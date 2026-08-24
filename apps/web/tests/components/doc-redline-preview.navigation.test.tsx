// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';

const DOC = ['# A', '', 'Đoạn thêm mới hoàn chỉnh.', '', 'Đoạn sửa hoàn chỉnh.', '', 'Neo xoá còn sống.'].join('\n');
const CHANGES = JSON.stringify([
  { id: 'add', kind: 'gap', severity: 'minor', quote: 'Đoạn thêm mới hoàn chỉnh.', reason: 'thêm', operation: 'add', sectionIndex: 0, sectionHeading: '# A' },
  { id: 'edit', kind: 'ux-writing', severity: 'major', before: 'Đoạn cũ.', quote: 'Đoạn sửa hoàn chỉnh.', reason: 'sửa', sectionIndex: 0, sectionHeading: '# A' },
  { id: 'del', kind: 'gap', severity: 'minor', before: 'Đoạn đã xoá.', anchor: 'Neo xoá còn sống.', reason: 'xoá', operation: 'delete', sectionIndex: 0, sectionHeading: '# A' },
]);
const NOTES = JSON.stringify([{ id: 'n', kind: 'gap', severity: 'minor', anchor: 'Đoạn sửa hoàn chỉnh.', finding: 'note', suggestion: 'fix', sectionIndex: 0, sectionHeading: '# A' }]);

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
    const deletion = container.querySelector('mark[data-change-id="del"][data-op="del"]');
    expect(deletion).not.toBeNull();
    fireEvent.click(container.querySelector('[data-change-item="del"]')!);
    await waitFor(() => expect(calls).toContain(deletion));
  });

  it('tabpanel document và rail được nối với tab đang chọn', async () => {
    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    await within(container).findByRole('navigation', { name: 'Điều hướng thay đổi' });
    const panels = within(container).getAllByRole('tabpanel');
    expect(panels).toHaveLength(2);
    const tabs = within(container).getAllByRole('tab');
    for (const panel of panels) {
      const labelledBy = panel.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();
      expect(tabs.find((tab) => tab.id === labelledBy)?.getAttribute('aria-selected')).toBe('true');
    }
  });
});
