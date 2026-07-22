// Agent-in-sandbox settings card (Settings → Execution, daemon mode).
// Read-side of `GET /api/sandbox/status`; the enable toggle persists through
// the shared `PUT /api/app-config` `sandbox` section (same route the `od
// sandbox enable|disable` CLI uses). Build/login are terminal-interactive
// docker operations, so the card only surfaces the commands to run.
import { useCallback, useEffect, useState } from 'react';
import type { SandboxStatusResponse, SandboxBuildResponse } from '@open-design/contracts';
import { useT } from '../i18n';
import { ClaudeAccountSwitcher } from './ClaudeAccountSwitcher';
import styles from './SandboxSection.module.css';

export function SandboxSection({ daemonLive }: { daemonLive: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<SandboxStatusResponse | null>(null);
  const [build, setBuild] = useState<SandboxBuildResponse | null>(null);

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

  // Resume a build that might already be running (e.g. Settings reopened while
  // the image is still building) so the panel shows live progress on open.
  useEffect(() => {
    if (!daemonLive) return;
    void fetch('/api/sandbox/build')
      .then((r) => (r.ok ? (r.json() as Promise<SandboxBuildResponse>) : null))
      .then((j) => { if (j) setBuild(j); })
      .catch(() => {});
  }, [daemonLive]);

  // Kick off an in-daemon `docker build` of the missing image. Returns at once
  // (build takes minutes); the poll effect below tracks it to completion.
  const startBuild = useCallback(async () => {
    try {
      const r = await fetch('/api/sandbox/build', { method: 'POST' });
      const j = (await r.json().catch(() => null)) as SandboxBuildResponse | null;
      if (j) setBuild(j);
    } catch {
      // Daemon unreachable — leave the button as-is for a retry.
    }
  }, []);

  // While a build runs, poll progress; when it finishes, refresh the status list
  // so the image row flips to OK and the Build button disappears.
  useEffect(() => {
    if (!build?.building) return;
    const id = window.setInterval(() => {
      void fetch('/api/sandbox/build')
        .then((r) => (r.ok ? (r.json() as Promise<SandboxBuildResponse>) : null))
        .then((j) => {
          if (!j) return;
          setBuild(j);
          if (!j.building) void refresh();
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(id);
  }, [build?.building, refresh]);

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
          <p className="hint" style={{ margin: '0 0 4px' }}>
            Mặc định chạy qua Docker sandbox · runtime: <code>{status.runtimes.join(', ')}</code> · skills:{' '}
            <code>{status.skills.join(', ')}</code>
          </p>
          <ul className={styles.statusList}>
            <li>
              <span>{t('settings.sandboxDocker')}</span>
              {okOrFix(status.dockerOk, 'open -a OrbStack')}
            </li>
            <li>
              <span>
                {t('settings.sandboxImage')} <code>{status.image}</code>
              </span>
              {/* Missing image + Docker up → build it right here (no terminal
                  needed on a fresh machine). Docker down → can't build yet. */}
              {status.imageOk ? (
                <span className={styles.ok}>{t('settings.sandboxOk')}</span>
              ) : status.dockerOk ? (
                <button
                  type="button"
                  className={styles.buildBtn}
                  disabled={build?.building}
                  onClick={() => void startBuild()}
                >
                  {build?.building ? 'Đang build…' : 'Build image'}
                </button>
              ) : (
                <span className={styles.missing}>{t('settings.sandboxMissing')} · cần Docker</span>
              )}
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

          {/* Live build progress: last log line while running, or the failure. */}
          {build?.building ? (
            <div className={styles.buildPanel}>
              <p className={styles.buildHint}>Đang build image trong Docker (lần đầu mất vài phút)…</p>
              {build.log.length ? (
                <code className={styles.buildLog}>{build.log[build.log.length - 1]}</code>
              ) : null}
            </div>
          ) : build && build.ok === false ? (
            <div className={styles.buildPanel}>
              <p className={styles.buildErr}>Build thất bại: {build.error ?? 'lỗi không rõ'}</p>
              {build.log.length ? (
                <code className={styles.buildLog}>{build.log.slice(-4).join('\n')}</code>
              ) : null}
            </div>
          ) : null}

          <ClaudeAccountSwitcher daemonLive={daemonLive} />
        </>
      )}
    </section>
  );
}
