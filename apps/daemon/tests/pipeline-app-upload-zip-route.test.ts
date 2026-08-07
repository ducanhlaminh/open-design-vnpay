// POST /api/pipelines/apps/:appId/upload-zip — multipart zip upload for the
// App-level doc corpus (Confluence's "export to MD" delivered as one .zip
// instead of a folder tree). Multer-based (multipart/form-data), so — unlike
// the JSON upload-folder route — this CANNOT be exercised through the fake-
// express handler harness (multer/busboy needs a real readable HTTP request
// stream, not a plain object). Boots the real server via `startServer`, same
// pattern as tests/pipeline-app-files-run-source.test.ts.
//
// NO extension allowlist (matches upload-folder — see that route's tests):
// only zip-slip path safety, the symlink-entry rejection reused from
// /api/plugins/upload-zip, the per-file 10MB cap, and the 300MB extracted-
// total cap gate what lands.

import type http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';

import { startServer } from '../src/server.js';

const dataDir = process.env.OD_DATA_DIR as string;

describe('POST /api/pipelines/apps/:appId/upload-zip', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function uniqueAppId(label: string): string {
    return `zip-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function createApp(appId: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/pipelines/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, name: appId }),
    });
    expect(res.status).toBe(201);
  }

  async function uploadZip(appId: string, zipBuffer: Buffer, filename = 'export.zip'): Promise<Response> {
    const form = new FormData();
    form.append('file', new Blob([zipBuffer], { type: 'application/zip' }), filename);
    return fetch(`${baseUrl}/api/pipelines/apps/${appId}/upload-zip`, { method: 'POST', body: form });
  }

  async function readWrittenFile(appId: string, relPath: string): Promise<string> {
    return readFile(path.join(dataDir, 'projects', appId, 'docs', relPath), 'utf8');
  }

  it('404s an unknown app', async () => {
    const zip = new JSZip();
    zip.file('a.md', '# A');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const res = await uploadZip('nope-app-does-not-exist', buf);
    expect(res.status).toBe(404);
  });

  it('400s a zip with no entries', async () => {
    const appId = uniqueAppId('empty');
    await createApp(appId);
    const buf = await new JSZip().generateAsync({ type: 'nodebuffer' });
    const res = await uploadZip(appId, buf);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no files/i);
  });

  it('400s a file that is not a valid zip', async () => {
    const appId = uniqueAppId('notazip');
    await createApp(appId);
    const res = await uploadZip(appId, Buffer.from('this is definitely not a zip file'), 'export.zip');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not a valid zip/i);
  });

  it('happy path: extracts nested entries, top folder kept, no extension allowlist (extensionless + .tmp accepted)', async () => {
    const appId = uniqueAppId('happy');
    await createApp(appId);
    const zip = new JSZip();
    zip.file('MyExport/overview.md', '# Overview');
    zip.file('MyExport/nested/page.md', '# Nested');
    zip.file('MyExport/overview/attachments/img.png', Buffer.from('fake-png'));
    zip.file('MyExport/README', 'no extension, still a real document');
    zip.file('MyExport/scratch.tmp', 'export-tool artifact');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const res = await uploadZip(appId, buf);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written: number; skipped: unknown[] };
    expect(body).toEqual({ written: 5, skipped: [] });

    expect(await readWrittenFile(appId, 'MyExport/overview.md')).toBe('# Overview');
    expect(await readWrittenFile(appId, 'MyExport/nested/page.md')).toBe('# Nested');
    expect(await readWrittenFile(appId, 'MyExport/overview/attachments/img.png')).toBe('fake-png');
    expect(await readWrittenFile(appId, 'MyExport/README')).toBe('no extension, still a real document');
    expect(await readWrittenFile(appId, 'MyExport/scratch.tmp')).toBe('export-tool artifact');
  });

  it('skips a zip-slip entry (absolute path), writes the rest', async () => {
    // JSZip itself neutralizes a literal `../` prefix at LOAD time (verified:
    // an entry stored as '../../escape.md' round-trips through real zip bytes
    // as plain 'escape.md' — JSZip's own parser strips the traversal before
    // this route's validator ever sees it, which is already safe). An
    // ABSOLUTE entry name ('/etc/passwd.md'), by contrast, survives the
    // round-trip verbatim and is the realistic zip-slip vector this route's
    // own path-safety check (validateUploadRelPath, shared with upload-folder)
    // must catch.
    const appId = uniqueAppId('zipslip');
    await createApp(appId);
    const zip = new JSZip();
    zip.file('/etc/passwd.md', 'should never land outside the app docs dir');
    zip.file('good.md', 'ok');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const res = await uploadZip(appId, buf);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written: number; skipped: Array<{ path: string; reason: string }> };
    expect(body.written).toBe(1);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]!.reason).toMatch(/absolute/);
    expect(await readWrittenFile(appId, 'good.md')).toBe('ok');
  });

  it('400s a zip whose file field exceeds the 200MB cap (multer rejects before extraction)', async () => {
    const appId = uniqueAppId('oversize');
    await createApp(appId);
    // Doesn't need to be a valid zip — multer's own fileSize limit rejects
    // during the multipart stream read, before this route's JSZip.loadAsync
    // is ever reached.
    const oversized = Buffer.alloc(200 * 1024 * 1024 + 1024);
    const res = await uploadZip(appId, oversized);
    expect(res.status).toBe(413);
  }, 30_000);
});
