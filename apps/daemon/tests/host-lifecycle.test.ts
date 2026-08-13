// WP3 — specs/change/20260813-web-first/wp3-process-lifecycle.md
//
// Host chat runs get no `docker kill`-style safety net for free the way
// sandboxed runs do: no process-group kill, no wall-clock cap, no orphan
// sweep at boot. These specs pin the three `runs.ts` primitives that
// reproduce those guarantees for the host branch — `killRunProcessTree`,
// `scheduleHostRunTimeout`, and `attachHostChild` / `sweepOrphanHostRuns`.
//
// Every test spawns a REAL detached `sh` process that backgrounds a `sleep`
// grandchild (mirroring exactly how server.ts spawns a host run — WP3
// design §1) so the assertions exercise the actual `process.kill(-pid,
// signal)` process-GROUP kill path, not a mocked stand-in.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChatRunService } from '../src/runs.js';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  { timeoutMs = 4_000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!(await condition())) {
    throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
  }
}

type FakeTree = { child: ChildProcess; shPid: number; sleepPid: number };

/**
 * Spawns a real detached `sh` process whose only action is to background a
 * `sleep` grandchild — the same shape server.ts's host branch spawns
 * (`detached: true`, agent CLI process potentially forking further
 * children). Prints "<shPid> <sleepPid>" on one stdout line so the test can
 * assert on both pids without re-implementing process-tree discovery.
 */
async function spawnFakeProcessTree(): Promise<FakeTree> {
  const child = spawn('sh', ['-c', 'sleep 60 & echo "$$ $!"; wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const [shPid, sleepPid] = await new Promise<[number, number]>((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex).trim();
      const match = /^(\d+)\s+(\d+)$/.exec(line);
      if (match) {
        child.stdout?.off('data', onData);
        resolve([Number(match[1]), Number(match[2])]);
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', reject);
    setTimeout(() => reject(new Error('timed out waiting for fake process tree pids')), 4_000).unref();
  });
  return { child, shPid, sleepPid };
}

const createRuns = (extra: Record<string, unknown> = {}) =>
  createChatRunService({
    createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    ttlMs: 60_000,
    shutdownGraceMs: 10,
    ...extra,
  });

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTempRunsDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

describe('host run process-tree lifecycle (WP3)', () => {
  it('killRunProcessTree kills the whole spawned tree, not just the direct child', async () => {
    const runs = createRuns();
    const { child, shPid, sleepPid } = await spawnFakeProcessTree();
    expect(isAlive(shPid)).toBe(true);
    expect(isAlive(sleepPid)).toBe(true);

    await runs.killRunProcessTree({ child });

    await waitUntil(() => !isAlive(shPid) && !isAlive(sleepPid));
    expect(isAlive(shPid)).toBe(false);
    expect(isAlive(sleepPid)).toBe(false);
  });

  it('killRunProcessTree is a no-op for sandboxed runs (sandboxContainerName set)', async () => {
    const runs = createRuns();
    const { child, shPid, sleepPid } = await spawnFakeProcessTree();
    try {
      await runs.killRunProcessTree({ child, sandboxContainerName: 'od-sandbox-fake' });
      // Sandbox cleanup is NOT this helper's job (WP3 design §1) — the tree
      // must still be alive afterward.
      expect(isAlive(shPid)).toBe(true);
      expect(isAlive(sleepPid)).toBe(true);
    } finally {
      await runs.killRunProcessTree({ child });
      await waitUntil(() => !isAlive(shPid) && !isAlive(sleepPid));
    }
  });

  it('scheduleHostRunTimeout closes the run as failed and kills the tree once the wall-clock cap elapses', async () => {
    const runs = createRuns();
    const run = runs.create({ projectId: 'p1' }) as any;
    run.status = 'running';
    const { child, shPid, sleepPid } = await spawnFakeProcessTree();
    run.child = child;

    const sentEvents: Array<{ event: string; data: unknown }> = [];
    runs.scheduleHostRunTimeout(run, {
      timeoutMs: 20,
      timeoutMinutes: 30,
      send: (event: string, data: unknown) => sentEvents.push({ event, data }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    });

    await waitUntil(() => run.status === 'failed');
    expect(run.status).toBe('failed');
    expect(
      sentEvents.some(
        (e) => e.event === 'error' && JSON.stringify(e.data).toLowerCase().includes('exceeded'),
      ),
    ).toBe(true);

    await waitUntil(() => !isAlive(shPid) && !isAlive(sleepPid));
  });

  it('scheduleHostRunTimeout does nothing once the run already finished naturally', async () => {
    const runs = createRuns();
    const run = runs.create() as any;
    run.status = 'running';
    const { child, shPid, sleepPid } = await spawnFakeProcessTree();
    run.child = child;

    const clear = runs.scheduleHostRunTimeout(run, {
      timeoutMs: 30,
      timeoutMinutes: 30,
      send: vi.fn(),
      createSseErrorPayload: vi.fn(),
    });
    runs.finish(run, 'succeeded', 0, null);
    clear();

    // Give the (cleared) timer's original delay window a chance to pass —
    // the tree must stay alive since the run is no longer active.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(isAlive(shPid)).toBe(true);
    expect(isAlive(sleepPid)).toBe(true);

    await runs.killRunProcessTree({ child });
    await waitUntil(() => !isAlive(shPid) && !isAlive(sleepPid));
  });

  it('sweepOrphanHostRuns kills a stamped process tree left by a previous daemon and clears its pid-file', async () => {
    const runsDir = await makeTempRunsDir('od-host-run-sweep-');
    const runs = createRuns({ runsStateDir: runsDir });
    const { shPid, sleepPid } = await spawnFakeProcessTree();
    const runId = 'orphan-run-1';
    const pidFilePath = path.join(runsDir, `${runId}.json`);
    await writeFile(
      pidFilePath,
      JSON.stringify({ runId, pid: shPid, command: 'sh', startedAt: Date.now() }),
      'utf8',
    );

    const swept = await runs.sweepOrphanHostRuns();

    expect(swept).toEqual([{ runId, pid: shPid }]);
    await waitUntil(() => !isAlive(shPid) && !isAlive(sleepPid));
    await expect(readFile(pidFilePath, 'utf8')).rejects.toThrow();
  });

  it('sweepOrphanHostRuns skips (and cleans up) a pid-file whose pid was recycled by an unrelated process', async () => {
    const runsDir = await makeTempRunsDir('od-host-run-sweep-recycled-');
    const runs = createRuns({ runsStateDir: runsDir });
    // The daemon's own pid is alive but its command line will never contain
    // this bogus marker — simulates a pid-file surviving a machine restart
    // long enough for the OS to hand the same pid to an unrelated process.
    const pidFilePath = path.join(runsDir, 'stale-run.json');
    await writeFile(
      pidFilePath,
      JSON.stringify({ runId: 'stale-run', pid: process.pid, command: 'od-definitely-not-this-process' }),
      'utf8',
    );

    const swept = await runs.sweepOrphanHostRuns();

    expect(swept).toEqual([]);
    expect(isAlive(process.pid)).toBe(true);
    await expect(readFile(pidFilePath, 'utf8')).rejects.toThrow();
  });

  it('sweepOrphanHostRuns is a no-op when no runsStateDir was configured', async () => {
    const runs = createRuns();
    await expect(runs.sweepOrphanHostRuns()).resolves.toEqual([]);
  });

  it('attachHostChild writes a pid-file that sweepOrphanHostRuns recovers after a simulated daemon restart', async () => {
    const runsDir = await makeTempRunsDir('od-host-run-attach-');
    const writerRuns = createRuns({ runsStateDir: runsDir });
    const run = writerRuns.create();
    const { child, shPid, sleepPid } = await spawnFakeProcessTree();
    writerRuns.attachHostChild(run, child, { command: 'sh' });

    const pidFilePath = path.join(runsDir, `${run.id}.json`);
    await waitUntil(async () => {
      try {
        await readFile(pidFilePath, 'utf8');
        return true;
      } catch {
        return false;
      }
    });

    // Simulate a daemon restart: a brand-new service instance (no in-memory
    // knowledge of `run`) sweeps the pid-file the old process left behind.
    const restartedRuns = createRuns({ runsStateDir: runsDir });
    const swept = await restartedRuns.sweepOrphanHostRuns();

    expect(swept).toEqual([{ runId: run.id, pid: shPid }]);
    await waitUntil(() => !isAlive(shPid) && !isAlive(sleepPid));
  });

  it('attachHostChild removes the pid-file once the child closes normally (no leftover for the next boot sweep)', async () => {
    const runsDir = await makeTempRunsDir('od-host-run-attach-close-');
    const runs = createRuns({ runsStateDir: runsDir });
    const run = runs.create();
    const child = spawn('sh', ['-c', 'exit 0'], { detached: true, stdio: 'ignore' });
    runs.attachHostChild(run, child, { command: 'sh' });

    const pidFilePath = path.join(runsDir, `${run.id}.json`);
    await waitUntil(async () => {
      try {
        await readFile(pidFilePath, 'utf8');
        return true;
      } catch {
        return false;
      }
    });

    await waitUntil(async () => {
      try {
        await readFile(pidFilePath, 'utf8');
        return false;
      } catch {
        return true;
      }
    });
  });
});
