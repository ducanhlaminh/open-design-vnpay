import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cancelHostCodexDeviceLogin,
  clearHostCodexDeviceLogin,
  hostCodexDeviceLoginStatus,
  HOST_CODEX_DEVICE_LOGIN_ARGS,
  startHostCodexDeviceLogin,
} from '../src/host-codex-login.js';
import { resolveHostCodexStatus } from '../src/sandbox-routes.js';

// A minimal fake `codex login --device-auth` child: the test pushes output
// and decides when/how it exits.
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

const DEVICE_OUTPUT = [
  'Welcome to Codex [v\u001b[90m0.147.0\u001b[0m]',
  'Follow these steps to sign in with ChatGPT using device code authorization:',
  '1. Open this link in your browser and sign in to your account',
  '   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
  '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m',
  '   \u001b[94mY9S1-Q78TL\u001b[0m',
].join('\n');

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('host Codex device login', () => {
  afterEach(() => {
    clearHostCodexDeviceLogin();
    vi.useRealTimers();
  });

  it('is idle before any attempt', () => {
    expect(hostCodexDeviceLoginStatus()).toEqual({ phase: 'idle', url: null, code: null, expiresAt: null, error: null });
  });

  it('runs the host binary with the device-auth args and surfaces URL + code, then done once auth.json carries a login', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const child = fakeChild();
    const spawnLogin = vi.fn(() => child as unknown as ChildProcess);
    let loggedIn = false;
    const probeLoggedIn = vi.fn(async () => loggedIn);

    const started = startHostCodexDeviceLogin('/opt/bin/codex', { CODEX_HOME: '/tmp/x' }, { spawnLogin, probeLoggedIn });
    expect(started.phase).toBe('starting');
    expect(spawnLogin).toHaveBeenCalledWith('/opt/bin/codex', { CODEX_HOME: '/tmp/x' });
    expect(HOST_CODEX_DEVICE_LOGIN_ARGS).toEqual(['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"']);

    child.stdout.write(DEVICE_OUTPUT);
    await flush();
    const awaiting = hostCodexDeviceLoginStatus();
    expect(awaiting.phase).toBe('awaiting-user');
    expect(awaiting.url).toBe('https://auth.openai.com/codex/device');
    expect(awaiting.code).toBe('Y9S1-Q78TL');
    expect(awaiting.expiresAt).toBeTruthy();

    // Browser approval → codex writes auth.json and exits 0.
    loggedIn = true;
    child.emit('close', 0);
    expect(hostCodexDeviceLoginStatus().phase).toBe('verifying');
    await vi.advanceTimersByTimeAsync(1000);
    expect(hostCodexDeviceLoginStatus().phase).toBe('done');
    expect(probeLoggedIn).toHaveBeenCalledWith({ CODEX_HOME: '/tmp/x' });
  });

  it('reports an error when codex exits without a login landing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const child = fakeChild();
    startHostCodexDeviceLogin('/opt/bin/codex', {}, {
      spawnLogin: () => child as unknown as ChildProcess,
      probeLoggedIn: async () => false,
    });
    child.stderr.write('\u001b[31mError: device code expired\u001b[0m\n');
    await flush();
    child.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10_500);
    const status = hostCodexDeviceLoginStatus();
    expect(status.phase).toBe('error');
    expect(status.error).toContain('device code expired');
  });

  it('cancel kills the child and marks the flow cancelled; a new start replaces it', async () => {
    const child = fakeChild();
    startHostCodexDeviceLogin('/opt/bin/codex', {}, {
      spawnLogin: () => child as unknown as ChildProcess,
      probeLoggedIn: async () => false,
    });
    const cancelled = cancelHostCodexDeviceLogin();
    expect(cancelled.phase).toBe('error');
    expect(cancelled.error).toContain('hủy');
    expect(child.kill).toHaveBeenCalled();

    const child2 = fakeChild();
    const again = startHostCodexDeviceLogin('/opt/bin/codex', {}, {
      spawnLogin: () => child2 as unknown as ChildProcess,
      probeLoggedIn: async () => false,
    });
    expect(again.phase).toBe('starting');
    // Late output from the cancelled child is ignored.
    child.stdout.write(DEVICE_OUTPUT);
    await flush();
    expect(hostCodexDeviceLoginStatus().phase).toBe('starting');
  });

  it('spawn failure (binary vanished) becomes a readable error', async () => {
    const child = fakeChild();
    startHostCodexDeviceLogin('/opt/bin/codex', {}, {
      spawnLogin: () => child as unknown as ChildProcess,
      probeLoggedIn: async () => false,
    });
    child.emit('error', new Error('ENOENT'));
    const status = hostCodexDeviceLoginStatus();
    expect(status.phase).toBe('error');
    expect(status.error).toContain('ENOENT');
  });
});

describe('resolveHostCodexStatus', () => {
  const originalPath = process.env.PATH;
  const originalAgentHome = process.env.OD_AGENT_HOME;
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalAgentHome === undefined) delete process.env.OD_AGENT_HOME;
    else process.env.OD_AGENT_HOME = originalAgentHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  it('reports not-installed + missing login when codex is absent and CODEX_HOME is empty (no Docker touched)', async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'od-host-codex-empty-'));
    process.env.PATH = '';
    process.env.OD_AGENT_HOME = emptyDir;
    process.env.CODEX_HOME = emptyDir;
    const status = await resolveHostCodexStatus();
    expect(status.available).toBe(false);
    expect(status.authStatus).toBe('missing');
    expect(status.authMessage).toBeTruthy();
  });

  it('reads the account email from a file-backed auth.json under CODEX_HOME', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'od-host-codex-home-'));
    const payload = Buffer.from(JSON.stringify({ email: 'designer@vnpay.vn' })).toString('base64url');
    await fs.writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'tok', id_token: `h.${payload}.s` } }),
    );
    process.env.CODEX_HOME = home;
    const status = await resolveHostCodexStatus();
    expect(status.authStatus).toBe('ok');
    expect(status.account?.email).toBe('designer@vnpay.vn');
  });
});
