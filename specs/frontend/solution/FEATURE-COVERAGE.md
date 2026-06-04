# Feature Coverage Analysis & Gap Report
# Open Design VNPay — Frontend Solution vs PRD/SRS/URD

> **Cập nhật**: 2026-06-03  
> **Mục đích**: Đảm bảo toàn bộ tính năng từ PRD/SRS/URD được phản ánh đầy đủ trong solution và tasks

---

## Tóm tắt

| Khu vực | Tính năng | Có trong solution | Gap |
|---------|----------|-------------------|-----|
| F-01 Agent Detection | 16 CLI agents | ✅ DEV-T-agent-service | — |
| F-02 BYOK Proxy | 6 providers | ⚠️ Thiếu chi tiết | Cần bổ sung BYOK routes |
| F-03 Skills System | 132+ skills | ✅ DEV-T-design-system-and-skill | Thiếu `skill import`, `skill example` |
| F-04 Design Systems | 150+ systems | ✅ DEV-T-design-system-and-skill | Thiếu GitHub import, CRUD |
| F-05 Projects | CRUD + files | ✅ DEV-T-project-service | Thiếu templates, archive |
| F-06 Conversations/Chat | SSE streaming | ✅ PHASE-0 + PHASE-1 | Thiếu event types: todo, question_form |
| F-07 Discovery Form | Turn-1 form | ❌ Không có task | **MISSING** |
| F-08 Artifact Rendering | sandboxed iframe | ❌ Không có task | **MISSING** |
| F-09 Export | HTML/PDF/PPTX/ZIP | ❌ Không có task | **MISSING** |
| F-10 Deploy | Vercel/Cloudflare | ⚠️ Đề cập sơ | Cần API task cụ thể |
| F-11 Import | Claude Design ZIP | ❌ Không có task | **MISSING** |
| F-12 Templates | Lưu template | ❌ Không có task | **MISSING** |
| F-13 Media Generation | Image/Video/Audio | ⚠️ Đề cập sơ | Thiếu tasks chi tiết |
| F-14 Routines | Cron automation | ❌ Không có task | **MISSING** |
| F-15 Orbit | Daily digest | ❌ Không có task | **MISSING** |
| F-16 MCP | MCP server/client | ⚠️ Đề cập sơ | Thiếu tasks chi tiết |
| F-17 Memory | Memory extraction | ❌ Không có task | **MISSING** |
| F-18 Plugins | Plugin system | ❌ Không có task | **MISSING** |
| F-19 Live Artifacts | Refreshable outputs | ⚠️ Entity có | Thiếu refresh logic |
| F-20 Desktop/Electron | Electron app | ✅ PHASE-3 | Thiếu sidecar IPC chi tiết |
| F-21 Settings/Config | AppConfig schema | ⚠️ Config service | Thiếu full schema |
| F-22 Connectors | Composio | ❌ Không có task | **MISSING** |

**Critical gaps: 8 tính năng hoàn toàn thiếu trong tasks**

---

## Chi tiết Gap Phân tích

### GAP-01: Discovery Form & Direction Picker (FR-07, US-02-01, US-02-02)

**Mô tả**: Turn-1 discovery form và visual direction picker là tính năng CORE — không có trong bất kỳ task nào.

**Ảnh hưởng**: Frontend không biết cần render form fields, handle direction picker events.

**Tasks cần thêm**:
- API client cho `question_form` event type
- React component `<QuestionForm>` với các field types
- React component `<DirectionPicker>` với 5 directions + OKLch palettes
- SSE event handler cho `question_form` và `direction_picker` events

---

### GAP-02: Artifact Rendering & File Workspace (FR-08, US-02-04, US-03-03)

**Mô tả**: Sandboxed iframe rendering và file workspace editor không có trong tasks.

**Ảnh hưởng**: Core functionality — không có artifact viewer = không có sản phẩm.

**Tasks cần thêm**:
- `<ArtifactViewer>` component với `srcdoc` iframe
- Artifact parser (extract HTML từ `<artifact>` XML tags)
- File workspace API client: GET/PUT/DELETE files
- Code editor component (syntax highlighting HTML/CSS/JS)
- Auto-save debounce (2 giây)

---

### GAP-03: Export & Deploy (FR-09, FR-10, US-04-01 → US-04-04)

**Mô tả**: Export HTML/PDF/PPTX/ZIP và Deploy Vercel/Cloudflare thiếu hoàn toàn trong frontend tasks.

**Tasks cần thêm**:
- `ExportApiClient`: GET `/api/projects/:id/files/:name/export/html|pdf`
- `DeployApiClient`: POST `/api/projects/:id/deployments/vercel|cloudflare`
- `<ExportMenu>` dropdown component
- `<DeployDialog>` với form nhập token
- Deployment status polling

---

### GAP-04: Import (FR-11, US-06-01)

**Mô tả**: Import từ Claude Design ZIP không có.

**Tasks cần thêm**:
- `ImportApiClient`: POST `/api/import/claude-design` (multipart/form-data)
- Drag & drop file upload component
- Import progress indicator

---

### GAP-05: Templates (FR-12, US-06-02)

**Tasks cần thêm**:
- `TemplatesApiClient`: CRUD `/api/templates`
- Templates library UI component

---

### GAP-06: Media Generation (FR-13, US-05-01 → US-05-03)

**Mô tả**: Image, Video, Audio generation API clients và UI thiếu.

**Tasks cần thêm**:
- `MediaApiClient`: POST `/api/media/image|video|audio`
- Task polling với status: `pending → processing → ready`
- `<MediaGenerationPanel>` với template picker
- ElevenLabs voice list: GET `/api/elevenlabs/voices`

---

### GAP-07: Routines & Orbit (FR-14, FR-15, US-08-01, US-08-02)

**Mô tả**: Scheduled automation và daily digest hoàn toàn thiếu.

**Tasks cần thêm**:
- `RoutinesApiClient`: CRUD + trigger manual run
- `<RoutineEditor>` form với schedule picker
- `<OrbitStatus>` component
- Cron schedule UI (daily/weekly/once)

---

### GAP-08: MCP, Memory, Plugins, Connectors (FR-16 → FR-22)

**Mô tả**: Các tính năng nâng cao này có trong SRS nhưng không có trong frontend tasks.

**Tasks cần thêm** (từng item):
- `MCPApiClient`: GET/PUT `/api/mcp/config`, OAuth flow endpoints
- `MemoryApiClient`: GET/POST/DELETE `/api/memory`
- `PluginsApiClient`: CRUD + install/uninstall/apply
- `ConnectorsApiClient`: CRUD + OAuth connect

---

## SSE Event Types Thiếu (FR-06.4)

Hiện tại tasks chỉ đề cập SSE basics. Các event types sau cần được handle:

| Event | Status trong tasks |
|-------|-------------------|
| `delta` | ✅ Có |
| `tool_use` | ✅ Có |
| `todo` | ❌ Thiếu |
| `artifact` | ❌ Thiếu |
| `file_op` | ❌ Thiếu |
| `question_form` | ❌ Thiếu |
| `direction_picker` | ❌ Thiếu |
| `end` | ✅ Có |
| `error` | ✅ Có |

---

## AppConfig Schema Thiếu (FR-21)

Config Service tasks hiện chỉ có `AppConfig` đơn giản. Cần bổ sung:
- `apiProtocol`: anthropic | openai | azure | google | ollama | senseaudio
- `mediaProviders`: image/video/audio provider credentials
- `composio`: Composio connector settings
- `agentModels`: per-agent model selection
- `agentCliEnv`: env var injection per agent
- `orbit`: OrbitConfig
- `pet`: PetConfig (community pets)
- `notifications`: NotificationsConfig
- `disabledSkills`, `disabledDesignSystems`
- `telemetry`: TelemetryConfig (metrics/content/artifactManifest)
- `customInstructions`
- `theme`, `accentColor`
