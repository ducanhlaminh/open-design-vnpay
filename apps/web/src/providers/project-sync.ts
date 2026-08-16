// Typed browser client for the App/Feature ↔ origin sync API.  Keep transport
// details here so preview components stay entirely concerned with review UI.
import {
  ERR_PROJECT_SYNC_PLAN_EXPIRED,
  type ProjectSyncApplyRequest,
  type ProjectSyncApplyResult,
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
  constructor() {
    super('Kế hoạch đồng bộ đã hết hạn. Hãy tải lại phần xem trước.');
    this.name = 'ProjectSyncPlanExpiredError';
  }
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
  const response = await fetch(`/api/project-sync/origins${suffix}`, { cache: 'no-store' });
  const body = await json(response);
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể tải danh sách bản trong kho chung.'));
  return ((body as { data?: { origins?: ProjectSyncOrigin[] } }).data?.origins ?? []);
}

export async function getProjectSyncStatuses(scopes: ProjectSyncScope[]): Promise<ProjectSyncScopeStatus[]> {
  const response = await fetch('/api/project-sync/status', {
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
  const response = await fetch('/api/project-sync/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await json(response);
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể lập kế hoạch đồng bộ.'));
  const plan = (body as { data?: ProjectSyncPlan }).data;
  if (!plan) throw new Error('Máy chủ không trả về kế hoạch đồng bộ.');
  return plan;
}

export async function applyProjectSync(request: ProjectSyncApplyRequest): Promise<ProjectSyncApplyResult> {
  const response = await fetch('/api/project-sync/apply', {
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
  const response = await fetch('/api/project-sync/operations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await json(response);
  const code = (body as { error?: { code?: string } }).error?.code;
  if (response.status === 409 && code === ERR_PROJECT_SYNC_PLAN_EXPIRED) throw new ProjectSyncPlanExpiredError();
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể bắt đầu đồng bộ.'));
  const operation = (body as { data?: ProjectSyncOperation }).data;
  if (!operation) throw new Error('Máy chủ không trả về tiến trình đồng bộ.');
  return operation;
}

export async function getProjectSyncOperation(operationId: string): Promise<ProjectSyncOperation> {
  const response = await fetch(`/api/project-sync/operations/${encodeURIComponent(operationId)}`, {
    cache: 'no-store',
  });
  const body = await json(response);
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể đọc tiến độ đồng bộ.'));
  const operation = (body as { data?: ProjectSyncOperation }).data;
  if (!operation) throw new Error('Máy chủ không trả về tiến trình đồng bộ.');
  return operation;
}

const FEATURE_PULL_BASE = '/api/project-sync/feature-pulls';

export async function planProjectSyncFeaturePullBatch(
  request: ProjectSyncFeaturePullBatchPlanRequest,
): Promise<ProjectSyncFeaturePullBatchPlan> {
  const response = await fetch(`${FEATURE_PULL_BASE}/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await json(response);
  if (!response.ok) throw new Error(messageFrom(body, 'Không thể lập kế hoạch lấy tính năng.'));
  const plan = (body as { data?: ProjectSyncFeaturePullBatchPlan }).data;
  if (!plan) throw new Error('Máy chủ không trả về kế hoạch lấy tính năng.');
  return plan;
}

export async function createProjectSyncFeaturePullBatchOperation(
  request: ProjectSyncFeaturePullBatchOperationCreateRequest,
): Promise<ProjectSyncFeaturePullBatchOperation> {
  const response = await fetch(`${FEATURE_PULL_BASE}/operations`, {
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
  const response = await fetch(`${FEATURE_PULL_BASE}/operations/${encodeURIComponent(operationId)}`, {
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
  const response = await fetch(`${FEATURE_PULL_BASE}/operations/${encodeURIComponent(operationId)}/retry`, {
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
