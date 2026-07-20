import { describe, expect, it } from 'vitest';
import { formatFeatureText, resolveImagePath } from '../../src/components/DocsReviewPreview';

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

  it('derives the prefix past the review/ segment for per-page fan-out reports', () => {
    // Nested per-page layout: `docs-to-prd/review/<slug>/report.json`. A naive
    // two-segments-up slice would give `docs-to-prd/review` and 404 the image.
    expect(
      resolveImagePath(
        'docs-to-prd/review/II.-Danh-muc__2.1.4.-Quan-ly-nhom/report.json',
        'docs/confluence/attachments/y.png',
      ),
    ).toBe('docs-to-prd/docs/confluence/attachments/y.png');
  });
});

// The review agent excerpts feature_text as ONE flattened line, joining the
// doc's segments with " | " and leaving the screen title glued before the
// first bold label. formatFeatureText rebuilds display structure from that.
describe('formatFeatureText', () => {
  it('splits the flattened one-line excerpt into a title heading + one bullet per |-segment', () => {
    const md = formatFeatureText(
      'MH-NCC-02.1 – Thêm mới NCC **Ý nghĩa màn hình:** Khai báo thông tin | Các trường (*) là bắt buộc | BR-005: vai trò tick sẵn',
    );
    expect(md.split('\n')).toEqual([
      '### MH-NCC-02.1 – Thêm mới NCC',
      '- **Ý nghĩa màn hình:** Khai báo thông tin',
      '- Các trường (*) là bắt buộc',
      '- BR-005: vai trò tick sẵn',
    ]);
  });

  it('keeps a single-segment excerpt as a plain paragraph under its title', () => {
    const md = formatFeatureText('MH-NCC-01 – Danh sách **Ý nghĩa màn hình:** Màn danh sách');
    expect(md.split('\n')).toEqual(['### MH-NCC-01 – Danh sách', '**Ý nghĩa màn hình:** Màn danh sách']);
  });

  it('passes a multi-line (real markdown) excerpt through untouched', () => {
    const md = '- ## MH-NCC-01\n  - **Ý nghĩa màn hình:** Màn danh sách';
    expect(formatFeatureText(md)).toBe(md);
  });

  it('does not split on a bold phrase buried deep in a long sentence', () => {
    const long = `${'x'.repeat(150)} **đậm** phần sau`;
    expect(formatFeatureText(long)).toBe(long);
  });
});
