// Silent host-runtime auto-update. Polls GET /api/update/status in the
// background; when a newer host-runtime release exists it fires
// POST /api/update/apply ONCE per session (useRef guard) and lets the
// daemon shell out to `deploy/host/install.sh --update` on its own — no
// confirmation dialog, per the repo owner's explicit tradeoff choice
// (silent auto-update over prompt-then-update). Once the daemon comes back
// up on the new version, the NEXT status poll reports `justUpdated` and
// this shows a one-time toast so the user knows it happened.
//
// Vietnamese-only copy on purpose — this fork's UI is Vietnamese and we
// avoid new i18n keys here (see InfraSetupGate.tsx / ClaudeAccountSwitcher).
import { useEffect, useRef, useState } from 'react';
import { Toast } from './Toast';

interface UpdateStatusResponse {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  justUpdated: { version: string; at: string } | null;
}

// Quiet background check, not something the user watches (unlike
// InfraSetupGate's aggressive 4s poll while its overlay is open) — 7
// minutes is a reasonable balance between "reasonably prompt" and not
// hammering the daemon (GET /api/update/status itself is cheap; the
// daemon-side GitHub call it fans out to is cached for an hour).
const POLL_INTERVAL_MS = 7 * 60 * 1000;

export function UpdateCheck() {
  const [justUpdatedVersion, setJustUpdatedVersion] = useState<string | null>(null);
  // Session-scoped guard: once we've decided to trigger an apply, never
  // trigger a second one from this tab, regardless of how many more polls
  // land before the daemon restarts (or even if the apply POST itself
  // fails to reach the daemon). The daemon's own `updateApplyInProgress`
  // lock covers races across multiple tabs/windows; this ref only needs
  // to stop THIS component from firing twice.
  const applyTriggeredRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const checkStatus = async () => {
      let status: UpdateStatusResponse;
      try {
        const res = await fetch('/api/update/status');
        if (!res.ok) return;
        status = (await res.json()) as UpdateStatusResponse;
      } catch {
        // Daemon unreachable — most likely mid-restart during its own
        // update (install.sh --update's ~60s health-check-with-rollback
        // window), or just a transient blip. Not a hard error: the next
        // scheduled poll retries.
        return;
      }
      if (cancelled) return;

      if (status.justUpdated) {
        setJustUpdatedVersion(status.justUpdated.version);
      }

      if (status.updateAvailable && !applyTriggeredRef.current) {
        applyTriggeredRef.current = true;
        try {
          await fetch('/api/update/apply', { method: 'POST' });
        } catch {
          // Fire-and-forget — see applyTriggeredRef comment above.
        }
      }
    };

    void checkStatus();
    const id = window.setInterval(() => {
      void checkStatus();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!justUpdatedVersion) return null;

  return (
    <Toast
      message={`Đã cập nhật lên v${justUpdatedVersion}`}
      onDismiss={() => setJustUpdatedVersion(null)}
    />
  );
}
