/**
 * F-22 — TemplateGallery
 * 6-mode filter pills + search + TemplateCard grid. Opens TemplateDetailModal on click.
 */
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
