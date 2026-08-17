import { describe, expect, it } from 'vitest';

import { isDocsReviewRedlinePage } from '../../src/components/FileViewer';

describe('isDocsReviewRedlinePage — dr-review clone routing', () => {
  it('nhận cả bố cục legacy (review/docs/…) lẫn App-pool (review/docs-feature/…) — kể cả tên có dấu/khoảng trắng', () => {
    expect(isDocsReviewRedlinePage('docs-review/review/docs/confluence/x.md')).toBe(true);
    expect(isDocsReviewRedlinePage('docs-review/review/docs/2.1.1-URD-Quan-ly-nhan-vien.md')).toBe(true);
    expect(isDocsReviewRedlinePage('docs-review/review/docs-feature/SDK/4.1.2.1.1.-URD-Mua-sim-thuong.md')).toBe(true);
    expect(isDocsReviewRedlinePage('docs-review/review/docs-feature/URD_Kích hoạt tài khoản.md')).toBe(true);
  });
  it('không nhận summary.md, changes.json, hay tài liệu gốc ngoài review/', () => {
    expect(isDocsReviewRedlinePage('docs-review/review/summary.md')).toBe(false);
    expect(isDocsReviewRedlinePage('docs-review/review/docs-feature/x.changes.json')).toBe(false);
    expect(isDocsReviewRedlinePage('docs-review/docs-feature/x.md')).toBe(false);
    expect(isDocsReviewRedlinePage('docs-review/docs/confluence/x.md')).toBe(false);
  });
});
