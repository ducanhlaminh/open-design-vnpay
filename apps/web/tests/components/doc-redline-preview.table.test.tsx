// @vitest-environment jsdom
//
// wp-table-highlight.yaml — hai phần THUẦN của tính năng "kéo bôi ô trong
// bảng" test được không cần dựng <table> thật trong jsdom (Range.intersectsNode
// phụ thuộc DOM layout mà jsdom không có, xem ghi chú cuối file):
//   (a) `parseDocNotes` giữ/khước từ `tableCells` đúng hình dạng khi round-trip
//       qua JSON (viết bởi `createTableCellAnnotation`, đọc lại lúc reload).
//   (b) `pickUniqueTableAnchorLine` chọn dòng mã nguồn DUY NHẤT đầu tiên trong
//       danh sách ứng viên (thứ tự ưu tiên: ô đã chọn trước, header sau — xem
//       `startTableCellHighlight`).
// Dùng khuôn mock tối thiểu (`providers/registry` + `Icon`) rồi `import()` như
// doc-redline-preview.test.tsx, để module 8000 dòng không đòi hỏi phụ thuộc
// nào chưa mock lúc nạp.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: vi.fn(async () => null),
}));
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { parseDocNotes, pickUniqueTableAnchorLine } = await import('../../src/components/DocRedlinePreview');

describe('parseDocNotes — tableCells round-trip (wp-table-highlight.yaml Q2)', () => {
  it('giữ tableCells hợp lệ nguyên vẹn', () => {
    const raw = JSON.stringify([
      {
        id: 'n1',
        kind: 'component',
        severity: 'minor',
        anchor: '| 1 | Ô nhập số điện thoại | Input | text |',
        tableCells: { cells: [{ row: 2, col: 1 }, { row: 2, col: 2 }] },
        finding: 'Component không khớp DS.',
        suggestion: '',
      },
    ]);
    const notes = parseDocNotes(raw);
    expect(notes).not.toBeNull();
    expect(notes![0]!.tableCells).toEqual({ cells: [{ row: 2, col: 1 }, { row: 2, col: 2 }] });
  });

  it('round-trip qua JSON.stringify (như saveAction ghi ra notes.json) không mất tableCells', () => {
    const original = parseDocNotes(JSON.stringify([
      {
        id: 'n1',
        kind: 'component',
        severity: 'minor',
        anchor: '| 1 | Ô nhập số điện thoại | Input | text |',
        tableCells: { cells: [{ row: 3, col: 0 }] },
        finding: 'Ghi chú ô bảng.',
        suggestion: '',
      },
    ]))!;
    const rewritten = parseDocNotes(JSON.stringify(original))!;
    expect(rewritten[0]!.tableCells).toEqual({ cells: [{ row: 3, col: 0 }] });
  });

  it('bỏ field khi cells không phải mảng — note vẫn giữ', () => {
    const raw = JSON.stringify([
      { id: 'n1', kind: 'component', severity: 'minor', anchor: 'x', tableCells: { cells: 'not-an-array' }, finding: 'ghi chú', suggestion: '' },
    ]);
    const notes = parseDocNotes(raw);
    expect(notes).not.toBeNull();
    expect(notes![0]!.tableCells).toBeUndefined();
    expect(notes![0]!.finding).toBe('ghi chú');
  });

  it('bỏ field khi cells rỗng', () => {
    const raw = JSON.stringify([
      { id: 'n1', kind: 'component', severity: 'minor', anchor: 'x', tableCells: { cells: [] }, finding: 'ghi chú', suggestion: '' },
    ]);
    const notes = parseDocNotes(raw);
    expect(notes![0]!.tableCells).toBeUndefined();
  });

  it('bỏ field khi một phần tử thiếu col', () => {
    const raw = JSON.stringify([
      { id: 'n1', kind: 'component', severity: 'minor', anchor: 'x', tableCells: { cells: [{ row: 0, col: 0 }, { row: 1 }] }, finding: 'ghi chú', suggestion: '' },
    ]);
    const notes = parseDocNotes(raw);
    expect(notes![0]!.tableCells).toBeUndefined();
  });

  it('bỏ field khi row âm', () => {
    const raw = JSON.stringify([
      { id: 'n1', kind: 'component', severity: 'minor', anchor: 'x', tableCells: { cells: [{ row: -1, col: 0 }] }, finding: 'ghi chú', suggestion: '' },
    ]);
    const notes = parseDocNotes(raw);
    expect(notes![0]!.tableCells).toBeUndefined();
  });

  it('bỏ field khi row không phải số nguyên', () => {
    const raw = JSON.stringify([
      { id: 'n1', kind: 'component', severity: 'minor', anchor: 'x', tableCells: { cells: [{ row: 1.5, col: 0 }] }, finding: 'ghi chú', suggestion: '' },
    ]);
    const notes = parseDocNotes(raw);
    expect(notes![0]!.tableCells).toBeUndefined();
  });

  it('note không có tableCells vẫn parse bình thường (đường cũ không đổi)', () => {
    const raw = JSON.stringify([
      { id: 'n1', kind: 'gap', severity: 'minor', anchor: 'Người dùng nhập OTP.', finding: 'Thiếu mô tả trường hợp lỗi.', suggestion: '' },
    ]);
    const notes = parseDocNotes(raw);
    expect(notes).not.toBeNull();
    expect(notes![0]!.tableCells).toBeUndefined();
    expect(notes![0]!.finding).toBe('Thiếu mô tả trường hợp lỗi.');
  });
});

describe('pickUniqueTableAnchorLine (wp-table-highlight.yaml Q2)', () => {
  const SOURCE = [
    '# Bảng thành phần',
    '',
    '| # | Thành phần | Component DS |',
    '| --- | --- | --- |',
    '| 1 | Ô nhập số điện thoại | Input |',
    '| 2 | Nút Đăng nhập | Button |',
    '',
  ].join('\n');

  it('trả dòng ĐẦU TIÊN trong candidates xuất hiện duy nhất trong source', () => {
    const line = pickUniqueTableAnchorLine(SOURCE, [
      '| 1 | Ô nhập số điện thoại | Input |',
      '| # | Thành phần | Component DS |',
    ]);
    expect(line).toBe('| 1 | Ô nhập số điện thoại | Input |');
  });

  it('bỏ qua ứng viên KHÔNG có trong source, thử ứng viên kế tiếp', () => {
    const line = pickUniqueTableAnchorLine(SOURCE, [
      '| 9 | Không tồn tại | X |',
      '| 2 | Nút Đăng nhập | Button |',
    ]);
    expect(line).toBe('| 2 | Nút Đăng nhập | Button |');
  });

  it('trả null khi ứng viên xuất hiện NHIỀU LẦN trong source (không định vị được)', () => {
    const dup = `${SOURCE}\n| 1 | Ô nhập số điện thoại | Input |\n`;
    const line = pickUniqueTableAnchorLine(dup, ['| 1 | Ô nhập số điện thoại | Input |']);
    expect(line).toBeNull();
  });

  it('trả null khi không ứng viên nào khớp', () => {
    const line = pickUniqueTableAnchorLine(SOURCE, ['| không | có | dòng | này |']);
    expect(line).toBeNull();
  });

  it('bỏ qua chuỗi rỗng trong danh sách ứng viên', () => {
    const line = pickUniqueTableAnchorLine(SOURCE, ['', '| 2 | Nút Đăng nhập | Button |']);
    expect(line).toBe('| 2 | Nút Đăng nhập | Button |');
  });
});

// Không có test thu {row,col} từ một <table> jsdom + Range.intersectsNode
// thật: jsdom không dựng layout (getBoundingClientRect luôn 0), và
// Range.intersectsNode so theo VỊ TRÍ CÂY DOM (không cần layout) nên về lý
// thuyết chạy được trên jsdom — nhưng phần thu thập {row,col} nằm trong
// `startTableCellHighlight`, một closure private của component (không export,
// đúng khuôn `must_not`: không thêm export mới cho hành vi nội bộ ngoài hai
// hàm thuần đã export ở trên). Test hành vi đó cần mount component thật +
// dựng Selection/Range thủ công trong jsdom — để ở phạm vi một test mount đầy
// đủ sau này (như doc-redline-preview.test.tsx), không thêm ở đây để giữ file
// này tập trung vào các hàm thuần theo đúng accept của spec.
