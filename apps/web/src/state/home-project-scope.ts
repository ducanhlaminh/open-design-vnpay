// Home "project scope" — the KGS/SimStudio project a newly created conversation
// is scoped to. The Home dropdown sets it; `createProject` reads it and stamps
// `metadata.kgsProjectId` on the new project so /projects can group by it and
// the conversation's KG operations target that project_id.
//
// A tiny module store (useSyncExternalStore) so the picker and createProject
// share one source of truth without threading props through the whole tree.
import { useSyncExternalStore } from 'react';
import { fetchKgProjects, type WebKgProject } from '../providers/registry';

interface ScopeState {
  projects: WebKgProject[];
  selectedId: string;
  loaded: boolean;
}

let state: ScopeState = { projects: [], selectedId: '', loaded: false };
const listeners = new Set<() => void>();
let loadPromise: Promise<void> | null = null;

const STORAGE_KEY = 'od.home.kgsProjectId';

function persisted(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function emit() {
  for (const l of listeners) l();
}

function setState(next: Partial<ScopeState>) {
  state = { ...state, ...next };
  emit();
}

/** Subscribe (for useSyncExternalStore). */
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Load the KGS project list once; pre-selects the persisted or first project. */
export function loadHomeKgProjects(force = false): Promise<void> {
  if (loadPromise && !force) return loadPromise;
  loadPromise = fetchKgProjects().then((projects) => {
    const saved = persisted();
    const selectedId =
      (saved && projects.some((p) => p.id === saved) && saved) ||
      state.selectedId ||
      projects[0]?.id ||
      '';
    setState({ projects, selectedId, loaded: true });
  });
  return loadPromise;
}

/** The KGS project_id the next new conversation will be scoped to ('' = none). */
export function getHomeKgProjectId(): string {
  return state.selectedId;
}

export function setHomeKgProject(id: string) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* non-persistent context — ignore */
  }
  setState({ selectedId: id });
}

/** Resolve a KGS project's display name (falls back to its id). */
export function kgProjectName(id: string | undefined | null): string {
  if (!id) return '';
  return state.projects.find((p) => p.id === id)?.name ?? id;
}

export function useHomeProjectScope(): ScopeState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
