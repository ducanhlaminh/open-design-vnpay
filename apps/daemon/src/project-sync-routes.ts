// HTTP adapter for the App/Feature origin-sync contract. Legacy `/api/kg/*`
// endpoints deliberately remain untouched; this is the single UI + CLI surface.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import {
  ERR_PROJECT_SYNC_ORIGIN_HIDDEN,
  ERR_PROJECT_SYNC_PLAN_EXPIRED,
  type ProjectSyncApplyRequest,
  type ProjectSyncDirection,
  type ProjectSyncEntryKind,
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
import { stageForOutput } from './pipelines.js';

export interface RegisterProjectSyncRoutesDeps extends RouteDeps<'db' | 'http' | 'paths'> {}

type LocalProject = { id: string; name?: string; metadata?: unknown };
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
function stateOf(summary: ReturnType<typeof emptyTotals>): 'new' | 'unchanged' | 'changed' | 'deleted' {
  if (summary.changed) return 'changed';
  if (summary.created) return 'new';
  if (summary.deleted) return 'deleted';
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
  const execution = new Map<string, { units: Unit[]; direction: ProjectSyncDirection; scope: ProjectSyncScope; localContentByPath: Map<string, Buffer>; expiresAt: number }>();
  const appliedResults = new Map<string, { expiresAt: number; result: { planId: string; applied: number; skipped: number; unchanged: number; softHiddenOriginFeatureIds: string[]; stale: Array<{ path: string; reason: string }> } }>();
  const projects = (): LocalProject[] => listProjects(db) as LocalProject[];

  const remoteOrigins = async (): Promise<ProjectSyncOrigin[]> => {
    const media = new MediaClient(mediaConfigFromEnv());
    const rows = await loadRemoteProjects(media);
    await Promise.all(rows.filter((row) => !row.isApp).map(async (row) => {
      try {
        const config = JSON.parse((await media.downloadFile(row.projectId, 'project.json')).toString('utf8')) as { appId?: unknown };
        row.appId = typeof config.appId === 'string' ? config.appId : null;
      } catch { row.appId = null; }
    }));
    return rows.map((row) => ({
      originId: row.projectId, name: row.name || row.projectId, kind: row.isApp ? 'app' : 'feature',
      appId: row.appId ?? null, visibility: row.visibility ?? 'visible', inMedia: row.inMedia,
      mappingVersion: null,
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
      const localAppId = binding?.appId ?? scope.appId ?? null;
      const originAppId = diagnosticOrigin?.appId ?? expectedOriginAppId ?? (selectedProject ? originAppIdOf(selectedProject) : null);
      // A Feature carries exactly its immutable bound Context version. It does
      // not silently upgrade to the App's current Context or copy all history.
      if (binding && safeSegment(localAppId) && originAppId) {
        units.push({
          localId: localAppId,
          originId: originAppId,
          prefix: 'bound-context',
          isApp: true,
          name: `Context ${binding.contextVersion}`,
          contextVersion: binding.contextVersion,
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
      const localRels = new Set<string>();
      if (unit.localId) {
        for (const file of await walkFiles(path.join(ctx.paths.PROJECTS_DIR, unit.localId))) {
          if (isControl(file.rel)) continue;
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
      const remoteFiles = unit.originId ? await media.listFiles(unit.originId).catch(() => []) : [];
      for (const file of remoteFiles) {
        const rel = typeof file.path === 'string' ? file.path : '';
        if (!rel || isControl(rel)) continue;
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

  const planFor = async (request: ProjectSyncPlanRequest, options: { retain?: boolean; origins?: ProjectSyncOrigin[] } = {}) => {
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
    // App pull includes origin-only Features as units too (and App push sees
    // them as `deleted`, which APPLY converts into a lifecycle soft-hide).
    if (request.scope.kind === 'app') {
      for (const origin of allOrigins.filter((row) => row.kind === 'feature' && row.appId === defaultOrigin.originId && row.visibility === 'visible')) {
        if (!units.some((unit) => unit.originId === origin.originId)) units.push({ ...(request.direction === 'pull' ? { localId: origin.originId } : {}), originId: origin.originId, prefix: `features/${origin.originId}`, featureId: origin.originId, isApp: false, name: origin.name });
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
    const statusOrigins = await remoteOrigins().catch(() => null);
    for (const scope of requested) {
      let mapped: string | null = null;
      try {
        const localProject = projects().find((project) => project.id === scope.projectId);
        mapped = scope.kind === 'app'
          ? (await readAppMapping(ctx.paths.PROJECTS_DIR, scope.projectId))?.originId ?? null
          : localProject ? originIdOf(localProject) : null;
        if (!mapped) {
          results.push({ scope, origin: null, state: 'new', mappingValid: false, features: [], summary: { created: 1, unchanged: 0, changed: 0, deleted: 0 }, entries: [] });
          continue;
        }
        if (!statusOrigins) throw new Error('origin registry unavailable');
        const planned = await planFor(
          { direction: 'push', scope, origin: { mode: 'existing', originId: mapped } },
          { retain: false, origins: statusOrigins },
        );
        results.push({ scope, origin: planned.origin, state: stateOf(planned.plan.summary), mappingValid: planned.mappingValid, ...(planned.plan.app ? { app: planned.plan.app } : {}), ...(planned.plan.context ? { context: planned.plan.context } : {}), features: planned.plan.features, summary: planned.plan.summary, entries: planned.plan.entries });
      } catch (error) {
        const code = (error as Error & { code?: string }).code;
        if (code === ERR_PROJECT_SYNC_ORIGIN_HIDDEN || code === 'ORIGIN_MAPPING_INVALID') {
          const diagnostic = mapped ? statusOrigins?.find((origin) => origin.originId === mapped) ?? null : null;
          results.push({ scope, origin: diagnostic, state: 'new', mappingValid: false, features: [], summary: { created: 1, unchanged: 0, changed: 0, deleted: 0 }, entries: [], error: (error as Error).message });
        } else {
          results.push({ scope, state: 'changed', mappingValid: false, features: [], summary: emptyTotals(), entries: [], error: (error as Error).message });
        }
      }
    }
    res.json({ ok: true, data: { results } });
  });

  app.post('/api/project-sync/apply', async (req, res) => {
    const body = (req.body ?? {}) as Partial<ProjectSyncApplyRequest>;
    const now = Date.now();
    for (const [id, completed] of appliedResults) if (completed.expiresAt <= now) appliedResults.delete(id);
    for (const [id, pending] of execution) if (pending.expiresAt <= now) execution.delete(id);
    if (typeof body.planId === 'string' && appliedResults.has(body.planId)) return res.json({ ok: true, data: appliedResults.get(body.planId)!.result });
    const stored = typeof body.planId === 'string' ? plans.get(body.planId) : null;
    const exec = typeof body.planId === 'string' ? execution.get(body.planId) : null;
    if (!stored || !exec) return sendApiError(res, 409, ERR_PROJECT_SYNC_PLAN_EXPIRED, 'plan expired — re-plan and retry');
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
    for (const entry of stored.plan.entries) {
      const resolution = body.resolutions?.[entry.path] ?? entry.resolution;
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
          } else if (!getProject(db, unit.localId!) && unit.isApp && !unit.contextVersion) {
            upsertPipelineAppName(db, { id: unit.localId!, name: unit.name, createdAt: Date.now() });
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
              upsertPipelineAppName(db, { id: unit.localId!, name: typeof remote.name === 'string' && remote.name ? remote.name : unit.name, createdAt: Date.now() });
            } else {
              await fs.mkdir(path.dirname(dest), { recursive: true });
              await fs.writeFile(dest, content);
            }
            applied += 1;
          }
        } else skipped += 1;
      } catch (error) { stale.push({ path: entry.path, reason: (error as Error).message }); }
    }
    // Persist a versioned local → origin mapping only after an entirely clean
    // APPLY. A partial/stale transfer is never allowed to claim a new origin.
    // Older `approvedMapping` remains readable; new writes use the explicit
    // remoteId bridge for App and every local Feature.
    if (stale.length === 0) for (const unit of exec.units) {
      if (!unit.localId || !unit.originId || unit.persistMapping === false) continue;
      if (unit.isApp && !unit.featureId) {
        await writeAppMapping(ctx.paths.PROJECTS_DIR, unit.localId, unit.originId);
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
    const result = { planId: stored.plan.planId, applied, skipped, unchanged, softHiddenOriginFeatureIds, stale };
    appliedResults.set(stored.plan.planId, { expiresAt: Date.now() + PROJECT_SYNC_PLAN_TTL_MS, result });
    res.json({ ok: true, data: result });
  });
}
