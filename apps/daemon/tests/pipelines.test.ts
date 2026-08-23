import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PipelineView, ProjectPipelineState } from '@open-design/contracts';

import {
  HELD_STAGE_IDS,
  PIPELINE_DEFS,
  WORKFLOWS,
  computeActive,
  effectiveDependsOn,
  resolveRunMode,
  stageRegenSet,
  hasDownstream,
  upstreamStages,
  deriveStateFromKgsFiles,
  deriveStateFromLocalFiles,
  getPipelineDef,
  getWorkflow,
  isSyncExcluded,
  isTargetScopedWfDir,
  listPipelineStatus,
  mergePipelineState,
  pickRunTarget,
  relClearedByRegen,
  missingDependencies,
  selectRunStages,
  stagesForOutput,
  validateRunStageSelection,
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
  assert.deepEqual(WORKFLOWS[0]!.pipelineIds, ['docs', 'docs-map', 'cj', 'ux-research', 'ux', 'ux-review', 'ui-html', 'ui-react', 'ui-react-ds']);
  // Both terminals are OPTIONS of the same step: same dependency, run either or both.
  // That dependency is the heuristic-review gate (not `ux` directly), so the
  // review must run once before either UI terminal unlocks.
  assert.deepEqual(def('ui-html').dependsOn, ['ux-review']);
  assert.deepEqual(def('ui-react').dependsOn, ['ux-review']);
  assert.deepEqual(def('ui-react-ds').dependsOn, ['ux-review']);
  // The React-DS terminal keeps its own output tree (react-ds/) so it can run
  // alongside ui-react in one project, and hard-requires a design system with
  // a react bundle at run time (gated in runPipeline, not here).
  assert.deepEqual(def('ui-react-ds').outputs, ['react-ds/']);
  assert.equal(def('ui-react-ds').acceptsDesignSystem, true);
});

test('docs-to-prd: fully independent of docs-to-ui — its own docs/cj/ux-research + review terminal', () => {
  const wf = WORKFLOWS.find((w) => w.id === 'docs-to-prd');
  assert.ok(wf, 'docs-to-prd workflow should exist');
  assert.deepEqual(wf!.pipelineIds, ['prd-docs', 'prd-cj', 'prd-ux-research', 'prd-review']);
  // Same ingredient skills as docs-to-ui's docs/cj/ux-research, but distinct
  // ids — so nothing here is ever "already done" from a docs-to-ui run.
  assert.equal(def('prd-docs').skillId, 'confluence-ingest');
  assert.equal(def('prd-cj').skillId, 'customer-journey-spec');
  assert.equal(def('prd-ux-research').skillId, 'ux-research');
  assert.deepEqual(def('prd-cj').dependsOn, ['prd-docs']);
  assert.deepEqual(def('prd-ux-research').dependsOn, ['prd-cj']);
  assert.deepEqual(def('prd-review').dependsOn, ['prd-ux-research']);
  assert.equal(def('prd-review').skillId, 'docs-mockup-review');
  assert.deepEqual(def('prd-review').outputs, ['review/']);
  // Each id resolves to docs-to-prd's OWN folder — never docs-to-ui's.
  assert.equal(workflowDirForPipeline('prd-docs'), 'docs-to-prd');
  assert.equal(workflowDirForPipeline('prd-ux-research'), 'docs-to-prd');
  assert.equal(workflowDirForPipeline('prd-review'), 'docs-to-prd');
  // And docs-to-ui's own ids are untouched, still resolving to docs-to-ui.
  assert.equal(workflowDirForPipeline('docs'), 'docs-to-ui');
  assert.equal(workflowDirForPipeline('ux-research'), 'docs-to-ui');
});

test('docs-review: fully independent of docs-to-ui and docs-to-prd — dr-docs -> dr-flow -> dr-comp -> dr-review, docs-to-ui stays WORKFLOWS[0]', () => {
  // docs-to-ui must remain the default workflow — appending docs-review must
  // not disturb WORKFLOWS[0] or DEFAULT_WORKFLOW_ID.
  assert.equal(WORKFLOWS[0]!.id, 'docs-to-ui');
  const wf = WORKFLOWS.find((w) => w.id === 'docs-review');
  assert.ok(wf, 'docs-review workflow should exist');
  assert.deepEqual(wf!.pipelineIds, ['dr-docs', 'dr-flow', 'dr-comp', 'dr-review']);
  assert.equal(def('dr-docs').skillId, 'confluence-ingest');
  assert.equal(def('dr-comp').skillId, 'docs-screen-components');
  assert.equal(def('dr-review').skillId, 'docs-spec-review');
  assert.equal(def('dr-flow').skillId, 'docs-flow-ux');
  assert.deepEqual(def('dr-docs').dependsOn, []);
  // 2026-08-17: dr-flow chạy TRƯỚC dr-comp — wireframe của dr-comp lấy
  // `data-nav` từ flows/, nên run-all sắp flow trước và re-run dr-flow có
  // cascade sẽ xoá comp/ + wireframes/. dr-review phải chờ CẢ HAI vì nhóm
  // `component` của nó là đọc lại kết quả dr-comp chứ không tự suy.
  assert.deepEqual(def('dr-flow').dependsOn, ['dr-docs']);
  assert.deepEqual(def('dr-comp').dependsOn, ['dr-docs', 'dr-flow']);
  // Review là bước CHỐT cuối — chờ đủ cả flow lẫn comp.
  assert.deepEqual(def('dr-review').dependsOn, ['dr-docs', 'dr-flow', 'dr-comp']);
  assert.deepEqual(def('dr-docs').outputs, ['docs/', 'docs-feature/']);
  // comp/ nằm ở gốc workflow-dir, KHÔNG lồng trong review/ — cùng lý do như
  // flows/: lồng vào đó thì re-run dr-review xoá mất, và stagesForOutput chấm
  // hai stage cho cùng một file.
  assert.deepEqual(def('dr-comp').outputs, ['comp/', 'wireframes/']);
  assert.deepEqual(def('dr-review').outputs, ['review/']);
  // flows/ sits at the workflow-dir root, NOT under review/ — see
  // tests/docs-flow-stage.test.ts for why that placement is load-bearing.
  assert.deepEqual(def('dr-flow').outputs, ['flows/']);
  // Each id resolves to docs-review's OWN folder namespace.
  assert.equal(workflowDirForPipeline('dr-docs'), 'docs-review');
  assert.equal(workflowDirForPipeline('dr-comp'), 'docs-review');
  assert.equal(workflowDirForPipeline('dr-review'), 'docs-review');
  assert.equal(workflowDirForPipeline('dr-flow'), 'docs-review');
  // And the other two workflows' own ids are untouched.
  assert.equal(workflowDirForPipeline('docs'), 'docs-to-ui');
  assert.equal(workflowDirForPipeline('prd-docs'), 'docs-to-prd');
});

test('dr-docs accepts a manual file upload (acceptsUpload), and the flag reaches clients through listPipelineStatus', () => {
  // dr-docs is the only stage that lets a user drop in a doc / criteria file
  // directly from the UI — everything else only ever gets input from a run.
  assert.equal(getPipelineDef('dr-docs')?.acceptsUpload, true);
  assert.equal(getPipelineDef('dr-comp')?.acceptsUpload, undefined);
  assert.equal(getPipelineDef('dr-review')?.acceptsUpload, undefined);
  assert.equal(getPipelineDef('dr-flow')?.acceptsUpload, undefined);
  assert.equal(getPipelineDef('docs')?.acceptsUpload, undefined);
  assert.equal(getPipelineDef('prd-docs')?.acceptsUpload, undefined);
  // …and the flag reaches clients through the pipeline view list, same as
  // acceptsDesignSystem / acceptsPlatform.
  const views = listPipelineStatus({}, ['dr-docs', 'dr-review', 'dr-flow']);
  assert.equal(viewOf(views, 'dr-docs').acceptsUpload, true);
  assert.equal(viewOf(views, 'dr-review').acceptsUpload, undefined);
  assert.equal(viewOf(views, 'dr-flow').acceptsUpload, undefined);
});

test('docs-review attribution: review/docs clone belongs only to dr-review, docs/ belongs only to dr-docs, criteria/ belongs to no stage and never gets cleared by a re-run', () => {
  // 'docs-review/review/docs/confluence/x.md' → dr-review ONLY (outputs 'review/').
  assert.deepEqual(
    stagesForOutput('docs-review/review/docs/confluence/x.md').map((d) => d.id),
    ['dr-review'],
  );
  // 'docs-review/docs/confluence/x.md' → dr-docs ONLY (outputs 'docs/').
  assert.deepEqual(
    stagesForOutput('docs-review/docs/confluence/x.md').map((d) => d.id),
    ['dr-docs'],
  );
  // 'docs-review/criteria/rules.md' matches NO stage's declared outputs.
  assert.deepEqual(stagesForOutput('docs-review/criteria/rules.md'), []);
  // …so a re-run of dr-review never clears it, even though it lives in the
  // same project cwd the fan-out otherwise sweeps.
  assert.equal(
    relClearedByRegen('docs-review/criteria/rules.md', new Set(['dr-review']), 'docs-review'),
    false,
  );
});

test('the ux-review gate sits between ux and the terminals (Gate 1: heuristic review)', () => {
  const g = def('ux-review');
  assert.deepEqual(g.dependsOn, ['ux']);
  assert.equal(g.skillId, 'heuristic-eval');
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

test('cj is active as soon as the workflow ingest (docs) has succeeded — the system map no longer gates it (2026-08 docs-only gate)', () => {
  // dependsOn STILL names docs-map (registry structure / display / cascade) —
  // only computeActive's gate itself changed, see this file's header comment.
  assert.deepEqual(def('cj').dependsOn, ['docs-map']);
  assert.equal(computeActive({}, def('cj')), false);
  const ingestOnly: ProjectPipelineState = { docs: { status: 'succeeded' } };
  // docs alone (the workflow's ingest) is now enough — docs-map need never
  // have run at all.
  assert.equal(computeActive(ingestOnly, def('cj')), true);
  const running: ProjectPipelineState = { 'docs-map': { status: 'running' } };
  // docs-map running (or done) with docs itself absent does NOT unlock cj —
  // the gate reads only the ingest stage's status, nothing else.
  assert.equal(computeActive(running, def('cj')), false);
  const docsMapDoneOnly: ProjectPipelineState = { 'docs-map': { status: 'succeeded' } };
  assert.equal(computeActive(docsMapDoneOnly, def('cj')), false);
});

test('the shared chain no longer gates linearly through the review gate — once docs succeeds, EVERY downstream stage unlocks together (2026-08 docs-only gate)', () => {
  // Before docs succeeds, nothing past the ingest is active — not even cj,
  // even though nothing here has run yet.
  assert.equal(computeActive({}, def('cj')), false);
  assert.equal(computeActive({}, def('ux-research')), false);
  assert.equal(computeActive({}, def('ux')), false);
  assert.equal(computeActive({}, def('ux-review')), false);
  assert.equal(computeActive({}, def('ui-html')), false);
  assert.equal(computeActive({}, def('ui-react')), false);
  // docs succeeds → every downstream stage unlocks AT ONCE, even though none
  // of cj/ux-research/ux/ux-review/ui-html/ui-react has ever run — there is no
  // more linear "one stage at a time" chain.
  const s: ProjectPipelineState = { docs: { status: 'succeeded' } };
  assert.equal(computeActive(s, def('cj')), true);
  assert.equal(computeActive(s, def('ux-research')), true);
  assert.equal(computeActive(s, def('ux')), true);
  assert.equal(computeActive(s, def('ux-review')), true);
  assert.equal(computeActive(s, def('ui-html')), true);
  assert.equal(computeActive(s, def('ui-react')), true);
});

test('listPipelineStatus returns every stage in registry order with derived active + status', () => {
  const views = listPipelineStatus({ docs: { status: 'succeeded' } });
  assert.deepEqual(
    views.map((v) => v.id),
    PIPELINE_DEFS.map((d) => d.id),
  );
  assert.equal(viewOf(views, 'docs').status, 'succeeded');
  assert.equal(viewOf(views, 'docs').active, true);
  // docs-map is idle but unlocked — the ingest is its only dependency.
  assert.equal(viewOf(views, 'docs-map').status, 'idle');
  assert.equal(viewOf(views, 'docs-map').active, true);
  // 2026-08 docs-only gate: docs succeeded unlocks EVERY downstream stage at
  // once, not just docs-map — cj is active even though it never ran.
  assert.equal(viewOf(views, 'cj').active, true);
  // …and ux too, further down the (now-flat) chain.
  assert.equal(viewOf(views, 'ux').active, true);
});

test('listPipelineStatus surfaces error ONLY alongside a failed status — a stale error on a non-failed row never leaks through', () => {
  const views = listPipelineStatus({
    docs: { status: 'failed', error: 'Chưa cấu hình Nguồn tài liệu' },
    // Defensive: even if a row somehow carries a leftover `error` value
    // while its status is NOT 'failed' (e.g. a hand-crafted/legacy row),
    // the view must not surface it — the invariant is enforced by
    // setProjectPipelineStatus (db.ts) on write, and mirrored here on read.
    'ux-research': { status: 'succeeded', error: 'stale, should never show' } as any,
  });
  assert.equal(viewOf(views, 'docs').error, 'Chưa cấu hình Nguồn tài liệu');
  assert.equal(viewOf(views, 'ux-research').error, undefined);
  // A normal idle row (no error ever set) stays absent, not null/empty string.
  assert.equal(viewOf(views, 'docs-map').error, undefined);
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

// Link-followed background pages land in `docs/context/` (bas-client.ts). The
// docs stage must DECLARE that folder: the same `outputs` list drives Quick
// result's file rail, the stage-scoped push and the stage-scoped pull, so an
// undeclared folder is invisible in the UI, never reaches the media store, and
// never pulls down — leaving a second machine's ux run without the domain
// background the ux-spec skill tells it to read.
// The LEAN run-all trades depth for speed: it drops the analysis stages and runs
// docs → UX Spec → UI. Which stages those are must stay a property of the stage
// itself, so a workflow change cannot silently leave the lean chain broken.
// The system map describes the PROJECT, not one product, so it must run once —
// a per-target copy would be N conflicting answers to the same question, and the
// hand-off points between apps would be recorded differently on each side.
test('the system map is a shared stage: one run per project, before the per-target fork', () => {
  assert.equal(def('docs-map').sharedAcrossTargets, true);
  assert.deepEqual(def('docs-map').outputs, ['docs/system-map.json']);

  // It lands INSIDE docs/, so the existing per-target docs copy carries it into
  // every target's cwd — no separate staging step.
  assert.deepEqual(stagesForOutput('docs-to-ui/docs/system-map.json').map((d) => d.id), ['docs-map']);
  // …and it does NOT collide with the ingest's own docs/ patterns.
  assert.deepEqual(stagesForOutput('docs-to-ui/docs/confluence/x.md').map((d) => d.id), ['docs']);

  // Shared stages must precede the per-target ones, or run-all's "run shared
  // first, then fork" would drop them.
  const ids = WORKFLOWS[0]!.pipelineIds;
  const lastShared = Math.max(...ids.map((id, i) => (def(id).sharedAcrossTargets || def(id).inputPlaceholder ? i : -1)));
  const firstPerTarget = ids.findIndex((id) => !def(id).sharedAcrossTargets && !def(id).inputPlaceholder);
  assert.ok(lastShared < firstPerTarget, 'mọi bước dùng chung phải đứng trước các bước theo target');
});

test('lean run-all skips the docs-to-ui analysis stages — and ONLY docs-to-ui', () => {
  const lean = (wfId: string) =>
    WORKFLOWS.find((w) => w.id === wfId)!.pipelineIds.filter((id) => !def(id).skippedInLeanRun);

  // docs-to-ui keeps the spec + both UI terminals; journey / research / review go.
  // docs-map stays: it is what keeps a multi-app project from being built as
  // several unrelated products, and a lean run still builds every target.
  assert.deepEqual(lean('docs-to-ui'), ['docs', 'docs-map', 'ux', 'ui-html', 'ui-react', 'ui-react-ds']);

  // docs-to-prd is UNTOUCHED by lean (product decision 2026-07): its journey +
  // research are the review's evidence base, not optional sharpening. The lean
  // toggle is inert here — the chain is identical in either mode.
  assert.deepEqual(lean('docs-to-prd'), ['prd-docs', 'prd-cj', 'prd-ux-research', 'prd-review']);

  // Every skipped stage must be one a downstream stage tolerates missing.
  for (const id of ['cj', 'ux-research', 'ux-review']) {
    assert.equal(def(id).skippedInLeanRun, true, `${id} phải bỏ được ở chế độ tiết kiệm`);
  }
  for (const id of ['docs', 'docs-map', 'ux', 'ui-html', 'ui-react', 'prd-docs', 'prd-cj', 'prd-ux-research', 'prd-review']) {
    assert.notEqual(def(id).skippedInLeanRun, true, `${id} KHÔNG được bỏ`);
  }
});

test('stagesForOutput: link-followed context pages attribute to the docs stage', () => {
  assert.deepEqual(stagesForOutput('docs-to-ui/docs/context/x.md').map((d) => d.id), ['docs']);
  assert.deepEqual(stagesForOutput('docs-to-ui/docs/context/nested/x.md').map((d) => d.id), ['docs']);
  // Inline images travel with their page.
  assert.deepEqual(stagesForOutput('docs-to-ui/docs/context/images/x.png').map((d) => d.id), ['docs']);
  // docs-to-prd runs the same ingest and needs the same attribution.
  assert.deepEqual(stagesForOutput('docs-to-prd/docs/context/x.md').map((d) => d.id), ['prd-docs']);
  // Both ingest stages declare all four ingest folders — docs-feature/ is an
  // App-linked project's selected-feature-pages source (see server.ts's app-pool
  // ingest), the source of truth for that layout alongside legacy docs/*.
  assert.deepEqual(def('docs').outputs, ['docs/jira/', 'docs/confluence/', 'docs/context/', 'docs-feature/']);
  assert.deepEqual(def('prd-docs').outputs, ['docs/jira/', 'docs/confluence/', 'docs/context/', 'docs-feature/']);
});

test('stagesForOutput: multi-target subfolder outputs attribute to the same stage', () => {
  // <workflow>/<target>/… nests post-docs outputs one level deeper; the target
  // segment is stripped so a per-target file lights the same stage as the flat
  // one (otherwise multi-target outputs orphan — no status, no sync).
  assert.deepEqual(stagesForOutput('docs-to-ui/mobile/cj/journey.json').map((d) => d.id), ['cj']);
  assert.deepEqual(stagesForOutput('docs-to-ui/web-backoffice/heuristic-review/report.json').map((d) => d.id), ['ux-review']);
  assert.deepEqual(stagesForOutput('docs-to-ui/web-user/prototype/index.html').map((d) => d.id), ['ui-html']);
  assert.deepEqual(stagesForOutput('docs-to-ui/mobile/app-ux-spec.json').map((d) => d.id), ['ux']);
  // A non-target second segment is NOT stripped (only the 3 known target dirs).
  assert.deepEqual(stagesForOutput('docs-to-ui/cj/journey.json').map((d) => d.id), ['cj']);
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
  // must still derive status so old projects don't break. An unprefixed path
  // is ambiguous between docs-to-ui's `docs`, docs-to-prd's `prd-docs`,
  // docs-review's `dr-docs`, and ds-lab's `lab-docs` (same relative output
  // pattern, independent workflows) — but no legacy unprefixed file can
  // actually be a docs-to-prd/docs-review/ds-lab one (all three workflows
  // were introduced after per-workflow folders already existed), and
  // stageForOutput's first-match still resolves to `docs` (declared first).
  assert.deepEqual(stagesForOutput('docs/confluence/x.md').map((d) => d.id), ['docs', 'prd-docs', 'dr-docs', 'lab-docs']);
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
    ['ui-html', 'ui-react', 'ui-react-ds', 'ux', 'ux-review'].sort(),
  );
  // Cascade from the gate: gate + both terminals (not ux, which is upstream).
  assert.deepEqual(
    [...stageRegenSet('ux-review', true)].sort(),
    ['ui-html', 'ui-react', 'ui-react-ds', 'ux-review'].sort(),
  );
  // Terminals have no downstream — cascade == self.
  assert.deepEqual(stageRegenSet('ui-html', true), ['ui-html']);
  assert.deepEqual(stageRegenSet('ui-react', true), ['ui-react']);
  // docs cascades to its own workflow only — docs-to-prd's independent
  // prd-docs/prd-cj/prd-ux-research/prd-review never light up from this.
  assert.deepEqual(
    [...stageRegenSet('docs', true)].sort(),
    ['docs', 'docs-map', 'cj', 'ux-research', 'ux', 'ux-review', 'ui-html', 'ui-react', 'ui-react-ds'].sort(),
  );
  // And prd-docs cascades to its own 4-stage workflow only.
  assert.deepEqual(
    [...stageRegenSet('prd-docs', true)].sort(),
    ['prd-docs', 'prd-cj', 'prd-ux-research', 'prd-review'].sort(),
  );
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
  assert.deepEqual([...upstreamStages('ux-review')].sort(), ['cj', 'docs', 'docs-map', 'ux', 'ux-research']);
  assert.deepEqual(upstreamStages('docs'), []); // head stage has no inputs
  assert.deepEqual([...upstreamStages('ux')].sort(), ['cj', 'docs', 'docs-map', 'ux-research']);
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

test('ux stage carries usesDesignSystemCriteria — NOT acceptsDesignSystem (DS is inferred from the App, not a per-run picker)', () => {
  assert.equal(getPipelineDef('ux')?.usesDesignSystemCriteria, true);
  // Deciding not to add acceptsDesignSystem here is load-bearing: that flag
  // makes the run-stage modal show a DS picker, and the ux stage's DS must
  // come from criteriaDesignSystemForProject (the App's own DS), never a
  // per-run user choice.
  assert.equal(getPipelineDef('ux')?.acceptsDesignSystem, undefined);
  // Criteria-consuming stages across all three workflows opt in explicitly.
  const criteriaStages = new Set(['ux', 'ux-review', 'ui-html', 'ui-react', 'ui-react-ds', 'prd-review', 'dr-comp', 'dr-review']);
  for (const d of PIPELINE_DEFS) {
    assert.equal(d.usesDesignSystemCriteria, criteriaStages.has(d.id) ? true : undefined, `${d.id} criteria flag mismatch`);
  }
  // criteria/ must never be declared as a stage output — it is staged input,
  // not a deliverable, so re-run clear must never sweep it (see the
  // docs-review attribution test above, which locks the same invariant via
  // stagesForOutput for 'docs-review/criteria/rules.md').
  for (const d of PIPELINE_DEFS) {
    for (const pattern of d.outputs ?? []) {
      assert.notEqual(pattern, 'criteria/', `${d.id}.outputs must not declare criteria/`);
    }
  }
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

test('mergePipelineState: the current failed run is not hidden by preview files', () => {
  const local: ProjectPipelineState = {
    docs: { status: 'failed' }, // local says failed...
    cj: { status: 'running' },
  };
  const kgs: ProjectPipelineState = {
    docs: { status: 'succeeded' }, // ...but KGS has files → done (cross-device)
  };
  const merged = mergePipelineState(local, kgs);
  // Output files can belong to an older successful run or a partial failed
  // run. The current attempt must finish successfully before the step is done.
  assert.equal(merged['docs']?.status, 'failed');
  // No KGS files for cj → keep this device's in-flight 'running'.
  assert.equal(merged['cj']?.status, 'running');
  assert.equal(computeActive(merged, def('cj')), false);
  assert.equal(computeActive({ ...merged, 'docs-map': { status: 'succeeded' } }, def('cj')), false);
});

test('mergePipelineState: an unfinished current attempt shows over old preview files', () => {
  const kgs: ProjectPipelineState = {
    ux: { status: 'succeeded' },
    cj: { status: 'succeeded' },
    'ux-review': { status: 'succeeded' },
  };
  const merged = mergePipelineState({
    ux: { status: 'running', lastRunId: 'run-running' },
    cj: { status: 'queued', lastRunId: 'run-queued' },
    'ux-review': { status: 'idle', lastRunId: 'run-canceled' },
  }, kgs);
  assert.equal(merged['ux']?.status, 'running');
  assert.equal(merged['cj']?.status, 'queued');
  assert.equal(merged['ux-review']?.status, 'idle');
});

test('mergePipelineState: pulled preview files still recover legacy stages without a local attempt', () => {
  const merged = mergePipelineState({}, { ux: { status: 'succeeded' } });
  assert.equal(merged['ux']?.status, 'succeeded');
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

// ── Lean run mode ───────────────────────────────────────────────────────────
// Regression: run-all in LEAN mode never runs the `skippedInLeanRun` stages,
// but `active` was derived from the STATIC dependsOn — so the UI terminals,
// which depend on `ux-review`, stayed locked FOREVER after a lean run. The
// stepper showed "Locked — finish UX Heuristic Review first" (and
// POST /api/pipelines/:id/run answered 409) even though the same lean chain had
// just produced a React app. Gating must follow the stages the mode runs.
function leanDoneState(): ProjectPipelineState {
  // What a finished LEAN chain leaves behind: docs → docs-map → ux → ui-react.
  return {
    docs: { status: 'succeeded' },
    'docs-map': { status: 'succeeded' },
    ux: { status: 'succeeded' },
    'ui-react': { status: 'succeeded' },
  };
}

test('lean mode: a dependency the mode skips collapses to the nearest stage it runs', () => {
  assert.equal(def('ux-review').skippedInLeanRun, true);
  assert.deepEqual(effectiveDependsOn(def('ui-react'), 'full'), ['ux-review']);
  assert.deepEqual(effectiveDependsOn(def('ui-react'), 'lean'), ['ux']);
  // A RUN of skipped stages collapses too: cj and ux-research are both skipped,
  // so under lean the UX Spec gates on the system map.
  assert.deepEqual(effectiveDependsOn(def('ux'), 'lean'), ['docs-map']);
});

test('lean is a docs-to-ui-only concept: docs-to-prd is untouched by it', () => {
  // Product decision: the PRD review's journey + research ARE its evidence
  // base, not optional sharpening — no docs-to-prd stage may be lean-skippable,
  // and lean must not change its gating in any way.
  const prd = WORKFLOWS.find((w) => w.id === 'docs-to-prd')!;
  for (const id of prd.pipelineIds) {
    assert.equal(def(id).skippedInLeanRun, undefined, `${id} must not be lean-skippable`);
    assert.deepEqual(effectiveDependsOn(def(id), 'lean'), def(id).dependsOn, `${id} gate must not change`);
  }
  // The saved flag is PROJECT-level (written by whichever workflow ran last):
  // a lean docs-to-ui run on the same project must not flip the docs-to-prd
  // tab to lean.
  assert.equal(resolveRunMode(true, {}, prd.pipelineIds), 'full');
  const leanPrd = listPipelineStatus({}, prd.pipelineIds, 'lean');
  for (const id of prd.pipelineIds) {
    assert.equal(viewOf(leanPrd, id).skipped, undefined, `${id} must never read "Bỏ qua"`);
  }
});

test('lean mode: a finished lean chain leaves the UI terminals runnable (docs-only gate: mode no longer matters at all)', () => {
  const state = leanDoneState();
  // The bug's original shape (ux-review idle) used to lock ui-html under
  // full-mode gating; under the 2026-08 docs-only gate, `mode` is inert —
  // docs succeeded is the only thing computeActive reads, so full and lean
  // read identically here.
  assert.equal(computeActive(state, def('ui-html'), 'full'), true);
  assert.equal(computeActive(state, def('ui-html'), 'lean'), true);
  assert.equal(computeActive(state, def('ui-react'), 'lean'), true);
  // A skipped stage stays runnable on its own — "chạy bổ sung" must work.
  assert.equal(computeActive(state, def('ux-review'), 'lean'), true);
});

test('listPipelineStatus flags the lean-skipped stages and unlocks their dependants', () => {
  const ids = WORKFLOWS[0]!.pipelineIds;
  const lean = listPipelineStatus(leanDoneState(), ids, 'lean');
  for (const id of ['cj', 'ux-research', 'ux-review']) {
    assert.equal(viewOf(lean, id).skipped, true, `${id} should be flagged skipped`);
  }
  assert.equal(viewOf(lean, 'docs').skipped, undefined);
  assert.equal(viewOf(lean, 'ux').skipped, undefined);
  assert.equal(viewOf(lean, 'ui-html').active, true);
  // The mode's real gate lands in effectiveDependsOn, so the lock copy can only
  // ever name a stage this mode actually runs.
  assert.deepEqual(viewOf(lean, 'ui-html').effectiveDependsOn, ['ux']);
  assert.deepEqual(viewOf(lean, 'ui-react').effectiveDependsOn, ['ux']);
  // A stage whose gate is unchanged by the mode omits the field entirely.
  assert.equal(viewOf(lean, 'docs-map').effectiveDependsOn, undefined);
});

test('lean mode must NOT rewrite dependsOn — its identity is the stepper grouping key', () => {
  // Regression: the stepper fuses CONSECUTIVE pipelines sharing an identical
  // dependsOn list into one option-group "UI-Spec" step. An earlier fix
  // rewrote dependsOn to the effective gate, which collapsed cj/ux-research/ux
  // onto ['docs-map'] and ux-review/ui-html/ui-react onto ['ux'] — the stepper
  // rendered two phantom three-option "UI-Spec" cards. dependsOn must stay the
  // STATIC registry list in every mode; the effective gate travels separately.
  const lean = listPipelineStatus(leanDoneState(), WORKFLOWS[0]!.pipelineIds, 'lean');
  for (const id of WORKFLOWS[0]!.pipelineIds) {
    assert.deepEqual(viewOf(lean, id).dependsOn, def(id).dependsOn, `${id} dependsOn must stay static`);
  }
  // The one legitimate group survives: both UI terminals share ['ux-review'].
  assert.deepEqual(viewOf(lean, 'ui-html').dependsOn, ['ux-review']);
  assert.deepEqual(viewOf(lean, 'ui-react').dependsOn, ['ux-review']);
});

test('full mode is untouched: no skipped flags; dependsOn/effectiveDependsOn stay unchanged — but active now comes from the docs-only gate, not from ux-review', () => {
  const full = listPipelineStatus(leanDoneState(), WORKFLOWS[0]!.pipelineIds);
  assert.equal(viewOf(full, 'ux-review').skipped, undefined);
  // docs succeeded (see leanDoneState) → ui-html is active regardless of
  // ux-review's own status or of mode.
  assert.equal(viewOf(full, 'ui-html').active, true);
  assert.deepEqual(viewOf(full, 'ui-html').dependsOn, ['ux-review']);
  assert.equal(viewOf(full, 'ui-html').effectiveDependsOn, undefined);
});

test('resolveRunMode: saved flag wins; legacy lean runs are inferred from state', () => {
  const ids = WORKFLOWS[0]!.pipelineIds;
  // Saved mode is authoritative in both directions.
  assert.equal(resolveRunMode(true, {}, ids), 'lean');
  assert.equal(resolveRunMode(false, leanDoneState(), ids), 'full');
  // Legacy (nothing saved): a UI terminal succeeded while the analysis stages
  // never ran — only a lean chain can produce that, so infer lean. This is the
  // exact "React: Done yet Locked — finish UX Heuristic Review first" screen.
  assert.equal(resolveRunMode(undefined, leanDoneState(), ids), 'lean');
  // Fresh project → full.
  assert.equal(resolveRunMode(undefined, {}, ids), 'full');
  // Full chain done → full.
  const fullDone: ProjectPipelineState = Object.fromEntries(
    ids.map((id) => [id, { status: 'succeeded' as const }]),
  );
  assert.equal(resolveRunMode(undefined, fullDone, ids), 'full');
  // Mid-full-run (analysis stage running) → full, even before anything downstream.
  assert.equal(
    resolveRunMode(
      undefined,
      { docs: { status: 'succeeded' }, 'docs-map': { status: 'succeeded' }, cj: { status: 'running' } },
      ids,
    ),
    'full',
  );
  // An analysis stage that FAILED also proves the chain included it → full.
  assert.equal(
    resolveRunMode(
      undefined,
      { docs: { status: 'succeeded' }, 'docs-map': { status: 'succeeded' }, cj: { status: 'failed' } },
      ids,
    ),
    'full',
  );
});

test('isTargetScopedWfDir: only <workflow>/<known-target> counts as target-scoped', () => {
  assert.equal(isTargetScopedWfDir(null), false);
  assert.equal(isTargetScopedWfDir(undefined), false);
  assert.equal(isTargetScopedWfDir('docs-to-ui'), false);
  assert.equal(isTargetScopedWfDir('docs-to-ui/mobile'), true);
  assert.equal(isTargetScopedWfDir('docs-to-ui/web-user'), true);
  assert.equal(isTargetScopedWfDir('docs-to-ui/web-backoffice'), true);
  // A non-target second segment (a stage output folder) is NOT a target scope.
  assert.equal(isTargetScopedWfDir('docs-to-ui/react-ds'), false);
});

// THE multi-target data-loss invariant: stagesForOutput strips the target
// segment for attribution, so without the fence a re-run of one target's stage
// would also delete every OTHER target's outputs of the same stage.
test('relClearedByRegen: a target-scoped run clears only its own target subtree', () => {
  const regen = new Set(['ui-react-ds']);
  // Own target subtree → cleared.
  assert.equal(
    relClearedByRegen('docs-to-ui/mobile/react-ds/src/App.tsx', regen, 'docs-to-ui/mobile'),
    true,
  );
  // A SIBLING target's outputs of the same stage → NEVER cleared by this run.
  assert.equal(
    relClearedByRegen('docs-to-ui/web-user/react-ds/src/App.tsx', regen, 'docs-to-ui/mobile'),
    false,
  );
  // Legacy shared-root outputs stay untouched by a target-scoped run too.
  assert.equal(
    relClearedByRegen('docs-to-ui/react-ds/dist/index.html', regen, 'docs-to-ui/mobile'),
    false,
  );
  // Upstream inputs are never cleared regardless of fence.
  assert.equal(
    relClearedByRegen('docs-to-ui/mobile/ux/foo-ux-spec.json', regen, 'docs-to-ui/mobile'),
    false,
  );
  // Cascade: the target run with downstream scope clears its own ux + react-ds.
  const cascade = new Set(['ux', 'ux-review', 'ui-react-ds']);
  assert.equal(
    relClearedByRegen('docs-to-ui/mobile/ux/foo-ux-spec.json', cascade, 'docs-to-ui/mobile'),
    true,
  );
  assert.equal(
    relClearedByRegen('docs-to-ui/web-user/ux/foo-ux-spec.json', cascade, 'docs-to-ui/mobile'),
    false,
  );
});

test('relClearedByRegen: legacy single-build behavior is unchanged', () => {
  const regen = new Set(['ui-react-ds']);
  // Workflow-root run (no target segment) clears the workflow-root outputs…
  assert.equal(
    relClearedByRegen('docs-to-ui/react-ds/src/App.tsx', regen, 'docs-to-ui'),
    true,
  );
  // …and history snapshots are always exempt.
  assert.equal(relClearedByRegen('_v/v3/docs-to-ui/react-ds/x.tsx', regen, 'docs-to-ui'), false);
});

test('pickRunTarget: single-stage target resolution rules', () => {
  // Single build (no targets.json): no target, and requesting one is an error.
  assert.equal(pickRunTarget([], undefined), null);
  assert.throws(() => pickRunTarget([], 'mobile'), /multi-target/);
  // Exactly one configured target → auto-selected.
  assert.equal(pickRunTarget(['mobile'], undefined), 'mobile');
  // Several configured → the caller must pick one.
  assert.throws(() => pickRunTarget(['mobile', 'web-user'], undefined), /chỉ định target/);
  assert.equal(pickRunTarget(['mobile', 'web-user'], 'web-user'), 'web-user');
  // A target outside the configured set is rejected.
  assert.throws(() => pickRunTarget(['mobile'], 'web-user'), /không nằm trong/);
});

// ── Workflow.stages regression ──────────────────────────────────────────────
// The web stage picker (apps/web/src/components/pipelines/PipelineModals.tsx)
// used to hand-mirror PIPELINE_DEFS' names into a static
// PIPELINE_STAGE_NAMES map, which could silently rot the moment this registry
// changed. `Workflow.stages` replaces it — this test is the regression that
// keeps the two lists from drifting apart again: every workflow must expose a
// name for EVERY one of its pipelineIds, in the same order.
test('every workflow exposes a Workflow.stages entry (id + name) for every pipelineId, in order', () => {
  for (const wf of WORKFLOWS) {
    assert.ok(wf.stages, `workflow ${wf.id} should carry a stages list`);
    assert.deepEqual(
      wf.stages!.map((s) => s.id),
      wf.pipelineIds,
      `workflow ${wf.id}: stages ids must match pipelineIds, in order`,
    );
    for (const s of wf.stages!) {
      const registryName = def(s.id).name;
      assert.equal(s.name, registryName, `workflow ${wf.id} stage ${s.id}: name must come from PIPELINE_DEFS`);
      assert.ok(s.name && s.name.length > 0, `workflow ${wf.id} stage ${s.id} should have a non-empty name`);
    }
  }
});

// ── Chọn BƯỚC để chạy (`stageIds`) ──────────────────────────────────────────
// Người dùng tick tay từng bước trong panel cấu hình. Đây là phạm vi được NÊU
// THẲNG, khác hẳn `lean`/`skipSucceeded` vốn là hai cách SUY RA phạm vi — nên
// khi có nó, hai cái kia không được nói thêm câu nào.
//
// Rủi ro chính mà bộ test này canh: run-all gọi thẳng runPipeline và KHÔNG hỏi
// gating (chú thích trong runWorkflowAll, server.ts), nên một lựa chọn thiếu
// phụ thuộc KHÔNG bị chặn ở tầng chạy — nó chạy thật với input rỗng và cho ra
// rác trông như thành công. `missingDependencies` là chỗ duy nhất chặn được.

const UI_IDS = WORKFLOWS[0]!.pipelineIds;

function succeededState(...ids: string[]): ProjectPipelineState {
  return Object.fromEntries(ids.map((id) => [id, { status: 'succeeded' as const }]));
}

test('stageIds: chạy đúng các bước được tick, theo THỨ TỰ WORKFLOW chứ không theo thứ tự gửi', () => {
  // Người dùng tick lộn xộn (ux-review trước docs) — chuỗi run-all chạy tuần
  // tự, nên giữ thứ tự gửi sẽ cho bước sau chạy trước input của nó. Dùng
  // `ux-review` (không held) thay vì một terminal UI-Spec — xem test riêng
  // "held stages: selectRunStages luôn lọc bỏ" bên dưới cho hành vi held.
  assert.deepEqual(
    selectRunStages(UI_IDS, { stageIds: ['ux-review', 'ux', 'docs'] }),
    ['docs', 'ux', 'ux-review'],
  );
  // Trùng lặp / thứ tự đảo không đổi kết quả.
  assert.deepEqual(
    selectRunStages(UI_IDS, { stageIds: ['ux-review', 'docs-map', 'ux-review'] }),
    ['docs-map', 'ux-review'],
  );
});

test('stageIds THẮNG lean: bước lean-skipped vẫn chạy khi được tick', () => {
  // `cj` và `ux-research` đều là skippedInLeanRun — lean một mình sẽ bỏ chúng.
  // Ba terminal UI-Spec (`ui-html`/`ui-react`/`ui-react-ds`) bị `selectRunStages`
  // tự lọc bỏ vì đang held (2026-08 hold, HELD_STAGE_IDS) — không liên quan lean.
  assert.deepEqual(
    selectRunStages(UI_IDS, { lean: true }),
    ['docs', 'docs-map', 'ux'],
  );
  // Tick tay đúng hai bước đó + lean bật → vẫn chạy cả hai.
  assert.deepEqual(
    selectRunStages(UI_IDS, { stageIds: ['cj', 'ux-research'], lean: true }),
    ['cj', 'ux-research'],
  );
});

test('stageIds THẮNG skipSucceeded: tick lại một bước đã xong nghĩa là muốn CHẠY LẠI nó', () => {
  const state = succeededState('docs', 'docs-map', 'cj');
  // skipSucceeded một mình bỏ ba bước đã xong…
  assert.deepEqual(
    selectRunStages(['docs', 'docs-map', 'cj', 'ux-research'], { skipSucceeded: true, state }),
    ['ux-research'],
  );
  // …nhưng khi người dùng tự tick, lựa chọn tường minh của họ thắng.
  assert.deepEqual(
    selectRunStages(UI_IDS, { stageIds: ['docs', 'cj'], skipSucceeded: true, state }),
    ['docs', 'cj'],
  );
  // Cả hai cờ cùng bật cũng không nói thêm được gì.
  assert.deepEqual(
    selectRunStages(UI_IDS, { stageIds: ['cj'], lean: true, skipSucceeded: true, state }),
    ['cj'],
  );
});

test('docsFromUpload VẪN lọc bước ingest kể cả khi người dùng tick đúng nó', () => {
  const dr = WORKFLOWS.find((w) => w.id === 'docs-review')!.pipelineIds;
  assert.equal(def('dr-docs').acceptsUpload, true, 'dr-docs là bước ingest nhận upload');
  // Nhánh cũ (không stageIds).
  assert.deepEqual(
    selectRunStages(dr, { docsFromUpload: true }),
    ['dr-flow', 'dr-comp', 'dr-review'],
  );
  // Nhánh tick tay: chạy lại ingest sẽ XOÁ SẠCH tài liệu vừa tải lên (output
  // khai báo của nó chính là docs/), nên việc người dùng lỡ tick không làm điều
  // đó bớt phá hoại — bước ingest vẫn bị loại.
  assert.deepEqual(
    selectRunStages(dr, { stageIds: ['dr-docs', 'dr-comp', 'dr-flow'], docsFromUpload: true }),
    ['dr-flow', 'dr-comp'],
  );
  // Không có cờ upload thì bước ingest được tick vẫn chạy bình thường.
  assert.deepEqual(
    selectRunStages(dr, { stageIds: ['dr-docs', 'dr-comp'] }),
    ['dr-docs', 'dr-comp'],
  );
});

test('stageIds vắng mặt → hành vi cũ KHÔNG đổi (lưới an toàn cho tương thích ngược), TRỪ held (2026-08 hold — xem test riêng bên dưới)', () => {
  // Không cờ nào: cả workflow, nguyên thứ tự — trừ 3 terminal UI-Spec held.
  assert.deepEqual(
    selectRunStages(UI_IDS, {}),
    UI_IDS.filter((id) => !HELD_STAGE_IDS.includes(id as (typeof HELD_STAGE_IDS)[number])),
  );
  // stageIds rỗng cũng là "vắng mặt" — không được hiểu thành "không chạy gì".
  assert.deepEqual(
    selectRunStages(UI_IDS, { stageIds: [] }),
    UI_IDS.filter((id) => !HELD_STAGE_IDS.includes(id as (typeof HELD_STAGE_IDS)[number])),
  );
  assert.deepEqual(
    selectRunStages(UI_IDS, { stageIds: [], lean: true }),
    ['docs', 'docs-map', 'ux'],
  );
  // lean + skipSucceeded vẫn cộng dồn như trước.
  assert.deepEqual(
    selectRunStages(UI_IDS, { lean: true, skipSucceeded: true, state: succeededState('docs', 'docs-map') }),
    ['ux'],
  );
});

test('missingDependencies: bước được tick mà tài liệu (bước ingest) của workflow đó chưa sẵn sàng → luôn báo thiếu đúng bước ingest (2026-08 docs-only gate)', () => {
  // Chọn mỗi UI-Spec trên một project trắng: run-all sẽ chạy nó thật, đọc thư
  // mục ux rỗng, và trả về "thành công" — đây là chỗ duy nhất chặn được.
  assert.deepEqual(missingDependencies(['ui-html'], {}), [{ stage: 'ui-html', missing: ['docs'] }]);
  // Nhiều bước được chọn cùng lúc mà tài liệu vẫn chưa sẵn sàng → MỖI bước báo
  // thiếu đúng bước ingest (docs) — không còn báo một bước trung gian
  // (ux-research) như mô hình theo-BƯỚC cũ.
  assert.deepEqual(
    missingDependencies(['ux', 'ui-html'], {}),
    [
      { stage: 'ux', missing: ['docs'] },
      { stage: 'ui-html', missing: ['docs'] },
    ],
  );
  // dr-review (workflow khác) giờ chỉ còn thiếu ĐÚNG bước ingest của NÓ
  // (dr-docs) — không còn ba phụ thuộc (dr-docs, dr-comp, dr-flow) như cũ,
  // vì dr-comp/dr-flow không còn gate gì.
  assert.deepEqual(
    missingDependencies(['dr-review'], {}),
    [{ stage: 'dr-review', missing: ['dr-docs'] }],
  );
});

test('missingDependencies: tài liệu (bước ingest) ĐÃ succeeded hoặc được chọn cùng → hợp lệ', () => {
  // (a) bước ingest (docs) đã chạy xong từ trước — dù ux-review/cj/… chưa
  // từng chạy.
  assert.deepEqual(missingDependencies(['ui-html'], succeededState('docs')), []);
  // (b) được tick cùng trong lần chạy này — docs nằm trong tập được chọn nên
  // tự thoả, dù state hoàn toàn rỗng.
  assert.deepEqual(
    missingDependencies(['docs', 'docs-map', 'cj', 'ux-research', 'ux', 'ux-review', 'ui-html'], {}),
    [],
  );
  // Trộn cả hai nguồn: docs đã xong sẵn, phần còn lại tick tay.
  assert.deepEqual(
    missingDependencies(['cj', 'ux-research', 'ux'], succeededState('docs')),
    [],
  );
  // Bước ingest tự nó luôn hợp lệ (không bao giờ báo thiếu chính nó).
  assert.deepEqual(missingDependencies(['docs'], {}), []);
});

test('missingDependencies: mode không còn ảnh hưởng gì — chỉ còn xét tài liệu (bước ingest) đã sẵn sàng hay chưa (2026-08 docs-only gate)', () => {
  // docs đã xong → không còn thiếu gì ở CẢ HAI mode, bất kể ux-review có bao
  // giờ chạy hay không (mode/`effectiveDependsOn` không còn được đọc ở đây).
  const state = succeededState('docs', 'docs-map', 'ux');
  assert.deepEqual(missingDependencies(['ui-html'], state, 'lean'), []);
  assert.deepEqual(missingDependencies(['ui-html'], state, 'full'), []);
  // Ngược lại: tài liệu CHƯA sẵn sàng thì thiếu giống hệt nhau ở cả hai mode.
  assert.deepEqual(missingDependencies(['ui-html'], {}, 'lean'), [{ stage: 'ui-html', missing: ['docs'] }]);
  assert.deepEqual(missingDependencies(['ui-html'], {}, 'full'), [{ stage: 'ui-html', missing: ['docs'] }]);
});

test('validateRunStageSelection: id lạ bị từ chối, nêu đích danh id sai', () => {
  const bogus = validateRunStageSelection(['docs', 'khong-co-that'], UI_IDS, {});
  assert.equal(bogus.ok, false);
  assert.match((bogus as { error: string }).error, /khong-co-that/);
  // Id CÓ THẬT nhưng thuộc workflow khác cũng là id lạ ở đây: docs-to-prd hoàn
  // toàn độc lập, không bước nào của nó chạy được trong docs-to-ui.
  const foreign = validateRunStageSelection(['prd-cj'], UI_IDS, {}, { workflowName: 'Docs → UI-Spec' });
  assert.equal(foreign.ok, false);
  assert.match((foreign as { error: string }).error, /prd-cj/);
  assert.match((foreign as { error: string }).error, /Docs → UI-Spec/);
});

test('validateRunStageSelection: thiếu tài liệu → lỗi tiếng Việt trỏ đích danh về bước INGEST, không bao giờ về một bước trung gian (2026-08 docs-only gate)', () => {
  const res = validateRunStageSelection(['ux'], UI_IDS, {});
  assert.equal(res.ok, false);
  // Thông báo phải dùng TÊN người dùng nhìn thấy trên stepper, và luôn trỏ về
  // bước ingest ("Tài liệu (nạp)") — không còn nêu tên một bước trung gian
  // (docs-map/ux-research) như mô hình theo-BƯỚC cũ.
  assert.equal(
    (res as { error: string }).error,
    'Bước "UX Spec" cần tài liệu — chạy bước "Tài liệu (nạp)" trước.',
  );
  // Tài liệu đã sẵn sàng (docs succeeded) → qua, dù docs-map/cj/ux-research
  // chưa từng chạy.
  assert.deepEqual(validateRunStageSelection(['ux'], UI_IDS, succeededState('docs')), { ok: true });
  // …và chọn kèm bước ingest trong cùng lần chạy cũng qua.
  assert.deepEqual(validateRunStageSelection(['docs', 'ux'], UI_IDS, {}), { ok: true });
});

// Bug: `POST /api/pipelines/run-all` gate theo mode CỦA LẦN CHẠY TRƯỚC (đọc từ
// `project.metadata.runAllConfig` đã lưu) thay vì mode của CHÍNH request này —
// một project chạy lần đầu (chưa có config lưu) suy ra `full`, nên bật lean rồi
// tick đúng tập bước lean bị 400 vì `ux` gate vào `ux-research` (bước lean bỏ
// qua). `validateRunStageSelection` tự nó đã đúng (đây là chỗ effectiveDependsOn
// thu cổng); các test dưới đây khoá hành vi `mode` truyền vào đúng như vậy,
// không phải hành vi mà route gọi sai.
test('validateRunStageSelection: mode lean + tập bước lean của docs-to-ui trên state rỗng → hợp lệ', () => {
  // Tập bước lean = docs-to-ui bỏ cj/ux-research/ux-review (khớp
  // selectRunStages({ lean: true }) ở test phía trên).
  const leanStageIds = ['docs', 'docs-map', 'ux', 'ui-html', 'ui-react', 'ui-react-ds'];
  assert.deepEqual(validateRunStageSelection(leanStageIds, UI_IDS, {}, { mode: 'lean' }), { ok: true });
});

test('validateRunStageSelection: mode không còn ảnh hưởng — tập bước lean (kèm docs) trên state rỗng vẫn hợp lệ dù mode là full (2026-08 docs-only gate)', () => {
  // `docs` (bước ingest) NẰM TRONG tập được chọn nên tự thoả — mode không còn
  // được đọc để gate, nên full và lean cho cùng một kết quả ở đây.
  const leanStageIds = ['docs', 'docs-map', 'ux', 'ui-html', 'ui-react', 'ui-react-ds'];
  const res = validateRunStageSelection(leanStageIds, UI_IDS, {}, { mode: 'full' });
  assert.deepEqual(res, { ok: true });
});

test('validateRunStageSelection: mode lean nhưng thiếu phụ thuộc THẬT → vẫn từ chối', () => {
  // Chọn `ux` mà không chọn docs/docs-map và state rỗng: lean vẫn cần docs-map
  // (effectiveDependsOn của ux dưới lean vẫn là docs-map — lean chỉ thu cổng
  // qua các bước `skippedInLeanRun`, không xoá phụ thuộc thật).
  const res = validateRunStageSelection(['ux'], UI_IDS, {}, { mode: 'lean' });
  assert.equal(res.ok, false);
});

// Bug: `runAllConfig` đã lưu có `lean: false` NHƯNG `stageIds` đúng bằng tập
// lean (project cũ lưu lệch, hoặc UI ghi thiếu field) — gate cũ đọc `mode` từ
// `lean` nên tính ra `full`, khoá `ux` vào `ux-research` dù người dùng đã bỏ
// tick nó tường minh, và route trả 400 vĩnh viễn. `explicitSelection: true`
// (nay LUÔN bật ở pipeline-routes.ts cho nhánh `stageIds` tick tay) sửa việc
// này: một bước `skippedInLeanRun` không được chọn và chưa `succeeded` được
// thay bằng chính phụ thuộc của nó, BẤT KỂ `mode` là gì — xem
// `explicitSelectionDependsOn` trong pipelines.ts.
test('validateRunStageSelection: BUG THẬT — lean:false + stageIds đúng bằng tập lean, docs/docs-map đã succeeded → hợp lệ', () => {
  const leanStageIds = ['docs', 'docs-map', 'ux', 'ui-html', 'ui-react', 'ui-react-ds'];
  const res = validateRunStageSelection(
    leanStageIds,
    UI_IDS,
    succeededState('docs', 'docs-map'),
    { mode: 'full', explicitSelection: true },
  );
  assert.deepEqual(res, { ok: true });
});

test('validateRunStageSelection: cùng bug trên state RỖNG (docs/docs-map cũng được tick cùng) → vẫn hợp lệ', () => {
  // docs/docs-map chưa succeeded, nhưng chúng NẰM TRONG tập được chọn nên tự
  // thoả — không cần state trước đó.
  const leanStageIds = ['docs', 'docs-map', 'ux', 'ui-html', 'ui-react', 'ui-react-ds'];
  const res = validateRunStageSelection(leanStageIds, UI_IDS, {}, { mode: 'full', explicitSelection: true });
  assert.deepEqual(res, { ok: true });
});

test('validateRunStageSelection: chọn MỖI ux, state rỗng → vẫn từ chối, và bước thiếu LUÔN là bước ingest (docs) — không phải docs-map hay ux-research (2026-08 docs-only gate)', () => {
  // mode/explicitSelection giữ trong chữ ký nhưng không còn ảnh hưởng kết quả
  // — thiếu luôn là bước ingest của workflow, không bao giờ một bước trung
  // gian (docs-map/ux-research).
  const res = validateRunStageSelection(['ux'], UI_IDS, {}, { mode: 'full', explicitSelection: true });
  assert.equal(res.ok, false);
  const msg = (res as { error: string }).error;
  assert.match(msg, /Tài liệu \(nạp\)/); // tên hiển thị của docs — bước ingest
  assert.doesNotMatch(msg, /Bản đồ hệ thống/);
  assert.doesNotMatch(msg, /UX Research/);
});

// Ca dễ nhầm: `cj` được chọn (không phải chỉ tick mỗi `ux`) nhưng `ux-research`
// — phụ thuộc TRỰC TIẾP của `ux` — thì không. Theo ba điều kiện của luật mới,
// `ux-research` (skippedInLeanRun, không được chọn, chưa succeeded) được thay
// bằng chính phụ thuộc của NÓ là `cj` — và `cj` LÀ một phần của tập được chọn
// lần này, nên nó tự thoả (đúng quy tắc nền đã có từ trước: một phụ thuộc được
// tick CÙNG lần chạy này luôn hợp lệ, không cần đã `succeeded`). Kết quả đúng
// theo luật là ok:true, KHÔNG PHẢI báo thiếu `ux-research` — dù trực giác ban
// đầu có thể nghĩ ngược lại, vì cj chạy trước ux trong thứ tự workflow nên ux
// vẫn có một đầu vào thật (customer journey) để đọc, đúng tinh thần "ux-spec
// carry on khi research vắng mặt" mà docblock của ux-research đã nêu.
test('validateRunStageSelection: chọn docs+docs-map+cj+ux (bỏ ux-research) trên state rỗng → hợp lệ vì cj được chọn cùng', () => {
  const res = validateRunStageSelection(
    ['docs', 'docs-map', 'cj', 'ux'],
    UI_IDS,
    {},
    { mode: 'full', explicitSelection: true },
  );
  assert.deepEqual(res, { ok: true });
});

test('validateRunStageSelection: mode lean qua đường explicitSelection (đường production thật) vẫn hợp lệ như trước — không hồi quy', () => {
  const leanStageIds = ['docs', 'docs-map', 'ux', 'ui-html', 'ui-react', 'ui-react-ds'];
  assert.deepEqual(
    validateRunStageSelection(leanStageIds, UI_IDS, {}, { mode: 'lean', explicitSelection: true }),
    { ok: true },
  );
  // Đường cũ (không truyền explicitSelection) không hồi quy: hành vi y hệt các
  // test 'mode lean …' phía trên.
  assert.deepEqual(
    validateRunStageSelection(leanStageIds, UI_IDS, {}, { mode: 'lean' }),
    { ok: true },
  );
});

// ── WP1 (2026-08 web-first hold): 3 stage sinh code UI-Spec KHÔNG chạy được
// nữa từ bất kỳ ngả nào (UI, API, CLI, run-all) — output cũ giữ nguyên mọi
// hành vi khác (registry, attribution, syncExclude, clear-on-rerun). Xem
// `HELD_STAGE_IDS` / `PipelineDef.heldFromRun` trong pipelines.ts.
test('HELD_STAGE_IDS: đúng 3 terminal UI-Spec, và PIPELINE_DEFS đánh dấu heldFromRun đúng những id đó — không id nào khác', () => {
  assert.deepEqual([...HELD_STAGE_IDS].sort(), ['ui-html', 'ui-react', 'ui-react-ds'].sort());
  for (const d of PIPELINE_DEFS) {
    const shouldBeHeld = (HELD_STAGE_IDS as readonly string[]).includes(d.id);
    assert.equal(
      d.heldFromRun === true,
      shouldBeHeld,
      `${d.id}: heldFromRun phải khớp HELD_STAGE_IDS (mong đợi ${shouldBeHeld})`,
    );
  }
});

test('selectRunStages: held stages KHÔNG BAO GIỜ lọt vào kế hoạch, kể cả khi được tick tường minh (defense-in-depth — route đã 400 trước khi tới đây)', () => {
  // Nhánh automatic (không stageIds) — đã canh ở test "vắng mặt" phía trên;
  // ở đây canh THÊM nhánh manual (stageIds tick tay chứa held id).
  assert.deepEqual(
    selectRunStages(UI_IDS, { stageIds: ['ux-review', 'ui-html', 'ui-react', 'ui-react-ds'] }),
    ['ux-review'],
  );
  // Tick CHỈ một held id → kế hoạch rỗng, không phải [id đó].
  assert.deepEqual(selectRunStages(UI_IDS, { stageIds: ['ui-html'] }), []);
});

test('listPipelineStatus: phát held:true đúng 3 view UI-Spec, không phát cho stage khác — orthogonal với active/skipped', () => {
  const state: ProjectPipelineState = { docs: { status: 'succeeded' } };
  const views = listPipelineStatus(state, UI_IDS, 'full');
  for (const id of ['ui-html', 'ui-react', 'ui-react-ds']) {
    const v = viewOf(views, id);
    assert.equal(v.held, true, `${id} phải mang held:true`);
    // held không thay thế active: docs đã succeeded nên UI-Spec vẫn active
    // (docs-only gate) — chỉ route mới chặn spawn, không phải view này.
    assert.equal(v.active, true, `${id} vẫn active dù held`);
  }
  for (const id of ['docs', 'docs-map', 'cj', 'ux-research', 'ux', 'ux-review']) {
    assert.equal(viewOf(views, id).held, undefined, `${id} không được mang held`);
  }
});

test('progress denominator: docs-to-ui có 9 stage đăng ký nhưng chỉ 6 KHÔNG held — mẫu số run-all/CLI cũng phải đọc 6 (xem pipeline-routes.test tương ứng)', () => {
  const nonHeld = UI_IDS.filter((id) => !getPipelineDef(id)?.heldFromRun);
  assert.equal(UI_IDS.length, 9);
  assert.equal(nonHeld.length, 6);
  assert.deepEqual(nonHeld, ['docs', 'docs-map', 'cj', 'ux-research', 'ux', 'ux-review']);
});

test('output react/ CŨ vẫn attribution đúng stage + vẫn syncExcluded dù ui-react đang held (hold chỉ chặn RUN, không đụng gì khác)', () => {
  // stagesForOutput vẫn chấm đúng ui-react cho file trong react/ — không mồ côi.
  assert.deepEqual(stagesForOutput('docs-to-ui/react/src/App.tsx').map((d) => d.id), ['ui-react']);
  assert.deepEqual(stagesForOutput('docs-to-ui/prototype/index.html').map((d) => d.id), ['ui-html']);
  assert.deepEqual(stagesForOutput('docs-to-ui/react-ds/dist/index.html').map((d) => d.id), ['ui-react-ds']);
  // syncExclude vẫn áp dụng y hệt trước — react/dist/ KHÔNG bị exclude (nó
  // round-trip), nhưng react/package.json (template scaffold) vẫn bị exclude.
  assert.equal(isSyncExcluded('docs-to-ui/react/dist/index.html'), false);
  assert.equal(isSyncExcluded('docs-to-ui/react/package.json'), true);
  assert.equal(isSyncExcluded('docs-to-ui/react-ds/src/ds/button.tsx'), true);
  // relClearedByRegen vẫn xoá react/ khi CHÍNH ui-react được re-run (giả định
  // sản phẩm mở lại rồi khoá lại sau) — clear-on-rerun không đổi hành vi.
  assert.equal(
    relClearedByRegen('docs-to-ui/react/src/App.tsx', new Set(['ui-react']), 'docs-to-ui'),
    true,
  );
});

// ── ds-lab: WP-kit (2026-08-22) — 5-stage workflow, lab-map → lab-kit-plan →
// lab-kit ─────────────────────────────────────────────────────────────────
// WP-kit-regen (.tmp/pipeline/wp-kit-regen.yaml, 2026-08-22): kit/kit.json
// đổi ngữ nghĩa từ "registry bền ngoài outputs" sang "output khai báo bình
// thường" — Chạy lại lab-kit nay gen lại từ đầu, dọn cả kit/kit.json.
// WP-kit-plan (.tmp/pipeline/wp-kit-plan.yaml, 2026-08-22): thêm stage cổng
// duyệt "Đề xuất kit" (lab-kit-plan) đứng TRƯỚC lab-kit; lab-kit dependsOn
// thêm lab-kit-plan.
// WP-lab-map (.tmp/pipeline/wp-lab-map.yaml, 2026-08-23): thêm stage CHỈ ĐỌC
// "Bản đồ màn" (lab-map) đứng NGAY SAU lab-docs, TRƯỚC lab-kit-plan — 4-stage
// trở thành 5-stage. lab-kit-plan/lab-compose's dependsOn KHÔNG đổi (bản đồ
// là ưu tiên khi có, không phải điều kiện cứng — cùng tinh thần lab-kit).
// WP-lab-reorder (.tmp/pipeline/wp-lab-reorder.yaml, 2026-08-23): ĐẢO thứ tự
// thành lab-docs → lab-map → lab-compose → lab-kit-plan → lab-kit — "Sáng
// tác màn" chạy NGAY sau "Bản đồ màn" (màn = bằng chứng thật); "Đề xuất kit"
// (lab-kit-plan) đổi vai QUÉT MÀN ĐÃ DUYỆT, `dependsOn` THÊM `lab-compose`,
// `outputs` THÊM `kit-candidates.json`/`kit-candidates/`; "Nâng bộ comp" đổi
// tên hiển thị thành "Đóng gói comp" (id/skillId/dependsOn/outputs KHÔNG
// đổi).

test('ds-lab: 5-stage workflow in order (lab-docs → lab-map → lab-compose → lab-kit-plan → lab-kit)', () => {
  const wf = getWorkflow('ds-lab');
  assert.ok(wf, 'ds-lab workflow should exist');
  assert.deepEqual(wf!.pipelineIds, ['lab-docs', 'lab-map', 'lab-compose', 'lab-kit-plan', 'lab-kit']);
  assert.deepEqual(
    wf!.stages.map((s) => s.id),
    ['lab-docs', 'lab-map', 'lab-compose', 'lab-kit-plan', 'lab-kit'],
  );

  assert.equal(getPipelineDef('lab-map')?.skillId, 'lab-map');
  assert.equal(getPipelineDef('lab-map')?.name, 'Bản đồ màn');
  assert.deepEqual(getPipelineDef('lab-map')?.dependsOn, ['lab-docs']);
  assert.deepEqual(getPipelineDef('lab-map')?.outputs, ['screen-map.json', 'screen-map.md']);
  assert.equal(getPipelineDef('lab-map')?.inputPlaceholder, 'Luồng/màn cần ưu tiên (tuỳ chọn)');

  assert.deepEqual(getPipelineDef('lab-compose')?.dependsOn, ['lab-docs']);

  assert.equal(getPipelineDef('lab-kit-plan')?.skillId, 'lab-kit-plan');
  assert.equal(getPipelineDef('lab-kit-plan')?.name, 'Đề xuất kit');
  assert.deepEqual(getPipelineDef('lab-kit-plan')?.dependsOn, ['lab-docs', 'lab-compose']);
  assert.deepEqual(getPipelineDef('lab-kit-plan')?.outputs, [
    'kit-plan.json',
    'kit-plan.md',
    'kit-candidates.json',
    'kit-candidates/',
  ]);
  assert.equal(getPipelineDef('lab-kit-plan')?.inputPlaceholder, 'Định hướng đề xuất (tuỳ chọn)');

  assert.equal(getPipelineDef('lab-kit')?.skillId, 'lab-kit-compose');
  assert.equal(getPipelineDef('lab-kit')?.name, 'Đóng gói comp');
  assert.deepEqual(getPipelineDef('lab-kit')?.dependsOn, ['lab-docs', 'lab-kit-plan']);
  assert.deepEqual(getPipelineDef('lab-kit')?.outputs, ['kit-shots/', 'kit-result.json', 'kit/kit.json']);
  assert.equal(getPipelineDef('lab-kit')?.inputPlaceholder, 'Định hướng thẩm mỹ (tuỳ chọn)');
});

test('ds-lab: screen-map.json/screen-map.md attribute to lab-map; re-run lab-kit-plan alone does NOT clear them', () => {
  assert.deepEqual(stagesForOutput('ds-lab/screen-map.json').map((d) => d.id), ['lab-map']);
  assert.deepEqual(stagesForOutput('ds-lab/screen-map.md').map((d) => d.id), ['lab-map']);
  // A re-run of lab-kit-plan ALONE must NOT sweep the map — it is a separate,
  // earlier stage the user re-runs on its own.
  assert.equal(relClearedByRegen('ds-lab/screen-map.json', new Set(['lab-kit-plan']), 'ds-lab'), false);
  // Re-running lab-map itself DOES clear its own declared outputs.
  assert.equal(relClearedByRegen('ds-lab/screen-map.json', new Set(['lab-map']), 'ds-lab'), true);
});

test('ds-lab: lab-map/map-src is NOT a declared output of any stage — never listed, never regen-cleared as an "output"', () => {
  for (const d of PIPELINE_DEFS) {
    for (const pattern of d.outputs ?? []) {
      assert.notEqual(pattern, 'map-src/', `${d.id}.outputs must not declare map-src/`);
    }
  }
  assert.deepEqual(stagesForOutput('ds-lab/map-src/flows/index.json'), []);
});

test('ds-lab: kit-plan.json/kit-plan.md attribute to lab-kit-plan; re-run lab-kit alone does NOT clear them', () => {
  assert.deepEqual(stagesForOutput('ds-lab/kit-plan.json').map((d) => d.id), ['lab-kit-plan']);
  assert.deepEqual(stagesForOutput('ds-lab/kit-plan.md').map((d) => d.id), ['lab-kit-plan']);
  // A re-run of lab-kit ALONE (regenSet = {'lab-kit'}) must NOT sweep the
  // plan — the approval gate is a separate stage the user re-runs on its own.
  assert.equal(relClearedByRegen('ds-lab/kit-plan.json', new Set(['lab-kit']), 'ds-lab'), false);
  // Re-running lab-kit-plan itself DOES clear its own declared outputs.
  assert.equal(relClearedByRegen('ds-lab/kit-plan.json', new Set(['lab-kit-plan']), 'ds-lab'), true);
});

test('ds-lab: kit-candidates.json/kit-candidates/ attribute to lab-kit-plan (WP-lab-reorder daemon tiền-quét)', () => {
  assert.deepEqual(stagesForOutput('ds-lab/kit-candidates.json').map((d) => d.id), ['lab-kit-plan']);
  assert.deepEqual(stagesForOutput('ds-lab/kit-candidates/KC-01.png').map((d) => d.id), ['lab-kit-plan']);
  // Re-running lab-kit-plan itself DOES clear its own tiền-quét output too.
  assert.equal(relClearedByRegen('ds-lab/kit-candidates.json', new Set(['lab-kit-plan']), 'ds-lab'), true);
  // Re-running lab-kit alone must NOT sweep the daemon's own scan output.
  assert.equal(relClearedByRegen('ds-lab/kit-candidates.json', new Set(['lab-kit']), 'ds-lab'), false);
});

test('ds-lab: lab-kit-plan dependsOn lab-compose (WP-lab-reorder) — downstream re-run of lab-compose cascades through lab-kit-plan to lab-kit', () => {
  const cascade = new Set(stageRegenSet('lab-compose', true));
  assert.ok(cascade.has('lab-compose'));
  assert.ok(cascade.has('lab-kit-plan'), 'lab-kit-plan should be stale once lab-compose (the screens it scans) re-runs');
  assert.ok(cascade.has('lab-kit'), 'lab-kit should cascade transitively through lab-kit-plan');
  // Re-running lab-kit-plan alone must NOT sweep lab-compose's own outputs —
  // dependsOn only flows one way (lab-kit-plan depends ON lab-compose, not
  // the other way around).
  assert.equal(relClearedByRegen('ds-lab/screens/SCR-01.png', new Set(['lab-kit-plan']), 'ds-lab'), false);
  assert.equal(relClearedByRegen('ds-lab/lab-result.json', new Set(['lab-kit-plan']), 'ds-lab'), false);
});

test('ds-lab: lab-kit output attribution — kit/kit.json is now a declared output, cleared on re-run', () => {
  assert.deepEqual(stagesForOutput('ds-lab/kit-shots/card-choose-number.png').map((d) => d.id), ['lab-kit']);
  assert.deepEqual(stagesForOutput('ds-lab/kit-result.json').map((d) => d.id), ['lab-kit']);
  // kit/kit.json is now a DECLARED output of lab-kit — no longer survives
  // "Chạy lại" the way lab-compose's patterns/ does.
  assert.deepEqual(stagesForOutput('ds-lab/kit/kit.json').map((d) => d.id), ['lab-kit']);
  assert.equal(
    relClearedByRegen('ds-lab/kit/kit.json', new Set(['lab-kit', 'lab-docs', 'lab-kit-plan', 'lab-compose']), 'ds-lab'),
    true,
  );
  // A re-run of lab-kit DOES clear its own declared outputs.
  assert.equal(
    relClearedByRegen('ds-lab/kit-shots/card-choose-number.png', new Set(['lab-kit']), 'ds-lab'),
    true,
  );
});

test('invariant: every PIPELINE_DEFS id (including lab-kit-plan and lab-kit) belongs to EXACTLY one workflow', () => {
  for (const d of PIPELINE_DEFS) {
    const owners = WORKFLOWS.filter((w) => w.pipelineIds.includes(d.id));
    if (d.id === 'dr-confirm') continue; // documented exception (see lab-compose.test.ts)
    assert.equal(owners.length, 1, `${d.id} should belong to exactly one workflow (found in: ${owners.map((w) => w.id).join(', ') || 'none'})`);
  }
  assert.deepEqual(WORKFLOWS.filter((w) => w.pipelineIds.includes('lab-map')).map((w) => w.id), ['ds-lab']);
  assert.deepEqual(WORKFLOWS.filter((w) => w.pipelineIds.includes('lab-kit-plan')).map((w) => w.id), ['ds-lab']);
  assert.deepEqual(WORKFLOWS.filter((w) => w.pipelineIds.includes('lab-kit')).map((w) => w.id), ['ds-lab']);
});
