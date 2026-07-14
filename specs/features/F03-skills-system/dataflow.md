# F-03: Skills System — Data Flow

## Skill Discovery Flow

```
Daemon starts
    │
    ▼
Scan skills/ directory
    │
    ▼
For each skills/<id>/SKILL.md:
    ├── Parse YAML frontmatter (od: block)
    ├── Extract: mode, platform, scenario, preview, featured, …
    └── Build SkillSummary { id, title, mode, scenario, featured, … }
    │
    ▼
Cache SkillSummary[] in memory
```

## API Data Flow

```
GET /api/skills
    └── → SkillSummary[] (list with metadata only)

GET /api/skills/:id
    └── → SkillDetail { ...summary, fullContent: string }

GET /api/skills/:id/example
    └── → Read skills/<id>/assets/example.html
        → Return HTML for iframe preview
```

## Skill Injection into Prompt (Pre-flight)

```
User submits first message in project
    │
    ▼
Daemon assembles prompt stack
    │
    ├── 1. DISCOVERY directives
    ├── 2. Identity charter
    ├── 3. Read active design system DESIGN.md → inject
    ├── 4. Read active SKILL.md → inject
    ├── 5. Project metadata (kind, fidelity, etc.)
    ├── 6. Read skills/<id>/assets/template.html → inject
    └── 7. Read skills/<id>/references/*.md → inject each
    │
    ▼
Complete prompt sent to agent
```

## Skill Filtering Flow

```
UI SkillPicker
    │
    ├── Load all skills: GET /api/skills
    │
    ├── Filter controls:
    │   ├── mode filter  (prototype | deck | image | ...)
    │   ├── platform filter (desktop | mobile)
    │   └── scenario filter (design | marketing | ...)
    │
    ├── Search by name (client-side text filter)
    │
    └── Display filtered grid
        └── Click skill card → Preview example.html
                            → Select skill for project
```

## Skill Directory Structure

```
skills/<skill-id>/
├── SKILL.md               ← frontmatter + instructions
├── assets/
│   ├── template.html      ← auto-injected into prompt
│   ├── example.html       ← served by GET /api/skills/:id/example
│   └── ...
└── references/
    ├── reference-1.md     ← auto-injected into prompt
    └── reference-2.md
```

## Data Models

```typescript
interface SkillSummary {
  id: string;
  title: string;
  mode: 'prototype' | 'deck' | 'image' | 'video' | 'audio' | 'template' | 'design-system' | 'utility';
  platform?: 'desktop' | 'mobile';
  scenario?: string;
  featured?: boolean;
  fidelity?: 'low' | 'medium' | 'high';
  speakerNotes?: boolean;
  animations?: boolean;
  examplePrompt?: string;
  preview?: { type: string };
  designSystem?: { requires: boolean };
  defaultFor?: string;
}

interface SkillDetail extends SkillSummary {
  fullContent: string;   // Full SKILL.md text
  hasTemplate: boolean;  // assets/template.html exists
  hasExample: boolean;   // assets/example.html exists
  references: string[];  // List of reference file names
}
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/skills` | List all skills with summary metadata |
| GET | `/api/skills/:id` | Full skill detail (SKILL.md content) |
| GET | `/api/skills/:id/example` | HTML example artifact for preview |
