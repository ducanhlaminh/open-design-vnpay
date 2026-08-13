# UX Spec — JSON schema

The agent writes a JSON document of this shape as a normal pipeline stage
output; the daemon syncs it to the shared media-service store like every
other docs-to-ui deliverable. Field names (`S_SCREEN_SPEC`-shaped screens,
`DP_UI_COMPONENT`-shaped components, `UX_PERSONA_PROFILE`-shaped personas) are
kept stable for compatibility with existing consumers of this schema.

## Top-level
```jsonc
{
  // NO project_id — content only. The file already lives inside this
  // project's own working directory; do not invent a project_id here.
  "screens":   [ Screen,  ... ],   // UX Spec screens (required to be useful)
  "personas":  [ Persona, ... ]    // optional — shared UX context / actor filter
}
```

## Screen  → `S_SCREEN_SPEC` shape
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
Fields read downstream: `id, title(=name), screen_type, layout,
primary_actor(=actor_id), permissions[], navigation_group, overlay_kind,
overlay_of`.

The wireframe of an overlay screen must MIRROR these: set `overlay` +
`data-overlay-of` in its `.html` (see `references/wireframe.md`) so the preview
frames it as that layer over the dimmed base screen.

## Component  → `DP_UI_COMPONENT` shape
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
- `component_type` is a fixed vocabulary (it drives the box-text mockup) — it
  is NOT the wireframe leaf slug. The same control appears twice, once per
  vocabulary: `component_type: "input"` here, `c: "shadcn:Input"` in the
  `.html`. Keep the two consistent in MEANING (same control, same label,
  same order); do not put a `shadcn:*` slug in `component_type`.
- The component links to its screen by the **`screen_id` PROP**, set from the
  parent screen id — NOT a graph edge.
- Components render the per-screen box-text mockup. A screen with no
  components still lists, just with an empty mockup body.
- Any extra fields (field_binding, validation_rules, enum_values, tooltip, …)
  are passed through as props for any downstream reader that wants them.

## Persona  → `UX_PERSONA_PROFILE` shape
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

## Why these exact field names
These field names (and the `S_SCREEN_SPEC` / `DP_UI_COMPONENT` /
`UX_PERSONA_PROFILE` shapes) are kept stable for compatibility with existing
consumers of this schema; mismatched keys are simply dropped by any reader
that doesn't recognize them. The contract:

| shape | key fields read |
|---|---|
| `S_SCREEN_SPEC` | id, title(=name), screen_type, layout, primary_actor(=actor_id), permissions[], navigation_group |
| `DP_UI_COMPONENT` | id, screen_id, component_type, label, order, required, data_type, semantic_type |
| `UX_PERSONA_PROFILE` | id, name |

## Pipeline recap
```
this JSON → synced (media-service, alongside wireframes/ and flows/) →
            available on any device via the normal pull flow
```
