# B-12..B-14 — Infrastructure: `skill-service` (Design Templates)

**Phase**: B2B | **Estimate**: ~5h | **Depends on**: B-06

---

## B-12 — `template_loader.go`

**Target**: `services/skill-service/internal/infra/fs/template_loader.go`  
**Estimate**: 3h

### Quan sát thực tế về SKILL.md format

Trước khi code, cần kiểm tra một số SKILL.md:
```bash
head -40 design-templates/blog-post/SKILL.md
head -40 design-templates/audio-jingle/SKILL.md
head -40 design-templates/critique/SKILL.md
```

Format YAML frontmatter mong đợi:
```yaml
---
name: "Blog Post Template"
description: "Generate a professional blog post"
triggers:
  - "write a blog post"
  - "create article"
od:
  mode: "template"
  platform: "desktop"
  scenario: "content-creation"
  inputs:
    - name: "topic"
      type: "string"
      required: true
      placeholder: "What topic to write about?"
    - name: "tone"
      type: "select"
      required: false
      default: "professional"
      options: ["professional", "casual", "technical"]
---

# Blog Post Template

Full description here...
```

> **Lưu ý**: `skill-service` đã có `github.com/goccy/go-yaml` trong go.mod — dùng thẳng, không cần thêm lib.

### Code đầy đủ

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

	"github.com/goccy/go-yaml"
)

// skillMDFrontmatter là YAML frontmatter schema của SKILL.md.
type skillMDFrontmatter struct {
	Name        string   `yaml:"name"`
	Description string   `yaml:"description"`
	Triggers    []string `yaml:"triggers"`
	OD          struct {
		Mode     string `yaml:"mode"`
		Platform string `yaml:"platform"`
		Scenario string `yaml:"scenario"`
		Inputs   []struct {
			Name        string   `yaml:"name"`
			Type        string   `yaml:"type"`
			Required    bool     `yaml:"required"`
			Default     string   `yaml:"default"`
			Options     []string `yaml:"options"`
			Placeholder string   `yaml:"placeholder"`
		} `yaml:"inputs"`
	} `yaml:"od"`
}

// TemplateLoader loads DesignTemplates từ filesystem.
// Mỗi template: templatesPath/<id>/SKILL.md + example.html (optional)
type TemplateLoader struct {
	templatesPath string
	cache         sync.Map // id → *domain.DesignTemplate
	mu            sync.Mutex
	loaded        bool
}

// NewTemplateLoader tạo loader. Falls back to DESIGN_TEMPLATES_PATH env.
func NewTemplateLoader(templatesPath string) *TemplateLoader {
	if templatesPath == "" {
		templatesPath = os.Getenv("DESIGN_TEMPLATES_PATH")
	}
	if templatesPath == "" {
		templatesPath = "./design-templates"
	}
	return &TemplateLoader{templatesPath: templatesPath}
}

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
		return nil, fmt.Errorf("template_loader: read dir %q: %w", l.templatesPath, err)
	}

	var result []*domain.DesignTemplate
	for _, e := range entries {
		// Chỉ load directories, bỏ qua AGENTS.md, README, etc.
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || strings.HasPrefix(e.Name(), "_") {
			continue
		}
		id := e.Name()
		dirPath := filepath.Join(l.templatesPath, id)
		t, err := l.loadOne(id, dirPath)
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
	fm, err := parseSKILLMDFrontmatter(data)
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
	// Default mode nếu không set
	if t.Mode == "" {
		t.Mode = domain.TemplateModePrototype
	}
	// Default triggers nếu nil
	if t.Triggers == nil {
		t.Triggers = []string{}
	}
	// Map inputs
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
	if t.Inputs == nil {
		t.Inputs = []domain.TemplateInput{}
	}
	return t, nil
}

// parseSKILLMDFrontmatter extracts YAML block between --- delimiters.
func parseSKILLMDFrontmatter(data []byte) (*skillMDFrontmatter, error) {
	content := strings.TrimSpace(string(data))
	if !strings.HasPrefix(content, "---") {
		return nil, fmt.Errorf("SKILL.md does not start with YAML frontmatter (---)")
	}
	// Split on "---": [empty, yaml, rest]
	parts := strings.SplitN(content, "---", 3)
	if len(parts) < 3 {
		return nil, fmt.Errorf("SKILL.md frontmatter not closed with ---")
	}
	yamlContent := parts[1]
	var fm skillMDFrontmatter
	if err := yaml.NewDecoder(bytes.NewReader([]byte(yamlContent))).Decode(&fm); err != nil {
		return nil, fmt.Errorf("YAML parse error: %w", err)
	}
	if fm.Name == "" {
		return nil, fmt.Errorf("SKILL.md missing 'name' field")
	}
	return &fm, nil
}

// fileExists là helper để check file existence.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
```

---

## B-13 — Verify yaml lib

**Estimate**: 0.5h

`skill-service/go.mod` đã có:
```
github.com/goccy/go-yaml v1.12.0
```

Không cần thêm lib. Chỉ cần verify import path đúng:
```go
import "github.com/goccy/go-yaml"
```

**Verify**: `cd services/skill-service && go build ./...`

---

## B-14 — Test TemplateLoader

**Estimate**: 1.5h

Kiểm tra thực tế với templates:
```bash
# Start skill-service với design-templates path
cd services/skill-service
SKILLS_PATH=../../ui/open-design-vnpay/skills \
DESIGN_TEMPLATES_PATH=../../ui/open-design-vnpay/design-templates \
HTTP_PORT=8082 go run ./cmd/main.go &

sleep 1

# Test 1: List tất cả
curl -s http://localhost:8082/api/v1/design-templates | jq '{total, first_item: .items[0].name}'

# Test 2: Filter by mode
curl -s "http://localhost:8082/api/v1/design-templates?mode=template" | jq '.total'

# Test 3: Template cụ thể
curl -s http://localhost:8082/api/v1/design-templates/blog-post | jq '{id,name,mode,inputs}'

# Test 4: Example serving
curl -s http://localhost:8082/api/v1/design-templates/blog-post/example | wc -c

# Test 5: Template không có example
curl -s http://localhost:8082/api/v1/design-templates/critique | jq '.hasExample'
# Expected: false

# Test 6: AGENTS.md bị skip (không phải dir)
curl -s http://localhost:8082/api/v1/design-templates/AGENTS.md
# Expected: 404
```

**Expected**: ~111 templates load được.

---

## Checklist B2B

- [x] B-12: `template_loader.go` — parse YAML frontmatter OK, 110 templates loaded
- [x] B-13: `goccy/go-yaml` import OK, go build clean
- [x] B-14: 110 templates load, filter by mode OK, AGENTS.md bị skip
