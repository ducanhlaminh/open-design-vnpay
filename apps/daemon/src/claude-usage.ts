// Claude account usage — reads the Claude Code OAuth token and calls
// Anthropic's usage endpoint (the source behind Claude Code's `/usage`) to
// report how much of the rolling 5-hour and 7-day subscription limits has been
// consumed. Account-level quota %, not token counting.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeUsageResponse } from '@open-design/contracts';

const execFileP = promisify(execFile);
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CACHE_TTL_MS = 60_000;

interface OAuthBlob {
  accessToken?: string;
  subscriptionType?: string;
}

function parseOAuth(raw: string): OAuthBlob | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const inner = (j.claudeAiOauth ?? j) as OAuthBlob;
    if (inner && typeof inner.accessToken === 'string' && inner.accessToken) return inner;
  } catch {
    /* not JSON */
  }
  return null;
}

/** Read the Claude Code OAuth blob from the macOS Keychain, then fall back to
 *  the plaintext credentials file used on Linux / some installs. */
async function readOAuth(): Promise<OAuthBlob | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP('security', [
        'find-generic-password',
        '-w',
        '-s',
        KEYCHAIN_SERVICE,
      ]);
      const blob = parseOAuth(stdout.trim());
      if (blob) return blob;
    } catch {
      /* not in keychain — try the file */
    }
  }
  try {
    const p = path.join(os.homedir(), '.claude', '.credentials.json');
    const blob = parseOAuth(await fs.promises.readFile(p, 'utf8'));
    if (blob) return blob;
  } catch {
    /* no file */
  }
  return null;
}

const UNAVAILABLE: ClaudeUsageResponse = {
  available: false,
  fiveHour: { utilization: null, resetsAt: null },
  sevenDay: { utilization: null, resetsAt: null },
  subscriptionType: null,
};

let cache: { at: number; value: ClaudeUsageResponse } | null = null;
// Last successful reading. Kept so a TRANSIENT failure (HTTP 429 rate limit,
// 5xx, network blip) doesn't blank the quota meter — the token is still valid,
// the endpoint just refused this one call. Cleared on switch (different account)
// and on a definitive auth failure (401/403 = token dead).
let lastAvailable: ClaudeUsageResponse | null = null;

/** Drop the cached usage so the NEXT fetch re-reads the (possibly switched)
 *  credentials — called after `od sandbox account switch` so the quota meter
 *  reflects the new account instead of the previous one for up to a minute. */
export function invalidateClaudeUsageCache(): void {
  cache = null;
  lastAvailable = null;
}

function pctOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}
function isoOf(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Fetch Claude account usage, cached ~60s to avoid hammering the endpoint.
 *  `sandboxCreds` is an optional fallback that returns the raw credentials JSON
 *  from the Docker sandbox auth volume — used when the sandbox owns Claude runs
 *  (Windows / Docker-only), where the token is NOT on the host keychain/file. */
export async function fetchClaudeUsage(opts?: {
  /** Reads the raw credentials JSON out of the Docker sandbox auth volume. */
  sandboxCreds?: () => Promise<string | null>;
  /** True when the sandbox OWNS Claude runs (Docker-only): read the token ONLY
   *  from the sandbox volume, never the host — otherwise the meter would show
   *  the host account's quota, which is not what this app actually spends. Not
   *  logged into the sandbox → unavailable (meter hidden). */
  sandboxOnly?: boolean;
}): Promise<ClaudeUsageResponse> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  let oauth: OAuthBlob | null = null;
  if (opts?.sandboxOnly) {
    const raw = opts.sandboxCreds ? await opts.sandboxCreds().catch(() => null) : null;
    if (raw) oauth = parseOAuth(raw);
  } else {
    oauth = await readOAuth();
    if (!oauth?.accessToken && opts?.sandboxCreds) {
      const raw = await opts.sandboxCreds().catch(() => null);
      if (raw) oauth = parseOAuth(raw);
    }
  }
  if (!oauth?.accessToken) {
    cache = { at: Date.now(), value: UNAVAILABLE };
    return UNAVAILABLE;
  }
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'claude-cli',
      },
    });
    if (!res.ok) {
      // 401/403 = token actually dead → blank the meter (and forget the stale
      // reading). 429/5xx = transient → keep showing the last good reading so a
      // rate-limit blip doesn't make the quota vanish for a minute.
      if (res.status === 401 || res.status === 403) lastAvailable = null;
      const value = lastAvailable ?? UNAVAILABLE;
      cache = { at: Date.now(), value };
      return value;
    }
    const d = (await res.json()) as Record<string, Record<string, unknown>>;
    const value: ClaudeUsageResponse = {
      available: true,
      fiveHour: {
        utilization: pctOf(d.five_hour?.utilization),
        resetsAt: isoOf(d.five_hour?.resets_at),
      },
      sevenDay: {
        utilization: pctOf(d.seven_day?.utilization),
        resetsAt: isoOf(d.seven_day?.resets_at),
      },
      subscriptionType: oauth.subscriptionType ?? null,
    };
    cache = { at: Date.now(), value };
    lastAvailable = value;
    return value;
  } catch {
    // Network blip — transient, keep the last good reading rather than blanking.
    const value = lastAvailable ?? UNAVAILABLE;
    cache = { at: Date.now(), value };
    return value;
  }
}

/** Probe a raw Claude credentials JSON against the usage endpoint to tell if its
 *  OAuth token is still valid. NOT cached — used per-account by the account
 *  status check. 401/403 → the token was revoked/expired (e.g. password change). */
export async function probeClaudeCredentials(raw: string): Promise<{ ok: boolean; error?: string }> {
  const oauth = parseOAuth(raw);
  if (!oauth?.accessToken) return { ok: false, error: 'Không đọc được token trong credentials' };
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'claude-cli',
      },
    });
    if (res.ok) return { ok: true };
    // ONLY 401/403 means the token was rejected (revoked/expired). 429 (rate
    // limited), 5xx, etc. are inconclusive — the token wasn't refused, so DON'T
    // flag the account dead (that turned a rate-limit into a false red).
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `HTTP ${res.status} — token hết hạn / bị thu hồi (đăng nhập lại)` };
    }
    return { ok: true };
  } catch {
    // Network/transient failure — can't prove the token is dead, so leave it be.
    return { ok: true };
  }
}
