// Pure helpers + in-memory snapshot store for conflict-aware pull
// (PLAN → RESOLVE → APPLY). No I/O here so this file is cheap to unit-test; the
// daemon wiring (planPull/applyPull) lives in server.ts and the HTTP surface in
// kg-sync-routes.ts. See docs/guides/pull-conflict-resolution-spec.md.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  PullApplyResult,
  PullConflict,
  PullEntry,
  PullPlan,
  PullResolution,
} from '@open-design/contracts';
import { isExportArtifact, isHistoryArtifact, isSyncExcluded } from '../pipelines.js';

/** Max bytes of either side we will inline-diff. A text file larger than this is
 *  classified `binary` (metadata-only comparison) — see conflictKind. */
export const PREVIEW_CAP = 256 * 1024;

/** Default lifetime of a plan snapshot. APPLY past this → PLAN_EXPIRED. */
export const PLAN_TTL_MS = 10 * 60_000;

/** hex sha256 of a buffer — the checksum unit shared with media-service
 *  (whose `sha256:`-prefixed value MediaClient already strips). */
export function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// Extensions we treat as diff-able text (spec §3). Everything else is binary.
const TEXT_EXTS = new Set([
  'md', 'json', 'txt', 'csv', 'svg', 'ts', 'tsx', 'js', 'jsx',
  'css', 'scss', 'html', 'yml', 'yaml', 'xml',
]);

/** Whether a path's extension is in the text allowlist (case-insensitive). */
export function isTextPath(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false; // no ext, or dotfile with no ext
  return TEXT_EXTS.has(base.slice(dot + 1).toLowerCase());
}

/** Classify one remote file against its local counterpart by checksum. */
export function classify(
  localChecksum: string | null,
  remoteChecksum: string,
): 'new' | 'unchanged' | 'conflict' {
  if (localChecksum === null) return 'new';
  return localChecksum === remoteChecksum ? 'unchanged' : 'conflict';
}

/** A conflict is inline-diffable only when the path is text AND neither side
 *  exceeds the preview cap; otherwise it's compared as binary metadata. */
export function conflictKind(filePath: string, localSize: number, remoteSize: number): 'text' | 'binary' {
  if (!isTextPath(filePath)) return 'binary';
  if (localSize > PREVIEW_CAP || remoteSize > PREVIEW_CAP) return 'binary';
  return 'text';
}

/** A new planId (`plan_<uuid>`). */
export function newPlanId(): string {
  return `plan_${randomUUID()}`;
}

/** What APPLY needs from a prior PLAN: the classified plan plus the remote
 *  checksum each path had at plan time (the TOCTOU baseline). */
export interface StoredPlan {
  plan: PullPlan;
  /** path → remoteChecksum captured at PLAN (every remote file, all classes). */
  remoteByPath: Map<string, string>;
  expiresAt: number;
}

/** In-memory plan snapshots with a TTL. Single-daemon scope (no persistence);
 *  an expired/unknown planId at APPLY surfaces as PLAN_EXPIRED so clients re-plan.
 *  A lazy sweep on every access keeps the map from growing unbounded. */
export class PullPlanStore {
  private readonly plans = new Map<string, StoredPlan>();

  constructor(
    private readonly ttlMs: number = PLAN_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Snapshot a freshly-built plan; returns its planId for convenience. */
  put(plan: PullPlan, remoteByPath: Map<string, string>): string {
    this.sweep();
    this.plans.set(plan.planId, { plan, remoteByPath, expiresAt: this.now() + this.ttlMs });
    return plan.planId;
  }

  /** Resolve a snapshot, or null if unknown/expired (caller → PLAN_EXPIRED). */
  get(planId: string): StoredPlan | null {
    this.sweep();
    return this.plans.get(planId) ?? null;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, rec] of this.plans) {
      if (rec.expiresAt <= t) this.plans.delete(id);
    }
  }
}

// ── core PLAN/APPLY logic (store + fs only — no HTTP) ────────────────────────
// Extracted from the daemon wiring so the classification + resolution + TOCTOU
// invariants are unit-testable against a fake store + a temp dir, with no daemon
// boot or live media-service. MediaClient satisfies RemoteFileStore structurally.

/** Minimal remote file the planner reads (a subset of media-client's MediaFile). */
export interface RemoteFile {
  id: string;
  path: string;
  stage: string;
  checksum: string;
  size: number;
}

/** The remote-store surface PLAN/APPLY depend on (MediaClient implements it). */
export interface RemoteFileStore {
  ensureFolder(projectId: string): Promise<string>;
  listAllFiles(folderId: string): Promise<RemoteFile[]>;
  downloadFile(projectId: string, filePath: string): Promise<Buffer>;
}

/** True when `dest` is `cwdReal` itself or strictly inside it (traversal guard). */
function withinCwd(dest: string, cwdReal: string): boolean {
  return dest === cwdReal || dest.startsWith(cwdReal + path.sep);
}

/** PLAN: classify a project's remote files against the local cwd. No disk writes.
 *  Returns the plan plus the path→remoteChecksum snapshot APPLY re-checks. */
export async function planPullFiles(
  projectId: string,
  cwd: string,
  store: RemoteFileStore,
): Promise<{ plan: PullPlan; remoteByPath: Map<string, string> }> {
  const cwdReal = path.resolve(cwd);
  const folderId = await store.ensureFolder(projectId);
  const remote = await store.listAllFiles(folderId);

  const remoteByPath = new Map<string, string>();
  const newEntries: PullEntry[] = [];
  const conflicts: PullConflict[] = [];
  let unchanged = 0;

  for (const rf of remote) {
    const rel = rf.path;
    if (!rel) continue;
    // Snapshot every remote checksum (TOCTOU baseline) even for skipped paths.
    remoteByPath.set(rel, rf.checksum);
    // History metadata (_v/ snapshots, changelog.json) is store-side only —
    // never a pull candidate; restore has its own API.
    if (isHistoryArtifact(rel)) continue;
    // syncExclude paths (build artifacts / template scaffold a stale store may
    // still carry) are invisible to PLAN: they must never surface as "new"
    // files or conflicts — pull would pin an old template over the local one.
    if (isSyncExcluded(rel)) continue;
    // Derived MD exports never pull (regenerated on every push) — surfacing
    // them as "new"/conflicts would be pure noise.
    if (isExportArtifact(rel)) continue;
    const dest = path.resolve(cwd, rel);
    if (!withinCwd(dest, cwdReal)) continue; // path-traversal guard

    const localStat = await fs.stat(dest).catch(() => null);
    if (!localStat || !localStat.isFile()) {
      newEntries.push({ path: rel, stage: rf.stage, remoteChecksum: rf.checksum });
      continue;
    }
    const localBuf = await fs.readFile(dest).catch(() => null);
    if (!localBuf) {
      newEntries.push({ path: rel, stage: rf.stage, remoteChecksum: rf.checksum });
      continue;
    }
    const localSum = sha256hex(localBuf);
    if (classify(localSum, rf.checksum) === 'unchanged') {
      unchanged += 1;
      continue;
    }
    // conflict — decide text (inline diff) vs binary (metadata only).
    let kind = conflictKind(rel, localStat.size, rf.size);
    let localPreview: string | null = null;
    let remotePreview: string | null = null;
    let remoteSize = rf.size;
    if (kind === 'text') {
      const remoteBuf = await store.downloadFile(projectId, rel).catch(() => null);
      if (!remoteBuf) continue; // remote vanished between list and download
      remoteSize = remoteBuf.length;
      if (remoteBuf.length > PREVIEW_CAP) {
        kind = 'binary';
      } else {
        localPreview = localBuf.toString('utf8');
        remotePreview = remoteBuf.toString('utf8');
      }
    }
    conflicts.push({
      path: rel,
      stage: rf.stage,
      kind,
      local: { checksum: localSum, size: localStat.size, mtime: localStat.mtimeMs, preview: localPreview },
      remote: { checksum: rf.checksum, size: remoteSize, preview: remotePreview, fileId: rf.id },
    });
  }

  const plan: PullPlan = {
    projectId,
    planId: newPlanId(),
    summary: { new: newEntries.length, unchanged, conflicts: conflicts.length },
    new: newEntries,
    conflicts,
  };
  return { plan, remoteByPath };
}

/** APPLY: act on a prior plan's resolutions. Re-lists remote to catch drift and
 *  only writes files whose remote checksum still matches the plan snapshot. */
export async function applyPullFiles(
  projectId: string,
  cwd: string,
  store: RemoteFileStore,
  stored: StoredPlan,
  resolutions: Record<string, PullResolution>,
  onConflictDefault: PullResolution,
): Promise<PullApplyResult> {
  const plan = stored.plan;
  const cwdReal = path.resolve(cwd);
  const folderId = await store.ensureFolder(projectId);
  const freshByPath = new Map<string, string>();
  for (const rf of await store.listAllFiles(folderId)) freshByPath.set(rf.path, rf.checksum);

  const stale: { path: string; reason: string }[] = [];
  let downloaded = 0;

  // Download+write one remote file, guarding both path-traversal and TOCTOU
  // (remote changed/removed since PLAN → stale, never written blind).
  const writeRemote = async (rel: string): Promise<void> => {
    const fresh = freshByPath.get(rel);
    if (fresh === undefined) {
      stale.push({ path: rel, reason: 'remote file removed since plan' });
      return;
    }
    const snap = stored.remoteByPath.get(rel);
    if (snap !== undefined && fresh !== snap) {
      stale.push({ path: rel, reason: 'remote changed since plan' });
      return;
    }
    const dest = path.resolve(cwd, rel);
    if (!withinCwd(dest, cwdReal)) {
      stale.push({ path: rel, reason: 'path outside project' });
      return;
    }
    const content = await store.downloadFile(projectId, rel).catch(() => null);
    if (!content) {
      stale.push({ path: rel, reason: 'download failed' });
      return;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content);
    downloaded += 1;
  };

  for (const entry of plan.new) await writeRemote(entry.path);

  let keptLocal = 0;
  for (const conflict of plan.conflicts) {
    const choice = resolutions[conflict.path] ?? onConflictDefault;
    if (choice === 'remote') await writeRemote(conflict.path);
    else keptLocal += 1;
  }

  return { downloaded, keptLocal, unchangedSkipped: plan.summary.unchanged, stale };
}
