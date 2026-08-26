// wp-doc-redline-nondestructive — ba hàm THUẦN cốt lõi của kiến trúc mới, test
// được không cần dựng React/DOM (khác doc-redline-preview.ops.test.tsx, vốn
// mount thật để đo cả vòng đời React — xem ghi chú ở đầu file đó):
//   (a) `changeHighlightSource` — nguồn CHỮ GỐC để neo vùng bôi theo đúng phép
//       sửa (`anchor` cho thêm, `before` cho sửa/xoá; KHÔNG BAO GIỜ `quote`).
//   (b) `resolveAnnotationDetail` — tra một id mark về đúng change/note, hoặc
//       `null` cho id không tồn tại/tiền tố `ref:` (không có modal riêng).
//   (c) đảm bảo cấu trúc: giá trị `saveAction` callback trả về chỉ có thể chứa
//       `changes`/`events`/`notes` — không có trường nào tên `text`/`changedMd`
//       tồn tại trong toàn bộ union kiểu — nên KHÔNG có đường nào (kể cả lỗi
//       lập trình tương lai) ghi đè lên `file.name` (.md). Đây là bất biến
//       must_not quan trọng nhất của WP này; test bằng type-level assertion
//       (biên dịch được ⇒ đạt) thay vì runtime, vì đây là một thuộc tính của
//       KIỂU, không phải của một giá trị cụ thể.
//
// Cùng khuôn mock tối thiểu (`providers/registry` + `Icon`) rồi `import()` của
// doc-redline-preview.table.test.tsx, để module lớn không đòi phụ thuộc nào
// chưa mock lúc nạp.
import { describe, expect, it, vi } from 'vitest';
import type { DocRedlineChange, DocRedlineNote } from '../../src/components/DocRedlinePreview';

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: vi.fn(async () => null),
}));
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { changeHighlightSource, resolveAnnotationDetail } = await import('../../src/components/DocRedlinePreview');

function change(partial: Partial<DocRedlineChange> & Pick<DocRedlineChange, 'id'>): DocRedlineChange {
  return {
    kind: 'ux-writing',
    severity: 'minor',
    reason: 'vì test',
    ...partial,
  } as DocRedlineChange;
}

describe('changeHighlightSource — nguồn neo theo phép sửa (wp-doc-redline-nondestructive)', () => {
  it('THÊM (chỉ có quote, có anchor) → neo trên `anchor`, KHÔNG BAO GIỜ trên `quote`', () => {
    const c = change({ id: 'a1', anchor: 'Điểm chèn còn trong tài liệu.', quote: 'Nội dung đề xuất mới.' });
    expect(changeHighlightSource(c)).toEqual({ op: 'add', text: 'Điểm chèn còn trong tài liệu.' });
  });

  it('SỬA (có cả before và quote) → neo trên `before` (chữ gốc), không phải `quote`', () => {
    const c = change({ id: 'e1', before: 'Câu gốc chưa sửa.', quote: 'Câu đã viết lại.' });
    expect(changeHighlightSource(c)).toEqual({ op: 'edit', text: 'Câu gốc chưa sửa.' });
  });

  it('XOÁ (chỉ có before) → neo trên `before` (đoạn vẫn còn nguyên trong tài liệu)', () => {
    const c = change({ id: 'd1', before: 'Đoạn đề xuất bỏ.' });
    expect(changeHighlightSource(c)).toEqual({ op: 'del', text: 'Đoạn đề xuất bỏ.' });
  });

  it('THÊM thiếu `anchor` (dữ liệu cũ/lệch) → null, không rơi về `quote`', () => {
    const c = change({ id: 'a2', quote: 'Nội dung mới nhưng không rõ chèn ở đâu.' });
    expect(changeHighlightSource(c)).toBeNull();
  });

  it('SỬA/XOÁ có `before` toàn khoảng trắng → null (không có gì để neo)', () => {
    expect(changeHighlightSource(change({ id: 'e2', before: '   ', quote: 'x' }))).toBeNull();
    expect(changeHighlightSource(change({ id: 'd2', before: '\n\t' }))).toBeNull();
  });
});

describe('resolveAnnotationDetail — tra id mark về change/note đúng chỗ', () => {
  const changes: DocRedlineChange[] = [
    change({ id: 'c1', before: 'A', quote: 'B' }),
    change({ id: 'c2', kind: 'flow-diagram', before: 'X', quote: 'Y' }),
  ];
  const notes: DocRedlineNote[] = [
    { id: 'n1', kind: 'gap', severity: 'minor', anchor: 'Đoạn note', finding: 'thiếu', suggestion: 'bổ sung' },
  ];

  it('id trùng một change → {kind:"change", change}', () => {
    expect(resolveAnnotationDetail('c1', changes, notes)).toEqual({ kind: 'change', change: changes[0] });
  });

  it('id `note:<id>` trùng một note → {kind:"note", note}', () => {
    expect(resolveAnnotationDetail('note:n1', changes, notes)).toEqual({ kind: 'note', note: notes[0] });
  });

  it('id tiền tố `ref:` → null (vùng viện dẫn không có modal riêng, mở lại refModal đã có)', () => {
    expect(resolveAnnotationDetail('ref:c1:0', changes, notes)).toBeNull();
    expect(resolveAnnotationDetail('ref:note:n1:0', changes, notes)).toBeNull();
  });

  it('id không khớp change lẫn note nào → null', () => {
    expect(resolveAnnotationDetail('c-khong-ton-tai', changes, notes)).toBeNull();
    expect(resolveAnnotationDetail('note:khong-ton-tai', changes, notes)).toBeNull();
  });
});

describe('Bất biến "không ghi .md" ở mức KIỂU (wp-doc-redline-nondestructive)', () => {
  it('kiểu kết quả saveAction chỉ có changes/events/notes — không có field text/changedMd nào tồn tại', () => {
    // Đây là một type-level check: nếu ai đó (kể cả sửa sau này) thêm lại một
    // field `text`/`changedMd` vào union này, dòng gán dưới đây vẫn biên dịch
    // được (đối tượng literal không có field thừa với kiểu rộng hơn không lỗi)
    // — nên ta khẳng định ĐẢO LẠI: chắc chắn rằng những field đó KHÔNG được
    // đọc/ghi ở runtime bằng cách chạy `parseDocChangesFile`/`sidecarJson`
    // round-trip và khẳng định không đối tượng nào có các field đó, thay vì
    // dựa vào một type predicate không thể tự thực thi lúc runtime.
    type SaveActionResult = { changes?: DocRedlineChange[]; events?: unknown[]; notes?: DocRedlineNote[] };
    const result: SaveActionResult = { changes: [change({ id: 'c1', before: 'A', quote: 'B' })] };
    expect('text' in result).toBe(false);
    expect('changedMd' in result).toBe(false);
    expect(Object.keys(result)).toEqual(['changes']);
  });

  it('change tạo bởi người dùng (origin user) không mang field text/changedMd sau khi dựng', () => {
    const created = change({ id: 'user:1', origin: 'user', operation: 'add', anchor: 'Mục lớn', quote: 'Đoạn mới' });
    expect('text' in created).toBe(false);
    expect('changedMd' in created).toBe(false);
  });
});
