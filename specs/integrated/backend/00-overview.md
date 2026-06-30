# Backend Integration — Overview

> **Mục đích**: Giải pháp chi tiết nâng cấp `services/` để tích hợp 3 asset directories:  
> `design-systems/` (150+), `design-templates/` (110+), `prompt-templates/` (103 JSON).

---

## Kiến trúc hiện tại `services/`

```
services/
├── skill-service/          ✅ Active — Clean Arch (adapter/domain/infra/usecase)
│   ├── domain/skill.go     ⚠️  Thiếu: DesignTemplate domain
│   ├── infra/fs/           ⚠️  SkillLoader dùng YAML, không parse SKILL.md frontmatter
│   └── adapter/http/       ⚠️  Thiếu /api/design-templates/* routes
│
├── media-service/          ✅ Active — Clean Arch
│   ├── domain/media.go     ⚠️  Thiếu: PromptTemplate domain + ArgumentParser
│   ├── usecase/            ⚠️  Thiếu: GenerateFromTemplateUseCase
│   └── adapter/http/       ⚠️  Thiếu /api/prompt-templates/* + /api/media/generate-from-template
│
├── config-service/         ✅ Active — quản lý AppConfig
├── plugin-service/         ✅ Active
├── memory-service/         ✅ Active
├── mcp-service/            ✅ Active
├── telemetry-service/      ✅ Active
│
├── preview-gateway/        ✅ Active — API Gateway (do NOT modify internals*)
├── preview-project/        ✅ Active — Project management (do NOT modify*)
└── prompt-registry-service/✅ Active — Versioned prompt/rule registry

── MISSING ────────────────────────────────────────────────────────────
├── design-system-svc/      ❌ Chưa có — cần tạo mới
```

> *`preview-*` là external services — chỉ có thể cấu hình, không modify code.

---

## Gap Analysis

| Asset | Service cần nâng cấp/tạo mới | Gap chính |
|-------|------------------------------|-----------|
| `design-systems/` | **TẠO MỚI `design-system-svc`** | Không có service nào serve 150+ DS |
| `design-templates/` | **NÂNG CẤP `skill-service`** | Chưa parse SKILL.md, chưa có `/api/design-templates/*` |
| `prompt-templates/` | **NÂNG CẤP `media-service`** | Chưa có PromptTemplate domain + loader |

---

## Documents trong thư mục này

| File | Mô tả |
|------|-------|
| [01-design-system-svc-new.md](./01-design-system-svc-new.md) | **TẠO MỚI** `design-system-svc` — toàn bộ service |
| [02-skill-service-upgrade.md](./02-skill-service-upgrade.md) | **NÂNG CẤP** `skill-service` — DesignTemplate registry |
| [03-media-service-upgrade.md](./03-media-service-upgrade.md) | **NÂNG CẤP** `media-service` — PromptTemplate + generate-from-template |
| [04-gateway-routing.md](./04-gateway-routing.md) | Cập nhật routing trong `preview-gateway` configs |
| [05-docker-compose.md](./05-docker-compose.md) | Volume mounts + service definitions |
| [06-task-execution-order.md](./06-task-execution-order.md) | 36 tasks, dependency graph, estimates |

---

## Implementation Status

> **Cập nhật**: 2026-06-04 — **HOÀN THÀNH 100%** (36/36 tasks)

| Service | Gap | Status |
|---------|-----|--------|
| `design-system-svc` | Chưa tồn tại | ✅ **Tạo mới hoàn chỉnh** — Clean Arch, port :8086, 150+ DS |
| `skill-service` | Thiếu DesignTemplate domain + routes | ✅ **Nâng cấp xong** — `/api/v1/design-templates/*` live |
| `media-service` | Thiếu PromptTemplate + GenerateFromTemplate | ✅ **Nâng cấp xong** — `/api/v1/prompt-templates/*` + generate-from-template |

### Files đã tạo/sửa

| File | Loại | Trạng thái |
|------|------|-----------|
| `services/design-system-svc/` (toàn bộ) | Mới | ✅ |
| `services/skill-service/internal/domain/design_template.go` | Mới | ✅ |
| `services/skill-service/internal/infra/fs/template_loader.go` | Mới | ✅ |
| `services/skill-service/internal/usecase/template_usecase.go` | Mới | ✅ |
| `services/skill-service/internal/adapter/http/handler.go` | Cập nhật | ✅ |
| `services/skill-service/cmd/main.go` | Cập nhật | ✅ |
| `services/media-service/internal/domain/prompt_template.go` | Mới | ✅ |
| `services/media-service/internal/infra/prompt/argument_parser.go` | Mới | ✅ |
| `services/media-service/internal/infra/fs/prompt_template_loader.go` | Mới | ✅ |
| `services/media-service/internal/usecase/template_usecase.go` | Mới | ✅ |
| `services/media-service/internal/adapter/http/handler.go` | Cập nhật | ✅ |
| `services/media-service/cmd/main.go` | Cập nhật | ✅ |
| `deploy/dev/docker-compose.server.yaml` | Cập nhật | ✅ |
| `deploy/dev/configs/nginx-b5-openledger.conf` | Cập nhật | ✅ |
| `deploy/dev/deploy.sh` | Cập nhật | ✅ |
| `ui/open-design-vnpay/ui/vite.config.ts` | Cập nhật | ✅ |
| `services/smoke_test.sh` | Mới | ✅ |

### Build verification

```
go build ./... — design-system-svc: PASS ✓
go build ./... — skill-service:      PASS ✓
go build ./... — media-service:      PASS ✓
go test ./internal/infra/prompt/...  PASS ✓ (13 unit tests)
```
