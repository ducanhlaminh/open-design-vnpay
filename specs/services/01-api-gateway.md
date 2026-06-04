# 01 — API Gateway

> **Port**: 7456 (public HTTP/SSE)  
> **Role**: Single entry point — routing, auth, rate limiting, SSE proxy

---

## 1. Vai trò

API Gateway là **điểm duy nhất** mà client (Web, Desktop, CLI) giao tiếp. Nó:

- **Authenticate** mọi request (JWT session token hoặc MCP bearer token)
- **Route** request đến đúng upstream gRPC service
- **Proxy SSE** streams từ Agent Service về client
- **Rate limit** per IP / per token
- **Validate** CORS origins (giống `origin-validation.ts` hiện tại)
- **Inject** trace context (OpenTelemetry) vào mọi request

Gateway **không** chứa business logic. Nó là một smart reverse proxy.

---

## 2. Cấu trúc thư mục (Clean Architecture)

```
gateway/
├── cmd/
│   └── main.go                    # Entry point
├── internal/
│   ├── config/
│   │   └── config.go              # Viper config loading
│   ├── middleware/
│   │   ├── auth.go                # JWT + MCP token validation
│   │   ├── cors.go                # Origin validation
│   │   ├── rate_limit.go          # Rate limiting (Redis-backed)
│   │   ├── tracing.go             # OpenTelemetry middleware
│   │   └── logging.go             # Structured request logging
│   ├── router/
│   │   └── router.go              # Echo route registration
│   ├── proxy/
│   │   ├── grpc_proxy.go          # Generic gRPC → HTTP proxy
│   │   └── sse_proxy.go           # SSE streaming proxy
│   └── upstream/
│       ├── registry.go            # Service registry / discovery
│       ├── project_client.go      # gRPC client cho Project Service
│       ├── agent_client.go        # gRPC client cho Agent Service
│       ├── design_system_client.go
│       ├── media_client.go
│       ├── plugin_client.go
│       ├── mcp_client.go
│       ├── memory_client.go
│       ├── skill_client.go
│       └── config_client.go
├── proto/                         # Generated protobuf Go code (từ shared proto)
└── Dockerfile
```

---

## 3. Route Map

```
Method  Path                                → Upstream Service
──────────────────────────────────────────────────────────────────────
# Agent / Runs
POST    /api/runs                           → AgentService.CreateRun
GET     /api/runs/:id/events                → AgentService.StreamRunEvents [SSE]
POST    /api/runs/:id/cancel                → AgentService.CancelRun
POST    /api/runs/:id/tool-result           → AgentService.SubmitToolResult

# Projects
GET     /api/projects                       → ProjectService.ListProjects
POST    /api/projects                       → ProjectService.CreateProject
GET     /api/projects/:id                   → ProjectService.GetProject
PUT     /api/projects/:id                   → ProjectService.UpdateProject
DELETE  /api/projects/:id                   → ProjectService.DeleteProject
GET     /api/projects/:id/files             → ProjectService.ListFiles
GET     /api/projects/:id/conversations     → ProjectService.ListConversations
POST    /api/projects/:id/conversations     → ProjectService.CreateConversation

# Design Systems
GET     /api/design-systems                 → DesignSystemService.List
POST    /api/design-systems                 → DesignSystemService.Create
GET     /api/design-systems/:id             → DesignSystemService.Get
DELETE  /api/design-systems/:id             → DesignSystemService.Delete

# Skills
GET     /api/skills                         → SkillService.List
GET     /api/skills/:id                     → SkillService.Get

# Agents (probe CLI agents)
GET     /api/agents                         → AgentService.ListAgents

# Media config
GET     /api/media/config                   → ConfigService.GetMediaConfig
PUT     /api/media/config                   → ConfigService.UpdateMediaConfig

# App config
GET     /api/app-config                     → ConfigService.GetAppConfig
PUT     /api/app-config                     → ConfigService.UpdateAppConfig

# Active context (MCP)
POST    /api/active                         → McpService.SetActiveContext

# Static file serving
GET     /artifacts/*                        → ProjectService.ServeArtifact
GET     /frames/*                           → ProjectService.ServeFrame

# MCP protocol endpoint
ANY     /mcp/*                              → McpService (passthrough)

# Health & metrics
GET     /health                             → Gateway internal
GET     /metrics                            → Prometheus metrics
```

---

## 4. Authentication Flow

```
Request arrives
    │
    ▼
Middleware: auth.go
    │
    ├── Path in /mcp/* ?
    │     └── Validate Bearer token → McpService.ValidateToken (gRPC)
    │
    ├── Header: X-Desktop-Auth present?
    │     └── Validate desktop session → ConfigService.ValidateDesktopToken
    │
    ├── No auth header?
    │     └── Check origin (127.0.0.1 / LAN) → allow local access
    │
    └── JWT token?
          └── Validate locally (public key from ConfigService at startup)
```

---

## 5. SSE Proxy Pattern

Agent Service gửi events qua **gRPC server streaming**. Gateway translate sang SSE:

```go
// sse_proxy.go
func (p *SSEProxy) ProxyRunEvents(c echo.Context) error {
    runID := c.Param("id")
    lastEventID := c.Request().Header.Get("Last-Event-ID")

    // Set SSE headers
    c.Response().Header().Set("Content-Type", "text/event-stream")
    c.Response().Header().Set("Cache-Control", "no-cache")
    c.Response().Header().Set("X-Accel-Buffering", "no")
    c.Response().WriteHeader(http.StatusOK)

    // Open gRPC stream to Agent Service
    stream, err := p.agentClient.StreamRunEvents(c.Request().Context(), &agentpb.StreamRequest{
        RunId:       runID,
        LastEventId: lastEventID,
    })

    flusher := c.Response().Writer.(http.Flusher)
    for {
        event, err := stream.Recv()
        if err == io.EOF { break }
        if err != nil { /* handle */ break }

        fmt.Fprintf(c.Response(), "id: %s\nevent: %s\ndata: %s\n\n",
            event.Id, event.Type, event.Data)
        flusher.Flush()
    }
    return nil
}
```

---

## 6. Rate Limiting

| Rule | Limit | Window |
|------|-------|--------|
| Per IP (anonymous local) | 1000 req | 1 min |
| Per MCP token | 200 req | 1 min |
| SSE connections per IP | 10 concurrent | — |
| Run creation per token | 20 runs | 1 min |

Implementation: **Redis sliding window** (token bucket).

---

## 7. Configuration

```yaml
# gateway/config.yaml
server:
  port: 7456
  host: "127.0.0.1"
  allowed_origins:
    - "http://localhost:3000"
    - "http://127.0.0.1:3000"

upstreams:
  project_service:  "localhost:8081"
  agent_service:    "localhost:8082"
  design_system:    "localhost:8083"
  media_service:    "localhost:8084"
  plugin_service:   "localhost:8085"
  mcp_service:      "localhost:8086"
  memory_service:   "localhost:8087"
  skill_service:    "localhost:8088"
  config_service:   "localhost:8089"

rate_limit:
  redis_url: "redis://localhost:6379"
  enabled: true

tracing:
  endpoint: "http://localhost:4317"  # OTLP gRPC
  service_name: "api-gateway"
```

---

## 8. Không chứa trong Gateway

- ❌ Business logic
- ❌ Database access
- ❌ File I/O
- ❌ AI agent spawning
- ✅ Chỉ routing, auth, rate limiting, tracing
