// @vitest-environment jsdom
// Background polling budget of the infra gate. A ready host-mode machine
// (the prod default) must NOT keep the 4 s /api/agents + /api/sandbox/status
// loops (nor the Windows PowerShell firmware probe) alive for the whole
// session once the gate has decided there is nothing to show — on Windows
// those spawns starved every other request ("chuyển trang chậm").
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>('../../src/state/config');
  return { ...actual, loadConfig: loadConfigMock };
});
vi.mock('../../src/components/EmbeddedClaudeLogin', () => ({ EmbeddedClaudeLogin: () => <div /> }));
vi.mock('../../src/components/CodexDeviceLogin', () => ({ CodexDeviceLogin: () => <div /> }));

import { InfraSetupGate } from '../../src/components/InfraSetupGate';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const hostStatus = {
  enabled: false,
  mode: 'host',
  dockerOk: false,
  image: 'od-agent-sandbox:latest',
  imageOk: false,
  authVolumeOk: false,
  authLoggedIn: null,
  activeContainers: [],
  runtimes: ['claude', 'codex'],
  skills: ['*'],
  timeoutMinutes: 30,
  builderDir: 'C:\\builder',
  hostClaude: { available: true, authStatus: 'ok' },
  hostCodex: { available: false, authStatus: 'missing' },
  runtimeStatuses: [],
};

async function settle() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(10);
}

describe('InfraSetupGate background polling', () => {
  const fetchMock = vi.fn();
  const calls = () => fetchMock.mock.calls.map((c) => String(c[0]).split('?')[0] ?? '');
  const count = (path: string) => calls().filter((u) => u.endsWith(path)).length;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    window.localStorage.clear();
    fetchMock.mockReset();
    loadConfigMock.mockReturnValue({ agentId: null });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    // Pretend to be the Windows pilot machine so the firmware loop is eligible.
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/sandbox/status')) return jsonResponse(hostStatus);
      if (url.endsWith('/api/agents')) {
        return jsonResponse({ agents: [
          { id: 'claude', name: 'Claude', available: true, authStatus: 'ok', models: [] },
          { id: 'codex', name: 'Codex', available: false, models: [] },
        ] });
      }
      if (url.endsWith('/sandbox/build')) return jsonResponse({ building: false, ok: null, error: null, log: [] });
      if (url.includes('/sandbox/windows/firmware')) return jsonResponse({ supportedPlatform: true, detection: null, guidance: null, pending: null, canRestartToFirmware: false });
      throw new Error(`Unexpected fetch: ${url}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('host mode + Claude ready: probes once, decides, then stops polling (no agents/status/firmware loops)', async () => {
    const { container } = render(<InfraSetupGate daemonLive={true} onOpenSettings={vi.fn()} />);
    // Let the first status + agents answers land and the verdict settle
    // (each fetch → setState → effect → next fetch needs its own flush).
    await settle();
    expect(container.textContent).toBe(''); // fully provisioned → nothing rendered
    const agentsAfterVerdict = count('/api/agents');
    const statusAfterVerdict = count('/api/sandbox/status');
    expect(agentsAfterVerdict).toBeGreaterThanOrEqual(1);
    expect(statusAfterVerdict).toBeGreaterThanOrEqual(1);

    // A whole minute of session time: no further background traffic.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count('/api/agents')).toBe(agentsAfterVerdict);
    expect(count('/api/sandbox/status')).toBe(statusAfterVerdict);
    expect(count('/api/sandbox/windows/firmware')).toBe(0);
  });

  it('host mode + nothing logged in: keeps the 4 s /api/agents loop (gate is on screen) but never touches Docker/firmware', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/sandbox/status')) return jsonResponse(hostStatus);
      if (url.endsWith('/api/agents')) {
        return jsonResponse({ agents: [
          { id: 'claude', name: 'Claude', available: true, authStatus: 'missing', models: [] },
          { id: 'codex', name: 'Codex', available: false, models: [] },
        ] });
      }
      if (url.endsWith('/sandbox/build')) return jsonResponse({ building: false, ok: null, error: null, log: [] });
      if (url.includes('/sandbox/windows/firmware')) return jsonResponse({ supportedPlatform: true, detection: null, guidance: null, pending: null, canRestartToFirmware: false });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { container } = render(<InfraSetupGate daemonLive={true} onOpenSettings={vi.fn()} />);
    await settle();
    expect(container.textContent).not.toBe(''); // gate shown: Claude needs login
    const statusAfterFirst = count('/api/sandbox/status');
    const agentsAfterFirst = count('/api/agents');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(count('/api/agents')).toBeGreaterThan(agentsAfterFirst); // live verdict while visible
    expect(count('/api/sandbox/status')).toBe(statusAfterFirst); // one answer was enough to learn the mode
    expect(count('/api/sandbox/windows/firmware')).toBe(0);
  });
});
