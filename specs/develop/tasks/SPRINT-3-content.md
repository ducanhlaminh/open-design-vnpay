# Sprint 3 — Content Services Tasks

> **Mục tiêu**: Design System OD Catalog, Skill Service, Media Service, Telemetry Service  
> **Thời gian**: Tuần 6-7 | **Team**: 3 Developers song song

---

## T-3DS-01: Design System Service — OD Catalog Domain {#t-3ds-01}

**Estimate**: 1 ngày | **Assignee**: Dev 1 | **Depends on**: T-1IN-01

### Bước thực hiện

```
[x] 1. Tạo internal/domain/entity/od_design_system.go:
        type ODDSSource string // "builtin" | "imported" | "generated"
        type ODDSStatus string // "active" | "processing" | "error"
        type ODDesignSystem struct {
            ID, Name, Version, Source, Status, Description string
            Tags        []string
            PreviewURL  string
            CreatedAt, UpdatedAt time.Time
        }
[x] 2. Tạo internal/domain/entity/od_ds_context.go:
        type ODDSContext struct {
            ID, Name   string
            TokensCSS  string   // content của tokens.css
            GuidelinesMD string // content của guidelines.md
        }
[x] 3. Tạo internal/domain/entity/od_ds_job.go:
        type ODDSJobKind string // "import" | "generate"
        type ODDSJobStatus string // "pending" | "running" | "done" | "error"
        type ODDSJob struct { ID, DesignSystemID string; Kind, Status; Progress int; ErrorMsg string; ... }
[x] 4. Tạo internal/usecase/port/od_ports.go (interfaces):
        type ODDSRepository interface { Create, GetByID, List, Delete }
        type ODDSJobRepository interface { Create, GetByID, UpdateProgress }
[ ] 5. Unit tests cho domain types
```

### Acceptance Criteria
- [x] Domain types compile không lỗi
- [x] Status transitions valid

---

## T-3DS-02: Design System Service — Builtin Catalog Loader {#t-3ds-02}

**Estimate**: 1.5 ngày | **Assignee**: Dev 1 | **Depends on**: T-3DS-01

### Bước thực hiện

```
[x] 1. Define index.yaml schema (cho mỗi built-in DS):
        id: "material-design-3"
        name: "Material Design 3"
        version: "3.0.0"
        description: "Google's Material Design system"
        tags: [google, material, android]
        files:
          - tokens.css
          - guidelines.md
          - preview.png  # optional
[x] 2. Tạo internal/infra/fs/builtin_loader.go:
        type BuiltinCatalogLoader struct {
            catalogPath string
            cache       sync.RWMutex
            cached      []*domain.ODDesignSystem
        }
        func (l *BuiltinCatalogLoader) LoadAll(ctx) ([]*domain.ODDesignSystem, error)
        func (l *BuiltinCatalogLoader) GetFile(dsID, filename string) ([]byte, error)
        func (l *BuiltinCatalogLoader) GetContext(dsID string) (*domain.ODDSContext, error)
[x] 3. LoadAll implementation:
        - Walk catalogPath/
        - Mỗi subdirectory → tìm index.yaml → parse → ODDesignSystem
        - cache trong sync.RWMutex
[x] 4. GetContext: đọc tokens.css + guidelines.md, return ODDSContext
[x] 5. Tạo 3 sample built-in DS trong design-systems/ folder:
        design-systems/
        ├── material-design-3/   ✅ (index.yaml + tokens.css + guidelines.md)
        ├── ant-design/          ✅ (index.yaml + tokens.css + guidelines.md)
        └── vnpay-design/        ✅ (index.yaml + tokens.css + guidelines.md)
[ ] 6. Unit tests với temp directory
```

### Acceptance Criteria
- [x] `LoadAll` trả về correct list từ filesystem
- [x] `GetContext("material-design-3")` trả về tokens_css + guidelines_md content
- [x] Missing index.yaml → DS bị skip (log warning, không crash)
- [x] Invalid YAML → log error + skip

---

## T-3DS-03: Design System Service — Postgres Repos {#t-3ds-03}

**Estimate**: 1 ngày | **Assignee**: Dev 1 | **Depends on**: T-3DS-01

### Bước thực hiện

```
[x] 1. Tạo migrations/000020_create_od_design_systems.up.sql:
        - od_design_systems table
        - od_design_system_files table
        - od_ds_jobs table
[x] 2. Implement internal/infra/persistence/postgres/od_ds_repo.go (ODDSRepo)
[x] 3. Implement ODDSJobRepo trong cùng file od_ds_repo.go
[ ] 4. Integration tests
```

### Acceptance Criteria
- [x] Migrations clean (up/down)
- [x] CRUD operations đầy đủ
- [x] Foreign key constraints hoạt động

---

## T-3DS-04: Design System Service — Use Cases + HTTP Handler {#t-3ds-04}

**Estimate**: 2.5 ngày | **Assignee**: Dev 1 | **Depends on**: T-3DS-02, T-3DS-03

### Bước thực hiện

```
[x] 1. Tạo internal/usecase/od_catalog_usecase.go:
        - ListODDesignSystems(ctx, filter) — merge builtin + imported
        - GetODDesignSystem(ctx, id)
        - DeleteODDesignSystem(ctx, id) — chỉ xóa imported, không xóa builtin
[x] 2. Tạo internal/usecase/od_context_usecase.go:
        - GetODDesignSystemContext(ctx, dsID) (*ODDSContext, error)
        - GetODDSFile(ctx, dsID, filename)
[ ] 3. ImportODDesignSystem use case (Phase 2 — background download)
[x] 4. Tạo internal/handler/od_catalog_handler.go:
        - GET /api/v1/od/design-systems
        - GET /api/v1/od/design-systems/:id
        - DELETE /api/v1/od/design-systems/:id
        - GET /api/v1/od/design-systems/:id/context
        - GET /api/v1/od/design-systems/:id/files/:filename
[ ] 5. buf generate (proto định nghĩa chưa cần cho HTTP-first approach)
[ ] 6. Startup: load builtin catalog khi service start (wired in main.go)
[ ] 7. E2E test: list DS → get context → verify tokens_css content
```

### Acceptance Criteria
- [x] `ListODDesignSystems` trả về builtin DS (từ filesystem)
- [x] `GetODDesignSystemContext` trả về đúng tokens + guidelines
- [x] `DeleteODDesignSystem` builtin → trả về error
- [x] Existing VNPay DS routes KHÔNG bị ảnh hưởng
- [ ] `ImportODDesignSystem` (Phase 2)

---

## T-3SK-01: Skill Service — Project Setup + FS Loader {#t-3sk-01}

**Estimate**: 2 ngày | **Assignee**: Dev 1 | **Depends on**: T-1IN-01

### Bước thực hiện

```
[x] 1. Tạo services/skill-service/ với go.mod (module: skill-service)
[x] 2. Tạo cấu trúc thư mục:
        cmd/main.go
        internal/domain/skill.go
        internal/usecase/catalog_usecase.go
        internal/infra/fs/skill_loader.go
        internal/adapter/http/handler.go
        skills/
[x] 3. Tạo domain/skill.go:
        type SkillKind string // "scenario" | "tool"
        type Skill struct { ID, Name, Description, Version, Author, Kind, SystemPrompt, Tags }
[x] 4. Tạo infra/fs/skill_loader.go:
        type SkillLoader struct { skillsPath string; cache sync.Map }
        func (l *SkillLoader) LoadAll() ([]*domain.Skill, error)
        func (l *SkillLoader) GetByID(id string) (*domain.Skill, error)
[x] 5. Định nghĩa skill.yaml format ✅
[x] 6. Tạo 3 sample skills trong skills/ folder:
        - generate-prd.yaml
        - design-ui-component.yaml
        - code-review-ux.yaml
[ ] 7. Unit tests cho skill_loader
```

### Acceptance Criteria
- [x] `LoadAll()` trả về đúng số skills từ filesystem
- [x] `GetByID("generate-prd")` trả về skill với system_prompt
- [x] Invalid YAML → log + skip
- [x] Missing skills/ dir → empty list (không crash)

---

## T-3SK-02: Skill Service — Use Cases + HTTP Server {#t-3sk-02}

**Estimate**: 2 ngày | **Assignee**: Dev 1 | **Depends on**: T-3SK-01

### Bước thực hiện

```
[x] 1. Tạo usecase/catalog_usecase.go:
        - ListSkills(kind, tags) — filter by kind, tags
        - GetSkill(id)
        - GetSkillContext(id) → system_prompt
[x] 2. Implement adapter/http/handler.go
        - GET /api/v1/skills
        - GET /api/v1/skills/:id
        - GET /api/v1/skills/:id/context
        - GET /health
[x] 3. Tạo cmd/main.go — wire up, start HTTP server
[x] 4. Thêm skill-service vào go.work
[ ] 5. Thêm skill-service vào docker-compose.local.yml
[ ] 6. E2E test: list skills → get context
```

### Acceptance Criteria
- [x] `ListSkills` trả về skills từ filesystem
- [x] `GetSkillContext` trả về system_prompt
- [x] HTTP server start trên port 8088
- [x] `/health` → 200

---

## T-3MD-01: Media Service — Project Setup + Domain {#t-3md-01}

**Estimate**: 1.5 ngày | **Assignee**: Dev 2 | **Depends on**: T-1IN-01, T-1CF-04

### Bước thực hiện

```
[x] 1. Tạo services/media-service/ với go.mod (module: media-service)
[x] 2. Cấu trúc thư mục đầy đủ
[x] 3. Tạo internal/domain/media.go:
        type MediaKind string // "image" | "video" | "audio"
        type JobStatus string // "pending" | "processing" | "done" | "failed"
        type MediaJob struct { ... }
[x] 4. Tạo internal/domain provider interfaces:
        type ImageProvider interface { Generate(req) (*ImageResult, error); Name() string }
        type AudioProvider interface { Generate(req) (*AudioResult, error); Name() string }
        type ImageGenerateRequest struct { Prompt, Model, Style, Quality, APIKey string; W, H int }
[x] 5. Tạo internal/domain/repository.go (interfaces trong domain/media.go)
[x] 6. Tạo migrations/000001_create_media_jobs.up.sql
[x] 7. Implement internal/infra/db/job_repo.go (PostgreSQL + InMemory fallback)
[x] 8. Tạo internal/infra/storage/local_store.go
```

### Acceptance Criteria
- [x] Domain types compile
- [x] Migration chạy clean
- [x] `LocalStore.Save` lưu file vào đúng path

---

## T-3MD-02: Media Service — DALL-E 3 Provider {#t-3md-02}

**Estimate**: 1.5 ngày | **Assignee**: Dev 2 | **Depends on**: T-3MD-01

### Bước thực hiện

```
[x] 1. Tạo internal/infra/provider/providers.go — DalleProvider
[x] 2. Implement Generate:
        POST https://api.openai.com/v1/images/generations
        Parse response: data[0].url → download → save
[x] 3. Retry logic: 3 lần với exponential backoff (429, 500, 502)
[x] 4. Tạo ProviderRegistry trong providers.go
[ ] 5. Unit tests với httptest.Server mock
[x] 6. Stub: stability.go → return not implemented (via registry miss)
```

### Acceptance Criteria
- [x] Generate với valid API key → returns ImageResult
- [x] Invalid API key → wrapped error với status 401
- [x] Rate limit (429) → retry 3 lần

---

## T-3MD-03: Media Service — OpenAI TTS Provider {#t-3md-03}

**Estimate**: 1 ngày | **Assignee**: Dev 2 | **Depends on**: T-3MD-01

### Bước thực hiện

```
[x] 1. Tạo internal/infra/provider/providers.go — OpenAITTSProvider
[x] 2. AudioGenerateRequest: { Text, Voice, Model, APIKey string; Speed float64 }
[x] 3. Implement Generate:
        POST https://api.openai.com/v1/audio/speech
        Stream response → save as MP3
[x] 4. Register vào ProviderRegistry
[ ] 5. Unit tests với mock server
```

### Acceptance Criteria
- [x] Generate TTS → MP3 file saved locally
- [x] Supported voices: alloy, echo, fable, onyx, nova, shimmer
- [x] Invalid model → clear error message

---

## T-3MD-04: Media Service — Worker Pool + Use Cases {#t-3md-04}

**Estimate**: 2 ngày | **Assignee**: Dev 2 | **Depends on**: T-3MD-02, T-3MD-03

### Bước thực hiện

```
[x] 1. Tạo internal/usecase/generate_usecase.go — GenerateImageUseCase
        - Create pending job
        - Dispatch to goroutine pool (semaphore chan)
        - Return job immediately (non-blocking)
[x] 2. Background processJob:
        - Acquire semaphore (max 5 concurrent)
        - Call provider.Generate
        - Save to storage
        - Update job status
[x] 3. GenerateAudioUseCase (tương tự)
[x] 4. JobUseCase: GetJob, ListJobs
[ ] 5. Unit tests với mock provider + mock storage
```

### Acceptance Criteria
- [x] `Execute` trả về job với status "pending" immediately
- [x] Background goroutine cập nhật job status thành "done"
- [x] Max 5 concurrent jobs enforced
- [ ] `go test -race` pass (cần unit test)

---

## T-3MD-05: Media Service — HTTP Server {#t-3md-05}

**Estimate**: 1.5 ngày | **Assignee**: Dev 2 | **Depends on**: T-3MD-04

### Bước thực hiện

```
[x] 1. Tạo internal/adapter/http/handler.go
        - POST /api/v1/media/generate/image
        - POST /api/v1/media/generate/audio
        - GET  /api/v1/media/jobs/:id
        - GET  /api/v1/media/jobs
[x] 2. Tạo cmd/main.go — wire up DI
[x] 3. Thêm media-service vào go.work
[ ] 4. Thêm media-service vào docker-compose.local.yml
[ ] 5. E2E test: generate image → poll job → download result
```

### Acceptance Criteria
- [x] HTTP server start trên port 8083
- [x] Generate image job → status "pending" → eventually "done" (background)
- [ ] Docker Compose integration test pass

---

## T-3TL-01: Telemetry Service — NATS Consumer + PostHog {#t-3tl-01}

**Estimate**: 3 ngày | **Assignee**: Dev 3 | **Depends on**: T-1CF-04

### Bước thực hiện

```
[x] 1. Tạo services/telemetry-service/ với go.mod
[x] 2. Cấu trúc thư mục
[x] 3. Tạo internal/domain/event.go:
        type TelemetryEvent struct { Name, InstallationID string; Properties map[string]any; Timestamp time.Time }
        func StripSensitiveContent(props) map[string]any
[x] 4. Tạo internal/infra/posthog/client.go:
        func (c *PostHogClient) Track(distinctID, event string, properties map[string]any) error
[x] 5. Tạo internal/infra/nats/consumer.go:
        Subscribe "od.>" (wildcard)
        Route: od.run.completed → RunsTotal/RunDuration + PostHog
               od.project.created → ProjectsTotal + PostHog
               od.media.completed → MediaGenerationsTotal + PostHog
               od.mcp.tool_called → MCPToolCallsTotal + PostHog
[x] 6. TelemetryConfig: Enabled + ContentEnabled privacy flags
[x] 7. cmd/main.go — wire up, start HTTP server (port 9090)
[x] 8. Thêm telemetry-service vào go.work
```

### Acceptance Criteria
- [x] NATS consumer nhận events từ các services
- [x] PostHog track gọi thành công
- [x] Privacy: khi TelemetryEnabled=false → không gọi PostHog
- [x] Privacy: khi TelemetryContent=false → strip content từ properties
- [x] Service start bình thường khi PostHog unavailable

---

## T-3TL-02: Telemetry Service — Prometheus Metrics {#t-3tl-02}

**Estimate**: 2 ngày | **Assignee**: Dev 3 | **Depends on**: T-3TL-01

### Bước thực hiện

```
[x] 1. Tạo internal/infra/prometheus/metrics.go:
        - RunsTotal: CounterVec (labels: agent_id, status)
        - RunDuration: HistogramVec (labels: agent_id)
        - ProjectsTotal: Gauge
        - MCPToolCallsTotal: CounterVec (labels: tool_name, status)
        - MediaGenerationsTotal: CounterVec (labels: provider, kind, status)
[x] 2. Update NATS consumer để update metrics cùng với PostHog tracking
[x] 3. Expose /metrics endpoint (Prometheus scrape):
        HTTP server trên port HTTP_PORT (default 9090)
        GET /metrics → prometheus text format
[ ] 4. Docker compose: expose port 9090
[ ] 5. Tạo Prometheus scrape config example
```

### Acceptance Criteria
- [x] `GET http://localhost:9090/metrics` → valid Prometheus text format
- [x] `open_design_runs_total` tăng khi run completed event đến
- [x] Metrics persist khi NATS tạm disconnect (in-memory counter)
