# Layout primitives — structure you copy, not re-derive

Origin: Open Design upstream, OD Next prototype profile (`layout.css` v1,
nexu-io/open-design #7327, 08/2026). Their blind evals showed three layout
defects recurring no matter how the prose rules were worded: sibling inline
spans that never became blocks, a chrome height constant reused as content
padding, and authored copy crammed until it wrapped or got an ellipsis. The
fix is a copyable block plus action-level rules keyed to its class names.

## The block (OD-LAYOUT-PRIMITIVES v1)

- **Self-contained HTML deliverables** (`ui-html` prototype pages): paste the
  block below **verbatim as the FIRST rule set** of the document's `<style>`,
  before your `:root` tokens. Keep the marker comments. Every page carries it.
- **React deliverables** (`ui-react`, `ui-react-ds`): the template
  `src/index.css` already ships the same block — use the classes, never
  redefine them.
- `@layer od-layout` is declared first, so every product / design-system rule
  outside the layer wins. The block is **structure only**: display, flex/grid,
  overflow, wrapping, ratio. It sets no palette, type, spacing scale, or
  component look — those stay on your tokens / `tk-*` classes.

```css
/* OD-LAYOUT-PRIMITIVES v1 — structure only: display, flex/grid, overflow, wrapping, ratio.
   Put this @layer first; product CSS outside the layer always wins. */
@layer od-layout {
  :where(.od-stack,.od-row,.od-row-top,.od-cluster,.od-grid,.od-field,.od-stat,.od-cell,.od-tile) > :where(*) { min-width: 0; }

  /* containers */
  .od-stack   { display: flex; flex-direction: column; gap: var(--od-gap, 8px); }
  .od-row     { display: flex; align-items: center; gap: var(--od-gap, 8px); }
  .od-row-top { display: flex; align-items: flex-start; gap: var(--od-gap, 8px); }
  .od-cluster { display: flex; flex-wrap: wrap; align-items: center; gap: var(--od-gap, 8px); }
  .od-fill    { flex: 1 1 0; min-width: 0; }
  .od-fixed   { flex: none; }
  .od-grid    { display: grid; gap: var(--od-gap, 12px); grid-template-columns: repeat(var(--od-cols, 3), minmax(0, 1fr)); }

  /* stacked information: each piece is its own line — never sibling inline spans */
  .od-stat, .od-field, .od-cell { display: grid; gap: var(--od-gap, 2px); }
  :where(.od-stat,.od-field,.od-cell) > :where(*) { display: block; }
  .od-tile { display: grid; grid-template-rows: auto 1fr; }
  :where(.od-tile) > :where(*) { display: block; }

  /* media keeps its intrinsic ratio by default; never a distorted or cropped
     cover by accident. height:auto lets the ratio win over an <img height="…">
     attribute. Cropping to a uniform box is an explicit opt-in: set --od-ratio
     AND add .od-media-cover together (only where a crop is deliberate — tile
     thumbs, decorative fills — never on full-frame content). */
  .od-media { display: block; width: 100%; height: auto; aspect-ratio: var(--od-ratio, auto); }
  .od-media-cover { object-fit: cover; }

  /* data text only — authored copy is rewritten to its budget instead */
  .od-truncate { display: block; max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .od-clamp-2, .od-clamp-3 { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .od-clamp-2 { -webkit-line-clamp: 2; }
  .od-clamp-3 { -webkit-line-clamp: 3; }
  .od-lines-2 { min-height: calc(2 * 1.4em); }   /* block-level reservation for a shared baseline */
  .od-nowrap  { white-space: nowrap; }           /* number+unit · price+suffix · date+weekday */
  .od-keep    { word-break: keep-all; overflow-wrap: anywhere; } /* short labels break at spaces / <wbr> first */

  /* screen skeleton (optional): bars take their own space, the middle scrolls — no padding guessed for chrome */
  .od-screen { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; }
  .od-scroll { overflow-y: auto; overscroll-behavior: contain; min-height: 0; }

  /* horizontal rail: the next item peeks at the edge; trailing room survives overflow */
  .od-rail { display: flex; gap: var(--od-gap, 8px); overflow-x: auto; scroll-snap-type: x proximity; scrollbar-width: none;
             padding-inline: var(--od-rail-pad, 16px); scroll-padding-inline: var(--od-rail-pad, 16px); }
  .od-rail::-webkit-scrollbar { display: none; }
  :where(.od-rail) > :where(*) { flex: none; scroll-snap-align: start; }
  :where(.od-rail) > :where(:last-child) { margin-inline-end: var(--od-rail-pad, 16px); }

  .od-spacer { flex: none; visibility: hidden; pointer-events: none; }
  .od-touch  { min-width: 44px; min-height: 44px; }
}
/* /OD-LAYOUT-PRIMITIVES v1 */
```

## Rules — apply while writing, not as a check afterwards

### 1. Stacked information = one block per piece

- Two texts that share one box (label over helper, numeral over caption,
  weekday over date) are two **block-level** elements — `<span>` children of a
  `<button>` included. Compose them from `.od-stat` / `.od-field` / `.od-cell`;
  never sibling inline spans.
- `width`, `height`, `min-height` go only on an element already declared block
  or flex.
- A number and its unit, a price and its suffix ("từ 98.000 ₫"), a date and
  its weekday sit in `.od-nowrap`. Size display-scale numerals with `clamp()`.

### 2. Variable-length text: choose one of three fates BEFORE writing it

Two kinds of text, two treatments:

- **Authored copy** — headings, taglines, chip labels, button labels, tile and
  section titles — is written to a length budget and **never truncated or
  clamped**: chip ≤ 2 words, tile name one line at ≥ 14px, tagline over media
  1–2 short lines, button label one line. When it does not fit, shorten the
  copy or change the container. A slogan with an ellipsis is not a design.
- **Data text** — names, addresses, descriptions, reviews, anything from the
  user's data — gets exactly one of: (a) wrap inside an auto-sized block with
  `.od-clamp-2` / `.od-clamp-3` in cards; (b) truncate to one line with
  `.od-truncate` in lists, chips and rails, with the full text one tap away
  (expand, sheet, or the detail screen — `title` alone is not a mobile path);
  (c) move the detail behind a disclosure. On confirmation, order and detail
  screens it wraps in full.
- **Never truncated, clamped or wrapped:** prices, times, quantities,
  availability and status, the primary action label, error messages.
- Never an undeclared overflow, a bare `overflow: hidden`, or a 1–2 character
  orphan on the last line.

### 3. Screen chrome takes its own space

- `.od-screen > header + .od-scroll + footer`: bars occupy their own rows and
  the middle scrolls. Never reuse a chrome height constant as content padding.
- Intentional fixed / sticky chrome (app bar, bottom navigation, floating
  controls) is fine, and reserves matching room for the content it covers via
  the skeleton — not a guessed number.
- A centring placeholder in a bar is `.od-spacer` sized like the opposite
  control — never an empty button.
- Sheets, dialogs, toasts and scrims mount at screen level, often outside the
  app's own wrapper, so product tokens live on `:root` — never on an inner
  wrapper an overlay cannot inherit.

### 4. Image geometry: measure, then size

- Before writing styles for a local image, read its intrinsic width and height
  from the file (`sips -g pixelWidth -g pixelHeight <file>` on macOS,
  `identify <file>` elsewhere). The container adopts that ratio: set
  `--od-ratio` from the measured values, or let `width: 100%; height: auto`
  flow. Never force a content-bearing image into a container with a different
  fixed ratio.
- Content-bearing images — product shots, covers, artwork, posters — render
  their full frame: bare `.od-media`. `object-fit: cover` is an explicit
  opt-in for deliberately croppable fills (hero backdrops, uniform tile
  thumbs): set `--od-ratio` **and** add `.od-media-cover` together. A container
  never locks both axes around variable-ratio content.
- `<img>` keeps its `width` / `height` attributes for layout stability and
  `.od-media` sizes it — never a CSS height on the image.

### 5. Flow first; absolute positioning is for decoration only

- Primary content regions lay out in normal flow (flex / grid). Never stack
  sibling content regions over each other with absolute positioning, negative
  margins, or transforms.
- Absolute positioning is reserved for decorative overlays (badges) anchored
  inside a positioned container, with offsets only on the anchoring axes
  (`top` + `right` for a corner badge) — offsets on every side stretch an
  auto-sized overlay to fill its parent.
- A card, tile or row built on `<a>` sets its own `color` and
  `text-decoration: none`; browser link styling never reaches product UI.
- Pointer-only styles live under `@media (hover: hover)`. Tap targets are
  ≥ 44 px (`.od-touch`) with ≥ 8 px between neighbours.

## Shapes — compose from the block instead of re-deriving per card / row / tile

| Content | Container | Shape |
|---|---|---|
| Numeral + caption | stat strip, hero stats | `.od-stat` — numeral above, caption below, each its own block |
| Label + helper text | settings row, form row | `.od-row > .od-field.od-fill + control.od-fixed`; helper is a block under the label, ≤ 2 lines |
| Weekday + day + availability | date rail cell | `.od-cell` — three blocks; a sold-out cell dims as a whole and keeps its text |
| Commerce / service card | list row, 2–3 column tile | `.od-tile > .od-media + body`: name one line; selling points as ≤ 3 chips, not a 2-line description; price in `.od-nowrap` on the name line or lower-right |
| Chip rail | filter bar | `.od-rail` — the next chip peeks at the edge; anything longer than a chip is a list row |
| Screen chrome | top bar / content / bottom bar | `.od-screen > header + .od-scroll + footer` |
| Centring placeholder in a bar | top bar | `.od-spacer` sized like the opposite control |
| Rarely needed explanation (fees, terms) | beside a label or price | a ≥ 44 px ⓘ control opening a sheet on tap; selling points and guarantees are chips, not hidden detail |
