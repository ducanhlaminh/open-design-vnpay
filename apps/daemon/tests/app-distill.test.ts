import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DistillConflictError,
  getDistillProgress,
  startDistill,
  type AppDistillDeps,
  type DistillTask,
} from '../src/app-distill.js';
import {
  appDocsDir,
  branchFilePath,
  overviewPath,
  readManifest,
  writeManifest,
  sha256,
  type AppPoolManifest,
} from '../src/app-pool.js';

let projectsDir: string;
// `app-distill.ts`'s progress map is a MODULE-level singleton (by design —
// it mirrors the in-flight-run registries elsewhere in the daemon), so each
// test gets its OWN appId to avoid cross-test "distill already running"
// collisions within this file.
let appId: string;

function waitForIdle(id: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return (async function poll(): Promise<void> {
    const progress = getDistillProgress(id);
    if (!progress || progress.running === false) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for distill job to finish');
    await new Promise((r) => setTimeout(r, 5));
    return poll();
  })();
}

beforeEach(async () => {
  projectsDir = await mkdtemp(path.join(tmpdir(), 'od-app-distill-'));
  appId = `app-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterEach(async () => {
  // Every test either awaits the job to finish or resolves its fake runTask
  // before returning, but be defensive: give any straggling background write
  // a moment before the temp dir removal races it.
  await waitForIdle(appId, 500).catch(() => null);
  await rm(projectsDir, { recursive: true, force: true });
});

function page(id: string, branch: string, content = 'v1'): AppPoolManifest['pages'][number] {
  return {
    pageId: id,
    path: `${branch}/${id}.md`,
    title: `Page ${id}`,
    branch,
    contentHash: sha256(content),
    fetchedAt: 1000,
    distill: { state: 'fetched', distilledHash: null },
  };
}

const VALID_BRANCH_DOC = (branch: string, pages: string[]) =>
  [
    `# ${branch}`,
    '',
    '| Path | Chức năng | Keywords |',
    '| --- | --- | --- |',
    ...pages.map((p) => `| ${p} | Chức năng | kw |`),
    '',
  ].join('\n');

const VALID_OVERVIEW = (branches: string[], pages: string[]) =>
  [
    '## Cách dùng file này',
    'x',
    '',
    '## Dự án',
    'x',
    '',
    '## Phân hệ',
    '',
    '| Slug | Phân hệ | Phạm vi | Branch |',
    '| --- | --- | --- | --- |',
    ...branches.map((b) => `| ${b} | X | X | ${b} |`),
    '',
    '## Luồng nghiệp vụ xuyên trang',
    'x',
    '',
    '## Thuật ngữ',
    'x',
    '',
    '## Bản đồ trang',
    '',
    '| Path | Nội dung | Keywords |',
    '| --- | --- | --- |',
    ...pages.map((p) => `| ${p} | X | kw |`),
    '',
  ].join('\n');

describe('app-distill — incremental branch selection', () => {
  it('startDistill selects only branches with ≥1 non-clean page', async () => {
    const manifest: AppPoolManifest = {
      version: 1,
      pages: [
        { ...page('1', 'a'), distill: { state: 'distilled', distilledHash: sha256('v1') } },
        page('2', 'b'), // fetched — needs distilling
      ],
    };
    await writeManifest(projectsDir, appId, manifest);
    const runTask = vi.fn(async () => 'failed' as const);
    const result = await startDistill(appId, { projectsDir, runTask });
    expect(result).toEqual({ started: true, branches: ['b'] });
    await waitForIdle(appId);
  });

  it('no branches need distilling → started:false, runTask never called', async () => {
    const manifest: AppPoolManifest = {
      version: 1,
      pages: [{ ...page('1', 'a'), distill: { state: 'distilled', distilledHash: sha256('v1') } }],
    };
    await writeManifest(projectsDir, appId, manifest);
    const runTask = vi.fn(async () => 'succeeded' as const);
    const result = await startDistill(appId, { projectsDir, runTask });
    expect(result).toEqual({ started: false, branches: [] });
    expect(runTask).not.toHaveBeenCalled();
  });

  it('a second start while one is running throws DistillConflictError (409 at the route)', async () => {
    const manifest: AppPoolManifest = { version: 1, pages: [page('1', 'a')] };
    await writeManifest(projectsDir, appId, manifest);
    // A FIXED (not re-created per call) deferred gate: resolving it before
    // `runTask` is even invoked is fine — an already-resolved promise still
    // awaits cleanly — so this is race-free regardless of when the
    // background job actually reaches its `runTask` call.
    let resolveTask: (v: 'succeeded' | 'failed') => void = () => {};
    const gate = new Promise<'succeeded' | 'failed'>((resolve) => {
      resolveTask = resolve;
    });
    const runTask = vi.fn(async () => gate);
    await startDistill(appId, { projectsDir, runTask });
    await expect(startDistill(appId, { projectsDir, runTask })).rejects.toBeInstanceOf(DistillConflictError);
    resolveTask('failed');
    await waitForIdle(appId);
  });
});

describe('app-distill — state machine (validate → distilled / revert on failure)', () => {
  it('a branch whose agent run succeeds AND validates flips every page to distilled', async () => {
    const manifest: AppPoolManifest = { version: 1, pages: [page('1', 'a'), page('2', 'a')] };
    await writeManifest(projectsDir, appId, manifest);

    const runTask: AppDistillDeps['runTask'] = async (_id, task: DistillTask) => {
      if (task.kind === 'branch') {
        await mkdir(path.dirname(branchFilePath(projectsDir, appId, task.branch!)), { recursive: true });
        await writeFile(
          branchFilePath(projectsDir, appId, task.branch!),
          VALID_BRANCH_DOC('a', ['a/1.md', 'a/2.md']),
        );
        return 'succeeded';
      }
      await writeFile(overviewPath(projectsDir, appId), VALID_OVERVIEW(['a'], ['a/1.md', 'a/2.md']));
      return 'succeeded';
    };

    await startDistill(appId, { projectsDir, runTask });
    await waitForIdle(appId);

    const after = await readManifest(projectsDir, appId);
    expect(after.pages.every((p) => p.distill.state === 'distilled' && p.distill.distilledHash === p.contentHash)).toBe(
      true,
    );
    const progress = getDistillProgress(appId);
    expect(progress?.error).toBeUndefined();
  });

  it('a failed agent run reverts the branch to its PRE-attempt state and surfaces an error', async () => {
    const manifest: AppPoolManifest = { version: 1, pages: [page('1', 'a')] };
    await writeManifest(projectsDir, appId, manifest);
    const runTask: AppDistillDeps['runTask'] = async () => 'failed';

    await startDistill(appId, { projectsDir, runTask });
    await waitForIdle(appId);

    const after = await readManifest(projectsDir, appId);
    expect(after.pages[0]!.distill.state).toBe('fetched'); // reverted, not stuck at 'distilling'
    expect(getDistillProgress(appId)?.error).toMatch(/agent run thất bại|thất bại/i);
  });

  it('an agent run that succeeds but writes an INVALID branch doc keeps the branch NOT distilled', async () => {
    const manifest: AppPoolManifest = { version: 1, pages: [page('1', 'a'), page('2', 'a')] };
    await writeManifest(projectsDir, appId, manifest);
    const runTask: AppDistillDeps['runTask'] = async (_id, task) => {
      if (task.kind !== 'branch') return 'failed';
      // Missing page "a/2.md" from the table — validateBranch must reject it.
      await mkdir(path.dirname(branchFilePath(projectsDir, appId, task.branch!)), { recursive: true });
      await writeFile(branchFilePath(projectsDir, appId, task.branch!), VALID_BRANCH_DOC('a', ['a/1.md']));
      return 'succeeded';
    };

    await startDistill(appId, { projectsDir, runTask });
    await waitForIdle(appId);

    const after = await readManifest(projectsDir, appId);
    expect(after.pages.some((p) => p.distill.state === 'distilled')).toBe(false);
    expect(getDistillProgress(appId)?.error).toMatch(/missing path/i);
  });

  it('reduce runs ONLY once every branch (not just the ones just processed) is distilled', async () => {
    // Branch "a" is already distilled from a PRIOR run; this job only
    // (re)processes "b" — reduce must still see the pool as a whole.
    const manifest: AppPoolManifest = {
      version: 1,
      pages: [
        { ...page('1', 'a'), distill: { state: 'distilled', distilledHash: sha256('v1') } },
        page('2', 'b'),
      ],
    };
    await writeManifest(projectsDir, appId, manifest);
    // Pre-write branch "a"'s file (from the earlier run) so the reduce step
    // can read it.
    await mkdir(appDocsDir(projectsDir, appId), { recursive: true });
    await mkdir(path.dirname(branchFilePath(projectsDir, appId, 'a')), { recursive: true });
    await writeFile(branchFilePath(projectsDir, appId, 'a'), VALID_BRANCH_DOC('a', ['a/1.md']));

    const reduceCalled = vi.fn();
    const runTask: AppDistillDeps['runTask'] = async (_id, task) => {
      if (task.kind === 'branch') {
        await mkdir(path.dirname(branchFilePath(projectsDir, appId, task.branch!)), { recursive: true });
        await writeFile(branchFilePath(projectsDir, appId, task.branch!), VALID_BRANCH_DOC('b', ['b/2.md']));
        return 'succeeded';
      }
      reduceCalled();
      await writeFile(overviewPath(projectsDir, appId), VALID_OVERVIEW(['a', 'b'], ['a/1.md', 'b/2.md']));
      return 'succeeded';
    };

    const result = await startDistill(appId, { projectsDir, runTask });
    expect(result.branches).toEqual(['b']); // "a" was already distilled — incremental selection.
    await waitForIdle(appId);
    expect(reduceCalled).toHaveBeenCalledTimes(1);
    expect(await readFile(overviewPath(projectsDir, appId), 'utf8')).toContain('## Bản đồ trang');
  });

  it('when a branch fails to validate, reduce is SKIPPED entirely', async () => {
    const manifest: AppPoolManifest = { version: 1, pages: [page('1', 'a')] };
    await writeManifest(projectsDir, appId, manifest);
    const reduceCalled = vi.fn();
    const runTask: AppDistillDeps['runTask'] = async (_id, task) => {
      if (task.kind === 'reduce') {
        reduceCalled();
        return 'succeeded';
      }
      return 'failed'; // branch agent run fails → pool never becomes clean
    };
    await startDistill(appId, { projectsDir, runTask });
    await waitForIdle(appId);
    expect(reduceCalled).not.toHaveBeenCalled();
    expect(getDistillProgress(appId)?.error).toBeTruthy();
  });
});
