// Google SSO for the Open Design daemon — gateway mode, ported from
// pipeline-studio's server/identity.ts (the battle-tested VNPAY setup).
//
// THIS daemon owns the OAuth authorization-code dance with Google, issues its
// own HMAC-SHA256 session cookie (od_session), and (best-effort) upserts the
// user into preview-identity so the same account works across pipeline-studio
// and Open Design. Google is the ONLY login method — no local email/password.
//
// OPT-IN: everything here is inert unless the env carries
//   SESSION_SECRET + GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
// (plus OD_APP_URL = the browser origin the web UI is served from, since the
// Google redirect_uri must be `${OD_APP_URL}/api/auth/google/callback` and
// registered in the Google Console). Without them the daemon behaves exactly
// as before — no gate, no routes beyond /api/auth/config reporting disabled.
//
// GATE SCOPE (phase 1 — "identify the user", not "lock the machine"):
// only BROWSER requests to /api/* are gated. A browser always sends
// Sec-Fetch-* / Origin / Referer headers; the local CLI (`od …`), the desktop
// sidecar and daemon-internal fetches send none, and keep working ungated
// from loopback. A LAN visitor opening the web UI hits the login screen.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AuthSyncIssue, AuthSyncState } from '@open-design/contracts';

const SESSION_COOKIE = 'od_session';
const STATE_COOKIE = 'od_oauth_state';
const SESSION_TTL_S = 7 * 24 * 60 * 60; // 7 days — local tool, low-risk scope

export interface AuthSessionUser {
  /** Google subject for new sessions. Legacy cookies may contain an identity
   * UUID or `google:<subject>` here and are reconciled defensively. */
  sub: string;
  googleSubject?: string;
  /** Canonical preview-identity UUID. The only id allowed at identity APIs. */
  identityUserId?: string;
  syncIssue?: AuthSyncIssue;
  email: string;
  name: string;
  picture?: string;
  provider: 'google';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isIdentityUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function identityUserIdOf(user: AuthSessionUser | null): string | null {
  if (!user) return null;
  if (isIdentityUuid(user.identityUserId)) return user.identityUserId;
  // Backward compatibility for cookies issued before identityUserId existed.
  return isIdentityUuid(user.sub) ? user.sub : null;
}

function googleSubjectOf(user: AuthSessionUser): string {
  if (typeof user.googleSubject === 'string' && user.googleSubject) return user.googleSubject;
  return user.sub.startsWith('google:') ? user.sub.slice('google:'.length) : (isIdentityUuid(user.sub) ? '' : user.sub);
}

export interface AuthConfig {
  sessionSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  /** Fallback browser origin of the web UI (return target after login) —
   *  normally the CURRENT origin is taken from the login request's Referer,
   *  since tools-dev assigns the web port dynamically. */
  appUrl: string;
  /** FIXED origin registered in the Google Console as the redirect_uri base
   *  (`${callbackOrigin}/api/auth/google/callback`). The daemon binds a tiny
   *  dedicated listener on this port so the callback survives dynamic
   *  daemon/web ports across restarts. Cookies are host-scoped (ports are
   *  ignored), so a session cookie set on this origin is visible to the web
   *  UI on any other localhost port. */
  callbackOrigin: string;
  /** preview-identity base URL — optional, upsert is best-effort. */
  identityUrl: string;
  /** Bearer credential for the identity service principal that may exchange
   * verified OAuth identities. It must carry `user:manage:global`. */
  identityServiceToken: string;
  /** Master switch for the allowlists below (OD_AUTH_DOMAIN_LOCK=1|true).
   *  OFF (dev default) → any verified Google account may sign in, lists are
   *  ignored. ON → only allowedEmails/allowedDomains pass; with both lists
   *  empty the lock FAILS CLOSED (nobody passes) so a half-finished config
   *  never silently opens the door. */
  domainLock: boolean;
  /** Comma-separated allowlists — enforced only when domainLock is on. */
  allowedEmails: string[];
  allowedDomains: string[];
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  return {
    sessionSecret: env.SESSION_SECRET ?? '',
    googleClientId: env.GOOGLE_CLIENT_ID ?? '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    appUrl: (env.OD_APP_URL ?? `http://localhost:${env.OD_WEB_PORT || '52564'}`).replace(/\/+$/, ''),
    callbackOrigin: (env.OD_AUTH_CALLBACK_URL ?? 'http://localhost:52564').replace(/\/+$/, ''),
    identityUrl: (env.IDENTITY_URL ?? '').replace(/\/+$/, ''),
    identityServiceToken: env.IDENTITY_SERVICE_TOKEN ?? '',
    domainLock: env.OD_AUTH_DOMAIN_LOCK === '1' || env.OD_AUTH_DOMAIN_LOCK === 'true',
    allowedEmails: list(env.OD_AUTH_ALLOWED_EMAILS),
    allowedDomains: list(env.OD_AUTH_ALLOWED_DOMAINS),
  };
}

export function isAuthEnabled(cfg: AuthConfig): boolean {
  return Boolean(cfg.sessionSecret && cfg.googleClientId && cfg.googleClientSecret);
}

/** Allowlist check — a no-op unless the domain lock is switched ON. With the
 *  lock on, only listed emails/domains pass; empty lists fail closed. */
export function emailAllowed(cfg: AuthConfig, email: string): boolean {
  if (!cfg.domainLock) return true;
  const lower = email.toLowerCase();
  if (cfg.allowedEmails.includes(lower)) return true;
  const domain = lower.slice(lower.lastIndexOf('@') + 1);
  return cfg.allowedDomains.includes(domain);
}

/* ── compact HMAC session token (header-less JWS-alike, no deps) ── */

export function signSession(secret: string, user: AuthSessionUser, nowMs = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ ...user, exp: Math.floor(nowMs / 1000) + SESSION_TTL_S }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(
  secret: string,
  token: string | undefined,
  nowMs = Date.now(),
): AuthSessionUser | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = createHmac('sha256', secret).update(payload).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp * 1000 < nowMs) return null;
    if (typeof data.sub !== 'string' || !data.sub) return null;
    return data as AuthSessionUser;
  } catch {
    return null;
  }
}

/* ── cookies (no cookie-parser dep) ── */

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function setCookie(res: Response, appUrl: string, name: string, value: string, maxAgeS: number) {
  const secure = appUrl.startsWith('https://') ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`,
  );
}

/* ── request classification ─────────────────────────────────────────────────
 * Phase-1 gate applies to BROWSER traffic only, so local tooling keeps
 * working without a token. Discriminator: real browsers send the full
 * Sec-Fetch-Dest/Site metadata plus Origin/Referer; Node's undici fetch (the
 * `od` CLI, daemon-internal calls) sends ONLY `sec-fetch-mode: cors` — so
 * that one header is deliberately NOT part of the check. */
export function isBrowserRequest(headers: Record<string, unknown>): boolean {
  return Boolean(
    headers['sec-fetch-dest'] || headers['sec-fetch-site'] || headers['origin'] || headers['referer'],
  );
}

/** Session user attached by the gate (null when auth disabled / CLI path). */
export function authUserOf(req: Request): AuthSessionUser | null {
  return (req as Request & { odSessionUser?: AuthSessionUser }).odSessionUser ?? null;
}

/* ── machine user ("máy này thuộc ai") ──────────────────────────────────────
 * Open Design is local-first: pushes run from the daemon/CLI where no browser
 * session exists. The LAST successful Google login is persisted as this
 * machine's owner and stamps everything the machine pushes (media file
 * owner, workspace owner props, identity project registration). Logout does
 * NOT clear it — signing out of the UI doesn't change whose machine it is. */

const MACHINE_USER_FILE = 'auth-user.json';
let machineUserDir: string | null = null;
let machineUserCache: { at: number; user: AuthSessionUser | null } | null = null;
let activeAuthConfig: AuthConfig | null = null;

function rememberMachineUser(user: AuthSessionUser): void {
  machineUserCache = { at: Date.now(), user };
  if (!machineUserDir) return;
  try {
    mkdirSync(machineUserDir, { recursive: true });
    writeFileSync(
      join(machineUserDir, MACHINE_USER_FILE),
      JSON.stringify(
        {
          sub: user.sub,
          googleSubject: googleSubjectOf(user),
          identityUserId: identityUserIdOf(user),
          syncIssue: user.syncIssue ?? null,
          email: user.email,
          name: user.name,
          ...(user.picture ? { picture: user.picture } : {}),
          provider: 'google',
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {
    /* disk hiccup — in-memory copy still serves this daemon's lifetime */
  }
}

/** The persisted machine owner (last Google login on this machine), if any. */
export function getMachineUser(): AuthSessionUser | null {
  if (machineUserCache && Date.now() - machineUserCache.at < 10_000) return machineUserCache.user;
  let user: AuthSessionUser | null = null;
  if (machineUserDir) {
    try {
      const raw = JSON.parse(readFileSync(join(machineUserDir, MACHINE_USER_FILE), 'utf8'));
      if (typeof raw?.sub === 'string' && raw.sub && typeof raw?.email === 'string') {
        user = {
          sub: raw.sub,
          ...(typeof raw.googleSubject === 'string' ? { googleSubject: raw.googleSubject } : {}),
          ...(isIdentityUuid(raw.identityUserId) ? { identityUserId: raw.identityUserId } : {}),
          ...(typeof raw.syncIssue === 'string' ? { syncIssue: raw.syncIssue as AuthSyncIssue } : {}),
          email: raw.email,
          name: raw.name ?? raw.email,
          ...(typeof raw.picture === 'string' ? { picture: raw.picture } : {}),
          provider: 'google',
        };
      }
    } catch {
      /* absent/corrupt → no machine user */
    }
  }
  machineUserCache = { at: Date.now(), user };
  return user;
}

/* ── Cursor-style login handoff ─────────────────────────────────────────────
 * The app (web tab or the desktop webview) never leaves for Google itself:
 * it creates a LOGIN REQUEST, opens `${callbackOrigin}/api/auth/google?lr=…`
 * in the system browser, and POLLS the claim endpoint. When the browser
 * finishes the OAuth dance, the callback parks the signed session on the
 * pending request and shows "you can close this tab"; the app's next poll
 * CLAIMS it — and because the claim response travels through the app's own
 * origin, the Set-Cookie lands exactly where the app runs (any host/port,
 * including the Electron webview). `claimSecret` never appears in the
 * browser URL, so a leaked/lr-bearing history entry cannot steal a session. */

interface PendingLogin {
  claimSecret: string;
  createdAt: number;
  token?: string;
  user?: AuthSessionUser;
}

const LOGIN_REQUEST_TTL_MS = 10 * 60_000;
const pendingLogins = new Map<string, PendingLogin>();

function prunePendingLogins(nowMs = Date.now()): void {
  for (const [id, p] of pendingLogins) {
    if (nowMs - p.createdAt > LOGIN_REQUEST_TTL_MS) pendingLogins.delete(id);
  }
}

export function createLoginRequest(nowMs = Date.now()): { requestId: string; claimSecret: string } {
  prunePendingLogins(nowMs);
  const requestId = randomBytes(16).toString('hex');
  const claimSecret = randomBytes(24).toString('base64url');
  pendingLogins.set(requestId, { claimSecret, createdAt: nowMs });
  return { requestId, claimSecret };
}

/** Park a completed session on its pending request (callback side). */
export function fulfillLoginRequest(requestId: string, user: AuthSessionUser, token: string): boolean {
  const p = pendingLogins.get(requestId);
  if (!p) return false;
  p.user = user;
  p.token = token;
  return true;
}

export type ClaimResult =
  | { status: 'expired' }
  | { status: 'forbidden' }
  | { status: 'pending' }
  | { status: 'ok'; user: AuthSessionUser; token: string };

export function claimLoginRequest(requestId: string, claimSecret: string, nowMs = Date.now()): ClaimResult {
  prunePendingLogins(nowMs);
  const p = pendingLogins.get(requestId);
  if (!p) return { status: 'expired' };
  if (p.claimSecret !== claimSecret) return { status: 'forbidden' };
  if (!p.token || !p.user) return { status: 'pending' };
  pendingLogins.delete(requestId); // one-shot
  return { status: 'ok', user: p.user, token: p.token };
}

/** "Đã đăng nhập — đóng tab này" page shown in the external browser. */
function handoffResultPage(ok: boolean, detail: string): string {
  const title = ok ? 'Đăng nhập thành công' : 'Đăng nhập thất bại';
  const icon = ok ? '✓' : '✕';
  const color = ok ? '#16a34a' : '#dc2626';
  const hint = ok
    ? 'Bạn có thể đóng tab này và quay lại ứng dụng — phiên đăng nhập đã sẵn sàng.'
    : detail;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f9;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
<div style="width:380px;max-width:90vw;padding:40px 32px;border-radius:16px;background:#fff;border:1px solid #e5e7eb;box-shadow:0 12px 40px rgba(16,24,40,.12);text-align:center">
<div style="width:56px;height:56px;margin:0 auto 16px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:26px;color:#fff;background:${color}">${icon}</div>
<div style="font-size:19px;font-weight:700;margin-bottom:8px">${title}</div>
<div style="font-size:13.5px;color:#6b7280;line-height:1.6">${hint}</div>
</div>
<script>if(${ok}){setTimeout(function(){try{window.close()}catch(e){}},1200)}</script>
</body></html>`;
}

/* ── preview-identity best-effort upsert (same account as pipeline-studio) ── */

type IdentityResolution =
  | { ok: true; id: string }
  | { ok: false; issue: AuthSyncIssue };

async function upsertIdentityUser(
  cfg: AuthConfig,
  input: { externalId: string; email: string; name: string; picture?: string },
): Promise<IdentityResolution> {
  if (!cfg.identityUrl) return { ok: false, issue: 'identity_not_configured' };
  if (!cfg.identityServiceToken) return { ok: false, issue: 'identity_not_configured' };
  const idFetch = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${cfg.identityUrl}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(5_000),
      headers: { 'content-type': 'application/json', 'x-user-id': 'open-design', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
  };
  const usersOf = (body: unknown): Array<{ id?: string; email?: string }> => {
    if (!body || typeof body !== 'object') return [];
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.users)) return b.users as Array<{ id?: string; email?: string }>;
    if (Array.isArray(b.items)) return b.items as Array<{ id?: string; email?: string }>;
    if (Array.isArray(body)) return body as Array<{ id?: string; email?: string }>;
    return [];
  };
  try {
    // Preferred atomic exchange. It is idempotent on email and returns the
    // canonical UUID even when another first-party app created the user.
    const resolved = await idFetch('/api/v1/auth/external/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.identityServiceToken}` },
      body: JSON.stringify({
        provider: 'google',
        externalId: input.externalId || input.email,
        email: input.email,
        name: input.name,
        ...(input.picture ? { avatarUrl: input.picture } : {}),
      }),
    });
    const resolvedBody = resolved.json as { user?: { id?: string } } | null;
    if (resolved.ok && isIdentityUuid(resolvedBody?.user?.id)) {
      return { ok: true, id: resolvedBody!.user!.id! };
    }
    // A deployed identity service is temporarily unavailable. Do not turn a
    // recoverable outage into "unresolved" merely because the legacy
    // fallback endpoints cannot answer either.
    if (resolved.status >= 500) return { ok: false, issue: 'identity_unavailable' };

    // Tolerate an older identity deployment during rolling upgrades.
    const found = await idFetch(`/api/v1/admin/users?search=${encodeURIComponent(input.email)}&limit=10`);
    if (found.status >= 500) return { ok: false, issue: 'identity_unavailable' };
    const match = usersOf(found.json).find(
      (u) => typeof u.email === 'string' && u.email.toLowerCase() === input.email.toLowerCase(),
    );
    if (isIdentityUuid(match?.id)) return { ok: true, id: match.id };
    const created = await idFetch('/api/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        name: input.name,
        password: randomBytes(24).toString('base64url'),
      }),
    });
    if (created.status >= 500) return { ok: false, issue: 'identity_unavailable' };
    const u = created.json as { user?: { id?: string }; id?: string } | null;
    const id = u?.user?.id ?? u?.id;
    return isIdentityUuid(id)
      ? { ok: true, id }
      : { ok: false, issue: 'identity_user_unresolved' };
  } catch {
    return { ok: false, issue: 'identity_unavailable' };
  }
}

async function reconcileIdentityUser(cfg: AuthConfig, user: AuthSessionUser): Promise<AuthSessionUser> {
  const existing = identityUserIdOf(user);
  if (existing) {
    const { syncIssue: _syncIssue, ...rest } = user;
    return { ...rest, identityUserId: existing };
  }
  const resolved = await upsertIdentityUser(cfg, {
    externalId: googleSubjectOf(user),
    email: user.email,
    name: user.name,
    ...(user.picture ? { picture: user.picture } : {}),
  });
  if (!resolved.ok) {
    const { identityUserId: _identityUserId, ...rest } = user;
    return { ...rest, syncIssue: resolved.issue };
  }
  const { syncIssue: _syncIssue, ...rest } = user;
  return { ...rest, identityUserId: resolved.id };
}

export function authSyncStateOf(user: AuthSessionUser | null): AuthSyncState {
  const identityUserId = identityUserIdOf(user);
  return identityUserId
    ? { syncReady: true, identityUserId, syncIssue: null }
    : {
        syncReady: false,
        identityUserId: null,
        syncIssue: user?.syncIssue ?? (activeAuthConfig?.identityUrl ? 'identity_user_unresolved' : 'identity_not_configured'),
      };
}

/** Reconciles a degraded Google login before a sync operation. */
export async function getMachineIdentityUser(): Promise<AuthSessionUser | null> {
  const user = getMachineUser();
  if (!user) return null;
  // A previously reconciled UUID remains a valid sync identity while the
  // identity service is temporarily unreachable or a daemon restart has not
  // loaded IDENTITY_URL yet.  Never manufacture a provider subject here.
  if (identityUserIdOf(user)) return user;
  if (!activeAuthConfig?.identityUrl) return null;
  if (user.syncIssue && machineUserCache && Date.now() - machineUserCache.at < 10_000) return null;
  const next = await reconcileIdentityUser(activeAuthConfig, user);
  rememberMachineUser(next);
  return identityUserIdOf(next) ? next : null;
}

/* ── registration ── */

export function registerAuthRoutes(
  app: Express,
  cfg: AuthConfig = authConfigFromEnv(),
  opts: { stateDir?: string } = {},
): void {
  const enabled = isAuthEnabled(cfg);
  activeAuthConfig = cfg;
  if (opts.stateDir) {
    machineUserDir = opts.stateDir;
    machineUserCache = null; // re-read from the new location
  }

  // Reported even when disabled so the web UI knows whether to gate itself.
  app.get('/api/auth/config', (_req, res) => {
    res.json({ enabled, provider: 'google' });
  });

  if (!enabled) return;

  // Paths that must stay reachable without a session: the auth surface
  // itself + the health probes the bearer middleware also leaves open.
  const OPEN_PATHS = new Set(['/health', '/version', '/daemon/status']);

  // Read-only content routes consumed by SANDBOXED preview iframes
  // (Origin: null — the browser NEVER attaches cookies there, so a session
  // check can only ever 401 them). The moment login was enabled these
  // broke every preview: dist/screen module imports
  // (`/projects/:id/raw/react/dist/assets/*.js`), prototype pages, pet
  // spritesheets, and skill example images. Mirrors the CORS layer's
  // null-origin GET allowance (server.ts `_NULL_ORIGIN_SAFE_GET_RE`) plus
  // the skill example asset route its iframe loads.
  const IFRAME_SAFE_GET_RE =
    /^\/projects\/[^/]+\/raw\/|^\/codex-pets\/[^/]+\/spritesheet$|^\/skills\/[^/]+\/assets\//;

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/auth/')) return next();
    if (OPEN_PATHS.has(req.path)) return next();
    if (req.method === 'GET' && IFRAME_SAFE_GET_RE.test(req.path)) return next();
    if (!isBrowserRequest(req.headers as Record<string, unknown>)) return next(); // CLI/internal
    const user = verifySession(cfg.sessionSecret, readCookie(req, SESSION_COOKIE));
    if (!user) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Đăng nhập Google để tiếp tục' } });
      return;
    }
    (req as Request & { odSessionUser?: AuthSessionUser }).odSessionUser = user;
    next();
  });

  // Login start — reachable through the CURRENT web origin's /api proxy. The
  // browser origin to RETURN to after Google is taken from the Referer (the
  // web port is dynamic); it rides along inside the state cookie, which is
  // host-scoped and therefore readable by the fixed-port callback listener.
  const googleStart = (req: Request, res: Response) => {
    const state = randomBytes(16).toString('hex');
    let returnOrigin = cfg.appUrl;
    try {
      const ref = req.headers.referer;
      if (typeof ref === 'string' && ref) returnOrigin = new URL(ref).origin;
    } catch {
      /* malformed referer → fallback */
    }
    // Cookies are HOST-scoped: a session set on localhost:<fixed> is invisible
    // to 127.0.0.1:<web>. Normalize the loopback IP to `localhost` so the
    // post-login redirect lands where the cookie actually applies.
    returnOrigin = returnOrigin.replace('://127.0.0.1', '://localhost');
    // Cursor-style handoff: `lr` rides in the state cookie so the callback
    // can park the session on the pending request instead of redirecting.
    const lr = typeof req.query.lr === 'string' && pendingLogins.has(req.query.lr) ? req.query.lr : '';
    setCookie(res, cfg.callbackOrigin, STATE_COOKIE, `${state}|${returnOrigin}|${lr}`, 600);
    const params = new URLSearchParams({
      client_id: cfg.googleClientId,
      redirect_uri: `${cfg.callbackOrigin}/api/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  };

  const googleCallback = async (req: Request, res: Response) => {
    const stateCookie = readCookie(req, STATE_COOKIE) ?? '';
    const [expectState = '', rawOrigin = '', loginRequestId = ''] = stateCookie.split('|');
    const returnOrigin = rawOrigin || cfg.appUrl;
    const fail = (msg: string) =>
      loginRequestId
        ? res.status(400).type('html').send(handoffResultPage(false, msg))
        : res.redirect(`${returnOrigin}/?auth_error=${encodeURIComponent(msg)}`);
    try {
      const { code, state } = req.query as Record<string, string | undefined>;
      if (!code) return fail('Google không trả về code');
      if (!state || !expectState || state !== expectState) return fail('OAuth state không khớp');
      setCookie(res, cfg.callbackOrigin, STATE_COOKIE, '', 0);

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: cfg.googleClientId,
          client_secret: cfg.googleClientSecret,
          redirect_uri: `${cfg.callbackOrigin}/api/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });
      const token = (await tokenRes.json()) as { id_token?: string; error_description?: string };
      if (!tokenRes.ok || !token.id_token) {
        return fail(token.error_description ?? 'Đổi code lấy token thất bại');
      }

      // Server-side id_token verification via Google's tokeninfo endpoint —
      // signature/expiry checked there; we additionally pin the audience.
      const infoRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token.id_token)}`,
      );
      const info = (await infoRes.json()) as {
        aud?: string;
        sub?: string;
        email?: string;
        email_verified?: string;
        name?: string;
        picture?: string;
      };
      if (!infoRes.ok || info.aud !== cfg.googleClientId) return fail('id_token không hợp lệ');
      if (!info.email || info.email_verified !== 'true') return fail('Email Google chưa xác minh');
      if (!emailAllowed(cfg, info.email)) return fail(`Tài khoản ${info.email} không được phép truy cập`);

      const name = info.name || info.email.split('@')[0]!;
      const identity = await upsertIdentityUser(cfg, {
        externalId: info.sub ?? info.email,
        email: info.email,
        name,
        ...(info.picture ? { picture: info.picture } : {}),
      });
      const session: AuthSessionUser = {
        sub: info.sub ?? info.email,
        googleSubject: info.sub ?? '',
        ...(identity.ok ? { identityUserId: identity.id } : { syncIssue: identity.issue }),
        email: info.email,
        name,
        ...(info.picture ? { picture: info.picture } : {}),
        provider: 'google',
      };
      const sessionToken = signSession(cfg.sessionSecret, session);
      rememberMachineUser(session);
      setCookie(res, cfg.callbackOrigin, SESSION_COOKIE, sessionToken, SESSION_TTL_S);
      if (loginRequestId) {
        // Handoff flow: park the session for the polling app and end the
        // browser trip here — "you can close this tab".
        fulfillLoginRequest(loginRequestId, session, sessionToken);
        res.type('html').send(handoffResultPage(true, ''));
        return;
      }
      res.redirect(`${returnOrigin}/`);
    } catch (e) {
      fail(String((e as Error).message));
    }
  };

  app.get('/api/auth/google', googleStart);
  app.get('/api/auth/google/callback', googleCallback);

  // Cursor-style handoff endpoints. Both live under /api/auth/ (open — they
  // are how a session is OBTAINED). The claim response's Set-Cookie travels
  // through the app's own origin, so the session lands on whatever host/port
  // the app runs on (browser tab or Electron webview alike).
  app.post('/api/auth/login-request', (_req, res) => {
    const { requestId, claimSecret } = createLoginRequest();
    res.json({
      requestId,
      claimSecret,
      authUrl: `${cfg.callbackOrigin}/api/auth/google?lr=${requestId}`,
      expiresInS: LOGIN_REQUEST_TTL_MS / 1000,
    });
  });

  app.post('/api/auth/login-request/claim', (req, res) => {
    const { requestId, claimSecret } = (req.body ?? {}) as {
      requestId?: string;
      claimSecret?: string;
    };
    if (!requestId || !claimSecret) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'requestId + claimSecret required' } });
      return;
    }
    const result = claimLoginRequest(requestId, claimSecret);
    if (result.status === 'expired') {
      res.status(410).json({ status: 'expired' });
      return;
    }
    if (result.status === 'forbidden') {
      res.status(403).json({ status: 'forbidden' });
      return;
    }
    if (result.status === 'pending') {
      res.json({ status: 'pending' });
      return;
    }
    setCookie(res, cfg.callbackOrigin, SESSION_COOKIE, result.token, SESSION_TTL_S);
    res.json({ status: 'ok', user: result.user });
  });

  // Dedicated FIXED-port listener for the Google redirect_uri: tools-dev
  // assigns daemon/web ports dynamically per restart, but the redirect_uri
  // registered in the Google Console cannot change. Cookies set here are
  // host-scoped (localhost), so the session is visible to the web UI on any
  // port. If the port is already taken (e.g. the web server itself grabbed
  // it), that owner's /api proxy delivers the same handlers — just warn.
  try {
    const cbUrl = new URL(cfg.callbackOrigin);
    const cbPort = Number(cbUrl.port || (cbUrl.protocol === 'https:' ? 443 : 80));
    const cbApp = express();
    cbApp.get('/api/auth/google', googleStart);
    cbApp.get('/api/auth/google/callback', googleCallback);
    const listener = cbApp.listen(cbPort, '127.0.0.1');
    listener.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(
          `[auth] callback port ${cbPort} already in use — assuming its owner proxies /api to this daemon`,
        );
      } else {
        console.warn('[auth] callback listener error:', err.message);
      }
    });
    listener.unref?.();
  } catch (err) {
    console.warn('[auth] could not start fixed callback listener:', (err as Error).message);
  }

  // Live role lookup from preview-identity (roles are MANAGED in
  // pipeline-studio's /roles UI — this app only displays/consumes them).
  // Not baked into the cookie so an admin's role change applies on the next
  // /me probe instead of surviving 7 days inside a stale token.
  const rolesCache = new Map<string, { at: number; roles: string[] }>();
  const ROLES_TTL_MS = 30_000;
  async function rolesOf(sub: string): Promise<string[]> {
    if (!cfg.identityUrl || sub.startsWith('google:')) return [];
    const hit = rolesCache.get(sub);
    if (hit && Date.now() - hit.at < ROLES_TTL_MS) return hit.roles;
    try {
      const res = await fetch(`${cfg.identityUrl}/api/v1/admin/users/${encodeURIComponent(sub)}/roles`, {
        headers: { 'content-type': 'application/json', 'x-user-id': 'open-design' },
      });
      type RoleRow = { role_name?: string; name?: string; role?: { name?: string } };
      const body = (await res.json().catch(() => null)) as
        | { roles?: RoleRow[] }
        | RoleRow[]
        | null;
      const rows = Array.isArray(body) ? body : body?.roles ?? [];
      // identity's ListUserRoles emits assignment rows with `role_name`;
      // tolerate `name`/`role.name` for older/other deploy shapes.
      const roles = [...new Set(
        rows
          .map((r) => r?.role_name ?? r?.name ?? r?.role?.name ?? '')
          .filter((n): n is string => Boolean(n)),
      )];
      rolesCache.set(sub, { at: Date.now(), roles });
      return roles;
    } catch {
      return hit?.roles ?? []; // identity down → last known (or none)
    }
  }

  app.get('/api/auth/me', async (req, res) => {
    const sessionUser = verifySession(cfg.sessionSecret, readCookie(req, SESSION_COOKIE));
    if (!sessionUser) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'chưa đăng nhập' } });
      return;
    }
    const user = await reconcileIdentityUser(cfg, sessionUser);
    const identityUserId = identityUserIdOf(user);
    if (identityUserId !== identityUserIdOf(sessionUser) || user.syncIssue !== sessionUser.syncIssue) {
      const refreshed = signSession(cfg.sessionSecret, user);
      setCookie(res, cfg.appUrl, SESSION_COOKIE, refreshed, SESSION_TTL_S);
      rememberMachineUser(user);
    }
    res.json({
      user: {
        googleSubject: googleSubjectOf(user),
        email: user.email,
        name: user.name,
        ...(user.picture ? { picture: user.picture } : {}),
        provider: user.provider,
        roles: identityUserId ? await rolesOf(identityUserId) : [],
      },
      ...authSyncStateOf(user),
    });
  });

  app.post('/api/auth/logout', (_req, res) => {
    setCookie(res, cfg.appUrl, SESSION_COOKIE, '', 0);
    res.status(204).end();
  });
}
