import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PipelineView, ProjectPipelineState } from '@open-design/contracts';

import {
  PIPELINE_DEFS,
  WORKFLOWS,
  computeActive,
  stageRegenSet,
  hasDownstream,
  upstreamStages,
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

test('docs-to-ui: terminal step offers two UI-Spec options', () => {
  assert.equal(WORKFLOWS[0]!.id, 'docs-to-ui');
  assert.deepEqual(WORKFLOWS[0]!.pipelineIds, ['docs', 'cj', 'ux-research', 'ux', 'ux-review', 'ui-html', 'ui-react']);
  // Both terminals are OPTIONS of the same step: same dependency, run either or both.
  // That dependency is the heuristic-review gate (not `ux` directly), so the
  // review must run once before either UI terminal unlocks.
  assert.deepEqual(def('ui-html').dependsOn, ['ux-review']);
  assert.deepEqual(def('ui-react').dependsOn, ['ux-review']);
});

test('docs-to-reviews: shares docs/cj/ux-research with docs-to-ui, own review-docs terminal', () => {
  const wf = WORKFLOWS.find((w) => w.id === 'docs-to-reviews');
  assert.ok(wf, 'docs-to-reviews workflow should exist');
  assert.deepEqual(wf!.pipelineIds, ['docs', 'cj', 'ux-research', 'review-docs']);
  assert.deepEqual(def('review-docs').dependsOn, ['ux-research']);
  assert.equal(def('review-docs').skillId, 'docs-mockup-review');
  // File-only: never projected into KGS.
  assert.equal(def('review-docs').convertToGraph, undefined);
  assert.deepEqual(def('review-docs').outputs, ['review/']);
  // The shared ids resolve to docs-to-ui's folder (first workflow to list
  // them) — both workflows read/write the SAME docs/cj/ux-research output,
  // so a project that ran docs-to-ui shows those 3 stages already done here.
  assert.equal(workflowDirForPipeline('docs'), 'docs-to-ui');
  assert.equal(workflowDirForPipeline('review-docs'), 'docs-to-reviews');
});

test('the ux-review gate sits between ux and the terminals (Gate 1: heuristic review)', () => {
  const g = def('ux-review');
  assert.deepEqual(g.dependsOn, ['ux']);
  assert.equal(g.skillId, 'heuristic-eval');
  // File-only review deliverable — never projected into KGS.
  assert.equal(g.convertToGraph, undefined);
  assert.deepEqual(g.outputs, ['heuristic-review/']);
});

test('Gate 2 (post-render WCAG) rides along on BOTH terminals as wcag-lint', () => {
  // The measurable a11y gate is deterministic and the terminals are optional,
  // so it is baked into each terminal (not a separate stage that could not gate
  // "either one"). Both terminals must carry the wcag-lint extra skill.
  assert.ok(def('ui-html').extraSkillIds?.includes('wcag-lint'));
  assert.ok(def('ui-react').extraSkillIds?.includes('wcag-lint'));
  // The report is written inside the produced output dir, so it needs no new
  // output pattern and it must round-trip (not be caught by react syncExclude).
  assert.equal(isSyncExcluded('docs-to-ui/prototype/a11y-report.json'), false);
  assert.equal(isSyncExcluded('docs-to-ui/react/a11y-report.json'), false);
  // …and it attributes to the owning terminal via the existing dir patterns.
  assert.deepEqual(stagesForOutput('docs-to-ui/prototype/a11y-report.json').map((d) => d.id), ['ui-html']);
  assert.deepEqual(stagesForOutput('docs-to-ui/react/a11y-report.json').map((d) => d.id), ['ui-react']);
});

test('docs has no prerequisites and is active from an empty state', () => {
  assert.equal(computeActive({}, def('docs')), true);
});

test('cj is gated until docs has succeeded', () => {
  assert.equal(computeActive({}, def('cj')), false);
  const running: ProjectPipelineState = { docs: { status: 'running' } };
  assert.equal(computeActive(running, def('cj')), false);
  const done: ProjectPipelineState = { docs: { status: 'succeeded' } };
  assert.equal(computeActive(done, def('cj')), true);
});

test('the shared chain gates linearly through the review gate (docs → cj → ux-research → ux → ux-review → ui-html | ui-react)', () => {
  const s: ProjectPipelineState = {
    docs: { status: 'succeeded' },
    cj: { status: 'succeeded' },
  };
  // cj done unlocks the RESEARCH stage — the UX Spec still waits on its report.
  assert.equal(computeActive(s, def('ux-research')), true);
  assert.equal(computeActive(s, def('ux')), false);
  assert.equal(computeActive(s, def('ux-review')), false);
  const withResearch = { ...s, 'ux-research': { status: 'succeeded' as const } };
  assert.equal(computeActive(withResearch, def('ux')), true);
  assert.equal(computeActive(withResearch, def('ux-review')), false);
  assert.equal(computeActive(withResearch, def('ui-html')), false);
  assert.equal(computeActive(withResearch, def('ui-react')), false);
  // ux done unlocks the review gate — but NOT the terminals yet.
  const withUx = { ...withResearch, ux: { status: 'succeeded' as const } };
  assert.equal(computeActive(withUx, def('ux-review')), true);
  assert.equal(computeActive(withUx, def('ui-html')), false);
  assert.equal(computeActive(withUx, def('ui-react')), false);
  // only after the review gate succeeds do BOTH terminals unlock.
  const withReview = { ...withUx, 'ux-review': { status: 'succeeded' as const } };
  assert.equal(computeActive(withReview, def('ui-html')), true);
  assert.equal(computeActive(withReview, def('ui-react')), true);
});

test('listPipelineStatus returns every stage in registry order with derived active + status', () => {
  const views = listPipelineStatus({ docs: { status: 'succeeded' } });
  assert.deepEqual(
    views.map((v) => v.id),
    PIPELINE_DEFS.map((d) => d.id),
  );
  assert.equal(viewOf(views, 'docs').status, 'succeeded');
  assert.equal(viewOf(views, 'docs').active, true);
  // cj is still idle but unlocked because docs succeeded.
  assert.equal(viewOf(views, 'cj').status, 'idle');
  assert.equal(viewOf(views, 'cj').active, true);
  // ux stays locked until cj succeeds.
  assert.equal(viewOf(views, 'ux').active, false);
});

test('deriveStateFromKgsFiles marks a stage succeeded when it has ≥1 KGS file', () => {
  const state = deriveStateFromKgsFiles([
    { stage: 'docs', path: 'docs-to-ui/docs/jira/A.md', status: 'ACTIVE' },
    { stage: 'docs', path: 'docs-to-ui/docs/jira/B.md', status: 'ACTIVE' },
    { stage: 'cj', path: 'docs-to-ui/app-cj.json', status: 'ACTIVE' },
    { path: 'no-stage.txt' }, // ignored: matches no stage output
  ]);
  assert.equal(state['docs']?.status, 'succeeded');
  assert.equal(state['cj']?.status, 'succeeded');
  assert.equal(state['ux'], undefined);
});

test('workflowDirForPipeline maps every pipeline to the single workflow folder', () => {
  for (const id of ['docs', 'cj', 'ux', 'ux-review', 'ui-html', 'ui-react']) {
    assert.equal(workflowDirForPipeline(id), 'docs-to-ui');
  }
  // Retired ids (twin workflows + the removed react-shadcn flow) resolve to nothing.
  assert.equal(workflowDirForPipeline('html-docs'), null);
  assert.equal(workflowDirForPipeline('react-docs'), null);
  assert.equal(workflowDirForPipeline('jira-ingest'), null);
  assert.equal(workflowDirForPipeline('nope'), null);
});

test('stagesForOutput: workflow-namespaced files attribute to the owning stage', () => {
  assert.deepEqual(stagesForOutput('docs-to-ui/docs/confluence/x.md').map((d) => d.id), ['docs']);
  assert.deepEqual(stagesForOutput('docs-to-ui/app-ux-spec.json').map((d) => d.id), ['ux']);
  assert.deepEqual(stagesForOutput('docs-to-ui/heuristic-review/summary.md').map((d) => d.id), ['ux-review']);
  assert.deepEqual(stagesForOutput('docs-to-ui/app-journey.json').map((d) => d.id), ['cj']);
  assert.deepEqual(stagesForOutput('docs-to-ui/prototype/index.html').map((d) => d.id), ['ui-html']);
  assert.deepEqual(stagesForOutput('docs-to-ui/react/dist/index.html').map((d) => d.id), ['ui-react']);
});

test('stagesForOutput: RETIRED workflow folders keep lighting the merged stages (no migration)', () => {
  // Old projects hold docs-to-html/… and docs-to-react/… trees on disk and on
  // the media store; the legacy-dir shim maps both onto the merged workflow.
  assert.deepEqual(stagesForOutput('docs-to-html/docs/confluence/x.md').map((d) => d.id), ['docs']);
  assert.deepEqual(stagesForOutput('docs-to-html/app-ux-spec.json').map((d) => d.id), ['ux']);
  assert.deepEqual(stagesForOutput('docs-to-html/app-journey.json').map((d) => d.id), ['cj']);
  assert.deepEqual(stagesForOutput('docs-to-html/prototype/index.html').map((d) => d.id), ['ui-html']);
  assert.deepEqual(stagesForOutput('docs-to-react/app-ux-spec.json').map((d) => d.id), ['ux']);
  assert.deepEqual(stagesForOutput('docs-to-react/app-customer-journey.json').map((d) => d.id), ['cj']);
  assert.deepEqual(stagesForOutput('docs-to-react/react/dist/index.html').map((d) => d.id), ['ui-react']);
});

test('stagesForOutput: unprefixed legacy paths still match (back-compat)', () => {
  // Files produced before per-workflow folders existed have no prefix; they
  // must still derive status so old projects don't break.
  assert.deepEqual(stagesForOutput('docs/confluence/x.md').map((d) => d.id), ['docs']);
});

test('ui-html prototype output round-trips cross-device (not localOnly)', () => {
  // Regression: the HTML UI-Spec deliverable (prototype/) must sync via the
  // media store. A localOnly ui-html would never reach another device.
  assert.equal(getPipelineDef('ui-html')?.localOnly, undefined);
});

test('ui-react built app round-trips cross-device (not localOnly) and takes a design system', () => {
  // The react/ deliverable (source + dist) must sync via the media store like
  // the ui-html prototype does, and both terminals offer the design-system picker.
  assert.equal(getPipelineDef('ui-react')?.localOnly, undefined);
  assert.equal(getPipelineDef('ui-react')?.acceptsDesignSystem, true);
  assert.equal(getPipelineDef('ui-html')?.acceptsDesignSystem, true);
});

test('stageRegenSet: re-run clear scope — self only, or self + transitive downstream', () => {
  // Non-cascade: only the stage itself.
  assert.deepEqual(stageRegenSet('ux', false), ['ux']);
  // Cascade from ux: ux + everything that (transitively) depends on it.
  assert.deepEqual(
    [...stageRegenSet('ux', true)].sort(),
    ['ui-html', 'ui-react', 'ux', 'ux-review'].sort(),
  );
  // Cascade from the gate: gate + both terminals (not ux, which is upstream).
  assert.deepEqual(
    [...stageRegenSet('ux-review', true)].sort(),
    ['ui-html', 'ui-react', 'ux-review'].sort(),
  );
  // Terminals have no downstream — cascade == self.
  assert.deepEqual(stageRegenSet('ui-html', true), ['ui-html']);
  assert.deepEqual(stageRegenSet('ui-react', true), ['ui-react']);
  // docs cascades to the whole workflow.
  assert.equal(stageRegenSet('docs', true).length, PIPELINE_DEFS.length);
});

test('hasDownstream: only terminals lack downstream (scope choice hidden there)', () => {
  assert.equal(hasDownstream('docs'), true);
  assert.equal(hasDownstream('ux'), true);
  assert.equal(hasDownstream('ux-review'), true);
  assert.equal(hasDownstream('ui-html'), false);
  assert.equal(hasDownstream('ui-react'), false);
});

test('upstreamStages: pre-run pull scope is inputs only — never self, never downstream', () => {
  // ux-review pulls its inputs (docs/cj/ux) but NOT the UI terminals, so running
  // it can't resurrect ui-html/ui-react outputs into the local cwd.
  assert.deepEqual([...upstreamStages('ux-review')].sort(), ['cj', 'docs', 'ux', 'ux-research']);
  assert.deepEqual(upstreamStages('docs'), []); // head stage has no inputs
  assert.deepEqual([...upstreamStages('ux')].sort(), ['cj', 'docs', 'ux-research']);
  // A terminal pulls the whole chain above it, but not the sibling terminal.
  const uiHtmlUp = upstreamStages('ui-html');
  assert.ok(uiHtmlUp.includes('ux-review') && uiHtmlUp.includes('ux'));
  assert.ok(!uiHtmlUp.includes('ui-html') && !uiHtmlUp.includes('ui-react'));
});

test('ux stage owns the target-platform choice (acceptsPlatform), terminals follow the spec', () => {
  // The UX stage authors each screen's `layout` (mobile|web), so the platform
  // picker attaches there; the UI-Spec terminals just render per that field.
  assert.equal(getPipelineDef('ux')?.acceptsPlatform, true);
  assert.equal(getPipelineDef('ui-html')?.acceptsPlatform, undefined);
  assert.equal(getPipelineDef('ui-react')?.acceptsPlatform, undefined);
  // …and the flag reaches clients through the pipeline view list.
  const view = listPipelineStatus({}, ['ux', 'ui-html']).find((p) => p.id === 'ux');
  assert.equal(view?.acceptsPlatform, true);
});

test('deriveStateFromLocalFiles lights the merged stages from unprefixed pulled files', () => {
  // A freshly-pulled device has NO local run metadata — only the pulled output
  // files. Legacy unprefixed files must mark their owning stages.
  const state = deriveStateFromLocalFiles([
    'docs/confluence/_index.md', // → docs
    'bidv-account-freeze-journey.json', // → cj (-journey.json)
    'bidv-account-freeze-ux-spec.json', // → ux
    'prototype/index.html', // → ui-html
  ]);
  for (const id of ['docs', 'cj', 'ux', 'ui-html']) {
    assert.equal(state[id]?.status, 'succeeded', `${id} should be derived succeeded`);
  }
});

test('deriveStateFromKgsFiles re-derives owning stage(s) from file path, not the stage tag', () => {
  // The media `stage` tag is stamped at upload time; old stores carry tags
  // from RETIRED stage ids (html-docs, react-ux, jira-ingest, …). Deriving
  // from PATH recovers the merged stage regardless of the tag.
  const state = deriveStateFromKgsFiles([
    { stage: 'jira-ingest', path: 'docs/confluence/_index.md' },
    { stage: 'html-ux', path: 'docs-to-html/app-ux-spec.json' },
    { stage: 'react-cj', path: 'docs-to-react/app-cj.json' },
  ]);
  assert.equal(state['docs']?.status, 'succeeded');
  assert.equal(state['ux']?.status, 'succeeded');
  assert.equal(state['cj']?.status, 'succeeded');
});

test('mergePipelineState: KGS done is authoritative, local fills transient state', () => {
  const local: ProjectPipelineState = {
    docs: { status: 'failed' }, // local says failed...
    cj: { status: 'running' },
  };
  const kgs: ProjectPipelineState = {
    docs: { status: 'succeeded' }, // ...but KGS has files → done (cross-device)
  };
  const merged = mergePipelineState(local, kgs);
  // KGS file presence wins over a stale local 'failed'.
  assert.equal(merged['docs']?.status, 'succeeded');
  // No KGS files for cj → keep this device's in-flight 'running'.
  assert.equal(merged['cj']?.status, 'running');
  // After merge, cj is active (docs done per KGS).
  assert.equal(computeActive(merged, def('cj')), true);
});

test('mergePipelineState: a local in-flight re-run (running) shows over old KGS files', () => {
  const local: ProjectPipelineState = { ux: { status: 'running' } };
  const kgs: ProjectPipelineState = { ux: { status: 'succeeded' } };
  const merged = mergePipelineState(local, kgs);
  assert.equal(merged['ux']?.status, 'running');
});

// ── syncExclude: react/ generated entries + template scaffold never sync ─────
// (dist/ DOES sync since 2026-07: remote consumers — pipeline-studio — preview
// the built app from the store and have no Docker builder to reconstruct it.)

test('isSyncExcluded: react scaffold barred; agent sources AND built dist sync', () => {
  // Excluded: generated entries, template-owned scaffold, render metadata —
  // in BOTH the merged folder and the retired docs-to-react folder.
  for (const wfDir of ['docs-to-ui', 'docs-to-react']) {
    for (const rel of [
      `${wfDir}/react/screens/home-entry.tsx`,
      `${wfDir}/react/package.json`,
      `${wfDir}/react/vite.config.ts`,
      `${wfDir}/react/tsconfig.json`,
      `${wfDir}/react/components.json`,
      `${wfDir}/react/index.html`,
      `${wfDir}/react/src/components/ui/button.tsx`,
      `${wfDir}/react/src/lib/utils.ts`,
      `${wfDir}/react/dist/index.html.artifact.json`,
      `${wfDir}/react/dist/screens/home.html.artifact.json`,
    ]) {
      assert.equal(isSyncExcluded(rel), true, `${rel} should be sync-excluded`);
    }
  }
  // Synced: everything the agent authored + the flow manifest + the built
  // dist deliverable (index.html, per-screen pages, shared asset chunks).
  for (const rel of [
    'docs-to-ui/react/flow.json',
    'docs-to-ui/react/src/App.tsx',
    'docs-to-ui/react/src/main.tsx',
    'docs-to-ui/react/src/index.css',
    'docs-to-ui/react/src/screens/home.tsx',
    // The agent-authored composite layer (use-case wrappers) MUST sync —
    // only the template-owned ui/ + lib/ are barred.
    'docs-to-ui/react/src/components/app/AccountRow.tsx',
    'docs-to-ui/react/src/components/app/index.ts',
    'docs-to-ui/react/dist/index.html',
    'docs-to-ui/react/dist/screens/home.html',
    'docs-to-ui/react/dist/assets/button-abc123.js',
    'docs-to-ui/react/dist/assets/chunk-KS7C4IRE-BW1GRIZQ.css',
    'docs-to-ui/some-ux-spec.json',
    'docs-to-ui/docs/jira/story.md',
    'docs-to-react/react/flow.json',
    'docs-to-react/react/dist/screens/home.html',
  ]) {
    assert.equal(isSyncExcluded(rel), false, `${rel} should sync`);
  }
});

test('isSyncExcluded: non-react outputs are untouched by the react exclusions', () => {
  assert.equal(isSyncExcluded('docs-to-ui/prototype/home.html'), false);
  assert.equal(isSyncExcluded('docs-to-html/prototype/home.html'), false);
  // A stray screens/ folder at the workflow root must not be caught by
  // ui-react's `react/screens/` pattern.
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
  assert.deepEqual(stagesForOutput('_v/v3/docs-to-ui/prototype/home.html'), []);
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
  // the ui-react stage discoverable even though scaffold files don't sync.
  const state = deriveStateFromKgsFiles([{ path: 'docs-to-ui/react/flow.json' }]);
  assert.equal(state['ui-react']?.status, 'succeeded');
  // Legacy folder derives the same stage.
  const legacy = deriveStateFromKgsFiles([{ path: 'docs-to-react/react/flow.json' }]);
  assert.equal(legacy['ui-react']?.status, 'succeeded');
});
