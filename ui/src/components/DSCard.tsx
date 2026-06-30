/**
 * F-17 — DSCard
 * Card in grid on DesignSystemsPage.
 * Shows mini iframe preview, token strip, source badge, select/view actions.
 */
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
  // Prefer 'app' preview, fallback to first available page
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
