// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';

const DOC = [
  '**Mục lục**',
  '- Phân quyền theo tính năng',
  '',
  '# PRD',
  '',
  '## Mục trước',
  '',
  'Nội dung thay đổi trước.',
  '',
  '## Mục sau',
  '',
  'Nội dung thay đổi sau.',
  '',
  '### Phân quyền theo tính năng',
  '',
  'Chi tiết phân quyền.',
].join('\n');

// `anchor` neo trên chữ CÒN NGUYÊN trong DOC (bằng chính `quote` ở đây — dữ
// liệu legacy chỉ có `quote`, nhưng test này đo THỨ TỰ, không đo ngữ nghĩa
// add/anchor, nên dùng luôn đoạn đã có sẵn trong tài liệu làm điểm neo).
const CHANGES = JSON.stringify([
  { id: 'later', kind: 'ux-writing', severity: 'minor', anchor: 'Nội dung thay đổi sau.', quote: 'Nội dung thay đổi sau.', reason: 'sau' },
  { id: 'earlier', kind: 'ux-writing', severity: 'minor', anchor: 'Nội dung thay đổi trước.', quote: 'Nội dung thay đổi trước.', reason: 'trước' },
]);
const NOTES = JSON.stringify([
  { id: 'legacy-note', kind: 'gap', severity: 'minor', anchor: '### Phân quyền theo tính năng', finding: 'thiếu', suggestion: 'bổ sung' },
]);

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_project: string, name: string) =>
    name.endsWith('.changes.json') ? CHANGES : name.endsWith('.notes.json') ? NOTES : DOC,
  projectRawUrl: () => '',
}));
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../src/components/MermaidDiagram', () => ({ MermaidDiagram: () => null }));

const { DocRedlinePreview } = await import('../../src/components/DocRedlinePreview');
const FILE = { name: 'docs-review/review/docs/legacy.md', kind: 'text', size: DOC.length, mtime: 1 } as never;

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('DocRedlinePreview legacy ordering and scope', () => {
  it('badge và navigation theo thứ tự tài liệu dù JSON bị đảo', async () => {
    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="earlier"]')?.getAttribute('data-od-idx')).toBe('1');
      expect(container.querySelector('mark[data-change-id="later"]')?.getAttribute('data-od-idx')).toBe('2');
    });

    const nav = within(container).getByRole('navigation', { name: 'Điều hướng thay đổi' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Thay đổi sau' }));
    await waitFor(() => expect(nav.textContent).toContain('1 / 2'));
    // "Sau" đi tới chỗ sửa ĐẦU tiên theo thứ tự tài liệu — "earlier" đứng
    // trước "later" trong tài liệu dù JSON liệt kê "later" trước.
    expect(container.querySelector('mark[data-change-id="earlier"]')?.className).toMatch(/Active/i);
  });

  it('legacy note trùng mục lục được bôi ở heading thật', async () => {
    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    const noteTab = (await within(container).findAllByRole('tab', { name: 'Nhận xét (1)' }))[0]!;
    fireEvent.click(noteTab);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="note:legacy-note"]')).not.toBeNull());
    const mark = container.querySelector('mark[data-change-id="note:legacy-note"]');
    expect(mark?.closest('h3')).not.toBeNull();
    expect(mark?.closest('li')).toBeNull();
  });
});
