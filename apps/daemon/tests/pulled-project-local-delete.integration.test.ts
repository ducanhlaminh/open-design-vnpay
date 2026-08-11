// Regression contract for a project pulled from the shared store:
// deleting it in Open Design is a local-only operation. The fixture models the
// durable state produced by Pull (App row + Feature rows + project folders),
// drives the real delete routes, then materializes the same remote snapshot
// again to prove that a later Pull starts cleanly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  deleteProject,
  getProject,
  insertPipelineApp,
  insertProject,
  listPipelineApps,
  openDatabase,
  updateProject,
} from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';
import { registerProjectRoutes } from '../src/project-routes.js';
import { removeProjectDir } from '../src/projects.js';

type RemoteProject = {
  projectId: string;
  name: string;
  isApp: boolean;
  inKgs: boolean;
  inMedia: boolean;
  files: number;
};

const REMOTE_APP: RemoteProject = {
  projectId: 'REMOTE-APP',
  name: 'Dự án dùng chung',
  isApp: true,
  inKgs: true,
  inMedia: true,
  files: 4,
};

let remoteCalls = 0;
let remoteImpl: () => Promise<RemoteProject[]>;

vi.mock('../src/kg-sync/remote-registry.js', () => ({
  loadRemoteProjects: async () => {
    remoteCalls += 1;
    return remoteImpl();
  },
}));

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const handlers = new Map<string, Handler>();
  const record = (method: string) => (routePath: string | RegExp, ...routeHandlers: Handler[]) => {
    handlers.set(`${method} ${String(routePath)}`, routeHandlers.at(-1)!);
  };
  return {
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    delete: record('DELETE'),
    patch: record('PATCH'),
    options: record('OPTIONS'),
    use: () => {},
    handlers,
  };
}

function makeRes() {
  const out: { status: number; body: any } = { status: 200, body: undefined };
  const res: any = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  return { res, out };
}

describe('pulled project local deletion', () => {
  let tempDir: string;
  let projectsDir: string;
  let db: any;
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    remoteCalls = 0;
    remoteImpl = async () => [{ ...REMOTE_APP }];
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-pulled-delete-'));
    projectsDir = path.join(tempDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    db = openDatabase(tempDir, { dataDir: tempDir });

    const app = makeApp();
    registerPipelineRoutes(app as any, {
      db,
      pipelines: { localOutputs: async () => [] },
      paths: { PROJECTS_DIR: projectsDir, RUNTIME_DATA_DIR: tempDir },
    } as any);
    registerProjectRoutes(app as any, {
      db,
      design: {},
      http: {
        sendApiError: (res: any, status: number, code: string, message: string) =>
          res.status(status).json({ error: { code, message } }),
      },
      paths: {
        DESIGN_SYSTEMS_DIR: path.join(tempDir, 'design-systems'),
        PROJECTS_DIR: projectsDir,
        SKILLS_DIR: path.join(tempDir, 'skills'),
      },
      projectStore: {
        insertProject,
        getProject,
        updateProject,
        dbDeleteProject: deleteProject,
        removeProjectDir,
        validateLinkedDirs: () => ({ dirs: [] }),
      },
      projectFiles: {},
      conversations: {},
      templates: {},
      status: {},
      events: {},
      ids: { randomId: () => 'test-id' },
      telemetry: {},
      validation: {},
    } as any);
    handlers = app.handlers;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function call(key: string, params: Record<string, string>) {
    const handler = handlers.get(key);
    expect(handler, `${key} should be registered`).toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ body: {}, query: {}, params }, res);
    return out;
  }

  function materializePull(remoteRevision: string, featureIds = ['remote-checkout', 'remote-refund']) {
    const now = Date.now();
    insertPipelineApp(db, {
      id: REMOTE_APP.projectId,
      name: REMOTE_APP.name,
      createdAt: now,
    });

    const appDir = path.join(projectsDir, REMOTE_APP.projectId);
    mkdirSync(path.join(appDir, 'context', 'versions', 'v1'), { recursive: true });
    writeFileSync(
      path.join(appDir, 'context', 'current.json'),
      JSON.stringify({ contextVersion: 'v1', remoteRevision }),
    );

    for (const id of featureIds) {
      insertProject(db, {
        id,
        name: id,
        skillId: null,
        designSystemId: null,
        pendingPrompt: null,
        metadata: {
          source: 'kg-pull',
          studioConfig: {
            appId: REMOTE_APP.projectId,
            appName: REMOTE_APP.name,
            approvedMapping: {
              approvedAppId: REMOTE_APP.projectId,
              approvedProjectId: id,
            },
          },
          appContextBinding: { appId: REMOTE_APP.projectId, contextVersion: 'v1' },
          remoteRevision,
        },
        createdAt: now,
        updatedAt: now,
      });
      const featureDir = path.join(projectsDir, id);
      mkdirSync(path.join(featureDir, 'docs-to-review'), { recursive: true });
      writeFileSync(path.join(featureDir, 'docs-to-review', 'result.md'), remoteRevision);
    }
  }

  it('deletes the pulled App, all Features and local sync state without touching remote, then permits a clean Pull', async () => {
    const remoteBefore = JSON.stringify(await remoteImpl());
    materializePull('remote-r1');

    const deleted = await call('DELETE /api/pipelines/apps/:id', { id: REMOTE_APP.projectId });

    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true, deletedFeatures: 2, localOnly: true });
    expect(listPipelineApps(db)).toEqual([]);
    expect(getProject(db, 'remote-checkout')).toBeNull();
    expect(getProject(db, 'remote-refund')).toBeNull();
    expect(existsSync(path.join(projectsDir, REMOTE_APP.projectId))).toBe(false);
    expect(existsSync(path.join(projectsDir, 'remote-checkout'))).toBe(false);
    expect(existsSync(path.join(projectsDir, 'remote-refund'))).toBe(false);
    expect(remoteCalls).toBe(0);
    expect(JSON.stringify(await remoteImpl())).toBe(remoteBefore);

    // A later Pull can materialize the same remote ids without stale local
    // mappings, files or revisions surviving the delete.
    materializePull('remote-r2');
    expect(listPipelineApps(db)).toEqual([
      expect.objectContaining({ id: REMOTE_APP.projectId, name: REMOTE_APP.name }),
    ]);
    expect(getProject(db, 'remote-checkout')?.metadata).toMatchObject({ remoteRevision: 'remote-r2' });
    expect(readFileSync(
      path.join(projectsDir, 'remote-checkout', 'docs-to-review', 'result.md'),
      'utf8',
    )).toBe('remote-r2');
  });

  it('deletes locally while the shared store is offline', async () => {
    remoteImpl = async () => {
      throw new Error('shared store unavailable');
    };
    materializePull('remote-r1', ['remote-checkout']);

    const deleted = await call('DELETE /api/pipelines/apps/:id', { id: REMOTE_APP.projectId });

    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true, deletedFeatures: 1, localOnly: true });
    expect(getProject(db, 'remote-checkout')).toBeNull();
    expect(remoteCalls).toBe(0);
  });

  it('deletes one pulled Feature without removing its App or sibling Feature', async () => {
    materializePull('remote-r1');

    const deleted = await call('DELETE /api/projects/:id', { id: 'remote-checkout' });

    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    expect(getProject(db, 'remote-checkout')).toBeNull();
    expect(existsSync(path.join(projectsDir, 'remote-checkout'))).toBe(false);
    expect(getProject(db, 'remote-refund')).not.toBeNull();
    expect(existsSync(path.join(projectsDir, 'remote-refund'))).toBe(true);
    expect(listPipelineApps(db)).toEqual([
      expect.objectContaining({ id: REMOTE_APP.projectId, name: REMOTE_APP.name }),
    ]);
    expect(remoteCalls).toBe(0);
  });
});
