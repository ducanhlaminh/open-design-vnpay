/**
 * F-36 — ProjectCard
 * Card in HomePage recent projects grid.
 * Shows iframe thumbnail (web kind), platform icon, hover-reveal delete button.
 */
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

  const icon = PLATFORM_ICONS[project.kind] ?? '📁';

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
        {project.kind === 'web' ? (
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
          {new Date(project.updatedAt ?? Date.now()).toLocaleDateString('vi-VN', {
            year: 'numeric', month: 'short', day: 'numeric',
          })}
        </div>
      </div>

      {/* Delete button (hover reveal via CSS) */}
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
