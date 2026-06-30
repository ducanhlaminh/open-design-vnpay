# F-19..F-22 — P1C: Template Components

**Phase**: P1C | **Estimate**: ~17h | **Depends on**: P0 + F-12 TokenStrip + F-16 DSPicker  
**Target dir**: `ui/src/components/`

---

## F-19 — `src/components/TemplateCard.tsx`

**Estimate**: 4h

```tsx
import { useState } from 'react';
import type { DesignTemplateSummary, TemplateMode } from '../types';

const MODE_ICONS: Record<TemplateMode, string> = {
  prototype: '🖥',
  deck:      '🎞',
  template:  '📄',
  image:     '🖼',
  video:     '🎬',
  audio:     '🎵',
};

interface TemplateCardProps {
  template: DesignTemplateSummary;
  onUse: (t: DesignTemplateSummary) => void;
}

export function TemplateCard({ template, onUse }: TemplateCardProps) {
  const [hovered, setHovered] = useState(false);

  // Scale factor: mobile → 0.46, deck → scale by height, desktop → 0.3
  const isMobile = template.platform === 'mobile';
  const scaleFactor = isMobile ? 0.46 : 0.3;
  const iframeW = isMobile ? 390 : '100%';
  const iframeH = template.mode === 'deck' ? 800 : 600;

  return (
    <div
      id={`template-card-${template.id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onUse(template)}
      style={{
        borderRadius: 'var(--radius)',
        border: `1px solid ${hovered ? 'var(--color-accent)' : 'var(--color-border)'}`,
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        boxShadow: hovered ? '0 4px 20px rgba(124,109,250,0.2)' : 'none',
        background: 'var(--color-surface)',
      }}
    >
      {/* Preview zone */}
      <div style={{ position: 'relative', height: 180, overflow: 'hidden', background: 'var(--color-bg)' }}>
        {template.hasExample ? (
          <iframe
            src={template.exampleUrl}
            sandbox="allow-scripts allow-same-origin"
            loading="lazy"
            style={{
              width: typeof iframeW === 'number' ? iframeW : '100%',
              height: iframeH,
              border: 'none',
              transform: `scale(${scaleFactor})`,
              transformOrigin: 'top left',
              pointerEvents: 'none',
            }}
            title={template.name}
          />
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', fontSize: 48, opacity: 0.4,
          }}>
            {MODE_ICONS[template.mode]}
          </div>
        )}

        {/* Mode badge */}
        <div style={{
          position: 'absolute', top: 8, left: 8,
          fontSize: 10, fontWeight: 600,
          padding: '2px 6px', borderRadius: 4,
          background: 'rgba(0,0,0,0.7)', color: '#fff',
          backdropFilter: 'blur(4px)',
        }}>
          {MODE_ICONS[template.mode]} {template.mode.charAt(0).toUpperCase() + template.mode.slice(1)}
        </div>

        {/* Platform badge */}
        {template.platform && (
          <div style={{
            position: 'absolute', top: 8, right: 8,
            fontSize: 10, padding: '2px 6px', borderRadius: 4,
            background: 'rgba(0,0,0,0.6)', color: '#ccc',
          }}>
            {template.platform}
          </div>
        )}

        {/* Hover CTA overlay */}
        {hovered && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(124,109,250,0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{
              background: 'var(--color-accent)', color: '#fff',
              padding: '7px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600,
            }}>
              Use Template
            </span>
          </div>
        )}
      </div>

      {/* Info section */}
      <div style={{ padding: '10px 12px' }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--color-text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3,
        }}>
          {template.name}
        </div>
        {template.description && (
          <div style={{
            fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
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

## F-20 — `src/components/TemplateInputForm.tsx`

**Estimate**: 3h

```tsx
import type { TemplateInput } from '../types';

interface TemplateInputFormProps {
  inputs: TemplateInput[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

const inputStyle = {
  width: '100%',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  color: 'var(--color-text)',
  fontSize: 13,
  padding: '8px 12px',
  outline: 'none',
  boxSizing: 'border-box' as const,
};

export function TemplateInputForm({ inputs, values, onChange }: TemplateInputFormProps) {
  if (inputs.length === 0) return null;

  const set = (key: string, val: string) => onChange({ ...values, [key]: val });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h4 style={{
        fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0,
      }}>
        Template Inputs
      </h4>

      {inputs.map((input) => (
        <div key={input.name}>
          <label style={{
            display: 'block', fontSize: 12, fontWeight: 500,
            color: 'var(--color-text)', marginBottom: 5,
          }}>
            {input.name}
            {input.required && <span style={{ color: '#fa5050', marginLeft: 3 }}>*</span>}
          </label>

          {input.type === 'text' ? (
            <textarea
              value={values[input.name] ?? input.default ?? ''}
              onChange={(e) => set(input.name, e.target.value)}
              placeholder={input.placeholder ?? input.default ?? `Enter ${input.name}...`}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          ) : input.type === 'select' && input.options ? (
            <select
              value={values[input.name] ?? input.default ?? ''}
              onChange={(e) => set(input.name, e.target.value)}
              style={inputStyle}
            >
              {input.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          ) : input.type === 'boolean' ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={values[input.name] === 'true' || (!values[input.name] && input.default === 'true')}
                onChange={(e) => set(input.name, String(e.target.checked))}
              />
              <span style={{ fontSize: 13, color: 'var(--color-text)' }}>
                {input.placeholder ?? 'Enable'}
              </span>
            </label>
          ) : (
            <input
              type={input.type === 'number' ? 'number' : 'text'}
              value={values[input.name] ?? input.default ?? ''}
              onChange={(e) => set(input.name, e.target.value)}
              placeholder={input.placeholder ?? input.default ?? `Enter ${input.name}...`}
              style={inputStyle}
            />
          )}
        </div>
      ))}
    </div>
  );
}
```

---

## F-21 — `src/components/TemplateDetailModal.tsx`

**Estimate**: 6h — **PHỨC TẠP** (dùng DSPicker, TemplateInputForm, fullscreen modal)

```tsx
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import { DesignSystemPicker } from './DesignSystemPicker';
import { TemplateInputForm } from './TemplateInputForm';
import type { DesignTemplateSummary, TemplateMode } from '../types';

const MODE_ICONS: Record<TemplateMode, string> = {
  prototype: '🖥', deck: '🎞', template: '📄',
  image: '🖼', video: '🎬', audio: '🎵',
};

interface TemplateDetailModalProps {
  templateId: string;
  onClose: () => void;
  onCreateProject: (
    templateId: string,
    inputs: Record<string, string>,
    dsId?: string,
  ) => Promise<void>;
}

export function TemplateDetailModal({ templateId, onClose, onCreateProject }: TemplateDetailModalProps) {
  const [template, setTemplate] = useState<DesignTemplateSummary | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [selectedDsId, setSelectedDsId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.designTemplates.getDesignTemplate(templateId).then((t) => {
      setTemplate(t);
      // Init defaults
      const defaults: Record<string, string> = {};
      t.inputs.forEach((i) => { if (i.default) defaults[i.name] = i.default; });
      setInputs(defaults);
    });
  }, [templateId]);

  // Escape to close
  useEffect(() => {
    function handler(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCreate = async () => {
    // Validate required inputs
    const missing = template?.inputs.filter((i) => i.required && !inputs[i.name]) ?? [];
    if (missing.length > 0) {
      setError(`Required: ${missing.map((i) => i.name).join(', ')}`);
      return;
    }
    setCreating(true);
    setError('');
    try {
      await onCreateProject(templateId, inputs, selectedDsId ?? undefined);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      id="template-detail-modal-backdrop"
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.75)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        width: 900, maxWidth: '95vw', height: '82vh',
        background: 'var(--color-surface)',
        borderRadius: 16, border: '1px solid var(--color-border)',
        display: 'flex', overflow: 'hidden',
        animation: 'modalIn 0.18s ease',
      }}>
        {/* Left — Preview iframe */}
        <div style={{
          flex: 1, background: '#f5f5f7',
          overflow: 'hidden', position: 'relative',
        }}>
          {template?.hasExample ? (
            <iframe
              src={api.designTemplates.getTemplateExampleUrl(templateId)}
              sandbox={template.mode === 'deck'
                ? 'allow-scripts allow-same-origin'
                : 'allow-scripts'}
              style={{ width: '100%', height: '100%', border: 'none' }}
              title={`${template.name} preview`}
            />
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100%', fontSize: 64, opacity: 0.3,
            }}>
              {template ? MODE_ICONS[template.mode] : '⋯'}
            </div>
          )}
        </div>

        {/* Right — Config panel */}
        <div style={{
          width: 340, padding: 24,
          display: 'flex', flexDirection: 'column', gap: 16,
          overflowY: 'auto', flexShrink: 0,
          borderLeft: '1px solid var(--color-border)',
        }}>
          {/* Close button */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 4 }}
            >
              <X size={18} />
            </button>
          </div>

          {/* Header */}
          {template && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--color-accent)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                {MODE_ICONS[template.mode]} {template.mode}
                {template.platform && ` · ${template.platform}`}
              </div>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text)', margin: '0 0 8px' }}>
                {template.name}
              </h2>
              {template.description && (
                <p style={{ fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.55, margin: 0 }}>
                  {template.description}
                </p>
              )}
            </div>
          )}

          {/* Template inputs */}
          {template && (
            <TemplateInputForm
              inputs={template.inputs}
              values={inputs}
              onChange={setInputs}
            />
          )}

          {/* DS picker */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 6 }}>
              Design System <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(optional)</span>
            </label>
            <DesignSystemPicker
              selectedId={selectedDsId}
              onSelect={setSelectedDsId}
            />
          </div>

          {/* Error */}
          {error && (
            <div style={{ fontSize: 12, color: '#fa5050', padding: '8px 10px', background: 'rgba(250,80,80,0.1)', borderRadius: 6 }}>
              {error}
            </div>
          )}

          {/* CTA */}
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              id="template-modal-create"
              onClick={handleCreate}
              disabled={creating || !template}
              style={{
                width: '100%', padding: '11px', borderRadius: 10, border: 'none',
                background: creating ? 'rgba(124,109,250,0.5)' : 'var(--color-accent)',
                color: '#fff', fontSize: 14, fontWeight: 600, cursor: creating ? 'wait' : 'pointer',
              }}
            >
              {creating ? 'Creating project...' : 'Create Project →'}
            </button>
            <button
              onClick={onClose}
              style={{
                width: '100%', padding: '9px', borderRadius: 10,
                border: '1px solid var(--color-border)',
                background: 'transparent', color: 'var(--color-text-muted)',
                fontSize: 13, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**CSS cần thêm vào `index.css`**:
```css
@keyframes modalIn {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}
```

---

## F-22 — `src/components/TemplateGallery.tsx`

**Estimate**: 4h

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useTemplateStore } from '../store/templateStore';
import { api } from '../api';
import { TemplateCard } from './TemplateCard';
import { TemplateDetailModal } from './TemplateDetailModal';
import type { DesignTemplateSummary, TemplateMode } from '../types';

const MODES: Array<{ label: string; value: TemplateMode | 'all' }> = [
  { label: 'All', value: 'all' },
  { label: '🖥 Prototype', value: 'prototype' },
  { label: '🎞 Deck', value: 'deck' },
  { label: '📄 Document', value: 'template' },
  { label: '🖼 Image', value: 'image' },
  { label: '🎬 Video', value: 'video' },
];

interface TemplateGalleryProps {
  onUseTemplate?: (t: DesignTemplateSummary) => void;
}

export function TemplateGallery({ onUseTemplate }: TemplateGalleryProps) {
  const { templates, loaded, fetchTemplates } = useTemplateStore();
  const [mode, setMode] = useState<TemplateMode | 'all'>('all');
  const [search, setSearch] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const filtered = useMemo(
    () => templates
      .filter((t) => mode === 'all' || t.mode === mode)
      .filter((t) => !search || t.name.toLowerCase().includes(search.toLowerCase())),
    [templates, mode, search],
  );

  return (
    <div>
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {MODES.map((m) => (
          <button
            key={m.value}
            id={`template-filter-${m.value}`}
            onClick={() => setMode(m.value)}
            style={{
              padding: '5px 12px', borderRadius: 20, fontSize: 12,
              border: `1px solid ${mode === m.value ? 'var(--color-accent)' : 'var(--color-border)'}`,
              background: mode === m.value ? 'rgba(124,109,250,0.15)' : 'transparent',
              color: mode === m.value ? 'var(--color-accent)' : 'var(--color-text-muted)',
              cursor: 'pointer',
            }}
          >
            {m.label}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search templates..."
          style={{
            marginLeft: 'auto', padding: '5px 12px', borderRadius: 8,
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 12,
            outline: 'none',
          }}
        />
      </div>

      {/* Count */}
      {loaded && (
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 12 }}>
          {filtered.length} template{filtered.length !== 1 ? 's' : ''}
          {search && ` for "${search}"`}
        </div>
      )}

      {/* Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 14,
      }}>
        {filtered.map((t) => (
          <TemplateCard
            key={t.id}
            template={t}
            onUse={() => {
              if (onUseTemplate) onUseTemplate(t);
              else setDetailId(t.id);
            }}
          />
        ))}
      </div>

      {/* Empty state */}
      {loaded && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--color-text-muted)', fontSize: 13 }}>
          No templates found{search ? ` for "${search}"` : ''}
        </div>
      )}

      {/* Detail modal */}
      {detailId && (
        <TemplateDetailModal
          templateId={detailId}
          onClose={() => setDetailId(null)}
          onCreateProject={async (templateId, inputs, dsId) => {
            const project = await api.projects.createProjectFromTemplate({
              templateId,
              inputs,
              designSystemId: dsId,
            });
            window.location.href = `/projects/${project.id}`;
          }}
        />
      )}
    </div>
  );
}
```

---

## Checklist P1C

- [x] F-19: `TemplateCard.tsx` — iframe preview with scale trick, hover overlay, mode badge, platform badge
- [x] F-20: `TemplateInputForm.tsx` — string/text/select/boolean/number input types, required validation
- [x] F-21: `TemplateDetailModal.tsx` — fullscreen modal, DSPicker, required validation, escape-to-close
- [x] F-22: `TemplateGallery.tsx` — 6 mode filters, search, useTemplateStore, empty state

> **Status**: ✅ DONE — all 4 components implemented, `tsc --noEmit` passes (2026-06-04)
