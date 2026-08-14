import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { execAgentFile } from './invocation.js';
import type { RuntimeEnv } from './types.js';

const execFileAsync = promisify(execFile);

export type AgentAuthProbeResult = {
  status: 'ok' | 'missing' | 'unknown';
  message?: string;
  // Output captured from the probe child process (e.g.
  // `cursor-agent status`). Exposed so callers like the connection
  // test layer can fold the probe's own stderr/exit context into their
  // structured diagnostics — the probe runs before the smoke spawn,
  // so without this the diagnostics block would otherwise drop the
  // probe output entirely.
  stdoutTail?: string;
  stderrTail?: string;
  exitCode?: number | null;
  signal?: string | null;
};

const CURSOR_AUTH_GUIDANCE =
  'Cursor Agent is not authenticated. Run `cursor-agent login`, then `cursor-agent status`, and retry. For automation, ensure CURSOR_API_KEY is set in the Open Design process environment.';

const DEEPSEEK_AUTH_GUIDANCE =
  'DeepSeek TUI is installed but is not authenticated. Add or verify your API key in `~/.deepseek/config.toml` as `api_key = "..."`, or expose DEEPSEEK_API_KEY to the Open Design daemon process, then retry. If Open Design is launched outside an interactive shell, shell rc files such as ~/.zshrc may not be loaded.';

export function cursorAuthGuidance(): string {
  return CURSOR_AUTH_GUIDANCE;
}

export function deepseekAuthGuidance(): string {
  return DEEPSEEK_AUTH_GUIDANCE;
}

export function isCursorAuthFailureText(text: string): boolean {
  const value = String(text || '');
  if (!value.trim()) return false;
  return (
    /authentication required/i.test(value) ||
    /not authenticated/i.test(value) ||
    /not logged in/i.test(value) ||
    /unauthenticated/i.test(value) ||
    /agent login/i.test(value) ||
    /cursor_api_key/i.test(value)
  );
}

export function isDeepSeekAuthFailureText(text: string): boolean {
  const value = String(text || '');
  if (!value.trim()) return false;
  return (
    /KEY=<your-key>/i.test(value) ||
    /api_key\s*=\s*["']<your-key>["']/i.test(value) ||
    (/~\/\.deepseek\/config\.toml/i.test(value) && /api[_ -]?key|KEY=/i.test(value)) ||
    (/DEEPSEEK_API_KEY/i.test(value) &&
      /auth|api[_ -]?key|missing|not set|required|unauthorized/i.test(value))
  );
}

export function classifyAgentAuthFailure(
  agentId: string,
  text: string,
): AgentAuthProbeResult | null {
  if (agentId === 'cursor-agent') {
    if (!isCursorAuthFailureText(text)) return null;
    return {
      status: 'missing',
      message: cursorAuthGuidance(),
    };
  }
  if (agentId === 'deepseek') {
    if (!isDeepSeekAuthFailureText(text)) return null;
    return {
      status: 'missing',
      message: deepseekAuthGuidance(),
    };
  }
  return null;
}

// Tail length matches the smoke-test sink so the diagnostics block
// stays compact when it folds probe output back into its overrides.
const PROBE_TAIL_BYTES = 400;

function tailString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > PROBE_TAIL_BYTES ? trimmed.slice(-PROBE_TAIL_BYTES) : trimmed;
}

function withProbeTails(
  base: AgentAuthProbeResult,
  stdoutText: string,
  stderrText: string,
): AgentAuthProbeResult {
  const result: AgentAuthProbeResult = { ...base };
  const stdoutTail = tailString(stdoutText);
  const stderrTail = tailString(stderrText);
  if (stdoutTail) result.stdoutTail = stdoutTail;
  if (stderrTail) result.stderrTail = stderrTail;
  return result;
}

// ── Claude Code (Local CLI) login detection ──────────────────────────────
// Claude Code stores OAuth credentials in `<configDir>/.credentials.json`
// (Linux/Windows) or in the macOS Keychain item "Claude Code-credentials".
// There is no non-interactive `claude auth status`, so the probe reads the
// same on-disk state the CLI itself consults.

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

const CLAUDE_AUTH_GUIDANCE =
  'Claude Code chưa đăng nhập trên máy này. Mở terminal, chạy `claude` rồi dùng `/login`; đăng nhập xong bấm Quét lại.';

const CLAUDE_AUTH_UNKNOWN =
  'Không xác minh được trạng thái đăng nhập Claude Code trên máy này.';

export function claudeAuthGuidance(): string {
  return CLAUDE_AUTH_GUIDANCE;
}

/**
 * A credentials blob counts as a login only when it actually carries a
 * non-empty accessToken — an aborted `/login` leaves a hollow file behind
 * (same contract as the sandbox-side `sandboxAuthLoggedIn`).
 */
export function claudeCredentialsCarryLogin(text: string): boolean {
  return /"accessToken"\s*:\s*"[^"]/.test(text);
}

// Windows env-var names are case-insensitive at the kernel level; compare
// case-insensitively so `Anthropic_Api_Key` still counts (mirrors
// claude-diagnostics.ts / env.ts).
function envLookup(env: RuntimeEnv, key: string): string | null {
  const upper = key.toUpperCase();
  const found = Object.keys(env).find((k) => k.toUpperCase() === upper);
  if (!found) return null;
  const value = (env as Record<string, unknown>)[found];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Injectable IO so tests never touch the real home dir or Keychain. */
export type ClaudeAuthProbeIO = {
  readFile?: (filePath: string) => Promise<string>;
  /** Whether the macOS Keychain holds the Claude Code credentials item. */
  keychainHasCredentials?: () => Promise<boolean>;
  platform?: NodeJS.Platform;
  homedir?: () => string;
};

async function defaultKeychainHasCredentials(): Promise<boolean> {
  // Attribute lookup only (no `-w`): reading the secret payload can pop the
  // macOS "wants to use your confidential information" ACL prompt from a
  // background daemon; the item's existence alone answers "logged in?".
  try {
    await execFileAsync(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE],
      { timeout: 3000, maxBuffer: 64 * 1024 },
    );
    return true;
  } catch (error) {
    // `security` itself missing/broken — rethrow so the caller degrades to
    // 'unknown' instead of a false "chưa đăng nhập".
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw error;
    return false; // non-zero exit (44) = item not found
  }
}

export async function probeClaudeAuthStatus(
  env: RuntimeEnv,
  io: ClaudeAuthProbeIO = {},
): Promise<AgentAuthProbeResult> {
  const platform = io.platform ?? process.platform;
  const home = io.homedir ?? os.homedir;
  const read = io.readFile ?? ((filePath: string) => readFile(filePath, 'utf8'));

  // External auth paths make `/login` irrelevant: an intentional API key
  // (spawnEnvForAgent only keeps ANTHROPIC_API_KEY alongside a custom
  // ANTHROPIC_BASE_URL) or Bedrock/Vertex routing.
  if (
    envLookup(env, 'ANTHROPIC_API_KEY') ||
    envLookup(env, 'CLAUDE_CODE_USE_BEDROCK') ||
    envLookup(env, 'CLAUDE_CODE_USE_VERTEX')
  ) {
    return { status: 'ok' };
  }

  const configDir = envLookup(env, 'CLAUDE_CONFIG_DIR') ?? path.join(home(), '.claude');
  // A read that failed for any reason other than "file absent" means we
  // could not actually answer — degrade to 'unknown', never a false
  // "chưa đăng nhập".
  let degraded = false;

  try {
    if (claudeCredentialsCarryLogin(await read(path.join(configDir, '.credentials.json')))) {
      return { status: 'ok' };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') degraded = true;
  }

  // settings.json apiKeyHelper = user-scripted credential source.
  try {
    if (/"apiKeyHelper"\s*:\s*"[^"]/.test(await read(path.join(configDir, 'settings.json')))) {
      return { status: 'ok' };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') degraded = true;
  }

  if (platform === 'darwin') {
    try {
      if (await (io.keychainHasCredentials ?? defaultKeychainHasCredentials)()) {
        return { status: 'ok' };
      }
    } catch {
      degraded = true;
    }
  }

  if (degraded) return { status: 'unknown', message: CLAUDE_AUTH_UNKNOWN };
  return { status: 'missing', message: CLAUDE_AUTH_GUIDANCE };
}

// ── Codex CLI login detection ─────────────────────────────────────────────
// Codex has no non-interactive online status check exposed as a stable API
// either — the CLI keeps its OAuth/API-key state in
// `<CODEX_HOME>/auth.json` (default `~/.codex`). The Docker sandbox path
// already parses this same file shape via `sandboxRuntimeAuthStateFromRaw`
// in agent-sandbox.ts; reimplemented as a small local helper here instead
// of importing from there, so this host-agnostic probe layer stays
// decoupled from the Docker-sandbox module (same reasoning as
// `claudeCredentialsCarryLogin` above duplicating rather than importing).

const CODEX_AUTH_GUIDANCE =
  'Codex CLI chưa đăng nhập trên máy này. Mở terminal, chạy `codex login`; đăng nhập xong bấm Quét lại.';

const CODEX_AUTH_UNKNOWN =
  'Không xác minh được trạng thái đăng nhập Codex CLI trên máy này.';

export function codexAuthGuidance(): string {
  return CODEX_AUTH_GUIDANCE;
}

/** Same shape agent-sandbox.ts's `sandboxRuntimeAuthStateFromRaw` checks for
 *  the codex runtime: an OAuth `tokens.access_token`, or a bare
 *  `OPENAI_API_KEY` fallback. */
export function codexAuthJsonCarriesToken(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as {
      tokens?: { access_token?: unknown };
      OPENAI_API_KEY?: unknown;
    };
    const token =
      typeof parsed.tokens?.access_token === 'string' && parsed.tokens.access_token
        ? parsed.tokens.access_token
        : typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY
          ? parsed.OPENAI_API_KEY
          : '';
    return Boolean(token);
  } catch {
    return false;
  }
}

/** Injectable IO so tests never touch the real home dir. */
export type CodexAuthProbeIO = {
  readFile?: (filePath: string) => Promise<string>;
  homedir?: () => string;
};

export async function probeCodexAuthStatus(
  env: RuntimeEnv,
  io: CodexAuthProbeIO = {},
): Promise<AgentAuthProbeResult> {
  // An explicit OPENAI_API_KEY is a deliberate external-auth path — login
  // state is irrelevant (mirrors Claude's ANTHROPIC_API_KEY shortcut above).
  if (envLookup(env, 'OPENAI_API_KEY')) {
    return { status: 'ok' };
  }
  const home = io.homedir ?? os.homedir;
  const read = io.readFile ?? ((filePath: string) => readFile(filePath, 'utf8'));
  const codexHome = envLookup(env, 'CODEX_HOME') ?? path.join(home(), '.codex');

  try {
    const raw = await read(path.join(codexHome, 'auth.json'));
    if (codexAuthJsonCarriesToken(raw)) return { status: 'ok' };
    return { status: 'missing', message: CODEX_AUTH_GUIDANCE };
  } catch (error) {
    // Anything other than "file absent" means we could not actually answer
    // — degrade to 'unknown', never a false "chưa đăng nhập" (same
    // invariant probeClaudeAuthStatus's `degraded` flag protects above).
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { status: 'missing', message: CODEX_AUTH_GUIDANCE };
    }
    return { status: 'unknown', message: CODEX_AUTH_UNKNOWN };
  }
}

export async function probeAgentAuthStatus(
  agentId: string,
  resolvedBin: string,
  env: RuntimeEnv,
): Promise<AgentAuthProbeResult | null> {
  if (agentId === 'claude') return probeClaudeAuthStatus(env);
  if (agentId === 'codex') return probeCodexAuthStatus(env);
  if (agentId !== 'cursor-agent') return null;
  try {
    const { stdout, stderr } = await execAgentFile(resolvedBin, ['status'], {
      env,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const stdoutText = typeof stdout === 'string' ? stdout : '';
    const stderrText = typeof stderr === 'string' ? stderr : '';
    const output = `${stdoutText}\n${stderrText}`;
    if (isCursorAuthFailureText(output)) {
      return withProbeTails(
        { status: 'missing', message: cursorAuthGuidance(), exitCode: 0, signal: null },
        stdoutText,
        stderrText,
      );
    }
    return { status: 'ok' };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: unknown;
      stderr?: unknown;
      code?: string | number;
      signal?: string;
    };
    const stdoutText = typeof err.stdout === 'string' ? err.stdout : '';
    const stderrText = typeof err.stderr === 'string' ? err.stderr : '';
    const output = [err.message, stdoutText, stderrText].join('\n');
    // util.promisify(execFile) attaches `code` and `signal` to the
    // rejection error. `code` may be a number (real non-zero exit) or
    // a Node ErrnoException string ("ENOENT"); only the numeric form
    // is meaningful as an exit code.
    const numericExit = typeof err.code === 'number' ? err.code : null;
    const childSignal = typeof err.signal === 'string' ? err.signal : null;
    if (isCursorAuthFailureText(output)) {
      return withProbeTails(
        {
          status: 'missing',
          message: cursorAuthGuidance(),
          exitCode: numericExit,
          signal: childSignal,
        },
        stdoutText,
        stderrText,
      );
    }
    return withProbeTails(
      {
        status: 'unknown',
        message: 'Cursor Agent authentication status could not be verified with `cursor-agent status`.',
        exitCode: numericExit,
        signal: childSignal,
      },
      stdoutText,
      stderrText,
    );
  }
}
