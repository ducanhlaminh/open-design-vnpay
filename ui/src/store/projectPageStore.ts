/**
 * F-09 — projectPageStore
 * Manages ProjectPage state: chat turns, SSE streaming, artifacts.
 */
import { create } from 'zustand';
import type { Artifact } from '../types';
import type { TodoItem } from '../api/runs/http';

// Local types (not imported from api to avoid circular deps)
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
