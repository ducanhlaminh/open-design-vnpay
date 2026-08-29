// @vitest-environment jsdom
//
// wp-docs-review-report-quick-result (Executor W1): StageCommentPanel trong
// dự án ảo `drsnap.<confirmationId>.<projectId>` (báo cáo xác nhận) là CHỈ
// XEM — không composer, không nút xoá, có nhãn "chỉ xem"; danh sách + lọc
// theo mục vẫn như thường. Dự án thật giữ nguyên composer (đối chứng).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DocsReviewStageComment } from '@open-design/contracts';

const { StageCommentPanel } = await import('../../../src/components/docs-review/StageCommentPanel');

const SNAP_ID = 'drsnap.abc123.p1';

const COMMENTS: DocsReviewStageComment[] = [
  { id: 'c1', stageId: 'dr-mockup', text: 'Màn này thiếu nút quay lại', by: 'Anh', at: 1_700_000_000_000, target: { kind: 'screen', key: 'SCR-001', label: 'Trang chủ' } },
  { id: 'c2', stageId: 'dr-mockup', text: 'Bình luận chung cả bước', by: 'Bình', at: 1_700_000_001_000 },
];

let calls: Array<{ url: string; method: string }> = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url: String(input), method });
      if (method !== 'GET') return new Response(JSON.stringify({ error: 'Bản xác nhận chỉ đọc' }), { status: 405 });
      return new Response(JSON.stringify({ stageId: 'dr-mockup', comments: COMMENTS }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StageCommentPanel — chỉ xem trong dự án ảo drsnap.*', () => {
  it('projectId drsnap.* → không textarea "Bình luận mới cho bước", không nút xoá, có "chỉ xem"; danh sách + lọc theo mục giữ', async () => {
    render(<StageCommentPanel projectId={SNAP_ID} stageId="dr-mockup" target={{ kind: 'screen', key: 'SCR-001', label: 'Trang chủ' }} />);
    await waitFor(() => expect(screen.getByText(/Bình luận \(1\)/)).toBeTruthy());
    expect(screen.getByTestId('stage-comment-readonly').textContent).toContain('chỉ xem');
    expect(screen.queryByRole('textbox', { name: 'Bình luận mới cho bước' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Gửi$|Đang gửi/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Xoá bình luận' })).toBeNull();
    // Lọc theo mục vẫn hoạt động: "Tất cả bước" hiện đủ 2.
    const group = screen.getByRole('group', { name: 'Phạm vi bình luận' });
    fireEvent.click(within(group).getByRole('button', { name: 'Tất cả bước' }));
    expect(screen.getAllByTestId('stage-comment-item')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Xoá bình luận' })).toBeNull();
    // Chỉ có GET — không POST/DELETE nào lọt ra.
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls[0]!.url).toBe(`/api/projects/${SNAP_ID}/docs-review/comments/dr-mockup`);
  });

  it('prop readOnly override: readOnly={true} với dự án thật cũng ẩn composer; readOnly={false} với drsnap.* bật lại', async () => {
    const { unmount } = render(<StageCommentPanel projectId="p1" stageId="dr-mockup" readOnly />);
    await waitFor(() => expect(screen.getByText(/Bình luận \(2\)/)).toBeTruthy());
    expect(screen.queryByRole('textbox', { name: 'Bình luận mới cho bước' })).toBeNull();
    unmount();
    render(<StageCommentPanel projectId={SNAP_ID} stageId="dr-mockup" readOnly={false} />);
    await waitFor(() => expect(screen.getByText(/Bình luận \(2\)/)).toBeTruthy());
    expect(screen.getByRole('textbox', { name: 'Bình luận mới cho bước' })).toBeTruthy();
  });

  it('đối chứng: projectId thường vẫn có composer + nút xoá, không nhãn "chỉ xem"', async () => {
    render(<StageCommentPanel projectId="p1" stageId="dr-mockup" />);
    await waitFor(() => expect(screen.getByText(/Bình luận \(2\)/)).toBeTruthy());
    expect(screen.getByRole('textbox', { name: 'Bình luận mới cho bước' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Xoá bình luận' })).toHaveLength(2);
    expect(screen.queryByTestId('stage-comment-readonly')).toBeNull();
  });
});
