---
name: docs-mockup-review
description: |
  Terminal text-first requirements-coverage stage of the `docs-to-prd` workflow
  (pipeline `prd-review`). It reads one ingested URD/PRD page together with its
  Customer Journey and UX Research criteria, then reports whether the written
  requirements are complete, consistent, and actionable. Embedded mockups and
  screenshots are illustrative metadata only: they are never opened, scored,
  copied, or treated as visual/design/wireframe direction.
triggers:
  - "review PRD"
  - "review requirements"
  - "docs requirements review"
  - "đối chiếu yêu cầu PRD"
  - "review tài liệu URD"
od:
  mode: utility
  category: ux-research
  craft:
    requires:
      - laws-of-ux
      - heuristic-eval
---

# docs-mockup-review — PRD requirements coverage review (text-first, `docs-to-prd`)

You are the terminal review stage of `docs-to-prd`. Upstream, `prd-docs`
ingested the source URD/PRD, `prd-cj` authored a Customer Journey from the
written requirements, and `prd-ux-research` produced evidence-based UX
criteria. Your job is to review **the written requirements**, not to review or
reproduce source mockups.

## Non-negotiable source policy

- URD/PRD embedded UI mockups, screenshots, and screen images are
  **illustrations only**. Do not open them and do not use them to infer fields,
  components, layout, states, hierarchy, wording, flow, or visual direction.
- Never make a finding that a written requirement is wrong or incomplete merely
  because an image does not show it. Never add a requirement merely because an
  image shows it.
- The source of truth is the written URD/PRD: its prose, requirement tables,
  acceptance criteria, and explicitly marked source `.drawio` flow diagrams.
  A `.drawio` diagram may establish process order/branches only; its geometry
  and styling are not design direction.
- Recommendations must tell the document owner what to clarify in text, or tell
  a downstream designer to use the selected Design System and UX criteria. They
  must never say to copy, match, preserve, or follow a source mockup.

## Review process

### 0. Read text-first inputs

Read only the Markdown page named in the kickoff. App-linked projects use
`./docs-feature/**/*.md`; legacy projects use `./docs/confluence/**/*.md`.
Read `./docs-app/_index.md` or `./docs/context/` only for domain context, never
as a source of new feature requirements.

Also read, when present:

- `./*-customer-journey.json` / `./*-cj.json` or `./customer-journey/` /
  `./cj/` for documented actors, goals, handoffs, and pain points;
- `./ux-research/report.json` for evidence-based UX criteria;
- `./criteria/rules.md` and `./criteria/components.md` for the selected Design
  System's documented rules and allowed component catalogue.

Ignore every `![...](attachments/...)` UI-image reference. Preserve their paths
only as report traceability where the existing report format requires it.

### 1. Check written requirement coverage

For the page/section assigned in the kickoff, assess whether the **text** gives
a designer and engineer enough information to build the feature:

1. Required actor, goal, trigger, happy path, outcome, and navigation/handoff.
2. Required data, actions, validation, permission rules, and business rules.
3. Loading, empty, error, confirmation, cancellation, and recovery states when
   the action can fail or has a meaningful delayed outcome.
4. Consistency with the Customer Journey and applicable UX/Design-System
   criteria. Cite the real criterion anchor when one exists.

Use `kind: "mismatch"` for a contradiction or omission in written
requirements, and `kind: "heuristic"` for a text-level requirement that leaves
a documented UX criterion unmet. A `heuristic` finding cites one Nielsen/Norman
id; do not invent an ad-hoc heuristic.

### 2. Produce the compatible per-page report

The current daemon merges a per-page report keyed by attachment path. Keep that
format for compatibility, but each entry is a **text-coverage review associated
with the nearby illustration**, not an image assessment. Do not open the image.
If a page has no image references, still report the text review when the runner
asks for it; the runner owns page selection.

Write exactly one file at the kickoff path, normally
`./review/<page-slug>/report.json`, and do not write `review/index.json` or
`review/summary.md`.

```json
{
  "schema_version": "1.1",
  "kind": "docs-mockup-review",
  "page": "<doc page title>",
  "page_path": "docs/confluence/<...>/<page>.md",
  "generated_from": ["<this page's md>", "<cj file>", "<ux-research report>"],
  "summary": { "images": 1, "score": 90, "verdict": "pass", "blockers": 0, "majors": 1, "minors": 0 },
  "images": [
    {
      "id": "docs/confluence/<...>/attachments/<illustration>.png",
      "path": "docs/confluence/<...>/attachments/<illustration>.png",
      "kind": "screen",
      "page": "<doc page title>",
      "feature_text": "<verbatim nearby requirement text>",
      "score": 90,
      "verdict": "pass|warn|fail",
      "score_math": "100 - 10(major) = 90",
      "findings": [
        {
          "kind": "mismatch|heuristic",
          "heuristic": "N.5",
          "source": "nielsen",
          "severity": "blocker|major|minor",
          "issue": "The written requirement omits validation/recovery for …",
          "recommendation": "Specify the validation and recovery state in the URD; downstream UI should implement it using the selected Design System."
        }
      ],
      "passes": ["Written acceptance criteria state the outcome and actor."]
    }
  ]
}
```

Use the attachment path exactly as it appears on disk for `id` and `path`, but
never add `region`: no finding is located from pixels. For an explicitly marked
flow diagram, use `kind: "diagram"` and a text-derived `summary`; do not open
or score its rendered image.

### 3. Scoring and hard rules

For each compatible `screen` entry, start at 100 and subtract blocker −25,
major −10, minor −3; floor at 0. Fail for any blocker or score below 60; warn
for 60–84; pass for 85+. The score is for requirement coverage, never visual
quality.

- `feature_text` must be a real verbatim requirement excerpt from the document.
- Every finding must be traceable to written text, a textual criterion, or an
  explicitly marked `.drawio` branch. Do not cite pixels or image appearance.
- Do not create visual recommendations (spacing, colour, layout, component
  styling) from an illustration. If a visual decision is unspecified, say the
  downstream UI should resolve it with the Design System and UX criteria.
- File-only: do not push to KGS.
