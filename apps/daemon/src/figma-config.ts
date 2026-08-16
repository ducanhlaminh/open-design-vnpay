// Figma Personal Access Token storage — the docs-review Screen → Component
// stage reads its component catalogue straight from Figma's REST API with
// this token (see figma-rest.ts). Deliberately separate from the generic
// external-MCP config (mcp-config.ts) and modelled on confluence-config.ts:
// <dataDir>/figma-config.json holds either `{ token }` or `null`, written
// atomically (write tmp → rename) under a per-dataDir lock.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export type FigmaConfig = { token: string } | null;

function configFile(dataDir: string): string {
  return path.join(dataDir, 'figma-config.json');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function sanitizeFigmaConfig(raw: unknown): FigmaConfig {
  if (!isPlainObject(raw)) return null;
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  return token ? { token } : null;
}

export async function readFigmaConfig(dataDir: string): Promise<FigmaConfig> {
  try {
    const raw = await readFile(configFile(dataDir), 'utf8');
    return sanitizeFigmaConfig(JSON.parse(raw));
  } catch (err: unknown) {
    const e = err as { code?: string; name?: string; message?: string };
    if (e.code === 'ENOENT') return null;
    if (e.name === 'SyntaxError') {
      console.error('[figma-config] Corrupted JSON, treating as unset:', e.message);
      return null;
    }
    throw err;
  }
}

const writeLocks = new Map<string, Promise<unknown>>();

/** Write the Figma token. `body.token` empty/omitted keeps the previously
 *  saved token (the UI never round-trips the real value back from GET);
 *  `body.clear === true` forgets it. */
export async function writeFigmaConfig(dataDir: string, body: unknown): Promise<FigmaConfig> {
  const prev = writeLocks.get(dataDir) ?? Promise.resolve();
  const task = prev.catch(() => {}).then(() => doWrite(dataDir, body));
  writeLocks.set(dataDir, task);
  try {
    return await task;
  } finally {
    if (writeLocks.get(dataDir) === task) writeLocks.delete(dataDir);
  }
}

async function doWrite(dataDir: string, body: unknown): Promise<FigmaConfig> {
  const raw = isPlainObject(body) ? body : {};
  const incomingToken = typeof raw.token === 'string' ? raw.token.trim() : '';
  const next: FigmaConfig = raw.clear === true
    ? null
    : sanitizeFigmaConfig({ token: incomingToken || (await readFigmaConfig(dataDir))?.token || '' });
  const file = configFile(dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp';
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await rename(tmp, file);
  return next;
}

/** Token to use for a request: an explicitly supplied one wins (so the UI can
 *  test/verify before saving), else the saved one, else empty. */
export async function resolveFigmaToken(dataDir: string, body: unknown): Promise<string> {
  const raw = isPlainObject(body) ? body : {};
  const incoming = typeof raw.token === 'string' ? raw.token.trim() : '';
  return incoming || (await readFigmaConfig(dataDir))?.token || '';
}
