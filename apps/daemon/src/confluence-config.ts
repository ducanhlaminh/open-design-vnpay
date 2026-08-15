// Confluence credential storage — independent of the generic external-MCP
// config (mcp-config.ts, which serves OTHER MCP servers like GitHub,
// Filesystem, image-gen… and must stay untouched by this file). WP8 removed
// the `mcp-atlassian` MCP server + the legacy JIRA agent path; the docs/
// prd-docs/dr-docs stages now only fetch Confluence, deterministically
// (no agent), via the creds this module resolves.
//
// Storage: <dataDir>/confluence-config.json holding either `{ base, token }`
// or `null`. Mirrors mcp-config.ts's atomic write-then-rename pattern
// (mkdir -> write tmp -> rename) so a crash mid-write never corrupts the
// file.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { readMcpConfig } from './mcp-config.js';

export type ConfluenceConfig = { base: string; token: string } | null;

function configFile(dataDir: string): string {
  return path.join(dataDir, 'confluence-config.json');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function sanitizeConfluenceConfig(raw: unknown): ConfluenceConfig {
  if (!isPlainObject(raw)) return null;
  const base = typeof raw.base === 'string' ? raw.base.trim().replace(/\/+$/, '') : '';
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  return base && token ? { base, token } : null;
}

/** Read the file as-is (no migration, no write) — used both by the public
 *  `readConfluenceConfig` and by `doWrite`'s "keep the existing token" fallback,
 *  which must never re-enter `writeConfluenceConfig`'s own lock. */
async function readRaw(dataDir: string): Promise<ConfluenceConfig> {
  try {
    const raw = await readFile(configFile(dataDir), 'utf8');
    return sanitizeConfluenceConfig(JSON.parse(raw));
  } catch (err: unknown) {
    const e = err as { code?: string; name?: string; message?: string };
    if (e.code === 'ENOENT') return null;
    if (e.name === 'SyntaxError') {
      console.error('[confluence-config] Corrupted JSON, treating as unset:', e.message);
      return null;
    }
    throw err;
  }
}

/** One-time migration: when confluence-config.json has never been written but
 *  mcp-config.json still carries a `mcp-atlassian` (or any `/atlassian/i`)
 *  row with a usable Confluence PAT, copy it over so upgrading past WP8
 *  never forces a re-type of a credential that was already entered once. */
async function migrateFromMcpConfig(dataDir: string): Promise<ConfluenceConfig> {
  try {
    const mcpCfg = await readMcpConfig(dataDir);
    const server =
      mcpCfg.servers.find((s) => s.id === 'mcp-atlassian') ??
      mcpCfg.servers.find((s) => /atlassian/i.test(s.id) || /atlassian/i.test(s.label ?? ''));
    const env = (server?.env ?? {}) as Record<string, string>;
    const legacy = sanitizeConfluenceConfig({
      base: env.CONFLUENCE_URL,
      token: env.CONFLUENCE_PERSONAL_TOKEN,
    });
    if (!legacy) return null;
    await writeConfluenceConfig(dataDir, legacy);
    console.log(
      '[confluence-config] migrated Confluence credential from mcp-config.json (mcp-atlassian row) to confluence-config.json',
    );
    return legacy;
  } catch (err) {
    console.warn('[confluence-config] migration from mcp-config.json failed (continuing without it):', err);
    return null;
  }
}

/** Read the saved Confluence credential, migrating once from the legacy
 *  `mcp-atlassian` MCP row when confluence-config.json doesn't exist yet. */
export async function readConfluenceConfig(dataDir: string): Promise<ConfluenceConfig> {
  let fileExists = true;
  try {
    await readFile(configFile(dataDir), 'utf8');
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === 'ENOENT') fileExists = false;
  }
  if (!fileExists) return migrateFromMcpConfig(dataDir);
  return readRaw(dataDir);
}

const writeLocks = new Map<string, Promise<unknown>>();

/** Write the Confluence credential. `body.token` empty/omitted keeps the
 *  previously saved token (the UI never round-trips the real value back from
 *  GET, so an unedited token field must not clobber it). Both fields empty
 *  clears the credential (writes `null`). */
export async function writeConfluenceConfig(dataDir: string, body: unknown): Promise<ConfluenceConfig> {
  const prev = writeLocks.get(dataDir) ?? Promise.resolve();
  const task = prev.catch(() => {}).then(() => doWrite(dataDir, body));
  writeLocks.set(dataDir, task);
  try {
    return await task;
  } finally {
    if (writeLocks.get(dataDir) === task) writeLocks.delete(dataDir);
  }
}

const TEST_TIMEOUT_MS = 12_000;

function normalizeBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export interface ConfluenceTestResult {
  ok: boolean;
  detail?: string;
  displayName?: string;
}

/** Live probe used by the Settings "Test connection" button — hits
 *  Confluence's own `/rest/api/user/current` (the standard lightweight
 *  who-am-I endpoint on both Server/Data Center) with whatever base/token
 *  the caller supplies, falling back to the already-saved token when the
 *  request omits one (so a returning user can re-test without retyping it).
 *  Never throws — every outcome (bad creds, unreachable host, timeout)
 *  comes back as `{ ok: false, detail }` for the UI to render directly. */
export async function testConfluenceConnection(dataDir: string, body: unknown): Promise<ConfluenceTestResult> {
  const raw = isPlainObject(body) ? body : {};
  const base = normalizeBase(typeof raw.base === 'string' ? raw.base : '');
  const incomingToken = typeof raw.token === 'string' ? raw.token.trim() : '';
  const token = incomingToken || (await readRaw(dataDir))?.token || '';
  if (!base || !token) {
    return { ok: false, detail: 'Cần nhập Base URL và Personal Access Token trước khi test.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/rest/api/user/current`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `Token không hợp lệ hoặc đã hết hạn (HTTP ${res.status}).` };
    }
    if (!res.ok) {
      return { ok: false, detail: `Confluence trả về lỗi HTTP ${res.status}.` };
    }
    let displayName: string | undefined;
    try {
      const data = JSON.parse(await res.text()) as { displayName?: string; username?: string };
      displayName = data.displayName || data.username || undefined;
    } catch {
      /* connection + auth already succeeded even if the body isn't the expected shape */
    }
    return { ok: true, ...(displayName ? { displayName } : {}) };
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      return { ok: false, detail: 'Hết thời gian chờ phản hồi từ Confluence.' };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `Không thể kết nối tới ${base}: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function doWrite(dataDir: string, body: unknown): Promise<ConfluenceConfig> {
  const raw = isPlainObject(body) ? body : {};
  const base = typeof raw.base === 'string' ? raw.base.trim().replace(/\/+$/, '') : '';
  const incomingToken = typeof raw.token === 'string' ? raw.token.trim() : '';
  const token = incomingToken || (await readRaw(dataDir))?.token || '';
  const next: ConfluenceConfig = base && token ? { base, token } : null;
  const file = configFile(dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp';
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await rename(tmp, file);
  return next;
}
