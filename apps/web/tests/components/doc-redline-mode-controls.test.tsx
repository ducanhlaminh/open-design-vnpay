// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { DocRedlineModeControls } from '../../src/components/DocRedlineModeControls';
import {
  annotationMode,
  belongsToMode,
  modeCountLabel,
  modeLabel,
} from '../../src/components/redline-mode';

afterEach(() => cleanup());

describe('redline mode model', () => {
  it('nhận diện change, note và ref theo owner', () => {
    expect(annotationMode('change-1')).toBe('changes');
    expect(annotationMode('note:note-1')).toBe('notes');
    expect(annotationMode('ref:change-1:0')).toBe('changes');
    expect(annotationMode('ref:note:note-1:2')).toBe('notes');

    expect(belongsToMode('ref:change-1:0', 'changes')).toBe(true);
    expect(belongsToMode('ref:change-1:0', 'notes')).toBe(false);
    expect(belongsToMode('ref:note:note-1:2', 'notes')).toBe(true);
  });

  it('cung cấp nhãn nhất quán cho integrator', () => {
    expect(modeLabel('changes')).toBe('Thay đổi');
    expect(modeLabel('notes')).toBe('Nhận xét');
    expect(modeCountLabel('changes', 12)).toBe('Thay đổi (12)');
    expect(modeCountLabel('notes', 4)).toBe('Nhận xét (4)');
  });
});

describe('DocRedlineModeControls', () => {
  it('render đúng counts, tab semantics và không có lựa chọn Tất cả', () => {
    render(
      <DocRedlineModeControls
        mode="changes"
        changeCount={7}
        noteCount={3}
        onModeChange={() => undefined}
        placement="document"
      />,
    );

    const group = screen.getByRole('tablist', { name: 'Chế độ xem tài liệu' });
    const changeTab = within(group).getByRole('tab', { name: 'Thay đổi (7)' });
    const noteTab = within(group).getByRole('tab', { name: 'Nhận xét (3)' });

    expect(changeTab.getAttribute('aria-selected')).toBe('true');
    expect(changeTab.getAttribute('tabindex')).toBe('0');
    expect(noteTab.getAttribute('aria-selected')).toBe('false');
    expect(noteTab.getAttribute('tabindex')).toBe('-1');
    expect(changeTab.id).toBe('doc-redline-document-changes-tab');
    expect(changeTab.getAttribute('aria-controls')).toBe('doc-redline-document-tabpanel');
    expect(noteTab.getAttribute('aria-controls')).toBe('doc-redline-document-tabpanel');
    expect(within(group).queryByText(/Tất cả/i)).toBeNull();
  });

  it('là controlled component: callback không tự đổi mode nếu parent chưa rerender', () => {
    const onModeChange = vi.fn();
    render(
      <DocRedlineModeControls
        mode="changes"
        changeCount={7}
        noteCount={3}
        onModeChange={onModeChange}
        placement="document"
      />,
    );

    const noteTab = screen.getByRole('tab', { name: 'Nhận xét (3)' });
    fireEvent.click(noteTab);

    expect(onModeChange).toHaveBeenCalledOnce();
    expect(onModeChange).toHaveBeenCalledWith('notes');
    expect(noteTab.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tab', { name: 'Thay đổi (7)' }).getAttribute('aria-selected')).toBe('true');
  });

  it.each(['document', 'rail'] as const)('placement %s dùng cùng callback contract', (placement) => {
    const onModeChange = vi.fn();
    const { container } = render(
      <DocRedlineModeControls
        mode="notes"
        changeCount={2}
        noteCount={5}
        onModeChange={onModeChange}
        placement={placement}
      />,
    );

    expect(container.firstElementChild?.getAttribute('data-placement')).toBe(placement);
    fireEvent.click(screen.getByRole('tab', { name: 'Thay đổi (2)' }));
    expect(onModeChange).toHaveBeenCalledWith('changes');
  });

  it('ArrowLeft/ArrowRight và Home/End đổi lựa chọn, đồng thời chuyển focus', () => {
    const onModeChange = vi.fn();
    const { rerender } = render(
      <DocRedlineModeControls
        mode="changes"
        changeCount={2}
        noteCount={5}
        onModeChange={onModeChange}
        placement="rail"
      />,
    );

    const changes = screen.getByRole('tab', { name: 'Thay đổi (2)' });
    const notes = screen.getByRole('tab', { name: 'Nhận xét (5)' });

    changes.focus();
    fireEvent.keyDown(changes, { key: 'ArrowRight' });
    expect(onModeChange).toHaveBeenLastCalledWith('notes');
    expect(document.activeElement).toBe(notes);
    rerender(
      <DocRedlineModeControls
        mode="notes"
        changeCount={2}
        noteCount={5}
        onModeChange={onModeChange}
        placement="rail"
      />,
    );

    fireEvent.keyDown(notes, { key: 'ArrowLeft' });
    expect(onModeChange).toHaveBeenLastCalledWith('changes');
    expect(document.activeElement).toBe(changes);
    rerender(
      <DocRedlineModeControls
        mode="changes"
        changeCount={2}
        noteCount={5}
        onModeChange={onModeChange}
        placement="rail"
      />,
    );

    fireEvent.keyDown(changes, { key: 'End' });
    expect(onModeChange).toHaveBeenLastCalledWith('notes');
    expect(document.activeElement).toBe(notes);
    rerender(
      <DocRedlineModeControls
        mode="notes"
        changeCount={2}
        noteCount={5}
        onModeChange={onModeChange}
        placement="rail"
      />,
    );

    fireEvent.keyDown(notes, { key: 'Home' });
    expect(onModeChange).toHaveBeenLastCalledWith('changes');
    expect(document.activeElement).toBe(changes);
  });

  it('Enter và Space dùng hành vi button chuẩn', () => {
    render(
      <DocRedlineModeControls
        mode="changes"
        changeCount={2}
        noteCount={5}
        onModeChange={() => undefined}
        placement="document"
      />,
    );

    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.tagName).toBe('BUTTON');
      expect((tab as HTMLButtonElement).type).toBe('button');
    }
  });
});
