# Open Design — Development Requirements

> **Version**: 1.0.0 | **Date**: 2026-06-03 | **Status**: 🟢 **Implementation Complete** (10/10 services build ✅)

---

## Mục đích tài liệu này

Tài liệu này **đối chiếu codebase hiện có** (`services/`) với **kiến trúc đích** (`specs/services/`) để xác định rõ ràng:
- ✅ **Nâng cấp**: Service cũ → upgrade lên chuẩn kiến trúc mới
- 🆕 **Tạo mới**: Service chưa tồn tại → build từ đầu
- 📦 **Tái sử dụng**: Codebase cũ dùng lại trực tiếp

---

## Codebase hiện có (services/)

| Service | Ngôn ngữ | Kiến trúc | Trạng thái |
|---------|---------|---------|---------|
| `preview-gateway` | Go | Clean Arch (gin + gRPC) | ✅ Production |
| `preview-project` | Go | Clean Arch (buf/proto + gRPC) | ✅ Production |
| `preview-identity` | Go | Clean Arch (RBAC + SSO) | ✅ Production |
| `preview-ai-agent` | Go | Simple service layer | ✅ Production |
| `preview-content` | Go | Layered (handler/service/repo) | ✅ Production |
| `preview-design` | Go | Layered (handler/repo) | ✅ Production |
| `preview-figma` | Go | Simple handler | ✅ Production |
| `preview-export` | Go | Minimal | ✅ Production |
| `chat-preview-service` | Go | Layered (biz/data/service) | ✅ Production |
| `openui-inference` | Go | Clean Arch (usecase/port) | ✅ Production |
| `openui-component` | Go | Layered | ✅ Production |
| `openui-model-registry` | Go | Layered | ✅ Production |
| `prompt-registry-service` | Go | Simple | ✅ Production |
| `preview-mcp` (app) | Go | Server + tools | ✅ Production |
| `ux-mcp` | Node.js | Express | Legacy |
| `kgs-platform` | — | External (read-only) | 🔒 External |
| `ui-knowledge-service` | — | External (read-only) | 🔒 External |
| `doc-to-kg` | — | Data pipeline | 🔒 External |
| `kg-to-dog` | — | Data pipeline | 🔒 External |

---

## Mapping: Codebase cũ → Kiến trúc mới

| Component Mới | Codebase nguồn | Chiến lược |
|--------------|---------------|-----------|
| **API Gateway** | `preview-gateway` | ✅ Nâng cấp — thêm routes Open Design |
| **Project Service** | `preview-project` | ✅ Nâng cấp — mở rộng domain (Conversation, Run, Files) |
| **Agent Service** | `preview-ai-agent` | ✅ Nâng cấp — thêm CLI spawn, SSE stream, BYOK |
| **Design System Service** | `preview-design` | ✅ Nâng cấp — thêm OD catalog sub-domain |
| **Media Service** | _không có_ | 🆕 Tạo mới |
| **Plugin Service** | `prompt-registry-service` | 🔄 Mở rộng pattern — tạo service mới độc lập |
| **MCP Service** | `preview-mcp` (app) | ✅ Nâng cấp — di chuyển sang services/, thêm OD tools |
| **Memory Service** | _không có_ | 🆕 Tạo mới |
| **Skill Service** | `prompt-registry-service` | 🔄 Mở rộng pattern — tạo service mới độc lập |
| **Config Service** | `preview-identity` | 🔄 Mở rộng — tách secrets thành service mới độc lập |
| **Telemetry Service** | _không có_ | 🆕 Tạo mới |
| `chat-preview-service` | `chat-preview-service` | ✅ Giữ nguyên — không chạm |

---

## Danh sách tài liệu yêu cầu

| File | Component | Chiến lược |
|------|----------|-----------|
| [DEV-01-api-gateway.md](./DEV-01-api-gateway.md) | API Gateway | ✅ Nâng cấp `preview-gateway` |
| [DEV-02-project-service.md](./DEV-02-project-service.md) | Project Service | ✅ Nâng cấp `preview-project` |
| [DEV-03-agent-service.md](./DEV-03-agent-service.md) | Agent Service | ✅ Nâng cấp `preview-ai-agent` |
| [DEV-04-design-system-service.md](./DEV-04-design-system-service.md) | Design System Service | ✅ Nâng cấp `preview-design` |
| [DEV-05-media-service.md](./DEV-05-media-service.md) | Media Service | 🆕 Tạo mới |
| [DEV-06-plugin-service.md](./DEV-06-plugin-service.md) | Plugin Service | 🆕 Tạo mới (pattern từ `prompt-registry`) |
| [DEV-07-mcp-service.md](./DEV-07-mcp-service.md) | MCP Service | ✅ Nâng cấp `preview-mcp` |
| [DEV-08-memory-service.md](./DEV-08-memory-service.md) | Memory Service | 🆕 Tạo mới |
| [DEV-09-12-remaining-services.md](./DEV-09-12-remaining-services.md) | Skill / Config / Telemetry / Monorepo | 🆕 Tạo mới |

---

## Ưu tiên phát triển (Sprint Planning)

### Sprint 1 — Foundation (2 tuần)
1. [DEV-12] Setup Go monorepo + shared packages
2. [DEV-01] Nâng cấp API Gateway (thêm Open Design routes)
3. [DEV-10] Config Service (tách secrets từ Identity)

### Sprint 2 — Core Services (3 tuần)
4. [DEV-02] Nâng cấp Project Service (mở rộng domain)
5. [DEV-03] Nâng cấp Agent Service (AI agent orchestration)
6. [DEV-07] Nâng cấp MCP Service (tách thành microservice)

### Sprint 3 — Content Services (2 tuần)
7. [DEV-04] Nâng cấp Design System Service
8. [DEV-05] Tạo Media Service mới
9. [DEV-09] Skill Service (từ prompt registry)

### Sprint 4 — Advanced Features (2 tuần)
10. [DEV-06] Plugin Service
11. [DEV-08] Memory Service (vector embedding)
12. [DEV-11] Telemetry Service

---

## Implementation Status (2026-06-03)

| Spec | Component | Build | Acceptance Criteria | Notes |
|------|-----------|-------|---------------------|-------|
| DEV-01 | API Gateway | ✅ | 7/8 ✅ | OTel traces pending |
| DEV-02 | Project Service | ✅ | 7/7 ✅ | Full OD domain |
| DEV-03 | Agent Service | ✅ | 8/8 ✅ | CLI spawn + SSE |
| DEV-04 | Design System Service | ✅ | 5/6 ✅ | ImportODDesignSystem Phase 2 |
| DEV-05 | Media Service | ✅ | 8/10 ✅ | Phase 2 providers pending |
| DEV-06 | Plugin Service | ✅ | 8/9 ✅ | Plugin marketplace Phase 2 |
| DEV-07 | MCP Service | ✅ | 9/9 ✅ | All OD tools wired |
| DEV-08 | Memory Service | ✅ | 6/6 ✅ | pgvector + SQLite fallback |
| DEV-09 | Skill Service | ✅ | 5/5 ✅ | Builtin catalog |
| DEV-10 | Config Service | ✅ | 4/4 ✅ | AES encrypted keys |
| DEV-11 | Telemetry Service | ✅ | 3/3 ✅ | OTLP + Prometheus |
| DEV-12 | Go Monorepo | ✅ | 4/4 ✅ | go.work + docker-compose |

**Overall**: **84/89 criteria done** (94%). All 10 services compile clean.  
**Remaining**: 5 Phase 2 items (OTel tracing, import DS, provider expansion).
