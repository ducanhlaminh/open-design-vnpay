# DEV-09 — Skill Service + DEV-10 — Config Service + DEV-11 — Telemetry Service

---

# DEV-09 — Skill Service: Tái sử dụng từ `prompt-registry-service`

> **Chiến lược**: 🔄 **Tái sử dụng một phần** — Pattern registry từ `prompt-registry-service`  
> **Nguồn**: `services/prompt-registry-service/` (pattern)  
> **Spec tham chiếu**: `specs/services/09-skill-service.md`

## 1. Phân tích

`prompt-registry-service` là registry cho AI prompts (key-value với versioning). Skill Service cần tương tự nhưng:
- Load từ **YAML/JSON files** (không chỉ DB)
- Expose **system_prompt** content (để inject vào agent)
- Serve qua **gRPC** (không chỉ HTTP)

## 2. Chiến lược

**Không nâng cấp** `prompt-registry-service` vì nó phục vụ mục đích khác (admin prompt management).
**Tạo service mới** `skill-service` với codebase nhỏ gọn, tái sử dụng **database pattern** từ prompt registry.

## 3. Cấu trúc (Nhỏ gọn)

```
services/skill-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── skill.go             ← Skill entity
│   │   └── repository.go
│   ├── usecase/
│   │   ├── catalog_usecase.go   ← ListSkills, GetSkill
│   │   └── context_usecase.go   ← GetSkillContext (system_prompt)
│   └── infra/
│       ├── fs/
│       │   └── skill_loader.go  ← Load YAML/JSON từ skills/ directory
│       └── adapter/grpc/
│           └── handler.go
├── api/proto/skill/v1/
│   └── skill.proto
├── Dockerfile
└── go.mod
```

## 4. Skill Loader (Core Logic)

```go
// internal/infra/fs/skill_loader.go
type SkillLoader struct {
    skillsPath string // OD_SKILLS_PATH
    cache      sync.Map
}

func (l *SkillLoader) LoadAll() ([]*domain.Skill, error) {
    return filepath.WalkDir(l.skillsPath, func(path string, d fs.DirEntry, err error) error {
        if !strings.HasSuffix(path, ".yaml") { return nil }
        // Parse YAML → Skill entity
        // Cache in sync.Map
    })
}
```

## 5. gRPC Protocol

```protobuf
service SkillService {
    rpc ListSkills(ListSkillsRequest) returns (ListSkillsResponse);
    rpc GetSkill(GetSkillRequest) returns (Skill);
    rpc GetSkillContext(GetSkillContextRequest) returns (SkillContext);
}

message SkillContext {
    string skill_id = 1;
    string system_prompt = 2;
}
```

## 6. Effort Estimate: **5 ngày**

---

# DEV-10 — Config Service: Tách từ `preview-identity`

> **Chiến lược**: 🆕 **Tạo mới** — Tách secrets logic từ `preview-identity`  
> **Nguồn**: `services/preview-identity/` (một phần secrets handling)  
> **Spec tham chiếu**: `specs/services/10-config-service.md`

## 1. Phân tích

`preview-identity` hiện tại có:
- `entity/mcp_key.go` — MCP API key management (giữ ở Identity)
- `entity/user.go` — User management (giữ ở Identity)
- **Không có** secrets storage cho LLM API keys

Config Service cần tạo mới để:
- Lưu LLM API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
- Lưu media provider keys (DALL-E, ElevenLabs, ...)
- App config (telemetry, installationId, ...)
- Phân phối keys cho services khác qua gRPC

## 2. Cấu trúc

```
services/config-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── app_config.go        ← AppConfig entity
│   │   ├── secret.go            ← Secret entity (encrypted)
│   │   └── repository.go
│   ├── usecase/
│   │   ├── config_usecase.go    ← GetConfig, UpdateConfig
│   │   ├── secret_usecase.go    ← GetSecret, SetSecret (AES-256-GCM)
│   │   └── media_config_usecase.go
│   └── infra/
│       ├── db/
│       │   ├── postgres.go
│       │   ├── config_repo.go
│       │   └── secret_repo.go
│       └── crypto/
│           └── aes_gcm.go       ← AES-256-GCM encryption
├── api/proto/config/v1/
│   └── config.proto
├── Dockerfile
└── go.mod
```

## 3. Security Model

```go
// internal/infra/crypto/aes_gcm.go
// Key derivation: HKDF(ENCRYPTION_KEY + machine_id) → 32-byte AES key

type AESGCMEncryptor struct {
    key [32]byte
}

func (e *AESGCMEncryptor) Encrypt(plaintext string) ([]byte, error) {
    // AES-256-GCM với random nonce
    // Output: nonce + ciphertext
}

func (e *AESGCMEncryptor) Decrypt(ciphertext []byte) (string, error) {
    // Extract nonce, decrypt
}
```

## 4. gRPC Protocol

```protobuf
service ConfigService {
    // Public (exposed via Gateway → Frontend)
    rpc GetAppConfig(Empty) returns (AppConfig);
    rpc UpdateAppConfig(UpdateAppConfigRequest) returns (AppConfig);
    rpc GetMediaConfig(Empty) returns (MediaConfig);
    rpc UpdateMediaConfig(UpdateMediaConfigRequest) returns (MediaConfig);

    // Internal only (NOT exposed via Gateway)
    rpc GetSecret(GetSecretRequest) returns (GetSecretResponse);
    rpc SetSecret(SetSecretRequest) returns (Empty);
    rpc DeleteSecret(DeleteSecretRequest) returns (Empty);
    rpc ListSecretKeys(Empty) returns (ListSecretKeysResponse);
}

message GetSecretResponse {
    string value = 1;    // plaintext (internal only)
    string key_tail = 2; // last 4 chars (safe for frontend)
}
```

## 5. Database Schema

```sql
CREATE TABLE app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE secrets (
    key            TEXT PRIMARY KEY,
    encrypted_val  BYTEA NOT NULL,
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Seed dữ liệu default
INSERT INTO app_config VALUES
    ('installation_id', gen_random_uuid()::text, NOW()),
    ('telemetry_enabled', 'true', NOW()),
    ('onboarding_completed', 'false', NOW());
```

## 6. Effort Estimate: **8 ngày**

---

# DEV-11 — Telemetry Service: Tạo mới

> **Chiến lược**: 🆕 **Tạo mới**  
> **Spec tham chiếu**: `specs/services/11-telemetry-service.md`

## 1. Phân tích

Hiện tại không có centralized telemetry service. Metrics rải rác trong từng service (mỗi service có `metrics.go` riêng). Telemetry Service sẽ:
- **Collect** events từ NATS JetStream
- **Forward** đến PostHog (analytics)
- **Forward** đến Langfuse (LLM tracing)
- **Expose** `/metrics` cho Prometheus scraping

## 2. Cấu trúc (Nhỏ gọn)

```
services/telemetry-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── event.go             ← TelemetryEvent
│   │   └── trace.go             ← LLMTrace
│   ├── usecase/
│   │   ├── analytics_usecase.go ← PostHog tracking (với privacy check)
│   │   ├── trace_usecase.go     ← Langfuse tracing
│   │   └── metrics_usecase.go   ← Prometheus metrics update
│   └── infra/
│       ├── posthog/
│       │   └── client.go        ← PostHog Go SDK wrapper
│       ├── langfuse/
│       │   └── client.go        ← Langfuse HTTP API client
│       ├── prometheus/
│       │   └── metrics.go       ← Prometheus collectors
│       └── nats/
│           └── consumer.go      ← NATS JetStream consumer
├── api/proto/telemetry/v1/
│   └── telemetry.proto
└── go.mod
```

## 3. NATS Consumer

```go
// internal/infra/nats/consumer.go
type EventConsumer struct {
    js              nats.JetStreamContext
    analyticsUC     *AnalyticsUseCase
    traceUC         *TraceUseCase
    metricsUC       *MetricsUseCase
}

func (c *EventConsumer) Start(ctx context.Context) error {
    // Subscribe to all od.* subjects
    c.js.Subscribe("od.>", func(msg *nats.Msg) {
        subject := msg.Subject
        switch {
        case subject == "od.run.completed":
            var event RunCompletedEvent
            json.Unmarshal(msg.Data, &event)
            c.analyticsUC.TrackRunCompleted(ctx, &event)
            c.traceUC.RecordLLMTrace(ctx, &event)
            c.metricsUC.IncrRunCompleted(event.AgentID)
        case subject == "od.project.created":
            // ...
        }
        msg.Ack()
    }, nats.Durable("telemetry-svc"))
}
```

## 4. Privacy Enforcement

```go
// usecase/analytics_usecase.go
func (uc *AnalyticsUseCase) Track(ctx context.Context, event *TelemetryEvent) error {
    config, _ := uc.configClient.GetAppConfig(ctx)

    // Privacy check
    if !config.TelemetryEnabled {
        return nil // silently drop
    }
    if !config.TelemetryContent {
        event.Properties = stripSensitiveContent(event.Properties)
    }

    return uc.posthog.Track(config.InstallationID, event.Name, event.Properties)
}
```

## 5. Prometheus Metrics

```go
// internal/infra/prometheus/metrics.go
var (
    RunsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "open_design_runs_total",
        Help: "Total number of agent runs",
    }, []string{"agent_id", "status"})

    RunDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "open_design_run_duration_seconds",
        Help:    "Agent run duration",
        Buckets: prometheus.DefBuckets,
    }, []string{"agent_id"})

    ProjectsTotal = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "open_design_projects_total",
    })
)
```

**Lưu ý**: Gateway đã có `go.uber.org/prometheus` setup. Telemetry Service chỉ cần expose `/metrics` endpoint của riêng mình.

## 6. Effort Estimate: **7 ngày**

---

# DEV-12 — Go Monorepo Setup

> **Chiến lược**: 🆕 **Tạo mới** — Cấu trúc monorepo cho Open Design Go backend

## 1. Lý do

Hiện tại mỗi service có `go.mod` riêng biệt. Để:
- Chia sẻ proto generated code
- Chia sẻ shared packages (grpc utilities, crypto, health)
- Đồng nhất versioning

## 2. Cấu trúc Đề xuất

**Tùy chọn A**: Go workspace (`go.work`) — ít xâm phạm nhất

```
# go.work (tại services/ root)
go 1.23

use (
    ./preview-gateway
    ./preview-project
    ./preview-identity
    ./preview-ai-agent
    ./preview-content
    ./preview-design
    # ... tất cả services hiện có
    ./agent-service       # mới
    ./design-system-svc   # mới
    ./media-service       # mới
    ./plugin-service      # mới
    ./mcp-service         # mới
    ./memory-service      # mới
    ./skill-service       # mới
    ./config-service      # mới
    ./telemetry-service   # mới
    ../shared             # shared packages
)
```

**Tùy chọn B**: Single `go.mod` (monorepo thực sự)
- Xâm phạm nhiều hơn, cần refactor tất cả imports
- Tốt hơn cho long-term

**Khuyến nghị**: Bắt đầu với **Tùy chọn A** (Go workspace) để ít xáo trộn nhất.

## 3. Shared Packages

```
services/shared/
├── go.mod                    # module: open-design/shared
├── grpcutil/
│   ├── client.go             ← NewGRPCClient với retry + tracing
│   └── server.go             ← NewGRPCServer với interceptors
├── dbutil/
│   ├── postgres.go           ← NewPostgresDB với pool config
│   └── sqlite.go             ← NewSQLiteDB
├── natsutil/
│   └── jetstream.go          ← NewNATSJetStream
├── crypto/
│   └── aes_gcm.go            ← AES-256-GCM (tái sử dụng trong Config Service)
├── health/
│   └── handler.go            ← Standard /health endpoint
└── version/
    └── version.go            ← Build version injection
```

## 4. Proto Code Generation

```bash
# deploy/scripts/proto-gen.sh
#!/bin/bash
# Generate Go code từ tất cả .proto files

PROTO_DIRS=(
    "agent/v1"
    "design_system/v1"
    "media/v1"
    "plugin/v1"
    "mcp/v1"
    "memory/v1"
    "skill/v1"
    "config/v1"
    "telemetry/v1"
)

for dir in "${PROTO_DIRS[@]}"; do
    protoc --go_out=. --go-grpc_out=. \
        --proto_path=. \
        "api/proto/${dir}/*.proto"
done
```

## 5. Effort Estimate: **3 ngày**

---

## 6. Acceptance Criteria

### DEV-09: Skill Service
- [x] `GET /api/v1/skills` trả về builtin skills catalog
- [x] `GET /api/v1/skills/:id` trả về skill detail
- [x] `GET /api/v1/skills/:id/context` trả về skill context (prompt template)
- [x] Skill YAML files được load từ skills/ directory
- [x] Docker build + compose profile `od`

### DEV-10: Config Service
- [x] `GET /api/v1/app-config` trả về public config (key names, không có values)
- [x] `POST /api/v1/keys/:key` set API key (encrypted in DB)
- [x] `GET /internal/keys/:key` internal-only key retrieval
- [x] Postgres persistence với AES encryption
- [x] Docker build + compose profile `od`

### DEV-11: Telemetry Service
- [x] OpenTelemetry OTLP collector endpoint `/v1/traces`, `/v1/metrics`, `/v1/logs`
- [x] Prometheus scrape endpoint `/metrics`
- [x] Service registry cho health aggregation
- [x] Docker build + compose profile `od`

### DEV-12: Go Monorepo Setup
- [x] `services/go.work` khai báo tất cả modules
- [x] Tất cả services build thành công từ go.work context
- [x] `deploy/local/docker-compose.yaml` có profile `od` cho tất cả OD services
- [x] `deploy/local/smoke-test.sh` verify health của tất cả services
