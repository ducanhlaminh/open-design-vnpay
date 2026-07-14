// Agent-in-sandbox settings card (Settings → Execution, daemon mode).
// Read-side of `GET /api/sandbox/status`; the enable toggle persists through
// the shared `PUT /api/app-config` `sandbox` section (same route the `od
// sandbox enable|disable` CLI uses). Build/login are terminal-interactive
// docker operations, so the card only surfaces the commands to run.
import { useCallback, useEffect, useState } from 'react';
import type { SandboxStatusResponse } from '@open-design/contracts';
import { useT } from '../i18n';
import styles from './SandboxSection.module.css';

export function SandboxSection({ daemonLive }: { daemonLive: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<SandboxStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!daemonLive) return;
    try {
      const resp = await fetch('/api/sandbox/status');
      if (resp.ok) setStatus((await resp.json()) as SandboxStatusResponse);
    } catch {
      // Daemon unreachable — keep whatever we last showed.
    }
  }, [daemonLive]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(async () => {
    if (!status || busy) return;
    setBusy(true);
    try {
      // Merge onto the persisted prefs (not the resolved status) so custom
      // runtimes/skills/timeout survive the toggle — mirrors the CLI path.
      const current = await fetch('/api/app-config')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const sandbox = {
        ...(current?.config?.sandbox ?? {}),
        enabled: !status.enabled,
      };
      await fetch('/api/app-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandbox }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [status, busy, refresh]);

  const okOrFix = (ok: boolean, fixCmd: string) =>
    ok ? (
      <span className={styles.ok}>{t('settings.sandboxOk')}</span>
    ) : (
      <span className={styles.missing}>
        {t('settings.sandboxMissing')} · {t('settings.sandboxRunCmd', { cmd: fixCmd })}
      </span>
    );

  return (
    <section className="settings-section" data-testid="settings-sandbox">
      <div className="section-head">
        <div>
          <h3>{t('settings.sandboxTitle')}</h3>
          <p className="hint">{t('settings.sandboxHint')}</p>
        </div>
      </div>
      {!daemonLive || !status ? (
        <small className="hint">{t('settings.sandboxDaemonOffline')}</small>
      ) : (
        <>
          <label className="field">
            <span className="field-label">
              <input
                type="checkbox"
                checked={status.enabled}
                disabled={busy}
                onChange={() => void toggle()}
              />{' '}
              {t('settings.sandboxEnabled', {
                runtimes: status.runtimes.join(', '),
                skills: status.skills.join(', '),
              })}
            </span>
          </label>
          <ul className={styles.statusList}>
            <li>
              <span>{t('settings.sandboxDocker')}</span>
              {okOrFix(status.dockerOk, 'open -a OrbStack')}
            </li>
            <li>
              <span>
                {t('settings.sandboxImage')} <code>{status.image}</code>
              </span>
              {okOrFix(status.imageOk, 'od sandbox build')}
            </li>
            <li>
              <span>{t('settings.sandboxAuth')}</span>
              {okOrFix(status.authVolumeOk, 'od sandbox login')}
            </li>
            {status.activeContainers.length > 0 ? (
              <li>
                <span>{t('settings.sandboxActiveRuns')}</span>
                <span>{status.activeContainers.join(', ')}</span>
              </li>
            ) : null}
          </ul>
        </>
      )}
    </section>
  );
}
