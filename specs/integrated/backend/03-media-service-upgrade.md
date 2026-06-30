# 03 — Nâng Cấp `media-service`

> **Vị trí**: `services/media-service/`  
> **Mục tiêu**: Thêm PromptTemplate domain, ArgumentParser, và generate-from-template use case  
> **Pattern**: Mở rộng Clean Architecture hiện tại — không phá vỡ routes hiện có  
> **Hiện tại**: `POST /api/v1/media/generate/image`, `POST /api/v1/media/generate/audio`

---

## 1. Gap Analysis hiện tại

### Cấu trúc hiện tại

```
media-service/internal/
├── domain/media.go                  ✅ MediaJob, ImageProvider, AudioProvider
├── usecase/generate_usecase.go      ✅ GenerateImageUseCase, GenerateAudioUseCase
├── infra/provider/providers.go      ✅ DALL-E, OpenAI TTS
├── infra/db/job_repo.go             ✅ PostgreSQL job repo
└── adapter/http/handler.go          ✅ 4 routes
```

### Thiếu

```
media-service/internal/
├── domain/prompt_template.go        ← MỚI: PromptTemplate domain
├── infra/fs/prompt_template_loader.go ← MỚI: Load 103 JSON files
├── infra/prompt/argument_parser.go  ← MỚI: Parse {argument name=...}
├── usecase/template_usecase.go      ← MỚI: List, Get, GenerateFromTemplate
└── adapter/http/handler.go          ← SỬA: thêm /api/v1/prompt-templates/*
```

---

## 2. Domain Model (`internal/domain/prompt_template.go`)

```go
package domain

// Surface phân loại loại media output.
type Surface string

const (
    SurfaceImage Surface = "image"
    SurfaceVideo Surface = "video"
)

// TemplateArgument là một placeholder {argument name="..." default="..."} trong prompt.
type TemplateArgument struct {
    Name    string `json:"name"`
    Default string `json:"default"`
}

// TemplateSource là metadata về nguồn gốc của template.
type TemplateSource struct {
    Repo    string `json:"repo"`
    License string `json:"license"`
    Author  string `json:"author,omitempty"`
    URL     string `json:"url,omitempty"`
}

// PromptTemplate là một prompt template từ prompt-templates/image/ hoặc video/.
type PromptTemplate struct {
    ID              string             `json:"id"`
    Surface         Surface            `json:"surface"`
    Title           string             `json:"title"`
    Summary         string             `json:"summary"`
    Category        string             `json:"category"`
    Tags            []string           `json:"tags"`
    Model           string             `json:"model"`
    Aspect          string             `json:"aspect"`
    RawPrompt       string             `json:"rawPrompt"`   // với {argument} placeholders
    Arguments       []TemplateArgument `json:"arguments"`   // parsed từ RawPrompt
    PreviewImageURL string             `json:"previewImageUrl,omitempty"`
    Source          TemplateSource     `json:"source"`
    ArgumentCount   int                `json:"argumentCount"`
}

// PromptTemplateSummary là version rút gọn cho danh sách.
type PromptTemplateSummary struct {
    ID              string   `json:"id"`
    Surface         Surface  `json:"surface"`
    Title           string   `json:"title"`
    Summary         string   `json:"summary"`
    Category        string   `json:"category"`
    Tags            []string `json:"tags"`
    Model           string   `json:"model"`
    Aspect          string   `json:"aspect"`
    PreviewImageURL string   `json:"previewImageUrl,omitempty"`
    ArgumentCount   int      `json:"argumentCount"`
}

// ToSummary chuyển đổi PromptTemplate thành PromptTemplateSummary.
func (t *PromptTemplate) ToSummary() *PromptTemplateSummary {
    return &PromptTemplateSummary{
        ID:              t.ID,
        Surface:         t.Surface,
        Title:           t.Title,
        Summary:         t.Summary,
        Category:        t.Category,
        Tags:            t.Tags,
        Model:           t.Model,
        Aspect:          t.Aspect,
        PreviewImageURL: t.PreviewImageURL,
        ArgumentCount:   len(t.Arguments),
    }
}

// GenerateFromTemplateRequest là request để generate media từ template.
type GenerateFromTemplateRequest struct {
    TemplateID   string            `json:"templateId" binding:"required"`
    Values       map[string]string `json:"values"`
    ProjectID    string            `json:"projectId"`
    OutputAspect string            `json:"outputAspect"`
    APIKey       string            `json:"apiKey,omitempty"`
}

// ─── Ports ───────────────────────────────────────────────────────────────────

// PromptTemplateCatalog là port truy xuất prompt templates.
type PromptTemplateCatalog interface {
    List(surface, category, model, query string) ([]*PromptTemplate, error)
    GetByID(id string) (*PromptTemplate, error)
    Reload() error
}
```

---

## 3. Argument Parser (`internal/infra/prompt/argument_parser.go`)

```go
package prompt

import (
    "regexp"
    "strings"
)

// argPattern matches {argument name="..." default="..."} placeholders.
// Supports both with and without default.
var argPattern = regexp.MustCompile(
    `\{argument\s+name="([^"]+)"(?:\s+default="([^"]*)")?\}`,
)

// TemplateArg là một parsed argument từ prompt.
type TemplateArg struct {
    Name    string
    Default string
}

// ParseArguments extracts unique arguments from a raw prompt string.
// Maintains insertion order, skips duplicates.
func ParseArguments(rawPrompt string) []TemplateArg {
    matches := argPattern.FindAllStringSubmatch(rawPrompt, -1)
    seen := make(map[string]bool)
    var args []TemplateArg
    for _, m := range matches {
        name := m[1]
        if seen[name] {
            continue
        }
        seen[name] = true
        defaultVal := ""
        if len(m) > 2 {
            defaultVal = m[2]
        }
        args = append(args, TemplateArg{Name: name, Default: defaultVal})
    }
    return args
}

// FillArguments replaces {argument name="x" default="y"} placeholders
// with user-supplied values. Falls back to default if value is empty.
func FillArguments(rawPrompt string, values map[string]string) string {
    return argPattern.ReplaceAllStringFunc(rawPrompt, func(match string) string {
        sub := argPattern.FindStringSubmatch(match)
        if len(sub) < 2 {
            return match
        }
        name := sub[1]
        defaultVal := ""
        if len(sub) > 2 {
            defaultVal = sub[2]
        }
        if v, ok := values[name]; ok && strings.TrimSpace(v) != "" {
            return v
        }
        return defaultVal
    })
}
```

---

## 4. Prompt Template Loader (`internal/infra/fs/prompt_template_loader.go`)

```go
package fs

import (
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "strings"
    "sync"

    "media-service/internal/domain"
    "media-service/internal/infra/prompt"
)

// rawTemplateJSON maps trực tiếp từ JSON file schema.
type rawTemplateJSON struct {
    ID              string          `json:"id"`
    Surface         string          `json:"surface"`
    Title           string          `json:"title"`
    Summary         string          `json:"summary"`
    Category        string          `json:"category"`
    Tags            []string        `json:"tags"`
    Model           string          `json:"model"`
    Aspect          string          `json:"aspect"`
    Prompt          string          `json:"prompt"`
    PreviewImageURL string          `json:"previewImageUrl"`
    Source          rawTemplateSource `json:"source"`
}

type rawTemplateSource struct {
    Repo    string `json:"repo"`
    License string `json:"license"`
    Author  string `json:"author"`
    URL     string `json:"url"`
}

// PromptTemplateLoader loads PromptTemplates from JSON files.
type PromptTemplateLoader struct {
    imagePath string // prompt-templates/image/
    videoPath string // prompt-templates/video/
    cache     sync.Map // id → *domain.PromptTemplate
    mu        sync.Mutex
    loaded    bool
}

// NewPromptTemplateLoader creates a loader.
// Defaults: PROMPT_TEMPLATES_IMAGE_PATH, PROMPT_TEMPLATES_VIDEO_PATH env vars.
func NewPromptTemplateLoader(imagePath, videoPath string) *PromptTemplateLoader {
    if imagePath == "" {
        imagePath = os.Getenv("PROMPT_TEMPLATES_IMAGE_PATH")
    }
    if imagePath == "" {
        imagePath = "./prompt-templates/image"
    }
    if videoPath == "" {
        videoPath = os.Getenv("PROMPT_TEMPLATES_VIDEO_PATH")
    }
    if videoPath == "" {
        videoPath = "./prompt-templates/video"
    }
    return &PromptTemplateLoader{imagePath: imagePath, videoPath: videoPath}
}

// List returns filtered prompt templates (summaries).
func (l *PromptTemplateLoader) List(surface, category, model, query string) ([]*domain.PromptTemplate, error) {
    all, err := l.loadAll()
    if err != nil {
        return nil, err
    }
    var out []*domain.PromptTemplate
    for _, t := range all {
        if surface != "" && string(t.Surface) != surface {
            continue
        }
        if category != "" && !strings.EqualFold(t.Category, category) {
            continue
        }
        if model != "" && t.Model != model {
            continue
        }
        if query != "" {
            q := strings.ToLower(query)
            if !strings.Contains(strings.ToLower(t.Title), q) &&
                !strings.Contains(strings.ToLower(t.Summary), q) {
                continue
            }
        }
        out = append(out, t)
    }
    return out, nil
}

// GetByID returns a template by ID.
func (l *PromptTemplateLoader) GetByID(id string) (*domain.PromptTemplate, error) {
    if v, ok := l.cache.Load(id); ok {
        return v.(*domain.PromptTemplate), nil
    }
    if _, err := l.loadAll(); err != nil {
        return nil, err
    }
    if v, ok := l.cache.Load(id); ok {
        return v.(*domain.PromptTemplate), nil
    }
    return nil, fmt.Errorf("prompt template %q not found", id)
}

// Reload clears cache and reloads.
func (l *PromptTemplateLoader) Reload() error {
    l.mu.Lock()
    l.loaded = false
    l.mu.Unlock()
    l.cache.Range(func(k, _ any) bool { l.cache.Delete(k); return true })
    _, err := l.loadAll()
    return err
}

func (l *PromptTemplateLoader) loadAll() ([]*domain.PromptTemplate, error) {
    l.mu.Lock()
    defer l.mu.Unlock()
    if l.loaded {
        var result []*domain.PromptTemplate
        l.cache.Range(func(_, v any) bool {
            result = append(result, v.(*domain.PromptTemplate))
            return true
        })
        return result, nil
    }

    var result []*domain.PromptTemplate
    for _, dirInfo := range []struct {
        path    string
        surface domain.Surface
    }{
        {l.imagePath, domain.SurfaceImage},
        {l.videoPath, domain.SurfaceVideo},
    } {
        entries, err := os.ReadDir(dirInfo.path)
        if err != nil {
            if os.IsNotExist(err) {
                continue
            }
            return nil, fmt.Errorf("prompt_template_loader: read dir %q: %w", dirInfo.path, err)
        }
        for _, e := range entries {
            if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
                continue
            }
            data, err := os.ReadFile(filepath.Join(dirInfo.path, e.Name()))
            if err != nil {
                continue
            }
            t, err := l.parseJSON(data, dirInfo.surface)
            if err != nil {
                fmt.Printf("[WARN] prompt_template_loader: skipping %q: %v\n", e.Name(), err)
                continue
            }
            l.cache.Store(t.ID, t)
            result = append(result, t)
        }
    }
    l.loaded = true
    return result, nil
}

func (l *PromptTemplateLoader) parseJSON(data []byte, surface domain.Surface) (*domain.PromptTemplate, error) {
    var raw rawTemplateJSON
    if err := json.Unmarshal(data, &raw); err != nil {
        return nil, err
    }
    if raw.ID == "" {
        return nil, fmt.Errorf("missing 'id' field")
    }

    // Parse arguments from raw prompt
    parsedArgs := prompt.ParseArguments(raw.Prompt)
    var args []domain.TemplateArgument
    for _, a := range parsedArgs {
        args = append(args, domain.TemplateArgument{Name: a.Name, Default: a.Default})
    }

    t := &domain.PromptTemplate{
        ID:              raw.ID,
        Surface:         surface,
        Title:           raw.Title,
        Summary:         raw.Summary,
        Category:        raw.Category,
        Tags:            raw.Tags,
        Model:           raw.Model,
        Aspect:          raw.Aspect,
        RawPrompt:       raw.Prompt,
        Arguments:       args,
        PreviewImageURL: raw.PreviewImageURL,
        Source: domain.TemplateSource{
            Repo:    raw.Source.Repo,
            License: raw.Source.License,
            Author:  raw.Source.Author,
            URL:     raw.Source.URL,
        },
        ArgumentCount: len(args),
    }
    // Override surface from JSON if present
    if raw.Surface != "" {
        t.Surface = domain.Surface(raw.Surface)
    }
    return t, nil
}
```

---

## 5. Template Use Case (`internal/usecase/template_usecase.go`)

```go
package usecase

import (
    "fmt"

    "media-service/internal/domain"
    "media-service/internal/infra/prompt"

    "go.uber.org/zap"
)

// TemplateUseCase handles prompt template operations.
type TemplateUseCase struct {
    catalog  domain.PromptTemplateCatalog
    imageUC  *GenerateImageUseCase
    logger   *zap.Logger
}

func NewTemplateUseCase(
    catalog domain.PromptTemplateCatalog,
    imageUC *GenerateImageUseCase,
    logger *zap.Logger,
) *TemplateUseCase {
    return &TemplateUseCase{catalog: catalog, imageUC: imageUC, logger: logger}
}

// ListTemplates returns filtered prompt templates.
func (uc *TemplateUseCase) ListTemplates(surface, category, model, query string) ([]*domain.PromptTemplateSummary, error) {
    all, err := uc.catalog.List(surface, category, model, query)
    if err != nil {
        return nil, err
    }
    summaries := make([]*domain.PromptTemplateSummary, len(all))
    for i, t := range all {
        summaries[i] = t.ToSummary()
    }
    return summaries, nil
}

// GetTemplate returns a single prompt template with full detail.
func (uc *TemplateUseCase) GetTemplate(id string) (*domain.PromptTemplate, error) {
    return uc.catalog.GetByID(id)
}

// GenerateFromTemplate fills template arguments and dispatches generation.
func (uc *TemplateUseCase) GenerateFromTemplate(req *domain.GenerateFromTemplateRequest) (*domain.MediaJob, error) {
    t, err := uc.catalog.GetByID(req.TemplateID)
    if err != nil {
        return nil, fmt.Errorf("GenerateFromTemplate: template not found: %w", err)
    }

    // Fill {argument} placeholders
    filledPrompt := prompt.FillArguments(t.RawPrompt, req.Values)

    switch t.Surface {
    case domain.SurfaceImage:
        aspect := req.OutputAspect
        if aspect == "" {
            aspect = t.Aspect
        }
        w, h := aspectToWidthHeight(aspect)
        imageReq := &domain.ImageGenerateRequest{
            Prompt:  filledPrompt,
            Model:   t.Model,
            Width:   w,
            Height:  h,
            APIKey:  req.APIKey,
        }
        return uc.imageUC.Execute(imageReq, "")

    case domain.SurfaceVideo:
        // Video generation: route to video provider when available
        // For now: create a pending job with the filled prompt
        uc.logger.Info("video generation from template", zap.String("template_id", req.TemplateID))
        return nil, fmt.Errorf("video generation not yet implemented")

    default:
        return nil, fmt.Errorf("unsupported surface: %q", t.Surface)
    }
}

// Reload triggers catalog reload.
func (uc *TemplateUseCase) Reload() error {
    return uc.catalog.Reload()
}

// aspectToWidthHeight converts "1:1" → (1024,1024), "16:9" → (1792,1024), etc.
func aspectToWidthHeight(aspect string) (int, int) {
    switch aspect {
    case "1:1":
        return 1024, 1024
    case "16:9":
        return 1792, 1024
    case "9:16":
        return 1024, 1792
    case "4:3":
        return 1024, 768
    case "3:4":
        return 768, 1024
    default:
        return 1024, 1024
    }
}
```

---

## 6. Cập nhật HTTP Handler (`internal/adapter/http/handler.go`)

Thêm vào `MediaHandler` struct:

```go
type MediaHandler struct {
    imageUC    *usecase.GenerateImageUseCase
    audioUC    *usecase.GenerateAudioUseCase
    jobUC      *usecase.JobUseCase
    templateUC *usecase.TemplateUseCase  // ← MỚI
    logger     *zap.Logger
}

// Thêm vào RegisterRoutes:
func (h *MediaHandler) RegisterRoutes(r *gin.Engine) {
    api := r.Group("/api/v1")
    {
        // Existing routes (unchanged)
        api.POST("/media/generate/image", h.GenerateImage)
        api.POST("/media/generate/audio", h.GenerateAudio)
        api.GET("/media/jobs/:id",        h.GetJob)
        api.GET("/media/jobs",            h.ListJobs)

        // ← MỚI: Prompt Template routes
        api.GET("/prompt-templates",      h.ListPromptTemplates)
        api.GET("/prompt-templates/:id",  h.GetPromptTemplate)
        api.GET("/prompt-templates/:id/preview", h.RedirectPreview)
        api.POST("/media/generate-from-template", h.GenerateFromTemplate)
        api.POST("/prompt-templates/-/reload", h.ReloadTemplates)
    }
    r.GET("/health", h.Health)
}

// ← MỚI handlers:

// GET /api/v1/prompt-templates?surface=&category=&model=&q=
func (h *MediaHandler) ListPromptTemplates(c *gin.Context) {
    list, err := h.templateUC.ListTemplates(
        c.Query("surface"),
        c.Query("category"),
        c.Query("model"),
        c.Query("q"),
    )
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, gin.H{"items": list, "total": len(list)})
}

// GET /api/v1/prompt-templates/:id
func (h *MediaHandler) GetPromptTemplate(c *gin.Context) {
    t, err := h.templateUC.GetTemplate(c.Param("id"))
    if err != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, t)
}

// GET /api/v1/prompt-templates/:id/preview → redirect to previewImageUrl
func (h *MediaHandler) RedirectPreview(c *gin.Context) {
    t, err := h.templateUC.GetTemplate(c.Param("id"))
    if err != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
        return
    }
    if t.PreviewImageURL == "" {
        c.JSON(http.StatusNotFound, gin.H{"error": "no preview image"})
        return
    }
    c.Redirect(http.StatusFound, t.PreviewImageURL)
}

// POST /api/v1/media/generate-from-template
func (h *MediaHandler) GenerateFromTemplate(c *gin.Context) {
    var req domain.GenerateFromTemplateRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }
    job, err := h.templateUC.GenerateFromTemplate(&req)
    if err != nil {
        h.logger.Error("GenerateFromTemplate failed", zap.Error(err))
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusAccepted, job)
}

// POST /api/v1/prompt-templates/-/reload
func (h *MediaHandler) ReloadTemplates(c *gin.Context) {
    if err := h.templateUC.Reload(); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, gin.H{"status": "reloaded"})
}
```

---

## 7. Cập nhật `cmd/main.go` của media-service

```go
// Thêm vào wire-up:
ptLoader := fs.NewPromptTemplateLoader(
    os.Getenv("PROMPT_TEMPLATES_IMAGE_PATH"),
    os.Getenv("PROMPT_TEMPLATES_VIDEO_PATH"),
)
templateUC := usecase.NewTemplateUseCase(ptLoader, imageUC, logger)

// Cập nhật handler:
handler := http.NewMediaHandler(imageUC, audioUC, jobUC, templateUC, logger)
```

---

## 8. Env vars cần thêm

| Env | Default | Mô tả |
|-----|---------|-------|
| `PROMPT_TEMPLATES_IMAGE_PATH` | `./prompt-templates/image` | Path đến image JSON files |
| `PROMPT_TEMPLATES_VIDEO_PATH` | `./prompt-templates/video` | Path đến video JSON files |

---

## 9. API mới sau nâng cấp

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/api/v1/prompt-templates` | List (filter: `?surface=&category=&model=&q=`) |
| GET | `/api/v1/prompt-templates/:id` | Detail với rawPrompt + arguments[] |
| GET | `/api/v1/prompt-templates/:id/preview` | Redirect → previewImageUrl |
| POST | `/api/v1/media/generate-from-template` | Fill args + dispatch generation |
| POST | `/api/v1/prompt-templates/-/reload` | Reload catalog |

---

## Implementation Status

> **Cập nhật**: 2026-06-04 — **HOÀN THÀNH** ✅

### Đã implement

| §  | Nội dung | File | Status |
|----|----------|------|--------|
| §1 | Gap analysis | — | ✅ Đã fix toàn bộ gaps |
| §2 | Domain Model | `internal/domain/prompt_template.go` | ✅ `PromptTemplate`, `PromptArgument`, `GenerateFromTemplateRequest`, `PromptTemplateCatalog` interface |
| §3 | Argument Parser | `internal/infra/prompt/argument_parser.go` | ✅ Dual-regex: plain `{argument name="x"}` + escaped `{argument name=\"x\"}` (JSON-embedded) |
| §4 | Prompt Template Loader | `internal/infra/fs/prompt_template_loader.go` | ✅ Image + Video directories, sync.Map cache, 102 templates (45 image + 57 video) |
| §5 | Template Use Case | `internal/usecase/template_usecase.go` | ✅ ListTemplates, GetTemplate, GenerateFromTemplate, Reload + `aspectToWidthHeight` helper |
| §6 | HTTP Handler update | `internal/adapter/http/handler.go` | ✅ 5 routes mới, `MediaHandler` struct + constructor cập nhật |
| §7 | `cmd/main.go` update | `cmd/main.go` | ✅ `ptLoader` + `templateUC` wire-up, env `PROMPT_TEMPLATES_*_PATH` |
| §8 | Env vars | `PROMPT_TEMPLATES_IMAGE_PATH` + `VIDEO_PATH` | ✅ docker-compose + main.go |
| §9 | API mới | 5 endpoints live | ✅ |

### Routes được thêm vào MediaHandler

```
GET  /api/v1/prompt-templates             → ListPromptTemplates   (surface, category, model, q)
GET  /api/v1/prompt-templates/:id         → GetPromptTemplate
GET  /api/v1/prompt-templates/:id/preview → RedirectPromptPreview (302 → previewImageUrl)
POST /api/v1/media/generate-from-template → GenerateFromTemplate  (fill args → enqueue job)
POST /api/v1/prompt-templates/-/reload    → ReloadPromptTemplates
```

### Critical implementation detail — ArgumentParser

Prompt templates lưu JSON. Sau khi `json.Unmarshal`, `\"` trong chuỗi trở thành `"`.  
Dùng **dual-regex**:
```go
argPatternPlain   = `{argument name="([^"]+)"(?:\s+default="([^"]*)")?}`   // sau unmarshal
argPatternEscaped = `{argument name=\"([^\"]+)\"(?:\s+default=\"([^\"]*)\")?}` // raw JSON
```

### Tests

```
go test ./internal/infra/prompt/... -v
--- PASS: TestFillArguments (13 subtests)
--- PASS: TestCountArguments
PASS   (0.983s)
```

### Build

```
cd services/media-service && go build ./...  → EXIT 0 ✓
```
