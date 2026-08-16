// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ProjectSyncFeaturePullBatchOperation,
  ProjectSyncFeaturePullBatchPlan,
  ProjectSyncFeaturePullBatchResult,
  ProjectSyncOrigin,
} from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/providers/project-sync', () => ({
  createProjectSyncFeaturePullBatchOperation: vi.fn(),
  getProjectSyncFeaturePullBatchOperation: vi.fn(),
  listProjectSyncOrigins: vi.fn(),
  planProjectSyncFeaturePullBatch: vi.fn(),
  retryProjectSyncFeaturePullBatchOperation: vi.fn(),
}));

import {
  createProjectSyncFeaturePullBatchOperation,
  getProjectSyncFeaturePullBatchOperation,
  listProjectSyncOrigins,
  planProjectSyncFeaturePullBatch,
  retryProjectSyncFeaturePullBatchOperation,
} from '../../src/providers/project-sync';
import { PullSharedFeaturesModal } from '../../src/components/pipelines/PullSharedFeaturesModal';

const listMock = vi.mocked(listProjectSyncOrigins);
const planMock = vi.mocked(planProjectSyncFeaturePullBatch);
const createMock = vi.mocked(createProjectSyncFeaturePullBatchOperation);
const pollMock = vi.mocked(getProjectSyncFeaturePullBatchOperation);
const retryMock = vi.mocked(retryProjectSyncFeaturePullBatchOperation);

const origins: ProjectSyncOrigin[] = [
  { originId: 'f-a', name: 'Feature A', kind: 'feature', appId: 'remote-app', visibility: 'visible', inMedia: true },
  { originId: 'f-b', name: 'Feature B', kind: 'feature', appId: 'remote-app', visibility: 'visible', inMedia: true },
];

const plan: ProjectSyncFeaturePullBatchPlan = {
  planId: 'batch-1', createdAt: '', localAppId: 'local-app', originAppId: 'remote-app', totalItems: 4,
  features: origins.map((origin, index) => ({
    originId: origin.originId, name: origin.name, localId: `local-${origin.originId}`, mode: index ? 'create' : 'update',
    summary: { created: index ? 2 : 0, changed: index ? 0 : 2, unchanged: 0, deleted: 0 },
    entries: Array.from({ length: 2 }, (_, entry) => ({
      path: `${origin.originId}/${entry}.json`, kind: 'feature' as const, change: index ? 'new' as const : 'changed' as const,
      resolution: 'pull' as const,
    })),
  })),
};

function operation(overrides: Partial<ProjectSyncFeaturePullBatchOperation> = {}): ProjectSyncFeaturePullBatchOperation {
  return {
    operationId: 'op-1', planId: plan.planId, state: 'running', phase: 'transferring',
    progress: { completedItems: 2, totalItems: 4, percent: 50, currentFeatureId: 'f-a', currentPath: 'f-a/1.json' },
    createdAt: '', updatedAt: '', expiresAt: '', ...overrides,
  };
}

function result(state: ProjectSyncFeaturePullBatchResult['state'] = 'succeeded'): ProjectSyncFeaturePullBatchResult {
  return {
    planId: plan.planId, localAppId: 'local-app', originAppId: 'remote-app', state,
    items: [
      { originId: 'f-a', localId: 'local-f-a', state: 'succeeded', result: { planId: 'a', applied: 2, skipped: 0, unchanged: 0, softHiddenOriginFeatureIds: [], stale: [] } },
      ...(state === 'partial' ? [{
        originId: 'f-b', localId: 'local-f-b', state: 'failed' as const,
        error: { code: 'COPY_FAILED', message: 'Không chép được Feature B', retryable: true },
      }] : [{ originId: 'f-b', localId: 'local-f-b', state: 'succeeded' as const, result: { planId: 'b', applied: 2, skipped: 0, unchanged: 0, softHiddenOriginFeatureIds: [], stale: [] } }]),
    ],
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('PullSharedFeaturesModal', () => {
  it('filters by the remote App and creates one plan for a multi-selection', async () => {
    listMock.mockResolvedValue(origins);
    planMock.mockResolvedValue(plan);
    render(
      <PullSharedFeaturesModal
        localAppId="local-app" remoteAppOriginId="remote-app"
        existingFeatureMappings={new Map([['f-a', 'feature-a-local']])}
        preselectedOriginIds={['f-a']} onClose={() => {}} onCompleted={() => {}}
      />,
    );

    expect(await screen.findByText('Feature A')).toBeTruthy();
    expect(listMock).toHaveBeenCalledWith({ kind: 'feature', appId: 'remote-app' });
    expect(screen.getByText('Cập nhật feature-a-local')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /Feature B/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));

    await waitFor(() => expect(planMock).toHaveBeenCalledWith({
      localAppId: 'local-app', originAppId: 'remote-app', originFeatureIds: ['f-a', 'f-b'],
    }));
    expect(await screen.findByText('4 mục')).toBeTruthy();
    const summary = screen.getByLabelText('Tóm tắt nội dung sẽ lấy');
    expect(summary.textContent).toContain('2 tạo mới');
    expect(summary.textContent).toContain('2 thay đổi');
  });

  it('keeps the picker mounted while showing determinate progress and reports completion once', async () => {
    listMock.mockResolvedValue(origins);
    planMock.mockResolvedValue(plan);
    createMock.mockResolvedValue(operation());
    pollMock.mockResolvedValue(operation({
      state: 'succeeded', phase: 'finalizing', progress: { completedItems: 4, totalItems: 4, percent: 100 }, result: result(),
    }));
    const onCompleted = vi.fn();
    render(
      <PullSharedFeaturesModal
        localAppId="local-app" remoteAppOriginId="remote-app" preselectedOriginIds={['f-a', 'f-b']}
        onClose={() => {}} onCompleted={onCompleted}
      />,
    );
    await screen.findByText('Feature A');
    fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    await screen.findByText('4 mục');
    fireEvent.click(screen.getByRole('button', { name: 'Lấy 2 tính năng' }));

    expect(await screen.findByText('50% · 2/4')).toBeTruthy();
    expect(screen.getByText('Feature A')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    await waitFor(() => expect(pollMock).toHaveBeenCalledWith('op-1'), { timeout: 2000 });
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(screen.getByText('100% · 4/4')).toBeTruthy();
    expect(screen.getAllByText('Thành công')).toHaveLength(2);
  });

  it('shows per-item partial results and retries only through the failed-operation endpoint', async () => {
    listMock.mockResolvedValue(origins);
    planMock.mockResolvedValue(plan);
    createMock.mockResolvedValue(operation({
      state: 'succeeded', phase: 'finalizing', progress: { completedItems: 4, totalItems: 4, percent: 100 }, result: result('partial'),
    }));
    retryMock.mockResolvedValue(operation({ operationId: 'op-retry', progress: { completedItems: 0, totalItems: 2, percent: 0 } }));
    render(
      <PullSharedFeaturesModal
        localAppId="local-app" remoteAppOriginId="remote-app" preselectedOriginIds={['f-a', 'f-b']}
        onClose={() => {}} onCompleted={() => {}}
      />,
    );
    await screen.findByText('Feature A');
    fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    await screen.findByText('4 mục');
    fireEvent.click(screen.getByRole('button', { name: 'Lấy 2 tính năng' }));

    expect(await screen.findByText('Không chép được Feature B')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại phần bị lỗi' }));
    await waitFor(() => expect(retryMock).toHaveBeenCalledWith('op-1'));
    expect(await screen.findByText('0% · 0/2')).toBeTruthy();
  });

  it('continues polling after a transient progress request fails', async () => {
    listMock.mockResolvedValue(origins);
    planMock.mockResolvedValue(plan);
    createMock.mockResolvedValue(operation());
    pollMock
      .mockRejectedValueOnce(new Error('Mất kết nối tạm thời'))
      .mockResolvedValueOnce(operation({
        state: 'succeeded', phase: 'finalizing', progress: { completedItems: 4, totalItems: 4, percent: 100 }, result: result(),
      }));
    const onCompleted = vi.fn();
    render(
      <PullSharedFeaturesModal
        localAppId="local-app" remoteAppOriginId="remote-app" preselectedOriginIds={['f-a', 'f-b']}
        onClose={() => {}} onCompleted={onCompleted}
      />,
    );
    await screen.findByText('Feature A');
    fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    await screen.findByText('4 mục');
    fireEvent.click(screen.getByRole('button', { name: 'Lấy 2 tính năng' }));

    expect(await screen.findByText('Mất kết nối tạm thời', {}, { timeout: 2_000 })).toBeTruthy();
    await waitFor(() => expect(pollMock).toHaveBeenCalledTimes(2), { timeout: 3_500 });
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  });
});
