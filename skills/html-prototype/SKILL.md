---
name: html-prototype
description: |
  Sinh prototype UI là **HTML/CSS flexbox thuần, Contract-clean** (token VNPAY render bằng
  div/flex + Inter, KHÔNG component React). Đây là "HTML mode" — chế độ prototype DUY NHẤT
  xuất được sang Figma (qua skill html-to-figma → Copy to Figma, không plugin). Khác với
  react-shadcn (component VNPAY verbatim, KHÔNG export Figma). Output: 1 file HTML self-
  contained tuân references/contract.md, deterministic để extractor map sạch sang Auto Layout.
triggers:
  - "html prototype"
  - "prototype xuất figma"
  - "html mode"
  - "figma-exportable ui"
  - "vnpay html thuần"
  - "contract-clean html"
od:
  mode: prototype
  category: web-artifacts
---

# html-prototype

> Output discipline: **một file HTML self-contained**, layout **chỉ flexbox**, brand bằng
> **token VNPAY** (`assets/tokens.css`) render qua **div/flex + Inter** — KHÔNG component
> React, KHÔNG grid/sticky/table. Mục tiêu kép: (1) preview đẹp trong iframe Open Design;
> (2) **map sạch 1-1 sang Figma Auto Layout** qua `html-to-figma`. Mọi luật ở
> `references/contract.md` là **bắt buộc** — phá luật = file Figma lệch/rách.

## Khi nào dùng (so với react-shadcn)

| | html-prototype (skill này) | react-shadcn |
|---|---|---|
| Cơ chế | HTML/CSS flexbox thuần + token VNPAY | `screen.json` → component VNPAY (Base UI) verbatim |
| **Copy to Figma** | ✅ **CÓ** (đường duy nhất ra Figma) | ❌ không |
| Dùng khi | cần handoff Figma, prototype nhanh, layout sạch | cần component thật/tương tác, không cần Figma |

Nếu người dùng **muốn xuất Figma** → dùng skill này. Nếu **muốn component VNPAY tương tác**
mà không cần Figma → dùng react-shadcn (giữ nguyên, không đụng).

## Luật cứng (trích Contract — đọc đủ ở references/contract.md)

1. **Layout chỉ Flexbox.** Mọi container `display:flex` + khai báo rõ `flex-direction`,
   `gap`, `padding`. ❌ Cấm `grid`, `table`, `float`, `position:sticky`, `flex-wrap`.
2. **Text mỗi đoạn 1 element riêng** (`<p>/<span>/<h*>`). ❌ Không trộn text trực tiếp lẫn
   element con trong cùng div (text trực tiếp bị bỏ).
3. **Font luôn Inter**, weight chỉ **400 / 700** (atlas Figma chỉ Regular/Bold; 500/600 quy
   về gần nhất). Tránh ký tự ngoài Latin/Việt/số/dấu/tiền tệ `₫€£` (vd icon glyph `→ ✓ ≈`
   sẽ bị bỏ khi sang Figma — dùng chữ hoặc inline SVG đơn giản).
4. **Màu** rgb/rgba/hex (token đã ở dạng hex). **Size** px cố định hoặc `flex:1` (fill);
   tránh `%/vw/vh/calc()`.
5. **Icon** = inline `<svg>` (path/rect/circle/ellipse/line/poly, `<g transform>` OK) → sang
   Figma thành **VECTOR editable** (nét mọi mức zoom). SVG có `<text>/<image>/<use>`/filter →
   raster fallback. Tránh ký tự glyph icon (`→ ✓`) trong text — dùng inline SVG thay thế.
6. **Ảnh** dùng `<img>` hoặc `background-image:url(...)` (sẽ nhúng base64 khi export).

## Khung file (luôn theo)

```html
<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8">
<style>/* dán nội dung assets/tokens.css vào đây, rồi style theo token */</style>
</head><body>
  <!-- 1 root <div> Contract-clean; mọi container là flex -->
</body></html>
```

`<body>` nên có 1 con gốc trực tiếp = root màn hình (extractor mặc định lấy
`body.firstElementChild`). Nhúng `assets/tokens.css` inline để file self-contained.

## Snippet Contract-clean (token VNPAY)

**Nút primary (gradient brand):**
```html
<div style="display:flex;justify-content:center;align-items:center;
     padding:14px 24px;border-radius:12px;
     background:linear-gradient(135deg,#0051b9,#545be9 52%,#009cf9)">
  <span style="font:700 16px Inter,sans-serif;color:#fff">Thanh toán</span>
</div>
```

**Card:**
```html
<div style="display:flex;flex-direction:column;gap:12px;padding:24px;
     background:#fff;border-radius:20px;box-shadow:0 8px 24px rgba(18,22,31,.10)">
  <p style="font:700 20px Inter,sans-serif;color:#12161f">Tiêu đề thẻ</p>
  <p style="font:400 15px Inter,sans-serif;color:#5f636f">Nội dung mô tả, số tiền 1.990.000₫.</p>
</div>
```

**Input (tĩnh):**
```html
<div style="display:flex;flex-direction:column;gap:8px">
  <span style="font:700 14px Inter,sans-serif;color:#12161f">Số tiền</span>
  <div style="display:flex;align-items:center;padding:12px 16px;border:1px solid #e4e6f0;border-radius:12px;background:#fff">
    <span style="font:400 16px Inter,sans-serif;color:#5f636f">0₫</span>
  </div>
</div>
```

**Nav row (space-between):**
```html
<div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;background:#fff">
  <span style="font:700 18px Inter,sans-serif;color:#12161f">VNPAY</span>
  <div style="display:flex;gap:16px;align-items:center">
    <span style="font:400 14px Inter,sans-serif;color:#5f636f">Trang chủ</span>
    <span style="font:400 14px Inter,sans-serif;color:#5f636f">Ví</span>
  </div>
</div>
```

## Xuất sang Figma

Sau khi có file (vd `screen.html`):
```bash
node ../html-to-figma/scripts/copy-figma.mjs screen.html
```
→ mở `screen.copy.html`, bấm **Copy to Figma**, sang Figma **Cmd/Ctrl+V**. Xem
`skills/html-to-figma/SKILL.md` cho chi tiết + giới hạn.

## Tham chiếu

- `assets/tokens.css` — token VNPAY Contract-clean (màu/spacing/type/radius/shadow).
- `references/contract.md` — luật HTML đầu vào (nguồn chuẩn).
- `specs/current/html-to-figma-clipboard-plan.md` — kiến trúc 2-mode + pipeline.
