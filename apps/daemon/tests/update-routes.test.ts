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
const updateChildListeners = new Map<string, (...args: unknown[]) => void>();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const rawSpawn = actual.spawn as (...args: unknown[]) => unknown;
  const spawnMock = ((command: string, args?: readonly string[], options?: unknown) => {
    const argv = args ? Array.from(args) : undefined;
    // Match on the COMMAND, not just the script path inside argv: WP-B
    // (installer downloaded fresh to a `update-installer-<opId>.sh` temp
    // file) means the update-apply route's script path no longer always
    // contains the literal substring "install.sh" — only the pre-existing
    // `$OD_HOME/current/install.sh` fallback path does. `spawn(resolvedCmd,
    // ...)` in the apply route is the ONLY caller in this codebase that
    // spawns a bare 'bash'/'powershell' command, so matching on command
    // name alone is both necessary (catches the remote temp-file case) and
    // safe (nothing else in server.ts spawns those literal commands) — this
    // must NEVER fall through to a real spawn, since a real one would
    // actually run install.sh/.ps1 against this machine's real OD_HOME.
    const isUpdateSpawn = command === 'bash' || (typeof command === 'string' && command.toLowerCase().includes('powershell'));
    if (isUpdateSpawn) {
      spawnCalls.push({ command, args: argv });
      // Never actually shell out — return a stand-in with the
      // methods/props the route touches: `child.unref()`, `child.pid`,
      // and `child.on('error', ...)` (added alongside the Windows-support
      // change — see specs/change/20260815-host-update-ui-windows) to
      // catch a spawn-time failure that previously vanished silently.
      return {
        unref: () => {},
        on: (event: string, listener: (...args: unknown[]) => void) => {
          updateChildListeners.set(event, listener);
        },
        pid: 999_999,
      };
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

let githubReleaseCalls = 0;
  let mirrorReleaseCalls = 0;
  let mirrorRelease: { version: string; tag: string } | null = null;
  // Body served for GET `${base}/install.sh` (WP-B: POST /api/update/apply
  // downloads the latest installer before spawning it). Defaults to 404 —
  // preserves the pre-WP-B "local install.sh" spawn path/args for every
  // test that doesn't opt in — flip per-test via `installerScriptBody`.
  let installerFetchCalls = 0;
  let installerScriptBody: string | null | undefined = undefined; // undefined = 404
  // A second, distinct release-source base used ONLY by the OD_RELEASE_URL
  // override test below — deliberately mocked here too so that test can
  // never fall through to `originalFetch` and hit the real network.
  const OVERRIDE_RELEASE_BASE = 'https://od-release-override.example.test/src';
  let overrideReleaseCalls = 0;

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
      // Mirror-first (0.8.168): các test có sẵn mô tả đường fallback GitHub,
      // nên mirror mặc định trả 404; test mirror riêng bật mirrorRelease.
      if (href === 'https://od-runtime.pages.dev/latest/release.json') {
        mirrorReleaseCalls += 1;
        if (mirrorRelease) {
          return new Response(JSON.stringify(mirrorRelease), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('not found', { status: 404 });
      }
      if (href === 'https://api.github.com/repos/ducanhlaminh/open-design-vnpay/releases/latest') {
        githubReleaseCalls += 1;
        return new Response(
          JSON.stringify({ tag_name: FAKE_LATEST_TAG, html_url: 'https://example.com/release' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // WP-B: POST /api/update/apply downloads `${base}/install.sh` before
      // spawning. Never let this fall through to originalFetch — default
      // (installerScriptBody undefined) is 404, matching the pre-WP-B
      // "run the locally-installed install.sh" behavior every other test
      // in this file already asserts.
      if (href === 'https://od-runtime.pages.dev/latest/install.sh') {
        installerFetchCalls += 1;
        if (installerScriptBody === undefined) {
          return new Response('not found', { status: 404 });
        }
        if (installerScriptBody === null) {
          return new Response('', { status: 200 });
        }
        return new Response(installerScriptBody, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      // OD_RELEASE_URL override test fixture — always fails, always mocked,
      // never real network.
      if (href === `${OVERRIDE_RELEASE_BASE}/release.json`) {
        overrideReleaseCalls += 1;
        return new Response('not found', { status: 404 });
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
    // Keep update-state.json after a started apply so the following
    // progress test exercises the same persisted operation across polls.
    await rm(join(dataDir, 'update.log'), { force: true }).catch(() => {});
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

    it('serves latestVersion from the 5-minute cache, but ?refresh=1 (header "Kiểm tra cập nhật") re-asks GitHub and reports checkedAt', async () => {
      const before = githubReleaseCalls;
      await fetch(`${baseUrl}/api/update/status`);
      await fetch(`${baseUrl}/api/update/status`);
      expect(githubReleaseCalls).toBe(before); // still within TTL from the first test

      const res = await fetch(`${baseUrl}/api/update/status?refresh=1`);
      const body = (await res.json()) as { latestVersion: string | null; checkedAt: string | null; checkError: string | null };
      expect(githubReleaseCalls).toBe(before + 1);
      expect(body.latestVersion).toBe(FAKE_LATEST_VERSION);
      expect(typeof body.checkedAt).toBe('string');
      expect(Number.isNaN(Date.parse(body.checkedAt as string))).toBe(false);
      expect(body.checkError).toBeNull();
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

    it('mirror-first: khi od-runtime.pages.dev/latest/release.json trả version, không hỏi GitHub', async () => {
      mirrorRelease = { version: '999.1.0', tag: 'host-runtime-v999.1.0' };
      const githubBefore = githubReleaseCalls;
      try {
        const res = await fetch(`${baseUrl}/api/update/status?refresh=1`);
        const body = (await res.json()) as { latestVersion: string | null; updateAvailable: boolean };
        expect(body.latestVersion).toBe('999.1.0');
        expect(body.updateAvailable).toBe(true);
        expect(githubReleaseCalls).toBe(githubBefore);
      } finally {
        mirrorRelease = null;
        // Cache release 5 phút là module-level — nạp lại qua GitHub fallback để
        // các test sau (apply) thấy đúng FAKE_LATEST_TAG như trước.
        await fetch(`${baseUrl}/api/update/status?refresh=1`);
      }
    });

    it('giấu bản ghi rolled-back của dòng đời cũ (target thấp hơn version đang chạy)', async () => {
      const startedAt = new Date('2026-08-19T06:43:58.631Z').toISOString();
      await writeFile(join(dataDir, 'update-state.json'), JSON.stringify({
        operationId: 'ancient-op',
        targetVersion: '0.0.1',
        sourceVersion: '0.0.0',
        state: 'rolled-back',
        phase: { step: 6, totalSteps: 6, label: 'x' },
        error: { message: 'update rolled back; daemon is still running newer instead of 0.0.1', at: startedAt },
        startedAt,
        updatedAt: startedAt,
      }), 'utf8');
      try {
        const res = await fetch(`${baseUrl}/api/update/status`);
        const body = (await res.json()) as { state: string | null; lastError: unknown; operationId: string | null };
        expect(body.state).toBeNull();
        expect(body.operationId).toBeNull();
        expect(body.lastError).toBeNull();
        // File post-mortem vẫn còn — chỉ giấu khỏi response.
        const persisted = JSON.parse(await readFile(join(dataDir, 'update-state.json'), 'utf8')) as { state: string };
        expect(persisted.state).toBe('rolled-back');
      } finally {
        await rm(join(dataDir, 'update-state.json'), { force: true });
      }
    });

    it('reconciles a persisted in-flight operation to healthy after a daemon restart lands on its target', async () => {
      const versionRes = await fetch(`${baseUrl}/api/update/status`);
      const { currentVersion } = (await versionRes.json()) as { currentVersion: string };
      const startedAt = new Date(Date.now() - 1_000).toISOString();
      await writeFile(join(dataDir, 'update-state.json'), JSON.stringify({
        operationId: 'persisted-op',
        targetVersion: currentVersion,
        sourceVersion: '0.0.0-before-update',
        state: 'restarting',
        phase: { step: 5, totalSteps: 6, label: 'Restarting' },
        error: null,
        startedAt,
        updatedAt: startedAt,
      }), 'utf8');

      const res = await fetch(`${baseUrl}/api/update/status`);
      const body = (await res.json()) as { operationId: string; targetVersion: string; state: string };
      expect(body).toMatchObject({ operationId: 'persisted-op', targetVersion: currentVersion, state: 'healthy' });

      const persisted = JSON.parse(await readFile(join(dataDir, 'update-state.json'), 'utf8')) as { state: string };
      expect(persisted.state).toBe('healthy');
      await rm(join(dataDir, 'update-state.json'), { force: true });
    });

    it('does not report a same-version preparing operation as healthy before restart', async () => {
      const versionRes = await fetch(`${baseUrl}/api/update/status`);
      const { currentVersion } = (await versionRes.json()) as { currentVersion: string };
      const startedAt = new Date().toISOString();
      await writeFile(join(dataDir, 'update-state.json'), JSON.stringify({
        operationId: 'same-version-op',
        targetVersion: currentVersion,
        sourceVersion: currentVersion,
        state: 'preparing',
        phase: null,
        error: null,
        startedAt,
        updatedAt: startedAt,
      }), 'utf8');

      const res = await fetch(`${baseUrl}/api/update/status`);
      const body = (await res.json()) as { operationId: string; state: string };
      expect(body).toMatchObject({ operationId: 'same-version-op', state: 'preparing' });
      await rm(join(dataDir, 'update-state.json'), { force: true });
    });

    it('fails closed for an ambiguous legacy same-version restart record', async () => {
      const versionRes = await fetch(`${baseUrl}/api/update/status`);
      const { currentVersion } = (await versionRes.json()) as { currentVersion: string };
      const startedAt = new Date().toISOString();
      await writeFile(join(dataDir, 'update-state.json'), JSON.stringify({
        operationId: 'legacy-replay-op',
        targetVersion: currentVersion,
        state: 'restarting',
        phase: { step: 5, totalSteps: 6, label: 'Restarting' },
        error: null,
        startedAt,
        updatedAt: startedAt,
      }), 'utf8');

      const res = await fetch(`${baseUrl}/api/update/status`);
      const body = (await res.json()) as { state: string; lastError: { message: string } };
      expect(body.state).toBe('failed');
      expect(body.lastError.message).toContain('cannot verify same-version update');
      await rm(join(dataDir, 'update-state.json'), { force: true });
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
      const applyBody = (await applyRes.json()) as {
        started: boolean;
        operationId: string;
        targetVersion: string;
      };
      expect(applyBody).toMatchObject({ started: true, targetVersion: FAKE_LATEST_VERSION });
      expect(applyBody.operationId).toMatch(/^[0-9a-f-]{36}$/);

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

      const durableState = JSON.parse(await readFile(join(dataDir, 'update-state.json'), 'utf8')) as {
        operationId: string;
        targetVersion: string;
        sourceVersion: string;
        state: string;
      };
      expect(durableState).toMatchObject({
        operationId: applyBody.operationId,
        targetVersion: FAKE_LATEST_VERSION,
        sourceVersion: expect.any(String),
        state: 'preparing',
      });
    });

    it('GET /status reports progress parsed from update.log while the apply is in progress', async () => {
      // afterEach clears update.log between tests, so it's absent here —
      // readUpdateProgress must treat that the same as "no phase line yet".
      const noPhaseYet = await fetch(`${baseUrl}/api/update/status`);
      const noPhaseBody = (await noPhaseYet.json()) as { progress: unknown };
      expect(noPhaseBody.progress).toBeNull();

      await writeFile(
        join(dataDir, 'update.log'),
        '\n\x1b[1m2/6 Kiem tra Node.js\x1b[0m\nsome other unrelated line\n',
        'utf8',
      );
      const withPhase = await fetch(`${baseUrl}/api/update/status`);
      const withPhaseBody = (await withPhase.json()) as {
        progress: { step: number; totalSteps: number; label: string; percent: number } | null;
      };
      expect(withPhaseBody.progress).toEqual({ step: 2, totalSteps: 6, label: 'Kiem tra Node.js', percent: 17 });
      const stateRes = await fetch(`${baseUrl}/api/update/status`);
      const stateBody = (await stateRes.json()) as {
        operationId: string;
        targetVersion: string;
        state: string;
        phase: { step: number; totalSteps: number; label: string };
      };
      expect(stateBody).toMatchObject({
        targetVersion: FAKE_LATEST_VERSION,
        state: 'verifying',
        phase: { step: 2, totalSteps: 6, label: 'Kiem tra Node.js', percent: 17 },
      });
    });

    it('responds already-in-progress on a second call and still does not spawn again', async () => {
      const spawnCallsBefore = spawnCalls.length;
      const res = await fetch(`${baseUrl}/api/update/apply`, { method: 'POST' });
      const body = (await res.json()) as { started: boolean; reason?: string };
      expect(body).toEqual({ started: false, reason: 'already-in-progress' });
      expect(spawnCalls.length).toBe(spawnCallsBefore);
    });

    it('persists a spawn error and exposes it through the compatible lastError field', async () => {
      updateChildListeners.get('error')?.(new Error('spawn bash ENOENT'));

      let body: { state?: string; lastError?: { message: string } | null } = {};
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`${baseUrl}/api/update/status`);
        body = await res.json() as typeof body;
        if (body.state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(body.state).toBe('failed');
      expect(body.lastError?.message).toContain('spawn bash ENOENT');
      const persisted = JSON.parse(await readFile(join(dataDir, 'update-state.json'), 'utf8')) as {
        state: string;
        error: { message: string } | null;
      };
      expect(persisted.state).toBe('failed');
      expect(persisted.error?.message).toContain('spawn bash ENOENT');
    });
  });

  // WP-B: POST /api/update/apply must download the LATEST installer before
  // spawning (so a bug already fixed upstream also fixes the update path
  // itself), falling back to the pre-WP-B "run the currently-installed
  // install.sh" behavior whenever the download fails or fails its sanity
  // check. Each `it` below ends by firing the mocked child's 'error'
  // listener to release `updateApplyInProgress` for the next test — same
  // trick the "persists a spawn error" test above already relies on.
  describe('POST /api/update/apply — installer download source (WP-B)', () => {
    afterEach(async () => {
      installerScriptBody = undefined;
      await rm(join(dataDir, 'update-state.json'), { force: true });
      await rm(join(dataDir, 'update-marker.json'), { force: true });
    });

    it('downloads and spawns the latest remote installer, recording installerSource "remote"', async () => {
      installerScriptBody = '#!/bin/sh\necho fake-latest-installer\n# usage: install.sh --update\n';
      const before = installerFetchCalls;

      const applyRes = await fetch(`${baseUrl}/api/update/apply`, { method: 'POST' });
      const applyBody = (await applyRes.json()) as { started: boolean; operationId: string };
      expect(applyBody.started).toBe(true);
      expect(installerFetchCalls).toBe(before + 1);

      const call = spawnCalls[spawnCalls.length - 1]!;
      expect(call.command).toBe('bash');
      expect(call.args?.[0]).toMatch(/update-installer-.*\.sh$/);
      expect(call.args?.[0]).not.toBe(join(odHomeFixture, 'current', 'install.sh'));
      expect(call.args?.[1]).toBe('--update');

      const statusRes = await fetch(`${baseUrl}/api/update/status`);
      const statusBody = (await statusRes.json()) as { updateState: { installerSource?: string } | null };
      expect(statusBody.updateState?.installerSource).toBe('remote');

      updateChildListeners.get('error')?.(new Error('test cleanup: release apply lock'));
    });

    it('falls back to the local install.sh when the downloaded body is empty (fails sanity check)', async () => {
      installerScriptBody = null; // mock serves a 200 with an empty body
      const applyRes = await fetch(`${baseUrl}/api/update/apply`, { method: 'POST' });
      expect((await applyRes.json() as { started: boolean }).started).toBe(true);

      const call = spawnCalls[spawnCalls.length - 1]!;
      expect(call.command).toBe('bash');
      expect(call.args).toEqual([join(odHomeFixture, 'current', 'install.sh'), '--update']);

      const statusRes = await fetch(`${baseUrl}/api/update/status`);
      const statusBody = (await statusRes.json()) as { updateState: { installerSource?: string } | null };
      expect(statusBody.updateState?.installerSource).toBe('local');

      updateChildListeners.get('error')?.(new Error('test cleanup: release apply lock'));
    });

    it('falls back to the local install.sh when the downloaded body is missing the --update marker', async () => {
      // A real-world failure mode: a captive-portal/proxy returns 200 with
      // an HTML page instead of the script.
      installerScriptBody = '<html><body>Sign in required</body></html>';
      const applyRes = await fetch(`${baseUrl}/api/update/apply`, { method: 'POST' });
      expect((await applyRes.json() as { started: boolean }).started).toBe(true);

      const call = spawnCalls[spawnCalls.length - 1]!;
      expect(call.args).toEqual([join(odHomeFixture, 'current', 'install.sh'), '--update']);

      updateChildListeners.get('error')?.(new Error('test cleanup: release apply lock'));
    });

    it('does not delete the temp installer right after spawning, but sweeps it on the NEXT apply', async () => {
      installerScriptBody = '#!/bin/sh\necho v1\n# --update\n';
      const first = await fetch(`${baseUrl}/api/update/apply`, { method: 'POST' });
      expect((await first.json() as { started: boolean }).started).toBe(true);
      const firstScriptPath = spawnCalls[spawnCalls.length - 1]!.args![0]!;

      // Still there right after the spawn — the installer process is
      // (nominally) still reading from it.
      await expect(readFile(firstScriptPath, 'utf8')).resolves.toContain('--update');

      updateChildListeners.get('error')?.(new Error('test cleanup: release apply lock'));
      await rm(join(dataDir, 'update-state.json'), { force: true });
      await rm(join(dataDir, 'update-marker.json'), { force: true });

      const second = await fetch(`${baseUrl}/api/update/apply`, { method: 'POST' });
      expect((await second.json() as { started: boolean }).started).toBe(true);

      // Swept at the start of the SECOND apply, since it belongs to a
      // different (now-stale) operationId.
      await expect(readFile(firstScriptPath, 'utf8')).rejects.toThrow();

      updateChildListeners.get('error')?.(new Error('test cleanup: release apply lock'));
    });
  });

  // WP-B: the release CHECK (GET /api/update/status) must honor
  // OD_RELEASE_URL the same way — see resolveHostRuntimeReleaseBase's unit
  // tests in update-command-resolution.test.ts for the pure base-resolution
  // logic. This exercises it end-to-end: when set, a failing fetch must NOT
  // fall back to GitHub (install.sh's own preflight treats a pinned source
  // as absolute — see install.sh ~line 488).
  describe('GET /api/update/status honors OD_RELEASE_URL (WP-B)', () => {
    const originalOdReleaseUrl = process.env.OD_RELEASE_URL;

    afterEach(async () => {
      if (originalOdReleaseUrl === undefined) delete process.env.OD_RELEASE_URL;
      else process.env.OD_RELEASE_URL = originalOdReleaseUrl;
      // Restore the shared release cache to the default mirror's value so
      // this test's env override can't leak into any test that runs later.
      await fetch(`${baseUrl}/api/update/status?refresh=1`);
    });

    it('when set and unreachable, does not fall back to GitHub (asserts call counts + the exact URL hit)', async () => {
      // Warm the cache via the default mirror first so there is a known
      // cached release available to serve `stale:true` from.
      await fetch(`${baseUrl}/api/update/status?refresh=1`);

      process.env.OD_RELEASE_URL = `${OVERRIDE_RELEASE_BASE}/`; // trailing slash — base resolution must strip it
      const githubBefore = githubReleaseCalls;
      const overrideBefore = overrideReleaseCalls;
      const mirrorBefore = mirrorReleaseCalls;

      const res = await fetch(`${baseUrl}/api/update/status?refresh=1`);
      const body = (await res.json()) as { checkError: string | null; latestVersion: string | null };

      // Exactly one call, to the override base's release.json — not the
      // default mirror, and never GitHub.
      expect(overrideReleaseCalls).toBe(overrideBefore + 1);
      expect(mirrorReleaseCalls).toBe(mirrorBefore);
      expect(githubReleaseCalls).toBe(githubBefore);
      expect(body.checkError).toBeTruthy();
    });
  });
});
