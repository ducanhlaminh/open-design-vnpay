// First-run infra setup gate. Two independent flows, branching on the daemon's
// effective sandbox mode (`GET /api/sandbox/status`.mode):
//
//   - HOST mode (default since the web-first migration, WP4): every run
//     spawns as a host CLI process, so the ONLY things worth gating on are
//     "is the Claude CLI on this machine" and "is it logged in" — read from
//     `GET /api/agents` (the same source the agent picker uses), not the
//     Docker/image/auth-volume wizard below.
//   - SANDBOX mode (opted in via prefs or OD_SANDBOX=1): unchanged legacy
//     wizard — Docker engine → sandbox image → Claude/Codex login. Read-side
//     of `GET /api/sandbox/status` + `GET /api/sandbox/accounts`; actions
//     reuse the existing build/login endpoints, so `od sandbox
//     status|build|login` stays the CLI mirror.
//
// The gate self-dismisses silently when every check already passes, and
// "Để sau" skips it for the current app session — Settings → Execution keeps
// the same controls for later. Completion is deliberately not persisted:
// a host CLI can be uninstalled, or Docker/images/auth volumes removed,
// independently from the app.
// Vietnamese-only copy on purpose — this fork's UI is
// Vietnamese and we avoid new i18n keys here (see ClaudeAccountSwitcher).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type {
  AgentInfo,
  SandboxAccountsResponse,
  SandboxBuildResponse,
  DockerSetupResponse,
  WindowsFirmwareStatusResponse,
} from '@open-design/contracts';
import { EmbeddedClaudeLogin } from './EmbeddedClaudeLogin';
import { CodexDeviceLogin } from './CodexDeviceLogin';
import {
  getStoredSandboxRuntime,
  isSandboxRuntimeReady,
  sandboxRuntimeDisplayName,
  type SandboxStatusResponse as SandboxUiStatusResponse,
} from './sandbox-runtime';
import styles from './InfraSetupGate.module.css';

const CLAUDE_INSTALL_URL = 'https://claude.ai/install.sh';
const CLAUDE_INSTALL_COMMAND = `curl -fsSL ${CLAUDE_INSTALL_URL} | bash`;

function clearPersistedDismissal(): void {
  try {
    // Migrate the old permanent flag. Readiness is now derived from the live
    // daemon status on every launch instead of a stale browser-side bit.
    window.localStorage.removeItem('od-infra-setup-done');
  } catch {
    // Storage unavailable — component state still reopens the gate.
  }
}

interface Props {
  daemonLive: boolean;
  /** Opens Settings → Execution, where the sandbox card + account switcher live. */
  onOpenSettings: () => void;
}

export function InfraSetupGate({ daemonLive, onOpenSettings }: Props): JSX.Element | null {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  const [skippedThisSession, setSkippedThisSession] = useState(false);
  const [status, setStatus] = useState<SandboxUiStatusResponse | null>(null);
  const [hostAgents, setHostAgents] = useState<AgentInfo[] | null>(null);
  const [accounts, setAccounts] = useState<SandboxAccountsResponse | null>(null);
  const [build, setBuild] = useState<SandboxBuildResponse | null>(null);
  const [dockerSetup, setDockerSetup] = useState<DockerSetupResponse | null>(null);
  const [windowsSetup, setWindowsSetup] = useState<WindowsFirmwareStatusResponse | null>(null);
  const [windowsSetupError, setWindowsSetupError] = useState<string | null>(null);
  const [guidanceSaved, setGuidanceSaved] = useState(false);
  const [restartingFirmware, setRestartingFirmware] = useState(false);
  const autoBuildStarted = useRef(false);
  const [selectedRuntime] = useState(() => getStoredSandboxRuntime());
  // True once the FIRST full evaluation decided the gate must show. Before
  // that we render nothing, so fully-provisioned machines never see a flash.
  const [evaluated, setEvaluated] = useState(false);

  // Even a previously completed setup must be probed on every launch. Docker,
  // its image, or its auth volumes can be removed independently from the app;
  // treating the localStorage flag as permanent hid onboarding forever on
  // those machines. "Để sau" remains a session-only escape hatch.
  const active = daemonLive && !skippedThisSession;
  const runtimeStatuses = status?.runtimeStatuses ?? [];
  const runtimeById = new Map(runtimeStatuses.map((runtime) => [runtime.id, runtime] as const));
  const selectedRuntimeStatus = runtimeById.get(selectedRuntime);
  const usingRuntimeStatuses = runtimeStatuses.length > 0;
  const isWindows = /Windows/i.test(navigator.userAgent);
  // `status.mode` is undefined only for a not-yet-refreshed daemon; treat that
  // as "unknown, not host" so the legacy sandbox render path (guarded by
  // `!status` at the bottom) stays the fallback until the first answer lands.
  const hostMode = status?.mode === 'host';

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/sandbox/status?probeAuth=1');
      if (r.ok) setStatus((await r.json()) as SandboxUiStatusResponse);
    } catch {
      // Daemon unreachable — keep the last snapshot.
    }
  }, []);

  // ── Host mode: the ONLY infra that matters is the host Claude CLI, read
  // from /api/agents (same source as the agent picker) — never Docker.
  const refreshHostAgents = useCallback(async () => {
    try {
      const r = await fetch('/api/agents');
      if (r.ok) {
        const body = (await r.json()) as { agents: AgentInfo[] };
        setHostAgents(body.agents);
      }
    } catch {
      // Daemon unreachable — keep the last snapshot.
    }
  }, []);

  useEffect(() => {
    if (!active || !hostMode) return;
    void refreshHostAgents();
    const id = window.setInterval(() => void refreshHostAgents(), 4000);
    return () => window.clearInterval(id);
  }, [active, hostMode, refreshHostAgents]);

  const hostClaude = hostAgents?.find((a) => a.id === 'claude') ?? null;
  const hostClaudeLoggedIn = hostClaude?.authStatus === 'ok';
  const hostClaudeReady = Boolean(hostClaude?.available && hostClaudeLoggedIn);

  // Codex is an equally valid host CLI (Piece 1: `probeAgentAuthStatus` now
  // knows how to read its login state too) — a machine with Codex but no
  // Claude must not be stuck behind this gate forever.
  const hostCodex = hostAgents?.find((a) => a.id === 'codex') ?? null;
  const hostCodexLoggedIn = hostCodex?.authStatus === 'ok';
  const hostCodexReady = Boolean(hostCodex?.available && hostCodexLoggedIn);

  // ── Cheap infra poll (docker version / image inspect / volume inspect).
  // 4s while the gate is relevant, so finishing a step flips it green live.
  useEffect(() => {
    // Do not invoke Docker CLI while the signed macOS app is being installed.
    // Calling CLI symlinks during the bundle copy can leave Docker.app partial.
    if (!active || dockerSetup?.running) return;
    void refreshStatus();
    const id = window.setInterval(() => void refreshStatus(), 4000);
    return () => window.clearInterval(id);
  }, [active, dockerSetup?.running, refreshStatus]);

  useEffect(() => {
    if (!active || !isWindows || status?.dockerOk !== false) return;
    let cancelled = false;
    let requestRunning = false;
    const refreshWindowsSetup = async () => {
      if (requestRunning) return;
      requestRunning = true;
      try {
        const r = await fetch('/api/sandbox/windows/firmware', { cache: 'no-store' });
        if (!r.ok) throw new Error('Không thể kiểm tra cấu hình virtualization của Windows.');
        const result = await r.json() as WindowsFirmwareStatusResponse;
        if (!cancelled) {
          setWindowsSetup(result);
          setWindowsSetupError(null);
        }
      } catch (error: unknown) {
        if (!cancelled) setWindowsSetupError(error instanceof Error ? error.message : 'Không thể kiểm tra cấu hình Windows.');
      } finally {
        requestRunning = false;
      }
    };
    // Keep probing while Docker is unavailable. Firmware/CIM state can settle
    // a few seconds after Windows resumes from the BIOS restart; a one-shot
    // read left the old "VT disabled" alert mounted for the whole app session.
    void refreshWindowsSetup();
    const id = window.setInterval(() => void refreshWindowsSetup(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, isWindows, status?.dockerOk]);

  const restartToFirmware = useCallback(async () => {
    if (!guidanceSaved) return;
    setRestartingFirmware(true);
    setWindowsSetupError(null);
    try {
      const r = await fetch('/api/sandbox/windows/firmware/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null) as { error?: string | { message?: string } } | null;
        const message = typeof body?.error === 'string' ? body.error : body?.error?.message;
        throw new Error(message ?? 'Không thể khởi động vào BIOS/UEFI.');
      }
    } catch (error) {
      setWindowsSetupError(error instanceof Error ? error.message : 'Không thể khởi động vào BIOS/UEFI.');
      setRestartingFirmware(false);
    }
  }, [guidanceSaved]);

  // ── Login-state fetch. Each call spins a short-lived container, so it runs
  // only when it can answer (docker + image up) and only polls while a login
  // the user launched is still pending — not on a permanent interval.
  const ready = Boolean(status?.dockerOk && status?.imageOk);
  const loggedIn = accounts?.loggedIn === true;
  const refreshAccounts = useCallback(async () => {
    try {
      const r = await fetch('/api/sandbox/accounts');
      if (r.ok) setAccounts((await r.json()) as SandboxAccountsResponse);
    } catch {
      // Daemon unreachable — keep the last snapshot.
    }
  }, []);

  useEffect(() => {
    if (!active || usingRuntimeStatuses || !ready) return;
    void refreshAccounts();
  }, [active, ready, usingRuntimeStatuses, status?.authVolumeOk, refreshAccounts]);

  // ── Build progress: resume a possibly-running build on mount, poll while
  // running, refresh the status list when it lands (same flow as Settings).
  useEffect(() => {
    if (!active) return;
    void fetch('/api/sandbox/build')
      .then((r) => (r.ok ? (r.json() as Promise<SandboxBuildResponse>) : null))
      .then((j) => {
        if (j) setBuild(j);
      })
      .catch(() => {});
  }, [active]);

  useEffect(() => {
    if (!active || !build?.building) return;
    const id = window.setInterval(() => {
      void fetch('/api/sandbox/build')
        .then((r) => (r.ok ? (r.json() as Promise<SandboxBuildResponse>) : null))
        .then((j) => {
          if (j) setBuild(j);
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(id);
  }, [active, build?.building]);

  const startBuild = useCallback(async () => {
    try {
      const r = await fetch('/api/sandbox/build', { method: 'POST' });
      const j = (await r.json().catch(() => null)) as SandboxBuildResponse | null;
      if (j) setBuild(j);
    } catch {
      // Daemon unreachable — leave the button for a retry.
    }
  }, []);

  const startDockerSetup = useCallback(async () => {
    try {
      const r = await fetch('/api/sandbox/docker/setup', { method: 'POST' });
      const j = (await r.json().catch(() => null)) as DockerSetupResponse | null;
      if (j) setDockerSetup(j);
    } catch {
      setDockerSetup({
        phase: 'error', running: false, dockerOk: false,
        error: 'Không kết nối được dịch vụ cài đặt.', log: [],
      });
    }
  }, []);

  useEffect(() => {
    if (!active || !dockerSetup?.running) return;
    const id = window.setInterval(() => {
      void fetch('/api/sandbox/docker/setup')
        .then((r) => (r.ok ? (r.json() as Promise<DockerSetupResponse>) : null))
        .then((j) => {
          if (!j) return;
          setDockerSetup(j);
          if (j.dockerOk) void refreshStatus();
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(id);
  }, [active, dockerSetup?.running, refreshStatus]);

  useEffect(() => {
    if (!dockerSetup?.dockerOk || status?.imageOk || build?.building || autoBuildStarted.current) return;
    autoBuildStarted.current = true;
    void startBuild();
  }, [dockerSetup?.dockerOk, status?.imageOk, build?.building, startBuild]);

  // Manual "Kiểm tra lại": one immediate re-probe of everything the gate
  // shows, for users who don't want to wait out the 4s poll (or whose login
  // just finished in the terminal). Accounts re-probe only when it can answer.
  const [rechecking, setRechecking] = useState(false);
  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      await Promise.all([
        refreshStatus(),
        hostMode ? refreshHostAgents() : ready ? refreshAccounts() : Promise.resolve(),
      ]);
    } finally {
      setRechecking(false);
    }
  }, [refreshStatus, refreshHostAgents, refreshAccounts, ready, hostMode]);

  // Auth step is N/A when the sandbox doesn't own Claude (host CLI handles
  // login there); until /accounts answers, assume it applies.
  const authNA = accounts != null && !accounts.supported;
  const legacyAllOk = Boolean(status?.dockerOk && status?.imageOk && (authNA || loggedIn));
  const selectedRuntimeReady = usingRuntimeStatuses
    ? isSandboxRuntimeReady(selectedRuntimeStatus)
    : legacyAllOk;

  // ── First-evaluation gate: decide once whether to show at all. A machine
  // that's already fully set up (or has the sandbox disabled) self-dismisses
  // without ever rendering; an incomplete one locks `evaluated` so the wizard
  // stays up until the user finishes or skips.
  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  const skip = useCallback(() => {
    setSkippedThisSession(true);
  }, []);

  useEffect(() => {
    clearPersistedDismissal();
  }, []);

  useEffect(() => {
    if (!active || evaluated || !status) return;
    // Host mode (the WP4 default): gate on the host Claude CLI snapshot from
    // /api/agents instead of the Docker/image/auth-volume checks below —
    // those never apply when the sandbox is off. Wait for the first agents
    // answer so a fully-set-up machine never flashes the wizard open.
    if (hostMode) {
      if (hostAgents == null) return;
      if (hostClaudeReady || hostCodexReady) {
        dismiss();
        return;
      }
      if (dismissed) {
        clearPersistedDismissal();
        setDismissed(false);
      }
      setEvaluated(true);
      return;
    }
    if (!status.enabled) {
      dismiss();
      return;
    }
    if (usingRuntimeStatuses) {
      if (!selectedRuntimeStatus || !selectedRuntimeReady) {
        if (dismissed) {
          clearPersistedDismissal();
          setDismissed(false);
        }
        setEvaluated(true);
        return;
      }
      dismiss();
      return;
    }
    if (!status.dockerOk || !status.imageOk) {
      if (dismissed) {
        clearPersistedDismissal();
        setDismissed(false);
      }
      setEvaluated(true);
      return;
    }
    // Shallow checks pass — the verdict needs the accounts answer.
    if (!accounts) return;
    if (!accounts.supported || accounts.loggedIn) {
      dismiss();
      return;
    }
    if (dismissed) {
      clearPersistedDismissal();
      setDismissed(false);
    }
    setEvaluated(true);
  }, [
    active,
    evaluated,
    status,
    hostMode,
    hostAgents,
    hostClaudeReady,
    hostCodexReady,
    accounts,
    dismissed,
    dismiss,
    usingRuntimeStatuses,
    selectedRuntimeStatus,
    selectedRuntimeReady,
  ]);

  if (!active || dismissed || !evaluated || !status) return null;
  const allOk = selectedRuntimeReady;

  // ── Host mode (WP4 default): a 2-step gate per agent — CLI installed, CLI
  // logged in — instead of the Docker/image/auth-volume wizard below. Never
  // touches /api/sandbox/* beyond the initial status probe that decided the
  // mode. Claude and Codex are rendered as two parallel cards; either one
  // being fully ready is enough to proceed.
  if (hostMode) {
    const claudeAvailable = Boolean(hostClaude?.available);
    const claudeSteps: Array<{ key: string; title: string; ok: boolean; body: JSX.Element | null }> = [
      {
        key: 'host-claude-cli',
        title: 'Claude CLI',
        ok: claudeAvailable,
        body: claudeAvailable ? null : (
          <>
            <p className={styles.stepHint}>
              Chưa tìm thấy Claude CLI trên máy. Cài đặt bằng lệnh bên dưới rồi bấm "Kiểm tra lại".
            </p>
            <div className={styles.actionRow}>
              <a className={styles.linkBtn} href={CLAUDE_INSTALL_URL} target="_blank" rel="noreferrer">
                Xem hướng dẫn cài đặt Claude CLI
              </a>
            </div>
            <code className={styles.buildLog}>{CLAUDE_INSTALL_COMMAND}</code>
          </>
        ),
      },
      {
        key: 'host-claude-login',
        title: 'Đăng nhập Claude',
        ok: hostClaudeLoggedIn,
        body: hostClaudeLoggedIn ? null : !claudeAvailable ? (
          <p className={styles.stepHint}>Chờ cài Claude CLI ở bước trên.</p>
        ) : (
          <>
            <p className={styles.stepHint}>
              {hostClaude?.authMessage ?? 'Chưa đăng nhập Claude CLI trên máy.'} Mở terminal và chạy lệnh:
            </p>
            <code className={styles.buildLog}>claude /login</code>
          </>
        ),
      },
    ];

    const codexAvailable = Boolean(hostCodex?.available);
    const codexInstallUrl = hostCodex?.installUrl ?? 'https://github.com/openai/codex';
    const codexSteps: Array<{ key: string; title: string; ok: boolean; body: JSX.Element | null }> = [
      {
        key: 'host-codex-cli',
        title: 'Codex CLI',
        ok: codexAvailable,
        body: codexAvailable ? null : (
          <>
            <p className={styles.stepHint}>
              Chưa tìm thấy Codex CLI trên máy. Cài đặt bằng lệnh bên dưới rồi bấm "Kiểm tra lại".
            </p>
            <div className={styles.actionRow}>
              <a className={styles.linkBtn} href={codexInstallUrl} target="_blank" rel="noreferrer">
                Xem hướng dẫn cài đặt Codex CLI
              </a>
            </div>
            <code className={styles.buildLog}>npm install -g @openai/codex</code>
          </>
        ),
      },
      {
        key: 'host-codex-login',
        title: 'Đăng nhập Codex',
        ok: hostCodexLoggedIn,
        body: hostCodexLoggedIn ? null : !codexAvailable ? (
          <p className={styles.stepHint}>Chờ cài Codex CLI ở bước trên.</p>
        ) : (
          <>
            <p className={styles.stepHint}>
              {hostCodex?.authMessage ?? 'Chưa đăng nhập Codex CLI trên máy.'} Mở terminal và chạy lệnh:
            </p>
            <code className={styles.buildLog}>codex login</code>
          </>
        ),
      },
    ];

    const hostAnyReady = hostClaudeReady || hostCodexReady;
    const renderAgentSteps = (
      groupLabel: string,
      steps: Array<{ key: string; title: string; ok: boolean; body: JSX.Element | null }>,
    ) => (
      <div className={styles.agentGroup}>
        <span className={styles.agentGroupTitle}>{groupLabel}</span>
        <ol className={styles.steps}>
          {steps.map((s, i) => (
            <li key={s.key} className={`${styles.step}${s.ok ? ' ' + styles.stepOk : ''}`}>
              <span className={styles.stepBadge} aria-hidden="true">{s.ok ? '✓' : i + 1}</span>
              <div className={styles.stepBody}>
                <div className={styles.stepTitle}>
                  {s.title}
                  {s.ok ? <span className={styles.stepDone}>xong</span> : null}
                </div>
                {s.body}
              </div>
            </li>
          ))}
        </ol>
      </div>
    );
    return (
      <div
        className={styles.overlay}
        role="dialog"
        aria-modal="true"
        aria-labelledby="infra-setup-gate-title"
        data-testid="infra-setup-gate"
      >
        <div className={styles.card}>
          <span className={styles.kicker}>VNPAY Design Platform</span>
          <h2 id="infra-setup-gate-title" className={styles.title}>
            Thiết lập môi trường lần đầu
          </h2>
          <p className={styles.desc}>
            Open Design chạy trực tiếp qua CLI đã cài trên máy — không cần Docker. Cần MỘT trong hai
            CLI dưới đây sẵn sàng.
          </p>
          {renderAgentSteps('Claude', claudeSteps)}
          {renderAgentSteps('Codex', codexSteps)}
          <div className={styles.footer}>
            <div className={styles.footerLeft}>
              <button
                type="button"
                className={styles.linkBtn}
                disabled={rechecking}
                onClick={() => void recheck()}
              >
                {rechecking ? 'Đang kiểm tra…' : 'Kiểm tra lại'}
              </button>
              <button type="button" className={styles.skipBtn} onClick={skip}>
                Để sau (mở lại trong Cài đặt)
              </button>
            </div>
            <button
              type="button"
              className={styles.doneBtn}
              disabled={!hostAnyReady}
              onClick={dismiss}
            >
              Bắt đầu sử dụng
            </button>
          </div>
        </div>
      </div>
    );
  }

  // One installer only (Docker Desktop, the cross-platform choice) so a
  // no-code user never has to pick; Windows additionally gets the WSL2 note.
  const virtualizationOff = Boolean(
    isWindows && windowsSetup?.supportedPlatform && windowsSetup.detection?.virtualizationEnabled === false,
  );
  const windowsDetection = windowsSetup?.detection;
  const windowsGuidance = windowsSetup?.guidance;
  const virtualizationGuide = virtualizationOff && windowsSetup && windowsDetection && windowsGuidance ? (
    <div className={styles.firmwareGuide} data-testid="windows-virtualization-guide">
      <div className={styles.firmwareHeading}>Bật virtualization trong BIOS/UEFI</div>
      <p className={styles.stepHint}>
        Thiết bị: <strong>{windowsDetection.manufacturer} {windowsDetection.model}</strong>
      </p>
      {windowsDetection.virtualizationSupported === false ? (
        <p className={styles.stepErr}>CPU này không báo hỗ trợ hardware virtualization. Hãy liên hệ bộ phận IT.</p>
      ) : (
        <>
          <p className={styles.firmwareNotice}>
            Hãy chụp hoặc lưu hướng dẫn này trước khi tiếp tục vì bạn sẽ không xem được app khi đang ở BIOS.
          </p>
          <ol className={styles.firmwareSteps}>
            <li>Mở BIOS/UEFI của máy.</li>
            {windowsGuidance.menuPaths.map((path) => <li key={path}>Mở <code>{path}</code>.</li>)}
            <li>Bật <code>{windowsGuidance.settingNames.join(' hoặc ')}</code>, sau đó lưu và thoát.</li>
          </ol>
          {windowsGuidance.menuPaths.length ? (
            <p className={styles.stepHint}>Đường dẫn thường gặp: <code>{windowsGuidance.menuPaths.join(' / ')}</code></p>
          ) : null}
          {windowsGuidance.settingNames.length ? (
            <p className={styles.stepHint}>Tên cài đặt: <code>{windowsGuidance.settingNames.join(', ')}</code></p>
          ) : null}
          {windowsGuidance.notes.map((note) => <p className={styles.stepHint} key={note}>{note}</p>)}
          {windowsGuidance.supportUrl ? (
            <a className={styles.supportLink} href={windowsGuidance.supportUrl} target="_blank" rel="noreferrer">
              Xem hướng dẫn chính thức của {windowsGuidance.displayName}
            </a>
          ) : null}
          <label className={styles.confirmRow}>
            <input type="checkbox" checked={guidanceSaved} onChange={(event) => setGuidanceSaved(event.target.checked)} />
            Tôi đã chụp hoặc lưu hướng dẫn ở trên
          </label>
          {windowsSetup.canRestartToFirmware ? (
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={!guidanceSaved || restartingFirmware}
              onClick={() => void restartToFirmware()}
            >
              {restartingFirmware ? 'Đang khởi động lại…' : 'Khởi động vào BIOS/UEFI'}
            </button>
          ) : (
            <p className={styles.firmwareFallback}>
              Khởi động lại máy và nhấn liên tục <strong>{windowsGuidance.biosKeys.join(' hoặc ') || 'phím BIOS của hãng'}</strong> khi logo {windowsGuidance.displayName} xuất hiện.
            </p>
          )}
          {windowsSetup.pending ? (
            <p className={styles.stepHint}>Thiết lập đang chờ. Sau khi bật virtualization và quay lại Windows, app sẽ tự kiểm tra để tiếp tục.</p>
          ) : null}
        </>
      )}
      {windowsSetupError ? <p className={styles.stepErr}>{windowsSetupError}</p> : null}
    </div>
  ) : windowsSetupError ? <p className={styles.stepErr}>{windowsSetupError}</p> : null;
  if (usingRuntimeStatuses) {
    const runtimeLabel = sandboxRuntimeDisplayName(selectedRuntime);

    return (
      <div
        className={styles.overlay}
        role="dialog"
        aria-modal="true"
        aria-labelledby="infra-setup-gate-title"
        data-testid="infra-setup-gate"
      >
        <div className={styles.card}>
          <span className={styles.kicker}>VNPAY Design Platform</span>
          <h2 id="infra-setup-gate-title" className={styles.title}>
            Thiết lập môi trường lần đầu
          </h2>
          <p className={styles.desc}>
            Máy này còn thiếu vài thứ để chạy agent thiết kế. Làm theo runtime đang được chọn
            trong cấu hình hiện tại; các runtime khác không chặn bước bắt đầu.
          </p>
          <ol className={styles.steps}>
            <li className={`${styles.step}${status.dockerOk ? ' ' + styles.stepOk : ''}`}>
              <span className={styles.stepBadge} aria-hidden="true">{status.dockerOk ? '✓' : '1'}</span>
              <div className={styles.stepBody}>
                <div className={styles.stepTitle}>
                  Docker Desktop
                  {status.dockerOk ? <span className={styles.stepDone}>xong</span> : null}
                </div>
                {!status.dockerOk ? (
                  <>
                    {virtualizationGuide}
                    {!virtualizationOff ? (
                      <>
                        <p className={styles.stepHint}>
                          App sẽ tự cài và mở Docker Desktop. Hệ điều hành có thể yêu cầu bạn xác nhận quyền quản trị.
                        </p>
                        <div className={styles.actionRow}>
                          <button
                            type="button"
                            className={styles.primaryBtn}
                            disabled={dockerSetup?.running}
                            onClick={() => void startDockerSetup()}
                          >
                            {dockerSetup?.running ? 'Đang cài đặt…' : 'Cài Docker tự động'}
                          </button>
                        </div>
                      </>
                    ) : null}
                    {dockerSetup?.log.length ? (
                      <code className={styles.buildLog}>{dockerSetup.log[dockerSetup.log.length - 1]}</code>
                    ) : null}
                    {dockerSetup?.error ? <p className={styles.stepErr}>{dockerSetup.error}</p> : null}
                  </>
                ) : null}
              </div>
            </li>
            <li className={`${styles.step}${selectedRuntimeReady ? ' ' + styles.stepOk : ''}`}>
              <span className={styles.stepBadge} aria-hidden="true">
                {selectedRuntimeStatus?.imageAvailable ? '✓' : '2'}
              </span>
              <div className={styles.stepBody}>
                <div className={styles.stepTitle}>
                  {runtimeLabel}
                  {selectedRuntimeReady ? <span className={styles.stepDone}>xong</span> : null}
                </div>
                <div className={styles.runtimePanel}>
                  <ul className={styles.runtimeSpecs}>
                    <li>
                      <span>Version</span>
                      <code>{selectedRuntimeStatus?.version ?? '—'}</code>
                    </li>
                    <li>
                      <span>Image</span>
                      {selectedRuntimeStatus?.imageAvailable ? (
                        <span className={styles.runtimeOk}>{t('settings.sandboxOk')}</span>
                      ) : (
                        <span className={styles.runtimeMissing}>{t('settings.sandboxMissing')}</span>
                      )}
                    </li>
                    <li>
                      <span>Auth volume</span>
                      <code>{selectedRuntimeStatus?.authVolume ?? '—'}</code>
                      {selectedRuntimeStatus?.authVolumeAvailable ? (
                        <span className={styles.runtimeOk}>{t('settings.sandboxOk')}</span>
                      ) : (
                        <span className={styles.runtimeMissing}>{t('settings.sandboxMissing')}</span>
                      )}
                    </li>
                    <li>
                      <span>Auth status</span>
                      <code>{selectedRuntimeStatus?.authStatus ?? '—'}</code>
                    </li>
                    <li>
                      <span>Login method</span>
                      <code>{selectedRuntimeStatus?.loginMethod ?? '—'}</code>
                    </li>
                  </ul>
                </div>
                {!selectedRuntimeStatus?.imageAvailable ? (
                  !status.dockerOk ? (
                    <p className={styles.stepHint}>Chờ Docker hoàn tất ở bước trên.</p>
                  ) : (
                    <div className={styles.actionRow}>
                      <button
                        type="button"
                        className={styles.primaryBtn}
                        disabled={build?.building}
                        onClick={() => void startBuild()}
                      >
                        {build?.building ? 'Đang chuẩn bị…' : 'Chuẩn bị môi trường'}
                      </button>
                    </div>
                  )
                ) : null}
                {build?.error ? <p className={styles.stepErr}>{build.error}</p> : null}
              </div>
            </li>
            <li className={`${styles.step}${selectedRuntimeReady ? ' ' + styles.stepOk : ''}`}>
              <span className={styles.stepBadge} aria-hidden="true">
                {selectedRuntimeReady ? '✓' : '3'}
              </span>
              <div className={styles.stepBody}>
                <div className={styles.stepTitle}>
                  {selectedRuntime === 'codex'
                    ? t('settings.sandboxCodexTitle')
                    : t('settings.sandboxClaudeTitle')}
                  {selectedRuntimeReady ? <span className={styles.stepDone}>xong</span> : null}
                </div>
                {selectedRuntime === 'codex' ? (
                  <CodexDeviceLogin
                    disabled={selectedRuntimeStatus ? !selectedRuntimeStatus.imageAvailable : false}
                    onAuthChanged={() => void refreshStatus()}
                    onComplete={() => void refreshStatus()}
                  />
                ) : (
                  <EmbeddedClaudeLogin
                    onSuccess={() => {
                      void refreshStatus();
                    }}
                  />
                )}
              </div>
            </li>
          </ol>
          <div className={styles.footer}>
            <div className={styles.footerLeft}>
              <button
                type="button"
                className={styles.linkBtn}
                disabled={rechecking}
                onClick={() => void recheck()}
              >
                {rechecking ? 'Đang kiểm tra…' : 'Kiểm tra lại'}
              </button>
              <button type="button" className={styles.skipBtn} onClick={dismiss}>
                Để sau (mở lại trong Cài đặt)
              </button>
            </div>
            <button
              type="button"
              className={styles.doneBtn}
              disabled={!allOk}
              onClick={dismiss}
            >
              Bắt đầu sử dụng
            </button>
          </div>
        </div>
      </div>
    );
  }

  const steps: Array<{
    key: string;
    title: string;
    ok: boolean;
    blocked: boolean;
    body: JSX.Element | null;
  }> = [
    {
      key: 'docker',
      title: 'Docker engine',
      ok: Boolean(status.dockerOk),
      blocked: false,
      body: status.dockerOk ? null : (
        <>
          {virtualizationGuide}
          {!virtualizationOff ? <><p className={styles.stepHint}>
            {isWindows
              ? 'Cần Docker để chạy agent thiết kế trong môi trường cách ly. Cài Docker Desktop (trình cài sẽ tự bật WSL2 — đồng ý khi được hỏi và khởi động lại máy nếu nó yêu cầu), mở app lên rồi chờ vài giây — trạng thái sẽ tự cập nhật.'
              : 'Cần Docker để chạy agent thiết kế trong môi trường cách ly. Cài Docker Desktop, mở app lên rồi chờ vài giây — trạng thái sẽ tự cập nhật.'}
          </p>
          <div className={styles.actionRow}>
            <button
              type="button"
              className={styles.linkBtn}
              disabled={dockerSetup?.running}
              onClick={() => void startDockerSetup()}
            >
              {dockerSetup?.running ? 'Đang cài đặt…' : 'Cài Docker tự động'}
            </button>
          </div>
          </> : null}
          {dockerSetup?.log.length ? (
            <code className={styles.buildLog}>{dockerSetup.log[dockerSetup.log.length - 1]}</code>
          ) : null}
          {dockerSetup?.error ? <p className={styles.stepErr}>{dockerSetup.error}</p> : null}
        </>
      ),
    },
    {
      key: 'image',
      title: 'Môi trường agent (image sandbox)',
      ok: Boolean(status.imageOk),
      blocked: !status.dockerOk,
      body: status.imageOk ? null : !status.dockerOk ? (
        <p className={styles.stepHint}>Chờ Docker chạy xong ở bước trên.</p>
      ) : (
        <>
          <p className={styles.stepHint}>
            Tải môi trường dựng sẵn <code>{status.image}</code> về máy một lần duy nhất (vài phút,
            tùy mạng). Nếu không tải được sẽ tự build tại máy.
          </p>
          <div className={styles.actionRow}>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={build?.building}
              onClick={() => void startBuild()}
            >
              {build?.building ? 'Đang chuẩn bị…' : 'Chuẩn bị môi trường'}
            </button>
          </div>
          {build?.building && build.log.length ? (
            <code className={styles.buildLog}>{build.log[build.log.length - 1]}</code>
          ) : null}
          {build && !build.building && build.ok === false ? (
            <p className={styles.stepErr}>
              Thất bại: {build.error ?? 'lỗi không rõ'}
              {build.log.length ? (
                <code className={styles.buildLog}>{build.log.slice(-4).join('\n')}</code>
              ) : null}
            </p>
          ) : null}
        </>
      ),
    },
    ...(authNA
      ? []
      : [
          {
            key: 'claude',
            title: 'Đăng nhập Claude',
            ok: loggedIn,
            blocked: !ready,
            body: loggedIn ? (
              accounts?.activeUnsaved ? (
                <p className={styles.stepHint}>
                  Đã đăng nhập. Bạn có thể đặt tên tài khoản để chuyển đổi nhanh sau này trong{' '}
                  <button type="button" className={styles.inlineLink} onClick={onOpenSettings}>
                    Cài đặt
                  </button>
                  .
                </p>
              ) : null
            ) : !ready ? (
              <p className={styles.stepHint}>Chờ hai bước trên xong trước.</p>
            ) : (
              <>
                <p className={styles.stepHint}>
                  Bấm nút bên dưới — trình duyệt sẽ mở trang đăng nhập Claude; cho phép xong, dán mã
                  xác nhận vào ô ngay tại đây.
                </p>
                <EmbeddedClaudeLogin
                  onSuccess={() => {
                    void refreshAccounts();
                    void refreshStatus();
                  }}
                />
              </>
            ),
          },
        ]),
  ];

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="infra-setup-gate-title"
      data-testid="infra-setup-gate"
    >
      <div className={styles.card}>
        <span className={styles.kicker}>VNPAY Design Platform</span>
        <h2 id="infra-setup-gate-title" className={styles.title}>
          Thiết lập môi trường lần đầu
        </h2>
        <p className={styles.desc}>
          Máy này còn thiếu vài thứ để chạy agent thiết kế. Làm lần lượt từng bước — mỗi bước xong
          sẽ tự chuyển xanh.
        </p>
        <ol className={styles.steps}>
          {steps.map((s, i) => (
            <li
              key={s.key}
              className={`${styles.step}${s.ok ? ' ' + styles.stepOk : ''}${s.blocked ? ' ' + styles.stepBlocked : ''}`}
            >
              <span className={styles.stepBadge} aria-hidden="true">
                {s.ok ? '✓' : i + 1}
              </span>
              <div className={styles.stepBody}>
                <div className={styles.stepTitle}>
                  {s.title}
                  {s.ok ? <span className={styles.stepDone}>xong</span> : null}
                </div>
                {s.body}
              </div>
            </li>
          ))}
        </ol>
        <div className={styles.footer}>
          <div className={styles.footerLeft}>
            <button
              type="button"
              className={styles.linkBtn}
              disabled={rechecking}
              onClick={() => void recheck()}
            >
              {rechecking ? 'Đang kiểm tra…' : 'Kiểm tra lại'}
            </button>
            <button type="button" className={styles.skipBtn} onClick={skip}>
              Để sau (mở lại trong Cài đặt)
            </button>
          </div>
          <button
            type="button"
            className={styles.doneBtn}
            disabled={!allOk}
            onClick={dismiss}
          >
            Bắt đầu sử dụng
          </button>
        </div>
      </div>
    </div>
  );
}
