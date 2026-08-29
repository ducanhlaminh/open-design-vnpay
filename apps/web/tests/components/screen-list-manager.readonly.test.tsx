// @vitest-environment jsdom
//
// wp-docs-review-report-quick-result (Executor W1): ScreenListManager trong dự
// án ảo `drsnap.*` (báo cáo xác nhận) chỉ xem — không Đổi tên/Bỏ/Hoàn tác,
// không form "Thêm màn"; bảng màn + trạng thái chờ (Sẽ bỏ / Sắp thêm) vẫn hiện.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { ScreenListManager } from '../../src/components/ScreenListManager';
import type { ScreenManifestEntry, ScreensOverrideEntry } from '../../src/components/ScreenListManager';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SNAP_ID = 'drsnap.abc123.p1';

const SCREENS: ScreenManifestEntry[] = [
  { key: 'login__DN01', code: 'DN01', name: 'Đăng nhập', source: 'docs/confluence/login.md', origin: 'doc', line: 12, hasSection: true },
  { key: 'home__TC01', code: 'TC01', name: 'Trang chủ', source: 'flows/f1.flow.json', origin: 'flow', line: null, hasSection: false },
];
const OVERRIDES: ScreensOverrideEntry[] = [
  { action: 'remove', key: 'home__TC01' },
  { action: 'add', source: 'docs/x.md', code: 'OT01', name: 'Xác thực OTP' },
];

function mockFetch() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/docs-review/screens')) {
      return new Response(JSON.stringify({ manifest: { schema_version: 1, screens: SCREENS }, overrides: { schema_version: 1, overrides: OVERRIDES } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ScreenListManager — chỉ xem trong dự án ảo drsnap.*', () => {
  it('drsnap.* → bảng vẫn 2 hàng + trạng thái chờ, nhưng không nút Đổi tên/Bỏ/Hoàn tác, không form Thêm màn', async () => {
    const fetchMock = mockFetch();
    render(<ScreenListManager projectId={SNAP_ID} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Màn hình (2)')).toBeTruthy());
    expect(screen.getByTestId('screen-row-login__DN01')).toBeTruthy();
    // Hàng đã "Bỏ" vẫn báo trạng thái, không nút Hoàn tác.
    expect(screen.getByTestId('screen-row-home__TC01').textContent).toContain('Sẽ bỏ');
    expect(screen.queryByTestId('undo-remove-home__TC01')).toBeNull();
    expect(screen.queryByTestId('remove-btn-login__DN01')).toBeNull();
    expect(screen.queryByTestId('rename-btn-login__DN01')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bỏ' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Đổi tên' })).toBeNull();
    // "Sắp thêm" vẫn liệt kê, không Hoàn tác.
    expect(screen.getByTestId('pending-adds').textContent).toContain('Xác thực OTP');
    expect(screen.queryByTestId('undo-add-0')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hoàn tác' })).toBeNull();
    expect(screen.queryByText('Thêm màn')).toBeNull();
    expect(screen.queryByTestId('add-save')).toBeNull();
    // Chỉ GET danh sách, không PUT nào.
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === undefined)).toBe(true);
  });

  it('đối chứng: projectId thường vẫn có Đổi tên/Bỏ/Hoàn tác + form Thêm màn', async () => {
    mockFetch();
    render(<ScreenListManager projectId="p1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Màn hình (2)')).toBeTruthy());
    expect(screen.getByTestId('remove-btn-login__DN01')).toBeTruthy();
    expect(screen.getByTestId('rename-btn-login__DN01')).toBeTruthy();
    expect(screen.getByTestId('undo-remove-home__TC01')).toBeTruthy();
    expect(screen.getByTestId('undo-add-0')).toBeTruthy();
    expect(screen.getByTestId('add-save')).toBeTruthy();
  });
});
