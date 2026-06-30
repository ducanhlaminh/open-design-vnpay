# 01 — Design Systems Integration

> **Source**: `design-systems/` — 150+ design systems  
> **Format**: `manifest.json` (v1 schema) + `DESIGN.md` + `tokens.css` + `components.html`  
> **Hiện trạng**: Chỉ được serve bởi daemon TypeScript, chưa có Go service chuẩn

---

## 1. Phân tích Hiện Trạng (Gap Analysis)

### Cấu trúc thực tế của `design-systems/<slug>/`

```
manifest.json          ← machine-readable entry (v1 schema đã có)
DESIGN.md              ← agent-facing design prose
tokens.css             ← CSS custom properties
components.html        ← optional component fixture
USAGE.md               ← optional agent guide
components.manifest.json ← optional component cache
assets/                ← brand assets
fonts/                 ← webfonts
preview/               ← static preview pages (colors, typography, spacing, buttons, app)
source/                ← importer evidence
```

### Thiếu trong `specs/services/04-design-system-service.md`

| Gap | Mô tả |
|-----|-------|
| ❌ **manifest.json schema** chưa được service đọc đúng | Service spec dùng `index.yaml`, thực tế file là `manifest.json` |
| ❌ **preview/** pages chưa được serve | Spec không đề cập multi-page preview |
| ❌ **components.html** endpoint chưa có | Spec thiếu `/api/design-systems/:id/components` route |
| ❌ **tokens.css** serving chưa rõ | Spec thiếu `/api/design-systems/:id/tokens.css` route |
| ❌ **Phân loại category** chưa map vào service | Spec thiếu category field trong List response |

### Thiếu trong `ui/src/api/domain/http.ts` (DesignSystemApiClient)

| Gap | Mô tả |
|-----|-------|
| ❌ `getPreviewPages()` — list multi-page preview | Chưa có |
| ❌ `getTokensCss()` — serve raw tokens.css | Chưa có |
| ❌ `getComponentsHtml()` — serve components.html | Chưa có |
| ❌ `listByCategory()` — filter by category | Chưa có |
| ❌ DS Picker component | Chưa có UI component |

---

## 2. Giải pháp: Service Layer (`04-design-system-service`)

### 2.1 Cập nhật BuiltinLoader — đọc `manifest.json` đúng format

```go
// infra/fs/builtin_loader.go
type Manifest struct {
    SchemaVersion string            `json:"schemaVersion"`
    ID            string            `json:"id"`
    Name          string            `json:"name"`
    Category      string            `json:"category"`
    Description   string            `json:"description"`
    Source        ManifestSource    `json:"source"`
    Files         ManifestFiles     `json:"files"`
    Preview       *ManifestPreview  `json:"preview,omitempty"`
    ImportMode    string            `json:"importMode,omitempty"`
}

type ManifestSource struct {
    Type   string `json:"type"`   // "bundled" | "imported"
    Origin string `json:"origin"` // "hand-authored" | "awesome-design-md" | ...
}

type ManifestFiles struct {
    Design     string `json:"design"`     // always "DESIGN.md"
    Tokens     string `json:"tokens"`     // always "tokens.css"
    Components string `json:"components"` // "components.html" or ""
}

type ManifestPreview struct {
    Dir   string         `json:"dir"`
    Pages []PreviewPage  `json:"pages"`
}

type PreviewPage struct {
    Path  string `json:"path"`
    Role  string `json:"role"`  // "colors"|"typography"|"spacing"|"buttons"|"app"
    Title string `json:"title"`
}

func (l *BuiltinLoader) LoadAll(ctx context.Context) ([]*domain.DesignSystem, error) {
    entries, _ := os.ReadDir(l.catalogPath)
    var result []*domain.DesignSystem

    for _, e := range entries {
        if !e.IsDir() || e.Name() == "_schema" { continue }

        slug := e.Name()
        dsDir := filepath.Join(l.catalogPath, slug)

        // Try manifest.json first (new format)
        manifestPath := filepath.Join(dsDir, "manifest.json")
        if ds, err := l.loadFromManifest(slug, dsDir, manifestPath); err == nil {
            result = append(result, ds)
            continue
        }

        // Fallback: parse DESIGN.md H1 + Category line (legacy format)
        if ds, err := l.loadFromDesignMD(slug, dsDir); err == nil {
            result = append(result, ds)
        }
    }
    return result, nil
}
```

### 2.2 Thêm HTTP routes trong API Gateway

```
GET  /api/design-systems                    → list (với ?category=&q=)
GET  /api/design-systems/:id                → detail + manifest
GET  /api/design-systems/:id/design.md      → serve DESIGN.md (raw text)
GET  /api/design-systems/:id/tokens.css     → serve tokens.css (CSS)
GET  /api/design-systems/:id/components     → serve components.html
GET  /api/design-systems/:id/preview        → list preview pages
GET  /api/design-systems/:id/preview/:role  → serve specific preview page HTML
GET  /api/design-systems/:id/assets/*path   → serve asset files
POST /api/design-systems                    → import (ZIP | URL | NPM)
DELETE /api/design-systems/:id              → delete (không xoá built-in)
GET  /api/design-systems/:id/job            → job status
```

### 2.3 Cập nhật gRPC proto

```protobuf
message DesignSystem {
    string id          = 1;
    string name        = 2;
    string category    = 3;  // ← THÊM
    string description = 4;
    string source_type = 5;  // "bundled" | "imported" | "generated"
    string status      = 6;
    string preview_url = 7;
    bool   has_tokens  = 8;  // ← THÊM
    bool   has_components = 9; // ← THÊM
    repeated PreviewPage preview_pages = 10; // ← THÊM
    google.protobuf.Timestamp created_at = 11;
}

message PreviewPage {
    string path  = 1;
    string role  = 2;
    string title = 3;
}

message DSContext {
    string tokens_css    = 1;
    string design_md     = 2;  // renamed from guidelines_md
    string name          = 3;
    string category      = 4;  // ← THÊM
    string components_html = 5; // ← THÊM (inject into agent context when needed)
}

// THÊM: Agent cần resolve DS context trước khi run
rpc GetDesignSystemContext(GetContextRequest) returns (DSContext);
rpc ListDesignSystemsByCategory(ByCategoryRequest) returns (ListResponse);
```

---

## 3. Giải pháp: UI Layer (`ui/src/`)

### 3.1 Cập nhật `HttpDesignSystemApiClient`

```typescript
// ui/src/api/domain/http.ts
export interface DesignSystemSummary {
  id: string;
  name: string;
  category: string;          // ← THÊM
  description?: string;
  sourceType: 'bundled' | 'imported' | 'generated';
  hasTokens: boolean;        // ← THÊM
  hasComponents: boolean;    // ← THÊM
  previewPages?: PreviewPage[]; // ← THÊM
}

export interface PreviewPage {
  path: string;
  role: 'colors' | 'typography' | 'spacing' | 'buttons' | 'app' | string;
  title: string;
}

// Methods mới cần thêm:
getTokensCssUrl(id: string): string       // → /api/design-systems/:id/tokens.css
getComponentsUrl(id: string): string      // → /api/design-systems/:id/components
getPreviewUrl(id: string, role?: string): string // → /api/design-systems/:id/preview/:role
getDesignMdUrl(id: string): string        // → /api/design-systems/:id/design.md
listByCategory(category: string): Promise<DesignSystemSummary[]>
```

### 3.2 Component mới: `<DesignSystemPicker>`

```
ui/src/components/DesignSystemPicker.tsx
```

- Dropdown grouped by category (AI & LLM, Developer Tools, Fintech...)
- Preview thumbnail (preview/app.html trong iframe)
- Quick tokens.css preview strip (màu sắc chính)
- Selected DS hiển thị badge trong chat toolbar

### 3.3 Component mới: `<DesignSystemDetail>`

```
ui/src/components/DesignSystemDetail.tsx
```

- Tabs: Preview / Tokens / Components / DESIGN.md
- Preview tab: iframe với dropdown chọn page (colors, typography, spacing...)
- Tokens tab: render tokens.css thành visual token grid
- Components tab: iframe với components.html

### 3.4 Cập nhật `DesignSystemsPage.tsx`

- Grid view: card mỗi DS với preview thumbnail + category badge
- Filter sidebar: by category
- Import button → ImportDialog (ZIP/URL)
- Click DS → DesignSystemDetail drawer

---

## 4. File Changes Summary

### Services (`specs/services/04-design-system-service.md`)

| Thay đổi | Chi tiết |
|----------|---------|
| `BuiltinLoader` | Đọc `manifest.json` thay `index.yaml` |
| Domain model | Thêm `Category`, `HasTokens`, `HasComponents`, `PreviewPages` |
| HTTP routes | Thêm `/tokens.css`, `/components`, `/preview/:role`, `/assets/*` |
| gRPC proto | Thêm fields category, previewPages vào DesignSystem message |
| `DSContext` | Thêm `componentsHtml`, rename `guidelinesMd` → `designMd` |

### UI (`ui/src/`)

| File | Thay đổi |
|------|---------|
| `api/domain/http.ts` | Thêm methods + types cho preview pages, tokens, components |
| `components/DesignSystemPicker.tsx` | Mới — grouped dropdown + thumbnail |
| `components/DesignSystemDetail.tsx` | Mới — tabbed detail view |
| `pages/DesignSystemsPage.tsx` | Implement: grid + filter + import |
