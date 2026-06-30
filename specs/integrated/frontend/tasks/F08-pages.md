# F-39..F-46 — P2: Pages

**Phase**: P2 | **Estimate**: ~56h | **Depends on**: TẤT CẢ P0 + P1 components  
**Target dir**: `ui/src/pages/`

> **Lưu ý**: Tất cả pages hiện tại đã tồn tại dưới dạng stub. Nhiệm vụ là **IMPLEMENT** đầy đủ.

---

## F-39 — `src/pages/HomePage.tsx`

**Estimate**: 6h | **Refs**: spec 07-home-page.md

### Cấu trúc
```
HomePage
├── Header (search + New Project button)
├── TabBar (Recent | Templates | Skills)
├── [recent] ProjectGrid hoặc EmptyState
├── [templates] TemplateGallery
├── [skills] SkillGrid
└── NewProjectDialog (modal)
```

### Implementation

```tsx
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
          onCreate={async (req) => {
            const p = await api.projects.createProject(req as any);
            navigate(`/projects/${p.id}`);
          }}
        />
      )}
    </div>
  );
}
```

---

## F-40 — `src/pages/ProjectPage.tsx`

**Estimate**: 10h — **PHỨC TẠP NHẤT** | **Refs**: spec 06-project-page-chat.md

### Cấu trúc
```
ProjectPage (2-col layout)
├── Left (1/3): ChatPanel
│   ├── ChatToolbar
│   ├── ChatHistory (scrollable)
│   │   ├── UserMessage bubbles
│   │   └── AssistantTurn[] (streaming)
│   └── ChatInput (sticky bottom)
└── Right (2/3): WorkspacePanel
    ├── [preview] ArtifactViewer
    ├── [files] FileWorkspace
    └── [transcript] TranscriptView
```

### Implementation outline

```tsx
import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { ChatToolbar } from '../components/ChatToolbar';
import { ChatInput } from '../components/ChatInput';
import { AssistantTurn } from '../components/AssistantTurn';
import { WorkspacePanel } from '../components/WorkspacePanel';
import { useProjectPageStore } from '../store/projectPageStore';
import { useAppStore } from '../store/appStore';
import { api } from '../api';

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const chatEndRef = useRef<HTMLDivElement>(null);
  const store = useProjectPageStore();
  const { selectedDesignSystemId, selectedSkillId } = useAppStore();

  useEffect(() => {
    if (projectId) store.initProject(projectId);
  }, [projectId]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [store.turns.length]);

  const handleSend = async (message: string) => {
    if (!projectId) return;
    store.addUserTurn(message);
    const turnId = store.startAssistantTurn();

    try {
      await api.runs.sendMessage(
        {
          projectId,
          message,
          designSystemId: selectedDesignSystemId ?? undefined,
          skillId: selectedSkillId ?? undefined,
        },
        {
          onDelta: (e) => store.appendDelta(turnId, e.text),
          onToolUse: (e) => store.addToolUse(turnId, { id: crypto.randomUUID(), ...e }),
          onTodo: (e) => store.setTodos(turnId, e.items),
          onArtifact: (e) => store.setArtifact(turnId, e),
          onQuestionForm: (e) => store.showQuestionForm(turnId, e),
          onDirectionPicker: (e) => store.showDirectionPicker(turnId, e),
          onEnd: () => store.finishTurn(turnId),
          onError: (e) => store.setError(e.error),
        },
      );
    } catch (err) {
      store.setError(String(err));
    }
  };

  const isStreaming = store.phase === 'streaming';

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: Chat panel (1/3) */}
      <div style={{
        width: '35%', minWidth: 320, maxWidth: 480,
        display: 'flex', flexDirection: 'column',
        borderRight: '1px solid var(--color-border)',
        overflow: 'hidden',
      }}>
        <ChatToolbar projectId={projectId ?? ''} />

        {/* Chat history */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {store.turns.map((turn) => (
            turn.role === 'user' ? (
              <div key={turn.id} style={{
                marginBottom: 12, display: 'flex', justifyContent: 'flex-end',
              }}>
                <div style={{
                  maxWidth: '80%', padding: '8px 12px',
                  background: 'var(--color-accent)', borderRadius: '10px 10px 2px 10px',
                  color: '#fff', fontSize: 13,
                }}>
                  {turn.text}
                </div>
              </div>
            ) : (
              <div key={turn.id} style={{ marginBottom: 12 }}>
                <AssistantTurn
                  turn={turn}
                  onAnswerQuestion={(answers) => {
                    // TODO: submit question answers via SSE
                  }}
                  onSelectDirection={(id) => {
                    // TODO: submit direction selection
                  }}
                />
              </div>
            )
          ))}
          {store.phase === 'error' && (
            <div style={{ color: '#fa5050', fontSize: 12, padding: '8px 0' }}>
              Error: {store.error}
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <ChatInput
          onSend={handleSend}
          disabled={isStreaming}
          isStreaming={isStreaming}
          onStop={store.reset}
        />
      </div>

      {/* Right: Workspace panel (2/3) */}
      <WorkspacePanel
        artifact={store.activeArtifact}
        projectId={projectId ?? ''}
      />
    </div>
  );
}
```

---

## F-41 — `src/pages/DesignSystemsPage.tsx`

**Estimate**: 6h | **Refs**: spec 03-design-systems-ui.md

```tsx
import { useState } from 'react';
import { useDesignSystemStore } from '../store/designSystemStore';
import { useAppStore } from '../store/appStore';
import { DSCard } from '../components/DSCard';
import { DSDetailDrawer } from '../components/DSDetailDrawer';
import { ImportDialog } from '../components/ImportDialog';
import { useEffect } from 'react';

export default function DesignSystemsPage() {
  const { catalog, categories, loading, fetchCatalog } = useDesignSystemStore();
  const { selectedDesignSystemId, setSelectedDS } = useAppStore();
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  useEffect(() => { fetchCatalog(); }, [fetchCatalog]);

  const filtered = catalog
    .filter((ds) => category === 'all' || ds.category === category)
    .filter((ds) => !search || ds.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', margin: 0, flex: 1 }}>
          Design Systems <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--color-text-muted)' }}>({catalog.length})</span>
        </h1>
        <input
          id="ds-page-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 13, width: 200, outline: 'none' }}
        />
        <button
          id="ds-page-import"
          onClick={() => setShowImport(true)}
          style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text)', fontSize: 12, cursor: 'pointer' }}
        >
          ↓ Import
        </button>
      </div>

      {/* Category pills */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        <button
          onClick={() => setCategory('all')}
          style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: `1px solid ${category === 'all' ? 'var(--color-accent)' : 'var(--color-border)'}`, background: category === 'all' ? 'rgba(124,109,250,0.15)' : 'transparent', color: category === 'all' ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
        >
          All ({catalog.length})
        </button>
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: `1px solid ${category === cat ? 'var(--color-accent)' : 'var(--color-border)'}`, background: category === cat ? 'rgba(124,109,250,0.15)' : 'transparent', color: category === cat ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--color-text-muted)' }}>Loading design systems...</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {filtered.map((ds) => (
            <DSCard
              key={ds.id}
              ds={ds}
              isSelected={ds.id === selectedDesignSystemId}
              onView={() => setViewingId(ds.id)}
              onSelect={() => setSelectedDS(ds.id)}
            />
          ))}
        </div>
      )}

      {/* Detail drawer */}
      {viewingId && (
        <DSDetailDrawer
          dsId={viewingId}
          onClose={() => setViewingId(null)}
          onSelect={(id) => { setSelectedDS(id); setViewingId(null); }}
          isSelected={viewingId === selectedDesignSystemId}
        />
      )}
    </div>
  );
}
```

---

## F-42 — `src/pages/MediaPage.tsx`

**Estimate**: 8h | **Refs**: spec 05-prompt-templates-media-ui.md

> Full implementation đã có trong spec 05. Implement trực tiếp từ spec đó.

Key implementation points:
- Surface tabs: Image | Video | Audio
- Mode switch: Direct | Template | Hyperframes (video only)
- `PromptTemplateGallery` cho mode=template
- `TemplateArgumentForm` khi template được chọn
- `MediaTaskCard[]` phải hiển thị results grid
- Auto-refresh 3s khi có pending/processing tasks

---

## F-43 — `src/pages/SkillsPage.tsx`

**Estimate**: 4h

```tsx
import { SkillGrid } from '../components/SkillGrid';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

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
          // Create a new project with this skill
          try {
            const project = await api.projects.createProject({
              name: `${skill.name} Project`,
              kind: 'web',
            } as any);
            navigate(`/projects/${project.id}`);
          } catch {
            // fallback: navigate to home with skill pre-selected
            navigate('/');
          }
        }}
      />
    </div>
  );
}
```

---

## F-44 — `src/pages/RoutinesPage.tsx`

**Estimate**: 6h

```tsx
// Routines = scheduled/automated AI tasks
// Giữ cấu trúc stub hiện tại + implement list + create routine

import { useEffect, useState } from 'react';
import { api } from '../api';

interface Routine {
  id: string;
  name: string;
  schedule: string;
  lastRun?: string;
  enabled: boolean;
}

export default function RoutinesPage() {
  const [routines, setRoutines] = useState<Routine[]>([]);

  useEffect(() => {
    (api as any).routines?.listRoutines()
      .then(setRoutines)
      .catch(() => setRoutines([]));
  }, []);

  return (
    <div style={{ padding: '24px 32px' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', marginBottom: 20 }}>Routines</h1>
      {routines.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 80, color: 'var(--color-text-muted)', fontSize: 13 }}>
          No routines yet. Routines allow you to schedule automated design tasks.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {routines.map((r) => (
            <div key={r.id} style={{ padding: '12px 16px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', background: 'var(--color-surface)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: 14, color: r.enabled ? 'var(--color-text)' : 'var(--color-text-muted)', flex: 1, fontWeight: 500 }}>{r.name}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.schedule}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## F-45 — `src/pages/SettingsPage.tsx`

**Estimate**: 12h — **CÓ 9 TABS**  
**Tabs**: General | Appearance | API Keys | Agents | Connectors | Memory | MCP | Plugins | About

```tsx
// Implement 9 tabs — mỗi tab là một sub-component
// Tab routing: /settings?tab=general (hoặc URL hash)

type SettingsTab = 'general' | 'appearance' | 'api-keys' | 'agents' | 'connectors' | 'memory' | 'mcp' | 'plugins' | 'about';

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: string }> = [
  { id: 'general',    label: 'General',    icon: '⚙️' },
  { id: 'appearance', label: 'Appearance', icon: '🎨' },
  { id: 'api-keys',   label: 'API Keys',   icon: '🔑' },
  { id: 'agents',     label: 'Agents',     icon: '🤖' },
  { id: 'connectors', label: 'Connectors', icon: '🔌' },
  { id: 'memory',     label: 'Memory',     icon: '🧠' },
  { id: 'mcp',        label: 'MCP',        icon: '🔗' },
  { id: 'plugins',    label: 'Plugins',    icon: '🧩' },
  { id: 'about',      label: 'About',      icon: 'ℹ️' },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('general');
  // ... implement each tab
}
```

> **Implementation strategy**: Mỗi tab là một component riêng trong `src/pages/settings/` hoặc `src/components/settings/`. Không cần implement toàn bộ ngay — ưu tiên: General → API Keys → Appearance.

---

## F-46 — `src/pages/OnboardingPage.tsx`

**Estimate**: 4h

```tsx
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/appStore';
import { DesignSystemPicker } from '../components/DesignSystemPicker';
import { useState } from 'react';

const STEPS = ['welcome', 'ds-select', 'api-key', 'done'] as const;
type OnboardingStep = typeof STEPS[number];

export default function OnboardingPage() {
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const { setSelectedDS, completeOnboarding } = useAppStore();
  const navigate = useNavigate();

  const handleDone = () => {
    completeOnboarding();
    navigate('/');
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', background: 'var(--color-bg)',
    }}>
      <div style={{ width: 480, padding: 40, textAlign: 'center' }}>
        {/* Step progress */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 32 }}>
          {STEPS.map((s, i) => (
            <div key={s} style={{
              width: 8, height: 8, borderRadius: '50%',
              background: i <= STEPS.indexOf(step) ? 'var(--color-accent)' : 'var(--color-border)',
            }} />
          ))}
        </div>

        {step === 'welcome' && (
          <>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✦</div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-text)', marginBottom: 8 }}>
              Welcome to Open Design
            </h1>
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 28 }}>
              Your AI-powered design platform. Let's get you set up in a few steps.
            </p>
            <button onClick={() => setStep('ds-select')} style={{ padding: '11px 32px', borderRadius: 10, border: 'none', background: 'var(--color-accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              Get Started →
            </button>
          </>
        )}

        {step === 'ds-select' && (
          <>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', marginBottom: 8 }}>Choose a Design System</h2>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20 }}>Pick a design system to guide the AI's visual style.</p>
            <DesignSystemPicker onSelect={(id) => { setSelectedDS(id); setStep('api-key'); }} />
            <button onClick={() => setStep('api-key')} style={{ marginTop: 12, fontSize: 12, color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>Skip</button>
          </>
        )}

        {step === 'api-key' && (
          <>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', marginBottom: 8 }}>Configure API Keys</h2>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20 }}>Add your AI provider API keys to enable generation features.</p>
            <button onClick={() => navigate('/settings?tab=api-keys')} style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text)', fontSize: 13, cursor: 'pointer', marginBottom: 12 }}>
              Open Settings →
            </button>
            <button onClick={() => setStep('done')} style={{ display: 'block', fontSize: 12, color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer', margin: '0 auto' }}>Skip for now</button>
          </>
        )}

        {step === 'done' && (
          <>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', marginBottom: 8 }}>You're all set!</h2>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 28 }}>Start creating your first design project.</p>
            <button onClick={handleDone} style={{ padding: '11px 32px', borderRadius: 10, border: 'none', background: 'var(--color-accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              Start Designing →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

---

## Sprint Plan

| Week | Days | Tasks |
|------|------|-------|
| Week 1 | Mon–Tue | F-01..F-11 (P0 Foundation) |
| Week 1 | Wed | F-12..F-15 (P1A Primitives) |
| Week 1 | Thu–Fri | F-16..F-18 (P1B DS Components) |
| Week 2 | Mon–Tue | F-19..F-22 (P1C Templates) |
| Week 2 | Wed | F-23..F-26 (P1D Media) |
| Week 2 | Thu–Fri | F-27..F-35 (P1E Chat) |
| Week 3 | Mon | F-36..F-38 (P1F Home/Dialogs) |
| Week 3 | Tue | F-39 (HomePage) |
| Week 3 | Wed–Thu | F-40 (ProjectPage — phức tạp nhất) |
| Week 3 | Fri | F-41..F-42 (DS + Media pages) |
| Week 4 | Mon | F-43..F-46 (Skills/Routines/Settings/Onboarding) |
| Week 4 | Tue–Fri | Testing + bug fixes + CSS polish |

---

## Checklist P2

- [x] F-39: `HomePage.tsx` — 3 tabs (recent/templates/skills), search, empty state, NewProjectDialog
- [x] F-40: `ProjectPage.tsx` — 2-col layout, SSE integration với useProjectPageStore, auto-scroll
- [x] F-41: `DesignSystemsPage.tsx` — category pills, search, DSCard grid, DSDetailDrawer
- [x] F-42: `MediaPage.tsx` — surface tabs, mode switch, PromptTemplateGallery, MediaTaskCard grid
- [x] F-43: `SkillsPage.tsx` — SkillGrid với onCreate navigation
- [x] F-44: `RoutinesPage.tsx` — routines list (fallback empty state OK)
- [x] F-45: `SettingsPage.tsx` — 9 tabs sidebar, General + API Keys + Appearance priority
- [x] F-46: `OnboardingPage.tsx` — 4-step flow, DS picker, skip options, completeOnboarding()

## Verify

```bash
cd ui/open-design-vnpay/ui
pnpm typecheck  # 0 errors
pnpm dev        # Visual check on localhost:5173
```
