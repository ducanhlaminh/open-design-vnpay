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
import { useHostCodexDeviceLogin } from '../hooks/useHostCodexDeviceLogin';
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

  // Host Claude CLI logout — clears the machine-level `claude /login` session
  // through the daemon (credentials file + macOS Keychain), then re-reads the
  // status snapshot so the card flips to "Cần đăng nhập".
  const [hostClaudeBusy, setHostClaudeBusy] = useState(false);
  const [hostClaudeError, setHostClaudeError] = useState<string | null>(null);
  const logoutHostClaudeCli = useCallback(async () => {
    if (hostClaudeBusy) return;
    if (!window.confirm('Đăng xuất Claude khỏi máy này? Bạn sẽ cần đăng nhập lại để tiếp tục dùng.')) return;
    setHostClaudeBusy(true);
    setHostClaudeError(null);
    try {
      const r = await fetch('/api/sandbox/host/claude/logout', { method: 'POST' });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        setHostClaudeError(j?.error?.message ?? `Không đăng xuất được (lỗi ${r.status}).`);
        return;
      }
      await refresh();
    } catch {
      setHostClaudeError('Không kết nối được — thử lại.');
    } finally {
      setHostClaudeBusy(false);
    }
  }, [hostClaudeBusy, refresh]);

  // Host Codex CLI logout — `codex logout` on the machine through the daemon,
  // then re-read the status snapshot so the card flips to "Cần đăng nhập".
  const [hostCodexBusy, setHostCodexBusy] = useState(false);
  const [hostCodexError, setHostCodexError] = useState<string | null>(null);
  const logoutHostCodexCli = useCallback(async () => {
    if (hostCodexBusy) return;
    if (!window.confirm('Đăng xuất Codex khỏi máy này? Bạn sẽ cần đăng nhập lại để tiếp tục dùng Codex.')) return;
    setHostCodexBusy(true);
    setHostCodexError(null);
    try {
      const response = await fetch('/api/sandbox/host/codex/logout', { method: 'POST' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setHostCodexError(body?.error?.message ?? `Không đăng xuất được Codex (lỗi ${response.status}).`);
        return;
      }
      await refresh();
    } catch {
      setHostCodexError('Không kết nối được — thử lại.');
    } finally {
      setHostCodexBusy(false);
    }
  }, [hostCodexBusy, refresh]);

  // Host Codex device-code login (daemon runs `codex login --device-auth` on
  // the machine; the card shows the URL + one-time code and polls until the
  // login lands). `onDone` re-reads the status snapshot so the card flips to
  // "Sẵn sàng" + account email without a manual re-check.
  const hostCodexLogin = useHostCodexDeviceLogin({ onDone: refresh });

  useEffect(() => {
    if (!daemonLive || !isWindows || isHostMode || status?.dockerOk !== false) {
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
  }, [daemonLive, isWindows, isHostMode, status?.dockerOk]);

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

  // Host-mode Claude state, from the cheap host probe (`status.hostClaude`) —
  // NOT from the Docker-volume runtimeStatuses, which describe an environment
  // designers never touch while the sandbox lock is on.
  const hostClaudeState = !status?.hostClaude?.available
    ? 'not-installed'
    : status.hostClaude.authStatus === 'ok'
      ? 'ready'
      : status.hostClaude.authStatus === 'missing'
        ? 'needs-login'
        : 'unknown';
  // Same for Codex (`status.hostCodex`, the Codex twin of the host probe).
  const hostCodexState = !status?.hostCodex
    ? 'unknown'
    : !status.hostCodex.available
      ? 'not-installed'
      : status.hostCodex.authStatus === 'ok'
        ? 'ready'
        : status.hostCodex.authStatus === 'missing'
          ? 'needs-login'
          : 'unknown';
  const hostCodexLoginLive =
    hostCodexLogin.session.phase === 'starting' ||
    hostCodexLogin.session.phase === 'awaiting-user' ||
    hostCodexLogin.session.phase === 'verifying';

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
              {/* TEMPORARY HOST LOCK — mirrors resolveSandboxConfig in
                  apps/daemon/src/agent-sandbox.ts; remove together. */}
              <p className="hint">Docker sandbox đang tạm khóa — mọi run chạy bằng Host CLI.</p>
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
                disabled
                title="Docker sandbox đang tạm khóa — mọi run chạy bằng Host CLI"
              >
                {t('settings.executionModeSandbox')}
              </button>
            </div>
          </div>
          {/* Docker prep panels are sandbox-mode-only — while the host lock is
              on, pushing designers to install Docker is pure noise. */}
          {!isHostMode && !status.dockerOk ? (
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
          ) : !isHostMode && !status.imageOk ? (
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
          {isHostMode ? (
            /* Host mode (the locked default): plain-language cards for
               non-technical designers — no version/image/volume jargon. The
               Docker cards below stay for the OD_SANDBOX=1 dev fallback. */
            <div className={styles.runtimeGrid} data-testid="host-runtime-cards">
              <div className={styles.hostCard} data-testid="host-runtime-claude">
                <div className={styles.hostCardHead}>
                  <div className={styles.hostCardCopy}>
                    <h4>Claude</h4>
                    <span>Trợ lý AI chính — dùng cho các bước thiết kế.</span>
                  </div>
                  {hostClaudeState === 'ready' ? (
                    <span className={styles.chipReady}>Sẵn sàng</span>
                  ) : hostClaudeState === 'needs-login' ? (
                    <span className={styles.chipWarn}>Cần đăng nhập</span>
                  ) : hostClaudeState === 'not-installed' ? (
                    <span className={styles.chipWarn}>Chưa cài</span>
                  ) : (
                    <span className={styles.chipMuted}>Đang kiểm tra…</span>
                  )}
                </div>
                <p className={styles.hostCardText}>
                  {hostClaudeState === 'ready'
                    ? status.hostClaude?.account?.email
                      ? `Đã đăng nhập với tài khoản ${status.hostClaude.account.email} — bạn có thể dùng ngay.`
                      : 'Đã đăng nhập trên máy này — bạn có thể dùng ngay, không cần cài thêm gì.'
                    : hostClaudeState === 'needs-login'
                      ? status.hostClaude?.authMessage ??
                        'Chưa đăng nhập Claude trên máy này. Nhờ đội kỹ thuật đăng nhập giúp bạn.'
                      : hostClaudeState === 'not-installed'
                        ? 'Máy này chưa cài Claude. Nhờ đội kỹ thuật cài đặt giúp bạn.'
                        : 'Chưa kiểm tra được trạng thái — thử tải lại trang.'}
                </p>
                <div className={styles.hostCardActions}>
                  {hostClaudeState === 'ready' ? (
                    <button
                      type="button"
                      className={styles.hostGhostBtn}
                      disabled={hostClaudeBusy}
                      onClick={() => void logoutHostClaudeCli()}
                    >
                      {hostClaudeBusy ? 'Đang đăng xuất…' : 'Đăng xuất'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.hostGhostBtn}
                      disabled={hostClaudeBusy}
                      onClick={() => void refresh()}
                    >
                      Kiểm tra lại
                    </button>
                  )}
                </div>
                {hostClaudeError ? <p className={styles.hostCardErr}>{hostClaudeError}</p> : null}
                {status.hostClaude?.version ? (
                  <details className={styles.techDetails}>
                    <summary>Chi tiết kỹ thuật</summary>
                    <p>Phiên bản Claude CLI: {status.hostClaude.version}</p>
                  </details>
                ) : null}
              </div>
              <div className={styles.hostCard} data-testid="host-runtime-codex">
                <div className={styles.hostCardHead}>
                  <div className={styles.hostCardCopy}>
                    <h4>Codex</h4>
                    <span>Trợ lý AI thay thế — không bắt buộc.</span>
                  </div>
                  {hostCodexState === 'ready' ? (
                    <span className={styles.chipReady}>Sẵn sàng</span>
                  ) : hostCodexState === 'needs-login' ? (
                    <span className={styles.chipWarn}>Cần đăng nhập</span>
                  ) : hostCodexState === 'not-installed' ? (
                    <span className={styles.chipMuted}>Chưa cài</span>
                  ) : (
                    <span className={styles.chipMuted}>Đang kiểm tra…</span>
                  )}
                </div>
                <p className={styles.hostCardText}>
                  {hostCodexState === 'ready'
                    ? status.hostCodex?.account?.email
                      ? `Đã đăng nhập với tài khoản ${status.hostCodex.account.email} — bạn có thể chọn Codex khi chạy.`
                      : 'Đã đăng nhập trên máy này — bạn có thể chọn Codex khi chạy.'
                    : hostCodexState === 'needs-login'
                      ? 'Chưa đăng nhập Codex trên máy này. Bấm "Đăng nhập", mở đường dẫn hiện ra và nhập mã — không cần Terminal.'
                      : hostCodexState === 'not-installed'
                        ? 'Chỉ cần khi bạn muốn dùng Codex thay cho Claude. Máy này chưa cài Codex — nhờ đội kỹ thuật cài giúp bạn.'
                        : 'Đang kiểm tra Codex trên máy…'}
                </p>
                {hostCodexLoginLive || hostCodexLogin.session.phase === 'error' ? (
                  <div className={styles.deviceLogin} data-testid="host-codex-device-login">
                    {hostCodexLogin.session.phase === 'starting' ? (
                      <p className={styles.hostCardText}>Đang tạo mã đăng nhập…</p>
                    ) : null}
                    {hostCodexLogin.session.phase === 'awaiting-user' ? (
                      <>
                        <p className={styles.hostCardText}>
                          1. Mở{' '}
                          {hostCodexLogin.session.url ? (
                            <a href={hostCodexLogin.session.url} target="_blank" rel="noreferrer">
                              {hostCodexLogin.session.url}
                            </a>
                          ) : (
                            'đường dẫn đăng nhập'
                          )}{' '}
                          và đăng nhập tài khoản ChatGPT.
                        </p>
                        <p className={styles.hostCardText}>
                          2. Nhập mã:{' '}
                          <code className={styles.deviceCode} data-testid="host-codex-device-code">
                            {hostCodexLogin.session.code ?? '—'}
                          </code>
                          {hostCodexLogin.session.code ? (
                            <button
                              type="button"
                              className={styles.hostGhostBtn}
                              onClick={() => void hostCodexLogin.copyCode()}
                            >
                              {hostCodexLogin.copied ? 'Đã chép' : 'Chép mã'}
                            </button>
                          ) : null}
                        </p>
                        <p className={styles.hostCardText}>Đang chờ bạn xác nhận trên trình duyệt…</p>
                      </>
                    ) : null}
                    {hostCodexLogin.session.phase === 'verifying' ? (
                      <p className={styles.hostCardText}>Đang xác minh đăng nhập…</p>
                    ) : null}
                    {hostCodexLogin.session.phase === 'error' && hostCodexLogin.session.error ? (
                      <p className={styles.hostCardErr}>{hostCodexLogin.session.error}</p>
                    ) : null}
                  </div>
                ) : null}
                <div className={styles.hostCardActions}>
                  {hostCodexLoginLive ? (
                    <button
                      type="button"
                      className={styles.hostGhostBtn}
                      disabled={hostCodexLogin.busy}
                      onClick={() => void hostCodexLogin.cancel()}
                    >
                      Hủy
                    </button>
                  ) : hostCodexState === 'ready' ? (
                    <button
                      type="button"
                      className={styles.hostGhostBtn}
                      disabled={hostCodexBusy}
                      onClick={() => void logoutHostCodexCli()}
                    >
                      {hostCodexBusy ? 'Đang đăng xuất…' : 'Đăng xuất'}
                    </button>
                  ) : hostCodexState === 'needs-login' ? (
                    <>
                      <button
                        type="button"
                        className={styles.hostPrimaryBtn}
                        disabled={hostCodexLogin.busy}
                        onClick={() => void hostCodexLogin.start()}
                      >
                        {hostCodexLogin.session.phase === 'error' ? 'Thử lại' : 'Đăng nhập'}
                      </button>
                      <button type="button" className={styles.hostGhostBtn} onClick={() => void refresh()}>
                        Kiểm tra lại
                      </button>
                    </>
                  ) : (
                    <button type="button" className={styles.hostGhostBtn} onClick={() => void refresh()}>
                      Kiểm tra lại
                    </button>
                  )}
                </div>
                {hostCodexError ? <p className={styles.hostCardErr}>{hostCodexError}</p> : null}
                {hostCodexLogin.requestError ? <p className={styles.hostCardErr}>{hostCodexLogin.requestError}</p> : null}
              </div>
            </div>
          ) : hasRuntimeStatuses ? (
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
                  alreadyLoggedIn={codexRuntime?.authStatus === 'logged-in'}
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
