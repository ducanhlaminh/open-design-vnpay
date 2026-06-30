// Home dropdown that scopes a new conversation to a KGS/SimStudio project.
// Options come from the KGS project list (GET /api/kg/projects). The selection
// is held in the home-project-scope store; `createProject` stamps it onto the
// new project's metadata.kgsProjectId.
import { useEffect } from 'react';
import { useT } from '../i18n';
import {
  loadHomeKgProjects,
  setHomeKgProject,
  useHomeProjectScope,
} from '../state/home-project-scope';

export function KgProjectPicker() {
  const t = useT();
  const { projects, selectedId, loaded } = useHomeProjectScope();

  useEffect(() => {
    void loadHomeKgProjects();
  }, []);

  // Hide entirely when there are no KGS projects to choose from (e.g. the
  // daemon can't reach preview-project) — avoids an empty, confusing control.
  if (loaded && projects.length === 0) return null;

  return (
    <div className="kg-project-picker" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label htmlFor="kg-project-scope" style={{ fontSize: 12, opacity: 0.75 }}>
        {t('home.kgScope.label')}
      </label>
      <select
        id="kg-project-scope"
        value={selectedId}
        onChange={(e) => setHomeKgProject(e.target.value)}
        title={t('home.kgScope.help')}
        style={{ fontSize: 13, padding: '4px 8px', borderRadius: 6 }}
      >
        <option value="">{t('home.kgScope.none')}</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.id})
          </option>
        ))}
      </select>
    </div>
  );
}
