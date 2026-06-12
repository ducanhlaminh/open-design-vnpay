# Copy to Figma — HTML → clipboard gốc Figma (spec-plan)

> Spec triển khai cho tính năng **"Copy to Figma"**: artifact HTML (output
> `react-shadcn` hoặc HTML tuân Contract) → một nút bấm → clipboard mang **định dạng
> gốc của Figma** → user **Cmd+V vào Figma ra node editable, KHÔNG cần plugin/MCP**.
>
> Phân tích & cơ sở kỹ thuật đầy đủ: [HTML-TO-FIGMA-INTEGRATION.md](../../HTML-TO-FIGMA-INTEGRATION.md).
> Tài liệu này là **WHAT/HOW triển khai** (phase, file, acceptance). Khi hai bên lệch,
> [AGENTS.md](../../AGENTS.md) là nguồn chuẩn về boundary.

## Purpose

Cho phép một màn UI sinh trong open-design được **handoff sang Figma dạng portable**:
node thật, Auto Layout, layer sạch để designer làm tiếp. "Portable" = không lệ thuộc
MCP/plugin; payload có thể lưu/gửi, máy nào Cmd+V cũng ra.

Cơ chế: tái dùng pipeline `IR` của figma-skill (`extract.js` + `IR-SCHEMA.md`), thay
mảnh "paste vào plugin" bằng **encode buffer `.fig` (Kiwi) → ráp clipboard `text/html`**.
Xem định dạng đã xác minh ở tài liệu phân tích §2.

## Kiến trúc 2 mode prototype (★ chốt với user 2026-06-08)

open-design-vnpay có **2 chế độ sinh prototype**, năng lực Figma **chỉ** ở chế độ HTML:

| Mode | Cơ chế | Copy to Figma |
|---|---|---|
| **HTML** (thuần, sạch) | HTML/CSS **flexbox theo Contract** (figma-skill `CONTRACT.md`) | ✅ **CÓ** (đường duy nhất ra Figma) |
| **HTML + react-shadcn** (hiện tại) | `screen.json` → component VNPAY (Base UI) qua shell.html | ❌ **KHÔNG** — giữ nguyên, không đụng |

**Vì sao chỉ HTML mode export** (phân tích đầy đủ ở chat 2026-06-08 + [HTML-TO-FIGMA-INTEGRATION.md](../../HTML-TO-FIGMA-INTEGRATION.md) §5):
react-shadcn render DOM tùy ý — `screen.json` mẫu đã dùng `grid`/`grid-cols-`/`sticky`;
multi-font (Inter + **Bricolage** + **JetBrains**, atlas chỉ Inter); component portal/overlay
(Dialog/Dropdown/Select/Sheet/Popover/Tooltip) snapshot tĩnh sai vị trí; export làm **mất
"component verbatim"** (giá trị cốt lõi của nó). Ép convert = giải lại bài "HTML rác bất kỳ"
mà figma-skill cố tình né. → **HTML mode Contract-by-construction** mới deterministic.

**Hệ quả cho spec này:** nguồn HTML cho pipeline figma-clip = **artifact HTML mode**, KHÔNG
phải react-shadcn. Do đó **bỏ** "contract-lint + figma-safe preset trên react-shadcn"
(D7/R6 cũ) — không còn liên quan; thay bằng "HTML mode tuân Contract sẵn".

Recommended defaults cho **HTML mode** (xác nhận/đổi nếu cần):
- **Brand:** dùng **token VNPAY** (giá trị từ `vnpay-glass.css`) render bằng div/flex thuần
  (không component React) → vẫn "chất VNPAY" nhưng Contract-clean.
- **UI building blocks:** bộ **snippet Contract-clean curated** (button/card/input/nav = div
  flex theo token) + cho phép HTML tự do theo Contract.
- **Hiện thực:** **2 skill riêng** — giữ `react-shadcn` nguyên vẹn, thêm skill mới
  `html-prototype` (`od.mode: prototype`, gắn cờ figma-exportable).
- **Chọn mode:** trước mắt theo intent/trigger (agent chọn skill); toggle tường minh ở
  NewProject là follow-up web (Phase 2).

## PoC results — Phase 0 ĐÃ XONG (2026-06-08, verified trên Figma thật)

> PoC tại `/Users/anhnd13/Documents/figma-skill/figma-clip-poc` (rời repo). Tất cả test
> paste vào file Figma thật `pF6KX5dr1HxVsr89uyYBE9` của user và xác nhận bằng mắt + MCP.

**Khả thi: ĐÃ CHỨNG MINH end-to-end.** Bấm nút → clipboard → Cmd+V → node editable, không plugin/MCP.

Phát hiện kỹ thuật (khác giả định ban đầu — phải cập nhật mọi chỗ nói "deflate/v15"):

1. **Container format hiện hành = version 106** (không phải 15). Archive vẫn `"fig-kiwi"` +
   u32 version + `[u32 size + data]*`, **2 chunk**: `file[0]=schema` (nén **DEFLATE**),
   `file[1]=message` (nén **ZSTD** — Figma đã đổi từ deflate→zstd). Node 24 có
   `zlib.zstdCompressSync/DecompressSync` xử lý được.
2. **`fig-kiwi@0.0.1` không dùng trực tiếp được:** (a) bản CJS `dist/index.js` là IIFE
   **không export gì** → phải import `fig-kiwi/dist/index.esm.js`; (b) `readHTMLMessage`
   của nó assume deflate cho cả 2 chunk + version 15 → **fail với format v106/zstd**.
   → Ta tự viết `figclip` (read/write) chỉ mượn `FigmaArchiveParser` + `kiwi-schema`.
3. **`kiwi-schema` phải nâng lên 0.5.0** (0.4.7 lỗi "Invalid type -8" khi decode schema mới).
4. **Marker clipboard bị escape** (`&lt;!--(figma)`) khi browser capture → unescape trước parse.
5. **Round-trip pixel-perfect:** decode 45 node → re-encode → paste ra **đúng y** landing page
   (text/màu/gradient/emoji/Auto Layout). Frame/fill/gradient/radius/effect/absolute **synth
   từ đầu render hoàn hảo**.
6. **TEXT là mấu chốt:** Figma paste **chỉ render từ `derivedTextData`** (mỗi text có
   `glyphs[]` 1 entry/ký tự, mỗi glyph trỏ `commandsBlob` = outline vector trong `blobs`).
   - Đổi `characters` mà giữ glyph cũ → hiện **chữ cũ**. Xoá `derivedTextData` → **trống**.
     Figma **KHÔNG** tự layout lại từ `characters` khi paste, **KHÔNG** dùng font của nó để vẽ.
   - Text node bắt buộc `visible:true` + `opacity:1` (thiếu → ẩn).
7. **★ Lời giải text = GLYPH-ATLAS (đã chứng minh):** blob outline là **em-normalized,
   độc lập kích thước**. → map `ký tự → {blob, advance}` harvest từ payload Figma thật,
   rồi **lắp text mới** bằng cách tính advance/vị trí và **tái dùng nguyên blob của Figma**.
   Đã synth chữ "Acme" từ đầu → paste ra **text MỚI editable đúng**. **Không cần parse
   font, không cần encode format byte của blob** → bền, né hẳn rủi ro "bake glyph từ TTF".
8. **★ Pipeline đầy đủ ĐÃ THÔNG (verified):** viết `text-layout` (atlas → derivedTextData,
   có **wrap nhiều dòng**) + `ir-to-fig` (IR → message: frame, Auto Layout stack*/sizing,
   fill solid, radius, stroke, **shadow**, text). Test end-to-end 2 đường, đều paste ra
   Figma đúng & editable:
   - IR tay → fig → paste: card (title + body wrap 2 dòng + nút) ✅
   - **`sample.html` → `extract.js` (Playwright) → IR → fig → paste**: khớp y HTML gốc ✅
   - **Atlas đầy đủ verified:** harvest **242 ký tự × Regular+Bold** (Latin+số+dấu+tiền
     tệ+**Tiếng Việt** precomposed); card tiếng Việt (`₫€£`, dấu, `—`, `@?`) paste ra
     Figma **render đúng 100%**; ký tự ngoài atlas (vd `≈`) → cảnh báo + bỏ qua graceful. ✅
   - **Gradient verified:** fill `GRADIENT_LINEAR/RADIAL/ANGULAR` (stops + transform matrix
     từ IR) — header + nút gradient paste ra Figma render đúng. ✅
   - **Image verified:** `IMAGE` paint, bytes vào blob, **hash = SHA-1 (20 byte)** của bytes
     ảnh (KHÔNG phải MD5 16 byte — MD5 bị Figma loại, hash về 0). PNG nhúng render đúng. ✅
   icon v1 skip (warn).

## Decisions (đã chốt + default khuyến nghị)

| # | Quyết định | Trạng thái |
|---|---|---|
| D1 | Hướng giao = clipboard "Copy to Figma" (paste tay), giữ editable Auto Layout | ✅ **chốt với user** |
| D2 | Encoder = **`figclip` tự viết** (read/write, deflate-schema + zstd-message, v106), mượn `FigmaArchiveParser` + `kiwi-schema@0.5.0`. KHÔNG dùng `fig-kiwi.readHTMLMessage/writeHTMLMessage` (assume deflate/v15) | ✅ **PoC verified** |
| D3 | Schema nguồn = **pin snapshot từ 1 copy thật** (decode lấy `schema`); refresh khi Figma bump format | ✅ verified |
| D8 | **★ TEXT = glyph-atlas** (tái dùng blob outline của Figma), KHÔNG bake từ font TTF | ✅ **PoC verified** |
| D4 | **Icon (SVG): VECTOR thật.** Reverse-engineer `vectorNetworkBlob` của Figma (decode + **round-trip byte-perfect** từ 1 vector thật): `u32 nV,nS,nR` + vertices`{style,x,y}` + segments`{style,vA,tangentA,vB,tangentB}` (tangent=control offset cubic) + regions`{winding,loops}` (NONZERO=1, EVENODD=2). Extractor parse SVG (path/rect/circle/ellipse/line/poly + `<g>` qua **CTM**, primitive→path, computed fill/stroke/fill-rule) → IR `paths[]` → lib build VECTOR node. **Nét mọi mức zoom + editable.** SVG `<text>/<image>/<use>`/filter → raster fallback (PNG 8x) | ✅ **verified trên Figma thật** (lib `svg-path`+`vecnet`, extractor `svgToPaths`) |
| D5 | **Ảnh:** nhúng bytes vào blob, hash **SHA-1 (20 byte)**, `IMAGE` paint `scaleMode FILL`; ảnh lỗi → placeholder xám + warn | ✅ **PoC verified** |
| D6 | **Hình thức:** Phase 0 PoC rời ✅ → Phase 1 **skill thuần** → Phase 2 **capability sản phẩm** (UI+CLI) | ⚠️ default — confirm |
| D7 | ~~Contract-lint + figma-safe preset trên react-shadcn~~ → **BỎ**. Thay bằng **2-mode** (xem "Kiến trúc 2 mode"): nguồn Figma = skill mới `html-prototype` (Contract-by-construction), react-shadcn KHÔNG export | ✅ **chốt với user** |
| D9 | **HTML mode = skill `html-prototype` riêng** (token VNPAY + snippet Contract-clean); react-shadcn giữ nguyên | ✅ chốt (default — đổi nếu cần) |

> Bước ngoặt: D8 (glyph-atlas) hạ rủi ro text từ "rất khó/giòn" xuống "trung bình".
> D7→2-mode bỏ luôn bài toán convert react-shadcn (grid/sticky/multi-font/portal). Icon
> (D4) giờ là điểm khó còn lại; HTML mode kiểm soát icon = inline SVG đơn giản.

## Target shape

```
[Phase 0]  PoC encoder (rời repo)
[Phase 1]  packages/figma-clip (lib thuần)  +  skills/html-to-figma  (skill thuần)
[Phase 2]  daemon endpoint /api/.../figma-clipboard  +  web nút "Copy to Figma"  +  od CLI
[Phase 3]  icon (raster) + image blob + contract-lint + figma-safe preset
```

Thư mục dự kiến (Phase 1–2):

```
packages/figma-clip/                 # lib thuần TS, KHÔNG phụ thuộc daemon/web/Next
├── src/
│   ├── ir-to-fig.ts                 # IR (IR-SCHEMA) → Kiwi message (nodeChanges)
│   ├── clipboard-wrap.ts            # message+schema → writeFigFile → text/html payload
│   ├── fig-schema.ts                # schema snapshot (D3) + loader
│   └── index.ts
└── tests/
    └── roundtrip.test.ts            # readHTMLMessage(write(ir)) phải decode lại đúng

skills/html-to-figma/                # Phase 1 — skill thuần
├── SKILL.md
├── assets/extract.js                # COPY từ figma-skill/extractor (Playwright, IR)
├── scripts/copy-figma.mjs           # extract.js → IR → figma-clip → ghi <name>.figma.html
└── references/{contract.md,ir-schema.md}

# Phase 2 — capability sản phẩm (dual-track, land 1 PR)
apps/daemon/src/figma-clipboard-routes.ts   # POST /api/projects/:id/figma-clipboard
apps/daemon/src/cli.ts                       # od artifact copy-figma (SUBCOMMAND_MAP)
packages/contracts/src/api/figma-clipboard.ts# DTO request/response
apps/web/src/...FileViewer toolbar           # nút "Copy to Figma" → clipboard.write
apps/web/src/providers/daemon.ts             # submitFigmaClipboard()
```

> Boundary: `packages/figma-clip` thuần TS (không Next/Express/SQLite) — dùng được cả
> daemon lẫn script skill. Extractor (Playwright) chạy **ngoài process** (spawn) để daemon
> không nuốt browser dependency.

## Data contracts

**IR** — GIỮ NGUYÊN `IR-SCHEMA.md` của figma-skill (hợp đồng dữ liệu, không đổi).

**Endpoint (Phase 2)** — `packages/contracts/src/api/figma-clipboard.ts`:

```ts
// POST /api/projects/:id/figma-clipboard
interface FigmaClipboardRequest {
  htmlPath: string;          // artifact HTML trong project (vd shell.html)
  selector?: string;         // root CSS selector (mặc định body.firstElementChild)
  images?: boolean;          // default false (D5)
  icons?: "skip" | "raster"; // default "skip" (D4)
}
interface FigmaClipboardResponse {
  html: string;              // payload text/html sẵn sàng clipboard.write
  warnings: string[];        // cảnh báo extractor + contract-lint (D7)
  stats: { nodes: number; bytes: number; images: number; iconsDropped: number };
}
```

Web copy: `navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([res.html], {type:"text/html"}) })])`.

## IR → Kiwi message — mapping cốt lõi

Bảng đầy đủ ở tài liệu phân tích §4. Tóm tắt field .fig (khác Plugin API):
`stackMode / stackSpacing / stackPadding* / stackPrimaryAlignItems /
stackCounterAlignItems / stackChildPrimaryGrow / stackChildAlignSelf /
stackPositioning + horizontal/verticalConstraint`; paint `SOLID|GRADIENT_*|IMAGE`;
`effects[]`; `rectangleCornerRadii*`; TEXT `textData + fontName` (Inter, weight→style).

---

## Phase 0 — PoC ✅ XONG (xem "PoC results" ở đầu file)

PoC tại `figma-clip-poc/`: `figclip.mjs` (read/write v106 deflate+zstd), `decode.mjs`
(rút schema + dump node thật + round-trip), `build-clip*.mjs` (synth frame + text),
`build-atlas.mjs` (★ glyph-atlas). Đã verified trên Figma thật: round-trip pixel-perfect,
frame synth OK, text synth qua atlas ra chữ "Acme" mới editable. **Cổng go/no-go = GO.**

## Phase 2 — Dual-track sản phẩm ✅ XONG (2026-06-08)

> **Kiến trúc chốt: extract HTML→IR ở client (hướng A), daemon chỉ làm IR→.fig (thuần,
> không Playwright).** Cả web + CLI POST `{ir}` lên cùng endpoint.
> - `packages/contracts/src/api/figma-clipboard.ts`: `FigmaClipboardRequest{ir,fontSizeFallback?}`
>   + `FigmaClipboardResponse{html,warnings,stats}` (plain TS, export trong index.ts).
> - **Daemon**: `POST /api/artifacts/figma-clipboard` (trong `registerProjectArtifactRoutes`,
>   project-routes.ts) → `irToClip(ir)` từ `@open-design/figma-clip` (đã thêm workspace dep) →
>   trả payload + stats. Verified: IR (extract `--ir-only`) → irToClip → payload 49.5KB, 3 vectors.
> - **CLI**: `od figma copy <artifact.html>` (cli.ts `SUBCOMMAND_MAP.figma`) — spawn
>   `copy-figma.mjs --ir-only` (Playwright extract → IR) → POST `{ir}` lên daemon → ghi
>   `<name>.figma.html` + `<name>.copy.html`. Hỗ trợ `--json`/`--selector`/`--out`/`--daemon-url`.
> - **Web**: nút **"Copy to Figma"** trên toolbar HtmlViewer (FileViewer.tsx). `apps/web/src/lib/
>   html-to-ir.ts` = `walkInPage` **verbatim** từ extract.cjs (inject vào iframe qua
>   `win.Function`, chạy với getComputedStyle/getCTM của iframe) + embed image (fetch→base64).
>   `submitFigmaClipboard()` (providers/daemon.ts) POST `{ir}` → `navigator.clipboard.write`.
>   i18n 4 key × 19 locale.
>   - **Gotcha cross-origin (đã xử lý):** iframe preview live do daemon serve ở origin khác web
>     → đọc DOM bị SecurityError. Fix: `extractIRFromHTML(source)` render `source` (HTML artifact
>     đang hiển thị) vào **iframe srcDoc tạm same-origin** rồi extract. Đồng thời clipboard dùng
>     **ClipboardItem(Promise)** gọi đồng bộ trong cú click (tránh "document not focused").
> - Gate: `pnpm guard` ✓ · `pnpm typecheck` (repo) ✓ · figma-clip 5 test ✓.

## Phase 1 — Core lib + glyph-atlas + skill thuần ✅ XONG (2026-06-08)

> **Đã port vào repo + verified:**
> - `packages/figma-clip` (lib thuần TS): `figclip` (read/write v106, **node:zlib** raw-deflate
>   + zstd — bỏ `fig-kiwi`/`pako`), `text-layout` (atlas → derivedTextData, wrap), `ir-to-fig`
>   (frame/autolayout/solid+gradient/radius/stroke/shadow/text/image), `scaffold` (schema+
>   DOCUMENT/CANVAS pin trong `assets/snapshot.json`), `assets/glyph-atlas.json` (242×Reg/Bold).
>   `pnpm --filter @open-design/figma-clip test` xanh (4 test: roundtrip, glyph thiếu, image
>   SHA-1, layout Việt). build + dist smoke OK.
> - `skills/html-to-figma`: `assets/extract.cjs` (vendored extractor + `svgToPaths` parse SVG
>   trong browser → IR `paths[]`), `scripts/copy-figma.mjs` (extract → figma-clip →
>   `<name>.figma.html` + `<name>.copy.html`), `SKILL.md`, `references/{contract,ir-schema}.md`.
>   Chạy thật trên card Contract-clean → 0 warning.
> - **Icon VECTOR** (D4): `src/svg-path.ts` (SVG `d` → M/L/C tuyệt đối, Q/A→cubic) +
>   `src/vecnet.ts` (build+encode `vectorNetworkBlob`). Verified trên Figma thật: icon
>   filled + stroke nét + editable. Raster (PNG 8x) chỉ còn là fallback.
> - `skills/html-prototype`: `SKILL.md` (output discipline), `assets/tokens.css` (token VNPAY
>   hex Contract-clean), `references/contract.md`.
> - `scripts/guard.ts`: allowlist `figma-clip/esbuild.config.mjs` + pattern skill node-scripts.
> - `pnpm guard` + `pnpm typecheck` (repo) xanh.

### Kế hoạch gốc (giữ để tham chiếu)

Tasks:
1. **Bootstrap glyph-atlas (★ mới, D8):** soạn 1 Figma text chứa **toàn bộ charset cần**
   (Latin + Việt + số + dấu câu) cho từng style Inter (Regular/Medium/SemiBold/Bold) →
   copy → `decode` → harvest `char→{commandsBlob bytes, advance}` per style → lưu
   `assets/glyph-atlas.json` (+ blob bytes). Đây là dữ liệu pin, refresh khi đổi font.
2. `packages/figma-clip`: port PoC thành lib thuần TS:
   - `figclip.ts` (read/write v106: deflate-schema + **zstd-message**, mượn `FigmaArchiveParser` + `kiwi-schema@0.5.0`).
   - `ir-to-fig.ts`: IR → nodeChanges (frame/fills/gradient/effects/radius/stroke/absolute).
   - `text-layout.ts`: IR text → `derivedTextData` qua **atlas** (advance→position, baselines,
     layoutSize, remap blob); `visible:true`+`opacity:1` bắt buộc.
   - `fig-schema.ts` (schema snapshot), `clipboard-html.ts` (ráp `(figma)/(figmeta)` + 2 span), `index.ts`.
   - v1 **bỏ icon** (placeholder), **bỏ ảnh** (`--no-images`).
3. `tests/roundtrip.test.ts`: encode IR mẫu → decode lại → assert; + test atlas synth 1 text.
4. **Skill `html-prototype` (★ nguồn HTML mode, D9):** sinh prototype **HTML/CSS flexbox
   tuân Contract** (token VNPAY + snippet Contract-clean: button/card/input/nav = div flex;
   icon = inline SVG). Đây là **đường input duy nhất** đi tiếp Figma. SKILL.md = "output
   discipline" theo `CONTRACT.md` (giống cách react-shadcn kỷ luật theo screen.json).
   - react-shadcn **không đụng tới**.
5. `skills/html-to-figma` (export): COPY `extract.js`; `scripts/copy-figma.mjs` = extract →
   IR → `figma-clip` → ghi `<name>.figma.html`; SKILL.md. Extractor **resolve Playwright
   động** (KHÔNG hardcode path như `react-shadcn/builder/shot.mjs`). Chỉ chạy trên artifact
   **html-prototype** (Contract-clean), không chạy trên react-shadcn.

**Acceptance:**
- 1 màn **html-prototype** → `node copy-figma.mjs <artifact.html>` → mở `<name>.figma.html`,
  copy, **paste vào Figma ra layout + TEXT đúng & editable** (Contract-clean nên không lệch).
- `pnpm --filter @open-design/figma-clip test` xanh (round-trip + atlas text).
- Báo `warnings` cho ký tự ngoài atlas (coverage gap) thay vì im lặng bỏ.

## Phase 2 — Capability sản phẩm: dual-track UI + CLI + ảnh (vài ngày)

> Bắt buộc land **cùng 1 PR** cả 3 surface ([AGENTS.md](../../AGENTS.md) "Capability exposure").

Tasks:
1. `packages/contracts/src/api/figma-clipboard.ts`: DTO ở trên.
2. `apps/daemon/src/figma-clipboard-routes.ts`: `POST /api/projects/:id/figma-clipboard` —
   spawn extractor (subprocess) → `figma-clip` → trả payload + warnings + stats. Đăng ký ở `server.ts`.
3. `apps/web`: nút **"Copy to Figma"** trên toolbar FileViewer artifact → `submitFigmaClipboard`
   (`providers/daemon.ts`) → `clipboard.write` → toast. i18n key 18 locale.
4. `apps/daemon/src/cli.ts`: `od artifact copy-figma <html> [--selector] [--images]
   [--icons skip|raster] [--out -|file] [--json]` qua `SUBCOMMAND_MAP`; hỗ trợ
   `--prompt-file`/stdin theo chuẩn repo.
5. **Ảnh (D5):** nhúng ảnh vào blob/image-registry của message; cờ `images:true`.

**Acceptance:**
- Web: bấm nút → toast → Cmd+V Figma ra màn có ảnh đúng.
- CLI: `od artifact copy-figma shell.html --images --out clip.html` → file paste được ở máy khác (portable).
- Cả hai gọi **cùng** `/api/projects/:id/figma-clipboard`.
- PR template: tick **cả** UI lẫn CLI; kèm screenshot entry point.

## Phase 3 — Icon, vector & atlas mở rộng

Tasks:
1. **Icon (D4):** điểm khó còn lại. v1 bỏ (placeholder); ưu tiên đánh giá:
   (a) atlas-hoá icon (harvest blob vector của icon từ Figma như glyph-atlas), hoặc
   (b) rasterize inline `<svg>` → PNG image paint (editable-enough), hoặc
   (c) `use_figma` chỉ cho icon. Chọn theo kết quả thử.
2. **Atlas mở rộng:** đủ charset Việt/số/dấu × các style; CI check coverage; cảnh báo glyph thiếu.
3. **Contract-guard trong `html-prototype`:** vì HTML mode tự sinh, đặt guard NGAY KHI SINH
   (không cho grid/sticky/wrap lọt ra) thay vì lint sau — Contract-by-construction.

**Acceptance:**
- Màn html-prototype có icon → paste ra icon hiện đúng (theo lựa chọn D4).
- Text Việt/số/dấu render đủ; glyph ngoài atlas → warning rõ.

---

## Risks & mitigations

| | Rủi ro | Giảm thiểu |
|---|---|---|
| R1 | **Icon/SVG** không có `createNodeFromSvg` ở clipboard | điểm khó CÒN LẠI (D4): v1 bỏ; sau atlas-hoá icon / vectorNetwork / `use_figma` |
| R2 | Ảnh phải vào blob/image-registry thủ công | D5: v1 no-images; sau nhúng |
| R3 | **Format drift** (đã thấy v15→v106, deflate→zstd) | payload tự mang schema + Kiwi compat; pin `kiwi-schema@0.5.0`; **round-trip test CI**; refresh atlas/schema khi Figma bump |
| R4 | `fig-kiwi@0.0.1` hỏng (CJS rỗng, deflate/v15 only) | KHÔNG dùng read/writeHTMLMessage của nó; tự `figclip` (ESM-import, zstd) |
| R5 | Browser clipboard cần gesture + secure context | Nút bấm + localhost/https; xử lý xin quyền clipboard-write |
| R6 | ~~Output react-shadcn không sạch Contract~~ → **loại bỏ** bằng 2-mode (D7): react-shadcn KHÔNG export; nguồn Figma = `html-prototype` Contract-by-construction |
| R7 | **TEXT** — Figma render từ `derivedTextData`, không recompute | **GIẢI bằng glyph-atlas (D8, đã verified)**; rủi ro còn lại = coverage |
| R8 | **Atlas coverage** — ký tự ngoài atlas không render | Bootstrap atlas đủ charset (Latin+Việt+số+dấu)×4 style; `warnings` khi gặp ký tự thiếu; kerning bỏ qua (drift nhỏ chấp nhận) |

## Out of scope (v1)

- Map `data-figma-component` → instance Design System thật trong Figma (Phase 4 sau).
- Vòng đo screenshot-diff tự động (pixelmatch).
- Batch nhiều màn / nhiều artifact một lần.
- Bản `use_figma` tự động (giữ làm alternative — Phụ lục C của tài liệu phân tích).

## Validation (theo AGENTS.md)

- `pnpm guard`, `pnpm typecheck`, `pnpm --filter @open-design/figma-clip test`.
- Phase 2: `pnpm --filter @open-design/web typecheck/build`, `--filter @open-design/daemon test`.
- **Human verify (visible):** so screenshot artifact vs Figma sau paste (skill `verify`);
  seed dữ liệu chỉ qua API thật, không backdoor.
- Bug follow-up: red spec trước (round-trip hoặc e2e HTTP boundary) theo playbook repo.

## References

- Tài liệu phân tích: [HTML-TO-FIGMA-INTEGRATION.md](../../HTML-TO-FIGMA-INTEGRATION.md)
- figma-skill: `/Users/anhnd13/Documents/figma-skill` (`extractor/extract.js`,
  `figma-plugin/code.js`, `IR-SCHEMA.md`, `CONTRACT.md`)
- Định dạng clipboard: https://alexharri.com/blog/clipboard ·
  https://github.com/JanOstrowka/figma-clipboard-extractor
- Encoder: `fig-kiwi` https://www.npmjs.com/package/fig-kiwi · Kiwi
  https://github.com/evanw/kiwi
- Importer tham khảo (vectorNetwork/blob): Penpot
  https://github.com/penpot/penpot-exporter-figma-plugin · Grida https://grida.co/docs/wg/feat-fig
