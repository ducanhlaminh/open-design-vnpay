---
name: heuristic-eval
description: |
  Gate 1 of the docs-to-ui workflow (the `ux-review` pipeline). Read the UX Spec
  (S_SCREEN_SPEC screens + components authored by the `ux-spec` pipeline) plus
  the Customer Journey and docs, and heuristically EVALUATE the wireframe BEFORE
  any UI is built — against Nielsen's 10 Usability Heuristics and Don Norman's 6
  fundamentals. Produce a per-screen review report (findings + severity + score)
  under `./heuristic-review/`. This is a REVIEW stage: it judges the spec and
  reports; it does not rewrite screens or emit UI. WCAG pixel gates (contrast,
  touch target, reflow) are NOT judged here — they are unmeasurable pre-render
  and belong to the post-render accessibility gate. Activate when the user runs
  the "UX Heuristic Review" pipeline or asks to heuristic-eval / soi UX / review
  a UX spec / wireframe against usability heuristics.
triggers:
  - "heuristic eval"
  - "heuristic evaluation"
  - "ux review"
  - "ux-review"
  - "review ux spec"
  - "usability review"
  - "soi ux"
  - "đánh giá heuristic"
  - "review wireframe"
od:
  mode: utility
  category: ux-research
  craft:
    requires:
      - laws-of-ux
      - heuristic-eval
---

# heuristic-eval — judge a UX Spec against usability heuristics (Gate 1)

You are the **UX Heuristic Review** stage of the `docs-to-ui` workflow. Upstream,
`ux-spec` authored the screens; downstream, `ui-html` / `ui-react` render them.
You sit in between as a **shift-left quality gate**: catch conceptual, flow, and
usability problems on the wireframe — where fixing them means editing a spec node,
not regenerating a whole app.

Your rubric is the injected craft reference **`heuristic-eval`** (Nielsen N.1–N.10
+ Norman D1–D6, with the fixed severity + scoring model). Follow it exactly:
every finding cites one heuristic id, takes a severity from that file, and the
score is computed with its arithmetic. Do NOT invent heuristics or severities.

> **Out of scope — do not score:** color contrast, touch-target pixels, font
> sizes, 200% reflow. These are unmeasurable on a wireframe (no color/pixels/DOM
> yet) and are judged later by the post-render WCAG gate. If a spec field hints
> at a risk (e.g. an icon-only control with no label → possible touch-target
> issue later), you may note it as **"deferred to WCAG gate"** in prose, but it
> does not produce a scored finding here.

## Workflow (do these in order)

### 0. Read the inputs (from the project cwd)

- **UX Spec (primary):** `./*-ux-spec.json` or files under `./ux/`. This is the
  screen set you evaluate — each **screen** (S_SCREEN_SPEC) has `screen_type`,
  `screen_intent`, `primary_actor`, `layout` (`mobile`|`web`), and an ordered
  list of **components** (DP_UI_COMPONENT: the inputs/buttons/lists/labels).
- **Wireframes (primary, when present):** `./wireframes/<SCREEN-ID>.wire.json`
  (a flexbox layout TREE — `stack`/`row` containers + leaves whose `c` is a slug
  from the closed registry `skills/ux-spec/references/wire-components.md`),
  authored by the same ux run. This IS the screen's composed LAYOUT, so judge it
  too: visual
  hierarchy and grouping (proximity — related fields adjacent?), primary-action
  placement (reachable, not buried), navigation consistency ACROSS screens (same
  sidebar/topbar skeleton?), and web/mobile idiom fit (a `layout: "web"` screen
  laid out as a narrow phone stack is a finding). A screen missing its wire.json
  while siblings have one is itself a completeness finding.
- **Customer Journey (context):** `./*-customer-journey.json` / `./*-cj.json` or
  under `./customer-journey/`. Use STAGE goals, pain points, and emotion to know
  what each screen is *supposed* to achieve — a screen that doesn't serve its
  stage's goal is itself a finding (N.8 / D6).
**Two documentation layouts.** If `./docs/_overview.md` exists: the documentation is a distilled snapshot from the App pool — read `./docs/_overview.md` first for the full picture, read `./docs/_branches/<slug>.md` for subsystem depth, and open original pages for detail using the "Page map" (paths like `./docs/<branch>/…/<page>.md`). Citations in the distilled snapshot may point to pages NOT loaded into the workspace (the user selected only part of the pool) — a missing path means that page was not selected: use the summary, do not infer further, and do not report an error. If `_overview.md` is absent: use the legacy layout (`./docs/confluence/`, `./docs/jira/`, `./docs/context/`) described below.

- **Docs (context):** `./docs/**/*.md` — the domain. Use them to tell a real
  domain constraint (which must be honored → D5/D6) from a missing affordance.
- **Rule flowcharts (primary, when present):** `./flows/<FLOW-ID>.flow.json`
  (decision/end nodes + labeled edges between screen ids), authored by the same
  ux run. Judge flow INTEGRITY as findings: a decision node with fewer than 2
  labeled outgoing branches (N.5/N.9 — the error path is unspecified), a screen
  edge whose target id doesn't exist in the spec, a spec screen that no flow
  reaches (orphan — N.8/D6 unless the docs justify a standalone screen), and a
  cj USER_FLOW with no corresponding flow file (coverage gap).
- **UX Research criteria (context, when present):** `./ux-research/report.json`
  — the upstream `ux-research` stage's evidence-based criteria. A screen that
  violates a `must` criterion is a finding: score it under the closest
  Nielsen/Norman heuristic as usual, and ALSO name the criterion id + its
  source in the finding's prose. The rubric's severities stay authoritative —
  do not invent a parallel scale for criteria. Absent report → skip silently.

If no UX Spec is present, stop and report that Gate 1 has nothing to evaluate —
do not fabricate screens.

### 1. Evaluate — adversarial, screen by screen

For EACH screen, walk the full rubric (N.1–N.10, then D1–D6) and actively try to
**refute** the screen: hunt for each heuristic's *failure signal* from the craft
file. Default to recording a finding when a required signal is absent — a gate
heuristic (N.5, N.3, D6 on money/data/destructive flows) with no evidence of
compliance is a finding, not a pass. Be concrete: tie every finding to a named
screen and, where possible, a specific component or the missing one.

For each finding capture: the heuristic id + name + source (`nielsen`|`norman`),
severity (per the craft file), whether it's a `gate`, the `issue` (what's wrong),
the `evidence` (which screen/component/field shows it), a `recommendation` (the
smallest spec change that fixes it), and `status` (`fail`|`warn`|`pass`).

Also record the notable **passes** — heuristics the screen clearly satisfies —
so the report is a real evaluation, not just a bug list.

### 2. Score (apply the craft arithmetic exactly)

Per screen: start 100, subtract blocker −25 / major −10 / minor −3, floor 0.
Screen verdict: **fail** if any blocker or score < 60; **warn** if 60–84;
**pass** if ≥ 85. Project score = mean of screen scores (rounded); project
verdict = worst screen verdict. Show the subtraction so a reader can re-derive it.

### 3. Write the report — FILE-ONLY, under `./heuristic-review/`

This is a **file-only** stage: produce files only, do **not** push anything to
KGS (no `od kg push`, no push_to_kgs.py).

> **Per-screen fan-out.** When the UX Spec has several screens, the daemon runs
> this skill ONCE PER screen and your kickoff names the screen id + tells you to
> write your slice to `heuristic-review/<slug>/report.json`. In that case:
> review ONLY that one screen (its wireframe + spec), put it as the single entry
> in `screens[]` (screen id VERBATIM), and do NOT write `heuristic-review/report.json`
> or `summary.md` — the daemon merges every screen's slice into those. Follow the
> kickoff's output path verbatim when it gives one.

Write three things:

1. **`./heuristic-review/report.json`** — the machine-readable result. Shape:

```json
{
  "schema_version": "1.0",
  "generated_from": ["<ux-spec file>", "<cj file>"],
  "summary": { "screens": 0, "score": 0, "verdict": "pass|warn|fail",
               "blockers": 0, "majors": 0, "minors": 0 },
  "screens": [
    {
      "screen": "<S_SCREEN_SPEC id, copied VERBATIM from the ux-spec JSON>",
      "screen_name": "<the screen's human-readable name>",
      "score": 0,
      "verdict": "pass|warn|fail",
      "score_math": "100 - 25(blocker) - 10(major) = 65",
      "findings": [
        {
          "heuristic": "N.5",
          "name": "Error prevention",
          "source": "nielsen",
          "severity": "blocker|major|minor",
          "gate": true,
          "status": "fail|warn|pass",
          "issue": "…",
          "evidence": "screen <x>, component <y> (or: missing)",
          "recommendation": "…"
        }
      ],
      "passes": ["N.1", "D4"]
    }
  ]
}
```

2. **`./heuristic-review/summary.md`** — a human-readable digest: the project
   verdict + score at the top, a table of screens (score / verdict / #blockers /
   #majors), then the blockers and majors listed with their recommendation.
   Lead with what must be fixed before building the UI.

3. **`./heuristic-review/<screen-slug>.md`** — one file per screen: its findings
   in full (grouped fail → warn → pass), each citing the heuristic id and the
   recommended spec change. Slug = the screen id lowercased/kebab-cased.

Keep ids stable (same screen → same slug file) so re-runs diff cleanly.

## Hard rules

- Cite one heuristic (N.1–N.10 / D1–D6) per finding — never an ad-hoc rule.
- `screens[].screen` MUST be the spec screen's `id` copied VERBATIM from the
  ux-spec JSON (`screen_name` carries its display name). Downstream viewers
  (pipeline-studio) join each review row to that screen's wireframe by this id
  — never invent, rename, or slugify it.
- Severity + scoring come from the `heuristic-eval` craft file; don't improvise.
- Never score WCAG pixel gates here (contrast/touch/reflow) — Gate 2 owns them.
- Do not modify the UX Spec or emit any UI. Report only.
- File-only: no KGS push. The pipeline syncs `./heuristic-review/` separately.
