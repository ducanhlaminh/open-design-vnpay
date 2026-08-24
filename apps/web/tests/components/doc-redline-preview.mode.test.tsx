// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';

const DOC = ['# Mục lục', '', '- Nội dung lặp', '', '# Chi tiết', '', 'Nội dung lặp', '', 'Nội dung thay đổi'].join('\n');
const CHANGES = JSON.stringify([{ id: 'c1', kind: 'ux-writing', severity: 'minor', quote: 'Nội dung thay đổi', reason: 'Sửa rõ hơn', sectionIndex: 2, sectionHeading: '# Chi tiết' }]);
const NOTES = JSON.stringify([{ id: 'n1', kind: 'gap', severity: 'major', anchor: 'Nội dung lặp', finding: 'Thiếu mô tả', suggestion: 'Bổ sung', sectionIndex: 2, sectionHeading: '# Chi tiết' }]);

let sourceDoc = DOC;
let sourceChanges = CHANGES;
let sourceNotes = NOTES;

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => name.endsWith('.changes.json') ? sourceChanges : name.endsWith('.notes.json') ? sourceNotes : sourceDoc,
  projectRawUrl: () => '',
}));
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../src/components/MermaidDiagram', () => ({ MermaidDiagram: () => null }));

const { DocRedlinePreview, parseDocChanges, parseDocNotes } = await import('../../src/components/DocRedlinePreview');
const FILE = { name: 'docs-review/review/docs/a.md', kind: 'text', size: DOC.length, mtime: 1 } as never;

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); window.print = vi.fn(); });
afterEach(() => {
  sourceDoc = DOC;
  sourceChanges = CHANGES;
  sourceNotes = NOTES;
});

describe('DocRedlinePreview mode integration', () => {
  it('đồng bộ hai mode controls và cô lập DOM theo mode', async () => {
    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="c1"]')).not.toBeNull());
    expect(container.querySelector('mark[data-change-id="note:n1"]')).toBeNull();
    expect(container.querySelector('[data-change-item="c1"]')).not.toBeNull();
    expect(container.querySelector('[data-change-item="note:n1"]')).toBeNull();

    const tablists = within(container).getAllByRole('tablist', { name: 'Chế độ xem tài liệu' });
    expect(tablists).toHaveLength(2);
    fireEvent.click(within(tablists[1]!).getByRole('tab', { name: 'Nhận xét (1)' }));
    await waitFor(() => expect(container.querySelector('mark[data-change-id="note:n1"]')).not.toBeNull());
    expect(container.querySelector('mark[data-change-id="c1"]')).toBeNull();
    expect(container.querySelector('[data-change-item="note:n1"]')).not.toBeNull();
    expect(container.querySelector('[data-change-item="c1"]')).toBeNull();
    for (const list of tablists) expect(within(list).getByRole('tab', { name: 'Nhận xét (1)' }).getAttribute('aria-selected')).toBe('true');
  });

  it('scope metadata tránh neo vào nội dung trùng trong mục lục, file cũ vẫn fallback', async () => {
    const parsedChange = parseDocChanges(CHANGES)![0]!;
    const parsedNote = parseDocNotes(NOTES)![0]!;
    expect(parsedChange).toMatchObject({ sectionIndex: 2, sectionHeading: '# Chi tiết' });
    expect(parsedNote).toMatchObject({ sectionIndex: 2, sectionHeading: '# Chi tiết' });
    const legacy = parseDocNotes(JSON.stringify([{ id: 'old', kind: 'gap', severity: 'minor', anchor: 'Nội dung lặp', finding: 'x', suggestion: 'y' }]))![0]!;
    expect(legacy.sectionIndex).toBeUndefined();

    const ordinal = parseDocChanges(JSON.stringify([{
      id: 'ordinal', kind: 'gap', severity: 'minor', quote: 'x', reason: 'y',
      sectionIndex: 1, sectionHeading: '# B', sectionStartHeadingOrdinal: 3,
      sectionEndHeadingOrdinalExclusive: 5,
    }]))![0]!;
    expect(ordinal).toMatchObject({
      sectionStartHeadingOrdinal: 3,
      sectionEndHeadingOrdinalExclusive: 5,
    });

    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    fireEvent.click((await within(container).findAllByRole('tab', { name: 'Nhận xét (1)' }))[0]!);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="note:n1"]')).not.toBeNull());
    const mark = container.querySelector('mark[data-change-id="note:n1"]')!;
    expect(mark.closest('li')).toBeNull();
    expect(mark.closest('p')?.previousElementSibling?.textContent).toBe('Chi tiết');
  });


  it('cleanup Mermaid khi đổi mode và ghép one-to-one hai code trùng theo range', async () => {
    const code = 'flowchart TD\nA --> B';
    sourceDoc = ['# Một', '', '```mermaid', code, '```', '', '# Hai', '', '```mermaid', code, '```'].join('\n');
    sourceChanges = JSON.stringify([
      { id: 'flow-1', kind: 'flow-diagram', severity: 'minor', quote: `\`\`\`mermaid\n${code}\n\`\`\``, reason: 'một', sectionStartHeadingOrdinal: 0, sectionEndHeadingOrdinalExclusive: 1 },
      { id: 'flow-2', kind: 'flow-diagram', severity: 'minor', quote: `\`\`\`mermaid\n${code}\n\`\`\``, reason: 'hai', sectionStartHeadingOrdinal: 1, sectionEndHeadingOrdinalExclusive: 2 },
    ]);
    sourceNotes = JSON.stringify([{ id: 'note', kind: 'gap', severity: 'minor', anchor: 'Hai', finding: 'x', suggestion: 'y' }]);

    const { container, unmount } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    await waitFor(() => expect(container.querySelectorAll('mark[data-change-id^="flow-"]')).toHaveLength(2));
    expect(container.querySelectorAll('mark[data-change-id="flow-1"]')).toHaveLength(1);
    expect(container.querySelectorAll('mark[data-change-id="flow-2"]')).toHaveLength(1);
    expect(container.querySelectorAll('details.md-mermaid__source')).toHaveLength(2);

    fireEvent.click(within(container).getAllByRole('tab', { name: 'Nhận xét (1)' })[0]!);
    await waitFor(() => expect(container.querySelectorAll('mark[data-change-id^="flow-"]')).toHaveLength(0));
    expect(container.querySelectorAll('details.md-mermaid__source')).toHaveLength(2);

    fireEvent.click(within(container).getAllByRole('tab', { name: 'Thay đổi (2)' })[0]!);
    await waitFor(() => expect(container.querySelectorAll('mark[data-change-id^="flow-"]')).toHaveLength(2));
    expect(container.querySelectorAll('details.md-mermaid__source')).toHaveLength(2);

    unmount();
    expect(container.querySelectorAll('details.md-mermaid__source')).toHaveLength(0);
  });

  it('không giới hạn doc_refs theo section của owner', async () => {
    sourceDoc = ['# Một', '', 'Anchor owner', '', '# Hai', '', 'Bằng chứng chéo section'].join('\n');
    sourceChanges = JSON.stringify([{
      id: 'cross-ref', kind: 'gap', severity: 'minor', quote: 'Anchor owner', reason: 'x',
      doc_refs: ['Bằng chứng chéo section'], sectionStartHeadingOrdinal: 0,
      sectionEndHeadingOrdinalExclusive: 1,
    }]);
    sourceNotes = '[]';

    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="ref:cross-ref:0"]')).not.toBeNull());
    expect(container.querySelector('mark[data-change-id="ref:cross-ref:0"]')?.textContent).toBe('Bằng chứng chéo section');
  });

  it('gắn full-block tint theo màu add/edit/note cho table và list item', async () => {
    sourceDoc = ['# A', '', '| Cột |', '| --- |', '| Giá trị sửa |', '', '- Giá trị thêm', '- Nhận xét list'].join('\n');
    sourceChanges = JSON.stringify([
      { id: 'table-edit', kind: 'ux-writing', severity: 'minor', before: 'Cũ', quote: 'Giá trị sửa', reason: 'x' },
      { id: 'list-add', kind: 'gap', severity: 'minor', quote: 'Giá trị thêm', reason: 'x', operation: 'add' },
    ]);
    sourceNotes = JSON.stringify([
      { id: 'list-note', kind: 'gap', severity: 'minor', anchor: 'Nhận xét list', finding: 'x', suggestion: 'y' },
    ]);

    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    await waitFor(() => expect(container.querySelector('[data-redline-block="edit"]')).not.toBeNull());
    const editTable = container.querySelector('[data-redline-block="edit"]');
    expect(editTable?.tagName).toBe('TABLE');
    expect(editTable?.className).toContain('blockTintFull');
    const addItem = container.querySelector('[data-redline-block="add"]');
    expect(addItem?.tagName).toBe('LI');
    expect(addItem?.className).toContain('blockTintFull');

    fireEvent.click(within(container).getAllByRole('tab', { name: 'Nhận xét (1)' })[0]!);
    await waitFor(() => expect(container.querySelector('[data-redline-block="note"]')).not.toBeNull());
    const noteItem = container.querySelector('[data-redline-block="note"]');
    expect(noteItem?.tagName).toBe('LI');
    expect(noteItem?.className).toContain('blockTintFull');
  });

  it('không biến doc_ref trong list/table thành full-block tint', async () => {
    sourceDoc = [
      '# A',
      '',
      '| Cột |',
      '| --- |',
      '| Owner change |',
      '',
      '- Ref change trong list',
      '- Owner note',
      '',
      '| Bằng chứng |',
      '| --- |',
      '| Ref note trong table |',
    ].join('\n');
    sourceChanges = JSON.stringify([{
      id: 'change-owner', kind: 'ux-writing', severity: 'minor', before: 'Owner cũ', quote: 'Owner change', reason: 'x',
      doc_refs: ['Ref change trong list'],
    }]);
    sourceNotes = JSON.stringify([{
      id: 'note-owner', kind: 'gap', severity: 'minor', anchor: 'Owner note', finding: 'x', suggestion: 'y',
      doc_refs: ['Ref note trong table'],
    }]);

    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    await waitFor(() => expect(container.querySelector('[data-redline-block="edit"]')).not.toBeNull());
    const changeOwnerBlock = container.querySelector('mark[data-change-id="change-owner"]')?.closest('table');
    expect(changeOwnerBlock?.dataset.redlineBlock).toBe('edit');
    expect(changeOwnerBlock?.className).toContain('blockTintFull');

    const changeRef = container.querySelector<HTMLElement>('mark[data-change-id="ref:change-owner:0"]');
    expect(changeRef).not.toBeNull();
    expect(changeRef?.style.borderBottomStyle).toBe('dotted');
    expect(changeRef?.closest('li')?.dataset.redlineBlock).toBeUndefined();
    expect(changeRef?.closest('li')?.className).not.toContain('blockTintFull');

    fireEvent.click(within(container).getAllByRole('tab', { name: 'Nhận xét (1)' })[0]!);
    await waitFor(() => expect(container.querySelector('[data-redline-block="note"]')).not.toBeNull());
    const noteOwnerBlock = container.querySelector('mark[data-change-id="note:note-owner"]')?.closest('li');
    expect(noteOwnerBlock?.dataset.redlineBlock).toBe('note');
    expect(noteOwnerBlock?.className).toContain('blockTintFull');

    const noteRef = container.querySelector<HTMLElement>('mark[data-change-id="ref:note:note-owner:0"]');
    expect(noteRef).not.toBeNull();
    expect(noteRef?.style.borderBottomStyle).toBe('dotted');
    expect(noteRef?.closest('table')?.dataset.redlineBlock).toBeUndefined();
    expect(noteRef?.closest('table')?.className).not.toContain('blockTintFull');
  });

  it('chỉ hiện filter phù hợp mode và bản in ghi đúng mode hiện tại', async () => {
    const { container } = render(<DocRedlinePreview projectId="p" file={FILE} />);
    await within(container).findByText(/1 thêm/);
    expect(within(container).getByRole('group', { name: 'Hiện tô màu theo loại' })).toBeTruthy();
    fireEvent.click(within(container).getAllByRole('tab', { name: 'Nhận xét (1)' })[0]!);
    await waitFor(() => expect(within(container).queryByRole('group', { name: 'Hiện tô màu theo loại' })).toBeNull());
    expect(document.body.querySelector('[data-od-print-sheet]')?.textContent).toContain('Chế độ: Nhận xét');
    expect(document.body.querySelector('[data-od-print-sheet] tbody')?.textContent).toContain('N1');
    expect(document.body.querySelector('[data-od-print-sheet] tbody')?.textContent).not.toContain('Sửa rõ hơn');
    fireEvent.click(within(container).getByRole('button', { name: 'Xuất PDF' }));
    expect(window.print).toHaveBeenCalled();
    expect(document.body.dataset.odPrint).toBe('redline');
  });
});
