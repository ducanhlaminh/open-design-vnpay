// Pipeline stage error reports → developers.
//
// Whenever a stage ends `failed` (db.ts setProjectPipelineStatus fires the
// failure hook), build one PipelineErrorReport — run metadata + failure
// reason + a redacted tail of the daemon log — write it to a local outbox
// (durable across restarts / offline), then upload it to the shared media
// store under the dedicated `__od-error-reports` folder where pipeline-
// studio lists it. Everything here is fire-and-forget: a report must never
// slow down, block or fail the run it describes.
//
// Rich per-run context (agent id, exit code, model, outputs summary…) is
// only known inside runPipeline's completion block (server.ts); it stashes
// that with `attachStageFailureContext()` right before it writes the
// failed status, and the hook merges it in. Deterministic (non-agent)
// failures simply report without it.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PipelineErrorReport } from '@open-design/contracts';
import { PIPELINE_ERROR_REPORTS_FOLDER, PIPELINE_ERROR_REPORTS_PREFIX } from '@open-design/contracts';
import { redactText } from '@open-design/diagnostics';
import { APP_KEYS, OPEN_DESIGN_SIDECAR_CONTRACT, SIDECAR_MODES, type SidecarStamp } from '@open-design/sidecar-proto';
import { resolveLogFilePath, resolveRuntimeNamespaceRoot, type SidecarRuntimeContext } from '@open-design/sidecar';
import { readAppConfig } from './app-config.js';
import { isPackagedRuntime, readCurrentAppVersionInfo } from './app-version.js';
import { getMachineUser } from './auth-routes.js';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';
import { redactSecrets } from './redact.js';

export const ERROR_REPORTS_OUTBOX_DIR = 'error-reports/outbox';
const LOG_TAIL_BYTES = 256 * 1024;
const LOG_TAIL_MAX_LINES = 250;
const LOG_TAIL_MAX_CHARS = 60_000;
const OUTBOX_MAX_FILES = 200;
const FLUSH_DELAY_MS = 30_000;
const CONTEXT_TTL_MS = 60_000;

export interface StageFailureContext {
  runId?: string;
  agentId?: string;
  model?: string | null;
  reasoning?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  errorCode?: string | null;
  durationMs?: number | null;
  outputs?: string | null;
  finalStatus?: string | null;
  stderrTail?: string | null;
  stdoutTail?: string | null;
  workflowId?: string | null;
}

const pendingContext = new Map<string, { at: number; ctx: StageFailureContext }>();

// ── Console tail (log fallback for launches without sidecar file logs) ────
// The host runtime (launchd / systemd / the Windows launcher — i.e. every
// prod install) has no `logs/daemon/latest.log`: stdout/stderr go wherever
// the service manager points them, which the daemon cannot read back. The
// first real prod report (Windows, 0.8.63) therefore arrived with
// `logTail: null` and nothing else to go on. Keep the last few hundred
// console lines in memory and use them whenever the file path is unknown or
// unreadable. Wrapping preserves the original console behaviour exactly.
const CONSOLE_TAIL_MAX_LINES = 400;
const consoleTail: string[] = [];
let consoleTailInstalled = false;

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
  } catch {
    return String(arg);
  }
}

export function pushConsoleTailLine(level: string, args: unknown[]): void {
  const stamp = new Date().toISOString();
  const text = args.map(formatConsoleArg).join(' ');
  for (const line of text.split('\n')) {
    consoleTail.push(`${stamp} [${level}] ${line}`);
  }
  if (consoleTail.length > CONSOLE_TAIL_MAX_LINES) consoleTail.splice(0, consoleTail.length - CONSOLE_TAIL_MAX_LINES);
}

/** Idempotent. Call once at daemon start, before anything worth logging. */
export function installConsoleTailCapture(target: Console = console): void {
  if (consoleTailInstalled) return;
  consoleTailInstalled = true;
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      try {
        pushConsoleTailLine(level, args);
      } catch {
        /* never let diagnostics break logging */
      }
      original(...args);
    };
  }
}

/** Snapshot of the in-memory console tail (tests + readLogTail fallback). */
export function consoleTailSnapshot(): string[] {
  return consoleTail.slice();
}

/** Tests only. */
export function resetConsoleTailForTests(): void {
  consoleTail.length = 0;
}

/** Called by runPipeline's completion block right BEFORE it writes the
 *  failed status, so the hook fired by that write can enrich the report. */
export function attachStageFailureContext(projectId: string, pipelineId: string, ctx: StageFailureContext): void {
  pendingContext.set(`${projectId} ${pipelineId}`, { at: Date.now(), ctx });
}

function takeStageFailureContext(projectId: string, pipelineId: string): StageFailureContext | null {
  const key = `${projectId} ${pipelineId}`;
  const entry = pendingContext.get(key);
  pendingContext.delete(key);
  if (!entry) return null;
  return Date.now() - entry.at <= CONTEXT_TTL_MS ? entry.ctx : null;
}

export function newErrorReportId(): string {
  return randomBytes(4).toString('hex');
}

/** `logs/daemon/latest.log` for this launch (null on a plain `od` launch —
 *  no sidecar runtime → no file logs, same caveat as diagnostics export). */
export function resolveDaemonLogPath(runtime: SidecarRuntimeContext<SidecarStamp> | null): string | null {
  if (!runtime) return null;
  try {
    const namespaceRoot = resolveRuntimeNamespaceRoot({
      contract: OPEN_DESIGN_SIDECAR_CONTRACT,
      runtime,
      runtimeMode: SIDECAR_MODES.RUNTIME,
    });
    return resolveLogFilePath({ app: APP_KEYS.DAEMON, contract: OPEN_DESIGN_SIDECAR_CONTRACT, runtimeRoot: namespaceRoot });
  } catch {
    return null;
  }
}

/** Last ~250 lines of the daemon log, secrets + home paths scrubbed. When a
 *  run id is known, prefer the window starting at its first mention so a
 *  long-running stage's own lines are not pushed out by later chatter. */
export async function readLogTail(logPath: string | null, runId?: string): Promise<string | null> {
  const fromFile = logPath ? await readLogTailFromFile(logPath, runId) : null;
  if (fromFile) return fromFile;
  return readLogTailFromConsole(runId);
}

function readLogTailFromConsole(runId?: string): string | null {
  if (consoleTail.length === 0) return null;
  let lines = consoleTail;
  if (runId) {
    const first = lines.findIndex((l) => l.includes(runId));
    if (first > 0) lines = lines.slice(Math.max(0, first - 20));
  }
  lines = lines.slice(-LOG_TAIL_MAX_LINES);
  let text = lines.join('\n');
  if (text.length > LOG_TAIL_MAX_CHARS) text = text.slice(-LOG_TAIL_MAX_CHARS);
  return scrub(text);
}

async function readLogTailFromFile(logPath: string, runId?: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(logPath, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    let lines = buf.toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1); // drop the cut first line
    if (runId) {
      const first = lines.findIndex((l) => l.includes(runId));
      if (first > 0) lines = lines.slice(Math.max(0, first - 20));
    }
    lines = lines.slice(-LOG_TAIL_MAX_LINES);
    let text = lines.join('\n');
    if (text.length > LOG_TAIL_MAX_CHARS) text = text.slice(-LOG_TAIL_MAX_CHARS);
    return scrub(text);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function scrub(text: string): string {
  let username: string | undefined;
  try {
    username = os.userInfo().username || undefined;
  } catch {
    username = undefined;
  }
  return redactText(redactSecrets(text), { username });
}

export interface ErrorReporterOptions {
  /** Daemon data dir — outbox lives at <dataDir>/error-reports/outbox. */
  dataDir: string;
  /** Path of logs/daemon/latest.log (null → no log tail). */
  logPath: string | null;
  namespace: string | null;
  /** Injectable for tests. */
  client?: Pick<MediaClient, 'uploadFile'>;
  identity?: () => Promise<{ user: string; installationId: string }>;
  version?: () => Promise<{ version: string; channel: string; packaged: boolean }>;
  projectName?: (projectId: string) => string | undefined;
  /** Latest run of a sub-conversation (fan-out fallback, see contextFromSubRuns). */
  subRunLookup?: (projectId: string, conversationId: string) => SubRunSnapshot | null;
  /** Workflow dir of a stage (fan-out fallback). */
  workflowIdOf?: (pipelineId: string) => string | null;
  now?: () => number;
  log?: (message: string) => void;
}

export type FailureInfo = {
  projectId: string;
  pipelineId: string;
  error: string | undefined;
  lastRunId: string | undefined;
  /** Fan-out stages: per-task conversations of the failing run. */
  subConversations?: Array<{ id: string; title: string; status: string }> | undefined;
};

/** What the reporter needs to know about one sub-run of a fan-out stage —
 *  a projection of design.runs' statusBody + the stderr/stdout tails the
 *  chat runner stashes on the run object. */
export interface SubRunSnapshot {
  id: string;
  agentId?: string | null;
  status?: string | null;
  error?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  errorCode?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  stderrTail?: string | null;
  stdoutTail?: string | null;
}

/** Fan-out fallback: when the failing stage attached no context (fan-out
 *  stages finish in daemon code, not in runPipeline's completion block),
 *  derive one from the latest run of every sub-conversation — which pages /
 *  screens failed, the first failure's error + exit code + stderr. */
export function contextFromSubRuns(
  info: FailureInfo,
  lookup: (projectId: string, conversationId: string) => SubRunSnapshot | null,
): { ctx: StageFailureContext; errorSuffix: string | null } | null {
  const tasks = info.subConversations ?? [];
  if (tasks.length === 0) return null;
  const rows = tasks.map((task) => {
    let run: SubRunSnapshot | null = null;
    try {
      run = lookup(info.projectId, task.id);
    } catch {
      run = null;
    }
    return { task, run };
  });
  const failed = rows.filter((r) => r.task.status === 'failed' || (r.run?.status && r.run.status !== 'succeeded' && r.run.status !== 'running' && r.run.status !== 'queued'));
  const firstFailedRun = failed.map((r) => r.run).find((r): r is SubRunSnapshot => Boolean(r)) ?? null;
  const anyRun = rows.map((r) => r.run).find((r): r is SubRunSnapshot => Boolean(r)) ?? null;
  const lines = rows.map(({ task, run }) => {
    const bits: string[] = [];
    if (run?.exitCode !== null && run?.exitCode !== undefined) bits.push(`exit ${run.exitCode}`);
    if (run?.signal) bits.push(`signal ${run.signal}`);
    if (run?.errorCode) bits.push(run.errorCode);
    const detail = run?.error ? ` — ${run.error.split('\n')[0]}` : '';
    // Task status is what the stage decided; the run status is what the
    // agent process did. They differ when the daemon rejected a finished
    // run's output — show both so "failed (agent run: succeeded)" reads as
    // "validation, not the agent".
    const status = run?.status && run.status !== task.status ? `${task.status} (agent run: ${run.status})` : (run?.status ?? task.status);
    return `- ${task.title || task.id}: ${status}${bits.length ? ` (${bits.join(', ')})` : ''}${detail}`;
  });
  const outputs = `fan-out: ${failed.length}/${rows.length} sub-run failed\n${lines.join('\n')}`;
  const ctx: StageFailureContext = {
    ...(firstFailedRun?.id ? { runId: firstFailedRun.id } : {}),
    ...(firstFailedRun?.agentId || anyRun?.agentId ? { agentId: (firstFailedRun?.agentId || anyRun?.agentId) as string } : {}),
    exitCode: firstFailedRun?.exitCode ?? null,
    signal: firstFailedRun?.signal ?? null,
    errorCode: firstFailedRun?.errorCode ?? null,
    durationMs:
      typeof firstFailedRun?.createdAt === 'number' && typeof firstFailedRun?.updatedAt === 'number'
        ? firstFailedRun.updatedAt - firstFailedRun.createdAt
        : null,
    outputs: outputs.length > 6000 ? `${outputs.slice(0, 6000)}\n…` : outputs,
    finalStatus: firstFailedRun?.status ?? null,
    stderrTail: firstFailedRun?.stderrTail ?? null,
    stdoutTail: firstFailedRun?.stdoutTail ?? null,
  };
  const firstError = firstFailedRun?.error?.split('\n')[0]?.trim();
  const errorSuffix = `${failed.length}/${rows.length} bước con lỗi${firstError ? ` — lỗi đầu: ${firstError}` : ''}`;
  return { ctx, errorSuffix };
}

/** Fan-out stages whose verdict is decided by daemon-side validation AFTER
 *  every agent run finished (docs-review, docs-comp…): the sub-conversations
 *  are green, the stage is red, and the only place the reason lives is the
 *  per-item `errors`. Flatten those into (a) one line per item for the
 *  report's `outputs` and (b) a short "first reason" for the stage error. */
export function fanoutFailureDetail(
  items: Array<{ name: string; errors: string[] }>,
  limit = 40,
): { list: string; first: string } {
  const failed = items.filter((it) => it.errors.length > 0);
  const lines = failed.slice(0, limit).map((it) => `- ${it.name}: ${it.errors.join('; ')}`);
  if (failed.length > limit) lines.push(`… và ${failed.length - limit} mục nữa`);
  const head = failed[0];
  const first = head ? `${head.name}: ${head.errors[0] ?? 'không rõ lý do'}` : 'không rõ lý do';
  return { list: lines.join('\n') || '(không có chi tiết lỗi)', first };
}

export interface ErrorReporter {
  /** Synchronous: allocates the id, kicks off build+send in the background. */
  report(info: FailureInfo): string;
  /** Re-send anything still sitting in the outbox (startup + after sends). */
  flushOutbox(): Promise<{ sent: number; left: number }>;
  /** Wait for in-flight work (tests). */
  idle(): Promise<void>;
}

const enabled = (): boolean => process.env.OD_ERROR_REPORTS !== '0';

export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m: string) => console.warn(m));
  const outboxDir = path.join(options.dataDir, ERROR_REPORTS_OUTBOX_DIR);
  let client: Pick<MediaClient, 'uploadFile'> | null = options.client ?? null;
  const clientOf = () => (client ??= new MediaClient(mediaConfigFromEnv()));
  const inflight = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>): Promise<unknown> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    return p;
  };

  const identity =
    options.identity ??
    (async () => {
      const config = await readAppConfig(options.dataDir);
      const machine = getMachineUser();
      return {
        user: machine?.email || config.feedbackUsername?.trim() || config.installationId || 'unknown',
        installationId: config.installationId || 'unknown-install',
      };
    });
  const version =
    options.version ??
    (async () => {
      const info = await readCurrentAppVersionInfo().catch(() => null);
      return {
        version: info?.version ?? '0.0.0',
        channel: info?.channel ?? 'unknown',
        packaged: info?.packaged ?? isPackagedRuntime(),
      };
    });

  const remotePath = (installationId: string, id: string) =>
    `${PIPELINE_ERROR_REPORTS_PREFIX}${installationId.replace(/[\\/:*?"<>|]/g, '')}/${id}.json`;

  async function upload(report: PipelineErrorReport): Promise<void> {
    await clientOf().uploadFile(
      PIPELINE_ERROR_REPORTS_FOLDER,
      'errors',
      remotePath(report.identity.installationId, report.id),
      'application/json',
      Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
    );
  }

  async function writeOutbox(report: PipelineErrorReport): Promise<string> {
    await fs.promises.mkdir(outboxDir, { recursive: true });
    const file = path.join(outboxDir, `${report.createdAt}-${report.id}.json`);
    await fs.promises.writeFile(file, JSON.stringify(report), 'utf8');
    return file;
  }

  async function pruneOutbox(): Promise<void> {
    const names = (await fs.promises.readdir(outboxDir).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort();
    for (const stale of names.slice(0, Math.max(0, names.length - OUTBOX_MAX_FILES))) {
      await fs.promises.unlink(path.join(outboxDir, stale)).catch(() => undefined);
    }
  }

  async function build(info: FailureInfo, id: string, attached: StageFailureContext | null): Promise<PipelineErrorReport> {
    const [who, app] = await Promise.all([identity(), version()]);
    let ctx = attached;
    let errorText = info.error ?? '(no error text)';
    // Fan-out stages: the per-sub-run view (which pages/screens ran, exit
    // codes, stderr of the first failure) is derived from design.runs. It
    // complements — never replaces — what the stage attached itself (e.g.
    // docs-review's per-page validation reasons): attached fields win,
    // derived fills the gaps, both `outputs` texts are kept.
    if (options.subRunLookup) {
      const derived = contextFromSubRuns(info, options.subRunLookup);
      if (derived) {
        const workflowId = attached?.workflowId ?? options.workflowIdOf?.(info.pipelineId) ?? null;
        if (!attached) {
          ctx = { ...derived.ctx, workflowId };
        } else {
          const definedAttached = Object.fromEntries(
            Object.entries(attached).filter(([, v]) => v !== undefined && v !== null),
          ) as Partial<StageFailureContext>;
          ctx = {
            ...derived.ctx,
            ...definedAttached,
            workflowId,
            outputs: [attached.outputs, derived.ctx.outputs].filter(Boolean).join('\n\n'),
          };
        }
        if (derived.errorSuffix) errorText = `${errorText} · ${derived.errorSuffix}`;
      }
    }
    const runId = ctx?.runId ?? info.lastRunId;
    const logTail = await readLogTail(options.logPath, runId);
    const projectName = options.projectName?.(info.projectId);
    return {
      schemaVersion: 1,
      id,
      createdAt: now(),
      app,
      machine: { platform: process.platform, release: os.release(), arch: process.arch, nodeVersion: process.version },
      identity: {
        user: who.user,
        installationId: who.installationId,
        namespace: options.namespace,
        channel: app.packaged ? 'packaged' : 'dev',
      },
      run: {
        projectId: info.projectId,
        ...(projectName ? { projectName } : {}),
        workflowId: ctx?.workflowId ?? null,
        stageId: info.pipelineId,
        ...(runId ? { runId } : {}),
        ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
        model: ctx?.model ?? null,
        reasoning: ctx?.reasoning ?? null,
        exitCode: ctx?.exitCode ?? null,
        signal: ctx?.signal ?? null,
        errorCode: ctx?.errorCode ?? null,
        durationMs: ctx?.durationMs ?? null,
        outputs: ctx?.outputs ?? null,
        finalStatus: ctx?.finalStatus ?? null,
      },
      error: scrub(errorText),
      stderrTail: ctx?.stderrTail ? scrub(ctx.stderrTail) : null,
      stdoutTail: ctx?.stdoutTail ? scrub(ctx.stdoutTail) : null,
      logTail,
    };
  }

  async function flushOutbox(): Promise<{ sent: number; left: number }> {
    if (!enabled()) return { sent: 0, left: 0 };
    const names = (await fs.promises.readdir(outboxDir).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort();
    let sent = 0;
    for (const name of names) {
      const file = path.join(outboxDir, name);
      try {
        const report = JSON.parse(await fs.promises.readFile(file, 'utf8')) as PipelineErrorReport;
        await upload(report);
        await fs.promises.unlink(file).catch(() => undefined);
        sent += 1;
      } catch (error) {
        // Store unreachable (offline / VPN) — stop here, keep the rest for
        // the next attempt; the outbox is ordered so nothing is skipped.
        log(`[error-reports] outbox flush stopped at ${name}: ${(error as Error)?.message ?? error}`);
        return { sent, left: names.length - sent };
      }
    }
    return { sent, left: 0 };
  }

  function report(info: FailureInfo): string {
    const ctx = takeStageFailureContext(info.projectId, info.pipelineId);
    const id = newErrorReportId();
    if (!enabled()) return id;
    void track(
      (async () => {
        const built = await build(info, id, ctx);
        await writeOutbox(built);
        await pruneOutbox();
        const { sent, left } = await flushOutbox();
        log(`[error-reports] stage ${info.projectId}/${info.pipelineId} failed → report #${id} (${sent} sent, ${left} queued)`);
      })().catch((error) => {
        log(`[error-reports] could not build report #${id}: ${(error as Error)?.message ?? error}`);
      }),
    );
    return id;
  }

  // Startup: anything left from a previous session goes out once the daemon
  // has settled (not in the hot path of boot).
  if (enabled()) {
    const timer = setTimeout(() => {
      void track(flushOutbox()).catch(() => undefined);
    }, FLUSH_DELAY_MS);
    timer.unref();
  }

  return {
    report,
    flushOutbox,
    idle: async () => {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
}
