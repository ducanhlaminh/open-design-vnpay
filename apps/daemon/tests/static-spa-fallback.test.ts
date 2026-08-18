import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveStaticSpaFallbackPath } from '../src/server.js';

describe('static SPA fallback', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-static-spa-'));
    writeFileSync(path.join(tempDir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(path.join(tempDir, 'app-icon.svg'), '<svg />');
  });

  afterEach(() => {
    rmSync(tempDir, { force: true, recursive: true });
  });

  function request(pathname: string, accept = 'text/html', method = 'GET') {
    return {
      get(name: string) {
        return name.toLowerCase() === 'accept' ? accept : undefined;
      },
      method,
      path: pathname,
    };
  }

  it('resolves the SPA shell for deep app routes', () => {
    expect(resolveStaticSpaFallbackPath(request('/automations'), tempDir))
      .toBe(path.join(tempDir, 'index.html'));
    expect(resolveStaticSpaFallbackPath(request('/projects/proj-1/files/index.html'), tempDir))
      .toBe(path.join(tempDir, 'index.html'));
  });

  it('leaves API and framework asset misses to downstream 404 handling', () => {
    expect(resolveStaticSpaFallbackPath(request('/api/routines/nope'), tempDir)).toBeNull();
    expect(resolveStaticSpaFallbackPath(request('/artifacts/missing'), tempDir)).toBeNull();
    expect(resolveStaticSpaFallbackPath(request('/frames/missing'), tempDir)).toBeNull();
    expect(resolveStaticSpaFallbackPath(request('/_next/static/missing.js'), tempDir)).toBeNull();
  });

  it('requires an HTML-capable request and an emitted shell', () => {
    expect(resolveStaticSpaFallbackPath(request('/automations', 'application/json'), tempDir)).toBeNull();
    expect(resolveStaticSpaFallbackPath(request('/automations', 'text/html', 'POST'), tempDir)).toBeNull();

    const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'od-static-spa-empty-'));
    try {
      expect(resolveStaticSpaFallbackPath(request('/automations'), emptyDir)).toBeNull();
    } finally {
      rmSync(emptyDir, { force: true, recursive: true });
    }
  });
});

describe('static SPA fallback -- packaged install under a dot-directory', () => {
  it('serves index.html for deep links when the static dir path contains a dot-segment', async () => {
    const [{ default: express }, { registerStaticSpaFallback }] = await Promise.all([
      import('express'),
      import('../src/server.js'),
    ]);
    // Packaged runtimes live under `~/.open-design/releases/<v>/...`. Mirror that
    // shape: a dot-directory in the ancestor chain of the static dir.
    const base = mkdtempSync(path.join(os.tmpdir(), 'od-static-spa-dot-'));
    const staticDir = path.join(base, '.open-design', 'apps', 'web', 'out');
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><div id="root">shell</div>');

    const app = express();
    app.use(express.static(staticDir));
    registerStaticSpaFallback(app, staticDir);

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/workspace`, { headers: { accept: 'text/html' } });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('shell');

      const nested = await fetch(`http://127.0.0.1:${port}/projects/p1/files`, { headers: { accept: 'text/html' } });
      expect(nested.status).toBe(200);

      const api = await fetch(`http://127.0.0.1:${port}/api/nope`, { headers: { accept: 'text/html' } });
      expect(api.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(base, { force: true, recursive: true });
    }
  });
});
