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

  it('chưa có token → KHÔNG có ô nhập token; nút "Cấu hình ở Tích hợp" mở /integrations/mcp', async () => {
    const { calls } = stubDaemon({ hasToken: false });
    window.history.replaceState(null, '', '/design-systems');
    render(<FigmaLinksPanel links={LINKS} linksError={null} />);
    await screen.findByText(/Chưa có token/);
    expect(screen.queryByLabelText('Personal Access Token của Figma')).toBeNull();
    expect(screen.queryByTestId('figma-token-save')).toBeNull();
    fireEvent.click(screen.getByTestId('figma-token-settings'));
    expect(window.location.pathname).toBe('/integrations/mcp');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(calls.some((call) => call.url === '/api/figma-config/verify-links')).toBe(false);
  });

  it('onOpenTokenSettings được ưu tiên hơn điều hướng mặc định', async () => {
    stubDaemon({ hasToken: false });
    window.history.replaceState(null, '', '/design-systems');
    const onOpen = vi.fn();
    render(<FigmaLinksPanel links={LINKS} linksError={null} onOpenTokenSettings={onOpen} />);
    await screen.findByText(/Chưa có token/);
    fireEvent.click(screen.getByTestId('figma-token-settings'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/design-systems');
  });

  it('chưa có token → "Kiểm tra lại" đọc lại config; token vừa lưu ở Tích hợp → tự kiểm tra link', async () => {
    const state = { hasToken: false };
    const { calls } = stubDaemon(state);
    const states: Array<{ status: string }> = [];
    render(<FigmaLinksPanel links={LINKS} linksError={null} onVerificationChange={(s) => states.push(s)} />);
    await screen.findByText(/Chưa có token/);
    expect(states.at(-1)).toMatchObject({ status: 'failed' });
    state.hasToken = true;
    fireEvent.click(screen.getByTestId('figma-token-recheck'));
    await screen.findByText(/tài khoản anh/);
    await screen.findByText('UI Kit');
    expect(states.at(-1)).toMatchObject({ status: 'verified', linksKey: 'ABC:' });
    expect(calls.filter((call) => call.method === 'GET' && call.url === '/api/figma-config')).toHaveLength(2);
  });

  it('token đã lưu nhưng daemon báo hỏng → hiện lý do + dẫn sang Tích hợp, không verify link', async () => {
    const { calls } = stubDaemon({ hasToken: true, testOk: false });
    render(<FigmaLinksPanel links={LINKS} linksError={null} />);
    await screen.findByText(/không hợp lệ hoặc đã bị thu hồi/);
    expect(screen.getByTestId('figma-token-settings').textContent).toBe('Cấu hình ở Tích hợp');
    expect(calls.some((call) => call.url === '/api/figma-config/verify-links')).toBe(false);
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
