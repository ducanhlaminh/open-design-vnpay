# F-08..F-11 — Foundation: Zustand Stores

**Phase**: P0 (stores) | **Estimate**: ~7h | **Depends on**: F-01 (zustand installed), F-02 (types)  
**Target dir**: `ui/src/store/` (TẠO MỚI thư mục nếu chưa có)

```bash
mkdir -p ui/open-design-vnpay/ui/src/store
```

---

## F-08 — `src/store/appStore.ts`

**Estimate**: 2h  
**Persist**: `localStorage` key `open-design-app`

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppConfig } from '../types';

// AppTheme — nếu chưa có trong types.ts, thêm:
// export type AppTheme = 'light' | 'dark' | 'system';
type AppTheme = 'light' | 'dark' | 'system';

interface AppStore {
  // Config từ server
  config: AppConfig | null;
  configLoaded: boolean;
  setConfig: (c: AppConfig) => void;
  updateConfig: (patch: Partial<AppConfig>) => void;

  // Theme (persisted)
  theme: AppTheme;
  setTheme: (t: AppTheme) => void;

  // Global selections (persisted — dùng cross-pages)
  selectedDesignSystemId: string | null;
  selectedSkillId: string | null;
  selectedAgentId: string | null;
  setSelectedDS: (id: string | null) => void;
  setSelectedSkill: (id: string | null) => void;
  setSelectedAgent: (id: string | null) => void;

  // Onboarding (persisted)
  onboardingCompleted: boolean;
  completeOnboarding: () => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      // Config
      config: null,
      configLoaded: false,
      setConfig: (config) => set({ config, configLoaded: true }),
      updateConfig: (patch) =>
        set((s) => ({ config: s.config ? { ...s.config, ...patch } : null })),

      // Theme
      theme: 'system',
      setTheme: (theme) => set({ theme }),

      // Selections
      selectedDesignSystemId: null,
      selectedSkillId: null,
      selectedAgentId: null,
      setSelectedDS: (id) => set({ selectedDesignSystemId: id }),
      setSelectedSkill: (id) => set({ selectedSkillId: id }),
      setSelectedAgent: (id) => set({ selectedAgentId: id }),

      // Onboarding
      onboardingCompleted: false,
      completeOnboarding: () => set({ onboardingCompleted: true }),
    }),
    {
      name: 'open-design-app',
      // Chỉ persist những fields cần thiết (không persist config từ server)
      partialize: (s) => ({
        theme: s.theme,
        selectedDesignSystemId: s.selectedDesignSystemId,
        selectedSkillId: s.selectedSkillId,
        selectedAgentId: s.selectedAgentId,
        onboardingCompleted: s.onboardingCompleted,
      }),
    },
  ),
);

// Convenience selectors (để tránh subscribe toàn store)
export const useSelectedDS = () => useAppStore((s) => s.selectedDesignSystemId);
export const useSetSelectedDS = () => useAppStore((s) => s.setSelectedDS);
export const useTheme = () => useAppStore((s) => s.theme);
export const useAppConfig = () => useAppStore((s) => s.config);
```

**Usage**:
```tsx
import { useAppStore, useSelectedDS } from '../store/appStore';

function ChatToolbar() {
  const selectedDSId = useSelectedDS();
  const setSelectedDS = useAppStore(s => s.setSelectedDS);
  return <DesignSystemPicker selectedId={selectedDSId} onSelect={setSelectedDS} />;
}
```

---

## F-09 — `src/store/projectPageStore.ts`

**Estimate**: 3h  
**Mục đích**: Quản lý state của ProjectPage — chat turns, SSE streaming, artifacts

```typescript
import { create } from 'zustand';
import type { Artifact, TodoItem } from '../types';

// Local types (không import từ api để tránh circular deps)
export interface ToolUseEvent {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: string;
  status: 'running' | 'done' | 'error';
}

export interface ArtifactEvent {
  identifier: string;
  title: string;
  content: string;
  artifactType: string;
}

export interface QuestionFormEvent {
  id: string;
  question: string;
  options?: string[];
}

export interface DirectionPickerEvent {
  id: string;
  directions: string[];
}

export type PagePhase = 'idle' | 'streaming' | 'question' | 'direction' | 'done' | 'error';

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolUses: ToolUseEvent[];
  todos: TodoItem[];
  artifacts: ArtifactEvent[];
  questionForm: QuestionFormEvent | null;
  directionEvent: DirectionPickerEvent | null;
  isStreaming: boolean;
}

interface ProjectPageStore {
  projectId: string | null;
  phase: PagePhase;
  turns: ChatTurn[];
  activeArtifact: Artifact | null;
  runId: string | null;
  error: string | null;

  // Actions
  initProject: (id: string) => void;
  addUserTurn: (text: string) => void;
  startAssistantTurn: () => string; // returns turnId
  appendDelta: (turnId: string, text: string) => void;
  setTodos: (turnId: string, items: TodoItem[]) => void;
  addToolUse: (turnId: string, event: ToolUseEvent) => void;
  setArtifact: (turnId: string, event: ArtifactEvent) => void;
  showQuestionForm: (turnId: string, form: QuestionFormEvent) => void;
  showDirectionPicker: (turnId: string, event: DirectionPickerEvent) => void;
  finishTurn: (turnId: string) => void;
  setError: (error: string) => void;
  reset: () => void;
}

const newTurn = (role: 'user' | 'assistant', text = ''): ChatTurn => ({
  id: crypto.randomUUID(),
  role,
  text,
  toolUses: [],
  todos: [],
  artifacts: [],
  questionForm: null,
  directionEvent: null,
  isStreaming: role === 'assistant',
});

export const useProjectPageStore = create<ProjectPageStore>()((set) => ({
  projectId: null,
  phase: 'idle',
  turns: [],
  activeArtifact: null,
  runId: null,
  error: null,

  initProject: (id) =>
    set({ projectId: id, phase: 'idle', turns: [], activeArtifact: null, error: null }),

  addUserTurn: (text) =>
    set((s) => ({
      turns: [...s.turns, newTurn('user', text)],
      phase: 'streaming',
    })),

  startAssistantTurn: () => {
    const turn = newTurn('assistant');
    set((s) => ({ turns: [...s.turns, turn] }));
    return turn.id;
  },

  appendDelta: (turnId, text) =>
    set((s) => ({
      turns: s.turns.map((t) => (t.id === turnId ? { ...t, text: t.text + text } : t)),
    })),

  setTodos: (turnId, items) =>
    set((s) => ({
      turns: s.turns.map((t) => (t.id === turnId ? { ...t, todos: items } : t)),
    })),

  addToolUse: (turnId, event) =>
    set((s) => ({
      turns: s.turns.map((t) =>
        t.id === turnId ? { ...t, toolUses: [...t.toolUses, event] } : t,
      ),
    })),

  setArtifact: (turnId, event) =>
    set((s) => ({
      turns: s.turns.map((t) =>
        t.id === turnId ? { ...t, artifacts: [...t.artifacts, event] } : t,
      ),
      activeArtifact: {
        identifier: event.identifier,
        title: event.title,
        html: event.content,
        artifactType: event.artifactType,
      } as Artifact,
    })),

  showQuestionForm: (turnId, form) =>
    set((s) => ({
      turns: s.turns.map((t) => (t.id === turnId ? { ...t, questionForm: form } : t)),
      phase: 'question',
    })),

  showDirectionPicker: (turnId, event) =>
    set((s) => ({
      turns: s.turns.map((t) => (t.id === turnId ? { ...t, directionEvent: event } : t)),
      phase: 'direction',
    })),

  finishTurn: (turnId) =>
    set((s) => ({
      turns: s.turns.map((t) => (t.id === turnId ? { ...t, isStreaming: false } : t)),
      phase: 'done',
    })),

  setError: (error) => set({ phase: 'error', error }),
  reset: () => set({ phase: 'idle', runId: null, error: null }),
}));
```

---

## F-10 — `src/store/designSystemStore.ts`

**Estimate**: 1h  
**Mục đích**: Cache catalog 150+ DS — chỉ fetch 1 lần per session

```typescript
import { create } from 'zustand';
import type { DesignSystemSummary } from '../types';

interface DesignSystemStore {
  catalog: DesignSystemSummary[];
  categories: string[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  fetchCatalog: () => Promise<void>;
  getById: (id: string) => DesignSystemSummary | undefined;
  filterByCategory: (category: string) => DesignSystemSummary[];
}

export const useDesignSystemStore = create<DesignSystemStore>()((set, get) => ({
  catalog: [],
  categories: [],
  loading: false,
  loaded: false,
  error: null,

  fetchCatalog: async () => {
    if (get().loading || get().loaded) return;
    set({ loading: true, error: null });
    try {
      // Dynamic import để tránh circular deps
      const { api } = await import('../api');
      const resp = await api.designSystems.listDesignSystems();
      // listDesignSystems returns DesignSystemSummary[] trực tiếp
      const list = Array.isArray(resp) ? resp : (resp as any).items ?? [];
      // Compute unique categories
      const cats = [...new Set(list.map((ds) => ds.category).filter(Boolean))].sort();
      set({ catalog: list, categories: cats, loaded: true });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ loading: false });
    }
  },

  getById: (id) => get().catalog.find((ds) => ds.id === id),

  filterByCategory: (category) => {
    if (!category || category === 'all') return get().catalog;
    return get().catalog.filter((ds) => ds.category === category);
  },
}));
```

---

## F-11 — `src/store/templateStore.ts`

**Estimate**: 1h  
**Mục đích**: Cache 111 design templates

```typescript
import { create } from 'zustand';
import type { DesignTemplateSummary } from '../types';

interface TemplateStore {
  templates: DesignTemplateSummary[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  fetchTemplates: () => Promise<void>;
  getById: (id: string) => DesignTemplateSummary | undefined;
  filterByMode: (mode: string) => DesignTemplateSummary[];
}

export const useTemplateStore = create<TemplateStore>()((set, get) => ({
  templates: [],
  loading: false,
  loaded: false,
  error: null,

  fetchTemplates: async () => {
    if (get().loading || get().loaded) return;
    set({ loading: true, error: null });
    try {
      const { api } = await import('../api');
      const resp = await api.designTemplates.listDesignTemplates();
      const list = Array.isArray(resp) ? resp : (resp as any).items ?? [];
      set({ templates: list, loaded: true });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ loading: false });
    }
  },

  getById: (id) => get().templates.find((t) => t.id === id),

  filterByMode: (mode) => {
    if (!mode || mode === 'all') return get().templates;
    return get().templates.filter((t) => t.mode === mode);
  },
}));
```

---

## Checklist P0 Stores

- [x] F-08: `store/appStore.ts` — persist OK, selectors exported
- [x] F-09: `store/projectPageStore.ts` — newTurn helper, all actions implemented
- [x] F-10: `store/designSystemStore.ts` — categories derived, filterByCategory OK
- [x] F-11: `store/templateStore.ts` — filterByMode OK

**Verify all stores**:
```bash
cd ui/open-design-vnpay/ui
pnpm typecheck
# Expected: 0 errors trong store/ directory
```
