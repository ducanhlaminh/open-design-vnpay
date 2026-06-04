# Master Task Tracker — Frontend Separation

> **Cập nhật**: 2026-06-04  
> **Tổng**: 94 tasks / 20 tuần  
> **Progress**: 35 / 94 completed  
> **Gap Analysis**: [FEATURE-COVERAGE.md](../FEATURE-COVERAGE.md)

---

## PHASE 0 — API Abstraction Layer (Tuần 1–3)
> **Frontend Dev** | Chỉ `ui` | 15 tasks

### Tuần 1 — Tạo API Client Layer
- [x] **T01** `BaseApiClient` — `src/api/client.ts` *(4h)* → `ui/src/api/client.ts`
- [x] **T02** `ProjectApiClient` — `src/api/projects/` *(8h)* → `ui/src/api/projects/http.ts`
- [x] **T03** `RunsApiClient` (SSE) — `src/api/runs/` *(12h)* ⭐ → `ui/src/api/runs/http.ts` (all 9 event types)
- [x] **T04** `DesignSystemApiClient` — `src/api/domain/http.ts` *(8h)*
- [x] **T05** `SkillApiClient` — `src/api/domain/http.ts` *(4h)*
- [x] **T06** `ConfigApiClient` — `src/api/domain/http.ts` *(6h)*
- [x] **T07** `AgentApiClient` — `src/api/domain/http.ts` *(4h)*
- [x] **T08** `ConnectorApiClient` — `src/api/domain/http.ts` *(6h)*
- [x] **T09** `api/index.ts` singleton — registry của tất cả clients *(2h)*

### Tuần 2 — Refactor Providers
- [ ] **T10** Refactor `providers/registry.ts` *(16h)* ⭐ complex
- [ ] **T11** Refactor `providers/daemon.ts` *(8h)* ⭐ complex
- [ ] **T12** Refactor `state/config.ts` *(6h)*
- [ ] **T13** Refactor `state/projects.ts` *(6h)*

### Tuần 3 — Tests & Sign-off
- [ ] **T14** Unit tests API clients *(16h)*
- [ ] **T15** Smoke test + Phase 0 sign-off *(8h)*

> **Phase 0 Gate**: Không có `fetch('/api/...')` trực tiếp trong providers/state ✓

---

## PHASE 0 — Supplement: API Clients Bổ sung (Tuần 2–4)
> **Frontend Dev** | `ui/src/api/` | 12 tasks  
> **File**: [PHASE-0-supplement-api-clients.md](./PHASE-0-supplement-api-clients.md)

### API Clients thiếu từ PRD/SRS/URD
- [x] **T16** SSE all event types (todo, artifact, file_op, question_form, direction_picker) → `ui/src/api/runs/http.ts`
- [x] **T17** `ExportApiClient` — HTML/PDF/ZIP/Markdown → `ui/src/api/supplement/http.ts`
- [x] **T18** `DeployApiClient` — Vercel + Cloudflare + polling → `ui/src/api/supplement/http.ts` ⭐
- [x] **T19** `ImportApiClient` — Claude Design ZIP → `ui/src/api/supplement/http.ts`
- [x] **T20** `TemplatesApiClient` — CRUD → `ui/src/api/supplement/http.ts`
- [x] **T21** `MediaApiClient` — Image/Video/Audio + polling → `ui/src/api/supplement/http.ts` ⭐
- [x] **T22** `RoutinesApiClient` — CRUD + Orbit + runs → `ui/src/api/supplement/http.ts`
- [x] **T23** `MCPApiClient` — config + OAuth → `ui/src/api/supplement/http.ts`
- [x] **T24** `MemoryApiClient` — list/extract/delete → `ui/src/api/supplement/http.ts`
- [x] **T25** `ConnectorsApiClient` — đã trong domain/http.ts + composio
- [x] **T26** `PluginsApiClient` — install/uninstall/apply → `ui/src/api/supplement/http.ts`
- [x] **T27** Update `api/index.ts` — export all clients → `ui/src/api/index.ts`

> **Đã hoàn thành**: T16–T27 — ~48h | Tất cả trong `ui/src/api/`

---

## PHASE 0 — Supplement: UI Core Components (Tuần 3–6)
> **Frontend Dev** | `ui/src/components/` | 12 tasks  
> **File**: [PHASE-0-supplement-ui-components.md](./PHASE-0-supplement-ui-components.md)

### Components thiếu từ PRD/SRS/URD
- [x] **T28** `<QuestionForm>` — Turn-1 discovery form → `ui/src/components/QuestionForm.tsx` ⭐ CORE
- [x] **T29** `<DirectionPicker>` — 5 visual aesthetics → `ui/src/components/DirectionPicker.tsx`
- [x] **T30** `<TodoCard>` — Real-time todo progress → `ui/src/components/TodoCard.tsx`
- [x] **T31** `<ArtifactViewer>` — Sandboxed iframe + export chips → `ui/src/components/ArtifactViewer.tsx` ⭐ CORE
- [ ] **T32** `<FileWorkspace>` — Code editor + auto-save (FR-08.3) *(12h)* ⭐ complex
- [ ] **T33** `<PreviewComments>` — Annotation overlay (FR-08.4) *(8h)*
- [ ] **T34** `<AppSettingsDialog>` Full schema 9 tabs (FR-21) *(16h)* ⭐ complex
- [x] **T35** `<DeployDialog>` — Vercel/Cloudflare form + status → bên trong `ArtifactViewer.tsx`
- [x] **T36** `<ImportDialog>` — Drag & drop ZIP → `ui/src/components/ImportDialog.tsx`
- [ ] **T37** `<MediaGenerationPanel>` — Image/Video/Audio (FR-13) *(10h)*
- [ ] **T38** `<RoutinesManager>` — CRUD + Orbit config (FR-14/15) *(8h)*
- [x] **T39** App entry + React Router v6 + RootLayout → `ui/src/main.tsx`, `router.tsx`, `layouts/RootLayout.tsx`

> **Tiến độ**: 7/12 hoàn thành | Còn lại: T32 FileWorkspace, T33 Comments, T34 Settings, T37 Media, T38 Routines

---

## PHASE 1 — Gateway + Core Services (Tuần 4–11)
> **Go Dev (2–3)** + **Frontend Dev (validation)** | 22 tasks

### Tuần 4–5 — Go API Gateway
- [ ] **T01** Gateway project setup + Makefile *(4h)*
- [ ] **T02** Config + Viper setup *(3h)*
- [ ] **T03** Daemon proxy (Strangler Fig fallback) *(6h)* ⭐ critical
- [ ] **T04** Auth middleware (JWT + local trust) *(8h)*
- [ ] **T05** CORS + Rate limit middleware *(4h)*
- [ ] **T06** Router + feature flags + Gateway MVP *(6h)*

### Tuần 6–8 — Agent Service
- [ ] **T07** Agent Service project setup *(3h)*
- [ ] **T08** Agent domain layer (Run entity + interfaces) *(6h)*
- [ ] **T09** Agent Protobuf definitions *(4h)*
- [ ] **T10** CLI Agent Executor (spawn claude/codex/gemini) *(12h)* ⭐ complex
- [ ] **T11** Agent use cases (create/stream/cancel) *(8h)*
- [ ] **T12** Agent SQLite DB repository *(6h)*
- [ ] **T13** Agent gRPC handler *(6h)*
- [ ] **T14** Gateway → Agent Service integration (SSE proxy) *(6h)* ⭐ critical

### Tuần 9–11 — Project Service
- [ ] **T15** Project Service project setup *(3h)*
- [ ] **T16** Project domain layer *(8h)*
- [ ] **T17** Project Protobuf definitions *(4h)*
- [ ] **T18** Project SQLite DB repository *(8h)*
- [ ] **T19** Data migration tool (daemon → Project Service) *(8h)*
- [ ] **T20** Project file store + static serving *(6h)*
- [ ] **T21** Gateway → Project Service integration *(6h)*
- [ ] **T22** Phase 1 A/B validation (24h monitoring) *(8h)*

> **Phase 1 Gate**: SSE streaming E2E pass; A/B test 24h zero regression ✓

---

## PHASE 2 — Remaining Services + Daemon Retirement (Tuần 12–18)
> **Go Dev (2–3)** | 20 tasks | Services có thể parallel

### Tuần 12–13 — Design System Service
- [ ] **T01** Design System Service setup + domain *(8h)*
- [ ] **T02** DS file serving (built-in + user DSes) *(6h)*
- [ ] **T03** DS gRPC + Gateway integration *(8h)*
- [ ] **T04** DS generation jobs (async) *(8h)*
- [ ] **T05** DS import (local + GitHub) *(6h)*

### Tuần 13–14 — Skill Service + Config Service
- [ ] **T06** Skill Service setup + file serving *(8h)*
- [ ] **T07** Skill Service Gateway integration *(3h)*
- [ ] **T08** Config Service (encrypted storage, installationId) *(12h)* ⭐ security

### Tuần 15 — MCP Service
- [ ] **T09** MCP Service setup *(4h)*
- [ ] **T10** MCP active context (Redis) *(4h)*
- [ ] **T11** MCP protocol passthrough + token auth *(8h)*

### Tuần 16 — Memory + Plugin Services
- [ ] **T12** Memory Service setup + domain *(6h)*
- [ ] **T13** Memory embedding + vector search *(10h)* ⭐ complex
- [ ] **T14** Plugin Service setup *(4h)*
- [ ] **T15** Plugin registry + Composio config *(8h)*

### Tuần 17 — Telemetry + Deploy Routes
- [ ] **T16** Telemetry Service (OpenTelemetry, Langfuse) *(8h)*
- [ ] **T17** Deploy routes (Cloudflare + Vercel) *(8h)*

### Tuần 17–18 — Daemon Retirement
- [ ] **T18** Verify all routes migrated (script) *(4h)*
- [ ] **T19** Final data migration (SQLite → Service DBs) *(8h)* ⭐ critical
- [ ] **T20** Daemon retirement execution *(4h)*

> **Phase 2 Gate**: 0 daemon fallback requests; 48h monitoring stable ✓

---

## PHASE 3 — Full Decoupled Deployment (Tuần 19–20)
> **Frontend Dev + DevOps** | 11 tasks

### Tuần 19–20 — React SPA + Nginx + Electron
- [ ] **T01** Vite config + `VITE_API_GATEWAY_URL` env *(3h)*
- [ ] **T02** API Client — Direct browser HTTP (`import.meta.env`) *(4h)*
- [ ] **T03** React Router v6 setup + migrate từ Next.js routing *(3h)*
- [ ] **T04** Xóa bỏ Next.js APIs (`next/link`, `next/image`, `next/navigation`) *(6h)*
- [ ] **T05** Dockerfile (Vite build + Nginx static) *(3h)* — **không cần Node.js runtime**
- [ ] **T06** Docker Compose Nginx `od` profile *(2h)*
- [ ] **T07** Electron: `loadFile(dist/index.html)` thay server *(8h)*
- [ ] **T08** Electron: IPC bridge cho `openExternal`, `getGatewayUrl` *(6h)*
- [ ] **T09** E2E test suite (Playwright + Vite dev server) *(16h)*
- [ ] **T10** Load test API Gateway (k6 Browser) *(4h)*
- [ ] **T11** Bundle optimization + code splitting (`React.lazy`) *(4h)*
- [ ] **T12** Security headers + CSP trong nginx.conf *(2h)*
- [ ] **T13** Documentation + sign-off *(4h)*

> **Phase 3 Gate**: `pnpm build` → `dist/`; Nginx SPA với `/api/` proxy; Playwright E2E 100% pass; Bundle < 500KB ✓

---

## Effort Summary

| Phase | Tasks | Est. Effort | Team |
|-------|-------|-------------|------|
| Phase 0 — Core | 15 | ~110h | 1–2 Frontend Dev |
| Phase 0 — API Clients Supplement | 12 | ~48h | 1 Frontend Dev |
| Phase 0 — UI Components Supplement | 12 | ~100h | 1–2 Frontend Dev |
| Phase 1 — Gateway + Agent + Project | 22 | ~155h | 2–3 Go Dev + 1 Frontend |
| Phase 2 — Remaining Services | 20 | ~140h | 2–3 Go Dev |
| Phase 3 — Deploy + E2E | 13 | ~62h | 1 Frontend + 1 DevOps |
| **Total** | **94** | **~615h** | |

---

## Tech Stack Reminder

> **Frontend**: React 18 CSR + Vite + React Router v6 — **không có Next.js**  
> **Backend**: Go microservices (nâng cấp `services/preview-*`)  
> **Deploy**: Nginx static (SPA) + Go Gateway  
> **Dev**: `pnpm --filter @open-design/ui dev` → Vite proxy → Gateway  

---

## Critical Path

```
T01 (BaseApiClient — fetch + import.meta.env)
└─ T02–T08 (Domain clients)
   └─ T09 (api/index.ts)
      └─ T10–T13 (Refactor providers/state)
         └─ T14–T15 (Tests + Phase 0 gate)
            └─ [P1] T01–T06 (Go Gateway MVP)
               └─ [P1] T07–T14 (Agent Service + SSE gRPC) ← LONGEST PATH
                  └─ [P1] T15–T21 (Project Service)
                     └─ [P1] T22 (Phase 1 gate)
                        └─ [P2] T01–T17 (parallel services)
                           └─ [P2] T18–T20 (Daemon retirement)
                              └─ [P3] T01–T13 (Vite + React Router + Nginx)
```

**Bottleneck**: P1-T10 (CLI Agent Executor) và P1-T14 (SSE proxy) — cần senior Go developer.

---

## Legend

- ⭐ = Complex/critical task — cần senior dev hoặc careful review
- `[ ]` = Chưa bắt đầu
- `[/]` = Đang làm
- `[x]` = Hoàn thành
- `[!]` = Blocked
