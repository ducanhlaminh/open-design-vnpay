---
name: ui-react
description: |
  Terminal UI-Spec option of the docs-to-ui workflow (the `ui-react` pipeline — React app output). Read the
  UX Spec (S_SCREEN_SPEC screens + components produced by the `ux-spec` pipeline)
  and author a REAL, buildable Vite + React 19 + Tailwind v4 app on the canonical
  shadcn/ui (radix) component set: first derive a reusable APP COMPONENT layer
  (`src/components/app/` — use-case composites wrapping the primitives), then one
  screen per route under `./react/src/screens/` composed from it, then build with
  the isolated toolkit backend (`builder/build.sh`: in-place inside the agent
  sandbox, or a network-less Docker container on host) until green.
  The deliverable is the built `./react/dist/` (a static app the file-viewer
  iframes) plus its `./react/src/` source. Activate when the user runs the "UI
  (React app)" pipeline or asks for a real React/shadcn application from the spec.
  Different from `react-shadcn` (emits `screen.json`, host-rendered, no build) and
  `html-interactive-prototype` (plain HTML, no framework, no build).
triggers:
  - "ui react"
  - "react app"
  - "react shadcn app"
  - "vite react"
  - "buildable react ui"
od:
  mode: prototype
  category: web-artifacts
  craft:
    requires:
      - anti-ai-slop
      - laws-of-ux
      - typography-hierarchy
      - color
      - animation-discipline
      - state-coverage
      - accessibility-baseline
---

# ui-react — UX Spec → real, buildable shadcn/ui React app

Final stage of the **docs → React** workflow. You turn the UX Spec screen
definitions into a **real Vite + React 19 + Tailwind v4** application that uses
the canonical **shadcn/ui (radix) component set**, then **build it with
`builder/build.sh`** (isolated toolkit — in-place in the agent sandbox, Docker
on host) and hand off the built app. The file-viewer previews the built
`./react/dist/` in an `<iframe>`.

- **Input (primary):** the UX Spec JSON from the `ux-spec` pipeline —
  `./*-ux-spec.json` (and anything under `./ux/`). Each `screens[]` entry has
  `id, name, screen_type, screen_intent, layout, primary_actor, permissions,
  navigation_group, components[]`; each component has `component_type, label,
  order, required, data_type, semantic_type, enum_values`.
- **Working directory:** everything is relative to your CWD. In the
  agent-in-sandbox runtime your CWD is the mounted project dir (`/work/app`) —
  it contains the same `.od-skills/`, spec files and `./react/` as a host run.
  Never write outside it.
- **Input (context, when present):** the customer journey
  (`./*-customer-journey.json` / `./*-cj.json` or `./customer-journey/`) — use it
  to decide the **navigation flow** between screens (which screen a button routes
  to). If no UX Spec exists, stop and tell the user to run **UX Spec** first.
- **Output:** a Vite React app under **`./react/`**. You author only `./react/src/`
  (the `components/app/` composite layer, screens, routes, theme tokens) +
  `./react/flow.json`. The build produces
  **`./react/dist/index.html`** (full app + HashRouter → resizable preview) AND
  **`./react/dist/screens/<slug>.html`** (one page per screen → the all-screens
  canvas). Do not write anything outside `./react/`.

## How this skill works (read first)

The scaffold is NOT something you write from scratch — it is **shipped with this
skill** and seeded for you:

- The **build toolchain + all dependencies** (React 19, Tailwind v4, the canonical
  shadcn/ui components, Vite, tsc) live in a shared Docker image — you never run
  `npm`/`pnpm install`.
- Running the build script **seeds** a ready project into `./react/` on first
  call: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `components.json`,
  the full **`src/components/ui/`** shadcn/ui set, `src/lib/utils.ts` (`cn`),
  `src/index.css` (default neutral theme), and a sample `src/App.tsx` + `src/screens/`.
- You then **replace the sample `src/App.tsx` + `src/screens/`** with the real
  screens from the spec, and **bind the design-system tokens** in `src/index.css`.
- The component architecture is **three layers**:
  1. `src/components/ui/` — the shipped shadcn primitives. **Read-only.** You
     never author or edit these.
  2. `src/components/app/` — **YOUR app component layer** (you author this):
     domain composites derived from the use cases that WRAP the primitives —
     reusable + centrally styled (see the dedicated step below).
  3. `src/screens/` — thin screens that compose mostly from
     `@/components/app/*`, dropping to raw primitives only for one-off cases.

### The build script

The build backend ships with this skill at **`builder/build.sh`** (skill root is
advertised in the preamble above — use the relative form, e.g.
`.od-skills/ui-react/builder/build.sh`). Run it from your working directory:

```bash
bash .od-skills/ui-react/builder/build.sh ./react
```

It seeds the scaffold (idempotent — never clobbers your edits), then runs
`tsc --noEmit && vite build` and writes `./react/dist/`. It prints
TypeScript / Vite errors to stderr and exits non-zero on failure. **This is
your feedback loop: build → read errors → fix `src/` → build again, until it
is green.** node_modules is the shared image toolkit (resolved from a parent
dir), so nothing heavy is written into `./react/`.

The script picks its backend automatically — same command either way:
- **Agent-in-sandbox runtime** (`UIREACT_IN_SANDBOX=1` is preset in your
  environment): you are already inside the toolkit container; the build runs
  in-place. Docker is NOT available here and you do not need it.
- **Host runtime**: the build runs inside a throwaway, network-less Docker
  container. Requires Docker/OrbStack (arm64) on the machine — if `build.sh`
  reports docker is missing, tell the user to install/start OrbStack and stop.

## Design system

If a **`## Active design system`** section is present later in this prompt, it is
the visual direction. Bind it by rewriting the token VALUES in
`./react/src/index.css` — the `:root { … }` and `.dark { … }` blocks are the ONLY
thing you change for theming (the `@theme inline` mapping and the component set
stay intact):

- Map the DESIGN.md palette to `--primary / --secondary / --accent / --muted /
  --destructive / --background / --foreground / --card / --border / --ring`
  (+ their `-foreground` pairs), using `oklch()` values.
- Apply the DESIGN.md `--radius`, and its type choices via the `body` font stack.

If no active design system is present, keep the **default shadcn neutral theme**
already in `src/index.css` (do not invent a brand palette).

## Design quality & creativity — be bold

The **`frontend-design`**, **`web-design-guidelines`** and **`taste-skill`** skills
are also active this run, and this skill opts into the craft rules (**anti-ai-slop,
laws-of-ux, typography-hierarchy, color, animation-discipline, state-coverage,
accessibility-baseline**). Treat all of that as design guidance layered on this
skill — the only files you write are still under `./react/src/`. Have a real point
of view, commit to one design language across every screen, and push hierarchy,
depth and disciplined motion. Aim for something a senior product designer would
demo, not a wireframe.

## Workflow (do these in order)

### 1. Seed + read the spec
Run `bash .od-skills/ui-react/builder/build.sh ./react` once to seed the scaffold
and confirm the baseline builds green. Then read the UX Spec JSON, build the
ordered screen list (respect `components[].order`). If a customer journey is
present, derive the click-flow (e.g. `login → home → detail`) from its
USER_FLOW / STAGE order so routes link sensibly.

### 1b. The wireframe IS the layout contract — do NOT re-derive it
The `ux` stage emits `./wireframes/<SCREEN-ID>.wire.json` for every screen: a
flexbox layout tree whose leaves carry a **slug from a closed registry named
after this very component set** (`shadcn:Input`, `shadcn:Table`, `mobile:AppBar`,
…). That is a handoff, not a sketch — read it for each screen and honor it:

- **Structure**: the container tree (`stack`/`row`, `card`, section `label`,
  `grow`/`w`) is the intended composition — section order, what is grouped in a
  card, what sits side by side, where the primary action lands. Keep it. If you
  deviate, it must be a deliberate craft improvement, not because you skipped
  reading the file.
- **Components**: each leaf's `c` maps 1:1 to a primitive under
  `@/components/ui/`. `shadcn:Select` → `Select`, `shadcn:Item` → `Item` rows,
  `shadcn:InputOTP` → `InputOTP`, `shadcn:ToggleGroup` → `ToggleGroup`, and so
  on. The mapping table (including the `mobile:*` slugs, which have no shadcn
  primitive and tell you what to compose instead) is
  `skills/ux-spec/references/wire-components.md`.
- **Props carry intent**: `block: true` = full-width primary action;
  `active: <n>` = the selected tab/step; `navigatesTo` = the target screen id,
  which must match the `data-flow-action` / route you wire in step 4.
- **`layouts.tablet` / `layouts.mobile`** on a web screen are the responsive
  redesigns — see the breakpoint rules below.

Your job is the layer the wireframe cannot express: the app composite layer,
real content, states, motion, and craft. Not re-inventing the bones.

### 2. Design the app component layer (`src/components/app/`)
**Before writing any screen**, derive a small library of DOMAIN composites from
the use cases — this is what lifts the output from "wireframe assembled from
primitives" to "one coherent product":

- **Mine the spec + journey for repetition**: scan every screen's
  `components[]` (by `component_type` + `semantic_type`) and the journey's
  use-case steps for patterns that recur — form field rows, amount/money
  display, account/list rows with status, confirmation dialogs, OTP entry,
  result/success states, the screen shell itself (header + back + title).
- **One composite per recurring pattern**, in `./react/src/components/app/`
  (PascalCase file per component + an `index.ts` barrel). Target **6–12**
  composites; typical shapes:
  `ScreenShell` (header/back/title/safe-area), `SectionCard`, `FieldRow`,
  `AmountInput` / `MoneyText` (vi-VN formatting), `AccountRow` / `AccountPicker`,
  `StatusBadge`, `ConfirmDialog`, `OtpDialog`, `ResultState`, `EmptyState`.
- **Composites WRAP the primitives** (`@/components/ui/*`) — never re-implement
  them, never fork their files. Centralize the styling decisions here: spacing
  scale, radius, tone mapping (`status → badge variant`), typography — use
  **`cva`** (class-variance-authority, shipped in the toolkit) for variants so
  screens pass semantic props (`tone="destructive"`), not class soup.
- **Typed, minimal props** oriented to the DOMAIN (`account`, `amount`,
  `onConfirm`) — not pass-through styling props. A composite earns its place by
  being used on **≥2 screens** (or being a journey-critical pattern like OTP);
  one-off layouts stay inline in the screen.
- Header-comment each composite file with one line: which screens use it and
  which spec pattern it encodes.

### 3. Author one screen component per spec screen
Create `./react/src/screens/<slug>.tsx` per screen (`<slug>` = screen `id`
lower-cased, or a kebab of `name`). **`export default`** the screen component — the
build emits a standalone page per screen for the canvas. **Compose from
`@/components/app/*` first**; drop to raw `@/components/ui/<name>` only for
one-off cases the app layer deliberately does not cover. Screens stay THIN —
if you catch yourself repeating the same primitive cluster in a second screen,
promote it to `src/components/app/` instead of copy-pasting:

| `component_type` | build with |
|---|---|
| `input` / `search` | app `FieldRow` (wraps `Input` + `Label`) — mark `required` |
| `select` | app picker composite or `Select` (use `enum_values` for options) |
| `text` | heading / `<p>` (pick by `semantic_type`); money → app `MoneyText` |
| `button` | `Button` (primary action → `variant="default"`) |
| `list` | app row composite (`AccountRow`, …) — 3–5 realistic placeholder rows |
| `tabs` / segmented | `Tabs` |
| `checkbox` / `switch` / `radio` | `Checkbox` / `Switch` / `RadioGroup` |
| `dialog` / modal | app `ConfirmDialog`/`OtpDialog` (wrap `Dialog` / `Sheet` / `Drawer`) |
| anything else | closest sensible composite/primitive; never skip a component |

- **Icons:** import from `lucide-react` (e.g. `import { ArrowRight } from 'lucide-react'`).
  **NEVER use an emoji or Unicode glyph as an icon.**
- **`cn`** from `@/lib/utils` for conditional classes; style with Tailwind utility
  classes that resolve to the theme tokens (`bg-primary`, `text-muted-foreground`,
  `border-border`, `rounded-lg`, …).
- Use **realistic Vietnamese placeholder content** consistent with the screen
  intent (not lorem ipsum).
- Full-bleed layout: `web` → constrain content to a centered max-width; `mobile`
  → full-width (the canvas frames it). No fake phone bezel.
- **Web screens MUST be responsive** — the preview shows every `layout: "web"`
  screen at three viewports (Desktop 1280 / Tablet 834 / Mobile 390), so a
  desktop-only layout reads as broken at the smaller two. Build with Tailwind
  breakpoints, **mobile-first** (base classes = mobile, layer `md:`/`lg:` up):
  - Desktop **sidebar / inline nav** → hidden below `lg:` in favor of a top bar
    with a hamburger opening a `Sheet side="left"` (drawer). Never let a fixed
    sidebar squeeze the content column on small widths.
  - **Tables** → `hidden md:table` (or `lg:`) + a stacked card list
    (`md:hidden`) for the same rows on mobile — no horizontally-scrolling table
    as the only mobile affordance.
  - **Multi-column forms/grids** → single column at base (`grid-cols-1
    md:grid-cols-2 …`); touch-sized controls at base.
  - When the UX Spec's wireframe carries per-device redesigns
    (`wireframes/<id>.wire.json` → `layouts.tablet` / `layouts.mobile`), those
    ARE the tablet/mobile designs — implement them via the breakpoints above,
    don't invent a different small-screen layout.
  - `mobile` (app) screens are single-width; no breakpoints needed.
- **Tag each screen's platform on its root element** — put `data-od-layout="web"`
  (or `"mobile"`, copied from the UX Spec `layout`) on the outermost element the
  screen returns:
  ```tsx
  export default function AdminDashboard() {
    return <div data-od-layout="web" className="min-h-screen">…</div>;
  }
  ```
  The preview + Copy-to-Figma read this at runtime to size the frame (a web
  screen auto-widens to desktop instead of being squished into a phone frame).
  It is the SAME per-screen platform you also list in `layout.json` below — both
  must agree.

### 4. Wire routes in `src/App.tsx` + emit `flow.json`
Screens **default-export**, so import them as defaults and add a `<Route>` per screen
inside the shipped **`HashRouter`** (required — the built app is previewed as static
files with no server routing). Use `useNavigate()` / `<Link>` for the cross-screen
flow derived from the customer journey; the first screen is `path="/"`.

Then write **`./react/flow.json`** — the user-action flow from the journey. The
all-screens canvas draws the navigation arrows, and the use-case simulator
steps through EVERY edge (navigation AND in-screen dialogs).
**Carry the UX rule flowcharts down:** when the upstream ux run authored
`../flows/<FLOW-ID>.flow.json`, reuse its edge labels VERBATIM — the action
label leaving a screen there is the `label` (→ `data-flow-action`) here, and a
decision's Yes/No branches become the corresponding conditional edges' labels
(e.g. `"xác nhận — OTP hợp lệ"` / `"xác nhận — OTP sai"`), so the canvas shows
the same conditions the UX flowchart declared:
```json
[
  { "from": "login", "to": "home",  "label": "đăng nhập" },
  { "from": "home",  "to": "detail", "label": "xem chi tiết" },
  { "from": "detail", "to": "detail", "label": "xóa tài khoản", "type": "dialog" },
  { "from": "detail", "to": "detail", "label": "xác nhận xóa",  "type": "dismiss" }
]
```
`from`/`to` are screen slugs (the `src/screens/<slug>.tsx` names). `type`:
- omitted / `"navigate"` — a route change to another screen (`from` ≠ `to`).
- `"dialog"` — the action opens a Dialog / Sheet / Drawer / AlertDialog **inside
  the same screen**: `to` MUST equal `from`. The simulator really clicks the
  trigger so the dialog opens live.
- `"dismiss"` — the action inside that open dialog that closes/confirms it
  (`to` = `from` to stay, or another slug when confirming also navigates).

Include dialog/alert interactions that matter to the journey as `dialog` +
`dismiss` edge pairs — they are use-case steps, not decoration. Omit the file
only if there is no meaningful flow at all.

**Overlay screens from the UX Spec.** A UX Spec screen with `overlay_kind`
(`dialog` / `drawer` / `sheet`) + `overlay_of` is NOT a separate route — it is a
secondary state of its base screen. Render it INSIDE the `overlay_of` screen as
the matching primitive and wire it as a flow pair, not a `<Route>`:

| `overlay_kind` | build inside the base screen with | flow edges (base slug = S) |
|---|---|---|
| `dialog` | `Dialog` / `AlertDialog` (app `ConfirmDialog`) | `{from:S,to:S,type:"dialog","overlay":"dialog"}` open + `{from:S,to:S,type:"dismiss"}` close |
| `sheet` | `Sheet` (bottom) — action menus, filters | same pair, `"overlay":"sheet"` on the open edge |
| `drawer` | `Sheet side="left"` / `Drawer` — nav menu | same pair, `"overlay":"drawer"` on the open edge |

A GLOBAL overlay (`overlay_of` null, e.g. the app nav drawer) is rendered once in
the shared shell/`ScreenShell`, opened by the header hamburger on every screen —
not duplicated per screen. Bind each edge's `label` to the real trigger /
close control via `data-flow-action` exactly as for any other flow edge.

**`overlay` field + `#od-open` contract (REQUIRED for every overlay).** The
preview canvas shows web screens at Desktop/Tablet/Mobile viewports; at
tablet/mobile it adds an EXTRA frame per overlay — the base screen with that
overlay already open (a phone deliverable needs the "drawer open" artboard,
desktop shows nav inline). Two things make that work:

1. Every `type: "dialog"` edge that opens an overlay carries
   `"overlay": "drawer" | "sheet" | "dialog"` (see table above).
2. Every overlay's open state MUST honor the URL hash `#od-open=<label>`
   (label = the open edge's exact `label`). Implement ONE tiny helper in the
   app layer and use it as each overlay's initial open state:

   ```tsx
   // src/components/app/useOdOpen.ts — preview contract: a screen loaded with
   // #od-open=<flow-action-label> mounts with that overlay already open.
   export function useOdOpen(label: string): boolean {
     if (typeof window === 'undefined') return false;
     return decodeURIComponent(window.location.hash).includes(`od-open=${label}`);
   }
   // in a screen:
   const [menuOpen, setMenuOpen] = useState(useOdOpen('mở menu'));
   ```

   Per-screen pages wrap a catch-all HashRouter, so the extra hash never
   breaks routing.

Also write **`./react/layout.json`** — each screen's target platform, copied
VERBATIM from the UX Spec's per-screen `layout` field:
```json
{ "login": "mobile", "admin-dashboard": "web" }
```
Keys are the SAME screen slugs as flow.json (`src/screens/<slug>.tsx`); values
are `"mobile"` | `"web"`. The preview canvases size each frame from this file
(phone width vs desktop width) — a missing file or slug falls back to the
phone frame, so emit it whenever the spec has any `layout: "web"` screen.

**Bind every flow edge to its real UI control.** On the `from` screen, the
element that triggers that navigation (the `Button`, link, card row, …) MUST
carry a `data-flow-action` attribute whose value is the edge's exact `label`:

```tsx
<Button data-flow-action="đăng nhập" onClick={() => navigate('/home')}>
  Đăng nhập
</Button>
```

This is a 1:1 contract with `flow.json`: every edge label appears as exactly one
`data-flow-action` on its `from` screen, and every `data-flow-action` value
appears in `flow.json`. For `type: "dialog"` edges the attribute goes on the
dialog TRIGGER; for `type: "dismiss"` it goes on the close/confirm control
INSIDE the dialog content. The use-case simulator drives the walkthrough by
spotlighting and clicking these controls — an edge without its annotated
element degrades to fuzzy text matching and may not be clickable in the
simulator. Do NOT invent a flow edge for an action the screen does not render;
fix the screen or drop the edge.

### 4b. Reason a per-screen DEMO scenario → emit `./react/demo.json`
The prototype auto-demo (Playwright) records ONE video per screen showing a
user actually using it — this is where you REASON the interaction, because not
every meaningful interaction is a flow.json edge (selecting a card, toggling a
switch, expanding a section, scrolling a long list). You just built every
screen, so you know its real interactions. Write **`./react/demo.json`** — one
entry per screen slug, a short realistic in-screen scenario (do NOT navigate to
other screens — cross-screen flow is the flowchart's job):

```json
{
  "card-design": {
    "title": "Thiết kế thẻ",
    "steps": [
      { "do": "scroll", "note": "Cuộn xem toàn bộ danh sách thiết kế" },
      { "do": "tap",  "target": "Sản phẩm thẻ",          "note": "Mở bảng chọn sản phẩm thẻ" },
      { "do": "tap",  "target": "Vietcombank Visa Debit", "note": "Chọn một sản phẩm thẻ" },
      { "do": "tap",  "target": "Lưu thay đổi",           "note": "Lưu → hiện dialog xác nhận" }
    ]
  },
  "card-services": {
    "steps": [
      { "do": "scroll", "note": "Cuộn xem các dịch vụ thẻ" },
      { "do": "tap", "target": "Thiết kế thẻ", "note": "Nhấn vào dịch vụ Thiết kế thẻ" }
    ]
  }
}
```

Rules:
- `do`: `scroll` | `tap` | `hold`. Start most screens with a `scroll` so the
  video shows the fixed header + scroll behaviour a wireframe can't.
- `target` (tap/hold): the element's **visible text** OR its `data-flow-action`.
  Prefer the exact visible label of the button/row/tab — the runner resolves by
  data-flow-action, then aria-label, then visible text, so a real on-screen
  label always works even without a data-flow-action.
- `note`: a short Vietnamese caption shown on the touch overlay ("đang làm gì").
- Keep each screen's scenario SHORT (2–5 steps) and self-contained; only demo
  interactions the screen actually renders. Every built screen SHOULD have an
  entry (a screen with nothing to do → just a `scroll` step).

### 5. Bind design-system tokens
Edit `./react/src/index.css` `:root` / `.dark` per the **Design system** section.
Composite-level styling (spacing, radius, tone variants) lives in
`src/components/app/` — tokens in `index.css`, usage in composites, screens
inherit both.

### 6. Build until green
Run `bash .od-skills/ui-react/builder/build.sh ./react`. Read any `tsc` / `vite`
errors, fix `src/`, and repeat until it exits 0 and writes `./react/dist/`.

## Hard rules
- **Author only `./react/src/`** (screens, `src/components/app/`, `App.tsx`,
  `main.tsx`, `index.css`) **+ `./react/flow.json` + `./react/layout.json` +
  `./react/demo.json`**. Do NOT edit
  `package.json` / `vite.config.ts` (keep `base: './'`) / `tsconfig.json` / the
  `components/ui/` set / the generated `screens/` entries / anything else
  outside `./react/`.
- **Layering is strict:** screens → `components/app` → `components/ui`. A
  screen never re-implements a pattern the app layer covers; an app composite
  never forks or edits a `ui/` primitive.
- **Dependencies:** import ONLY from the allowed superset — see
  `references/allowed-deps.md`. Do NOT run `npm`/`pnpm install`; do NOT add a dep
  the toolkit image doesn't ship.
- **Assets** (images, fonts): reference by URL/path — never inline large blobs.
- **Deliverable is the built app:** finish only when `build.sh` is GREEN and
  `./react/dist/` exists. A red build is not done.
- Do not invent screens that aren't in the spec; do render every screen that is.

## Done when
- `build.sh` is green → `./react/dist/index.html` **and** `./react/dist/screens/<slug>.html`
  (one per screen) exist, AND
- there is one `src/screens/<slug>.tsx` (default-export) + `<Route>` per UX Spec
  screen, cross-screen navigation is wired, and `./react/flow.json` + `./react/layout.json` reflect it, AND
- every `flow.json` edge has its `data-flow-action="<label>"` element on the
  `from` screen (the simulator contract above), AND
- `src/components/app/` holds the derived composite layer (with `index.ts`
  barrel) and screens compose from it — recurring patterns (fields, money,
  rows, dialogs, results, screen shell) appear exactly ONCE in the codebase.

Report the number of screens built + the app-layer component list, and stop.
