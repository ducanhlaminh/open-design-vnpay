import { describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

// WP5 (web-first migration): `POST /api/projects/:id/export/pdf` (backed by
// `apps/daemon/src/pdf-export.ts`, `buildDesktopPdfExportInput`, and the
// `desktopPdfExporter` IPC bridge to `apps/desktop`) was removed along with
// the rest of the desktop-app-only PDF path — the browser fallback in
// `apps/web/src/runtime/exports.ts` is now the only PDF export path. The
// desktop-branch specs for `POST /api/render/pdf` (which used to pin the
// fast, deterministic Electron `printToPDF` backend so CI didn't have to
// provision headless Chromium) went with it; the only backend left,
// `renderHtmlToPdf`'s headless-Chromium fallback, provisions npm + a ~150MB
// Chromium download on first use and isn't exercised here for that reason —
// this file keeps only the backend-agnostic input-validation spec.
describe('POST /api/render/pdf', () => {
  it('rejects an empty document before reaching any backend', async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      server: { close(cb: () => void): void };
      url: string;
    };
    try {
      const response = await fetch(`${started.url}/api/render/pdf`, {
        body: JSON.stringify({ html: '   ' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => started.server.close(resolve));
    }
  });
});
