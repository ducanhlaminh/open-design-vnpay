// Read-only badge shown in the project workspace header to indicate which
// KGS/SimStudio project this conversation/project is scoped to
// (metadata.kgsProjectId). Self-contained: loads + subscribes to the
// home-project-scope store so it resolves the project's display name.
import { useEffect } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';
import {
  kgProjectName,
  loadHomeKgProjects,
  useHomeProjectScope,
} from '../state/home-project-scope';

export function KgProjectChip({ kgProjectId }: { kgProjectId: string }) {
  const t = useT();
  // Subscribe so the label re-resolves to a name once the KGS list loads.
  useHomeProjectScope();
  useEffect(() => {
    void loadHomeKgProjects();
  }, []);

  if (!kgProjectId) return null;
  const name = kgProjectName(kgProjectId);
  return (
    <span
      className="project-kg-chip"
      data-testid="project-kg-chip"
      title={t('project.kgScopeTitle', { name })}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        border: '1px solid var(--border, #2a2a2a)',
        opacity: 0.85,
      }}
    >
      <Icon name="folder" size={11} />
      <span>{name === kgProjectId ? kgProjectId : `${name} (${kgProjectId})`}</span>
    </span>
  );
}
