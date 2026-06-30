# B-08..B-11 — Infrastructure: `design-system-svc`

**Phase**: B2A | **Estimate**: ~8.5h | **Depends on**: B-05

---

## B-08 — `manifest_loader.go`

**Target**: `services/design-system-svc/internal/infra/fs/manifest_loader.go`  
**Estimate**: 4h | **Critical path** — task quan trọng nhất

### Lý do phức tạp
- Phải handle **152 directories** trong `design-systems/`
- Hỗ trợ **2 format**: `manifest.json` (v1) ưu tiên, fallback `DESIGN.md` legacy
- **Bỏ qua** `_schema/`, `.gitkeep`, `README.md` (không phải DS)
- `sync.Map` cache để thread-safe, tránh race khi concurrent requests
- `Reload()` phải clear cache + reload từ disk

### Format 1: `manifest.json` (v1 schema)

Kiểm tra 1 DS thực tế để hiểu schema:
```bash
cat design-systems/airbnb/manifest.json | head -30
```

Schema mong đợi:
```json
{
  "schemaVersion": "1",
  "id": "airbnb",
  "name": "Airbnb Design System",
  "category": "Consumer App",
  "description": "...",
  "source": { "type": "bundled", "origin": "..." },
  "files": {
    "design": "DESIGN.md",
    "tokens": "tokens.css",
    "components": "components.html"
  },
  "preview": {
    "dir": "preview",
    "pages": [
      { "path": "preview/app.html", "role": "app", "title": "App Preview" },
      { "path": "preview/colors.html", "role": "colors", "title": "Colors" }
    ]
  }
}
```

### Format 2: Legacy `DESIGN.md` (fallback)

Kiểm tra 1 DS legacy:
```bash
head -10 design-systems/apple/DESIGN.md
```

Parse pattern:
```
# Design System Inspired by Apple
> Category: Consumer App
```

### Code đầy đủ

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
	Dir   string                `json:"dir"`
	Pages []manifestPreviewPage `json:"pages"`
}

type manifestPreviewPage struct {
	Path  string `json:"path"`
	Role  string `json:"role"`
	Title string `json:"title"`
}

// ManifestLoader đọc tất cả DS từ catalogPath.
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
		// Bỏ qua: files, _schema/, .gitkeep, hidden dirs
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
		ID:          id,
		Name:        m.Name,
		Category:    m.Category,
		Description: m.Description,
		SourceType:  domain.DesignSystemSource(m.Source.Type),
		Status:      domain.StatusActive,
		ImportMode:  m.ImportMode,
		DiskPath:    dirPath,
	}
	if ds.SourceType == "" {
		ds.SourceType = domain.SourceBundled
	}
	if ds.Name == "" {
		ds.Name = slug
	}
	// Check file existence for HasTokens / HasComponents
	if m.Files.Tokens != "" {
		ds.HasTokens = fileExists(filepath.Join(dirPath, m.Files.Tokens))
	} else {
		ds.HasTokens = fileExists(filepath.Join(dirPath, "tokens.css"))
	}
	if m.Files.Components != "" {
		ds.HasComponents = fileExists(filepath.Join(dirPath, m.Files.Components))
	} else {
		ds.HasComponents = fileExists(filepath.Join(dirPath, "components.html"))
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
		return nil, fmt.Errorf("no manifest.json and no DESIGN.md in %q", slug)
	}
	name, category := parseLegacyDesignMD(string(data))
	if name == "" {
		name = slug
	}
	if category == "" {
		category = "General"
	}
	ds := &domain.DesignSystem{
		ID:            slug,
		Name:          name,
		Category:      category,
		SourceType:    domain.SourceBundled,
		Status:        domain.StatusActive,
		DiskPath:      dirPath,
		HasTokens:     fileExists(filepath.Join(dirPath, "tokens.css")),
		HasComponents: fileExists(filepath.Join(dirPath, "components.html")),
	}
	return ds, nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// parseLegacyDesignMD extracts name and category from legacy DESIGN.md format.
// Expected format:
//   # Design System Inspired by <Name>   ← line with "# "
//   > Category: <Category>               ← line with "> Category:"
func parseLegacyDesignMD(content string) (name, category string) {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "# ") && name == "" {
			raw := strings.TrimPrefix(line, "# ")
			raw = strings.TrimPrefix(raw, "Design System Inspired by ")
			raw = strings.TrimPrefix(raw, "Design System ")
			name = strings.TrimSpace(raw)
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

### Test commands sau khi implement B-08:

```bash
# Quick manual test
cd services/design-system-svc
DS_CATALOG_PATH=../../ui/open-design-vnpay/design-systems go run ./cmd/main.go &
sleep 1
curl -s http://localhost:8086/api/v1/design-systems | jq '.total'
# Expected: 152 (or similar)
curl -s http://localhost:8086/api/v1/design-systems/airbnb | jq '{id,name,category,hasTokens}'
```

---

## B-09 — `file_server.go`

**Target**: `services/design-system-svc/internal/infra/fs/file_server.go`  
**Estimate**: 1.5h

```go
package fs

import (
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"
)

// DiskFileServer serves files từ DesignSystem disk path.
type DiskFileServer struct {
	loader *ManifestLoader
}

func NewDiskFileServer(loader *ManifestLoader) *DiskFileServer {
	return &DiskFileServer{loader: loader}
}

// ReadFile returns content + mimeType của file trong DS.
// Chống path traversal: reject bất kỳ path nào chứa ".."
func (s *DiskFileServer) ReadFile(dsID, relativePath string) ([]byte, string, error) {
	ds, err := s.loader.GetByID(dsID)
	if err != nil {
		return nil, "", err
	}
	// Security: prevent path traversal
	clean := filepath.Clean(relativePath)
	if strings.HasPrefix(clean, "..") || strings.Contains(clean, "/../") {
		return nil, "", fmt.Errorf("invalid path: %q", relativePath)
	}
	fullPath := filepath.Join(ds.DiskPath, clean)
	data, err := os.ReadFile(fullPath)
	if err != nil {
		return nil, "", fmt.Errorf("file not found: %q in ds %q", relativePath, dsID)
	}
	ext := strings.ToLower(filepath.Ext(fullPath))
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		// Fallback mime types
		switch ext {
		case ".css":
			mimeType = "text/css; charset=utf-8"
		case ".html":
			mimeType = "text/html; charset=utf-8"
		case ".md":
			mimeType = "text/markdown; charset=utf-8"
		case ".svg":
			mimeType = "image/svg+xml"
		case ".woff2":
			mimeType = "font/woff2"
		default:
			mimeType = "application/octet-stream"
		}
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

## B-10 — Test ManifestLoader với 5 DS mẫu

**Estimate**: 2h

Kiểm tra thực tế với các DS đa dạng:

```bash
# 1. DS có manifest.json
curl -s http://localhost:8086/api/v1/design-systems/airbnb | jq .

# 2. DS có DESIGN.md legacy (nếu tồn tại)
curl -s http://localhost:8086/api/v1/design-systems/apple | jq '{id,name,category,sourceType}'

# 3. tokens.css serving
curl -s http://localhost:8086/api/v1/design-systems/airbnb/tokens.css | head -10

# 4. Preview pages (nếu có)
curl -s http://localhost:8086/api/v1/design-systems/airbnb/preview | jq .

# 5. Filter by category
curl -s "http://localhost:8086/api/v1/design-systems?category=Consumer%20App" | jq '.total'

# 6. Search
curl -s "http://localhost:8086/api/v1/design-systems?q=ant" | jq '.items[].name'
```

**Expected**: Tất cả 152 DS load được, không có crash/panic.

---

## B-11 — Test legacy DESIGN.md fallback

**Estimate**: 1h

```bash
# Tìm DS không có manifest.json
for dir in design-systems/*/; do
  if [ ! -f "$dir/manifest.json" ] && [ -f "$dir/DESIGN.md" ]; then
    echo "LEGACY: $dir"
  fi
done

# Test 1 DS legacy qua API
# (sau khi xác định được tên)
curl -s http://localhost:8086/api/v1/design-systems/<legacy-id> | jq '{name,category,sourceType}'
```

**Edge cases phải pass**:
- `_schema/` → bỏ qua (không phải DS)
- `README.md` → bỏ qua (không phải dir)
- DS không có `tokens.css` → `hasTokens: false`
- DS không có `components.html` → `hasComponents: false`

---

## Checklist B2A

- [x] B-08: `manifest_loader.go` — 150 DS loaded, handle cả 2 format, `_schema/` skipped
- [x] B-09: `file_server.go` — path traversal check OK, MIME type resolution OK
- [x] B-10: 5 DS mẫu trả về đúng JSON structure (airbnb: id, name, category, hasTokens)
- [x] B-11: Legacy DESIGN.md DS load được, `_schema/` bị skip ✓
