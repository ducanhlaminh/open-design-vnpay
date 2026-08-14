// Real-HTTP route coverage for GET /api/update/status + POST
// /api/update/apply, mirroring sandbox-mode.test.ts's
// real-`startServer()`-over-HTTP style.
//
// Two things this file needs that most other daemon test files don't:
//
// 1. `OD_RESOURCE_ROOT` must be set BEFORE server.ts is first evaluated —
//    `DAEMON_RESOURCE_ROOT` (used to derive OD_HOME for the apply route) is
//    computed once at module top-level, not inside `startServer()`. So this
//    file dynamically `import()`s server.js inside `beforeAll`, after
//    setting the env var, instead of the usual static top-level import.
//
// 2. `node:child_process`'s `spawn` is mocked, but only for the
//    `install.sh --update` call the apply route makes — never for real.
//    Everything else (including the fake `opencode` CLI the
//    runs-active-guard test spawns via a real child process on PATH, same
//    `withFakeAgent` pattern chat-route.test.ts uses) passes through to the
//    real implementation, so this file can still exercise a genuinely
//    active run over real HTTP without the update-apply mock swallowing it.
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type StartedServer = { url: string; server: http.Server };
type SpawnCall = { command: string; args: string[] | undefined };

const spawnCalls: SpawnCall[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const rawSpawn = actual.spawn as (...args: unknown[]) => unknown;
  const spawnMock = ((command: string, args?: readonly string[], options?: unknown) => {
    const argv = args ? Array.from(args) : undefined;
    const isUpdateSpawn = Array.isArray(argv) && argv.some((a) => typeof a === 'string' && a.includes('install.sh'));
    if (isUpdateSpawn) {
      spawnCalls.push({ command, args: argv });
      // Never actually shell out — return a stand-in with the two
      // methods/props the route touches (`child.unref()`, `child.pid`).
      return { unref: () => {}, pid: 999_999 };
    }
    return rawSpawn(command, argv, options);
  }) as typeof actual.spawn;
  return { ...actual, spawn: spawnMock };
});

// A fixed, always-newer-than-whatever-is-installed fake latest release.
// Every status/apply test in this file shares ONE server instance (and
// therefore one warm 60-minute GitHub cache inside server.ts), so the mock
// intentionally never varies across tests — see the module docblock above.
const FAKE_LATEST_TAG = 'v999.0.0';
const FAKE_LATEST_VERSION = '999.0.0';

async function withFakeOpencodeAgent<T>(script: string, run: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'od-update-routes-bin-'));
  const oldPath = process.env.PATH;
  try {
    const bin = join(dir, 'opencode');
    await writeFile(bin, `#!/usr/bin/env node\n${script}`);
    await chmod(bin, 0o755);
    process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
    return await run();
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
}

describe('host-runtime self-update routes', () => {
  let server: http.Server;
  let baseUrl: string;
  let dataDir: string;
  let odHomeFixture: string;
  const originalResourceRoot = process.env.OD_RESOURCE_ROOT;
  const originalSandboxEnv = process.env.OD_SANDBOX;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    delete process.env.OD_SANDBOX;

    // repo root: apps/daemon/tests -> apps/daemon -> apps -> <repo root>.
    const repoRoot = resolve(__dirname, '..', '..', '..');
    odHomeFixture = join(repoRoot, '.tmp-update-routes-test-fixture');
    const resourceRoot = join(odHomeFixture, 'current', 'resources', 'open-design');
    await mkdir(resourceRoot, { recursive: true });
    process.env.OD_RESOURCE_ROOT = resourceRoot;

    // Fake the GitHub `releases/latest` call for JUST the host-runtime
    // repo this feature queries; anything else (there shouldn't be
    // anything else during these tests) falls through to the real fetch.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input.toString();
      if (href === 'https://api.github.com/repos/ducanhlaminh/open-design-vnpay/releases/latest') {
        return new Response(
          JSON.stringify({ tag_name: FAKE_LATEST_TAG, html_url: 'https://example.com/release' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    // Module-level state (DAEMON_RESOURCE_ROOT, the update-apply lock, the
    // GitHub release cache) is computed at import time — must import AFTER
    // the env/fetch setup above.
    const serverModule = await import('../src/server.js');
    dataDir = process.env.OD_DATA_DIR!;
    const started = (await serverModule.startServer({ port: 0, returnServer: true })) as StartedServer;
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    if (originalResourceRoot === undefined) delete process.env.OD_RESOURCE_ROOT;
    else process.env.OD_RESOURCE_ROOT = originalResourceRoot;
    if (originalSandboxEnv === undefined) delete process.env.OD_SANDBOX;
    else process.env.OD_SANDBOX = originalSandboxEnv;
    globalThis.fetch = originalFetch;
    await rm(odHomeFixture, { recursive: true, force: true });
    await new Promise<void>((res) => server.close(() => res()));
  });

  afterEach(async () => {
    // Keep the persistent-data-dir marker file from leaking between tests
    // that don't expect one.
    await rm(join(dataDir, 'update-marker.json'), { force: true }).catch(() => {});
  });

  describe('GET /api/update/status', () => {
    it('reports currentVersion, the cached latestVersion, and updateAvailable', async () => {
      const res = await fetch(`${baseUrl}/api/update/status`);
      const body = (await res.json()) as {
        currentVersion: string;
        latestVersion: string | null;
        updateAvailable: boolean;
        justUpdated: unknown;
      };
      expect(res.ok).toBe(true);
      expect(typeof body.currentVersion).toBe('string');
      expect(body.currentVersion.length).toBeGreaterThan(0);
      expect(body.latestVersion).toBe(FAKE_LATEST_VERSION);
      expect(body.updateAvailable).toBe(true);
      expect(body.justUpdated).toBeNull();
    });

    it('reports justUpdated exactly once when a marker matching the running version is present', async () => {
      const statusRes = await fetch(`${baseUrl}/api/update/status`);
      const { currentVersion } = (await statusRes.json()) as { currentVersion: string };

      const at = Date.now() - 1_000;
      await writeFile(
        join(dataDir, 'update-marker.json'),
        JSON.stringify({ version: currentVersion, at }),
        'utf8',
      );

      const first = await fetch(`${baseUrl}/api/update/status`);
      const firstBody = (await first.json()) as { justUpdated: { version: string; at: string } | null };
      expect(firstBody.justUpdated).not.toBeNull();
      expect(firstBody.justUpdated?.version).toBe(currentVersion);
      expect(new Date(firstBody.justUpdated!.at).toISOString()).toBe(firstBody.justUpdated!.at);

      const second = await fetch(`${baseUrl}/api/update/status`);
      const secondBody = (await second.json()) as { justUpdated: unknown };
      expect(secondBody.justUpdated).toBeNull();

      const raw = await readFile(join(dataDir, 'update-marker.json'), 'utf8').catch(() => null);
      expect(raw).toBeNull();
    });

    it('does not report justUpdated when the marker targets a version that is not the one currently running', async () => {
      await writeFile(
        join(dataDir, 'update-marker.json'),
        JSON.stringify({ version: '0.0.1-does-not-match-anything', at: Date.now() }),
        'utf8',
      );
      const res = await fetch(`${baseUrl}/api/update/status`);
      const body = (await res.json()) as { justUpdated: unknown };
      expect(body.justUpdated).toBeNull();
    });
  });

  describe('POST /api/update/apply', () => {
    it('responds runs-active and does not spawn while an agent run is in progress', async () => {
      const conversationId = `conv-${randomUUID()}`;
      await withFakeOpencodeAgent(
        `
setTimeout(() => {
  console.log(JSON.stringify({ type: 'step_start' }));
  console.log(JSON.stringify({ type: 'text', part: { text: 'ok' } }));
  console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 1 } } }));
  process.exit(0);
}, 400);
`,
        async () => {
          const chatPromise = fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'opencode', conversationId, message: 'hello' }),
          }).then((r) => r.text());

          // Poll for the run to actually show up as active before asserting
          // the guard — avoids a fixed-sleep race against run creation.
          let active = false;
          for (let i = 0; i < 40 && !active; i++) {
            const runsRes = await fetch(`${baseUrl}/api/runs?status=active`);
            const runsBody = (await runsRes.json()) as { runs: unknown[] };
            active = Array.isArray(runsBody.runs) && runsBody.runs.length > 0;
            if (!active) await new Promise((r) => setTimeout(r, 25));
          }
          expect(active).toBe(true);

          const spawnCallsBefore = spawnCalls.length;
          const applyRes = await fetch(`${baseUrl}/api/update/apply`, { method: 'POST' });
          const applyBody = (await applyRes.json()) as { started: boolean; reason?: string };
          expect(applyBody).toEqual({ started: false, reason: 'runs-active' });
          expect(spawnCalls.length).toBe(spawnCallsBefore);

          await chatPromise;
        },
      );
    });

    it('writes the marker, spawns install.sh --update under the derived OD_HOME, and responds started:true', async () => {
      const applyRes = await fetch(`${baseUrl}/api/update/apply`, { method: 'POST' });
      const applyBody = (await applyRes.json()) as { started: boolean };
      expect(applyBody).toEqual({ started: true });

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0]!;
      expect(call.command).toBe('bash');
      expect(call.args).toEqual([join(odHomeFixture, 'current', 'install.sh'), '--update']);

      const marker = JSON.parse(await readFile(join(dataDir, 'update-marker.json'), 'utf8')) as {
        version: string;
        at: number;
      };
      expect(marker.version).toBe(FAKE_LATEST_VERSION);
      expect(typeof marker.at).toBe('number');
    });

    it('responds already-in-progress on a second call and still does not spawn again', async () => {
      const spawnCallsBefore = spawnCalls.length;
      const res = await fetch(`${baseUrl}/api/update/apply`, { method: 'POST' });
      const body = (await res.json()) as { started: boolean; reason?: string };
      expect(body).toEqual({ started: false, reason: 'already-in-progress' });
      expect(spawnCalls.length).toBe(spawnCallsBefore);
    });
  });
});
