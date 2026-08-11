import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerAppContextRoutes } from '../src/app-context-routes.js';
import { closeDatabase, insertPipelineApp, insertProject, openDatabase } from '../src/db.js';

type Handler = (req: any, res: any) => unknown;

function fakeApp() {
  const handlers = new Map<string, Handler>();
  const record = (method: string) => (route: string, handler: Handler) => handlers.set(`${method} ${route}`, handler);
  return { get: record('GET'), post: record('POST'), handlers };
}

function fakeRes() {
  const out: { status: number; body?: any } = { status: 200 };
  const res: any = {
    status(value: number) { out.status = value; return res; },
    json(value: unknown) { out.body = value; return res; },
  };
  return { out, res };
}

describe('App Context HTTP contracts', () => {
  let root: string;
  let db: any;
  let handlers: Map<string, Handler>;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'od-context-routes-'));
    db = openDatabase(root, { dataDir: root });
    insertPipelineApp(db, { id: 'banking', name: 'Banking', designSystemId: null, createdAt: Date.now() });
    insertProject(db, {
      id: 'pay', name: 'Pay', skillId: null, designSystemId: null, pendingPrompt: null,
      metadata: { kind: 'pipeline', studioConfig: { appId: 'banking', appName: 'Banking' } },
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    await fs.promises.mkdir(path.join(root, 'banking', 'app-context'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'banking', 'app-context', 'ux-charter.json'), '{}\n');
    const app = fakeApp();
    registerAppContextRoutes(app as any, {
      db,
      paths: {
        PROJECTS_DIR: root,
        RUNTIME_DATA_DIR: root,
        DESIGN_SYSTEMS_DIR: path.join(root, 'ds'),
        USER_DESIGN_SYSTEMS_DIR: path.join(root, 'user-ds'),
      },
      http: {
        sendApiError(res: any, status: number, code: string, message: string) {
          return res.status(status).json({ error: { code, message } });
        },
      },
    } as any);
    handlers = app.handlers;
  });

  afterEach(async () => {
    closeDatabase();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  async function call(key: string, params: Record<string, string>, body: unknown = {}) {
    const handler = handlers.get(key);
    expect(handler).toBeTypeOf('function');
    const { out, res } = fakeRes();
    await handler!({ params, body }, res);
    return out;
  }

  it('creates an immutable version, reports it, and binds a Feature explicitly', async () => {
    const created = await call('POST /api/pipelines/apps/:appId/context/versions', { appId: 'banking' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'created', manifest: { contextVersion: 'v1' } });
    const manifest = created.body.data.manifest;

    const bound = await call('POST /api/projects/:featureId/context-binding', { featureId: 'pay' }, {
      appId: 'banking', contextVersion: manifest.contextVersion, contentDigest: manifest.contentDigest,
    });
    expect(bound.body.data.binding).toMatchObject({ appId: 'banking', contextVersion: 'v1' });

    const summary = await call('GET /api/pipelines/apps/:appId/context', { appId: 'banking' });
    expect(summary.body.data).toMatchObject({
      current: { contextVersion: 'v1' },
      bindings: [{ featureId: 'pay', binding: { contextVersion: 'v1' } }],
    });
  });
});
