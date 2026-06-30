---
name: taste-skill
description: |
  High-agency frontend skill that gives AI good taste with tunable design variance, motion intensity, and visual density to stop generic UI slop.
triggers:
  - "design taste"
  - "visual taste"
  - "good taste"
  - "anti slop"
  - "visual density"
od:
  mode: design-system
  category: design-systems
  upstream: "https://github.com/Leonxlnx/taste-skill"
---

# taste-skill - anti-slop taste for product UI

> Adapted from [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) (the
> `skills/taste-skill` SKILL.md). The upstream targets React/Tailwind/Motion landing
> pages; this vendored copy keeps the **stack-agnostic taste rules** and adapts them
> for **self-contained HTML + hand-written CSS + vanilla JS product/app screens** (the
> `html-interactive-prototype` deliverable). Rules that assume npm packages, a React
> stack, or marketing-hero composition are dropped; the design judgment is kept.

Every rule is **contextual** - read the screen's intent first, then apply what fits.
The deliverable is still only `./prototype/*.html`; this is taste guidance, not a new
output.

## 1. The three dials

Set three dials and let every layout / motion / density decision follow them:

* **`DESIGN_VARIANCE`** - 1 = perfect symmetry, 10 = artsy chaos
* **`MOTION_INTENSITY`** - 1 = static, 10 = cinematic
* **`VISUAL_DENSITY`** - 1 = airy, 10 = packed data

**Default for these prototypes (regulated / banking / trust-first product UI): `3 / 2 / 5`.**
Low variance and low motion read as trustworthy and legible; medium density suits
forms and account data. Raise variance/motion only if the brief is explicitly playful
or marketing-facing. Keep the SAME dial values across every screen so the set feels
like one product.

## 2. Icons & emoji (adapted - self-contained, no CDN)

The prototype is self-contained (no icon library, no CDN). So:

* **Icons = inline `<svg>`** drawn in a **single consistent stroke style** (one
  `stroke-width`, e.g. `1.75`, one cap/join, one grid size e.g. 24×24). Reuse the same
  inline-SVG set across every screen.
* **NEVER use a Unicode glyph or emoji as an icon** (`←`, `⌂`, `⚠️`, `✓`, `→`, `⚙`).
  They render inconsistently, break in handoff, and read as AI-slop. Replace each with a
  proper inline-SVG (a back chevron, a home glyph, a warning triangle, a checkmark).
* **One icon family per project** - do not mix outline and filled at random.
* Decorative hand-drawn illustrations: avoid. A simple geometric mark is fine.

## 3. Typography

* Control hierarchy with **weight + color + spacing**, not raw font-size. No oversized
  H1s that just scream.
* Inter (or a clean neutral sans / system stack) is **fine and preferred here** - this
  is accessibility-first product UI, exactly the case the upstream allows Inter for. Do
  not reach for a decorative serif to "feel premium"; serif-as-default is a top AI tell.
* Readable body: comfortable line-height, measure ≤ ~65ch for paragraphs.
* If you italicize a word with a descender (`y g j p q`), give it ≥ 1.1 line-height so
  it is not clipped.

## 4. Color calibration

* **Max 1 accent color**; saturation < ~80%. Neutral base (zinc/slate/stone), one
  high-contrast accent.
* **No "AI purple/blue glow"** - no automatic purple/indigo button glows, no random neon
  gradients. (Also a lint-enforced anti-ai-slop sin.)
* **Color consistency lock:** pick one accent and use it on the WHOLE set. A blue-accent
  app does not get a teal status badge on screen 7.
* **One neutral temperature** - do not drift between warm and cool greys.

## 5. Materiality, shape, shadows

* **Shape consistency lock:** ONE corner-radius scale for the whole set (e.g. cards 12px,
  inputs 8px, buttons pill) and follow it everywhere. Round buttons in a square layout =
  broken.
* Use **cards only when elevation means real hierarchy** - otherwise group with a
  hairline (`border-top` / `divide`) or whitespace.
* Shadows: **tint to the background hue**, never pure-black on light. No neon/outer glow.
* No pure black (`#000`) - use off-black/charcoal.

## 6. Interactive states (always implement full cycles)

LLMs default to "static success only." Always cover:

* **Loading:** skeleton matching the final layout shape, not a generic spinner.
* **Empty:** composed empty state that shows how to populate it.
* **Error:** inline under the field (forms) or contextual.
* **Tactile feedback:** on `:active`, a small `translateY(1px)` or `scale(0.98)` push.
* **Button contrast (a11y, mandatory):** every button's label must pass WCAG AA against
  its background (4.5:1 body, 3:1 for ≥18px). No white-on-white, no transparent button
  with no border over a same-color background. Audit every CTA.
* **No CTA text wrap** at normal width; keep primary labels to ≤ 3 words.
* **One label per intent** - don't put "Xác nhận", "Đồng ý", "Tiếp tục" for the same
  action on one screen; pick one.

## 7. Forms & data

* **Label ABOVE the input.** Never placeholder-as-label. Error text BELOW the field.
* Visible focus ring on every interactive field (a11y).
* **Long lists (> 5 items) need a real component**, not a longer `<ul>` with a hairline
  under every row: group into chunks, a card grid, tabs/accordion, or a scroll-snap row.
* **Realistic, locale-appropriate placeholder content** (Vietnamese, consistent with the
  screen) - never "John Doe", "Acme", lorem ipsum, or fake-perfect numbers
  (`99.99%`, `1234567`). Use organic values; mark mock data as mock.

## 8. AI tells - forbidden by default

Hard bans unless the brief explicitly asks:

* No neon / outer glow; no oversaturated accent; no excessive gradient text.
* No custom mouse cursors; no decorative crosshair / hairline grid lines.
* No generic names / avatars / startup-slop brand names ("Acme", "Nexus").
* No filler verbs ("Elevate", "Seamless", "Unleash", "Next-Gen", "Revolutionize").
* No `div`-based fake screenshots / fake dashboards built from styled divs.
* No decorative colored status dots on every row/nav/badge - only for real semantic
  state, used sparingly.
* No section-number eyebrows (`01 / Capabilities`), no version stamps, no scroll cues.
* **EM-DASH BAN (non-negotiable):** never output an em-dash or en-dash character
  anywhere visible (headlines, labels, body, buttons, captions). Use a regular hyphen
  `-`, a comma, a colon, or two sentences. A stray em-dash/en-dash fails pre-flight.

## 9. Copy self-audit (before done)

Re-read every visible string (headings, labels, button text, body, captions). Rewrite
anything grammatically broken, with unclear referents, or that reads like an LLM trying
to sound thoughtful (forced metaphors, fake-craftsman labels). When unsure, replace with
a plain functional sentence. Boring-but-clear beats cute-but-wrong.

---

These rules **layer on** `html-interactive-prototype` (self-contained HTML/CSS/JS) and
the active craft rules (`anti-ai-slop`, `laws-of-ux`, `typography-hierarchy`, `color`,
`animation-discipline`, `state-coverage`, `accessibility-baseline`). When this guidance
and the prototype skill's hard rules ever conflict, the prototype skill wins (plain
stack, self-contained, no build).
