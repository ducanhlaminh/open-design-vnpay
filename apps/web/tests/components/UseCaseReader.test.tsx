// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UseCaseReader } from '../../src/components/UseCaseReader';

const DOC = {
  id: 'FLOW-reader',
  title: 'Đăng ký',
  source: 'flow.md',
  nodes: [
    { id: 'start', type: 'start' as const, label: 'Bắt đầu' },
    { id: 'action', type: 'action' as const, label: 'Nhập thông tin' },
    { id: 'decision', type: 'decision' as const, label: 'Hợp lệ?' },
    { id: 'success', type: 'end' as const, label: 'Thành công' },
    { id: 'error', type: 'action' as const, label: 'Báo lỗi' },
    { id: 'error-end', type: 'end' as const, label: 'Đã dừng' },
  ],
  edges: [
    { from: 'start', to: 'action' },
    { from: 'action', to: 'decision' },
    { from: 'decision', to: 'success', label: 'Có' },
    { from: 'decision', to: 'error', label: 'Không' },
    { from: 'error', to: 'action' },
    { from: 'error', to: 'error-end' },
  ],
};

describe('UseCaseReader', () => {
  it('lists scenarios, opens detail, renders extras, and shows loops', () => {
    const extra = vi.fn((node) => <span>thumbnail-{node.id}</span>);
    render(<UseCaseReader doc={DOC} renderStepExtra={extra} />);

    expect(screen.getAllByText('Thành công').length).toBeGreaterThan(0);
    expect(screen.getByText('Báo lỗi')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Báo lỗi/ }));
    // Bước chung ở đầu nằm trong khối gộp — bung ra mới thấy (và mới gọi
    // renderStepExtra cho node đó).
    const shared = screen.queryByRole('button', { name: /Các bước chung/ });
    if (shared) fireEvent.click(shared);
    expect(screen.getByText('Nhập thông tin')).toBeTruthy();
    expect(screen.getByText('thumbnail-action')).toBeTruthy();
    expect(extra).toHaveBeenCalled();
    expect(screen.getByText(/Quay lại bước #2/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /← Kịch bản/ }));
    expect(screen.getAllByText('Thành công').length).toBeGreaterThan(0);
  });
});
