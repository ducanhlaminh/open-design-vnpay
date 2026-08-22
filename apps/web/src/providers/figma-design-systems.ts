import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CreateFigmaDesignSystemSourceRequest,
  FigmaDesignSystemGuideJob,
  FigmaDesignSystemSource,
  GenerateFigmaDesignSystemGuideResponse,
  GetFigmaDesignSystemSourceResponse,
  ListFigmaDesignSystemSourcesResponse,
  RefreshFigmaDesignSystemSourceResponse,
} from '@open-design/contracts';

export type { FigmaDesignSystemGuideJob, FigmaDesignSystemSource } from '@open-design/contracts';

type SourcePayload = CreateFigmaDesignSystemSourceRequest;

// WP21b — type cục bộ theo .tmp/pipeline/wp21-contract.md (WP21a đang dựng
// API cùng nguyên văn contract này ở nhánh song song). `@open-design/contracts`
// KHÔNG có các type/field dưới đây trong lúc hai WP chạy song song, nên khai
// báo cục bộ ở đây thay vì import — nếu import sẽ vỡ typecheck cho tới khi
// WP21a merge. Marker để dễ tìm: WP21c hợp nhất sang @open-design/contracts.

/** Contract mục 1 — GET /api/figma-design-systems/:id/components */
export interface FigmaDesignSystemComponentItem {
  anchor: string;
  name: string;
  nodeId: string;
  fileKey: string;
  fileName: string;
  page?: string;
  /** Đã merge guide; verbatim, KHÔNG kèm hậu tố "(AI sinh)". */
  description?: string;
  descriptionSource: 'figma' | 'ai' | 'none';
  properties: { name: string; type: string; values: string[] }[];
  // WP23c hợp nhất sang @open-design/contracts. .tmp/pipeline/wp23-contract.md
  // mục 2 — luôn được daemon set; optional để client cũ (chưa nạp lại) không
  // vỡ khi field vắng mặt.
  /** true khi isJunkComponentName(name) — tên không đủ nghĩa, cần đặt lại
   *  tên trong Figma trước khi sinh mô tả có ý nghĩa. */
  needsRename?: boolean;
  /** classifyComponentKind(page, name) — 'asset' bỏ qua fetch cây node/ảnh
   *  khi sinh mô tả (input chỉ tên/trang). */
  kind?: 'asset' | 'normal';
}

interface ListFigmaDesignSystemComponentsResponse {
  components: FigmaDesignSystemComponentItem[];
}

/** Contract mục 2 — từng item của lượt sinh mô tả đang chạy/vừa chạy. `page`
 *  là trang Figma của comp — daemon fan-out theo NHÓM TRANG (mỗi page 1
 *  nhóm, chunk 12 tuần tự trong nhóm, các nhóm chạy song song); UI nhóm
 *  panel tiến độ theo field này. */
export interface FigmaDesignSystemGuideJobItem {
  anchor: string;
  name: string;
  page?: string;
  // WP23c hợp nhất sang @open-design/contracts. .tmp/pipeline/wp23-contract.md
  // mục 3 — comp needsRename đánh 'skipped' NGAY khi job start, không gửi
  // agent, không tính vào failed.
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
  reason?: string;
}

/** Contract mục 2 — mở rộng optional-only của FigmaDesignSystemGuideJob. Job
 *  cũ (daemon chưa update) không có `items` — mọi nơi đọc field này phải coi
 *  `undefined` là "fallback về 3 con số", KHÔNG coi là lỗi.
 *  `Omit<..., 'items'>` vì @open-design/contracts đã có field `items` riêng
 *  (union `status` hẹp hơn, chưa có 'skipped') từ vòng WP21 trước — override
 *  bằng `FigmaDesignSystemGuideJobItem` cục bộ ở trên thay vì kế thừa thẳng
 *  để tránh lỗi "incorrectly extends" (TS2430). */
export interface FigmaDesignSystemGuideJobV2 extends Omit<FigmaDesignSystemGuideJob, 'items' | 'skipped'> {
  items?: FigmaDesignSystemGuideJobItem[];
  /** CHỈ còn dùng cho vòng sinh bù trong prep dr-comp (cap 60/lượt); job từ
   *  nút "Sinh mô tả" ở trang detail KHÔNG còn cap — sinh TOÀN BỘ comp thiếu
   *  một lần, field này absent/0 ở job đó. */
  remainingAfterCap?: number;
  // WP23c hợp nhất sang @open-design/contracts. .tmp/pipeline/wp23-contract.md
  // mục 3 — đếm item 'skipped' (tên rác); optional cùng lý do với `items`
  // (job cũ trước WP23a không có field này).
  skipped?: number;
}

/** Contract mục 3 — optional field mới của GET /api/figma-design-systems/:id. */
export interface FigmaDesignSystemLastGuideRun {
  finishedAt: string;
  generated: number;
  failed: number;
  failures: { anchor: string; name: string; reason: string }[];
}

export interface GetFigmaDesignSystemSourceResponseV2 extends GetFigmaDesignSystemSourceResponse {
  lastGuideRun?: FigmaDesignSystemLastGuideRun;
  // WP23c hợp nhất sang @open-design/contracts. .tmp/pipeline/wp23-contract.md
  // mục 4 — total = số comp trong snapshot, cached = số file .png hiện có,
  // running = task prefetch ảnh của nguồn này đang chạy.
  imageCache?: { total: number; cached: number; running: boolean };
}

/** Contract mục 5 — bản NHẸ của job sinh mô tả cho GET /api/figma-guide-jobs/active.
 *  WP23c hợp nhất sang @open-design/contracts. */
export interface FigmaGuideActiveJob {
  jobId: string;
  sourceId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  /** Items succeeded+failed+skipped. */
  done: number;
  total: number;
  startedAt: number;
  finishedAt?: number;
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string | { message?: string } } | null;
  if (typeof body?.error === 'string') return body.error;
  if (body?.error && typeof body.error.message === 'string') return body.error.message;
  return fallback;
}

export async function fetchFigmaDesignSystems(): Promise<FigmaDesignSystemSource[]> {
  const response = await fetch('/api/figma-design-systems');
  if (!response.ok) throw new Error(await errorMessage(response, 'Không tải được Design system Figma.'));
  const body = await response.json() as ListFigmaDesignSystemSourcesResponse;
  return body.sources ?? [];
}

export async function fetchFigmaDesignSystemDetail(id: string): Promise<GetFigmaDesignSystemSourceResponseV2> {
  const response = await fetch(`/api/figma-design-systems/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(await errorMessage(response, 'Không tải được Design system Figma.'));
  return await response.json() as GetFigmaDesignSystemSourceResponseV2;
}

/** Contract mục 1 — danh sách component phẳng của một nguồn Figma, thứ tự
 *  theo snapshot (file → component), KHÔNG re-sort. 409 CATALOG_REQUIRED khi
 *  nguồn chưa có catalog — thông điệp riêng cho case đó vì daemon không kèm
 *  `message` (chỉ `code`), errorMessage() sẽ rơi về fallback truyền vào. */
export async function fetchFigmaDesignSystemComponents(sourceId: string): Promise<FigmaDesignSystemComponentItem[]> {
  const response = await fetch(`/api/figma-design-systems/${encodeURIComponent(sourceId)}/components`);
  if (!response.ok) {
    const fallback = response.status === 409
      ? 'Nguồn chưa có danh mục component.'
      : 'Không tải được danh mục component.';
    throw new Error(await errorMessage(response, fallback));
  }
  const body = await response.json() as ListFigmaDesignSystemComponentsResponse;
  return body.components ?? [];
}

export async function fetchFigmaDesignSystem(id: string): Promise<FigmaDesignSystemSource> {
  return (await fetchFigmaDesignSystemDetail(id)).source;
}

/** WP-ds-tokens (0.8.96): tokens.md de-facto của nguồn — sinh NỀN sau mỗi lần
 *  Làm mới thành công. 404 TOKENS_NOT_GENERATED = chưa từng sinh (nguồn chưa
 *  refresh từ 0.8.96, hoặc mining còn đang chạy) → trả null để tab Tokens hiện
 *  empty-state hướng dẫn, KHÔNG phải lỗi. */
export async function fetchFigmaDesignSystemTokens(
  sourceId: string,
  signal?: AbortSignal,
): Promise<{ markdown: string; generatedAt: string } | null> {
  const response = await fetch(`/api/figma-design-systems/${encodeURIComponent(sourceId)}/tokens`, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await errorMessage(response, 'Không tải được tokens của nguồn này.'));
  return await response.json() as { markdown: string; generatedAt: string };
}

export async function createFigmaDesignSystem(payload: SourcePayload): Promise<FigmaDesignSystemSource> {
  const response = await fetch('/api/figma-design-systems', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await errorMessage(response, 'Không tạo được Design system Figma.'));
  const body = await response.json() as { source?: FigmaDesignSystemSource } | FigmaDesignSystemSource;
  return 'source' in body && body.source ? body.source : body as FigmaDesignSystemSource;
}

export async function updateFigmaDesignSystem(id: string, payload: SourcePayload): Promise<FigmaDesignSystemSource> {
  const response = await fetch(`/api/figma-design-systems/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await errorMessage(response, 'Không cập nhật được Design system Figma.'));
  const body = await response.json() as { source?: FigmaDesignSystemSource } | FigmaDesignSystemSource;
  return 'source' in body && body.source ? body.source : body as FigmaDesignSystemSource;
}

export async function refreshFigmaDesignSystem(id: string): Promise<RefreshFigmaDesignSystemSourceResponse> {
  const response = await fetch(`/api/figma-design-systems/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
  if (!response.ok) throw new Error(await errorMessage(response, 'Không thể làm mới danh mục component.'));
  return await response.json() as RefreshFigmaDesignSystemSourceResponse;
}

export async function deleteFigmaDesignSystem(id: string): Promise<void> {
  const response = await fetch(`/api/figma-design-systems/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await errorMessage(response, 'Không thể xóa Design system Figma.'));
}

// WP20: nút "Sinh mô tả (N thiếu)" của panel DS App khi App gắn qua nguồn
// dùng chung — cùng khuôn job App-level (state/figma-config.ts:
// generateAppFigmaGuide/fetchAppFigmaGuideJob), khác chỗ trả `{ok, error}`
// thay vì throw (mọi hàm khác của module này throw) để panel tự quyết cách
// hiện lỗi giống hệt panel App-level, không cần try/catch ở call site.
async function readJson<T>(response: Response): Promise<T | null> {
  try { return (await response.json()) as T; } catch { return null; }
}

export async function generateFigmaDesignSystemGuide(
  sourceId: string,
  signal?: AbortSignal,
): Promise<{ ok: true; jobId: string; job: FigmaDesignSystemGuideJobV2 } | { ok: false; error: string }> {
  try {
    const response = await fetch(`/api/figma-design-systems/${encodeURIComponent(sourceId)}/generate-guide`, { method: 'POST', signal });
    const body = await readJson<
      Omit<GenerateFigmaDesignSystemGuideResponse, 'job'> & { job?: FigmaDesignSystemGuideJobV2; error?: string | { message?: string } }
    >(response);
    if (!response.ok || !body?.job) {
      const err = body?.error;
      const message = typeof err === 'string' ? err : err?.message;
      return { ok: false, error: message ?? `HTTP ${response.status}` };
    }
    return { ok: true, jobId: body.jobId, job: body.job };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchFigmaDesignSystemGuideJob(sourceId: string, jobId: string, signal?: AbortSignal): Promise<FigmaDesignSystemGuideJobV2 | null> {
  try {
    const response = await fetch(`/api/figma-design-systems/${encodeURIComponent(sourceId)}/generate-guide/${encodeURIComponent(jobId)}`, { signal });
    if (!response.ok) return null;
    const body = await readJson<{ job?: FigmaDesignSystemGuideJobV2 }>(response);
    return body?.job ?? null;
  } catch {
    return null;
  }
}

/** Contract mục 5 — GET /api/figma-guide-jobs/active. Network lỗi → mảng
 *  rỗng (khuôn fetchActiveImportJobs trong providers/app-import-jobs.ts:
 *  hook coi như "hiện không có job", không phải một trạng thái cần hiện lỗi
 *  riêng). */
export async function fetchActiveGuideJobs(signal?: AbortSignal): Promise<FigmaGuideActiveJob[]> {
  try {
    const response = await fetch('/api/figma-guide-jobs/active', { signal });
    if (!response.ok) return [];
    const body = await readJson<{ jobs?: FigmaGuideActiveJob[] }>(response);
    return body?.jobs ?? [];
  } catch {
    return [];
  }
}

/** Cùng cadence poll với trang detail (GUIDE_JOB_POLL_MS cục bộ ở
 *  FigmaDsSourceDetail.tsx). */
const GUIDE_JOB_POLL_MS = 3_000;

/** Hook re-attach cho job sinh mô tả của MỘT nguồn Figma — khuôn
 *  useAppImportJob (providers/app-import-jobs.ts). Mount → hỏi
 *  `/api/figma-guide-jobs/active` lọc theo `sourceId`; có job queued/running
 *  → adopt jobId đó rồi poll bản ĐẦY ĐỦ (kèm items) mỗi
 *  `GUIDE_JOB_POLL_MS`; không có job active → không poll. Component gọi
 *  `adopt(job)` ngay sau khi tự POST generate-guide thành công để hiện panel
 *  tiến độ mà không cần đợi vòng poll active kế tiếp. */
export function useFigmaGuideJob(sourceId: string): {
  job: FigmaDesignSystemGuideJobV2 | null;
  adopt: (job: FigmaDesignSystemGuideJobV2) => void;
  refresh: () => Promise<void>;
} {
  const [job, setJob] = useState<FigmaDesignSystemGuideJobV2 | null>(null);
  const jobRef = useRef<FigmaDesignSystemGuideJobV2 | null>(null);
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
    const latest = await fetchFigmaDesignSystemGuideJob(sourceId, jobId);
    if (!latest) {
      // Job biến mất vĩnh viễn (daemon restart / bị prune TTL) → 404 mãi.
      // Không dừng ngay (một lần 404 có thể là mạng chớp), nhưng 3 lần liên
      // tiếp thì thôi poll — job hiển thị đứng ở trạng thái cuối đã biết.
      missedPollsRef.current += 1;
      if (missedPollsRef.current >= 3) stopPoll();
      return;
    }
    missedPollsRef.current = 0;
    setJob(latest);
    if (latest.status !== 'queued' && latest.status !== 'running') stopPoll();
  }, [sourceId, stopPoll]);

  const startPoll = useCallback((jobId: string) => {
    stopPoll();
    timerRef.current = setInterval(() => { void pollFull(jobId); }, GUIDE_JOB_POLL_MS);
  }, [pollFull, stopPoll]);

  useEffect(() => {
    let alive = true;
    setJob(null);
    stopPoll();
    void fetchActiveGuideJobs().then((jobs) => {
      if (!alive) return;
      const mine = jobs.find((item) => item.sourceId === sourceId && (item.status === 'queued' || item.status === 'running'));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pollFull`/`startPoll`/`stopPoll` are stable per-sourceId via useCallback deps above.
  }, [sourceId]);

  const adopt = useCallback((next: FigmaDesignSystemGuideJobV2) => {
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
