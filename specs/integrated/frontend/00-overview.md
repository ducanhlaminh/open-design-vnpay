# Frontend Integration — Overview

> **Mục đích**: Giải pháp chi tiết nâng cấp `ui/` (React 18 CSR) để tích hợp 3 asset directories:  
> `design-systems/` (150+ DS), `design-templates/` (110+ templates), `prompt-templates/` (103 JSON)

---

## Hiện trạng `ui/src/`

```
api/
  client.ts              ✅ BaseApiClient + SSE
  domain/http.ts         ⚠️  DS client thiếu: category, preview pages, tokens/components URLs
  projects/http.ts       ✅
  runs/http.ts           ✅ 9 SSE event types
  supplement/http.ts     ⚠️  Templates: chưa có TemplateSummary/Input types
                         ⚠️  Media: chưa có PromptTemplate types
  index.ts               ✅ Registry

components/
  ArtifactViewer.tsx     ✅ (T31) sandboxed iframe + deploy
  DirectionPicker.tsx    ✅ (T29)
  ImportDialog.tsx       ✅ (T36)
  QuestionForm.tsx       ✅ (T28)
  TodoCard.tsx           ✅ (T30)

layouts/
  RootLayout.tsx         ✅ sidebar nav

pages/
  HomePage.tsx           ✅ (F-39) 3 tabs + search + NewProjectDialog
  ProjectPage.tsx        ✅ (F-40) 2-col chat+workspace, SSE streaming
  DesignSystemsPage.tsx  ✅ (F-41) category pills, DSCard grid, DSDetailDrawer
  SkillsPage.tsx         ✅ (F-43) SkillGrid + create project navigation
  RoutinesPage.tsx       ✅ (F-44) routines list + empty state
  MediaPage.tsx          ✅ (F-42) surface tabs, mode switch, PromptTemplateGallery
  SettingsPage.tsx       ✅ (F-45) 9-tab sidebar, General+APIKeys+Appearance
  OnboardingPage.tsx     ✅ (F-46) 4-step flow + completeOnboarding()
```

## Documents trong thư mục này

| File | Mô tả |
|------|-------|
| [01-api-layer-upgrades.md](./01-api-layer-upgrades.md) | Nâng cấp tất cả API clients |
| [02-types-upgrades.md](./02-types-upgrades.md) | Cập nhật `types.ts` |
| [03-design-systems-ui.md](./03-design-systems-ui.md) | Components + Page cho DS |
| [04-design-templates-ui.md](./04-design-templates-ui.md) | Components + Page cho Templates |
| [05-prompt-templates-media-ui.md](./05-prompt-templates-media-ui.md) | Components + Page cho Media |
| [06-project-page-chat.md](./06-project-page-chat.md) | ProjectPage với chat + artifact |
| [07-home-page.md](./07-home-page.md) | HomePage tổng hợp |
| [08-settings-page.md](./08-settings-page.md) | SettingsPage (9 tabs) |
| [09-state-management.md](./09-state-management.md) | Global state với Zustand |
| [10-task-execution-order.md](./10-task-execution-order.md) | Thứ tự thực thi + estimates |
