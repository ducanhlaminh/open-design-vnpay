# 01 — Project Models

**Nguồn:** `packages/contracts/src/api/projects.ts`

---

## ProjectKind

```typescript
type ProjectKind =
  | 'prototype'   // Web prototype / landing page
  | 'deck'        // Slide deck
  | 'template'    // Saved template
  | 'other'
  | 'image'       // Image generation
  | 'video'       // Video generation
  | 'audio';      // Audio generation
```

---

## MediaAspect

```typescript
type MediaAspect = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
```

---

## ProjectPlatform

```typescript
type ProjectPlatform =
  | 'auto'
  | 'responsive'
  | 'web-desktop'
  | 'mobile-ios'
  | 'mobile-android'
  | 'tablet'
  | 'desktop-app';
```

---

## AudioKind

```typescript
type AudioKind = 'music' | 'speech' | 'sfx';
```

---

## ProjectDisplayStatus

```typescript
type ProjectDisplayStatus =
  | 'not_started'
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'succeeded'
  | 'failed'
  | 'canceled';

interface ProjectStatusInfo {
  value: ProjectDisplayStatus;
  updatedAt?: number;
  runId?: string;
}
```

---

## PromptTemplateMetadata

Subset của PromptTemplate lưu trên project (reference khi tạo):

```typescript
interface PromptTemplateMetadataSource {
  repo: string;
  license: string;
  author?: string;
  url?: string;
}

interface PromptTemplateMetadata {
  id: string;
  surface: 'image' | 'video';
  title: string;
  prompt: string;           // Có thể user-edited trước khi create
  summary?: string;
  category?: string;
  tags?: string[];
  model?: string;
  aspect?: MediaAspect;
  source?: PromptTemplateMetadataSource;
}
```

---

## DesignSystemReview

Lưu kết quả review các sections khi tạo custom design system:

```typescript
type DesignSystemReviewDecision = 'looks-good' | 'needs-work';
type DesignSystemReviewTaskStatus = 'queued' | 'sent' | 'failed';

interface DesignSystemReviewAgentTask {
  status: DesignSystemReviewTaskStatus;
  prompt: string;
  queuedAt: string;
  sentAt?: string;
  error?: string;
}

interface DesignSystemReviewEntry {
  decision: DesignSystemReviewDecision;
  updatedAt: string;
  feedback?: string;
  files?: string[];
  agentTask?: DesignSystemReviewAgentTask;
}
```

---

## ProjectMetadata

Rich metadata về project, lưu dưới dạng JSON column trong SQLite:

```typescript
interface ProjectMetadata {
  kind: ProjectKind;
  intent?: 'live-artifact';

  // Fidelity & scale
  fidelity?: 'wireframe' | 'high-fidelity';
  speakerNotes?: boolean;
  slideCount?: string;
  animations?: boolean;
  includeLandingPage?: boolean;
  includeOsWidgets?: boolean;

  // Template origin
  templateId?: string;
  templateLabel?: string;

  // Platform & targeting
  platform?: ProjectPlatform;
  platformTargets?: ProjectPlatform[];

  // Naming
  nameSource?: 'generated' | 'prompt' | 'user';

  // Design inspiration
  inspirationDesignSystemIds?: string[];

  // Import origin
  importedFrom?: 'claude-design' | 'folder' | string;
  entryFile?: string;
  sourceFileName?: string;
  baseDir?: string;               // Folder-import: absolute path
  fromTrustedPicker?: true;       // Desktop-trust gate marker
  userWorkingDir?: string;        // Hint from Home composer

  // Media
  imageModel?: string;
  imageAspect?: MediaAspect;
  imageStyle?: string;
  videoModel?: string;            // e.g. 'hyperframes-html'
  videoLength?: number;
  videoAspect?: MediaAspect;
  audioKind?: AudioKind;
  audioModel?: string;
  audioDuration?: number;
  voice?: string;

  // Prompt template
  promptTemplate?: PromptTemplateMetadata;

  // Linked dirs (agent can read via --add-dir)
  linkedDirs?: string[];

  // Skip discovery form for batch/API-created projects
  skipDiscoveryBrief?: boolean;

  // Context references (@ mentions on Home)
  contextPlugins?: ProjectContextPluginRef[];
  contextMcpServers?: ProjectContextMcpServerRef[];
  contextConnectors?: ProjectContextConnectorRef[];

  // Design system review results
  designSystemReview?: Record<string, DesignSystemReviewEntry>;
}
```

---

## Project

```typescript
interface Project {
  id: string;
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  createdAt: number;          // Unix ms
  updatedAt: number;          // Unix ms
  status?: ProjectStatusInfo;
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
  appliedPluginSnapshotId?: string;
  customInstructions?: string;
}
```

---

## ProjectTemplate

```typescript
interface ProjectTemplate {
  id: string;
  name: string;
  sourceProjectId?: string;
  files: Array<{ name: string; content: string }>;
  description?: string;
  createdAt: number;
}
```

---

## Conversation

```typescript
interface Conversation {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  latestRun?: {
    status: ChatRunStatus;
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
  };
}
```

---

## API Request/Response

### CreateProjectRequest
```typescript
interface CreateProjectRequest {
  name: string;
  skillId?: string | null;
  designSystemId?: string | null;
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
  pluginId?: string;
  appliedPluginSnapshotId?: string;
  pluginInputs?: Record<string, unknown>;
  customInstructions?: string;
  skipDiscoveryBrief?: boolean;
}
```

### ImportFolderRequest
```typescript
interface ImportFolderRequest {
  baseDir: string;
  name?: string;
  skillId?: string | null;
  designSystemId?: string | null;
}

interface ImportFolderResponse {
  project: Project;
  conversationId: string;
  entryFile: string | null;
}
```

---

## Deployment Models

```typescript
type DeployProviderId = 'vercel-self' | 'cloudflare-pages';

type DeploymentStatus =
  | 'deploying'
  | 'preparing-link'
  | 'ready'
  | 'link-delayed'
  | 'protected'
  | 'failed';

interface DeploymentInfo {
  id: string;
  projectId: string;
  fileName: string;
  providerId: DeployProviderId;
  url: string;
  deploymentId?: string;
  deploymentCount: number;
  target: 'preview';
  status: DeploymentStatus;
  statusMessage?: string;
  reachableAt?: number;
  cloudflarePages?: CloudflarePagesDeploymentInfo;
  createdAt: number;
  updatedAt: number;
}
```

### Cloudflare Pages types

```typescript
type CloudflarePagesDnsStatus =
  | 'skipped' | 'created' | 'reused' | 'unmarked' | 'patched' | 'conflict' | 'failed';

type CloudflarePagesDomainStatus =
  | 'skipped' | 'pending' | 'active' | 'conflict' | 'failed';

type CloudflarePagesCustomDomainStatus =
  | 'pending' | 'ready' | 'conflict' | 'failed';

interface CloudflarePagesCustomDomainInfo {
  hostname: string;
  url: string;
  zoneId: string;
  zoneName: string;
  domainPrefix: string;
  status: CloudflarePagesCustomDomainStatus;
  statusMessage?: string;
  errorCode?: string;
  errorMessage?: string;
  dnsStatus?: CloudflarePagesDnsStatus;
  dnsRecordId?: string;
  dnsOwnership?: 'marked' | 'unmarked' | 'external';
  domainStatus?: CloudflarePagesDomainStatus;
  pagesDomainStatus?: string;
}

interface CloudflarePagesDeploymentInfo {
  projectName: string;
  pagesDev: DeploymentLinkInfo;
  customDomain?: CloudflarePagesCustomDomainInfo;
}
```

---

## Deploy Preflight

```typescript
type DeployPreflightWarningCode =
  | 'broken-reference'
  | 'invalid-reference'
  | 'large-asset'
  | 'large-bundle'
  | 'large-html'
  | 'external-script'
  | 'external-stylesheet'
  | 'no-doctype'
  | 'no-viewport';

interface DeployPreflightWarning {
  code: DeployPreflightWarningCode;
  message: string;
  path?: string;
  url?: string;
  size?: number;
}

interface DeployPreflightFile {
  path: string;
  size: number;
  mime: string;
  sourcePath: string;
}

interface DeployPreflightResponse {
  providerId: DeployProviderId;
  entry: string;
  files: DeployPreflightFile[];
  totalFiles: number;
  totalBytes: number;
  warnings: DeployPreflightWarning[];
}
```
