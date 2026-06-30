# 06 — Memory & Automation Models

**Nguồn:** `packages/contracts/src/api/memory.ts`, `packages/contracts/src/api/automations.ts`

---

## Memory Models

### MemoryType

```typescript
type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
```

| Type | Mô tả |
|------|-------|
| `user` | Thông tin về user (role, preferences, context) |
| `feedback` | Feedback từ user về output của agent |
| `project` | Thông tin liên quan đến project cụ thể |
| `reference` | Reference material (URLs, docs, data) |

### MemoryEntrySummary

```typescript
interface MemoryEntrySummary {
  id: string;           // File slug, e.g., "user_role"
  name: string;         // Human display title từ frontmatter
  description: string;  // One-line description
  type: MemoryType;
  updatedAt: number;    // Unix ms (file mtime)
}
```

### MemoryEntry

Full entry với Markdown body:

```typescript
interface MemoryEntry extends MemoryEntrySummary {
  body: string;         // Markdown body, frontmatter stripped
}
```

### MemorySuggestion

Đề xuất memory từ extraction (chưa confirm):

```typescript
interface MemorySuggestion {
  id: string;           // Suggestion batch id (không phải file id)
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  source?: {
    kind: 'connector';
    connectorId?: string;
    connectorName?: string;
    accountLabel?: string;
    toolName?: string;
    toolTitle?: string;
  };
}
```

---

## Memory Config

### MemoryExtractionProvider

```typescript
type MemoryExtractionProvider =
  | 'anthropic'
  | 'openai'
  | 'azure'
  | 'google'
  | 'ollama'
  | 'senseaudio';
```

### MemoryExtractionConfig

```typescript
interface MemoryExtractionConfig {
  provider: MemoryExtractionProvider;
  model?: string;       // Default: 'claude-haiku-4-5' / 'gpt-4o-mini' / etc.
  baseUrl?: string;
  apiKey?: string;
  apiVersion?: string;  // Azure only
}
```

### MemoryListResponse

```typescript
interface MemoryListResponse {
  enabled: boolean;                         // Memory injection ON/OFF
  chatExtractionEnabled: boolean;           // Auto-extract từ chat
  rootDir: string;                          // Absolute path
  index: string;                            // MEMORY.md content
  entries: MemoryEntrySummary[];
  extraction: MemoryExtractionMaskedConfig | null;
}
```

---

## Memory Extraction Records

Track lịch sử extraction (heuristic và LLM):

```typescript
type MemoryExtractionKind = 'heuristic' | 'llm' | 'connector';

type MemoryExtractionPhase =
  | 'running'
  | 'success'
  | 'skipped'
  | 'failed'
  | 'deleted'
  | 'cleared';

type MemoryExtractionSkipReason =
  | 'no-provider'
  | 'memory-disabled'
  | 'chat-disabled'
  | 'empty-message'
  | 'no-match';         // Heuristic only: ran but 0 captures

interface MemoryExtractionRecord {
  id: string;
  kind?: MemoryExtractionKind;
  startedAt: number;
  finishedAt?: number;
  phase: MemoryExtractionPhase;
  reason?: MemoryExtractionSkipReason;
  provider?: {
    kind: MemoryExtractionProvider;
    model: string;
    credentialSource:
      | 'memory-config'
      | 'env'
      | 'media-config'
      | 'chat-byok'
      | 'chat-cli';
  };
  userMessagePreview: string;    // First ~120 chars
  proposedCount?: number;
  writtenCount?: number;
  writtenIds?: string[];
  error?: string;
}
```

---

## Memory SSE Events

```typescript
type MemoryChangeKind =
  | 'upsert'
  | 'delete'
  | 'index'
  | 'config'
  | 'extract';

interface MemoryChangeEvent {
  kind: MemoryChangeKind;
  id?: string;
  name?: string;
  description?: string;
  type?: MemoryType;
  count?: number;          // 'extract' only: entries written
  source?: 'heuristic' | 'llm' | 'manual' | 'connector';
  enabled?: boolean;       // 'config' only
  at: number;              // Unix ms
}
```

---

## MemoryTreeNode

Tree view của memory store:

```typescript
type MemoryTreeNodeKind = 'folder' | 'entry';

type MemoryTreeNodeScope =
  | 'global'
  | 'project'
  | 'connector'
  | 'artifact'
  | 'design-system'
  | 'skill';

interface MemoryTreeNode {
  id: string;
  parentId: string | null;
  path: string;
  name: string;
  description?: string;
  kind: MemoryTreeNodeKind;
  type?: MemoryType;
  scope: MemoryTreeNodeScope;
  sourcePacketIds: string[];
  proposalIds: string[];
  createdAt: string;
  updatedAt: string;
  childrenCount?: number;
}
```

---

## Automation Models

### AutomationTemplate

Blueprint cho automation pipeline:

```typescript
type AutomationTriggerKind = 'manual' | 'schedule' | 'connector' | 'project-event';

type AutomationSourceKind =
  | 'upload' | 'url' | 'repo' | 'connector' | 'artifact' | 'chat';

type AutomationOutputSink =
  | 'memory' | 'skill' | 'design-system' | 'automation-template' | 'artifact';

type AutomationReviewPolicy = 'always' | 'trusted-source' | 'auto-apply';
type AutomationTokenCompressionMode = 'off' | 'balanced' | 'aggressive';

type AutomationTemplateStageKind =
  | 'ingest' | 'canonicalize' | 'redact' | 'compress'
  | 'classify' | 'propose' | 'agent-run' | 'apply' | 'notify';

interface AutomationTemplateStage {
  id: string;
  kind: AutomationTemplateStageKind;
  title: string;
  description?: string;
  config?: JsonValue;
}

interface AutomationTemplate {
  id: string;
  title: string;
  description: string;
  purpose: string;
  triggerKinds: AutomationTriggerKind[];
  sourceKinds: AutomationSourceKind[];
  stages: AutomationTemplateStage[];
  outputSinks: AutomationOutputSink[];
  reviewPolicy: AutomationReviewPolicy;
  tokenCompression: AutomationTokenCompressionMode;
  context?: RunContextSelection;
  tags?: string[];
}
```

---

### AutomationRunSummary

```typescript
type AutomationRunStatus =
  | 'queued' | 'running' | 'needs-review' | 'succeeded' | 'failed' | 'canceled';

interface AutomationRunSummary {
  id: string;
  templateId: string;
  status: AutomationRunStatus;
  triggerKind: AutomationTriggerKind;
  startedAt: string;
  completedAt?: string;
  projectId?: string;
  sourcePacketIds: string[];
  proposalIds: string[];
  summary?: string;
  error?: string;
}
```

---

### AutomationContentPacket

Ingested content packet (data flowing through automation):

```typescript
type AutomationSensitivity =
  | 'public' | 'workspace' | 'private' | 'secret-adjacent';

interface AutomationTokenStats {
  originalTokens: number;
  canonicalTokens?: number;
  compressedTokens?: number;
  compressionRatio?: number;
}

interface AutomationAttachmentRef {
  id: string;
  name: string;
  mimeType?: string;
  path?: string;
  sizeBytes?: number;
  tokenEstimate?: number;
}

interface AutomationContentPacket {
  id: string;
  sourceEventId: string;
  sourceKind: AutomationSourceKind;
  sourceRef: string;
  title: string;
  capturedAt: string;
  bodyMarkdown: string;
  provenance: AutomationProvenanceRef[];
  attachments: AutomationAttachmentRef[];
  sensitivity: AutomationSensitivity;
  capabilityHints: string[];
  tokenStats: AutomationTokenStats;
  candidateSinks: AutomationOutputSink[];
  metadata?: JsonValue;
}
```

---

### AutomationEvolutionProposal

Đề xuất thay đổi (create/update/delete memory/skill/DS):

```typescript
type AutomationProposalTargetKind =
  | 'memory-node' | 'skill' | 'design-system' | 'automation-template';

type AutomationProposalAction =
  | 'create' | 'update' | 'merge' | 'move' | 'delete' | 'promote';

type AutomationProposalStatus =
  | 'draft' | 'pending-review' | 'applied' | 'rejected' | 'superseded' | 'failed';

type AutomationProposalPatchFormat = 'markdown' | 'json' | 'file-tree';

interface AutomationProposalPatch {
  format: AutomationProposalPatchFormat;
  before?: string;
  after?: string;
  diffSummary?: string;
}

interface AutomationCompressionReport {
  mode: AutomationTokenCompressionMode;
  status: 'not-run' | 'applied' | 'skipped' | 'failed';
  beforeTokens: number;
  afterTokens: number;
  summary: string;
  warnings?: string[];
  preservedSourcePacketId?: string;
}

interface AutomationEvolutionProposal {
  id: string;
  title: string;
  summary: string;
  targetKind: AutomationProposalTargetKind;
  action: AutomationProposalAction;
  status: AutomationProposalStatus;
  reviewPolicy: AutomationReviewPolicy;
  createdAt: string;
  updatedAt: string;
  sourcePacketIds: string[];
  automationRunId?: string;
  targetRef?: string;
  patch: AutomationProposalPatch;
  confidence?: number;
  compressionReport?: AutomationCompressionReport;
  metadata?: JsonValue;
}
```
