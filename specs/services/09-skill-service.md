# 09 — Skill Service

> **Port gRPC**: 8088  
> **Domain**: Skill catalog, skill metadata, AI skill dispatch

---

## 1. Vai trò & Trách nhiệm

Thay thế `skills.ts` (~42KB):

- **Skill catalog**: List/Get skills từ `skills/` directory
- **Skill parsing**: Parse YAML/JSON skill definitions
- **Skill context**: Provide skill instructions để Agent Service inject vào prompt
- **Skill execution**: Dispatch skill run (qua Agent Service)

---

## 2. Cấu trúc thư mục

```
skill-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── skill.go              # Skill entity
│   │   └── repository.go
│   │
│   ├── usecase/
│   │   ├── catalog_usecase.go    # ListSkills, GetSkill
│   │   └── context_usecase.go    # GetSkillContext (for Agent Service)
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   └── skill_repo.go     # SQLite/PG for persisted metadata
│   │   └── fs/
│   │       └── skill_loader.go   # Load skills từ YAML/JSON files
│   │
│   └── delivery/
│       ├── grpc/
│       │   └── handler.go
│       └── http/
│           └── health.go
│
├── proto/
│   └── skill/v1/skill.proto
└── Dockerfile
```

---

## 3. Domain Model

```go
// domain/skill.go
type Skill struct {
    ID          string
    Name        string
    Description string
    Category    string         // "ui-generation" | "image" | "refactor" | ...
    Tags        []string
    Version     string
    // Instructions injected into agent system prompt
    SystemPrompt    string
    ExamplePrompts  []string
    // Metadata
    Author    string
    CreatedAt time.Time
}

type SkillSummary struct {
    ID          string
    Name        string
    Description string
    Category    string
    Tags        []string
}
```

---

## 4. Skill File Format (YAML)

```yaml
# skills/ui-generation/landing-page.yaml
id: landing-page
name: Landing Page Generator
description: Generate a beautiful landing page from a brief description
category: ui-generation
version: 1.0.0
author: open-design-team
tags:
  - web
  - landing-page
  - hero

system_prompt: |
  You are a professional UI developer. When generating landing pages:
  - Use semantic HTML5 elements
  - Apply the active design system tokens
  - Create responsive layouts
  - Add smooth animations with CSS transitions
  - Ensure accessibility (ARIA labels, contrast ratios)

example_prompts:
  - "Create a SaaS landing page for a project management tool"
  - "Generate a portfolio landing page for a designer"
```

---

## 5. gRPC Protocol

```protobuf
syntax = "proto3";
package skill.v1;

service SkillService {
    rpc ListSkills(ListSkillsRequest) returns (ListSkillsResponse);
    rpc GetSkill(GetSkillRequest) returns (Skill);
    rpc GetSkillContext(GetSkillContextRequest) returns (SkillContext);
}

message ListSkillsRequest {
    string category = 1;        // optional filter
    repeated string tags = 2;   // optional filter
    int32  page = 3;
    int32  page_size = 4;
}

message Skill {
    string id = 1;
    string name = 2;
    string description = 3;
    string category = 4;
    repeated string tags = 5;
    string version = 6;
    string author = 7;
    repeated string example_prompts = 8;
}

message SkillContext {
    string skill_id = 1;
    string system_prompt = 2;    // Inject into agent system prompt
}
```

---

## 6. Skill Catalog Loading

Skills được load từ filesystem khi service khởi động và cache trong memory:

```go
// infra/fs/skill_loader.go
type FSSkillLoader struct {
    skillsPath string // OD_SKILLS_PATH
}

func (l *FSSkillLoader) LoadAll() ([]*domain.Skill, error) {
    var skills []*domain.Skill
    err := filepath.WalkDir(l.skillsPath, func(path string, d fs.DirEntry, err error) error {
        if d.IsDir() { return nil }
        if !strings.HasSuffix(path, ".yaml") && !strings.HasSuffix(path, ".json") {
            return nil
        }
        skill, err := l.parseSkillFile(path)
        if err == nil {
            skills = append(skills, skill)
        }
        return nil
    })
    return skills, err
}
```
