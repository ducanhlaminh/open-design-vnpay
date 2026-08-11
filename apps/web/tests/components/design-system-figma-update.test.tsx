// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DesignSystemCriteriaUpdateReview,
  DesignSystemFigmaUpdateWorkspace,
} from '../../src/components/DesignSystemFigmaUpdate';
import type { DesignSystemFigmaUpdateState } from '../../src/providers/design-system-figma-update';
import { parseDesignSystemFigmaUpdateState } from '../../src/providers/design-system-figma-update';

const mocks = vi.hoisted(() => ({
  approveCriteria: vi.fn(),
  approveUpdate: vi.fn(),
  discardCriteria: vi.fn(),
  fetchState: vi.fn(),
  uploadUpdate: vi.fn(),
}));

vi.mock('../../src/providers/design-system-figma-update', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/design-system-figma-update')>(
    '../../src/providers/design-system-figma-update',
  );
  return {
    ...actual,
    approveDesignSystemCriteriaDraft: mocks.approveCriteria,
    approveDesignSystemFigmaUpdate: mocks.approveUpdate,
    discardDesignSystemCriteriaDraft: mocks.discardCriteria,
    fetchDesignSystemFigmaUpdateState: mocks.fetchState,
    uploadDesignSystemFigmaUpdate: mocks.uploadUpdate,
  };
});

const approved: DesignSystemFigmaUpdateState = parseDesignSystemFigmaUpdateState({
  designSystemId: 'ds-1',
  lifecycle: 'approved',
  currentVersion: 1,
  deleteOldSourceAfterApproval: false,
  criteria: {
    components: { status: 'current', count: 7, generatedFromVersion: 1 },
    rules: { status: 'current', count: 4, generatedFromVersion: 1 },
  },
});

const pending: DesignSystemFigmaUpdateState = parseDesignSystemFigmaUpdateState({
  designSystemId: 'ds-1',
  lifecycle: 'criteria_pending',
  currentVersion: 1,
  candidateVersion: 2,
  deleteOldSourceAfterApproval: true,
  criteria: {
    components: { status: 'stale', count: 7, generatedFromVersion: 1 },
    rules: { status: 'stale', count: 4, generatedFromVersion: 1 },
  },
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.fetchState.mockResolvedValue({ ok: true, value: approved });
});

describe('DesignSystemFigmaUpdateWorkspace', () => {
  it('updates the existing Design System with selected ZIP files and preserves explicit delete intent', async () => {
    mocks.uploadUpdate.mockResolvedValue({ ok: true, value: pending });
    render(
      <DesignSystemFigmaUpdateWorkspace systemId="user:payments" title="Payments DS">
        <div>showcase</div>
      </DesignSystemFigmaUpdateWorkspace>,
    );
    await screen.findByText('Bản đang dùng: 1');

    fireEvent.click(screen.getByRole('button', { name: 'Cập nhật từ file Figma' }));
    const input = screen.getByLabelText(/Chọn file ZIP Figma mới/) as HTMLInputElement;
    const zip = new File(['zip'], 'payments-v2.zip', { type: 'application/zip' });
    fireEvent.change(input, { target: { files: [zip] } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Xóa source Figma cũ sau khi duyệt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo bản cập nhật' }));

    await waitFor(() => expect(mocks.uploadUpdate).toHaveBeenCalledWith('user:payments', [zip], true));
    expect(await screen.findByText('Bản 2 đang chờ duyệt')).toBeTruthy();
    expect(screen.getAllByText(/Cần cập nhật/)).toHaveLength(2);
  });

  it('requires an explicit warning acknowledgement before approving with stale criteria', async () => {
    mocks.fetchState.mockResolvedValue({ ok: true, value: pending });
    const finalState: DesignSystemFigmaUpdateState = {
      ...approved,
      currentVersion: 2,
    };
    mocks.approveUpdate.mockResolvedValue({
      ok: true,
      value: {
        state: finalState,
        staleCriteriaAccepted: ['components', 'rules'],
        contextUpdates: [{ appId: 'merchant-app', status: 'created', contextVersion: '11' }],
      },
    });
    render(
      <DesignSystemFigmaUpdateWorkspace systemId="ds-1" title="Payments DS">
        <div>showcase</div>
      </DesignSystemFigmaUpdateWorkspace>,
    );
    await screen.findByText('Bản 2 đang chờ duyệt');

    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận duyệt bản 2' }));
    const approve = screen.getByRole('button', { name: 'Duyệt bản 2' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.getByText(/Danh mục component, Quy tắc thiết kế chưa được duyệt lại/)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: /Tôi hiểu các tài liệu trên vẫn là bản cũ/ }));
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);

    await waitFor(() => expect(mocks.approveUpdate).toHaveBeenCalledWith('ds-1', true));
    expect(await screen.findByText('1 ứng dụng có phiên bản ngữ cảnh mới')).toBeTruthy();
    expect(screen.getByText(/Feature không tự đổi phiên bản/)).toBeTruthy();
  });
});

describe('DesignSystemCriteriaUpdateReview', () => {
  it('previews a draft beside the approved file and approves it separately', async () => {
    const draftState: DesignSystemFigmaUpdateState = {
      ...pending,
      criteria: {
        ...pending.criteria,
        components: {
          ...pending.criteria.components,
          status: 'draft',
          count: 8,
          generatedFromVersion: 2,
          approvedContent: '# Components\nButton',
          draftContent: '# Components\nButton\nDatePicker',
        },
      },
    };
    const afterApprove: DesignSystemFigmaUpdateState = {
      ...draftState,
      criteria: {
        ...draftState.criteria,
        components: { ...draftState.criteria.components, status: 'current' },
      },
    };
    mocks.approveCriteria.mockResolvedValue({ ok: true, value: afterApprove });
    const onStateChange = vi.fn();
    render(
      <DesignSystemCriteriaUpdateReview
        systemId="ds-1"
        state={draftState}
        onStateChange={onStateChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Xem bản nháp' }));
    expect(screen.getByText('1 dòng mới, 0 dòng không còn trong bản mới.')).toBeTruthy();
    expect(screen.getByText(/DatePicker/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Duyệt bản mới' }));

    await waitFor(() => expect(mocks.approveCriteria).toHaveBeenCalledWith('ds-1', 'components'));
    expect(onStateChange).toHaveBeenCalledWith(afterApprove);
  });

  it('discards a generated draft without changing the approved file', async () => {
    const draftState: DesignSystemFigmaUpdateState = {
      ...pending,
      criteria: {
        ...pending.criteria,
        rules: {
          ...pending.criteria.rules,
          status: 'draft',
          count: 5,
          generatedFromVersion: 2,
          approvedContent: '# Rules\nOld rule',
          draftContent: '# Rules\nNew rule',
        },
      },
    };
    mocks.discardCriteria.mockResolvedValue({ ok: true, value: pending });
    render(
      <DesignSystemCriteriaUpdateReview systemId="ds-1" state={draftState} onStateChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Xem bản nháp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bỏ bản nháp' }));

    await waitFor(() => expect(mocks.discardCriteria).toHaveBeenCalledWith('ds-1', 'rules'));
  });
});
