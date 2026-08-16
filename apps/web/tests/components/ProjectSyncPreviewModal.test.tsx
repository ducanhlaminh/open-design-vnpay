// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectSyncPlan } from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/providers/project-sync', () => ({
  ProjectSyncPlanExpiredError: class ProjectSyncPlanExpiredError extends Error {},
  createProjectSyncOperation: vi.fn(),
  getProjectSyncOperation: vi.fn(),
  planProjectSync: vi.fn(),
  waitForProjectSyncOperation: vi.fn(async (initial, getOperation, options) => {
    options?.onUpdate?.(initial);
    if (initial.state !== 'queued' && initial.state !== 'running') return initial;
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    const next = await getOperation(initial.operationId);
    options?.onUpdate?.(next);
    return next;
  }),
}));

vi.mock('../../src/components/project-sync/SyncSummary', () => ({
  SyncSummary: ({ summary }: { summary: { changed: number } }) => (
    <div data-testid="sync-summary">changed:{summary.changed}</div>
  ),
}));

vi.mock('../../src/components/project-sync/SyncPreviewTree', () => ({
  SyncPreviewTree: ({ plan }: { plan: ProjectSyncPlan }) => (
    <div data-testid="sync-tree">plan:{plan.planId}</div>
  ),
}));

import {
  createProjectSyncOperation,
  getProjectSyncOperation,
  planProjectSync,
  ProjectSyncPlanExpiredError,
} from '../../src/providers/project-sync';
import { ProjectSyncPreviewModal } from '../../src/components/project-sync/ProjectSyncPreviewModal';

const planProjectSyncMock = vi.mocked(planProjectSync);
const createProjectSyncOperationMock = vi.mocked(createProjectSyncOperation);
const getProjectSyncOperationMock = vi.mocked(getProjectSyncOperation);

function makePlan(planId: string, projectId: string): ProjectSyncPlan {
  return {
    planId,
    createdAt: '2026-08-16T00:00:00.000Z',
    direction: 'pull',
    scope: { kind: 'app', projectId },
    origin: { mode: 'existing', originId: 'origin-accounting' },
    features: [],
    entries: [{
      path: 'context/current.json',
      kind: 'context',
      change: 'changed',
      resolution: 'pull',
    }],
    summary: { created: 0, unchanged: 0, changed: 1, deleted: 0 },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectSyncPreviewModal request lifecycle', () => {
  it('does not refetch or clear its tree for equal-valued object rerenders', async () => {
    planProjectSyncMock.mockResolvedValue(makePlan('plan-1', 'accounting'));
    const props = {
      subjectName: 'Kế toán',
      onClose: vi.fn(),
    };
    const { rerender } = render(
      <ProjectSyncPreviewModal
        {...props}
        scope={{ kind: 'app', projectId: 'accounting' }}
        origin={{ mode: 'existing', originId: 'origin-accounting' }}
      />,
    );

    expect((await screen.findByTestId('sync-tree')).textContent).toBe('plan:plan-1');
    expect(planProjectSyncMock).toHaveBeenCalledTimes(1);

    rerender(
      <ProjectSyncPreviewModal
        {...props}
        scope={{ kind: 'app', projectId: 'accounting' }}
        origin={{ mode: 'existing', originId: 'origin-accounting' }}
      />,
    );

    expect(screen.getByTestId('sync-tree').textContent).toBe('plan:plan-1');
    expect(screen.queryByText('Đang tải trạng thái và bản trong kho chung…')).toBeNull();
    await waitFor(() => expect(planProjectSyncMock).toHaveBeenCalledTimes(1));
  });

  it('ignores a stale response after the primitive request identity changes', async () => {
    let resolveFirst!: (plan: ProjectSyncPlan) => void;
    planProjectSyncMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(makePlan('plan-new', 'treasury'));

    const { rerender } = render(
      <ProjectSyncPreviewModal
        subjectName="Kế toán"
        scope={{ kind: 'app', projectId: 'accounting' }}
        origin={{ mode: 'existing', originId: 'origin-accounting' }}
        onClose={() => {}}
      />,
    );

    rerender(
      <ProjectSyncPreviewModal
        subjectName="Ngân quỹ"
        scope={{ kind: 'app', projectId: 'treasury' }}
        origin={{ mode: 'existing', originId: 'origin-accounting' }}
        onClose={() => {}}
      />,
    );

    expect((await screen.findByTestId('sync-tree')).textContent).toBe('plan:plan-new');
    resolveFirst(makePlan('plan-stale', 'accounting'));

    await waitFor(() => {
      expect(screen.getByTestId('sync-tree').textContent).toBe('plan:plan-new');
      expect(screen.queryByText('plan:plan-stale')).toBeNull();
    });
  });

  it('keeps the current tree mounted while explicitly refreshing an expired plan', async () => {
    let resolveRefresh!: (plan: ProjectSyncPlan) => void;
    planProjectSyncMock
      .mockResolvedValueOnce(makePlan('plan-1', 'accounting'))
      .mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));
    createProjectSyncOperationMock.mockRejectedValueOnce(new ProjectSyncPlanExpiredError());

    render(
      <ProjectSyncPreviewModal
        subjectName="Kế toán"
        scope={{ kind: 'app', projectId: 'accounting' }}
        origin={{ mode: 'existing', originId: 'origin-accounting' }}
        onClose={() => {}}
      />,
    );

    expect((await screen.findByTestId('sync-tree')).textContent).toBe('plan:plan-1');
    fireEvent.click(screen.getByRole('button', { name: 'Lấy dự án về máy' }));
    const reload = await screen.findByRole('button', { name: 'Tải lại xem trước' });
    fireEvent.click(reload);

    expect(screen.getByRole('status').textContent).toBe('Đang làm mới bản xem trước…');
    expect(screen.getByTestId('sync-tree').textContent).toBe('plan:plan-1');

    resolveRefresh(makePlan('plan-2', 'accounting'));
    await waitFor(() => {
      expect(screen.getByTestId('sync-tree').textContent).toBe('plan:plan-2');
    });
  });

  it('keeps the plan mounted, shows determinate progress, and completes polling once', async () => {
    planProjectSyncMock.mockResolvedValue(makePlan('plan-1', 'accounting'));
    const result = { planId: 'plan-1', applied: 1, skipped: 0, unchanged: 0, softHiddenOriginFeatureIds: [], stale: [] };
    createProjectSyncOperationMock.mockResolvedValue({
      operationId: 'op-1', planId: 'plan-1', state: 'running', phase: 'transferring',
      progress: { completedItems: 2, totalItems: 4, percent: 50, currentPath: 'context/current.json' },
      createdAt: '', updatedAt: '', expiresAt: '',
    });
    getProjectSyncOperationMock.mockResolvedValue({
      operationId: 'op-1', planId: 'plan-1', state: 'succeeded', phase: 'finalizing',
      progress: { completedItems: 4, totalItems: 4, percent: 100 }, result,
      createdAt: '', updatedAt: '', expiresAt: '',
    });
    const onApplied = vi.fn();
    const onClose = vi.fn();

    render(
      <ProjectSyncPreviewModal
        subjectName="Kế toán"
        scope={{ kind: 'app', projectId: 'accounting' }}
        onClose={onClose}
        onApplied={onApplied}
      />,
    );
    expect(await screen.findByTestId('sync-tree')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lấy dự án về máy' }));

    const progress = await screen.findByRole('progressbar', { name: 'Tiến độ lấy dự án về máy' });
    expect(progress.getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getAllByText('2/4 mục · 50%')).toHaveLength(2);
    expect(screen.getByText('context/current.json')).toBeTruthy();
    expect(screen.getByTestId('sync-tree')).toBeTruthy();
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1), { timeout: 1_500 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports an operation failure and lets the user retry successfully', async () => {
    planProjectSyncMock.mockResolvedValue(makePlan('plan-1', 'accounting'));
    const result = { planId: 'plan-1', applied: 1, skipped: 0, unchanged: 0, softHiddenOriginFeatureIds: [], stale: [] };
    createProjectSyncOperationMock
      .mockResolvedValueOnce({
        operationId: 'op-failed', planId: 'plan-1', state: 'failed', phase: 'transferring',
        progress: { completedItems: 1, totalItems: 2, percent: 50 },
        error: { code: 'COPY_FAILED', message: 'Không thể sao chép tệp.', retryable: true },
        createdAt: '', updatedAt: '', expiresAt: '',
      })
      .mockResolvedValueOnce({
        operationId: 'op-success', planId: 'plan-1', state: 'succeeded', phase: 'finalizing',
        progress: { completedItems: 1, totalItems: 1, percent: 100 }, result,
        createdAt: '', updatedAt: '', expiresAt: '',
      });
    const onApplied = vi.fn();
    const onClose = vi.fn();
    render(
      <ProjectSyncPreviewModal
        subjectName="Kế toán"
        scope={{ kind: 'app', projectId: 'accounting' }}
        onClose={onClose}
        onApplied={onApplied}
      />,
    );
    expect(await screen.findByTestId('sync-tree')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lấy dự án về máy' }));
    expect(await screen.findByText('Không thể sao chép tệp.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lấy dự án về máy' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
