# F-07: Discovery Form (Turn-1) — Business Logic

## Overview

Before the agent writes a single pixel, the system emits an **Interactive Discovery Form** to gather design intent from the user ("locking the brief"). This is followed optionally by a **Visual Direction Picker** (Turn-2) when brand context is absent. The 5-dimensional self-critique runs after artifact generation.

---

## Business Rules

### Discovery Form (Turn-1)

| Rule | Detail |
|------|--------|
| **BR-01** | The discovery form is emitted as an SSE event `question_form` at the start of Turn-1 |
| **BR-02** | The form gathers: surface, audience, tone, brand context, scale, constraints |
| **BR-03** | Maximum 8 fields in the form — no cognitive overload |
| **BR-04** | User submits form answers before agent starts generating |
| **BR-05** | Projects with `skipDiscoveryBrief: true` skip the form entirely (for batch/API use) |

### Form Fields

| Field | Type | Options / Description |
|-------|------|----------------------|
| `surface` | radio | `desktop` \| `mobile` \| `tablet` |
| `audience` | text | Who is this for? |
| `tone` | radio | `formal` \| `casual` \| `playful` \| `professional` |
| `brand_context` | text | Brand colors, fonts, existing assets |
| `scale` | radio | `1-page` \| `multi-page` \| `full-app` |
| `constraints` | text | Technical constraints |

### Visual Direction Picker (Turn-2)

| Rule | Detail |
|------|--------|
| **BR-06** | Direction Picker is emitted when user has no specific brand — emitted as `direction_picker` SSE event |
| **BR-07** | 5 visual directions with OKLch palettes and font stacks are offered |
| **BR-08** | After selection, the agent uses the OKLch palette — no freestyle color selection |
| **BR-09** | Font stack is applied consistently across the entire artifact |
| **BR-10** | The palette is referenced in the artifact's CSS |

### Direction Definitions

| Direction | OKLch Palette | Font Stack |
|-----------|--------------|------------|
| Editorial Monocle | Charcoal + cream + gold | Playfair Display + Inter |
| Modern Minimal | White + near-black + electric | Inter + Roboto Mono |
| Warm Soft | Blush + ivory + terracotta | Lora + DM Sans |
| Tech Utility | Deep navy + cyan + slate | JetBrains Mono + Inter |
| Brutalist Experimental | Black + neon lime + raw white | Space Grotesk |

### Junior-Designer Mode (huashu-design philosophy)

| Rule | Detail |
|------|--------|
| **BR-11** | Batch all questions upfront — never self-assume missing info mid-turn |
| **BR-12** | Show something visible early (even a wireframe with grey blocks is acceptable) |
| **BR-13** | Redirects are cheap — one chat round to change direction is acceptable |

### 5-Dimensional Self-Critique

| Rule | Detail |
|------|--------|
| **BR-14** | After artifact generation, agent runs a self-critique across 5 dimensions |
| **BR-15** | Self-critique is part of the DISCOVERY directive injected into the prompt |
| **BR-16** | Critique is internal — agent revises artifact based on its own assessment |

| Dimension | Check Question |
|-----------|---------------|
| **Philosophy** | Does the design match the brief and philosophy? |
| **Hierarchy** | Is visual hierarchy clear? Does the user know where to look? |
| **Detail** | Are color, spacing, typography consistent? |
| **Function** | Is the artifact actually usable? Do interactions work? |
| **Innovation** | Is there something new, memorable, beyond templates? |

### Anti-AI-Slop Identity Charter

| Rule | Detail |
|------|--------|
| **BR-17** | No stock photo placeholders |
| **BR-18** | No generic "Lorem ipsum" content |
| **BR-19** | No generic colors (red, blue, green) — must use palette tokens |
| **BR-20** | No "minimum viable" code — must be premium |
| **BR-21** | No `// TODO: implement this` comments |
| **BR-22** | Agent persona: **senior product designer** with focus on aesthetics, micro-interactions, and design token precision |

---

## Acceptance Criteria

- [ ] Form emitted as Turn-1 SSE event before any code generation
- [ ] User submits form, agent proceeds with answers as context
- [ ] Agent generates initial todo plan after form submission
- [ ] Direction Picker shows color palette preview per direction
- [ ] After direction selection, artifact uses defined OKLch palette (no freestyle)
- [ ] Self-critique occurs across all 5 dimensions after artifact creation
- [ ] Form limited to max 8 fields
