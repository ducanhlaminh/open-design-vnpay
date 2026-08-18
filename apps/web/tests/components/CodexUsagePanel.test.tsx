// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexUsagePanel } from '../../src/components/CodexUsagePanel';

vi.mock('../../src/components/AgentAuthLine', () => ({ AgentAuthLine: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const EMPTY = {
  available: false,
  primary: { utilization: null, resetsAt: null, durationMinutes: null },
  secondary: null,
  planType: null,
  hasCredits: null,
};

function stub(body: unknown, ok = true) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
  });
  return calls;
}

describe('CodexUsagePanel', () => {
  it('shows the daemon reason instead of the old "check Docker" text', async () => {
    stub({ ...EMPTY, reason: 'Codex CLI chưa đăng nhập trên máy này — chạy `codex login`.' });
    render(<CodexUsagePanel />);
    await waitFor(() => expect(screen.getByTestId('codex-usage-reason').textContent).toMatch(/codex login/));
    expect(screen.queryByText(/Docker/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy();
  });

  it('falls back to a host-mode hint (no Docker) when the daemon gives no reason', async () => {
    stub(EMPTY);
    render(<CodexUsagePanel />);
    await waitFor(() => expect(screen.getByTestId('codex-usage-reason').textContent).toMatch(/Codex CLI đã cài và đã đăng nhập/));
    expect(screen.queryByText(/Docker/)).toBeNull();
  });

  it('daemon HTTP error → says the daemon did not answer, retry re-fetches', async () => {
    const calls = stub(EMPTY, false);
    render(<CodexUsagePanel />);
    await waitFor(() => expect(screen.getByTestId('codex-usage-reason').textContent).toMatch(/daemon trả về HTTP 500/));
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it('renders the windows when available', async () => {
    stub({ available: true, primary: { utilization: 43, resetsAt: null, durationMinutes: 10080 }, secondary: null, planType: 'plus', hasCredits: false });
    render(<CodexUsagePanel />);
    await screen.findByText('43%');
    expect(screen.getByText('7 ngày')).toBeTruthy();
  });
});
