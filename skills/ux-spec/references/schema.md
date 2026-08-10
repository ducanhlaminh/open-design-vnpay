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
  "screen_type":   "list",                     // list | form | detail | confirmation | dialog | drawer | sheet | …
  "screen_intent": "Tìm và chọn đơn để hoàn",  // shown on the UX Spec header
  "layout":        "mobile",                   // "mobile" | "web" — this screen's target platform
  "responsive_notes": "…",                     // web screens only: desktop→mobile adaptation contract (see SKILL 0b)
                                               //   (from the run's platform choice, see SKILL.md 0b;
                                               //   no choice → "mobile"). ui-html/ui-react render per this.
  "primary_actor": "actor-owner",              // accepts "actor_id" as an alias
  "permissions":   ["owner"],
  "navigation_group": "Refund",
  // OVERLAY screens only (a dialog / slide-in drawer / bottom sheet shown ON TOP
  // of a base screen, not a full page). Omit both for a normal full screen.
  "overlay_kind":  "dialog",                   // "dialog" | "drawer" | "sheet" — how it layers
  "overlay_of":    "SCR-REFUND-LIST",          // id of the base screen it overlays; null for a GLOBAL
                                               //   overlay (e.g. the app nav drawer, shared by all screens)
  "components": [ Component, ... ]             // drive the box-text mockup
}
```
Mapped props read by node_mapper: `id, title(=name), screen_type, layout,
primary_actor(=actor_id), permissions[], navigation_group, overlay_kind,
overlay_of, project_id`.

The wireframe of an overlay screen must MIRROR these: set `overlay` +
`data-overlay-of` in its `.html` (see `references/wireframe.md`) so the preview
frames it as that layer over the dimmed base screen.

## Component  → KGS `DP_UI_COMPONENT`  → SimStudio `ui_components` table
```jsonc
{
  "id":             "SCR-REFUND-LIST-search",  // optional — auto-generated as <screen>-c<N>
  "component_type": "input",                   // input | button | list | select | text | …
  "label":          "Tìm theo mã đơn / SĐT",
  "order":          1,
  "required":       false,
  "data_type":      "string",
  "semantic_type":  "search",
  // NAVIGATION (REQUIRED on every component that moves the user to another
  // screen — buttons, links, list rows that open a detail, …). This is the
  // ONLY source of the flow diagram: viewers draw edges EXCLUSIVELY from
  // `navigates_to` and never guess from labels, so a navigating CTA without
  // it simply renders no edge.
  "navigates_to":   "SCR-REFUND-DETAIL",       // id of the destination screen (must exist in `screens`)
  "nav_type":       "navigate"                 // "navigate" (default, solid arrow) | "back" (dashed return
                                               //   edge — back/cancel/close actions)
}
```
- `component_type` is the **KGS / SimStudio** vocabulary (it lands in
  `DP_UI_COMPONENT.component_type` and drives the `/ux-spec` box-text mockup) —
  it is NOT the wireframe leaf slug. The same control appears twice, once per
  vocabulary: `component_type: "input"` here, `c: "shadcn:Input"` in the
  `.html`. Keep the two consistent in MEANING (same control, same label,
  same order); do not put a `shadcn:*` slug in `component_type`.
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
