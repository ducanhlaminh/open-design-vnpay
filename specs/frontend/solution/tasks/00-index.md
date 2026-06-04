# Tasks Index — Frontend Separation

> **Cập nhật**: 2026-06-03  
> **Tổng số tác vụ**: 68 tasks (Phase 0–3) + DEV tasks (Go services)  
> **Timeline**: 20 tuần (5 tháng)

---

## Tech Stack — Frontend (React CSR)

> ⚠️ **Không dùng Next.js** — Frontend là **React thuần Client-Side Rendering (CSR)**

| Thành phần | Công nghệ |
|-----------|----------|
| Framework | **React 18** (CSR, không SSR) |
| Build tool | **Vite** |
| Routing | **React Router v6** (`createBrowserRouter`) |
| Language | TypeScript |
| Testing | **Vitest** + `@testing-library/react` |
| E2E | **Playwright** |
| Styling | CSS Modules / Tailwind CSS |
| HTTP/SSE | `fetch()` API thuần (không axios) |
| State | Zustand / Context API |
| Deploy | **Nginx** static serving (Docker) hoặc S3/CDN |
| Dev server | Vite dev server với proxy `/api/*` → Gateway |

**Thư mục output**: `ui/` (nằm trong project root)

---

## Danh sách Task Files

| File | Phase | Tuần | Tasks |
|------|-------|------|-------|
| [PHASE-0-T01 → T15](./PHASE-0-api-abstraction.md) | Phase 0 | 1–3 | API Client Abstraction Layer (React) |
| [PHASE-0-supplement-api-clients.md](./PHASE-0-supplement-api-clients.md) | Phase 0 | 2–4 | T16–T27: API clients bổ sung (Export, Deploy, Import, Media, Routines, MCP, Memory, Plugins, Connectors) |
| [PHASE-0-supplement-ui-components.md](./PHASE-0-supplement-ui-components.md) | Phase 0 | 3–6 | T28–T39: UI Components (QuestionForm, ArtifactViewer, FileWorkspace, Settings...) |
| [PHASE-1-T01 → T22](./PHASE-1-gateway-core-services.md) | Phase 1 | 4–11 | Go Gateway + Agent + Project Services |
| [PHASE-2-T01 → T20](./PHASE-2-remaining-services.md) | Phase 2 | 12–18 | Remaining 7 Services + Daemon Retirement |
| [PHASE-3-T01 → T13](./PHASE-3-full-decoupled.md) | Phase 3 | 19–20 | React SPA + Vite + Nginx Deploy |

---

## Tổng quan Status

```
PHASE 0 — API Abstraction Layer     [ ] 15 tasks   (Tuần 1–3)   — ui/src/api/
PHASE 0 — Supplement: API Clients   [ ] 12 tasks   (Tuần 2–4)   — ui/src/api/ (bổ sung)
PHASE 0 — Supplement: UI Components [ ] 12 tasks   (Tuần 3–6)   — ui/src/components/
PHASE 1 — Gateway + Core Services   [ ] 22 tasks   (Tuần 4–11)  — Go services
PHASE 2 — Remaining Services        [ ] 20 tasks   (Tuần 12–18) — Go services
PHASE 3 — Full Decoupled Deploy     [ ] 13 tasks   (Tuần 19–20) — Vite + Nginx
─────────────────────────────────────────────────────────────────
TOTAL                               [ ] 94 tasks   (20 tuần)
```

> **Gap Analysis**: Xem [FEATURE-COVERAGE.md](../FEATURE-COVERAGE.md) để biết các tính năng PRD/SRS/URD
> được bổ sung vào supplement tasks (T16–T39).

---

## Dependency Flow

```
PHASE 0 (T01–T15)              ui/src/ — React CSR
    ├─ T01: BaseApiClient (fetch, import.meta.env)
    ├─ T02–T08: Domain API Clients
    ├─ T09: API Registry Singleton
    ├─ T10–T13: Refactor Providers
    └─ T14–T15: Tests (Vitest)
         │
         ▼ Unblocks PHASE 1
PHASE 1 (T01–T22)              Go services
    ├─ T01–T06: API Gateway (Go, preview-gateway)
    ├─ T07–T14: Agent Service (Go, preview-ai-agent)
    ├─ T15–T21: Project Service (Go, preview-project)
    └─ T22: Phase 1 Validation
         │
         ▼ Unblocks PHASE 2
PHASE 2 (T01–T20)              Go services
    ├─ T01–T05: Design System Service
    ├─ T06–T08: Skill + Config Service
    ├─ T09–T11: MCP Service
    ├─ T12–T13: Memory Service
    ├─ T14–T15: Plugin Service
    └─ T19–T20: Daemon Retirement
         │
         ▼ Unblocks PHASE 3
PHASE 3 (T01–T13)              React SPA + Nginx + Electron
    ├─ T01–T04: Vite config + React Router + Next.js removal
    ├─ T05–T06: Dockerfile (Nginx) + Docker Compose
    ├─ T07–T08: Electron Desktop (loadFile + IPC)
    └─ T09–T13: E2E, Load Test, Bundle Optimization
```

---

## Status Legend

- `[ ]` — Chưa bắt đầu
- `[/]` — Đang thực hiện
- `[x]` — Hoàn thành
- `[!]` — Blocked / Cần review

---

## Quick Reference — Files cần tạo mới

### Phase 0 — ui/
```
ui/
├── package.json                   ← @open-design/ui
├── vite.config.ts                 ← Vite config + dev proxy
├── vitest.config.ts               ← Test config
├── tsconfig.json
├── index.html                     ← SPA entry
├── nginx.conf                     ← Phase 3: Nginx config
├── Dockerfile                     ← Phase 3: Vite build + Nginx
├── src/
│   ├── main.tsx                   ← React entry point (T39)
│   ├── router.tsx                 ← React Router v6 (T39)
│   ├── layouts/
│   │   └── RootLayout.tsx         ← Sidebar + main area (T39)
│   ├── api/
│   │   ├── client.ts              ← T01: BaseApiClient (fetch API)
│   │   ├── index.ts               ← T09+T27: API Registry (all clients)
│   │   ├── projects/              ← T02
│   │   ├── runs/                  ← T03 (SSE + all event types T16)
│   │   ├── design-systems/        ← T04
│   │   ├── skills/                ← T05
│   │   ├── config/                ← T06
│   │   ├── agents/                ← T07
│   │   ├── connectors/            ← T08 + T25
│   │   ├── export/                ← T17 NEW (FR-09)
│   │   ├── deploy/                ← T18 NEW (FR-10)
│   │   ├── import/                ← T19 NEW (FR-11)
│   │   ├── templates/             ← T20 NEW (FR-12)
│   │   ├── media/                 ← T21 NEW (FR-13)
│   │   ├── routines/              ← T22 NEW (FR-14)
│   │   ├── mcp/                   ← T23 NEW (FR-16)
│   │   ├── memory/                ← T24 NEW (FR-17)
│   │   └── plugins/               ← T26 NEW (FR-18)
│   ├── components/
│   │   ├── QuestionForm.tsx       ← T28 NEW (FR-07.1)
│   │   ├── DirectionPicker.tsx    ← T29 NEW (FR-07.2)
│   │   ├── TodoCard.tsx           ← T30 NEW (FR-06.4)
│   │   ├── ArtifactViewer.tsx     ← T31 NEW (FR-08) ★ CORE
│   │   ├── FileWorkspace/         ← T32 NEW (FR-08.3)
│   │   ├── PreviewComments.tsx    ← T33 NEW (FR-08.4)
│   │   ├── DeployDialog.tsx       ← T35 NEW (FR-10)
│   │   ├── ImportDialog.tsx       ← T36 NEW (FR-11)
│   │   ├── MediaGenerationPanel.tsx ← T37 NEW (FR-13)
│   │   ├── RoutinesManager/       ← T38 NEW (FR-14/15)
│   │   └── SettingsDialog/        ← T34 NEW (FR-21) full schema
│   ├── pages/
│   ├── providers/                 ← T10–T11
│   └── state/                     ← T12–T13
└── tests/e2e/                     ← Phase 3
```

### Phase 1–2 — Go Services
```
services/
├── preview-gateway/               ← Nâng cấp (thêm OD routes)
├── preview-ai-agent/              ← Nâng cấp (CLI spawner + SSE)
├── preview-project/               ← Nâng cấp (Conversation, Run, Files)
├── config-service/                ← Tạo mới (AES encryption)
└── skill-service/                 ← Tạo mới
```

---

## Lưu ý khi implement Phase 0

### Import `meta.env` thay `process.env`
```typescript
// ❌ SAI — Next.js style
const url = process.env.NEXT_PUBLIC_API_URL;

// ✅ ĐÚNG — Vite style
const url = import.meta.env.VITE_API_GATEWAY_URL ?? 'http://localhost:7456';
```

### Không dùng `next/link`, `next/image`
```typescript
// ❌ SAI — Next.js
import Link from 'next/link';
import Image from 'next/image';

// ✅ ĐÚNG — React Router
import { Link } from 'react-router-dom';
// Dùng <img> thuần hoặc custom Image component
```

### SSE với `fetch()` không phải `EventSource`
```typescript
// ❌ EventSource: không hỗ trợ custom headers
const es = new EventSource('/api/runs/123/events');

// ✅ fetch() streaming:
const res = await fetch('/api/runs/123/events', {
  headers: { 'Last-Event-ID': lastEventId },
  signal: abortController.signal,
});
const reader = res.body!.getReader();
// ... parse SSE frames từ reader
```
