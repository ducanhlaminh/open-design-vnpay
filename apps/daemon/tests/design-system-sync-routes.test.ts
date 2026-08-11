import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => ({ files: new Map<string, Buffer>() }));

vi.mock('../src/auth-routes.js', () => ({
  getMachineIdentityUser: async () => ({ id: '00000000-0000-4000-8000-000000000001', identityUserId: '00000000-0000-4000-8000-000000000001', email: 'designer@example.com', name: 'Designer' }),
  identityUserIdOf: (user: any) => user?.identityUserId ?? null,
}));

vi.mock('../src/kg-sync/media-client.js', () => ({
  mediaConfigFromEnv: () => ({ baseUrl: '', appId: '', userId: '', role: 'admin' }),
  MediaClient: class {
    async listFiles() { return [...remote.files.keys()].map((filePath, index) => ({ id: String(index), path: filePath })); }
    async downloadFile(_folder: string, filePath: string) { const value = remote.files.get(filePath); if (!value) throw new Error('not found'); return Buffer.from(value); }
    async syncProjectFiles(_folder: string, files: Array<{ path: string; content: Buffer }>) {
      let uploaded = 0; let skipped = 0;
      for (const file of files) { const old = remote.files.get(file.path); if (old?.equals(file.content)) skipped++; else { remote.files.set(file.path, Buffer.from(file.content)); uploaded++; } }
      return { uploaded, skipped, deleted: 0 };
    }
  },
}));

import { registerDesignSystemSyncRoutes } from '../src/design-system-sync-routes.js';
import { closeDatabase, openDatabase } from '../src/db.js';

type Handler = (req: any, res: any) => unknown;
function fakeApp() {
  const handlers = new Map<string, Handler>();
  const record = (method: string) => (route: string, handler: Handler) => handlers.set(`${method} ${route}`, handler);
  return { get: record('GET'), post: record('POST'), handlers };
}
function fakeRes() {
  const out: { status: number; body?: any } = { status: 200 };
  const res: any = { status(value: number) { out.status = value; return res; }, json(value: unknown) { out.body = value; return res; } };
  return { out, res };
}

describe('Design System sync HTTP contracts', () => {
  let root: string; let db: any; let handlers: Map<string, Handler>;
  beforeEach(async () => {
    remote.files.clear(); root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'od-ds-sync-routes-'));
    db = openDatabase(root, { dataDir: root });
    const dsDir = path.join(root, 'design-systems', 'payments');
    await fs.promises.mkdir(path.join(dsDir, 'criteria'), { recursive: true });
    await fs.promises.mkdir(path.join(dsDir, 'ir'), { recursive: true });
    await fs.promises.writeFile(path.join(dsDir, 'manifest.json'), JSON.stringify({ name: 'Payments DS' }));
    await fs.promises.writeFile(path.join(dsDir, 'ir', 'figma.json'), '{}');
    await fs.promises.writeFile(path.join(dsDir, 'criteria', 'components.md'), '# Components\n\n### `button` Button\n');
    await fs.promises.writeFile(path.join(dsDir, 'criteria', 'rules.md'), '# Rules\n\n### `r1` Rule\n');
    const app = fakeApp();
    registerDesignSystemSyncRoutes(app as any, { db, paths: { USER_DESIGN_SYSTEMS_DIR: path.join(root, 'design-systems'), PROJECTS_DIR: path.join(root, 'projects') },
      http: { sendApiError(res: any, status: number, code: string, message: string) { return res.status(status).json({ error: { code, message } }); } } } as any);
    handlers = app.handlers;
  });
  afterEach(async () => { closeDatabase(); await fs.promises.rm(root, { recursive: true, force: true }); });

  async function call(key: string, params: Record<string, string> = {}, body: unknown = {}, query: unknown = {}) {
    const handler = handlers.get(key); expect(handler).toBeTypeOf('function');
    const { out, res } = fakeRes(); await handler!({ params, body, query }, res); return out;
  }

  it('uses one contract for status, push, remote listing and pull planning', async () => {
    const status = await call('GET /api/design-systems/:id/sync/status', { id: 'payments' });
    expect(status.body.data).toMatchObject({ localDesignSystemId: 'user:payments', canPush: true });
    const pushed = await call('POST /api/design-systems/:id/sync/push', { id: 'payments' });
    expect(pushed.body.data).toMatchObject({ status: 'published', summary: { remoteDesignSystemId: 'payments', visibility: 'workspace' } });
    const listed = await call('GET /api/design-systems/sync/remote');
    expect(listed.body.data).toMatchObject({ total: 1, items: [{ remoteDesignSystemId: 'payments' }] });
    const plan = await call('POST /api/design-systems/sync/pull/plan', {}, { remoteDesignSystemId: 'payments', localDesignSystemId: 'copy' });
    expect(plan.body.data).toMatchObject({ localDesignSystemId: 'user:copy', localExists: false, conflict: false });
  });
});
