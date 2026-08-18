// Host-mode Codex device-code login for the Settings → Runtime Codex card.
//
// Drives the daemon's host flow (`/api/sandbox/host/codex/login`): POST
// starts `codex login --device-auth` on the machine, GET is polled every 2 s
// while the flow is live so the card can show the verification URL + one-time
// code and then flip to `done` once Codex writes its auth.json. Same response
// shape as the Docker sandbox flow (SandboxCodexDeviceLoginStatus), so
// CodexDeviceLogin.tsx and this hook agree on phases.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SandboxDeviceLoginResponse } from '../components/sandbox-runtime';

export const HOST_CODEX_LOGIN_URL = '/api/sandbox/host/codex/login';
export const HOST_CODEX_LOGIN_CANCEL_URL = '/api/sandbox/host/codex/login/cancel';
const POLL_MS = 2000;

const IDLE: SandboxDeviceLoginResponse = { phase: 'idle', url: null, code: null, expiresAt: null, error: null };

function normalize(value: unknown): SandboxDeviceLoginResponse | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Partial<SandboxDeviceLoginResponse>;
  if (
    c.phase !== 'idle' &&
    c.phase !== 'starting' &&
    c.phase !== 'awaiting-user' &&
    c.phase !== 'verifying' &&
    c.phase !== 'done' &&
    c.phase !== 'error'
  ) {
    return null;
  }
  return {
    phase: c.phase,
    url: typeof c.url === 'string' ? c.url : null,
    code: typeof c.code === 'string' ? c.code : null,
    expiresAt: typeof c.expiresAt === 'string' ? c.expiresAt : null,
    error: typeof c.error === 'string' ? c.error : null,
  };
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim()) return error;
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
  }
  return `HTTP ${status}`;
}

export function useHostCodexDeviceLogin({ onDone }: { onDone?: () => void | Promise<void> } = {}) {
  const [session, setSession] = useState<SandboxDeviceLoginResponse>(IDLE);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const doneFiredRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const live = session.phase === 'starting' || session.phase === 'awaiting-user' || session.phase === 'verifying';

  const apply = useCallback((next: SandboxDeviceLoginResponse) => {
    setSession(next);
    if (next.phase === 'done' && !doneFiredRef.current) {
      doneFiredRef.current = true;
      void onDoneRef.current?.();
    }
  }, []);

  const call = useCallback(
    async (url: string, init?: RequestInit) => {
      const resp = await fetch(url, init);
      const body: unknown = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error(errorMessage(body, resp.status));
      const data = normalize(body);
      if (!data) throw new Error('Phản hồi đăng nhập Codex không hợp lệ.');
      apply(data);
      return data;
    },
    [apply],
  );

  // Poll while live. On a transient poll failure keep the last known state —
  // the flow lives in the daemon, not here.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      void call(HOST_CODEX_LOGIN_URL).catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [live, call]);

  const start = useCallback(async () => {
    setBusy(true);
    setRequestError(null);
    setCopied(false);
    doneFiredRef.current = false;
    try {
      await call(HOST_CODEX_LOGIN_URL, { method: 'POST' });
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [call]);

  const cancel = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(HOST_CODEX_LOGIN_CANCEL_URL, { method: 'POST' }).catch(() => null);
    } finally {
      setBusy(false);
    }
    setSession(IDLE);
  }, []);

  const copyCode = useCallback(async () => {
    if (!session.code) return;
    try {
      await navigator.clipboard.writeText(session.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the code is still visible on screen */
    }
  }, [session.code]);

  return { session, live, busy, requestError, copied, start, cancel, copyCode };
}
