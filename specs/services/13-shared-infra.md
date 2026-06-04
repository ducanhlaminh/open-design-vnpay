# 13 — Shared Infrastructure

> Database, Message Queue, Service Discovery, Observability Stack

---

## 1. Database Strategy

### 1.1 Local Mode (SQLite)

Mỗi service dùng SQLite riêng, lưu ở `~/.open-design/{service}/data.db`:

```
~/.open-design/
├── project-svc/
│   └── data.db
├── agent-svc/
│   └── data.db        ← Không có (dùng Redis)
├── design-system-svc/
│   └── data.db
├── media-svc/
│   └── data.db
├── plugin-svc/
│   └── data.db
├── mcp-svc/
│   └── data.db
├── memory-svc/
│   └── data.db        ← SQLite + sqlite-vec
├── skill-svc/
│   └── data.db
└── config-svc/
    └── data.db
```

### 1.2 Production Mode (PostgreSQL)

Mỗi service có **schema riêng** trong cùng PostgreSQL instance (hoặc PostgreSQL instance riêng):

```sql
-- Separate schemas for isolation
CREATE SCHEMA project_svc;
CREATE SCHEMA design_system_svc;
CREATE SCHEMA media_svc;
CREATE SCHEMA plugin_svc;
CREATE SCHEMA mcp_svc;
CREATE SCHEMA memory_svc;   -- cần pgvector extension
CREATE SCHEMA skill_svc;
CREATE SCHEMA config_svc;

-- Enable pgvector for memory service
CREATE EXTENSION IF NOT EXISTS vector;
```

### 1.3 Connection Pool

```go
// shared/db/postgres.go — dùng trong mỗi service
func NewPostgresDB(cfg *DatabaseConfig) (*gorm.DB, error) {
    sqlDB, err := sql.Open("pgx", cfg.DSN)
    sqlDB.SetMaxOpenConns(cfg.MaxOpenConns)     // default: 25
    sqlDB.SetMaxIdleConns(cfg.MaxIdleConns)     // default: 5
    sqlDB.SetConnMaxLifetime(5 * time.Minute)

    return gorm.Open(postgres.New(postgres.Config{
        Conn: sqlDB,
    }), &gorm.Config{
        Logger: NewGORMLogger(),
    })
}
```

### 1.4 Migrations

Mỗi service tự quản lý migrations của mình bằng **golang-migrate**:

```
infra/db/migrations/
├── 000001_create_projects.up.sql
├── 000001_create_projects.down.sql
├── 000002_create_conversations.up.sql
└── ...
```

```go
// Run on startup
func RunMigrations(db *sql.DB, migrationsPath string) error {
    m, err := migrate.New("file://"+migrationsPath, dbURL)
    return m.Up()
}
```

---

## 2. Message Queue (NATS JetStream)

### 2.1 Tại sao NATS

| Feature | NATS JetStream | Redis Streams | Kafka |
|---------|---------------|--------------|-------|
| Latency | Microsecond | Low ms | Higher ms |
| Complexity | Low | Low | High |
| Go support | Native | Good | Good |
| Persistence | JetStream | AOF/RDB | Yes |
| Local dev | Single binary | Needs Redis | Heavy |

### 2.2 Streams & Subjects

```
Stream: OPEN_DESIGN
Subjects (topics):
├── od.project.created
├── od.project.deleted
├── od.run.created
├── od.run.completed
├── od.run.failed
├── od.run.cancelled
├── od.media.generated
├── od.design_system.imported
├── od.plugin.executed
└── od.error.occurred
```

### 2.3 Event Bus Interface

```go
// domain/event_bus.go (trong mỗi service)
type EventBus interface {
    Publish(event DomainEvent) error
    Subscribe(subject string, handler EventHandler) error
}

type DomainEvent interface {
    Subject() string  // e.g., "od.project.created"
    Payload() []byte  // JSON
}

// infra/nats/event_bus.go
type NATSEventBus struct {
    js nats.JetStreamContext
}

func (b *NATSEventBus) Publish(event domain.DomainEvent) error {
    _, err := b.js.Publish(event.Subject(), event.Payload())
    return err
}
```

### 2.4 Event Schema

```go
// Ví dụ: RunCompletedEvent
type RunCompletedEvent struct {
    RunID      string    `json:"run_id"`
    ProjectID  string    `json:"project_id"`
    AgentID    string    `json:"agent_id"`
    ExitCode   int       `json:"exit_code"`
    DurationMs int64     `json:"duration_ms"`
    OccurredAt time.Time `json:"occurred_at"`
}

func (e *RunCompletedEvent) Subject() string  { return "od.run.completed" }
func (e *RunCompletedEvent) Payload() []byte  { b, _ := json.Marshal(e); return b }
```

---

## 3. Service Discovery

### 3.1 Local / Docker Compose

Static DNS qua Docker Compose service names:

```yaml
# docker-compose.yml
services:
  gateway:
    environment:
      - PROJECT_SERVICE_ADDR=project-svc:8081
      - AGENT_SERVICE_ADDR=agent-svc:8082
      - DESIGN_SYSTEM_SERVICE_ADDR=design-system-svc:8083
```

### 3.2 Kubernetes

DNS-based service discovery (tự động qua Kubernetes Services):

```yaml
# k8s/services/project-svc.yaml
apiVersion: v1
kind: Service
metadata:
  name: project-svc
  namespace: open-design
spec:
  selector:
    app: project-svc
  ports:
    - port: 8081
      targetPort: 8081
```

Gateway config:
```yaml
upstreams:
  project_service: "project-svc.open-design.svc.cluster.local:8081"
```

---

## 4. gRPC Connection Management

```go
// shared/grpc/client.go
type ClientConfig struct {
    Address    string
    Timeout    time.Duration
    MaxRetries int
    TLSEnabled bool
}

func NewGRPCClient(cfg *ClientConfig) (*grpc.ClientConn, error) {
    opts := []grpc.DialOption{
        grpc.WithBlock(),
        grpc.WithTimeout(cfg.Timeout),
        grpc.WithUnaryInterceptor(retryInterceptor(cfg.MaxRetries)),
        grpc.WithUnaryInterceptor(tracingInterceptor()),
    }

    if cfg.TLSEnabled {
        opts = append(opts, grpc.WithTransportCredentials(credentials.NewTLS(nil)))
    } else {
        opts = append(opts, grpc.WithTransportCredentials(insecure.NewCredentials()))
    }

    return grpc.Dial(cfg.Address, opts...)
}
```

---

## 5. Observability Stack

### 5.1 OpenTelemetry

Mỗi service instrument với OpenTelemetry SDK:

```go
// shared/telemetry/otel.go
func InitOTEL(serviceName, otlpEndpoint string) (*sdktrace.TracerProvider, error) {
    exporter, _ := otlpgrpc.New(ctx,
        otlpgrpc.WithEndpoint(otlpEndpoint),
        otlpgrpc.WithInsecure(),
    )

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceName(serviceName),
        )),
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp, nil
}
```

### 5.2 Logging Convention

```go
// shared/logging/logger.go — structured logging với slog
func NewLogger(serviceName, level string) *slog.Logger {
    opts := &slog.HandlerOptions{Level: parseLevel(level)}
    handler := slog.NewJSONHandler(os.Stdout, opts)
    return slog.New(handler).With("service", serviceName)
}

// Usage
slog.InfoContext(ctx, "run started",
    "run_id", run.ID,
    "project_id", run.ProjectID,
    "agent_id", run.AgentID,
)
```

### 5.3 Health Check Standard

Mỗi service expose `/health` endpoint:

```go
// delivery/http/health.go
type HealthResponse struct {
    Status    string            `json:"status"`     // "ok" | "degraded" | "unhealthy"
    Service   string            `json:"service"`
    Version   string            `json:"version"`
    Uptime    string            `json:"uptime"`
    Checks    map[string]string `json:"checks"`     // "db": "ok", "nats": "ok"
}

func HealthHandler(db *gorm.DB, nats *nats.Conn) echo.HandlerFunc {
    return func(c echo.Context) error {
        checks := map[string]string{}

        if err := db.Raw("SELECT 1").Error; err != nil {
            checks["db"] = "unhealthy: " + err.Error()
        } else {
            checks["db"] = "ok"
        }

        status := "ok"
        for _, v := range checks {
            if v != "ok" { status = "degraded"; break }
        }

        return c.JSON(200, HealthResponse{
            Status:  status,
            Service: "project-svc",
            Version: version.Build,
            Checks:  checks,
        })
    }
}
```

---

## 6. Shared Packages

```
shared/                 ← Go module: github.com/vnpay/open-design/shared
├── grpc/
│   ├── client.go       # gRPC client factory
│   └── server.go       # gRPC server factory with interceptors
├── db/
│   ├── postgres.go     # PostgreSQL connection
│   └── sqlite.go       # SQLite connection
├── nats/
│   └── jetstream.go    # NATS JetStream connection
├── telemetry/
│   ├── otel.go         # OpenTelemetry init
│   └── prometheus.go   # Prometheus registry
├── logging/
│   └── logger.go       # Structured logger
├── crypto/
│   └── aes.go          # AES-256-GCM encryption
├── uid/
│   └── uid.go          # UUID generation (crypto/rand based)
└── health/
    └── handler.go      # Standard health check handler
```

Các services import shared qua Go modules:

```go
// go.mod của từng service
require (
    github.com/vnpay/open-design/shared v0.1.0
)
```
