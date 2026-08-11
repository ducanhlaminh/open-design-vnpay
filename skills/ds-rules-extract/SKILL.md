---
name: ds-rules-extract
description: |
  Sinh criteria/rules.md từ showcase + token của Design System, có căn cứ từ
  preview, STYLE-GUIDE và catalog; ghi an toàn vào rules.md.next để daemon kiểm tra.
triggers:
  - "sinh quy tắc review design system"
  - "tạo rules.md cho design system"
  - "ds rules extract"
od:
  mode: utility
  category: design-systems
---

# ds-rules-extract — sinh quy tắc review từ DS

Cwd là thư mục gốc của DS. Đọc nguồn trực quan và tài liệu thật, suy luận quy
tắc dùng component khi có bằng chứng; không bịa component hoặc mâu thuẫn token.

## Input

Đọc:
- `react/showcase/index.html` (showcase tổng hợp, toolbar theme).
- `preview/*.html` (colors, typography, spacing, shadows, radius, components).
- `react/STYLE-GUIDE.md` (token contract).
- `react/docs/catalog.md` (component, prop, tên tham chiếu).
- `DESIGN.md` (tên DS).

**KHÔNG đọc `react/showcase/showcase-data.js`**: asset SVG base64, vô ích và tốn
context.

## Output

Chỉ tạo đúng `criteria/rules.md.next`. Tuyệt đối không ghi đè
`criteria/rules.md`; daemon validate rồi rename. Không tạo `components.md`,
`_meta.json` hoặc file khác.

Tiêu đề: `# Quy tắc review — <tên DS lấy từ DESIGN.md>`.
Nhóm bằng `## <NHÓM>`; có thể dùng MÀU & THEME, TYPOGRAPHY, SPACING & LAYOUT,
ELEVATION & RADIUS, COMPONENT USAGE, TRẠNG THÁI & TƯƠNG TÁC.
Mỗi quy tắc dùng đúng heading:
`### \`R-<SLUG-HOA-HOẶC-SỐ>\` <Tên quy tắc ngắn>`.
Anchor chỉ xuất hiện một lần. Dưới heading viết 1–4 câu tiếng Việt, nêu căn cứ
quan sát được từ showcase, token, STYLE-GUIDE hoặc catalog. Chỉ heading `###`
là quy tắc; `#` và `##` không có anchor.

Phạm vi được gồm quy tắc dùng component và quyết định sản phẩm nếu showcase và
catalog chứng minh được (ví dụ biến thể button hoặc bottom sheet hiện hữu).
Ưu tiên điều kiểm chứng được. Tham khảo 12–30 quy tắc; không dưới 6 nếu nguồn
đủ dữ liệu, không cần chẻ vụn quá 40.

## Tự kiểm

Đọc lại `.next`: mọi `###` có đúng một anchor `R-...`, không trùng; không có
anchor trên `#`/`##`; chỉ có file `criteria/rules.md.next` được tạo.
