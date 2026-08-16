import { describe, expect, it } from 'vitest';
import { canonicalProjectSyncDigest, digestProjectSyncSides, evaluateProjectSyncStatus } from '../src/project-sync-status.js';

const file = (path: string, checksum: string) => ({ path, checksum, size: 1, kind: 'output' as const });
const digest = (checksum: string) => canonicalProjectSyncDigest([file('feature/a.md', checksum)]);
const baseline = { localDigest: digest('a'), originDigest: digest('a'), lastSyncedAt: '2026-08-16T00:00:00.000Z', incomplete: false };

describe('friendly project sync status', () => {
  it('uses a canonical order-independent digest', () => {
    expect(canonicalProjectSyncDigest([file('b', '2'), file('a', '1')]))
      .toBe(canonicalProjectSyncDigest([file('a', '1'), file('b', '2')]));
  });

  it('reports a first pull whose two sides match as up to date without a baseline', () => {
    const sides = digestProjectSyncSides([file('feature/a.md', 'a')], [file('feature/a.md', 'a')]);
    expect(evaluateProjectSyncStatus(sides, null)).toEqual({ status: 'up_to_date', reason: 'contents_match' });
  });

  it.each([
    [{ localDigest: digest('b'), originDigest: digest('a') }, 'not_shared', 'local_changed'],
    [{ localDigest: digest('a'), originDigest: digest('b') }, 'update_available', 'origin_changed'],
    [{ localDigest: digest('b'), originDigest: digest('c') }, 'needs_review', 'both_changed'],
  ] as const)('classifies changes relative to the clean baseline', (current, status, reason) => {
    expect(evaluateProjectSyncStatus(current, baseline)).toMatchObject({ status, reason });
  });

  it('keeps an interrupted pull visible until a clean retry', () => {
    expect(evaluateProjectSyncStatus(
      { localDigest: digest('a'), originDigest: digest('a') },
      { ...baseline, incomplete: true },
    )).toMatchObject({ status: 'incomplete', reason: 'previous_sync_incomplete' });
  });

  it('treats unchanged side-specific digests as up to date even when local identity rewrites differ', () => {
    const rewrittenBaseline = { ...baseline, localDigest: digest('local-app-id'), originDigest: digest('origin-app-id') };
    expect(evaluateProjectSyncStatus(
      { localDigest: rewrittenBaseline.localDigest, originDigest: rewrittenBaseline.originDigest },
      rewrittenBaseline,
    )).toMatchObject({ status: 'up_to_date', reason: 'contents_match' });
  });

  it('uses a safe review state for different legacy sides with no baseline', () => {
    expect(evaluateProjectSyncStatus({ localDigest: digest('a'), originDigest: digest('b') }, null))
      .toEqual({ status: 'needs_review', reason: 'no_sync_baseline' });
  });
});
