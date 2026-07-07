import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PipelineView, ProjectPipelineState } from '@open-design/contracts';

import {
  PIPELINE_DEFS,
  computeActive,
  deriveStateFromKgsFiles,
  deriveStateFromLocalFiles,
  getPipelineDef,
  isSyncExcluded,
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

test('html-docs and react-docs have no prerequisites and are active from an empty state', () => {
  assert.equal(computeActive({}, def('html-docs')), true);
  assert.equal(computeActive({}, def('react-docs')), true);
});

test('html-cj is gated until html-docs has succeeded', () => {
  assert.equal(computeActive({}, def('html-cj')), false);
  const running: ProjectPipelineState = { 'html-docs': { status: 'running' } };
  assert.equal(computeActive(running, def('html-cj')), false);
  const done: ProjectPipelineState = { 'html-docs': { status: 'succeeded' } };
  assert.equal(computeActive(done, def('html-cj')), true);
});

test('docs-to-html is a linear chain gated at each step (html-docs → html-cj → html-ux → ui-html)', () => {
  const s: ProjectPipelineState = {
    'html-docs': { status: 'succeeded' },
    'html-cj': { status: 'succeeded' },
  };
  assert.equal(computeActive(s, def('html-ux')), true);
  assert.equal(computeActive(s, def('ui-html')), false);
  assert.equal(computeActive({ ...s, 'html-ux': { status: 'succeeded' } }, def('ui-html')), true);
});

test('listPipelineStatus returns every stage in registry order with derived active + status', () => {
  const views = listPipelineStatus({ 'html-docs': { status: 'succeeded' } });
  assert.deepEqual(
    views.map((v) => v.id),
    PIPELINE_DEFS.map((d) => d.id),
  );
  assert.equal(viewOf(views, 'html-docs').status, 'succeeded');
  assert.equal(viewOf(views, 'html-docs').active, true);
  // html-cj is still idle but unlocked because html-docs succeeded.
  assert.equal(viewOf(views, 'html-cj').status, 'idle');
  assert.equal(viewOf(views, 'html-cj').active, true);
  // html-ux stays locked until html-cj succeeds.
  assert.equal(viewOf(views, 'html-ux').active, false);
});

test('deriveStateFromKgsFiles marks a stage succeeded when it has ≥1 KGS file', () => {
  const state = deriveStateFromKgsFiles([
    { stage: 'html-docs', path: 'docs-to-html/docs/jira/A.md', status: 'ACTIVE' },
    { stage: 'html-docs', path: 'docs-to-html/docs/jira/B.md', status: 'ACTIVE' },
    { stage: 'html-cj', path: 'docs-to-html/app-cj.json', status: 'ACTIVE' },
    { path: 'no-stage.txt' }, // ignored: matches no stage output
  ]);
  assert.equal(state['html-docs']?.status, 'succeeded');
  assert.equal(state['html-cj']?.status, 'succeeded');
  assert.equal(state['html-ux'], undefined);
});

test('workflowDirForPipeline maps each pipeline to its workflow folder', () => {
  assert.equal(workflowDirForPipeline('html-docs'), 'docs-to-html');
  assert.equal(workflowDirForPipeline('ui-html'), 'docs-to-html');
  assert.equal(workflowDirForPipeline('react-docs'), 'docs-to-react');
  assert.equal(workflowDirForPipeline('ui-react'), 'docs-to-react');
  // Removed docs-to-ui workflow ids resolve to nothing.
  assert.equal(workflowDirForPipeline('jira-ingest'), null);
  assert.equal(workflowDirForPipeline('nope'), null);
});

test('stagesForOutput: workflow-namespaced files attribute to that workflow ONLY (isolation)', () => {
  // docs-to-html files light up ONLY docs-to-html stages.
  assert.deepEqual(stagesForOutput('docs-to-html/docs/confluence/x.md').map((d) => d.id), ['html-docs']);
  assert.deepEqual(stagesForOutput('docs-to-html/app-ux-spec.json').map((d) => d.id), ['html-ux']);
  assert.deepEqual(stagesForOutput('docs-to-html/app-journey.json').map((d) => d.id), ['html-cj']);
  assert.deepEqual(stagesForOutput('docs-to-html/prototype/index.html').map((d) => d.id), ['ui-html']);
  // docs-to-react files light up ONLY docs-to-react stages (shared cj/ux/docs
  // patterns stay scoped to this workflow; the built react/ maps to ui-react).
  assert.deepEqual(stagesForOutput('docs-to-react/app-ux-spec.json').map((d) => d.id), ['react-ux']);
  assert.deepEqual(stagesForOutput('docs-to-react/app-customer-journey.json').map((d) => d.id), ['react-cj']);
  assert.deepEqual(stagesForOutput('docs-to-react/react/dist/index.html').map((d) => d.id), ['ui-react']);
});

test('stagesForOutput: unprefixed legacy paths still match across workflows (back-compat)', () => {
  // Files produced before per-workflow folders existed have no prefix; they must
  // still derive status (matching across ALL stages sharing the pattern) so old
  // projects don't break.
  assert.deepEqual(
    stagesForOutput('docs/confluence/x.md').map((d) => d.id).sort(),
    ['html-docs', 'react-docs'],
  );
});

test('ui-html prototype output round-trips cross-device (not localOnly)', () => {
  // Regression: the docs-to-html deliverable (prototype/) must sync via the media
  // store. A localOnly ui-html would never reach another device on push/pull-all.
  assert.equal(getPipelineDef('ui-html')?.localOnly, undefined);
});

test('docs-to-react is a linear chain gated at each step (react-docs → react-cj → react-ux → ui-react)', () => {
  assert.equal(computeActive({}, def('react-docs')), true);
  assert.equal(computeActive({}, def('react-cj')), false);
  const s: ProjectPipelineState = {
    'react-docs': { status: 'succeeded' },
    'react-cj': { status: 'succeeded' },
  };
  assert.equal(computeActive(s, def('react-ux')), true);
  assert.equal(computeActive(s, def('ui-react')), false);
  assert.equal(computeActive({ ...s, 'react-ux': { status: 'succeeded' } }, def('ui-react')), true);
});

test('ui-react built app round-trips cross-device (not localOnly) and takes a design system', () => {
  // The react/ deliverable (source + dist) must sync via the media store like the
  // ui-html prototype does, and ui-react offers the design-system picker.
  assert.equal(getPipelineDef('ui-react')?.localOnly, undefined);
  assert.equal(getPipelineDef('ui-react')?.acceptsDesignSystem, true);
});

test('deriveStateFromLocalFiles lights up both workflows from unprefixed pulled files (cross-workflow)', () => {
  // A freshly-pulled device has NO local run metadata — only the pulled output
  // files. docs-to-html and docs-to-react share output patterns for the shared
  // upstream stages, so a legacy unprefixed file must mark its owning stage in
  // BOTH workflows (first-match-only attribution would leave one stepper empty).
  const state = deriveStateFromLocalFiles([
    'docs/confluence/_index.md', // → html-docs AND react-docs
    'bidv-account-freeze-journey.json', // → html-cj AND react-cj (-journey.json)
    'bidv-account-freeze-ux-spec.json', // → html-ux AND react-ux
    'prototype/index.html', // → ui-html
  ]);
  for (const id of ['html-docs', 'html-cj', 'html-ux', 'ui-html']) {
    assert.equal(state[id]?.status, 'succeeded', `${id} should be derived succeeded`);
  }
  // The shared docs-to-react upstream stages derive too.
  for (const id of ['react-docs', 'react-cj', 'react-ux']) {
    assert.equal(state[id]?.status, 'succeeded', `${id} should be derived succeeded`);
  }
});

test('deriveStateFromKgsFiles re-derives owning stage(s) from file path, not the stage tag', () => {
  // The media `stage` tag is first-match-only. Deriving from PATH recovers
  // every workflow's stage a shared unprefixed output also belongs to —
  // including files uploaded under stage tags of the REMOVED docs-to-ui
  // workflow (legacy stores).
  const state = deriveStateFromKgsFiles([
    { stage: 'jira-ingest', path: 'docs/confluence/_index.md' },
    { stage: 'ux-spec', path: 'app-ux-spec.json' },
  ]);
  assert.equal(state['html-docs']?.status, 'succeeded');
  assert.equal(state['react-docs']?.status, 'succeeded');
  assert.equal(state['html-ux']?.status, 'succeeded');
  assert.equal(state['react-ux']?.status, 'succeeded');
});

test('mergePipelineState: KGS done is authoritative, local fills transient state', () => {
  const local: ProjectPipelineState = {
    'html-docs': { status: 'failed' }, // local says failed...
    'html-cj': { status: 'running' },
  };
  const kgs: ProjectPipelineState = {
    'html-docs': { status: 'succeeded' }, // ...but KGS has files → done (cross-device)
  };
  const merged = mergePipelineState(local, kgs);
  // KGS file presence wins over a stale local 'failed'.
  assert.equal(merged['html-docs']?.status, 'succeeded');
  // No KGS files for html-cj → keep this device's in-flight 'running'.
  assert.equal(merged['html-cj']?.status, 'running');
  // After merge, html-cj is active (html-docs done per KGS).
  assert.equal(computeActive(merged, def('html-cj')), true);
});

test('mergePipelineState: a local in-flight re-run (running) shows over old KGS files', () => {
  const local: ProjectPipelineState = { 'html-ux': { status: 'running' } };
  const kgs: ProjectPipelineState = { 'html-ux': { status: 'succeeded' } };
  const merged = mergePipelineState(local, kgs);
  assert.equal(merged['html-ux']?.status, 'running');
});

// ── syncExclude: react/ generated entries + template scaffold never sync ─────
// (dist/ DOES sync since 2026-07: remote consumers — pipeline-studio — preview
// the built app from the store and have no Docker builder to reconstruct it.)

test('isSyncExcluded: react scaffold barred; agent sources AND built dist sync', () => {
  // Excluded: generated entries, template-owned scaffold, render metadata.
  for (const rel of [
    'docs-to-react/react/screens/home-entry.tsx',
    'docs-to-react/react/package.json',
    'docs-to-react/react/vite.config.ts',
    'docs-to-react/react/tsconfig.json',
    'docs-to-react/react/components.json',
    'docs-to-react/react/index.html',
    'docs-to-react/react/src/components/ui/button.tsx',
    'docs-to-react/react/src/lib/utils.ts',
    'docs-to-react/react/dist/index.html.artifact.json',
    'docs-to-react/react/dist/screens/home.html.artifact.json',
  ]) {
    assert.equal(isSyncExcluded(rel), true, `${rel} should be sync-excluded`);
  }
  // Synced: everything the agent authored + the flow manifest + the built
  // dist deliverable (index.html, per-screen pages, shared asset chunks).
  for (const rel of [
    'docs-to-react/react/flow.json',
    'docs-to-react/react/src/App.tsx',
    'docs-to-react/react/src/main.tsx',
    'docs-to-react/react/src/index.css',
    'docs-to-react/react/src/screens/home.tsx',
    // The agent-authored composite layer (use-case wrappers) MUST sync —
    // only the template-owned ui/ + lib/ are barred.
    'docs-to-react/react/src/components/app/AccountRow.tsx',
    'docs-to-react/react/src/components/app/index.ts',
    'docs-to-react/react/dist/index.html',
    'docs-to-react/react/dist/screens/home.html',
    'docs-to-react/react/dist/assets/button-abc123.js',
    'docs-to-react/react/dist/assets/chunk-KS7C4IRE-BW1GRIZQ.css',
    'docs-to-react/some-ux-spec.json',
    'docs-to-react/docs/jira/story.md',
  ]) {
    assert.equal(isSyncExcluded(rel), false, `${rel} should sync`);
  }
});

test('isSyncExcluded: other workflows are untouched by the react exclusions', () => {
  assert.equal(isSyncExcluded('docs-to-html/prototype/home.html'), false);
  // A legacy folder from the removed docs-to-ui workflow must not be caught
  // by ui-react's `react/screens/` pattern either.
  assert.equal(isSyncExcluded('docs-to-ui/screens/home.json'), false);
  // dist/index.html must NOT be caught by the `react/index.html` scaffold
  // pattern (endsWith-on-basename only matches the exact relative path).
  assert.equal(isSyncExcluded('react/dist/index.html'), false);
  // Un-namespaced legacy scaffold paths still barred.
  assert.equal(isSyncExcluded('react/index.html'), true);
});

test('history artifacts (_v/ snapshots + changelog.json) never light a stage', () => {
  // Frozen snapshot paths repeat real output shapes — every classifier must
  // ignore them or old versions would re-mark stages done forever.
  assert.deepEqual(stagesForOutput('_v/v3/docs-to-html/prototype/home.html'), []);
  assert.deepEqual(stagesForOutput('_v/v1/docs-to-react/mua-sim-customer-journey.json'), []);
  assert.deepEqual(stagesForOutput('changelog.json'), []);
  const state = deriveStateFromKgsFiles([
    { path: '_v/v2/docs-to-html/some-ux-spec.json' },
    { path: 'changelog.json' },
  ]);
  assert.deepEqual(state, {});
});

test('syncExclude never bars a stage-gating source: react/ still lights ui-react from synced files', () => {
  // Cross-device gating derives "done" from store files — flow.json/src keep
  // the ui-react stage discoverable even though dist/ no longer syncs.
  const state = deriveStateFromKgsFiles([{ path: 'docs-to-react/react/flow.json' }]);
  assert.equal(state['ui-react']?.status, 'succeeded');
});
