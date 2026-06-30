// design-v3 KG sync DTOs — shared between the daemon HTTP layer, the web UI, and
// the `od kg …` CLI. open-design-vnpay pulls a remote KGS project (app_id =
// design-v3) into its local SQLite mirror and pushes locally-authored rows back.
// See apps/daemon/src/kg-sync/ and docs/sync-design-v3-spec-plan.md.

export type KgSyncStatus = 'ok' | 'partial';

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
