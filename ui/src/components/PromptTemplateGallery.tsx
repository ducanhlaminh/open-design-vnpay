/**
 * F-25 — PromptTemplateGallery
 * Shows all AI media prompt templates for a given surface (image/video).
 * Category pills + search + auto-refresh on mount.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { PromptTemplateCard } from './PromptTemplateCard';
import type { PromptTemplateSummary } from '../types';

interface PromptTemplateGalleryProps {
  surface: 'image' | 'video';
  selectedId?: string;
  onSelect: (template: PromptTemplateSummary) => void;
}

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
