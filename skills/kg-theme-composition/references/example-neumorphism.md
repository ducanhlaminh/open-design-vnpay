# Example: Neumorphism Composition

Ví dụ hoàn chỉnh tạo theme composition theo phong cách Neumorphism.

---

## Discovery Answers

```json
{
  "compositionName": "Neumorphic Dashboard",
  "visualDirection": "Neumorphism — soft shadows, monochrome, tactile",
  "colorStance": "Monochromatic — 1 hue với lightness variations",
  "primaryColor": "#9ca3af (neutral grey)",
  "targetPlatform": ["Web responsive", "Desktop app"],
  "density": "Spacious — generous whitespace"
}
```

---

## Step 1: Create 7 Themes

```cypher
// 1. Brand Theme — Neumorphic Grey
CREATE (brand:UI_THEME {
  id: 'theme-neumorphic-grey-brand',
  name: 'Neumorphic Grey Brand',
  slug: 'neumorphic-grey-brand',
  kind: 'brand',
  description: 'Monochrome grey palette with dual soft shadows',
  authored: true,
  createdAt: datetime(),
  updatedAt: datetime()
})

// 2. Typography Theme — Clean Sans
CREATE (typo:UI_THEME {
  id: 'theme-clean-sans-type',
  name: 'Clean Sans Type',
  slug: 'clean-sans-type',
  kind: 'typography',
  description: 'Inter display + body, medium weight, generous spacing',
  authored: true,
  createdAt: datetime()
})

// 3. Spacing Theme — Spacious
CREATE (spacing:UI_THEME {
  id: 'theme-spacious-spacing',
  name: 'Spacious Spacing',
  slug: 'spacious-spacing',
  kind: 'spacing',
  description: '8px base with 1.6 scale, generous padding',
  authored: true,
  createdAt: datetime()
})

// 4. Icon Theme — Rounded Outline
CREATE (icon:UI_THEME {
  id: 'theme-rounded-outline-icons',
  name: 'Rounded Outline Icons',
  slug: 'rounded-outline-icons',
  kind: 'icon',
  description: 'Lucide rounded style, 24px default, 2px stroke',
  authored: true,
  createdAt: datetime()
})

// 5. Visual Theme — Soft Shadows
CREATE (visual:UI_THEME {
  id: 'theme-soft-shadows-visual',
  name: 'Soft Shadows Visual',
  slug: 'soft-shadows-visual',
  kind: 'visual',
  description: 'Dual light/dark shadows, no borders, depth via shadow only',
  authored: true,
  createdAt: datetime()
})

// 6. Control Density — Spacious
CREATE (control:UI_THEME {
  id: 'theme-spacious-controls',
  name: 'Spacious Controls',
  slug: 'spacious-controls',
  kind: 'control-density',
  description: '52px default height, ample padding, 48px minimum touch',
  authored: true,
  createdAt: datetime()
})

// 7. Rounded Theme — Soft Pill
CREATE (rounded:UI_THEME {
  id: 'theme-soft-pill-rounded',
  name: 'Soft Pill Rounded',
  slug: 'soft-pill-rounded',
  kind: 'rounded',
  description: '16px default radius, pill for buttons',
  authored: true,
  createdAt: datetime()
})

RETURN brand, typo, spacing, icon, visual, control, rounded
```

---

## Step 2: Link Themes to Axes

```cypher
MATCH (axisBrand:UI_THEME_AXIS {kind: 'brand'})
MATCH (axisTypo:UI_THEME_AXIS {kind: 'typography'})
MATCH (axisSpacing:UI_THEME_AXIS {kind: 'spacing'})
MATCH (axisIcon:UI_THEME_AXIS {kind: 'icon'})
MATCH (axisVisual:UI_THEME_AXIS {kind: 'visual'})
MATCH (axisControl:UI_THEME_AXIS {kind: 'control-density'})
MATCH (axisRounded:UI_THEME_AXIS {kind: 'rounded'})

MATCH (brand:UI_THEME {slug: 'neumorphic-grey-brand'})
MATCH (typo:UI_THEME {slug: 'clean-sans-type'})
MATCH (spacing:UI_THEME {slug: 'spacious-spacing'})
MATCH (icon:UI_THEME {slug: 'rounded-outline-icons'})
MATCH (visual:UI_THEME {slug: 'soft-shadows-visual'})
MATCH (control:UI_THEME {slug: 'spacious-controls'})
MATCH (rounded:UI_THEME {slug: 'soft-pill-rounded'})

CREATE (axisBrand)-[:HAS_THEME]->(brand)
CREATE (axisTypo)-[:HAS_THEME]->(typo)
CREATE (axisSpacing)-[:HAS_THEME]->(spacing)
CREATE (axisIcon)-[:HAS_THEME]->(icon)
CREATE (axisVisual)-[:HAS_THEME]->(visual)
CREATE (axisControl)-[:HAS_THEME]->(control)
CREATE (axisRounded)-[:HAS_THEME]->(rounded)
```

---

## Step 3: Create Composition

```cypher
CREATE (comp:UI_THEME_COMPOSITION {
  id: 'composition-neumorphic-dashboard',
  name: 'Neumorphic Dashboard',
  slug: 'neumorphic-dashboard',
  description: 'Monochrome grey neumorphic design with soft tactile shadows',
  authored: true,
  createdAt: datetime(),
  updatedAt: datetime()
})

MATCH (brand:UI_THEME {slug: 'neumorphic-grey-brand'})
MATCH (typo:UI_THEME {slug: 'clean-sans-type'})
MATCH (spacing:UI_THEME {slug: 'spacious-spacing'})
MATCH (icon:UI_THEME {slug: 'rounded-outline-icons'})
MATCH (visual:UI_THEME {slug: 'soft-shadows-visual'})
MATCH (control:UI_THEME {slug: 'spacious-controls'})
MATCH (rounded:UI_THEME {slug: 'soft-pill-rounded'})

CREATE (comp)-[:USES_THEME]->(brand)
CREATE (comp)-[:USES_THEME]->(typo)
CREATE (comp)-[:USES_THEME]->(spacing)
CREATE (comp)-[:USES_THEME]->(icon)
CREATE (comp)-[:USES_THEME]->(visual)
CREATE (comp)-[:USES_THEME]->(control)
CREATE (comp)-[:USES_THEME]->(rounded)

RETURN comp
```

---

## Step 4: Create Color Token Values (Brand Theme)

```cypher
MATCH (modeLight:UI_MODE {slug: 'light'})
MATCH (modeDark:UI_MODE {slug: 'dark'})

// Token: color.bg
MATCH (tokenBg:UI_TOKEN {domain: 'color', slug: 'bg'})
CREATE (vBgLight:UI_TOKEN_VALUE {
  id: 'val-neumorphic-grey-brand-color-bg-light',
  themeId: 'theme-neumorphic-grey-brand',
  rawValue: 'oklch(94% 0.004 240)',
  resolvedValue: 'oklch(94% 0.004 240)',
  authored: true,
  createdAt: datetime()
})
CREATE (vBgDark:UI_TOKEN_VALUE {
  id: 'val-neumorphic-grey-brand-color-bg-dark',
  themeId: 'theme-neumorphic-grey-brand',
  rawValue: 'oklch(18% 0.008 240)',
  resolvedValue: 'oklch(18% 0.008 240)',
  authored: true
})
CREATE (vBgLight)-[:FOR_TOKEN]->(tokenBg)
CREATE (vBgLight)-[:IN_MODE]->(modeLight)
CREATE (vBgDark)-[:FOR_TOKEN]->(tokenBg)
CREATE (vBgDark)-[:IN_MODE]->(modeDark)

// Token: color.surface (same as bg for neumorphic effect)
MATCH (tokenSurface:UI_TOKEN {domain: 'color', slug: 'surface'})
CREATE (vSurfaceLight:UI_TOKEN_VALUE {
  id: 'val-neumorphic-grey-brand-color-surface-light',
  themeId: 'theme-neumorphic-grey-brand',
  rawValue: 'oklch(94% 0.004 240)',
  resolvedValue: 'oklch(94% 0.004 240)',
  authored: true
})
CREATE (vSurfaceDark:UI_TOKEN_VALUE {
  id: 'val-neumorphic-grey-brand-color-surface-dark',
  themeId: 'theme-neumorphic-grey-brand',
  rawValue: 'oklch(18% 0.008 240)',
  resolvedValue: 'oklch(18% 0.008 240)',
  authored: true
})
CREATE (vSurfaceLight)-[:FOR_TOKEN]->(tokenSurface)
CREATE (vSurfaceLight)-[:IN_MODE]->(modeLight)
CREATE (vSurfaceDark)-[:FOR_TOKEN]->(tokenSurface)
CREATE (vSurfaceDark)-[:IN_MODE]->(modeDark)

// Token: color.fg
MATCH (tokenFg:UI_TOKEN {domain: 'color', slug: 'fg'})
CREATE (vFgLight:UI_TOKEN_VALUE {
  id: 'val-neumorphic-grey-brand-color-fg-light',
  themeId: 'theme-neumorphic-grey-brand',
  rawValue: 'oklch(28% 0.012 240)',
  resolvedValue: 'oklch(28% 0.012 240)',
  authored: true
})
CREATE (vFgDark:UI_TOKEN_VALUE {
  id: 'val-neumorphic-grey-brand-color-fg-dark',
  themeId: 'theme-neumorphic-grey-brand',
  rawValue: 'oklch(92% 0.006 240)',
  resolvedValue: 'oklch(92% 0.006 240)',
  authored: true
})
CREATE (vFgLight)-[:FOR_TOKEN]->(tokenFg)
CREATE (vFgLight)-[:IN_MODE]->(modeLight)
CREATE (vFgDark)-[:FOR_TOKEN]->(tokenFg)
CREATE (vFgDark)-[:IN_MODE]->(modeDark)

// Token: color.muted
MATCH (tokenMuted:UI_TOKEN {domain: 'color', slug: 'muted'})
CREATE (vMutedLight:UI_TOKEN_VALUE {
  id: 'val-neumorphic-grey-brand-color-muted-light',
  themeId: 'theme-neumorphic-grey-brand',
  rawValue: 'oklch(52% 0.010 240)',
  resolvedValue: 'oklch(52% 0.010 240)',
  authored: true
})
CREATE (vMutedDark:UI_TOKEN_VALUE {
  id: 'val-neumorphic-grey-brand-color-muted-dark',
  themeId: 'theme-neumorphic-grey-brand',
  rawValue: 'oklch(62% 0.010 240)',
  resolvedValue: 'oklch(62% 0.010 240)',
  authored: true
})
CREATE (vMutedLight)-[:FOR_TOKEN]->(tokenMuted)
CREATE (vMutedLight)-[:IN_MODE]->(modeLight)
CREATE (vMutedDark)-[:FOR_TOKEN]->(tokenMuted)
CREATE (vMutedDark)-[:IN_MODE]->(modeDark)

// Token: color.border (subtle, almost invisible)
MATCH (tokenBorder:UI_TOKEN {domain: 'color', slug: 'border'})
CREATE (vBorderLight:UI_TOKEN_VALUE {
  id: 'val-neumorphic-grey-brand-color-border-light',
  themeId: 'theme-neumorphic-grey-brand',
  rawValue: 'oklch(88% 0.006 240)',
  resolvedValue: 'oklch(88% 0.006 240)',
  authored: true
})
CREATE (vBorderDark:UI_TOKEN_VALUE {
  id: 'val-neumorphic-grey-brand-color-border-dark',
  themeId: 'theme-neumorphic-grey-brand',
  rawValue: 'oklch(26% 0.010 240)',
  resolvedValue: 'oklch(26% 0.010 240)',
  authored: true
})
CREATE (vBorderLight)-[:FOR_TOKEN]->(tokenBorder)
CREATE (vBorderLight)-[:IN_MODE]->(modeLight)
CREATE (vBorderDark)-[:FOR_TOKEN]->(tokenBorder)
CREATE (vBorderDark)-[:IN_MODE]->(modeDark)

// Token: color.accent (single blue accent)
MATCH (tokenAccent:UI_TOKEN {domain: 'color', slug: 'accent'})
CREATE (vAccentLight:UI_TOKEN_VALUE {
  id: 'val-neumorphic-grey-brand-color-accent-light',
  themeId: 'theme-neumorphic-grey-brand',
  rawValue: 'oklch(56% 0.14 220)',
  resolvedValue: 'oklch(56% 0.14 220)',
  authored: true
})
CREATE (vAccentDark:UI_TOKEN_VALUE {
  id: 'val-neumorphic-grey-brand-color-accent-dark',
  themeId: 'theme-neumorphic-grey-brand',
  rawValue: 'oklch(64% 0.16 220)',
  resolvedValue: 'oklch(64% 0.16 220)',
  authored: true
})
CREATE (vAccentLight)-[:FOR_TOKEN]->(tokenAccent)
CREATE (vAccentLight)-[:IN_MODE]->(modeLight)
CREATE (vAccentDark)-[:FOR_TOKEN]->(tokenAccent)
CREATE (vAccentDark)-[:IN_MODE]->(modeDark)

// ... (repeat for accent-fg, destructive, success, warning, muted-bg, muted-fg)
```

---

## Step 5: Create Visual Token Values (Visual Theme)

```cypher
MATCH (modeLight:UI_MODE {slug: 'light'})
MATCH (modeDark:UI_MODE {slug: 'dark'})

// Token: visual.shadow-sm (extruded effect)
MATCH (tokenShadowSm:UI_TOKEN {domain: 'visual', slug: 'shadow-sm'})
CREATE (vShadowSmLight:UI_TOKEN_VALUE {
  id: 'val-soft-shadows-visual-shadow-sm-light',
  themeId: 'theme-soft-shadows-visual',
  rawValue: '4px 4px 8px oklch(88% 0.006 240), -4px -4px 8px oklch(100% 0 0)',
  resolvedValue: '4px 4px 8px oklch(88% 0.006 240), -4px -4px 8px oklch(100% 0 0)',
  authored: true
})
CREATE (vShadowSmDark:UI_TOKEN_VALUE {
  id: 'val-soft-shadows-visual-shadow-sm-dark',
  themeId: 'theme-soft-shadows-visual',
  rawValue: '4px 4px 8px oklch(12% 0.010 240), -4px -4px 8px oklch(24% 0.010 240)',
  resolvedValue: '4px 4px 8px oklch(12% 0.010 240), -4px -4px 8px oklch(24% 0.010 240)',
  authored: true
})
CREATE (vShadowSmLight)-[:FOR_TOKEN]->(tokenShadowSm)
CREATE (vShadowSmLight)-[:IN_MODE]->(modeLight)
CREATE (vShadowSmDark)-[:FOR_TOKEN]->(tokenShadowSm)
CREATE (vShadowSmDark)-[:IN_MODE]->(modeDark)

// Token: visual.shadow-md (debossed for inputs)
MATCH (tokenShadowMd:UI_TOKEN {domain: 'visual', slug: 'shadow-md'})
CREATE (vShadowMdLight:UI_TOKEN_VALUE {
  id: 'val-soft-shadows-visual-shadow-md-light',
  themeId: 'theme-soft-shadows-visual',
  rawValue: 'inset 4px 4px 8px oklch(88% 0.006 240), inset -4px -4px 8px oklch(100% 0 0)',
  resolvedValue: 'inset 4px 4px 8px oklch(88% 0.006 240), inset -4px -4px 8px oklch(100% 0 0)',
  authored: true
})
CREATE (vShadowMdDark:UI_TOKEN_VALUE {
  id: 'val-soft-shadows-visual-shadow-md-dark',
  themeId: 'theme-soft-shadows-visual',
  rawValue: 'inset 4px 4px 8px oklch(12% 0.010 240), inset -4px -4px 8px oklch(24% 0.010 240)',
  resolvedValue: 'inset 4px 4px 8px oklch(12% 0.010 240), inset -4px -4px 8px oklch(24% 0.010 240)',
  authored: true
})
CREATE (vShadowMdLight)-[:FOR_TOKEN]->(tokenShadowMd)
CREATE (vShadowMdLight)-[:IN_MODE]->(modeLight)
CREATE (vShadowMdDark)-[:FOR_TOKEN]->(tokenShadowMd)
CREATE (vShadowMdDark)-[:IN_MODE]->(modeDark)

// ... (repeat for shadow-lg, shadow-xl, blur, border-width)
```

---

## Step 6: Link to Workspace

```cypher
MATCH (ws:UI_WORKSPACE {slug: 'ws-od-prototypes'})
MATCH (comp:UI_THEME_COMPOSITION {slug: 'neumorphic-dashboard'})
MERGE (ws)-[:WORKSPACE_COMPOSITION]->(comp)
```

---

## Step 7: Verification

Run validation query #1:

```cypher
MATCH (comp:UI_THEME_COMPOSITION {slug: 'neumorphic-dashboard'})-[:USES_THEME]->(theme)
WITH comp, collect({kind: theme.kind, name: theme.name}) AS themes
RETURN comp.name, size(themes) AS themeCount, themes
```

**Expected output:**
```json
{
  "comp.name": "Neumorphic Dashboard",
  "themeCount": 7,
  "themes": [
    {"kind": "brand", "name": "Neumorphic Grey Brand"},
    {"kind": "typography", "name": "Clean Sans Type"},
    {"kind": "spacing", "name": "Spacious Spacing"},
    {"kind": "icon", "name": "Rounded Outline Icons"},
    {"kind": "visual", "name": "Soft Shadows Visual"},
    {"kind": "control-density", "name": "Spacious Controls"},
    {"kind": "rounded", "name": "Soft Pill Rounded"}
  ]
}
```

✅ **PASS** — Composition has all 7 themes.

---

## Complete Token Value Count

For a complete Neumorphic composition:

| Theme | Token Domain | Token Count | Values (Light + Dark) |
|-------|--------------|-------------|-----------------------|
| Brand | color | 15 tokens | 30 values |
| Typography | typography | 10 tokens | 20 values |
| Spacing | spacing | 8 tokens | 16 values |
| Icon | icon | 5 tokens | 10 values |
| Visual | visual | 10 tokens | 20 values |
| Control | control | 6 tokens | 12 values |
| Rounded | rounded | 5 tokens | 10 values |
| **Total** | | **59 tokens** | **118 values** |

---

## Preview Artifact (Optional)

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Neumorphic Dashboard Preview</title>
  <style>
    :root {
      --bg: oklch(94% 0.004 240);
      --surface: oklch(94% 0.004 240);
      --fg: oklch(28% 0.012 240);
      --muted: oklch(52% 0.010 240);
      --border: oklch(88% 0.006 240);
      --accent: oklch(56% 0.14 220);
      --shadow-extruded: 8px 8px 16px oklch(88% 0.006 240), -8px -8px 16px oklch(100% 0 0);
      --shadow-debossed: inset 4px 4px 8px oklch(88% 0.006 240), inset -4px -4px 8px oklch(100% 0 0);
      --rounded: 16px;
      --control-height: 52px;
      --spacing: 1.5rem;
    }
    html.dark {
      --bg: oklch(18% 0.008 240);
      --surface: oklch(18% 0.008 240);
      --fg: oklch(92% 0.006 240);
      --muted: oklch(62% 0.010 240);
      --border: oklch(26% 0.010 240);
      --accent: oklch(64% 0.16 220);
      --shadow-extruded: 6px 6px 12px oklch(12% 0.010 240), -6px -6px 12px oklch(24% 0.010 240);
      --shadow-debossed: inset 4px 4px 8px oklch(12% 0.010 240), inset -4px -4px 8px oklch(24% 0.010 240);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font: 16px/1.6 'Inter', -apple-system, system-ui, sans-serif;
      padding: 3rem;
      min-height: 100vh;
      display: grid;
      place-items: center;
    }
    .card {
      background: var(--surface);
      padding: var(--spacing);
      border-radius: var(--rounded);
      box-shadow: var(--shadow-extruded);
      max-width: 400px;
      width: 100%;
    }
    .card h2 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 1rem;
      letter-spacing: 0.02em;
    }
    .card p {
      color: var(--muted);
      margin-bottom: var(--spacing);
    }
    .input {
      width: 100%;
      height: var(--control-height);
      background: var(--surface);
      border: none;
      border-radius: var(--rounded);
      box-shadow: var(--shadow-debossed);
      padding: 0 1.5rem;
      color: var(--fg);
      font: inherit;
      margin-bottom: 1rem;
    }
    .input:focus {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .button {
      width: 100%;
      height: var(--control-height);
      background: var(--surface);
      border: none;
      border-radius: 9999px;
      box-shadow: var(--shadow-extruded);
      color: var(--fg);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .button:hover {
      box-shadow: 4px 4px 6px oklch(88% 0.006 240), -4px -4px 6px oklch(100% 0 0);
    }
    .button:active {
      box-shadow: var(--shadow-debossed);
    }
    .button.primary {
      background: var(--accent);
      color: white;
    }
    .toggle {
      position: fixed;
      top: 2rem;
      right: 2rem;
      font: 12px/1 ui-monospace, monospace;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      cursor: pointer;
      padding: 0.5rem 1rem;
      background: var(--surface);
      border-radius: 8px;
      box-shadow: var(--shadow-extruded);
    }
  </style>
</head>
<body>
  <div class="toggle" onclick="document.documentElement.classList.toggle('dark')">
    Toggle Dark
  </div>
  
  <div class="card">
    <h2>Neumorphic Dashboard</h2>
    <p>Soft tactile design with dual shadows and monochrome palette.</p>
    <input class="input" placeholder="Enter email" />
    <button class="button primary">Sign In</button>
  </div>
</body>
</html>
```

---

## Summary

Composition **"Neumorphic Dashboard"** created with:
- ✅ 7 themes across 7 axes
- ✅ 118 token values (59 tokens × 2 modes)
- ✅ Monochrome grey palette with single blue accent
- ✅ Dual soft shadows (extruded + debossed)
- ✅ Spacious controls (52px height)
- ✅ Soft pill rounded (16px radius)
- ✅ Linked to workspace `ws-od-prototypes`
- ✅ Preview artifact shows interactive demo

Ready to use in `react-shadcn` screens or export to Figma via `figma-generate-library`.
