import type {
  DesignSystemSyncStatus,
  ListRemoteDesignSystemsResponse,
  PublishDesignSystemRequest,
  PublishDesignSystemResult,
  PullDesignSystemPlan,
  PullDesignSystemPlanRequest,
  PullDesignSystemRequest,
  PullDesignSystemResult,
} from '@open-design/contracts';

export interface DesignSystemSyncError {
  message: string;
  status?: number;
}

export type DesignSystemSyncResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: DesignSystemSyncError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrap<T>(payload: unknown): T {
  if (isRecord(payload) && 'data' in payload) return payload.data as T;
  return payload as T;
}

async function readError(response: Response, fallback: string): Promise<DesignSystemSyncError> {
  const payload = await response.json().catch(() => null) as unknown;
  const source = isRecord(payload) && isRecord(payload.error) ? payload.error : payload;
  const message = isRecord(source) && typeof source.message === 'string'
    ? source.message
    : isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : fallback;
  return { message, status: response.status };
}

async function request<T>(input: RequestInfo | URL, init: RequestInit | undefined, fallback: string): Promise<DesignSystemSyncResponse<T>> {
  try {
    const response = await fetch(input, init);
    if (!response.ok) return { ok: false, error: await readError(response, fallback) };
    return { ok: true, value: unwrap<T>(await response.json()) };
  } catch (error) {
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : fallback },
    };
  }
}

/** Push/Pull use non-2xx responses for typed business outcomes such as
 * `blocked`, `conflict`, and `auth_required`. Keep those outcomes intact so
 * the UI can offer the correct recovery instead of showing a transport error. */
async function resultRequest<T>(input: RequestInfo | URL, init: RequestInit, fallback: string): Promise<DesignSystemSyncResponse<T>> {
  try {
    const response = await fetch(input, init);
    const payload = await response.json().catch(() => null) as unknown;
    const value = unwrap<T>(payload);
    if (isRecord(value) && typeof value.status === 'string') return { ok: true, value };
    if (!response.ok) {
      const source = isRecord(payload) && isRecord(payload.error) ? payload.error : payload;
      return {
        ok: false,
        error: {
          message: isRecord(source) && typeof source.message === 'string'
            ? source.message
            : isRecord(payload) && typeof payload.error === 'string'
              ? payload.error
              : fallback,
          status: response.status,
        },
      };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: { message: error instanceof Error ? error.message : fallback } };
  }
}

export function listRemoteDesignSystems(query = ''): Promise<DesignSystemSyncResponse<ListRemoteDesignSystemsResponse>> {
  const search = new URLSearchParams();
  if (query.trim()) search.set('q', query.trim());
  const suffix = search.size > 0 ? `?${search.toString()}` : '';
  return request(`/api/design-systems/sync/remote${suffix}`, { cache: 'no-store' }, 'Không đọc được kho Design System chung.');
}

export function fetchDesignSystemSyncStatus(localDesignSystemId: string): Promise<DesignSystemSyncResponse<DesignSystemSyncStatus>> {
  return request(
    `/api/design-systems/${encodeURIComponent(localDesignSystemId)}/sync/status`,
    { cache: 'no-store' },
    'Không đọc được thay đổi của bộ Design System.',
  );
}

export function publishDesignSystem(
  localDesignSystemId: string,
  body: PublishDesignSystemRequest,
): Promise<DesignSystemSyncResponse<PublishDesignSystemResult>> {
  return resultRequest(
    `/api/design-systems/${encodeURIComponent(localDesignSystemId)}/sync/push`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    'Không thể chia sẻ bộ Design System.',
  );
}

export function planPullDesignSystem(
  body: PullDesignSystemPlanRequest,
): Promise<DesignSystemSyncResponse<PullDesignSystemPlan>> {
  return request(
    '/api/design-systems/sync/pull/plan',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    'Không thể so sánh bộ Design System với bản trên máy.',
  );
}

export function pullDesignSystem(
  body: PullDesignSystemRequest,
): Promise<DesignSystemSyncResponse<PullDesignSystemResult>> {
  return resultRequest(
    '/api/design-systems/sync/pull',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    'Không thể lấy bộ Design System về máy.',
  );
}
