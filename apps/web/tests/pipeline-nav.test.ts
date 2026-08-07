/**
 * Coverage for the pure grouping/progress helpers behind the Pipelines
 * drill-down (App → Feature → Pipeline). All three drill-down screens ask
 * "which apps, which features, how far along" through this single module so
 * they can't disagree with each other on progress counts — see the module
 * docblock in `usePipelineNav.ts`.
 *
 * Only the pure exports (`groupByApp`, `isFeatureDone`, `appIdOf`) are
 * tested here. `usePipelineNav` itself does network I/O and is out of scope.
 */

import { describe, expect, it } from 'vitest';
import type { PipelineProject } from '@open-design/contracts';

import { UNASSIGNED_APP } from '../src/router';
import { appIdOf, groupByApp, isFeatureDone } from '../src/components/pipelines/usePipelineNav';

function feature(overrides: Partial<PipelineProject> & { id: string; name: string }): PipelineProject {
  return {
    done: 0,
    total: 3,
    running: 0,
    ...overrides,
  };
}

describe('groupByApp', () => {
  it('groups each feature under p.app.id', () => {
    const projects = [
      feature({ id: 'f-1', name: 'Feature One', app: { id: 'app-1', name: 'App One' } }),
    ];
    const apps = groupByApp(projects, []);
    expect(apps).toHaveLength(1);
    expect(apps[0]!.id).toBe('app-1');
    expect(apps[0]!.features.map((f) => f.id)).toEqual(['f-1']);
  });

  it('buckets features with no app under UNASSIGNED_APP', () => {
    const projects = [feature({ id: 'f-1', name: 'Orphan feature' })];
    const apps = groupByApp(projects, []);
    expect(apps).toHaveLength(1);
    expect(apps[0]!.id).toBe(UNASSIGNED_APP);
    expect(apps[0]!.unassigned).toBe(true);
    expect(apps[0]!.features.map((f) => f.id)).toEqual(['f-1']);
  });

  it('keeps an app from knownApps visible even with zero features (a just-created app must not vanish)', () => {
    const apps = groupByApp([], [{ id: 'app-empty', name: 'Freshly Created App' }]);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ id: 'app-empty', name: 'Freshly Created App', features: [] });
  });

  it('sorts the unassigned bucket last regardless of name, ahead of any alphabetical position', () => {
    const projects = [
      feature({ id: 'f-a', name: 'A', app: { id: 'app-aaa', name: 'AAA' } }),
      feature({ id: 'f-z', name: 'Z', app: { id: 'app-zzz', name: 'ZZZ' } }),
      feature({ id: 'f-orphan', name: 'Orphan' }),
    ];
    const apps = groupByApp(projects, []);
    expect(apps.map((a) => a.id)).toEqual(['app-aaa', 'app-zzz', UNASSIGNED_APP]);
  });

  it('sorts other apps by name (independent of insertion order)', () => {
    const projects = [
      feature({ id: 'f-1', name: 'F1', app: { id: 'app-b', name: 'Bravo' } }),
      feature({ id: 'f-2', name: 'F2', app: { id: 'app-a', name: 'Alpha' } }),
    ];
    const apps = groupByApp(projects, []);
    expect(apps.map((a) => a.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('sorts features inside an app by name', () => {
    const projects = [
      feature({ id: 'f-z', name: 'Zulu', app: { id: 'app-1', name: 'App One' } }),
      feature({ id: 'f-a', name: 'Alpha', app: { id: 'app-1', name: 'App One' } }),
    ];
    const apps = groupByApp(projects, []);
    expect(apps[0]!.features.map((f) => f.name)).toEqual(['Alpha', 'Zulu']);
  });

  it('counts doneFeatures and runningFeatures correctly', () => {
    const projects = [
      feature({ id: 'f-done', name: 'Done', done: 3, total: 3, running: 0, app: { id: 'app-1' } }),
      feature({ id: 'f-running', name: 'Running', done: 1, total: 3, running: 1, app: { id: 'app-1' } }),
      feature({ id: 'f-idle', name: 'Idle', done: 0, total: 3, running: 0, app: { id: 'app-1' } }),
    ];
    const apps = groupByApp(projects, []);
    expect(apps[0]!.doneFeatures).toBe(1);
    expect(apps[0]!.runningFeatures).toBe(1);
  });

  it('names the app from knownApps when the feature\'s own app.name is stale or absent', () => {
    const projects = [feature({ id: 'f-1', name: 'F1', app: { id: 'app-1' } })];
    const apps = groupByApp(projects, [{ id: 'app-1', name: 'Real App Name' }]);
    expect(apps[0]!.name).toBe('Real App Name');
  });
});

describe('isFeatureDone', () => {
  it('is true when done reaches total (total > 0)', () => {
    expect(isFeatureDone({ done: 3, total: 3 })).toBe(true);
    expect(isFeatureDone({ done: 4, total: 3 })).toBe(true);
  });

  it('is false when done is below total', () => {
    expect(isFeatureDone({ done: 2, total: 3 })).toBe(false);
  });

  it('treats total === 0 as NOT done, even though done >= total trivially holds (an API failure must not render as 100%)', () => {
    expect(isFeatureDone({ done: 0, total: 0 })).toBe(false);
  });
});

describe('appIdOf', () => {
  it('falls back to UNASSIGNED_APP when app is absent or its id is blank', () => {
    expect(appIdOf(feature({ id: 'f-1', name: 'F1' }))).toBe(UNASSIGNED_APP);
    expect(appIdOf(feature({ id: 'f-2', name: 'F2', app: { id: '   ' } }))).toBe(UNASSIGNED_APP);
  });

  it('returns the trimmed app id when present', () => {
    expect(appIdOf(feature({ id: 'f-3', name: 'F3', app: { id: ' app-1 ' } }))).toBe('app-1');
  });
});
