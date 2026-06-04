# DEV-03 — Agent Service: Nâng cấp `preview-ai-agent`

> **Chiến lược**: ✅ **Nâng cấp** — Mở rộng `preview-ai-agent` trong-place, không đụng vào các service khác  
> **Nguồn**: `services/preview-ai-agent/`  
> **Giữ nguyên**: `services/chat-preview-service/` — không chạm  
> **Spec tham chiếu**: `specs/services/03-agent-service.md`

---

## 1. Phân tích Codebase Hiện có

### 1.1 `preview-ai-agent` — Hiện trạng

```
internal/
├── domain/
│   └── types.go                 ← AIJob, AIJobStatus, AIPrompt, AISession
├── service/
│   └── ai_job_service.go        ← 15KB — job management, LLM calls (OpenAI/Anthropic)
├── biz/                         ← Business layer
├── client/                      ← HTTP clients to external APIs
├── infra/                       ← Database
└── adapter/
    └── controller/              ← HTTP handlers
```

**Domain hiện tại** (`AIJob`):
- `AIJobStatus`: queued → processing → done/failed
- `AIJob`: job record cho async document generation
- **Thiếu**: Agent Service cần quản lý CLI process spawning, SSE streaming, không chỉ async job

### 1.2 `chat-preview-service` — Giữ Nguyên (Không Chạm)

`chat-preview-service` là service độc lập, tiếp tục chạy song song. **Không merge** vào Agent Service.

Những khả năng mới cần thêm cho Agent Service (CLI spawn, SSE stream, BYOK) sẽ được viết mới hoàn toàn trong `preview-ai-agent`.

---

## 2. Kiến trúc Mới của Agent Service

### 2.1 Cấu trúc Thư mục Mới (Clean Architecture chuẩn)

```
preview-ai-agent/   ← đổi tên thành agent-service hoặc giữ tên
├── cmd/
│   └── main.go                  ← cập nhật DI wiring
├── internal/
│   ├── domain/
│   │   ├── types.go             ← GIỮ AIJob + thêm Run, RunEvent, RunStatus
│   │   ├── run.go               ← THÊM MỚI: Run entity + state machine
│   │   ├── event.go             ← THÊM MỚI: RunEvent entity
│   │   ├── agent_info.go        ← THÊM MỚI: AgentInfo (CLI probe)
│   │   └── repository.go       ← THÊM MỚI: interfaces
│   │
│   ├── usecase/                 ← THÊM MỚI (thay thế service/)
│   │   ├── run_usecase.go       ← CreateRun, CancelRun, GetRun
│   │   ├── stream_usecase.go    ← StreamRunEvents (gRPC server streaming)
│   │   ├── tool_result_usecase.go ← SubmitToolResult
│   │   ├── agent_probe_usecase.go ← ListAgents (probe CLI)
│   │   └── byok_usecase.go      ← BYOK API mode streaming
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── run_repo.go      ← THÊM MỚI: Run records in PostgreSQL
│   │   │   └── event_store.go   ← THÊM MỚI: Redis ring buffer for events
│   │   ├── cli/
│   │   │   ├── spawner.go       ← THÊM MỚI: os/exec process management
│   │   │   ├── claude_adapter.go← THÊM MỚI: Claude Code output parser
│   │   │   ├── gemini_adapter.go← THÊM MỚI: Gemini CLI output parser
│   │   │   └── codex_adapter.go ← THÊM MỚI: Codex output parser
│   │   └── api/                 ← GIỮ + refactor từ service/ai_job_service.go
│   │       ├── anthropic.go     ← REFACTOR: BYOK Anthropic streaming
│   │       ├── openai.go        ← REFACTOR: BYOK OpenAI streaming
│   │       └── google.go        ← THÊM MỚI: BYOK Google Gemini
│   │
│   └── adapter/
│       ├── controller/
│       │   └── grpc/
│       │       └── handler.go   ← THÊM MỚI: gRPC server handler
│       └── client/              ← GIỮ + thêm Config, Project clients
│
├── api/proto/agent/v1/
│   └── agent.proto              ← THÊM MỚI
└── migrations/                  ← THÊM MỚI
```

### 2.2 Domain Model Mới

```go
// internal/domain/run.go — THÊM MỚI
type Run struct {
    ID             string
    ProjectID      string
    ConversationID string
    AgentID        string        // "claude-code" | "codex" | "gemini" | "byok-anthropic" | ...
    Mode           RunMode       // "cli" | "byok"
    APIProtocol    *string       // for byok: "anthropic"|"openai"|"google"|"ollama"
    Status         RunStatus
    ExitCode       *int
    Signal         *string
    ProcessPID     *int
    StartedAt      time.Time
    FinishedAt     *time.Time
}

// GIỮ từ types.go nhưng RENAME để phân biệt:
// AIJob → dùng cho document generation (cũ)
// Run → dùng cho agent conversation (mới)
```

### 2.3 Event Store (Redis Ring Buffer) — Mới

```go
// internal/infra/db/event_store.go
// Events: lưu trong Redis List với TTL để support lastEventId resume

type RedisEventStore struct {
    client *redis.Client
    ttl    time.Duration
}

// Key: run_events:{runID}
func (s *RedisEventStore) Append(runID string, event *RunEvent) error
func (s *RedisEventStore) GetSince(runID, lastEventID string) ([]*RunEvent, error)
func (s *RedisEventStore) Subscribe(runID string) (<-chan *RunEvent, error)
```

**Lưu ý**: Gateway đã có Redis client (rate limiter). Dùng chung Redis instance.

---

## 3. CLI Spawner — Trái tim của Agent Service

### 3.1 Yêu cầu `spawner.go`

```go
type CLISpawner struct {
    eventStore     EventStore
    projectClient  ProjectServiceClient    // gRPC → preview-project
    configClient   ConfigServiceClient     // gRPC → config-service (API keys)
    memoryClient   MemoryServiceClient     // gRPC → memory-service (context)
    dsSvcClient    DesignSystemSvcClient   // gRPC → design-system-service (DS context)
}

// SpawnAndStream: spawn CLI agent process và stream output về event store
func (s *CLISpawner) SpawnAndStream(ctx context.Context, run *Run, req *CreateRunRequest) error

// CancelRun: kill running process
func (s *CLISpawner) CancelRun(ctx context.Context, runID string) error
```

### 3.2 CLI Agent Adapters

Mỗi CLI agent có output format khác nhau:

| Agent | Format | Output Parser |
|-------|--------|--------------|
| `claude-code` | Anthropic streaming JSON + tool events | `claude_adapter.go` |
| `codex` | OpenAI streaming JSON | `codex_adapter.go` |
| `gemini` | Google streaming JSON | `gemini_adapter.go` |
| `aider` | Plain text + structured events | `aider_adapter.go` |

```go
// interface cho tất cả adapters
type CLIOutputAdapter interface {
    ParseLine(line string) (*RunEvent, error)
    AgentID() string
}
```

---

## 4. BYOK Mode — Refactor từ `ai_job_service.go`

File `service/ai_job_service.go` (~15KB) đã có:
- Anthropic API calls
- OpenAI API calls
- Streaming response handling

**Việc cần làm**: Refactor thành `internal/infra/api/` với interface chuẩn (giữ các HTTP client code, chỉ restructure):

```go
type APIProvider interface {
    StreamChat(ctx context.Context, run *Run, req *ByokRequest) error
    Name() string // "anthropic" | "openai" | "google" | "ollama"
}
```

**Không** lấy code từ `chat-preview-service`. Tất cả streaming logic mới viết trong `preview-ai-agent`.

---

## 5. gRPC Server — Mới Hoàn Toàn

```protobuf
// api/proto/agent/v1/agent.proto
service AgentService {
    rpc CreateRun(CreateRunRequest) returns (Run);
    rpc GetRun(GetRunRequest) returns (Run);
    rpc CancelRun(CancelRunRequest) returns (google.protobuf.Empty);
    rpc SubmitToolResult(SubmitToolResultRequest) returns (google.protobuf.Empty);
    rpc StreamRunEvents(StreamRunEventsRequest) returns (stream RunEvent);
    rpc ListAgents(ListAgentsRequest) returns (ListAgentsResponse);
}
```

Hiện tại `preview-ai-agent` chỉ expose HTTP. Cần **thêm gRPC server** tương tự cách `preview-project` đã làm.

---

## 6. Phụ thuộc (Interservice)

| Service | Protocol | Mục đích |
|---------|---------|---------|
| `preview-project` | gRPC | Get project workspace path, tạo Run record |
| `config-service` | gRPC | Lấy API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY) |
| `memory-service` | gRPC | Inject context vào agent prompt |
| `design-system-svc` | gRPC | Inject active DS vào system prompt |
| Redis | SDK | Event store cho SSE |
| NATS | SDK | Publish run events cho Telemetry |

---

## 7. Giữ Nguyên

- ✅ `AIJob` entity và document generation flow (dùng cho `/api/v1/ai/` routes hiện tại)
- ✅ Database schema `ai_jobs` table
- ✅ HTTP handlers cho `/api/v1/ai/` (vẫn hoạt động song song)
- ✅ `ai_job_service.go` (refactor nhẹ, không xóa)

---

## 8. Database Migration

```sql
-- Thêm bảng mới (không xóa ai_jobs)
CREATE TABLE agent_runs (
    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id      TEXT NOT NULL,
    conversation_id TEXT,
    agent_id        TEXT NOT NULL,
    mode            TEXT NOT NULL DEFAULT 'cli',
    api_protocol    TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    exit_code       INTEGER,
    signal          TEXT,
    process_pid     INTEGER,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ
);

CREATE INDEX idx_agent_runs_project ON agent_runs(project_id);
CREATE INDEX idx_agent_runs_status ON agent_runs(status);
```

---

## 9. Acceptance Criteria

- [x] `POST /api/runs` tạo Run record, spawn CLI agent process
- [x] `GET /api/runs/:id/events` stream SSE events về client
- [x] Client reconnect với `Last-Event-ID` được resume đúng
- [x] `POST /api/runs/:id/cancel` kill process thành công
- [x] `POST /api/runs/:id/tool-result` forward tool result vào stdin của process
- [x] `GET /api/agents` trả về list agents với availability status
- [x] BYOK mode: anthropic, openai stream thành công
- [x] AI document generation flow hiện tại KHÔNG bị ảnh hưởng

---

## 10. Effort Estimate

| Task | Estimate |
|------|---------|
| Domain model (Run, Event, AgentInfo) | 1 ngày |
| CLI Spawner + Claude adapter | 3 ngày |
| Event Store (Redis ring buffer) | 2 ngày |
| gRPC server setup | 1.5 ngày |
| BYOK refactor | 1.5 ngày |
| Agent probe (ListAgents) | 0.5 ngày |
| Database migration | 0.5 ngày |
| Integration tests | 2 ngày |
| **Tổng** | **12 ngày** |
