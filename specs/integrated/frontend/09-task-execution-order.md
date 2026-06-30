# 09 — Task Execution Order

> Thứ tự thực thi, dependency graph, và estimates cho toàn bộ frontend integration.

---

## Dependency Graph

```
[P0] Types + API  →  [P1] Shared Components  →  [P2] Pages
                  ↗
[P0] State Stores
```

### P0 — Foundation (không có dependency, làm trước)

| Task | File | Estimate |
|------|------|---------|
| **F-01** Cài `zustand` | `package.json` | 0.5h |
| **F-02** Upgrade `types.ts` | `types.ts` | 2h |
| **F-03** Upgrade `api/domain/http.ts` | `api/domain/http.ts` | 3h |
| **F-04** Thêm `api/supplement/http.ts` (PromptTemplate) | `supplement/http.ts` | 2h |
| **F-05** Thêm `HttpDesignTemplateApiClient` | `api/domain/http.ts` | 1.5h |
| **F-06** Cập nhật `api/projects/http.ts` | `projects/http.ts` | 0.5h |
| **F-07** Cập nhật `api/index.ts` | `index.ts` | 0.5h |
| **F-08** Tạo `store/appStore.ts` | `store/appStore.ts` | 2h |
| **F-09** Tạo `store/projectPageStore.ts` | `store/projectPageStore.ts` | 3h |
| **F-10** Tạo `store/designSystemStore.ts` | `store/designSystemStore.ts` | 1h |
| **F-11** Tạo `store/templateStore.ts` | `store/templateStore.ts` | 1h |

**P0 Total**: ~17h

---

### P1A — Shared Primitive Components (P0 → P1A)

| Task | File | Estimate |
|------|------|---------|
| **F-12** `<TokenStrip>` | `components/TokenStrip.tsx` | 3h |
| **F-13** `<MarkdownViewer>` | `components/MarkdownViewer.tsx` | 2h |
| **F-14** `<MarkdownMessage>` (streaming) | `components/MarkdownMessage.tsx` | 2h |
| **F-15** `<StatusDot>` + `<SpinnerIcon>` | `components/shared/` | 1h |

**P1A Total**: ~8h

---

### P1B — DS Components (P0 + P1A → P1B)

| Task | File | Estimate |
|------|------|---------|
| **F-16** `<DesignSystemPicker>` | `components/DesignSystemPicker.tsx` | 6h |
| **F-17** `<DSCard>` | `components/DSCard.tsx` | 4h |
| **F-18** `<DSDetailDrawer>` | `components/DSDetailDrawer.tsx` | 8h |

**P1B Total**: ~18h

---

### P1C — Template Components (P0 + P1A → P1C)

| Task | File | Estimate |
|------|------|---------|
| **F-19** `<TemplateCard>` | `components/TemplateCard.tsx` | 4h |
| **F-20** `<TemplateInputForm>` | `components/TemplateInputForm.tsx` | 3h |
| **F-21** `<TemplateDetailModal>` (needs P1B) | `components/TemplateDetailModal.tsx` | 6h |
| **F-22** `<TemplateGallery>` | `components/TemplateGallery.tsx` | 4h |

**P1C Total**: ~17h

---

### P1D — Media Components (P0 + P1A → P1D)

| Task | File | Estimate |
|------|------|---------|
| **F-23** `<PromptTemplateCard>` | `components/PromptTemplateCard.tsx` | 3h |
| **F-24** `<TemplateArgumentForm>` | `components/TemplateArgumentForm.tsx` | 2h |
| **F-25** `<PromptTemplateGallery>` | `components/PromptTemplateGallery.tsx` | 4h |
| **F-26** `<MediaTaskCard>` | `components/MediaTaskCard.tsx` | 3h |

**P1D Total**: ~12h

---

### P1E — Chat + Project Components (P0 + P1A + P1B → P1E)

| Task | File | Estimate |
|------|------|---------|
| **F-27** `<ChatToolbar>` | `components/ChatToolbar.tsx` | 3h |
| **F-28** `<ChatInput>` | `components/ChatInput.tsx` | 2h |
| **F-29** `<AssistantTurn>` | `components/AssistantTurn.tsx` | 4h |
| **F-30** `<ToolUseCard>` | `components/ToolUseCard.tsx` | 2h |
| **F-31** `<WorkspacePanel>` | `components/WorkspacePanel.tsx` | 3h |
| **F-32** `<SkillPicker>` | `components/SkillPicker.tsx` | 3h |
| **F-33** `<AgentSelector>` | `components/AgentSelector.tsx` | 2h |
| **F-34** `<FileWorkspace>` (T32) | `components/FileWorkspace.tsx` | 8h |
| **F-35** `<TranscriptView>` | `components/TranscriptView.tsx` | 2h |

**P1E Total**: ~29h

---

### P1F — Home + Project Dialogs (P0 + P1B + P1C → P1F)

| Task | File | Estimate |
|------|------|---------|
| **F-36** `<ProjectCard>` | `components/ProjectCard.tsx` | 3h |
| **F-37** `<NewProjectDialog>` | `components/NewProjectDialog.tsx` | 5h |
| **F-38** `<SkillCard>` + `<SkillGrid>` | `components/SkillGrid.tsx` | 3h |

**P1F Total**: ~11h

---

### P2 — Pages (cần tất cả P1 components)

| Task | File | Estimate |
|------|------|---------|
| **F-39** Implement `HomePage.tsx` | `pages/HomePage.tsx` | 6h |
| **F-40** Implement `ProjectPage.tsx` | `pages/ProjectPage.tsx` | 10h |
| **F-41** Implement `DesignSystemsPage.tsx` | `pages/DesignSystemsPage.tsx` | 6h |
| **F-42** Implement `MediaPage.tsx` (T37) | `pages/MediaPage.tsx` | 8h |
| **F-43** Implement `SkillsPage.tsx` | `pages/SkillsPage.tsx` | 4h |
| **F-44** Implement `RoutinesPage.tsx` | `pages/RoutinesPage.tsx` | 6h |
| **F-45** Implement `SettingsPage.tsx` (9 tabs) | `pages/SettingsPage.tsx` | 12h |
| **F-46** Implement `OnboardingPage.tsx` | `pages/OnboardingPage.tsx` | 4h |

**P2 Total**: ~56h

---

## Tổng kết

> **Cập nhật**: 2026-06-04 — **SPRINT HOÀN THÀNH** ✅ 46/46 tasks

| Phase | Tasks | Estimate | Actual | Status |
|-------|-------|---------|--------|--------|
| P0 Foundation | 11 | ~17h | ~14h | ✅ DONE |
| P1A Primitives | 4 | ~8h | ~6h | ✅ DONE |
| P1B DS Components | 3 | ~18h | ~14h | ✅ DONE |
| P1C Template Components | 4 | ~17h | ~12h | ✅ DONE |
| P1D Media Components | 4 | ~12h | ~9h | ✅ DONE |
| P1E Chat Components | 9 | ~29h | ~22h | ✅ DONE |
| P1F Home Dialogs | 3 | ~11h | ~8h | ✅ DONE |
| P2 Pages | 8 | ~56h | ~40h | ✅ DONE |
| **Total** | **46 tasks** | **~168h** | **~125h** | **✅ DONE** |

### TypeScript verification

```bash
cd ui/open-design-vnpay/ui
npx tsc --noEmit  # ✅ 0 errors (verified 2026-06-04)
```

---

## Sprint plan (8h/day)

```
Week 1: P0 + P1A + P1B (Foundation + DS system)
  Mon-Tue: F-01..F-11 (P0)
  Wed:     F-12..F-15 (P1A)
  Thu-Fri: F-16..F-18 (DS components)

Week 2: P1C + P1D + P1E (Templates + Media + Chat)
  Mon-Tue: F-19..F-22 (Template components)
  Wed:     F-23..F-26 (Media components)
  Thu-Fri: F-27..F-35 (Chat + Project components)

Week 3: P1F + P2 (Dialogs + Pages)
  Mon:     F-36..F-38 (Home dialogs)
  Tue:     F-39 (HomePage)
  Wed-Thu: F-40 (ProjectPage)
  Fri:     F-41..F-42 (DS + Media pages)

Week 4: Remaining pages + polish
  Mon:     F-43..F-46 (Skills, Routines, Settings, Onboarding)
  Tue-Fri: Testing + bug fixes + CSS polish
```

---

## Cập nhật `MASTER-TRACKER.md` khi hoàn thành

Sau mỗi task completed, cập nhật:

```markdown
- [x] F-01: Install zustand
- [/] F-02: Upgrade types.ts (in progress)
- [ ] F-03: Upgrade api/domain/http.ts
...
```

---

## CSS additions cần thiết (`index.css`)

```css
/* DS Picker */
.ds-picker-dropdown { ... }
.ds-picker-category { ... }

/* Template cards */
.template-card-hover { ... }

/* Media task status */
.status-dot-pending { background: #f5a623; }
.status-dot-processing { background: var(--color-accent); animation: pulse 1s infinite; }
.status-dot-done { background: #6ac47e; }
.status-dot-failed { background: #fa5050; }

/* Modal backdrop */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 1000; }

/* Drawer slide-in */
.drawer { animation: slideInRight 0.2s ease; }
@keyframes slideInRight {
  from { transform: translateX(20px); opacity: 0; }
  to   { transform: translateX(0);    opacity: 1; }
}

/* Spinner */
@keyframes spin { to { transform: rotate(360deg); } }
.spinner { animation: spin 0.7s linear infinite; }
```
