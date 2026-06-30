# Direction Library — Visual Palettes

6 visual directions với ready-to-use OKLch palettes. Agent pick direction dựa trên user brief, copy palette vào token values.

---

## 1. Neumorphism — Soft Tactile

**Mood:** Monochrome background với dual soft shadows (light from top-left). Low contrast, subtle depth.

**When:** UI tools, dashboards, skeuomorphic apps, accessibility-aware contexts.

**Palette (Light mode):**
```css
--bg:      oklch(94% 0.004 240)   /* soft grey canvas */
--surface: oklch(94% 0.004 240)   /* same as bg for neumorphic effect */
--fg:      oklch(28% 0.012 240)   /* dark grey text */
--muted:   oklch(52% 0.010 240)   /* muted text */
--border:  oklch(88% 0.006 240)   /* subtle border */
--accent:  oklch(56% 0.14 220)    /* single blue accent */

/* Neumorphic shadows */
--shadow-extruded: 8px 8px 16px oklch(88% 0.006 240), -8px -8px 16px oklch(100% 0 0)
--shadow-debossed: inset 4px 4px 8px oklch(88% 0.006 240), inset -4px -4px 8px oklch(100% 0 0)
```

**Palette (Dark mode):**
```css
--bg:      oklch(18% 0.008 240)
--surface: oklch(18% 0.008 240)
--fg:      oklch(92% 0.006 240)
--muted:   oklch(62% 0.010 240)
--border:  oklch(26% 0.010 240)
--accent:  oklch(64% 0.16 220)

--shadow-extruded: 6px 6px 12px oklch(12% 0.010 240), -6px -6px 12px oklch(24% 0.010 240)
--shadow-debossed: inset 4px 4px 8px oklch(12% 0.010 240), inset -4px -4px 8px oklch(24% 0.010 240)
```

**Typography:** Clean sans-serif, medium weight, generous letter-spacing

**Borders:** Rounded (12-16px), no hard edges

**Control Density:** Spacious (48px+ heights, ample padding)

---

## 2. Glassmorphism — Frosted Depth

**Mood:** Translucent layers, frosted glass, depth via blur + transparency. Colorful gradients behind.

**When:** Modern SaaS, creative tools, marketing pages, iOS-inspired apps.

**Palette (Light mode):**
```css
--bg:      oklch(98% 0.008 240)   /* light neutral */
--surface: oklch(100% 0 0 / 0.7)  /* translucent white */
--fg:      oklch(18% 0.014 240)   /* deep text */
--muted:   oklch(48% 0.012 240)
--border:  oklch(100% 0 0 / 0.18) /* subtle white border */
--accent:  oklch(58% 0.20 255)    /* vibrant blue */

/* Glassmorphic effects */
--blur:    blur(12px)
--backdrop: blur(16px) saturate(180%)
--surface-glass: oklch(100% 0 0 / 0.7)
--border-glass:  oklch(100% 0 0 / 0.18)
```

**Palette (Dark mode):**
```css
--bg:      oklch(14% 0.010 240)
--surface: oklch(20% 0.014 240 / 0.6)
--fg:      oklch(96% 0.006 240)
--muted:   oklch(64% 0.012 240)
--border:  oklch(100% 0 0 / 0.1)
--accent:  oklch(68% 0.22 255)

--backdrop: blur(20px) saturate(200%)
```

**Typography:** System fonts (SF Pro, Inter), medium-tight tracking

**Borders:** Soft rounded (8-12px), translucent white borders

**Control Density:** Default (44px touch targets)

---

## 3. Material Design — Bold Elevation

**Mood:** Strong saturated colors, elevation shadows, motion-driven.

**When:** Android apps, Google-inspired products, data-heavy dashboards.

**Palette (Light mode):**
```css
--bg:      oklch(100% 0 0)        /* pure white */
--surface: oklch(98% 0.002 240)   /* subtle grey */
--fg:      oklch(13% 0.016 240)   /* near-black */
--muted:   oklch(42% 0.012 240)
--border:  oklch(90% 0.006 240)
--accent:  oklch(54% 0.24 264)    /* bold indigo */

/* Material elevation */
--shadow-1: 0 1px 2px oklch(0% 0 0 / 0.06), 0 1px 3px oklch(0% 0 0 / 0.1)
--shadow-2: 0 4px 6px oklch(0% 0 0 / 0.07), 0 2px 4px oklch(0% 0 0 / 0.06)
--shadow-8: 0 10px 15px oklch(0% 0 0 / 0.1), 0 4px 6px oklch(0% 0 0 / 0.05)
```

**Palette (Dark mode):**
```css
--bg:      oklch(12% 0.012 240)
--surface: oklch(18% 0.014 240)
--fg:      oklch(98% 0.004 240)
--muted:   oklch(68% 0.010 240)
--border:  oklch(28% 0.012 240)
--accent:  oklch(64% 0.26 264)
```

**Typography:** Roboto / Product Sans, strong weight contrast (300/500/700)

**Borders:** Sharp (4px) or pill (9999px), no middle ground

**Control Density:** Compact-to-default (40-48px)

---

## 4. iOS HIG — Clean System

**Mood:** SF Pro fonts, system colors, restrained, accessibility-first.

**When:** iOS apps, Apple-adjacent products, minimalist tools.

**Palette (Light mode):**
```css
--bg:      oklch(100% 0 0)
--surface: oklch(98% 0.002 0)
--fg:      oklch(0% 0 0)          /* true black */
--muted:   oklch(60% 0.004 240)
--border:  oklch(92% 0.004 240)
--accent:  oklch(52% 0.18 250)    /* iOS blue */

/* iOS system colors */
--destructive: oklch(58% 0.22 25)  /* red */
--success:     oklch(62% 0.16 145) /* green */
--warning:     oklch(68% 0.20 80)  /* orange */
```

**Palette (Dark mode):**
```css
--bg:      oklch(0% 0 0)
--surface: oklch(16% 0.006 240)
--fg:      oklch(100% 0 0)
--muted:   oklch(70% 0.006 240)
--border:  oklch(24% 0.008 240)
--accent:  oklch(62% 0.20 250)
```

**Typography:** SF Pro Display/Text, system-ui fallback, tight tracking

**Borders:** Rounded (10px default), hairline dividers (0.5px)

**Control Density:** Default (44px minimum touch targets per HIG)

---

## 5. Editorial — Print Magazine

**Mood:** Serif headlines, generous whitespace, restrained palette (neutral + one accent).

**When:** Publishing, content-first apps, editorial tools, long-form reading.

**Palette (Light mode):**
```css
--bg:      oklch(98% 0.004 95)    /* warm off-white */
--surface: oklch(100% 0.002 95)   /* paper white */
--fg:      oklch(20% 0.018 70)    /* ink black */
--muted:   oklch(48% 0.012 70)
--border:  oklch(90% 0.006 95)
--accent:  oklch(52% 0.10 28)     /* muted red */

/* Editorial spacing */
--leading: 1.75                   /* generous line-height */
--measure: 68ch                   /* optimal reading width */
```

**Palette (Dark mode):**
```css
--bg:      oklch(12% 0.008 70)
--surface: oklch(16% 0.010 70)
--fg:      oklch(96% 0.006 70)
--muted:   oklch(64% 0.012 70)
--border:  oklch(24% 0.010 70)
--accent:  oklch(62% 0.12 28)
```

**Typography:** 
- Display: Iowan Old Style, Charter, Georgia (serif)
- Body: System sans-serif for UI, serif for long-form
- Mono: For metadata/captions only

**Borders:** Hairline (1px) or none, no rounded cards

**Control Density:** Spacious (generous padding, one idea per screen)

---

## 6. Brutalist — Experimental Grid

**Mood:** Loud type, visible grid, mono body, system sans display, deliberately ugly.

**When:** Art/indie projects, agency sites, manifestos, intentionally anti-corporate.

**Palette (Light mode):**
```css
--bg:      oklch(98% 0.004 240)
--surface: oklch(100% 0 0)
--fg:      oklch(15% 0.02 100)    /* strong black */
--muted:   oklch(40% 0.02 100)
--border:  oklch(15% 0.02 100)    /* borders = fg color */
--accent:  oklch(60% 0.22 25)     /* loud red */

/* Brutalist posture */
--border-weight: 2px              /* thick borders */
--grid-visible: 1px dashed oklch(15% 0.02 100 / 0.15)
```

**Palette (Dark mode):**
```css
--bg:      oklch(8% 0.008 100)
--surface: oklch(12% 0.010 100)
--fg:      oklch(98% 0.008 100)
--muted:   oklch(68% 0.014 100)
--border:  oklch(98% 0.008 100)
--accent:  oklch(68% 0.24 25)
```

**Typography:**
- Display: Times New Roman, Georgia (serif at extreme sizes)
- Body: ui-monospace, IBM Plex Mono (monospace)
- Size: clamp(80px, 12vw, 200px) for headlines

**Borders:** Full-strength (1.5-2px), zero radius, asymmetric layouts

**Control Density:** Variable (intentionally inconsistent)

---

## Usage in Workflow

Agent maps user's `visualDirection` answer to one of these 6 palettes:

1. Read user brief → identify direction keyword (neumorphic, glass, material, ios, editorial, brutalist)
2. Copy matching palette above **verbatim** into `UI_TOKEN_VALUE.rawValue`
3. Adjust only the `--accent` hue if user provided a specific color
4. Keep L/C values intact for perceptual consistency
5. Generate Dark mode by shifting Lightness (L):
   - Light bg: 94-100% → Dark bg: 8-18%
   - Light fg: 13-28% → Dark fg: 92-100%
   - Accent: shift +6-10% lightness in dark mode

**Example:**
```
User: "Tạo composition Glassmorphism với màu xanh dương Stripe"
Agent: → Pick direction #2 (Glassmorphism)
       → Copy palette, adjust --accent hue from 255 to 250 (Stripe blue)
       → Keep L=58%, C=0.20 (perceptually consistent)
```
