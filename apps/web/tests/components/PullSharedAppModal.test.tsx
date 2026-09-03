// @vitest-environment jsdom
//
// Pull App không còn bước xem trước: bấm pull là modal tự chạy chuỗi
// plan → preflight Confluence (chỉ khi có file wiki) → apply với resolution
// mặc định của plan.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectSyncOperation, ProjectSyncPlan } from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/providers/project-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/project-sync')>()),
  listProjectSyncOrigins: vi.fn(),
  planProjectSync: vi.fn(),
  preflightProjectSyncConfluence: vi.fn(),
  createProjectSyncOperation: vi.fn(),
  getProjectSyncOperation: vi.fn(),
  waitForProjectSyncOperation: vi.fn(async (initial, getOperation, options) => {
    options?.onUpdate?.(initial);
    let current = initial;
    while (current.state === 'queued' || current.state === 'running') {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
      current = await getOperation(current.operationId);
      options?.onTransientError?.(null);
      options?.onUpdate?.(current);
    }
    return current;
  }),
}));

import {
  createProjectSyncOperation,
  listProjectSyncOrigins,
  planProjectSync,
  preflightProjectSyncConfluence,
} from '../../src/providers/project-sync';
import { PullSharedAppModal } from '../../src/components/pipelines/PullSharedAppModal';

const listMock = vi.mocked(listProjectSyncOrigins);
const planMock = vi.mocked(planProjectSync);
const preflightMock = vi.mocked(preflightProjectSyncConfluence);
const createMock = vi.mocked(createProjectSyncOperation);

const sharedApp = {
  originId: 'remote-accounting',
  name: 'Kế toán',
  kind: 'app' as const,
  appId: null,
  visibility: 'visible' as const,
  inMedia: true,
  mappingVersion: null,
};

function planOf(overrides: Partial<ProjectSyncPlan> = {}): ProjectSyncPlan {
  return {
    planId: 'plan-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    direction: 'pull',
    scope: { kind: 'app', projectId: 'ke-toan' },
    origin: { mode: 'existing', originId: 'remote-accounting' },
    features: [],
    entries: [
      { path: 'app/context/urd.md', kind: 'context', change: 'changed', resolution: 'pull' },
      { path: 'app/context/prd.md', kind: 'context', change: 'new', resolution: 'pull' },
      { path: 'app/context/logo.png', kind: 'context', change: 'unchanged', resolution: 'skip' },
    ],
    summary: { created: 1, unchanged: 1, changed: 1, deleted: 0 },
    ...overrides,
  };
}

function operationOf(overrides: Partial<ProjectSyncOperation> = {}): ProjectSyncOperation {
  return {
    operationId: 'op-1',
    planId: 'plan-1',
    state: 'succeeded',
    phase: 'finalizing',
    progress: { completedItems: 2, totalItems: 2, percent: 100 },
    createdAt: '',
    updatedAt: '',
    expiresAt: '',
    result: { planId: 'plan-1', applied: 2, skipped: 0, unchanged: 1, softHiddenOriginFeatureIds: [], stale: [] },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PullSharedAppModal', () => {
  it('list mode: bấm "Lấy về máy" chạy thẳng plan → apply, không tạo App rỗng và không hỏi lại', async () => {
    listMock.mockResolvedValue([sharedApp]);
    planMock.mockResolvedValue(planOf());
    createMock.mockResolvedValue(operationOf());
    const onClose = vi.fn();
    const onApplied = vi.fn();
    render(
      <PullSharedAppModal
        mappedOriginIds={new Set()}
        localAppIds={new Set()}
        onClose={onClose}
        onApplied={onApplied}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Lấy về máy' }));

    await waitFor(() => expect(planMock).toHaveBeenCalledWith({
      direction: 'pull',
      scope: { kind: 'app', projectId: 'ke-toan' },
      origin: { mode: 'existing', originId: 'remote-accounting' },
      includeDeleted: true,
    }));
    // Apply với resolution mặc định của plan — không gửi lựa chọn từng file.
    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ planId: 'plan-1' }));
    expect(preflightMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hiện đúng 1 dòng tóm tắt gọn thay cho cây file sau khi plan', async () => {
    listMock.mockResolvedValue([sharedApp]);
    planMock.mockResolvedValue(planOf());
    let finishCreate!: (value: ProjectSyncOperation) => void;
    createMock.mockReturnValue(new Promise((resolve) => { finishCreate = resolve; }));
    const onClose = vi.fn();
    render(
      <PullSharedAppModal
        mappedOriginIds={new Set()}
        localAppIds={new Set()}
        onClose={onClose}
        onApplied={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Lấy về máy' }));

    const summary = await screen.findByTestId('project-sync-plan-summary');
    // Đếm entries `change !== 'unchanged'`; App pull toàn bộ là kind context.
    expect(summary.textContent).toBe('Tài liệu dùng chung · 2 mục cập nhật');
    expect(screen.getByTestId('project-sync-progress').textContent).toContain('Đang kiểm tra kế hoạch…');
    finishCreate(operationOf());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('dùng destination id còn trống khi slug từ tên hiển thị đã tồn tại', async () => {
    listMock.mockResolvedValue([sharedApp]);
    planMock.mockResolvedValue(planOf());
    createMock.mockResolvedValue(operationOf());
    render(
      <PullSharedAppModal
        mappedOriginIds={new Set()}
        localAppIds={new Set(['ke-toan', 'ke-toan-2'])}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Lấy về máy' }));
    await waitFor(() => expect(planMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'app', projectId: 'ke-toan-3' },
    })));
  });

  it('mode một App (đã có mapping): mở modal là tự chạy plan không origin rồi apply', async () => {
    planMock.mockResolvedValue(planOf({ scope: { kind: 'app', projectId: 'retail' } }));
    createMock.mockResolvedValue(operationOf());
    const onClose = vi.fn();
    const onApplied = vi.fn();
    render(
      <PullSharedAppModal
        scope={{ kind: 'app', projectId: 'retail' }}
        subjectName="Retail"
        onClose={onClose}
        onApplied={onApplied}
      />,
    );

    await waitFor(() => expect(planMock).toHaveBeenCalledWith({
      direction: 'pull',
      scope: { kind: 'app', projectId: 'retail' },
      includeDeleted: true,
    }));
    expect(listMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('preflight Confluence là gate cứng: fail thì dừng, "Kiểm tra lại" pass thì tự apply tiếp', async () => {
    planMock.mockResolvedValue(planOf({
      summary: { created: 1, unchanged: 1, changed: 1, deleted: 0, confluence: { files: 2, bytes: 1024 } },
    }));
    const preflight = {
      required: true, files: 2, bytes: 1024, base: 'https://wiki.example.vn', credsBase: 'https://wiki.example.vn',
      baseMatches: true, token: 'ok' as const, displayName: 'Nguyễn Văn A',
      spaces: [{ key: 'SMB', samplePageId: '1', ok: true, status: 200, files: 2 }], ok: true,
    };
    preflightMock
      .mockResolvedValueOnce({ ...preflight, token: 'invalid', displayName: undefined, spaces: [], ok: false })
      .mockResolvedValueOnce(preflight);
    createMock.mockResolvedValue(operationOf());
    const onApplied = vi.fn();
    render(
      <PullSharedAppModal
        scope={{ kind: 'app', projectId: 'retail' }}
        subjectName="Retail"
        onClose={() => {}}
        onApplied={onApplied}
      />,
    );

    expect(await screen.findByText('PAT không hợp lệ hoặc hết hạn')).toBeTruthy();
    expect(createMock).not.toHaveBeenCalled();
    const pullButton = screen.getByRole('button', { name: 'Lấy dự án về máy' }) as HTMLButtonElement;
    expect(pullButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra lại' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ planId: 'plan-1' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });

  it('giữ modal mở khi có cảnh báo wiki drift/missing; "Hoàn tất" mới đóng', async () => {
    planMock.mockResolvedValue(planOf());
    createMock.mockResolvedValue(operationOf({
      result: {
        planId: 'plan-1', applied: 2, skipped: 0, unchanged: 1, softHiddenOriginFeatureIds: [], stale: [],
        confluence: { fetched: 1, drifted: [], missing: [{ path: 'context/attachments/a.png', reason: 'HTTP 404' }] },
      },
    }));
    const onClose = vi.fn();
    const onApplied = vi.fn();
    render(
      <PullSharedAppModal
        scope={{ kind: 'app', projectId: 'retail' }}
        subjectName="Retail"
        onClose={onClose}
        onApplied={onApplied}
      />,
    );

    const warnings = await screen.findByTestId('project-sync-confluence-warnings');
    expect(warnings.textContent).toContain('1 file Confluence không tải được (không ghi vào máy): context/attachments/a.png (HTTP 404)');
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Hoàn tất' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('plan lỗi thì hiện lỗi và nút pull chạy lại từ plan mới', async () => {
    planMock
      .mockRejectedValueOnce(new Error('Kho chung phản hồi quá lâu. Vui lòng thử lại.'))
      .mockResolvedValueOnce(planOf());
    createMock.mockResolvedValue(operationOf());
    const onApplied = vi.fn();
    render(
      <PullSharedAppModal
        scope={{ kind: 'app', projectId: 'retail' }}
        subjectName="Retail"
        onClose={() => {}}
        onApplied={onApplied}
      />,
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Kho chung phản hồi quá lâu.');
    fireEvent.click(screen.getByRole('button', { name: 'Lấy dự án về máy' }));
    await waitFor(() => expect(planMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });
});
