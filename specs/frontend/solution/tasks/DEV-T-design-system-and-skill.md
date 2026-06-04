# DEV-T-04 — Design System Service + DEV-T-09 Skill Service Tasks

---

# DEV-T-04 — Design System Service

> **Service**: `services/preview-design` → Nâng cấp (thêm OD Catalog sub-domain)  
> **Effort**: 9 ngày  
> **Sprint**: Sprint 3 (Tuần 6–7)  
> **Ref**: [DEV-04-design-system-service.md](../../develop/DEV-04-design-system-service.md)

---

## Nguyên tắc

> ✅ **GIỮ NGUYÊN**: Tất cả VNPay kits/themes, `GET /api/v1/kits/*`, KGS integration  
> ❌ **KHÔNG CHẠM**: Domain entities, routes, handlers hiện có của VNPay DS  
> ✅ **THÊM MỚI**: Sub-domain `od_catalog` hoàn toàn tách biệt trong `internal/od_catalog/`

---

## Nhóm A — OD Catalog Domain (Ngày 1)

### A01 — Entity `ODDesignSystem`

**File**: `services/preview-design/internal/od_catalog/domain/od_design_system.go`  
**Effort**: 1.5h  
**Status**: `[ ]`

```go
package domain

import "time"

type ODDesignSystem struct {
    ID          string
    Name        string
    Version     string
    Source      string     // "builtin" | "imported" | "generated"
    Status      string     // "active" | "processing" | "error"
    Description string
    Tags        []string
    PreviewURL  string
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

// Context được inject vào agent system prompt
type ODDesignSystemContext struct {
    ID           string
    Name         string
    TokensCSS    string  // content của tokens.css
    GuidelinesMD string  // content của guidelines.md
}
```

### A02 — Entity `ODDSJob` + Repository Interfaces

**File**: `services/preview-design/internal/od_catalog/domain/od_ds_job.go`  
**File**: `services/preview-design/internal/od_catalog/domain/repository.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
type ODDSJob struct {
    ID             string
    DesignSystemID string
    Kind           string   // "import" | "generate"
    Status         string   // "pending" | "running" | "done" | "error"
    Progress       int
    ErrorMsg       string
    StartedAt      time.Time
    FinishedAt     *time.Time
}

// Interfaces
type ODDesignSystemRepository interface {
    Create(ctx, *ODDesignSystem) error
    GetByID(ctx, id string) (*ODDesignSystem, error)
    List(ctx, filter ODDSFilter) ([]*ODDesignSystem, error)
    Update(ctx, *ODDesignSystem) error
    Delete(ctx, id string) error
}

type ODDSJobRepository interface {
    Create(ctx, *ODDSJob) error
    GetByID(ctx, id string) (*ODDSJob, error)
    UpdateStatus(ctx, id, status string, progress int, errMsg string) error
}
```

---

## Nhóm B — Built-in Catalog Loader (Ngày 1–2.5)

### B01 — `BuiltinCatalogLoader`

**File**: `services/preview-design/internal/od_catalog/infra/fs/builtin_loader.go`  
**Effort**: 1.5 ngày  
**Status**: `[ ]`

```go
type BuiltinCatalogLoader struct {
    catalogPath string    // OD_DS_CATALOG_PATH (mounted design-systems/)
    cache       sync.Once
    cached      []*domain.ODDesignSystem
}

// index.yaml schema:
type ODDesignSystemIndex struct {
    ID          string   `yaml:"id"`
    Name        string   `yaml:"name"`
    Version     string   `yaml:"version"`
    Description string   `yaml:"description"`
    Tags        []string `yaml:"tags"`
    PreviewURL  string   `yaml:"preview_url"`
}

// LoadAll: walk catalogPath/, parse index.yaml
// Kết quả được cache (sync.Once) — reload khi service restart
func (l *BuiltinCatalogLoader) LoadAll(ctx) ([]*domain.ODDesignSystem, error)

// GetFile: đọc file trong DS folder (tokens.css, guidelines.md)
// Security: validate path không traverse ra ngoài catalogPath
func (l *BuiltinCatalogLoader) GetFile(dsID, filename string) ([]byte, error)

// GetContext: đọc tokens.css + guidelines.md → ODDesignSystemContext
func (l *BuiltinCatalogLoader) GetContext(ctx, dsID string) (*domain.ODDesignSystemContext, error)
```

**Test**:
- [ ] Load thư mục có 3 built-in DSes → trả về 3 items
- [ ] DS thiếu `index.yaml` → skip (không crash)
- [ ] Path traversal `../../../etc/passwd` → error
- [ ] Cache: gọi lần 2 không scan filesystem lại

---

## Nhóm C — Use Cases (Ngày 2.5–4.5)

### C01 — `CatalogUseCase`

**File**: `services/preview-design/internal/od_catalog/usecase/catalog_usecase.go`  
**Effort**: 1 ngày  
**Status**: `[ ]`

```go
type CatalogUseCase struct {
    builtinLoader *fs.BuiltinCatalogLoader
    dsRepo        domain.ODDesignSystemRepository
}

func (uc *CatalogUseCase) ListDesignSystems(ctx, filter domain.ODDSFilter) ([]*domain.ODDesignSystem, error)
// Merge: builtin (from FS) + user-created (from DB)

func (uc *CatalogUseCase) GetDesignSystem(ctx, id string) (*domain.ODDesignSystem, error)

func (uc *CatalogUseCase) GetDesignSystemContext(ctx, id string) (*domain.ODDesignSystemContext, error)
// Critical for Agent Service: trả về tokens.css + guidelines.md

func (uc *CatalogUseCase) ListFiles(ctx, dsID string) ([]string, error)

func (uc *CatalogUseCase) GetFile(ctx, dsID, path string) ([]byte, error)
```

### C02 — `ImportUseCase`

**File**: `services/preview-design/internal/od_catalog/usecase/import_usecase.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```go
func (uc *ImportUseCase) ImportFromLocalPath(ctx, localPath string) (*domain.ODDesignSystem, error)
func (uc *ImportUseCase) ImportFromZipURL(ctx, url string) (*domain.ODDSJob, error)  // async
```

### C03 — `JobUseCase`

**File**: `services/preview-design/internal/od_catalog/usecase/job_usecase.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```go
func (uc *JobUseCase) GetJobStatus(ctx, jobID string) (*domain.ODDSJob, error)
func (uc *JobUseCase) CreateImportJob(ctx, dsID string, source string) (*domain.ODDSJob, error)
```

---

## Nhóm D — Postgres Repos + Migrations (Ngày 4.5–5.5)

### D01 — `od_ds_repo.go` + `od_job_repo.go`

**Files**: `internal/od_catalog/infra/postgres/`  
**Effort**: 1 ngày  
**Status**: `[ ]`

```sql
-- migrations/X_create_od_design_systems.sql
CREATE TABLE od_design_systems (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name        TEXT NOT NULL,
    version     TEXT,
    source      TEXT NOT NULL DEFAULT 'builtin',
    status      TEXT NOT NULL DEFAULT 'active',
    description TEXT,
    tags        TEXT[],
    preview_url TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE od_ds_jobs (
    id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    design_system_id  TEXT REFERENCES od_design_systems(id) ON DELETE CASCADE,
    kind              TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    progress          INTEGER DEFAULT 0,
    error_msg         TEXT,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at       TIMESTAMPTZ
);
```

---

## Nhóm E — gRPC Proto + Handler (Ngày 5.5–7)

### E01 — Proto Definition

**File**: `services/preview-design/api/proto/design_system/v1/od_catalog.proto`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

### E02 — gRPC Handler

**File**: `services/preview-design/internal/od_catalog/handler/grpc/od_catalog_handler.go`  
**Effort**: 1 ngày  
**Status**: `[ ]`

```go
// Methods: ListODDesignSystems, GetODDesignSystem, ImportODDesignSystem,
// DeleteODDesignSystem, GetJobStatus, GetODDesignSystemContext, GetODDSFile
```

### E03 — Register Handler trong `main.go`

**File**: `services/preview-design/cmd/main.go` (MODIFY)  
**Effort**: 1h  
**Status**: `[ ]`

Thêm gRPC server cho OD catalog, không thay đổi HTTP server hiện có.

---

## Nhóm F — Docker Volume Mount (Ngày 7)

### F01 — Cập nhật Dockerfile + Compose

**Effort**: 0.5h  
**Status**: `[ ]`

```yaml
# docker-compose.yaml
design-svc:
  volumes:
    - ../../design-systems:/od-catalog:ro   # Mount built-in catalog
  environment:
    - OD_DS_CATALOG_PATH=/od-catalog
```

---

## Nhóm G — Tests (Ngày 7–9)

- [ ] `catalog_usecase_test.go` — mock loader + repo
- [ ] `builtin_loader_test.go` — với real test fixtures
- [ ] `import_usecase_test.go`
- [ ] Integration: gRPC GetODDesignSystemContext

---

## Acceptance Criteria (DEV-04)

- [ ] `GET /api/design-systems` (OD route) trả về list từ FS catalog
- [ ] `GetODDesignSystemContext` gRPC trả về `tokens_css` + `guidelines_md`
- [ ] Built-in catalog load khi service start
- [ ] VNPay routes hiện tại **không bị ảnh hưởng**
- [ ] `go test ./... -race` pass

---
---

# DEV-T-09 — Skill Service Tasks

> **Service**: `services/skill-service` → Tạo mới (tham khảo pattern `prompt-registry-service`)  
> **Effort**: 5 ngày  
> **Sprint**: Sprint 3 (Tuần 6–7)  
> **Ref**: [DEV-09-12-remaining-services.md](../../develop/DEV-09-12-remaining-services.md) section DEV-09

---

## Nhóm A — Project Setup (Ngày 1)

### A01 — Khởi tạo Module

**File**: `services/skill-service/`  
**Effort**: 1h  
**Status**: `[ ]`

```bash
mkdir -p services/skill-service
cd services/skill-service
go mod init github.com/open-design/skill-service
go get google.golang.org/grpc go.uber.org/zap github.com/spf13/viper
```

```
services/skill-service/
├── cmd/main.go
├── internal/
│   ├── config/config.go
│   ├── domain/
│   │   ├── skill.go
│   │   └── repository.go
│   ├── usecase/
│   │   ├── catalog_usecase.go
│   │   └── context_usecase.go
│   └── infra/
│       └── fs/skill_loader.go
├── api/proto/skill/v1/skill.proto
├── Dockerfile
└── go.mod
```

---

## Nhóm B — Domain + Loader (Ngày 1–2)

### B01 — `Skill` Entity

**File**: `services/skill-service/internal/domain/skill.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
type Skill struct {
    ID          string
    Name        string
    Title       string
    Description string
    Version     string
    Kind        string     // "coding" | "design" | "content" | "analysis"
    Tags        []string
    Files       []string   // file paths trong skill directory
}

type SkillContext struct {
    SkillID      string
    SystemPrompt string  // content để inject vào agent prompt
}
```

### B02 — `SkillLoader` (File System)

**File**: `services/skill-service/internal/infra/fs/skill_loader.go`  
**Effort**: 1.5 ngày  
**Status**: `[ ]`

```go
type SkillLoader struct {
    skillsPath string     // OD_SKILLS_PATH
    cache      sync.Map   // id → *Skill
}

// LoadAll: walk skillsPath, parse SKILL.md / skill.yaml frontmatter
// Caching: load on first call, watcher cho reload (optional)
func (l *SkillLoader) LoadAll() ([]*domain.Skill, error) {
    var skills []*domain.Skill
    
    filepath.WalkDir(l.skillsPath, func(path string, d fs.DirEntry, err error) error {
        // Look for skill.yaml or SKILL.md in each subdirectory
        if d.IsDir() {
            skill, err := l.loadSkillDir(path)
            if err == nil {
                skills = append(skills, skill)
            }
        }
        return nil
    })
    
    return skills, nil
}

// loadSkillDir: đọc skill.yaml hoặc parse SKILL.md frontmatter
func (l *SkillLoader) loadSkillDir(dir string) (*domain.Skill, error)

// GetSystemPrompt: đọc system_prompt section từ SKILL.md
func (l *SkillLoader) GetSystemPrompt(skillID string) (string, error)
```

---

## Nhóm C — Use Cases (Ngày 2–3)

### C01 — `CatalogUseCase` + `ContextUseCase`

**Effort**: 1 ngày  
**Status**: `[ ]`

```go
// CatalogUseCase
func (uc *CatalogUseCase) ListSkills(ctx context.Context) ([]*domain.Skill, error)
func (uc *CatalogUseCase) GetSkill(ctx context.Context, id string) (*domain.Skill, error)
func (uc *CatalogUseCase) ListFiles(ctx context.Context, skillID string) ([]string, error)
func (uc *CatalogUseCase) GetFile(ctx context.Context, skillID, path string) ([]byte, error)

// ContextUseCase — for Agent Service injection
func (uc *ContextUseCase) GetSkillContext(ctx context.Context, skillID string) (*domain.SkillContext, error)
```

---

## Nhóm D — gRPC Proto + Handler (Ngày 3–4)

### D01 — Proto + gRPC

**File**: `services/skill-service/api/proto/skill/v1/skill.proto`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```protobuf
service SkillService {
    rpc ListSkills(ListSkillsRequest) returns (ListSkillsResponse);
    rpc GetSkill(GetSkillRequest) returns (Skill);
    rpc GetSkillContext(GetSkillContextRequest) returns (SkillContext);
    rpc ListFiles(ListFilesRequest) returns (ListFilesResponse);
}
```

### D02 — Handler + main.go

**Effort**: 0.5 ngày  
**Status**: `[ ]`

---

## Nhóm E — Tests + Docker (Ngày 4–5)

- [ ] `skill_loader_test.go` — với test fixtures skills directory
- [ ] `catalog_usecase_test.go`
- [ ] `Dockerfile` — `FROM golang:1.23-alpine AS builder`
- [ ] Docker Compose entry với profile `od`
- [ ] `smoke-test.sh` entry cho Skill Service

---

## Acceptance Criteria (DEV-09)

- [ ] `GET /api/skills` trả về builtin skills catalog
- [ ] `GET /api/skills/:id` trả về skill detail
- [ ] `GetSkillContext` gRPC trả về system_prompt
- [ ] YAML files được load từ `skills/` directory
- [ ] `go test ./... -race` pass
- [ ] Docker build + compose `od` profile
