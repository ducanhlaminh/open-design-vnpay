# 05 — UI Components Plan

> Components cần bổ sung trong `ui/src/components/` để tích hợp 3 asset directories.

---

## Design Systems UI Components

### `<DesignSystemPicker>` — Dropdown có nhóm

**File**: `ui/src/components/DesignSystemPicker.tsx`  
**Dùng ở**: Chat toolbar, New Project dialog, Project settings

```
Props:
  selectedId?: string
  onSelect: (id: string) => void
  disabled?: boolean

Behavior:
  - Fetch /api/design-systems và group theo category
  - Render Combobox với optgroup cho mỗi category
  - Preview strip: hiển thị 4 màu chính từ tokens.css (inlined)
  - Khi DS được chọn: hiển thị DS name badge trong toolbar
```

**Grouped categories**:
```
── Starter (default, warm-editorial, atelier-zero, kami)
── AI & LLM (claude, openai, mistral-ai, x-ai, ...)
── Developer Tools (cursor, raycast, vercel, ...)
── Productivity & SaaS (notion, linear-app, cal, ...)
── Fintech & Crypto (stripe, coinbase, revolut, ...)
── ... etc
```

---

### `<DesignSystemDetail>` — Detail drawer/page

**File**: `ui/src/components/DesignSystemDetail.tsx`  
**Dùng ở**: DesignSystemsPage (click card → open)

```
Props:
  designSystemId: string
  onClose: () => void

Tabs:
  1. Preview — iframe dropdown (colors | typography | spacing | buttons | app)
  2. Tokens  — visual token grid từ tokens.css
  3. Components — iframe với components.html
  4. Spec — rendered DESIGN.md markdown
```

---

### `<DesignSystemCard>` — Grid card

**File**: `ui/src/components/DesignSystemCard.tsx`  
**Dùng ở**: DesignSystemsPage grid

```
Props:
  ds: DesignSystemSummary
  onView: () => void
  onSelect: () => void

Layout:
  - Preview thumbnail (preview/app.html trong iframe mini 200x120)
  - Name + Category badge
  - Source chip (bundled | imported | generated)
  - "Select" button (active state khi ds === selectedDesignSystemId)
```

---

### `<TokenStrip>` — Visual color/font preview

**File**: `ui/src/components/TokenStrip.tsx`  
**Dùng ở**: DesignSystemPicker dropdown, DesignSystemCard

```
Props:
  tokensUrl: string  // /api/design-systems/:id/tokens.css

Behavior:
  - Fetch tokens.css
  - Parse --color-* CSS variables
  - Render color swatches strip (5-8 màu)
  - Parse font-family fallbacks
  - Render font name
```

---

## Design Templates UI Components

### `<TemplateGallery>` — Gallery có tab theo mode

**File**: `ui/src/components/TemplateGallery.tsx`  
**Dùng ở**: HomePage (Templates tab), NewProjectDialog

```
Props:
  onUseTemplate: (template: TemplateSummary) => void
  filterMode?: TemplMode

Tabs: All | Prototype | Deck | Document | Media

Layout:
  - Masonry grid (3 cols desktop, 2 cols tablet, 1 col mobile)
  - Infinite scroll hoặc pagination
  - Search box
```

---

### `<TemplateCard>` — Gallery card

**File**: `ui/src/components/TemplateCard.tsx`

```
Props:
  template: TemplateSummary
  onUse: () => void

Layout:
  - example.html trong iframe (sandboxed, lazy-loaded)
  - Mode badge: 🖥 Prototype / 🎞 Deck / 📄 Document
  - Platform chip (Desktop | Mobile)
  - "Use Template" button (hover)
```

**Deck cards** phải resize iframe cho preview (fixed 300x225px).

---

### `<TemplateDetailModal>` — Full preview + inputs form

**File**: `ui/src/components/TemplateDetailModal.tsx`

```
Props:
  templateId: string
  onClose: () => void
  onCreateProject: (templateId: string, inputs: Record<string, string>) => void

Sections:
  1. Full preview iframe (deckNavigation: không sandbox keyboard)
  2. Template info (name, description, mode, platform, triggers)
  3. Input form (od.inputs rendered từ TemplateInput[])
  4. Design System picker (nếu requires: true)
  5. CTA: "Create Project"
```

---

### `<TemplateInputForm>` — Dynamic input form từ od.inputs

**File**: `ui/src/components/TemplateInputForm.tsx`

```
Props:
  inputs: TemplateInput[]
  values: Record<string, string>
  onChange: (values: Record<string, string>) => void

Renders:
  - type: string  → <input type="text">
  - type: text    → <textarea>
  - type: select  → <select> với options
  - type: number  → <input type="number">
  - type: boolean → <input type="checkbox">
  - required      → * indicator
  - default       → placeholder / defaultValue
```

---

## Prompt Templates UI Components

### `<MediaGenerationPanel>` (T37) — Main panel

**File**: `ui/src/components/MediaGenerationPanel.tsx`  
**Dùng ở**: MediaPage

```
Props:
  projectId: string

Tabs:
  1. Image
  2. Video
  3. Audio (basic — text-to-speech via ElevenLabs)

Image Tab Modes:
  A. Direct Prompt → input + model/aspect selectors + Generate
  B. Use Template  → PromptTemplateGallery (image surface)
                   → TemplateArgumentForm
                   → Generate

Video Tab Modes:
  A. Direct Prompt → input + model selector + Generate
  B. Use Template  → PromptTemplateGallery (video surface)
                   → TemplateArgumentForm
                   → Generate
  C. Hyperframes   → HTML input + effect selector + Generate
```

---

### `<PromptTemplateGallery>` — Template browser cho media

**File**: `ui/src/components/PromptTemplateGallery.tsx`

```
Props:
  surface: 'image' | 'video'
  onSelect: (template: PromptTemplateSummary) => void

Layout:
  - Category filter pills (Profile Avatar | Social Media | Infographic | ...)
  - Masonry grid với PromptTemplateCard
  - Search
```

---

### `<PromptTemplateCard>` — Card với preview image

**File**: `ui/src/components/PromptTemplateCard.tsx`

```
Props:
  template: PromptTemplateSummary
  onUse: () => void

Layout:
  - previewImageUrl → <img loading="lazy">
  - title + category
  - model badge (gpt-image-2 / seedance-2.0 / ...)
  - aspect chip (1:1 / 16:9 / ...)
  - argumentCount badge (e.g. "3 inputs")
```

---

### `<TemplateArgumentForm>` — Argument fill form

**File**: `ui/src/components/TemplateArgumentForm.tsx`  
**Dùng chung cho cả design templates và prompt templates**

```
Props:
  args: Array<{ name: string; default: string }>
  values: Record<string, string>
  onChange: (values: Record<string, string>) => void

Renders:
  - Mỗi arg → label + input (type=text)
  - default → placeholder
  - Khi value trống → sẽ dùng default khi generate
```

---

### `<MediaTaskCard>` — Task status card

**File**: `ui/src/components/MediaTaskCard.tsx`

```
Props:
  task: MediaTask
  onRefresh: () => void

States:
  pending    → skeleton spinner
  processing → progress animation + "Generating..."
  ready      → thumbnail/video preview + download button
  failed     → error message + retry
```

---

## Component Dependency Map

```
HomePage
  └── TemplateGallery
        └── TemplateCard → example.html iframe
              └── TemplateDetailModal
                    ├── TemplateInputForm
                    └── DesignSystemPicker

DesignSystemsPage
  ├── DesignSystemCard → TokenStrip
  └── DesignSystemDetail
        ├── iframe (preview pages)
        ├── iframe (components.html)
        └── Markdown renderer (DESIGN.md)

MediaPage
  └── MediaGenerationPanel
        ├── PromptTemplateGallery
        │     └── PromptTemplateCard
        ├── TemplateArgumentForm
        └── MediaTaskCard

ChatPanel (trong ProjectPage)
  └── DesignSystemPicker (toolbar)
```

---

## Task Mapping

| Component | Task | Priority |
|-----------|------|---------|
| DesignSystemPicker | T-DS-01 | HIGH — cần cho chat |
| DesignSystemCard | T-DS-02 | HIGH |
| DesignSystemDetail | T-DS-03 | MEDIUM |
| TokenStrip | T-DS-04 | LOW |
| TemplateGallery | T-TM-01 | HIGH — HomePage |
| TemplateCard | T-TM-02 | HIGH |
| TemplateDetailModal | T-TM-03 | MEDIUM |
| TemplateInputForm | T-TM-04 | MEDIUM |
| MediaGenerationPanel | T37 | HIGH |
| PromptTemplateGallery | T-PT-01 | HIGH |
| PromptTemplateCard | T-PT-02 | MEDIUM |
| TemplateArgumentForm | T-PT-03 | MEDIUM |
| MediaTaskCard | T-PT-04 | MEDIUM |
