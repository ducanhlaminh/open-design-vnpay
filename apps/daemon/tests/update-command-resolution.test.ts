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

import { formatUpdateSpawnError, resolveUpdateCommand } from '../src/server.js';

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

  it('resolves to powershell -File install.ps1 -Update on win32, matching deploy/host/README.md', () => {
    // README's documented Windows update command:
    //   powershell -File $env:USERPROFILE\.open-design\current\install.ps1 -Update
    // No -ExecutionPolicy Bypass — the README example doesn't use it, so
    // this must not add it either.
    expect(resolveUpdateCommand(odHome, 'win32')).toEqual({
      cmd: 'powershell',
      args: ['-File', join(odHome, 'current', 'install.ps1'), '-Update'],
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
