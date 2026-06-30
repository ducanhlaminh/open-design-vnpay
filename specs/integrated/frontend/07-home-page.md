# 07 — HomePage

> Trang chủ — hub trung tâm tích hợp Projects + Templates + Skills.

---

## Layout

```
HomePage
├── Header (search bar toàn cục + New Project button)
├── TabBar: Recent | Templates | Skills
│
├── [Recent] ProjectGrid
│   ├── ProjectCard[] (recent projects)
│   └── EmptyState → "Start with a template"
│
├── [Templates] TemplateGallery (component từ spec 04)
│   └── → TemplateDetailModal → create project
│
└── [Skills] SkillGrid
    └── SkillCard[] (kết nối skills, click → new project với skill preset)
```

---

## Component: `<ProjectCard>`

```tsx
export function ProjectCard({ project, onOpen }: Props) {
  return (
    <div onClick={() => onOpen(project.id)} style={{
      borderRadius: 'var(--radius)', border: '1px solid var(--color-border)',
      background: 'var(--color-surface)', cursor: 'pointer',
      transition: 'border-color 0.15s', overflow: 'hidden',
    }}>
      {/* Thumbnail: iframe của file HTML cuối cùng */}
      <div style={{ height: 140, background: 'var(--color-bg)', overflow: 'hidden' }}>
        {project.kind === 'web' && (
          <iframe
            src={`/api/projects/${project.id}/files/index.html/preview`}
            sandbox="allow-scripts"
            loading="lazy"
            style={{ width: '100%', height: 300, transform: 'scale(0.47)', transformOrigin: 'top left', pointerEvents: 'none', border: 'none' }}
          />
        )}
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>{project.name}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
          {new Date(project.updatedAt).toLocaleDateString()}
        </div>
      </div>
    </div>
  );
}
```

---

## Page: `HomePage.tsx`

```tsx
export default function HomePage() {
  const [tab, setTab] = useState<'recent' | 'templates' | 'skills'>('recent');
  const [projects, setProjects] = useState<Project[]>([]);
  const [search, setSearch] = useState('');
  const [showNewProject, setShowNewProject] = useState(false);
  const navigate = useNavigate();

  useEffect(() => { api.projects.listProjects().then(setProjects); }, []);

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1280, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text)', flex: 1 }}>
          Open Design
        </h1>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search projects..."
          style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 13, width: 220 }}
        />
        <button onClick={() => setShowNewProject(true)}
          style={{ padding: '8px 18px', borderRadius: 10, border: 'none', background: 'var(--color-accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          + New Project
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 20, borderBottom: '1px solid var(--color-border)' }}>
        {([
          { id: 'recent', label: 'Recent' },
          { id: 'templates', label: 'Templates' },
          { id: 'skills', label: 'Skills' },
        ] as const).map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{
              padding: '8px 18px', fontSize: 13, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === t.id ? 'var(--color-text)' : 'var(--color-text-muted)',
              borderBottom: tab === t.id ? '2px solid var(--color-accent)' : '2px solid transparent',
              fontWeight: tab === t.id ? 600 : 400,
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === 'recent' && (
        projects.length === 0 ? (
          <EmptyState onBrowseTemplates={() => setTab('templates')} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
            {projects
              .filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()))
              .map(p => (
                <ProjectCard key={p.id} project={p} onOpen={id => navigate(`/projects/${id}`)} />
              ))}
          </div>
        )
      )}

      {tab === 'templates' && (
        <TemplateGallery
          onUseTemplate={t => { /* navigate to create project with template */ }}
        />
      )}

      {tab === 'skills' && <SkillGrid />}

      {/* New project dialog */}
      {showNewProject && (
        <NewProjectDialog
          onClose={() => setShowNewProject(false)}
          onCreate={async (req) => {
            const p = await api.projects.createProject(req);
            navigate(`/projects/${p.id}`);
          }}
        />
      )}
    </div>
  );
}

function EmptyState({ onBrowseTemplates }: { onBrowseTemplates: () => void }) {
  return (
    <div style={{ textAlign: 'center', padding: '80px 0' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>✦</div>
      <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-text)', marginBottom: 8 }}>
        Start your first design
      </h2>
      <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 24 }}>
        Create from scratch or pick a template
      </p>
      <button onClick={onBrowseTemplates}
        style={{ padding: '10px 24px', borderRadius: 10, border: 'none', background: 'var(--color-accent)', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
        Browse Templates →
      </button>
    </div>
  );
}
```

---

## Component: `<NewProjectDialog>`

```tsx
interface NewProjectDialogProps {
  onClose: () => void;
  onCreate: (req: CreateProjectRequest) => Promise<void>;
}

export function NewProjectDialog({ onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProjectKind>('web');
  const [designSystemId, setDesignSystemId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div style={{ /* modal backdrop */ }}>
      <div style={{ /* dialog 440px */ }}>
        <h2>New Project</h2>

        <label>Name</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="My design" />

        <label>Type</label>
        <div>{(['web', 'image', 'video', 'audio'] as ProjectKind[]).map(k => (
          <button key={k} onClick={() => setKind(k)}>{k}</button>
        ))}</div>

        <label>Design System (optional)</label>
        <DesignSystemPicker selectedId={designSystemId} onSelect={setDesignSystemId} />

        <button onClick={async () => {
          setCreating(true);
          await onCreate({ name, kind, designSystemId: designSystemId ?? undefined });
        }} disabled={!name || creating}>
          Create →
        </button>
      </div>
    </div>
  );
}
```

---

## Files summary

| File | Hành động |
|------|----------|
| `pages/HomePage.tsx` | **IMPLEMENT** (hiện là stub) |
| `components/ProjectCard.tsx` | **TẠO MỚI** |
| `components/NewProjectDialog.tsx` | **TẠO MỚI** |
| `components/SkillGrid.tsx` | **TẠO MỚI** (grid of skills) |
| `components/SkillCard.tsx` | **TẠO MỚI** |
