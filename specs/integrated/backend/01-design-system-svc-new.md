# 01 — Tạo Mới `design-system-svc`

> **Vị trí**: `services/design-system-svc/`  
> **Vai trò**: Serve 150+ design systems từ `design-systems/` directory  
> **Pattern**: Clean Architecture — giống `skill-service` (adapter/domain/infra/usecase)  
> **HTTP**: Gin + port 8086 (hoặc cấu hình qua `PORT` env)

---

## 1. Cấu trúc thư mục

```
services/design-system-svc/
├── cmd/
│   └── main.go                          # Bootstrap
├── internal/
│   ├── domain/
│   │   └── design_system.go             # Domain model + interfaces
│   ├── usecase/
│   │   ├── catalog_usecase.go           # List, Get, file serving
│   │   └── ports.go                     # Port interfaces
│   ├── infra/
│   │   └── fs/
│   │       ├── manifest_loader.go       # manifest.json (v1 schema)
│   │       ├── legacy_loader.go         # DESIGN.md fallback (legacy format)
│   │       └── file_server.go           # Serve tokens.css, components.html, assets
│   └── adapter/
│       └── http/
│           └── handler.go               # Gin handler, tất cả routes
├── go.mod
└── Dockerfile
```

---

## 2. Domain Model (`internal/domain/design_system.go`)

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
    DiskPath      string             `json:"-"` // absolute path trên disk, không expose
    CreatedAt     time.Time          `json:"createdAt,omitempty"`
}

// DSContext là dữ liệu inject vào agent context.
type DSContext struct {
    ID             string `json:"id"`
    Name           string `json:"name"`
    Category       string `json:"category"`
    DesignMD       string `json:"designMd"`    // content của DESIGN.md
    TokensCSS      string `json:"tokensCSS"`   // content của tokens.css
    ComponentsHTML string `json:"componentsHTML,omitempty"`
}

// ─── Ports ───────────────────────────────────────────────────────────────────

// Catalog là port truy xuất danh sách DS.
type Catalog interface {
    List(category, query, source string) ([]*DesignSystem, error)
    GetByID(id string) (*DesignSystem, error)
    Reload() error
}

// FileServer là port serve file assets của DS.
type FileServer interface {
    ReadFile(dsID, relativePath string) ([]byte, string, error) // content, mimeType, error
    FileExists(dsID, relativePath string) bool
}
```

---

## 3. Manifest Loader (`internal/infra/fs/manifest_loader.go`)

```go
package fs

import (
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "strings"
    "sync"

    "design-system-svc/internal/domain"
)

// manifestV1 maps trực tiếp từ manifest.json schema.
type manifestV1 struct {
    SchemaVersion string           `json:"schemaVersion"`
    ID            string           `json:"id"`
    Name          string           `json:"name"`
    Category      string           `json:"category"`
    Description   string           `json:"description"`
    Source        manifestSource   `json:"source"`
    Files         manifestFiles    `json:"files"`
    Preview       *manifestPreview `json:"preview,omitempty"`
    ImportMode    string           `json:"importMode,omitempty"`
}

type manifestSource struct {
    Type   string `json:"type"`
    Origin string `json:"origin"`
}

type manifestFiles struct {
    Design     string `json:"design"`
    Tokens     string `json:"tokens"`
    Components string `json:"components"`
}

type manifestPreview struct {
    Dir   string                  `json:"dir"`
    Pages []manifestPreviewPage   `json:"pages"`
}

type manifestPreviewPage struct {
    Path  string `json:"path"`
    Role  string `json:"role"`
    Title string `json:"title"`
}

// ManifestLoader đọc tất cả DS từ catalogPath, ưu tiên manifest.json.
type ManifestLoader struct {
    catalogPath string
    cache       sync.Map   // id → *domain.DesignSystem
    mu          sync.Mutex
    loaded      bool
}

func NewManifestLoader(catalogPath string) *ManifestLoader {
    if catalogPath == "" {
        catalogPath = os.Getenv("DS_CATALOG_PATH")
    }
    if catalogPath == "" {
        catalogPath = "./design-systems"
    }
    return &ManifestLoader{catalogPath: catalogPath}
}

// List returns all DS, loading from disk if needed.
func (l *ManifestLoader) List(category, query, source string) ([]*domain.DesignSystem, error) {
    all, err := l.loadAll()
    if err != nil {
        return nil, err
    }
    var out []*domain.DesignSystem
    for _, ds := range all {
        if category != "" && !strings.EqualFold(ds.Category, category) {
            continue
        }
        if source != "" && string(ds.SourceType) != source {
            continue
        }
        if query != "" {
            q := strings.ToLower(query)
            if !strings.Contains(strings.ToLower(ds.Name), q) &&
                !strings.Contains(strings.ToLower(ds.Description), q) {
                continue
            }
        }
        out = append(out, ds)
    }
    return out, nil
}

// GetByID returns a single DS by ID.
func (l *ManifestLoader) GetByID(id string) (*domain.DesignSystem, error) {
    if v, ok := l.cache.Load(id); ok {
        return v.(*domain.DesignSystem), nil
    }
    if _, err := l.loadAll(); err != nil {
        return nil, err
    }
    if v, ok := l.cache.Load(id); ok {
        return v.(*domain.DesignSystem), nil
    }
    return nil, fmt.Errorf("design system %q not found", id)
}

// Reload clears cache and reloads from disk.
func (l *ManifestLoader) Reload() error {
    l.mu.Lock()
    l.loaded = false
    l.mu.Unlock()
    l.cache.Range(func(k, _ any) bool { l.cache.Delete(k); return true })
    _, err := l.loadAll()
    return err
}

func (l *ManifestLoader) loadAll() ([]*domain.DesignSystem, error) {
    l.mu.Lock()
    defer l.mu.Unlock()
    if l.loaded {
        var result []*domain.DesignSystem
        l.cache.Range(func(_, v any) bool {
            result = append(result, v.(*domain.DesignSystem))
            return true
        })
        return result, nil
    }

    entries, err := os.ReadDir(l.catalogPath)
    if err != nil {
        if os.IsNotExist(err) {
            return []*domain.DesignSystem{}, nil
        }
        return nil, fmt.Errorf("manifest_loader: read dir: %w", err)
    }

    var result []*domain.DesignSystem
    for _, e := range entries {
        if !e.IsDir() || strings.HasPrefix(e.Name(), "_") || strings.HasPrefix(e.Name(), ".") {
            continue
        }
        dsDir := filepath.Join(l.catalogPath, e.Name())
        ds, err := l.loadOneDir(e.Name(), dsDir)
        if err != nil {
            fmt.Printf("[WARN] design-system-svc: skipping %q: %v\n", e.Name(), err)
            continue
        }
        l.cache.Store(ds.ID, ds)
        result = append(result, ds)
    }
    l.loaded = true
    return result, nil
}

func (l *ManifestLoader) loadOneDir(slug, dirPath string) (*domain.DesignSystem, error) {
    manifestPath := filepath.Join(dirPath, "manifest.json")
    if data, err := os.ReadFile(manifestPath); err == nil {
        return l.fromManifest(slug, dirPath, data)
    }
    // Fallback: legacy DESIGN.md format
    return l.fromLegacyDesignMD(slug, dirPath)
}

func (l *ManifestLoader) fromManifest(slug, dirPath string, data []byte) (*domain.DesignSystem, error) {
    var m manifestV1
    if err := json.Unmarshal(data, &m); err != nil {
        return nil, fmt.Errorf("parse manifest.json: %w", err)
    }
    id := m.ID
    if id == "" {
        id = slug
    }
    ds := &domain.DesignSystem{
        ID:         id,
        Name:       m.Name,
        Category:   m.Category,
        Description: m.Description,
        SourceType: domain.DesignSystemSource(m.Source.Type),
        Status:     domain.StatusActive,
        ImportMode: m.ImportMode,
        DiskPath:   dirPath,
    }
    if ds.SourceType == "" {
        ds.SourceType = domain.SourceBundled
    }
    // Check file existence
    if m.Files.Tokens != "" {
        ds.HasTokens = fileExists(filepath.Join(dirPath, m.Files.Tokens))
    }
    if m.Files.Components != "" {
        ds.HasComponents = fileExists(filepath.Join(dirPath, m.Files.Components))
    }
    // Preview pages
    if m.Preview != nil {
        for _, p := range m.Preview.Pages {
            ds.PreviewPages = append(ds.PreviewPages, domain.PreviewPage{
                Path:  p.Path,
                Role:  p.Role,
                Title: p.Title,
            })
        }
    }
    return ds, nil
}

func (l *ManifestLoader) fromLegacyDesignMD(slug, dirPath string) (*domain.DesignSystem, error) {
    designPath := filepath.Join(dirPath, "DESIGN.md")
    data, err := os.ReadFile(designPath)
    if err != nil {
        return nil, fmt.Errorf("no manifest.json and no DESIGN.md in %q", dirPath)
    }
    // Parse: first line = "# <Name>" and second meaningful line = "> Category: <cat>"
    name, category := parseLegacyDesignMD(string(data))
    if name == "" {
        name = slug
    }
    ds := &domain.DesignSystem{
        ID:         slug,
        Name:       name,
        Category:   category,
        SourceType: domain.SourceBundled,
        Status:     domain.StatusActive,
        DiskPath:   dirPath,
        HasTokens:  fileExists(filepath.Join(dirPath, "tokens.css")),
        HasComponents: fileExists(filepath.Join(dirPath, "components.html")),
    }
    return ds, nil
}

func fileExists(path string) bool {
    _, err := os.Stat(path)
    return err == nil
}

// parseLegacyDesignMD extracts name and category from legacy DESIGN.md format.
func parseLegacyDesignMD(content string) (name, category string) {
    lines := strings.Split(content, "\n")
    for _, line := range lines {
        line = strings.TrimSpace(line)
        if strings.HasPrefix(line, "# ") && name == "" {
            name = strings.TrimPrefix(line, "# ")
            // Strip "Design System Inspired by " prefix
            name = strings.TrimPrefix(name, "Design System Inspired by ")
        }
        if strings.HasPrefix(line, "> Category:") && category == "" {
            category = strings.TrimSpace(strings.TrimPrefix(line, "> Category:"))
        }
        if name != "" && category != "" {
            break
        }
    }
    return
}
```

---

## 4. File Server (`internal/infra/fs/file_server.go`)

```go
package fs

import (
    "fmt"
    "mime"
    "os"
    "path/filepath"
    "strings"
)

// DiskFileServer serves files from a DesignSystem's disk path.
type DiskFileServer struct {
    loader *ManifestLoader
}

func NewDiskFileServer(loader *ManifestLoader) *DiskFileServer {
    return &DiskFileServer{loader: loader}
}

// ReadFile returns the content + mime type of a file within a DS.
// relativePath examples: "tokens.css", "components.html", "preview/colors.html", "assets/logo.svg"
func (s *DiskFileServer) ReadFile(dsID, relativePath string) ([]byte, string, error) {
    ds, err := s.loader.GetByID(dsID)
    if err != nil {
        return nil, "", err
    }
    // Security: prevent path traversal
    clean := filepath.Clean(relativePath)
    if strings.HasPrefix(clean, "..") {
        return nil, "", fmt.Errorf("invalid path: %q", relativePath)
    }
    fullPath := filepath.Join(ds.DiskPath, clean)
    data, err := os.ReadFile(fullPath)
    if err != nil {
        return nil, "", fmt.Errorf("file not found: %q", relativePath)
    }
    ext := filepath.Ext(fullPath)
    mimeType := mime.TypeByExtension(ext)
    if mimeType == "" {
        mimeType = "application/octet-stream"
    }
    return data, mimeType, nil
}

// FileExists checks if a file exists within a DS.
func (s *DiskFileServer) FileExists(dsID, relativePath string) bool {
    ds, err := s.loader.GetByID(dsID)
    if err != nil {
        return false
    }
    clean := filepath.Clean(relativePath)
    if strings.HasPrefix(clean, "..") {
        return false
    }
    return fileExists(filepath.Join(ds.DiskPath, clean))
}
```

---

## 5. Use Cases (`internal/usecase/catalog_usecase.go`)

```go
package usecase

import (
    "fmt"
    "os"

    "design-system-svc/internal/domain"
)

// CatalogUseCase encapsulates catalog operations.
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

// GetContext returns the DSContext for agent injection.
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
    if data, _, err := uc.fileServer.ReadFile(id, "DESIGN.md"); err == nil {
        ctx.DesignMD = string(data)
    }
    if ds.HasTokens {
        if data, _, err := uc.fileServer.ReadFile(id, "tokens.css"); err == nil {
            ctx.TokensCSS = string(data)
        }
    }
    if ds.HasComponents {
        if data, _, err := uc.fileServer.ReadFile(id, "components.html"); err == nil {
            ctx.ComponentsHTML = string(data)
        }
    }
    return ctx, nil
}

// ServeFile returns a file's content and mime type.
func (uc *CatalogUseCase) ServeFile(dsID, relativePath string) ([]byte, string, error) {
    return uc.fileServer.ReadFile(dsID, relativePath)
}

// ListPreviewPages returns the preview pages for a DS.
func (uc *CatalogUseCase) ListPreviewPages(id string) ([]domain.PreviewPage, error) {
    ds, err := uc.catalog.GetByID(id)
    if err != nil {
        return nil, err
    }
    return ds.PreviewPages, nil
}

// Reload triggers a catalog reload from disk.
func (uc *CatalogUseCase) Reload() error {
    return uc.catalog.Reload()
}
```

---

## 6. HTTP Handler (`internal/adapter/http/handler.go`)

```go
package http

import (
    "net/http"
    "path/filepath"

    "design-system-svc/internal/usecase"

    "github.com/gin-gonic/gin"
    "go.uber.org/zap"
)

type DSHandler struct {
    catalogUC *usecase.CatalogUseCase
    logger    *zap.Logger
}

func NewDSHandler(catalogUC *usecase.CatalogUseCase, logger *zap.Logger) *DSHandler {
    return &DSHandler{catalogUC: catalogUC, logger: logger}
}

func (h *DSHandler) RegisterRoutes(r *gin.Engine) {
    api := r.Group("/api/v1")
    {
        // Catalog
        api.GET("/design-systems",          h.List)
        api.GET("/design-systems/:id",      h.Get)
        api.GET("/design-systems/:id/context", h.GetContext)
        api.POST("/design-systems/-/reload",   h.Reload)

        // File serving
        api.GET("/design-systems/:id/design.md",    h.ServeDesignMD)
        api.GET("/design-systems/:id/tokens.css",   h.ServeTokensCSS)
        api.GET("/design-systems/:id/components",   h.ServeComponents)
        api.GET("/design-systems/:id/preview",      h.ListPreviewPages)
        api.GET("/design-systems/:id/preview/:role", h.ServePreviewPage)
        api.GET("/design-systems/:id/assets/*path", h.ServeAsset)
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
    pages, err := h.catalogUC.ListPreviewPages(id)
    if err != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
        return
    }
    for _, p := range pages {
        if p.Role == role {
            h.serveFile(c, id, p.Path)
            return
        }
    }
    c.JSON(http.StatusNotFound, gin.H{"error": "preview page not found: " + role})
}

// GET /api/v1/design-systems/:id/assets/*path
func (h *DSHandler) ServeAsset(c *gin.Context) {
    assetPath := filepath.Join("assets", c.Param("path"))
    h.serveFile(c, c.Param("id"), assetPath)
}

// POST /api/v1/design-systems/-/reload
func (h *DSHandler) Reload(c *gin.Context) {
    if err := h.catalogUC.Reload(); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, gin.H{"status": "reloaded"})
}

func (h *DSHandler) Health(c *gin.Context) {
    c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "design-system-svc"})
}

// serveFile is a helper that reads a file and writes it as the HTTP response.
func (h *DSHandler) serveFile(c *gin.Context, dsID, relativePath string) {
    data, mimeType, err := h.catalogUC.ServeFile(dsID, relativePath)
    if err != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
        return
    }
    // Allow iframe embedding from same origin
    c.Header("X-Frame-Options", "SAMEORIGIN")
    c.Data(http.StatusOK, mimeType, data)
}
```

---

## 7. Bootstrap (`cmd/main.go`)

```go
package main

import (
    "os"
    "design-system-svc/internal/adapter/http"
    "design-system-svc/internal/infra/fs"
    "design-system-svc/internal/usecase"

    "github.com/gin-gonic/gin"
    "go.uber.org/zap"
)

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    catalogPath := os.Getenv("DS_CATALOG_PATH")
    loader := fs.NewManifestLoader(catalogPath)
    fileServer := fs.NewDiskFileServer(loader)
    catalogUC := usecase.NewCatalogUseCase(loader, fileServer)

    // Pre-load catalog on startup
    if err := catalogUC.Reload(); err != nil {
        logger.Warn("catalog pre-load failed", zap.Error(err))
    }

    r := gin.New()
    r.Use(gin.Recovery())
    handler := http.NewDSHandler(catalogUC, logger)
    handler.RegisterRoutes(r)

    port := os.Getenv("PORT")
    if port == "" {
        port = "8086"
    }
    logger.Info("design-system-svc starting", zap.String("port", port))
    r.Run(":" + port)
}
```

---

## 8. `go.mod`

```go
module design-system-svc

go 1.22.0

require (
    github.com/gin-gonic/gin v1.10.0
    go.uber.org/zap v1.27.0
)
```

---

## 9. `Dockerfile`

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o design-system-svc ./cmd/main.go

FROM alpine:3.19
WORKDIR /app
COPY --from=builder /app/design-system-svc .
EXPOSE 8086
ENV DS_CATALOG_PATH=/catalog
CMD ["./design-system-svc"]
```

---

## 10. Thêm vào `go.work`

```
use ./design-system-svc
```

---

## 11. API Summary

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/api/v1/design-systems` | List (filter: `?category=&q=&source=`) |
| GET | `/api/v1/design-systems/:id` | Detail |
| GET | `/api/v1/design-systems/:id/context` | DSContext cho agent injection |
| GET | `/api/v1/design-systems/:id/design.md` | Raw DESIGN.md |
| GET | `/api/v1/design-systems/:id/tokens.css` | Raw tokens.css |
| GET | `/api/v1/design-systems/:id/components` | components.html |
| GET | `/api/v1/design-systems/:id/preview` | List preview pages |
| GET | `/api/v1/design-systems/:id/preview/:role` | Specific preview page HTML |
| GET | `/api/v1/design-systems/:id/assets/*path` | Asset files |
| POST | `/api/v1/design-systems/-/reload` | Reload catalog from disk |
| GET | `/health` | Health check |

---

## Implementation Status

> **Cập nhật**: 2026-06-04 — **HOÀN THÀNH** ✅

### Đã implement

| §  | Nội dung | File | Status |
|----|----------|------|--------|
| §1 | Cấu trúc thư mục | `services/design-system-svc/` | ✅ Đúng spec (cmd, domain, infra/fs, usecase, adapter/http) |
| §2 | Domain Model | `internal/domain/design_system.go` | ✅ `DesignSystem`, `PreviewPage`, `Catalog` interface |
| §3 | Manifest Loader | `internal/infra/fs/manifest_loader.go` | ✅ Đọc `manifest.json` + legacy `DESIGN.md`, sync.Map cache, 150+ DS |
| §4 | File Server | `internal/infra/fs/file_server.go` | ✅ `DiskFileServer`, mime detection, path traversal blocked |
| §5 | Use Cases | `internal/usecase/catalog_usecase.go` | ✅ List, Get, GetContext, ServeFile, ListPreviewPages, GetPreviewPageByRole, ServeAsset, Reload, Categories |
| §6 | HTTP Handler | `internal/adapter/http/handler.go` | ✅ 11 routes, CORS middleware, `serveFile` helper, `X-Frame-Options` |
| §7 | Bootstrap | `cmd/main.go` | ✅ Graceful shutdown, pre-warm catalog, port :8086 |
| §8 | `go.mod` | `go.mod` (gin + zap) | ✅ |
| §9 | `Dockerfile` | `Dockerfile` | ✅ |
| §10 | `go.work` | `services/go.work` | ✅ `use ./design-system-svc` |
| §11 | API Summary | nginx + docker-compose | ✅ Deployed (:18086 host) |

### Khác biệt vs spec (implementation decisions)

- **Spec §1**: mô tả `legacy_loader.go` riêng biệt → **Impl**: legacy fallback tích hợp trực tiếp trong `manifest_loader.go` (ít file hơn, dễ maintain)
- **Spec §5**: `ports.go` riêng → **Impl**: interfaces định nghĩa trực tiếp trong `catalog_usecase.go`
- **Spec §6**: CORS config trong gateway → **Impl**: CORS middleware trực tiếp trong handler (safe for standalone dev)

### Build

```
cd services/design-system-svc && go build ./...  → EXIT 0 ✓
```
