# Features Documentation — Open Design VNPay Edition

> **Version:** 1.0 | **Ngày:** 2026-06-24 | **Nguồn:** Phân tích mã nguồn `open-design-vnpay` v0.8.0

Thư mục này chứa tài liệu chi tiết từng tính năng của sản phẩm **Open Design VNPay Edition**.

---

## Danh mục tính năng

| File | Nhóm tính năng | Mô tả ngắn |
|------|----------------|------------|
| [01-agent-system.md](./01-agent-system.md) | 🤖 Agent System | Multi-agent detection, BYOK proxy |
| [02-skills-system.md](./02-skills-system.md) | 🎨 Skills | 132+ workflow thiết kế |
| [03-design-systems.md](./03-design-systems.md) | 🎭 Design Systems | 150+ design system library |
| [04-project-management.md](./04-project-management.md) | 📁 Projects | Quản lý projects, files, filesystem |
| [05-chat-and-streaming.md](./05-chat-and-streaming.md) | 💬 Chat | Conversation, SSE streaming, agent spawn |
| [06-discovery-form.md](./06-discovery-form.md) | 🔍 Discovery | Turn-1 form, Direction Picker, self-critique |
| [07-artifact-rendering.md](./07-artifact-rendering.md) | 🖼️ Artifact | Sandboxed preview, File Workspace, Comments |
| [08-export-deploy.md](./08-export-deploy.md) | 📤 Export & Deploy | HTML, PDF, PPTX, ZIP, Vercel, Cloudflare |
| [09-media-generation.md](./09-media-generation.md) | 🎬 Media | Image, Video, Audio generation |
| [10-routines-automation.md](./10-routines-automation.md) | ⚙️ Automation | Routines, Orbit daily digest |
| [11-mcp-integration.md](./11-mcp-integration.md) | 🔌 MCP | Model Context Protocol, OAuth 2.0 |
| [12-memory-connectors.md](./12-memory-connectors.md) | 🧠 Memory | Memory system, external connectors |
| [13-plugin-system.md](./13-plugin-system.md) | 🧩 Plugins | Plugin lifecycle, snapshots |
| [14-live-artifacts.md](./14-live-artifacts.md) | ⚡ Live Artifacts | Refreshable design outputs |
| [15-desktop-app.md](./15-desktop-app.md) | 🖥️ Desktop | Electron app, sidecar IPC, auth gate |
| [16-settings-config.md](./16-settings-config.md) | ⚙️ Settings | Cấu hình, Privacy, Telemetry, i18n |
| [17-import-templates.md](./17-import-templates.md) | 📥 Import | Claude Design ZIP, GitHub DS, Templates |

---

## Tổng quan kiến trúc

```
Browser (Next.js 16)
    ↕ /api/* (rewrite)
Local Daemon (Express + SQLite)
    ↕ child_process.spawn
AI Agent CLIs (16 agents) + BYOK API Proxy
```

**Tech stack:** Next.js 16 · React 18 · TypeScript · Node.js 24 · Express · SQLite (WAL) · SSE · Electron

---

## Trạng thái phát triển

| Phase | Status |
|-------|--------|
| Phase 1 — Core Platform (v0.8.0) | ✅ Hoàn thành |
| Phase 2 — VNPay Customization | 🔄 Đang phát triển |
| Phase 3 — Enterprise Features | 📋 Kế hoạch |
