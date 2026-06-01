---
name: react-shadcn
description: |
  Sinh artifact UI từ một CÂY CONTENT JSON (cấu trúc nested của màn hình), render
  bằng React 19 + Tailwind v4 với bộ component VNPAY thật (Base UI + radix-ui),
  VERBATIM — KHÔNG port tay, KHÔNG HTML thuần. Output là 2 file: `shell.html`
  (khung cố định: bundle component + renderer đệ quy) + `screen.json` (agent biên
  tập). Shell fetch screen.json rồi đi đệ quy cây node, mount component theo slug —
  đúng cơ chế ScreenRenderer của design-v3. Chạy trong iframe preview của Open
  Design. Compose tốt với taste-skill / gpt-taste để có creative direction.
triggers:
  - "react shadcn"
  - "shadcn html"
  - "vnpay ui"
  - "base ui"
  - "json screen"
  - "screen renderer"
  - "design artifact"
  - "creative ui"
od:
  mode: prototype
  category: web-artifacts
---

# react-shadcn-html

> Output discipline: UI được mô tả bằng **một cây JSON** (`screen.json`) và render
> bởi **shell.html** — khung chạy **React 19 + Tailwind v4** với **bộ component
> VNPAY thật** (Base UI + radix-ui, verbatim). Agent **không viết JSX**; agent
> **biên tập cây content JSON**. Cơ chế render mô phỏng nguyên `ScreenRenderer` của
> design-v3 (`apps/frontend/src/components/preview/screen-renderer.tsx`).

## Kiến trúc (đọc kỹ)

```
assets/shell.html   ← KHUNG cố định, KHÔNG sửa. Self-contained:
 ├─ <link> Google Fonts                        Inter · Bricolage Grotesque · JetBrains Mono
 ├─ <script @tailwindcss/browser@4>           engine Tailwind v4 (JIT theo DOM)
 ├─ <style type="text/tailwindcss">            theme.css (token + default theme)
 ├─ <style> vnpay-glass.css                    BRAND dual-scheme light/dark (KG-resolved)
 ├─ <script @babel/standalone>                 transpile khối render
 ├─ <script> /*PREBUILT BUNDLE*/ </script>     ⇒ window.{React,createRoot,UI,Lucide,cn}
 ├─ <script type="application/json" id="screen"></script>   fallback inline (thường để trống)
 └─ <script type="text/babel"> RENDERER </script>   đệ quy cây JSON → component thật

assets/shell-light.html  ← BẢN LIGHT (giống hệt shell.html, chỉ khác <html class="">)
assets/screen.json       ← AGENT CHỈ SỬA Ở ĐÂY. Cây content của màn hình.
```

Luồng: `shell.html` → `fetch('./screen.json')` → đọc `screen.roots[]` → bọc
**mobile-first (KHÔNG device frame)** → `RenderNode` đi đệ quy: tra slug trong bảng
component, gắn `props`, đệ quy `children`/`text`. Slug không tra được → badge đỏ
`?slug`. Token icon (`asset.icon.*`) → ánh xạ sang Lucide.

**Mặc định mới:** màn render **mobile-first, không khung điện thoại** (cột full-width
giới hạn 480px, căn giữa trên màn rộng; nền mesh brand xuyên qua). Muốn full-bleed cho
dashboard → đặt `"viewport": "desktop"`.

**Light/dark = 2 FILE RIÊNG, KHÔNG toggle.** `shell.html` = dark (`<html class="dark">`),
`shell-light.html` = light (`<html class="">`). Hai file **giống hệt nhau**, chỉ khác
class trên `<html>`; token cả 2 scheme nằm trong `vnpay-glass.css` inline (`:root`=light,
`html.dark`=dark). Cả hai cùng fetch `./screen.json` → serve file nào ra mode đó. Muốn
xuất artifact 2 mode → copy cả `shell.html` + `shell-light.html` (+ `screen.json`).

## Khi nào dùng

- User muốn dựng màn hình UI bằng **bộ design system VNPAY** dưới dạng cây content
  JSON (vd seed screen của design-v3: `UI_PROJECT_SCREEN/...`), render preview được.
- Bất kỳ task design nào trả về artifact preview từ một mô tả cấu trúc màn hình.
- Compose với `taste-skill` / `gpt-taste` (creative direction).

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
5. **Agent = UI-COMPOSER, KHÔNG phải stylist.** Nhiệm vụ là *dựng cấu trúc* (chọn
   component, props ngữ nghĩa, layout, phân cấp) — KHÔNG tự định nghĩa diện mạo của
   component. Diện mạo component (màu nền/chữ/viền/shadow/gradient) **CHỈ** đến từ:
   (a) **prop `variant`/`size`** dựng sẵn của component, và (b) **theme token** trong `:root`.
   - Muốn nút đỏ → `"variant":"destructive"`. Nút phụ → `"variant":"secondary"`. Viền →
     `"variant":"outline"`. Xem bộ variant đầy đủ ở `references/components.md`.
   - **CẤM trên component thật**: class màu tự chế (`vnp-cta`, `vp-accent-grad`…),
     arbitrary color (`bg-[oklch(...)]`, `bg-[#...]`, `text-[oklch(...)]`), `!important`,
     hay bất kỳ class nào đổi background/text/border/shadow. Những thứ này *ghi đè* design
     system → đúng lỗi "component trong màn khác component gốc".
6. **`props.className` trên component = CHỈ layout/spacing/sizing/vị trí.** Cho phép:
   `flex`, `grid`, `gap-*`, `w-full`, `h-12`, `px-*`, `py-*`, `m-*`, `rounded-2xl`,
   `absolute`, `z-*`, `items-*`, `justify-*`, `size-[44px]`… **KHÔNG** màu sắc. Class
   semantic theo token cho **div/span trang trí thuần** vẫn OK (`bg-card`, `text-foreground`,
   `border-border`, `type-title-medium`). Arbitrary color chỉ được dùng trên `div`/`span`
   trang trí (nền glass, chip…), **KHÔNG** trên component design-system.
7. **2 file phải đi cùng nhau** khi serve (shell.html + screen.json cùng thư mục).
   Nếu môi trường chặn fetch (iframe `srcDoc` null-origin), dùng fallback: dán cây
   vào `<script type="application/json" id="screen">` trong shell.
8. **`screen.json` là SOURCE OF TRUTH, author TRỰC TIẾP dưới dạng JSON khai báo.**
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
9. **CẤM inject `<style>` chứa class màu đè component.** Muốn đổi tông màu cả hệ thống
   (brand color, dark/light) → sửa **token `:root`** (`--primary`, `--accent`, `--card`…)
   để reskin NHẤT QUÁN qua design system. KHÔNG vá lẻ bằng class `.vnp-*`/`.vp-*` mang
   màu rồi gắn lên từng nút. (Style trang trí *surface* thuần trên `div` như glass/gradient
   nền vẫn chấp nhận, miễn KHÔNG áp lên component design-system.)
10. **Reskin sang brand THẬT trong KG → pull ĐỦ 7 layer của composition, bind VERBATIM.**
   Một composition (vd "VNPAY Glass") KHÔNG chỉ là màu — nó chồng nhiều layer
   (spacing · radius · typography · control-density · color · icon · brand). **CẤM chỉ
   lấy layer màu** → mất radius/type/control, style ra **sai data KG** (bo góc lệch,
   control thấp, font sai). Quy trình + cypher + mapping control/glass đầy đủ:
   `references/kg-brand-binding.md`. Stylesheet brand đã sinh sẵn:
   `assets/vnpay-glass.css` (include SAU `theme.css`). Nguồn duy nhất:
   `builder/make-showcase.mjs`.

## Quy trình bắt buộc

```
1. Đọc references/components.md → biết slug/component nào có sẵn + variant + token.
2. Copy assets/shell.html + assets/screen.json → thư mục artifact (project cwd).
3. (nếu có taste-skill) tuân creative direction cho layout/typography/spacing.
4. Author cây node (componentSlug + props.className + children/text) TRỰC TIẾP trong
   file `<name>.screen.json` — đây là source of truth (Hard rule 8). KHÔNG dựng cây
   bằng code JS rồi sinh ra json.
5. Đưa cây vào HTML: ưu tiên serve 2 file cạnh nhau (shell tự fetch screen.json). Nếu
   môi trường chặn fetch (iframe null-origin), viết/dùng `build-*.mjs` chỉ để
   `JSON.parse(readFileSync('<name>.screen.json'))` rồi inline vào slot
   `<script id="screen">`. `.mjs` chỉ ĐỌC json, không tự dựng/sửa cây.
6. Cần icon chưa map → thêm vào ICON_TOKEN_TO_LUCIDE (builder/app-shell-block.jsx) rồi
   chạy `node builder/make-shell.mjs` để regenerate shell.html.
7. Verify: `PW_CHROME=<chrome> node builder/verify.mjs` (render headless, assert 0
   unresolved slug) hoặc `node builder/shot.mjs assets/shell.html /tmp/x.png`.
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
        { "id": "search", "componentSlug": "InputGroup", "props": { "className": "m-6 bg-card" },
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
- Xung đột: **creative direction thắng** về thẩm mỹ, nhưng **format output (shell.html
  + screen.json + slug + token) của skill này thắng**.

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

- `assets/shell.html` — khung self-contained (bundle + Tailwind v4 + Babel + renderer).
- `assets/screen.json` — cây content mẫu (màn xpos product-categories).
- `builder/app-shell-block.jsx` — renderer + bảng icon token (single source).
- `references/components.md` — inventory đầy đủ + variant + token đã wire sẵn.
- `references/composition.md` — pattern layout (hero, dashboard, form, bento…).
- `references/kg-brand-binding.md` — reskin brand thật từ KG: pull đủ 7 layer, bind
  verbatim, mapping control/glass đã rà soát. ĐỌC khi đổi sang VNPAY Glass / brand KG.
- `assets/vnpay-glass.css` — stylesheet brand VNPAY Glass (auto-gen, include sau theme.css).
- `assets/showcase.html` — gallery 40 component (light/dark) để verify diện mạo brand.
- `builder/make-showcase.mjs` — nguồn duy nhất sinh showcase + vnpay-glass.css.

## Anti-patterns (phát hiện = sai)

- Viết JSX `function App()` / `import { Button }` ❌ → tất cả ở `screen.json`.
- Sửa trực tiếp `shell.html` để chèn UI ❌ → sửa `screen.json`.
- `componentSlug` sai tên (vd `"InputBox"`, `"btn"`) ❌ → badge đỏ `?slug`.
- Dán lại source `.tsx` của Base UI vào file ❌ (đã có trong bundle).
- Dựng cây content bằng code JS trong `.mjs` (helper `N/D/S(...)`, builder functions) ❌
  — kể cả khi có `writeFileSync('*.screen.json', JSON.stringify(tree))`. Khi đó JS là
  nguồn thật, json chỉ là output phái sinh → ngược hướng. Source of truth phải là chính
  file `.screen.json` author tay; `.mjs` chỉ được `readFileSync`/import/fetch json đó (Hard rule 8).
- Hex màu cứng đè token brand khi không cần ❌ (dùng `bg-primary`, `text-foreground`…).
- **Đè diện mạo component bằng className màu** ❌ (Hard rule 5–6). Ví dụ:
  - SAI: `{"componentSlug":"Button","props":{"className":"vnp-cta bg-[oklch(0.58_0.22_25)] !important"}}`
    → tự sơn đỏ, khác hẳn variant gốc.
  - ĐÚNG: `{"componentSlug":"Button","props":{"variant":"destructive","className":"h-12 w-full rounded-2xl"}}`
    → màu đỏ đến từ variant của design system; className chỉ lo kích thước/bo góc.
- Định nghĩa class `.vnp-*`/`.vp-*` mang **màu** rồi gắn lên component ❌ (Hard rule 9)
  → muốn đổi tông thì sửa token `:root`, không vá lẻ từng nút.
- Tự định nghĩa `tailwind.config = {…}` kiểu v3 ❌ (Tailwind v4, token ở CSS).
