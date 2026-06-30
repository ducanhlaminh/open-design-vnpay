# 02 — Design Templates Integration

> **Source**: `design-templates/` — 110+ templates  
> **Format**: `SKILL.md` (YAML frontmatter + Markdown body) + `example.html` + optional `assets/`  
> **od.mode**: `prototype` | `deck` | `template` | `image` | `video` | `audio`

---

## 1. Phân tích Hiện Trạng (Gap Analysis)

### Cấu trúc thực tế của `design-templates/<slug>/`

```
SKILL.md          ← YAML frontmatter (name, description, triggers, od.*)
example.html      ← baked preview artifact
assets/           ← optional media files
examples/         ← optional derived variants
```

### SKILL.md frontmatter schema (thực tế)

```yaml
name: saas-landing
description: |
  Single-page SaaS landing with hero, features, pricing...
triggers:
  - "saas landing"
  - "marketing page"
od:
  mode: prototype          # prototype | deck | template | image | video | audio
  platform: desktop        # desktop | mobile | tablet
  scenario: marketing      # marketing | dashboard | document | ...
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: true
    sections: [color, typography, layout, components]
  craft:
    requires: [typography, color, anti-ai-slop, laws-of-ux]
  inputs:
    - name: product_name
      type: string
      required: true
    - name: tagline
      type: string
```

### Thiếu trong `specs/services/09-skill-service.md`

| Gap | Mô tả |
|-----|-------|
| ❌ **Design templates chưa có riêng service** | Spec `09-skill-service.md` chỉ nói về skills, không rõ design-templates |
| ❌ **Route `/api/design-templates`** chưa được định nghĩa | Cần tách registry riêng |
| ❌ **`od.mode` filtering** chưa có | Chưa thể filter theo `deck`, `prototype`, `image`, `video` |
| ❌ **`od.inputs`** chưa được expose qua API | Chưa thể render dynamic input form |
| ❌ **Deck navigation contract** chưa được validate | AGENTS.md có spec deck nav, service chưa enforce |

### Thiếu trong `ui/`

| Gap | Mô tả |
|-----|-------|
| ❌ **Gallery tab** trên HomePage chưa implement | Template browsing chưa có |
| ❌ **TemplateCard** component chưa có | Preview iframe + mode badge |
| ❌ **New Project từ template** chưa có | Flow: pick template → inject into new project |
| ❌ **`od.inputs` form** chưa render | Dynamic form cho template inputs |

---

## 2. Giải pháp: Service Layer

### 2.1 Tách Design Templates thành sub-registry trong Skill Service

Design templates chia sẻ `SkillSummary`/`SkillDetail` type với skills (như AGENTS.md đã ghi), nhưng cần riêng registry:

```go
// 09-skill-service: thêm TemplateRegistry bên cạnh SkillRegistry
type TemplateRegistry struct {
    catalogPath string // trỏ đến design-templates/
}

type TemplateSummary struct {
    ID          string     `json:"id"`
    Name        string     `json:"name"`
    Description string     `json:"description"`
    Mode        TemplMode  `json:"mode"`        // ← QUAN TRỌNG
    Platform    string     `json:"platform"`
    Scenario    string     `json:"scenario"`
    Triggers    []string   `json:"triggers"`
    HasExample  bool       `json:"hasExample"`
    ExampleUrl  string     `json:"exampleUrl"`
    Inputs      []Input    `json:"inputs"`
}

type TemplMode string
const (
    TemplModePrototype TemplMode = "prototype"
    TemplModeDeck      TemplMode = "deck"
    TemplModeTemplate  TemplMode = "template"
    TemplModeImage     TemplMode = "image"
    TemplModeVideo     TemplMode = "video"
    TemplModeAudio     TemplMode = "audio"
)

type Input struct {
    Name        string `json:"name"`
    Type        string `json:"type"`   // string | text | select | number | boolean
    Required    bool   `json:"required"`
    Default     string `json:"default,omitempty"`
    Options     []string `json:"options,omitempty"` // for select
    Placeholder string `json:"placeholder,omitempty"`
}
```

### 2.2 API Routes mới (thêm vào Gateway)

```
GET  /api/design-templates                   → list all (với ?mode=deck&q=)
GET  /api/design-templates/:id               → detail + inputs
GET  /api/design-templates/:id/example       → serve example.html
GET  /api/design-templates/:id/examples/:key → serve derived example
GET  /api/design-templates/:id/assets/*path  → serve assets
```

**Lưu ý từ AGENTS.md**: example HTML rewrite URL về `/api/skills/:id/...` — cần Gateway redirect để backward compat.

### 2.3 SKILL.md Parser — đọc YAML frontmatter

```go
// infra/fs/skill_loader.go
func parseSkillMD(content []byte) (*TemplateSummary, error) {
    // Strip --- YAML block ---
    // Unmarshal YAML frontmatter
    // Parse od.mode, od.inputs, od.platform, od.scenario
    // Parse triggers[]
}
```

### 2.4 Deck Navigation Validation (từ AGENTS.md spec)

Service phải validate `od.mode: deck` templates có đủ nav runtime:

```go
func (v *DeckValidator) Validate(exampleHTML []byte) error {
    // Check for ArrowRight/ArrowLeft key handlers
    // Check for .slide.active class
    // Check for navigation dots
    // Warn (không error) nếu thiếu
}
```

---

## 3. Giải pháp: UI Layer

### 3.1 Cập nhật `HttpTemplatesApiClient` (ui/src/api/supplement/http.ts)

```typescript
export interface TemplateSummary {
  id: string;
  name: string;
  description?: string;
  mode: 'prototype' | 'deck' | 'template' | 'image' | 'video' | 'audio';
  platform?: string;
  scenario?: string;
  triggers: string[];
  hasExample: boolean;
  exampleUrl: string;
  inputs: TemplateInput[];
}

export interface TemplateInput {
  name: string;
  type: 'string' | 'text' | 'select' | 'number' | 'boolean';
  required: boolean;
  default?: string;
  options?: string[];
  placeholder?: string;
}

// Rename existing methods, add:
listDesignTemplates(mode?: string): Promise<TemplateSummary[]>
getDesignTemplate(id: string): Promise<TemplateSummary>
getExampleUrl(id: string): string  // → /api/design-templates/:id/example
```

### 3.2 Mới: `<TemplateGallery>` Component

```
ui/src/components/TemplateGallery.tsx
```

**Layout**: Tabs theo `od.mode`:
- **All** | **Prototype** | **Deck** | **Document** | **Media**

**TemplateCard**:
- iframe preview (example.html trong sandbox)
- Mode badge (🖥 Prototype / 🎞 Deck / 📄 Document)
- Hover: "Use Template" button
- Click: `<TemplateDetailModal>`

### 3.3 Mới: `<TemplateDetailModal>`

```
ui/src/components/TemplateDetailModal.tsx
```

- Full preview iframe (non-sandboxed cho deck keyboard nav)
- `od.inputs` form render (dynamic từ template metadata)
- "Create Project with this template" CTA → POST /api/projects { templateId, inputs }

### 3.4 Cập nhật `HomePage.tsx`

```tsx
// Tabs: Recent Projects | Templates Gallery | Skills
<Tabs>
  <Tab id="projects">Recent Projects</Tab>
  <Tab id="templates">Templates</Tab>  {/* ← THÊM */}
  <Tab id="skills">Skills</Tab>
</Tabs>

{activeTab === 'templates' && <TemplateGallery />}
```

### 3.5 New Project Flow Integration

```tsx
// ProjectPage.tsx hoặc NewProjectDialog.tsx
// Step 1: Choose template (optional)
// Step 2: Fill od.inputs form
// Step 3: Choose design system
// Step 4: Create project → inject template + inputs into first message
```

---

## 4. File Changes Summary

### Services

| File | Thay đổi |
|------|---------|
| `specs/services/09-skill-service.md` | Thêm TemplateRegistry, routes `/api/design-templates/*` |
| `specs/services/01-api-gateway.md` | Thêm `/api/design-templates/*` routing |

### UI (`ui/src/`)

| File | Thay đổi |
|------|---------|
| `api/supplement/http.ts` | Mở rộng `HttpTemplatesApiClient` với TemplateSummary/Input types |
| `components/TemplateGallery.tsx` | Mới — tabbed gallery theo mode |
| `components/TemplateDetailModal.tsx` | Mới — preview + inputs form |
| `pages/HomePage.tsx` | Implement: tabs + TemplateGallery |

---

## 5. Template Categories (110 templates)

| Mode | Count | Examples |
|------|-------|---------|
| `prototype` | ~40 | saas-landing, mobile-app, dating-web, waitlist-page |
| `deck` | ~40 | html-ppt-*, guizang-ppt, simple-deck, kami-deck |
| `document` | ~15 | blog-post, invoice, finance-report, pm-spec |
| `image` | ~5 | image-poster, social-carousel, magazine-poster |
| `video` | ~5 | video-shortform, motion-frames, sprite-animation |
| `audio` | ~5 | audio-jingle |
