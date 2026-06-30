# 03 — Design Systems UI

> Components + Page cho 150+ design systems.  
> Source data: `design-systems/` → `/api/design-systems/*`

---

## Component Tree

```
DesignSystemsPage
├── DSPageHeader (search + import button)
├── DSCategoryFilter (category pills)
├── DSGrid
│   └── DSCard[] (card per DS)
│       └── TokenStrip (4–6 màu từ tokens.css)
└── DSDetailDrawer (slide-in từ phải)
    ├── DSDetailHeader (name + category + source badge)
    ├── DSPreviewTabs
    │   ├── iframe (preview/app.html)
    │   ├── iframe (preview/colors.html)
    │   ├── iframe (preview/typography.html)
    │   └── iframe (preview/spacing.html)
    ├── DSTokensTab (visual token grid)
    ├── DSComponentsTab (iframe components.html)
    └── DSSpecTab (markdown DESIGN.md)

DesignSystemPicker  ← dùng trong ChatToolbar, NewProjectDialog
├── Combobox grouped by category
└── TokenStrip mini (4 màu)
```

---

## Component 1: `<DesignSystemPicker>`

**File**: `ui/src/components/DesignSystemPicker.tsx`

```tsx
interface DesignSystemPickerProps {
  selectedId?: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
  compact?: boolean;   // compact mode cho toolbar
}

export function DesignSystemPicker({ selectedId, onSelect, disabled, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [grouped, setGrouped] = useState<Record<string, DesignSystemSummary[]>>({});

  useEffect(() => {
    api.designSystems.listDesignSystems()
      .then(list => {
        // Group by category
        const g: Record<string, DesignSystemSummary[]> = {};
        list.forEach(ds => {
          if (!g[ds.category]) g[ds.category] = [];
          g[ds.category].push(ds);
        });
        setGrouped(g);
      });
  }, []);

  const selected = /* find in grouped by selectedId */;

  return (
    <div style={{ position: 'relative' }}>
      {/* Trigger button */}
      <button onClick={() => setOpen(o => !o)} disabled={disabled}>
        <Layers size={14} />
        {compact ? null : (selected?.name ?? 'Design System')}
        <TokenStrip tokensUrl={selected ? api.designSystems.getTokensCssUrl(selected.id) : null} mini />
        <ChevronDown size={12} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="ds-picker-dropdown">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." />
          {Object.entries(grouped)
            .filter(([cat, items]) => /* search filter */)
            .map(([category, items]) => (
              <div key={category}>
                <div className="ds-picker-category">{category}</div>
                {items.map(ds => (
                  <button key={ds.id} onClick={() => { onSelect(ds.id); setOpen(false); }}>
                    <TokenStrip tokensUrl={api.designSystems.getTokensCssUrl(ds.id)} mini />
                    {ds.name}
                    {selectedId === ds.id && <CheckIcon size={12} />}
                  </button>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
```

**Styles cần thêm vào `index.css`**:
```css
.ds-picker-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 200;
  width: 280px;
  max-height: 360px;
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
}
.ds-picker-category {
  padding: 6px 12px 2px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}
```

---

## Component 2: `<TokenStrip>`

**File**: `ui/src/components/TokenStrip.tsx`

```tsx
interface TokenStripProps {
  tokensUrl: string | null;
  mini?: boolean;   // 4 swatches 12px vs 6 swatches 18px
}

// Fetch tokens.css, parse --color-* CSS variables, render swatches
export function TokenStrip({ tokensUrl, mini }: TokenStripProps) {
  const [colors, setColors] = useState<string[]>([]);

  useEffect(() => {
    if (!tokensUrl) return;
    fetch(tokensUrl)
      .then(r => r.text())
      .then(css => {
        // Parse: --color-accent: #7C6DFA; → extract hex/hsl values
        const matches = css.matchAll(/--color-(?!text|bg|surface|border)[^:]+:\s*([^;]+)/g);
        const parsed = [...matches].map(m => m[1].trim()).slice(0, mini ? 4 : 6);
        setColors(parsed);
      })
      .catch(() => setColors([]));
  }, [tokensUrl]);

  const size = mini ? 12 : 18;
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {colors.map((c, i) => (
        <div key={i} style={{
          width: size, height: size, borderRadius: 3,
          background: c, border: '1px solid rgba(255,255,255,0.08)'
        }} />
      ))}
    </div>
  );
}
```

---

## Component 3: `<DSCard>`

**File**: `ui/src/components/DSCard.tsx`

```tsx
interface DSCardProps {
  ds: DesignSystemSummary;
  isSelected?: boolean;
  onView: () => void;
  onSelect: () => void;
}

export function DSCard({ ds, isSelected, onView, onSelect }: Props) {
  const previewUrl = ds.previewPages.find(p => p.role === 'app')
    ? api.designSystems.getPreviewPageUrl(ds.id, 'app')
    : api.designSystems.getPreviewPageUrl(ds.id, ds.previewPages[0]?.role ?? 'colors');

  return (
    <div onClick={onView} style={{ cursor: 'pointer', border: `1px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      {/* Mini preview iframe */}
      <div style={{ height: 120, background: 'var(--color-bg)', overflow: 'hidden', position: 'relative' }}>
        {ds.previewPages.length > 0 ? (
          <iframe
            src={previewUrl}
            sandbox="allow-scripts"
            style={{ width: '100%', height: '200%', transform: 'scale(0.5)', transformOrigin: 'top left', pointerEvents: 'none', border: 'none' }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Layers size={32} opacity={0.3} />
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)', flex: 1 }}>{ds.name}</span>
          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(124,109,250,0.15)', color: 'var(--color-accent)' }}>
            {ds.sourceType === 'bundled' ? 'Built-in' : ds.sourceType}
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>{ds.category}</div>
        <TokenStrip tokensUrl={api.designSystems.getTokensCssUrl(ds.id)} />
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '0 12px 12px' }}>
        <button onClick={e => { e.stopPropagation(); onSelect(); }}>
          {isSelected ? '✓ Selected' : 'Select'}
        </button>
        <button onClick={e => { e.stopPropagation(); onView(); }}>View</button>
      </div>
    </div>
  );
}
```

---

## Component 4: `<DSDetailDrawer>`

**File**: `ui/src/components/DSDetailDrawer.tsx`

```tsx
interface DSDetailDrawerProps {
  dsId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  isSelected?: boolean;
}

type Tab = 'preview' | 'tokens' | 'components' | 'spec';

export function DSDetailDrawer({ dsId, onClose, onSelect, isSelected }: Props) {
  const [tab, setTab] = useState<Tab>('preview');
  const [ds, setDs] = useState<DesignSystemSummary | null>(null);
  const [previewRole, setPreviewRole] = useState('app');

  useEffect(() => {
    api.designSystems.getDesignSystem(dsId).then(setDs);
  }, [dsId]);

  return (
    <div style={{ /* slide-in overlay */ }}>
      <div style={{ /* drawer panel 480px */ }}>
        {/* Header */}
        <div>{ds?.name} <button onClick={onClose}>✕</button></div>

        {/* Tab bar */}
        <div>{(['preview', 'tokens', 'components', 'spec'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}>{t}</button>
        ))}</div>

        {/* Preview tab */}
        {tab === 'preview' && (
          <div>
            {/* Role selector */}
            <select value={previewRole} onChange={e => setPreviewRole(e.target.value)}>
              {ds?.previewPages.map(p => (
                <option key={p.role} value={p.role}>{p.title}</option>
              ))}
            </select>
            <iframe
              src={api.designSystems.getPreviewPageUrl(dsId, previewRole)}
              sandbox="allow-scripts allow-same-origin"
              style={{ width: '100%', height: 400, border: 'none' }}
            />
          </div>
        )}

        {/* Tokens tab */}
        {tab === 'tokens' && (
          <iframe
            src={api.designSystems.getTokensCssUrl(dsId)}
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
          // Or: fetch + parse + render visual token grid
        )}

        {/* Components tab */}
        {tab === 'components' && ds?.hasComponents && (
          <iframe
            src={api.designSystems.getComponentsUrl(dsId)}
            sandbox="allow-scripts allow-same-origin"
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
        )}

        {/* Spec tab */}
        {tab === 'spec' && (
          <MarkdownViewer url={api.designSystems.getDesignMdUrl(dsId)} />
        )}

        {/* Footer */}
        <button onClick={() => onSelect(dsId)}>
          {isSelected ? '✓ Using this DS' : 'Use this Design System'}
        </button>
      </div>
    </div>
  );
}
```

---

## Page: `DesignSystemsPage.tsx`

**File**: `ui/src/pages/DesignSystemsPage.tsx`

```tsx
export default function DesignSystemsPage() {
  const [dsList, setDsList] = useState<DesignSystemSummary[]>([]);
  const [category, setCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useGlobalSelectedDS(); // từ Zustand store

  // Categories
  const categories = useMemo(() => ['all', ...unique(dsList.map(d => d.category))], [dsList]);

  // Filtered
  const filtered = dsList
    .filter(d => category === 'all' || d.category === category)
    .filter(d => !search || d.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      {/* Header */}
      <header>
        <h1>Design Systems</h1>
        <input placeholder="Search..." value={search} onChange={...} />
        <button onClick={() => /* open ImportDialog */}>Import</button>
      </header>

      {/* Category pills */}
      <div>{categories.map(cat => (
        <button key={cat} onClick={() => setCategory(cat)}>{cat}</button>
      ))}</div>

      {/* Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
        {filtered.map(ds => (
          <DSCard
            key={ds.id}
            ds={ds}
            isSelected={ds.id === selectedId}
            onView={() => setViewingId(ds.id)}
            onSelect={() => setSelectedId(ds.id)}
          />
        ))}
      </div>

      {/* Detail drawer */}
      {viewingId && (
        <DSDetailDrawer
          dsId={viewingId}
          onClose={() => setViewingId(null)}
          onSelect={id => setSelectedId(id)}
          isSelected={viewingId === selectedId}
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
| `components/DesignSystemPicker.tsx` | **TẠO MỚI** |
| `components/TokenStrip.tsx` | **TẠO MỚI** |
| `components/DSCard.tsx` | **TẠO MỚI** |
| `components/DSDetailDrawer.tsx` | **TẠO MỚI** |
| `components/MarkdownViewer.tsx` | **TẠO MỚI** (simple fetch + render) |
| `pages/DesignSystemsPage.tsx` | **IMPLEMENT** (hiện là stub) |
| `index.css` | **CẬP NHẬT** (thêm .ds-picker-dropdown styles) |
