// @vitest-environment jsdom
// Header update button: hidden until an update exists; clicking POSTs
// /api/update/apply and the button ITSELF turns into the progress
// indicator (percent in the label + --od-update-percent fill). No banner,
// no modal.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostUpdateButton, hostUpdateButtonLabel } from '../../src/components/HostUpdateButton';
import {
  hostUpdatePercent,
  resetHostUpdateState,
  setHostUpdateState,
  type UpdateStatusResponse,
} from '../../src/state/host-update-store';

function status(overrides: Partial<UpdateStatusResponse> = {}): UpdateStatusResponse {
  return {
    currentVersion: '0.8.41',
    latestVersion: '0.8.42',
    updateAvailable: true,
    justUpdated: null,
    lastError: null,
    state: null,
    progress: null,
    ...overrides,
  };
}

describe('hostUpdateButtonLabel / hostUpdatePercent', () => {
  it('labels the three faces', () => {
    expect(hostUpdateButtonLabel({ applying: false, percent: 0, restartRequired: false, latestVersion: '0.8.42' }))
      .toBe('Cập nhật v0.8.42');
    expect(hostUpdateButtonLabel({ applying: true, percent: 42, restartRequired: false, latestVersion: '0.8.42' }))
      .toBe('Đang cập nhật · 42%');
    expect(hostUpdateButtonLabel({ applying: false, percent: 0, restartRequired: true, latestVersion: '0.8.42' }))
      .toBe('Cần khởi động lại');
  });

  it('prefers the daemon percent, falls back to steps, never reaches 100', () => {
    expect(hostUpdatePercent(status({ progress: { step: 1, totalSteps: 6, label: 'x', percent: 8 } }))).toBe(8);
    expect(hostUpdatePercent(status({ progress: { step: 4, totalSteps: 6, label: 'x' } }))).toBe(50);
    expect(hostUpdatePercent(status({ progress: { step: 6, totalSteps: 6, label: 'x', percent: 100 } }))).toBe(99);
    expect(hostUpdatePercent(status({ progress: null }))).toBe(0);
  });
});

describe('<HostUpdateButton />', () => {
  beforeEach(() => {
    resetHostUpdateState();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetHostUpdateState();
  });

  it('renders nothing when no update is available', () => {
    setHostUpdateState({ status: status({ updateAvailable: false }) });
    render(<HostUpdateButton />);
    expect(screen.queryByTestId('host-update-button')).toBeNull();
  });

  it('shows the accent CTA with the new version and starts the apply on click', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/update/apply' && init?.method === 'POST') {
        return new Response(JSON.stringify({ started: true }), { status: 200 });
      }
      if (url === '/api/update/status') {
        return new Response(
          JSON.stringify(status({ progress: { step: 1, totalSteps: 6, label: 'Kiem tra goi cai dat', percent: 8 } })),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    setHostUpdateState({ status: status() });
    render(<HostUpdateButton />);

    const button = screen.getByTestId('host-update-button') as HTMLButtonElement;
    expect(button.textContent).toContain('Cập nhật v0.8.42');
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/update/apply', expect.objectContaining({ method: 'POST' }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('host-update-button').textContent).toContain('Đang cập nhật · 8%');
    });
    const applying = screen.getByTestId('host-update-button') as HTMLButtonElement;
    expect(applying.disabled).toBe(true);
    expect(applying.getAttribute('data-percent')).toBe('8');
    expect(applying.style.getPropertyValue('--od-update-percent')).toBe('8%');
  });

  it('shows the restart face for the Windows safe-fallback state', () => {
    setHostUpdateState({ status: status({ state: 'restart-required' }) });
    render(<HostUpdateButton />);
    const button = screen.getByTestId('host-update-button') as HTMLButtonElement;
    expect(button.textContent).toContain('Cần khởi động lại');
    expect(button.disabled).toBe(true);
  });
});
