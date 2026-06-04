# DEV-T-01 — API Gateway Implementation Tasks

> **Service**: `services/preview-gateway` → Nâng cấp  
> **Effort**: 4.5 ngày  
> **Sprint**: Sprint 1 (Tuần 1–2)  
> **Ref**: [DEV-01-api-gateway.md](../../develop/DEV-01-api-gateway.md)

---

## Nguyên tắc

> ❌ **KHÔNG thay đổi** bất kỳ route, handler, middleware nào hiện có  
> ✅ **CHỈ thêm** handlers mới cho Open Design routes  
> ✅ Giữ nguyên: Gin framework, JWT middleware, rate limiter, OpenTelemetry

---

## Nhóm A — gRPC Clients Mới (Ngày 1)

---

### A01 — Thêm `agent_client.go`

**File**: `services/preview-gateway/pkg/adapter/gateway/agent_client.go`  
**Effort**: 3h  
**Status**: `[ ]`

**Mô tả**: gRPC client kết nối tới Agent Service.

```go
// pkg/adapter/gateway/agent_client.go
package gateway

import (
    "context"
    agentpb "github.com/open-design/agent-service/api/proto/agent/v1"
    "google.golang.org/grpc"
)

type AgentClient struct {
    conn   *grpc.ClientConn
    client agentpb.AgentServiceClient
}

func NewAgentClient(addr string) (*AgentClient, error) {
    conn, err := grpc.Dial(addr, grpc.WithInsecure(), grpc.WithBlock())
    if err != nil {
        return nil, err
    }
    return &AgentClient{
        conn:   conn,
        client: agentpb.NewAgentServiceClient(conn),
    }, nil
}

func (c *AgentClient) CreateRun(ctx context.Context, req *agentpb.CreateRunRequest) (*agentpb.Run, error) {
    return c.client.CreateRun(ctx, req)
}

func (c *AgentClient) StreamRunEvents(ctx context.Context, req *agentpb.StreamRunEventsRequest) (agentpb.AgentService_StreamRunEventsClient, error) {
    return c.client.StreamRunEvents(ctx, req)
}

func (c *AgentClient) CancelRun(ctx context.Context, req *agentpb.CancelRunRequest) error {
    _, err := c.client.CancelRun(ctx, req)
    return err
}

func (c *AgentClient) SubmitToolResult(ctx context.Context, req *agentpb.SubmitToolResultRequest) error {
    _, err := c.client.SubmitToolResult(ctx, req)
    return err
}

func (c *AgentClient) ListAgents(ctx context.Context) (*agentpb.ListAgentsResponse, error) {
    return c.client.ListAgents(ctx, &agentpb.ListAgentsRequest{})
}
```

**Acceptance Criteria**:
- [ ] File tạo thành công, không có compile errors
- [ ] Connection gracefully handles timeout với `grpc.WithTimeout(5 * time.Second)`
- [ ] `Close()` method để cleanup connection

---

### A02 — Thêm `design_system_client.go`

**File**: `services/preview-gateway/pkg/adapter/gateway/design_system_client.go`  
**Effort**: 2h  
**Status**: `[ ]`

**Methods cần implement**:
```go
func (c *DesignSystemClient) ListODDesignSystems(ctx) ([]*odpb.ODDesignSystem, error)
func (c *DesignSystemClient) GetODDesignSystem(ctx, id string) (*odpb.ODDesignSystem, error)
func (c *DesignSystemClient) GetJobStatus(ctx, jobID string) (*odpb.ODDSJob, error)
```

**Acceptance Criteria**:
- [ ] Compile thành công
- [ ] Timeout handling

---

### A03 — Thêm `skill_client.go`

**File**: `services/preview-gateway/pkg/adapter/gateway/skill_client.go`  
**Effort**: 1.5h  
**Status**: `[ ]`

```go
func (c *SkillClient) ListSkills(ctx) ([]*skillpb.Skill, error)
func (c *SkillClient) GetSkill(ctx, id string) (*skillpb.Skill, error)
```

---

### A04 — Thêm `config_service_client.go`

**File**: `services/preview-gateway/pkg/adapter/gateway/config_service_client.go`  
**Effort**: 1.5h  
**Status**: `[ ]`

```go
func (c *ConfigClient) GetAppConfig(ctx) (*configpb.AppConfig, error)
func (c *ConfigClient) UpdateAppConfig(ctx, req) (*configpb.AppConfig, error)
func (c *ConfigClient) GetMediaConfig(ctx) (*configpb.MediaConfig, error)
func (c *ConfigClient) UpdateMediaConfig(ctx, req) (*configpb.MediaConfig, error)
```

---

## Nhóm B — SSE Proxy (Ngày 2–3, Critical)

---

### B01 — Tạo `agent_sse_proxy.go`

**File**: `services/preview-gateway/pkg/adapter/controller/http/agent_sse_proxy.go`  
**Effort**: 2 ngày  
**Status**: `[ ]`

**Mô tả**: Chuyển đổi gRPC server streaming → HTTP SSE. Đây là task quan trọng nhất — SSE streaming phải hoạt động đúng để frontend nhận events từ agent.

```go
// pkg/adapter/controller/http/agent_sse_proxy.go
package http

import (
    "fmt"
    "io"
    "net/http"
    
    "github.com/gin-gonic/gin"
    agentpb "github.com/open-design/agent-service/api/proto/agent/v1"
    "go.uber.org/zap"
)

type AgentSSEProxy struct {
    agentClient *gateway.AgentClient
    logger      *zap.Logger
}

func NewAgentSSEProxy(client *gateway.AgentClient, logger *zap.Logger) *AgentSSEProxy {
    return &AgentSSEProxy{agentClient: client, logger: logger}
}

// StreamRunEvents: GET /api/runs/:id/events
func (p *AgentSSEProxy) StreamRunEvents(c *gin.Context) {
    runID := c.Param("id")
    lastEventID := c.GetHeader("Last-Event-ID")
    
    // Set SSE headers — critical: buffer phải bị tắt
    c.Header("Content-Type", "text/event-stream")
    c.Header("Cache-Control", "no-cache")
    c.Header("Connection", "keep-alive")
    c.Header("X-Accel-Buffering", "no")    // Tắt nginx buffer
    
    // Open gRPC stream
    stream, err := p.agentClient.StreamRunEvents(c.Request.Context(), &agentpb.StreamRunEventsRequest{
        RunId:       runID,
        LastEventId: lastEventID,
    })
    if err != nil {
        p.logger.Error("failed to open agent stream", zap.Error(err))
        c.Status(http.StatusBadGateway)
        return
    }
    
    // Stream events về client
    flusher, ok := c.Writer.(http.Flusher)
    if !ok {
        c.Status(http.StatusInternalServerError)
        return
    }
    
    c.Status(http.StatusOK)
    
    for {
        event, err := stream.Recv()
        if err == io.EOF {
            // Agent run completed
            fmt.Fprintf(c.Writer, "event: end\ndata: {}\n\n")
            flusher.Flush()
            return
        }
        if err != nil {
            // Check if client disconnected
            select {
            case <-c.Request.Context().Done():
                return
            default:
                p.logger.Error("stream recv error", zap.Error(err))
                fmt.Fprintf(c.Writer, "event: error\ndata: {\"message\": \"stream error\"}\n\n")
                flusher.Flush()
                return
            }
        }
        
        // Write SSE frame — format phải giống daemon
        if event.Id != "" {
            fmt.Fprintf(c.Writer, "id: %s\n", event.Id)
        }
        fmt.Fprintf(c.Writer, "event: %s\n", event.EventType)
        fmt.Fprintf(c.Writer, "data: %s\n\n", event.Data)
        flusher.Flush()
    }
}
```

**Acceptance Criteria**:
- [ ] SSE frame format: `id: {id}\nevent: {type}\ndata: {json}\n\n` — **phải đúng**
- [ ] `X-Accel-Buffering: no` header được set (tránh nginx buffer SSE)
- [ ] Client disconnect (context cancel) được handle gracefully
- [ ] `Last-Event-ID` được forward qua gRPC request
- [ ] `io.EOF` gửi `event: end\ndata: {}\n\n` trước khi đóng

**Test bắt buộc**:
```go
// agent_sse_proxy_test.go
func TestStreamRunEvents_SSEFormat(t *testing.T)     // verify SSE frame format
func TestStreamRunEvents_LastEventID(t *testing.T)   // verify header forwarding
func TestStreamRunEvents_ClientDisconnect(t *testing.T) // context cancel
func TestStreamRunEvents_GRPCError(t *testing.T)    // handle gRPC errors
```

---

### B02 — Tạo `run_proxy_handler.go`

**File**: `services/preview-gateway/pkg/adapter/controller/http/run_proxy_handler.go`  
**Effort**: 4h  
**Status**: `[ ]`

**Handlers cần implement**:

```go
type RunProxyHandler struct {
    agentClient *gateway.AgentClient
    logger      *zap.Logger
}

// POST /api/runs
func (h *RunProxyHandler) CreateRun(c *gin.Context)

// POST /api/runs/:id/cancel
func (h *RunProxyHandler) CancelRun(c *gin.Context)

// POST /api/runs/:id/tool-result
func (h *RunProxyHandler) SubmitToolResult(c *gin.Context)

// GET /api/runs/:id
func (h *RunProxyHandler) GetRun(c *gin.Context)

// GET /api/runs
func (h *RunProxyHandler) ListRuns(c *gin.Context)

// GET /api/agents
func (h *RunProxyHandler) ListAgents(c *gin.Context)
```

**Acceptance Criteria**:
- [ ] `POST /api/runs` bind JSON body → gRPC request → return `{"runId": "..."}`
- [ ] `POST /api/runs/:id/cancel` → gRPC CancelRun → 200 OK
- [ ] `POST /api/runs/:id/tool-result` bind `{toolUseId, content}` → gRPC SubmitToolResult
- [ ] Error handling: gRPC NotFound → 404, Internal → 500

---

## Nhóm C — OD Routes trong `router.go` (Ngày 4)

---

### C01 — Thêm OD routes vào `router.go`

**File**: `services/preview-gateway/pkg/adapter/controller/http/router.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

**Mô tả**: Thêm routes mới vào cuối `SetupRouter()` function, **SAU** tất cả routes hiện có.

```go
// Thêm vào sau MCP routes (~line 115):

// === Open Design Routes ===
odGroup := router.Group("/api")
{
    // Agent/Run routes
    odGroup.POST("/runs", odMiddleware.WithLocalAuth(), runHandler.CreateRun)
    odGroup.GET("/runs", odMiddleware.WithLocalAuth(), runHandler.ListRuns)
    odGroup.GET("/runs/:id", odMiddleware.WithLocalAuth(), runHandler.GetRun)
    odGroup.POST("/runs/:id/cancel", odMiddleware.WithLocalAuth(), runHandler.CancelRun)
    odGroup.POST("/runs/:id/tool-result", odMiddleware.WithLocalAuth(), runHandler.SubmitToolResult)
    
    // SSE streaming — separate handler
    odGroup.GET("/runs/:id/events", sseProxy.StreamRunEvents)  // no auth middleware (SSE streams)
    
    // Agents
    odGroup.GET("/agents", odMiddleware.WithLocalAuth(), runHandler.ListAgents)
    
    // Skills
    odGroup.GET("/skills", skillHandler.ListSkills)
    odGroup.GET("/skills/:id", skillHandler.GetSkill)
    
    // Config
    odGroup.GET("/app-config", odMiddleware.WithLocalAuth(), configHandler.GetAppConfig)
    odGroup.PUT("/app-config", odMiddleware.WithLocalAuth(), configHandler.UpdateAppConfig)
    odGroup.GET("/media/config", odMiddleware.WithLocalAuth(), configHandler.GetMediaConfig)
    odGroup.PUT("/media/config", odMiddleware.WithLocalAuth(), configHandler.UpdateMediaConfig)
    odGroup.GET("/health", healthHandler.Check)  // public
    
    // Design Systems (OD catalog)
    odGroup.GET("/design-systems", dsHandler.ListODDesignSystems)
    odGroup.GET("/design-systems/:id", dsHandler.GetODDesignSystem)
}

// Artifact + Frame serving — separate from /api/ group
router.GET("/artifacts/*path", projectHandler.ServeArtifact)
router.GET("/frames/*path", projectHandler.ServeFrame)
```

**Acceptance Criteria**:
- [ ] Tất cả routes hiện có vẫn hoạt động (smoke test)
- [ ] Routes mới không conflict với routes cũ
- [ ] Rate limiting áp dụng cho routes mới
- [ ] OpenTelemetry trace cho mỗi request

---

### C02 — Thêm Local Access Middleware

**File**: `services/preview-gateway/pkg/adapter/middleware/local_auth.go`  
**Effort**: 2h  
**Status**: `[ ]`

**Mô tả**: Allow requests từ `127.0.0.1` / `::1` mà không cần JWT — cho CLI tool `od` và Electron app.

```go
// middleware/local_auth.go
func WithLocalAuth() gin.HandlerFunc {
    return func(c *gin.Context) {
        ip := c.ClientIP()
        // Allow local access without JWT
        if ip == "127.0.0.1" || ip == "::1" || strings.HasPrefix(ip, "192.168.") {
            c.Next()
            return
        }
        // Non-local: require JWT (delegate to existing auth middleware)
        authMiddleware.JWT()(c)
    }
}
```

---

### C03 — Cập nhật `config.yaml`

**File**: `services/preview-gateway/configs/config.yaml`  
**Effort**: 0.5h  
**Status**: `[ ]`

```yaml
# Thêm vào section upstreams:
upstreams:
  # ... existing upstreams ...
  agent_service:     "${AGENT_SERVICE_ADDR:=localhost:8082}"
  design_system_svc: "${DESIGN_SYSTEM_SERVICE_ADDR:=localhost:8083}"
  skill_service:     "${SKILL_SERVICE_ADDR:=localhost:8088}"
  config_service:    "${CONFIG_SERVICE_ADDR:=localhost:8089}"
  project_service:   "${PROJECT_SERVICE_ADDR:=localhost:8081}"
```

---

## Nhóm D — Tests & Validation (Ngày 4–4.5)

---

### D01 — Unit Tests

**Files**: `*_test.go`  
**Effort**: 1 ngày  
**Status**: `[ ]`

**Test files cần tạo**:
- [ ] `agent_sse_proxy_test.go` — 4 test cases (xem B01)
- [ ] `run_proxy_handler_test.go` — mock AgentClient, test each handler
- [ ] `local_auth_test.go` — local IP pass, non-local fail

---

### D02 — Integration Test (Smoke)

**Effort**: 0.5 ngày  
**Status**: `[ ]`

```bash
# Chạy integration test:
docker compose -f deploy/dev/docker-compose.yaml up gateway agent-service -d

# Test routes
curl -X POST http://localhost:7456/api/runs \
  -H "Content-Type: application/json" \
  -d '{"agentId":"claude-code","projectId":"test"}'

curl -N http://localhost:7456/api/runs/{id}/events

curl http://localhost:7456/api/agents
curl http://localhost:7456/api/skills
curl http://localhost:7456/api/app-config
curl http://localhost:7456/api/health
```

**Acceptance Criteria**:
- [ ] `POST /api/runs` → 200 với `runId`
- [ ] `GET /api/runs/:id/events` → SSE stream không bị buffer
- [ ] `GET /api/agents` → JSON array
- [ ] `GET /api/health` → `{"status": "ok"}`
- [ ] Tất cả VNPay routes hiện có vẫn trả về đúng

---

## Acceptance Criteria Tổng thể (DEV-01)

- [ ] `GET /api/runs/:id/events` — SSE stream từ Agent Service
- [ ] `POST /api/runs` — tạo run, trả về ID
- [ ] `GET /artifacts/{projectId}/{path}` — serve file từ Project Service
- [ ] `GET /api/skills` — skill list
- [ ] `GET /api/app-config` — config từ Config Service
- [ ] Tất cả VNPay routes hiện có **không bị ảnh hưởng**
- [ ] Rate limiting hoạt động với routes mới
- [ ] OpenTelemetry traces cho routes mới
- [ ] `go build ./...` — thành công
- [ ] `go test ./... -race` — pass
