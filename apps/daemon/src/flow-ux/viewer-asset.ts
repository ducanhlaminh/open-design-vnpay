// Serve draw.io's static viewer JS to the web app.
//
// `viewer-static.min.js` (jgraph/drawio, Apache-2.0) is ~4 MB — over the
// repo's file-size line — so it is NOT vendored. The daemon fetches it once
// from the official CDN into the runtime data dir (the same place the draw.io
// PNG render runner keeps its Chromium) and serves it from disk after that.
// Offline with an empty cache → 503; the web then loads the CDN URL directly.

import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';

export const DRAWIO_VIEWER_CDN_URL = 'https://viewer.diagrams.net/js/viewer-static.min.js';
const CACHE_SUBDIR = 'drawio-viewer';
const CACHE_FILE = 'viewer-static.min.js';
// A truncated download must never be served: the real file is ~4 MB and
// starts with the viewer's window.* path defaults.
const MIN_BYTES = 1_000_000;

let inflight: Promise<string> | null = null;

export function drawioViewerCachePath(runtimeDataDir: string): string {
  return path.join(runtimeDataDir, CACHE_SUBDIR, CACHE_FILE);
}

async function looksComplete(file: string): Promise<boolean> {
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || st.size < MIN_BYTES) return false;
  const fd = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(64);
    await fd.read(buf, 0, 64, 0);
    return buf.toString('utf8').includes('window.');
  } finally {
    await fd.close();
  }
}

/** Ensure the viewer JS is cached; returns its path. Concurrent callers share
 *  one download. */
export async function ensureDrawioViewerJs(runtimeDataDir: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const file = drawioViewerCachePath(runtimeDataDir);
  if (await looksComplete(file)) return file;
  if (inflight) return inflight;
  inflight = (async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const res = await fetchImpl(DRAWIO_VIEWER_CDN_URL, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`draw.io viewer download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < MIN_BYTES) throw new Error(`draw.io viewer download too small (${buf.length} bytes)`);
    const tmp = `${file}.part`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
    return file;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function serveDrawioViewerJs(_req: Request, res: Response, runtimeDataDir: string): Promise<void> {
  try {
    const file = await ensureDrawioViewerJs(runtimeDataDir);
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(file);
  } catch (error) {
    res.status(503).json({
      error: 'DRAWIO_VIEWER_UNAVAILABLE',
      message: `Không tải được viewer draw.io (${String((error as Error)?.message ?? error)}). Web sẽ thử CDN trực tiếp.`,
      cdn: DRAWIO_VIEWER_CDN_URL,
    });
  }
}
