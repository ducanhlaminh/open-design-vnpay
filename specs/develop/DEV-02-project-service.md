# DEV-02 — Project Service: Nâng cấp `preview-project`

> **Chiến lược**: ✅ **Nâng cấp** codebase hiện có  
> **Nguồn**: `services/preview-project/`  
> **Spec tham chiếu**: `specs/services/02-project-service.md`

---

## 1. Phân tích Codebase Hiện có

### 1.1 Domain Entities đã có

| Entity | File | Trạng thái |
|--------|------|-----------|
| `Project` / `ProjectRecord` | `entity/project.go` | ✅ Dùng lại (bổ sung `Kind` field) |
| `Journey` | `entity/journey.go` | ✅ Giữ nguyên |
| `Screen` | `entity/screen.go` | ✅ Giữ nguyên |
| `Member` | `entity/member.go` | ✅ Giữ nguyên |
| `Export` | `entity/export.go` | ✅ Giữ nguyên |

**Thiếu so với kiến trúc mới:**

| Entity | Trạng thái | Ghi chú |
|--------|-----------|---------|
| `Conversation` | ❌ Thiếu | Cần thêm — chat conversations |
| `Message` | ❌ Thiếu | Cần thêm — chat messages |
| `Run` | ❌ Thiếu | Cần thêm — AI agent run records |
| `LiveArtifact` | ❌ Thiếu | Cần thêm — dynamic artifacts |
| `ProjectFile` | ❌ Thiếu | Cần thêm — file listing |

### 1.2 Use Cases đã có

```
internal/usecase/interactor/
├── project_interactor.go      ← CreateProject, GetProject, ListProjects, DeleteProject
├── journey_interactor.go      ← Journey CRUD
├── screen_interactor.go       ← Screen CRUD  
└── member_interactor.go       ← Member management
```

### 1.3 Infra đã có

```
internal/infra/
├── postgres/                  ← PostgreSQL repository implementations
└── ...
```

### 1.4 API/Proto đã có

```
api/proto/                     ← Protobuf definitions (buf + grpc)
```

---

## 2. Những gì cần THÊM / THAY ĐỔI

### 2.1 Domain Layer — Entities mới

```go
// THÊM: internal/domain/entity/conversation.go
type Conversation struct {
    ID        string
    ProjectID string
    Title     string
    CreatedAt time.Time
}

// THÊM: internal/domain/entity/message.go
type Message struct {
    ID             string
    ConversationID string
    Role           string        // "user" | "assistant"
    Content        string
    AgentID        string
    EventsJSON     []byte        // raw SSE events snapshot
    CreatedAt      time.Time
}

// THÊM: internal/domain/entity/run.go
type Run struct {
    ID             string
    ProjectID      string
    ConversationID string
    AgentID        string
    Status         RunStatus     // "pending"|"running"|"completed"|"failed"|"cancelled"
    ExitCode       *int
    Signal         *string
    StartedAt      time.Time
    FinishedAt     *time.Time
}

// THÊM: internal/domain/entity/live_artifact.go
type LiveArtifact struct {
    ID         string
    ProjectID  string
    Title      string
    Slug       string
    Status     string
    SourceData map[string]any
    Preview    string
    CreatedAt  time.Time
}
```

### 2.2 Mở rộng `project.go` entity

```go
// THAY ĐỔI: Thêm Kind field vào ProjectRecord
type ProjectRecord struct {
    ID          string      // đã có
    Name        string      // đã có
    OwnerID     string      // đã có
    Description string      // đã có
    ScreenCount int         // đã có
    // THÊM MỚI:
    Kind        ProjectKind // "web-ui" | "image" | "video" | "audio"
    Metadata    map[string]any
    KGSAppID    string      // đã có (giữ)
    KGSApiKeyEnc string     // đã có (giữ)
    KGSKeyHash  string      // đã có (giữ)
    CreatedAt   time.Time   // đã có
    UpdatedAt   time.Time   // đã có
}
```

### 2.3 Use Cases mới

```
internal/usecase/interactor/
├── project_interactor.go         ← đã có, bổ sung GetProjectFiles
├── conversation_interactor.go    ← THÊM MỚI
├── message_interactor.go         ← THÊM MỚI
├── run_interactor.go             ← THÊM MỚI
└── live_artifact_interactor.go   ← THÊM MỚI
```

### 2.4 Repository Ports mới

```go
// THÊM: internal/usecase/port/conversation_repository.go
type ConversationRepository interface {
    Create(ctx context.Context, c *entity.Conversation) error
    GetByID(ctx context.Context, id string) (*entity.Conversation, error)
    ListByProject(ctx context.Context, projectID string) ([]*entity.Conversation, error)
    Delete(ctx context.Context, id string) error
}

// THÊM: internal/usecase/port/run_repository.go
type RunRepository interface {
    Create(ctx context.Context, r *entity.Run) error
    GetByID(ctx context.Context, id string) (*entity.Run, error)
    UpdateStatus(ctx context.Context, id string, status entity.RunStatus, exitCode *int, signal *string) error
    ListByProject(ctx context.Context, projectID string, limit int) ([]*entity.Run, error)
}
```

### 2.5 Infrastructure — Postgres Repositories mới

```
internal/infra/postgres/
├── project_repo.go              ← đã có
├── journey_repo.go              ← đã có
├── screen_repo.go               ← đã có
├── member_repo.go               ← đã có
├── conversation_repo.go         ← THÊM MỚI
├── message_repo.go              ← THÊM MỚI
├── run_repo.go                  ← THÊM MỚI
└── live_artifact_repo.go        ← THÊM MỚI
```

### 2.6 File Store (mới)

```go
// THÊM: internal/infra/fs/file_store.go
type LocalFileStore struct {
    workspaceRoot string // OD_WORKSPACE_ROOT
}

func (s *LocalFileStore) ListProjectFiles(ctx context.Context, projectID string) ([]*entity.ProjectFile, error) {
    // Walk workspace/{projectID}/ directory
}

func (s *LocalFileStore) ReadFile(ctx context.Context, projectID, path string) ([]byte, string, error) {
    // Read file + detect MIME type
}

func (s *LocalFileStore) ServeArtifact(ctx context.Context, projectID, path string) (io.Reader, string, error) {
    // Stream file for serving via gRPC
}
```

### 2.7 Proto Extensions

Thêm vào `api/proto/project/v1/project.proto`:

```protobuf
// THÊM các RPCs:
rpc CreateConversation(CreateConversationRequest) returns (Conversation);
rpc ListConversations(ListConversationsRequest) returns (ListConversationsResponse);
rpc AddMessage(AddMessageRequest) returns (Message);
rpc ListMessages(ListMessagesRequest) returns (ListMessagesResponse);
rpc CreateRun(CreateRunRequest) returns (Run);
rpc GetRun(GetRunRequest) returns (Run);
rpc UpdateRunStatus(UpdateRunStatusRequest) returns (Run);
rpc ListFiles(ListFilesRequest) returns (ListFilesResponse);
rpc ReadFile(ReadFileRequest) returns (stream FileChunk);
rpc GetLiveArtifact(GetLiveArtifactRequest) returns (LiveArtifact);
rpc CreateLiveArtifact(CreateLiveArtifactRequest) returns (LiveArtifact);
```

---

## 3. Database Migrations

```sql
-- Migration: add_kind_to_projects.sql
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'web-ui';
ALTER TABLE projects ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}';

-- Migration: create_conversations.sql
CREATE TABLE conversations (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration: create_messages.sql
CREATE TABLE messages (
    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT,
    agent_id        TEXT,
    events_json     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration: create_runs.sql
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

-- Migration: create_live_artifacts.sql
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
```

---

## 4. Giữ Nguyên (Không Chạm)

- ✅ Toàn bộ Journey logic
- ✅ Toàn bộ Screen logic (schema, states, render-spec)
- ✅ Member/RBAC logic
- ✅ KGS integration (`KGSAppID`, `KGSApiKeyEnc`)
- ✅ Export logic
- ✅ gRPC server setup
- ✅ Database connection + migration runner

---

## 5. Acceptance Criteria

- [x] `CreateConversation` / `ListConversations` hoạt động qua gRPC
- [x] `CreateRun` / `UpdateRunStatus` hoạt động qua gRPC
- [x] `ListFiles` trả về file tree của project workspace
- [x] `ReadFile` stream file content qua gRPC
- [x] `ProjectRecord.Kind` được lưu và truy vấn đúng
- [x] Migration chạy không break dữ liệu hiện có
- [x] Tất cả API endpoints hiện tại vẫn hoạt động

---

## 6. Effort Estimate

| Task | Estimate |
|------|---------|
| Domain entities (4 entities) | 1 ngày |
| Use case interactors (4) | 2 ngày |
| Postgres repositories (4) | 2 ngày |
| File store adapter | 1.5 ngày |
| Proto extensions + codegen | 1 ngày |
| Database migrations | 0.5 ngày |
| Tests | 2 ngày |
| **Tổng** | **10 ngày** |
