# F-12: Import & Templates — Business Logic

## Overview

The Import & Templates feature allows users to reuse design work through two mechanisms:
1. **Import** — Bring external projects (Claude Design ZIP, GitHub Design Systems, Figma, local folders) into Open Design
2. **Templates** — Save completed projects as reusable templates, then create new projects from them

---

## Import — Business Rules

### Claude Design ZIP Import

| Rule | Detail |
|------|--------|
| **BR-01** | Supports the Claude Design (Anthropic) export ZIP format |
| **BR-02** | Import can be triggered by drag-and-drop onto the welcome dialog |
| **BR-03** | Creates a new project with a new UUID |
| **BR-04** | Project conversation history is reconstructed from the ZIP data |
| **BR-05** | Imported files are immediately accessible in the File Workspace |
| **BR-06** | Clear error message if ZIP is invalid or in wrong format |

### GitHub Design System Import

| Rule | Detail |
|------|--------|
| **BR-07** | User pastes a public GitHub repository URL |
| **BR-08** | Daemon fetches and parses the repo's `DESIGN.md` |
| **BR-09** | Must validate all 9 sections of the schema |
| **BR-10** | Missing sections return a descriptive validation error |

### File Upload in Chat

| Rule | Detail |
|------|--------|
| **BR-11** | Images and documents can be dragged/dropped into the chat composer |
| **BR-12** | Images can be pasted from clipboard |
| **BR-13** | Files are attached to the message as `ChatAttachment` |
| **BR-14** | Agent can reference attached files in its context |

### Figma Import (via Skills)

| Rule | Detail |
|------|--------|
| **BR-15** | `figma-use` skill connects to Figma via MCP |
| **BR-16** | `figma-implement-design` converts Figma designs to HTML/CSS artifacts |

---

## Templates — Business Rules

| Rule | Detail |
|------|--------|
| **BR-17** | Any project can be saved as a template via "Save as Template" action |
| **BR-18** | Template captures the entire file structure and content of the project |
| **BR-19** | Templates are stored in SQLite with snapshot of `files` array |
| **BR-20** | User can browse and search the template library |
| **BR-21** | Template can be previewed before creating a project from it |
| **BR-22** | Creating from template copies all files to a new project directory |
| **BR-23** | The new project is customizable after creation |
| **BR-24** | Templates can have a name and description |
| **BR-25** | Templates retain a reference to the `sourceProjectId` |

---

## Prompt Templates (Image / Video)

| Rule | Detail |
|------|--------|
| **BR-26** | 43 image prompt templates organized by category (poster, avatar, infographic, etc.) |
| **BR-27** | 39 Seedance video prompt templates |
| **BR-28** | 11 HyperFrames video prompt templates |
| **BR-29** | Templates can be previewed in a modal before applying |
| **BR-30** | Applying a template pre-fills the prompt field in the composer |

---

## Data Models

```typescript
interface ProjectTemplate {
  id: string;
  name: string;
  description?: string;
  sourceProjectId?: string;           // Original project
  files: Array<{ name: string; content: string }>;
  createdAt: number;
}

interface PromptTemplate {
  id: string;
  surface: 'image' | 'video';
  title: string;
  prompt: string;
  summary?: string;
  category?: string;
  tags?: string[];
  model?: string;
  aspect?: MediaAspect;
}
```

---

## Acceptance Criteria

**Import:**
- [ ] Claude Design ZIP format supported
- [ ] Project history preserved after import
- [ ] Files accessible in File Workspace post-import
- [ ] Clear error if ZIP is invalid
- [ ] GitHub Design System: parse DESIGN.md + validate schema

**Templates:**
- [ ] Save project as template
- [ ] Templates list with search/filter
- [ ] Preview template before use
- [ ] Create project from template
- [ ] Template captures full file structure

**Examples Tab:**
- [ ] Browse gallery by category
- [ ] Preview in sandboxed iframe
- [ ] "Use this example" creates new project
