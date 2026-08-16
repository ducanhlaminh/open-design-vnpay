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
}));

vi.mock('../src/db.js', () => ({
  listProjects: () => state.projects,
  listPipelineApps: () => state.pipelineApps,
  getPipelineApp: (_db: unknown, id: string) => state.pipelineApps.find((app) => app.id === id) ?? null,
  getProject: (_db: unknown, id: string) => state.projects.find((project) => project.id === id) ?? null,
  insertProject: (_db: unknown, project: any) => { state.projects.push(project); },
  updateProject: (_db: unknown, id: string, patch: any) => { const project = state.projects.find((row) => row.id === id); if (project) Object.assign(project, patch); },
  upsertPipelineAppName: (_db: unknown, value: { id: string; name: string }) => { state.appUpserts.push(value); },
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
import { registerProjectSyncRoutes } from '../src/project-sync-routes.js';

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
  beforeEach(() => { state.projects = []; state.origins = []; state.mediaFiles = {}; state.uploads = []; state.appUpserts = []; state.pipelineApps = []; state.failDownloads = new Set(); state.downloads = []; });

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

      // A later update removes a file that disappeared remotely while keeping
      // the existing mapped local id.
      state.mediaFiles['feature-a'] = state.mediaFiles['feature-a']!.filter((file) => file.path !== 'outputs/a.md');
      const updatePlan = await call(table.get('POST /api/project-sync/feature-pulls/plan')!, {
        localAppId: 'local-app', originAppId: 'shared-app', originFeatureIds: ['feature-a'],
      });
      expect(updatePlan.body.data.features[0]).toMatchObject({ mode: 'update', localId: 'feature-a' });
      expect(updatePlan.body.data.features[0].entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'feature/outputs/a.md', change: 'deleted' })]));
      const updateStarted = await call(table.get('POST /api/project-sync/feature-pulls/operations')!, { planId: updatePlan.body.data.planId });
      await pollFeaturePullOperation(table, updateStarted.body.data.operationId);
      await expect(fs.stat(path.join(root, 'feature-a', 'outputs', 'a.md'))).rejects.toThrow();
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
          { path: 'app.json', checksum: 'remote-app', content: JSON.stringify({ kind: 'app', name: 'Shared App' }) },
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
});
