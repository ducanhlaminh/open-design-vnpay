# Integrated Assets — Overview

> **Mục đích**: Tài liệu này mô tả cách 3 asset directories cốt lõi được tích hợp vào kiến trúc microservices và React CSR SPA.

## 3 Asset Directories

| Directory | Số lượng | Bản chất |
|-----------|----------|---------|
| `design-systems/` | **150+ design systems** | `DESIGN.md` + `manifest.json` + `tokens.css` + `components.html` |
| `design-templates/` | **110+ templates** | `SKILL.md` + `example.html` — shapes, decks, prototypes |
| `prompt-templates/` | **46 image + 57 video** | `.json` — prompt metadata cho AI generation |

## Integration Map

```
design-systems/       ──→  04-design-system-service.go  (catalog gRPC)
                           SkillApiClient (ui/)
                           DesignSystemsPage.tsx (ui/)

design-templates/     ──→  09-skill-service.go  (design-templates catalog)
                           TemplatesApiClient (ui/)
                           HomePage.tsx  (Gallery tab)

prompt-templates/     ──→  05-media-service.go  (prompt library)
                           MediaApiClient (ui/)
                           MediaPage.tsx + MediaGenerationPanel.tsx
```

## Documents trong thư mục này

| File | Mô tả |
|------|-------|
| [01-design-systems-integration.md](./01-design-systems-integration.md) | 150+ DS → service + UI |
| [02-design-templates-integration.md](./02-design-templates-integration.md) | 110+ templates → service + UI |
| [03-prompt-templates-integration.md](./03-prompt-templates-integration.md) | 103 prompts → media service + UI |
| [04-api-contracts.md](./04-api-contracts.md) | REST/gRPC contracts cho tất cả 3 loại |
| [05-ui-components-plan.md](./05-ui-components-plan.md) | UI components cần bổ sung |
| [06-task-list.md](./06-task-list.md) | Task list thực thi |
