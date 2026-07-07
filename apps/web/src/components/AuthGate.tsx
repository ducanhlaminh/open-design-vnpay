// Google SSO gate for the web UI — pairs with the daemon's auth-routes.ts.
// Renders nothing extra when auth is DISABLED on the daemon (the default).
//
// Login uses the Cursor-style handoff: the app never navigates to Google
// itself. It creates a login request on the daemon, opens the auth URL in
// the system browser (Electron's window-open handler routes http(s) URLs to
// `shell.openExternal`; a plain browser opens a new tab), and POLLS the
// claim endpoint. The browser tab finishes the OAuth dance and shows "you
// can close this tab"; the next poll returns the session and — because the
// claim response rides the app's own origin — the cookie lands exactly
// where the app runs, webview included.

import { useEffect, useRef, useState, type ReactNode } from 'react';

interface AuthUser {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  /** Role names from preview-identity (managed in pipeline-studio /roles). */
  roles?: string[];
}

type GateState =
  | { phase: 'checking' }
  | { phase: 'open' } // auth disabled → passthrough
  | { phase: 'login'; error?: string }
  | { phase: 'waiting'; authUrl: string }
  | { phase: 'ready'; user: AuthUser };

async function probeAuth(): Promise<GateState> {
  try {
    const conf = await fetch('/api/auth/config');
    const { enabled } = (await conf.json()) as { enabled?: boolean };
    if (!enabled) return { phase: 'open' };
    const me = await fetch('/api/auth/me');
    if (me.ok) {
      const { user } = (await me.json()) as { user: AuthUser };
      return { phase: 'ready', user };
    }
    const params = new URLSearchParams(window.location.search);
    const error = params.get('auth_error') ?? undefined;
    return { phase: 'login', ...(error ? { error } : {}) };
  } catch {
    // Daemon unreachable — let the app render its own "daemon offline" UX
    // instead of a misleading login wall.
    return { phase: 'open' };
  }
}

const POLL_MS = 1500;

const cardStyle: React.CSSProperties = {
  width: 360,
  maxWidth: '90vw',
  padding: '36px 32px',
  borderRadius: 16,
  background: 'var(--card, #fff)',
  border: '1px solid var(--border, #e5e7eb)',
  boxShadow: '0 12px 40px rgba(16,24,40,.12)',
  textAlign: 'center',
};

const shellStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--bg, #f6f7f9)',
  fontFamily: 'inherit',
};

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ phase: 'checking' });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    let alive = true;
    void probeAuth().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
      stopPolling();
    };
  }, []);

  const startLogin = async () => {
    try {
      const r = await fetch('/api/auth/login-request', { method: 'POST' });
      if (!r.ok) throw new Error(`login-request HTTP ${r.status}`);
      const { requestId, claimSecret, authUrl } = (await r.json()) as {
        requestId: string;
        claimSecret: string;
        authUrl: string;
      };
      // Electron routes external http(s) URLs to the system browser; a plain
      // browser opens a normal tab. Either way the app stays here and polls.
      window.open(authUrl, '_blank', 'noopener');
      setState({ phase: 'waiting', authUrl });
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch('/api/auth/login-request/claim', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId, claimSecret }),
          });
          if (res.status === 410 || res.status === 403) {
            stopPolling();
            setState({ phase: 'login', error: 'Phiên đăng nhập đã hết hạn — thử lại.' });
            return;
          }
          const body = (await res.json()) as { status?: string; user?: AuthUser };
          if (body.status === 'ok' && body.user) {
            stopPolling();
            setState({ phase: 'ready', user: body.user });
          }
        } catch {
          /* daemon hiccup — keep polling until TTL */
        }
      }, POLL_MS);
    } catch (e) {
      setState({ phase: 'login', error: String((e as Error).message) });
    }
  };

  if (state.phase === 'checking') {
    return <div className="od-loading-shell">Đang kiểm tra phiên đăng nhập…</div>;
  }

  if (state.phase === 'login' || state.phase === 'waiting') {
    const waiting = state.phase === 'waiting';
    return (
      <div style={shellStyle}>
        <div style={cardStyle}>
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>VNPAY Design Platform</div>
          <div style={{ fontSize: 13.5, color: 'var(--muted-foreground, #6b7280)', marginBottom: 24 }}>
            {waiting
              ? 'Hoàn tất đăng nhập Google trên trình duyệt vừa mở — xong là ứng dụng tự vào.'
              : 'Đăng nhập bằng tài khoản Google để tiếp tục'}
          </div>
          {state.phase === 'login' && state.error ? (
            <div
              style={{
                marginBottom: 16,
                padding: '8px 12px',
                borderRadius: 8,
                fontSize: 12.5,
                color: '#b42318',
                background: '#fef3f2',
                border: '1px solid #fecdca',
              }}
            >
              {state.error}
            </div>
          ) : null}
          {waiting ? (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  padding: '12px 0 18px',
                  color: 'var(--muted-foreground, #6b7280)',
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 999,
                    border: '2px solid #d0d5dd',
                    borderTopColor: '#2563eb',
                    animation: 'od-auth-spin .8s linear infinite',
                  }}
                />
                Đang chờ xác nhận từ trình duyệt…
                <style>{'@keyframes od-auth-spin{to{transform:rotate(360deg)}}'}</style>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <a
                  href={state.authUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ fontSize: 12.5, color: '#2563eb' }}
                >
                  Mở lại trang đăng nhập
                </a>
                <span style={{ color: 'var(--border, #d0d5dd)' }}>·</span>
                <button
                  type="button"
                  onClick={() => {
                    stopPolling();
                    setState({ phase: 'login' });
                  }}
                  style={{
                    fontSize: 12.5,
                    color: 'var(--muted-foreground, #6b7280)',
                    background: 'none',
                    border: 0,
                    padding: 0,
                    cursor: 'pointer',
                  }}
                >
                  Hủy
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void startLogin()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                width: '100%',
                padding: '10px 16px',
                borderRadius: 10,
                border: '1px solid var(--border, #d0d5dd)',
                background: '#fff',
                color: '#1f2937',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <GoogleMark />
              Đăng nhập với Google
            </button>
          )}
        </div>
      </div>
    );
  }

  // 'open' | 'ready' → render the SPA. When ready, expose the session user
  // for any component that wants it (Settings, feedback identity, …).
  if (state.phase === 'ready') {
    (window as Window & { __odSessionUser?: AuthUser }).__odSessionUser = state.user;
  }
  return <>{children}</>;
}

/** Log out (clears the daemon session cookie) then reload into the gate. */
export async function odLogout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/';
}
