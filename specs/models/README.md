# Data Models — Open Design VNPay

> **Nguồn:** Trích xuất từ `packages/contracts/src/` (TypeScript canonical types), `packages/contracts/src/plugins/` (Zod schemas), và `prompt-templates/` (JSON schemas).

---

## Nhóm Model

| # | File | Mô tả |
|---|------|-------|
| 01 | [01-project-models.md](./01-project-models.md) | Project, Conversation, Deployment, Template |
| 02 | [02-chat-models.md](./02-chat-models.md) | ChatMessage, ChatRun, ChatAttachment, SSE Events |
| 03 | [03-artifact-models.md](./03-artifact-models.md) | ArtifactManifest, LiveArtifact, ProjectFile |
| 04 | [04-registry-models.md](./04-registry-models.md) | Agent, Skill, DesignSystem, DesignTemplate |
| 05 | [05-plugin-models.md](./05-plugin-models.md) | PluginManifest, InstalledPlugin, AppliedSnapshot |
| 06 | [06-memory-models.md](./06-memory-models.md) | MemoryEntry, MemoryExtraction, AutomationTemplate |
| 07 | [07-connector-mcp-models.md](./07-connector-mcp-models.md) | Connector, MCPServer, OAuth |
| 08 | [08-routine-orbit-models.md](./08-routine-orbit-models.md) | Routine, RoutineRun, OrbitConfig |
| 09 | [09-prompt-template-models.md](./09-prompt-template-models.md) | PromptTemplate (Image/Video) |
| 10 | [10-config-models.md](./10-config-models.md) | AppConfig, TelemetryPrefs, Comments |

---

## Sơ đồ quan hệ cấp cao

```
Project ───────── has many ─────── Conversations
   │                                     │
   │                                     └── has many ── ChatMessages
   │                                                          │
   ├── applies one ─── Skill                                  └── may produce ── ProjectFiles
   ├── applies one ─── DesignSystem
   ├── applies one ─── AppliedPluginSnapshot                  ChatMessage ── references ── LiveArtifact
   ├── has many ─── ProjectFiles (disk)
   ├── has many ─── Deployments
   └── has many ─── LiveArtifacts

Routine ── runs as ── RoutineRun ── creates ── Project (or reuses)

Memory ─── extracted from ── ChatMessages
       └── fed by ────────── Connectors

Plugin ── installed as ── InstalledPluginRecord
       └── applied as ──── AppliedPluginSnapshot ── linked to ── Project
```

---

## Nguồn (Source Files)

| File | Package |
|------|---------|
| `packages/contracts/src/api/projects.ts` | Canonical project types |
| `packages/contracts/src/api/chat.ts` | Chat, run, message types |
| `packages/contracts/src/api/artifacts.ts` | Artifact manifest |
| `packages/contracts/src/api/live-artifacts.ts` | Live artifact |
| `packages/contracts/src/api/registry.ts` | Agent, skill, design system |
| `packages/contracts/src/api/memory.ts` | Memory entries |
| `packages/contracts/src/api/automations.ts` | Automation templates, proposals |
| `packages/contracts/src/api/connectors.ts` | Connectors |
| `packages/contracts/src/api/mcp.ts` | MCP servers |
| `packages/contracts/src/api/routines.ts` | Routines |
| `packages/contracts/src/api/app-config.ts` | App config |
| `packages/contracts/src/api/comments.ts` | Preview comments |
| `packages/contracts/src/api/files.ts` | Project files |
| `packages/contracts/src/plugins/manifest.ts` | Plugin manifest (Zod) |
| `packages/contracts/src/plugins/installed.ts` | Installed plugin record |
| `packages/contracts/src/plugins/apply.ts` | Applied plugin snapshot |
| `packages/contracts/src/sse/chat.ts` | SSE event shapes |
| `prompt-templates/image/*.json` | Image prompt template schema |
| `prompt-templates/video/*.json` | Video prompt template schema |
