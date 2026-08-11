// @vitest-environment jsdom
// @ts-nocheck

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppPoolTree } from '../../src/components/pipelines/AppPoolTree';

const page = (pageId, path, title) => ({
  pageId,
  path,
  title,
  branch: path.split('/')[0] ?? '',
  contentHash: `${pageId}-hash`,
  fetchedAt: 1,
});

const pages = [
  page('p1', 'admin/users.md', 'Quản lý người dùng'),
  page('p2', 'admin/roles.md', 'Phân quyền'),
  page('p3', 'admin/audit.md', 'Nhật ký hệ thống'),
  page('p4', 'operations/onboarding.md', 'Hướng dẫn vận hành'),
  page('p5', 'operations/metrics.md', 'Báo cáo chỉ số'),
  page('p6', 'hr/leave.md', 'Nghỉ phép'),
];

const selectionProps = (onToggle, ticked = new Set()) => ({
  ticked,
  onToggle,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AppPoolTree query filtering', () => {
  it('renders the full tree without a query and toggles one page', () => {
    const onToggle = vi.fn();
    render(<AppPoolTree pages={pages} selection={selectionProps(onToggle)} />);

    expect(screen.getByText('Quản lý người dùng')).toBeTruthy();
    expect(screen.getByText('Phân quyền')).toBeTruthy();
    expect(screen.getByText('Hướng dẫn vận hành')).toBeTruthy();
    expect(screen.getByText('Nghỉ phép')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tick trang Quản lý người dùng' }));
    expect(onToggle).toHaveBeenCalledWith(new Set(['admin/users.md']));
  });

  it('matches an accented title with an unaccented query and auto-expands ancestors', () => {
    render(<AppPoolTree pages={pages} query="quan ly" />);

    expect(screen.getByText('Quản lý người dùng')).toBeTruthy();
    expect(screen.queryByText('Phân quyền')).toBeNull();
    expect(screen.queryByText('admin')).toBeTruthy();
  });

  it('shows every descendant when the folder name matches', () => {
    render(<AppPoolTree pages={pages} query="operations" />);

    expect(screen.getByText('Hướng dẫn vận hành')).toBeTruthy();
    expect(screen.getByText('Báo cáo chỉ số')).toBeTruthy();
    expect(screen.queryByText('Quản lý người dùng')).toBeNull();
  });

  it('shows an empty state when nothing matches', () => {
    render(<AppPoolTree pages={pages} query="không tồn tại" />);

    expect(screen.getByText('Không có trang nào khớp "không tồn tại".')).toBeTruthy();
  });

  it('ticks only visible pages when filtering a folder cascade', () => {
    const onToggle = vi.fn();
    render(<AppPoolTree pages={pages} query="quan ly" selection={selectionProps(onToggle)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Tick cả nhánh admin' }));
    expect(onToggle).toHaveBeenCalledWith(new Set(['admin/users.md']));
  });

  it('restores the full tree after clearing the query', () => {
    const { rerender } = render(<AppPoolTree pages={pages} query="quan ly" />);
    expect(screen.queryByText('Phân quyền')).toBeNull();

    rerender(<AppPoolTree pages={pages} query="" />);
    expect(screen.getByText('Phân quyền')).toBeTruthy();
    expect(screen.getByText('Báo cáo chỉ số')).toBeTruthy();
    expect(screen.getByText('Nghỉ phép')).toBeTruthy();
  });
});
