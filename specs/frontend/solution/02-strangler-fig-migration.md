# Giải pháp 02 — Strangler Fig Migration

> **Độ phức tạp**: Trung bình  
> **Rủi ro**: Trung bình  
> **Thời gian ước tính**: 8–12 tuần  
> **Phạm vi thay đổi**: `apps/web` + Go API Gateway + Go Services (theo `specs/services/`)

---

## 1. Mô tả

**Strangler Fig Pattern** — thay thế daemon dần dần bằng cách đặt **Go API Gateway** (specs/services/01-api-gateway.md) giữa frontend và backend, sau đó migrate từng service một:

```
Giai đoạn 1:
  Frontend → API Gateway (Go) → Daemon (TypeScript) [fallback toàn bộ]

Giai đoạn 2:
  Frontend → API Gateway (Go) ─┬─→ Agent Service (Go) [runs]
                                ├─→ Project Service (Go) [projects]
                                └─→ Daemon (TypeScript) [phần còn lại]

Giai đoạn 3:
  Frontend → API Gateway (Go) → [Tất cả Go Services]
                                 [Daemon retired]
```

---

## 2. Strangler Fig Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    apps/web (Next.js)                           │
│  Không thay đổi — vẫn gọi /api/*, /artifacts/*, /frames/*      │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTP (port 7456)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│            API GATEWAY (Go — Echo v4) — port 7456               │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │               ROUTING DECISION TABLE                     │    │
│  │                                                          │    │
│  │  /api/runs/*          → Agent Service (Go :8082)  ✅     │    │
│  │  /api/projects/*      → Project Service (Go :8081) ✅    │    │
│  │  /api/design-systems/*→ Daemon (TS :7457)         🔄     │    │
│  │  /api/skills/*        → Daemon (TS :7457)         🔄     │    │
│  │  /api/media/*         → Daemon (TS :7457)         🔄     │    │
│  │  /api/app-config      → Daemon (TS :7457)         🔄     │    │
│  │  /artifacts/*         → Daemon (TS :7457)         🔄     │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
          │ gRPC                                  │ HTTP proxy
          ├─→ Agent Service :8082                 └─→ Daemon :7457
          └─→ Project Service :8081
```

---

## 3. Migration Phases

### Phase 1 — Gateway + Core Services (Tuần 1–4)

**Mục tiêu**: Deploy API Gateway, migrate Runs + Projects.

**Bước 1**: Đổi port daemon từ 7456 → 7457 (internal)

```yaml
# deploy/dev/.env
OD_PORT=7457  # Daemon chuyển sang internal port
GATEWAY_PORT=7456  # Gateway nhận traffic từ frontend
```

**Bước 2**: Deploy API Gateway với full fallback về Daemon

```go
// gateway/internal/router/router.go

// Tất cả routes ban đầu fallback sang daemon
func (r *Router) Setup(e *echo.Echo) {
    // Fallback proxy — daemon handles everything initially
    e.Any("/*", r.proxy.ToDaemon)
    
    // Phase 1 overrides — sẽ uncommment từng cái
    // e.POST("/api/runs", r.agent.CreateRun)
    // e.GET("/api/runs/:id/events", r.agent.StreamRunEvents)
}
```

**Bước 3**: Migrate Agent Service (Runs) — theo [specs/services/03-agent-service.md](../services/03-agent-service.md)

```go
// Uncomment khi Agent Service sẵn sàng
e.POST("/api/runs", middleware.Auth(r.agent.CreateRun))
e.GET("/api/runs/:id/events", r.agent.StreamRunEvents)  // SSE
e.POST("/api/runs/:id/cancel", r.agent.CancelRun)
e.POST("/api/runs/:id/tool-result", r.agent.SubmitToolResult)
e.GET("/api/runs", r.agent.ListRuns)
e.GET("/api/runs/:id", r.agent.GetRun)
```

**Bước 4**: Migrate Project Service — theo [specs/services/02-project-service.md](../services/02-project-service.md)

```go
// Uncomment khi Project Service sẵn sàng
e.GET("/api/projects", r.project.ListProjects)
e.POST("/api/projects", r.project.CreateProject)
e.GET("/api/projects/:id", r.project.GetProject)
e.PUT("/api/projects/:id", r.project.UpdateProject)
e.DELETE("/api/projects/:id", r.project.DeleteProject)
e.GET("/api/projects/:id/files", r.project.ListFiles)
e.GET("/artifacts/*", r.project.ServeArtifact)
e.GET("/frames/*", r.project.ServeFrame)
```

**Validation Phase 1**:
- Frontend không thay đổi gì
- A/B test: 10% traffic qua Go services, 90% qua daemon
- Compare response payloads — must be identical

---

### Phase 2 — Design System + Skills + Config (Tuần 5–8)

**Services cần build:**
- Design System Service (specs/services/04-design-system-service.md)
- Skill Service (specs/services/09-skill-service.md)
- Config Service (specs/services/10-config-service.md)

```go
// Uncomment sau Phase 2
e.GET("/api/design-systems", r.designSystem.List)
e.POST("/api/design-systems", r.designSystem.Create)
e.GET("/api/design-systems/:id", r.designSystem.Get)
e.DELETE("/api/design-systems/:id", r.designSystem.Delete)

e.GET("/api/skills", r.skill.List)
e.GET("/api/skills/:id", r.skill.Get)

e.GET("/api/app-config", r.config.GetAppConfig)
e.PUT("/api/app-config", r.config.UpdateAppConfig)
e.GET("/api/media/config", r.config.GetMediaConfig)
e.PUT("/api/media/config", r.config.UpdateMediaConfig)
```

---

### Phase 3 — Media + Plugin + MCP + Memory (Tuần 9–12)

```go
// Các services phức tạp hơn
// Media: image/video generation
// Plugin: plugin registry & execution
// MCP: MCP protocol endpoint
// Memory: embedding & search
```

---

### Phase 4 — Retire Daemon

Khi tất cả routes đã migrate:
1. Remove fallback proxy trong Gateway
2. Shutdown TypeScript daemon
3. Update Docker Compose — loại bỏ daemon container

---

## 4. Data Migration Strategy

### 4.1 SQLite → PostgreSQL

Daemon hiện dùng SQLite (better-sqlite3). Go services dùng PostgreSQL (prod) hoặc SQLite (local).

```sql
-- Daemon SQLite schema (apps/daemon/src/db.ts):
projects (id, name, kind, metadata, created_at, updated_at)
conversations (id, project_id, title, created_at)
messages (id, conversation_id, role, content, events_json, created_at)
runs (id, project_id, conversation_id, agent_id, status, ...)

-- Go Project Service PostgreSQL schema (tương đương):
CREATE TABLE projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'web-ui',
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Migration tool** (one-time):
```bash
# Tạo migration script TypeScript → Go PostgreSQL
apps/daemon/scripts/migrate-to-postgres.ts
```

### 4.2 File System — Giữ nguyên

Project files, artifacts vẫn lưu trên local filesystem (không thay đổi vị trí).
Go services đọc từ cùng path như daemon (`OD_WORKSPACE_ROOT`).

---

## 5. Frontend Changes — Tối thiểu

Với Strangler Fig, frontend **gần như không cần thay đổi**. Chỉ một số điều chỉnh nhỏ:

### 5.1 Environment Variable

```typescript
// apps/web/next.config.ts — dev rewrite target
// Before: daemon on 7456
const DAEMON_PORT = Number(process.env.OD_PORT) || 7456;

// After: point to gateway on 7456 (same!)
// No change needed — gateway takes over port 7456
```

### 5.2 Health Check Endpoint

Go Gateway cần expose `/api/health`:

```go
// gateway — health endpoint
e.GET("/api/health", func(c echo.Context) error {
    return c.JSON(200, map[string]string{"status": "ok"})
})
```

Frontend `providers/registry.ts`:
```typescript
export async function daemonIsLive(): Promise<boolean> {
  // KHÔNG THAY ĐỔI — vẫn gọi /api/health
  const resp = await fetch('/api/health');
  return resp.ok;
}
```

### 5.3 CORS Configuration

```go
// gateway/internal/config/config.go
AllowedOrigins: []string{
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    // + OD_ALLOWED_ORIGINS env var
}
```

---

## 6. Go API Gateway — Implementation

Theo `specs/services/01-api-gateway.md`, thêm **Daemon Proxy** cho giai đoạn transition:

```go
// gateway/internal/proxy/daemon_proxy.go

package proxy

import (
    "net/http"
    "net/http/httputil"
    "net/url"
    "github.com/labstack/echo/v4"
)

type DaemonProxy struct {
    target *url.URL
    proxy  *httputil.ReverseProxy
}

func NewDaemonProxy(daemonURL string) (*DaemonProxy, error) {
    target, err := url.Parse(daemonURL)
    if err != nil {
        return nil, err
    }
    return &DaemonProxy{
        target: target,
        proxy:  httputil.NewSingleHostReverseProxy(target),
    }, nil
}

// ToDaemon proxies request to TypeScript daemon (fallback)
func (p *DaemonProxy) ToDaemon(c echo.Context) error {
    req := c.Request()
    req.URL.Host = p.target.Host
    req.URL.Scheme = p.target.Scheme
    req.Header.Set("X-Forwarded-Host", req.Header.Get("Host"))
    p.proxy.ServeHTTP(c.Response(), req)
    return nil
}

// ToSSE proxies SSE stream from daemon (preserves chunked encoding)
func (p *DaemonProxy) ToSSEDaemon(c echo.Context) error {
    // Same as ToDaemon but with SSE headers
    c.Response().Header().Set("X-Accel-Buffering", "no")
    c.Response().Header().Set("Cache-Control", "no-cache")
    return p.ToDaemon(c)
}
```

```go
// gateway/internal/router/router.go

type Router struct {
    daemon        *proxy.DaemonProxy
    agentClient   *upstream.AgentClient   // nil until Phase 1 complete
    projectClient *upstream.ProjectClient  // nil until Phase 1 complete
}

func (r *Router) Setup(e *echo.Echo) {
    // Auth middleware
    e.Use(middleware.JWTAuth(r.config))
    e.Use(middleware.RateLimit(r.redis))
    e.Use(middleware.Tracing())

    // === Phase 1: Core Services ===
    if r.agentClient != nil {
        e.POST("/api/runs", r.handleCreateRun)
        e.GET("/api/runs/:id/events", r.handleStreamRunEvents)
        e.POST("/api/runs/:id/cancel", r.handleCancelRun)
        e.POST("/api/runs/:id/tool-result", r.handleSubmitToolResult)
    }

    if r.projectClient != nil {
        e.GET("/api/projects", r.handleListProjects)
        e.POST("/api/projects", r.handleCreateProject)
        // ... more project routes
        e.GET("/artifacts/*", r.handleServeArtifact)
        e.GET("/frames/*", r.handleServeFrame)
    }

    // === Fallback: Daemon proxy (everything else) ===
    e.Any("/*", r.daemon.ToDaemon)
}
```

---

## 7. Validation & Rollback

### Shadow Mode Testing

Trong transition, Gateway có thể chạy **shadow mode**:

```go
// Gửi request đến CẢ Go service VÀ daemon, so sánh response
func (h *Handler) ShadowCompareListProjects(c echo.Context) error {
    // Primary: Go service
    goPrimary := h.projectClient.List(c.Request().Context())
    
    // Shadow: Daemon (async, không block response)
    go func() {
        daemonResult := h.daemon.ListProjects(c.Request().Context())
        if !deepEqual(goPrimary, daemonResult) {
            slog.Warn("shadow mismatch", "endpoint", "/api/projects")
        }
    }()
    
    return c.JSON(200, goPrimary)
}
```

### Feature Flag

```go
// Config-driven routing
type FeatureFlags struct {
    UseGoAgentService   bool `env:"FF_GO_AGENT_SERVICE" default:"false"`
    UseGoProjectService bool `env:"FF_GO_PROJECT_SERVICE" default:"false"`
}
```

### Rollback Plan

```bash
# Rollback: Tắt Go services, point gateway về daemon
FF_GO_AGENT_SERVICE=false
FF_GO_PROJECT_SERVICE=false
# Gateway tự động fallback về daemon proxy
```

---

## 8. Docker Compose — Transition Setup

```yaml
# deploy/dev/docker-compose.local.yml

services:
  # API Gateway (Go) — nhận toàn bộ frontend traffic
  gateway:
    image: open-design/gateway:latest
    ports: ["7456:7456"]
    environment:
      DAEMON_URL: "http://daemon:7457"  # Fallback
      PROJECT_SERVICE_URL: "http://project-service:8081"
      AGENT_SERVICE_URL: "http://agent-service:8082"
      FF_GO_AGENT_SERVICE: "true"
      FF_GO_PROJECT_SERVICE: "false"  # Not ready yet

  # Daemon vẫn chạy — chỉ đổi port sang 7457
  daemon:
    image: open-design/daemon:latest
    ports: ["7457:7457"]  # Internal only, không expose 7456
    environment:
      OD_PORT: "7457"

  # Go services (enable từng cái)
  agent-service:
    image: open-design/agent-service:latest
    ports: ["8082:8082"]

  # project-service: (uncomment khi ready)
  # project-service:
  #   image: open-design/project-service:latest
  #   ports: ["8081:8081"]
```

---

## 9. Rủi ro & Giảm thiểu

| Rủi ro | Xác suất | Ảnh hưởng | Giảm thiểu |
|--------|---------|----------|------------|
| Response format mismatch | Trung bình | Cao | Shadow testing trước khi switch |
| SSE streaming break | Thấp | Cao | E2E test với SSE consumer |
| Data migration corruption | Thấp | Cao | Backup SQLite trước migration |
| Go service performance | Thấp | Thấp | Load test với realistic traffic |
| Auth token mismatch | Trung bình | Cao | Verify JWT format giữa daemon và gateway |

---

## 10. Success Criteria

- [ ] API Gateway nhận 100% traffic từ frontend
- [ ] Agent Service: SSE streaming hoạt động end-to-end
- [ ] Project Service: CRUD + file listing hoạt động
- [ ] Response latency ≤ daemon + 5ms overhead
- [ ] Zero 5xx errors trong 24h sau migration mỗi phase
- [ ] Frontend không cần thay đổi gì
