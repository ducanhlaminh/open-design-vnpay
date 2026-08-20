// HTTP surface of app-pool-routes.ts: same fake-express harness as
// tests/pipeline-apps-routes.test.ts (registers real handlers on a fake
// `app`, no socket bind) — app-pool-routes.ts has no server.ts-internal
// dependency, so it doesn't need the real-server harness the GATE tests use.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, insertPipelineApp, openDatabase } from '../src/db.js';
import { registerAppPoolRoutes } from '../src/app-pool-routes.js';
import { appDocsDir, readManifest, sha256, writeManifest, type AppPoolManifest } from '../src/app-pool.js';

// WP22 background-import-job tests mock `importConfluenceIntoPool` directly
// (contract .tmp/pipeline/wp22-contract.md — the per-batch loop now lives in
// app-pool-routes.ts, so exercising it through the real Confluence fetch
// path per batch would mean re-deriving the fixture-server dance the OTHER
// tests in this file already do, times 3 batches). Every other export stays
// real; the default implementation delegates to the real function too, so
// every OLDER test below (which never touches this mock) is unaffected.
vi.mock('../src/app-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app-pool.js')>();
  return { ...actual, importConfluenceIntoPool: vi.fn(actual.importConfluenceIntoPool) };
});
import { importConfluenceIntoPool } from '../src/app-pool.js';
const realImportConfluenceIntoPool = (
  await vi.importActual<typeof import('../src/app-pool.js')>('../src/app-pool.js')
).importConfluenceIntoPool;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flushes the microtask queue (real timers only — callers using fake timers
 *  must switch back first) so a fire-and-forget `runImportJob` loop gets a
 *  turn to run before the test asserts on job state. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Polls a real (setTimeout-based) predicate until it's true or `timeoutMs`
 *  elapses. Used where a single `flush()` tick isn't a strong enough
 *  guarantee — e.g. waiting for `runImportJob`'s post-status-flip
 *  `versionAfterMutation` (real disk I/O) to actually finish before the test
 *  ends and the outer `afterEach` deletes `tempDir` out from under it. */
async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

  describe('background import jobs (WP22)', () => {
    beforeEach(() => {
      // The mock's call HISTORY is shared across every `it` in this file
      // (the outer tests above call through it too, via the delegate-to-real
      // default) — clear it here so each job test's `toHaveBeenCalledTimes`
      // assertions count only its own calls.
      vi.mocked(importConfluenceIntoPool).mockClear();
    });

    afterEach(() => {
      vi.mocked(importConfluenceIntoPool).mockReset();
      vi.mocked(importConfluenceIntoPool).mockImplementation(realImportConfluenceIntoPool);
      vi.useRealTimers();
    });

    /** Writes one real page under the App's pool docs dir — makes the App
     *  Context content digest actually change, so `versionAfterMutation`'s
     *  effect (a new `context/versions/vN`) is observable without needing to
     *  intercept the call itself. */
    async function writeFakePoolFile(appId: string, relPath: string, content: string) {
      const target = path.join(appDocsDir(tempDir, appId), relPath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    async function contextVersionDirs(appId: string): Promise<string[]> {
      return readdir(path.join(tempDir, appId, 'context', 'versions')).catch(() => []);
    }

    it('(a) 202s a running job, done grows per batch as they commit, ends succeeded with cumulative imported/updated', async () => {
      insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
      const refs = Array.from({ length: 12 }, (_, i) => String(i + 1));
      const batch1 = deferred<{ imported: number; updated: number; pages: never[] }>();
      const batch2 = deferred<{ imported: number; updated: number; pages: never[] }>();
      const mock = vi.mocked(importConfluenceIntoPool);
      mock.mockImplementationOnce(async () => batch1.promise);
      mock.mockImplementationOnce(async () => batch2.promise);

      const start = await call('POST /api/pipelines/apps/:appId/import-confluence/start', {
        params: { appId: 'XPOS' },
        body: { refs },
      });
      expect(start.status).toBe(202);
      expect(start.body.job).toMatchObject({
        appId: 'XPOS',
        status: 'running',
        phase: 'preparing',
        done: 0,
        total: 12,
        imported: 0,
        updated: 0,
      });
      const jobId = start.body.job.id;

      batch1.resolve({ imported: 3, updated: 1, pages: [] });
      await flush();
      let polled = await call('GET /api/pipelines/apps/:appId/import-jobs/:jobId', { params: { appId: 'XPOS', jobId } });
      expect(polled.body.job).toMatchObject({ status: 'running', done: 8, imported: 3, updated: 1 });

      batch2.resolve({ imported: 2, updated: 0, pages: [] });
      await flush();
      polled = await call('GET /api/pipelines/apps/:appId/import-jobs/:jobId', { params: { appId: 'XPOS', jobId } });
      expect(polled.body.job).toMatchObject({ status: 'succeeded', done: 12, imported: 5, updated: 1 });
      expect(polled.body.job.phase).toBeUndefined();
      expect(polled.body.job.finishedAt).toBeTypeOf('number');
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('(b) splits 20 refs into 8/8/4 batches, in order, and calls versionAfterMutation once for the whole job (not per batch)', async () => {
      insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
      const refs = Array.from({ length: 20 }, (_, i) => String(i + 1));
      const mock = vi.mocked(importConfluenceIntoPool);
      let batchIndex = 0;
      mock.mockImplementation(async () => {
        batchIndex += 1;
        await writeFakePoolFile('XPOS', `branch/page-${batchIndex}.md`, `# batch ${batchIndex}`);
        return { imported: 1, updated: 0, pages: [] };
      });

      const start = await call('POST /api/pipelines/apps/:appId/import-confluence/start', {
        params: { appId: 'XPOS' },
        body: { refs },
      });
      expect(start.status).toBe(202);
      const jobId = start.body.job.id;
      await waitFor(async () => {
        const polled = await call('GET /api/pipelines/apps/:appId/import-jobs/:jobId', { params: { appId: 'XPOS', jobId } });
        return polled.body.job.status !== 'running';
      });
      // Job status flips before the post-loop versionAfterMutation call
      // (which does real disk I/O) — wait for its effect too so the test
      // doesn't race the outer afterEach's tempDir cleanup.
      await waitFor(async () => (await contextVersionDirs('XPOS')).length > 0);

      const calledRefs = mock.mock.calls.map((args) => (args[0] as { refs: string[] }).refs);
      expect(calledRefs).toEqual([refs.slice(0, 8), refs.slice(8, 16), refs.slice(16, 20)]);

      const polled = await call('GET /api/pipelines/apps/:appId/import-jobs/:jobId', { params: { appId: 'XPOS', jobId } });
      expect(polled.body.job.status).toBe('succeeded');
      expect(polled.body.job.done).toBe(20);
      expect(polled.body.job.imported).toBe(3);
      // 3 successful batches, each writing DIFFERENT content — if
      // versionAfterMutation ran once per batch instead of once at job end,
      // this would be 3 (v1, v2, v3) instead of 1.
      expect(await contextVersionDirs('XPOS')).toEqual(['v1']);
    });

    it('(c) a failing second batch marks the job failed with the batch error, keeps done at the first batch, and still versions once', async () => {
      insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
      const refs = Array.from({ length: 16 }, (_, i) => String(i + 1));
      const mock = vi.mocked(importConfluenceIntoPool);
      mock.mockImplementationOnce(async () => {
        await writeFakePoolFile('XPOS', 'branch/page-1.md', '# batch 1');
        return { imported: 4, updated: 1, pages: [] };
      });
      mock.mockImplementationOnce(async () => {
        throw new Error('batch 2 boom');
      });

      const start = await call('POST /api/pipelines/apps/:appId/import-confluence/start', {
        params: { appId: 'XPOS' },
        body: { refs },
      });
      const jobId = start.body.job.id;
      await waitFor(async () => {
        const polled = await call('GET /api/pipelines/apps/:appId/import-jobs/:jobId', { params: { appId: 'XPOS', jobId } });
        return polled.body.job.status !== 'running';
      });
      await waitFor(async () => (await contextVersionDirs('XPOS')).length > 0);

      const polled = await call('GET /api/pipelines/apps/:appId/import-jobs/:jobId', { params: { appId: 'XPOS', jobId } });
      expect(polled.body.job.status).toBe('failed');
      expect(polled.body.job.error).toMatch(/batch 2 boom/);
      expect(polled.body.job.done).toBe(8);
      expect(polled.body.job.imported).toBe(4);
      expect(polled.body.job.updated).toBe(1);
      // The failure must not skip versioning the one batch that DID commit.
      expect(await contextVersionDirs('XPOS')).toEqual(['v1']);
    });

    it('(d) cancel while preparing aborts the in-flight batch and marks the job cancelled; re-cancelling a finished job is idempotent', async () => {
      insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
      const mock = vi.mocked(importConfluenceIntoPool);
      let sawAbort!: () => void;
      const aborted = new Promise<void>((resolve) => {
        sawAbort = resolve;
      });
      mock.mockImplementationOnce(
        (opts: any) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener(
              'abort',
              () => {
                sawAbort();
                reject(opts.signal.reason ?? new DOMException('aborted', 'AbortError'));
              },
              { once: true },
            );
          }),
      );

      const start = await call('POST /api/pipelines/apps/:appId/import-confluence/start', {
        params: { appId: 'XPOS' },
        body: { refs: ['1'] },
      });
      const jobId = start.body.job.id;

      const cancelRes = await call('POST /api/pipelines/apps/:appId/import-jobs/:jobId/cancel', {
        params: { appId: 'XPOS', jobId },
      });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.ok).toBe(true);
      await aborted;
      await flush();

      const polled = await call('GET /api/pipelines/apps/:appId/import-jobs/:jobId', { params: { appId: 'XPOS', jobId } });
      expect(polled.body.job.status).toBe('cancelled');
      expect(polled.body.job.done).toBe(0);

      const cancelAgain = await call('POST /api/pipelines/apps/:appId/import-jobs/:jobId/cancel', {
        params: { appId: 'XPOS', jobId },
      });
      expect(cancelAgain.status).toBe(200);
      expect(cancelAgain.body).toEqual({ ok: true, job: polled.body.job });
    });

    it('(d2) cancel while committing lets the in-flight batch finish (atomic commit) and stops after it', async () => {
      insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
      const mock = vi.mocked(importConfluenceIntoPool);
      let commitStarted!: () => void;
      const atCommit = new Promise<void>((resolve) => {
        commitStarted = resolve;
      });
      let releaseCommit!: () => void;
      const commitGate = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      mock.mockImplementationOnce(async (opts: any) => {
        await opts.onCommitStart?.();
        commitStarted();
        await commitGate;
        return { imported: 1, updated: 0, pages: [] };
      });

      // 10 refs → batch 1 (8 refs, the one we gate on commit) + batch 2 (2
      // refs) — only with a real second batch pending can this test tell
      // "let the in-flight batch finish, then stop" apart from "the job
      // simply had nothing left to do".
      const refs = Array.from({ length: 10 }, (_, i) => String(i + 1));
      const start = await call('POST /api/pipelines/apps/:appId/import-confluence/start', {
        params: { appId: 'XPOS' },
        body: { refs },
      });
      const jobId = start.body.job.id;
      await atCommit;

      const cancelRes = await call('POST /api/pipelines/apps/:appId/import-jobs/:jobId/cancel', {
        params: { appId: 'XPOS', jobId },
      });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.job.status).toBe('running');

      releaseCommit();
      await flush();
      const polled = await call('GET /api/pipelines/apps/:appId/import-jobs/:jobId', { params: { appId: 'XPOS', jobId } });
      expect(polled.body.job.status).toBe('cancelled');
      // done=8: batch 1 (the only one that ran) committed all 8 of its refs;
      // batch 2 (refs 9-10) never started.
      expect(polled.body.job.done).toBe(8);
      expect(polled.body.job.imported).toBe(1);
      // If cancel-during-commit incorrectly let batch 2 start too, this
      // would be 2 (real importConfluenceIntoPool would then also throw on
      // missing Confluence creds, since only 1 mockImplementationOnce was
      // queued — a second, unrelated failure this assertion is not about).
      expect(mock).toHaveBeenCalledTimes(1);
    });

    it('(e) a running job 409s a second job start AND the sync route for the same App, and vice versa', async () => {
      insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
      // Second half uses its own App: once job1 below resolves, its
      // `finally` block kicks off a real (unmocked-fs) versionAfterMutation
      // write for XPOS in the background — reusing XPOS for the reverse
      // check too risks a filesystem race between that still-in-flight write
      // and the reverse scenario's own versionAfterMutation call.
      insertPipelineApp(db, { id: 'YPAY', name: 'Y Pay', createdAt: Date.now() });
      const mock = vi.mocked(importConfluenceIntoPool);
      const gate1 = deferred<{ imported: number; updated: number; pages: never[] }>();
      mock.mockImplementationOnce(async () => gate1.promise);

      const start = await call('POST /api/pipelines/apps/:appId/import-confluence/start', {
        params: { appId: 'XPOS' },
        body: { refs: ['1'] },
      });
      expect(start.status).toBe(202);

      const secondStart = await call('POST /api/pipelines/apps/:appId/import-confluence/start', {
        params: { appId: 'XPOS' },
        body: { refs: ['2'] },
      });
      expect(secondStart.status).toBe(409);

      const syncDuringJob = await call('POST /api/pipelines/apps/:appId/import-confluence', {
        params: { appId: 'XPOS' },
        body: { refs: ['3'] },
      });
      expect(syncDuringJob.status).toBe(409);

      gate1.resolve({ imported: 0, updated: 0, pages: [] });
      // Wait for job1's post-status-flip versionAfterMutation (real disk
      // I/O) to actually settle before moving on, so it can never race the
      // reverse-direction scenario's own write or the outer afterEach's
      // tempDir cleanup.
      await waitFor(async () => (await contextVersionDirs('XPOS')).length > 0);

      // Reverse direction (separate App): the sync route holding the lock
      // also blocks a job start for THAT App.
      const gate2 = deferred<{ imported: number; updated: number; pages: never[] }>();
      mock.mockImplementationOnce(async () => gate2.promise);
      const syncHandler = handlers.get('POST /api/pipelines/apps/:appId/import-confluence')!;
      const { res: syncRes, out: syncOut } = makeRes();
      const runningSync = syncHandler({ params: { appId: 'YPAY' }, body: { refs: ['4'] } }, syncRes);

      const jobDuringSync = await call('POST /api/pipelines/apps/:appId/import-confluence/start', {
        params: { appId: 'YPAY' },
        body: { refs: ['5'] },
      });
      expect(jobDuringSync.status).toBe(409);

      gate2.resolve({ imported: 0, updated: 0, pages: [] });
      await runningSync;
      expect(syncOut.status).toBe(200);
    });

    it('validates like the sync route (404 unknown app, 400 empty refs) and 404s an unknown job id', async () => {
      const notFound = await call('POST /api/pipelines/apps/:appId/import-confluence/start', {
        params: { appId: 'ghost' },
        body: { refs: ['1'] },
      });
      expect(notFound.status).toBe(404);

      insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
      const noRefs = await call('POST /api/pipelines/apps/:appId/import-confluence/start', {
        params: { appId: 'XPOS' },
        body: {},
      });
      expect(noRefs.status).toBe(400);

      const unknownJob = await call('GET /api/pipelines/apps/:appId/import-jobs/:jobId', {
        params: { appId: 'XPOS', jobId: 'nope' },
      });
      expect(unknownJob.status).toBe(404);

      const unknownCancel = await call('POST /api/pipelines/apps/:appId/import-jobs/:jobId/cancel', {
        params: { appId: 'XPOS', jobId: 'nope' },
      });
      expect(unknownCancel.status).toBe(404);
    });

    it('(f) the active listing includes running + just-finished jobs and prunes ones past the 10-minute TTL', async () => {
      insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
      insertPipelineApp(db, { id: 'YPAY', name: 'Y Pay', createdAt: Date.now() });
      const mock = vi.mocked(importConfluenceIntoPool);

      mock.mockImplementationOnce(async () => ({ imported: 1, updated: 0, pages: [] }));
      const start1 = await call('POST /api/pipelines/apps/:appId/import-confluence/start', {
        params: { appId: 'XPOS' },
        body: { refs: ['1'] },
      });
      await flush();
      const job1Id = start1.body.job.id;
      const polled1 = await call('GET /api/pipelines/apps/:appId/import-jobs/:jobId', { params: { appId: 'XPOS', jobId: job1Id } });
      expect(polled1.body.job.status).toBe('succeeded');

      const gate2 = deferred<{ imported: number; updated: number; pages: never[] }>();
      mock.mockImplementationOnce(async () => gate2.promise);
      const start2 = await call('POST /api/pipelines/apps/:appId/import-confluence/start', {
        params: { appId: 'YPAY' },
        body: { refs: ['2'] },
      });
      const job2Id = start2.body.job.id;

      let active = await call('GET /api/pipelines/app-import-jobs/active', {});
      expect((active.body.jobs as Array<{ id: string }>).map((j) => j.id).sort()).toEqual([job1Id, job2Id].sort());

      const finishedAt = polled1.body.job.finishedAt as number;
      vi.useFakeTimers();
      vi.setSystemTime(finishedAt + 10 * 60_000 + 1);
      active = await call('GET /api/pipelines/app-import-jobs/active', {});
      expect((active.body.jobs as Array<{ id: string }>).map((j) => j.id)).toEqual([job2Id]);

      vi.useRealTimers();
      gate2.resolve({ imported: 0, updated: 0, pages: [] });
      await flush();
    });

    it('(g) leaves the sync route and its operationId-cancel route behaviorally unchanged (regression guard)', async () => {
      // The pre-existing sync-route tests above already exercise this in
      // depth; this is a light smoke check scoped to the new describe block
      // so a future edit that accidentally routes the sync path through the
      // job machinery fails loudly here too.
      insertPipelineApp(db, { id: 'XPOS', name: 'X POS', createdAt: Date.now() });
      const mock = vi.mocked(importConfluenceIntoPool);
      mock.mockImplementationOnce(async () => ({ imported: 1, updated: 0, pages: [] }));
      const res = await call('POST /api/pipelines/apps/:appId/import-confluence', {
        params: { appId: 'XPOS' },
        body: { refs: ['1'] },
      });
      expect(res.status).toBe(200);
      expect(res.body.imported).toBe(1);
      // The sync route never registers a job.
      const active = await call('GET /api/pipelines/app-import-jobs/active', {});
      expect(active.body.jobs).toEqual([]);
    });
  });
});
