// @vitest-environment jsdom
//
// DocsReviewConfirmStatus (wp-docs-review-confirm-revoke): chip trạng thái
// xác nhận từ GET /docs-review/confirm/state cạnh nút "Xác nhận hoàn tất";
// "Thu hồi xác nhận" hỏi window.confirm rồi POST /docs-review/confirm/revoke,
// sau đó chip tự refetch và chuyển "Đã thu hồi xác nhận" (không còn nút).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  DOCS_REVIEW_REVOKE_CONFIRM_MESSAGE,
  DocsReviewConfirmStatus,
} from '../../../src/components/docs-review/DocsReviewConfirmStatus';

const STATE_URL = '/api/projects/p1/docs-review/confirm/state';
const REVOKE_URL = '/api/projects/p1/docs-review/confirm/revoke';

const CONFIRMED = { latest: { confirmationId: 'c1', confirmedAt: Date.UTC(2026, 7, 28, 3, 0, 0) } };
const REVOKED = {
  latest: {
    confirmationId: 'c1',
    confirmedAt: Date.UTC(2026, 7, 28, 3, 0, 0),
    revoked: { revokedAt: Date.UTC(2026, 7, 29, 4, 0, 0), user: 'binh' },
  },
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('DocsReviewConfirmStatus', () => {
  it('không có bản xác nhận (latest: null) → không render gì', async () => {
    fetchMock.mockResolvedValueOnce(ok({ latest: null }));
    const { container } = render(<DocsReviewConfirmStatus projectId="p1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(STATE_URL));
    expect(container.firstChild).toBeNull();
  });

  it('đã xác nhận → chip + nút thu hồi; window.confirm từ chối → KHÔNG POST', async () => {
    fetchMock.mockResolvedValueOnce(ok(CONFIRMED));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DocsReviewConfirmStatus projectId="p1" />);
    const chip = await screen.findByTestId('pipeline-docs-review-confirm-state');
    expect(chip.textContent).toContain('Đã xác nhận hoàn tất ·');
    fireEvent.click(screen.getByTestId('pipeline-docs-review-revoke'));
    expect(confirmSpy).toHaveBeenCalledWith(DOCS_REVIEW_REVOKE_CONFIRM_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1); // chỉ GET state, không POST
  });

  it('đồng ý thu hồi → POST revoke, gọi onRevoked, chip refetch thành "Đã thu hồi xác nhận"', async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === REVOKE_URL && init?.method === 'POST') return ok({ ok: true, confirmationId: 'c1', revokedAt: REVOKED.latest.revoked.revokedAt });
      if (url === STATE_URL) {
        // GET đầu = đã xác nhận; GET sau thu hồi = revoked.
        return ok(fetchMock.mock.calls.some(([u, i]) => u === REVOKE_URL && (i as { method?: string })?.method === 'POST') ? REVOKED : CONFIRMED);
      }
      return ok({ error: `unexpected ${url}` }, 404);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onRevoked = vi.fn();
    render(<DocsReviewConfirmStatus projectId="p1" onRevoked={onRevoked} />);
    fireEvent.click(await screen.findByTestId('pipeline-docs-review-revoke'));
    await waitFor(() => expect(onRevoked).toHaveBeenCalledWith({ ok: true, confirmationId: 'c1', revokedAt: REVOKED.latest.revoked.revokedAt }));
    await waitFor(() => expect(screen.getByTestId('pipeline-docs-review-confirm-state').textContent).toContain('Đã thu hồi xác nhận ·'));
    // Trạng thái revoked không còn nút thu hồi; nút "Xác nhận hoàn tất" là của cha, không đổi.
    expect(screen.queryByTestId('pipeline-docs-review-revoke')).toBeNull();
  });

  it('bản mới nhất đã thu hồi → chip "Đã thu hồi", không nút; POST lỗi → onRevokeError', async () => {
    fetchMock.mockResolvedValueOnce(ok(REVOKED));
    render(<DocsReviewConfirmStatus projectId="p1" />);
    expect((await screen.findByTestId('pipeline-docs-review-confirm-state')).textContent).toContain('Đã thu hồi xác nhận ·');
    expect(screen.queryByTestId('pipeline-docs-review-revoke')).toBeNull();
    cleanup();

    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === REVOKE_URL && init?.method === 'POST') return ok({ error: 'Bản xác nhận "c1" đã được thu hồi trước đó' }, 409);
      return ok(CONFIRMED);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onRevokeError = vi.fn();
    render(<DocsReviewConfirmStatus projectId="p1" onRevokeError={onRevokeError} />);
    fireEvent.click(await screen.findByTestId('pipeline-docs-review-revoke'));
    await waitFor(() => expect(onRevokeError).toHaveBeenCalledWith('Bản xác nhận "c1" đã được thu hồi trước đó'));
  });
});
