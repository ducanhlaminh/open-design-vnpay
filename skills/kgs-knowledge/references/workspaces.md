# Workspace cheatsheet

Every KGS node has a `workspaceId`. Filter your reasoning by workspace
before assembling output — mixing project-specific tokens into the
shared catalog (or vice-versa) is the most common source of wrong
results.

## ws-catalog-shadcn

**Shared shadcn component catalog.** Reference data for component
implementation parity.

Typical contents:
- `UI_COMPONENT` — shadcn primitives (Button, Input, Card, Dialog, …)
- `UI_COMPONENT_SLOT` — every styleable part of those components
- `UI_TOKEN_VALUE` — catalog-side reference token values

Use when:
- Implementing a component (need slot list, base classes, sizing JSON)
- Looking up the "canonical" shadcn behavior

Do NOT use when:
- Pulling brand tokens for a specific product — those live in the
  project workspace, not here

## ws-project-XPOS

**A real product project.** Contains screens, project-specific token
overrides, and per-project composition.

Typical contents:
- `UI_SCREEN_INSTANCE` — rendered nodes (ids prefixed `xpos-*`)
- `UI_THEME_COMPOSITION` — the active brand composition for this product
- `UI_TOKEN_VALUE` — project-specific token overrides (may shadow
  catalog defaults)

Use when:
- Generating UI for the XPOS product
- Reading "what is the brand here?"

## How to scope a query to one workspace

KGS search is global; the workspace lives on each returned node.
Filter on the client (your reasoning) by reading `workspaceId` on the
returned nodes — do not try to encode the workspace in the search
query unless the workspace slug is also semantically meaningful.

Example:
```
kg_search query="UI_THEME_COMPOSITION active" limit=10
  → among hits, prefer the one with workspaceId="ws-project-XPOS"
    when the user task is about the XPOS product
```
