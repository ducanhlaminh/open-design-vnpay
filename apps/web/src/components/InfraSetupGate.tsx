// First-run infra setup gate: a full-screen wizard shown the first time the
// app opens on a machine whose sandbox infra is incomplete (Docker engine →
// sandbox image → Claude login). Read-side of `GET /api/sandbox/status` +
// `GET /api/sandbox/accounts`; actions reuse the existing build/login
// endpoints, so `od sandbox status|build|login` stays the CLI mirror.
//
// Dismissal is a per-machine localStorage flag (infra is machine state, not
// user config): the gate self-dismisses silently when every check already
// passes, and "Để sau" skips it — Settings → Execution keeps the same
// controls for later. Vietnamese-only copy on purpose — this fork's UI is
// Vietnamese and we avoid new i18n keys here (see ClaudeAccountSwitcher).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type {
  SandboxAccountsResponse,
  SandboxBuildResponse,
  DockerSetupResponse,
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

const DISMISS_KEY = 'od-infra-setup-done';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // Storage unavailable — the gate will re-evaluate next open, which is
    // harmless (it only shows while something is actually missing).
  }
}

interface Props {
  daemonLive: boolean;
  /** Opens Settings → Execution, where the sandbox card + account switcher live. */
  onOpenSettings: () => void;
}

export function InfraSetupGate({ daemonLive, onOpenSettings }: Props): JSX.Element | null {
  const t = useT();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [status, setStatus] = useState<SandboxUiStatusResponse | null>(null);
  const [accounts, setAccounts] = useState<SandboxAccountsResponse | null>(null);
  const [build, setBuild] = useState<SandboxBuildResponse | null>(null);
  const [dockerSetup, setDockerSetup] = useState<DockerSetupResponse | null>(null);
  const autoBuildStarted = useRef(false);
  const [selectedRuntime] = useState(() => getStoredSandboxRuntime());
  // True once the FIRST full evaluation decided the gate must show. Before
  // that we render nothing, so fully-provisioned machines never see a flash.
  const [evaluated, setEvaluated] = useState(false);

  const active = daemonLive && !dismissed;
  const runtimeStatuses = status?.runtimeStatuses ?? [];
  const runtimeById = new Map(runtimeStatuses.map((runtime) => [runtime.id, runtime] as const));
  const selectedRuntimeStatus = runtimeById.get(selectedRuntime);
  const usingRuntimeStatuses = runtimeStatuses.length > 0;

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/sandbox/status?probeAuth=1');
      if (r.ok) setStatus((await r.json()) as SandboxUiStatusResponse);
    } catch {
      // Daemon unreachable — keep the last snapshot.
    }
  }, []);

  // ── Cheap infra poll (docker version / image inspect / volume inspect).
  // 4s while the gate is relevant, so finishing a step flips it green live.
  useEffect(() => {
    if (!active) return;
    void refreshStatus();
    const id = window.setInterval(() => void refreshStatus(), 4000);
    return () => window.clearInterval(id);
  }, [active, refreshStatus]);

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
      await Promise.all([refreshStatus(), ready ? refreshAccounts() : Promise.resolve()]);
    } finally {
      setRechecking(false);
    }
  }, [refreshStatus, refreshAccounts, ready]);

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
    persistDismissed();
    setDismissed(true);
  }, []);

  useEffect(() => {
    if (!active || evaluated || !status) return;
    if (!status.enabled) {
      dismiss();
      return;
    }
    if (usingRuntimeStatuses) {
      if (!selectedRuntimeStatus || !selectedRuntimeReady) {
        setEvaluated(true);
        return;
      }
      dismiss();
      return;
    }
    if (!status.dockerOk || !status.imageOk) {
      setEvaluated(true);
      return;
    }
    // Shallow checks pass — the verdict needs the accounts answer.
    if (!accounts) return;
    if (!accounts.supported || accounts.loggedIn) {
      dismiss();
      return;
    }
    setEvaluated(true);
  }, [active, evaluated, status, accounts, dismiss, usingRuntimeStatuses, selectedRuntimeStatus, selectedRuntimeReady]);

  if (!active || !evaluated || !status) return null;
  const allOk = selectedRuntimeReady;

  // One installer only (Docker Desktop, the cross-platform choice) so a
  // no-code user never has to pick; Windows additionally gets the WSL2 note.
  const isWindows = /Windows/i.test(navigator.userAgent);
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
      ok: status.dockerOk,
      blocked: false,
      body: status.dockerOk ? null : (
        <>
          <p className={styles.stepHint}>
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
      ok: status.imageOk,
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
