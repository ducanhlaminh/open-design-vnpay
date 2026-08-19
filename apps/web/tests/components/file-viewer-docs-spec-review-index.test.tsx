// @vitest-environment jsdom
//
// docs-review/review/index.json (DocsSpecReviewIndexPreview trong FileViewer.tsx)
// — WP3 (.tmp/pipeline/wp3.yaml mục 8) thêm hai cột "Sơ đồ"/"Bảng thành phần"
// (từ `diagrams_updated`/`composition_tables`), CHỈ khi field đó có mặt trong
// JSON. File index.json TỪ TRƯỚC WP3 (không có hai field) phải render đúng 3
// cột như cũ — test thứ hai khoá điều đó.
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';
import { fetchProjectFileText } from '../../src/providers/registry';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>('../../src/providers/registry');
  return { ...actual, fetchProjectFileText: vi.fn() };
});

const mockedFetch = vi.mocked(fetchProjectFileText);

function indexFile(): ProjectFile {
  return {
    name: 'docs-review/review/index.json',
    path: 'docs-review/review/index.json',
    type: 'file',
    size: 256,
    mtime: 1710000000,
    kind: 'text',
    mime: 'application/json',
  } as ProjectFile;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DocsSpecReviewIndexPreview (docs-review/review/index.json)', () => {
  it('index.json có diagrams_updated/composition_tables → bảng thêm đúng 2 cột mới', async () => {
    mockedFetch.mockResolvedValue(
      JSON.stringify({
        kind: 'docs-spec-review-index',
        summary: { pages: 2, changed_pages: 2, changes: 10, blockers: 1, majors: 2, minors: 3, diagrams_updated: 1, composition_tables: 9 },
        pages: [
          { slug: 'urd', page: 'URD', review_path: 'review/docs/urd.md', changes: 6, status: 'succeeded', diagrams_updated: 1, composition_tables: 5 },
          { slug: 'prd', page: 'PRD', review_path: 'review/docs/prd.md', changes: 4, status: 'succeeded', diagrams_updated: 0, composition_tables: 4 },
        ],
      }),
    );

    const { container, findByText } = render(<FileViewer projectId="p1" projectKind="prototype" file={indexFile()} />);

    await findByText('URD');
    const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).toEqual(['Trang', 'Trạng thái', 'Số chỗ sửa', 'Sơ đồ', 'Bảng thành phần']);

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(2);
    const urdCells = Array.from(rows[0]!.querySelectorAll('td')).map((td) => td.textContent);
    expect(urdCells).toEqual(['URD', 'Đã sửa', '6', '1', '5']);

    await waitFor(() => {
      expect(container.textContent).toContain('1 sơ đồ');
      expect(container.textContent).toContain('9 bảng');
    });
  });

  it('index.json CŨ (không có 2 field mới) → bảng giữ nguyên 3 cột', async () => {
    mockedFetch.mockResolvedValue(
      JSON.stringify({
        kind: 'docs-spec-review-index',
        summary: { pages: 1, changed_pages: 1, changes: 3, blockers: 0, majors: 1, minors: 2 },
        pages: [{ slug: 'urd', page: 'URD', review_path: 'review/docs/urd.md', changes: 3, status: 'succeeded' }],
      }),
    );

    const { container, findByText } = render(<FileViewer projectId="p1" projectKind="prototype" file={indexFile()} />);

    await findByText('URD');
    const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).toEqual(['Trang', 'Trạng thái', 'Số chỗ sửa']);
    expect(container.textContent).not.toContain('sơ đồ');
    expect(container.textContent).not.toContain('bảng');
  });
});
