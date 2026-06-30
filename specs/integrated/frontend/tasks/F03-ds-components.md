# F-16..F-18 — P1B: Design System Components

**Phase**: P1B | **Estimate**: ~18h | **Depends on**: P0 (stores + api) + F-12 (TokenStrip)  
**Target dir**: `ui/src/components/`

---

## F-16 — `src/components/DesignSystemPicker.tsx`

**Estimate**: 6h  
**Mục đích**: Combobox grouped-by-category để chọn DS — dùng trong ChatToolbar, NewProjectDialog

```tsx
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Layers, Check } from 'lucide-react';
import { api } from '../api';
import { useDesignSystemStore } from '../store/designSystemStore';
import { TokenStrip } from './TokenStrip';
import type { DesignSystemSummary } from '../types';

interface DesignSystemPickerProps {
  selectedId?: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
  compact?: boolean;  // compact=true: chỉ hiện icon + token strip (cho toolbar)
  placeholder?: string;
}

export function DesignSystemPicker({
  selectedId,
  onSelect,
  disabled,
  compact,
  placeholder = 'Design System',
}: DesignSystemPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { catalog, categories, loaded, fetchCatalog } = useDesignSystemStore();

  // Fetch catalog on mount (no-op nếu đã loaded)
  useEffect(() => { fetchCatalog(); }, [fetchCatalog]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selected = catalog.find((ds) => ds.id === selectedId);

  // Group by category, filtered by search
  const grouped: Record<string, DesignSystemSummary[]> = {};
  const q = search.toLowerCase();
  catalog.forEach((ds) => {
    if (q && !ds.name.toLowerCase().includes(q) && !ds.category.toLowerCase().includes(q)) return;
    if (!grouped[ds.category]) grouped[ds.category] = [];
    grouped[ds.category].push(ds);
  });

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      {/* Trigger */}
      <button
        id="ds-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !loaded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: compact ? '4px 8px' : '6px 12px',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
          color: 'var(--color-text)',
          fontSize: 13,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          minWidth: compact ? 'auto' : 160,
        }}
      >
        <Layers size={14} />
        {!compact && (
          <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected?.name ?? placeholder}
          </span>
        )}
        {selected && (
          <TokenStrip tokensUrl={api.designSystems.getTokensCssUrl(selected.id)} mini />
        )}
        <ChevronDown size={12} style={{ flexShrink: 0 }} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="ds-picker-dropdown" id="ds-picker-dropdown">
          {/* Search */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-border)' }}>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search design systems..."
              style={{
                width: '100%',
                padding: '4px 8px',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 4,
                color: 'var(--color-text)',
                fontSize: 12,
                outline: 'none',
              }}
            />
          </div>

          {/* Groups */}
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {categories
              .filter((cat) => grouped[cat]?.length > 0)
              .map((category) => (
                <div key={category}>
                  <div className="ds-picker-category">{category}</div>
                  {grouped[category].map((ds) => (
                    <button
                      key={ds.id}
                      onClick={() => { onSelect(ds.id); setOpen(false); setSearch(''); }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        padding: '6px 12px',
                        background: selectedId === ds.id ? 'rgba(124,109,250,0.12)' : 'transparent',
                        border: 'none',
                        color: 'var(--color-text)',
                        fontSize: 13,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <TokenStrip tokensUrl={api.designSystems.getTokensCssUrl(ds.id)} mini />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ds.name}
                      </span>
                      {selectedId === ds.id && <Check size={12} color="var(--color-accent)" />}
                    </button>
                  ))}
                </div>
              ))}
            {Object.keys(grouped).length === 0 && (
              <div style={{ padding: 16, color: 'var(--color-text-muted)', fontSize: 13, textAlign: 'center' }}>
                No results for "{search}"
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

**CSS trong `index.css`**:
```css
.ds-picker-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 200;
  width: 280px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  animation: fadeSlideDown 0.12s ease;
}
@keyframes fadeSlideDown {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.ds-picker-category {
  padding: 8px 12px 2px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}
```

---

## F-17 — `src/components/DSCard.tsx`

**Estimate**: 4h  
**Mục đích**: Card trong grid trên DesignSystemsPage — mini preview iframe + info + actions

```tsx
import { Layers } from 'lucide-react';
import { api } from '../api';
import { TokenStrip } from './TokenStrip';
import type { DesignSystemSummary } from '../types';

interface DSCardProps {
  ds: DesignSystemSummary;
  isSelected?: boolean;
  onView: () => void;
  onSelect: () => void;
}

export function DSCard({ ds, isSelected, onView, onSelect }: DSCardProps) {
  // Ưu tiên 'app' preview, fallback sang page đầu tiên
  const primaryRole = ds.previewPages.find((p) => p.role === 'app')?.role
    ?? ds.previewPages[0]?.role;
  const previewUrl = primaryRole
    ? api.designSystems.getPreviewPageUrl(ds.id, primaryRole)
    : null;

  const sourceBadge = ds.sourceType === 'bundled' ? 'Built-in'
    : ds.sourceType === 'imported' ? 'Imported'
    : 'Generated';

  return (
    <div
      id={`ds-card-${ds.id}`}
      style={{
        border: `1px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        background: 'var(--color-surface)',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        cursor: 'pointer',
      }}
      className="ds-card"
      onClick={onView}
    >
      {/* Mini preview */}
      <div style={{ height: 120, background: 'var(--color-bg)', overflow: 'hidden', position: 'relative' }}>
        {previewUrl ? (
          <iframe
            src={previewUrl}
            sandbox="allow-scripts"
            style={{
              width: '100%',
              height: '200%',
              transform: 'scale(0.5)',
              transformOrigin: 'top left',
              pointerEvents: 'none',
              border: 'none',
            }}
            title={`${ds.name} preview`}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Layers size={32} opacity={0.2} />
          </div>
        )}
      </div>

      {/* Info section */}
      <div style={{ padding: '10px 12px 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ds.name}
          </span>
          <span style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 4, flexShrink: 0,
            background: ds.sourceType === 'bundled' ? 'rgba(124,109,250,0.15)' : 'rgba(100,200,100,0.15)',
            color: ds.sourceType === 'bundled' ? 'var(--color-accent)' : '#6ac47e',
          }}>
            {sourceBadge}
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 8 }}>
          {ds.category}
        </div>
        <TokenStrip tokensUrl={api.designSystems.getTokensCssUrl(ds.id)} />
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, padding: '8px 12px 12px' }}>
        <button
          id={`ds-select-${ds.id}`}
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
          style={{
            flex: 1, padding: '5px 0', fontSize: 12, borderRadius: 4,
            background: isSelected ? 'var(--color-accent)' : 'transparent',
            border: `1px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
            color: isSelected ? '#fff' : 'var(--color-text)',
            cursor: 'pointer',
          }}
        >
          {isSelected ? '✓ Selected' : 'Select'}
        </button>
        <button
          id={`ds-view-${ds.id}`}
          onClick={(e) => { e.stopPropagation(); onView(); }}
          style={{
            flex: 1, padding: '5px 0', fontSize: 12, borderRadius: 4,
            background: 'transparent',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
            cursor: 'pointer',
          }}
        >
          View
        </button>
      </div>
    </div>
  );
}
```

**CSS trong `index.css`**:
```css
.ds-card:hover {
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  border-color: var(--color-border) !important;
}
```

---

## F-18 — `src/components/DSDetailDrawer.tsx`

**Estimate**: 8h — **PHỨC TẠP NHẤT trong P1B**  
**Mục đích**: Slide-in drawer 480px từ phải — 4 tabs: Preview, Tokens, Components, Spec

### Structure

```
DSDetailDrawer
├── Overlay (click to close)
├── Panel (480px, slide-in animation)
│   ├── Header (name + category badge + close button)
│   ├── TabBar (preview | tokens | components | spec)
│   │
│   ├── [preview tab]
│   │   ├── Role selector (dropdown từ ds.previewPages)
│   │   └── iframe (src = getPreviewPageUrl(id, role))
│   │
│   ├── [tokens tab]
│   │   └── iframe (src = getTokensCssUrl(id))
│   │
│   ├── [components tab]
│   │   └── iframe (src = getComponentsUrl(id)) hoặc "No components"
│   │
│   └── [spec tab]
│       └── MarkdownViewer (url = getDesignMdUrl(id))
│
└── Footer (Use this DS button)
```

```tsx
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import { MarkdownViewer } from './MarkdownViewer';
import type { DesignSystemSummary } from '../types';

interface DSDetailDrawerProps {
  dsId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  isSelected?: boolean;
}

type Tab = 'preview' | 'tokens' | 'components' | 'spec';
const TABS: Tab[] = ['preview', 'tokens', 'components', 'spec'];

export function DSDetailDrawer({ dsId, onClose, onSelect, isSelected }: DSDetailDrawerProps) {
  const [tab, setTab] = useState<Tab>('preview');
  const [ds, setDs] = useState<DesignSystemSummary | null>(null);
  const [previewRole, setPreviewRole] = useState('app');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.designSystems.getDesignSystem(dsId)
      .then((data) => {
        setDs(data);
        // Auto-select first available preview role
        const firstRole = data.previewPages[0]?.role ?? 'app';
        setPreviewRole(firstRole);
      })
      .finally(() => setLoading(false));
  }, [dsId]);

  // Keyboard: Escape to close
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.5)',
          zIndex: 300,
        }}
      />

      {/* Drawer panel */}
      <div
        className="drawer"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 480, maxWidth: '90vw',
          background: 'var(--color-surface)',
          borderLeft: '1px solid var(--color-border)',
          zIndex: 301,
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text)' }}>
              {loading ? 'Loading...' : ds?.name}
            </div>
            {ds && (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                {ds.category} · {ds.sourceType}
              </div>
            )}
          </div>
          <button
            id="ds-drawer-close"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)', padding: '0 20px' }}>
          {TABS.map((t) => (
            <button
              key={t}
              id={`ds-drawer-tab-${t}`}
              onClick={() => setTab(t)}
              style={{
                padding: '10px 14px',
                fontSize: 13,
                background: 'none',
                border: 'none',
                borderBottom: `2px solid ${tab === t ? 'var(--color-accent)' : 'transparent'}`,
                color: tab === t ? 'var(--color-accent)' : 'var(--color-text-muted)',
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {tab === 'preview' && ds && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {ds.previewPages.length > 1 && (
                <div style={{ padding: '8px 20px', borderBottom: '1px solid var(--color-border)' }}>
                  <select
                    value={previewRole}
                    onChange={(e) => setPreviewRole(e.target.value)}
                    style={{ fontSize: 12, padding: '3px 8px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 4, color: 'var(--color-text)' }}
                  >
                    {ds.previewPages.map((p) => (
                      <option key={p.role} value={p.role}>{p.title}</option>
                    ))}
                  </select>
                </div>
              )}
              <iframe
                src={api.designSystems.getPreviewPageUrl(dsId, previewRole)}
                sandbox="allow-scripts allow-same-origin"
                style={{ flex: 1, border: 'none', width: '100%' }}
                title="Design system preview"
              />
            </div>
          )}

          {tab === 'tokens' && (
            <iframe
              src={api.designSystems.getTokensCssUrl(dsId)}
              style={{ flex: 1, border: 'none', width: '100%', fontFamily: 'monospace', fontSize: 12 }}
              title="Design system tokens"
            />
          )}

          {tab === 'components' && (
            ds?.hasComponents ? (
              <iframe
                src={api.designSystems.getComponentsUrl(dsId)}
                sandbox="allow-scripts allow-same-origin"
                style={{ flex: 1, border: 'none', width: '100%' }}
                title="Design system components"
              />
            ) : (
              <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13, textAlign: 'center' }}>
                No component library for this design system.
              </div>
            )
          )}

          {tab === 'spec' && (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <MarkdownViewer url={api.designSystems.getDesignMdUrl(dsId)} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: 16, borderTop: '1px solid var(--color-border)' }}>
          <button
            id={`ds-drawer-select-${dsId}`}
            onClick={() => onSelect(dsId)}
            style={{
              width: '100%', padding: '10px', fontSize: 14, fontWeight: 600,
              background: isSelected ? 'rgba(124,109,250,0.2)' : 'var(--color-accent)',
              border: `1px solid ${isSelected ? 'var(--color-accent)' : 'transparent'}`,
              borderRadius: 'var(--radius)',
              color: isSelected ? 'var(--color-accent)' : '#fff',
              cursor: 'pointer',
            }}
          >
            {isSelected ? '✓ Using this Design System' : 'Use this Design System'}
          </button>
        </div>
      </div>
    </>
  );
}
```

**CSS trong `index.css`**:
```css
.drawer {
  animation: slideInRight 0.2s ease;
}
@keyframes slideInRight {
  from { transform: translateX(40px); opacity: 0; }
  to   { transform: translateX(0);    opacity: 1; }
}
```

---

## Checklist P1B

- [x] F-16: `DesignSystemPicker.tsx` — grouped dropdown, search, close-on-outside-click, compact mode
- [x] F-17: `DSCard.tsx` — mini iframe preview, TokenStrip, source badge, select/view actions
- [x] F-18: `DSDetailDrawer.tsx` — 4 tabs, role selector, MarkdownViewer, keyboard escape, footer CTA
