# F-07: Discovery Form (Turn-1) — Data Flow

## Turn-1 Discovery Form Flow

```
User sends first message in project
    │
    ▼
Daemon assembles DISCOVERY directives (including turn-1 form spec)
    │
    ▼
Agent processes message → emits question_form event
    │
SSE event:
event: question_form
data: {
  "id": "discovery",
  "fields": [
    { "id": "surface", "type": "radio", "options": ["desktop","mobile","tablet"] },
    { "id": "audience", "type": "text", "placeholder": "Who is this for?" },
    { "id": "tone", "type": "radio", "options": ["formal","casual","playful","professional"] },
    { "id": "brand_context", "type": "text", "placeholder": "Brand colors, fonts, existing assets" },
    { "id": "scale", "type": "radio", "options": ["1-page","multi-page","full-app"] },
    { "id": "constraints", "type": "text", "placeholder": "Any technical constraints?" }
  ]
}
    │
    ▼
UI: Render QuestionForm component
    ├── Show all fields
    └── Wait for user to fill and submit
```

## Form Submission Flow

```
User fills discovery form → Submit
    │
    ▼
UI: Serialize form answers into structured message
    {
      surface: "desktop",
      audience: "SaaS product managers",
      tone: "professional",
      brand_context: "Blue #2563EB, Inter font",
      scale: "1-page",
      constraints: "No frameworks, vanilla HTML/CSS"
    }
    │
    ▼
POST /api/projects/:id/conversations/:cid/messages
    Body: { content: "Form answers: { surface: 'desktop', … }" }
    │
    ▼
Agent resumes → builds todo plan → starts generating artifact
```

## Direction Picker Flow (Turn-2)

```
Agent evaluates: user has no specific brand context
    │
    ▼
Agent emits direction_picker SSE event:

event: direction_picker
data: {
  "directions": [
    {
      "id": "editorial-monocle",
      "label": "Editorial Monocle",
      "palette": ["oklch(25% 0.02 240)", "oklch(95% 0.01 60)", "oklch(75% 0.15 85)"],
      "fonts": ["Playfair Display", "Inter"]
    },
    {
      "id": "modern-minimal",
      "label": "Modern Minimal",
      "palette": ["oklch(100% 0 0)", "oklch(10% 0 0)", "oklch(65% 0.20 250)"],
      "fonts": ["Inter", "Roboto Mono"]
    },
    …
  ]
}
    │
    ▼
UI: Render DirectionPicker component
    ├── Show 5 direction cards with color swatches
    └── Wait for user to select one
    │
User selects direction
    │
    ▼
UI: Submit selection as message
    │
    ▼
Agent: uses selected OKLch palette and font stack
    → No freestyle color selection allowed
    → Palette referenced in artifact CSS variables
```

## Self-Critique Flow (Post-Artifact)

```
Agent finishes writing artifact
    │
    ▼
DISCOVERY directive triggers internal critique pass
    │
    ▼
Agent evaluates 5 dimensions internally:
    ├── Philosophy: Does it match the brief?
    ├── Hierarchy: Is the visual hierarchy clear?
    ├── Detail: Colors, spacing, typography consistent?
    ├── Function: Interactions work? Artifact usable?
    └── Innovation: Memorable? Beyond template?
    │
    ▼
Agent applies revisions based on critique
    │
    ▼
Final artifact emitted (improved version)
```

## Prompt Stack — DISCOVERY Directive Position

```
Full prompt assembly:
    1. ← DISCOVERY directives    (turn-1 form, turn-2 brand branch,
    │                              TodoWrite spec, 5-dim critique spec,
    │                              anti-AI-slop rules, junior-designer mode)
    2.    Identity charter
    3.    DESIGN.md
    4.    SKILL.md
    5.    Project metadata
    6.    Skill side files
```

## Data Structures

```typescript
interface FormField {
  id: string;
  type: 'radio' | 'text' | 'checkbox' | 'select';
  label?: string;
  placeholder?: string;
  options?: string[];
  required?: boolean;
}

interface QuestionFormEvent {
  id: string;
  fields: FormField[];
}

interface Direction {
  id: string;
  label: string;
  palette: string[];      // OKLch color values
  fonts: string[];        // Font family names
  description?: string;
}

interface DirectionPickerEvent {
  directions: Direction[];
}
```

## SSE Events Summary

| Event | Trigger | UI Action |
|-------|---------|-----------|
| `question_form` | Turn-1, agent needs brief | Render QuestionForm, block user input |
| `direction_picker` | Turn-2, no brand context | Render DirectionPicker, show palette previews |
