# 02 — Types Upgrades (`types.ts`)

> File: `ui/src/types.ts`  
> Cập nhật các type definitions để đồng bộ với API contracts mới.

---

## Các types cần cập nhật / thêm mới

```typescript
// ── Design Systems (V2) ─────────────────────────────────────────────────

export interface DSPreviewPage {
  path: string;
  role: 'colors' | 'typography' | 'spacing' | 'buttons' | 'app' | string;
  title: string;
}

// Thay thế DesignSystemSummary cũ (chỉ có id, name, description, builtin, updatedAt)
export interface DesignSystemSummary {
  id: string;
  name: string;
  category: string;          // ← MỚI — group dropdown: "AI & LLM", "Fintech", etc.
  description?: string;
  sourceType: 'bundled' | 'imported' | 'generated'; // ← MỚI (thay 'builtin': boolean)
  status: 'active' | 'processing' | 'error';
  hasTokens: boolean;        // ← MỚI
  hasComponents: boolean;    // ← MỚI
  previewPages: DSPreviewPage[]; // ← MỚI
  updatedAt?: string;
}

// DesignSystemDetail không còn cần 'content' field (server serve riêng tokens.css/DESIGN.md)
export interface DesignSystemDetail extends DesignSystemSummary {
  importMode?: string;
  craft?: {
    applies: string[];
    suggested: string[];
    exemptions: string[];
  };
  fonts?: string[];
}

// ── Design Templates (MỚI) ─────────────────────────────────────────────

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
  exampleUrl: string;        // /api/design-templates/:id/example
  inputs: TemplateInput[];
}

// ── Skills (mở rộng nhẹ) ────────────────────────────────────────────────

// Giữ nguyên SkillSummary, thêm:
export interface SkillDetail {
  id: string;
  name: string;
  description?: string;
  scenario?: string;
  tags?: string[];
  content: string;
  exampleUrl?: string;
  version?: string;
  author?: string;
  kind?: 'scenario' | 'tool';    // ← MỚI — từ skill-service domain
}

// ── Prompt Templates (MỚI) ─────────────────────────────────────────────

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
  model: string;             // "gpt-image-2" | "seedance-2.0" | ...
  aspect: string;            // "1:1" | "16:9" | ...
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

// ── Media (mở rộng) ────────────────────────────────────────────────────

// Thêm field templateId vào MediaJob tracking
export interface MediaJobSummary {
  id: string;
  kind: 'image' | 'video' | 'audio';
  status: 'pending' | 'processing' | 'done' | 'failed';
  prompt: string;
  model: string;
  provider: string;
  templateId?: string;       // ← MỚI — nếu generate từ template
  resultUrl?: string;
  errorMsg?: string;
  durationMs?: number;
  createdAt: string;
  finishedAt?: string;
}

// ── Project (mở rộng) ──────────────────────────────────────────────────

export interface ProjectMetadata {
  description?: string;
  surface?: ProjectPlatform;
  tags?: string[];
  templateId?: string;       // ← MỚI — nếu tạo từ design template
  templateInputs?: Record<string, string>; // ← MỚI
}

// ── AppConfig (mở rộng) ────────────────────────────────────────────────

// Giữ nguyên, nhưng thêm:
export interface AppConfig {
  // ... existing fields ...
  selectedDesignSystemId?: string | null;  // ← MỚI — DS đang chọn trong toolbar
  selectedTemplateId?: string | null;      // ← MỚI
}
```

---

## Migration notes

| Type cũ | Type mới | Breaking? |
|---------|---------|----------|
| `DesignSystemSummary.builtin: boolean` | `sourceType: 'bundled'\|'imported'\|'generated'` | ⚠️ Yes |
| `DesignSystemDetail.content: string` | Không có — fetch riêng via URL | ⚠️ Yes |
| `SkillSummary` | Giữ nguyên | ✅ No |
| `ProjectTemplate` | Giữ nguyên (project-level template, khác design-templates) | ✅ No |

---

## Chiến lược migration

1. Cập nhật `types.ts` trước
2. Fix TypeScript errors trong `api/domain/http.ts` (đổi return types)
3. Fix components đang dùng `DesignSystemSummary.builtin` → `sourceType === 'bundled'`
4. Chạy `pnpm typecheck` để verify
