// Thứ tự mockup trước/sau theo bảng CR "Hiện trạng | Thay đổi" (WP-V4).
//
// Tài liệu CR mô tả mỗi màn bằng 2 dòng bảng: dòng tên in đậm rồi dòng
// `| ![](ảnh-cũ) | ![](ảnh-mới) | bullet |`. Mảng mockups của một màn hiện
// không phân biệt ảnh "Hiện trạng" (trước) với "Thay đổi" (đích), nhưng
// dr-comp cần ảnh ĐÍCH đứng trước để agent biết compose theo trạng thái nào.
// Hàm thuần: không I/O, không import module daemon khác.

/** Kết quả sắp lại mockups theo cột bảng "Hiện trạng | Thay đổi". */
export interface MockupOrderResult {
  /** mockups đã sắp: [Thay đổi...] + [Hiện trạng...] + [không phân loại được...] */
  ordered: string[];
  /** true khi có ít nhất 1 mockup rơi vào cột "Thay đổi". */
  hasBeforeAfter: boolean;
}

const IMAGE_MARKDOWN_RE = /!\[[^\]]*\]\(([^)]+)\)/g;

/** Lấy basename để so khớp mockups (path tương đối cwd) với path trong markdown
 *  (có thể mang prefix khác nhau, vd `docs-feature/attachments/x.png` vs
 *  `attachments/x.png` hay `../../../attachments/x.png`). */
function basenameOf(p: string): string {
  const trimmed = p.trim();
  const parts = trimmed.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last !== undefined && last !== '' ? last : trimmed;
}

/** Tách một dòng bảng markdown thành các cell, bỏ cell rỗng đầu/cuối sinh ra
 *  do dòng bắt đầu/kết thúc bằng `|`. Trả về [] nếu dòng không phải dòng bảng. */
function tableCellsOf(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  const raw = trimmed.split('|');
  const first = raw[0];
  const lastEntry = raw[raw.length - 1];
  if (first !== undefined && first.trim() === '') raw.shift();
  if (raw.length > 0 && lastEntry !== undefined && lastEntry.trim() === '') raw.pop();
  return raw;
}

/** Chuẩn hoá cell header để so khớp "Hiện trạng"/"Thay đổi" không phân biệt
 *  hoa thường, cho phép bold `**`. */
function normalizeHeaderCell(cell: string): string {
  return cell.replace(/\*\*/g, '').trim().toLowerCase();
}

/**
 * Tìm bảng "Hiện trạng | Thay đổi" trong sectionLines, gom ảnh của từng
 * cột trên toàn bảng rồi phân loại từng entry trong `mockups` theo basename.
 * Không tìm thấy bảng đúng dạng → giữ nguyên mockups, hasBeforeAfter=false.
 */
export function orderMockupsByChangeColumn(
  sectionLines: string[],
  mockups: string[],
): MockupOrderResult {
  const fallback: MockupOrderResult = { ordered: [...mockups], hasBeforeAfter: false };

  // 1. Tìm dòng header có đủ 2 cột "Hiện trạng" + "Thay đổi" (đọc INDEX cột
  //    từ header, không hardcode cột 0/1 — tài liệu thật có thể đảo).
  let headerIndex = -1;
  let beforeCol = -1;
  let afterCol = -1;
  for (let i = 0; i < sectionLines.length; i += 1) {
    const line = sectionLines[i];
    if (line === undefined) continue;
    const cells = tableCellsOf(line);
    if (cells.length < 2) continue;
    const normalized = cells.map(normalizeHeaderCell);
    const bIdx = normalized.findIndex((c) => c === 'hiện trạng');
    const aIdx = normalized.findIndex((c) => c === 'thay đổi');
    if (bIdx !== -1 && aIdx !== -1) {
      headerIndex = i;
      beforeCol = bIdx;
      afterCol = aIdx;
      break;
    }
  }
  if (headerIndex === -1) return fallback;

  // 2. Gom ảnh theo cột trên mọi dòng bảng phía sau header, dừng khi hết bảng
  //    (dòng không còn bắt đầu bằng `|`).
  const beforeBasenames = new Set<string>();
  const afterBasenames = new Set<string>();

  for (let i = headerIndex + 1; i < sectionLines.length; i += 1) {
    const line = sectionLines[i];
    if (line === undefined || !line.trim().startsWith('|')) break;
    const cells = tableCellsOf(line);
    const beforeCell = cells[beforeCol] ?? '';
    const afterCell = cells[afterCol] ?? '';
    for (const match of beforeCell.matchAll(IMAGE_MARKDOWN_RE)) {
      const src = match[1];
      if (src !== undefined) beforeBasenames.add(basenameOf(src));
    }
    for (const match of afterCell.matchAll(IMAGE_MARKDOWN_RE)) {
      const src = match[1];
      if (src !== undefined) afterBasenames.add(basenameOf(src));
    }
  }

  // Không có ảnh nào rơi vào 1 trong 2 cột đã biết → không phải bảng
  // trước/sau thật (vd bảng rỗng) — vẫn trả kết quả tất định theo phân loại.
  // 3. Phân loại từng mockup: Thay đổi trước, Hiện trạng sau, còn lại giữ nguyên vị trí gốc.
  const afterList: string[] = [];
  const beforeList: string[] = [];
  const restList: string[] = [];
  for (const mock of mockups) {
    const base = basenameOf(mock);
    if (afterBasenames.has(base)) afterList.push(mock);
    else if (beforeBasenames.has(base)) beforeList.push(mock);
    else restList.push(mock);
  }

  return {
    ordered: [...afterList, ...beforeList, ...restList],
    hasBeforeAfter: afterList.length > 0,
  };
}
