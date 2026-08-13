// WP1 (2026-08 web-first hold): the run-all "what will actually run" /
// "what will this lose" pure predictions must never count a held stage as
// runnable — mirrors the daemon's `selectRunStages` held filter (see
// `HELD_STAGE_IDS` in apps/daemon/src/pipelines.ts). `held` comes straight
// off `PipelineView.held`; no hard-coded id list here or in the component.
//
// Imports via dynamic import from PipelinesView (pure-function layer, no
// mount) — same pattern as tests/components/stage-run-uses-config.test.tsx.
import { describe, expect, it } from 'vitest';
import type { PipelineView } from '@open-design/contracts';

const { willRunStageIdsForRunAll, stagesLosingOutputForRunAll } = await import(
  '../../src/components/PipelinesView'
);

function view(id: string, extra: Partial<PipelineView> = {}): Pick<
  PipelineView,
  'id' | 'name' | 'status' | 'dependsOn' | 'skipped' | 'held'
> {
  return { id, name: id, status: 'idle', dependsOn: [], ...extra };
}

// Docs-to-ui's post-review stage set, trimmed: ux-review feeds three held
// terminal options.
const PIPELINES = [
  view('docs', { status: 'succeeded' }),
  view('ux-review', { status: 'succeeded', dependsOn: ['docs'] }),
  view('ui-html', { status: 'succeeded', dependsOn: ['ux-review'], held: true }),
  view('ui-react', { status: 'idle', dependsOn: ['ux-review'], held: true }),
  view('ui-react-ds', { status: 'idle', dependsOn: ['ux-review'], held: true }),
];

describe('willRunStageIdsForRunAll — held stages never count as "will run"', () => {
  it('automatic branch (no stageIds): default terminal is held → dropped from the plan', () => {
    const ids = willRunStageIdsForRunAll(PIPELINES, { terminal: 'ui-html', skipSucceeded: false });
    expect(ids).not.toContain('ui-html');
    expect(ids).toContain('docs');
    expect(ids).toContain('ux-review');
  });

  it('manual branch (explicit stageIds): a stale saved selection naming a held id is still filtered out', () => {
    const ids = willRunStageIdsForRunAll(PIPELINES, {
      stageIds: ['docs', 'ux-review', 'ui-react'],
      terminal: 'ui-html',
      skipSucceeded: false,
    });
    expect(ids).toEqual(['docs', 'ux-review']);
  });

  it('no pipeline is held → behavior unchanged (regression guard)', () => {
    const notHeld = PIPELINES.map((p) => ({ ...p, held: undefined }));
    const ids = willRunStageIdsForRunAll(notHeld, { terminal: 'ui-html', skipSucceeded: false });
    expect(ids).toContain('ui-html');
  });
});

// `stagesLosingOutputForRunAll` is a DIFFERENT question from "will run":
// hold blocks a stage from being RE-RUN, but it does NOT protect its old
// output from the pre-existing downstream-reset cascade a fresh AUTOMATIC
// full run-all still performs when its first stage actually executes
// (`resetScopeForRunAllStage` in server.ts — untouched by this change, per
// spec's "KHÔNG đụng clear-on-rerun"). So a held stage's succeeded output
// correctly STILL shows up as "about to be lost" in that one scenario — the
// UI warning that once-lost output can never be regenerated while held is if
// anything MORE useful, not less. A MANUAL (hand-ticked) selection never
// triggers that cascade at all (`resetScopeForRunAllStage`'s `manualStages`
// branch always resets 'stage', never 'downstream'), so a held stage stays
// unaffected there.
describe('stagesLosingOutputForRunAll — held stages follow the SAME clear-on-rerun rules as before (unchanged, see relClearedByRegen/resetScopeForRunAllStage)', () => {
  it('automatic full run-all starting from docs → ui-html\'s prior succeeded output STILL flagged as lost (real downstream-reset cascade, unrelated to hold)', () => {
    const lost = stagesLosingOutputForRunAll(PIPELINES, { terminal: 'ui-html', skipSucceeded: false });
    // `view()` sets `name: id`, so a listed loss would read literally "ui-html".
    expect(lost).toContain('ui-html');
  });

  it('manual (hand-ticked) selection excluding the held id → NOT flagged (manual runs never cascade-reset downstream)', () => {
    const lost = stagesLosingOutputForRunAll(PIPELINES, {
      stageIds: ['docs', 'ux-review'],
      terminal: 'ui-html',
      skipSucceeded: false,
    });
    expect(lost).not.toContain('ui-html');
  });
});
