---
name: kg-theme-composition
description: |
  Tạo theme composition mới trong Knowledge Graph UI sử dụng kiến trúc compositional
  design pattern. Skill này hướng dẫn agent tạo UI_THEME_COMPOSITION với 7 theme axes
  (Brand, Typography, Spacing, Icon, Visual, Control Density, Rounded), tạo UI_THEME
  building blocks độc lập, và tạo UI_TOKEN_VALUE với themeId binding. Output là các
  Cypher queries để insert vào KG qua MCP kg-local.
triggers:
  - "tạo theme composition"
  - "create style composition"
  - "new design system"
  - "kg theme"
  - "compositional design"
  - "theme axes"
  - "ui token value"
od:
  mode: design-system
  category: knowledge-graph
---

# kg-theme-composition

> **Bản chất của compositional design pattern:** Khi tạo style mới, bạn **CHỈ cần tạo**
> `UI_THEME` mới cho các axes cần thay đổi và `UI_TOKEN_VALUE` mới với `themeId` binding.
> Infrastructure (Workspace, Axes, Tokens, Modes) được **dùng lại**, không tạo mới.

> **Vị trí trong pipeline dựng prototype:** skill này = **Stage ③ (nhánh "tạo mới")**
> của xương sống canonical `skills/react-shadcn/references/pipeline.md`. Chỉ chạy khi
> "chọn theme" rẽ vào nhánh **composition CHƯA có trong KG**. Tạo xong → quay lại
> react-shadcn: `ui_tokens_get {X}` (grounding) → author → build (binding). Nếu
> composition X **đã có** thì BỎ QUA skill này, dùng thẳng `ui_tokens_get`.

## Kiến trúc 7 tầng (đọc kỹ)

```
Layer 1: UI_WORKSPACE                    ws-od-prototypes (dùng lại)
         │
         │ WORKSPACE_COMPOSITION
         ▼
Layer 2: UI_THEME_COMPOSITION           ← TẠO MỚI (1 node/composition)
         │
         │ USES_THEME
         ▼
Layer 3: UI_THEME_AXIS                   7 axes cố định (dùng lại)
         │                               - Brand, Typography, Spacing
         │ HAS_THEME                     - Icon, Visual, Control, Rounded
         ▼
Layer 4: UI_THEME                        ← TẠO MỚI (7 themes/composition)
         │                               Mỗi axis chọn 1 theme
         │ (themeId property)
         ▼
Layer 5: UI_TOKEN                        Dùng lại (color, spacing, typography...)
         │
         │ FOR_TOKEN
         ▼
Layer 6: UI_TOKEN_VALUE                  ← TẠO MỚI (values với themeId)
         │                               rawValue: oklch()/px/rem
         │ IN_MODE                       authored: true
         ▼
Layer 7: UI_MODE                         Dùng lại (Light, Dark)
```

## Khi nào dùng skill này

- User muốn tạo một **design system hoàn chỉnh** mới (ví dụ: Neumorphism, Glassmorphism, Material Design, iOS HIG)
- Cần tạo **brand palette** mới với color tokens và values
- Muốn định nghĩa **typography scale**, **spacing system**, **icon style** mới
- Tạo **visual direction** (shadows, borders, effects) cho một product
- Compose với **react-shadcn** skill để render preview

## Workflow — 9 bước chi tiết

### Bước 1: Discovery & Direction

**Agent hỏi user:**
```
<question-form id="theme-composition-discovery" title="Theme Composition Brief">
{
  "description": "Tôi sẽ tạo theme composition mới trong KG. Trả lời các câu sau:",
  "questions": [
    {
      "id": "compositionName",
      "label": "Tên composition (ví dụ: VNPAY Emerald, iOS Material Fusion)",
      "type": "text",
      "required": true
    },
    {
      "id": "visualDirection",
      "label": "Phong cách visual chính",
      "type": "radio",
      "required": true,
      "options": [
        "Neumorphism — soft shadows, monochrome, tactile",
        "Glassmorphism — frosted glass, transparency, depth",
        "Material Design — elevation, bold colors, motion",
        "iOS HIG — clean, system fonts, restrained",
        "Editorial — serif headlines, generous whitespace",
        "Brutalist — loud type, visible grid, no decoration",
        "Custom — tôi sẽ mô tả"
      ]
    },
    {
      "id": "colorStance",
      "label": "Color palette approach",
      "type": "radio",
      "options": [
        "Monochromatic — 1 hue với lightness variations",
        "Analogous — 2-3 hues gần nhau trên color wheel",
        "Complementary — 1 primary + 1 accent đối lập",
        "Brand-driven — dựa trên brand colors có sẵn"
      ]
    },
    {
      "id": "primaryColor",
      "label": "Màu chính (hex hoặc mô tả)",
      "type": "text",
      "placeholder": "#2563eb hoặc 'deep blue like Stripe'"
    },
    {
      "id": "targetPlatform",
      "label": "Target platform",
      "type": "checkbox",
      "maxSelections": 3,
      "options": ["Web responsive", "iOS app", "Android app", "Desktop app"]
    },
    {
      "id": "density",
      "label": "UI density preference",
      "type": "radio",
      "options": ["Compact — data-dense, minimal padding", "Default — balanced", "Spacious — generous whitespace"]
    }
  ]
}
</question-form>
```

### Bước 2: Phân tích & lập palette

Agent đọc `references/direction-library.md` để map visual direction → concrete tokens:

- **Neumorphism** → dual soft shadows, monochrome background, low contrast
- **Glassmorphism** → backdrop-filter blur, rgba backgrounds, border highlights
- **Material** → elevation shadows, bold saturated colors, motion curves
- Etc.

Tạo **color palette** với OKLch values:
```
--bg:      oklch(98% 0.004 240)    // neutral background
--surface: oklch(100% 0 0)         // card/panel surface
--fg:      oklch(18% 0.012 240)    // primary text
--muted:   oklch(54% 0.012 240)    // secondary text
--border:  oklch(92% 0.005 240)    // dividers
--accent:  oklch(58% 0.18 255)     // primary action color
```

### Bước 3: Tạo 7 UI_THEME nodes

**Hard rule:** Mỗi composition PHẢI có đúng 7 themes, mỗi axis 1 theme.

Agent tạo Cypher query:

```cypher
// 1. Brand theme
CREATE (brand:UI_THEME {
  id: 'theme-vnpay-emerald-brand',
  name: 'VNPAY Emerald Brand',
  slug: 'vnpay-emerald-brand',
  kind: 'brand',
  description: 'Emerald green payment brand with trust signals',
  authored: true,
  createdAt: datetime(),
  updatedAt: datetime()
})

// 2. Typography theme
CREATE (typo:UI_THEME {
  id: 'theme-modern-geist-type',
  name: 'Modern Geist Type',
  slug: 'modern-geist-type',
  kind: 'typography',
  description: 'Geist Sans display + Geist Mono code',
  authored: true
})

// 3. Spacing theme
CREATE (spacing:UI_THEME {
  id: 'theme-default-spacing',
  name: 'Default Spacing',
  slug: 'default-spacing',
  kind: 'spacing',
  description: '4px base, 1.5 scale',
  authored: true
})

// 4. Icon theme
CREATE (icon:UI_THEME {
  id: 'theme-lucide-outline',
  name: 'Lucide Outline',
  slug: 'lucide-outline',
  kind: 'icon',
  description: 'Lucide icon set, 24px default',
  authored: true
})

// 5. Visual theme
CREATE (visual:UI_THEME {
  id: 'theme-payment-glass-pro',
  name: 'Payment Glass Pro',
  slug: 'payment-glass-pro',
  kind: 'visual',
  description: 'Frosted glass panels, subtle elevation',
  authored: true
})

// 6. Control Density theme
CREATE (control:UI_THEME {
  id: 'theme-default-controls',
  name: 'Default Controls',
  slug: 'default-controls',
  kind: 'control-density',
  description: 'Balanced control sizes, 44px touch targets',
  authored: true
})

// 7. Rounded theme
CREATE (rounded:UI_THEME {
  id: 'theme-soft-rounded',
  name: 'Soft Rounded',
  slug: 'soft-rounded',
  kind: 'rounded',
  description: '12px default border-radius',
  authored: true
})

RETURN brand, typo, spacing, icon, visual, control, rounded
```

### Bước 4: Kết nối Axes → Themes (HAS_THEME)

```cypher
// Tìm 7 axes có sẵn
MATCH (axisBrand:UI_THEME_AXIS {kind: 'brand'})
MATCH (axisTypo:UI_THEME_AXIS {kind: 'typography'})
MATCH (axisSpacing:UI_THEME_AXIS {kind: 'spacing'})
MATCH (axisIcon:UI_THEME_AXIS {kind: 'icon'})
MATCH (axisVisual:UI_THEME_AXIS {kind: 'visual'})
MATCH (axisControl:UI_THEME_AXIS {kind: 'control-density'})
MATCH (axisRounded:UI_THEME_AXIS {kind: 'rounded'})

// Tìm 7 themes vừa tạo
MATCH (brand:UI_THEME {slug: 'vnpay-emerald-brand'})
MATCH (typo:UI_THEME {slug: 'modern-geist-type'})
MATCH (spacing:UI_THEME {slug: 'default-spacing'})
MATCH (icon:UI_THEME {slug: 'lucide-outline'})
MATCH (visual:UI_THEME {slug: 'payment-glass-pro'})
MATCH (control:UI_THEME {slug: 'default-controls'})
MATCH (rounded:UI_THEME {slug: 'soft-rounded'})

// Tạo HAS_THEME relationships
CREATE (axisBrand)-[:HAS_THEME]->(brand)
CREATE (axisTypo)-[:HAS_THEME]->(typo)
CREATE (axisSpacing)-[:HAS_THEME]->(spacing)
CREATE (axisIcon)-[:HAS_THEME]->(icon)
CREATE (axisVisual)-[:HAS_THEME]->(visual)
CREATE (axisControl)-[:HAS_THEME]->(control)
CREATE (axisRounded)-[:HAS_THEME]->(rounded)

RETURN axisBrand, axisTypo, axisSpacing, axisIcon, axisVisual, axisControl, axisRounded
```

### Bước 5: Tạo UI_THEME_COMPOSITION node

```cypher
CREATE (comp:UI_THEME_COMPOSITION {
  id: 'composition-vnpay-emerald',
  name: 'VNPAY Emerald',
  slug: 'vnpay-emerald',
  description: 'Emerald green payment brand with glassmorphic visual treatment',
  authored: true,
  createdAt: datetime(),
  updatedAt: datetime()
})

// Tìm 7 themes
MATCH (brand:UI_THEME {slug: 'vnpay-emerald-brand'})
MATCH (typo:UI_THEME {slug: 'modern-geist-type'})
MATCH (spacing:UI_THEME {slug: 'default-spacing'})
MATCH (icon:UI_THEME {slug: 'lucide-outline'})
MATCH (visual:UI_THEME {slug: 'payment-glass-pro'})
MATCH (control:UI_THEME {slug: 'default-controls'})
MATCH (rounded:UI_THEME {slug: 'soft-rounded'})

// Kết nối USES_THEME
CREATE (comp)-[:USES_THEME]->(brand)
CREATE (comp)-[:USES_THEME]->(typo)
CREATE (comp)-[:USES_THEME]->(spacing)
CREATE (comp)-[:USES_THEME]->(icon)
CREATE (comp)-[:USES_THEME]->(visual)
CREATE (comp)-[:USES_THEME]->(control)
CREATE (comp)-[:USES_THEME]->(rounded)

RETURN comp
```

### Bước 6: Tạo UI_TOKEN_VALUE với themeId binding

**CRITICAL:** Token values KHÔNG dùng relationship, dùng property `themeId`.

```cypher
// Tìm token color.bg
MATCH (token:UI_TOKEN {domain: 'color', slug: 'bg'})
MATCH (modeLight:UI_MODE {slug: 'light'})
MATCH (modeDark:UI_MODE {slug: 'dark'})

// Tạo value cho Light mode
CREATE (vLight:UI_TOKEN_VALUE {
  id: 'val-vnpay-emerald-brand-color-bg-light',
  themeId: 'theme-vnpay-emerald-brand',  // ← QUAN TRỌNG
  rawValue: 'oklch(98% 0.004 160)',
  resolvedValue: 'oklch(98% 0.004 160)',
  authored: true,
  createdAt: datetime()
})

// Tạo value cho Dark mode
CREATE (vDark:UI_TOKEN_VALUE {
  id: 'val-vnpay-emerald-brand-color-bg-dark',
  themeId: 'theme-vnpay-emerald-brand',
  rawValue: 'oklch(12% 0.008 160)',
  resolvedValue: 'oklch(12% 0.008 160)',
  authored: true
})

// Kết nối relationships
CREATE (vLight)-[:FOR_TOKEN]->(token)
CREATE (vLight)-[:IN_MODE]->(modeLight)
CREATE (vDark)-[:FOR_TOKEN]->(token)
CREATE (vDark)-[:IN_MODE]->(modeDark)

RETURN vLight, vDark
```

**Repeat** cho tất cả tokens cần thiết:
- Color tokens: `bg`, `surface`, `fg`, `muted`, `border`, `accent`, `accent-fg`, `destructive`, `success`, `warning`
- Spacing tokens: `xs`, `sm`, `md`, `lg`, `xl`, `2xl`, `3xl`
- Typography tokens: `font-display`, `font-body`, `font-mono`, `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl`
- Visual tokens: `shadow-sm`, `shadow-md`, `shadow-lg`, `blur-sm`, `blur-md`, `border-width`
- Control tokens: `control-height-sm`, `control-height-md`, `control-height-lg`, `control-padding`
- Rounded tokens: `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-full`

### Bước 7: Gắn composition vào Workspace

```cypher
MATCH (ws:UI_WORKSPACE {slug: 'ws-od-prototypes'})
MATCH (comp:UI_THEME_COMPOSITION {slug: 'vnpay-emerald'})

MERGE (ws)-[:WORKSPACE_COMPOSITION]->(comp)

RETURN ws, comp
```

### Bước 8: Verify & Lint

Agent chạy validation queries:

```cypher
// 1. Kiểm tra composition có đủ 7 themes không
MATCH (comp:UI_THEME_COMPOSITION {slug: 'vnpay-emerald'})-[:USES_THEME]->(theme)
WITH comp, collect(theme.kind) AS kinds
RETURN comp.name, size(kinds) AS themeCount, kinds
// Expected: themeCount = 7, kinds = ['brand', 'typography', 'spacing', 'icon', 'visual', 'control-density', 'rounded']

// 2. Kiểm tra mỗi theme có token values không
MATCH (comp:UI_THEME_COMPOSITION {slug: 'vnpay-emerald'})-[:USES_THEME]->(theme)
OPTIONAL MATCH (val:UI_TOKEN_VALUE {themeId: theme.id})
WITH theme, count(val) AS valueCount
RETURN theme.name, theme.kind, valueCount
ORDER BY theme.kind

// 3. Kiểm tra có token nào thiếu Light/Dark mode không
MATCH (val:UI_TOKEN_VALUE)-[:FOR_TOKEN]->(token)
WHERE val.themeId STARTS WITH 'theme-vnpay-emerald'
MATCH (val)-[:IN_MODE]->(mode)
WITH token, collect(DISTINCT mode.slug) AS modes
WHERE size(modes) < 2
RETURN token.domain + '.' + token.slug AS tokenPath, modes
// Expected: empty result (mỗi token phải có cả Light và Dark)
```

### Bước 9: Generate preview artifact (optional)

Nếu user muốn xem preview, agent tạo một HTML artifact sử dụng composition:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>VNPAY Emerald — Theme Preview</title>
  <style>
    :root {
      --bg: oklch(98% 0.004 160);
      --surface: oklch(100% 0 0);
      --fg: oklch(18% 0.012 160);
      --accent: oklch(52% 0.16 160);
      /* ... all tokens ... */
    }
    html.dark {
      --bg: oklch(12% 0.008 160);
      --surface: oklch(16% 0.01 160);
      --fg: oklch(94% 0.008 160);
      /* ... dark tokens ... */
    }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: 'Geist Sans', system-ui, sans-serif;
      padding: 2rem;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--rounded-md);
      padding: 1.5rem;
      box-shadow: var(--shadow-sm);
    }
    .button {
      background: var(--accent);
      color: var(--accent-fg);
      border: none;
      padding: var(--control-padding);
      height: var(--control-height-md);
      border-radius: var(--rounded-md);
      font-weight: 500;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <h1>VNPAY Emerald Theme Preview</h1>
  <div class="card">
    <h2>Card Title</h2>
    <p>This is a preview of the VNPAY Emerald composition.</p>
    <button class="button">Primary Action</button>
  </div>
  <script>
    // Toggle dark mode
    document.addEventListener('keydown', e => {
      if (e.key === 'd') document.documentElement.classList.toggle('dark');
    });
  </script>
</body>
</html>
```

## Output discipline

Agent **KHÔNG viết Cypher queries trực tiếp vào chat**. Thay vào đó:

1. **Tạo file `theme-composition-script.cypher`** chứa tất cả queries
2. **Giải thích từng bước** bằng tiếng Việt
3. **Chạy queries qua MCP `kg_cypher_read`** (read-only check) hoặc hướng dẫn user chạy bằng Neo4j Browser
4. **Emit artifact** nếu có preview HTML

## Checklist — Agent tự kiểm tra trước khi emit

- [ ] Composition có đúng 7 themes (mỗi axis 1)?
- [ ] Mỗi theme có `id`, `slug`, `name`, `kind`, `authored: true`?
- [ ] Tất cả themes đã kết nối với axes qua `HAS_THEME`?
- [ ] Composition đã kết nối với 7 themes qua `USES_THEME`?
- [ ] Composition đã gắn vào workspace qua `WORKSPACE_COMPOSITION`?
- [ ] Mỗi token value có `themeId` trỏ đúng theme?
- [ ] Mỗi token value có `rawValue` với đơn vị cụ thể (oklch/px/rem)?
- [ ] Mỗi token value có `authored: true`?
- [ ] Mỗi token có cả Light và Dark mode values?
- [ ] Đã chạy verification queries và pass?
- [ ] File `.cypher` đã được format đẹp với comments?

## Best Practices

### ✅ DO

- **Dùng lại infrastructure:** Workspace, Axes, Tokens, Modes đã có sẵn
- **Tạo themes độc lập:** Mỗi theme có thể mix & match với themes khác
- **OKLch cho colors:** `oklch(L% C H)` — perceptually uniform
- **Relative units:** `rem` cho spacing/typography, `px` khi cần absolute
- **Semantic naming:** `theme-vnpay-emerald-brand`, không phải `theme-1` hay `green-theme`
- **Light/Dark parity:** Mỗi token PHẢI có cả 2 mode values
- **Verify trước khi ship:** Chạy 3 validation queries ở Bước 8

### ❌ DON'T

- **Tạo axes mới:** 7 axes đã cố định, không thêm/bớt
- **Tạo tokens mới:** Dùng catalog tokens có sẵn; chỉ tạo values
- **Dùng relationship cho themeId:** Property `themeId` trên UI_TOKEN_VALUE, KHÔNG relationship
- **Hardcode hex colors:** Dùng OKLch để dễ derive variants
- **Bỏ qua Dark mode:** Mỗi composition phải support cả 2 modes
- **Duplicate theme slugs:** Mỗi slug phải unique trong workspace
- **Quên `authored: true`:** Nodes do agent tạo phải có flag này

## References

- `references/direction-library.md` — 6 visual directions với palette templates
- `references/token-catalog.md` — Danh sách tokens có sẵn (color, spacing, typography, visual, control, rounded)
- `references/example-compositions.md` — 3 composition examples (Neumorphism, Glassmorphism, Editorial)
- `references/cypher-patterns.md` — Common Cypher query patterns
- `references/validation-queries.md` — Verification & debugging queries

## Compose với skills khác

- **react-shadcn** — Render preview của composition bằng React + Tailwind
- **taste-skill** — Creative direction cho visual themes
- **figma-generate-library** — Export composition sang Figma variables/styles
- **html-prototype** — Tạo static HTML prototype với composition tokens
