# F-05: Project Management — Data Flow

## Project Creation Flow

```
User: Home → New Project
    │
    ├── Select skill (optional)
    ├── Select design system (optional)
    ├── Enter prompt (optional - pendingPrompt)
    └── Select media surface chip (Design / Deck / Image / Video / Motion / Audio)
    │
    ▼
POST /api/projects
    Body: {
      name, skillId, designSystemId,
      pendingPrompt, metadata: { kind, platform, … }
    }
    │
    ▼
Daemon:
    ├── Generate UUID
    ├── INSERT project into SQLite
    ├── Create .od/projects/<id>/ directory
    ├── Create initial conversation
    └── If pendingPrompt → queue first message
    │
    ▼
→ { project, conversationId }
    │
    ▼
UI: navigate to /projects/<id>/conversations/<cid>
```

## Project List Flow

```
GET /api/projects
    └── SELECT FROM projects ORDER BY updatedAt DESC
        → Project[]
```

## Project Update Flow

```
PATCH /api/projects/:id
    Body: { name?, skillId?, designSystemId?, metadata?, customInstructions? }
    │
    ▼
Daemon:
    ├── Validate: name not empty, skillId exists if provided
    ├── UPDATE projects SET … WHERE id = :id
    └── → { project: Project }
```

## Project Delete Flow

```
DELETE /api/projects/:id
    │
    ▼
Daemon:
    ├── DELETE FROM projects WHERE id = :id
    ├── DELETE FROM conversations WHERE projectId = :id
    ├── DELETE FROM messages WHERE conversationId IN (…)
    ├── rm -rf .od/projects/<id>/
    └── → { deleted: true }
```

## File Workspace Flow

```
GET /api/projects/:id/files
    └── readdir .od/projects/<id>/
        → ProjectFile[] { name, size, updatedAt }

GET /api/projects/:id/files/:name
    └── read .od/projects/<id>/<name>
        → { content: string }

PUT /api/projects/:id/files/:name
    Body: { content: string }
    └── write .od/projects/<id>/<name>
        → { file: ProjectFile }

DELETE /api/projects/:id/files/:name
    └── unlink .od/projects/<id>/<name>
        → { deleted: true }
```

## Auto-Save Flow (Client Side)

```
User edits file in FileWorkspace
    │
    ▼
Debounce 2 seconds (reset on each keystroke)
    │
    ▼
PUT /api/projects/:id/files/:name
    └── { content: editorValue }
    │
    ▼
Preview iframe reloads
```

## ZIP Archive Flow

```
GET /api/projects/:id/archive
    │
    ▼
Daemon:
    ├── Enumerate all files in .od/projects/<id>/
    ├── Stream archiver (zip format)
    └── → application/zip download
```

## Conversation Transcript Flow

```
GET /api/projects/:id/transcript
    │
    ▼
Daemon:
    ├── Load all conversations for project
    ├── Load all messages for each conversation
    ├── Format as Markdown:
    │   "# Conversation: {title}\n\n**User:** {prompt}\n\n**Agent:** {response}\n\n"
    └── → text/markdown download
```

## Quick Switcher Flow

```
User: Cmd+K (keyboard shortcut)
    │
    ▼
UI: Open QuickSwitcher modal
    ├── Load recent projects (from local storage)
    ├── Search input → filter by name
    └── Keyboard navigation (up/down arrows)
    │
User selects project
    │
    ▼
Navigate to /projects/<id>
```

## Folder Import Flow

```
POST /api/import/folder
    Body: { baseDir: "/path/to/user/folder", name?, skillId? }
    │
    ▼
Daemon:
    ├── realpath(baseDir) → canonicalize
    ├── Check for X-OD-Desktop-Import-Token header (desktop trust gate)
    ├── CREATE project with metadata.baseDir = realpath
    ├── Scan for entry file (index.html, etc.)
    └── → { project, conversationId, entryFile }
```

## Data Models

```typescript
interface ProjectFile {
  name: string;
  content: string;
  size: number;
  updatedAt: number;
}

interface CreateProjectRequest {
  name: string;
  skillId?: string | null;
  designSystemId?: string | null;
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
  customInstructions?: string;
  skipDiscoveryBrief?: boolean;
}

interface CreateProjectResponse {
  project: Project;
  conversationId?: string;
}
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List projects (sorted by updatedAt) |
| POST | `/api/projects` | Create new project |
| GET | `/api/projects/:id` | Project detail + resolvedDir |
| PATCH | `/api/projects/:id` | Update project metadata |
| DELETE | `/api/projects/:id` | Delete project + files |
| GET | `/api/projects/:id/files` | List project files |
| GET | `/api/projects/:id/files/:name` | Read file content |
| PUT | `/api/projects/:id/files/:name` | Write file content |
| DELETE | `/api/projects/:id/files/:name` | Delete file |
| GET | `/api/projects/:id/archive` | Download ZIP |
| GET | `/api/projects/:id/transcript` | Conversation transcript (Markdown) |
| POST | `/api/import/folder` | Import local folder as project |
