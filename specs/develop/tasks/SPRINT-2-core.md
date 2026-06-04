# Sprint 2 — Core Services Tasks

> **Mục tiêu**: Project Service (entities mới), Agent Service (CLI spawn + SSE), MCP Service (migrate + OD tools)  
> **Thời gian**: Tuần 3-5 | **Team**: 3 Developers song song

---

## T-2PJ-01: Project Service — Domain Entities Mới {#t-2pj-01}

**Estimate**: 1 ngày | **Assignee**: Dev 1 | **Depends on**: T-1IN-01

### Bước thực hiện

```
[x] 1. Tạo internal/domain/entity/conversation.go
[x] 2. Tạo internal/domain/entity/message.go
[x] 3. Tạo internal/domain/entity/run.go (RunStatus state machine: IsTerminal, CanCancel)
[x] 4. Tạo internal/domain/entity/live_artifact.go
[x] 5. Tạo internal/domain/entity/od_extensions.go (ProjectKind, ProjectFile, ProjectRecordODExt)
[x] 6. ProjectFile entity trong od_extensions.go
[ ] 7. Viết unit tests cho all entities (validation, state transitions)
```

### Acceptance Criteria
- [x] Tất cả entities compile không lỗi
- [x] `RunStatus` transition: pending → running → completed/failed/cancelled
- [x] `ProjectKind` validate input (reject unknown kinds)

---

## T-2PJ-02: Project Service — Conversation Repository {#t-2pj-02}

**Estimate**: 1 ngày | **Assignee**: Dev 1 | **Depends on**: T-2PJ-01

### Bước thực hiện

```
[x] 1. Tạo internal/usecase/port/od_ports.go — ConversationRepository + MessageRepository interfaces
[x] 2. Tạo migrations/010_conversations_messages.sql
[x] 3. Thêm 010_conversations + 010_messages vào auto_migrate.go
[x] 4. Tạo internal/infra/persistence/postgres/conversation_repo.go (ConversationRepo + MessageRepo)
[x] 5. Tạo internal/infra/persistence/postgres/helpers.go — newUUID() stdlib
[ ] 6. Integration tests với testcontainers (PostgreSQL)
```

### Acceptance Criteria
- [x] Create/GetByID/ListByProject/Delete đều hoạt động
- [x] Delete conversation cascade xóa messages (ON DELETE CASCADE)
- [x] ListByProject trả về đúng conversations theo project_id

---

## T-2PJ-03: Project Service — Run Repository {#t-2pj-03}

**Estimate**: 1 ngày | **Assignee**: Dev 1 | **Depends on**: T-2PJ-01

### Bước thực hiện

```
[x] 1. RunRepository interface trong od_ports.go
[x] 2. Tạo migrations/011_agent_runs.sql
[x] 3. Thêm 011_agent_runs vào auto_migrate.go
[x] 4. Implement RunRepo trong internal/infra/persistence/postgres/od_repos.go
[ ] 5. Integration tests
```

### Acceptance Criteria
- [x] `UpdateStatus` cập nhật đúng status + exit_code + finished_at
- [x] `ListByProject` trả về limit records, ordered by started_at DESC

---

## T-2PJ-04: Project Service — LiveArtifact Repository {#t-2pj-04}

**Estimate**: 0.5 ngày | **Assignee**: Dev 1 | **Depends on**: T-2PJ-01

### Bước thực hiện

```
[x] 1. LiveArtifactRepository interface trong od_ports.go
[x] 2. Tạo migrations/012_live_artifacts.sql
[x] 3. Thêm 012_live_artifacts vào auto_migrate.go
[x] 4. Implement LiveArtifactRepo trong od_repos.go
[ ] 5. Tests
```

### Acceptance Criteria
- [x] CRUD operations đầy đủ
- [x] Unique constraint trên (project_id, slug)

---

## T-2PJ-05: Project Service — File Store Adapter {#t-2pj-05}

**Estimate**: 1.5 ngày | **Assignee**: Dev 1 | **Depends on**: T-2PJ-01

### Bước thực hiện

```
[x] 1. FileStore interface trong od_ports.go
[x] 2. Tạo internal/infra/fs/local_file_store.go:
        - workspaceRoot: OD_WORKSPACE_ROOT env
        - ListFiles: filepath.WalkDir, return tree structure
        - ReadFile: os.ReadFile + mime.TypeByExtension
        - Security: path traversal protection (filepath.Clean + HasPrefix check)
[ ] 3. Viết security test: path traversal attempt → error
[ ] 4. Unit tests với temp directory
```

### Acceptance Criteria
- [x] `ListFiles(\"proj-123\")` trả về file tree
- [x] `ReadFile(\"proj-123\", \"src/App.tsx\")` trả về content + MIME
- [x] Path traversal `../../etc/passwd` → error (ErrPathTraversal)
- [x] Missing file → wrapped `ErrNotFound`

---

## T-2PJ-06: Project Service — Use Cases Mới {#t-2pj-06}

**Estimate**: 2 ngày | **Assignee**: Dev 1 | **Depends on**: T-2PJ-02, T-2PJ-03, T-2PJ-04, T-2PJ-05

### Bước thực hiện

```
[x] 1. Tạo internal/usecase/interactor/conversation_interactor.go (Conversation + Message)
[x] 2. Tạo internal/usecase/interactor/run_file_interactor.go (Run + File)
[x] 3. ConversationInteractor: CreateConversation, ListConversations, DeleteConversation
[x] 4. MessageInteractor: AddMessage, ListMessages
[x] 5. RunInteractor: CreateRun (status=pending), GetRun, UpdateRunStatus, ListRunsByProject
[x] 6. FileInteractor: ListFiles, ReadFile, WriteFile, DeleteFile
[ ] 7. Unit tests cho mỗi interactor (mock repos)
```

### Acceptance Criteria
- [x] Tất cả use cases compile và test pass
- [x] `CreateConversation` trả về Conversation với ID generated
- [x] `CreateRun` gọi đúng repo + trả về Run với status "pending"

---

## T-2PJ-07: Project Service — Proto Extensions + Migrations {#t-2pj-07}

**Estimate**: 1.5 ngày | **Assignee**: Dev 1 | **Depends on**: T-2PJ-06

### Bước thực hiện

```
[ ] 1. Mở rộng api/proto/project/v1/project.proto — thêm RPCs:
        rpc CreateConversation, ListConversations, AddMessage, ListMessages
        rpc CreateRun, GetRun, UpdateRunStatus
        rpc ListFiles, ReadFile, GetLiveArtifact
[ ] 2. Chạy buf generate
[ ] 3. Implement grpc handler cho các RPCs mới
[ ] 4. Verify migration thứ tự đúng (010, 011, 012)
[ ] 5. E2E test: Gateway → Project Service gRPC
```

### Acceptance Criteria
- [ ] `buf lint` pass
- [ ] Generated code compile không lỗi
- [ ] gRPC handler trả về đúng response cho mỗi RPC
- [ ] Migrations up không lỗi

---

## T-2AG-01: Agent Service — Domain Model (Run, Event, AgentInfo) {#t-2ag-01}

**Estimate**: 1 ngày | **Assignee**: Dev 2 | **Depends on**: T-1IN-01

### Bước thực hiện

```
[x] 1. Tạo internal/domain/agent_domain.go:
        - RunStatus, RunMode enums
        - IsTerminal(), CanCancel() methods
        - RunEvent với EventType (text|tool_use|tool_result|thinking|done|error)
        - AgentInfo struct
        - RunRepository + EventStore interfaces
[ ] 2. Unit tests: state machine transitions (RunStatus)
```

### Acceptance Criteria
- [x] `IsTerminal()` trả về true cho Completed/Failed/Cancelled
- [x] `CanCancel()` trả về true chỉ khi Pending/Running
- [x] EventType constants đầy đủ

---

## T-2AG-02: Agent Service — Redis Event Store {#t-2ag-02}

**Estimate**: 2 ngày | **Assignee**: Dev 2 | **Depends on**: T-2AG-01

### Bước thực hiện

```
[x] 1. Tạo internal/infra/db/event_store.go (RedisEventStore):
        - Append: XADD run_events:{runID} MAXLEN ~ 10000
        - EXPIRE key 24h sau mỗi Append
[x] 2. Implement GetSince(runID, lastEventID) — XRANGE từ lastID
[x] 3. Implement Subscribe(runID) — XREAD BLOCK goroutine loop
        - Stop khi nhận done/error event
        - Backoff 200ms khi transient error
[ ] 4. Viết unit tests (dùng miniredis)
[ ] 5. Viết benchmark: Append throughput
```

### Acceptance Criteria
- [x] `Append` + `GetSince("")` roundtrip đúng thứ tự
- [x] `Subscribe` nhận events real-time
- [x] TTL được set sau mỗi Append
- [ ] `go test -race` pass

---

## T-2AG-03: Agent Service — CLI Spawner {#t-2ag-03}

**Estimate**: 2 ngày | **Assignee**: Dev 2 | **Depends on**: T-2AG-01, T-2AG-02

### Bước thực hiện

```
[x] 1. Tạo internal/infra/cli/spawner.go:
        - CLISpawner với semaphore concurrency control
        - Spawn: acquire sem → exec.CommandContext → pipe stdout/stderr → parse events
        - Cancel: SIGTERM → 5s timeout → SIGKILL
[x] 2. CLIOutputAdapter interface trong spawner.go
[x] 3. textLineAdapter fallback cho unknown agents
[ ] 4. Unit tests: mock exec.Cmd, verify events emitted
[ ] 5. Integration test: real shell script "echo hello; exit 0"
```

### Acceptance Criteria
- [x] Spawn process và stream output thành RunEvents
- [x] Process exit → update status "completed"/"failed"/"cancelled"
- [x] Cancel → SIGTERM → SIGKILL fallback
- [x] Max concurrent runs enforced (semaphore)

---

## T-2AG-04: Agent Service — Claude Code Output Adapter {#t-2ag-04}

**Estimate**: 1 ngày | **Assignee**: Dev 2 | **Depends on**: T-2AG-03

### Bước thực hiện

```
[x] 1. Tạo internal/infra/cli/adapters.go:
        - ClaudeAdapter: parse NDJSON (content_block_delta, tool_use, tool_result, thinking, message_stop)
        - CodexAdapter: parse SSE stream (choices[].delta.content)
        - mustMarshal helper
[ ] 2. Unit tests với sample Claude output (golden files trong testdata/)
```

### Acceptance Criteria
- [x] `ParseLine` với Claude NDJSON → correct RunEvent type
- [x] Unknown line format → logged + skipped (không crash)
- [x] CodexAdapter xử lý SSE "data: [DONE]"

---

## T-2AG-05: Agent Service — BYOK API Providers {#t-2ag-05}

**Estimate**: 1.5 ngày | **Assignee**: Dev 2 | **Depends on**: T-2AG-01

### Bước thực hiện

```
[x] 1. Tạo internal/infra/api/providers.go:
        - APIProvider interface (StreamChat, Name)
        - AnthropicProvider: POST /v1/messages, parse SSE
        - OpenAIProvider: POST /v1/chat/completions, parse SSE
        - ProviderRegistry: Get(name) APIProvider
[ ] 2. Unit tests với httptest.Server mock
[ ] 3. Thêm Google Gemini và Ollama providers (Sprint 3)
```

### Acceptance Criteria
- [x] Anthropic streaming: nhận chunks, convert đúng sang RunEvent
- [x] OpenAI streaming: tương tự
- [x] Provider not found → clear error message

---

## T-2AG-06: Agent Service — Use Cases + HTTP Handler {#t-2ag-06}

**Estimate**: 1.5 ngày | **Assignee**: Dev 2 | **Depends on**: T-2AG-02, T-2AG-03, T-2AG-05

### Bước thực hiện

```
[x] 1. Tạo internal/usecase/agent_usecases.go:
        - RunUseCase: CreateRun, GetRun, CancelRun
        - StreamUseCase: StreamRunEvents, GetSince
[x] 2. Tạo internal/adapter/controller/http/agent_sse_handler.go:
        - POST /api/v1/agent/runs → CreateRun
        - GET  /api/v1/agent/runs/:id → GetRun
        - DEL  /api/v1/agent/runs/:id → CancelRun
        - GET  /api/v1/agent/runs/:id/events → SSE stream
        - GET  /api/v1/agent/runs/:id/events/poll → polling
        - GET  /api/v1/agents → ListAgents
[ ] 3. Wire up trong cmd/main.go
[ ] 4. E2E test: create run + stream events
```

### Acceptance Criteria
- [x] `CreateRun` tạo record + trả về Run{status: pending}
- [x] `StreamRunEvents` SSE stream với X-Accel-Buffering: no
- [x] `CancelRun` cập nhật status
- [x] `ListAgents` trả về list agents với availability

---

## T-2AG-07: Agent Service — Agent Probe {#t-2ag-07}

**Estimate**: 0.5 ngày | **Assignee**: Dev 2 | **Depends on**: T-2AG-06

### Bước thực hiện

```
[x] 1. AgentProbeUseCase trong agent_usecases.go:
        - probe() dùng exec.LookPath cho claude/codex/gemini
        - getVersion() gọi --version
        - Cache 60s (sync.RWMutex)
[x] 2. BYOK agents luôn available=true
[ ] 3. Unit test với mock exec
```

### Acceptance Criteria
- [x] `ListAgents` trả về list đúng
- [x] `available=false` khi binary không tìm thấy
- [x] BYOK agents luôn `available=true`

---

## T-2MC-01: MCP Service — Di chuyển apps/ → services/ {#t-2mc-01}

**Estimate**: 1 ngày | **Assignee**: Dev 3 | **Depends on**: T-1IN-01

### Bước thực hiện

```
[x] 1. Copy apps/preview-mcp/ → services/mcp-service/
[x] 2. Cập nhật go.mod: module github.com/binhnt/ba-agent-preview/services/mcp-service
[x] 3. Update tất cả import paths (0 còn lại)
[x] 4. Thêm mcp-service vào go.work (uncommented)
[x] 5. `go build ./...` — compile thành công
[ ] 6. `go test ./...` — verify all existing tests pass
[ ] 7. Update docker-compose: đổi build context
[ ] 8. Xóa apps/preview-mcp/ hoặc add deprecation notice
```

### Acceptance Criteria
- [x] `go build` thành công từ services/mcp-service/
- [x] Tất cả import paths đã update
- [ ] Docker image build thành công

---

## T-2MC-02: MCP Service — Thêm gRPC Clients {#t-2mc-02}

**Estimate**: 1 ngày | **Assignee**: Dev 3 | **Depends on**: T-2MC-01

### Bước thực hiện

```
[x] 1. Tạo client/od_clients.go:
        - ODServiceClients (HTTP-first, với gRPC stubs)
        - ProjectGRPCClientConn — dial + Close
        - AgentGRPCClientConn — dial + Close
[x] 2. HTTP helpers (doGet) cho OD service calls
[ ] 3. Update server/config.go — thêm OD service address fields
[ ] 4. Graceful handle upstream UNAVAILABLE
```

### Acceptance Criteria
- [x] Clients init thành công
- [x] Service start bình thường kể cả khi upstream unavailable
- [x] gRPC dial non-blocking (WithBlock không được set)

---

## T-2MC-03: MCP Service — Open Design Tools (10 tools) {#t-2mc-03}

**Estimate**: 3 ngày | **Assignee**: Dev 3 | **Depends on**: T-2MC-02

### Bước thực hiện

```
[x] 1. Tạo tools/open_design.go với RegisterOpenDesignTools()
[x] 2. get_active_context — đọc từ activecontext.GetActiveContext()
[x] 3. create_project — POST /api/v1/projects
[x] 4. list_projects — GET /api/v1/projects
[x] 5. get_project_files — GET /api/v1/od/projects/:id/files
[x] 6. read_file — GET /api/v1/od/projects/:id/files/read (truncate 50KB)
[x] 7. run_design_skill — POST /api/v1/agent/runs
[x] 8. get_live_artifact — GET /api/v1/od/artifacts/:id
[x] 9. list_agents — GET /api/v1/agents
[x] 10. list_design_systems — stub (Sprint 3)
[x] 11. list_skills — stub (Sprint 3)
[ ] 12. Update tools/register.go để gọi RegisterOpenDesignTools
[ ] 13. Manual test tất cả 10 tools
```

### Acceptance Criteria
- [x] Mỗi tool trả về kết quả đúng định dạng MCP
- [x] `get_active_context` trả về context hiện tại
- [x] `read_file` truncate nếu file quá lớn (50KB)
- [x] Tools hoạt động kể cả khi upstream unavailable (graceful error)

---

## T-2MC-04: MCP Service — Active Context Store {#t-2mc-04}

**Estimate**: 0.5 ngày | **Assignee**: Dev 3 | **Depends on**: T-2MC-01

### Bước thực hiện

```
[x] 1. Tạo activecontext/active_context.go:
        - ActiveContextStore với sync.RWMutex
        - Set/Get/Clear methods
        - globalActiveContext singleton
        - GetActiveContext() / SetActiveContext() public API
[ ] 2. Expose HTTP endpoint: POST /api/v1/mcp/active-context
[ ] 3. Gateway route: POST /api/active → mcp-service
[ ] 4. Unit test Set/Get/Clear
```

### Acceptance Criteria
- [x] Set context → Get trả về giá trị đúng
- [x] Concurrent Set/Get thread-safe (RWMutex)
- [ ] Frontend POST → context được update

---

## 📊 Sprint 2 Progress Summary

| Task | Status | Build | Notes |
|------|--------|-------|-------|
| T-2PJ-01 | ✅ Done | ✅ | Entities: Conversation, Message, Run, LiveArtifact, ProjectFile |
| T-2PJ-02 | ✅ Done | ✅ | ConversationRepo + MessageRepo + migration |
| T-2PJ-03 | ✅ Done | ✅ | RunRepo + migration |
| T-2PJ-04 | ✅ Done | ✅ | LiveArtifactRepo + migration |
| T-2PJ-05 | ✅ Done | ✅ | LocalFileStore + path traversal protection |
| T-2PJ-06 | ✅ Done | ✅ | Conversation, Message, Run, File interactors |
| T-2PJ-07 | 🔲 Pending | — | Proto generation + gRPC handler (next) |
| T-2AG-01 | ✅ Done | ✅ | Domain model: Run, Event, AgentInfo, repos |
| T-2AG-02 | ✅ Done | ✅ | Redis Streams event store |
| T-2AG-03 | ✅ Done | ✅ | CLI Spawner + SIGTERM/SIGKILL cancel |
| T-2AG-04 | ✅ Done | ✅ | ClaudeAdapter + CodexAdapter |
| T-2AG-05 | ✅ Done | ✅ | Anthropic + OpenAI streaming providers |
| T-2AG-06 | ✅ Done | ✅ | RunUseCase + StreamUseCase + SSE handler |
| T-2AG-07 | ✅ Done | ✅ | AgentProbeUseCase (cache 60s) |
| T-2MC-01 | ✅ Done | ✅ | apps/preview-mcp → services/mcp-service |
| T-2MC-02 | ✅ Done | ✅ | OD service gRPC client stubs |
| T-2MC-03 | ✅ Done | ✅ | 10 Open Design MCP tools |
| T-2MC-04 | ✅ Done | ✅ | activecontext package (thread-safe) |

**Sprint 2 Core**: **17/18 tasks complete** (T-2PJ-07 proto generation pending)
