# Reskin brand từ Knowledge Graph (kg-local) — bind VERBATIM, đủ 7 layer

> 🚦 **Cập nhật OUTPUT POLICY:** artifact KHÔNG còn ghi `brand.css`. Theme do **host
> `preview-runtime-v3` resolve** lúc render (ThemeLab đọc composition của màn từ KG).
> Doc này giờ dùng để **author/đảm bảo GIÁ TRỊ token đủ 7 layer trong KG** + gắn đúng
> composition cho màn — KHÔNG phải để fill css ra file cạnh `screen.json`. Mọi bước
> "ghi `<artifact>/brand.css`" bên dưới là LỊCH SỬ (standalone shell), bỏ qua khi output
> chỉ `screen.json`.

> Tài liệu nguồn-sự-thật khi muốn đổi tông màu/brand của artifact sang **một
> design system thật trong KG** (vd "VNPAY Glass"). Token KG là source of truth —
> **không bao giờ chế giá trị**. Giá trị token bind ở host (`:root`/`html.dark`).

## ⚠️ Lỗi kinh điển: chỉ lấy layer màu → style SAI so với KG

Một composition trong KG **KHÔNG phải chỉ là màu**. Nó là **một chồng nhiều layer**
(`USES_THEME`, có `order`). Nếu chỉ pull layer color, ta mất radius, typography,
control density… → component ra **lệch hẳn** so với data thật (bo góc sai, control
thấp, font sai). **BẮT BUỘC pull TẤT CẢ layer của composition, không chỉ color.**

## Công cụ (MCP server `kg-local` — Neo4j LOCAL của project)

> Server cũ `sm-mcp` (gọi chéo sang dự án vpn-design-main) đã RETIRED. Toàn bộ
> subgraph UI (theme, composition, token value, component catalog, screen XPOS)
> đã được **clone về Neo4j local** (`pnpm tools-kg clone`); MCP `kg-local`
> (định nghĩa trong `.od/mcp-config.json`, source `tools/kg/`) là đường truy
> cập duy nhất. Re-sync khi design KG nguồn đổi: `pnpm tools-kg clone --refresh`.

- `kg_cypher_read({query, params?, limit?})` — Cypher read-only (write clause bị
  chặn). **Tên tham số là `query`.** Không cần `$app_id`/`$tenant_id`.
- `kg_find({term, label?, limit?})` — tìm node theo substring trên
  name/slug/componentSlug (thay cho `kg_search` semantic cũ).
- Meta composition: dùng thẳng Cypher (xem các query dưới) — không còn tool
  `kg_get_theme_composition` riêng.

Nếu tool `kg_*` chưa xuất hiện: mở lại session (MCP chỉ nạp tool lúc khởi
động). Neo4j local phải đang chạy: `pnpm tools-kg neo4j status`.

## Composition "VNPAY Glass" — 7 layer (ws-project-XPOS)

`composition_id = d8308445-1011-5d6c-f103-6317fc28269c`

| order | layer | kind | themeId | Đóng góp gì |
|---|---|---|---|---|
| 1 | Default Spacing | spacing | `730c1474-ede9-5e95-f1c8-caa7aa591732` | thang `space-*` (4px scale) |
| 2 | Rounded | rounded | `c4cbdb43-53bf-5579-2707-4891031a50dc` | `--radius*` (md 16, card 28, control/input 16, pill 999…) |
| 3 | Dashboard Type | typography | `7dc12377-1f29-520b-4275-eda4eba259bc` | font (Inter/Bricolage/JetBrains) + type-scale `text-*` |
| 4 | Large controls | control-density | `bbbe976a-0b1a-5698-0afb-01bdce85e607` | chiều cao control 48, input 48, switch 44×24/22, padding… |
| 5 | **Payment Glass Pro** | visual (color) | `41476d15-1d09-530f-528b-b61dee940e09` | nền mesh, glass card/popover, semantic, border/input/ring |
| 6 | Lucide Outline Icons | icon | `089191bb-af5a-5b7c-4f41-965fbe594c27` | bộ icon (đã có sẵn lucide trong bundle) |
| 7 | **VNPAY Merchant** | brand | `4b2ecd3e-ff82-56d8-91af-2a5f2ca086e1` | primary GRADIENT 258→275→240, accent đỏ, ring |

> Layer 5 (color) + 7 (brand) chồng lên nhau: brand **chỉ override ~22 path** trên
> nền color. Layer 1–4 cho radius/type/control. Layer 6 icon không cần bind CSS.

### Lấy layer order (không hardcode id)

```cypher
MATCH (c:UI_THEME_COMPOSITION {id:$cid})-[r:USES_THEME]->(t:UI_THEME)
RETURN r.order AS ord, t.id AS themeId, t.name AS name, t.kind AS kind ORDER BY ord
```
(params: `{cid:"d8308445-…"}`). `kg_get_theme_composition` có thể trả `layers:[]` —
dùng Cypher như trên là chắc.

### Lấy token values của (các) layer

```cypher
MATCH (t:UI_THEME)-[:EMITS|HAS_VALUE|DEFINES]->(v:UI_TOKEN_VALUE)
WHERE t.id IN $ids
RETURN t.name AS theme, v.targetPath AS path, collect(DISTINCT v.rawValue) AS vals
ORDER BY theme, path
```

## Dual-scheme: index0 = DARK, index1 = LIGHT

Mỗi `UI_TOKEN_VALUE` của VNPAY Glass phát **2 rawValue** (dark + light), **không có
field `mode`**. Cách phân biệt đã kiểm chứng cho composition này:
`collect(DISTINCT v.rawValue)` → **phần tử [0] = DARK, [1] = LIGHT** (xác nhận qua
luminance: `background` dark = `oklch(0.08…)`, light = `oklch(0.99…)`; `foreground`
ngược lại). Token 1 giá trị = giống nhau cả 2 mode. *(Thứ tự này đúng với layer
project `41476d15`/`4b2ecd3e`; nếu nghi ngờ, luôn kiểm bằng luminance của
`background`/`foreground`.)*

## Bind vào CSS: tokens → `:root` (light) + `html.dark` (dark)

Component tiêu thụ một tập biến cố định; map KG path → biến đó. `theme.css` đã có
`@theme inline { --color-X: var(--X) }`, nên chỉ cần set `--X`.

`background · foreground · card(+foreground) · popover(+foreground) · secondary(+fg)
· muted(+fg) · accent(+fg) · destructive(+fg) · border · input · input-border · ring
· success/warning/info(+fg)`. Cộng radius scale + control + type-scale (xem dưới).

### ⚙️ Resolver `kgRawValueToCss(path, rawValue)` — KHÔNG hand-derive

rawValue KG lưu ở **4 định dạng**; resolver dispatch theo định dạng → **CSS thuần**
(KHÔNG gõ lại tay giá trị nào → không drift, tự đúng khi KG đổi):

| Định dạng | Ví dụ rawValue | → CSS |
|---|---|---|
| **plain** | `oklch(…)` · `16px` | dùng nguyên |
| **paint JSON** | `{type:"paint",layers:[{kind:"gradient",angle,stops}]}` | `linear-gradient(angle, stops)` · solid → color · gradient lấy **mid-stop** làm `--primary` |
| **shadow JSON** | `{type:"shadow",layers:[{kind:"inner"\|"drop",x,y,blur,spread,color\|colorRef}]}` | `box-shadow: [inset] x y blur spread color` |
| **class-token** | `bg-[X] backdrop-blur-[28px] shadow-[…] before:bg-[…] before:[mask-composite:exclude]` | parse từng fragment → `background`/`backdrop-filter`/`box-shadow`/`::before{…}` |

> **Vì sao phải ra CSS thuần, không dùng lại class-token trên element:** đã test —
> in-browser Tailwind compile HỤT `shadow-[đa lớp oklch]` (ra trong suốt) và
> `[mask-composite:exclude]` (ra `add`). Resolver làm thay việc của Tailwind tại
> build-time (đúng cách theme-lab resolver của design-v3 sinh `.bg-card{…}` qua cssText).
> Fragment lạ → `console.warn` + bỏ qua, KHÔNG nuốt im lặng.

Implementation: `kgRawValueToCss` + `paintToCss`/`shadowToCss`/`classTokenToCss` trong
`builder/make-showcase.mjs`. Data thô nằm trong object `KG` (rawValue verbatim, `{d,l}`).

### Primary là GRADIENT — xử lý riêng (rất quan trọng)

`primary` trong KG là **paint gradient**, nhưng `bg-primary` của Tailwind resolve
ra **background-COLOR** → nhét gradient vào `--primary` sẽ vỡ (color-mix/border/ring
hỏng). Cách đúng:

```css
:root { --primary: oklch(0.55 0.21 275); /* mid-stop 275, solid hợp lệ */
        --primary-gradient: linear-gradient(135deg, oklch(0.46 0.18 258) 0%, oklch(0.55 0.21 275) 52%, oklch(0.66 0.19 240) 100%); }
.bg-primary { background-image: var(--primary-gradient) !important; }   /* gradient thật phủ lên */
```

### Type-scale → biến `.type-*` đọc

`theme.css` có utility `.type-<name>` đọc `--text-<name>-{family,size,line-height,
weight,tracking}`. KG layer typography phát `text-<name>` dạng JSON
`{family,size,lineHeight,weight,tracking}` → tách ra thành các biến đó.

## ⚙️ Mapping control & glass (ĐÃ RÀ SOÁT) — vì component hardcode size

**Mấu chốt:** bộ component react-shadcn **hardcode** kích thước (`h-8`…) và **không
đọc** token control của KG — *trừ Switch* (đã viết để đọc `--switch-*`). Nên muốn
control đúng "Large controls" của KG, phải **map thủ công qua `[data-slot]`**. Đây là
bảng đầy đủ đã verify (đo DOM), tránh sót slot (lỗi từng gặp: chỉ map `input` mà quên
`input-group` → lệch chiều cao):

| Control `data-slot` | Hardcode gốc | Token KG | Cách bind |
|---|---|---|---|
| `button` (+`data-size`) | h-8/7/9/6, icon size-8… | control-h 48/40/52/36 | set `height`/`width` theo `data-size`, `border-radius:var(--radius-control)` |
| `input`, `select-trigger` | h-8 (32) | input-height 48 | `height:var(--input-height)` + radius-input |
| `input-group` (wrapper) | h-8 (32) | 48 | `min-height:var(--input-height)` (min để biến thể textarea co giãn) |
| `textarea` | min-h-16 (64) | — | giữ 64 (multi-line), chỉ set radius |
| `switch` + `switch-thumb` | đọc `--switch-*` | 44×24, thumb 22 | **chỉ cần set var** `--switch-track-w/h`, `--switch-thumb` (thumb translate tự tính) |
| `checkbox`, `radio-group-item` | size-4 (16) | selection-indicator 24 | set `width/height:var(--selection-indicator-size)`, scale mark con |
| `toggle` | h-8 (32) | 48 | `height`+`min-width` 48, radius-control |
| `toggle-group-item` | h-8 (32) | 48 | `height`+`min-width` 48 (KHÔNG set radius — group lo bo góc segmented) |
| `input-otp-slot` | size-8 (32) | control-size 48 | `width/height:var(--control-size-default)` |
| `tabs-list` (+ `tabs-trigger`) | h-8 (32) | *không có token tab riêng* → reuse control-h-sm 40 / px-sm 16 | list `height:var(--control-h-sm)` + `padding:4px`; trigger `padding-inline:var(--control-px-sm)` (trigger tự fill `h-[calc(100%-1px)]`) |

**KHÔNG đụng** (đúng phạm vi — không phải form-control của layer này): `dropdown-menu-item`,
`select-item`, `command-item` (row menu); `accordion-trigger`; `slider`.

> Tabs là segmented-control nhưng layer "Large controls" KHÔNG phát token tab riêng.
> Để KHÔNG chế số mới, **reuse token control sẵn có** (`control-h-sm`=40, `control-px-sm`=16)
> thay vì để mặc định 32px (trông nhỏ lệch cạnh control 48px). Nguyên tắc: thiếu token
> chuyên dụng thì mượn token cùng họ trong KG, KHÔNG hardcode giá trị tự nghĩ.

### Glass thật (Payment Glass Pro card/popover)

Surface (`card`, `popover`) là **class-token** trong KG. Resolver `classTokenToCss`
parse ra: màu nền (`--card`/`--popover`) + `backdrop-filter` (blur 28/24 + saturate) +
`box-shadow` (`--glass-*-shadow`) + **viền hairline gradient `::before`**
(`--glass-*-hairline` + `mask`/`mask-composite:exclude` từ chính class-token). Áp qua
`[data-slot]`:
- `card` → `[data-slot="card"]` + `::before`.
- popover-family (`popover-content, dialog-content, alert-dialog-content,
  sheet-content, drawer-content, dropdown-menu-content, dropdown-menu-sub-content,
  select-content, hover-card-content, tooltip-content`) → tương tự, blur 24px.

Mọi giá trị (blur, shadow, hairline gradient, mask) **resolve từ rawValue KG**, biến
`--glass-*` tách **light/dark** để toggle không cần rebuild.

## ⚡ Kiến trúc 3 tầng mới: structure ở SHELL, brand.css chỉ chở GIÁ TRỊ

Từ bản nâng cấp "Token từ KG, sáng tác mức A": các block structural ([data-slot]
glass/control/tabs) đã chuyển **vĩnh viễn vào shell** (`builder/shell-structural.css`,
mọi var có fallback = cỡ gốc component nên composition phẳng tự degrade). Reskin
artifact giờ KHÔNG đụng shell: lấy `cssVars` từ `ui_tokens_get` (hoặc
`tools-kg css <comp> --vars-only`) → ghi `<artifact>/brand.css` hoặc dán slot
`<style id="brand">`. Default values của shell sinh từ
`assets/vnpay-glass-vars.css` (regenerate: `pnpm tools-kg css <glass-comp-id>
--vars-only --out skills/react-shadcn/assets/vnpay-glass-vars.css`).

## Tạo BRAND/STYLE MỚI trong KG local (không cần sửa make-showcase.mjs)

Từ khi có style-authoring tools trên MCP `kg-local`, reskin **không còn phải dán
rawValue vào `make-showcase.mjs`**: tạo theme/composition ngay trong KG local
(`ui_theme_upsert` based-on layer cũ → `ui_token_values_set` override →
`ui_composition_upsert` mix với layer clone → `ui_composition_export_css` ra
stylesheet cùng shape `vnpay-glass.css`). Resolver (`tools/kg/src/kg-css.ts`) là
bản port verbatim của `kgRawValueToCss` dưới đây — 2 nơi phải giữ sync. Quy
trình chi tiết + ví dụ emerald đã verify: `references/screen-graph-authoring.md`
mục "Style authoring".

## Triển khai chuẩn (single source) + cách regenerate

- **`builder/make-showcase.mjs`** = reference implementation: pull-7-layer → sinh CSS.
- **`assets/vnpay-glass.css`** = stylesheet brand **độc lập, tái dùng** (auto-generated).
  Include **SAU** `theme.css` để `:root`/`html.dark` thắng `@layer base`.
- **`assets/showcase.html`** = gallery 40 component xác minh bằng mắt (light/dark toggle).

```bash
cd builder
node make-showcase.mjs        # → assets/showcase.html + assets/vnpay-glass.css
PW_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  node shot.mjs ../assets/showcase.html /tmp/showcase.png   # verify render
```

**Reskin sang brand khác** = đổi `composition_id`, pull lại đủ 7 layer, **dán rawValue
verbatim vào object `KG`** trong `make-showcase.mjs` (KHÔNG convert tay — resolver lo),
regenerate. Quy trình y hệt — chỉ data đổi.
