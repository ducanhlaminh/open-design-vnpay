// @vitest-environment jsdom
//
// Ba phép sửa phải TRÔNG KHÁC NHAU. Test này tách khỏi
// doc-redline-preview.test.tsx (fixture ở đó khoá tập id neo được của luồng
// "sửa" cũ) và chỉ đo một thứ: thêm bôi xanh, sửa bôi vàng, xoá hiện lại được
// trong tài liệu (highlight TẠI CHỖ trên `before` — không còn tái tạo bằng
// injectDeletedRuns), và modal chi tiết của một chỗ SỬA chỉ tô chữ THẬT SỰ
// đổi thay vì hai khối nguyên văn.
//
// Mount thật dưới React, cùng lý do đã ghi trong doc-redline-preview.test.tsx:
// các phép đo thuần không thấy được vòng đời React.
//
// wp-doc-redline-nondestructive: tài liệu hiển thị KHÔNG BAO GIỜ bị sửa, nên
// mọi `before`/`anchor` dưới đây phải là chữ CÒN NGUYÊN trong DOC được phục vụ
// — khác bản cũ (từng phục vụ "bản đã sửa" chứa `quote`).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

const DELETED_TEXT = 'Ô nhập mã giới thiệu (không còn dùng).';
const DEL_ANCHOR = 'Bảng danh sách khách hàng hỗ trợ tìm kiếm theo mã.';
const ADD_ANCHOR = 'Điểm neo cho phần thêm mới.';
/** Cặp đoạn vượt trần bảng DP của wordDiff (450 × 450 ô > 200_000) — modal của
 *  nó phải rơi về layout hai khối before/quote cũ. */
const BIG_BEFORE = Array.from({ length: 450 }, (_, i) => `từ${i}`).join(' ');
const BIG_AFTER = Array.from({ length: 450 }, (_, i) => `chữ${i}`).join(' ');

const DOC = [
  '# Quản lý khách hàng',
  '',
  'Người dùng nhập OTP.',
  '',
  ADD_ANCHOR,
  '',
  DELETED_TEXT,
  '',
  DEL_ANCHOR,
  '',
  // d2 cố ý KHÔNG có mặt trong tài liệu — mô phỏng ca "before không còn khớp".
  BIG_BEFORE,
  '',
].join('\n');

const CHANGES = JSON.stringify([
  // SỬA: có cả before và quote — before còn nguyên trong DOC.
  {
    id: 'e1',
    kind: 'ux-writing',
    severity: 'minor',
    before: 'Người dùng nhập OTP.',
    quote: 'Người dùng nhập mã OTP gồm 6 chữ số.',
    reason: 'Nêu rõ định dạng OTP để người đọc không phải đoán.',
    doc_refs: ['URD §3.2', 42],
  },
  // THÊM: neo trên `anchor` (điểm chèn, chữ gốc) — `quote` chỉ là đề xuất.
  {
    id: 'a1',
    kind: 'gap',
    severity: 'major',
    anchor: ADD_ANCHOR,
    quote: 'Hệ thống gửi thông báo cho quản trị viên.',
    reason: 'Luồng thiếu bước thông báo cho quản trị viên.',
  },
  // XOÁ: `before` còn nguyên trong DOC — highlight tại chỗ, không tái tạo.
  {
    id: 'd1',
    kind: 'flow',
    severity: 'blocker',
    before: DELETED_TEXT,
    reason: 'Trường này không còn trong nghiệp vụ hiện tại.',
  },
  // XOÁ không neo được: `before` không khớp gì trong DOC (dữ liệu lệch).
  {
    id: 'd2',
    kind: 'edge-case',
    severity: 'minor',
    before: 'Nút Xoá vĩnh viễn đã được bỏ khỏi màn hình.',
    reason: 'Hành động không thể hoàn tác, cần xác nhận hai bước.',
  },
  // SỬA quá lớn để diff: modal rơi về hai khối nguyên văn.
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
    return DOC;
  },
  projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
}));
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { DocRedlinePreview } = await import('../../src/components/DocRedlinePreview');

const FILE = {
  name: 'docs-review/review/docs/confluence/urd.md',
  kind: 'text',
  size: DOC.length,
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

/** Bấm vùng bôi của `id` rồi trả về modal chi tiết đang mở (hoặc ném lỗi nếu
 *  không mở được — thay cho "Chi tiết ▾" của rail cũ). */
function openDetail(container: HTMLElement, id: string): HTMLElement {
  fireEvent.click(markOf(container, id));
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error(`không mở được modal chi tiết của ${id}`);
  return dialog;
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

  it('chỗ XOÁ hiện lại trong tài liệu, gạch ngang, đúng đoạn đã có sẵn', async () => {
    const container = await renderRedline();

    const del = markOf(container, 'd1');
    // Không còn `data-op="del"`/`<del>` lồng bên trong (đó là dấu của
    // injectDeletedRuns, đã bỏ) — gạch ngang giờ nằm ngay trong style/class
    // của chính <mark>, và chữ bên trong CHÍNH LÀ đoạn gốc, không phải bản
    // dựng lại.
    expect(del.dataset.op).toBeUndefined();
    expect(del.querySelector('del')).toBeNull();
    expect(del.getAttribute('style')).toContain('239,68,68'); // red
    expect(del.getAttribute('style')).toContain('line-through');
    expect(del.textContent).toBe(DELETED_TEXT);
    expect(container.querySelectorAll('mark[data-change-id="d1"]').length).toBe(1);
  });

  it('chỗ xoá CÓ before khớp mở được modal; chỗ xoá before KHÔNG khớp thì không có mark nào', async () => {
    const container = await renderRedline();

    // Neo được ⇒ bấm mở được modal.
    const dialog = openDetail(container, 'd1');
    expect(dialog.textContent).toContain('Trường này không còn trong nghiệp vụ hiện tại.');

    // before không khớp gì trong DOC ⇒ không có <mark> nào để bấm.
    expect(container.querySelector('mark[data-change-id="d2"]')).toBeNull();
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

  it('modal chi tiết của chỗ SỬA chỉ tô chữ thật sự đổi, không còn hai khối nguyên văn', async () => {
    const container = await renderRedline();

    const dialog = openDetail(container, 'e1');
    const del = dialog.querySelector('[class*="runDel"]');
    const add = dialog.querySelector('[class*="runAdd"]');
    expect(del?.textContent).toBe('OTP.');
    expect(add?.textContent).toBe('mã OTP gồm 6 chữ số.');
    // Phần không đổi vẫn đọc được nguyên câu, chỉ không bị tô.
    expect((dialog.textContent ?? '').replace(/\s+/g, ' ')).toContain(
      'Người dùng nhập OTP. mã OTP gồm 6 chữ số.',
    );
    // Không rơi về layout hai khối "Nguyên bản"/"Đề xuất" khi diff được.
    const labels = Array.from(dialog.querySelectorAll('[class*="detailLabel"]')).map((el) => el.textContent);
    expect(labels).not.toContain('Nguyên bản');
    expect(labels).not.toContain('Đề xuất');
  });

  it('modal chi tiết của chỗ THÊM hiện đúng nội dung đề xuất, chỗ XOÁ hiện đúng đoạn đề xuất bỏ', async () => {
    const container = await renderRedline();

    const addDialog = openDetail(container, 'a1');
    expect(addDialog.textContent).toContain('Hệ thống gửi thông báo cho quản trị viên.');

    const delDialog = openDetail(container, 'd1');
    expect(delDialog.textContent).toContain(DELETED_TEXT);
  });

  it('cặp đoạn quá lớn để diff rơi về layout hai khối cũ thay vì mất chữ', async () => {
    const container = await renderRedline();

    const dialog = openDetail(container, 'e2');
    expect(dialog.querySelector('[class*="runDel"]')).toBeNull();
    expect(dialog.textContent).toContain(BIG_BEFORE);
    expect(dialog.textContent).toContain(BIG_AFTER);
  });

  it('parse khoan dung `doc_refs`: phần tử không phải chuỗi bị bỏ, không đánh hỏng modal', async () => {
    const container = await renderRedline();
    // doc_refs chưa được render trong modal; điều phải giữ là một mảng lẫn số
    // không làm mất chỗ sửa nào — mọi mark neo được vẫn mở modal bình thường.
    const dialog = openDetail(container, 'e1');
    expect(dialog.textContent).toContain('Nêu rõ định dạng OTP');
    expect(container.querySelectorAll('mark[data-change-id]').length).toBe(4);
  });
});
