// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/EmbeddedClaudeLogin', () => ({
  EmbeddedClaudeLogin: () => <div>Claude login</div>,
}));
vi.mock('../../src/components/CodexDeviceLogin', () => ({
  CodexDeviceLogin: () => <div>Codex login</div>,
}));

import { InfraSetupGate } from '../../src/components/InfraSetupGate';

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const sandboxStatus = {
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
};

const windowsSetup = {
  supportedPlatform: true,
  detection: {
    manufacturer: 'Dell Inc.',
    model: 'Latitude 5440',
    cpuManufacturer: 'GenuineIntel',
    virtualizationSupported: true,
    virtualizationEnabled: false,
    firmwareType: 'UEFI',
  },
  canRestartToFirmware: true,
  pending: false,
  guidance: {
    vendor: 'Dell',
    displayName: 'Dell',
    biosKeys: ['F2'],
    menuPaths: ['Virtualization Support', 'Virtualization'],
    settingNames: ['Intel Virtualization Technology'],
    notes: ['Chọn Apply rồi Exit.'],
  },
};

describe('InfraSetupGate Windows virtualization guidance', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/sandbox/status')) return jsonResponse(sandboxStatus);
      if (url.endsWith('/sandbox/build')) return jsonResponse({ building: false, ok: null, error: null, log: [] });
      if (url.endsWith('/sandbox/windows/firmware')) return jsonResponse(windowsSetup);
      if (url.endsWith('/sandbox/windows/firmware/restart') && init?.method === 'POST') return jsonResponse({ ok: true });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows model-specific guidance and requires confirmation before firmware restart', async () => {
    render(<InfraSetupGate daemonLive={true} onOpenSettings={vi.fn()} />);

    expect(await screen.findByText('Dell Inc. Latitude 5440')).toBeTruthy();
    expect(screen.getAllByText(/Bật/).length).toBeGreaterThan(1);
    expect(screen.getAllByText(/Virtualization Support/).length).toBeGreaterThan(0);

    const restart = screen.getByRole('button', { name: 'Khởi động vào BIOS/UEFI' }) as HTMLButtonElement;
    expect(restart.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /đã chụp hoặc lưu hướng dẫn/i }));
    expect(restart.disabled).toBe(false);
    fireEvent.click(restart);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sandbox/windows/firmware/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      });
    });
  });

  it('rechecks firmware state and removes stale VT guidance after Windows reports enabled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let firmwareReads = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/sandbox/status')) return jsonResponse(sandboxStatus);
      if (url.endsWith('/sandbox/build')) return jsonResponse({ building: false, ok: null, error: null, log: [] });
      if (url.endsWith('/sandbox/windows/firmware')) {
        firmwareReads += 1;
        return jsonResponse(firmwareReads === 1 ? windowsSetup : {
          ...windowsSetup,
          detection: { ...windowsSetup.detection, virtualizationEnabled: true },
          canRestartToFirmware: false,
          pending: null,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<InfraSetupGate daemonLive={true} onOpenSettings={vi.fn()} />);
    expect(await screen.findByTestId('windows-virtualization-guide')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => expect(screen.queryByTestId('windows-virtualization-guide')).toBeNull());
    vi.useRealTimers();
  });

  it('shows the vendor BIOS key when direct firmware restart is unavailable', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/sandbox/status')) return jsonResponse(sandboxStatus);
      if (url.endsWith('/sandbox/build')) return jsonResponse({ building: false, ok: null, error: null, log: [] });
      if (url.endsWith('/sandbox/windows/firmware')) {
        return jsonResponse({ ...windowsSetup, canRestartToFirmware: false });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<InfraSetupGate daemonLive={true} onOpenSettings={vi.fn()} />);

    expect((await screen.findByText(/nhấn liên tục/i)).textContent).toContain('F2');
    expect(screen.queryByRole('button', { name: 'Khởi động vào BIOS/UEFI' })).toBeNull();
  });
});
