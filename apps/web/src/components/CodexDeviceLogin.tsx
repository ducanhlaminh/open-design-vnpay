import { useCallback, useEffect, useRef, useState } from 'react';
import type { SandboxDeviceLoginResponse } from './sandbox-runtime';
import { useT } from '../i18n';
import styles from './CodexDeviceLogin.module.css';

const LOGIN_URL = '/api/sandbox/runtimes/codex/login';
const LOGIN_CANCEL_URL = '/api/sandbox/runtimes/codex/login/cancel';
const AUTH_URL = '/api/sandbox/runtimes/codex/auth';
const POLL_MS = 2000;

function normalizeLoginResponse(value: unknown): SandboxDeviceLoginResponse | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SandboxDeviceLoginResponse>;
  if (
    candidate.phase !== 'idle' &&
    candidate.phase !== 'starting' &&
    candidate.phase !== 'awaiting-user' &&
    candidate.phase !== 'verifying' &&
    candidate.phase !== 'done' &&
    candidate.phase !== 'error'
  ) {
    return null;
  }
  const phase = candidate.phase as SandboxDeviceLoginResponse['phase'];
  return {
    phase,
    url: typeof candidate.url === 'string' ? candidate.url : null,
    code: typeof candidate.code === 'string' ? candidate.code : null,
    expiresAt: typeof candidate.expiresAt === 'string' ? candidate.expiresAt : null,
    error: typeof candidate.error === 'string' ? candidate.error : null,
  };
}

function formatExpiresAt(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return expiresAt;
  return date.toLocaleString();
}

function extractResponseError(body: unknown, status: number): string {
  if (!body || typeof body !== 'object' || !('error' in body)) {
    return `HTTP ${status}`;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return `HTTP ${status}`;
}

interface Props {
  disabled?: boolean;
  onComplete?: () => void;
  onAuthChanged?: () => void;
}

export function CodexDeviceLogin({ disabled = false, onComplete, onAuthChanged }: Props): JSX.Element {
  const t = useT();
  const [session, setSession] = useState<SandboxDeviceLoginResponse>({
    phase: 'idle',
    url: null,
    code: null,
    expiresAt: null,
    error: null,
  });
  const [busy, setBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const completeFiredRef = useRef(false);

  const live = session.phase === 'starting' || session.phase === 'awaiting-user' || session.phase === 'verifying';

  const applySession = useCallback(
    (next: SandboxDeviceLoginResponse) => {
      setSession(next);
      if (next.phase === 'done') {
        if (!completeFiredRef.current) {
          completeFiredRef.current = true;
          onComplete?.();
        }
        onAuthChanged?.();
      }
    },
    [onAuthChanged, onComplete],
  );

  const call = useCallback(async (url: string, init?: RequestInit) => {
    setRequestError(null);
    setStatusError(null);
    const resp = await fetch(url, init);
    const data = normalizeLoginResponse(await resp.json().catch(() => null));
    if (!resp.ok) {
      const message = data?.error ?? `HTTP ${resp.status}`;
      throw new Error(message);
    }
    if (!data) {
      throw new Error('Malformed Codex login response');
    }
    applySession(data);
    return data;
  }, [applySession]);

  const refresh = useCallback(async () => {
    try {
      await call(LOGIN_URL);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }, [call]);

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [live, refresh]);

  const start = useCallback(async () => {
    if (disabled) return;
    setBusy(true);
    setRequestError(null);
    completeFiredRef.current = false;
    try {
      await call(LOGIN_URL, { method: 'POST' });
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [call, disabled]);

  const retry = useCallback(async () => {
    await start();
  }, [start]);

  const cancel = useCallback(async () => {
    setBusy(true);
    try {
      await call(LOGIN_CANCEL_URL, { method: 'POST' });
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      setBusy(false);
    }
    setSession({ phase: 'idle', url: null, code: null, expiresAt: null, error: null });
  }, [call]);

  const disconnect = useCallback(async () => {
    setAuthBusy(true);
    setRequestError(null);
    try {
      const resp = await fetch(AUTH_URL, { method: 'DELETE' });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(extractResponseError(body, resp.status));
      }
      onAuthChanged?.();
      setSession({ phase: 'idle', url: null, code: null, expiresAt: null, error: null });
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  }, [onAuthChanged]);

  const url = session.url;
  const code = session.code;
  const expiresAt = formatExpiresAt(session.expiresAt);

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div>
          <div className={styles.kicker}>{t('settings.sandboxCodexTitle')}</div>
          <p className={styles.hint}>{t('settings.sandboxCodexHint')}</p>
        </div>
        <span className={`${styles.statusPill} ${session.phase === 'done' ? styles.statusReady : styles.statusIdle}`}>
          {session.phase === 'done' ? t('settings.sandboxRuntimeReady') : t('settings.sandboxRuntimeNotReady')}
        </span>
      </div>

      {session.phase === 'idle' || session.phase === 'error' ? (
        <div className={styles.actions}>
          <button type="button" className={styles.primaryBtn} disabled={busy || disabled} onClick={() => void start()}>
            {session.phase === 'error' ? t('settings.testRetry') : t('settings.sandboxCodexLoginStart')}
          </button>
          {session.phase === 'error' && session.error ? <p className={styles.error}>{session.error}</p> : null}
        </div>
      ) : null}

      {session.phase === 'starting' ? (
        <p className={styles.hint}>Starting device-code login…</p>
      ) : null}

      {session.phase === 'awaiting-user' || session.phase === 'verifying' || session.phase === 'done' ? (
        <div className={styles.loginBody}>
          <div className={styles.row}>
            <span className={styles.label}>URL</span>
            {url ? (
              <a href={url} target="_blank" rel="noreferrer" className={styles.link}>
                {url}
              </a>
            ) : (
              <span className={styles.muted}>Waiting for browser authorization…</span>
            )}
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Code</span>
            <code className={styles.code}>{code ?? '—'}</code>
          </div>
          {expiresAt ? (
            <div className={styles.row}>
              <span className={styles.label}>Expires</span>
              <span className={styles.value}>{expiresAt}</span>
            </div>
          ) : null}
          {session.phase === 'awaiting-user' ? (
            <p className={styles.hint}>Waiting for you to approve the login…</p>
          ) : null}
          {session.phase === 'verifying' ? (
            <p className={styles.hint}>Verifying the code…</p>
          ) : null}
          {session.phase === 'done' ? (
            <p className={styles.success}>Signed in.</p>
          ) : null}
          {session.phase === 'error' && session.error ? (
            <p className={styles.error}>{session.error}</p>
          ) : null}
        </div>
      ) : null}

      {requestError ? <p className={styles.error}>{requestError}</p> : null}
      {statusError ? <p className={styles.error}>{statusError}</p> : null}

      <div className={styles.actions}>
        {live ? (
          <button type="button" className={styles.ghostBtn} onClick={() => void cancel()} disabled={busy}>
            {t('common.cancel')}
          </button>
        ) : null}
        {session.phase === 'done' ? (
          <button type="button" className={styles.ghostBtn} onClick={() => void disconnect()} disabled={authBusy}>
            {t('settings.sandboxCodexLoginDisconnect')}
          </button>
        ) : null}
        {session.phase === 'error' ? (
          <button type="button" className={styles.ghostBtn} onClick={() => void retry()} disabled={busy || disabled}>
            {t('settings.testRetry')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
