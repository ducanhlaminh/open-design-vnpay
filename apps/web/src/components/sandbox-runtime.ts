import { loadConfig } from '../state/config';
import type { AppConfig } from '../types';

export type SandboxRuntimeId = 'claude' | 'codex';

export type SandboxDeviceLoginPhase =
  | 'idle'
  | 'starting'
  | 'awaiting-user'
  | 'verifying'
  | 'done'
  | 'error';

/**
 * Local shadow of the daemon sandbox contract.
 *
 * The daemon-side worktree is landing a newer sandbox DTO than the copy this
 * branch was generated against, so the web UI keeps the minimal shape it needs
 * here and treats every field as runtime-optional. That lets the settings and
 * onboarding UI compile cleanly without waiting on the contract worktree.
 */
export interface SandboxRuntimeStatus {
  id: string;
  version: string | null;
  imageAvailable: boolean;
  authVolume: string | null;
  authVolumeAvailable: boolean;
  authStatus: string | null;
  loginMethod: string | null;
}

export interface SandboxStatusResponse {
  enabled: boolean;
  runtimeStatuses?: SandboxRuntimeStatus[];
  dockerOk: boolean;
  image: string;
  imageOk: boolean;
  authVolumeOk: boolean;
  authLoggedIn: boolean | null;
  activeContainers: string[];
  runtimes: string[];
  skills: string[];
  timeoutMinutes: number;
  builderDir: string;
}

export interface SandboxDeviceLoginResponse {
  phase: SandboxDeviceLoginPhase;
  url: string | null;
  code: string | null;
  expiresAt: string | null;
  error: string | null;
}

export function getSelectedSandboxRuntime(config: Pick<AppConfig, 'agentId'> | null | undefined): SandboxRuntimeId {
  return config?.agentId === 'codex' ? 'codex' : 'claude';
}

export function getStoredSandboxRuntime(): SandboxRuntimeId {
  return getSelectedSandboxRuntime(loadConfig());
}

export function sandboxRuntimeDisplayName(runtimeId: SandboxRuntimeId): string {
  return runtimeId === 'codex' ? 'Codex' : 'Claude';
}

export function isSandboxRuntimeReady(status: SandboxRuntimeStatus | undefined): boolean {
  if (!status) return false;
  const authReady =
    status.authStatus === 'ready' ||
    status.authStatus === 'authenticated' ||
    status.authStatus === 'logged-in' ||
    status.authStatus === 'done';
  return status.imageAvailable && status.authVolumeAvailable && authReady;
}
