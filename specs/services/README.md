# Open Design — Backend Microservices Architecture (Golang)

> **Version**: 1.0.0  
> **Date**: 2026-06-03  
> **Status**: Proposed  

---

## Mục lục tài liệu

| File | Nội dung |
|------|---------|
| [00-overview.md](./00-overview.md) | Tổng quan kiến trúc, nguyên tắc thiết kế, sơ đồ hệ thống |
| [01-api-gateway.md](./01-api-gateway.md) | API Gateway — routing, auth, rate limiting, SSE proxy |
| [02-project-service.md](./02-project-service.md) | Project Service — CRUD dự án, conversations, messages |
| [03-agent-service.md](./03-agent-service.md) | Agent Service — AI agent orchestration, run lifecycle, SSE streaming |
| [04-design-system-service.md](./04-design-system-service.md) | Design System Service — DS catalog, import, generation |
| [05-media-service.md](./05-media-service.md) | Media Service — image/video/audio generation |
| [06-plugin-service.md](./06-plugin-service.md) | Plugin Service — plugin registry, sandbox execution |
| [07-mcp-service.md](./07-mcp-service.md) | MCP Service — Model Context Protocol server |
| [08-memory-service.md](./08-memory-service.md) | Memory Service — context persistence, embedding |
| [09-skill-service.md](./09-skill-service.md) | Skill Service — skill catalog, execution |
| [10-config-service.md](./10-config-service.md) | Config Service — app config, secrets management |
| [11-telemetry-service.md](./11-telemetry-service.md) | Telemetry Service — analytics, LLM tracing, metrics |
| [12-clean-architecture.md](./12-clean-architecture.md) | Clean Architecture pattern — layers, conventions, ví dụ code |
| [13-shared-infra.md](./13-shared-infra.md) | Shared Infrastructure — databases, message queue, observability |
| [14-deployment.md](./14-deployment.md) | Deployment — Docker Compose, Kubernetes, CI/CD |

---

## Tóm tắt hệ thống

```
Client (Web/Desktop/CLI)
        │
        ▼
  API Gateway (Go) ← single entry point
        │
  ┌─────┼──────────────────────────────────────────────┐
  │     │     │       │        │      │     │     │    │
  ▼     ▼     ▼       ▼        ▼      ▼     ▼     ▼    ▼
Project Agent Design  Media  Plugin  MCP  Memory Skill Config
Service Service System Service Service Svc  Svc   Svc   Svc
        │
        ▼
  Telemetry Service (async, via message queue)
```

Mỗi service là một **Go binary độc lập**, giao tiếp nội bộ qua **gRPC**, expose HTTP ra ngoài chỉ qua API Gateway.
