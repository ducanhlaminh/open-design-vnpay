// Host-runtime self-update state shared between the headless poller
// (components/UpdateCheck.tsx, mounted once in App) and the header button
// (components/HostUpdateButton.tsx, mounted in the entry topbar). A tiny
// module store instead of prop drilling: the button must reflect an apply
// that was started before the user navigated, and the poller must keep
// running (and reload on `justUpdated`) even when the button is not on
// screen. `od self-update` (apps/daemon/src/cli.ts) is the CLI mirror of
// the same two endpoints.
import { useSyncExternalStore } from 'react';

export interface UpdateStatusResponse {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** Set by the daemon when it actually answered from GitHub (fresh or
   *  cached); `checkError` is only populated for an explicit `?refresh=1`
   *  check that could not reach GitHub. */
  checkedAt?: string | null;
  checkError?: string | null;
  justUpdated: { version: string; at: string } | null;
  lastError: { message: string; at: string } | null;
  state?: string | null;
  // Parsed by the daemon from the running install.sh/install.ps1 log — only
  // non-null while THIS daemon process is still the one applying the update.
  // `percent` = completed steps + the last "NN%" seen in the current step.
  progress: { step: number; totalSteps: number; label: string; percent?: number } | null;
}

export interface HostUpdateState {
  status: UpdateStatusResponse | null;
  applying: boolean;
  applyStartedAt: number | null;
  applyError: string | null;
  restartRequired: string | null;
}

const initialState: HostUpdateState = {
  status: null,
  applying: false,
  applyStartedAt: null,
  applyError: null,
  restartRequired: null,
};

let state: HostUpdateState = initialState;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getHostUpdateState(): HostUpdateState {
  return state;
}

export function setHostUpdateState(patch: Partial<HostUpdateState>): void {
  state = { ...state, ...patch };
  emit();
}

export function resetHostUpdateState(): void {
  state = initialState;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHostUpdateState(): HostUpdateState {
  return useSyncExternalStore(subscribe, getHostUpdateState, getHostUpdateState);
}

// Percent shown on the header button while an apply is in flight. Prefers
// the daemon's estimate; falls back to a step-based one for daemons that
// predate `progress.percent`. Never 100 — only `justUpdated` (and the page
// reload it triggers) means done.
export function hostUpdatePercent(status: UpdateStatusResponse | null): number {
  const progress = status?.progress;
  if (!progress) return 0;
  if (typeof progress.percent === 'number' && Number.isFinite(progress.percent)) {
    return Math.min(99, Math.max(0, Math.round(progress.percent)));
  }
  if (progress.totalSteps > 0) {
    return Math.min(99, Math.max(0, Math.round(((progress.step - 1) / progress.totalSteps) * 100)));
  }
  return 0;
}
