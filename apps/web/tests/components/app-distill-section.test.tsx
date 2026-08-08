// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppDistillSection } from '../../src/components/pipelines/AppDistillSection';
import { fetchProjectFileText } from '../../src/providers/registry';

vi.mock('../../src/providers/registry', () => ({ fetchProjectFileText: vi.fn() }));

const page = (id: string, branch: string, state: 'fetched' | 'distilling' | 'distilled', clean = state === 'distilled') => ({
  pageId: id, path: `${branch}/${id}.md`, title: id, branch, contentHash: `${id}-hash`, fetchedAt: 1,
  distill: { state, distilledHash: clean ? `${id}-hash` : null },
});
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const pool = (overrides: Record<string, unknown> = {}) => ({
  pages: [page('a', 'admin', 'fetched'), page('b', 'ops', 'fetched')],
  distill: { clean: false, pending: 2, running: false, progress: { done: 0, total: 2 } }, overviewExists: false, ...overrides,
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('AppDistillSection', () => {
  it('shows the hero and starts one distill job', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => response(pool())).mockImplementation((url, init) => {
      if (init?.method === 'POST') return response({ ok: true });
      return response(pool({ distill: { clean: false, pending: 2, running: true, progress: { done: 0, total: 2 } } }));
    });
    render(<AppDistillSection appId="app-1" />);
    expect(await screen.findByRole('button', { name: 'Chưng cất tài liệu' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Chưng cất tài liệu' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
    expect(screen.getByText(/Bắt đầu chưng cất/)).toBeTruthy();
  });

  it('polls to a clean pool and lists distilled files', async () => {
    vi.useFakeTimers();
    const running = pool({ distill: { clean: false, pending: 1, running: true, progress: { done: 1, total: 2 } } });
    const clean = { pages: [page('a', 'admin', 'distilled'), page('b', 'ops', 'distilled')], distill: { clean: true, pending: 0, running: false, progress: { done: 2, total: 2 } }, overviewExists: true };
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => response(running)).mockImplementationOnce(() => response(clean));
    render(<AppDistillSection appId="app-1" />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByText('Đã chưng cất đủ')).toBeTruthy();
    expect(screen.getByText(/Hoàn tất/)).toBeTruthy();
    expect(screen.getByText('_overview.md')).toBeTruthy();
    expect(screen.getByText('_branches/admin.md')).toBeTruthy();
  });

  it('shows a failed run and retry action', async () => {
    const message = 'Agent hết thời gian chờ';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(pool({ distill: { clean: false, pending: 2, running: false, progress: { done: 1, total: 2, error: message } } }))));
    render(<AppDistillSection appId="app-1" />);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy();
  });

  it('loads and renders the overview preview', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ pages: [page('a', 'admin', 'distilled')], distill: { clean: true, pending: 0, running: false }, overviewExists: true })));
    vi.mocked(fetchProjectFileText).mockResolvedValue('# Tổng quan');
    render(<AppDistillSection appId="app-1" />);
    fireEvent.click(await screen.findByText('_overview.md'));
    await waitFor(() => expect(fetchProjectFileText).toHaveBeenCalledWith('app-1', 'docs/_overview.md'));
    expect(await screen.findByText('Tổng quan')).toBeTruthy();
  });
});
