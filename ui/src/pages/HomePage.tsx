/**
 * F-39 — HomePage
 * 3 tabs: Recent projects | Templates | Skills
 * + Search + NewProjectDialog
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ProjectCard } from '../components/ProjectCard';
import { TemplateGallery } from '../components/TemplateGallery';
import { SkillGrid } from '../components/SkillGrid';
import { NewProjectDialog } from '../components/NewProjectDialog';
import type { Project, CreateProjectRequest } from '../types';

type HomeTab = 'recent' | 'templates' | 'skills';

export default function HomePage() {
  const [tab, setTab] = useState<HomeTab>('recent');
  const [projects, setProjects] = useState<Project[]>([]);
  const [search, setSearch] = useState('');
  const [showNewProject, setShowNewProject] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.projects.listProjects()
      .then((resp) => setProjects(Array.isArray(resp) ? resp : (resp as any).projects ?? []))
      .catch(() => setProjects([]));
  }, []);

  const filtered = projects.filter(
    (p) => !search || p.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1280, margin: '0 auto', overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text)', margin: 0, flex: 1 }}>
          Open Design
        </h1>
        <input
          id="home-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search projects..."
          style={{
            padding: '7px 12px', borderRadius: 8, border: '1px solid var(--color-border)',
            background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 13, width: 220, outline: 'none',
          }}
        />
        <button
          id="home-new-project"
          onClick={() => setShowNewProject(true)}
          style={{
            padding: '8px 18px', borderRadius: 10, border: 'none',
            background: 'var(--color-accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          + New Project
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 20, borderBottom: '1px solid var(--color-border)' }}>
        {([
          { id: 'recent', label: '🕐 Recent' },
          { id: 'templates', label: '📐 Templates' },
          { id: 'skills', label: '⚡ Skills' },
        ] as const).map((t) => (
          <button
            key={t.id}
            id={`home-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            style={{
              padding: '8px 18px', fontSize: 13, border: 'none', cursor: 'pointer',
              background: 'transparent',
              color: tab === t.id ? 'var(--color-text)' : 'var(--color-text-muted)',
              borderBottom: tab === t.id ? '2px solid var(--color-accent)' : '2px solid transparent',
              fontWeight: tab === t.id ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === 'recent' && (
        filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✦</div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-text)', marginBottom: 8 }}>
              {search ? 'No projects found' : 'Start your first design'}
            </h2>
            {!search && (
              <>
                <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 24 }}>
                  Create from scratch or pick a template
                </p>
                <button
                  onClick={() => setTab('templates')}
                  style={{
                    padding: '10px 24px', borderRadius: 10, border: 'none',
                    background: 'var(--color-accent)', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
                  }}
                >
                  Browse Templates →
                </button>
              </>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
            {filtered.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onOpen={(id) => navigate(`/projects/${id}`)}
              />
            ))}
          </div>
        )
      )}

      {tab === 'templates' && <TemplateGallery />}
      {tab === 'skills' && <SkillGrid />}

      {/* New project dialog */}
      {showNewProject && (
        <NewProjectDialog
          onClose={() => setShowNewProject(false)}
          onCreate={async (req: CreateProjectRequest) => {
            const p = await api.projects.createProject({
              name: req.name,
              designSystemId: req.designSystemId,
              skillId: req.skillId,
              pendingPrompt: req.description,
            });
            navigate(`/projects/${p.id}`);
          }}
        />
      )}
    </div>
  );
}
