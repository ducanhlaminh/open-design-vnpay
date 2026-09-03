// @vitest-environment jsdom
//
// Pull tính năng không còn bước "Xem trước": một nút "Lấy N tính năng" chạy
// thẳng plan → preflight Confluence (nếu có file wiki) → apply.

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
  features: [
    {
      originId: 'f-a', name: 'Feature A', localId: 'local-f-a', mode: 'update',
      summary: { created: 0, changed: 2, unchanged: 1, deleted: 0 },
      entries: [
        // Stage do daemon gắn sẵn…
        { path: 'feature/docs-review/spec.md', kind: 'output', change: 'changed', resolution: 'pull', stage: 'docs-review' },
        // …hoặc suy từ segment đầu của path (sau prefix đơn vị `feature/`).
        { path: 'feature/docs-review/review.json', kind: 'output', change: 'changed', resolution: 'pull' },
        { path: 'feature/docs-review/notes.md', kind: 'output', change: 'unchanged', resolution: 'skip', stage: 'docs-review' },
      ],
    },
    {
      originId: 'f-b', name: 'Feature B', localId: 'local-f-b', mode: 'create',
      summary: { created: 2, changed: 0, unchanged: 0, deleted: 0 },
      entries: [
        { path: 'feature/ui-react/App.tsx', kind: 'output', change: 'new', resolution: 'pull', stage: 'ui-react' },
        { path: 'feature/context/urd.md', kind: 'context', change: 'new', resolution: 'pull' },
      ],
    },
  ],
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
  it('lọc theo remote App, một nút pull tạo plan chung và liệt kê CHỈ output đổi theo stage', async () => {
    listMock.mockResolvedValue(origins);
    planMock.mockResolvedValue(plan);
    let finishCreate!: (value: ProjectSyncFeaturePullBatchOperation) => void;
    createMock.mockReturnValue(new Promise((resolve) => { finishCreate = resolve; }));
    const onClose = vi.fn();
    render(
      <PullSharedFeaturesModal
        localAppId="local-app" remoteAppOriginId="remote-app"
        existingFeatureMappings={new Map([['f-a', 'feature-a-local']])}
        preselectedOriginIds={['f-a']} onClose={onClose} onCompleted={() => {}}
      />,
    );

    expect(await screen.findByText('Feature A')).toBeTruthy();
    expect(listMock).toHaveBeenCalledWith({ kind: 'feature', appId: 'remote-app' });
    expect(screen.getByText('Cập nhật feature-a-local')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Xem trước' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Feature B/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Lấy 2 tính năng' }));

    await waitFor(() => expect(planMock).toHaveBeenCalledWith({
      localAppId: 'local-app', originAppId: 'remote-app', originFeatureIds: ['f-a', 'f-b'],
    }));
    // Per-row: đếm CHỈ entries output có thay đổi, breakdown theo stage; entry
    // context/binding không lẫn vào con số output.
    expect(await screen.findByText('docs-review 2 · Cập nhật')).toBeTruthy();
    expect(screen.getByText('ui-react 1 · Tạo mới')).toBeTruthy();
    // Section "Nội dung sẽ lấy" (summary grid) đã bỏ — thông tin nằm per-row.
    expect(screen.queryByLabelText('Tóm tắt nội dung sẽ lấy')).toBeNull();
    // Không có file wiki trong plan → không preflight, apply chạy luôn.
    expect(preflightMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Tài liệu Confluence')).toBeNull();
    expect(createMock).toHaveBeenCalledWith({ planId: 'batch-1' });
    finishCreate(operation({ state: 'succeeded', phase: 'finalizing', progress: { completedItems: 4, totalItems: 4, percent: 100 }, result: result() }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('preflight Confluence là gate cứng: fail thì dừng trước apply, "Kiểm tra lại" pass thì tự chạy tiếp', async () => {
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
    createMock.mockResolvedValue(operation({
      state: 'succeeded', phase: 'finalizing', progress: { completedItems: 4, totalItems: 4, percent: 100 }, result: result(),
    }));
    render(
      <PullSharedFeaturesModal
        localAppId="local-app" remoteAppOriginId="remote-app" preselectedOriginIds={['f-a', 'f-b']}
        onClose={() => {}} onCompleted={() => {}}
      />,
    );
    await screen.findByText('Feature A');
    fireEvent.click(screen.getByRole('button', { name: 'Lấy 2 tính năng' }));

    await waitFor(() => expect(preflightMock).toHaveBeenCalledWith({ batchPlanId: 'batch-wiki' }));
    expect(await screen.findByText('PAT không hợp lệ hoặc hết hạn')).toBeTruthy();
    expect(screen.getByText('5 file (3.0 MB) sẽ tải từ https://wiki.example.vn')).toBeTruthy();
    expect(createMock).not.toHaveBeenCalled();
    const start = screen.getByRole('button', { name: 'Lấy 2 tính năng' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra lại' }));
    expect(await screen.findByText('PAT hợp lệ · Nguyễn Văn A')).toBeTruthy();
    expect(preflightMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ planId: 'batch-wiki' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Lấy 2 tính năng' }));

    await waitFor(() => expect(pollMock.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3_500 });
    if (finishPoll) finishPoll(completed);
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  });

  it('shows a timeout alert and unlocks the modal so the user can retry from a fresh plan', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Lấy 2 tính năng' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('mất quá nhiều thời gian'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Lấy 2 tính năng' }) as HTMLButtonElement).disabled).toBe(false));
  });
});
