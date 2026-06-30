/**
 * F-37 — NewProjectDialog
 * Modal to create a new project: name, type (4 kinds), DS picker, description.
 * Enter key submits. Reuses DSPicker.
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import { DesignSystemPicker } from './DesignSystemPicker';
import type { CreateProjectRequest, ProjectKind } from '../types';

interface NewProjectDialogProps {
  onClose: () => void;
  onCreate: (req: CreateProjectRequest) => Promise<void>;
}

const PROJECT_KINDS: Array<{ kind: ProjectKind; icon: string; label: string; desc: string }> = [
  { kind: 'web',   icon: '🌐', label: 'Web',   desc: 'HTML/CSS/JS prototype' },
  { kind: 'image', icon: '🖼', label: 'Image',  desc: 'AI image generation' },
  { kind: 'video', icon: '🎬', label: 'Video',  desc: 'AI video generation' },
  { kind: 'audio', icon: '🎵', label: 'Audio',  desc: 'TTS or AI audio' },
];

export function NewProjectDialog({ onClose, onCreate }: NewProjectDialogProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProjectKind>('web');
  const [designSystemId, setDesignSystemId] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!name.trim()) { setError('Project name is required'); return; }
    setCreating(true);
    setError('');
    try {
      await onCreate({
        name: name.trim(),
        kind,
        designSystemId: designSystemId ?? undefined,
        description: description.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      id="new-project-dialog-backdrop"
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.7)',
        zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        id="new-project-dialog"
        style={{
          width: 480, maxWidth: '95vw',
          background: 'var(--color-surface)',
          borderRadius: 16, border: '1px solid var(--color-border)',
          padding: 28,
          animation: 'modalIn 0.18s ease',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text)', margin: 0, flex: 1 }}>
            New Project
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Name */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text)', marginBottom: 6 }}>
            Project name <span style={{ color: '#fa5050' }}>*</span>
          </label>
          <input
            id="new-project-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My design project"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8,
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 14,
              outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Project type */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text)', marginBottom: 8 }}>
            Project type
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {PROJECT_KINDS.map((k) => (
              <button
                key={k.kind}
                id={`new-project-kind-${k.kind}`}
                onClick={() => setKind(k.kind)}
                style={{
                  padding: '10px 6px',
                  borderRadius: 10,
                  border: `1px solid ${kind === k.kind ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  background: kind === k.kind ? 'rgba(124,109,250,0.15)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: 20, marginBottom: 4 }}>{k.icon}</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: kind === k.kind ? 'var(--color-accent)' : 'var(--color-text)' }}>
                  {k.label}
                </div>
                <div style={{ fontSize: 9, color: 'var(--color-text-muted)', marginTop: 2 }}>{k.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Design system */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text)', marginBottom: 6 }}>
            Design System <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>(optional)</span>
          </label>
          <DesignSystemPicker selectedId={designSystemId} onSelect={setDesignSystemId} />
        </div>

        {/* Description */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text)', marginBottom: 6 }}>
            Description <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Briefly describe what you want to build..."
            rows={2}
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8,
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 13,
              outline: 'none', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit',
            }}
          />
        </div>

        {/* Error */}
        {error && (
          <div style={{ fontSize: 12, color: '#fa5050', marginBottom: 12 }}>{error}</div>
        )}

        {/* CTA */}
        <button
          id="new-project-create"
          onClick={handleCreate}
          disabled={!name.trim() || creating}
          style={{
            width: '100%', padding: '11px', borderRadius: 10, border: 'none',
            background: (!name.trim() || creating) ? 'rgba(124,109,250,0.4)' : 'var(--color-accent)',
            color: '#fff', fontSize: 14, fontWeight: 600,
            cursor: (!name.trim() || creating) ? 'not-allowed' : 'pointer',
          }}
        >
          {creating ? 'Creating...' : 'Create Project →'}
        </button>
      </div>
    </div>
  );
}
