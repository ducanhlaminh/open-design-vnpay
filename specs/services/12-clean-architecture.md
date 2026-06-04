# 12 — Clean Architecture Pattern

> Hướng dẫn chi tiết về cách áp dụng Clean Architecture trong mỗi service Golang

---

## 1. Nguyên tắc cốt lõi

```
                    ┌─────────────────────────────────────┐
                    │           Delivery Layer             │
                    │    (gRPC handlers, HTTP handlers)    │
                    └────────────────┬────────────────────┘
                                     │ calls
                    ┌────────────────▼────────────────────┐
                    │           Use Case Layer             │
                    │    (Business logic orchestration)    │
                    └────────────────┬────────────────────┘
                                     │ calls (via interfaces)
                    ┌────────────────▼────────────────────┐
                    │           Domain Layer               │
                    │   (Entities, Interfaces/Ports)       │
                    └────────────────┬────────────────────┘
                                     ↑ implements
                    ┌────────────────┴────────────────────┐
                    │        Infrastructure Layer          │
                    │  (Database, External APIs, FS, ...)  │
                    └─────────────────────────────────────┘
```

**Dependency Rule**: Mũi tên phụ thuộc chỉ đi vào trong (inward). Lớp trong không bao giờ import lớp ngoài.

---

## 2. Layer Responsibilities

### 2.1 Domain Layer (`internal/domain/`)

Chỉ chứa:
- **Entities**: Struct thuần Go, không có tag DB/JSON phức tạp
- **Value Objects**: Immutable types (e.g., `Email`, `RunStatus`)
- **Domain Events**: Events mà business logic phát ra
- **Repository Interfaces**: Interfaces mà infra phải implement

```go
// ✅ ĐÚNG — domain/project.go
package domain

import "time"

type Project struct {
    ID        string
    Name      string
    Kind      ProjectKind
    Metadata  map[string]any
    CreatedAt time.Time
    UpdatedAt time.Time
}

type ProjectKind string
const (
    ProjectKindWebUI ProjectKind = "web-ui"
    ProjectKindImage ProjectKind = "image"
)

// Domain events
type ProjectCreatedEvent struct {
    ProjectID string
    Name      string
    Kind      ProjectKind
}

// Repository interface (Port)
type ProjectRepository interface {
    Create(ctx context.Context, p *Project) error
    GetByID(ctx context.Context, id string) (*Project, error)
    List(ctx context.Context, filter ProjectFilter) ([]*Project, error)
    Update(ctx context.Context, p *Project) error
    Delete(ctx context.Context, id string) error
}

// ❌ SAI — không import DB package trong domain
// import "gorm.io/gorm"   ← KHÔNG BAO GIỜ
```

### 2.2 Use Case Layer (`internal/usecase/`)

Orchestrate domain logic. **Không** chứa SQL hay HTTP.

```go
// usecase/project_usecase.go
package usecase

import (
    "context"
    "yourservice/internal/domain"
)

// Dependencies injected via interfaces
type ProjectUseCase struct {
    projectRepo domain.ProjectRepository   // Interface, not concrete
    fileStore   domain.FileStore
    eventBus    domain.EventBus
}

// Constructor với dependency injection
func NewProjectUseCase(
    repo domain.ProjectRepository,
    fs domain.FileStore,
    bus domain.EventBus,
) *ProjectUseCase {
    return &ProjectUseCase{
        projectRepo: repo,
        fileStore:   fs,
        eventBus:    bus,
    }
}

// Use case method
func (uc *ProjectUseCase) CreateProject(ctx context.Context, req CreateProjectRequest) (*domain.Project, error) {
    // 1. Validate
    if req.Name == "" {
        return nil, ErrProjectNameRequired
    }

    // 2. Create entity
    project := &domain.Project{
        ID:   generateID(),
        Name: req.Name,
        Kind: req.Kind,
    }

    // 3. Create filesystem directory
    if err := uc.fileStore.CreateProjectDir(ctx, project.ID); err != nil {
        return nil, fmt.Errorf("create project dir: %w", err)
    }

    // 4. Persist
    if err := uc.projectRepo.Create(ctx, project); err != nil {
        return nil, fmt.Errorf("create project: %w", err)
    }

    // 5. Emit domain event
    uc.eventBus.Publish(&domain.ProjectCreatedEvent{
        ProjectID: project.ID,
        Name:      project.Name,
    })

    return project, nil
}
```

### 2.3 Infrastructure Layer (`internal/infra/`)

Implement repository interfaces. Có thể import bất kỳ external package nào.

```go
// infra/db/project_repo.go
package db

import (
    "context"
    "yourservice/internal/domain"
    "gorm.io/gorm"
)

// Concrete implementation of domain.ProjectRepository
type PostgresProjectRepository struct {
    db *gorm.DB
}

// DB model (separate from domain entity!)
type projectModel struct {
    ID        string `gorm:"primarykey"`
    Name      string `gorm:"not null"`
    Kind      string `gorm:"not null"`
    Metadata  []byte `gorm:"type:jsonb"`
    CreatedAt time.Time
    UpdatedAt time.Time
}

func (r *PostgresProjectRepository) Create(ctx context.Context, p *domain.Project) error {
    model := toProjectModel(p)  // domain → db model conversion
    return r.db.WithContext(ctx).Create(model).Error
}

func (r *PostgresProjectRepository) GetByID(ctx context.Context, id string) (*domain.Project, error) {
    var model projectModel
    err := r.db.WithContext(ctx).Where("id = ?", id).First(&model).Error
    if errors.Is(err, gorm.ErrRecordNotFound) {
        return nil, domain.ErrProjectNotFound
    }
    return toProjectDomain(&model), err  // db model → domain entity
}

// Conversion helpers
func toProjectModel(p *domain.Project) *projectModel { /* ... */ }
func toProjectDomain(m *projectModel) *domain.Project { /* ... */ }
```

### 2.4 Delivery Layer (`internal/delivery/`)

Handle transport protocol. Chuyển đổi giữa transport format và use case input/output.

```go
// delivery/grpc/handler.go
package grpc

import (
    "context"
    "yourservice/internal/usecase"
    pb "yourservice/proto/project/v1"
)

type ProjectGRPCHandler struct {
    pb.UnimplementedProjectServiceServer
    projectUC *usecase.ProjectUseCase
}

func (h *ProjectGRPCHandler) CreateProject(
    ctx context.Context,
    req *pb.CreateProjectRequest,
) (*pb.Project, error) {
    // 1. Validate gRPC request
    if req.Name == "" {
        return nil, status.Error(codes.InvalidArgument, "name is required")
    }

    // 2. Call use case
    project, err := h.projectUC.CreateProject(ctx, usecase.CreateProjectRequest{
        Name: req.Name,
        Kind: domain.ProjectKind(req.Kind),
    })
    if err != nil {
        return nil, toGRPCError(err)  // map domain errors → gRPC status codes
    }

    // 3. Convert domain → proto
    return toProtoProject(project), nil
}

// Error mapping
func toGRPCError(err error) error {
    switch {
    case errors.Is(err, domain.ErrProjectNotFound):
        return status.Error(codes.NotFound, err.Error())
    case errors.Is(err, usecase.ErrProjectNameRequired):
        return status.Error(codes.InvalidArgument, err.Error())
    default:
        return status.Error(codes.Internal, "internal error")
    }
}
```

---

## 3. Dependency Injection (main.go)

```go
// cmd/main.go
func main() {
    cfg := config.Load()

    // 1. Infrastructure
    db := infra.NewPostgresDB(cfg.DatabaseURL)
    projectRepo := db.NewProjectRepository()
    fileStore := infra.NewLocalFileStore(cfg.WorkspacePath)
    eventBus := infra.NewNATSEventBus(cfg.NATSUrl)

    // 2. Use cases
    projectUC := usecase.NewProjectUseCase(projectRepo, fileStore, eventBus)
    convUC    := usecase.NewConversationUseCase(convRepo, projectRepo)

    // 3. Delivery
    grpcHandler := grpc.NewProjectGRPCHandler(projectUC, convUC)

    // 4. Start server
    server := grpc.NewServer(grpcHandler)
    server.Serve(cfg.Port)
}
```

---

## 4. Error Handling Convention

```go
// domain/errors.go — domain-level errors
var (
    ErrProjectNotFound     = errors.New("project not found")
    ErrConversationNotFound = errors.New("conversation not found")
    ErrRunNotFound         = errors.New("run not found")
)

// usecase/errors.go — use case validation errors
var (
    ErrProjectNameRequired = errors.New("project name is required")
    ErrInvalidProjectKind  = errors.New("invalid project kind")
)

// delivery/grpc/errors.go — transport layer mapping
func toGRPCError(err error) error {
    switch {
    case errors.Is(err, domain.ErrProjectNotFound):
        return status.Error(codes.NotFound, err.Error())
    case errors.Is(err, usecase.ErrProjectNameRequired):
        return status.Error(codes.InvalidArgument, err.Error())
    default:
        // Log internal error, return generic message
        slog.Error("internal error", "err", err)
        return status.Error(codes.Internal, "internal server error")
    }
}
```

---

## 5. Testing Strategy

```
Layer            Test Type        Tools
──────────────────────────────────────────────────────
Domain           Unit             go test, testify
Use Case         Unit (mock infra) gomock, testify
Infrastructure   Integration      testcontainers-go
Delivery (gRPC)  Integration      grpc test server
End-to-end       E2E              real service + real DB
```

**Use Case Test Example** (với mock repository):

```go
// usecase/project_usecase_test.go
func TestCreateProject(t *testing.T) {
    ctrl := gomock.NewController(t)
    mockRepo := mocks.NewMockProjectRepository(ctrl)
    mockFS   := mocks.NewMockFileStore(ctrl)
    mockBus  := mocks.NewMockEventBus(ctrl)

    uc := NewProjectUseCase(mockRepo, mockFS, mockBus)

    // Expect calls
    mockFS.EXPECT().CreateProjectDir(gomock.Any(), gomock.Any()).Return(nil)
    mockRepo.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)
    mockBus.EXPECT().Publish(gomock.Any()).AnyTimes()

    project, err := uc.CreateProject(context.Background(), CreateProjectRequest{
        Name: "My Project",
        Kind: domain.ProjectKindWebUI,
    })

    assert.NoError(t, err)
    assert.Equal(t, "My Project", project.Name)
}
```

---

## 6. Project Layout Convention

```
{service-name}/
├── cmd/
│   └── main.go                   # Entry point, DI wiring
│
├── internal/
│   ├── config/
│   │   └── config.go             # Viper config struct
│   │
│   ├── domain/
│   │   ├── {entity}.go           # Entities + value objects
│   │   ├── errors.go             # Domain error vars
│   │   └── repository.go         # All repository interfaces
│   │
│   ├── usecase/
│   │   ├── {feature}_usecase.go  # One file per feature
│   │   ├── dto.go                # Request/Response DTOs
│   │   └── errors.go             # UseCase validation errors
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── postgres.go       # DB connection
│   │   │   ├── migrations/       # SQL migrations
│   │   │   └── {entity}_repo.go  # Repository implementation
│   │   └── {adapter}/
│   │       └── {adapter}.go      # External API adapter
│   │
│   └── delivery/
│       ├── grpc/
│       │   ├── handler.go        # gRPC handler
│       │   ├── mapping.go        # proto ↔ domain conversion
│       │   └── errors.go         # gRPC error mapping
│       └── http/
│           └── health.go         # /health, /metrics
│
├── proto/
│   └── {service}/v1/
│       └── {service}.proto       # Protobuf definition
│
├── mocks/                        # Generated mocks (gomock)
├── Dockerfile
├── go.mod
└── go.sum
```

---

## 7. Coding Standards

```go
// 1. Tất cả exported functions phải có godoc
// CreateProject creates a new project in the workspace.
// Returns ErrProjectNameRequired if name is empty.
func (uc *ProjectUseCase) CreateProject(...) {}

// 2. Context luôn là parameter đầu tiên
func (r *repo) Create(ctx context.Context, entity *Entity) error {}

// 3. Error wrapping với %w
return fmt.Errorf("creating project directory: %w", err)

// 4. Structured logging với slog
slog.InfoContext(ctx, "project created", "project_id", project.ID, "name", project.Name)

// 5. Không dùng global state — inject mọi thứ
// ❌ var db *gorm.DB  ← KHÔNG
// ✅ Inject qua constructor

// 6. Interface nhỏ, đơn nhiệm
// ❌ type Repository interface { Create(); Read(); Update(); Delete(); List(); Count(); ... }
// ✅ Chia nhỏ theo use case nếu cần
```
