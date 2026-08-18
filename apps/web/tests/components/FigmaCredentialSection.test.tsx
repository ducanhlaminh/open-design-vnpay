// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FigmaCredentialSection } from '../../src/components/FigmaCredentialSection';

vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubDaemon(state: { hasToken: boolean; testOk?: boolean; validTokens?: string[] }) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url === '/api/figma-config' && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ hasToken: state.hasToken }), { status: 200 });
    }
    if (url === '/api/figma-config' && init?.method === 'PUT') {
      if (body?.clear) state.hasToken = false;
      else if (typeof body?.token === 'string' && body.token) state.hasToken = true;
      return new Response(JSON.stringify({ hasToken: state.hasToken }), { status: 200 });
    }
    if (url === '/api/figma-config/test') {
      const draft = typeof body?.token === 'string' ? body.token : undefined;
      const ok = draft
        ? (state.validTokens ?? ['figd_new']).includes(draft)
        : state.testOk !== false;
      return new Response(JSON.stringify(ok
        ? { ok: true, handle: draft ? 'moi' : 'anh' }
        : { ok: false, detail: 'Token Figma không hợp lệ hoặc đã bị thu hồi.' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

describe('FigmaCredentialSection', () => {
  it('chưa có token → badge "Chưa cấu hình" + nút Thiết lập; lưu = probe token mới rồi mới PUT', async () => {
    const { calls } = stubDaemon({ hasToken: false });
    render(<FigmaCredentialSection />);
    await screen.findByText('Chưa cấu hình');
    fireEvent.click(screen.getByTestId('figma-config-setup'));
    fireEvent.change(screen.getByLabelText('Personal Access Token của Figma'), { target: { value: 'figd_new' } });
    fireEvent.click(screen.getByTestId('figma-token-save'));

    await screen.findByText('Đã cấu hình');
    expect(screen.getByText(/tài khoản moi/)).toBeTruthy();
    const order = calls.filter((call) => call.url.startsWith('/api/figma-config')).map((call) => `${call.method} ${call.url}`);
    expect(order).toEqual(['GET /api/figma-config', 'POST /api/figma-config/test', 'PUT /api/figma-config']);
    expect(calls.find((call) => call.url === '/api/figma-config/test')?.body).toEqual({ token: 'figd_new' });
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ token: 'figd_new' });
    expect(screen.queryByLabelText('Personal Access Token của Figma')).toBeNull();
  });

  it('token nháp không hợp lệ → báo lỗi tại chỗ, KHÔNG PUT, token cũ giữ nguyên', async () => {
    const { calls } = stubDaemon({ hasToken: true });
    render(<FigmaCredentialSection />);
    await screen.findByText(/tài khoản anh/);
    fireEvent.click(screen.getByTestId('figma-config-edit'));
    fireEvent.change(screen.getByLabelText('Personal Access Token của Figma'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByTestId('figma-token-save'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/không hợp lệ/);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(screen.getByText(/tài khoản anh/)).toBeTruthy();
  });

  it('có token → "Kiểm tra kết nối" gọi /test không kèm token và hiện tài khoản', async () => {
    const { calls } = stubDaemon({ hasToken: true });
    render(<FigmaCredentialSection />);
    await screen.findByText('Đã cấu hình');
    fireEvent.click(screen.getByTestId('figma-config-test'));
    await screen.findByTestId('figma-config-test-result');
    expect(screen.getByTestId('figma-config-test-result').textContent).toMatch(/tài khoản anh/);
    const tests = calls.filter((call) => call.url === '/api/figma-config/test');
    expect(tests).toHaveLength(2);
    expect(tests[1]!.body).toEqual({});
  });

  it('token đã lưu nhưng hỏng → badge "Cần kiểm tra" + lý do từ daemon', async () => {
    stubDaemon({ hasToken: true, testOk: false });
    render(<FigmaCredentialSection />);
    await screen.findByText('Cần kiểm tra');
    expect(screen.getByText(/không hợp lệ hoặc đã bị thu hồi/)).toBeTruthy();
    expect(screen.getByTestId('figma-config-edit')).toBeTruthy();
  });

  it('"Gỡ token" → confirm rồi PUT {clear:true} → về trạng thái chưa cấu hình', async () => {
    const { calls } = stubDaemon({ hasToken: true });
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<FigmaCredentialSection />);
    await screen.findByText('Đã cấu hình');
    fireEvent.click(screen.getByTestId('figma-config-clear'));
    await screen.findByText('Chưa cấu hình');
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ clear: true });
    await waitFor(() => expect(screen.getByTestId('figma-config-setup')).toBeTruthy());
  });

  it('hướng dẫn lấy token mở/đóng tại chỗ và có link sang trang Settings của Figma', async () => {
    stubDaemon({ hasToken: false });
    render(<FigmaCredentialSection />);
    await screen.findByText('Chưa cấu hình');
    fireEvent.click(screen.getByRole('button', { name: /Cách lấy token/ }));
    expect(screen.getByText(/Personal access tokens/)).toBeTruthy();
    expect((screen.getByTestId('figma-config-token-link') as HTMLAnchorElement).href).toBe('https://www.figma.com/settings');
  });
});
