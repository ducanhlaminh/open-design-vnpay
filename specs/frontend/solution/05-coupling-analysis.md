# Phân tích Coupling — Frontend ↔ Daemon

> Tài liệu này phân tích chi tiết **tất cả điểm coupling** giữa `apps/web` và `apps/daemon`,  
> làm cơ sở để lên kế hoạch migration chính xác.

---

## 1. Dependency Graph

```
apps/web/src/
├── providers/
│   ├── registry.ts     ← 80+ API calls đến daemon
│   ├── daemon.ts       ← SSE streaming + run lifecycle
│   ├── daemon-url.ts   ← Base URL detection
│   └── api-proxy.ts    ← BYOK API proxy
│
├── state/
│   ├── config.ts       ← app-config + media config sync
│   └── projects.ts     ← project CRUD + file ops
│
└── App.tsx             ← Orchestrate tất cả fetch calls
```

---

## 2. Chi tiết Coupling Từng File

### 2.1 `providers/registry.ts` (~64KB, ~2010 lines)

| Function | Endpoint | Go Service |
|----------|----------|-----------|
| `fetchAgents()` | `GET /api/agents` | AgentService |
| `fetchSkills()` | `GET /api/skills` | SkillService |
| `fetchDesignTemplates()` | `GET /api/design-templates` | SkillService |
| `fetchDesignSystems()` | `GET /api/design-systems` | DesignSystemService |
| `fetchDesignSystem(id)` | `GET /api/design-systems/:id` | DesignSystemService |
| `fetchDesignSystemFiles(id)` | `GET /api/design-systems/:id/files` | DesignSystemService |
| `createDesignSystemDraft()` | `POST /api/design-systems` | DesignSystemService |
| `startDesignSystemGenerationJob()` | `POST /api/design-systems/generation-jobs` | DesignSystemService |
| `fetchDesignSystemGenerationJob()` | `GET /api/design-systems/generation-jobs/:id` | DesignSystemService |
| `deleteDesignSystemDraft()` | `DELETE /api/design-systems/:id` | DesignSystemService |
| `importLocalDesignSystem()` | `POST /api/design-systems/import/local` | DesignSystemService |
| `importGitHubDesignSystem()` | `POST /api/design-systems/import/github` | DesignSystemService |
| `fetchPromptTemplates()` | `GET /api/prompt-templates` | SkillService |
| `daemonIsLive()` | `GET /api/health` | Gateway |
| `fetchConnectors()` | `GET /api/connectors` | PluginService |
| `connectConnector()` | `POST /api/connectors/:id/connect` | PluginService |
| `disconnectConnector()` | `POST /api/connectors/:id/disconnect` | PluginService |
| `fetchDeployConfig()` | `GET /api/deploy/config` | ProjectService |
| `deployProjectFile()` | `POST /api/deploy/project-file` | ProjectService |
| `uploadProjectFiles()` | `POST /api/projects/:id/files` | ProjectService |
| `fetchLiveArtifacts()` | `GET /api/projects/:id/live-artifacts` | ProjectService |
| `refreshLiveArtifact()` | `POST /api/live-artifacts/:id/refresh` | ProjectService |
| `fetchAppVersionInfo()` | `GET /api/version` | Gateway |
| `openExternalUrl()` | `POST /api/system/open-external` | AgentService |
| `importLocalDesignSystem()` | `POST /api/design-systems/import/local` | DesignSystemService |
| *... ~50 more functions* | | |

### 2.2 `providers/daemon.ts` (~27KB, ~760 lines)

| Function | Endpoint | Go Service |
|----------|----------|-----------|
| `streamViaDaemon()` | `POST /api/runs` + `GET /api/runs/:id/events` | AgentService |
| `reattachDaemonRun()` | `GET /api/runs/:id/events` | AgentService |
| `fetchChatRunStatus()` | `GET /api/runs/:id` | AgentService |
| `submitChatRunToolResult()` | `POST /api/runs/:id/tool-result` | AgentService |
| `reportChatRunFeedback()` | `POST /api/runs/:id/feedback` | AgentService |
| `listActiveChatRuns()` | `GET /api/runs?status=active` | AgentService |
| `listProjectRuns()` | `GET /api/runs` | AgentService |
| `saveArtifact()` | `POST /api/artifacts/save` | ProjectService |

**Đặc biệt phức tạp**: `streamViaDaemon()` implement toàn bộ SSE protocol với:
- Reconnect logic (5 retries)
- `Last-Event-ID` resumption
- `stdout`/`stderr`/`agent`/`start`/`end`/`error` event types
- Stuck-run watchdog (`trackRunStart`/`trackRunProgress`/`trackRunTerminal`)
- Cancel via `AbortSignal`

### 2.3 `state/config.ts` (~26KB)

| Function | Endpoint | Go Service |
|----------|----------|-----------|
| `fetchDaemonConfig()` | `GET /api/app-config` | ConfigService |
| `syncConfigToDaemon()` | `PUT /api/app-config` | ConfigService |
| `fetchMediaProvidersFromDaemon()` | `GET /api/media/config` | ConfigService |
| `syncMediaProvidersToDaemon()` | `PUT /api/media/config` | ConfigService |
| `fetchComposioConfigFromDaemon()` | `GET /api/connectors/composio` | PluginService |
| `syncComposioConfigToDaemon()` | `PUT /api/connectors/composio` | PluginService |

**Config Fields Owned by Daemon** (cần migrate sang Config Service):
```typescript
// Hiện tại trong daemon's app-config.json:
interface AppConfigPrefs {
  installationId: string;      // → ConfigService
  telemetry: TelemetryConfig;  // → ConfigService
  privacyDecisionAt: number;   // → ConfigService
}
// Media API keys → ConfigService (encrypted)
// Composio API key → PluginService (encrypted)
```

### 2.4 `state/projects.ts` (~33KB)

| Function | Endpoint | Go Service |
|----------|----------|-----------|
| `listProjects()` | `GET /api/projects` | ProjectService |
| `getProject()` | `GET /api/projects/:id` | ProjectService |
| `createProject()` | `POST /api/projects` | ProjectService |
| `patchProject()` | `PATCH /api/projects/:id` | ProjectService |
| `deleteProject()` | `DELETE /api/projects/:id` | ProjectService |
| `importFolderProject()` | `POST /api/projects/import` | ProjectService |
| `listTemplates()` | `GET /api/projects/templates` | ProjectService |
| `listProjectFiles()` | `GET /api/projects/:id/files` | ProjectService |

### 2.5 `App.tsx` — Daemon Liveness Detection

```typescript
// App.tsx:374 — daemonIsLive() check on mount
useEffect(() => {
  (async () => {
    const alive = await daemonIsLive();
    setDaemonLive(alive);
    if (!alive) {
      // Stop all loading flags — empty state renders
      return;
    }
    // ... fan out all data fetches
  })();
}, []);
```

**Ý nghĩa**: Frontend có "offline mode" khi daemon không chạy. Sau migration sang Go Gateway, behavior này giữ nguyên — chỉ health check endpoint đổi target.

### 2.6 `next.config.ts` — Build-time Coupling

```typescript
// Line 11-12: Daemon port hardcoded
const DAEMON_PORT = Number(process.env.OD_PORT) || 7456;
const DAEMON_ORIGIN = `http://127.0.0.1:${DAEMON_PORT}`;

// Line 195-199: Dev rewrite to daemon
rewrites: [
  { source: '/api/:path*', destination: `${DAEMON_ORIGIN}/api/:path*` },
  { source: '/artifacts/:path*', destination: `${DAEMON_ORIGIN}/artifacts/:path*` },
  { source: '/frames/:path*', destination: `${DAEMON_ORIGIN}/frames/:path*` },
]

// Line 175-182: Prod = static export (daemon serves HTML)
output: 'export',
```

**Migration**: `DAEMON_ORIGIN` → `API_GATEWAY_ORIGIN` (same port 7456, Go Gateway).

---

## 3. Coupling Heat Map

```
High Coupling:
  providers/registry.ts  ████████████████████ 80+ calls
  providers/daemon.ts    ████████████ 15 calls (nhưng SSE phức tạp)
  state/config.ts        ████████ 6 calls (config persistence)
  state/projects.ts      ████████ 8 calls
  App.tsx                ████ Orchestration
  next.config.ts         ████ Dev rewrite + build mode

Low Coupling (không call API):
  components/            ← React UI, không fetch trực tiếp
  hooks/                 ← Wrap providers/state functions
  router.ts              ← Client-side routing
  types.ts               ← Type definitions (shared với daemon qua @open-design/contracts)
```

---

## 4. Shared Types — `@open-design/contracts`

Package `packages/contracts/` định nghĩa types được share giữa web và daemon:

```typescript
// packages/contracts/src/index.ts
export type {
  Project, Conversation, ChatMessage, ChatRequest,
  ChatSseEvent, ChatSseStartPayload, DaemonAgentPayload,
  DesignSystemSummary, DesignSystemDetail,
  LiveArtifact, LiveArtifactSummary,
  AgentInfo, SkillSummary, SkillDetail,
  AppConfigPrefs,
  // ... ~50 more types
}
```

**Migration note**: Go services dùng Protobuf definitions, nhưng API Gateway expose HTTP/JSON với cùng shape như TypeScript contracts. Contracts package **không cần thay đổi**.

---

## 5. Non-HTTP Coupling (Phức tạp hơn)

### 5.1 `packages/sidecar` — Desktop IPC

```typescript
// packages/sidecar — Bridge giữa Next.js server và daemon trong packaged desktop
// Chỉ áp dụng cho Electron build
// Sau migration: sidecar bridge sang Go Gateway thay vì daemon
```

### 5.2 `packages/host` — Host Bridge Interface

```typescript
// packages/host — OpenDesignHost interface cho embed mode
// Hiện tại: host calls daemon qua HTTP
// Sau migration: host calls Go Gateway (same interface)
```

### 5.3 BYOK API Proxy (`providers/api-proxy.ts`)

```typescript
// providers/api-proxy.ts — Direct provider API calls (bypass daemon)
// BYOK mode: Web → Anthropic/OpenAI/Google API trực tiếp
// Không qua daemon → Không cần migrate (đây là feature, không phải coupling)
```

---

## 6. Migration Priority Matrix

| Endpoint Group | Traffic Volume | Complexity | Priority |
|---------------|---------------|-----------|---------|
| `/api/runs/*` + SSE | Rất cao | Cao | P0 — Phase 1 |
| `/api/projects/*` | Cao | Trung bình | P0 — Phase 1 |
| `/api/app-config` | Trung bình | Thấp | P1 — Phase 2 |
| `/api/design-systems/*` | Trung bình | Cao | P1 — Phase 2 |
| `/api/skills/*` | Trung bình | Thấp | P1 — Phase 2 |
| `/api/agents` | Thấp | Trung bình | P1 — Phase 2 |
| `/api/media/config` | Thấp | Thấp | P1 — Phase 2 |
| `/api/connectors/*` | Thấp | Cao | P2 — Phase 2 |
| `/api/deploy/*` | Rất thấp | Trung bình | P2 — Phase 2 |
| `/mcp/*` | Thấp | Cao | P2 — Phase 2 |
| `/artifacts/*`, `/frames/*` | Cao | Thấp | P0 — Phase 1 |

---

## 7. Kết luận

### Frontend cần thay đổi gì?

| Layer | Thay đổi | Lý do |
|-------|---------|-------|
| `providers/registry.ts` | Refactor sang API client | Phase 0 |
| `providers/daemon.ts` | Refactor sang API client | Phase 0 |
| `state/config.ts` | Refactor sang API client | Phase 0 |
| `state/projects.ts` | Refactor sang API client | Phase 0 |
| `next.config.ts` | Đổi `DAEMON_ORIGIN` → `GATEWAY_ORIGIN` | Phase 1 |
| `next.config.ts` | Enable server/standalone output mode | Phase 3 |
| Auth (mới) | Thêm JWT auth cho cross-origin | Phase 3 |

### Frontend KHÔNG cần thay đổi gì?

| Layer | Lý do |
|-------|-------|
| Tất cả React components | Không fetch trực tiếp |
| Routing (`router.ts`) | Client-side, không liên quan |
| Types (`types.ts`) | API contract giữ nguyên |
| `@open-design/contracts` | Shape tương thích |
| SSE consumer logic | Go Gateway giữ nguyên SSE format |
| BYOK provider logic | Bypass daemon, không migrate |

**Tóm lại**: ~4 file providers/state cần refactor (Phase 0), config nhỏ trong next.config.ts (Phase 1/3). **Components và types không đụng đến**.
