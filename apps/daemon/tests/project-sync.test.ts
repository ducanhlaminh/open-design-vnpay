import { describe, expect, it } from 'vitest';

import { ProjectSyncPlanStore, parseProjectSyncResolutionArgs, planProjectSync, projectSyncPlanIsFresh } from '../src/project-sync.js';
import { originIdOf } from '../src/project-sync-routes.js';

const scope = { kind: 'feature' as const, projectId: 'feature-a', appId: 'app-a' };
const origin = { mode: 'existing' as const, originId: 'feature-a' };
const file = (path: string, checksum: string) => ({ path, checksum, size: 1, kind: 'output' as const });

describe('project sync plan engine', () => {
  it('classifies directional new/unchanged/changed/deleted snapshots', () => {
    const { plan } = planProjectSync({
      direction: 'push', scope, origin,
      local: [file('new.txt', '1'), file('same.txt', '2'), file('changed.txt', '3')],
      originFiles: [file('same.txt', '2'), file('changed.txt', '4'), file('deleted.txt', '5')],
    });
    expect(plan.entries.map((entry) => [entry.path, entry.change])).toEqual([
      ['changed.txt', 'changed'], ['deleted.txt', 'deleted'], ['new.txt', 'new'], ['same.txt', 'unchanged'],
    ]);
    expect(plan.summary).toEqual({ created: 1, changed: 1, deleted: 1, unchanged: 1 });
    expect(plan.entries.find((entry) => entry.path === 'deleted.txt')?.resolution).toBe('push');
  });

  it('keeps Feature and workflow-stage ownership on every planned output', () => {
    const { plan } = planProjectSync({
      direction: 'push', scope, origin,
      local: [{ ...file('docs-to-ui/customer-journey.json', '1'), featureId: 'feature-a', stage: 'cj' }],
      originFiles: [],
    });
    expect(plan.entries[0]).toMatchObject({ featureId: 'feature-a', stage: 'cj', change: 'new' });
  });

  it('binds APPLY to an immutable two-sided snapshot and expires stale plans', () => {
    let now = 0;
    const built = planProjectSync({ direction: 'pull', scope, origin, local: [file('a', '1')], originFiles: [file('a', '2')] });
    const store = new ProjectSyncPlanStore(10, () => now);
    store.put(built);
    const stored = store.get(built.plan.planId)!;
    expect(projectSyncPlanIsFresh(stored, [file('a', '1')], [file('a', '2')])).toBe(true);
    expect(projectSyncPlanIsFresh(stored, [file('a', 'x')], [file('a', '2')])).toBe(false);
    now = 10;
    expect(store.get(built.plan.planId)).toBeNull();
  });

  it('never infers an origin from a local id, while accepting legacy mappings', () => {
    expect(originIdOf({ id: 'local-id', metadata: { studioConfig: {} } })).toBeNull();
    expect(originIdOf({ id: 'local-id', metadata: { studioConfig: { approvedMapping: { localProjectId: 'local-id', approvedProjectId: 'origin-v1', pendingId: 'p', decidedAt: 'now' } } } })).toBe('origin-v1');
    expect(originIdOf({ id: 'local-id', metadata: { studioConfig: { remoteId: 'origin-v2' } } })).toBe('origin-v2');
    expect(originIdOf({ id: 'local-id', metadata: { studioConfig: { remoteId: 'legacy', projectSyncMapping: { schemaVersion: 1, localId: 'local-id', originId: 'origin-v3', mappedAt: 'now' } } } })).toBe('origin-v3');
    expect(originIdOf({ id: 'local-id', metadata: { studioConfig: { remoteId: 'must-not-mask-invalid-v1', projectSyncMapping: null } } })).toBeNull();
    expect(originIdOf({ id: 'local-id', metadata: { studioConfig: { remoteId: 'must-not-mask-stale-v1', projectSyncMapping: { schemaVersion: 1, localId: 'another-local-id', originId: 'origin-v3', mappedAt: 'now' } } } })).toBeNull();
  });

  it('parses every CLI per-file resolution in both supported flag forms', () => {
    expect(parseProjectSyncResolutionArgs([
      '--resolution', 'docs/a.md=pull',
      '--resolution=ui/output.html=skip',
      '--resolution', 'bad-value',
    ])).toEqual({ 'docs/a.md': 'pull', 'ui/output.html': 'skip' });
  });
});
