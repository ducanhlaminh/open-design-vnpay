// @vitest-environment jsdom

// WP8 — Confluence credential (base URL + PAT) gets its own small Settings
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
  it('hydrates from GET and shows a "saved" badge without ever rendering the real token', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (url === '/api/confluence-config' && (!init || init.method === undefined)) {
        return jsonResponse({ base: 'https://wiki.example.test', hasToken: true });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });

    render(<ConfluenceCredentialSection />);

    const baseInput = (await screen.findByTestId('confluence-config-base-input')) as HTMLInputElement;
    await waitFor(() => expect(baseInput.value).toBe('https://wiki.example.test'));

    // Saved badge shows, but the password field itself stays empty — the
    // real token is never sent back by the daemon and never appears here.
    expect(screen.getByText('Saved')).toBeTruthy();
    const tokenInput = screen.getByTestId('confluence-config-token-input') as HTMLInputElement;
    expect(tokenInput.type).toBe('password');
    expect(tokenInput.value).toBe('');
    // No literal secret value leaked into the DOM anywhere.
    expect(document.body.textContent).not.toMatch(/hasToken|real-token|actual-secret/);
  });

  it('Save PUTs the typed base + token, then clears the token field', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (url === '/api/confluence-config' && (!init || !init.method)) {
        return jsonResponse({ base: '', hasToken: false });
      }
      if (url === '/api/confluence-config' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ base: 'https://new.example.test', token: 'brand-new-token' });
        return jsonResponse({ base: 'https://new.example.test', hasToken: true });
      }
      throw new Error(`unexpected fetch ${String(url)} ${init?.method ?? 'GET'}`);
    });

    render(<ConfluenceCredentialSection />);

    const baseInput = (await screen.findByTestId('confluence-config-base-input')) as HTMLInputElement;
    await waitFor(() => expect(baseInput.disabled).toBe(false));

    fireEvent.change(baseInput, { target: { value: 'https://new.example.test' } });
    const tokenInput = screen.getByTestId('confluence-config-token-input') as HTMLInputElement;
    fireEvent.change(tokenInput, { target: { value: 'brand-new-token' } });

    fireEvent.click(screen.getByTestId('confluence-config-save'));

    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
    await waitFor(() => expect((screen.getByTestId('confluence-config-token-input') as HTMLInputElement).value).toBe(''));
  });

  it('defaults the base URL to wiki.servicehub.vn when nothing is saved yet, and links to the token-creation page', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (url === '/api/confluence-config' && (!init || !init.method)) {
        return jsonResponse({ base: '', hasToken: false });
      }
      throw new Error(`unexpected fetch ${String(url)} ${init?.method ?? 'GET'}`);
    });

    render(<ConfluenceCredentialSection />);

    const baseInput = (await screen.findByTestId('confluence-config-base-input')) as HTMLInputElement;
    await waitFor(() => expect(baseInput.value).toBe('https://wiki.servicehub.vn'));

    const link = screen.getByTestId('confluence-config-token-link') as HTMLAnchorElement;
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
    await waitFor(() => expect((screen.getByTestId('confluence-config-base-input') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Hướng dẫn lấy token' }));

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
    expect((screen.getByTestId('confluence-config-token-input') as HTMLInputElement).value).toBe('token-from-guide');
  });

  it('Test connection posts the pasted token and shows the daemon result', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (url === '/api/confluence-config' && (!init || !init.method)) {
        return jsonResponse({ base: 'https://wiki.servicehub.vn', hasToken: false });
      }
      if (url === '/api/confluence-config/test' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ base: 'https://wiki.servicehub.vn', token: 'pasted-token' });
        return jsonResponse({ ok: true, displayName: 'Alice' });
      }
      throw new Error(`unexpected fetch ${String(url)} ${init?.method ?? 'GET'}`);
    });

    render(<ConfluenceCredentialSection />);

    const tokenInput = (await screen.findByTestId('confluence-config-token-input')) as HTMLInputElement;
    await waitFor(() => expect(tokenInput.disabled).toBe(false));
    fireEvent.change(tokenInput, { target: { value: 'pasted-token' } });

    const testButton = screen.getByTestId('confluence-config-test') as HTMLButtonElement;
    expect(testButton.disabled).toBe(false);
    fireEvent.click(testButton);

    await waitFor(() => expect(screen.getByTestId('confluence-config-test-result').textContent).toBe('Connected as Alice.'));
  });

  it('Test connection surfaces a failure detail from the daemon', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (url === '/api/confluence-config' && (!init || !init.method)) {
        return jsonResponse({ base: 'https://wiki.servicehub.vn', hasToken: false });
      }
      if (url === '/api/confluence-config/test' && init?.method === 'POST') {
        return jsonResponse({ ok: false, detail: 'Token khong hop le hoac da het han (HTTP 401).' });
      }
      throw new Error(`unexpected fetch ${String(url)} ${init?.method ?? 'GET'}`);
    });

    render(<ConfluenceCredentialSection />);

    const tokenInput = (await screen.findByTestId('confluence-config-token-input')) as HTMLInputElement;
    await waitFor(() => expect(tokenInput.disabled).toBe(false));
    fireEvent.change(tokenInput, { target: { value: 'bad-token' } });
    fireEvent.click(screen.getByTestId('confluence-config-test'));

    await waitFor(() =>
      expect(screen.getByTestId('confluence-config-test-result').textContent).toBe(
        'Token khong hop le hoac da het han (HTTP 401).',
      ),
    );
  });
});
