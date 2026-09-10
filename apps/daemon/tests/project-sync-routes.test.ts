import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({
  projects: [] as any[],
  origins: [] as any[],
  mediaFiles: {} as Record<string, any[]>,
  uploads: [] as Array<{ projectId: string; path: string; content: Buffer }>,
  deletes: [] as Array<{ projectId: string; path: string }>,
  appUpserts: [] as Array<{ id: string; name: string }>,
  pipelineApps: [] as Array<{ id: string; name: string }>,
  failDownloads: new Set<string>(),
  downloads: [] as string[],
  sessionOpens: [] as string[],
  listCalls: [] as string[],
  failAppUpsert: false,
  history: [] as Array<{ cwd: string; kind: string; input?: string }>,
  confluenceCreds: null as { base: string; token: string } | null,
  confluenceFetch: null as null | ((url: string) => Response | Promise<Response>),
  confluenceRequests: [] as string[],
}));

vi.mock('../src/bas/bas-client.js', () => ({
  resolveConfluenceCreds: async () => state.confluenceCreds,
}));
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (state.confluenceFetch && url.startsWith('https://wiki.test')) { state.confluenceRequests.push(url); return state.confluenceFetch(url); }
  return realFetch(input, init);
}) as typeof fetch;

vi.mock('../src/db.js', () => ({
  listProjects: () => state.projects,
  listPipelineApps: () => state.pipelineApps,
  getPipelineApp: (_db: unknown, id: string) => state.pipelineApps.find((app) => app.id === id) ?? null,
  getProject: (_db: unknown, id: string) => state.projects.find((project) => project.id === id) ?? null,
  insertProject: (_db: unknown, project: any) => { state.projects.push(project); },
  updateProject: (_db: unknown, id: string, patch: any) => { const project = state.projects.find((row) => row.id === id); if (project) Object.assign(project, patch); },
  upsertPipelineAppName: (_db: unknown, value: { id: string; name: string }) => {
    if (state.failAppUpsert) throw new Error('app upsert failed');
    state.appUpserts.push(value);
    const existing = state.pipelineApps.find((row) => row.id === value.id);
    if (existing) existing.name = value.name;
    else state.pipelineApps.push({ id: value.id, name: value.name });
  },
  setPipelineAppDesignSystem: (_db: unknown, value: { id: string; designSystemId: string | null }) => {
    const app = state.pipelineApps.find((row) => row.id === value.id);
    if (app) Object.assign(app, { designSystemId: value.designSystemId });
  },
  setPipelineAppDocsReviewComponentSource: (_db: unknown, value: { id: string; source: unknown }) => {
    const app = state.pipelineApps.find((row) => row.id === value.id);
    if (app) Object.assign(app, { docsReviewComponentSource: value.source });
  },
}));
vi.mock('../src/kg-sync/remote-registry.js', () => ({
  PROJECT_LIFECYCLE_PATH: '_studio/project-lifecycle.json',
  loadRemoteProjects: async () => state.origins,
}));
vi.mock('../src/kg-sync/media-client.js', () => ({
  MediaClient: class {
    async downloadFile(projectId: string, filePath: string) {
      state.downloads.push(`${projectId}:${filePath}`);
      if (state.failDownloads.has(`${projectId}:${filePath}`)) throw new Error(`download failed: ${projectId}:${filePath}`);
      const file = state.mediaFiles[projectId]?.find((candidate) => candidate.path === filePath);
      if (file?.content) return Buffer.from(file.content);
      const row = state.origins.find((origin) => origin.projectId === projectId);
      return Buffer.from(JSON.stringify({ appId: row?.appId }));
    }
    async listFiles(projectId: string) { state.listCalls.push(projectId); return state.mediaFiles[projectId] ?? []; }
    // Resolves one row by path WITHOUT listing the folder (mirrors the real
    // tag-search endpoint) — never pushes to state.listCalls/sessionOpens, so
    // a view-only App pull that only needs `app.json` never triggers the
    // full-listing assertions below.
    async findFileByPath(projectId: string, filePath: string) {
      const file = state.mediaFiles[projectId]?.find((candidate) => candidate.path === filePath);
      if (!file) return null;
      const id = file.id ?? `${projectId}:${filePath}`;
      return { id, path: file.path, checksum: file.checksum ?? '', stage: file.stage ?? '', name: file.path.split('/').pop() ?? file.path, mime: file.mime ?? '', size: 0 };
    }
    async downloadById(id: string) {
      const sep = id.indexOf(':');
      const projectId = sep === -1 ? id : id.slice(0, sep);
      const filePath = sep === -1 ? '' : id.slice(sep + 1);
      return this.downloadFile(projectId, filePath);
    }
    async uploadFile(projectId: string, _name: string, filePath: string, _mime: string, content: Buffer) {
      state.uploads.push({ projectId, path: filePath, content });
    }
    async deleteFile() {}
    // Mirrors MediaFolderSession: one "list" per open (counted in
    // state.sessionOpens), every read/write delegated to the fake above so
    // state.uploads / state.downloads keep recording.
    async openFolderSession(projectId: string) {
      state.sessionOpens.push(projectId);
      const rows = () => state.mediaFiles[projectId] ?? [];
      return {
        projectId,
        folderId: projectId,
        has: (filePath: string) => rows().some((row) => row.path === filePath),
        get: (filePath: string) => rows().filter((row) => row.path === filePath),
        list: () => rows(),
        listFiles: () => rows(),
        download: (filePath: string) => this.downloadFile(projectId, filePath),
        upload: (filePath: string, stage: string, mime: string, content: Buffer) => this.uploadFile(projectId, stage, filePath, mime, content),
        deleteByPath: async (filePath: string) => { state.deletes.push({ projectId, path: filePath }); return 1; },
      };
    }
  },
  mediaConfigFromEnv: () => ({}),
}));
vi.mock('../src/project-history.js', async () => {
  const { promises: nodeFs } = await import('node:fs');
  const nodePath = await import('node:path');
  return {
    commitHistory: async (cwd: string, meta: { kind: string; input?: string }) => {
      state.history.push({ cwd, kind: meta.kind, ...(meta.input ? { input: meta.input } : {}) });
      // Simulate the hidden repo the real module creates inside cwd.
      await nodeFs.mkdir(nodePath.join(cwd, '.odhistory'), { recursive: true });
      await nodeFs.writeFile(nodePath.join(cwd, '.odhistory', 'HEAD'), 'ref: refs/heads/main\n');
      return { commit: 'deadbeef', filesChanged: 1 };
    },
  };
});
vi.mock('../src/history-actor.js', () => ({ historyActor: () => ({ id: 'user-1', email: 'user@test', name: 'User' }) }));
import { createHash } from 'node:crypto';
import { registerProjectSyncRoutes, runningStageIdsOf } from '../src/project-sync-routes.js';

type Handler = (req: any, res: any) => Promise<void> | void;
function handlers(projectsDir = '/no-projects') {
  const table = new Map<string, Handler>();
  const app = { get: (path: string, handler: Handler) => table.set(`GET ${path}`, handler), post: (path: string, handler: Handler) => table.set(`POST ${path}`, handler) };
  registerProjectSyncRoutes(app as never, { db: {} as never, http: { sendApiError: (res: any, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } }) } as never, paths: { PROJECTS_DIR: projectsDir } as never });
  return table;
}
async function call(handler: Handler, body = {}, query = {}, params = {}) {
  const output: any = { status: 200 }; const res: any = { status: (status: number) => (output.status = status, res), json: (json: unknown) => (output.body = json, res) };
  await handler({ body, query, params }, res); return output;
}
const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));
async function pollOperation(table: Map<string, Handler>, operationId: string) {
  let response: any;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await nextImmediate();
    response = await call(table.get('GET /api/project-sync/operations/:id')!, {}, {}, { id: operationId });
    if (response.body.data.state === 'succeeded' || response.body.data.state === 'failed') return response;
  }
  return response;
}
/** Time-based variant for operations that do real disk + wiki I/O. */
async function pollOperationSlow(table: Map<string, Handler>, operationId: string) {
  let response: any;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    response = await call(table.get('GET /api/project-sync/operations/:id')!, {}, {}, { id: operationId });
    if (response.body.data.state === 'succeeded' || response.body.data.state === 'failed') return response;
  }
  return response;
}
async function pollFeaturePullOperation(table: Map<string, Handler>, operationId: string) {
  let response: any;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    response = await call(table.get('GET /api/project-sync/feature-pulls/operations/:id')!, {}, {}, { id: operationId });
    if (response.body.data.state === 'succeeded' || response.body.data.state === 'failed') return response;
  }
  return response;
}

describe('project-sync route contract', () => {
  beforeEach(() => { state.projects = []; state.origins = []; state.mediaFiles = {}; state.uploads = []; state.deletes = []; state.appUpserts = []; state.pipelineApps = []; state.failDownloads = new Set(); state.downloads = []; state.sessionOpens = []; state.listCalls = []; state.failAppUpsert = false; state.history = []; state.confluenceCreds = null; state.confluenceFetch = null; state.confluenceRequests = []; });

  it('filters origins to visible rows and supports the Feature App filter', async () => {
    state.origins = [
      { projectId: 'app', name: 'App', isApp: true, inMedia: true, visibility: 'visible' },
      { projectId: 'feature-a', name: 'A', isApp: false, appId: 'app', inMedia: true, visibility: 'visible' },
      { projectId: 'feature-hidden', name: 'Hidden', isApp: false, appId: 'app', inMedia: true, visibility: 'hidden' },
    ];
    const out = await call(handlers().get('GET /api/project-sync/origins')!, {}, { kind: 'feature', appId: 'app' });
    expect(out.status).toBe(200);
    expect(out.body.data.origins.map((origin: any) => origin.originId)).toEqual(['feature-a']);
  });

  it('reports an unmapped local project as new and guards PLAN/APPLY', async () => {
    state.projects = [{ id: 'local', name: 'Local', metadata: { studioConfig: {} } }];
    const table = handlers();
    const status = await call(table.get('POST /api/project-sync/status')!);
    expect(status.body.data.results[0]).toMatchObject({ state: 'new', mappingValid: false, origin: null });
    const plan = await call(table.get('POST /api/project-sync/plan')!, { direction: 'push', scope: { kind: 'feature', projectId: 'local' } });
    expect(plan.status).toBe(400); expect(plan.body.error.code).toBe('ORIGIN_REQUIRED');
    const apply = await call(table.get('POST /api/project-sync/apply')!, { planId: 'gone' });
    expect(apply.status).toBe(409); expect(apply.body.error.code).toBe('PLAN_EXPIRED');
  });

  it('keeps App status scoped to App metadata and latest Context, excluding Features', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-app-status-scope-'));
    try {
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.origins = [
        { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'remote-feature', name: 'Remote Feature', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
      ];
      state.mediaFiles = {
        'shared-app': [{ path: 'app.json', content: '{}' }],
        'remote-feature': [{ path: 'project.json', content: '{}' }, { path: 'remote-only.md', content: 'remote' }],
      };
      await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
      const status = await call(handlers(root).get('POST /api/project-sync/status')!, { scopes: [{ kind: 'app', projectId: 'local-app' }] });
      expect(status.body.data.results[0].entries.every((entry: any) => !entry.path.startsWith('features/'))).toBe(true);
      expect(status.body.data.results[0].features).toEqual([]);
      // 0.8.168: appId đọc sẵn trong lượt list registry — App status không còn
      // tải bất kỳ file nào của feature (trước đây cho phép đúng 1 lượt
      // project.json "registry lookup only").
      expect(state.downloads.every((value) => !value.startsWith('remote-feature:'))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('marks a Pull incomplete when post-transfer App mapping finalization fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-app-pull-finalize-fail-'));
    try {
      state.origins = [{ projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' }];
      state.mediaFiles = { 'shared-app': [{ path: 'app.json', content: JSON.stringify({ kind: 'app', name: 'Shared App' }) }] };
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/plan')!, {
        direction: 'pull', scope: { kind: 'app', projectId: 'local-app' }, origin: { mode: 'existing', originId: 'shared-app' }, pullMode: 'work',
      });
      state.failAppUpsert = true;
      await expect(call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId })).rejects.toThrow('app upsert failed');
      state.failAppUpsert = false;
      const status = await call(table.get('POST /api/project-sync/status')!, { scopes: [{ kind: 'app', projectId: 'local-app' }] });
      expect(status.body.data.results[0]).toMatchObject({ status: 'incomplete', reason: 'previous_sync_incomplete' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('uses an optional new display name while keeping the generated destination id', async () => {
    state.projects = [{ id: 'local', name: 'Tên trên máy', metadata: { studioConfig: {} } }];
    const table = handlers();
    const planned = await call(table.get('POST /api/project-sync/plan')!, {
      direction: 'push',
      scope: { kind: 'feature', projectId: 'local' },
      origin: { mode: 'new', originId: 'feature--generated', name: 'Tên trên kho chung' },
    });
    expect(planned.status).toBe(200);
    expect(planned.body.data.origin).toEqual({ mode: 'new', originId: 'feature--generated', name: 'Tên trên kho chung' });
    expect(planned.body.data.features[0]).toMatchObject({ id: 'local', name: 'Tên trên kho chung', originId: 'feature--generated' });
    const applied = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
    expect(applied.status).toBe(200);
    const uploaded = state.uploads.find((item) => item.projectId === 'feature--generated' && item.path === 'project.json');
    expect(JSON.parse(uploaded!.content.toString('utf8')).name).toBe('Tên trên kho chung');
  });

  it('pushes many files through one folder session per unit (uploads all, lists at most twice)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-push-session-'));
    try {
      state.projects = [{ id: 'local', name: 'Local', metadata: { studioConfig: {} } }];
      await fs.mkdir(path.join(root, 'local', 'ux'), { recursive: true });
      for (let i = 0; i < 10; i += 1) await fs.writeFile(path.join(root, 'local', 'ux', `file-${i}.json`), JSON.stringify({ i }));
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/plan')!, {
        direction: 'push', scope: { kind: 'feature', projectId: 'local' }, origin: { mode: 'new', originId: 'feature--many' },
      });
      expect(planned.status).toBe(200);
      state.sessionOpens = [];
      const applied = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
      expect(applied.status).toBe(200);
      expect(applied.body.data.stale).toEqual([]);
      const uploaded = state.uploads.filter((item) => item.projectId === 'feature--many' && item.path.startsWith('ux/')).map((item) => item.path).sort();
      expect(uploaded).toEqual(Array.from({ length: 10 }, (_, i) => `ux/file-${i}.json`).sort());
      expect(applied.body.data.applied).toBeGreaterThanOrEqual(10);
      // The apply itself opens ONE session for the unit; the post-apply verify
      // plan may open one more. Never one list per file.
      expect(state.sessionOpens.filter((id) => id === 'feature--many').length).toBeLessThanOrEqual(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('starts and polls an asynchronous APPLY operation while preserving legacy APPLY', async () => {
    state.projects = [{ id: 'local', name: 'Local', metadata: { studioConfig: {} } }];
    const table = handlers();
    const planned = await call(table.get('POST /api/project-sync/plan')!, {
      direction: 'push',
      scope: { kind: 'feature', projectId: 'local' },
      origin: { mode: 'new', originId: 'feature--async' },
    });
    const actionableItems = planned.body.data.entries.filter((entry: any) => entry.change !== 'unchanged' && entry.resolution !== 'skip').length;
    const started = await call(table.get('POST /api/project-sync/operations')!, { planId: planned.body.data.planId });
    expect(started.status).toBe(202);
    expect(started.body.data).toMatchObject({
      planId: planned.body.data.planId,
      state: 'queued',
      phase: 'validating',
      progress: { completedItems: 0, totalItems: actionableItems },
    });
    const duplicate = await call(table.get('POST /api/project-sync/operations')!, { planId: planned.body.data.planId });
    expect(duplicate.status).toBe(202);
    expect(duplicate.body.data.operationId).toBe(started.body.data.operationId);

    const polled = await pollOperation(table, started.body.data.operationId);
    expect(polled.status).toBe(200);
    expect(polled.body.data).toMatchObject({
      state: 'succeeded',
      phase: 'finalizing',
      progress: {
        completedItems: actionableItems,
        totalItems: actionableItems,
        percent: 100,
      },
      result: { planId: planned.body.data.planId, stale: [] },
    });
    expect(state.uploads.filter((item) => item.projectId === 'feature--async')).toHaveLength(1);

    const retained = await call(table.get('POST /api/project-sync/operations')!, { planId: planned.body.data.planId });
    expect(retained.status).toBe(200);
    expect(retained.body.data.operationId).toBe(started.body.data.operationId);

    const legacy = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
    expect(legacy.status).toBe(200);
    expect(legacy.body.data).toEqual(polled.body.data.result);
  });

  it('reports missing operations and retains asynchronous PLAN_EXPIRED failures', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-project-sync-operation-'));
    try {
      const table = handlers(root);
      const missing = await call(table.get('GET /api/project-sync/operations/:id')!, {}, {}, { id: 'missing' });
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('PROJECT_SYNC_OPERATION_NOT_FOUND');

      state.projects = [{ id: 'local', name: 'Local', metadata: { studioConfig: {} } }];
      const planned = await call(table.get('POST /api/project-sync/plan')!, {
        direction: 'push',
        scope: { kind: 'feature', projectId: 'local' },
        origin: { mode: 'new', originId: 'feature--drift' },
      });
      await fs.mkdir(path.join(root, 'local'), { recursive: true });
      // A changed local control file invalidates the immutable PLAN baseline.
      await fs.writeFile(path.join(root, 'local', 'project.json'), '{"name":"drifted"}');
      const started = await call(table.get('POST /api/project-sync/operations')!, { planId: planned.body.data.planId });
      const failed = await pollOperation(table, started.body.data.operationId);
      expect(failed.body.data).toMatchObject({
        state: 'failed',
        error: { code: 'PLAN_EXPIRED', retryable: true },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('plans and pulls one or many Features only under the mapped App with pollable progress', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-batch-'));
    try {
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.origins = [
        { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature-a', name: 'Feature A', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
        { projectId: 'feature-b', name: 'Feature B', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
      ];
      const featureControl = (name: string) => JSON.stringify({ name, appId: 'shared-app', appContextBinding: { appId: 'shared-app', contextVersion: 'v1' } });
      state.mediaFiles = {
        'shared-app': [
          { path: 'app.json', content: JSON.stringify({ name: 'Shared App' }) },
          { path: 'context/versions/v1/manifest.json', content: JSON.stringify({ contextVersion: 'v1', files: [{ path: 'brief.md' }] }) },
          { path: 'context/versions/v1/files/brief.md', content: 'shared context' },
        ],
        'feature-a': [
          { path: 'project.json', content: featureControl('Feature A') },
          { path: 'outputs/a.md', content: 'A' },
        ],
        'feature-b': [
          { path: 'project.json', content: featureControl('Feature B') },
          { path: 'outputs/b.md', content: 'B' },
        ],
      };
      await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {
        localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a', 'feature-b'], pullMode: 'work',
      });
      expect(planned.status).toBe(200);
      expect(planned.body.data.features).toEqual([
        expect.objectContaining({ originId: 'feature-a', mode: 'create', localId: 'feature-a' }),
        expect.objectContaining({ originId: 'feature-b', mode: 'create', localId: 'feature-b' }),
      ]);
      const started = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: planned.body.data.planId });
      expect(started.status).toBe(202);
      const duplicate = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: planned.body.data.planId });
      expect(duplicate.body.data.operationId).toBe(started.body.data.operationId);
      const completed = await pollFeaturePullOperation(table, started.body.data.operationId);
      expect(completed.body.data).toMatchObject({
        state: 'succeeded', phase: 'finalizing', progress: { percent: 100 },
        result: { state: 'succeeded', items: [{ state: 'succeeded' }, { state: 'succeeded' }] },
      });
      expect(state.projects.map((project) => project.id)).toEqual(['feature-a', 'feature-b']);
      expect(await fs.readFile(path.join(root, 'feature-a', 'outputs', 'a.md'), 'utf8')).toBe('A');
      expect(JSON.parse(await fs.readFile(path.join(root, 'feature-a', 'project.json'), 'utf8'))).toMatchObject({
        appId: 'local-app', appContextBinding: { appId: 'local-app', contextVersion: 'v1' },
      });
      expect(await fs.readFile(path.join(root, 'local-app', 'context', 'versions', 'v1', 'files', 'brief.md'), 'utf8')).toBe('shared context');
      expect(state.projects[0].metadata).toMatchObject({
        appContextBinding: { appId: 'local-app', contextVersion: 'v1' },
        studioConfig: { appId: 'local-app', remoteId: 'feature-a', projectSyncMapping: { originAppId: 'shared-app' } },
      });
      const firstPullStatus = await call(table.get('POST /api/project-sync/status')!, {
        scopes: [{ kind: 'feature', projectId: 'feature-a', appId: 'local-app' }],
      });
      expect(firstPullStatus.body.data.results[0]).toMatchObject({
        status: 'up_to_date',
        reason: 'contents_match',
        state: expect.not.stringMatching(/^deleted$/),
      });

      // A later update removes a file that disappeared remotely while keeping
      // the existing mapped local id.
      state.mediaFiles['feature-a'] = state.mediaFiles['feature-a']!.filter((file) => file.path !== 'outputs/a.md');
      const updatePlan = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {
        localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'], pullMode: 'work',
      });
      expect(updatePlan.body.data.features[0]).toMatchObject({ mode: 'update', localId: 'feature-a' });
      expect(updatePlan.body.data.features[0].entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'feature/outputs/a.md', change: 'deleted', resolution: 'skip' })]));
      const updateStarted = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: updatePlan.body.data.planId });
      const updateDone = await pollFeaturePullOperation(table, updateStarted.body.data.operationId);
      // A local-only file is `deleted`/`skip` in a pull PLAN: it is kept, not removed.
      expect(updateDone.body.data.result.items[0]).toMatchObject({ state: 'succeeded', result: { applied: 0 } });
      expect(await fs.readFile(path.join(root, 'feature-a', 'outputs', 'a.md'), 'utf8')).toBe('A');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('commits successful Feature items, leaves no failed orphan, and retries failed items only', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-partial-'));
    try {
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.origins = [
        { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature-a', name: 'A', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
        { projectId: 'feature-b', name: 'B', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
      ];
      const control = (name: string) => JSON.stringify({ name, appId: 'shared-app' });
      state.mediaFiles = {
        'shared-app': [{ path: 'app.json', content: '{}' }],
        'feature-a': [{ path: 'project.json', content: control('A') }, { path: 'a.md', content: 'A' }],
        'feature-b': [{ path: 'project.json', content: control('B') }, { path: 'b.md', content: 'B' }],
      };
      await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a', 'feature-b'], pullMode: 'work' });
      state.failDownloads.add('feature-b:b.md');
      const started = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: planned.body.data.planId });
      const partial = await pollFeaturePullOperation(table, started.body.data.operationId);
      expect(partial.body.data.result).toMatchObject({ state: 'partial', items: [{ originId: 'feature-a', state: 'succeeded' }, { originId: 'feature-b', state: 'failed' }] });
      expect(state.projects.map((project) => project.id)).toEqual(['feature-a']);
      await expect(fs.stat(path.join(root, 'feature-b'))).rejects.toThrow();
      state.failDownloads.clear();
      state.downloads = [];
      const retry = await call(table.get('POST /api/project-sync/feature-pulls/operations/:id/retry')!, {}, {}, { id: started.body.data.operationId });
      const duplicateRetry = await call(table.get('POST /api/project-sync/feature-pulls/operations/:id/retry')!, {}, {}, { id: started.body.data.operationId });
      expect(duplicateRetry.body.data.operationId).toBe(retry.body.data.operationId);
      const retried = await pollFeaturePullOperation(table, retry.body.data.operationId);
      expect(retried.body.data.result).toMatchObject({ state: 'succeeded', items: [{ originId: 'feature-b', state: 'succeeded' }] });
      expect(state.downloads.some((value) => value.startsWith('feature-a:'))).toBe(false);
      expect(state.projects.map((project) => project.id)).toEqual(['feature-a', 'feature-b']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed Feature batch bodies before accessing origin storage', async () => {
    const table = handlers();
    const response = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {});
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('FEATURE_PULL_INVALID_REQUEST');
    expect(state.downloads).toEqual([]);
  });

  it('keeps a hidden or wrong-kind mapping in the explicit new/remediation state', async () => {
    state.projects = [{ id: 'local', name: 'Local', metadata: { studioConfig: { remoteId: 'shared' } } }];
    state.origins = [{ projectId: 'shared', name: 'Shared', isApp: false, inMedia: true, visibility: 'hidden' }];
    const table = handlers();
    const hidden = await call(table.get('POST /api/project-sync/status')!, { scopes: [{ kind: 'feature', projectId: 'local' }] });
    expect(hidden.body.data.results[0]).toMatchObject({ state: 'new', mappingValid: false, origin: { originId: 'shared', visibility: 'hidden' } });

    state.origins = [{ projectId: 'shared', name: 'Shared app', isApp: true, inMedia: true, visibility: 'visible' }];
    const wrongKind = await call(table.get('POST /api/project-sync/status')!, { scopes: [{ kind: 'feature', projectId: 'local' }] });
    expect(wrongKind.body.data.results[0]).toMatchObject({ state: 'new', mappingValid: false });
  });

  it('reports a mapped Feature parent lookup failure as unavailable, not missing', async () => {
    state.projects = [{ id: 'local', name: 'Local', metadata: { studioConfig: { remoteId: 'shared' } } }];
    // 0.8.168: appId/parentLookupFailed do loadRemoteProjects đọc sẵn (1 lượt
    // list), route không tải lại project.json — mô phỏng lỗi ngay trên row.
    state.origins = [{ projectId: 'shared', name: 'Shared', isApp: false, appId: null, parentLookupFailed: true, inMedia: true, visibility: 'visible' }];
    const status = await call(handlers().get('POST /api/project-sync/status')!, { scopes: [{ kind: 'feature', projectId: 'local', appId: 'local-app' }] });
    expect(status.body.data.results[0]).toMatchObject({ status: 'unavailable', reason: 'status_check_failed' });
  });

  it('plans Feature Pull against the remote bound Context version, not stale local metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-remote-binding-'));
    try {
      state.projects = [{
        id: 'local-feature', name: 'Feature',
        metadata: {
          appContextBinding: { schemaVersion: 1, appId: 'local-app', contextVersion: 'v1', contentDigest: 'sha256:old', boundAt: '2026-01-01T00:00:00.000Z' },
          studioConfig: { appId: 'local-app', remoteId: 'origin-feature', projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'origin-feature', originAppId: 'origin-app' } },
        },
      }];
      state.origins = [
        { projectId: 'origin-app', name: 'App', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'origin-feature', name: 'Feature', isApp: false, appId: 'origin-app', inMedia: true, visibility: 'visible' },
      ];
      state.mediaFiles = {
        'origin-feature': [{ path: 'project.json', content: JSON.stringify({ appId: 'origin-app', appContextBinding: { appId: 'origin-app', contextVersion: 'v2' } }) }],
        'origin-app': [
          { path: 'context/versions/v2/manifest.json', content: '{}' },
          { path: 'context/versions/v2/files/context.md', content: 'v2' },
        ],
      };
      const plan = await call(handlers(root).get('POST /api/project-sync/plan')!, {
        direction: 'pull', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' },
      });
      expect(plan.status).toBe(200);
      expect(plan.body.data.context).toMatchObject({ contextVersion: 'v2' });
      expect(plan.body.data.entries.some((entry: any) => entry.path.includes('context/versions/v2/'))).toBe(true);
      expect(plan.body.data.entries.some((entry: any) => entry.path.includes('context/versions/v1/'))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('limits a Feature plan to that Feature and its explicitly bound Context version', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-project-sync-'));
    try {
      state.projects = [{
        id: 'local-feature',
        name: 'Checkout',
        metadata: {
          studioConfig: {
            appId: 'local-app',
            projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'shared-feature', originAppId: 'shared-app', mappedAt: 'now' },
          },
          appContextBinding: { schemaVersion: 1, appId: 'local-app', contextVersion: 'v2', contentDigest: `sha256:${'a'.repeat(64)}`, boundAt: 'now' },
        },
      }];
      state.origins = [
        { projectId: 'shared-feature', name: 'Checkout', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
        { projectId: 'shared-app', name: 'Retail', isApp: true, inMedia: true, visibility: 'visible' },
      ];
      state.mediaFiles = {
        'shared-feature': [{ path: 'project.json', checksum: 'remote-binding' }],
        'shared-app': [
          { path: 'context/current.json', checksum: 'current' },
          { path: 'context/versions/v1/manifest.json', checksum: 'old' },
          { path: 'context/versions/v2/manifest.json', checksum: 'bound' },
        ],
      };
      await fs.mkdir(path.join(root, 'local-app', 'context', 'versions', 'v1'), { recursive: true });
      await fs.mkdir(path.join(root, 'local-app', 'context', 'versions', 'v2'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', 'context', 'versions', 'v1', 'manifest.json'), 'old');
      await fs.writeFile(path.join(root, 'local-app', 'context', 'versions', 'v2', 'manifest.json'), 'bound-local');

      const planned = await call(handlers(root).get('POST /api/project-sync/plan')!, {
        direction: 'pull',
        scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' },
      });
      expect(planned.status).toBe(200);
      expect(planned.body.data.context).toMatchObject({ contextVersion: 'v2', originId: 'shared-app' });
      expect(planned.body.data.entries.map((entry: any) => entry.path)).toContain('bound-context/context/versions/v2/manifest.json');
      expect(planned.body.data.entries.map((entry: any) => entry.path)).not.toContain('bound-context/context/versions/v1/manifest.json');
      expect(planned.body.data.features.map((feature: any) => feature.id)).toEqual(['local-feature']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('pulls only App metadata and the latest immutable Context, then maps after a clean APPLY', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-project-sync-app-pull-'));
    try {
      state.origins = [
        { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'shared-feature-a', name: 'Feature A', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
        { projectId: 'shared-feature-b', name: 'Feature B', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
      ];
      state.mediaFiles = {
        'shared-app': [
          { path: 'app.json', checksum: 'remote-app', content: JSON.stringify({
            kind: 'app', name: 'Shared App', designSystemId: 'shared-ds',
            docsReviewComponentSource: { mode: 'figma-links', links: [{ url: 'https://www.figma.com/design/ABC123', fileKey: 'ABC123' }] },
          }) },
          { path: 'context/current.json', checksum: 'current-v2', content: JSON.stringify({ schemaVersion: 1, appId: 'shared-app', contextVersion: 'v2' }) },
          { path: 'context/versions/v1/manifest.json', checksum: 'manifest-v1', content: '{"contextVersion":"v1"}' },
          { path: 'context/versions/v1/files/app-context/old.md', checksum: 'old-v1', content: 'old' },
          { path: 'context/versions/v2/manifest.json', checksum: 'manifest-v2', content: '{"contextVersion":"v2"}' },
          { path: 'context/versions/v2/files/app-context/current.md', checksum: 'current-file-v2', content: 'current' },
          { path: 'changelog.json', checksum: 'history', content: '[]' },
        ],
        'shared-feature-a': [{ path: 'project.json', checksum: 'feature-a', content: JSON.stringify({ appId: 'shared-app' }) }],
        'shared-feature-b': [{ path: 'project.json', checksum: 'feature-b', content: JSON.stringify({ appId: 'shared-app' }) }],
      };
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/plan')!, {
        direction: 'pull',
        scope: { kind: 'app', projectId: 'local-app' },
        origin: { mode: 'existing', originId: 'shared-app' },
        pullMode: 'work',
      });

      expect(planned.status).toBe(200);
      expect(planned.body.data.features).toEqual([]);
      expect(planned.body.data.entries.map((entry: any) => entry.path)).toEqual([
        'app/app.json',
        'app/context/current.json',
        'app/context/versions/v2/files/app-context/current.md',
        'app/context/versions/v2/manifest.json',
      ]);
      expect(state.appUpserts).toEqual([]);
      await expect(fs.stat(path.join(root, 'local-app'))).rejects.toMatchObject({ code: 'ENOENT' });

      const applied = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
      expect(applied.status).toBe(200);
      expect(applied.body.data.stale).toEqual([]);
      expect(state.appUpserts).toHaveLength(1);
      expect(state.appUpserts[0]).toMatchObject({ id: 'local-app', name: 'Shared App' });
      expect(state.pipelineApps[0]).toMatchObject({
        id: 'local-app',
        designSystemId: 'shared-ds',
        docsReviewComponentSource: { mode: 'figma-links', links: [{ fileKey: 'ABC123' }] },
      });
      expect(JSON.parse(await fs.readFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), 'utf8'))).toMatchObject({
        schemaVersion: 1,
        localId: 'local-app',
        originId: 'shared-app',
      });
      expect(JSON.parse(await fs.readFile(path.join(root, 'local-app', 'app.json'), 'utf8'))).toMatchObject({
        kind: 'app',
        name: 'Shared App',
      });
      expect(await fs.readFile(path.join(root, 'local-app', 'context', 'versions', 'v2', 'files', 'app-context', 'current.md'), 'utf8')).toBe('current');
      await expect(fs.stat(path.join(root, 'local-app', 'context', 'versions', 'v1'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('materializes the pulled Context package into the mutable App root so the Tài liệu pool is not empty', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-project-sync-app-pull-docs-'));
    const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'od-project-sync-app-seed-'));
    try {
      // A genuine immutable package (valid manifest digest) built the way the
      // publishing machine builds one, then served byte-for-byte from media.
      const { createAppContextVersion } = await import('../src/app-context-version.js');
      await fs.mkdir(path.join(seed, 'shared-app', 'docs', 'guide'), { recursive: true });
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', '_manifest.json'), JSON.stringify({ version: 1, pages: [{ pageId: 'p1', title: 'Trang 1', path: 'guide/page.md', branch: 'guide' }] }));
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', 'guide', 'page.md'), '# Trang 1\n');
      await createAppContextVersion({ projectsDir: seed, appId: 'shared-app', appName: 'Shared App', designSystemId: null });
      const packaged: Array<{ path: string; checksum: string; content: string }> = [];
      const walk = async (dir: string, rel: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
          else {
            const content = await fs.readFile(path.join(dir, entry.name), 'utf8');
            packaged.push({ path: childRel, checksum: createHash('sha256').update(content).digest('hex'), content });
          }
        }
      };
      await walk(path.join(seed, 'shared-app', 'context'), 'context');
      state.origins = [{ projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' }];
      state.mediaFiles = { 'shared-app': [
        { path: 'app.json', checksum: 'remote-app', content: JSON.stringify({ kind: 'app', name: 'Shared App' }) },
        ...packaged,
      ] };
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/plan')!, {
        direction: 'pull', scope: { kind: 'app', projectId: 'local-app' }, origin: { mode: 'existing', originId: 'shared-app' }, pullMode: 'work',
      });
      expect(planned.status).toBe(200);
      const applied = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
      expect(applied.status).toBe(200);
      expect(applied.body.data.stale).toEqual([]);
      // The immutable copy landed AND was materialized into the mutable root.
      expect(await fs.readFile(path.join(root, 'local-app', 'context', 'versions', 'v1', 'files', 'docs', 'guide', 'page.md'), 'utf8')).toBe('# Trang 1\n');
      expect(await fs.readFile(path.join(root, 'local-app', 'docs', 'guide', 'page.md'), 'utf8')).toBe('# Trang 1\n');
      expect(JSON.parse(await fs.readFile(path.join(root, 'local-app', 'docs', '_manifest.json'), 'utf8')).pages).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(seed, { recursive: true, force: true });
    }
  });

  it('normalizes a pulled Feature project.json back to the origin App id on push', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-push-normalize-appid-'));
    try {
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.projects = [{
        id: 'local-feature', name: 'Checkout',
        metadata: {
          studioConfig: { appId: 'local-app', projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'feature--f', originAppId: 'app--x', mappedAt: 'now' } },
          appContextBinding: { appId: 'local-app', contextVersion: 'v1' },
        },
      }];
      state.origins = [
        { projectId: 'app--x', name: 'X', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature--f', name: 'Checkout', isApp: false, appId: 'app--x', inMedia: true, visibility: 'visible' },
      ];
      const remoteControl = JSON.stringify({ name: 'Checkout (old)', appId: 'app--x', appContextBinding: { appId: 'app--x', contextVersion: 'v1' } });
      state.mediaFiles = {
        'app--x': [],
        'feature--f': [{ path: 'project.json', content: remoteControl, checksum: createHash('sha256').update(remoteControl).digest('hex') }],
      };
      // Exactly what a Feature pull writes locally: LOCAL App id everywhere.
      await fs.mkdir(path.join(root, 'local-feature'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-feature', 'project.json'), `${JSON.stringify({ name: 'Checkout', appId: 'local-app', appContextBinding: { appId: 'local-app', contextVersion: 'v1' } }, null, 2)}\n`);
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/plan')!, {
        direction: 'push', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' },
      });
      expect(planned.status).toBe(200);
      expect(planned.body.data.entries.find((entry: any) => entry.path === 'feature/project.json')).toMatchObject({ change: 'changed' });
      const applied = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
      expect(applied.status).toBe(200);
      expect(applied.body.data.stale).toEqual([]);
      const uploaded = state.uploads.find((item) => item.projectId === 'feature--f' && item.path === 'project.json');
      expect(uploaded).toBeTruthy();
      expect(JSON.parse(uploaded!.content.toString('utf8'))).toEqual({ name: 'Checkout', appId: 'app--x', appContextBinding: { appId: 'app--x', contextVersion: 'v1' } });
      // The local file itself is untouched (still local ownership).
      expect(JSON.parse(await fs.readFile(path.join(root, 'local-feature', 'project.json'), 'utf8')).appId).toBe('local-app');
      // The store now holds the uploaded bytes; STATUS must see no phantom change.
      state.mediaFiles['feature--f'] = [{ path: 'project.json', content: uploaded!.content.toString('utf8'), checksum: createHash('sha256').update(uploaded!.content).digest('hex') }];
      const status = await call(table.get('POST /api/project-sync/status')!, { scopes: [{ kind: 'feature', projectId: 'local-feature', appId: 'local-app' }] });
      expect(status.body.data.results[0]).toMatchObject({ status: 'up_to_date' });
      expect(status.body.data.results[0].entries.filter((entry: any) => entry.change !== 'unchanged')).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('excludes docs-review pool copies from Feature push/status and never deletes them on origin (syncExclude pool copies)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-push-pool-exclude-'));
    try {
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.projects = [{
        id: 'local-feature', name: 'Checkout',
        metadata: { studioConfig: { appId: 'local-app', projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'feature--f', originAppId: 'app--x', mappedAt: 'now' } } },
      }];
      state.origins = [
        { projectId: 'app--x', name: 'X', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature--f', name: 'Checkout', isApp: false, appId: 'app--x', inMedia: true, visibility: 'visible' },
      ];
      const remoteControl = JSON.stringify({ name: 'Checkout', appId: 'app--x' });
      state.mediaFiles = {
        'app--x': [],
        'feature--f': [
          { path: 'project.json', content: remoteControl, checksum: createHash('sha256').update(remoteControl).digest('hex') },
          { path: 'docs-review/docs-app/old.md', content: 'OLD', checksum: createHash('sha256').update('OLD').digest('hex') },
        ],
      };
      await fs.mkdir(path.join(root, 'local-feature', 'docs-review', 'docs-feature'), { recursive: true });
      await fs.mkdir(path.join(root, 'local-feature', 'docs-review', 'docs-app'), { recursive: true });
      await fs.mkdir(path.join(root, 'local-feature', 'docs-review', 'review'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-feature', 'docs-review', 'docs-feature', 'a.md'), 'A');
      await fs.writeFile(path.join(root, 'local-feature', 'docs-review', 'docs-app', 'b.md'), 'B');
      await fs.writeFile(path.join(root, 'local-feature', 'docs-review', 'review', 'r.md'), 'R');
      await fs.writeFile(path.join(root, 'local-feature', 'project.json'), `${JSON.stringify({ name: 'Checkout', appId: 'local-app' }, null, 2)}\n`);
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/plan')!, {
        direction: 'push', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' },
      });
      expect(planned.status).toBe(200);
      const paths: string[] = planned.body.data.entries.map((entry: any) => entry.path);
      expect(paths.some((p) => p.includes('docs-app/'))).toBe(false);
      expect(paths.some((p) => p.includes('docs-feature/'))).toBe(false);
      expect(paths).toContain('feature/docs-review/review/r.md');
      // The pool copy already on origin never surfaces as a plan entry — not
      // even a `deleted` one — because it is invisible on BOTH sides.
      expect(planned.body.data.entries.some((entry: any) => entry.path.includes('old.md'))).toBe(false);

      const applied = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
      expect(applied.status).toBe(200);
      expect(applied.body.data.stale).toEqual([]);
      expect(state.uploads.some((item) => item.path.includes('docs-app/') || item.path.includes('docs-feature/'))).toBe(false);
      expect(state.deletes).toEqual([]);

      // Reflect the just-uploaded bytes on origin (same pattern as the
      // normalize test above) and re-check STATUS: the excluded pool copies
      // stay invisible on both sides, so nothing but them differs.
      const uploadedControl = state.uploads.find((item) => item.projectId === 'feature--f' && item.path === 'project.json');
      const uploadedReview = state.uploads.find((item) => item.projectId === 'feature--f' && item.path === 'docs-review/review/r.md');
      expect(uploadedControl).toBeTruthy();
      expect(uploadedReview).toBeTruthy();
      state.mediaFiles['feature--f'] = [
        { path: 'project.json', content: uploadedControl!.content.toString('utf8'), checksum: createHash('sha256').update(uploadedControl!.content).digest('hex') },
        { path: 'docs-review/docs-app/old.md', content: 'OLD', checksum: createHash('sha256').update('OLD').digest('hex') },
        { path: 'docs-review/review/r.md', content: uploadedReview!.content.toString('utf8'), checksum: createHash('sha256').update(uploadedReview!.content).digest('hex') },
      ];
      const status = await call(table.get('POST /api/project-sync/status')!, { scopes: [{ kind: 'feature', projectId: 'local-feature', appId: 'local-app' }] });
      expect(status.body.data.results[0]).toMatchObject({ status: 'up_to_date' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('pushes the Feature tick list in project.json normalized to the origin App id (tick list)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-push-appPool-'));
    try {
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.projects = [{
        id: 'local-feature', name: 'Checkout',
        metadata: {
          studioConfig: { appId: 'local-app', projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'feature--f', originAppId: 'app--x', mappedAt: 'now' } },
          runAllConfig: { appPool: { appId: 'local-app', paths: ['guide/page.md'] } },
        },
      }];
      state.origins = [
        { projectId: 'app--x', name: 'X', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature--f', name: 'Checkout', isApp: false, appId: 'app--x', inMedia: true, visibility: 'visible' },
      ];
      state.mediaFiles = { 'app--x': [], 'feature--f': [] };
      await fs.mkdir(path.join(root, 'local-feature'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-feature', 'project.json'), `${JSON.stringify({ name: 'Checkout', appId: 'local-app' }, null, 2)}\n`);
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/plan')!, {
        direction: 'push', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' },
      });
      expect(planned.status).toBe(200);
      const applied = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
      expect(applied.status).toBe(200);
      expect(applied.body.data.stale).toEqual([]);
      const uploaded = state.uploads.find((item) => item.projectId === 'feature--f' && item.path === 'project.json');
      expect(uploaded).toBeTruthy();
      expect(JSON.parse(uploaded!.content.toString('utf8'))).toMatchObject({
        appId: 'app--x',
        appPool: { appId: 'app--x', paths: ['guide/page.md'] },
      });
      // The local file itself keeps the local App id (still local ownership).
      expect(JSON.parse(await fs.readFile(path.join(root, 'local-feature', 'project.json'), 'utf8')).appId).toBe('local-app');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('materializes docs-review/docs-feature and docs-app from the bound Context on Feature pull and restores the tick list', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-materialize-'));
    const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-materialize-seed-'));
    try {
      const { createAppContextVersion } = await import('../src/app-context-version.js');
      await fs.mkdir(path.join(seed, 'shared-app', 'docs', 'guide'), { recursive: true });
      await fs.mkdir(path.join(seed, 'shared-app', 'docs', 'attachments'), { recursive: true });
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', '_manifest.json'), JSON.stringify({ version: 1, pages: [] }));
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', 'guide', 'page.md'), '# Page\n');
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', 'guide', 'other.md'), '# Other\n');
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', '_overview.md'), '# Overview\n');
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', 'attachments', 'img.png'), Buffer.from([1, 2, 3]));
      const result = await createAppContextVersion({ projectsDir: seed, appId: 'shared-app', appName: 'Shared App', designSystemId: null });
      const manifest = (result as { manifest: { contextVersion: string; contentDigest: string } }).manifest;
      const packaged: Array<{ path: string; checksum: string; content: Buffer }> = [];
      const walk = async (dir: string, rel: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
          else {
            const content = await fs.readFile(path.join(dir, entry.name));
            packaged.push({ path: childRel, checksum: createHash('sha256').update(content).digest('hex'), content });
          }
        }
      };
      await walk(path.join(seed, 'shared-app', 'context'), 'context');

      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.origins = [
        { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'shared-feature', name: 'Checkout', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
      ];
      const featureControl = JSON.stringify({
        name: 'Checkout', appId: 'shared-app',
        appContextBinding: { appId: 'shared-app', contextVersion: manifest.contextVersion, contentDigest: manifest.contentDigest },
        appPool: { appId: 'shared-app', paths: ['guide/page.md'] },
      });
      state.mediaFiles = {
        'shared-app': [{ path: 'app.json', content: JSON.stringify({ name: 'Shared App' }) }, ...packaged],
        'shared-feature': [{ path: 'project.json', content: featureControl }],
      };
      await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {
        localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['shared-feature'], pullMode: 'work',
      });
      expect(planned.status).toBe(200);
      const started = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: planned.body.data.planId });
      const done = await pollFeaturePullOperation(table, started.body.data.operationId);
      expect(done.body.data.result).toMatchObject({ state: 'succeeded' });

      const localId = state.projects[0]!.id as string;
      const dr = path.join(root, localId, 'docs-review');
      expect(await fs.readFile(path.join(dr, 'docs-feature', 'guide', 'page.md'), 'utf8')).toBe('# Page\n');
      expect(await fs.readFile(path.join(dr, 'docs-feature', 'attachments', 'img.png'))).toBeInstanceOf(Buffer);
      expect(await fs.readFile(path.join(dr, 'docs-app', 'guide', 'page.md'), 'utf8')).toBe('# Page\n');
      expect(await fs.readFile(path.join(dr, 'docs-app', 'guide', 'other.md'), 'utf8')).toBe('# Other\n');
      await expect(fs.stat(path.join(dr, 'docs-feature', 'guide', 'other.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(path.join(dr, 'docs-app', '_overview.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(path.join(dr, 'docs-app', 'attachments', 'img.png'))).rejects.toMatchObject({ code: 'ENOENT' });

      const localControl = JSON.parse(await fs.readFile(path.join(root, localId, 'project.json'), 'utf8'));
      expect(localControl.appPool).toEqual({ appId: 'local-app', paths: ['guide/page.md'] });
      expect(state.projects[0]!.metadata.runAllConfig).toMatchObject({ appPool: { appId: 'local-app', paths: ['guide/page.md'] } });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(seed, { recursive: true, force: true });
    }
  });

  it('materializes docs-review: an empty origin tick list clears a stale local docs-feature copy while docs-app always rebuilds', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-materialize-empty-'));
    const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-materialize-empty-seed-'));
    try {
      const { createAppContextVersion } = await import('../src/app-context-version.js');
      await fs.mkdir(path.join(seed, 'shared-app', 'docs', 'guide'), { recursive: true });
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', '_manifest.json'), JSON.stringify({ version: 1, pages: [] }));
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', 'guide', 'page.md'), '# Page\n');
      const result = await createAppContextVersion({ projectsDir: seed, appId: 'shared-app', appName: 'Shared App', designSystemId: null });
      const manifest = (result as { manifest: { contextVersion: string; contentDigest: string } }).manifest;
      const packaged: Array<{ path: string; checksum: string; content: Buffer }> = [];
      const walk = async (dir: string, rel: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
          else {
            const content = await fs.readFile(path.join(dir, entry.name));
            packaged.push({ path: childRel, checksum: createHash('sha256').update(content).digest('hex'), content });
          }
        }
      };
      await walk(path.join(seed, 'shared-app', 'context'), 'context');

      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.origins = [
        { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'shared-feature', name: 'Checkout', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
      ];
      // A previously-pulled Feature already has a docs-feature/ pool copy on
      // disk (from an earlier non-empty tick list) — the fixture the fix
      // targets: today's pull ticks nothing, and the stale copy must not survive.
      state.projects = [{
        id: 'local-feature', name: 'Checkout',
        metadata: { studioConfig: { appId: 'local-app', projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'shared-feature', originAppId: 'shared-app', mappedAt: 'now' } } },
      }];
      await fs.mkdir(path.join(root, 'local-feature', 'docs-review', 'docs-feature', 'guide'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-feature', 'docs-review', 'docs-feature', 'guide', 'stale.md'), '# Stale\n');
      const featureControl = JSON.stringify({
        name: 'Checkout', appId: 'shared-app',
        appContextBinding: { appId: 'shared-app', contextVersion: manifest.contextVersion, contentDigest: manifest.contentDigest },
        appPool: { appId: 'shared-app', paths: [] },
      });
      state.mediaFiles = {
        'shared-app': [{ path: 'app.json', content: JSON.stringify({ name: 'Shared App' }) }, ...packaged],
        'shared-feature': [{ path: 'project.json', content: featureControl }],
      };
      await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {
        localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['shared-feature'], pullMode: 'work',
      });
      expect(planned.status).toBe(200);
      const started = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: planned.body.data.planId });
      const done = await pollFeaturePullOperation(table, started.body.data.operationId);
      expect(done.body.data.result).toMatchObject({ state: 'succeeded' });

      const localId = state.projects[0]!.id as string;
      expect(localId).toBe('local-feature');
      const dr = path.join(root, localId, 'docs-review');
      await expect(fs.stat(path.join(dr, 'docs-feature', 'guide', 'stale.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readdir(path.join(dr, 'docs-feature')).catch(() => [])).resolves.toEqual([]);
      expect(await fs.readFile(path.join(dr, 'docs-app', 'guide', 'page.md'), 'utf8')).toBe('# Page\n');
      expect(state.projects[0]!.metadata.runAllConfig).toMatchObject({ appPool: { appId: 'local-app', paths: [] } });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(seed, { recursive: true, force: true });
    }
  });

  it('materializes docs-review: no origin appPool signal leaves a stale local docs-feature copy untouched while docs-app always rebuilds', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-materialize-unknown-'));
    const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-materialize-unknown-seed-'));
    try {
      const { createAppContextVersion } = await import('../src/app-context-version.js');
      await fs.mkdir(path.join(seed, 'shared-app', 'docs', 'guide'), { recursive: true });
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', '_manifest.json'), JSON.stringify({ version: 1, pages: [] }));
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', 'guide', 'page.md'), '# Page\n');
      const result = await createAppContextVersion({ projectsDir: seed, appId: 'shared-app', appName: 'Shared App', designSystemId: null });
      const manifest = (result as { manifest: { contextVersion: string; contentDigest: string } }).manifest;
      const packaged: Array<{ path: string; checksum: string; content: Buffer }> = [];
      const walk = async (dir: string, rel: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
          else {
            const content = await fs.readFile(path.join(dir, entry.name));
            packaged.push({ path: childRel, checksum: createHash('sha256').update(content).digest('hex'), content });
          }
        }
      };
      await walk(path.join(seed, 'shared-app', 'context'), 'context');

      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.origins = [
        { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'shared-feature', name: 'Checkout', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
      ];
      // Same stale-copy fixture as above, but the origin control carries no
      // `appPool` at all (an older, not-yet-reseeded origin) — "unknown"
      // must not be treated as "empty".
      state.projects = [{
        id: 'local-feature', name: 'Checkout',
        metadata: { studioConfig: { appId: 'local-app', projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'shared-feature', originAppId: 'shared-app', mappedAt: 'now' } } },
      }];
      await fs.mkdir(path.join(root, 'local-feature', 'docs-review', 'docs-feature', 'guide'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-feature', 'docs-review', 'docs-feature', 'guide', 'stale.md'), '# Stale\n');
      const featureControl = JSON.stringify({
        name: 'Checkout', appId: 'shared-app',
        appContextBinding: { appId: 'shared-app', contextVersion: manifest.contextVersion, contentDigest: manifest.contentDigest },
      });
      state.mediaFiles = {
        'shared-app': [{ path: 'app.json', content: JSON.stringify({ name: 'Shared App' }) }, ...packaged],
        'shared-feature': [{ path: 'project.json', content: featureControl }],
      };
      await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {
        localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['shared-feature'], pullMode: 'work',
      });
      expect(planned.status).toBe(200);
      const started = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: planned.body.data.planId });
      const done = await pollFeaturePullOperation(table, started.body.data.operationId);
      expect(done.body.data.result).toMatchObject({ state: 'succeeded' });

      const localId = state.projects[0]!.id as string;
      expect(localId).toBe('local-feature');
      const dr = path.join(root, localId, 'docs-review');
      expect(await fs.readFile(path.join(dr, 'docs-feature', 'guide', 'stale.md'), 'utf8')).toBe('# Stale\n');
      expect(await fs.readFile(path.join(dr, 'docs-app', 'guide', 'page.md'), 'utf8')).toBe('# Page\n');
      expect((state.projects[0]!.metadata as { runAllConfig?: unknown }).runAllConfig).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(seed, { recursive: true, force: true });
    }
  });

  it('App push carries only the current and Feature-bound Context versions and leaves other origin versions untouched (Feature-bound Context versions)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-app-push-retain-'));
    try {
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.projects = [{
        id: 'local-feature', name: 'Checkout',
        metadata: {
          studioConfig: { appId: 'local-app' },
          appContextBinding: { schemaVersion: 1, appId: 'local-app', contextVersion: 'v1', contentDigest: `sha256:${'a'.repeat(64)}`, boundAt: 'now' },
        },
      }];
      state.origins = [
        { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
      ];
      const v2Manifest = '{"contextVersion":"v2"}';
      state.mediaFiles = {
        'shared-app': [
          { path: 'context/versions/v2/manifest.json', content: v2Manifest, checksum: createHash('sha256').update(v2Manifest).digest('hex') },
          { path: 'context/versions/v2/files/app-context/design.md', content: 'design v2', checksum: createHash('sha256').update('design v2').digest('hex') },
        ],
      };
      await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
      await fs.mkdir(path.join(root, 'local-app', 'context'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', 'context', 'current.json'), JSON.stringify({ schemaVersion: 1, appId: 'local-app', contextVersion: 'v3' }));
      for (const version of ['v1', 'v2', 'v3']) {
        await fs.mkdir(path.join(root, 'local-app', 'context', 'versions', version), { recursive: true });
        await fs.writeFile(path.join(root, 'local-app', 'context', 'versions', version, 'manifest.json'), JSON.stringify({ contextVersion: version }));
      }
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/plan')!, {
        direction: 'push', scope: { kind: 'app', projectId: 'local-app' },
      });
      expect(planned.status).toBe(200);
      const paths: string[] = planned.body.data.entries.map((entry: any) => entry.path);
      expect(paths.some((p) => p.startsWith('app/context/versions/v1/'))).toBe(true);
      expect(paths.some((p) => p.startsWith('app/context/versions/v3/'))).toBe(true);
      expect(paths.some((p) => p.startsWith('app/context/versions/v2/'))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a Push PLAN while a stage is queued/running but keeps STATUS readable', async () => {
    expect(runningStageIdsOf({ pipelines: { 'dr-review': { status: 'running' }, ux: { status: 'succeeded' }, 'ui-html': { status: 'queued' } } })).toEqual(['dr-review', 'ui-html']);
    expect(runningStageIdsOf(null)).toEqual([]);
    expect(runningStageIdsOf({ pipelines: [] })).toEqual([]);
    state.projects = [{
      id: 'local-feature', name: 'Checkout',
      metadata: {
        pipelines: { 'dr-review': { status: 'running' } },
        studioConfig: { appId: 'local-app', projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'feature--f', originAppId: 'app--x', mappedAt: 'now' } },
      },
    }];
    state.origins = [
      { projectId: 'app--x', name: 'X', isApp: true, inMedia: true, visibility: 'visible' },
      { projectId: 'feature--f', name: 'Checkout', isApp: false, appId: 'app--x', inMedia: true, visibility: 'visible' },
    ];
    state.mediaFiles = { 'app--x': [], 'feature--f': [] };
    const table = handlers();
    const planned = await call(table.get('POST /api/project-sync/plan')!, {
      direction: 'push', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' },
    });
    expect(planned.status).toBe(409);
    expect(planned.body.error.code).toBe('PROJECT_SYNC_STAGE_RUNNING');
    expect(planned.body.error.message).toContain('local-feature: dr-review');
    const pull = await call(table.get('POST /api/project-sync/plan')!, {
      direction: 'pull', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' },
    });
    expect(pull.status).toBe(200);
    const status = await call(table.get('POST /api/project-sync/status')!, { scopes: [{ kind: 'feature', projectId: 'local-feature', appId: 'local-app' }] });
    expect(status.status).toBe(200);
    expect(status.body.data.results[0].status).not.toBe('unavailable');
    expect(status.body.data.results[0].error).toBeUndefined();
  });

  it('never shares .od-skills or .tmp folders', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-walk-skip-'));
    try {
      state.projects = [{ id: 'local', name: 'Local', metadata: { studioConfig: {} } }];
      const dir = path.join(root, 'local');
      for (const rel of ['outputs/a.md', '.od-skills/SKILL.md', 'docs-review/.od-skills/SKILL.md', '.tmp/scratch.txt', '.odhistory/HEAD', 'node_modules/x/index.js']) {
        await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await fs.writeFile(path.join(dir, rel), rel);
      }
      const planned = await call(handlers(root).get('POST /api/project-sync/plan')!, {
        direction: 'push', scope: { kind: 'feature', projectId: 'local' }, origin: { mode: 'new', originId: 'feature--walk' },
      });
      expect(planned.status).toBe(200);
      const paths = planned.body.data.entries.map((entry: any) => entry.path);
      expect(paths).toContain('feature/outputs/a.md');
      expect(paths.filter((value: string) => value.includes('.od-skills') || value.includes('.tmp/') || value.includes('.odhistory') || value.includes('node_modules'))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fences .odhistory before an overwriting pull and records the pull afterwards', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-pull-history-fence-'));
    try {
      // Feature APPLY pull over an existing local folder.
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.projects = [{
        id: 'local-feature', name: 'Checkout',
        metadata: { studioConfig: { appId: 'local-app', projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'feature--f', originAppId: 'app--x', mappedAt: 'now' } } },
      }];
      state.origins = [
        { projectId: 'app--x', name: 'X', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature--f', name: 'Checkout', isApp: false, appId: 'app--x', inMedia: true, visibility: 'visible' },
      ];
      state.mediaFiles = { 'app--x': [], 'feature--f': [{ path: 'outputs/a.md', content: 'remote', checksum: createHash('sha256').update('remote').digest('hex') }] };
      await fs.mkdir(path.join(root, 'local-feature', 'outputs'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-feature', 'outputs', 'a.md'), 'local edit');
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/plan')!, { direction: 'pull', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' } });
      expect(planned.status).toBe(200);
      const applied = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
      expect(applied.status).toBe(200);
      expect(applied.body.data.stale).toEqual([]);
      expect(await fs.readFile(path.join(root, 'local-feature', 'outputs', 'a.md'), 'utf8')).toBe('remote');
      const featureCwd = path.join(root, 'local-feature');
      expect(state.history.filter((entry) => entry.cwd === featureCwd).map((entry) => entry.kind)).toEqual(['pre-pull', 'pull']);
      expect(state.history.find((entry) => entry.cwd === featureCwd && entry.kind === 'pull')?.input).toBe('feature--f');

      // Feature batch pull: create (no fence) then update (fence + pull), repo survives the swap.
      state.history = [];
      state.projects = [];
      state.origins = [
        { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature-a', name: 'Feature A', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
      ];
      state.mediaFiles = {
        'shared-app': [{ path: 'app.json', content: JSON.stringify({ name: 'Shared App' }) }],
        'feature-a': [
          { path: 'project.json', content: JSON.stringify({ name: 'Feature A', appId: 'shared-app' }) },
          { path: 'outputs/a.md', content: 'A' },
        ],
      };
      await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
      const batch = handlers(root);
      const created = await call(batch.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'], pullMode: 'work' });
      expect(created.body.data.features[0]).toMatchObject({ mode: 'create', localId: 'feature-a' });
      const createdOp = await call(batch.get('POST /api/project-sync/feature-pulls/operations')!, { planId: created.body.data.planId });
      const createdDone = await pollFeaturePullOperation(batch, createdOp.body.data.operationId);
      expect(createdDone.body.data.result.state).toBe('succeeded');
      const batchCwd = path.join(root, 'feature-a');
      expect(state.history.filter((entry) => entry.cwd === batchCwd).map((entry) => entry.kind)).toEqual(['pull']);

      state.history = [];
      state.mediaFiles['feature-a']![1] = { path: 'outputs/a.md', content: 'A2' };
      const updated = await call(batch.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'], pullMode: 'work' });
      expect(updated.body.data.features[0]).toMatchObject({ mode: 'update', localId: 'feature-a' });
      const updatedOp = await call(batch.get('POST /api/project-sync/feature-pulls/operations')!, { planId: updated.body.data.planId });
      const updatedDone = await pollFeaturePullOperation(batch, updatedOp.body.data.operationId);
      expect(updatedDone.body.data.result.state).toBe('succeeded');
      expect(state.history.filter((entry) => entry.cwd === batchCwd).map((entry) => entry.kind)).toEqual(['pre-pull', 'pull']);
      expect(await fs.readFile(path.join(batchCwd, 'outputs', 'a.md'), 'utf8')).toBe('A2');
      expect(await fs.readFile(path.join(batchCwd, '.odhistory', 'HEAD'), 'utf8')).toContain('refs/heads/main');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('self-heals a Feature origin re-parented to the local App id by a pre-fix push, but not one owned by another App', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-push-reparent-heal-'));
    try {
      const localFeature = () => ({
        id: 'local-feature', name: 'Checkout',
        metadata: { studioConfig: { appId: 'local-app', projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'feature--f', originAppId: 'app--x', mappedAt: 'now' } } },
      });
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.projects = [localFeature()];
      // Broken origin: project.json.appId on the store is the LOCAL App id.
      const brokenControl = JSON.stringify({ name: 'Checkout', appId: 'local-app' });
      state.origins = [
        { projectId: 'app--x', name: 'X', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature--f', name: 'Checkout', isApp: false, appId: 'local-app', inMedia: true, visibility: 'visible' },
      ];
      state.mediaFiles = { 'app--x': [], 'feature--f': [{ path: 'project.json', content: brokenControl, checksum: createHash('sha256').update(brokenControl).digest('hex') }] };
      await fs.mkdir(path.join(root, 'local-feature'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-feature', 'project.json'), `${JSON.stringify({ name: 'Checkout', appId: 'local-app' }, null, 2)}\n`);
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/plan')!, { direction: 'push', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' } });
      expect(planned.status).toBe(200);
      const applied = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
      expect(applied.status).toBe(200);
      expect(applied.body.data.stale).toEqual([]);
      const uploaded = state.uploads.find((item) => item.projectId === 'feature--f' && item.path === 'project.json');
      expect(JSON.parse(uploaded!.content.toString('utf8')).appId).toBe('app--x');
      // Pull is NOT relaxed: the broken origin still fails parent validation.
      const pull = await call(table.get('POST /api/project-sync/plan')!, { direction: 'pull', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' } });
      expect(pull.status).toBe(409);
      expect(pull.body.error.code).toBe('ORIGIN_MAPPING_INVALID');

      // Origin genuinely owned by another App: still refused.
      state.uploads = [];
      state.projects = [localFeature()];
      state.origins = [
        { projectId: 'app--x', name: 'X', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'app--other', name: 'Other', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature--f', name: 'Checkout', isApp: false, appId: 'app--other', inMedia: true, visibility: 'visible' },
      ];
      const otherControl = JSON.stringify({ name: 'Checkout', appId: 'app--other' });
      state.mediaFiles['feature--f'] = [{ path: 'project.json', content: otherControl, checksum: createHash('sha256').update(otherControl).digest('hex') }];
      const refused = await call(handlers(root).get('POST /api/project-sync/plan')!, { direction: 'push', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' } });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('ORIGIN_MAPPING_INVALID');
      expect(state.uploads).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps local-only files on a Feature batch update unless a pull resolution is explicit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-keep-local-'));
    try {
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.origins = [
        { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature-a', name: 'Feature A', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
      ];
      state.mediaFiles = {
        'shared-app': [{ path: 'app.json', content: JSON.stringify({ name: 'Shared App' }) }],
        'feature-a': [
          { path: 'project.json', content: JSON.stringify({ name: 'Feature A', appId: 'shared-app' }) },
          { path: 'outputs/a.md', content: 'A' },
        ],
      };
      await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
      const table = handlers(root);
      const created = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'], pullMode: 'work' });
      const createdOp = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: created.body.data.planId });
      expect((await pollFeaturePullOperation(table, createdOp.body.data.operationId)).body.data.result.state).toBe('succeeded');

      // Owner produces a local-only output (not pushed yet); colleague adds a new remote file.
      await fs.writeFile(path.join(root, 'feature-a', 'outputs', 'local-only.md'), 'mine');
      state.mediaFiles['feature-a']!.push({ path: 'outputs/new.md', content: 'theirs' });
      const updated = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'], pullMode: 'work' });
      expect(updated.body.data.features[0]).toMatchObject({ mode: 'update', localId: 'feature-a' });
      expect(updated.body.data.features[0].entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'feature/outputs/local-only.md', change: 'deleted', resolution: 'skip' }),
        expect.objectContaining({ path: 'feature/outputs/new.md', change: 'new', resolution: 'pull' }),
      ]));
      const updatedOp = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: updated.body.data.planId });
      expect(updatedOp.body.data.progress.totalItems).toBe(1);
      const done = await pollFeaturePullOperation(table, updatedOp.body.data.operationId);
      expect(done.body.data.result.items[0]).toMatchObject({ state: 'succeeded', result: { applied: 1 } });
      expect(await fs.readFile(path.join(root, 'feature-a', 'outputs', 'local-only.md'), 'utf8')).toBe('mine');
      expect(await fs.readFile(path.join(root, 'feature-a', 'outputs', 'new.md'), 'utf8')).toBe('theirs');
      expect(await fs.readFile(path.join(root, 'feature-a', 'outputs', 'a.md'), 'utf8')).toBe('A');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('plans a Feature batch from listing checksums — only project.json and ledgers are downloaded, Context listed once per version', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-listing-checksum-'));
    try {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex');
      const row = (path: string, content: string) => ({ path, content, checksum: sha(content) });
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.origins = [
        { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature-a', name: 'Feature A', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
        { projectId: 'feature-b', name: 'Feature B', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
      ];
      const control = (name: string) => JSON.stringify({ name, appId: 'shared-app', appContextBinding: { appId: 'shared-app', contextVersion: 'v1' } });
      const ledger = JSON.stringify({ version: 1, base: 'https://wiki.test', items: [{ name: 'a.png', sha256: sha('AAA'), size: 3, pageId: '100', spaceKey: 'S', attachment: 'a.png', attachmentVersion: 1, fetchedAt: 1 }] });
      state.mediaFiles = {
        'shared-app': [
          row('app.json', JSON.stringify({ name: 'Shared App' })),
          row('context/versions/v1/manifest.json', JSON.stringify({ contextVersion: 'v1', files: [{ path: 'brief.md' }] })),
          row('context/versions/v1/files/brief.md', 'shared context'),
          row('context/versions/v1/files/docs/attachments/_sources.json', ledger),
        ],
        'feature-a': [row('project.json', control('Feature A')), row('outputs/a.md', 'A')],
        'feature-b': [row('project.json', control('Feature B')), row('outputs/b.md', 'B'), row('outputs/attachments/_sources.json', ledger)],
      };
      await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a', 'feature-b'], pullMode: 'work' });
      expect(planned.status).toBe(200);
      // Ordinary files carry the LISTING checksum, without any download.
      expect(planned.body.data.features[0].entries.find((entry: any) => entry.path === 'feature/outputs/a.md')).toMatchObject({ change: 'new', origin: { checksum: sha('A') } });
      expect(planned.body.data.features[1].entries.find((entry: any) => entry.path === 'feature/outputs/attachments/_sources.json')).toMatchObject({ origin: { checksum: sha(ledger) }, confluenceGroup: { files: 1 } });
      // Only project.json + ledgers were downloaded — each exactly once (the
      // shared Context ledger once for BOTH features bound to v1).
      expect([...state.downloads].sort()).toEqual([
        'feature-a:project.json',
        'feature-b:outputs/attachments/_sources.json',
        'feature-b:project.json',
        'shared-app:context/versions/v1/files/docs/attachments/_sources.json',
      ]);
      // The origin App folder is listed once for the whole batch.
      expect(state.sessionOpens.filter((id) => id === 'shared-app')).toEqual(['shared-app']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to downloading a row whose listing has no checksum and still plans the right digest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-checksum-fallback-'));
    try {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex');
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.origins = [
        { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature-a', name: 'Feature A', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
      ];
      const control = JSON.stringify({ name: 'Feature A', appId: 'shared-app' });
      state.mediaFiles = {
        'shared-app': [{ path: 'app.json', content: '{}', checksum: sha('{}') }],
        'feature-a': [
          { path: 'project.json', content: control, checksum: sha(control) },
          { path: 'outputs/kept.md', content: 'KEPT', checksum: sha('KEPT') },
          { path: 'outputs/nochk.md', content: 'NOCHK' },
        ],
      };
      await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
      await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
      const table = handlers(root);
      const planned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'], pullMode: 'work' });
      expect(planned.status).toBe(200);
      expect(planned.body.data.features[0].entries.find((entry: any) => entry.path === 'feature/outputs/nochk.md')).toMatchObject({ change: 'new', origin: { checksum: sha('NOCHK') } });
      expect(state.downloads).toContain('feature-a:outputs/nochk.md');
      expect(state.downloads).not.toContain('feature-a:outputs/kept.md');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  describe('Confluence-backed attachments (ledger manifest)', () => {
    const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const WIKI = 'https://wiki.test';
    const ledgerItem = (name: string, content: string, pageId = '100', spaceKey = 'SMB') => ({ name, sha256: sha(content), size: content.length, pageId, spaceKey, attachment: name, attachmentVersion: 3, fetchedAt: 1 });
    const ledgerJson = (items: unknown[]) => JSON.stringify({ version: 1, base: WIKI, items }, null, 2);
    const mappedFeature = () => {
      state.projects = [{
        id: 'local-feature', name: 'Checkout',
        metadata: { studioConfig: { appId: 'local-app', projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'feature--f', originAppId: 'app--x', mappedAt: 'now' } } },
      }];
      state.origins = [
        { projectId: 'app--x', name: 'X', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature--f', name: 'Checkout', isApp: false, appId: 'app--x', inMedia: true, visibility: 'visible' },
      ];
    };
    const mediaRow = (path: string, content: string) => ({ path, content, checksum: sha(content) });
    /** Pinned URL carries `version=`; the fallback URL does not. */
    const wikiServer = (byName: Record<string, { pinned?: string | number; latest?: string | number }>) => (url: string) => {
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop()!);
      const pinned = url.includes('version=');
      const reply = byName[name]?.[pinned ? 'pinned' : 'latest'];
      if (reply === undefined) return new Response('', { status: 404 });
      return typeof reply === 'number' ? new Response('', { status: reply }) : new Response(reply, { status: 200 });
    };

    it('plans one group entry per ledger on push: matched files are neither read nor uploaded, the rest stay plain', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-confluence-push-'));
      const readSpy = vi.spyOn(fs, 'readFile');
      try {
        mappedFeature();
        const control = JSON.stringify({ name: 'Checkout', appId: 'app--x' });
        state.mediaFiles = { 'app--x': [], 'feature--f': [mediaRow('project.json', control)] };
        // WP hotfix-sync (2026-09): fixture moved off `docs-review/docs-feature/`
        // — that folder is now a deterministic pool copy excluded from sync
        // (see pipelines.ts's `dr-docs` syncExclude); this test only cares
        // about generic ledger/attachment grouping behavior, so any
        // non-excluded workflow-namespaced folder is equivalent.
        const dir = path.join(root, 'local-feature', 'docs-review', 'review', 'attachments');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(root, 'local-feature', 'project.json'), control);
        await fs.writeFile(path.join(dir, 'a.png'), 'AAA');      // listed, older than the ledger → matched by mtime, never read
        await fs.writeFile(path.join(dir, 'b.png'), 'BBB');      // unlisted → plain bytes
        await fs.writeFile(path.join(dir, 'c.png'), 'CCC');      // listed, NEWER than the ledger → matched by sha (read once)
        await fs.writeFile(path.join(dir, 'stale.png'), 'NEW');  // listed (same size), newer, sha differs → plain bytes
        await fs.writeFile(path.join(dir, 'short.png'), 'S');    // listed but size differs → plain bytes (no read)
        await fs.writeFile(path.join(dir, '_sources.json'), ledgerJson([ledgerItem('a.png', 'AAA'), ledgerItem('c.png', 'CCC'), ledgerItem('stale.png', 'OLD'), ledgerItem('short.png', 'SHORT')]));
        const future = new Date(Date.now() + 60_000);
        await fs.utimes(path.join(dir, 'c.png'), future, future);
        await fs.utimes(path.join(dir, 'stale.png'), future, future);
        await fs.utimes(path.join(dir, 'short.png'), future, future);
        const table = handlers(root);
        readSpy.mockClear();
        const planned = await call(table.get('POST /api/project-sync/plan')!, { direction: 'push', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' } });
        expect(planned.status).toBe(200);
        const entry = (rel: string) => planned.body.data.entries.find((row: any) => row.path === `feature/docs-review/review/attachments/${rel}`);
        expect(entry('_sources.json')).toMatchObject({ change: 'new', kind: 'output', confluenceGroup: { files: 2, bytes: 6, missing: 0 } });
        expect(entry('_sources.json').confluence).toBeUndefined();
        expect(entry('a.png')).toBeUndefined();
        expect(entry('c.png')).toBeUndefined();
        expect(entry('b.png')).toMatchObject({ change: 'new' });
        expect(entry('stale.png')).toMatchObject({ change: 'new' });
        expect(entry('short.png')).toMatchObject({ change: 'new' });
        expect(planned.body.data.entries.some((row: any) => row.confluence)).toBe(false);
        expect(planned.body.data.summary).toEqual({ created: 4, unchanged: 0, changed: 1, deleted: 0, confluence: { files: 2, bytes: 6 } }); // changed = normalized project.json
        // Lazy walk: a.png (mtime rule) is never opened; c.png is read exactly once (sha rule).
        const read = readSpy.mock.calls.map((args) => String(args[0])).filter((file) => file.startsWith(dir)).map((file) => path.basename(file));
        expect(read).not.toContain('a.png');
        expect(read.filter((name) => name === 'c.png')).toHaveLength(1);

        const applied = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
        expect(applied.status).toBe(200);
        expect(applied.body.data).toMatchObject({ stale: [], manifested: 2, applied: 5 }); // project.json (normalized) + ledger + b + stale + short
        expect(applied.body.data.confluence).toBeUndefined();
        const uploaded = state.uploads.filter((item) => item.projectId === 'feature--f').map((item) => item.path).sort();
        expect(uploaded).toEqual(['docs-review/review/attachments/_sources.json', 'docs-review/review/attachments/b.png', 'docs-review/review/attachments/short.png', 'docs-review/review/attachments/stale.png', 'project.json']);

        // Origin now lists the ledger (never a.png / c.png): the re-plan is fully unchanged and still has no per-file entry.
        state.mediaFiles['feature--f'] = [mediaRow('project.json', control), ...state.uploads.filter((item) => item.projectId === 'feature--f').map((item) => mediaRow(item.path, item.content.toString('utf8')))];
        state.uploads = [];
        const replanned = await call(table.get('POST /api/project-sync/plan')!, { direction: 'push', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' } });
        expect(replanned.body.data.entries.find((row: any) => row.path === 'feature/docs-review/review/attachments/_sources.json')).toMatchObject({ change: 'unchanged', confluenceGroup: { files: 2, bytes: 6, missing: 0 } });
        expect(replanned.body.data.entries.some((row: any) => /\/(a|c)\.png$/.test(row.path))).toBe(false);
        expect(replanned.body.data.summary).toEqual({ created: 0, unchanged: 5, changed: 0, deleted: 0, confluence: { files: 2, bytes: 6 } });
        const status = await call(table.get('POST /api/project-sync/status')!, { scopes: [{ kind: 'feature', projectId: 'local-feature', appId: 'local-app' }] });
        expect(status.body.data.results[0].state).toBe('unchanged');
        expect(status.body.data.results[0].entries.filter((row: any) => row.change !== 'unchanged')).toEqual([]);
      } finally {
        readSpy.mockRestore();
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('expands a pulled ledger group file by file: only absent items hit the wiki, progress counts every file', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-confluence-pull-'));
      try {
        mappedFeature();
        // Already in the normalized form so project.json diffs as unchanged.
        const control = `${JSON.stringify({ name: 'Checkout', appId: 'app--x' }, null, 2)}\n`;
        const ledger = ledgerJson([ledgerItem('a.png', 'AAA'), ledgerItem('c.png', 'CCC'), ledgerItem('d.png', 'DDD'), ledgerItem('e.png', 'EEE', '200', 'OPS')]);
        state.mediaFiles = { 'app--x': [], 'feature--f': [mediaRow('project.json', control), mediaRow('docs/attachments/_sources.json', ledger)] };
        const attachments = path.join(root, 'local-feature', 'docs', 'attachments');
        await fs.mkdir(attachments, { recursive: true });
        await fs.writeFile(path.join(root, 'local-feature', 'project.json'), control);
        await fs.writeFile(path.join(attachments, 'a.png'), 'AAA');       // already here (size matches) → skipped
        await fs.writeFile(path.join(attachments, '_sources.json'), ledger); // identical ledger — still actionable because files are missing
        const table = handlers(root);
        const planned = await call(table.get('POST /api/project-sync/plan')!, { direction: 'pull', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' } });
        expect(planned.status).toBe(200);
        const entries = planned.body.data.entries;
        expect(entries.map((row: any) => row.path)).toEqual(['feature/docs/attachments/_sources.json', 'feature/project.json']);
        expect(entries[0]).toMatchObject({ change: 'changed', resolution: 'pull', confluenceGroup: { files: 4, bytes: 12, missing: 3 }, local: { checksum: sha(ledger) }, origin: { checksum: sha(ledger) } });
        expect(planned.body.data.summary).toEqual({ created: 0, unchanged: 1, changed: 1, deleted: 0, confluence: { files: 4, bytes: 12 } });
        expect(state.downloads.filter((value) => value.startsWith('feature--f:docs/attachments/') && !value.endsWith('_sources.json'))).toEqual([]);

        state.confluenceCreds = { base: WIKI, token: 'pat' };
        state.confluenceFetch = wikiServer({
          'a.png': { pinned: 'AAA' },
          'c.png': { pinned: 'XXX', latest: 'CCC' },
          'd.png': { pinned: 'XXX', latest: 'YYY' },
          'e.png': { pinned: 404, latest: 404 },
        });
        const started = await call(table.get('POST /api/project-sync/operations')!, { planId: planned.body.data.planId });
        expect(started.status).toBe(202);
        expect(started.body.data.progress.totalItems).toBe(5); // 1 ledger entry + 4 wiki files
        const completed = await pollOperationSlow(table, started.body.data.operationId);
        expect(completed.body.data).toMatchObject({ state: 'succeeded', progress: { completedItems: 5, totalItems: 5, percent: 100 } });
        const result = completed.body.data.result;
        expect(result.stale).toEqual([]);
        expect(result.confluence).toEqual({
          fetched: 2,
          drifted: [{ path: 'feature/docs/attachments/d.png', reason: expect.stringContaining('v3') }],
          missing: [{ path: 'feature/docs/attachments/e.png', reason: 'HTTP 404' }],
        });
        expect(result.applied).toBe(3); // ledger + 2 fetched files (a.png skipped, e.png missing)
        // a.png was already present: never requested from the wiki.
        expect(state.confluenceRequests.some((url) => url.includes('/a.png'))).toBe(false);
        expect(state.confluenceRequests.every((url) => url.startsWith(`${WIKI}/download/attachments/`))).toBe(true);
        expect(await fs.readFile(path.join(attachments, 'a.png'), 'utf8')).toBe('AAA');
        expect(await fs.readFile(path.join(attachments, 'c.png'), 'utf8')).toBe('CCC');
        expect(await fs.readFile(path.join(attachments, 'd.png'), 'utf8')).toBe('YYY');
        expect(await fs.stat(path.join(attachments, 'e.png')).catch(() => null)).toBeNull();
        expect(await fs.readFile(path.join(attachments, '_sources.json'), 'utf8')).toBe(ledger);
        // The (partial) wiki outcome never counts as stale → the mapping still persists.
        expect(state.projects[0].metadata.studioConfig.projectSyncMapping).toMatchObject({ originId: 'feature--f' });
        expect(state.uploads).toEqual([]);

        // Re-plan: c.png / d.png now exist, e.png is still missing → the ledger stays actionable with missing = 1.
        const replanned = await call(table.get('POST /api/project-sync/plan')!, { direction: 'pull', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' } });
        expect(replanned.body.data.entries[0]).toMatchObject({ path: 'feature/docs/attachments/_sources.json', change: 'changed', confluenceGroup: { files: 4, bytes: 12, missing: 1 } });
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => fs.rm(root, { recursive: true, force: true }));
      }
    });

    it('marks every wiki file missing (never stale) when this machine has no PAT', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-confluence-pull-nopat-'));
      try {
        mappedFeature();
        const control = JSON.stringify({ name: 'Checkout', appId: 'app--x' });
        state.mediaFiles = { 'app--x': [], 'feature--f': [mediaRow('project.json', control), mediaRow('docs/attachments/_sources.json', ledgerJson([ledgerItem('a.png', 'AAA')]))] };
        await fs.mkdir(path.join(root, 'local-feature'), { recursive: true });
        await fs.writeFile(path.join(root, 'local-feature', 'project.json'), control);
        const table = handlers(root);
        const planned = await call(table.get('POST /api/project-sync/plan')!, { direction: 'pull', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' } });
        const applied = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
        expect(applied.body.data).toMatchObject({ stale: [], confluence: { fetched: 0, drifted: [], missing: [{ path: 'feature/docs/attachments/a.png', reason: 'Chưa cấu hình PAT Confluence' }] } });
        expect(state.confluenceRequests).toEqual([]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('preflights PAT, base, and per-space access for a Pull plan', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-confluence-preflight-'));
      try {
        mappedFeature();
        const control = JSON.stringify({ name: 'Checkout', appId: 'app--x' });
        state.mediaFiles = { 'app--x': [], 'feature--f': [mediaRow('project.json', control), mediaRow('docs/attachments/_sources.json', ledgerJson([ledgerItem('a.png', 'AAA'), ledgerItem('b.png', 'BBB'), ledgerItem('e.png', 'EEE', '200', 'OPS')]))] };
        await fs.mkdir(path.join(root, 'local-feature'), { recursive: true });
        await fs.writeFile(path.join(root, 'local-feature', 'project.json'), control);
        const table = handlers(root);
        const preflight = table.get('POST /api/project-sync/confluence-preflight')!;
        expect((await call(preflight, {})).status).toBe(400);
        expect((await call(preflight, { planId: 'a', batchPlanId: 'b' })).status).toBe(400);
        const expired = await call(preflight, { planId: 'gone' });
        expect(expired.status).toBe(404); expect(expired.body.error.code).toBe('PLAN_EXPIRED');

        const planned = await call(table.get('POST /api/project-sync/plan')!, { direction: 'pull', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' } });
        const planId = planned.body.data.planId;
        const missing = await call(preflight, { planId });
        expect(missing.status).toBe(200);
        expect(missing.body.data).toMatchObject({ required: true, files: 3, bytes: 9, base: WIKI, credsBase: null, baseMatches: false, token: 'missing', ok: false });
        expect(missing.body.data.spaces).toEqual([
          { key: 'SMB', samplePageId: '100', ok: false, status: null, files: 2 },
          { key: 'OPS', samplePageId: '200', ok: false, status: null, files: 1 },
        ]);

        state.confluenceCreds = { base: WIKI, token: 'pat' };
        state.confluenceFetch = () => new Response('', { status: 401 });
        expect((await call(preflight, { planId })).body.data).toMatchObject({ token: 'invalid', baseMatches: true, ok: false });

        state.confluenceFetch = (url) => url.endsWith('/rest/api/user/current')
          ? new Response(JSON.stringify({ displayName: 'Anh' }), { status: 200 })
          : new Response('', { status: url.endsWith('/rest/api/content/200') ? 404 : 200 });
        const partial = await call(preflight, { planId });
        expect(partial.body.data).toMatchObject({ token: 'ok', displayName: 'Anh', ok: false });
        expect(partial.body.data.spaces).toEqual([
          { key: 'SMB', samplePageId: '100', ok: true, status: 200, files: 2 },
          { key: 'OPS', samplePageId: '200', ok: false, status: 404, files: 1 },
        ]);

        state.confluenceFetch = () => new Response('{}', { status: 200 });
        expect((await call(preflight, { planId })).body.data).toMatchObject({ token: 'ok', ok: true });

        state.confluenceCreds = { base: 'https://other.test', token: 'pat' };
        expect((await call(preflight, { planId })).body.data).toMatchObject({ baseMatches: false, credsBase: 'https://other.test', ok: false });

        // A plan without Confluence entries is trivially ok — and resolutions=skip drop entries.
        state.mediaFiles['feature--f'] = [mediaRow('project.json', control)];
        const plain = await call(table.get('POST /api/project-sync/plan')!, { direction: 'pull', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' } });
        expect((await call(preflight, { planId: plain.body.data.planId })).body.data).toMatchObject({ required: false, files: 0, ok: true });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('pulls a Feature batch whose Feature and bound Context ledgers expand from the wiki', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-confluence-batch-'));
      try {
        state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
        state.origins = [
          { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
          { projectId: 'feature-a', name: 'Feature A', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
        ];
        const featureControl = JSON.stringify({ name: 'Feature A', appId: 'shared-app', appContextBinding: { appId: 'shared-app', contextVersion: 'v1' } });
        const featureLedger = ledgerJson([ledgerItem('a.png', 'AAA'), ledgerItem('gone.png', 'GONE')]);
        state.mediaFiles = {
          'shared-app': [
            mediaRow('app.json', JSON.stringify({ name: 'Shared App' })),
            mediaRow('context/versions/v1/manifest.json', JSON.stringify({ contextVersion: 'v1', files: [{ path: 'brief.md' }] })),
            mediaRow('context/versions/v1/files/brief.md', 'shared context'),
            mediaRow('context/versions/v1/files/docs/attachments/_sources.json', ledgerJson([ledgerItem('ctx.png', 'CTX')])),
            mediaRow('context/versions/v2/files/docs/attachments/_sources.json', ledgerJson([ledgerItem('v2.png', 'V2')])),
          ],
          'feature-a': [
            mediaRow('project.json', featureControl),
            mediaRow('outputs/a.md', 'A'),
            mediaRow('outputs/attachments/_sources.json', featureLedger),
          ],
        };
        await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
        await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
        const table = handlers(root);
        const planned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'], pullMode: 'work' });
        expect(planned.status).toBe(200);
        const entries = planned.body.data.features[0].entries;
        expect(entries.find((row: any) => row.path === 'feature/outputs/attachments/_sources.json')).toMatchObject({ change: 'new', confluenceGroup: { files: 2, bytes: 7, missing: 2 }, origin: { checksum: sha(featureLedger) } });
        expect(entries.find((row: any) => row.path === 'bound-context/feature-a/context/versions/v1/files/docs/attachments/_sources.json')).toMatchObject({ change: 'new', confluenceGroup: { files: 1, bytes: 3, missing: 1 } });
        expect(entries.some((row: any) => row.confluence || /\.png$/.test(row.path))).toBe(false);
        expect(entries.some((row: any) => row.path.includes('/v2/'))).toBe(false);
        expect(planned.body.data.features[0].summary.confluence).toEqual({ files: 3, bytes: 10 });
        const actionable = entries.filter((row: any) => row.change !== 'unchanged' && row.resolution === 'pull');
        expect(planned.body.data.totalItems).toBe(actionable.length + 3);
        // PLAN never downloads ledger-listed attachments from media.
        expect(state.downloads.filter((value) => /attachments\/(a|gone|ctx)\.png$/.test(value))).toEqual([]);

        const batchPreflight = await call(table.get('POST /api/project-sync/confluence-preflight')!, { batchPlanId: planned.body.data.planId });
        expect(batchPreflight.body.data).toMatchObject({ required: true, files: 3, bytes: 10, token: 'missing', ok: false });

        state.confluenceCreds = { base: WIKI, token: 'pat' };
        state.confluenceFetch = wikiServer({ 'a.png': { pinned: 'AAA' }, 'ctx.png': { pinned: 'CTX' }, 'gone.png': { pinned: 404, latest: 404 } });
        const started = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: planned.body.data.planId });
        expect(started.body.data.progress.totalItems).toBe(actionable.length + 3);
        const completed = await pollFeaturePullOperation(table, started.body.data.operationId);
        expect(completed.body.data).toMatchObject({ state: 'succeeded', progress: { completedItems: actionable.length + 3, percent: 100 }, result: { state: 'succeeded' } });
        expect(completed.body.data.result.items[0].result).toMatchObject({
          stale: [],
          applied: actionable.length + 2,
          confluence: { fetched: 2, drifted: [], missing: [{ path: 'feature/outputs/attachments/gone.png', reason: 'HTTP 404' }] },
        });
        expect(await fs.readFile(path.join(root, 'feature-a', 'outputs', 'attachments', 'a.png'), 'utf8')).toBe('AAA');
        expect(await fs.readFile(path.join(root, 'feature-a', 'outputs', 'attachments', '_sources.json'), 'utf8')).toBe(featureLedger);
        expect(await fs.stat(path.join(root, 'feature-a', 'outputs', 'attachments', 'gone.png')).catch(() => null)).toBeNull();
        expect(await fs.readFile(path.join(root, 'feature-a', 'outputs', 'a.md'), 'utf8')).toBe('A');
        expect(await fs.readFile(path.join(root, 'local-app', 'context', 'versions', 'v1', 'files', 'docs', 'attachments', 'ctx.png'), 'utf8')).toBe('CTX');
        expect(await fs.readFile(path.join(root, 'local-app', 'context', 'versions', 'v1', 'files', 'brief.md'), 'utf8')).toBe('shared context');
        expect(state.projects[0].metadata.studioConfig.projectSyncMapping).toMatchObject({ originId: 'feature-a', originAppId: 'shared-app' });

        // Second batch PLAN for the now-mapped Feature: a.png matches its ledger (no entry, not read),
        // gone.png is still missing → the ledger remains actionable; ctx.png is present → bound Context ledger unchanged.
        state.confluenceRequests = [];
        const replanned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'], pullMode: 'work' });
        expect(replanned.status).toBe(200);
        const again = replanned.body.data.features[0].entries;
        expect(replanned.body.data.features[0].mode).toBe('update');
        expect(again.find((row: any) => row.path === 'feature/outputs/attachments/_sources.json')).toMatchObject({ change: 'changed', confluenceGroup: { files: 2, missing: 1 } });
        expect(again.find((row: any) => row.path === 'bound-context/feature-a/context/versions/v1/files/docs/attachments/_sources.json')).toMatchObject({ change: 'unchanged', confluenceGroup: { files: 1, missing: 0 } });
        expect(again.some((row: any) => /\.png$/.test(row.path))).toBe(false);
        const restarted = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: replanned.body.data.planId });
        const redone = await pollFeaturePullOperation(table, restarted.body.data.operationId);
        expect(redone.body.data).toMatchObject({ state: 'succeeded', result: { state: 'succeeded' } });
        // a.png was already staged from the local copy → skipped, only gone.png is retried.
        expect(state.confluenceRequests.some((url) => url.includes('/a.png'))).toBe(false);
        expect(state.confluenceRequests.filter((url) => url.includes('/gone.png')).length).toBeGreaterThan(0);
        expect(redone.body.data.result.items[0].result.confluence).toEqual({ fetched: 0, drifted: [], missing: [{ path: 'feature/outputs/attachments/gone.png', reason: 'HTTP 404' }] });
        expect(await fs.readFile(path.join(root, 'feature-a', 'outputs', 'attachments', 'a.png'), 'utf8')).toBe('AAA');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('pull view mode', () => {
    async function seedAppContext(seed: string) {
      const { createAppContextVersion } = await import('../src/app-context-version.js');
      await fs.mkdir(path.join(seed, 'shared-app', 'docs', 'guide'), { recursive: true });
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', '_manifest.json'), JSON.stringify({ version: 1, pages: [] }));
      await fs.writeFile(path.join(seed, 'shared-app', 'docs', 'guide', 'page.md'), '# Trang 1\n');
      const result = await createAppContextVersion({ projectsDir: seed, appId: 'shared-app', appName: 'Shared App', designSystemId: null });
      const manifest = (result as { manifest: { contextVersion: string; contentDigest: string } }).manifest;
      const packaged: Array<{ path: string; checksum: string; content: Buffer }> = [];
      const walk = async (dir: string, rel: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
          else {
            const content = await fs.readFile(path.join(dir, entry.name));
            packaged.push({ path: childRel, checksum: createHash('sha256').update(content).digest('hex'), content });
          }
        }
      };
      await walk(path.join(seed, 'shared-app', 'context'), 'context');
      return { manifest, packaged };
    }

    it('Feature pull in view mode transfers only the Feature outputs and never touches the App context', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-view-'));
      const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-view-seed-'));
      try {
        const { manifest, packaged } = await seedAppContext(seed);
        state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
        state.origins = [
          { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
          { projectId: 'shared-feature', name: 'Checkout', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
        ];
        const featureControl = JSON.stringify({
          name: 'Checkout', appId: 'shared-app',
          appContextBinding: { appId: 'shared-app', contextVersion: manifest.contextVersion, contentDigest: manifest.contentDigest },
          appPool: { appId: 'shared-app', paths: ['guide/page.md'] },
        });
        state.mediaFiles = {
          'shared-app': [{ path: 'app.json', content: JSON.stringify({ name: 'Shared App' }) }, ...packaged],
          'shared-feature': [{ path: 'project.json', content: featureControl }, { path: 'outputs/spec.md', content: 'ok' }],
        };
        await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
        await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
        const table = handlers(root);
        const planned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {
          localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['shared-feature'],
        });
        expect(planned.status).toBe(200);
        expect(planned.body.data.pullMode).toBe('view');
        expect(planned.body.data.features[0].entries.some((entry: any) => entry.path.startsWith('bound-context/'))).toBe(false);
        expect(state.sessionOpens.includes('shared-app')).toBe(false);

        const started = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: planned.body.data.planId });
        const done = await pollFeaturePullOperation(table, started.body.data.operationId);
        expect(done.body.data.result).toMatchObject({ state: 'succeeded' });

        const localId = state.projects[0]!.id as string;
        expect(await fs.readFile(path.join(root, localId, 'outputs', 'spec.md'), 'utf8')).toBe('ok');
        expect(await fs.readFile(path.join(root, localId, 'docs-review', 'docs-feature', 'guide', 'page.md'), 'utf8')).toBe('# Trang 1\n');
        await expect(fs.stat(path.join(root, 'local-app', 'context', 'versions', manifest.contextVersion))).rejects.toMatchObject({ code: 'ENOENT' });
        expect((state.projects[0]!.metadata as { appContextBinding?: unknown }).appContextBinding).toBeUndefined();
        expect((state.projects[0]!.metadata as { runAllConfig?: { appPool?: unknown } }).runAllConfig?.appPool).toBeUndefined();
        expect((state.projects[0]!.metadata as any).studioConfig.projectSyncMapping.pullMode).toBe('view');
        // amend_view_mode_no_listing: even the ticked-page fetch (the trang
        // tick loop) must resolve the App's docs page via findFileByPath +
        // downloadById — never opening/listing the origin App's folder. The
        // Feature's own origin folder IS listed/opened (it isn't the App).
        expect(state.sessionOpens).not.toContain('shared-app');
        expect(state.listCalls).not.toContain('shared-app');
        expect(state.sessionOpens).toContain('shared-feature');

        const status = await call(table.get('POST /api/project-sync/status')!, {
          scopes: [{ kind: 'feature', projectId: localId, appId: 'local-app' }],
        });
        expect(status.body.data.results[0]).toMatchObject({ status: 'up_to_date', pullMode: 'view' });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(seed, { recursive: true, force: true });
      }
    });

    it('Feature pull in work mode keeps the 0.8.171 behaviour and marks the mapping work', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-work-'));
      const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-work-seed-'));
      try {
        const { manifest, packaged } = await seedAppContext(seed);
        state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
        state.origins = [
          { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
          { projectId: 'shared-feature', name: 'Checkout', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
        ];
        const featureControl = JSON.stringify({
          name: 'Checkout', appId: 'shared-app',
          appContextBinding: { appId: 'shared-app', contextVersion: manifest.contextVersion, contentDigest: manifest.contentDigest },
          appPool: { appId: 'shared-app', paths: ['guide/page.md'] },
        });
        state.mediaFiles = {
          'shared-app': [{ path: 'app.json', content: JSON.stringify({ name: 'Shared App' }) }, ...packaged],
          'shared-feature': [{ path: 'project.json', content: featureControl }, { path: 'outputs/spec.md', content: 'ok' }],
        };
        await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
        await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app' }));
        const table = handlers(root);
        const planned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {
          localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['shared-feature'], pullMode: 'work',
        });
        expect(planned.status).toBe(200);
        expect(planned.body.data.pullMode).toBe('work');
        const started = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: planned.body.data.planId });
        const done = await pollFeaturePullOperation(table, started.body.data.operationId);
        expect(done.body.data.result).toMatchObject({ state: 'succeeded' });

        const localId = state.projects[0]!.id as string;
        expect(await fs.readFile(path.join(root, 'local-app', 'context', 'versions', manifest.contextVersion, 'files', 'docs', 'guide', 'page.md'), 'utf8')).toBe('# Trang 1\n');
        const dr = path.join(root, localId, 'docs-review');
        expect(await fs.readFile(path.join(dr, 'docs-feature', 'guide', 'page.md'), 'utf8')).toBe('# Trang 1\n');
        expect(await fs.readFile(path.join(dr, 'docs-app', 'guide', 'page.md'), 'utf8')).toBe('# Trang 1\n');
        expect((state.projects[0]!.metadata as any).appContextBinding).toMatchObject({ appId: 'local-app', contextVersion: manifest.contextVersion });
        expect((state.projects[0]!.metadata as any).runAllConfig.appPool).toEqual({ appId: 'local-app', paths: ['guide/page.md'] });
        expect((state.projects[0]!.metadata as any).studioConfig.projectSyncMapping.pullMode).toBe('work');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(seed, { recursive: true, force: true });
      }
    });

    it('refuses a Push PLAN for a view-only Feature and App but keeps PULL/STATUS working', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-view-only-push-'));
      try {
        state.projects = [{
          id: 'local-feature', name: 'Checkout',
          metadata: {
            studioConfig: { appId: 'local-app', projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'feature--f', originAppId: 'app--x', mappedAt: 'now', pullMode: 'view' } },
          },
        }];
        state.origins = [
          { projectId: 'app--x', name: 'X', isApp: true, inMedia: true, visibility: 'visible' },
          { projectId: 'feature--f', name: 'Checkout', isApp: false, appId: 'app--x', inMedia: true, visibility: 'visible' },
        ];
        state.mediaFiles = { 'app--x': [], 'feature--f': [] };
        const table = handlers(root);
        const featurePush = await call(table.get('POST /api/project-sync/plan')!, {
          direction: 'push', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' },
        });
        expect(featurePush.status).toBe(409);
        expect(featurePush.body.error.code).toBe('PROJECT_SYNC_VIEW_ONLY');

        state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
        await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
        await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'app--x', pullMode: 'view' }));
        const appPush = await call(table.get('POST /api/project-sync/plan')!, {
          direction: 'push', scope: { kind: 'app', projectId: 'local-app' },
        });
        expect(appPush.status).toBe(409);
        expect(appPush.body.error.code).toBe('PROJECT_SYNC_VIEW_ONLY');

        const pull = await call(table.get('POST /api/project-sync/plan')!, {
          direction: 'pull', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' },
        });
        expect(pull.status).toBe(200);

        const status = await call(table.get('POST /api/project-sync/status')!, { scopes: [{ kind: 'feature', projectId: 'local-feature', appId: 'local-app' }] });
        expect(status.status).toBe(200);
        expect(status.body.data.results[0].status).not.toBe('unavailable');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('mapping without pullMode still pushes', async () => {
      state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
      state.projects = [{
        id: 'local-feature', name: 'Checkout',
        metadata: { studioConfig: { appId: 'local-app', projectSyncMapping: { schemaVersion: 1, localId: 'local-feature', originId: 'feature--f', originAppId: 'app--x', mappedAt: 'now' } } },
      }];
      state.origins = [
        { projectId: 'app--x', name: 'X', isApp: true, inMedia: true, visibility: 'visible' },
        { projectId: 'feature--f', name: 'Checkout', isApp: false, appId: 'app--x', inMedia: true, visibility: 'visible' },
      ];
      state.mediaFiles = { 'app--x': [], 'feature--f': [] };
      const push = await call(handlers().get('POST /api/project-sync/plan')!, {
        direction: 'push', scope: { kind: 'feature', projectId: 'local-feature', appId: 'local-app' },
      });
      expect(push.status).toBe(200);
    });

    it('App pull in view mode installs only app.json, the pipeline_apps row and a view mapping', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-app-pull-view-'));
      try {
        state.origins = [{ projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' }];
        state.mediaFiles = { 'shared-app': [
          { path: 'app.json', content: JSON.stringify({ kind: 'app', name: 'Shared App' }) },
          { path: 'context/current.json', content: JSON.stringify({ schemaVersion: 1, appId: 'shared-app', contextVersion: 'v1' }) },
          { path: 'context/versions/v1/manifest.json', content: '{"contextVersion":"v1"}' },
          { path: 'context/versions/v1/files/app-context/x.md', content: 'hello' },
        ] };
        const table = handlers(root);
        const planned = await call(table.get('POST /api/project-sync/plan')!, {
          direction: 'pull', scope: { kind: 'app', projectId: 'local-app' }, origin: { mode: 'existing', originId: 'shared-app' },
        });
        expect(planned.status).toBe(200);
        expect(planned.body.data.pullMode).toBe('view');
        expect(planned.body.data.entries.map((entry: any) => entry.path)).toEqual(['app/app.json']);
        // View mode must never pull the full remote listing — with a large
        // Context history this is thousands of rows just to filter one file.
        // downloadFile()/openFolderSession() both list-then-serve internally,
        // so PLAN must resolve app.json via findFileByPath (no listing) and
        // never open a MediaFolderSession on the App's origin at all.
        expect(state.listCalls).not.toContain('shared-app');
        expect(state.sessionOpens).not.toContain('shared-app');

        const applied = await call(table.get('POST /api/project-sync/apply')!, { planId: planned.body.data.planId });
        expect(applied.status).toBe(200);
        expect(applied.body.data.stale).toEqual([]);
        expect(state.pipelineApps).toHaveLength(1);
        expect(JSON.parse(await fs.readFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), 'utf8'))).toMatchObject({ pullMode: 'view' });
        await expect(fs.stat(path.join(root, 'local-app', 'context'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(state.listCalls).not.toContain('shared-app');
        expect(state.sessionOpens).not.toContain('shared-app');

        const status = await call(table.get('POST /api/project-sync/status')!, { scopes: [{ kind: 'app', projectId: 'local-app' }] });
        expect(status.body.data.results[0]).toMatchObject({ status: 'up_to_date', pullMode: 'view' });
        expect(state.listCalls).not.toContain('shared-app');
        expect(state.sessionOpens).not.toContain('shared-app');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('refuses a work Feature pull under a view-only App', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-app-view-only-'));
      try {
        state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
        state.origins = [
          { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
          { projectId: 'shared-feature', name: 'Checkout', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
        ];
        state.mediaFiles = {
          'shared-app': [{ path: 'app.json', content: JSON.stringify({ name: 'Shared App' }) }],
          'shared-feature': [{ path: 'project.json', content: JSON.stringify({ name: 'Checkout', appId: 'shared-app' }) }],
        };
        await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
        await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app', pullMode: 'view' }));
        const table = handlers(root);
        const workPlan = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {
          localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['shared-feature'], pullMode: 'work',
        });
        expect(workPlan.status).toBe(409);
        expect(workPlan.body.error.code).toBe('FEATURE_PULL_APP_VIEW_ONLY');

        const viewPlan = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {
          localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['shared-feature'],
        });
        expect(viewPlan.status).toBe(200);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('upgrading a view Feature to work installs the Context and rewrites the mapping', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-upgrade-'));
      const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'od-feature-pull-upgrade-seed-'));
      try {
        const { manifest, packaged } = await seedAppContext(seed);
        state.pipelineApps = [{ id: 'local-app', name: 'Local App' }];
        state.origins = [
          { projectId: 'shared-app', name: 'Shared App', isApp: true, inMedia: true, visibility: 'visible' },
          { projectId: 'shared-feature', name: 'Checkout', isApp: false, appId: 'shared-app', inMedia: true, visibility: 'visible' },
        ];
        const featureControl = JSON.stringify({
          name: 'Checkout', appId: 'shared-app',
          appContextBinding: { appId: 'shared-app', contextVersion: manifest.contextVersion, contentDigest: manifest.contentDigest },
          appPool: { appId: 'shared-app', paths: ['guide/page.md'] },
        });
        state.mediaFiles = {
          'shared-app': [{ path: 'app.json', content: JSON.stringify({ name: 'Shared App' }) }, ...packaged],
          'shared-feature': [{ path: 'project.json', content: featureControl }, { path: 'outputs/spec.md', content: 'ok' }],
        };
        await fs.mkdir(path.join(root, 'local-app', '_studio'), { recursive: true });
        await fs.writeFile(path.join(root, 'local-app', '_studio', 'project-sync-mapping.json'), JSON.stringify({ schemaVersion: 1, localId: 'local-app', originId: 'shared-app', pullMode: 'work' }));
        const table = handlers(root);

        const viewPlanned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {
          localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['shared-feature'],
        });
        expect(viewPlanned.status).toBe(200);
        const viewStarted = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: viewPlanned.body.data.planId });
        await pollFeaturePullOperation(table, viewStarted.body.data.operationId);
        expect((state.projects[0]!.metadata as any).studioConfig.projectSyncMapping.pullMode).toBe('view');
        await expect(fs.stat(path.join(root, 'local-app', 'context', 'versions', manifest.contextVersion))).rejects.toMatchObject({ code: 'ENOENT' });

        const workPlanned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {
          localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['shared-feature'], pullMode: 'work',
        });
        expect(workPlanned.status).toBe(200);
        expect(workPlanned.body.data.features[0].mode).toBe('update');
        const workStarted = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: workPlanned.body.data.planId });
        const workDone = await pollFeaturePullOperation(table, workStarted.body.data.operationId);
        expect(workDone.body.data.result).toMatchObject({ state: 'succeeded' });

        expect(await fs.readFile(path.join(root, 'local-app', 'context', 'versions', manifest.contextVersion, 'files', 'docs', 'guide', 'page.md'), 'utf8')).toBe('# Trang 1\n');
        expect((state.projects[0]!.metadata as any).appContextBinding).toMatchObject({ appId: 'local-app', contextVersion: manifest.contextVersion });
        expect((state.projects[0]!.metadata as any).studioConfig.projectSyncMapping.pullMode).toBe('work');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(seed, { recursive: true, force: true });
      }
    });
  });
});
