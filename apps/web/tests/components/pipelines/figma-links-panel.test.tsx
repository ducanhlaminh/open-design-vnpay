// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FigmaLinksPanel } from '../../../src/components/pipelines/FigmaLinksPanel';

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LINKS = [{ url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }];

function stubDaemon(state: { hasToken: boolean; verify?: () => unknown; testOk?: boolean }) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url === '/api/figma-config' && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ hasToken: state.hasToken }), { status: 200 });
    }
    if (url === '/api/figma-config' && init?.method === 'PUT') {
      state.hasToken = Boolean(body?.token);
      return new Response(JSON.stringify({ hasToken: state.hasToken }), { status: 200 });
    }
    if (url === '/api/figma-config/test') {
      return new Response(JSON.stringify(state.testOk === false
        ? { ok: false, detail: 'Token Figma không hợp lệ hoặc đã bị thu hồi.' }
        : { ok: true, handle: 'anh' }), { status: 200 });
    }
    if (url === '/api/figma-config/verify-links') {
      return new Response(JSON.stringify(state.verify?.() ?? { hasToken: state.hasToken, links: [
        { fileKey: 'ABC', url: LINKS[0]!.url, ok: true, name: 'UI Kit', componentCount: 42 },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

describe('FigmaLinksPanel', () => {
  it('có token → tự kiểm tra link và hiện tên file + số component', async () => {
    const { calls } = stubDaemon({ hasToken: true });
    render(<FigmaLinksPanel links={LINKS} linksError={null} />);
    await screen.findByText(/tài khoản anh/);
    await screen.findByText('UI Kit');
    expect(screen.getByText('42 component')).toBeTruthy();
    const verify = calls.find((call) => call.url === '/api/figma-config/verify-links');
    expect(verify?.body).toEqual({ links: LINKS });
  });

  it('chưa có token → hiện ô dán token + hướng dẫn; Lưu token thì test trước rồi PUT, sau đó tự kiểm tra link', async () => {
    const { calls } = stubDaemon({ hasToken: false });
    render(<FigmaLinksPanel links={LINKS} linksError={null} />);
    await screen.findByText(/Chưa có token/);
    fireEvent.click(screen.getByRole('button', { name: 'Cách lấy token' }));
    expect(screen.getByText(/Personal access tokens/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Personal Access Token của Figma'), { target: { value: 'figd_new' } });
    fireEvent.click(screen.getByTestId('figma-token-save'));

    await screen.findByText(/tài khoản anh/);
    const order = calls.filter((call) => call.url.startsWith('/api/figma-config')).map((call) => `${call.method} ${call.url}`);
    expect(order.slice(0, 3)).toEqual(['GET /api/figma-config', 'POST /api/figma-config/test', 'PUT /api/figma-config']);
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ token: 'figd_new' });
    await screen.findByText('UI Kit');
    expect(screen.queryByLabelText('Personal Access Token của Figma')).toBeNull();
  });

  it('token sai → báo lỗi tại chỗ, KHÔNG ghi đè token', async () => {
    const { calls } = stubDaemon({ hasToken: false, testOk: false });
    render(<FigmaLinksPanel links={LINKS} linksError={null} />);
    await screen.findByText(/Chưa có token/);
    fireEvent.change(screen.getByLabelText('Personal Access Token của Figma'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByTestId('figma-token-save'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/không hợp lệ/);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('link không đọc được → dòng đỏ với lý do; link lỗi cú pháp → không gọi daemon', async () => {
    stubDaemon({ hasToken: true, verify: () => ({ hasToken: true, links: [
      { fileKey: 'ABC', url: LINKS[0]!.url, ok: false, name: 'Checkout', componentCount: 0, remoteOnly: true, detail: 'File này không định nghĩa component riêng. Hãy dán link file thư viện gốc.' },
    ] }) });
    render(<FigmaLinksPanel links={LINKS} linksError={null} />);
    await screen.findByText('Checkout');
    expect(screen.getByText(/thư viện gốc/)).toBeTruthy();
    expect(screen.getByText(/Có link chưa đọc được/)).toBeTruthy();
    cleanup();

    const { calls } = stubDaemon({ hasToken: true });
    render(<FigmaLinksPanel links={[]} linksError="Đây không phải link Figma: x" />);
    await screen.findByText(/tài khoản anh/);
    await waitFor(() => expect(screen.getByText('Sửa link ở trên trước đã.')).toBeTruthy());
    expect(calls.some((call) => call.url === '/api/figma-config/verify-links')).toBe(false);
  });
});
