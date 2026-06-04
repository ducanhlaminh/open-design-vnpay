# PHASE-0 Supplement — UI Core Components Tasks

> **Phạm vi**: `ui/src/` — Components bổ sung từ gap analysis PRD/SRS/URD  
> **Bổ sung cho**: [PHASE-0-api-abstraction.md](./PHASE-0-api-abstraction.md)  
> **Nguồn yêu cầu**: FR-06.4, FR-07, FR-08, FR-09, FR-11, FR-12, FR-13

---

## T16 — Bổ sung SSE Event Types (FR-06.4)

**File**: `ui/src/api/runs/http.ts` (MODIFY)  
**Effort**: 4h  
**Status**: `[ ]`

**Mô tả**: Bổ sung handler cho tất cả 9 SSE event types từ SRS FR-06.4.

```typescript
// Tất cả event types cần handle trong SSE parser:
type SSEEventType =
  | 'delta'          // {text: string} — text token từ agent ← đã có
  | 'tool_use'       // {name, input, output} — tool call ← đã có
  | 'todo'           // {items: TodoItem[]} — live todo tracking ← THIẾU
  | 'artifact'       // {html, title, identifier} — artifact emitted ← THIẾU
  | 'file_op'        // {path, operation} — file write/delete ← THIẾU
  | 'question_form'  // {fields: FormField[]} — Turn-1 discovery form ← THIẾU
  | 'direction_picker' // {directions: Direction[]} — visual directions ← THIẾU
  | 'end'            // {runId, status} — turn kết thúc ← đã có
  | 'error';         // {message, code} — lỗi ← đã có

// TodoItem (từ SRS FR-06.4):
interface TodoItem {
  id: string;
  text: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
}

// FormField (từ SRS FR-07.1):
interface FormField {
  id: string;          // 'surface', 'audience', 'tone', etc.
  type: 'radio' | 'text' | 'select';
  label: string;
  options?: string[];  // cho radio/select
  placeholder?: string;
  required?: boolean;
}

// Direction (từ SRS FR-07.2):
interface Direction {
  id: string;
  name: string;        // 'Editorial Monocle', 'Modern Minimal', etc.
  description: string;
  palette: OKLchColor[];
  fontStack: string[];
  previewColors: string[]; // hex values cho UI display
}
```

**Checklist**:
- [ ] `sse-parser.ts` parse đúng tất cả 9 event types
- [ ] `todo` event: update TodoItem list real-time
- [ ] `artifact` event: trigger artifact rendering
- [ ] `file_op` event: refresh file workspace
- [ ] `question_form` event: emit lên UI layer để render form
- [ ] `direction_picker` event: emit lên UI layer để render picker
- [ ] Unrecognized event types: log và bỏ qua (không crash)

---

## T17 — `ExportApiClient` (FR-09)

**File**: `ui/src/api/export/`  
**Effort**: 4h  
**Status**: `[ ]`

**Mô tả**: API client cho tất cả export formats. Dựa trên SRS FR-09.

```typescript
// ui/src/api/export/client.ts
interface IExportApiClient {
  exportHTML(projectId: string, fileName: string): Promise<Blob>;
  exportPDF(projectId: string, fileName: string): Promise<Blob>;
  downloadArchiveZip(projectId: string): Promise<Blob>;
  downloadTranscriptMarkdown(projectId: string): Promise<Blob>;
}

// ui/src/api/export/http.ts
class HttpExportApiClient extends BaseApiClient implements IExportApiClient {
  async exportHTML(projectId: string, fileName: string): Promise<Blob> {
    // GET /api/projects/:id/files/:name/export/html
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/files/${fileName}/export/html`);
    return res.blob();  // trigger browser download
  }
  
  async exportPDF(projectId: string, fileName: string): Promise<Blob> {
    // GET /api/projects/:id/files/:name/export/pdf
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/files/${fileName}/export/pdf`);
    return res.blob();
  }
  
  async downloadArchiveZip(projectId: string): Promise<Blob> {
    // GET /api/projects/:id/archive
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/archive`);
    return res.blob();
  }
}
```

**Acceptance Criteria**:
- [ ] `exportHTML()` tải file HTML với assets inlined
- [ ] `exportPDF()` tải file PDF
- [ ] `downloadArchiveZip()` tải toàn bộ project
- [ ] Trigger browser download đúng cách (dùng `URL.createObjectURL`)
- [ ] File name được set từ `Content-Disposition` header

---

## T18 — `DeployApiClient` (FR-10)

**File**: `ui/src/api/deploy/`  
**Effort**: 6h  
**Status**: `[ ]`

**Mô tả**: Deploy lên Vercel hoặc Cloudflare Pages. Dựa trên SRS FR-10.

```typescript
// ui/src/api/deploy/client.ts
interface IDeployApiClient {
  deployToVercel(projectId: string, req: VercelDeployRequest): Promise<Deployment>;
  deployToCloudflare(projectId: string, req: CloudflareDeployRequest): Promise<Deployment>;
  getDeploymentStatus(projectId: string, deploymentId: string): Promise<Deployment>;
  listDeployments(projectId: string): Promise<Deployment[]>;
  listCloudflarZones(token: string): Promise<CloudflareZone[]>;
}

interface VercelDeployRequest {
  fileName: string;
  token: string;
  teamId?: string;
  projectName?: string;
}

interface CloudflareDeployRequest {
  fileName: string;
  accountId: string;
  token: string;
  projectName: string;
}

interface Deployment {
  id: string;
  projectId: string;
  fileName: string;
  providerId: 'vercel' | 'cloudflare';
  url: string;
  deploymentId?: string;
  deploymentCount: number;
  status: 'ready' | 'pending' | 'failed';
  statusMessage?: string;
  createdAt: number;
  updatedAt: number;
}
```

**Acceptance Criteria**:
- [ ] `deployToVercel()` → POST `/api/projects/:id/deployments/vercel`
- [ ] `deployToCloudflare()` → POST `/api/projects/:id/deployments/cloudflare`
- [ ] Status polling: 3s interval, max 120s timeout
- [ ] `listCloudflarZones()` → GET `/api/cloudflare/zones`

---

## T19 — `ImportApiClient` (FR-11)

**File**: `ui/src/api/import/`  
**Effort**: 3h  
**Status**: `[ ]`

**Mô tả**: Import project từ Claude Design ZIP. Dựa trên SRS FR-11.1.

```typescript
// ui/src/api/import/client.ts
interface IImportApiClient {
  importClaudeDesignZip(file: File): Promise<{ projectId: string; name: string }>;
  importDesignSystemFromGitHub(repoUrl: string): Promise<{ designSystemId: string }>;
}

// ui/src/api/import/http.ts
class HttpImportApiClient extends BaseApiClient implements IImportApiClient {
  async importClaudeDesignZip(file: File): Promise<{ projectId: string; name: string }> {
    // POST /api/import/claude-design — multipart/form-data
    const formData = new FormData();
    formData.append('zip', file);
    
    const res = await fetch(`${this.baseUrl}/api/import/claude-design`, {
      method: 'POST',
      body: formData,
      // KHÔNG set Content-Type — browser tự set với boundary
    });
    
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res.json();
  }
}
```

**Acceptance Criteria**:
- [ ] Multipart upload đúng format
- [ ] File size validation client-side (max 100MB)
- [ ] Progress indicator trong upload
- [ ] Error handling: ZIP invalid → rõ ràng message

---

## T20 — `TemplatesApiClient` (FR-12)

**File**: `ui/src/api/templates/`  
**Effort**: 3h  
**Status**: `[ ]`

**Mô tả**: Quản lý project templates. Dựa trên SRS FR-12.

```typescript
interface ITemplatesApiClient {
  list(): Promise<ProjectTemplate[]>;
  get(id: string): Promise<ProjectTemplate>;
  create(req: CreateTemplateRequest): Promise<ProjectTemplate>;
  update(id: string, req: Partial<CreateTemplateRequest>): Promise<ProjectTemplate>;
  delete(id: string): Promise<void>;
}

interface ProjectTemplate {
  id: string;
  name: string;
  description?: string;
  sourceProjectId?: string;
  files: ProjectFile[];
  createdAt: number;
}

interface CreateTemplateRequest {
  name: string;
  description?: string;
  sourceProjectId: string;
}
```

**Endpoints**:
```
GET    /api/templates
POST   /api/templates
GET    /api/templates/:id
PUT    /api/templates/:id
DELETE /api/templates/:id
```

---

## T21 — `MediaApiClient` (FR-13)

**File**: `ui/src/api/media/`  
**Effort**: 8h  
**Status**: `[ ]`

**Mô tả**: Image, Video, Audio generation. Dựa trên SRS FR-13.

```typescript
// ui/src/api/media/client.ts
interface IMediaApiClient {
  // Image
  generateImage(req: ImageGenerationRequest): Promise<MediaTask>;
  
  // Video
  generateVideo(req: VideoGenerationRequest): Promise<MediaTask>;
  
  // Audio
  generateAudio(req: AudioGenerationRequest): Promise<MediaTask>;
  
  // Status polling
  getTaskStatus(taskId: string): Promise<MediaTask>;
  listTasks(projectId: string): Promise<MediaTask[]>;
  
  // ElevenLabs voices
  listVoices(): Promise<ElevenLabsVoice[]>;
}

interface ImageGenerationRequest {
  prompt: string;
  projectId: string;
  model: string;          // 'gpt-image-2', 'dall-e-3', etc.
  aspect: '1:1' | '16:9' | '4:3' | '9:16' | '3:4';
}

interface VideoGenerationRequest {
  prompt: string;
  projectId: string;
  model: 'seedance-2.0' | 'hyperframes-html';
  duration?: number;      // seconds
  aspect: string;
  sourceImage?: string;   // URL for image-to-video
}

interface AudioGenerationRequest {
  projectId: string;
  kind: 'speech' | 'sound_effects';
  text?: string;          // cho speech
  prompt?: string;        // cho sound effects
  voiceId?: string;       // ElevenLabs voice
}

interface MediaTask {
  id: string;
  projectId: string;
  kind: 'image' | 'video' | 'audio';
  status: 'pending' | 'processing' | 'ready' | 'failed';
  prompt: string;
  model: string;
  providerId: string;
  resultUrl?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}
```

**Media Task Polling Pattern**:
```typescript
// Async polling — không blocking
async function pollMediaTask(
  client: IMediaApiClient,
  taskId: string,
  onUpdate: (task: MediaTask) => void,
  maxWaitMs = 300_000  // 5 phút max
): Promise<MediaTask> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    const task = await client.getTaskStatus(taskId);
    onUpdate(task);
    
    if (task.status === 'ready' || task.status === 'failed') {
      return task;
    }
    
    // Exponential backoff: 2s, 4s, 8s, max 15s
    const elapsed = Date.now() - startTime;
    const delay = Math.min(2000 * Math.pow(1.5, Math.floor(elapsed / 10_000)), 15_000);
    await new Promise(r => setTimeout(r, delay));
  }
  
  throw new Error('Media generation timed out');
}
```

**Acceptance Criteria**:
- [ ] `generateImage()` → `POST /api/media/image`
- [ ] `generateVideo()` → `POST /api/media/video`
- [ ] `generateAudio()` → `POST /api/media/audio`
- [ ] `listVoices()` → `GET /api/elevenlabs/voices` (với ElevenLabs Fallback khi lỗi)
- [ ] Polling với exponential backoff
- [ ] `getTaskStatus()` → `GET /api/media/tasks/:id`

---

## T22 — `RoutinesApiClient` (FR-14)

**File**: `ui/src/api/routines/`  
**Effort**: 4h  
**Status**: `[ ]`

**Mô tả**: Scheduled automation. Dựa trên SRS FR-14.

```typescript
interface IRoutinesApiClient {
  list(): Promise<Routine[]>;
  get(id: string): Promise<Routine>;
  create(req: CreateRoutineRequest): Promise<Routine>;
  update(id: string, req: Partial<CreateRoutineRequest>): Promise<Routine>;
  delete(id: string): Promise<void>;
  triggerManualRun(id: string): Promise<RoutineRun>;
  listRuns(id: string): Promise<RoutineRun[]>;
}

interface Routine {
  id: string;
  name: string;
  prompt: string;
  scheduleKind: 'daily' | 'weekly' | 'once';
  scheduleValue: string;   // '09:00' | 'monday' | '2026-06-05'
  projectMode: 'new' | 'existing';
  projectId?: string;
  skillId?: string;
  agentId?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
```

---

## T23 — `MCPApiClient` (FR-16)

**File**: `ui/src/api/mcp/`  
**Effort**: 4h  
**Status**: `[ ]`

**Mô tả**: Model Context Protocol config management.

```typescript
interface IMCPApiClient {
  getConfig(): Promise<MCPConfig>;
  updateConfig(config: MCPConfig): Promise<MCPConfig>;
  listTemplates(): Promise<MCPConfigTemplate[]>;
  beginOAuth(serverId: string): Promise<{ authUrl: string }>;
  getTokens(): Promise<MCPToken[]>;
  refreshToken(serverId: string): Promise<void>;
}
```

---

## T24 — `MemoryApiClient` (FR-17)

**File**: `ui/src/api/memory/`  
**Effort**: 3h  
**Status**: `[ ]`

```typescript
interface IMemoryApiClient {
  list(): Promise<MemoryEntry[]>;
  extract(messageId: string): Promise<MemoryEntry[]>;
  delete(id: string): Promise<void>;
}
```

---

## T25 — `ConnectorsApiClient` (FR-22)

**File**: `ui/src/api/connectors/`  
**Effort**: 4h  
**Status**: `[ ]`

```typescript
interface IConnectorsApiClient {
  list(): Promise<Connector[]>;
  getStatus(): Promise<ConnectorStatus[]>;
  discover(): Promise<ConnectorDiscovery[]>;
  get(id: string): Promise<Connector>;
  connect(id: string): Promise<OAuthResult>;
  disconnect(id: string): Promise<void>;
  getAuthStatus(id: string): Promise<AuthStatus>;
  getComposioConfig(): Promise<ComposioConfig>;
  updateComposioConfig(config: ComposioConfig): Promise<ComposioConfig>;
}
```

---

## T26 — `PluginsApiClient` (FR-18)

**File**: `ui/src/api/plugins/`  
**Effort**: 4h  
**Status**: `[ ]`

```typescript
interface IPluginsApiClient {
  list(): Promise<Plugin[]>;
  get(id: string): Promise<Plugin>;
  install(source: string): Promise<Plugin>;
  uninstall(id: string): Promise<void>;
  apply(id: string, projectId: string): Promise<void>;
  getSnapshot(snapshotId: string): Promise<PluginSnapshot>;
}
```

---

## T27 — Cập nhật `api/index.ts` với tất cả clients mới

**File**: `ui/src/api/index.ts` (MODIFY)  
**Effort**: 1h  
**Status**: `[ ]`

```typescript
// ui/src/api/index.ts — Updated with ALL clients
export const api = {
  // Existing (T01–T09)
  projects: new HttpProjectApiClient(),
  runs: new HttpRunsApiClient(),
  designSystems: new HttpDesignSystemApiClient(),
  skills: new HttpSkillApiClient(),
  config: new HttpConfigApiClient(),
  agents: new HttpAgentApiClient(),
  connectors: new HttpConnectorsApiClient(),
  
  // New from gap analysis (T17–T26)
  export: new HttpExportApiClient(),
  deploy: new HttpDeployApiClient(),
  import: new HttpImportApiClient(),
  templates: new HttpTemplatesApiClient(),
  media: new HttpMediaApiClient(),
  routines: new HttpRoutinesApiClient(),
  mcp: new HttpMCPApiClient(),
  memory: new HttpMemoryApiClient(),
  plugins: new HttpPluginsApiClient(),
} as const;

export type Api = typeof api;
```
