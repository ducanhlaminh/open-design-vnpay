# B-23..B-28 — HTTP Handlers

**Phase**: B4 | **Estimate**: ~11h | **Depends on**: B3 (use cases)

---

## B-23 + B-24 — `design-system-svc/internal/adapter/http/handler.go`

**Estimate**: 4h (gồm B-24 serveFile helper)

```go
package http

import (
	"mime"
	"net/http"
	"path/filepath"
	"strings"

	"design-system-svc/internal/usecase"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// DSHandler phục vụ tất cả HTTP routes của design-system-svc.
type DSHandler struct {
	catalogUC *usecase.CatalogUseCase
	logger    *zap.Logger
}

func NewDSHandler(catalogUC *usecase.CatalogUseCase, logger *zap.Logger) *DSHandler {
	return &DSHandler{catalogUC: catalogUC, logger: logger}
}

// RegisterRoutes đăng ký tất cả routes.
func (h *DSHandler) RegisterRoutes(r *gin.Engine) {
	// CORS middleware — cho phép browser request từ Vite dev server
	r.Use(func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	})

	api := r.Group("/api/v1")
	{
		// Catalog
		api.GET("/design-systems",              h.List)
		api.GET("/design-systems/:id",          h.Get)
		api.GET("/design-systems/:id/context",  h.GetContext)
		api.GET("/design-systems/-/categories", h.Categories)
		api.POST("/design-systems/-/reload",    h.Reload)

		// File serving — direct file content
		api.GET("/design-systems/:id/design.md",     h.ServeDesignMD)
		api.GET("/design-systems/:id/tokens.css",    h.ServeTokensCSS)
		api.GET("/design-systems/:id/components",    h.ServeComponents)

		// Preview pages
		api.GET("/design-systems/:id/preview",       h.ListPreviewPages)
		api.GET("/design-systems/:id/preview/:role", h.ServePreviewPage)

		// Assets (catch-all)
		api.GET("/design-systems/:id/assets/*path",  h.ServeAsset)
	}
	r.GET("/health", h.Health)
}

// GET /api/v1/design-systems?category=&q=&source=
func (h *DSHandler) List(c *gin.Context) {
	list, err := h.catalogUC.List(
		c.Query("category"),
		c.Query("q"),
		c.Query("source"),
	)
	if err != nil {
		h.logger.Error("List failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": list, "total": len(list)})
}

// GET /api/v1/design-systems/:id
func (h *DSHandler) Get(c *gin.Context) {
	ds, err := h.catalogUC.Get(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, ds)
}

// GET /api/v1/design-systems/:id/context
func (h *DSHandler) GetContext(c *gin.Context) {
	ctx, err := h.catalogUC.GetContext(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, ctx)
}

// GET /api/v1/design-systems/-/categories
func (h *DSHandler) Categories(c *gin.Context) {
	cats, err := h.catalogUC.Categories()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"categories": cats})
}

// GET /api/v1/design-systems/:id/design.md
func (h *DSHandler) ServeDesignMD(c *gin.Context) {
	h.serveFile(c, c.Param("id"), "DESIGN.md")
}

// GET /api/v1/design-systems/:id/tokens.css
func (h *DSHandler) ServeTokensCSS(c *gin.Context) {
	h.serveFile(c, c.Param("id"), "tokens.css")
}

// GET /api/v1/design-systems/:id/components
func (h *DSHandler) ServeComponents(c *gin.Context) {
	h.serveFile(c, c.Param("id"), "components.html")
}

// GET /api/v1/design-systems/:id/preview
func (h *DSHandler) ListPreviewPages(c *gin.Context) {
	pages, err := h.catalogUC.ListPreviewPages(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"pages": pages})
}

// GET /api/v1/design-systems/:id/preview/:role
func (h *DSHandler) ServePreviewPage(c *gin.Context) {
	id, role := c.Param("id"), c.Param("role")
	data, err := h.catalogUC.GetPreviewPageByRole(id, role)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	h.writeHTML(c, data)
}

// GET /api/v1/design-systems/:id/assets/*path
func (h *DSHandler) ServeAsset(c *gin.Context) {
	assetPath := c.Param("path") // Gin: includes leading "/"
	data, mimeType, err := h.catalogUC.ServeAsset(c.Param("id"), assetPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.Data(http.StatusOK, mimeType, data)
}

// POST /api/v1/design-systems/-/reload
func (h *DSHandler) Reload(c *gin.Context) {
	if err := h.catalogUC.Reload(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "reloaded"})
}

// GET /health
func (h *DSHandler) Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "design-system-svc"})
}

// ─── B-24: serveFile helper ──────────────────────────────────────────────────

// serveFile reads a file từ DS và writes HTTP response với đúng Content-Type.
// - Cho phép iframe embedding (X-Frame-Options: SAMEORIGIN)
// - Block path traversal (handled trong FileServer)
func (h *DSHandler) serveFile(c *gin.Context, dsID, relativePath string) {
	data, mimeType, err := h.catalogUC.ServeFile(dsID, relativePath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	// Allow embedding từ same origin (cho iframe previews)
	c.Header("X-Frame-Options", "SAMEORIGIN")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, mimeType, data)
}

// writeHTML là shortcut cho HTML response.
func (h *DSHandler) writeHTML(c *gin.Context, data []byte) {
	c.Header("X-Frame-Options", "SAMEORIGIN")
	c.Data(http.StatusOK, "text/html; charset=utf-8", data)
}

// mimeFromPath là fallback mime detection từ file extension.
func mimeFromPath(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if m := mime.TypeByExtension(ext); m != "" {
		return m
	}
	switch ext {
	case ".css":
		return "text/css; charset=utf-8"
	case ".html":
		return "text/html; charset=utf-8"
	case ".md":
		return "text/markdown; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}
```

**API Routes summary**:

| Method | Path | Handler |
|--------|------|---------|
| GET | `/api/v1/design-systems` | List |
| GET | `/api/v1/design-systems/:id` | Get |
| GET | `/api/v1/design-systems/:id/context` | GetContext |
| GET | `/api/v1/design-systems/-/categories` | Categories |
| GET | `/api/v1/design-systems/:id/design.md` | ServeDesignMD |
| GET | `/api/v1/design-systems/:id/tokens.css` | ServeTokensCSS |
| GET | `/api/v1/design-systems/:id/components` | ServeComponents |
| GET | `/api/v1/design-systems/:id/preview` | ListPreviewPages |
| GET | `/api/v1/design-systems/:id/preview/:role` | ServePreviewPage |
| GET | `/api/v1/design-systems/:id/assets/*path` | ServeAsset |
| POST | `/api/v1/design-systems/-/reload` | Reload |

---

## B-25 + B-26 — Cập nhật `skill-service/internal/adapter/http/handler.go`

**Estimate**: 3.5h

### B-26: Cập nhật struct và constructor (làm trước)

```go
// Sửa SkillHandler struct — thêm templateUC
type SkillHandler struct {
	catalogUC  *usecase.CatalogUseCase
	templateUC *usecase.TemplateUseCase  // ← THÊM MỚI
	logger     *zap.Logger
}

// Sửa constructor
func NewSkillHandler(
	catalogUC *usecase.CatalogUseCase,
	templateUC *usecase.TemplateUseCase,  // ← THÊM MỚI
	logger *zap.Logger,
) *SkillHandler {
	return &SkillHandler{catalogUC: catalogUC, templateUC: templateUC, logger: logger}
}
```

### B-25: Thêm routes và handlers

Thêm vào `RegisterRoutes`:
```go
// ← THÊM MỚI: Design Template routes
v1.GET("/design-templates",                    h.ListTemplates)
v1.GET("/design-templates/:id",               h.GetTemplate)
v1.GET("/design-templates/:id/example",       h.ServeExample)
v1.GET("/design-templates/:id/examples/:key", h.ServeDerivedExample)
v1.GET("/design-templates/:id/assets/*path",  h.ServeTemplateAsset)
v1.POST("/design-templates/-/reload",         h.ReloadTemplates)
```

Thêm handler methods:
```go
// GET /api/v1/design-templates?mode=&q=&scenario=
func (h *SkillHandler) ListTemplates(c *gin.Context) {
	list, err := h.templateUC.ListTemplates(
		c.Query("mode"),
		c.Query("q"),
		c.Query("scenario"),
	)
	if err != nil {
		h.logger.Error("ListTemplates failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": list, "total": len(list)})
}

// GET /api/v1/design-templates/:id
func (h *SkillHandler) GetTemplate(c *gin.Context) {
	t, err := h.templateUC.GetTemplate(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, t)
}

// GET /api/v1/design-templates/:id/example
func (h *SkillHandler) ServeExample(c *gin.Context) {
	data, err := h.templateUC.ServeExample(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.Header("X-Frame-Options", "SAMEORIGIN")
	c.Data(http.StatusOK, "text/html; charset=utf-8", data)
}

// GET /api/v1/design-templates/:id/examples/:key
func (h *SkillHandler) ServeDerivedExample(c *gin.Context) {
	data, err := h.templateUC.ServeDerivedExample(c.Param("id"), c.Param("key"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.Header("X-Frame-Options", "SAMEORIGIN")
	c.Data(http.StatusOK, "text/html; charset=utf-8", data)
}

// GET /api/v1/design-templates/:id/assets/*path
func (h *SkillHandler) ServeTemplateAsset(c *gin.Context) {
	data, mimeType, err := h.templateUC.ServeAsset(c.Param("id"), c.Param("path"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.Data(http.StatusOK, mimeType, data)
}

// POST /api/v1/design-templates/-/reload
func (h *SkillHandler) ReloadTemplates(c *gin.Context) {
	if err := h.templateUC.Reload(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "reloaded"})
}
```

**Verify**: `cd services/skill-service && go build ./...`

---

## B-27 + B-28 — Cập nhật `media-service/internal/adapter/http/handler.go`

**Estimate**: 3.5h

### B-28: Cập nhật struct và constructor (làm trước)

```go
// Sửa MediaHandler struct
type MediaHandler struct {
	imageUC    *usecase.GenerateImageUseCase
	audioUC    *usecase.GenerateAudioUseCase
	jobUC      *usecase.JobUseCase
	templateUC *usecase.TemplateUseCase  // ← THÊM MỚI
	logger     *zap.Logger
}

// Sửa constructor
func NewMediaHandler(
	imageUC    *usecase.GenerateImageUseCase,
	audioUC    *usecase.GenerateAudioUseCase,
	jobUC      *usecase.JobUseCase,
	templateUC *usecase.TemplateUseCase,  // ← THÊM MỚI
	logger     *zap.Logger,
) *MediaHandler {
	return &MediaHandler{
		imageUC: imageUC, audioUC: audioUC,
		jobUC: jobUC, templateUC: templateUC, logger: logger,
	}
}
```

### B-27: Thêm routes và handlers

Thêm vào `RegisterRoutes`:
```go
// ← THÊM MỚI: Prompt Template routes
api.GET("/prompt-templates",                    h.ListPromptTemplates)
api.GET("/prompt-templates/:id",               h.GetPromptTemplate)
api.GET("/prompt-templates/:id/preview",       h.RedirectPromptPreview)
api.POST("/media/generate-from-template",      h.GenerateFromTemplate)
api.POST("/prompt-templates/-/reload",         h.ReloadPromptTemplates)
```

Thêm handler methods:
```go
// GET /api/v1/prompt-templates?surface=&category=&model=&q=
func (h *MediaHandler) ListPromptTemplates(c *gin.Context) {
	list, err := h.templateUC.ListTemplates(
		c.Query("surface"),
		c.Query("category"),
		c.Query("model"),
		c.Query("q"),
	)
	if err != nil {
		h.logger.Error("ListPromptTemplates failed", zap.Error(err))
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
func (h *MediaHandler) RedirectPromptPreview(c *gin.Context) {
	t, err := h.templateUC.GetTemplate(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if t.PreviewImageURL == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "no preview image for this template"})
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
		h.logger.Error("GenerateFromTemplate failed",
			zap.String("template_id", req.TemplateID),
			zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusAccepted, job)
}

// POST /api/v1/prompt-templates/-/reload
func (h *MediaHandler) ReloadPromptTemplates(c *gin.Context) {
	if err := h.templateUC.Reload(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "reloaded"})
}
```

**Verify**: `cd services/media-service && go build ./...`

---

## Checklist B4

- [x] B-23: `design-system-svc/handler.go` — 11 routes, CORS middleware
- [x] B-24: `serveFile` helper với path traversal check, đúng Content-Type
- [x] B-25: `skill-service/handler.go` — 6 template routes thêm vào (giữ nguyên skill routes)
- [x] B-26: `SkillHandler` struct và constructor cập nhật với `templateUC`
- [x] B-27: `media-service/handler.go` — 5 prompt-template routes thêm vào
- [x] B-28: `MediaHandler` struct và constructor cập nhật với `templateUC`
