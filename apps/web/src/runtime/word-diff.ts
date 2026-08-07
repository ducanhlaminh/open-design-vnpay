// word-diff — diff mức TỪ giữa hai đoạn văn, dùng cho thẻ lý do của redline.
//
// Vì sao cần: thẻ lý do trước đây hiện `before → quote` thành hai khối nguyên
// văn. Với một câu URD dài 30 từ mà chỉ đổi hai từ, người đọc phải tự so hai
// khối để tìm chỗ khác nhau — đúng phần việc mà máy làm được. Ở mức TỪ (không
// phải mức ký tự) vì đơn vị người đọc rà là từ: diff ký tự trên tiếng Việt cắt
// vụn giữa các dấu thanh và cho ra một chuỗi mảnh vá lởm chởm khó đọc hơn cả
// hai khối gốc.
//
// Module thuần: không DOM, không React, không phụ thuộc CSS Module — phía gọi
// tự quyết định tô màu cho từng run. Nhờ vậy test được bằng phép so chuỗi.

export type DiffRun = { op: 'same' | 'del' | 'add'; text: string };

/** Trần số ô của bảng DP. LCS là O(n·m) cả thời gian lẫn bộ nhớ, nên một cặp
 *  đoạn dài bất thường (LLM dán cả một mục vào `before`) sẽ treo luồng render.
 *  200_000 ô ≈ 450×450 từ — dài hơn mọi đoạn văn thật trong tài liệu URD, mà
 *  vẫn rẻ (một Int32Array ~800KB, vài ms). Vượt trần thì trả null để phía gọi
 *  rơi về cách hiển thị hai khối cũ: xấu hơn nhưng luôn hiện được. */
const MAX_DIFF_CELLS = 200_000;

/** Cắt theo whitespace. Cố ý KHÔNG giữ nguyên dạng khoảng trắng (tab, xuống
 *  dòng, thụt lề) — đây là hiển thị trong một thẻ hẹp, không phải patch để áp
 *  lại vào file, nên nguyên dạng whitespace không có người dùng nào. */
function tokenize(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/**
 * Diff mức TỪ giữa hai đoạn văn (tokenize theo whitespace, LCS chuẩn DP).
 *
 * Trả null khi đầu vào quá lớn (xem MAX_DIFF_CELLS) — phía gọi rơi về cách
 * hiển thị hai khối cũ. Run liền kề cùng `op` được gộp, nên chuỗi trả về không
 * bao giờ có hai run cùng loại dính nhau; `text` của một run là các token nối
 * bằng đúng MỘT khoảng trắng.
 *
 * Khi hoà (xoá và thêm cùng dài như nhau) thì ưu tiên phát `del` TRƯỚC `add`:
 * thẻ lý do đọc là "chữ cũ (gạch ngang) rồi chữ mới", nên thứ tự này khớp với
 * cách người ta đọc một redline trên giấy.
 */
export function wordDiff(before: string, after: string): DiffRun[] | null {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length * b.length > MAX_DIFF_CELLS) return null;

  // dp[i][j] = độ dài LCS của a[i..] và b[j..] — bảng HẬU TỐ, để lát nữa lần
  // xuôi từ (0,0) mà vẫn biết đường nào dài hơn. Phẳng hoá thành một
  // Int32Array: cùng độ phức tạp nhưng không cấp phát n mảng con.
  const width = b.length + 1;
  const dp = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + (j + 1)]!);
    }
  }

  const runs: DiffRun[] = [];
  /** Gộp ngay lúc phát, thay vì phát từng token rồi gộp một lượt sau: phía gọi
   *  render mỗi run thành một <span>, nên một run mỗi từ sẽ đẻ ra hàng chục
   *  span liền kề cùng màu — trông như chữ bị chặt khúc. */
  const emit = (op: DiffRun['op'], token: string) => {
    const last = runs[runs.length - 1];
    if (last && last.op === op) last.text += ` ${token}`;
    else runs.push({ op, text: token });
  };

  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      emit('same', a[i]!);
      i += 1;
      j += 1;
    } else if (i < a.length && (j === b.length || dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!)) {
      emit('del', a[i]!);
      i += 1;
    } else {
      emit('add', b[j]!);
      j += 1;
    }
  }
  return runs;
}
