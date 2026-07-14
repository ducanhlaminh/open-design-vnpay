// Per-project output versioning — a HIDDEN git repo inside each project cwd.
//
// Pipelines overwrite their outputs by design; this module preserves every
// prior state so a re-run/pull/push never silently destroys work. The repo
// lives in `<cwd>/.odhistory` (git-dir) with the cwd as work-tree:
//   • dotfile name → snapshotPipelineCwd's walker never syncs it to the
//     media store, and the agent working in the cwd doesn't see a `.git`
//     it might be tempted to touch.
//   • excludes (node_modules/, .tmp/, .odhistory/) live in info/exclude so
//     no .gitignore file appears in the project tree (it would sync).
//
// Commits happen at the daemon's lifecycle hooks (run finished, build, pull,
// push, manual-edit fence, restore) with a structured JSON body so history
// doubles as the machine-local changelog. Published cross-device versions
// (`_v/<id>` on the media store) reference these commits by hash.
//
// Everything is BEST-EFFORT by contract: a history failure (git missing,
// disk hiccup) must never fail the pipeline operation that triggered it —
// callers use `commitHistory(...).catch(...)` or the null return.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const GIT_DIR = '.odhistory';
const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;

export interface HistoryActor {
  id?: string;
  email?: string;
  name?: string;
}

export interface HistoryMeta {
  kind: 'manual-edits' | 'run' | 'build' | 'pre-pull' | 'pull' | 'push' | 'restore' | 'export';
  pipelineId?: string;
  runId?: string;
  status?: string;
  by?: HistoryActor | null;
  input?: string;
  /** Published version id (`v3`) when kind === 'push'/'restore'. */
  verId?: string;
  note?: string;
}

export interface HistoryEntry extends HistoryMeta {
  commit: string;
  /** ISO timestamp of the commit. */
  at: string;
  subject: string;
  /** Working-tree paths touched, counted at commit time. */
  filesChanged?: number;
}

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [`--git-dir=${join(cwd, GIT_DIR)}`, `--work-tree=${cwd}`, ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]}: ${stderr || err.message}`.slice(0, 400)));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function ensureRepo(cwd: string): Promise<void> {
  const gitDir = join(cwd, GIT_DIR);
  try {
    await fs.access(join(gitDir, 'HEAD'));
    return;
  } catch {
    /* not initialized yet */
  }
  await runGit(cwd, ['init', '--initial-branch=main']);
  // info/exclude instead of a .gitignore in the tree: the tree must stay
  // byte-identical to what pipelines produce (a .gitignore would sync).
  await fs.mkdir(join(gitDir, 'info'), { recursive: true });
  await fs.writeFile(
    join(gitDir, 'info', 'exclude'),
    ['.odhistory/', 'node_modules/', '.tmp/', '.DS_Store'].join('\n') + '\n',
  );
}

function authorArgs(by?: HistoryActor | null): string[] {
  const name = by?.name || by?.email || 'Open Design';
  const email = by?.email || 'open-design@local';
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
}

// Commits from concurrent hooks (e.g. a push while a run finishes) must not
// interleave `add`/`commit` — serialize per cwd.
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(cwd: string, task: () => Promise<T>): Promise<T> {
  const tail = queues.get(cwd) ?? Promise.resolve();
  const next = tail.then(task, task);
  queues.set(cwd, next.catch(() => {}));
  return next;
}

/**
 * Snapshot the current cwd state as one commit. Returns null when the tree
 * is clean (nothing to record) — callers treat that as "no-op, fine".
 */
export function commitHistory(
  cwd: string,
  meta: HistoryMeta,
): Promise<{ commit: string; filesChanged: number } | null> {
  return serialized(cwd, async () => {
    await ensureRepo(cwd);
    const status = await runGit(cwd, ['status', '--porcelain']);
    const changed = status.stdout.split('\n').filter(Boolean).length;
    if (changed === 0) return null;
    await runGit(cwd, ['add', '-A']);
    const subject = [
      meta.kind,
      meta.pipelineId ?? '',
      meta.verId ?? '',
      meta.status ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    const body = JSON.stringify({ ...meta, filesChanged: changed });
    await runGit(cwd, [
      ...authorArgs(meta.by),
      'commit',
      '--no-verify',
      '-m',
      subject,
      '-m',
      body,
    ]);
    const head = await runGit(cwd, ['rev-parse', 'HEAD']);
    return { commit: head.stdout.trim(), filesChanged: changed };
  });
}

const FIELD = '';
const RECORD = '';

/** Newest-first history entries (machine-local changelog). */
export async function listHistory(cwd: string, limit = 100): Promise<HistoryEntry[]> {
  try {
    await fs.access(join(cwd, GIT_DIR, 'HEAD'));
  } catch {
    return [];
  }
  try {
    const out = await runGit(cwd, [
      'log',
      `-n${limit}`,
      `--format=%H${FIELD}%aI${FIELD}%s${FIELD}%b${RECORD}`,
    ]);
    return out.stdout
      .split(RECORD)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [commit = '', at = '', subject = '', body = ''] = r.split(FIELD);
        let meta: Partial<HistoryEntry> = {};
        try {
          const parsed = JSON.parse(body.trim());
          if (parsed && typeof parsed === 'object') meta = parsed as Partial<HistoryEntry>;
        } catch {
          /* non-JSON body (foreign commit) — subject-only entry */
        }
        return {
          kind: 'manual-edits',
          ...meta,
          commit,
          at,
          subject,
        } as HistoryEntry;
      });
  } catch {
    return [];
  }
}

/** Bytes of `path` as of `commit`. Null when absent in that version. */
export async function showFileAt(cwd: string, commit: string, path: string): Promise<Buffer | null> {
  try {
    const out = await new Promise<Buffer>((resolve, reject) => {
      execFile(
        'git',
        [`--git-dir=${join(cwd, GIT_DIR)}`, `--work-tree=${cwd}`, 'show', `${commit}:${path}`],
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'buffer' },
        (err, stdout) => (err ? reject(err) : resolve(stdout as unknown as Buffer)),
      );
    });
    return out;
  } catch {
    return null;
  }
}

/**
 * Restore file contents from `commit` into the working tree (all tracked
 * paths of that commit, or just `paths`). Files created AFTER that commit
 * are left in place — restore rewinds content, it does not delete forward
 * work. The restore itself is committed so history never loses a state.
 */
export async function restoreCommit(
  cwd: string,
  commit: string,
  paths: string[] | undefined,
  by?: HistoryActor | null,
): Promise<{ commit: string; filesChanged: number } | null> {
  await serialized(cwd, async () => {
    await ensureRepo(cwd);
    await runGit(cwd, ['restore', '--source', commit, '--worktree', '--', ...(paths?.length ? paths : ['.'])]);
  });
  return commitHistory(cwd, {
    kind: 'restore',
    note: `restore ${paths?.length ? paths.join(', ') : 'toàn bộ'} về ${commit.slice(0, 10)}`,
    by: by ?? null,
  });
}

/** True when a usable `git` binary is on PATH (feature-gates the UI). */
export async function historyAvailable(): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['--version'], { timeout: 5_000 }, (err) => (err ? reject(err) : resolve()));
    });
    return true;
  } catch {
    return false;
  }
}
