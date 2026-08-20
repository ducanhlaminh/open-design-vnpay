// @vitest-environment jsdom
//
// WP22b — AppImportBanner (+ useAppImportJob) đọc job import nền qua
// GET /api/pipelines/app-import-jobs/active theo contract ĐÃ ĐÓNG
// .tmp/pipeline/wp22-contract.md (mục 1-2-4). Type job dùng bản LOCAL trong
// providers/app-import-jobs.ts (marker "WP22c hợp nhất sang
// @open-design/contracts") nên test cũng khai payload thô, không import type
// từ daemon/contracts.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppImportBanner } from '../../../src/components/pipelines/AppImportBanner';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function activeJobsResponse(job: Record<string, unknown> | null) {
  return new Response(JSON.stringify({ jobs: job ? [job] : [] }), { status: 200 });
}

describe('AppImportBanner', () => {
  it('running: hiện x/y (%) + nút Dừng; bấm Dừng POST đúng URL cancel', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/app-import-jobs/active')) {
          return activeJobsResponse({
            id: 'job-1', appId: 'app-1', status: 'running', done: 3, total: 10, imported: 0, updated: 0, startedAt: Date.now(),
          });
        }
        if (url.includes('/import-jobs/job-1/cancel')) {
          return new Response(
            JSON.stringify({
              ok: true,
              job: { id: 'job-1', appId: 'app-1', status: 'cancelled', done: 3, total: 10, imported: 0, updated: 0, startedAt: Date.now(), finishedAt: Date.now() },
            }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 200 });
      }),
    );

    render(<AppImportBanner appId="app-1" />);
    expect(await screen.findByText(/3\/10 \(30%\)/)).toBeTruthy();
    const stopButton = screen.getByTestId('app-import-banner-stop') as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);
    fireEvent.click(stopButton);

    await waitFor(() =>
      expect(calls.some((c) => c === 'POST /api/pipelines/apps/app-1/import-jobs/job-1/cancel')).toBe(true),
    );
    // Job trả về từ cancel là 'cancelled' → banner đổi sang màn kết quả dừng.
    expect(await screen.findByText(/Đã dừng — đã vào 3\/10 trang\./)).toBeTruthy();
  });

  it('failed: hiện lỗi + "đã vào done/total trang"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/app-import-jobs/active')) {
          return activeJobsResponse({
            id: 'job-2', appId: 'app-1', status: 'failed', done: 2, total: 5, imported: 1, updated: 1,
            error: 'Confluence lỗi 502.', startedAt: Date.now(), finishedAt: Date.now(),
          });
        }
        return new Response('{}', { status: 200 });
      }),
    );

    render(<AppImportBanner appId="app-1" />);
    expect(await screen.findByText(/Confluence lỗi 502\./)).toBeTruthy();
    expect(screen.getByText(/2\/5 trang/)).toBeTruthy();
  });

  it('không có job active của appId: banner tự ẩn (không render gì)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => activeJobsResponse(null)));
    const { container } = render(<AppImportBanner appId="app-1" />);
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe('');
  });

  it('running → succeeded qua 2 lần poll (fake timers): hiện kết quả, onFinished gọi đúng 1 lần', async () => {
    vi.useFakeTimers();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!url.endsWith('/app-import-jobs/active')) return new Response('{}', { status: 200 });
        call += 1;
        if (call <= 2) {
          return activeJobsResponse({
            id: 'job-3', appId: 'app-1', status: 'running', done: call, total: 3, imported: 0, updated: 0, startedAt: Date.now(),
          });
        }
        return activeJobsResponse({
          id: 'job-3', appId: 'app-1', status: 'succeeded', done: 3, total: 3, imported: 3, updated: 0, startedAt: Date.now(), finishedAt: Date.now(),
        });
      }),
    );

    // `poll()` chuỗi vài microtask (fetch → .json() → setState) — flush bằng
    // vài `await Promise.resolve()` liên tiếp thay vì `advanceTimersByTimeAsync`
    // (treo với fetch mock async khi fake timers đang bật, xem report).
    const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

    const onFinished = vi.fn();
    render(<AppImportBanner appId="app-1" onFinished={onFinished} />);
    // Poll #1 — lúc mount.
    await act(flush);
    expect(screen.getByText(/1\/3/)).toBeTruthy();
    expect(onFinished).not.toHaveBeenCalled();

    // Poll #2 — qua interval 3s đầu tiên, vẫn 'running'.
    await act(async () => { vi.advanceTimersByTime(3000); await flush(); });
    expect(screen.getByText(/2\/3/)).toBeTruthy();
    expect(onFinished).not.toHaveBeenCalled();

    // Poll #3 — qua interval 3s thứ hai, chuyển 'succeeded'.
    await act(async () => { vi.advanceTimersByTime(3000); await flush(); });
    expect(screen.getByText(/Đã nhập xong 3 trang/)).toBeTruthy();
    expect(onFinished).toHaveBeenCalledTimes(1);

    // Một khoảng poll nữa không gọi thêm onFinished (đã dừng poll).
    await act(async () => { vi.advanceTimersByTime(3000); await flush(); });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});
