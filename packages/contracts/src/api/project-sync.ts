// App/Feature ↔ origin sync contract. Both Pipeline Studio and `od` use this
// surface; keep it deliberately independent from the legacy `/api/kg/*` sync.

export type ProjectSyncDirection = 'pull' | 'push';
export type ProjectSyncScopeKind = 'app' | 'feature';
export type ProjectSyncChange = 'new' | 'unchanged' | 'changed' | 'deleted';
/** Human-facing status for an App or Feature. File-level changes deliberately
 * remain separate: a remote-only file must never label the whole entity as
 * deleted. */
export type ProjectSyncUserStatus =
  | 'up_to_date'
  | 'update_available'
  | 'not_shared'
  | 'needs_review'
  | 'incomplete'
  | 'unavailable'
  | 'origin_missing';
export type ProjectSyncStatusReason =
  | 'contents_match'
  | 'origin_changed'
  | 'local_changed'
  | 'both_changed'
  | 'no_sync_baseline'
  | 'mapping_missing'
  | 'origin_missing_or_hidden'
  | 'previous_sync_incomplete'
  | 'status_check_failed';
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

/** Provenance of a raw Confluence attachment recorded in the sibling
 * `attachments/_sources.json` ledger. Push skips the bytes for such an entry;
 * Pull re-downloads them from the wiki pinned to `attachmentVersion`. */
export interface ProjectSyncConfluenceSource {
  base: string;
  pageId: string;
  spaceKey: string;
  attachment: string;
  attachmentVersion: number;
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
  /** Present when the bytes live on Confluence rather than in media. */
  confluence?: ProjectSyncConfluenceSource;
}

export interface ProjectSyncSummary {
  /** Created on the target side. Entries retain the more precise `new` state. */
  created: number;
  unchanged: number;
  changed: number;
  deleted: number;
  /** Every entry (any change state) whose bytes come from Confluence; `bytes`
   * uses `local.size ?? origin.size`. Omitted when there is no such entry. */
  confluence?: { files: number; bytes: number };
}

/** UI-facing aggregate. Consumers must use this instead of inferring an App or
 * Feature state from arbitrary file paths. */
export interface SyncEntitySummary {
  id: string;
  name: string;
  kind: 'app' | 'context' | 'feature';
  /** @deprecated Use the scope-level `status`. Kept for one release. */
  state: Exclude<ProjectSyncChange, 'deleted'>;
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
  status: ProjectSyncUserStatus;
  reason: ProjectSyncStatusReason;
  checkedAt: string;
  lastSyncedAt?: string | null;
  /** @deprecated Use `status`. Kept for one release and never equals deleted. */
  state: Exclude<ProjectSyncChange, 'deleted'>;
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
  /** Push: Confluence-backed entries whose bytes were deliberately not uploaded. */
  manifested?: number;
  /** Pull: outcome of the Confluence re-download phase. `drifted` files were
   * written from the latest wiki version because the pinned one no longer
   * matches; `missing` files were not written at all. Neither is `stale`. */
  confluence?: ProjectSyncConfluencePullOutcome;
}

export interface ProjectSyncConfluencePullOutcome {
  fetched: number;
  drifted: Array<{ path: string; reason: string }>;
  missing: Array<{ path: string; reason: string }>;
}

export type ProjectSyncConfluenceTokenState = 'ok' | 'missing' | 'invalid' | 'unreachable';

/** Exactly one of the two ids. */
export interface ProjectSyncConfluencePreflightRequest {
  planId?: string;
  batchPlanId?: string;
}

/** Answers "can THIS machine pull the Confluence-backed files of a plan?"
 * before APPLY. The web blocks the Pull button while `ok` is false. */
export interface ProjectSyncConfluencePreflight {
  /** False ⇒ the plan has no Confluence entry; every other field is empty/ok. */
  required: boolean;
  files: number;
  bytes: number;
  /** Base recorded in the origin ledger. */
  base: string | null;
  /** Base configured on this machine (CONFLUENCE_URL). */
  credsBase: string | null;
  baseMatches: boolean;
  token: ProjectSyncConfluenceTokenState;
  displayName?: string;
  spaces: Array<{ key: string; samplePageId: string; ok: boolean; status: number | null; files: number }>;
  /** `required === false || (baseMatches && token === 'ok' && spaces.every(ok))` */
  ok: boolean;
}

export interface ProjectSyncConfluencePreflightResponse {
  ok: true;
  data: ProjectSyncConfluencePreflight;
}

/** Long-running APPLY lifecycle. The legacy synchronous APPLY response remains
 * supported; these types back the asynchronous operation endpoints. */
export type ProjectSyncOperationState = 'queued' | 'running' | 'succeeded' | 'failed';
export type ProjectSyncOperationPhase = 'validating' | 'transferring' | 'finalizing';

export interface ProjectSyncOperationError {
  /** Stable machine-readable identifier suitable for CLI/UI branching. */
  code: string;
  message: string;
  retryable: boolean;
}

export interface ProjectSyncOperationProgress {
  /** Completed and total count the immutable plan entries selected for APPLY. */
  completedItems: number;
  totalItems: number;
  /** Integer in the inclusive 0..100 range. */
  percent: number;
  /** Optional detail for a progress label; neither field affects the total. */
  currentPath?: string | null;
  currentFeatureId?: string | null;
}

/** Pollable snapshot returned by POST/GET `/api/project-sync/operations`. */
export interface ProjectSyncOperation<TResult = ProjectSyncApplyResult> {
  operationId: string;
  planId: string;
  state: ProjectSyncOperationState;
  phase: ProjectSyncOperationPhase;
  progress: ProjectSyncOperationProgress;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** Immutable terminal payload retained until `expiresAt`. */
  result?: TResult;
  error?: ProjectSyncOperationError;
}

/** Backward-compatible async equivalent of `ProjectSyncApplyRequest`. */
export interface ProjectSyncOperationCreateRequest extends ProjectSyncApplyRequest {}

/** Pull several remote Features into one already-pulled local App. App Context
 * is deliberately outside this request: each Feature keeps its own immutable
 * binding and the App must already map to `originAppId`. */
export interface ProjectSyncFeaturePullBatchPlanRequest {
  localAppId: string;
  originAppId: string;
  originFeatureIds: string[];
}

export type ProjectSyncFeaturePullMode = 'create' | 'update';

export interface ProjectSyncFeaturePullBatchPlanItem {
  originId: string;
  name: string;
  localId: string;
  mode: ProjectSyncFeaturePullMode;
  summary: ProjectSyncSummary;
  entries: ProjectSyncEntry[];
}

/** Immutable baseline for one batch. APPLY must use `planId` instead of
 * rebuilding the selection from the latest origin listing. */
export interface ProjectSyncFeaturePullBatchPlan {
  planId: string;
  createdAt: string;
  localAppId: string;
  originAppId: string;
  features: ProjectSyncFeaturePullBatchPlanItem[];
  totalItems: number;
}

export type ProjectSyncFeaturePullBatchItemState = 'succeeded' | 'failed';

interface ProjectSyncFeaturePullBatchItemResultBase {
  originId: string;
  localId: string;
}

export type ProjectSyncFeaturePullBatchItemResult =
  | (ProjectSyncFeaturePullBatchItemResultBase & {
      state: 'succeeded';
      result: ProjectSyncApplyResult;
      error?: never;
    })
  | (ProjectSyncFeaturePullBatchItemResultBase & {
      state: 'failed';
      result?: never;
      error: ProjectSyncOperationError;
    });

export type ProjectSyncFeaturePullBatchResultState = 'succeeded' | 'partial' | 'failed';

/** A batch is intentionally allowed to complete partially. Callers should
 * retain successful items and offer retry for only failed origin ids. */
export interface ProjectSyncFeaturePullBatchResult {
  planId: string;
  localAppId: string;
  originAppId: string;
  state: ProjectSyncFeaturePullBatchResultState;
  items: ProjectSyncFeaturePullBatchItemResult[];
}

export interface ProjectSyncFeaturePullBatchApplyRequest {
  planId: string;
}

export interface ProjectSyncFeaturePullBatchOperationCreateRequest extends ProjectSyncFeaturePullBatchApplyRequest {}

export type ProjectSyncFeaturePullBatchOperation = ProjectSyncOperation<ProjectSyncFeaturePullBatchResult>;

/** Retry derives its selection exclusively from failed items in the retained
 * terminal operation, preventing an accidental replay of successful pulls. */
export interface ProjectSyncFeaturePullBatchRetryRequest {
  operationId: string;
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

export interface ProjectSyncOperationCreateResponse {
  ok: true;
  data: ProjectSyncOperation;
}

export interface ProjectSyncOperationResponse {
  ok: true;
  data: ProjectSyncOperation;
}

export interface ProjectSyncFeaturePullBatchPlanResponse {
  ok: true;
  data: ProjectSyncFeaturePullBatchPlan;
}

export interface ProjectSyncFeaturePullBatchOperationResponse {
  ok: true;
  data: ProjectSyncFeaturePullBatchOperation;
}

export interface ProjectSyncFeaturePullBatchRetryResponse extends ProjectSyncFeaturePullBatchOperationResponse {}

/** HTTP 409: immutable PLAN snapshot is unknown, expired, or no longer valid. */
export const ERR_PROJECT_SYNC_PLAN_EXPIRED = 'PLAN_EXPIRED';
/** HTTP 404: asynchronous APPLY operation is unknown or its retention TTL elapsed. */
export const ERR_PROJECT_SYNC_OPERATION_NOT_FOUND = 'PROJECT_SYNC_OPERATION_NOT_FOUND';
/** HTTP 409: a soft-hidden remote cannot be revived by reusing its id. */
export const ERR_PROJECT_SYNC_ORIGIN_HIDDEN = 'ORIGIN_HIDDEN_REQUIRES_NEW_ID';
