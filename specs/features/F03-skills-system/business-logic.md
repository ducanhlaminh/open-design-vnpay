# F-03: Skills System — Business Logic

## Overview

Skills are design **workflow definitions** — each skill specifies a concrete output type (landing page, dashboard, mobile app, deck, etc.) with a prompt template, optional HTML template, and reference docs. Skills shape the agent's behavior before it writes a single line of code.

---

## Business Rules

| Rule | Detail |
|------|--------|
| **BR-01** | Each skill is defined by a `SKILL.md` file with a `od:` YAML frontmatter block |
| **BR-02** | Skills are discovered automatically from the `skills/` directory; no registration step needed |
| **BR-03** | Daemon restart is required when a new skill folder is added |
| **BR-04** | A skill's `assets/template.html` is **auto-injected** into the agent pre-flight prompt |
| **BR-05** | A skill's `references/*.md` are **auto-injected** into the agent pre-flight prompt |
| **BR-06** | Each skill has a `mode` that determines artifact rendering: `prototype`, `deck`, `image`, `video`, `audio`, `template`, `design-system`, `utility` |
| **BR-07** | Skills can be tagged with a `scenario` for filtering: `design`, `marketing`, `operation`, `engineering`, `product`, `finance`, `hr`, `sale`, `personal` |
| **BR-08** | Skills tagged `featured: true` appear prominently in the picker UI |
| **BR-09** | Skills with `design_system.requires: true` only function correctly when a design system is selected |
| **BR-10** | The `default_for` field designates a skill as the default for a given mode |
| **BR-11** | Disabled skills (listed in `AppConfig.disabledSkills`) are hidden from the catalog |

---

## Skill Frontmatter Schema

```yaml
od:
  mode: prototype | deck | image | video | audio | template | design-system | utility
  platform: desktop | mobile
  scenario: design | marketing | operation | engineering | product | finance | hr | sale | personal
  preview:
    type: html | deck | image | video | audio
  design_system:
    requires: boolean
  default_for: prototype | deck | ...
  featured: boolean
  fidelity: low | medium | high
  speaker_notes: boolean
  animations: boolean
  example_prompt: string
```

---

## Skill Catalog (by Mode)

### Prototype — Desktop (~32 skills)
`web-prototype`, `saas-landing`, `dashboard`, `frontend-design`, `platform-design`, `login-flow`, `faq-page`, `email-marketing`, `social-carousel`, `magazine-poster`, `ad-creative`, `pm-spec`, `eng-runbook`, `brainstorming`, `design-brief`, `data-report`, `finance-report`, `resume-modern`, `brand-guidelines`, …

### Prototype — Mobile (~5 skills)
`mobile-app`, `mobile-onboarding`, `gamified-app`, `flutter-animating-apps`, `swiftui-design`

### Deck (~9 skills)
`deck-guizang-editorial`, `deck-open-slide-canvas`, `deck-swiss-international`, `slides`, `frontend-slides`, `nanobanana-ppt`, `ppt-keynote`, `html-ppt-retro-quarterly-review`

### Media (Image, Video, Audio)
`imagegen`, `imagen`, `fal-generate`, `fal-image-edit`, `fal-upscale`, `fal-3d`, `fal-tryon`, `video-hyperframes`, `sora`, `fal-kling-o3`, `remotion`, `speech`, `venice-audio-speech`, `venice-audio-music`

### Figma Integration
`figma-generate-design`, `figma-implement-design`, `figma-create-design-system-rules`, `figma-generate-library`, `figma-create-new-file`, `figma-code-connect-components`, `figma-use`

### Animation (GSAP)
`gsap-core`, `gsap-scrolltrigger`, `gsap-timeline`, `gsap-plugins`, `gsap-frameworks`, `gsap-performance`, `gsap-react`

### HyperFrames / Motion Templates
`frame-data-chart-nyt`, `frame-flowchart-sticky`, `frame-glitch-title`, `frame-light-leak-cinema`, `frame-liquid-bg-hero`, `frame-logo-outro`, `frame-macos-notification`

### Utility
`design-review`, `competitive-ads-extractor`, `color-expert`, `enhance-prompt`, `creative-director`, `copywriting`, `marketing-psychology`, `domain-name-brainstormer`, `d3-visualization`, `threejs`, `shader-dev`, `hand-drawn-diagrams`, `algorithmic-art`, `screenshot`, `full-page-screenshot`, `kgs-knowledge`

### Social Media
`card-twitter`, `card-xiaohongshu`, `social-x-post-card`, `social-reddit-card`, `social-spotify-card`, `gif-sticker-maker`, `slack-gif-creator`

### Documents
`doc`, `doc-kami-parchment`, `docx`, `pdf`, `minimax-pdf`, `minimax-docx`

---

## Prompt Stack Injection Order

When a skill is active, the pre-flight injections happen in this order:

```
1. DISCOVERY directives
2. Identity charter
3. Active DESIGN.md        ← design system
4. Active SKILL.md         ← skill instructions
5. Project metadata
6. assets/template.html    ← auto-injected
7. references/*.md         ← auto-injected
8. (deck only) DECK_FRAMEWORK_DIRECTIVE
```

---

## Acceptance Criteria

- [ ] Grid view with thumbnail/preview for each skill
- [ ] Filter by mode, platform, scenario
- [ ] Search by skill name
- [ ] `example.html` renders in sandboxed iframe
- [ ] Skill context injected before agent starts (pre-flight)
- [ ] Template HTML from `assets/template.html` auto-injected
- [ ] Reference docs from `references/*.md` auto-injected
- [ ] Adding a new skill folder + daemon restart makes skill available
