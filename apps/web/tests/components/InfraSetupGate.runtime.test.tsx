// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

vi.mock('../../src/components/EmbeddedClaudeLogin', () => ({
  EmbeddedClaudeLogin: () => <div data-testid="claude-login">Claude login</div>,
}));

vi.mock('../../src/components/CodexDeviceLogin', () => ({
  CodexDeviceLogin: () => <div data-testid="codex-login">Codex login</div>,
}));

import { InfraSetupGate } from '../../src/components/InfraSetupGate';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('InfraSetupGate runtime selection', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    loadConfigMock.mockReturnValue({ agentId: null });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/sandbox/status')) {
        return jsonResponse({
          enabled: true,
          dockerOk: true,
          image: 'od-agent-sandbox:latest',
          imageOk: true,
          authVolumeOk: true,
          authLoggedIn: true,
          activeContainers: [],
          runtimes: ['claude', 'codex'],
          skills: ['*'],
          timeoutMinutes: 30,
          builderDir: '/tmp/builder',
          runtimeStatuses: [
            {
              id: 'claude',
              version: '1.0.0',
              imageAvailable: true,
              authVolume: '/volumes/claude',
              authVolumeAvailable: true,
              authStatus: 'ready',
              loginMethod: 'account-switcher',
            },
            {
              id: 'codex',
              version: '2.0.0',
              imageAvailable: false,
              authVolume: '/volumes/codex',
              authVolumeAvailable: false,
              authStatus: 'missing',
              loginMethod: 'device-code',
            },
          ],
        });
      }
      if (url.endsWith('/sandbox/build')) {
        return jsonResponse({ building: false, ok: true, error: null, log: [] });
      }
      if (url.endsWith('/sandbox/accounts')) {
        return jsonResponse({ supported: true, loggedIn: true, activeUnsaved: false, accounts: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('dismisses onboarding when the default Claude runtime is ready even if Codex is not', async () => {
    render(<InfraSetupGate daemonLive={true} onOpenSettings={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByTestId('infra-setup-gate')).toBeNull();
    });
  });

  it('keeps the gate open for an unready selected Codex runtime', async () => {
    loadConfigMock.mockReturnValue({ agentId: 'codex' });

    render(<InfraSetupGate daemonLive={true} onOpenSettings={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('infra-setup-gate')).toBeTruthy();
    });

    expect(screen.getByTestId('codex-login')).toBeTruthy();
    expect(screen.queryByTestId('claude-login')).toBeNull();
    expect((screen.getByRole('button', { name: 'Bắt đầu sử dụng' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers in-app Docker installation when the engine is missing', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/sandbox/status')) {
        return jsonResponse({
          enabled: true,
          dockerOk: false,
          image: 'od-agent-sandbox:latest',
          imageOk: false,
          authVolumeOk: false,
          authLoggedIn: null,
          activeContainers: [],
          runtimes: ['claude'],
          skills: ['*'],
          timeoutMinutes: 30,
          builderDir: '/tmp/builder',
          runtimeStatuses: [{
            id: 'claude', version: null, imageAvailable: false,
            authVolume: 'od-claude-auth', authVolumeAvailable: false,
            authStatus: 'unknown', loginMethod: 'interactive',
          }],
        });
      }
      if (url.endsWith('/sandbox/build')) {
        return jsonResponse({ building: false, ok: null, error: null, log: [] });
      }
      if (url.endsWith('/sandbox/docker/setup') && init?.method === 'POST') {
        return jsonResponse({ phase: 'installing', running: true, dockerOk: false, error: null, log: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<InfraSetupGate daemonLive={true} onOpenSettings={vi.fn()} />);
    const install = await screen.findByRole('button', { name: 'Cài Docker tự động' });
    fireEvent.click(install);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sandbox/docker/setup', { method: 'POST' });
    });
  });
});
