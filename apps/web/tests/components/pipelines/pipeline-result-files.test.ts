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
import { isUiPreviewFile, outputMatches, stripWorkflowDir } from '../../../src/components/pipelines/PipelineModals';

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

// Regression: App-pool projects (App docs pool, 08/2026) ingest into
// docs-feature/ instead of docs/, and dr-review clones that into
// review/docs-feature/ (see docs-review.ts's cloneDocsForReview). Quick
// result's isUiPreviewFile only matched `docs/**/*.md`, so a docs-feature
// project's redline pages never showed up in the rail — only index.json +
// summary.md did. Same `docs|docs-feature` pairing as
// FileViewer.isDocsReviewRedlinePage (fix ab41f3e).
describe('isUiPreviewFile', () => {
  it('matches a dr-review redline page cloned from the App docs pool (docs-feature)', () => {
    expect(isUiPreviewFile('docs-review/review/docs-feature/A/x.md')).toBe(true);
  });

  it('keeps matching a dr-review redline page cloned from Confluence docs (unchanged)', () => {
    expect(isUiPreviewFile('docs-review/review/docs/confluence/a.md')).toBe(true);
  });

  it('does not treat a docs-feature .changes.json sidecar as a previewable page', () => {
    expect(isUiPreviewFile('docs-review/review/docs-feature/A/x.changes.json')).toBe(false);
  });

  it('does not treat a docs-feature _index.md companion as a previewable page', () => {
    expect(isUiPreviewFile('docs-review/review/docs-feature/A/_index.md')).toBe(false);
  });

  it('matches a dr-docs ingest output page under docs-feature (not under review/)', () => {
    expect(isUiPreviewFile('docs-review/docs-feature/A/x.md')).toBe(true);
  });
});
