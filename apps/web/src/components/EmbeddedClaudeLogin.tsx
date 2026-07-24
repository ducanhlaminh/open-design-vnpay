// Embedded (no-terminal) Claude login — shared by the first-run wizard and
// the Settings account switcher. Talks to /api/sandbox/accounts/embedded-login:
// start → daemon walks the container login TUI and opens the OAuth page in the
// host browser → the user pastes the confirmation code HERE → done when the
// credentials land in the auth volume. A terminal-window fallback stays one
// click away for machines where the embedded path misbehaves. Vietnamese-only
// copy on purpose (fork convention — no new i18n keys).
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SandboxEmbeddedLoginStatus,
  SandboxLoginLaunchResponse,
} from '@open-design/contracts';
import styles from './EmbeddedClaudeLogin.module.css';

interface Props {
  /** Called once when the login completes (credentials present). */
  onSuccess: () => void;
  /** Label for the idle-state start button. */
  startLabel?: string;
}

export function EmbeddedClaudeLogin({ onSuccess, startLabel }: Props): JSX.Element {
  const [status, setStatus] = useState<SandboxEmbeddedLoginStatus>({
    phase: 'idle',
    url: null,
    error: null,
  });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [terminalFallback, setTerminalFallback] = useState<SandboxLoginLaunchResponse | null>(null);
  const successFired = useRef(false);

  const applyStatus = useCallback(
    (next: SandboxEmbeddedLoginStatus) => {
      setStatus(next);
      if (next.phase === 'done' && !successFired.current) {
        successFired.current = true;
        onSuccess();
      }
    },
    [onSuccess],
  );

  const call = useCallback(
    async (url: string, init?: RequestInit) => {
      setBusy(true);
      setRequestError(null);
      try {
        const r = await fetch(url, init);
        const j = (await r.json().catch(() => null)) as
          | SandboxEmbeddedLoginStatus
          | { error?: { message?: string } }
          | null;
        if (!r.ok) {
          setRequestError(
            (j as { error?: { message?: string } })?.error?.message ?? `Lỗi ${r.status}`,
          );
          return;
        }
        if (j) applyStatus(j as SandboxEmbeddedLoginStatus);
      } catch (e) {
        setRequestError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [applyStatus],
  );

  // Poll while a session is live so the phase flips without user action
  // (URL extracted, code verified, timeout error...).
  const live = status.phase === 'starting' || status.phase === 'awaiting-code' || status.phase === 'verifying';
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      void fetch('/api/sandbox/accounts/embedded-login')
        .then((r) => (r.ok ? (r.json() as Promise<SandboxEmbeddedLoginStatus>) : null))
        .then((j) => {
          if (j) applyStatus(j);
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(id);
  }, [live, applyStatus]);

  const start = useCallback(() => {
    successFired.current = false;
    setCode('');
    setTerminalFallback(null);
    void call('/api/sandbox/accounts/embedded-login', { method: 'POST' });
  }, [call]);

  const submitCode = useCallback(() => {
    if (!code.trim()) return;
    void call('/api/sandbox/accounts/embedded-login/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim() }),
    });
  }, [call, code]);

  const openTerminalFallback = useCallback(() => {
    void (async () => {
      // Cancel the embedded session first so two logins don't fight over stdin.
      await fetch('/api/sandbox/accounts/embedded-login', { method: 'DELETE' }).catch(() => {});
      setStatus({ phase: 'idle', url: null, error: null });
      try {
        const r = await fetch('/api/sandbox/accounts/login', { method: 'POST' });
        const j = (await r.json().catch(() => null)) as SandboxLoginLaunchResponse | null;
        if (r.ok && j) setTerminalFallback(j);
      } catch {
        /* surfaced by the missing panel — user can retry */
      }
    })();
  }, []);

  return (
    <div className={styles.box}>
      {status.phase === 'idle' || status.phase === 'error' ? (
        <>
          {status.phase === 'error' && status.error ? (
            <p className={styles.err}>{status.error}</p>
          ) : null}
          <button type="button" className={styles.primaryBtn} disabled={busy} onClick={start}>
            {startLabel ?? 'Đăng nhập Claude'}
          </button>
        </>
      ) : null}

      {status.phase === 'starting' ? (
        <p className={styles.hint}>Đang khởi tạo phiên đăng nhập… (vài giây)</p>
      ) : null}

      {status.phase === 'awaiting-code' || status.phase === 'verifying' ? (
        <>
          <p className={styles.hint}>
            Trình duyệt đã mở trang đăng nhập Claude — bấm <b>Cho phép</b>, copy <b>mã xác nhận</b>{' '}
            rồi dán vào đây.{' '}
            {status.url ? (
              <a href={status.url} target="_blank" rel="noreferrer">
                Mở lại trang đăng nhập
              </a>
            ) : null}
          </p>
          {status.error ? <p className={styles.err}>{status.error}</p> : null}
          <div className={styles.codeRow}>
            <input
              type="text"
              className={styles.input}
              placeholder="Dán mã xác nhận vào đây"
              value={code}
              disabled={busy || status.phase === 'verifying'}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCode();
              }}
            />
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={busy || status.phase === 'verifying' || !code.trim()}
              onClick={submitCode}
            >
              {status.phase === 'verifying' ? 'Đang xác thực…' : 'Xác nhận'}
            </button>
          </div>
        </>
      ) : null}

      {status.phase === 'done' ? <p className={styles.ok}>✓ Đã đăng nhập thành công.</p> : null}

      {requestError ? <p className={styles.err}>{requestError}</p> : null}

      {status.phase !== 'done' ? (
        <button type="button" className={styles.fallbackLink} onClick={openTerminalFallback}>
          Cách khác: đăng nhập qua cửa sổ Terminal
        </button>
      ) : null}

      {terminalFallback ? (
        <p className={styles.hint}>
          {terminalFallback.message ??
            (terminalFallback.launched
              ? 'Hoàn tất đăng nhập ở cửa sổ terminal vừa mở.'
              : 'Chạy lệnh này trong terminal:')}{' '}
          {!terminalFallback.launched ? <code className={styles.cmd}>{terminalFallback.command}</code> : null}
        </p>
      ) : null}
    </div>
  );
}
