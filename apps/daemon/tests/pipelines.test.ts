import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PipelineView, ProjectPipelineState } from '@open-design/contracts';

import {
  PIPELINE_DEFS,
  computeActive,
  deriveStateFromKgsFiles,
  deriveStateFromLocalFiles,
  getPipelineDef,
  listPipelineStatus,
  mergePipelineState,
  stagesForOutput,
  workflowDirForPipeline,
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

test('workflowDirForPipeline maps each pipeline to its workflow folder', () => {
  assert.equal(workflowDirForPipeline('jira-ingest'), 'docs-to-ui');
  assert.equal(workflowDirForPipeline('ui'), 'docs-to-ui');
  assert.equal(workflowDirForPipeline('html-docs'), 'docs-to-html');
  assert.equal(workflowDirForPipeline('ui-html'), 'docs-to-html');
  assert.equal(workflowDirForPipeline('nope'), null);
});

test('stagesForOutput: workflow-namespaced files attribute to that workflow ONLY (isolation)', () => {
  // docs-to-html files light up ONLY docs-to-html stages — the shared output
  // patterns no longer bleed into docs-to-ui's stepper.
  assert.deepEqual(stagesForOutput('docs-to-html/docs/confluence/x.md').map((d) => d.id), ['html-docs']);
  assert.deepEqual(stagesForOutput('docs-to-html/app-ux-spec.json').map((d) => d.id), ['html-ux']);
  assert.deepEqual(stagesForOutput('docs-to-html/app-journey.json').map((d) => d.id), ['html-cj']);
  assert.deepEqual(stagesForOutput('docs-to-html/prototype/index.html').map((d) => d.id), ['ui-html']);
  // docs-to-ui files light up ONLY docs-to-ui stages.
  assert.deepEqual(stagesForOutput('docs-to-ui/docs/confluence/x.md').map((d) => d.id), ['jira-ingest']);
  assert.deepEqual(stagesForOutput('docs-to-ui/app-ux-spec.json').map((d) => d.id), ['ux-spec']);
  assert.deepEqual(stagesForOutput('docs-to-ui/screens/s/screen.json').map((d) => d.id), ['ui']);
});

test('stagesForOutput: unprefixed legacy paths still match across workflows (back-compat)', () => {
  // Files produced before per-workflow folders existed have no prefix; they must
  // still derive status (matching across all stages) so old projects don't break.
  assert.deepEqual(
    stagesForOutput('docs/confluence/x.md').map((d) => d.id).sort(),
    ['html-docs', 'jira-ingest'],
  );
});

test('ui-html prototype output round-trips cross-device (not localOnly)', () => {
  // Regression: the docs-to-html deliverable (prototype/) must sync via the media
  // store. A localOnly ui-html would never reach another device on push/pull-all.
  assert.equal(getPipelineDef('ui-html')?.localOnly, undefined);
});

test('deriveStateFromLocalFiles lights up docs-to-html stages from pulled files (cross-workflow)', () => {
  // A freshly-pulled device has NO local run metadata — only the pulled output
  // files. docs-to-ui and docs-to-html share output patterns, so each file must
  // mark its owning stage in BOTH workflows. Before the fix, first-match-only
  // attribution lit only the docs-to-ui stages and left the docs-to-html stepper
  // empty ("run from scratch") even though every output was present.
  const state = deriveStateFromLocalFiles([
    'docs/confluence/_index.md', // → jira-ingest AND html-docs
    'bidv-account-freeze-journey.json', // → customer-journey AND html-cj (-journey.json)
    'bidv-account-freeze-ux-spec.json', // → ux-spec AND html-ux
    'prototype/index.html', // → ui-html
  ]);
  for (const id of ['html-docs', 'html-cj', 'html-ux', 'ui-html']) {
    assert.equal(state[id]?.status, 'succeeded', `${id} should be derived succeeded`);
  }
  // docs-to-ui stages still derive too (shared outputs belong to both workflows).
  for (const id of ['jira-ingest', 'customer-journey', 'ux-spec']) {
    assert.equal(state[id]?.status, 'succeeded', `${id} should be derived succeeded`);
  }
});

test('deriveStateFromKgsFiles re-derives owning stage(s) from file path, not the stage tag', () => {
  // The media `stage` tag is first-match-only (docs-to-ui). Deriving from PATH
  // recovers the docs-to-html stage a shared output also belongs to.
  const state = deriveStateFromKgsFiles([
    { stage: 'jira-ingest', path: 'docs/confluence/_index.md' },
    { stage: 'ux-spec', path: 'app-ux-spec.json' },
  ]);
  assert.equal(state['html-docs']?.status, 'succeeded');
  assert.equal(state['html-ux']?.status, 'succeeded');
  assert.equal(state['jira-ingest']?.status, 'succeeded');
  assert.equal(state['ux-spec']?.status, 'succeeded');
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
