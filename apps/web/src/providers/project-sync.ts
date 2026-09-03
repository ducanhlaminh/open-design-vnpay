// Typed browser client for the App/Feature ↔ origin sync API.  Keep transport
// details here so preview components stay entirely concerned with review UI.
import {
  ERR_PROJECT_SYNC_PLAN_EXPIRED,
  type ProjectSyncApplyRequest,
  type ProjectSyncApplyResult,
  type ProjectSyncConfluencePreflight,
  type ProjectSyncConfluencePreflightRequest,
  type ProjectSyncFeaturePullBatchOperation,
  type ProjectSyncFeaturePullBatchOperationCreateRequest,
  type ProjectSyncFeaturePullBatchPlan,
  type ProjectSyncFeaturePullBatchPlanRequest,
  type ProjectSyncFeaturePullBatchRetryRequest,
  type ProjectSyncOperation,
  type ProjectSyncOperationCreateRequest,
  type ProjectSyncOrigin,
  type ProjectSyncOriginsQuery,
  type ProjectSyncPlan,
  type ProjectSyncPlanRequest,
  type ProjectSyncScope,
  type ProjectSyncScopeStatus,
} from '@open-design/contracts';

export class ProjectSyncPlanExpiredError extends Error {
  constructor(message = 'Kế hoạch đồng bộ đã hết hạn. Hãy tải lại phần xem trước.') {
    super(message);
    this.name = 'ProjectSyncPlanExpiredError';
  }
}

/** Push while a feature still has a queued/running stage: the daemon refuses
 *  the plan (409) because the local baseline is being rewritten under it.
 *  Contract constant lives daemon-side for now; mirrored here verbatim. */
export const ERR_PROJECT_SYNC_STAGE_RUNNING = 'PROJECT_SYNC_STAGE_RUNNING';

/** Push-specific wording for PLAN_EXPIRED: the local tree (not the shared
 *  copy) moved between plan and apply — almost always a stage still writing
 *  output files. The generic "reload the preview" line is misleading here. */
export const PROJECT_SYNC_PUSH_PLAN_EXPIRED_MESSAGE =
  'Kết quả trên máy vừa thay đổi trong lúc chia sẻ (bước đang chạy?). Mở lại và thử lại.';

export class ProjectSyncStageRunningError extends Error {
  readonly code = ERR_PROJECT_SYNC_STAGE_RUNNING;
  constructor(message = 'Bước đang chạy — đợi xong rồi chia sẻ.') {
    super(message);
    this.name = 'ProjectSyncStageRunningError';
  }
}

function errorCodeOf(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | null)?.error?.code;
}

export const PROJECT_SYNC_REQUEST_TIMEOUT_MS = 30_000;
/** PLAN reads the whole origin listing (a big Feature batch can take a while
 *  even without content downloads) — give it more room than the 30s default. */
export const PROJECT_SYNC_PLAN_TIMEOUT_MS = 120_000;
export const PROJECT_SYNC_OPERATION_TIMEOUT_MS = 5 * 60_000;
export const PROJECT_SYNC_POLL_INTERVAL_MS = 700;

export class ProjectSyncTimeoutError extends Error {
  constructor(message = 'Thao tác đồng bộ mất quá nhiều thời gian. Vui lòng kiểm tra kết nối và thử lại.') {
    super(message);
    this.name = 'ProjectSyncTimeoutError';
  }
}

async function syncFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = PROJECT_SYNC_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (cause) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      throw new ProjectSyncTimeoutError('Kho chung phản hồi quá lâu. Vui lòng thử lại.');
    }
    throw cause;
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = window.setTimeout(finish, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function waitForProjectSyncOperation<T extends ProjectSyncOperation<unknown>>(
  initial: T,
  getOperation: (operationId: string) => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    pollIntervalMs?: number;
    onUpdate?: (operation: T) => void;
    onTransientError?: (error: Error | null) => void;
  } = {},
): Promise<T> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? PROJECT_SYNC_OPERATION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? PROJECT_SYNC_POLL_INTERVAL_MS;
  let current = initial;
  options.onUpdate?.(current);
  while (current.state === 'queued' || current.state === 'running') {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new ProjectSyncTimeoutError();
    await wait(Math.min(pollIntervalMs, remaining), options.signal);
    try {
      current = await getOperation(current.operationId);
      options.onTransientError?.(null);
      options.onUpdate?.(current);
    } catch (cause) {
      if (options.signal?.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) throw cause;
      const error = cause instanceof Error ? cause : new Error('Không thể đọc tiến độ đồng bộ.');
      options.onTransientError?.(error);
      if (Date.now() - startedAt >= timeoutMs) throw new ProjectSyncTimeoutError();
    }
  }
  return current;
}

function messageFrom(body: unknown, fallback: string): string {
  const record = body as { error?: { message?: string } | string; message?: string } | null;
  if (typeof record?.error === 'string') return record.error;
  if (typeof record?.error?.message === 'string') return record.error.message;
  return typeof record?.message === 'string' ? record.message : fallback;
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

export async function listProjectSyncOrigins(
  scope?: Pick<ProjectSyncOriginsQuery, 'kind'> & { appId?: string | null; projectId?: string },
): Promise<ProjectSyncOrigin[]> {
  const query = new URLSearchParams();
  if (scope) {
    if (scope.kind) query.set('kind', scope.kind);
    const appId = scope.appId;
    if (appId) query.set('appId', appId);
  }
  const suffix = query.size ? `?${query.toString()}` : '';
  const response = await syncFetch(`/api/project-sync/origins${suffix}`, { cache: 'no-store' });
  const body = await json(response);
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể tải danh sách bản trong kho chung.'));
  return ((body as { data?: { origins?: ProjectSyncOrigin[] } }).data?.origins ?? []);
}

export async function getProjectSyncStatuses(scopes: ProjectSyncScope[]): Promise<ProjectSyncScopeStatus[]> {
  const response = await syncFetch('/api/project-sync/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scopes }),
  });
  const body = await json(response);
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể kiểm tra trạng thái đồng bộ.'));
  const statuses = (body as { data?: { results?: ProjectSyncScopeStatus[] } }).data?.results ?? [];
  return statuses;
}

export async function getProjectSyncStatus(scope: ProjectSyncScope): Promise<ProjectSyncScopeStatus> {
  const status = (await getProjectSyncStatuses([scope]))[0];
  if (!status) throw new Error('Không tìm thấy trạng thái đồng bộ cho phạm vi này.');
  return status;
}

export async function planProjectSync(request: ProjectSyncPlanRequest): Promise<ProjectSyncPlan> {
  const response = await syncFetch('/api/project-sync/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }, PROJECT_SYNC_PLAN_TIMEOUT_MS);
  const body = await json(response);
  if (response.status === 409 && errorCodeOf(body) === ERR_PROJECT_SYNC_STAGE_RUNNING) {
    throw new ProjectSyncStageRunningError(messageFrom(body, 'Bước đang chạy — đợi xong rồi chia sẻ.'));
  }
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể lập kế hoạch đồng bộ.'));
  const plan = (body as { data?: ProjectSyncPlan }).data;
  if (!plan) throw new Error('Máy chủ không trả về kế hoạch đồng bộ.');
  return plan;
}

export async function applyProjectSync(request: ProjectSyncApplyRequest): Promise<ProjectSyncApplyResult> {
  const response = await syncFetch('/api/project-sync/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await json(response);
  const code = (body as { error?: { code?: string } }).error?.code;
  if (response.status === 409 && code === ERR_PROJECT_SYNC_PLAN_EXPIRED) throw new ProjectSyncPlanExpiredError();
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể áp dụng đồng bộ.'));
  const result = (body as { data?: ProjectSyncApplyResult }).data;
  if (!result) throw new Error('Máy chủ không trả về kết quả đồng bộ.');
  return result;
}

export async function createProjectSyncOperation(request: ProjectSyncOperationCreateRequest): Promise<ProjectSyncOperation> {
  const response = await syncFetch('/api/project-sync/operations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await json(response);
  const code = (body as { error?: { code?: string } }).error?.code;
  if (response.status === 409 && code === ERR_PROJECT_SYNC_PLAN_EXPIRED) throw new ProjectSyncPlanExpiredError();
  if (response.status === 409 && code === ERR_PROJECT_SYNC_STAGE_RUNNING) {
    throw new ProjectSyncStageRunningError(messageFrom(body, 'Bước đang chạy — đợi xong rồi chia sẻ.'));
  }
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể bắt đầu đồng bộ.'));
  const operation = (body as { data?: ProjectSyncOperation }).data;
  if (!operation) throw new Error('Máy chủ không trả về tiến trình đồng bộ.');
  return operation;
}

export async function getProjectSyncOperation(operationId: string): Promise<ProjectSyncOperation> {
  const response = await syncFetch(`/api/project-sync/operations/${encodeURIComponent(operationId)}`, {
    cache: 'no-store',
  });
  const body = await json(response);
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể đọc tiến độ đồng bộ.'));
  const operation = (body as { data?: ProjectSyncOperation }).data;
  if (!operation) throw new Error('Máy chủ không trả về tiến trình đồng bộ.');
  return operation;
}

/** Asks the daemon whether THIS machine can re-download the Confluence-backed
 *  files of a pull plan (PAT present/valid, same wiki base, space access).
 *  Exactly one of `planId` / `batchPlanId` must be given. An expired plan
 *  surfaces as `ProjectSyncPlanExpiredError` like the apply endpoints do. */
export async function preflightProjectSyncConfluence(
  request: ProjectSyncConfluencePreflightRequest,
): Promise<ProjectSyncConfluencePreflight> {
  const response = await syncFetch('/api/project-sync/confluence-preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await json(response);
  if ((response.status === 404 || response.status === 409) && errorCodeOf(body) === ERR_PROJECT_SYNC_PLAN_EXPIRED) {
    throw new ProjectSyncPlanExpiredError();
  }
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể kiểm tra quyền truy cập Confluence.'));
  const preflight = (body as { data?: ProjectSyncConfluencePreflight }).data;
  if (!preflight) throw new Error('Máy chủ không trả về kết quả kiểm tra Confluence.');
  return preflight;
}

const FEATURE_PULL_BASE = '/api/project-sync/feature-pulls';

export async function planProjectSyncFeaturePullBatch(
  request: ProjectSyncFeaturePullBatchPlanRequest,
): Promise<ProjectSyncFeaturePullBatchPlan> {
  const response = await syncFetch(`${FEATURE_PULL_BASE}/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }, PROJECT_SYNC_PLAN_TIMEOUT_MS);
  const body = await json(response);
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể lập kế hoạch lấy tính năng.'));
  const plan = (body as { data?: ProjectSyncFeaturePullBatchPlan }).data;
  if (!plan) throw new Error('Máy chủ không trả về kế hoạch lấy tính năng.');
  return plan;
}

export async function createProjectSyncFeaturePullBatchOperation(
  request: ProjectSyncFeaturePullBatchOperationCreateRequest,
): Promise<ProjectSyncFeaturePullBatchOperation> {
  const response = await syncFetch(`${FEATURE_PULL_BASE}/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await json(response);
  const code = (body as { error?: { code?: string } }).error?.code;
  if (response.status === 409 && code === ERR_PROJECT_SYNC_PLAN_EXPIRED) throw new ProjectSyncPlanExpiredError();
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể bắt đầu lấy tính năng.'));
  const operation = (body as { data?: ProjectSyncFeaturePullBatchOperation }).data;
  if (!operation) throw new Error('Máy chủ không trả về tiến trình lấy tính năng.');
  return operation;
}

export async function getProjectSyncFeaturePullBatchOperation(
  operationId: string,
): Promise<ProjectSyncFeaturePullBatchOperation> {
  const response = await syncFetch(`${FEATURE_PULL_BASE}/operations/${encodeURIComponent(operationId)}`, {
    cache: 'no-store',
  });
  const body = await json(response);
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể đọc tiến độ lấy tính năng.'));
  const operation = (body as { data?: ProjectSyncFeaturePullBatchOperation }).data;
  if (!operation) throw new Error('Máy chủ không trả về tiến trình lấy tính năng.');
  return operation;
}

export async function retryProjectSyncFeaturePullBatchOperation(
  operationId: string,
): Promise<ProjectSyncFeaturePullBatchOperation> {
  const request: ProjectSyncFeaturePullBatchRetryRequest = { operationId };
  const response = await syncFetch(`${FEATURE_PULL_BASE}/operations/${encodeURIComponent(operationId)}/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await json(response);
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể thử lại các tính năng bị lỗi.'));
  const operation = (body as { data?: ProjectSyncFeaturePullBatchOperation }).data;
  if (!operation) throw new Error('Máy chủ không trả về tiến trình thử lại.');
  return operation;
}
