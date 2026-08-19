// @vitest-environment jsdom
//
// Chip rule phải đọc được bởi người KHÔNG biết mã rule là gì: chip hiện nhãn
// tiếng Việt, rê chuột ra một câu tóm tắt, bấm vào mới hiện mã kỹ thuật đầy đủ
// kèm đoạn giải thích. Trước đây chip hiện thẳng `default#edge-case` — đúng mà
// vô nghĩa với người review tài liệu nghiệp vụ.
//
// Fixture tách khỏi doc-redline-preview.test.tsx vì file đó khoá tập id neo
// được của nó; ở đây cần cả một CHANGE lẫn một NOTE có rule_id để chứng minh
// một chỗ sửa (RuleChip) ăn cả hai loại thẻ.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

afterEach(() => cleanup());

const EDITED = [
  '# Quản lý khách hàng',
  '',
  'Người dùng nhập mã OTP gồm 6 chữ số.',
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

const CRITERIA = ['# Bộ tiêu chí', '', '## `R-OVERLAY` Khi nào dùng overlay', '', 'Modal chỉ dùng cho xác nhận một bước.', ''].join('\n');

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => {
    if (name.endsWith('.changes.json')) return CHANGES;
    if (name.endsWith('.notes.json')) return NOTES;
    if (name.endsWith('/criteria/rules.md')) return CRITERIA;
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

/** Chip rule của một thẻ, tìm theo class riêng của nút "?" (`ruleHelpBtn`) —
 *  KHÔNG còn dùng `button[aria-expanded]` chung chung: wp3b.yaml mục D thêm
 *  nút "Chi tiết ▾/▴" (cũng mang `aria-expanded`) vào mọi thẻ, nên selector cũ
 *  đếm lẫn cả nút đó. `ruleHelpBtn` chỉ nút "?" của RuleChip mới có. */
async function renderAndGetChips(): Promise<HTMLButtonElement[]> {
  const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
  await waitFor(() => {
    expect(container.querySelectorAll('[class*="ruleHelpBtn"]').length).toBe(2);
  });
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[class*="ruleHelpBtn"]'));
}

describe('chip rule — nhãn dễ hiểu, tooltip, popover chi tiết', () => {
  it('badge của rule mặc định hiện NHÃN chứ không hiện mã; nút "?" đứng cạnh mang tooltip một câu', async () => {
    const [helpBtn] = await renderAndGetChips();
    // Badge là span nhãn thuần đứng ngay trước nút "?" (phần bấm được duy nhất).
    const badge = helpBtn!.previousElementSibling as HTMLElement;

    expect(badge.textContent).toBe('Thiếu trường hợp biên');
    expect(badge.textContent).not.toContain('default#');
    expect(helpBtn!.textContent).toBe('?');
    expect(helpBtn!.getAttribute('title')).toBe('Chưa nói điều gì xảy ra khi thao tác không suôn sẻ.');
  });

  it('badge của rule dự án hiện phần sau dấu #, nút "?" mời bấm xem nội dung', async () => {
    const chips = await renderAndGetChips();
    // Thẻ thứ hai là NOTE — cùng một RuleChip, nên một chỗ sửa ăn cả hai loại.
    const noteHelpBtn = chips[1]!;
    const noteBadge = noteHelpBtn.previousElementSibling as HTMLElement;

    expect(noteBadge.textContent).toBe('R-OVERLAY');
    expect(noteHelpBtn.getAttribute('title')).toBe('Tiêu chí riêng của dự án — bấm để xem nội dung');
  });

  it('bấm chip mở popover có CẢ nhãn, mã kỹ thuật đầy đủ và đoạn giải thích', async () => {
    const [chip] = await renderAndGetChips();

    fireEvent.click(chip!);

    const pop = await waitFor(() => {
      const el = chip!.parentElement?.querySelector('[role="note"]');
      expect(el, 'popover phải mở').not.toBeNull();
      return el as HTMLElement;
    });
    expect(chip!.getAttribute('aria-expanded')).toBe('true');
    expect(pop.textContent).toContain('Thiếu trường hợp biên');
    // Mã kỹ thuật vẫn còn — đó là đường trace ngược về criteria.
    expect(pop.textContent).toContain('default#edge-case');
    // Giải thích viết theo giọng người thường, không còn "state lỗi/validation".
    expect(pop.textContent).toContain('gặp lỗi thì hiện gì');
    expect(pop.textContent).not.toContain('validation');

    // Bấm lại là đóng (giữ nguyên hành vi toggle cũ).
    fireEvent.click(chip!);
    await waitFor(() => {
      expect(chip!.parentElement?.querySelector('[role="note"]')).toBeNull();
    });
  });

  it('popover của rule dự án hiện mã đầy đủ và trích đoạn từ file criteria', async () => {
    const chips = await renderAndGetChips();
    const noteChip = chips[1]!;

    fireEvent.click(noteChip);

    await waitFor(() => {
      const pop = noteChip.parentElement?.querySelector('[role="note"]');
      expect(pop?.textContent).toContain('criteria/rules.md#R-OVERLAY');
      expect(pop?.textContent).toContain('Modal chỉ dùng cho xác nhận một bước.');
    });
  });
});
