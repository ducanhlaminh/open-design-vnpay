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
const FETCH_TIMEOUT_MS = 15_000;

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

/** Where Claude Code keeps `.credentials.json` — honours CLAUDE_CONFIG_DIR
 *  exactly like `probeClaudeAuthStatus` does, so the meter and the login badge
 *  never disagree about which login they are looking at. */
function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override && override.trim() ? override.trim() : path.join(os.homedir(), '.claude');
}

/** Time-box for `security find-generic-password -w`. When the Keychain item's
 *  ACL does not trust `security`, macOS shows an "allow access?" dialog and the
 *  command blocks until the user answers — from a launchd daemon that dialog
 *  can sit unanswered forever, which used to leave the meter on "Đang đọc…"
 *  with no way to see why. */
const KEYCHAIN_TIMEOUT_MS = 8_000;

type OAuthRead =
  | { oauth: OAuthBlob; reason?: undefined }
  | { oauth: null; reason: string };

/** Read the Claude Code OAuth blob from the macOS Keychain, then fall back to
 *  the plaintext credentials file used on Linux / Windows / some installs.
 *  Always explains a miss so the meter can say WHY instead of just hiding. */
async function readOAuth(): Promise<OAuthRead> {
  const notes: string[] = [];
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP('security', [
        'find-generic-password',
        '-w',
        '-s',
        KEYCHAIN_SERVICE,
      ], { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 256 * 1024 });
      const blob = parseOAuth(stdout.trim());
      if (blob) return { oauth: blob };
      notes.push('Keychain có mục "Claude Code-credentials" nhưng nội dung không đọc được như JSON.');
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: string | number; stderr?: string };
      if (e?.killed || e?.signal === 'SIGTERM') {
        notes.push('macOS Keychain chưa cho phép đọc mục "Claude Code-credentials" (hộp thoại xin quyền chưa được trả lời — chọn "Always Allow").');
      } else if (e?.code === 'ENOENT') {
        notes.push('Không tìm thấy lệnh `security` của macOS.');
      } else if (typeof e?.code === 'number' && e.code === 44) {
        notes.push('Keychain không có mục "Claude Code-credentials".');
      } else if (typeof e?.code === 'number' && (e.code === 51 || e.code === 128)) {
        notes.push('macOS Keychain từ chối cho đọc mục "Claude Code-credentials" (bạn đã bấm Deny? — xoá quyền trong Keychain Access hoặc đăng nhập lại `claude`).');
      } else {
        const detail = (e?.stderr ?? e?.message ?? '').toString().trim().split('\n')[0];
        notes.push(`Không đọc được Keychain (${detail || 'lỗi không rõ'}).`);
      }
    }
  }
  const credentialsPath = path.join(claudeConfigDir(), '.credentials.json');
  try {
    const blob = parseOAuth(await fs.promises.readFile(credentialsPath, 'utf8'));
    if (blob) return { oauth: blob };
    notes.push(`${credentialsPath} không chứa accessToken (đăng nhập dở dang?).`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      notes.push(`Không có ${credentialsPath}.`);
    } else {
      notes.push(`Không đọc được ${credentialsPath} (${(err as Error)?.message ?? 'lỗi'}).`);
    }
  }
  return {
    oauth: null,
    reason: `Chưa tìm thấy đăng nhập Claude CLI trên máy này — chạy \`claude\` rồi \`/login\`. ${notes.join(' ')}`.trim(),
  };
}

/** Human-readable reason for a fetch() failure against the usage endpoint —
 *  corporate TLS inspection / proxy / offline all land here, and the bare
 *  Node error code is the one thing support needs to see. */
function describeFetchError(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string; message?: string }; message?: string; name?: string };
  const code = e?.cause?.code ?? e?.code ?? '';
  const message = e?.cause?.message ?? e?.message ?? String(err);
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return 'Gọi api.anthropic.com quá thời gian chờ (mạng chậm hoặc bị chặn).';
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|SSL|TLS/i.test(code) || /certificate/i.test(message)) {
    return `Không xác minh được chứng chỉ TLS của api.anthropic.com (${code || message}). Mạng công ty đang chặn/inspect TLS — cần cấu hình proxy hoặc NODE_EXTRA_CA_CERTS cho Open Design.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return `Không phân giải được tên miền api.anthropic.com (${code}) — kiểm tra DNS/mạng.`;
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(code)) {
    return `Không kết nối được api.anthropic.com (${code}) — kiểm tra mạng/proxy/tường lửa.`;
  }
  return `Không gọi được api.anthropic.com: ${code ? `${code} — ` : ''}${message}`;
}

const UNAVAILABLE: ClaudeUsageResponse = {
  available: false,
  fiveHour: { utilization: null, resetsAt: null },
  sevenDay: { utilization: null, resetsAt: null },
  subscriptionType: null,
};

function unavailable(reason: string): ClaudeUsageResponse {
  return { ...UNAVAILABLE, reason };
}

/** Auth that Claude Code resolves from the environment (API key / Bedrock /
 *  Vertex) has no subscription quota to show — the meter must say so rather
 *  than "signed out". Mirrors the env checks in `probeClaudeAuthStatus`. */
function envAuthReason(): string | null {
  const has = (k: string) => typeof process.env[k] === 'string' && process.env[k]!.trim() !== '';
  if (has('CLAUDE_CODE_USE_BEDROCK')) return 'Claude đang chạy qua Amazon Bedrock — không có hạn mức gói Claude để hiển thị.';
  if (has('CLAUDE_CODE_USE_VERTEX')) return 'Claude đang chạy qua Google Vertex — không có hạn mức gói Claude để hiển thị.';
  if (has('ANTHROPIC_API_KEY') && has('ANTHROPIC_BASE_URL')) return 'Claude đang xác thực bằng ANTHROPIC_API_KEY qua endpoint tuỳ chỉnh — không có hạn mức gói Claude để hiển thị.';
  return null;
}

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
  let missReason: string;
  if (opts?.sandboxOnly) {
    const raw = opts.sandboxCreds ? await opts.sandboxCreds().catch(() => null) : null;
    if (raw) oauth = parseOAuth(raw);
    missReason = 'Docker sandbox đang sở hữu Claude nhưng volume od-claude-auth chưa có đăng nhập — đăng nhập Claude trong Cài đặt → Sandbox.';
  } else {
    const read = await readOAuth();
    oauth = read.oauth;
    missReason = read.reason ?? '';
    if (!oauth?.accessToken && opts?.sandboxCreds) {
      const raw = await opts.sandboxCreds().catch(() => null);
      if (raw) oauth = parseOAuth(raw);
    }
  }
  if (!oauth?.accessToken) {
    // Deliberately NOT cached. "Signed out" is the one verdict that can be
    // invalidated by something outside this process (the user finishing
    // `/login`), and caching it means a reading taken seconds before the
    // credentials land keeps the meter hidden for a further minute after the
    // account switcher already shows a green check. The cache exists to spare
    // the network/docker read under load, but the meter is the only caller and
    // it polls once a minute, so there is no load to spare here.
    return unavailable(envAuthReason() ?? missReason);
  }
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'claude-cli',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 401/403 = token actually dead → blank the meter (and forget the stale
      // reading). 429/5xx = transient → keep showing the last good reading so a
      // rate-limit blip doesn't make the quota vanish for a minute.
      if (res.status === 401 || res.status === 403) lastAvailable = null;
      const reason = res.status === 401 || res.status === 403
        ? `Anthropic từ chối token (HTTP ${res.status}) — token hết hạn hoặc bị thu hồi, đăng nhập lại \`claude\`.`
        : res.status === 429
          ? 'Anthropic đang tạm chặn đọc mức dùng (HTTP 429) — thử lại sau một lát.'
          : `Anthropic trả về HTTP ${res.status} khi đọc mức dùng — thử lại sau.`;
      const value = lastAvailable ?? unavailable(reason);
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
  } catch (err) {
    // Network blip — transient, keep the last good reading rather than blanking.
    const value = lastAvailable ?? unavailable(describeFetchError(err));
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
