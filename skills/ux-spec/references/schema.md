# UX Spec — JSON schema & KGS mapping

The agent writes a JSON document of this shape; `scripts/push_to_kgs.py` (or the
open-design-vnpay "Push to KG" button) turns it into KGS nodes in the
**open-design** app. Every node is tagged with `project_id`. Renders on
SimStudio's `/ux-spec` after Pull All.

## Top-level
```jsonc
{
  // NO project_id — content only. The target project is filled at PUSH time
  // (conversation binding / Push to KG dropdown / --project-id) and applied to
  // every node. Do not invent a project_id here.
  "screens":   [ Screen,  ... ],   // UX Spec screens (required to be useful)
  "personas":  [ Persona, ... ]    // optional — shared UX context / actor filter
}
```

## Screen  → KGS `S_SCREEN_SPEC`  → SimStudio `screens` table
```jsonc
{
  "id":            "SCR-REFUND-LIST",
  "name":          "Danh sách đơn cần hoàn",   // → screens.name
  "screen_type":   "list",                     // list | form | detail | confirmation | …
  "screen_intent": "Tìm và chọn đơn để hoàn",  // shown on the UX Spec header
  "layout":        "mobile",
  "primary_actor": "actor-owner",              // accepts "actor_id" as an alias
  "permissions":   ["owner"],
  "navigation_group": "Refund",
  "components": [ Component, ... ]             // drive the box-text mockup
}
```
Mapped props read by node_mapper: `id, title(=name), screen_type, layout,
primary_actor(=actor_id), permissions[], navigation_group, project_id`.

## Component  → KGS `DP_UI_COMPONENT`  → SimStudio `ui_components` table
```jsonc
{
  "id":             "SCR-REFUND-LIST-search",  // optional — auto-generated as <screen>-c<N>
  "component_type": "input",                   // input | button | list | select | text | …
  "label":          "Tìm theo mã đơn / SĐT",
  "order":          1,
  "required":       false,
  "data_type":      "string",
  "semantic_type":  "search"
}
```
- The component links to its screen by the **`screen_id` PROP** (the script sets
  it from the parent screen id) — NOT a graph edge.
- Components render the per-screen box-text mockup on `/ux-spec`. A screen with
  no components still lists, just with an empty mockup body.
- Any extra fields (field_binding, validation_rules, enum_values, tooltip, …)
  are passed through as props; node_mapper reads the ones it knows.

## Persona  → KGS `UX_PERSONA_PROFILE`  → SimStudio `ux_personas` table
```jsonc
{
  "id":   "PRSN-OWNER",        // optional — auto-generated if omitted
  "name": "Chủ cửa hàng",
  "tech_savviness": "medium",  // any extra fields are stored as props
  "device_primary": "mobile",
  "market": "VN"
}
```
Required: `name`. Everything else is optional metadata.

## Why these exact labels/props
`preview-content/internal/sync/node_mapper.go` maps KGS labels → SimStudio
tables. It reads the props below; mismatched keys are dropped. The contract:

| label | table | key props read |
|---|---|---|
| `S_SCREEN_SPEC` | `screens` | id, title(=name), screen_type, layout, primary_actor(=actor_id), permissions[], navigation_group, project_id |
| `DP_UI_COMPONENT` | `ui_components` | id, screen_id, component_type, label, order, required, data_type, semantic_type, project_id |
| `UX_PERSONA_PROFILE` | `ux_personas` | id, name, project_id |

`project_id` is what `/sync/pull` filters on (`pid == projectID`), so a screen
pushed with `project_id=xpos` only ever shows up in project xpos.

## Pipeline recap
```
this JSON  → push_to_kgs.py / od kg push / "Push to KG" button (POST /v1/graph/nodes, project_id)
           → KGS open-design app (Postgres write model)
           → KGS outbox → Neo4j projection
SimStudio "Pull All" → /sync/pull → GetFullGraph(open-design) reads Neo4j
           → node_mapper → demo_db.screens / ui_components / ux_personas
           → /ux-spec  (filtered by project_id, box-text from components)
```
