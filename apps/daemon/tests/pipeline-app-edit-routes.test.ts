// HTTP surface sửa/xóa của Phase 2: PATCH/DELETE /api/pipelines/apps/:id và
// PATCH /api/pipelines/projects/:id.
//
// Cùng cách dựng như tests/pipeline-apps-routes.test.ts: gọi thẳng handler mà
// registerPipelineRoutes đăng ký (fake express app ghi lại handler theo
// "METHOD path") trên một DB SQLite tạm, `loadRemoteProjects` mock để registry
// trung tâm không cần mạng — mặc định coi như store chết (nhánh best-effort).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, getProject, insertProject, listPipelineApps, openDatabase } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';

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

describe('pipeline app/feature edit routes', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;

  beforeEach(() => {
    remoteImpl = UNREACHABLE;
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-pipeline-edit-'));
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
  const patchApp = (id: string, body: unknown) =>
    call('PATCH /api/pipelines/apps/:id', { params: { id }, body });
  const deleteApp = (id: string) => call('DELETE /api/pipelines/apps/:id', { params: { id } });
  const patchProject = (id: string, body: unknown) =>
    call('PATCH /api/pipelines/projects/:id', { params: { id }, body });
  const listProjectsRoute = () => call('GET /api/pipelines/projects');

  // Feature mang App cha denormalize trong metadata.studioConfig.
  function insertFeature(id: string, appId?: string, appName?: string) {
    const now = Date.now();
    insertProject(db, {
      id,
      name: id,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: {
        kind: 'pipeline',
        ...(appId ? { studioConfig: { appId, ...(appName ? { appName } : {}) } } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  const studioConfigOf = (id: string) =>
    ((getProject(db, id)?.metadata as any)?.studioConfig ?? {}) as Record<string, unknown>;

  it('renames an app in the table and on every feature that denormalizes it', async () => {
    expect((await postApp({ appId: 'XPOS', name: 'X POS' })).status).toBe(201);
    insertFeature('xpos-checkout', 'XPOS', 'X POS');
    insertFeature('xpos-refund', 'XPOS', 'X POS');
    insertFeature('other-feature', 'VNPAY', 'VNPAY App');

    const res = await patchApp('XPOS', { name: 'X POS mới' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'XPOS', name: 'X POS mới', designSystemId: null });

    expect(listPipelineApps(db)).toEqual([
      expect.objectContaining({ id: 'XPOS', name: 'X POS mới' }),
    ]);
    expect(studioConfigOf('xpos-checkout')).toEqual({ appId: 'XPOS', appName: 'X POS mới' });
    expect(studioConfigOf('xpos-refund')).toEqual({ appId: 'XPOS', appName: 'X POS mới' });
    // App khác không bị ảnh hưởng.
    expect(studioConfigOf('other-feature')).toEqual({ appId: 'VNPAY', appName: 'VNPAY App' });
  });

  it('renames an app that only exists denormalized on a feature (no row yet)', async () => {
    insertFeature('vnpay-checkout', 'VNPAY', 'VNPAY App');

    expect((await patchApp('VNPAY', { name: 'VNPAY Wallet' })).status).toBe(200);
    // Row shadow được tạo để tên mới sống được cả khi feature cuối bị gỡ.
    expect(listPipelineApps(db)).toEqual([
      expect.objectContaining({ id: 'VNPAY', name: 'VNPAY Wallet' }),
    ]);
    expect(studioConfigOf('vnpay-checkout')).toEqual({ appId: 'VNPAY', appName: 'VNPAY Wallet' });
  });

  it('400s on an empty rename and 404s on an app no source knows', async () => {
    expect((await postApp({ appId: 'XPOS', name: 'X POS' })).status).toBe(201);
    const empty = await patchApp('XPOS', { name: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/name or designSystemId is required/);

    const missing = await patchApp('NOPE', { name: 'Nope' });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/not found/);
  });

  it('deletes a local app and all of its features from this device', async () => {
    expect((await postApp({ appId: 'XPOS', name: 'X POS' })).status).toBe(201);
    insertFeature('xpos-checkout', 'XPOS', 'X POS');
    insertFeature('xpos-refund', 'XPOS', 'X POS');
    insertFeature('other-feature', 'VNPAY', 'VNPAY App');

    const res = await deleteApp('XPOS');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deletedFeatures: 2, localOnly: true });

    expect(listPipelineApps(db)).toEqual([]);
    expect(getProject(db, 'xpos-checkout')).toBeNull();
    expect(getProject(db, 'xpos-refund')).toBeNull();
    expect(studioConfigOf('other-feature')).toEqual({ appId: 'VNPAY', appName: 'VNPAY App' });

    const listed = await listProjectsRoute();
    const byId = new Map(listed.body.projects.map((p: any) => [p.id, p]));
    expect(byId.has('xpos-checkout')).toBe(false);
    expect(byId.has('xpos-refund')).toBe(false);
    expect((byId.get('other-feature') as any).app).toEqual({ id: 'VNPAY', name: 'VNPAY App' });
  });

  it('deletes a pulled app locally without consulting the central registry', async () => {
    const remote = vi.fn(async () => [
      { projectId: 'REMOTEAPP', name: 'Remote App', inKgs: true, inMedia: true, files: 0, isApp: true },
    ]);
    remoteImpl = remote;
    insertFeature('remote-feature', 'REMOTEAPP', 'Remote App');

    const res = await deleteApp('REMOTEAPP');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deletedFeatures: 1, localOnly: true });
    expect(getProject(db, 'remote-feature')).toBeNull();
    expect(remote).not.toHaveBeenCalled();
  });

  it('404s deleting an app no local source knows', async () => {
    expect((await deleteApp('NOPE')).status).toBe(404);
  });

  it('renames a feature without touching its id or app', async () => {
    insertFeature('xpos-checkout', 'XPOS', 'X POS');

    const res = await patchProject('xpos-checkout', { name: 'Thanh toán' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'xpos-checkout', name: 'Thanh toán' });
    expect(getProject(db, 'xpos-checkout')?.name).toBe('Thanh toán');
    expect(studioConfigOf('xpos-checkout')).toEqual({ appId: 'XPOS', appName: 'X POS' });
  });

  it('reassigns a feature to another app and detaches it on appId: null', async () => {
    expect((await postApp({ appId: 'VNPAY', name: 'VNPAY App' })).status).toBe(201);
    insertFeature('xpos-checkout', 'XPOS', 'X POS');

    expect((await patchProject('xpos-checkout', { appId: 'VNPAY' })).status).toBe(200);
    // appName suy ra từ App đang biết khi client không gửi kèm.
    expect(studioConfigOf('xpos-checkout')).toEqual({ appId: 'VNPAY', appName: 'VNPAY App' });

    expect((await patchProject('xpos-checkout', { appId: null })).status).toBe(200);
    expect(studioConfigOf('xpos-checkout')).toEqual({});
    expect(getProject(db, 'xpos-checkout')).not.toBeNull();
  });

  it('400s on an empty body and 404s on an unknown/non-pipeline project', async () => {
    insertFeature('xpos-checkout', 'XPOS', 'X POS');
    const empty = await patchProject('xpos-checkout', {});
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/name or appId is required/);

    expect((await patchProject('nope', { name: 'X' })).status).toBe(404);

    // Workspace chat thường không phải pipeline project.
    const now = Date.now();
    insertProject(db, {
      id: 'chat-workspace',
      name: 'chat',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    expect((await patchProject('chat-workspace', { name: 'X' })).status).toBe(404);
  });
});
