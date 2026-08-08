// App Docs Pool — distill runner (docs/app-docs-pool-spec.md §WP-2).
//
// Map-reduce over the pool's branches: one agent turn per branch not yet
// `distilled` (MODE=branch, skill `app-context-distill`) writes
// `_branches/<slug>.md`; once EVERY branch in the manifest is `distilled`,
// one more agent turn (MODE=reduce) writes `_overview.md`. Each output is
// validated deterministically (app-distill-validate.ts) before its state
// flips to `distilled` — a failed validation (or a failed agent run) leaves
// the branch's PRE-attempt state untouched ("giữ nguyên") and surfaces the
// error via `getDistillProgress`.
//
// The actual "run one agent turn to completion" step is injected
// (`AppDistillDeps.runTask`) rather than hard-coded here: the real
// implementation (server.ts) wires it to the daemon's existing fan-out
// primitives (design.runs + startChatRun — see prd-review-fanout in
// server.ts for the shape this mirrors), while tests inject a fake so the
// state machine / incremental selection / validation wiring is verifiable
// without spawning a real agent.

import fs from 'node:fs';

import {
  branchesNeedingDistill,
  branchFilePath,
  isPoolClean,
  markBranchDistilled,
  overviewPath,
  pagesForBranch,
  pendingCount,
  readManifest,
  setBranchState,
  writeIndexMd,
  writeManifest,
  type AppPoolManifest,
  type DistillState,
} from './app-pool.js';
import { validateBranch, validateOverview } from './app-distill-validate.js';

export interface DistillTask {
  kind: 'branch' | 'reduce';
  /** Present when `kind === 'branch'`. */
  branch?: string;
}

export interface AppDistillDeps {
  projectsDir: string;
  /** Run ONE distill task (a branch write, or the final reduce) to
   *  completion. Resolves 'succeeded'/'failed' on the AGENT run itself —
   *  content validation happens separately, after, against the file the
   *  task was supposed to write. Must not throw for an ordinary agent
   *  failure (resolve 'failed' instead); a thrown error aborts the whole
   *  distill job. */
  runTask(appId: string, task: DistillTask): Promise<'succeeded' | 'failed'>;
}

export interface DistillProgress {
  running: boolean;
  done: number;
  total: number;
  branches: string[];
  error?: string;
}

// In-memory only (§2.1's manifest schema has no top-level progress field —
// it is pinned and per-page only); a daemon restart mid-distill simply loses
// the live progress readout, same as any other in-flight run's transient
// state (see pipelineCancelers in server.ts for the same pattern).
const progressByApp = new Map<string, DistillProgress>();

export function getDistillProgress(appId: string): DistillProgress | undefined {
  return progressByApp.get(appId);
}

export function isDistillRunning(appId: string): boolean {
  return progressByApp.get(appId)?.running === true;
}

class DistillConflictError extends Error {
  code = 'CONFLICT' as const;
  constructor() {
    super('distill already running for this app');
  }
}

/** §2.2 POST …/distill: select the branches that need (re)distilling and run
 *  them (+ a final reduce once every branch is clean), in the background.
 *  Returns immediately with the branches selected; throws DistillConflictError
 *  (routes map to 409) if a distill is already running for this app. */
export interface EnsureDistilledResult {
  ok: boolean;
  error?: string;
}

export interface EnsureDistilledOptions {
  pollMs?: number;
  timeoutMs?: number;
}

/** Ensure the app pool is clean, waiting for an in-flight job when needed. */
export async function ensureDistilled(
  appId: string,
  deps: AppDistillDeps,
  onProgress?: (p: DistillProgress) => void,
  opts: EnsureDistilledOptions = {},
): Promise<EnsureDistilledResult> {
  const pollMs = opts.pollMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 3_600_000;
  let manifest = await readManifest(deps.projectsDir, appId);
  if (isPoolClean(manifest)) return { ok: true };

  if (!isDistillRunning(appId)) {
    try {
      await startDistill(appId, deps);
    } catch (error) {
      if (!(error instanceof DistillConflictError)) throw error;
    }
  }

  const deadline = Date.now() + timeoutMs;
  let previous: DistillProgress | undefined;
  while (isDistillRunning(appId)) {
    const progress = getDistillProgress(appId);
    if (progress && (!previous || progress.done !== previous.done || progress.total !== previous.total || progress.error !== previous.error || progress.branches.join('\0') !== previous.branches.join('\0'))) {
      onProgress?.(progress);
      previous = progress;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, error: 'Chưng cất quá 60 phút — kiểm tra agent rồi thử lại.' };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }

  const progress = getDistillProgress(appId);
  if (progress && (!previous || progress.done !== previous.done || progress.total !== previous.total || progress.error !== previous.error || progress.branches.join('\0') !== previous.branches.join('\0'))) {
    onProgress?.(progress);
  }
  manifest = await readManifest(deps.projectsDir, appId);
  if (isPoolClean(manifest)) return { ok: true };
  return {
    ok: false,
    error:
      progress?.error ??
      `Chưng cất chưa hoàn tất — còn ${pendingCount(manifest)} trang chưa chưng cất.`,
  };
}

export async function startDistill(
  appId: string,
  deps: AppDistillDeps,
): Promise<{ started: boolean; branches: string[] }> {
  if (isDistillRunning(appId)) throw new DistillConflictError();
  const manifest = await readManifest(deps.projectsDir, appId);
  const branches = branchesNeedingDistill(manifest);
  if (branches.length === 0) return { started: false, branches: [] };
  progressByApp.set(appId, { running: true, done: 0, total: branches.length + 1, branches });
  void runDistillJob(appId, branches, deps).catch((error) => {
    progressByApp.set(appId, {
      running: false,
      done: 0,
      total: branches.length + 1,
      branches,
      error: String((error as Error)?.message ?? error),
    });
  });
  return { started: true, branches };
}

async function runDistillJob(appId: string, branches: string[], deps: AppDistillDeps): Promise<void> {
  const progress = (): DistillProgress => progressByApp.get(appId)!;
  let manifest = await readManifest(deps.projectsDir, appId);
  let firstError: string | undefined;

  for (const branch of branches) {
    const pages = pagesForBranch(manifest, branch);
    // Snapshot each page's PRE-attempt state so a failure can revert exactly
    // ("giữ nguyên" — §WP-2), instead of collapsing every failure to one
    // fixed fallback state.
    const priorStates = new Map(pages.map((p) => [p.pageId, p.distill.state] as const));

    manifest = setBranchState(manifest, branch, 'distilling');
    await writeManifest(deps.projectsDir, appId, manifest);

    const revert = async (message: string) => {
      manifest = {
        ...manifest,
        pages: manifest.pages.map((p) =>
          p.branch === branch
            ? { ...p, distill: { ...p.distill, state: priorStates.get(p.pageId) ?? ('fetched' as DistillState) } }
            : p,
        ),
      };
      await writeManifest(deps.projectsDir, appId, manifest);
      firstError = firstError ?? message;
    };

    let agentStatus: 'succeeded' | 'failed';
    try {
      agentStatus = await deps.runTask(appId, { kind: 'branch', branch });
    } catch (error) {
      agentStatus = 'failed';
      console.warn(`[app-distill] branch "${branch}" agent run threw:`, error);
    }
    if (agentStatus !== 'succeeded') {
      await revert(`Nhánh "${branch}": lượt chạy agent thất bại.`);
    } else {
      const content = await fs.promises
        .readFile(branchFilePath(deps.projectsDir, appId, branch), 'utf8')
        .catch(() => null);
      if (content === null) {
        await revert(`Nhánh "${branch}": không tìm thấy file _branches/${branch}.md sau khi chạy.`);
      } else {
        const check = validateBranch(content, pages);
        if (!check.ok) {
          await revert(`Nhánh "${branch}": ${check.errors.join(' ')}`);
        } else {
          manifest = markBranchDistilled(manifest, branch);
          await writeManifest(deps.projectsDir, appId, manifest);
        }
      }
    }
    progressByApp.set(appId, { ...progress(), done: progress().done + 1 });
  }

  await writeIndexMd(deps.projectsDir, appId, manifest);

  // Reduce runs ONLY once the WHOLE pool (every branch, not just the ones
  // just processed) is clean — a branch this job could not fix must not be
  // papered over by an overview that claims full coverage.
  if (isPoolClean(manifest)) {
    let reduceStatus: 'succeeded' | 'failed';
    try {
      reduceStatus = await deps.runTask(appId, { kind: 'reduce' });
    } catch (error) {
      reduceStatus = 'failed';
      console.warn('[app-distill] reduce agent run threw:', error);
    }
    if (reduceStatus !== 'succeeded') {
      firstError = firstError ?? 'Tổng hợp _overview.md: lượt chạy agent thất bại.';
    } else {
      const content = await fs.promises.readFile(overviewPath(deps.projectsDir, appId), 'utf8').catch(() => null);
      if (content === null) {
        firstError = firstError ?? 'Tổng hợp _overview.md: không tìm thấy file sau khi chạy.';
      } else {
        const branchSlugs = [...new Set(manifest.pages.map((p) => p.branch))];
        const check = validateOverview(content, manifest.pages, branchSlugs);
        if (!check.ok) firstError = firstError ?? `_overview.md: ${check.errors.join(' ')}`;
      }
    }
  } else {
    firstError = firstError ?? 'Còn nhánh chưa chưng cất được — bỏ qua bước tổng hợp _overview.md.';
  }

  progressByApp.set(appId, {
    running: false,
    done: progress().done + 1,
    total: progress().total,
    branches,
    ...(firstError ? { error: firstError } : {}),
  });
}

export { DistillConflictError };
export type { AppPoolManifest };
