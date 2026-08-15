// Host-runtime self-update, UI-triggered (not silent). Polls GET
// /api/update/status in the background; when a newer host-runtime release
// exists it shows a small non-blocking banner with a button so the user
// decides when to update — no more firing POST /api/update/apply on its
// own the moment `updateAvailable` flips true (that used to happen here;
// the repo owner asked for an explicit action instead). `od self-update`
// (apps/daemon/src/cli.ts) is the CLI mirror of the same two endpoints.
// Once the daemon comes back up on the new version, the NEXT status poll
// reports `justUpdated`; reload the page so it immediately picks up the
// freshly installed web bundle served by that daemon.
//
// Vietnamese-only copy on purpose — this fork's UI is Vietnamese and we
// avoid new i18n keys here (see InfraSetupGate.tsx / ClaudeAccountSwitcher).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Toast } from './Toast';
import styles from './UpdateCheck.module.css';

interface UpdateStatusResponse {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  justUpdated: { version: string; at: string } | null;
  lastError: { message: string; at: string } | null;
  // Parsed from the running install.sh/install.ps1's own "N/6 <label>" phase
  // output — only non-null while THIS daemon process is still the one
  // applying the update (see server.ts's readUpdateProgress).
  progress: { step: number; totalSteps: number; label: string } | null;
}

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

export function UpdateCheck() {
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyOutcomeError, setApplyOutcomeError] = useState<string | null>(null);
  // Wall-clock start of the current apply attempt, for the timeout check
  // in checkStatus below. A ref (not state) since it must not itself
  // trigger a re-render.
  const applyStartedAtRef = useRef<number | null>(null);

  const checkStatus = useCallback(async () => {
    let body: UpdateStatusResponse;
    try {
      const res = await fetch('/api/update/status');
      if (!res.ok) return;
      body = (await res.json()) as UpdateStatusResponse;
    } catch {
      // Daemon unreachable — most likely mid-restart during its own
      // update (install.sh/install.ps1's health-check-with-rollback
      // window), or just a transient blip. Not a hard error: the next
      // scheduled poll (fast, while an apply is in flight) retries.
      return;
    }

    setStatus(body);

    if (shouldReloadAfterUpdate(body.justUpdated)) {
      setApplying(false);
      applyStartedAtRef.current = null;
      window.location.reload();
      return;
    }

    if (applyStartedAtRef.current == null) return;

    if (body.lastError) {
      setApplyOutcomeError(body.lastError.message);
      setApplying(false);
      applyStartedAtRef.current = null;
      return;
    }

    if (Date.now() - applyStartedAtRef.current > APPLY_TIMEOUT_MS) {
      setApplyOutcomeError('Cập nhật có thể chưa xong hoặc thất bại, thử tải lại trang.');
      setApplying(false);
      applyStartedAtRef.current = null;
    }
  }, []);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  // Poll cadence switches to FAST_POLL_INTERVAL_MS for as long as an apply
  // is in flight, then falls back to the quiet 7-minute cadence — mirrors
  // InfraSetupGate's docker-status poll gated on whether its setup flow is
  // active.
  useEffect(() => {
    const id = window.setInterval(
      () => void checkStatus(),
      applying ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(id);
  }, [applying, checkStatus]);

  const startApply = useCallback(async () => {
    setApplying(true);
    setApplyOutcomeError(null);
    applyStartedAtRef.current = Date.now();
    try {
      const res = await fetch('/api/update/apply', { method: 'POST' });
      const body = await res.json().catch(() => null);
      const failure = updateApplyFailureMessage(res.ok, body);
      if (failure) {
        setApplyOutcomeError(failure);
        setApplying(false);
        applyStartedAtRef.current = null;
        return;
      }
    } catch {
      // Fire-and-forget — the fast poll above notices the outcome (or
      // times out) regardless of whether this POST itself reached the
      // daemon.
    }
    // Pick up the outcome immediately instead of waiting out the first
    // fast-poll tick.
    void checkStatus();
  }, [checkStatus]);

  return (
    <>
      {applyOutcomeError ? (
        <Toast
          role="alert"
          message="Cập nhật thất bại"
          details={applyOutcomeError}
          onDismiss={() => setApplyOutcomeError(null)}
        />
      ) : null}
      {status?.updateAvailable ? (
        <div className={styles.banner} role="status">
          <div className={styles.bannerRow}>
            <span className={styles.bannerText}>
              Có bản cập nhật mới: v{status.latestVersion} (đang chạy v{status.currentVersion})
            </span>
            <button
              type="button"
              className={styles.bannerBtn}
              disabled={applying}
              onClick={() => void startApply()}
            >
              {applying ? 'Đang cập nhật…' : 'Cập nhật ngay'}
            </button>
          </div>
          {applying && status.progress ? (
            <>
              <span className={styles.progressLabel}>
                Bước {status.progress.step}/{status.progress.totalSteps} — {status.progress.label}
              </span>
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${Math.round((status.progress.step / status.progress.totalSteps) * 100)}%` }}
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
