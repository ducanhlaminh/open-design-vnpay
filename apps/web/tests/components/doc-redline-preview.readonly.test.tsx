// @vitest-environment jsdom
//
// wp-docs-review-report-quick-result (Executor W1): DocRedlinePreview trong dự
// án ảo `drsnap.*` (báo cáo xác nhận) chỉ xem — không toolbar "Tự chỉnh";
// panel chi tiết không footer (Chỉnh đề xuất / Bỏ / Hoàn tác), không composer
// "Bình luận mới" + nút xoá bình luận, nhưng danh sách bình luận annotation
// vẫn hiện. Chọn annotation / mode Thay đổi|Nhận xét giữ nguyên.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const TEXT = ['# Tài liệu', '', 'Người dùng nhập mã xác thực.', '', 'Người dùng nhập OTP.', ''].join('\n');
const SIDECAR = JSON.stringify({
  schemaVersion: 2,
  annotations: [{
    id: 'agent-1',
    kind: 'ux-writing',
    severity: 'minor',
    origin: 'agent',
    operation: 'edited',
    before: 'Người dùng nhập mã xác thực.',
    quote: 'Người dùng nhập OTP.',
    initialBefore: 'Người dùng nhập mã xác thực.',
    initialQuote: 'Người dùng nhập OTP.',
    reason: 'Dùng thuật ngữ trong tài liệu.',
    comments: [{ id: 'cm1', text: 'Cần BA xác nhận lại.', at: 1_700_000_000_000, by: 'Anh' }],
  }],
  events: [],
});

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => {
    if (name.endsWith('.changes.json')) return SIDECAR;
    if (name.endsWith('.notes.json')) return null;
    return TEXT;
  },
  projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
}));
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../src/components/docs-review/StageCommentPanel', () => ({
  StageCommentPanel: (props: { projectId: string; stageId: string }) => (
    <aside data-testid="stage-comment-panel" data-project-id={props.projectId} data-stage-id={props.stageId} />
  ),
}));

const { DocRedlinePreview } = await import('../../src/components/DocRedlinePreview');

const SNAP_ID = 'drsnap.abc123.p1';
const FILE = {
  name: 'docs-review/review/docs/urd.md',
  kind: 'text',
  size: TEXT.length,
  mtime: 1,
} as never;

const fetchMock = vi.fn();

beforeAll(() => {
  Element.prototype.scrollIntoView = function noop() {};
});
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => cleanup());

function writeCalls() {
  return fetchMock.mock.calls.filter((args) => (args[1] as RequestInit | undefined)?.method === 'POST');
}

describe('DocRedlinePreview — chỉ xem trong dự án ảo drsnap.*', () => {
  it('drsnap.* → không "Tự chỉnh"; panel chi tiết không Bỏ/Chỉnh đề xuất/Bình luận mới/Xoá bình luận, vẫn hiện bình luận đã có; không POST', async () => {
    const { container, baseElement, queryByRole } = render(<DocRedlinePreview projectId={SNAP_ID} file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());
    expect(queryByRole('button', { name: 'Tự chỉnh' })).toBeNull();
    expect(queryByRole('button', { name: 'Sửa đoạn chọn' })).toBeNull();

    // Chọn annotation vẫn mở panel chi tiết (phần đọc giữ).
    fireEvent.click(container.querySelector('mark[data-change-id="agent-1"]')!);
    const dialog = await waitFor(() => {
      const el = baseElement.querySelector('[role="dialog"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const buttonTexts = Array.from(dialog.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(buttonTexts).not.toContain('Bỏ');
    expect(buttonTexts).not.toContain('Hoàn tác');
    expect(buttonTexts.some((t) => t?.includes('Chỉnh đề xuất'))).toBe(false);
    expect(buttonTexts).not.toContain('Gửi');
    expect(dialog.querySelector('textarea[aria-label="Bình luận mới"]')).toBeNull();
    expect(dialog.querySelector('button[aria-label="Xoá bình luận"]')).toBeNull();
    // Bình luận annotation đã có vẫn hiện.
    expect(dialog.textContent).toContain('Bình luận (1)');
    expect(dialog.textContent).toContain('Cần BA xác nhận lại.');
    expect(dialog.textContent).toContain('Dùng thuật ngữ trong tài liệu.');
    // Đóng panel vẫn được.
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Đóng')!);
    await waitFor(() => expect(baseElement.querySelector('[role="dialog"]')).toBeNull());
    expect(writeCalls()).toHaveLength(0);
  });

  it('đối chứng: projectId thường vẫn có "Tự chỉnh" và panel có Bỏ + "Bình luận mới"', async () => {
    const { container, baseElement, getByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());
    expect(getByRole('button', { name: 'Tự chỉnh' })).toBeTruthy();
    fireEvent.click(container.querySelector('mark[data-change-id="agent-1"]')!);
    const dialog = await waitFor(() => {
      const el = baseElement.querySelector('[role="dialog"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(Array.from(dialog.querySelectorAll('button')).some((b) => b.textContent === 'Bỏ')).toBe(true);
    expect(dialog.querySelector('textarea[aria-label="Bình luận mới"]')).not.toBeNull();
    expect(dialog.querySelector('button[aria-label="Xoá bình luận"]')).not.toBeNull();
  });
});
