// Host-runtime silent auto-update — pure/testable helpers backing
// GET /api/update/status and POST /api/update/apply in server.ts.
//
// server.ts itself is `@ts-nocheck`, so the parts worth type-checking and
// unit-testing in isolation (semver compare, OD_HOME derivation, the
// on-disk "just updated" marker's read/expire lifecycle) live here as a
// real TypeScript module instead. server.ts only wires these into the two
// routes and owns the GitHub-fetch caching (mirrors the existing
// `readOpenDesignLatestReleaseInfo` pattern there) and the spawn of
// `deploy/host/install.sh --update`.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface UpdateMarker {
  version: string;
  at: number;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parseVersion(input: string): ParsedVersion | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(cleaned);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Semver-ish compare: returns 1 if `a` > `b`, -1 if `a` < `b`, 0 if equal
 * (or both unparseable). A release (no prerelease suffix) outranks any
 * prerelease of the same major.minor.patch. An unparseable version never
 * wins — it sorts as lower than any parseable one, so a malformed
 * `latestVersion` from a flaky GitHub response can never look "newer" than
 * the currently running version and trigger a spurious update.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return pa.prerelease > pb.prerelease ? 1 : pa.prerelease < pb.prerelease ? -1 : 0;
}

/**
 * GitHub release `tag_name` values for this repo come in two shapes
 * depending on what triggered the workflow (see
 * `.github/workflows/release-host-runtime.yml`'s "Resolve release tag"
 * step): a real tag push publishes as `v<version>`, a branch push
 * publishes as `host-runtime-v<version>`. Grab the trailing semver
 * regardless of prefix so both shapes compare correctly.
 */
export function extractSemverFromTag(tagName: string): string | null {
  if (typeof tagName !== 'string') return null;
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(tagName.trim());
  return match?.[1] ?? null;
}

/**
 * The daemon receives `OD_RESOURCE_ROOT=<OD_HOME>/current/resources/open-design`
 * (written by `install.sh`'s `write_config_env`) but never `OD_HOME`
 * itself. Strip the three known trailing segments to recover it — see
 * `resolveDaemonResourceRoot` in server.ts for where the raw env value is
 * read and validated.
 */
export function deriveOdHomeFromResourceRoot(resourceRoot: string | null | undefined): string | null {
  if (typeof resourceRoot !== 'string' || resourceRoot.trim().length === 0) return null;
  const odHome = dirname(dirname(dirname(resourceRoot)));
  return odHome.length > 0 && odHome !== '.' ? odHome : null;
}

export const UPDATE_MARKER_FILENAME = 'update-marker.json';

// Generous relative to install.sh's own ~60s health-check-with-rollback
// window (see HEALTH_TIMEOUT in deploy/host/install.sh) — covers a slow
// machine without holding a stale/failed marker around indefinitely.
export const UPDATE_MARKER_EXPIRY_MS = 10 * 60 * 1000;

export function updateMarkerPath(dataDir: string): string {
  return join(dataDir, UPDATE_MARKER_FILENAME);
}

/**
 * Written by POST /api/update/apply BEFORE spawning `install.sh --update`,
 * to the daemon's PERSISTENT data directory — NOT the versioned
 * `releases/<version>` tree, which gets abandoned by the update itself.
 * Must land on disk before the child spawns since the daemon process
 * writing it is killed partway through the script's own restart step.
 */
export async function writeUpdateMarker(
  dataDir: string,
  version: string,
  at: number = Date.now(),
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const marker: UpdateMarker = { version, at };
  await writeFile(updateMarkerPath(dataDir), JSON.stringify(marker), 'utf8');
}

export async function clearUpdateMarker(dataDir: string): Promise<void> {
  await rm(updateMarkerPath(dataDir), { force: true }).catch(() => {});
}

export async function readUpdateMarkerRaw(dataDir: string): Promise<UpdateMarker | null> {
  try {
    const raw = await readFile(updateMarkerPath(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed
      && typeof parsed === 'object'
      && typeof (parsed as Record<string, unknown>).version === 'string'
      && typeof (parsed as Record<string, unknown>).at === 'number'
    ) {
      return {
        version: (parsed as Record<string, unknown>).version as string,
        at: (parsed as Record<string, unknown>).at as number,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Backing logic for GET /api/update/status's `justUpdated` field.
 *
 * Only reports (and only clears) the marker when `marker.version` matches
 * the CURRENTLY RUNNING version — i.e. the restart actually landed on the
 * version the marker targeted. If `install.sh --update`'s own health check
 * rolled back to the old version, the marker's target version never
 * matches `currentVersion`, so this deliberately stays silent (no false
 * "updated!" toast for an update that failed) and leaves the marker in
 * place for a later poll to re-check, until it eventually ages out past
 * `UPDATE_MARKER_EXPIRY_MS` and gets swept.
 *
 * On a genuine match the marker is deleted before returning so the toast
 * fires exactly once — across every browser tab polling this endpoint,
 * not just the current one.
 */
export async function resolveJustUpdated(
  dataDir: string,
  currentVersion: string,
  now: number = Date.now(),
): Promise<UpdateMarker | null> {
  const marker = await readUpdateMarkerRaw(dataDir);
  if (!marker) return null;

  if (now - marker.at > UPDATE_MARKER_EXPIRY_MS) {
    await clearUpdateMarker(dataDir);
    return null;
  }

  if (marker.version !== currentVersion) {
    return null;
  }

  await clearUpdateMarker(dataDir);
  return marker;
}
