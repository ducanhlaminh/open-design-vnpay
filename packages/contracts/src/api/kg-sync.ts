// design-v3 KG sync DTOs — shared between the daemon HTTP layer, the web UI, and
// the `od kg …` CLI. open-design-vnpay pulls a remote KGS project (app_id =
// design-v3) into its local SQLite mirror and pushes locally-authored rows back.
// See apps/daemon/src/kg-sync/ and docs/sync-design-v3-spec-plan.md.

export type KgSyncStatus = 'ok' | 'partial';

/**
 * Body of `POST /api/kg/pull-all` and `push-all`. `projectIds` narrows to a
 * chosen subset of projects (the UI's Pull all / Push all modals / --projects);
 * `stages` narrows which pipelines' OUTPUT FILES travel (--stages) — the KG
 * graph always moves whole-project. `workflow` is a convenience for CLI/API
 * callers: when `stages` is absent it expands to that workflow's pipeline ids
 * (the UI modals are workflow-scoped and always send explicit `stages`).
 * Absent or empty → everything.
 */
export interface KgPullAllRequest {
  projectIds?: string[];
  stages?: string[];
  workflow?: string;
}

export interface KgPullResult {
  projectId: string;
  nodes: number;
  edges: number;
  skippedLocalNodes: number;
  skippedLocalEdges: number;
  status: KgSyncStatus;
  errors: string[];
}

export interface KgPushResult {
  projectId: string;
  nodesPushed: number;
  edgesPushed: number;
  status: KgSyncStatus;
  errors: string[];
  // Non-fatal notes — e.g. an edit to a pulled node that KGS could not upsert.
  caveats: string[];
}

export interface ApprovedProjectMapping {
  localProjectId: string;
  approvedProjectId: string;
  approvedAppId?: string;
  pendingId: string;
  decidedAt: string;
  decidedBy?: { id: string; email?: string; name?: string } | null;
}

export type PublishResult =
  | {
      status: 'published';
      projectId: string;
      approvedProjectId: string;
      filesUploaded: number;
      filesConverted: number;
      nodesPushed: number;
      edgesPushed: number;
      workspace: 'created' | 'exists' | 'error';
      mapping?: ApprovedProjectMapping;
      caveats: string[];
    }
  | {
      status: 'pending_approval';
      projectId: string;
      requestId: string;
      requestedProjectId: string;
      filesUploaded: number;
      filesConverted: number;
      caveats: string[];
    }
  | {
      status: 'rejected';
      projectId: string;
      requestId: string;
      reason: string;
      caveats: string[];
    }
  | {
      status: 'auth_required';
      projectId: string;
      message: string;
      code: 'SYNC_IDENTITY_REQUIRED';
      caveats: string[];
    }
  | {
      status: 'error';
      projectId: string;
      message: string;
      code?: string;
      caveats: string[];
    };

export interface KgPushAllResponse {
  ok: boolean;
  data: { pushed: number; results: PublishResult[] };
}

export interface KgSyncCounts {
  projectId: string;
  nodes: number;
  edges: number;
  localNodes: number;
  localEdges: number;
}

export interface KgPullResponse {
  ok: boolean;
  data: KgPullResult;
}

export interface KgPushResponse {
  ok: boolean;
  data: KgPushResult;
}

export interface KgStatusResponse {
  ok: true;
  data: KgSyncCounts;
}

/** Per-stage local↔remote file diff (POST /api/kg/sync-status, `od kg diff`).
 *  Counts follow the push/pull eligibility rules (history metadata, syncExclude
 *  and localOnly-stage files never travel → never counted), so `differs` always
 *  corresponds to something a push or pull would actually move. */
export interface StageSyncStatus {
  stage: string;
  /** Sync-eligible files in the local cwd / on the store. */
  local: number;
  remote: number;
  /** Present on both sides with different checksums. */
  changed: number;
  /** Local-only (a push would upload) / remote-only (a pull would download). */
  localOnly: number;
  remoteOnly: number;
  differs: boolean;
}

export interface ProjectSyncStatus {
  projectId: string;
  stages: StageSyncStatus[];
  /** Set when this project's diff could not be computed (others still return). */
  error?: string;
}

export interface KgSyncStatusResponse {
  ok: boolean;
  data: { results: ProjectSyncStatus[] };
}
