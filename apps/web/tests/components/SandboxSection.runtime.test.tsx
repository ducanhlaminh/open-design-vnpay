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

  // Host mode (the locked default): designer-friendly cards — plain Vietnamese
  // status from the HOST probes, no Docker jargon, no Docker install prompts.
  it('renders plain-language host cards and hides Docker prep in host mode', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/sandbox/status')) {
        return jsonResponse({
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
          builderDir: '/tmp/builder',
          hostClaude: { available: true, version: '2.1.198 (Claude Code)', authStatus: 'ok' },
          runtimeStatuses: [{
            id: 'claude', version: '1.0.0', imageAvailable: true,
            authVolume: 'od-claude-auth', authVolumeAvailable: true,
            authStatus: 'logged-in', loginMethod: 'interactive',
          }],
        });
      }
      if (url.endsWith('/sandbox/build')) {
        return jsonResponse({ building: false, ok: null, error: null, log: [] });
      }
      if (url.endsWith('/api/usage/codex')) {
        return jsonResponse({ available: false, primary: { utilization: null, resetsAt: null, durationMinutes: null }, secondary: null });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SandboxSection daemonLive={true} />);

    const claudeCard = await screen.findByTestId('host-runtime-claude');
    expect(within(claudeCard).getByText('Sẵn sàng')).toBeTruthy();
    expect(within(claudeCard).getByText(/Đã đăng nhập trên máy này/)).toBeTruthy();

    const codexCard = screen.getByTestId('host-runtime-codex');
    await waitFor(() => {
      expect(within(codexCard).getByText('Chưa dùng được')).toBeTruthy();
    });

    // No tech jargon and no Docker cards/panels in host mode.
    expect(screen.queryByText('Auth volume')).toBeNull();
    expect(screen.queryByText('Login method')).toBeNull();
    expect(screen.queryByTestId('sandbox-runtime-claude')).toBeNull();
    expect(screen.queryByTestId('sandbox-docker-setup')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cài Docker tự động' })).toBeNull();
  });

  it('logs out the host Claude CLI from the host card after a confirm', async () => {
    const hostStatus = (authStatus: string, email?: string) => ({
      enabled: false,
      mode: 'host',
      dockerOk: true,
      image: 'od-agent-sandbox:latest',
      imageOk: true,
      authVolumeOk: true,
      authLoggedIn: null,
      activeContainers: [],
      runtimes: ['claude', 'codex'],
      skills: ['*'],
      timeoutMinutes: 30,
      builderDir: '/tmp/builder',
      hostClaude: {
        available: true,
        version: '2.1.198 (Claude Code)',
        authStatus,
        ...(email ? { account: { email } } : {}),
      },
      runtimeStatuses: [],
    });
    let loggedOut = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/sandbox/status')) {
        return jsonResponse(loggedOut ? hostStatus('missing') : hostStatus('ok', 'designer@vnpay.vn'));
      }
      if (url.endsWith('/sandbox/build')) {
        return jsonResponse({ building: false, ok: null, error: null, log: [] });
      }
      if (url.endsWith('/api/usage/codex')) {
        return jsonResponse({ available: false, primary: { utilization: null, resetsAt: null, durationMinutes: null }, secondary: null });
      }
      if (url.endsWith('/api/sandbox/host/claude/logout') && init?.method === 'POST') {
        loggedOut = true;
        return jsonResponse({ ok: true, hostClaude: { available: true, authStatus: 'missing' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<SandboxSection daemonLive={true} />);

    const claudeCard = await screen.findByTestId('host-runtime-claude');
    expect(within(claudeCard).getByText(/designer@vnpay\.vn/)).toBeTruthy();

    fireEvent.click(within(claudeCard).getByRole('button', { name: 'Đăng xuất' }));
    expect(confirmSpy).toHaveBeenCalled();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sandbox/host/claude/logout', { method: 'POST' });
      // The card flipped to the logged-out state and now offers a re-check.
      expect(within(claudeCard).getByText('Cần đăng nhập')).toBeTruthy();
      expect(within(claudeCard).getByRole('button', { name: 'Kiểm tra lại' })).toBeTruthy();
    });
  });

  // WP4 (web-first migration): execution-mode toggle writes sandbox.enabled
  // through the same PUT /api/app-config prefs path `od sandbox enable|disable` uses.
  it('switches to host mode through PUT /api/app-config when the toggle is clicked', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/sandbox/status')) {
        return jsonResponse({
          enabled: true,
          mode: 'sandbox',
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
          runtimeStatuses: [],
        });
      }
      if (url.endsWith('/sandbox/build')) {
        return jsonResponse({ building: false, ok: true, error: null, log: [] });
      }
      if (url.endsWith('/api/app-config') && (!init || !init.method || init.method === 'GET')) {
        return jsonResponse({ config: { sandbox: { enabled: true } } });
      }
      if (url.endsWith('/api/app-config') && init?.method === 'PUT') {
        return jsonResponse({ config: { sandbox: { enabled: false } } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SandboxSection daemonLive={true} />);

    // `t()` resolves to the English dict by default in this test environment.
    const hostBtn = await screen.findByRole('radio', { name: 'Host CLI (default)' });
    fireEvent.click(hostBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/app-config',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ sandbox: { enabled: false } }),
        }),
      );
    });
  });
});
