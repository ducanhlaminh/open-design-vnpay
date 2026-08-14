// @vitest-environment jsdom
//
// The Claude quota used to be an always-visible header chip that polled
// /api/usage/claude every 60s from every open tab. That traffic drove the
// upstream usage endpoint into HTTP 429, and a rate-limited read renders as
// "unavailable" — so the meter simply vanished, which looked identical to being
// signed out. It now lives in the Local CLI dropdown and reads on open.
//
// What must hold: nothing is requested until the dropdown opens, opening it
// costs exactly one request, and a refused read says so instead of rendering
// nothing.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (k: string) => k }),
  useT: () => (k: string) => k,
}));

const AVAILABLE_USAGE = {
  available: true,
  fiveHour: { utilization: 33, resetsAt: null },
  sevenDay: { utilization: 81, resetsAt: null },
  subscriptionType: 'max',
};

const UNAVAILABLE_USAGE = {
  available: false,
  fiveHour: { utilization: null, resetsAt: null },
  sevenDay: { utilization: null, resetsAt: null },
  subscriptionType: null,
};

const claude = {
  id: 'claude',
  name: 'Claude Code',
  available: true,
  models: [{ id: 'default', label: 'Default' }],
} as unknown as AgentInfo;

const config = {
  mode: 'daemon',
  agentId: 'claude',
  model: '',
  agentModels: {},
} as unknown as AppConfig;

let usageCalls = 0;
let codexUsageCalls = 0;
let usageBody: unknown = AVAILABLE_USAGE;
let usageOk = true;

function renderSwitcher() {
  return render(
    <InlineModelSwitcher
      config={config}
      agents={[claude]}
      daemonLive
      onModeChange={() => undefined}
      onAgentChange={() => undefined}
      onAgentModelChange={() => undefined}
      onApiProtocolChange={() => undefined}
      onApiModelChange={() => undefined}
      onRefreshAgents={() => []}
      onOpenSettings={() => undefined}
    />,
  );
}

const openDropdown = () =>
  fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

beforeEach(() => {
  usageCalls = 0;
  codexUsageCalls = 0;
  usageBody = AVAILABLE_USAGE;
  usageOk = true;
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).includes('/api/usage/claude')) usageCalls += 1;
    if (String(url).includes('/api/usage/codex')) {
      codexUsageCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          available: true,
          primary: { utilization: 43, resetsAt: null, durationMinutes: 10080 },
          secondary: null,
          planType: 'plus',
          hasCredits: false,
        }),
      } as Response;
    }
    return { ok: usageOk, status: usageOk ? 200 : 500, json: async () => usageBody } as Response;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Claude quota in the Local CLI dropdown', () => {
  it('requests nothing until the dropdown is opened', () => {
    renderSwitcher();
    expect(usageCalls).toBe(0);
    expect(screen.queryByText('33%')).toBeNull();
  });

  it('reads the quota once on open and shows both windows', async () => {
    renderSwitcher();
    openDropdown();

    await waitFor(() => expect(screen.getByText('33%')).toBeTruthy());
    expect(screen.getByText('81%')).toBeTruthy();
    expect(usageCalls).toBe(1);
  });

  it('says the read was refused instead of rendering nothing', async () => {
    usageBody = UNAVAILABLE_USAGE;
    renderSwitcher();
    openDropdown();

    await waitFor(() => expect(screen.getByText(/Chưa đọc được mức dùng/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy();
  });

  it('retries on demand after a refused read', async () => {
    usageBody = UNAVAILABLE_USAGE;
    renderSwitcher();
    openDropdown();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy());
    expect(usageCalls).toBe(1);

    usageBody = AVAILABLE_USAGE;
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));

    await waitFor(() => expect(screen.getByText('33%')).toBeTruthy());
    expect(usageCalls).toBe(2);
  });

  it('reads the real Codex allowance once when the Codex Local CLI is opened', async () => {
    const codex = { ...claude, id: 'codex', name: 'Codex' } as AgentInfo;
    render(
      <InlineModelSwitcher
        config={{ ...config, agentId: 'codex' } as AppConfig}
        agents={[codex]}
        daemonLive
        onModeChange={() => undefined}
        onAgentChange={() => undefined}
        onAgentModelChange={() => undefined}
        onApiProtocolChange={() => undefined}
        onApiModelChange={() => undefined}
        onRefreshAgents={() => []}
        onOpenSettings={() => undefined}
      />,
    );
    openDropdown();

    await waitFor(() => expect(screen.getByText('43%')).toBeTruthy());
    expect(usageCalls).toBe(0);
    expect(codexUsageCalls).toBe(1);
  });
});
