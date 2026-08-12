// App/Feature ↔ origin sync contract. Both Pipeline Studio and `od` use this
// surface; keep it deliberately independent from the legacy `/api/kg/*` sync.

export type ProjectSyncDirection = 'pull' | 'push';
export type ProjectSyncScopeKind = 'app' | 'feature';
export type ProjectSyncChange = 'new' | 'unchanged' | 'changed' | 'deleted';
export type ProjectSyncResolution = 'pull' | 'push' | 'skip';
export type ProjectSyncEntryKind = 'context' | 'feature' | 'binding' | 'output';

/** `local-all` means the full local App tree; Feature is intentionally scoped. */
export interface ProjectSyncScope {
  kind: ProjectSyncScopeKind;
  projectId: string;
  /** Required for a Feature that belongs to an App; omitted for standalone Features. */
  appId?: string | null;
}

/** Remote-origin model shared by the picker and status diagnostics. The picker
 * returns visible rows only; status may report a hidden mapped origin. */
export interface ProjectSyncOrigin {
  originId: string;
  name: string;
  kind: ProjectSyncScopeKind;
  appId?: string | null;
  /** Present in status diagnostics. The origin picker endpoint only returns visible rows. */
  visibility: 'visible' | 'hidden';
  inKgs: boolean;
  inMedia: boolean;
  /** Mapping is intentionally best-effort: old origins need not have it. */
  mappingVersion?: number | null;
}

/** GET `/api/project-sync/origins` query. `kind=feature&appId=…` narrows the
 * picker to Features belonging to the selected App; `q` is a server-side
 * case-insensitive name/id prefix filter. */
export interface ProjectSyncOriginsQuery {
  kind?: ProjectSyncScopeKind;
  appId?: string;
  q?: string;
}

export type ProjectSyncOriginSelection =
  | { mode: 'existing'; originId: string }
  | {
      mode: 'new';
      originId: string;
      /** Optional display name for the newly-created shared App/Feature. */
      name?: string;
    };

/** Versioned local metadata bridge. Readers remain tolerant of the older
 * `studioConfig.remoteId` / approved-mapping forms during migration. */
export interface ProjectSyncMapping {
  schemaVersion: 1;
  localId: string;
  originId: string;
  originAppId?: string | null;
  mappedAt: string;
}

/** A content snapshot. `checksum` is a bare SHA-256 hex string. */
export interface ProjectSyncSide {
  checksum: string;
  size: number;
  /** Omitted where an old origin has no version/mapping metadata. */
  version?: string | null;
}

export interface ProjectSyncEntry {
  /** Stable path within the sync tree, including a feature-id prefix for App scopes. */
  path: string;
  kind: ProjectSyncEntryKind;
  /** Which side differs from the other. `deleted` is only a current-file deletion. */
  change: ProjectSyncChange;
  local?: ProjectSyncSide;
  origin?: ProjectSyncSide;
  /** Suggested action; callers can override this per path in APPLY. */
  resolution: ProjectSyncResolution;
  featureId?: string;
  /** Owning workflow stage for output filtering; absent for Context/control files. */
  stage?: string;
  contextVersion?: string;
}

export interface ProjectSyncSummary {
  /** Created on the target side. Entries retain the more precise `new` state. */
  created: number;
  unchanged: number;
  changed: number;
  deleted: number;
}

/** UI-facing aggregate. Consumers must use this instead of inferring an App or
 * Feature state from arbitrary file paths. */
export interface SyncEntitySummary {
  id: string;
  name: string;
  kind: 'app' | 'context' | 'feature';
  state: ProjectSyncChange;
  /** False when an origin mapping is absent, malformed, stale, or soft-hidden. */
  mappingValid: boolean;
  totals: ProjectSyncSummary;
  originId?: string | null;
  contextVersion?: string | null;
}

/** Immutable PLAN snapshot. APPLY revalidates this baseline before writes. */
export interface ProjectSyncPlan {
  planId: string;
  createdAt: string;
  direction: ProjectSyncDirection;
  scope: ProjectSyncScope;
  origin: ProjectSyncOriginSelection;
  /** Present for App plans and for an App-owned Feature plan. */
  app?: SyncEntitySummary;
  /** Current/history Context entity selected by the plan (never inferred from paths). */
  context?: SyncEntitySummary;
  /** App = every Feature; Feature = exactly the selected Feature. */
  features: SyncEntitySummary[];
  entries: ProjectSyncEntry[];
  summary: ProjectSyncSummary;
}

export interface ProjectSyncStatusRequest {
  /** Omitted = local-all status for every local App/Feature mapping. */
  scopes?: ProjectSyncScope[];
}

export interface ProjectSyncScopeStatus {
  scope: ProjectSyncScope;
  origin?: ProjectSyncOrigin | null;
  /** Aggregate state for this scope; UI must not derive it from file entries. */
  state: ProjectSyncChange;
  /** Mapping can be invalid while a status is still useful for remediation. */
  mappingValid: boolean;
  app?: SyncEntitySummary;
  context?: SyncEntitySummary;
  features: SyncEntitySummary[];
  summary: ProjectSyncSummary;
  entries: ProjectSyncEntry[];
  error?: string;
}

export interface ProjectSyncPlanRequest {
  direction: ProjectSyncDirection;
  scope: ProjectSyncScope;
  /** Pull normally derives the mapped origin; Push can choose existing or new. */
  origin?: ProjectSyncOriginSelection;
  /** Surface current-file deletions. Historical `_v/` artifacts are never deleted. */
  includeDeleted?: boolean;
}

export interface ProjectSyncApplyRequest {
  planId: string;
  /** Per-path overrides. Missing paths use the PLAN's suggested resolution. */
  resolutions?: Record<string, ProjectSyncResolution>;
}

export interface ProjectSyncApplyResult {
  planId: string;
  applied: number;
  skipped: number;
  unchanged: number;
  softHiddenOriginFeatureIds: string[];
  /** Entries not written because the remote/local baseline drifted after PLAN. */
  stale: Array<{ path: string; reason: string }>;
}

export interface ProjectSyncOriginsResponse {
  ok: true;
  data: { origins: ProjectSyncOrigin[] };
}

export interface ProjectSyncStatusResponse {
  ok: true;
  data: { results: ProjectSyncScopeStatus[] };
}

export interface ProjectSyncPlanResponse {
  ok: true;
  data: ProjectSyncPlan;
}

export interface ProjectSyncApplyResponse {
  ok: true;
  data: ProjectSyncApplyResult;
}

/** HTTP 409: immutable PLAN snapshot is unknown, expired, or no longer valid. */
export const ERR_PROJECT_SYNC_PLAN_EXPIRED = 'PLAN_EXPIRED';
/** HTTP 409: a soft-hidden remote cannot be revived by reusing its id. */
export const ERR_PROJECT_SYNC_ORIGIN_HIDDEN = 'ORIGIN_HIDDEN_REQUIRES_NEW_ID';
