# 03 — Agent Service

> **Port gRPC**: 8082  
> **Domain**: AI Agent lifecycle, Run execution, SSE streaming, CLI orchestration

---

## 1. Vai trò & Trách nhiệm

Agent Service là **trái tim** của hệ thống — nó thay thế `chat-routes.ts` và một phần lớn `server.ts` hiện tại:

- **Spawn AI agent CLI processes** (claude-code, codex, gemini, aider, ...)
- **Stream output** từ agent process về client qua SSE (thông qua Gateway)
- **Translate** agent output → typed SSE events (start, agent, stdout, error, end)
- **Manage run lifecycle** — pending → running → completed/failed/cancelled
- **Support tool-result** — client trả lời tool calls
- **Resume on reconnect** — `lastEventId` để client reconnect
- **Probe CLI agents** — kiểm tra agent nào đang installed
- **BYOK API mode** — proxy trực tiếp đến AI provider API (Anthropic, OpenAI, Gemini, Ollama)

---

## 2. Cấu trúc thư mục (Clean Architecture)

```
agent-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── agent.go              # Agent entity (CLI type, config)
│   │   ├── run.go                # Run entity + state machine
│   │   ├── event.go              # RunEvent (start/agent/stdout/error/end)
│   │   ├── tool_result.go        # ToolResult entity
│   │   └── repository.go         # RunRepository, EventStore interfaces
│   │
│   ├── usecase/
│   │   ├── run_usecase.go        # CreateRun, CancelRun, GetRun
│   │   ├── stream_usecase.go     # StreamRunEvents (SSE source)
│   │   ├── tool_result_usecase.go # SubmitToolResult
│   │   ├── agent_probe_usecase.go # ListAgents, probe CLI
│   │   └── byok_usecase.go       # BYOK API mode streaming
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── run_repo.go       # Run state in Redis + PostgreSQL
│   │   │   └── event_store.go    # Event ring buffer in Redis
│   │   ├── cli/
│   │   │   ├── spawner.go        # os/exec process management
│   │   │   ├── claude_adapter.go # Claude Code output parser
│   │   │   ├── codex_adapter.go  # OpenAI Codex output parser
│   │   │   ├── gemini_adapter.go # Gemini CLI output parser
│   │   │   └── aider_adapter.go  # Aider output parser
│   │   ├── api/
│   │   │   ├── anthropic.go      # BYOK Anthropic streaming
│   │   │   ├── openai.go         # BYOK OpenAI streaming
│   │   │   ├── google.go         # BYOK Google Gemini
│   │   │   ├── ollama.go         # BYOK Ollama local
│   │   │   └── azure.go          # BYOK Azure OpenAI
│   │   └── project_client.go     # gRPC client → Project Service
│   │
│   └── delivery/
│       ├── grpc/
│       │   └── handler.go        # gRPC server
│       └── http/
│           └── health.go
│
├── proto/
│   └── agent/v1/agent.proto
└── Dockerfile
```

---

## 3. Run Lifecycle State Machine

```
                    CreateRun
                        │
                        ▼
                   ┌─────────┐
                   │ PENDING │
                   └────┬────┘
                        │ spawn process
                        ▼
                   ┌─────────┐
         ┌────────►│ RUNNING │◄────────────┐
         │         └────┬────┘             │
         │              │                  │ tool-result received
         │              │ process exits    │
         │              ▼                  │
         │     ┌─────────────────┐         │
         │     │ tool_call event │─────────┘
         │     └─────────────────┘
         │
         │    cancel request
         │         │
    ┌────┴─────┐   │   ┌────────────┐
    │CANCELLED │◄──┤   │  COMPLETED │
    └──────────┘   │   └────────────┘
                   │
                   │   ┌────────────┐
                   └──►│   FAILED   │
                       └────────────┘
```

---

## 4. Domain Model

```go
// domain/run.go
type Run struct {
    ID             string
    ProjectID      string
    ConversationID string
    AgentID        string
    Mode           RunMode        // "cli" | "byok"
    APIProtocol    *APIProtocol   // for byok mode
    Status         RunStatus
    ExitCode       *int
    Signal         *string
    StartedAt      time.Time
    FinishedAt     *time.Time
    ProcessPID     *int           // tracking live process
}

type RunMode string
const (
    RunModeCLI  RunMode = "cli"
    RunModeBYOK RunMode = "byok"
)

type APIProtocol string
const (
    APIProtocolAnthropic APIProtocol = "anthropic"
    APIProtocolOpenAI    APIProtocol = "openai"
    APIProtocolGoogle    APIProtocol = "google"
    APIProtocolAzure     APIProtocol = "azure"
    APIProtocolOllama    APIProtocol = "ollama"
)

// domain/event.go
type RunEvent struct {
    ID        string    // monotonically increasing (for SSE lastEventId)
    RunID     string
    EventType EventType // start | agent | stdout | error | end
    Data      string    // JSON payload
    CreatedAt time.Time
}

type EventType string
const (
    EventTypeStart  EventType = "start"
    EventTypeAgent  EventType = "agent"
    EventTypeStdout EventType = "stdout"
    EventTypeError  EventType = "error"
    EventTypeEnd    EventType = "end"
)
```

---

## 5. CLI Process Management

```go
// infra/cli/spawner.go
type CLISpawner struct {
    eventStore  EventStore
    projectSvc  ProjectServiceClient
}

func (s *CLISpawner) SpawnAndStream(ctx context.Context, run *domain.Run, req *RunRequest) error {
    // 1. Get project context from Project Service
    project, _ := s.projectSvc.GetProject(ctx, run.ProjectID)

    // 2. Build command based on agent type
    cmd := s.buildCommand(run.AgentID, req)
    cmd.Dir = project.WorkspacePath
    cmd.Env = s.buildEnv(req) // inject API keys from Config Service

    // 3. Create pipes
    stdout, _ := cmd.StdoutPipe()
    stderr, _ := cmd.StderrPipe()

    // 4. Publish start event
    s.eventStore.Append(run.ID, &domain.RunEvent{Type: EventTypeStart})

    // 5. Start process
    cmd.Start()

    // 6. Stream output in goroutines
    go s.streamOutput(run.ID, stdout, run.AgentID)
    go s.streamStderr(run.ID, stderr)

    // 7. Wait for completion
    err := cmd.Wait()
    if err != nil {
        s.eventStore.Append(run.ID, &domain.RunEvent{Type: EventTypeError, Data: err.Error()})
    }
    s.eventStore.Append(run.ID, &domain.RunEvent{Type: EventTypeEnd})
    return err
}
```

---

## 6. Event Store (Redis Ring Buffer)

Events được lưu trong Redis với TTL để support **reconnect với lastEventId**:

```go
// infra/db/event_store.go
type RedisEventStore struct {
    client *redis.Client
    ttl    time.Duration // default: 2h
}

// Key pattern: run_events:{runID}
// Stored as Redis List (RPUSH, LRANGE)
func (s *RedisEventStore) Append(runID string, event *domain.RunEvent) error {
    data, _ := json.Marshal(event)
    s.client.RPush(ctx, "run_events:"+runID, data)
    s.client.Expire(ctx, "run_events:"+runID, s.ttl)
}

func (s *RedisEventStore) GetSince(runID, lastEventID string) ([]*domain.RunEvent, error) {
    // Find index of lastEventID, return subsequent events
}
```

---

## 7. Agent Probe (List CLI Agents)

```go
// usecase/agent_probe_usecase.go
type AgentProbeUseCase struct{}

type AgentInfo struct {
    ID          string
    Name        string
    Available   bool
    Version     string
    Mode        string // "cli" | "api-only"
}

func (uc *AgentProbeUseCase) ListAgents(ctx context.Context) ([]*AgentInfo, error) {
    agents := []struct{ id, cmd string }{
        {"claude-code", "claude"},
        {"codex", "codex"},
        {"gemini", "gemini"},
        {"aider", "aider"},
    }

    results := make([]*AgentInfo, 0)
    for _, a := range agents {
        path, err := exec.LookPath(a.cmd)
        available := err == nil
        version := ""
        if available {
            out, _ := exec.Command(path, "--version").Output()
            version = strings.TrimSpace(string(out))
        }
        results = append(results, &AgentInfo{
            ID: a.id, Available: available, Version: version,
        })
    }
    return results, nil
}
```

---

## 8. gRPC Protocol Definition

```protobuf
syntax = "proto3";
package agent.v1;

service AgentService {
    rpc CreateRun(CreateRunRequest) returns (Run);
    rpc GetRun(GetRunRequest) returns (Run);
    rpc CancelRun(CancelRunRequest) returns (google.protobuf.Empty);
    rpc SubmitToolResult(SubmitToolResultRequest) returns (google.protobuf.Empty);

    // Server streaming — Gateway will convert to SSE
    rpc StreamRunEvents(StreamRunEventsRequest) returns (stream RunEvent);

    rpc ListAgents(ListAgentsRequest) returns (ListAgentsResponse);
}

message CreateRunRequest {
    string project_id = 1;
    string conversation_id = 2;
    string agent_id = 3;
    string prompt = 4;
    map<string, string> context = 5;
    string run_mode = 6;      // "cli" | "byok"
    string api_protocol = 7;  // for byok mode
    bytes  api_config = 8;    // JSON: endpoint, key (encrypted)
}

message StreamRunEventsRequest {
    string run_id = 1;
    string last_event_id = 2;
}

message RunEvent {
    string id = 1;
    string run_id = 2;
    string event_type = 3;
    string data = 4;
    google.protobuf.Timestamp created_at = 5;
}
```

---

## 9. BYOK (Bring Your Own Key) Mode

Khi `run_mode = "byok"`, Agent Service proxy streaming đến AI provider API trực tiếp:

```go
// infra/api/anthropic.go
type AnthropicAdapter struct {
    httpClient *http.Client
    eventStore EventStore
}

func (a *AnthropicAdapter) StreamChat(ctx context.Context, run *domain.Run, req *ByokRequest) error {
    // POST to api.anthropic.com/v1/messages với stream=true
    // Parse SSE response → translate to RunEvent
    // Append events to event store
    // Gateway streams these to client
}
```

---

## 10. Interservice Dependencies

| Calls to | Purpose |
|----------|---------|
| **Project Service** | Get project workspace path, create/update run record |
| **Config Service** | Get API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) |
| **Memory Service** | Inject context into agent prompt |
| **Design System Service** | Inject active design system into agent system prompt |
| **Skill Service** | Get skill definition to inject into prompt |
| **Telemetry Service** | Publish run events (async via NATS) |
