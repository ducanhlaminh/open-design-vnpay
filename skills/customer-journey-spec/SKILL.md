---
name: customer-journey-spec
description: |
  Author a Customer Journey map as a JSON file from the ingested product docs.
  open-design is the UX PRODUCER: this skill writes USER_FLOW (to-be customer
  journeys), STAGE (journey steps with emotion + pain points), and optionally
  personas. The docs→UI pipeline reads the file DIRECTLY (the Customer Journey
  preview / `/customer-journey`) — it is not pushed anywhere. Activate when the
  user asks to "design a customer journey", "tạo customer journey", "user flow",
  "to-be journey", or "journey map". For per-screen UX specs (S_SCREEN_SPEC +
  components on /ux-spec) use the sibling `ux-spec` skill instead.
triggers:
  - "customer journey"
  - "customer journey map"
  - "user journey"
  - "user flow"
  - "to-be journey"
  - "journey map"
  - "tạo customer journey"
od:
  mode: utility
  category: ux-research
---

# customer-journey-spec — author a Customer Journey (JSON file)

open-design produces **UX** for an App's features. This skill authors the
Customer Journey for the feature described by the ingested docs and writes it as
a **JSON file** that the docs→UI pipeline reads directly — the open-design
Customer Journey preview (`/customer-journey`) renders it, and the downstream
`ux-spec` stage reads the journeys/personas to derive screens.

> Sibling skill: `ux-spec` authors the per-screen UX Spec for `/ux-spec`. Use
> that one for screen specs; use this one for journey maps. A persona can appear
> in either.

> **MCP note.** The project may have `mcp-atlassian` (Confluence/Jira) enabled —
> that is for the **docs ingest** step, NOT this one. Do NOT call any Confluence/
> Jira MCP tool here: your source is the already-ingested Markdown under `./docs/`.

## When to use
- The user wants to design / generate a customer journey for the feature whose
  docs have been ingested, to appear in the Customer Journey preview.

## Workflow (do these in order)

### 0. Read the input (docs MD is the source)
The docs→UI workflow is `docs → cj → ux`: this pipeline runs straight after docs
ingest, with NO feature-analysis upstream and NO `./features/` folder — do not
look for one.
1. **Docs MD (primary):** read every Markdown file under `./docs/` (e.g.
   `./docs/confluence/**/*.md`, `./docs/jira/**/*.md`). These product docs ARE
   your source of truth — derive the actors, the to-be journeys, and each stage
   (with emotion / pain points) directly from them.
2. **Ad-hoc:** if no docs are present at all, take the journey from the user's
   request.

**Context pages — `./docs/context/` (do NOT build from these):** link-followed
pages fetched ONLY as background. Read them to understand the domain / business
rules, but do NOT derive any actor, journey, or stage from them. Build the
journeys strictly from `./docs/confluence/` and `./docs/jira/`.

3. **Flow diagrams (AUTHORITATIVE for the order of steps):** the ingest saves
   every draw.io diagram embedded in the docs as its SOURCE file next to the
   page — `./docs/confluence/attachments/<name>.drawio` — and marks it in the
   Markdown with a line reading `flow-diagram — nguồn sơ đồ (đọc file này để
   lấy luồng): …`. Where a diagram exists, IT is the documented flow. Read it
   and follow it; do not invent an order the diagram contradicts, and do not
   quietly drop a branch it shows.

   The file is mxGraph XML. You do not need to read all of it — the meaning is
   in the box labels and the arrows between them:
   ```bash
   # boxes and edge labels
   grep -o 'value="[^"]*"' docs/confluence/attachments/<name>.drawio
   # arrows: which box leads to which
   grep -o '<mxCell[^>]*edge="1"[^>]*>' docs/confluence/attachments/<name>.drawio
   ```
   An arrow's own `value` is the CONDITION on that branch ("Từ 2 DN", "Chưa có
   DN"), and a box with several outgoing labelled arrows is a decision point.
   Those conditions are exactly the branches a journey must not flatten away.

   The rendered PNGs beside it (`<name>-p1.png`, …) are the same diagram for a
   human to look at — the `.drawio` is the one to read.

   **Transcribe the branches into the journey.** A box with several labelled
   arrows leaving it is a decision: give that stage `stage_type: "decision"` and
   list every outgoing branch in its `next[]`, with the arrow's label as the
   `condition` (see `references/schema.md`). Three documented outcomes must not
   collapse into one happy path — that flattening is exactly how a journey ends
   up describing a flow the product does not have, and the Flow tab draws
   `next[]`, so a flattened journey shows as a straight line that is visibly
   wrong.

**System map — `./docs/system-map.json` (when present).** The upstream `docs-map`
stage classified every document by the APP it describes and recorded where flows
HAND OFF between apps. Read it first:

- `documents[]` tells you which files are yours. A file listing your app in its
  `apps` is in scope; one that lists only another app is not — even if it reads
  well.
- `handoffs[]` is what stops your journey from describing a closed world. Where
  a flow leaves your app ("hồ sơ chờ backoffice duyệt"), model the hand-off as a
  stage from YOUR actor's point of view — what they submit, what they wait for,
  what comes back — and stop there. Do NOT invent the other app's internals, and
  do NOT quietly end the journey as if the flow finished.
- `apps[]` includes systems this project does not build (an identity provider, a
  core service). Those are touchpoints, never actors of your journey.

The file is hand-editable, so treat it as decided: do not re-derive a
classification you disagree with — flag it in the stage's `sources[]`.

**One audience per run (multi-target projects).** When the kickoff names an
audience — END CUSTOMER or BACKOFFICE — the docs folder you are reading is
SHARED with the other targets: it holds material for all of them. Build journeys
ONLY for your audience and leave the rest alone. A backoffice run has internal
operators as its actor (approve, configure, reconcile, audit); an end-customer
run never does. A doc section that plainly belongs to the other audience is not
yours to model, however well written it is. No audience named → single build,
cover the docs as a whole.

**Docs are the source of truth.** When your reading of the prose and the diagram
disagree, say so in the stage's `sources[]` rather than picking one silently —
an invented step is worse than a flagged contradiction.

Whichever input you use, you MUST capture the **key source text** for each stage
in its `sources[]` (next section) — short verbatim excerpts from the MD that
justify that stage. This is what the Customer Journey preview surfaces.

### 1. Generate the JSON
Author a journey file following `references/schema.md`. Key rules:
- One or more **journeys** (USER_FLOW). Each has an `actor_id`, a `goal`, and an
  ordered list of **stages** (STAGE) nested inside it.
- Each stage carries `emotion` (frustrated/anxious/neutral/satisfied/delighted),
  `user_actions`, `system_responses`, `touchpoints`, `pain_points` — this drives
  the emotion curve + pain markers on the customer-journey view.
- **Each stage MUST carry `sources[]`** — the key source-text excerpts that
  justify it: `{ "file": "docs/confluence/<slug>.md", "heading": "<section>",
  "quote": "<short verbatim snippet from that MD>" }`. Keep quotes short (1–3
  sentences), copied VERBATIM (do not paraphrase). **`file` MUST be the exact
  SLUGIFIED path of the file you actually read on disk** (kebab-cased, deaccented
  — e.g. `docs/confluence/Hoan-tien-don-hang.md`), NOT the human page title with
  spaces/diacritics — otherwise the preview's "Mở tài liệu nguồn" can't find it.
  1–3 sources per stage is ideal.
- Optional **personas** (UX_PERSONA_PROFILE) — shared UX context / actor filter.
- Use stable, human-readable ids (`UFLW-…`, `STG-…`, `PRSN-…`).

Write the file under the feature's cwd (e.g. `./<feature>-customer-journey.json`).
See `assets/example-customer-journey.json` for a complete, valid example.

> **Per-module fan-out.** When the docs are a multi-section tree (a sub-tree
> scan), the daemon runs this skill ONCE PER top-level module and your kickoff
> names the module + its pages and tells you to write your slice to
> `cj/<module-key>/journey.json` instead of the root file. In that case: cover
> ONLY your module's pages, write ONLY that slice (personas + journeys for this
> module), and do NOT write the root `-customer-journey.json` — the daemon
> merges every module's slice (unions personas, concatenates journeys) into the
> canonical file. Follow the kickoff's output path verbatim when it gives one.

## Hard rules
- **File-only.** Produce the JSON file(s) ONLY. Do NOT push anything anywhere
  (no `od kg push`, no KGS) — the pipeline reads the file on disk directly.
- **`sources[].file` must match the on-disk slug**, copied verbatim from the file
  you read (see §1) — this is the single most common cause of a broken "Mở tài
  liệu nguồn".
- **Stages are NESTED inside their journey's `stages[]`** — there is no flat
  `user_flow_id` link and no graph edge.
- Keep quotes VERBATIM (never paraphrase) so the highlight locates them in the doc.
- **Never invent a step the docs do not show.** Every stage must trace to prose
  or to a flow diagram (§0.3). A journey that reads well but describes a flow
  the documents never specified is the failure this stage exists to avoid —
  every downstream stage builds on it.
