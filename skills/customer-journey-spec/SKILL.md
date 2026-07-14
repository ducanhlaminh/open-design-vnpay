---
name: customer-journey-spec
description: |
  Generate a Customer Journey map (as a JSON file) for an EXISTING SimStudio
  project, then push it into the Knowledge Graph (KGS open-design app) so it can
  be pulled back and viewed on SimStudio's /customer-journey screen. open-design
  is the UX PRODUCER: this skill authors USER_FLOW (to-be customer journeys),
  STAGE (journey steps with emotion + pain points), and optionally
  UX_PERSONA_PROFILE, scoped to a project_id. Activate when the user asks to
  "design a customer journey", "tạo customer journey", "user flow", "to-be
  journey", "journey map", or to push journey data into KGS / SimStudio for a
  given project. For per-screen UX specs (S_SCREEN_SPEC + components on /ux-spec)
  use the sibling `ux-spec` skill instead.
triggers:
  - "customer journey"
  - "customer journey map"
  - "user journey"
  - "user flow"
  - "to-be journey"
  - "journey map"
  - "push journey to kgs"
  - "tạo customer journey"
od:
  mode: utility
  category: ux-research
---

# customer-journey-spec — author Customer Journey → KGS → SimStudio

open-design is the **UX producer** in a 3-app Knowledge Graph:
- **design-v3 app** — UI (screens / components / themes).
- **open-design app** — UX (this skill writes here): journeys, stages, personas.
- **vnp-platform / SimStudio** — the consumer that pulls and renders.

This skill produces a JSON file of Customer Journeys and pushes it to the
open-design KGS app. SimStudio's **Pull All** then materialises it and shows it
on `/customer-journey`, scoped to the project.

> Sibling skill: `ux-spec` authors the per-screen UX Spec (S_SCREEN_SPEC +
> DP_UI_COMPONENT) for `/ux-spec`. Use that one for screen specs; use this one
> for journey maps. A persona can appear in either.

## When to use
- The user wants to design / generate a customer journey to appear in
  SimStudio's `/customer-journey`.

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

Whichever input you use, you MUST capture the **key source text** for each stage
in its `sources[]` (next section) — short verbatim excerpts from the MD that
justify that stage. This is what the Customer Journey preview surfaces.

### 1. Generate the JSON (content only — no project_id)
Author a journey file following `references/schema.md`. **Do NOT put a
`project_id` in the file** — you are authoring CONTENT only. The target KGS
project is chosen at PUSH time (from the conversation's bound project, the
Push to KG dropdown, or `--project-id`), so inventing a `project_id` here would
be ignored at best and misleading at worst. Key rules:
- One or more **journeys** (USER_FLOW). Each has an `actor_id`, a `goal`, and an
  ordered list of **stages** (STAGE).
- Each stage carries `emotion` (frustrated/anxious/neutral/satisfied/delighted),
  `user_actions`, `system_responses`, `touchpoints`, `pain_points` — this drives
  the emotion curve + pain markers on SimStudio's customer-journey view.
- **Each stage MUST carry `sources[]`** — the key source-text excerpts that
  justify it: `{ "file": "docs/confluence/<name>.md", "heading": "<section>",
  "quote": "<short verbatim snippet from that MD>" }`. Keep quotes short (1–3
  sentences), copied VERBATIM from the doc (do not paraphrase), and reference the
  cwd-relative `file`. 1–3 sources per stage is ideal; this powers the preview's
  "key text from MD" panel and keeps every stage traceable to its doc.
- Optional **personas** (UX_PERSONA_PROFILE) — shared UX context / actor filter.
- Use stable, human-readable ids (`UFLW-…`, `STG-…`, `PRSN-…`). The same id
  re-pushed updates the same node.

Write the file under the project (e.g. `./<feature>-customer-journey.json`).
See `assets/example-customer-journey.json` for a complete, valid example.

### 2. Push to KGS
Two equivalent ways (both write via the KGS graph API → projected to Neo4j):

**a) open-design-vnpay button (recommended for users).** Open the generated JSON
file in the open-design-vnpay FileViewer. A **"Push to KG"** button appears with
a **project dropdown** (the list of SimStudio projects). Pick the target project
and click — no env/CLI needed (the daemon holds the KGS credentials).

**b) CLI / script.** Run the push script with the open-design app credentials:
```bash
KGS_URL=http://localhost:28001 \
KGS_API_KEY=<open-design app key> \
KGS_APP_ID=open-design-app \
python3 scripts/push_to_kgs.py <your-journey>.json --project-id <project_id>
# or, against a running daemon:  od kg push <your-journey>.json --project-id <project_id>
# list targets:                  od kg projects
```
- Use `--dry-run` first to preview what will be written.
- Writes via the KGS **graph write API** (`POST /v1/graph/nodes`), NOT a DB
  insert — required so KGS projects the nodes to Neo4j, which is what SimStudio's
  pull reads. Do NOT insert into Postgres/Neo4j directly.
- 409 (already exists) is fine — re-pushing is idempotent per id.

### 3. View in SimStudio
Tell the user: open SimStudio → select the project → click **Pull All** in the
header → open `/customer-journey`. The new journeys appear, filtered to that
project.

## Mapping (why labels/props matter)
SimStudio's `preview-content` maps KGS labels to its DB; keep these exact:
| KGS label | → SimStudio | required props |
|---|---|---|
| `USER_FLOW` | journeys | `id, name, actor(=actor_id), project_id` |
| `STAGE` | journey_steps | `id, user_flow_id, order, name, project_id` |
| `UX_PERSONA_PROFILE` | ux_personas | `id, name, project_id` |

Full field reference: `references/schema.md`.

## Hard rules
- **Never put `project_id` in the file.** It is filled at push time (conversation
  binding / dropdown / `--project-id`) and applied to every node by the pusher.
  A `project_id` you invent here is ignored by the Push to KG button and only
  causes confusion.
- **Stages link to the journey by the `user_flow_id` PROP**, not a graph edge.
- **Push only via `scripts/push_to_kgs.py` / `od kg push` / the Push to KG
  button** (graph write API) — never edit KGS Postgres/Neo4j directly (the node
  would not be projected → invisible to Pull All).
- Target the **open-design app** (UX producer), never the design-v3 app.
