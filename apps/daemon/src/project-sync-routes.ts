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
  type ProjectSyncConfluencePreflightRequest,
  type ProjectSyncConfluencePullOutcome,
  type ProjectSyncConfluenceSource,
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
  setPipelineAppDesignSystem,
  setPipelineAppDocsReviewComponentSource,
} from './db.js';
import { featureContextBindingFromMetadata, parseManifestComponentSource } from './app-context-version.js';
import { MediaClient, mediaConfigFromEnv, type MediaFolderSession } from './kg-sync/media-client.js';
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
import { commitHistory } from './project-history.js';
import { historyActor } from './history-actor.js';
import { digestProjectSyncSides, evaluateProjectSyncStatus } from './project-sync-status.js';
import { ProjectSyncStateStore } from './project-sync-state.js';
import { resolveConfluenceCreds } from './bas/bas-client.js';
import type { ConfluenceSourceItem, ConfluenceSourcesLedger } from './confluence-sources.js';
import {
  CONFLUENCE_CREDS_MISSING,
  CONFLUENCE_PULL_CONCURRENCY,
  confluencePreflight,
  confluenceSourceOf,
  expandLedgerGroup,
  fetchConfluenceBlob,
  groupLocalLedgers,
  groupOriginLedgers,
  isAttachmentsLedgerPath,
  mapLimit,
  parseConfluenceLedgerBuffer,
  type LazyLocalFile,
  type OriginLedgerGroup,
} from './confluence-blobs.js';

// Media transfers (upload/download) per project folder run through ONE
// MediaFolderSession (single list) with bounded parallelism.
const MEDIA_TRANSFER_CONCURRENCY = 4;
type ConfluenceCreds = { base: string; token: string };
/** Wiki items one `attachments/_sources.json` entry stands for (origin side),
 * kept out of the plan JSON so APPLY/preflight never re-download the ledger. */
type LedgerRef = { base: string; items: ConfluenceSourceItem[] };
const groupOf = (group: Pick<OriginLedgerGroup, 'files' | 'bytes' | 'missing'>) => ({ files: group.files, bytes: group.bytes, missing: group.missing });
const ledgerRefOf = (group: OriginLedgerGroup): LedgerRef => ({ base: group.base, items: group.items });

/** Origin ledgers of one media folder → one group per ledger for the items
 * whose bytes are NOT on media. Ledgers are tiny, so sequential downloads are
 * fine. `local` = null skips the pull-only `missing` stat. */
async function originLedgerGroups(
  download: (rel: string) => Promise<Buffer>,
  remoteRels: readonly string[],
  include: (rel: string) => boolean,
  local: { root: string | null } | null,
): Promise<Map<string, OriginLedgerGroup>> {
  const ledgers: Array<{ dirRel: string; ledger: ConfluenceSourcesLedger }> = [];
  for (const rel of remoteRels) {
    if (!isAttachmentsLedgerPath(rel) || !include(rel)) continue;
    const content = await download(rel).catch(() => null);
    const ledger = content ? parseConfluenceLedgerBuffer(content) : null;
    if (ledger) ledgers.push({ dirRel: path.posix.dirname(rel), ledger });
  }
  if (ledgers.length === 0) return new Map();
  return groupOriginLedgers(ledgers, new Set(remoteRels), local);
}

/** Same, from ledger blobs that were already downloaded (batch PLAN). */
async function ledgerGroupsFromContents(
  contents: ReadonlyArray<{ rel: string; content: Buffer }>,
  remoteRels: readonly string[],
  local: { root: string | null } | null,
): Promise<Map<string, OriginLedgerGroup>> {
  const ledgers: Array<{ dirRel: string; ledger: ConfluenceSourcesLedger }> = [];
  for (const { rel, content } of contents) {
    if (!isAttachmentsLedgerPath(rel)) continue;
    const ledger = parseConfluenceLedgerBuffer(content);
    if (ledger) ledgers.push({ dirRel: path.posix.dirname(rel), ledger });
  }
  if (ledgers.length === 0) return new Map();
  return groupOriginLedgers(ledgers, new Set(remoteRels), local);
}

const emptyConfluenceOutcome = (): ProjectSyncConfluencePullOutcome => ({ fetched: 0, drifted: [], missing: [] });

/** Pull one Confluence-backed file into `target`. `missing` writes nothing. */
async function pullConfluenceBlob(
  creds: ConfluenceCreds | null,
  entryPath: string,
  source: ProjectSyncConfluenceSource,
  expectedSha256: string,
  target: string,
  outcome: ProjectSyncConfluencePullOutcome,
): Promise<boolean> {
  if (!creds) { outcome.missing.push({ path: entryPath, reason: CONFLUENCE_CREDS_MISSING }); return false; }
  const fetched = await fetchConfluenceBlob(creds, source, expectedSha256);
  if (fetched.kind === 'missing') { outcome.missing.push({ path: entryPath, reason: fetched.reason }); return false; }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, fetched.bytes);
  outcome.fetched += 1;
  if (fetched.kind === 'drifted') outcome.drifted.push({ path: entryPath, reason: `sha256 khác bản pin v${source.attachmentVersion || '?'} — đã ghi bản mới nhất trên wiki` });
  return true;
}

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
  pulledDesignSystemId?: string | null;
  pulledComponentSource?: import('@open-design/contracts').DocsReviewComponentSource;
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

// `.od-skills` is the per-run private SKILL.md copy and `.tmp` is scratch —
// neither is a shareable output (mirrors the `.odhistory` info/exclude list).
const WALK_SKIP_DIRS = new Set(['.odhistory', 'node_modules', '.od-skills', '.tmp']);

/** Stage ids whose pipeline state is queued/running in a project's metadata. */
export function runningStageIdsOf(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const pipelines = (metadata as Record<string, unknown>).pipelines;
  if (!pipelines || typeof pipelines !== 'object' || Array.isArray(pipelines)) return [];
  return Object.entries(pipelines as Record<string, unknown>)
    .filter(([, row]) => {
      const status = row && typeof row === 'object' && !Array.isArray(row) ? (row as { status?: unknown }).status : null;
      return status === 'queued' || status === 'running';
    })
    .map(([stageId]) => stageId);
}

/** Lazy walk: stat every file up front, read bytes only on `read()` (cached).
 * Files matching a sibling Confluence ledger are never read at all. */
async function walkFiles(root: string): Promise<LazyLocalFile[]> {
  const out: LazyLocalFile[] = [];
  const visit = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(abs, rel);
      else if (entry.isFile()) {
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat) continue;
        let cached: Promise<Buffer> | null = null;
        out.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs, read: () => (cached ??= fs.readFile(abs)) });
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
    featureFiles: BatchExecutionFile[];
    contextVersion: string | null;
    contextFiles: BatchExecutionFile[];
  };
  /** `ledger` marks an `attachments/_sources.json` whose wiki items expand at APPLY. */
  type BatchExecutionFile = { rel: string; checksum: string; confluence?: ProjectSyncConfluenceSource; ledger?: LedgerRef };
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
  const execution = new Map<string, { units: Unit[]; direction: ProjectSyncDirection; scope: ProjectSyncScope; localContentByPath: Map<string, Buffer>; ledgerItemsByPath: Map<string, LedgerRef>; expiresAt: number }>();
  const appliedResults = new Map<string, { expiresAt: number; result: ProjectSyncApplyResult }>();
  const projects = (): LocalProject[] => listProjects(db) as LocalProject[];
  // PAT + base of THIS machine; null means every Confluence-backed Pull entry
  // ends up `missing` (the web preflight blocks the button before that).
  const confluenceCreds = async (): Promise<ConfluenceCreds | null> => {
    try { return await resolveConfluenceCreds(ctx.paths.RUNTIME_DATA_DIR); } catch { return null; }
  };

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
    const ledgerItemsByPath = new Map<string, LedgerRef>();
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
      const localRoot = unit.localId ? path.join(ctx.paths.PROJECTS_DIR, unit.localId) : null;
      if (unit.localId && localRoot) {
        const walked = (await walkFiles(localRoot)).filter((file) => !isControl(file.rel)
          && includeLatestAppContext(file.rel)
          && (!unit.contextVersion || file.rel.startsWith(`context/versions/${unit.contextVersion}/`)));
        // A raw wiki attachment matching its sibling ledger is represented by
        // the ledger entry alone (`confluenceGroup`): never read, never listed.
        const ledgers = await groupLocalLedgers(localRoot, walked);
        for (const file of walked) {
          if (ledgers.matched.has(file.rel)) continue;
          let content = await file.read().catch(() => null);
          if (!content) continue;
          const controlRel = unit.isApp ? 'app.json' : 'project.json';
          // A pulled Feature keeps the LOCAL App id in its project.json; the
          // origin must always see the origin App id, otherwise a later push
          // re-parents the Feature on the registry (origin_missing for everyone).
          const normalizeAppId = !unit.isApp && unit.featureId && unit.originAppId ? unit.originAppId : null;
          if (file.rel === controlRel && (unit.overrideName || normalizeAppId)) {
            try {
              const current = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
              const next: Record<string, unknown> = { ...current, ...(unit.overrideName ? { name: unit.name } : {}) };
              if (normalizeAppId) {
                next.appId = normalizeAppId;
                const binding = next.appContextBinding;
                if (binding && typeof binding === 'object' && !Array.isArray(binding)) {
                  next.appContextBinding = { ...(binding as Record<string, unknown>), appId: normalizeAppId };
                }
              }
              content = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
            } catch {
              // Keep malformed source visible to the normal validation/diff
              // path instead of silently replacing the whole control file.
            }
          }
          const entryPath = `${unit.prefix}/${file.rel}`;
          localRels.add(file.rel);
          localContentByPath.set(entryPath, content);
          const stage = !unit.isApp ? stageForOutput(file.rel)?.id : undefined;
          const group = ledgers.groups.get(file.rel);
          localFiles.push({ path: entryPath, checksum: checksum(content), size: content.length, kind: kindOf(file.rel, unit.isApp), ...(unit.featureId ? { featureId: unit.featureId } : {}), ...(stage ? { stage } : {}), ...(unit.contextVersion ? { contextVersion: unit.contextVersion } : {}), ...(group ? { confluenceGroup: { files: group.files, bytes: group.bytes, missing: 0 } } : {}) });
        }
      }
      const remoteRels: string[] = remoteFiles.map((file) => (typeof file.path === 'string' ? file.path : '')).filter(Boolean);
      const includeRemote = (rel: string): boolean => Boolean(rel) && !isControl(rel) && includeLatestAppContext(rel)
        && (!unit.contextVersion || rel.startsWith(`context/versions/${unit.contextVersion}/`));
      // Origin ledgers stand in for the attachment bytes that were never
      // uploaded: ONE group per ledger entry, never one entry per file. Pull
      // also stats the local copies so an identical ledger with files missing
      // on this machine still expands.
      const ledgerGroups = unit.originId
        ? await originLedgerGroups((rel) => media.downloadFile(unit.originId, rel), remoteRels, includeRemote, direction === 'pull' ? { root: localRoot } : null)
        : new Map<string, OriginLedgerGroup>();
      for (const file of remoteFiles) {
        const rel = typeof file.path === 'string' ? file.path : '';
        if (!includeRemote(rel)) continue;
        const stage = !unit.isApp
          ? (typeof (file as { stage?: unknown }).stage === 'string' ? (file as { stage: string }).stage : stageForOutput(rel)?.id)
          : undefined;
        const entryPath = `${unit.prefix}/${rel}`;
        const group = ledgerGroups.get(rel);
        if (group) ledgerItemsByPath.set(entryPath, ledgerRefOf(group));
        originFiles.push({ path: entryPath, checksum: typeof file.checksum === 'string' ? file.checksum : '', size: 0, kind: kindOf(rel, unit.isApp), ...(unit.featureId ? { featureId: unit.featureId } : {}), ...(stage ? { stage } : {}), ...(unit.contextVersion ? { contextVersion: unit.contextVersion } : {}), ...(group ? { confluenceGroup: groupOf(group) } : {}) });
      }
      if (unit.localId && !unit.contextVersion) {
        const controlRel = unit.isApp ? 'app.json' : 'project.json';
        if (!localRels.has(controlRel)) {
          let existing: Record<string, unknown> = {};
          if (direction === 'push' && remoteFiles.some((file) => file.path === controlRel)) {
            try { existing = JSON.parse((await media.downloadFile(unit.originId, controlRel)).toString('utf8')) as Record<string, unknown>; } catch { /* use local fields only */ }
          }
          const project = unit.featureId ? projects().find((candidate) => candidate.id === unit.localId) : null;
          const localApp = unit.isApp && !unit.featureId ? getPipelineApp(db, unit.localId) : null;
          const binding = project ? featureContextBindingFromMetadata(project.metadata) : null;
          const content = Buffer.from(`${JSON.stringify(unit.isApp ? {
            ...existing,
            kind: 'app',
            name: unit.name,
            ...(localApp ? {
              designSystemId: localApp.designSystemId,
              docsReviewComponentSource: localApp.docsReviewComponentSource,
            } : {}),
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
    return { localFiles, originFiles, localContentByPath, ledgerItemsByPath };
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
    // Self-heal: a pre-fix push uploaded the pulled project.json verbatim, so
    // the origin's `appId` is this machine's LOCAL App id instead of the
    // origin App id ("re-parented by pre-fix push"). Only a Push may claim it
    // back — and only when the stray id is exactly the local App id, never
    // when the origin genuinely belongs to another App. The normalized
    // project.json (see snapshot) then repairs the origin for everyone.
    const reparentedByPreFixPush = request.direction === 'push' && request.scope.kind === 'feature' && Boolean(request.scope.appId)
      && defaultOrigin.mode === 'existing' && diagnosticOrigin?.kind === 'feature' && Boolean(expectedOriginAppId)
      && diagnosticOrigin.appId !== expectedOriginAppId && diagnosticOrigin.appId === request.scope.appId;
    const parentValid = request.scope.kind !== 'feature' || !request.scope.appId
      || Boolean(expectedOriginAppId && diagnosticOrigin?.appId === expectedOriginAppId)
      || reparentedByPreFixPush;
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
    // Units must see the REAL origin App id (not the stray local id on the
    // broken origin) so snapshot normalizes project.json to it and the bound
    // Context resolves against the right origin App.
    const unitOrigin = reparentedByPreFixPush && diagnosticOrigin ? { ...diagnosticOrigin, appId: expectedOriginAppId } : diagnosticOrigin;
    const units = await unitsFor(request.scope, defaultOrigin, request.direction === 'pull', unitOrigin, expectedOriginAppId);
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
    // A user-facing Push PLAN while a stage is still writing outputs would only
    // expire at APPLY (`plan baseline changed`). STATUS and the post-apply /
    // post-pull verification passes (retain: false) are read-only and exempt.
    if (request.direction === 'push' && !options.statusScope && options.retain !== false) {
      const running: string[] = [];
      for (const unit of units) {
        if (unit.isApp || !unit.localId) continue;
        const project = projects().find((candidate) => candidate.id === unit.localId);
        const stages = project ? runningStageIdsOf(project.metadata) : [];
        if (stages.length > 0) running.push(`${unit.featureId ?? unit.localId}: ${stages.join(', ')}`);
      }
      if (running.length > 0) {
        const error = new Error(`Bước đang chạy — đợi xong rồi chia sẻ (${running.join('; ')})`) as Error & { code?: string };
        error.code = 'PROJECT_SYNC_STAGE_RUNNING';
        throw error;
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
      // Only bytes a Push may upload stay resident for the plan TTL; APPLY
      // re-reads from disk when a buffer is absent.
      if (request.direction !== 'push') files.localContentByPath.clear();
      else for (const entry of built.plan.entries) if (entry.change === 'unchanged') files.localContentByPath.delete(entry.path);
      execution.set(built.plan.planId, {
        units,
        direction: request.direction,
        scope: request.scope,
        localContentByPath: files.localContentByPath,
        ledgerItemsByPath: files.ledgerItemsByPath,
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
    const localRoot = localId ? path.join(ctx.paths.PROJECTS_DIR, localId) : null;
    if (localRoot) {
      const walked = (await walkFiles(localRoot)).filter((file) => !isControl(file.rel));
      const ledgers = await groupLocalLedgers(localRoot, walked);
      for (const file of walked) {
        if (ledgers.matched.has(file.rel)) continue;
        const content = await file.read().catch(() => null);
        if (!content) continue;
        const stage = stageForOutput(file.rel)?.id;
        const group = ledgers.groups.get(file.rel);
        localFiles.push({ path: `feature/${file.rel}`, checksum: checksum(content), size: content.length, kind: kindOf(file.rel, false), featureId: originId, ...(stage ? { stage } : {}), ...(group ? { confluenceGroup: { files: group.files, bytes: group.bytes, missing: 0 } } : {}) });
      }
    }
    const originFiles: ProjectSyncSnapshotFile[] = [];
    const featureFiles: BatchExecutionFeature['featureFiles'] = [];
    const session = await media.openFolderSession(originId, { create: false });
    const remoteFeatureFiles = session.listFiles();
    const remoteRels = remoteFeatureFiles.map((file) => (typeof file.path === 'string' ? file.path : '')).filter(Boolean);
    const featureRels: string[] = [];
    for (const file of remoteFeatureFiles) {
      const rel = typeof file.path === 'string' ? file.path : '';
      if (!rel || isControl(rel)) continue;
      if (!safeRelativePath(rel)) throw new Error(`Unsafe remote Feature path: ${rel}`);
      featureRels.push(rel);
    }
    const featureContents = await mapLimit(featureRels, MEDIA_TRANSFER_CONCURRENCY, (rel) => session.download(rel));
    // Confluence-backed attachments: ONE group per ledger (already downloaded
    // above) — nothing else to fetch at PLAN time; APPLY expands the group.
    const ledgerGroups = await ledgerGroupsFromContents(featureRels.map((rel, i) => ({ rel, content: featureContents[i]! })), remoteRels, { root: localRoot });
    for (const [i, rel] of featureRels.entries()) {
      const content = featureContents[i]!;
      const digest = checksum(content);
      const group = ledgerGroups.get(rel);
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
      featureFiles.push({ rel, checksum: digest, ...(group ? { ledger: ledgerRefOf(group) } : {}) });
      originFiles.push({ path: `feature/${rel}`, checksum: checksum(comparisonContent), size: comparisonContent.length, kind: kindOf(rel, false), featureId: originId, ...(stage ? { stage } : {}), ...(group ? { confluenceGroup: groupOf(group) } : {}) });
    }
    return { localFiles, originFiles, featureFiles };
  };

  const boundContextSnapshot = async (originAppId: string, localAppId: string, contextVersion: string | null, featureId: string) => {
    const empty = { localFiles: [] as ProjectSyncSnapshotFile[], originFiles: [] as ProjectSyncSnapshotFile[], contextFiles: [] as BatchExecutionFeature['contextFiles'] };
    if (!contextVersion || !/^v[1-9]\d*$/.test(contextVersion)) return empty;
    const media = new MediaClient(mediaConfigFromEnv());
    const root = `context/versions/${contextVersion}`;
    const session = await media.openFolderSession(originAppId, { create: false });
    const allRemote = session.listFiles();
    const inVersion = (rel: string) => rel === `${root}/manifest.json` || rel.startsWith(`${root}/files/`);
    const remote = allRemote.filter((file) => typeof file.path === 'string' && inVersion(file.path));
    if (!remote.some((file) => file.path === `${root}/manifest.json`)) throw new Error(`Bound Context ${contextVersion} is missing from origin App ${originAppId}`);
    const remoteRels = allRemote.map((file) => (typeof file.path === 'string' ? file.path : '')).filter(Boolean);
    const contextRels = remote.map((file) => file.path as string);
    for (const rel of contextRels) if (!safeRelativePath(rel)) throw new Error(`Unsafe bound Context path: ${rel}`);
    const contextContents = await mapLimit(contextRels, MEDIA_TRANSFER_CONCURRENCY, (rel) => session.download(rel));
    const localRoot = path.join(ctx.paths.PROJECTS_DIR, localAppId);
    const ledgerGroups = await ledgerGroupsFromContents(contextRels.map((rel, i) => ({ rel, content: contextContents[i]! })), remoteRels, { root: localRoot });
    for (const [i, rel] of contextRels.entries()) {
      const content = contextContents[i]!;
      const digest = checksum(content);
      const entryPath = `bound-context/${featureId}/${rel}`;
      const group = ledgerGroups.get(rel);
      empty.originFiles.push({ path: entryPath, checksum: digest, size: content.length, kind: 'context', featureId, contextVersion, ...(group ? { confluenceGroup: groupOf(group) } : {}) });
      empty.contextFiles.push({ rel, checksum: digest, ...(group ? { ledger: ledgerRefOf(group) } : {}) });
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
      if (code === ERR_PROJECT_SYNC_ORIGIN_HIDDEN || code === 'ORIGIN_ID_EXISTS' || code === 'ORIGIN_MAPPING_INVALID' || code === 'PROJECT_SYNC_STAGE_RUNNING') return sendApiError(res, 409, code, (error as Error).message);
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
    const creds = await confluenceCreds();
    let completed = 0;
    const items: ProjectSyncFeaturePullBatchResult['items'] = [];
    // The origin App folder is shared by every Feature in the batch: list once.
    let appSessionPromise: Promise<MediaFolderSession> | null = null;
    const appSession = () => (appSessionPromise ??= media.openFolderSession(stored.plan.originAppId, { create: false }));
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
      // Only an explicit `pull` resolution acts — a local-only file (`deleted`)
      // defaults to `skip` and stays in place (it is already inside stageFeature
      // via the cp above). Mirrors applyHandler's pull branch.
      const actionable = planned.entries.filter((entry) => entry.change !== 'unchanged' && entry.resolution === 'pull');
      // Progress units: one per entry plus one per wiki file a ledger expands.
      const featureUnits = actionable.reduce((total, entry) => total + 1 + (entry.confluenceGroup?.files ?? 0), 0);
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
        const featureSession = await media.openFolderSession(feature.originId, { create: false });
        const control = JSON.parse((await featureSession.download('project.json')).toString('utf8')) as Record<string, unknown>;
        if (control.appId !== stored.plan.originAppId) throw new Error(`Feature ${feature.originId} no longer belongs to App ${stored.plan.originAppId}`);
        if (feature.mode === 'update') {
          // Fence the current local state so the overwrite below is undoable.
          // `.odhistory` lives inside `destination`, so cp + rename keeps it.
          await commitHistory(destination, { kind: 'pre-pull', by: historyActor() }).catch(() => null);
          await fs.cp(destination, stageFeature, { recursive: true });
        } else await fs.mkdir(stageFeature, { recursive: true });
        updateProgress('transferring', feature.originId, null);
        // Media files are downloaded through the per-folder sessions,
        // MEDIA_TRANSFER_CONCURRENCY at a time; Confluence-backed files are
        // pulled from the wiki afterwards, CONFLUENCE_PULL_CONCURRENCY at a time.
        const confluenceTasks: Array<{ entryPath: string; source: ProjectSyncConfluenceSource; checksum: string; target: string }> = [];
        const mediaTasks: Array<{ entryPath: string; download: () => Promise<Buffer>; checksum: string; target: string; label: string }> = [];
        // Ledger entries: download the ledger, expand its wiki items into the
        // stage dir (progress per file), then write the ledger itself.
        const groupTasks: Array<{ entryPath: string; ledger: LedgerRef; files: number; download: () => Promise<Buffer>; checksum: string; target: string; label: string }> = [];
        const confluenceOutcome = emptyConfluenceOutcome();
        let groupFetched = 0;
        let groupMissing = 0;
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
            if (expected.ledger) {
              groupTasks.push({ entryPath: entry.path, ledger: expected.ledger, files: entry.confluenceGroup?.files ?? expected.ledger.items.length, download: () => featureSession.download(rel), checksum: expected.checksum, target: path.join(stageFeature, rel), label: `Remote Feature changed after PLAN: ${rel}` });
              continue;
            }
            if (expected.confluence) {
              confluenceTasks.push({ entryPath: entry.path, source: expected.confluence, checksum: expected.checksum, target: path.join(stageFeature, rel) });
              continue;
            }
            mediaTasks.push({ entryPath: entry.path, download: () => featureSession.download(rel), checksum: expected.checksum, target: path.join(stageFeature, rel), label: `Remote Feature changed after PLAN: ${rel}` });
            continue;
          } else if (entry.path.startsWith(`bound-context/${feature.originId}/`)) {
            const rel = entry.path.slice(`bound-context/${feature.originId}/`.length);
            const expected = feature.contextFiles.find((file) => file.rel === rel);
            if (!expected) throw new Error(`Bound Context file disappeared: ${rel}`);
            if (expected.ledger) {
              groupTasks.push({ entryPath: entry.path, ledger: expected.ledger, files: entry.confluenceGroup?.files ?? expected.ledger.items.length, download: async () => (await appSession()).download(rel), checksum: expected.checksum, target: path.join(stageContext, rel), label: `Bound Context changed after PLAN: ${rel}` });
              continue;
            }
            if (expected.confluence) {
              confluenceTasks.push({ entryPath: entry.path, source: expected.confluence, checksum: expected.checksum, target: path.join(stageContext, rel) });
              continue;
            }
            mediaTasks.push({ entryPath: entry.path, download: async () => (await appSession()).download(rel), checksum: expected.checksum, target: path.join(stageContext, rel), label: `Bound Context changed after PLAN: ${rel}` });
            continue;
          }
          completed += 1;
          updateProgress('transferring', feature.originId, entry.path);
        }
        await mapLimit(mediaTasks, MEDIA_TRANSFER_CONCURRENCY, async (task) => {
          const content = await task.download();
          if (checksum(content) !== task.checksum) throw new Error(task.label);
          await fs.mkdir(path.dirname(task.target), { recursive: true });
          await fs.writeFile(task.target, content);
          completed += 1;
          updateProgress('transferring', feature.originId, task.entryPath);
        });
        await mapLimit(confluenceTasks, CONFLUENCE_PULL_CONCURRENCY, async (task) => {
          await pullConfluenceBlob(creds, task.entryPath, task.source, task.checksum, task.target, confluenceOutcome);
          completed += 1;
          updateProgress('transferring', feature.originId, task.entryPath);
        });
        for (const task of groupTasks) {
          const content = await task.download();
          if (checksum(content) !== task.checksum) throw new Error(task.label);
          const relDir = path.posix.dirname(task.entryPath);
          let reported = 0;
          const outcome = await expandLedgerGroup(creds, task.ledger, path.dirname(task.target), {
            relDir,
            onItem: (name) => {
              reported += 1;
              completed += 1;
              updateProgress('transferring', feature.originId, `${relDir}/${name}`);
            },
          });
          completed += Math.max(0, task.files - reported);
          confluenceOutcome.fetched += outcome.fetched;
          confluenceOutcome.drifted.push(...outcome.drifted);
          confluenceOutcome.missing.push(...outcome.missing);
          groupFetched += outcome.fetched;
          groupMissing += outcome.missing.length;
          // The ledger lands last so its mtime caps every file it stands for.
          await fs.mkdir(path.dirname(task.target), { recursive: true });
          await fs.writeFile(task.target, content);
          completed += 1;
          updateProgress('transferring', feature.originId, task.entryPath);
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
        await commitHistory(destination, { kind: 'pull', by: historyActor(), input: feature.originId }).catch(() => null);
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
        // `applied` = entries written + wiki files actually fetched (a missing
        // legacy per-file entry was itself an entry; a missing group item is not).
        const applied = actionable.length - (confluenceOutcome.missing.length - groupMissing) + groupFetched;
        items.push({ originId: feature.originId, localId: feature.localId, state: 'succeeded', result: { planId: stored.plan.planId, applied, skipped: planned.entries.length - actionable.length - unchanged, unchanged, softHiddenOriginFeatureIds: [], stale: [], ...(confluenceTasks.length > 0 || groupTasks.length > 0 ? { confluence: confluenceOutcome } : {}) } });
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
        completed = completedBeforeFeature + featureUnits;
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
    // One unit per actionable entry, plus one per wiki file its ledger expands.
    const totalItems = stored.plan.features.filter((feature) => selectedOriginIds.has(feature.originId))
      .reduce((total, feature) => total + feature.entries
        .filter((entry) => entry.change !== 'unchanged' && entry.resolution === 'pull')
        .reduce((sum, entry) => sum + 1 + (entry.confluenceGroup?.files ?? 0), 0), 0);
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
    // One MediaFolderSession per origin folder for the whole APPLY: the folder
    // is listed once and every upload/download/delete below hits the index.
    // Push may create the folder; pull never does.
    const sessions = new Map<string, Promise<MediaFolderSession>>();
    const sessionFor = (originId: string): Promise<MediaFolderSession> => {
      let pending = sessions.get(originId);
      if (!pending) {
        pending = media.openFolderSession(originId, { create: stored.plan.direction === 'push' });
        sessions.set(originId, pending);
      }
      return pending;
    };
    const unitFor = (entryPath: string) => exec.units.find((unit) => entryPath === unit.prefix || entryPath.startsWith(`${unit.prefix}/`));
    const relFor = (entryPath: string, unit: Unit) => entryPath.slice(unit.prefix.length + 1);
    let applied = 0; let skipped = 0; let unchanged = 0; let manifested = 0;
    const softHiddenOriginFeatureIds: string[] = []; const stale: Array<{ path: string; reason: string }> = [];
    // Pull phase 2: Confluence-backed entries, fetched from the wiki in
    // parallel after every media entry has been handled sequentially.
    const confluenceTasks: Array<{ entry: typeof stored.plan.entries[number]; source: ProjectSyncConfluenceSource; dest: string }> = [];
    // Pull phase 3: ledger entries, each expanded into its wiki files
    // (sequentially per ledger, CONFLUENCE_PULL_CONCURRENCY within one).
    const groupTasks: Array<{ entry: typeof stored.plan.entries[number]; unit: Unit; rel: string; dest: string }> = [];
    const confluenceOutcome = emptyConfluenceOutcome();
    // Media transfers run MEDIA_TRANSFER_CONCURRENCY at a time after the
    // sequential pass: push uploads, and plain pull downloads (control-file
    // rewrites — project.json / app.json — stay inline and sequential).
    const mediaTasks: Array<{ entry: typeof stored.plan.entries[number]; run: () => Promise<void> }> = [];
    // App Push removes an origin-only Feature as one lifecycle operation, not
    // once for every file in its folder. The current files and history remain
    // intact so an administrator can audit or restore the hidden Feature.
    if (stored.plan.direction === 'push' && exec.scope.kind === 'app') {
      for (const unit of exec.units.filter((candidate) => !candidate.localId && candidate.featureId && candidate.originId)) {
        try {
          await (await sessionFor(unit.originId)).upload(PROJECT_LIFECYCLE_PATH, '', 'application/json', Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: unit.originId, visibility: 'hidden', hiddenAt: new Date().toISOString() })));
          softHiddenOriginFeatureIds.push(unit.originId);
          applied += 1;
        } catch (error) {
          stale.push({ path: unit.prefix, reason: (error as Error).message });
        }
      }
    }
    // Pull overwrites local files in place: fence every touched local folder
    // in `.odhistory` first (same contract as the legacy kg pull path), so a
    // clobbered local edit can always be restored.
    const fencedCwds: string[] = [];
    if (stored.plan.direction === 'pull') {
      for (const unit of exec.units) {
        if (!unit.localId) continue;
        const cwd = path.join(ctx.paths.PROJECTS_DIR, unit.localId);
        if (fencedCwds.includes(cwd)) continue;
        const touches = stored.plan.entries.some((entry) => entry.change !== 'unchanged'
          && (body.resolutions?.[entry.path] ?? entry.resolution) === 'pull'
          && unitFor(entry.path) === unit);
        if (!touches || !(await fs.stat(cwd).then((stat) => stat.isDirectory(), () => false))) continue;
        fencedCwds.push(cwd);
        await commitHistory(cwd, { kind: 'pre-pull', by: historyActor() }).catch(() => null);
      }
    }
    let completedItems = 0;
    report?.('transferring', completedItems);
    for (const entry of stored.plan.entries) {
      const resolution = body.resolutions?.[entry.path] ?? entry.resolution;
      const actionable = entry.change !== 'unchanged' && resolution !== 'skip';
      let deferred = false;
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
              } else if (entry.confluence && !entry.local) {
                // A ledger-synthesized origin entry has no media file to remove;
                // the next ledger upload drops it from every origin listing.
                applied += 1;
              } else if (!isHistory(rel)) { await (await sessionFor(unit.originId)).deleteByPath(rel); applied += 1; }
            } else if (entry.confluence) {
              // Bytes stay on Confluence: the ledger (uploaded as a plain file)
              // is the manifest. A stale media copy from a pre-ledger push is
              // removed so the origin listing stops shadowing the ledger.
              if (entry.change === 'changed' && entry.origin && !isHistory(rel)) {
                await (await sessionFor(unit.originId)).deleteByPath(rel);
              }
              manifested += 1;
            } else if (unit.localId) {
              // A ledger uploads as a plain file; the wiki files it stands for
              // are manifested, never uploaded.
              if (entry.confluenceGroup) manifested += entry.confluenceGroup.files;
              const { localId, originId } = unit;
              mediaTasks.push({ entry, run: async () => {
                const content = exec.localContentByPath.get(entry.path)
                  ?? await fs.readFile(path.join(ctx.paths.PROJECTS_DIR, localId, rel));
                await (await sessionFor(originId)).upload(rel, '', 'application/octet-stream', content);
              } });
              deferred = true;
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
            else if (entry.confluenceGroup && entry.origin && isAttachmentsLedgerPath(rel)) {
              groupTasks.push({ entry, unit, rel, dest });
              deferred = true;
            } else if (entry.confluence && entry.origin) {
              confluenceTasks.push({ entry, source: entry.confluence, dest });
              deferred = true;
            } else if (!(unit.featureId && rel === 'project.json') && !(unit.isApp && !unit.contextVersion && rel === 'app.json')) {
              const { originId } = unit;
              mediaTasks.push({ entry, run: async () => {
                const content = await (await sessionFor(originId)).download(rel);
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await fs.writeFile(dest, content);
              } });
              deferred = true;
            } else {
              const content = await (await sessionFor(unit.originId)).download(rel);
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
                unit.pulledDesignSystemId = typeof remote.designSystemId === 'string' && remote.designSystemId
                  ? remote.designSystemId : null;
                unit.pulledComponentSource = parseManifestComponentSource(remote.docsReviewComponentSource);
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
        if (actionable && !deferred) {
          completedItems += 1;
          report?.('transferring', completedItems, entry.path, entry.featureId ?? null);
        }
      }
    }
    if (mediaTasks.length > 0) {
      await mapLimit(mediaTasks, MEDIA_TRANSFER_CONCURRENCY, async ({ entry, run }) => {
        try { await run(); applied += 1; } catch (error) { stale.push({ path: entry.path, reason: (error as Error).message }); }
        completedItems += 1;
        report?.('transferring', completedItems, entry.path, entry.featureId ?? null);
      });
    }
    if (confluenceTasks.length > 0 || groupTasks.length > 0) {
      const creds = await confluenceCreds();
      await mapLimit(confluenceTasks, CONFLUENCE_PULL_CONCURRENCY, async ({ entry, source, dest }) => {
        try {
          if (await pullConfluenceBlob(creds, entry.path, source, entry.origin!.checksum, dest, confluenceOutcome)) applied += 1;
        } catch (error) { stale.push({ path: entry.path, reason: (error as Error).message }); }
        completedItems += 1;
        report?.('transferring', completedItems, entry.path, entry.featureId ?? null);
      });
      for (const { entry, unit, rel, dest } of groupTasks) {
        const files = entry.confluenceGroup?.files ?? 0;
        const relDir = path.posix.dirname(entry.path);
        let reported = 0;
        try {
          const content = await (await sessionFor(unit.originId)).download(rel);
          if (checksum(content) !== entry.origin!.checksum) throw new Error(`Remote ledger changed after PLAN: ${rel}`);
          const parsed = parseConfluenceLedgerBuffer(content);
          const ledger = exec.ledgerItemsByPath.get(entry.path) ?? (parsed ? { base: parsed.base, items: parsed.items } : null);
          if (!ledger) throw new Error(`Ledger unreadable: ${rel}`);
          const outcome = await expandLedgerGroup(creds, ledger, path.dirname(dest), {
            relDir,
            onItem: (name) => {
              reported += 1;
              completedItems += 1;
              report?.('transferring', completedItems, `${relDir}/${name}`, entry.featureId ?? null);
            },
          });
          confluenceOutcome.fetched += outcome.fetched;
          confluenceOutcome.drifted.push(...outcome.drifted);
          confluenceOutcome.missing.push(...outcome.missing);
          // The ledger lands last so its mtime caps every file it stands for
          // (the next PLAN matches them by mtime instead of hashing bytes).
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, content);
          applied += 1 + outcome.fetched;
        } catch (error) { stale.push({ path: entry.path, reason: (error as Error).message }); }
        completedItems += 1 + Math.max(0, files - reported);
        report?.('transferring', completedItems, entry.path, entry.featureId ?? null);
      }
    }
    report?.('finalizing', completedItems);
    if (stale.length === 0) {
      for (const cwd of fencedCwds) await commitHistory(cwd, { kind: 'pull', by: historyActor(), input: stored.plan.origin.originId }).catch(() => null);
    }
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
            setPipelineAppDesignSystem(db, {
              id: unit.localId,
              name: unit.name,
              designSystemId: unit.pulledDesignSystemId ?? null,
              createdAt: Date.now(),
            });
            setPipelineAppDocsReviewComponentSource(db, {
              id: unit.localId,
              name: unit.name,
              source: unit.pulledComponentSource ?? { mode: 'app-design-system' },
              createdAt: Date.now(),
            });
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
    const result: ProjectSyncApplyResult = {
      planId: stored.plan.planId, applied, skipped, unchanged, softHiddenOriginFeatureIds, stale,
      ...(manifested > 0 ? { manifested } : {}),
      ...(confluenceTasks.length > 0 || groupTasks.length > 0 ? { confluence: confluenceOutcome } : {}),
    };
    appliedResults.set(stored.plan.planId, { expiresAt: Date.now() + PROJECT_SYNC_PLAN_TTL_MS, result });
    res.json({ ok: true, data: result });
  };
  app.post('/api/project-sync/apply', applyHandler);

  // Web calls this after a Pull PLAN: can THIS machine re-download the plan's
  // Confluence-backed files? Blocks the Pull button on PAT/base/space problems.
  app.post('/api/project-sync/confluence-preflight', async (req, res) => {
    const body = (req.body ?? {}) as ProjectSyncConfluencePreflightRequest;
    const planId = typeof body.planId === 'string' ? body.planId : '';
    const batchPlanId = typeof body.batchPlanId === 'string' ? body.batchPlanId : '';
    if ((planId ? 1 : 0) + (batchPlanId ? 1 : 0) !== 1) return sendApiError(res, 400, 'BAD_REQUEST', 'exactly one of planId or batchPlanId is required');
    // Sources = every wiki item of a selected ledger entry (from the retained
    // ledger items, never re-downloaded) + legacy per-file Confluence entries.
    type PreflightEntry = { path: string; confluence?: ProjectSyncConfluenceSource; confluenceGroup?: { files: number }; resolution: string; local?: { size: number }; origin?: { size: number } };
    // Entry paths repeat across the Features of one batch (`feature/…`), so
    // each Feature resolves its ledgers against its own execution record.
    let scopes: Array<{ entries: PreflightEntry[]; ledgerAt: (entryPath: string) => LedgerRef | undefined }> | null = null;
    if (planId) {
      const now = Date.now();
      for (const [id, pending] of execution) if (pending.expiresAt <= now) execution.delete(id);
      const stored = plans.get(planId);
      const exec = execution.get(planId);
      scopes = stored && exec ? [{ entries: stored.plan.entries, ledgerAt: (entryPath) => exec.ledgerItemsByPath.get(entryPath) }] : null;
    } else {
      sweepFeaturePull();
      const stored = featurePullPlans.get(batchPlanId);
      scopes = stored ? stored.plan.features.map((planned) => {
        const feature = stored.features.find((row) => row.originId === planned.originId);
        const byPath = new Map<string, LedgerRef>();
        for (const file of feature?.featureFiles ?? []) if (file.ledger) byPath.set(`feature/${file.rel}`, file.ledger);
        for (const file of feature?.contextFiles ?? []) if (file.ledger) byPath.set(`bound-context/${planned.originId}/${file.rel}`, file.ledger);
        return { entries: planned.entries, ledgerAt: (entryPath: string) => byPath.get(entryPath) };
      }) : null;
    }
    if (!scopes) return sendApiError(res, 404, ERR_PROJECT_SYNC_PLAN_EXPIRED, 'plan expired — re-plan and retry');
    const sources: ProjectSyncConfluenceSource[] = [];
    const sizes: number[] = [];
    for (const { entries, ledgerAt } of scopes) for (const entry of entries) {
      if (entry.resolution === 'skip') continue;
      const ledger = entry.confluenceGroup ? ledgerAt(entry.path) : undefined;
      if (ledger) {
        for (const item of ledger.items) { sources.push(confluenceSourceOf(ledger.base, item)); sizes.push(item.size); }
      } else if (entry.confluence) {
        sources.push(entry.confluence);
        sizes.push(entry.local?.size ?? entry.origin?.size ?? 0);
      }
    }
    try {
      const data = await confluencePreflight(await confluenceCreds(), sources, sizes);
      res.json({ ok: true, data });
    } catch (error) { sendApiError(res, 502, 'PROJECT_SYNC_CONFLUENCE_PREFLIGHT_FAILED', (error as Error).message); }
  });

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
    // One unit per actionable entry; a Pull adds one per wiki file a ledger
    // entry expands (Push manifests the group as a single upload).
    const totalItems = stored.plan.entries.reduce((total, entry) => {
      const resolution = body.resolutions?.[entry.path] ?? entry.resolution;
      if (entry.change === 'unchanged' || resolution === 'skip') return total;
      return total + 1 + (stored.plan.direction === 'pull' ? entry.confluenceGroup?.files ?? 0 : 0);
    }, 0);
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
