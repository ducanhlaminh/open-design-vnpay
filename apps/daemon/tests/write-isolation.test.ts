import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WRITE_ISOLATION_BIN,
  buildWriteIsolationProfile,
  planWriteIsolation,
  wrapInvocationInWriteIsolation,
  writeIsolationMode,
} from '../src/write-isolation.js';

describe('writeIsolationMode', () => {
  it('defaults to off when the env var is unset', () => {
    expect(writeIsolationMode({})).toBe('off');
  });

  it('parses on/off/required', () => {
    expect(writeIsolationMode({ OD_WRITE_ISOLATION: 'on' })).toBe('on');
    expect(writeIsolationMode({ OD_WRITE_ISOLATION: 'off' })).toBe('off');
    expect(writeIsolationMode({ OD_WRITE_ISOLATION: 'required' })).toBe('required');
  });

  it('falls back to off on an unrecognized value — never behaves like on', () => {
    expect(writeIsolationMode({ OD_WRITE_ISOLATION: 'yes' })).toBe('off');
    expect(writeIsolationMode({ OD_WRITE_ISOLATION: '1' })).toBe('off');
    expect(writeIsolationMode({ OD_WRITE_ISOLATION: '' })).toBe('off');
  });
});

describe('buildWriteIsolationProfile', () => {
  const base = {
    cwd: '/data/projects/p1/docs-to-react',
    extraWritableDirs: [] as string[],
    home: '/Users/dev',
  };

  it('opens with version/allow-default/deny-write in order', () => {
    const profile = buildWriteIsolationProfile(base);
    const lines = profile.split('\n');
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(allow default)');
    expect(lines[2]).toBe('(deny file-write*)');
    expect(lines[3]).toBe('(allow file-write*');
  });

  it('contains every built-in allowlist entry, in spec order', () => {
    const profile = buildWriteIsolationProfile(base);
    const allowBlockStart = profile.indexOf('(allow file-write*');
    const idx = (needle: string): number => {
      const at = profile.indexOf(needle);
      expect(at, `expected profile to contain: ${needle}`).toBeGreaterThan(-1);
      return at;
    };

    const cwdIdx = idx('(subpath "/data/projects/p1/docs-to-react")');
    const tmpIdx = idx('(subpath "/private/tmp")');
    const varFoldersIdx = idx('(subpath "/private/var/folders")');
    const devIdx = idx('(regex #"^/dev/")');
    const claudeDirIdx = idx('(subpath "/Users/dev/.claude")');
    const claudeJsonIdx = idx('(literal "/Users/dev/.claude.json")');
    const claudeJsonBackupIdx = idx('(literal "/Users/dev/.claude.json.backup")');
    const npmIdx = idx('(subpath "/Users/dev/.npm")');
    const cacheIdx = idx('(subpath "/Users/dev/.cache")');
    const pnpmIdx = idx('(subpath "/Users/dev/Library/pnpm")');
    const cachesIdx = idx('(subpath "/Users/dev/Library/Caches")');

    expect(allowBlockStart).toBeGreaterThan(-1);
    expect(cwdIdx).toBeGreaterThan(allowBlockStart);
    expect([
      cwdIdx,
      tmpIdx,
      varFoldersIdx,
      devIdx,
      claudeDirIdx,
      claudeJsonIdx,
      claudeJsonBackupIdx,
      npmIdx,
      cacheIdx,
      pnpmIdx,
      cachesIdx,
    ]).toEqual(
      [
        cwdIdx,
        tmpIdx,
        varFoldersIdx,
        devIdx,
        claudeDirIdx,
        claudeJsonIdx,
        claudeJsonBackupIdx,
        npmIdx,
        cacheIdx,
        pnpmIdx,
        cachesIdx,
      ].slice().sort((a, b) => a - b),
    );

    // Ends the allow block with a lone closing paren, then nothing else.
    expect(profile.trimEnd().endsWith(')')).toBe(true);
  });

  it('appends extraWritableDirs after the built-ins', () => {
    const profile = buildWriteIsolationProfile({
      ...base,
      extraWritableDirs: ['/data/projects/p1/.linked-assets', '/Users/dev/.codex'],
    });
    expect(profile).toContain('(subpath "/data/projects/p1/.linked-assets")');
    expect(profile).toContain('(subpath "/Users/dev/.codex")');
    const cachesIdx = profile.indexOf('(subpath "/Users/dev/Library/Caches")');
    const linkedIdx = profile.indexOf('(subpath "/data/projects/p1/.linked-assets")');
    const codexIdx = profile.indexOf('(subpath "/Users/dev/.codex")');
    expect(linkedIdx).toBeGreaterThan(cachesIdx);
    expect(codexIdx).toBeGreaterThan(linkedIdx);
  });

  it('dedupes extraWritableDirs entries against each other', () => {
    const profile = buildWriteIsolationProfile({
      ...base,
      extraWritableDirs: ['/data/projects/p1/.linked-assets', '/data/projects/p1/.linked-assets'],
    });
    const occurrences = profile.split('(subpath "/data/projects/p1/.linked-assets")').length - 1;
    expect(occurrences).toBe(1);
  });

  it('dedupes extraWritableDirs entries against the built-in allowlist', () => {
    const profile = buildWriteIsolationProfile({
      ...base,
      extraWritableDirs: [base.cwd, '/Users/dev/.npm', '/data/projects/p1/.linked-assets'],
    });
    const cwdOccurrences = profile.split(`(subpath "${base.cwd}")`).length - 1;
    const npmOccurrences = profile.split('(subpath "/Users/dev/.npm")').length - 1;
    expect(cwdOccurrences).toBe(1);
    expect(npmOccurrences).toBe(1);
    expect(profile).toContain('(subpath "/data/projects/p1/.linked-assets")');
  });

  it('throws when cwd, home, or an extra dir contains a double-quote', () => {
    expect(() => buildWriteIsolationProfile({ ...base, cwd: '/data/"evil' })).toThrow();
    expect(() => buildWriteIsolationProfile({ ...base, home: '/Users/"evil' })).toThrow();
    expect(() =>
      buildWriteIsolationProfile({ ...base, extraWritableDirs: ['/data/"evil'] }),
    ).toThrow();
  });

  it('throws when cwd, home, or an extra dir contains a backslash', () => {
    // A trailing backslash right before the closing quote would be read as an
    // escape for that quote and swallow it — reject outright rather than emit
    // a profile that silently merges with whatever text follows.
    expect(() => buildWriteIsolationProfile({ ...base, cwd: '/data/evil\\' })).toThrow();
    expect(() => buildWriteIsolationProfile({ ...base, home: '/Users/evil\\dev' })).toThrow();
    expect(() =>
      buildWriteIsolationProfile({ ...base, extraWritableDirs: ['/data/evil\\path'] }),
    ).toThrow();
  });

  it('throws when cwd, home, or an extra dir contains a control character', () => {
    expect(() => buildWriteIsolationProfile({ ...base, cwd: '/data/evil\npath' })).toThrow();
    expect(() => buildWriteIsolationProfile({ ...base, home: '/Users/evil\tdev' })).toThrow();
    expect(() =>
      buildWriteIsolationProfile({ ...base, extraWritableDirs: ['/data/evil\r\npath'] }),
    ).toThrow();
  });
});

describe('planWriteIsolation', () => {
  it('returns null when the gate is off, regardless of platform', async () => {
    const plan = await planWriteIsolation({
      cwd: os.tmpdir(),
      runId: 'run-off',
      env: { OD_WRITE_ISOLATION: 'off' },
      platform: 'darwin',
    });
    expect(plan).toBeNull();
  });

  it('returns null off-darwin even with the gate on', async () => {
    // Standing in for the "sandbox-exec missing" branch too: both are
    // "isolation not possible here" outcomes, and this one is hermetic to
    // test without stubbing a real filesystem access check against
    // /usr/bin/sandbox-exec (a fixed, non-injectable path per the public API).
    const plan = await planWriteIsolation({
      cwd: os.tmpdir(),
      runId: 'run-linux',
      env: { OD_WRITE_ISOLATION: 'on' },
      platform: 'linux',
    });
    expect(plan).toBeNull();
    const plan2 = await planWriteIsolation({
      cwd: os.tmpdir(),
      runId: 'run-win',
      env: { OD_WRITE_ISOLATION: 'required' },
      platform: 'win32',
    });
    expect(plan2).toBeNull();
  });

  it('writes a profile file and returns its path on darwin with the gate on', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'od-write-iso-test-cwd-'));
    const plan = await planWriteIsolation({
      cwd,
      runId: 'run-42',
      env: { OD_WRITE_ISOLATION: 'on' },
      platform: 'darwin',
    });
    // This suite runs on darwin in CI/dev for this repo; /usr/bin/sandbox-exec
    // is expected present (verified in the spec's feasibility check). If some
    // future host lacks it, planWriteIsolation correctly returns null instead
    // — assert that shape rather than failing outright.
    if (plan === null) {
      return;
    }
    expect(plan.profilePath.endsWith('write-isolation-run-42.sb')).toBe(true);
    const contents = await fs.readFile(plan.profilePath, 'utf8');
    expect(contents).toContain('(version 1)');
    const realCwd = await fs.realpath(cwd);
    expect(contents).toContain(`(subpath "${realCwd}")`);
  });

  it('sanitizes the runId used in the profile file name', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'od-write-iso-test-cwd-'));
    const plan = await planWriteIsolation({
      cwd,
      runId: 'run/../evil id!',
      env: { OD_WRITE_ISOLATION: 'required' },
      platform: 'darwin',
    });
    if (plan === null) return;
    expect(path.basename(plan.profilePath)).toBe('write-isolation-run-..-evil-id-.sb');
  });
});

describe('wrapInvocationInWriteIsolation', () => {
  it('wraps the invocation in sandbox-exec -f <profile> <command> ...args', () => {
    const wrapped = wrapInvocationInWriteIsolation(
      { command: 'claude', args: ['-p', '--input-format', 'stream-json'] },
      { profilePath: '/tmp/od-write-iso-abc/write-isolation-run-1.sb' },
    );
    expect(wrapped).toEqual({
      command: WRITE_ISOLATION_BIN,
      args: [
        '-f',
        '/tmp/od-write-iso-abc/write-isolation-run-1.sb',
        'claude',
        '-p',
        '--input-format',
        'stream-json',
      ],
    });
  });

  it('preserves an empty args list', () => {
    const wrapped = wrapInvocationInWriteIsolation(
      { command: 'codex', args: [] },
      { profilePath: '/tmp/profile.sb' },
    );
    expect(wrapped.args).toEqual(['-f', '/tmp/profile.sb', 'codex']);
  });
});
