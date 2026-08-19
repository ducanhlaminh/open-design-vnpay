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
  manifest: { schema_version: 1; screens: ScreenManifestEntry[] } | null;
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
