// POST /api/pipelines/apps/:appId/upload-folder + GET .../docs-files —
// App-LEVEL doc corpus upload (retargeted from the earlier workflow-level
// design: the App owns the docs corpus, not any one pipeline run; a
// feature's run-config later PICKS files out of it via the `app-files`
// source — see tests/pipeline-app-files-run-source.test.ts).
//
// Writes land at <PROJECTS_DIR>/<appId>/docs/<path> via the SAME
// `writeProjectFile` (projects.ts) helper /api/projects/:id/files uses.
// `appId` must be a LOCAL `pipeline_apps` row (404 otherwise) — apps aren't
// project rows, so this route never touches `getProject`.
//
// NO extension allowlist (removed per real-export feedback: a Confluence
// "export to MD" folder mixes genuine extensionless documents with export
// artifacts like .tmp/.html — both must upload untouched). Path safety
// (absolute/../backslash/empty-segment) + size caps are the only gates.
//
// Same fake-express harness as tests/pipeline-app-docs-tree-routes.test.ts:
// records handlers by "METHOD path", real SQLite + real filesystem in a temp
// dir (registerPipelineRoutes writes for real here — no fs mocks).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, openDatabase } from '../src/db.js';
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

describe('App-level doc corpus upload (POST .../upload-folder, GET .../docs-files)', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-app-upload-'));
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
  const uploadFolder = (appId: string, files: unknown) =>
    call('POST /api/pipelines/apps/:appId/upload-folder', { params: { appId }, body: { files } });
  const docsFiles = (appId: string) =>
    call('GET /api/pipelines/apps/:appId/docs-files', { params: { appId } });

  async function createApp(appId: string) {
    expect((await postApp({ appId, name: appId })).status).toBe(201);
  }

  function readWrittenFile(appId: string, relPath: string): string {
    return readFileSync(path.join(tempDir, appId, 'docs', relPath), 'utf8');
  }

  it('404s an unknown app', async () => {
    const res = await uploadFolder('nope', [{ path: 'a.md', text: 'hi' }]);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/);
  });

  it('400s when files is missing or empty', async () => {
    await createApp('XPOS');
    const res = await uploadFolder('XPOS', []);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/files are required/);
  });

  it('happy path: writes text + base64 files (mixed, nested dirs) under <appId>/docs/', async () => {
    await createApp('XPOS');
    const res = await uploadFolder('XPOS', [
      { path: 'overview.md', text: '# Overview\nhello' },
      { path: 'nested/sub/dir/page.md', text: '# Nested' },
      { path: 'images/logo.png', base64: Buffer.from('fake-png-bytes').toString('base64') },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: 3, skipped: [] });
    expect(readWrittenFile('XPOS', 'overview.md')).toBe('# Overview\nhello');
    expect(readWrittenFile('XPOS', 'nested/sub/dir/page.md')).toBe('# Nested');
    expect(readWrittenFile('XPOS', 'images/logo.png')).toBe('fake-png-bytes');
  });

  it('accepts an extensionless file AND a .tmp export artifact — no extension allowlist', async () => {
    await createApp('XPOS');
    // No spaces in the path: writeProjectFile's own sanitizeName (shared with
    // every other project-file write path) collapses whitespace to '-'
    // regardless of this route — an orthogonal, pre-existing behavior, not
    // what this test is checking.
    const res = await uploadFolder('XPOS', [
      { path: 'SDMH_Them-sua-giay-bao-no_V1', text: 'a real document with no extension' },
      { path: 'export/page1.tmp', text: 'export-tool scratch artifact' },
      { path: 'export/page1.render', text: 'export-tool render artifact' },
      { path: 'export/page1.tfss', text: 'export-tool tfss artifact' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: 4, skipped: [] });
    expect(readWrittenFile('XPOS', 'SDMH_Them-sua-giay-bao-no_V1')).toBe('a real document with no extension');
    expect(readWrittenFile('XPOS', 'export/page1.tmp')).toBe('export-tool scratch artifact');
    expect(readWrittenFile('XPOS', 'export/page1.tfss')).toBe('export-tool tfss artifact');
  });

  it('re-upload overwrites an existing file at the same path (same semantics as /api/projects/:id/files)', async () => {
    await createApp('XPOS');
    await uploadFolder('XPOS', [{ path: 'overview.md', text: 'v1' }]);
    const res = await uploadFolder('XPOS', [{ path: 'overview.md', text: 'v2' }]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: 1, skipped: [] });
    expect(readWrittenFile('XPOS', 'overview.md')).toBe('v2');
  });

  it('skips (never 500s) an absolute path, a ../ traversal, a backslash path, and an empty path — writes the rest', async () => {
    await createApp('XPOS');
    const res = await uploadFolder('XPOS', [
      { path: '/etc/passwd.md', text: 'nope' },
      { path: '../../escape.md', text: 'nope' },
      { path: 'sub\\dir\\file.md', text: 'nope' },
      { path: '', text: 'nope' },
      { path: 'good.md', text: 'ok' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(1);
    expect(res.body.skipped).toHaveLength(4);
    const reasons = Object.fromEntries(res.body.skipped.map((s: any) => [s.path, s.reason]));
    expect(reasons['/etc/passwd.md']).toMatch(/absolute/);
    expect(reasons['../../escape.md']).toMatch(/traversal/);
    expect(reasons['sub\\dir\\file.md']).toMatch(/backslash/);
    expect(reasons['']).toMatch(/empty path/);
    expect(readWrittenFile('XPOS', 'good.md')).toBe('ok');
  });

  it('skips a path with an empty segment (double slash / trailing slash)', async () => {
    await createApp('XPOS');
    const res = await uploadFolder('XPOS', [{ path: 'a//b.md', text: 'x' }]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: 0, skipped: [{ path: 'a//b.md', reason: 'empty path segment' }] });
  });

  it('skips a file with neither text nor base64, and one with both', async () => {
    await createApp('XPOS');
    const res = await uploadFolder('XPOS', [
      { path: 'neither.md' },
      { path: 'both.md', text: 'a', base64: 'YQ==' },
      { path: 'ok.md', text: 'ok' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(1);
    const reasons = Object.fromEntries(res.body.skipped.map((s: any) => [s.path, s.reason]));
    expect(reasons['neither.md']).toMatch(/exactly one of text or base64/);
    expect(reasons['both.md']).toMatch(/exactly one of text or base64/);
  });

  it('400s when the request has more than 300 files (no partial write)', async () => {
    await createApp('XPOS');
    const files = Array.from({ length: 301 }, (_, i) => ({ path: `f${i}.md`, text: 'x' }));
    const res = await uploadFolder('XPOS', files);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too many files/);
  });

  it('400s when a single file exceeds 10MB (no partial write)', async () => {
    await createApp('XPOS');
    const bigText = 'a'.repeat(10 * 1024 * 1024 + 1);
    const res = await uploadFolder('XPOS', [
      { path: 'small.md', text: 'ok' },
      { path: 'huge.md', text: bigText },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/);
    expect(() => readWrittenFile('XPOS', 'small.md')).toThrow();
  });

  it('400s when the total request exceeds 80MB even though every individual file is under the 10MB cap', async () => {
    await createApp('XPOS');
    const perFile = 9_400_000;
    const files = Array.from({ length: 9 }, (_, i) => ({ path: `part${i}.md`, text: 'a'.repeat(perFile) }));
    const res = await uploadFolder('XPOS', files);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/80.*bytes total|exceeds/i);
    expect(() => readWrittenFile('XPOS', 'part0.md')).toThrow();
  });

  describe('GET /api/pipelines/apps/:appId/docs-files', () => {
    it('404s an unknown app', async () => {
      const res = await docsFiles('nope');
      expect(res.status).toBe(404);
    });

    it('lists every uploaded file recursively, relative to docs/, sorted by path, with a fallback title on short .md content', async () => {
      await createApp('XPOS');
      await uploadFolder('XPOS', [
        { path: 'overview.md', text: '12345' },
        { path: 'nested/sub/page.md', text: '1234567890' },
        { path: 'attachments/img.png', base64: Buffer.from('abc').toString('base64') },
      ]);
      const res = await docsFiles('XPOS');
      expect(res.status).toBe(200);
      // Both .md files' single-line content qualifies as a fallback title
      // (non-empty, <200 chars, not image/link-only) — see the dedicated
      // "docs-files title extraction" describe block below for the heading
      // and no-title cases.
      expect(res.body).toEqual({
        files: [
          { path: 'attachments/img.png', size: 3 },
          { path: 'nested/sub/page.md', size: 10, title: '1234567890' },
          { path: 'overview.md', size: 5, title: '12345' },
        ],
      });
    });

    it('returns an empty list for an app with no uploads yet', async () => {
      await createApp('XPOS');
      const res = await docsFiles('XPOS');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ files: [] });
    });

    // Confluence's "export to MD" slugifies filenames (diacritics dropped) —
    // the real title survives INSIDE the file as its first heading. Files are
    // never renamed on disk (other exported .md files cross-reference the
    // slug paths); `title` is a display-only field layered onto the listing.
    describe('title extraction (.md/.markdown only, first ~2KB)', () => {
      async function titleOf(appId: string, relPath: string): Promise<string | undefined> {
        const res = await docsFiles(appId);
        expect(res.status).toBe(200);
        const entry = res.body.files.find((f: any) => f.path === relPath);
        expect(entry, `${relPath} should be listed`).toBeDefined();
        return entry.title;
      }

      it('extracts the first ATX heading, stripping trailing #s/whitespace', async () => {
        await createApp('XPOS');
        await uploadFolder('XPOS', [
          { path: '1-tng-quan-h-thng.md', text: '# Tổng quan hệ thống\n\nNội dung...' },
        ]);
        expect(await titleOf('XPOS', '1-tng-quan-h-thng.md')).toBe('Tổng quan hệ thống');
      });

      it('strips a closing-hash ATX heading (## Title ##)', async () => {
        await createApp('XPOS');
        await uploadFolder('XPOS', [{ path: 'closed.md', text: '## Nguyên tắc chung ##\n\nbody' }]);
        expect(await titleOf('XPOS', 'closed.md')).toBe('Nguyên tắc chung');
      });

      it('finds a heading that is not on the very first line (blank/front-matter lines before it)', async () => {
        await createApp('XPOS');
        await uploadFolder('XPOS', [{ path: 'delayed.md', text: '\n\n### Luồng chung\ntext' }]);
        expect(await titleOf('XPOS', 'delayed.md')).toBe('Luồng chung');
      });

      it('falls back to the first non-empty text line when there is no heading', async () => {
        await createApp('XPOS');
        await uploadFolder('XPOS', [{ path: 'noheading.md', text: '\nJust a plain first line\nmore text' }]);
        expect(await titleOf('XPOS', 'noheading.md')).toBe('Just a plain first line');
      });

      it('no title when the fallback first line is image/link-only', async () => {
        await createApp('XPOS');
        await uploadFolder('XPOS', [
          { path: 'imageonly.md', text: '![Diagram](attachments/diagram.png)\n\nmore text below' },
        ]);
        expect(await titleOf('XPOS', 'imageonly.md')).toBeUndefined();
      });

      it('no title when the fallback first line is too long (>=200 chars)', async () => {
        await createApp('XPOS');
        const longLine = 'x'.repeat(200);
        await uploadFolder('XPOS', [{ path: 'toolong.md', text: `${longLine}\nshort second line` }]);
        expect(await titleOf('XPOS', 'toolong.md')).toBeUndefined();
      });

      it('no title for a file with no heading and no non-empty line at all', async () => {
        await createApp('XPOS');
        await uploadFolder('XPOS', [{ path: 'blank.md', text: '\n\n\n' }]);
        expect(await titleOf('XPOS', 'blank.md')).toBeUndefined();
      });

      it('.markdown extension also gets a title; binary/other entries never do', async () => {
        await createApp('XPOS');
        await uploadFolder('XPOS', [
          { path: 'page.markdown', text: '# Markdown ext title' },
          { path: 'image.png', base64: Buffer.from('binary-bytes').toString('base64') },
          { path: 'notes.txt', text: '# Looks like a heading but .txt is not covered' },
        ]);
        expect(await titleOf('XPOS', 'page.markdown')).toBe('Markdown ext title');
        expect(await titleOf('XPOS', 'image.png')).toBeUndefined();
        expect(await titleOf('XPOS', 'notes.txt')).toBeUndefined();
      });

      it('only reads the head — a heading beyond ~2KB is not found (fallback also misses, first line too long)', async () => {
        await createApp('XPOS');
        // Push the heading past the 2KB head-read window with an oversized
        // (but still no-title-worthy, since it's > 200 chars) first line.
        const padding = 'a'.repeat(2100);
        await uploadFolder('XPOS', [{ path: 'farheading.md', text: `${padding}\n# Too far to see` }]);
        expect(await titleOf('XPOS', 'farheading.md')).toBeUndefined();
      });
    });
  });
});
