// Loads `<OD_HOME>/config.env` (written by deploy/host/install.sh /
// install.ps1) into process.env before anything else reads it.
//
// macOS/Linux don't strictly need this: the LaunchAgent plist and the
// systemd --user unit both source config.env into the daemon's OS process
// env before exec'ing node (see scripts/host-runtime/service/*.in), so by
// the time this module runs, process.env already has it and every fill
// below is a no-op. Windows has no equivalent — install.ps1's
// Start-Process/schtasks launch `node cli.js` directly with nothing
// sourcing config.env — so on Windows this is the ONLY thing that loads it.
// Doing it here once, for all platforms, means the daemon doesn't depend on
// three different OS-specific env-injection mechanisms staying in sync.
//
// Imported for its side effect at the top of apps/daemon's CLI entry point
// (cli.ts), before daemon-startup.js (and therefore server.ts) is reached.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnv } from './load-local-env.js';

/**
 * `<OD_HOME>/releases/<version>/apps/daemon/{dist,src}` -> `<OD_HOME>`.
 * Mirrors server.ts's resolveProjectRoot (daemon dir = parent of dist/src),
 * plus two more levels up past `releases/<version>` to reach OD_HOME itself.
 * In dev (repo root, no releases/<version> nesting) this lands somewhere
 * outside the repo with no config.env — loadHostConfigEnv() below just finds
 * nothing there and no-ops, same as load-local-env.ts does for a missing
 * .env/.env.local.
 */
export function resolveOdHomeFromModuleDir(moduleDir: string): string {
  const base = path.basename(moduleDir);
  const daemonDir = base === 'dist' || base === 'src' ? path.dirname(moduleDir) : moduleDir;
  return path.resolve(daemonDir, '..', '..', '..', '..');
}

/** Fills only vars not already present in `target` — a real env var (or an
 * earlier-loaded config.env on macOS/Linux) always wins over this file. */
export function applyConfigEnv(text: string, target: NodeJS.ProcessEnv = process.env): void {
  const parsed = parseEnv(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) target[key] = value;
  }
}

export function loadHostConfigEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const configPath = path.join(resolveOdHomeFromModuleDir(here), 'config.env');
  if (!existsSync(configPath)) return; // dev repo, or config.env not written yet
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    return;
  }
  applyConfigEnv(text);
}

loadHostConfigEnv();
