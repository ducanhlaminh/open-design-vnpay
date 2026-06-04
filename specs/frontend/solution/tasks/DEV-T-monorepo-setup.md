# DEV-T-12 — Go Monorepo Setup Tasks

> **Service**: Infrastructure — `services/go.work` + `services/shared/`  
> **Effort**: 3 ngày  
> **Sprint**: Sprint 1 (Tuần 1–2)  
> **Ref**: [DEV-09-12-remaining-services.md](../../develop/DEV-09-12-remaining-services.md) section DEV-12

---

## Tổng quan

Setup Go workspace để tất cả services chia sẻ proto generated code và shared utilities, mà không cần restructure toàn bộ imports.

---

## Nhóm A — Go Workspace Setup (Ngày 1)

---

### A01 — Tạo `services/go.work`

**File**: `services/go.work`  
**Effort**: 2h  
**Status**: `[ ]`

```go
// services/go.work
go 1.23

use (
    // === Existing services (giữ nguyên go.mod) ===
    ./preview-gateway
    ./preview-project
    ./preview-identity
    ./preview-ai-agent
    ./preview-content
    ./preview-figma
    ./preview-export
    ./preview-design
    ./preview-mcp
    ./chat-preview-service
    ./prompt-registry-service
    
    // === New Open Design services ===
    ./config-service
    ./skill-service
    ./memory-service
    ./telemetry-service
    
    // === Shared packages ===
    ./shared
)
```

**Checklist**:
- [ ] `go work sync` chạy thành công từ `services/` directory
- [ ] `go build ./...` từ `services/` không có errors
- [ ] Thêm `go.work` và `go.work.sum` vào `.gitignore` (optional — team quyết định)

---

### A02 — Verify Existing Services Build

**Effort**: 1h  
**Status**: `[ ]`

```bash
cd services/
go build ./preview-gateway/... 
go build ./preview-project/...
go build ./preview-ai-agent/...
# Verify không có errors sau khi thêm go.work
```

---

## Nhóm B — Shared Package (Ngày 1–2)

---

### B01 — Khởi tạo `services/shared` module

**File**: `services/shared/go.mod`  
**Effort**: 0.5h  
**Status**: `[ ]`

```
module github.com/open-design/shared

go 1.23
```

---

### B02 — `grpcutil` — gRPC Client/Server Helpers

**File**: `services/shared/grpcutil/`  
**Effort**: 4h  
**Status**: `[ ]`

```go
// services/shared/grpcutil/client.go
package grpcutil

import (
    "context"
    "time"
    
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

type ClientOptions struct {
    Addr            string
    DialTimeout     time.Duration
    MaxRetries      int
    EnableTracing   bool
}

// NewGRPCClient: tạo gRPC client với retry + tracing
func NewGRPCClient(opts ClientOptions) (*grpc.ClientConn, error) {
    ctx, cancel := context.WithTimeout(context.Background(), opts.DialTimeout)
    defer cancel()
    
    var dialOpts []grpc.DialOption
    dialOpts = append(dialOpts, grpc.WithTransportCredentials(insecure.NewCredentials()))
    
    if opts.EnableTracing {
        // OpenTelemetry interceptor
        dialOpts = append(dialOpts, grpc.WithUnaryInterceptor(otelgrpc.UnaryClientInterceptor()))
        dialOpts = append(dialOpts, grpc.WithStreamInterceptor(otelgrpc.StreamClientInterceptor()))
    }
    
    return grpc.DialContext(ctx, opts.Addr, dialOpts...)
}

// services/shared/grpcutil/server.go
// NewGRPCServer: tạo gRPC server với interceptors
func NewGRPCServer(opts ServerOptions) *grpc.Server {
    return grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            recoveryInterceptor(),
            loggingInterceptor(opts.Logger),
            otelgrpc.UnaryServerInterceptor(),
        ),
        grpc.ChainStreamInterceptor(
            otelgrpc.StreamServerInterceptor(),
        ),
    )
}
```

---

### B03 — `health` — Standard Health Endpoint

**File**: `services/shared/health/handler.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
// Standard health check handler — tất cả services dùng chung
package health

import (
    "net/http"
    "time"
)

type HealthHandler struct {
    ServiceName string
    Version     string
    StartTime   time.Time
}

func (h *HealthHandler) Handle(w http.ResponseWriter, r *http.Request) {
    resp := map[string]any{
        "status":  "ok",
        "service": h.ServiceName,
        "version": h.Version,
        "uptime":  time.Since(h.StartTime).String(),
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}
```

---

### B04 — `crypto` — AES-GCM (Tái sử dụng từ Config Service)

**File**: `services/shared/crypto/aes_gcm.go`  
**Effort**: 0.5h  
**Status**: `[ ]`

**Mô tả**: Di chuyển `AESGCMEncryptor` từ `config-service/internal/infra/crypto/` vào `shared/crypto/` để các services khác có thể dùng.

---

### B05 — `natsutil` — NATS JetStream Helper

**File**: `services/shared/natsutil/jetstream.go`  
**Effort**: 2h  
**Status**: `[ ]`

```go
package natsutil

import "github.com/nats-io/nats.go"

type JetStreamOptions struct {
    URL      string
    ClientID string
    Streams  []StreamConfig
}

type StreamConfig struct {
    Name     string
    Subjects []string
}

// NewJetStream: connect + ensure streams exist
func NewJetStream(opts JetStreamOptions) (nats.JetStreamContext, error) {
    nc, err := nats.Connect(opts.URL)
    js, err := nc.JetStream()
    
    for _, s := range opts.Streams {
        js.AddStream(&nats.StreamConfig{
            Name:     s.Name,
            Subjects: s.Subjects,
        })
    }
    
    return js, nil
}
```

---

## Nhóm C — Proto Code Generation (Ngày 2–3)

---

### C01 — Proto Directory Structure

**File**: `services/proto/` (shared proto definitions)  
**Effort**: 1h  
**Status**: `[ ]`

```
services/proto/
├── agent/v1/agent.proto
├── project/v1/project.proto  (extension)
├── config/v1/config.proto
├── skill/v1/skill.proto
├── memory/v1/memory.proto
├── design_system/v1/od_catalog.proto
└── buf.yaml
```

---

### C02 — `buf.yaml` + Proto Generation Script

**File**: `services/proto/buf.yaml`  
**Effort**: 2h  
**Status**: `[ ]`

```yaml
# services/proto/buf.yaml
version: v1
breaking:
  use:
    - FILE
lint:
  use:
    - DEFAULT
```

```bash
# deploy/scripts/proto-gen.sh
#!/bin/bash
set -e

PROTO_ROOT="$(dirname "$0")/../../services/proto"
OUT_ROOT="$(dirname "$0")/../../services"

echo "Generating proto files..."

for proto_file in $(find "$PROTO_ROOT" -name "*.proto"); do
    service_dir=$(echo "$proto_file" | grep -oP '(?<=proto/)[^/]+')
    
    protoc \
        --proto_path="$PROTO_ROOT" \
        --go_out="$OUT_ROOT/$service_dir-service/api/proto" \
        --go_opt=paths=source_relative \
        --go-grpc_out="$OUT_ROOT/$service_dir-service/api/proto" \
        --go-grpc_opt=paths=source_relative \
        "$proto_file"
done

echo "Done!"
```

**Checklist**:
- [ ] Script chạy được từ project root
- [ ] Generated code vào đúng thư mục của từng service
- [ ] `buf lint` pass

---

### C03 — Makefile targets

**File**: `services/Makefile`  
**Effort**: 1h  
**Status**: `[ ]`

```makefile
.PHONY: proto-gen build test lint docker-build

# Generate all proto files
proto-gen:
    @bash deploy/scripts/proto-gen.sh

# Build all services
build:
    go build ./...

# Run all tests
test:
    go test -race ./...

# Lint
lint:
    golangci-lint run ./...

# Docker build all services
docker-build:
    docker build -t open-design/gateway -f preview-gateway/Dockerfile preview-gateway/
    docker build -t open-design/agent-service -f preview-ai-agent/Dockerfile preview-ai-agent/
    docker build -t open-design/project-service -f preview-project/Dockerfile preview-project/
    docker build -t open-design/config-service -f config-service/Dockerfile config-service/
    docker build -t open-design/skill-service -f skill-service/Dockerfile skill-service/
```

---

## Nhóm D — Docker Compose (Ngày 3)

---

### D01 — Docker Compose với Profile `od`

**File**: `deploy/dev/docker-compose.yaml` (MODIFY — thêm services)  
**Effort**: 2h  
**Status**: `[ ]`

```yaml
# Thêm vào docker-compose.yaml với profile "od" (Open Design services)
# Sử dụng: docker compose --profile od up

services:
  # === Open Design Services (profile: od) ===
  
  config-service:
    profiles: [od]
    build:
      context: ../../services/config-service
    ports: ["8089:8089"]
    environment:
      OD_ENCRYPTION_KEY: "${OD_ENCRYPTION_KEY:?error: OD_ENCRYPTION_KEY required}"
      OD_DATABASE_URL: "postgres://od:od@postgres:5432/open_design?sslmode=disable"
    depends_on:
      postgres:
        condition: service_healthy

  agent-service:
    profiles: [od]
    build:
      context: ../../services/preview-ai-agent
    ports: ["8082:8082"]
    environment:
      CONFIG_SERVICE_ADDR: "config-service:8089"
      PROJECT_SERVICE_ADDR: "project-service:8081"
      REDIS_URL: "redis://redis:6379"
      OD_DATABASE_URL: "postgres://od:od@postgres:5432/open_design?sslmode=disable"
    depends_on:
      - config-service
      - redis
      - postgres

  project-service:
    profiles: [od]
    build:
      context: ../../services/preview-project
    ports: ["8081:8081"]
    environment:
      OD_WORKSPACE_ROOT: "/workspace"
      OD_DATABASE_URL: "postgres://od:od@postgres:5432/open_design?sslmode=disable"
    volumes:
      - workspace:/workspace
    depends_on:
      postgres:
        condition: service_healthy

  skill-service:
    profiles: [od]
    build:
      context: ../../services/skill-service
    ports: ["8088:8088"]
    environment:
      OD_SKILLS_PATH: "/skills"
    volumes:
      - ../../skills:/skills:ro

  # === Infrastructure (dùng chung với existing) ===
  postgres:
    # đã có — chỉ thêm database nếu cần
    environment:
      POSTGRES_DB: open_design

  redis:
    image: redis:7-alpine
    # đã có hoặc thêm mới

volumes:
  workspace:
```

---

### D02 — Smoke Test Script

**File**: `deploy/dev/smoke-test.sh`  
**Effort**: 1h  
**Status**: `[ ]`

```bash
#!/bin/bash
# Verify health của tất cả Open Design services

GATEWAY="http://localhost:7456"
CONFIG="http://localhost:8090"
AGENT="http://localhost:8083"
PROJECT="http://localhost:8084"
SKILL="http://localhost:8091"

check_health() {
    local name=$1
    local url=$2
    
    if curl -sf "$url/health" > /dev/null; then
        echo "✅ $name: healthy"
    else
        echo "❌ $name: FAILED"
        exit 1
    fi
}

echo "=== Open Design Services Health Check ==="
check_health "Gateway" "$GATEWAY"
check_health "Config Service" "$CONFIG"
check_health "Agent Service" "$AGENT"
check_health "Project Service" "$PROJECT"
check_health "Skill Service" "$SKILL"

# Functional test
echo ""
echo "=== Functional Tests ==="

# Test config endpoint
if curl -sf "$GATEWAY/api/app-config" | jq '.installationId' > /dev/null; then
    echo "✅ /api/app-config: OK"
else
    echo "❌ /api/app-config: FAILED"
fi

# Test agents
if curl -sf "$GATEWAY/api/agents" | jq '.[0].id' > /dev/null 2>&1; then
    echo "✅ /api/agents: OK"
else
    echo "⚠️  /api/agents: empty (no CLI agents installed)"
fi

echo ""
echo "All checks passed!"
```

---

## Acceptance Criteria (DEV-12)

- [ ] `services/go.work` khai báo tất cả modules
- [ ] `go build ./...` từ `services/` — thành công
- [ ] `go test ./... -race` từ `services/` — pass
- [ ] `services/shared/` module build được
- [ ] `proto-gen` script tạo Go code đúng vị trí
- [ ] `docker compose --profile od up` — tất cả OD services start
- [ ] `deploy/dev/smoke-test.sh` — tất cả health checks pass
