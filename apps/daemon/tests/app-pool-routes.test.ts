// HTTP surface of app-pool-routes.ts: same fake-express harness as
// tests/pipeline-apps-routes.test.ts (registers real handlers on a fake
// `app`, no socket bind) — app-pool-routes.ts has no server.ts-internal
// dependency, so it doesn't need the real-server harness the GATE tests use.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, insertPipelineApp, openDatabase } from '../src/db.js';
import { registerAppPoolRoutes } from '../src/app-pool-routes.js';
import { appDocsDir, readManifest, sha256, writeManifest, type AppPoolManifest } from '../src/app-pool.js';

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const handlers = new Map<string, Handler>();
  const record = (method: string) => (routePath: string, handler: Handler) => {
    handlers.set(`${method} ${routePath}`, handler);
  };
  return { get: record('GET'), post: record('POST'), put: record('PUT'), delete: record('DELETE'), handlers };
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

describe('app-pool routes', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;
  let onImportCommitStart: ((appId: string) => void | Promise<void>) | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-app-pool-routes-'));
    onImportCommitStart = undefined;
    db = openDatabase(tempDir, { dataDir: tempDir });
    const app = makeApp();
    registerAppPoolRoutes(app as any, {
      db,
      paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
      onImportCommitStart: (appId: string) => onImportCommitStart?.(appId),
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

  it('404s every route for an app id nobody knows about', async () => {
    const importRes = await call('POST /api/pipelines/apps/:appId/import-confluence', {
      params: { appId: 'ghost' },
      body: { refs: ['123'] },
    });
    expect(importRes.status).toBe(404);

    const poolRes = await call('GET /api/pipelines/apps/:appId/pool', { params: { appId: 'ghost' } });
    expect(poolRes.status).toBe(404);

    const deleteRes = await call('DELETE /api/pipelines/apps/:appId/pool/pages', {
      params: { appId: 'ghost' },
      body: { pageIds: ['1'] },
    });
    expect(deleteRes.status).toBe(404);

  });

  it('GET pool returns the gate/pending/progress shape for a known app with an empty pool', async () => {
    insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
    const res = await call('GET /api/pipelines/apps/:appId/pool', { params: { appId: 'XPOS' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pages: [],

    });
  });

  it('DELETE pool/pages removes the manifest entry (real HTTP body shape)', async () => {
    insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
    const docsDir = appDocsDir(tempDir, 'XPOS');
    await mkdir(path.join(docsDir, 'branch-a'), { recursive: true });
    await writeFile(path.join(docsDir, 'branch-a/p.md'), '# P');
    await writeManifest(tempDir, 'XPOS', {
      version: 1,
      pages: [
        {
          pageId: '1',
          path: 'branch-a/p.md',
          title: 'P',
          branch: 'branch-a',
          contentHash: sha256('# P'),
          fetchedAt: Date.now(),
        },
      ],
    });
    const res = await call('DELETE /api/pipelines/apps/:appId/pool/pages', {
      params: { appId: 'XPOS' },
      body: { pageIds: ['1'] },
    });
    expect(res.status).toBe(200);
    expect(res.body.pages).toEqual([]);
  });

  it('linked-pages 400s with missing/invalid refs and returns discovered pages', async () => {
    const missing = await call('POST /api/pipelines/confluence/linked-pages', { body: {} });
    expect(missing.status).toBe(400);
    const invalid = await call('POST /api/pipelines/confluence/linked-pages', { body: { refs: [''] } });
    expect(invalid.status).toBe(400);

    const previousUrl = process.env.CONFLUENCE_URL;
    const previousToken = process.env.CONFLUENCE_PERSONAL_TOKEN;
    process.env.CONFLUENCE_URL = 'https://wiki.test';
    process.env.CONFLUENCE_PERSONAL_TOKEN = 'pat';
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: any) => {
      const id = /\/content\/(\d+)\?/.exec(String(url))?.[1];
      const page = id === '1'
        ? { title: 'Seed', body: { view: { value: '<a href=\"/pages/2/Linked\">Linked</a>' } }, ancestors: [] }
        : { title: 'Linked', body: { view: { value: '<p>Linked</p>' } }, ancestors: [{ id: 'root', title: 'Root' }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(page) };
    }) as any;
    try {
      const result = await call('POST /api/pipelines/confluence/linked-pages', { body: { refs: ['1'] } });
      expect(result.status).toBe(200);
      expect(result.body.pages).toEqual([{ pageId: '2', title: 'Linked', ancestors: ['Root'], linkedFrom: 'Seed' }]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.CONFLUENCE_URL;
      else process.env.CONFLUENCE_URL = previousUrl;
      if (previousToken === undefined) delete process.env.CONFLUENCE_PERSONAL_TOKEN;
      else process.env.CONFLUENCE_PERSONAL_TOKEN = previousToken;
    }
  });

  it('import-confluence 400s with no refs, and surfaces the missing-credential error as 502', async () => {
    insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
    const noRefs = await call('POST /api/pipelines/apps/:appId/import-confluence', {
      params: { appId: 'XPOS' },
      body: {},
    });
    expect(noRefs.status).toBe(400);

    // No CONFLUENCE_URL/PAT and no BAS gateway configured in this harness →
    // importConfluenceIntoPool throws its credential error, mapped to 502.
    const noCreds = await call('POST /api/pipelines/apps/:appId/import-confluence', {
      params: { appId: 'XPOS' },
      body: { refs: ['123'] },
    });
    expect(noCreds.status).toBe(502);
    expect(noCreds.body.error).toMatch(/credential/i);
  });

  it('explicit cancel aborts the daemon fetch and does not materialize pool pages', async () => {
    insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
    const previousUrl = process.env.CONFLUENCE_URL;
    const previousToken = process.env.CONFLUENCE_PERSONAL_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.CONFLUENCE_URL = 'https://wiki.test';
    process.env.CONFLUENCE_PERSONAL_TOKEN = 'pat';
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    globalThis.fetch = vi.fn((_url: any, init?: RequestInit) => new Promise((_resolve, reject) => {
      fetchStarted();
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
    })) as any;
    try {
      const handler = handlers.get('POST /api/pipelines/apps/:appId/import-confluence')!;
      const { res, out } = makeRes();
      const running = handler({
        params: { appId: 'XPOS' },
        body: { refs: ['123'], operationId: 'op-12345678' },
      }, res);
      await started;
      const cancelled = await call('POST /api/pipelines/apps/:appId/import-confluence/:operationId/cancel', {
        params: { appId: 'XPOS', operationId: 'op-12345678' },
      });
      expect(cancelled.body).toEqual({ ok: true, cancelled: true, phase: 'preparing' });
      await running;
      expect(out.status).toBe(499);
      expect(out.body).toMatchObject({ aborted: true });
      await expect(readManifest(tempDir, 'XPOS')).resolves.toEqual({ version: 1, pages: [] });
      await expect(stat(appDocsDir(tempDir, 'XPOS'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.CONFLUENCE_URL;
      else process.env.CONFLUENCE_URL = previousUrl;
      if (previousToken === undefined) delete process.env.CONFLUENCE_PERSONAL_TOKEN;
      else process.env.CONFLUENCE_PERSONAL_TOKEN = previousToken;
    }
  });

  it('cancel after the atomic commit boundary is too late and the route reports success', async () => {
    insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
    const previousUrl = process.env.CONFLUENCE_URL;
    const previousToken = process.env.CONFLUENCE_PERSONAL_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.CONFLUENCE_URL = 'https://wiki.test';
    process.env.CONFLUENCE_PERSONAL_TOKEN = 'pat';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      title: 'Page 123',
      body: { export_view: { value: '<p>committed</p>' }, view: { value: '<p>committed</p>' } },
      ancestors: [],
    }), { status: 200 })) as any;
    let commitStarted!: () => void;
    const atCommit = new Promise<void>((resolve) => { commitStarted = resolve; });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    onImportCommitStart = async () => {
      commitStarted();
      await commitGate;
    };
    try {
      const handler = handlers.get('POST /api/pipelines/apps/:appId/import-confluence')!;
      const { res, out } = makeRes();
      const running = handler({
        params: { appId: 'XPOS' },
        body: { refs: ['123'], operationId: 'op-commit-123' },
      }, res);
      await atCommit;
      const cancelled = await call('POST /api/pipelines/apps/:appId/import-confluence/:operationId/cancel', {
        params: { appId: 'XPOS', operationId: 'op-commit-123' },
      });
      expect(cancelled.body).toEqual({ ok: true, cancelled: false, phase: 'committing' });
      releaseCommit();
      await running;
      expect(out.status).toBe(200);
      expect(out.body.imported).toBe(1);
      const manifest = await readManifest(tempDir, 'XPOS');
      expect(manifest.pages).toHaveLength(1);
      await expect(readFile(path.join(appDocsDir(tempDir, 'XPOS'), manifest.pages[0]!.path), 'utf8'))
        .resolves.toContain('committed');
    } finally {
      globalThis.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.CONFLUENCE_URL;
      else process.env.CONFLUENCE_URL = previousUrl;
      if (previousToken === undefined) delete process.env.CONFLUENCE_PERSONAL_TOKEN;
      else process.env.CONFLUENCE_PERSONAL_TOKEN = previousToken;
    }
  });

  it('cancel arriving before import registration leaves a tombstone and prevents any fetch or mutation', async () => {
    insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const cancelled = await call('POST /api/pipelines/apps/:appId/import-confluence/:operationId/cancel', {
      params: { appId: 'XPOS', operationId: 'op-before-123' },
    });
    expect(cancelled.body).toEqual({ ok: true, cancelled: true, phase: 'queued' });
    const result = await call('POST /api/pipelines/apps/:appId/import-confluence', {
      params: { appId: 'XPOS' },
      body: { refs: ['123'], operationId: 'op-before-123' },
    });
    expect(result.status).toBe(499);
    expect(result.body).toMatchObject({ aborted: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(readManifest(tempDir, 'XPOS')).resolves.toEqual({ version: 1, pages: [] });
    fetchSpy.mockRestore();
  });

  it('an App denormalized only on a feature\'s studioConfig.appId (no pipeline_apps row) still resolves', async () => {
    const { insertProject } = await import('../src/db.js');
    insertProject(db, {
      id: 'feature-1',
      name: 'feature-1',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'pipeline', studioConfig: { appId: 'DENORM-APP' } },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const res = await call('GET /api/pipelines/apps/:appId/pool', { params: { appId: 'DENORM-APP' } });
    expect(res.status).toBe(200);
  });
});
