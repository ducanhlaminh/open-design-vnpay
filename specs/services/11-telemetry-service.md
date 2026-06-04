# 11 — Telemetry Service

> **Port gRPC**: 8090  
> **Domain**: Product analytics, LLM tracing, Prometheus metrics

---

## 1. Vai trò & Trách nhiệm

Thay thế telemetry logic rải rác trong `server.ts` và `telemetry-worker/`:

- **PostHog analytics**: UI events, funnels, user behavior (khi telemetry bật)
- **Langfuse tracing**: LLM run traces, cost tracking, latency
- **Prometheus metrics**: System metrics (request count, latency, errors)
- **Privacy enforcement**: Tôn trọng `telemetry_enabled` từ Config Service
- **Async batching**: Events được buffer và flush theo batch để không block

---

## 2. Cấu trúc thư mục

```
telemetry-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── event.go              # TelemetryEvent entity
│   │   └── trace.go              # LLMTrace entity
│   │
│   ├── usecase/
│   │   ├── analytics_usecase.go  # Track UI events → PostHog
│   │   ├── trace_usecase.go      # Record LLM traces → Langfuse
│   │   └── metrics_usecase.go    # Record system metrics → Prometheus
│   │
│   ├── infra/
│   │   ├── posthog/
│   │   │   └── posthog_client.go
│   │   ├── langfuse/
│   │   │   └── langfuse_client.go
│   │   ├── prometheus/
│   │   │   └── metrics.go        # Prometheus collectors
│   │   └── queue/
│   │       └── nats_consumer.go  # NATS JetStream consumer
│   │
│   └── delivery/
│       ├── grpc/
│       │   └── handler.go
│       └── http/
│           ├── metrics.go        # /metrics endpoint (Prometheus scrape)
│           └── health.go
│
├── proto/
│   └── telemetry/v1/telemetry.proto
└── Dockerfile
```

---

## 3. Event Flow (Async)

```
Other Services → NATS JetStream (publish events)
                        │
                        ▼
             Telemetry Service (NATS consumer)
                        │
             ┌──────────┼───────────┐
             ▼          ▼           ▼
          PostHog    Langfuse   Prometheus
          (if         (if        (always)
        enabled)    enabled)
```

---

## 4. Domain Events Consumed

| Event | Source | Action |
|-------|--------|--------|
| `project.created` | Project Service | PostHog track |
| `project.deleted` | Project Service | PostHog track |
| `run.created` | Agent Service | PostHog track + Langfuse trace start |
| `run.completed` | Agent Service | PostHog track + Langfuse trace end |
| `run.failed` | Agent Service | PostHog track + Langfuse error |
| `media.generated` | Media Service | PostHog track |
| `design_system.imported` | DS Service | PostHog track |
| `plugin.executed` | Plugin Service | PostHog track |

---

## 5. Privacy Rules

```go
// usecase/analytics_usecase.go
func (uc *AnalyticsUseCase) Track(ctx context.Context, event *domain.TelemetryEvent) error {
    // Always check privacy setting first
    config, _ := uc.configClient.GetAppConfig(ctx)
    if !config.TelemetryEnabled {
        return nil // silently drop
    }

    // Strip content if telemetry_content = false
    if !config.TelemetryContent {
        event.Properties = stripContent(event.Properties)
    }

    return uc.posthog.Track(config.InstallationID, event)
}
```

---

## 6. Prometheus Metrics Exposed

```
# Run metrics
open_design_runs_total{agent_id, status} counter
open_design_run_duration_seconds{agent_id} histogram
open_design_runs_active gauge

# API Gateway metrics
open_design_http_requests_total{method, path, status} counter
open_design_http_request_duration_seconds{method, path} histogram

# Project metrics
open_design_projects_total gauge
open_design_conversations_total gauge

# Media generation metrics
open_design_media_jobs_total{kind, provider, status} counter
open_design_media_job_duration_seconds{kind, provider} histogram

# Error rates
open_design_errors_total{service, code} counter
```

---

## 7. gRPC Protocol

```protobuf
syntax = "proto3";
package telemetry.v1;

service TelemetryService {
    // Direct gRPC calls (for low-latency critical events)
    rpc TrackEvent(TrackEventRequest) returns (google.protobuf.Empty);
    rpc RecordTrace(RecordTraceRequest) returns (google.protobuf.Empty);
    rpc RecordMetric(RecordMetricRequest) returns (google.protobuf.Empty);
}

message TrackEventRequest {
    string event_name = 1;
    bytes  properties_json = 2;
    google.protobuf.Timestamp occurred_at = 3;
}

message RecordTraceRequest {
    string run_id = 1;
    string agent_id = 2;
    string model = 3;
    int64  input_tokens = 4;
    int64  output_tokens = 5;
    int64  duration_ms = 6;
    float  cost_usd = 7;
    bool   is_error = 8;
}
```

---

## 8. Langfuse Trace Schema

```go
// LLM run → Langfuse trace
type LangfuseTrace struct {
    TraceID    string    // run ID
    Name       string    // e.g., "claude-code-run"
    Input      string    // user prompt (if content telemetry enabled)
    Output     string    // agent response (if content telemetry enabled)
    Model      string
    Usage      struct {
        InputTokens  int
        OutputTokens int
    }
    Cost        float64
    Duration    time.Duration
    Tags        []string
}
```
