# MASTER TRACKER — Backend Integration Tasks

> **Tổng**: 36 tasks | **Estimate**: ~56h | **Sprint**: 5 days  
> Cập nhật status khi thực thi: `[ ]` → `[/]` → `[x]`

---

## Progress Overview

| Phase | Tasks | Status |
|-------|-------|--------|
| B0 — Scaffolding | 4 | `[x]` |
| B1 — Domain Models | 3 | `[x]` |
| B2 — Infrastructure | 11 | `[x]` |
| B3 — Use Cases | 4 | `[x]` |
| B4 — HTTP Handlers | 6 | `[x]` |
| B5 — Bootstrap | 4 | `[x]` |
| B6 — Config & Deploy | 4 | `[x]` |

---

## B0 — Scaffolding

- [x] [B-01] Scaffold `services/design-system-svc/` directory tree
- [x] [B-02] Tạo `design-system-svc/go.mod`
- [x] [B-03] Thêm `design-system-svc` vào `services/go.work`
- [x] [B-04] Tạo `design-system-svc/Dockerfile`

---

## B1 — Domain Models

- [x] [B-05] Tạo `design-system-svc/internal/domain/design_system.go`
- [x] [B-06] Tạo `skill-service/internal/domain/design_template.go`
- [x] [B-07] Tạo `media-service/internal/domain/prompt_template.go`

---

## B2 — Infrastructure

### design-system-svc
- [x] [B-08] Tạo `design-system-svc/internal/infra/fs/manifest_loader.go`
- [x] [B-09] Tạo `design-system-svc/internal/infra/fs/file_server.go`
- [x] [B-10] Test ManifestLoader với 5 DS mẫu từ `design-systems/` (150 DS loaded, airbnb OK)
- [x] [B-11] Test legacy DESIGN.md fallback (`_schema/` skipped ✓)

### skill-service
- [x] [B-12] Tạo `skill-service/internal/infra/fs/template_loader.go`
- [x] [B-13] Verify yaml lib (goccy/go-yaml đã có sẵn trong go.mod ✓)
- [x] [B-14] Test TemplateLoader với 5 design-templates mẫu (110 templates loaded)

### media-service
- [x] [B-15] Tạo `media-service/internal/infra/prompt/argument_parser.go`
- [x] [B-16] Test ArgumentParser: unit test với 13 test cases — all PASS
- [x] [B-17] Tạo `media-service/internal/infra/fs/prompt_template_loader.go`
- [x] [B-18] Test PromptTemplateLoader với JSON files từ `prompt-templates/image/` (102 templates, 45 image + 57 video)

---

## B3 — Use Cases

- [x] [B-19] Tạo `design-system-svc/internal/usecase/catalog_usecase.go`
- [x] [B-20] Tạo `skill-service/internal/usecase/template_usecase.go`
- [x] [B-21] Tạo `media-service/internal/usecase/template_usecase.go`
- [x] [B-22] Implement `aspectToWidthHeight` helper trong template_usecase.go

---

## B4 — HTTP Handlers

### design-system-svc
- [x] [B-23] Tạo `design-system-svc/internal/adapter/http/handler.go`
- [x] [B-24] Implement serveFile helper với path traversal check

### skill-service
- [x] [B-25] Cập nhật `skill-service/internal/adapter/http/handler.go` (thêm template routes)
- [x] [B-26] Cập nhật SkillHandler struct + constructor (thêm templateUC)

### media-service
- [x] [B-27] Cập nhật `media-service/internal/adapter/http/handler.go` (thêm template routes)
- [x] [B-28] Cập nhật MediaHandler struct + constructor (thêm templateUC)

---

## B5 — Bootstrap & Wire-up

- [x] [B-29] Tạo `design-system-svc/cmd/main.go`
- [x] [B-30] Cập nhật `skill-service/cmd/main.go` (thêm TemplateLoader wire-up)
- [x] [B-31] Cập nhật `media-service/cmd/main.go` (thêm PromptTemplateLoader wire-up)
- [x] [B-32] `go build ./...` tất cả 3 services — verify compile clean

---

## B6 — Config & Deploy

- [x] [B-33] Cập nhật `deploy/dev/docker-compose.server.yaml` (volumes + design-system-svc service)
- [x] [B-34] Cập nhật `ui/open-design-vnpay/ui/vite.config.ts` (dual-mode proxy: gateway + VITE_USE_DIRECT_SERVICES=1)
- [x] [B-35] Cập nhật `nginx-b5-openledger.conf` (3 upstreams + 4 location blocks cho design-system-svc, design-templates, prompt-templates)
- [x] [B-36] Tạo `services/smoke_test.sh` (smoke test tất cả 3 services, hỗ trợ direct + nginx gateway mode)

---

## Quick Reference

| Task file | Nội dung |
|-----------|---------|
| [B00-scaffolding.md](./B00-scaffolding.md) | B-01..B-04 |
| [B01-domain-models.md](./B01-domain-models.md) | B-05..B-07 |
| [B02-ds-infra.md](./B02-ds-infra.md) | B-08..B-11 |
| [B03-skill-infra.md](./B03-skill-infra.md) | B-12..B-14 |
| [B04-media-infra.md](./B04-media-infra.md) | B-15..B-18 |
| [B05-use-cases.md](./B05-use-cases.md) | B-19..B-22 |
| [B06-handlers.md](./B06-handlers.md) | B-23..B-28 |
| [B07-bootstrap.md](./B07-bootstrap.md) | B-29..B-32 |
| [B08-config-deploy.md](./B08-config-deploy.md) | B-33..B-36 |
