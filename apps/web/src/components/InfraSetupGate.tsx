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
import { useCallback, useEffect, useState } from 'react';
import type {
  SandboxAccountsResponse,
  SandboxBuildResponse,
  SandboxLoginLaunchResponse,
  SandboxStatusResponse,
} from '@open-design/contracts';
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
  const [dismissed, setDismissed] = useState(readDismissed);
  const [status, setStatus] = useState<SandboxStatusResponse | null>(null);
  const [accounts, setAccounts] = useState<SandboxAccountsResponse | null>(null);
  const [build, setBuild] = useState<SandboxBuildResponse | null>(null);
  const [login, setLogin] = useState<SandboxLoginLaunchResponse | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  // True once the FIRST full evaluation decided the gate must show. Before
  // that we render nothing, so fully-provisioned machines never see a flash.
  const [evaluated, setEvaluated] = useState(false);

  const active = daemonLive && !dismissed;

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/sandbox/status');
      if (r.ok) setStatus((await r.json()) as SandboxStatusResponse);
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
    if (!active || !ready) return;
    void refreshAccounts();
  }, [active, ready, status?.authVolumeOk, refreshAccounts]);

  useEffect(() => {
    if (!active || !ready || !login || loggedIn) return;
    const id = window.setInterval(() => void refreshAccounts(), 6000);
    return () => window.clearInterval(id);
  }, [active, ready, login, loggedIn, refreshAccounts]);

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

  const startLogin = useCallback(async () => {
    setLoginBusy(true);
    try {
      const r = await fetch('/api/sandbox/accounts/login', { method: 'POST' });
      const j = (await r.json().catch(() => null)) as SandboxLoginLaunchResponse | null;
      if (r.ok && j) setLogin(j);
    } catch {
      // Daemon unreachable — leave the button for a retry.
    } finally {
      setLoginBusy(false);
    }
  }, []);

  // Auth step is N/A when the sandbox doesn't own Claude (host CLI handles
  // login there); until /accounts answers, assume it applies.
  const authNA = accounts != null && !accounts.supported;
  const allOk = Boolean(status?.dockerOk && status?.imageOk && (authNA || loggedIn));

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
  }, [active, evaluated, status, accounts, dismiss]);

  if (!active || !evaluated || !status) return null;

  // One installer only (Docker Desktop, the cross-platform choice) so a
  // no-code user never has to pick; Windows additionally gets the WSL2 note.
  const isWindows = /Windows/i.test(navigator.userAgent);

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
            <a
              className={styles.linkBtn}
              href="https://www.docker.com/products/docker-desktop/"
              target="_blank"
              rel="noreferrer"
            >
              Tải Docker Desktop
            </a>
          </div>
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
                  Bấm nút bên dưới — một cửa sổ terminal sẽ mở ra kèm trình duyệt để đăng nhập tài
                  khoản Claude. Làm theo hướng dẫn trong đó rồi quay lại đây, trạng thái sẽ tự
                  chuyển xanh.
                </p>
                <div className={styles.actionRow}>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    disabled={loginBusy}
                    onClick={() => void startLogin()}
                  >
                    {login ? 'Mở lại cửa sổ đăng nhập' : 'Đăng nhập Claude'}
                  </button>
                  {login ? (
                    <button
                      type="button"
                      className={styles.linkBtn}
                      onClick={() => void refreshAccounts()}
                    >
                      Kiểm tra lại
                    </button>
                  ) : null}
                </div>
                {login && !login.launched ? (
                  <p className={styles.stepHint}>
                    {login.message ?? 'Không mở được terminal — chạy lệnh này thủ công:'}{' '}
                    <code className={styles.cmd}>{login.command}</code>
                  </p>
                ) : null}
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
