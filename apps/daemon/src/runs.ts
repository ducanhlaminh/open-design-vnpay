// @ts-nocheck
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { isProcessAlive, listProcessSnapshots, waitForProcessExit } from '@open-design/platform';
import { killSandboxContainer } from './agent-sandbox.js';

export const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractErrorDetails(data) {
  const payload = data && typeof data === 'object' ? data : {};
  const nested = payload.error && typeof payload.error === 'object' ? payload.error : {};
  return {
    error: readString(nested.message) ?? readString(payload.message),
    errorCode: readString(nested.code) ?? readString(payload.code),
  };
}

// ── WP3: host-run process-tree lifecycle ──────────────────────────────────
// specs/change/20260813-web-first/wp3-process-lifecycle.md
//
// Docker gives sandboxed runs process-group kill + wall-clock timeout +
// orphan sweep for free (`docker kill` tears down the whole container in
// one call). Host runs get the same three guarantees reproduced here
// without Docker:
//   1. `server.ts` spawns host runs with `detached: true` on POSIX, which
//      makes `child.pid` the process GROUP id too — `process.kill(-pid,
//      signal)` below reaches the agent CLI AND every descendant it spawns
//      (MCP stdio servers, vite, python, ...), not just the direct child.
//   2. `scheduleHostRunTimeout` — a wall-clock ceiling mirroring the
//      sandbox's `sandbox.timeoutMinutes` cap.
//   3. `attachHostChild` / `sweepOrphanHostRuns` — a pid-file per run under
//      `<OD_DATA_DIR>/runs/` so a daemon restart mid-run can still find and
//      reap the orphaned tree at boot (run state itself is in-memory only).

const HOST_KILL_GRACE_MS = 5_000;
const HOST_KILL_FORCE_WAIT_MS = 500;
const HOST_RUN_PID_FILE_SUFFIX = '.json';

// POSIX only: `-pid` targets the whole process GROUP when `pid` is the
// group leader (true whenever the process was spawned with `detached:
// true`, as host runs are — see server.ts). Falls back to a direct
// single-pid signal if the group is somehow gone (ESRCH) so a lingering
// direct child still gets the signal.
function signalProcessGroupOrPid(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

// Windows has no process-group signal Node can reach, so best-effort walk
// the OS-tracked parent/child tree instead. Daemon dev on Windows is not
// the packaged end-user target, so this stays a single best-effort call —
// no separate SIGTERM/SIGKILL escalation (per WP3 design §1).
function killWindowsProcessTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
  });
}

// Kill an entire host-run process tree BY PID: signal the group, wait up to
// `graceMs`, escalate to SIGKILL if anything is still alive. Used both by
// the live kill-tree helper below (real run, real OS pid) and by the boot
// sweep (pid recovered from a pid-file after a daemon restart) — the
// process's group membership is a kernel-level attribute of the pid and
// survives the ORIGINAL daemon process dying, so the same mechanism works
// for both callers.
async function killHostProcessTreeByPid(pid, { graceMs = HOST_KILL_GRACE_MS } = {}) {
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return;
  if (process.platform === 'win32') {
    await killWindowsProcessTree(pid);
    return;
  }
  if (!isProcessAlive(pid)) return;
  signalProcessGroupOrPid(pid, 'SIGTERM');
  const exited = await waitForProcessExit(pid, graceMs);
  if (!exited) {
    signalProcessGroupOrPid(pid, 'SIGKILL');
    await waitForProcessExit(pid, HOST_KILL_FORCE_WAIT_MS);
  }
}

function hostRunPidFilePath(runsDir, runId) {
  return path.join(runsDir, `${runId}${HOST_RUN_PID_FILE_SUFFIX}`);
}

async function writeHostRunPidFile(runsDir, runId, pid, command) {
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return;
  try {
    await fsp.mkdir(runsDir, { recursive: true });
    await fsp.writeFile(
      hostRunPidFilePath(runsDir, runId),
      JSON.stringify({ runId, pid, command: command ?? null, startedAt: Date.now() }),
      'utf8',
    );
  } catch {
    // Best-effort bookkeeping only — a missed write just means this one run
    // won't be caught by the NEXT boot's orphan sweep if the daemon dies
    // mid-run; the live kill path (killRunProcessTree) is unaffected.
  }
}

async function removeHostRunPidFile(runsDir, runId) {
  try {
    await fsp.rm(hostRunPidFilePath(runsDir, runId), { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Boot-time orphan sweep for host runs (WP3 design §3). Run state is
 * in-memory, so ANY pid-file left on disk when a daemon starts belongs to a
 * run whose PREVIOUS daemon process already died — same reasoning as the
 * sandbox container sweep in server.ts. Cross-checks the live process's
 * command line (via `@open-design/platform#listProcessSnapshots`, the
 * package's existing generic `ps`/CIM process-table primitive) against what
 * was recorded when the pid-file was written, so a pid recycled by an
 * unrelated process (e.g. after a machine restart) is skipped instead of
 * killed blind.
 */
async function sweepOrphanHostRunProcessGroups(runsDir) {
  let entries;
  try {
    entries = await fsp.readdir(runsDir);
  } catch {
    return [];
  }
  let snapshots = null;
  const swept = [];
  for (const entry of entries) {
    if (!entry.endsWith(HOST_RUN_PID_FILE_SUFFIX)) continue;
    const filePath = path.join(runsDir, entry);
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const stamp = JSON.parse(raw);
      const pid = Number(stamp?.pid);
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        if (stamp.command) {
          snapshots ??= await listProcessSnapshots();
          const live = snapshots.find((p) => p.pid === pid);
          if (!live || !live.command.includes(stamp.command)) {
            // Pid recycled by something else since the stamp was written —
            // do not kill an unrelated process, just clean up the stale file.
            await fsp.rm(filePath, { force: true }).catch(() => {});
            continue;
          }
        }
        await killHostProcessTreeByPid(pid, { graceMs: HOST_KILL_GRACE_MS });
        swept.push({ runId: stamp.runId ?? entry, pid });
      }
    } catch {
      // Corrupt/partial pid-file — best-effort skip, file removed below.
    }
    await fsp.rm(filePath, { force: true }).catch(() => {});
  }
  return swept;
}

export function createChatRunService({
  createSseResponse,
  createSseErrorPayload,
  maxEvents = 2_000,
  ttlMs = 30 * 60 * 1000,
  shutdownGraceMs = 3_000,
  // WP3: directory for per-host-run pid-files (`<OD_DATA_DIR>/runs/`).
  // `null` disables persistence entirely (e.g. unit tests constructing this
  // service without a real data dir) — `attachHostChild`/`sweepOrphanHostRuns`
  // become no-ops, matching pre-WP3 behavior.
  runsStateDir = null,
}) {
  const runs = new Map();

  const create = (meta = {}) => {
    const now = Date.now();
    const run = {
      id: randomUUID(),
      projectId: typeof meta.projectId === 'string' && meta.projectId ? meta.projectId : null,
      conversationId: typeof meta.conversationId === 'string' && meta.conversationId ? meta.conversationId : null,
      assistantMessageId: typeof meta.assistantMessageId === 'string' && meta.assistantMessageId ? meta.assistantMessageId : null,
      clientRequestId: typeof meta.clientRequestId === 'string' && meta.clientRequestId ? meta.clientRequestId : null,
      agentId: typeof meta.agentId === 'string' && meta.agentId ? meta.agentId : null,
      // Plan §3.A1 / spec §11.5. The applied plugin snapshot id pins
      // every prompt fragment and tool gate to a frozen view so replay
      // is byte-equal across plugin upgrades. Runs are in-memory in
      // v1 — the id lives on the run object plus on the
      // `applied_plugin_snapshots` row (FK back via run_id).
      appliedPluginSnapshotId:
        typeof meta.appliedPluginSnapshotId === 'string' && meta.appliedPluginSnapshotId
          ? meta.appliedPluginSnapshotId
          : null,
      pluginId:
        typeof meta.pluginId === 'string' && meta.pluginId ? meta.pluginId : null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      events: [],
      nextEventId: 1,
      clients: new Set(),
      waiters: new Set(),
      child: null,
      acpSession: null,
      exitCode: null,
      signal: null,
      error: null,
      errorCode: null,
      cancelRequested: false,
    };
    runs.set(run.id, run);
    return run;
  };

  const get = (id) => runs.get(id) ?? null;

  const scheduleCleanup = (run) => {
    setTimeout(() => {
      if (TERMINAL_RUN_STATUSES.has(run.status)) runs.delete(run.id);
    }, ttlMs).unref?.();
  };

  const emit = (run, event, data) => {
    if (event === 'error') {
      const details = extractErrorDetails(data);
      if (details.error) run.error = details.error;
      if (details.errorCode) run.errorCode = details.errorCode;
    }
    const id = run.nextEventId++;
    const record = { id, event, data, timestamp: Date.now() };
    run.events.push(record);
    if (run.events.length > maxEvents) run.events.splice(0, run.events.length - maxEvents);
    run.updatedAt = Date.now();
    for (const sse of run.clients) sse.send(event, data, id);
    return record;
  };

  const statusBody = (run) => ({
    id: run.id,
    projectId: run.projectId,
    conversationId: run.conversationId,
    assistantMessageId: run.assistantMessageId,
    agentId: run.agentId,
    appliedPluginSnapshotId: run.appliedPluginSnapshotId ?? null,
    pluginId: run.pluginId ?? null,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    exitCode: run.exitCode,
    signal: run.signal,
    error: run.error ?? null,
    errorCode: run.errorCode ?? null,
  });

  const finish = (run, status, code: number | null = null, signal: string | null = null) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    run.status = status;
    run.exitCode = code;
    run.signal = signal;
    run.updatedAt = Date.now();
    emit(run, 'end', { code, signal, status });
    for (const sse of run.clients) sse.end();
    run.clients.clear();
    for (const waiter of run.waiters) waiter(statusBody(run));
    run.waiters.clear();
    scheduleCleanup(run);
  };

  const fail = (run, code, message, init = {}) => {
    emit(run, 'error', createSseErrorPayload(code, message, init));
    finish(run, 'failed', 1, null);
  };

  const start = (run, starter) => {
    void starter(run).catch((err) => {
      fail(run, 'AGENT_EXECUTION_FAILED', err instanceof Error ? err.message : String(err));
    });
    return run;
  };

  const stream = (run, req, res) => {
    const sse = createSseResponse(res);
    const lastEventId = Number(req.get('Last-Event-ID') || req.query.after || 0);
    let sent = 0;
    for (const record of run.events) {
      if (!Number.isFinite(lastEventId) || record.id > lastEventId) {
        sse.send(record.event, record.data, record.id);
        sent++;
      }
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      // Guarantee a reattaching client sees a terminal signal even if its
      // cursor is at or past the final event id — otherwise the SSE
      // stream ends silently and the client falls back to status-only fetch.
      if (sent === 0 && run.events.length > 0) {
        const last = run.events[run.events.length - 1];
        sse.send(last.event, last.data, last.id);
      }
      sse.end();
      return;
    }
    run.clients.add(sse);
    res.on('close', () => {
      run.clients.delete(sse);
      sse.cleanup();
    });
  };

  const list = ({ projectId, conversationId, status } = {}) => Array.from(runs.values()).filter((run) => {
    if (typeof projectId === 'string' && projectId && run.projectId !== projectId) return false;
    if (typeof conversationId === 'string' && conversationId && run.conversationId !== conversationId) return false;
    if (status === 'active') return !TERMINAL_RUN_STATUSES.has(run.status);
    if (typeof status === 'string' && status) return run.status === status;
    return true;
  });

  const waitForChildExit = (child, timeoutMs) => {
    if (!child) return Promise.resolve(true);
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off?.('close', onClose);
        child.off?.('exit', onClose);
        resolve(exited);
      };
      const onClose = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      timer.unref?.();
      child.once?.('close', onClose);
      child.once?.('exit', onClose);
    });
  };

  const killChild = (run, signal) => {
    if (!run.child || run.child.exitCode !== null || run.child.signalCode !== null) return false;
    try {
      return run.child.kill(signal);
    } catch {
      return false;
    }
  };

  /**
   * Kill an ENTIRE host-run process tree, not just the direct agent CLI
   * child — WP3 design §1. ONLY for the host branch
   * (`!run.sandboxContainerName`): a sandboxed run's `run.child` is the
   * docker CLIENT process, which is not detached and does not lead its own
   * process group, so a negative-pid signal there would be meaningless (or
   * could hit an unrelated group). Sandbox cleanup keeps its existing
   * `killSandboxContainer` + direct `child.kill` path, untouched by this WP.
   *
   * Always also drives the direct child through `killChild` (in addition to
   * the OS-level group/tree signal) so callers that observe `child.kill()`
   * — including in-memory tests that fake a child without a real OS pid —
   * see the exact same signal sequence this module used before WP3.
   */
  const killRunProcessTree = async (run, { graceMs = HOST_KILL_GRACE_MS } = {}) => {
    if (!run || !run.child || run.sandboxContainerName) return;
    const signalTree = (signal) => {
      const pid = run.child.pid;
      if (typeof pid === 'number' && Number.isFinite(pid)) {
        if (process.platform === 'win32') {
          void killWindowsProcessTree(pid);
        } else {
          signalProcessGroupOrPid(pid, signal);
        }
      }
      killChild(run, signal);
    };
    signalTree('SIGTERM');
    if (!(await waitForChildExit(run.child, graceMs))) {
      signalTree('SIGKILL');
      await waitForChildExit(run.child, HOST_KILL_FORCE_WAIT_MS);
    }
  };

  /**
   * Wires a freshly spawned HOST child onto the run and records its pid
   * (WP3 design §3) so a daemon restart mid-run can still find and reap it
   * at boot. Sandboxed runs do NOT go through this — server.ts assigns
   * `run.child = child` directly for those, matching pre-WP3 behavior.
   */
  const attachHostChild = (run, child, { command } = {}) => {
    run.child = child;
    if (!runsStateDir || typeof child.pid !== 'number') return;
    void writeHostRunPidFile(runsStateDir, run.id, child.pid, command);
    child.once('close', () => {
      void removeHostRunPidFile(runsStateDir, run.id);
    });
  };

  /** Boot-time orphan sweep entry point — see `sweepOrphanHostRunProcessGroups`. */
  const sweepOrphanHostRuns = () => {
    if (!runsStateDir) return Promise.resolve([]);
    return sweepOrphanHostRunProcessGroups(runsStateDir);
  };

  /**
   * Wall-clock cap for a HOST run (WP3 design §2) — mirrors the sandbox
   * container's existing `sandbox.timeoutMinutes` ceiling so a runaway host
   * agent can't sit on CPU/RAM forever. The inactivity watchdog elsewhere in
   * server.ts only fires on *silence*; this fires on elapsed wall-clock time
   * regardless of activity. No-ops once the run is already terminal (normal
   * completion racing the timer) and clears itself when the child closes.
   */
  const scheduleHostRunTimeout = (run, { timeoutMs, timeoutMinutes, send, createSseErrorPayload: makeErrorPayload } = {}) => {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return () => {};
    const timer = setTimeout(() => {
      if (TERMINAL_RUN_STATUSES.has(run.status)) return;
      if (typeof send === 'function' && typeof makeErrorPayload === 'function') {
        send('error', makeErrorPayload(
          'AGENT_EXECUTION_FAILED',
          `Run exceeded ${timeoutMinutes} minute${timeoutMinutes === 1 ? '' : 's'} and was killed (sandbox.timeoutMinutes).`,
        ));
      }
      void (async () => {
        await killRunProcessTree(run);
        finish(run, 'failed', null, 'SIGTERM');
      })();
    }, timeoutMs);
    timer.unref?.();
    const clear = () => clearTimeout(timer);
    if (run.child) run.child.once('close', clear);
    return clear;
  };

  const cancel = (run) => {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      run.cancelRequested = true;
      run.updatedAt = Date.now();
      // Prefer RPC-level abort for agents that support it (pi, ACP adapters).
      // abort() sends the graceful shutdown signal; cancel() owns the
      // SIGTERM fallback so that a misbehaving session can't leave the
      // child alive indefinitely.
      if (run.acpSession?.abort) {
        run.acpSession.abort();
        const graceMs = Number(process.env.PI_ABORT_GRACE_MS) || 3000;
        setTimeout(() => {
          if (!run.child || run.child.killed) return;
          if (run.sandboxContainerName) {
            run.child.kill('SIGTERM');
          } else {
            // WP3: same host kill-tree path as the branch below, so a
            // stubborn pi/ACP child's MCP stdio / vite / python
            // descendants don't outlive it either.
            void killRunProcessTree(run);
          }
        }, graceMs).unref();
      } else if (run.child && !run.child.killed) {
        // Sandboxed runs: run.child is the docker CLIENT. The attached CLI
        // proxies SIGTERM into the container, but if the client dies before
        // the container exits (or gets SIGKILLed later) the container would
        // linger — kill it by name as well; `docker run --rm` then reaps it
        // and the client's close path finishes the run normally.
        if (run.sandboxContainerName) {
          void killSandboxContainer(run.sandboxContainerName);
          run.child.kill('SIGTERM');
        } else {
          // WP3: host runs — kill the whole process GROUP (agent CLI +
          // every descendant it spawned), not just the direct child.
          void killRunProcessTree(run);
        }
      } else {
        finish(run, 'canceled', null, 'SIGTERM');
      }
    }
  };

  const shutdownActive = async ({ graceMs = shutdownGraceMs } = {}) => {
    const activeRuns = Array.from(runs.values()).filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
    await Promise.all(activeRuns.map(async (run) => {
      run.cancelRequested = true;
      run.updatedAt = Date.now();
      if (run.acpSession?.abort) {
        try {
          run.acpSession.abort();
        } catch {
          // Process signals below are the shutdown fallback.
        }
      }
      if (run.sandboxContainerName) {
        // Sandboxed runs: also kill the container by name — SIGKILL on the
        // docker client below would otherwise leave the container running
        // (the startup orphan sweep is the backstop, not the plan).
        void killSandboxContainer(run.sandboxContainerName);
        killChild(run, 'SIGTERM');
        finish(run, 'canceled', null, 'SIGTERM');
        if (run.child && !(await waitForChildExit(run.child, graceMs))) {
          killChild(run, 'SIGKILL');
          await waitForChildExit(run.child, 500);
        }
      } else {
        // WP3: host runs — the shared kill-tree helper already carries its
        // own SIGTERM → grace → SIGKILL escalation, so no separate
        // wait/escalate dance is needed here.
        finish(run, 'canceled', null, 'SIGTERM');
        await killRunProcessTree(run, { graceMs });
      }
    }));
  };

  const wait = (run) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return Promise.resolve(statusBody(run));
    return new Promise((resolve) => run.waiters.add(resolve));
  };

  return {
    create,
    start,
    get,
    list,
    stream,
    cancel,
    shutdownActive,
    wait,
    emit,
    finish,
    fail,
    statusBody,
    isTerminal(status) {
      return TERMINAL_RUN_STATUSES.has(status);
    },
    killRunProcessTree,
    attachHostChild,
    sweepOrphanHostRuns,
    scheduleHostRunTimeout,
  };
}
