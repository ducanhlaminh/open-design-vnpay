# Tài liệu thiết kế: "Copy to Figma" (HTML → clipboard gốc Figma) cho open-design-vnpay

> ⚠️ **CẬP NHẬT 2026-06-08 — PoC Phase 0 ĐÃ XONG, có khác biệt với tài liệu này.**
> Kết quả thực nghiệm + chiến lược chốt nằm ở [specs/current/html-to-figma-clipboard-plan.md](specs/current/html-to-figma-clipboard-plan.md)
> ("PoC results"). Tóm tắt khác biệt so với phán đoán ban đầu bên dưới:
> - Format Figma hiện hành = **version 106**, message nén **zstd** (không phải deflate/v15).
> - **Không dùng** `fig-kiwi.read/writeHTMLMessage` (CJS rỗng + chỉ deflate/v15); tự viết `figclip` + `kiwi-schema@0.5.0`.
> - **TEXT**: Figma render từ `derivedTextData` (glyph outline baked), không recompute → giải bằng **glyph-atlas** (tái dùng blob của Figma), KHÔNG bake từ TTF như §6 phỏng đoán.
> - Khả thi đã chứng minh end-to-end trên Figma thật (round-trip pixel-perfect + synth text "Acme").
>
> Phần dưới giữ nguyên làm bối cảnh phân tích ban đầu.
>
> Trạng thái: ~~THIẾT KẾ~~ → **PoC verified, đang chuẩn bị Phase 1**.
>
> **Quyết định đã chốt với user (2026-06-08):**
> 1. Mục tiêu = **portable handoff**: một nút "Copy to Figma", bấm xong sang Figma
>    **Cmd+V ra node thật, KHÔNG cần plugin, KHÔNG cần MCP**. Ai/máy nào cũng paste được.
> 2. Chấp nhận đánh đổi **"khó & giòn"** để giữ **editable Auto Layout** (không chịu SVG phẳng).
>
> Hệ quả: hướng chính chuyển từ `use_figma` MCP → **encode định dạng clipboard gốc của
> Figma (Kiwi)**. `use_figma` còn lại như một *automation alternative* (Phụ lục C).
>
> Nguồn: figma-skill `/Users/anhnd13/Documents/figma-skill` (`extractor/extract.js`,
> `figma-plugin/code.js`, `IR-SCHEMA.md`, `CONTRACT.md`); repo này
> [skills/react-shadcn/SKILL.md](skills/react-shadcn/SKILL.md), [AGENTS.md](AGENTS.md).
> Tham khảo kỹ thuật ở §Sources cuối file.

---

## 1. Câu hỏi gốc & trả lời

> "Bấm 'Copy to Figma' → sang Figma chủ động paste ra, không qua Plugin được không?"

**Được.** Figma vốn cho paste ra node editable **không cần plugin** — đó chính là cơ chế
copy/paste nội bộ của nó. Điều kiện duy nhất: clipboard phải mang **đúng định dạng gốc**
của Figma (cặp blob `figmeta`/`figma`). Đây không phải lý thuyết — định dạng đã được
reverse-engineer công khai và **có sẵn thư viện encode** (`fig-kiwi`).

Ba định dạng Figma đọc khi paste, ba kết quả khác nhau:

| Clipboard mang gì | Paste ra | Editable Auto Layout? | Công sức |
|---|---|---|---|
| **Định dạng gốc Figma** (`figma`/`figmeta` Kiwi) | Node thật: frame, text, Auto Layout | ✅ **đúng mục tiêu** | Cao (nhưng có lib) |
| SVG (`image/svg+xml`) | Vector/group phẳng | ❌ | ~0 |
| PNG (`image/png`) | 1 ảnh bẹt | ❌ | ~0 |

→ Đã chọn dòng 1.

---

## 2. Định dạng clipboard của Figma (đã xác minh)

Khi copy trong Figma, clipboard `text/html` có dạng (rút gọn từ payload thật):

```html
<meta charset="utf-8">
<div>
  <span data-metadata="<!--(figmeta)eyJmaWxlS2V5Ii4uLn0=(/figmeta)-->"></span>
  <span data-buffer="<!--(figma)ZmlnLWtpd2lG...P/Ag==(/figma)-->"></span>
</div>
<span style="white-space:pre-wrap;">…plain-text fallback…</span>
```

- **`(figmeta)`** = base64 của JSON nhỏ:
  ```json
  { "fileKey": "<bất kỳ>", "pasteID": 0, "dataType": "scene" }
  ```
- **`(figma)`** = base64 của **buffer Kiwi**, mở đầu bằng magic ASCII `fig-kiwi`, rồi
  version u32 (LE), rồi các chunk `(u32 length + khối deflate)`:
  **chunk 0 = schema Kiwi** (định nghĩa message), **chunk 1 = dữ liệu message**
  (`nodeChanges` = node thật + `blobs` = geometry/vector/ảnh).

**Điểm vàng — payload TỰ MANG SCHEMA**: vì schema nằm ngay trong buffer (chunk 0),
Figma giải mã theo schema *ta nhúng* chứ không bắt khớp tuyệt đối schema hiện hành.
Cộng với việc Kiwi thiết kế để **tương thích tiến/lùi**, **rủi ro "vỡ theo version
Figma" thấp hơn nhiều** so với lo ngại ban đầu (xem §6 rủi ro #3).

Browser clipboard: ghi bằng
`navigator.clipboard.write([ new ClipboardItem({ "text/html": blob }) ])` — cần
**user gesture** (nút bấm thoả) + **secure context** (localhost/https — OK). Figma
desktop & web đều đọc `text/html` khi paste.

---

## 3. Kiến trúc tích hợp (hướng chính)

```
react-shadcn → shell.html (artifact trong project cwd)
      │  Bash + Playwright (1.60 của repo)
      ▼
  extract.js  →  IR JSON  (IR-SCHEMA.md — GIỮ NGUYÊN làm hợp đồng dữ liệu)
      │  ir-to-fig.ts  (MỚI: IR → Kiwi message)
      ▼
  fig-kiwi writeFigFile({message, schema})  →  buffer .fig
      │  wrap: base64 + (figma)/(figmeta) + 2 span HTML
      ▼
  payload text/html  ──►  [Web: nút "Copy to Figma" → clipboard.write]
                     └──►  [CLI: od ... --copy-figma → ghi file/stdout]
              ┊
              ▼ user Cmd+V trong Figma
       Node thật, Auto Layout, editable
```

**IR (`IR-SCHEMA.md`) giữ nguyên** — vẫn là trục xương sống. Chỉ thêm **một bộ
encode mới `ir-to-fig`** thay cho mảnh "plugin paste" cũ. Extractor (`extract.js`)
tái dùng gần như nguyên vẹn.

**Phân tầng theo boundary repo** ([AGENTS.md](AGENTS.md)): clipboard chỉ ghi được ở
browser, nhưng *encode nặng* (Kiwi, ảnh) nên đặt ở **daemon**:

- **daemon** chạy `extract.js` + `ir-to-fig` + `fig-kiwi` → trả **chuỗi `text/html`** đã
  sẵn sàng (`POST /api/.../figma-clipboard`, DTO ở `packages/contracts`).
- **web**: nút "Copy to Figma" fetch payload đó rồi `clipboard.write` (thin, đúng cơ chế
  daemon-owns-logic).
- **CLI**: `od ... --copy-figma` xuất payload ra file/stdout (portable, satisfies
  dual-track UI+CLI của repo).

---

## 4. Mapping IR → Kiwi message (.fig node)

Tương tự IR → Plugin API trong `code.js`, nhưng **tên field theo schema .fig** (khác
Plugin API). Bảng đối chiếu cốt lõi:

| IR | Plugin API (`code.js` cũ) | **.fig / Kiwi (mới)** |
|---|---|---|
| frame | `createFrame()` | NodeChange `type: FRAME` |
| layout.mode | `layoutMode HORIZONTAL/VERTICAL` | `stackMode: HORIZONTAL/VERTICAL` |
| layout.gap | `itemSpacing` | `stackSpacing` |
| layout.padding | `paddingTop/...` | `stackPaddingTop/Right/Bottom/Left` |
| justify | `primaryAxisAlignItems` | `stackPrimaryAlignItems` |
| align | `counterAxisAlignItems` | `stackCounterAlignItems` |
| sizing fill | `layoutGrow=1` | `stackChildPrimaryGrow=1` |
| sizing stretch | `layoutAlign=STRETCH` | `stackChildAlignSelf=STRETCH` |
| sizing hug/fixed | `primary/counterAxisSizingMode` | `stackWidth/HeightResize` (AUTO/FIXED) |
| text | `createText()`+`loadFontAsync` | NodeChange `type: TEXT` + `textData`/`fontName` |
| fills solid | SOLID paint | Paint `type: SOLID`, color {r,g,b,a} |
| fills gradient | GRADIENT_* + `gradientTransform` | Paint `type: GRADIENT_LINEAR/RADIAL/ANGULAR` + `transform` |
| effects | DROP/INNER_SHADOW, LAYER/BACKGROUND_BLUR | `effects[]` cùng enum |
| radius | `topLeftRadius…` | `rectangleCornerRadii*` |
| stroke | `strokes/strokeWeight` | `strokePaints` + `strokeWeight` |
| image | `createImage(bytes)` → IMAGE paint | Paint `type: IMAGE` + `image.hash` → **blob/registry** |
| vector (svg) | `createNodeFromSvg(svg)` | **vectorNetwork blob** (KHÓ — §6 #1) |
| absolute | `layoutPositioning=ABSOLUTE` + constraints | `stackPositioning: ABSOLUTE` + `horizontalConstraint/verticalConstraint` |

Phần frame/text/fills/effects/radius/stroke/gradient/absolute: **map thẳng, rõ ràng**.
Hai chỗ tốn công: **vector (icon)** và **image** (đều dùng `blobs`).

---

## 5. Encoder: `fig-kiwi` + một wrapper nhỏ

API thực tế của `fig-kiwi` (đã xác minh trên README):

```ts
import { readHTMLMessage, readFigFile, writeFigFile } from "fig-kiwi";

// ĐỌC clipboard Figma (dùng để LẤY SCHEMA, xem dưới)
const { message, meta } = readHTMLMessage(html);

// GHI .fig từ message + schema
const { message, schema, preview } = readFigFile(figBytes);
const out: Uint8Array = writeFigFile({ message, schema });
```

> ⚠️ `fig-kiwi` **KHÔNG có `writeHTMLMessage`**. Ta tự ráp clipboard HTML:
> `writeFigFile({message, schema})` → `base64` → bọc `<!--(figma)…-->` +
> `<!--(figmeta)…-->` + 2 span. ~30 dòng wrapper.

**Mẹo lấy schema bền vững (giảm rủi ro version):**
1. Copy **một frame bất kỳ** trong Figma hiện tại của bạn.
2. `readHTMLMessage(html)` → lấy `schema` (và một message mẫu để học cấu trúc node).
3. **Tái dùng `schema` đó** cho mọi `writeFigFile` của ta → payload luôn khớp Figma bạn
   đang dùng. Khi Figma update lớn → copy lại 1 lần, refresh schema. Đây là "kim chỉ nam"
   để không phải bảo trì schema thủ công.

> Lưu ý: README nói **không parse sẵn blob data** và **"no warranty"** — geometry vector
> và ảnh phải tự xử lý ở tầng blob (xem §6).

---

## 6. Rủi ro (xếp lại theo route clipboard)

1. **Vector / icon (SVG) — KHÓ NHẤT.** Clipboard không chạy `createNodeFromSvg`. Muốn icon
   thành vector editable phải tự dựng **vectorNetwork** (vertices/segments/regions) từ
   path SVG và nhét vào `blobs` — phức tạp. **Ba lựa chọn:**
   - (a) **Rasterize icon → image paint** (dễ, nhưng icon mất editable, thành ảnh).
   - (b) **SVG path → vectorNetwork** (đúng, đắt; có thể mượn logic Penpot/Grida importer).
   - (c) **v1: bỏ icon** (giữ ô trống/placeholder), thêm sau.
   > Đây là **điểm yếu so với `use_figma`** (vốn `createNodeFromSvg` native). Cần chốt sớm.
2. **Image — trung bình.** Paint IMAGE tham chiếu `hash`; bytes ảnh phải vào blob/registry
   của message. fig-kiwi không lo hộ → tự code. Hoặc v1 `--no-images`/placeholder.
3. **Schema drift — THẤP** (đã giảm): payload tự mang schema + Kiwi tương thích tiến/lùi +
   mẹo "lấy schema từ copy thật" (§5). Vẫn cần test lại khi Figma đổi lớn.
4. **Text — trung bình.** TEXT cần `textData` (characters + styleOverrideTable) và
   `fontName` (family/style/postscript). Inter là font Figma bundle → resolve được; cần map
   weight→style như `code.js`.
5. **Browser clipboard.** `clipboard.write` text/html cần user-gesture + secure context.
   OK với nút bấm trên localhost/https. Một số trình duyệt cần xin quyền clipboard-write.
6. **Không chính thức / no warranty.** `fig-kiwi` + định dạng = reverse-engineer. Phải
   **pin version**, có **round-trip test** trong CI để bắt sớm khi vỡ.
7. **Kế thừa (vẫn còn): output react-shadcn không sạch Contract** — `shell.html` có 46
   `grid`, 21 `sticky`, 3 `flex-wrap` (Contract cấm) → layout lệch. Cần contract-lint +
   figma-safe preset (Phase 3, như bản trước).

---

## 7. Thiết kế tính năng (dual-track UI + CLI)

Theo [AGENTS.md](AGENTS.md) §"Capability exposure" — nếu làm thành **capability sản phẩm**
phải đủ cả UI lẫn CLI, cùng gọi `/api/*`:

- **daemon**: `POST /api/projects/:id/artifacts/figma-clipboard` (body: đường dẫn HTML +
  cờ `selector`, `images`, `icons`) → chạy extract + ir-to-fig + fig-kiwi → trả
  `{ html: "<payload text/html>", warnings: [...] }`. DTO ở `packages/contracts`.
- **web**: nút **"Copy to Figma"** ở thanh công cụ artifact/FileViewer → fetch endpoint →
  `clipboard.write([ClipboardItem({'text/html': blob})])` → toast "Đã copy, sang Figma Cmd+V".
- **CLI**: `od artifact copy-figma <html> [--selector] [--no-images] [--out -]` → in payload
  (portable: lưu file, gửi đi, máy khác paste). Hỗ trợ `--json`, `--prompt-file`/stdin.

Cả ba land **cùng một PR** (yêu cầu của repo). Nếu chỉ làm **skill thuần** (agent tạo
payload, user paste) thì né được ràng buộc này cho bản thử.

---

## 8. Lộ trình & tiêu chí thoát

| Phase | Việc | Acceptance |
|---|---|---|
| **0 — PoC khâu giòn nhất** (½–1 ngày) | Lấy `schema` từ 1 copy thật (§5) → tự dựng 1 message: frame Auto Layout dọc, 3 con (2 text + 1 frame màu) → `writeFigFile` → ráp HTML → **paste vào Figma** | Frame xuất hiện, **là Auto Layout thật** (đổi gap/padding thấy con dãn), layer sạch. Chứng minh chuỗi không-plugin chạy. |
| **1 — IR → fig đầy đủ** (vài ngày) | `ir-to-fig` map frame/text/fills/gradient/effects/radius/stroke/absolute; wrapper clipboard; nút "Copy to Figma" (web) + endpoint daemon | 1 màn react-shadcn (bỏ icon/ảnh) → paste ra layout đúng, editable |
| **2 — Icon & ảnh** | Chốt §6#1: rasterize hay vectorNetwork; image blob registry; CLI `od ... copy-figma` | Icon & ảnh hiện đúng (theo lựa chọn đánh đổi) |
| **3 — Contract** | contract-lint trên DOM render + figma-safe preset cho react-shadcn | Báo cáo độ sạch; màn preset paste layout đúng cột (không bị grid→1 cột) |

**Round-trip test (bắt buộc, mọi phase):** `readHTMLMessage(writeOurPayload(ir))` phải
decode lại đúng → chốt trong CI để phát hiện vỡ schema sớm (rủi ro #6).

**Verify visible:** so screenshot artifact vs Figma sau paste bằng mắt (skill `verify`).

---

## 9. Quyết định cần chốt trước khi code

1. **Icon (rủi ro lớn nhất §6#1):** v1 chọn (a) rasterize, (b) vectorNetwork, hay (c) bỏ icon?
2. **Ảnh:** nhúng qua blob registry, hay v1 `--no-images`/placeholder?
3. **Hình thức:** skill thuần (thử nhanh) hay capability sản phẩm đủ UI+CLI (land 1 PR)?
4. **Contract grid/sticky:** chỉ lint+cảnh báo (v1) hay làm figma-safe preset ngay?

---

## Phụ lục A — Cấu trúc buffer `.fig` (tham khảo)

```
"fig-kiwi"            8 byte magic ASCII
version              u32 LE
[ chunk ]*           mỗi chunk = u32 length + deflate(block)
  chunk 0 = Kiwi schema (định nghĩa message — self-describing)
  chunk 1 = message data: { nodeChanges:[...], blobs:[...] }
```
Clipboard `(figma)` blob = đúng buffer này, base64. `(figmeta)` = base64 JSON
`{fileKey, pasteID, dataType:"scene"}`.

## Phụ lục B — Wrapper clipboard (phác thảo, ~30 dòng)

```ts
import { writeFigFile } from "fig-kiwi";
function toFigmaClipboardHTML(message, schema) {
  const fig = writeFigFile({ message, schema });                 // Uint8Array
  const figB64 = base64(fig);
  const metaB64 = base64(JSON.stringify(
    { fileKey: "open-design", pasteID: 0, dataType: "scene" }));
  return `<meta charset="utf-8"><div>` +
    `<span data-metadata="<!--(figmeta)${metaB64}(/figmeta)-->"></span>` +
    `<span data-buffer="<!--(figma)${figB64}(/figma)-->"></span></div>`;
}
// web: await navigator.clipboard.write([new ClipboardItem({
//   "text/html": new Blob([html], { type: "text/html" }) })]);
```

## Phụ lục C — `use_figma` MCP (automation alternative)

Nếu sau này muốn **bản tự động** (agent đẩy thẳng, không cần user paste): map IR → Plugin
API như `figma-plugin/code.js` rồi chạy qua tool `use_figma` (MCP `figma-use` đang enabled
ở [.od/mcp-config.json](.od/mcp-config.json)). Ưu: API chính thức, `createNodeFromSvg`
native (icon dễ). Nhược: cần MCP chạy, **không portable**. Hai route **dùng chung IR** nên
có thể làm song song, không xung đột.

---

## Sources

- Figma clipboard format (figmeta/figma, data-buffer, text/html): Alex Harri —
  https://alexharri.com/blog/clipboard
- Figma clipboard extractor (figmeta/figbuffer): JanOstrowka —
  https://github.com/JanOstrowka/figma-clipboard-extractor
- `fig-kiwi` (read/write .fig + readHTMLMessage): https://www.npmjs.com/package/fig-kiwi
- Phân tích cấu trúc .fig (magic, schema chunk, deflate): easylogic —
  https://easylogic.medium.com/figma-inside-fig-파일-분석-7252bef141da
- Kiwi (schema-based binary, Evan Wallace): https://github.com/evanw/kiwi
- Tham khảo importer .fig (vectorNetwork, blob) — Penpot exporter:
  https://github.com/penpot/penpot-exporter-figma-plugin ; Grida io-figma:
  https://grida.co/docs/wg/feat-fig
