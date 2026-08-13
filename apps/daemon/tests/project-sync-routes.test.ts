import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({
  projects: [] as any[],
  origins: [] as any[],
  mediaFiles: {} as Record<string, any[]>,
  uploads: [] as Array<{ projectId: string; path: string; content: Buffer }>,
}));

vi.mock('../src/db.js', () => ({
  listProjects: () => state.projects,
  listPipelineApps: () => [],
  getPipelineApp: () => null,
  getProject: (_db: unknown, id: string) => state.projects.find((project) => project.id === id) ?? null,
  insertProject: () => {}, updateProject: () => {}, upsertPipelineAppName: () => {},
}));
vi.mock('../src/kg-sync/remote-registry.js', () => ({
  PROJECT_LIFECYCLE_PATH: '_studio/project-lifecycle.json',
  loadRemoteProjects: async () => state.origins,
}));
vi.mock('../src/kg-sync/media-client.js', () => ({
  MediaClient: class {
    async downloadFile(projectId: string, filePath: string) {
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
async function call(handler: Handler, body = {}, query = {}) {
  const output: any = { status: 200 }; const res: any = { status: (status: number) => (output.status = status, res), json: (json: unknown) => (output.body = json, res) };
  await handler({ body, query }, res); return output;
}

describe('project-sync route contract', () => {
  beforeEach(() => { state.projects = []; state.origins = []; state.mediaFiles = {}; state.uploads = []; });

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
});
