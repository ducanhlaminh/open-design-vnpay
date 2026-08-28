// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROJECT_SYNC_PUSH_PLAN_EXPIRED_MESSAGE,
  ProjectSyncPlanExpiredError,
  ProjectSyncStageRunningError,
  ProjectSyncTimeoutError,
  applyProjectSync,
  createProjectSyncFeaturePullBatchOperation,
  createProjectSyncOperation,
  getProjectSyncOperation,
  getProjectSyncFeaturePullBatchOperation,
  getProjectSyncStatus,
  listProjectSyncOrigins,
  planProjectSync,
  planProjectSyncFeaturePullBatch,
  retryProjectSyncFeaturePullBatchOperation,
  waitForProjectSyncOperation,
} from '../../src/providers/project-sync';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

describe('project-sync provider', () => {
  it('uses scoped status/origin endpoints and unwraps their contract responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ data: { results: [{ scope: { kind: 'feature', projectId: 'f-1', appId: 'a-1' }, state: 'new', mappingValid: false, features: [], summary: { created: 1, unchanged: 0, changed: 0, deleted: 0 }, entries: [] }] } }))
      .mockResolvedValueOnce(response({ data: { origins: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    await getProjectSyncStatus({ kind: 'feature', projectId: 'f-1', appId: 'a-1' });
    expect(await listProjectSyncOrigins({ kind: 'feature', projectId: 'f-1', appId: 'a-1' })).toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/project-sync/status');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ scopes: [{ kind: 'feature', projectId: 'f-1', appId: 'a-1' }] });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/project-sync/origins?kind=feature&appId=a-1');
  });

  it('sends plan/apply bodies unchanged and recognizes PLAN_EXPIRED', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ data: { planId: 'p1', direction: 'pull', scope: { kind: 'feature', projectId: 'f1' }, origin: { mode: 'existing', originId: 'o1' }, features: [], entries: [], summary: { created: 0, unchanged: 1, changed: 0, deleted: 0 } } }))
      .mockResolvedValueOnce(response({ error: { code: 'PLAN_EXPIRED' } }, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    await planProjectSync({ direction: 'pull', scope: { kind: 'feature', projectId: 'f1' }, includeDeleted: true });
    await expect(applyProjectSync({ planId: 'p1', resolutions: { 'x.md': 'skip' } })).rejects.toBeInstanceOf(ProjectSyncPlanExpiredError);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ direction: 'pull', scope: { kind: 'feature', projectId: 'f1' }, includeDeleted: true });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ planId: 'p1', resolutions: { 'x.md': 'skip' } });
  });

  it('surfaces a 409 PROJECT_SYNC_STAGE_RUNNING as a typed error carrying the server wording', async () => {
    const serverMessage = 'Bước đang chạy — đợi xong rồi chia sẻ. checkout: dr-review';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: false, error: { code: 'PROJECT_SYNC_STAGE_RUNNING', message: serverMessage } }, { status: 409 }))
      .mockResolvedValueOnce(response({ ok: false, error: { code: 'PROJECT_SYNC_STAGE_RUNNING', message: serverMessage } }, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const planError = await planProjectSync({ direction: 'push', scope: { kind: 'feature', projectId: 'checkout', appId: 'retail' }, includeDeleted: true })
      .then(() => null, (cause: unknown) => cause);
    expect(planError).toBeInstanceOf(ProjectSyncStageRunningError);
    expect((planError as Error).message).toBe(serverMessage);
    expect((planError as ProjectSyncStageRunningError).code).toBe('PROJECT_SYNC_STAGE_RUNNING');
    await expect(createProjectSyncOperation({ planId: 'p1', resolutions: {} })).rejects.toBeInstanceOf(ProjectSyncStageRunningError);
    expect(PROJECT_SYNC_PUSH_PLAN_EXPIRED_MESSAGE).toContain('bước đang chạy');
  });

  it('creates and reads an asynchronous apply operation', async () => {
    const operation = {
      operationId: 'op-1',
      planId: 'p1',
      state: 'running',
      phase: 'transferring',
      progress: { completedItems: 2, totalItems: 4, percent: 50, currentPath: 'context/current.json' },
      createdAt: '2026-08-16T00:00:00Z',
      updatedAt: '2026-08-16T00:00:01Z',
      expiresAt: '2026-08-16T00:10:00Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ data: operation }, { status: 202 }))
      .mockResolvedValueOnce(response({ data: operation }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createProjectSyncOperation({ planId: 'p1', resolutions: { 'context/current.json': 'pull' } })).resolves.toEqual(operation);
    await expect(getProjectSyncOperation('op/1')).resolves.toEqual(operation);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/project-sync/operations');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ planId: 'p1', resolutions: { 'context/current.json': 'pull' } });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/project-sync/operations/op%2F1');
  });

  it('uses the Feature batch plan, operation, poll and retry endpoints', async () => {
    const plan = { planId: 'batch-1', createdAt: '', localAppId: 'app-1', originAppId: 'remote-app', features: [], totalItems: 0 };
    const operation = {
      operationId: 'op-1', planId: 'batch-1', state: 'running', phase: 'transferring',
      progress: { completedItems: 0, totalItems: 1, percent: 0 }, createdAt: '', updatedAt: '', expiresAt: '',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ data: plan }))
      .mockResolvedValueOnce(response({ data: operation }, { status: 202 }))
      .mockResolvedValueOnce(response({ data: operation }))
      .mockResolvedValueOnce(response({ data: operation }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(planProjectSyncFeaturePullBatch({
      localAppId: 'app-1', originAppId: 'remote-app', originFeatureIds: ['f-1', 'f-2'],
    })).resolves.toEqual(plan);
    await createProjectSyncFeaturePullBatchOperation({ planId: 'batch-1' });
    await getProjectSyncFeaturePullBatchOperation('op/1');
    await retryProjectSyncFeaturePullBatchOperation('op/1');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/project-sync/feature-pulls/plan',
      '/api/project-sync/feature-pulls/operations',
      '/api/project-sync/feature-pulls/operations/op%2F1',
      '/api/project-sync/feature-pulls/operations/op%2F1/retry',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      localAppId: 'app-1', originAppId: 'remote-app', originFeatureIds: ['f-1', 'f-2'],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ operationId: 'op/1' });
  });

  it('polls an operation to completion and reports every progress snapshot', async () => {
    const running = {
      operationId: 'op-1', planId: 'p1', state: 'running' as const, phase: 'transferring' as const,
      progress: { completedItems: 1, totalItems: 2, percent: 50 }, createdAt: '', updatedAt: '', expiresAt: '',
    };
    const succeeded = {
      ...running,
      state: 'succeeded' as const,
      phase: 'finalizing' as const,
      progress: { completedItems: 2, totalItems: 2, percent: 100 },
      result: { planId: 'p1', applied: 2, skipped: 0, unchanged: 0, softHiddenOriginFeatureIds: [], stale: [] },
    };
    const onUpdate = vi.fn();

    await expect(waitForProjectSyncOperation(running, vi.fn().mockResolvedValue(succeeded), {
      pollIntervalMs: 1,
      timeoutMs: 100,
      onUpdate,
    })).resolves.toEqual(succeeded);
    expect(onUpdate.mock.calls.map(([value]) => value.progress.percent)).toEqual([50, 100]);
  });

  it('stops polling and raises a friendly timeout error', async () => {
    const running = {
      operationId: 'op-timeout', planId: 'p1', state: 'running' as const, phase: 'transferring' as const,
      progress: { completedItems: 0, totalItems: 2, percent: 0 }, createdAt: '', updatedAt: '', expiresAt: '',
    };

    await expect(waitForProjectSyncOperation(running, vi.fn().mockResolvedValue(running), {
      pollIntervalMs: 5,
      timeoutMs: 15,
    })).rejects.toBeInstanceOf(ProjectSyncTimeoutError);
  });

  it('aborts a request that exceeds the network timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })));

    const request = planProjectSync({ direction: 'pull', scope: { kind: 'app', projectId: 'app-1', appId: 'app-1' } });
    const rejection = expect(request).rejects.toBeInstanceOf(ProjectSyncTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
  });
});
