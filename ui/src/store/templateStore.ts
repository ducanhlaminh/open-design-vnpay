/**
 * F-11 — templateStore
 * Cache design template catalog (111 templates) — fetch once per session.
 */
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
      const list = Array.isArray(resp) ? resp : (resp.items ?? []);
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
