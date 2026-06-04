# DEV Sprint Task Summary

> **Cập nhật**: 2026-06-03  
> **Tổng effort**: ~107.5 ngày | 3 devs × ~36 ngày  
> **Sprint plan**: [DEV-INDEX.md](./DEV-INDEX.md)

---

## Sprint 1 — Foundation (Tuần 1–2)

| Task | Service | Effort | Assignee | Status |
|------|---------|--------|----------|--------|
| **DEV-12** | [Go Monorepo Setup](./DEV-T-monorepo-setup.md) | 3 ngày | Dev 1 | `[ ]` |
| **DEV-10** | [Config Service (new)](./DEV-T-config-service.md) | 8 ngày | Dev 2 | `[ ]` |
| **DEV-01** | [API Gateway — thêm OD routes](./DEV-T-api-gateway.md) | 4.5 ngày | Dev 3 | `[ ]` |

### DEV-12 Checklist (Go Monorepo)
- [ ] A01: `services/go.work` setup
- [ ] A02: Verify existing services build
- [ ] B01–B05: `shared/` packages (grpcutil, health, crypto, natsutil)
- [ ] C01–C03: Proto directory + buf.yaml + Makefile
- [ ] D01: Docker Compose `od` profile
- [ ] D02: Smoke test script

### DEV-01 Checklist (API Gateway)
- [ ] A01–A04: gRPC clients (agent, design-system, skill, config)
- [ ] B01: `agent_sse_proxy.go` (Critical — SSE streaming)
- [ ] B02: `run_proxy_handler.go`
- [ ] C01: Thêm OD routes vào `router.go`
- [ ] C02: Local access middleware
- [ ] C03: `config.yaml` upstreams
- [ ] D01: Unit tests
- [ ] D02: Integration smoke test

### DEV-10 Checklist (Config Service)
- [ ] A01–A02: Project setup + Config
- [ ] B01–B03: Domain entities + Repository interfaces
- [ ] C01: AES-256-GCM Encryptor (với tests!)
- [ ] D01–D04: PostgreSQL repos + migrations
- [ ] E01–E03: Use cases (Config, Secret, MediaConfig)
- [ ] F01–F03: gRPC proto + handler + HTTP handler
- [ ] G01–G03: Tests (crypto, usecase, integration)

---

## Sprint 2 — Core Services (Tuần 3–5)

| Task | Service | Effort | Assignee | Status |
|------|---------|--------|----------|--------|
| **DEV-02** | [Project Service](./DEV-T-project-service.md) | 10 ngày | Dev 1 | `[ ]` |
| **DEV-03** | [Agent Service](./DEV-T-agent-service.md) | 12 ngày | Dev 2 | `[ ]` |
| **DEV-07** | MCP Service | 9 ngày | Dev 3 | `[ ]` |

### DEV-02 Checklist (Project Service)
- [ ] A01–A05: Domain entities (Conversation, Message, Run, LiveArtifact, ProjectFile)
- [ ] B01–B02: Repository interfaces
- [ ] C01–C05: Use case interactors mới
- [ ] D01–D04: PostgreSQL repos mới
- [ ] E01: LocalFileStore
- [ ] F01: Proto extensions
- [ ] F02: Database migrations
- [ ] G01–G02: Tests

### DEV-03 Checklist (Agent Service)
- [ ] A01–A03: Domain layer (Run, RunEvent, AgentInfo, interfaces)
- [ ] B01–B02: Redis Event Store + Postgres RunRepo
- [ ] C01: CLISpawner core ⭐ critical
- [ ] C02: Claude Code Adapter
- [ ] C03: Tool Result Handler (stdin injection)
- [ ] D01–D02: BYOK refactor + APIProvider interface
- [ ] E01: AgentProbeUseCase (ListAgents)
- [ ] F01: Proto definition
- [ ] F02: gRPC Handler
- [ ] F03: Thêm gRPC server vào main.go
- [ ] G01–G03: Tests

---

## Sprint 3 — Content Services (Tuần 6–7)

| Task | Service | Effort | Assignee | Status |
|------|---------|--------|----------|--------|
| **DEV-04** | [Design System Service](./DEV-T-design-system-and-skill.md) | 9 ngày | Dev 1 | `[ ]` |
| **DEV-09** | [Skill Service (new)](./DEV-T-design-system-and-skill.md) | 5 ngày | Dev 1 | `[ ]` |
| **DEV-05** | Media Service | 14 ngày | Dev 2 | `[ ]` |
| **DEV-11** | Telemetry Service | 7 ngày | Dev 3 | `[ ]` |

### DEV-04 Checklist (Design System Service)
- [ ] A01–A02: OD Catalog domain entities + repository interfaces
- [ ] B01: BuiltinCatalogLoader (FS)
- [ ] C01–C03: Use cases (Catalog, Import, Job)
- [ ] D01: PostgreSQL repos + migrations
- [ ] E01–E03: gRPC proto + handler + register in main.go
- [ ] F01: Docker volume mount config
- [ ] G: Tests

### DEV-09 Checklist (Skill Service)
- [ ] A01: Project setup
- [ ] B01–B02: Skill domain + SkillLoader (FS)
- [ ] C01: CatalogUseCase + ContextUseCase
- [ ] D01–D02: gRPC proto + handler
- [ ] E: Tests + Docker

---

## Sprint 4 — Advanced Features (Tuần 8–10)

| Task | Service | Effort | Assignee | Status |
|------|---------|--------|----------|--------|
| **DEV-06** | Plugin Service | 13.5 ngày | Dev 1 | `[ ]` |
| **DEV-08** | Memory Service | 12.5 ngày | Dev 2 | `[ ]` |
| Integration testing | All services | — | Dev 3 | `[ ]` |

---

## Services chưa có Task Files chi tiết

> *(Sẽ tạo sau Sprint 2 validate xong)*

| Service | DEV Spec | Effort |
|---------|---------|--------|
| Media Service | [DEV-05](../../develop/DEV-05-media-service.md) | 14 ngày |
| Plugin Service | [DEV-06](../../develop/DEV-06-plugin-service.md) | 13.5 ngày |
| MCP Service | [DEV-07](../../develop/DEV-07-mcp-service.md) | 9 ngày |
| Memory Service | [DEV-08](../../develop/DEV-08-memory-service.md) | 12.5 ngày |
| Telemetry Service | [DEV-09-12](../../develop/DEV-09-12-remaining-services.md) | 7 ngày |

---

## Tổng Progress

```
Sprint 1 Foundation          [ ] 0/3 services done
Sprint 2 Core Services       [ ] 0/3 services done
Sprint 3 Content Services    [ ] 0/4 services done
Sprint 4 Advanced Features   [ ] 0/3 services done
─────────────────────────────────────────
TOTAL                        [ ] 0/13 services done
```
