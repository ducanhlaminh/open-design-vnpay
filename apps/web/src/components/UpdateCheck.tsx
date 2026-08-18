// Host-runtime self-update, UI-triggered (not silent). HEADLESS: polls GET
// /api/update/status in the background and owns the outcome (reload on
// `justUpdated`, error / restart-required toasts). The visible control is
// components/HostUpdateButton.tsx in the entry topbar — a header button
// whose own face shows the apply progress (no banner, no modal; asked for
// on 2026-08-18: "button có state progress luôn"). State is shared through
// state/host-update-store.ts so the button reflects an apply started
// before the user navigated, and this poller keeps running (and reloads)
// even while the button is off screen. `od self-update`
// (apps/daemon/src/cli.ts) is the CLI mirror of the same two endpoints.
// Once the daemon comes back up on the new version, the NEXT status poll
// reports `justUpdated`; reload the page so it immediately picks up the
// freshly installed web bundle served by that daemon.
//
// Vietnamese-only copy on purpose — this fork's UI is Vietnamese and we
// avoid new i18n keys here (see InfraSetupGate.tsx / ClaudeAccountSwitcher).
import { useCallback, useEffect } from 'react';
import { Toast } from './Toast';
import {
  getHostUpdateState,
  setHostUpdateState,
  useHostUpdateState,
  type UpdateStatusResponse,
} from '../state/host-update-store';

type UpdateApplyResponse = {
  started?: unknown;
  reason?: unknown;
  error?: unknown;
};

// Turn the apply endpoint's response into an immediate user-facing failure.
// Previously the UI ignored `{started:false}` and every HTTP error, leaving
// the button disabled until the generic 90-second timeout even though the
// daemon had already explained why it could not start.
export function updateApplyFailureMessage(responseOk: boolean, body: unknown): string | null {
  const result = body && typeof body === 'object' ? (body as UpdateApplyResponse) : null;
  if (responseOk && result?.started === true) return null;

  if (typeof result?.error === 'string' && result.error.trim()) return result.error;
  if (result?.reason === 'runs-active') {
    return 'Đang có tác vụ AI chạy. Hãy đợi tác vụ hoàn tất rồi cập nhật lại.';
  }
  if (result?.reason === 'already-in-progress') {
    return 'Một lần cập nhật khác đang được thực hiện.';
  }
  if (typeof result?.reason === 'string' && result.reason.trim()) return result.reason;
  return responseOk
    ? 'Daemon không xác nhận đã bắt đầu cập nhật.'
    : 'Không thể bắt đầu cập nhật.';
}

export function shouldReloadAfterUpdate(
  justUpdated: UpdateStatusResponse['justUpdated'],
): boolean {
  return justUpdated !== null;
}

export function updateRestartRequiredMessage(state: string | null | undefined): string | null {
  return state === 'restart-required'
    ? 'Bản cập nhật đã được cài an toàn. Hãy đăng xuất/đăng nhập lại Windows, hoặc chạy install.ps1 -Start để kích hoạt.'
    : null;
}

// Quiet background cadence when nothing is happening — 7 minutes is a
// reasonable balance between "reasonably prompt" and not hammering the
// daemon (GET /api/update/status itself is cheap; the daemon-side GitHub
// call it fans out to is cached for an hour).
const POLL_INTERVAL_MS = 7 * 60 * 1000;
// Once the user clicks "Cập nhật ngay", poll aggressively — same idea as
// InfraSetupGate's 4s poll while its overlay is open — so the outcome
// (success toast / error toast / timeout message) resolves promptly
// instead of waiting out the full 7-minute background interval.
const FAST_POLL_INTERVAL_MS = 4000;
// install.sh / install.ps1's own health-check-with-rollback window is
// generous but bounded (see the "Host-runtime self-update" comment in
// server.ts); give it headroom before telling the user to reload manually
// — this is a real architectural limit, not a bug: the daemon that
// accepted the apply request kills itself partway through the update, so
// nothing on this side can definitively confirm success beyond polling.
const APPLY_TIMEOUT_MS = 90 * 1000;

// Kick off POST /api/update/apply. Exported (not a hook) so the header
// button can call it without owning the poll. The fast poll in UpdateCheck
// notices the outcome (or times out) regardless of whether this POST itself
// reached the daemon.
export async function startHostUpdate(): Promise<void> {
  if (getHostUpdateState().applying) return;
  setHostUpdateState({
    applying: true,
    applyStartedAt: Date.now(),
    applyError: null,
    restartRequired: null,
  });
  try {
    const res = await fetch('/api/update/apply', { method: 'POST' });
    const body = await res.json().catch(() => null);
    const failure = updateApplyFailureMessage(res.ok, body);
    if (failure) {
      setHostUpdateState({ applying: false, applyStartedAt: null, applyError: failure });
      return;
    }
  } catch {
    // Fire-and-forget — see above.
  }
  // Pick up the outcome immediately instead of waiting out the first
  // fast-poll tick.
  void checkHostUpdateStatus();
}

// Outcome of one status poll, for the header button's explicit
// "Kiểm tra cập nhật" face: `update` = a newer version exists,
// `latest` = GitHub answered and we are on it, `error` = daemon or GitHub
// could not be reached (message when the daemon explained why).
export type HostUpdateCheckOutcome =
  | { kind: 'update'; latestVersion: string }
  | { kind: 'latest'; currentVersion: string }
  | { kind: 'error'; message: string | null };

// `refresh` = user-initiated: `?refresh=1` makes the daemon bypass its
// 5-minute release cache so the answer is live, not the last poll's.
export async function checkHostUpdateStatus(
  { refresh = false }: { refresh?: boolean } = {},
): Promise<HostUpdateCheckOutcome> {
  let body: UpdateStatusResponse;
  try {
    const res = await fetch(refresh ? '/api/update/status?refresh=1' : '/api/update/status');
    if (!res.ok) return { kind: 'error', message: null };
    body = (await res.json()) as UpdateStatusResponse;
  } catch {
    // Daemon unreachable — most likely mid-restart during its own
    // update (install.sh/install.ps1's health-check-with-rollback
    // window), or just a transient blip. Not a hard error: the next
    // scheduled poll (fast, while an apply is in flight) retries.
    return { kind: 'error', message: null };
  }

  setHostUpdateState({ status: body });
  const outcome: HostUpdateCheckOutcome =
    body.updateAvailable && body.latestVersion
      ? { kind: 'update', latestVersion: body.latestVersion }
      : body.checkError || body.latestVersion == null
        ? { kind: 'error', message: body.checkError ?? null }
        : { kind: 'latest', currentVersion: body.currentVersion };

  if (shouldReloadAfterUpdate(body.justUpdated)) {
    setHostUpdateState({ applying: false, applyStartedAt: null });
    window.location.reload();
    return outcome;
  }

  const { applyStartedAt } = getHostUpdateState();
  if (applyStartedAt == null) return outcome;

  const restartMessage = updateRestartRequiredMessage(body.state);
  if (restartMessage) {
    setHostUpdateState({ restartRequired: restartMessage, applying: false, applyStartedAt: null });
    return outcome;
  }

  if (body.lastError) {
    setHostUpdateState({ applyError: body.lastError.message, applying: false, applyStartedAt: null });
    return outcome;
  }

  if (Date.now() - applyStartedAt > APPLY_TIMEOUT_MS) {
    setHostUpdateState({
      applyError: 'Cập nhật có thể chưa xong hoặc thất bại, thử tải lại trang.',
      applying: false,
      applyStartedAt: null,
    });
  }
  return outcome;
}

export function UpdateCheck() {
  const { applying, applyError, restartRequired } = useHostUpdateState();

  const checkStatus = useCallback(() => void checkHostUpdateStatus(), []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Poll cadence switches to FAST_POLL_INTERVAL_MS for as long as an apply
  // is in flight, then falls back to the quiet 7-minute cadence — mirrors
  // InfraSetupGate's docker-status poll gated on whether its setup flow is
  // active.
  useEffect(() => {
    const id = window.setInterval(checkStatus, applying ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [applying, checkStatus]);

  return (
    <>
      {applyError ? (
        <Toast
          role="alert"
          message="Cập nhật thất bại"
          details={applyError}
          onDismiss={() => setHostUpdateState({ applyError: null })}
        />
      ) : null}
      {restartRequired ? (
        <Toast
          message="Cần khởi động lại"
          details={restartRequired}
          ttlMs={0}
          onDismiss={() => setHostUpdateState({ restartRequired: null })}
        />
      ) : null}
    </>
  );
}
