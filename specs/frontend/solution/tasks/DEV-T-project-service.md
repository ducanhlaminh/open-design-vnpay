# DEV-T-02 — Project Service Implementation Tasks

> **Service**: `services/preview-project` → Nâng cấp  
> **Effort**: 10 ngày  
> **Sprint**: Sprint 2 (Tuần 3–5)  
> **Ref**: [DEV-02-project-service.md](../../develop/DEV-02-project-service.md)

---

## Nguyên tắc

> ✅ **GIỮ NGUYÊN**: Journey, Screen, Member, Export logic, KGS integration  
> ❌ **KHÔNG CHẠM**: `journey_interactor.go`, `screen_interactor.go`, `member_interactor.go`  
> ✅ **THÊM MỚI**: Conversation, Message, Run, LiveArtifact, FileStore

---

## Nhóm A — Domain Entities Mới (Ngày 1)

---

### A01 — Entity `Conversation`

**File**: `services/preview-project/internal/domain/entity/conversation.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
package entity

import "time"

type Conversation struct {
    ID        string
    ProjectID string
    Title     string
    CreatedAt time.Time
}
```

---

### A02 — Entity `Message`

**File**: `services/preview-project/internal/domain/entity/message.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
package entity

import "time"

type Message struct {
    ID             string
    ConversationID string
    Role           string    // "user" | "assistant"
    Content        string
    AgentID        string
    EventsJSON     []byte    // raw SSE events snapshot
    CreatedAt      time.Time
}
```

---

### A03 — Entity `Run`

**File**: `services/preview-project/internal/domain/entity/run.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
package entity

import "time"

type RunStatus string
const (
    RunStatusPending   RunStatus = "pending"
    RunStatusRunning   RunStatus = "running"
    RunStatusCompleted RunStatus = "completed"
    RunStatusFailed    RunStatus = "failed"
    RunStatusCancelled RunStatus = "cancelled"
)

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
```

---

### A04 — Entity `LiveArtifact`

**File**: `services/preview-project/internal/domain/entity/live_artifact.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
package entity

import "time"

type LiveArtifact struct {
    ID         string
    ProjectID  string
    Title      string
    Slug       string
    Status     string          // "active" | "processing" | "error"
    SourceData map[string]any
    Preview    string
    CreatedAt  time.Time
}
```

---

### A05 — Entity `ProjectFile` + Bổ sung `ProjectRecord`

**File**: `services/preview-project/internal/domain/entity/project.go` (MODIFY)  
**File**: `services/preview-project/internal/domain/entity/project_file.go` (NEW)  
**Effort**: 2h  
**Status**: `[ ]`

**Thêm vào `ProjectRecord`**:
```go
type ProjectKind string
const (
    ProjectKindWebUI ProjectKind = "web-ui"
    ProjectKindImage ProjectKind = "image"
    ProjectKindVideo ProjectKind = "video"
    ProjectKindAudio ProjectKind = "audio"
)

// Thêm fields vào struct hiện có:
type ProjectRecord struct {
    // ... existing fields ...
    Kind     ProjectKind    // THÊM MỚI
    Metadata map[string]any // THÊM MỚI
}
```

**File mới**:
```go
// entity/project_file.go
type ProjectFile struct {
    Path     string
    Kind     string // "file" | "directory"
    Size     int64
    Modified time.Time
    MimeType string
}
```

---

## Nhóm B — Repository Interfaces (Ngày 1–2)

---

### B01 — `ConversationRepository` interface

**File**: `services/preview-project/internal/usecase/port/conversation_repository.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
package port

import (
    "context"
    "github.com/.../entity"
)

type ConversationRepository interface {
    Create(ctx context.Context, c *entity.Conversation) error
    GetByID(ctx context.Context, id string) (*entity.Conversation, error)
    ListByProject(ctx context.Context, projectID string) ([]*entity.Conversation, error)
    Delete(ctx context.Context, id string) error
}

type MessageRepository interface {
    Create(ctx context.Context, m *entity.Message) error
    GetByID(ctx context.Context, id string) (*entity.Message, error)
    ListByConversation(ctx context.Context, conversationID string) ([]*entity.Message, error)
    Update(ctx context.Context, m *entity.Message) error
}
```

---

### B02 — `RunRepository` interface

**File**: `services/preview-project/internal/usecase/port/run_repository.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
type RunRepository interface {
    Create(ctx context.Context, r *entity.Run) error
    GetByID(ctx context.Context, id string) (*entity.Run, error)
    UpdateStatus(ctx context.Context, id string, status entity.RunStatus, exitCode *int, signal *string) error
    ListByProject(ctx context.Context, projectID string, limit int) ([]*entity.Run, error)
}

type LiveArtifactRepository interface {
    Create(ctx context.Context, a *entity.LiveArtifact) error
    GetByID(ctx context.Context, id string) (*entity.LiveArtifact, error)
    ListByProject(ctx context.Context, projectID string) ([]*entity.LiveArtifact, error)
    Update(ctx context.Context, a *entity.LiveArtifact) error
}

type FileStore interface {
    ListProjectFiles(ctx context.Context, projectID string) ([]*entity.ProjectFile, error)
    ReadFile(ctx context.Context, projectID, path string) ([]byte, string, error) // content, mimeType
    ServeFile(ctx context.Context, projectPath string) (*os.File, error)
    CreateProjectDir(ctx context.Context, projectID string) (string, error)
    DeleteProjectDir(ctx context.Context, projectID string) error
}
```

---

## Nhóm C — Use Case Interactors Mới (Ngày 2–4)

---

### C01 — `ConversationInteractor`

**File**: `services/preview-project/internal/usecase/interactor/conversation_interactor.go`  
**Effort**: 1 ngày  
**Status**: `[ ]`

```go
type ConversationInteractor struct {
    convRepo    port.ConversationRepository
    messageRepo port.MessageRepository
}

// Methods:
func (i *ConversationInteractor) CreateConversation(ctx, projectID, title string) (*entity.Conversation, error)
func (i *ConversationInteractor) ListConversations(ctx, projectID string) ([]*entity.Conversation, error)
func (i *ConversationInteractor) GetConversation(ctx, id string) (*entity.Conversation, error)
func (i *ConversationInteractor) AddMessage(ctx, req *AddMessageRequest) (*entity.Message, error)
func (i *ConversationInteractor) ListMessages(ctx, conversationID string) ([]*entity.Message, error)
func (i *ConversationInteractor) UpdateMessage(ctx, id string, eventsJSON []byte) (*entity.Message, error)
```

**Acceptance Criteria**:
- [ ] `CreateConversation` tạo conversation với ID unique (uuid)
- [ ] `AddMessage` validate role ("user" | "assistant")
- [ ] Không có SQL trực tiếp — chỉ gọi repository interfaces

---

### C02 — `RunInteractor`

**File**: `services/preview-project/internal/usecase/interactor/run_interactor.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```go
type RunInteractor struct {
    runRepo port.RunRepository
}

func (i *RunInteractor) CreateRun(ctx, req *CreateRunRequest) (*entity.Run, error)
func (i *RunInteractor) GetRun(ctx, id string) (*entity.Run, error)
func (i *RunInteractor) UpdateRunStatus(ctx, id string, status entity.RunStatus, exitCode *int, signal *string) (*entity.Run, error)
func (i *RunInteractor) ListRunsByProject(ctx, projectID string, limit int) ([]*entity.Run, error)
```

---

### C03 — `FileInteractor`

**File**: `services/preview-project/internal/usecase/interactor/file_interactor.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```go
type FileInteractor struct {
    fileStore   port.FileStore
    projectRepo port.ProjectRepository
}

func (i *FileInteractor) ListProjectFiles(ctx, projectID string) ([]*entity.ProjectFile, error)
func (i *FileInteractor) ReadProjectFile(ctx, projectID, path string) ([]byte, string, error)
func (i *FileInteractor) ServeArtifact(ctx, projectID, path string) (*os.File, error)
```

**Acceptance Criteria**:
- [ ] Path validation — không cho phép `../` traversal
- [ ] `ListProjectFiles` filter hidden directories (`.git`, `node_modules`, `.next`)

---

### C04 — Bổ sung `GetProjectFiles` vào `ProjectInteractor`

**File**: `services/preview-project/internal/usecase/interactor/project_interactor.go` (MODIFY)  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

**Thêm vào existing interactor**:
```go
// Thêm vào ProjectInteractor struct:
fileInteractor *FileInteractor

// Thêm method:
func (i *ProjectInteractor) GetProjectFiles(ctx, projectID string) ([]*entity.ProjectFile, error)
```

---

### C05 — `LiveArtifactInteractor`

**File**: `services/preview-project/internal/usecase/interactor/live_artifact_interactor.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```go
func (i *LiveArtifactInteractor) CreateLiveArtifact(ctx, req) (*entity.LiveArtifact, error)
func (i *LiveArtifactInteractor) GetLiveArtifact(ctx, id string) (*entity.LiveArtifact, error)
func (i *LiveArtifactInteractor) ListLiveArtifacts(ctx, projectID string) ([]*entity.LiveArtifact, error)
func (i *LiveArtifactInteractor) RefreshLiveArtifact(ctx, id string) (*entity.LiveArtifact, error)
```

---

## Nhóm D — Postgres Repositories Mới (Ngày 4–6)

---

### D01 — `conversation_repo.go`

**File**: `services/preview-project/internal/infra/postgres/conversation_repo.go`  
**Effort**: 1 ngày  
**Status**: `[ ]`

```go
type PostgresConversationRepository struct {
    db *gorm.DB
}

// Implements port.ConversationRepository
func (r *PostgresConversationRepository) Create(ctx, c *entity.Conversation) error
func (r *PostgresConversationRepository) GetByID(ctx, id string) (*entity.Conversation, error)
func (r *PostgresConversationRepository) ListByProject(ctx, projectID string) ([]*entity.Conversation, error)
func (r *PostgresConversationRepository) Delete(ctx, id string) error

// Internal DB model (không phải entity):
type conversationModel struct {
    ID        string    `gorm:"primarykey"`
    ProjectID string    `gorm:"not null;index"`
    Title     string
    CreatedAt time.Time
}
```

---

### D02 — `message_repo.go`

**File**: `services/preview-project/internal/infra/postgres/message_repo.go`  
**Effort**: 1 ngày  
**Status**: `[ ]`

```go
type messageModel struct {
    ID             string    `gorm:"primarykey"`
    ConversationID string    `gorm:"not null;index"`
    Role           string    `gorm:"not null"`
    Content        string    `gorm:"type:text"`
    AgentID        string
    EventsJSON     []byte    `gorm:"type:jsonb"`
    CreatedAt      time.Time
}
```

---

### D03 — `run_repo.go`

**File**: `services/preview-project/internal/infra/postgres/run_repo.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```go
type runModel struct {
    ID             string     `gorm:"primarykey"`
    ProjectID      string     `gorm:"not null;index"`
    ConversationID string
    AgentID        string
    Status         string     `gorm:"not null;default:'pending'"`
    ExitCode       *int
    Signal         *string
    StartedAt      time.Time
    FinishedAt     *time.Time
}
```

---

### D04 — `live_artifact_repo.go`

**File**: `services/preview-project/internal/infra/postgres/live_artifact_repo.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

---

## Nhóm E — File Store (Ngày 6–7.5)

---

### E01 — `LocalFileStore`

**File**: `services/preview-project/internal/infra/fs/file_store.go`  
**Effort**: 1.5 ngày  
**Status**: `[ ]`

```go
type LocalFileStore struct {
    workspaceRoot string // từ OD_WORKSPACE_ROOT env var
}

// ListProjectFiles: walk workspace/{projectID}/, return file tree
// - Filter: .git/, node_modules/, .next/ (hidden/build dirs)
// - Include: relative path, size, modified, mimeType
func (s *LocalFileStore) ListProjectFiles(ctx context.Context, projectID string) ([]*entity.ProjectFile, error)

// ReadFile: đọc file content, detect MIME type
// - Path validation: không cho phép ../
func (s *LocalFileStore) ReadFile(ctx context.Context, projectID, path string) ([]byte, string, error)

// ServeFile: trả về *os.File để stream
func (s *LocalFileStore) ServeFile(ctx context.Context, projectPath string) (*os.File, error)

// CreateProjectDir: tạo {workspaceRoot}/{projectID}/
func (s *LocalFileStore) CreateProjectDir(ctx context.Context, projectID string) (string, error)
```

**Security**:
- [ ] `filepath.Clean()` + check không bắt đầu bằng `..`
- [ ] `os.ReadFile` vs `io.ReadAll` — dùng streaming cho files lớn

---

## Nhóm F — Proto Extensions + DB Migrations (Ngày 7.5–8.5)

---

### F01 — Thêm RPCs vào `project.proto`

**File**: `services/preview-project/api/proto/project/v1/project.proto` (MODIFY)  
**Effort**: 1 ngày  
**Status**: `[ ]`

**Thêm vào service definition**:
```protobuf
// Conversation RPCs
rpc CreateConversation(CreateConversationRequest) returns (Conversation);
rpc ListConversations(ListConversationsRequest) returns (ListConversationsResponse);
rpc AddMessage(AddMessageRequest) returns (Message);
rpc ListMessages(ListMessagesRequest) returns (ListMessagesResponse);
rpc UpdateMessage(UpdateMessageRequest) returns (Message);

// Run RPCs
rpc CreateRun(CreateRunRequest) returns (Run);
rpc GetRun(GetRunRequest) returns (Run);
rpc UpdateRunStatus(UpdateRunStatusRequest) returns (Run);
rpc ListRuns(ListRunsRequest) returns (ListRunsResponse);

// File RPCs
rpc ListFiles(ListFilesRequest) returns (ListFilesResponse);
rpc ReadFile(ReadFileRequest) returns (stream FileChunk);

// Live Artifact RPCs
rpc CreateLiveArtifact(CreateLiveArtifactRequest) returns (LiveArtifact);
rpc GetLiveArtifact(GetLiveArtifactRequest) returns (LiveArtifact);
rpc ListLiveArtifacts(ListLiveArtifactsRequest) returns (ListLiveArtifactsResponse);
```

**Checklist**:
- [ ] Proto thêm đúng, không thay đổi RPCs hiện có
- [ ] `make proto-gen` chạy thành công
- [ ] Generated Go code không có errors

---

### F02 — Database Migrations

**File**: `services/preview-project/migrations/` (SQL files mới)  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

**Files cần tạo**:
```
migrations/
├── 00X_add_kind_to_projects.sql
├── 00Y_create_conversations.sql
├── 00Z_create_messages.sql
├── 00A_create_runs.sql
└── 00B_create_live_artifacts.sql
```

**SQL** (xem DEV-02 section 3 để biết chi tiết)

---

## Nhóm G — Tests (Ngày 8.5–10)

---

### G01 — Unit Tests Interactors

**Files**: `*_interactor_test.go`  
**Effort**: 1.5 ngày  
**Status**: `[ ]`

- [ ] `conversation_interactor_test.go` — mock repo, test CRUD
- [ ] `run_interactor_test.go` — test status transitions
- [ ] `file_interactor_test.go` — test path validation (security!)

---

### G02 — Integration Tests gRPC

**Files**: `*_handler_test.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```go
// Test với real DB (testcontainers)
func TestCreateConversation_gRPC(t *testing.T)
func TestListConversations_gRPC(t *testing.T)
func TestCreateRun_gRPC(t *testing.T)
func TestUpdateRunStatus_gRPC(t *testing.T)
func TestListFiles_gRPC(t *testing.T)
```

---

## Acceptance Criteria (DEV-02)

- [ ] `CreateConversation` / `ListConversations` qua gRPC hoạt động
- [ ] `CreateRun` / `UpdateRunStatus` qua gRPC hoạt động
- [ ] `ListFiles` trả về file tree của project workspace
- [ ] `ReadFile` stream file content qua gRPC
- [ ] `ProjectRecord.Kind` lưu và query đúng
- [ ] Migrations chạy không break data hiện có
- [ ] Tất cả API endpoints hiện có (Journey, Screen, Member) vẫn hoạt động
- [ ] `go test ./... -race` pass
