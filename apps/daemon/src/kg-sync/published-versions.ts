// Published versions on the media store — the cross-device half of project
// history. Every PUSH freezes the deliverables of that moment under
// `_v/<verId>/…` and appends an entry to `changelog.json`, so pipeline-studio
// (and any other consumer of the store) can show a timeline and open the
// exact outputs of an older version. Fine-grained per-run history stays in
// the machine-local .odhistory git repo (project-history.ts) — entries here
// reference its commits by hash.
//
// Store layout per project folder:
//   <latest files>            ← unchanged behavior, what pull-all fetches
//   changelog.json            ← [{verId, at, by, gitCommit, files, …}] index
//   _v/v1/… _v/v2/…           ← frozen deliverable snapshots, capped at
//                               OD_HISTORY_KEEP (default 10), pruned on push
//
// `_v/` and `changelog.json` are metadata, NOT pipeline outputs: pulls skip
// them and stage derivation ignores them (see pipelines.ts guards).

import type { LocalSyncFile, MediaClient } from './media-client.js';

export const VERSIONS_PREFIX = '_v/';
export const CHANGELOG_PATH = 'changelog.json';

export interface ChangelogEntry {
  verId: string;
  /** ISO timestamp of the push. */
  at: string;
  by: { id?: string; email?: string; name?: string } | null;
  /** .odhistory commit hash on the pushing machine (per-machine reference). */
  gitCommit?: string;
  /** Deliverable files frozen into this version's snapshot. */
  files: number;
  /** Store delta of the push itself (new/changed uploads, pruned rows). */
  uploaded: number;
  deleted: number;
  note?: string;
}

/** True for store paths that are store METADATA rather than outputs:
 *  version snapshots + changelog, and the studio-written project config. */
export function isHistoryPath(rel: string): boolean {
  return rel === CHANGELOG_PATH || rel === 'project.json' || rel.startsWith(VERSIONS_PREFIX);
}

export function historyKeepCount(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OD_HISTORY_KEEP);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10;
}

export async function readChangelog(media: MediaClient, projectId: string): Promise<ChangelogEntry[]> {
  try {
    const buf = await media.downloadFile(projectId, CHANGELOG_PATH);
    const parsed = JSON.parse(buf.toString('utf8'));
    return Array.isArray(parsed)
      ? parsed.filter((e): e is ChangelogEntry => e && typeof e.verId === 'string')
      : [];
  } catch {
    return []; // absent / unreadable → start at v1
  }
}

const verNum = (verId: string): number => {
  const n = Number(/^v(\d+)$/.exec(verId)?.[1]);
  return Number.isFinite(n) ? n : 0;
};

export function nextVerId(entries: ChangelogEntry[]): string {
  return `v${entries.reduce((max, e) => Math.max(max, verNum(e.verId)), 0) + 1}`;
}

/** Freeze `files` (already-in-memory push buffers) under `_v/<verId>/…`.
 *  One listing via syncProjectFiles; the fresh prefix means pure adds. */
export async function publishVersion(
  media: MediaClient,
  projectId: string,
  verId: string,
  files: LocalSyncFile[],
): Promise<number> {
  if (files.length === 0) return 0;
  const snapshot = files.map((f) => ({ ...f, path: `${VERSIONS_PREFIX}${verId}/${f.path}` }));
  const r = await media.syncProjectFiles(projectId, snapshot);
  return r.uploaded + r.skipped;
}

export async function writeChangelog(
  media: MediaClient,
  projectId: string,
  entries: ChangelogEntry[],
): Promise<void> {
  await media.uploadFile(
    projectId,
    'history',
    CHANGELOG_PATH,
    'application/json',
    Buffer.from(JSON.stringify(entries, null, 2)),
  );
}

/** Drop snapshots beyond the newest `keep` versions. Best-effort. */
export async function pruneVersions(
  media: MediaClient,
  projectId: string,
  keep: number,
): Promise<string[]> {
  const remote = await media.listFiles(projectId);
  const byVer = new Map<string, string[]>(); // verId -> file ids
  for (const f of remote) {
    const rel = typeof f.path === 'string' ? f.path : '';
    const m = /^_v\/(v\d+)\//.exec(rel);
    if (!m || typeof f.id !== 'string') continue;
    const arr = byVer.get(m[1]!) ?? [];
    arr.push(f.id);
    byVer.set(m[1]!, arr);
  }
  const dropped = [...byVer.keys()]
    .sort((a, b) => verNum(b) - verNum(a))
    .slice(keep);
  for (const ver of dropped) {
    for (const id of byVer.get(ver) ?? []) {
      await media.deleteFile(id).catch(() => {});
    }
  }
  return dropped;
}
