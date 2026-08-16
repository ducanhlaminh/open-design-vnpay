import { createHash } from 'node:crypto';
import type { ProjectSyncStatusReason, ProjectSyncUserStatus } from '@open-design/contracts';
import type { ProjectSyncSnapshotFile } from './project-sync.js';

export interface ProjectSyncDigestPair { localDigest: string; originDigest: string }
export interface ProjectSyncBaselineView extends ProjectSyncDigestPair {
  lastSyncedAt: string;
  incomplete: boolean;
}

/** Stable across filesystem order and ignores transport-only size metadata. */
export function canonicalProjectSyncDigest(files: readonly ProjectSyncSnapshotFile[]): string {
  const canonical = files
    .map((file) => `${file.path}\0${file.checksum}`)
    .sort((a, b) => a.localeCompare(b))
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export function digestProjectSyncSides(local: readonly ProjectSyncSnapshotFile[], origin: readonly ProjectSyncSnapshotFile[]): ProjectSyncDigestPair {
  return { localDigest: canonicalProjectSyncDigest(local), originDigest: canonicalProjectSyncDigest(origin) };
}

export function evaluateProjectSyncStatus(
  current: ProjectSyncDigestPair,
  baseline: ProjectSyncBaselineView | null,
): { status: ProjectSyncUserStatus; reason: ProjectSyncStatusReason; lastSyncedAt?: string } {
  if (baseline?.incomplete) return { status: 'incomplete', reason: 'previous_sync_incomplete', lastSyncedAt: baseline.lastSyncedAt };
  if (current.localDigest === current.originDigest) {
    return { status: 'up_to_date', reason: 'contents_match', ...(baseline ? { lastSyncedAt: baseline.lastSyncedAt } : {}) };
  }
  if (!baseline) return { status: 'needs_review', reason: 'no_sync_baseline' };
  const localChanged = current.localDigest !== baseline.localDigest;
  const originChanged = current.originDigest !== baseline.originDigest;
  if (!localChanged && !originChanged) return { status: 'up_to_date', reason: 'contents_match', lastSyncedAt: baseline.lastSyncedAt };
  if (localChanged && !originChanged) return { status: 'not_shared', reason: 'local_changed', lastSyncedAt: baseline.lastSyncedAt };
  if (!localChanged && originChanged) return { status: 'update_available', reason: 'origin_changed', lastSyncedAt: baseline.lastSyncedAt };
  if (localChanged && originChanged) return { status: 'needs_review', reason: 'both_changed', lastSyncedAt: baseline.lastSyncedAt };
  // A legacy/corrupt baseline can contain different side digests while neither
  // side moved. Present a safe review state instead of guessing a direction.
  return { status: 'needs_review', reason: 'no_sync_baseline', lastSyncedAt: baseline.lastSyncedAt };
}
