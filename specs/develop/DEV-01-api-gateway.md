# DEV-01 — API Gateway: Nâng cấp `preview-gateway`

> **Chiến lược**: ✅ **Nâng cấp** codebase hiện có  
> **Nguồn**: `services/preview-gateway/`  
> **Spec tham chiếu**: `specs/services/01-api-gateway.md`

---

## 1. Phân tích Codebase Hiện có

### 1.1 Những gì đã có (GIỮ NGUYÊN)

| File/Module | Trạng thái | Ghi chú |
|-------------|-----------|---------|
| `pkg/adapter/controller/http/router.go` | ✅ Giữ | 22 proxy handlers, đầy đủ routes hiện tại |
| `pkg/adapter/controller/http/sse_bridge.go` | ✅ Giữ | SSE streaming cho inference |
| `pkg/adapter/controller/http/auth_handler.go` | ✅ Giữ | JWT auth middleware |
| `pkg/adapter/middleware/` | ✅ Giữ | Rate limiting, CORS, tracing |
| `pkg/adapter/gateway/` | ✅ Giữ | gRPC clients (component, inference, model) |
| OpenTelemetry setup | ✅ Giữ | Tracing với OTLP |
| Gin + gRPC stack | ✅ Giữ | Không thay đổi framework |
| NATS integration | ✅ Giữ | Event bus đã có |
| WebSocket handler | ✅ Giữ | `ws_handler.go` |

### 1.2 Những gì cần THÊM MỚI

| Tính năng | Tại sao cần | File mới |
|-----------|------------|---------|
| Routes cho Open Design daemon | Frontend gọi `/api/runs/*`, `/api/projects/*` v.v. | `run_proxy_handler.go` |
| SSE proxy cho Agent Service | `/api/runs/:id/events` → gRPC stream | `agent_sse_proxy.go` |
| Routes cho `/artifacts/*`, `/frames/*` | File serving từ Project Service | trong `router.go` |
| gRPC client → Agent Service | Routing agent requests | `agent_client.go` |
| gRPC client → Design System Service | Routing DS requests | `design_system_client.go` |
| gRPC client → Skill Service | Routing skill requests | `skill_client.go` |
| gRPC client → Config Service | Routing config requests | `config_service_client.go` |
| gRPC client → Memory Service | (internal use) | `memory_client.go` |

---

## 2. Yêu cầu Phát triển Chi tiết

### 2.1 New Routes cần thêm vào `router.go`

```
# Thêm vào sau MCP routes (dòng 115):

# Open Design — Agent/Run routes
POST   /api/runs                     → agentProxyHandler.CreateRun
GET    /api/runs/:id/events          → agentSSEProxy.StreamEvents [SSE]
POST   /api/runs/:id/cancel          → agentProxyHandler.CancelRun
POST   /api/runs/:id/tool-result     → agentProxyHandler.SubmitToolResult

# Open Design — Artifact/Frame serving
GET    /artifacts/*path              → projectProxyHandler.ServeArtifact
GET    /frames/*path                 → projectProxyHandler.ServeFrame

# Open Design — Design Systems
GET    /api/design-systems           → đã có route → designProxyHandler (mới)
POST   /api/design-systems           → designProxyHandler.Create

# Open Design — Skills
GET    /api/skills                   → skillProxyHandler.List
GET    /api/skills/:id               → skillProxyHandler.Get

# Open Design — App Config
GET    /api/app-config               → configProxyHandler.GetAppConfig
PUT    /api/app-config               → configProxyHandler.UpdateAppConfig
GET    /api/media/config             → configProxyHandler.GetMediaConfig
PUT    /api/media/config             → configProxyHandler.UpdateMediaConfig

# Open Design — Active context
POST   /api/active                   → đã có mcpProxyHandler
```

### 2.2 `agent_sse_proxy.go` — Mới (Critical)

```go
// SSE Proxy: chuyển gRPC server streaming → HTTP SSE
// Tương tự sse_bridge.go nhưng forward từ Agent Service gRPC
type AgentSSEProxy struct {
    agentClient agentpb.AgentServiceClient
    logger      *zap.Logger
}

func (p *AgentSSEProxy) StreamRunEvents(c *gin.Context) {
    runID := c.Param("id")
    lastEventID := c.GetHeader("Last-Event-ID")

    // Set SSE headers (dùng lại pattern từ sse_bridge.go)
    c.Header("Content-Type", "text/event-stream")
    c.Header("Cache-Control", "no-cache")
    c.Header("X-Accel-Buffering", "no")

    stream, err := p.agentClient.StreamRunEvents(c.Request.Context(), &agentpb.StreamRunEventsRequest{
        RunId:       runID,
        LastEventId: lastEventID,
    })
    // ... stream về client
}
```

### 2.3 Bổ sung gRPC Clients

Hiện tại gateway đã có `component_client.go`, `inference_client.go`, `model_client.go`. Cần thêm:

```
pkg/adapter/gateway/
├── component_client.go     ← hiện có
├── inference_client.go     ← hiện có  
├── model_client.go         ← hiện có
├── agent_client.go         ← THÊM MỚI
├── design_system_client.go ← THÊM MỚI
├── skill_client.go         ← THÊM MỚI
└── config_client.go        ← THÊM MỚI
```

### 2.4 Middleware Bổ sung

Hiện tại đã có `rate_limiter.go`, JWT middleware. Cần bổ sung:
- **Local-access bypass**: Cho phép `127.0.0.1` access không cần JWT (cho CLI tool `od`)
- **MCP token validation**: Gọi MCP Service để validate thay vì check local

---

## 3. Thay đổi Cấu hình

### 3.1 Thêm vào `configs/config.yaml`

```yaml
# Thêm upstream addresses cho Open Design services
upstreams:
  # Existing
  openui_inference:  "${INFERENCE_SERVICE_ADDR:=localhost:9001}"
  openui_component:  "${COMPONENT_SERVICE_ADDR:=localhost:9002}"
  openui_model:      "${MODEL_SERVICE_ADDR:=localhost:9003}"
  # New Open Design services
  agent_service:     "${AGENT_SERVICE_ADDR:=localhost:8082}"
  design_system:     "${DESIGN_SYSTEM_SERVICE_ADDR:=localhost:8083}"
  skill_service:     "${SKILL_SERVICE_ADDR:=localhost:8088}"
  config_service:    "${CONFIG_SERVICE_ADDR:=localhost:8089}"
```

---

## 4. Không Thay đổi

- ❌ Không thay đổi bất kỳ route nào hiện có
- ❌ Không thay đổi auth middleware
- ❌ Không thay đổi proxy handlers hiện tại (project, kg, identity, figma, ...)
- ❌ Không đổi framework (giữ Gin)

---

## 5. Acceptance Criteria

- [x] `GET /api/runs/:id/events` trả về SSE stream từ Agent Service
- [x] `POST /api/runs` tạo run và trả về ID
- [x] `GET /artifacts/{projectId}/{path}` serve file từ Project Service
- [x] `GET /api/skills` trả về danh sách skills
- [x] `GET /api/app-config` trả về config từ Config Service
- [x] Tất cả routes hiện có vẫn hoạt động bình thường
- [x] Rate limiting áp dụng cho tất cả routes mới
- [x] Traces xuất hiện trong OpenTelemetry cho routes mới

---

## 6. Effort Estimate

| Task | Estimate |
|------|---------|
| Thêm gRPC clients (4 clients) | 1 ngày |
| `agent_sse_proxy.go` | 2 ngày |
| Thêm routes vào router.go | 0.5 ngày |
| Config + tests | 1 ngày |
| **Tổng** | **4.5 ngày** |
