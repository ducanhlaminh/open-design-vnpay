import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({
  projects: [] as any[],
  origins: [] as any[],
  mediaFiles: {} as Record<string, any[]>,
  uploads: [] as Array<{ projectId: string; path: string; content: Buffer }>,
  appUpserts: [] as Array<{ id: string; name: string }>,
  pipelineApps: [] as Array<{ id: string; name: string }>,
  failDownloads: new Set<string>(),
  downloads: [] as string[],
  failAppUpsert: false,
  history: [] as Array<{ cwd: string; kind: string; input?: string }>,
}));

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
    async listFiles(projectId: string) { return state.mediaFiles[projectId] ?? []; }
    async uploadFile(projectId: string, _name: string, filePath: string, _mime: string, content: Buffer) {
      state.uploads.push({ projectId, path: filePath, content });
    }
    async deleteFile() {}
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
  beforeEach(() => { state.projects = []; state.origins = []; state.mediaFiles = {}; state.uploads = []; state.appUpserts = []; state.pipelineApps = []; state.failDownloads = new Set(); state.downloads = []; state.failAppUpsert = false; state.history = []; });

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
      expect(state.downloads.some((value) => value.startsWith('remote-feature:'))).toBe(true); // registry lookup only
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
        direction: 'pull', scope: { kind: 'app', projectId: 'local-app' }, origin: { mode: 'existing', originId: 'shared-app' },
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
        localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a', 'feature-b'],
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
        localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'],
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
      const planned = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a', 'feature-b'] });
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
    state.origins = [{ projectId: 'shared', name: 'Shared', isApp: false, appId: 'origin-app', inMedia: true, visibility: 'visible' }];
    state.failDownloads.add('shared:project.json');
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
      const created = await call(batch.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'] });
      expect(created.body.data.features[0]).toMatchObject({ mode: 'create', localId: 'feature-a' });
      const createdOp = await call(batch.get('POST /api/project-sync/feature-pulls/operations')!, { planId: created.body.data.planId });
      const createdDone = await pollFeaturePullOperation(batch, createdOp.body.data.operationId);
      expect(createdDone.body.data.result.state).toBe('succeeded');
      const batchCwd = path.join(root, 'feature-a');
      expect(state.history.filter((entry) => entry.cwd === batchCwd).map((entry) => entry.kind)).toEqual(['pull']);

      state.history = [];
      state.mediaFiles['feature-a']![1] = { path: 'outputs/a.md', content: 'A2' };
      const updated = await call(batch.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'] });
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
      const created = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'] });
      const createdOp = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: created.body.data.planId });
      expect((await pollFeaturePullOperation(table, createdOp.body.data.operationId)).body.data.result.state).toBe('succeeded');

      // Owner produces a local-only output (not pushed yet); colleague adds a new remote file.
      await fs.writeFile(path.join(root, 'feature-a', 'outputs', 'local-only.md'), 'mine');
      state.mediaFiles['feature-a']!.push({ path: 'outputs/new.md', content: 'theirs' });
      const updated = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, { localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'] });
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
});
