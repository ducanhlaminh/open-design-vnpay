import { describe, expect, it } from 'vitest';

import type { ProjectSyncEntry, ProjectSyncFeaturePullBatchPlanRequest, ProjectSyncSummary } from '@open-design/contracts';
import {
  PROJECT_SYNC_FEATURE_PULL_BATCH_MAX,
  ProjectSyncFeaturePullPlanError,
  planProjectSyncFeaturePullBatch,
  type ProjectSyncFeaturePullPlanningData,
} from '../src/project-sync-feature-pull.js';

const unchanged: ProjectSyncSummary = { created: 0, unchanged: 1, changed: 0, deleted: 0 };

function entry(featureId: string, path = 'project.json'): ProjectSyncEntry {
  return {
    path: `feature/${path}`,
    kind: path === 'project.json' ? 'binding' : 'output',
    change: 'new',
    origin: { checksum: 'a'.repeat(64), size: 10 },
    resolution: 'pull',
    featureId,
  };
}

function fixture(): { request: ProjectSyncFeaturePullBatchPlanRequest; data: ProjectSyncFeaturePullPlanningData } {
  return {
    request: {
      localAppId: 'local-app',
      originAppId: 'shared-app',
      originFeatureIds: ['shared-checkout', 'shared-search'],
    },
    data: {
      localApp: { localId: 'local-app', originAppId: 'shared-app' },
      originApp: { originId: 'shared-app', visibility: 'visible' },
      localFeatures: [{ localId: 'shared-checkout', originId: null }],
      originFeatures: [
        {
          originId: 'shared-checkout',
          originAppId: 'shared-app',
          name: 'Checkout',
          summary: unchanged,
          entries: [entry('shared-checkout'), entry('shared-checkout', 'output.md')],
        },
        {
          originId: 'shared-search',
          originAppId: 'shared-app',
          name: 'Search',
          summary: { created: 2, unchanged: 0, changed: 0, deleted: 0 },
          entries: [entry('shared-search')],
        },
      ],
    },
  };
}

function expectCode(run: () => unknown, code: ProjectSyncFeaturePullPlanError['code']): void {
  try {
    run();
    throw new Error('Expected planner to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectSyncFeaturePullPlanError);
    expect((error as ProjectSyncFeaturePullPlanError).code).toBe(code);
  }
}

describe('project sync Feature batch planner', () => {
  it('creates an immutable plan and allocates collision-safe deterministic local ids', () => {
    const { request, data } = fixture();
    const before = structuredClone(data);
    const now = () => new Date('2026-08-16T01:02:03.000Z');
    const plan = planProjectSyncFeaturePullBatch(request, data, { now });

    expect(plan).toMatchObject({
      createdAt: '2026-08-16T01:02:03.000Z',
      localAppId: 'local-app',
      originAppId: 'shared-app',
      totalItems: 3,
    });
    expect(plan.features).toEqual([
      expect.objectContaining({ originId: 'shared-checkout', localId: 'shared-checkout--2', mode: 'create' }),
      expect.objectContaining({ originId: 'shared-search', localId: 'shared-search', mode: 'create' }),
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.features[0]!.entries)).toBe(true);
    expect(data).toEqual(before);
    expect(planProjectSyncFeaturePullBatch(request, data, { now }).planId).toBe(plan.planId);
  });

  it('reuses an existing Feature mapped to the selected origin', () => {
    const { request, data } = fixture();
    data.localFeatures = [{ localId: 'checkout-local', originId: 'shared-checkout' }];
    request.originFeatureIds = ['shared-checkout'];

    const plan = planProjectSyncFeaturePullBatch(request, data);
    expect(plan.features).toEqual([
      expect.objectContaining({ originId: 'shared-checkout', localId: 'checkout-local', mode: 'update' }),
    ]);
  });

  it('rejects empty, duplicate, unsafe, and oversized selections', () => {
    const { request, data } = fixture();
    expectCode(
      () => planProjectSyncFeaturePullBatch({ ...request, originFeatureIds: [] }, data),
      'FEATURE_PULL_INVALID_REQUEST',
    );
    expectCode(
      () => planProjectSyncFeaturePullBatch({ ...request, originFeatureIds: ['a', 'a'] }, data),
      'FEATURE_PULL_INVALID_REQUEST',
    );
    expectCode(
      () => planProjectSyncFeaturePullBatch({ ...request, originFeatureIds: ['../escape'] }, data),
      'FEATURE_PULL_INVALID_REQUEST',
    );
    expectCode(
      () => planProjectSyncFeaturePullBatch({ ...request, originFeatureIds: Array.from({ length: PROJECT_SYNC_FEATURE_PULL_BATCH_MAX + 1 }, (_, index) => `f-${index}`) }, data),
      'FEATURE_PULL_INVALID_REQUEST',
    );
  });

  it('requires the local App mapping and a visible matching origin App', () => {
    const { request, data } = fixture();
    expectCode(
      () => planProjectSyncFeaturePullBatch(request, { ...data, localApp: null }),
      'FEATURE_PULL_LOCAL_APP_NOT_FOUND',
    );
    expectCode(
      () => planProjectSyncFeaturePullBatch(request, { ...data, originApp: { originId: 'shared-app', visibility: 'hidden' } }),
      'FEATURE_PULL_ORIGIN_APP_NOT_FOUND',
    );
    expectCode(
      () => planProjectSyncFeaturePullBatch(request, { ...data, localApp: { localId: 'local-app', originAppId: 'another-app' } }),
      'FEATURE_PULL_APP_MAPPING_MISMATCH',
    );
  });

  it('rejects a missing Feature, a wrong parent, and ambiguous local mappings', () => {
    const { request, data } = fixture();
    expectCode(
      () => planProjectSyncFeaturePullBatch({ ...request, originFeatureIds: ['missing'] }, data),
      'FEATURE_PULL_ORIGIN_FEATURE_NOT_FOUND',
    );
    expectCode(
      () => planProjectSyncFeaturePullBatch(request, {
        ...data,
        originFeatures: data.originFeatures.map((feature) => feature.originId === 'shared-checkout'
          ? { ...feature, originAppId: 'wrong-app' }
          : feature),
      }),
      'FEATURE_PULL_FEATURE_PARENT_MISMATCH',
    );
    expectCode(
      () => planProjectSyncFeaturePullBatch(request, {
        ...data,
        localFeatures: [
          { localId: 'checkout-a', originId: 'shared-checkout' },
          { localId: 'checkout-b', originId: 'shared-checkout' },
        ],
      }),
      'FEATURE_PULL_LOCAL_MAPPING_COLLISION',
    );
  });

  it('allocates collision suffixes independently of request selection order', () => {
    const { request, data } = fixture();
    data.originFeatures = [
      { ...data.originFeatures[0]!, originId: 'Feature A' },
      { ...data.originFeatures[1]!, originId: 'Feature-A' },
    ];
    const first = planProjectSyncFeaturePullBatch(
      { ...request, originFeatureIds: ['Feature A', 'Feature-A'] },
      data,
      { now: () => new Date(0) },
    );
    const second = planProjectSyncFeaturePullBatch(
      { ...request, originFeatureIds: ['Feature-A', 'Feature A'] },
      data,
      { now: () => new Date(0) },
    );
    const map = (plan: typeof first) => Object.fromEntries(plan.features.map((feature) => [feature.originId, feature.localId]));
    expect(map(first)).toEqual(map(second));
    expect(new Set(Object.values(map(first))).size).toBe(2);
  });
});
