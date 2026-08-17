// Pure/testable helpers backing GET /api/update/status + POST
// /api/update/apply (see apps/daemon/src/update-check.ts). No server
// involved — these exercise the version-compare helper, the OD_HOME
// derivation, and the on-disk "just updated" marker's read/expire
// lifecycle directly, which is both faster and more precise than driving
// them through real HTTP.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearUpdateMarker,
  compareVersions,
  deriveOdHomeFromResourceRoot,
  extractSemverFromTag,
  isTerminalUpdateState,
  patchUpdateState,
  readUpdateState,
  readUpdateMarkerRaw,
  resolveJustUpdated,
  UPDATE_MARKER_EXPIRY_MS,
  UPDATE_MARKER_FILENAME,
  updateMarkerPath,
  UPDATE_STATE_FILENAME,
  writeUpdateState,
  writeUpdateMarker,
} from '../src/update-check.js';

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1);
    expect(compareVersions('1.1.9', '1.2.0')).toBe(-1);
    expect(compareVersions('1.1.2', '1.1.1')).toBe(1);
    expect(compareVersions('1.1.1', '1.1.2')).toBe(-1);
  });

  it('treats identical versions as equal', () => {
    expect(compareVersions('0.8.3', '0.8.3')).toBe(0);
  });

  it('tolerates a leading "v" on either side', () => {
    expect(compareVersions('v0.8.3', '0.8.3')).toBe(0);
    expect(compareVersions('v0.9.0', '0.8.3')).toBe(1);
  });

  it('ranks a release above a prerelease of the same core version', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
  });

  it('never lets an unparseable version win', () => {
    expect(compareVersions('not-a-version', '0.0.1')).toBe(-1);
    expect(compareVersions('0.0.1', 'not-a-version')).toBe(1);
    expect(compareVersions('garbage', 'also-garbage')).toBe(0);
  });
});

describe('durable update state', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'od-update-state-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('atomically persists and restores an operation', async () => {
    const state = {
      operationId: 'op-1',
      targetVersion: '1.2.3',
      state: 'preparing' as const,
      phase: null,
      error: null,
      startedAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
    };
    await writeUpdateState(dataDir, state);
    expect(await readUpdateState(dataDir)).toEqual(state);
    expect(await readdir(dataDir)).toEqual([UPDATE_STATE_FILENAME]);
  });

  it('patches only the matching operation and preserves immutable identity fields', async () => {
    await writeUpdateState(dataDir, {
      operationId: 'op-1', targetVersion: '1.2.3', state: 'preparing', phase: null, error: null,
      startedAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
    });
    expect(await patchUpdateState(dataDir, 'stale-op', { state: 'failed' })).toBeNull();
    const next = await patchUpdateState(dataDir, 'op-1', {
      state: 'installing',
      phase: { step: 3, totalSteps: 6, label: 'Install' },
      updatedAt: '2026-08-17T00:00:01.000Z',
    });
    expect(next).toMatchObject({
      operationId: 'op-1', targetVersion: '1.2.3', state: 'installing',
      phase: { step: 3, totalSteps: 6, label: 'Install' },
      startedAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:01.000Z',
    });
  });

  it('fails closed on malformed state and identifies terminal states', async () => {
    await writeFile(join(dataDir, UPDATE_STATE_FILENAME), '{broken', 'utf8');
    expect(await readUpdateState(dataDir)).toBeNull();
    expect(isTerminalUpdateState('healthy')).toBe(true);
    expect(isTerminalUpdateState('restart-required')).toBe(true);
    expect(isTerminalUpdateState('rolled-back')).toBe(true);
    expect(isTerminalUpdateState('failed')).toBe(true);
    expect(isTerminalUpdateState('restarting')).toBe(false);
  });
});

describe('extractSemverFromTag', () => {
  it('strips a plain "v" tag prefix', () => {
    expect(extractSemverFromTag('v0.8.3')).toBe('0.8.3');
  });

  it('strips the branch-push "host-runtime-v" prefix', () => {
    expect(extractSemverFromTag('host-runtime-v0.8.3')).toBe('0.8.3');
  });

  it('passes through a bare semver unchanged', () => {
    expect(extractSemverFromTag('0.8.3')).toBe('0.8.3');
  });

  it('returns null when no semver can be found', () => {
    expect(extractSemverFromTag('latest')).toBeNull();
  });
});

describe('deriveOdHomeFromResourceRoot', () => {
  it('strips open-design/resources/current to recover OD_HOME', () => {
    expect(deriveOdHomeFromResourceRoot('/Users/alice/.open-design/current/resources/open-design')).toBe(
      '/Users/alice/.open-design',
    );
  });

  it('returns null for a null/empty/undefined input', () => {
    expect(deriveOdHomeFromResourceRoot(null)).toBeNull();
    expect(deriveOdHomeFromResourceRoot(undefined)).toBeNull();
    expect(deriveOdHomeFromResourceRoot('')).toBeNull();
  });
});

describe('update marker read/write/expire lifecycle', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'od-update-marker-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('writes a marker file that readUpdateMarkerRaw can read back', async () => {
    await writeUpdateMarker(dataDir, '0.9.0', 1000);
    const marker = await readUpdateMarkerRaw(dataDir);
    expect(marker).toEqual({ version: '0.9.0', at: 1000 });
    // Confirm it lands at the documented filename, in the persistent data
    // dir passed in — not some nested/derived path.
    const raw = await readFile(join(dataDir, UPDATE_MARKER_FILENAME), 'utf8');
    expect(JSON.parse(raw)).toEqual({ version: '0.9.0', at: 1000 });
    expect(updateMarkerPath(dataDir)).toBe(join(dataDir, UPDATE_MARKER_FILENAME));
  });

  it('readUpdateMarkerRaw returns null when no marker exists', async () => {
    expect(await readUpdateMarkerRaw(dataDir)).toBeNull();
  });

  it('readUpdateMarkerRaw returns null for a corrupt/malformed marker file', async () => {
    await writeFile(join(dataDir, UPDATE_MARKER_FILENAME), '{ not json', 'utf8');
    expect(await readUpdateMarkerRaw(dataDir)).toBeNull();

    await writeFile(join(dataDir, UPDATE_MARKER_FILENAME), JSON.stringify({ version: 42 }), 'utf8');
    expect(await readUpdateMarkerRaw(dataDir)).toBeNull();
  });

  it('clearUpdateMarker removes the file and is a no-op when nothing exists', async () => {
    await writeUpdateMarker(dataDir, '0.9.0');
    await clearUpdateMarker(dataDir);
    expect(await readUpdateMarkerRaw(dataDir)).toBeNull();
    // Second call — file already gone — must not throw.
    await expect(clearUpdateMarker(dataDir)).resolves.toBeUndefined();
  });

  describe('resolveJustUpdated', () => {
    it('returns null when there is no marker', async () => {
      expect(await resolveJustUpdated(dataDir, '0.9.0')).toBeNull();
    });

    it('reports and then clears the marker once the running version matches it (the success case)', async () => {
      const now = 1_000_000;
      await writeUpdateMarker(dataDir, '0.9.0', now - 5_000);

      const first = await resolveJustUpdated(dataDir, '0.9.0', now);
      expect(first).toEqual({ version: '0.9.0', at: now - 5_000 });

      // Fires exactly once: a second poll (even moments later, from any
      // tab) must no longer see it — the marker was deleted on first read.
      const second = await resolveJustUpdated(dataDir, '0.9.0', now + 1_000);
      expect(second).toBeNull();
      expect(await readUpdateMarkerRaw(dataDir)).toBeNull();
    });

    it('stays silent (and keeps the marker) while the version has not landed yet', async () => {
      // Still on the OLD version — either the update is still mid-flight
      // (daemon hasn't restarted yet) or it failed and install.sh rolled
      // the `current` symlink back. Either way: no false "updated!" toast.
      const now = 1_000_000;
      await writeUpdateMarker(dataDir, '0.9.0', now - 1_000);

      const result = await resolveJustUpdated(dataDir, '0.8.3', now);
      expect(result).toBeNull();
      // Marker must survive so a LATER poll (after the real restart lands)
      // can still report it.
      expect(await readUpdateMarkerRaw(dataDir)).toEqual({ version: '0.9.0', at: now - 1_000 });
    });

    it('sweeps a marker that aged out past UPDATE_MARKER_EXPIRY_MS without ever matching', async () => {
      const now = 1_000_000;
      await writeUpdateMarker(dataDir, '0.9.0', now - UPDATE_MARKER_EXPIRY_MS - 1);

      const result = await resolveJustUpdated(dataDir, '0.8.3', now);
      expect(result).toBeNull();
      // Stale marker is cleaned up, not left behind forever.
      expect(await readUpdateMarkerRaw(dataDir)).toBeNull();
    });

    it('a marker exactly at the expiry boundary is still honored', async () => {
      const now = 1_000_000;
      await writeUpdateMarker(dataDir, '0.9.0', now - UPDATE_MARKER_EXPIRY_MS);

      const result = await resolveJustUpdated(dataDir, '0.9.0', now);
      expect(result).toEqual({ version: '0.9.0', at: now - UPDATE_MARKER_EXPIRY_MS });
    });
  });
});
