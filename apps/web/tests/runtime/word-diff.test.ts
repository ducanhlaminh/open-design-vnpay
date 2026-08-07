import { describe, expect, it } from 'vitest';
import { wordDiff } from '../../src/runtime/word-diff';

/** Nối lại các run cùng op để so nhanh trong test — kiểm được "chữ nào bị bỏ,
 *  chữ nào là mới" mà không phải viết ra cả chuỗi run. */
function texts(runs: NonNullable<ReturnType<typeof wordDiff>>, op: 'same' | 'del' | 'add'): string[] {
  return runs.filter((run) => run.op === op).map((run) => run.text);
}

describe('wordDiff', () => {
  it('thay một cụm GIỮA câu: chỉ cụm đó là del/add, phần còn lại giữ nguyên', () => {
    const runs = wordDiff('Người dùng nhập OTP để xác thực.', 'Người dùng nhập mã OTP gồm 6 số để xác thực.')!;
    expect(runs).not.toBeNull();
    expect(texts(runs, 'del')).toEqual([]);
    // "mã" chèn trước OTP, "gồm 6 số" chèn sau — hai chỗ thêm rời nhau.
    expect(texts(runs, 'add')).toEqual(['mã', 'gồm 6 số']);
    expect(runs.filter((run) => run.op === 'same').map((run) => run.text).join(' ')).toBe(
      'Người dùng nhập OTP để xác thực.',
    );
  });

  it('thay hẳn một từ giữa câu cho ra một cặp del rồi add', () => {
    const runs = wordDiff('Luồng thay thế 16 (Xuất Excel).', 'Luồng thay thế AF-18 (Xuất Excel).')!;
    expect(texts(runs, 'del')).toEqual(['16']);
    expect(texts(runs, 'add')).toEqual(['AF-18']);
    // del phải đứng TRƯỚC add — thẻ lý do đọc là "chữ cũ rồi chữ mới".
    const ops = runs.map((run) => run.op);
    expect(ops).toEqual(['same', 'del', 'add', 'same']);
  });

  it('thêm ở CUỐI: một run same rồi một run add', () => {
    const runs = wordDiff('Nhấn nút Xuất Excel.', 'Nhấn nút Xuất Excel. Hệ thống tải tệp về máy.')!;
    expect(runs).toEqual([
      { op: 'same', text: 'Nhấn nút Xuất Excel.' },
      { op: 'add', text: 'Hệ thống tải tệp về máy.' },
    ]);
  });

  it('xoá ở ĐẦU: một run del rồi một run same', () => {
    const runs = wordDiff('Ghi chú nội bộ. Người dùng nhập OTP.', 'Người dùng nhập OTP.')!;
    expect(runs).toEqual([
      { op: 'del', text: 'Ghi chú nội bộ.' },
      { op: 'same', text: 'Người dùng nhập OTP.' },
    ]);
  });

  it('hai đoạn giống hệt cho ra ĐÚNG MỘT run same', () => {
    const runs = wordDiff('Người dùng nhập mã OTP.', 'Người dùng nhập mã OTP.')!;
    expect(runs).toEqual([{ op: 'same', text: 'Người dùng nhập mã OTP.' }]);
  });

  it('khác biệt whitespace (xuống dòng, thụt lề, khoảng trắng kép) KHÔNG tính là thay đổi', () => {
    const runs = wordDiff('Người dùng  nhập\n  mã OTP.', 'Người dùng nhập mã OTP.')!;
    expect(runs).toEqual([{ op: 'same', text: 'Người dùng nhập mã OTP.' }]);
  });

  it('gộp mọi run liền kề cùng op — không bao giờ có hai run cùng loại dính nhau', () => {
    const runs = wordDiff('một hai ba bốn năm', 'một sáu bảy tám năm')!;
    expect(texts(runs, 'del')).toEqual(['hai ba bốn']);
    expect(texts(runs, 'add')).toEqual(['sáu bảy tám']);
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]!.op, `run ${i} dính op với run trước`).not.toBe(runs[i - 1]!.op);
    }
  });

  it('trả null khi bảng DP vượt trần 200_000 ô', () => {
    // 450 × 450 = 202_500 ô > trần; phía gọi rơi về hai khối nguyên văn.
    const big = Array.from({ length: 450 }, (_, i) => `từ${i}`).join(' ');
    const other = Array.from({ length: 450 }, (_, i) => `chữ${i}`).join(' ');
    expect(wordDiff(big, other)).toBeNull();
    // Ngay dưới trần thì vẫn phải chạy: trần là chặn treo máy, không phải chặn
    // mọi đoạn dài.
    const ok = Array.from({ length: 400 }, (_, i) => `từ${i}`).join(' ');
    expect(wordDiff(ok, ok)).toEqual([{ op: 'same', text: ok }]);
  });

  it('một phía rỗng: chỉ có add, hoặc chỉ có del', () => {
    expect(wordDiff('', 'Câu hoàn toàn mới.')).toEqual([{ op: 'add', text: 'Câu hoàn toàn mới.' }]);
    expect(wordDiff('Câu cũ bị bỏ.', '')).toEqual([{ op: 'del', text: 'Câu cũ bị bỏ.' }]);
    expect(wordDiff('', '')).toEqual([]);
  });
});
