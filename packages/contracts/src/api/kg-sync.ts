// Remote project sync DTOs — shared between the daemon HTTP layer and the web
// UI. open-design-vnpay pushes a project's pipeline output files to the
// shared media-service store and reads the registry of what's already there.
// See apps/daemon/src/remote-projects-routes.ts and
// docs/sync-design-v3-spec-plan.md.
//
// (Prior to the KGS removal this also covered a separate graph-store mirror
// — KgPullResult/KgPushResult/KgSyncCounts and their `/api/projects/:id/kg-*`
// responses — that half is gone; PublishResult's nodesPushed/edgesPushed/
// workspace fields are kept at 0/'exists' for response-shape compatibility.)

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

/** Per-stage local↔remote file diff (POST /api/kg/sync-status).
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
