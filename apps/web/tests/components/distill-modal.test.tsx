// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DistillModal } from '../../src/components/pipelines/DistillModal';

const page = (pageId: string, branch: string, state: 'fetched' | 'distilling' | 'distilled', clean = state === 'distilled') => ({
  pageId,
  path: `${branch}/${pageId}.md`,
  title: pageId,
  branch,
  contentHash: `${pageId}-hash`,
  fetchedAt: 1,
  distill: { state, distilledHash: clean ? `${pageId}-hash` : null },
});

const pool = (overrides: Record<string, unknown> = {}) => ({
  pages: [page('a', 'admin', 'fetched'), page('b', 'admin', 'distilling'), page('c', 'ops', 'fetched')],
  distill: { clean: false, pending: 3, running: false, progress: { done: 0, total: 4 } },
  overviewExists: false,
  ...overrides,
});

function response(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DistillModal', () => {
  it('auto-starts a pending pool once and shows branch statuses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (String(url).endsWith('/distill')) return response({ ok: true });
      return response(pool());
    });

    render(<DistillModal appId="app-1" onClose={vi.fn()} />);

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
    expect(screen.getByText('admin')).toBeTruthy();
    expect(screen.getByText('ops')).toBeTruthy();
    expect(screen.getAllByText('Chờ').length).toBeGreaterThan(0);
    expect(screen.getByText('Đang chưng cất')).toBeTruthy();
  });

  it('polls to completion and calls onFinished', async () => {
    vi.useFakeTimers();
    const onFinished = vi.fn();
    const runningPool = pool({
      distill: { clean: false, pending: 1, running: true, progress: { done: 2, total: 4 } },
    });
    const cleanPool = {
      pages: [page('a', 'admin', 'distilled'), page('b', 'admin', 'distilled'), page('c', 'ops', 'distilled')],
      distill: { clean: true, pending: 0, running: false, progress: { done: 4, total: 4 } },
      overviewExists: true,
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => response(runningPool)).mockImplementationOnce(() => response(cleanPool));

    render(<DistillModal appId="app-1" onClose={vi.fn()} onFinished={onFinished} />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('Đã chưng cất').length).toBe(2);
    expect(screen.getByText('Xong')).toBeTruthy();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('shows the server error and retries with a second POST', async () => {
    const errorMessage = 'Agent hết thời gian chờ';
    const failedPool = pool({
      distill: { clean: false, pending: 2, running: false, progress: { done: 1, total: 4, error: errorMessage } },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (String(url).endsWith('/distill')) return response({ ok: true });
      return response(failedPool);
    });

    render(<DistillModal appId="app-1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(errorMessage)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2));
  });

  it('does not start an empty pool and shows the ready state', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => response({
      pages: [],
      distill: { clean: true, pending: 0, running: false },
      overviewExists: true,
    }));

    render(<DistillModal appId="app-1" onClose={vi.fn()} />);
    expect(await screen.findByText('Pool đã chưng cất đủ')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
