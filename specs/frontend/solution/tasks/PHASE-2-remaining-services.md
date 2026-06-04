# PHASE 2 — Remaining Services + Daemon Retirement

> **Tuần**: 12–18  
> **Phạm vi**: 7 Go services còn lại + retire daemon  
> **Mục tiêu**: 100% routes migrate sang Go; daemon shutdown  
> **Ref**: [02-strangler-fig-migration.md](../02-strangler-fig-migration.md), [specs/services/](../../services/)

---

## Tuần 12–13 — Design System Service

---

### T01 — Design System Service Setup & Domain

**File**: `services/design-system-service/`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: Phase 1 Gateway running  
**Status**: `[ ]`

**Mô tả**: Setup project + domain layer cho Design System Service.  
**Ref**: [specs/services/04-design-system-service.md](../../services/04-design-system-service.md)

**Domain entities**:
```go
type DesignSystem struct {
    ID          string
    Name        string
    Title       string
    Version     string
    Status      DSStatus   // "draft" | "published"
    Surface     string     // "web" | "image" | "video"
    ArtifactMode string    // "generated" | "agent-managed"
    SourcePath  string
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

type DSGenerationJob struct {
    ID             string
    DesignSystemID string
    Status         JobStatus
    Error          string
    CreatedAt      time.Time
    CompletedAt    *time.Time
}
```

**Checklist**:
- [ ] Project structure (cmd, domain, usecase, infra, delivery)
- [ ] Domain entities + interfaces
- [ ] SQLite schema + migrations

---

### T02 — Design System File Serving

**File**: `services/design-system-service/internal/infra/fs/`  
**Effort**: 6h  
**Assignee**: Go Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Mô tả**: Serve design system files từ `design-systems/` directory (150+ built-in DSes).

**Checklist**:
- [ ] `ListDesignSystems()` — scan directory + parse `index.yaml`
- [ ] `GetDesignSystem(id)` — read metadata + content
- [ ] `ListFiles(dsID)` — list files trong DS folder
- [ ] `GetFile(dsID, path)` — read file content
- [ ] Built-in DSes từ `open-design-vnpay/design-systems/` (read-only mount)
- [ ] User-created DSes từ `{workspacePath}/design-systems/`

---

### T03 — Design System gRPC + Gateway Integration

**File**: `services/design-system-service/internal/delivery/grpc/`, `gateway/upstream/`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: T02  
**Status**: `[ ]`

**Endpoints → Go**:
```
GET  /api/design-systems         → DesignSystemService.List
GET  /api/design-systems/:id     → DesignSystemService.Get
POST /api/design-systems         → DesignSystemService.Create
PATCH /api/design-systems/:id    → DesignSystemService.Update
DELETE /api/design-systems/:id   → DesignSystemService.Delete
GET /api/design-systems/:id/files→ DesignSystemService.ListFiles
```

**Acceptance Criteria**:
- [ ] Frontend Design Systems tab load đúng list
- [ ] Design System detail page hoạt động
- [ ] `FF_GO_DESIGN_SYSTEM_SERVICE=true` enable trong gateway

---

### T04 — Design System Generation Jobs

**File**: `services/design-system-service/internal/usecase/generation_job_usecase.go`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: T03  
**Status**: `[ ]`

**Mô tả**: Async job để generate DS từ AI prompt.

**Checklist**:
- [ ] `POST /api/design-systems/generation-jobs` — create job
- [ ] `GET /api/design-systems/generation-jobs/:id` — poll status
- [ ] Background worker chạy generation (call Agent Service để spawn AI)
- [ ] Job result lưu vào DS record

---

### T05 — Design System Import (Local + GitHub)

**File**: `services/design-system-service/internal/usecase/import_usecase.go`  
**Effort**: 6h  
**Assignee**: Go Dev  
**Depends on**: T03  
**Status**: `[ ]`

**Checklist**:
- [ ] `POST /api/design-systems/import/local` — import từ local path
- [ ] `POST /api/design-systems/import/github` — import từ GitHub repo
- [ ] Validate DS structure (có `index.yaml`, `tokens.css`)
- [ ] Copy files vào workspace

---

## Tuần 13–14 — Skill Service + Config Service

---

### T06 — Skill Service Setup & File Serving

**File**: `services/skill-service/`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: Phase 1 Gateway  
**Status**: `[ ]`

**Ref**: [specs/services/09-skill-service.md](../../services/09-skill-service.md)

**Mô tả**: Serve skill YAML/MD files từ `skills/` directory.

**Checklist**:
- [ ] Project setup (light service — mostly file serving)
- [ ] `ListSkills()` — scan `skills/` + parse frontmatter
- [ ] `GetSkill(id)` — read SKILL.md + metadata
- [ ] `ListFiles(skillID)` — files trong skill folder
- [ ] `ImportSkill()` — copy user skill vào workspace
- [ ] `UpdateSkill()` — update user skill (shadow copy)
- [ ] `DeleteSkill()` — delete user skill
- [ ] Same for design templates và prompt templates
- [ ] gRPC + Gateway integration

**Endpoints**:
```
GET  /api/skills
GET  /api/skills/:id
POST /api/skills/import
PUT  /api/skills/:id
DELETE /api/skills/:id
GET  /api/skills/:id/files
GET  /api/design-templates
GET  /api/design-templates/:id
GET  /api/prompt-templates
GET  /api/prompt-templates/:surface/:id
```

---

### T07 — Skill Service Gateway Integration

**File**: `gateway/internal/upstream/skill_client.go`  
**Effort**: 3h  
**Assignee**: Go Dev  
**Depends on**: T06  
**Status**: `[ ]`

- [ ] gRPC client
- [ ] HTTP handlers cho tất cả skill routes
- [ ] `FF_GO_SKILL_SERVICE=true` enable

---

### T08 — Config Service

**File**: `services/config-service/`  
**Effort**: 12h  
**Assignee**: Go Dev  
**Depends on**: Phase 1 Gateway  
**Status**: `[ ]`

**Ref**: [specs/services/10-config-service.md](../../services/10-config-service.md)

**Checklist**:
- [ ] Domain: `AppConfig`, `MediaConfig`, `ConfigRepository` interface
- [ ] SQLite DB với **encrypted storage** cho API keys
  ```go
  // AES-256-GCM encryption cho sensitive fields
  func encryptValue(key []byte, plaintext string) (string, error)
  func decryptValue(key []byte, ciphertext string) (string, error)
  ```
- [ ] Installation ID management (generate UUID, persist)
- [ ] `GET/PUT /api/app-config` endpoints
- [ ] `GET/PUT /api/media/config` endpoints
- [ ] `GET /api/version` endpoint
- [ ] Migration: Import config từ daemon's `app-config.json`
- [ ] gRPC + Gateway integration

**Endpoints**:
```
GET  /api/app-config
PUT  /api/app-config
GET  /api/media/config
PUT  /api/media/config
GET  /api/version
```

**Security**:
- [ ] API keys không bao giờ log ra
- [ ] Config endpoint chỉ expose `apiKeyConfigured: true` + `apiKeyTail`
- [ ] Encryption key từ env var, không hardcode

---

## Tuần 15 — MCP Service

---

### T09 — MCP Service Setup

**File**: `services/mcp-service/`  
**Effort**: 4h  
**Assignee**: Go Dev  
**Depends on**: Phase 1 Gateway  
**Status**: `[ ]`

**Ref**: [specs/services/07-mcp-service.md](../../services/07-mcp-service.md)

**Checklist**:
- [ ] Project setup
- [ ] Domain: `McpToken`, `ActiveContext`

---

### T10 — MCP Active Context

**File**: `services/mcp-service/internal/usecase/active_context.go`  
**Effort**: 4h  
**Assignee**: Go Dev  
**Depends on**: T09  
**Status**: `[ ]`

**Checklist**:
- [ ] `POST /api/active` — set active context (projectId + fileName)
- [ ] Store in Redis với TTL (context là ephemeral)
- [ ] `GET /api/active` — get current active context

---

### T11 — MCP Protocol Passthrough + Token Auth

**File**: `services/mcp-service/internal/delivery/`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: T10  
**Status**: `[ ]`

**Checklist**:
- [ ] `/mcp/*` — MCP protocol endpoint (SSE or HTTP streaming)
- [ ] MCP token CRUD: `POST /api/mcp/tokens`, `DELETE /api/mcp/tokens/:id`
- [ ] Token validation cho incoming MCP connections
- [ ] Gateway integration: `ANY /mcp/*` → MCP Service

---

## Tuần 16 — Memory Service

---

### T12 — Memory Service Setup & Domain

**File**: `services/memory-service/`  
**Effort**: 6h  
**Assignee**: Go Dev  
**Depends on**: Phase 1 Gateway  
**Status**: `[ ]`

**Ref**: [specs/services/08-memory-service.md](../../services/08-memory-service.md)

**Checklist**:
- [ ] Project setup
- [ ] Domain: `MemoryConnector`, `MemoryEntry`, embedding interfaces
- [ ] SQLite + sqlite-vec (local) / PostgreSQL + pgvector (prod)

---

### T13 — Memory Embedding & Search

**File**: `services/memory-service/internal/usecase/`  
**Effort**: 10h  
**Assignee**: Go Dev  
**Depends on**: T12  
**Status**: `[ ]`

**Checklist**:
- [ ] `GET/POST /api/memory/connectors` — memory connector CRUD
- [ ] `POST /api/memory/entries` — add memory entry + compute embedding
- [ ] `POST /api/memory/search` — vector similarity search
- [ ] Embedding provider abstraction: OpenAI, Ollama, local
- [ ] Gateway integration

---

## Tuần 16 — Plugin Service (Basic)

---

### T14 — Plugin Service Setup

**File**: `services/plugin-service/`  
**Effort**: 4h  
**Assignee**: Go Dev  
**Depends on**: Phase 1 Gateway  
**Status**: `[ ]`

**Ref**: [specs/services/06-plugin-service.md](../../services/06-plugin-service.md)

**Checklist**:
- [ ] Project setup
- [ ] Domain: `Plugin`, `PluginRegistry`

---

### T15 — Plugin Registry + Composio Config

**File**: `services/plugin-service/internal/`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: T14  
**Status**: `[ ]`

**Checklist**:
- [ ] `GET /api/plugins` — list plugins từ `plugins/` directory
- [ ] `GET/POST /api/connectors/composio/config` — Composio API key management (encrypted)
- [ ] `GET /api/connectors` — connector list (wrap Composio API)
- [ ] `POST /api/connectors/:id/connect` — initiate OAuth
- [ ] Plugin sandbox execution (basic — defer complex sandbox to later)
- [ ] Gateway integration

---

## Tuần 17 — Telemetry Service + Health Check

---

### T16 — Telemetry Service (Basic)

**File**: `services/telemetry-service/`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: Phase 1 Gateway  
**Status**: `[ ]`

**Ref**: [specs/services/11-telemetry-service.md](../../services/11-telemetry-service.md)

**Checklist**:
- [ ] OpenTelemetry SDK setup (traces + metrics)
- [ ] Prometheus metrics endpoint `/metrics`
- [ ] NATS subscriber cho async events từ các services
- [ ] Langfuse bridge (forward LLM traces)
- [ ] PostHog proxy (forward analytics events)

---

### T17 — Deploy Routes (Cloudflare + Vercel)

**File**: `services/project-service/internal/usecase/deploy_usecase.go`  
**Effort**: 8h  
**Assignee**: Go Dev  
**Depends on**: Phase 1 Project Service  
**Status**: `[ ]`

**Mô tả**: Migrate deploy functionality từ daemon (`deploy.ts` ~74KB).

**Checklist**:
- [ ] `GET/PUT /api/deploy/config` — deploy provider config
- [ ] `GET /api/deploy/providers` — list providers (Vercel, Cloudflare)
- [ ] `POST /api/deploy/project-file` — deploy file
- [ ] `GET /api/projects/:id/deployments` — deployment history
- [ ] Cloudflare Pages API integration
- [ ] Vercel API integration

---

## Tuần 17–18 — Daemon Retirement

---

### T18 — Verify All Routes Migrated

**Effort**: 4h  
**Assignee**: Go Dev + Frontend Dev  
**Depends on**: T01–T17  
**Status**: `[ ]`

**Checklist**:
- [ ] Script kiểm tra tất cả routes trong `gateway/router.go` không còn fallback proxy:
  ```bash
  #!/bin/bash
  # verify-all-routes-migrated.sh
  if grep -r "daemon.ToDaemon" services/gateway/internal/router/; then
    echo "FAIL: daemon proxy still active"
    exit 1
  fi
  echo "PASS: all routes migrated"
  ```
- [ ] Map đầy đủ: mỗi endpoint trong daemon `server.ts` có tương ứng trong Go
- [ ] Disable fallback proxy trong gateway config

---

### T19 — Final Data Migration (SQLite → PostgreSQL / Service DBs)

**Effort**: 8h  
**Assignee**: Go Dev + DevOps  
**Depends on**: T18  
**Status**: `[ ]`

**Checklist**:
- [ ] Chạy migration tools đã tạo ở T19 (Phase 1) với production data
- [ ] Backup daemon SQLite trước khi migrate
  ```bash
  cp ~/.od/data/open-design.db backup/pre-retirement-$(date +%Y%m%d).db
  ```
- [ ] Migrate projects, conversations, messages → Project Service DB
- [ ] Migrate run history → Agent Service DB
- [ ] Migrate design systems → Design System Service DB
- [ ] Migrate app-config → Config Service DB (với encryption)
- [ ] Verify record counts sau migration
- [ ] Smoke test với Go services đọc migrated data

---

### T20 — Daemon Retirement Execution

**Effort**: 4h  
**Assignee**: DevOps  
**Depends on**: T19  
**Status**: `[ ]`

**Checklist**:
- [ ] Remove daemon từ Docker Compose (hoặc comment out)
- [ ] Remove daemon startup từ Electron main process
- [ ] Tag Git commit:
  ```bash
  git tag daemon-retirement-$(date +%Y-%m-%d)
  git push --tags
  ```
- [ ] Archive daemon code (không delete — keep for reference):
  ```bash
  # apps/daemon/ vẫn tồn tại nhưng không được build trong CI
  # Thêm vào .github/workflows: exclude daemon from build
  ```
- [ ] Update README và QUICKSTART — remove daemon references
- [ ] Update Docker Compose docs
- [ ] Thông báo team: Daemon retired

**Acceptance Criteria Phase 2**:
- [ ] Tất cả 10 Go services chạy
- [ ] Daemon không còn trong Docker Compose
- [ ] Frontend hoạt động 100% với Go services
- [ ] 0 requests fallback sang daemon (verify từ gateway logs)
- [ ] Monitoring 48h: 0 service crashes

**Phase 2 Done** → Unblocks Phase 3
