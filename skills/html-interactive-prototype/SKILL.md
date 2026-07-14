---
name: html-interactive-prototype
description: |
  Terminal UI-Spec option of the docs-to-ui workflow (the `ui-html` pipeline — HTML prototype output).
  Read the UX Spec (S_SCREEN_SPEC screens + components produced by the `ux-spec`
  pipeline) and render EACH screen as a self-contained, CLICKABLE prototype:
  plain HTML + hand-written CSS + a little vanilla JS for real interactivity
  (tabs, modals, navigating between screens). One file per screen under
  `./prototype/<slug>.html`, plus a `./prototype/index.html` hub. No framework,
  no build, no external requests. Activate when the user runs the "UI (HTML
  prototype)" pipeline or asks for an interactive HTML/CSS clickable prototype.
  Different from `html-prototype` (flexbox-only, static, Figma-export focus) and
  `react-shadcn` (emits `screen.json`, not HTML).
triggers:
  - "html interactive prototype"
  - "clickable prototype"
  - "interactive html prototype"
  - "ui-html"
  - "prototype html css js"
od:
  mode: utility
  category: prototype
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

# html-interactive-prototype — UX Spec → clickable HTML/CSS prototype

Final stage of the **docs → HTML prototype** workflow. You turn the UX Spec
screen definitions into a set of **self-contained, clickable** HTML pages a
reviewer can actually click through — and that the Pipelines "prototype canvas"
embeds one-per-frame via `<iframe srcdoc>`.

- **Input (primary):** the UX Spec JSON from the `ux-spec` pipeline —
  `./*-ux-spec.json` (and anything under `./ux/`). It contains `screens[]`, each
  with `id, name, screen_type, screen_intent, layout, primary_actor,
  permissions, navigation_group, components[]`; each component has
  `component_type, label, order, required, data_type, semantic_type`.
  - **Overlay screens** (`overlay_kind` = `dialog`/`drawer`/`sheet` +
    `overlay_of`) do NOT get their own `<slug>.html` page — render them as an
    in-page **modal / slide-in drawer / bottom sheet** (backdrop + panel, JS
    toggled) ON the `overlay_of` screen's page, opened by that screen's trigger.
    A GLOBAL overlay (`overlay_of` null, e.g. the nav drawer) is the same
    drawer/menu on every page, opened by the header hamburger.
- **Input (context, when present):** the customer journey
  (`./*-customer-journey.json` / `./*-cj.json` or `./customer-journey/`) — use it
  to decide the **navigation flow** between screens (which screen a button goes
  to). If no UX Spec exists, stop and tell the user to run **UX Spec** first.
- **Output:** one file per screen `./prototype/<slug>.html` (self-contained) plus
  `./prototype/index.html` (a hub linking every screen). `<slug>` = the screen
  `id` lower-cased (or a kebab of `name`). The ONLY other allowed file is a
  per-screen `./prototype/<slug>.states.json` for multistep screens (see 3.5) —
  no `screen.json`, no React, no shared external CSS/JS file.

> This pipeline does NOT emit `screen.json` (the only JSON it may write is a
> `<slug>.states.json` capture recipe — see 3.5). The deliverable is real `.html`.

## Design quality & creativity — be bold
The **`frontend-design`**, **`web-design-guidelines`** (Vercel product-UI
standards: layout, type, color, motion, a11y) and **`taste-skill`** (good taste:
deliberate design variance, motion intensity, visual density — anti generic slop)
skills are also active in this run,
and this skill opts into the craft rules (**anti-ai-slop, laws-of-ux,
typography-hierarchy, color, animation-discipline, state-coverage,
accessibility-baseline**). Treat all of that as **design guidance layered on this
skill — not separate deliverables**: the only files you write are still
`./prototype/*.html`. Apply them to make the prototype genuinely *designed*:

- **Have a point of view.** Don't ship the default LLM look. Pick a deliberate
  visual direction (type pairing, a real color system with proper contrast,
  spacing rhythm, a signature element) and commit to it across all screens.
- **You own the CSS — use that freedom.** Push layout, hierarchy, depth,
  micro-interactions and motion (within `animation-discipline`). Aim for
  something a senior product designer would be proud to demo, not a wireframe.
- **Obey the craft rules** (they're partly lint-enforced): no AI-slop patterns,
  respect UX laws, real typographic hierarchy, accessible color, disciplined
  motion. Creativity within these constraints — not despite them.

Keep the SAME design language across every screen so the set feels like one
product.

## Workflow (do these in order)

### 1. Read the spec
Read the UX Spec JSON. Build the screen list (respect `components[].order`). If a
customer journey is present, derive the click-flow (e.g. `login → home → detail`)
from its USER_FLOW / STAGE order so the prototype's buttons link sensibly.

### 2. Author your own CSS once, then reuse it
There is **no pre-made stylesheet** — you write the CSS yourself when you run.
On the FIRST screen, author one clean, modern stylesheet and keep it in a
`<style>` tag; **reuse the exact same block, inlined, in every screen file** so
all screens look consistent and each file stays self-contained (zero external
requests). Add only small screen-specific tweaks after the shared block.

Make the CSS genuinely good, not skeletal — include:
- **Design tokens** in `:root` (CSS custom properties): bg / surface / border /
  text + muted/faint / a primary + soft tint / danger·success·warn / radius
  scale / shadows / spacing / system font stack. Neutral by default (you may
  derive a palette from the brand/feature context if obvious).
- A reset (`box-sizing`, margins), readable type scale, and components for:
  app bar/header, content body, **cards**, **list rows** (hover state),
  **form fields** (label + input/select + focus ring + required mark),
  **buttons** (primary / secondary / block / ghost, active press), **tabs**
  (selected state), **modal/dialog** (backdrop + panel), a bottom action bar,
  badges, and an empty state.
- A **full-bleed** screen shell (NO fake phone bezel): a root that fills 100%
  width and its natural height, a sticky top app bar, and a scrollable content
  area. Do NOT emit a fixed-size `.device`/phone-frame wrapper.

Pick your own class names, but keep them STABLE across screens and matching the
JS hooks in step 3 (e.g. a selected tab, a hidden tab panel, an open modal).

Structure per `layout` — **full-bleed, no phone bezel**:
- Root element (e.g. `.screen`) fills **100% width and its natural height** — no
  fixed `375×812` `.device` shell, no rounded phone frame, no drop-shadow bezel.
- A **sticky** `.appbar` header pinned to the top, then a scrollable `.content`.
- `mobile` → content flows full-width (the canvas renders it inside a ~375px
  iframe, so it naturally reads as a mobile screen without a fake device).
- `web` → same full-bleed root, but constrain `.content` to a readable
  **centered max-width** (e.g. `min(100%, 960px)`). Still no `.device`.
  Prefer web patterns: a data **table** where the spec's list is tabular,
  sidebar/top navigation instead of bottom tabs, multi-column forms.
- **Declare the layout in every file's `<head>`**:
  `<meta name="od-layout" content="mobile">` or `content="web"` (copy the
  screen's `layout` from the UX Spec). The preview canvas reads this marker to
  size each frame (phone vs desktop) — a missing marker falls back to mobile.

> The root must NOT have a fixed height or a hard-coded phone size — a fixed
> shell with a `flex:1` child collapses when handed off (e.g. Copy-to-Figma).
> Full-bleed + sticky app bar renders cleanly everywhere.

Header shows `name` (`.appbar__title`) and `screen_intent` (`.appbar__sub`).
Render `components[]` in `order` using this mapping:

| `component_type` | HTML / class |
|---|---|
| `input` / `search` | `.field` > `<label>` + `.input` (placeholder = label; mark `required` with `<span class=req>*</span>`) |
| `select` | `.field` > `<label>` + `<select class=select>` (use `enum_values` for options if present) |
| `text` | a heading or `<p>` (use `semantic_type` to pick) |
| `button` | `.btn` (primary action → `.btn--primary .btn--block`) |
| `list` | `.list` of `.list-item` (3–5 realistic placeholder rows) |
| `tabs` / segmented | `.tabs` + `.tabpanel`s (see Interactivity) |
| anything else | closest sensible element; never skip a component |

Use **realistic Vietnamese placeholder content** consistent with the screen
intent (not lorem ipsum). A `confirmation`/`form` screen ends with an
`.actionbar` holding its primary button.

### 2.5 Icons — use the bundled Lucide set, inline as SVG
A static **Lucide** icon set ships with this skill at **`assets/icons/<name>.svg`**
(see `assets/icons/README.md` for the full name list + ISC license). Icons are the
ONLY correct way to render glyphs here.

- **NEVER use a Unicode character or emoji as an icon** (`←`, `⌂`, `⚠️`, `✓`, `→`,
  `⚙`, `🏠`, `🔒`). They render inconsistently, drop out on handoff (e.g. Copy-to-Figma),
  and read as AI-slop. Use a real SVG instead: `arrow-left`, `house`, `triangle-alert`,
  `check`, `arrow-right`, `settings`, `lock`.
- **Inline the SVG** — read `assets/icons/<name>.svg` and paste its `<svg>…</svg>` into
  the markup. Do NOT `<link>`/`<img src>` it (the deliverable is self-contained, no CDN).
- Lucide icons are `stroke="currentColor"`, so an icon **inherits the surrounding text
  `color`** — set color on the parent, not the SVG. Keep ONE `stroke-width` across the
  whole set (Lucide default `2`; `1.5`–`1.75` reads finer/more premium).
- Missing a glyph? Reuse the closest one from `assets/icons/` (banking-relevant ones are
  included: `snowflake` freeze, `wallet`, `credit-card`, `banknote`, `landmark`, `receipt`,
  `shield-check`, `scan-face`, `qr-code`, `lock`). Never hand-draw a new icon path.

**Size the icon to its position (set `width`/`height` on the `<svg>`, match the optical
size of the text/area it sits in):**

| Where | Icon size | Note |
|---|---|---|
| App-bar / nav action, section header | **24px** | Inside a ≥44px tap target for touch |
| Inline with text — button label, list-row, field affix, badge | **16–20px** | ≈ the line's font-size; `vertical-align: middle`, small gap to the text |
| Standalone tap target (icon-only button) | **20–24px** glyph | In a 40–44px hit area |
| Empty-state / feature / hero glyph | **32–48px** | Decorative focal point only |
| Dense table / caption / helper | **14–16px** | Do not go below 14px — illegible |

Rule of thumb: the icon's optical height ≈ the cap-height/line-height of the text next to
it. An icon must never dwarf its label or look lost beside it. One size per role, used
consistently across all screens.

### 3. Make it actually clickable (vanilla JS, inline)
Add a small inline `<script>` per file — no libraries:
- **Tabs:** clicking a `.tab` sets `aria-selected` and toggles the matching
  `.tabpanel[hidden]`.
- **Modals:** a trigger opens `.modal-backdrop.open`; backdrop click / a close
  button removes `open`. Use for confirms, filters, detail popovers.
- **Navigate between screens:** primary buttons / list items that lead somewhere
  link to the sibling file: `onclick="location.href='<target-slug>.html'"`
  (relative, same `./prototype/` folder). Pick the target from the journey flow
  (step 1); the back arrow goes to the previous screen or `index.html`.

### 3.5 Multistep / show-hide screens — state hooks + states recipe + looping demo

Some screens reveal content in steps or toggle visibility (wizard steps, an OTP
sheet, progressive disclosure). For EACH such screen, do all three:

**a) Stable state hooks** — make every distinct visual state reachable + labelable
via stable attributes, not ad-hoc class toggles:
- the state container carries `data-state="<id>"` (e.g. `step-1`, `step-2`,
  `otp-open`); your JS sets `data-state` to switch;
- the control that advances carries `data-action="next"` (and `data-action="back"`
  / `data-open="<id>"` for a modal). The SAME hooks drive both the JS and the
  capture recipe below — keep them stable.

**b) Emit a states recipe** `./prototype/<slug>.states.json` listing every state in
display order, so Copy-to-Figma captures EACH state as its own Figma frame
(`scripts/copy-figma-h2d.mjs` reads it automatically beside the `.html`):
```json
[
  { "label": "Bước 1 — Nhập tiền", "actions": [] },
  { "label": "Bước 2 — Xác nhận",  "actions": [{ "click": "[data-action='next']" }] },
  { "label": "OTP",                "actions": [{ "click": "[data-open='otp']" }] }
]
```
- `actions` apply IN ORDER, CUMULATIVELY, on one render. First state = the initial
  load (empty `actions`). Vocabulary: `{"click":"<css>"}`, `{"wait":<ms>}`,
  `{"set":{"selector":"<css>","attr":"data-state","value":"<id>"}}` (use single
  quotes inside CSS attr selectors so the JSON stays valid).
- Only emit a recipe for a screen that genuinely has >1 state.

**c) Looping auto-advance, freezable for capture.** The auto-advance demo must
LOOP (after the last state, wrap back to the first so the viewer can re-watch
step 1) AND pause during capture — gate it on the capture flag:
```js
if (!window.__H2D_CAPTURE) {
  // cycle data-state through the states every ~1.2s, wrapping back to the first
}
```
NEVER auto-advance while `window.__H2D_CAPTURE` is set — the capture tool relies
on a stable, recipe-driven state.

### 4. Write `./prototype/index.html`
A simple hub: the project name + a responsive grid of cards, one per screen
(name + intent), each linking to its `<slug>.html`. This is the entry point and
the canvas's overview.

## Hard rules
- **Self-contained:** every `.html` works opened directly (file://) — your own
  CSS inlined in a `<style>` tag (the same shared block reused across screens),
  JS inline, no CDN, no `<link>`/`<script src>`, and NO pre-made stylesheet file
  shipped with the skill — you write the CSS each run.
- **One file per screen** under `./prototype/`, named from the screen id; keep a
  comment `<!-- screen: <id> -->` at the top for traceability back to the spec.
- **Clickable, not static:** at least the cross-screen navigation must work;
  add tabs/modals where the screen type calls for them.
- **Plain stack only:** HTML + CSS + vanilla JS. No React, no Tailwind, no build
  step, no `screen.json`.
- Do not invent screens that aren't in the spec; do render every screen that is.

## Done when
- `./prototype/index.html` exists and links to one `./prototype/<slug>.html` per
  UX Spec screen, AND
- each screen file is self-contained and its primary navigation works when
  clicked.

Report the number of screens rendered and stop.
