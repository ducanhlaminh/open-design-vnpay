/**
 * F-19 — TemplateCard
 * Card in the template gallery — iframe scaled preview + mode badge + hover CTA.
 */
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
