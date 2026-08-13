// HTTP surface của App container 0 feature: POST/GET /api/pipelines/apps.
//
// Gọi thẳng handler mà registerPipelineRoutes đăng ký (fake express app ghi lại
// handler theo "METHOD path", như tests/http/adapter.test.ts) trên một DB SQLite
// tạm, nên không cần bind socket. `loadRemoteProjects` được mock để phần
// registry trung tâm (KGS/media) không cần mạng — mặc định coi như store chết,
// đúng nhánh best-effort mà route phải chịu được.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, insertProject, openDatabase } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';

// Mặc định: store không với tới được (throw) → picker/tạo mới chỉ dựa vào local.
const UNREACHABLE = async (): Promise<unknown[]> => {
  throw new Error('stores unreachable');
};
let remoteImpl: () => Promise<unknown[]> = UNREACHABLE;

vi.mock('../src/kg-sync/remote-registry.js', () => ({
  loadRemoteProjects: () => remoteImpl(),
}));

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const handlers = new Map<string, Handler>();
  const record = (method: string) => (routePath: string, handler: Handler) => {
    handlers.set(`${method} ${routePath}`, handler);
  };
  return {
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    delete: record('DELETE'),
    patch: record('PATCH'),
    use: () => {},
    handlers,
  };
}

// Bản res tối thiểu: ghi lại status + body của lời gọi json đầu tiên.
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

describe('pipeline apps routes', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;

  beforeEach(() => {
    remoteImpl = UNREACHABLE;
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-pipeline-apps-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const app = makeApp();
    registerPipelineRoutes(app as any, {
      db,
      pipelines: { localOutputs: async () => [] },
      paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    } as any);
    handlers = app.handlers;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function call(key: string, req: Record<string, unknown> = {}) {
    const handler = handlers.get(key);
    expect(handler, `${key} should be registered`).toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ body: {}, query: {}, params: {}, ...req }, res);
    return out;
  }

  const postApp = (body: unknown) => call('POST /api/pipelines/apps', { body });
  const listApps = () => call('GET /api/pipelines/apps');

  // Feature mang App cha denormalize trong metadata.studioConfig.
  function insertFeature(id: string, appId: string, appName?: string) {
    const now = Date.now();
    insertProject(db, {
      id,
      name: id,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'pipeline', studioConfig: { appId, ...(appName ? { appName } : {}) } },
      createdAt: now,
      updatedAt: now,
    });
  }

  it('creates a 0-feature app and lists it locally', async () => {
    const created = await postApp({ appId: 'XPOS', name: 'X POS' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: 'XPOS', name: 'X POS', designSystemId: null });

    const listed = await listApps();
    expect(listed.body).toEqual({ apps: [{ id: 'XPOS', name: 'X POS', designSystemId: null, origin: 'local' }] });
  });

  it('rejects an id pipeline-studio would never accept', async () => {
    const res = await postApp({ appId: '_bad id', name: 'Bad' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid app id/);
    expect((await listApps()).body).toEqual({ apps: [] });
  });

  it('409s on an app id that already exists — row or denormalized on a feature', async () => {
    expect((await postApp({ appId: 'XPOS', name: 'X POS' })).status).toBe(201);
    const again = await postApp({ appId: 'XPOS', name: 'X POS again' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already exists/);

    // App chỉ tồn tại dưới dạng {appId, appName} trên một feature cũng là trùng.
    insertFeature('VNPAY-checkout', 'VNPAY', 'VNPAY App');
    expect((await postApp({ appId: 'VNPAY', name: 'VNPAY App' })).status).toBe(409);
  });

  it('409s on an app that only exists on the central registry', async () => {
    remoteImpl = async () => [
      { projectId: 'REMOTEAPP', name: 'Remote App', inMedia: true, files: 0, isApp: true },
    ];
    expect((await postApp({ appId: 'REMOTEAPP', name: 'Remote App' })).status).toBe(409);
  });

  it('lists only Apps that exist locally and leaves remote discovery to the Pull API', async () => {
    expect((await postApp({ appId: 'XPOS', name: 'X POS' })).status).toBe(201);
    insertFeature('VNPAY-checkout', 'VNPAY', 'VNPAY App');
    remoteImpl = async () => [
      { projectId: 'XPOS', name: 'Studio name', inMedia: true, files: 0, isApp: true },
      { projectId: 'ONLYREMOTE', name: 'Only Remote', inMedia: false, files: 0, isApp: true },
      // Feature trên registry không phải App → không vào picker.
      { projectId: 'REMOTEFEAT', name: 'Remote Feature', inMedia: true, files: 3, isApp: false },
    ];

    expect((await listApps()).body).toEqual({
      apps: [
        { id: 'VNPAY', name: 'VNPAY App', designSystemId: null, origin: 'local' },
        { id: 'XPOS', name: 'X POS', designSystemId: null, origin: 'local' },
      ],
    });
  });
});
