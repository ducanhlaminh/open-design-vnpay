# DEV-05 — Media Service: Tạo mới hoàn toàn

> **Chiến lược**: 🆕 **Tạo mới** — Không có codebase tương đương  
> **Spec tham chiếu**: `specs/services/05-media-service.md`

---

## 1. Lý do Tạo Mới

Trong codebase hiện tại **không có service nào** phụ trách image/video/audio generation.
`preview-ai-agent` có gọi AI APIs nhưng chỉ cho text generation (document creation), không phải media.

---

## 2. Cấu trúc Thư mục (Tạo Mới)

```
services/media-service/          ← TẠO MỚI
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── media_job.go         ← MediaJob entity
│   │   ├── provider.go          ← ImageProvider, VideoProvider, AudioProvider interfaces
│   │   ├── errors.go
│   │   └── repository.go
│   │
│   ├── usecase/
│   │   ├── generate_image.go    ← GenerateImage use case
│   │   ├── generate_video.go    ← GenerateVideo use case
│   │   ├── generate_audio.go    ← GenerateAudio use case
│   │   └── job_usecase.go       ← GetJob, ListJobs
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── postgres.go
│   │   │   └── job_repo.go
│   │   ├── storage/
│   │   │   ├── local_store.go   ← Save to local filesystem
│   │   │   └── s3_store.go      ← Save to S3 (future)
│   │   └── provider/
│   │       ├── registry.go      ← Provider registry + fallback
│   │       ├── dalle.go         ← OpenAI DALL-E 3
│   │       ├── stability.go     ← Stability AI
│   │       ├── replicate.go     ← Replicate (Flux, SDXL)
│   │       ├── elevenlabs.go    ← ElevenLabs TTS
│   │       └── openai_tts.go    ← OpenAI TTS
│   │
│   └── adapter/
│       ├── grpc/
│       │   └── handler.go       ← gRPC server
│       └── http/
│           └── health.go
│
├── api/proto/media/v1/
│   └── media.proto
├── migrations/
│   └── 000001_create_media_jobs.up.sql
├── configs/
│   └── config.yaml
├── Dockerfile
├── Makefile
└── go.mod
```

---

## 3. Domain Model

### 3.1 MediaJob Entity

```go
// internal/domain/media_job.go
type MediaJob struct {
    ID           string
    Kind         MediaKind      // "image" | "video" | "audio"
    Provider     string         // "dalle3" | "stability" | "elevenlabs" | ...
    Prompt       string
    Config       map[string]any // resolution, style, voice, etc.
    Status       JobStatus      // "pending" | "processing" | "done" | "failed"
    ResultURL    string         // relative URL to access result
    StoragePath  string         // absolute local path
    ErrorMsg     string
    DurationMs   int64
    CreatedAt    time.Time
    FinishedAt   *time.Time
}

type MediaKind string
const (
    MediaKindImage MediaKind = "image"
    MediaKindVideo MediaKind = "video"
    MediaKindAudio MediaKind = "audio"
)
```

### 3.2 Provider Interfaces

```go
// internal/domain/provider.go
type ImageProvider interface {
    Generate(ctx context.Context, req ImageGenerateRequest) (*ImageResult, error)
    Name() string
}

type ImageGenerateRequest struct {
    Prompt  string
    Width   int
    Height  int
    Style   string      // "vivid" | "natural" | ...
    Quality string      // "standard" | "hd"
    Model   string
    APIKey  string      // injected from Config Service
}

type ImageResult struct {
    URL         string  // URL returned by provider
    LocalPath   string  // path after download
    ContentType string
}
```

---

## 4. Provider Implementations

### 4.1 DALL-E 3 (`infra/provider/dalle.go`)

```go
type DalleProvider struct {
    httpClient *http.Client
}

func (p *DalleProvider) Generate(ctx context.Context, req ImageGenerateRequest) (*ImageResult, error) {
    // POST https://api.openai.com/v1/images/generations
    body := map[string]any{
        "model":   "dall-e-3",
        "prompt":  req.Prompt,
        "n":       1,
        "size":    fmt.Sprintf("%dx%d", req.Width, req.Height),
        "quality": req.Quality,
        "style":   req.Style,
    }
    // ... HTTP call với Authorization: Bearer {req.APIKey}
    // Parse response, download image, save locally
}
```

### 4.2 ElevenLabs (`infra/provider/elevenlabs.go`)

```go
type ElevenLabsProvider struct {
    httpClient *http.Client
}

func (p *ElevenLabsProvider) Generate(ctx context.Context, req AudioGenerateRequest) (*AudioResult, error) {
    // POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
    // Stream response → save to file
}
```

---

## 5. Worker Pool Pattern

```go
// usecase/generate_image.go
type GenerateImageUseCase struct {
    jobRepo      JobRepository
    storage      StorageAdapter
    providerReg  *ProviderRegistry
    configClient ConfigServiceClient  // gRPC → config-service
    workerPool   chan struct{}          // semaphore: max concurrent jobs
    nats         EventBus
}

func (uc *GenerateImageUseCase) Execute(ctx context.Context, req GenerateImageRequest) (*MediaJob, error) {
    // 1. Create job record (status: "pending")
    job := &domain.MediaJob{
        ID:       uuid.New().String(),
        Kind:     domain.MediaKindImage,
        Provider: req.Provider,
        Prompt:   req.Prompt,
        Status:   "pending",
    }
    uc.jobRepo.Create(ctx, job)

    // 2. Dispatch to worker pool (non-blocking)
    go uc.processJob(job, req)

    // 3. Return job ID immediately
    return job, nil
}

func (uc *GenerateImageUseCase) processJob(job *domain.MediaJob, req GenerateImageRequest) {
    // Acquire worker slot
    uc.workerPool <- struct{}{}
    defer func() { <-uc.workerPool }()

    // Get API key from Config Service
    apiKey, _ := uc.configClient.GetSecret(ctx, secretKeyForProvider(req.Provider))

    // Generate
    provider := uc.providerReg.GetImageProvider(req.Provider)
    result, err := provider.Generate(ctx, ImageGenerateRequest{
        Prompt: req.Prompt,
        APIKey: apiKey,
        // ...
    })

    // Update job status
    if err != nil {
        uc.jobRepo.UpdateStatus(ctx, job.ID, "failed", err.Error())
        return
    }

    // Save to storage
    localPath := uc.storage.Save(result)
    uc.jobRepo.UpdateStatus(ctx, job.ID, "done", localPath)
}
```

---

## 6. gRPC Protocol

```protobuf
// api/proto/media/v1/media.proto
syntax = "proto3";
package media.v1;

option go_package = "media-service/api/proto/media/v1;mediav1";

service MediaService {
    rpc GenerateImage(GenerateImageRequest) returns (MediaJob);
    rpc GenerateVideo(GenerateVideoRequest) returns (MediaJob);
    rpc GenerateAudio(GenerateAudioRequest) returns (MediaJob);
    rpc GetJob(GetJobRequest) returns (MediaJob);
    rpc ListJobs(ListJobsRequest) returns (ListJobsResponse);
    rpc ServeMedia(ServeMediaRequest) returns (stream MediaChunk);
}

message GenerateImageRequest {
    string prompt   = 1;
    string provider = 2;    // "dalle3" | "stability" | "replicate"
    string model    = 3;
    int32  width    = 4;
    int32  height   = 5;
    string style    = 6;
    string quality  = 7;
    map<string, string> extra = 8;
}

message MediaJob {
    string id = 1;
    string kind = 2;
    string provider = 3;
    string status = 4;
    string result_url = 5;
    string error_msg = 6;
    google.protobuf.Timestamp created_at = 7;
    optional google.protobuf.Timestamp finished_at = 8;
    int64 duration_ms = 9;
}
```

---

## 7. API Endpoints (qua Gateway)

```
POST   /api/media/generate/image    → MediaService.GenerateImage
POST   /api/media/generate/video    → MediaService.GenerateVideo  
POST   /api/media/generate/audio    → MediaService.GenerateAudio
GET    /api/media/jobs/:id          → MediaService.GetJob
GET    /api/media/jobs              → MediaService.ListJobs
GET    /api/media/config            → ConfigService.GetMediaConfig (không qua Media Service)
PUT    /api/media/config            → ConfigService.UpdateMediaConfig
```

---

## 8. Database Schema

```sql
CREATE TABLE media_jobs (
    id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    kind         TEXT NOT NULL,
    provider     TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    config       JSONB NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL DEFAULT 'pending',
    result_url   TEXT,
    storage_path TEXT,
    error_msg    TEXT,
    duration_ms  BIGINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at  TIMESTAMPTZ
);
```

---

## 9. Supported Providers (Phase 1)

| Kind | Provider | Priority |
|------|---------|---------|
| Image | `dalle3` (OpenAI DALL-E 3) | P1 |
| Image | `stability` (Stability AI) | P2 |
| Image | `replicate` (Flux) | P2 |
| Audio | `openai-tts` (OpenAI TTS) | P1 |
| Audio | `elevenlabs` | P2 |
| Video | `runway` | P3 (future) |

---

## 10. Effort Estimate

| Task | Estimate |
|------|---------|
| Project setup (go.mod, Dockerfile, Makefile) | 0.5 ngày |
| Domain model + interfaces | 1 ngày |
| Use cases + worker pool | 2 ngày |
| DALL-E 3 provider | 1.5 ngày |
| ElevenLabs + OpenAI TTS providers | 1.5 ngày |
| Stability AI + Replicate providers | 2 ngày |
| Local storage adapter | 0.5 ngày |
| gRPC server | 1 ngày |
| Database + migrations | 0.5 ngày |
| Integration với Config Service | 1 ngày |
| Tests | 2 ngày |
| **Tổng** | **14 ngày** |

---

## 11. Acceptance Criteria

- [x] `POST /api/v1/media/generate` tạo job thành công (async)
- [x] `GET /api/v1/media/jobs/:id` trả về job status + result URL
- [x] DALL-E 3 provider hoạt động với API key từ config-service
- [x] OpenAI TTS provider hoạt động
- [x] Job persistence trong PostgreSQL
- [x] Local file storage lưu output files
- [x] Worker pool xử lý concurrent jobs (non-blocking)
- [x] Docker build + docker-compose.yaml thêm media-service profile
- [ ] Stability AI / Replicate providers (Phase 2)
- [ ] ElevenLabs provider (Phase 2)
