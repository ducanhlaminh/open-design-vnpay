# 04 — Registry Models (Agent, Skill, Design System)

**Nguồn:** `packages/contracts/src/api/registry.ts`

---

## AgentInfo

```typescript
interface AgentModelOption {
  id: string;
  label: string;
}

interface AgentInfo {
  id: string;
  name: string;
  bin: string;                   // Binary path or name
  available: boolean;
  authStatus?: 'ok' | 'missing' | 'unknown';
  authMessage?: string;
  path?: string;
  version?: string | null;
  models?: AgentModelOption[];
  modelsSource?: 'live' | 'fallback';
  reasoningOptions?: AgentModelOption[];
  installUrl?: string;
  docsUrl?: string;
  externalMcpInjection?:
    | 'claude-mcp-json'
    | 'acp-merge'
    | 'opencode-env-content';
}
```

---

## SkillSummary

Metadata của một skill (không có body):

```typescript
type SkillSource = 'built-in' | 'user';

interface SkillSummary {
  id: string;
  name: string;
  displayName?: Record<string, string>;       // i18n
  description: string;
  descriptionI18n?: Record<string, string>;
  triggers: string[];
  mode:
    | 'prototype'
    | 'deck'
    | 'template'
    | 'design-system'
    | 'image'
    | 'video'
    | 'audio';
  surface?: 'web' | 'image' | 'video' | 'audio';
  platform?: 'desktop' | 'mobile' | null;
  scenario?: string | null;
  category?: string | null;       // Filter pill trong Settings → Skills
  source?: SkillSource;
  previewType: string;
  designSystemRequired: boolean;
  defaultFor: string[];
  upstream: string | null;
  featured?: number | null;
  fidelity?: 'wireframe' | 'high-fidelity' | null;
  speakerNotes?: boolean | null;
  animations?: boolean | null;
  craftRequires?: string[];
  hasBody: boolean;
  examplePrompt: string;
  examplePromptI18n?: Record<string, string>;
  aggregatesExamples: boolean;
}

interface SkillDetail extends SkillSummary {
  body: string;              // Full SKILL.md body
}

interface SkillFileEntry {
  path: string;
  kind: 'file' | 'directory';
  size: number | null;
}
```

---

## DesignSystemSummary

```typescript
interface DesignSystemSummary {
  id: string;
  title: string;
  category: string;
  summary: string;
  swatches?: string[];           // Color hex strings for preview
  surface?: 'web' | 'image' | 'video' | 'audio';
  source?: 'built-in' | 'installed' | 'user';
  status?: 'draft' | 'published';
  isEditable?: boolean;
  createdAt?: string;
  updatedAt?: string;
  provenance?: DesignSystemProvenance;
  projectId?: string;            // DS has a companion project
}

interface DesignSystemDetail extends DesignSystemSummary {
  body: string;                  // Full DESIGN.md body
  packageInfo?: DesignSystemPackageInfo;
}
```

---

## DesignSystemProvenance

Thông tin nguồn gốc (import từ GitHub, Figma, v.v.):

```typescript
interface DesignSystemProvenance {
  companyBlurb?: string;
  githubUrls?: string[];
  localCodeFiles?: string[];
  figFiles?: string[];
  assetFiles?: string[];
  notes?: string;
  sourceNotes?: string;
}
```

---

## DesignSystemPackageInfo

Thông tin package của DS (khi import từ repo):

```typescript
interface DesignSystemPackageInfo {
  manifest?: {
    schemaVersion: string;
    id: string;
    name: string;
    category: string;
    source?: {
      type?: string;
      url?: string;
      path?: string;
      branch?: string;
      commit?: string;
      importedAt?: string;
    };
    files?: {
      design?: string;
      tokens?: string;
      components?: string;
    };
    usage?: string;
    componentsManifest?: string;
    importMode?: string;
    craft?: {
      applies?: string[];
      suggested?: string[];
      exemptions?: string[];
    };
    fonts?: Array<{ family?: string; weight?: string | number; style?: string; file?: string }>;
    preview?: {
      dir?: string;
      pages?: Array<{ path?: string; role?: string; title?: string }>;
    };
    sourceFiles?: {
      scanned?: string;
      evidence?: string;
      tokens?: string;
      snippets?: string;
    };
    assetsDir?: string;
  };
  sourceEvidence?: {
    scannedFileCount?: number;
    tokenCount?: number;
    snippetCount?: number;
    confidence?: Record<string, string | number>;
    evidenceExcerpt?: string;
  };
}
```

---

## DesignSystemFile

```typescript
type DesignSystemFileKind =
  | 'folder'
  | 'page'
  | 'stylesheet'
  | 'document'
  | 'image'
  | 'data'
  | 'asset';

interface DesignSystemFileSummary {
  path: string;
  name: string;
  kind: DesignSystemFileKind;
  size?: number;
  updatedAt?: string;
}

interface DesignSystemFileDetail extends DesignSystemFileSummary {
  content: string;
}
```

---

## DesignSystemRevision

Đề xuất revision cho một section của DS (review workflow):

```typescript
type DesignSystemRevisionStatus = 'pending' | 'accepted' | 'rejected';

interface DesignSystemRevision {
  id: string;
  designSystemId: string;
  status: DesignSystemRevisionStatus;
  feedback: string;
  baseBody: string;
  proposedBody: string;
  createdAt: string;
  updatedAt: string;
  sectionTitle?: string;
  jobId?: string;
}
```

---

## DesignSystemGenerationJob

Async job tạo/revise DS:

```typescript
type DesignSystemGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
type DesignSystemGenerationStepStatus = 'pending' | 'running' | 'succeeded' | 'failed';

interface DesignSystemGenerationStep {
  id: string;
  title: string;
  status: DesignSystemGenerationStepStatus;
  message?: string;
  startedAt?: string;
  completedAt?: string;
}

interface DesignSystemGenerationJob {
  id: string;
  kind?: 'generation' | 'revision';
  status: DesignSystemGenerationJobStatus;
  progress: number;           // 0-100
  steps: DesignSystemGenerationStep[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  designSystemId?: string;
  revisionId?: string;
  error?: string;
  message?: string;
}
```

---

## DesignSystemPackageAudit

Kết quả audit DS package:

```typescript
type DesignSystemPackageAuditSeverity = 'error' | 'warning';

interface DesignSystemPackageAuditIssue {
  severity: DesignSystemPackageAuditSeverity;
  code: string;
  message: string;
  path?: string;
}

interface DesignSystemPackageAudit {
  ok: boolean;
  projectPath: string;
  filesInspected: number;
  errors: DesignSystemPackageAuditIssue[];
  warnings: DesignSystemPackageAuditIssue[];
}
```

---

## CodexPetSummary

Gamification — Virtual pets:

```typescript
interface CodexPetSummary {
  id: string;
  displayName: string;
  description: string;
  spritesheetUrl: string;
  spritesheetExt: string;       // 'png' | 'webp' | 'gif'
  hatchedAt: number;
  bundled?: boolean;
}
```

---

## Import Types

```typescript
type InstallInput =
  | { source: 'github'; url: string }
  | { source: 'local'; path: string };

interface ImportLocalDesignSystemRequest {
  baseDir: string;
  name?: string;
  importMode?: 'normalized' | 'hybrid' | 'verbatim';
  craftApplies?: string[];
}

interface ImportGitHubDesignSystemRequest {
  githubUrl: string;
  branch?: string;
  name?: string;
  importMode?: 'normalized' | 'hybrid' | 'verbatim';
  craftApplies?: string[];
}
```
