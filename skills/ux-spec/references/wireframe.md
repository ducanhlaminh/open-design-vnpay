# Wireframe files — `wireframes/<SCREEN-ID>.wire.json`

For EVERY screen in the UX Spec, also author one wireframe JSON at
`./wireframes/<SCREEN-ID>.wire.json` (e.g. `wireframes/SCR-TRANSFER.wire.json`).
This is the screen's visual LAYOUT — the host renders it and it opens in the
wiretext.app editor for hand-tweaks.

## Author a LAYOUT TREE — never pixel coordinates

Describe the screen as a **tree of containers and components**, exactly like you
would write HTML/JSX structure. The host lays it out with real flexbox, so it can
never overlap or misalign. **Do NOT compute col/row coordinates** — just express
the STRUCTURE (what stacks vertically, what sits in a row).

```jsonc
{
  "layout": {
    "dir": "stack",            // stack = vertical column; row = horizontal
    "children": [ WireNode, ... ]
  }
}
```

## Mobile app vs Web — one tree, or three

- A **mobile app** screen (screen `layout: "mobile"`) → author ONE `layout` tree
  (a phone). Nothing else.
- A **web** screen (screen `layout: "web"`) → author a REDESIGN per device, not
  one tree that just shrinks. A desktop 2-column layout must become a stacked,
  hamburger/bottom-nav layout on a phone — that is a different tree, not the same
  boxes narrower. Put each device's tree in `layouts`:
  ```jsonc
  {
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

### Node kinds

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

**Leaf** — a single component (`componentType` + props). Common types:
`navbar`, `tabs`, `section`, `text`, `heading`, `input`, `search`, `textarea`,
`select`, `checkbox`, `radio`, `toggle`, `button`, `chip`, `chips`, `list`,
`table`, `card`, `stat`, `progress`, `stepper`, `avatar`, `image`, `divider`,
`alert`, `spacer`.

**Mobile navigation leaves** (use these when redesigning a web screen for
`layouts.mobile` — a desktop sidebar/top-nav does NOT survive as-is on a phone):
`appbar` (top bar: hamburger + title + one action), `drawer` (the off-canvas
menu shown open, with a scrim — what a sidebar/nav menu BECOMES on mobile),
`bottomnav` (bottom tab bar for ≤5 primary destinations), `fab` (floating
primary action). Example props:
```jsonc
{ "componentType": "appbar", "label": "Giao dịch" }
{ "componentType": "drawer", "label": "VBSP", "items": ["Trang chủ", "Chuyển tiền", "Lịch sử", "Cài đặt"], "activeStep": 1 }
{ "componentType": "bottomnav", "items": ["Trang chủ", "Giao dịch", "Thẻ", "Cá nhân"], "activeTab": 0 }
{ "componentType": "fab", "icon": "+" }
```
Props per leaf:
```jsonc
{ "componentType": "input", "label": "Số tài khoản nhận", "hint": "Danh bạ" }
{ "componentType": "select", "label": "Ngân hàng thụ hưởng" }
{ "componentType": "chips", "chips": ["Vietcombank", "BIDV", "VIETINBANK"], "activeStep": 0 }
{ "componentType": "tabs", "tabs": ["Chuyển đến TK", "Chuyển đến Thẻ"], "activeTab": 0 }
{ "componentType": "list", "items": ["Nhóm Dự án", "Phòng Kỹ thuật", "Hỗ trợ"] }
{ "componentType": "table", "columns": ["Mã", "Khách", "Số tiền"], "rows": [[],[],[]] }
{ "componentType": "button", "label": "Tiếp tục", "grow": 1 }   // grow → primary/full-width
{ "componentType": "textarea", "label": "Nội dung", "hint": "24/200" }
```
Leaves stretch to full width inside a `stack` automatically (like real form
fields). In a `row`, use `grow` to fill or `w` for a fixed width.

## Secondary states are their OWN screens (dialog / drawer / sheet)

A wireframe shows ONE state. A nav drawer, a confirm dialog, an action sheet, a
record-voice overlay — these are separate STATES that sit on top of a base
screen. Model each as its own screen (see `schema.md` `overlay_kind` +
`overlay_of`) with its own `wire.json`, and mark that wire as an overlay:

```jsonc
{ "overlay": "dialog",          // "dialog" | "drawer" | "sheet"
  "overlayOf": "SCR-VOICE",     // base screen id (omit for a GLOBAL overlay)
  "layout": { /* JUST the overlay's own content: the dialog body / drawer menu /
                 sheet actions — NOT the whole page. The host draws the base
                 screen dimmed behind it. */ } }
```

Rules for overlays:
- The **base screen** shows the CLOSED trigger, not the open overlay: a mobile
  base uses `appbar` (☰), not an inline open `drawer`. Don't bake the open state
  into the base tree.
- The **global nav drawer** is authored ONCE (one screen, `overlay_of: null`),
  shared by every screen's ☰ — do NOT duplicate a nav drawer per screen.
- Author a screen-specific overlay only when it carries real UX: a destructive
  confirm (`dialog`), a long-press action menu (`sheet`), a filter panel
  (`sheet`/`drawer`), a transient mode (record voice → `sheet`/`dialog`).
- An overlay's `layout` is just the overlay content; `overlay`+`overlayOf` are
  siblings of `layout` (and `layouts`) in the wire.json.

## Archetypes — match the screen to a shape

**Mobile (layout `mobile`)** → ONE `stack`, top to bottom. This is the reliable
default; keep each control full-width, group related fields, label sections.
Put chip-style choices in a `row`.

**Web (layout `web`)** → author THREE trees (`layout` = desktop, `layouts.tablet`,
`layouts.mobile`). Each is a real redesign for its width:

- **Desktop** (`layout`, ~1280px): top `navbar`, then a `row` of a fixed-width
  sidebar (`w`) + a growing main (`grow`). Wide tables, multi-column forms,
  content side-by-side. Use `table` for tabular data, not a bullet list.
- **Tablet** (`layouts.tablet`, ~834px): DROP the sidebar into a slim rail or a
  `tabs` bar across the top; main becomes one column (or two `grow` columns at
  most). Keep tables but with fewer columns. Forms go 1–2 columns.
- **Mobile** (`layouts.mobile`, ~390px): ONE `stack`, and apply REAL mobile
  patterns — this is where the redesign matters most:
  - Desktop **sidebar / nav menu** → an `appbar` (hamburger + title) at the top,
    and move its menu items into a `drawer` (secondary/many destinations) OR a
    `bottomnav` pinned last (≤5 primary destinations). Do NOT keep a `navbar`
    with inline links — that's a desktop pattern.
  - Desktop **table** → a `list` of card rows (one line per record), never a
    squeezed multi-column grid.
  - Multi-column **forms** → single column, every field full-width.
  - The main create/compose action → a `fab`, or a full-width `button`
    (`"grow": 1`) pinned at the bottom.

The redesign is STRUCTURAL, not cosmetic: desktop `row` of sidebar+main →
mobile `appbar` + `stack` + `drawer`/`bottomnav`; desktop `table` → mobile
`list`. If the mobile tree still has a sidebar `row` or a `table`, it's wrong.

## Full mobile example (a transfer screen)

```jsonc
{ "layout": { "dir": "stack", "gap": "md", "children": [
  { "componentType": "navbar", "label": "Chuyển tiền ngoài VBSP", "navItems": ["Trang chủ"] },
  { "componentType": "tabs", "tabs": ["Chuyển đến TK", "Chuyển đến Thẻ"], "activeTab": 0 },
  { "card": true, "dir": "stack", "gap": "sm", "children": [
    { "componentType": "text", "label": "Từ tài khoản  ·  7062598067" },
    { "componentType": "text", "label": "Số dư khả dụng  ·  701,073,440 VND" }
  ] },
  { "label": "Thông tin giao dịch", "dir": "stack", "gap": "sm", "children": [
    { "componentType": "select", "label": "Ngân hàng thụ hưởng" },
    { "componentType": "chips", "chips": ["Vietcombank", "BIDV", "VIETINBANK"], "activeStep": 0 },
    { "componentType": "input", "label": "Số tài khoản nhận", "hint": "Danh bạ" },
    { "componentType": "input", "label": "Số tiền", "hint": "VND" }
  ] },
  { "dir": "row", "align": "between", "children": [
    { "componentType": "text", "label": "Phí chuyển tiền" },
    { "componentType": "text", "label": "5,500 VND" }
  ] },
  { "componentType": "select", "label": "Người trả phí" },
  { "componentType": "textarea", "label": "Nội dung", "hint": "24/200" },
  { "componentType": "button", "label": "Tiếp tục", "grow": 1 }
] } }
```

## Full web example (a transactions screen — 3 devices)

```jsonc
{
  "layout": {                               // DESKTOP: sidebar + main, wide table
    "dir": "stack", "gap": "md", "children": [
      { "componentType": "navbar", "label": "Quản lý giao dịch", "navItems": ["Tổng quan", "Giao dịch", "Báo cáo"] },
      { "dir": "row", "gap": "lg", "align": "start", "children": [
        { "dir": "stack", "w": 240, "gap": "sm", "children": [
          { "componentType": "list", "items": ["Tất cả", "Chờ duyệt", "Đã duyệt", "Từ chối"] }
        ] },
        { "dir": "stack", "grow": 1, "gap": "md", "children": [
          { "dir": "row", "gap": "sm", "children": [
            { "componentType": "search", "placeholder": "Tìm giao dịch", "grow": 1 },
            { "componentType": "select", "label": "Trạng thái", "w": 180 }
          ] },
          { "componentType": "table", "columns": ["Mã", "Khách hàng", "Số tiền", "Trạng thái"], "rows": [[],[],[],[]] }
        ] }
      ] }
    ]
  },
  "layouts": {
    "tablet": {                             // TABLET: nav as top tabs, no sidebar, slimmer table
      "dir": "stack", "gap": "md", "children": [
        { "componentType": "navbar", "label": "Quản lý giao dịch" },
        { "componentType": "tabs", "tabs": ["Tất cả", "Chờ duyệt", "Đã duyệt", "Từ chối"], "activeTab": 0 },
        { "componentType": "search", "placeholder": "Tìm giao dịch" },
        { "componentType": "table", "columns": ["Khách hàng", "Số tiền", "Trạng thái"], "rows": [[],[],[]] }
      ]
    },
    "mobile": {                             // MOBILE: appbar + list of cards + bottom nav
      "dir": "stack", "gap": "sm", "children": [
        { "componentType": "appbar", "label": "Giao dịch" },
        { "componentType": "tabs", "tabs": ["Tất cả", "Chờ duyệt"], "activeTab": 0 },
        { "componentType": "search", "placeholder": "Tìm giao dịch" },
        { "componentType": "list", "items": ["NGUYEN VAN A · 5,500,000 · Chờ duyệt", "TRAN THI B · 1,200,000 · Đã duyệt"] },
        { "componentType": "bottomnav", "items": ["Giao dịch", "Báo cáo", "Cá nhân"], "activeTab": 0 }
      ]
    }
  }
}
```

## Rules

- Compose a REAL screen: use `card` to group, `label` for sections, `row` for
  side-by-side items (chips, a label + value, sidebar + main). Don't dump a flat
  list of loose components.
- Keep it to the screen's actual `components[]` from the UX Spec, in a sensible
  order — but arrange them into the archetype above, don't just stack blindly.
- Reuse the SAME skeleton (navbar/tabs/sidebar) across screens of one product.
- The primary action button gets `"grow": 1` (renders solid/full-width).
- **Web screens: author `layouts.tablet` and `layouts.mobile`**, each a real
  redesign (sidebar→top-nav, table→list). A mobile APP screen has only `layout`.
