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
  installerFileNameForPlatform,
  installerSanityMarker,
  isSanityValidInstallerBody,
  isWindowsUpdateRestartRequiredExit,
  formatUpdateSpawnError,
  resolveHostRuntimeReleaseBase,
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

  // WP-B: POST /api/update/apply downloads the LATEST installer to a temp
  // file first and, on success, must run THAT file instead of the one
  // bundled with the currently-installed version — see
  // `downloadLatestInstaller` in server.ts. `scriptPath` is the seam that
  // lets this be exercised without any fs/network.
  it('uses scriptPath in place of the derived $OD_HOME/current install script on darwin', () => {
    const scriptPath = '/tmp/od-data/update-installer-abc-123.sh';
    expect(resolveUpdateCommand(odHome, 'darwin', scriptPath)).toEqual({
      cmd: 'bash',
      args: [scriptPath, '--update'],
    });
  });

  it('uses scriptPath in place of the derived $OD_HOME/current install script on win32', () => {
    const scriptPath = 'C:\\Users\\alice\\AppData\\od-data\\update-installer-abc-123.ps1';
    expect(resolveUpdateCommand(odHome, 'win32', scriptPath)).toEqual({
      cmd: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Update',
      ],
    });
  });

  it('falls back to the derived $OD_HOME/current path when scriptPath is not given', () => {
    expect(resolveUpdateCommand(odHome, 'darwin').args[0]).toBe(join(odHome, 'current', 'install.sh'));
    expect(resolveUpdateCommand(odHome, 'win32').args[5]).toBe(join(odHome, 'current', 'install.ps1'));
  });
});

// WP-B: base resolution for both the release check and the installer
// download must honor `OD_RELEASE_URL` (config.env, written by
// install.sh's write_config_env — see deploy/host/install.sh's
// resolve_archive ~line 460) as an ABSOLUTE override with no GitHub/mirror
// fallback, exactly like the installer itself treats a pinned source.
describe('resolveHostRuntimeReleaseBase', () => {
  it('defaults to the mirror base and isOverride:false when OD_RELEASE_URL is unset', () => {
    expect(resolveHostRuntimeReleaseBase({})).toEqual({
      base: 'https://od-runtime.pages.dev/latest',
      isOverride: false,
    });
  });

  it('defaults when OD_RELEASE_URL is set but blank/whitespace-only', () => {
    expect(resolveHostRuntimeReleaseBase({ OD_RELEASE_URL: '' })).toEqual({
      base: 'https://od-runtime.pages.dev/latest',
      isOverride: false,
    });
    expect(resolveHostRuntimeReleaseBase({ OD_RELEASE_URL: '   ' })).toEqual({
      base: 'https://od-runtime.pages.dev/latest',
      isOverride: false,
    });
  });

  it('uses OD_RELEASE_URL verbatim (trimmed) when set without a trailing slash', () => {
    expect(resolveHostRuntimeReleaseBase({ OD_RELEASE_URL: '  https://mirror.internal/od  ' })).toEqual({
      base: 'https://mirror.internal/od',
      isOverride: true,
    });
  });

  it('strips a trailing slash (or several) from OD_RELEASE_URL', () => {
    expect(resolveHostRuntimeReleaseBase({ OD_RELEASE_URL: 'https://mirror.internal/od/' })).toEqual({
      base: 'https://mirror.internal/od',
      isOverride: true,
    });
    expect(resolveHostRuntimeReleaseBase({ OD_RELEASE_URL: 'https://mirror.internal/od///' })).toEqual({
      base: 'https://mirror.internal/od',
      isOverride: true,
    });
  });
});

describe('installer sanity check (installerSanityMarker / isSanityValidInstallerBody)', () => {
  it('requires the platform-appropriate flag marker inside a non-empty body', () => {
    expect(installerSanityMarker('win32')).toBe('-Update');
    expect(installerSanityMarker('darwin')).toBe('--update');
    expect(installerSanityMarker('linux')).toBe('--update');
  });

  it('accepts a body containing the marker', () => {
    expect(isSanityValidInstallerBody('#!/bin/sh\n# usage: install.sh --update\n', 'darwin')).toBe(true);
    expect(isSanityValidInstallerBody('# ... -Update ...', 'win32')).toBe(true);
  });

  it('rejects an empty body — guards against a 200-OK empty response', () => {
    expect(isSanityValidInstallerBody('', 'darwin')).toBe(false);
    expect(isSanityValidInstallerBody('   \n  ', 'darwin')).toBe(false);
  });

  it('rejects a body missing the marker — guards against a proxy/captive-portal 200-HTML page', () => {
    expect(isSanityValidInstallerBody('<html><body>Sign in to Wi-Fi</body></html>', 'darwin')).toBe(false);
  });

  it('rejects a non-string body', () => {
    expect(isSanityValidInstallerBody(null, 'darwin')).toBe(false);
    expect(isSanityValidInstallerBody(undefined, 'darwin')).toBe(false);
  });
});

describe('installerFileNameForPlatform', () => {
  it('names the temp file with the operationId and the platform-appropriate extension', () => {
    expect(installerFileNameForPlatform('darwin', 'op-1')).toBe('update-installer-op-1.sh');
    expect(installerFileNameForPlatform('linux', 'op-1')).toBe('update-installer-op-1.sh');
    expect(installerFileNameForPlatform('win32', 'op-1')).toBe('update-installer-op-1.ps1');
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

describe('isWindowsUpdateRestartRequiredExit', () => {
  it('accepts only the dedicated unsignalled Windows exit code', () => {
    expect(isWindowsUpdateRestartRequiredExit('win32', 75, null)).toBe(true);
    expect(isWindowsUpdateRestartRequiredExit('linux', 75, null)).toBe(false);
    expect(isWindowsUpdateRestartRequiredExit('win32', 1, null)).toBe(false);
    expect(isWindowsUpdateRestartRequiredExit('win32', 75, 'SIGTERM')).toBe(false);
  });
});
