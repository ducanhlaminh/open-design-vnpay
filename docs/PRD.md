# Product Requirements Document (PRD)
# Open Design — VNPay Edition

**Phiên bản:** 1.0  
**Ngày:** 2026-06-02  
**Trạng thái:** Bản nháp  
**Tác giả:** VNPay Platform Team  

---

## 1. Tổng quan sản phẩm

### 1.1 Tầm nhìn

**Open Design (VNPay Edition)** là nền tảng thiết kế mã nguồn mở, local-first, được tùy chỉnh dành cho hệ sinh thái VNPay. Đây là giải pháp thay thế mã nguồn mở cho Claude Design/Figma — web-deployable, BYOK (Bring Your Own Key) ở mọi lớp, cho phép 16 coding-agent CLI tự động phát hiện trên PATH trở thành design engine, được điều khiển bởi 132+ Skills có thể kết hợp và 150+ Design Systems chuẩn brand.

### 1.2 Mục tiêu sản phẩm

| Mục tiêu | Mô tả |
|----------|-------|
| **Tự chủ công nghệ** | Không phụ thuộc vào công cụ thiết kế đám mây đóng cửa (Figma, Claude Design) |
| **BYOK mọi lớp** | Dùng API key riêng cho mọi mô hình AI (Anthropic, OpenAI, Azure, Google, Ollama) |
| **Local-first** | Toàn bộ dữ liệu dự án lưu local, không bắt buộc đám mây |
| **Tích hợp đa agent** | Hỗ trợ 16 coding-agent CLI (Claude Code, Codex, Gemini CLI, Cursor, ...) |
| **Design system chuẩn hóa** | 150+ design systems dạng Markdown portable, dễ mở rộng |
| **Artifact-first workflow** | Mọi đầu ra là artifact có thể xem, tải, chỉnh sửa và deploy |

### 1.3 Phạm vi sản phẩm

**Trong phạm vi:**
- Web application (Next.js 16, App Router)
- Local daemon (Node.js 24, Express, SQLite)
- Desktop application (Electron, tùy chọn)
- Skills catalog (132+ skills)
- Design Systems library (150+ systems)
- Media generation (image, video, audio)
- Export/Import (HTML, PDF, PPTX, ZIP, Markdown)
- Deploy (Vercel, Cloudflare Pages)
- MCP (Model Context Protocol) integration

**Ngoài phạm vi:**
- Dịch vụ đám mây độc quyền của bên thứ ba
- Mobile app native (iOS/Android)
- Công cụ thiết kế vector trực tiếp (như Figma)

---

## 2. Đối tượng người dùng

### 2.1 Persona chính

#### 👤 Nhà thiết kế sản phẩm (Product Designer)
- **Nhu cầu:** Tạo prototype nhanh, thử nghiệm design system mới, xuất ra artifact HTML/PDF có thể review
- **Điểm đau:** Tool thiết kế quá phức tạp, chi phí cao, lock-in vendor
- **Kỳ vọng:** Giao diện chat đơn giản → artifact đẹp, có thể share và chỉnh sửa

#### 👤 Kỹ sư Frontend (Frontend Engineer)
- **Nhu cầu:** Xem spec thiết kế chính xác, lấy code HTML/CSS sẵn sàng tích hợp
- **Điểm đau:** Mô tả thiết kế mơ hồ, thiếu tài liệu design token
- **Kỳ vọng:** Artifact có code HTML clean, design system documented theo chuẩn Markdown

#### 👤 Trưởng nhóm kỹ thuật / Product Manager
- **Nhu cầu:** Review design nhanh, approve concept, theo dõi tiến độ
- **Điểm đau:** Phải cài đặt nhiều tool, khó chia sẻ với stakeholder
- **Kỳ vọng:** URL preview shareable, export PDF/PPTX cho presentation

#### 👤 AI Engineer / Developer
- **Nhu cầu:** Tích hợp MCP, tùy chỉnh skills, thêm connector
- **Điểm đau:** Hệ thống prompt phức tạp, khó extend
- **Kỳ vọng:** API rõ ràng, skills dạng file Markdown dễ fork

### 2.2 Persona phụ

- **Quản lý sản phẩm (PM):** Tạo spec document (pm-spec skill), OKR scoresheet, kanban board
- **Nhóm marketing:** Tạo social carousel, landing page, email marketing, poster
- **Nhóm tài chính/HR:** Tạo báo cáo tài chính, onboarding plan, invoice

---

## 3. Tính năng sản phẩm

### 3.1 Core Features — Thiết kế với AI Agent

#### F-01: Multi-Agent Detection & Routing
- Tự động phát hiện 16 CLI agent trên PATH: Claude Code, Codex, Devin, Cursor Agent, Gemini CLI, OpenCode, Qwen, Qoder CLI, GitHub Copilot CLI, Hermes, Kimi, Pi, Kiro, Kilo, Mistral Vibe, DeepSeek TUI
- Chuyển đổi agent một click từ model picker
- BYOK Proxy fallback: Anthropic / OpenAI / Azure / Google / Ollama / SenseAudio
- SSRF protection: Chặn non-loopback private IP, link-local, CGNAT, multicast

#### F-02: Skills System (132+ Skills)
- Mỗi skill là một folder `SKILL.md` + `assets/` + `references/`
- Frontmatter mở rộng `od:` với: `mode`, `platform`, `scenario`, `preview.type`, `design_system.requires`
- **Modes:** `prototype`, `deck`, `image`, `video`, `audio`, `template`, `design-system`, `utility`
- **Scenarios:** `design`, `marketing`, `operation`, `engineering`, `product`, `finance`, `hr`, `sale`, `personal`
- Thêm skill mới: tạo folder → restart daemon → xuất hiện trong picker

**Skill nổi bật:**
| Skill | Platform | Scenario | Output |
|-------|----------|----------|--------|
| `web-prototype` | desktop | design | Single-page HTML landing |
| `saas-landing` | desktop | marketing | Hero/features/pricing layout |
| `dashboard` | desktop | operation | Admin panel với data layout |
| `mobile-app` | mobile | design | iPhone 15 Pro / Pixel framed |
| `mobile-onboarding` | mobile | design | Multi-screen onboarding flow |
| `gamified-app` | mobile | personal | Gamified mobile prototype |
| `guizang-ppt` | desktop | design | Magazine-style web PPT |
| `pm-spec` | desktop | product | PM specification doc |
| `eng-runbook` | desktop | engineering | Incident runbook |
| `finance-report` | desktop | finance | Exec finance summary |

#### F-03: Design Systems Library (150+ Systems)
- Schema 9-section `DESIGN.md`: color, typography, spacing, layout, components, motion, voice, brand, anti-patterns
- Portable Markdown, không phải theme JSON
- Brands nổi bật: Linear, Stripe, Vercel, Airbnb, Tesla, Notion, Apple, Anthropic, Cursor, Supabase, Figma, Revolut, Coinbase, và VNPay custom
- Switch system → lần render tiếp dùng token mới

#### F-04: Interactive Question Form (Turn-1 Discovery)
- Trước khi agent viết một pixel, OD lock brief qua form tương tác
- Thu thập: surface, audience, tone, brand context, scale, constraints
- Direction Picker: 5 trường phái thị giác (Editorial Monocle, Modern Minimal, Warm Soft, Tech Utility, Brutalist Experimental)
- Mỗi trường phái có palette OKLch xác định + font stack

#### F-05: Live Artifact Rendering
- Mỗi `<artifact>` render trong sandboxed srcdoc iframe
- Artifact Parser tách và hiển thị HTML/CSS/JS real-time
- File Workspace: xem, chỉnh sửa file trong project
- Download chips: HTML, PDF, ZIP, PPTX, Markdown

#### F-06: Agent Runtime & Project Filesystem
- Daemon spawn CLI với `cwd` = project folder `.od/projects/<id>/`
- Agent có quyền: Read, Write, Bash, WebFetch trên filesystem thực
- Windows ENAMETOOLONG fallbacks (stdin / prompt-file)
- Sessions persist trong SQLite — mở lại dự án ngày mai, todo card đúng chỗ

### 3.2 Media Generation

#### F-07: Image Generation
- **GPT-Image-2** (Azure/OpenAI): poster, avatar, infographic, illustrated map
- **Custom Image API / ImageRouter**: bất kỳ endpoint OpenAI-compatible
- 43 prompt templates sẵn có

#### F-08: Video Generation
- **Seedance 2.0** (ByteDance): text-to-video và image-to-video, 15s cinematic
- **HyperFrames** (HeyGen): HTML→MP4 motion graphics
- 39 Seedance + 11 HyperFrames prompt templates

#### F-09: Audio Generation
- Speech (ElevenLabs, text source)
- Sound effects (prompt source)
- ElevenLabs Fallback Voice khi không load được voices

### 3.3 Deployment & Export

#### F-10: Export
- HTML (inline assets)
- PDF (browser print, deck-aware)
- PPTX (agent-driven qua skill)
- ZIP (archiver)
- Markdown

#### F-11: Deploy
- Vercel deployment
- Cloudflare Pages deployment
- Preview và production targets

#### F-12: Import
- Claude Design export ZIP → Real project (POST /api/import/claude-design)
- GitHub Design System import

### 3.4 Platform & Infrastructure

#### F-13: MCP Integration
- Model Context Protocol server/client
- Live Artifacts MCP Server
- OAuth 2.0 support cho MCP connectors
- Tool token registry

#### F-14: Persistence (SQLite)
- Projects, Conversations, Messages, Tabs, Templates
- Routines (scheduled automation)
- Deployments
- Media tasks
- Plugin snapshots

#### F-15: Connectors & Memory
- Memory extraction từ conversations
- Connector credentials management (Composio integration)
- Community pets sync

#### F-16: Routines (Scheduled Automation)
- Cron-based và time-based scheduling
- Orbit: Daily connector activity digest
- Routine run tracking với status, error, summary

---

## 4. Prompt Stack Architecture

```
DISCOVERY directives  (turn-1 form, turn-2 brand branch, TodoWrite, 5-dim critique)
  + identity charter   (OFFICIAL_DESIGNER_PROMPT, anti-AI-slop, junior-pass)
  + active DESIGN.md   (150 systems available)
  + active SKILL.md    (132 skills available)
  + project metadata   (kind, fidelity, speakerNotes, animations, inspiration ids)
  + skill side files   (auto-injected pre-flight: assets/template.html + references/*.md)
  + (deck kind) DECK_FRAMEWORK_DIRECTIVE   (nav / counter / scroll / print)
```

**Junior-Designer mode** (từ huashu-design):
1. Batch câu hỏi lên trước
2. Show something visible sớm (dù là wireframe)
3. Để user redirect rẻ

**5-dimensional self-critique:**
- Philosophy · Hierarchy · Detail · Function · Innovation

---

## 5. Yêu cầu hiệu suất & chất lượng

### 5.1 Performance
- Artifact render: < 2s trong sandboxed iframe
- Agent spawn: < 1s sau khi submit prompt
- SSE streaming: real-time, không có delay cảm nhận được
- SQLite WAL mode: concurrent reads không block writes

### 5.2 Reliability
- Daemon auto-restart khi crash
- SQLite WAL mode cho consistency
- Stale run reconciliation khi boot
- Snapshot GC cho plugin artifacts

### 5.3 Security
- SSRF blocking: loopback allowed, non-loopback private/link-local/CGNAT/multicast rejected
- Desktop auth gate cho packaged app
- Origin validation cho browser requests
- API token protection

### 5.4 Accessibility
- i18n hỗ trợ qua `/apps/web/src/i18n/`
- Keyboard shortcuts (Quick Switcher)
- Screen reader friendly components

---

## 6. Kiến trúc kỹ thuật

```
┌────────────────────── browser (Next.js 16) ──────────────────────┐
│  chat · file workspace · iframe preview · settings · imports     │
└──────────────┬───────────────────────────────────┬───────────────┘
               │ /api/* (rewritten in dev)          │
               ▼                                    ▼
   ┌──────────────────────────────────┐   /api/proxy/{provider}/stream (SSE)
   │  Local daemon (Express + SQLite) │   ─→ any OpenAI-compat endpoint (BYOK)
   │                                  │
   │  /api/agents          /api/skills│
   │  /api/design-systems  /api/projects/…
   │  /api/chat (SSE)      /api/proxy/{provider}/stream (SSE)
   │  /api/templates       /api/import/claude-design
   │  /api/artifacts/save  /api/artifacts/lint
   │  /api/upload          /api/projects/:id/files…
   │  /artifacts (static)  /frames (static)
   │
   │  sidecar IPC: /tmp/open-design/ipc/<ns>/<app>.sock
   └─────────┬────────────────────────┘
             │ spawn(cli, [...], { cwd: .od/projects/<id> })
             ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  claude · codex · devin · gemini · opencode · cursor-agent   │
   │  qwen · qoder · copilot · hermes · kimi · pi · kiro · kilo  │
   │  vibe · deepseek                                             │
   └──────────────────────────────────────────────────────────────┘
```

| Layer | Stack |
|-------|-------|
| Frontend | Next.js 16 App Router + React 18 + TypeScript |
| Daemon | Node 24 · Express · SSE · better-sqlite3 |
| Agent transport | child_process.spawn · claude-stream-json · acp-json-rpc · pi-rpc · plain |
| BYOK proxy | POST /api/proxy/{anthropic,openai,azure,google,ollama,senseaudio}/stream |
| Storage | `.od/projects/<id>/` + `.od/app.sqlite` + `.od/media-config.json` |
| Preview | Sandboxed iframe srcdoc + artifact parser |
| Desktop | Electron shell với sidecar IPC |

---

## 7. Lộ trình phát triển

### Phase 1 — Core Platform (Hiện tại: v0.8.0-preview)
- [x] Multi-agent detection (16 CLIs)
- [x] Skills system (132+ skills)
- [x] Design systems library (150+ systems)
- [x] Interactive question form
- [x] Live artifact rendering
- [x] Export (HTML, PDF, PPTX, ZIP)
- [x] Deploy (Vercel, Cloudflare Pages)
- [x] SQLite persistence
- [x] MCP integration
- [x] Media generation (image, video, audio)

### Phase 2 — VNPay Customization
- [ ] VNPay Design System (`design-systems/vnpay/DESIGN.md`)
- [ ] VNPay-specific Skills (product spec, payment flow prototype)
- [ ] Single Sign-On với hệ thống VNPay
- [ ] Private deployment (on-premise)
- [ ] Tích hợp KGS Platform (Knowledge Graph Service)

### Phase 3 — Enterprise Features
- [ ] Team collaboration (multi-user projects)
- [ ] Access control & audit log
- [ ] Custom connector marketplace
- [ ] Analytics dashboard cho design metrics

---

## 8. Điều kiện thành công (Success Metrics)

| Metric | Target |
|--------|--------|
| Time to first artifact | < 3 phút từ khi nhập prompt |
| Agent spawn success rate | > 99% |
| Artifact render time | < 2s |
| User retention (week 1) | > 70% |
| Daily active projects | > 10 projects/ngày |
| Export success rate | > 99% |

---

## 9. Rủi ro & Giảm thiểu

| Rủi ro | Xác suất | Tác động | Giảm thiểu |
|--------|----------|----------|------------|
| Agent CLI không available | Cao | Cao | BYOK proxy fallback sẵn sàng |
| LLM output không đúng format | Trung bình | Trung bình | Artifact parser robust, lint-artifact |
| SQLite corruption | Thấp | Cao | WAL mode, backup routine |
| SSRF attack | Thấp | Cao | Blocklist validated tại daemon edge |
| Breaking changes từ upstream | Trung bình | Trung bình | Lock dependency versions |

---

## 10. Phụ lục

### 10.1 Thuật ngữ
| Thuật ngữ | Định nghĩa |
|-----------|------------|
| **Project** | Workspace thiết kế chứa conversations và design files |
| **Normal Artifact** | Design output với entry file và manifest |
| **Live Artifact** | Refreshable design output với source data và preview state |
| **Artifact Entry File** | File chính mở/render một Normal Artifact |
| **Artifact Manifest** | Sidecar metadata xác định kind, renderer, exports |
| **Active Project** | Project user tương tác gần nhất, dùng cho MCP operations |
| **Chip Rail** | Hàng intent chips bên dưới Home prompt card |
| **Skill** | Một folder SKILL.md + assets/ định nghĩa một workflow thiết kế |
| **BYOK** | Bring Your Own Key — dùng API key riêng |
| **SSE** | Server-Sent Events — streaming real-time từ daemon |
| **MCP** | Model Context Protocol |
| **ACP** | Agent Client Protocol |

### 10.2 Tham chiếu
- [Open Design GitHub](https://github.com/nexu-io/open-design)
- [QUICKSTART.md](../QUICKSTART.md)
- [CONTEXT.md](../CONTEXT.md)
- [skills-protocol.md](./skills-protocol.md)
