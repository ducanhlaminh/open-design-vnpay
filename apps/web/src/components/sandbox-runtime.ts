import { loadConfig } from '../state/config';
import type { AppConfig } from '../types';
import type {
  SandboxCodexDeviceLoginStatus,
  SandboxRuntimeId,
  SandboxRuntimeStatus,
  SandboxStatusResponse as ContractSandboxStatusResponse,
} from '@open-design/contracts/api/sandbox';

export type { SandboxRuntimeId, SandboxRuntimeStatus };
export type SandboxStatusResponse = Omit<ContractSandboxStatusResponse, 'runtimeStatuses'> & {
  runtimeStatuses?: SandboxRuntimeStatus[];
};
export type SandboxDeviceLoginResponse = SandboxCodexDeviceLoginStatus;

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
  return status.imageAvailable && status.authVolumeAvailable && status.authStatus === 'logged-in';
}
