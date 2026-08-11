// app-context — shared, cross-feature context for an App.
//
// The pipeline is per-FEATURE (one docs→…→ui run = one feature). An APP is the
// container above features. Without an app-level layer, every feature researches
// and specs its UX independently, so the same app ends up with divergent
// navigation, states, terminology and patterns across features. This module is
// the "inherit" half of the fix: an app owns a small shared context (UX charter,
// domain glossary, information architecture, established patterns) that every
// feature READS before it designs, so the whole app develops coherently — even
// across sessions, because the context lives on the media store, not in a prompt.
//
// Storage (reuses "media store = where config lives", since KGS has no node
// update API):
//   • The app is a media project keyed by its appId; its context lives under
//     `app-context/**` there.
//   • A feature's `project.json` (already on the media store) carries an optional
//     `appId` linking it to its app.
//
// Staging mirrors the UX knowledge base: the daemon copies the app's
// `app-context/**` into the run cwd as `./.app-context` (a dot-folder, so
// snapshot / push / re-run-clear never see it) and hands the agent a relative
// path. Write-back is deliberately NOT done here — a feature only PROPOSES
// additions (an `app-context-delta.md` output file); promoting a delta into the
// app context is a separate, reviewed step (see docs/app-context-spec.md).

import fs from 'node:fs';
import path from 'node:path';

import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';

/** Folder holding an app's shared context inside its media project. */
export const APP_CONTEXT_DIR = 'app-context';
/** Dot-folder the context is staged into inside a feature's run cwd. */
export const STAGED_APP_CONTEXT = '.app-context';

const stripLead = (p: string) => p.replace(/^\/+/, '');

/**
 * Read the parent app id from a feature's `project.json` on the media store.
 * Returns null when the feature isn't linked to an app (the common case today —
 * the whole mechanism is then a no-op). Best-effort: any media/parse error
 * resolves to null so a pipeline run NEVER fails because of app context.
 */
export async function resolveAppId(featureProjectId: string): Promise<string | null> {
  try {
    const media = new MediaClient(mediaConfigFromEnv());
    const files = await media.listFiles(featureProjectId);
    const hasConfig = files.some((f) => stripLead(String(f.path ?? '')) === 'project.json');
    if (!hasConfig) return null;
    const buf = await media.downloadFile(featureProjectId, 'project.json');
    const cfg = JSON.parse(buf.toString('utf8')) as { appId?: unknown };
    const appId = typeof cfg.appId === 'string' ? cfg.appId.trim() : '';
    return appId || null;
  } catch {
    return null;
  }
}

/** Relative context file paths inside an app's media project (under APP_CONTEXT_DIR). */
async function listAppContextFiles(media: MediaClient, appId: string): Promise<string[]> {
  const files = await media.listFiles(appId);
  return files
    .map((f) => stripLead(String(f.path ?? '')))
    .filter((p) => p.startsWith(`${APP_CONTEXT_DIR}/`) && !p.endsWith('/'));
}

/**
 * Stage an app's shared context (`<appId>` media project → `app-context/**`)
 * into `<runCwd>/.app-context`, mirroring the ux-kb staging. Returns the
 * context-relative paths staged (i.e. without the `app-context/` prefix); an
 * empty array means the app has no context yet, and nothing is written.
 */
export async function stageAppContext(appId: string, runCwd: string): Promise<string[]> {
  const media = new MediaClient(mediaConfigFromEnv());
  const ctx = await listAppContextFiles(media, appId);
  if (ctx.length === 0) return [];
  const staged = path.join(runCwd, STAGED_APP_CONTEXT);
  await fs.promises.rm(staged, { recursive: true, force: true });
  const rel: string[] = [];
  for (const p of ctx) {
    const inner = p.slice(APP_CONTEXT_DIR.length + 1); // strip "app-context/"
    const buf = await media.downloadFile(appId, p);
    const abs = path.join(staged, inner);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, buf);
    rel.push(inner);
  }
  return rel;
}

/**
 * Stage mutable local context and lazily import the legacy media-only layout
 * when a local App has no context yet. Open Design owns these imported bytes;
 * subsequent edits/runs never re-read media implicitly.
 */
export async function stageLocalAppContext(
  projectsDir: string,
  appId: string,
  runCwd: string,
): Promise<string[]> {
  const source = path.join(projectsDir, appId, APP_CONTEXT_DIR);
  const listLocal = async (): Promise<string[]> => {
    const result: string[] = [];
    const walk = async (dir: string, rel = ''): Promise<void> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const next = rel ? `${rel}/${entry.name}` : entry.name;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(absolute, next);
        else if (entry.isFile()) result.push(next);
      }
    };
    await walk(source);
    return result.sort();
  };
  let local = await listLocal();
  if (local.length === 0) {
    const media = new MediaClient(mediaConfigFromEnv());
    const legacy = await listAppContextFiles(media, appId).catch(() => [] as string[]);
    for (const remotePath of legacy) {
      const inner = remotePath.slice(APP_CONTEXT_DIR.length + 1);
      const content = await media.downloadFile(appId, remotePath);
      const target = path.join(source, ...inner.split('/'));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    local = await listLocal();
  }
  if (local.length === 0) return [];
  const staged = path.join(runCwd, STAGED_APP_CONTEXT);
  await fs.promises.rm(staged, { recursive: true, force: true });
  for (const relative of local) {
    const target = path.join(staged, ...relative.split('/'));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(path.join(source, ...relative.split('/')), target);
  }
  return local;
}

/**
 * The kickoff directive appended for a feature that inherits app context. Pure
 * (no I/O) so it is unit-testable; returns '' when nothing was staged, keeping
 * the kickoff byte-identical to the legacy one for unlinked features.
 */
export function appContextDirective(stagedFiles: string[]): string {
  if (stagedFiles.length === 0) return '';
  return (
    ` This feature belongs to an APP with shared cross-feature context staged at "./.app-context"` +
    ` (files: ${stagedFiles.join(', ')}). READ it FIRST and treat it as the app-wide source of truth.` +
    ` "ux-charter.json" is a STRUCTURED set of UX criteria — each { "id", "priority" (must|should|nice),` +
    ` "area", "text" }. Treat every "must" as a HARD CONSTRAINT and every "should" as a default you follow,` +
    ` so this feature stays consistent with the rest of the app; reuse any patterns/conventions it` +
    ` establishes rather than reinventing them.` +
    ` If this feature genuinely needs a NEW cross-cutting criterion, record it as a PROPOSAL in` +
    ` "./app-context-delta.json" — a JSON object {"criteria":[{ "id": "kebab-id", "priority":` +
    ` "must|should|nice", "area": "...", "text": "..." }]} (create the file, or extend its "criteria" array).` +
    ` Do NOT edit ./.app-context directly (it is read-only; a human reviews and promotes deltas into the` +
    ` app charter).`
  );
}
