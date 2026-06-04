# Lộ trình Thực thi — Frontend Separation

> **Document**: Implementation Roadmap  
> **Version**: 1.0.0  
> **Date**: 2026-06-03

---

## 1. Tổng quan Timeline

```
Tháng 1         Tháng 2         Tháng 3         Tháng 4         Tháng 5
│               │               │               │               │
├─── PHASE 0 ───┤
│ API Abstraction│
│ (Giải pháp 01) │
│                │
│        ├────── PHASE 1 ───────────────────────┤
│        │ Strangler Fig (Giải pháp 02)          │
│        │ Gateway + Agent + Project Services   │
│        │                                      │
│        │              ├──────── PHASE 2 ───────────────────────────┤
│        │              │ Remaining Services + Full Decoupled Deploy  │
│        │              │ (Giải pháp 02 + 03)                        │
```

---

## 2. Phase 0 — API Abstraction Layer (Tuần 1–3)

> **Mục tiêu**: Chuẩn bị frontend sẵn sàng swap backend bất cứ lúc nào  
> **Phạm vi**: Chỉ `apps/web` — zero backend changes

### Tuần 1: Tạo API Layer

| Task | File | Effort |
|------|------|--------|
| Tạo `BaseApiClient` | `src/api/client.ts` | 4h |
| Tạo `IProjectApiClient` + HTTP impl | `src/api/projects/` | 8h |
| Tạo `IRunsApiClient` + HTTP impl | `src/api/runs/` | 12h |
| Tạo `IDesignSystemApiClient` + impl | `src/api/design-systems/` | 8h |
| Tạo `ISkillApiClient` + impl | `src/api/skills/` | 4h |
| Tạo `IConfigApiClient` + impl | `src/api/config/` | 6h |
| Tạo `IAgentApiClient` + impl | `src/api/agents/` | 4h |
| Tạo `api/index.ts` (singleton) | `src/api/index.ts` | 2h |

### Tuần 2: Refactor providers/

| Task | File | Effort |
|------|------|--------|
| Refactor `providers/registry.ts` → `api.*` | Existing file | 16h |
| Refactor `providers/daemon.ts` → `api.runs.*` | Existing file | 8h |
| Refactor `state/config.ts` → `api.config.*` | Existing file | 6h |
| Refactor `state/projects.ts` → `api.projects.*` | Existing file | 6h |

### Tuần 3: Tests

| Task | Coverage |
|------|---------|
| Unit tests cho mỗi API client | 80%+ |
| Integration tests với daemon | Smoke test toàn bộ endpoints |
| Regression test E2E | Critical paths: create project, run agent, SSE streaming |

**Deliverable**: Frontend hoạt động như cũ, nhưng logic API call nằm trong `src/api/` có interface rõ ràng.

---

## 3. Phase 1 — API Gateway + Core Services (Tuần 4–11)

> **Mục tiêu**: Deploy Go API Gateway + Agent Service + Project Service  
> **Phạm vi**: Go codebase mới + Docker Compose

### Tuần 4–5: Go API Gateway

Theo [specs/services/01-api-gateway.md](../services/01-api-gateway.md):

```
Deliverables:
├── gateway/cmd/main.go
├── gateway/internal/config/config.go
├── gateway/internal/middleware/auth.go
├── gateway/internal/middleware/cors.go
├── gateway/internal/middleware/rate_limit.go
├── gateway/internal/proxy/daemon_proxy.go   ← Strangler Fig fallback
├── gateway/internal/router/router.go
└── Dockerfile
```

**Acceptance Criteria:**
- [ ] Gateway khởi động trên port 7456
- [ ] Tất cả requests fallback sang daemon (port 7457) thành công
- [ ] `/api/health` trả về 200
- [ ] JWT middleware validate token
- [ ] Rate limiting hoạt động
- [ ] CORS headers đúng

### Tuần 6–8: Agent Service

Theo [specs/services/03-agent-service.md](../services/03-agent-service.md):

```
Deliverables:
├── agent-service/cmd/main.go
├── agent-service/internal/domain/
│   ├── run.go          ← Run entity
│   └── repository.go   ← RunRepository interface
├── agent-service/internal/usecase/
│   ├── create_run.go
│   ├── stream_run.go
│   └── cancel_run.go
├── agent-service/internal/infra/
│   ├── db/run_repo.go
│   └── cli/agent_executor.go  ← Spawn claude/codex/gemini
├── agent-service/internal/delivery/
│   └── grpc/handler.go
└── agent-service/proto/agent/v1/agent.proto
```

**Acceptance Criteria:**
- [ ] `POST /api/runs` tạo run thành công
- [ ] `GET /api/runs/:id/events` SSE streaming hoạt động
- [ ] Claude Code CLI spawn và stream output
- [ ] `POST /api/runs/:id/cancel` dừng agent
- [ ] `POST /api/runs/:id/tool-result` answer tool call
- [ ] Run state persist trong DB (SQLite local / PostgreSQL prod)

### Tuần 9–11: Project Service

Theo [specs/services/02-project-service.md](../services/02-project-service.md):

```
Deliverables:
├── project-service/cmd/main.go
├── project-service/internal/domain/
│   ├── project.go
│   ├── conversation.go
│   └── repository.go
├── project-service/internal/usecase/
│   ├── project_usecase.go
│   └── conversation_usecase.go
├── project-service/internal/infra/
│   ├── db/
│   ├── fs/workspace.go   ← Local filesystem operations
│   └── static/           ← Serve /artifacts/* /frames/*
└── project-service/proto/project/v1/
```

**Acceptance Criteria:**
- [ ] `GET/POST /api/projects` CRUD hoạt động
- [ ] `GET /api/projects/:id/files` list files
- [ ] `/artifacts/:path*` serve static files
- [ ] `/frames/:path*` serve iframes
- [ ] Data tương thích với daemon's SQLite schema (migration tool)

**Phase 1 Validation:**
```bash
# A/B test: Switch 10% traffic → Go services, monitor errors
FF_GO_AGENT_SERVICE=true
FF_GO_PROJECT_SERVICE=true

# Compare response: curl daemon vs gateway
./scripts/compare-responses.sh /api/projects
./scripts/compare-responses.sh /api/runs
```

---

## 4. Phase 2 — Remaining Services (Tuần 12–18)

### Tuần 12–13: Design System Service

Theo [specs/services/04-design-system-service.md](../services/04-design-system-service.md):

| Endpoint | Priority |
|----------|---------|
| `GET /api/design-systems` | P0 |
| `GET /api/design-systems/:id` | P0 |
| `POST /api/design-systems` | P1 |
| Design system generation jobs | P1 |

### Tuần 13–14: Skill Service + Config Service

**Skill Service** (theo [specs/services/09-skill-service.md](../services/09-skill-service.md)):
- Serve skill YAML files từ `skills/` directory
- `GET /api/skills`, `GET /api/skills/:id`

**Config Service** (theo [specs/services/10-config-service.md](../services/10-config-service.md)):
- `GET/PUT /api/app-config` — App preferences
- `GET/PUT /api/media/config` — Media provider API keys (encrypted)
- `GET/PUT /api/connectors` — Composio config

### Tuần 15: MCP Service

Theo [specs/services/07-mcp-service.md](../services/07-mcp-service.md):
- `POST /api/active` — Set active context
- `/mcp/*` — MCP protocol passthrough

### Tuần 16: Memory Service

Theo [specs/services/08-memory-service.md](../services/08-memory-service.md):
- Vector embedding và search
- Context persistence per-project

### Tuần 17–18: Daemon Retirement

```bash
# Checklist trước khi retire daemon:

# 1. Verify 100% routes đã migrate sang Go
./scripts/verify-all-routes-migrated.sh

# 2. Verify không còn fallback proxy nào active
grep "daemon.ToDaemon" gateway/internal/router/router.go
# Expected: 0 results

# 3. Final data sync (daemon SQLite → PostgreSQL)
./scripts/final-data-migration.sh

# 4. Shutdown daemon
# Remove daemon từ docker-compose
# Remove daemon startup từ Electron main

# 5. Archive daemon code
git tag daemon-retirement-2026-Q3
# Daemon code giữ lại nhưng không build
```

---

## 5. Phase 3 — Full Decoupled Deployment (Tuần 19–20)

### Tuần 19: Frontend Deployment Mode

```typescript
// apps/web/next.config.ts
// Enable server mode for independent deployment

// Thêm environment-aware rewrite:
async rewrites() {
  const apiUrl = process.env.NEXT_PUBLIC_API_GATEWAY_URL ?? '';
  if (!apiUrl) return []; // dev mode: no rewrite needed
  return [
    { source: '/api/:path*', destination: `${apiUrl}/api/:path*` },
    { source: '/artifacts/:path*', destination: `${apiUrl}/artifacts/:path*` },
    { source: '/frames/:path*', destination: `${apiUrl}/frames/:path*` },
  ];
}
```

```dockerfile
# apps/web/Dockerfile — [NEW]
# Multi-stage build cho standalone deployment
FROM node:22-alpine AS builder
# ... build steps

FROM node:22-alpine AS runner
# ... runtime
EXPOSE 3000
CMD ["node", "server.js"]
```

### Tuần 20: Validation & Hardening

| Validation | Tool | Pass Criteria |
|-----------|------|--------------|
| E2E test toàn bộ user flows | Playwright | 100% pass |
| Load test API Gateway | k6 | p99 < 200ms |
| SSE streaming stress test | Custom | 100 concurrent streams |
| CORS cross-origin test | Playwright | No CORS errors |
| Security scan | OWASP ZAP | No High findings |

---

## 6. Dependency Map

```
Phase 0 (API Abstraction)
    └── Unblocks: Phase 1, 2, 3

Phase 1 (Gateway + Agent + Project)
    └── Requires: Phase 0 complete
    └── Unblocks: Phase 2, 3

Phase 2 (Remaining Services)
    └── Requires: Phase 1 complete (Gateway deployed)
    └── Each service can proceed in parallel

Phase 3 (Full Decoupled)
    └── Requires: Phase 2 complete (all services live)
```

---

## 7. Team Allocation Đề xuất

| Role | Phase 0 | Phase 1 | Phase 2 | Phase 3 |
|------|---------|---------|---------|---------|
| Frontend Dev (1–2) | Abstraction layer, tests | Validation, CORS fixes | Config migration UX | Deploy pipeline |
| Go Dev (2–3) | — | Gateway + Agent + Project | Remaining services | Perf, security |
| DevOps (1) | — | Docker Compose setup | K8s manifests | CI/CD, monitoring |

---

## 8. Monitoring & Observability

Theo [specs/services/11-telemetry-service.md](../services/11-telemetry-service.md):

```yaml
# Metrics cần track sau mỗi phase:
metrics:
  - name: api_gateway_request_duration_p99
    alert: > 500ms for 5min
  - name: sse_stream_error_rate
    alert: > 1% for 1min
  - name: agent_run_success_rate
    alert: < 95% for 5min
  - name: db_query_duration_p99
    alert: > 100ms for 5min

dashboards:
  - Grafana: API Gateway overview
  - Langfuse: Agent run traces
  - PostHog: Frontend error rate
```

---

## 9. Rollback Plan

Mỗi phase có rollback procedure:

### Phase 1 Rollback
```bash
# Feature flag tắt Go services → daemon handles all
FF_GO_AGENT_SERVICE=false
FF_GO_PROJECT_SERVICE=false
# Gateway fallback về daemon tự động
```

### Phase 2 Rollback
```bash
# Tắt từng service một
FF_GO_DESIGN_SYSTEM_SERVICE=false
FF_GO_SKILL_SERVICE=false
# Gateway fallback về daemon cho route đó
```

### Phase 3 Rollback
```bash
# Khởi động lại daemon (port 7457)
# Gateway fallback toàn bộ về daemon
# Frontend deployment: rollback Vercel/Docker image
```

---

## 10. Checklist Hoàn thành

### Phase 0 ✅ Ready to ship khi:
- [ ] API clients có interface rõ ràng
- [ ] `providers/registry.ts` delegate sang `api.*`
- [ ] `providers/daemon.ts` delegate sang `api.runs.*`
- [ ] Unit tests > 80%
- [ ] Smoke test pass với daemon

### Phase 1 ✅ Ready to ship khi:
- [ ] Gateway deploy, fallback daemon hoạt động
- [ ] Agent Service: SSE streaming E2E pass
- [ ] Project Service: CRUD + file serving pass
- [ ] A/B test 24h: 0 regressions
- [ ] Response format identical với daemon

### Phase 2 ✅ Ready to ship khi:
- [ ] Tất cả 10 services deployed
- [ ] Design System Service: import/generate hoạt động
- [ ] Config Service: API keys encrypted và persist
- [ ] MCP endpoint hoạt động
- [ ] Daemon có thể tắt mà frontend vẫn hoạt động

### Phase 3 ✅ Ready to ship khi:
- [ ] Frontend deploy độc lập (Vercel/Docker)
- [ ] CORS hoạt động cross-origin
- [ ] Electron Desktop vẫn hoạt động
- [ ] Load test pass
- [ ] Security scan pass
- [ ] Documentation cập nhật

---

## 11. Tài liệu Liên quan

| Spec | Link |
|------|------|
| API Gateway | [01-api-gateway.md](../services/01-api-gateway.md) |
| Project Service | [02-project-service.md](../services/02-project-service.md) |
| Agent Service | [03-agent-service.md](../services/03-agent-service.md) |
| Design System Service | [04-design-system-service.md](../services/04-design-system-service.md) |
| Config Service | [10-config-service.md](../services/10-config-service.md) |
| Clean Architecture | [12-clean-architecture.md](../services/12-clean-architecture.md) |
| Deployment | [14-deployment.md](../services/14-deployment.md) |
| Giải pháp 01 | [01-api-client-abstraction.md](./01-api-client-abstraction.md) |
| Giải pháp 02 | [02-strangler-fig-migration.md](./02-strangler-fig-migration.md) |
| Giải pháp 03 | [03-full-decoupled-spa.md](./03-full-decoupled-spa.md) |
