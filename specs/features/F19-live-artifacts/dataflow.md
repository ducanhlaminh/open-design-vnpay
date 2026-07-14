# F-19: Live Artifacts — Data Flow

## Create Live Artifact Flow

```
Agent: MCP tool call → create_live_artifact
    Body: {
      projectId: "proj-xyz",
      title: "Weekly Dashboard",
      sourceData: { metrics: { … }, dateRange: "last-7-days" },
      preview: { html: "<div>…</div>", kind: "html" }
    }
    │
    ▼
POST /api/projects/:id/live-artifacts
    Body: { title, slug, sourceData, preview }
    │
    ▼
Daemon:
    ├── INSERT into live_artifacts: { status: 'active', refreshStatus: 'idle', … }
    └── → { liveArtifact: LiveArtifact }
```

## Live Artifact List Flow

```
GET /api/projects/:id/live-artifacts
    │
    ▼
SELECT FROM live_artifacts
    WHERE projectId = :id AND status = 'active'
    ORDER BY pinned DESC, updatedAt DESC
    │
    ▼
→ LiveArtifact[]
    │
    ▼
UI: Renders artifact cards with:
    ├── Pinned artifacts first (📌)
    ├── Preview (HTML iframe or image)
    ├── Status badge (🟢 Idle | 🔄 Refreshing | ❌ Failed)
    └── "Refresh" button
```

## Refresh Flow

```
User clicks "Refresh" on live artifact
    │
    ▼
POST /api/projects/:id/live-artifacts/:aid/refresh
    │
    ▼
Daemon:
    ├── UPDATE live_artifacts SET refreshStatus = 'refreshing'
    ├── CREATE refresh log entry: { status: 'running', startedAt: now }
    │
    ├── Run source data pipeline:
    │   ├── Load artifact's sourceData
    │   ├── Re-run generation (agent call or data transform)
    │   └── Produce new preview HTML
    │
    ├── On success:
    │   ├── UPDATE live_artifacts:
    │   │   { refreshStatus: 'idle', preview: newPreview, lastRefreshedAt: now }
    │   └── UPDATE refresh_log: { status: 'succeeded', summary: '…' }
    │
    └── On failure:
        ├── UPDATE live_artifacts: { refreshStatus: 'failed' }
        └── UPDATE refresh_log: { status: 'failed', error: '…' }
    │
    ▼
UI: LiveArtifactBadges updates status in real-time
    ├── 🔄 Refreshing... → 🟢 Idle (on success)
    └── 🔄 Refreshing... → ❌ Failed (on failure)
```

## Refresh Log Flow

```
GET /api/projects/:id/live-artifacts/:aid/refresh-log
    │
    ▼
SELECT FROM live_artifact_refresh_logs
    WHERE liveArtifactId = :aid
    ORDER BY startedAt DESC
    │
    ▼
→ LiveArtifactRefreshLog[]
    UI: Show history of refresh attempts with status, summary, error
```

## Pin / Archive Flow

```
PATCH /api/projects/:id/live-artifacts/:aid
    │
    ├── Body: { pinned: true }
    │   └── UPDATE live_artifacts SET pinned = 1 WHERE id = :aid
    │
    ├── Body: { status: 'archived' }
    │   └── UPDATE live_artifacts SET status = 'archived' WHERE id = :aid
    │       → Hidden from active list
    │
    └── Body: { title: "New Title" }
        └── UPDATE live_artifacts SET title = … WHERE id = :aid
```

## MCP Tool Flows

```
CLI Agent: read_live_artifact({ id: "artifact-xyz" })
    │
    ▼
MCP Server → GET /api/projects/:pid/live-artifacts/:aid
    └── → { sourceData, preview, status, … }

---

CLI Agent: write_live_artifact({ id: "artifact-xyz", sourceData: { … } })
    │
    ▼
MCP Server → PATCH /api/projects/:pid/live-artifacts/:aid
    Body: { sourceData: { … } }
    └── Source data updated (preview not yet refreshed)

---

CLI Agent: refresh_live_artifact({ id: "artifact-xyz" })
    │
    ▼
MCP Server → POST /api/projects/:pid/live-artifacts/:aid/refresh
    └── Trigger refresh pipeline
        → { status: 'refreshing' }
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/:id/live-artifacts` | List live artifacts |
| POST | `/api/projects/:id/live-artifacts` | Create live artifact |
| GET | `/api/projects/:id/live-artifacts/:aid` | Artifact detail |
| PATCH | `/api/projects/:id/live-artifacts/:aid` | Update (title, pinned, status) |
| DELETE | `/api/projects/:id/live-artifacts/:aid` | Delete artifact |
| POST | `/api/projects/:id/live-artifacts/:aid/refresh` | Trigger refresh |
| GET | `/api/projects/:id/live-artifacts/:aid/refresh-log` | Refresh history |
