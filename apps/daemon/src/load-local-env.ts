// Minimal local .env loader. The daemon reads configuration straight from
// process.env (there is intentionally no dotenv dependency). For local dev we
// still want persistent vars — notably the local KGS creds (KGS_URL /
// KGS_APP_ID / KGS_TENANT / KGS_API_KEY) so `od kg pull` works without
// re-exporting them on every launch. This fills MISSING vars from gitignored
// `.env.local` (secrets) then committed `.env` (non-secret defaults) at the
// open-design repo root. The real process environment always wins, so an
// explicit `export KGS_API_KEY=…` still overrides the file.
//
// Imported for its side effect at the top of the daemon entry points
// (sidecar/index.ts, cli.ts).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let loaded = false;

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadLocalEnv(): void {
  if (loaded) return;
  loaded = true;
  // This module lives at apps/daemon/{src,dist}/load-local-env.{ts,js}; the
  // open-design repo root is three levels up in both layouts.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..', '..', '..');
  // `.env.local` (gitignored) takes precedence over `.env`; both only fill
  // vars not already present, so the real environment wins over either file.
  for (const file of ['.env.local', '.env']) {
    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(readFileSync(path.join(root, file), 'utf8'));
    } catch {
      continue; // missing file is fine
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}

loadLocalEnv();
