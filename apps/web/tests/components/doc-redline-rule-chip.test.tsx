// @vitest-environment jsdom
//
// wp-doc-redline-nondestructive: RuleChip (badge nhãn dễ hiểu + nút "?" +
// popover với mã kỹ thuật/giải thích/trích đoạn criteria) đã GỠ BỎ CÓ CHỦ Ý
// cùng đợt bỏ rail — nó sống trong khối "Chi tiết ▾" của thẻ rail, và rail đã
// bỏ hẳn (xem docblock đầu DocRedlinePreview.tsx). `rule_id` giờ chỉ hiện như
// MỘT CHUỖI THUẦN ở đầu `AnnotationDetailPanel` (không nhãn dịch, không
// tooltip, không popover, không fetch nội dung criteria/rules.md) — không có
// đường thay thế non-destructive nào được yêu cầu cho phần "dịch nhãn/giải
// thích" của tính năng cũ, nên toàn bộ 5 test gốc của file này (đo popover,
// badge nhãn dịch, tooltip, và cả NoteDetail "Chi tiết ▾" — cũng là rail) đã
// XOÁ, thay bằng một bài kiểm tối giản: rule_id của cả change lẫn note vẫn
// hiện được (dạng chuỗi thô) trong modal chi tiết của chúng.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

afterEach(() => cleanup());

const EDITED = [
  '# Quản lý khách hàng',
  '',
  'Người dùng nhập OTP.',
  '',
  'Màn hình hiện popup xác nhận xoá.',
  '',
].join('\n');

const CHANGES = JSON.stringify([
  {
    id: 'c1',
    kind: 'edge-case',
    severity: 'major',
    rule_id: 'default#edge-case',
    before: 'Người dùng nhập OTP.',
    quote: 'Người dùng nhập mã OTP gồm 6 chữ số.',
    reason: 'Chưa nêu điều gì xảy ra khi nhập sai.',
  },
]);

const NOTES = JSON.stringify([
  {
    id: 'n1',
    kind: 'component',
    severity: 'blocker',
    rule_id: 'criteria/rules.md#R-OVERLAY',
    anchor: 'Màn hình hiện popup xác nhận xoá.',
    finding: 'Popup này có form nhiều bước.',
    suggestion: 'Đổi sang drawer.',
  },
]);

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => {
    if (name.endsWith('.changes.json')) return CHANGES;
    if (name.endsWith('.notes.json')) return NOTES;
    return EDITED;
  },
  projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
}));

vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { DocRedlinePreview } = await import('../../src/components/DocRedlinePreview');

const FILE = {
  name: 'docs-review/review/docs/confluence/urd.md',
  kind: 'text',
  size: EDITED.length,
  mtime: 1,
} as never;

// jsdom không cài scrollIntoView (xem chú thích trong doc-redline-preview.test.tsx).
beforeAll(() => {
  Element.prototype.scrollIntoView = function noop() {};
});

describe('rule_id trong modal chi tiết — chuỗi thuần, không còn RuleChip/popover', () => {
  it('modal của một CHANGE hiện rule_id nguyên văn ở đầu modal', async () => {
    const { container, baseElement } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="c1"]')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('mark[data-change-id="c1"]')!);

    const dialog = await waitFor(() => {
      const el = baseElement.querySelector('[role="dialog"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(dialog.textContent).toContain('default#edge-case');
    // Không còn popover ("?" + [role="note"]) hay badge nhãn dịch riêng.
    expect(dialog.querySelector('[role="note"]')).toBeNull();
    expect(dialog.querySelector('button[title]')).toBeNull();
  });

  it('modal của một NOTE hiện rule_id nguyên văn', async () => {
    const { container, baseElement } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    const notesTab = await waitFor(() => {
      const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Nhận xét'));
      expect(btn, 'phải có nút chuyển tab "Nhận xét"').toBeTruthy();
      return btn as HTMLButtonElement;
    });
    fireEvent.click(notesTab);
    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="note:n1"]')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('mark[data-change-id="note:n1"]')!);

    const dialog = await waitFor(() => {
      const el = baseElement.querySelector('[role="dialog"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(dialog.textContent).toContain('criteria/rules.md#R-OVERLAY');
    expect(dialog.textContent).toContain('Popup này có form nhiều bước.');
    expect(dialog.textContent).toContain('Đổi sang drawer.');
  });
});
