// @vitest-environment jsdom
//
// "Xem lỗi" shows the id of the error report the daemon sent to the
// developers (PipelineView.errorReportId) — both when there is no run row to
// poll (fail-fast validation) and alongside a failed run.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineView } from '@open-design/contracts';

import { PipelineStatusModal } from '../../../src/components/pipelines/PipelineModals';

function pipeline(o: Partial<PipelineView>): PipelineView {
  return { id: 'docs', name: 'Tài liệu', dependsOn: [], status: 'failed', active: true, ...o } as PipelineView;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ id: 'run-1', status: 'failed', error: 'agent exit 1', createdAt: 1, updatedAt: 2 }), { status: 200 }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PipelineStatusModal error report id', () => {
  it('shows the report id for a fail-fast failure without a run', () => {
    render(
      <PipelineStatusModal
        pipeline={pipeline({ error: 'Chưa cấu hình Nguồn tài liệu', errorReportId: 'ab12cd34' })}
        projectId="P1"
        onClose={() => {}}
        onOpenChat={null}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText('Chưa cấu hình Nguồn tài liệu')).toBeTruthy();
    expect(screen.getByText('#ab12cd34')).toBeTruthy();
    expect(screen.getByText(/Đã gửi báo cáo lỗi/)).toBeTruthy();
  });

  it('shows the report id alongside a failed run', async () => {
    render(
      <PipelineStatusModal
        pipeline={pipeline({ lastRunId: 'run-1', error: 'Bước chạy thất bại', errorReportId: 'ff00ff00' })}
        projectId="P1"
        onClose={() => {}}
        onOpenChat={null}
        onRefresh={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('agent exit 1')).toBeTruthy());
    expect(screen.getByText('#ff00ff00')).toBeTruthy();
  });

  it('stays quiet when no report was sent', () => {
    render(
      <PipelineStatusModal
        pipeline={pipeline({ error: 'Chưa cấu hình Nguồn tài liệu' })}
        projectId="P1"
        onClose={() => {}}
        onOpenChat={null}
        onRefresh={() => {}}
      />,
    );
    expect(screen.queryByText(/Đã gửi báo cáo lỗi/)).toBeNull();
  });

  it('opens a multi-turn recovery conversation and validates only on explicit action', async () => {
    const onOpenTask = vi.fn();
    const onRefresh = vi.fn();
    render(
      <PipelineStatusModal
        pipeline={pipeline({
          recovery: {
            schemaVersion: 1,
            kind: 'flow',
            state: 'needs-assistance',
            updatedAt: 1,
            units: [{ id: 'flow-login', title: 'Flow đăng nhập', conversationId: 'recovery-conv', errors: ['Chưa thấy screen'] }],
          },
        })}
        projectId="P1"
        onClose={() => {}}
        onOpenChat={null}
        onOpenTask={onOpenTask}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByTestId('pipeline-recovery-workspace')).toBeTruthy();
    fireEvent.click(screen.getByText('Mở recovery chat'));
    expect(onOpenTask).toHaveBeenCalledWith('recovery-conv');

    fireEvent.click(screen.getByTestId('pipeline-recovery-validate'));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/pipelines/docs/recovery/validate',
      expect.objectContaining({ method: 'POST' }),
    ));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });
});
