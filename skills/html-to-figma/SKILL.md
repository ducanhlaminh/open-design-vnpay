---
name: html-to-figma
description: |
  Biến một artifact HTML thành payload clipboard ĐỊNH DẠNG GỐC FIGMA ("HTML to Design" /
  figh2d). Bấm nút "Copy to Figma" → sang Figma Cmd/Ctrl+V → ra node editable, KHÔNG cần
  plugin/MCP. Pipeline: copy-figma-h2d.mjs (Playwright dựng DOM thật) → @open-design/figma-h2d
  serializer (figh2d JSON) → file payload + trang copy 1-click. Nhiều input → MỘT payload
  (paste 1 lần, mỗi màn thành 1 frame anh em). Fully client-side, không qua daemon.
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

> Output discipline: **HTML → clipboard payload Figma (figh2d)**. Không sinh UI; đây là
> **bước handoff**. Engine = `@open-design/figma-h2d` (serializer clean-room chạy trên DOM
> thật trong Playwright). HTML càng sạch (flex, ít overlap) thì node Figma càng đẹp —
> tham khảo `references/contract.md`.

## Khi nào dùng

Người dùng muốn đưa một (hoặc nhiều) màn HTML sang **Figma để designer làm tiếp**, dưới dạng
**portable** (payload lưu/gửi được, máy nào Cmd+V cũng ra), **không lệ thuộc plugin/MCP**.

## Cách chạy

```bash
node scripts/copy-figma-h2d.mjs <input.html> [<input2.html> ...] [--out-dir <dir>] [--width <px>] [--json]
```

- **Nhiều input → MỘT payload**: paste 1 lần, mỗi màn rơi vào Figma thành 1 frame anh em
  (tiện "copy cả bộ màn" của một prototype).

Sinh ra cạnh input đầu (hoặc `--out-dir`):
- `<name>.figma.html` — **payload thô** (đúng định dạng clipboard Figma). Tích hợp máy: đọc
  nội dung, đẩy vào `navigator.clipboard.write({ "text/html": ... })`.
- `<name>.copy.html` — **trang 1-click**: mở trong browser, bấm **"Copy to Figma"**, rồi sang
  Figma **Cmd/Ctrl+V**. (Khi nhiều input, `<name>` = `<màn đầu>+<N-1>`.)

`--json` in ra `{ payloadPath, copyPath, bytes, screens }` cho pipeline tự động.

### Yêu cầu môi trường

- `@open-design/figma-h2d` đã build (cần `dist/figma-h2d.global.js`):
  `pnpm --filter @open-design/figma-h2d build`.
- **Playwright** (dựng DOM thật) — script tự resolve từ node_modules quanh repo; nếu thiếu:
  ```bash
  cd skills/html-to-figma && npm i playwright && npx playwright install chromium
  ```

## Cùng engine với nút web

Nút **"Copy to Figma"** trên web (FileViewer single-file, canvas prototype, canvas screens)
dùng đúng serializer này nhưng **chạy hoàn toàn trong browser** (`apps/web/src/lib/html-to-h2d.ts`,
không cần Playwright/daemon): render HTML vào iframe `srcdoc` same-origin rồi `captureElement`.
CLI này là đường **portable/headless** tương đương (Playwright thay cho iframe).

## Nền tảng kỹ thuật

- Định dạng = **figh2d** ("HTML to Design"): clipboard `text/html` mang JSON document, Figma
  dựng node editable từ JSON lúc paste (không cần encode `.fig` nhị phân, không daemon).
- Toàn bộ ở `packages/figma-h2d` (lib thuần TS: serialize / transform / text-layout / fonts /
  images / svg). Spec: `specs/current/h2d-serializer-spec.md`.
- `references/contract.md` — luật HTML đầu vào (HTML càng sạch → kết quả càng tốt).
