# PHASE 0 — API Abstraction Layer

> **Tuần**: 1–3  
> **Phạm vi**: Chỉ `ui/src/` — không đụng backend  
> **Mục tiêu**: Tách biệt HTTP logic vào `api/` layer có interface rõ ràng  
> **Ref**: [01-api-client-abstraction.md](../01-api-client-abstraction.md)

---

## Tuần 1 — Tạo API Client Layer

---

### T01 — Tạo `BaseApiClient`

**File**: `ui/src/api/client.ts`  
**Effort**: 4h  
**Assignee**: Frontend Dev  
**Status**: `[ ]`

**Mô tả**: Tạo base class với các HTTP method helpers (get, post, put, delete), error handling chuẩn, và `ApiError` class.

**Acceptance Criteria**:
- [ ] `BaseApiClient` có methods: `get<T>()`, `post<T>()`, `put<T>()`, `patch<T>()`, `del()`
- [ ] `ApiError` class với `status` (HTTP code) và `message`
- [ ] Tất cả methods nhận optional `RequestOptions` (signal, headers)
- [ ] Không throw raw `fetch` errors — wrap trong `ApiError`
- [ ] Export: `BaseApiClient`, `ApiError`, `RequestOptions`

**Files tạo mới**:
```
ui/src/api/client.ts
ui/src/api/types.ts   ← Shared request/response base types
```

**Test**: Unit test mock `fetch` → assert ApiError được throw đúng.

---

### T02 — Tạo `ProjectApiClient`

**File**: `ui/src/api/projects/`  
**Effort**: 8h  
**Assignee**: Frontend Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Mô tả**: Interface + HTTP implementation cho tất cả project-related endpoints.

**Endpoints cần implement** (từ `state/projects.ts`):
```typescript
GET    /api/projects
GET    /api/projects/:id
POST   /api/projects
PATCH  /api/projects/:id
DELETE /api/projects/:id
POST   /api/projects/import
GET    /api/projects/templates
DELETE /api/projects/templates/:id
GET    /api/projects/:id/files
POST   /api/projects/:id/files         ← upload
POST   /api/projects/:id/conversations
GET    /api/projects/:id/conversations
GET    /api/projects/:id/live-artifacts
GET    /api/projects/:id/design-system-package-audit
POST   /api/projects/:id/replace-working-dir
```

**Acceptance Criteria**:
- [ ] `IProjectApiClient` interface định nghĩa đầy đủ methods
- [ ] `HttpProjectApiClient extends BaseApiClient implements IProjectApiClient`
- [ ] Mọi method return `null` / `[]` khi error (không throw)
- [ ] Types được import từ `@open-design/contracts` và `../types`

**Files tạo mới**:
```
ui/src/api/projects/client.ts  ← Interface
ui/src/api/projects/http.ts    ← HTTP implementation
```

---

### T03 — Tạo `RunsApiClient` (SSE)

**File**: `ui/src/api/runs/`  
**Effort**: 12h  
**Assignee**: Frontend Dev (senior)  
**Depends on**: T01  
**Status**: `[ ]`

**Mô tả**: Interface + HTTP implementation cho run lifecycle và SSE streaming. Đây là task phức tạp nhất — cần migrate toàn bộ logic từ `providers/daemon.ts`.

**Endpoints cần implement**:
```typescript
POST   /api/runs                      ← createRun()
GET    /api/runs/:id/events           ← streamEvents() [SSE]
POST   /api/runs/:id/cancel           ← cancelRun()
POST   /api/runs/:id/tool-result      ← submitToolResult()
POST   /api/runs/:id/feedback         ← reportFeedback()
GET    /api/runs/:id                  ← getRunStatus()
GET    /api/runs                      ← listRuns()
POST   /api/artifacts/save            ← saveArtifact()
```

**Acceptance Criteria**:
- [ ] `IRunsApiClient` interface với `streamEvents()` callback-based API
- [ ] SSE consumer logic (reconnect 5 lần, `Last-Event-ID` resumption)
- [ ] Support cả `stdout` / `stderr` / `agent` / `start` / `end` / `error` event types
- [ ] `AbortSignal` cancel hủy SSE connection
- [ ] `cancelSignal` gọi `POST /api/runs/:id/cancel`
- [ ] Stuck-run tracking (`trackRunStart`, `trackRunProgress`, `trackRunTerminal`) vẫn hoạt động
- [ ] `buildDaemonTranscript()` và `latestUserPromptFromHistory()` giữ nguyên logic

**Files tạo mới**:
```
ui/src/api/runs/client.ts      ← Interface + types
ui/src/api/runs/http.ts        ← SSE implementation
ui/src/api/runs/sse-parser.ts  ← Tách riêng SSE frame parsing
```

**Note**: Move `translateAgentEvent()`, `buildDaemonTranscript()`, `buildPriorRunContextWarning()` vào `runs/http.ts` hoặc `runs/transcript.ts`.

---

### T04 — Tạo `DesignSystemApiClient`

**File**: `ui/src/api/design-systems/`  
**Effort**: 8h  
**Assignee**: Frontend Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Endpoints cần implement** (từ `providers/registry.ts`):
```typescript
GET    /api/design-systems
GET    /api/design-systems/:id
POST   /api/design-systems
PATCH  /api/design-systems/:id
DELETE /api/design-systems/:id
GET    /api/design-systems/:id/files
GET    /api/design-systems/:id/file?path=...
POST   /api/design-systems/:id/workspace
POST   /api/design-systems/generation-jobs
GET    /api/design-systems/generation-jobs/:id
GET    /api/design-systems/:id/revisions
PATCH  /api/design-systems/:id/revisions/:revId
POST   /api/design-systems/:id/revision-jobs
POST   /api/design-systems/import/local
POST   /api/design-systems/import/github
```

**Acceptance Criteria**:
- [ ] `IDesignSystemApiClient` interface
- [ ] `HttpDesignSystemApiClient` implementation
- [ ] `parseDesignSystemDetail()` helper giữ nguyên (wrapper handling)

**Files tạo mới**:
```
ui/src/api/design-systems/client.ts
ui/src/api/design-systems/http.ts
```

---

### T05 — Tạo `SkillApiClient`

**File**: `ui/src/api/skills/`  
**Effort**: 4h  
**Assignee**: Frontend Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Endpoints**:
```typescript
GET    /api/skills
GET    /api/skills/:id
POST   /api/skills/import
PUT    /api/skills/:id
DELETE /api/skills/:id
GET    /api/skills/:id/files
GET    /api/design-templates
GET    /api/design-templates/:id
GET    /api/prompt-templates
GET    /api/prompt-templates/:surface/:id
```

**Files tạo mới**:
```
ui/src/api/skills/client.ts
ui/src/api/skills/http.ts
```

---

### T06 — Tạo `ConfigApiClient`

**File**: `ui/src/api/config/`  
**Effort**: 6h  
**Assignee**: Frontend Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Endpoints** (từ `state/config.ts`):
```typescript
GET    /api/app-config
PUT    /api/app-config
GET    /api/media/config
PUT    /api/media/config
GET    /api/version
GET    /api/health
```

**Acceptance Criteria**:
- [ ] `IConfigApiClient` interface
- [ ] Tách biệt `AppConfig` (localStorage) vs `DaemonConfig` (API-owned fields)
- [ ] `fetchDaemonConfig()` → `config.getDaemonConfig()`
- [ ] `syncConfigToDaemon()` → `config.updateDaemonConfig()`

**Files tạo mới**:
```
ui/src/api/config/client.ts
ui/src/api/config/http.ts
```

---

### T07 — Tạo `AgentApiClient`

**File**: `ui/src/api/agents/`  
**Effort**: 4h  
**Assignee**: Frontend Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Endpoints**:
```typescript
GET    /api/agents
POST   /api/active
POST   /api/system/open-external
```

**Files tạo mới**:
```
ui/src/api/agents/client.ts
ui/src/api/agents/http.ts
```

---

### T08 — Tạo `ConnectorApiClient`

**File**: `ui/src/api/connectors/`  
**Effort**: 6h  
**Assignee**: Frontend Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Endpoints** (từ `providers/registry.ts` connector section):
```typescript
GET    /api/connectors
GET    /api/connectors/status
GET    /api/connectors/discovery
GET    /api/connectors/:id
POST   /api/connectors/:id/connect
POST   /api/connectors/:id/disconnect
POST   /api/connectors/:id/auth-config
GET    /api/connectors/:id/auth-status
GET    /api/connectors/composio/config
PUT    /api/connectors/composio/config
```

**Files tạo mới**:
```
ui/src/api/connectors/client.ts
ui/src/api/connectors/http.ts
```

---

### T09 — Tạo `api/index.ts` — API Registry Singleton

**File**: `ui/src/api/index.ts`  
**Effort**: 2h  
**Assignee**: Frontend Dev  
**Depends on**: T01–T08  
**Status**: `[ ]`

**Mô tả**: Tạo singleton `api` object và `ApiProvider` React context.

```typescript
// Kết quả:
export const api = {
  projects: new HttpProjectApiClient(),
  runs: new HttpRunsApiClient(),
  designSystems: new HttpDesignSystemApiClient(),
  skills: new HttpSkillApiClient(),
  config: new HttpConfigApiClient(),
  agents: new HttpAgentApiClient(),
  connectors: new HttpConnectorApiClient(),
} as const;
```

**Files tạo mới**:
```
ui/src/api/index.ts
ui/src/api/ApiProvider.tsx   ← React Context wrapper (optional, for testing)
```

---

## Tuần 2 — Refactor Providers

---

### T10 — Refactor `providers/registry.ts`

**File**: `ui/src/providers/registry.ts`  
**Effort**: 16h  
**Assignee**: Frontend Dev  
**Depends on**: T09  
**Status**: `[ ]`

**Mô tả**: Thay thế tất cả `fetch('/api/...')` calls bằng `api.*` delegates. File registry.ts vẫn tồn tại để giữ backward compatibility với callers hiện tại.

**Strategy**: Mỗi exported function trong registry.ts sẽ trở thành thin wrapper:
```typescript
// BEFORE:
export async function fetchAgents(): Promise<AgentInfo[]> {
  const resp = await fetch('/api/agents');
  // ... parse
}

// AFTER:
export async function fetchAgents(options?: { throwOnError?: boolean }): Promise<AgentInfo[]> {
  return api.agents.list(options);
}
```

**Checklist**:
- [ ] `fetchAgents()` → `api.agents.list()`
- [ ] `fetchSkills()` → `api.skills.list()`
- [ ] `fetchDesignTemplates()` → `api.skills.listDesignTemplates()`
- [ ] `fetchDesignSystems()` → `api.designSystems.list()`
- [ ] `fetchDesignSystem(id)` → `api.designSystems.get(id)`
- [ ] `fetchDesignSystemFiles()` → `api.designSystems.listFiles()`
- [ ] `createDesignSystemDraft()` → `api.designSystems.create()`
- [ ] `startDesignSystemGenerationJob()` → `api.designSystems.startGenerationJob()`
- [ ] `fetchConnectors()` → `api.connectors.list()`
- [ ] `connectConnector()` → `api.connectors.connect()`
- [ ] `daemonIsLive()` → `api.config.health()`
- [ ] `fetchAppVersionInfo()` → `api.config.getVersion()`
- [ ] `uploadProjectFiles()` → `api.projects.uploadFiles()`
- [ ] `fetchPromptTemplates()` → `api.skills.listPromptTemplates()`
- [ ] *(~60 more functions)*

**Acceptance Criteria**:
- [ ] Tất cả existing callers vẫn hoạt động mà không thay đổi import paths
- [ ] Không có `fetch('/api/...')` trực tiếp trong file này sau refactor
- [ ] TypeScript không có type errors

---

### T11 — Refactor `providers/daemon.ts`

**File**: `ui/src/providers/daemon.ts`  
**Effort**: 8h  
**Assignee**: Frontend Dev (senior)  
**Depends on**: T03, T09  
**Status**: `[ ]`

**Mô tả**: Refactor `streamViaDaemon()` và `reattachDaemonRun()` để delegate sang `api.runs.*`.

**Checklist**:
- [ ] `streamViaDaemon()` → gọi `api.runs.create()` + `api.runs.streamEvents()`
- [ ] `reattachDaemonRun()` → gọi `api.runs.streamEvents()`
- [ ] `fetchChatRunStatus()` → `api.runs.getStatus()`
- [ ] `submitChatRunToolResult()` → `api.runs.submitToolResult()`
- [ ] `reportChatRunFeedback()` → `api.runs.reportFeedback()`
- [ ] `listActiveChatRuns()` → `api.runs.listActive()`
- [ ] `listProjectRuns()` → `api.runs.list()`
- [ ] `saveArtifact()` → `api.runs.saveArtifact()`
- [ ] Helper functions (`buildDaemonTranscript`, `translateAgentEvent`) → move vào `api/runs/`

**Acceptance Criteria**:
- [ ] SSE streaming vẫn hoạt động end-to-end
- [ ] Reconnect + `Last-Event-ID` vẫn hoạt động
- [ ] Cancel via `AbortSignal` vẫn hoạt động
- [ ] Stuck-run watchdog vẫn hoạt động

---

### T12 — Refactor `state/config.ts`

**File**: `ui/src/state/config.ts`  
**Effort**: 6h  
**Assignee**: Frontend Dev  
**Depends on**: T06, T08, T09  
**Status**: `[ ]`

**Checklist**:
- [ ] `fetchDaemonConfig()` → `api.config.getDaemonConfig()`
- [ ] `syncConfigToDaemon()` → `api.config.updateDaemonConfig()`
- [ ] `fetchMediaProvidersFromDaemon()` → `api.config.getMediaProviders()`
- [ ] `syncMediaProvidersToDaemon()` → `api.config.updateMediaProviders()`
- [ ] `fetchComposioConfigFromDaemon()` → `api.connectors.getComposioConfig()`
- [ ] `syncComposioConfigToDaemon()` → `api.connectors.updateComposioConfig()`
- [ ] `loadConfig()` và `saveConfig()` (localStorage) — giữ nguyên, không migrate

---

### T13 — Refactor `state/projects.ts`

**File**: `ui/src/state/projects.ts`  
**Effort**: 6h  
**Assignee**: Frontend Dev  
**Depends on**: T02, T09  
**Status**: `[ ]`

**Checklist**:
- [ ] `listProjects()` → `api.projects.list()`
- [ ] `getProject()` → `api.projects.get()`
- [ ] `createProject()` → `api.projects.create()`
- [ ] `patchProject()` → `api.projects.patch()`
- [ ] `deleteProject()` → `api.projects.delete()`
- [ ] `importFolderProject()` → `api.projects.importFolder()`
- [ ] `importClaudeDesignZip()` → `api.projects.importClaudeDesign()`
- [ ] `listTemplates()` → `api.projects.listTemplates()`
- [ ] `deleteTemplate()` → `api.projects.deleteTemplate()`
- [ ] `createPluginShareProject()` → `api.projects.createPluginShare()`

---

## Tuần 3 — Tests & Validation

---

### T14 — Unit Tests cho API Clients

**File**: `ui/src/api/__tests__/`  
**Effort**: 16h  
**Assignee**: Frontend Dev  
**Depends on**: T01–T09  
**Status**: `[ ]`

**Coverage target**: 80%+ cho mỗi client

**Test cases bắt buộc**:
- [ ] `BaseApiClient.get()` — success response
- [ ] `BaseApiClient.get()` — error response → throws `ApiError`
- [ ] `BaseApiClient.get()` — network error → throws `ApiError`
- [ ] `HttpProjectApiClient.list()` — returns empty array on error
- [ ] `HttpProjectApiClient.create()` — sends correct body
- [ ] `HttpRunsApiClient.create()` — POST /api/runs với đúng payload
- [ ] `HttpRunsApiClient.streamEvents()` — parse SSE frames đúng
- [ ] `HttpRunsApiClient.streamEvents()` — reconnect on disconnect
- [ ] `HttpRunsApiClient.cancel()` — gọi POST /api/runs/:id/cancel
- [ ] `HttpConfigApiClient.health()` — trả về true khi 200
- [ ] `HttpConfigApiClient.health()` — trả về false khi error

**Tool**: Vitest + `@testing-library/react` (CSR — không cần jsdom tricks cho Next.js)

**Files tạo mới**:
```
ui/src/api/__tests__/client.test.ts
ui/src/api/__tests__/projects.test.ts
ui/src/api/__tests__/runs.test.ts
ui/src/api/__tests__/config.test.ts
ui/src/api/__tests__/sse.test.ts
```

**Vitest config** (`ui/vitest.config.ts`):
```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
```

---

### T15 — Integration Smoke Test + Phase 0 Sign-off

**Effort**: 8h  
**Assignee**: Frontend Dev  
**Depends on**: T10–T14  
**Status**: `[ ]`

**Mô tả**: Chạy Vite dev server (`pnpm dev`) với Go Gateway, verify mọi flow vẫn hoạt động sau refactor.

```bash
# Khởi động dev environment:
cd ui && pnpm dev                    # Vite dev server → localhost:3000
go run services/preview-gateway/cmd/main.go  # Gateway → localhost:7456
```

**Checklist smoke test**:
- [ ] App load tại `http://localhost:3000` — không có console errors
- [ ] `daemonIsLive()` / `api.config.health()` trả về true
- [ ] Projects list load
- [ ] Tạo project mới
- [ ] Mở project, load design systems
- [ ] Chạy một agent run — SSE streaming nhận events
- [ ] Cancel run hoạt động
- [ ] Settings → Config sync hoạt động
- [ ] Design system list load
- [ ] React Router: navigate qua các pages không reload toàn bộ app

**Acceptance Criteria Phase 0**:
- [ ] Không có `fetch('/api/...')` trực tiếp trong `providers/` và `state/` (chỉ qua `api/`)
- [ ] Tất cả smoke tests pass
- [ ] Unit test coverage > 80% cho `api/` layer
- [ ] TypeScript build không có errors — `pnpm --filter @open-design/ui tsc --noEmit` pass
- [ ] `pnpm --filter @open-design/ui test` pass (Vitest)
- [ ] `pnpm --filter @open-design/ui build` tạo ra `ui/dist/` thành công
- [ ] Không có import từ `next/*` trong `ui/src/`

**Phase 0 Done** → Unblocks Phase 1
