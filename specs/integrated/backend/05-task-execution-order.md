# 05 — Task Execution Order (Backend)

> 36 tasks, dependency graph, estimates cho toàn bộ backend integration.

---

## Dependency Graph

```
[B0] go.work + go.mod  →  [B1] Domains  →  [B2] Infra  →  [B3] Use Cases  →  [B4] Handlers  →  [B5] Bootstrap  →  [B6] Config
```

---

## Phase B0 — Scaffolding (không có dependency)

| Task | File | Estimate |
|------|------|---------|
| **B-01** Tạo thư mục `services/design-system-svc/` | mkdir -p | 0.5h |
| **B-02** Tạo `design-system-svc/go.mod` | `go mod init design-system-svc` | 0.5h |
| **B-03** Thêm `use ./design-system-svc` vào `go.work` | `go work edit -use ./design-system-svc` | 0.5h |
| **B-04** Tạo `design-system-svc/Dockerfile` | From spec 01 | 0.5h |

**B0 Total**: ~2h

---

## Phase B1 — Domain Models

### design-system-svc

| Task | File | Estimate |
|------|------|---------|
| **B-05** Tạo `design-system-svc/internal/domain/design_system.go` | From spec 01 §2 | 1.5h |

### skill-service (nâng cấp)

| Task | File | Estimate |
|------|------|---------|
| **B-06** Tạo `skill-service/internal/domain/design_template.go` | From spec 02 §2 | 1.5h |

### media-service (nâng cấp)

| Task | File | Estimate |
|------|------|---------|
| **B-07** Tạo `media-service/internal/domain/prompt_template.go` | From spec 03 §2 | 2h |

**B1 Total**: ~5h

---

## Phase B2 — Infrastructure

### design-system-svc

| Task | File | Estimate |
|------|------|---------|
| **B-08** Tạo `design-system-svc/internal/infra/fs/manifest_loader.go` | From spec 01 §3 | 4h |
| **B-09** Tạo `design-system-svc/internal/infra/fs/file_server.go` | From spec 01 §4 | 1.5h |
| **B-10** Test `ManifestLoader` với 5 DS mẫu | Manual test | 2h |
| **B-11** Test legacy `DESIGN.md` fallback | Manual test | 1h |

### skill-service

| Task | File | Estimate |
|------|------|---------|
| **B-12** Tạo `skill-service/internal/infra/fs/template_loader.go` | From spec 02 §3 | 3h |
| **B-13** Thêm `gopkg.in/yaml.v3` vào skill-service go.mod (hoặc dùng existing yaml lib) | `go get` | 0.5h |
| **B-14** Test `TemplateLoader` với 5 templates mẫu | Manual test | 1.5h |

### media-service

| Task | File | Estimate |
|------|------|---------|
| **B-15** Tạo `media-service/internal/infra/prompt/argument_parser.go` | From spec 03 §3 | 2h |
| **B-16** Test `ArgumentParser` với 3 prompt examples | Unit test | 1.5h |
| **B-17** Tạo `media-service/internal/infra/fs/prompt_template_loader.go` | From spec 03 §4 | 3h |
| **B-18** Test `PromptTemplateLoader` với 5 templates mẫu | Manual test | 1.5h |

**B2 Total**: ~21.5h

---

## Phase B3 — Use Cases (B1 + B2 → B3)

### design-system-svc

| Task | File | Estimate |
|------|------|---------|
| **B-19** Tạo `design-system-svc/internal/usecase/catalog_usecase.go` | From spec 01 §5 | 2h |

### skill-service

| Task | File | Estimate |
|------|------|---------|
| **B-20** Tạo `skill-service/internal/usecase/template_usecase.go` | From spec 02 §4 | 2h |

### media-service

| Task | File | Estimate |
|------|------|---------|
| **B-21** Tạo `media-service/internal/usecase/template_usecase.go` | From spec 03 §5 | 2.5h |
| **B-22** Implement `aspectToWidthHeight` helper | In template_usecase.go | 0.5h |

**B3 Total**: ~7h

---

## Phase B4 — HTTP Handlers (B3 → B4)

### design-system-svc

| Task | File | Estimate |
|------|------|---------|
| **B-23** Tạo `design-system-svc/internal/adapter/http/handler.go` | From spec 01 §6 | 3h |
| **B-24** Implement `serveFile` helper với path traversal check | In handler.go | 1h |

### skill-service

| Task | File | Estimate |
|------|------|---------|
| **B-25** Cập nhật `skill-service/internal/adapter/http/handler.go` | Add template routes (spec 02 §5) | 3h |
| **B-26** Cập nhật `SkillHandler` struct + constructor | Add `templateUC *TemplateUseCase` | 0.5h |

### media-service

| Task | File | Estimate |
|------|------|---------|
| **B-27** Cập nhật `media-service/internal/adapter/http/handler.go` | Add template routes (spec 03 §6) | 3h |
| **B-28** Cập nhật `MediaHandler` struct + constructor | Add `templateUC *TemplateUseCase` | 0.5h |

**B4 Total**: ~11h

---

## Phase B5 — Bootstrap & Wire-up (B4 → B5)

| Task | File | Estimate |
|------|------|---------|
| **B-29** Tạo `design-system-svc/cmd/main.go` | From spec 01 §7 | 1.5h |
| **B-30** Cập nhật `skill-service/cmd/main.go` | Thêm TemplateLoader + wire-up | 1h |
| **B-31** Cập nhật `media-service/cmd/main.go` | Thêm PromptTemplateLoader + wire-up | 1h |
| **B-32** `go build ./...` tất cả 3 services | Verify compile | 1h |

**B5 Total**: ~4.5h

---

## Phase B6 — Config & Deploy (B5 → B6)

| Task | File | Estimate |
|------|------|---------|
| **B-33** Cập nhật `deploy/dev/docker-compose.server.yaml` | From spec 04 §2 | 1.5h |
| **B-34** Cập nhật `ui/vite.config.ts` | Thêm proxy rules (spec 04 §3) | 0.5h |
| **B-35** Tạo/cập nhật gateway config | From spec 04 §1 | 1h |
| **B-36** End-to-end test: `docker compose up` + curl các endpoints | Smoke test | 2h |

**B6 Total**: ~5h

---

## Tổng kết

| Phase | Tasks | Estimate |
|-------|-------|---------|
| B0 Scaffolding | 4 | ~2h |
| B1 Domains | 3 | ~5h |
| B2 Infrastructure | 11 | ~21.5h |
| B3 Use Cases | 4 | ~7h |
| B4 Handlers | 6 | ~11h |
| B5 Bootstrap | 4 | ~4.5h |
| B6 Config | 4 | ~5h |
| **Total** | **36 tasks** | **~56h** |

---

## Sprint plan (8h/day)

```
Day 1: B0 + B1 (Scaffolding + Domains)
  Morning: B-01..B-04 (design-system-svc structure)
  Afternoon: B-05..B-07 (domain models)

Day 2: B2A (design-system-svc infra)
  B-08: ManifestLoader — cốt lõi, đọc manifest.json
  B-09: DiskFileServer
  B-10, B-11: Manual tests

Day 3: B2B (skill-service + media-service infra)
  Morning: B-12..B-14 (TemplateLoader + SKILL.md parser)
  Afternoon: B-15..B-18 (ArgumentParser + PromptTemplateLoader)

Day 4: B3 + B4A (Use cases + design-system-svc handler)
  B-19..B-22 (use cases)
  B-23, B-24 (DS handler)

Day 5: B4B + B5 + B6 (handlers + bootstrap + deploy)
  B-25..B-28 (skill + media handlers)
  B-29..B-32 (bootstrap + compile)
  B-33..B-36 (config + smoke test)
```

---

## Smoke test commands

```bash
# design-system-svc
curl http://localhost:8086/api/v1/design-systems | jq '.total'
curl http://localhost:8086/api/v1/design-systems/default | jq '.name'
curl http://localhost:8086/api/v1/design-systems/default/tokens.css | head -5
curl http://localhost:8086/api/v1/design-systems/default/preview | jq '.pages[].role'

# skill-service (templates)
curl http://localhost:8082/api/v1/design-templates | jq '.total'
curl http://localhost:8082/api/v1/design-templates/saas-landing | jq '.inputs'
curl http://localhost:8082/api/v1/design-templates/saas-landing/example | wc -c

# media-service (prompt templates)
curl http://localhost:8084/api/v1/prompt-templates | jq '.total'
curl http://localhost:8084/api/v1/prompt-templates?surface=image | jq '.total'
curl http://localhost:8084/api/v1/prompt-templates/3d-stone-staircase-evolution-infographic | jq '.argumentCount'

# generate-from-template
curl -X POST http://localhost:8084/api/v1/media/generate-from-template \
  -H 'Content-Type: application/json' \
  -d '{"templateId":"profile-avatar-anime-girl-to-cinematic-photo","values":{}}'
```

---

## Critical paths

### B-08 (ManifestLoader) là task quan trọng nhất

- Phải handle cả 2 format: `manifest.json` (v1) và legacy `DESIGN.md`
- Phải handle 150+ directories trong catalogs path
- Sync.Map cache để tránh race condition
- Test với edge cases: `_schema/`, dotfiles, empty dirs

### B-15 + B-16 (ArgumentParser) là task tinh tế nhất

- Regex phải match cả `{argument name="x"}` (không có default) và `{argument name="x" default="y"}`
- Phải xử lý JSON trong JSON (video prompt templates có JSON object với placeholders bên trong)
- Unit test với ít nhất 5 prompt templates thực tế

### B-12 (TemplateLoader/SKILL.md parser) phụ thuộc vào format frontmatter

- SKILL.md bắt đầu bằng `---` YAML block
- `od.inputs[].type` phải map đúng sang `TemplateInputType`
- `od.mode` phải default là `prototype` nếu không có

---

## Implementation Status

> **Cập nhật**: 2026-06-04 — **SPRINT HOÀN THÀNH** ✅ 36/36 tasks

| Phase | Tasks | Estimate | Actual | Status |
|-------|-------|----------|--------|--------|
| B0 Scaffolding | 4 | ~2h | ~1h | ✅ DONE |
| B1 Domains | 3 | ~5h | ~3h | ✅ DONE |
| B2 Infrastructure | 11 | ~21.5h | ~16h | ✅ DONE |
| B3 Use Cases | 4 | ~7h | ~5h | ✅ DONE |
| B4 Handlers | 6 | ~11h | ~8h | ✅ DONE |
| B5 Bootstrap | 4 | ~4.5h | ~3h | ✅ DONE |
| B6 Config | 4 | ~5h | ~4h | ✅ DONE |
| **Total** | **36** | **~56h** | **~40h** | **✅ DONE** |

### Critical path thực tế

**B-08 ManifestLoader** — implement xong, đặc điểm:
- Dual-format: `manifest.json` (v1 schema) + legacy `DESIGN.md` fallback
- `_schema/`, dotfiles bị skip đúng
- `sync.Map` cache thread-safe
- 150+ DS loaded ✓

**B-15/B-16 ArgumentParser** — implement xong, đặc điểm:
- Dual-regex xử lý cả `{argument name="x"}` lẫn `{argument name=\"x\"}` (JSON-embedded)
- 13 unit tests PASS ✓

**B-12 TemplateLoader** — implement xong:
- Parse YAML frontmatter từ `SKILL.md`
- `od.inputs[].type` map đúng sang `TemplateInputType`
- `od.mode` default là `chat` nếu không có

### Smoke test commands (verified)

```bash
# design-system-svc (:8086)
curl http://localhost:8086/api/v1/design-systems | jq '.total'
# → 150+ DS

curl http://localhost:8086/api/v1/design-systems/airbnb | jq '.name'
# → "Airbnb"

# skill-service (:8082)
curl http://localhost:8082/api/v1/design-templates | jq '.total'
# → 110+

# media-service (:8084)
curl http://localhost:8084/api/v1/prompt-templates | jq '.total'
# → 102

curl http://localhost:8084/api/v1/prompt-templates/3d-stone-staircase-evolution-infographic | jq '.argumentCount'
# → >0 (args parsed đúng từ JSON-embedded format)
```

> Chạy `services/smoke_test.sh` để verify tự động (direct mode hoặc gateway mode).
