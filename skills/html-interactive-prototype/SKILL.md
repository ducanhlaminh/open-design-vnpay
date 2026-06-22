---
name: html-interactive-prototype
description: |
  Terminal step of the docs → HTML prototype workflow (the `ui-html` pipeline).
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
- **Input (context, when present):** `./features/` and `./*-customer-journey.json`
  — use the customer journey to decide the **navigation flow** between screens
  (which screen a button goes to). If no UX Spec exists, stop and tell the user
  to run **UX Spec** first.
- **Output:** one file per screen `./prototype/<slug>.html` (self-contained) plus
  `./prototype/index.html` (a hub linking every screen). `<slug>` = the screen
  `id` lower-cased (or a kebab of `name`). NOTHING else — no `screen.json`, no
  React, no shared external CSS/JS file.

> This pipeline does NOT emit `screen.json`. If you find yourself writing JSON,
> you are in the wrong mode — the deliverable here is real `.html`.

## Design quality & creativity — be bold
The **`frontend-design`** skill is also active in this run, and this skill opts
into the craft rules (**anti-ai-slop, laws-of-ux, typography-hierarchy, color,
animation-discipline**). Treat all of that as **design guidance layered on this
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
- A phone frame for `mobile` screens and a centered wide shell for `web`.

Pick your own class names, but keep them STABLE across screens and matching the
JS hooks in step 3 (e.g. a selected tab, a hidden tab panel, an open modal).

Structure per `layout`:
- `mobile` → wrap content in `.device` (phone frame) with an `.appbar` header.
- `web` → use `.web-shell`.

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
