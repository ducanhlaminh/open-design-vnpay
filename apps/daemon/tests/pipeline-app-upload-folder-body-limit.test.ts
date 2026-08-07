// Regression for the LIVE bug: POST /api/pipelines/apps/:appId/upload-folder
// 413ing on a real 88MB Confluence export against the global
// `express.json({limit:'4mb'})` at server.ts (~L3637). The fake-express
// harness the other upload-folder tests use (tests/pipeline-app-upload-folder-route.test.ts)
// calls the route handler directly and never goes through Express's
// body-parser middleware stack at all, so it CANNOT see this bug — a real
// HTTP round-trip through `startServer` is required. This file boots the
// real server (same pattern as tests/project-file-rename.test.ts /
// tests/memory-config-route.test.ts) and asserts:
//   - a request over the OLD 4mb global limit reaches the route (not a 413)
//     once the route-scoped `app.use('/api/pipelines/apps/:appId/upload-folder',
//     express.json({limit:'120mb'}))` is registered ahead of the global one.
//   - an UNRELATED JSON route is still capped at the original 4mb — the fix
//     must not accidentally widen the limit for every route.

import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

describe('POST /api/pipelines/apps/:appId/upload-folder body-size limit (real HTTP, not the fake-express harness)', () => {
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

  async function createApp(): Promise<string> {
    const appId = `upload-body-limit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const resp = await fetch(`${baseUrl}/api/pipelines/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, name: appId }),
    });
    expect(resp.status).toBe(201);
    return appId;
  }

  it('accepts a JSON body over the old 4mb global limit (route-scoped 120mb parser wins)', async () => {
    const appId = await createApp();
    // ~5MB of raw text — comfortably over the old 4mb global json() limit,
    // comfortably under the route's own 10MB-per-file / 80MB-total caps.
    const bigText = 'a'.repeat(5 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/pipelines/apps/${appId}/upload-folder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'big.md', text: bigText }] }),
    });
    // Real bug reproduction: status 413 here means the global 4mb limit won.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written: number; skipped: unknown[] };
    expect(body).toEqual({ written: 1, skipped: [] });
  });

  it('does NOT widen the limit for an unrelated JSON route — still 413s over 4mb there', async () => {
    // POST /api/pipelines/apps has nothing to do with this route; an
    // oversized body must still be rejected by the global 4mb parser, proving
    // the fix is scoped to /api/pipelines/apps/:appId/upload-folder only.
    // body-parser enforces the byte limit while reading the raw stream,
    // before JSON parsing even starts, so the field values here don't need
    // to be valid.
    const junk = 'x'.repeat(5 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/pipelines/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'oversized-app', name: junk }),
    });
    expect(res.status).toBe(413);
  });
});
