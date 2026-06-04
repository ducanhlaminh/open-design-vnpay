# Software Requirements Specification (SRS)
# Open Design — VNPay Edition

**Phiên bản:** 1.0  
**Ngày:** 2026-06-03  
**Trạng thái:** Bản nháp chính thức  
**Tác giả:** VNPay Platform Team  
**Nguồn gốc:** Dựa trên mã nguồn `open-design-vnpay` v0.8.0, PRD v1.0, URD v1.0  

---

## Mục lục

1. [Giới thiệu](#1-giới-thiệu)
2. [Mô tả tổng quan hệ thống](#2-mô-tả-tổng-quan-hệ-thống)
3. [Yêu cầu chức năng](#3-yêu-cầu-chức-năng)
4. [Yêu cầu phi chức năng](#4-yêu-cầu-phi-chức-năng)
5. [Kiến trúc hệ thống và thiết kế kỹ thuật](#5-kiến-trúc-hệ-thống-và-thiết-kế-kỹ-thuật)
6. [Mô hình dữ liệu](#6-mô-hình-dữ-liệu)
7. [Giao diện hệ thống (API)](#7-giao-diện-hệ-thống-api)
8. [Giao diện người dùng](#8-giao-diện-người-dùng)
9. [Ràng buộc và giả định](#9-ràng-buộc-và-giả-định)
10. [Kịch bản kiểm thử](#10-kịch-bản-kiểm-thử)
11. [Thuật ngữ](#11-thuật-ngữ)
12. [Phụ lục](#12-phụ-lục)

---

## 1. Giới thiệu

### 1.1 Mục đích tài liệu

Tài liệu Đặc tả Yêu cầu Phần mềm (SRS) này mô tả đầy đủ và chính xác toàn bộ yêu cầu kỹ thuật và chức năng cho hệ thống **Open Design VNPay Edition** — phiên bản tùy chỉnh của open-source project `nexu-io/open-design`, được thích nghi cho hệ sinh thái VNPay.

SRS này phục vụ làm:
- Cơ sở thiết kế và phát triển cho engineering team
- Tài liệu kiểm thử và nghiệm thu (QA)
- Hợp đồng kỹ thuật giữa các bên liên quan

### 1.2 Phạm vi hệ thống

**Open Design VNPay Edition** là nền tảng thiết kế AI-driven, local-first, web-deployable bao gồm:

| Thành phần | Phạm vi |
|------------|---------|
| **Web Application** | Next.js 16, App Router, chạy tại `localhost:7457` (mặc định) |
| **Local Daemon** | Node.js 24, Express.js, SQLite, chạy tại `localhost:7456` (mặc định) |
| **Desktop App** | Electron shell (tùy chọn), macOS + Windows |
| **Skills System** | 132+ skills (SKILL.md convention) |
| **Design Systems Library** | 150+ systems (9-section DESIGN.md schema) |
| **Agent Adapters** | 16 coding-agent CLIs + BYOK proxy |
| **Media Generation** | Image, Video, Audio |
| **MCP Integration** | Model Context Protocol server/client |

**Ngoài phạm vi:** Mobile app native (iOS/Android), vector design tools, real-time collaborative editing.

### 1.3 Tài liệu tham chiếu

| Tài liệu | Mô tả |
|---------|-------|
| [PRD.md](./PRD.md) | Product Requirements Document v1.0 |
| [URD.md](./URD.md) | User Requirements Document v1.0 |
| [CONTEXT.md](../CONTEXT.md) | Domain Language Glossary |
| [README.md](../README.md) | Project overview và quickstart |
| [QUICKSTART.md](../QUICKSTART.md) | Hướng dẫn cài đặt chi tiết |
| `apps/daemon/src/server.ts` | Express server (501KB, ~12,854 LOC) — nguồn chân lý API |
| `apps/daemon/src/db.ts` | SQLite schema và data access layer |
| `apps/web/src/types.ts` | TypeScript type definitions |
| `packages/contracts/src/` | API contract types |

### 1.4 Tổng quan tài liệu

SRS được tổ chức theo chuẩn IEEE 830:
- **Phần 2:** Mô tả product context, personas, constraints
- **Phần 3:** Yêu cầu chức năng — mỗi feature được đánh số FR-XX
- **Phần 4:** Yêu cầu phi chức năng — NFR-XX
- **Phần 5:** Kiến trúc kỹ thuật — stack, luồng dữ liệu
- **Phần 6:** Database schema
- **Phần 7:** API specification
- **Phần 8:** UI specification

---

## 2. Mô tả tổng quan hệ thống

### 2.1 Bối cảnh hệ thống

Open Design VNPay Edition được xây dựng dựa trên open-source `nexu-io/open-design` (Apache-2.0), được fork và tùy chỉnh bởi VNPay Platform Team. Hệ thống sử dụng mô hình:

```
User → Web UI (Next.js) → Local Daemon (Express+SQLite) → AI Agent CLI
                                                         ↘ BYOK API Proxy
                                                         ↘ Media API (ElevenLabs, ByteDance, etc.)
```

**Triết lý thiết kế (từ README):**
> "We don't ship an agent. Yours is good enough."

Daemon không tích hợp AI model riêng — nó phát hiện các coding agent CLI đã cài sẵn trên máy user (Claude Code, Gemini CLI, Codex, v.v.), spawn chúng như subprocess trong project directory, và stream output về UI qua SSE.

### 2.2 Người dùng và Stakeholders

| Persona | Vai trò | Nhu cầu chính |
|---------|---------|---------------|
| **Product Designer** | Tạo/review artifacts | Prototype nhanh, preview đẹp, export dễ |
| **Frontend Engineer** | Xem spec, lấy code | HTML/CSS artifact clean, design token rõ ràng |
| **Product Manager** | Review, approve, track | URL shareable, PDF/PPTX export |
| **AI/ML Engineer** | Config agent, custom skill | API rõ ràng, skill dạng Markdown |
| **Platform Admin** | Deploy, quản lý | Docker, env config, token auth |
| **Business Analyst** | Report, phân tích | finance-report, kanban, meeting-notes skills |

### 2.3 Giả định và phụ thuộc

| # | Giả định / Phụ thuộc |
|---|---------------------|
| A-01 | Node.js `~24` và pnpm `≥10.33.2 <11` được cài sẵn |
| A-02 | Ít nhất một AI agent CLI (Claude Code, Gemini CLI, v.v.) hoặc BYOK API key hợp lệ |
| A-03 | SQLite WAL mode hoạt động bình thường trên filesystem của deployment |
| A-04 | Browser hỗ trợ `srcdoc` iframe sandbox (Chrome 88+, Firefox 89+, Safari 14+) |
| A-05 | Media generation yêu cầu API key của provider tương ứng (ElevenLabs, Azure OpenAI, ByteDance) |
| A-06 | Deploy Vercel/Cloudflare yêu cầu account và token |

---

## 3. Yêu cầu chức năng

### FR-01: Khởi động và Phát hiện Agent

**Nguồn:** `apps/daemon/src/agents.ts`, `apps/daemon/src/server.ts`

**Mô tả:** Khi daemon khởi động, hệ thống tự động scan `PATH` để phát hiện các coding agent CLI được hỗ trợ.

**Danh sách agent được phát hiện (16 agents):**

| Agent ID | CLI Binary | Protocol |
|----------|-----------|---------|
| `claude` | `claude` | `claude-stream-json` |
| `codex` | `codex` | `json-event-stream` |
| `devin` | `devin` | `acp-json-rpc` |
| `cursor-agent` | `cursor-agent` | `json-event-stream` |
| `gemini` | `gemini` | `json-event-stream` |
| `opencode` | `opencode` | `json-event-stream` |
| `qwen` | `qwen` | `plain` |
| `qodercli` | `qodercli` | `qoder-stream-json` |
| `copilot` | `copilot` | `copilot-stream-json` |
| `hermes` | `hermes` | `acp-json-rpc` |
| `kimi` | `kimi` | `acp-json-rpc` |
| `pi` | `pi` | `pi-rpc` |
| `kiro-cli` | `kiro-cli` | `acp-json-rpc` |
| `kilo` | `kilo` | `acp-json-rpc` |
| `vibe-acp` | `vibe-acp` | `acp-json-rpc` (Mistral Vibe) |
| `deepseek` | `deepseek` | `plain` |

**Điều kiện:**
- Daemon phải tìm được ≥1 agent CLI hoặc có BYOK API config hợp lệ để cho phép tạo artifact
- Kết quả phát hiện được cache và refresh khi user reload
- Mỗi agent có status: `available` | `not_found`

**API:** `GET /api/agents` → `AgentInfo[]`

---

### FR-02: BYOK API Proxy

**Nguồn:** `apps/daemon/src/server.ts`, `apps/daemon/src/connectionTest.ts`

**Mô tả:** Khi không có agent CLI, daemon đóng vai trò proxy chuyển SSE stream từ provider API về client.

**Endpoints:**
```
POST /api/proxy/anthropic/stream
POST /api/proxy/openai/stream
POST /api/proxy/azure/stream
POST /api/proxy/google/stream
POST /api/proxy/ollama/stream
POST /api/proxy/senseaudio/stream
```

**Bảo mật SSRF:**
- **Loopback** (`127.0.0.1`, `::1`) — **ALLOWED** (dành cho Ollama local, LM Studio)
- **Private / link-local / CGNAT / multicast / reserved** — **REJECTED**
- Upstream redirect bị disable tại daemon edge
- Non-loopback private IP bị reject ngay khi validate `baseUrl`

**Chuẩn hóa response:** Tất cả provider đều trả về SSE events theo format thống nhất:
```
event: delta\ndata: {"text": "..."}
event: end\ndata: {}
event: error\ndata: {"message": "..."}
```

**SenseAudio đặc biệt:** Proxy expose thêm `generate_image` và `generate_video` tools để model có thể tạo artifact trực tiếp.

---

### FR-03: Skills System

**Nguồn:** `apps/daemon/src/skills.ts`, `skills/` directory (132+ skills)

**Mô tả:** Skills là các workflow thiết kế được định nghĩa dưới dạng file SKILL.md + assets/ + references/. Daemon đọc và parse frontmatter mở rộng `od:` để populate catalog.

#### FR-03.1: Cấu trúc Skill

Mỗi skill là một folder với:
```
skills/<skill-id>/
├── SKILL.md          ← Frontmatter od: + instructions
├── assets/
│   ├── template.html ← Template artifact
│   └── ...
└── references/
    └── *.md          ← Reference docs auto-injected
```

**Frontmatter `od:` schema:**
```yaml
od:
  mode: prototype | deck | image | video | audio | template | design-system | utility
  platform: desktop | mobile
  scenario: design | marketing | operation | engineering | product | finance | hr | sale | personal
  preview:
    type: html | deck | image | video | audio
  design_system:
    requires: boolean
  default_for: prototype | deck | ...
  featured: boolean
  fidelity: low | medium | high
  speaker_notes: boolean
  animations: boolean
  example_prompt: string
```

#### FR-03.2: API Skills

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/skills` | GET | Danh sách tất cả skills với summary |
| `/api/skills/:id` | GET | Chi tiết một skill (full SKILL.md) |
| `/api/skills/:id/example` | GET | HTML preview artifact mẫu |

#### FR-03.3: Catalog Modes

- **`prototype`** (32 skills): Single-page HTML artifacts — landings, mobile apps, dashboards, specs
- **`deck`** (9 skills): Horizontal-swipe presentations với deck navigation
- **`image`**: Media generation image workflow
- **`video`**: Media generation video workflow
- **`audio`**: Media generation audio workflow
- **`template`**: Template files (non-interactive)
- **`design-system`**: Design system builder workflow
- **`utility`**: Post-export audit, catalog updaters

#### FR-03.4: Skills nổi bật (prototype mode)

| Skill ID | Platform | Scenario | Output |
|----------|---------|---------|--------|
| `web-prototype` | desktop | design | Single-page HTML |
| `saas-landing` | desktop | marketing | Hero/features/pricing |
| `dashboard` | desktop | operation | Admin + data layout |
| `mobile-app` | mobile | design | iPhone 15 Pro / Pixel frames |
| `mobile-onboarding` | mobile | design | Multi-screen onboarding |
| `gamified-app` | mobile | personal | Gamified prototype |
| `email-marketing` | desktop | marketing | HTML email |
| `social-carousel` | desktop | marketing | 3-card 1080×1080 |
| `magazine-poster` | desktop | marketing | Editorial poster |
| `pm-spec` | desktop | product | PM spec doc |
| `eng-runbook` | desktop | engineering | Incident runbook |
| `finance-report` | desktop | finance | Exec finance summary |
| `invoice` | desktop | finance | Single-page invoice |
| `hr-onboarding` | desktop | hr | Onboarding plan |

#### FR-03.5: Deck Skills

| Skill ID | Mô tả |
|---------|-------|
| `guizang-ppt` | Magazine-style PPT (default deck) |
| `simple-deck` | Minimal horizontal-swipe |
| `replit-deck` | Product-walkthrough deck |
| `weekly-update` | Team weekly cadence deck |

#### FR-03.6: Thêm skill mới

1. Tạo folder `skills/<new-skill-id>/SKILL.md`
2. Restart daemon (`pnpm tools-dev stop && pnpm tools-dev run web`)
3. Skill tự động xuất hiện trong catalog picker

---

### FR-04: Design Systems Library

**Nguồn:** `apps/daemon/src/design-systems.ts`, `design-systems/` directory (151 entries)

**Mô tả:** Library 150+ design systems được định nghĩa theo schema 9-section DESIGN.md portable Markdown.

#### FR-04.1: Schema DESIGN.md (9 sections)

```markdown
## 1. Color System
## 2. Typography
## 3. Spacing & Layout
## 4. Component Library
## 5. Motion & Animation
## 6. Voice & Tone
## 7. Brand Assets
## 8. Anti-patterns
## 9. Iconography
```

#### FR-04.2: Design Systems có sẵn (150+ systems)

Bao gồm: Linear, Stripe, Vercel, Airbnb, Tesla, Notion, Apple, Anthropic, Cursor, Supabase, Figma, Revolut, Coinbase, Spotify, Shopify, Discord, Slack, GitHub, OpenAI, Mistral AI, ElevenLabs, Perplexity, Sentry, MongoDB, PostHog, Raycast, Webflow, Sanity, Framer, và nhiều hơn.

#### FR-04.3: API Design Systems

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/design-systems` | GET | Danh sách tất cả design systems |
| `/api/design-systems/:id` | GET | Chi tiết (DESIGN.md + files) |
| `/api/design-systems/:id/preview` | GET | Preview HTML showcase |
| `/api/design-systems/:id/showcase` | GET | Showcase artifact |
| `/api/design-systems` | POST | Tạo custom design system |
| `/api/design-systems/:id` | PUT | Update design system |
| `/api/design-systems/:id` | DELETE | Xóa design system |

#### FR-04.4: Import GitHub Design System

- `POST /api/design-systems/import/github`
- Parse repo URL, clone DESIGN.md, extract metadata

---

### FR-05: Project Management

**Nguồn:** `apps/daemon/src/projects.ts`, `apps/daemon/src/db.ts`

**Mô tả:** Projects là top-level workspaces chứa conversations và design files. Mỗi project có một thư mục riêng trên disk.

#### FR-05.1: Project Lifecycle

```
Create → Active → [Chat turns] → Files on disk → Export/Deploy → Archive
```

#### FR-05.2: Project Data

```typescript
interface Project {
  id: string;          // UUID
  name: string;
  skillId?: string;    // Skill được chọn
  designSystemId?: string;
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
  customInstructions?: string;
  appliedPluginSnapshotId?: string;
  createdAt: number;
  updatedAt: number;
}

interface ProjectMetadata {
  kind?: ProjectKind;   // 'design' | 'deck' | 'image' | 'video' | 'audio'
  platform?: string;
  fidelity?: string;
  speakerNotes?: boolean;
  animations?: boolean;
  inspirationIds?: string[];
  videoModel?: string;  // 'hyperframes-html' cho HyperFrames
}
```

#### FR-05.3: Project Filesystem

```
.od/
├── app.sqlite          ← Metadata DB (WAL mode)
├── artifacts/          ← One-off "Save to disk" renders
├── media-config.json   ← API keys (gitignored)
└── projects/<id>/      ← Working dir (agent's cwd)
    ├── index.html      ← Main artifact file
    ├── brand-spec.md
    ├── style.css
    └── ...
```

#### FR-05.4: API Projects

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/projects` | GET | Danh sách projects (sorted by updatedAt) |
| `/api/projects` | POST | Tạo project mới |
| `/api/projects/:id` | GET | Chi tiết project |
| `/api/projects/:id` | PATCH | Cập nhật metadata |
| `/api/projects/:id` | DELETE | Xóa project + files |
| `/api/projects/:id/files` | GET | Danh sách files |
| `/api/projects/:id/files/:name` | GET | Đọc file |
| `/api/projects/:id/files/:name` | PUT | Ghi file |
| `/api/projects/:id/files/:name` | DELETE | Xóa file |
| `/api/projects/:id/archive` | GET | Download ZIP archive |

---

### FR-06: Conversation và Chat

**Nguồn:** `apps/daemon/src/chat-routes.ts` (55KB), `apps/daemon/src/db.ts`

**Mô tả:** Mỗi project có nhiều conversations. Mỗi conversation là một thread chat giữa user và agent, với lịch sử messages được persist trong SQLite.

#### FR-06.1: Conversation Model

```typescript
interface Conversation {
  id: string;
  projectId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  latestRun?: ConversationRunSummary;
}

interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  agentId?: string;
  agentName?: string;
  eventsJson?: string;     // Persisted agent events
  attachments?: ChatAttachment[];
  producedFiles?: string[];
  runId?: string;
  runStatus?: RunStatus;   // 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  startedAt?: number;
  endedAt?: number;
  position: number;
  createdAt: number;
}
```

#### FR-06.2: Chat Flow (SSE Streaming)

```
POST /api/projects/:id/conversations/:convId/messages
→ SSE stream: event: delta | tool_use | todo | artifact | end | error
```

**Prompt Stack Assembly (theo thứ tự):**
1. `DISCOVERY directives` — Turn-1 form, Turn-2 brand branch, TodoWrite, 5-dim critique
2. `identity charter` — OFFICIAL_DESIGNER_PROMPT, anti-AI-slop, junior-pass
3. `active DESIGN.md` — 150+ systems
4. `active SKILL.md` — 132+ skills
5. `project metadata` — kind, fidelity, speakerNotes, animations, inspirationIds
6. `skill side files` — assets/template.html + references/*.md (auto-inject pre-flight)
7. `(deck kind)` DECK_FRAMEWORK_DIRECTIVE — nav/counter/scroll/print

#### FR-06.3: Agent Spawn

```javascript
spawn(agentBinary, args, {
  cwd: `.od/projects/${projectId}/`,
  env: { ...process.env, ...agentSpecificEnv },
  stdio: ['pipe', 'pipe', 'pipe']
})
```

**Windows ENAMETOOLONG fallbacks:**
- Khi command line > 8191 chars: stdin injection hoặc prompt-file

#### FR-06.4: Stream Events

| Event | Payload | Mô tả |
|-------|---------|-------|
| `delta` | `{text: string}` | Text token từ agent |
| `tool_use` | `{name, input, output}` | Tool call của agent |
| `todo` | `{items: TodoItem[]}` | Live TodoWrite progress |
| `artifact` | `{html, title, identifier}` | Artifact emitted |
| `file_op` | `{path, operation}` | File write/delete |
| `question_form` | `{fields: FormField[]}` | Turn-1 discovery form |
| `direction_picker` | `{directions: Direction[]}` | Visual direction picker |
| `end` | `{runId, status}` | Turn kết thúc |
| `error` | `{message, code}` | Lỗi |

---

### FR-07: Interactive Discovery Form (Turn-1)

**Nguồn:** `apps/daemon/src/prompts/discovery.ts` (30KB), `apps/web/src/components/QuestionForm.tsx`

**Mô tả:** Trước khi agent viết một pixel, hệ thống emit discovery form để lock brief.

#### FR-07.1: Discovery Form Fields

```xml
<question-form id="discovery">
  <field id="surface" type="radio" options="desktop|mobile|tablet"/>
  <field id="audience" type="text" placeholder="Who is this for?"/>
  <field id="tone" type="radio" options="formal|casual|playful|professional"/>
  <field id="brand_context" type="text" placeholder="Brand colors, fonts, existing assets"/>
  <field id="scale" type="radio" options="1-page|multi-page|full-app"/>
  <field id="constraints" type="text" placeholder="Any technical constraints?"/>
</question-form>
```

#### FR-07.2: Visual Direction Picker (Turn-2)

Khi user không có brand cụ thể, agent emit Direction Picker với 5 trường phái:

| Direction | OKLch Palette | Font Stack |
|-----------|-------------|-----------|
| **Editorial Monocle** | Charcoal + cream + gold | Playfair Display + Inter |
| **Modern Minimal** | White + near-black + electric | Inter + Roboto Mono |
| **Warm Soft** | Blush + ivory + terracotta | Lora + DM Sans |
| **Tech Utility** | Deep navy + cyan + slate | JetBrains Mono + Inter |
| **Brutalist Experimental** | Black + neon lime + raw white | Space Grotesk |

Mỗi direction sau khi chọn → agent dùng palette xác định, không freestyle màu.

#### FR-07.3: Junior-Designer Mode

Từ `huashu-design`:
1. **Batch câu hỏi lên trước** — không tự suy đoán thiếu thông tin
2. **Show something visible sớm** — dù là wireframe với grey blocks
3. **Cho user redirect rẻ** — chi phí một redirect là một chat round

#### FR-07.4: 5-Dimensional Self-Critique

Sau khi tạo artifact, agent thực hiện self-critique theo 5 chiều:
1. **Philosophy** — Thiết kế có đúng triết lý không?
2. **Hierarchy** — Visual hierarchy rõ ràng?
3. **Detail** — Màu sắc, spacing, typography nhất quán?
4. **Function** — Artifact thực sự dùng được không?
5. **Innovation** — Có gì mới hoặc đáng nhớ không?

---

### FR-08: Artifact Rendering và Preview

**Nguồn:** `apps/web/src/artifacts/parser.ts`, `apps/web/src/components/FileViewer.tsx`

**Mô tả:** Agent emit artifact trong XML tag `<artifact>`, hệ thống parse và render trong sandboxed iframe.

#### FR-08.1: Artifact Format

```xml
<artifact identifier="unique-id" type="text/html" title="My Landing Page">
<!DOCTYPE html>
<html>
  ...full HTML document...
</html>
</artifact>
```

#### FR-08.2: Sandboxed Iframe Rendering

```html
<iframe
  srcdoc="...artifact HTML..."
  sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
  loading="lazy"
/>
```

**Đặc điểm:**
- Độc lập với trang chính (no script leak)
- User có thể interact: click, scroll, hover, animation hoạt động
- Resize preview panel
- Artifact render trong vòng 2 giây sau khi agent hoàn thành

#### FR-08.3: File Workspace

`FileViewer.tsx` (311KB) cung cấp:
- Danh sách files trong project (sidebar)
- Syntax highlighting cho HTML, CSS, JS, Markdown
- Auto-save sau 2 giây không có thay đổi
- Preview sync với file đang edit
- Diff view khi có version mới

#### FR-08.4: Preview Comments & Annotations

**Nguồn:** `apps/daemon/src/db.ts` (table: `preview_comments`)

```typescript
interface PreviewComment {
  id: string;
  projectId: string;
  conversationId: string;
  filePath: string;
  elementId: string;
  selector: string;     // CSS selector
  label: string;
  text: string;
  positionJson: object; // {x, y, width, height}
  htmlHint: string;
  styleJson?: object;
  note: string;
  status: 'open' | 'resolved';
  selectionKind: 'element' | 'visual' | 'pod';
  memberCount?: number;
  podMembersJson?: object[];
  createdAt: number;
  updatedAt: number;
}
```

- Click mode vs interact mode phân biệt rõ ràng
- Comment inject vào conversation context cho turn tiếp theo
- Unique constraint: `(project_id, conversation_id, file_path, element_id)`

---

### FR-09: Export

**Nguồn:** `apps/daemon/src/import-export-routes.ts`, `apps/daemon/src/inline-assets.ts`

**Mô tả:** Hệ thống hỗ trợ 5 định dạng export.

| Format | Endpoint | Mô tả |
|--------|---------|-------|
| **HTML** | `GET /api/projects/:id/files/:name/export/html` | Inline assets, offline-capable |
| **PDF** | `GET /api/projects/:id/files/:name/export/pdf` | Browser print, deck-aware |
| **PPTX** | Agent-driven via skill | File .pptx trong project folder |
| **ZIP** | `GET /api/projects/:id/archive` | Toàn bộ project |
| **Markdown** | `GET /api/projects/:id/transcript` | Conversation transcript |

**HTML Export:**
- CSS, JS, images được inline (base64 hoặc `<style>`)
- File < 5MB cho artifact thông thường
- Hoạt động offline trên Chrome/Firefox/Safari

**PDF Export:**
- Deck mode: mỗi slide = một trang PDF
- Text selectable trong PDF
- Page breaks hợp lý

---

### FR-10: Deploy

**Nguồn:** `apps/daemon/src/deploy.ts` (74KB), `apps/daemon/src/deploy-routes.ts`

**Mô tả:** Deploy artifact lên hosting provider và trả về public URL.

#### FR-10.1: Vercel Deploy

```
POST /api/projects/:id/deployments/vercel
Body: { fileName, token, teamId?, projectName? }
→ { url, status: 'pending' | 'ready' | 'failed' }
```

**Flow:**
1. Build file set (inline assets)
2. POST to Vercel API
3. Poll deployment status
4. Return stable URL

#### FR-10.2: Cloudflare Pages Deploy

```
POST /api/projects/:id/deployments/cloudflare
Body: { fileName, accountId, token, projectName }
→ { url, deploymentId, status }
```

**Đặc điểm:**
- `POST /api/cloudflare/zones` — List CF zones
- `aggregateCloudflarePagesStatus()` — Normalize CF status
- Deploy < 60 giây với artifact < 1MB

#### FR-10.3: Deployment Tracking

```typescript
interface Deployment {
  id: string;
  projectId: string;
  fileName: string;
  providerId: 'vercel' | 'cloudflare';
  url: string;
  deploymentId?: string;
  deploymentCount: number;
  target: 'preview';
  status: 'ready' | 'pending' | 'failed';
  statusMessage?: string;
  reachableAt?: number;
  createdAt: number;
  updatedAt: number;
}
```

---

### FR-11: Import

**Nguồn:** `apps/daemon/src/claude-design-import.ts`, `apps/daemon/src/import-export-routes.ts`

**Mô tả:** Import project từ nguồn ngoài.

#### FR-11.1: Import Claude Design ZIP

```
POST /api/import/claude-design
Content-Type: multipart/form-data
Body: { zip: File }
→ { projectId, name }
```

- Parse ZIP format của Claude Design (Anthropic)
- Tạo real project với history
- Files accessible trong File Workspace
- Error message rõ ràng nếu ZIP invalid

#### FR-11.2: GitHub Design System Import

```
POST /api/design-systems/import/github
Body: { repoUrl: string }
```

---

### FR-12: Templates

**Nguồn:** `apps/daemon/src/db.ts` (table: `templates`)

**Mô tả:** User có thể lưu project làm template để tái sử dụng.

```typescript
interface ProjectTemplate {
  id: string;
  name: string;
  description?: string;
  sourceProjectId?: string;
  files: ProjectFile[];
  createdAt: number;
}
```

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/templates` | GET | Danh sách templates |
| `/api/templates` | POST | Tạo template từ project |
| `/api/templates/:id` | GET | Chi tiết template |
| `/api/templates/:id` | PUT | Update template |
| `/api/templates/:id` | DELETE | Xóa template |

---

### FR-13: Media Generation

**Nguồn:** `apps/daemon/src/media.ts` (105KB), `apps/daemon/src/media-routes.ts`

**Mô tả:** Hỗ trợ tạo media (image, video, audio) từ prompt hoặc source text.

#### FR-13.1: Image Generation

**Provider:** GPT-Image-2 (Azure/OpenAI), Custom Image API/ImageRouter

```
POST /api/media/image
Body: {
  prompt: string,
  model: string,   // 'gpt-image-2', ...
  aspect: '1:1' | '16:9' | '4:3' | ...
}
→ { taskId, status: 'pending' | 'ready' | 'failed', imageUrl? }
```

- 43 prompt templates sẵn có (dưới `prompt-templates/`)
- Image lưu vào project folder
- Aspect ratio tùy chỉnh

#### FR-13.2: Video Generation

**Providers:**
- **Seedance 2.0** (ByteDance): text-to-video và image-to-video (15s cinematic)
- **HyperFrames** (HeyGen): HTML→MP4 motion graphics

```
POST /api/media/video
Body: {
  prompt: string,
  model: string,   // 'seedance-2.0', 'hyperframes-html'
  duration: number,
  aspect: string
}
→ { taskId, status: 'pending' | 'processing' | 'ready' | 'failed' }
```

- 39 Seedance + 11 HyperFrames prompt templates
- Async polling với status updates
- Video `.mp4` lưu vào project folder

#### FR-13.3: Audio Generation

**Provider:** ElevenLabs

```
POST /api/media/audio
Body: {
  text: string,    // Cho speech
  prompt?: string, // Cho sound effects
  kind: 'speech' | 'sound_effects',
  voiceId?: string
}
→ { taskId, status, audioUrl? }
```

- Voice list load từ ElevenLabs API (`GET /api/elevenlabs/voices`)
- ElevenLabs Fallback Voice: default voice ID khi API lỗi
- Audio preview inline
- Download `.mp3`

#### FR-13.4: Media Task Tracking

```typescript
interface MediaTask {
  id: string;
  projectId: string;
  kind: 'image' | 'video' | 'audio';
  status: 'pending' | 'processing' | 'ready' | 'failed';
  prompt: string;
  model: string;
  providerId: string;
  resultUrl?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}
```

---

### FR-14: Routines (Scheduled Automation)

**Nguồn:** `apps/daemon/src/routines.ts`, `apps/daemon/src/routine-routes.ts`

**Mô tả:** Routines là cron-based hoặc time-based automation chạy định kỳ để tạo project mới với prompt và skill cho trước.

```typescript
interface Routine {
  id: string;
  name: string;
  prompt: string;
  scheduleKind: 'daily' | 'weekly' | 'once';
  scheduleValue: string;    // '09:00' | 'monday' | '2026-06-05'
  scheduleJson?: RoutineSchedule;
  projectMode: 'new' | 'existing';
  projectId?: string;
  skillId?: string;
  agentId?: string;
  contextJson?: object;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface RoutineRun {
  id: string;
  routineId: string;
  trigger: 'scheduled' | 'manual';
  status: 'running' | 'succeeded' | 'failed';
  projectId: string;
  conversationId: string;
  agentRunId: string;
  startedAt: number;
  completedAt?: number;
  summary?: string;
  error?: string;
  errorCode?: string;
}
```

**API Routines:**

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/routines` | GET | Danh sách routines |
| `/api/routines` | POST | Tạo routine mới |
| `/api/routines/:id` | GET | Chi tiết routine |
| `/api/routines/:id` | PUT | Update routine |
| `/api/routines/:id` | DELETE | Xóa routine |
| `/api/routines/:id/run` | POST | Trigger manual run |
| `/api/routines/:id/runs` | GET | Run history |

---

### FR-15: Orbit — Daily Activity Digest

**Nguồn:** `apps/daemon/src/orbit.ts` (28KB)

**Mô tả:** Orbit là routine đặc biệt chạy hàng ngày vào giờ cố định, tổng hợp connector activity và tạo digest project.

```typescript
interface OrbitConfig {
  enabled: boolean;
  time: string;         // 'HH:mm' format
  templateSkillId?: string | null;
}
```

- Timezone awareness
- Summary từ memory connectors
- Không chạy nếu không có connector data
- `GET /api/orbit/status` — Trạng thái hiện tại
- `POST /api/orbit/run` — Manual trigger

---

### FR-16: MCP Integration

**Nguồn:** `apps/daemon/src/mcp.ts` (49KB), `apps/daemon/src/mcp-config.ts` (56KB)

**Mô tả:** Model Context Protocol cho phép tích hợp external tools và data sources.

#### FR-16.1: MCP Server (Daemon → Agent)

Daemon expose MCP server cho agents để:
- Read/write live artifacts
- Access project files
- Execute design tools

#### FR-16.2: MCP Client (Daemon → External)

Daemon kết nối như MCP client đến external servers:

| Endpoint | Mô tả |
|---------|-------|
| `GET /api/mcp/config` | Đọc MCP config |
| `PUT /api/mcp/config` | Cập nhật MCP config |
| `GET /api/mcp/templates` | MCP config templates |
| `POST /api/mcp/oauth/begin` | Bắt đầu OAuth flow |
| `POST /api/mcp/oauth/callback` | OAuth callback |
| `GET /api/mcp/tokens` | Đọc stored tokens |

#### FR-16.3: OAuth 2.0

- Authorization Code flow với PKCE
- Token storage + refresh
- `POST /api/mcp/oauth/refresh` — Refresh expired tokens

---

### FR-17: Memory System

**Nguồn:** `apps/daemon/src/memory.ts` (30KB), `apps/daemon/src/memory-connectors.ts` (45KB)

**Mô tả:** Hệ thống memory cho phép agent nhớ thông tin qua các conversations.

- Memory entries được extract tự động từ conversations
- Có thể suggest, confirm, và delete memory entries
- Connector memory: extract từ external connectors (GitHub, Slack, v.v.)
- `GET /api/memory` — List entries
- `POST /api/memory/extract` — Extract từ message
- `DELETE /api/memory/:id` — Xóa entry

---

### FR-18: Plugin System

**Nguồn:** `apps/daemon/src/plugins/` directory

**Mô tả:** Plugin system cho phép mở rộng functionality của daemon.

#### FR-18.1: Plugin Lifecycle

```
Install → Snapshot → Apply → Run Pipeline → Uninstall
```

#### FR-18.2: API Plugins

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/plugins` | GET | Danh sách plugins đã cài |
| `/api/plugins/:id` | GET | Chi tiết plugin |
| `/api/plugins/install` | POST | Cài plugin |
| `/api/plugins/:id/uninstall` | POST | Gỡ plugin |
| `/api/plugins/:id/apply` | POST | Apply plugin vào project |
| `/api/plugins/snapshots/:id` | GET | Đọc plugin snapshot |

---

### FR-19: Live Artifacts

**Nguồn:** `apps/daemon/src/live-artifacts/`, `apps/daemon/src/live-artifact-routes.ts`

**Mô tả:** Live Artifacts là refreshable design outputs với source data và preview state — khác với Normal Artifacts (static HTML).

```typescript
interface LiveArtifact {
  id: string;
  projectId: string;
  title: string;
  slug: string;
  status: 'active' | 'archived';
  refreshStatus: 'idle' | 'refreshing' | 'failed';
  pinned: boolean;
  preview: LiveArtifactPreview;
  hasDocument: boolean;
  updatedAt: string;
  lastRefreshedAt?: string;
}
```

- `GET /api/projects/:id/live-artifacts` — List
- `POST /api/projects/:id/live-artifacts` — Create
- `POST /api/projects/:id/live-artifacts/:aid/refresh` — Trigger refresh
- `GET /api/projects/:id/live-artifacts/:aid/refresh-log` — Refresh history

---

### FR-20: Desktop Application (Electron)

**Nguồn:** `apps/desktop/`, `apps/daemon/src/sidecar/`

**Mô tả:** Optional Electron shell wrapper xung quanh Web UI.

#### FR-20.1: Sidecar IPC

Desktop app giao tiếp với daemon qua Unix socket:
```
/tmp/open-design/ipc/<namespace>/<app>.sock
```

**IPC Commands:**
| Command | Payload | Mô tả |
|---------|---------|-------|
| `STATUS` | — | Daemon status |
| `EVAL` | `{script}` | Execute JS trong renderer |
| `SCREENSHOT` | — | Capture screenshot |
| `CONSOLE` | — | Get console messages |
| `CLICK` | `{x, y}` | Simulate click |
| `SHUTDOWN` | — | Graceful shutdown |

#### FR-20.2: Desktop Auth Gate

Khi `OD_DESKTOP_AUTH=1`, desktop app yêu cầu auth trước khi cho phép API calls:
- Auth secret rotate sau mỗi boot
- Import nonce mechanism ngăn replay attacks

#### FR-20.3: Data Migration

**Option A: Auto-migration (OD_LEGACY_DATA_DIR)**
```bash
OD_LEGACY_DATA_DIR="/path/to/.od" \
  "/Applications/Open Design.app/Contents/MacOS/Open Design"
```

- Staging → promote atomically
- `.migrated-from` marker ngăn re-migration
- Lỗi nếu: source không có `app.sqlite`, hoặc desktop đã có data

**Option B: Manual copy** (rsync + atomic swap)

---

### FR-21: Settings và Configuration

**Nguồn:** `apps/web/src/components/SettingsDialog.tsx` (245KB), `apps/daemon/src/app-config.ts`

**Mô tả:** Settings dialog quản lý toàn bộ cấu hình ứng dụng.

#### FR-21.1: App Config Schema

```typescript
interface AppConfig {
  mode: 'daemon' | 'api';
  apiKey: string;
  baseUrl: string;
  model: string;
  apiProtocol?: 'anthropic' | 'openai' | 'azure' | 'google' | 'ollama' | 'senseaudio';
  apiProtocolConfigs?: Record<ApiProtocol, ApiProtocolConfig>;
  agentId: string | null;
  skillId: string | null;
  designSystemId: string | null;
  theme?: 'system' | 'light' | 'dark';
  accentColor?: string;
  onboardingCompleted?: boolean;
  mediaProviders?: Record<string, MediaProviderCredentials>;
  composio?: ComposioSettings;
  agentModels?: Record<string, AgentModelChoice>;
  agentCliEnv?: AgentCliEnvConfig;
  maxTokens?: number;
  pet?: PetConfig;
  notifications?: NotificationsConfig;
  orbit?: OrbitConfig;
  disabledSkills?: string[];
  disabledDesignSystems?: string[];
  installationId?: string | null;
  privacyDecisionAt?: number | null;
  telemetry?: TelemetryConfig;
  customInstructions?: string;
}
```

#### FR-21.2: Privacy và Telemetry

```typescript
interface TelemetryConfig {
  metrics?: boolean;         // Aggregate usage (default: ON)
  content?: boolean;         // Prompts và artifacts (default: ON)
  artifactManifest?: boolean; // (default: OFF)
}
```

- Toggle từng loại ON/OFF trong Settings → Privacy
- "Delete my data": xóa `installationId`, reset consent
- Không xóa projects
- Privacy policy link rõ ràng

---

### FR-22: Connectors

**Nguồn:** `apps/daemon/src/connectors/`

**Mô tả:** Connectors cho phép kết nối đến external services (GitHub, Slack, Notion, v.v.) thông qua Composio.

- Credential store per-connector
- `GET /api/connectors` — List configured connectors
- `POST /api/connectors/:id/connect` — Connect với OAuth
- `DELETE /api/connectors/:id` — Disconnect
- Memory extraction từ connector data

---

## 4. Yêu cầu phi chức năng

### NFR-01: Performance

| Metric | Target | Cơ sở |
|--------|--------|-------|
| **Artifact render** | < 2s sau khi agent hoàn thành | srcdoc iframe, no network |
| **Agent spawn** | < 1s sau khi submit prompt | `child_process.spawn` |
| **SSE streaming** | Latency cảm nhận < 100ms | Chunked transfer |
| **SQLite WAL** | Concurrent reads không block writes | `journal_mode = WAL` |
| **Home page load** | < 2s | Next.js SSR + static assets |
| **Skills picker** | < 1s | Cached từ daemon |
| **File workspace list** | < 500ms | SQLite query |
| **Image generation** | < 30s | Async, progress indicator |
| **Deploy (< 1MB)** | < 60s | Vercel/CF API |

### NFR-02: Reliability

| Yêu cầu | Cơ chế |
|--------|--------|
| **Daemon auto-restart** | Process manager / systemd / PM2 |
| **SQLite consistency** | WAL mode + `foreign_keys = ON` |
| **Stale run reconciliation** | `reconcileStaleRuns()` khi boot |
| **Plugin snapshot GC** | `startSnapshotGc()` |
| **Media task recovery** | `reconcileMediaTasksOnBoot()` |
| **Conversation persistence** | messages không mất sau browser refresh |
| **Project files** | không mất sau daemon restart |
| **Failed agent run** | retry mà không mất conversation |

### NFR-03: Security

| Yêu cầu | Implementation |
|--------|---------------|
| **SSRF blocking** | `origin-validation.ts` — loopback OK, private/link-local/CGNAT rejected |
| **API token auth** | `OD_API_TOKEN` header validation |
| **Desktop auth gate** | `desktop-auth.ts` — secret + nonce mechanism |
| **Origin validation** | `isAllowedBrowserOrigin()` cho browser requests |
| **API key masking** | Chỉ show 4 ký tự cuối trong UI |
| **API keys không log** | Redaction trong `redact.ts` |
| **No external upload** | Files không upload nếu không có explicit deploy |
| **Artifact sandbox** | `sandbox` attributes trên iframe |
| **SSRF redirect** | Upstream redirect bị disable |

### NFR-04: Usability

| Yêu cầu | Target |
|--------|--------|
| **Time to first artifact** | < 3 phút cho user mới |
| **Learning curve** | < 10 phút với user chưa biết |
| **Discovery form** | Không quá 8 câu hỏi |
| **Error messages** | Actionable suggestions |
| **Keyboard navigation** | Main workflows |
| **Loading states** | Mọi async operation |

### NFR-05: Accessibility

| Yêu cầu | Standard |
|--------|---------|
| **WCAG compliance** | 2.1 AA cho core UI |
| **Dark mode** | System/Light/Dark toggle |
| **Font size** | Tối thiểu 14px |
| **Color contrast** | 4.5:1 ratio |
| **i18n** | `/apps/web/src/i18n/` (Vietnamese + multiple languages) |

### NFR-06: Scalability

| Yêu cầu | Cơ chế |
|--------|--------|
| **SQLite** | Đủ cho local-first single-user |
| **File storage** | Filesystem trực tiếp |
| **OD_DATA_DIR** | Relocate all daemon data |
| **OD_MEDIA_CONFIG_DIR** | Separate credentials dir |
| **Namespace isolation** | `--namespace` flag cho E2E test isolation |

### NFR-07: Portability và Deployment

| Target | Support |
|--------|---------|
| **Local (dev)** | `pnpm tools-dev run web` |
| **Docker** | `docker compose up -d` tại port 7456 |
| **Vercel (web layer)** | `vercel.json` configurat |
| **Desktop macOS** | Apple Silicon (arm64) + Intel (x64) |
| **Desktop Windows** | x64 |
| **Desktop Linux** | AppImage (beta) |

---

## 5. Kiến trúc hệ thống và thiết kế kỹ thuật

### 5.1 Kiến trúc tổng quan

```
┌────────────────────── Browser (Next.js 16) ──────────────────────┐
│  HomeView · ProjectView · SettingsDialog                         │
│  ChatPane · FileViewer · PreviewModal · DesignSystemFlow         │
└──────────────┬───────────────────────────────────┬───────────────┘
               │ HTTP / SSE (/api/*)               │ SSE events
               ▼                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│              Local Daemon (Express.js + SQLite)                  │
│                                                                  │
│  Routes:                                                         │
│  /api/agents          /api/skills          /api/design-systems  │
│  /api/projects/:id/*  /api/chat (SSE)      /api/proxy/*/stream  │
│  /api/templates       /api/import          /api/export          │
│  /api/artifacts/*     /api/upload          /api/media/*         │
│  /api/routines        /api/orbit           /api/mcp/*           │
│  /api/memory          /api/connectors      /api/plugins/*       │
│  /api/deployments     /api/live-artifacts  /api/xai/*           │
│                                                                  │
│  Sidecar IPC: /tmp/open-design/ipc/<ns>/<app>.sock              │
└──────────────┬──────────────────────────────────────────────────┘
               │ spawn(cli, args, { cwd: .od/projects/<id>/ })
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  AI Agent CLIs (16 agents)                                       │
│  claude · codex · devin · gemini · opencode · cursor-agent      │
│  qwen · qodercli · copilot · hermes · kimi · pi                 │
│  kiro-cli · kilo · vibe-acp · deepseek                          │
│                                                                  │
│  Agent reads: SKILL.md, DESIGN.md, assets/template.html         │
│  Agent writes: artifacts to .od/projects/<id>/                  │
└─────────────────────────────────────────────────────────────────┘
                              │ BYOK fallback
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  External APIs (BYOK Proxy)                                      │
│  Anthropic · OpenAI · Azure OpenAI · Google Gemini              │
│  Ollama (loopback) · SenseAudio                                  │
│  ElevenLabs · ByteDance (Seedance) · HeyGen (HyperFrames)       │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Frontend** | Next.js App Router + React + TypeScript | Next.js 16, React 18, TS 5.9 |
| **Styling** | CSS Modules + vanilla CSS | — |
| **State** | React hooks + custom state management | `apps/web/src/state/` |
| **Backend** | Node.js + Express.js | Node ~24 |
| **Database** | SQLite (WAL mode) | `better-sqlite3` |
| **Agent Spawn** | `child_process.spawn` | Node built-in |
| **SSE** | Express SSE với chunked transfer | — |
| **Desktop** | Electron | — |
| **Sidecar IPC** | Unix domain socket | — |
| **Build** | pnpm workspaces + esbuild | pnpm 10.33.x |
| **Testing** | Vitest | — |
| **E2E** | `tools-dev inspect` + sidecar | — |
| **Package Manager** | pnpm | 10.33.2 |

### 5.3 Monorepo Structure

```
open-design-vnpay/
├── apps/
│   ├── web/          ← Next.js frontend
│   ├── daemon/       ← Express.js backend
│   ├── desktop/      ← Electron shell
│   ├── landing-page/ ← open-design.ai marketing site
│   ├── packaged/     ← Electron packaging
│   └── telemetry-worker/
├── packages/
│   ├── contracts/    ← Shared TypeScript types
│   ├── platform/     ← Agent command invocation
│   ├── host/         ← Browser runtime host
│   ├── sidecar/      ← Sidecar protocol
│   ├── sidecar-proto/← Sidecar type defs
│   ├── download/     ← Download utilities
│   ├── diagnostics/  ← Diagnostics export
│   ├── plugin-runtime/← Plugin execution
│   ├── registry-protocol/← Plugin registry
│   └── agui-adapter/ ← Agent GUI adapter
├── skills/           ← 132+ skill folders
├── design-systems/   ← 150+ design system folders
├── docs/             ← Documentation (this file)
├── tools/            ← Internal CLI tools
├── e2e/              ← E2E test suite
├── specs/            ← Spec files
├── guides/           ← User guides
└── deploy/           ← Docker compose + configs
```

### 5.4 Agent Communication Protocols

| Protocol | Agents | Description |
|---------|--------|-------------|
| `claude-stream-json` | Claude Code | Custom Claude streaming JSON parser |
| `json-event-stream` | Codex, Gemini, OpenCode, Cursor Agent | Generic JSON SSE parser |
| `acp-json-rpc` | Devin, Hermes, Kimi, Kiro, Kilo, Mistral Vibe | Agent Client Protocol JSON-RPC |
| `copilot-stream-json` | GitHub Copilot CLI | Custom Copilot parser |
| `qoder-stream-json` | Qoder CLI | Custom Qoder parser |
| `pi-rpc` | Pi | Stdio JSON-RPC |
| `plain` | Qwen Code, DeepSeek TUI | Plain text output |

### 5.5 Lifecycle Management

```
pnpm tools-dev start   ← Khởi động daemon + web + desktop
pnpm tools-dev stop    ← Dừng tất cả processes
pnpm tools-dev run web ← Chỉ chạy web + daemon
pnpm tools-dev status  ← Trạng thái hiện tại
pnpm tools-dev logs    ← Xem logs
pnpm tools-dev inspect ← Inspect desktop/browser
pnpm tools-dev check   ← Health check
```

**Ports (mặc định):**
- Daemon: 7456 (`--daemon-port`)
- Web: 7457 (`--web-port`)
- Namespace: `default` (`--namespace`)

---

## 6. Mô hình dữ liệu

### 6.1 SQLite Schema (`app.sqlite`)

```sql
-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  skill_id TEXT,
  design_system_id TEXT,
  pending_prompt TEXT,
  metadata_json TEXT,
  custom_instructions TEXT,
  applied_plugin_snapshot_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Templates
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source_project_id TEXT,
  files_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_conv_project ON conversations(project_id, updated_at DESC);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  agent_id TEXT,
  agent_name TEXT,
  events_json TEXT,
  attachments_json TEXT,
  produced_files_json TEXT,
  feedback_json TEXT,
  pre_turn_file_names_json TEXT,
  comment_attachments_json TEXT,
  run_id TEXT,
  run_status TEXT,
  last_run_event_id TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_conv ON messages(conversation_id, position);

-- Preview Comments / Annotations
CREATE TABLE IF NOT EXISTS preview_comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  element_id TEXT NOT NULL,
  selector TEXT NOT NULL,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  position_json TEXT NOT NULL,
  html_hint TEXT NOT NULL,
  style_json TEXT,
  note TEXT NOT NULL,
  status TEXT NOT NULL,  -- 'open' | 'resolved'
  selection_kind TEXT,   -- 'element' | 'visual' | 'pod'
  member_count INTEGER,
  pod_members_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, conversation_id, file_path, element_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Tabs (Open file tabs per project)
CREATE TABLE IF NOT EXISTS tabs (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id, name),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Deployments
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  url TEXT NOT NULL,
  deployment_id TEXT,
  deployment_count INTEGER NOT NULL DEFAULT 1,
  target TEXT NOT NULL DEFAULT 'preview',
  status TEXT NOT NULL DEFAULT 'ready',
  status_message TEXT,
  reachable_at INTEGER,
  provider_metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, file_name, provider_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Routines
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_kind TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  schedule_json TEXT,
  project_mode TEXT NOT NULL,
  project_id TEXT,
  skill_id TEXT,
  agent_id TEXT,
  context_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Routine Runs
CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  summary TEXT,
  error TEXT,
  error_code TEXT,
  FOREIGN KEY(routine_id) REFERENCES routines(id) ON DELETE CASCADE
);
```

**Note:** Ngoài ra còn có các bảng được tạo bởi `migrateCritique()`, `migrateMediaTasks()`, và `migratePlugins()`.

### 6.2 File Storage

```
.od/
├── app.sqlite       ← DB chính
├── app.sqlite-wal   ← WAL journal
├── app.sqlite-shm   ← WAL shared memory
├── artifacts/       ← Standalone exports
│   └── <timestamp>-<name>.html
├── media-config.json ← API credentials (gitignored)
└── projects/
    └── <uuid>/       ← Project working dir
        ├── index.html
        ├── brand-spec.md
        ├── style.css
        ├── images/
        └── ...
```

---

## 7. Giao diện hệ thống (API)

### 7.1 API Base URL

- **Development:** `http://localhost:7456`
- **Production (Docker):** `http://localhost:7456`
- **Web proxy rewrite:** `/api/*` → daemon trong dev mode

### 7.2 Authentication

```http
Authorization: Bearer <OD_API_TOKEN>
```

Khi `OD_API_TOKEN` được set trong env, tất cả API requests phải có header này.

### 7.3 API Groups

#### Projects API

```
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id
GET    /api/projects/:id/conversations
POST   /api/projects/:id/conversations
GET    /api/projects/:id/conversations/:convId/messages
POST   /api/projects/:id/conversations/:convId/messages  ← SSE stream
DELETE /api/projects/:id/conversations/:convId
GET    /api/projects/:id/files
GET    /api/projects/:id/files/:name
PUT    /api/projects/:id/files/:name
DELETE /api/projects/:id/files/:name
GET    /api/projects/:id/archive
GET    /api/projects/:id/deployments
```

#### Skills API

```
GET /api/skills
GET /api/skills/:id
GET /api/skills/:id/example
POST /api/skills/:id/install    ← Install từ GitHub
DELETE /api/skills/:id          ← Uninstall
```

#### Design Systems API

```
GET    /api/design-systems
GET    /api/design-systems/:id
GET    /api/design-systems/:id/preview
GET    /api/design-systems/:id/showcase
POST   /api/design-systems
PUT    /api/design-systems/:id
DELETE /api/design-systems/:id
POST   /api/design-systems/import/github
POST   /api/design-systems/:id/install
DELETE /api/design-systems/:id/uninstall
```

#### Media API

```
POST /api/media/image
POST /api/media/video
POST /api/media/audio
GET  /api/media/tasks/:id
GET  /api/media/tasks           ← Recent tasks
GET  /api/elevenlabs/voices
GET  /api/media/models
GET  /api/media/config          ← Đọc provider credentials (masked)
PUT  /api/media/config          ← Save provider credentials
```

#### Deploy API

```
POST /api/projects/:id/deployments/vercel
POST /api/projects/:id/deployments/cloudflare
GET  /api/projects/:id/deployments/:deployId
GET  /api/cloudflare/zones
GET  /api/deploy/config
PUT  /api/deploy/config
```

#### Import/Export API

```
POST /api/import/claude-design
GET  /api/projects/:id/files/:name/export/html
GET  /api/projects/:id/files/:name/export/pdf
GET  /api/projects/:id/archive
GET  /api/projects/:id/transcript
```

#### Proxy API (BYOK)

```
POST /api/proxy/anthropic/stream
POST /api/proxy/openai/stream
POST /api/proxy/azure/stream
POST /api/proxy/google/stream
POST /api/proxy/ollama/stream
POST /api/proxy/senseaudio/stream
```

#### MCP API

```
GET  /api/mcp/config
PUT  /api/mcp/config
GET  /api/mcp/templates
POST /api/mcp/oauth/begin
POST /api/mcp/oauth/callback
POST /api/mcp/oauth/refresh
GET  /api/mcp/tokens
```

#### Agents API

```
GET  /api/agents
POST /api/agents/test
GET  /api/agents/models
POST /api/providers/test
GET  /api/providers/models
```

#### Routines API

```
GET    /api/routines
POST   /api/routines
GET    /api/routines/:id
PUT    /api/routines/:id
DELETE /api/routines/:id
POST   /api/routines/:id/run
GET    /api/routines/:id/runs
```

#### Static Resources

```
GET /artifacts/:name        ← Static artifact files
GET /frames/:name           ← Device frame SVGs
GET /design-systems/:id/*   ← Design system assets
GET /skills/:id/*           ← Skill assets
```

### 7.4 SSE Chat Stream

```
POST /api/projects/:id/conversations/:convId/messages
Content-Type: application/json
Body: {
  content: string,
  attachments?: ChatAttachment[],
  commentAttachments?: ChatCommentAttachment[],
  agentId?: string,
  skillId?: string,
  designSystemId?: string,
  projectMetadata?: ProjectMetadata,
  research?: { enabled: boolean, query?: string }
}
→ Content-Type: text/event-stream

event: delta
data: {"text": "..."}

event: todo
data: {"items": [{"id":"...", "content":"...", "status":"in_progress"}]}

event: artifact
data: {"identifier":"...", "title":"...", "html":"..."}

event: question_form
data: {"id":"discovery", "fields": [...]}

event: direction_picker
data: {"directions": [...]}

event: file_op
data: {"path":"index.html", "operation":"write"}

event: end
data: {"runId":"...", "status":"succeeded"}

event: error
data: {"message":"...", "code":"..."}
```

---

## 8. Giao diện người dùng

### 8.1 Views và Components

| View | Component | Mô tả |
|------|---------|-------|
| **Home** | `HomeView.tsx` | Entry point, prompt input, chip rail |
| **Home Hero** | `HomeHero.tsx` | Hero banner, recent projects |
| **Project** | `ProjectView.tsx` | Chat + file workspace + preview |
| **Settings** | `SettingsDialog.tsx` | Toàn bộ settings |
| **Design Systems** | `DesignSystemFlow.tsx` | DS browser + creator |
| **Plugins** | `PluginsView.tsx` | Plugin catalog |
| **Connectors** | `ConnectorsBrowser.tsx` | Connector management |
| **Tasks** | `TasksView.tsx` | Routines + automation |

### 8.2 Home View Layout

```
┌─────────────────────────────────────────────────────┐
│  [Logo]  [Recent Projects Strip]       [Settings]   │
├─────────────────────────────────────────────────────┤
│                                                     │
│              [Prompt Input Card]                    │
│                                                     │
│  [Chip Rail: web | image | video | audio | ...]    │
│                                                     │
│  [Skills Section] [Design Systems Section]          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 8.3 Project View Layout

```
┌──────────────┬─────────────────────────┬────────────┐
│  Chat Pane   │  File Workspace / Preview│ Files Panel│
│              │                         │            │
│  [Messages]  │  [iframe Preview]       │ [File List]│
│              │  or                     │            │
│  [Composer]  │  [File Editor]          │            │
└──────────────┴─────────────────────────┴────────────┘
       ↑                 ↑
  SSE streaming    srcdoc iframe
```

### 8.4 Chip Rail (Home Composer Media Surface)

| Chip | Surface | Maps to |
|------|---------|---------|
| Web | `web` | `kind: "design"` (prototype) |
| Image | `image` | `kind: "image"` |
| Video | `video` | `kind: "video"` |
| Audio | `audio` | `kind: "audio"` |
| HyperFrames | `video` | `kind: "video"`, `videoModel: "hyperframes-html"` |

### 8.5 Routing

| Route | Component | Mô tả |
|-------|---------|-------|
| `/` | `HomeView` | Landing |
| `/project/:id` | `ProjectView` | Project workspace |
| `/project/:id/settings` | `SettingsDialog` (project) | Project settings |
| `/design-systems` | `DesignSystemsTab` | DS library |
| `/skills` | `SkillsSection` | Skills catalog |
| `/plugins` | `PluginsView` | Plugin catalog |
| `/connectors` | `ConnectorsBrowser` | Connectors |
| `/tasks` | `TasksView` | Routines |
| `/settings` | `SettingsDialog` | Global settings |
| `/integrations` | `IntegrationsView` | Integrations |

---

## 9. Ràng buộc và giả định

### 9.1 Ràng buộc kỹ thuật

| # | Ràng buộc |
|---|----------|
| C-01 | SQLite chỉ cho phép một writer đồng thời (WAL mode cải thiện nhưng không eliminate) |
| C-02 | Agent CLI yêu cầu cài đặt riêng trên máy user (ngoài phạm vi của OD) |
| C-03 | Desktop app không share data dir với dev-server đồng thời |
| C-04 | Schema migrations là forward-only (không có rollback) |
| C-05 | Windows ENAMETOOLONG: command line < 8191 chars (fallback: stdin/prompt-file) |
| C-06 | Browser phải support `srcdoc` iframe (Chrome 88+, Firefox 89+, Safari 14+) |
| C-07 | `OD_DATA_DIR` chỉ dùng absolute hoặc relative-to-repo path |
| C-08 | Plugin artifacts không thể merge nếu Desktop đã có data riêng |

### 9.2 Giả định

| # | Giả định |
|---|---------|
| A-01 | Node.js `~24` tương thích với tất cả dependencies |
| A-02 | pnpm `10.33.x` là package manager duy nhất |
| A-03 | SQLite filesystem không phải NFS/CIFS (WAL mode cần file locking) |
| A-04 | User có write permission tại thư mục chứa `.od/` |
| A-05 | Media API keys được bảo mật bởi user, không phải daemon |
| A-06 | Agent CLI được trust hoàn toàn — có thể read/write arbitrary files trong project dir |

---

## 10. Kịch bản kiểm thử

### ATS-01: First Run Onboarding

**Precondition:** Fresh install, Claude Code có trên PATH  
**Steps:**
1. Khởi động daemon: `pnpm tools-dev run web`
2. Mở browser tại `http://localhost:7457`
3. Welcome dialog xuất hiện
4. Kiểm tra agent list: Claude Code hiển thị "Available"
5. Nhập Anthropic API key → Test Connection → "OK"
6. Close dialog → có thể tạo project

**Expected:**
- ✅ Daemon khởi động < 10s
- ✅ `.od/` được tạo tự động
- ✅ ≥ 130 skills load
- ✅ ≥ 150 design systems load

### ATS-02: End-to-End Design Workflow

**Steps:**
1. Home → nhập "Create a SaaS landing page for B2B analytics"
2. Chọn skill: `saas-landing`, DS: `stripe`
3. Submit → Discovery form xuất hiện
4. Điền: Surface=desktop, Audience=B2B managers, Tone=professional
5. Submit form → Direction picker xuất hiện
6. Chọn "Modern Minimal"
7. Agent todo streaming: Read SKILL → Write brand-spec → Create HTML → Critique
8. Artifact render trong iframe
9. Gõ "Make the header section taller and add a gradient background"
10. Agent update → artifact re-render
11. Export HTML → file download → mở offline

**Expected:**
- ✅ Discovery form xuất hiện trước khi agent viết code
- ✅ Todo card stream real-time
- ✅ Artifact render < 2s
- ✅ Chat update không reset toàn bộ
- ✅ HTML export < 5MB, hoạt động offline

### ATS-03: Deck Workflow

**Steps:**
1. Chọn skill: `guizang-ppt`
2. Nhập: "Make a seed round pitch deck for an AI fintech startup"
3. Điền form → chọn direction
4. Agent tạo 8-12 slide deck
5. Preview: horizontal swipe hoạt động
6. Export PDF → 8-12 trang, mỗi slide = 1 trang

**Expected:**
- ✅ Slides có horizontal swipe navigation
- ✅ PDF slide boundaries đúng
- ✅ Text selectable trong PDF

### ATS-04: Deploy Flow

**Steps:**
1. Có artifact HTML hoàn chỉnh
2. Click Deploy → Vercel
3. Nhập Vercel token
4. Status: pending → building → ready
5. Mở URL trong browser tab khác

**Expected:**
- ✅ Deploy < 60s
- ✅ URL accessible từ ngoài
- ✅ Status tracking đúng

### ATS-05: BYOK Proxy

**Precondition:** Không có agent CLI, có OpenAI API key  
**Steps:**
1. Settings → API → chọn OpenAI, nhập key, chọn model `gpt-4o`
2. Tạo project → Chat
3. Agent stream từ OpenAI API

**Expected:**
- ✅ Chat hoạt động qua BYOK proxy
- ✅ SSRF: test với private IP → bị reject
- ✅ Loopback URL cho Ollama → allowed

### ATS-06: Security — SSRF Blocking

**Steps:**
1. Settings → API → nhập baseUrl: `http://192.168.1.1/api`
2. Test Connection

**Expected:**
- ✅ Connection bị reject với error message rõ ràng
- ✅ Không có request nào đến 192.168.1.1

### ATS-07: Mobile Prototype

**Steps:**
1. Chọn chip: Web → Skill: `mobile-app`
2. Nhập: "Design a mobile banking app for VNPay users"
3. Discovery: Surface=mobile, Audience=millennials
4. Agent tạo 3 screens trong iPhone 15 Pro frame
5. Preview render đúng device frame
6. Export ZIP

**Expected:**
- ✅ iPhone 15 Pro frame visible với Dynamic Island
- ✅ 3 screens phân biệt
- ✅ ZIP chứa đúng files

### ATS-08: Routine Automation

**Steps:**
1. Tasks → Create Routine
2. Name: "Weekly Design Digest", Schedule: Every Monday 09:00
3. Prompt: "Create a design progress summary", Skill: `pm-spec`
4. Enable → Save
5. Manual trigger (test)
6. Check: new project created với pm-spec artifact

**Expected:**
- ✅ Routine run history hiển thị
- ✅ Project mới được tạo
- ✅ Artifact có đúng format pm-spec

### ATS-09: Data Persistence

**Steps:**
1. Tạo project, chat vài turns
2. Đóng browser
3. Kill daemon: `pnpm tools-dev stop`
4. Start lại: `pnpm tools-dev run web`
5. Mở lại browser

**Expected:**
- ✅ Projects list đầy đủ
- ✅ Conversation history đầy đủ
- ✅ File workspace giống hệt trước khi stop
- ✅ Open tabs được restore

---

## 11. Thuật ngữ

| Thuật ngữ | Định nghĩa |
|-----------|------------|
| **Project** | Top-level workspace chứa conversations và design files; có thư mục riêng trên disk |
| **Normal Artifact** | Design output tĩnh được tạo bởi agent — có Artifact Entry File và Artifact Manifest |
| **Live Artifact** | Refreshable design output với source data và preview state |
| **Artifact Entry File** | File chính (thường là `index.html`) mở/render một Normal Artifact |
| **Artifact Manifest** | Sidecar metadata xác định kind, renderer, exports, và entry file |
| **Active Project** | Project user tương tác gần nhất; được dùng mặc định cho MCP operations |
| **Chip Rail** | Hàng intent chips phía dưới Home prompt card |
| **Home Composer Media Surface** | Intent surface (web/image/video/audio/hyperframes) chọn trước khi submit |
| **HyperFrames Composer Surface** | HTML-based motion generation surface, submit dưới dạng `kind: "video"` |
| **Essential Audio Generation** | Audio entry workflow bao gồm speech và sound effects (loại trừ music) |
| **Audio Source Field** | Speech dùng Text source; sound effects dùng Prompt source |
| **ElevenLabs Fallback Voice** | Default voice ID khi ElevenLabs API không load được voice list |
| **Skill** | Folder SKILL.md + assets/ + references/ định nghĩa một design workflow |
| **Design System** | Folder DESIGN.md (9-section schema) định nghĩa brand tokens |
| **BYOK** | Bring Your Own Key — user cung cấp API key của AI provider |
| **SSE** | Server-Sent Events — streaming real-time từ daemon |
| **MCP** | Model Context Protocol — protocol tích hợp external tools |
| **ACP** | Agent Client Protocol — JSON-RPC protocol cho agents như Devin, Hermes, Kimi |
| **Daemon** | Local Express.js server chạy trên máy user |
| **Sidecar IPC** | Unix socket communication giữa Desktop app và daemon |
| **WAL** | Write-Ahead Logging — SQLite journaling mode cho concurrent access |
| **SSRF** | Server-Side Request Forgery — class of attack mà daemon phải block |
| **Junior-Designer Mode** | Workflow: batch câu hỏi trước, show visible sớm, cho redirect rẻ |
| **5-Dim Critique** | 5-dimensional self-critique: Philosophy · Hierarchy · Detail · Function · Innovation |
| **TodoWrite** | Agent tool để emit live progress card trong UI |
| **Turn** | Một round trip: user message → agent response |
| **Run** | Một agent execution session (có runId, status, start/end time) |
| **OD_DATA_DIR** | Env var để relocate toàn bộ daemon data (`.od/`) |
| **OD_MEDIA_CONFIG_DIR** | Env var để tách `media-config.json` ra khỏi data dir |
| **OD_API_TOKEN** | Env var để enable API authentication |

---

## 12. Phụ lục

### 12.1 Environment Variables

| Variable | Mô tả | Default |
|---------|-------|---------|
| `OD_DATA_DIR` | Relocate `.od/` data dir | `<repo>/.od/` |
| `OD_MEDIA_CONFIG_DIR` | Override chỉ `media-config.json` | Same as `OD_DATA_DIR` |
| `OD_API_TOKEN` | Enable API token auth | — (off) |
| `OD_DAEMON_URL` | Override daemon URL | `http://localhost:7456` |
| `OD_BIN` / `OD_DAEMON_CLI_PATH` | Override daemon binary path | Auto-resolved |
| `OD_LEGACY_DATA_DIR` | Source dir cho auto-migration | — |
| `OD_DESKTOP_AUTH` | Enable desktop auth gate | — |
| `OD_RESOURCE_ROOT` | Override resource root (skills, DS) | Auto-resolved |
| `CODEX_HOME` | Codex home dir (for image generation) | `~/.codex` |

### 12.2 Docker Configuration

```yaml
# deploy/docker-compose.yml
services:
  open-design:
    image: ghcr.io/nexu-io/open-design:latest
    ports:
      - "7456:7456"
    environment:
      - OD_API_TOKEN=${OD_API_TOKEN}
    volumes:
      - od-data:/app/.od
volumes:
  od-data:
```

**Quick start:**
```bash
cd deploy
cp .env.example .env
# Edit .env: OD_API_TOKEN=<secure-token>
docker compose up -d
# → http://localhost:7456
```

### 12.3 Ports Reference

| Port | Service | Configurable |
|------|---------|-------------|
| 7456 | Daemon (Express.js) | `--daemon-port` |
| 7457 | Web (Next.js dev) | `--web-port` |

### 12.4 Data Migration Path (Desktop App)

| Platform | App Data Base | Stable Channel Path |
|---------|-------------|-------------------|
| macOS | `~/Library/Application Support` | `Open Design/namespaces/release-stable/data/` |
| Windows | `%APPDATA%` | `Open Design\namespaces\release-stable-win\data\` |
| Linux | `$XDG_CONFIG_HOME` (`~/.config`) | `Open Design/namespaces/release-stable-linux/data/` |

### 12.5 Skill Protocol Reference

Xem [`docs/skills-protocol.md`](./skills-protocol.md) (nếu có) để biết chi tiết về frontmatter schema và cách tạo skill mới.

### 12.6 Links

| Tài liệu | URL |
|---------|-----|
| GitHub Repository | https://github.com/nexu-io/open-design |
| Desktop Download | https://open-design.ai/ |
| Discord Community | https://discord.gg/qhbcCH8Am4 |
| awesome-design-md | https://github.com/VoltAgent/awesome-design-md |
| awesome-design-skills | https://github.com/bergside/awesome-design-skills |

---

*Tài liệu này được tạo bởi VNPay Platform Team dựa trên phân tích mã nguồn `open-design-vnpay` v0.8.0 (2026-06-03).*  
*Mọi thay đổi về implementation phải được phản ánh vào tài liệu này.*
