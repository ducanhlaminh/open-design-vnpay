# Wireframe files — `wireframes/<SCREEN-ID>.wire.json` (DSL v2)

For EVERY screen in the UX Spec, also author one wireframe JSON at
`./wireframes/<SCREEN-ID>.wire.json` (e.g. `wireframes/SCR-TRANSFER.wire.json`).
The file name IS the join to the spec — it must equal a `screens[].id` exactly.

This file is not just a picture: the **UI stages read it as the layout contract**
(`ui-react` builds the screen from this tree with the mapped shadcn components),
and `ux-review` judges usability on it. Author it as carefully as the spec.

## Two rules that make or break the file

1. **Layout is a TREE, never coordinates.** Describe containers and components
   like HTML/JSX structure. The host lays it out with real flexbox, so it can
   never overlap or misalign. Do NOT compute col/row positions.
2. **The component vocabulary is CLOSED.** Every leaf's `c` must be a slug from
   **`wire-components.md`** (generated from `wire-registry.json`). An unknown
   slug fails validation and renders as a red `?slug` badge.

Validate before you finish — this is not optional. `<SKILL-ROOT>` is the
`.od-skills/…` path from the preamble at the top of the skill:

```bash
node <SKILL-ROOT>/scripts/validate-wire.mjs ./wireframes --spec ./<feature>-ux-spec.json
```

## Shape

```jsonc
{
  "dslVersion": 2,
  "layout": { "dir": "stack", "children": [ WireNode, ... ] }
}
```

**Container** — groups children:
```jsonc
{ "dir": "stack" | "row", "children": [ ... ],
  "gap": "sm" | "md" | "lg" | "none",   // spacing between children (default md)
  "align": "start" | "center" | "end" | "between" | "stretch",
  "card": true,                          // draw a bordered card around the group
  "label": "Thông tin giao dịch",        // section label above the group
  "grow": 1,                             // fill remaining space in a parent row
  "w": 260 }                             // OR a fixed width in px (a sidebar)
```

**Leaf** — one component: a registry slug in `c`, its props in `props`:
```jsonc
{ "c": "shadcn:Input",  "props": { "label": "Số tài khoản nhận", "hint": "Danh bạ" } }
{ "c": "shadcn:Select", "props": { "label": "Ngân hàng thụ hưởng", "options": ["Vietcombank", "BIDV"] } }
{ "c": "shadcn:Tabs",   "props": { "items": ["Chuyển đến TK", "Chuyển đến Thẻ"], "active": 0 } }
{ "c": "shadcn:Table",  "props": { "columns": ["Mã", "Khách", "Số tiền"] } }
{ "c": "shadcn:Button", "props": { "label": "Tiếp tục", "block": true, "navigatesTo": "SCR-OTP" } }
{ "c": "mobile:AppBar", "props": { "label": "Giao dịch", "back": true } }
{ "c": "mobile:BottomNav", "props": { "items": ["Trang chủ", "Giao dịch", "Cá nhân"], "active": 0 } }
```

- `block: true` on the primary action = full-width / solid.
- `active` = the selected INDEX (tabs, chips, radio, sidebar, bottom nav).
- `navigatesTo` mirrors the spec component's `navigates_to` — keep them the same.
- Leaves stretch to full width inside a `stack` (like real form fields). In a
  `row`, use `grow` to fill or `w` for a fixed width.

**The full slug list, their props, and what each becomes in `ui-react` /
`ui-html` / `ui-rn`: `wire-components.md`.** Read it before authoring — picking
the right slug is how the UI stage builds the right component.

> Legacy files use `componentType: "input"` instead of `c: "shadcn:Input"`. Those
> still render (the registry maps old names), but **author new files in v2** —
> the validator flags v1 names with the v2 slug to use.

## Mobile app vs Web — one tree, or three

- A **mobile app** screen (screen `layout: "mobile"`) → author ONE `layout` tree
  (a phone). Nothing else.
- A **web** screen (screen `layout: "web"`) → author a REDESIGN per device, not
  one tree that just shrinks. A desktop 2-column layout must become a stacked,
  hamburger/bottom-nav layout on a phone — that is a different tree, not the same
  boxes narrower. Put each device's tree in `layouts`:
  ```jsonc
  {
    "dslVersion": 2,
    "layout":  { /* DESKTOP tree — also the fallback */ },
    "layouts": {
      "tablet": { /* redesigned for ~834px — condense, fewer columns */ },
      "mobile": { /* redesigned for ~390px — single stack, top/bottom nav */ }
    }
  }
  ```
  The host shows a Desktop / Tablet / Mobile switch and renders the matching
  tree. A device you omit from `layouts` just reflows the desktop tree (marked
  "co lại" in the UI) — so DO author `tablet` and `mobile` for web screens.

## Secondary states are their OWN screens (dialog / drawer / sheet)

A wireframe shows ONE state. A nav drawer, a confirm dialog, an action sheet, a
record-voice overlay — these are separate STATES that sit on top of a base
screen. Model each as its own screen (see `schema.md` `overlay_kind` +
`overlay_of`) with its own `wire.json`, and mark that wire as an overlay:

```jsonc
{ "dslVersion": 2,
  "overlay": "dialog",          // "dialog" | "drawer" | "sheet"
  "overlayOf": "SCR-VOICE",     // base screen id (omit for a GLOBAL overlay)
  "layout": { /* JUST the overlay's own content: the dialog body / drawer menu /
                 sheet actions — NOT the whole page. The host draws the base
                 screen dimmed behind it. */ } }
```

Rules for overlays:
- The **base screen** shows the CLOSED trigger, not the open overlay: a mobile
  base uses `mobile:AppBar` (☰), not an inline open drawer. Don't bake the open
  state into the base tree.
- The **global nav drawer** is authored ONCE (one screen, `overlay_of: null`),
  shared by every screen's ☰ — do NOT duplicate a nav drawer per screen.
- Author a screen-specific overlay only when it carries real UX: a destructive
  confirm (`dialog`), a long-press action menu (`sheet`), a filter panel
  (`sheet`/`drawer`), a transient mode (record voice → `sheet`/`dialog`).
- Overlay content leaves are ordinary slugs — `overlay` is a document-level
  field, there is no `shadcn:Dialog` leaf.

## Archetypes — match the screen to a shape

**Mobile (layout `mobile`)** → ONE `stack`, top to bottom. This is the reliable
default; keep each control full-width, group related fields, label sections.
Put chip-style choices in a `row` (or use `shadcn:ToggleGroup`).

**Web (layout `web`)** → author THREE trees (`layout` = desktop, `layouts.tablet`,
`layouts.mobile`). Each is a real redesign for its width:

- **Desktop** (`layout`, ~1280px): top `shadcn:NavigationMenu`, then a `row` of a
  fixed-width `shadcn:Sidebar` (`w`) + a growing main (`grow`). Wide tables,
  multi-column forms, content side-by-side. Use `shadcn:Table` for tabular data,
  not a list.
- **Tablet** (`layouts.tablet`, ~834px): DROP the sidebar into a slim rail or a
  `shadcn:Tabs` bar across the top; main becomes one column (or two `grow`
  columns at most). Keep tables but with fewer columns. Forms go 1–2 columns.
- **Mobile** (`layouts.mobile`, ~390px): ONE `stack`, and apply REAL mobile
  patterns — this is where the redesign matters most:
  - Desktop **sidebar / nav menu** → `mobile:AppBar` (hamburger + title) at the
    top, and move its menu items into `mobile:NavDrawer` (secondary/many
    destinations) OR `mobile:BottomNav` pinned last (≤5 primary destinations).
    Do NOT keep `shadcn:NavigationMenu` — that's a desktop pattern.
  - Desktop **`shadcn:Table`** → `shadcn:Item` rows (one line per record), never
    a squeezed multi-column grid.
  - Multi-column **forms** → single column, every field full-width.
  - The main create/compose action → `mobile:Fab`, or a `shadcn:Button` with
    `block: true` pinned at the bottom.

The redesign is STRUCTURAL, not cosmetic: desktop `row` of sidebar+main → mobile
`mobile:AppBar` + `stack` + drawer/bottom nav; desktop table → mobile item list.
If the mobile tree still has a sidebar `row` or a `shadcn:Table`, it's wrong.

## Full mobile example (a transfer screen)

```jsonc
{ "dslVersion": 2, "layout": { "dir": "stack", "gap": "md", "children": [
  { "c": "mobile:AppBar", "props": { "label": "Chuyển tiền ngoài VBSP", "back": true } },
  { "c": "shadcn:Tabs", "props": { "items": ["Chuyển đến TK", "Chuyển đến Thẻ"], "active": 0 } },
  { "card": true, "dir": "stack", "gap": "sm", "children": [
    { "c": "shadcn:Text", "props": { "label": "Từ tài khoản  ·  7062598067" } },
    { "c": "shadcn:Text", "props": { "label": "Số dư khả dụng  ·  701,073,440 VND" } }
  ] },
  { "label": "Thông tin giao dịch", "dir": "stack", "gap": "sm", "children": [
    { "c": "shadcn:Select", "props": { "label": "Ngân hàng thụ hưởng" } },
    { "c": "shadcn:ToggleGroup", "props": { "items": ["Vietcombank", "BIDV", "VIETINBANK"], "active": 0 } },
    { "c": "shadcn:Input", "props": { "label": "Số tài khoản nhận", "hint": "Danh bạ" } },
    { "c": "shadcn:Input", "props": { "label": "Số tiền", "hint": "VND" } }
  ] },
  { "dir": "row", "align": "between", "children": [
    { "c": "shadcn:Text", "props": { "label": "Phí chuyển tiền" } },
    { "c": "shadcn:Text", "props": { "label": "5,500 VND" } }
  ] },
  { "c": "shadcn:Textarea", "props": { "label": "Nội dung", "hint": "24/200" } },
  { "c": "shadcn:Button", "props": { "label": "Tiếp tục", "block": true, "navigatesTo": "SCR-OTP" } }
] } }
```

## Full web example (a transactions screen — 3 devices)

```jsonc
{
  "dslVersion": 2,
  "layout": {                               // DESKTOP: sidebar + main, wide table
    "dir": "stack", "gap": "md", "children": [
      { "c": "shadcn:NavigationMenu", "props": { "label": "Quản lý giao dịch", "items": ["Tổng quan", "Giao dịch", "Báo cáo"] } },
      { "dir": "row", "gap": "lg", "align": "start", "children": [
        { "c": "shadcn:Sidebar", "w": 240, "props": { "items": ["Tất cả", "Chờ duyệt", "Đã duyệt", "Từ chối"], "active": 0 } },
        { "dir": "stack", "grow": 1, "gap": "md", "children": [
          { "dir": "row", "gap": "sm", "children": [
            { "c": "shadcn:InputSearch", "grow": 1, "props": { "placeholder": "Tìm giao dịch" } },
            { "c": "shadcn:Select", "w": 180, "props": { "label": "Trạng thái" } }
          ] },
          { "c": "shadcn:Table", "props": { "columns": ["Mã", "Khách hàng", "Số tiền", "Trạng thái"] } },
          { "c": "shadcn:Pagination", "props": { "pages": 5, "active": 0 } }
        ] }
      ] }
    ]
  },
  "layouts": {
    "tablet": {                             // TABLET: nav as top tabs, no sidebar
      "dir": "stack", "gap": "md", "children": [
        { "c": "shadcn:NavigationMenu", "props": { "label": "Quản lý giao dịch" } },
        { "c": "shadcn:Tabs", "props": { "items": ["Tất cả", "Chờ duyệt", "Đã duyệt"], "active": 0 } },
        { "c": "shadcn:InputSearch", "props": { "placeholder": "Tìm giao dịch" } },
        { "c": "shadcn:Table", "props": { "columns": ["Khách hàng", "Số tiền", "Trạng thái"] } }
      ]
    },
    "mobile": {                             // MOBILE: appbar + item list + bottom nav
      "dir": "stack", "gap": "sm", "children": [
        { "c": "mobile:AppBar", "props": { "label": "Giao dịch", "menu": true } },
        { "c": "shadcn:Tabs", "props": { "items": ["Tất cả", "Chờ duyệt"], "active": 0 } },
        { "c": "shadcn:InputSearch", "props": { "placeholder": "Tìm giao dịch" } },
        { "c": "shadcn:Item", "props": { "items": ["NGUYEN VAN A · 5,500,000 · Chờ duyệt", "TRAN THI B · 1,200,000 · Đã duyệt"], "navigatesTo": "SCR-TXN-DETAIL" } },
        { "c": "mobile:BottomNav", "props": { "items": ["Giao dịch", "Báo cáo", "Cá nhân"], "active": 0 } }
      ]
    }
  }
}
```

## Rules

- Compose a REAL screen: use `card` to group, `label` for sections, `row` for
  side-by-side items (a label + value, sidebar + main). Don't dump a flat list of
  loose components.
- Keep it to the screen's actual `components[]` from the UX Spec, in a sensible
  order — but arrange them into the archetype above, don't just stack blindly.
- Reuse the SAME skeleton (app bar / tabs / sidebar) across screens of one product.
- The primary action gets `"block": true`.
- **Web screens: author `layouts.tablet` and `layouts.mobile`**, each a real
  redesign (sidebar→top-nav, table→item list). A mobile APP screen has only `layout`.
- **Run the validator before finishing.** Zero errors is the bar; fix every
  warning that names a v1 slug.
