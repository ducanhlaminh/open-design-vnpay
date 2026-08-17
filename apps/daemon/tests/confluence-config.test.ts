// Confluence credential storage (WP8) — its own file, independent of the
// generic external-MCP config. Covers: read/write roundtrip, the one-time
// migration from a legacy `mcp-atlassian` mcp-config.json row, and the two
// HTTP routes (GET never leaks the real token, PUT writes the file).

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configuredConfluenceBase,
  readConfluenceConfig,
  testConfluenceConnection,
  writeConfluenceConfig,
} from '../src/confluence-config.js';
import { writeMcpConfig } from '../src/mcp-config.js';
import { startServer } from '../src/server.js';

describe('confluence-config storage', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-confluenceconfig-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns null when no config file and no legacy mcp-config.json exist', async () => {
    const cfg = await readConfluenceConfig(dataDir);
    expect(cfg).toBeNull();
  });

  it('returns null for a corrupt JSON file, rather than throwing', async () => {
    await writeFile(path.join(dataDir, 'confluence-config.json'), '{not valid');
    const cfg = await readConfluenceConfig(dataDir);
    expect(cfg).toBeNull();
  });

  it('persists and re-reads a valid { base, token } roundtrip', async () => {
    const written = await writeConfluenceConfig(dataDir, {
      base: 'https://wiki.test.example/',
      token: 'pat-abc123',
    });
    // Trailing slash stripped, mirroring mcp-config's CONFLUENCE_URL handling.
    expect(written).toEqual({ base: 'https://wiki.test.example', token: 'pat-abc123' });

    const reread = await readConfluenceConfig(dataDir);
    expect(reread).toEqual({ base: 'https://wiki.test.example', token: 'pat-abc123' });

    const onDisk = JSON.parse(
      await readFile(path.join(dataDir, 'confluence-config.json'), 'utf8'),
    );
    expect(onDisk).toEqual({ base: 'https://wiki.test.example', token: 'pat-abc123' });
  });

  it('an empty/omitted token on write keeps the previously saved one', async () => {
    await writeConfluenceConfig(dataDir, { base: 'https://wiki.test.example', token: 'first-token' });
    const updated = await writeConfluenceConfig(dataDir, { base: 'https://wiki2.test.example' });
    expect(updated).toEqual({ base: 'https://wiki2.test.example', token: 'first-token' });
  });

  it('writing with both fields blank clears the credential (writes null)', async () => {
    await writeConfluenceConfig(dataDir, { base: 'https://wiki.test.example', token: 'tok' });
    const cleared = await writeConfluenceConfig(dataDir, { base: '', token: '' });
    expect(cleared).toBeNull();
    const reread = await readConfluenceConfig(dataDir);
    expect(reread).toBeNull();
  });

  it('migrates once from a legacy mcp-atlassian row in mcp-config.json when confluence-config.json is absent', async () => {
    await writeMcpConfig(dataDir, {
      servers: [
        {
          id: 'mcp-atlassian',
          label: 'Atlassian (Jira + Confluence Data Center)',
          transport: 'stdio',
          enabled: true,
          command: 'uvx',
          args: ['mcp-atlassian@0.21.1'],
          env: {
            JIRA_URL: 'https://jr.example.test',
            CONFLUENCE_URL: 'https://wiki.example.test/',
            CONFLUENCE_PERSONAL_TOKEN: 'legacy-pat',
          },
        },
      ],
    });

    const migrated = await readConfluenceConfig(dataDir);
    expect(migrated).toEqual({ base: 'https://wiki.example.test', token: 'legacy-pat' });

    // The migration WROTE confluence-config.json — a second read must not
    // re-derive from mcp-config.json again (it just reads the new file).
    const onDisk = JSON.parse(
      await readFile(path.join(dataDir, 'confluence-config.json'), 'utf8'),
    );
    expect(onDisk).toEqual({ base: 'https://wiki.example.test', token: 'legacy-pat' });
  });

  it('does not migrate when mcp-config.json has no atlassian-ish row', async () => {
    await writeMcpConfig(dataDir, {
      servers: [
        { id: 'github', transport: 'stdio', enabled: true, command: 'npx', args: ['-y', 'server-github'] },
      ],
    });
    const cfg = await readConfluenceConfig(dataDir);
    expect(cfg).toBeNull();
  });

  it('a real confluence-config.json is never overwritten by a stale mcp-atlassian row', async () => {
    await writeConfluenceConfig(dataDir, { base: 'https://real.example', token: 'real-token' });
    await writeMcpConfig(dataDir, {
      servers: [
        {
          id: 'mcp-atlassian',
          transport: 'stdio',
          enabled: true,
          command: 'uvx',
          env: { CONFLUENCE_URL: 'https://stale.example', CONFLUENCE_PERSONAL_TOKEN: 'stale-token' },
        },
      ],
    });
    const cfg = await readConfluenceConfig(dataDir);
    expect(cfg).toEqual({ base: 'https://real.example', token: 'real-token' });
  });
});

describe('configuredConfluenceBase', () => {
  it('normalizes only the deployment CONFLUENCE_URL', () => {
    expect(configuredConfluenceBase({ CONFLUENCE_URL: 'wiki.servicehub.vn/' })).toBe(
      'https://wiki.servicehub.vn',
    );
    expect(configuredConfluenceBase({})).toBe('');
  });
});

describe('testConfluenceConnection', () => {
  let dataDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-confluencetest-'));
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('fails fast without calling Confluence when neither the request nor the saved config has a token', async () => {
    const result = await testConfluenceConnection(dataDir, { base: 'https://wiki.example.test' });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the already-saved token when the request omits one', async () => {
    await writeConfluenceConfig(dataDir, { base: 'https://wiki.example.test', token: 'saved-token' });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ displayName: 'Saved User' }), { status: 200 }),
    );

    const result = await testConfluenceConnection(dataDir, { base: 'https://wiki.example.test' });
    expect(result).toEqual({ ok: true, displayName: 'Saved User' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://wiki.example.test/rest/api/user/current');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer saved-token');
  });

  it('normalizes a bare hostname (no scheme) to https before calling Confluence', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await testConfluenceConnection(dataDir, { base: 'wiki.servicehub.vn', token: 't' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://wiki.servicehub.vn/rest/api/user/current');
  });

  it('reports an invalid-token detail on a 401 without throwing', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const result = await testConfluenceConnection(dataDir, { base: 'https://wiki.example.test', token: 'bad' });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/401/);
  });

  it('reports an unreachable-host detail when fetch itself throws', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    const result = await testConfluenceConnection(dataDir, { base: 'https://nope.example.test', token: 't' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('https://nope.example.test');
  });
});

describe('confluence-config routes', () => {
  let server: http.Server;
  let baseUrl: string;
  let previousConfluenceUrl: string | undefined;

  beforeAll(async () => {
    previousConfluenceUrl = process.env.CONFLUENCE_URL;
    process.env.CONFLUENCE_URL = 'https://route-test.example';
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    // Reset to a clean (unset) state so this route test never leaks a
    // credential into other daemon test files sharing the same OD_DATA_DIR.
    await fetch(`${baseUrl}/api/confluence-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    }).catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousConfluenceUrl === undefined) delete process.env.CONFLUENCE_URL;
    else process.env.CONFLUENCE_URL = previousConfluenceUrl;
  });

  it('GET reports hasToken but never the real token; PUT writes the file', async () => {
    const getEmpty = await fetch(`${baseUrl}/api/confluence-config`);
    expect(getEmpty.status).toBe(200);
    const emptyBody = (await getEmpty.json()) as Record<string, unknown>;
    expect('token' in emptyBody).toBe(false);

    const putRes = await fetch(`${baseUrl}/api/confluence-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'https://attacker.example', token: 'route-token' }),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { base: string; hasToken: boolean };
    expect(putBody).toEqual({ base: 'https://route-test.example', hasToken: true });
    expect('token' in putBody).toBe(false);

    const getRes = await fetch(`${baseUrl}/api/confluence-config`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { base: string; hasToken: boolean };
    expect(getBody).toEqual({ base: 'https://route-test.example', hasToken: true });
    expect('token' in getBody).toBe(false);
  });

  it('POST /test reports ok:false without hitting the network when no credential is configured', async () => {
    // Clears whatever the previous test in this file left behind.
    await fetch(`${baseUrl}/api/confluence-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    const res = await fetch(`${baseUrl}/api/confluence-config/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; detail?: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toBeTruthy();
  });
});
