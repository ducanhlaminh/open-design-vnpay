# F-19: Live Artifacts — Business Logic

## Overview

**Live Artifacts** are refreshable design outputs distinct from Normal Artifacts (static HTML files). They store **source data** and **preview state** in SQLite, and can be regenerated on-demand without a new chat turn. They're designed for data-driven views like dashboards and reports.

---

## Business Rules

### Normal vs Live Artifacts

| Property | Normal Artifact | Live Artifact |
|----------|----------------|--------------|
| Definition | Static design output | Refreshable design output |
| Storage | File on disk (`index.html`) + Artifact Manifest | SQLite record with source data + preview |
| Refresh | Re-chat with agent | Click "Refresh" button |
| Use case | Landing page, deck, prototype | Dashboard, report, data-driven view |
| MCP | Create via MCP tools | Refresh via MCP tools |

### Live Artifact Management

| Rule | Detail |
|------|--------|
| **BR-01** | Live Artifacts are stored as records in SQLite (not just files) |
| **BR-02** | Each artifact has `source data` — the input that drives generation |
| **BR-03** | Refresh triggers a pipeline that re-runs the source data through the generation process |
| **BR-04** | Refresh status: `idle → refreshing → idle | failed` |
| **BR-05** | All refresh attempts are logged in the `LiveArtifactRefreshLog` table |
| **BR-06** | Artifacts can be **pinned** to appear at the top of the list |
| **BR-07** | Archived artifacts are hidden from active views |
| **BR-08** | Preview can be an HTML string or an image URL (screenshot) |

### MCP Integration

| Rule | Detail |
|------|--------|
| **BR-09** | CLI agents can interact with live artifacts via MCP tools |
| **BR-10** | `read_live_artifact(id)` returns current source data |
| **BR-11** | `write_live_artifact(id, data)` updates source data |
| **BR-12** | `refresh_live_artifact(id)` triggers regeneration |

---

## Data Models

```typescript
interface LiveArtifact {
  id: string;
  projectId: string;
  title: string;
  slug: string;
  status: 'active' | 'archived';
  refreshStatus: 'idle' | 'refreshing' | 'failed';
  pinned: boolean;
  preview: LiveArtifactPreview;
  hasDocument: boolean;
  updatedAt: string;
  lastRefreshedAt?: string;
}

interface LiveArtifactPreview {
  html?: string;           // Preview HTML
  imageUrl?: string;       // Screenshot preview
  kind: 'html' | 'image';
}

interface LiveArtifactRefreshLog {
  id: string;
  liveArtifactId: string;
  status: 'succeeded' | 'failed';
  summary?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}
```

---

## Acceptance Criteria

- [ ] Create live artifact with source data
- [ ] Refresh live artifact on-demand
- [ ] Refresh log tracking
- [ ] Pin/unpin live artifacts
- [ ] Archive live artifacts
- [ ] MCP tools expose live artifact operations
- [ ] refreshStatus tracking: idle / refreshing / failed
