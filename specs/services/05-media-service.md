# 05 — Media Service

> **Port gRPC**: 8084  
> **Domain**: Image, Video, Audio generation via external AI APIs

---

## 1. Vai trò & Trách nhiệm

Thay thế `media.ts` (~105KB) hiện tại:

- **Image generation**: DALL-E 3, Stable Diffusion, Midjourney, Flux, ...
- **Video generation**: Runway, Kling, Sora, ...
- **Audio generation**: ElevenLabs, SenseAudio, OpenAI TTS, ...
- **Job-based processing**: Mỗi generation là một async job (có thể poll status)
- **Provider management**: Switch provider dễ dàng, fallback logic
- **Storage**: Lưu generated assets vào local FS / S3

---

## 2. Cấu trúc thư mục (Clean Architecture)

```
media-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── media_job.go          # MediaJob entity (generation request + result)
│   │   ├── provider.go           # Provider interface + types
│   │   └── repository.go
│   │
│   ├── usecase/
│   │   ├── generate_image_usecase.go
│   │   ├── generate_video_usecase.go
│   │   ├── generate_audio_usecase.go
│   │   └── job_usecase.go        # GetJob, ListJobs
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   └── job_repo.go
│   │   ├── storage/
│   │   │   ├── local_store.go    # Save to local FS
│   │   │   └── s3_store.go       # Save to S3 (prod)
│   │   └── provider/
│   │       ├── dalle.go          # OpenAI DALL-E 3
│   │       ├── stability.go      # Stability AI
│   │       ├── replicate.go      # Replicate (Flux, SDXL, ...)
│   │       ├── runway.go         # Runway video
│   │       ├── kling.go          # Kling video
│   │       ├── elevenlabs.go     # ElevenLabs audio
│   │       ├── senseaudio.go     # SenseAudio multimodal
│   │       └── openai_tts.go     # OpenAI TTS
│   │
│   └── delivery/
│       ├── grpc/
│       │   └── handler.go
│       └── http/
│           └── health.go
│
├── proto/
│   └── media/v1/media.proto
└── Dockerfile
```

---

## 3. Domain Model

```go
// domain/media_job.go
type MediaJob struct {
    ID           string
    Kind         MediaKind    // "image" | "video" | "audio"
    Provider     string       // "dalle3" | "stability" | "runway" | "elevenlabs" | ...
    Prompt       string
    Config       map[string]any // provider-specific params (resolution, style, voice, ...)
    Status       JobStatus    // "pending" | "processing" | "done" | "failed"
    ResultURL    string       // URL to access result
    StoragePath  string       // local path
    ErrorMsg     string
    CreatedAt    time.Time
    FinishedAt   *time.Time
    DurationMs   int64
}

type MediaKind string
const (
    MediaKindImage MediaKind = "image"
    MediaKindVideo MediaKind = "video"
    MediaKindAudio MediaKind = "audio"
)

// domain/provider.go
type ImageProvider interface {
    Generate(ctx context.Context, req ImageRequest) (*ImageResult, error)
    Name() string
}

type VideoProvider interface {
    Generate(ctx context.Context, req VideoRequest) (*VideoResult, error)
    Name() string
}

type AudioProvider interface {
    Generate(ctx context.Context, req AudioRequest) (*AudioResult, error)
    Name() string
}

type ImageRequest struct {
    Prompt     string
    Width      int
    Height     int
    Style      string
    Quality    string
    Model      string
    APIKey     string  // from Config Service
}
```

---

## 4. Provider Registry & Fallback

```go
// infra/provider/registry.go
type ProviderRegistry struct {
    imageProviders map[string]ImageProvider
    videoProviders map[string]VideoProvider
    audioProviders map[string]AudioProvider
}

func (r *ProviderRegistry) GetImageProvider(name string) (ImageProvider, error) {
    if p, ok := r.imageProviders[name]; ok {
        return p, nil
    }
    return nil, ErrProviderNotFound
}

// Fallback chain: if primary fails, try next
func (r *ProviderRegistry) GenerateImageWithFallback(
    ctx context.Context,
    req ImageRequest,
    providers []string,
) (*ImageResult, error) {
    var lastErr error
    for _, name := range providers {
        p, err := r.GetImageProvider(name)
        if err != nil { continue }
        result, err := p.Generate(ctx, req)
        if err == nil { return result, nil }
        lastErr = err
    }
    return nil, lastErr
}
```

---

## 5. Job Flow (Async)

```
POST /api/media/generate  →  Gateway → Media Service
    │
    ▼
GenerateImageUseCase
    ├── Create MediaJob (status: "pending")
    ├── Return job ID immediately
    └── Dispatch to worker pool (goroutine)

Worker pool:
    ├── Call provider API
    ├── Download result
    ├── Store to FS/S3
    ├── Update MediaJob (status: "done", resultURL)
    └── Publish event → Telemetry Service (async)

Client polls:
GET /api/media/jobs/:id  →  GetJob
```

---

## 6. gRPC Protocol Definition

```protobuf
syntax = "proto3";
package media.v1;

service MediaService {
    rpc GenerateImage(GenerateImageRequest) returns (MediaJob);
    rpc GenerateVideo(GenerateVideoRequest) returns (MediaJob);
    rpc GenerateAudio(GenerateAudioRequest) returns (MediaJob);
    rpc GetJob(GetJobRequest) returns (MediaJob);
    rpc ListJobs(ListJobsRequest) returns (ListJobsResponse);
}

message GenerateImageRequest {
    string prompt = 1;
    string provider = 2;      // "dalle3" | "stability" | "replicate"
    string model = 3;
    int32  width = 4;
    int32  height = 5;
    string style = 6;
    string quality = 7;
    map<string, string> extra = 8;
}

message MediaJob {
    string id = 1;
    string kind = 2;          // "image" | "video" | "audio"
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

## 7. Database Schema

```sql
CREATE TABLE media_jobs (
    id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    kind         TEXT NOT NULL,        -- 'image' | 'video' | 'audio'
    provider     TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    config       JSONB NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL DEFAULT 'pending',
    result_url   TEXT,
    storage_path TEXT,
    error_msg    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at  TIMESTAMPTZ,
    duration_ms  BIGINT
);

CREATE INDEX idx_media_jobs_status ON media_jobs(status);
CREATE INDEX idx_media_jobs_kind ON media_jobs(kind);
```

---

## 8. Supported Providers

| Kind | Provider ID | API |
|------|------------|-----|
| Image | `dalle3` | OpenAI DALL-E 3 |
| Image | `stability` | Stability AI |
| Image | `replicate` | Replicate (Flux, SDXL) |
| Image | `midjourney` | Midjourney API |
| Video | `runway` | Runway Gen-3 |
| Video | `kling` | Kling AI |
| Video | `sora` | OpenAI Sora (when available) |
| Audio | `elevenlabs` | ElevenLabs TTS |
| Audio | `openai-tts` | OpenAI TTS |
| Audio | `senseaudio` | SenseAudio multimodal |

---

## 9. Config từ Config Service

Media Service **không** lưu API keys. Mỗi request đến provider, keys được fetch từ Config Service qua gRPC:

```go
func (p *DalleProvider) Generate(ctx context.Context, req ImageRequest) (*ImageResult, error) {
    // key được inject từ Config Service vào req.APIKey
    client := openai.NewClient(req.APIKey)
    // ...
}
```
