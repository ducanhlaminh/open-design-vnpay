# F-04: Design Systems Library — Data Flow

## Design System Discovery Flow

```
Daemon starts
    │
    ▼
Scan design-systems/ directory
    │
    ▼
For each design-systems/<id>/DESIGN.md:
    ├── Parse: name, description
    ├── Extract color palette (section 1)
    ├── Extract typography (section 2)
    └── Build DesignSystemSummary { id, name, colors[4], … }
    │
    ▼
Cache DesignSystemSummary[] in memory
```

## API Data Flow

```
GET /api/design-systems
    └── → DesignSystemSummary[] (with 4 color swatches each)

GET /api/design-systems/:id
    └── → DesignSystemDetail { ...summary, fullContent: string }

GET /api/design-systems/:id/preview
    └── → HTML preview snippet

GET /api/design-systems/:id/showcase
    └── → Full showcase artifact HTML

POST /api/design-systems
    ├── Body: { name, content, assets[] }
    ├── Validate 9-section schema
    └── → { designSystem: DesignSystemSummary }

PUT /api/design-systems/:id
    └── → Updated DesignSystemSummary

DELETE /api/design-systems/:id
    └── → { deleted: true }

POST /api/design-systems/import/github
    ├── Body: { repoUrl: string }
    ├── Fetch DESIGN.md from GitHub
    ├── Validate 9-section schema
    └── → { designSystem: DesignSystemSummary }
```

## Design System Selection Flow

```
User opens project
    │
    ▼
UI loads DesignSystemPicker
    ├── GET /api/design-systems → list with swatches
    └── Display grid view
    │
User selects design system
    │
    ▼
PATCH /api/projects/:id
    └── { designSystemId: "linear" }
    │
    ▼
Next message turn:
    Daemon reads design-systems/linear/DESIGN.md
    → Inject into prompt stack position 3
```

## Custom Design System Creation Flow

```
User: Settings → Design Systems → Create New
    │
    ▼
Form:
    ├── Name input
    ├── DESIGN.md textarea (9 sections)
    ├── Color picker (live preview)
    └── Asset uploads (logo, fonts)
    │
    ▼
POST /api/design-systems
    ├── Validate: all 9 sections present
    │   ├── Valid → save to user library
    │   └── Invalid → return validation error with missing sections
    │
    ▼
DesignSystemSummary added to catalog
```

## GitHub Import Flow

```
User: Import → GitHub URL
    │
    ▼
POST /api/design-systems/import/github
    Body: { repoUrl: "https://github.com/owner/repo" }
    │
    ▼
Daemon:
    ├── Parse repo URL → owner/repo
    ├── Fetch raw DESIGN.md from GitHub API
    ├── Parse 9 sections
    │   ├── All present → extract metadata
    │   └── Missing sections → return error
    ├── Extract: name, colors, typography, components
    └── Save to user library
    │
    ▼
→ { designSystem: DesignSystemSummary }
```

## Prompt Injection Flow

```
User sends message
    │
    ▼
Daemon: resolve designSystemId from project
    │
    ▼
Read design-systems/<id>/DESIGN.md
    │
    ▼
Insert at prompt position 3:
    "## Design System\n{DESIGN.md content}"
    │
    ▼
Remaining prompt stack assembled
    │
    ▼
Full prompt sent to agent
```

## Data Models

```typescript
interface DesignSystemSummary {
  id: string;
  name: string;
  description?: string;
  colors: string[];      // 4 hex signature colors
  isBuiltIn: boolean;
  isCustom: boolean;
}

interface DesignSystemDetail extends DesignSystemSummary {
  fullContent: string;   // Full DESIGN.md text
  hasShowcase: boolean;
}

interface CreateDesignSystemRequest {
  name: string;
  content: string;       // Full DESIGN.md text
  assets?: File[];
}

interface ImportGitHubDesignSystemRequest {
  repoUrl: string;
}
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/design-systems` | List all design systems with swatches |
| GET | `/api/design-systems/:id` | Full DESIGN.md content + metadata |
| GET | `/api/design-systems/:id/preview` | Preview HTML snippet |
| GET | `/api/design-systems/:id/showcase` | Full showcase artifact |
| POST | `/api/design-systems` | Create custom design system |
| PUT | `/api/design-systems/:id` | Update design system |
| DELETE | `/api/design-systems/:id` | Delete design system |
| POST | `/api/design-systems/import/github` | Import from GitHub repo |
