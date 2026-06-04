# Frontend Separation — Tổng quan Giải pháp

> **Version**: 1.0.0  
> **Date**: 2026-06-03  
> **Status**: Proposed  
> **Scope**: `apps/web` (Next.js) ↔ Daemon (Express 5) → Go Microservices

---

## 1. Bối cảnh & Vấn đề

### Kiến trúc hiện tại

```
apps/web (Next.js SPA)
    │
    │  HTTP / SSE  (dev: Next.js rewrite → localhost:7456)
    │  (prod: static export, served BY daemon)
    ▼
apps/daemon (Express 5 — port 7456)
    │
    ├── /api/runs          ← Chat agent streaming
    ├── /api/projects      ← Project CRUD
    ├── /api/design-systems← Design system registry
    ├── /api/skills        ← Skill catalog
    ├── /api/agents        ← Agent probing
    ├── /api/media/*       ← Media generation config
    ├── /api/app-config    ← Config persistence
    ├── /api/active        ← MCP active context
    ├── /artifacts/*       ← Static file serving
    └── /frames/*          ← iframe serving
```

**Vấn đề cốt lõi:**
- Frontend (`apps/web`) **phụ thuộc trực tiếp vào daemon** — không có abstraction layer
- Daemon là monolith TypeScript ~250KB CLI + ~500KB server code
- Frontend được build dưới dạng **static export** và **daemon serve** → tight coupling
- Không thể deploy frontend độc lập (Vercel, CDN thuần)
- Kiến trúc backend mới (Go Microservices) đã được định nghĩa tại `specs/services/`

---

## 2. Mục tiêu Phân tách

| Mục tiêu | Mô tả |
|-----------|-------|
| **Frontend độc lập** | `apps/web` build và deploy hoàn toàn độc lập, không cần daemon |
| **API Contract** | Frontend chỉ giao tiếp với API Gateway (port 7456) — endpoint giữ nguyên |
| **Backend mới** | Daemon TypeScript được thay thế dần bằng Go Microservices |
| **Zero breaking change** | API contract 100% tương thích ngược |
| **Deploy linh hoạt** | Frontend deploy lên Vercel/CDN; Backend deploy trên Docker/K8s |

---

## 3. Danh sách Giải pháp

Ba giải pháp được đề xuất, theo mức độ phức tạp tăng dần:

| # | Giải pháp | Complexity | Risk | Thời gian |
|---|-----------|-----------|------|-----------|
| **01** | [API Client Abstraction Layer](./01-api-client-abstraction.md) | Thấp | Thấp | 2–3 tuần |
| **02** | [Strangler Fig Migration](./02-strangler-fig-migration.md) | Trung bình | Trung bình | 8–12 tuần |
| **03** | [Full Decoupled SPA + API Gateway](./03-full-decoupled-spa.md) | Cao | Cao | 16–20 tuần |

---

## 4. Điểm Coupling Hiện tại (Analysis)

### 4.1 API Calls từ Frontend → Daemon

Tất cả được tập trung trong 2 file chính:

| File | API Calls | Domain |
|------|-----------|--------|
| `src/providers/registry.ts` | ~80 functions | Skills, DesignSystems, Connectors, Deploy |
| `src/providers/daemon.ts` | ~15 functions | Runs, SSE streaming |
| `src/state/config.ts` | ~10 functions | App config, Media providers |
| `src/state/projects.ts` | ~15 functions | Projects CRUD |

### 4.2 Deployment Coupling

```typescript
// apps/web/next.config.ts
// Dev mode: Next.js proxy → daemon
rewrites: [
  { source: '/api/:path*', destination: `http://127.0.0.1:7456/api/:path*` },
  { source: '/artifacts/:path*', destination: `http://127.0.0.1:7456/artifacts/:path*` },
  { source: '/frames/:path*', destination: `http://127.0.0.1:7456/frames/:path*` },
]

// Prod mode: static export, daemon serves the HTML
output: 'export'  // Next.js generates static HTML
// Daemon's cli.ts serves: express.static('out/') 
```

### 4.3 Config State Coupling

```typescript
// src/state/config.ts — config được split giữa localStorage và daemon
// localStorage: UI prefs (theme, etc.)
// Daemon: installationId, telemetry, privacyDecisionAt, API keys
```

### 4.4 SSE Streaming Coupling

```typescript
// src/providers/daemon.ts — streamViaDaemon()
// 1. POST /api/runs → tạo run, nhận runId
// 2. GET /api/runs/:id/events → SSE stream
// 3. POST /api/runs/:id/cancel → cancel
// 4. POST /api/runs/:id/tool-result → tool answer
```

---

## 5. Mapping API → Go Services

Theo specs/services/00-overview.md, mapping đầy đủ:

```
Frontend Endpoint          → Go Service
─────────────────────────────────────────────────────
POST   /api/runs           → AgentService.CreateRun
GET    /api/runs/:id/events→ AgentService.StreamRunEvents [SSE]
POST   /api/runs/:id/cancel→ AgentService.CancelRun
POST   /api/runs/:id/tool-result → AgentService.SubmitToolResult

GET    /api/projects       → ProjectService.ListProjects
POST   /api/projects       → ProjectService.CreateProject
GET    /api/projects/:id   → ProjectService.GetProject
...

GET    /api/design-systems → DesignSystemService.List
GET    /api/skills         → SkillService.List
GET    /api/agents         → AgentService.ListAgents

GET    /api/media/config   → ConfigService.GetMediaConfig
GET    /api/app-config     → ConfigService.GetAppConfig
PUT    /api/app-config     → ConfigService.UpdateAppConfig

POST   /api/active         → McpService.SetActiveContext
GET    /artifacts/*        → ProjectService.ServeArtifact
GET    /frames/*           → ProjectService.ServeFrame
```

**Kết luận:** API Gateway Go (port 7456) **có thể thay thế hoàn toàn daemon** với cùng endpoint contract — frontend **không cần thay đổi gì**.

---

## 6. Khuyến nghị

**Áp dụng kết hợp:**
1. Trước tiên: Giải pháp **01** — tạo abstraction layer (ít rủi ro, thực hiện ngay)
2. Song song: Giải pháp **02** — migrate backend từng service theo Strangler Fig
3. Cuối cùng: Giải pháp **03** — hoàn thiện full decoupled deployment

---

## 7. Tài liệu Chi tiết

- [01-api-client-abstraction.md](./01-api-client-abstraction.md) — Abstraction Layer
- [02-strangler-fig-migration.md](./02-strangler-fig-migration.md) — Strangler Fig Migration
- [03-full-decoupled-spa.md](./03-full-decoupled-spa.md) — Full Decoupled SPA
- [04-implementation-roadmap.md](./04-implementation-roadmap.md) — Lộ trình thực thi
