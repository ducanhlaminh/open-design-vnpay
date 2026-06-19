# Customer Journey — JSON schema & KGS mapping

The agent writes a JSON document of this shape; `scripts/push_to_kgs.py` (or the
open-design-vnpay "Push to KG" button) turns it into KGS nodes in the
**open-design** app. Every node is tagged with `project_id`. Renders on
SimStudio's `/customer-journey` after Pull All.

> For per-screen UX specs (screens + components on `/ux-spec`) use the sibling
> `ux-spec` skill.

## Top-level
```jsonc
{
  // NO project_id — content only. The target project is filled at PUSH time
  // (conversation binding / Push to KG dropdown / --project-id) and applied to
  // every node. Do not invent a project_id here.
  "journeys":  [ Journey, ... ],   // the customer journeys (required to be useful)
  "personas":  [ Persona, ... ]    // optional — shared UX context / actor filter
}
```

## Journey  → KGS `USER_FLOW`  → SimStudio `journeys` table
```jsonc
{
  "id":         "UFLW-OWNER-REFUND",   // stable, unique. Re-push = update.
  "name":       "Hoàn tiền đơn hàng",  // shown as the journey title
  "actor_id":   "actor-owner",         // who performs it (drives actor filter)
  "journey_mode": "to_be",             // "to_be" | "as_is"
  "goal":       "…",                   // optional
  "flow_type":  "primary",             // "primary" | "alternative" | …
  "stages":     [ Stage, ... ]         // ordered steps
}
```
Mapped props: `id, name, title, actor (=actor_id), actor_id, journey_mode, goal, flow_type`.

## Stage  → KGS `STAGE`  → SimStudio `journey_steps` table
```jsonc
{
  "id":          "STG-REFUND-1",
  "name":        "Tìm đơn hàng cần hoàn",
  "order":       1,                    // 1-based position in the journey
  "stage_type":  "action",            // action | decision | confirmation | error | …
  "goal":        "…",
  "emotion":     "neutral",           // frustrated | anxious | neutral | satisfied | delighted
  "user_actions":     ["…"],          // what the user does
  "system_responses": ["…"],          // what the system does
  "touchpoints":      ["…"],          // screens / channels
  "pain_points":      ["…"],          // surfaced as pain markers
  "thoughts":         ["…"]           // optional inner monologue
}
```
- **Link to the journey is by the `user_flow_id` PROP** (the script sets it from
  the parent journey id) — NOT by a graph edge. This avoids KGS's edge-projection
  quirks and is exactly what SimStudio's node_mapper reads.
- `emotion` → numeric `emotion_score` (1..5) is added automatically so the
  customer-journey emotion curve renders.

## Persona  → KGS `UX_PERSONA_PROFILE`  → SimStudio `ux_personas` table
```jsonc
{
  "id":   "PRSN-OWNER",        // optional — auto-generated if omitted
  "name": "Chủ cửa hàng",
  "tech_savviness": "medium",  // any extra fields are stored as props
  "device_primary": "mobile",
  "market": "VN",
  "prefers_guidance": true,
  "error_tolerance": "low"
}
```
Required: `name`. Everything else is optional metadata.

## Why these exact labels/props
`preview-content/internal/sync/node_mapper.go` maps KGS labels → SimStudio tables.
It reads the props above; mismatched keys are dropped. The contract:

| label | table | key props read |
|---|---|---|
| `USER_FLOW` | `journeys` | id, name, actor_id (accepts `actor`), goal, flow_type, project_id |
| `STAGE` | `journey_steps` | id, flow_id (accepts `user_flow_id`), name, order, project_id |
| `UX_PERSONA_PROFILE` | `ux_personas` | id, name, project_id |

`project_id` is what `/sync/pull` filters on (`pid == projectID`), so a journey
pushed with `project_id=xpos` only ever shows up in project xpos.

## Pipeline recap
```
this JSON  → push_to_kgs.py / od kg push / "Push to KG" button (POST /v1/graph/nodes, project_id)
           → KGS open-design app (Postgres write model)
           → KGS outbox → Neo4j projection
SimStudio "Pull All" → /sync/pull → GetFullGraph(open-design) reads Neo4j
           → node_mapper → demo_db.journeys / journey_steps / ux_personas
           → /customer-journey  (filtered by project_id)
```
