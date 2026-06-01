---
name: kgs-knowledge
description: |
  Operating manual for the in-house Knowledge Graph Service (KGS) exposed
  via the sm-mcp MCP server. Tells the agent which kg_* tool to reach for,
  the UI-domain taxonomy (UI_THEME_COMPOSITION, UI_THEME, UI_TOKEN_VALUE,
  UI_COMPONENT, FIGMA_VARIABLE, …), how workspaces partition the graph
  (ws-catalog-shadcn for the shared catalog vs ws-project-XPOS for a real
  project), and concrete workflow recipes (apply brand → fetch
  composition; rebuild a component → look up slots + tokens). Activate on
  any task involving brand spec, design tokens, themes, component
  catalog, or "the KG".
triggers:
  - "knowledge graph"
  - "kgs"
  - "kg search"
  - "design tokens"
  - "brand spec"
  - "theme composition"
  - "shadcn catalog"
  - "ui theme"
od:
  mode: utility
  category: design-systems
---

# KGS — Knowledge Graph operating manual

The Knowledge Graph (KGS) is the source of truth for design tokens,
themes, components, and screen instances. It is reachable only through
the `kg_*` MCP tools — never through curl, never through repo files.
Use it as your reference data layer the way a human designer would
consult a Figma library.

The graph is multi-domain. This manual covers the **UI domain**, which
is the only domain currently active.

---

## 0. Cold-start — when in doubt, call this first

`kg_describe(domain="UI")` returns a machine-readable copy of this
manual (labels + edges + workspaces + recipes + anti-patterns) straight
from the MCP server. It is **always cheap** (no upstream call) and
travels with the server, so even agents without this skill loaded can
self-orient.

Call it once at the start of a session if any of the following is true:
- The user mentioned KGS / knowledge graph and you have no other
  context loaded.
- You're unsure which `kg_*` tool to reach for next.
- It's been a while since you last interacted with KGS and the schema
  may have evolved.

After calling, dereference whichever `seedId` / label looks relevant
with `kg_get_node` or `kg_search` to confirm the graph still matches
the manual.

## 1. Tool decision tree

Always start here. Pick the cheapest tool that answers the question.

```
Cold start, no context, unsure where to begin?
  → kg_describe(domain="UI") then re-evaluate below

Need to find SOMETHING you don't have an id for?
  ├─ Natural language description?  → kg_search(query, limit)
  └─ Already know a label like "UI_THEME_COMPOSITION"?
       → kg_search(query="UI_THEME_COMPOSITION <hint>", limit=5)

Have an id, want EVERYTHING about that one node?
  → kg_get_node(node_id)

Have an id, want to see what it CONNECTS to?
  ├─ depth=1 just neighbors                 → kg_neighbors(node_id, depth=1)
  ├─ depth=2 to see neighbors-of-neighbors  → kg_neighbors(node_id, depth=2)
  └─ direction matters?
       ├─ "what uses me?"      → direction="INCOMING"
       ├─ "what do I use?"     → direction="OUTGOING"
       └─ both                 → direction="BOTH" (default)

Have a list of ids, want the INDUCED graph (only edges between THEM)?
  → kg_subgraph(node_ids=[id1, id2, id3, ...])

Have a UI_THEME_COMPOSITION id, want the FULL brand spec?
  → kg_get_theme_composition(composition_id)
  (Returns composition + ordered layers + every token — one call
   replaces ~10 manual hops.)
```

**Rule of thumb**: if you find yourself calling `kg_neighbors` three
times in a row to assemble a brand spec, you should have called
`kg_get_theme_composition` instead.

---

## 2. UI-domain label taxonomy

These are the node `label` values you will encounter in the UI domain.
See `references/labels.md` for property cheatsheets.

| Label                  | What it is                                         | Notable props                                   |
|------------------------|----------------------------------------------------|-------------------------------------------------|
| `UI_THEME_COMPOSITION` | A brand-ready stack of theme layers                | `name`, `isActive`, `workspaceId`               |
| `UI_THEME`             | One layer (spacing OR typography OR colors OR …)   | `name`, `slug`, `kind`                          |
| `UI_TOKEN`             | A token definition (parent of values)              | `name`, `targetPath`                            |
| `UI_TOKEN_VALUE`       | The concrete value of a token in a specific theme  | `rawValue`, `targetPath`, `targetType`, `themeId`, `layerId` |
| `UI_COMPONENT`         | A component definition (e.g. `Button`, `FieldError`) | `displayName`, `baseClasses`, `category`, `catalogRole`, `controlSizingJson` |
| `UI_COMPONENT_SLOT`    | A styleable slot inside a component                | `componentId`, `part`, `property`, `state`, `required` |
| `UI_SCREEN_INSTANCE`   | A rendered instance on a screen                    | `componentSlug`, `props`, `text`, `order`       |
| `FIGMA_VARIABLE`       | Mirror of a Figma variable                         | `collectionName`, `collectionSlug`, `displayName`, `payloadJson` |
| `FIGMA_STYLE`          | Mirror of a Figma style                            | `collectionName`, `displayName`, `payloadJson`  |

**Universal props** (on every node): `id`, `app_id`, `entity_type`,
`is_deleted`, `label`, `name`, `runId`, `tenant_id`, `version`,
`createdAt`, `updatedAt`, `workspaceId`.

---

## 3. Edge types

Known so far (the graph may have more — `kg_neighbors` will reveal them
when traversing):

| Edge          | From → To                                  | Notable props |
|---------------|--------------------------------------------|---------------|
| `USES_THEME`  | `UI_THEME_COMPOSITION` → `UI_THEME`        | `order` (layer stacking order) |
| (others)      | use `kg_neighbors` on a sample node to discover live |

When you see an unfamiliar edge type, follow it once — the relation
name (`USES_THEME`, etc.) is self-describing.

---

## 4. Workspaces — the partition key

Every node carries a `workspaceId`. The graph is multi-tenant; do not
mix data across workspaces unless the task explicitly says so.

| Workspace          | What lives there                                    |
|--------------------|-----------------------------------------------------|
| `ws-catalog-shadcn` | The shared shadcn component catalog (UI_COMPONENT + UI_COMPONENT_SLOT). Use as the reference catalog when generating component code. |
| `ws-project-XPOS`   | A real product project (UI_SCREEN_INSTANCE, project-specific token overrides). Use when the task is about THIS product. |

Multiple `UI_TOKEN_VALUE` rows with the same `displayName` are normal —
they live in different themes (different `themeId` / `layerId`) and
often different workspaces.

---

## 5. Workflow recipes

### Recipe A — Apply brand to a new artifact (most common)

```
1. kg_search query="UI_THEME_COMPOSITION active <brand-hint>" limit=5
   → list compositions; pick the one with isActive=true matching the brand
2. kg_get_theme_composition composition_id="<id>"
   → get the full brand spec in one call (composition + ordered layers + tokens)
3. Map tokens to CSS variables / Tailwind config / shadcn theme tokens
   - rawValue with targetType "color" / oklch() / hsl() / hex → color var
   - rawValue with targetType "spacing" → spacing scale
   - rawValue with targetType "typography" → font-family / font-size
4. Build the artifact (HTML / TSX) using ONLY values from step 3, never bias data
```

### Recipe B — "Which themes exist?"

```
1. kg_search query="UI_THEME spacing typography colors" limit=20
2. Group results by workspaceId → that's the set of theme stacks
3. For each interesting one, kg_get_node to read its kind/slug
```

### Recipe C — "What does component X look like in the shadcn catalog?"

```
1. kg_search query="UI_COMPONENT <name>" limit=5
   (e.g. "UI_COMPONENT Button" or "UI_COMPONENT FieldError")
2. kg_get_node component_id → read displayName, baseClasses, category, catalogRole
3. kg_neighbors node_id=<component_id> depth=1 direction="OUTGOING"
   → discover UI_COMPONENT_SLOTs (each is a styleable part × state × property)
4. For each slot, kg_neighbors to find the UI_TOKEN_VALUEs that style it
```

### Recipe D — "Show me everything connected to this token id"

```
1. kg_get_node node_id="<token_value_id>"
   → confirm it's UI_TOKEN_VALUE, read rawValue, targetPath, themeId
2. kg_neighbors node_id depth=2 direction="BOTH"
   → see which slot / component / theme consume this value
```

### Recipe E — "Map a Figma style/variable to a token"

```
1. kg_search query="FIGMA_VARIABLE <displayName-hint>" limit=10
2. kg_get_node figma_var_id → read payloadJson + collectionName
3. kg_neighbors figma_var_id depth=1 → look for an edge to UI_TOKEN_VALUE
```

### Recipe F — "Browse screens of project XPOS"

```
1. kg_search query="UI_SCREEN_INSTANCE xpos" limit=20
2. Group by name prefix (e.g. xpos-m10-*, xpos-m04-*) → screen modules
3. kg_neighbors any screen_id → discover the component slugs used
```

### Recipe G — "Cross-reference: which tokens does this composition's
layer 'spacing' actually emit?"

This is the long way of getting what `kg_get_theme_composition` returns
in one call. Prefer the shortcut. But for ad-hoc exploration:

```
1. kg_search "UI_THEME spacing" → pick a UI_THEME node_id (call it themeId)
2. kg_neighbors node_id=themeId depth=1 direction="OUTGOING"
3. Filter the returned nodes to label=UI_TOKEN_VALUE
4. Read rawValue + targetPath for each
```

---

## 6. Search query patterns

### Good queries (return useful hits)

- `"UI_THEME_COMPOSITION active brand"` — label + intent words
- `"primary color token oklch"` — concrete property hint
- `"FieldError component slot"` — label + name + role
- `"xpos screen item span"` — workspace prefix + label hint

### Bad queries (too broad, mostly noise)

- `"color"` — matches every color token across every theme; pick a more
  specific descriptor (e.g. `"primary color oklch"` or filter by label)
- `"theme"` — same problem; use `"UI_THEME_COMPOSITION"` or
  `"UI_THEME kind=spacing"`
- `""` (empty) — returns nothing useful

### Anti-patterns

- ❌ Don't `kg_search` 10 times with slight variations — call once with
   a richer query, then `kg_neighbors` to expand.
- ❌ Don't `kg_neighbors depth=3+` — the graph fans out fast. Stay at
   depth 1 or 2, use `kg_subgraph` instead when you have multiple ids.
- ❌ Don't invent ids. If `kg_get_node` returns 404, search again.
- ❌ Don't mix `ws-catalog-shadcn` data into project-specific code
   unless the user explicitly asked for the catalog parity.

---

## 7. End-to-end walkthrough

> "Build a fintech landing page hero using our active brand."

```
Step 1 — Find the active brand composition
  kg_search query="UI_THEME_COMPOSITION active brand fintech" limit=5
  → pick the composition with isActive=true → comp_id = "...-..."

Step 2 — Get the full brand spec
  kg_get_theme_composition composition_id="comp_id"
  → returns { composition, layers: [ { order, theme, tokens: [...] }, ... ] }

Step 3 — Extract what you need
  - From layer with kind=color   → primary, secondary, background, foreground
  - From layer with kind=typography → font family, scale
  - From layer with kind=spacing → spacing scale

Step 4 — Build the artifact
  - Single HTML (via react-shadcn-html skill if active)
  - Inline CSS variables = token rawValues (NOT made up values)
  - At top of file, list every node_id you read in an HTML comment
    block so the user can verify provenance

Step 5 — Stop. Don't keep searching.
```

---

## 8. When uncertain

If you cannot find what the user needs after 2 well-formed searches:

1. Try the **other workspace** (`ws-catalog-shadcn` ↔ `ws-project-XPOS`)
2. Call `kg_neighbors` on the closest match to discover unfamiliar
   labels/edges
3. Ask the user (only after step 1 + 2 failed):
   "I searched for X in workspace Y and found N hits. Do you have a
   specific node_id, or should I look in a different workspace?"

---

## Notes for code generation

- `rawValue` for color tokens uses **`oklch()`** in this KGS. Some
  agents bias to hex/hsl — keep the original oklch() string in CSS
  variables so designers see exact parity with Figma. Modern browsers
  (2024+) understand oklch natively.
- `controlSizingJson` on `UI_COMPONENT` carries per-size dimensions; do
  not hand-roll Tailwind class strings — parse it.
- `targetPath` on `UI_TOKEN_VALUE` is the **canonical token name**
  (e.g. `border-strong`, `bg-card`); use it as CSS variable suffix.

---

## See also

- `references/labels.md` — full property cheatsheet per label
- `references/workspaces.md` — current workspace list with what each contains
