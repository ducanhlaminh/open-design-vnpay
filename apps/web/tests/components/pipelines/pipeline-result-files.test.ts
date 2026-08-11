// Regression for the docs-review Quick result bug: `WORKFLOW_DIR_RE` /
// `KNOWN_WORKFLOW_DIRS` (PipelineModals.tsx) list every workflow-folder head
// the daemon may prefix an output with, and MUST be kept in sync by hand with
// the daemon's `WORKFLOWS` registry (apps/daemon/src/pipelines.ts) — see the
// docblock above `WORKFLOW_DIR_RE`. When `docs-review` was added daemon-side
// without mirroring it here, `stripWorkflowDir` never stripped the
// `docs-review/` prefix off a dr-review output path, so `outputMatches`
// compared the WRONG (still-prefixed) relative path against the stage's
// `review/` pattern and always missed — Quick result reported "No output
// files yet" for a dr-review run that plainly succeeded on disk.
import { describe, expect, it } from 'vitest';
import { outputMatches, stripWorkflowDir } from '../../../src/components/pipelines/PipelineModals';

describe('stripWorkflowDir', () => {
  it('strips the docs-review workflow prefix off a dr-review output path', () => {
    expect(stripWorkflowDir('docs-review/review/docs/confluence/x.md')).toBe('review/docs/confluence/x.md');
  });

  it('keeps stripping the docs-to-prd prefix (pre-existing behavior, unchanged)', () => {
    expect(stripWorkflowDir('docs-to-prd/review/report.json')).toBe('review/report.json');
  });
});

describe('outputMatches', () => {
  it('matches a stripped dr-review path against its "review/" outputs pattern', () => {
    expect(outputMatches(stripWorkflowDir('docs-review/review/docs/confluence/x.md'), 'review/')).toBe(true);
  });
});
