// ── Concept tham khảo cho ds-lab (WP-lab-refs) ───────────────────────────────
// Section "Concept tham khảo" (rail cấu hình → modal) đọc/ghi danh sách link
// page Figma dùng làm mẫu bố cục cho `lab-compose`. Daemon mở API contract này
// trong một WP SONG SONG (wp-lab-refs-daemon.yaml) — types ở đây khai LOCAL,
// KHÔNG import từ `@open-design/contracts`, vì contract đó chưa hợp nhất lúc
// hai WP còn chạy độc lập. Hợp nhất vào `packages/contracts` sau khi cả web
// lẫn daemon đã ổn định hình dạng response.
//
// Convention fetch giống các provider job/figma khác trong thư mục này
// (design-system-figma-update.ts, figma-build-jobs.ts…): trả `{ok, ...}`,
// KHÔNG throw — caller tự quyết định hiện lỗi ở đâu (rail fail-soft, section
// hiện detail).

export interface LabRefsPage {
  url: string;
  fileKey: string;
  nodeId: string;
  name?: string;
  ok: boolean;
  detail?: string;
}

export interface LabRefsConcept {
  id: string;
  fileKey: string;
  nodeId: string;
  name: string;
  /** Đường dẫn tương đối trong project (vd 'ds-lab/refs/x.png'); rỗng = ảnh lỗi.
   *  Hiện bằng `projectFileUrl(projectId, png)` — cùng cách FileViewer render ảnh. */
  png: string;
  width?: number;
  height?: number;
}

export interface LabRefsFile {
  schemaVersion: 1;
  scannedAt?: string;
  pages: LabRefsPage[];
  concepts: LabRefsConcept[];
}

export interface LabRefsError {
  message: string;
  code?: string;
  detail?: string;
}

export type LabRefsResult<T> = { ok: true; value: T } | { ok: false; error: LabRefsError };

export interface PutLabRefsResponse {
  refs: LabRefsFile;
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseLabRefsPage(value: unknown): LabRefsPage | null {
  if (!isObject(value)) return null;
  const { url, fileKey, nodeId } = value;
  if (typeof url !== 'string' || typeof fileKey !== 'string' || typeof nodeId !== 'string') return null;
  return {
    url,
    fileKey,
    nodeId,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ok: value.ok === true,
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
  };
}

function parseLabRefsConcept(value: unknown): LabRefsConcept | null {
  if (!isObject(value)) return null;
  const { id, fileKey, nodeId, name, png } = value;
  if (
    typeof id !== 'string'
    || typeof fileKey !== 'string'
    || typeof nodeId !== 'string'
    || typeof name !== 'string'
    || typeof png !== 'string'
  ) {
    return null;
  }
  return {
    id,
    fileKey,
    nodeId,
    name,
    png,
    ...(typeof value.width === 'number' ? { width: value.width } : {}),
    ...(typeof value.height === 'number' ? { height: value.height } : {}),
  };
}

/** Chưa cấu hình → daemon trả `pages`/`concepts` rỗng; giữ nguyên bất biến đó
 *  khi payload thiếu/hỏng field thay vì ném lỗi — rail/section fail-soft. */
function parseLabRefsFile(value: unknown): LabRefsFile {
  const source = isObject(value) ? value : {};
  const pages = Array.isArray(source.pages)
    ? source.pages.flatMap((p) => {
        const parsed = parseLabRefsPage(p);
        return parsed ? [parsed] : [];
      })
    : [];
  const concepts = Array.isArray(source.concepts)
    ? source.concepts.flatMap((c) => {
        const parsed = parseLabRefsConcept(c);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    schemaVersion: 1,
    ...(typeof source.scannedAt === 'string' ? { scannedAt: source.scannedAt } : {}),
    pages,
    concepts,
  };
}

/** 400 của PUT có hình dạng khác các endpoint khác trong repo: `error` là một
 *  STRING mã lỗi (vd 'FIGMA_TOKEN_REQUIRED'), không phải object {code,message}
 *  — đúng như contract WP-lab-refs-daemon ghi. `detail` đi kèm là câu người
 *  đọc được. */
async function readLabRefsError(response: Response, fallback: string): Promise<LabRefsError> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isObject(payload)) return { message: fallback };
  const code = typeof payload.error === 'string' ? payload.error : undefined;
  const detail = typeof payload.detail === 'string' ? payload.detail : undefined;
  return {
    message: detail ?? code ?? fallback,
    ...(code ? { code } : {}),
    ...(detail ? { detail } : {}),
  };
}

export async function getLabRefs(projectId: string): Promise<LabRefsResult<LabRefsFile>> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/ds-lab/lab-refs`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      return { ok: false, error: await readLabRefsError(response, `Không đọc được concept tham khảo (${response.status}).`) };
    }
    return { ok: true, value: parseLabRefsFile(await response.json()) };
  } catch (error) {
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : 'Không đọc được concept tham khảo.' },
    };
  }
}

export async function putLabRefs(
  projectId: string,
  links: string[],
): Promise<LabRefsResult<PutLabRefsResponse>> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/ds-lab/lab-refs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links }),
    });
    if (!response.ok) {
      return { ok: false, error: await readLabRefsError(response, `Không quét được concept (${response.status}).`) };
    }
    const payload = (await response.json()) as unknown;
    const source = isObject(payload) ? payload : {};
    const warnings = Array.isArray(source.warnings)
      ? source.warnings.filter((w): w is string => typeof w === 'string')
      : [];
    return { ok: true, value: { refs: parseLabRefsFile(source.refs), warnings } };
  } catch (error) {
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : 'Không quét được concept.' },
    };
  }
}
