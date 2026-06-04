# Open Design Backend — Task Index

> **Tổng số tasks**: 45 | **Tổng effort**: ~107.5 ngày | **Team**: 3 developers

---

## Quy ước Task ID

```
T-[Sprint][Component][Số thứ tự]
  Sprint:    1-4
  Component: GW(Gateway) PJ(Project) AG(Agent) DS(DesignSystem)
             MD(Media) PL(Plugin) MC(MCP) MM(Memory)
             SK(Skill) CF(Config) TL(Telemetry) IN(Infrastructure)
```

Ví dụ: `T-1IN-01` = Sprint 1, Infrastructure, task 01

---

## Sprint 1 — Foundation (Tuần 1-2)

| Task ID | Title | Effort | File |
|---------|-------|--------|------|
| T-1IN-01 | Setup Go Workspace (go.work) | 0.5 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1in-01) |
| T-1IN-02 | Tạo shared package: grpcutil | 0.5 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1in-02) |
| T-1IN-03 | Tạo shared package: dbutil | 0.5 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1in-03) |
| T-1IN-04 | Tạo shared package: crypto (AES-GCM) | 0.5 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1in-04) |
| T-1IN-05 | Tạo shared package: health | 0.5 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1in-05) |
| T-1CF-01 | Config Service: Project setup | 0.5 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1cf-01) |
| T-1CF-02 | Config Service: Domain + Crypto layer | 1 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1cf-02) |
| T-1CF-03 | Config Service: Postgres repos | 1 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1cf-03) |
| T-1CF-04 | Config Service: Use cases + gRPC server | 1.5 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1cf-04) |
| T-1CF-05 | Config Service: Docker + migrations | 0.5 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1cf-05) |
| T-1GW-01 | Gateway: Thêm gRPC clients cho OD services | 1 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1gw-01) |
| T-1GW-02 | Gateway: Agent SSE Proxy handler | 2 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1gw-02) |
| T-1GW-03 | Gateway: Thêm OD routes vào router.go | 1 ngày | [SPRINT-1-foundation.md](./SPRINT-1-foundation.md#t-1gw-03) |

---

## Sprint 2 — Core Services (Tuần 3-5)

| Task ID | Title | Effort | File |
|---------|-------|--------|------|
| T-2PJ-01 | Project Service: Domain entities mới | 1 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2pj-01) |
| T-2PJ-02 | Project Service: Conversation repo | 1 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2pj-02) |
| T-2PJ-03 | Project Service: Run repo | 1 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2pj-03) |
| T-2PJ-04 | Project Service: LiveArtifact repo | 0.5 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2pj-04) |
| T-2PJ-05 | Project Service: File store adapter | 1.5 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2pj-05) |
| T-2PJ-06 | Project Service: Use cases mới | 2 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2pj-06) |
| T-2PJ-07 | Project Service: Proto extensions + migrations | 1.5 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2pj-07) |
| T-2AG-01 | Agent Service: Domain model (Run, Event) | 1 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2ag-01) |
| T-2AG-02 | Agent Service: Redis Event Store | 2 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2ag-02) |
| T-2AG-03 | Agent Service: CLI Spawner | 2 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2ag-03) |
| T-2AG-04 | Agent Service: Claude Code adapter | 1 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2ag-04) |
| T-2AG-05 | Agent Service: BYOK refactor | 1.5 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2ag-05) |
| T-2AG-06 | Agent Service: gRPC server + use cases | 1.5 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2ag-06) |
| T-2AG-07 | Agent Service: Agent probe (ListAgents) | 0.5 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2ag-07) |
| T-2MC-01 | MCP Service: Di chuyển apps/ → services/ | 1 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2mc-01) |
| T-2MC-02 | MCP Service: Thêm gRPC clients | 1 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2mc-02) |
| T-2MC-03 | MCP Service: Open Design tools (10 tools) | 3 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2mc-03) |
| T-2MC-04 | MCP Service: Active context store | 0.5 ngày | [SPRINT-2-core.md](./SPRINT-2-core.md#t-2mc-04) |

---

## Sprint 3 — Content Services (Tuần 6-7)

| Task ID | Title | Effort | File |
|---------|-------|--------|------|
| T-3DS-01 | Design System Service: OD Catalog domain | 1 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3ds-01) |
| T-3DS-02 | Design System Service: Builtin Catalog loader | 1.5 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3ds-02) |
| T-3DS-03 | Design System Service: Postgres repos | 1 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3ds-03) |
| T-3DS-04 | Design System Service: Use cases + gRPC | 2.5 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3ds-04) |
| T-3SK-01 | Skill Service: Project setup + FS loader | 2 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3sk-01) |
| T-3SK-02 | Skill Service: Use cases + gRPC server | 2 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3sk-02) |
| T-3MD-01 | Media Service: Project setup + domain | 1.5 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3md-01) |
| T-3MD-02 | Media Service: DALL-E 3 provider | 1.5 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3md-02) |
| T-3MD-03 | Media Service: OpenAI TTS provider | 1 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3md-03) |
| T-3MD-04 | Media Service: Worker pool + use cases | 2 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3md-04) |
| T-3MD-05 | Media Service: gRPC server + storage | 1.5 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3md-05) |
| T-3TL-01 | Telemetry Service: NATS consumer + PostHog | 3 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3tl-01) |
| T-3TL-02 | Telemetry Service: Prometheus metrics | 2 ngày | [SPRINT-3-content.md](./SPRINT-3-content.md#t-3tl-02) |

---

## Sprint 4 — Advanced Features (Tuần 8-10)

| Task ID | Title | Effort | File |
|---------|-------|--------|------|
| T-4PL-01 | Plugin Service: Project setup + domain | 1.5 ngày | [SPRINT-4-advanced.md](./SPRINT-4-advanced.md#t-4pl-01) |
| T-4PL-02 | Plugin Service: Builtin catalog loader | 1 ngày | [SPRINT-4-advanced.md](./SPRINT-4-advanced.md#t-4pl-02) |
| T-4PL-03 | Plugin Service: Composio HTTP client | 2 ngày | [SPRINT-4-advanced.md](./SPRINT-4-advanced.md#t-4pl-03) |
| T-4PL-04 | Plugin Service: Subprocess sandbox | 1.5 ngày | [SPRINT-4-advanced.md](./SPRINT-4-advanced.md#t-4pl-04) |
| T-4PL-05 | Plugin Service: Use cases + gRPC server | 2 ngày | [SPRINT-4-advanced.md](./SPRINT-4-advanced.md#t-4pl-05) |
| T-4MM-01 | Memory Service: Project setup + domain | 1 ngày | [SPRINT-4-advanced.md](./SPRINT-4-advanced.md#t-4mm-01) |
| T-4MM-02 | Memory Service: OpenAI Embedder | 1 ngày | [SPRINT-4-advanced.md](./SPRINT-4-advanced.md#t-4mm-02) |
| T-4MM-03 | Memory Service: Ollama Embedder + Chunker | 1.5 ngày | [SPRINT-4-advanced.md](./SPRINT-4-advanced.md#t-4mm-03) |
| T-4MM-04 | Memory Service: PostgreSQL + pgvector repo | 2 ngày | [SPRINT-4-advanced.md](./SPRINT-4-advanced.md#t-4mm-04) |
| T-4MM-05 | Memory Service: SQLite + sqlite-vec repo | 1.5 ngày | [SPRINT-4-advanced.md](./SPRINT-4-advanced.md#t-4mm-05) |
| T-4MM-06 | Memory Service: Use cases + gRPC server | 2 ngày | [SPRINT-4-advanced.md](./SPRINT-4-advanced.md#t-4mm-06) |

---

## Dependency Graph

```
T-1IN-01 (go.work)
  └── T-1IN-02 (grpcutil)
  └── T-1IN-03 (dbutil)
  └── T-1IN-04 (crypto)
  └── T-1IN-05 (health)
        └── T-1CF-01 → T-1CF-02 → T-1CF-03 → T-1CF-04 → T-1CF-05
                └── T-1GW-01 → T-1GW-02 → T-1GW-03
                       └── T-2PJ-01 → ... → T-2PJ-07
                       └── T-2AG-01 → ... → T-2AG-07
                       └── T-2MC-01 → ... → T-2MC-04
                              └── T-3DS-01 → ... → T-3DS-04
                              └── T-3SK-01 → T-3SK-02
                              └── T-3MD-01 → ... → T-3MD-05
                              └── T-3TL-01 → T-3TL-02
                                     └── T-4PL-01 → ... → T-4PL-05
                                     └── T-4MM-01 → ... → T-4MM-06
```

## Trạng thái Legend

| Icon | Ý nghĩa |
|------|---------|
| ⬜ | Chưa bắt đầu |
| 🔵 | Đang thực hiện |
| ✅ | Hoàn thành |
| 🔴 | Bị chặn (blocked) |
| ⏸️ | Tạm hoãn |
