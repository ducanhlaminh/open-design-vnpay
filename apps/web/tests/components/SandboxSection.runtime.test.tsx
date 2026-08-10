// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
      if (url.endsWith('/sandbox/status')) {
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

    expect(within(claudeCard).getByText('Claude runtime')).toBeTruthy();
    expect(within(claudeCard).getByText('Ready')).toBeTruthy();
    expect(within(claudeCard).getByTestId('claude-switcher')).toBeTruthy();

    expect(within(codexCard).getByText('Codex runtime')).toBeTruthy();
    expect(within(codexCard).getByText('Not ready')).toBeTruthy();
    expect(within(codexCard).getByTestId('codex-login')).toBeTruthy();

    expect(screen.queryByText('Docker engine')).toBeNull();
  });
});
