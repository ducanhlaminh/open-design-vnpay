---
name: ui-react-ds
description: |
  Terminal UI-Spec option of the docs-to-ui workflow (the `ui-react-ds` pipeline — React app built ON the
  imported design system). Read the UX Spec (S_SCREEN_SPEC screens produced by
  the `ux-spec` pipeline) and author a REAL, buildable Vite + React 19 app whose
  screens compose EXCLUSIVELY from the selected design system's compiled react
  bundle (a Figma IR import: `src/ds/components/ui/*` + CSS-variable tokens +
  single-declaration `tk-*` classes — NO Tailwind, NO shadcn). The daemon stages
  the bundle into the run cwd before this skill starts. Build with the isolated
  toolkit backend (`builder/build.sh`) until green; the deliverable is
  `./react-ds/dist/` plus its `./react-ds/src/` source. Activate when the user
  runs the "UI-Spec (React DS)" pipeline. Different from `ui-react` (generic
  shadcn/Tailwind app) — here the component vocabulary and every visual value
  come from the imported design system, not from a generic kit.
triggers:
  - "ui react ds"
  - "react design system app"
  - "ui-spec react ds"
od:
  mode: prototype
  category: web-artifacts
  craft:
    requires:
      - anti-ai-slop
      - laws-of-ux
      - state-coverage
      - accessibility-baseline
      - layout-primitives
---

# ui-react-ds — UX Spec → React app trên bộ design system đã import

Final stage of the **docs → React (DS)** workflow. You turn the UX Spec screen
definitions into a **real Vite + React 19** application whose screens are
assembled from the **imported design system's own component source** — the
compiled Figma bundle the daemon staged into your working directory.

## How this skill works (read first)

- The **build toolchain** (React 19, Vite, tsc) lives in the shared
  `uireact-base` Docker image — you never run `npm`/`pnpm install`. There is
  **NO Tailwind** in this stage; do not write Tailwind classes.
- The **design system bundle is already staged** by the daemon before you start:
  - `./react-ds/src/ds/components/ui/*.tsx` — one React component per Figma
    component set (variant props). **Read-only.**
  - `./react-ds/src/ds/components/icons/*.tsx` — icon components. **Read-only.**
  - `./react-ds/src/ds/lib/runtime.tsx` — `Svg` / `P` / `Icon` runtime. **Read-only.**
  - `./react-ds/src/ds/styles/globals.css` — every design token as a CSS
    variable (per collection/mode; dark modes double as `.dark`) + the complete
    `tk-*` utility vocabulary. **Read-only.**
  - `./react-ds/src/ds/docs/catalog.md` — **the component API reference**: every
    component's props / variant options. Read it BEFORE authoring screens.
  - `./react-ds/src/ds/docs/STYLE-GUIDE.md` — the token contract rules.
  - `./react-ds/public/assets/` — icon/vector SVGs the runtime lazy-fetches.
    **Read-only.** The build copies them into `dist/assets/`.
- Running the build script **seeds** the rest of the project scaffold into
  `./react-ds/` on first call (`package.json`, `vite.config.ts`,
  `tsconfig.json`, `index.html`, `src/main.tsx`, `src/index.css`, sample
  `src/App.tsx` + `src/screens/`). You **replace the sample screens** with the
  real ones from the spec.
- The component architecture is **three layers**:
  1. `src/ds/` — the staged design system. **Never author or edit anything here.**
  2. `src/components/app/` — **YOUR app component layer**: use-case composites
     wrapping the ds components (screen shell, money rows, confirm dialogs…).
  3. `src/screens/` — thin screens composed mostly from `@/components/app/*`,
     dropping to raw ds components for one-off cases.

### The build script

The build backend ships with this skill at **`builder/build.sh`** (skill root is
advertised in the preamble above — use the relative form). Run it from your
working directory:

```bash
bash .od-skills/ui-react-ds/builder/build.sh ./react-ds
```

It seeds the scaffold (idempotent — never clobbers your or the daemon's files),
then runs `tsc --noEmit && vite build` and writes `./react-ds/dist/`. **This is
your feedback loop: build → read errors → fix `src/` → build again, until it is
green.**

Sau khi `vite build` xanh, script chạy tiếp **`builder/verify.mjs`** — cổng
design-system: nó soi `src/screens/` + `src/components/` và **fail build**
khi bạn inline token thay vì dùng class `tk-*`, viết hex/rgb, viết GIÁ TRỊ
literal cho thuộc tính styling (`fontSize: 14`, `color: 'white'`,
`borderRadius: 8`…), hay dựng tay khung màn mà DS đã có component cùng nhóm
(khớp mờ theo tên: `i-pay-dialog`, `dialog-action` đều thuộc nhóm Dialog).
Lỗi in ra kèm class `tk-*` / tên component thay thế — sửa theo đúng gợi ý rồi
chạy lại. Muốn xem báo cáo mà không chặn: `UIREACT_VERIFY_SOFT=1`.

## LUẬT token & styling (bắt buộc — đây là điểm khác ui-react)

1. **CHỈ dùng token của bộ DS** cho màu, khoảng cách, bo góc, chữ — qua class
   `tk-*` khai báo trong `src/ds/styles/globals.css`. **KHÔNG bịa hex/px mới.
   KHÔNG Tailwind. KHÔNG utility tự chế.**
2. **Token PHẢI đi qua class `tk-*`, KHÔNG viết inline `style={{ …:
   'var(--token)' }}`** cho nhóm thuộc tính "giá trị": màu (`color`,
   `background*`, `border*Color`, `fill`, `stroke`), chữ (`fontSize`,
   `fontWeight`, `lineHeight`, `letterSpacing`, `fontFamily`), `borderRadius`,
   `boxShadow`.

   > **Vì sao:** bước "Capture Figma" chỉ đọc `classList` để nhận diện token
   > (`stampFigMarkers` dựng bảng token từ CSS rule `.tk-*`). Token viết inline
   > `var()` chạy đúng trên web nhưng **sang Figma thành giá trị chết** — mất
   > liên kết variable, mất text style. Đây là lỗi im lặng: build vẫn xanh,
   > chỉ file Figma là hỏng.

   Tra class theo tên token: token `--font-size-sm` → class `tk-fs-font-size-sm`;
   `--ground-foreground` → `tk-text-ground-foreground` / `tk-bg-ground-foreground`.
   Tiền tố: `tk-bg-` `tk-text-` `tk-border-` `tk-rounded-` `tk-shadow-`
   `tk-fs-` `tk-fw-` `tk-lh-` `tk-ls-` `tk-font-family-` `tk-fill-` `tk-stroke-`.
   **Thiếu class cho cặp (thuộc tính × token) bạn cần → đổi sang token khác đã
   có class, đừng inline.**
3. **Ưu tiên COMPONENT có sẵn** trong `src/ds/components/ui/` (API xem
   `src/ds/docs/catalog.md`) thay vì tự dựng markup. Icon lấy theo tên qua
   `Icon` của `src/ds/lib/runtime` hoặc component trong `components/icons/`.

   **Khung màn KHÔNG được dựng tay bằng `<div>`** khi bộ DS đã có — đọc mục
   "Screen scaffolding" ở đầu `catalog.md` trước khi viết `components/app/`:
   app bar / header, bottom sheet, dialog, tab bar & navigation bar, card,
   list item, snackbar/note. Tự dựng lại = mất instance khi sang Figma.

   Nếu component của nhóm đó **thật sự không dùng được** (text cứng không có
   prop override, không nhận handler…), khai báo ngoại lệ NGAY TRONG file tự
   dựng — verify sẽ cho qua nhưng in cảnh báo để reviewer thấy:

   ```
   // od-verify-allow: scaffold — <lý do cụ thể, ví dụ: i-pay-dialog label cứng "Label", không nhận onClick>
   ```

   Đây là lối thoát CUỐI CÙNG cho đúng file đó — không phải cách né luật;
   composite tự dựng vẫn phải bọc tối đa các atom DS (overlay, button…) và
   style 100% qua class `tk-*`.
4. Layout thuần (`display` / `flex*` / `gap` / `position` / `inset` / `zIndex`
   / `width` / `height` / padding-margin số) được phép viết inline `style` —
   đó là cấu trúc, không phải styling giá trị.
5. **`src/styles/layout.css` — file CSS DUY NHẤT bạn được sửa, và CHỈ chứa
   layout.** Dùng cho (a) breakpoint responsive và (b) class layout tái dùng
   mà inline style không tả được. Quy tắc:
   - Mọi class định nghĩa ở đó phải prefix **`ly-`**; dùng class `ly-*` chưa
     định nghĩa trong file = lỗi verify.
   - CHỈ thuộc tính layout (display/flex*/grid*/gap/position/inset/z-index/
     size/min-max/padding/margin/overflow/order/aspect-ratio). Màu / chữ /
     radius / shadow trong file này = **verify FAIL** — styling giá trị vẫn
     phải qua class `tk-*` trong markup.
   - **Target website (responsive)**: breakpoint khai ở đây, desktop-first,
     adapt tại `@media (max-width: 768px)` theo đúng `responsive_notes` của
     từng màn trong UX spec. Không có `@media` nào = verify FAIL.
   - **Target mobile-app (fixed viewport 390px)**: CẤM `@media` — một layout
     duy nhất. (Daemon ghi target của run vào `./react-ds/.od-target.json`;
     verify đọc file đó, bạn không cần khai gì.)
6. **Dark mode / brand theme**: đổi class `.dark` / `.mode-*` trên root — token
   tự đổi. KHÔNG viết màu dark thủ công. Không tự chế theme provider.

## Workflow (do these in order)

### 1a. Apply Design System review rules
Read `./criteria/rules.md` when present before implementing screens. It may be hand-authored OR auto-generated by the daemon from the DS's showcase + tokens, so apply whatever it contains — overlays, feedback, tables, badges, primary actions, layout, states, plus color/typography/spacing/elevation/radius — citing the **exact anchor written in the file** when a rule drives a choice. Use `./criteria/components.md` as the closed validity set and `src/ds/docs/catalog.md` for implementation details. Missing criteria files are valid.

### 1. Seed + read the spec
Run the build script once so the scaffold exists green, then read the UX Spec
(`../ux/*-ux-spec.json` + `../wireframes/` + `../flows/` from the ux stage) and
`src/ds/docs/catalog.md`. The wireframe IS the layout contract — do NOT
re-derive layout from prose.

**Đọc `data-comp` trên từng block wireframe** — đó CHÍNH LÀ anchor component
DS phải dựng. Đối chiếu anchor với `criteria/components.md` và vai trò trong
`catalog.md`; không map theo slug. Block không có `data-comp` thì tự dựng bằng
markup + class `tk-*`. Wireframe nhắc component đặc thù qua nội dung và cấu
trúc HTML — tra catalog để chọn đúng component.

Component trong `criteria/components.md` không có dòng "Mô tả:" → tra
`criteria/components-guide.md` (cùng thư mục, nếu tồn tại) theo đúng anchor
`#figma-…`: đó là mô tả do AI sinh từ phân tích node + ảnh Figma — dùng làm
ngữ cảnh để hiểu component, KHÔNG dùng thay cho anchor DS phải trỏ tới (vẫn
chỉ `criteria/components.md#…`), và khi trích dẫn trong code comment phải ghi
rõ nguồn "(AI sinh)". File không tồn tại hoặc không có entry cho component đó
→ coi như component không có mô tả, xử lý như trước nay.

**Block wireframe có `data-comp` = lựa chọn ĐÃ ĐƯỢC NGƯỜI CHỐT** (gán trong
preview ux-spec): block đó PHẢI dựng bằng đúng component ấy — không thương
lượng. Verify sẽ fail nếu một component đã chốt không được dùng.

### 2. Design the app component layer (`src/components/app/`)
Derive the recurring patterns across screens (screen shell with AppBar/BottomBar,
form field rows, money/amount displays, list rows, confirm dialogs, result
states…) and author them ONCE as composites that wrap the ds components.
Export through an `index.ts` barrel. Recurring patterns appear exactly once in
the codebase.

### 3. Author one screen component per spec screen
`src/screens/<slug>.tsx`, **default-export**, composed from
`@/components/app/*` first, raw ds components second. Every screen the spec
declares — no invented screens. Follow the wireframe structure; cover the
states the spec calls out (empty / loading / error where declared).

### 4. Wire routes in `src/App.tsx` + emit `flow.json`
Same contract as the ui-react stage — the canvas and the use-case simulator
depend on it:

- Import screens as defaults, one `<Route>` per screen inside the shipped
  **`HashRouter`**; first screen is `path="/"`. Cross-screen flow via
  `useNavigate()` / `<Link>`.
- Write **`./react-ds/flow.json`** — the user-action flow from the journey.
  When the ux run authored `../flows/<FLOW-ID>.flow.json`, reuse its edge
  labels VERBATIM. Edge shape:

  ```json
  [
    { "from": "login", "to": "home",  "label": "đăng nhập" },
    { "from": "home",  "to": "home",  "label": "mở bộ lọc", "type": "dialog", "overlay": "sheet" },
    { "from": "home",  "to": "home",  "label": "áp dụng",   "type": "dismiss" }
  ]
  ```

  `type`: omitted/`"navigate"` = route change; `"dialog"` = opens an overlay
  INSIDE the same screen (`to` = `from`, carry `"overlay": "dialog" | "sheet" |
  "drawer"`); `"dismiss"` = the control that closes/confirms it.
- Overlay screens from the UX Spec (`overlay_kind` + `overlay_of`) are NOT
  separate routes — render them inside their base screen with the matching ds
  component (Dialog / ActionSheet / BottomSheet…), wired as `dialog`+`dismiss`
  edge pairs.
- **`#od-open` contract**: every overlay's open state MUST honor the URL hash
  `#od-open=<label>` (label = the open edge's exact `label`). Implement one
  `useOdOpen(label)` helper in `src/components/app/` and use it as each
  overlay's initial open state.
- Bind every flow edge's `label` to its real trigger element via
  **`data-flow-action="<label>"`** on the `from` screen — the simulator clicks
  these for real.
- Also write `./react-ds/layout.json` (`{"screens": {"<slug>": "mobile" | "web"}}`)
  from the spec's per-screen `layout`.

### 5. Build until green
`bash .od-skills/ui-react-ds/builder/build.sh ./react-ds` — read `tsc`/`vite`
errors, fix `src/`, repeat until it exits 0 and writes `./react-ds/dist/`.

## capture.config.json — khai states cho "Capture Figma" (bắt buộc cập nhật)

The project ships `./react-ds/capture.config.json`. The **Capture Figma** button
(and `od pipeline figma-capture`) drives the BUILT app with Playwright and
turns every screen + state into a Figma frame (real component instances via the
`data-fig-comp` markers your ds components already carry). Without config
entries it falls back to one stateless capture per built screen — you MUST
declare states for every interaction-revealed UI so no overlay/picker/tab is
lost. Rules (mirrors design-v3's `fig-playwright`):

- One entry per screen: `{ "path": "/<route>", "name": "<NN> <Tên màn>", "states": [...] }`.
  `path` is the screen's hash route (`/` prefix, no `#`); `name` starts with
  the screen's order number — it becomes the Figma frame name.
- A **state** is a VISUAL variant of the SAME screen (dialog open, dropdown
  expanded, tab switched, date picked): `{ "name": "<Tên state>", "clicks": ["<selector>", ...] }`.
  Each state reloads the screen from scratch — `clicks` must be the FULL
  Playwright-selector chain from the default state (picker open + day 29 = 2
  clicks), never cumulative from the previous state.
- Do NOT declare states for navigation (the destination is another screen's
  entry) or for hover-only affordances.
- Selectors: prefer `text=<nhãn hiển thị>`; fall back to a stable attribute you
  rendered (e.g. `[data-flow-action="<label>"]`).
- **Viewports**: KHÔNG cần khai — target responsive tự capture mỗi màn/state ở
  cả 1440 lẫn 390 (frame Figma `<tên> · <width>`), target mobile-app chỉ 390.
  Chỉ thêm `"viewports": [<width>…]` khi muốn override danh sách đó.

## Hard rules
- **Author only `./react-ds/src/`** (screens, `src/components/app/`, `App.tsx`,
  `main.tsx`, `src/styles/layout.css`) **+ `./react-ds/flow.json` +
  `./react-ds/layout.json`**. Do NOT edit `package.json` / `vite.config.ts`
  (keep `base: './'`) / `tsconfig.json` / `index.html` / anything under
  `src/ds/` or `public/` / the generated `screens/` entries.
- `src/index.css` stays as shipped (it imports the ds globals + layout.css and
  carries the `OD-LAYOUT-PRIMITIVES v1` block) — theming is mode classes; the
  ONLY editable stylesheet is `src/styles/layout.css` (layout-only, rule 5
  above). The shipped `od-*` structure classes (`.od-stat`, `.od-truncate`,
  `.od-nowrap`, `.od-rail`, `.od-screen`…) are allowed in `className` and pass
  verify; use them per the `layout-primitives` craft section before writing a
  new `ly-*` rule for the same shape.
- **Dependencies:** `react`, `react-dom`, `react-router-dom` only. Do NOT run
  `npm`/`pnpm install`; do NOT import anything else — the ds components are
  dependency-free by construction.
- **Deliverable is the built app:** finish only when `build.sh` is GREEN and
  `./react-ds/dist/` exists. A red build is not done.
- Do not invent screens that aren't in the spec; do render every screen that is.

## Done when
- `build.sh` is green → `./react-ds/dist/index.html` **and**
  `./react-ds/dist/screens/<slug>.html` (one per screen) exist, AND
- there is one `src/screens/<slug>.tsx` (default-export) + `<Route>` per UX
  Spec screen, cross-screen navigation is wired, and `./react-ds/flow.json` +
  `./react-ds/layout.json` reflect it, AND
- every `flow.json` edge has its `data-flow-action="<label>"` element on the
  `from` screen, AND
- screens use ONLY ds components + `tk-*`/`ly-*` classes — **`builder/verify.mjs`
  exits 0** (nó chặn: inline `style` mang `var(--token)` cho màu/chữ/radius/
  shadow, hex/rgb literal, giá trị literal cho thuộc tính styling — `fontSize:
  14`, `color: 'white'`, `borderRadius: 8`…, class utility tự chế / Tailwind,
  class `ly-*` chưa định nghĩa, giá trị styling hay class không-`ly-` trong
  `layout.css`, thiếu `@media` khi target responsive / có `@media` khi target
  mobile-app, khung màn dựng tay khi DS đã có component cùng nhóm — check TỪNG
  FILE, file nào dựng tay phải tự import component nhóm đó hoặc khai
  `// od-verify-allow: scaffold — <lý do>`, và file render markup mà KHÔNG
  tham chiếu token tk-* / component DS / app-layer nào). Verify đỏ = chưa xong;
  đừng bypass bằng `UIREACT_VERIFY_SOFT`.

Report the number of screens built + the app-layer component list, and stop.
