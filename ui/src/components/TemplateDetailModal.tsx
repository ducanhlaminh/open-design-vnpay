/**
 * F-21 — TemplateDetailModal
 * Fullscreen 2-panel modal: left = iframe preview, right = config + CTA.
 * Uses DSPicker (optional), TemplateInputForm, validates required inputs.
 * Escape key closes.
 */
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
      const defaults: Record<string, string> = {};
      t.inputs.forEach((i) => { if (i.default) defaults[i.name] = i.default; });
      setInputs(defaults);
    });
  }, [templateId]);

  useEffect(() => {
    function handler(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCreate = async () => {
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
