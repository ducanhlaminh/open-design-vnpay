// WP4 (specs/change/20260813-web-first/wp4-host-default-ui.md): the sandbox
// default flipped from ON to OFF. This suite proves BOTH branches end to end
// over real HTTP — host mode is the new default, and OD_SANDBOX=1 must still
// restore the exact old Docker-sandbox surface (the only safe fallback if
// host mode turns out to have a problem in the field).
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

type StartedServer = { url: string; server: http.Server };

describe('sandbox mode: host is the default (no OD_SANDBOX override)', () => {
  let server: http.Server;
  let baseUrl: string;
  const originalSandboxEnv = process.env.OD_SANDBOX;

  beforeAll(async () => {
    // Exercise the TRUE default, not a leftover env override from another
    // suite in the same worker (fileParallelism is off, but env is process-wide).
    delete process.env.OD_SANDBOX;
    const started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    if (originalSandboxEnv === undefined) delete process.env.OD_SANDBOX;
    else process.env.OD_SANDBOX = originalSandboxEnv;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /api/sandbox/status reports host mode with a hostClaude snapshot', async () => {
    const res = await fetch(`${baseUrl}/api/sandbox/status`);
    const body = (await res.json()) as { enabled: boolean; mode: string; hostClaude?: { authStatus?: string } };
    expect(res.ok).toBe(true);
    expect(body.enabled).toBe(false);
    expect(body.mode).toBe('host');
    expect(body.hostClaude).toBeTruthy();
    expect(['ok', 'missing', 'unknown']).toContain(body.hostClaude?.authStatus);
  });

  it('GET /api/agents does not hide host CLIs behind the Docker-only branch', async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    const body = (await res.json()) as { agents: Array<{ id: string; sandbox?: unknown }> };
    expect(res.ok).toBe(true);
    const claude = body.agents.find((a) => a.id === 'claude');
    expect(claude).toBeTruthy();
    // `agent.sandbox` is only attached by the dockerOnly branch — absent means
    // /api/agents actually probed the host CLI instead of assuming Docker owns it.
    expect(claude?.sandbox).toBeUndefined();
  });

  it('GET /api/usage/codex answers from the HOST Codex CLI, never touching Docker', async () => {
    // Host mode reads the machine's own Codex CLI directly (no Docker) —
    // `available` therefore genuinely depends on whether this machine has
    // Codex installed and logged in, unlike the pre-Piece-3 behavior where
    // this route was an unconditional Docker-only no-op in host mode. What
    // stays a structural invariant regardless of environment is that the
    // Docker sandbox path (`resolveSandboxConfig(...).enabled === false`
    // here) is never reached, so a response shape check is all that's
    // portable across machines with/without Codex installed.
    const res = await fetch(`${baseUrl}/api/usage/codex`);
    const body = (await res.json()) as {
      available: boolean;
      primary: { utilization: number | null; resetsAt: number | null; durationMinutes: number | null };
      secondary: unknown;
    };
    expect(res.ok).toBe(true);
    expect(typeof body.available).toBe('boolean');
    if (!body.available) {
      expect(body.primary).toEqual({ utilization: null, resetsAt: null, durationMinutes: null });
      expect(body.secondary).toBeNull();
    }
  });

  it('POST /api/sandbox/build returns 409 SANDBOX_MODE_HOST instead of a Docker error', async () => {
    const res = await fetch(`${baseUrl}/api/sandbox/build`, { method: 'POST' });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(409);
    expect(body.error?.code).toBe('SANDBOX_MODE_HOST');
  });

  it('POST /api/sandbox/accounts/save returns 409 SANDBOX_MODE_HOST', async () => {
    const res = await fetch(`${baseUrl}/api/sandbox/accounts/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'test' }),
    });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(409);
    expect(body.error?.code).toBe('SANDBOX_MODE_HOST');
  });

  it('POST /api/sandbox/embedded-login returns 409 SANDBOX_MODE_HOST', async () => {
    const res = await fetch(`${baseUrl}/api/sandbox/embedded-login`, { method: 'POST' });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(409);
    expect(body.error?.code).toBe('SANDBOX_MODE_HOST');
  });
});

describe('sandbox mode: OD_SANDBOX=1 restores the pre-WP4 Docker-sandbox surface', () => {
  let server: http.Server;
  let baseUrl: string;
  const originalSandboxEnv = process.env.OD_SANDBOX;

  beforeAll(async () => {
    process.env.OD_SANDBOX = '1';
    const started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    if (originalSandboxEnv === undefined) delete process.env.OD_SANDBOX;
    else process.env.OD_SANDBOX = originalSandboxEnv;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /api/sandbox/status reports sandbox mode', async () => {
    const res = await fetch(`${baseUrl}/api/sandbox/status`);
    const body = (await res.json()) as { enabled: boolean; mode: string };
    expect(res.ok).toBe(true);
    expect(body.enabled).toBe(true);
    expect(body.mode).toBe('sandbox');
  });

  it('POST /api/sandbox/build no longer 409s with SANDBOX_MODE_HOST (falls through to the real docker preflight)', async () => {
    const res = await fetch(`${baseUrl}/api/sandbox/build`, { method: 'POST' });
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    expect(body?.error?.code).not.toBe('SANDBOX_MODE_HOST');
  });
});
