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

type DesktopStatusOverride = {
  available?: boolean;
  detail?: string;
  activeFileTitle?: string | null;
  canSwitch?: boolean;
  platform?: string;
} | null;

function stubDaemon(state: {
  hasToken: boolean;
  verify?: (body: any) => unknown;
  testOk?: boolean;
  /** undefined → mặc định available; null → daemon lỗi (status !ok). */
  desktopStatus?: DesktopStatusOverride;
}) {
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
      return new Response(JSON.stringify(state.verify?.(body) ?? { hasToken: state.hasToken || Boolean(body?.token), links: [
        { fileKey: 'ABC', url: LINKS[0]!.url, ok: true, name: 'UI Kit', componentCount: 42 },
      ] }), { status: 200 });
    }
    if (url === '/api/figma-desktop/status') {
      if (state.desktopStatus === null) {
        return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
      }
      return new Response(JSON.stringify({
        available: true,
        canSwitch: true,
        platform: 'darwin',
        activeFileTitle: 'UI Kit',
        ...state.desktopStatus,
      }), { status: 200 });
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

  it('chỉ báo verified cho đúng generation link hiện tại và reset ngay khi link đổi', async () => {
    stubDaemon({ hasToken: true });
    const states: Array<{ status: string; linksKey: string }> = [];
    const view = render(<FigmaLinksPanel links={LINKS} linksError={null} onVerificationChange={(state) => states.push(state)} />);
    await screen.findByText('UI Kit');
    expect(states.at(-1)).toMatchObject({ status: 'verified', linksKey: 'ABC:' });

    view.rerender(<FigmaLinksPanel links={[{ url: 'https://www.figma.com/design/XYZ', fileKey: 'XYZ' }]} linksError={null} onVerificationChange={(state) => states.push(state)} />);
    await waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'pending', linksKey: 'XYZ:' }));
  });

  it('chưa có token → draft phải đọc được mọi link rồi mới PUT, sau đó tự kiểm tra link đã lưu', async () => {
    const { calls } = stubDaemon({ hasToken: false });
    render(<FigmaLinksPanel links={LINKS} linksError={null} />);
    await screen.findByText(/Chưa có token/);
    fireEvent.click(screen.getByRole('button', { name: 'Cách lấy token' }));
    expect(screen.getByText(/Personal access tokens/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Personal Access Token của Figma'), { target: { value: 'figd_new' } });
    fireEvent.click(screen.getByTestId('figma-token-save'));

    await screen.findByText(/Đã lưu/);
    const order = calls.filter((call) => call.url.startsWith('/api/figma-config')).map((call) => `${call.method} ${call.url}`);
    expect(order.slice(0, 3)).toEqual(['GET /api/figma-config', 'POST /api/figma-config/verify-links', 'PUT /api/figma-config']);
    expect(calls.find((call) => call.url === '/api/figma-config/verify-links')?.body).toEqual({ links: LINKS, token: 'figd_new' });
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ token: 'figd_new' });
    await screen.findByText('UI Kit');
    expect(screen.queryByLabelText('Personal Access Token của Figma')).toBeNull();
  });

  it('draft token thiếu quyền file → báo lỗi tại chỗ, KHÔNG ghi đè token', async () => {
    const { calls } = stubDaemon({ hasToken: false, verify: (body) => ({ hasToken: Boolean(body?.token), links: [
      { fileKey: 'ABC', url: LINKS[0]!.url, ok: false, detail: 'Token không có quyền đọc file này.' },
    ] }) });
    render(<FigmaLinksPanel links={LINKS} linksError={null} />);
    await screen.findByText(/Chưa có token/);
    fireEvent.change(screen.getByLabelText('Personal Access Token của Figma'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByTestId('figma-token-save'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/không có quyền/);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('response verify rỗng/thiếu file không được tính là hợp lệ và không PUT', async () => {
    const { calls } = stubDaemon({ hasToken: true, verify: () => ({ hasToken: true, links: [] }) });
    render(<FigmaLinksPanel links={LINKS} linksError={null} />);
    await screen.findByText(/tài khoản anh/);
    fireEvent.click(screen.getByRole('button', { name: 'Đổi token' }));
    fireEvent.change(screen.getByLabelText('Personal Access Token của Figma'), { target: { value: 'figd_partial' } });
    fireEvent.click(screen.getByTestId('figma-token-save'));
    await screen.findByText(/chưa trả kết quả kiểm tra cho file ABC/i);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('không cho lưu token khi chưa có link hợp lệ và hiện hướng dẫn', async () => {
    const { calls } = stubDaemon({ hasToken: false });
    render(<FigmaLinksPanel links={[]} linksError="Dán ít nhất 1 link Figma." />);
    await screen.findByText(/Chưa có token/);
    fireEvent.change(screen.getByLabelText('Personal Access Token của Figma'), { target: { value: 'figd_new' } });
    expect((screen.getByTestId('figma-token-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Sửa link Figma ở trên trước khi lưu token/)).toBeTruthy();
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

  it('Figma Desktop đang chạy → hiện trạng thái + tên file đang mở', async () => {
    stubDaemon({ hasToken: true });
    render(<FigmaLinksPanel links={LINKS} linksError={null} />);
    await screen.findByText('Đang chạy · MCP bật · đang mở “UI Kit”');
  });

  it('Figma Desktop chưa kết nối được → hiện lý do + gợi ý không bắt buộc', async () => {
    stubDaemon({ hasToken: true, desktopStatus: { available: false, detail: 'Figma Desktop chưa chạy…' } });
    render(<FigmaLinksPanel links={LINKS} linksError={null} />);
    await screen.findByText('Figma Desktop chưa chạy…');
    expect(screen.getByText(/Không bắt buộc/)).toBeTruthy();
  });

  it('bấm "Kiểm tra lại" của Figma Desktop → gọi lại /api/figma-desktop/status', async () => {
    const { calls } = stubDaemon({ hasToken: true });
    render(<FigmaLinksPanel links={LINKS} linksError={null} />);
    await screen.findByTestId('figma-desktop-recheck');
    fireEvent.click(screen.getByTestId('figma-desktop-recheck'));
    await waitFor(() => {
      expect(calls.filter((call) => call.url === '/api/figma-desktop/status')).toHaveLength(2);
    });
  });

  it('không có link và không lỗi → không hỏi trạng thái Figma Desktop', async () => {
    const { calls } = stubDaemon({ hasToken: true });
    render(<FigmaLinksPanel links={[]} linksError={null} />);
    await screen.findByText('Dán link để kiểm tra.');
    expect(calls.some((call) => call.url === '/api/figma-desktop/status')).toBe(false);
  });
});
