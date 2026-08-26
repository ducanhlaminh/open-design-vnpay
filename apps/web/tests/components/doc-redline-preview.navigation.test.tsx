// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';

// Tài liệu KHÔNG BAO GIỜ bị sửa: mọi `before`/`anchor` phải là chữ CÒN NGUYÊN
// trong DOC này. `quote` chỉ là đề xuất (hiện trong modal), không cần khớp gì
// ở đây.
const DOC = ['# A', '', 'Đoạn gốc làm điểm neo thêm.', '', 'Đoạn gốc trước khi sửa.', '', 'Đoạn đã xoá còn nguyên trong tài liệu.'].join('\n');
const CHANGES = JSON.stringify([
  { id: 'add', kind: 'gap', severity: 'minor', anchor: 'Đoạn gốc làm điểm neo thêm.', quote: 'Đoạn thêm mới hoàn chỉnh.', reason: 'thêm', operation: 'add', sectionIndex: 0, sectionHeading: '# A' },
  { id: 'edit', kind: 'ux-writing', severity: 'major', before: 'Đoạn gốc trước khi sửa.', quote: 'Đoạn sửa hoàn chỉnh.', reason: 'sửa', sectionIndex: 0, sectionHeading: '# A' },
  { id: 'del', kind: 'gap', severity: 'minor', before: 'Đoạn đã xoá còn nguyên trong tài liệu.', reason: 'xoá', operation: 'delete', sectionIndex: 0, sectionHeading: '# A' },
]);
const NOTES = JSON.stringify([{ id: 'n', kind: 'gap', severity: 'minor', anchor: 'Đoạn gốc trước khi sửa.', finding: 'note', suggestion: 'fix', sectionIndex: 0, sectionHeading: '# A' }]);

vi.mock('../../src/providers/registry', () => ({ fetchProjectFileText: async (_p: string, name: string) => name.endsWith('.changes.json') ? CHANGES : name.endsWith('.notes.json') ? NOTES : DOC, projectRawUrl: () => '' }));
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../src/components/MermaidDiagram', () => ({ MermaidDiagram: () => null }));
const { DocRedlinePreview } = await import('../../src/components/DocRedlinePreview');
const FILE = { name: 'docs-review/review/docs/nav.md', kind: 'text', size: DOC.length, mtime: 1 } as never;
const calls: Element[] = [];
beforeAll(() => { Element.prototype.scrollIntoView = function () { calls.push(this); }; });
beforeEach(() => { calls.length = 0; });

describe('DocRedlinePreview navigation integration', () => {
  it('Trước/Sau dùng thứ tự rail, wrap và cập nhật vị trí', async () => {
    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    const nav = await within(container).findByRole('navigation', { name: 'Điều hướng thay đổi' });
    expect(nav.textContent).toContain('— / 3');
    fireEvent.click(within(nav).getByRole('button', { name: 'Thay đổi sau' }));
    await waitFor(() => expect(nav.textContent).toContain('1 / 3'));
    expect(calls.some((el) => (el as HTMLElement).dataset.changeId === 'add')).toBe(true);
    fireEvent.click(within(nav).getByRole('button', { name: 'Thay đổi trước' }));
    await waitFor(() => expect(nav.textContent).toContain('3 / 3'));
    expect(calls.some((el) => (el as HTMLElement).dataset.changeId === 'del')).toBe(true);
  });

  it('keyboard điều hướng và đổi mode reset current', async () => {
    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    const nav = await within(container).findByRole('navigation', { name: 'Điều hướng thay đổi' });
    fireEvent.keyDown(nav, { key: 'ArrowRight' });
    await waitFor(() => expect(nav.textContent).toContain('1 / 3'));
    fireEvent.click(within(container).getAllByRole('tab', { name: 'Nhận xét (1)' })[0]!);
    const noteNav = await within(container).findByRole('navigation', { name: 'Điều hướng nhận xét' });
    expect(noteNav.textContent).toContain('— / 1');
  });

  it('áp tint block cho add và giữ deletion cùng đường select/scroll', async () => {
    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="add"]')).not.toBeNull());
    expect(container.querySelector('mark[data-change-id="add"]')?.closest('[data-redline-block="add"]')).not.toBeNull();
    const editBlock = container.querySelector('mark[data-change-id="edit"]')?.closest('[data-redline-block="edit"]');
    expect(editBlock).not.toBeNull();
    // Xoá: mark neo trên `before` (còn nguyên trong tài liệu), lớp `hlDel`
    // mang gạch ngang — không còn `data-op="del"` (đó là dấu của
    // `injectDeletedRuns`, đã bỏ, xem docblock đầu component).
    const deletion = container.querySelector('mark[data-change-id="del"][class*="hlDel"]');
    expect(deletion).not.toBeNull();
    // Bấm vùng bôi mở MODAL chi tiết (không còn cuộn rail — rail đã bỏ).
    fireEvent.click(deletion!);
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).not.toBeNull());
  });

  it('có đúng MỘT tabpanel tài liệu, nối với tab đang chọn', async () => {
    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    await within(container).findByRole('navigation', { name: 'Điều hướng thay đổi' });
    const panels = within(container).getAllByRole('tabpanel');
    expect(panels).toHaveLength(1);
    const tabs = within(container).getAllByRole('tab');
    const labelledBy = panels[0]!.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(tabs.find((tab) => tab.id === labelledBy)?.getAttribute('aria-selected')).toBe('true');
  });
});
