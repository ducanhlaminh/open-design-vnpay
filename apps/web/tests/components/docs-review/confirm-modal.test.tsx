// @vitest-environment jsdom
//
// DocsReviewConfirmModal (wp-docs-review-confirm-v2, Executor J3): modal chặn
// trước "Xác nhận hoàn tất" — liệt kê bước + số bình luận, gate bằng checkbox
// "Tôi đã xem hết kết quả các bước", POST như cũ (sourceRunId), sau 201 hiện
// "Mở báo cáo" điều hướng nội bộ /feedback/docs-review/<projectId>/<confirmId>.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

const { DocsReviewConfirmModal, docsReviewReportPath } = await import('../../../src/components/docs-review/DocsReviewConfirmModal');

const STAGES = [
  { id: 'dr-docs', name: 'Tài liệu', status: 'succeeded' },
  { id: 'dr-flow', name: 'Luồng màn hình', status: 'succeeded' },
  { id: 'dr-flow-improve', name: 'Cải thiện luồng', status: 'succeeded' },
  { id: 'dr-mockup', name: 'Mockup màn', status: 'succeeded' },
  { id: 'dr-review', name: 'Review tài liệu', status: 'succeeded' },
];
const COUNTS = { 'dr-docs': 0, 'dr-flow': 2, 'dr-flow-improve': 0, 'dr-mockup': 3, 'dr-review': 1 };

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/pipelines');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ok(body: unknown, status = 201) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('DocsReviewConfirmModal', () => {
  it('liệt kê 5 bước (tên · trạng thái · 💬 n); nút xác nhận khoá tới khi tick checkbox', () => {
    render(
      <DocsReviewConfirmModal projectId="p1" stages={STAGES} commentCounts={COUNTS} onClose={() => {}} onConfirmed={() => {}} />,
    );
    const list = screen.getByTestId('docs-review-confirm-stages');
    const rows = list.querySelectorAll('li');
    expect(rows).toHaveLength(5);
    expect(rows[3]!.textContent).toContain('Mockup màn');
    expect(rows[3]!.textContent).toContain('Hoàn thành');
    expect(rows[3]!.textContent).toContain('3');
    expect(screen.getByText('Tổng 6 bình luận cấp bước sẽ được gửi kèm.')).toBeTruthy();

    const submit = screen.getByTestId('docs-review-confirm-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('docs-review-confirm-ack'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(screen.getByTestId('docs-review-confirm-ack'));
    expect(submit.disabled).toBe(true);
  });

  it('tick → POST /docs-review/confirm { sourceRunId } → onConfirmed(body) + "Mở báo cáo" điều hướng nội bộ (pushState + popstate)', async () => {
    const artifact = { confirmationId: 'conf-42', summary: { agentProposals: 7, humanEdits: 2, comments: 6 } };
    fetchMock.mockResolvedValue(ok({ ok: true, artifact, mediaPath: 'm', localPath: 'l', studioUrl: 'https://studio/x' }));
    const onConfirmed = vi.fn();
    const onClose = vi.fn();
    const popstate = vi.fn();
    window.addEventListener('popstate', popstate);
    render(
      <DocsReviewConfirmModal projectId="p 1" stages={STAGES} commentCounts={COUNTS} sourceRunId="run-9" onClose={onClose} onConfirmed={onConfirmed} />,
    );
    fireEvent.click(screen.getByTestId('docs-review-confirm-ack'));
    fireEvent.click(screen.getByTestId('docs-review-confirm-submit'));
    await waitFor(() => expect(screen.getByTestId('docs-review-confirm-done')).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/p%201/docs-review/confirm');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ sourceRunId: 'run-9' });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed.mock.calls[0]![0]).toMatchObject({ artifact: { confirmationId: 'conf-42' } });
    expect(screen.getByTestId('docs-review-confirm-done').textContent).toContain('7 đề xuất của agent, 2 chỉnh sửa, 6 bình luận');
    // Không còn nút xác nhận; có Đóng + Mở báo cáo.
    expect(screen.queryByTestId('docs-review-confirm-submit')).toBeNull();

    fireEvent.click(screen.getByTestId('docs-review-open-report'));
    expect(window.location.pathname).toBe(docsReviewReportPath('p 1', 'conf-42'));
    expect(window.location.pathname).toBe('/feedback/docs-review/p%201/conf-42');
    expect(popstate).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    window.removeEventListener('popstate', popstate);
  });

  it('không có sourceRunId → body {}; POST lỗi → hiện lỗi, KHÔNG onConfirmed, checkbox vẫn tick để thử lại', async () => {
    fetchMock.mockResolvedValue(ok({ error: 'Chưa đủ output' }, 409));
    const onConfirmed = vi.fn();
    render(
      <DocsReviewConfirmModal projectId="p1" stages={STAGES} commentCounts={{}} onClose={() => {}} onConfirmed={onConfirmed} />,
    );
    fireEvent.click(screen.getByTestId('docs-review-confirm-ack'));
    fireEvent.click(screen.getByTestId('docs-review-confirm-submit'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa đủ output'));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
    expect(onConfirmed).not.toHaveBeenCalled();
    expect((screen.getByTestId('docs-review-confirm-ack') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('docs-review-open-report')).toBeNull();
  });

  it('201 nhưng thiếu confirmationId → không có nút Mở báo cáo (chỉ Đóng)', async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    render(
      <DocsReviewConfirmModal projectId="p1" stages={STAGES} commentCounts={{}} onClose={() => {}} onConfirmed={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('docs-review-confirm-ack'));
    fireEvent.click(screen.getByTestId('docs-review-confirm-submit'));
    await waitFor(() => expect(screen.getByTestId('docs-review-confirm-done')).toBeTruthy());
    expect(screen.queryByTestId('docs-review-open-report')).toBeNull();
    expect(screen.getByTestId('docs-review-confirm-close')).toBeTruthy();
  });
});
