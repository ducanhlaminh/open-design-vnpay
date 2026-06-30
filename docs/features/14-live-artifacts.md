# F-19: Live Artifacts

**Nhóm:** ⚡ Platform — Live Artifacts  
**Nguồn code:** `apps/daemon/src/live-artifacts/`, `apps/daemon/src/live-artifact-routes.ts`  
**UI:** `LiveArtifactBadges.tsx`  
**Khái niệm:** `CONTEXT.md` — "A refreshable project design output"

---

## 1. Tổng quan

**Live Artifacts** là refreshable design outputs — khác với Normal Artifacts (static HTML files). Live Artifacts lưu **source data** và **preview state**, và có thể được refresh (re-generate) mà không cần chat lại với agent.

---

## 2. Normal Artifact vs Live Artifact

| | Normal Artifact | Live Artifact |
|--|----------------|--------------|
| **Định nghĩa** | Static design output | Refreshable design output |
| **Storage** | File trên disk (`index.html`) + Artifact Manifest | Record trong SQLite với source data + preview state |
| **Refresh** | Re-chat với agent | Click "Refresh" button |
| **Use case** | Landing page, deck, prototype | Dashboard, report, data-driven views |
| **MCP** | Create via MCP tools | Refresh via MCP tools |

---

## 3. Data Model

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
```

---

## 4. Refresh Mechanism

```
User click "Refresh"
  → POST /api/projects/:id/live-artifacts/:aid/refresh
  → Daemon re-runs source data pipeline
  → Preview updated
  → Status: idle → refreshing → idle (hoặc failed)
```

---

## 5. Refresh Log

```typescript
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

## 6. Pinning

- Live Artifacts có thể được **pin** để hiển thị ưu tiên
- Pinned artifacts hiển thị đầu danh sách

---

## 7. API

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/projects/:id/live-artifacts` | GET | List live artifacts |
| `/api/projects/:id/live-artifacts` | POST | Create live artifact |
| `/api/projects/:id/live-artifacts/:aid` | GET | Chi tiết |
| `/api/projects/:id/live-artifacts/:aid` | PATCH | Update (title, pinned, status) |
| `/api/projects/:id/live-artifacts/:aid` | DELETE | Xóa |
| `/api/projects/:id/live-artifacts/:aid/refresh` | POST | Trigger refresh |
| `/api/projects/:id/live-artifacts/:aid/refresh-log` | GET | Refresh history |

---

## 8. Live Artifact Badges

`LiveArtifactBadges.tsx` — Hiển thị trạng thái:
- 🟢 Idle
- 🔄 Refreshing...
- ❌ Failed

---

## 9. MCP Integration

Agents trong CLI có thể:
- `read_live_artifact(id)` — Đọc source data
- `write_live_artifact(id, data)` — Update source data
- `refresh_live_artifact(id)` — Trigger refresh

---

## 10. Acceptance Criteria

- [x] Create live artifact với source data
- [x] Refresh live artifact on-demand
- [x] Refresh log tracking
- [x] Pin/unpin live artifacts
- [x] Archive live artifacts
- [x] MCP tools expose live artifact operations
- [x] refreshStatus tracking: idle / refreshing / failed
