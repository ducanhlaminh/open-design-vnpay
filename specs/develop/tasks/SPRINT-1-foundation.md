# Sprint 1 — Foundation Tasks

> **Mục tiêu**: Setup infrastructure, Config Service, Gateway OD routes  
> **Thời gian**: Tuần 1-2 | **Team**: 3 Developers song song

> **⚠️ Thay đổi kiến trúc**: `services/shared/` → đã merge vào `pkg/` (root-level shared package). Shared code: `pkg/crypto/`, `pkg/grpcutil/`, `pkg/database/`, `pkg/dbmigrate/`, `pkg/health/`, `pkg/middleware/`. Services mới dùng `replace vnp-design-platform => ../..` trong `go.mod`.

---

## T-1IN-01: Setup Go Workspace (go.work) {#t-1in-01} ✅

**Status**: ✅ DONE  
**File**: `services/go.work`

```
[x] Tạo services/go.work với tất cả existing services
[x] go work sync — PASS (go 1.25.0)
[x] Thêm config-service (active), các service Sprint 2+ (commented)
```

---

## T-1IN-02: Shared — grpcutil {#t-1in-02} ✅

**Status**: ✅ DONE  
**File**: `pkg/grpcutil/grpcutil.go`

```
[x] NewClient + retry interceptor (3x, exponential backoff)
[x] NewServer + panic recovery interceptor
[x] MustDial, IsReady helpers
[x] go build ./pkg/... PASS
```

---

## T-1IN-03: Shared — dbutil {#t-1in-03} ✅

**Status**: ✅ DONE (reuse existing)  
**Files**: `pkg/database/postgres.go`, `pkg/dbmigrate/migrator.go`

```
[x] Dùng lại pkg/database.NewPool(ctx, Config, logger)
[x] Dùng lại pkg/dbmigrate.RunWithPgxPool(pool, migrationsFS, opts)
```

---

## T-1IN-04: Shared — crypto (AES-GCM) {#t-1in-04} ✅

**Status**: ✅ DONE  
**Files**: `pkg/crypto/aes_gcm.go`, `pkg/crypto/aes_gcm_test.go`

```
[x] AESGCMEncryptor — HKDF-SHA256 key derivation
[x] Encrypt/Decrypt roundtrip
[x] KeyTail(plaintext, n) — safe display preview
[x] Tests: roundtrip, tamper, wrong key, different nonce
[x] go build ./pkg/... PASS
```

---

## T-1IN-05: Shared — health {#t-1in-05} ✅

**Status**: ✅ DONE (extend existing)  
**File**: `pkg/health/always_ok.go` (bổ sung)

```
[x] Dùng lại pkg/health.CompositeChecker + HTTPHandler + SimpleCheck
[x] Thêm AlwaysOK CheckFunc cho optional dependencies
```

---

## T-1CF-01: Config Service — Project Setup {#t-1cf-01} ✅

**Status**: ✅ DONE  
**Files**: `services/config-service/go.mod` + directory structure

```
[x] services/config-service/ directory structure
[x] go.mod: module config-service, replace vnp-design-platform => ../..
[x] cmd/, internal/domain/, internal/usecase/, internal/infra/db/
    internal/adapter/{grpc,http}/, api/proto/config/v1/, migrations/, configs/
```

---

## T-1CF-02: Config Service — Domain + Repository Interfaces {#t-1cf-02} ✅

**Status**: ✅ DONE  
**File**: `services/config-service/internal/domain/domain.go`

```
[x] AppConfig struct (InstallationID, TelemetryEnabled, TelemetryContent, OnboardingCompleted)
[x] MediaConfig struct (DefaultImageProvider, DefaultAudioProvider)
[x] Secret struct (Key, EncryptedVal, KeyTail, UpdatedAt, Plaintext)
[x] AppConfigRepository interface (Get, Set, GetAll)
[x] SecretRepository interface (Get, Set, Delete, ListKeys)
```

---

## T-1CF-03: Config Service — Postgres Repositories + Migrations {#t-1cf-03} ✅

**Status**: ✅ DONE  
**Files**: `migrations/000001_*.sql`, `migrations/000002_*.sql`, `internal/infra/db/repos.go`

```
[x] 000001_create_app_config.up.sql — CREATE TABLE + seed defaults (idempotent)
[x] 000001_create_app_config.down.sql
[x] 000002_create_secrets.up.sql — CREATE TABLE secrets (key, encrypted_val, key_tail)
[x] 000002_create_secrets.down.sql
[x] AppConfigRepo: Get, Set, GetAll — upsert pattern
[x] SecretRepo: Get, Set, Delete, ListKeys
```

---

## T-1CF-04: Config Service — Use Cases + HTTP Adapter + main.go {#t-1cf-04} ✅

**Status**: ✅ DONE  
**Files**: `internal/usecase/usecase.go`, `internal/adapter/grpc/handler.go`, `internal/adapter/http/server.go`, `cmd/main.go`

```
[x] ConfigUseCase: GetAppConfig, UpdateAppConfig, GetMediaConfig, UpdateMediaConfig
[x] SecretUseCase: GetSecret (decrypt), SetSecret (encrypt), DeleteSecret, ListSecretKeys
[x] grpc/handler.go: gRPC handler stubs (local struct pattern, no buf required)
[x] http/server.go: HTTP adapter — JSON endpoints
      GET/PATCH /api/v1/app-config
      GET/PATCH /api/v1/media-config
      GET/POST  /internal/secrets (⚠️ blocked at Gateway)
      GET/DELETE /internal/secrets/{key}
      GET /health
[x] cmd/main.go: DI wiring, inline migration runner, graceful shutdown
[x] api/proto/config/v1/config.proto: proto definition (generate later)
[x] go mod tidy && go build ./... — RUNNING (downloading deps)
```

### API Routes

| Method | Path | Access |
|--------|------|--------|
| GET | `/api/v1/app-config` | Public (via Gateway) |
| PATCH | `/api/v1/app-config` | Auth required |
| GET | `/api/v1/media-config` | Public (via Gateway) |
| PATCH | `/api/v1/media-config` | Auth required |
| GET/POST | `/internal/secrets` | **Internal only — blocked at Gateway** |
| GET/DELETE | `/internal/secrets/{key}` | **Internal only** |
| GET | `/health` | Public |

---

## T-1CF-05: Config Service — Docker + Compose {#t-1cf-05} ✅

**Status**: ✅ DONE  
**Files**: `services/config-service/Dockerfile`, `services/config-service/Makefile`, `deploy/dev/docker-compose.yaml`

```
[x] Dockerfile: multi-stage build (golang:1.25-alpine → alpine:3.20)
    Includes repo root context để truy cập pkg/
[x] Makefile: run, build, test, docker-build, fmt
[x] docker-compose.yaml: config-service thêm vào profile [opendesign, full]
    Port: 18089 (host) → 8089 (container)
    Env: DATABASE_URL, ENCRYPTION_KEY (OD_ENCRYPTION_KEY)
    depends_on: postgres (service_healthy)
    healthcheck: wget /health | grep ok
```

### Start config-service locally:
```bash
docker compose --profile opendesign up -d
# hoặc start riêng lẻ:
docker compose up -d config-service
```

---

## T-1GW-01: Gateway — gRPC Clients cho OD Services {#t-1gw-01} ✅

**Status**: ✅ DONE  
**Files**: `services/preview-gateway/pkg/adapter/gateway/{config_client.go,agent_client.go,od_clients.go}`

```
[x] ConfigClient: HTTP client cho config-service (HTTP proxy pattern)
[x] ConfigClientConn: gRPC conn (reserved for when proto gen available)
[x] AgentClient: gRPC stub — addr empty until Sprint 2 (T-2AG-06)
[x] SkillClient: gRPC stub — addr empty until Sprint 3
[x] DesignSystemClient: gRPC stub — addr empty until Sprint 3
[x] Gateway config.go: thêm OD service addresses
    ConfigServiceHTTPAddr (default: http://config-service:8089)
    AgentServiceAddr, SkillServiceAddr, DesignSystemServiceAddr (empty defaults)
```

---

## T-1GW-02: Gateway — Config Proxy Handler {#t-1gw-02} ✅

**Status**: ✅ DONE  
**File**: `services/preview-gateway/pkg/adapter/controller/http/config_proxy_handler.go`

```
[x] ConfigProxyHandler: reverse proxy → config-service HTTP
[x] GetAppConfig  → GET  /api/v1/app-config
[x] UpdateAppConfig → PUT/PATCH /api/v1/app-config
[x] GetMediaConfig  → GET  /api/v1/media-config
[x] UpdateMediaConfig → PUT/PATCH /api/v1/media-config
[x] Nil-safe: handler is nil if ConfigServiceHTTPAddr is empty → 503
[x] Forwards Authorization header
```

> ⚠️ Note: T-1GW-02 ban đầu là "Agent SSE Proxy" nhưng phụ thuộc Sprint 2 (T-2AG-06).
> Thay thế bằng Config Proxy trong Sprint 1. SSE Proxy → Sprint 2.

---

## T-1GW-03: Gateway — OD Routes trong router.go {#t-1gw-03} ✅

**Status**: ✅ DONE  
**Files**: `services/preview-gateway/pkg/adapter/controller/http/router.go`, `cmd/main.go`

```
[x] router.go: NewRouter nhận configProxyHandler *ConfigProxyHandler (Sprint 1)
[x] OD routes thêm TRƯỚC SPA fallback, KHÔNG conflict existing routes:
    GET    /api/v1/od/app-config
    PUT    /api/v1/od/app-config
    PATCH  /api/v1/od/app-config
    GET    /api/v1/od/media-config
    PUT    /api/v1/od/media-config
    PATCH  /api/v1/od/media-config
[x] /internal/secrets/* KHÔNG expose — blocked tại Gateway
[x] main.go: wire configProxyHandler từ cfg.ConfigServiceHTTPAddr
[x] Nil-guard: configProxyHandler nil → routes không đăng ký (optional service)
[x] go build ./... — RUNNING
[x] TODO Sprint 2: Agent/Run SSE routes
[x] TODO Sprint 3: Skill + Design System catalog routes
```

---

## 📊 Sprint 1 Progress — COMPLETE ✅

| Task | Status | Files tạo/sửa |
|------|--------|---------------|
| T-1IN-01 Go Workspace | ✅ DONE | `services/go.work` |
| T-1IN-02 grpcutil | ✅ DONE | `pkg/grpcutil/grpcutil.go` |
| T-1IN-03 dbutil | ✅ DONE | reuse `pkg/database` + `pkg/dbmigrate` |
| T-1IN-04 crypto | ✅ DONE | `pkg/crypto/aes_gcm.go` |
| T-1IN-05 health | ✅ DONE | `pkg/health/always_ok.go` |
| T-1CF-01 Config setup | ✅ DONE | `services/config-service/` |
| T-1CF-02 Domain | ✅ DONE | `internal/domain/domain.go` |
| T-1CF-03 Postgres repos | ✅ DONE | `infra/db/repos.go` + migrations |
| T-1CF-04 Use cases + HTTP | ✅ DONE | usecase, grpc handler, http adapter, main.go |
| T-1CF-05 Docker | ✅ DONE | Dockerfile, Makefile, docker-compose.yaml |
| T-1GW-01 OD clients | ✅ DONE | config/agent/skill/design-system clients |
| T-1GW-02 Config Proxy | ✅ DONE | `config_proxy_handler.go` |
| T-1GW-03 OD Routes | ✅ DONE | `router.go` + `main.go` updated |

**Hoàn thành**: 13/13 (100%) ✅

---

## 📝 Kiến trúc thay đổi so với kế hoạch ban đầu

| Kế hoạch | Thực tế |
|----------|---------|
| `services/shared/` module | Merge vào `pkg/` (root) |
| gRPC server cho config-service | HTTP adapter (JSON) — gRPC khi có buf |
| T-1GW-02 Agent SSE Proxy | → Moved to Sprint 2 (phụ thuộc T-2AG-06) |
| T-1GW-02 thay bằng | Config Proxy Handler |

## 🔜 Sprint 2 Preview

Bước tiếp theo: xem [SPRINT-2-core.md](./SPRINT-2-core.md)

- **T-2AG-01**: Agent Service setup
- **T-2AG-02**: Tool Registry domain
- **T-2AG-03**: LLM Provider interface  
- **T-2AG-04**: Agent execution engine
- **T-2AG-05**: MCP client integration
- **T-2AG-06**: Agent gRPC server (triggers T-1GW-02 SSE Proxy)
