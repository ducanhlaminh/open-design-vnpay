// Fallback mô tả component do AI sinh — WP19a (hạ tầng tất định; nội dung do
// WP-B sinh sau, qua một nút ở DS tab). Bối cảnh: DS Figma của dự án cũ
// thường không khai description trên node, nên `criteria/components.md`
// (đóng băng từ Figma REST, xem figma-component-catalog.ts) thiếu dòng
// "- Mô tả:", khiến cột "Mô tả component" của bảng "Cấu thành màn hình"
// (dr-review, docs-review-enrich.ts) hiện "—" và agent dr-comp thiếu ngữ
// cảnh.
//
// `components-guide.md` là MỘT file bổ sung, sống ở App-level
// (`<PROJECTS_DIR>/<appId>/figma-catalog/components-guide.md`, đọc/ghi ở
// figma-catalog-routes.ts), mirror ĐÚNG format đóng của components.md
// (heading `### \`#anchor\` Tên` + `- Mô tả: …`) để dùng lại được nguyên
// parser sẵn có thay vì một bộ regex song song có thể trôi lệch — xem
// {@link parseComponentsGuide}.
//
// Nguyên tắc bất biến: Figma LUÔN thắng. {@link mergeCatalogueWithGuide} chỉ
// điền description từ guide vào đúng những anchor mà components.md CÓ mặt
// nhưng KHÔNG có mô tả — không bao giờ ghi đè một mô tả Figma đã có, và
// không bao giờ mang vào một anchor mà components.md không còn biết tới
// (component đã bị xoá khỏi Figma kể từ lần guide được sinh).

import { parseCatalogue } from './docs-review-enrich.js';

/** Một dòng nội dung của guide: `anchor` KHÔNG có dấu `#`, khớp thẳng
 *  `#figma-<hash>` (anchorFor, figma-component-catalog.ts — hash ổn định từ
 *  fileKey+nodeId qua các lần refresh). `name` chỉ để người đọc file dễ tra
 *  cứu — Figma vẫn là nguồn tên thật khi merge, {@link mergeCatalogueWithGuide}
 *  không bao giờ dùng `name` của guide. */
export interface ComponentsGuideEntry {
  anchor: string;
  name: string;
  description: string;
}

/** Một entry catalogue sau khi merge với guide. `fromGuide: true` đánh dấu
 *  description ĐẾN TỪ guide (không phải từ Figma) để caller (renderCompositionDraft,
 *  docs-review-enrich.ts) gắn hậu tố " (AI sinh)" cho người đọc bảng biết
 *  xuất xứ. Vắng mặt (undefined)/`false` == mô tả thật từ Figma hoặc rỗng. */
export interface MergedCatalogueEntry {
  name: string;
  description: string;
  fromGuide?: boolean;
}

/** Dựng `components-guide.md`: mirror format đóng của components.md (xem
 *  {@link parseComponentsGuide} đọc lại) + header cảnh báo AI-sinh (tiếng
 *  Việt) — người mở file lên phải hiểu ngay đây KHÔNG phải danh mục chính,
 *  sửa tay được, và bị Figma đè khi cả hai đều có mô tả. Entry rỗng
 *  `description` vẫn được ghi ra heading (không kèm dòng "- Mô tả:") để giữ
 *  liên tục thứ tự — {@link parseComponentsGuide}/parseCatalogue vẫn khoan
 *  dung với heading thiếu mô tả (description rỗng, không lỗi). */
export function renderComponentsGuideMarkdown(entries: readonly ComponentsGuideEntry[]): string {
  const lines = [
    '# Mô tả component (AI sinh — dự phòng)',
    '',
    '> File này do AI sinh từ phân tích node + ảnh Figma. CHỈ dùng khi ' +
      '"criteria/components.md" (danh mục chính, đọc trực tiếp từ Figma) ' +
      'thiếu dòng "- Mô tả:" cho component đó — Figma LUÔN thắng khi cả hai ' +
      'đều có mô tả. Sửa tay được; không phải nguồn dữ liệu bắt buộc.',
    '',
  ];
  for (const entry of entries) {
    lines.push(`### \`#${entry.anchor}\` ${entry.name}`, '');
    if (entry.description) lines.push(`- Mô tả: ${entry.description.replace(/\s+/g, ' ').trim()}`, '');
  }
  return `${lines.join('\n').trim()}\n`;
}

/** Đọc lại `components-guide.md` thành `Map<anchor, {name, description}>` —
 *  gọi THẲNG {@link parseCatalogue} (docs-review-enrich.ts, WP19 dùng chung)
 *  vì format hai file giống hệt nhau (xem docblock đầu file): chia sẻ nguyên
 *  hàm thay vì chép lại regex heading/`- Mô tả:` ra một bản song song có thể
 *  trôi lệch. Khoan dung y hệt parseCatalogue: entry hỏng bị bỏ qua, không
 *  throw. */
export function parseComponentsGuide(markdown: string): Map<string, { name: string; description: string }> {
  return parseCatalogue(markdown);
}

/** Merge `catalogue` (từ `criteria/components.md`, luôn thắng) với `guide`
 *  (fallback) — CHỈ điền `description` cho anchor mà `catalogue` CÓ nhưng mô
 *  tả rỗng; anchor chỉ tồn tại trong `guide` (không có trong `catalogue`, vd
 *  component đã bị xoá khỏi Figma) bị bỏ hẳn, không lọt vào kết quả. Entry
 *  điền từ guide được đánh dấu `fromGuide: true` (xem {@link MergedCatalogueEntry}). */
export function mergeCatalogueWithGuide(
  catalogue: ReadonlyMap<string, { name: string; description: string }>,
  guide: ReadonlyMap<string, { name: string; description: string }>,
): Map<string, MergedCatalogueEntry> {
  const merged = new Map<string, MergedCatalogueEntry>();
  for (const [anchor, entry] of catalogue) {
    if (entry.description) {
      merged.set(anchor, { name: entry.name, description: entry.description });
      continue;
    }
    const guideEntry = guide.get(anchor);
    if (guideEntry?.description) {
      merged.set(anchor, { name: entry.name, description: guideEntry.description, fromGuide: true });
    } else {
      merged.set(anchor, { name: entry.name, description: entry.description });
    }
  }
  return merged;
}
