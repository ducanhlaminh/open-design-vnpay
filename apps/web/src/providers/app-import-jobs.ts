'use client';

// WP22b — App-docs import chạy nền (job daemon), theo contract ĐÃ ĐÓNG
// .tmp/pipeline/wp22-contract.md (mục 1-2-4). Daemon (WP22a) chạy SONG SONG
// trên apps/daemon + packages/contracts — trong lúc hai WP chạy song song,
// web KHÔNG import type từ @open-design/contracts cho job này; type dưới đây
// là bản LOCAL, nguyên văn contract mục 1.
//
// WP22c hợp nhất sang @open-design/contracts.

import { useCallback, useEffect, useRef, useState } from 'react';

/** WP22c hợp nhất sang @open-design/contracts. Nguyên văn
 *  packages/contracts/src/api/pipelines.ts (WP22a) — xem contract mục 1. */
export interface AppImportJob {
  id: string;
  appId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  /** Pha của LÔ hiện tại — chỉ có nghĩa khi status==='running'. */
  phase?: 'preparing' | 'committing';
  /** Số ref đã ĐƯỢC COMMIT vào pool (cộng dồn theo lô đã xong). */
  done: number;
  total: number;
  imported: number;
  updated: number;
  /** Khi status==='failed' — lỗi của lô làm dừng job. */
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface StartAppImportOptions {
  refs: string[];
  relatedRefs?: string[];
  followLinks?: boolean;
  includeDescendants?: boolean;
}

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** POST .../import-confluence/start — contract mục 2. 202 kèm job 'running'
 *  ngay lập tức (không chờ lô đầu tiên xong). Lỗi 404/400/409 trả về
 *  `{ok:false}` với `status` để caller phân biệt "App không tồn tại"/"refs
 *  rỗng"/"đang có import khác chạy" mà không cần parse message. */
export async function startAppImport(
  appId: string,
  options: StartAppImportOptions,
): Promise<{ ok: true; job: AppImportJob } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(`/api/pipelines/apps/${encodeURIComponent(appId)}/import-confluence/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options),
    });
    const body = await readJson<{ job?: AppImportJob; error?: string }>(res);
    if (!res.ok || !body?.job) return { ok: false, status: res.status, error: body?.error ?? `HTTP ${res.status}` };
    return { ok: true, job: body.job };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** GET /api/pipelines/app-import-jobs/active — contract mục 2. Mọi job
 *  'running' + các job đã kết thúc trong 10 phút gần nhất. Network lỗi →
 *  mảng rỗng (hook coi như "hiện không có job", không phải một trạng thái
 *  cần hiện lỗi riêng). */
export async function fetchActiveImportJobs(signal?: AbortSignal): Promise<AppImportJob[]> {
  try {
    const res = await fetch('/api/pipelines/app-import-jobs/active', { signal });
    if (!res.ok) return [];
    const body = await readJson<{ jobs?: AppImportJob[] }>(res);
    return body?.jobs ?? [];
  } catch {
    return [];
  }
}

/** POST .../import-jobs/:jobId/cancel — contract mục 2. Idempotent trên job
 *  đã kết thúc (daemon trả job nguyên trạng). */
export async function cancelAppImport(
  appId: string,
  jobId: string,
): Promise<{ ok: true; job: AppImportJob } | { ok: false; error: string }> {
  try {
    const res = await fetch(
      `/api/pipelines/apps/${encodeURIComponent(appId)}/import-jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: 'POST' },
    );
    const body = await readJson<{ ok?: boolean; job?: AppImportJob; error?: string }>(res);
    if (!res.ok || !body?.job) return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
    return { ok: true, job: body.job };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Cùng cadence với các poll job nền khác trong pipelines UI (xem
 *  AppDesignSystemPanel's GUIDE_JOB_POLL_MS). */
const POLL_MS = 3_000;

/** Hook dùng chung cho banner tiến độ import (AppImportBanner, mount ở
 *  PipelinesFeaturesView + AppPoolSection). Luôn làm MỘT lần fetch lúc mount
 *  để phát hiện job còn sống (hoặc vừa kết thúc trong 10 phút) của `appId`;
 *  chỉ bắt đầu poll mỗi 3s tiếp theo khi lần fetch đó (hay lần poll gần nhất)
 *  thấy job 'running'. Job không tồn tại/đã kết thúc → dừng poll, nhưng job
 *  đã kết thúc vẫn được GIỮ trong state để banner còn hiện được kết quả cho
 *  tới khi người dùng tự đóng (`dismiss`). */
export function useAppImportJob(appId: string): {
  job: AppImportJob | null;
  cancel: () => Promise<void>;
  dismiss: () => void;
} {
  const [job, setJob] = useState<AppImportJob | null>(null);
  const jobRef = useRef<AppImportJob | null>(null);
  jobRef.current = job;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const poll = useCallback(async (): Promise<AppImportJob | null> => {
    const jobs = await fetchActiveImportJobs();
    const mine = jobs.find((candidate) => candidate.appId === appId) ?? null;
    setJob(mine);
    if (!mine || mine.status !== 'running') stopPoll();
    return mine;
  }, [appId, stopPoll]);

  useEffect(() => {
    let alive = true;
    setJob(null);
    stopPoll();
    void poll().then((first) => {
      if (!alive || !first || first.status !== 'running') return;
      timerRef.current = setInterval(() => { void poll(); }, POLL_MS);
    });
    return () => {
      alive = false;
      stopPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `poll`/`stopPoll` are stable per-appId via useCallback deps above.
  }, [appId]);

  const cancel = useCallback(async () => {
    const current = jobRef.current;
    if (!current) return;
    const result = await cancelAppImport(appId, current.id);
    if (result.ok) {
      setJob(result.job);
      if (result.job.status !== 'running') stopPoll();
    }
  }, [appId, stopPoll]);

  const dismiss = useCallback(() => {
    stopPoll();
    setJob(null);
  }, [stopPoll]);

  return { job, cancel, dismiss };
}
