---
name: wcag-lint
description: |
  Gate 2 of the docs-to-ui workflow — the post-render accessibility check that
  runs at the END of a UI-Spec terminal (`ui-html` / `ui-react`). After the
  terminal has produced its self-contained HTML, MEASURE the rendered output
  against the WCAG success criteria that only exist once pixels do: text &
  non-text contrast (1.4.3 / 1.4.11), touch-target size (2.5.8), plus heuristic
  flags for color-only signalling and text-as-image. Emit a machine-readable
  `a11y-report.json` next to the deliverable. This is a MEASUREMENT gate, not a
  judgment one — it runs a deterministic linter and records the numbers; it does
  not redesign screens. Activate as an extra skill on the UI terminals, or when
  the user asks to WCAG-lint / accessibility-check / a11y-audit a produced
  prototype or built React app.
triggers:
  - "wcag lint"
  - "wcag check"
  - "accessibility check"
  - "a11y audit"
  - "a11y lint"
  - "contrast check"
  - "kiểm tra accessibility"
od:
  mode: utility
  category: quality
  craft:
    requires:
      - accessibility-baseline
---

# wcag-lint — measure a produced UI against WCAG (Gate 2)

You run at the **end of a UI-Spec terminal run** (`ui-html` or `ui-react`),
after the screens have been produced/built. Where Gate 1 (`heuristic-eval`)
*judged the wireframe*, you *measure the render*: the WCAG success criteria that
are unmeasurable before pixels exist — contrast, touch target, reflow. Your
rubric is the injected craft reference **`accessibility-baseline`** (WCAG 2.2 AA
as the working floor).

This is deterministic: a bundled linter computes the numbers. Do not eyeball
contrast or redesign screens — run the tool, then fold its output into the
report and add short notes only for the checks the tool defers to manual.

## Workflow

### 1. Find the produced UI output (this run)

- **HTML terminal (`ui-html`):** the self-contained pages are under
  `./prototype/`.
- **React terminal (`ui-react`):** the BUILT pages are under `./react/dist/`
  (`index.html` + `screens/*.html`). Run this only AFTER the build step has
  produced `dist/` — lint the built HTML, not the `.tsx` source.

Pick whichever directory this run produced.

### 2. Run the linter

```bash
python3 scripts/wcag_lint.py <output-dir> <output-dir>/a11y-report.json
# ui-html:   python3 scripts/wcag_lint.py ./prototype      ./prototype/a11y-report.json
# ui-react:  python3 scripts/wcag_lint.py ./react/dist     ./react/a11y-report.json
```

`scripts/wcag_lint.py` is stdlib-only Python (no deps, no browser). It reads
every `.html` in the directory and measures:

- **Contrast (WCAG 1.4.3 / 1.4.11)** — resolves the `:root` design-token palette
  (`--bg/--surface/--fg/--muted/--border/--accent`) and any explicit inline
  `color`+`background` pairs, then computes the real ratio. `fail` when normal
  text is under 4.5:1; `warn` for near-misses and ambiguous non-text roles.
- **Touch target (WCAG 2.5.8)** — flags interactive elements that declare an
  explicit size under 44px.
- **Color-only / text-as-image / reflow / 200% zoom** — emitted as `manual`
  items (they need real layout/zoom), so the report states honestly what a
  static pass does NOT cover.

Write the report **inside the produced output directory** (`./prototype/` or
`./react/`) as shown — it then syncs to the media store with the deliverable and
attributes to this terminal stage automatically.

### 3. Act on the result

- If the linter reports **`fail`** findings (real contrast violations you
  produced), FIX them in the UI you just generated — adjust the offending token
  or inline color so it clears the threshold — then re-run the linter until
  contrast fails are gone. Contrast fails are self-inflicted and cheap to fix
  here; do not ship them.
- Leave `warn`/`info` as recorded advisories.
- For each `manual` item, add a one-line note in your run summary telling the
  reviewer what to verify by eye (color-only signalling, text-spacing reflow,
  200% zoom) — you cannot measure these without a browser, so do not mark them
  passed.

## Hard rules

- Measure with the tool; never fabricate contrast numbers.
- Fix `fail` contrast in the generated UI before finishing the run.
- The report path lives inside the output dir (`prototype/` or `react/`) so it
  syncs and attributes correctly — do not write it to the cwd root.
- Do not push anything to KGS — the report is a file-only deliverable.
- This is the render-time gate; screen/flow/usability judgment belongs to Gate 1
  (`heuristic-eval`), not here.
