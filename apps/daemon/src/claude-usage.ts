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
      cache = { at: Date.now(), value: UNAVAILABLE };
      return UNAVAILABLE;
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
    return value;
  } catch {
    cache = { at: Date.now(), value: UNAVAILABLE };
    return UNAVAILABLE;
  }
}
