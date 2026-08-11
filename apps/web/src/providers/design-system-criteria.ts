import type {
  CriteriaGenerationDocumentResponse,
  CriteriaGenerationKind,
  CriteriaGenerationStartResponse,
} from '@open-design/contracts';

export type CriteriaGenerationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function criteriaUrl(designSystemId: string, kind: CriteriaGenerationKind): string {
  return (
    `/api/design-systems/${encodeURIComponent(designSystemId)}`
    + `/criteria/${encodeURIComponent(kind)}`
  );
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string | { message?: string }; message?: string }
    | null;
  if (typeof payload?.error === 'string') return payload.error;
  if (payload?.error && typeof payload.error.message === 'string') return payload.error.message;
  if (typeof payload?.message === 'string') return payload.message;
  return fallback;
}

export async function fetchCriteriaGenerationDocument(
  designSystemId: string,
  kind: CriteriaGenerationKind,
  signal?: AbortSignal,
): Promise<CriteriaGenerationResult<CriteriaGenerationDocumentResponse>> {
  try {
    const response = await fetch(criteriaUrl(designSystemId, kind), {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await responseError(response, `Không tải được tài liệu (${response.status}).`),
      };
    }
    return { ok: true, value: await response.json() as CriteriaGenerationDocumentResponse };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: 'Yêu cầu đã được hủy.' };
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Không tải được tài liệu.',
    };
  }
}

export async function startCriteriaGeneration(
  designSystemId: string,
  kind: CriteriaGenerationKind,
): Promise<CriteriaGenerationResult<CriteriaGenerationStartResponse>> {
  try {
    const response = await fetch(`${criteriaUrl(designSystemId, kind)}/generate`, {
      method: 'POST',
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await responseError(response, `Không bắt đầu được quá trình sinh tài liệu (${response.status}).`),
      };
    }
    return { ok: true, value: await response.json() as CriteriaGenerationStartResponse };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Không bắt đầu được quá trình sinh tài liệu.',
    };
  }
}
