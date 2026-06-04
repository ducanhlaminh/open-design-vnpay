# 02 — Project Service

> **Port gRPC**: 8081  
> **Domain**: Projects, Conversations, Messages, Runs, Files, Artifacts

---

## 1. Bounded Context

Project Service sở hữu toàn bộ dữ liệu liên quan đến **workspace của người dùng**:

| Entity | Mô tả |
|--------|-------|
| `Project` | Một design project (có tên, loại, metadata) |
| `Conversation` | Một cuộc hội thoại trong project |
| `Message` | Một tin nhắn trong conversation (user/assistant) |
| `Run` | Một lần chạy AI agent (liên kết với conversation) |
| `ProjectFile` | File trong project directory |
| `LiveArtifact` | Artifact động (data-driven, có thể refresh) |

---

## 2. Cấu trúc thư mục (Clean Architecture)

```
project-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── project.go            # Project entity + domain events
│   │   ├── conversation.go       # Conversation entity
│   │   ├── message.go            # Message entity
│   │   ├── run.go                # Run entity + status machine
│   │   ├── live_artifact.go      # LiveArtifact entity
│   │   └── repository.go         # Repository interfaces (ports)
│   │
│   ├── usecase/
│   │   ├── project_usecase.go    # CreateProject, GetProject, ListProjects, DeleteProject
│   │   ├── conversation_usecase.go
│   │   ├── message_usecase.go
│   │   ├── run_usecase.go        # CreateRun, UpdateRunStatus, GetRun
│   │   ├── file_usecase.go       # ListFiles, ReadFile, ServeArtifact
│   │   └── live_artifact_usecase.go
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── postgres.go       # PostgreSQL connection + migrations
│   │   │   ├── sqlite.go         # SQLite connection (local mode)
│   │   │   ├── project_repo.go   # implements domain.ProjectRepository
│   │   │   ├── conversation_repo.go
│   │   │   ├── message_repo.go
│   │   │   ├── run_repo.go
│   │   │   └── live_artifact_repo.go
│   │   └── fs/
│   │       └── file_store.go     # Local filesystem adapter
│   │
│   └── delivery/
│       ├── grpc/
│       │   └── handler.go        # gRPC server implementation
│       └── http/
│           └── health.go         # /health endpoint
│
├── proto/
│   └── project/v1/project.proto
└── Dockerfile
```

---

## 3. Domain Model

```go
// domain/project.go
type Project struct {
    ID        string
    Name      string
    Kind      ProjectKind       // "web-ui" | "image" | "video" | "audio"
    Metadata  map[string]any    // JSONB
    CreatedAt time.Time
    UpdatedAt time.Time
}

type ProjectKind string
const (
    ProjectKindWebUI ProjectKind = "web-ui"
    ProjectKindImage ProjectKind = "image"
    ProjectKindVideo ProjectKind = "video"
    ProjectKindAudio ProjectKind = "audio"
)

// domain/run.go
type Run struct {
    ID             string
    ProjectID      string
    ConversationID string
    AgentID        string
    Status         RunStatus
    ExitCode       *int
    Signal         *string
    StartedAt      time.Time
    FinishedAt     *time.Time
}

type RunStatus string
const (
    RunStatusPending   RunStatus = "pending"
    RunStatusRunning   RunStatus = "running"
    RunStatusCompleted RunStatus = "completed"
    RunStatusFailed    RunStatus = "failed"
    RunStatusCancelled RunStatus = "cancelled"
)

// domain/repository.go
type ProjectRepository interface {
    Create(ctx context.Context, p *Project) error
    GetByID(ctx context.Context, id string) (*Project, error)
    List(ctx context.Context, filter ProjectFilter) ([]*Project, error)
    Update(ctx context.Context, p *Project) error
    Delete(ctx context.Context, id string) error
}

type RunRepository interface {
    Create(ctx context.Context, r *Run) error
    GetByID(ctx context.Context, id string) (*Run, error)
    UpdateStatus(ctx context.Context, id string, status RunStatus, exitCode *int) error
}
```

---

## 4. Use Cases

```go
// usecase/project_usecase.go
type ProjectUseCase struct {
    projectRepo ProjectRepository
    convRepo    ConversationRepository
    fileStore   FileStore
    eventBus    EventBus  // publish domain events
}

func (uc *ProjectUseCase) CreateProject(ctx context.Context, req CreateProjectRequest) (*Project, error) {
    // 1. Validate input
    // 2. Create project entity
    // 3. Create project directory on filesystem
    // 4. Persist to repo
    // 5. Publish ProjectCreated event
    // 6. Return
}

func (uc *ProjectUseCase) ListProjects(ctx context.Context) ([]*Project, error) {
    // 1. Fetch from repo
    // 2. Enrich with file counts (from FileStore)
    // 3. Return
}
```

---

## 5. gRPC Protocol Definition

```protobuf
// proto/project/v1/project.proto
syntax = "proto3";
package project.v1;

service ProjectService {
    rpc CreateProject(CreateProjectRequest) returns (Project);
    rpc GetProject(GetProjectRequest) returns (Project);
    rpc ListProjects(ListProjectsRequest) returns (ListProjectsResponse);
    rpc UpdateProject(UpdateProjectRequest) returns (Project);
    rpc DeleteProject(DeleteProjectRequest) returns (google.protobuf.Empty);

    rpc CreateConversation(CreateConversationRequest) returns (Conversation);
    rpc GetConversation(GetConversationRequest) returns (Conversation);
    rpc ListConversations(ListConversationsRequest) returns (ListConversationsResponse);

    rpc AddMessage(AddMessageRequest) returns (Message);
    rpc ListMessages(ListMessagesRequest) returns (ListMessagesResponse);

    rpc CreateRun(CreateRunRequest) returns (Run);
    rpc GetRun(GetRunRequest) returns (Run);
    rpc UpdateRunStatus(UpdateRunStatusRequest) returns (Run);

    rpc ListFiles(ListFilesRequest) returns (ListFilesResponse);
    rpc ReadFile(ReadFileRequest) returns (ReadFileResponse);

    rpc GetLiveArtifact(GetLiveArtifactRequest) returns (LiveArtifact);
    rpc CreateLiveArtifact(CreateLiveArtifactRequest) returns (LiveArtifact);
}

message Project {
    string id = 1;
    string name = 2;
    string kind = 3;
    google.protobuf.Struct metadata = 4;
    google.protobuf.Timestamp created_at = 5;
    google.protobuf.Timestamp updated_at = 6;
}

message Run {
    string id = 1;
    string project_id = 2;
    string conversation_id = 3;
    string agent_id = 4;
    string status = 5;
    optional int32 exit_code = 6;
    optional string signal = 7;
    google.protobuf.Timestamp started_at = 8;
    optional google.protobuf.Timestamp finished_at = 9;
}
```

---

## 6. Database Schema (PostgreSQL)

```sql
-- Identical schema to current SQLite, migrated to PostgreSQL
CREATE TABLE projects (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'web-ui',
    metadata    JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversations (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE messages (
    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,      -- 'user' | 'assistant'
    content         TEXT,
    agent_id        TEXT,
    events_json     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE runs (
    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES conversations(id),
    agent_id        TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    exit_code       INTEGER,
    signal          TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ
);

CREATE TABLE live_artifacts (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    slug        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    source_data JSONB,
    preview     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_conversations_project_id ON conversations(project_id);
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_runs_project_id ON runs(project_id);
CREATE INDEX idx_runs_status ON runs(status);
```

---

## 7. File Serving

Project Service serves project files trực tiếp qua gRPC streaming (cho Gateway proxy):

```go
// Artifacts: /artifacts/{project_id}/{path}
// Frames:    /frames/{project_id}/{path}
func (h *GRPCHandler) ServeArtifact(req *ServeArtifactRequest, stream ProjectService_ServeArtifactServer) error {
    filePath := filepath.Join(h.workspaceRoot, req.ProjectId, req.Path)
    f, err := os.Open(filePath)
    // stream file chunks back
}
```

---

## 8. Domain Events Published

| Event | Payload | Consumers |
|-------|---------|-----------|
| `project.created` | ProjectID, name, kind | Telemetry |
| `project.deleted` | ProjectID | Telemetry, Memory (cleanup) |
| `run.created` | RunID, projectID, agentID | Telemetry |
| `run.completed` | RunID, exitCode, duration | Telemetry |
| `run.failed` | RunID, error | Telemetry |
