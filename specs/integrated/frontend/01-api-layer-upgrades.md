# 01 — API Layer Upgrades

> File: `ui/src/api/`  
> Nâng cấp các API clients để cover đầy đủ 3 asset directories.

---

## 1.A Nâng cấp `api/domain/http.ts`

### Vấn đề hiện tại

`HttpDesignSystemApiClient` chỉ có:
- `listDesignSystems()` → thiếu `?category=` param
- `getDesignSystem(id)` → thiếu `category`, `previewPages`, `hasTokens`
- `getPreviewUrl(id)` → chỉ serve 1 URL, chưa hỗ trợ multi-page
- Thiếu: `getTokensCssUrl`, `getComponentsUrl`, `getDesignMdUrl`

`HttpSkillApiClient` thiếu:
- `listDesignTemplates()` — route `/api/design-templates`
- `getDesignTemplate(id)` — detail với `od.inputs`
- `getTemplateExampleUrl(id)` — `/api/design-templates/:id/example`

### Code mới cho `api/domain/http.ts`

```typescript
// ── Design Systems (mở rộng) ─────────────────────────────────────────────

export interface DSPreviewPage {
  path: string;
  role: 'colors' | 'typography' | 'spacing' | 'buttons' | 'app' | string;
  title: string;
}

export interface DesignSystemSummaryV2 {
  id: string;
  name: string;
  category: string;                    // ← MỚI
  description?: string;
  sourceType: 'bundled' | 'imported' | 'generated';
  status: 'active' | 'processing' | 'error';
  hasTokens: boolean;                  // ← MỚI
  hasComponents: boolean;              // ← MỚI
  previewPages: DSPreviewPage[];       // ← MỚI
}

export class HttpDesignSystemApiClient extends BaseApiClient {
  // Existing (keep, nhưng refactor return type)
  listDesignSystems(params?: {
    category?: string;
    q?: string;
    source?: 'bundled' | 'imported' | 'generated';
  }): Promise<DesignSystemSummaryV2[]> {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params ?? {}).filter(([, v]) => v !== undefined),
      ),
    ).toString();
    return this.get(`/api/design-systems${qs ? '?' + qs : ''}`);
  }

  getDesignSystem(id: string): Promise<DesignSystemSummaryV2> {
    return this.get(`/api/design-systems/${id}`);
  }

  // URL builders (không gọi API, trả về URL string để dùng trong iframe/img)
  getTokensCssUrl(id: string): string {
    return this.buildUrl(`/api/design-systems/${id}/tokens.css`);
  }

  getComponentsUrl(id: string): string {
    return this.buildUrl(`/api/design-systems/${id}/components`);
  }

  getDesignMdUrl(id: string): string {
    return this.buildUrl(`/api/design-systems/${id}/design.md`);
  }

  getPreviewPageUrl(id: string, role: string): string {
    return this.buildUrl(`/api/design-systems/${id}/preview/${role}`);
  }

  getAssetUrl(id: string, path: string): string {
    return this.buildUrl(`/api/design-systems/${id}/assets/${path}`);
  }

  // Existing CRUD (keep as-is)
  createDesignSystem(data: { name: string; content: string }): Promise<DesignSystemSummaryV2> {
    return this.post('/api/design-systems', data);
  }
  updateDesignSystem(id: string, data: Partial<{ name: string }>): Promise<DesignSystemSummaryV2> {
    return this.put(`/api/design-systems/${id}`, data);
  }
  deleteDesignSystem(id: string): Promise<void> {
    return this.del(`/api/design-systems/${id}`);
  }
  importFromGitHub(repoUrl: string): Promise<DesignSystemSummaryV2> {
    return this.post('/api/design-systems/import/github', { repoUrl });
  }
  getImportJobStatus(id: string): Promise<{ status: string; progress: number; error?: string }> {
    return this.get(`/api/design-systems/${id}/job`);
  }
}

// ── Design Templates (MỚI) ───────────────────────────────────────────────

export type TemplateMode = 'prototype' | 'deck' | 'template' | 'image' | 'video' | 'audio';

export interface TemplateInput {
  name: string;
  type: 'string' | 'text' | 'select' | 'number' | 'boolean';
  required: boolean;
  default?: string;
  options?: string[];
  placeholder?: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  description?: string;
  mode: TemplateMode;
  platform?: 'desktop' | 'mobile' | 'tablet';
  scenario?: string;
  triggers: string[];
  hasExample: boolean;
  exampleUrl: string;
  inputs: TemplateInput[];
}

export class HttpDesignTemplateApiClient extends BaseApiClient {
  listDesignTemplates(params?: {
    mode?: TemplateMode;
    q?: string;
    scenario?: string;
  }): Promise<TemplateSummary[]> {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params ?? {}).filter(([, v]) => v !== undefined),
      ),
    ).toString();
    return this.get(`/api/design-templates${qs ? '?' + qs : ''}`);
  }

  getDesignTemplate(id: string): Promise<TemplateSummary> {
    return this.get(`/api/design-templates/${id}`);
  }

  getTemplateExampleUrl(id: string): string {
    return this.buildUrl(`/api/design-templates/${id}/example`);
  }

  getTemplateDerivedExampleUrl(id: string, key: string): string {
    return this.buildUrl(`/api/design-templates/${id}/examples/${key}`);
  }

  getTemplateAssetUrl(id: string, path: string): string {
    return this.buildUrl(`/api/design-templates/${id}/assets/${path}`);
  }
}
```

---

## 1.B Nâng cấp `api/supplement/http.ts`

### Vấn đề hiện tại

`HttpTemplatesApiClient` (ProjectTemplate) không liên quan đến design-templates.  
`HttpMediaApiClient` thiếu hoàn toàn prompt-template methods.

### Thêm vào `HttpMediaApiClient`

```typescript
export interface PromptTemplateSummary {
  id: string;
  surface: 'image' | 'video';
  title: string;
  summary: string;
  category: string;
  tags: string[];
  model: string;
  aspect: string;
  previewImageUrl?: string;
  argumentCount: number;
}

export interface PromptTemplateDetail extends PromptTemplateSummary {
  rawPrompt: string;
  arguments: Array<{ name: string; default: string }>;
  source: {
    repo: string;
    license: string;
    author?: string;
    url?: string;
  };
}

export interface GenerateFromPromptTemplateRequest {
  templateId: string;
  values: Record<string, string>;
  projectId: string;
  outputAspect?: string;
}

// Thêm vào class HttpMediaApiClient:
listPromptTemplates(params?: {
  surface?: 'image' | 'video';
  category?: string;
  model?: string;
  q?: string;
}): Promise<PromptTemplateSummary[]> {
  const qs = new URLSearchParams(...).toString();
  return this.get(`/api/prompt-templates${qs ? '?' + qs : ''}`);
}

getPromptTemplate(id: string): Promise<PromptTemplateDetail> {
  return this.get(`/api/prompt-templates/${id}`);
}

generateFromPromptTemplate(req: GenerateFromPromptTemplateRequest): Promise<MediaTask> {
  return this.post('/api/media/generate-from-template', req);
}

getPromptTemplatePreviewUrl(id: string): string {
  return this.buildUrl(`/api/prompt-templates/${id}/preview`);
}
```

---

## 1.C Cập nhật `api/index.ts` — Thêm client mới

```typescript
// Thêm vào registry:
import { HttpDesignTemplateApiClient } from './domain/http';

export const api = {
  // ... existing ...
  designTemplates: new HttpDesignTemplateApiClient(),  // ← MỚI
} as const;
```

---

## 1.D Cập nhật `api/projects/http.ts` — Template-based project creation

```typescript
// Thêm method:
createProjectFromTemplate(req: {
  templateId: string;
  inputs: Record<string, string>;
  designSystemId?: string;
  name?: string;
}): Promise<Project> {
  return this.post('/api/projects/from-template', req);
}
```

---

## File changes

| File | Thay đổi |
|------|---------|
| `ui/src/api/domain/http.ts` | Thêm DSPreviewPage, DesignSystemSummaryV2, TemplateSummary, TemplateInput, HttpDesignTemplateApiClient |
| `ui/src/api/supplement/http.ts` | Thêm PromptTemplateSummary, PromptTemplateDetail, methods vào HttpMediaApiClient |
| `ui/src/api/index.ts` | Thêm `designTemplates` vào registry |
| `ui/src/api/projects/http.ts` | Thêm `createProjectFromTemplate` |
