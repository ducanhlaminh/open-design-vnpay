import { describe, expect, it } from 'vitest';

import {
  ProjectSyncOperationStore,
  ProjectSyncOperationTransitionError,
} from '../src/project-sync-operation-store.js';

const result = {
  planId: 'plan-a',
  applied: 3,
  skipped: 0,
  unchanged: 0,
  softHiddenOriginFeatureIds: [],
  stale: [],
};

describe('ProjectSyncOperationStore', () => {
  it('tracks fixed-total monotonic progress through ordered phases', () => {
    let now = 0;
    const store = new ProjectSyncOperationStore(1_000, () => now, () => 'operation-a');
    expect(store.create({ planId: 'plan-a', totalItems: 3 })).toMatchObject({
      operationId: 'operation-a', state: 'queued', phase: 'validating',
      progress: { completedItems: 0, totalItems: 3, percent: 0 },
    });
    now = 10;
    expect(store.update('operation-a', { phase: 'transferring', completedItems: 1, currentFeatureId: 'feature-a' })).toMatchObject({
      state: 'running', phase: 'transferring',
      progress: { completedItems: 1, totalItems: 3, percent: 33, currentFeatureId: 'feature-a' },
    });
    expect(() => store.update('operation-a', { phase: 'validating', completedItems: 2 })).toThrow(ProjectSyncOperationTransitionError);
    expect(() => store.update('operation-a', { phase: 'transferring', completedItems: 0 })).toThrow('cannot decrease');
    expect(() => store.update('operation-a', { phase: 'finalizing', completedItems: 4 })).toThrow('cannot exceed');
  });

  it('retains an immutable idempotent success result until expiry', () => {
    let now = 0;
    const store = new ProjectSyncOperationStore(100, () => now, () => 'operation-a');
    store.create({ planId: 'plan-a', totalItems: 3 });
    const completed = store.succeed('operation-a', result)!;
    expect(completed).toMatchObject({ state: 'succeeded', phase: 'finalizing', progress: { completedItems: 3, totalItems: 3, percent: 100 }, result });

    completed.result!.stale.push({ path: 'caller-mutation', reason: 'must not leak' });
    expect(store.fail('operation-a', { code: 'LATE_ERROR', message: 'ignored', retryable: false })).toEqual(store.get('operation-a'));
    expect(store.get('operation-a')?.result?.stale).toEqual([]);

    now = 100;
    expect(store.get('operation-a')).toBeNull();
  });

  it('retains the first terminal failure and supports zero-item operations', () => {
    const store = new ProjectSyncOperationStore(100, () => 0, () => 'operation-a');
    expect(store.create({ planId: 'plan-a', totalItems: 0 }).progress.percent).toBe(100);
    const failure = store.fail('operation-a', { code: 'TRANSFER_FAILED', message: 'network unavailable', retryable: true });
    expect(failure).toMatchObject({ state: 'failed', error: { code: 'TRANSFER_FAILED', retryable: true } });
    expect(store.succeed('operation-a', result)).toEqual(failure);
  });

  it('rejects invalid counts and id collisions', () => {
    const store = new ProjectSyncOperationStore(100, () => 0, () => 'same-id');
    expect(() => store.create({ planId: '', totalItems: 1 })).toThrow('planId');
    expect(() => store.create({ planId: 'plan-a', totalItems: -1 })).toThrow(RangeError);
    store.create({ planId: 'plan-a', totalItems: 1 });
    expect(() => store.succeed('same-id', { ...result, planId: 'another-plan' })).toThrow('planId');
    expect(() => store.create({ planId: 'plan-b', totalItems: 1 })).toThrow('Duplicate');
  });
});
