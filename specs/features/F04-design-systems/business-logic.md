# F-04: Design Systems Library — Business Logic

## Overview

The Design Systems Library provides 150+ design system definitions encoded as **portable Markdown** (`DESIGN.md`) rather than JSON theme tokens. Each system is human-readable, forkable, and extensible. The selected design system is injected into the agent prompt stack before every generation turn.

---

## Business Rules

### Library Management

| Rule | Detail |
|------|--------|
| **BR-01** | Each design system is defined by a `DESIGN.md` file following the 9-section portable schema |
| **BR-02** | 150+ built-in systems span Tech/SaaS, AI/ML, Finance, Crypto, Consumer, E-commerce categories |
| **BR-03** | VNPay custom design system is under active development (Phase 2) |
| **BR-04** | User can create custom design systems via Settings → Design Systems → Create New |
| **BR-05** | Disabled design systems (in `AppConfig.disabledDesignSystems`) are hidden from pickers |

### Selection & Application

| Rule | Detail |
|------|--------|
| **BR-06** | Design system is selected per-project via `designSystemId` |
| **BR-07** | Switching design system **does not** delete project history |
| **BR-08** | On the next generation turn, the newly selected system's DESIGN.md is injected |
| **BR-09** | Artifacts from a prior system are not retroactively re-styled |

### Custom Design Systems

| Rule | Detail |
|------|--------|
| **BR-10** | Custom systems must follow the 9-section DESIGN.md schema (all sections required) |
| **BR-11** | User can upload brand assets (logo, fonts) as part of a custom system |
| **BR-12** | Color preview is shown in real-time during custom system creation |
| **BR-13** | Custom systems are stored in the user's local library |

### GitHub Import

| Rule | Detail |
|------|--------|
| **BR-14** | User can import a design system from a public GitHub repository |
| **BR-15** | The importer fetches the repo's `DESIGN.md`, parses it, and validates all 9 sections |
| **BR-16** | Invalid schema (missing sections) returns a clear validation error |

---

## DESIGN.md — 9-Section Schema

```markdown
## 1. Color System
## 2. Typography
## 3. Spacing & Layout
## 4. Component Library
## 5. Motion & Animation
## 6. Voice & Tone
## 7. Brand Assets
## 8. Anti-patterns
## 9. Iconography
```

All 9 sections must be present for a DESIGN.md to be considered valid.

---

## Built-in Design Systems

### Tech & SaaS
Linear, Stripe, Vercel, Supabase, Figma, GitHub, Notion, Sentry, PostHog, Raycast, Webflow, Sanity, Framer

### AI & ML
Anthropic, OpenAI, Cursor, Mistral AI, Perplexity, ElevenLabs

### Finance & Crypto
Revolut, Coinbase, Stripe

### Consumer
Apple, Spotify, Airbnb, Discord, Slack

### E-commerce & Platform
Shopify, Tesla, MongoDB

### VNPay Custom (Phase 2)
VNPay — Vietnamese fintech brand (in development)

---

## Prompt Stack Injection

The DESIGN.md of the active design system is injected at position 3 in the prompt stack:

```
1. DISCOVERY directives
2. Identity charter
3. → Active DESIGN.md    ← THIS
4. Active SKILL.md
5. Project metadata
6. Skill side files (template.html + references)
```

---

## Acceptance Criteria

- [ ] Display 150+ systems with color swatches (4 signature colors each)
- [ ] View full DESIGN.md content in detail modal
- [ ] Swatch grid for color palette
- [ ] Live showcase renders an artifact using the selected system's tokens
- [ ] Switch design system without deleting project history
- [ ] Create custom design system using the 9-section schema
- [ ] Import from GitHub repository
- [ ] Validate schema (all 9 sections required)
