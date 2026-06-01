# UI-domain label reference

Captured from a snapshot of the live KGS. The graph evolves — if a
property listed here is missing on a node you fetched, fall back to
whatever `kg_get_node` actually returned.

## UI_THEME_COMPOSITION

Top-level brand container. Has `USES_THEME` edges out to its theme
layers, with an `order` property on each edge for stacking order.

Notable props:
- `name` — human-readable composition name
- `isActive` — boolean, the "current" composition per workspace
- `workspaceId` — partition key

Workflow: prefer `kg_get_theme_composition(composition_id)` to fetching
manually — that one tool walks the whole subtree for you.

## UI_THEME

A single layer (one of: spacing, typography, colors, borders, …).

Notable props:
- `name` — display name
- `slug` — url-safe handle
- `kind` — `color | spacing | typography | radius | shadow | …`

## UI_TOKEN

Token definition (the *role* — separate from per-theme value).

Notable props:
- `name`
- `targetPath` — canonical token name (e.g. `primary.500`, `border-strong`)

## UI_TOKEN_VALUE

Concrete value of a token in one theme. Several `UI_TOKEN_VALUE` rows
with the same `displayName` are normal (one per theme).

Notable props:
- `rawValue` — `"oklch(0.708 0 0 / 0.72)"`, `"16px"`, `"600"`, …
- `targetPath` — canonical token name
- `targetType` — `slot | color | spacing | typography | …`
- `themeId` — back-pointer to UI_THEME (not always followed via edge)
- `layerId` — back-pointer to layer
- `status` — `published | draft | …`
- `source` — `seed | figma | user | …`
- `authored` — boolean
- `blendable` — boolean

## UI_COMPONENT

A component definition in the shared catalog.

Notable props:
- `displayName` — e.g. `Button`, `FieldError`
- `baseClasses` — Tailwind base classes
- `category` — `form | display | navigation | …`
- `catalogRole` — `primitive | composite | layout`
- `controlSizingJson` — per-size dimensions (`sm`, `md`, `lg`)
- `bridgeJson` — handoff data for code generation

## UI_COMPONENT_SLOT

A styleable part of a component (part × state × property).

Notable props:
- `componentId` — parent UI_COMPONENT id
- `part` — `root | label | icon | item | …`
- `property` — `backgroundColor | borderWidth | textColor | …`
- `state` — `default | hover | focus | disabled | …`
- `required` — boolean

A `UI_COMPONENT` typically has dozens of slots; expanding via
`kg_neighbors depth=1 direction=OUTGOING` returns them all.

## UI_SCREEN_INSTANCE

A rendered DOM-like node on a project screen.

Notable props:
- `componentSlug` — `span`, `button`, `Card`, …
- `props` — JSON string of element props (className, style, …)
- `text` — text content if any
- `order` — position among siblings
- ids look like `xpos-m04-m4-v` (project prefix + module + variant)

## FIGMA_VARIABLE

A Figma variable mirrored into the graph.

Notable props:
- `collectionName` — Figma collection grouping
- `collectionSlug` — slug form
- `displayName` — `Control/control-h-default`, etc.
- `payloadJson` — original Figma payload

## FIGMA_STYLE

A Figma style mirrored into the graph.

Notable props:
- Same shape as FIGMA_VARIABLE plus style-specific fields in payloadJson
- `displayName` example: `Surface/card-elevated Stroke`
