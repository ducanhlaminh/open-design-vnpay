import { describe, expect, it } from 'vitest';
import { createRedlineDocumentIndex } from '../../src/components/redline-document';

describe('redline document index', () => {
  const doc = [
    '**Mục lục**',
    '- Phân quyền theo tính năng',
    '- 2. Thanh toán',
    '',
    '# PRD',
    '',
    '## 1. Giới thiệu',
    '',
    'Nội dung xuất hiện trước.',
    '',
    '## 2. Thanh toán',
    '',
    'Nội dung xuất hiện sau.',
    '',
    '### Phân quyền theo tính năng',
    '',
    'Chi tiết phân quyền.',
  ].join('\n');

  it('sort annotation theo vị trí thật thay vì thứ tự JSON', () => {
    const index = createRedlineDocumentIndex(doc);
    const sorted = index.sort([
      { id: 'later', quote: 'Nội dung xuất hiện sau.' },
      { id: 'earlier', quote: 'Nội dung xuất hiện trước.' },
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['earlier', 'later']);
  });

  it('suy scope heading thật cho sidecar cũ, không neo vào mục lục', () => {
    const index = createRedlineDocumentIndex(doc);
    expect(index.scopeFor({ anchor: '### Phân quyền theo tính năng' })).toEqual({
      sectionHeading: '### Phân quyền theo tính năng',
      sectionStartHeadingOrdinal: 3,
    });
  });

  it('ưu tiên occurrence trong thân tài liệu khi text trùng mục lục', () => {
    const index = createRedlineDocumentIndex(doc);
    const position = index.positionOf({ anchor: 'Phân quyền theo tính năng' });
    expect(position).toBeGreaterThan(doc.indexOf('# PRD'));
  });

  it('ưu tiên provenance ordinal mới và giữ stable order khi cùng section', () => {
    const index = createRedlineDocumentIndex(doc);
    const annotation = {
      quote: 'Nội dung xuất hiện sau.',
      sectionIndex: 7,
      sectionHeading: '## 2. Thanh toán',
      sectionStartHeadingOrdinal: 2,
      sectionEndHeadingOrdinalExclusive: 4,
    };
    expect(index.scopeFor(annotation)).toEqual({
      sectionIndex: 7,
      sectionHeading: '## 2. Thanh toán',
      sectionStartHeadingOrdinal: 2,
      sectionEndHeadingOrdinalExclusive: 4,
    });
  });

  it('bỏ heading giả nằm trong cả hai loại code fence', () => {
    const fenced = ['# A', '```md', '# giả 1', '```', '~~~md', '# giả 2', '~~~', '# B'].join('\n');
    const index = createRedlineDocumentIndex(fenced);
    expect(index.scopeFor({ anchor: '# B' })).toEqual({
      sectionHeading: '# B',
      sectionStartHeadingOrdinal: 1,
    });
  });
});
