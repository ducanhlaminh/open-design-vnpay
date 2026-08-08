---
name: feature-analysis
description: |
  Pipeline P2 (analyze features). Read the Markdown requirement docs produced by
  the `jira-ingest` pipeline (P1) under `./docs/jira/` (and `./docs/confluence/`)
  and distil them into a Feature list written as ONE FILE PER FEATURE under
  `./features/<Feature Name>.md` (+ a `./features/_index.json` manifest). This is
  the JOIN POINT of the docs→UI pipeline: those per-feature files are the contract
  the UX pipeline (`ux-spec`) and Customer Journey pipeline
  (`customer-journey-spec`) both consume. Activate when
  the user runs the "Phân tích Feature" pipeline, or asks to "analyze features",
  "phân tích yêu cầu", "trích feature từ tài liệu", "build feature list".
triggers:
  - "feature analysis"
  - "analyze features"
  - "phân tích feature"
  - "phân tích yêu cầu"
  - "trích feature"
  - "feature list"
  - "requirement analysis"
od:
  mode: utility
  category: requirements
---

# feature-analysis — Docs → Feature list (pipeline P2)

Second stage of the **docs → UI** pipeline. You turn the raw Jira Markdown from
P1 into a clean, deduplicated **Feature list** that downstream design stages can
build on without re-reading Jira.

**Two documentation layouts.** If `./docs/_overview.md` exists: the documentation is a distilled snapshot from the App pool — read `./docs/_overview.md` first for the full picture, read `./docs/_branches/<slug>.md` for subsystem depth, and open original pages for detail using the "Page map" (paths like `./docs/<branch>/…/<page>.md`). Citations in the distilled snapshot may point to pages NOT loaded into the workspace (the user selected only part of the pool) — a missing path means that page was not selected: use the summary, do not infer further, and do not report an error. If `_overview.md` is absent: use the legacy layout (`./docs/confluence/`, `./docs/jira/`, `./docs/context/`) described below.

- **Input (only):** in the distilled layout, read the App snapshot and source pages under `./docs/<branch>/**/*.md`; in the legacy layout read `./docs/jira/*.md` + `./docs/jira/_index.md` written by the
  `jira-ingest` pipeline (P1). If that folder is missing/empty, stop and tell the
  user to run **Docs → Markdown (JIRA)** first.
- **Output:** one file per feature `./features/<Feature Name>.md` (frontmatter =
  machine contract + readable body) plus `./features/_index.json` (manifest).
  These are what `ux-spec` (P3) and `customer-journey-spec` (P4) read.
- Optional helper: the `ba-agent` MCP server may be used to cross-check or enrich
  the feature breakdown, but the `.md` files remain the source of truth.

## Workflow (do these in order)

### 1. Read every doc
- Read `./docs/jira/_index.md` to get the full issue set, then read each
  `<KEY>.md`. Parse the frontmatter (`key/type/status/epic/...`) and the
  Description / Acceptance Criteria sections.

### 2. Group issues into features
- A **feature** is a coherent unit of user-facing capability — usually an Epic, or
  a cluster of Stories that serve one goal. Group Stories/Tasks under their `epic`
  (frontmatter) when present; otherwise cluster by theme/labels.
- For each feature extract: the user stories, the actors/personas involved, the
  acceptance criteria, and a first guess at the screens it implies.

### 3. Write ONE file per feature — filename = the feature name

Do NOT dump everything into a single `features.json`. Write **one Markdown file
per feature** under `./features/`, named after the feature itself:

```
./features/<Feature Name>.md      e.g. ./features/Checkout & Payment.md
```

- **Filename = the feature's name** (sanitize only `\ / : * ? " < > |` → `-`;
  keep spaces and Vietnamese characters). One feature = one file.
- Each file has YAML frontmatter (the machine contract P3/P4 read) + a readable
  body. This is the SAME schema as before, just split per feature:

```markdown
---
id: FEAT-001                       # stable, re-runnable
name: Checkout & Payment
priority: High                     # High | Medium | Low
actors: [Customer, Cashier]        # drives the UX actor filter
related_issues: [VNP-1234, VNP-1235]
suggested_screens: [Cart, Payment, Confirmation]   # hints for ux-spec
---

# Checkout & Payment

<2-4 sentence summary.>

## User stories
- **US-001** As a Customer, I want to pay by QR, so that checkout is fast. _(VNP-1234)_

## Acceptance criteria
- Payment confirmed within 3s
- …
```

Rules:
- **Every feature must trace back** to ≥1 `related_issues` key from the docs — do
  not invent features with no source. Mark inferred items clearly; keep
  `related_issues` accurate.
- `actors` + `suggested_screens` are the bridge into P3/P4 (ux-spec uses actors +
  screens; customer-journey-spec uses actors + user_stories as journey stages).
- Stable `FEAT-…` / `US-…` ids so a re-run updates the same file in place.

### 4. Write `./features/_index.json` (manifest)
A small manifest so P3/P4 and tracking can enumerate the set without parsing
every file:

```jsonc
{
  "project": "<project key or name>",
  "generated_at": "<ISO timestamp>",
  "source": "./docs/jira/",
  "features": [
    { "id": "FEAT-001", "name": "Checkout & Payment", "file": "features/Checkout & Payment.md",
      "priority": "High", "related_issues": ["VNP-1234", "VNP-1235"] }
  ]
}
```

> Contract with P3 (`ux-spec`) and P4 (`customer-journey-spec`): read
> `./features/_index.json` to list features, then each `./features/<name>.md` for
> the full per-feature detail (frontmatter + body).

## Done criteria
- `./features/` has one `.md` per feature (filename = feature name), each with the
  frontmatter above, and `./features/_index.json` lists them all (≥1 feature).
- Every feature has non-empty `related_issues` tracing to P1 docs.
- Report the feature count and stop. The UX (`ux-spec`) and Customer Journey
  (`customer-journey-spec`) pipelines become available once this run succeeds.

## Hard rules
- Input is the P1 Markdown only; never re-pull Jira here (that is P1's job).
- No KGS / graph writes in this stage — output is local JSON + Markdown.
- Keep traceability: features → issues → docs. No orphan features.
