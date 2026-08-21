import { useCallback, useEffect, useRef, useState } from 'react';

// WP25b (.tmp/pipeline/wp25-plan.md, Spec WP25b) — type cục bộ theo hợp đồng
// mà WP25a (daemon, chạy song song trên nhánh khác) sẽ dựng. `@open-design/contracts`
// CHƯA có các type/field dưới đây trong lúc hai WP chạy song song, nên khai
// báo cục bộ ở đây thay vì import từ apps/daemon (sẽ vỡ do daemon chưa merge).
// Marker để dễ tìm: WP25 chờ hợp nhất sang @open-design/contracts.

export type FigmaBuildJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/** Trạng thái dựng của MỘT màn trong job (item). */
export interface FigmaBuildJobItem {
  screenKey: string;
  status: FigmaBuildJobStatus;
  frameUrl?: string;
  error?: string;
}

/** Contract WP25 — GET /api/projects/:projectId/docs-review/figma-build/:jobId
 *  (và body 202 của POST .../figma-build/start). */
export interface FigmaBuildJob {
  id: string;
  projectId: string;
  status: FigmaBuildJobStatus;
  items: FigmaBuildJobItem[];
  message?: string;
}

/** Contract WP25 — GET /api/figma-build-jobs/active. Bản NHẸ, khuôn
 *  FigmaGuideActiveJob (providers/figma-design-systems.ts). */
export interface FigmaBuildActiveJob {
  jobId: string;
  projectId: string;
  status: FigmaBuildJobStatus;
  done: number;
  total: number;
  startedAt: number;
  finishedAt?: number;
}

/** Mã lỗi precheck của POST .../figma-build/start (Spec WP25b intent;
 *  MCP_FIGMA_CONNECT_REQUIRED thêm ở WP26 — server đã seed sẵn nhưng chưa
 *  bấm Connect/OAuth, khác với chưa có server nào). */
export type FigmaBuildStartErrorCode =
  | 'FIGMA_PREVIEW_FILE_REQUIRED'
  | 'MCP_FIGMA_REQUIRED'
  | 'MCP_FIGMA_CONNECT_REQUIRED'
  | 'CATALOG_REQUIRED'
  | 'AGENT_UNAVAILABLE';

/** Contract WP25 — GET/PUT /api/projects/:projectId/docs-review/figma-preview. */
export interface FigmaPreviewConfig {
  fileKey?: string;
  url?: string;
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

interface ErrorBody {
  error?: string | { code?: string; message?: string };
  code?: string;
}

function errCodeAndMessage(body: ErrorBody | null): { code?: string; message?: string } {
  const err = body?.error;
  if (typeof err === 'string') return { message: err };
  if (err && typeof err === 'object') return { code: err.code, message: err.message };
  if (body?.code) return { code: body.code };
  return {};
}

/** POST /api/projects/:projectId/docs-review/figma-build/start. Trả `{ok,...}`
 *  không throw (convention providers/figma-design-systems.ts:185-192) — component
 *  tự quyết cách hiện lỗi theo `code`.
 *  409 (job khác của project đang chạy) kèm `job` hiện có → coi như thành công
 *  (component gọi `adopt()` y hệt trường hợp 202, không phải một lỗi cần hiện). */
export async function startFigmaBuild(
  projectId: string,
  screenKeys: string[],
): Promise<{ ok: true; job: FigmaBuildJob } | { ok: false; error: string; code?: FigmaBuildStartErrorCode }> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/docs-review/figma-build/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screenKeys }),
    });
    const body = await readJson<ErrorBody & { job?: FigmaBuildJob }>(response);
    if ((response.ok || response.status === 409) && body?.job) {
      return { ok: true, job: body.job };
    }
    const { code, message } = errCodeAndMessage(body ?? null);
    return { ok: false, error: message ?? `HTTP ${response.status}`, code: code as FigmaBuildStartErrorCode | undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** GET /api/projects/:projectId/docs-review/figma-build/:jobId. Network lỗi /
 *  404 → null (khuôn fetchFigmaDesignSystemGuideJob). */
export async function fetchFigmaBuildJob(projectId: string, jobId: string, signal?: AbortSignal): Promise<FigmaBuildJob | null> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/docs-review/figma-build/${encodeURIComponent(jobId)}`, { signal });
    if (!response.ok) return null;
    const body = await readJson<{ job?: FigmaBuildJob }>(response);
    return body?.job ?? null;
  } catch {
    return null;
  }
}

/** GET /api/figma-build-jobs/active. Network lỗi → mảng rỗng (khuôn
 *  fetchActiveGuideJobs — coi như "hiện không có job", không phải lỗi riêng). */
export async function fetchActiveFigmaBuildJobs(signal?: AbortSignal): Promise<FigmaBuildActiveJob[]> {
  try {
    const response = await fetch('/api/figma-build-jobs/active', { signal });
    if (!response.ok) return [];
    const body = await readJson<{ jobs?: FigmaBuildActiveJob[] }>(response);
    return body?.jobs ?? [];
  } catch {
    return [];
  }
}

/** GET /api/projects/:projectId/docs-review/figma-preview. Daemon bọc payload
 *  trong `{config}` (config = null khi chưa cấu hình — phân biệt được với
 *  "config rỗng"); helper trải phẳng về FigmaPreviewConfig cho component. */
export async function fetchFigmaPreviewConfig(
  projectId: string,
): Promise<{ ok: true; config: FigmaPreviewConfig } | { ok: false; error: string }> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/docs-review/figma-preview`);
    const body = await readJson<{ config?: FigmaPreviewConfig | null } & ErrorBody>(response);
    if (!response.ok) {
      const { message } = errCodeAndMessage(body ?? null);
      return { ok: false, error: message ?? `HTTP ${response.status}` };
    }
    return { ok: true, config: { fileKey: body?.config?.fileKey, url: body?.config?.url } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** PUT /api/projects/:projectId/docs-review/figma-preview — validate link phía
 *  server; lỗi → `{ok:false,error}` để component hiện message ngay dưới ô nhập. */
export async function putFigmaPreviewConfig(
  projectId: string,
  payload: { url: string },
): Promise<{ ok: true; config: FigmaPreviewConfig } | { ok: false; error: string }> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/docs-review/figma-preview`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readJson<{ config?: FigmaPreviewConfig | null } & ErrorBody>(response);
    if (!response.ok) {
      const { message } = errCodeAndMessage(body ?? null);
      return { ok: false, error: message ?? 'Link Figma không hợp lệ.' };
    }
    return { ok: true, config: { fileKey: body?.config?.fileKey, url: body?.config?.url } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Cùng cadence poll với job sinh mô tả DS (useFigmaGuideJob). */
const BUILD_JOB_POLL_MS = 3_000;

/** Hook re-attach cho job "Dựng trong Figma" của MỘT project — khuôn
 *  useFigmaGuideJob (providers/figma-design-systems.ts:251-322). Mount → hỏi
 *  `/api/figma-build-jobs/active` lọc theo `projectId`; có job queued/running
 *  → adopt jobId đó rồi poll bản ĐẦY ĐỦ (kèm items) mỗi `BUILD_JOB_POLL_MS`;
 *  không có job active → không poll. 3 lần 404 liên tiếp (job bị prune TTL /
 *  daemon restart) → dừng poll, job đứng ở trạng thái cuối đã biết. Component
 *  gọi `adopt(job)` ngay sau khi tự POST start thành công (hoặc 409-adopt) để
 *  hiện tiến trình mà không cần đợi vòng poll active kế tiếp. */
export function useFigmaBuildJob(projectId: string): {
  job: FigmaBuildJob | null;
  adopt: (job: FigmaBuildJob) => void;
  refresh: () => Promise<void>;
} {
  const [job, setJob] = useState<FigmaBuildJob | null>(null);
  const jobRef = useRef<FigmaBuildJob | null>(null);
  jobRef.current = job;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const missedPollsRef = useRef(0);
  const pollFull = useCallback(async (jobId: string) => {
    const latest = await fetchFigmaBuildJob(projectId, jobId);
    if (!latest) {
      missedPollsRef.current += 1;
      if (missedPollsRef.current >= 3) stopPoll();
      return;
    }
    missedPollsRef.current = 0;
    setJob(latest);
    if (latest.status !== 'queued' && latest.status !== 'running') stopPoll();
  }, [projectId, stopPoll]);

  const startPoll = useCallback((jobId: string) => {
    stopPoll();
    // Reset bộ đếm 404 — nếu không, một lượt poll trước đó đã dừng vì 3×404
    // để lại counter = 3, và job MỚI adopt vào sẽ dừng ngay sau 1 lần 404 lẻ.
    missedPollsRef.current = 0;
    timerRef.current = setInterval(() => { void pollFull(jobId); }, BUILD_JOB_POLL_MS);
  }, [pollFull, stopPoll]);

  useEffect(() => {
    let alive = true;
    setJob(null);
    stopPoll();
    missedPollsRef.current = 0;
    void fetchActiveFigmaBuildJobs().then((jobs) => {
      if (!alive) return;
      const mine = jobs.find((item) => item.projectId === projectId && (item.status === 'queued' || item.status === 'running'));
      if (!mine) return;
      void pollFull(mine.jobId).then(() => {
        if (!alive) return;
        startPoll(mine.jobId);
      });
    });
    return () => {
      alive = false;
      stopPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pollFull`/`startPoll`/`stopPoll` are stable per-projectId via useCallback deps above.
  }, [projectId]);

  const adopt = useCallback((next: FigmaBuildJob) => {
    setJob(next);
    if (next.status === 'queued' || next.status === 'running') startPoll(next.id);
    else stopPoll();
  }, [startPoll, stopPoll]);

  const refresh = useCallback(async () => {
    const current = jobRef.current;
    if (!current) return;
    await pollFull(current.id);
  }, [pollFull]);

  return { job, adopt, refresh };
}
