# 08 — Global State Management (Zustand)

> Strategy: Zustand cho global state. Không dùng Context API vì tạo re-render không cần thiết.

---

## Why Zustand

- Lightweight (~1KB)
- Không wrap app với Provider
- Tích hợp tốt với TypeScript
- Hỗ trợ persist (localStorage)
- Dễ test

---

## Stores cần tạo

### 1. `useAppStore` — Config + Theme + Global selections

**File**: `ui/src/store/appStore.ts`

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppTheme, AppConfig } from '../types';

interface AppStore {
  // Config
  config: AppConfig | null;
  configLoaded: boolean;
  setConfig: (c: AppConfig) => void;
  updateConfig: (patch: Partial<AppConfig>) => void;

  // Theme
  theme: AppTheme;
  setTheme: (t: AppTheme) => void;

  // Global selections (persist cross-sessions)
  selectedDesignSystemId: string | null;
  selectedSkillId: string | null;
  selectedAgentId: string | null;
  setSelectedDS: (id: string | null) => void;
  setSelectedSkill: (id: string | null) => void;
  setSelectedAgent: (id: string | null) => void;

  // Onboarding
  onboardingCompleted: boolean;
  completeOnboarding: () => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      config: null,
      configLoaded: false,
      setConfig: (config) => set({ config, configLoaded: true }),
      updateConfig: (patch) => set(s => ({ config: s.config ? { ...s.config, ...patch } : null })),

      theme: 'system',
      setTheme: (theme) => set({ theme }),

      selectedDesignSystemId: null,
      selectedSkillId: null,
      selectedAgentId: null,
      setSelectedDS: (id) => set({ selectedDesignSystemId: id }),
      setSelectedSkill: (id) => set({ selectedSkillId: id }),
      setSelectedAgent: (id) => set({ selectedAgentId: id }),

      onboardingCompleted: false,
      completeOnboarding: () => set({ onboardingCompleted: true }),
    }),
    {
      name: 'open-design-app',
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
```

---

### 2. `useProjectPageStore` — Chat + Streaming state per project

**File**: `ui/src/store/projectPageStore.ts`

```typescript
import { create } from 'zustand';
import type { Artifact, TodoItem, QuestionFormEvent, DirectionPickerEvent } from '../types';
import type { ToolUseEvent, ArtifactEvent } from '../api/runs/http';

export type PagePhase = 'idle' | 'streaming' | 'question' | 'direction' | 'done' | 'error';

interface ChatTurn {
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

export const useProjectPageStore = create<ProjectPageStore>()((set) => ({
  projectId: null,
  phase: 'idle',
  turns: [],
  activeArtifact: null,
  runId: null,
  error: null,

  initProject: (id) => set({ projectId: id, phase: 'idle', turns: [], activeArtifact: null }),

  addUserTurn: (text) => set(s => ({
    turns: [...s.turns, { id: crypto.randomUUID(), role: 'user', text, toolUses: [], todos: [], artifacts: [], questionForm: null, directionEvent: null, isStreaming: false }],
    phase: 'streaming',
  })),

  startAssistantTurn: () => {
    const id = crypto.randomUUID();
    set(s => ({
      turns: [...s.turns, { id, role: 'assistant', text: '', toolUses: [], todos: [], artifacts: [], questionForm: null, directionEvent: null, isStreaming: true }],
    }));
    return id;
  },

  appendDelta: (turnId, text) => set(s => ({
    turns: s.turns.map(t => t.id === turnId ? { ...t, text: t.text + text } : t),
  })),

  setTodos: (turnId, items) => set(s => ({
    turns: s.turns.map(t => t.id === turnId ? { ...t, todos: items } : t),
  })),

  addToolUse: (turnId, event) => set(s => ({
    turns: s.turns.map(t => t.id === turnId ? { ...t, toolUses: [...t.toolUses, event] } : t),
  })),

  setArtifact: (turnId, event) => set(s => ({
    turns: s.turns.map(t => t.id === turnId ? { ...t, artifacts: [...t.artifacts, event] } : t),
    activeArtifact: { identifier: event.identifier, title: event.title, html: event.content, artifactType: event.artifactType },
  })),

  showQuestionForm: (turnId, form) => set(s => ({
    turns: s.turns.map(t => t.id === turnId ? { ...t, questionForm: form } : t),
    phase: 'question',
  })),

  showDirectionPicker: (turnId, event) => set(s => ({
    turns: s.turns.map(t => t.id === turnId ? { ...t, directionEvent: event } : t),
    phase: 'direction',
  })),

  finishTurn: (turnId) => set(s => ({
    turns: s.turns.map(t => t.id === turnId ? { ...t, isStreaming: false } : t),
    phase: 'done',
  })),

  setError: (error) => set({ phase: 'error', error }),
  reset: () => set({ phase: 'idle', runId: null, error: null }),
}));
```

---

### 3. `useDesignSystemStore` — DS catalog cache

**File**: `ui/src/store/designSystemStore.ts`

```typescript
import { create } from 'zustand';
import type { DesignSystemSummary } from '../types';

interface DesignSystemStore {
  catalog: DesignSystemSummary[];
  loading: boolean;
  loaded: boolean;
  fetchCatalog: () => Promise<void>;
  getById: (id: string) => DesignSystemSummary | undefined;
}

export const useDesignSystemStore = create<DesignSystemStore>()((set, get) => ({
  catalog: [],
  loading: false,
  loaded: false,

  fetchCatalog: async () => {
    if (get().loading || get().loaded) return;
    set({ loading: true });
    try {
      const { api } = await import('../api');
      const list = await api.designSystems.listDesignSystems();
      set({ catalog: list, loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  getById: (id) => get().catalog.find(ds => ds.id === id),
}));
```

---

### 4. `useTemplateStore` — Design template catalog cache

**File**: `ui/src/store/templateStore.ts`

```typescript
import { create } from 'zustand';
import type { DesignTemplateSummary } from '../types';

interface TemplateStore {
  templates: DesignTemplateSummary[];
  loaded: boolean;
  fetchTemplates: () => Promise<void>;
}

export const useTemplateStore = create<TemplateStore>()((set, get) => ({
  templates: [],
  loaded: false,
  fetchTemplates: async () => {
    if (get().loaded) return;
    const { api } = await import('../api');
    const list = await api.designTemplates.listDesignTemplates();
    set({ templates: list, loaded: true });
  },
}));
```

---

## Installation

```bash
pnpm --filter @open-design/ui add zustand
```

**Thêm vào `package.json` dependencies**:
```json
"zustand": "^4.5.5"
```

---

## Usage pattern trong components

```tsx
// Component dùng DS selection
import { useAppStore } from '../store/appStore';

function ChatToolbar() {
  const { selectedDesignSystemId, setSelectedDS } = useAppStore();
  return <DesignSystemPicker selectedId={selectedDesignSystemId} onSelect={setSelectedDS} />;
}

// Component dùng DS catalog
import { useDesignSystemStore } from '../store/designSystemStore';

function DesignSystemPicker() {
  const { catalog, loaded, fetchCatalog } = useDesignSystemStore();
  useEffect(() => { fetchCatalog(); }, []);
  // ...
}
```

---

## Files summary

| File | Hành động |
|------|----------|
| `store/appStore.ts` | **TẠO MỚI** — config + theme + global selections |
| `store/projectPageStore.ts` | **TẠO MỚI** — chat + SSE streaming state |
| `store/designSystemStore.ts` | **TẠO MỚI** — DS catalog cache |
| `store/templateStore.ts` | **TẠO MỚI** — design templates cache |
| `package.json` | **CẬP NHẬT** — thêm `zustand` dependency |
