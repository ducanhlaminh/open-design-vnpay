# Token Catalog — Available Tokens

Danh sách tokens có sẵn trong KG. Agent **KHÔNG tạo tokens mới**, chỉ tạo `UI_TOKEN_VALUE` với `themeId` pointing to theme.

---

## Color Tokens (domain: `color`)

Mỗi token PHẢI có value cho cả Light và Dark mode.

| Slug | Purpose | Light Example | Dark Example |
|------|---------|---------------|--------------|
| `bg` | Page background | `oklch(98% 0.004 240)` | `oklch(12% 0.008 240)` |
| `surface` | Card/panel surface | `oklch(100% 0 0)` | `oklch(16% 0.010 240)` |
| `fg` | Primary text | `oklch(18% 0.012 240)` | `oklch(94% 0.008 240)` |
| `muted` | Secondary text | `oklch(54% 0.012 240)` | `oklch(62% 0.010 240)` |
| `border` | Dividers, outlines | `oklch(92% 0.005 240)` | `oklch(26% 0.010 240)` |
| `accent` | Primary action color | `oklch(58% 0.18 255)` | `oklch(64% 0.20 255)` |
| `accent-fg` | Text on accent bg | `oklch(100% 0 0)` | `oklch(100% 0 0)` |
| `destructive` | Danger/error color | `oklch(58% 0.22 25)` | `oklch(64% 0.24 25)` |
| `destructive-fg` | Text on destructive | `oklch(100% 0 0)` | `oklch(100% 0 0)` |
| `success` | Success states | `oklch(62% 0.16 145)` | `oklch(68% 0.18 145)` |
| `success-fg` | Text on success | `oklch(100% 0 0)` | `oklch(100% 0 0)` |
| `warning` | Warning states | `oklch(68% 0.20 80)` | `oklch(72% 0.22 80)` |
| `warning-fg` | Text on warning | `oklch(18% 0.012 80)` | `oklch(18% 0.012 80)` |
| `muted-bg` | Subtle backgrounds | `oklch(96% 0.004 240)` | `oklch(20% 0.010 240)` |
| `muted-fg` | Text on muted-bg | `oklch(54% 0.012 240)` | `oklch(62% 0.010 240)` |

**Value format:** Always use OKLch — `oklch(L% C H)` or `oklch(L% C H / A)`

---

## Spacing Tokens (domain: `spacing`)

Mỉnh định 8-point grid với 1.5 scale ratio (hoặc custom).

| Slug | Default Value | Purpose |
|------|---------------|---------|
| `xs` | `0.5rem` (8px) | Tiny gaps, icon padding |
| `sm` | `0.75rem` (12px) | Compact spacing |
| `md` | `1rem` (16px) | Default spacing |
| `lg` | `1.5rem` (24px) | Section padding |
| `xl` | `2rem` (32px) | Large gaps |
| `2xl` | `3rem` (48px) | Page margins |
| `3xl` | `4rem` (64px) | Hero sections |
| `4xl` | `6rem` (96px) | Extra large |

**Value format:** Use `rem` (relative) hoặc `px` (absolute). Dark mode: same values.

---

## Typography Tokens (domain: `typography`)

Font families + size scale.

### Font Family Tokens

| Slug | Purpose | Light/Dark Value Example |
|------|---------|--------------------------|
| `font-display` | Headlines | `"Geist Sans", -apple-system, system-ui, sans-serif` |
| `font-body` | Body text | `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` |
| `font-mono` | Code, numbers | `ui-monospace, "JetBrains Mono", "IBM Plex Mono", Menlo, monospace` |

### Font Size Tokens

| Slug | Default Value | Usage |
|------|---------------|-------|
| `text-xs` | `0.75rem` (12px) | Captions, metadata |
| `text-sm` | `0.875rem` (14px) | Secondary text |
| `text-base` | `1rem` (16px) | Body text |
| `text-lg` | `1.125rem` (18px) | Large body |
| `text-xl` | `1.25rem` (20px) | Subheadings |
| `text-2xl` | `1.5rem` (24px) | Section titles |
| `text-3xl` | `1.875rem` (30px) | Page titles |
| `text-4xl` | `2.25rem` (36px) | Hero headlines |
| `text-5xl` | `3rem` (48px) | Display |
| `text-6xl` | `3.75rem` (60px) | Large display |

### Line Height Tokens

| Slug | Value | Purpose |
|------|-------|---------|
| `leading-none` | `1` | Tight headlines |
| `leading-tight` | `1.25` | Display text |
| `leading-normal` | `1.5` | Body text |
| `leading-relaxed` | `1.75` | Long-form reading |

**Value format:** Font families as CSS string, sizes as `rem`, line-heights as unitless ratio.

---

## Visual Tokens (domain: `visual`)

Shadows, blur, border-width.

### Shadow Tokens

| Slug | Light Value | Dark Value |
|------|-------------|------------|
| `shadow-sm` | `0 1px 2px oklch(0% 0 0 / 0.05)` | `0 1px 2px oklch(0% 0 0 / 0.3)` |
| `shadow-md` | `0 4px 6px oklch(0% 0 0 / 0.1), 0 2px 4px oklch(0% 0 0 / 0.06)` | `0 4px 6px oklch(0% 0 0 / 0.4), 0 2px 4px oklch(0% 0 0 / 0.2)` |
| `shadow-lg` | `0 10px 15px oklch(0% 0 0 / 0.1), 0 4px 6px oklch(0% 0 0 / 0.05)` | `0 10px 15px oklch(0% 0 0 / 0.5), 0 4px 6px oklch(0% 0 0 / 0.3)` |
| `shadow-xl` | `0 20px 25px oklch(0% 0 0 / 0.15), 0 10px 10px oklch(0% 0 0 / 0.04)` | `0 20px 25px oklch(0% 0 0 / 0.6), 0 10px 10px oklch(0% 0 0 / 0.3)` |

### Blur Tokens

| Slug | Value | Purpose |
|------|-------|---------|
| `blur-sm` | `4px` | Subtle frosted glass |
| `blur-md` | `8px` | Default glassmorphism |
| `blur-lg` | `16px` | Heavy backdrop blur |
| `blur-xl` | `24px` | Extra heavy blur |

### Border Tokens

| Slug | Light Value | Dark Value |
|------|-------------|------------|
| `border-width` | `1px` | `1px` |
| `border-width-thick` | `2px` | `2px` |
| `border-color` | Reference `color.border` | Reference `color.border` |

**Value format:** CSS shadow strings, blur in `px`, border-width in `px`.

---

## Control Tokens (domain: `control-density`)

Interactive control sizes (buttons, inputs, selects).

| Slug | Compact | Default | Spacious |
|------|---------|---------|----------|
| `control-height-sm` | `32px` | `36px` | `44px` |
| `control-height-md` | `40px` | `44px` | `52px` |
| `control-height-lg` | `48px` | `56px` | `64px` |
| `control-padding-x` | `12px` | `16px` | `24px` |
| `control-padding-y` | `6px` | `8px` | `12px` |
| `control-gap` | `8px` | `12px` | `16px` |

**Value format:** `px` (absolute). Dark mode: same values.

---

## Rounded Tokens (domain: `rounded`)

Border-radius values.

| Slug | Sharp | Soft | Pill |
|------|-------|------|------|
| `rounded-sm` | `2px` | `4px` | `8px` |
| `rounded-md` | `4px` | `8px` | `12px` |
| `rounded-lg` | `6px` | `12px` | `16px` |
| `rounded-xl` | `8px` | `16px` | `20px` |
| `rounded-full` | `9999px` | `9999px` | `9999px` |

**Value format:** `px` or `9999px` for pill.

---

## Icon Tokens (domain: `icon`)

Icon library reference + sizing.

| Slug | Value | Purpose |
|------|-------|---------|
| `icon-library` | `"lucide"` or `"phosphor"` or `"heroicons"` | Which icon set to use |
| `icon-size-sm` | `16px` | Inline icons |
| `icon-size-md` | `24px` | Default |
| `icon-size-lg` | `32px` | Large icons |
| `icon-stroke-width` | `1.5px` or `2px` | Outline weight |

**Value format:** String for library, `px` for sizes.

---

## Usage in Workflow (Bước 6)

Agent iterates through ALL tokens trong catalog và tạo `UI_TOKEN_VALUE` cho từng theme cần values.

**Example:** Theme `theme-vnpay-emerald-brand` (kind: `brand`) cần color tokens:

```cypher
// 1. Find token
MATCH (token:UI_TOKEN {domain: 'color', slug: 'bg'})
MATCH (modeLight:UI_MODE {slug: 'light'})
MATCH (modeDark:UI_MODE {slug: 'dark'})

// 2. Create Light value
CREATE (vLight:UI_TOKEN_VALUE {
  id: 'val-vnpay-emerald-brand-color-bg-light',
  themeId: 'theme-vnpay-emerald-brand',
  rawValue: 'oklch(98% 0.004 160)',  // emerald-tinted neutral
  resolvedValue: 'oklch(98% 0.004 160)',
  authored: true,
  createdAt: datetime()
})

// 3. Create Dark value
CREATE (vDark:UI_TOKEN_VALUE {
  id: 'val-vnpay-emerald-brand-color-bg-dark',
  themeId: 'theme-vnpay-emerald-brand',
  rawValue: 'oklch(12% 0.008 160)',  // emerald-tinted dark
  resolvedValue: 'oklch(12% 0.008 160)',
  authored: true
})

// 4. Connect relationships
CREATE (vLight)-[:FOR_TOKEN]->(token)
CREATE (vLight)-[:IN_MODE]->(modeLight)
CREATE (vDark)-[:FOR_TOKEN]->(token)
CREATE (vDark)-[:IN_MODE]->(modeDark)
```

**Repeat** cho các tokens khác: `surface`, `fg`, `muted`, `border`, `accent`, etc.

---

## Token Count per Theme Kind

Estimate để agent biết cần tạo bao nhiêu values:

| Theme Kind | Typical Token Count | Which Domains |
|-----------|---------------------|---------------|
| `brand` | ~30 values (15 tokens × 2 modes) | `color.*` (all color tokens) |
| `typography` | ~20 values (10 tokens × 2 modes) | `typography.*` (fonts, sizes, leading) |
| `spacing` | ~16 values (8 tokens × 2 modes) | `spacing.*` |
| `icon` | ~10 values (5 tokens × 2 modes) | `icon.*` |
| `visual` | ~20 values (10 tokens × 2 modes) | `visual.*` (shadows, blur, borders) |
| `control-density` | ~12 values (6 tokens × 2 modes) | `control.*` |
| `rounded` | ~10 values (5 tokens × 2 modes) | `rounded.*` |

**Total per composition:** ~118 token values (59 tokens × 2 modes, distributed across 7 themes)

---

## Quick Reference — Token Path Format

Format: `{domain}.{slug}`

Examples:
- `color.bg` → background color
- `spacing.md` → default spacing
- `typography.font-display` → display font family
- `visual.shadow-md` → medium shadow
- `control.control-height-md` → default button height
- `rounded.rounded-md` → default border-radius
- `icon.icon-library` → which icon set

Agent uses this format when querying:
```cypher
MATCH (token:UI_TOKEN {domain: 'color', slug: 'bg'})
```
