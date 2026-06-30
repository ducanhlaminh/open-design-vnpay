# 02 — Nâng Cấp `skill-service`

> **Vị trí**: `services/skill-service/`  
> **Mục tiêu**: Thêm DesignTemplate registry — parse `SKILL.md` với YAML frontmatter  
> **Nguyên tắc**: Không phá vỡ API hiện có (`/api/v1/skills/*`)  
> **Pattern**: Mở rộng Clean Architecture hiện tại — thêm domain/loader/handler riêng cho templates

---

## 1. Hiện trạng cần nâng cấp

### Cấu trúc hiện tại

```
skill-service/internal/
├── domain/skill.go           ✅ Skill domain (id, name, kind, system_prompt, tags)
├── infra/fs/skill_loader.go  ✅ Load từ .yaml files
├── usecase/catalog_usecase.go ✅ List, Get, GetContext
└── adapter/http/handler.go   ✅ /api/v1/skills/*
```

### Cần thêm

```
skill-service/internal/
├── domain/design_template.go  ← MỚI: DesignTemplate domain
├── infra/fs/template_loader.go ← MỚI: parse SKILL.md frontmatter  
├── usecase/template_usecase.go ← MỚI: list/get/serve templates
└── adapter/http/handler.go    ← SỬA: thêm /api/v1/design-templates/* routes
```

---

## 2. Domain Model (`internal/domain/design_template.go`)

```go
package domain

// TemplateMode là mode render của một design template.
type TemplateMode string

const (
    TemplateModePrototype TemplateMode = "prototype"
    TemplateModeDeck      TemplateMode = "deck"
    TemplateModeTemplate  TemplateMode = "template"
    TemplateModeImage     TemplateMode = "image"
    TemplateModeVideo     TemplateMode = "video"
    TemplateModeAudio     TemplateMode = "audio"
)

// TemplatePlatform là platform target của template.
type TemplatePlatform string

const (
    PlatformDesktop TemplatePlatform = "desktop"
    PlatformMobile  TemplatePlatform = "mobile"
    PlatformTablet  TemplatePlatform = "tablet"
)

// TemplateInputType là kiểu của một input field.
type TemplateInputType string

const (
    InputTypeString  TemplateInputType = "string"
    InputTypeText    TemplateInputType = "text"
    InputTypeSelect  TemplateInputType = "select"
    InputTypeNumber  TemplateInputType = "number"
    InputTypeBoolean TemplateInputType = "boolean"
)

// TemplateInput là một input field được định nghĩa trong od.inputs.
type TemplateInput struct {
    Name        string            `json:"name" yaml:"name"`
    Type        TemplateInputType `json:"type" yaml:"type"`
    Required    bool              `json:"required" yaml:"required"`
    Default     string            `json:"default,omitempty" yaml:"default"`
    Options     []string          `json:"options,omitempty" yaml:"options"`
    Placeholder string            `json:"placeholder,omitempty" yaml:"placeholder"`
}

// DesignTemplate là một design template entry từ design-templates/.
type DesignTemplate struct {
    ID          string           `json:"id"`
    Name        string           `json:"name"`
    Description string           `json:"description,omitempty"`
    Mode        TemplateMode     `json:"mode"`
    Platform    TemplatePlatform `json:"platform,omitempty"`
    Scenario    string           `json:"scenario,omitempty"`
    Triggers    []string         `json:"triggers"`
    HasExample  bool             `json:"hasExample"`
    ExampleURL  string           `json:"exampleUrl"` // /api/v1/design-templates/:id/example
    Inputs      []TemplateInput  `json:"inputs"`
    DiskPath    string           `json:"-"` // absolute path
}

// TemplateCatalog là port để truy xuất templates.
type TemplateCatalog interface {
    List(mode, query, scenario string) ([]*DesignTemplate, error)
    GetByID(id string) (*DesignTemplate, error)
    Reload() error
}
```

---

## 3. Template Loader (`internal/infra/fs/template_loader.go`)

```go
package fs

import (
    "bytes"
    "fmt"
    "os"
    "path/filepath"
    "strings"
    "sync"

    "skill-service/internal/domain"

    "gopkg.in/yaml.v3"
)

// SKILL.md YAML frontmatter schema (giữa --- ... ---)
type skillMDFrontmatter struct {
    Name        string                 `yaml:"name"`
    Description string                 `yaml:"description"`
    Triggers    []string               `yaml:"triggers"`
    OD          skillMDOD              `yaml:"od"`
}

type skillMDOD struct {
    Mode     string           `yaml:"mode"`
    Platform string           `yaml:"platform"`
    Scenario string           `yaml:"scenario"`
    Inputs   []skillMDInput   `yaml:"inputs"`
}

type skillMDInput struct {
    Name        string   `yaml:"name"`
    Type        string   `yaml:"type"`
    Required    bool     `yaml:"required"`
    Default     string   `yaml:"default"`
    Options     []string `yaml:"options"`
    Placeholder string   `yaml:"placeholder"`
}

// TemplateLoader loads DesignTemplates from the filesystem.
// Each template lives in templatesPath/<id>/SKILL.md + example.html
type TemplateLoader struct {
    templatesPath string
    cache         sync.Map // id → *domain.DesignTemplate
    mu            sync.Mutex
    loaded        bool
}

// NewTemplateLoader creates a loader pointing at templatesPath.
// Falls back to DESIGN_TEMPLATES_PATH env or "./design-templates".
func NewTemplateLoader(templatesPath string) *TemplateLoader {
    if templatesPath == "" {
        templatesPath = os.Getenv("DESIGN_TEMPLATES_PATH")
    }
    if templatesPath == "" {
        templatesPath = "./design-templates"
    }
    return &TemplateLoader{templatesPath: templatesPath}
}

// List returns filtered templates.
func (l *TemplateLoader) List(mode, query, scenario string) ([]*domain.DesignTemplate, error) {
    all, err := l.loadAll()
    if err != nil {
        return nil, err
    }
    var out []*domain.DesignTemplate
    for _, t := range all {
        if mode != "" && string(t.Mode) != mode {
            continue
        }
        if scenario != "" && t.Scenario != scenario {
            continue
        }
        if query != "" {
            q := strings.ToLower(query)
            if !strings.Contains(strings.ToLower(t.Name), q) &&
                !strings.Contains(strings.ToLower(t.Description), q) {
                continue
            }
        }
        out = append(out, t)
    }
    return out, nil
}

// GetByID returns a template by ID.
func (l *TemplateLoader) GetByID(id string) (*domain.DesignTemplate, error) {
    if v, ok := l.cache.Load(id); ok {
        return v.(*domain.DesignTemplate), nil
    }
    if _, err := l.loadAll(); err != nil {
        return nil, err
    }
    if v, ok := l.cache.Load(id); ok {
        return v.(*domain.DesignTemplate), nil
    }
    return nil, fmt.Errorf("design template %q not found", id)
}

// Reload clears cache and reloads.
func (l *TemplateLoader) Reload() error {
    l.mu.Lock()
    l.loaded = false
    l.mu.Unlock()
    l.cache.Range(func(k, _ any) bool { l.cache.Delete(k); return true })
    _, err := l.loadAll()
    return err
}

func (l *TemplateLoader) loadAll() ([]*domain.DesignTemplate, error) {
    l.mu.Lock()
    defer l.mu.Unlock()
    if l.loaded {
        var result []*domain.DesignTemplate
        l.cache.Range(func(_, v any) bool {
            result = append(result, v.(*domain.DesignTemplate))
            return true
        })
        return result, nil
    }

    entries, err := os.ReadDir(l.templatesPath)
    if err != nil {
        if os.IsNotExist(err) {
            return []*domain.DesignTemplate{}, nil
        }
        return nil, fmt.Errorf("template_loader: read dir: %w", err)
    }

    var result []*domain.DesignTemplate
    for _, e := range entries {
        if !e.IsDir() {
            continue
        }
        id := e.Name()
        templateDir := filepath.Join(l.templatesPath, id)
        t, err := l.loadOne(id, templateDir)
        if err != nil {
            fmt.Printf("[WARN] template_loader: skipping %q: %v\n", id, err)
            continue
        }
        l.cache.Store(id, t)
        result = append(result, t)
    }
    l.loaded = true
    return result, nil
}

func (l *TemplateLoader) loadOne(id, dirPath string) (*domain.DesignTemplate, error) {
    skillMDPath := filepath.Join(dirPath, "SKILL.md")
    data, err := os.ReadFile(skillMDPath)
    if err != nil {
        return nil, fmt.Errorf("SKILL.md not found in %q", dirPath)
    }

    fm, err := parseSKILLMD(data)
    if err != nil {
        return nil, fmt.Errorf("parse SKILL.md %q: %w", skillMDPath, err)
    }

    hasExample := fileExists(filepath.Join(dirPath, "example.html"))
    exampleURL := ""
    if hasExample {
        exampleURL = "/api/v1/design-templates/" + id + "/example"
    }

    t := &domain.DesignTemplate{
        ID:          id,
        Name:        fm.Name,
        Description: strings.TrimSpace(fm.Description),
        Mode:        domain.TemplateMode(fm.OD.Mode),
        Platform:    domain.TemplatePlatform(fm.OD.Platform),
        Scenario:    fm.OD.Scenario,
        Triggers:    fm.Triggers,
        HasExample:  hasExample,
        ExampleURL:  exampleURL,
        DiskPath:    dirPath,
    }
    if t.Mode == "" {
        t.Mode = domain.TemplateModePrototype
    }

    for _, inp := range fm.OD.Inputs {
        inputType := domain.TemplateInputType(inp.Type)
        if inputType == "" {
            inputType = domain.InputTypeString
        }
        t.Inputs = append(t.Inputs, domain.TemplateInput{
            Name:        inp.Name,
            Type:        inputType,
            Required:    inp.Required,
            Default:     inp.Default,
            Options:     inp.Options,
            Placeholder: inp.Placeholder,
        })
    }
    return t, nil
}

// parseSKILLMD extracts YAML frontmatter from a SKILL.md file.
// Frontmatter is between the first --- and second --- delimiters.
func parseSKILLMD(data []byte) (*skillMDFrontmatter, error) {
    content := string(data)
    // Strip leading ---
    if !strings.HasPrefix(strings.TrimSpace(content), "---") {
        return nil, fmt.Errorf("SKILL.md does not start with YAML frontmatter (---)")
    }
    parts := strings.SplitN(content, "---", 3)
    if len(parts) < 3 {
        return nil, fmt.Errorf("SKILL.md frontmatter not closed with ---")
    }
    yamlContent := parts[1]

    var fm skillMDFrontmatter
    if err := yaml.NewDecoder(bytes.NewReader([]byte(yamlContent))).Decode(&fm); err != nil {
        return nil, fmt.Errorf("YAML parse error: %w", err)
    }
    return &fm, nil
}

func fileExists(path string) bool {
    _, err := os.Stat(path)
    return err == nil
}
```

---

## 4. Template Use Case (`internal/usecase/template_usecase.go`)

```go
package usecase

import (
    "fmt"
    "os"
    "path/filepath"
    "strings"

    "skill-service/internal/domain"
)

// TemplateUseCase encapsulates design template operations.
type TemplateUseCase struct {
    catalog domain.TemplateCatalog
}

func NewTemplateUseCase(catalog domain.TemplateCatalog) *TemplateUseCase {
    return &TemplateUseCase{catalog: catalog}
}

// ListTemplates returns filtered list of design templates.
func (uc *TemplateUseCase) ListTemplates(mode, query, scenario string) ([]*domain.DesignTemplate, error) {
    return uc.catalog.List(mode, query, scenario)
}

// GetTemplate returns a single template by ID.
func (uc *TemplateUseCase) GetTemplate(id string) (*domain.DesignTemplate, error) {
    return uc.catalog.GetByID(id)
}

// ServeExample reads and returns the example.html content.
func (uc *TemplateUseCase) ServeExample(id string) ([]byte, error) {
    t, err := uc.catalog.GetByID(id)
    if err != nil {
        return nil, err
    }
    if !t.HasExample {
        return nil, fmt.Errorf("template %q has no example.html", id)
    }
    return os.ReadFile(filepath.Join(t.DiskPath, "example.html"))
}

// ServeDerivedExample reads a derived example from examples/<key>.html.
func (uc *TemplateUseCase) ServeDerivedExample(id, key string) ([]byte, error) {
    t, err := uc.catalog.GetByID(id)
    if err != nil {
        return nil, err
    }
    // Security: key must be simple slug
    if strings.ContainsAny(key, "/\\..") {
        return nil, fmt.Errorf("invalid example key: %q", key)
    }
    path := filepath.Join(t.DiskPath, "examples", key+".html")
    return os.ReadFile(path)
}

// ServeAsset reads an asset file from the template's assets/ directory.
func (uc *TemplateUseCase) ServeAsset(id, assetPath string) ([]byte, error) {
    t, err := uc.catalog.GetByID(id)
    if err != nil {
        return nil, err
    }
    clean := filepath.Clean(assetPath)
    if strings.HasPrefix(clean, "..") {
        return nil, fmt.Errorf("invalid asset path: %q", assetPath)
    }
    return os.ReadFile(filepath.Join(t.DiskPath, "assets", clean))
}

// Reload triggers catalog reload.
func (uc *TemplateUseCase) Reload() error {
    return uc.catalog.Reload()
}
```

---

## 5. Cập nhật HTTP Handler (`internal/adapter/http/handler.go`)

Thêm vào `SkillHandler` struct và `RegisterRoutes`:

```go
// Thêm field vào struct
type SkillHandler struct {
    catalogUC  *usecase.CatalogUseCase
    templateUC *usecase.TemplateUseCase  // ← MỚI
    logger     *zap.Logger
}

// Thêm vào RegisterRoutes
func (h *SkillHandler) RegisterRoutes(r *gin.Engine) {
    v1 := r.Group("/api/v1")
    {
        // Existing skill routes (unchanged)
        v1.GET("/skills",              h.ListSkills)
        v1.GET("/skills/:id",         h.GetSkill)
        v1.GET("/skills/:id/context", h.GetSkillContext)

        // ← MỚI: Design Template routes
        v1.GET("/design-templates",                       h.ListTemplates)
        v1.GET("/design-templates/:id",                  h.GetTemplate)
        v1.GET("/design-templates/:id/example",          h.ServeExample)
        v1.GET("/design-templates/:id/examples/:key",    h.ServeDerivedExample)
        v1.GET("/design-templates/:id/assets/*path",     h.ServeTemplateAsset)
        v1.POST("/design-templates/-/reload",            h.ReloadTemplates)

        // ← MỚI: Backward-compat alias (theo AGENTS.md)
        // /api/v1/skills/:id/example → redirect khi id là template
        // Handled bởi middleware hoặc trong GetSkill fallthrough
    }
    r.GET("/health", h.Health)
}

// ← MỚI: Template handlers
func (h *SkillHandler) ListTemplates(c *gin.Context) {
    list, err := h.templateUC.ListTemplates(
        c.Query("mode"),
        c.Query("q"),
        c.Query("scenario"),
    )
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, gin.H{"items": list, "total": len(list)})
}

func (h *SkillHandler) GetTemplate(c *gin.Context) {
    t, err := h.templateUC.GetTemplate(c.Param("id"))
    if err != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, t)
}

func (h *SkillHandler) ServeExample(c *gin.Context) {
    data, err := h.templateUC.ServeExample(c.Param("id"))
    if err != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
        return
    }
    c.Header("X-Frame-Options", "SAMEORIGIN")
    c.Data(http.StatusOK, "text/html; charset=utf-8", data)
}

func (h *SkillHandler) ServeDerivedExample(c *gin.Context) {
    data, err := h.templateUC.ServeDerivedExample(c.Param("id"), c.Param("key"))
    if err != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
        return
    }
    c.Header("X-Frame-Options", "SAMEORIGIN")
    c.Data(http.StatusOK, "text/html; charset=utf-8", data)
}

func (h *SkillHandler) ServeTemplateAsset(c *gin.Context) {
    data, err := h.templateUC.ServeAsset(c.Param("id"), c.Param("path"))
    if err != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
        return
    }
    // Detect mime type from path
    ext := filepath.Ext(c.Param("path"))
    mimeType := mime.TypeByExtension(ext)
    if mimeType == "" {
        mimeType = "application/octet-stream"
    }
    c.Data(http.StatusOK, mimeType, data)
}

func (h *SkillHandler) ReloadTemplates(c *gin.Context) {
    if err := h.templateUC.Reload(); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, gin.H{"status": "reloaded"})
}
```

---

## 6. Cập nhật `cmd/main.go` của skill-service

```go
// Thêm vào wire-up:
templateLoader := fs.NewTemplateLoader(os.Getenv("DESIGN_TEMPLATES_PATH"))
templateUC := usecase.NewTemplateUseCase(templateLoader)

// Cập nhật handler constructor:
handler := http.NewSkillHandler(catalogUC, templateUC, logger) // thêm templateUC
```

---

## 7. Thêm vào `go.mod` của skill-service

```
require (
    ...
    gopkg.in/yaml.v3 v3.0.1   // ← nếu chưa có (hiện đang dùng goccy/go-yaml)
)
```

---

## 8. Env vars cần thêm

| Env | Default | Mô tả |
|-----|---------|-------|
| `DESIGN_TEMPLATES_PATH` | `./design-templates` | Path đến design-templates directory |
| `SKILLS_PATH` | `./skills` | Giữ nguyên |

---

## 9. API mới sau nâng cấp

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/api/v1/design-templates` | List (filter: `?mode=&q=&scenario=`) |
| GET | `/api/v1/design-templates/:id` | Detail với inputs[] |
| GET | `/api/v1/design-templates/:id/example` | example.html |
| GET | `/api/v1/design-templates/:id/examples/:key` | Derived example |
| GET | `/api/v1/design-templates/:id/assets/*path` | Asset files |
| POST | `/api/v1/design-templates/-/reload` | Reload catalog |

---

## Implementation Status

> **Cập nhật**: 2026-06-04 — **HOÀN THÀNH** ✅

### Đã implement

| §  | Nội dung | File | Status |
|----|----------|------|--------|
| §1 | Gap analysis | — | ✅ Đã fix toàn bộ gaps |
| §2 | Domain Model | `internal/domain/design_template.go` | ✅ `DesignTemplate`, `TemplateInput`, `TemplateInputType`, `TemplateCatalog` interface |
| §3 | Template Loader | `internal/infra/fs/template_loader.go` | ✅ SKILL.md frontmatter parser, sync.Map cache, 110+ templates |
| §4 | Template Use Case | `internal/usecase/template_usecase.go` | ✅ ListTemplates, GetTemplate, ServeExample, ServeDerivedExample, ServeAsset, Reload |
| §5 | HTTP Handler update | `internal/adapter/http/handler.go` | ✅ 6 routes mới: `/api/v1/design-templates/*`, `SkillHandler` struct + constructor cập nhật |
| §6 | `cmd/main.go` update | `cmd/main.go` | ✅ `templateLoader` + `templateUC` wire-up, env `DESIGN_TEMPLATES_PATH` |
| §7 | `go.mod` | Dùng `goccy/go-yaml` đã có sẵn | ✅ Không cần thêm dep mới |
| §8 | Env vars | `DESIGN_TEMPLATES_PATH=/design-templates` | ✅ docker-compose + main.go |
| §9 | API mới | 6 endpoints live | ✅ |

### Routes được thêm vào SkillHandler

```
GET  /api/v1/design-templates             → ListTemplates   (q, mode, scenario)
GET  /api/v1/design-templates/:id         → GetTemplate
GET  /api/v1/design-templates/:id/example → ServeExample    (HTML preview)
GET  /api/v1/design-templates/:id/examples/:key → ServeDerivedExample
GET  /api/v1/design-templates/:id/assets/*path  → ServeTemplateAsset
POST /api/v1/design-templates/-/reload    → ReloadTemplates
```

### Khác biệt vs spec

- **Spec §3**: mô tả `SKILL.md` parser riêng → **Impl**: parser tích hợp trong `template_loader.go` (đơn giản hơn)
- **Spec §5**: `ListTemplates` filter qua `q`, `mode`, `scenario` → **Impl**: đúng spec, thêm case-insensitive search

### Build

```
cd services/skill-service && go build ./...  → EXIT 0 ✓
```
