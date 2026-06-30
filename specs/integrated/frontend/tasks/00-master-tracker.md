# MASTER TRACKER — Frontend Integration Tasks

> **Tổng**: 46 tasks | **Estimate**: ~168h | **Sprint**: 4 tuần  
> Cập nhật status khi thực thi: `[ ]` → `[/]` → `[x]`
>
> **🎉 SPRINT HOÀN THÀNH** — 46/46 tasks ✅ | TypeScript: 0 errors (verified 2026-06-04)

---

## Progress Overview

| Phase | Tasks | Estimate | Actual | Status |
|-------|-------|---------|--------|--------|
| P0 Foundation | 11 | ~17h | ~14h | ✅ DONE |
| P1A Primitive Components | 4 | ~8h | ~6h | ✅ DONE |
| P1B DS Components | 3 | ~18h | ~14h | ✅ DONE |
| P1C Template Components | 4 | ~17h | ~12h | ✅ DONE |
| P1D Media Components | 4 | ~12h | ~9h | ✅ DONE |
| P1E Chat + Project Components | 9 | ~29h | ~22h | ✅ DONE |
| P1F Home + Project Dialogs | 3 | ~11h | ~8h | ✅ DONE |
| P2 Pages | 8 | ~56h | ~40h | ✅ DONE |
| **Total** | **46** | **~168h** | **~125h** | **✅ DONE** |

---

## P0 — Foundation (làm trước tiên, không có dependency)

- [x] [F-01] Cài `zustand` vào package.json
- [x] [F-02] Upgrade `src/types.ts` — DesignSystemSummary v2, DesignTemplate, PromptTemplate, MediaJobSummary, CreateProjectRequest types
- [x] [F-03] Upgrade `src/api/domain/http.ts` — DS client v2, thêm HttpDesignTemplateApiClient
- [x] [F-04] Thêm PromptTemplate methods vào `src/api/supplement/http.ts`
- [x] [F-05] Thêm `HttpDesignTemplateApiClient` export vào domain
- [x] [F-06] Cập nhật `src/api/projects/http.ts` — createProjectFromTemplate, readFile, writeFile, getTranscriptUrl
- [x] [F-07] Cập nhật `src/api/index.ts` — thêm `designTemplates` registry
- [x] [F-08] Tạo `src/store/appStore.ts`
- [x] [F-09] Tạo `src/store/projectPageStore.ts`
- [x] [F-10] Tạo `src/store/designSystemStore.ts`
- [x] [F-11] Tạo `src/store/templateStore.ts`

---

## P1A — Shared Primitive Components (P0 → P1A)

- [x] [F-12] Tạo `src/components/TokenStrip.tsx`
- [x] [F-13] Tạo `src/components/MarkdownViewer.tsx`
- [x] [F-14] Tạo `src/components/MarkdownMessage.tsx` (streaming)
- [x] [F-15] Tạo `src/components/shared/StatusDot.tsx` + `SpinnerIcon.tsx`

---

## P1B — DS Components (P0 + P1A → P1B)

- [x] [F-16] Tạo `src/components/DesignSystemPicker.tsx`
- [x] [F-17] Tạo `src/components/DSCard.tsx`
- [x] [F-18] Tạo `src/components/DSDetailDrawer.tsx` (complex)

---

## P1C — Template Components (P0 + P1A → P1C)

- [x] [F-19] Tạo `src/components/TemplateCard.tsx`
- [x] [F-20] Tạo `src/components/TemplateInputForm.tsx`
- [x] [F-21] Tạo `src/components/TemplateDetailModal.tsx`
- [x] [F-22] Tạo `src/components/TemplateGallery.tsx`

---

## P1D — Media Components (P0 + P1A → P1D)

- [x] [F-23] Tạo `src/components/PromptTemplateCard.tsx`
- [x] [F-24] Tạo `src/components/TemplateArgumentForm.tsx`
- [x] [F-25] Tạo `src/components/PromptTemplateGallery.tsx`
- [x] [F-26] Tạo `src/components/MediaTaskCard.tsx`

---

## P1E — Chat + Project Components (P0 + P1A + P1B → P1E)

- [x] [F-27] Tạo `src/components/ChatToolbar.tsx`
- [x] [F-28] Tạo `src/components/ChatInput.tsx`
- [x] [F-29] Tạo `src/components/AssistantTurn.tsx`
- [x] [F-30] Tạo `src/components/ToolUseCard.tsx`
- [x] [F-31] Tạo `src/components/WorkspacePanel.tsx`
- [x] [F-32] Tạo `src/components/SkillPicker.tsx`
- [x] [F-33] Tạo `src/components/AgentSelector.tsx`
- [x] [F-34] Tạo `src/components/FileWorkspace.tsx`
- [x] [F-35] Tạo `src/components/TranscriptView.tsx`

---

## P1F — Home + Project Dialogs (P0 + P1B + P1C → P1F)

- [x] [F-36] Tạo `src/components/ProjectCard.tsx`
- [x] [F-37] Tạo `src/components/NewProjectDialog.tsx`
- [x] [F-38] Tạo `src/components/SkillGrid.tsx` (+ SkillCard inline)

---

## P2 — Pages (tất cả P1 components xong → P2)

- [x] [F-39] Implement `src/pages/HomePage.tsx` — 3 tabs, search, empty state, NewProjectDialog
- [x] [F-40] Implement `src/pages/ProjectPage.tsx` — 2-col layout, SSE streaming, AbortController stop
- [x] [F-41] Implement `src/pages/DesignSystemsPage.tsx` — category pills, search, DSCard grid, DSDetailDrawer, ImportDialog
- [x] [F-42] Implement `src/pages/MediaPage.tsx` — surface tabs (image/video/audio), mode switch, PromptTemplateGallery, 3s auto-refresh
- [x] [F-43] Implement `src/pages/SkillsPage.tsx` — SkillGrid với onCreate navigation
- [x] [F-44] Implement `src/pages/RoutinesPage.tsx` — routines list với empty state
- [x] [F-45] Implement `src/pages/SettingsPage.tsx` — 9-tab sidebar, General + API Keys + Appearance priority
- [x] [F-46] Implement `src/pages/OnboardingPage.tsx` — 4-step flow, DS picker, skip options, completeOnboarding()

---

## Verify

```bash
cd ui/open-design-vnpay/ui
npx tsc --noEmit  # ✅ 0 errors (verified 2026-06-04)
```

---

## Quick Reference

| Task file | Tasks | Phạm vi |
|-----------|-------|---------|
| [F00-foundation.md](./F00-foundation.md) | F-01..F-07 | zustand + API layer |
| [F01-stores.md](./F01-stores.md) | F-08..F-11 | Zustand stores |
| [F02-primitives.md](./F02-primitives.md) | F-12..F-15 | TokenStrip, Markdown, StatusDot |
| [F03-ds-components.md](./F03-ds-components.md) | F-16..F-18 | DS Picker, DS Card, DS Drawer |
| [F04-template-components.md](./F04-template-components.md) | F-19..F-22 | Template cards, form, gallery |
| [F05-media-components.md](./F05-media-components.md) | F-23..F-26 | Prompt template, media task |
| [F06-chat-components.md](./F06-chat-components.md) | F-27..F-35 | Chat toolbar, input, turns |
| [F07-dialog-components.md](./F07-dialog-components.md) | F-36..F-38 | Project card, dialogs, skill grid |
| [F08-pages.md](./F08-pages.md) | F-39..F-46 | All 8 pages |
