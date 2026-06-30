// Pull conflict resolution DTOs — shared between the daemon HTTP layer, the web
// UI (PullConflictModal), and the `od kg pull` CLI.
//
// When a project's pipeline files are pulled from the media-service store back
// into the local cwd, a file that already exists locally AND differs from the
// remote must NOT be silently overwritten. The flow is three phases:
//   ① PLAN  (daemon, no disk writes): compare local↔remote checksums →
//            new / unchanged / conflict; text conflicts carry a capped preview
//            so the UI can diff. Returns a `planId` the apply binds to.
//   ② RESOLVE (UI): the user picks Remote/Local per conflicting file.
//   ③ APPLY (daemon): re-check remote checksums (TOCTOU) then download+write the
//            chosen-remote + new files; keep the chosen-local ones untouched.
//
// See docs/guides/pull-conflict-resolution-spec.md and media-file-sync-design.md.

/** Per-file resolution chosen by the user (or the CLI default). */
export type PullResolution = 'remote' | 'local';

/** A remote-only file that will be downloaded without asking. */
export interface PullEntry {
  path: string;
  stage: string;
  remoteChecksum: string;
}

/** One side (local or remote) of a conflicting file. `preview` is the full text
 *  capped at PREVIEW_CAP; null for binary (or text over the cap → treated as
 *  binary). `fileId` is the media-service file id (remote side only). */
export interface ConflictSide {
  checksum: string;
  size: number;
  mtime?: number;
  preview: string | null;
  fileId?: string;
}

/** A file present on both sides with differing checksums. `kind` decides whether
 *  the UI offers an inline text diff or a metadata-only binary comparison. */
export interface PullConflict {
  path: string;
  stage: string;
  kind: 'text' | 'binary';
  local: ConflictSide;
  remote: ConflictSide;
}

/** Result of PLAN: the classified remote vs local file set for one project. */
export interface PullPlan {
  projectId: string;
  planId: string;
  summary: { new: number; unchanged: number; conflicts: number };
  new: PullEntry[];
  conflicts: PullConflict[];
}

/** Request body for APPLY. `resolutions` is keyed by path; conflicts absent from
 *  it fall back to `onConflictDefault` (default 'local'). */
export interface PullApplyRequest {
  projectId: string;
  planId: string;
  resolutions: Record<string, PullResolution>;
  onConflictDefault?: PullResolution;
}

/** Result of APPLY. `stale` lists files skipped because the remote checksum
 *  changed between PLAN and APPLY (TOCTOU guard — never written blind). */
export interface PullApplyResult {
  downloaded: number;
  keptLocal: number;
  unchangedSkipped: number;
  stale: { path: string; reason: string }[];
}

export interface PullPlanResponse {
  ok: boolean;
  data: PullPlan;
}

export interface PullApplyResponse {
  ok: boolean;
  data: PullApplyResult;
}

/** Error code returned (HTTP 409) when APPLY references a planId that has expired
 *  or is unknown — the UI/CLI should re-plan. */
export const ERR_PLAN_EXPIRED = 'PLAN_EXPIRED';
