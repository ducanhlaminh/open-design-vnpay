// @vitest-environment jsdom
//
// WP25b (.tmp/pipeline/wp25-plan.md, Spec WP25b) — provider "Dựng trong
// Figma": fetch helpers trả {ok,...} không throw + hook useFigmaBuildJob
// (adopt job vừa POST xong / re-attach job đang chạy qua /active, poll 3s,
// dừng sau 3 lần 404 liên tiếp).

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchActiveFigmaBuildJobs,
  fetchFigmaBuildJob,
  fetchFigmaPreviewConfig,
  putFigmaPreviewConfig,
  startFigmaBuild,
  useFigmaBuildJob,
} from '../../src/providers/figma-build-jobs';
import type { FigmaBuildJob } from '../../src/providers/figma-build-jobs';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

describe('startFigmaBuild', () => {
  it('POST đúng route + body {screenKeys}; 202 kèm job → {ok:true,job}', async () => {
    const job: FigmaBuildJob = { id: 'job-1', projectId: 'p1', status: 'running', items: [{ screenKey: 'S1', status: 'queued' }] };
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ job }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await startFigmaBuild('p1', ['S1']);
    expect(res).toEqual({ ok: true, job });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/p1/docs-review/figma-build/start');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ screenKeys: ['S1'] });
  });

  it('409 kèm job hiện có → vẫn {ok:true,job} (coi như adopt, không phải lỗi)', async () => {
    const job: FigmaBuildJob = { id: 'job-2', projectId: 'p1', status: 'running', items: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ job }, { status: 409 })));
    const res = await startFigmaBuild('p1', ['S1']);
    expect(res).toEqual({ ok: true, job });
  });

  it.each([
    ['FIGMA_PREVIEW_FILE_REQUIRED'],
    ['MCP_FIGMA_REQUIRED'],
    ['CATALOG_REQUIRED'],
    ['AGENT_UNAVAILABLE'],
  ])('mã lỗi precheck %s → {ok:false,code}', async (code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ error: { code, message: 'x' } }, { status: 422 })));
    const res = await startFigmaBuild('p1', ['S1']);
    expect(res).toEqual({ ok: false, error: 'x', code });
  });

  it('lỗi mạng → {ok:false} không throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')));
    const res = await startFigmaBuild('p1', ['S1']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('network down');
  });
});

describe('fetchFigmaBuildJob / fetchActiveFigmaBuildJobs', () => {
  it('fetchFigmaBuildJob: 404 → null; 200 → job', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({}, { status: 404 })));
    expect(await fetchFigmaBuildJob('p1', 'job-1')).toBeNull();

    const job: FigmaBuildJob = { id: 'job-1', projectId: 'p1', status: 'succeeded', items: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ job })));
    expect(await fetchFigmaBuildJob('p1', 'job-1')).toEqual(job);
  });

  it('fetchActiveFigmaBuildJobs: lỗi mạng → mảng rỗng', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('down')));
    expect(await fetchActiveFigmaBuildJobs()).toEqual([]);
  });
});

describe('fetchFigmaPreviewConfig / putFigmaPreviewConfig', () => {
  it('GET trải phẳng body {config:{fileKey,url}} của daemon; config null (chưa cấu hình) → {}', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ config: { fileKey: 'FK', url: 'https://www.figma.com/design/FK' } })));
    const res = await fetchFigmaPreviewConfig('p1');
    expect(res).toEqual({ ok: true, config: { fileKey: 'FK', url: 'https://www.figma.com/design/FK' } });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ config: null })));
    const empty = await fetchFigmaPreviewConfig('p1');
    expect(empty).toEqual({ ok: true, config: { fileKey: undefined, url: undefined } });
  });

  it('PUT gọi đúng route + body; lỗi validate → {ok:false,error}', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ error: 'Link Figma không hợp lệ.' }, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await putFigmaPreviewConfig('p1', { url: 'not-a-figma-link' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/p1/docs-review/figma-preview');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PUT');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ url: 'not-a-figma-link' });
    expect(res).toEqual({ ok: false, error: 'Link Figma không hợp lệ.' });
  });
});

describe('useFigmaBuildJob', () => {
  it('adopt(job running) → poll 3s tới khi terminal, rồi dừng', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, { status: 404 }))); // /active mount call → không job.
    const { result } = renderHook(() => useFigmaBuildJob('p1'));
    await waitFor(() => expect(result.current.job).toBeNull());

    const running: FigmaBuildJob = { id: 'job-1', projectId: 'p1', status: 'running', items: [{ screenKey: 'S1', status: 'running' }] };
    act(() => result.current.adopt(running));
    expect(result.current.job).toEqual(running);

    const succeeded: FigmaBuildJob = { id: 'job-1', projectId: 'p1', status: 'succeeded', items: [{ screenKey: 'S1', status: 'succeeded', frameUrl: 'https://figma.com/x' }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ job: succeeded })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(result.current.job).toEqual(succeeded);

    // Đã terminal → không poll tiếp (fetch không bị gọi thêm sau khi đổi mock).
    const spy = vi.mocked(fetch);
    const callsBefore = spy.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
  });

  it('mount tìm thấy job active của project → tự poll bản đầy đủ ngay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const active = [{ jobId: 'job-9', projectId: 'p1', status: 'running' as const, done: 0, total: 2, startedAt: 1 }];
    const full: FigmaBuildJob = { id: 'job-9', projectId: 'p1', status: 'running', items: [{ screenKey: 'S1', status: 'running' }] };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/figma-build-jobs/active')) return response({ jobs: active });
      if (url.includes('/figma-build/job-9')) return response({ job: full });
      return response({}, { status: 404 });
    }));
    const { result } = renderHook(() => useFigmaBuildJob('p1'));
    await waitFor(() => expect(result.current.job).toEqual(full));
  });

  it('404 liên tiếp 3 lần → dừng poll (job giữ nguyên trạng thái cuối)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, { status: 404 })));
    const { result } = renderHook(() => useFigmaBuildJob('p1'));
    await waitFor(() => expect(result.current.job).toBeNull());

    const running: FigmaBuildJob = { id: 'job-x', projectId: 'p1', status: 'running', items: [] };
    act(() => result.current.adopt(running));

    const jobFetchMock = vi.fn().mockResolvedValue(response({}, { status: 404 }));
    vi.stubGlobal('fetch', jobFetchMock);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 3_000);
    });
    expect(result.current.job).toEqual(running); // vẫn trạng thái cuối đã biết
    const callsAfter3 = jobFetchMock.mock.calls.length;
    expect(callsAfter3).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(jobFetchMock.mock.calls.length).toBe(callsAfter3); // không gọi thêm — đã dừng poll
  });
});
