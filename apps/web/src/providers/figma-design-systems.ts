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
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  reason?: string;
}

/** Contract mục 2 — mở rộng optional-only của FigmaDesignSystemGuideJob. Job
 *  cũ (daemon chưa update) không có `items` — mọi nơi đọc field này phải coi
 *  `undefined` là "fallback về 3 con số", KHÔNG coi là lỗi. */
export interface FigmaDesignSystemGuideJobV2 extends FigmaDesignSystemGuideJob {
  items?: FigmaDesignSystemGuideJobItem[];
  /** CHỈ còn dùng cho vòng sinh bù trong prep dr-comp (cap 60/lượt); job từ
   *  nút "Sinh mô tả" ở trang detail KHÔNG còn cap — sinh TOÀN BỘ comp thiếu
   *  một lần, field này absent/0 ở job đó. */
  remainingAfterCap?: number;
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
