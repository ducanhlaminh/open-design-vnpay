// HTTP adapter for the App/Feature origin-sync contract. Legacy `/api/kg/*`
// endpoints deliberately remain untouched; this is the single UI + CLI surface.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import {
  ERR_PROJECT_SYNC_ORIGIN_HIDDEN,
  ERR_PROJECT_SYNC_OPERATION_NOT_FOUND,
  ERR_PROJECT_SYNC_PLAN_EXPIRED,
  type ProjectSyncApplyRequest,
  type ProjectSyncApplyResult,
  type ProjectSyncDirection,
  type ProjectSyncEntryKind,
  type ProjectSyncFeaturePullBatchOperation,
  type ProjectSyncFeaturePullBatchPlan,
  type ProjectSyncFeaturePullBatchPlanRequest,
  type ProjectSyncFeaturePullBatchResult,
  type ProjectSyncOrigin,
  type ProjectSyncOriginSelection,
  type ProjectSyncPlanRequest,
  type ProjectSyncScope,
  type ProjectSyncScopeStatus,
  type SyncEntitySummary,
} from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';
import {
  getPipelineApp,
  getProject,
  insertProject,
  listPipelineApps,
  listProjects,
  updateProject,
  upsertPipelineAppName,
} from './db.js';
import { featureContextBindingFromMetadata } from './app-context-version.js';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';
import { loadRemoteProjects, PROJECT_LIFECYCLE_PATH } from './kg-sync/remote-registry.js';
import { studioConfigOf } from './kg-sync/push-dest.js';
import { PROJECT_SYNC_PLAN_TTL_MS, ProjectSyncPlanStore, planProjectSync, projectSyncPlanIsFresh, type ProjectSyncSnapshotFile } from './project-sync.js';
import { PROJECT_SYNC_OPERATION_TTL_MS, ProjectSyncOperationStore } from './project-sync-operation-store.js';
import {
  PROJECT_SYNC_FEATURE_PULL_BATCH_MAX,
  ProjectSyncFeaturePullPlanError,
  isSafeProjectSyncFeatureId,
  planProjectSyncFeaturePullBatch,
} from './project-sync-feature-pull.js';
import { stageForOutput } from './pipelines.js';
import { digestProjectSyncSides, evaluateProjectSyncStatus } from './project-sync-status.js';
import { ProjectSyncStateStore } from './project-sync-state.js';

export interface RegisterProjectSyncRoutesDeps extends RouteDeps<'db' | 'http' | 'paths'> {}

type LocalProject = { id: string; name?: string; metadata?: unknown };
type DiagnosticOrigin = ProjectSyncOrigin & { parentLookupFailed?: boolean };
type Unit = {
  localId?: string;
  originId: string;
  prefix: string;
  featureId?: string;
  isApp: boolean;
  name: string;
  /** Replace only the display name in the main control file for a new origin. */
  overrideName?: boolean;
  /** Context-only unit used by a Feature scope. It is never independently mapped. */
  contextVersion?: string;
  persistMapping?: boolean;
  originAppId?: string | null;
  /** Pulling an App transfers only its metadata plus the immutable package
   * selected by the remote `context/current.json` pointer. App Push retains
   * the full-tree behaviour and never sets this flag. */
  latestAppContextOnly?: boolean;
};

const LOCAL_MAPPING_PATH = '_studio/project-sync-mapping.json';

const checksum = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const isHistory = (rel: string) => rel === 'changelog.json'
  || rel.startsWith('_v/')
  || rel.startsWith('context/versions/');
const isControl = (rel: string) => rel === PROJECT_LIFECYCLE_PATH
  || rel === LOCAL_MAPPING_PATH
  || rel === 'context/publish.json';
const kindOf = (rel: string, isApp: boolean): ProjectSyncEntryKind =>
  rel.startsWith('context/') ? 'context' : rel === 'project.json' && !isApp ? 'binding' : isApp ? 'context' : 'output';
const emptyTotals = () => ({ created: 0, unchanged: 0, changed: 0, deleted: 0 });

function appIdOf(project: LocalProject): string | null {
  return studioConfigOf(project.metadata).appId ?? null;
}
function mappingPropertyOf(project: LocalProject): unknown {
  const metadata = project.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const studio = (metadata as Record<string, unknown>).studioConfig;
  if (!studio || typeof studio !== 'object' || Array.isArray(studio)) return null;
  return (studio as Record<string, unknown>).projectSyncMapping;
}
function hasMappingProperty(project: LocalProject): boolean {
  const metadata = project.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const studio = (metadata as Record<string, unknown>).studioConfig;
  return Boolean(studio && typeof studio === 'object' && !Array.isArray(studio)
    && Object.prototype.hasOwnProperty.call(studio, 'projectSyncMapping'));
}
function versionedMappingOf(project: LocalProject): { originId: string; originAppId?: string | null } | null {
  const mapping = mappingPropertyOf(project);
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return null;
  const value = mapping as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.localId !== project.id || typeof value.originId !== 'string' || !value.originId) return null;
  return { originId: value.originId, ...(typeof value.originAppId === 'string' ? { originAppId: value.originAppId } : {}) };
}
/** Tolerant versioned mapping reader. Never infer origin identity from a local
 * id: missing mapping is a visible remediation state, not an association. */
export function originIdOf(project: LocalProject): string | null {
  const versioned = versionedMappingOf(project);
  if (versioned) return versioned.originId;
  // Once the versioned field exists, a malformed value is a broken mapping.
  // Falling back to remoteId would conceal the remediation state forever.
  if (hasMappingProperty(project)) return null;
  const config = studioConfigOf(project.metadata);
  return config.remoteId ?? config.approvedMapping?.approvedProjectId ?? null;
}
function originAppIdOf(project: LocalProject): string | null {
  const versioned = versionedMappingOf(project);
  if (versioned?.originAppId) return versioned.originAppId;
  if (hasMappingProperty(project)) return null;
  return studioConfigOf(project.metadata).approvedMapping?.approvedAppId ?? null;
}
function safeSegment(value: string | null | undefined): value is string {
  return Boolean(value && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\'));
}
function safeRelativePath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
async function readAppMapping(projectsDir: string, appId: string): Promise<{ originId: string } | null> {
  if (!safeSegment(appId)) return null;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(projectsDir, appId, LOCAL_MAPPING_PATH), 'utf8')) as Record<string, unknown>;
    return raw.schemaVersion === 1 && raw.localId === appId && typeof raw.originId === 'string' && raw.originId
      ? { originId: raw.originId }
      : null;
  } catch { return null; }
}
async function writeAppMapping(projectsDir: string, appId: string, originId: string): Promise<void> {
  const target = path.join(projectsDir, appId, LOCAL_MAPPING_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({ schemaVersion: 1, localId: appId, originId, mappedAt: new Date().toISOString() }, null, 2)}\n`);
}
function stateOf(summary: ReturnType<typeof emptyTotals>): 'new' | 'unchanged' | 'changed' {
  if (summary.changed) return 'changed';
  if (summary.created) return 'new';
  // `deleted` describes a target-only file in a directional PLAN. It is not
  // an entity lifecycle state and must never escape as an App/Feature badge.
  if (summary.deleted) return 'changed';
  return 'unchanged';
}
function entity(id: string, name: string, kind: SyncEntitySummary['kind'], totals: ReturnType<typeof emptyTotals>, mappingValid: boolean, originId?: string | null): SyncEntitySummary {
  return { id, name, kind, state: stateOf(totals), mappingValid, totals, ...(originId ? { originId } : {}) };
}

async function walkFiles(root: string): Promise<Array<{ rel: string; content: Buffer }>> {
  const out: Array<{ rel: string; content: Buffer }> = [];
  const visit = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.odhistory' || entry.name === 'node_modules') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(abs, rel);
      else if (entry.isFile()) {
        const content = await fs.readFile(abs).catch(() => null);
        if (content) out.push({ rel, content });
      }
    }
  };
  await visit(root, '');
  return out;
}

/** Registered separately so it stays testable and `server.ts` only wires it. */
export function registerProjectSyncRoutes(app: Express, ctx: RegisterProjectSyncRoutesDeps): void {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const plans = new ProjectSyncPlanStore();
  const operations = new ProjectSyncOperationStore();
  const syncState = new ProjectSyncStateStore(db);
  type BatchExecutionFeature = {
    originId: string;
    localId: string;
    name: string;
    mode: 'create' | 'update';
    featureFiles: Array<{ rel: string; checksum: string }>;
    contextVersion: string | null;
    contextFiles: Array<{ rel: string; checksum: string }>;
  };
  type StoredBatch = { plan: ProjectSyncFeaturePullBatchPlan; features: BatchExecutionFeature[]; expiresAt: number };
  const featurePullPlans = new Map<string, StoredBatch>();
  const featurePullOperations = new Map<string, { operation: ProjectSyncFeaturePullBatchOperation; expiresAt: number }>();
  const featurePullOperationByPlan = new Map<string, string>();
  const featurePullRetryByOperation = new Map<string, string>();
  const operationIdByPlan = new Map<string, string>();
  const expireOperationIndex = (planId: string, operationId: string): void => {
    const timer = setTimeout(() => {
      if (operationIdByPlan.get(planId) === operationId) operationIdByPlan.delete(planId);
    }, PROJECT_SYNC_OPERATION_TTL_MS);
    timer.unref();
  };
  const execution = new Map<string, { units: Unit[]; direction: ProjectSyncDirection; scope: ProjectSyncScope; localContentByPath: Map<string, Buffer>; expiresAt: number }>();
  const appliedResults = new Map<string, { expiresAt: number; result: { planId: string; applied: number; skipped: number; unchanged: number; softHiddenOriginFeatureIds: string[]; stale: Array<{ path: string; reason: string }> } }>();
  const projects = (): LocalProject[] => listProjects(db) as LocalProject[];

  const remoteOrigins = async (): Promise<DiagnosticOrigin[]> => {
    const media = new MediaClient(mediaConfigFromEnv());
    const rows = await loadRemoteProjects(media);
    await Promise.all(rows.filter((row) => !row.isApp).map(async (row) => {
      try {
        const config = JSON.parse((await media.downloadFile(row.projectId, 'project.json')).toString('utf8')) as { appId?: unknown };
        row.appId = typeof config.appId === 'string' ? config.appId : null;
      } catch {
        row.appId = null;
        (row as typeof row & { parentLookupFailed?: boolean }).parentLookupFailed = true;
      }
    }));
    return rows.map((row) => ({
      originId: row.projectId, name: row.name || row.projectId, kind: row.isApp ? 'app' : 'feature',
      appId: row.appId ?? null, visibility: row.visibility ?? 'visible', inMedia: row.inMedia,
      mappingVersion: null,
      ...((row as typeof row & { parentLookupFailed?: boolean }).parentLookupFailed ? { parentLookupFailed: true } : {}),
    }));
  };

  const unitsFor = async (
    scope: ProjectSyncScope,
    selected: ProjectSyncOriginSelection,
    materializeOriginOnly: boolean,
    diagnosticOrigin: ProjectSyncOrigin | null,
    expectedOriginAppId: string | null,
  ): Promise<Unit[]> => {
    const local = projects();
    const selectedProject = local.find((project) => project.id === scope.projectId);
    const requestedName = selected.mode === 'new' && typeof selected.name === 'string'
      ? selected.name.trim()
      : '';
    if (scope.kind === 'feature') {
      const units: Unit[] = [{
        ...(selectedProject?.id ? { localId: selectedProject.id } : {}), originId: selected.originId,
        prefix: 'feature', featureId: scope.projectId, isApp: false, name: requestedName || selectedProject?.name || scope.projectId,
        ...(requestedName ? { overrideName: true } : {}),
        originAppId: diagnosticOrigin?.appId ?? expectedOriginAppId ?? originAppIdOf(selectedProject ?? { id: scope.projectId }),
      }];
      const binding = selectedProject ? featureContextBindingFromMetadata(selectedProject.metadata) : null;
      let bindingAppId = binding?.appId ?? null;
      let boundContextVersion = binding?.contextVersion ?? null;
      if (materializeOriginOnly && selected.originId) {
        const media = new MediaClient(mediaConfigFromEnv());
        const remoteControl = JSON.parse((await media.downloadFile(selected.originId, 'project.json')).toString('utf8')) as Record<string, unknown>;
        const remoteBinding = remoteControl.appContextBinding;
        if (remoteBinding && typeof remoteBinding === 'object' && !Array.isArray(remoteBinding)) {
          const value = remoteBinding as Record<string, unknown>;
          if (typeof value.appId === 'string' && typeof value.contextVersion === 'string' && /^v[1-9]\d*$/.test(value.contextVersion)) {
            bindingAppId = value.appId;
            boundContextVersion = value.contextVersion as `v${number}`;
          }
        }
      }
      const localAppId = scope.appId ?? bindingAppId ?? null;
      const originAppId = diagnosticOrigin?.appId ?? expectedOriginAppId ?? (selectedProject ? originAppIdOf(selectedProject) : null);
      // A Feature carries exactly its immutable bound Context version. It does
      // not silently upgrade to the App's current Context or copy all history.
      if (boundContextVersion && safeSegment(localAppId) && originAppId) {
        units.push({
          localId: localAppId,
          originId: originAppId,
          prefix: 'bound-context',
          isApp: true,
          name: `Context ${boundContextVersion}`,
          contextVersion: boundContextVersion,
          persistMapping: false,
        });
      }
      return units;
    }
    const children = local.filter((project) => appIdOf(project) === scope.projectId);
    const app = getPipelineApp(db, scope.projectId) as { id: string; name: string } | null;
    return [
      {
        ...(app || children.length > 0 ? { localId: scope.projectId } : {}),
        originId: selected.originId,
        prefix: 'app',
        isApp: true,
        name: requestedName || app?.name || children.find((project) => project.name)?.name || scope.projectId,
        ...(requestedName ? { overrideName: true } : {}),
      },
      ...children.map((project) => {
        const mapped = originIdOf(project);
        // An unmapped Feature must never probe an empty (or local-id guessed)
        // folder. Pull sees it as local-only; Push allocates a fresh origin id.
        const originId = mapped ?? (materializeOriginOnly ? '' : `feature--${randomUUID()}`);
        return { localId: project.id, originId, prefix: `features/${project.id}`, featureId: project.id, isApp: false, name: project.name ?? project.id, originAppId: selected.originId };
      }),
    ];
  };

  const snapshot = async (units: Unit[], direction: ProjectSyncDirection) => {
    const media = new MediaClient(mediaConfigFromEnv());
    const localFiles: ProjectSyncSnapshotFile[] = [];
    const originFiles: ProjectSyncSnapshotFile[] = [];
    const localContentByPath = new Map<string, Buffer>();
    for (const unit of units) {
      const remoteFiles = unit.originId ? await media.listFiles(unit.originId).catch(() => []) : [];
      let latestRemoteContextVersion: `v${number}` | null = null;
      if (unit.latestAppContextOnly && remoteFiles.some((file) => file.path === 'context/current.json')) {
        try {
          const pointer = JSON.parse((await media.downloadFile(unit.originId, 'context/current.json')).toString('utf8')) as Record<string, unknown>;
          if (typeof pointer.contextVersion === 'string' && /^v[1-9]\d*$/.test(pointer.contextVersion)) {
            latestRemoteContextVersion = pointer.contextVersion as `v${number}`;
          }
        } catch {
          // A malformed/torn pointer must not make historical packages look
          // current. The App metadata remains pullable for remediation.
        }
      }
      const includeLatestAppContext = (rel: string): boolean => {
        if (!unit.latestAppContextOnly) return true;
        if (rel === 'app.json' || rel === 'context/current.json') return true;
        if (!latestRemoteContextVersion) return false;
        const versionRoot = `context/versions/${latestRemoteContextVersion}`;
        return rel === `${versionRoot}/manifest.json` || rel.startsWith(`${versionRoot}/files/`);
      };
      const localRels = new Set<string>();
      if (unit.localId) {
        for (const file of await walkFiles(path.join(ctx.paths.PROJECTS_DIR, unit.localId))) {
          if (isControl(file.rel)) continue;
          if (!includeLatestAppContext(file.rel)) continue;
          if (unit.contextVersion && !file.rel.startsWith(`context/versions/${unit.contextVersion}/`)) continue;
          let content = file.content;
          const controlRel = unit.isApp ? 'app.json' : 'project.json';
          if (unit.overrideName && file.rel === controlRel) {
            try {
              const current = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
              content = Buffer.from(`${JSON.stringify({ ...current, name: unit.name }, null, 2)}\n`);
            } catch {
              // Keep malformed source visible to the normal validation/diff
              // path instead of silently replacing the whole control file.
            }
          }
          const entryPath = `${unit.prefix}/${file.rel}`;
          localRels.add(file.rel);
          localContentByPath.set(entryPath, content);
          const stage = !unit.isApp ? stageForOutput(file.rel)?.id : undefined;
          localFiles.push({ path: entryPath, checksum: checksum(content), size: content.length, kind: kindOf(file.rel, unit.isApp), ...(unit.featureId ? { featureId: unit.featureId } : {}), ...(stage ? { stage } : {}), ...(unit.contextVersion ? { contextVersion: unit.contextVersion } : {}) });
        }
      }
      for (const file of remoteFiles) {
        const rel = typeof file.path === 'string' ? file.path : '';
        if (!rel || isControl(rel)) continue;
        if (!includeLatestAppContext(rel)) continue;
        if (unit.contextVersion && !rel.startsWith(`context/versions/${unit.contextVersion}/`)) continue;
        const stage = !unit.isApp
          ? (typeof (file as { stage?: unknown }).stage === 'string' ? (file as { stage: string }).stage : stageForOutput(rel)?.id)
          : undefined;
        originFiles.push({ path: `${unit.prefix}/${rel}`, checksum: typeof file.checksum === 'string' ? file.checksum : '', size: 0, kind: kindOf(rel, unit.isApp), ...(unit.featureId ? { featureId: unit.featureId } : {}), ...(stage ? { stage } : {}), ...(unit.contextVersion ? { contextVersion: unit.contextVersion } : {}) });
      }
      if (unit.localId && !unit.contextVersion) {
        const controlRel = unit.isApp ? 'app.json' : 'project.json';
        if (!localRels.has(controlRel)) {
          let existing: Record<string, unknown> = {};
          if (direction === 'push' && remoteFiles.some((file) => file.path === controlRel)) {
            try { existing = JSON.parse((await media.downloadFile(unit.originId, controlRel)).toString('utf8')) as Record<string, unknown>; } catch { /* use local fields only */ }
          }
          const project = unit.featureId ? projects().find((candidate) => candidate.id === unit.localId) : null;
          const binding = project ? featureContextBindingFromMetadata(project.metadata) : null;
          const content = Buffer.from(`${JSON.stringify(unit.isApp ? {
            ...existing,
            kind: 'app',
            name: unit.name,
          } : {
            ...existing,
            name: unit.name,
            ...(unit.originAppId ? { appId: unit.originAppId } : {}),
            ...(binding ? { appContextBinding: unit.originAppId && binding.appId !== unit.originAppId ? { ...binding, appId: unit.originAppId } : binding } : {}),
          }, null, 2)}\n`);
          const entryPath = `${unit.prefix}/${controlRel}`;
          localContentByPath.set(entryPath, content);
          localFiles.push({ path: entryPath, checksum: checksum(content), size: content.length, kind: unit.isApp ? 'context' : 'binding', ...(unit.featureId ? { featureId: unit.featureId } : {}) });
        }
      }
    }
    return { localFiles, originFiles, localContentByPath };
  };

  const planFor = async (request: ProjectSyncPlanRequest, options: { retain?: boolean; origins?: ProjectSyncOrigin[]; statusScope?: boolean } = {}) => {
    const localProject = projects().find((project) => project.id === request.scope.projectId);
    const mappedOrigin = request.scope.kind === 'app'
      ? (await readAppMapping(ctx.paths.PROJECTS_DIR, request.scope.projectId))?.originId ?? null
      : localProject ? originIdOf(localProject) : null;
    if (!request.origin && !mappedOrigin) {
      const error = new Error('origin mapping is required; choose an existing origin or a new origin id') as Error & { code?: string };
      error.code = 'ORIGIN_REQUIRED';
      throw error;
    }
    const defaultOrigin: ProjectSyncOriginSelection = request.origin ?? { mode: 'existing', originId: mappedOrigin! };
    const allOrigins = options.origins ?? await remoteOrigins();
    const diagnosticOrigin = allOrigins.find((origin) => origin.originId === defaultOrigin.originId) ?? null;
    if (request.direction === 'push' && diagnosticOrigin?.visibility === 'hidden') {
      const error = new Error('a soft-hidden origin cannot be revived; choose a new origin id') as Error & { code?: string };
      error.code = ERR_PROJECT_SYNC_ORIGIN_HIDDEN;
      throw error;
    }
    if (request.direction === 'push' && defaultOrigin.mode === 'new' && diagnosticOrigin) {
      const error = new Error('the requested new origin id already exists; choose another id') as Error & { code?: string };
      error.code = 'ORIGIN_ID_EXISTS';
      throw error;
    }
    const expectedOriginAppId = request.scope.kind === 'feature' && request.scope.appId
      ? (localProject ? originAppIdOf(localProject) : null)
        ?? (await readAppMapping(ctx.paths.PROJECTS_DIR, request.scope.appId))?.originId
        ?? null
      : null;
    const typeValid = diagnosticOrigin?.kind === request.scope.kind;
    const parentValid = request.scope.kind !== 'feature' || !request.scope.appId
      || Boolean(expectedOriginAppId && diagnosticOrigin?.appId === expectedOriginAppId);
    const mappingValid = defaultOrigin.mode === 'new'
      ? request.scope.kind === 'app' || !request.scope.appId || Boolean(expectedOriginAppId)
      : Boolean(diagnosticOrigin?.visibility === 'visible' && typeValid && parentValid);
    if (request.direction === 'pull' && !mappingValid) {
      const error = new Error('origin mapping is missing, hidden, or belongs to another scope') as Error & { code?: string };
      error.code = 'ORIGIN_MAPPING_INVALID';
      throw error;
    }
    if (request.direction === 'push' && defaultOrigin.mode === 'existing' && !mappingValid) {
      const error = new Error('the selected origin is missing or belongs to another scope') as Error & { code?: string };
      error.code = 'ORIGIN_MAPPING_INVALID';
      throw error;
    }
    const units = await unitsFor(request.scope, defaultOrigin, request.direction === 'pull', diagnosticOrigin, expectedOriginAppId);
    if (options.statusScope && request.scope.kind === 'app') {
      units.splice(1);
      if (units[0]) units[0].latestAppContextOnly = true;
    }
    if (request.direction === 'pull' && request.scope.kind === 'app') {
      // App Pull is deliberately a context-only operation. Keep one App unit,
      // materialize a first-time local container only during APPLY, and never
      // let local or origin-only Features enter the PLAN.
      units.splice(1);
      const appUnit = units[0];
      if (appUnit) {
        appUnit.localId = request.scope.projectId;
        appUnit.name = diagnosticOrigin?.name || appUnit.name;
        appUnit.latestAppContextOnly = true;
      }
    }
    // App Push sees origin-only Features as `deleted`, which APPLY converts
    // into a lifecycle soft-hide. App Pull intentionally never reaches here.
    if (request.scope.kind === 'app' && request.direction === 'push' && !options.statusScope) {
      for (const origin of allOrigins.filter((row) => row.kind === 'feature' && row.appId === defaultOrigin.originId && row.visibility === 'visible')) {
        if (!units.some((unit) => unit.originId === origin.originId)) units.push({ originId: origin.originId, prefix: `features/${origin.originId}`, featureId: origin.originId, isApp: false, name: origin.name });
      }
    }
    const files = await snapshot(units, request.direction);
    const built = planProjectSync({ direction: request.direction, scope: request.scope, origin: defaultOrigin, local: files.localFiles, originFiles: files.originFiles });
    const totalsFor = (predicate: (entry: typeof built.plan.entries[number]) => boolean) => {
      const totals = emptyTotals();
      for (const entry of built.plan.entries.filter(predicate)) {
        if (entry.change === 'new') totals.created += 1;
        else totals[entry.change] += 1;
      }
      return totals;
    };
    const totals = built.plan.summary;
    const requestedName = defaultOrigin.mode === 'new' && typeof defaultOrigin.name === 'string'
      ? defaultOrigin.name.trim()
      : '';
    const selected = entity(request.scope.projectId, requestedName || localProject?.name || getPipelineApp(db, request.scope.projectId)?.name || request.scope.projectId, request.scope.kind, totals, mappingValid, defaultOrigin.originId);
    if (request.scope.kind === 'app') built.plan.app = selected;
    else if (request.scope.appId) {
      const appTotals = totalsFor((entry) => entry.kind === 'context');
      built.plan.app = entity(request.scope.appId, getPipelineApp(db, request.scope.appId)?.name ?? request.scope.appId, 'app', appTotals, Boolean(expectedOriginAppId), expectedOriginAppId);
    }
    if (request.scope.appId || request.scope.kind === 'app') {
      const contextUnit = units.find((unit) => unit.contextVersion);
      built.plan.context = {
        ...entity(request.scope.appId ?? request.scope.projectId, contextUnit?.name ?? 'Context', 'context', totalsFor((entry) => entry.kind === 'context'), mappingValid, contextUnit?.originId ?? defaultOrigin.originId),
        ...(contextUnit?.contextVersion ? { contextVersion: contextUnit.contextVersion } : {}),
      };
    }
    built.plan.features = units.filter((unit) => !unit.isApp).map((unit) => entity(
      unit.featureId ?? unit.originId,
      unit.name,
      'feature',
      totalsFor((entry) => entry.featureId === unit.featureId),
      mappingValid,
      unit.originId,
    ));
    if (options.retain !== false) {
      plans.put(built);
      execution.set(built.plan.planId, {
        units,
        direction: request.direction,
        scope: request.scope,
        localContentByPath: files.localContentByPath,
        expiresAt: Date.now() + PROJECT_SYNC_PLAN_TTL_MS,
      });
    }
    return { plan: built.plan, files, origin: diagnosticOrigin, mappingValid };
  };

  const sweepFeaturePull = (): void => {
    const now = Date.now();
    for (const [id, record] of featurePullPlans) if (record.expiresAt <= now) featurePullPlans.delete(id);
    for (const [id, record] of featurePullOperations) {
      if (record.expiresAt > now) continue;
      featurePullOperations.delete(id);
      if (featurePullOperationByPlan.get(record.operation.planId) === id) featurePullOperationByPlan.delete(record.operation.planId);
    }
  };

  const featurePullOperation = (planId: string, totalItems: number): ProjectSyncFeaturePullBatchOperation => {
    const now = Date.now();
    return {
      operationId: `project_sync_feature_pull_operation_${randomUUID()}`,
      planId,
      state: 'queued',
      phase: 'validating',
      progress: { completedItems: 0, totalItems, percent: totalItems === 0 ? 100 : 0 },
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PROJECT_SYNC_OPERATION_TTL_MS).toISOString(),
    };
  };

  const saveFeaturePullOperation = (operation: ProjectSyncFeaturePullBatchOperation): void => {
    const now = Date.now();
    operation.updatedAt = new Date(now).toISOString();
    operation.expiresAt = new Date(now + PROJECT_SYNC_OPERATION_TTL_MS).toISOString();
    featurePullOperations.set(operation.operationId, { operation, expiresAt: now + PROJECT_SYNC_OPERATION_TTL_MS });
  };

  const featureSnapshot = async (originId: string, localId: string | null, localAppId: string) => {
    const media = new MediaClient(mediaConfigFromEnv());
    const localFiles: ProjectSyncSnapshotFile[] = [];
    if (localId) for (const file of await walkFiles(path.join(ctx.paths.PROJECTS_DIR, localId))) {
      if (isControl(file.rel)) continue;
      const stage = stageForOutput(file.rel)?.id;
      localFiles.push({ path: `feature/${file.rel}`, checksum: checksum(file.content), size: file.content.length, kind: kindOf(file.rel, false), featureId: originId, ...(stage ? { stage } : {}) });
    }
    const originFiles: ProjectSyncSnapshotFile[] = [];
    const featureFiles: Array<{ rel: string; checksum: string }> = [];
    for (const file of await media.listFiles(originId)) {
      const rel = typeof file.path === 'string' ? file.path : '';
      if (!rel || isControl(rel)) continue;
      if (!safeRelativePath(rel)) throw new Error(`Unsafe remote Feature path: ${rel}`);
      const content = await media.downloadFile(originId, rel);
      const digest = checksum(content);
      let comparisonContent = content;
      if (rel === 'project.json') {
        const remote = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
        comparisonContent = Buffer.from(`${JSON.stringify({
          ...remote,
          appId: localAppId,
          ...(remote.appContextBinding && typeof remote.appContextBinding === 'object' && !Array.isArray(remote.appContextBinding)
            ? { appContextBinding: { ...(remote.appContextBinding as Record<string, unknown>), appId: localAppId } }
            : {}),
        }, null, 2)}\n`);
      }
      const stage = stageForOutput(rel)?.id;
      featureFiles.push({ rel, checksum: digest });
      originFiles.push({ path: `feature/${rel}`, checksum: checksum(comparisonContent), size: comparisonContent.length, kind: kindOf(rel, false), featureId: originId, ...(stage ? { stage } : {}) });
    }
    return { localFiles, originFiles, featureFiles };
  };

  const boundContextSnapshot = async (originAppId: string, localAppId: string, contextVersion: string | null, featureId: string) => {
    const empty = { localFiles: [] as ProjectSyncSnapshotFile[], originFiles: [] as ProjectSyncSnapshotFile[], contextFiles: [] as Array<{ rel: string; checksum: string }> };
    if (!contextVersion || !/^v[1-9]\d*$/.test(contextVersion)) return empty;
    const media = new MediaClient(mediaConfigFromEnv());
    const root = `context/versions/${contextVersion}`;
    const remote = (await media.listFiles(originAppId)).filter((file) => typeof file.path === 'string' && (file.path === `${root}/manifest.json` || file.path.startsWith(`${root}/files/`)));
    if (!remote.some((file) => file.path === `${root}/manifest.json`)) throw new Error(`Bound Context ${contextVersion} is missing from origin App ${originAppId}`);
    for (const file of remote) {
      const rel = file.path as string;
      if (!safeRelativePath(rel)) throw new Error(`Unsafe bound Context path: ${rel}`);
      const content = await media.downloadFile(originAppId, rel);
      const digest = checksum(content);
      const entryPath = `bound-context/${featureId}/${rel}`;
      empty.originFiles.push({ path: entryPath, checksum: digest, size: content.length, kind: 'context', featureId, contextVersion });
      empty.contextFiles.push({ rel, checksum: digest });
      const local = await fs.readFile(path.join(ctx.paths.PROJECTS_DIR, localAppId, rel)).catch(() => null);
      if (local) empty.localFiles.push({ path: entryPath, checksum: checksum(local), size: local.length, kind: 'context', featureId, contextVersion });
    }
    return empty;
  };

  const buildFeaturePullBatch = async (request: ProjectSyncFeaturePullBatchPlanRequest): Promise<StoredBatch> => {
    if (!request || typeof request !== 'object'
      || !isSafeProjectSyncFeatureId(request.localAppId)
      || !isSafeProjectSyncFeatureId(request.originAppId)
      || !Array.isArray(request.originFeatureIds)
      || request.originFeatureIds.length === 0
      || request.originFeatureIds.length > PROJECT_SYNC_FEATURE_PULL_BATCH_MAX
      || request.originFeatureIds.some((id) => !isSafeProjectSyncFeatureId(id))
      || new Set(request.originFeatureIds).size !== request.originFeatureIds.length) {
      throw new ProjectSyncFeaturePullPlanError('FEATURE_PULL_INVALID_REQUEST', 'localAppId, originAppId, and unique safe originFeatureIds are required');
    }
    const origins = await remoteOrigins();
    const localApp = getPipelineApp(db, request.localAppId) as { id: string } | null;
    const appMapping = await readAppMapping(ctx.paths.PROJECTS_DIR, request.localAppId);
    const localFeatures = projects().filter((project) => appIdOf(project) === request.localAppId);
    const originApp = origins.find((origin) => origin.originId === request.originAppId && origin.kind === 'app') ?? null;
    const executionByOrigin = new Map<string, Omit<BatchExecutionFeature, 'localId' | 'mode'>>();
    const originFeatures = [];
    const media = new MediaClient(mediaConfigFromEnv());
    for (const originId of request.originFeatureIds) {
      const origin = origins.find((row) => row.originId === originId && row.kind === 'feature' && row.visibility === 'visible');
      if (!origin) continue;
      const mapped = localFeatures.find((project) => originIdOf(project) === originId) ?? null;
      const feature = await featureSnapshot(originId, mapped?.id ?? null, request.localAppId);
      const projectFile = await media.downloadFile(originId, 'project.json');
      const config = JSON.parse(projectFile.toString('utf8')) as Record<string, unknown>;
      const rawBinding = config.appContextBinding;
      const contextVersion = rawBinding && typeof rawBinding === 'object' && !Array.isArray(rawBinding) && typeof (rawBinding as Record<string, unknown>).contextVersion === 'string'
        ? (rawBinding as Record<string, unknown>).contextVersion as string : null;
      const context = await boundContextSnapshot(request.originAppId, request.localAppId, contextVersion, originId);
      const built = planProjectSync({ direction: 'pull', scope: { kind: 'feature', projectId: mapped?.id ?? originId, appId: request.localAppId }, origin: { mode: 'existing', originId }, local: [...feature.localFiles, ...context.localFiles], originFiles: [...feature.originFiles, ...context.originFiles] });
      originFeatures.push({ originId, originAppId: origin.appId ?? '', name: origin.name, summary: built.plan.summary, entries: built.plan.entries });
      executionByOrigin.set(originId, { originId, name: origin.name, featureFiles: feature.featureFiles, contextVersion, contextFiles: context.contextFiles });
    }
    const plan = planProjectSyncFeaturePullBatch(request, {
      localApp: localApp ? { localId: localApp.id, originAppId: appMapping?.originId ?? null } : null,
      originApp: originApp ? { originId: originApp.originId, visibility: originApp.visibility } : null,
      localFeatures: localFeatures.map((project) => ({ localId: project.id, originId: originIdOf(project) })),
      originFeatures,
    });
    const features = plan.features.map((item) => ({ ...executionByOrigin.get(item.originId)!, localId: item.localId, mode: item.mode }));
    return { plan, features, expiresAt: Date.now() + PROJECT_SYNC_PLAN_TTL_MS };
  };

  // Visible picker rows only. `kind=feature&appId=…` is the App-filter seam.
  app.get('/api/project-sync/origins', async (req, res) => {
    try {
      const kind = req.query.kind === 'app' || req.query.kind === 'feature' ? req.query.kind : undefined;
      const appId = typeof req.query.appId === 'string' ? req.query.appId : undefined;
      const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
      const origins = (await remoteOrigins()).filter((origin) => origin.visibility === 'visible')
        .filter((origin) => !kind || origin.kind === kind)
        .filter((origin) => !appId || origin.appId === appId)
        .filter((origin) => !q || origin.originId.toLowerCase().includes(q) || origin.name.toLowerCase().includes(q));
      res.json({ ok: true, data: { origins } });
    } catch (error) { sendApiError(res, 502, 'PROJECT_SYNC_ORIGINS_FAILED', (error as Error).message); }
  });

  app.post('/api/project-sync/plan', async (req, res) => {
    const body = (req.body ?? {}) as Partial<ProjectSyncPlanRequest>;
    const originValid = body.origin == null || (
      (body.origin.mode === 'existing' || body.origin.mode === 'new')
      && safeSegment(body.origin.originId)
      && (body.origin.mode !== 'new' || body.origin.name == null || (typeof body.origin.name === 'string' && body.origin.name.trim().length <= 160))
    );
    if ((body.direction !== 'pull' && body.direction !== 'push') || !body.scope || (body.scope.kind !== 'app' && body.scope.kind !== 'feature') || !safeSegment(body.scope.projectId) || (body.scope.appId != null && !safeSegment(body.scope.appId)) || !originValid) return sendApiError(res, 400, 'BAD_REQUEST', 'direction, a safe scope, and a valid destination are required');
    try { res.json({ ok: true, data: (await planFor(body as ProjectSyncPlanRequest)).plan }); }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (code === ERR_PROJECT_SYNC_ORIGIN_HIDDEN || code === 'ORIGIN_ID_EXISTS' || code === 'ORIGIN_MAPPING_INVALID') return sendApiError(res, 409, code, (error as Error).message);
      if (code === 'ORIGIN_REQUIRED') return sendApiError(res, 400, 'ORIGIN_REQUIRED', (error as Error).message);
      sendApiError(res, 502, 'PROJECT_SYNC_PLAN_FAILED', (error as Error).message);
    }
  });

  app.post('/api/project-sync/status', async (req, res) => {
    const requested: ProjectSyncScope[] = Array.isArray(req.body?.scopes) ? req.body.scopes as ProjectSyncScope[] : [
      ...listPipelineApps(db).map((app) => ({ kind: 'app' as const, projectId: app.id })),
      ...projects().map((project) => {
        const appId = appIdOf(project);
        return { kind: 'feature' as const, projectId: project.id, ...(appId ? { appId } : {}) };
      }),
    ];
    const results: ProjectSyncScopeStatus[] = [];
    const checkedAt = new Date().toISOString();
    const statusOrigins = await remoteOrigins().catch(() => null);
    for (const scope of requested) {
      let mapped: string | null = null;
      let diagnostic: DiagnosticOrigin | null = null;
      try {
        const localProject = projects().find((project) => project.id === scope.projectId);
        mapped = scope.kind === 'app'
          ? (await readAppMapping(ctx.paths.PROJECTS_DIR, scope.projectId))?.originId ?? null
          : localProject ? originIdOf(localProject) : null;
        if (!mapped) {
          results.push({ scope, origin: null, status: 'not_shared', reason: 'mapping_missing', checkedAt, state: 'new', mappingValid: false, features: [], summary: { created: 1, unchanged: 0, changed: 0, deleted: 0 }, entries: [] });
          continue;
        }
        if (!statusOrigins) {
          const baseline = syncState.get(scope, { originId: mapped });
          results.push({ scope, status: 'unavailable', reason: 'status_check_failed', checkedAt, ...(baseline ? { lastSyncedAt: baseline.lastSyncedAt } : {}), state: 'changed', mappingValid: true, features: [], summary: emptyTotals(), entries: [], error: 'origin registry unavailable' });
          continue;
        }
        diagnostic = statusOrigins.find((origin) => origin.originId === mapped) ?? null;
        if (diagnostic?.parentLookupFailed) {
          const baseline = syncState.get(scope, { originId: mapped });
          results.push({ scope, origin: diagnostic, status: 'unavailable', reason: 'status_check_failed', checkedAt, ...(baseline ? { lastSyncedAt: baseline.lastSyncedAt } : {}), state: 'changed', mappingValid: true, features: [], summary: emptyTotals(), entries: [], error: 'origin parent could not be verified' });
          continue;
        }
        if (!diagnostic || diagnostic.visibility === 'hidden' || diagnostic.kind !== scope.kind) {
          const baseline = syncState.get(scope, { originId: mapped, originAppId: diagnostic?.appId ?? null });
          results.push({ scope, origin: diagnostic, status: 'origin_missing', reason: 'origin_missing_or_hidden', checkedAt, ...(baseline ? { lastSyncedAt: baseline.lastSyncedAt } : {}), state: 'new', mappingValid: false, features: [], summary: emptyTotals(), entries: [] });
          continue;
        }
        const planned = await planFor(
          { direction: 'push', scope, origin: { mode: 'existing', originId: mapped } },
          { retain: false, origins: statusOrigins, statusScope: true },
        );
        const baselineIdentity = { originId: mapped, originAppId: diagnostic.appId ?? null };
        const evaluated = evaluateProjectSyncStatus(digestProjectSyncSides(planned.files.localFiles, planned.files.originFiles), syncState.get(scope, baselineIdentity));
        results.push({ scope, origin: planned.origin, ...evaluated, checkedAt, state: stateOf(planned.plan.summary), mappingValid: planned.mappingValid, ...(planned.plan.app ? { app: planned.plan.app } : {}), ...(planned.plan.context ? { context: planned.plan.context } : {}), features: planned.plan.features, summary: planned.plan.summary, entries: planned.plan.entries });
      } catch (error) {
        const code = (error as Error & { code?: string }).code;
        if (code === ERR_PROJECT_SYNC_ORIGIN_HIDDEN || code === 'ORIGIN_MAPPING_INVALID') {
          diagnostic = mapped ? statusOrigins?.find((origin) => origin.originId === mapped) ?? null : null;
          results.push({ scope, origin: diagnostic, status: 'origin_missing', reason: 'origin_missing_or_hidden', checkedAt, state: 'new', mappingValid: false, features: [], summary: { created: 1, unchanged: 0, changed: 0, deleted: 0 }, entries: [], error: (error as Error).message });
        } else {
          const baseline = mapped ? syncState.get(scope, { originId: mapped, originAppId: diagnostic?.appId ?? null }) : null;
          results.push({ scope, status: 'unavailable', reason: 'status_check_failed', checkedAt, ...(baseline ? { lastSyncedAt: baseline.lastSyncedAt } : {}), state: 'changed', mappingValid: Boolean(mapped), features: [], summary: emptyTotals(), entries: [], error: (error as Error).message });
        }
      }
    }
    res.json({ ok: true, data: { results } });
  });

  app.post('/api/project-sync/feature-pulls/plan', async (req, res) => {
    const body = (req.body ?? {}) as ProjectSyncFeaturePullBatchPlanRequest;
    try {
      sweepFeaturePull();
      const stored = await buildFeaturePullBatch(body);
      featurePullPlans.set(stored.plan.planId, stored);
      res.json({ ok: true, data: stored.plan });
    } catch (error) {
      if (error instanceof ProjectSyncFeaturePullPlanError) {
        const status = error.code === 'FEATURE_PULL_INVALID_REQUEST' ? 400
          : error.code === 'FEATURE_PULL_LOCAL_APP_NOT_FOUND' || error.code === 'FEATURE_PULL_ORIGIN_APP_NOT_FOUND' || error.code === 'FEATURE_PULL_ORIGIN_FEATURE_NOT_FOUND' ? 404
            : 409;
        return sendApiError(res, status, error.code, error.message);
      }
      sendApiError(res, 502, 'FEATURE_PULL_PLAN_FAILED', (error as Error).message);
    }
  });

  const runFeaturePullBatch = async (
    stored: StoredBatch,
    operation: ProjectSyncFeaturePullBatchOperation,
    selectedOriginIds: Set<string>,
  ): Promise<void> => {
    operation.state = 'running';
    operation.phase = 'validating';
    saveFeaturePullOperation(operation);
    const media = new MediaClient(mediaConfigFromEnv());
    let completed = 0;
    const items: ProjectSyncFeaturePullBatchResult['items'] = [];
    const updateProgress = (phase: 'validating' | 'transferring' | 'finalizing', currentFeatureId?: string | null, currentPath?: string | null): void => {
      operation.phase = phase;
      operation.progress = {
        completedItems: completed,
        totalItems: operation.progress.totalItems,
        percent: operation.progress.totalItems === 0 ? 100 : Math.floor((completed / operation.progress.totalItems) * 100),
        ...(currentFeatureId !== undefined ? { currentFeatureId } : {}),
        ...(currentPath !== undefined ? { currentPath } : {}),
      };
      saveFeaturePullOperation(operation);
    };
    for (const feature of stored.features.filter((item) => selectedOriginIds.has(item.originId))) {
      const planned = stored.plan.features.find((item) => item.originId === feature.originId)!;
      const actionable = planned.entries.filter((entry) => entry.change !== 'unchanged' && (entry.resolution === 'pull' || entry.change === 'deleted'));
      const completedBeforeFeature = completed;
      const stageRoot = await fs.mkdtemp(path.join(ctx.paths.PROJECTS_DIR, `.feature-pull-${feature.localId}-`));
      const stageFeature = path.join(stageRoot, 'feature');
      const stageContext = path.join(stageRoot, 'context');
      const destination = path.join(ctx.paths.PROJECTS_DIR, feature.localId);
      const backup = path.join(ctx.paths.PROJECTS_DIR, `.feature-pull-backup-${feature.localId}-${randomUUID()}`);
      let backedUp = false;
      let installedDestination = false;
      try {
        updateProgress('validating', feature.originId, null);
        const control = JSON.parse((await media.downloadFile(feature.originId, 'project.json')).toString('utf8')) as Record<string, unknown>;
        if (control.appId !== stored.plan.originAppId) throw new Error(`Feature ${feature.originId} no longer belongs to App ${stored.plan.originAppId}`);
        if (feature.mode === 'update') await fs.cp(destination, stageFeature, { recursive: true });
        else await fs.mkdir(stageFeature, { recursive: true });
        updateProgress('transferring', feature.originId, null);
        for (const entry of actionable) {
          updateProgress('transferring', feature.originId, entry.path);
          if (entry.path.startsWith('feature/')) {
            const rel = entry.path.slice('feature/'.length);
            if (entry.change === 'deleted') {
              await fs.rm(path.join(stageFeature, rel), { recursive: true, force: true });
              completed += 1;
              updateProgress('transferring', feature.originId, entry.path);
              continue;
            }
            const expected = feature.featureFiles.find((file) => file.rel === rel);
            if (!expected) throw new Error(`Remote Feature file disappeared: ${rel}`);
            const content = await media.downloadFile(feature.originId, rel);
            if (checksum(content) !== expected.checksum) throw new Error(`Remote Feature changed after PLAN: ${rel}`);
            const target = path.join(stageFeature, rel);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, content);
          } else if (entry.path.startsWith(`bound-context/${feature.originId}/`)) {
            const rel = entry.path.slice(`bound-context/${feature.originId}/`.length);
            const expected = feature.contextFiles.find((file) => file.rel === rel);
            if (!expected) throw new Error(`Bound Context file disappeared: ${rel}`);
            const content = await media.downloadFile(stored.plan.originAppId, rel);
            if (checksum(content) !== expected.checksum) throw new Error(`Bound Context changed after PLAN: ${rel}`);
            const target = path.join(stageContext, rel);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, content);
          }
          completed += 1;
          updateProgress('transferring', feature.originId, entry.path);
        }
        // Local project control always points at local ownership while the
        // explicit mapping below retains remote identity.
        const localControl = {
          ...control,
          appId: stored.plan.localAppId,
          ...(control.appContextBinding && typeof control.appContextBinding === 'object' && !Array.isArray(control.appContextBinding)
            ? { appContextBinding: { ...(control.appContextBinding as Record<string, unknown>), appId: stored.plan.localAppId } }
            : {}),
        };
        await fs.writeFile(path.join(stageFeature, 'project.json'), `${JSON.stringify(localControl, null, 2)}\n`);
        updateProgress('finalizing', feature.originId, null);
        // Context is immutable and shared by Features, so copying an exact
        // verified package is safe even when another item already installed it.
        if (feature.contextVersion) {
          const stagedVersion = path.join(stageContext, 'context', 'versions', feature.contextVersion);
          const targetVersion = path.join(ctx.paths.PROJECTS_DIR, stored.plan.localAppId, 'context', 'versions', feature.contextVersion);
          if (await fs.stat(stagedVersion).then(() => true, () => false)) {
            await fs.mkdir(path.dirname(targetVersion), { recursive: true });
            await fs.cp(stagedVersion, targetVersion, { recursive: true, force: true });
          }
        }
        if (await fs.stat(destination).then(() => true, () => false)) {
          await fs.rename(destination, backup);
          backedUp = true;
        }
        await fs.rename(stageFeature, destination);
        installedDestination = true;
        const existing = getProject(db, feature.localId) as LocalProject | null;
        const previousMetadata = existing?.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
          ? existing.metadata as Record<string, unknown> : {};
        const remoteBinding = control.appContextBinding && typeof control.appContextBinding === 'object' && !Array.isArray(control.appContextBinding)
          ? { ...(control.appContextBinding as Record<string, unknown>), appId: stored.plan.localAppId } : null;
        const oldStudio = previousMetadata.studioConfig && typeof previousMetadata.studioConfig === 'object' && !Array.isArray(previousMetadata.studioConfig)
          ? previousMetadata.studioConfig as Record<string, unknown> : {};
        const metadata = {
          ...previousMetadata,
          source: 'kg-pull',
          ...(remoteBinding ? { appContextBinding: remoteBinding } : {}),
          studioConfig: {
            ...oldStudio,
            appId: stored.plan.localAppId,
            remoteId: feature.originId,
            projectSyncMapping: { schemaVersion: 1, localId: feature.localId, originId: feature.originId, originAppId: stored.plan.originAppId, mappedAt: new Date().toISOString() },
          },
        };
        if (existing) updateProject(db, feature.localId, { name: feature.name, metadata, updatedAt: Date.now() });
        else insertProject(db, { id: feature.localId, name: feature.name, skillId: null, designSystemId: null, pendingPrompt: null, metadata, createdAt: Date.now(), updatedAt: Date.now() });
        if (backedUp) await fs.rm(backup, { recursive: true, force: true });
        const featureScope: ProjectSyncScope = { kind: 'feature', projectId: feature.localId, appId: stored.plan.localAppId };
        const identity = { originId: feature.originId, originAppId: stored.plan.originAppId };
        // Re-snapshot through the same code path used by STATUS. Local control
        // files intentionally retain local App ids, so the two canonical side
        // digests may differ even after a clean pull; the baseline records each
        // side independently.
        try {
          const verified = await planFor(
            { direction: 'push', scope: featureScope, origin: { mode: 'existing', originId: feature.originId } },
            { retain: false, origins: [
              { originId: stored.plan.originAppId, name: stored.plan.originAppId, kind: 'app', visibility: 'visible', inMedia: true },
              { originId: feature.originId, name: feature.name, kind: 'feature', appId: stored.plan.originAppId, visibility: 'visible', inMedia: true },
            ] },
          );
          syncState.recordClean(featureScope, identity, digestProjectSyncSides(verified.files.localFiles, verified.files.originFiles), feature.contextVersion);
        } catch {
          // The files were installed atomically, but a post-install remote
          // verification can still fail (for example, temporary network loss).
          // Keep the usable Feature and expose a retryable incomplete status.
          syncState.markIncomplete(featureScope, identity, undefined, feature.contextVersion);
        }
        const unchanged = planned.entries.filter((entry) => entry.change === 'unchanged').length;
        items.push({ originId: feature.originId, localId: feature.localId, state: 'succeeded', result: { planId: stored.plan.planId, applied: actionable.length, skipped: planned.entries.length - actionable.length - unchanged, unchanged, softHiddenOriginFeatureIds: [], stale: [] } });
      } catch (error) {
        syncState.markIncomplete(
          { kind: 'feature', projectId: feature.localId, appId: stored.plan.localAppId },
          { originId: feature.originId, originAppId: stored.plan.originAppId },
          undefined,
          feature.contextVersion,
        );
        if (installedDestination) await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
        if (backedUp) {
          await fs.rename(backup, destination).catch(() => undefined);
        }
        // Count the remainder of this item as processed so operation progress
        // remains monotonic and reaches 100% even for partial failure.
        completed = completedBeforeFeature + actionable.length;
        items.push({ originId: feature.originId, localId: feature.localId, state: 'failed', error: { code: 'FEATURE_PULL_ITEM_FAILED', message: (error as Error).message, retryable: true } });
      } finally {
        await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
        updateProgress('transferring', feature.originId, null);
      }
    }
    const succeeded = items.filter((item) => item.state === 'succeeded').length;
    const result: ProjectSyncFeaturePullBatchResult = {
      planId: stored.plan.planId,
      localAppId: stored.plan.localAppId,
      originAppId: stored.plan.originAppId,
      state: succeeded === items.length ? 'succeeded' : succeeded === 0 ? 'failed' : 'partial',
      items,
    };
    operation.state = 'succeeded';
    operation.phase = 'finalizing';
    operation.progress = { completedItems: operation.progress.totalItems, totalItems: operation.progress.totalItems, percent: 100 };
    operation.result = result;
    saveFeaturePullOperation(operation);
  };

  const startFeaturePullOperation = (stored: StoredBatch, selectedOriginIds: Set<string>): ProjectSyncFeaturePullBatchOperation => {
    const totalItems = stored.plan.features.filter((feature) => selectedOriginIds.has(feature.originId))
      .reduce((total, feature) => total + feature.entries.filter((entry) => entry.change !== 'unchanged' && (entry.resolution === 'pull' || entry.change === 'deleted')).length, 0);
    const operation = featurePullOperation(stored.plan.planId, totalItems);
    saveFeaturePullOperation(operation);
    setImmediate(() => void runFeaturePullBatch(stored, operation, selectedOriginIds).catch((error: Error) => {
      operation.state = 'failed';
      operation.error = { code: 'FEATURE_PULL_OPERATION_FAILED', message: error.message, retryable: true };
      saveFeaturePullOperation(operation);
    }));
    return operation;
  };

  app.post('/api/project-sync/feature-pulls/operations', (req, res) => {
    sweepFeaturePull();
    const planId = typeof req.body?.planId === 'string' ? req.body.planId : '';
    if (!planId) return sendApiError(res, 400, 'BAD_REQUEST', 'planId is required');
    const stored = featurePullPlans.get(planId);
    if (!stored) return sendApiError(res, 409, ERR_PROJECT_SYNC_PLAN_EXPIRED, 'Feature pull plan expired — re-plan and retry');
    const existingId = featurePullOperationByPlan.get(planId);
    const existing = existingId ? featurePullOperations.get(existingId)?.operation : null;
    if (existing) return res.status(existing.state === 'queued' || existing.state === 'running' ? 202 : 200).json({ ok: true, data: existing });
    const operation = startFeaturePullOperation(stored, new Set(stored.plan.features.map((feature) => feature.originId)));
    featurePullOperationByPlan.set(planId, operation.operationId);
    res.status(202).json({ ok: true, data: operation });
  });

  app.get('/api/project-sync/feature-pulls/operations/:id', (req, res) => {
    sweepFeaturePull();
    const record = featurePullOperations.get(typeof req.params.id === 'string' ? req.params.id : '');
    if (!record) return sendApiError(res, 404, ERR_PROJECT_SYNC_OPERATION_NOT_FOUND, 'Feature pull operation not found or expired');
    res.json({ ok: true, data: record.operation });
  });

  app.post('/api/project-sync/feature-pulls/operations/:id/retry', (req, res) => {
    sweepFeaturePull();
    const previousId = typeof req.params.id === 'string' ? req.params.id : '';
    const previous = featurePullOperations.get(previousId)?.operation;
    if (!previous) return sendApiError(res, 404, ERR_PROJECT_SYNC_OPERATION_NOT_FOUND, 'Feature pull operation not found or expired');
    if (previous.state === 'queued' || previous.state === 'running') return sendApiError(res, 409, 'FEATURE_PULL_OPERATION_NOT_TERMINAL', 'Feature pull operation is still running');
    const existingRetryId = featurePullRetryByOperation.get(previousId);
    const existingRetry = existingRetryId ? featurePullOperations.get(existingRetryId)?.operation : null;
    if (existingRetry) return res.status(existingRetry.state === 'queued' || existingRetry.state === 'running' ? 202 : 200).json({ ok: true, data: existingRetry });
    const failedIds = previous.result?.items.filter((item) => item.state === 'failed').map((item) => item.originId) ?? [];
    if (failedIds.length === 0) return sendApiError(res, 409, 'FEATURE_PULL_NOTHING_TO_RETRY', 'Feature pull operation has no failed items');
    const stored = featurePullPlans.get(previous.planId);
    if (!stored) return sendApiError(res, 409, ERR_PROJECT_SYNC_PLAN_EXPIRED, 'Feature pull plan expired — re-plan and retry');
    const operation = startFeaturePullOperation(stored, new Set(failedIds));
    featurePullRetryByOperation.set(previousId, operation.operationId);
    res.status(202).json({ ok: true, data: operation });
  });

  type ApplyProgress = (phase: 'validating' | 'transferring' | 'finalizing', completedItems: number, currentPath?: string | null, currentFeatureId?: string | null) => void;
  const applyHandler = async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<ProjectSyncApplyRequest>;
    const report = (req as unknown as { projectSyncReport?: ApplyProgress }).projectSyncReport;
    const now = Date.now();
    for (const [id, completed] of appliedResults) if (completed.expiresAt <= now) appliedResults.delete(id);
    for (const [id, pending] of execution) if (pending.expiresAt <= now) execution.delete(id);
    if (typeof body.planId === 'string' && appliedResults.has(body.planId)) return res.json({ ok: true, data: appliedResults.get(body.planId)!.result });
    const stored = typeof body.planId === 'string' ? plans.get(body.planId) : null;
    const exec = typeof body.planId === 'string' ? execution.get(body.planId) : null;
    if (!stored || !exec) return sendApiError(res, 409, ERR_PROJECT_SYNC_PLAN_EXPIRED, 'plan expired — re-plan and retry');
    report?.('validating', 0);
    const current = await snapshot(exec.units, exec.direction);
    if (!projectSyncPlanIsFresh(stored, current.localFiles, current.originFiles)) return sendApiError(res, 409, ERR_PROJECT_SYNC_PLAN_EXPIRED, 'plan baseline changed — re-plan and retry');
    const media = new MediaClient(mediaConfigFromEnv());
    const unitFor = (entryPath: string) => exec.units.find((unit) => entryPath === unit.prefix || entryPath.startsWith(`${unit.prefix}/`));
    const relFor = (entryPath: string, unit: Unit) => entryPath.slice(unit.prefix.length + 1);
    let applied = 0; let skipped = 0; let unchanged = 0;
    const softHiddenOriginFeatureIds: string[] = []; const stale: Array<{ path: string; reason: string }> = [];
    // App Push removes an origin-only Feature as one lifecycle operation, not
    // once for every file in its folder. The current files and history remain
    // intact so an administrator can audit or restore the hidden Feature.
    if (stored.plan.direction === 'push' && exec.scope.kind === 'app') {
      for (const unit of exec.units.filter((candidate) => !candidate.localId && candidate.featureId && candidate.originId)) {
        try {
          await media.uploadFile(unit.originId, '', PROJECT_LIFECYCLE_PATH, 'application/json', Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: unit.originId, visibility: 'hidden', hiddenAt: new Date().toISOString() })));
          softHiddenOriginFeatureIds.push(unit.originId);
          applied += 1;
        } catch (error) {
          stale.push({ path: unit.prefix, reason: (error as Error).message });
        }
      }
    }
    let completedItems = 0;
    report?.('transferring', completedItems);
    for (const entry of stored.plan.entries) {
      const resolution = body.resolutions?.[entry.path] ?? entry.resolution;
      const actionable = entry.change !== 'unchanged' && resolution !== 'skip';
      if (actionable) report?.('transferring', completedItems, entry.path, entry.featureId ?? null);
      try {
        if (entry.change === 'unchanged') { unchanged += 1; continue; }
        if (resolution === 'skip') { skipped += 1; continue; }
        const unit = unitFor(entry.path);
        if (!unit) { stale.push({ path: entry.path, reason: 'unit missing' }); continue; }
        const rel = relFor(entry.path, unit);
        try {
          if (stored.plan.direction === 'push' && resolution === 'push') {
            if (entry.change === 'deleted') {
              if (!unit.localId && unit.featureId) {
                // The unit-level lifecycle write above owns this removal. Never
                // delete or rewrite its individual current/history files.
                continue;
              } else if (!isHistory(rel)) { const files = await media.listFiles(unit.originId); const found = files.find((file) => file.path === rel) as { id?: string } | undefined; if (found?.id) await media.deleteFile(found.id); applied += 1; }
            } else if (unit.localId) {
              const content = exec.localContentByPath.get(entry.path)
                ?? await fs.readFile(path.join(ctx.paths.PROJECTS_DIR, unit.localId, rel));
              await media.uploadFile(unit.originId, '', rel, 'application/octet-stream', content); applied += 1;
            }
          } else if (stored.plan.direction === 'pull' && resolution === 'pull') {
            const dest = unit.localId ? path.join(ctx.paths.PROJECTS_DIR, unit.localId, rel) : null;
            if (!dest) { stale.push({ path: entry.path, reason: 'no local target' }); continue; }
            if (!getProject(db, unit.localId!) && unit.featureId) {
              insertProject(db, {
                id: unit.localId!, name: unit.name, skillId: null, designSystemId: null, pendingPrompt: null,
                metadata: { source: 'kg-pull', ...(unit.featureId ? { studioConfig: { appId: exec.scope.projectId } } : {}) },
                createdAt: Date.now(), updatedAt: Date.now(),
              });
            }
            if (entry.change === 'deleted') { if (!isHistory(rel)) await fs.rm(dest, { force: true }); applied += 1; }
            else {
              const content = await media.downloadFile(unit.originId, rel);
              if (unit.featureId && rel === 'project.json') {
                const remote = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
                const project = getProject(db, unit.localId!) as LocalProject;
                const metadata = project.metadata && typeof project.metadata === 'object' && !Array.isArray(project.metadata)
                  ? { ...(project.metadata as Record<string, unknown>) }
                  : {};
                const studio = metadata.studioConfig && typeof metadata.studioConfig === 'object' && !Array.isArray(metadata.studioConfig)
                  ? { ...(metadata.studioConfig as Record<string, unknown>) }
                  : {};
                const appContextBinding = remote.appContextBinding && typeof remote.appContextBinding === 'object' && !Array.isArray(remote.appContextBinding)
                  ? { ...(remote.appContextBinding as Record<string, unknown>), ...(exec.scope.appId ? { appId: exec.scope.appId } : {}) }
                  : metadata.appContextBinding;
                updateProject(db, unit.localId!, { metadata: {
                  ...metadata,
                  ...(appContextBinding ? { appContextBinding } : {}),
                  studioConfig: { ...studio, ...(exec.scope.appId ? { appId: exec.scope.appId } : {}), remoteId: unit.originId },
                } });
              } else if (unit.isApp && !unit.contextVersion && rel === 'app.json') {
                const remote = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
                if (typeof remote.name === 'string' && remote.name) unit.name = remote.name;
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await fs.writeFile(dest, content);
              } else {
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await fs.writeFile(dest, content);
              }
              applied += 1;
            }
          } else skipped += 1;
        } catch (error) { stale.push({ path: entry.path, reason: (error as Error).message }); }
      } finally {
        if (actionable) {
          completedItems += 1;
          report?.('transferring', completedItems, entry.path, entry.featureId ?? null);
        }
      }
    }
    report?.('finalizing', completedItems);
    const baselineIdentity = {
      originId: stored.plan.origin.originId,
      // App identity is the selected origin itself. Only a Feature baseline
      // carries the parent origin App id; child units in an App Push must not
      // accidentally change the App baseline identity.
      originAppId: exec.scope.kind === 'feature'
        ? exec.units.find((unit) => unit.featureId)?.originAppId ?? null
        : null,
    };
    // Persist a versioned local → origin mapping only after an entirely clean
    // APPLY. A partial/stale transfer is never allowed to claim a new origin.
    // Older `approvedMapping` remains readable; new writes use the explicit
    // remoteId bridge for App and every local Feature.
    try {
      if (stale.length === 0) for (const unit of exec.units) {
        if (!unit.localId || !unit.originId || unit.persistMapping === false) continue;
        if (unit.isApp && !unit.featureId) {
          await writeAppMapping(ctx.paths.PROJECTS_DIR, unit.localId, unit.originId);
          if (stored.plan.direction === 'pull') {
            upsertPipelineAppName(db, { id: unit.localId, name: unit.name, createdAt: Date.now() });
          }
          continue;
        }
        if (!getProject(db, unit.localId)) continue;
        const project = getProject(db, unit.localId) as LocalProject;
        const config = studioConfigOf(project.metadata);
        const metadata = (project.metadata && typeof project.metadata === 'object' && !Array.isArray(project.metadata)) ? project.metadata as Record<string, unknown> : {};
        const studio = metadata.studioConfig && typeof metadata.studioConfig === 'object' && !Array.isArray(metadata.studioConfig) ? metadata.studioConfig as Record<string, unknown> : {};
        updateProject(db, unit.localId, { metadata: {
          ...metadata,
          studioConfig: {
            ...studio,
            ...config,
            remoteId: unit.originId, // compatibility reader for pre-schema clients
            projectSyncMapping: { schemaVersion: 1, localId: unit.localId, originId: unit.originId, ...(unit.featureId ? { originAppId: unit.originAppId ?? (exec.scope.kind === 'app' ? stored.plan.origin.originId : null) } : {}), mappedAt: new Date().toISOString() },
          },
        } });
      }
    } catch (error) {
      // A Pull may already have replaced local files before its mapping/DB
      // finalization fails. Preserve that truth for the next status check.
      // Push failures do not make the intact local copy incomplete.
      if (stored.plan.direction === 'pull') syncState.markIncomplete(exec.scope, baselineIdentity);
      throw error;
    }
    if (stale.length === 0 && skipped === 0) {
      try {
        const verified = await planFor(
          { direction: 'push', scope: exec.scope, origin: { mode: 'existing', originId: baselineIdentity.originId } },
          { retain: false, statusScope: true, origins: [{
            originId: baselineIdentity.originId,
            name: baselineIdentity.originId,
            kind: exec.scope.kind,
            ...(exec.scope.kind === 'feature' ? { appId: baselineIdentity.originAppId } : {}),
            visibility: 'visible',
            inMedia: true,
          }] },
        );
        const pair = digestProjectSyncSides(verified.files.localFiles, verified.files.originFiles);
        syncState.recordClean(exec.scope, baselineIdentity, pair, verified.plan.context?.contextVersion ?? null);
      } catch {
        if (stored.plan.direction === 'pull') syncState.markIncomplete(exec.scope, baselineIdentity);
      }
    } else if (stored.plan.direction === 'pull') {
      syncState.markIncomplete(exec.scope, baselineIdentity);
    }
    const result = { planId: stored.plan.planId, applied, skipped, unchanged, softHiddenOriginFeatureIds, stale };
    appliedResults.set(stored.plan.planId, { expiresAt: Date.now() + PROJECT_SYNC_PLAN_TTL_MS, result });
    res.json({ ok: true, data: result });
  };
  app.post('/api/project-sync/apply', applyHandler);

  app.post('/api/project-sync/operations', (req, res) => {
    const body = (req.body ?? {}) as Partial<ProjectSyncApplyRequest>;
    if (typeof body.planId !== 'string' || !body.planId) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'planId is required');
    }
    const now = Date.now();
    for (const [id, completed] of appliedResults) if (completed.expiresAt <= now) appliedResults.delete(id);
    for (const [id, pending] of execution) if (pending.expiresAt <= now) execution.delete(id);
    const existingOperationId = operationIdByPlan.get(body.planId);
    const existingOperation = existingOperationId ? operations.get(existingOperationId) : null;
    if (existingOperation && existingOperation.state !== 'failed') {
      return res.status(existingOperation.state === 'succeeded' ? 200 : 202).json({ ok: true, data: existingOperation });
    }
    if (!existingOperation) operationIdByPlan.delete(body.planId);
    const stored = plans.get(body.planId);
    if (!stored) {
      return sendApiError(res, 409, ERR_PROJECT_SYNC_PLAN_EXPIRED, 'plan expired — re-plan and retry');
    }
    const totalItems = stored.plan.entries.filter((entry) => {
      const resolution = body.resolutions?.[entry.path] ?? entry.resolution;
      return entry.change !== 'unchanged' && resolution !== 'skip';
    }).length;
    const operation = operations.create({ planId: body.planId, totalItems });
    operationIdByPlan.set(body.planId, operation.operationId);

    setImmediate(() => {
      let statusCode = 200;
      let payload: unknown;
      const operationResponse = {
        status(code: number) { statusCode = code; return this; },
        json(value: unknown) { payload = value; return this; },
      } as unknown as Response;
      const operationRequest = {
        body,
        projectSyncReport: (phase: 'validating' | 'transferring' | 'finalizing', completedItems: number, currentPath?: string | null, currentFeatureId?: string | null) => {
          operations.update(operation.operationId, {
            phase,
            completedItems,
            ...(currentPath !== undefined ? { currentPath } : {}),
            ...(currentFeatureId !== undefined ? { currentFeatureId } : {}),
          });
        },
      } as unknown as Request;
      void applyHandler(operationRequest, operationResponse).then(() => {
        const response = payload as { ok?: boolean; data?: ProjectSyncApplyResult; error?: { code?: string; message?: string } } | undefined;
        if (statusCode >= 400 || !response?.ok || !response.data) {
          operations.fail(operation.operationId, {
            code: response?.error?.code ?? 'PROJECT_SYNC_APPLY_FAILED',
            message: response?.error?.message ?? 'project sync apply failed',
            retryable: statusCode >= 500 || response?.error?.code === ERR_PROJECT_SYNC_PLAN_EXPIRED,
          });
          expireOperationIndex(body.planId!, operation.operationId);
          return;
        }
        operations.succeed(operation.operationId, response.data);
        expireOperationIndex(body.planId!, operation.operationId);
      }, (error: Error) => {
        operations.fail(operation.operationId, {
          code: 'PROJECT_SYNC_APPLY_FAILED',
          message: error.message,
          retryable: true,
        });
        expireOperationIndex(body.planId!, operation.operationId);
      });
    });

    res.status(202).json({ ok: true, data: operation });
  });

  app.get('/api/project-sync/operations/:id', (req, res) => {
    const operationId = typeof req.params.id === 'string' ? req.params.id : '';
    const operation = operationId ? operations.get(operationId) : null;
    if (!operation) {
      return sendApiError(res, 404, ERR_PROJECT_SYNC_OPERATION_NOT_FOUND, 'project sync operation not found or expired');
    }
    res.json({ ok: true, data: operation });
  });
}
