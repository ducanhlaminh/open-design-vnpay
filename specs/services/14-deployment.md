# 14 — Deployment

> Docker Compose (local), Kubernetes (production), CI/CD pipeline

---

## 1. Monorepo Layout (Go)

```
open-design-backend/              ← Go monorepo
├── cmd/
│   ├── gateway/
│   │   └── main.go
│   ├── project-svc/
│   │   └── main.go
│   ├── agent-svc/
│   │   └── main.go
│   ├── design-system-svc/
│   │   └── main.go
│   ├── media-svc/
│   │   └── main.go
│   ├── plugin-svc/
│   │   └── main.go
│   ├── mcp-svc/
│   │   └── main.go
│   ├── memory-svc/
│   │   └── main.go
│   ├── skill-svc/
│   │   └── main.go
│   ├── config-svc/
│   │   └── main.go
│   └── telemetry-svc/
│       └── main.go
│
├── internal/
│   ├── gateway/
│   ├── project/
│   ├── agent/
│   ├── design_system/
│   ├── media/
│   ├── plugin/
│   ├── mcp/
│   ├── memory/
│   ├── skill/
│   ├── config/
│   └── telemetry/
│
├── pkg/                          ← shared packages
│   ├── grpcutil/
│   ├── dbutil/
│   ├── natsutil/
│   ├── crypto/
│   └── health/
│
├── proto/                        ← Protobuf definitions (shared)
│   ├── project/v1/
│   ├── agent/v1/
│   ├── design_system/v1/
│   ├── media/v1/
│   ├── plugin/v1/
│   ├── mcp/v1/
│   ├── memory/v1/
│   ├── skill/v1/
│   ├── config/v1/
│   └── telemetry/v1/
│
├── deploy/
│   ├── local/
│   │   └── docker-compose.yml   ← Local development
│   ├── k8s/
│   │   ├── namespace.yaml
│   │   ├── services/            ← K8s Service definitions
│   │   ├── deployments/         ← K8s Deployment definitions
│   │   ├── configmaps/
│   │   └── secrets/
│   └── scripts/
│       ├── build-all.sh
│       └── proto-gen.sh
│
├── go.mod
├── go.sum
├── Makefile
└── Dockerfile.base              ← Base image
```

---

## 2. Docker Compose (Local Development)

```yaml
# deploy/local/docker-compose.yml
version: "3.9"

x-common-env: &common-env
  LOG_LEVEL: "debug"
  NATS_URL: "nats://nats:4222"
  OD_WORKSPACE_ROOT: "/workspace"

services:
  # ─── Infrastructure ───────────────────────────────────────────
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: opendesign
      POSTGRES_PASSWORD: opendesign
      POSTGRES_DB: opendesign
    volumes:
      - postgres-data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U opendesign"]
      interval: 5s

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]

  nats:
    image: nats:2.10-alpine
    command: "-js"    # enable JetStream
    ports:
      - "4222:4222"
      - "8222:8222"   # monitoring

  # ─── Open Design Services ─────────────────────────────────────
  config-svc:
    build:
      context: ../../
      dockerfile: Dockerfile
      args:
        SERVICE: config-svc
    environment:
      <<: *common-env
      GRPC_PORT: "8089"
      DATABASE_URL: "postgres://opendesign:opendesign@postgres/opendesign?search_path=config_svc"
      ENCRYPTION_KEY: "${OD_ENCRYPTION_KEY:-dev-key-change-in-prod}"
    depends_on:
      postgres: { condition: service_healthy }
    ports:
      - "8089:8089"

  project-svc:
    build:
      context: ../../
      dockerfile: Dockerfile
      args:
        SERVICE: project-svc
    environment:
      <<: *common-env
      GRPC_PORT: "8081"
      DATABASE_URL: "postgres://opendesign:opendesign@postgres/opendesign?search_path=project_svc"
    volumes:
      - workspace:/workspace
    depends_on:
      postgres: { condition: service_healthy }
      nats: { condition: service_started }
    ports:
      - "8081:8081"

  agent-svc:
    build:
      context: ../../
      dockerfile: Dockerfile
      args:
        SERVICE: agent-svc
    environment:
      <<: *common-env
      GRPC_PORT: "8082"
      REDIS_URL: "redis://redis:6379"
      PROJECT_SERVICE_ADDR: "project-svc:8081"
      CONFIG_SERVICE_ADDR: "config-svc:8089"
      MEMORY_SERVICE_ADDR: "memory-svc:8087"
      DESIGN_SYSTEM_SERVICE_ADDR: "design-system-svc:8083"
    volumes:
      - workspace:/workspace
      - /usr/local/bin:/usr/local/bin:ro    # access to claude, codex, etc.
    depends_on:
      - project-svc
      - config-svc
      - redis
    ports:
      - "8082:8082"

  design-system-svc:
    build:
      context: ../../
      dockerfile: Dockerfile
      args:
        SERVICE: design-system-svc
    environment:
      <<: *common-env
      GRPC_PORT: "8083"
      DATABASE_URL: "postgres://opendesign:opendesign@postgres/opendesign?search_path=design_system_svc"
      DS_CATALOG_PATH: "/ds-catalog"
    volumes:
      - ../../design-systems:/ds-catalog:ro
    depends_on:
      postgres: { condition: service_healthy }
    ports:
      - "8083:8083"

  media-svc:
    build:
      context: ../../
      dockerfile: Dockerfile
      args:
        SERVICE: media-svc
    environment:
      <<: *common-env
      GRPC_PORT: "8084"
      DATABASE_URL: "postgres://opendesign:opendesign@postgres/opendesign?search_path=media_svc"
      CONFIG_SERVICE_ADDR: "config-svc:8089"
      STORAGE_PATH: "/media-storage"
    volumes:
      - media-storage:/media-storage
    depends_on:
      - config-svc
    ports:
      - "8084:8084"

  plugin-svc:
    build:
      context: ../../
      dockerfile: Dockerfile
      args:
        SERVICE: plugin-svc
    environment:
      <<: *common-env
      GRPC_PORT: "8085"
      DATABASE_URL: "postgres://opendesign:opendesign@postgres/opendesign?search_path=plugin_svc"
      CONFIG_SERVICE_ADDR: "config-svc:8089"
      PLUGINS_PATH: "/plugins"
    volumes:
      - ../../plugins:/plugins:ro
    ports:
      - "8085:8085"

  mcp-svc:
    build:
      context: ../../
      dockerfile: Dockerfile
      args:
        SERVICE: mcp-svc
    environment:
      <<: *common-env
      GRPC_PORT: "8086"
      DATABASE_URL: "postgres://opendesign:opendesign@postgres/opendesign?search_path=mcp_svc"
      PROJECT_SERVICE_ADDR: "project-svc:8081"
      AGENT_SERVICE_ADDR: "agent-svc:8082"
      SKILL_SERVICE_ADDR: "skill-svc:8088"
    ports:
      - "8086:8086"

  memory-svc:
    build:
      context: ../../
      dockerfile: Dockerfile
      args:
        SERVICE: memory-svc
    environment:
      <<: *common-env
      GRPC_PORT: "8087"
      DATABASE_URL: "postgres://opendesign:opendesign@postgres/opendesign?search_path=memory_svc&options=-c%20search_path%3Dmemory_svc"
      CONFIG_SERVICE_ADDR: "config-svc:8089"
    depends_on:
      postgres: { condition: service_healthy }
    ports:
      - "8087:8087"

  skill-svc:
    build:
      context: ../../
      dockerfile: Dockerfile
      args:
        SERVICE: skill-svc
    environment:
      <<: *common-env
      GRPC_PORT: "8088"
      SKILLS_PATH: "/skills"
    volumes:
      - ../../skills:/skills:ro
    ports:
      - "8088:8088"

  telemetry-svc:
    build:
      context: ../../
      dockerfile: Dockerfile
      args:
        SERVICE: telemetry-svc
    environment:
      <<: *common-env
      GRPC_PORT: "8090"
      HTTP_PORT: "9090"
      CONFIG_SERVICE_ADDR: "config-svc:8089"
      POSTHOG_API_KEY: "${OD_POSTHOG_API_KEY:-}"
      LANGFUSE_PUBLIC_KEY: "${OD_LANGFUSE_PUBLIC_KEY:-}"
      LANGFUSE_SECRET_KEY: "${OD_LANGFUSE_SECRET_KEY:-}"
    ports:
      - "8090:8090"
      - "9090:9090"   # Prometheus metrics

  gateway:
    build:
      context: ../../
      dockerfile: Dockerfile
      args:
        SERVICE: gateway
    environment:
      <<: *common-env
      HTTP_PORT: "7456"
      PROJECT_SERVICE_ADDR: "project-svc:8081"
      AGENT_SERVICE_ADDR: "agent-svc:8082"
      DESIGN_SYSTEM_SERVICE_ADDR: "design-system-svc:8083"
      MEDIA_SERVICE_ADDR: "media-svc:8084"
      PLUGIN_SERVICE_ADDR: "plugin-svc:8085"
      MCP_SERVICE_ADDR: "mcp-svc:8086"
      MEMORY_SERVICE_ADDR: "memory-svc:8087"
      SKILL_SERVICE_ADDR: "skill-svc:8088"
      CONFIG_SERVICE_ADDR: "config-svc:8089"
      REDIS_URL: "redis://redis:6379"
    depends_on:
      - project-svc
      - agent-svc
      - design-system-svc
      - media-svc
      - plugin-svc
      - mcp-svc
      - memory-svc
      - skill-svc
      - config-svc
    ports:
      - "7456:7456"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:7456/health"]
      interval: 10s

volumes:
  postgres-data:
  workspace:
  media-storage:
```

---

## 3. Dockerfile (Multi-stage, shared)

```dockerfile
# Dockerfile (root của Go monorepo)
FROM golang:1.23-alpine AS builder

ARG SERVICE
WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X main.version=$(git describe --tags --always)" \
    -o /app/bin/${SERVICE} \
    ./cmd/${SERVICE}

# ── Final image ─────────────────────────────────────────────────
FROM alpine:3.20

ARG SERVICE
ENV SERVICE_NAME=${SERVICE}

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /app/bin/${SERVICE} /usr/local/bin/service

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s \
    CMD wget -q --spider http://localhost:8080/health || exit 1

ENTRYPOINT ["/usr/local/bin/service"]
```

---

## 4. Makefile

```makefile
# Makefile
.PHONY: proto build run test lint

SERVICES := gateway project-svc agent-svc design-system-svc media-svc \
            plugin-svc mcp-svc memory-svc skill-svc config-svc telemetry-svc

# Generate protobuf
proto:
	@bash deploy/scripts/proto-gen.sh

# Build all services
build:
	@for svc in $(SERVICES); do \
		echo "Building $$svc..."; \
		go build -o bin/$$svc ./cmd/$$svc; \
	done

# Run locally with Docker Compose
run:
	docker compose -f deploy/local/docker-compose.yml up --build

# Run tests
test:
	go test ./... -race -timeout 120s

# Run tests with coverage
test-coverage:
	go test ./... -race -coverprofile=coverage.out
	go tool cover -html=coverage.out

# Lint
lint:
	golangci-lint run ./...

# Generate mocks
mocks:
	@find . -name "repository.go" | xargs mockgen
```

---

## 5. CI/CD Pipeline (GitHub Actions)

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
      redis:
        image: redis:7-alpine
      nats:
        image: nats:2.10-alpine
        options: --cmd "-js"

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
          cache: true

      - name: Generate proto
        run: make proto

      - name: Lint
        uses: golangci/golangci-lint-action@v4

      - name: Test
        run: make test-coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v4

  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build all services
        run: make build
      - name: Build Docker images
        run: |
          for SVC in gateway project-svc agent-svc design-system-svc \
                     media-svc plugin-svc mcp-svc memory-svc skill-svc \
                     config-svc telemetry-svc; do
            docker build --build-arg SERVICE=$SVC -t open-design/$SVC:$GITHUB_SHA .
          done
```

---

## 6. Environment Variables Reference

| Variable | Default | Service | Mô tả |
|----------|---------|---------|-------|
| `GRPC_PORT` | `8080` | All | gRPC listen port |
| `HTTP_PORT` | `9080` | All | HTTP (health/metrics) port |
| `LOG_LEVEL` | `info` | All | `debug`/`info`/`warn`/`error` |
| `DATABASE_URL` | — | Most | PostgreSQL DSN |
| `NATS_URL` | — | Most | NATS connection URL |
| `REDIS_URL` | — | Gateway, Agent | Redis URL |
| `OD_WORKSPACE_ROOT` | `~/.open-design` | Project, Agent | Workspace path |
| `OD_DS_CATALOG_PATH` | `/ds-catalog` | Design System | Design systems folder |
| `OD_SKILLS_PATH` | `/skills` | Skill | Skills folder |
| `ENCRYPTION_KEY` | — | Config | AES key for secrets |
| `{SERVICE}_ADDR` | — | Gateway | Upstream gRPC addresses |
| `POSTHOG_API_KEY` | — | Telemetry | PostHog project key |
| `LANGFUSE_PUBLIC_KEY` | — | Telemetry | Langfuse public key |
| `OTLP_ENDPOINT` | — | All | OpenTelemetry collector |

---

## 7. Migration từ Node.js Daemon (Strangler Fig)

```
Phase 1 (Week 1-2):
  ✅ Setup monorepo, proto, shared packages
  ✅ Deploy Gateway + Project Service + Agent Service
  ✅ Gateway proxies unknown routes → Node.js daemon (port 7457)

Phase 2 (Week 3-4):
  ✅ Deploy Design System Service
  ✅ Deploy Media Service
  ✅ Deploy Skill Service
  ✅ Remove proxy for these routes

Phase 3 (Week 5-6):
  ✅ Deploy Plugin Service
  ✅ Deploy MCP Service
  ✅ Deploy Memory Service

Phase 4 (Week 7-8):
  ✅ Deploy Config Service
  ✅ Deploy Telemetry Service
  ✅ Retire Node.js daemon
  ✅ Complete migration
```
