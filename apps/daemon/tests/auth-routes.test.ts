import { describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import {
  authConfigFromEnv,
  claimLoginRequest,
  createLoginRequest,
  emailAllowed,
  fulfillLoginRequest,
  getMachineUser,
  isAuthEnabled,
  isBrowserRequest,
  registerAuthRoutes,
  signSession,
  verifySession,
  type AuthConfig,
  type AuthSessionUser,
} from '../src/auth-routes.js';

const USER: AuthSessionUser = {
  sub: 'usr_1',
  email: 'dev@vnpay.vn',
  name: 'Dev',
  provider: 'google',
};

const cfg = (over: Partial<AuthConfig> = {}): AuthConfig => ({
  sessionSecret: 's3cret',
  googleClientId: 'cid',
  googleClientSecret: 'csec',
  appUrl: 'http://localhost:52564',
  // Port 0 → the fixed-callback listener binds an ephemeral port in tests.
  callbackOrigin: 'http://127.0.0.1:0',
  identityUrl: '',
  domainLock: false,
  allowedEmails: [],
  allowedDomains: [],
  ...over,
});

describe('session token', () => {
  it('signs and verifies a round-trip', () => {
    const token = signSession('s3cret', USER);
    expect(verifySession('s3cret', token)).toMatchObject({ sub: 'usr_1', email: 'dev@vnpay.vn' });
  });

  it('rejects tampered payloads and wrong secrets', () => {
    const token = signSession('s3cret', USER);
    expect(verifySession('other', token)).toBeNull();
    const [payload, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...USER, sub: 'usr_evil', exp: Math.floor(Date.now() / 1000) + 999 }),
    ).toString('base64url');
    expect(verifySession('s3cret', `${forged}.${sig}`)).toBeNull();
    expect(verifySession('s3cret', payload)).toBeNull(); // no signature part
  });

  it('rejects expired sessions', () => {
    const token = signSession('s3cret', USER, Date.now() - 8 * 24 * 60 * 60 * 1000);
    expect(verifySession('s3cret', token)).toBeNull();
  });
});

describe('config + allowlists', () => {
  it('is disabled unless secret + google client are all present', () => {
    expect(isAuthEnabled(cfg())).toBe(true);
    expect(isAuthEnabled(cfg({ sessionSecret: '' }))).toBe(false);
    expect(isAuthEnabled(cfg({ googleClientId: '' }))).toBe(false);
    expect(
      isAuthEnabled(authConfigFromEnv({ SESSION_SECRET: 'x' } as NodeJS.ProcessEnv)),
    ).toBe(false);
  });

  it('emailAllowed: lock OFF allows everyone regardless of lists', () => {
    expect(emailAllowed(cfg(), 'anyone@example.com')).toBe(true);
    expect(
      emailAllowed(cfg({ allowedDomains: ['vnpay.vn'] }), 'anyone@example.com'),
    ).toBe(true); // lists ignored while the switch is off
  });

  it('emailAllowed: lock ON enforces lists and fails closed when empty', () => {
    const gated = cfg({
      domainLock: true,
      allowedDomains: ['vnpay.vn'],
      allowedEmails: ['guest@example.com'],
    });
    expect(emailAllowed(gated, 'Dev@VNPAY.vn')).toBe(true);
    expect(emailAllowed(gated, 'guest@example.com')).toBe(true);
    expect(emailAllowed(gated, 'evil@example.com')).toBe(false);
    // lock on + no lists → nobody passes (misconfig must not open the door)
    expect(emailAllowed(cfg({ domainLock: true }), 'dev@vnpay.vn')).toBe(false);
  });
});

describe('browser-request heuristic', () => {
  it('flags Sec-Fetch-Dest/Site + Origin/Referer, passes CLI/undici requests', () => {
    expect(isBrowserRequest({ 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' })).toBe(true);
    expect(isBrowserRequest({ 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(isBrowserRequest({ origin: 'http://localhost:52564' })).toBe(true);
    expect(isBrowserRequest({ referer: 'http://localhost:52564/' })).toBe(true);
    // Node's undici fetch sends ONLY sec-fetch-mode — must NOT be gated (the
    // `od` CLI would break otherwise).
    expect(isBrowserRequest({ 'sec-fetch-mode': 'cors', 'user-agent': 'node' })).toBe(false);
    expect(isBrowserRequest({})).toBe(false);
  });
});

describe('login handoff (Cursor-style request → fulfill → claim)', () => {
  it('walks the full lifecycle and is one-shot', () => {
    const { requestId, claimSecret } = createLoginRequest();
    expect(claimLoginRequest(requestId, claimSecret)).toEqual({ status: 'pending' });
    expect(claimLoginRequest(requestId, 'wrong')).toEqual({ status: 'forbidden' });

    const token = signSession('s3cret', USER);
    expect(fulfillLoginRequest(requestId, USER, token)).toBe(true);
    const claimed = claimLoginRequest(requestId, claimSecret);
    expect(claimed).toMatchObject({ status: 'ok', token, user: { email: USER.email } });
    // one-shot: a second claim (replay) is gone
    expect(claimLoginRequest(requestId, claimSecret)).toEqual({ status: 'expired' });
    expect(fulfillLoginRequest('nope', USER, token)).toBe(false);
  });

  it('expires stale requests at claim time', () => {
    const now = Date.now();
    const { requestId, claimSecret } = createLoginRequest(now);
    expect(claimLoginRequest(requestId, claimSecret, now + 11 * 60_000)).toEqual({
      status: 'expired',
    });
  });

  it('HTTP surface: create → claim pending → fulfilled claim sets the session cookie', async () => {
    const app = express();
    app.use(express.json());
    registerAuthRoutes(app, cfg());
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const created = await fetch(`${base}/api/auth/login-request`, { method: 'POST' });
      expect(created.status).toBe(200);
      const { requestId, claimSecret, authUrl } = (await created.json()) as {
        requestId: string;
        claimSecret: string;
        authUrl: string;
      };
      expect(authUrl).toContain(`/api/auth/google?lr=${requestId}`);

      const claim = (body: object) =>
        fetch(`${base}/api/auth/login-request/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      const pending = await claim({ requestId, claimSecret });
      expect(await pending.json()).toEqual({ status: 'pending' });

      fulfillLoginRequest(requestId, USER, signSession('s3cret', USER));
      const ok = await claim({ requestId, claimSecret });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('set-cookie')).toContain('od_session=');
      expect(await ok.json()).toMatchObject({ status: 'ok', user: { email: USER.email } });

      const replay = await claim({ requestId, claimSecret });
      expect(replay.status).toBe(410);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('machine user (attribution identity)', () => {
  it('reads the persisted auth-user.json once a stateDir is registered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-auth-'));
    writeFileSync(
      join(dir, 'auth-user.json'),
      JSON.stringify({ sub: 'usr_9', email: 'anhnd13@vnpay.vn', name: 'Anh', at: 'x' }),
    );
    const app = express();
    registerAuthRoutes(app, cfg(), { stateDir: dir });
    expect(getMachineUser()).toMatchObject({ sub: 'usr_9', email: 'anhnd13@vnpay.vn' });
  });
});

describe('gate middleware (integration)', () => {
  async function withApp(
    authCfg: AuthConfig,
    run: (base: string) => Promise<void>,
  ): Promise<void> {
    const app = express();
    registerAuthRoutes(app, authCfg);
    app.get('/api/projects', (_req, res) => res.json({ ok: true }));
    app.get(/^\/api\/projects\/([^/]+)\/raw\/(.+)$/u, (_req, res) => res.json({ ok: true }));
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  it('disabled config → no gate, /api/auth/config reports enabled:false', async () => {
    await withApp(cfg({ sessionSecret: '' }), async (base) => {
      const conf = await fetch(`${base}/api/auth/config`);
      expect(await conf.json()).toMatchObject({ enabled: false });
      const r = await fetch(`${base}/api/projects`, {
        headers: { 'sec-fetch-dest': 'empty' },
      });
      expect(r.status).toBe(200);
    });
  });

  it('enabled → browser without session 401s, CLI passes, cookie passes', async () => {
    await withApp(cfg(), async (base) => {
      const browser = await fetch(`${base}/api/projects`, {
        headers: { 'sec-fetch-dest': 'empty' },
      });
      expect(browser.status).toBe(401);

      const cli = await fetch(`${base}/api/projects`);
      expect(cli.status).toBe(200);

      const token = signSession('s3cret', USER);
      const authed = await fetch(`${base}/api/projects`, {
        headers: { 'sec-fetch-mode': 'cors', cookie: `od_session=${encodeURIComponent(token)}` },
      });
      expect(authed.status).toBe(200);

      const me = await fetch(`${base}/api/auth/me`, {
        headers: { cookie: `od_session=${encodeURIComponent(token)}` },
      });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ user: { email: 'dev@vnpay.vn' } });
    });
  });

  it('iframe-safe read-only GETs stay open: sandboxed previews never send cookies (issue: 401 on dist/screen assets)', async () => {
    await withApp(cfg(), async (base) => {
      // A dist/screen module import fetched from a sandboxed iframe: browser
      // request (Origin: null → sec-fetch headers present) with NO cookie.
      const asset = await fetch(
        `${base}/api/projects/TEST/raw/docs-to-ui/react/dist/assets/chunk.js`,
        { headers: { 'sec-fetch-dest': 'script', origin: 'null' } },
      );
      expect(asset.status).toBe(200);
      // Only GET is exempt — a browser DELETE on the same path still needs a session.
      const del = await fetch(
        `${base}/api/projects/TEST/raw/docs-to-ui/react/dist/assets/chunk.js`,
        { method: 'DELETE', headers: { 'sec-fetch-dest': 'empty', origin: 'null' } },
      );
      expect(del.status).toBe(401);
    });
  });

  it('auth surface + health probes stay open for browsers', async () => {
    await withApp(cfg(), async (base) => {
      const conf = await fetch(`${base}/api/auth/config`, {
        headers: { 'sec-fetch-dest': 'empty' },
      });
      expect(conf.status).toBe(200);
      const me = await fetch(`${base}/api/auth/me`, {
        headers: { 'sec-fetch-dest': 'empty' },
      });
      expect(me.status).toBe(401); // open route, but reports unauthenticated
      const redirect = await fetch(`${base}/api/auth/google`, {
        headers: { 'sec-fetch-dest': 'document', referer: 'http://localhost:59999/' },
        redirect: 'manual',
      });
      expect(redirect.status).toBe(302);
      const loc = redirect.headers.get('location') ?? '';
      expect(loc).toContain('accounts.google.com');
      // redirect_uri pins the FIXED callback origin, not the dynamic web port.
      expect(loc).toContain(encodeURIComponent('http://127.0.0.1:0/api/auth/google/callback'));
      // The state cookie carries the RETURN origin (from Referer) for the
      // callback listener to bounce the browser back to the right web port.
      const cookie = redirect.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(encodeURIComponent('|http://localhost:59999'));
    });
  });
});
