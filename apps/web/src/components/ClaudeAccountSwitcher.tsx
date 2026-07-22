// Switch between saved Claude CLI accounts in the Docker sandbox. The sandbox
// auth is ONE credentials file in the od-claude-auth volume; each saved login is
// a copy, and "switch" swaps which is active. Only shows when the sandbox owns
// Claude (Docker-only). Backed by /api/sandbox/accounts. Vietnamese-only copy on
// purpose — this fork's UI is Vietnamese and we avoid new i18n keys here.
import { useCallback, useEffect, useState } from 'react';
import type {
  SandboxAccountsResponse,
  SandboxAccountsCheckResponse,
  SandboxLoginLaunchResponse,
} from '@open-design/contracts';
import styles from './ClaudeAccountSwitcher.module.css';

type AccStatus = { ok: boolean; error?: string };

const JSON_POST = (label: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label }),
});

export function ClaudeAccountSwitcher({ daemonLive }: { daemonLive: boolean }) {
  const [data, setData] = useState<SandboxAccountsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveLabel, setSaveLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<SandboxLoginLaunchResponse | null>(null);
  const [statuses, setStatuses] = useState<Record<string, AccStatus>>({});
  const [checkingLabel, setCheckingLabel] = useState<string | null>(null);

  // Probe token health. `label` → just that account; absent → all. A revoked/
  // expired token comes back not-ok and is flagged red — never deleted.
  const runCheck = useCallback(async (label?: string) => {
    setCheckingLabel(label ?? '*');
    try {
      const r = await fetch('/api/sandbox/accounts/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(label ? { label } : {}),
      });
      if (!r.ok) return;
      const j = (await r.json()) as SandboxAccountsCheckResponse;
      setStatuses((prev) => {
        const next = { ...prev };
        for (const s of j.statuses) next[s.label] = { ok: s.ok, error: s.error };
        return next;
      });
    } catch {
      /* transient — keep last statuses */
    } finally {
      setCheckingLabel(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!daemonLive) return;
    try {
      const r = await fetch('/api/sandbox/accounts');
      if (r.ok) setData((await r.json()) as SandboxAccountsResponse);
    } catch {
      /* daemon unreachable — keep the last snapshot */
    }
  }, [daemonLive]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Probe account health ONCE when the panel first sees saved accounts, so a
  // revoked token (password change) shows red on open. NO polling loop — each
  // probe hits Anthropic's usage endpoint, and an interval here (plus the 60s
  // quota meter) tripped its rate limit (HTTP 429). Re-checks are on-demand via
  // the per-account ⟳ button.
  useEffect(() => {
    if (!daemonLive || !data?.supported || !data.accounts.length) return;
    void runCheck();
  }, [daemonLive, data?.supported, data?.accounts.length, runCheck]);

  // Every mutation returns the fresh list, so one helper covers switch/save/remove.
  const call = useCallback(async (url: string, init?: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(url, init);
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setError(j?.error?.message ?? j?.error ?? `Lỗi ${r.status}`);
        return;
      }
      setData(j as SandboxAccountsResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Switching changes the active credentials → nudge the quota meter to re-poll
  // immediately (its own poll + the server cache would otherwise lag ~1 minute).
  const switchTo = useCallback(
    async (label: string) => {
      await call('/api/sandbox/accounts/switch', JSON_POST(label));
      window.dispatchEvent(new Event('od:claude-usage-refresh'));
    },
    [call],
  );

  // "Add account" = a fresh Claude OAuth login. It's an interactive terminal TUI
  // (can't run inside the web), so the daemon opens a host terminal; the user
  // finishes there and Saves. Falls back to a copyable command if it can't open.
  const addAccount = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/sandbox/accounts/login', { method: 'POST' });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setError(j?.error?.message ?? j?.error ?? `Lỗi ${r.status}`);
        return;
      }
      setLogin(j as SandboxLoginLaunchResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Hidden unless the sandbox owns Claude (Docker-only) — no account concept otherwise.
  if (!daemonLive || !data || !data.supported) return null;

  return (
    <div className={styles.block}>
      <div className={styles.title}>Tài khoản Claude (Docker sandbox)</div>

      {data.accounts.length === 0 ? (
        <p className={styles.hint}>
          {data.loggedIn
            ? 'Đã đăng nhập nhưng chưa lưu tài khoản nào. Đặt tên rồi Lưu để sau này chuyển đổi nhanh.'
            : 'Chưa đăng nhập tài khoản nào.'}
        </p>
      ) : (
        <ul className={styles.list}>
          {data.accounts.map((a) => {
            const st = statuses[a.label];
            const dead = st ? !st.ok : false;
            return (
            <li key={a.label} className={styles.item}>
              <div className={styles.row}>
              <button
                type="button"
                className={`${styles.acc}${a.active ? ' ' + styles.active : ''}${dead ? ' ' + styles.dead : ''}`}
                disabled={busy || a.active}
                onClick={() => void switchTo(a.label)}
                title={
                  dead
                    ? st?.error ?? 'Token lỗi'
                    : a.active
                      ? 'Đang dùng'
                      : `Chuyển sang "${a.label}"`
                }
              >
                <span className={`${styles.dot}${dead ? ' ' + styles.dotDead : ''}`} aria-hidden="true">
                  {dead ? '⚠' : a.active ? '●' : '○'}
                </span>
                <span className={styles.accName}>{a.label}</span>
                {/* Token health (OK / lỗi) shows for EVERY checked account,
                    including the active one, alongside its "đang dùng" tag. */}
                {st ? (
                  dead ? (
                    <span className={styles.accErr}>lỗi</span>
                  ) : (
                    <span className={styles.accOk}>OK</span>
                  )
                ) : null}
                {a.active ? <span className={styles.accTag}>đang dùng</span> : null}
              </button>
              <button
                type="button"
                className={styles.del}
                disabled={busy || checkingLabel !== null}
                title="Kiểm tra token của tài khoản này"
                onClick={() => void runCheck(a.label)}
              >
                {checkingLabel === a.label ? '…' : '⟳'}
              </button>
              <button
                type="button"
                className={styles.del}
                disabled={busy}
                title="Xoá tài khoản đã lưu (không đăng xuất)"
                onClick={() => void call(`/api/sandbox/accounts/${encodeURIComponent(a.label)}`, { method: 'DELETE' })}
              >
                ✕
              </button>
              </div>
              {dead && st?.error ? <p className={styles.rowErr}>{st.error}</p> : null}
            </li>
            );
          })}
        </ul>
      )}

      {data.activeUnsaved ? (
        <p className={styles.hint}>Login hiện tại chưa được lưu thành tài khoản.</p>
      ) : null}

      {/* Name-and-save the current login — only when there's an UNSAVED login to
          name: right after "+ Thêm tài khoản" (login flow) or an activeUnsaved. */}
      {login || data.activeUnsaved ? (
        <div className={styles.saveRow}>
          <input
            type="text"
            className={styles.input}
            placeholder="Tên tài khoản (Personal / Work)"
            value={saveLabel}
            disabled={busy}
            onChange={(e) => setSaveLabel(e.target.value)}
          />
          <button
            type="button"
            className={styles.btn}
            disabled={busy || !saveLabel.trim()}
            onClick={() => {
              void (async () => {
                await call('/api/sandbox/accounts/save', JSON_POST(saveLabel.trim()));
                setSaveLabel('');
                setLogin(null); // saved → close the add/name flow
              })();
            }}
          >
            Lưu login hiện tại
          </button>
        </div>
      ) : null}

      <button
        type="button"
        className={`${styles.btn} ${styles.addBtn}`}
        disabled={busy}
        onClick={() => void addAccount()}
      >
        + Thêm tài khoản mới (đăng nhập)
      </button>

      {login ? (
        <div className={styles.loginPanel}>
          <p className={styles.hint}>
            {login.message ??
              (login.launched
                ? 'Hoàn tất đăng nhập ở cửa sổ terminal vừa mở, rồi đặt tên + Lưu bên trên.'
                : 'Chạy lệnh này ở terminal để đăng nhập tài khoản mới, rồi quay lại đặt tên + Lưu.')}
          </p>
          <div className={styles.cmdRow}>
            <code className={styles.cmd}>{login.command}</code>
            <button
              type="button"
              className={styles.btn}
              onClick={() => void navigator.clipboard?.writeText(login.command).catch(() => {})}
              title="Copy lệnh"
            >
              Copy
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  );
}
