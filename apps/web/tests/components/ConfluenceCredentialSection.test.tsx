// @vitest-environment jsdom

// WP8 — Confluence PAT gets its own small Settings
// section, independent of the generic external-MCP config panel. Covers:
// hydration from GET, the "saved" state never showing a real token value,
// and Save issuing a PUT with the typed fields.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfluenceCredentialSection } from '../../src/components/ConfluenceCredentialSection';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ConfluenceCredentialSection', () => {
  it('shows a compact connected state and never renders a PAT input after setup', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (url === '/api/confluence-config' && (!init || init.method === undefined)) {
        return jsonResponse({ base: 'https://wiki.example.test', hasToken: true });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });

    render(<ConfluenceCredentialSection />);

    await screen.findByText('PAT đã được lưu an toàn');
    expect(screen.queryByTestId('confluence-config-base-input')).toBeNull();
    expect(screen.queryByTestId('confluence-config-token-input')).toBeNull();
    expect(screen.queryByTestId('confluence-token-modal-input')).toBeNull();
    expect(screen.getByRole('button', { name: 'Thay đổi PAT' })).toBeTruthy();
    // No literal secret value leaked into the DOM anywhere.
    expect(document.body.textContent).not.toMatch(/hasToken|real-token|actual-secret/);

    fireEvent.click(screen.getByRole('button', { name: 'Thay đổi PAT' }));
    expect(screen.getByRole('dialog', { name: 'Thay đổi Confluence PAT' })).toBeTruthy();
    expect(screen.getByTestId('confluence-token-modal-input')).toBeTruthy();
  });

  it('opens a dedicated edit modal and saves only the replacement PAT', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (url === '/api/confluence-config' && (!init || !init.method)) {
        return jsonResponse({ base: 'https://wiki.servicehub.vn', hasToken: false });
      }
      if (url === '/api/confluence-config' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ token: 'brand-new-token' });
        return jsonResponse({ base: 'https://wiki.servicehub.vn', hasToken: true });
      }
      throw new Error(`unexpected fetch ${String(url)} ${init?.method ?? 'GET'}`);
    });

    render(<ConfluenceCredentialSection />);

    await screen.findByText('Chưa có Personal Access Token');
    fireEvent.click(screen.getByRole('button', { name: 'Thiết lập PAT' }));
    const tokenInput = screen.getByTestId('confluence-token-modal-input') as HTMLInputElement;
    fireEvent.change(tokenInput, { target: { value: 'brand-new-token' } });
    fireEvent.click(screen.getByTestId('confluence-token-modal-save'));

    await waitFor(() => expect(screen.getByText('PAT đã được lưu an toàn')).toBeTruthy());
    expect(screen.queryByTestId('confluence-token-modal-input')).toBeNull();
    expect(screen.queryByTestId('confluence-config-token-input')).toBeNull();
  });

  it('uses the daemon-configured URL for the token link without exposing a URL field', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (url === '/api/confluence-config' && (!init || !init.method)) {
        return jsonResponse({ base: 'https://wiki.servicehub.vn', hasToken: false });
      }
      throw new Error(`unexpected fetch ${String(url)} ${init?.method ?? 'GET'}`);
    });

    render(<ConfluenceCredentialSection />);

    const link = (await screen.findByTestId('confluence-config-token-link')) as HTMLAnchorElement;
    expect(screen.queryByTestId('confluence-config-base-input')).toBeNull();
    expect(link.href).toBe('https://wiki.servicehub.vn/plugins/personalaccesstokens/usertokens.action');
    expect(link.target).toBe('_blank');
  });

  it('opens the low-tech token guide and pastes its token back into the settings form', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (url === '/api/confluence-config' && (!init || !init.method)) {
        return jsonResponse({ base: 'https://wiki.servicehub.vn', hasToken: false });
      }
      throw new Error(`unexpected fetch ${String(url)} ${init?.method ?? 'GET'}`);
    });

    render(<ConfluenceCredentialSection />);
    await screen.findByText('Chưa có Personal Access Token');
    fireEvent.click(screen.getByRole('button', { name: 'Hướng dẫn lấy PAT' }));

    const dialog = screen.getByRole('dialog', { name: 'Hướng dẫn lấy Confluence Access Token' });
    expect(dialog.textContent).toContain('Mở trang Personal Access Tokens');
    expect(dialog.textContent).toContain('Đặt tên và tạo token');
    expect(dialog.textContent).toContain('Sao chép token ngay khi Confluence hiển thị');
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(
      screen.getByAltText('Trang Personal Access Tokens với nút Create token ở góc phải được khoanh đỏ')
        .getAttribute('src'),
    ).toBe('/guides/confluence-token/step-1-create-token.svg');
    expect(
      screen.getByAltText('Form tạo Personal Access Token với ô Token Name và tùy chọn Automatic expiry được đánh dấu đỏ')
        .getAttribute('src'),
    ).toBe('/guides/confluence-token/step-2-configure-token.svg');
    expect(screen.getByAltText('Token mới tạo và nút sao chép được đánh dấu đỏ').getAttribute('src')).toBe(
      '/guides/confluence-token/step-3-copy-token.svg',
    );
    const createLink = screen.getByRole('link', { name: /Mở trang tạo token/ }) as HTMLAnchorElement;
    expect(createLink.href).toBe('https://wiki.servicehub.vn/plugins/personalaccesstokens/usertokens.action');

    const useButton = screen.getByRole('button', { name: 'Dùng token này' }) as HTMLButtonElement;
    expect(useButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Dán token vào đây/), { target: { value: ' token-from-guide ' } });
    expect(useButton.disabled).toBe(false);
    fireEvent.click(useButton);

    expect(screen.queryByRole('dialog', { name: 'Hướng dẫn lấy Confluence Access Token' })).toBeNull();
    const modalInput = screen.getByTestId('confluence-token-modal-input') as HTMLInputElement;
    expect(modalInput.value).toBe('token-from-guide');
    expect(screen.getByRole('dialog', { name: 'Thiết lập Confluence PAT' })).toBeTruthy();
  });

  it('tests the saved PAT without exposing or resubmitting it from the browser', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (url === '/api/confluence-config' && (!init || !init.method)) {
        return jsonResponse({ base: 'https://wiki.servicehub.vn', hasToken: true });
      }
      if (url === '/api/confluence-config/test' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({});
        return jsonResponse({ ok: true, displayName: 'Alice' });
      }
      throw new Error(`unexpected fetch ${String(url)} ${init?.method ?? 'GET'}`);
    });

    render(<ConfluenceCredentialSection />);

    const testButton = (await screen.findByTestId('confluence-config-test')) as HTMLButtonElement;
    expect(testButton.disabled).toBe(false);
    fireEvent.click(testButton);

    await waitFor(() => expect(screen.getByTestId('confluence-config-test-result').textContent).toContain('Alice'));
  });

  it('Test connection surfaces a failure detail from the daemon', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (url === '/api/confluence-config' && (!init || !init.method)) {
        return jsonResponse({ base: 'https://wiki.servicehub.vn', hasToken: true });
      }
      if (url === '/api/confluence-config/test' && init?.method === 'POST') {
        return jsonResponse({ ok: false, detail: 'Token khong hop le hoac da het han (HTTP 401).' });
      }
      throw new Error(`unexpected fetch ${String(url)} ${init?.method ?? 'GET'}`);
    });

    render(<ConfluenceCredentialSection />);

    fireEvent.click(await screen.findByTestId('confluence-config-test'));

    await waitFor(() =>
      expect(screen.getByTestId('confluence-config-test-result').textContent).toBe(
        'Token khong hop le hoac da het han (HTTP 401).',
      ),
    );
  });
});
