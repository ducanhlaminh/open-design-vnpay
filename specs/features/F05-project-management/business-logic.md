# F-05: Project Management — Business Logic

## Overview

Projects are the **top-level workspace** unit in Open Design. Each project maps to a directory on disk (`.od/projects/<id>/`), has its own conversation threads, files, and metadata. Projects persist via SQLite (WAL mode) and survive daemon restarts.

---

## Business Rules

### Project Lifecycle

| Rule | Detail |
|------|--------|
| **BR-01** | Each project has a UUID and gets a dedicated directory at `.od/projects/<id>/` |
| **BR-02** | Project list is sorted by `updatedAt` descending (most recent first) |
| **BR-03** | Projects persist across daemon restart — all data is in SQLite + filesystem |
| **BR-04** | Deleting a project removes both the SQLite record and the on-disk directory |
| **BR-05** | `OD_DATA_DIR` env var relocates the entire data directory |

### Project Kinds

| Kind | Description |
|------|-------------|
| `prototype` | Web prototype, landing page, dashboard |
| `deck` | Presentation slides |
| `image` | Image generation project |
| `video` | Video generation project |
| `audio` | Audio generation project |
| `template` | Internal template type |
| `other` | General-purpose |

### File Workspace

| Rule | Detail |
|------|--------|
| **BR-06** | Agent has read/write/bash/webfetch access to the project directory |
| **BR-07** | Files auto-save after 2 seconds of inactivity |
| **BR-08** | Preview syncs automatically when a file is saved |
| **BR-09** | File editor provides syntax highlighting for HTML, CSS, JS, Markdown, JSON |
| **BR-10** | Diff view appears when agent creates a new version of an existing file |

### Home Composer (Media Surfaces)

| Surface | Chip | Project Kind | Notes |
|---------|------|-------------|-------|
| Design | "Design" | `prototype` | General prototype |
| Deck | "Deck" | `deck` | Slides presentation |
| Image | "Image" | `image` | Image generation |
| Video | "Video" | `video` | Video generation |
| HyperFrames | "Motion" | `video` | `videoModel: "hyperframes-html"` |
| Audio | "Audio" | `audio` | Speech & sound |

### Quick Switcher

| Rule | Detail |
|------|--------|
| **BR-11** | Recent projects list is stored for quick access |
| **BR-12** | Search by project name, keyboard navigation supported |

### KGS Integration

| Rule | Detail |
|------|--------|
| **BR-13** | Projects can be scoped to a KGS project via `metadata.kgsProjectId` |
| **BR-14** | KGS project ID groups projects for the portfolio view |

---

## Project Data Model

```typescript
type ProjectKind = 'prototype' | 'deck' | 'template' | 'other' | 'image' | 'video' | 'audio';

interface Project {
  id: string;
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  createdAt: number;
  updatedAt: number;
  status?: ProjectStatusInfo;
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
  appliedPluginSnapshotId?: string;
  customInstructions?: string;
}

interface ProjectMetadata {
  kind: ProjectKind;
  kgsProjectId?: string;
  platform?: ProjectPlatform;
  fidelity?: 'wireframe' | 'high-fidelity';
  speakerNotes?: boolean;
  animations?: boolean;
  videoModel?: string;
  imageModel?: string;
  audioKind?: 'music' | 'speech' | 'sfx';
  importedFrom?: 'claude-design' | 'folder' | string;
  baseDir?: string;           // For folder-imported projects
  linkedDirs?: string[];      // Linked local code folders
  skipDiscoveryBrief?: boolean;
  contextPlugins?: ProjectContextPluginRef[];
  contextMcpServers?: ProjectContextMcpServerRef[];
  contextConnectors?: ProjectContextConnectorRef[];
}
```

---

## Filesystem Layout

```
.od/
├── app.sqlite              ← Metadata DB (WAL mode)
├── artifacts/              ← One-off "Save to disk" renders
├── media-config.json       ← API keys (gitignored)
└── projects/<id>/          ← Agent's working directory (cwd)
    ├── index.html          ← Main artifact
    ├── brand-spec.md
    ├── style.css
    └── …
```

---

## Acceptance Criteria

- [ ] Create project from Home with skill and design system selections
- [ ] Project list sorted by `updatedAt`
- [ ] Files persist across daemon restart
- [ ] File workspace with syntax highlighting
- [ ] Auto-save after 2 seconds
- [ ] Download ZIP archive of entire project
- [ ] Delete project removes both DB record and disk files
- [ ] Sessions persist in SQLite — reopening project next day works
