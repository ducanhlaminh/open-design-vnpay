/**
 * F-08 — appStore
 * Global app state: config, theme, cross-page selections, onboarding.
 * Persisted in localStorage under key 'open-design-app'.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppConfig, AppTheme } from '../types';

interface AppStore {
  // Config from server
  config: AppConfig | null;
  configLoaded: boolean;
  setConfig: (c: AppConfig) => void;
  updateConfig: (patch: Partial<AppConfig>) => void;

  // Theme (persisted)
  theme: AppTheme;
  setTheme: (t: AppTheme) => void;

  // Global selections (persisted — used cross-pages)
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
      // Only persist fields that need to survive page reload (not server-fetched config)
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

// Convenience selectors (avoid subscribing to full store)
export const useSelectedDS = () => useAppStore((s) => s.selectedDesignSystemId);
export const useSetSelectedDS = () => useAppStore((s) => s.setSelectedDS);
export const useTheme = () => useAppStore((s) => s.theme);
export const useAppConfig = () => useAppStore((s) => s.config);
