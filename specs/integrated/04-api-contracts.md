# 04 — API Contracts (REST + gRPC)

> Tổng hợp tất cả API contracts cho 3 asset directories tích hợp vào system.

---

## 1. Design Systems API

### REST (via API Gateway)

```
GET    /api/design-systems
  ?category=string        # filter by category (AI & LLM, Fintech, etc.)
  &q=string              # fulltext search on name/description
  &source=bundled|imported|generated
  → 200 DesignSystemSummary[]

GET    /api/design-systems/:id
  → 200 DesignSystemDetail

GET    /api/design-systems/:id/design.md
  Content-Type: text/markdown
  → 200 raw DESIGN.md content

GET    /api/design-systems/:id/tokens.css
  Content-Type: text/css
  → 200 raw tokens.css

GET    /api/design-systems/:id/components
  Content-Type: text/html
  → 200 components.html (or 404 if not exists)

GET    /api/design-systems/:id/preview
  → 200 PreviewPage[]

GET    /api/design-systems/:id/preview/:role
  Content-Type: text/html
  role: colors | typography | spacing | buttons | app
  → 200 preview HTML

GET    /api/design-systems/:id/assets/*path
  → 200 binary asset file

POST   /api/design-systems
  Body: { source: "zip"|"url"|"npm", url?: string, file?: multipart }
  → 202 { id, jobId, status: "processing" }

DELETE /api/design-systems/:id
  → 204 (only for imported/generated, not bundled)

GET    /api/design-systems/:id/job
  → 200 { jobId, status, progress, error? }
```

### JSON Schemas

```typescript
// DesignSystemSummary
interface DesignSystemSummary {
  id: string;
  name: string;
  category: string;
  description?: string;
  sourceType: 'bundled' | 'imported' | 'generated';
  status: 'active' | 'processing' | 'error';
  hasTokens: boolean;
  hasComponents: boolean;
  previewPages: PreviewPage[];
}

interface PreviewPage {
  path: string;
  role: 'colors' | 'typography' | 'spacing' | 'buttons' | 'app' | string;
  title: string;
}

// DesignSystemDetail extends DesignSystemSummary
interface DesignSystemDetail extends DesignSystemSummary {
  importMode?: string;
  craft?: { applies: string[]; suggested: string[]; exemptions: string[] };
  fonts?: string[];
  source?: { type: string; origin: string };
}
```

### gRPC

```protobuf
service DesignSystemService {
  rpc ListDesignSystems(ListDSRequest)       returns (ListDSResponse);
  rpc GetDesignSystem(GetDSRequest)          returns (DesignSystem);
  rpc GetDesignSystemContext(ContextRequest) returns (DSContext);
  rpc GetFile(GetFileRequest)                returns (stream FileChunk);
  rpc CreateDesignSystem(CreateDSRequest)    returns (CreateDSResponse);
  rpc DeleteDesignSystem(DeleteDSRequest)    returns (google.protobuf.Empty);
  rpc GetJobStatus(GetJobRequest)            returns (DSJob);
}

message ListDSRequest {
  string category = 1;
  string query    = 2;
  string source   = 3;
}

message DSContext {
  string tokens_css      = 1;
  string design_md       = 2;
  string name            = 3;
  string category        = 4;
  string components_html = 5; // optional
}
```

---

## 2. Design Templates API

### REST

```
GET    /api/design-templates
  ?mode=prototype|deck|template|image|video|audio
  &q=string
  &scenario=string
  → 200 TemplateSummary[]

GET    /api/design-templates/:id
  → 200 TemplateDetail (includes inputs[])

GET    /api/design-templates/:id/example
  Content-Type: text/html
  → 200 example.html

GET    /api/design-templates/:id/examples/:key
  Content-Type: text/html
  → 200 derived example HTML

GET    /api/design-templates/:id/assets/*path
  → 200 asset file

# Backward compat (from AGENTS.md: URLs rewrite to /api/skills/:id/...)
GET    /api/skills/:id/example → redirect 301 /api/design-templates/:id/example
GET    /api/skills/:id/assets/*path → redirect 301 /api/design-templates/:id/assets/*path
```

### JSON Schemas

```typescript
interface TemplateSummary {
  id: string;
  name: string;
  description?: string;
  mode: 'prototype' | 'deck' | 'template' | 'image' | 'video' | 'audio';
  platform?: 'desktop' | 'mobile' | 'tablet';
  scenario?: string;
  triggers: string[];
  hasExample: boolean;
  exampleUrl: string;
  inputs: TemplateInput[];
}

interface TemplateInput {
  name: string;
  type: 'string' | 'text' | 'select' | 'number' | 'boolean';
  required: boolean;
  default?: string;
  options?: string[];     // for type=select
  placeholder?: string;
}
```

### gRPC (added to Skill Service)

```protobuf
service SkillService {
  // ... existing skill rpcs ...
  rpc ListDesignTemplates(ListTemplateRequest)  returns (ListTemplateResponse);
  rpc GetDesignTemplate(GetTemplateRequest)     returns (DesignTemplate);
}

message ListTemplateRequest {
  string mode     = 1; // filter by od.mode
  string query    = 2;
  string scenario = 3;
}

message DesignTemplate {
  string id          = 1;
  string name        = 2;
  string description = 3;
  string mode        = 4;
  string platform    = 5;
  string scenario    = 6;
  repeated string triggers = 7;
  bool   has_example = 8;
  string example_url = 9;
  repeated TemplateInput inputs = 10;
}

message TemplateInput {
  string name        = 1;
  string type        = 2;
  bool   required    = 3;
  string default_val = 4;
  repeated string options = 5;
}
```

---

## 3. Prompt Templates API

### REST

```
GET    /api/prompt-templates
  ?surface=image|video
  &category=string
  &model=string      # e.g. gpt-image-2, seedance-2.0
  &q=string
  → 200 PromptTemplateSummary[]

GET    /api/prompt-templates/:id
  → 200 PromptTemplateDetail (includes arguments[])

GET    /api/prompt-templates/:id/preview
  → 302 redirect to previewImageUrl

POST   /api/media/generate-from-template
  Body: {
    templateId: string,
    values: Record<string, string>,
    projectId: string,
    outputAspect?: string
  }
  → 200 MediaTask { id, status: "pending", ... }
```

### JSON Schemas

```typescript
interface PromptTemplateSummary {
  id: string;
  surface: 'image' | 'video';
  title: string;
  summary: string;
  category: string;
  tags: string[];
  model: string;
  aspect: string;
  previewImageUrl?: string;
  argumentCount: number;   // quick count for UI
}

interface PromptTemplateDetail extends PromptTemplateSummary {
  rawPrompt: string;       // original prompt (with {argument} placeholders)
  arguments: TemplateArgument[];
  source: {
    repo: string;
    license: string;
    author?: string;
    url?: string;
  };
}

interface TemplateArgument {
  name: string;
  default: string;
}
```

### gRPC (added to Media Service)

```protobuf
service MediaService {
  // ... existing media rpcs ...
  rpc ListPromptTemplates(ListPTRequest)       returns (ListPTResponse);
  rpc GetPromptTemplate(GetPTRequest)          returns (PromptTemplate);
  rpc GenerateFromTemplate(GenFromTmplRequest) returns (MediaTask);
}

message PromptTemplate {
  string id          = 1;
  string surface     = 2;
  string title       = 3;
  string summary     = 4;
  string category    = 5;
  repeated string tags = 6;
  string model       = 7;
  string aspect      = 8;
  string raw_prompt  = 9;
  repeated TemplateArgument arguments = 10;
  string preview_image_url = 11;
}

message TemplateArgument {
  string name        = 1;
  string default_val = 2;
}

message GenFromTmplRequest {
  string template_id = 1;
  map<string, string> values = 2;
  string project_id  = 3;
  string output_aspect = 4;
}
```

---

## 4. Cross-Service Dependencies

```
Agent Service
    ↓ GetDesignSystemContext (gRPC)
Design System Service
    ← reads design-systems/<slug>/DESIGN.md + tokens.css

Skill Service  
    ↓ GetDesignTemplate (gRPC)
    ← reads design-templates/<slug>/SKILL.md

Media Service
    ↓ GenerateFromTemplate
    ← reads prompt-templates/image/*.json + prompt-templates/video/*.json
    → calls Image/Video provider APIs
```

---

## 5. Catalog Path Configuration

```yaml
# config.yaml (Go services)
catalogs:
  design_systems:   "/app/design-systems"      # OD_DS_CATALOG_PATH
  design_templates: "/app/design-templates"    # OD_TEMPLATES_CATALOG_PATH
  prompt_templates:
    image: "/app/prompt-templates/image"       # OD_PROMPT_IMAGE_PATH
    video: "/app/prompt-templates/video"       # OD_PROMPT_VIDEO_PATH
```

```yaml
# docker-compose volumes
volumes:
  - ./design-systems:/app/design-systems:ro
  - ./design-templates:/app/design-templates:ro
  - ./prompt-templates:/app/prompt-templates:ro
```
