# F-01..F-07 — Foundation: API Layer

**Phase**: P0 | **Estimate**: ~9h | **Depends on**: nothing  
**Target dir**: `ui/open-design-vnpay/ui/src/`

---

## F-01 — Cài `zustand`

**Estimate**: 0.5h

```bash
cd ui/open-design-vnpay/ui
pnpm add zustand
```

Verify `package.json` có:
```json
"dependencies": {
  "zustand": "^4.5.5"
}
```

---

## F-02 — Upgrade `src/types.ts`

**Target**: `ui/src/types.ts`  
**Estimate**: 2h  
**Action**: Thêm/sửa các types (KHÔNG xóa types cũ trừ khi có migration note)

### Thêm vào phần Design Systems

```typescript
// ── DSPreviewPage (MỚI) ──────────────────────────────────────────────────
export interface DSPreviewPage {
  path: string;
  role: 'colors' | 'typography' | 'spacing' | 'buttons' | 'app' | string;
  title: string;
}

// ── DesignSystemSummary (UPGRADE — thêm fields mới) ─────────────────────
// Tìm interface DesignSystemSummary và thêm các fields:
//   category: string
//   sourceType: 'bundled' | 'imported' | 'generated'
//   hasTokens: boolean
//   hasComponents: boolean
//   previewPages: DSPreviewPage[]
// Migration: sourceType thay thế boolean 'builtin' field cũ
```

### Thêm Design Templates types (MỚI hoàn toàn)

```typescript
export type TemplateMode = 'prototype' | 'deck' | 'template' | 'image' | 'video' | 'audio';

export interface TemplateInput {
  name: string;
  type: 'string' | 'text' | 'select' | 'number' | 'boolean';
  required: boolean;
  default?: string;
  options?: string[];
  placeholder?: string;
}

export interface DesignTemplateSummary {
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
```

### Thêm PromptTemplate types (MỚI hoàn toàn)

```typescript
export interface PromptTemplateArg {
  name: string;
  default: string;
}

export interface PromptTemplateSummary {
  id: string;
  surface: 'image' | 'video';
  title: string;
  summary: string;
  category: string;
  tags: string[];
  model: string;    // "gpt-image-2" | "seedance-2.0" | ...
  aspect: string;   // "1:1" | "16:9" | ...
  previewImageUrl?: string;
  argumentCount: number;
}

export interface PromptTemplateDetail extends PromptTemplateSummary {
  rawPrompt: string;
  arguments: PromptTemplateArg[];
  source: {
    repo: string;
    license: string;
    author?: string;
    url?: string;
  };
}
```

### Mở rộng MediaJobSummary

```typescript
// Tìm MediaJobSummary và thêm:
//   templateId?: string   ← nếu generate từ template
```

### Mở rộng ProjectMetadata

```typescript
// Tìm ProjectMetadata và thêm:
//   templateId?: string
//   templateInputs?: Record<string, string>
```

**Verify**: `pnpm typecheck` — expect 0 errors hoặc chỉ có errors từ files chưa cập nhật (F-03 sẽ fix)

---

## F-03 — Upgrade `src/api/domain/http.ts`

**Target**: `ui/src/api/domain/http.ts`  
**Estimate**: 3h

### Thay đổi trong `HttpDesignSystemApiClient`

**Sửa** `listDesignSystems()` — thêm filter params:
```typescript
listDesignSystems(params?: {
  category?: string;
  q?: string;
  source?: 'bundled' | 'imported' | 'generated';
}): Promise<DesignSystemSummary[]> {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  ).toString();
  return this.get(`/api/design-systems${qs ? '?' + qs : ''}`);
}
```

**Xóa** `getPreviewUrl(id)` → **Thêm** các URL builders mới:
```typescript
// URL builders — không gọi API, trả về URL string cho iframe/fetch
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
```

### Thêm class mới `HttpDesignTemplateApiClient`

```typescript
export class HttpDesignTemplateApiClient extends BaseApiClient {
  listDesignTemplates(params?: {
    mode?: TemplateMode;
    q?: string;
    scenario?: string;
  }): Promise<{ items: DesignTemplateSummary[]; total: number }> {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params ?? {}).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
    ).toString();
    return this.get(`/api/design-templates${qs ? '?' + qs : ''}`);
  }

  getDesignTemplate(id: string): Promise<DesignTemplateSummary> {
    return this.get(`/api/design-templates/${id}`);
  }

  // URL builders
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

**Import types** ở đầu file:
```typescript
import type {
  DesignSystemSummary,
  DesignSystemDetail,
  DesignTemplateSummary,
  TemplateMode,
  // ...existing
} from '../../types';
```

---

## F-04 — Thêm PromptTemplate methods vào `src/api/supplement/http.ts`

**Target**: `ui/src/api/supplement/http.ts`  
**Estimate**: 2h

Tìm `class HttpMediaApiClient` và thêm vào cuối:

```typescript
// ── Prompt Templates (MỚI) ──────────────────────────────────────────────

listPromptTemplates(params?: {
  surface?: 'image' | 'video';
  category?: string;
  model?: string;
  q?: string;
}): Promise<{ items: PromptTemplateSummary[]; total: number }> {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  ).toString();
  return this.get(`/api/prompt-templates${qs ? '?' + qs : ''}`);
}

getPromptTemplate(id: string): Promise<PromptTemplateDetail> {
  return this.get(`/api/prompt-templates/${id}`);
}

generateFromPromptTemplate(req: {
  templateId: string;
  values: Record<string, string>;
  projectId: string;
  outputAspect?: string;
}): Promise<MediaTask> {
  return this.post('/api/media/generate-from-template', req);
}

getPromptTemplatePreviewUrl(id: string): string {
  return this.buildUrl(`/api/prompt-templates/${id}/preview`);
}
```

**Thêm imports** ở đầu file supplement/http.ts:
```typescript
import type {
  PromptTemplateSummary,
  PromptTemplateDetail,
  MediaTask,  // hoặc MediaJobSummary tùy type tên hiện tại
} from '../../types';
```

---

## F-05 — Export `HttpDesignTemplateApiClient`

**Target**: `ui/src/api/domain/http.ts`  
**Estimate**: 0 (included trong F-03)

Đảm bảo class đã được export trong F-03:
```typescript
export class HttpDesignTemplateApiClient extends BaseApiClient { ... }
```

---

## F-06 — Cập nhật `src/api/projects/http.ts`

**Target**: `ui/src/api/projects/http.ts`  
**Estimate**: 0.5h

Thêm method vào `HttpProjectsApiClient`:
```typescript
// Tạo project từ design template
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

## F-07 — Cập nhật `src/api/index.ts`

**Target**: `ui/src/api/index.ts`  
**Estimate**: 0.5h

Thêm `HttpDesignTemplateApiClient`:
```typescript
import { HttpDesignTemplateApiClient } from './domain/http';

export const api = {
  // ...existing...
  designTemplates: new HttpDesignTemplateApiClient(),  // ← THÊM
} as const;
```

**Verify** F-01..F-07:
```bash
cd ui/open-design-vnpay/ui
pnpm typecheck
# Expected: 0 errors (hoặc chỉ còn từ files stub chưa implement)
```

---

## Checklist P0 API

- [x] F-01: `zustand` trong package.json dependencies
- [x] F-02: types.ts — DSPreviewPage, DesignTemplateSummary, PromptTemplateSummary, PromptTemplateDetail
- [x] F-03: domain/http.ts — DS client v2 (filter params + URL builders), HttpDesignTemplateApiClient class
- [x] F-04: supplement/http.ts — PromptTemplate methods trong HttpMediaApiClient
- [x] F-05: HttpDesignTemplateApiClient exported (done trong F-03)
- [x] F-06: projects/http.ts — createProjectFromTemplate method
- [x] F-07: api/index.ts — `designTemplates` registry entry
