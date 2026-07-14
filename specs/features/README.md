# Open Design VNPay — Feature Specs Index

> **Version:** 1.0 | **Date:** 2026-06-30 | **Based on:** feature docs in `docs/features/`

This directory contains **business logic** and **data flow** specifications for each feature of Open Design VNPay Edition.

Each feature folder contains two files:
- `business-logic.md` — Rules, constraints, data models, acceptance criteria
- `dataflow.md` — Step-by-step flow diagrams, API contracts, sequence flows

---

## Feature Index

| Folder | Feature Name | Feature IDs |
|--------|-------------|-------------|
| [F01-F02-agent-system](./F01-F02-agent-system/) | Multi-Agent Detection & BYOK Proxy | F-01, F-02 |
| [F03-skills-system](./F03-skills-system/) | Skills System | F-03 |
| [F04-design-systems](./F04-design-systems/) | Design Systems Library | F-04 |
| [F05-project-management](./F05-project-management/) | Project Management | F-05 |
| [F06-chat-streaming](./F06-chat-streaming/) | Chat & Agent Streaming | F-06 |
| [F07-discovery-form](./F07-discovery-form/) | Interactive Discovery Form (Turn-1) | F-07 |
| [F08-artifact-rendering](./F08-artifact-rendering/) | Artifact Rendering & Preview | F-08 |
| [F09-F10-F11-export-deploy-import](./F09-F10-F11-export-deploy-import/) | Export, Deploy & Import | F-09, F-10, F-11 |
| [F12-import-templates](./F12-import-templates/) | Import & Templates | F-12 |
| [F13-media-generation](./F13-media-generation/) | Media Generation | F-13 |
| [F14-F15-routines-orbit](./F14-F15-routines-orbit/) | Routines & Orbit (Automation) | F-14, F-15 |
| [F16-mcp-integration](./F16-mcp-integration/) | MCP Integration | F-16 |
| [F17-F22-memory-connectors](./F17-F22-memory-connectors/) | Memory System & Connectors | F-17, F-22 |
| [F18-plugin-system](./F18-plugin-system/) | Plugin System | F-18 |
| [F19-live-artifacts](./F19-live-artifacts/) | Live Artifacts | F-19 |
| [F20-desktop-app](./F20-desktop-app/) | Desktop Application (Electron) | F-20 |
| [F21-settings-config](./F21-settings-config/) | Settings & Configuration | F-21 |

---

## Architecture Overview

```
Browser (Next.js 16)
    ↕ /api/* (rewrite)
Local Daemon (Express + SQLite — WAL mode)
    ↕ child_process.spawn
AI Agent CLIs (16 agents) + BYOK API Proxy
```

**Tech Stack:** Next.js 16 · React 18 · TypeScript · Node.js 24 · Express · SQLite (WAL) · SSE · Electron

---

## Spec File Convention

Each `business-logic.md` covers:
- **Overview** — Feature purpose and boundaries
- **Business Rules (BR-xx)** — Numbered rules for traceability
- **Data Model** — Key TypeScript interfaces
- **Acceptance Criteria** — Testable conditions as checklist

Each `dataflow.md` covers:
- **Flow Diagrams** — ASCII art step-by-step flows
- **SSE Event Schemas** — Event formats for streaming flows
- **API Endpoints Table** — Method + path + description

---

## Development Status

| Phase | Status |
|-------|--------|
| Phase 1 — Core Platform (v0.8.0) | ✅ Complete |
| Phase 2 — VNPay Customization | 🔄 In Development |
| Phase 3 — Enterprise Features | 📋 Planned |
