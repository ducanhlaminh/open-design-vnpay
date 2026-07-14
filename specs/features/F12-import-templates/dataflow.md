# F-12: Import & Templates — Data Flow

## Claude Design ZIP Import Flow

```
User: drag & drop .zip into welcome dialog (or Home)
    │
    ▼
POST /api/import/claude-design
    Content-Type: multipart/form-data
    Body: { zip: File }
    │
    ▼
claude-design-import.ts:
    ├── Validate: is a ZIP? → else error
    ├── Extract ZIP in memory
    ├── Verify Claude Design format:
    │   ├── Check for known structure files
    │   └── Wrong format → error: "Not a Claude Design ZIP"
    │
    ├── Parse ZIP contents:
    │   ├── project.json → { name, metadata, … }
    │   ├── conversation.json → messages[]
    │   └── files/ → project file tree
    │
    ├── CREATE new project in SQLite (new UUID)
    │   POST /api/projects (internal)
    │
    ├── Copy files → .od/projects/<newId>/
    │   ├── index.html
    │   ├── style.css
    │   └── …
    │
    ├── Reconstruct conversation:
    │   INSERT messages (user + assistant) into SQLite
    │
    └── → { projectId: "new-uuid", name: "My Design" }
    │
    ▼
UI: navigate to /projects/<projectId>
```

## Template Creation Flow

```
User: Project → "Save as Template"
    │
    ▼
POST /api/templates
    Body: {
      name: "SaaS Landing Template",
      description: "Standard landing page with hero section",
      sourceProjectId: "proj-xyz"
    }
    │
    ▼
Daemon:
    ├── Read all files from .od/projects/<sourceProjectId>/
    ├── Serialize files: [{ name, content }]
    └── INSERT template: {
          id, name, description, sourceProjectId,
          files: JSON.stringify(filesArray),
          createdAt
        }
    │
    ▼
→ { template: ProjectTemplate }
```

## Template List & Preview Flow

```
GET /api/templates
    └── SELECT * FROM templates ORDER BY createdAt DESC
        → ProjectTemplate[]
    │
    ▼
UI: TemplatesLibrary view
    ├── Grid of template cards (name, description, preview)
    ├── Search: filter by name
    └── Click template → Preview modal
        ├── Preview file list
        └── Render index.html in sandboxed iframe
```

## Create Project from Template Flow

```
User: Template → "Use this template"
    │
    ▼
POST /api/projects
    Body: {
      name: "My New Project",
      metadata: { templateId: "tmpl-abc", templateLabel: "SaaS Landing Template" }
    }
    │
    ▼
Daemon:
    ├── CREATE new project (new UUID)
    ├── Load template files from SQLite: templates.files
    ├── Write each file to .od/projects/<newId>/
    │   ├── index.html → .od/projects/<newId>/index.html
    │   └── …
    └── → { project, conversationId }
    │
    ▼
User starts with pre-populated project files
    └── Can customize via chat or manual edit
```

## Template CRUD Flow

```
PUT /api/templates/:id
    Body: { name: "Updated Name", description: "Updated desc" }
    └── UPDATE templates SET name=…, description=… WHERE id=:id
        → { template: ProjectTemplate }

DELETE /api/templates/:id
    └── DELETE FROM templates WHERE id=:id
        → { deleted: true }
```

## Prompt Template Apply Flow

```
UI: PromptTemplatesTab
    │
    ├── GET /api/media/prompt-templates
    │   → PromptTemplate[] (43 image + 39 video + 11 HyperFrames)
    │
    ├── Filter by: surface (image|video), category, tags
    ├── Click template → PromptTemplatePreviewModal
    │   └── Preview: title, prompt text, model suggestion
    │
    └── "Use this template" →
        Pre-fill chat composer:
        ├── prompt: template.prompt
        ├── model: template.model (if set)
        └── aspect: template.aspect (if set)
```

## Examples Tab Flow

```
UI: ExamplesTab
    │
    ▼
GET /api/examples
    └── → Example[] { id, title, category, previewUrl }
    │
    ▼
Grid view:
    ├── Filter by category: landing pages, dashboards, mobile apps, decks
    └── Click example → Preview in sandboxed iframe
    │
User: "Use this example"
    │
    ▼
POST /api/projects
    Body: {
      name: "Example: {title}",
      metadata: { importedFrom: "example", templateId: exampleId }
    }
    │
    ▼
Daemon:
    ├── Copy example files to new project
    └── → { project, conversationId }
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/templates` | List all templates |
| POST | `/api/templates` | Create template from project |
| GET | `/api/templates/:id` | Template detail |
| PUT | `/api/templates/:id` | Update template |
| DELETE | `/api/templates/:id` | Delete template |
| POST | `/api/import/claude-design` | Import Claude Design ZIP |
| GET | `/api/examples` | List example designs |
| GET | `/api/media/prompt-templates` | List media prompt templates |
