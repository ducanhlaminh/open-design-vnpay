# Open Design Backend — Development Plan & Effort Summary

> **Date**: 2026-06-03 | **Status**: Ready for Sprint Planning

---

## 1. Tổng hợp Mapping Codebase → Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                  CODEBASE HIỆN CÓ → MAPPING KIẾN TRÚC MỚI                   │
├─────────────────────────────┬──────────────────────────┬──────────────────── │
│ Codebase Hiện Có            │ Component Mới            │ Chiến lược          │
├─────────────────────────────┼──────────────────────────┼──────────────────── │
│ preview-gateway             │ API Gateway              │ ✅ Nâng cấp         │
│ preview-project             │ Project Service          │ ✅ Nâng cấp         │
│ preview-ai-agent            │ Agent Service            │ ✅ Nâng cấp         │
│ chat-preview-service        │ (giữ nguyên)             │ ✅ Giữ nguyên       │
│ preview-design              │ Design System Service    │ ✅ Nâng cấp         │
│ preview-identity            │ Identity (giữ) +         │ ✅ Tách một phần    │
│                             │ Config Service (tách)    │                     │
│ apps/preview-mcp            │ MCP Service              │ ✅ Nâng cấp + move  │
│ prompt-registry-service     │ Skill Svc (pattern)      │ 🔄 Tham khảo pattern│
│ preview-content             │ Content (giữ nguyên)     │ ✅ Giữ nguyên       │
│ preview-figma               │ Figma (giữ nguyên)       │ ✅ Giữ nguyên       │
│ preview-export              │ Export (giữ nguyên)      │ ✅ Giữ nguyên       │
│ openui-inference            │ Inference (giữ nguyên)   │ ✅ Giữ nguyên       │
│ openui-component            │ Component (giữ nguyên)   │ ✅ Giữ nguyên       │
│ openui-model-registry       │ Model Registry (giữ)     │ ✅ Giữ nguyên       │
│ kgs-platform                │ KGS (external)           │ 🔒 Read-only        │
│ ui-knowledge-service        │ UIKS (external)          │ 🔒 Read-only        │
│ — (không có)                │ Media Service            │ 🆕 Tạo mới          │
│ — (không có)                │ Memory Service           │ 🆕 Tạo mới          │
│ — (không có)                │ Skill Service            │ 🆕 Tạo mới          │
│ — (không có)                │ Config Service           │ 🆕 Tạo mới          │
│ — (không có)                │ Telemetry Service        │ 🆕 Tạo mới          │
│ — (không có)                │ Go Monorepo Setup        │ 🆕 Infrastructure   │
└─────────────────────────────┴──────────────────────────┴──────────────────── │
```

---

## 2. Effort Summary

| # | Component | Chiến lược | Effort (ngày) | Spec |
|---|-----------|-----------|--------------|------|
| 01 | API Gateway | ✅ Nâng cấp | 4.5 | [DEV-01](./DEV-01-api-gateway.md) |
| 02 | Project Service | ✅ Nâng cấp | 10 | [DEV-02](./DEV-02-project-service.md) |
| 03 | Agent Service | ✅ Nâng cấp | 12 | [DEV-03](./DEV-03-agent-service.md) |
| 04 | Design System Service | ✅ Nâng cấp | 9 | [DEV-04](./DEV-04-design-system-service.md) |
| 05 | Media Service | 🆕 Tạo mới | 14 | [DEV-05](./DEV-05-media-service.md) |
| 06 | Plugin Service | 🔄 Tái sử dụng | 13.5 | [DEV-06](./DEV-06-plugin-service.md) |
| 07 | MCP Service | ✅ Nâng cấp | 9 | [DEV-07](./DEV-07-mcp-service.md) |
| 08 | Memory Service | 🆕 Tạo mới | 12.5 | [DEV-08](./DEV-08-memory-service.md) |
| 09 | Skill Service | 🔄 Tái sử dụng | 5 | [DEV-09-12](./DEV-09-12-remaining-services.md) |
| 10 | Config Service | 🆕 Tạo mới | 8 | [DEV-09-12](./DEV-09-12-remaining-services.md) |
| 11 | Telemetry Service | 🆕 Tạo mới | 7 | [DEV-09-12](./DEV-09-12-remaining-services.md) |
| 12 | Go Monorepo Setup | 🆕 Infrastructure | 3 | [DEV-09-12](./DEV-09-12-remaining-services.md) |
| | **TỔNG** | | **107.5 ngày** | |

**Với team 3 developers**: ~36 ngày (~7.5 tuần)  
**Với team 5 developers**: ~22 ngày (~4.5 tuần)

---

## 3. Sprint Plan (3 Developers)

### Sprint 1 — Foundation (Tuần 1-2)
**Mục tiêu**: Setup infrastructure, không phá vỡ hệ thống hiện có

| Task | Assignee | Effort |
|------|---------|--------|
| DEV-12: Go Monorepo (go.work) + shared packages | Dev 1 | 3 ngày |
| DEV-10: Config Service (new) | Dev 2 | 8 ngày |
| DEV-01: API Gateway — thêm OD routes | Dev 3 | 4.5 ngày |

**Deliverable**: Gateway nhận OD routes, Config Service phân phối keys.

---

### Sprint 2 — Core Services (Tuần 3-5)
**Mục tiêu**: Project + Agent (core user journey)

| Task | Assignee | Effort |
|------|---------|--------|
| DEV-02: Project Service — thêm Conversation/Run/Files | Dev 1 | 10 ngày |
| DEV-03: Agent Service — CLI spawn + SSE streaming | Dev 2 | 12 ngày |
| DEV-07: MCP Service — migrate + OD tools | Dev 3 | 9 ngày |

**Deliverable**: User có thể chat với AI agent, project được tạo, MCP tools hoạt động.

---

### Sprint 3 — Content Services (Tuần 6-7)
**Mục tiêu**: Design systems, skills, media

| Task | Assignee | Effort |
|------|---------|--------|
| DEV-04: Design System Service — OD catalog | Dev 1 | 9 ngày |
| DEV-09: Skill Service (nhỏ) | Dev 1 | 5 ngày |
| DEV-05: Media Service — image/audio generation | Dev 2 | 14 ngày |
| DEV-11: Telemetry Service | Dev 3 | 7 ngày |

**Deliverable**: 150+ DS catalog, skill execution, image/audio generation, observability.

---

### Sprint 4 — Advanced Features (Tuần 8-10)
**Mục tiêu**: Plugin ecosystem, memory/context

| Task | Assignee | Effort |
|------|---------|--------|
| DEV-06: Plugin Service + Composio | Dev 1 | 13.5 ngày |
| DEV-08: Memory Service + vector search | Dev 2 | 12.5 ngày |
| Integration testing + Bug fixes | Dev 3 | — |

**Deliverable**: Plugin marketplace, context-aware AI responses.

---

## 4. API Compatibility Matrix

Tất cả API endpoints hiện tại (**VNPay platform**) **KHÔNG BỊ THAY ĐỔI**:

| Endpoint Group | Service | Thay đổi |
|---------------|---------|---------|
| `/api/v1/auth/*` | preview-identity | ❌ Không thay đổi |
| `/api/v1/projects/*` | preview-project | ❌ Không thay đổi |
| `/api/v1/screens/*` | preview-content | ❌ Không thay đổi |
| `/api/v1/journeys/*` | preview-content | ❌ Không thay đổi |
| `/api/v1/ai/*` | preview-ai-agent | ❌ Không thay đổi |
| `/api/v1/kg/*` | kgs-platform | ❌ Không thay đổi |
| `/api/v1/mcp/*` | preview-mcp | ❌ Không thay đổi |
| `/api/v1/design-systems/*` | preview-design | ❌ Không thay đổi |
| `/api/v1/admin/prompts/*` | prompt-registry | ❌ Không thay đổi |

**Thêm mới** (cho Open Design frontend):

| Endpoint Group | Service Mới | Ghi chú |
|---------------|-----------|---------|
| `/api/runs/*` | Agent Service | Mới hoàn toàn |
| `/api/projects/*` (OD subset) | Project Service | Bổ sung vào route |
| `/api/skills/*` | Skill Service | Mới hoàn toàn |
| `/api/media/*` | Media Service | Mới hoàn toàn |
| `/api/app-config` | Config Service | Mới hoàn toàn |
| `/artifacts/*` | Project Service | Mới hoàn toàn |
| `/frames/*` | Project Service | Mới hoàn toàn |

---

## 5. Risks & Mitigations

| Risk | Mức độ | Mitigation |
|------|--------|-----------|
| CLI agent spawn security (OS exec) | 🟡 Medium | Whitelist allowed agents, no shell injection |
| pgvector không available trên PG cũ | 🟡 Medium | SQLite fallback cho local mode |
| Redis event store lost on restart | 🟡 Medium | Persist completed run to PostgreSQL |
| OD routes conflict với VNPay routes | 🟠 High | Careful route ordering in Gateway router.go |
| Config Service single point of failure | 🟡 Medium | Cache API keys in memory với TTL |
| Agent CLI not installed | 🟢 Low | Probe và báo lỗi rõ ràng |
| Composio API rate limits | 🟢 Low | Retry với backoff |

---

## 6. Định nghĩa "Done"

Mỗi service được coi là **Done** khi:
- [x] Tất cả use cases trong spec được implement
- [ ] Unit tests coverage > 70%
- [x] gRPC handler tests (integration)
- [x] Docker build thành công
- [x] Health check endpoint trả về OK
- [ ] Không có race condition (go test -race)
- [ ] Tài liệu README.md đầy đủ
- [x] Docker Compose local chạy được
