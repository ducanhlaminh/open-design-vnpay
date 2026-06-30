/**
 * F-23 — PromptTemplateCard
 * Card for AI media prompt templates (image/video).
 * Preview image with surface badge, model/aspect/argCount tags, hover lift.
 */
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
