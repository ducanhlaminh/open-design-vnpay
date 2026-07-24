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

### 0. Read the inputs (docs + the customer journey)
The docs→UI workflow is `docs → cj → ux`: there is NO feature-analysis step and
NO `./features/` folder — do not look for one. Your inputs are:

**Docs (primary input):** the ingested Markdown under `./docs/` (e.g.
`./docs/confluence/**/*.md`, `./docs/jira/**/*.md`). Read these to understand the
domain and derive the screens — each doc section that needs a UI becomes a
screen. Only when no docs are present at all, take the screens from the user's
request.

**Context pages — `./docs/context/` (do NOT build from these):** link-followed
background pages. Read for domain understanding only; NEVER turn them into
screens. Every screen must come from `./docs/confluence/` (or `./docs/jira/`) —
never from `./docs/context/`.

**Customer journey (primary input, produced by the upstream `cj` stage):** the
journey file on disk — `./*-customer-journey.json` / `./*-cj.json` or under
`./customer-journey/`. Read it and let it shape the screens: every USER_FLOW
**STAGE** should be served by at least one screen, the screen ordering should
follow the journey, and each screen's spec should support that stage's intent /
pain points. Keep traceability (a screen serves a journey stage). If, unusually,
no journey file is present, derive the screens from the docs alone — do not block
or fabricate a journey.

### 0b. Target platform → every screen's `layout`
The kickoff message may name a **target platform** for this run:
- **WEBSITE** (`platform: web`) → set `layout: "web"` on EVERY screen, and spec
  web-appropriate patterns: data **tables** instead of card lists where the
  content is tabular, **sidebar or top navigation** instead of bottom tab bars,
  wider **multi-column forms**, hover-revealed row actions.
- **MOBILE** (`platform: mobile`) → set `layout: "mobile"` on every screen, with
  mobile patterns (bottom action bars, single-column forms, list rows).
- **No platform named** → default to `layout: "mobile"` (the legacy behavior —
  do not guess web from the docs' content).

Downstream UI-Spec stages (`ui-html`, `ui-react`) read each screen's `layout`
and render it as a phone screen or a full web page — so the value you set here
decides what the user ultimately gets.

### 0b0. System map — `./docs/system-map.json` (when present)
The `docs-map` stage classified each document by the app it describes and
recorded where flows hand off between apps. It decides your SCOPE:

- Spec screens only from documents whose `apps` include the app you are building.
- `handoffs[]` marks the seams. A flow leaving your app needs the screen that
  hands it off (a submitted state, a "chờ duyệt" state) and the screen that
  receives the result — but never the other app's own screens.
- `apps[]` with `"external": true` (an identity provider, a partner service) are
  touchpoints: spec the screen that launches or returns from them, not the
  external screens themselves.

Hand-edited by design — take its classification as decided. Absent → work from
the docs as a whole.

### 0b1. Audience (multi-target runs)
The kickoff may name an AUDIENCE alongside the platform — END CUSTOMER or
BACKOFFICE. Two web targets share the same `layout: "web"` AND the same docs
folder, so the audience is the only thing that separates them: spec ONLY the
screens the docs describe for your audience.

- **BACKOFFICE**: internal operators/admins. Dense tables over card lists, bulk
  actions, filters and saved views, audit trail / permission affordances,
  multi-column forms. Never spec end-customer marketing or onboarding screens.
- **END CUSTOMER**: the public-facing product. Never spec internal
  configuration, approval queues, or admin-only tooling.

A doc section belonging to the other audience is not yours to build. No audience
named → single build; cover the docs as a whole.

### 0b2. Read the UX Research criteria (produced by the upstream `ux-research` stage)
The docs→UI workflow runs `ux-research` BEFORE this stage; its report is at
`./ux-research/report.json` (criteria: id, statement, priority, applies_to —
journey stage/flow names, sources). Read it and author AGAINST it:

- Every `must` criterion MUST be satisfiable by the screens you design — when a
  criterion names a flow, the screens serving that flow must carry the
  components/affordances it demands (e.g. inline-validation implies per-field
  error affordances in the spec).
- Cite the criterion id in the screen's `screen_intent` rationale when it drove
  a design choice (same style as citing a Mobbin reference).
- `should`/`nice` criteria: apply when they don't conflict with docs/journey;
  conflicts resolve in favor of the docs (they are the requirements).

If the report is absent (stage skipped on this machine), continue without it —
do not block.

### 0c. Gather real-world references from Mobbin (when the `mobbin` MCP is available)
If the run exposes Mobbin MCP tools (server id `mobbin`), use them BEFORE
authoring screens — this is how the spec inherits real-market patterns instead
of guessed ones:

1. From the docs/journey, identify the app's **domain** (banking, e-commerce,
   healthcare, …) and the 3-5 **key flows** (e.g. onboarding/KYC, transfer,
   checkout).
2. Search Mobbin for each key flow scoped to that domain and the target
   platform from 0b (mobile/web). Prefer flow/screen searches over generic
   app browsing.
3. Save what you use into `./ux-refs/mobbin/` — downloaded screen images as
   `<flow>-<app>-<nn>.png` plus ONE `notes.md` summarising, per flow: the
   screen sequence observed, recurring components, and any pattern you adopted
   or deliberately rejected (with reason).
4. Let the references shape the SCREEN INVENTORY and per-screen components
   (step 1), and cite them in each screen's `screen_intent` rationale when a
   pattern came from a reference.

Rules: `./ux-refs/` is **reference material only** — it is NOT a stage output,
never push it to KGS and never list it in the spec. Cap the effort (≤ ~15
images total, one search pass per flow — no exhaustive crawling). If the
`mobbin` tools are absent or every call errors (auth/plan), skip this step
silently and continue — the stage must produce the same outputs without it.

### 1. Generate the JSON (content only — no project_id)
Author a UX Spec file following `references/schema.md`. **Do NOT put a
`project_id` in the file** — you are authoring CONTENT only. The target KGS
project is chosen at PUSH time (conversation binding / Push to KG dropdown /
`--project-id`), so a `project_id` invented here would be ignored. Key rules:
- One or more **screens** (S_SCREEN_SPEC). Each has `screen_type`,
  `screen_intent`, `primary_actor`, `layout` (see 0b), and an ordered list of
  **components** (DP_UI_COMPONENT) — the inputs/buttons/lists that render the
  box-text mockup.
- **Navigation is EXPLICIT and required**: every component that moves the user
  to another screen (button, link, list row opening a detail, …) MUST carry
  `navigates_to: "<screen-id>"` (+ `nav_type: "back"` for back/cancel/close
  actions). Viewers draw the flow diagram EXCLUSIVELY from these fields — no
  label-based guessing — so a navigating CTA without `navigates_to` shows no
  edge at all. Targets must be ids that exist in `screens`.
- Optional **personas** (UX_PERSONA_PROFILE) — shared UX context, drives the
  actor filter.
- Use stable, human-readable ids (`SCR-…`, `PRSN-…`). The same id re-pushed
  updates the same node.

Write the file under the project (e.g. `./<feature>-ux-spec.json`).
See `assets/example-ux-spec.json` for a complete, valid example.

> **Per-module fan-out.** When the docs are a multi-section tree, the daemon
> runs this skill ONCE PER top-level module and your kickoff names the module +
> its pages + tells you to write your slice to `ux/<module-key>/ux-spec.json`.
> In that case: author screens ONLY for your module, and **prefix EVERY screen
> id with `<module-key>__`** (the kickoff gives the exact prefix) so ids — and
> the `wireframes/<screen-id>.wire.json` files that name them — never collide
> across modules. Still write each screen's wireframe + each flow's flowchart
> into the SHARED `wireframes/` and `flows/` dirs. Do NOT write the root
> `-ux-spec.json` — the daemon merges every module's screens (and reconciles
> personas + cross-module navigation). Follow the kickoff's output path + id
> prefix verbatim.

### 1b. Author one wireframe per screen (layout tree, DSL v2)
For EVERY screen, also write `./wireframes/<SCREEN-ID>.wire.json` following
`references/wireframe.md`. Describe the screen as a **layout TREE** (`stack` /
`row` containers + component leaves) — like writing HTML/JSX structure, NOT pixel
coordinates. The host lays it out with flexbox so it never overlaps. Compose a
real screen (mobile → one vertical stack of full-width fields, sections, chips,
a primary CTA; web → nav + a row of sidebar + main), matching the archetype and
worked example in `references/wireframe.md`.

Two hard requirements:

- **`"dslVersion": 2`** and every leaf is `{ "c": "<slug>", "props": { … } }`,
  where `<slug>` comes from the CLOSED registry in
  **`references/wire-components.md`** (generated from `wire-registry.json`).
  Slugs are named after shadcn/ui because the `ui-react` terminal builds with
  exactly that set — the slug you pick IS the component it builds. Anything not
  in the registry is an error, not a free-text hint.
- **Validate before you finish** (zero errors is the bar). `<SKILL-ROOT>` is the
  `.od-skills/…` path in the preamble at the top of this skill — the script and
  its registry live there, your wireframes live in the working directory:
  ```bash
  node <SKILL-ROOT>/scripts/validate-wire.mjs ./wireframes --spec ./<feature>-ux-spec.json
  ```
  It catches unknown slugs, wrong prop types, missing required props, screens
  with no wireframe, wireframes with no screen, and web screens missing their
  `layouts.tablet` / `layouts.mobile` redesign.

The Wireframe view renders it, and it still exports to wiretext.app for hand-tweaks.

### 1c. Author one RULE FLOWCHART per user flow (`flows/<FLOW-ID>.flow.json`)
The wireframes are the SCREENS; the user flow is expressed as wireframes + a
**rule flowchart** (decision diamonds with Yes/No branches — like a classic
troubleshooting flowchart). For EVERY journey flow (each cj USER_FLOW that the
screens serve), write `./flows/<FLOW-ID>.flow.json`.

> **The documented diagram outranks your reconstruction.** When the docs embed a
> flow diagram, the ingest saved its SOURCE at
> `./docs/confluence/attachments/<name>.drawio` and marked it in the Markdown
> (`flow-diagram — nguồn sơ đồ …`). That diagram IS the specified flow: read it
> and TRANSCRIBE it. Do not redraw it from the prose, and do not drop a branch
> because the screens you designed have no home for it — a branch with nowhere
> to go is a missing screen, not a branch to delete.
>
> Read it without loading the whole XML (it is mostly geometry):
> ```bash
> grep -o 'value="[^"]*"' docs/confluence/attachments/<name>.drawio          # box + edge labels
> grep -o '<mxCell[^>]*edge="1"[^>]*>' docs/confluence/attachments/<name>.drawio  # arrows
> ```
> It maps onto this file almost one-to-one:
>
> | draw.io | `flow.json` |
> |---|---|
> | box with ≥2 outgoing labelled arrows | `{"kind": "decision"}` node |
> | the arrow's own label ("Từ 2 DN") | that edge's `label` — the CONDITION |
> | box naming a screen (`MH-DN-03`) | the matching `screens[].id` |
> | terminal box ("KẾT THÚC") | `{"kind": "end"}` node |
>
> No diagram for a flow → build it from the prose as before.

```jsonc
{
  "id": "FLOW-TRANSFER",           // stable id, FLOW-…
  "name": "Chuyển tiền nội bộ",
  "entry": "SCR-TRANSFER",          // the screen the flow starts on
  // nodes[] lists ONLY the non-screen nodes. Screens are implicit: any edge
  // endpoint that matches a spec screen id IS that screen (the viewer renders
  // its wireframe thumbnail as the node).
  "nodes": [
    { "id": "D-OTP",  "kind": "decision", "label": "OTP hợp lệ?" },
    { "id": "E-DONE", "kind": "end",      "label": "Giao dịch hoàn tất" }
  ],
  "edges": [
    { "from": "SCR-TRANSFER", "to": "D-OTP",      "label": "Xác nhận chuyển" },
    { "from": "D-OTP",        "to": "E-DONE",      "label": "Yes" },
    { "from": "D-OTP",        "to": "SCR-TRANSFER","label": "No — báo lỗi tại field" }
  ]
}
```

Rules:
- **Every screen referenced must exist in the spec** (`screens[].id`) — the
  flowchart joins wireframes by id, a dangling id renders as a hole.
- **Every decision node has ≥ 2 labeled outgoing edges** (Yes/No or the actual
  conditions). A decision with one branch is not a decision.
- **Edge labels leaving a SCREEN name the user ACTION** on that screen ("Xác
  nhận chuyển", "Bỏ qua") — the same wording the screen's component
  `navigates_to` action uses. Downstream `ui-react` reuses these labels 1:1 as
  `data-flow-action` values, which is what makes the built app's flow.json,
  the simulator, and the Playwright demo line up with this chart.
- Keep `navigates_to` on components authoritative for plain screen→screen
  navigation; the flow file ADDS the rule layer (conditions, ends) on top —
  don't contradict it.

### 2. Push to KGS
Two equivalent ways (both write via the KGS graph API → projected to Neo4j):

**a) open-design-vnpay button (recommended for users).** Open the generated JSON
file in the open-design-vnpay FileViewer. A **"Push to KG"** button appears with
a **project dropdown** (the list of SimStudio projects). Pick the target project
and click — no env/CLI needed (the daemon holds the KGS credentials).

**b) CLI / script.** Run the push script with the open-design app credentials
(`<SKILL-ROOT>` = the `.od-skills/…` path from the preamble above — the script
ships with this skill, it is NOT in your working directory):
```bash
KGS_URL=http://localhost:28001 \
KGS_API_KEY=<open-design app key> \
KGS_APP_ID=open-design-app \
python3 <SKILL-ROOT>/scripts/push_to_kgs.py <your-ux-spec>.json --project-id <project_id>
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
- **Docs are the source of truth; a flow diagram is the flow.** Where the ingest
  saved a `.drawio` (§1c), the flowchart transcribes it — screens exist to serve
  the documented flow, not the other way round. Inventing a branch the documents
  never specified, or silently dropping one they do, corrupts every stage built
  on this one.
- **Never put `project_id` in the file.** It is filled at push time (conversation
  binding / dropdown / `--project-id`) and applied to every node by the pusher.
  A `project_id` you invent here is ignored by the Push to KG button.
- **Components link to their screen by the `screen_id` PROP**, not a graph edge.
- **Push only via `scripts/push_to_kgs.py` / `od kg push` / the Push to KG
  button** (graph write API) — never edit KGS Postgres/Neo4j directly.
- Target the **open-design app** (UX producer), never the design-v3 app.
