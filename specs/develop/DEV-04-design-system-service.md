# DEV-04 — Design System Service: Nâng cấp `preview-design`

> **Chiến lược**: ✅ **Nâng cấp** codebase hiện có  
> **Nguồn**: `services/preview-design/`  
> **Spec tham chiếu**: `specs/services/04-design-system-service.md`

---

## 1. Phân tích Codebase Hiện có

### 1.1 Cấu trúc `preview-design`

```
internal/
├── config/          ← Configuration
├── domain/          ← Domain entities (design systems)
├── handler/         ← HTTP handlers
├── infra/           ← Infrastructure
├── repo/            ← Repository layer
├── resolve/         ← Service resolution
└── usecase/         ← Use cases
```

**Hiện trạng**: `preview-design` phục vụ design systems cho VNPay platform (kits, themes, component patterns). Đây là **hệ thống khác** với design systems của Open Design (150+ CSS-based design systems như Stripe, Material, ...).

### 1.2 Điểm Khác Biệt Quan Trọng

| Tính năng | `preview-design` hiện tại | Open Design cần |
|-----------|--------------------------|----------------|
| DS Format | VNPay component kits (JSON) | CSS tokens + guidelines.md |
| DS Source | Database + KGS Platform | Local filesystem catalog (150+ built-ins) |
| DS Purpose | Component rendering | AI agent system prompt injection |
| DS Count | Hàng trăm VNPay components | 150+ generic design systems |
| Preview | Component rendering | CSS preview |

**Kết luận**: Hai domain khác nhau. Cần **thêm layer mới** vào `preview-design` thay vì thay thế.

---

## 2. Chiến lược: Thêm "Open Design Catalog" vào `preview-design`

### 2.1 Giữ Nguyên (Không Chạm)

- ✅ Toàn bộ VNPay kits/themes logic
- ✅ `GET /api/v1/kits/*` routes
- ✅ `GET /api/v1/design-systems/*` (VNPay design systems)
- ✅ KGS integration
- ✅ Database schema hiện tại

### 2.2 Thêm Mới: "OD Catalog" Sub-domain

```
internal/
├── domain/                  ← hiện có (VNPay DS)
│   └── ...
├── od_catalog/              ← THÊM MỚI — Open Design catalog
│   ├── domain/
│   │   ├── od_design_system.go   ← OD DS entity (CSS-based)
│   │   ├── od_ds_job.go          ← Import/generation job
│   │   └── repository.go         ← Interface
│   ├── usecase/
│   │   ├── catalog_usecase.go    ← List/Get/Delete OD DS
│   │   ├── import_usecase.go     ← Import từ ZIP/URL/NPM
│   │   └── job_usecase.go        ← Job tracking
│   ├── infra/
│   │   ├── fs/
│   │   │   └── builtin_loader.go ← Load 150+ built-in DS từ disk
│   │   └── postgres/
│   │       ├── od_ds_repo.go
│   │       └── od_job_repo.go
│   └── handler/
│       └── grpc/
│           └── od_catalog_handler.go ← gRPC handler cho OD routes
└── ...
```

### 2.3 Built-in Catalog Loading

```go
// internal/od_catalog/infra/fs/builtin_loader.go
type BuiltinCatalogLoader struct {
    catalogPath string // OD_DS_CATALOG_PATH (mount từ design-systems/ directory)
}

// index.yaml schema cho mỗi built-in DS:
type ODDesignSystemIndex struct {
    ID          string   `yaml:"id"`
    Name        string   `yaml:"name"`
    Version     string   `yaml:"version"`
    Description string   `yaml:"description"`
    Tags        []string `yaml:"tags"`
}

func (l *BuiltinCatalogLoader) LoadAll(ctx context.Context) ([]*ODDesignSystem, error) {
    // Walk OD_DS_CATALOG_PATH
    // Parse index.yaml cho mỗi DS
    // Return in-memory list (cache với sync.Once)
}

func (l *BuiltinCatalogLoader) GetFile(dsID, filename string) ([]byte, error) {
    // Read tokens.css, guidelines.md, etc.
}
```

### 2.4 OD DS Entity

```go
// internal/od_catalog/domain/od_design_system.go
type ODDesignSystem struct {
    ID          string
    Name        string
    Version     string
    Source      string   // "builtin" | "imported" | "generated"
    Status      string   // "active" | "processing" | "error"
    Description string
    Tags        []string
    PreviewURL  string
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

// Context cho Agent Service
type ODDesignSystemContext struct {
    ID           string
    Name         string
    TokensCSS    string  // content của tokens.css
    GuidelinesMD string  // content của guidelines.md
}
```

### 2.5 gRPC Proto — Thêm mới

```protobuf
// api/proto/design_system/v1/od_catalog.proto — THÊM MỚI
service ODDesignSystemService {
    rpc ListODDesignSystems(ListRequest) returns (ListResponse);
    rpc GetODDesignSystem(GetRequest) returns (ODDesignSystem);
    rpc ImportODDesignSystem(ImportRequest) returns (ImportResponse);
    rpc DeleteODDesignSystem(DeleteRequest) returns (google.protobuf.Empty);
    rpc GetJobStatus(GetJobRequest) returns (ODDSJob);
    
    // Critical: Agent Service gọi để inject DS context vào prompt
    rpc GetODDesignSystemContext(GetContextRequest) returns (ODDSContext);
    
    // File serving
    rpc GetODDSFile(GetFileRequest) returns (stream FileChunk);
}

message ODDSContext {
    string tokens_css = 1;
    string guidelines_md = 2;
    string name = 3;
}
```

---

## 3. Database Migrations

```sql
-- Chỉ thêm bảng mới, không thay đổi bảng hiện có
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

CREATE TABLE od_design_system_files (
    id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    design_system_id  TEXT NOT NULL REFERENCES od_design_systems(id) ON DELETE CASCADE,
    path              TEXT NOT NULL,   -- "tokens.css" | "guidelines.md"
    content_hash      TEXT,
    storage_path      TEXT
);

CREATE TABLE od_ds_jobs (
    id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    design_system_id  TEXT REFERENCES od_design_systems(id) ON DELETE CASCADE,
    kind              TEXT NOT NULL,   -- "import" | "generate"
    status            TEXT NOT NULL DEFAULT 'pending',
    progress          INTEGER DEFAULT 0,
    error_msg         TEXT,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at       TIMESTAMPTZ
);
```

---

## 4. Mount Design Systems Catalog

```yaml
# docker-compose — mount design-systems folder
design-svc:
  volumes:
    - ../../design-systems:/od-catalog:ro
  environment:
    - OD_DS_CATALOG_PATH=/od-catalog
```

---

## 5. Acceptance Criteria

- [x] `GET /api/design-systems` (OD route, không phải VNPay) trả về 150+ built-in DS
- [x] `GET /api/design-systems/:id` trả về DS detail với preview URL
- [x] `GetODDesignSystemContext` qua gRPC trả về `tokens_css` + `guidelines_md`
- [ ] `ImportODDesignSystem` tạo job, background import từ ZIP URL
- [x] Built-in catalog load tự động khi service start
- [x] Tất cả routes VNPay hiện tại KHÔNG bị ảnh hưởng

---

## 6. Effort Estimate

| Task | Estimate |
|------|---------|
| OD Catalog domain + entities | 1 ngày |
| Builtin catalog loader (FS) | 1.5 ngày |
| Use cases (list/get/import/context) | 2 ngày |
| Postgres repos | 1 ngày |
| gRPC proto + handler | 1.5 ngày |
| Database migrations | 0.5 ngày |
| Tests | 1.5 ngày |
| **Tổng** | **9 ngày** |
