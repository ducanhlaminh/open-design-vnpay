/**
 * The quota meter stayed blank for up to a minute AFTER the account switcher
 * had already shown a green "đã đăng nhập" check.
 *
 * Cause: `fetchClaudeUsage` cached the "signed out" verdict for the full 60s
 * TTL. The embedded login writes its credentials a few seconds after the user
 * submits the confirmation code, so any usage read taken inside that window
 * cached "signed out" — and nothing dropped it once the credentials actually
 * landed, leaving the meter hidden long after the login was real.
 *
 * The fix: never cache the signed-out verdict. It is the one answer that can be
 * invalidated by something outside this process (the user finishing `/login`),
 * and the cache buys nothing there — the meter is the only caller and it polls
 * once a minute anyway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchClaudeUsage, invalidateClaudeUsageCache } from '../src/claude-usage.js';

const OAUTH_BLOB = JSON.stringify({
  claudeAiOauth: { accessToken: 'sk-ant-oat01-live', subscriptionType: 'max' },
});

const USAGE_PAYLOAD = {
  five_hour: { utilization: 12, resets_at: '2026-07-29T12:00:00Z' },
  seven_day: { utilization: 40, resets_at: '2026-08-02T12:00:00Z' },
};

let usageCalls = 0;

beforeEach(() => {
  usageCalls = 0;
  invalidateClaudeUsageCache();
  vi.stubGlobal('fetch', async () => {
    usageCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => USAGE_PAYLOAD,
    } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateClaudeUsageCache();
});

describe('fetchClaudeUsage caching', () => {
  it('shows the quota as soon as credentials land, even right after a signed-out read', async () => {
    // The read that happens while the login is still exchanging its code.
    let credentials: string | null = null;
    const opts = { sandboxOnly: true, sandboxCreds: async () => credentials };

    const whileLoggingIn = await fetchClaudeUsage(opts);
    expect(whileLoggingIn.available).toBe(false);

    // Credentials land a couple of seconds later — well inside the 60s TTL.
    credentials = OAUTH_BLOB;

    const afterLogin = await fetchClaudeUsage(opts);
    expect(afterLogin.available).toBe(true);
    expect(afterLogin.fiveHour.utilization).toBe(12);
    expect(afterLogin.sevenDay.utilization).toBe(40);
    expect(afterLogin.subscriptionType).toBe('max');
  });

  it('still caches a successful reading so the endpoint is not hammered', async () => {
    const opts = { sandboxOnly: true, sandboxCreds: async () => OAUTH_BLOB };

    const first = await fetchClaudeUsage(opts);
    const second = await fetchClaudeUsage(opts);

    expect(first.available).toBe(true);
    expect(second).toEqual(first);
    expect(usageCalls).toBe(1);
  });

  it('re-reads credentials after an explicit invalidation (account switch)', async () => {
    const opts = { sandboxOnly: true, sandboxCreds: async () => OAUTH_BLOB };
    await fetchClaudeUsage(opts);
    expect(usageCalls).toBe(1);

    invalidateClaudeUsageCache();
    await fetchClaudeUsage(opts);
    expect(usageCalls).toBe(2);
  });
});

describe('fetchClaudeUsage reasons (why the meter is unavailable)', () => {
  it('names the sandbox volume when the sandbox owns Claude and holds no login', async () => {
    const out = await fetchClaudeUsage({ sandboxOnly: true, sandboxCreds: async () => null });
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/od-claude-auth/);
  });

  it('401/403 → reason says the token was refused and to log in again', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response);
    const out = await fetchClaudeUsage({ sandboxOnly: true, sandboxCreds: async () => OAUTH_BLOB });
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/HTTP 401/);
    expect(out.reason).toMatch(/đăng nhập lại/);
  });

  it('429 → reason says Anthropic is rate-limiting, not that the user is signed out', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response);
    const out = await fetchClaudeUsage({ sandboxOnly: true, sandboxCreds: async () => OAUTH_BLOB });
    expect(out.reason).toMatch(/HTTP 429/);
  });

  it('TLS verification failure (corporate inspection) → reason names the cert error and the CA hint', async () => {
    vi.stubGlobal('fetch', async () => {
      const err = new TypeError('fetch failed') as TypeError & { cause?: unknown };
      err.cause = Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
      throw err;
    });
    const out = await fetchClaudeUsage({ sandboxOnly: true, sandboxCreds: async () => OAUTH_BLOB });
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
    expect(out.reason).toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  it('DNS failure → reason names the code', async () => {
    vi.stubGlobal('fetch', async () => {
      const err = new TypeError('fetch failed') as TypeError & { cause?: unknown };
      err.cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' });
      throw err;
    });
    const out = await fetchClaudeUsage({ sandboxOnly: true, sandboxCreds: async () => OAUTH_BLOB });
    expect(out.reason).toMatch(/ENOTFOUND/);
  });

  it('5xx with no earlier good reading → reason names the HTTP status', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response);
    const out = await fetchClaudeUsage({ sandboxOnly: true, sandboxCreds: async () => OAUTH_BLOB });
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/HTTP 503/);
  });
});
