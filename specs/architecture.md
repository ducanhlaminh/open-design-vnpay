# Open Design — Architecture Document

> **Version**: 0.8.0  
> **Date**: 2026-06-02  
> **Status**: Current  

---

## 1. Tổng quan hệ thống

**Open Design** là một _local-first design workspace_ — nền tảng thiết kế AI cho phép người dùng tạo ra các sản phẩm thiết kế (UI, image, video, audio) bằng cách hội thoại với các coding agent (Claude, Codex, Gemini, ...) ngay trên máy local của họ.

### 1.1 Mục tiêu kiến trúc

| Mục tiêu | Mô tả |
|-----------|-------|
| **Local-first** | Toàn bộ project data, conversation, artifact lưu trên local disk. Không cloud dependency cho core workflow. |
| **Agent-agnostic** | Hỗ trợ nhiều coding CLI agents (Claude Code, Codex, Gemini CLI, Aider, ...) thông qua một abstraction layer thống nhất. |
| **Multi-surface** | Tạo ra được Web UI, Image, Video, Audio thông qua cùng một chat interface. |
| **Plugin-extensible** | Hệ thống plugin runtime cho phép bên thứ ba mở rộng chức năng. |
| **MCP-integrated** | Phơi ra MCP server để coding agents trong project khác có thể tương tác với Open Design. |

---

## 2. Kiến trúc Monorepo (pnpm workspace)

```
open-design-vnpay/
├── apps/
│   ├── web/           # Next.js 16 frontend (SPA + SSR optional)
│   ├── daemon/        # Express 5 backend + CLI entry point (`od`)
│   ├── desktop/       # Electron shell wrapper
│   ├── packaged/      # Build packaging utilities
│   ├── landing-page/  # Marketing landing page
│   └── telemetry-worker/ # Background telemetry worker
│
├── packages/
│   ├── contracts/         # Shared TypeScript types & API contracts
│   ├── platform/          # Shared platform utilities
│   ├── host/              # Host bridge interface
│   ├── sidecar/           # Web ↔ Daemon bridge layer
│   ├── sidecar-proto/     # Protobuf definitions cho sidecar
│   ├── plugin-runtime/    # Plugin sandbox execution runtime
│   ├── agui-adapter/      # AG-UI protocol adapter
│   ├── diagnostics/       # Diagnostics & error reporting
│   ├── download/          # File download utilities
│   └── registry-protocol/ # Plugin registry protocol types
│
├── design-systems/    # 150+ built-in design systems (JSON definitions)
├── plugins/           # Plugin catalog (official + community)
├── skills/            # AI skill definitions (YAML/JSON)
├── specs/             # 📄 Technical specifications (thư mục này)
├── e2e/               # End-to-end tests
└── tools/             # Build tools (dev, pack, serve)
```

---

## 3. Kiến trúc tổng thể (High-Level Architecture)

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Layer                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Web Browser │  │ Electron App │  │  CLI Tool (`od`)     │  │
│  │ (Next.js SPA)│  │  (Desktop)   │  │  (Daemon CLI)        │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
└─────────│─────────────────│──────────────────────│─────────────┘
          │                 │                      │
          │    HTTP/SSE     │    IPC/HTTP          │  Direct
          ▼                 ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Daemon (Express 5)                          │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                  Route Layer (server.ts)                   │ │
│  │   /api/runs    /api/projects   /api/design-systems         │ │
│  │   /api/skills  /api/agents     /api/media   /api/mcp       │ │
│  │   /artifacts   /frames         /api/active  /api/runs      │ │
│  └─────┬──────────────────────────────────────────────────────┘ │
│        │                                                        │
│  ┌─────▼──────────────────────────────────────────────────────┐ │
│  │                  Business Logic Layer                       │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │ │
│  │  │ projects │ │chat-route│ │  media   │ │design-systems│  │ │
│  │  │  .ts     │ │   .ts    │ │   .ts    │ │    .ts       │  │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │ │
│  │  │  memory  │ │  skills  │ │  orbit   │ │   mcp.ts     │  │ │
│  │  │   .ts    │ │   .ts    │ │   .ts    │ │              │  │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │ │
│  └─────┬──────────────────────────────────────────────────────┘ │
│        │                                                        │
│  ┌─────▼──────────────────────────────────────────────────────┐ │
│  │                    Storage Layer                            │ │
│  │  ┌──────────────────────┐  ┌───────────────────────────┐  │ │
│  │  │  SQLite (better-sqlite3) │  │   Local Filesystem       │  │ │
│  │  │  • projects DB         │  │   • Project folders       │  │ │
│  │  │  • conversations DB    │  │   • Artifact files        │  │ │
│  │  │  • app-config.json     │  │   • Design system files   │  │ │
│  │  └──────────────────────┘  └───────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   External AI Agents / APIs                     │
│   Claude Code CLI │ Codex CLI │ Gemini CLI │ Aider │ OpenAI API │
│   Anthropic API   │ Azure OpenAI │ Ollama  │ DeepSeek │ Google  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Daemon Layer (`apps/daemon`)

### 4.1 Vai trò và trách nhiệm

Daemon là trái tim của hệ thống — một **Express 5 HTTP server** chạy local, binding mặc định ở cổng `7456`. Nó:

- Là **CLI entry point** (`od` binary, `apps/daemon/src/cli.ts`, ~250KB)
- Là **API backend** cho Web và Desktop frontends
- **Quản lý project filesystem** — lưu conversations, artifacts, files
- **Điều phối AI agent** — spawn CLI processes, stream output về cho client
- **Serve static web assets** khi deploy production
- Phơi ra **MCP server** cho coding agents bên ngoài

### 4.2 Cấu trúc nguồn daemon chính

| File | Kích thước | Chức năng |
|------|-----------|-----------|
| `server.ts` | ~500KB | Toàn bộ Express route registration và middleware |
| `cli.ts` | ~250KB | CLI argument parsing, daemon startup logic |
| `db.ts` | ~53KB | SQLite database schema và queries |
| `projects.ts` | ~52KB | Project CRUD, conversation management |
| `chat-routes.ts` | ~55KB | Chat/run streaming, SSE event loop |
| `design-systems.ts` | ~110KB | Design system import, generation, preview |
| `media.ts` | ~105KB | Image/Video/Audio generation |
| `mcp.ts` | ~49KB | MCP server implementation |
| `memory.ts` | ~31KB | Memory connector (context persistence) |
| `deploy.ts` | ~75KB | Cloudflare Pages deployment |
| `lint-artifact.ts` | ~46KB | Artifact linting pipeline |
| `skills.ts` | ~42KB | Skill catalog management |

### 4.3 Chat Run Lifecycle

```
UI Submit Prompt
    │
    ▼
POST /api/runs
    │
    ├─► Daemon creates run record (SQLite)
    ├─► Returns runId immediately
    │
    ▼
GET /api/runs/:id/events  (SSE stream)
    │
    ├─► Daemon spawns AI agent CLI process
    │   (claude-code / codex / gemini / ...)
    │
    ├─► Reads stdout/stderr via pipe
    │
    ├─► Translates agent output → SSE events:
    │   event: start   → run starting
    │   event: agent   → typed events (text_delta, tool_use, tool_result, ...)
    │   event: stdout  → raw text chunks
    │   event: error   → run failed
    │   event: end     → run finished (code/signal/status)
    │
    └─► Client reconnects on disconnect (up to 5 retries, lastEventId resume)
```

### 4.4 Database Schema (SQLite)

```sql
-- Core entities
projects (id, name, kind, metadata, created_at, updated_at)
conversations (id, project_id, title, created_at)
messages (id, conversation_id, role, content, agent_id, events_json, created_at)
runs (id, project_id, conversation_id, agent_id, status, exit_code, signal, ...)

-- Design systems
design_systems (id, name, version, source, ...)
design_system_files (id, design_system_id, path, content_hash, ...)
design_system_jobs (id, design_system_id, status, ...)

-- Live artifacts (refreshable data-driven outputs)
live_artifacts (id, project_id, title, slug, status, source_data, preview, ...)
live_artifact_refresh_log (id, artifact_id, refresh_id, phase, ...)

-- Memory (agent context persistence)
memory_connectors (id, project_id, kind, config, ...)
memory_entries (id, connector_id, content, embedding, ...)

-- Config & auth
app_config (key, value)
mcp_tokens (id, token_hash, scope, created_at)
```

---

## 5. Web Frontend (`apps/web`)

### 5.1 Tech Stack

| Công nghệ | Phiên bản | Vai trò |
|-----------|-----------|---------|
| **Next.js** | 16.2.6 | Web framework (SPA + static export) |
| **React** | 18.3.1 | UI library |
| **TypeScript** | 5.9.3 | Type system |
| **TailwindCSS** | 4.3.0 | Utility CSS |
| **Turbopack** | built-in | Dev bundler |
| **Vitest** | 4.1.6 | Unit testing |

**Deployment modes** (qua `OD_WEB_OUTPUT_MODE`):
- `export` (default prod): Next.js static export → Daemon serves `out/`
- `server`: Next.js SSR với sidecar proxy
- `standalone`: Traced standalone server

### 5.2 Routing

Custom router nhẹ (không dùng react-router), sử dụng `window.history.pushState` và `popstate` events:

```typescript
type Route =
  | { kind: 'home'; view: EntryHomeView }      // /, /onboarding, /projects, /tasks, /plugins, ...
  | { kind: 'project'; projectId: string; conversationId?: string; fileName: string | null }
  | { kind: 'design-system-create' }
  | { kind: 'design-system-detail'; designSystemId: string }
  | { kind: 'marketplace' }
  | { kind: 'marketplace-detail'; pluginId: string };
```

URL patterns:
```
/                               → Home
/onboarding                     → Onboarding
/projects                       → Projects list
/projects/:id                   → Project view
/projects/:id/conversations/:cid→ Project + conversation
/design-systems                 → Design systems list
/design-systems/create          → Create design system
/design-systems/:id             → Design system detail
/marketplace                    → Plugin marketplace
/marketplace/:pluginId          → Plugin detail
/automations                    → Tasks/Automations
/integrations                   → MCP integrations
```

### 5.3 Component Architecture

```
App.tsx (root state machine)
├── WorkspaceTabsBar (tab management)
│
├── EntryView (home shell)
│   ├── EntryShell (nav rail + content)
│   │   ├── HomeView
│   │   │   ├── HomeHero (prompt card + chip rail)
│   │   │   ├── RecentProjectsStrip
│   │   │   ├── PluginsHomeSection
│   │   │   └── SkillsSection
│   │   ├── DesignsTab (project listing)
│   │   ├── DesignSystemsTab (DS listing)
│   │   ├── PluginsView (plugin marketplace)
│   │   ├── TasksView (automations)
│   │   └── IntegrationsView (MCP tools)
│
├── ProjectView (active project)
│   ├── ChatPane (conversation)
│   │   ├── ChatComposer (input + attachments)
│   │   └── AssistantMessage (streaming response)
│   ├── DesignFilesPanel (file tree)
│   ├── FileViewer (file preview/edit)
│   └── FileWorkspace (multi-tab workspace)
│
├── DesignSystemFlow (DS creation wizard)
├── SettingsDialog (app settings)
├── MarketplaceView / PluginDetailView
└── PetOverlay (animated companion)
```

### 5.4 State Management

State được quản lý qua **React useState** tại `App.tsx` (single root store pattern):

| State | Loại | Nguồn |
|-------|------|-------|
| `config` | `AppConfig` | localStorage + daemon sync |
| `projects` | `Project[]` | `/api/projects` |
| `agents` | `AgentInfo[]` | `/api/agents` |
| `skills` | `SkillSummary[]` | `/api/skills` |
| `designSystems` | `DesignSystemSummary[]` | `/api/design-systems` |
| `daemonLive` | `boolean` | `/api/health` |
| `route` | `Route` | Custom router hook |

**Config persistence strategy:**
- Client-only fields → `localStorage` (key: `open-design:config`)
- Privacy-sensitive fields (`installationId`, `telemetry`, `privacyDecisionAt`) → Daemon `app-config.json` (source of truth)
- Media provider API keys → Daemon (never stored in localStorage)

### 5.5 API Communication Pattern

```
Web → Daemon:

  POST /api/runs              → Start AI agent run
  GET  /api/runs/:id/events   → SSE stream (chunked, resumable)
  POST /api/runs/:id/cancel   → Cancel run
  POST /api/runs/:id/tool-result → Answer tool call

  GET  /api/projects          → List projects
  POST /api/projects          → Create project
  GET  /api/projects/:id      → Get project
  GET  /api/projects/:id/files → List files

  GET  /api/design-systems    → List design systems
  GET  /api/skills            → List skills
  GET  /api/agents            → List + probe CLI agents

  GET  /api/media/config      → Media provider config
  PUT  /api/media/config      → Save media provider config

  GET  /api/app-config        → Daemon-persisted config
  PUT  /api/app-config        → Sync config to daemon

  POST /api/active            → Set active project context (MCP)
```

Dev mode: Next.js rewrites `/api/*`, `/artifacts/*`, `/frames/*` → `http://127.0.0.1:7456/...`

---

## 6. Desktop Layer (`apps/desktop`)

Electron shell tối giản — wrap the web frontend:
- Main process (`src/main/`) — lifecycle management, IPC
- Renderer: embedded Next.js web app
- Auth: `desktop-auth.ts` trong daemon handles desktop-specific OAuth flows

---

## 7. Packages Layer

### 7.1 `@open-design/contracts`

Shared TypeScript interface definitions giữa web và daemon:

```typescript
// Các types core:
Project, Conversation, ChatMessage, ChatRequest, ChatSseEvent
DesignSystemSummary, DesignSystemDetail, DesignSystemRevision
LiveArtifact, LiveArtifactSummary, LiveArtifactPreview
AgentInfo, SkillSummary, SkillDetail
ProjectFile, ProjectKind, ProjectMetadata
AppConfigPrefs  // Config fields daemon owns
```

### 7.2 `@open-design/platform`

Cross-platform utilities, shared giữa web và daemon.

### 7.3 `@open-design/host`

Bridge interface cho Host integrations (embed Open Design vào product khác):

```typescript
interface OpenDesignHost {
  // project import, file operations, etc.
}
```

### 7.4 `@open-design/sidecar`

Web sidecar kết nối Next.js server và daemon runtime trong packaged desktop builds. Handles proxy và lifecycle coordination.

### 7.5 `@open-design/plugin-runtime`

Sandboxed plugin execution environment:
- Mỗi plugin chạy trong isolated context
- Plugin API được expose qua typed interface
- Hỗ trợ các plugin type: `scenario` (prompt variants), `tool` (external integrations)

### 7.6 `@open-design/agui-adapter`

Adapter cho AG-UI protocol — chuẩn giao tiếp giữa AI agents và UI frameworks.

---

## 8. Plugin System

### 8.1 Plugin Spec

```yaml
# plugins/spec/SPEC.md định nghĩa:
id: unique-plugin-id
name: Display Name
description: What this plugin does
kind: scenario | tool
version: 1.0.0
author: author-name
inputs:
  - id: api_key
    label: API Key
    type: secret
tools:
  - name: tool_name
    description: Tool description
```

### 8.2 Plugin Categories

| Category | Mô tả |
|----------|-------|
| **Official** (`plugins/_official/`) | Plugins chính thức từ team |
| **Community** (`plugins/community/`) | Community-contributed plugins |
| **Registry** (`plugins/registry/`) | Registry metadata |

**Composio integration**: Daemon's `connectors/composio.ts` (~71KB) cho phép kết nối 100+ external services (GitHub, Notion, Slack, ...) như tools thông qua Composio API.

---

## 9. Design Systems

### 9.1 Khái niệm

Design System là một bộ styling tokens + component guidelines mà AI agent sẽ follow khi generate UI:

```
design-systems/
  ├── default/          # Default fallback DS
  │   ├── index.yaml    # DS metadata
  │   ├── tokens.css    # CSS variables
  │   └── guidelines.md # Agent instructions
  ├── stripe/           # Stripe-inspired DS
  ├── material/         # Google Material DS
  └── ...               # 150+ more
```

### 9.2 DS Lifecycle

```
User selects DS
    │
    ▼
Daemon injects DS context into agent system prompt
    │
    ▼
Agent generates UI following DS tokens/guidelines
    │
    ▼
Artifact rendered with DS CSS variables applied
```

---

## 10. AI Agent Integration

### 10.1 Supported Agents

| Agent | Protocol | Mode |
|-------|---------|------|
| Claude Code | Anthropic streaming JSON | Daemon CLI |
| OpenAI Codex | OpenAI streaming | Daemon CLI |
| Gemini CLI | Google streaming | Daemon CLI |
| Aider | OpenAI-compatible | Daemon CLI |
| Custom | BYOK (multiple protocols) | API mode |

### 10.2 Execution Modes

**Daemon mode** (default): Agent CLI runs as subprocess, daemon streams output.

**API mode** (BYOK): Web frontend streams directly to provider API, bypassing CLI agents.

### 10.3 Multi-Provider Support (BYOK)

```typescript
type ApiProtocol = 
  | 'anthropic'   // /v1/messages
  | 'openai'      // /v1/chat/completions
  | 'azure'       // Azure OpenAI endpoint
  | 'google'      // Gemini API
  | 'ollama'      // Local Ollama
  | 'senseaudio'; // SenseAudio (multimodal)
```

---

## 11. MCP (Model Context Protocol) Integration

Daemon phơi ra một MCP server cho phép coding agents trong projects khác tương tác với Open Design:

```
MCP Tools exposed:
├── get_active_context    → Get current project/file context
├── create_project        → Create a new design project
├── run_design_skill      → Execute a design skill
├── get_live_artifact     → Get live artifact data
└── ... (15+ tools)
```

Config được lưu tại `mcp-config.ts` (~56KB) và yêu cầu authentication qua MCP tokens.

---

## 12. Observability & Analytics

### 12.1 Telemetry Stack

| Component | Provider | Data |
|-----------|---------|------|
| Product analytics | PostHog | UI events, funnels, retention |
| LLM tracing | Langfuse | Run traces, costs, latency |
| Metrics | Prometheus (`prom-client`) | System metrics |
| Error tracking | PostHog `$exception` | Frontend errors |

### 12.2 Privacy Model

- `telemetry.metrics`: Master switch for PostHog events
- `telemetry.content`: Allow content in traces  
- `telemetry.artifactManifest`: Share artifact metadata
- `installationId`: Anonymous UUID, rotatable, daemon-owned
- All privacy fields stored in daemon `app-config.json`, NOT localStorage

---

## 13. Build & Deployment

### 13.1 Build Pipeline

```bash
# Web
pnpm --filter @open-design/web build      # Next.js static export
pnpm --filter @open-design/web build:sidecar  # Desktop sidecar

# Daemon  
pnpm --filter @open-design/daemon build   # TypeScript → dist/

# Desktop
pnpm --filter @open-design/desktop build  # Electron package
```

### 13.2 Runtime Environments

| Env | Web Output Mode | Daemon | Notes |
|-----|----------------|--------|-------|
| Dev | Dev server + rewrite | Separate process port 7456 | Hot reload via Turbopack |
| Web (Vercel) | Static export | - | SPA only, no daemon features |
| CLI daemon | Static export | Same process | `od` command |
| Desktop | server/standalone | Bundled | Electron wraps both |

### 13.3 Configuration via Environment Variables

| Variable | Default | Mô tả |
|----------|---------|-------|
| `OD_PORT` | `7456` | Daemon HTTP port |
| `OD_WEB_OUTPUT_MODE` | - | `server`/`standalone` for packaged |
| `OD_WORKSPACE_ROOT` | computed | pnpm workspace root |
| `OD_ALLOWED_ORIGINS` | - | CORS allowed origins |
| `OD_HOST` | `127.0.0.1` | Daemon bind host |

---

## 14. Security Architecture

### 14.1 Origin Validation

Daemon validates request origins via `origin-validation.ts`:
- Whitelist local IPs (127.0.0.1, LAN IPs)
- `OD_ALLOWED_ORIGINS` for custom hosts
- MCP endpoints require bearer token auth

### 14.2 Secret Management

- LLM API keys: Never persist to disk unencrypted; daemon holds in memory + `app-config.json`
- Media provider keys: Daemon-owned storage
- Composio keys: Daemon-owned, only `apiKeyTail` (last 4 chars) exposed to browser
- Agent CLI secrets (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) stripped before localStorage save

---

## 15. Dependency Graph

```
apps/web
    └── @open-design/contracts
    └── @open-design/host
    └── @open-design/platform
    └── @open-design/sidecar
    └── @open-design/sidecar-proto

apps/daemon
    └── @open-design/contracts
    └── @open-design/platform
    └── @open-design/plugin-runtime
    └── @open-design/agui-adapter
    └── @open-design/diagnostics
    └── @open-design/registry-protocol
    └── @open-design/sidecar
    └── @open-design/sidecar-proto

apps/desktop
    └── @open-design/sidecar  (for launcher)
```

---

*Tài liệu này được tổng hợp từ phân tích codebase trực tiếp. Cập nhật khi có breaking changes.*
