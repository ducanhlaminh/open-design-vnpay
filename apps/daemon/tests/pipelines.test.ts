import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PipelineView, ProjectPipelineState } from '@open-design/contracts';

import {
  PIPELINE_DEFS,
  computeActive,
  deriveStateFromKgsFiles,
  getPipelineDef,
  listPipelineStatus,
  mergePipelineState,
} from '../src/pipelines.js';

function def(id: string) {
  const d = getPipelineDef(id);
  assert.ok(d, `pipeline ${id} should exist in the registry`);
  return d;
}

function viewOf(views: PipelineView[], id: string): PipelineView {
  const v = views.find((x) => x.id === id);
  assert.ok(v, `view ${id} should be present`);
  return v;
}

test('jira-ingest has no prerequisites and is active from an empty state', () => {
  assert.equal(computeActive({}, def('jira-ingest')), true);
});

test('feature-analysis is gated until jira-ingest has succeeded', () => {
  assert.equal(computeActive({}, def('feature-analysis')), false);
  const running: ProjectPipelineState = { 'jira-ingest': { status: 'running' } };
  assert.equal(computeActive(running, def('feature-analysis')), false);
  const done: ProjectPipelineState = { 'jira-ingest': { status: 'succeeded' } };
  assert.equal(computeActive(done, def('feature-analysis')), true);
});

test('ux-spec and customer-journey both unlock after feature-analysis succeeds', () => {
  const state: ProjectPipelineState = {
    'jira-ingest': { status: 'succeeded' },
    'feature-analysis': { status: 'succeeded' },
  };
  assert.equal(computeActive(state, def('ux-spec')), true);
  assert.equal(computeActive(state, def('customer-journey')), true);
});

test('ui requires BOTH ux-spec and customer-journey to have succeeded (join)', () => {
  const base: ProjectPipelineState = {
    'jira-ingest': { status: 'succeeded' },
    'feature-analysis': { status: 'succeeded' },
  };
  assert.equal(
    computeActive({ ...base, 'ux-spec': { status: 'succeeded' } }, def('ui')),
    false,
  );
  assert.equal(
    computeActive(
      {
        ...base,
        'ux-spec': { status: 'succeeded' },
        'customer-journey': { status: 'succeeded' },
      },
      def('ui'),
    ),
    true,
  );
});

test('listPipelineStatus returns all five in registry order with derived active + status', () => {
  const views = listPipelineStatus({ 'jira-ingest': { status: 'succeeded' } });
  assert.deepEqual(
    views.map((v) => v.id),
    PIPELINE_DEFS.map((d) => d.id),
  );
  assert.equal(viewOf(views, 'jira-ingest').status, 'succeeded');
  assert.equal(viewOf(views, 'jira-ingest').active, true);
  // feature-analysis is still idle but unlocked because jira-ingest succeeded.
  assert.equal(viewOf(views, 'feature-analysis').status, 'idle');
  assert.equal(viewOf(views, 'feature-analysis').active, true);
  // ux-spec stays locked until feature-analysis succeeds.
  assert.equal(viewOf(views, 'ux-spec').active, false);
});

test('deriveStateFromKgsFiles marks a stage succeeded when it has ≥1 KGS file', () => {
  const state = deriveStateFromKgsFiles([
    { stage: 'jira-ingest', path: 'docs/jira/A.md', status: 'ACTIVE' },
    { stage: 'jira-ingest', path: 'docs/jira/B.md', status: 'ACTIVE' },
    { stage: 'feature-analysis', path: 'features.json', status: 'CONVERTED' },
    { path: 'no-stage.txt' }, // ignored: no stage
  ]);
  assert.equal(state['jira-ingest']?.status, 'succeeded');
  assert.equal(state['feature-analysis']?.status, 'succeeded');
  assert.equal(state['ux-spec'], undefined);
});

test('mergePipelineState: KGS done is authoritative, local fills transient state', () => {
  const local: ProjectPipelineState = {
    'jira-ingest': { status: 'failed' }, // local says failed...
    'feature-analysis': { status: 'running' },
  };
  const kgs: ProjectPipelineState = {
    'jira-ingest': { status: 'succeeded' }, // ...but KGS has files → done (cross-device)
  };
  const merged = mergePipelineState(local, kgs);
  // KGS file presence wins over a stale local 'failed'.
  assert.equal(merged['jira-ingest']?.status, 'succeeded');
  // No KGS files for feature-analysis → keep this device's in-flight 'running'.
  assert.equal(merged['feature-analysis']?.status, 'running');
  // After merge, feature-analysis is active (jira-ingest done per KGS).
  assert.equal(computeActive(merged, def('feature-analysis')), true);
});

test('mergePipelineState: a local in-flight re-run (running) shows over old KGS files', () => {
  const local: ProjectPipelineState = { 'ux-spec': { status: 'running' } };
  const kgs: ProjectPipelineState = { 'ux-spec': { status: 'succeeded' } };
  const merged = mergePipelineState(local, kgs);
  assert.equal(merged['ux-spec']?.status, 'running');
});
