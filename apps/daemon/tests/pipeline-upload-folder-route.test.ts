// POST /api/pipelines/upload-folder — bulk folder upload for docs stages, now
// on EVERY workflow (docs-to-ui/docs-to-prd/docs-review, all three ingest
// stages `acceptsUpload: true`), not just docs-review. Writes go through the
// SAME `writeProjectFile` (projects.ts) helper /api/projects/:id/files uses,
// into `<projectDir>/<docsDir>/<path>` where `docsDir` is resolved via the
// canonical `workflowDirForPipeline` helper (`docsDirForWorkflow` in
// pipeline-routes.ts) — the SAME resolution the real run path uses — not a
// hand-rolled `${workflowId}/docs/` literal. Also covers GET /api/workflows'
// new `docsDir` field, which the FE's single-file upload path needs to build
// the right target name per workflow.
//
// Same harness as tests/pipeline-app-docs-tree-routes.test.ts: fake express
// app that records handlers by "METHOD path", real SQLite + real filesystem
// in a temp dir (registerPipelineRoutes writes for real here — no fs mocks —
// since the whole point of this route is the on-disk write).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, getProject, insertProject, openDatabase } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';

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

describe('POST /api/pipelines/upload-folder', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-upload-folder-'));
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

  const uploadFolder = (body: unknown) => call('POST /api/pipelines/upload-folder', { body });

  function insertPipelineProject(id: string) {
    const now = Date.now();
    insertProject(db, {
      id,
      name: id,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'pipeline' },
      createdAt: now,
      updatedAt: now,
    });
  }

  function readWrittenFile(projectId: string, workflowId: string, relPath: string): string {
    return readFileSync(path.join(tempDir, projectId, workflowId, 'docs', relPath), 'utf8');
  }

  it('404s an unknown project', async () => {
    const res = await uploadFolder({
      projectId: 'nope',
      workflowId: 'docs-review',
      files: [{ path: 'a.md', text: 'hi' }],
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/);
  });

  it('400s an unknown workflowId', async () => {
    insertPipelineProject('xpos-checkout');
    const res = await uploadFolder({
      projectId: 'xpos-checkout',
      workflowId: 'not-a-real-workflow',
      files: [{ path: 'a.md', text: 'hi' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown workflowId/);
  });

  it('400s when projectId or workflowId is missing', async () => {
    expect((await uploadFolder({ workflowId: 'docs-review', files: [] })).status).toBe(400);
    insertPipelineProject('xpos-checkout');
    expect((await uploadFolder({ projectId: 'xpos-checkout', files: [] })).status).toBe(400);
  });

  it('400s when files is missing or empty', async () => {
    insertPipelineProject('xpos-checkout');
    const res = await uploadFolder({ projectId: 'xpos-checkout', workflowId: 'docs-review', files: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/files are required/);
  });

  it('happy path: writes text + base64 files (mixed, nested dirs) under <workflowId>/docs/', async () => {
    insertPipelineProject('xpos-checkout');
    const res = await uploadFolder({
      projectId: 'xpos-checkout',
      workflowId: 'docs-review',
      files: [
        { path: 'overview.md', text: '# Overview\nhello' },
        { path: 'nested/sub/dir/page.md', text: '# Nested' },
        { path: 'images/logo.png', base64: Buffer.from('fake-png-bytes').toString('base64') },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: 3, skipped: [] });
    expect(readWrittenFile('xpos-checkout', 'docs-review', 'overview.md')).toBe('# Overview\nhello');
    expect(readWrittenFile('xpos-checkout', 'docs-review', 'nested/sub/dir/page.md')).toBe('# Nested');
    expect(readWrittenFile('xpos-checkout', 'docs-review', 'images/logo.png')).toBe('fake-png-bytes');
  });

  it('re-upload overwrites an existing file at the same path (same semantics as /api/projects/:id/files)', async () => {
    insertPipelineProject('xpos-checkout');
    await uploadFolder({
      projectId: 'xpos-checkout',
      workflowId: 'docs-review',
      files: [{ path: 'overview.md', text: 'v1' }],
    });
    const res = await uploadFolder({
      projectId: 'xpos-checkout',
      workflowId: 'docs-review',
      files: [{ path: 'overview.md', text: 'v2' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: 1, skipped: [] });
    expect(readWrittenFile('xpos-checkout', 'docs-review', 'overview.md')).toBe('v2');
  });

  it('skips (never 500s) an absolute path, a ../ traversal, a backslash path, and an empty path — writes the rest', async () => {
    insertPipelineProject('xpos-checkout');
    const res = await uploadFolder({
      projectId: 'xpos-checkout',
      workflowId: 'docs-review',
      files: [
        { path: '/etc/passwd.md', text: 'nope' },
        { path: '../../escape.md', text: 'nope' },
        { path: 'sub\\dir\\file.md', text: 'nope' },
        { path: '', text: 'nope' },
        { path: 'good.md', text: 'ok' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(1);
    expect(res.body.skipped).toHaveLength(4);
    const reasons = Object.fromEntries(res.body.skipped.map((s: any) => [s.path, s.reason]));
    expect(reasons['/etc/passwd.md']).toMatch(/absolute/);
    expect(reasons['../../escape.md']).toMatch(/traversal/);
    expect(reasons['sub\\dir\\file.md']).toMatch(/backslash/);
    expect(reasons['']).toMatch(/empty path/);
    expect(readWrittenFile('xpos-checkout', 'docs-review', 'good.md')).toBe('ok');
  });

  it('skips a path with an empty segment (double slash / trailing slash)', async () => {
    insertPipelineProject('xpos-checkout');
    const res = await uploadFolder({
      projectId: 'xpos-checkout',
      workflowId: 'docs-review',
      files: [{ path: 'a//b.md', text: 'x' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: 0, skipped: [{ path: 'a//b.md', reason: 'empty path segment' }] });
  });

  it('skips a disallowed extension, keeps the allowlisted siblings', async () => {
    insertPipelineProject('xpos-checkout');
    const res = await uploadFolder({
      projectId: 'xpos-checkout',
      workflowId: 'docs-review',
      files: [
        { path: 'script.exe', text: 'nope' },
        { path: 'no-extension', text: 'nope' },
        { path: 'doc.md', text: 'ok' },
        { path: 'sheet.csv', text: 'a,b\n1,2' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(2);
    const reasons = Object.fromEntries(res.body.skipped.map((s: any) => [s.path, s.reason]));
    expect(reasons['script.exe']).toMatch(/extension not allowed: \.exe/);
    expect(reasons['no-extension']).toMatch(/extension not allowed: \(none\)/);
  });

  it('skips a file with neither text nor base64, and one with both', async () => {
    insertPipelineProject('xpos-checkout');
    const res = await uploadFolder({
      projectId: 'xpos-checkout',
      workflowId: 'docs-review',
      files: [
        { path: 'neither.md' },
        { path: 'both.md', text: 'a', base64: 'YQ==' },
        { path: 'ok.md', text: 'ok' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(1);
    const reasons = Object.fromEntries(res.body.skipped.map((s: any) => [s.path, s.reason]));
    expect(reasons['neither.md']).toMatch(/exactly one of text or base64/);
    expect(reasons['both.md']).toMatch(/exactly one of text or base64/);
  });

  it('400s when the request has more than 300 files (no partial write)', async () => {
    insertPipelineProject('xpos-checkout');
    const files = Array.from({ length: 301 }, (_, i) => ({ path: `f${i}.md`, text: 'x' }));
    const res = await uploadFolder({ projectId: 'xpos-checkout', workflowId: 'docs-review', files });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too many files/);
  });

  it('400s when a single file exceeds 10MB (no partial write)', async () => {
    insertPipelineProject('xpos-checkout');
    const bigText = 'a'.repeat(10 * 1024 * 1024 + 1);
    const res = await uploadFolder({
      projectId: 'xpos-checkout',
      workflowId: 'docs-review',
      files: [
        { path: 'small.md', text: 'ok' },
        { path: 'huge.md', text: bigText },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/);
    // Nothing partially written — not even the small file that came first.
    expect(() => readWrittenFile('xpos-checkout', 'docs-review', 'small.md')).toThrow();
  });

  it('400s when the total request exceeds 80MB even though every individual file is under the 10MB cap', async () => {
    insertPipelineProject('xpos-checkout');
    // 9 files * ~9.4MB = ~84.6MB > 80MB cap; each file individually < 10MB.
    const perFile = 9_400_000;
    const files = Array.from({ length: 9 }, (_, i) => ({ path: `part${i}.md`, text: 'a'.repeat(perFile) }));
    const res = await uploadFolder({ projectId: 'xpos-checkout', workflowId: 'docs-review', files });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/80.*bytes total|exceeds/i);
    expect(() => readWrittenFile('xpos-checkout', 'docs-review', 'part0.md')).toThrow();
  });

  // The critical fix: the route resolves the REAL wfDir via
  // workflowDirForPipeline (docsDirForWorkflow) instead of assuming
  // `${workflowId}/docs/`. Traced against server.ts's `runPipeline`: `docs`
  // (docs-to-ui) and `prd-docs` (docs-to-prd) both carry `inputPlaceholder`,
  // which short-circuits `resolveRunTargetDir` to null (no `<target>/`
  // nesting ever applies to an ingest stage) — so `wfDir` for all three real
  // workflows' own pipelines is `workflowDirForPipeline(pipelineId)`, which is
  // ALWAYS that pipeline's own workflow id (workflowForPipeline(...)?.id).
  // None of the three resolve to the cwd root; these tests assert the
  // resolved dir explicitly rather than assuming it.
  it('lands an upload to docs-to-ui at <projectDir>/docs-to-ui/docs/ (workflowDirForPipeline("docs") === "docs-to-ui")', async () => {
    insertPipelineProject('xpos-checkout');
    const res = await uploadFolder({
      projectId: 'xpos-checkout',
      workflowId: 'docs-to-ui',
      files: [{ path: 'overview.md', text: '# UI docs' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: 1, skipped: [] });
    expect(readWrittenFile('xpos-checkout', 'docs-to-ui', 'overview.md')).toBe('# UI docs');
  });

  it('lands an upload to docs-to-prd at <projectDir>/docs-to-prd/docs/ (workflowDirForPipeline("prd-docs") === "docs-to-prd")', async () => {
    insertPipelineProject('xpos-checkout');
    const res = await uploadFolder({
      projectId: 'xpos-checkout',
      workflowId: 'docs-to-prd',
      files: [{ path: 'overview.md', text: '# PRD docs' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: 1, skipped: [] });
    expect(readWrittenFile('xpos-checkout', 'docs-to-prd', 'overview.md')).toBe('# PRD docs');
  });

  describe('GET /api/workflows', () => {
    it('carries docsDir per workflow, matching the real wfDir the upload-folder route writes into', async () => {
      const res = await call('GET /api/workflows');
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.workflows.map((w: any) => [w.id, w.docsDir]));
      expect(byId).toEqual({
        'docs-to-ui': 'docs-to-ui/docs',
        'docs-to-prd': 'docs-to-prd/docs',
        'docs-review': 'docs-review/docs',
      });
    });
  });
});
