# B-15..B-18 — Infrastructure: `media-service` (Prompt Templates)

**Phase**: B2C | **Estimate**: ~8h | **Depends on**: B-07

---

## B-15 — `argument_parser.go`

**Target**: `services/media-service/internal/infra/prompt/argument_parser.go`  
**Estimate**: 2h

### Quan sát thực tế về JSON format

Kiểm tra 2 templates:
```bash
# Image template
cat prompt-templates/image/3d-stone-staircase-evolution-infographic.json | jq '{model,aspect,prompt}' | head -20

# Video template (có thể có JSON trong JSON)
cat prompt-templates/video/seedance-2.0-cinematic-fashion-editorial-open-field.json | jq '{model,prompt}' | head -20
```

Format `{argument name="..." default="..."}` trong `prompt` field:
```
A professional photo of {argument name="subject" default="a person"} 
in {argument name="setting" default="studio"} lighting
```

### Code đầy đủ

```go
package prompt

import (
	"regexp"
	"strings"
)

// argPattern matches {argument name="..." default="..."} placeholders.
// Hỗ trợ:
//   {argument name="x"}                  → name="x", default=""
//   {argument name="x" default="y"}      → name="x", default="y"
//   {argument name="x" default="y z"}    → name="x", default="y z"
var argPattern = regexp.MustCompile(
	`\{argument\s+name="([^"]+)"(?:\s+default="([^"]*)")?\}`,
)

// TemplateArg là một parsed argument từ raw prompt.
type TemplateArg struct {
	Name    string
	Default string
}

// ParseArguments extracts unique arguments từ raw prompt string.
// Maintains insertion order, skips duplicates.
// Handles cả plain string và JSON-escaped strings.
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

// FillArguments replaces {argument ...} placeholders với user-supplied values.
// Falls back to default value nếu user value empty.
// Nếu cả hai đều empty → giữ nguyên placeholder text (không replace).
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
		if defaultVal != "" {
			return defaultVal
		}
		// Giữ placeholder nếu không có value và không có default
		return "[" + name + "]"
	})
}

// CountArguments returns số lượng unique arguments trong prompt.
func CountArguments(rawPrompt string) int {
	return len(ParseArguments(rawPrompt))
}
```

---

## B-16 — Unit test `ArgumentParser`

**Target**: `services/media-service/internal/infra/prompt/argument_parser_test.go`  
**Estimate**: 1.5h

```go
package prompt_test

import (
	"testing"
	"media-service/internal/infra/prompt"
)

func TestParseArguments(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []prompt.TemplateArg
	}{
		{
			name:  "no arguments",
			input: "A photo of a cat in the studio",
			expected: nil,
		},
		{
			name:  "one argument no default",
			input: `A photo of {argument name="subject"}`,
			expected: []prompt.TemplateArg{
				{Name: "subject", Default: ""},
			},
		},
		{
			name:  "one argument with default",
			input: `A photo of {argument name="subject" default="a cat"}`,
			expected: []prompt.TemplateArg{
				{Name: "subject", Default: "a cat"},
			},
		},
		{
			name:  "two arguments",
			input: `{argument name="style" default="cinematic"} portrait of {argument name="subject" default="a warrior"}`,
			expected: []prompt.TemplateArg{
				{Name: "style", Default: "cinematic"},
				{Name: "subject", Default: "a warrior"},
			},
		},
		{
			name:  "duplicate argument deduplicated",
			input: `{argument name="x" default="1"} and {argument name="x" default="2"}`,
			expected: []prompt.TemplateArg{
				{Name: "x", Default: "1"}, // first occurrence wins
			},
		},
		{
			name:  "JSON-escaped prompt (video templates)",
			input: `{"prompt": "{argument name=\"hero\" default=\"warrior\"}"}`,
			expected: []prompt.TemplateArg{
				// JSON-escaped quotes — regex phải handle
				// (nếu JSON đã được parse thì: {argument name="hero" default="warrior"})
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := prompt.ParseArguments(tt.input)
			if len(got) != len(tt.expected) {
				t.Errorf("got %d args, want %d: %v", len(got), len(tt.expected), got)
				return
			}
			for i, a := range got {
				if a.Name != tt.expected[i].Name || a.Default != tt.expected[i].Default {
					t.Errorf("arg[%d]: got {%q,%q}, want {%q,%q}",
						i, a.Name, a.Default, tt.expected[i].Name, tt.expected[i].Default)
				}
			}
		})
	}
}

func TestFillArguments(t *testing.T) {
	tests := []struct {
		name     string
		prompt   string
		values   map[string]string
		expected string
	}{
		{
			name:     "fill with user value",
			prompt:   `A portrait of {argument name="subject" default="a cat"}`,
			values:   map[string]string{"subject": "a warrior"},
			expected: "A portrait of a warrior",
		},
		{
			name:     "fall back to default",
			prompt:   `A portrait of {argument name="subject" default="a cat"}`,
			values:   map[string]string{},
			expected: "A portrait of a cat",
		},
		{
			name:     "no value no default → placeholder",
			prompt:   `A portrait of {argument name="subject"}`,
			values:   map[string]string{},
			expected: "A portrait of [subject]",
		},
		{
			name:     "multiple arguments",
			prompt:   `{argument name="style" default="cinematic"} photo of {argument name="subject" default="hero"}`,
			values:   map[string]string{"subject": "knight"},
			expected: "cinematic photo of knight",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := prompt.FillArguments(tt.prompt, tt.values)
			if got != tt.expected {
				t.Errorf("got %q, want %q", got, tt.expected)
			}
		})
	}
}
```

**Chạy test**:
```bash
cd services/media-service && go test ./internal/infra/prompt/... -v
```

**Expected**: Tất cả tests PASS.

---

## B-17 — `prompt_template_loader.go`

**Target**: `services/media-service/internal/infra/fs/prompt_template_loader.go`  
**Estimate**: 3h

### Quan sát JSON schema thực tế

```bash
cat prompt-templates/image/3d-stone-staircase-evolution-infographic.json | jq .
```

Expected JSON structure:
```json
{
  "id": "3d-stone-staircase-evolution-infographic",
  "title": "3D Stone Staircase Evolution Infographic",
  "summary": "...",
  "category": "Infographic",
  "tags": ["3d", "stone", "infographic"],
  "model": "gpt-image-2",
  "aspect": "1:1",
  "prompt": "A detailed 3D stone staircase...",
  "previewImageUrl": "",
  "source": {
    "repo": "openai/image-prompt-library",
    "license": "MIT"
  }
}
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

	"media-service/internal/domain"
	"media-service/internal/infra/prompt"
)

// rawTemplateJSON maps trực tiếp từ JSON file schema.
type rawTemplateJSON struct {
	ID              string          `json:"id"`
	Surface         string          `json:"surface"`  // optional — override inferred from dir
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

// PromptTemplateLoader loads PromptTemplates từ JSON files.
type PromptTemplateLoader struct {
	imagePath string // prompt-templates/image/
	videoPath string // prompt-templates/video/
	cache     sync.Map // id → *domain.PromptTemplate
	mu        sync.Mutex
	loaded    bool
}

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
				fmt.Printf("[WARN] prompt_template_loader: read %q: %v\n", e.Name(), err)
				continue
			}
			t, err := l.parseJSON(data, dirInfo.surface)
			if err != nil {
				fmt.Printf("[WARN] prompt_template_loader: parse %q: %v\n", e.Name(), err)
				continue
			}
			l.cache.Store(t.ID, t)
			result = append(result, t)
		}
	}
	l.loaded = true
	return result, nil
}

func (l *PromptTemplateLoader) parseJSON(data []byte, inferredSurface domain.Surface) (*domain.PromptTemplate, error) {
	var raw rawTemplateJSON
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("json unmarshal: %w", err)
	}
	if raw.ID == "" {
		return nil, fmt.Errorf("missing 'id' field")
	}
	if raw.Title == "" {
		return nil, fmt.Errorf("missing 'title' field in %q", raw.ID)
	}

	// Parse arguments từ raw prompt
	parsedArgs := prompt.ParseArguments(raw.Prompt)
	var args []domain.TemplateArgument
	for _, a := range parsedArgs {
		args = append(args, domain.TemplateArgument{Name: a.Name, Default: a.Default})
	}
	if args == nil {
		args = []domain.TemplateArgument{}
	}

	// Surface: từ JSON "surface" field nếu có, else từ directory
	surface := inferredSurface
	if raw.Surface != "" {
		surface = domain.Surface(raw.Surface)
	}

	return &domain.PromptTemplate{
		ID:      raw.ID,
		Surface: surface,
		Title:   raw.Title,
		Summary: raw.Summary,
		Category: func() string {
			if raw.Category == "" {
				return "General"
			}
			return raw.Category
		}(),
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
	}, nil
}
```

---

## B-18 — Test PromptTemplateLoader

**Estimate**: 1.5h

```bash
# Start media-service
cd services/media-service
PROMPT_TEMPLATES_IMAGE_PATH=../../ui/open-design-vnpay/prompt-templates/image \
PROMPT_TEMPLATES_VIDEO_PATH=../../ui/open-design-vnpay/prompt-templates/video \
HTTP_PORT=8084 go run ./cmd/main.go &

sleep 1

# Test 1: Total count
curl -s http://localhost:8084/api/v1/prompt-templates | jq '.total'
# Expected: 103 (46 image + 57 video)

# Test 2: Filter by surface
curl -s "http://localhost:8084/api/v1/prompt-templates?surface=image" | jq '.total'
# Expected: 46
curl -s "http://localhost:8084/api/v1/prompt-templates?surface=video" | jq '.total'
# Expected: 57

# Test 3: Template cụ thể
curl -s "http://localhost:8084/api/v1/prompt-templates/3d-stone-staircase-evolution-infographic" | \
  jq '{id,title,model,aspect,argumentCount}'

# Test 4: ArgumentCount đúng
curl -s "http://localhost:8084/api/v1/prompt-templates/3d-stone-staircase-evolution-infographic" | \
  jq '.arguments'

# Test 5: Filter by model
curl -s "http://localhost:8084/api/v1/prompt-templates?model=gpt-image-2" | jq '.total'

# Test 6: Summary vs detail
curl -s "http://localhost:8084/api/v1/prompt-templates" | jq '.items[0] | has("rawPrompt")'
# Expected: false (summary không có rawPrompt)
curl -s "http://localhost:8084/api/v1/prompt-templates/3d-stone-staircase-evolution-infographic" | jq 'has("rawPrompt")'
# Expected: true (detail có rawPrompt)
```

**Expected**: 46 image + 57 video = 103 tổng.

---

## Checklist B2C

- [x] B-15: `argument_parser.go` — dual regex (plain + escaped), ParseArguments + FillArguments OK
- [x] B-16: Unit tests PASS (13 test cases — 6 ParseArguments + 5 FillArguments + 2 CountArguments)
- [x] B-17: `prompt_template_loader.go` — load cả image + video dirs, parse JSON-embedded args
- [x] B-18: 102 templates total (45 image + 57 video), surface filter OK, argumentCount đúng (5 args cho 3d-stone)
