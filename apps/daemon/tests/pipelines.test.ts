import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PipelineView, ProjectPipelineState } from '@open-design/contracts';

import {
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
  assert.equal(def('prd-docs').skillId, 'jira-ingest');
  assert.equal(def('prd-cj').skillId, 'customer-journey-spec');
  assert.equal(def('prd-ux-research').skillId, 'ux-research');
  assert.deepEqual(def('prd-cj').dependsOn, ['prd-docs']);
  assert.deepEqual(def('prd-ux-research').dependsOn, ['prd-cj']);
  assert.deepEqual(def('prd-review').dependsOn, ['prd-ux-research']);
  assert.equal(def('prd-review').skillId, 'docs-mockup-review');
  // File-only: never projected into KGS.
  assert.equal(def('prd-review').convertToGraph, undefined);
  assert.deepEqual(def('prd-review').outputs, ['review/']);
  // Each id resolves to docs-to-prd's OWN folder — never docs-to-ui's.
  assert.equal(workflowDirForPipeline('prd-docs'), 'docs-to-prd');
  assert.equal(workflowDirForPipeline('prd-ux-research'), 'docs-to-prd');
  assert.equal(workflowDirForPipeline('prd-review'), 'docs-to-prd');
  // And docs-to-ui's own ids are untouched, still resolving to docs-to-ui.
  assert.equal(workflowDirForPipeline('docs'), 'docs-to-ui');
  assert.equal(workflowDirForPipeline('ux-research'), 'docs-to-ui');
});

test('docs-review: fully independent of docs-to-ui and docs-to-prd — dr-docs -> dr-comp -> dr-flow -> dr-review, docs-to-ui stays WORKFLOWS[0]', () => {
  // docs-to-ui must remain the default workflow — appending docs-review must
  // not disturb WORKFLOWS[0] or DEFAULT_WORKFLOW_ID.
  assert.equal(WORKFLOWS[0]!.id, 'docs-to-ui');
  const wf = WORKFLOWS.find((w) => w.id === 'docs-review');
  assert.ok(wf, 'docs-review workflow should exist');
  assert.deepEqual(wf!.pipelineIds, ['dr-docs', 'dr-comp', 'dr-flow', 'dr-review']);
  assert.equal(def('dr-docs').skillId, 'jira-ingest');
  assert.equal(def('dr-comp').skillId, 'docs-component-audit');
  assert.equal(def('dr-review').skillId, 'docs-spec-review');
  assert.equal(def('dr-flow').skillId, 'docs-flow-extract');
  assert.deepEqual(def('dr-docs').dependsOn, []);
  // dr-comp đọc bản GỐC nên chỉ cần dr-docs; dr-review phải chờ CẢ HAI vì nhóm
  // `component` của nó giờ là đọc lại kết quả dr-comp chứ không tự suy.
  assert.deepEqual(def('dr-comp').dependsOn, ['dr-docs']);
  assert.deepEqual(def('dr-flow').dependsOn, ['dr-docs']);
  // Review là bước CHỐT cuối — chờ đủ cả comp lẫn flow.
  assert.deepEqual(def('dr-review').dependsOn, ['dr-docs', 'dr-comp', 'dr-flow']);
  assert.deepEqual(def('dr-docs').outputs, ['docs/']);
  // comp/ nằm ở gốc workflow-dir, KHÔNG lồng trong review/ — cùng lý do như
  // flows/: lồng vào đó thì re-run dr-review xoá mất, và stagesForOutput chấm
  // hai stage cho cùng một file.
  assert.deepEqual(def('dr-comp').outputs, ['comp/']);
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
  // (App-level doc uploads — POST /api/pipelines/apps/:appId/upload-folder —
  // are a separate, App-scoped corpus, not a per-stage acceptsUpload flag.)
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

test('cj is gated until the system map has succeeded', () => {
  // cj classifies journeys per app, so it waits on docs-map (which itself waits
  // on docs) rather than on the ingest directly.
  assert.deepEqual(def('cj').dependsOn, ['docs-map']);
  assert.equal(computeActive({}, def('cj')), false);
  const ingestOnly: ProjectPipelineState = { docs: { status: 'succeeded' } };
  assert.equal(computeActive(ingestOnly, def('cj')), false);
  const running: ProjectPipelineState = { 'docs-map': { status: 'running' } };
  assert.equal(computeActive(running, def('cj')), false);
  const done: ProjectPipelineState = { 'docs-map': { status: 'succeeded' } };
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
  // docs-map is idle but unlocked — the ingest is its only dependency.
  assert.equal(viewOf(views, 'docs-map').status, 'idle');
  assert.equal(viewOf(views, 'docs-map').active, true);
  // cj waits on the system map, not on the ingest.
  assert.equal(viewOf(views, 'cj').active, false);
  // ux stays locked further down the chain.
  assert.equal(viewOf(views, 'ux').active, false);
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
  // Both ingest stages declare all three ingest folders.
  assert.deepEqual(def('docs').outputs, ['docs/jira/', 'docs/confluence/', 'docs/context/']);
  assert.deepEqual(def('prd-docs').outputs, ['docs/jira/', 'docs/confluence/', 'docs/context/']);
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
  // is ambiguous between docs-to-ui's `docs`, docs-to-prd's `prd-docs`, and
  // docs-review's `dr-docs` (same relative output pattern, independent
  // workflows) — but no legacy unprefixed file can actually be a
  // docs-to-prd/docs-review one (both workflows were introduced after
  // per-workflow folders already existed), and stageForOutput's first-match
  // still resolves to `docs` (declared first).
  assert.deepEqual(stagesForOutput('docs/confluence/x.md').map((d) => d.id), ['docs', 'prd-docs', 'dr-docs']);
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
  // After merge, cj still waits on docs-map — the ingest alone no longer unlocks it.
  assert.equal(computeActive(merged, def('cj')), false);
  assert.equal(computeActive({ ...merged, 'docs-map': { status: 'succeeded' } }, def('cj')), true);
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

test('lean mode: a finished lean chain leaves the UI terminals runnable', () => {
  const state = leanDoneState();
  // The bug's exact shape: ux-review idle → locked under full-mode gating.
  assert.equal(computeActive(state, def('ui-html'), 'full'), false);
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

test('full mode is untouched: no skipped flags, gating still runs through ux-review', () => {
  const full = listPipelineStatus(leanDoneState(), WORKFLOWS[0]!.pipelineIds);
  assert.equal(viewOf(full, 'ux-review').skipped, undefined);
  assert.equal(viewOf(full, 'ui-html').active, false);
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
  // Người dùng tick lộn xộn (ui-html trước docs) — chuỗi run-all chạy tuần tự,
  // nên giữ thứ tự gửi sẽ cho bước sau chạy trước input của nó.
  assert.deepEqual(
    selectRunStages(UI_IDS, { stageIds: ['ui-html', 'ux', 'docs'] }),
    ['docs', 'ux', 'ui-html'],
  );
  // Trùng lặp / thứ tự đảo không đổi kết quả.
  assert.deepEqual(
    selectRunStages(UI_IDS, { stageIds: ['ux-review', 'docs-map', 'ux-review'] }),
    ['docs-map', 'ux-review'],
  );
});

test('stageIds THẮNG lean: bước lean-skipped vẫn chạy khi được tick', () => {
  // `cj` và `ux-research` đều là skippedInLeanRun — lean một mình sẽ bỏ chúng.
  assert.deepEqual(
    selectRunStages(UI_IDS, { lean: true }),
    ['docs', 'docs-map', 'ux', 'ui-html', 'ui-react', 'ui-react-ds'],
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
    ['dr-comp', 'dr-flow', 'dr-review'],
  );
  // Nhánh tick tay: chạy lại ingest sẽ XOÁ SẠCH tài liệu vừa tải lên (output
  // khai báo của nó chính là docs/), nên việc người dùng lỡ tick không làm điều
  // đó bớt phá hoại — bước ingest vẫn bị loại.
  assert.deepEqual(
    selectRunStages(dr, { stageIds: ['dr-docs', 'dr-comp', 'dr-flow'], docsFromUpload: true }),
    ['dr-comp', 'dr-flow'],
  );
  // Không có cờ upload thì bước ingest được tick vẫn chạy bình thường.
  assert.deepEqual(
    selectRunStages(dr, { stageIds: ['dr-docs', 'dr-comp'] }),
    ['dr-docs', 'dr-comp'],
  );
});

test('stageIds vắng mặt → hành vi cũ KHÔNG đổi (lưới an toàn cho tương thích ngược)', () => {
  // Không cờ nào: cả workflow, nguyên thứ tự.
  assert.deepEqual(selectRunStages(UI_IDS, {}), [...UI_IDS]);
  // stageIds rỗng cũng là "vắng mặt" — không được hiểu thành "không chạy gì".
  assert.deepEqual(selectRunStages(UI_IDS, { stageIds: [] }), [...UI_IDS]);
  assert.deepEqual(
    selectRunStages(UI_IDS, { stageIds: [], lean: true }),
    ['docs', 'docs-map', 'ux', 'ui-html', 'ui-react', 'ui-react-ds'],
  );
  // lean + skipSucceeded vẫn cộng dồn như trước.
  assert.deepEqual(
    selectRunStages(UI_IDS, { lean: true, skipSucceeded: true, state: succeededState('docs', 'docs-map') }),
    ['ux', 'ui-html', 'ui-react', 'ui-react-ds'],
  );
});

test('missingDependencies: bước được tick mà phụ thuộc vừa không được chọn vừa chưa chạy', () => {
  // Chọn mỗi UI-Spec trên một project trắng: run-all sẽ chạy nó thật, đọc thư
  // mục ux rỗng, và trả về "thành công" — đây là chỗ duy nhất chặn được.
  assert.deepEqual(missingDependencies(['ui-html'], {}), [{ stage: 'ui-html', missing: ['ux-review'] }]);
  // Chuỗi thiếu ở giữa: ux được chọn nhưng ux-research thì không.
  assert.deepEqual(
    missingDependencies(['docs', 'ux'], succeededState('docs')),
    [{ stage: 'ux', missing: ['ux-research'] }],
  );
  // dr-review có BA phụ thuộc — báo đủ cả ba, không dừng ở cái đầu.
  assert.deepEqual(
    missingDependencies(['dr-review'], {}),
    [{ stage: 'dr-review', missing: ['dr-docs', 'dr-comp', 'dr-flow'] }],
  );
});

test('missingDependencies: phụ thuộc ĐÃ succeeded hoặc được chọn cùng → hợp lệ', () => {
  // (a) đã chạy xong từ trước.
  assert.deepEqual(missingDependencies(['ui-html'], succeededState('ux-review')), []);
  // (b) được tick cùng trong lần chạy này — cả một chuỗi liền mạch.
  assert.deepEqual(
    missingDependencies(['docs', 'docs-map', 'cj', 'ux-research', 'ux', 'ux-review', 'ui-html'], {}),
    [],
  );
  // Trộn cả hai nguồn: docs/docs-map đã xong, phần còn lại tick tay.
  assert.deepEqual(
    missingDependencies(['cj', 'ux-research', 'ux'], succeededState('docs', 'docs-map')),
    [],
  );
  // Bước không có phụ thuộc luôn hợp lệ.
  assert.deepEqual(missingDependencies(['docs'], {}), []);
});

test('missingDependencies: chế độ lean thu cổng về bước gần nhất chế độ đó CÓ chạy', () => {
  // Một project chạy lean xong: ux đã succeeded, ux-review thì KHÔNG BAO GIỜ
  // chạy. Nếu gate theo dependsOn thô, tick ui-html sẽ bị từ chối vĩnh viễn vì
  // một bước mà chế độ này không bao giờ chạy (đúng lỗi effectiveDependsOn sửa).
  const state = succeededState('docs', 'docs-map', 'ux');
  assert.deepEqual(missingDependencies(['ui-html'], state, 'lean'), []);
  assert.deepEqual(missingDependencies(['ui-html'], state, 'full'), [
    { stage: 'ui-html', missing: ['ux-review'] },
  ]);
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

test('validateRunStageSelection: thiếu phụ thuộc → lỗi tiếng Việt nêu rõ bước nào thiếu bước nào', () => {
  const res = validateRunStageSelection(['ux'], UI_IDS, succeededState('docs', 'docs-map', 'cj'));
  assert.equal(res.ok, false);
  // Thông báo phải dùng TÊN người dùng nhìn thấy trên stepper, không phải id trần.
  assert.equal(
    (res as { error: string }).error,
    'Bước "UX Spec" cần "UX Research" chạy xong trước, nhưng bước đó không được chọn và cũng chưa chạy.',
  );
  // Phụ thuộc đã xong → qua.
  assert.deepEqual(
    validateRunStageSelection(['ux'], UI_IDS, succeededState('docs', 'docs-map', 'cj', 'ux-research')),
    { ok: true },
  );
  // …và chọn kèm phụ thuộc trong cùng lần chạy cũng qua.
  assert.deepEqual(validateRunStageSelection(['ux-research', 'ux'], UI_IDS, succeededState('cj')), { ok: true });
});
