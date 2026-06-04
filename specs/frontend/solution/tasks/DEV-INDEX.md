# DEV Sprint Plan — Implementation Tasks

> **Cập nhật**: 2026-06-03  
> **Tổng effort**: ~107.5 ngày (3 devs × ~36 ngày)  
> **Nguồn**: [DEV-00-plan-summary.md](../../develop/DEV-00-plan-summary.md)

---

## Chiến lược Nâng cấp (Quan trọng!)

Các services **KHÔNG được tạo mới từ đầu** — thay vào đó **nâng cấp codebase hiện có**:

| Codebase Hiện có | → Service Mới | Chiến lược |
|-----------------|--------------|------------|
| `services/preview-gateway` | API Gateway | ✅ Nâng cấp |
| `services/preview-project` | Project Service | ✅ Nâng cấp |
| `services/preview-ai-agent` | Agent Service | ✅ Nâng cấp |
| `services/preview-design` | Design System Service | ✅ Nâng cấp |
| `services/preview-identity` | Config Service (tách ra) | 🆕 Tạo mới |
| `services/apps/preview-mcp` | MCP Service | ✅ Nâng cấp + move |
| `services/prompt-registry-service` | Skill Service (pattern) | 🔄 Tái sử dụng pattern |
| *(chưa có)* | Media Service | 🆕 Tạo mới |
| *(chưa có)* | Memory Service | 🆕 Tạo mới |
| *(chưa có)* | Telemetry Service | 🆕 Tạo mới |
| *(chưa có)* | Go Monorepo `go.work` | 🆕 Infrastructure |

---

## Sprint Files

| File | Sprint | Effort |
|------|--------|--------|
| [SPRINT-1-foundation.md](./SPRINT-1-foundation.md) | Tuần 1–2 | ~15.5 ngày |
| [SPRINT-2-core-services.md](./SPRINT-2-core-services.md) | Tuần 3–5 | ~31 ngày |
| [SPRINT-3-content-services.md](./SPRINT-3-content-services.md) | Tuần 6–7 | ~35 ngày |
| [SPRINT-4-advanced.md](./SPRINT-4-advanced.md) | Tuần 8–10 | ~26 ngày |
| [DEV-T-api-gateway.md](./DEV-T-api-gateway.md) | Sprint 1 | 4.5 ngày |
| [DEV-T-project-service.md](./DEV-T-project-service.md) | Sprint 2 | 10 ngày |
| [DEV-T-agent-service.md](./DEV-T-agent-service.md) | Sprint 2 | 12 ngày |
| [DEV-T-design-system-service.md](./DEV-T-design-system-service.md) | Sprint 3 | 9 ngày |
| [DEV-T-config-service.md](./DEV-T-config-service.md) | Sprint 1 | 8 ngày |
| [DEV-T-skill-service.md](./DEV-T-skill-service.md) | Sprint 3 | 5 ngày |
| [DEV-T-mcp-service.md](./DEV-T-mcp-service.md) | Sprint 2 | 9 ngày |
| [DEV-T-media-service.md](./DEV-T-media-service.md) | Sprint 3 | 14 ngày |
| [DEV-T-memory-service.md](./DEV-T-memory-service.md) | Sprint 4 | 12.5 ngày |
| [DEV-T-plugin-service.md](./DEV-T-plugin-service.md) | Sprint 4 | 13.5 ngày |
| [DEV-T-telemetry-service.md](./DEV-T-telemetry-service.md) | Sprint 3 | 7 ngày |
| [DEV-T-monorepo-setup.md](./DEV-T-monorepo-setup.md) | Sprint 1 | 3 ngày |

---

## Definition of Done (mỗi service)

- [ ] Tất cả use cases được implement
- [ ] Unit test coverage > 70%
- [ ] gRPC handler integration tests pass
- [ ] `docker build` thành công
- [ ] `/health` endpoint trả về OK
- [ ] `go test -race` không có race condition
- [ ] README.md đầy đủ
- [ ] Docker Compose local với profile `od` chạy được
