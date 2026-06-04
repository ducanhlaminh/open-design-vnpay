# 04 — Design System Service

> **Port gRPC**: 8083  
> **Domain**: Design System catalog, import, generation, preview

---

## 1. Vai trò & Trách nhiệm

Thay thế `design-systems.ts` (~110KB) hiện tại:

- **Catalog management**: List/Get/Delete design systems (150+ built-in DS)
- **Import**: Import DS từ file ZIP, URL, hoặc NPM package
- **Generation**: Tạo mới DS từ AI (style extraction, token generation)
- **Preview**: Render preview thumbnail cho DS
- **File serving**: Serve DS assets (tokens.css, guidelines.md, components)
- **Job management**: Long-running import/generation jobs với status tracking

---

## 2. Cấu trúc thư mục (Clean Architecture)

```
design-system-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── design_system.go      # DesignSystem entity
│   │   ├── ds_file.go            # DesignSystemFile entity
│   │   ├── ds_job.go             # Import/Generation job entity
│   │   └── repository.go         # Repository interfaces
│   │
│   ├── usecase/
│   │   ├── catalog_usecase.go    # List, Get, Delete DS
│   │   ├── import_usecase.go     # Import DS từ ZIP/URL/NPM
│   │   ├── generate_usecase.go   # AI-generate DS
│   │   ├── preview_usecase.go    # Generate preview thumbnail
│   │   └── job_usecase.go        # Job status tracking
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── ds_repo.go
│   │   │   ├── ds_file_repo.go
│   │   │   └── job_repo.go
│   │   ├── fs/
│   │   │   ├── builtin_loader.go  # Load 150+ built-in DS từ disk
│   │   │   └── ds_store.go        # FS adapter cho DS files
│   │   ├── ai/
│   │   │   └── ds_generator.go    # AI-powered DS generation
│   │   └── npm/
│   │       └── npm_importer.go    # Import từ NPM package
│   │
│   └── delivery/
│       ├── grpc/
│       │   └── handler.go
│       └── http/
│           └── health.go
│
├── proto/
│   └── design_system/v1/design_system.proto
└── Dockerfile
```

---

## 3. Domain Model

```go
// domain/design_system.go
type DesignSystem struct {
    ID          string
    Name        string
    Version     string
    Source      DSSource       // "builtin" | "imported" | "generated"
    Status      DSStatus       // "active" | "processing" | "error"
    Description string
    Tags        []string
    PreviewURL  string
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

type DSSource string
const (
    DSSourceBuiltin   DSSource = "builtin"
    DSSourceImported  DSSource = "imported"
    DSSourceGenerated DSSource = "generated"
)

// domain/ds_file.go
type DesignSystemFile struct {
    ID             string
    DesignSystemID string
    Path           string    // e.g., "tokens.css", "guidelines.md"
    ContentHash    string
    SizeBytes      int64
}

// domain/ds_job.go
type DSJob struct {
    ID             string
    DesignSystemID string
    Kind           DSJobKind  // "import" | "generate" | "preview"
    Status         JobStatus  // "pending" | "running" | "done" | "failed"
    Progress       int        // 0-100
    Error          string
    StartedAt      time.Time
    FinishedAt     *time.Time
}
```

---

## 4. Built-in Design Systems

150+ DS được bundle sẵn trong binary / mounted volume:

```
/ds-catalog/                  ← OD_DS_CATALOG_PATH
  ├── default/
  │   ├── index.yaml           # name, version, description, tags
  │   ├── tokens.css           # CSS custom properties
  │   └── guidelines.md        # AI agent instructions
  ├── stripe/
  │   ├── index.yaml
  │   ├── tokens.css
  │   └── guidelines.md
  ├── material/
  │   └── ...
  └── ...
```

```go
// infra/fs/builtin_loader.go
type BuiltinLoader struct {
    catalogPath string
}

func (l *BuiltinLoader) LoadAll(ctx context.Context) ([]*domain.DesignSystem, error) {
    // Walk catalogPath, parse index.yaml for each DS
    // Return list of DesignSystem entities (no DB needed for built-ins)
}

func (l *BuiltinLoader) GetFile(dsID, path string) ([]byte, error) {
    // Read file from catalog directory
}
```

---

## 5. Import Job Flow

```
POST /api/design-systems  (source: "zip" | "url" | "npm")
    │
    ▼
DesignSystemService.Create (gRPC)
    │
    ├── Create DS record (status: "processing")
    ├── Create DSJob (kind: "import", status: "pending")
    ├── Return DS ID immediately
    │
    ▼  (background goroutine)
ImportUseCase.Execute
    │
    ├── Download / extract source
    ├── Parse & validate tokens.css, guidelines.md
    ├── Compute file hashes
    ├── Store files
    ├── Update DSJob (status: "done", progress: 100)
    └── Update DS (status: "active")
```

---

## 6. gRPC Protocol Definition

```protobuf
syntax = "proto3";
package design_system.v1;

service DesignSystemService {
    rpc ListDesignSystems(ListRequest) returns (ListResponse);
    rpc GetDesignSystem(GetRequest) returns (DesignSystem);
    rpc CreateDesignSystem(CreateRequest) returns (CreateResponse);
    rpc DeleteDesignSystem(DeleteRequest) returns (google.protobuf.Empty);
    rpc GetJobStatus(GetJobRequest) returns (DSJob);

    // For Agent Service: inject DS context into prompts
    rpc GetDesignSystemContext(GetContextRequest) returns (DSContext);
    // For Preview
    rpc GetPreviewURL(GetPreviewRequest) returns (GetPreviewResponse);
    // For File serving
    rpc GetFile(GetFileRequest) returns (stream FileChunk);
}

message DesignSystem {
    string id = 1;
    string name = 2;
    string version = 3;
    string source = 4;
    string status = 5;
    string description = 6;
    repeated string tags = 7;
    string preview_url = 8;
    google.protobuf.Timestamp created_at = 9;
}

message DSContext {
    // Used by Agent Service to inject into system prompt
    string tokens_css = 1;
    string guidelines_md = 2;
    string name = 3;
}
```

---

## 7. Database Schema

```sql
CREATE TABLE design_systems (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name        TEXT NOT NULL,
    version     TEXT,
    source      TEXT NOT NULL DEFAULT 'builtin',
    status      TEXT NOT NULL DEFAULT 'active',
    description TEXT,
    tags        TEXT[] DEFAULT '{}',
    preview_url TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE design_system_files (
    id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    design_system_id  TEXT NOT NULL REFERENCES design_systems(id) ON DELETE CASCADE,
    path              TEXT NOT NULL,
    content_hash      TEXT,
    size_bytes        BIGINT,
    storage_path      TEXT  -- actual path on disk
);

CREATE TABLE design_system_jobs (
    id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    design_system_id  TEXT NOT NULL REFERENCES design_systems(id) ON DELETE CASCADE,
    kind              TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    progress          INTEGER DEFAULT 0,
    error_msg         TEXT,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at       TIMESTAMPTZ
);
```
