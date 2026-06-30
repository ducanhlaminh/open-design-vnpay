# 03 — Artifact Models

**Nguồn:** `packages/contracts/src/api/artifacts.ts`, `packages/contracts/src/api/live-artifacts.ts`, `packages/contracts/src/api/files.ts`

---

## ArtifactKind

```typescript
type ArtifactKind =
  | 'html'
  | 'deck'
  | 'react-component'
  | 'markdown-document'
  | 'svg'
  | 'diagram'
  | 'code-snippet'
  | 'mini-app'
  | 'design-system';
```

---

## ArtifactRendererId

```typescript
type ArtifactRendererId =
  | 'html'
  | 'deck-html'
  | 'react-component'
  | 'markdown'
  | 'svg'
  | 'diagram'
  | 'code'
  | 'mini-app'
  | 'design-system';
```

---

## ArtifactExportKind

```typescript
type ArtifactExportKind = 'html' | 'pdf' | 'zip' | 'pptx' | 'jsx' | 'md' | 'svg' | 'txt';
```

---

## Artifact Provenance Types

Metadata về nguồn gốc và phân phối artifact:

```typescript
type ArtifactProvenanceTaskKind =
  | 'new-generation'
  | 'code-migration'
  | 'figma-migration'
  | 'tune-collab';

type ArtifactProvenanceArtifactKind =
  | 'html-prototype'
  | 'deck'
  | 'interactive-video'
  | 'design-system'
  | 'code-diff'
  | 'production-app'
  | 'asset-pack';

type ArtifactProvenanceRenderKind =
  | 'html' | 'jsx' | 'pptx' | 'markdown' | 'video' | 'image' | 'diff' | 'repo';

type ArtifactProvenanceHandoffKind =
  | 'design-only'
  | 'implementation-plan'
  | 'patch'
  | 'deployable-app';

type ArtifactExportSurface =
  | 'cli' | 'desktop' | 'web' | 'docker' | 'github' | 'figma' | 'code-agent';

type ArtifactDeployProvider =
  | 'aws' | 'gcp' | 'azure' | 'aliyun' | 'tencent' | 'huawei' | 'self-hosted';

interface ArtifactExportTarget {
  surface: ArtifactExportSurface;
  target: string;
  exportedAt: number;
}

interface ArtifactDeployTarget {
  provider: ArtifactDeployProvider;
  location: string;
  deployedAt: number;
}
```

---

## ArtifactManifest

File `artifact.json` (hoặc embedded) mô tả một artifact:

```typescript
interface ArtifactManifest {
  version: 1;
  kind: ArtifactKind;
  title: string;
  entry: string;               // Entry file path (e.g., 'index.html')
  renderer: ArtifactRendererId;
  status?: 'streaming' | 'complete' | 'error';
  exports: ArtifactExportKind[];
  primary?: string | boolean;
  supportingFiles?: string[];
  createdAt?: string;
  updatedAt?: string;
  sourceSkillId?: string;
  designSystemId?: string | null;
  metadata?: Record<string, unknown>;

  // Plugin provenance (v1)
  sourcePluginSnapshotId?: string;
  sourcePluginId?: string;
  sourcePluginVersion?: string;
  sourceTaskKind?: ArtifactProvenanceTaskKind;
  sourceRunId?: string;
  sourceProjectId?: string;
  parentArtifactId?: string;

  artifactKind?: ArtifactProvenanceArtifactKind;
  renderKind?: ArtifactProvenanceRenderKind;
  handoffKind?: ArtifactProvenanceHandoffKind;

  exportTargets?: ArtifactExportTarget[];
  deployTargets?: ArtifactDeployTarget[];
}
```

---

## ProjectFile

File trong project folder trên disk:

```typescript
type ProjectFileKind =
  | 'html'
  | 'image'
  | 'video'
  | 'audio'
  | 'sketch'
  | 'text'
  | 'code'
  | 'pdf'
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'binary';

interface ProjectFile {
  name: string;
  path?: string;
  type?: 'file' | 'dir';
  size: number;           // bytes
  mtime: number;          // Unix ms
  kind: ProjectFileKind;
  mime: string;
  artifactKind?: ArtifactKind;
  artifactManifest?: ArtifactManifest;
  stubGuardWarning?: ProjectFileStubGuardWarning;
}

// Emitted khi agent tạo artifact regression (smaller than previous)
interface ProjectFileStubGuardWarning {
  code: 'ARTIFACT_REGRESSION';
  message: string;
  identifier: string;
  newSize: number;
  priorSize: number;
  priorName: string;
}
```

---

## LiveArtifact

Refreshable artifact với source data và preview:

```typescript
type LiveArtifactStatus = 'active' | 'archived' | 'error';
type LiveArtifactRefreshStatus = 'never' | 'idle' | 'running' | 'succeeded' | 'failed';
type LiveArtifactPreviewType = 'html' | 'jsx' | 'markdown';
type LiveArtifactSourceType = 'local_file' | 'daemon_tool' | 'connector_tool';
type LiveArtifactConnectorApprovalPolicy = 'read_only_auto' | 'manual_refresh_granted_for_read_only';
type LiveArtifactRefreshPermission = 'none' | 'manual_refresh_granted_for_read_only';
type LiveArtifactOutputTransform = 'identity' | 'compact_table' | 'metric_summary';
type LiveArtifactProvenanceGenerator = 'agent' | 'refresh_runner';
type LiveArtifactProvenanceSourceType = 'connector' | 'local_file' | 'user_input' | 'derived';

interface LiveArtifactPreview {
  type: LiveArtifactPreviewType;
  entry: string;            // File path to render
}

interface LiveArtifactSource {
  type: LiveArtifactSourceType;
  toolName?: string;
  input: BoundedJsonObject;
  connector?: {
    connectorId: string;
    accountLabel?: string;
    toolName: string;
    approvalPolicy?: LiveArtifactConnectorApprovalPolicy;
  };
  outputMapping?: {
    dataPaths?: Array<{ from: string; to: string }>;
    transform?: LiveArtifactOutputTransform;
  };
  refreshPermission: LiveArtifactRefreshPermission;
}

interface LiveArtifactDocument {
  format: 'html_template_v1';
  templatePath: 'template.html';
  generatedPreviewPath: 'index.html';
  dataPath: 'data.json';
  dataJson: BoundedJsonObject;          // Cached from data.json
  dataSchemaJson?: BoundedJsonObject;
  sourceJson?: LiveArtifactSource;
}

interface LiveArtifactProvenance {
  generatedAt: string;
  generatedBy: LiveArtifactProvenanceGenerator;
  notes?: string;
  sources: LiveArtifactProvenanceSource[];
}

interface LiveArtifact {
  schemaVersion: 1;
  id: string;
  projectId: string;
  sessionId?: string;
  createdByRunId?: string;
  title: string;
  slug: string;
  status: LiveArtifactStatus;
  pinned: boolean;
  preview: LiveArtifactPreview;
  refreshStatus: LiveArtifactRefreshStatus;
  createdAt: string;
  updatedAt: string;
  lastRefreshedAt?: string;
  document: LiveArtifactDocument;
}

// Summary (list endpoint — không có document)
type LiveArtifactSummary = Omit<LiveArtifact, 'document'> & {
  hasDocument: boolean;
};
```

---

## LiveArtifactRefreshLog

Log mỗi bước refresh:

```typescript
type LiveArtifactRefreshStepStatus =
  | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

interface LiveArtifactRefreshErrorRecord {
  code?: string;
  message: string;
  path?: string;
}

interface LiveArtifactRefreshSourceMetadata {
  sourceType: 'document';
  toolName?: string;
  connector?: {
    connectorId: string;
    accountLabel?: string;
    toolName: string;
    approvalPolicy?: LiveArtifactConnectorApprovalPolicy;
  };
}

interface LiveArtifactRefreshLogEntry {
  schemaVersion: 1;
  projectId: string;
  artifactId: string;
  refreshId: string;
  sequence: number;
  step: string;
  status: LiveArtifactRefreshStepStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  source?: LiveArtifactRefreshSourceMetadata;
  error?: LiveArtifactRefreshErrorRecord;
  metadata?: BoundedJsonObject;
  createdAt: string;
}
```

---

## PreviewComment

Annotation trực tiếp trên artifact preview:

```typescript
type PreviewCommentStatus =
  | 'open'
  | 'attached'
  | 'applying'
  | 'needs_review'
  | 'resolved'
  | 'failed';

interface PreviewCommentPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PreviewAnnotationStyle {
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  textAlign?: string;
  fontFamily?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  borderRadius?: string;
}

type PreviewCommentSelectionKind = 'element' | 'pod';
type PreviewVisualMarkKind = 'click' | 'stroke' | 'click+stroke';

interface PreviewCommentMember {
  elementId: string;
  selector: string;
  label: string;
  text: string;
  position: PreviewCommentPosition;
  htmlHint: string;
  style?: PreviewAnnotationStyle;
}

interface PreviewComment {
  id: string;
  projectId: string;
  conversationId: string;
  filePath: string;
  elementId: string;
  selector: string;
  label: string;
  text: string;
  position: PreviewCommentPosition;
  htmlHint: string;
  style?: PreviewAnnotationStyle;
  selectionKind?: PreviewCommentSelectionKind;
  memberCount?: number;
  podMembers?: PreviewCommentMember[];
  note: string;
  status: PreviewCommentStatus;
  createdAt: number;
  updatedAt: number;
}
```
