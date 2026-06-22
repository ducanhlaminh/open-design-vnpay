---
name: react-shadcn
description: |
  Sinh artifact UI từ một CÂY CONTENT JSON (cấu trúc nested của màn hình), render
  bằng React 19 + Tailwind v4 với bộ component VNPAY thật (Base UI + radix-ui),
  VERBATIM — KHÔNG port tay, KHÔNG HTML thuần. Output per màn = **DUY NHẤT `screen.json`**
  (cây content agent biên tập); KHÔNG ghi shell.html / shell-light.html / brand.css / index.html
  cạnh artifact. Host `preview-runtime-v3` (canvas Open Design) fetch screen.json, đệ quy cây
  node, mount component theo slug — đúng cơ chế ScreenRenderer của design-v3 — và tự resolve theme
  (dark/light). `assets/shell.html` chỉ là harness dev/verify TRONG skill, KHÔNG ship per-artifact.
  Compose tốt với taste-skill / gpt-taste để có creative direction.
triggers:
  - "react shadcn"
  - "shadcn html"
  - "vnpay ui"
  - "base ui"
  - "json screen"
  - "screen renderer"
  - "design artifact"
  - "creative ui"
  - "graph screen"
  - "kg screen"
  - "tạo screen trong graph"
od:
  mode: prototype
  category: web-artifacts
---

# react-shadcn-html

> Output discipline: UI được mô tả bằng **một cây JSON** (`screen.json`) và render
> bởi **host runtime `preview-runtime-v3`** (canvas Open Design) — chạy **React 19 +
> Tailwind v4** với **bộ component VNPAY thật** (Base UI + radix-ui, verbatim). Agent
> **không viết JSX**; agent **biên tập cây content JSON**. Cơ chế render mô phỏng nguyên
> `ScreenRenderer` của design-v3 (`apps/frontend/src/components/preview/screen-renderer.tsx`).
> `assets/shell.html` chỉ tái hiện cơ chế đó để verify cục bộ, KHÔNG phải file ship.

> 🚦 **OUTPUT POLICY (BẤT KHẢ XÂM PHẠM) — output per màn = CHỈ `screen.json`.**
> KHÔNG sinh / KHÔNG copy `shell.html`, `shell-light.html`, `brand.css`, `index.html`
> (hay bất kỳ `.html`/`.css` nào) cạnh artifact. Host `preview-runtime-v3` đóng vai shell
> (render cây) và tự resolve theme dark/light (ThemeLab) — nên artifact KHÔNG cần shell
> tự chứa, KHÔNG cần brand.css, KHÔNG cần launcher. Mọi mô tả "shell/brand" bên dưới là
> kiến trúc của HARNESS dev (`assets/`), không phải thứ phải ghi ra cho mỗi màn.

## Kiến trúc (đọc kỹ)

> ⚠️ Sơ đồ dưới mô tả **HARNESS** `assets/shell.html` (để hiểu cơ chế render + verify
> cục bộ). Ở runtime thật, **host `preview-runtime-v3` đóng đúng vai shell này** và tự
> resolve theme — nên PER-ARTIFACT bạn **chỉ xuất `screen.json`**, không ghi shell/brand.

```
KIẾN TRÚC 3 TẦNG:  shell = TỪ VỰNG + CẤU TRÚC · brand = GIÁ TRỊ (data) · screen.json = NỘI DUNG (data)

assets/shell.html   ← KHUNG cố định, KHÔNG sửa. Self-contained:
 ├─ <link> Google Fonts                        Inter · Bricolage Grotesque · JetBrains Mono
 ├─ <script @tailwindcss/browser@4>           engine Tailwind v4 (JIT theo DOM)
 ├─ <style type="text/tailwindcss">            theme.css — @theme đăng ký TOKEN VOCABULARY
 │                                             (→ utility bg-primary, from-info, bg-data-1… TỒN TẠI sẵn)
 ├─ <style> shell-structural.css               binding [data-slot] vĩnh viễn, var-FALLBACK = cỡ gốc
 │                                             component (composition phẳng tự degrade, không vỡ)
 ├─ <style> vnpay-glass-vars.css               GIÁ TRỊ MẶC ĐỊNH (VNPAY Glass, vars-only, KG-resolved)
 ├─ <link href="./brand.css">                  CỬA 1: giá trị PER-ARTIFACT (vars-only) — file cạnh,
 │                                             load SAU default → cascade đè; vắng mặt = Glass
 ├─ <style id="brand"></style>                 CỬA 2: slot dán inline (môi trường srcDoc null-origin)
 ├─ <script @babel/standalone>                 transpile khối render
 ├─ <script> /*PREBUILT BUNDLE*/ </script>     ⇒ window.{React,createRoot,UI,Lucide,cn}
 ├─ <script type="application/json" id="screen"></script>   fallback inline (thường để trống)
 └─ <script type="text/babel"> RENDERER </script>   đệ quy cây JSON → component thật

assets/shell-light.html  ← BẢN LIGHT (giống hệt shell.html, chỉ khác <html class="">)
assets/screen.json       ← cây content của màn hình (agent biên tập)
<artifact>/brand.css     ← giá trị token của composition USER CHỌN — agent lấy qua MCP
                           kg-local `ui_tokens_get` (trường cssVars) rồi ghi file này
```

Luồng: `shell.html` → `fetch('./screen.json')` → đọc `screen.roots[]` → bọc
**mobile-first (KHÔNG device frame)** → `RenderNode` đi đệ quy: tra slug trong bảng
component, gắn `props`, đệ quy `children`/`text`. Slug không tra được → badge đỏ
`?slug`. Token icon (`asset.icon.*`) → ánh xạ sang Lucide.

**Mặc định mới:** màn render **mobile-first, không khung điện thoại** (cột full-width
giới hạn 480px, căn giữa trên màn rộng; nền mesh brand xuyên qua). Muốn full-bleed cho
dashboard → đặt `"viewport": "desktop"`.

**Light/dark = HOST tự toggle, KHÔNG xuất 2 file.** Trên canvas Open Design, host
`preview-runtime-v3` resolve theme qua ThemeLab và bật dark/light ngay trên cùng một
`screen.json` (nút Dark/Light của canvas). Agent **KHÔNG** xuất `shell.html` (dark) +
`shell-light.html` (light) per-artifact nữa — chỉ một `screen.json`, host lo cả 2 mode.
*(Trong HARNESS dev, `assets/shell.html`=dark và `assets/shell-light.html`=light chỉ
để verify mắt cục bộ; token 2 scheme nằm trong `vnpay-glass.css` inline.)*

## Khi nào dùng

- User muốn dựng màn hình UI bằng **bộ design system VNPAY** dưới dạng cây content
  JSON (vd seed screen của design-v3: `UI_PROJECT_SCREEN/...`), render preview được.
- Bất kỳ task design nào trả về artifact preview từ một mô tả cấu trúc màn hình.
- Compose với `taste-skill` / `gpt-taste` (creative direction).

## Hai chế độ authoring — Graph mode là MẶC ĐỊNH

| | **Graph mode** (MẶC ĐỊNH — KG-first) | **File mode** (throwaway, opt-in) |
|---|---|---|
| Source of truth | **graph Neo4j local** (workspace `ws-od-prototypes`) | file `*.screen.json` author tay |
| Cách author | tạo node/edge qua MCP `kg-local` (`ui_screen_upsert`, `ui_instance_upsert`, `ui_flow_link`) | biên tập JSON trực tiếp (Hard rule 8) |
| screen.json | **build artifact** của `ui_screen_export` (đóng dấu `__provenance`) — CẤM sửa tay, sửa thì quay về graph rồi re-export | LÀ nguồn (KHÔNG có `__provenance`) |
| `validate.mjs` | qua **cổng xuất xứ** tự động (có `__provenance`) | **phải thêm `--allow-handwritten`** (thiếu dấu = FAIL) |
| Grounding | catalog `UI_COMPONENT` + screen XPOS thật đã clone trong graph | references/components.md |
| Khi nào | **prototype thật**: grounding data thật, flow đa màn, tái dùng pattern, trace về design system, reskin theo composition KG | chỉ màn nháp vứt đi, không cần trace/đa màn |

> **Vì sao KG-first là mặc định:** prototype thật phải trace về design system và reskin
> được theo composition trong KG. Gõ thẳng JSON bỏ qua grounding → slug/pattern chế từ
> trí nhớ, không reskin chuẩn được. `validate.mjs` chặn cứng: screen.json thiếu
> `__provenance` (dấu do `ui_screen_export` đóng) sẽ **FAIL** trừ khi bật
> `--allow-handwritten` (opt-in có chủ đích). Đây là cổng ngăn lỗi "quên tạo KG mà tự
> gõ JSON".

Graph mode: đọc **`references/screen-graph-authoring.md`** (contract node/edge,
MCP tools, workflow lint→export→validate→render, guardrails). Hạ tầng:
`pnpm tools-kg neo4j up && pnpm tools-kg clone` (một lần).

## Cấu trúc `screen.json`

Top-level (giống seed design-v3 — chấp nhận cả 3 dạng: `{screen}`, `{roots}`, `[...]`):

```jsonc
{
  "screen": {
    "slug": "danh-muc-san-pham",
    "name": "Danh Mục Sản Phẩm",
    "viewport": "mobile",          // mặc định mobile-first KHÔNG frame; "desktop" ⇒ full-bleed
    "roots": [ <node>, ... ]       // mảng node gốc
  }
}
```

Mỗi **node**:

```jsonc
{
  "id": "m05-add",                 // tùy chọn, dùng làm React key
  "componentSlug": "Button",       // BẮT BUỘC: tên component (xem "Slug" bên dưới)
  "props": { "variant": "default", "size": "icon", "className": "..." },
  "text": "Sản phẩm",              // text leaf (đặt trước children)
  "children": [ <node>, ... ]      // node con
}
```

### Slug — cách resolver tra component

Cơ chế **bê nguyên từ design-v3** (`screen-renderer.tsx`): có một **whitelist curated**
`COMPONENT_PRIMITIVES` (key kebab) trong `builder/app-shell-block.jsx`. Cách tra (giống hệt
design-v3): `COMPONENT_PRIMITIVES[slug] ?? COMPONENT_PRIMITIVES[componentCatalogSlug(slug)]`.

1. Viết `componentSlug` theo **tên export** (PascalCase: `"Button"`, `"Card"`, `"InputGroup"`,
   `"InputGroupInput"`, `"Tabs"`, `"TabsTrigger"`…). Resolver tự đổi sang kebab
   (`componentCatalogSlug`: `InputGroupInput` → `input-group-input`) rồi tra trong whitelist.
2. **Chỉ các primitive trong whitelist mới mount** (~47 component + subpart, đúng bộ của
   design-v3). KHÔNG mount bừa mọi export của `UI` — đây là điểm khác bản generic cũ.
3. Đặc biệt: `"Asset"` → icon (xem dưới); `"form"` → `<form>` thuần; fallback HTML
   `"div" "span" "p" "ul" "li" "img"`.

Slug ngoài whitelist (kể cả export UI hợp lệ nhưng không nằm trong bộ primitive) → **badge đỏ
`?slug`**, y như design-v3. Danh sách primitive đầy đủ xem `PRIMITIVE_SLUGS` trong
`builder/app-shell-block.jsx`; biến thể/variant xem `references/components.md`.

> Field: design-v3 đọc `component`; seed authored dùng `componentSlug`. Shell chấp nhận **cả
> hai** (`node.component || node.componentSlug`), nên screen.json giữ `componentSlug` như seed.

### Icon / Asset

Node `{"componentSlug":"Asset","props":{"token":"asset.icon.add"}}` → tra bảng
`ICON_TOKEN_TO_LUCIDE` trong `app-shell-block.jsx` → render icon Lucide tương ứng.
Token chưa có trong bảng → ô placeholder viền + tooltip tên token (giữ kích thước
layout). **Cần icon mới?** thêm cặp `"asset.icon.x": "LucideName"` vào bảng đó.
Bảng đã map sẵn: add, search, products, orders, cash, home, history, back, close,
menu, more, settings, user, cart, check, edit, delete, filter, chevron-right, bell, scan.

## Hard rules (KHÔNG vi phạm)

1. **KHÔNG sửa `shell.html`.** Agent chỉ biên tập `screen.json`. (Trừ khi cần thêm
   CDN khác → chèn vào `<head>`; hoặc thêm icon token → sửa bảng trong
   `builder/app-shell-block.jsx` rồi rebuild shell.)
2. **KHÔNG copy source component.** Component đã prebuilt trong bundle, mount qua slug.
3. **KHÔNG viết JSX `App()`, KHÔNG `import`/`export`.** Toàn bộ UI đến từ cây JSON.
4. **`componentSlug` phải khớp resolver** (PascalCase export UI / tag HTML / Asset).
   Slug sai = badge đỏ `?slug`. Kiểm tra bằng `references/components.md`.
5. **KHẾ ƯỚC MỨC A — "component bất khả xâm phạm, sáng tác trên surface".**
   Agent là **art director được phát đúng MỘT bảng màu** (palette của composition
   user chọn, lấy qua `ui_tokens_get`). Ranh giới:

   | Đối tượng | ĐƯỢC | CẤM |
   |---|---|---|
   | **Component whitelist** (Button, Card, Input…) | `variant`/`size` + className **layout-only** (flex, gap, w-full, px-*, rounded-*…) | MỌI class màu — kể cả token (`bg-primary/10` lên Card = vi phạm `component-paint`) |
   | **Element trang trí** (div, span, p, section…) | **TỰ DO thị giác** bằng utility ngữ nghĩa từ token: `bg-primary/12`, `bg-linear-135 from-primary to-info`, `text-accent`, `shadow-lg shadow-primary/20`, `bg-data-1`, blur, type-* | Màu KHÔNG truy được về token (xem rule 6) |

   - Muốn nút đỏ → `"variant":"destructive"`; nút phụ → `"variant":"secondary"`.
   - Muốn màn ấn tượng → sáng tác ở **wrapper/hero/band/chip/nền** quanh component —
     đó là ~50–60% pixel của màn và là đất diễn hợp lệ. Pattern chuẩn:
     `references/creative-with-tokens.md`.
6. **MÀU CHỈ TỒN TẠI DƯỚI DẠNG UTILITY NGỮ NGHĨA CỦA TOKEN.** Validator
   (`builder/validate.mjs`) chặn cứng cả 3 đường lậu, ở MỌI node:
   - ❌ color literal: `#22c55e`, `oklch(…)`, `rgb(…)`, kể cả trong `props.style`;
   - ❌ arbitrary màu: `bg-[#…]`, `bg-[oklch(…)]`, `bg-[var(--primary)]`,
     `bg-[linear-gradient(…)]`, `shadow-[…rgba…]` — đã có utility thì không đi đường vòng
     (arbitrary **layout** vẫn hợp lệ: `size-[44px]`, `grid-cols-[1fr_2fr]`);
   - ❌ palette mặc định của Tailwind: `bg-red-500`, `text-blue-300`… — đó là màu của
     Tailwind, không phải token KG.
   Phái sinh hợp lệ duy nhất: **modifier `/N`** (`bg-primary/12`) — Tailwind tự
   color-mix từ token, vẫn đổi theo dark/light.
7. **OUTPUT PER MÀN = CHỈ `screen.json`.** KHÔNG ghi/copy `shell.html`,
   `shell-light.html`, `brand.css`, `index.html` (hay `.html`/`.css` nào) cạnh artifact.
   Host `preview-runtime-v3` render cây + tự resolve theme (dark/light) → artifact không
   cần shell tự chứa, không cần brand.css, không cần launcher. (Harness verify cục bộ
   dùng `assets/shell.html` trong thư mục TẠM, KHÔNG để lại file cạnh `screen.json`.)
8. **(File mode) `screen.json` là SOURCE OF TRUTH, author TRỰC TIẾP dưới dạng JSON khai báo.**
   *(Graph mode đảo lại: graph là nguồn, screen.json export ra là build artifact cấm sửa
   tay — xem `references/screen-graph-authoring.md`. Phần còn lại của rule này áp dụng
   cho file mode.)*
   Nội dung màn được viết tay (hoặc biên tập) ngay trong file `*.screen.json` — file
   JSON LÀ nguồn, không phải sản phẩm phái sinh của thứ khác. Mỗi màn ⇒ một file
   `*.screen.json` (vd `home.screen.json`).
   - **CẤM dựng cây bằng code JS** (helper `N/D/S(...)`, builder functions…) rồi sinh ra
     JSON — kể cả khi có `writeFileSync('*.screen.json', JSON.stringify(tree))`. Làm vậy
     thì *JS mới là nguồn thật*, json chỉ là output; sửa màn lại phải sửa JS → sai hướng.
   - **Nếu cần script `.mjs`** (để inline cây vào HTML khi môi trường chặn fetch, hoặc
     ghép nhiều màn), script đó CHỈ ĐƯỢC **đọc/import/fetch** file `.screen.json` đã author
     (`JSON.parse(readFileSync('*.screen.json'))` / `import data from './x.screen.json'`)
     rồi nhúng — TUYỆT ĐỐI không tự dựng/chỉnh cây trong code. `.mjs` là *consumer*, json là *source*.
9. **ĐỔI TÔNG/BRAND = ĐỔI GIÁ TRỊ TOKEN trong KG, KHÔNG ghi brand.css, KHÔNG inject CSS đè.**
   Theme do **host `preview-runtime-v3` resolve** (ThemeLab đọc composition từ KG) — agent
   KHÔNG ghi `<artifact>/brand.css` nữa. Vai trò của token với agent **chỉ còn là GROUNDING**:
   đọc `palette` qua `ui_tokens_get` để chọn className **decorative** đúng tông (Hard rule 5–6)
   NGAY KHI author. Muốn artifact mang composition khác → set composition đó trong KG/ThemeLab
   của màn, KHÔNG fill CSS vào file. CẤM tự viết `<style>` chứa class màu, CẤM sửa/chế giá trị
   token bằng tay (mọi giá trị resolve từ KG — "không bao giờ chế giá trị").
10. **Reskin sang brand THẬT trong KG → pull ĐỦ 7 layer của composition, bind VERBATIM.**
   Một composition (vd "VNPAY Glass") KHÔNG chỉ là màu — nó chồng nhiều layer
   (spacing · radius · typography · control-density · color · icon · brand). **CẤM chỉ
   lấy layer màu** → mất radius/type/control, style ra **sai data KG** (bo góc lệch,
   control thấp, font sai). Quy trình + cypher + mapping control/glass đầy đủ:
   `references/kg-brand-binding.md`. Stylesheet brand đã sinh sẵn:
   `assets/vnpay-glass.css` (include SAU `theme.css`). Nguồn duy nhất:
   `builder/make-showcase.mjs`.
11. **KHÔNG tự tạo KG — HITL trước.** Khi trigger để dựng một màn mà KG **chưa có**
   màn đó, skill **KHÔNG** tự ý `ui_screen_upsert`/tạo workspace. PHẢI chạy **Step 0
   (Preflight HITL)** bên dưới: kiểm tra tồn tại read-only → `AskUserQuestion` đề xuất
   phương án tạo (màn mới trong dự án có sẵn / dự án mới) → chỉ author SAU KHI user
   chọn. Nhảy thẳng vào author khi user chưa chọn = vi phạm.

## Step 0 — Preflight HITL: KG đã có màn chưa? (BẮT BUỘC, chạy TRƯỚC mọi thứ)

> "Dự án" = **KG workspace** (`UI_WORKSPACE` sở hữu screen). Skill KHÔNG tự tạo KG —
> khi màn chưa có, HỎI user cách tạo, không tự quyết (Hard rule 11).

```
1. KIỂM TRA TỒN TẠI (read-only — KHÔNG ghi gì):
   - Liệt kê dự án (workspace) đang có:
       kg_cypher_read "MATCH (w:UI_WORKSPACE) RETURN w.slug AS slug, w.name AS name ORDER BY name"
   - Tìm màn theo slug/tên user yêu cầu (cả prototype lẫn reference XPOS):
       kg_find {term: "<vd: login / đăng nhập>", label: "UI_PROJECT_SCREEN"}
       (hoặc: MATCH (s:UI_PROJECT_SCREEN) WHERE s.slug=$slug OR toLower(s.name) CONTAINS toLower($term)
              RETURN s.slug, s.name, s.workspaceId)

2. RẼ NHÁNH theo kết quả:

   A. MÀN ĐÃ CÓ trong dự án ghi được (ws-od-prototypes) → AskUserQuestion:
      • "Dùng lại & export màn hiện có"  → thẳng bước 6 (ui_screen_export)
      • "Tạo bản mới (slug khác)"        → author màn mới, bước 4
      • "Ghi đè màn hiện có"             → author đè trên slug đó

   B. MÀN CHƯA CÓ → AskUserQuestion ĐỀ XUẤT PHƯƠNG ÁN TẠO (HITL bắt buộc, KHÔNG tự chọn):
      • "Tạo màn mới trong dự án có sẵn" [HỖ TRỢ SẴN] → chọn 1 workspace đang có
        (mặc định ws-od-prototypes) rồi vào Quy trình bắt buộc từ bước 4.
      • "Tạo dự án (workspace) mới" [FOLLOW-UP — ⚠️ CHƯA hỗ trợ tự động] → tool ghi KG
        đang ghim ws-od-prototypes. Nếu user chọn: GIẢI THÍCH giới hạn + đề nghị hoặc
        đặt env `OD_KG_WORKSPACE=<tên mới>` rồi mở lại session, hoặc tạm dùng dự án có
        sẵn. TUYỆT ĐỐI không tự tạo workspace.
      • (chỉ hiện nếu bước 1 thấy màn mẫu tương tự) "Dựa trên màn mẫu '<X>' có sẵn" →
        clone pattern màn reference đó thành màn mới trong dự án có sẵn (bước 4).

   C. THOÁT HIỂM (chỉ khi user CHỦ ĐỘNG từ chối KG): file mode — author tay +
      `validate.mjs --allow-handwritten`. Nêu rõ đánh đổi: không trace, không reskin chuẩn.

3. Sau khi user chọn → đi tiếp "Quy trình bắt buộc (KG-first)" từ bước tương ứng.
   KHÔNG author khi nhánh B chưa có lựa chọn của user.
```

## Quy trình bắt buộc (KG-first)

> **Thứ tự chặng là canonical ở `references/pipeline.md`** — mục này chỉ là CHI TIẾT
> THAO TÁC. Chạy **Step 0 (Preflight HITL)** TRƯỚC. Mặc định = **Graph mode**:
> ① author trong KG → ② export (`__provenance`) → ④ build + verify. Theme (③) là mối
> bận **CHÉO**, không phải bước đứng giữa ② và ④: *grounding SỚM* (đọc palette
> trước/khi author) + *binding MUỘN* (fill brand.css lúc build) — xem pipeline.md.
> File mode chỉ cho màn nháp + `--allow-handwritten` (xem "Thoát hiểm" cuối mục).

```
1. Đọc references/components.md → slug/component/variant/token có sẵn.
2. GROUNDING TRONG KG (đừng chế slug/pattern từ trí nhớ): kg_find / kg_cypher_read
   catalog UI_COMPONENT + variant + screen mẫu XPOS. Chi tiết:
   references/screen-graph-authoring.md.
3. CHỌN THEME — token grounding (CHỈ để chọn màu, KHÔNG fill file): `ui_tokens_get {compositionId}`
   → ĐỌC `palette` (giá trị dark/light + utilities mỗi token) để phối màu decorative ĐÚNG
   (Hard rule 5–6) NGAY KHI author — primary tông gì, accent ấm/lạnh, có data-1..4 không…
   Đây là "grounding" SỚM. **KHÔNG còn bước "binding"/fill brand.css** — theme do host
   `preview-runtime-v3` resolve khi render (đặt composition cho màn trong KG/ThemeLab).
   (Muốn TẠO composition mới thay vì dùng cái có sẵn → skill kg-theme-composition.)
4. AUTHOR SCREEN TRONG GRAPH: `ui_screen_upsert {slug,name,viewport}` →
   `ui_instance_upsert` root (componentSlug "div", props `bg-background`) rồi đệ quy
   con qua `parentId` + `order`. SÁNG TÁC theo khế ước mức A (rule 5–6): component
   nguyên trạng, decorative tự do bằng utility token — pattern chuẩn ở
   references/creative-with-tokens.md. (nếu đa màn) `ui_flow_link`.
5. `ui_screen_lint` → sửa graph đến khi 0 error.
6. `ui_screen_export {slug}` → `.od/kg-exports/<slug>/screen.json` — tự đóng dấu
   `__provenance`. ĐÂY là source of truth; CẤM sửa tay file export (sửa thì về graph
   rồi re-export).
7. ĐẶT OUTPUT: chỉ copy/ghi **`screen.json`** vào thư mục artifact. **KHÔNG** copy
   shell.html/shell-light.html, **KHÔNG** ghi brand.css, **KHÔNG** tạo index.html. Theme
   do host resolve (bước 3 grounding đã chọn màu; composition gắn cho màn trong KG/ThemeLab).
   Script `.mjs` (nếu có) chỉ ĐỌC file, không tự dựng/sửa cây, không materialize HTML/CSS.
8. VALIDATE: `node builder/validate.mjs <artifact>/screen.json` (cổng xuất xứ + cấu
   trúc + slug + icon + foreign-color + component-paint, ~100ms, không Chrome). File
   export có `__provenance` → qua cổng tự động.
9. VERIFY render qua HARNESS (không để lại file cạnh artifact): copy `screen.json` vào
   thư mục TẠM cùng `assets/shell.html`+`shell-light.html` (vd `/tmp/verify-<slug>/`) rồi
   `node builder/verify.mjs /tmp/verify-<slug>` (0 badge `?slug`, 0 console error) hoặc
   `node builder/shot.mjs /tmp/verify-<slug>/shell.html /tmp/x.png`. Xong **xoá thư mục tạm**.
   (Hoặc tin vào render thật trên canvas Open Design.) Icon thiếu? thêm cặp vào
   ICON_TOKEN_TO_LUCIDE (builder/app-shell-block.jsx) rồi `node builder/make-shell.mjs`.

THOÁT HIỂM — file mode (màn nháp vứt đi, KHÔNG khuyến cho prototype thật):
- Bỏ bước 2 (grounding KG) và 4–6. Author tay `<name>.screen.json` (Hard rule 8:
  JSON LÀ source, CẤM dựng cây bằng JS rồi sinh JSON).
- `node builder/validate.mjs <name>.screen.json --allow-handwritten` (thiếu
  `__provenance` nên CẦN cờ này). Đánh đổi: không trace về KG, không reskin theo
  composition KG chuẩn.
```

## Ví dụ node tree (rút gọn)

```jsonc
{
  "screen": {
    "slug": "demo", "name": "Demo", "viewport": "mobile",
    "roots": [{
      "id": "shell", "componentSlug": "div",
      "props": { "className": "flex h-full flex-col bg-background" },
      "children": [
        { "id": "top", "componentSlug": "div",
          "props": { "className": "flex items-center justify-between px-6 py-3 border-b border-border bg-card" },
          "children": [
            { "id": "t", "componentSlug": "span",
              "props": { "className": "type-title-medium text-foreground" }, "text": "Sản phẩm" },
            { "id": "add", "componentSlug": "Button",
              "props": { "variant": "default", "size": "icon", "aria-label": "Thêm" },
              "children": [
                { "id": "ic", "componentSlug": "Asset", "props": { "token": "asset.icon.add" } }
              ] }
          ] },
        { "id": "search", "componentSlug": "InputGroup", "props": { "className": "m-6" },
          "children": [
            { "componentSlug": "InputGroupAddon", "children": [
              { "componentSlug": "Asset", "props": { "token": "asset.icon.search", "className": "size-5" } } ] },
            { "componentSlug": "InputGroupInput", "props": { "placeholder": "Tìm sản phẩm" } }
          ] }
      ]
    }]
  }
}
```

## Reskin brand thật từ KG (sm-mcp) — bind đủ 7 layer

Khi user muốn artifact mang **một design system thật trong Knowledge Graph** (vd
"VNPAY Glass"), token là source of truth — pull qua `sm-mcp`, **không chế giá trị**.

- **Pull TẤT CẢ layer của composition, KHÔNG chỉ màu** (Hard rule 10). VNPAY Glass = 7
  layer: spacing · radius · typography · control-density · color (Payment Glass Pro) ·
  icon · brand (VNPAY Merchant). Chỉ lấy color → radius/font/control sai.
- Quy trình, id composition, cypher (`USES_THEME` → layer; `EMITS` → token value),
  dual-scheme (index0=dark/index1=light), gradient-primary, và **bảng mapping
  control/glass đã rà soát** (vì component hardcode size, riêng Switch đọc `--switch-*`):
  xem `references/kg-brand-binding.md`.
- Asset sẵn dùng: `assets/vnpay-glass.css` (brand override, include SAU `theme.css`) +
  `assets/showcase.html` (gallery 40 component, toggle light/dark để verify mắt).
- Regenerate sau khi đổi token: `node builder/make-showcase.mjs`.

## Composition với taste-skill / gpt-taste

- `taste-skill` / `gpt-taste` = **creative brain** (layout, typography, spacing, palette).
- `react-shadcn-html` = **output discipline** (cây JSON, component VNPAY verbatim, token-driven).
- Xung đột: **creative direction thắng** về thẩm mỹ, nhưng **format output (CHỈ
  `screen.json` + slug + token, KHÔNG html/css) của skill này thắng**.

## Cờ điều chỉnh (mặc định nếu user không nói)

- `DESIGN_VARIANCE`: `medium` · `MOTION_INTENSITY`: `medium` · `VISUAL_DENSITY`: `spacious`

## Rebuild shell (chỉ khi đổi bundle hoặc render block)

`builder/` là dev-harness, KHÔNG ship runtime — chỉ `assets/` được dùng.

```
# Brand dual-scheme (light/dark) + glass + control sizing — sinh từ KG token:
node builder/make-showcase.mjs              → assets/vnpay-glass.css (+ showcase.html)

# Chỉ đổi render block / bảng icon (bundle giữ nguyên). make-shell INLINE
# vnpay-glass.css nên chạy make-showcase.mjs trước nếu brand đổi:
node builder/make-shell.mjs                 → shell.html (dark) + shell-light.html (light)

# Đổi bộ component nguồn (components/ui ở preview-runtime-v3):
cd builder && npm install && node build.mjs → dist/components.bundle.js
node builder/gen-runtime.mjs                → theme.css + components.bundle.js + shell.html
PW_CHROME=<chrome> node builder/verify.mjs  → render check headless
```

> Shell inline `vnpay-glass.css` (brand dual-scheme) + render block **mobile-first
> không frame**. Light/dark là **2 file** (`shell.html` dark + `shell-light.html` light),
> không toggle. Đổi brand → đổi token KG trong `make-showcase.mjs` →
> `node make-showcase.mjs && node make-shell.mjs`.

## Tài liệu tham khảo

- `references/pipeline.md` — **XƯƠNG SỐNG CANONICAL**: nguồn-sự-thật-duy-nhất cho THỨ
  TỰ 5 chặng (Preflight → Author → Export → Build), theme là mối bận chéo (grounding
  sớm/binding muộn), fork dùng-có-sẵn vs tạo-mới. ĐỌC ĐẦU TIÊN khi phân vân thứ tự.
- `assets/shell.html` — khung self-contained (bundle + Tailwind v4 + Babel + renderer).
- `assets/screen.json` — cây content mẫu (màn xpos product-categories).
- `builder/app-shell-block.jsx` — renderer + bảng icon token (single source).
- `builder/validate.mjs` — validate offline screen.json (cấu trúc + slug + icon +
  foreign-color + component-paint theo khế ước mức A).
- `references/screen.schema.json` — JSON Schema của screen.json.
- `references/creative-with-tokens.md` — COOKBOOK sáng tác mức A: pattern hero/glow/
  band/chip/stat bằng utility token, luật cặp đôi màu chữ, giới hạn blur. ĐỌC khi
  cần làm màn "có art direction" thay vì layout trần.
- `references/screen-graph-authoring.md` — GRAPH MODE: author screen bằng node/edge
  trong KG local qua MCP `kg-local`, export → render. ĐỌC khi user muốn tạo screen
  trong graph / cần grounding data design system thật.
- `references/components.md` — inventory đầy đủ + variant + token đã wire sẵn.
- `references/composition.md` — pattern layout (hero, dashboard, form, bento…).
- `references/kg-brand-binding.md` — reskin brand thật từ KG: pull đủ 7 layer, bind
  verbatim, mapping control/glass đã rà soát. ĐỌC khi đổi sang VNPAY Glass / brand KG.
- `assets/vnpay-glass.css` — stylesheet brand VNPAY Glass (auto-gen, include sau theme.css).
- `assets/showcase.html` — gallery 40 component (light/dark) để verify diện mạo brand.
- `builder/make-showcase.mjs` — nguồn duy nhất sinh showcase + vnpay-glass.css.

## Anti-patterns (phát hiện = sai)

- Viết JSX `function App()` / `import { Button }` ❌ → tất cả ở `screen.json`.
- **Ghi `shell.html`/`shell-light.html`/`brand.css`/`index.html` cạnh `screen.json` ❌**
  (Output policy + Hard rule 7) → output per màn CHỈ `screen.json`; host render + tự theme.
- Sửa trực tiếp `shell.html` để chèn UI ❌ → sửa `screen.json`.
- `componentSlug` sai tên (vd `"InputBox"`, `"btn"`) ❌ → badge đỏ `?slug`.
- Dán lại source `.tsx` của Base UI vào file ❌ (đã có trong bundle).
- Dựng cây content bằng code JS trong `.mjs` (helper `N/D/S(...)`, builder functions) ❌
  — kể cả khi có `writeFileSync('*.screen.json', JSON.stringify(tree))`. Khi đó JS là
  nguồn thật, json chỉ là output phái sinh → ngược hướng. Source of truth phải là chính
  file `.screen.json` author tay; `.mjs` chỉ được `readFileSync`/import/fetch json đó (Hard rule 8).
- **Màu lậu dưới mọi hình thức** ❌ (Hard rule 6 — validator chặn cứng):
  - SAI: `bg-[#22c55e]` · `bg-[oklch(0.6_0.2_150)]` · `bg-[var(--primary)]` ·
    `bg-red-500` · `props.style:{background:"rgb(…)"}`
  - ĐÚNG: `bg-primary/12` · `bg-linear-135 from-primary to-info` · `text-accent` ·
    `shadow-lg shadow-primary/20` — utility ngữ nghĩa của token, tự đúng dark/light.
- **Nhuộm component bằng className màu** ❌ — kể cả màu token (Hard rule 5, mức A):
  - SAI: `{"componentSlug":"Button","props":{"className":"bg-primary/20"}}` ·
    `{"componentSlug":"Card","props":{"className":"bg-card border-border"}}`
    (Card TỰ có surface của nó — thừa và vi phạm)
  - ĐÚNG: `{"componentSlug":"Button","props":{"variant":"destructive","className":"h-12 w-full"}}`
    → màu từ variant; muốn ấn tượng thì sáng tác ở WRAPPER quanh component.
- Tự chế giá trị token / sửa tay brand.css ❌ (Hard rule 9) — mọi giá trị resolve từ KG
  qua `ui_tokens_get`; đổi tông = đổi composition, không vá CSS.
- Tự định nghĩa `tailwind.config = {…}` kiểu v3 ❌ (Tailwind v4, token ở CSS).
