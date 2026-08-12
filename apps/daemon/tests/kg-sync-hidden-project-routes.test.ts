// Soft-deleted projects remain on KGS/media for restore and history, but a
// caller with an old project id must not be able to bypass Pull discovery.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  appId: null as string | null,
  inserted: [] as string[],
  pulled: [] as string[],
  remote: [] as Array<{
    projectId: string;
    name: string;
    inKgs: boolean;
    inMedia: boolean;
    files: number;
    isApp: boolean;
    visibility?: 'visible' | 'hidden';
  }>,
}));

vi.mock('../src/kg-sync/remote-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kg-sync/remote-registry.js')>();
  return { ...actual, loadRemoteProjects: async () => state.remote };
});

vi.mock('../src/kg-sync/kgs-client.js', () => ({
  KgsClient: class {},
  kgsConfigFromEnv: () => ({}),
}));

vi.mock('../src/kg-sync/media-client.js', () => ({
  MediaClient: class {},
  mediaConfigFromEnv: () => ({}),
}));

vi.mock('../src/kg-sync/pull.js', () => ({
  pullProject: async (_db: unknown, projectId: string) => {
    state.pulled.push(projectId);
    return { status: 'ok', nodes: 1, edges: 0, errors: [] };
  },
}));

vi.mock('../src/kg-sync/identity-registry.js', () => ({
  ensureProjectRegistered: async () => 'ok',
  memberProjectAccess: async () => new Map(),
  pullScopeFor: async () => ({ all: true, ids: new Set<string>() }),
}));

vi.mock('../src/auth-routes.js', () => ({
  getMachineIdentityUser: async () => null,
  identityAccessTokenOf: () => null,
  identityUserIdOf: () => null,
}));

vi.mock('../src/app-context.js', () => ({
  resolveAppId: async () => state.appId,
}));

import { registerKgSyncRoutes } from '../src/kg-sync-routes.js';

type Handler = (req: any, res: any) => unknown;

function routeHandler(): Handler {
  const handlers = new Map<string, Handler>();
  const record = (method: string) => (path: string, handler: Handler) => {
    handlers.set(`${method} ${path}`, handler);
  };
  const app = {
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    delete: record('DELETE'),
    patch: record('PATCH'),
    use: () => {},
  };
  registerKgSyncRoutes(app as never, {
    db: {} as never,
    http: {
      sendApiError: (res: any, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
    } as never,
    ids: { randomId: () => 'run-id' } as never,
    projectStore: {
      getProject: () => null,
      insertProject: (_db: unknown, row: { id: string }) => state.inserted.push(row.id),
    } as never,
    pipelines: {} as never,
  });
  return handlers.get('POST /api/projects/:id/kg-pull')!;
}

async function call(projectId: string) {
  const output: { status: number; body?: unknown } = { status: 200 };
  const res: any = {
    status(status: number) {
      output.status = status;
      return res;
    },
    json(body: unknown) {
      output.body = body;
      return res;
    },
  };
  await routeHandler()({ params: { id: projectId }, body: {}, query: {} }, res);
  return output;
}

const row = (projectId: string, visibility: 'visible' | 'hidden', isApp = false) => ({
  projectId,
  name: projectId,
  inKgs: true,
  inMedia: true,
  files: 1,
  isApp,
  visibility,
});

describe('POST /api/projects/:id/kg-pull lifecycle guard', () => {
  beforeEach(() => {
    state.appId = null;
    state.inserted = [];
    state.pulled = [];
    state.remote = [];
  });

  it('returns PROJECT_HIDDEN and performs no local write for a hidden project id', async () => {
    state.remote = [row('old-project', 'hidden')];
    const response = await call('old-project');

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ error: { code: 'PROJECT_HIDDEN' } });
    expect(state.inserted).toEqual([]);
    expect(state.pulled).toEqual([]);
  });

  it('also blocks a visible Feature whose parent App is hidden', async () => {
    state.appId = 'app--old';
    state.remote = [row('app--old', 'hidden', true), row('child', 'visible')];
    const response = await call('child');

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ error: { code: 'PROJECT_HIDDEN' } });
    expect(state.pulled).toEqual([]);
  });

  it('keeps legacy/visible direct Pull behavior', async () => {
    state.remote = [row('active', 'visible')];
    const response = await call('active');

    expect(response.status).toBe(200);
    expect(state.inserted).toEqual(['active']);
    expect(state.pulled).toEqual(['active']);
  });
});
