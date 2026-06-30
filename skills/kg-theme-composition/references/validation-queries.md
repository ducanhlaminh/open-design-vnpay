# Validation Queries — Verify Composition

Chạy các queries sau qua MCP `kg_cypher_read` để verify composition đã tạo đúng.

---

## 1. Check Composition Has 7 Themes

**Purpose:** Verify composition kết nối đủ 7 themes (mỗi axis 1).

```cypher
MATCH (comp:UI_THEME_COMPOSITION {slug: $compositionSlug})-[:USES_THEME]->(theme)
WITH comp, collect({kind: theme.kind, name: theme.name, slug: theme.slug}) AS themes
RETURN 
  comp.name AS composition,
  size(themes) AS themeCount,
  themes
ORDER BY comp.name
```

**Expected:**
```
{
  "composition": "VNPAY Emerald",
  "themeCount": 7,
  "themes": [
    {"kind": "brand", "name": "VNPAY Emerald Brand", "slug": "vnpay-emerald-brand"},
    {"kind": "typography", "name": "Modern Geist Type", "slug": "modern-geist-type"},
    {"kind": "spacing", "name": "Default Spacing", "slug": "default-spacing"},
    {"kind": "icon", "name": "Lucide Outline", "slug": "lucide-outline"},
    {"kind": "visual", "name": "Payment Glass Pro", "slug": "payment-glass-pro"},
    {"kind": "control-density", "name": "Default Controls", "slug": "default-controls"},
    {"kind": "rounded", "name": "Soft Rounded", "slug": "soft-rounded"}
  ]
}
```

**Failure cases:**
- `themeCount < 7` → Missing themes, composition incomplete
- `themeCount > 7` → Duplicate themes for same axis
- Missing any kind → That axis not covered

---

## 2. Check Each Theme Has Token Values

**Purpose:** Verify mỗi theme có ít nhất 1 token value (và nên có ~10-30 values).

```cypher
MATCH (comp:UI_THEME_COMPOSITION {slug: $compositionSlug})-[:USES_THEME]->(theme)
OPTIONAL MATCH (val:UI_TOKEN_VALUE {themeId: theme.id})
WITH theme, count(val) AS valueCount
RETURN 
  theme.kind AS themeKind,
  theme.name AS themeName,
  valueCount
ORDER BY theme.kind
```

**Expected (example):**
```
[
  {"themeKind": "brand", "themeName": "VNPAY Emerald Brand", "valueCount": 30},
  {"themeKind": "control-density", "themeName": "Default Controls", "valueCount": 12},
  {"themeKind": "icon", "themeName": "Lucide Outline", "valueCount": 10},
  {"themeKind": "rounded", "themeName": "Soft Rounded", "valueCount": 10},
  {"themeKind": "spacing", "themeName": "Default Spacing", "valueCount": 16},
  {"themeKind": "typography", "themeName": "Modern Geist Type", "valueCount": 20},
  {"themeKind": "visual", "themeName": "Payment Glass Pro", "valueCount": 20}
]
```

**Failure cases:**
- `valueCount = 0` → Theme has no token values (useless theme)
- `valueCount < 10` for `brand`/`typography`/`visual` → Incomplete token coverage

---

## 3. Check Token Values Have Both Light & Dark Modes

**Purpose:** Mỗi token trong composition PHẢI có value cho cả Light và Dark mode.

```cypher
MATCH (comp:UI_THEME_COMPOSITION {slug: $compositionSlug})-[:USES_THEME]->(theme)
MATCH (val:UI_TOKEN_VALUE {themeId: theme.id})-[:FOR_TOKEN]->(token)
MATCH (val)-[:IN_MODE]->(mode)
WITH token, theme, collect(DISTINCT mode.slug) AS modes
WHERE size(modes) < 2
RETURN 
  theme.kind AS themeKind,
  theme.name AS themeName,
  token.domain + '.' + token.slug AS tokenPath,
  modes AS availableModes
ORDER BY themeKind, tokenPath
```

**Expected:** Empty result (no rows). Nếu có rows → token thiếu mode.

**Failure example:**
```
[
  {
    "themeKind": "brand",
    "themeName": "VNPAY Emerald Brand",
    "tokenPath": "color.accent",
    "availableModes": ["light"]  // ← Missing dark mode!
  }
]
```

**Fix:** Tạo thêm `UI_TOKEN_VALUE` cho mode còn thiếu.

---

## 4. Check Themes Are Linked to Axes

**Purpose:** Verify mỗi theme kết nối với đúng axis qua `HAS_THEME`.

```cypher
MATCH (comp:UI_THEME_COMPOSITION {slug: $compositionSlug})-[:USES_THEME]->(theme)
OPTIONAL MATCH (axis:UI_THEME_AXIS)-[:HAS_THEME]->(theme)
RETURN 
  theme.kind AS themeKind,
  theme.name AS themeName,
  axis.kind AS axisKind,
  CASE WHEN axis IS NULL THEN 'NOT LINKED' ELSE 'OK' END AS status
ORDER BY theme.kind
```

**Expected:** All rows have `status = 'OK'` and `axisKind = themeKind`.

**Failure example:**
```
{
  "themeKind": "brand",
  "themeName": "VNPAY Emerald Brand",
  "axisKind": null,
  "status": "NOT LINKED"  // ← Missing HAS_THEME relationship!
}
```

**Fix:** Run:
```cypher
MATCH (axis:UI_THEME_AXIS {kind: 'brand'})
MATCH (theme:UI_THEME {slug: 'vnpay-emerald-brand'})
MERGE (axis)-[:HAS_THEME]->(theme)
```

---

## 5. Check Composition Linked to Workspace

**Purpose:** Composition phải gắn vào workspace để có thể dùng.

```cypher
MATCH (comp:UI_THEME_COMPOSITION {slug: $compositionSlug})
OPTIONAL MATCH (ws:UI_WORKSPACE)-[:WORKSPACE_COMPOSITION]->(comp)
RETURN 
  comp.name AS composition,
  ws.slug AS workspace,
  CASE WHEN ws IS NULL THEN 'NOT IN WORKSPACE' ELSE 'OK' END AS status
```

**Expected:**
```
{
  "composition": "VNPAY Emerald",
  "workspace": "ws-od-prototypes",
  "status": "OK"
}
```

**Failure:**
```
{
  "composition": "VNPAY Emerald",
  "workspace": null,
  "status": "NOT IN WORKSPACE"
}
```

**Fix:**
```cypher
MATCH (ws:UI_WORKSPACE {slug: 'ws-od-prototypes'})
MATCH (comp:UI_THEME_COMPOSITION {slug: 'vnpay-emerald'})
MERGE (ws)-[:WORKSPACE_COMPOSITION]->(comp)
```

---

## 6. Check No Duplicate Theme Slugs in Workspace

**Purpose:** Mỗi theme slug phải unique trong workspace.

```cypher
MATCH (ws:UI_WORKSPACE {slug: 'ws-od-prototypes'})-[:WORKSPACE_COMPOSITION]->(comp)-[:USES_THEME]->(theme)
WITH theme.slug AS slug, collect(DISTINCT comp.name) AS compositions
WHERE size(compositions) > 1
RETURN slug, compositions
```

**Expected:** Empty result. Nếu có rows → slug collision.

**Failure example:**
```
{
  "slug": "default-spacing",
  "compositions": ["VNPAY Emerald", "VNPAY Sapphire"]  // ← Reused theme, OK!
}
```

Actually, **reusing themes across compositions is GOOD** (compositional pattern encourages this). Only fail if same slug points to DIFFERENT theme nodes:

```cypher
MATCH (theme:UI_THEME)
WITH theme.slug AS slug, collect(DISTINCT theme.id) AS ids
WHERE size(ids) > 1
RETURN slug, ids
```

**Expected:** Empty. If rows → same slug, different IDs → BAD duplication.

---

## 7. List All Token Values for a Theme

**Purpose:** Debug — see all values for one theme.

```cypher
MATCH (theme:UI_THEME {slug: $themeSlug})
MATCH (val:UI_TOKEN_VALUE {themeId: theme.id})-[:FOR_TOKEN]->(token)
MATCH (val)-[:IN_MODE]->(mode)
RETURN 
  token.domain AS domain,
  token.slug AS tokenSlug,
  mode.slug AS mode,
  val.rawValue AS value
ORDER BY domain, tokenSlug, mode
```

**Example output (theme: `vnpay-emerald-brand`):**
```
[
  {"domain": "color", "tokenSlug": "accent", "mode": "dark", "value": "oklch(64% 0.20 160)"},
  {"domain": "color", "tokenSlug": "accent", "mode": "light", "value": "oklch(58% 0.18 160)"},
  {"domain": "color", "tokenSlug": "bg", "mode": "dark", "value": "oklch(12% 0.008 160)"},
  {"domain": "color", "tokenSlug": "bg", "mode": "light", "value": "oklch(98% 0.004 160)"},
  ...
]
```

---

## 8. Get Full Composition Tree (for debugging)

**Purpose:** See entire structure from composition → themes → tokens → values → modes.

```cypher
MATCH path = (comp:UI_THEME_COMPOSITION {slug: $compositionSlug})-[:USES_THEME]->(theme)
               <-[:HAS_THEME]-(axis:UI_THEME_AXIS)
OPTIONAL MATCH (val:UI_TOKEN_VALUE {themeId: theme.id})-[:FOR_TOKEN]->(token)
OPTIONAL MATCH (val)-[:IN_MODE]->(mode)
RETURN 
  comp.name AS composition,
  axis.kind AS axis,
  theme.name AS theme,
  theme.slug AS themeSlug,
  collect(DISTINCT {
    token: token.domain + '.' + token.slug,
    mode: mode.slug,
    value: val.rawValue
  }) AS values
ORDER BY axis, theme
```

Use this when full picture needed (warning: large result for complete compositions).

---

## 9. Find Themes Without Axes (orphaned themes)

**Purpose:** Detect themes created but not linked to any axis.

```cypher
MATCH (theme:UI_THEME)
WHERE theme.authored = true
AND NOT ((:UI_THEME_AXIS)-[:HAS_THEME]->(theme))
RETURN theme.slug, theme.kind, theme.name
```

**Expected:** Empty. If rows → orphaned themes (probably copy/paste mistake).

**Fix:** Link to correct axis or delete if unused.

---

## 10. Count Total Entities in Composition

**Purpose:** Sanity check — verify composition created expected number of nodes.

```cypher
MATCH (comp:UI_THEME_COMPOSITION {slug: $compositionSlug})
OPTIONAL MATCH (comp)-[:USES_THEME]->(theme)
OPTIONAL MATCH (val:UI_TOKEN_VALUE)
WHERE val.themeId IN [t IN collect(theme) | t.id]
RETURN 
  comp.name AS composition,
  count(DISTINCT theme) AS themeCount,
  count(DISTINCT val) AS tokenValueCount
```

**Expected (example):**
```
{
  "composition": "VNPAY Emerald",
  "themeCount": 7,
  "tokenValueCount": 118  // ~59 tokens × 2 modes
}
```

**Rules of thumb:**
- `themeCount` MUST be exactly 7
- `tokenValueCount` typically 80-150 depending on coverage
  - Minimal: ~60 values (30 tokens × 2 modes)
  - Standard: ~118 values (59 tokens × 2 modes)
  - Complete: ~200+ values (full token catalog)

---

## Run All Checks — Combined Query

Agent can run this single query to get overview:

```cypher
MATCH (comp:UI_THEME_COMPOSITION {slug: $compositionSlug})

// 1. Theme count
OPTIONAL MATCH (comp)-[:USES_THEME]->(theme)
WITH comp, collect(theme) AS themes

// 2. Value count
UNWIND themes AS theme
OPTIONAL MATCH (val:UI_TOKEN_VALUE {themeId: theme.id})
WITH comp, themes, theme, collect(val) AS vals

// 3. Mode coverage
UNWIND vals AS val
OPTIONAL MATCH (val)-[:IN_MODE]->(mode)
WITH comp, themes, theme, vals, collect(DISTINCT mode.slug) AS modes

RETURN 
  comp.name AS composition,
  size(themes) AS themeCount,
  theme.kind AS themeKind,
  theme.name AS themeName,
  size(vals) AS valueCount,
  modes AS availableModes,
  CASE 
    WHEN size(modes) = 2 THEN 'OK'
    WHEN size(modes) = 1 THEN 'MISSING ' + CASE WHEN 'light' IN modes THEN 'dark' ELSE 'light' END
    ELSE 'NO VALUES'
  END AS status
ORDER BY themeKind
```

**Interpret results:**
- All rows have `status = 'OK'` → PASS
- Any row with `status = 'MISSING ...'` → FIX that theme's values
- `themeCount != 7` → Missing or duplicate themes

---

## Usage in Skill Workflow (Bước 8)

After creating composition, agent runs queries 1, 2, 3, 5, 10 in sequence:

1. **Query 1** → Verify 7 themes
2. **Query 2** → Check each theme has values
3. **Query 3** → Check Light/Dark parity
4. **Query 5** → Check workspace link
5. **Query 10** → Sanity check counts

If all pass → emit success message + optional preview artifact.

If any fail → show failure, suggest fix, DO NOT emit artifact yet.
