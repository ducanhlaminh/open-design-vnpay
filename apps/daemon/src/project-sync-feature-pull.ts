import { createHash } from 'node:crypto';

import type {
  ProjectSyncEntry,
  ProjectSyncFeaturePullBatchPlan,
  ProjectSyncFeaturePullBatchPlanItem,
  ProjectSyncFeaturePullBatchPlanRequest,
  ProjectSyncSummary,
} from '@open-design/contracts';

export const PROJECT_SYNC_FEATURE_PULL_BATCH_MAX = 50;

export type ProjectSyncFeaturePullPlanErrorCode =
  | 'FEATURE_PULL_INVALID_REQUEST'
  | 'FEATURE_PULL_LOCAL_APP_NOT_FOUND'
  | 'FEATURE_PULL_ORIGIN_APP_NOT_FOUND'
  | 'FEATURE_PULL_APP_MAPPING_MISMATCH'
  | 'FEATURE_PULL_ORIGIN_FEATURE_NOT_FOUND'
  | 'FEATURE_PULL_FEATURE_PARENT_MISMATCH'
  | 'FEATURE_PULL_LOCAL_MAPPING_COLLISION';

export class ProjectSyncFeaturePullPlanError extends Error {
  constructor(
    readonly code: ProjectSyncFeaturePullPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectSyncFeaturePullPlanError';
  }
}

export interface ProjectSyncFeaturePullLocalApp {
  localId: string;
  /** A batch pull requires the App pull/mapping to have completed first. */
  originAppId: string | null;
}

export interface ProjectSyncFeaturePullOriginApp {
  originId: string;
  visibility: 'visible' | 'hidden';
}

export interface ProjectSyncFeaturePullLocalFeature {
  localId: string;
  originId: string | null;
}

/** The route adapter may build these snapshots with MediaClient. Planning only
 * compares and copies this injected data; it never touches disk or the DB. */
export interface ProjectSyncFeaturePullOriginFeature {
  originId: string;
  originAppId: string;
  name: string;
  summary: ProjectSyncSummary;
  entries: ProjectSyncEntry[];
}

export interface ProjectSyncFeaturePullPlanningData {
  localApp: ProjectSyncFeaturePullLocalApp | null;
  originApp: ProjectSyncFeaturePullOriginApp | null;
  localFeatures: ProjectSyncFeaturePullLocalFeature[];
  originFeatures: ProjectSyncFeaturePullOriginFeature[];
}

export interface PlanProjectSyncFeaturePullBatchOptions {
  now?: () => Date;
}

function invalid(message: string): never {
  throw new ProjectSyncFeaturePullPlanError('FEATURE_PULL_INVALID_REQUEST', message);
}

/** Storage ids are one bounded path segment. This intentionally accepts
 * existing Unicode/space ids while rejecting traversal and control bytes. */
export function isSafeProjectSyncFeatureId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && value === value.trim()
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function requireSafeId(label: string, value: unknown): asserts value is string {
  if (!isSafeProjectSyncFeatureId(value)) invalid(`${label} must be a safe non-empty path segment`);
}

function cloneSummary(summary: ProjectSyncSummary): ProjectSyncSummary {
  return { ...summary };
}

function cloneEntry(entry: ProjectSyncEntry): ProjectSyncEntry {
  return {
    ...entry,
    ...(entry.local ? { local: { ...entry.local } } : {}),
    ...(entry.origin ? { origin: { ...entry.origin } } : {}),
  };
}

function localIdBase(originId: string): string {
  const slug = originId
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 112);
  return slug && slug !== '.' && slug !== '..' ? slug : 'feature';
}

function allocateLocalId(base: string, occupied: Set<string>): string {
  if (!occupied.has(base)) {
    occupied.add(base);
    return base;
  }
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const suffixText = `--${suffix}`;
    const candidate = `${base.slice(0, 128 - suffixText.length)}${suffixText}`;
    if (!occupied.has(candidate)) {
      occupied.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Unable to allocate a local id for ${base}`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Pure batch planner. All DB, MediaClient, and filesystem reads belong in the
 * route adapter that constructs `data`; this function performs zero writes. */
export function planProjectSyncFeaturePullBatch(
  request: ProjectSyncFeaturePullBatchPlanRequest,
  data: ProjectSyncFeaturePullPlanningData,
  options: PlanProjectSyncFeaturePullBatchOptions = {},
): ProjectSyncFeaturePullBatchPlan {
  if (!request || typeof request !== 'object') invalid('request is required');
  requireSafeId('localAppId', request.localAppId);
  requireSafeId('originAppId', request.originAppId);
  if (!Array.isArray(request.originFeatureIds) || request.originFeatureIds.length === 0) {
    invalid('originFeatureIds must contain at least one id');
  }
  if (request.originFeatureIds.length > PROJECT_SYNC_FEATURE_PULL_BATCH_MAX) {
    invalid(`originFeatureIds exceeds the maximum batch size of ${PROJECT_SYNC_FEATURE_PULL_BATCH_MAX}`);
  }
  request.originFeatureIds.forEach((id, index) => requireSafeId(`originFeatureIds[${index}]`, id));
  if (new Set(request.originFeatureIds).size !== request.originFeatureIds.length) {
    invalid('originFeatureIds must be unique');
  }

  if (!data.localApp || data.localApp.localId !== request.localAppId) {
    throw new ProjectSyncFeaturePullPlanError('FEATURE_PULL_LOCAL_APP_NOT_FOUND', `Local App not found: ${request.localAppId}`);
  }
  if (!data.originApp || data.originApp.originId !== request.originAppId || data.originApp.visibility !== 'visible') {
    throw new ProjectSyncFeaturePullPlanError('FEATURE_PULL_ORIGIN_APP_NOT_FOUND', `Visible origin App not found: ${request.originAppId}`);
  }
  if (data.localApp.originAppId !== request.originAppId) {
    throw new ProjectSyncFeaturePullPlanError(
      'FEATURE_PULL_APP_MAPPING_MISMATCH',
      `Local App ${request.localAppId} is not mapped to origin App ${request.originAppId}`,
    );
  }

  const localByOrigin = new Map<string, ProjectSyncFeaturePullLocalFeature>();
  const occupied = new Set<string>();
  for (const local of data.localFeatures) {
    requireSafeId('local feature id', local.localId);
    if (occupied.has(local.localId)) {
      throw new ProjectSyncFeaturePullPlanError('FEATURE_PULL_LOCAL_MAPPING_COLLISION', `Duplicate local Feature id: ${local.localId}`);
    }
    occupied.add(local.localId);
    if (!local.originId) continue;
    requireSafeId('local Feature origin id', local.originId);
    if (localByOrigin.has(local.originId)) {
      throw new ProjectSyncFeaturePullPlanError(
        'FEATURE_PULL_LOCAL_MAPPING_COLLISION',
        `More than one local Feature maps to origin ${local.originId}`,
      );
    }
    localByOrigin.set(local.originId, local);
  }

  const originById = new Map(data.originFeatures.map((feature) => [feature.originId, feature]));
  const selected = request.originFeatureIds.map((originId) => {
    const origin = originById.get(originId);
    if (!origin) {
      throw new ProjectSyncFeaturePullPlanError('FEATURE_PULL_ORIGIN_FEATURE_NOT_FOUND', `Origin Feature not found: ${originId}`);
    }
    if (origin.originAppId !== request.originAppId) {
      throw new ProjectSyncFeaturePullPlanError(
        'FEATURE_PULL_FEATURE_PARENT_MISMATCH',
        `Origin Feature ${originId} does not belong to App ${request.originAppId}`,
      );
    }
    return origin;
  });

  // Allocate creates in sorted origin-id order so request checkbox order never
  // changes collision suffixes or the resulting immutable baseline.
  const allocated = new Map<string, string>();
  for (const origin of [...selected].sort((left, right) => left.originId.localeCompare(right.originId))) {
    const existing = localByOrigin.get(origin.originId);
    allocated.set(origin.originId, existing?.localId ?? allocateLocalId(localIdBase(origin.originId), occupied));
  }

  const features: ProjectSyncFeaturePullBatchPlanItem[] = selected.map((origin) => ({
    originId: origin.originId,
    name: origin.name,
    localId: allocated.get(origin.originId)!,
    mode: localByOrigin.has(origin.originId) ? 'update' : 'create',
    summary: cloneSummary(origin.summary),
    entries: origin.entries.map(cloneEntry),
  }));
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const baseline = {
    createdAt,
    localAppId: request.localAppId,
    originAppId: request.originAppId,
    features,
    totalItems: features.reduce((total, feature) => total + feature.entries.filter((entry) => entry.change !== 'unchanged' && (entry.resolution === 'pull' || entry.change === 'deleted')).length, 0),
  };
  const digest = createHash('sha256').update(JSON.stringify(baseline)).digest('hex');
  return deepFreeze({ planId: `project_sync_feature_pull_${digest}`, ...baseline });
}
