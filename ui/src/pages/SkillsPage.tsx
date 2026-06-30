/**
 * F-43 — SkillsPage
 * SkillGrid with onCreate navigation (creates a new project pre-loaded with that skill).
 */
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { SkillGrid } from '../components/SkillGrid';

export default function SkillsPage() {
  const navigate = useNavigate();

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', margin: '0 0 6px' }}>Skills</h1>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0 }}>
          Skills guide the AI assistant in generating specific types of designs.
        </p>
      </div>
      <SkillGrid
        onSelectSkill={async (skill) => {
          try {
            const project = await api.projects.createProject({
              name: `${skill.name} Project`,
              skillId: skill.id,
            });
            navigate(`/projects/${project.id}`);
          } catch {
            navigate('/');
          }
        }}
      />
    </div>
  );
}
