// GET /api/pipelines/confluence/resolve?ref= — tra MỘT trang từ link/page id
// dán vào cùng ô tìm (WP confluence-paste-link). Route chỉ là lớp mỏng trên
// ctx.pipelines.bas.resolveConfluencePage: thiếu ref → 400; lỗi mang
// ConfluenceResolveError.status → đúng status đó; lỗi lạ → 502.
//
// Cùng cách dựng như tests/pipeline-projects-workflows-route.test.ts: fake
// express app ghi lại handler, DB SQLite tạm, registry remote mock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfluenceResolveError } from '../src/bas/bas-client.js';
import { closeDatabase, openDatabase } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';

vi.mock('../src/kg-sync/remote-registry.js', () => ({
  loadRemoteProjects: async () => {
    throw new Error('stores unreachable');
  },
}));

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const handlers = new Map<string, Handler>();
  const record = (method: string) => (routePath: string, handler: Handler) => {
    handlers.set(`${method} ${routePath}`, handler);
  };
  return { get: record('GET'), post: record('POST'), put: record('PUT'), delete: record('DELETE'), patch: record('PATCH'), use: () => {}, handlers };
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

describe('GET /api/pipelines/confluence/resolve', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  const resolveConfluencePage = vi.fn();

  beforeEach(() => {
    resolveConfluencePage.mockReset();
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-conf-resolve-'));
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const app = makeApp();
    registerPipelineRoutes(app as any, {
      db,
      pipelines: { localOutputs: async () => [], bas: { resolveConfluencePage } },
      paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    } as any);
    handlers = app.handlers;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function call(query: Record<string, unknown>) {
    const handler = handlers.get('GET /api/pipelines/confluence/resolve');
    expect(handler, 'route should be registered').toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ body: {}, params: {}, query }, res);
    return out;
  }

  it('returns { page } from the dep for a pasted link', async () => {
    const page = { id: '301', title: 'Đăng nhập', url: 'https://wiki.test/pages/301', space: 'XPOS', ancestors: ['Root'], hasChildren: true };
    resolveConfluencePage.mockResolvedValueOnce(page);
    const out = await call({ ref: ' https://wiki.test/pages/301/Dang-nhap ' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ page });
    expect(resolveConfluencePage).toHaveBeenCalledWith('https://wiki.test/pages/301/Dang-nhap');
  });

  it('400 when ref is missing or blank — dep not called', async () => {
    expect((await call({})).status).toBe(400);
    expect((await call({ ref: '   ' })).status).toBe(400);
    expect((await call({ ref: ['a', 'b'] })).status).toBe(400);
    expect(resolveConfluencePage).not.toHaveBeenCalled();
  });

  it('maps ConfluenceResolveError.status straight through (400 / 404 / 502)', async () => {
    for (const status of [400, 404, 502] as const) {
      resolveConfluencePage.mockRejectedValueOnce(new ConfluenceResolveError(status, `err ${status}`));
      const out = await call({ ref: '301' });
      expect(out.status).toBe(status);
      expect(out.body).toEqual({ error: `err ${status}` });
    }
  });

  it('any other error → 502 with its message', async () => {
    resolveConfluencePage.mockRejectedValueOnce(new Error('gateway down'));
    const out = await call({ ref: '301' });
    expect(out.status).toBe(502);
    expect(out.body).toEqual({ error: 'gateway down' });
  });
});
