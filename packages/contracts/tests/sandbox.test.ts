import { describe, expect, it } from 'vitest';
import {
  sandboxAccountLabelFromEmail,
  type SandboxCodexDeviceLoginStatus,
  type SandboxRuntimeStatus,
  type SandboxStatusResponse,
} from '../src/api/sandbox.js';

describe('sandbox contracts', () => {
  it('derives a filesystem-safe Claude account label from email', () => {
    expect(sandboxAccountLabelFromEmail('dev+ops@example.com')).toBe('dev-ops');
    expect(sandboxAccountLabelFromEmail('...')).toBeNull();
  });

  it('accepts runtime status and Codex device login payloads with the new fields', () => {
    const runtimeStatus: SandboxRuntimeStatus = {
      id: 'codex',
      version: '0.142.0',
      imageAvailable: true,
      authVolume: 'od-codex-auth',
      authVolumeAvailable: true,
      authStatus: 'logged-in',
      loginMethod: 'device',
    };
    const loginStatus: SandboxCodexDeviceLoginStatus = {
      phase: 'awaiting-user',
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-1234',
      expiresAt: null,
      error: null,
    };
    const response: SandboxStatusResponse = {
      enabled: true,
      runtimes: ['claude', 'codex'],
      skills: ['*'],
      timeoutMinutes: 30,
      dockerOk: true,
      image: 'od-agent-sandbox:test',
      imageOk: true,
      claudeVersion: '1.2.3',
      authVolumeOk: true,
      authLoggedIn: true,
      runtimeStatuses: [runtimeStatus],
      activeContainers: [],
      builderDir: '/tmp/builder',
    };

    expect(runtimeStatus.loginMethod).toBe('device');
    expect(loginStatus.phase).toBe('awaiting-user');
    expect(response.runtimeStatuses[0]?.id).toBe('codex');
  });
});
