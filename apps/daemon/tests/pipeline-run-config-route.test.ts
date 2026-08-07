// HTTP surface của "lưu cấu hình mà KHÔNG chạy": PUT
// /api/pipelines/projects/:id/run-config.
//
// Gọi thẳng handler mà registerPipelineRoutes đăng ký (fake express app ghi lại
// handler theo "METHOD path", như tests/pipeline-apps-routes.test.ts) trên một
// DB SQLite tạm, nên không cần bind socket.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, getProject, insertProject, openDatabase } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';

// Registry trung tâm không cần mạng trong test này.
vi.mock('../src/kg-sync/remote-registry.js', () => ({
  loadRemoteProjects: async () => [],
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

describe('PUT /api/pipelines/projects/:id/run-config', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-pipeline-run-config-'));
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

  async function putConfig(id: string, body: Record<string, unknown>) {
    const handler = handlers.get('PUT /api/pipelines/projects/:id/run-config');
    expect(handler, 'route should be registered').toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ params: { id }, query: {}, body }, res);
    return out;
  }

  const savedConfig = (id: string) =>
    (getProject(db, id) as any)?.metadata?.runAllConfig as Record<string, unknown> | undefined;

  function insertFeature(id: string, runAllConfig?: Record<string, unknown>, kind = 'pipeline') {
    const now = Date.now();
    insertProject(db, {
      id,
      name: id,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind, ...(runAllConfig ? { runAllConfig } : {}) },
      createdAt: now,
      updatedAt: now,
    });
  }

  it('merge shallow: field không gửi giữ nguyên giá trị đã lưu', async () => {
    insertFeature('FEAT', {
      confluencePages: [{ id: '111', title: 'Spec cũ' }],
      designSystemId: 'ds-old',
      targets: ['mobile'],
      terminal: 'ui-html',
      lean: false,
    });

    const res = await putConfig('FEAT', { targets: ['web-user', 'mobile'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const cfg = savedConfig('FEAT');
    expect(cfg?.targets).toEqual(['web-user', 'mobile']);
    // Các section khác không bị section vừa lưu xóa mất.
    expect(cfg?.confluencePages).toEqual([{ id: '111', title: 'Spec cũ' }]);
    expect(cfg?.designSystemId).toBe('ds-old');
    expect(cfg?.terminal).toBe('ui-html');
    expect(cfg?.lean).toBe(false);
  });

  it('lưu được từng section riêng: nguồn tài liệu và chế độ chạy', async () => {
    insertFeature('FEAT', { designSystemId: 'ds-old' });

    await putConfig('FEAT', {
      confluencePages: [{ id: '222', title: 'Spec mới', url: 'https://wiki/x' }],
      followLinks: false,
      includeDescendants: true,
      docsFromUpload: false,
    });
    await putConfig('FEAT', { lean: true });

    const cfg = savedConfig('FEAT');
    expect(cfg?.confluencePages).toEqual([{ id: '222', title: 'Spec mới', url: 'https://wiki/x' }]);
    expect(cfg?.followLinks).toBe(false);
    expect(cfg?.includeDescendants).toBe(true);
    expect(cfg?.docsFromUpload).toBe(false);
    expect(cfg?.lean).toBe(true);
    expect(cfg?.designSystemId).toBe('ds-old');
  });

  it('designSystemId: null ghi đè thành null ("Không dùng")', async () => {
    insertFeature('FEAT', { designSystemId: 'ds-old', lean: true });

    const res = await putConfig('FEAT', { designSystemId: null });
    expect(res.status).toBe(200);

    const cfg = savedConfig('FEAT');
    expect(cfg).toHaveProperty('designSystemId', null);
    expect(cfg?.lean).toBe(true);
  });

  it('404 khi project không tồn tại hoặc không phải pipeline project', async () => {
    insertFeature('CHAT', undefined, 'chat');

    const missing = await putConfig('nope', { lean: true });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'project not found' });

    const notPipeline = await putConfig('CHAT', { lean: true });
    expect(notPipeline.status).toBe(404);
    expect(savedConfig('CHAT')).toBeUndefined();
  });

  // appFiles — App-corpus selection for the docs-ingest stage (see the
  // `app-files` deterministic run source, server.ts's runPipeline).
  describe('appFiles', () => {
    it('round-trips { appId, paths } and leaves other sections untouched', async () => {
      insertFeature('FEAT', { designSystemId: 'ds-old', confluencePages: [{ id: '111' }] });

      const res = await putConfig('FEAT', { appFiles: { appId: 'XPOS', paths: ['Overview.md', 'sub/Page.md'] } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const cfg = savedConfig('FEAT');
      expect(cfg?.appFiles).toEqual({ appId: 'XPOS', paths: ['Overview.md', 'sub/Page.md'] });
      // Other sections survive the shallow merge.
      expect(cfg?.designSystemId).toBe('ds-old');
      expect(cfg?.confluencePages).toEqual([{ id: '111' }]);
    });

    it('a field NOT sent keeps the previously-saved appFiles', async () => {
      insertFeature('FEAT', { appFiles: { appId: 'XPOS', paths: ['A.md'] } });

      const res = await putConfig('FEAT', { lean: true });
      expect(res.status).toBe(200);
      expect(savedConfig('FEAT')?.appFiles).toEqual({ appId: 'XPOS', paths: ['A.md'] });
    });

    it('null clears a previously-saved appFiles selection', async () => {
      insertFeature('FEAT', { appFiles: { appId: 'XPOS', paths: ['A.md'] } });

      const res = await putConfig('FEAT', { appFiles: null });
      expect(res.status).toBe(200);
      expect(savedConfig('FEAT')).not.toHaveProperty('appFiles');
    });

    it('400s a non-object appFiles', async () => {
      insertFeature('FEAT');
      const res = await putConfig('FEAT', { appFiles: 'XPOS' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/appFiles must be an object/);
    });

    it('400s appFiles missing appId', async () => {
      insertFeature('FEAT');
      const res = await putConfig('FEAT', { appFiles: { paths: ['A.md'] } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/appFiles must be/);
    });

    it('400s appFiles with an empty paths array', async () => {
      insertFeature('FEAT');
      const res = await putConfig('FEAT', { appFiles: { appId: 'XPOS', paths: [] } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/appFiles must be/);
    });

    it('400s appFiles with a non-string path entry', async () => {
      insertFeature('FEAT');
      const res = await putConfig('FEAT', { appFiles: { appId: 'XPOS', paths: ['A.md', 42] } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/appFiles must be/);
    });

    it('a 400 leaves the previously-saved config untouched (no partial write)', async () => {
      insertFeature('FEAT', { appFiles: { appId: 'XPOS', paths: ['A.md'] }, lean: true });
      const res = await putConfig('FEAT', { appFiles: { appId: 'XPOS' }, lean: false });
      expect(res.status).toBe(400);
      const cfg = savedConfig('FEAT');
      expect(cfg?.appFiles).toEqual({ appId: 'XPOS', paths: ['A.md'] });
      expect(cfg?.lean).toBe(true);
    });
  });
});
