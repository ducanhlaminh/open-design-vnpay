---
name: ux-spec
description: |
  Generate a UX Spec (the per-screen box-text mockup data) as a JSON file for an
  EXISTING SimStudio project, then push it into the Knowledge Graph (KGS
  open-design app) so it can be pulled back and viewed on SimStudio's /ux-spec
  screen. open-design is the UX PRODUCER: this skill authors S_SCREEN_SPEC
  (screens with type/intent/actor), DP_UI_COMPONENT (the fields/buttons on each
  screen), and optionally UX_PERSONA_PROFILE, scoped to a project_id. Activate
  when the user asks to "design a UX spec", "tạo UX spec", "spec màn hình",
  "screen spec", "wireframe spec", or to push UX screen specs into KGS /
  SimStudio for a given project. For customer-journey maps (USER_FLOW + STAGE
  emotion curves) use the sibling `customer-journey-spec` skill instead.
triggers:
  - "ux spec"
  - "ux specification"
  - "screen spec"
  - "screen specification"
  - "wireframe spec"
  - "màn hình spec"
  - "spec màn"
  - "tạo ux spec"
  - "push ux spec to kgs"
od:
  mode: utility
  category: ux-research
---

# ux-spec — author UX Spec screens → KGS → SimStudio

open-design is the **UX producer** in a 3-app Knowledge Graph:
- **design-v3 app** — UI (full screens / components / themes).
- **open-design app** — UX (this skill writes here): screens specs, components,
  personas.
- **vnp-platform / SimStudio** — the consumer that pulls and renders.

This skill produces a JSON file of UX Spec **screens** (+ their components) and
pushes it to the open-design KGS app. SimStudio's **Pull All** then materialises
it and shows it on `/ux-spec`, scoped to the project.

> Sibling skill: `customer-journey-spec` authors the Customer Journey
> (USER_FLOW + STAGE emotion curves) for `/customer-journey`. Use that one for
> journeys; use this one for screen specs. A persona can appear in either.

## When to use
- The user wants to design / generate a UX Spec (screen-by-screen) to appear in
  SimStudio's `/ux-spec`.

## Workflow (do these in order)

### 0. Read the inputs (features, plus the customer journey when present)
**Features (primary input, from the `feature-analysis` pipeline, P2):** If
`./features/_index.json` exists (the docs→UI pipeline produced it), that is your
input: read the manifest, then each `./features/<Feature Name>.md`. Use each
feature's frontmatter — `actors` → the screen's `primary_actor`,
`suggested_screens` → the screens to spec, plus the user stories / acceptance
criteria in the body — to author the S_SCREEN_SPEC screens. Keep traceability
(a screen comes from a feature). If there is no `./features/` folder (ad-hoc use),
take the screens from the user's request instead.

**Customer journey (additional input, when it already exists):** If a customer
journey produced by the `customer-journey-spec` pipeline is present on disk —
`./*-customer-journey.json` / `./*-cj.json` or under `./customer-journey/` —
read it too and let it shape the screens: every USER_FLOW **STAGE** should be
served by at least one screen, the screen ordering should follow the journey, and
each screen's spec should support that stage's intent / pain points. Keep the
traceability both ways (a screen comes from a feature **and** serves a journey
stage). If no journey file is present (e.g. when this pipeline runs in parallel
with Customer Journey and that one hasn't finished yet), just proceed with the
features — do not block or fabricate a journey.

### 1. Generate the JSON (content only — no project_id)
Author a UX Spec file following `references/schema.md`. **Do NOT put a
`project_id` in the file** — you are authoring CONTENT only. The target KGS
project is chosen at PUSH time (conversation binding / Push to KG dropdown /
`--project-id`), so a `project_id` invented here would be ignored. Key rules:
- One or more **screens** (S_SCREEN_SPEC). Each has `screen_type`,
  `screen_intent`, `primary_actor`, and an ordered list of **components**
  (DP_UI_COMPONENT) — the inputs/buttons/lists that render the box-text mockup.
- Optional **personas** (UX_PERSONA_PROFILE) — shared UX context, drives the
  actor filter.
- Use stable, human-readable ids (`SCR-…`, `PRSN-…`). The same id re-pushed
  updates the same node.

Write the file under the project (e.g. `./<feature>-ux-spec.json`).
See `assets/example-ux-spec.json` for a complete, valid example.

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
python3 scripts/push_to_kgs.py <your-ux-spec>.json --project-id <project_id>
# or, against a running daemon:  od kg push <your-ux-spec>.json --project-id <project_id>
# list targets:                  od kg projects
```
- Use `--dry-run` first to preview what will be written.
- Writes via the KGS **graph write API** (`POST /v1/graph/nodes`), NOT a DB
  insert — required so KGS projects the nodes to Neo4j, which is what SimStudio's
  pull reads. Do NOT insert into Postgres/Neo4j directly.
- 409 (already exists) is fine — re-pushing is idempotent per id.

### 3. View in SimStudio
Tell the user: open SimStudio → select the project → click **Pull All** in the
header → open `/ux-spec`. The screens appear, filtered to that project, with the
per-screen box-text mockup built from the components.

## Mapping (why labels/props matter)
SimStudio's `preview-content` maps KGS labels to its DB; keep these exact:
| KGS label | → SimStudio | required props |
|---|---|---|
| `S_SCREEN_SPEC` | screens | `id, title(=name), screen_type, primary_actor, project_id` |
| `DP_UI_COMPONENT` | ui_components | `id, screen_id, component_type, label, project_id` |
| `UX_PERSONA_PROFILE` | ux_personas | `id, name, project_id` |

Full field reference: `references/schema.md`.

## Hard rules
- **Never put `project_id` in the file.** It is filled at push time (conversation
  binding / dropdown / `--project-id`) and applied to every node by the pusher.
  A `project_id` you invent here is ignored by the Push to KG button.
- **Components link to their screen by the `screen_id` PROP**, not a graph edge.
- **Push only via `scripts/push_to_kgs.py` / `od kg push` / the Push to KG
  button** (graph write API) — never edit KGS Postgres/Neo4j directly.
- Target the **open-design app** (UX producer), never the design-v3 app.
