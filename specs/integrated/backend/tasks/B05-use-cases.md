# B-19..B-22 — Use Cases

**Phase**: B3 | **Estimate**: ~7h | **Depends on**: B1 + B2 hoàn thành

---

## B-19 — `design-system-svc/internal/usecase/catalog_usecase.go`

**Estimate**: 2h

```go
package usecase

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"design-system-svc/internal/domain"
)

// CatalogUseCase encapsulates tất cả catalog operations.
type CatalogUseCase struct {
	catalog    domain.Catalog
	fileServer domain.FileServer
}

func NewCatalogUseCase(catalog domain.Catalog, fileServer domain.FileServer) *CatalogUseCase {
	return &CatalogUseCase{catalog: catalog, fileServer: fileServer}
}

// List returns filtered list of design systems.
func (uc *CatalogUseCase) List(category, query, source string) ([]*domain.DesignSystem, error) {
	return uc.catalog.List(category, query, source)
}

// Get returns a single DS by ID.
func (uc *CatalogUseCase) Get(id string) (*domain.DesignSystem, error) {
	return uc.catalog.GetByID(id)
}

// GetContext returns DSContext cho agent injection.
// DSContext chứa full content DESIGN.md + tokens.css để agent có đầy đủ context.
func (uc *CatalogUseCase) GetContext(id string) (*domain.DSContext, error) {
	ds, err := uc.catalog.GetByID(id)
	if err != nil {
		return nil, err
	}
	ctx := &domain.DSContext{
		ID:       ds.ID,
		Name:     ds.Name,
		Category: ds.Category,
	}
	// Load DESIGN.md
	if data, _, err := uc.fileServer.ReadFile(id, "DESIGN.md"); err == nil {
		ctx.DesignMD = string(data)
	}
	// Load tokens.css (chỉ nếu hasTokens)
	if ds.HasTokens {
		if data, _, err := uc.fileServer.ReadFile(id, "tokens.css"); err == nil {
			ctx.TokensCSS = string(data)
		}
	}
	// Load components.html (optional, chỉ nếu hasComponents)
	if ds.HasComponents {
		if data, _, err := uc.fileServer.ReadFile(id, "components.html"); err == nil {
			ctx.ComponentsHTML = string(data)
		}
	}
	return ctx, nil
}

// ServeFile returns a file's content và mime type.
func (uc *CatalogUseCase) ServeFile(dsID, relativePath string) ([]byte, string, error) {
	return uc.fileServer.ReadFile(dsID, relativePath)
}

// ListPreviewPages returns preview pages của một DS.
func (uc *CatalogUseCase) ListPreviewPages(id string) ([]domain.PreviewPage, error) {
	ds, err := uc.catalog.GetByID(id)
	if err != nil {
		return nil, err
	}
	if ds.PreviewPages == nil {
		return []domain.PreviewPage{}, nil
	}
	return ds.PreviewPages, nil
}

// GetPreviewPageByRole tìm preview page theo role và trả về HTML content.
func (uc *CatalogUseCase) GetPreviewPageByRole(id, role string) ([]byte, error) {
	ds, err := uc.catalog.GetByID(id)
	if err != nil {
		return nil, err
	}
	for _, p := range ds.PreviewPages {
		if p.Role == role {
			data, _, err := uc.fileServer.ReadFile(id, p.Path)
			return data, err
		}
	}
	// Fallback: thử serve trực tiếp từ role name
	guessedPaths := []string{
		fmt.Sprintf("preview/%s.html", role),
		fmt.Sprintf("%s.html", role),
	}
	for _, path := range guessedPaths {
		if data, _, err := uc.fileServer.ReadFile(id, path); err == nil {
			return data, nil
		}
	}
	return nil, fmt.Errorf("preview page %q not found in ds %q", role, id)
}

// ServeAsset serves a file từ assets/ subdirectory của DS.
func (uc *CatalogUseCase) ServeAsset(dsID, assetSubPath string) ([]byte, string, error) {
	// Ensure path stays within assets/
	clean := filepath.Clean(assetSubPath)
	if strings.HasPrefix(clean, "..") {
		return nil, "", fmt.Errorf("invalid asset path")
	}
	// Strip leading "/" nếu có
	clean = strings.TrimPrefix(clean, "/")
	return uc.fileServer.ReadFile(dsID, filepath.Join("assets", clean))
}

// Reload triggers catalog reload từ disk.
func (uc *CatalogUseCase) Reload() error {
	return uc.catalog.Reload()
}

// Categories returns distinct categories từ tất cả DS.
func (uc *CatalogUseCase) Categories() ([]string, error) {
	all, err := uc.catalog.List("", "", "")
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var cats []string
	for _, ds := range all {
		if !seen[ds.Category] && ds.Category != "" {
			seen[ds.Category] = true
			cats = append(cats, ds.Category)
		}
	}
	return cats, nil
}

// Đảm bảo unused imports không gây lỗi compile
var _ = os.ReadFile
var _ = strings.TrimPrefix
```

**Verify**: `cd services/design-system-svc && go vet ./internal/usecase/...`

---

## B-20 — `skill-service/internal/usecase/template_usecase.go`

**Estimate**: 2h

```go
package usecase

import (
	"fmt"
	"mime"
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

// ServeExample reads và returns example.html content.
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

// ServeDerivedExample reads examples/<key>.html từ template directory.
func (uc *TemplateUseCase) ServeDerivedExample(id, key string) ([]byte, error) {
	t, err := uc.catalog.GetByID(id)
	if err != nil {
		return nil, err
	}
	// Security: key chỉ được chứa alphanumeric + hyphen/underscore
	if strings.ContainsAny(key, "/\\..") {
		return nil, fmt.Errorf("invalid example key: %q", key)
	}
	path := filepath.Join(t.DiskPath, "examples", key+".html")
	return os.ReadFile(path)
}

// ServeAsset reads asset file từ assets/ directory của template.
func (uc *TemplateUseCase) ServeAsset(id, assetPath string) ([]byte, string, error) {
	t, err := uc.catalog.GetByID(id)
	if err != nil {
		return nil, "", err
	}
	clean := filepath.Clean(assetPath)
	if strings.HasPrefix(clean, "..") {
		return nil, "", fmt.Errorf("invalid asset path: %q", assetPath)
	}
	// Strip leading "/"
	clean = strings.TrimPrefix(clean, "/")
	fullPath := filepath.Join(t.DiskPath, "assets", clean)
	data, err := os.ReadFile(fullPath)
	if err != nil {
		return nil, "", fmt.Errorf("asset not found: %q", assetPath)
	}
	ext := strings.ToLower(filepath.Ext(fullPath))
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return data, mimeType, nil
}

// Reload triggers catalog reload.
func (uc *TemplateUseCase) Reload() error {
	return uc.catalog.Reload()
}
```

**Verify**: `cd services/skill-service && go vet ./internal/usecase/...`

---

## B-21 + B-22 — `media-service/internal/usecase/template_usecase.go`

**Estimate**: 2.5h (gồm B-22 aspectToWidthHeight)

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
	catalog domain.PromptTemplateCatalog
	imageUC *GenerateImageUseCase
	logger  *zap.Logger
}

func NewTemplateUseCase(
	catalog domain.PromptTemplateCatalog,
	imageUC *GenerateImageUseCase,
	logger *zap.Logger,
) *TemplateUseCase {
	return &TemplateUseCase{catalog: catalog, imageUC: imageUC, logger: logger}
}

// ListTemplates returns filtered prompt templates (summary format).
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

// GetTemplate returns full detail của một prompt template.
func (uc *TemplateUseCase) GetTemplate(id string) (*domain.PromptTemplate, error) {
	return uc.catalog.GetByID(id)
}

// GenerateFromTemplate fills template arguments và dispatches generation.
func (uc *TemplateUseCase) GenerateFromTemplate(req *domain.GenerateFromTemplateRequest) (*domain.MediaJob, error) {
	t, err := uc.catalog.GetByID(req.TemplateID)
	if err != nil {
		return nil, fmt.Errorf("GenerateFromTemplate: template not found: %w", err)
	}

	// Fill {argument} placeholders với user values
	filledPrompt := prompt.FillArguments(t.RawPrompt, req.Values)

	uc.logger.Info("generating from template",
		zap.String("template_id", req.TemplateID),
		zap.String("surface", string(t.Surface)),
		zap.Int("values_count", len(req.Values)),
	)

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
		return uc.imageUC.Execute(imageReq, inferProvider(t.Model))

	case domain.SurfaceVideo:
		// Video generation placeholder — sẽ implement khi có VideoUseCase
		uc.logger.Warn("video generation from template not yet implemented",
			zap.String("template_id", req.TemplateID))
		return nil, fmt.Errorf("video generation from template not yet implemented")

	default:
		return nil, fmt.Errorf("unsupported surface: %q", t.Surface)
	}
}

// Reload triggers catalog reload.
func (uc *TemplateUseCase) Reload() error {
	return uc.catalog.Reload()
}

// ─── B-22: aspectToWidthHeight helper ────────────────────────────────────────

// aspectToWidthHeight converts aspect ratio string to pixel dimensions.
// Optimized for gpt-image-2 supported sizes.
func aspectToWidthHeight(aspect string) (width, height int) {
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
	case "3:2":
		return 1536, 1024
	case "2:3":
		return 1024, 1536
	case "21:9":
		return 1792, 768
	default:
		// Default to 1:1 nếu không nhận ra
		return 1024, 1024
	}
}

// inferProvider maps model name → provider name trong registry.
func inferProvider(model string) string {
	switch {
	case model == "" || model == "gpt-image-2" || model == "dall-e-3" || model == "dall-e-2":
		return "dalle"
	case model == "stable-diffusion-xl" || model == "sdxl":
		return "replicate"
	default:
		return "" // Let GenerateImageUseCase pick default
	}
}
```

**Verify**: `cd services/media-service && go vet ./internal/usecase/...`

---

## Checklist B3

- [x] B-19: `design-system-svc/catalog_usecase.go` — List, Get, GetContext, ServeFile, ListPreviewPages, GetPreviewPageByRole, ServeAsset, Reload, Categories
- [x] B-20: `skill-service/template_usecase.go` — ListTemplates, GetTemplate, ServeExample, ServeDerivedExample, ServeAsset, Reload
- [x] B-21: `media-service/template_usecase.go` — ListTemplates (summary), GetTemplate (detail), GenerateFromTemplate, Reload
- [x] B-22: `aspectToWidthHeight` và `inferProvider` helpers hoạt động đúng với 8 aspect ratios
