// ux-kb-sync — the UX knowledge base lives ON THE MEDIA SERVICE (project id
// env UX_KB_MEDIA_PROJECT, default "ux-knowledge-base") so updating knowledge
// is ONE push (`od kb push`) and every daemon pulls the fresh copy before the
// ux-research stage runs. Resolve order (first hit wins):
//   ① env UX_KB_DIR            — explicit local override (dev / air-gapped)
//   ② media store              — synced into <runtimeDataDir>/ux-kb-cache;
//        a checksum marker of the remote file set makes the re-sync a no-op
//        until someone pushes new knowledge (stale cache still serves offline)
//   ③ ~/ux-knowledge-base      — the original hand-crawled local folder
// Every failure falls through — the KB is enrichment, never load-bearing for
// the stage (the skill has an explicit "unavailable" fallback report).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MediaClient, mediaConfigFromEnv, type LocalSyncFile } from './kg-sync/media-client.js';

export function uxKbMediaProject(): string {
  return (process.env.UX_KB_MEDIA_PROJECT ?? '').trim() || 'ux-knowledge-base';
}

const looksLikeKb = (dir: string): boolean =>
  fs.existsSync(path.join(dir, 'data')) && fs.existsSync(path.join(dir, 'scripts'));

export interface UxKbResolution {
  dir: string | null;
  source: 'env' | 'media' | 'home' | 'none';
  /** Files downloaded in THIS resolve (0 = cache already fresh). */
  synced?: number;
  note?: string;
}

export async function resolveUxKbDir(runtimeDataDir: string): Promise<UxKbResolution> {
  const envDir = (process.env.UX_KB_DIR ?? '').trim();
  if (envDir) {
    if (looksLikeKb(envDir)) return { dir: envDir, source: 'env' };
    return { dir: null, source: 'none', note: `UX_KB_DIR="${envDir}" thiếu data/ hoặc scripts/` };
  }

  const cacheDir = path.join(runtimeDataDir, 'ux-kb-cache');
  try {
    const media = new MediaClient(mediaConfigFromEnv());
    const remote = await media.listFiles(uxKbMediaProject());
    if (remote.length > 0) {
      const markerPath = path.join(cacheDir, '.sync-marker');
      const marker = crypto
        .createHash('sha256')
        .update(remote.map((f) => `${f.path}|${f.checksum ?? ''}`).sort().join('\n'))
        .digest('hex');
      const prev = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : '';
      if (prev === marker && looksLikeKb(cacheDir)) {
        return { dir: cacheDir, source: 'media', synced: 0 };
      }
      await fs.promises.rm(cacheDir, { recursive: true, force: true });
      let synced = 0;
      for (const f of remote) {
        const rel = typeof f.path === 'string' ? f.path : '';
        // Store paths are trusted-ish but never let one escape the cache dir.
        if (!rel || rel.split('/').includes('..')) continue;
        const buf = await media.downloadFile(uxKbMediaProject(), rel);
        const abs = path.join(cacheDir, rel);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, buf);
        synced++;
      }
      await fs.promises.writeFile(markerPath, marker);
      console.log(`[ux-kb] synced ${synced} file(s) from media project "${uxKbMediaProject()}"`);
      if (looksLikeKb(cacheDir)) return { dir: cacheDir, source: 'media', synced };
    }
  } catch (err) {
    console.warn('[ux-kb] media sync failed (falling back):', err);
    // Offline / store down: yesterday's cache is still a valid KB.
    if (looksLikeKb(cacheDir)) return { dir: cacheDir, source: 'media', note: 'offline cache' };
  }

  const home = path.join(os.homedir(), 'ux-knowledge-base');
  if (looksLikeKb(home)) return { dir: home, source: 'home' };
  return { dir: null, source: 'none' };
}

const KB_MIME: Record<string, string> = {
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.py': 'text/x-python',
  '.txt': 'text/plain',
};

// data/nngroup/articles/ is the per-machine LAZY CACHE of NN/g full text — the
// KB's own README keeps full articles out of any shared store (ToS: index is
// metadata-only, full text fetched on demand). Everything else ships.
const PUSH_EXCLUDE = /(^|\/)(\.git|__pycache__|\.DS_Store|node_modules)(\/|$)|(^|\/)data\/nngroup\/articles\//i;

async function collectKbFiles(root: string): Promise<LocalSyncFile[]> {
  const out: LocalSyncFile[] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (PUSH_EXCLUDE.test(rel + (entry.isDirectory() ? '/' : ''))) continue;
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile() && !entry.name.startsWith('.')) {
        out.push({
          path: rel,
          stage: 'ux-kb',
          mime: KB_MIME[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream',
          content: await fs.promises.readFile(abs),
        });
      }
    }
  };
  await walk(root);
  return out;
}

export interface UxKbPushResult {
  project: string;
  files: number;
  uploaded: number;
  skipped: number;
  deleted: number;
}

/** Push a local KB folder to the media store (`od kb push` / POST
 * /api/ux-kb/push). Content-hash sync: re-pushing an unchanged KB uploads
 * nothing. Default source dir: env UX_KB_DIR, else ~/ux-knowledge-base. */
export async function pushUxKb(localDir?: string): Promise<UxKbPushResult> {
  const dir =
    (localDir ?? '').trim() ||
    (process.env.UX_KB_DIR ?? '').trim() ||
    path.join(os.homedir(), 'ux-knowledge-base');
  if (!looksLikeKb(dir)) {
    throw new Error(`"${dir}" không phải knowledge base (cần có data/ và scripts/)`);
  }
  const files = await collectKbFiles(dir);
  if (files.length === 0) throw new Error(`"${dir}" không có file nào để push`);
  const media = new MediaClient(mediaConfigFromEnv());
  const r = await media.syncProjectFiles(uxKbMediaProject(), files);
  return { project: uxKbMediaProject(), files: files.length, ...r };
}
