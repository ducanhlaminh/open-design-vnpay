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
