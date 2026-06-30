# F-23..F-26 — P1D: Media Components

**Phase**: P1D | **Estimate**: ~12h | **Depends on**: P0 + F-15 (StatusDot, SpinnerIcon)  
**Target dir**: `ui/src/components/`

---

## F-23 — `src/components/PromptTemplateCard.tsx`

**Estimate**: 3h

```tsx
import type { PromptTemplateSummary } from '../types';

const SURFACE_ICON: Record<string, string> = {
  image: '🖼',
  video: '🎬',
};

interface PromptTemplateCardProps {
  template: PromptTemplateSummary;
  isSelected?: boolean;
  onClick: () => void;
}

export function PromptTemplateCard({ template, isSelected, onClick }: PromptTemplateCardProps) {
  return (
    <div
      id={`prompt-template-card-${template.id}`}
      onClick={onClick}
      style={{
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        cursor: 'pointer',
        border: `1px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        background: isSelected ? 'rgba(124,109,250,0.08)' : 'var(--color-surface)',
        transition: 'border-color 0.15s, transform 0.1s',
      }}
      className="prompt-template-card"
    >
      {/* Preview image */}
      <div style={{ height: 140, background: 'var(--color-bg)', overflow: 'hidden', position: 'relative' }}>
        {template.previewImageUrl ? (
          <img
            src={template.previewImageUrl}
            alt={template.title}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', fontSize: 40, opacity: 0.3,
          }}>
            {SURFACE_ICON[template.surface] ?? '🎨'}
          </div>
        )}

        {/* Surface badge */}
        <div style={{
          position: 'absolute', bottom: 6, left: 6,
          fontSize: 10, fontWeight: 600,
          padding: '2px 6px', borderRadius: 4,
          background: 'rgba(0,0,0,0.75)', color: '#fff',
        }}>
          {SURFACE_ICON[template.surface]} {template.surface}
        </div>
      </div>

      {/* Info */}
      <div style={{ padding: '8px 10px' }}>
        <div style={{
          fontSize: 12, fontWeight: 600, color: 'var(--color-text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          marginBottom: 5,
        }}>
          {template.title}
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 10, padding: '1px 5px', borderRadius: 3,
            background: 'rgba(124,109,250,0.15)', color: 'var(--color-accent)',
          }}>
            {template.model}
          </span>
          <span style={{
            fontSize: 10, padding: '1px 5px', borderRadius: 3,
            background: 'var(--color-border)', color: 'var(--color-text-muted)',
          }}>
            {template.aspect}
          </span>
          {template.argumentCount > 0 && (
            <span style={{
              fontSize: 10, padding: '1px 5px', borderRadius: 3,
              background: 'var(--color-border)', color: 'var(--color-text-muted)',
            }}>
              {template.argumentCount} arg{template.argumentCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
```

**CSS trong `index.css`**:
```css
.prompt-template-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 14px rgba(0,0,0,0.25);
}
```

---

## F-24 — `src/components/TemplateArgumentForm.tsx`

**Estimate**: 2h  
**Mục đích**: Form điền `{argument name="..."}` placeholders cho prompt templates

```tsx
interface TemplateArgumentFormProps {
  args: Array<{ name: string; default: string }>;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

export function TemplateArgumentForm({ args, values, onChange }: TemplateArgumentFormProps) {
  if (args.length === 0) return null;

  const set = (key: string, val: string) => onChange({ ...values, [key]: val });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
      }}>
        Arguments
      </div>
      {args.map((arg) => (
        <div key={arg.name}>
          <label style={{
            display: 'block', fontSize: 12,
            color: 'var(--color-text)', marginBottom: 4,
          }}>
            {arg.name}
          </label>
          <input
            type="text"
            value={values[arg.name] ?? ''}
            placeholder={arg.default || `Enter ${arg.name}...`}
            onChange={(e) => set(arg.name, e.target.value)}
            style={{
              width: '100%',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              color: 'var(--color-text)',
              fontSize: 12,
              padding: '6px 10px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          {arg.default && (
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 3 }}>
              Default: {arg.default}
            </div>
          )}
        </div>
      ))}

      {/* Preview filled prompt — utility for user */}
      <details style={{ fontSize: 11, color: 'var(--color-text-muted)', cursor: 'pointer' }}>
        <summary style={{ userSelect: 'none' }}>Preview argument substitution</summary>
        <div style={{
          marginTop: 6, padding: '8px 10px',
          background: 'rgba(0,0,0,0.2)', borderRadius: 6,
          fontSize: 11, lineHeight: 1.5,
          fontFamily: 'monospace',
        }}>
          {args.map((arg) => (
            <div key={arg.name}>
              <span style={{ color: 'var(--color-accent)' }}>{arg.name}</span>
              {' → '}
              {values[arg.name] || arg.default || <em style={{ opacity: 0.5 }}>empty</em>}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
```

---

## F-25 — `src/components/PromptTemplateGallery.tsx`

**Estimate**: 4h

```tsx
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { PromptTemplateCard } from './PromptTemplateCard';
import type { PromptTemplateSummary } from '../types';

interface PromptTemplateGalleryProps {
  surface: 'image' | 'video';
  selectedId?: string;
  onSelect: (template: PromptTemplateSummary) => void;
}

// Extract unique sorted values
function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)].sort() as T[];
}

export function PromptTemplateGallery({ surface, selectedId, onSelect }: PromptTemplateGalleryProps) {
  const [templates, setTemplates] = useState<PromptTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    setCategory('All');
    api.media.listPromptTemplates({ surface })
      .then((resp) => {
        const list = Array.isArray(resp) ? resp : (resp as any).items ?? [];
        setTemplates(list);
      })
      .finally(() => setLoading(false));
  }, [surface]);

  const categories = useMemo(
    () => ['All', ...unique(templates.map((t) => t.category).filter(Boolean))],
    [templates],
  );

  const filtered = useMemo(
    () => templates
      .filter((t) => category === 'All' || t.category === category)
      .filter((t) => !search || t.title.toLowerCase().includes(search.toLowerCase())),
    [templates, category, search],
  );

  return (
    <div>
      {/* Category pills + search */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        {categories.map((c) => (
          <button
            key={c}
            id={`pt-category-${c.toLowerCase().replace(/\s/g, '-')}`}
            onClick={() => setCategory(c)}
            style={{
              padding: '3px 10px', borderRadius: 20, fontSize: 11, cursor: 'pointer',
              border: `1px solid ${category === c ? 'var(--color-accent)' : 'var(--color-border)'}`,
              background: category === c ? 'rgba(124,109,250,0.15)' : 'transparent',
              color: category === c ? 'var(--color-accent)' : 'var(--color-text-muted)',
            }}
          >
            {c}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          style={{
            marginLeft: 'auto', padding: '3px 8px', borderRadius: 8,
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 11,
            outline: 'none',
          }}
        />
      </div>

      {/* Count */}
      {!loading && (
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 8 }}>
          {filtered.length} template{filtered.length !== 1 ? 's' : ''}
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--color-text-muted)', fontSize: 12 }}>
          Loading templates...
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 10,
          maxHeight: 380,
          overflowY: 'auto',
        }}>
          {filtered.map((t) => (
            <PromptTemplateCard
              key={t.id}
              template={t}
              isSelected={t.id === selectedId}
              onClick={() => onSelect(t)}
            />
          ))}
          {filtered.length === 0 && (
            <div style={{
              gridColumn: '1/-1', textAlign: 'center',
              padding: 40, color: 'var(--color-text-muted)', fontSize: 12,
            }}>
              No templates found
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

---

## F-26 — `src/components/MediaTaskCard.tsx`

**Estimate**: 3h  
**Mục đích**: Render một media job — auto-poll khi pending/processing

```tsx
import { useEffect } from 'react';
import { StatusDot } from './shared/StatusDot';
import { SpinnerIcon } from './shared/SpinnerIcon';
import type { MediaJobSummary } from '../types';

interface MediaTaskCardProps {
  task: MediaJobSummary;
  onRefresh: () => void;
}

export function MediaTaskCard({ task, onRefresh }: MediaTaskCardProps) {
  // Auto-poll mỗi 3 giây khi đang chạy
  useEffect(() => {
    if (task.status === 'pending' || task.status === 'processing') {
      const interval = setInterval(onRefresh, 3000);
      return () => clearInterval(interval);
    }
  }, [task.status, onRefresh]);

  const SURFACE_EMOJI: Record<string, string> = {
    image: '🖼',
    video: '🎬',
    audio: '🎵',
  };

  return (
    <div
      id={`media-task-${task.id}`}
      style={{
        padding: 12,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
        background: 'var(--color-surface)',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusDot status={task.status} size={8} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>
          {SURFACE_EMOJI[task.kind] ?? '?'} {task.kind}
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
          {task.model}
        </span>
      </div>

      {/* Template source */}
      {task.templateId && (
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          Template: {task.templateId}
        </div>
      )}

      {/* Result preview */}
      {task.status === 'done' && task.resultUrl && (
        task.kind === 'image' ? (
          <img
            src={task.resultUrl}
            alt="Generated"
            style={{ width: '100%', borderRadius: 8, display: 'block' }}
          />
        ) : task.kind === 'video' ? (
          <video
            src={task.resultUrl}
            controls
            style={{ width: '100%', borderRadius: 8 }}
          />
        ) : (
          <audio src={task.resultUrl} controls style={{ width: '100%' }} />
        )
      )}

      {/* Processing indicator */}
      {(task.status === 'pending' || task.status === 'processing') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
          <SpinnerIcon size={14} />
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {task.status === 'pending' ? 'Queued...' : 'Generating...'}
          </span>
        </div>
      )}

      {/* Error */}
      {task.status === 'failed' && (
        <div style={{ fontSize: 12, color: '#fa5050', lineHeight: 1.4 }}>
          {task.errorMsg ?? 'Generation failed'}
        </div>
      )}

      {/* Footer: Download + duration */}
      {task.status === 'done' && task.resultUrl && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <a
            href={task.resultUrl}
            download
            style={{ fontSize: 11, color: 'var(--color-accent)', textDecoration: 'none' }}
          >
            ↓ Download
          </a>
          {task.durationMs && (
            <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
              {(task.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      )}
    </div>
  );
}
```

---

## Checklist P1D

- [x] F-23: `PromptTemplateCard.tsx` — previewImage fallback emoji, model/aspect/argCount badges, hover lift
- [x] F-24: `TemplateArgumentForm.tsx` — text inputs for each arg, default placeholder, preview details
- [x] F-25: `PromptTemplateGallery.tsx` — category filter pills, search, auto-load by surface, 380px scroll
- [x] F-26: `MediaTaskCard.tsx` — auto-poll 3s, image/video/audio render, download link, durationMs

> **Status**: ✅ DONE — all 4 components implemented, `tsc --noEmit` passes (2026-06-04)
