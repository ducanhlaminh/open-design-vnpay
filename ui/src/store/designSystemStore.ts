/**
 * F-10 — designSystemStore
 * Cache design system catalog (150+ DS) — fetch once per session.
 */
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
      // Dynamic import to avoid circular deps
      const { api } = await import('../api');
      const resp = await api.designSystems.listDesignSystems();
      // listDesignSystems returns DesignSystemSummary[] directly
      const list = Array.isArray(resp) ? resp : ((resp as unknown as { items: DesignSystemSummary[] }).items ?? []);
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
