# F-36..F-38 — P1F: Home + Project Dialog Components

**Phase**: P1F | **Estimate**: ~11h | **Depends on**: P0 + P1B (DSPicker) + P1C (TemplateGallery)  
**Target dir**: `ui/src/components/`

---

## F-36 — `src/components/ProjectCard.tsx`

**Estimate**: 3h

```tsx
import type { Project } from '../types';

interface ProjectCardProps {
  project: Project;
  onOpen: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function ProjectCard({ project, onOpen, onDelete }: ProjectCardProps) {
  const PLATFORM_ICONS: Record<string, string> = {
    web: '🌐',
    mobile: '📱',
    desktop: '🖥',
    image: '🖼',
    video: '🎬',
    audio: '🎵',
  };

  const icon = PLATFORM_ICONS[(project as any).kind ?? 'web'] ?? '📁';

  return (
    <div
      id={`project-card-${project.id}`}
      onClick={() => onOpen(project.id)}
      style={{
        borderRadius: 'var(--radius)',
        border: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
        cursor: 'pointer',
        overflow: 'hidden',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
      className="project-card"
    >
      {/* Thumbnail */}
      <div style={{
        height: 140, background: 'var(--color-bg)',
        overflow: 'hidden', position: 'relative',
      }}>
        {(project as any).kind === 'web' ? (
          <iframe
            src={`/api/projects/${project.id}/files/index.html/preview`}
            sandbox="allow-scripts"
            loading="lazy"
            style={{
              width: '100%', height: 300,
              transform: 'scale(0.47)', transformOrigin: 'top left',
              pointerEvents: 'none', border: 'none',
            }}
            title={project.name}
          />
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', fontSize: 40, opacity: 0.25,
          }}>
            {icon}
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '10px 12px' }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--color-text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          marginBottom: 3,
        }}>
          {icon} {project.name}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {new Date((project as any).updatedAt ?? Date.now()).toLocaleDateString('vi-VN', {
            year: 'numeric', month: 'short', day: 'numeric',
          })}
        </div>
      </div>

      {/* Optional delete button (hover reveal) */}
      {onDelete && (
        <div
          className="project-card-actions"
          style={{
            padding: '0 12px 10px',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button
            id={`project-delete-${project.id}`}
            onClick={(e) => { e.stopPropagation(); onDelete(project.id); }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 11, color: 'var(--color-text-muted)',
              padding: '2px 6px', borderRadius: 4,
            }}
          >
            🗑 Delete
          </button>
        </div>
      )}
    </div>
  );
}
```

**CSS**:
```css
.project-card:hover {
  border-color: var(--color-accent) !important;
  box-shadow: 0 4px 16px rgba(0,0,0,0.25);
}
.project-card-actions {
  opacity: 0;
  transition: opacity 0.15s;
}
.project-card:hover .project-card-actions {
  opacity: 1;
}
```

---

## F-37 — `src/components/NewProjectDialog.tsx`

**Estimate**: 5h

```tsx
import { useState } from 'react';
import { X } from 'lucide-react';
import { DesignSystemPicker } from './DesignSystemPicker';
import type { CreateProjectRequest, ProjectKind } from '../types';

interface NewProjectDialogProps {
  onClose: () => void;
  onCreate: (req: CreateProjectRequest) => Promise<void>;
}

const PROJECT_KINDS: Array<{ kind: ProjectKind; icon: string; label: string; desc: string }> = [
  { kind: 'web',    icon: '🌐', label: 'Web',   desc: 'HTML/CSS/JS prototype' },
  { kind: 'image',  icon: '🖼', label: 'Image',  desc: 'AI image generation' },
  { kind: 'video',  icon: '🎬', label: 'Video',  desc: 'AI video generation' },
  { kind: 'audio',  icon: '🎵', label: 'Audio',  desc: 'TTS or AI audio' },
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
      } as CreateProjectRequest);
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
```

---

## F-38 — `src/components/SkillGrid.tsx` (+ SkillCard)

**Estimate**: 3h

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SkillSummary } from '../types';

// SkillCard (inline hoặc tách file riêng)
function SkillCard({ skill, onClick }: { skill: SkillSummary; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      id={`skill-card-${skill.id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        padding: 16,
        borderRadius: 'var(--radius)',
        border: `1px solid ${hovered ? 'var(--color-accent)' : 'var(--color-border)'}`,
        background: 'var(--color-surface)',
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        boxShadow: hovered ? '0 4px 14px rgba(124,109,250,0.15)' : 'none',
      }}
    >
      <div style={{ fontSize: 24, marginBottom: 8 }}>⚡</div>
      <div style={{
        fontSize: 13, fontWeight: 600, color: 'var(--color-text)',
        marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {skill.name}
      </div>
      {skill.description && (
        <div style={{
          fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4,
          display: '-webkit-box', WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {skill.description}
        </div>
      )}
      {hovered && (
        <div style={{
          marginTop: 10, padding: '4px 0',
          fontSize: 11, color: 'var(--color-accent)', fontWeight: 500,
        }}>
          Use this skill →
        </div>
      )}
    </div>
  );
}

// SkillGrid
interface SkillGridProps {
  onSelectSkill?: (skill: SkillSummary) => void;
}

export function SkillGrid({ onSelectSkill }: SkillGridProps) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.skills.listSkills()
      .then((resp) => {
        const list = Array.isArray(resp) ? resp : (resp as any).items ?? [];
        setSkills(list);
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = skills.filter(
    (s) => !search || s.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div>
      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills..."
          style={{
            padding: '7px 12px', borderRadius: 8,
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 13,
            outline: 'none', width: 240,
          }}
        />
        {!loading && (
          <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--color-text-muted)' }}>
            {filtered.length} skill{filtered.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 13, padding: 24, textAlign: 'center' }}>
          Loading skills...
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 12,
        }}>
          {filtered.map((s) => (
            <SkillCard
              key={s.id}
              skill={s}
              onClick={() => onSelectSkill?.(s)}
            />
          ))}
          {filtered.length === 0 && (
            <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: 48, color: 'var(--color-text-muted)', fontSize: 13 }}>
              No skills found
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

---

## Checklist P1F

- [x] F-36: `ProjectCard.tsx` — iframe thumbnail (web), platform icon, hover delete button
- [x] F-37: `NewProjectDialog.tsx` — 4 project types grid, DSPicker, description, Enter-to-create
- [x] F-38: `SkillGrid.tsx` + `SkillCard` — search, hover effects, 2-line description truncation

> **Status**: ✅ DONE — all 3 components implemented, `tsc --noEmit` passes (2026-06-04)
