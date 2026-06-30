// Ensure `uv`/`uvx` exists so uvx-launched stdio MCP servers (mcp-atlassian)
// work on a fresh machine that never installed uv. Best-effort and idempotent:
// when uvx is already resolvable we do nothing; otherwise we run the official
// standalone installer, which drops a self-contained binary into ~/.local/bin
// (no Python or Homebrew required). The packaged daemon's PATH already includes
// ~/.local/bin + Homebrew (resolvePackagedPathEnv / wellKnownUserToolchainBins),
// so a freshly installed uvx is immediately resolvable by the MCP child spawn.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { readMcpConfig } from './mcp-config.js';

const execFileAsync = promisify(execFile);

const UV_INSTALL_URL = 'https://astral.sh/uv/install.sh';
// Matches a bare `uv`/`uvx` (PATH-resolved) or an absolute path ending in one.
const UVX_COMMAND_RE = /(^|\/)uvx?$/;

async function uvxAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-c', 'command -v uvx'], { env, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `uvx` runnable, installing uv when absent. Returns true when uvx is
 * available afterwards. Never throws — a failure is logged and leaves uvx
 * unavailable, so the dependent MCP server surfaces its own launch error
 * instead of taking down daemon startup.
 */
export async function ensureUvInstalled(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (await uvxAvailable(env)) return true;
  console.log('[ensure-uv] uvx not found — installing uv via the astral.sh standalone installer…');
  try {
    // curl the installer and pipe to sh. `-LsSf`: follow redirects, silent,
    // still show errors, fail on HTTP error. INSTALLER_NO_MODIFY_PATH stops it
    // editing shell rc files — we rely on the daemon's own PATH (~/.local/bin),
    // not an interactive shell.
    await execFileAsync(
      'sh',
      ['-c', `curl -LsSf ${UV_INSTALL_URL} | env INSTALLER_NO_MODIFY_PATH=1 sh`],
      { env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (err) {
    console.error('[ensure-uv] uv install failed:', err instanceof Error ? err.message : err);
    return false;
  }
  const ok = await uvxAvailable(env);
  console.log(
    ok
      ? '[ensure-uv] uv installed; uvx is now resolvable.'
      : '[ensure-uv] uv installer ran but uvx is still not on PATH.',
  );
  return ok;
}

/**
 * Gate ensureUvInstalled on actual need: only install uv when the seeded MCP
 * config has an enabled stdio server launched through `uvx` (today:
 * mcp-atlassian). Called best-effort at daemon startup; swallows all errors.
 */
export async function ensureUvForMcp(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const { servers } = await readMcpConfig(dataDir);
    const needsUv = servers.some(
      (s) =>
        s.enabled &&
        s.transport === 'stdio' &&
        UVX_COMMAND_RE.test((s.command ?? '').trim()),
    );
    if (!needsUv) return;
    await ensureUvInstalled(env);
  } catch (err) {
    console.error('[ensure-uv] gate check failed:', err instanceof Error ? err.message : err);
  }
}
