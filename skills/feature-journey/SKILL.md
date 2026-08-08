---
name: feature-journey
description: |
  Combined step for the docs → HTML prototype workflow: run BOTH Feature Analysis
  AND Customer Journey in ONE pass, in dependency order. The two are coupled — the
  customer journey is DERIVED from the features — so this skill runs Feature
  Analysis first (writing ./features/) and then Customer Journey, which READS those
  features to build traceable journeys. Activate when the user runs the combined
  "Feature Analysis + Customer Journey" pipeline. The detailed feature-analysis and
  customer-journey-spec workflows are appended to this prompt; follow them verbatim
  within the two ordered phases below.
triggers:
  - "feature and journey"
  - "feature + customer journey"
  - "feature analysis and customer journey"
  - "feature journey combined"
od:
  mode: utility
  category: requirements
---

# feature-journey — Feature Analysis + Customer Journey (combined step)

One pipeline step that produces BOTH the Feature list AND the Customer Journey in
a single run. They are **interdependent**: the journey is built FROM the features,
so order matters. The two detailed skill workflows are included **below in this
same prompt** (`feature-analysis` and `customer-journey-spec`) — follow them
exactly, but sequence them through the two phases here.

> Why one step: in this workflow the journey has no meaning without the features
> it traces back to, so they ship together. Running them out of order (journey
> before features) would force the journey into its ad-hoc fallback and lose
> traceability — do not do that.

## Run in two ordered phases (do NOT interleave)

### Phase 1 — Feature Analysis → `./features/`
**Two documentation layouts.** If `./docs/_overview.md` exists: the documentation is a distilled snapshot from the App pool — read `./docs/_overview.md` first for the full picture, read `./docs/_branches/<slug>.md` for subsystem depth, and open original pages for detail using the "Page map" (paths like `./docs/<branch>/…/<page>.md`). Citations in the distilled snapshot may point to pages NOT loaded into the workspace (the user selected only part of the pool) — a missing path means that page was not selected: use the summary, do not infer further, and do not report an error. If `_overview.md` is absent: use the legacy layout (`./docs/confluence/`, `./docs/jira/`, `./docs/context/`) described below.

Follow the **feature-analysis** workflow exactly: in the distilled layout read `./docs/_overview.md` first, then the selected source pages under `./docs/<branch>/**/*.md`; otherwise read `./docs/jira/*.md` (+
`./docs/confluence/`) produced by *Docs → Markdown*, distil into one file per
feature under `./features/<Feature Name>.md` plus `./features/_index.json`. If
`./docs/jira/` is missing or empty, STOP and tell the user to run **Docs →
Markdown (JIRA)** first.
**Finish this phase — `./features/_index.json` must exist on disk — before
starting Phase 2.**

### Phase 2 — Customer Journey → `./<feature>-customer-journey.json`
Follow the **customer-journey-spec** workflow exactly. Its Step 0 READS
`./features/_index.json` from Phase 1: use each feature's `actors` +
`user_stories` to build the USER_FLOW + STAGE journey, keeping traceability —
**every journey stage must trace back to a feature from Phase 1**. Because Phase 1
always produced the features in this combined run, do NOT take the "no
`./features/` folder" ad-hoc path.

## Done when
- `./features/` (with `_index.json`) exists, AND
- the customer-journey JSON exists and every journey traces back to those
  features.

Report the feature count and the journey count, then stop. KGS push for each
output follows that sub-skill's own rules; target the `project_id` given in the
run kickoff.
