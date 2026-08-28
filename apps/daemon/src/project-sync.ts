// Pure App/Feature origin-sync planning. I/O belongs in project-sync-routes;
// this module deliberately only compares immutable content snapshots and holds
// the PLAN → APPLY TOCTOU baseline.

import { randomUUID } from 'node:crypto';
import type {
  ProjectSyncChange,
  ProjectSyncConfluenceSource,
  ProjectSyncDirection,
  ProjectSyncEntry,
  ProjectSyncEntryKind,
  ProjectSyncPlan,
  ProjectSyncResolution,
  ProjectSyncScope,
  ProjectSyncSummary,
} from '@open-design/contracts';

export const PROJECT_SYNC_PLAN_TTL_MS = 10 * 60_000;

export interface ProjectSyncSnapshotFile {
  path: string;
  checksum: string;
  size: number;
  kind: ProjectSyncEntryKind;
  featureId?: string;
  stage?: string;
  contextVersion?: string;
  version?: string | null;
  /** Bytes live on Confluence (see `confluence-blobs.ts`); media has no copy. */
  confluence?: ProjectSyncConfluenceSource;
}

export interface StoredProjectSyncPlan {
  plan: ProjectSyncPlan;
  /** Both sides are captured so APPLY can reject a plan after either drifts. */
  localByPath: Map<string, string>;
  originByPath: Map<string, string>;
  expiresAt: number;
}

export class ProjectSyncPlanStore {
  private readonly plans = new Map<string, StoredProjectSyncPlan>();

  constructor(private readonly ttlMs = PROJECT_SYNC_PLAN_TTL_MS, private readonly now = Date.now) {}

  put(record: Omit<StoredProjectSyncPlan, 'expiresAt'>): void {
    this.sweep();
    this.plans.set(record.plan.planId, { ...record, expiresAt: this.now() + this.ttlMs });
  }

  get(planId: string): StoredProjectSyncPlan | null {
    this.sweep();
    return this.plans.get(planId) ?? null;
  }

  /** APPLY is retry-idempotent: retain a completed snapshot until TTL expiry. */
  private sweep(): void {
    const now = this.now();
    for (const [id, record] of this.plans) if (record.expiresAt <= now) this.plans.delete(id);
  }
}

/** CLI adapter helper kept pure so repeated per-file choices are testable
 * without starting a daemon or binding a loopback port. */
export function parseProjectSyncResolutionArgs(args: readonly string[]): Record<string, ProjectSyncResolution> {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--resolution' && typeof args[index + 1] === 'string') {
      values.push(args[index + 1]!);
      index += 1;
    } else if (arg?.startsWith('--resolution=')) {
      values.push(arg.slice('--resolution='.length));
    }
  }
  const resolutions: Record<string, ProjectSyncResolution> = {};
  for (const item of values) {
    const pivot = item.lastIndexOf('=');
    const path = pivot > 0 ? item.slice(0, pivot) : '';
    const value = pivot > 0 ? item.slice(pivot + 1) : '';
    if (path && (value === 'pull' || value === 'push' || value === 'skip')) resolutions[path] = value;
  }
  return resolutions;
}

function emptySummary(): ProjectSyncSummary {
  return { created: 0, unchanged: 0, changed: 0, deleted: 0 };
}

function entryChange(
  direction: ProjectSyncDirection,
  local: ProjectSyncSnapshotFile | undefined,
  origin: ProjectSyncSnapshotFile | undefined,
): ProjectSyncChange {
  const source = direction === 'push' ? local : origin;
  const target = direction === 'push' ? origin : local;
  if (source && !target) return 'new';
  if (!source && target) return 'deleted';
  if (!source || !target) return 'unchanged';
  return source.checksum === target.checksum ? 'unchanged' : 'changed';
}

function defaultResolution(direction: ProjectSyncDirection, change: ProjectSyncChange): ProjectSyncResolution {
  if (change === 'unchanged') return 'skip';
  // Push deletion is deliberate: origin-only Feature units are soft-hidden by
  // APPLY and origin-only current files are removed without touching `_v/`.
  // Pull keeps its local-only files until a caller explicitly chooses `pull`.
  if (change === 'deleted') return direction === 'push' ? 'push' : 'skip';
  return direction;
}

/** Build a directional diff. A `new` row means source-only; `deleted` means
 * target-only and can only remove a current artifact during APPLY. */
export function planProjectSync(input: {
  direction: ProjectSyncDirection;
  scope: ProjectSyncScope;
  origin: ProjectSyncPlan['origin'];
  local: readonly ProjectSyncSnapshotFile[];
  originFiles: readonly ProjectSyncSnapshotFile[];
  now?: Date;
}): { plan: ProjectSyncPlan; localByPath: Map<string, string>; originByPath: Map<string, string> } {
  const localFiles = new Map(input.local.map((file) => [file.path, file]));
  const originFiles = new Map(input.originFiles.map((file) => [file.path, file]));
  const paths = [...new Set([...localFiles.keys(), ...originFiles.keys()])].sort();
  const summary = emptySummary();
  const entries: ProjectSyncEntry[] = paths.map((path) => {
    const local = localFiles.get(path);
    const origin = originFiles.get(path);
    const change = entryChange(input.direction, local, origin);
    if (change === 'new') summary.created += 1;
    else summary[change] += 1;
    const source = input.direction === 'push' ? local : origin;
    const metadata = source ?? local ?? origin;
    // The local ledger wins when both sides know the file: it reflects the
    // bytes actually on this machine (re-imported pool > older origin ledger).
    const confluence = local?.confluence ?? origin?.confluence;
    if (confluence) {
      summary.confluence ??= { files: 0, bytes: 0 };
      summary.confluence.files += 1;
      summary.confluence.bytes += local?.size || origin?.size || 0;
    }
    return {
      path,
      kind: source?.kind ?? local?.kind ?? origin?.kind ?? 'output',
      change,
      resolution: defaultResolution(input.direction, change),
      ...(local ? { local: { checksum: local.checksum, size: local.size, ...(local.version !== undefined ? { version: local.version } : {}) } } : {}),
      ...(origin ? { origin: { checksum: origin.checksum, size: origin.size, ...(origin.version !== undefined ? { version: origin.version } : {}) } } : {}),
      ...(metadata?.featureId ? { featureId: metadata.featureId } : {}),
      ...(metadata?.stage ? { stage: metadata.stage } : {}),
      ...(metadata?.contextVersion ? { contextVersion: metadata.contextVersion } : {}),
      ...(confluence ? { confluence } : {}),
    };
  });
  const planId = `project_sync_${randomUUID()}`;
  return {
    plan: {
      planId,
      createdAt: (input.now ?? new Date()).toISOString(),
      direction: input.direction,
      scope: input.scope,
      origin: input.origin,
      features: [],
      entries,
      summary,
    },
    localByPath: new Map(input.local.map((file) => [file.path, file.checksum])),
    originByPath: new Map(input.originFiles.map((file) => [file.path, file.checksum])),
  };
}

/** True only when the original source/target state is still exactly valid. */
export function projectSyncPlanIsFresh(
  stored: StoredProjectSyncPlan,
  local: readonly ProjectSyncSnapshotFile[],
  origin: readonly ProjectSyncSnapshotFile[],
): boolean {
  const same = (expected: Map<string, string>, current: readonly ProjectSyncSnapshotFile[]) => {
    const actual = new Map(current.map((file) => [file.path, file.checksum]));
    return expected.size === actual.size && [...expected].every(([path, checksum]) => actual.get(path) === checksum);
  };
  return same(stored.localByPath, local) && same(stored.originByPath, origin);
}
