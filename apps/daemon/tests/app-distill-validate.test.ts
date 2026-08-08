import { describe, expect, it } from 'vitest';

import {
  validateBranch,
  validateBranchReferences,
  validateOverview,
  type DistillPage,
} from '../src/app-distill-validate.js';

const OVERVIEW_HEADER = [
  '## Cách dùng file này',
  'Đọc trước.',
  '',
  '## Dự án',
  'Mô tả dự án.',
  '',
  '## Phân hệ',
  '',
  '| Slug | Phân hệ | Phạm vi | Branch |',
  '| --- | --- | --- | --- |',
  '| branch-a | Tài khoản | Quản lý tài khoản | branch-a |',
  '',
  '## Luồng nghiệp vụ xuyên trang',
  'Luồng.',
  '',
  '## Thuật ngữ',
  'Thuật ngữ.',
  '',
  '## Bản đồ trang',
  '',
].join('\n');

function overviewWithPageMap(rows: string[]): string {
  return (
    `${OVERVIEW_HEADER}\n` +
    '| Path | Nội dung | Keywords |\n' +
    '| --- | --- | --- |\n' +
    `${rows.join('\n')}\n`
  );
}

const pages: DistillPage[] = [{ path: 'branch-a/page-one.md' }, { path: 'branch-a/page-two.md' }];

describe('app-distill-validate — validateOverview', () => {
  it('passes a well-formed overview: exact headings, full page map, referenced branch', () => {
    const content = overviewWithPageMap([
      '| branch-a/page-one.md | Nội dung 1 | kw1 |',
      '| branch-a/page-two.md | Nội dung 2 | kw2 |',
    ]);
    const result = validateOverview(content, pages, ['branch-a']);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails when a heading is missing/out of order', () => {
    const badHeader = OVERVIEW_HEADER.replace('## Thuật ngữ', '## ThuatNgu');
    const content =
      `${badHeader}\n` +
      '| Path | Nội dung | Keywords |\n' +
      '| --- | --- | --- |\n' +
      '| branch-a/page-one.md | X | kw |\n' +
      '| branch-a/page-two.md | Y | kw |\n';
    const result = validateOverview(content, pages, ['branch-a']);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /headings must be exactly/i.test(e))).toBe(true);
  });

  it('"thiếu trang" — the page map missing an entry from the manifest fails', () => {
    const content = overviewWithPageMap(['| branch-a/page-one.md | Nội dung 1 | kw1 |']);
    const result = validateOverview(content, pages, ['branch-a']);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /missing path: branch-a\/page-two\.md/.test(e))).toBe(true);
  });

  it('"path bịa" — a page map row citing a path NOT in the manifest fails', () => {
    const content = overviewWithPageMap([
      '| branch-a/page-one.md | Nội dung 1 | kw1 |',
      '| branch-a/page-two.md | Nội dung 2 | kw2 |',
      '| branch-a/made-up.md | Bịa | kw |',
    ]);
    const result = validateOverview(content, pages, ['branch-a']);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /unknown path: branch-a\/made-up\.md/.test(e))).toBe(true);
  });

  it('"quá trần" — more than 400 lines fails', () => {
    const content = overviewWithPageMap([
      '| branch-a/page-one.md | Nội dung 1 | kw1 |',
      '| branch-a/page-two.md | Nội dung 2 | kw2 |',
    ]) + '\n'.repeat(400);
    const result = validateOverview(content, pages, ['branch-a']);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Overview exceeds 400 lines.');
  });

  it('(c) an existing _branches/<slug>.md not referenced by ## Phân hệ fails', () => {
    const content = overviewWithPageMap([
      '| branch-a/page-one.md | Nội dung 1 | kw1 |',
      '| branch-a/page-two.md | Nội dung 2 | kw2 |',
    ]);
    // "branch-b" has no row in the ## Phân hệ table above.
    const result = validateOverview(content, pages, ['branch-a', 'branch-b']);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /does not reference _branches\/branch-b\.md/.test(e))).toBe(true);
  });

  it('omitting branchSlugs skips rule (c) entirely', () => {
    const content = overviewWithPageMap([
      '| branch-a/page-one.md | Nội dung 1 | kw1 |',
      '| branch-a/page-two.md | Nội dung 2 | kw2 |',
    ]);
    const result = validateOverview(content, pages);
    expect(result.ok).toBe(true);
  });
});

describe('app-distill-validate — validateBranchReferences directly', () => {
  it('passes when every slug is referenced (by Slug or Branch column)', () => {
    const result = validateBranchReferences(OVERVIEW_HEADER, ['branch-a']);
    expect(result.ok).toBe(true);
  });

  it('fails when the Phân hệ table is missing but branches exist', () => {
    const noTable = OVERVIEW_HEADER.replace(
      /\| Slug \| Phân hệ[\s\S]*?\n\n/,
      '',
    );
    const result = validateBranchReferences(noTable, ['branch-a']);
    expect(result.ok).toBe(false);
  });
});

describe('app-distill-validate — validateBranch', () => {
  const branchPages: DistillPage[] = [{ path: 'branch-a/page-one.md' }, { path: 'branch-a/page-two.md' }];

  function branchDoc(rows: string[]): string {
    return ['# branch-a', '', '| Path | Chức năng | Keywords |', '| --- | --- | --- |', ...rows, ''].join('\n');
  }

  it('passes a well-formed branch doc with the full page table', () => {
    const content = branchDoc([
      '| branch-a/page-one.md | Chức năng 1 | kw1 |',
      '| branch-a/page-two.md | Chức năng 2 | kw2 |',
    ]);
    const result = validateBranch(content, branchPages);
    expect(result.ok).toBe(true);
  });

  it('"thiếu trang" fails', () => {
    const content = branchDoc(['| branch-a/page-one.md | Chức năng 1 | kw1 |']);
    const result = validateBranch(content, branchPages);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /missing path: branch-a\/page-two\.md/.test(e))).toBe(true);
  });

  it('"path bịa" fails', () => {
    const content = branchDoc([
      '| branch-a/page-one.md | Chức năng 1 | kw1 |',
      '| branch-a/page-two.md | Chức năng 2 | kw2 |',
      '| branch-a/bogus.md | Bịa | kw |',
    ]);
    const result = validateBranch(content, branchPages);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /unknown path: branch-a\/bogus\.md/.test(e))).toBe(true);
  });

  it('"quá trần" (>120 lines) fails', () => {
    const content =
      branchDoc(['| branch-a/page-one.md | Chức năng 1 | kw1 |', '| branch-a/page-two.md | Chức năng 2 | kw2 |']) +
      '\n'.repeat(120);
    const result = validateBranch(content, branchPages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Branch document exceeds 120 lines.');
  });

  it('a missing page table entirely fails', () => {
    const result = validateBranch('# branch-a\n\nno table here\n', branchPages);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /page table is missing/i.test(e))).toBe(true);
  });

  it('a duplicate path row fails', () => {
    const content = branchDoc([
      '| branch-a/page-one.md | Chức năng 1 | kw1 |',
      '| branch-a/page-one.md | Chức năng 1 lần nữa | kw1 |',
      '| branch-a/page-two.md | Chức năng 2 | kw2 |',
    ]);
    const result = validateBranch(content, branchPages);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /duplicate path/.test(e))).toBe(true);
  });
});
