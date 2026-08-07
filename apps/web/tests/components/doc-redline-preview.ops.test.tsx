// @vitest-environment jsdom
//
// Ba phép sửa phải TRÔNG KHÁC NHAU. Test này tách khỏi
// doc-redline-preview.test.tsx (fixture ở đó khoá tập id neo được của luồng
// "sửa" cũ) và chỉ đo một thứ: thêm bôi xanh, sửa bôi vàng, xoá hiện lại được
// trong tài liệu nhờ `anchor`, và thẻ lý do của một chỗ viết lại chỉ tô chữ
// THẬT SỰ đổi thay vì hai khối nguyên văn.
//
// Mount thật dưới React, cùng lý do đã ghi trong doc-redline-preview.test.tsx:
// các phép đo thuần không thấy được vòng đời React.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const EDITED = [
  '# Quản lý khách hàng',
  '',
  'Người dùng nhập mã OTP gồm 6 chữ số.',
  '',
  'Hệ thống gửi thông báo cho quản trị viên.',
  '',
  'Bảng danh sách khách hàng hỗ trợ tìm kiếm theo mã.',
  '',
].join('\n');

const DELETED_TEXT = 'Ô nhập mã giới thiệu (không còn dùng).';
const DEL_ANCHOR = 'Bảng danh sách khách hàng hỗ trợ tìm kiếm theo mã.';
/** Cặp đoạn vượt trần bảng DP của wordDiff (450 × 450 ô > 200_000) — thẻ của nó
 *  phải rơi về layout hai khối `before → quote` cũ. */
const BIG_BEFORE = Array.from({ length: 450 }, (_, i) => `từ${i}`).join(' ');
const BIG_AFTER = Array.from({ length: 450 }, (_, i) => `chữ${i}`).join(' ');

const CHANGES = JSON.stringify([
  // SỬA: có cả before và quote.
  {
    id: 'e1',
    kind: 'ux-writing',
    severity: 'minor',
    before: 'Người dùng nhập OTP.',
    quote: 'Người dùng nhập mã OTP gồm 6 chữ số.',
    reason: 'Nêu rõ định dạng OTP để người đọc không phải đoán.',
    doc_refs: ['URD §3.2', 42],
  },
  // THÊM: chỉ có quote.
  {
    id: 'a1',
    kind: 'gap',
    severity: 'major',
    quote: 'Hệ thống gửi thông báo cho quản trị viên.',
    reason: 'Luồng thiếu bước thông báo cho quản trị viên.',
  },
  // XOÁ có neo: chỉ có before, kèm `anchor` là đoạn còn sống cạnh chỗ xoá.
  {
    id: 'd1',
    kind: 'flow',
    severity: 'blocker',
    before: DELETED_TEXT,
    anchor: DEL_ANCHOR,
    reason: 'Trường này không còn trong nghiệp vụ hiện tại.',
  },
  // XOÁ không neo (dữ liệu từ trước khi có field `anchor`): thẻ chết như cũ.
  {
    id: 'd2',
    kind: 'edge-case',
    severity: 'minor',
    before: 'Nút Xoá vĩnh viễn đã được bỏ khỏi màn hình.',
    reason: 'Hành động không thể hoàn tác, cần xác nhận hai bước.',
  },
  // SỬA quá lớn để diff: rơi về hai khối nguyên văn.
  {
    id: 'e2',
    kind: 'gap',
    severity: 'minor',
    before: BIG_BEFORE,
    quote: BIG_AFTER,
    reason: 'Viết lại toàn bộ mục.',
  },
]);

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => {
    if (name.endsWith('.changes.json')) return CHANGES;
    if (name.endsWith('.notes.json')) return null;
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

// jsdom không cài `scrollIntoView`; component gọi nó khi chọn một chỗ sửa.
beforeAll(() => {
  Element.prototype.scrollIntoView = function noop() {};
});

async function renderRedline(): Promise<HTMLElement> {
  const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
  await waitFor(() => {
    expect(container.querySelectorAll('mark[data-change-id]').length).toBeGreaterThan(0);
  });
  return container;
}

function markOf(container: HTMLElement, id: string): HTMLElement {
  const mark = container.querySelector<HTMLElement>(`mark[data-change-id="${id}"]`);
  if (!mark) throw new Error(`không tìm thấy mark của ${id}`);
  return mark;
}
function itemOf(container: HTMLElement, id: string): HTMLElement {
  const item = container.querySelector<HTMLElement>(`[data-change-item="${id}"]`);
  if (!item) throw new Error(`không tìm thấy mục danh sách của ${id}`);
  return item;
}

describe('DocRedlinePreview — ba màu theo phép sửa', () => {
  it('chỗ SỬA bôi vàng, chỗ THÊM bôi xanh — hai loại không được trông giống nhau', async () => {
    const container = await renderRedline();

    const edit = markOf(container, 'e1');
    const add = markOf(container, 'a1');
    // Màu nằm trong style nội tuyến (không phụ thuộc CSS Module có tới nơi hay
    // không), nên đo ở đó mới là đo thứ người dùng thấy.
    expect(edit.getAttribute('style')).toContain('245,158,11'); // amber
    expect(add.getAttribute('style')).toContain('34,197,94'); // green
    expect(add.getAttribute('style')).not.toContain('245,158,11');
    // Class cũng phải khác nhau, để .hlActive/.hlFlash và legend khớp đúng loại.
    expect(add.className).toMatch(/hlAdd/);
    expect(edit.className).not.toMatch(/hlAdd/);
  });

  it('chỗ XOÁ hiện lại trong tài liệu, gạch ngang, ngay sau đoạn neo', async () => {
    const container = await renderRedline();

    const del = markOf(container, 'd1');
    expect(del.dataset.op).toBe('del');
    expect(del.getAttribute('style')).toContain('239,68,68'); // red
    // Chữ đã xoá nằm trong <del>, đó là thứ nói "đoạn này đã bị bỏ".
    const inner = del.querySelector('del');
    expect(inner).not.toBeNull();
    expect(inner!.textContent).toBe(DELETED_TEXT);
    // Neo ĐÚNG chỗ: node nằm ngay sau đoạn văn chứa anchor, không rơi lên đầu
    // tài liệu.
    const paragraph = del.closest('p');
    expect(paragraph?.textContent ?? '').toContain(DEL_ANCHOR);
    // Đoạn neo KHÔNG bị bôi — nó là chữ của bản đã sửa, không bị sửa gì.
    expect(container.querySelectorAll('mark[data-change-id="d1"]').length).toBe(1);
  });

  it('chỗ xoá CÓ anchor nhảy tới được; chỗ xoá KHÔNG anchor vẫn là thẻ chết', async () => {
    const container = await renderRedline();

    // Neo được ⇒ <button> thật (bàn phím + trình đọc màn hình cần một control).
    expect(itemOf(container, 'd1').tagName.toLowerCase()).toBe('button');
    // Không có anchor ⇒ không có gì để neo vào, giữ hành vi cũ.
    const dead = itemOf(container, 'd2');
    expect(dead.tagName.toLowerCase()).not.toBe('button');
    expect(dead.textContent).toContain('Không tìm thấy trong tài liệu');
  });

  it('dải trạng thái đếm theo phép sửa và có đủ bốn mục chú giải', async () => {
    const container = await renderRedline();

    const strip = container.querySelector('[class*="strip"]');
    const text = (strip?.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('2 sửa · 1 thêm · 2 xoá · 0 nhận xét');
    for (const label of ['Thêm', 'Sửa', 'Xoá', 'Cần bàn']) {
      expect(text).toContain(label);
    }
    expect(container.querySelectorAll('[class*="legendSwatch"]').length).toBe(4);
  });

  it('thẻ lý do của chỗ SỬA chỉ tô chữ thật sự đổi, không còn hai khối nguyên văn', async () => {
    const container = await renderRedline();

    const card = itemOf(container, 'e1');
    const del = card.querySelector('[class*="runDel"]');
    const add = card.querySelector('[class*="runAdd"]');
    expect(del?.textContent).toBe('OTP.');
    expect(add?.textContent).toBe('mã OTP gồm 6 chữ số.');
    // Phần không đổi vẫn đọc được nguyên câu, chỉ không bị tô.
    expect((card.textContent ?? '').replace(/\s+/g, ' ')).toContain(
      'Người dùng nhập OTP. mã OTP gồm 6 chữ số.',
    );
    // Không rơi về layout hai khối khi diff được.
    expect(card.querySelector('[class*="diffBefore"]')).toBeNull();
  });

  it('thẻ của chỗ THÊM và chỗ XOÁ mang nhãn tương ứng', async () => {
    const container = await renderRedline();

    const addCard = itemOf(container, 'a1');
    expect(addCard.querySelector('[class*="blockAdd"]')?.textContent).toBe(
      'Hệ thống gửi thông báo cho quản trị viên.',
    );
    expect(addCard.textContent).toContain('Đã thêm');

    const delCard = itemOf(container, 'd1');
    expect(delCard.querySelector('[class*="blockDel"]')?.textContent).toBe(DELETED_TEXT);
    expect(delCard.textContent).toContain('Đã xoá');
  });

  it('cặp đoạn quá lớn để diff rơi về layout hai khối cũ thay vì mất chữ', async () => {
    const container = await renderRedline();

    const card = itemOf(container, 'e2');
    expect(card.querySelector('[class*="runDel"]')).toBeNull();
    expect(card.querySelector('[class*="diffBefore"]')?.textContent).toBe(BIG_BEFORE);
    expect(card.querySelector('[class*="diffAfter"]')?.textContent).toBe(BIG_AFTER);
  });

  it('parse khoan dung `doc_refs`: phần tử không phải chuỗi bị bỏ, không đánh hỏng thẻ', async () => {
    const container = await renderRedline();
    // doc_refs chưa được render trong task này; điều phải giữ là một mảng lẫn
    // số không làm mất chỗ sửa nào.
    expect(container.textContent).toContain('Nêu rõ định dạng OTP');
    expect(container.querySelectorAll('[data-change-item]').length).toBe(5);
  });
});
