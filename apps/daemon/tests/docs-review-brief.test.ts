import { describe, expect, it } from 'vitest';

import { buildDocsReviewSectionBrief } from '../src/docs-review-brief.js';

const base = {
  projectId: 'sim-tourism',
  pageTitle: 'Mua SIM du lịch',
  originalPath: 'docs-feature/mua-sim.md',
  sectionHeading: '6.4.1 Nhập thông tin',
  startLine: 379,
  endLine: 420,
  bodyLines: 40,
  parentHeading: false,
  imageRefs: ['attachments/checkout.png'],
  slicePath: 'review/docs-feature/mua-sim.s06.slice.md',
  outlinePath: 'review/docs-feature/mua-sim.outline.md',
  reviewPath: 'review/docs-feature/mua-sim.md',
  changesPath: 'review/docs-feature/mua-sim.s06.changes.json',
  notesPath: 'review/docs-feature/mua-sim.s06.notes.json',
};

describe('buildDocsReviewSectionBrief', () => {
  it('formats the daemon user prompt as readable Markdown sections', () => {
    const brief = buildDocsReviewSectionBrief(base);
    expect(brief).toContain('# Review một section · 6.4.1 Nhập thông tin');
    expect(brief).toContain('\n## Phạm vi lần này\n');
    expect(brief).toContain('\n## Tệp cần đọc\n');
    expect(brief).toContain('\n## Việc cần làm\n');
    expect(brief).toContain('\n## Ràng buộc ghi file\n');
    expect(brief).toContain('`attachments/checkout.png`');
    expect(brief).not.toContain('Run the "docs-spec-review" review for ONE SECTION');
  });

  it('keeps enrich and repair context in explicit sections', () => {
    const brief = buildDocsReviewSectionBrief({
      ...base,
      enrichContext: '- Flow đã được daemon thay trước khi review.',
      repairErrors: ['quote không tồn tại', 'JSON notes hỏng'],
    });
    expect(brief).toContain('\n## Ngữ cảnh daemon đã chuẩn bị\n');
    expect(brief).toContain('\n## Repair duy nhất\n');
    expect(brief).toContain('quote không tồn tại | JSON notes hỏng');
  });

  it('distinguishes an empty parent heading from a real content gap', () => {
    expect(buildDocsReviewSectionBrief({ ...base, bodyLines: 0, parentHeading: true }))
      .toContain('Heading này là mục cha');
    expect(buildDocsReviewSectionBrief({ ...base, bodyLines: 0, parentHeading: false }))
      .toContain('ghi một note mức major');
  });
});
