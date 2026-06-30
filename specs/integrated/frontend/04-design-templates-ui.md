# 04 — Design Templates UI

> Components + Page cho 110+ design templates.  
> Source data: `design-templates/` → `/api/design-templates/*`

---

## Component Tree

```
HomePage (Templates tab)
└── TemplateGallery
    ├── TemplateModeFilter (All | Prototype | Deck | Document | Media)
    ├── TemplateSearch
    └── TemplateGrid
        └── TemplateCard[]
            └── TemplateDetailModal (on click)
                ├── iframe (example.html — full preview)
                ├── TemplateInputForm (od.inputs)
                ├── DesignSystemPicker (nếu requires: true)
                └── CreateProjectButton
```

---

## Component 1: `<TemplateCard>`

**File**: `ui/src/components/TemplateCard.tsx`

```tsx
interface TemplateCardProps {
  template: DesignTemplateSummary;
  onUse: (t: DesignTemplateSummary) => void;
}

const MODE_ICONS: Record<TemplateMode, string> = {
  prototype: '🖥',
  deck:      '🎞',
  template:  '📄',
  image:     '🖼',
  video:     '🎬',
  audio:     '🎵',
};

export function TemplateCard({ template, onUse }: TemplateCardProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderRadius: 'var(--radius)',
        border: '1px solid var(--color-border)',
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
        borderColor: hovered ? 'var(--color-accent)' : undefined,
      }}
      onClick={() => onUse(template)}
    >
      {/* Preview iframe — scale-down trick */}
      <div style={{ position: 'relative', height: 180, overflow: 'hidden', background: 'var(--color-bg)' }}>
        {template.hasExample ? (
          <iframe
            src={template.exampleUrl}
            sandbox="allow-scripts allow-same-origin"
            loading="lazy"
            style={{
              width: template.platform === 'mobile' ? 390 : '100%',
              height: template.mode === 'deck' ? 800 : 600,
              border: 'none',
              transform: template.platform === 'mobile' ? 'scale(0.46)' : 'scale(0.3)',
              transformOrigin: 'top left',
              pointerEvents: 'none',
            }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 32 }}>
            {MODE_ICONS[template.mode]}
          </div>
        )}

        {/* Mode badge */}
        <div style={{
          position: 'absolute', top: 8, left: 8,
          fontSize: 10, fontWeight: 600, padding: '2px 6px',
          borderRadius: 4, background: 'rgba(0,0,0,0.7)', color: '#fff',
        }}>
          {MODE_ICONS[template.mode]} {template.mode.charAt(0).toUpperCase() + template.mode.slice(1)}
        </div>

        {/* Platform chip */}
        {template.platform && (
          <div style={{ position: 'absolute', top: 8, right: 8, fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(0,0,0,0.5)', color: '#fff' }}>
            {template.platform}
          </div>
        )}

        {/* Hover overlay */}
        {hovered && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(124,109,250,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ background: 'var(--color-accent)', color: '#fff', padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500 }}>
              Use Template
            </span>
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)', marginBottom: 2 }}>
          {template.name}
        </div>
        {template.description && (
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {template.description}
          </div>
        )}
        {template.inputs.length > 0 && (
          <div style={{ fontSize: 10, color: 'var(--color-accent)', marginTop: 4 }}>
            {template.inputs.length} input{template.inputs.length > 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## Component 2: `<TemplateInputForm>`

**File**: `ui/src/components/TemplateInputForm.tsx`

```tsx
interface TemplateInputFormProps {
  inputs: TemplateInput[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

export function TemplateInputForm({ inputs, values, onChange }: Props) {
  const set = (key: string, val: string) =>
    onChange({ ...values, [key]: val });

  if (inputs.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h4 style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Template Inputs
      </h4>
      {inputs.map(input => (
        <div key={input.name}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text)', marginBottom: 4 }}>
            {input.name}
            {input.required && <span style={{ color: '#fa5050', marginLeft: 3 }}>*</span>}
          </label>

          {input.type === 'text' ? (
            <textarea
              value={values[input.name] ?? input.default ?? ''}
              onChange={e => set(input.name, e.target.value)}
              placeholder={input.placeholder ?? input.default}
              rows={3}
              style={{ width: '100%', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 8, color: 'var(--color-text)', fontSize: 13, padding: '8px 12px', resize: 'vertical' }}
            />
          ) : input.type === 'select' && input.options ? (
            <select
              value={values[input.name] ?? input.default ?? ''}
              onChange={e => set(input.name, e.target.value)}
              style={{ width: '100%', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 8, color: 'var(--color-text)', fontSize: 13, padding: '8px 12px' }}
            >
              {input.options.map(opt => <option key={opt}>{opt}</option>)}
            </select>
          ) : input.type === 'boolean' ? (
            <label>
              <input type="checkbox" checked={values[input.name] === 'true'} onChange={e => set(input.name, String(e.target.checked))} />
              <span style={{ marginLeft: 8, fontSize: 13 }}>{input.default ?? 'Enable'}</span>
            </label>
          ) : (
            <input
              type={input.type === 'number' ? 'number' : 'text'}
              value={values[input.name] ?? input.default ?? ''}
              onChange={e => set(input.name, e.target.value)}
              placeholder={input.placeholder ?? input.default}
              style={{ width: '100%', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 8, color: 'var(--color-text)', fontSize: 13, padding: '8px 12px' }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
```

---

## Component 3: `<TemplateDetailModal>`

**File**: `ui/src/components/TemplateDetailModal.tsx`

```tsx
interface TemplateDetailModalProps {
  templateId: string;
  onClose: () => void;
  onCreateProject: (templateId: string, inputs: Record<string, string>, dsId?: string) => Promise<void>;
}

export function TemplateDetailModal({ templateId, onClose, onCreateProject }: Props) {
  const [template, setTemplate] = useState<DesignTemplateSummary | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [selectedDsId, setSelectedDsId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.designTemplates.getDesignTemplate(templateId).then(t => {
      setTemplate(t);
      // Init default values
      const defaults: Record<string, string> = {};
      t.inputs.forEach(i => { if (i.default) defaults[i.name] = i.default; });
      setInputs(defaults);
    });
  }, [templateId]);

  const handleCreate = async () => {
    setCreating(true);
    await onCreateProject(templateId, inputs, selectedDsId ?? undefined);
    setCreating(false);
    onClose();
  };

  return (
    <div style={{ /* backdrop */ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ width: 880, maxWidth: '95vw', height: '80vh', background: 'var(--color-surface)', borderRadius: 16, border: '1px solid var(--color-border)', display: 'flex', overflow: 'hidden' }}>

        {/* Left — Preview */}
        <div style={{ flex: 1, background: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {template?.hasExample && (
            <iframe
              src={api.designTemplates.getTemplateExampleUrl(templateId)}
              sandbox={template?.mode === 'deck'
                ? 'allow-scripts allow-same-origin' // allow keyboard nav
                : 'allow-scripts'}
              style={{ width: '100%', height: '100%', border: 'none' }}
            />
          )}
        </div>

        {/* Right — Config panel */}
        <div style={{ width: 320, padding: 24, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-accent)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
              {MODE_ICONS[template?.mode ?? 'prototype']} {template?.mode}
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text)' }}>
              {template?.name}
            </h2>
            {template?.description && (
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                {template.description}
              </p>
            )}
          </div>

          {/* Template inputs */}
          {template && <TemplateInputForm inputs={template.inputs} values={inputs} onChange={setInputs} />}

          {/* DS picker */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 6 }}>
              Design System
            </label>
            <DesignSystemPicker selectedId={selectedDsId} onSelect={setSelectedDsId} />
          </div>

          {/* CTA */}
          <div style={{ marginTop: 'auto' }}>
            <button onClick={handleCreate} disabled={creating} style={{ width: '100%', padding: '10px', borderRadius: 10, border: 'none', background: 'var(--color-accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              {creating ? 'Creating...' : 'Create Project →'}
            </button>
            <button onClick={onClose} style={{ width: '100%', marginTop: 8, padding: '8px', borderRadius: 10, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-muted)', fontSize: 13, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

---

## Component 4: `<TemplateGallery>`

**File**: `ui/src/components/TemplateGallery.tsx`

```tsx
const MODES: Array<{ label: string; value: TemplateMode | 'all' }> = [
  { label: 'All', value: 'all' },
  { label: '🖥 Prototype', value: 'prototype' },
  { label: '🎞 Deck', value: 'deck' },
  { label: '📄 Document', value: 'template' },
  { label: '🖼 Image', value: 'image' },
  { label: '🎬 Video', value: 'video' },
];

export function TemplateGallery({ onUseTemplate }: { onUseTemplate?: (t: DesignTemplateSummary) => void }) {
  const [templates, setTemplates] = useState<DesignTemplateSummary[]>([]);
  const [mode, setMode] = useState<TemplateMode | 'all'>('all');
  const [search, setSearch] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);

  const filtered = templates
    .filter(t => mode === 'all' || t.mode === mode)
    .filter(t => !search || t.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      {/* Mode filter tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {MODES.map(m => (
          <button key={m.value} onClick={() => setMode(m.value)}
            style={{
              padding: '5px 12px', borderRadius: 20, border: '1px solid var(--color-border)',
              background: mode === m.value ? 'var(--color-accent)' : 'transparent',
              color: mode === m.value ? '#fff' : 'var(--color-text-muted)', fontSize: 12, cursor: 'pointer',
            }}>
            {m.label}
          </button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search templates..."
          style={{ marginLeft: 'auto', padding: '5px 10px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 12 }} />
      </div>

      {/* Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
        {filtered.map(t => (
          <TemplateCard key={t.id} template={t} onUse={() => setDetailId(t.id)} />
        ))}
      </div>

      {/* Detail modal */}
      {detailId && (
        <TemplateDetailModal
          templateId={detailId}
          onClose={() => setDetailId(null)}
          onCreateProject={async (templateId, inputs, dsId) => {
            const project = await api.projects.createProjectFromTemplate({ templateId, inputs, designSystemId: dsId });
            window.location.href = `/projects/${project.id}`;
          }}
        />
      )}
    </div>
  );
}
```

---

## Files summary

| File | Hành động |
|------|----------|
| `components/TemplateCard.tsx` | **TẠO MỚI** |
| `components/TemplateInputForm.tsx` | **TẠO MỚI** |
| `components/TemplateDetailModal.tsx` | **TẠO MỚI** |
| `components/TemplateGallery.tsx` | **TẠO MỚI** |
