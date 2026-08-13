// Agent-in-sandbox settings card (Settings → Execution, daemon mode).
// The web UI reads the daemon sandbox snapshot and renders the Claude and
// Codex runtimes independently. The daemon contract is mid-migration in the
// other worktree, so this file keeps a local shadow of the new shape and falls
// back to the legacy summary view when the runtime list is still absent.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DockerSetupResponse, SandboxBuildResponse, WindowsFirmwareStatusResponse } from '@open-design/contracts';
import { useT } from '../i18n';
import { ClaudeAccountSwitcher } from './ClaudeAccountSwitcher';
import { CodexDeviceLogin } from './CodexDeviceLogin';
import {
  isSandboxRuntimeReady,
  type SandboxRuntimeStatus,
  type SandboxStatusResponse,
} from './sandbox-runtime';
import styles from './SandboxSection.module.css';

export function SandboxSection({ daemonLive }: { daemonLive: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<SandboxStatusResponse | null>(null);
  const [build, setBuild] = useState<SandboxBuildResponse | null>(null);
  const [dockerSetup, setDockerSetup] = useState<DockerSetupResponse | null>(null);
  const [windowsSetup, setWindowsSetup] = useState<WindowsFirmwareStatusResponse | null>(null);
  const [modeSaving, setModeSaving] = useState(false);
  const isWindows = /Windows/i.test(navigator.userAgent);

  const refresh = useCallback(async () => {
    if (!daemonLive) return;
    try {
      const resp = await fetch('/api/sandbox/status?probeAuth=1');
      if (resp.ok) setStatus((await resp.json()) as SandboxStatusResponse);
    } catch {
      // Daemon unreachable — keep whatever we last showed.
    }
  }, [daemonLive]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // `status.mode` is undefined until the first status answer lands; fall
  // back to `enabled` (also present from the first answer on) so the toggle
  // never flashes the wrong side before settling.
  const executionMode = status?.mode ?? (status?.enabled ? 'sandbox' : 'host');
  const isHostMode = executionMode === 'host';

  // Writes `sandbox.enabled` through the same PUT /api/app-config prefs path
  // `od sandbox enable|disable` uses, so the CLI and this toggle never drift.
  const setExecutionMode = useCallback(
    async (enabled: boolean) => {
      if (!daemonLive || modeSaving) return;
      setModeSaving(true);
      try {
        const current = await fetch('/api/app-config')
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null) as { config?: { sandbox?: Record<string, unknown> } } | null;
        const sandbox = { ...(current?.config?.sandbox ?? {}), enabled };
        const resp = await fetch('/api/app-config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sandbox }),
        });
        if (resp.ok) await refresh();
      } catch {
        // Daemon unreachable — leave the toggle as-is for a retry.
      } finally {
        setModeSaving(false);
      }
    },
    [daemonLive, modeSaving, refresh],
  );

  useEffect(() => {
    if (!daemonLive || !isWindows || status?.dockerOk !== false) {
      setWindowsSetup(null);
      return;
    }
    let cancelled = false;
    let requestRunning = false;
    const refreshFirmware = async () => {
      if (requestRunning) return;
      requestRunning = true;
      try {
        const response = await fetch('/api/sandbox/windows/firmware', { cache: 'no-store' });
        if (response.ok) {
          const next = await response.json() as WindowsFirmwareStatusResponse;
          if (!cancelled) setWindowsSetup(next);
        }
      } catch {
        // The setup modal owns detailed firmware errors. Settings simply keeps
        // installation unavailable until a reliable answer arrives.
      } finally {
        requestRunning = false;
      }
    };
    void refreshFirmware();
    const id = window.setInterval(() => void refreshFirmware(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [daemonLive, isWindows, status?.dockerOk]);

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

  const startDockerSetup = useCallback(async () => {
    try {
      const response = await fetch('/api/sandbox/docker/setup', { method: 'POST' });
      const next = (await response.json().catch(() => null)) as DockerSetupResponse | null;
      if (next) setDockerSetup(next);
    } catch {
      setDockerSetup({
        phase: 'error', running: false, dockerOk: false,
        error: 'Không kết nối được dịch vụ cài đặt Docker.', log: [],
      });
    }
  }, []);

  useEffect(() => {
    if (!dockerSetup?.running) return;
    const id = window.setInterval(() => {
      void fetch('/api/sandbox/docker/setup')
        .then((response) => (response.ok ? response.json() as Promise<DockerSetupResponse> : null))
        .then((next) => {
          if (!next) return;
          setDockerSetup(next);
          if (!next.running || next.dockerOk) void refresh();
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(id);
  }, [dockerSetup?.running, refresh]);

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

  const okOrFix = (ok: boolean | undefined, fixCmd: string) =>
    ok ? (
      <span className={styles.ok}>{t('settings.sandboxOk')}</span>
    ) : (
      <span className={styles.missing}>
        {t('settings.sandboxMissing')} · {t('settings.sandboxRunCmd', { cmd: fixCmd })}
      </span>
    );

  const runtimeStatuses = status?.runtimeStatuses ?? [];
  const runtimeById = useMemo(
    () => new Map(runtimeStatuses.map((runtime) => [runtime.id, runtime] as const)),
    [runtimeStatuses],
  );
  const claudeRuntime = runtimeById.get('claude');
  const codexRuntime = runtimeById.get('codex');
  const hasRuntimeStatuses = runtimeStatuses.length > 0;
  const virtualizationBlocked = Boolean(
    isWindows && windowsSetup?.supportedPlatform && windowsSetup.detection?.virtualizationEnabled === false,
  );

  const renderRuntimeRow = (runtime: SandboxRuntimeStatus | undefined) => {
    if (!runtime) {
      return (
        <span className={styles.missing}>
          {t('settings.sandboxMissing')}
        </span>
      );
    }

    return (
        <div className={styles.runtimeSummary}>
          <ul className={styles.runtimeSpecs}>
            <li>
            <span>Version</span>
            <code>{runtime.version ?? '—'}</code>
          </li>
          <li>
            <span>Image</span>
            {runtime.imageAvailable ? (
              <span className={styles.ok}>{t('settings.sandboxOk')}</span>
            ) : (
              <span className={styles.missing}>{t('settings.sandboxMissing')}</span>
            )}
          </li>
          <li>
            <span>Auth volume</span>
            <code>{runtime.authVolume ?? '—'}</code>
            {runtime.authVolumeAvailable ? (
              <span className={styles.ok}>{t('settings.sandboxOk')}</span>
            ) : (
              <span className={styles.missing}>{t('settings.sandboxMissing')}</span>
            )}
          </li>
          <li>
            <span>Auth status</span>
            <code>{runtime.authStatus ?? '—'}</code>
          </li>
          <li>
            <span>Login method</span>
            <code>{runtime.loginMethod ?? '—'}</code>
          </li>
        </ul>
      </div>
    );
  };

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
          <div className={styles.modeRow} data-testid="sandbox-execution-mode">
            <div>
              <h4>{t('settings.executionModeTitle')}</h4>
              <p className="hint">{t('settings.executionModeHint')}</p>
            </div>
            <div className={styles.modeToggle} role="radiogroup" aria-label={t('settings.executionModeTitle')}>
              <button
                type="button"
                className={isHostMode ? styles.modeBtnActive : styles.modeBtn}
                role="radio"
                aria-checked={isHostMode}
                disabled={modeSaving}
                onClick={() => void setExecutionMode(false)}
              >
                {t('settings.executionModeHost')}
              </button>
              <button
                type="button"
                className={!isHostMode ? styles.modeBtnActive : styles.modeBtn}
                role="radio"
                aria-checked={!isHostMode}
                disabled={modeSaving}
                onClick={() => void setExecutionMode(true)}
              >
                {t('settings.executionModeSandbox')}
              </button>
            </div>
          </div>
          {!status.dockerOk ? (
            <div className={styles.setupPanel} data-testid="sandbox-docker-setup">
              <div>
                <strong>{virtualizationBlocked ? 'Cần bật virtualization trước' : 'Docker chưa sẵn sàng'}</strong>
                <p>{virtualizationBlocked
                  ? 'Mở lại màn hình hướng dẫn thiết lập, bật VT trong BIOS/UEFI rồi quay lại đây. Open Design sẽ tự kiểm tra lại.'
                  : 'Cài Docker Desktop để Open Design chạy Claude và Codex trong môi trường cách ly.'}</p>
              </div>
              <button
                type="button"
                className={styles.buildBtn}
                disabled={dockerSetup?.running || virtualizationBlocked || (isWindows && windowsSetup == null)}
                onClick={() => void startDockerSetup()}
              >
                {dockerSetup?.running ? 'Đang cài Docker…' : virtualizationBlocked ? 'Bật VT trước khi cài' : 'Cài Docker tự động'}
              </button>
              {dockerSetup?.log.length ? (
                <code className={styles.buildLog}>{dockerSetup.log[dockerSetup.log.length - 1]}</code>
              ) : null}
              {dockerSetup?.error ? <p className={styles.buildErr}>{dockerSetup.error}</p> : null}
            </div>
          ) : !status.imageOk ? (
            <div className={styles.setupPanel} data-testid="sandbox-image-setup">
              <div>
                <strong>Môi trường agent chưa có trên máy</strong>
                <p>Open Design sẽ tải image phù hợp với máy; nếu không tải được, hệ thống tự build tại máy.</p>
              </div>
              <button
                type="button"
                className={styles.buildBtn}
                disabled={build?.building}
                onClick={() => void startBuild()}
              >
                {build?.building ? 'Đang chuẩn bị…' : 'Chuẩn bị môi trường'}
              </button>
            </div>
          ) : null}
          {hasRuntimeStatuses ? (
        <div className={styles.runtimeGrid}>
          <details className={styles.runtimeCard} data-testid="sandbox-runtime-claude">
            <summary className={styles.runtimeToggle}>
              <span className={styles.runtimeToggleCopy}>
                <h4>{t('settings.sandboxClaudeTitle')}</h4>
                <span>{t('settings.sandboxClaudeHint')}</span>
              </span>
              <span className={isSandboxRuntimeReady(claudeRuntime) ? styles.runtimeReady : styles.runtimeMissing}>
                {isSandboxRuntimeReady(claudeRuntime)
                  ? t('settings.sandboxRuntimeReady')
                  : t('settings.sandboxRuntimeNotReady')}
              </span>
            </summary>
            <div className={styles.runtimeExpanded}>
              {renderRuntimeRow(claudeRuntime)}
              <div className={styles.runtimeBody}>
                <ClaudeAccountSwitcher daemonLive={daemonLive} hostMode={isHostMode} />
              </div>
            </div>
          </details>
          <details className={styles.runtimeCard} data-testid="sandbox-runtime-codex">
            <summary className={styles.runtimeToggle}>
              <span className={styles.runtimeToggleCopy}>
                <h4>{t('settings.sandboxCodexTitle')}</h4>
                <span>{t('settings.sandboxCodexHint')}</span>
              </span>
              <span className={isSandboxRuntimeReady(codexRuntime) ? styles.runtimeReady : styles.runtimeMissing}>
                {isSandboxRuntimeReady(codexRuntime)
                  ? t('settings.sandboxRuntimeReady')
                  : t('settings.sandboxRuntimeNotReady')}
              </span>
            </summary>
            <div className={styles.runtimeExpanded}>
              {renderRuntimeRow(codexRuntime)}
              <div className={styles.runtimeBody}>
                <CodexDeviceLogin
                  disabled={codexRuntime ? !codexRuntime.imageAvailable : false}
                  onAuthChanged={() => void refresh()}
                  onComplete={() => void refresh()}
                />
              </div>
            </div>
          </details>
        </div>
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

          <ClaudeAccountSwitcher daemonLive={daemonLive} hostMode={isHostMode} />
        </>
          )}
        </>
      )}
    </section>
  );
}
