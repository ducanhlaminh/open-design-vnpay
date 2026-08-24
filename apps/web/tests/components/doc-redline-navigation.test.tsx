// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DocRedlineNavigation } from '../../src/components/DocRedlineNavigation';
import {
  getAdjacentNavigationId,
  getAnchoredNavigationItems,
  getNavigationPosition,
  type RedlineNavigationItem,
} from '../../src/components/redline-navigation';

afterEach(() => cleanup());

const ITEMS: RedlineNavigationItem[] = [
  { id: 'a', anchored: true },
  { id: 'dismissed', anchored: true, dismissed: true },
  { id: 'unanchored', anchored: false },
  { id: 'b', anchored: true },
];

describe('redline navigation helpers', () => {
  it('tạo thứ tự chỉ gồm item anchored và chưa dismissed', () => {
    expect(getAnchoredNavigationItems(ITEMS).map((item) => item.id)).toEqual(['a', 'b']);
    expect(getAnchoredNavigationItems([])).toEqual([]);
  });

  it('previous/next wrap ở đầu/cuối và skip item không hợp lệ', () => {
    expect(getAdjacentNavigationId(ITEMS, 'a', 'previous')).toBe('b');
    expect(getAdjacentNavigationId(ITEMS, 'b', 'next')).toBe('a');
    expect(getAdjacentNavigationId(ITEMS, 'dismissed', 'next')).toBe('a');
    expect(getAdjacentNavigationId([], null, 'next')).toBeNull();
  });

  it('tính k/total và trả current null khi chưa chọn item anchored', () => {
    expect(getNavigationPosition(ITEMS, 'b')).toEqual({ current: 2, total: 2 });
    expect(getNavigationPosition(ITEMS, 'unanchored')).toEqual({ current: null, total: 2 });
    expect(getNavigationPosition([], null)).toEqual({ current: null, total: 0 });
  });
});

describe('DocRedlineNavigation', () => {
  it('render trạng thái chưa chọn, legend changes và aria-label rõ nghĩa', () => {
    render(
      <DocRedlineNavigation
        mode="changes"
        current={null}
        total={4}
        onPrevious={() => {}}
        onNext={() => {}}
      />,
    );
    expect(screen.getByText('— / 4')).toBeTruthy();
    expect(screen.getByText('1…N')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Thay đổi trước' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Thay đổi sau' })).toBeTruthy();
  });

  it('render legend notes và vô hiệu hoá điều hướng khi rỗng', () => {
    render(
      <DocRedlineNavigation mode="notes" current={null} total={0} onPrevious={() => {}} onNext={() => {}} />,
    );
    expect(screen.getByText('N1…Nk')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Nhận xét trước' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Nhận xét sau' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('phát callback bằng click và phím mũi tên', () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    render(
      <DocRedlineNavigation
        mode="notes"
        current={2}
        total={3}
        onPrevious={onPrevious}
        onNext={onNext}
      />,
    );
    expect(screen.getByText('2 / 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nhận xét trước' }));
    fireEvent.click(screen.getByRole('button', { name: 'Nhận xét sau' }));
    const navigation = screen.getByRole('navigation', { name: 'Điều hướng nhận xét' });
    fireEvent.keyDown(navigation, { key: 'ArrowLeft' });
    fireEvent.keyDown(navigation, { key: 'ArrowRight' });
    expect(onPrevious).toHaveBeenCalledTimes(2);
    expect(onNext).toHaveBeenCalledTimes(2);
  });
});
