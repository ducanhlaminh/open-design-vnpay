---
name: html-to-figma
description: |
  Biến một artifact HTML (Contract-clean, vd output của skill html-prototype) thành
  payload clipboard ĐỊNH DẠNG GỐC FIGMA. Bấm nút "Copy to Figma" → sang Figma Cmd/Ctrl+V
  → ra node Auto Layout editable, KHÔNG cần plugin/MCP. Pipeline: extract.cjs (Playwright →
  IR) → @open-design/figma-clip (IR → Kiwi .fig v106) → file payload + trang copy 1-click.
  Hỗ trợ: frame · Auto Layout · solid/gradient fill · radius · stroke · shadow · TEXT tiếng
  Việt (glyph-atlas) · ảnh raster · ICON inline-SVG → VECTOR editable. CHỈ chạy trên HTML
  Contract-clean (không react-shadcn).
triggers:
  - "copy to figma"
  - "html to figma"
  - "export figma"
  - "paste vào figma"
  - "figma clipboard"
  - "handoff figma"
od:
  mode: utility
  category: figma
---

# html-to-figma

> Output discipline: **HTML Contract-clean → clipboard payload Figma**. Không sinh UI;
> đây là **bước handoff**. Nguồn HTML phải tuân `references/contract.md` (chính là output
> của skill **html-prototype**). KHÔNG dùng cho artifact **react-shadcn** (grid/sticky/
> multi-font/component portal — extractor map sai, mất "component verbatim").

## Khi nào dùng

Người dùng muốn đưa một màn HTML đã sinh sang **Figma để designer làm tiếp**, dưới dạng
**portable** (payload lưu/gửi được, máy nào Cmd+V cũng ra), **không lệ thuộc plugin/MCP**.

## Cách chạy

```bash
node scripts/copy-figma.mjs <input.html> [--selector "<css>"] [--out-dir <dir>] [--json]
```

Sinh ra cạnh input (hoặc `--out-dir`):
- `<name>.figma.html` — **payload thô** (đúng định dạng clipboard Figma). Dùng khi tích hợp
  máy: đọc nội dung, đẩy vào `navigator.clipboard.write({ "text/html": ... })`.
- `<name>.copy.html` — **trang 1-click**: mở trong browser, bấm **"Copy to Figma"**, rồi
  sang Figma **Cmd/Ctrl+V**.

`--json` in ra `{ payloadPath, copyPath, bytes, warnings }` cho pipeline tự động.

### Yêu cầu môi trường

- `@open-design/figma-clip` đã build: `pnpm --filter @open-design/figma-clip build`.
- **Playwright** (cho extractor) — script tự resolve từ node_modules quanh repo; nếu thiếu:
  ```bash
  cd skills/html-to-figma && npm i playwright && npx playwright install chromium
  ```

## Phủ & giới hạn (v1)

| Hỗ trợ | Ghi chú |
|---|---|
| Frame · Auto Layout (hug/fill/fixed, gap, padding, justify/align) | flexbox theo Contract |
| Fill **solid + gradient** (linear/radial/angular) | `background`/`linear-gradient(...)` |
| Radius · stroke · **shadow/blur** | `border-radius`/`border`/`box-shadow`/`backdrop-filter` |
| **TEXT tiếng Việt** + số + dấu + tiền tệ `₫€£` | glyph-atlas Inter Regular/Bold |
| **Ảnh raster** (`<img>`, `background-image`) | nhúng base64 → IMAGE paint |
| **Icon inline `<svg>`** (path/rect/circle/ellipse/line/poly + `<g transform>`) | → **VECTOR editable** (nét mọi mức zoom); fill/stroke/fill-rule/CTM giữ nguyên |
| ⚠️ Glyph ngoài atlas (vd `→ ≈ ✓`) | cảnh báo + bỏ qua (text vẫn render phần còn lại) |
| ⚠️ SVG có `<text>/<image>/<use>`/filter | raster fallback (PNG 8x) cho phần không path-hoá được |
| ❌ Font ngoài Inter, weight ngoài 400/700 | quy về Inter Regular/Bold |

## Nền tảng kỹ thuật

- **Định dạng**: `.fig` container v106 (`fig-kiwi` + zstd message + deflate schema). TEXT chỉ
  render từ `derivedTextData` (per-glyph outline blob) — atlas tái dùng outline thật của Figma,
  không bake font. Ảnh hash **SHA-1 (20 byte)**.
- Toàn bộ ở `packages/figma-clip` (lib thuần TS). Chi tiết: `specs/current/html-to-figma-clipboard-plan.md`.
- `references/contract.md` — luật HTML đầu vào. `references/ir-schema.md` — hợp đồng IR.
