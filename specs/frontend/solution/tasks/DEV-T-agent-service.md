# DEV-T-03 — Agent Service Implementation Tasks

> **Service**: `services/preview-ai-agent` → Nâng cấp  
> **Effort**: 12 ngày  
> **Sprint**: Sprint 2 (Tuần 3–5)  
> **Ref**: [DEV-03-agent-service.md](../../develop/DEV-03-agent-service.md)

---

## Nguyên tắc

> ✅ **GIỮ NGUYÊN**: `AIJob` entity, `ai_job_service.go`, document generation flow, `ai_jobs` table  
> ❌ **KHÔNG CHẠM**: `chat-preview-service` — service khác, không merge  
> ✅ **THÊM MỚI**: Run entity, CLI spawner, Event Store (Redis), gRPC server, BYOK refactor

---

## Nhóm A — Domain Layer Mới (Ngày 1)

---

### A01 — Entity `Run` + State Machine

**File**: `services/preview-ai-agent/internal/domain/run.go`  
**Effort**: 3h  
**Status**: `[ ]`

```go
package domain

import "time"

type RunMode string
const (
    RunModeCLI  RunMode = "cli"
    RunModeBYOK RunMode = "byok"
)

type RunStatus string
const (
    RunStatusPending   RunStatus = "pending"
    RunStatusRunning   RunStatus = "running"
    RunStatusCompleted RunStatus = "completed"
    RunStatusFailed    RunStatus = "failed"
    RunStatusCancelled RunStatus = "cancelled"
)

// Valid status transitions
var validTransitions = map[RunStatus][]RunStatus{
    RunStatusPending:   {RunStatusRunning, RunStatusCancelled},
    RunStatusRunning:   {RunStatusCompleted, RunStatusFailed, RunStatusCancelled},
    RunStatusCompleted: {},
    RunStatusFailed:    {},
    RunStatusCancelled: {},
}

type Run struct {
    ID             string
    ProjectID      string
    ConversationID string
    AgentID        string
    Mode           RunMode
    APIProtocol    *string  // byok: "anthropic"|"openai"|"google"|"ollama"
    Status         RunStatus
    ExitCode       *int
    Signal         *string
    ProcessPID     *int
    StartedAt      time.Time
    FinishedAt     *time.Time
}

// ValidateTransition checks if status change is allowed
func (r *Run) ValidateTransition(newStatus RunStatus) error {
    valid := validTransitions[r.Status]
    for _, s := range valid {
        if s == newStatus {
            return nil
        }
    }
    return ErrInvalidStatusTransition
}

var (
    ErrRunNotFound              = errors.New("run not found")
    ErrInvalidStatusTransition  = errors.New("invalid status transition")
    ErrRunAlreadyFinished       = errors.New("run already finished")
)
```

---

### A02 — Entity `RunEvent`

**File**: `services/preview-ai-agent/internal/domain/event.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
type RunEventType string
const (
    EventTypeStdout RunEventType = "stdout"
    EventTypeStderr RunEventType = "stderr"
    EventTypeAgent  RunEventType = "agent"
    EventTypeStart  RunEventType = "start"
    EventTypeEnd    RunEventType = "end"
    EventTypeError  RunEventType = "error"
)

type RunEvent struct {
    ID        string       // uuid — dùng làm SSE event ID
    RunID     string
    EventType RunEventType
    Data      string       // JSON string
    CreatedAt time.Time
}
```

---

### A03 — Entity `AgentInfo` + Repository Interfaces

**File**: `services/preview-ai-agent/internal/domain/agent_info.go`  
**File**: `services/preview-ai-agent/internal/domain/repository.go`  
**Effort**: 2h  
**Status**: `[ ]`

```go
// agent_info.go
type AgentInfo struct {
    ID          string  // "claude-code" | "codex" | "gemini"
    Name        string
    Available   bool
    Version     string
    Description string
}

// repository.go
type RunRepository interface {
    Create(ctx context.Context, r *Run) error
    GetByID(ctx context.Context, id string) (*Run, error)
    UpdateStatus(ctx context.Context, id string, status RunStatus, exitCode *int, signal *string) error
    UpdatePID(ctx context.Context, id string, pid int) error
    List(ctx context.Context, filter RunFilter) ([]*Run, error)
}

type EventStore interface {
    Append(ctx context.Context, runID string, event *RunEvent) error
    GetSince(ctx context.Context, runID, lastEventID string) ([]*RunEvent, error)
    Subscribe(ctx context.Context, runID string) (<-chan *RunEvent, error)
    Unsubscribe(runID string, ch <-chan *RunEvent)
}
```

---

## Nhóm B — Event Store (Redis Ring Buffer) (Ngày 2–3)

---

### B01 — Redis Event Store

**File**: `services/preview-ai-agent/internal/infra/db/event_store.go`  
**Effort**: 2 ngày  
**Status**: `[ ]`

**Mô tả**: Events từ CLI process được lưu vào Redis List với TTL, hỗ trợ client reconnect với `Last-Event-ID`.

```go
type RedisEventStore struct {
    client *redis.Client
    ttl    time.Duration   // 1 giờ mặc định
    pubsub *redis.PubSub
}

// Key patterns:
// - run_events:{runID}  → Redis List (RPUSH/LRANGE)
// - run_events:{runID}:channel → Redis Pub/Sub channel

func NewRedisEventStore(client *redis.Client, ttl time.Duration) *RedisEventStore

// Append: RPUSH event vào list + PUBLISH qua pub/sub
func (s *RedisEventStore) Append(ctx, runID string, event *RunEvent) error {
    data, _ := json.Marshal(event)
    
    pipe := s.client.TxPipeline()
    pipe.RPush(ctx, key(runID), data)
    pipe.Expire(ctx, key(runID), s.ttl)
    pipe.Publish(ctx, channelKey(runID), data)
    
    _, err := pipe.Exec(ctx)
    return err
}

// GetSince: LRANGE sau lastEventID position
func (s *RedisEventStore) GetSince(ctx, runID, lastEventID string) ([]*RunEvent, error)

// Subscribe: Redis Pub/Sub subscriber cho real-time events
func (s *RedisEventStore) Subscribe(ctx, runID string) (<-chan *RunEvent, error)
```

**Test**:
- [ ] `Append` → `GetSince("")` trả về tất cả events
- [ ] `Append` → `GetSince(lastID)` chỉ trả về events sau đó
- [ ] `Subscribe` nhận event ngay khi `Append` publish
- [ ] TTL: event tự xóa sau 1 giờ

---

### B02 — Postgres Run Repository

**File**: `services/preview-ai-agent/internal/infra/db/run_repo.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```sql
-- migrations/create_agent_runs.sql (THÊM MỚI — không xóa ai_jobs)
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

## Nhóm C — CLI Spawner (Ngày 3–6, Critical)

---

### C01 — `CLISpawner` Core

**File**: `services/preview-ai-agent/internal/infra/cli/spawner.go`  
**Effort**: 2 ngày  
**Status**: `[ ]`

```go
type CLISpawner struct {
    eventStore    domain.EventStore
    runRepo       domain.RunRepository
    configClient  ConfigServiceClient  // lấy API keys
    projectClient ProjectServiceClient // lấy workspace path
    
    mu       sync.Mutex
    running  map[string]*os.Process // runID → process
}

// SpawnAndStream: chạy trong goroutine riêng
func (s *CLISpawner) SpawnAndStream(ctx context.Context, run *domain.Run, req *CreateRunRequest) error {
    // 1. Lấy workspace path từ Project Service
    wsPath, err := s.projectClient.GetWorkspacePath(ctx, run.ProjectID)
    
    // 2. Lấy API keys từ Config Service
    envVars, err := s.buildEnvVars(ctx, run)
    
    // 3. Chọn adapter theo agentID
    adapter := s.selectAdapter(run.AgentID)
    
    // 4. Build command
    cmd := exec.CommandContext(ctx, adapter.BinaryPath(), adapter.Args(req)...)
    cmd.Dir = wsPath
    cmd.Env = append(os.Environ(), envVars...)
    
    // 5. Pipe stdout/stderr
    stdout, _ := cmd.StdoutPipe()
    stderr, _ := cmd.StderrPipe()
    
    // 6. Start process
    if err := cmd.Start(); err != nil {
        return err
    }
    
    // 7. Track process
    s.mu.Lock()
    s.running[run.ID] = cmd.Process
    s.mu.Unlock()
    
    // 8. Update PID in DB
    s.runRepo.UpdatePID(ctx, run.ID, cmd.Process.Pid)
    
    // Emit start event
    s.emitEvent(ctx, run.ID, &domain.RunEvent{
        EventType: domain.EventTypeStart,
        Data: `{"pid":` + strconv.Itoa(cmd.Process.Pid) + `}`,
    })
    
    // 9. Stream stdout
    go s.streamPipe(ctx, run.ID, stdout, adapter, domain.EventTypeStdout)
    go s.streamPipe(ctx, run.ID, stderr, nil, domain.EventTypeStderr)
    
    // 10. Wait for completion
    err = cmd.Wait()
    exitCode := cmd.ProcessState.ExitCode()
    
    // 11. Update status
    if err != nil {
        s.runRepo.UpdateStatus(ctx, run.ID, domain.RunStatusFailed, &exitCode, nil)
    } else {
        s.runRepo.UpdateStatus(ctx, run.ID, domain.RunStatusCompleted, &exitCode, nil)
    }
    
    // 12. Emit end/error event
    // 13. Close event store channel
    return nil
}

// CancelRun: kill process
func (s *CLISpawner) CancelRun(ctx context.Context, runID string) error {
    s.mu.Lock()
    proc, ok := s.running[runID]
    s.mu.Unlock()
    
    if !ok {
        return domain.ErrRunNotFound
    }
    
    return proc.Kill()
}
```

**Security**:
- [ ] Whitelist allowed binary names: `claude`, `claude-code`, `codex`, `gemini`, `aider`
- [ ] **KHÔNG** dùng `exec.Command("sh", "-c", ...)` — no shell injection
- [ ] `filepath.Clean` trên workspace path

---

### C02 — Claude Code Adapter

**File**: `services/preview-ai-agent/internal/infra/cli/claude_adapter.go`  
**Effort**: 1 ngày  
**Status**: `[ ]`

```go
// CLIOutputAdapter interface
type CLIOutputAdapter interface {
    BinaryPath() string
    Args(req *CreateRunRequest) []string
    ParseLine(line string) (*domain.RunEvent, error)
    AgentID() string
}

// ClaudeCodeAdapter: parse claude-code streaming JSON output
type ClaudeCodeAdapter struct{}

// claude-code output format: JSON objects per line
// {"type":"content","content":[{"type":"text","text":"..."}]}
// {"type":"tool_use","name":"bash","input":{"command":"..."}}
// {"type":"tool_result","tool_use_id":"...","content":"..."}

func (a *ClaudeCodeAdapter) ParseLine(line string) (*domain.RunEvent, error) {
    var raw map[string]any
    if err := json.Unmarshal([]byte(line), &raw); err != nil {
        // Plain text line (non-JSON)
        return &domain.RunEvent{
            EventType: domain.EventTypeStdout,
            Data:      fmt.Sprintf(`{"text":%q}`, line),
        }, nil
    }
    
    eventType := raw["type"].(string)
    switch eventType {
    case "content":
        return &domain.RunEvent{
            EventType: domain.EventTypeAgent,
            Data:      line,
        }, nil
    case "tool_use":
        return &domain.RunEvent{
            EventType: domain.EventTypeAgent,
            Data:      line,
        }, nil
    // ... handle other types
    }
    return nil, nil
}
```

**Acceptance Criteria**:
- [ ] Plain text lines → `EventTypeStdout`
- [ ] `{"type":"content",...}` → `EventTypeAgent`
- [ ] `{"type":"tool_use",...}` → `EventTypeAgent`
- [ ] Malformed JSON → không crash, log và bỏ qua

---

### C03 — Tool Result Handler (stdin injection)

**File**: `services/preview-ai-agent/internal/infra/cli/spawner.go` (thêm method)  
**Effort**: 4h  
**Status**: `[ ]`

```go
// SubmitToolResult: ghi tool result vào stdin của running process
func (s *CLISpawner) SubmitToolResult(ctx context.Context, runID, toolUseID, content string) error {
    s.mu.Lock()
    stdin, ok := s.runningStdin[runID]
    s.mu.Unlock()
    
    if !ok {
        return domain.ErrRunNotFound
    }
    
    // Format phụ thuộc vào agent
    result := map[string]any{
        "type":        "tool_result",
        "tool_use_id": toolUseID,
        "content":     content,
    }
    data, _ := json.Marshal(result)
    _, err := fmt.Fprintf(stdin, "%s\n", data)
    return err
}
```

---

## Nhóm D — BYOK Refactor (Ngày 6–7.5)

---

### D01 — `APIProvider` Interface

**File**: `services/preview-ai-agent/internal/infra/api/provider.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
type APIProvider interface {
    StreamChat(ctx context.Context, run *domain.Run, req *ByokRequest, eventStore domain.EventStore) error
    Name() string // "anthropic" | "openai" | "google" | "ollama"
}
```

---

### D02 — Refactor `ai_job_service.go` → `infra/api/`

**Files**: `internal/infra/api/anthropic.go`, `openai.go`  
**Effort**: 1.5 ngày  
**Status**: `[ ]`

**Mô tả**: Di chuyển HTTP streaming code từ `service/ai_job_service.go` vào `infra/api/` với interface chuẩn. **Không xóa** `ai_job_service.go` — vẫn giữ để serve `/api/v1/ai/` routes cũ.

- [ ] Extract Anthropic streaming → `anthropic.go` implements `APIProvider`
- [ ] Extract OpenAI streaming → `openai.go` implements `APIProvider`
- [ ] Thêm Google Gemini streaming → `google.go` (mới)
- [ ] `ai_job_service.go` vẫn tồn tại, import từ `infra/api/` nếu cần

---

## Nhóm E — Agent Probe (Ngày 7.5–8)

---

### E01 — `AgentProbeUseCase`

**File**: `services/preview-ai-agent/internal/usecase/agent_probe_usecase.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```go
// ListAgents: probe các CLI agents đang được cài
func (uc *AgentProbeUseCase) ListAgents(ctx context.Context) ([]*domain.AgentInfo, error) {
    var agents []*domain.AgentInfo
    
    candidates := []struct {
        id   string
        name string
        bins []string // binary names to check
    }{
        {"claude-code", "Claude Code", []string{"claude", "claude-code"}},
        {"codex", "OpenAI Codex", []string{"codex"}},
        {"gemini", "Gemini CLI", []string{"gemini"}},
        {"aider", "Aider", []string{"aider"}},
    }
    
    for _, c := range candidates {
        for _, bin := range c.bins {
            path, err := exec.LookPath(bin)
            if err == nil {
                // Probe version
                version := probeVersion(path)
                agents = append(agents, &domain.AgentInfo{
                    ID:        c.id,
                    Name:      c.name,
                    Available: true,
                    Version:   version,
                })
                break
            }
        }
    }
    
    return agents, nil
}
```

---

## Nhóm F — gRPC Server (Ngày 8–9.5)

---

### F01 — Proto Definition

**File**: `services/preview-ai-agent/api/proto/agent/v1/agent.proto`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```protobuf
syntax = "proto3";

package agent.v1;

service AgentService {
    rpc CreateRun(CreateRunRequest) returns (Run);
    rpc GetRun(GetRunRequest) returns (Run);
    rpc CancelRun(CancelRunRequest) returns (google.protobuf.Empty);
    rpc SubmitToolResult(SubmitToolResultRequest) returns (google.protobuf.Empty);
    rpc StreamRunEvents(StreamRunEventsRequest) returns (stream RunEvent);
    rpc ListAgents(ListAgentsRequest) returns (ListAgentsResponse);
}

message CreateRunRequest {
    string project_id      = 1;
    string conversation_id = 2;
    string agent_id        = 3;
    string mode            = 4;   // "cli" | "byok"
    string prompt          = 5;
    repeated Message history = 6;
    ByokConfig byok_config = 7;
}

message StreamRunEventsRequest {
    string run_id        = 1;
    string last_event_id = 2;  // for resume
}

message RunEvent {
    string id         = 1;
    string run_id     = 2;
    string event_type = 3;
    string data       = 4;  // JSON string
}
```

---

### F02 — gRPC Handler

**File**: `services/preview-ai-agent/internal/adapter/controller/grpc/handler.go`  
**Effort**: 1.5 ngày  
**Status**: `[ ]`

```go
type AgentGRPCHandler struct {
    agentpb.UnimplementedAgentServiceServer
    runUC      *usecase.RunUseCase
    streamUC   *usecase.StreamUseCase
    probeUC    *usecase.AgentProbeUseCase
    spawner    *cli.CLISpawner
}

// CreateRun: validate → tạo Run record → spawn async → trả về Run
func (h *AgentGRPCHandler) CreateRun(ctx, req) (*agentpb.Run, error)

// StreamRunEvents: gRPC server streaming → forward từ EventStore
func (h *AgentGRPCHandler) StreamRunEvents(req, stream agentpb.AgentService_StreamRunEventsServer) error {
    eventCh, err := h.streamUC.Subscribe(stream.Context(), req.RunId, req.LastEventId)
    for event := range eventCh {
        if err := stream.Send(toProto(event)); err != nil {
            return err
        }
    }
    return nil
}

// CancelRun → spawner.CancelRun
// SubmitToolResult → spawner.SubmitToolResult
// ListAgents → probeUC.ListAgents
```

---

### F03 — Thêm gRPC Server vào `main.go`

**File**: `services/preview-ai-agent/cmd/main.go` (MODIFY)  
**Effort**: 1h  
**Status**: `[ ]`

```go
// Thêm gRPC server song song với HTTP server hiện có:
go func() {
    lis, _ := net.Listen("tcp", cfg.GRPCAddr) // ":8082"
    grpcServer := grpc.NewServer(grpc.UnaryInterceptor(...))
    agentpb.RegisterAgentServiceServer(grpcServer, handler)
    grpcServer.Serve(lis)
}()

// HTTP server hiện có — giữ nguyên
httpServer.ListenAndServe()
```

---

## Nhóm G — Tests (Ngày 9.5–12)

---

### G01 — Unit Tests CLI Spawner

**Files**: `spawner_test.go`, `claude_adapter_test.go`  
**Effort**: 1 ngày  
**Status**: `[ ]`

- [ ] Mock agent (simple script): `echo '{"type":"content"}'`
- [ ] Test `SpawnAndStream` → events được emit
- [ ] Test `CancelRun` → process killed
- [ ] Test `ClaudeCodeAdapter.ParseLine` — all event types

---

### G02 — Unit Tests Event Store

**File**: `event_store_test.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

- [ ] `Append` + `GetSince` với real Redis (miniredis)
- [ ] `Subscribe` — receive events via pub/sub

---

### G03 — Integration Tests

**Effort**: 0.5 ngày  
**Status**: `[ ]`

- [ ] End-to-end: `CreateRun` → spawn echo agent → stream events → `GetRun` status=completed
- [ ] Existing `ai_job_service` flow vẫn hoạt động

---

## Acceptance Criteria (DEV-03)

- [ ] `POST /api/runs` tạo Run, spawn CLI process
- [ ] `GET /api/runs/:id/events` SSE stream qua Gateway
- [ ] Client reconnect với `Last-Event-ID` resume đúng
- [ ] `POST /api/runs/:id/cancel` kill process thành công
- [ ] `POST /api/runs/:id/tool-result` inject vào stdin
- [ ] `GET /api/agents` trả về available agents
- [ ] BYOK mode (anthropic, openai) stream thành công
- [ ] AI document generation flow hiện tại (`ai_jobs`) **không bị ảnh hưởng**
- [ ] `go test ./... -race` pass
