import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DesktopExportPdfInput, DesktopExportPdfResult } from '@open-design/sidecar-proto';

import { buildDesktopPdfExportInput } from '../src/pdf-export.js';
import { startServer } from '../src/server.js';

describe('buildDesktopPdfExportInput', () => {
  let projectsRoot = '';
  const projectId = 'proj-pdf-test';

  beforeEach(async () => {
    projectsRoot = mkdtempSync(path.join(tmpdir(), 'od-pdf-export-'));
    await mkdir(path.join(projectsRoot, projectId, 'deck', 'assets'), { recursive: true });
    await writeFile(
      path.join(projectsRoot, projectId, 'deck', 'index.html'),
      '<!doctype html><section class="slide">One</section>',
    );
  });

  afterEach(() => {
    if (projectsRoot) rmSync(projectsRoot, { recursive: true, force: true });
  });

  it('reads the project file and derives a raw-route baseHref from the file directory', async () => {
    const input = await buildDesktopPdfExportInput({
      daemonUrl: 'http://127.0.0.1:7456',
      deck: true,
      fileName: 'deck/index.html',
      projectId,
      projectsRoot,
      title: 'Seed Deck',
    });

    expect(input).toEqual({
      baseHref: 'http://127.0.0.1:7456/api/projects/proj-pdf-test/raw/deck/',
      deck: true,
      defaultFilename: 'Seed-Deck.pdf',
      html: '<!doctype html><section class="slide">One</section>',
      title: 'Seed Deck',
    });
  });

  it('falls back to the file basename when the caller omits a title', async () => {
    const input = await buildDesktopPdfExportInput({
      daemonUrl: 'http://127.0.0.1:7456',
      deck: false,
      fileName: 'deck/index.html',
      projectId,
      projectsRoot,
    });

    expect(input.title).toBe('index');
    expect(input.defaultFilename).toBe('index.pdf');
  });
});

describe('POST /api/projects/:id/export/pdf', () => {
  it('forwards the project HTML file to the configured desktop PDF exporter', async () => {
    const projectId = `proj-pdf-route-${Date.now()}`;
    const calls: unknown[] = [];
    const started = await startServer({
      port: 0,
      returnServer: true,
      desktopPdfExporter: async (input: unknown) => {
        calls.push(input);
        return { ok: true, path: '/tmp/seed.pdf' };
      },
    }) as { server: { close(cb: () => void): void }; url: string };

    try {
      await fetch(`${started.url}/api/projects/${encodeURIComponent(projectId)}/files`, {
        body: JSON.stringify({
          content: '<!doctype html><section class="slide">One</section>',
          name: 'deck/index.html',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      const response = await fetch(`${started.url}/api/projects/${encodeURIComponent(projectId)}/export/pdf`, {
        body: JSON.stringify({ deck: true, fileName: 'deck/index.html', title: 'Seed Deck' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, path: '/tmp/seed.pdf' });
      expect(calls).toEqual([
        {
          baseHref: `${started.url}/api/projects/${encodeURIComponent(projectId)}/raw/deck/`,
          deck: true,
          defaultFilename: 'Seed-Deck.pdf',
          html: '<!doctype html><section class="slide">One</section>',
          title: 'Seed Deck',
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => started.server.close(resolve));
    }
  });
});

// POST /api/render/pdf has two backends. In the DESKTOP app the PDF comes from
// Electron's own printToPDF (nothing to provision — no npm, no ~150MB Chromium
// download, works offline); only a browser/CLI caller falls back to headless
// Chromium. These specs pin the desktop branch: a packaged Windows build with
// no Node installed used to 500 here because the fallback was the only path.
describe('POST /api/render/pdf', () => {
  async function withServer<T>(
    exporter: ((input: DesktopExportPdfInput) => Promise<DesktopExportPdfResult>) | undefined,
    run: (url: string) => Promise<T>,
  ): Promise<T> {
    const started = (await startServer({
      port: 0,
      returnServer: true,
      ...(exporter ? { desktopPdfExporter: exporter } : {}),
    })) as { server: { close(cb: () => void): void }; url: string };
    try {
      return await run(started.url);
    } finally {
      await new Promise<void>((resolve) => started.server.close(resolve));
    }
  }

  const post = (url: string, body: unknown) =>
    fetch(`${url}/api/render/pdf`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

  it('renders through the desktop exporter and answers the saved path as JSON', async () => {
    const calls: unknown[] = [];
    await withServer(
      async (input: DesktopExportPdfInput) => {
        calls.push(input);
        return { ok: true, path: 'C:\\Users\\me\\review.pdf' };
      },
      async (url) => {
        const response = await post(url, { html: '<h1>hi</h1>', filename: 'review-tong-hop.pdf' });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(await response.json()).toEqual({
          ok: true,
          path: 'C:\\Users\\me\\review.pdf',
          saved: true,
        });
        expect(calls).toEqual([
          {
            deck: false,
            defaultFilename: 'review-tong-hop.pdf',
            html: '<h1>hi</h1>',
            title: 'review-tong-hop',
          },
        ]);
      },
    );
  });

  it('treats a dismissed Save dialog as success, not an error', async () => {
    await withServer(
      async () => ({ canceled: true, ok: false }),
      async (url) => {
        const response = await post(url, { html: '<h1>hi</h1>', filename: 'x.pdf' });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ canceled: true, ok: false, saved: true });
      },
    );
  });

  it('rejects an empty document before reaching any backend', async () => {
    await withServer(
      async () => {
        throw new Error('exporter must not run for an empty document');
      },
      async (url) => {
        const response = await post(url, { html: '   ' });

        expect(response.status).toBe(400);
      },
    );
  });
});
