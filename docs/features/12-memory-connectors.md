# F-17 & F-22: Memory System & Connectors

**Nhóm:** 🧠 Platform — Memory & Connectors  
**Nguồn code:**
- `apps/daemon/src/memory.ts` (30KB)
- `apps/daemon/src/memory-connectors.ts` (45KB)
- `apps/daemon/src/connectors/`  
**UI:** `MemorySection.tsx` (89KB), `MemoryModelInline.tsx`, `ConnectorsBrowser.tsx` (63KB)

---

## 1. Memory System (F-17)

### 1.1 Tổng quan

Hệ thống memory cho phép **agent nhớ thông tin** qua các conversations khác nhau. Memory entries được extract tự động từ conversations và có thể được confirm hoặc xóa bởi user.

### 1.2 Memory Entries

```typescript
interface MemoryEntry {
  id: string;
  content: string;         // Nội dung memory
  source: string;          // Nguồn: conversation ID, connector ID
  confidence: number;      // 0-1, độ tin cậy
  status: 'suggested' | 'confirmed' | 'rejected';
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}
```

### 1.3 Memory Lifecycle

```
Conversation → Extract → Suggest → User confirm/reject → Persist
                                                         ↓
                              Next conversation → Inject as context
```

### 1.4 API

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/memory` | GET | List all memory entries |
| `/api/memory/extract` | POST | Extract memories từ message |
| `/api/memory/:id` | GET | Chi tiết entry |
| `/api/memory/:id` | PATCH | Confirm / reject |
| `/api/memory/:id` | DELETE | Xóa entry |

### 1.5 Memory Toast

`MemoryToast.tsx` — Hiển thị notification khi:
- Memory mới được suggest từ conversation
- User cần confirm/reject

### 1.6 Memory Model Inline

`MemoryModelInline.tsx` — Hiển thị memory entries inline trong chat:
- User thấy ngay memory được extract
- Có thể confirm/reject ngay trong chat

---

## 2. Connectors (F-22)

### 2.1 Tổng quan

Connectors cho phép kết nối đến **external services** (GitHub, Slack, Notion, v.v.) thông qua **Composio** integration. Connector data được dùng bởi Memory system và Orbit.

### 2.2 Supported Connectors

| Connector | Dữ liệu extract | Logo |
|-----------|----------------|------|
| **GitHub** | Commits, PRs, issues, code activity | `ConnectorLogo.tsx` |
| **Slack** | Messages, channel activity | — |
| **Notion** | Pages, database updates | — |
| **Google Calendar** | Events, meetings | — |
| **Linear** | Issues, project updates | — |
| **Jira** | Tickets, sprints | — |
| ...và nhiều hơn qua Composio | — | — |

### 2.3 Connection Flow

```
1. User browse ConnectorsBrowser
2. Click connector → "Connect"
3. OAuth flow qua Composio
4. Credentials stored per-connector
5. Connector active → data flows to Memory
```

### 2.4 API

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/connectors` | GET | List configured connectors |
| `/api/connectors/:id/connect` | POST | Connect với OAuth |
| `/api/connectors/:id` | DELETE | Disconnect |
| `/api/connectors/:id/data` | GET | Lấy data từ connector |

### 2.5 Composio Integration

`AppConfig.composio`:
```typescript
interface ComposioSettings {
  apiKey?: string;
  enabled: boolean;
}
```

- Composio là middleware quản lý OAuth và data access
- Hỗ trợ 200+ integrations qua Composio

### 2.6 Connector Memory Extraction

`memory-connectors.ts`:
- Pull data từ connector (GitHub commits, Slack messages, v.v.)
- Extract meaningful memories
- Deduplicate với existing entries
- Feed vào Orbit digest

---

## 3. Community Pets (Gamification)

`apps/web/src/components/pet/` + `apps/daemon/src/orbit.ts`:

```typescript
interface PetConfig {
  name?: string;
  kind?: string;
  enabled?: boolean;
}
```

- Virtual pet trong UI (gamification element)
- Pet phát triển dựa trên usage
- Community pets sync qua server

---

## 4. Acceptance Criteria

**Memory:**
- [x] Memory entries được extract tự động từ conversations
- [x] User có thể confirm/reject từng entry
- [x] Memory inject vào context cho conversation tiếp theo
- [x] Delete memory entry
- [x] Memory toast notification

**Connectors:**
- [x] Credential store per-connector
- [x] Connect qua OAuth (Composio)
- [x] Disconnect / revoke
- [x] Memory extraction từ connector data
- [x] Connector data feed vào Orbit digest
