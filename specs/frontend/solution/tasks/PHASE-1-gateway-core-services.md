# PHASE 1 — API Gateway + Core Services

> **Tuần**: 4–11  
> **Phạm vi**: Go codebase + Docker Compose  
> **Mục tiêu**: Deploy Go API Gateway, Agent Service, Project Service theo Strangler Fig pattern  
> **Ref**: [02-strangler-fig-migration.md](../02-strangler-fig-migration.md), [specs/services/01-api-gateway.md](../../services/01-api-gateway.md)

---

## Tuần 4–5 — Go API Gateway

---

### T01 — Setup Go Workspace & Gateway Project

**File**: `services/gateway/`  
**Effort**: 4h  
**Assignee**: Go Dev  
**Depends on**: Phase 0 complete  
**Status**: `[ ]`

**Mô tả**: Khởi tạo Go module, setup project structure theo Clean Architecture.

**Checklist**:
- [ ] Tạo thư mục `services/gateway/`
- [ ] `go mod init github.com/open-design/gateway`
- [ ] Cài dependencies: `echo/v4`, `google.golang.org/grpc`, `viper`, `zap`
- [ ] Tạo cấu trúc thư mục:
  ```
  gateway/
  ├── cmd/main.go
  ├── internal/
  │   ├── config/
  │   ├── middleware/
  │   ├── router/
  │   ├── proxy/
  │   └── upstream/
  ├── Dockerfile
  └── go.sum
  ```
- [ ] `Makefile` với targets: `build`, `run`, `test`, `docker-build`

---

### T02 — Gateway Config & Viper Setup

**File**: `services/gateway/internal/config/config.go`  
**Effort**: 3h  
**Assignee**: Go Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Config fields cần thiết**:
```yaml
# config.yaml
server:
  port: 7456
  host: "127.0.0.1"

daemon:
  url: "http://127.0.0.1:7457"   # Strangler Fig fallback

upstreams:
  agent_service:   "localhost:8082"
  project_service: "localhost:8081"
  # ... (all services — nil until Phase 2)

feature_flags:
  use_go_agent_service:   false
  use_go_project_service: false

auth:
  jwt_secret: ""
  skip_auth_for_local: true

rate_limit:
  enabled: true
  redis_url: "redis://localhost:6379"

cors:
  allowed_origins:
    - "http://localhost:3000"
    - "http://127.0.0.1:3000"

tracing:
  enabled: false
  endpoint: "http://localhost:4317"
```

**Acceptance Criteria**:
- [ ] Config load từ file + env vars (12-factor)
- [ ] `OD_GATEWAY_PORT`, `OD_DAEMON_URL`, `FF_GO_AGENT_SERVICE` env vars hoạt động
- [ ] Validate required fields với thông báo rõ ràng

---

### T03 — Daemon Proxy (Strangler Fig Fallback)

**File**: `services/gateway/internal/proxy/daemon_proxy.go`  
**Effort**: 6h  
**Assignee**: Go Dev  
**Depends on**: T02  
**Status**: `[ ]`

**Mô tả**: HTTP reverse proxy về daemon TypeScript — tất cả requests ban đầu fallback vào đây.

**Checklist**:
- [ ] `DaemonProxy` dùng `net/http/httputil.ReverseProxy`
- [ ] `ToDaemon(c echo.Context) error` — proxy tất cả methods
- [ ] `ToSSEDaemon(c echo.Context) error` — proxy với SSE headers (`X-Accel-Buffering: no`, `Cache-Control: no-cache`)
- [ ] Preserve request headers (`X-OD-Client`, `Authorization`, `Last-Event-ID`)
- [ ] Log lỗi khi daemon unreachable

**Test**:
- [ ] Unit test: verify headers được forward đúng
- [ ] Integration test: proxy request → daemon mock → response pass-through

---

### T04 — Auth Middleware

**File**: `services/gateway/internal/middleware/auth.go`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: T02  
**Status**: `[ ]`

**Logic** (theo `specs/services/01-api-gateway.md` section 4):

```
Request → auth.go
  ├── Path /mcp/* → Validate Bearer MCP token
  ├── Header X-Desktop-Auth → Validate desktop session
  ├── No auth header + local IP (127.x, 192.168.x) → allow (local mode)
  └── Bearer JWT → validate với JWT secret
```

**Checklist**:
- [ ] `JWTMiddleware` validate JWT token (HS256 hoặc RS256)
- [ ] `LocalTrustMiddleware` — skip auth cho localhost/LAN (mode `skip_auth_for_local`)
- [ ] `MCPTokenMiddleware` — validate MCP bearer tokens
- [ ] Propagate `userID` và `scope` vào `echo.Context`
- [ ] Return `401 Unauthorized` với JSON body `{"error": "unauthorized"}`

**Test**:
- [ ] Valid JWT → passes
- [ ] Expired JWT → 401
- [ ] Local IP without token → passes (khi skip_auth_for_local=true)
- [ ] Invalid token → 401

---

### T05 — CORS & Rate Limit Middleware

**File**: `services/gateway/internal/middleware/cors.go`, `rate_limit.go`  
**Effort**: 4h  
**Assignee**: Go Dev  
**Depends on**: T02  
**Status**: `[ ]`

**CORS**:
- [ ] Dùng `echo/middleware.CORSWithConfig`
- [ ] `AllowOrigins` từ config
- [ ] `AllowCredentials: true` cho cross-origin SSE
- [ ] Pre-flight `OPTIONS` response

**Rate Limit**:
- [ ] Redis sliding window (dùng `go-redis`)
- [ ] Per-IP: 1000 req/min (anonymous)
- [ ] Per-MCP-token: 200 req/min
- [ ] SSE connections per-IP: 10 concurrent
- [ ] Graceful degradation khi Redis unavailable (log + allow)

---

### T06 — Router Setup + Phase 1 Feature Flags

**File**: `services/gateway/internal/router/router.go`  
**Effort**: 6h  
**Assignee**: Go Dev  
**Depends on**: T03, T04, T05  
**Status**: `[ ]`

**Mô tả**: Echo router với feature-flag-driven routing. Ban đầu tất cả routes fallback sang daemon.

```go
func (r *Router) Setup(e *echo.Echo) {
    // Middleware
    e.Use(middleware.CORS(...))
    e.Use(middleware.Auth(...))

    // Health (luôn từ gateway)
    e.GET("/api/health", r.health)
    e.GET("/metrics", r.metrics)

    // Feature-flag driven routes
    if r.flags.UseGoAgentService {
        // T14: Agent Service routes
    }
    if r.flags.UseGoProjectService {
        // T21: Project Service routes
    }

    // Fallback: Daemon proxy (ALL routes)
    e.Any("/*", r.daemon.ToDaemon)
}
```

**Acceptance Criteria — T06 Gateway MVP**:
- [ ] Gateway start, port 7456
- [ ] `GET /api/health` → `{"status":"ok"}`
- [ ] Tất cả `/api/*` requests proxy sang daemon (port 7457)
- [ ] SSE `/api/runs/:id/events` proxy với streaming
- [ ] `/artifacts/*` và `/frames/*` proxy sang daemon
- [ ] `docker-compose up gateway daemon` hoạt động

**Validate**:
```bash
# Đổi daemon port sang 7457
OD_PORT=7457 pnpm --filter @open-design/daemon dev

# Start gateway
cd services/gateway && go run cmd/main.go

# Test: frontend vẫn hoạt động qua gateway
pnpm --filter @open-design/ui dev
# → Mọi request đi qua gateway → daemon → response
```

---

## Tuần 6–8 — Agent Service

---

### T07 — Setup Agent Service Project

**File**: `services/agent-service/`  
**Effort**: 3h  
**Assignee**: Go Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Checklist**:
- [ ] `go mod init github.com/open-design/agent-service`
- [ ] Dependencies: `grpc`, `gorm`, `sqlite`, `redis`, `zap`, `viper`
- [ ] Project structure (theo `specs/services/12-clean-architecture.md`):
  ```
  agent-service/
  ├── cmd/main.go
  ├── internal/
  │   ├── config/
  │   ├── domain/
  │   ├── usecase/
  │   ├── infra/
  │   │   ├── db/
  │   │   └── cli/
  │   └── delivery/
  │       ├── grpc/
  │       └── http/    ← health
  ├── proto/agent/v1/
  └── Dockerfile
  ```
- [ ] Shared proto workspace setup (nếu dùng buf.build)

---

### T08 — Agent Domain Layer

**File**: `services/agent-service/internal/domain/`  
**Effort**: 6h  
**Assignee**: Go Dev  
**Depends on**: T07  
**Status**: `[ ]`

**Entities cần tạo**:
```go
// domain/run.go
type Run struct {
    ID             string
    ProjectID      string
    ConversationID string
    AgentID        string
    Status         RunStatus
    ExitCode       *int
    Signal         *string
    CreatedAt      time.Time
    UpdatedAt      time.Time
}

type RunStatus string
const (
    RunStatusQueued    RunStatus = "queued"
    RunStatusRunning   RunStatus = "running"
    RunStatusSucceeded RunStatus = "succeeded"
    RunStatusFailed    RunStatus = "failed"
    RunStatusCanceled  RunStatus = "canceled"
)

// domain/run_event.go
type RunEvent struct {
    ID        string
    RunID     string
    EventType string   // "stdout", "agent", "start", "end", "error"
    Data      string   // JSON
    CreatedAt time.Time
}

// domain/repository.go
type RunRepository interface {
    Create(ctx, *Run) error
    GetByID(ctx, id string) (*Run, error)
    UpdateStatus(ctx, id string, status RunStatus, exitCode *int, signal *string) error
    List(ctx, filter RunFilter) ([]*Run, error)
    AppendEvent(ctx, event *RunEvent) error
    ListEvents(ctx, runID string, afterEventID string) ([]*RunEvent, error)
}
```

**Acceptance Criteria**:
- [ ] Domain entities không import external packages
- [ ] `RunRepository` interface đầy đủ
- [ ] Domain errors: `ErrRunNotFound`, `ErrRunAlreadyFinished`

---

### T09 — Agent Protobuf Definitions

**File**: `services/agent-service/proto/agent/v1/agent.proto`  
**Effort**: 4h  
**Assignee**: Go Dev  
**Depends on**: T08  
**Status**: `[ ]`

**RPCs cần define**:
```protobuf
service AgentService {
    rpc CreateRun(CreateRunRequest) returns (CreateRunResponse);
    rpc StreamRunEvents(StreamRunRequest) returns (stream RunEvent);
    rpc CancelRun(CancelRunRequest) returns (CancelRunResponse);
    rpc SubmitToolResult(SubmitToolResultRequest) returns (SubmitToolResultResponse);
    rpc GetRunStatus(GetRunStatusRequest) returns (RunStatusResponse);
    rpc ListRuns(ListRunsRequest) returns (ListRunsResponse);
    rpc ListAgents(ListAgentsRequest) returns (ListAgentsResponse);
}
```

**Checklist**:
- [ ] `proto` file với tất cả RPCs
- [ ] `buf.gen.yaml` hoặc Makefile target generate Go code
- [ ] Generate: `make proto-gen`

---

### T10 — Agent CLI Executor

**File**: `services/agent-service/internal/infra/cli/agent_executor.go`  
**Effort**: 12h  
**Assignee**: Go Dev (senior)  
**Depends on**: T08  
**Status**: `[ ]`

**Mô tả**: Spawn CLI agents (`claude`, `codex`, `gemini`) và stream output — core logic của agent service.

**Checklist**:
- [ ] `AgentExecutor` interface:
  ```go
  type AgentExecutor interface {
      Execute(ctx context.Context, run *domain.Run) (<-chan AgentOutput, error)
      Cancel(runID string) error
  }
  ```
- [ ] `CLIAgentExecutor` implementation:
  - `exec.CommandContext()` với cwd = project folder
  - Pipe `stdout` → channel (`AgentOutput{Type: "stdout", Data: chunk}`)
  - Pipe `stderr` → channel (`AgentOutput{Type: "stderr", Data: chunk}`)
  - Parse JSON streaming (claude-code format) → typed events
  - Track running processes (để cancel)
- [ ] Support agent IDs: `claude-code`, `codex`, `gemini`, `aider`
- [ ] Env vars injection (`ANTHROPIC_API_KEY`, etc.) từ run config
- [ ] Process cleanup on context cancellation

**Test**:
- [ ] Mock agent (simple echo script) → verify output streaming
- [ ] Cancel → process được kill
- [ ] Agent không tồn tại → error rõ ràng

---

### T11 — Agent Use Cases

**File**: `services/agent-service/internal/usecase/`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: T08, T10  
**Status**: `[ ]`

**Use cases**:
```go
// usecase/create_run.go
func (uc *RunUseCase) CreateRun(ctx, req CreateRunRequest) (*domain.Run, error)

// usecase/stream_run.go
func (uc *RunUseCase) StreamRunEvents(ctx, runID string, afterEventID string) (<-chan *domain.RunEvent, error)

// usecase/cancel_run.go
func (uc *RunUseCase) CancelRun(ctx, runID string) error

// usecase/submit_tool_result.go
func (uc *RunUseCase) SubmitToolResult(ctx, runID, toolUseId, content string) error

// usecase/list_agents.go
func (uc *AgentUseCase) ListAgents(ctx) ([]*domain.AgentInfo, error)
```

**Acceptance Criteria**:
- [ ] `CreateRun` tạo Run record, spawn CLI executor async
- [ ] `StreamRunEvents` trả về channel events (gRPC stream consume từ channel này)
- [ ] Events persist vào DB (`AppendEvent`) để resume với `Last-Event-ID`
- [ ] `CancelRun` signal CLI process + update status
- [ ] `ListAgents` probe installed CLIs (check PATH)

---

### T12 — Agent DB Repository (SQLite)

**File**: `services/agent-service/internal/infra/db/`  
**Effort**: 6h  
**Assignee**: Go Dev  
**Depends on**: T08  
**Status**: `[ ]`

**Checklist**:
- [ ] SQLite connection với WAL mode
- [ ] Migrations SQL:
  ```sql
  CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      conversation_id TEXT,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      exit_code INTEGER,
      signal TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      event_type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  ```
- [ ] `SQLiteRunRepository implements domain.RunRepository`
- [ ] Index: `run_events(run_id, created_at)` cho pagination

---

### T13 — Agent gRPC Handler

**File**: `services/agent-service/internal/delivery/grpc/handler.go`  
**Effort**: 6h  
**Assignee**: Go Dev  
**Depends on**: T09, T11  
**Status**: `[ ]`

**Checklist**:
- [ ] `AgentGRPCHandler` implements proto `AgentServiceServer`
- [ ] `CreateRun()` → call usecase → return `{runId}`
- [ ] `StreamRunEvents()` → server-side streaming → forward events channel → flush
- [ ] `CancelRun()` → call usecase
- [ ] Error mapping: `domain.ErrRunNotFound` → `codes.NotFound`
- [ ] gRPC server bind `:8082`

---

### T14 — Gateway: Agent Service Integration

**File**: `services/gateway/internal/upstream/agent_client.go`  
**Effort**: 6h  
**Assignee**: Go Dev  
**Depends on**: T06, T13  
**Status**: `[ ]`

**Mô tả**: Gateway gọi Agent Service qua gRPC và convert sang HTTP/SSE cho frontend.

**Checklist**:
- [ ] `AgentClient` gRPC client
- [ ] `HandleCreateRun(c echo.Context)` — POST /api/runs
  - Bind JSON body → gRPC request
  - Return `{"runId": "..."}` JSON
- [ ] `HandleStreamRunEvents(c echo.Context)` — GET /api/runs/:id/events
  - Open gRPC stream → convert thành SSE
  - `id: {eventId}\nevent: {type}\ndata: {json}\n\n`
  - Flush sau mỗi event
  - Handle disconnect gracefully
- [ ] `HandleCancelRun(c echo.Context)` — POST /api/runs/:id/cancel
- [ ] `HandleSubmitToolResult(c echo.Context)` — POST /api/runs/:id/tool-result
- [ ] Enable trong router khi `FF_GO_AGENT_SERVICE=true`

**Acceptance Criteria**:
- [ ] SSE format giống hệt daemon: `event: agent\ndata: {...}\n\n`
- [ ] `Last-Event-ID` header được pass qua gRPC `afterEventID`
- [ ] Frontend SSE consumer không cần thay đổi

---

## Tuần 9–11 — Project Service

---

### T15 — Setup Project Service Project

**File**: `services/project-service/`  
**Effort**: 3h  
**Assignee**: Go Dev  
**Depends on**: T07 (tương tự setup)  
**Status**: `[ ]`

**Checklist**:
- [ ] `go mod init github.com/open-design/project-service`
- [ ] Project structure theo Clean Architecture
- [ ] Shared proto workspace (nếu dùng buf)

---

### T16 — Project Domain Layer

**File**: `services/project-service/internal/domain/`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: T15  
**Status**: `[ ]`

**Entities**:
```go
// domain/project.go
type Project struct {
    ID        string
    Name      string
    Kind      ProjectKind  // "web-ui", "image", "video"
    Metadata  map[string]any
    Path      string      // Absolute path on disk
    CreatedAt time.Time
    UpdatedAt time.Time
}

// domain/conversation.go
type Conversation struct {
    ID        string
    ProjectID string
    Title     string
    CreatedAt time.Time
}

// domain/message.go
type Message struct {
    ID             string
    ConversationID string
    Role           string // "user" | "assistant"
    Content        string
    AgentID        string
    EventsJSON     string
    CreatedAt      time.Time
}

// domain/file.go
type ProjectFile struct {
    Path     string
    Kind     string // "file" | "directory"
    Size     int64
    Modified time.Time
}
```

**Repository interfaces**:
```go
type ProjectRepository interface {
    Create(ctx, *Project) error
    GetByID(ctx, id string) (*Project, error)
    List(ctx) ([]*Project, error)
    Update(ctx, *Project) error
    Delete(ctx, id string) error
}

type ConversationRepository interface {
    Create(ctx, *Conversation) error
    GetByID(ctx, id string) (*Conversation, error)
    ListByProject(ctx, projectID string) ([]*Conversation, error)
}

type MessageRepository interface {
    Create(ctx, *Message) error
    ListByConversation(ctx, conversationID string) ([]*Message, error)
    GetByID(ctx, id string) (*Message, error)
    Update(ctx, *Message) error
}

type FileStore interface {
    ListFiles(ctx, projectPath string) ([]*ProjectFile, error)
    CreateProjectDir(ctx, projectID string) (string, error)
    DeleteProjectDir(ctx, projectID string) error
    ServeFile(ctx, path string) (io.ReadCloser, error)
    WriteFile(ctx, path string, content io.Reader) error
}
```

---

### T17 — Project Protobuf Definitions

**File**: `services/project-service/proto/project/v1/project.proto`  
**Effort**: 4h  
**Assignee**: Go Dev  
**Depends on**: T16  
**Status**: `[ ]`

**RPCs**:
```protobuf
service ProjectService {
    rpc ListProjects(ListProjectsRequest) returns (ListProjectsResponse);
    rpc CreateProject(CreateProjectRequest) returns (Project);
    rpc GetProject(GetProjectRequest) returns (Project);
    rpc UpdateProject(UpdateProjectRequest) returns (Project);
    rpc DeleteProject(DeleteProjectRequest) returns (DeleteProjectResponse);
    rpc ListFiles(ListFilesRequest) returns (ListFilesResponse);
    rpc ListConversations(ListConversationsRequest) returns (ListConversationsResponse);
    rpc CreateConversation(CreateConversationRequest) returns (Conversation);
    rpc ListMessages(ListMessagesRequest) returns (ListMessagesResponse);
    rpc ServeArtifact(ServeArtifactRequest) returns (stream FileChunk);
    rpc ListLiveArtifacts(ListLiveArtifactsRequest) returns (ListLiveArtifactsResponse);
}
```

---

### T18 — Project DB Repository (SQLite)

**File**: `services/project-service/internal/infra/db/`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: T16  
**Status**: `[ ]`

**Checklist**:
- [ ] SQLite schema tương thích với daemon's `db.ts`:
  ```sql
  CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'web-ui',
      metadata TEXT DEFAULT '{}',
      path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE conversations (...);
  CREATE TABLE messages (...);
  ```
- [ ] `SQLiteProjectRepository`, `SQLiteConversationRepository`, `SQLiteMessageRepository`
- [ ] **Migration tool**: Script TypeScript → Go SQLite schema transform (T19)

---

### T19 — Data Migration Tool (Daemon → Project Service)

**File**: `services/project-service/cmd/migrate/main.go`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: T18  
**Status**: `[ ]`

**Mô tả**: One-time migration đọc daemon's SQLite DB và import vào Project Service DB.

```bash
# Usage:
go run services/project-service/cmd/migrate/main.go \
    --daemon-db ~/.od/data/open-design.db \
    --project-db ./data/project-service.db \
    --dry-run
```

**Checklist**:
- [ ] Read projects, conversations, messages từ daemon DB
- [ ] Transform và insert vào project-service DB
- [ ] Verify count sau migration
- [ ] `--dry-run` mode chỉ validate không write
- [ ] Idempotent (chạy lại không tạo duplicate)

---

### T20 — Project File Store & Static Serving

**File**: `services/project-service/internal/infra/fs/`  
**Effort**: 6h  
**Assignee**: Go Dev  
**Depends on**: T16  
**Status**: `[ ]`

**Checklist**:
- [ ] `LocalFileStore implements domain.FileStore`
- [ ] `ListFiles()` — recursive directory listing (filter hidden dirs)
- [ ] `CreateProjectDir()` — tạo project folder (`{workspacePath}/{projectId}/`)
- [ ] `ServeFile()` — đọc file với security path validation (no `../`)
- [ ] HTTP handler cho `/artifacts/*` và `/frames/*`:
  - Validate path không traverse ra ngoài workspace
  - Set `Content-Type` headers đúng
  - Support `If-None-Match` / `ETag` caching

---

### T21 — Gateway: Project Service Integration

**File**: `services/gateway/internal/upstream/project_client.go`  
**Effort**: 6h  
**Assignee**: Go Dev  
**Depends on**: T14, T17  
**Status**: `[ ]`

**Checklist**:
- [ ] `ProjectClient` gRPC client
- [ ] HTTP handlers cho tất cả project routes
- [ ] `GET /artifacts/*` → `ProjectService.ServeArtifact` → stream file bytes
- [ ] `GET /frames/*` → `ProjectService.ServeFrame`
- [ ] Enable trong router khi `FF_GO_PROJECT_SERVICE=true`
- [ ] Response JSON format giống hệt daemon

---

### T22 — Phase 1 Validation & A/B Testing

**Effort**: 8h  
**Assignee**: Frontend Dev + Go Dev  
**Depends on**: T14, T21  
**Status**: `[ ]`

**Checklist**:
- [ ] Deploy: Gateway (7456) + Agent Service + Project Service + Daemon (7457)
- [ ] Enable feature flags:
  ```bash
  FF_GO_AGENT_SERVICE=true
  FF_GO_PROJECT_SERVICE=true
  ```
- [ ] So sánh responses:
  ```bash
  ./scripts/compare-responses.sh /api/projects
  ./scripts/compare-responses.sh /api/agents
  ```
- [ ] E2E smoke test qua Go services:
  - [ ] Tạo project → lưu đúng vào Go DB
  - [ ] Chạy agent → SSE streaming qua Gateway → Go Agent Service
  - [ ] Cancel run → hoạt động
  - [ ] List files → đúng kết quả
  - [ ] `/artifacts/` serving → đúng
- [ ] Load test nhẹ: 10 concurrent users × 5 phút → p99 < 300ms
- [ ] Chạy liên tục 24h với monitoring → 0 regressions

**Phase 1 Done** → Unblocks Phase 2
