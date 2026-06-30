# 03 — Prompt Templates Integration

> **Source**: `prompt-templates/image/` (46 JSON) + `prompt-templates/video/` (57 JSON)  
> **Format**: JSON — `id`, `surface`, `title`, `summary`, `category`, `model`, `aspect`, `prompt`, `previewImageUrl`, `source`  
> **Tổng**: 103 prompt templates

---

## 1. Phân tích Hiện Trạng (Gap Analysis)

### Cấu trúc JSON thực tế

```json
{
  "id": "3d-stone-staircase-evolution-infographic",
  "surface": "image",
  "title": "3D Stone Staircase Evolution Infographic",
  "summary": "Transforms a flat evolutionary timeline into a realistic 3D stone staircase infographic.",
  "category": "Infographic",
  "tags": ["3d-render"],
  "model": "gpt-image-2",
  "aspect": "1:1",
  "prompt": "{ ... JSON prompt with {argument} placeholders ... }",
  "previewImageUrl": "https://cms-assets.youmind.com/...",
  "source": {
    "repo": "YouMind-OpenLab/awesome-gpt-image-2",
    "license": "CC-BY-4.0",
    "author": "...",
    "url": "..."
  }
}
```

**Quan trọng**: `prompt` field chứa `{argument name="..." default="..."}` placeholders → runtime phải parse và render thành form inputs.

### Prompt Template Categories

**Image (46 templates)**:
| Category | Count |
|----------|-------|
| Profile Avatar | ~15 |
| Social Media Post | ~8 |
| Game Screenshot/UI | ~5 |
| Infographic | ~3 |
| Other | ~15 |

**Video (57 templates)**:
| Category | Count |
|----------|-------|
| Hyperframes HTML-to-video | ~15 |
| Cinematic sequences | ~12 |
| Character animation | ~8 |
| Seedance 2.0 | ~5 |
| Other | ~17 |

### Thiếu trong `specs/services/05-media-service.md`

| Gap | Mô tả |
|-----|-------|
| ❌ **Prompt template library chưa có** | `05-media-service.md` không mention prompt-templates |
| ❌ **`{argument}` parser chưa được spec** | Phải parse template arguments để render input form |
| ❌ **`/api/prompt-templates` route chưa có** | Chưa có endpoint nào |
| ❌ **Model routing từ template** chưa có | Template chỉ định model (gpt-image-2, seedance-2.0...) |

### Thiếu trong `ui/`

| Gap | Mô tả |
|-----|-------|
| ❌ `MediaApiClient` không có `listPromptTemplates()` | Chưa có method |
| ❌ `MediaPage.tsx` chưa implement | Chỉ là placeholder |
| ❌ `MediaGenerationPanel` (T37) chưa có | Task còn open |
| ❌ Argument form renderer chưa có | `{argument name=...}` parsing chưa có |
| ❌ Preview image display chưa có | `previewImageUrl` chưa dùng |

---

## 2. Giải pháp: Service Layer (`05-media-service`)

### 2.1 Prompt Template Domain Model

```go
// domain/prompt_template.go
type PromptTemplate struct {
    ID             string            `json:"id"`
    Surface        Surface           `json:"surface"`   // "image" | "video"
    Title          string            `json:"title"`
    Summary        string            `json:"summary"`
    Category       string            `json:"category"`
    Tags           []string          `json:"tags"`
    Model          string            `json:"model"`     // e.g. "gpt-image-2"
    Aspect         string            `json:"aspect"`    // "1:1" | "16:9" etc.
    RawPrompt      string            `json:"prompt"`    // may contain {argument ...}
    Arguments      []TemplateArg     `json:"-"`         // parsed from RawPrompt
    PreviewImageURL string           `json:"previewImageUrl"`
    Source         TemplateSource    `json:"source"`
}

type Surface string
const (
    SurfaceImage Surface = "image"
    SurfaceVideo Surface = "video"
)

type TemplateArg struct {
    Name    string // from {argument name="..."}
    Default string // from {argument ... default="..."}
}

type TemplateSource struct {
    Repo    string `json:"repo"`
    License string `json:"license"`
    Author  string `json:"author,omitempty"`
    URL     string `json:"url,omitempty"`
}
```

### 2.2 Argument Parser

```go
// infra/prompt/argument_parser.go
import "regexp"

var argPattern = regexp.MustCompile(
    `\{argument\s+name="([^"]+)"(?:\s+default="([^"]*)")?\}`,
)

// ParseArguments extracts {argument name="x" default="y"} placeholders
func ParseArguments(rawPrompt string) []TemplateArg {
    matches := argPattern.FindAllStringSubmatch(rawPrompt, -1)
    seen := map[string]bool{}
    var args []TemplateArg
    for _, m := range matches {
        name := m[1]
        if seen[name] { continue }
        seen[name] = true
        args = append(args, TemplateArg{Name: name, Default: m[2]})
    }
    return args
}

// FillArguments substitutes user-supplied values into the prompt
func FillArguments(rawPrompt string, values map[string]string) string {
    return argPattern.ReplaceAllStringFunc(rawPrompt, func(match string) string {
        sub := argPattern.FindStringSubmatch(match)
        name, def := sub[1], sub[2]
        if v, ok := values[name]; ok && v != "" {
            return v
        }
        return def
    })
}
```

### 2.3 PromptTemplateLoader

```go
// infra/fs/prompt_template_loader.go
type PromptTemplateLoader struct {
    imageDir string // prompt-templates/image/
    videoDir string // prompt-templates/video/
}

func (l *PromptTemplateLoader) LoadAll() ([]*domain.PromptTemplate, error) {
    var all []*domain.PromptTemplate
    for _, dir := range []string{l.imageDir, l.videoDir} {
        entries, _ := os.ReadDir(dir)
        for _, e := range entries {
            if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") { continue }
            data, _ := os.ReadFile(filepath.Join(dir, e.Name()))
            var t domain.PromptTemplate
            json.Unmarshal(data, &t)
            t.Arguments = prompt.ParseArguments(t.RawPrompt)
            all = append(all, &t)
        }
    }
    return all, nil
}
```

### 2.4 API Routes mới (thêm vào Gateway)

```
GET /api/prompt-templates                → list (với ?surface=image|video&category=&model=&q=)
GET /api/prompt-templates/:id            → detail + parsed arguments
GET /api/prompt-templates/:id/preview    → redirect to previewImageUrl

POST /api/media/generate-from-template   → {
    templateId: string,
    values: Record<string, string>,  // argument fill values
    projectId: string,
    outputAspect?: string            // override aspect
}
```

### 2.5 Generate from Template Use Case

```go
// usecase/generate_from_template.go
func (uc *GenerateFromTemplateUseCase) Execute(ctx context.Context, req GenerateFromTemplateRequest) (*MediaTask, error) {
    // 1. Load template
    tmpl, err := uc.repo.GetPromptTemplate(ctx, req.TemplateID)

    // 2. Fill arguments with user values
    filledPrompt := prompt.FillArguments(tmpl.RawPrompt, req.Values)

    // 3. Route to correct model
    switch tmpl.Surface {
    case domain.SurfaceImage:
        return uc.imageGen.Generate(ctx, ImageGenRequest{
            Prompt: filledPrompt, Model: tmpl.Model, Aspect: tmpl.Aspect,
        })
    case domain.SurfaceVideo:
        return uc.videoGen.Generate(ctx, VideoGenRequest{
            Prompt: filledPrompt, Model: tmpl.Model,
        })
    }
}
```

---

## 3. Giải pháp: UI Layer

### 3.1 Mở rộng `HttpMediaApiClient` (ui/src/api/supplement/http.ts)

```typescript
export interface PromptTemplate {
  id: string;
  surface: 'image' | 'video';
  title: string;
  summary: string;
  category: string;
  tags: string[];
  model: string;
  aspect: string;
  arguments: TemplateArgument[];   // ← parsed từ service
  previewImageUrl?: string;
  source: {
    repo: string;
    license: string;
    author?: string;
    url?: string;
  };
}

export interface TemplateArgument {
  name: string;
  default: string;
}

export interface GenerateFromTemplateRequest {
  templateId: string;
  values: Record<string, string>;
  projectId: string;
  outputAspect?: string;
}

// Methods mới:
listPromptTemplates(surface?: 'image' | 'video', category?: string): Promise<PromptTemplate[]>
getPromptTemplate(id: string): Promise<PromptTemplate>
generateFromTemplate(req: GenerateFromTemplateRequest): Promise<MediaTask>
```

### 3.2 Mới: `<MediaGenerationPanel>` (T37)

```
ui/src/components/MediaGenerationPanel.tsx
```

**Tabs**: Image | Video

**Image Tab**:
- Mode selector: Direct Prompt | Use Template
- Template browser: grid với previewImageUrl thumbnail
- Template detail: argument form (parsed `{argument}`)
- Model selector (gpt-image-2, seedance, etc.)
- Aspect ratio selector
- Generate button → poll MediaTask

**Video Tab**:
- Mode selector: Direct Prompt | Use Template | Hyperframes
- Hyperframes sub-section: HTML → video conversion
- Template browser: phân loại (Cinematic / Animation / Hyperframes)
- Argument form

### 3.3 `<PromptTemplateCard>` Component

```
ui/src/components/PromptTemplateCard.tsx
```

```tsx
function PromptTemplateCard({ template, onUse }: Props) {
  return (
    <div onClick={() => onUse(template)}>
      <img src={template.previewImageUrl} loading="lazy" />
      <div>{template.title}</div>
      <div>{template.category}</div>
      <div>{template.model} · {template.aspect}</div>
    </div>
  );
}
```

### 3.4 `<TemplateArgumentForm>` Component

```
ui/src/components/TemplateArgumentForm.tsx
```

```tsx
function TemplateArgumentForm({ args, values, onChange }: Props) {
  // Render một input cho mỗi TemplateArgument
  // Default value từ template.arguments[i].default
  // onChange → cập nhật values map
}
```

### 3.5 Cập nhật `MediaPage.tsx`

```tsx
export default function MediaPage() {
  return (
    <div>
      <h1>Media Generation</h1>
      <MediaGenerationPanel projectId={...} />
      <MediaTaskHistory projectId={...} />
    </div>
  );
}
```

---

## 4. File Changes Summary

### Services

| File | Thay đổi |
|------|---------|
| `specs/services/05-media-service.md` | Thêm PromptTemplate domain, loader, argument parser, routes |
| `specs/services/01-api-gateway.md` | Thêm `/api/prompt-templates/*` và `/api/media/generate-from-template` |

### UI (`ui/src/`)

| File | Thay đổi |
|------|---------|
| `api/supplement/http.ts` | Thêm PromptTemplate types + listPromptTemplates, generateFromTemplate |
| `components/MediaGenerationPanel.tsx` | **Mới** (T37) — Image/Video tabs + template browser |
| `components/PromptTemplateCard.tsx` | **Mới** — thumbnail card |
| `components/TemplateArgumentForm.tsx` | **Mới** — argument fill form |
| `pages/MediaPage.tsx` | Implement thực sự |

---

## 5. Argument Format Examples

### Image template argument

```
"background": "{argument name=\"background style\" default=\"vintage textured parchment paper\"}"
```

→ Form field: `background style`, default: `vintage textured parchment paper`

### Video Hyperframes argument

```
"{argument name=\"animation effect\" default=\"liquid glass\"}"
```

→ Form field: `animation effect`, default: `liquid glass`

### Complex JSON prompt (video)

Nhiều video templates có prompt là full JSON object:
```json
{
  "scene": "{argument name=\"scene description\" default=\"cinematic aerial view\"}",
  "duration": "{argument name=\"duration seconds\" default=\"5\"}",
  "style": "cinematic"
}
```

→ Service phải `FillArguments()` trước khi stringify và gửi đến AI provider.
