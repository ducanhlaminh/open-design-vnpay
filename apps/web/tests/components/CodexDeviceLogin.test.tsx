// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexDeviceLogin } from '../../src/components/CodexDeviceLogin';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('CodexDeviceLogin', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('polls through the device-code phases until the login completes', async () => {
    const onComplete = vi.fn();
    const onAuthChanged = vi.fn();
    const pollResponses = [
      { phase: 'awaiting-user', url: 'https://example.com/device', code: 'ABCD-1234', expiresAt: '2026-08-10T08:30:00Z', error: null },
      { phase: 'verifying', url: 'https://example.com/device', code: 'ABCD-1234', expiresAt: '2026-08-10T08:30:00Z', error: null },
      { phase: 'done', url: 'https://example.com/device', code: 'ABCD-1234', expiresAt: '2026-08-10T08:30:00Z', error: null },
    ] as const;
    let pollIndex = 0;

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/login') && method === 'POST') {
        return jsonResponse({ phase: 'starting', url: null, code: null, expiresAt: null, error: null });
      }
      if (url.endsWith('/login')) {
        const poll = pollResponses[Math.min(pollIndex, pollResponses.length - 1)];
        pollIndex += 1;
        return jsonResponse(poll);
      }
      if (url.endsWith('/auth') && method === 'DELETE') {
        return jsonResponse({}, true);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    render(<CodexDeviceLogin onComplete={onComplete} onAuthChanged={onAuthChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start login' }));

    await waitFor(() => {
      expect(screen.getByText('Starting device-code login…')).toBeTruthy();
    });

    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => {
      expect(screen.getByText('Waiting for you to approve the login…')).toBeTruthy();
      expect(screen.getByText('ABCD-1234')).toBeTruthy();
    });

    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => {
      expect(screen.getByText('Verifying the code…')).toBeTruthy();
    });

    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => {
      expect(screen.getByText('Signed in.')).toBeTruthy();
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onAuthChanged).toHaveBeenCalled();
  });

  it('exposes retry after an error and lets the user cancel a live session', async () => {
    let loginPosts = 0;

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/login') && method === 'POST') {
        loginPosts += 1;
        if (loginPosts === 1) {
          return jsonResponse({ phase: 'error', url: null, code: null, expiresAt: null, error: 'Device code expired' });
        }
        return jsonResponse({ phase: 'starting', url: null, code: null, expiresAt: null, error: null });
      }
      if (url.endsWith('/login') && method !== 'POST') {
        return jsonResponse({ phase: 'starting', url: null, code: null, expiresAt: null, error: null });
      }
      if (url.endsWith('/login/cancel')) {
        return jsonResponse({ phase: 'idle', url: null, code: null, expiresAt: null, error: null });
      }
      if (url.endsWith('/auth') && method === 'DELETE') {
        return jsonResponse({}, true);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    render(<CodexDeviceLogin />);

    fireEvent.click(screen.getByRole('button', { name: 'Start login' }));

    await waitFor(() => {
      expect(screen.getByText('Device code expired')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Retry test' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry test' }));

    await waitFor(() => {
      expect(screen.getByText('Starting device-code login…')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start login' })).toBeTruthy();
    });
  });
});
