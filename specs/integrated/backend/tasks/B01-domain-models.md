# B-05..B-07 — Domain Models

**Phase**: B1 | **Estimate**: ~5h | **Depends on**: B0

---

## B-05 — `design-system-svc/internal/domain/design_system.go`

**Target**: `services/design-system-svc/internal/domain/design_system.go`  
**Estimate**: 1.5h

Tạo file với nội dung đầy đủ:

```go
package domain

import "time"

// DesignSystemSource phân loại nguồn gốc của DS.
type DesignSystemSource string

const (
	SourceBundled   DesignSystemSource = "bundled"
	SourceImported  DesignSystemSource = "imported"
	SourceGenerated DesignSystemSource = "generated"
)

// DesignSystemStatus vòng đời của DS.
type DesignSystemStatus string

const (
	StatusActive     DesignSystemStatus = "active"
	StatusProcessing DesignSystemStatus = "processing"
	StatusError      DesignSystemStatus = "error"
)

// PreviewPage là một trang preview tĩnh được bundle với DS.
type PreviewPage struct {
	Path  string `json:"path"`
	Role  string `json:"role"`  // "colors"|"typography"|"spacing"|"buttons"|"app"
	Title string `json:"title"`
}

// DesignSystem là domain entity chính.
type DesignSystem struct {
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	Category      string             `json:"category"`
	Description   string             `json:"description,omitempty"`
	SourceType    DesignSystemSource `json:"sourceType"`
	Status        DesignSystemStatus `json:"status"`
	HasTokens     bool               `json:"hasTokens"`
	HasComponents bool               `json:"hasComponents"`
	PreviewPages  []PreviewPage      `json:"previewPages"`
	ImportMode    string             `json:"importMode,omitempty"`
	DiskPath      string             `json:"-"` // absolute path, không expose qua JSON
	CreatedAt     time.Time          `json:"createdAt,omitempty"`
}

// DSContext là dữ liệu inject vào agent context.
type DSContext struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Category       string `json:"category"`
	DesignMD       string `json:"designMd"`               // content của DESIGN.md
	TokensCSS      string `json:"tokensCSS"`              // content của tokens.css
	ComponentsHTML string `json:"componentsHTML,omitempty"` // content của components.html
}

// ─── Port interfaces ─────────────────────────────────────────────────────────

// Catalog là port truy xuất danh sách DS.
type Catalog interface {
	List(category, query, source string) ([]*DesignSystem, error)
	GetByID(id string) (*DesignSystem, error)
	Reload() error
}

// FileServer là port serve file assets của DS.
type FileServer interface {
	// ReadFile trả về content + mimeType của file trong DS.
	// relativePath ví dụ: "tokens.css", "preview/colors.html", "assets/logo.svg"
	ReadFile(dsID, relativePath string) ([]byte, string, error)
	FileExists(dsID, relativePath string) bool
}
```

**Verify**: `cd services/design-system-svc && go vet ./internal/domain/...`

---

## B-06 — `skill-service/internal/domain/design_template.go`

**Target**: `services/skill-service/internal/domain/design_template.go`  
**Estimate**: 1.5h

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

// TemplateInput là một input field được định nghĩa trong od.inputs của SKILL.md.
type TemplateInput struct {
	Name        string            `json:"name"        yaml:"name"`
	Type        TemplateInputType `json:"type"        yaml:"type"`
	Required    bool              `json:"required"    yaml:"required"`
	Default     string            `json:"default,omitempty"     yaml:"default"`
	Options     []string          `json:"options,omitempty"     yaml:"options"`
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
	ExampleURL  string           `json:"exampleUrl"`
	Inputs      []TemplateInput  `json:"inputs"`
	DiskPath    string           `json:"-"` // absolute path, không expose
}

// TemplateCatalog là port để truy xuất design templates.
type TemplateCatalog interface {
	List(mode, query, scenario string) ([]*DesignTemplate, error)
	GetByID(id string) (*DesignTemplate, error)
	Reload() error
}
```

**Verify**: `cd services/skill-service && go vet ./internal/domain/...`

---

## B-07 — `media-service/internal/domain/prompt_template.go`

**Target**: `services/media-service/internal/domain/prompt_template.go`  
**Estimate**: 2h

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
	Model           string             `json:"model"`   // "gpt-image-2"|"seedance-2.0"|...
	Aspect          string             `json:"aspect"`  // "1:1"|"16:9"|...
	RawPrompt       string             `json:"rawPrompt"`
	Arguments       []TemplateArgument `json:"arguments"`
	PreviewImageURL string             `json:"previewImageUrl,omitempty"`
	Source          TemplateSource     `json:"source"`
	ArgumentCount   int                `json:"argumentCount"`
}

// ToSummary chuyển đổi PromptTemplate thành dạng rút gọn cho danh sách.
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

// PromptTemplateSummary là version rút gọn cho danh sách (không có rawPrompt).
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

// GenerateFromTemplateRequest là HTTP request body để generate media từ template.
type GenerateFromTemplateRequest struct {
	TemplateID   string            `json:"templateId"   binding:"required"`
	Values       map[string]string `json:"values"`       // {arg_name: value}
	ProjectID    string            `json:"projectId"`
	OutputAspect string            `json:"outputAspect"` // override template's aspect
	APIKey       string            `json:"apiKey,omitempty"`
}

// ─── Port interfaces ─────────────────────────────────────────────────────────

// PromptTemplateCatalog là port truy xuất prompt templates.
type PromptTemplateCatalog interface {
	List(surface, category, model, query string) ([]*PromptTemplate, error)
	GetByID(id string) (*PromptTemplate, error)
	Reload() error
}
```

**Verify**: `cd services/media-service && go vet ./internal/domain/...`

---

## Checklist B1

- [x] B-05: `design-system-svc/internal/domain/design_system.go` — compile clean
- [x] B-06: `skill-service/internal/domain/design_template.go` — compile clean
- [x] B-07: `media-service/internal/domain/prompt_template.go` — compile clean, `ToSummary()` method OK
