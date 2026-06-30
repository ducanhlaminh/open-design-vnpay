# 06 — Task List thực thi

> Danh sách chi tiết các task cần thực hiện để tích hợp 3 asset directories.  
> Append vào [MASTER-TRACKER.md](../frontend/solution/tasks/MASTER-TRACKER.md).

---

## PHASE I — Design Systems Integration

### I.A Service Layer (Go)

| Task | File | Ưu tiên | Estimate |
|------|------|---------|---------|
| **T-DS-S01** Fix `BuiltinLoader`: đọc `manifest.json` thay `index.yaml` | `04-design-system-service` | 🔴 HIGH | 4h |
| **T-DS-S02** Update domain model: thêm `Category`, `HasTokens`, `HasComponents`, `PreviewPages` | `04-design-system-service` | 🔴 HIGH | 2h |
| **T-DS-S03** Add HTTP routes: `/tokens.css`, `/components`, `/preview/:role`, `/assets/*` | API Gateway | 🔴 HIGH | 4h |
| **T-DS-S04** Update gRPC proto: thêm fields mới + `DSContext.componentsHtml` | proto file | 🟡 MEDIUM | 3h |
| **T-DS-S05** Update `DSContext.guidelinesMd` → `designMd` trong Agent Service | Agent Service | 🟡 MEDIUM | 1h |

### I.B UI Layer (React)

| Task | File | Ưu tiên | Estimate |
|------|------|---------|---------|
| **T-DS-U01** Update `HttpDesignSystemApiClient`: thêm types + methods | `api/domain/http.ts` | 🔴 HIGH | 2h |
| **T-DS-U02** `<DesignSystemPicker>`: grouped dropdown + token preview strip | `components/DesignSystemPicker.tsx` | 🔴 HIGH | 6h |
| **T-DS-U03** `<DesignSystemCard>`: card với preview thumbnail | `components/DesignSystemCard.tsx` | 🟡 MEDIUM | 3h |
| **T-DS-U04** `<TokenStrip>`: fetch + parse tokens.css, render swatches | `components/TokenStrip.tsx` | 🟢 LOW | 3h |
| **T-DS-U05** `<DesignSystemDetail>`: tabbed detail (Preview/Tokens/Components/Spec) | `components/DesignSystemDetail.tsx` | 🟡 MEDIUM | 8h |
| **T-DS-U06** Implement `DesignSystemsPage.tsx`: grid + filter + import button | `pages/DesignSystemsPage.tsx` | 🟡 MEDIUM | 6h |

**Subtotal**: ~42h

---

## PHASE II — Design Templates Integration

### II.A Service Layer (Go)

| Task | File | Ưu tiên | Estimate |
|------|------|---------|---------|
| **T-TM-S01** Add `TemplateRegistry` vào Skill Service: domain model, loader, SKILL.md parser | `09-skill-service` | 🔴 HIGH | 8h |
| **T-TM-S02** Add HTTP routes `/api/design-templates/*` vào API Gateway | API Gateway | 🔴 HIGH | 3h |
| **T-TM-S03** Add backward compat redirect `/api/skills/:id/*` → `/api/design-templates/:id/*` | API Gateway | 🔴 HIGH | 1h |
| **T-TM-S04** Add gRPC `ListDesignTemplates`/`GetDesignTemplate` RPC vào Skill Service proto | proto | 🟡 MEDIUM | 2h |
| **T-TM-S05** `DeckValidator`: validate `od.mode: deck` templates có keyboard nav | `09-skill-service` | 🟢 LOW | 4h |

### II.B UI Layer (React)

| Task | File | Ưu tiên | Estimate |
|------|------|---------|---------|
| **T-TM-U01** Update `HttpTemplatesApiClient`: thêm `TemplateSummary`, `TemplateInput` types | `api/supplement/http.ts` | 🔴 HIGH | 2h |
| **T-TM-U02** `<TemplateCard>`: iframe preview + mode badge + hover action | `components/TemplateCard.tsx` | 🔴 HIGH | 4h |
| **T-TM-U03** `<TemplateGallery>`: tabs by mode + grid + search | `components/TemplateGallery.tsx` | 🔴 HIGH | 6h |
| **T-TM-U04** `<TemplateInputForm>`: dynamic form từ `od.inputs` | `components/TemplateInputForm.tsx` | 🟡 MEDIUM | 4h |
| **T-TM-U05** `<TemplateDetailModal>`: full preview + inputs + DS picker + CTA | `components/TemplateDetailModal.tsx` | 🟡 MEDIUM | 8h |
| **T-TM-U06** Implement `HomePage.tsx`: tabs (Projects | Templates | Skills) | `pages/HomePage.tsx` | 🔴 HIGH | 4h |

**Subtotal**: ~46h

---

## PHASE III — Prompt Templates Integration

### III.A Service Layer (Go)

| Task | File | Ưu tiên | Estimate |
|------|------|---------|---------|
| **T-PT-S01** Add `PromptTemplate` domain model + `PromptTemplateLoader` | `05-media-service` | 🔴 HIGH | 4h |
| **T-PT-S02** Implement `ArgumentParser`: parse/fill `{argument name=...}` placeholders | `05-media-service` | 🔴 HIGH | 3h |
| **T-PT-S03** Add HTTP routes `/api/prompt-templates/*` vào API Gateway | API Gateway | 🔴 HIGH | 2h |
| **T-PT-S04** Add `POST /api/media/generate-from-template` endpoint | API Gateway + Media Service | 🔴 HIGH | 4h |
| **T-PT-S05** Add gRPC `ListPromptTemplates`/`GenerateFromTemplate` RPCs | proto | 🟡 MEDIUM | 3h |
| **T-PT-S06** Config: Docker volume mounts cho `prompt-templates/` | docker-compose | 🟡 MEDIUM | 1h |

### III.B UI Layer (React)

| Task | File | Ưu tiên | Estimate |
|------|------|---------|---------|
| **T-PT-U01** Update `HttpMediaApiClient`: thêm `PromptTemplate` types + methods | `api/supplement/http.ts` | 🔴 HIGH | 2h |
| **T-PT-U02** `<PromptTemplateCard>`: previewImage + model/aspect/argCount badges | `components/PromptTemplateCard.tsx` | 🔴 HIGH | 3h |
| **T-PT-U03** `<PromptTemplateGallery>`: category pills + grid + search | `components/PromptTemplateGallery.tsx` | 🔴 HIGH | 5h |
| **T-PT-U04** `<TemplateArgumentForm>` (shared): arg fill form | `components/TemplateArgumentForm.tsx` | 🔴 HIGH | 3h |
| **T-PT-U05** `<MediaGenerationPanel>` (T37): Image/Video/Audio tabs | `components/MediaGenerationPanel.tsx` | 🔴 HIGH | 10h |
| **T-PT-U06** `<MediaTaskCard>`: task status display + download | `components/MediaTaskCard.tsx` | 🟡 MEDIUM | 4h |
| **T-PT-U07** Implement `MediaPage.tsx` | `pages/MediaPage.tsx` | 🔴 HIGH | 3h |

**Subtotal**: ~47h

---

## Tổng kết

| Phase | Tasks | Estimate |
|-------|-------|---------|
| I — Design Systems | 11 tasks | 42h |
| II — Design Templates | 11 tasks | 46h |
| III — Prompt Templates | 13 tasks | 47h |
| **Total** | **35 tasks** | **~135h** |

---

## Thứ tự thực hiện (Recommended)

```
Sprint A (1 tuần): T-DS-U01, T-DS-U02, T-TM-U01, T-TM-U06 (Homepage + DS Picker)
Sprint B (1 tuần): T-TM-U02, T-TM-U03, T-TM-U04 (Template Gallery)
Sprint C (1 tuần): T-PT-U01..T-PT-U05 (Media Panel — T37)
Sprint D (1 tuần): Service layer — T-DS-S01..S03, T-TM-S01..S03, T-PT-S01..S04
```

---

## Updates cần thiết trong `specs/services/`

| File | Nội dung cần cập nhật |
|------|-----------------------|
| `04-design-system-service.md` | BuiltinLoader đọc manifest.json, routes mới, gRPC fields mới |
| `09-skill-service.md` | Thêm TemplateRegistry, SKILL.md parser, routes `/api/design-templates/*` |
| `05-media-service.md` | Thêm PromptTemplate domain, ArgumentParser, routes `/api/prompt-templates/*`, generate-from-template |
| `01-api-gateway.md` | Thêm tất cả routes mới cho 3 asset directories |
| `14-deployment.md` | Docker volume mounts cho 3 asset directories |
