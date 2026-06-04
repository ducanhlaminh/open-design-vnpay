# 00 — Tổng quan Kiến trúc Backend Microservices (Golang)

> **Version**: 1.0.0 | **Status**: Proposed

---

## 1. Bối cảnh & Mục tiêu

Hệ thống hiện tại của **Open Design** sử dụng một daemon đơn lẻ viết bằng TypeScript (Express 5), đảm nhận **toàn bộ** logic:
- Project management
- AI agent orchestration & streaming
- Design system processing
- Media generation
- MCP server
- Plugin runtime
- Memory / embedding
- Telemetry

Khi hệ thống tăng trưởng, kiến trúc monolith gặp các vấn đề:
- **Khó scale độc lập** từng chức năng (agent streaming cần tài nguyên khác media generation)
- **Deployment risk cao** — một lỗi trong media generation có thể crash toàn daemon
- **Coupling chặt** — khó test, khó maintain từng domain
- **Team isolation kém** — nhiều team phải touch cùng codebase

**Mục tiêu kiến trúc mới:**

| Mục tiêu | Mô tả |
|-----------|-------|
| **Độc lập triển khai** | Mỗi service deploy/scale riêng biệt |
| **Domain isolation** | Mỗi service owns domain logic + storage của mình |
| **Performance** | Go cho throughput cao, latency thấp hơn Node.js |
| **Maintainability** | Clean Architecture trong từng service |
| **Backward compatible** | API contract 100% compatible với frontend hiện tại |
| **Local-first** | Vẫn chạy được all-in-one trên máy local (Docker Compose) |

---

## 2. Sơ đồ Kiến trúc Tổng thể

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
│   ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐   │
│   │  Web Browser    │  │  Electron Desktop │  │  CLI Tool (`od`)         │   │
│   │ (Next.js SPA)   │  │   (Electron Shell)│  │  (Go CLI binary)         │   │
│   └────────┬────────┘  └────────┬──────────┘  └────────────┬─────────────┘   │
└────────────│────────────────────│──────────────────────────│─────────────────┘
             │  HTTP/SSE          │  HTTP/SSE                │  gRPC/HTTP
             ▼                    ▼                          ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         API GATEWAY  :7456                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  • JWT / MCP Token Authentication                                    │    │
│  │  • Rate Limiting (per IP, per user)                                  │    │
│  │  • Request routing → gRPC upstreams                                  │    │
│  │  • SSE proxy & multiplexing                                          │    │
│  │  • CORS & Origin Validation                                          │    │
│  │  • Request logging & tracing (OpenTelemetry)                         │    │
│  │  • WebSocket upgrade (future)                                        │    │
│  └───────────────────────────┬──────────────────────────────────────────┘    │
└──────────────────────────────│───────────────────────────────────────────────┘
                               │ gRPC (internal)
          ┌────────────────────┼────────────────────────────────────┐
          │           │        │         │          │               │
          ▼           ▼        ▼         ▼          ▼               ▼
   ┌──────────┐ ┌──────────┐ ┌────────────────┐ ┌──────────┐ ┌──────────┐
   │ project  │ │  agent   │ │ design-system  │ │  media   │ │  plugin  │
   │ service  │ │ service  │ │   service      │ │ service  │ │ service  │
   │ :8081    │ │ :8082    │ │   :8083        │ │ :8084    │ │ :8085    │
   └────┬─────┘ └────┬─────┘ └───────┬────────┘ └─────┬────┘ └─────┬────┘
        │             │               │                │             │
        ▼             ▼               ▼                ▼             ▼
   SQLite/PG    SQLite/Redis     SQLite/PG         SQLite        SQLite
                      │
          ┌───────────┼───────────────┐
          │           │               │
          ▼           ▼               ▼
   ┌──────────┐ ┌──────────┐ ┌──────────────┐
   │   mcp    │ │  memory  │ │    skill     │
   │ service  │ │ service  │ │   service    │
   │ :8086    │ │ :8087    │ │   :8088      │
   └──────────┘ └──────────┘ └──────────────┘

          ┌─────────────────────────────┐
          │       config service        │
          │          :8089              │
          │  (all services read config) │
          └─────────────────────────────┘

  ──────────────── Message Queue (NATS / Redis Streams) ─────────────────────
          │                                          │
          ▼ (async events)                           ▼
   ┌──────────────────┐                    ┌──────────────────┐
   │ telemetry service│                    │  audit log svc   │
   │    :8090         │                    │  (future)        │
   └──────────────────┘                    └──────────────────┘
```

---

## 3. Danh sách Services

| Service | Port gRPC | Port HTTP (internal) | Chức năng chính |
|---------|-----------|---------------------|----------------|
| **API Gateway** | — | 7456 (public) | Routing, auth, SSE proxy |
| **Project Service** | 8081 | — | Projects, conversations, messages, runs, files |
| **Agent Service** | 8082 | — | AI agent lifecycle, CLI spawn, SSE streaming |
| **Design System Service** | 8083 | — | DS catalog, import, generation, preview |
| **Media Service** | 8084 | — | Image/video/audio generation via external APIs |
| **Plugin Service** | 8085 | — | Plugin registry, sandbox execution, Composio |
| **MCP Service** | 8086 | — | MCP server protocol, tool registration |
| **Memory Service** | 8087 | — | Context persistence, vector embedding, search |
| **Skill Service** | 8088 | — | Skill catalog, execution, AI skill dispatch |
| **Config Service** | 8089 | — | App config, secrets, API keys management |
| **Telemetry Service** | 8090 | — | PostHog, Langfuse, Prometheus metrics |

---

## 4. Nguyên tắc thiết kế

### 4.1 Clean Architecture (mỗi service)

```
service/
  cmd/          ← Entry point (main.go)
  internal/
    domain/     ← Entities, Value Objects, Domain Events (không import bên ngoài)
    usecase/    ← Business logic (chỉ biết domain)
    infra/      ← Database, external API adapters (implement interfaces từ domain)
    delivery/
      grpc/     ← gRPC handlers
      http/     ← HTTP handlers (internal health check, metrics)
  pkg/          ← Reusable utilities (có thể share giữa services)
  proto/        ← Protobuf definitions
```

### 4.2 Domain-Driven Design

- Mỗi service = 1 **Bounded Context**
- Services giao tiếp qua **Domain Events** (async) hoặc **gRPC** (sync)
- Không share database giữa services
- **API Gateway** là điểm duy nhất expose ra ngoài

### 4.3 Giao tiếp giữa services

| Kiểu | Công nghệ | Khi nào dùng |
|------|-----------|-------------|
| Sync request-response | gRPC | Cần kết quả ngay, ví dụ: agent service gọi project service để lấy context |
| Async event | NATS JetStream | Fire-and-forget, ví dụ: agent kết thúc → telemetry ghi log |
| SSE streaming | HTTP + gRPC stream | Client nhận real-time events từ agent |

### 4.4 Storage Strategy

| Service | Primary DB | Lý do |
|---------|-----------|-------|
| Project | PostgreSQL (prod) / SQLite (local) | Relational, ACID, JSONB for metadata |
| Agent | Redis (state) + PostgreSQL (history) | Run state cần fast read/write |
| Design System | PostgreSQL + Local FS | File content + metadata |
| Media | PostgreSQL (jobs) + S3/Local FS | Job tracking + binary storage |
| Plugin | PostgreSQL | Registry + config |
| MCP | PostgreSQL | Token, tool registration |
| Memory | PostgreSQL + pgvector (prod) / SQLite+sqlite-vec (local) | Embedding search |
| Skill | PostgreSQL + Local FS | Metadata + YAML files |
| Config | PostgreSQL (encrypted) | Encrypted secrets |
| Telemetry | In-memory + async flush | Low latency |

### 4.5 Local-first Mode

Trong môi trường local (dev/desktop), tất cả services chạy trong **Docker Compose** hoặc như các process riêng biệt với SQLite, không cần infra phức tạp:

```yaml
# docker-compose.local.yml — một lệnh khởi động toàn bộ
services:
  gateway:      { port: 7456 }
  project-svc:  { port: 8081 }
  agent-svc:    { port: 8082 }
  ...
```

---

## 5. API Compatibility với Frontend hiện tại

Frontend (Next.js) **không thay đổi** — API Gateway expose **chính xác các endpoints hiện tại**:

```
POST   /api/runs                → Agent Service
GET    /api/runs/:id/events     → Agent Service (SSE)
POST   /api/runs/:id/cancel     → Agent Service
POST   /api/runs/:id/tool-result → Agent Service

GET    /api/projects            → Project Service
POST   /api/projects            → Project Service
GET    /api/projects/:id        → Project Service
GET    /api/projects/:id/files  → Project Service

GET    /api/design-systems      → Design System Service
GET    /api/skills              → Skill Service
GET    /api/agents              → Agent Service (probe CLI)

GET    /api/media/config        → Config Service
PUT    /api/media/config        → Config Service

GET    /api/app-config          → Config Service
PUT    /api/app-config          → Config Service

POST   /api/active              → MCP Service

GET    /artifacts/*             → Project Service (file serving)
GET    /frames/*                → Project Service (iframe serving)

/mcp                            → MCP Service (MCP protocol)
```

---

## 6. Technology Stack

| Layer | Technology | Lý do |
|-------|-----------|-------|
| Language | **Go 1.23+** | Performance, concurrency model phù hợp streaming |
| gRPC framework | **google.golang.org/grpc** | Standard, well-supported |
| HTTP framework | **Echo v4** (Gateway) | Fast, middleware-rich |
| ORM | **GORM + sqlc** | Type-safe queries |
| Database (prod) | **PostgreSQL 16** | JSONB, pgvector |
| Database (local) | **SQLite + WAL** | Zero-config local |
| Cache | **Redis 7** | Run state, rate limiting |
| Message Queue | **NATS JetStream** | Lightweight, Go-native |
| Config | **Viper + env** | 12-factor app |
| Observability | **OpenTelemetry SDK** | Traces, metrics, logs |
| Testing | **testify + gomock** | Unit + integration |
| Container | **Docker multi-stage** | Minimal images |
| Service discovery | **DNS (k8s)** / **static (local)** | Simple, effective |

---

## 7. Migration Strategy

Vì frontend không thể thay đổi ngay, migration theo **strangler fig pattern**:

```
Phase 1 (MVP): 
  Gateway → Agent Service + Project Service (core features)
  Các services khác: Gateway proxy thẳng đến Node.js daemon cũ

Phase 2:
  Migrate Design System Service, Media Service, Skill Service

Phase 3:
  Migrate Plugin Service, MCP Service, Memory Service

Phase 4:
  Retire Node.js daemon, Config Service + Telemetry Service hoàn thiện
```

---

## 8. Tài liệu liên quan

Xem chi tiết từng service trong thư mục này:

- [01-api-gateway.md](./01-api-gateway.md)
- [02-project-service.md](./02-project-service.md)
- [03-agent-service.md](./03-agent-service.md)
- [04-design-system-service.md](./04-design-system-service.md)
- [05-media-service.md](./05-media-service.md)
- [06-plugin-service.md](./06-plugin-service.md)
- [07-mcp-service.md](./07-mcp-service.md)
- [08-memory-service.md](./08-memory-service.md)
- [09-skill-service.md](./09-skill-service.md)
- [10-config-service.md](./10-config-service.md)
- [11-telemetry-service.md](./11-telemetry-service.md)
- [12-clean-architecture.md](./12-clean-architecture.md)
- [13-shared-infra.md](./13-shared-infra.md)
- [14-deployment.md](./14-deployment.md)
