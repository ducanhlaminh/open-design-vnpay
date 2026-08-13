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
});
