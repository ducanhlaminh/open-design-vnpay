# 05 — Prompt Templates & Media UI (T37)

> Components + Page cho 103 prompt templates (46 image + 57 video).  
> Source data: `prompt-templates/` → `/api/prompt-templates/*`

---

## Component Tree

```
MediaPage
├── MediaGenerationPanel (T37)
│   ├── SurfaceTabs (Image | Video | Audio)
│   │
│   ├── Image Tab
│   │   ├── ModeSwitch (Direct | Template)
│   │   ├── [Direct] DirectPromptInput + ModelSelector + AspectSelector + GenerateBtn
│   │   └── [Template] PromptTemplateGallery (surface=image)
│   │       └── PromptTemplateCard[]
│   │           └── PromptTemplateDetailPanel (slide-in)
│   │               ├── previewImageUrl thumbnail
│   │               ├── TemplateArgumentForm
│   │               └── GenerateBtn
│   │
│   ├── Video Tab
│   │   ├── ModeSwitch (Direct | Template | Hyperframes)
│   │   ├── [Direct] DirectPromptInput + ModelSelector + GenerateBtn
│   │   ├── [Template] PromptTemplateGallery (surface=video)
│   │   └── [Hyperframes] HyperframesPanel
│   │
│   └── Audio Tab
│       ├── TTSPanel (text → speech)
│       └── VoiceSelector (ElevenLabs voices)
│
└── MediaTaskHistory
    └── MediaTaskCard[]
```

---

## Component 1: `<PromptTemplateCard>`

**File**: `ui/src/components/PromptTemplateCard.tsx`

```tsx
interface PromptTemplateCardProps {
  template: PromptTemplateSummary;
  isSelected?: boolean;
  onClick: () => void;
}

const SURFACE_ICON = { image: '🖼', video: '🎬' };

export function PromptTemplateCard({ template, isSelected, onClick }: Props) {
  return (
    <div onClick={onClick}
      style={{
        borderRadius: 'var(--radius)', overflow: 'hidden', cursor: 'pointer',
        border: `1px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        background: isSelected ? 'rgba(124,109,250,0.08)' : 'var(--color-surface)',
        transition: 'border-color 0.15s',
      }}>
      {/* Preview image */}
      <div style={{ height: 140, background: 'var(--color-bg)', overflow: 'hidden' }}>
        {template.previewImageUrl ? (
          <img
            src={template.previewImageUrl}
            alt={template.title}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 32 }}>
            {SURFACE_ICON[template.surface]}
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '8px 10px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)', marginBottom: 2,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {template.title}
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
          <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: 'rgba(124,109,250,0.15)', color: 'var(--color-accent)' }}>
            {template.model}
          </span>
          <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
            {template.aspect}
          </span>
          {template.argumentCount > 0 && (
            <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
              {template.argumentCount} args
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
```

---

## Component 2: `<TemplateArgumentForm>`

**File**: `ui/src/components/TemplateArgumentForm.tsx`

```tsx
interface TemplateArgumentFormProps {
  args: Array<{ name: string; default: string }>;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

export function TemplateArgumentForm({ args, values, onChange }: Props) {
  if (args.length === 0) return null;

  const set = (key: string, val: string) => onChange({ ...values, [key]: val });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Arguments
      </div>
      {args.map(arg => (
        <div key={arg.name}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text)', marginBottom: 3 }}>
            {arg.name}
          </label>
          <input
            type="text"
            value={values[arg.name] ?? ''}
            placeholder={arg.default || 'Enter value...'}
            onChange={e => set(arg.name, e.target.value)}
            style={{
              width: '100%', background: 'var(--color-bg)', border: '1px solid var(--color-border)',
              borderRadius: 8, color: 'var(--color-text)', fontSize: 12, padding: '6px 10px',
            }}
          />
          {arg.default && (
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>
              Default: {arg.default}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

---

## Component 3: `<PromptTemplateGallery>`

**File**: `ui/src/components/PromptTemplateGallery.tsx`

```tsx
interface PromptTemplateGalleryProps {
  surface: 'image' | 'video';
  selectedId?: string;
  onSelect: (template: PromptTemplateSummary) => void;
}

export function PromptTemplateGallery({ surface, selectedId, onSelect }: Props) {
  const [templates, setTemplates] = useState<PromptTemplateSummary[]>([]);
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');

  // Load templates
  useEffect(() => {
    api.media.listPromptTemplates({ surface }).then(setTemplates);
  }, [surface]);

  const categories = useMemo(
    () => ['All', ...unique(templates.map(t => t.category))],
    [templates],
  );

  const filtered = templates
    .filter(t => category === 'All' || t.category === category)
    .filter(t => !search || t.title.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      {/* Category pills */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {categories.map(c => (
          <button key={c} onClick={() => setCategory(c)}
            style={{
              padding: '3px 10px', borderRadius: 20, fontSize: 11, cursor: 'pointer',
              border: `1px solid ${category === c ? 'var(--color-accent)' : 'var(--color-border)'}`,
              background: category === c ? 'rgba(124,109,250,0.15)' : 'transparent',
              color: category === c ? 'var(--color-accent)' : 'var(--color-text-muted)',
            }}>
            {c}
          </button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..."
          style={{ marginLeft: 'auto', padding: '3px 8px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 11 }} />
      </div>

      {/* Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10, maxHeight: 400, overflowY: 'auto' }}>
        {filtered.map(t => (
          <PromptTemplateCard key={t.id} template={t} isSelected={t.id === selectedId} onClick={() => onSelect(t)} />
        ))}
      </div>
    </div>
  );
}
```

---

## Component 4: `<MediaTaskCard>`

**File**: `ui/src/components/MediaTaskCard.tsx`

```tsx
export function MediaTaskCard({ task, onRefresh }: { task: MediaJobSummary; onRefresh: () => void }) {
  // Auto-poll if pending/processing
  useEffect(() => {
    if (task.status === 'pending' || task.status === 'processing') {
      const t = setInterval(onRefresh, 3000);
      return () => clearInterval(t);
    }
  }, [task.status]);

  return (
    <div style={{ padding: 12, border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', background: 'var(--color-surface)' }}>
      {/* Status + kind */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <StatusDot status={task.status} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>{task.kind}</span>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
          {task.model}
        </span>
      </div>

      {/* Result */}
      {task.status === 'done' && task.resultUrl && (
        task.kind === 'image' ? (
          <img src={task.resultUrl} alt="Generated" style={{ width: '100%', borderRadius: 8 }} />
        ) : task.kind === 'video' ? (
          <video src={task.resultUrl} controls style={{ width: '100%', borderRadius: 8 }} />
        ) : (
          <audio src={task.resultUrl} controls style={{ width: '100%' }} />
        )
      )}

      {/* Failed */}
      {task.status === 'failed' && (
        <p style={{ fontSize: 12, color: '#fa5050' }}>{task.errorMsg ?? 'Generation failed'}</p>
      )}

      {/* Pending/Processing */}
      {(task.status === 'pending' || task.status === 'processing') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SpinnerIcon />
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {task.status === 'pending' ? 'Queued...' : 'Generating...'}
          </span>
        </div>
      )}

      {/* Download button */}
      {task.status === 'done' && task.resultUrl && (
        <a href={task.resultUrl} download style={{ display: 'block', marginTop: 8, textAlign: 'center', fontSize: 12, color: 'var(--color-accent)' }}>
          ↓ Download
        </a>
      )}
    </div>
  );
}
```

---

## Page: `MediaPage.tsx` (T37 — thực thi)

**File**: `ui/src/pages/MediaPage.tsx`

```tsx
type MediaSurface = 'image' | 'video' | 'audio';
type GenMode = 'direct' | 'template' | 'hyperframes';

export default function MediaPage() {
  const [surface, setSurface] = useState<MediaSurface>('image');
  const [mode, setMode] = useState<GenMode>('direct');

  // Direct prompt state
  const [directPrompt, setDirectPrompt] = useState('');
  const [model, setModel] = useState('gpt-image-2');
  const [aspect, setAspect] = useState('1:1');

  // Template state
  const [selectedTemplate, setSelectedTemplate] = useState<PromptTemplateSummary | null>(null);
  const [templateDetail, setTemplateDetail] = useState<PromptTemplateDetail | null>(null);
  const [argValues, setArgValues] = useState<Record<string, string>>({});

  // Tasks history
  const [tasks, setTasks] = useState<MediaJobSummary[]>([]);
  const [generating, setGenerating] = useState(false);

  // Fetch template detail when selected
  useEffect(() => {
    if (selectedTemplate) {
      api.media.getPromptTemplate(selectedTemplate.id).then(d => {
        setTemplateDetail(d);
        // Init defaults
        const defaults: Record<string, string> = {};
        d.arguments.forEach(a => { defaults[a.name] = a.default; });
        setArgValues(defaults);
      });
    }
  }, [selectedTemplate?.id]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      let task: MediaJobSummary;
      if (mode === 'template' && selectedTemplate) {
        task = await api.media.generateFromPromptTemplate({
          templateId: selectedTemplate.id,
          values: argValues,
          projectId: '',   // TODO: từ context
          outputAspect: aspect,
        });
      } else {
        task = await api.media.generateImage({ prompt: directPrompt, model, aspect, projectId: '' });
      }
      setTasks(prev => [task, ...prev]);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left panel — Generation config */}
      <div style={{ width: 400, borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Surface tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)' }}>
          {(['image', 'video', 'audio'] as MediaSurface[]).map(s => (
            <button key={s} onClick={() => { setSurface(s); setMode('direct'); }}
              style={{
                flex: 1, padding: '10px', fontSize: 13, border: 'none', cursor: 'pointer',
                background: surface === s ? 'var(--color-surface)' : 'transparent',
                color: surface === s ? 'var(--color-text)' : 'var(--color-text-muted)',
                borderBottom: surface === s ? '2px solid var(--color-accent)' : '2px solid transparent',
              }}>
              {{image: '🖼 Image', video: '🎬 Video', audio: '🎵 Audio'}[s]}
            </button>
          ))}
        </div>

        {/* Mode switch */}
        {surface !== 'audio' && (
          <div style={{ display: 'flex', gap: 6, padding: 12 }}>
            {(['direct', 'template', ...(surface === 'video' ? ['hyperframes'] : [])] as GenMode[]).map(m => (
              <button key={m} onClick={() => setMode(m)}
                style={{
                  padding: '4px 10px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${mode === m ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  background: mode === m ? 'rgba(124,109,250,0.15)' : 'transparent',
                  color: mode === m ? 'var(--color-accent)' : 'var(--color-text-muted)',
                }}>
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        )}

        {/* Config area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
          {mode === 'direct' && (
            <DirectGenPanel surface={surface} prompt={directPrompt} onPromptChange={setDirectPrompt}
              model={model} onModelChange={setModel} aspect={aspect} onAspectChange={setAspect} />
          )}
          {mode === 'template' && (
            <div>
              <PromptTemplateGallery surface={surface as 'image' | 'video'}
                selectedId={selectedTemplate?.id} onSelect={setSelectedTemplate} />
              {templateDetail && (
                <div style={{ marginTop: 12 }}>
                  <TemplateArgumentForm args={templateDetail.arguments} values={argValues} onChange={setArgValues} />
                </div>
              )}
            </div>
          )}
          {mode === 'hyperframes' && <HyperframesPanel />}
          {surface === 'audio' && <AudioPanel />}
        </div>

        {/* Generate button */}
        <div style={{ padding: 12, borderTop: '1px solid var(--color-border)' }}>
          <button onClick={handleGenerate} disabled={generating}
            style={{ width: '100%', padding: '10px', borderRadius: 10, border: 'none', background: 'var(--color-accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
            {generating ? 'Generating...' : `✦ Generate ${surface.charAt(0).toUpperCase() + surface.slice(1)}`}
          </button>
        </div>
      </div>

      {/* Right panel — Task history */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Generated
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          {tasks.map(t => (
            <MediaTaskCard key={t.id} task={t} onRefresh={async () => {
              const updated = await api.media.getTaskStatus(t.id);
              setTasks(prev => prev.map(p => p.id === t.id ? updated : p));
            }} />
          ))}
        </div>
        {tasks.length === 0 && (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--color-text-muted)', fontSize: 13 }}>
            Generate an image, video, or audio to see results here
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## Files summary

| File | Hành động |
|------|----------|
| `components/PromptTemplateCard.tsx` | **TẠO MỚI** |
| `components/PromptTemplateGallery.tsx` | **TẠO MỚI** |
| `components/TemplateArgumentForm.tsx` | **TẠO MỚI** |
| `components/MediaTaskCard.tsx` | **TẠO MỚI** |
| `pages/MediaPage.tsx` | **IMPLEMENT** (T37 — hiện là stub) |
