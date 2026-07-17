import { describe, expect, it } from 'vitest';
import { resolveImagePath } from '../../src/components/DocsReviewPreview';

// Regression coverage: the docs-mockup-review skill runs with its cwd set to
// the workflow-scoped folder (docs-to-prd/) and has no visibility into that
// prefix, so images[].path in report.json is written relative to ITS cwd
// (e.g. `docs/confluence/x/attachments/y.png`) — not the project root
// /api/projects/:id/raw|archive expect. Without reconstructing the prefix,
// the mockup image 404s and Export ships a zip missing every image.
describe('resolveImagePath', () => {
  it('prepends the workflow prefix derived from the report path', () => {
    expect(
      resolveImagePath('docs-to-prd/review/report.json', 'docs/confluence/x/attachments/y.png'),
    ).toBe('docs-to-prd/docs/confluence/x/attachments/y.png');
  });

  it('is idempotent — a path that already carries the prefix is left alone', () => {
    expect(
      resolveImagePath('docs-to-prd/review/report.json', 'docs-to-prd/docs/confluence/x/attachments/y.png'),
    ).toBe('docs-to-prd/docs/confluence/x/attachments/y.png');
  });

  it('passes an unprefixed legacy report path through unchanged', () => {
    expect(resolveImagePath('review/report.json', 'docs/confluence/x/attachments/y.png')).toBe(
      'docs/confluence/x/attachments/y.png',
    );
  });
});
