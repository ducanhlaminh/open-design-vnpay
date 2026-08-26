// @vitest-environment jsdom
//
// WP13b (.tmp/pipeline/wp13b.yaml) — ScreenListManager: bảng "Màn hình (N)"
// với badge nguồn, Đổi tên/Bỏ/Hoàn tác, form "Thêm màn", tất cả ghi qua
// PUT .../screens-overrides (ghi ĐÈ toàn bộ mảng, không PATCH). Test mock
// fetch — không gọi daemon thật (WP14 chưa dựng route).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ScreenListManager } from '../../src/components/ScreenListManager';
import type { ScreenManifestEntry, ScreensOverrideEntry, ScreensOverrides } from '../../src/components/ScreenListManager';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SCREENS: ScreenManifestEntry[] = [
  { key: 'login__DN01', code: 'DN01', name: 'Đăng nhập', source: 'docs/confluence/login.md', origin: 'doc', line: 12, hasSection: true },
  { key: 'home__TC01', code: 'TC01', name: 'Trang chủ', source: 'flows/f1.flow.json', origin: 'flow', line: null, hasSection: false },
  { key: 'otp__OT01', code: 'OT01', name: 'Xác thực OTP', source: null, origin: 'agent', line: null, hasSection: false },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** fetch mock: GET trả manifest+overrides cố định; PUT trả `putResult`
 *  (mặc định 200 { ok: true }) và ghi lại body gửi lên vào `putCalls`. */
function mockFetch(opts: {
  manifest: { schema_version: 1 | 2; screens: ScreenManifestEntry[] } | null;
  overrides?: ScreensOverrideEntry[];
  putResult?: Response | (() => Response);
}) {
  const putCalls: ScreensOverrides[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/docs-review/screens')) {
      return jsonResponse({
        manifest: opts.manifest,
        overrides: opts.overrides ? { schema_version: 1, overrides: opts.overrides } : null,
      });
    }
    if (url.endsWith('/docs-review/screens-overrides')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as ScreensOverrides;
      putCalls.push(body);
      const result = opts.putResult;
      if (typeof result === 'function') return result();
      return result ?? jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, putCalls };
}

describe('ScreenListManager', () => {
  it('1) render bảng 3 hàng với badge nguồn đúng nhãn cho flow/doc/agent', async () => {
    mockFetch({ manifest: { schema_version: 1, screens: SCREENS } });
    render(<ScreenListManager projectId="p1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Màn hình (3)')).toBeTruthy();
    });
    expect(screen.getByTestId('screen-row-login__DN01').textContent).toContain('Tài liệu');
    expect(screen.getByTestId('screen-row-home__TC01').textContent).toContain('Luồng');
    expect(screen.getByTestId('screen-row-otp__OT01').textContent).toContain('Agent');
  });

  it('2) Bỏ một màn → PUT {action:"remove",key}; hàng mờ + Hoàn tác; Hoàn tác → PUT không còn entry đó', async () => {
    const { putCalls } = mockFetch({ manifest: { schema_version: 1, screens: SCREENS } });
    render(<ScreenListManager projectId="p1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('remove-btn-login__DN01')).toBeTruthy());
    fireEvent.click(screen.getByTestId('remove-btn-login__DN01'));

    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]).toEqual({ schema_version: 1, overrides: [{ action: 'remove', key: 'login__DN01' }] });

    const row = screen.getByTestId('screen-row-login__DN01');
    expect(row.getAttribute('style')).toContain('opacity: 0.55');
    expect(row.textContent).toContain('chờ chạy lại');
    const undoBtn = screen.getByTestId('undo-remove-login__DN01');
    expect(undoBtn).toBeTruthy();

    fireEvent.click(undoBtn);
    await waitFor(() => expect(putCalls.length).toBe(2));
    expect(putCalls[1]).toEqual({ schema_version: 1, overrides: [] });
  });

  it('3) Đổi tên → PUT {action:"rename",key,name}', async () => {
    const { putCalls } = mockFetch({ manifest: { schema_version: 1, screens: SCREENS } });
    render(<ScreenListManager projectId="p1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('rename-btn-login__DN01')).toBeTruthy());
    fireEvent.click(screen.getByTestId('rename-btn-login__DN01'));

    const input = screen.getByTestId('rename-input-login__DN01') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Đăng nhập tài khoản' } });
    fireEvent.click(screen.getByTestId('rename-save-login__DN01'));

    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]).toEqual({
      schema_version: 1,
      overrides: [{ action: 'rename', key: 'login__DN01', name: 'Đăng nhập tài khoản' }],
    });
  });

  it('4) Thêm màn đủ field → PUT {action:"add",source,code,name,anchorText}; thiếu tên/mã → nút Lưu disable', async () => {
    const { putCalls } = mockFetch({ manifest: { schema_version: 1, screens: SCREENS } });
    render(<ScreenListManager projectId="p1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('add-save')).toBeTruthy());
    expect((screen.getByTestId('add-save') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('add-code'), { target: { value: 'DN02' } });
    expect((screen.getByTestId('add-save') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('add-source-custom'), { target: { value: 'docs/confluence/signup.md' } });
    fireEvent.change(screen.getByTestId('add-name'), { target: { value: 'Đăng ký' } });
    fireEvent.change(screen.getByTestId('add-anchor'), { target: { value: 'Người dùng bấm nút Đăng ký ở trang chủ.' } });

    expect((screen.getByTestId('add-save') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('add-save'));

    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]).toEqual({
      schema_version: 1,
      overrides: [
        {
          action: 'add',
          source: 'docs/confluence/signup.md',
          code: 'DN02',
          name: 'Đăng ký',
          anchorText: 'Người dùng bấm nút Đăng ký ở trang chủ.',
        },
      ],
    });
  });

  it('5) PUT 200 → banner "chạy lại bước"; PUT 400 → hiện error message', async () => {
    const { putCalls } = mockFetch({
      manifest: { schema_version: 1, screens: SCREENS },
      putResult: () => (putCalls.length === 1 ? jsonResponse({ error: 'Mã màn đã tồn tại' }, 400) : jsonResponse({ ok: true })),
    });
    render(<ScreenListManager projectId="p1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('remove-btn-login__DN01')).toBeTruthy());
    fireEvent.click(screen.getByTestId('remove-btn-login__DN01'));

    await waitFor(() => {
      expect(screen.getByTestId('save-error').textContent).toContain('Mã màn đã tồn tại');
    });
    expect(screen.queryByTestId('save-banner')).toBeNull();

    fireEvent.click(screen.getByTestId('undo-remove-login__DN01'));
    await waitFor(() => {
      expect(screen.getByTestId('save-banner').textContent).toContain('chạy lại bước');
    });
    expect(screen.queryByTestId('save-error')).toBeNull();
  });

  it('6) manifest null → thông điệp trống, không crash', async () => {
    mockFetch({ manifest: null });
    render(<ScreenListManager projectId="p1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('no-manifest-msg').textContent).toContain('Chưa có lần chạy nào');
    });
    expect(screen.queryByTestId('screen-row-login__DN01')).toBeNull();
    // Form "Thêm màn" vẫn dùng được dù chưa có manifest.
    expect(screen.getByTestId('add-code')).toBeTruthy();
  });
});

// screen-variants WP-V5 (docs/screen-variants-spec.md §WP-V5, T7 trong
// docs/screen-variants-subplan.md): manifest schema_version 2 có thể mang
// `platform`/`groupKey` trên entry. Entry cùng `groupKey` phải gộp 1 hàng
// với tab App/Web (nhãn generic — không dùng thuật ngữ riêng dự án bank);
// manifest không entry nào mang field mới (schema v1, khối test phía trên)
// phải TIẾP TỤC render y hệt — đó là lý do khối test trên không đổi.
const SCREENS_V2: ScreenManifestEntry[] = [
  {
    key: 'login__DN01--mb',
    code: 'DN01',
    name: 'Đăng nhập',
    source: 'docs/mb.md',
    origin: 'doc',
    line: 10,
    hasSection: true,
    platform: 'mobile',
    groupKey: 'login__G-dang-nhap',
  },
  {
    key: 'login__DN01--ib',
    code: 'DN02',
    name: 'Đăng nhập',
    source: 'docs/ib.md',
    origin: 'doc',
    line: 20,
    hasSection: true,
    platform: 'web',
    groupKey: 'login__G-dang-nhap',
  },
  {
    key: 'transfer__CT01--mb',
    code: 'CT01',
    name: 'Chuyển tiền',
    source: 'docs/mb.md',
    origin: 'doc',
    line: 30,
    hasSection: true,
    platform: 'mobile',
    groupKey: 'transfer__G-chuyen-tien',
  },
  {
    key: 'transfer__CT01--ib',
    code: 'CT02',
    name: 'Chuyển tiền',
    source: 'docs/ib.md',
    origin: 'doc',
    line: 40,
    hasSection: true,
    platform: 'web',
    groupKey: 'transfer__G-chuyen-tien',
  },
  { key: 'home__TC01', code: 'TC01', name: 'Trang chủ', source: 'flows/f1.flow.json', origin: 'flow', line: null, hasSection: false },
];

describe('ScreenListManager — nhóm biến thể (manifest schema_version 2)', () => {
  it('a) 2 nhóm groupKey + 1 màn đơn → đúng số hàng, đúng tab, click tab đổi selection key', async () => {
    mockFetch({ manifest: { schema_version: 2, screens: SCREENS_V2 } });
    render(<ScreenListManager projectId="p1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Màn hình (5)')).toBeTruthy();
    });

    // Đúng số hàng: 2 hàng nhóm (mặc định hiện thành viên mobile) + 1 hàng đơn = 3.
    expect(screen.getAllByRole('row')).toHaveLength(1 + 3); // 1 header + 3 body rows
    expect(screen.getByTestId('screen-row-login__DN01--mb')).toBeTruthy();
    expect(screen.getByTestId('screen-row-transfer__CT01--mb')).toBeTruthy();
    expect(screen.getByTestId('screen-row-home__TC01')).toBeTruthy();
    // Màn đơn không có tab nhóm.
    expect(screen.queryByTestId('screen-group-tabs-home__TC01')).toBeNull();

    // Tab đúng nhãn App/Web, mobile là mặc định đang chọn.
    const mbTab = screen.getByTestId('screen-tab-login__G-dang-nhap-mobile');
    const webTab = screen.getByTestId('screen-tab-login__G-dang-nhap-web');
    expect(mbTab.textContent).toBe('App');
    expect(webTab.textContent).toBe('Web');
    expect(mbTab.getAttribute('aria-pressed')).toBe('true');
    expect(webTab.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('screen-row-login__DN01--mb').textContent).toContain('DN01');

    // Click tab Web → đổi sang key thành viên web cho MỌI hành vi (hàng, mã, nút thao tác).
    fireEvent.click(webTab);
    expect(screen.queryByTestId('screen-row-login__DN01--mb')).toBeNull();
    const row = screen.getByTestId('screen-row-login__DN01--ib');
    expect(row.textContent).toContain('DN02');
    expect(screen.getByTestId('rename-btn-login__DN01--ib')).toBeTruthy();
    expect(screen.getByTestId('remove-btn-login__DN01--ib')).toBeTruthy();
    // Nhóm khác không bị ảnh hưởng bởi việc đổi tab của nhóm này.
    expect(screen.getByTestId('screen-row-transfer__CT01--mb')).toBeTruthy();

    // Đổi tên áp vào đúng key thành viên đang chọn (web).
    fireEvent.click(screen.getByTestId('rename-btn-login__DN01--ib'));
    fireEvent.change(screen.getByTestId('rename-input-login__DN01--ib'), { target: { value: 'Đăng nhập IB' } });
    fireEvent.click(screen.getByTestId('rename-save-login__DN01--ib'));
    await waitFor(() => {
      expect(screen.getByTestId('screen-row-login__DN01--ib').textContent).toContain('chờ chạy lại');
    });
  });

  it('b) manifest v1 (không platform/groupKey) → render như cũ, không có tab nhóm', async () => {
    mockFetch({ manifest: { schema_version: 1, screens: SCREENS } });
    render(<ScreenListManager projectId="p1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Màn hình (3)')).toBeTruthy();
    });
    expect(screen.getByTestId('screen-row-login__DN01')).toBeTruthy();
    expect(screen.getByTestId('screen-row-home__TC01')).toBeTruthy();
    expect(screen.getByTestId('screen-row-otp__OT01')).toBeTruthy();
    // Không đường nào phát sinh tab/badge platform cho dữ liệu v1.
    expect(screen.queryByTestId('platform-badge')).toBeNull();
    expect(screen.queryAllByTestId(/^screen-tab-/).length).toBe(0);
    expect(screen.queryAllByTestId(/^screen-group-tabs-/).length).toBe(0);
  });
});
