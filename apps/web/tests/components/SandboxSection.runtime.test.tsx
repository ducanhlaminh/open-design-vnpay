// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/ClaudeAccountSwitcher', () => ({
  ClaudeAccountSwitcher: () => <div data-testid="claude-switcher">Claude switcher</div>,
}));

vi.mock('../../src/components/CodexDeviceLogin', () => ({
  CodexDeviceLogin: () => <div data-testid="codex-login">Codex login</div>,
}));

import { SandboxSection } from '../../src/components/SandboxSection';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('SandboxSection runtime split', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
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
              authStatus: 'logged-in',
              loginMethod: 'interactive',
            },
            {
              id: 'codex',
              version: '2.0.0',
              imageAvailable: false,
              authVolume: '/volumes/codex',
              authVolumeAvailable: false,
              authStatus: 'missing',
              loginMethod: 'device',
            },
          ],
        });
      }
      if (url.endsWith('/sandbox/build')) {
        return jsonResponse({ building: false, ok: true, error: null, log: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders Claude and Codex panels independently from runtimeStatuses', async () => {
    render(<SandboxSection daemonLive={true} />);

    await waitFor(() => {
      expect(screen.getByTestId('sandbox-runtime-claude')).toBeTruthy();
      expect(screen.getByTestId('sandbox-runtime-codex')).toBeTruthy();
    });

    const claudeCard = screen.getByTestId('sandbox-runtime-claude');
    const codexCard = screen.getByTestId('sandbox-runtime-codex');
    expect((claudeCard as HTMLDetailsElement).open).toBe(false);
    expect((codexCard as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(within(claudeCard).getByText('Claude runtime').closest('summary')!);
    expect((claudeCard as HTMLDetailsElement).open).toBe(true);
    expect((codexCard as HTMLDetailsElement).open).toBe(false);

    expect(within(claudeCard).getByText('Claude runtime')).toBeTruthy();
    expect(within(claudeCard).getByText('Ready')).toBeTruthy();
    expect(within(claudeCard).getByTestId('claude-switcher')).toBeTruthy();

    expect(within(codexCard).getByText('Codex runtime')).toBeTruthy();
    expect(within(codexCard).getByText('Not ready')).toBeTruthy();
    expect(within(codexCard).getByTestId('codex-login')).toBeTruthy();

    expect(screen.queryByText('Docker engine')).toBeNull();
  });

  it('offers manual Docker setup in Execution even when runtimeStatuses are present', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/sandbox/status')) {
        return jsonResponse({
          enabled: true,
          dockerOk: false,
          image: 'od-agent-sandbox:0.2.1',
          imageOk: false,
          authVolumeOk: false,
          authLoggedIn: null,
          activeContainers: [],
          runtimes: ['claude', 'codex'],
          skills: ['*'],
          timeoutMinutes: 30,
          builderDir: '/tmp/builder',
          runtimeStatuses: [{
            id: 'claude', version: null, imageAvailable: false,
            authVolume: 'od-claude-auth', authVolumeAvailable: false,
            authStatus: 'missing', loginMethod: 'interactive',
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

    render(<SandboxSection daemonLive={true} />);
    const install = await screen.findByRole('button', { name: 'Cài Docker tự động' });
    fireEvent.click(install);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sandbox/docker/setup', { method: 'POST' });
    });
  });

  it('disables Docker installation on Windows until firmware virtualization is enabled', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/sandbox/status')) {
        return jsonResponse({
          enabled: true, dockerOk: false, image: 'od-agent-sandbox:0.2.1', imageOk: false,
          authVolumeOk: false, authLoggedIn: null, activeContainers: [], runtimes: ['claude'],
          skills: ['*'], timeoutMinutes: 30, builderDir: '/tmp/builder', runtimeStatuses: [],
        });
      }
      if (url.endsWith('/sandbox/build')) return jsonResponse({ building: false, ok: null, error: null, log: [] });
      if (url.endsWith('/sandbox/windows/firmware')) {
        return jsonResponse({
          supportedPlatform: true,
          detection: {
            manufacturer: 'Dell', model: 'Latitude', cpuManufacturer: 'Intel',
            virtualizationEnabled: false, virtualizationSupported: true, firmwareType: 'uefi',
          },
          guidance: null, pending: null, canRestartToFirmware: true,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SandboxSection daemonLive={true} />);
    const install = await screen.findByRole('button', { name: 'Bật VT trước khi cài' }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    fireEvent.click(install);
    expect(fetchMock).not.toHaveBeenCalledWith('/api/sandbox/docker/setup', { method: 'POST' });
  });
});
