/**
 * URL router coverage for the Pipelines drill-down (App → Feature → Pipeline
 * → Chạy).
 *
 * The drill-down uses a literal `app/` path segment
 * (`/pipelines/app/:appId[/:featureId[/:pipelineId]]`) to keep it distinct
 * from the pre-existing Quick result deep link
 * (`/pipelines/:projectId/result/:pipelineId`), which notifications in the
 * wild already point at. `parseRoute` checks the `result` branch FIRST, so a
 * project literally named `app` must still resolve to `pipeline-result`, not
 * the drill-down — that's the one collision case where the two branches'
 * shapes actually overlap.
 */

import { describe, expect, it } from 'vitest';

import { buildPath, parseRoute, type Route } from '../src/router';

function roundTrip(route: Route): Route {
  return parseRoute(buildPath(route));
}

describe('router /pipelines drill-down', () => {
  it('parses /pipelines/app/:appId as the app-level route', () => {
    expect(parseRoute('/pipelines/app/app-1')).toEqual({
      kind: 'pipelines-app',
      appId: 'app-1',
    });
  });

  it('parses /pipelines/app/:appId/:featureId as the feature-level route', () => {
    expect(parseRoute('/pipelines/app/app-1/feat-1')).toEqual({
      kind: 'pipelines-feature',
      appId: 'app-1',
      featureId: 'feat-1',
    });
  });

  it('parses /pipelines/app/:appId/:featureId/:pipelineId as the run-level route', () => {
    expect(parseRoute('/pipelines/app/app-1/feat-1/ui-html')).toEqual({
      kind: 'pipelines-run',
      appId: 'app-1',
      featureId: 'feat-1',
      pipelineId: 'ui-html',
    });
  });

  it('round-trips all three drill-down levels through buildPath', () => {
    const routes: Route[] = [
      { kind: 'pipelines-app', appId: 'app-1' },
      { kind: 'pipelines-feature', appId: 'app-1', featureId: 'feat-1' },
      { kind: 'pipelines-run', appId: 'app-1', featureId: 'feat-1', pipelineId: 'ui-html' },
    ];
    for (const route of routes) {
      expect(roundTrip(route)).toEqual(route);
    }
  });

  it('still parses the legacy Quick result deep link as pipeline-result (notification links in the wild)', () => {
    expect(parseRoute('/pipelines/proj-1/result/ui-html')).toEqual({
      kind: 'pipeline-result',
      projectId: 'proj-1',
      pipelineId: 'ui-html',
    });
  });

  it('resolves the result route even when the project id is literally "app" (the one shape collision with the drill-down)', () => {
    // /pipelines/app/result/x matches BOTH the result branch's shape
    // (parts[1]='app', parts[2]='result', parts[3]='x') and, if checked
    // first, could be misread as drill-down (parts[1]==='app'). The result
    // branch is checked first in parseRoute, so it must win.
    expect(parseRoute('/pipelines/app/result/x')).toEqual({
      kind: 'pipeline-result',
      projectId: 'app',
      pipelineId: 'x',
    });
  });

  it('round-trips the Quick result route through buildPath', () => {
    const route: Route = { kind: 'pipeline-result', projectId: 'proj-1', pipelineId: 'ui-html' };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/pipelines/proj-1/result/ui-html');
  });

  it('survives ids with spaces, slashes, and unicode through a buildPath round-trip', () => {
    const routes: Route[] = [
      { kind: 'pipelines-app', appId: 'app one/two ăâê' },
      {
        kind: 'pipelines-feature',
        appId: 'app one/two ăâê',
        featureId: 'feature/slash ệ',
      },
      {
        kind: 'pipelines-run',
        appId: 'app one/two ăâê',
        featureId: 'feature/slash ệ',
        pipelineId: 'pipe line/id 日本語',
      },
      { kind: 'pipeline-result', projectId: 'proj/1 with space', pipelineId: 'pipe line/id 日本語' },
    ];
    for (const route of routes) {
      expect(roundTrip(route)).toEqual(route);
    }
  });

  it('resolves bare /pipelines to the pipelines home view', () => {
    expect(parseRoute('/pipelines')).toEqual({ kind: 'home', view: 'pipelines' });
    expect(parseRoute('/pipelines/')).toEqual({ kind: 'home', view: 'pipelines' });
  });
});
