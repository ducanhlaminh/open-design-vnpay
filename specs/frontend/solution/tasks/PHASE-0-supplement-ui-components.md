# PHASE-0 Supplement — UI Core Components

> **Phạm vi**: `ui/src/components/` — Core React components bổ sung từ gap analysis PRD/SRS/URD  
> **Nguồn**: FR-06.4, FR-07, FR-08, FR-21  
> **Bổ sung cho**: [PHASE-0-supplement-api-clients.md](./PHASE-0-supplement-api-clients.md)

---

## T28 — `<QuestionForm>` Component (FR-07, US-02-01)

**File**: `ui/src/components/QuestionForm.tsx`  
**Effort**: 8h  
**Status**: `[ ]`

**Mô tả**: Turn-1 discovery form render từ SSE `question_form` event. Agent gửi form **trước** khi viết bất kỳ code nào — đây là tính năng CORE của sản phẩm.

```typescript
// Types (từ SRS FR-07.1)
interface FormField {
  id: string;
  type: 'radio' | 'text' | 'select';
  label: string;
  options?: string[];      // cho radio/select
  placeholder?: string;
  required?: boolean;
}

interface QuestionFormData {
  id: string;              // 'discovery'
  fields: FormField[];
  title?: string;
}

interface QuestionFormProps {
  form: QuestionFormData;
  onSubmit: (answers: Record<string, string>) => void;
  onSkip?: () => void;
  disabled?: boolean;      // true khi agent đang xử lý
}

export function QuestionForm({ form, onSubmit, onSkip, disabled }: QuestionFormProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit(answers); }}>
      <h3>{form.title ?? 'Tell me about your project'}</h3>
      
      {form.fields.map(field => (
        <div key={field.id} className="form-field">
          <label>{field.label}</label>
          
          {field.type === 'radio' && (
            <div className="radio-group">
              {field.options?.map(opt => (
                <label key={opt}>
                  <input type="radio" name={field.id} value={opt}
                    checked={answers[field.id] === opt}
                    onChange={e => setAnswers(a => ({ ...a, [field.id]: e.target.value }))}
                  />
                  {opt}
                </label>
              ))}
            </div>
          )}
          
          {field.type === 'text' && (
            <input type="text" placeholder={field.placeholder}
              value={answers[field.id] ?? ''}
              onChange={e => setAnswers(a => ({ ...a, [field.id]: e.target.value }))}
            />
          )}
        </div>
      ))}
      
      <div className="form-actions">
        {onSkip && <button type="button" onClick={onSkip}>Skip</button>}
        <button type="submit" disabled={disabled}>Continue →</button>
      </div>
    </form>
  );
}
```

**Standard form fields** (SRS FR-07.1):
```
surface      → radio: desktop | mobile | tablet
audience     → text: "Who is this for?"
tone         → radio: formal | casual | playful | professional
brand_context→ text: "Brand colors, fonts, existing assets"
scale        → radio: 1-page | multi-page | full-app
constraints  → text: "Any technical constraints?"
```

**Acceptance Criteria**:
- [ ] Render radio, text, select field types
- [ ] Submit answers đúng format: `Record<string, string>`
- [ ] Skip button optional (bỏ qua discovery)
- [ ] Form disabled state khi agent processing
- [ ] Responsive: desktop + mobile layout
- [ ] Không quá 8 fields (URD UNF-02)

---

## T29 — `<DirectionPicker>` Component (FR-07.2, US-02-02)

**File**: `ui/src/components/DirectionPicker.tsx`  
**Effort**: 6h  
**Status**: `[ ]`

**Mô tả**: Visual direction picker với 5 design aesthetics. Render từ SSE `direction_picker` event.

```typescript
// 5 directions từ SRS FR-07.2 — hardcoded (không thay đổi theo SRS)
const BUILTIN_DIRECTIONS = [
  {
    id: 'editorial-monocle',
    name: 'Editorial Monocle',
    description: 'Magazine-quality editorial with luxurious restraint',
    palette: ['#2B2B2B', '#F5F0E8', '#C9A84C', '#FFFFFF'],
    fontStack: ['Playfair Display', 'Inter'],
  },
  {
    id: 'modern-minimal',
    name: 'Modern Minimal',
    description: 'Crisp white space with bold typography',
    palette: ['#FFFFFF', '#0F0F0F', '#5B5BFF', '#F0F0F0'],
    fontStack: ['Inter', 'Roboto Mono'],
  },
  {
    id: 'warm-soft',
    name: 'Warm Soft',
    description: 'Approachable warmth with natural textures',
    palette: ['#F2E8E4', '#FFFAF7', '#C17C54', '#4A3728'],
    fontStack: ['Lora', 'DM Sans'],
  },
  {
    id: 'tech-utility',
    name: 'Tech Utility',
    description: 'Precision-engineered for power users',
    palette: ['#0A1628', '#00D4FF', '#64748B', '#F8FAFC'],
    fontStack: ['JetBrains Mono', 'Inter'],
  },
  {
    id: 'brutalist-experimental',
    name: 'Brutalist Experimental',
    description: 'Raw, uncompromising, unapologetically bold',
    palette: ['#000000', '#C8FF00', '#FFFFFF', '#FF0000'],
    fontStack: ['Space Grotesk'],
  },
];

interface DirectionPickerProps {
  directions?: typeof BUILTIN_DIRECTIONS;
  onSelect: (directionId: string) => void;
  disabled?: boolean;
}

export function DirectionPicker({ directions = BUILTIN_DIRECTIONS, onSelect, disabled }: DirectionPickerProps) {
  const [selected, setSelected] = useState<string | null>(null);
  
  return (
    <div className="direction-picker">
      <h3>Choose your visual direction</h3>
      <div className="directions-grid">
        {directions.map(dir => (
          <button
            key={dir.id}
            className={`direction-card ${selected === dir.id ? 'selected' : ''}`}
            onClick={() => {
              setSelected(dir.id);
              onSelect(dir.id);
            }}
            disabled={disabled}
          >
            <div className="color-swatches">
              {dir.palette.map((color, i) => (
                <div key={i} style={{ backgroundColor: color, width: 24, height: 24 }} />
              ))}
            </div>
            <strong>{dir.name}</strong>
            <span className="fonts">{dir.fontStack.join(' + ')}</span>
            <p>{dir.description}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
```

**Acceptance Criteria**:
- [ ] 5 direction cards với color swatches (4 màu mỗi card)
- [ ] Font stack hiển thị dưới tên
- [ ] Click → selected state (border/highlight)
- [ ] `onSelect(directionId)` gọi ngay khi click
- [ ] Sau khi chọn, artifact dùng đúng palette (không freestyle màu)

---

## T30 — `<TodoCard>` Component (FR-06.4, US-02-03)

**File**: `ui/src/components/TodoCard.tsx`  
**Effort**: 4h  
**Status**: `[ ]`

**Mô tả**: Real-time todo progress từ SSE `todo` event. Hiển thị các bước agent đang thực thi.

```typescript
interface TodoItem {
  id: string;
  text: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
}

interface TodoCardProps {
  items: TodoItem[];
  isStreaming?: boolean;
}

export function TodoCard({ items, isStreaming }: TodoCardProps) {
  return (
    <div className={`todo-card ${isStreaming ? 'streaming' : ''}`}>
      {items.map(item => (
        <div key={item.id} className={`todo-item status-${item.status}`}>
          <StatusIcon status={item.status} />
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}

// Icons: queued → ○, in_progress → spinner, completed → ✓, failed → ✗
```

**Acceptance Criteria**:
- [ ] Icon mỗi status: `○` queued, `⟳` in_progress, `✓` completed, `✗` failed
- [ ] `in_progress` item có CSS pulse/spin animation
- [ ] Items update real-time (React state driven by SSE)
- [ ] User thấy "Reading SKILL.md → in_progress" → "completed" → step tiếp theo

---

## T31 — `<ArtifactViewer>` Component (FR-08, US-02-04)

**File**: `ui/src/components/ArtifactViewer.tsx`  
**Effort**: 12h  
**Status**: `[ ]`

**Mô tả**: Sandboxed iframe render artifact HTML. Tính năng CORE — không có viewer = không có sản phẩm.

```typescript
interface ArtifactViewerProps {
  html: string;            // Full HTML content
  title: string;
  identifier: string;      // Unique artifact ID
  projectId: string;
  fileName?: string;       // File trong project (cho export)
  mode?: 'desktop' | 'mobile';
}

export function ArtifactViewer({
  html, title, identifier, projectId, fileName, mode = 'desktop'
}: ArtifactViewerProps) {
  const [viewMode, setViewMode] = useState<'desktop' | 'mobile'>(mode);
  
  // Mobile: wrap HTML trong viewport meta + optional device frame
  const processedHtml = viewMode === 'mobile'
    ? addMobileViewport(html)
    : html;
  
  return (
    <div className={`artifact-viewer mode-${viewMode}`}>
      {/* Toolbar */}
      <div className="artifact-toolbar">
        <span className="title">{title}</span>
        
        {/* Mode toggle */}
        <div className="mode-toggle">
          <button onClick={() => setViewMode('desktop')} className={viewMode === 'desktop' ? 'active' : ''}>
            🖥 Desktop
          </button>
          <button onClick={() => setViewMode('mobile')} className={viewMode === 'mobile' ? 'active' : ''}>
            📱 Mobile
          </button>
        </div>
        
        {/* Export chips (PRD F-05) */}
        <ExportChips projectId={projectId} fileName={fileName ?? 'index.html'} />
      </div>
      
      {/* Iframe */}
      <div className="iframe-container">
        <iframe
          srcDoc={processedHtml}
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
          loading="lazy"
          title={title}
          className="artifact-iframe"
        />
      </div>
    </div>
  );
}

// Download chips: HTML, PDF, ZIP, Markdown, Deploy
function ExportChips({ projectId, fileName }: { projectId: string; fileName: string }) {
  const [showDeploy, setShowDeploy] = useState(false);
  
  return (
    <div className="export-chips">
      <button onClick={() => triggerDownload(api.export.exportHTML(projectId, fileName), `${fileName}`)}>
        HTML ↓
      </button>
      <button onClick={() => triggerDownload(api.export.exportPDF(projectId, fileName), `${fileName}.pdf`)}>
        PDF ↓
      </button>
      <button onClick={() => triggerDownload(api.export.downloadArchiveZip(projectId), 'project.zip')}>
        ZIP ↓
      </button>
      <button onClick={() => triggerDownload(api.export.downloadTranscriptMarkdown(projectId), 'transcript.md')}>
        Markdown ↓
      </button>
      <button onClick={() => setShowDeploy(true)}>Deploy ↗</button>
      
      {showDeploy && (
        <DeployDialog projectId={projectId} fileName={fileName} onClose={() => setShowDeploy(false)} />
      )}
    </div>
  );
}
```

**Acceptance Criteria**:
- [ ] `srcDoc` (không phải `src`) — không cần server
- [ ] `sandbox="allow-scripts allow-forms allow-popups allow-same-origin"` đúng
- [ ] Click, scroll, hover, CSS animations hoạt động trong iframe
- [ ] Mode toggle desktop ↔ mobile không reload iframe (chỉ thay CSS wrapper)
- [ ] Export chips: HTML, PDF, ZIP, Markdown, Deploy
- [ ] Render time < 2s (NFR-01)
- [ ] Mobile mode: max-width 390px (iPhone 15 Pro)

---

## T32 — `<FileWorkspace>` Component (FR-08.3, US-03-03)

**File**: `ui/src/components/FileWorkspace/index.tsx`  
**Effort**: 12h  
**Status**: `[ ]`

**Mô tả**: File editor với syntax highlighting, auto-save, preview sync.

**Sub-components**:
```
FileWorkspace/
├── index.tsx        ← Main layout
├── FileTree.tsx     ← Sidebar file list
├── CodeEditor.tsx   ← Editor (CodeMirror lazy-load)
├── DiffView.tsx     ← Version diff khi agent update
└── useAutoSave.ts   ← Debounce save hook
```

```typescript
// useAutoSave.ts
export function useAutoSave(
  projectId: string,
  path: string | null,
  content: string,
  delayMs = 2000  // 2 giây (URD US-03-03)
) {
  const saveRef = useRef<ReturnType<typeof setTimeout>>();
  
  useEffect(() => {
    if (!path || !content) return;
    
    clearTimeout(saveRef.current);
    saveRef.current = setTimeout(async () => {
      await api.projects.writeFile(projectId, path, content);
    }, delayMs);
    
    return () => clearTimeout(saveRef.current);
  }, [projectId, path, content]);
}
```

**File API endpoints cần có**:
```
GET  /api/projects/:id/files           → danh sách files
GET  /api/projects/:id/files/:name     → đọc content
PUT  /api/projects/:id/files/:name     → ghi content
DELETE /api/projects/:id/files/:name   → xóa file
```

**Acceptance Criteria**:
- [ ] File list load từ `GET /api/projects/:id/files`
- [ ] Syntax highlighting: HTML, CSS, JavaScript, Markdown
- [ ] Auto-save 2 giây sau lần gõ cuối
- [ ] Refresh file list khi nhận SSE `file_op` event
- [ ] Diff view khi agent tạo version mới

---

## T33 — `<PreviewComments>` Overlay (FR-08.4, US-03-02)

**File**: `ui/src/components/PreviewComments.tsx`  
**Effort**: 8h  
**Status**: `[ ]`

**Mô tả**: Annotation overlay trên artifact preview.

```typescript
type PreviewMode = 'interact' | 'comment';  // Switch rõ ràng

interface PreviewComment {
  id: string;
  elementId: string;
  selector: string;       // CSS selector
  text: string;
  position: { x: number; y: number; width: number; height: number };
  status: 'open' | 'resolved';
}

interface PreviewCommentsProps {
  projectId: string;
  conversationId: string;
  mode: PreviewMode;
  onCommentAdded?: (comment: PreviewComment) => void;
}
```

**Comment flow**:
1. User chuyển sang **comment mode**
2. Click element trong iframe
3. Inject click listener vào iframe qua `postMessage`
4. Dialog hiện → user nhập comment text
5. POST `/api/preview-comments` với `{elementId, selector, position, text}`
6. Comment pin render đúng vị trí
7. Next agent turn → comment text inject vào context

**Acceptance Criteria**:
- [ ] Comment mode vs interact mode phân biệt rõ (icon toggle)
- [ ] Click element → dialog → save comment
- [ ] Comment pin hiển thị đúng position trên iframe
- [ ] Status toggle: `open` ↔ `resolved`
- [ ] Comments inject vào conversation như context

---

## T34 — `<AppSettingsDialog>` Full Schema (FR-21, US-09-01 → US-09-03)

**File**: `ui/src/components/SettingsDialog/`  
**Effort**: 16h  
**Status**: `[ ]`

**Mô tả**: Full settings dialog implement đầy đủ `AppConfig` schema từ SRS FR-21.1.

**Tabs & Nội dung**:

```typescript
// SRS FR-21.1 AppConfig — Full schema
interface AppConfig {
  // General
  theme?: 'system' | 'light' | 'dark';
  accentColor?: string;
  
  // Agent
  mode: 'daemon' | 'api';
  agentId: string | null;
  agentModels?: Record<string, AgentModelChoice>;    // model per agent
  agentCliEnv?: AgentCliEnvConfig;                   // env vars per agent
  maxTokens?: number;
  
  // API / BYOK
  apiKey: string;
  baseUrl: string;
  model: string;
  apiProtocol?: 'anthropic' | 'openai' | 'azure' | 'google' | 'ollama' | 'senseaudio';
  apiProtocolConfigs?: Record<ApiProtocol, ApiProtocolConfig>;
  
  // Media
  mediaProviders?: Record<string, MediaProviderCredentials>;
  // Keys: dalle, elevenlabs, stability, fal, seedance, hyperframes
  
  // Connectors
  composio?: ComposioSettings;
  
  // Routines / Orbit
  orbit?: OrbitConfig;         // enabled, time, templateSkillId
  notifications?: NotificationsConfig;
  
  // Skills / Design Systems
  disabledSkills?: string[];
  disabledDesignSystems?: string[];
  
  // Custom Instructions
  customInstructions?: string;  // max 2000 chars
  
  // Privacy (FR-21.2)
  installationId?: string | null;
  privacyDecisionAt?: number | null;
  telemetry?: {
    metrics?: boolean;         // DEFAULT: true
    content?: boolean;         // DEFAULT: true
    artifactManifest?: boolean; // DEFAULT: false
  };
  
  // Pet (gamification)
  pet?: PetConfig;
}
```

**Tab layout**:
```
SettingsDialog/
├── index.tsx              ← Dialog container + tab navigation
├── tabs/
│   ├── GeneralTab.tsx     ← theme, accent color
│   ├── AgentTab.tsx       ← agentId, models, CLI env vars
│   ├── APITab.tsx         ← mode, provider, key (masked), test connection
│   ├── MediaTab.tsx       ← image/video/audio API keys (masked)
│   ├── MCPTab.tsx         ← MCP config editor
│   ├── ConnectorsTab.tsx  ← Composio settings
│   ├── RoutinesTab.tsx    ← orbit config, notifications
│   ├── PrivacyTab.tsx     ← telemetry toggles, delete data
│   └── InstructionsTab.tsx← customInstructions textarea
└── components/
    ├── APIKeyInput.tsx    ← masked input (show last 4 chars)
    └── TestConnection.tsx ← test button + result indicator
```

**APIKeyInput** (SRS NFR-03 "API key masking"):
```typescript
// Show only last 4 chars: "••••••••••••abcd"
function APIKeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [isEditing, setIsEditing] = useState(false);
  
  const maskedValue = value && !isEditing
    ? '•'.repeat(Math.max(0, value.length - 4)) + value.slice(-4)
    : value;
  
  return (
    <div className="api-key-input">
      <input
        type={isEditing ? 'text' : 'password'}
        value={maskedValue}
        onFocus={() => setIsEditing(true)}
        onBlur={() => setIsEditing(false)}
        onChange={e => onChange(e.target.value)}
      />
      <button onClick={() => setIsEditing(!isEditing)}>
        {isEditing ? '🙈' : '👁'}
      </button>
    </div>
  );
}
```

**Privacy Tab** (SRS FR-21.2):
```typescript
// Telemetry defaults: metrics=ON, content=ON, artifactManifest=OFF
// "Delete my data" → xóa installationId + reset privacyDecisionAt
//                   → KHÔNG xóa projects (URD US-09-01 AC)
```

**Acceptance Criteria**:
- [ ] Tab General: theme light/dark/system, accent color picker
- [ ] Tab Agent: agent picker, model per-agent, CLI env vars injection
- [ ] Tab API: mode selector, provider picker, API key (mask 4 chars), test connection
- [ ] Tab Media: API keys cho DALL-E, ElevenLabs, Seedance, HeyGen, Stability, FAL
- [ ] Tab Privacy: 3 telemetry toggles, "Delete my data" (xóa ID, không xóa projects)
- [ ] Tab Instructions: textarea 2000 chars với counter
- [ ] Settings persist qua browser reload (localStorage + API sync)
- [ ] API keys không log vào console (SRS NFR-03)

---

## T35 — `<DeployDialog>` Component (FR-10, US-04-03)

**File**: `ui/src/components/DeployDialog.tsx`  
**Effort**: 6h  
**Status**: `[ ]`

**Mô tả**: Dialog nhập Vercel/Cloudflare token và trigger deployment.

```typescript
interface DeployDialogProps {
  projectId: string;
  fileName: string;
  onClose: () => void;
}

export function DeployDialog({ projectId, fileName, onClose }: DeployDialogProps) {
  const [provider, setProvider] = useState<'vercel' | 'cloudflare'>('vercel');
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [polling, setPolling] = useState(false);
  
  // Vercel fields: token, teamId, projectName
  // Cloudflare fields: token, accountId, projectName
  
  const handleDeploy = async (formData: DeployFormData) => {
    let result: Deployment;
    
    if (provider === 'vercel') {
      result = await api.deploy.deployToVercel(projectId, { fileName, ...formData });
    } else {
      result = await api.deploy.deployToCloudflare(projectId, { fileName, ...formData });
    }
    
    setDeployment(result);
    
    // Poll status: pending → ready/failed (max 120s)
    if (result.status === 'pending') {
      setPolling(true);
      await pollDeploymentStatus(result.id);
      setPolling(false);
    }
  };
  
  return (
    <dialog className="deploy-dialog">
      <h2>Deploy to {provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages'}</h2>
      
      {/* Provider tabs */}
      <div className="provider-tabs">
        <button onClick={() => setProvider('vercel')} className={provider === 'vercel' ? 'active' : ''}>
          Vercel
        </button>
        <button onClick={() => setProvider('cloudflare')} className={provider === 'cloudflare' ? 'active' : ''}>
          Cloudflare Pages
        </button>
      </div>
      
      {deployment ? (
        <DeploymentStatus deployment={deployment} polling={polling} />
      ) : (
        <DeployForm provider={provider} onSubmit={handleDeploy} />
      )}
    </dialog>
  );
}
```

**Acceptance Criteria**:
- [ ] Provider switch: Vercel ↔ Cloudflare
- [ ] Deploy < 60s với artifact < 1MB (NFR-01)
- [ ] Status indicator: `pending` → `building` → `ready` / `failed`
- [ ] URL hiển thị khi `ready`, có thể copy/open
- [ ] Token field masked

---

## T36 — `<ImportDialog>` Component (FR-11, US-06-01)

**File**: `ui/src/components/ImportDialog.tsx`  
**Effort**: 4h  
**Status**: `[ ]`

**Mô tả**: Import Claude Design ZIP và GitHub Design System.

```typescript
export function ImportDialog({ onClose, onImported }: ImportDialogProps) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file?.name.endsWith('.zip')) {
      setError('Please drop a .zip file exported from Claude Design');
      return;
    }
    
    setUploading(true);
    try {
      const { projectId, name } = await api.import.importClaudeDesignZip(file);
      onImported(projectId, name);
      onClose();
    } catch (err) {
      setError('Invalid ZIP format. Make sure this is exported from Claude Design.');
    } finally {
      setUploading(false);
    }
  };
  
  return (
    <dialog>
      <h2>Import from Claude Design</h2>
      <div
        className={`drop-zone ${dragOver ? 'over' : ''}`}
        onDragOver={() => setDragOver(true)}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {uploading ? <Spinner /> : 'Drop .zip file here'}
      </div>
      {error && <p className="error">{error}</p>}
    </dialog>
  );
}
```

**Acceptance Criteria**:
- [ ] Drag & drop .zip file
- [ ] File picker fallback (click to browse)
- [ ] Error message rõ nếu ZIP invalid (URD US-06-01 AC)
- [ ] Project history được giữ nguyên sau import

---

## T37 — `<MediaGenerationPanel>` (FR-13, US-05-01 → US-05-03)

**File**: `ui/src/components/MediaGenerationPanel.tsx`  
**Effort**: 10h  
**Status**: `[ ]`

**Mô tả**: Tạo image, video, audio với template picker và status polling.

```typescript
type MediaKind = 'image' | 'video' | 'audio';

interface MediaGenerationPanelProps {
  projectId: string;
  kind: MediaKind;
  onGenerated?: (task: MediaTask) => void;
}

export function MediaGenerationPanel({ projectId, kind, onGenerated }: MediaGenerationPanelProps) {
  const [task, setTask] = useState<MediaTask | null>(null);
  const [polling, setPolling] = useState(false);
  
  // Prompt templates từ prompt-templates/ directory
  const templates = usePromptTemplates(kind);
  // Image: 43 templates, Video: 39 Seedance + 11 HyperFrames, Audio: speech/effects
  
  const handleGenerate = async (formData: MediaGenerationFormData) => {
    let result: MediaTask;
    
    if (kind === 'image') {
      result = await api.media.generateImage({ ...formData, projectId });
    } else if (kind === 'video') {
      result = await api.media.generateVideo({ ...formData, projectId });
    } else {
      result = await api.media.generateAudio({ ...formData, projectId });
    }
    
    setTask(result);
    
    // Poll nếu không phải immediate
    if (result.status === 'pending' || result.status === 'processing') {
      setPolling(true);
      const finalTask = await pollMediaTask(api.media, result.id, setTask);
      setPolling(false);
      onGenerated?.(finalTask);
    }
  };
  
  return (
    <div className="media-panel">
      <PromptTemplateSelector kind={kind} templates={templates} />
      <MediaForm kind={kind} onSubmit={handleGenerate} />
      {task && <MediaTaskStatus task={task} polling={polling} />}
    </div>
  );
}
```

**Cho từng kind**:
- **Image**: model picker (gpt-image-2), aspect ratio (1:1/16:9/4:3/9:16)
- **Video**: model picker (seedance-2.0/hyperframes-html), duration, aspect, source image (image-to-video)
- **Audio**: kind (speech/sound_effects), voice picker (ElevenLabs), text input

**Acceptance Criteria**:
- [ ] Image generation < 30s (URD US-05-01 AC)
- [ ] Video: async poll với progress indicator
- [ ] Audio: voice list từ `GET /api/elevenlabs/voices` với ElevenLabs Fallback
- [ ] Download result: image (PNG/WebP), video (.mp4), audio (.mp3)
- [ ] Preview inline: image hiển thị, video player, audio player

---

## T38 — `<RoutinesManager>` (FR-14, FR-15, US-08-01, US-08-02)

**File**: `ui/src/components/RoutinesManager/`  
**Effort**: 8h  
**Status**: `[ ]`

**Mô tả**: Quản lý scheduled automation và Orbit daily digest.

```typescript
// Sub-components:
// RoutineList.tsx — danh sách routines với status, enable/disable toggle
// RoutineEditor.tsx — form tạo/edit routine
// RoutineRunHistory.tsx — run history với status/error
// OrbitConfig.tsx — cấu hình Orbit (enabled, time, templateSkillId)
```

**RoutineEditor fields**:
```typescript
interface RoutineFormData {
  name: string;
  prompt: string;
  scheduleKind: 'daily' | 'weekly' | 'once';
  scheduleValue: string;   // '09:00' | 'monday' | '2026-06-05'
  projectMode: 'new' | 'existing';
  projectId?: string;      // nếu projectMode = 'existing'
  skillId?: string;
  agentId?: string;
  enabled: boolean;
}
```

**Acceptance Criteria**:
- [ ] Create routine với schedule: daily/weekly/once (URD US-08-01 AC)
- [ ] Timezone awareness (schedule theo local time)
- [ ] Routine run history với status: running/succeeded/failed
- [ ] Manual trigger button
- [ ] Orbit section: enable toggle, time picker, template skill selector
- [ ] Orbit không chạy nếu không có connector data (URD US-08-02 AC)

---

## T39 — App Entry Point & Router Setup (cho Phase 3)

**File**: `ui/src/main.tsx`, `ui/src/router.tsx`, `ui/src/layouts/RootLayout.tsx`  
**Effort**: 6h  
**Status**: `[ ]`

**Mô tả**: Wiring tất cả components vào React Router và layout chính.

```typescript
// router.tsx — Full routes mapping
export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <HomePage /> },                    // project list + onboarding
      { path: 'projects/:id', element: <ProjectPage /> },        // main workspace
      { path: 'projects/:id/files', element: <ProjectFilesPage /> },
      { path: 'design-systems', element: <DesignSystemsPage /> },
      { path: 'design-systems/:id', element: <DesignSystemDetailPage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'skills/:id', element: <SkillDetailPage /> },
      { path: 'routines', element: <RoutinesPage /> },
      { path: 'media', element: <MediaPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'onboarding', element: <OnboardingPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

// RootLayout: sidebar navigation + main content area + settings dialog
```

**Acceptance Criteria**:
- [ ] Tất cả routes navigate đúng page
- [ ] SPA: browser back/forward hoạt động
- [ ] 404 page cho unknown routes
- [ ] Layout: sidebar (nav), main area, dialog overlay
- [ ] Settings dialog accessible từ mọi page

---

## Summary — Tất cả Supplement Tasks

| Task | Feature | Effort | FR |
|------|---------|--------|-----|
| T16 | SSE all event types | 4h | FR-06.4 |
| T17 | ExportApiClient | 4h | FR-09 |
| T18 | DeployApiClient | 6h | FR-10 |
| T19 | ImportApiClient | 3h | FR-11 |
| T20 | TemplatesApiClient | 3h | FR-12 |
| T21 | MediaApiClient + polling | 8h | FR-13 |
| T22 | RoutinesApiClient | 4h | FR-14 |
| T23 | MCPApiClient | 4h | FR-16 |
| T24 | MemoryApiClient | 3h | FR-17 |
| T25 | ConnectorsApiClient | 4h | FR-22 |
| T26 | PluginsApiClient | 4h | FR-18 |
| T27 | Update api/index.ts | 1h | All |
| T28 | `<QuestionForm>` | 8h | FR-07.1 |
| T29 | `<DirectionPicker>` | 6h | FR-07.2 |
| T30 | `<TodoCard>` | 4h | FR-06.4 |
| T31 | `<ArtifactViewer>` + ExportChips | 12h | FR-08 |
| T32 | `<FileWorkspace>` | 12h | FR-08.3 |
| T33 | `<PreviewComments>` | 8h | FR-08.4 |
| T34 | `<AppSettingsDialog>` Full | 16h | FR-21 |
| T35 | `<DeployDialog>` | 6h | FR-10 |
| T36 | `<ImportDialog>` | 4h | FR-11 |
| T37 | `<MediaGenerationPanel>` | 10h | FR-13 |
| T38 | `<RoutinesManager>` | 8h | FR-14/15 |
| T39 | App Entry + Router + Layout | 6h | All |
| **Total** | | **~162h** | |
