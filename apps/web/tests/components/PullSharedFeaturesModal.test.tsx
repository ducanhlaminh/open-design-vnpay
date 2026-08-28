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
  preflightProjectSyncConfluence: vi.fn(),
  retryProjectSyncFeaturePullBatchOperation: vi.fn(),
  waitForProjectSyncOperation: vi.fn(async (initial, getOperation, options) => {
    options?.onUpdate?.(initial);
    let current = initial;
    while (current.state === 'queued' || current.state === 'running') {
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
        current = await getOperation(current.operationId);
        options?.onTransientError?.(null);
        options?.onUpdate?.(current);
      } catch (cause) {
        options?.onTransientError?.(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }
    return current;
  }),
}));

import {
  createProjectSyncFeaturePullBatchOperation,
  getProjectSyncFeaturePullBatchOperation,
  listProjectSyncOrigins,
  planProjectSyncFeaturePullBatch,
  preflightProjectSyncConfluence,
  retryProjectSyncFeaturePullBatchOperation,
  waitForProjectSyncOperation,
} from '../../src/providers/project-sync';
import { PullSharedFeaturesModal } from '../../src/components/pipelines/PullSharedFeaturesModal';

const listMock = vi.mocked(listProjectSyncOrigins);
const planMock = vi.mocked(planProjectSyncFeaturePullBatch);
const preflightMock = vi.mocked(preflightProjectSyncConfluence);
const createMock = vi.mocked(createProjectSyncFeaturePullBatchOperation);
const pollMock = vi.mocked(getProjectSyncFeaturePullBatchOperation);
const retryMock = vi.mocked(retryProjectSyncFeaturePullBatchOperation);
const waitMock = vi.mocked(waitForProjectSyncOperation);

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
    // No wiki-backed entry in the plan → no preflight round-trip.
    expect(preflightMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Tài liệu Confluence')).toBeNull();
  });

  it('runs the Confluence preflight for the batch plan and blocks the pull until it passes', async () => {
    listMock.mockResolvedValue(origins);
    const wiki = { base: 'https://wiki.example.vn', pageId: '123', spaceKey: 'SMB', attachment: 'a.png', attachmentVersion: 2 };
    const wikiPlan: ProjectSyncFeaturePullBatchPlan = {
      ...plan,
      planId: 'batch-wiki',
      features: plan.features.map((feature, index) => index === 0
        ? { ...feature, summary: { ...feature.summary, confluence: { files: 3, bytes: 3 * 1024 * 1024 } } }
        // Older daemon without summary.confluence: totals fall back to the entries.
        : { ...feature, entries: feature.entries.map((entry) => ({ ...entry, origin: { checksum: 'x', size: 512 }, confluence: wiki })) }),
    };
    planMock.mockResolvedValue(wikiPlan);
    const preflight = {
      required: true, files: 5, bytes: 3 * 1024 * 1024 + 1024, base: wiki.base, credsBase: wiki.base, baseMatches: true,
      token: 'ok' as const, displayName: 'Nguyễn Văn A', spaces: [{ key: 'SMB', samplePageId: '123', ok: true, status: 200, files: 5 }], ok: true,
    };
    preflightMock
      .mockResolvedValueOnce({ ...preflight, token: 'invalid', displayName: undefined, spaces: [], ok: false })
      .mockResolvedValueOnce(preflight);
    render(
      <PullSharedFeaturesModal
        localAppId="local-app" remoteAppOriginId="remote-app" preselectedOriginIds={['f-a', 'f-b']}
        onClose={() => {}} onCompleted={() => {}}
      />,
    );
    await screen.findByText('Feature A');
    fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    await screen.findByText('4 mục');

    await waitFor(() => expect(preflightMock).toHaveBeenCalledWith({ batchPlanId: 'batch-wiki' }));
    expect(await screen.findByText('PAT không hợp lệ hoặc hết hạn')).toBeTruthy();
    expect(screen.getByText('5 file (3.0 MB) sẽ tải từ https://wiki.example.vn')).toBeTruthy();
    const start = screen.getByRole('button', { name: 'Lấy 2 tính năng' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra lại' }));
    expect(await screen.findByText('PAT hợp lệ · Nguyễn Văn A')).toBeTruthy();
    expect(preflightMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(start.disabled).toBe(false));
  });

  it('keeps the dialog open and names the Feature whose wiki files went missing', async () => {
    listMock.mockResolvedValue(origins);
    planMock.mockResolvedValue(plan);
    const finished = result();
    const first = finished.items[0];
    if (first?.state === 'succeeded') {
      first.result = { ...first.result, confluence: { fetched: 1, drifted: [], missing: [{ path: 'f-a/attachments/a.png', reason: 'HTTP 404' }] } };
    }
    createMock.mockResolvedValue(operation({
      state: 'succeeded', phase: 'finalizing', progress: { completedItems: 4, totalItems: 4, percent: 100 }, result: finished,
    }));
    const onClose = vi.fn();
    const onCompleted = vi.fn();
    render(
      <PullSharedFeaturesModal
        localAppId="local-app" remoteAppOriginId="remote-app" preselectedOriginIds={['f-a', 'f-b']}
        onClose={onClose} onCompleted={onCompleted}
      />,
    );
    await screen.findByText('Feature A');
    fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    await screen.findByText('4 mục');
    fireEvent.click(screen.getByRole('button', { name: 'Lấy 2 tính năng' }));

    const warnings = await screen.findByTestId('feature-pull-confluence-warnings');
    expect(warnings.textContent).toContain('Feature A: 1 file Confluence không tải được (không ghi vào máy): f-a/attachments/a.png (HTTP 404)');
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Hoàn tất' }));
    expect(onClose).toHaveBeenCalledTimes(1);
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

    expect(await screen.findByText('2/4 file · 50%')).toBeTruthy();
    expect(screen.getByText('Feature A')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    await waitFor(() => expect(pollMock).toHaveBeenCalledWith('op-1'), { timeout: 2000 });
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(screen.getByText('4/4 file · 100%')).toBeTruthy();
    expect(screen.getAllByText('Thành công')).toHaveLength(2);
  });

  it('runs the bar indeterminate while validating, names wiki files while transferring and summarises the pull', async () => {
    listMock.mockResolvedValue(origins);
    planMock.mockResolvedValue(plan);
    createMock.mockResolvedValue(operation({ phase: 'validating', progress: { completedItems: 0, totalItems: 5, percent: 0 } }));
    const finished = result();
    for (const item of finished.items) {
      if (item.state === 'succeeded') {
        item.result = { ...item.result, confluence: { fetched: item.originId === 'f-a' ? 2 : 1, drifted: [], missing: [] } };
      }
    }
    pollMock
      .mockResolvedValueOnce(operation({
        phase: 'transferring',
        progress: { completedItems: 2, totalItems: 5, percent: 40, currentFeatureId: 'f-a', currentPath: 'f-a/attachments/hd-su-dung.pdf' },
      }))
      .mockResolvedValueOnce(operation({
        state: 'succeeded', phase: 'finalizing', progress: { completedItems: 5, totalItems: 5, percent: 100 }, result: finished,
      }));
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

    const progressPanel = await screen.findByTestId('feature-pull-progress');
    expect(progressPanel.textContent).toContain('Đang kiểm tra kế hoạch…');
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.getAttribute('data-indeterminate')).toBe('true');

    expect(await screen.findByText('2/5 file · 40%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');
    expect(screen.getByRole('progressbar').getAttribute('data-indeterminate')).toBeNull();
    expect(screen.getByText('Tính năng: f-a · Đang tải tài liệu từ wiki: hd-su-dung.pdf')).toBeTruthy();

    expect(await screen.findByText('5/5 file · 100%')).toBeTruthy();
    expect(screen.getByTestId('feature-pull-confluence-summary').textContent).toBe('Đã tải 3 file từ wiki · lệch 0 · thiếu 0');
    expect(screen.getByText('Đã hoàn tất')).toBeTruthy();
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
    expect(await screen.findByText('0/2 file · 0%')).toBeTruthy();
  });

  it('continues polling after a transient progress request fails', async () => {
    listMock.mockResolvedValue(origins);
    planMock.mockResolvedValue(plan);
    createMock.mockResolvedValue(operation());
    let finishPoll!: (value: ProjectSyncFeaturePullBatchOperation) => void;
    pollMock
      .mockRejectedValueOnce(new Error('Mất kết nối tạm thời'))
      .mockReturnValueOnce(new Promise((resolve) => { finishPoll = resolve; }));
    const completed = operation({
        state: 'succeeded', phase: 'finalizing', progress: { completedItems: 4, totalItems: 4, percent: 100 }, result: result(),
      });
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

    await waitFor(() => expect(pollMock.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3_500 });
    if (finishPoll) finishPoll(completed);
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  });

  it('shows a timeout alert and unlocks the modal so the user can retry', async () => {
    listMock.mockResolvedValue(origins);
    planMock.mockResolvedValue(plan);
    createMock.mockResolvedValue(operation());
    waitMock.mockRejectedValueOnce(new Error('Thao tác đồng bộ mất quá nhiều thời gian. Vui lòng thử lại.'));
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

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('mất quá nhiều thời gian'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Lấy 2 tính năng' }) as HTMLButtonElement).disabled).toBe(false));
  });
});
