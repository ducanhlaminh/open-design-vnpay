// Host-runtime self-update, UI-triggered (not silent). Polls GET
// /api/update/status in the background; when a newer host-runtime release
// exists it shows a small non-blocking banner with a button so the user
// decides when to update — no more firing POST /api/update/apply on its
// own the moment `updateAvailable` flips true (that used to happen here;
// the repo owner asked for an explicit action instead). `od self-update`
// (apps/daemon/src/cli.ts) is the CLI mirror of the same two endpoints.
// Once the daemon comes back up on the new version, the NEXT status poll
// reports `justUpdated` and this shows a one-time toast so the user knows
// it happened — that part is unchanged.
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
  const [justUpdatedVersion, setJustUpdatedVersion] = useState<string | null>(null);
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

    if (body.justUpdated) {
      setJustUpdatedVersion(body.justUpdated.version);
      setApplying(false);
      applyStartedAtRef.current = null;
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
      await fetch('/api/update/apply', { method: 'POST' });
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
      {justUpdatedVersion ? (
        <Toast
          message={`Đã cập nhật lên v${justUpdatedVersion}`}
          onDismiss={() => setJustUpdatedVersion(null)}
        />
      ) : null}
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
