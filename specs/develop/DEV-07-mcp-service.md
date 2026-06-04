# DEV-07 — MCP Service: Nâng cấp `apps/preview-mcp`

> **Chiến lược**: ✅ **Nâng cấp** — Tách `apps/preview-mcp` thành `services/mcp-service` (microservice đầy đủ)  
> **Nguồn**: `apps/preview-mcp/`  
> **Spec tham chiếu**: `specs/services/07-mcp-service.md`

---

## 1. Phân tích Codebase Hiện có (`apps/preview-mcp`)

### 1.1 Cấu trúc Hiện tại

```
apps/preview-mcp/
├── main.go                      ← Entry point, transport switch (stdio | http)
├── server/
│   ├── config.go                ← Config loading (PREVIEW_API_URL, REDIS_URL, etc.)
│   ├── server.go                ← MCP server setup với mark3labs/mcp-go
│   ├── middleware.go            ← Auth middleware (11KB) — MCP key validation
│   ├── rate_limiter.go          ← Rate limiting (4KB)
│   ├── jwt.go                   ← JWT validation
│   ├── db.go                    ← DB connection (cho KGS key resolver)
│   ├── logger.go                ← Zap logger
│   └── metrics.go               ← Prometheus metrics
├── tools/
│   ├── register.go              ← Tool registration
│   ├── project.go               ← project_* tools (4KB)
│   ├── document.go              ← document_* tools (6KB)
│   ├── schema.go                ← schema_* tools (6KB)
│   ├── graph.go                 ← graph_* tools (27KB) — knowledge graph tools
│   ├── simulation.go            ← simulation_* tools (15KB)
│   ├── local_document.go        ← local_document_ingest tool (17KB)
│   └── registry.go              ← prompt registry tools (3KB)
├── client/
│   ├── preview_client.go        ← HTTP client → preview-service REST
│   ├── registry_client.go       ← HTTP client → prompt-registry-service
│   ├── kgs_client.go            ← HTTP client → KGS Platform
│   └── kgs_key_resolver.go      ← DB query cho KGS keys
├── notifications/
│   └── redis_bridge.go          ← Redis Pub/Sub → MCP notifications
└── resources/
    └── ...                      ← MCP resources
```

### 1.2 Điểm Mạnh Cần Giữ

| Thành phần | Giá trị | Hành động |
|-----------|---------|---------|
| `server/middleware.go` | MCP key auth hoàn chỉnh (rate limit, usage tracking) | ✅ Giữ + tích hợp với Identity Service |
| `tools/graph.go` (27KB) | 20+ knowledge graph tools | ✅ Giữ nguyên |
| `tools/simulation.go` (15KB) | Simulation tools | ✅ Giữ nguyên |
| `tools/local_document.go` (17KB) | Document ingestion | ✅ Giữ nguyên |
| `notifications/redis_bridge.go` | Redis notification bridge | ✅ Giữ nguyên |
| mark3labs/mcp-go library | MCP protocol implementation | ✅ Giữ |

---

## 2. Những gì cần THÊM cho Open Design MCP

### 2.1 Tạo Tool Group Mới: `tools/open_design.go`

```go
// tools/open_design.go — THÊM MỚI
// Open Design specific MCP tools

// get_active_context: Get active project/conversation/file context
func RegisterGetActiveContextTool(s *server.MCPServer, projectClient *grpc.ProjectClient) {
    s.AddTool(mcp.NewTool("get_active_context",
        mcp.WithDescription("Get the currently active project, conversation, and file context in Open Design"),
    ), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
        // gRPC call → MCP Service (Active Context store)
        // hoặc gọi trực tiếp vào in-memory state
    })
}

// create_project: Create a new design project
func RegisterCreateProjectTool(s *server.MCPServer, projectClient *grpc.ProjectClient) {
    s.AddTool(mcp.NewTool("create_project",
        mcp.WithDescription("Create a new design project in Open Design workspace"),
        mcp.WithString("name", mcp.Required(), mcp.Description("Project name")),
        mcp.WithString("kind", mcp.Description("Project kind: web-ui | image | video | audio")),
    ), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
        // gRPC → Project Service
    })
}

// run_design_skill: Execute a design skill
// get_live_artifact: Get live artifact
// list_projects: List projects
// get_project_files: Get file tree
// read_file: Read file content
// list_design_systems: List available DS
// get_design_system_context: Get DS context
// list_skills: List skills
```

### 2.2 Thêm gRPC Clients trong `client/`

```
client/
├── preview_client.go          ← ✅ Giữ
├── registry_client.go         ← ✅ Giữ
├── kgs_client.go              ← ✅ Giữ
├── kgs_key_resolver.go        ← ✅ Giữ
├── project_grpc_client.go     ← 🆕 THÊM: gRPC → Project Service
├── agent_grpc_client.go       ← 🆕 THÊM: gRPC → Agent Service
├── skill_grpc_client.go       ← 🆕 THÊM: gRPC → Skill Service
└── design_system_grpc_client.go ← 🆕 THÊM: gRPC → Design System Service
```

### 2.3 Active Context Store

```go
// server/active_context.go — THÊM MỚI
// In-memory active context (project/conversation/file đang active)

type ActiveContextStore struct {
    mu             sync.RWMutex
    ProjectID      string
    ConversationID string
    FilePath       string
    UpdatedAt      time.Time
}

var globalActiveContext = &ActiveContextStore{}

func (s *ActiveContextStore) Set(projectID, conversationID, filePath string) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.ProjectID      = projectID
    s.ConversationID = conversationID
    s.FilePath       = filePath
    s.UpdatedAt      = time.Now()
}

func (s *ActiveContextStore) Get() (string, string, string, time.Time) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return s.ProjectID, s.ConversationID, s.FilePath, s.UpdatedAt
}
```

---

## 3. Di chuyển từ `apps/` sang `services/`

```
apps/preview-mcp/         ← Hiện tại
     ↓
services/mcp-service/     ← Sau khi migrate
```

### 3.1 Cập nhật Module Path

```go
// go.mod — cập nhật module name
module github.com/binhnt/ba-agent-preview/services/mcp-service

// Thay thế import paths
// Cũ: github.com/binhnt/ba-agent-preview/apps/preview-mcp/...
// Mới: github.com/binhnt/ba-agent-preview/services/mcp-service/...
```

### 3.2 Cấu trúc Mới

```
services/mcp-service/
├── cmd/
│   └── main.go              ← refactor từ apps/preview-mcp/main.go
├── server/                  ← GIỮ NGUYÊN (config, middleware, jwt, metrics, ...)
├── tools/
│   ├── register.go          ← GIỮ + thêm Open Design tools
│   ├── project.go           ← GIỮ (VNPay project tools)
│   ├── document.go          ← GIỮ
│   ├── schema.go            ← GIỮ
│   ├── graph.go             ← GIỮ
│   ├── simulation.go        ← GIỮ
│   ├── local_document.go    ← GIỮ
│   ├── registry.go          ← GIỮ
│   └── open_design.go       ← 🆕 THÊM MỚI (10+ OD tools)
├── client/
│   ├── preview_client.go    ← GIỮ
│   ├── registry_client.go   ← GIỮ
│   ├── kgs_client.go        ← GIỮ
│   ├── kgs_key_resolver.go  ← GIỮ
│   └── *_grpc_client.go     ← 🆕 THÊM (4 gRPC clients)
├── notifications/           ← GIỮ
├── resources/               ← GIỮ
└── go.mod                   ← UPDATE module path
```

---

## 4. Identity Service Integration

Hiện tại MCP auth middleware validate MCP keys bằng cách query database trực tiếp. Cần integrate với Identity Service:

```go
// server/middleware.go — THAY ĐỔI
// Cũ: query MCPAPIKey từ DB trực tiếp
// Mới: gRPC call → preview-identity để validate MCP key

type MCPAuthMiddleware struct {
    identityClient *IdentityGRPCClient  // thêm mới
    db             *pgxpool.Pool        // giữ fallback
    rateLimiter    *RateLimiter
    metrics        *MCPMetrics
}
```

---

## 5. Thêm Open Design MCP Tools

```go
// tools/register.go — thêm vào RegisterAll()
func RegisterAll(s *server.MCPServer, deps Dependencies) {
    // Existing VNPay tools (giữ nguyên)
    RegisterProjectTools(s, deps.PreviewClient)
    RegisterDocumentTools(s, deps.PreviewClient)
    RegisterSchemaTools(s, deps.PreviewClient)
    RegisterGraphTools(s, deps.PreviewClient, deps.KGSClient)
    RegisterSimulationTools(s, deps.PreviewClient)
    RegisterLocalDocumentTool(s, deps.KGSClient, deps.KGSKeyResolver)
    RegisterRegistryTools(s, deps.RegistryClient)

    // THÊM MỚI: Open Design tools
    if deps.ProjectGRPCClient != nil {
        RegisterOpenDesignTools(s, deps.ProjectGRPCClient, deps.AgentGRPCClient,
            deps.SkillGRPCClient, deps.DesignSystemGRPCClient)
    }
}
```

Open Design tools cần triển khai:

| Tool | Mô tả | gRPC Upstream |
|------|-------|--------------|
| `get_active_context` | Context hiện tại | In-memory store |
| `create_project` | Tạo project mới | Project Service |
| `list_projects` | Danh sách projects | Project Service |
| `get_project_files` | File tree | Project Service |
| `read_file` | Đọc file content | Project Service |
| `run_design_skill` | Chạy skill | Agent Service |
| `get_live_artifact` | Lấy artifact | Project Service |
| `list_design_systems` | Danh sách DS | Design System Service |
| `get_design_system_context` | DS tokens + guidelines | Design System Service |
| `list_skills` | Danh sách skills | Skill Service |

---

## 6. Config Bổ sung

```go
// server/config.go — thêm fields
type Config struct {
    // Existing fields
    PreviewAPIURL   string
    RegistryURL     string
    RedisURL        string
    KGSPlatformURL  string
    JWTSecret       string
    // THÊM MỚI — Open Design gRPC upstreams
    ProjectServiceAddr      string // PROJECT_SERVICE_ADDR
    AgentServiceAddr        string // AGENT_SERVICE_ADDR
    SkillServiceAddr        string // SKILL_SERVICE_ADDR
    DesignSystemServiceAddr string // DESIGN_SYSTEM_SERVICE_ADDR
}
```

---

## 7. Acceptance Criteria

- [x] Tất cả VNPay MCP tools hiện tại vẫn hoạt động sau di chuyển
- [x] `get_active_context` trả về project/conversation đang active
- [x] `create_project` tạo project thành công qua gRPC
- [x] `list_projects` trả về danh sách projects
- [x] `read_file` trả về nội dung file từ project workspace
- [x] `run_design_skill` trigger agent run
- [x] `list_design_systems` trả về 150+ built-in DS
- [x] MCP token auth vẫn hoạt động
- [x] Redis notification bridge vẫn hoạt động

---

## 8. Effort Estimate

| Task | Estimate |
|------|---------|
| Di chuyển `apps/` → `services/` + update imports | 1 ngày |
| Thêm 4 gRPC clients | 1 ngày |
| Implement `tools/open_design.go` (10 tools) | 3 ngày |
| Active context store | 0.5 ngày |
| Identity Service integration (auth) | 1 ngày |
| Config update + Docker | 0.5 ngày |
| Tests | 2 ngày |
| **Tổng** | **9 ngày** |
