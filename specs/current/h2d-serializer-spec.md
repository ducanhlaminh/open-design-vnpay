# H2D Serializer — clean-room spec (DOM → Figma "HTML to Design" JSON)

> Mục tiêu: dựng lại serializer DOM→H2D JSON **chuẩn như Figma** mà KHÔNG copy code độc
> quyền. Tài liệu này là blueprint hành vi/schema (reverse-engineer từ quan sát output +
> đặc tả CSS công khai), để cài đặt `packages/figma-h2d` clean-room.
>
> Vì sao cần: bản "Copy to Figma" hiện tại của repo (`packages/figma-clip`) tự encode buffer
> Kiwi `.fig` (nhị phân) → giòn, khó khớp schema Figma, font qua glyph-atlas. Figma **không**
> làm vậy: extension chính chủ chỉ **serialize DOM thành JSON** rồi để Figma tự dựng node lúc
> paste. Đổi sang format này = "chuẩn" + bớt phần khó nhất.

## 1. Clipboard payload (text/html)

Khi copy, ghi `ClipboardItem` với 2 type:
- `text/html`: gồm 2 `<span>` (thứ tự: meta trước, data sau), không cần `<meta charset>`:
  ```html
  <span data-metadata="<!--(figmeta)BASE64_META(/figmeta)-->"></span>
  <span data-h2d="<!--(figh2d)BASE64_DOC(/figh2d)-->"></span>
  ```
- `text/plain`: chuỗi rỗng (hoặc fallback text tuỳ ý).

Quy tắc base64: encode UTF-8 → base64 (lấy phần sau dấu `,` của một data URL `application/octet-stream`, hoặc `btoa(unescape(encodeURIComponent(s)))`).

- `BASE64_META` = base64(JSON):
  ```json
  { "dataType": "h2d", "source": "<string>", "capturedAtIso": "<ISO>",
    "h2d": { "v": 1, "origin": { "source": "<string>", "capturedAtIso": "<ISO>" } } }
  ```
- `BASE64_DOC` = base64(JSON) của **một MẢNG** các H2D document: `[doc1, doc2, ...]`
  (mỗi capture = 1 phần tử; thường chỉ 1).

> Khác biệt cốt lõi so với `figma-clip`: KHÔNG có blob `(figma)`, KHÔNG Kiwi, KHÔNG deflate.
> `dataType: "h2d"` (không phải `"scene"`).

## 2. H2D document (kết quả của `capture()`)

```ts
interface H2DDocument {
  root: H2DElementNode;            // luôn là ELEMENT_NODE
  documentTitle?: string;
  documentRect: Rect;              // {x:0,y:0,width:scrollWidth,height:scrollHeight}
  viewportRect: Rect;              // element: {scrollLeft,scrollTop,clientW,clientH}; doc: {0,0,innerW,innerH}
  devicePixelRatio: number;        // window.devicePixelRatio
  version: 2;
  assets: Record<string, Asset>;   // key = url/hash; blob → dataURL (base64) sau serialize
  fonts: Record<string, FontFamily>;
}
interface Rect { x: number; y: number; width: number; height: number; quad?: Quad }
interface Quad { p1:{x,y}; p2:{x,y}; p3:{x,y}; p4:{x,y} }  // chỉ khi có transform xiên/skew
```

### Node tree

```ts
type H2DNode = H2DElementNode | H2DTextNode;

interface H2DElementNode {
  nodeType: 1;                     // Node.ELEMENT_NODE
  id: string;                      // "h2d-node-<n>" ổn định theo WeakMap
  tag: string;                     // tagName.toUpperCase() (HTMLFormElement → "FORM")
  attributes: Record<string,string>; // allowlist (xem §6) + aria-*
  styles: Record<string,string>;   // computed styles ĐÃ LỌC default (xem §3)
  rect: Rect;                       // toạ độ viewport, có transform (xem §4)
  childNodes: H2DNode[];
  content?: string;                 // SVG: outerHTML đã bake (xem §5)
  placeholderUrl?: string;          // <canvas>: "rasterized:<n>" → asset
  pseudoElementNodes?: { before?: H2DElementNode; after?: H2DElementNode };
  pseudoElementStyles?: { placeholder?: Record<string,string> }; // input/textarea ::placeholder
  computedStyles?: Record<string,string>; // giá trị "specified" qua Typed OM (xem §3)
  variableStyles?: Record<string,string>; // CSS var bindings (optional, để sau)
  owningReactComponent?: string;    // tên component (optional, để sau — xem §7)
  // sources / selectionSourceId / figmaComponentMetadata: optional, bỏ ở v1
}

interface H2DTextNode {
  nodeType: 3;                     // Node.TEXT_NODE
  id: string;
  text: string;                    // gộp các text node liền kề
  rect: Rect;                      // bbox của Range (xem §4.text)
  lineCount: number;               // số dòng (xem §4.text)
}
```

## 3. Style filtering (`extractStyles(el, pseudo?)`)

1. `cs = getComputedStyle(el, pseudo)`.
2. Với pseudo `::before/::after`: nếu `content ∈ {none, normal, no-open-quote, no-close-quote}` → trả `null` (bỏ pseudo).
3. `styles = {}`: với mỗi cặp `[prop, default]` trong **DEFAULTS** (§3.1), nếu `cs[prop] !== default` thì giữ `styles[prop] = cs[prop]`.
4. **Typed OM** (chỉ element thật, không pseudo, nếu có `computedStyleMap`):
   - `SIZING = [width,height,minWidth,maxWidth,minHeight,maxHeight]`: lấy `map.get(dash(prop)).toString()`. Nếu == default → `delete styles[prop]`; nếu != giá trị used đã lấy ở b3 → `computedStyles[prop] = specified`.
   - `GRID = [gridTemplateColumns,gridTemplateRows,gridColumnStart,gridColumnEnd,gridRowStart,gridRowEnd,columnGap,rowGap,gridAutoFlow,gridTemplateAreas,gridAutoColumns,gridAutoRows]`: nếu specified != default && != used → `computedStyles[prop] = specified`.
   - `MARGINS = [marginTop,marginRight,marginBottom,marginLeft]`: nếu specified == `"auto"` → `styles[prop] = "auto"`.
   > Mục đích: giữ ý định gốc (`width:100%`, `margin:auto`, `grid-template:...`) thay vì giá trị px đã resolve.
5. Dọn dependent: với mỗi cạnh border `{style,width,color}`, nếu `styles[width]==null` → `delete styles[style]`, `delete styles[color]`. Tương tự `outlineWidth==null` → bỏ `outlineStyle/outlineColor`.
6. Nếu `styles.webkitTextFillColor === cs.color` → bỏ `webkitTextFillColor`.
7. Trả `{ styles, computedStyles }`. Chỉ gắn `computedStyles` vào node khi non-empty.

### 3.1 DEFAULTS table
Bảng ~190 cặp `prop → giá trị mặc định` (factual CSS initial/UA values). Xem `src/style-defaults.ts`.
Lưu ý vài giá trị "đặc thù Chromium" cần khớp: `fontFamily:"Times"`, `display:""` (rỗng → luôn giữ display), `webkitTextFillColor:""`, `transformOrigin:"auto"`, `transitionProperty:"all"`.
`dash(prop)` = camel→`kebab`, riêng `webkit*` thêm tiền tố `-` (→ `-webkit-...`).

## 4. Rect & transform (phần toán cốt lõi)

Với mỗi element:
1. `size`:
   - có transform (`rotate/scale/transform/translate != none`) hoặc đang trong ngữ cảnh transform cha → `{offsetWidth, offsetHeight}`.
   - thường → `getBoundingClientRect().{width,height}`.
   - `SVGSVGElement` → `parseFloat(cs.width)||baseVal`; `SVGGraphicsElement` → `getBBox()`; `MathMLElement` → bbox.
2. `localMatrix` (nếu element có transform): tính bằng `DOMMatrix`:
   `T(origin) · translate(translate) · rotate(rotate) · scale(scale) · matrix(transform) · T(origin)⁻¹`
   với `transform-origin` parse thành `translate3d(ox,oy,oz)`; `translate` %→px theo size; `rotate`/`scale` theo cú pháp CSS.
3. `inverseTransform` truyền xuống con = `parentInverse` kết hợp local (để con nằm trong hệ toạ độ đã "gỡ" transform cha): xem `Wt(parentInverse, localMatrix, {x,y})` = `Tr(x,y)·localMatrix⁻¹·Tr(-x,-y)·parentInverse`.
4. `rect` cuối:
   - nếu không transform & không parentInverse → `{x:bcr.x, y:bcr.y, width, height}`.
   - có transform: lấy tâm `bcr`, transform ngược qua `parentInverse`, đặt lại `{x,y}` quanh size gốc (hàm `Ta`). Nếu local matrix có thành phần xiên (a≠1/b≠0/c≠0/d≠1...) → thêm `rect.quad` (4 điểm, hàm `Ra`).

### 4.text — text node rect + lineCount (`measureText(node, inverse, lineBoxHeight)`)
1. Tạo `Range`: nếu mảng text node liền kề → setStart(first,0)/setEnd(last,len); else `selectNode`.
2. `bcr = range.getBoundingClientRect()`; `rects = range.getClientRects()` (lọc width|height>0).
3. `vertical = writingMode của commonAncestor bắt đầu "vertical"`.
4. Nếu có `inverse` & rects: giải bbox theo AABB:
   - nghịch đảo 2×2 của inverse (`ro`).
   - mỗi client rect: lấy tâm, transform qua inverse, giải lại width/height (nếu biết `lineBoxHeight` → `so` dùng chiều cao dòng; else `ao` giải AABB tổng quát), gom union (`lo`).
   - `lineCount` = `countLines(rects, vertical)` (gom theo trục, đếm cụm tâm cách nhau ≥1px).
5. Fallback: dùng `bcr` + `countLines`.

> `lineBoxHeight` đến từ FontCollector (đo qua canvas, §an dưới); nếu null thì AABB tổng quát.

## 5. SVG, canvas, ảnh, video
- **SVG**: `content = bakedOuterHTML(el)`: clone, set width/height từ computed nếu là px, và **bake** mọi thuộc tính presentation (fill, stroke, opacity, ... — bảng `SVG_PRESENTATION_DEFAULTS`) khác default vào attribute tương ứng (đệ quy theo children). Không serialize children SVG thành H2D node.
- **canvas**: `placeholderUrl = images.addCanvas(el)` → rasterize `toBlob`/`convertToBlob`, key `rasterized:<n>`.
- **img**: `images.addImage(currentSrc)`; collect background-image `url("...")` từ styles; video poster.
- Asset map (`getBlobMap`): fetch URL → Blob (timeout 8s); avif/heif/heic → convert sang png qua canvas; remote có thể skip (option). `serialize()` (Jt) đổi mỗi blob → dataURL base64 trước khi `JSON.stringify`.

## 6. attributes allowlist
Giữ thuộc tính tên ∈ {alt, checked, currentSrc, disabled, for, href, id, multiple, placeholder, poster, readonly, rel, required, role, selected, target, title, type, value} **hoặc** bắt đầu `aria-`. Thêm: `poster`/`currentSrc` cho video/img; `type` cho input.

Bỏ hẳn element: `HEAD, SCRIPT, STYLE, NOSCRIPT`; element có `data-h2d-ignore="true"`; `HTMLScriptElement`.

## 7. Không lấy ở v1 (giữ optional, thêm sau)
- `owningReactComponent` (dò React fiber `_debugOwner` / `_fgT`) — để đặt tên layer; phụ thuộc nội bộ React, bỏ ở v1.
- `sources` / `selectionSourceId` / `variableStyles` (CSS var scopes) / `figmaComponentMetadata` / `sourceDataMap` (devtools).
- Pseudo `::placeholder`, shadow DOM, `<slot>` flatten: làm sau khi core ổn.

## 8. Public API (clean-room module)
```ts
// browser-only (cần DOM)
captureElement(el: Element, opts?: CaptureOptions): Promise<H2DDocument>
captureDocument(doc?: Document, opts?: CaptureOptions): Promise<H2DDocument>
serializeDocument(doc: H2DDocument): Promise<string>        // blobs→dataURL, JSON.stringify
toFigmaClipboardHtml(docs: H2DDocument[], meta?): Promise<{html:string; plain:string}>
writeFigmaClipboard(docs: H2DDocument[]): Promise<void>      // navigator.clipboard.write
```

## 9. Validation — ĐÃ CHẠY (2026-06-24)

Clean-room module `packages/figma-h2d` đã: **typecheck pass**, **esbuild bundle 39KB**, và chạy
qua headless Chromium (`tests/harness.html` + `tests/harness-iframe.html`) — **mọi check thật pass**:
tree đúng, `root.rect.width` khớp `getBoundingClientRect`, paragraph `lineCount>1`, SVG `content`
baked, phần tử `rotate(12deg)` sinh `rect.quad`, `::before` bắt được, fonts thu được, payload có
`(figh2d)`+`(figmeta)`. Quan trọng: **capture DOM bên trong `<iframe>` same-origin chạy đúng**
(realm-aware) — đúng kịch bản web "Copy to Figma".

> Validate dứt điểm "chuẩn như Figma" = paste payload thật vào Figma desktop/web và so mắt
> (skill `verify`). Khuyến nghị thêm bước CI: paste round-trip hoặc diff cấu trúc khi đổi schema.

### Realm-aware (bắt buộc cho web)
Web render artifact trong `<iframe srcdoc>` same-origin (preview iframe live là cross-origin,
không đọc được DOM). Serializer lấy `realm = {doc, win}` từ `el.ownerDocument` và dùng
`win.getComputedStyle` / `doc.createRange` / `win.CSSStyleSheet` … — nếu dùng global của realm cha
sẽ `WrongDocumentError` (Range.selectNode) và lỗi adopt stylesheet xuyên realm. `captureElement`
nhận element từ iframe và tự suy ra realm.

## 10. Wiring vào web (sẵn để dán)

**Bước build**: thêm `"@open-design/figma-h2d": "workspace:*"` vào `apps/web/package.json` deps →
`pnpm install` → `pnpm --filter @open-design/figma-h2d build`. (Next đã import nhiều workspace pkg
khác; nếu cần thì thêm vào `transpilePackages`.)

**`apps/web/src/lib/html-to-h2d.ts`** (mirror `html-to-ir.ts`'s iframe harness):
```ts
import { captureElement, toFigmaClipboardHtml } from "@open-design/figma-h2d";

export async function htmlToFigmaClipboard(html: string, width = 430): Promise<string> {
  if (!html?.trim()) throw new Error("Không có nội dung artifact để trích xuất");
  const tmp = document.createElement("iframe");
  tmp.setAttribute("aria-hidden", "true");
  tmp.style.cssText =
    `position:fixed;left:-100000px;top:0;width:${Math.max(320, Math.round(width))}px;` +
    "height:5000px;border:0;visibility:hidden;pointer-events:none;";
  document.body.appendChild(tmp);
  try {
    await new Promise<void>((res) => { tmp.onload = () => res(); tmp.srcdoc = html; });
    const win = tmp.contentWindow, doc = tmp.contentDocument;
    if (!win || !doc) throw new Error("Không tạo được iframe trích xuất");
    try { await (doc.fonts?.ready ?? Promise.resolve()); } catch {}
    await new Promise((r) => setTimeout(r, 180));
    const rootEl = doc.body.firstElementChild ?? doc.body;
    const figDoc = await captureElement(rootEl, { skipRemoteAssetSerialization: false });
    const { html: payload } = await toFigmaClipboardHtml([figDoc], { source: "open-design" });
    return payload; // text/html, paste thẳng vào Figma (dataType: h2d)
  } finally {
    tmp.remove();
  }
}
```

**`FileViewer.tsx` `copyToFigma`** — thay nhánh daemon Kiwi bằng H2D client-side:
```ts
const payload = (async () => {
  const { htmlToFigmaClipboard } = await import("../lib/html-to-h2d");
  return new Blob([await htmlToFigmaClipboard(html, previewWidth)], { type: "text/html" });
})();
// phần navigator.clipboard.write([...]) giữ nguyên
```
Bỏ phụ thuộc `extractIRFromHTML` + `submitFigmaClipboard` ở nhánh này (không cần daemon nữa).

## 11. Dual-track CLI (ràng buộc AGENTS.md) — quyết định còn lại
H2D engine cần DOM → **không chạy được trong daemon Node**. Hiện route `/api/artifacts/figma-clipboard`
+ `od artifact copy-figma` dùng pipeline Kiwi (`figma-clip`). Hai lựa chọn để giữ dual-track:
- (a) **Web dùng H2D** (chuẩn hơn) + **CLI/daemon vẫn Kiwi** tạm thời — cảnh báo lệch output giữa 2 surface.
- (b) Cho daemon chạy H2D qua **Playwright** (repo đã có cho e2e): daemon mở headless, inject artifact,
  gọi `captureElement` → trả payload. Thống nhất output cả 2 surface. Tốn công hơn.
