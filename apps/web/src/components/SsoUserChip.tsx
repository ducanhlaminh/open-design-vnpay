// Header avatar chip for the Google SSO session — lives at the right end of
// the workspace tabs chrome (next to new-tab/search). Renders NOTHING when
// auth is off or the app was entered without a session, so the header is
// byte-identical to the pre-SSO layout in that case. Click → small popover
// with the account identity + Đăng xuất.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { odLogout } from './AuthGate';

interface SessionUser {
  email: string;
  name: string;
  picture?: string;
  /** Role names from preview-identity — display only; managed in pipeline-studio. */
  roles?: string[];
}

function sessionUser(): SessionUser | null {
  return (
    (window as Window & { __odSessionUser?: SessionUser }).__odSessionUser ?? null
  );
}

export function SsoUserChip(): JSX.Element | null {
  const user = sessionUser();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [open]);

  if (!user) return null;

  const toggle = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    setOpen((o) => !o);
  };

  const initial = (user.name || user.email).slice(0, 1).toUpperCase();

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title={`${user.name} — ${user.email}`}
        aria-label="Tài khoản"
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          padding: 0,
          marginLeft: 4,
          border: '1px solid var(--border, #d0d5dd)',
          borderRadius: 999,
          background: 'var(--accent, #0066b3)',
          color: '#fff',
          fontSize: 11,
          fontWeight: 700,
          cursor: 'pointer',
          overflow: 'hidden',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        {user.picture ? (
          <img
            src={user.picture}
            alt=""
            referrerPolicy="no-referrer"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          initial
        )}
      </button>
      {open && pos
        ? createPortal(
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 998 }}
                onClick={() => setOpen(false)}
                aria-hidden
              />
              <div
                role="dialog"
                aria-label="Tài khoản Google"
                style={{
                  position: 'fixed',
                  top: pos.top,
                  right: pos.right,
                  zIndex: 999,
                  width: 260,
                  padding: 14,
                  borderRadius: 12,
                  background: 'var(--card, #fff)',
                  border: '1px solid var(--border, #e5e7eb)',
                  boxShadow: '0 12px 32px rgba(16,24,40,.16)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  {user.picture ? (
                    <img
                      src={user.picture}
                      alt=""
                      referrerPolicy="no-referrer"
                      style={{ width: 36, height: 36, borderRadius: 999 }}
                    />
                  ) : (
                    <span
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 999,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'var(--accent, #0066b3)',
                        color: '#fff',
                        fontWeight: 700,
                        fontSize: 15,
                      }}
                    >
                      {initial}
                    </span>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 13.5,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {user.name}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        opacity: 0.7,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {user.email}
                    </div>
                  </div>
                </div>
                {/* Roles from preview-identity — quản lý ở pipeline-studio /roles. */}
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    marginBottom: 12,
                    alignItems: 'center',
                  }}
                >
                  {user.roles?.length ? (
                    user.roles.map((r) => (
                      <span
                        key={r}
                        style={{
                          padding: '2px 9px',
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 600,
                          color:
                            r.toLowerCase() === 'admin'
                              ? '#b42318'
                              : 'var(--accent, #0066b3)',
                          background:
                            r.toLowerCase() === 'admin' ? '#fef3f2' : 'rgba(0,102,179,.08)',
                          border: `1px solid ${
                            r.toLowerCase() === 'admin' ? '#fecdca' : 'rgba(0,102,179,.25)'
                          }`,
                        }}
                      >
                        {r}
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: 11.5, opacity: 0.55 }}>
                      Chưa được gán role — quản lý trong Pipeline Studio
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void odLogout()}
                  style={{
                    width: '100%',
                    padding: '7px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border, #d0d5dd)',
                    background: 'transparent',
                    color: 'var(--foreground, #111827)',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Đăng xuất
                </button>
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
