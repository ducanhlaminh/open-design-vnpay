// Cross-user feedback collection over the shared media-service file store.
//
// Problem: open-design is local-first — each install has its own
// `app.sqlite`, so a user's follow-up "fix this output" prompts never leave
// their machine. To build a per-project feedback digest across the whole team
// we ship those prompts to the ONE place every install already shares: the
// media-service file store (one folder per project; same backend the
// Pull/Upload-project buttons use).
//
// Design — per-install file, merge on read (race-free):
//   * Each install writes ONLY its own file `feedback/<installationId>.jsonl`
//     inside the project's media folder. Two installs never touch the same
//     file, so the read-modify-write race of a single shared log can't happen.
//     `installationId` is the collision-free FILE KEY; the human-readable
//     `user` (Settings → feedback username) is carried INSIDE each record for
//     attribution. MediaClient.uploadFile is content-hash idempotent, so
//     re-publishing an unchanged file is a no-op.
//   * `publishFeedback` rebuilds this install's whole file from app.sqlite on
//     every capture — no append/dedup bookkeeping, just an overwrite of our
//     own file.
//   * `pullMergedFeedback` lists `feedback/*.jsonl`, downloads them all, and
//     concatenates into `<cwd>/.feedback-merged.jsonl` — the union of every
//     install's prompts, which the summary-feedback skill then reads locally.

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';

type SqliteDb = Database.Database;

export const FEEDBACK_DIR = 'feedback';
export const MERGED_FEEDBACK_FILENAME = '.feedback-merged.jsonl';

/** One captured end-user feedback prompt, attributed to a person + project. */
export interface FeedbackRecord {
  /** Display name from Settings (feedbackUsername); falls back to install id. */
  user: string;
  /** KGS/media project id (the folder the prompt belongs to). */
  project: string;
  /** Verbatim user prompt text. */
  prompt: string;
  /** Unix-millis when the prompt was sent. */
  ts: number;
  /** Conversation the prompt belongs to (for grouping a back-and-forth). */
  conversationId: string;
  /** Output file names that existed when the user typed — what they reacted to. */
  outputUserSaw: string[];
}

interface MessageRow {
  content: string;
  created_at: number;
  conversation_id: string;
  pre_turn_file_names_json: string | null;
}

function parseFileNames(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// A safe, stable filename segment for the per-install file key. Restricts to a
// conservative charset so a stray id never escapes the `feedback/` folder.
function safeKey(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

/** This install's feedback file path within the project's media folder. */
export function feedbackFilePath(installKey: string): string {
  return `${FEEDBACK_DIR}/${safeKey(installKey)}.jsonl`;
}

/** Read this install's real end-user feedback prompts for a project. Excludes
 *  the synthetic prompts that merely trigger a pipeline/orbit/routine run, and
 *  the summary-feedback invocation itself. `user` is the display name. */
export function buildFeedbackRecords(
  db: SqliteDb,
  projectId: string,
  user: string,
): FeedbackRecord[] {
  const rows = db
    .prepare(
      `SELECT m.content, m.created_at, m.conversation_id,
              m.pre_turn_file_names_json
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.project_id = ?
          AND m.role = 'user'
          AND m.id NOT LIKE 'pipeline-user-%'
          AND m.id NOT LIKE 'orbit-user-%'
          AND m.id NOT LIKE 'routine-user-%'
          AND m.content NOT LIKE '%summary-feedback%'
        ORDER BY m.created_at ASC`,
    )
    .all(projectId) as MessageRow[];

  return rows.map((r) => ({
    user,
    project: projectId,
    prompt: r.content,
    ts: Number(r.created_at),
    conversationId: r.conversation_id,
    outputUserSaw: parseFileNames(r.pre_turn_file_names_json),
  }));
}

function serializeJsonl(records: FeedbackRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

/** Publish this install's feedback file for a project to media-service. Keyed
 *  by `installKey` (collision-free per install). No-op when there are no real
 *  prompts yet. Returns the number of records published. Throws on media error
 *  — the capture caller should swallow (best-effort, never blocks chat). */
export async function publishFeedback(
  db: SqliteDb,
  projectId: string,
  opts: { user: string; installKey: string; client?: MediaClient },
): Promise<{ records: number }> {
  const records = buildFeedbackRecords(db, projectId, opts.user);
  if (records.length === 0) return { records: 0 };
  const client = opts.client ?? new MediaClient(mediaConfigFromEnv());
  const content = Buffer.from(serializeJsonl(records), 'utf8');
  await client.uploadFile(
    projectId,
    FEEDBACK_DIR,
    feedbackFilePath(opts.installKey),
    'application/x-ndjson',
    content,
  );
  return { records: records.length };
}

interface MediaFileRow {
  path?: unknown;
}

/** Merge every install's feedback file for a project into a single local
 *  `<cwd>/.feedback-merged.jsonl` (the union of all users' prompts). Returns
 *  the absolute path plus how many files/records were merged. Throws on media
 *  error; the caller decides whether absence is fatal. */
export async function pullMergedFeedback(
  projectId: string,
  cwd: string,
  opts: { client?: MediaClient } = {},
): Promise<{ path: string; files: number; records: number }> {
  const client = opts.client ?? new MediaClient(mediaConfigFromEnv());
  const listed = (await client.listFiles(projectId)) as MediaFileRow[];
  const feedbackPaths = listed
    .map((f) => (typeof f.path === 'string' ? f.path : null))
    .filter((p): p is string => !!p && p.startsWith(`${FEEDBACK_DIR}/`) && p.endsWith('.jsonl'));

  const records: FeedbackRecord[] = [];
  for (const p of feedbackPaths) {
    const buf = await client.downloadFile(projectId, p);
    for (const line of buf.toString('utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as FeedbackRecord);
      } catch {
        // skip a corrupt line rather than fail the whole merge
      }
    }
  }
  records.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  const outPath = path.join(cwd, MERGED_FEEDBACK_FILENAME);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(outPath, serializeJsonl(records), 'utf8');
  return { path: outPath, files: feedbackPaths.length, records: records.length };
}
