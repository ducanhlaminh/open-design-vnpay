// Confluence credential storage (WP8) — its own file, independent of the
// generic external-MCP config. Covers: read/write roundtrip, the one-time
// migration from a legacy `mcp-atlassian` mcp-config.json row, and the two
// HTTP routes (GET never leaks the real token, PUT writes the file).

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { readConfluenceConfig, writeConfluenceConfig } from '../src/confluence-config.js';
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

describe('confluence-config routes', () => {
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

  afterAll(async () => {
    // Reset to a clean (unset) state so this route test never leaks a
    // credential into other daemon test files sharing the same OD_DATA_DIR.
    await fetch(`${baseUrl}/api/confluence-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: '', token: '' }),
    }).catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET reports hasToken but never the real token; PUT writes the file', async () => {
    const getEmpty = await fetch(`${baseUrl}/api/confluence-config`);
    expect(getEmpty.status).toBe(200);
    const emptyBody = (await getEmpty.json()) as Record<string, unknown>;
    expect('token' in emptyBody).toBe(false);

    const putRes = await fetch(`${baseUrl}/api/confluence-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'https://route-test.example/', token: 'route-token' }),
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
});
