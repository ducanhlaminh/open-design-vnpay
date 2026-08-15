// Pure/testable helpers backing the platform-aware spawn in POST
// /api/update/apply (see apps/daemon/src/server.ts). No server/HTTP
// involved — these exercise `resolveUpdateCommand` (which install command
// to run per platform) and `formatUpdateSpawnError` (how a spawn-time
// failure gets normalized into `lastUpdateError`) directly, as pure
// functions with no fs/spawn side effects.
//
// See specs/change/20260815-host-update-ui-windows/spec.md — Windows
// verification is limited to this unit test; there is no Windows machine
// in this dev environment to exercise a real `install.ps1` spawn.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  HOST_RUNTIME_RELEASE_CACHE_TTL_MS,
  formatPrematureUpdateExitError,
  formatUpdateSpawnError,
  resolveUpdateCommand,
  resolveUpdateSpawnOptions,
} from '../src/server.js';

describe('host runtime release cache', () => {
  it('expires before the UI background poll can remain stale for another cycle', () => {
    expect(HOST_RUNTIME_RELEASE_CACHE_TTL_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});

describe('resolveUpdateCommand', () => {
  const odHome = '/Users/alice/.open-design';

  it('resolves to bash install.sh --update on darwin', () => {
    expect(resolveUpdateCommand(odHome, 'darwin')).toEqual({
      cmd: 'bash',
      args: [join(odHome, 'current', 'install.sh'), '--update'],
    });
  });

  it('resolves to bash install.sh --update on linux', () => {
    expect(resolveUpdateCommand(odHome, 'linux')).toEqual({
      cmd: 'bash',
      args: [join(odHome, 'current', 'install.sh'), '--update'],
    });
  });

  it('resolves to a non-interactive powershell invocation of install.ps1 -Update on win32', () => {
    // Must NOT match the README's bare interactive example — this spawn
    // has no console/TTY (detached, windowsHide, stdio to a file), so it
    // needs -NoProfile/-NonInteractive/-ExecutionPolicy Bypass to avoid
    // exiting before running any script code. Verified live on Windows:
    // without these flags, the daemon's spawn produced an empty
    // update.log and never restarted the service, while the same command
    // typed into an interactive shell completed normally.
    expect(resolveUpdateCommand(odHome, 'win32')).toEqual({
      cmd: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', join(odHome, 'current', 'install.ps1'),
        '-Update',
      ],
    });
  });

  it('defaults platform to process.platform when not given', () => {
    const result = resolveUpdateCommand(odHome);
    expect(result.cmd).toBe(process.platform === 'win32' ? 'powershell' : 'bash');
  });
});

describe('formatUpdateSpawnError', () => {
  it('extracts .message from an Error instance', () => {
    const err = new Error('spawn bash ENOENT');
    expect(formatUpdateSpawnError(err, '2026-08-15T00:00:00.000Z')).toEqual({
      message: 'spawn bash ENOENT',
      at: '2026-08-15T00:00:00.000Z',
    });
  });

  it('stringifies a non-Error value', () => {
    expect(formatUpdateSpawnError('boom', '2026-08-15T00:00:00.000Z')).toEqual({
      message: 'boom',
      at: '2026-08-15T00:00:00.000Z',
    });
  });

  it('defaults `at` to an ISO timestamp when not given', () => {
    const result = formatUpdateSpawnError(new Error('x'));
    expect(new Date(result.at).toISOString()).toBe(result.at);
  });
});

describe('resolveUpdateSpawnOptions', () => {
  it('keeps the Windows PowerShell child attached while hiding its window', () => {
    // Live Windows repro: detached+unref PowerShell children exited 0 but
    // never executed their -Command body. Both non-detached variants ran,
    // regardless of windowsHide.
    expect(resolveUpdateSpawnOptions('win32')).toEqual({
      detached: false,
      windowsHide: true,
    });
  });

  it.each(['darwin', 'linux'] as const)('keeps the existing detached behavior on %s', (platform) => {
    expect(resolveUpdateSpawnOptions(platform)).toEqual({ detached: true });
  });
});

describe('formatPrematureUpdateExitError', () => {
  it('treats exit code 0 as a failure when the original daemon is still alive', () => {
    expect(formatPrematureUpdateExitError(0, null).message).toContain('code 0');
  });

  it('includes a termination signal when present', () => {
    expect(formatPrematureUpdateExitError(null, 'SIGTERM').message).toContain('signal SIGTERM');
  });
});
