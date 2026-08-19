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

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ErrorReportAgentContext,
  ErrorReportEnvContext,
  ErrorReportStageContext,
  PipelineErrorReport,
} from '@open-design/contracts';
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

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

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
  /** Kickoff prompt size + skill of the run (report.agent.prompt). */
  promptChars?: number | null;
  skillId?: string | null;
  /** Structured per-item validation failures (fan-out stages). */
  validation?: Array<{ item: string; code: string; detail: string }> | null;
  /** Directory whose file listing (names/sizes only) goes into the report. */
  outputsDir?: string | null;
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
  /** Last assistant message of a conversation (content + raw events_json)
   *  → report.agent.transcriptTail / tools / usage. */
  lastAssistantMessage?: (conversationId: string) => { content: string | null; eventsJson: string | null } | null;
  /** The CLI as the Local CLI panel sees it → report.agent.cli. */
  agentInfo?: (agentId: string) => Promise<ErrorReportAgentContext['cli']>;
  /** Subscription quota snapshot → report.agent.quota. */
  quota?: (agentId: string) => Promise<ErrorReportAgentContext['quota']>;
  /** Project root on disk (path length + disk-free probe). */
  projectRoot?: (projectId: string) => string | null;
  /** URLs to probe for reachability when a report is built. */
  connectivityTargets?: (agentId: string | null) => string[];
  activeRuns?: () => number | null;
  sandboxEnabled?: () => boolean | null;
  /** Injectable fetch for the connectivity probes (tests). */
  fetchImpl?: typeof fetch;
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
  /** Conversation of the stage's last run (single-conversation stages). */
  conversationId?: string | undefined;
  /** Report id of the previous failure of the same stage, if any. */
  previousReportId?: string | undefined;
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

// ── Additive context helpers (report.agent / .stage / .env / fingerprint) ──
// All deterministic: DB rows, process/os/fs reads, a few HEAD probes. No LLM.

const TRANSCRIPT_TAIL_CHARS = 3000;
const TOOL_FAILURES_MAX = 10;
const OUTPUTS_LISTING_MAX_ENTRIES = 150;
const OUTPUTS_LISTING_MAX_DEPTH = 4;
const CONNECTIVITY_TIMEOUT_MS = 3000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.turbo', '.odhistory']);

/** Stable tag for a daemon-side validation error string (docs-review /
 *  docs-comp / prd-review). Pattern-matched on the daemon's OWN messages, so
 *  it is exact for known shapes and `OTHER` for anything else. */
export function classifyValidationError(text: string): string {
  const t = text.toLowerCase();
  if (/^files:/.test(t)) return 'EVIDENCE';
  if (/agent run kết thúc|agent run ended|trạng thái "failed"|trạng thái "canceled"/.test(t)) return 'AGENT_RUN';
  if (/không cắt được/.test(t)) return 'SLICE';
  if (/không ghép lại được/.test(t)) return 'REBUILD';
  if (/không đọc được output|không có review\//.test(t)) return 'OUTPUT_MISSING';
  if (/json/.test(t)) return 'INVALID_JSON';
  if (/\[rà soát/.test(t)) return 'MARKER_LEFT';
  if (/rule[_ ]?id|tiêu chí|criteria/.test(t)) return 'RULE_ID';
  if (/neo|anchor/.test(t)) return 'NOTE_ANCHOR';
  if (/không khớp|mismatch|diff/.test(t)) return 'DIFF_MISMATCH';
  if (/schema|thiếu trường|missing field/.test(t)) return 'SCHEMA';
  return 'OTHER';
}

/** Structured validation list from the same items fanoutFailureDetail takes. */
export function structuredValidation(
  items: Array<{ name: string; errors: string[] }>,
  limit = 60,
): Array<{ item: string; code: string; detail: string }> {
  const out: Array<{ item: string; code: string; detail: string }> = [];
  for (const it of items) {
    for (const err of it.errors) {
      if (out.length >= limit) return out;
      out.push({ item: it.name, code: classifyValidationError(err), detail: err.length > 400 ? `${err.slice(0, 400)}…` : err });
    }
  }
  return out;
}

/** Transcript tail + tool summary + token usage from one persisted assistant
 *  message (messages.content + messages.events_json). */
export function summarizeAssistantMessage(
  row: { content: string | null; eventsJson: string | null } | null,
): Pick<ErrorReportAgentContext, 'transcriptTail' | 'tools' | 'usage'> {
  if (!row) return { transcriptTail: null, tools: null, usage: null };
  let events: Array<Record<string, unknown>> = [];
  if (row.eventsJson) {
    try {
      const parsed = JSON.parse(row.eventsJson) as unknown;
      if (Array.isArray(parsed)) events = parsed.filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object');
    } catch {
      events = [];
    }
  }
  // Text: prefer the persisted content (already coalesced); fall back to
  // concatenating text events.
  let text = typeof row.content === 'string' ? row.content : '';
  if (!text.trim()) text = events.filter((e) => e.kind === 'text' && typeof e.text === 'string').map((e) => e.text as string).join('');
  text = text.trim();
  const transcriptTail = text ? redactSecrets(redactText(text.length > TRANSCRIPT_TAIL_CHARS ? `…${text.slice(-TRANSCRIPT_TAIL_CHARS)}` : text)) : null;

  const uses = new Map<string, string>();
  let total = 0;
  let failed = 0;
  let lastTool: string | null = null;
  const failures: string[] = [];
  const usageAcc = { seen: false, inputTokens: null as number | null, outputTokens: null as number | null, costUsd: null as number | null };
  for (const e of events) {
    if (e.kind === 'tool_use') {
      total += 1;
      const name = typeof e.name === 'string' ? e.name : '?';
      lastTool = name;
      if (typeof e.id === 'string') uses.set(e.id, name);
    } else if (e.kind === 'tool_result') {
      if (e.isError) {
        failed += 1;
        if (failures.length < TOOL_FAILURES_MAX) {
          const name = (typeof e.toolUseId === 'string' && uses.get(e.toolUseId)) || '?';
          const content = typeof e.content === 'string' ? e.content : String(e.content ?? '');
          const first = content.split('\n').find((l) => l.trim())?.trim() ?? '';
          failures.push(redactSecrets(`${name}: ${first.length > 200 ? `${first.slice(0, 200)}…` : first}`));
        }
      }
    } else if (e.kind === 'usage') {
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      usageAcc.seen = true;
      usageAcc.inputTokens = num(e.inputTokens) ?? usageAcc.inputTokens;
      usageAcc.outputTokens = num(e.outputTokens) ?? usageAcc.outputTokens;
      usageAcc.costUsd = num(e.costUsd) ?? usageAcc.costUsd;
    }
  }
  const tools = events.length ? { total, failed, lastTool, failures } : null;
  const usage = usageAcc.seen ? { inputTokens: usageAcc.inputTokens, outputTokens: usageAcc.outputTokens, costUsd: usageAcc.costUsd } : null;
  return { transcriptTail, tools, usage };
}

/** "relative/path  size  mtime" lines under `dir` (names only). Depth- and
 *  count-capped; skips node_modules/.git-like dirs. */
export async function listOutputsDir(
  dir: string,
  opts: { maxEntries?: number; maxDepth?: number } = {},
): Promise<string | null> {
  const maxEntries = opts.maxEntries ?? OUTPUTS_LISTING_MAX_ENTRIES;
  const maxDepth = opts.maxDepth ?? OUTPUTS_LISTING_MAX_DEPTH;
  const lines: string[] = [];
  let truncated = false;
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (truncated) return;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (depth + 1 >= maxDepth) {
          lines.push(`${childRel}/  (…)`);
        } else {
          await walk(path.join(abs, ent.name), childRel, depth + 1);
        }
      } else {
        let size = 0;
        let mtime = '';
        try {
          const st = await fs.promises.stat(path.join(abs, ent.name));
          size = st.size;
          mtime = st.mtime.toISOString();
        } catch {
          /* listing is best-effort */
        }
        lines.push(`${childRel}  ${size}B  ${mtime}`);
      }
      if (lines.length >= maxEntries) {
        truncated = true;
        lines.push('… (truncated)');
      }
    }
  };
  try {
    const st = await fs.promises.stat(dir);
    if (!st.isDirectory()) return null;
  } catch {
    return `(missing) ${dir}`;
  }
  await walk(dir, '', 0);
  return lines.length ? lines.join('\n') : '(empty)';
}

export function taskCounts(
  tasks: Array<{ status: string }> | undefined,
): ErrorReportStageContext['tasks'] {
  if (!tasks || tasks.length === 0) return null;
  const counts = { total: tasks.length, queued: 0, running: 0, succeeded: 0, failed: 0 };
  for (const t of tasks) {
    if (t.status === 'queued') counts.queued += 1;
    else if (t.status === 'running') counts.running += 1;
    else if (t.status === 'succeeded') counts.succeeded += 1;
    else if (t.status === 'failed') counts.failed += 1;
  }
  return counts;
}

/** HEAD each target with a short timeout; result is a status code, a
 *  network error code, or "timeout". Never throws. */
export async function probeConnectivity(
  targets: string[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CONNECTIVITY_TIMEOUT_MS,
): Promise<ErrorReportEnvContext['connectivity']> {
  const unique = [...new Set(targets.filter((t) => /^https?:\/\//.test(t)))];
  if (unique.length === 0) return null;
  return Promise.all(
    unique.map(async (target) => {
      const started = Date.now();
      try {
        const res = await fetchImpl(target, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        return { target, result: `HTTP ${res.status}`, ms: Date.now() - started };
      } catch (error) {
        const err = error as { name?: string; code?: string; cause?: { code?: string; errors?: Array<{ code?: string }> }; message?: string };
        // undici wraps ECONNREFUSED & co. in `cause` (an AggregateError when
        // several addresses were tried) — dig the first real code out.
        const code =
          err?.cause?.code ??
          err?.cause?.errors?.find((e) => e?.code)?.code ??
          err?.code ??
          (err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : null);
        return { target, result: code ?? (err?.message ?? 'error').slice(0, 80), ms: Date.now() - started };
      }
    }),
  );
}

export async function collectEnv(opts: {
  projectRoot: string | null;
  activeRuns: number | null;
  sandboxEnabled: boolean | null;
  connectivity: ErrorReportEnvContext['connectivity'];
  env?: NodeJS.ProcessEnv;
}): Promise<ErrorReportEnvContext> {
  const env = opts.env ?? process.env;
  let diskFreeBytes: number | null = null;
  const statfs = (fs.promises as { statfs?: (p: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }> }).statfs;
  if (statfs) {
    try {
      const st = await statfs(opts.projectRoot ?? os.homedir());
      diskFreeBytes = Number(st.bavail) * Number(st.bsize);
    } catch {
      diskFreeBytes = null;
    }
  }
  let locale: string | null = null;
  let timezone: string | null = null;
  try {
    const dtf = Intl.DateTimeFormat().resolvedOptions();
    locale = dtf.locale ?? null;
    timezone = dtf.timeZone ?? null;
  } catch {
    /* Intl unavailable */
  }
  return {
    diskFreeBytes,
    memFreeBytes: os.freemem(),
    memTotalBytes: os.totalmem(),
    projectRootLength: opts.projectRoot ? opts.projectRoot.length : null,
    locale,
    timezone,
    daemonUptimeMs: Math.round(process.uptime() * 1000),
    activeRuns: opts.activeRuns,
    proxy: Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy),
    extraCaCerts: Boolean(env.NODE_EXTRA_CA_CERTS),
    sandboxEnabled: opts.sandboxEnabled,
    connectivity: opts.connectivity,
  };
}

/** sha1(stage | cause) — cause = first validation code, else errorCode,
 *  else the error's first line with numbers/quotes/paths normalized. */
export function computeFingerprint(
  stageId: string,
  cause: { validation?: Array<{ code: string }> | null; errorCode?: string | null; error: string },
): string {
  let key: string;
  if (cause.validation && cause.validation.length > 0) {
    key = `validation:${[...new Set(cause.validation.map((v) => v.code))].sort().join('+')}`;
  } else if (cause.errorCode) {
    key = `code:${cause.errorCode}`;
  } else {
    key = `error:${(cause.error.split('\n')[0] ?? '')
      .toLowerCase()
      .replace(/["'`“”‘’].*?["'`“”‘’]/g, '"…"')
      .replace(/[a-z]:\\[^\s]+|\/[^\s]+/g, '<path>')
      .replace(/\d+/g, '#')
      .trim()}`;
  }
  return createHash('sha1').update(`${stageId}|${key}`).digest('hex').slice(0, 12);
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
    const additive = await collectAdditiveContext(info, ctx, errorText).catch((error) => {
      log(`[error-reports] additive context failed (report still sent): ${(error as Error)?.message ?? error}`);
      return null;
    });
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
      agent: additive?.agent ?? null,
      stage: additive?.stage ?? null,
      env: additive?.env ?? null,
      fingerprint: additive?.fingerprint ?? null,
      previousReportId: info.previousReportId ?? null,
    };
  }

  /** report.agent / .stage / .env / fingerprint — every piece independent
   *  and best-effort; one failing probe never drops the others. */
  async function collectAdditiveContext(
    info: FailureInfo,
    ctx: StageFailureContext | null,
    errorText: string,
  ): Promise<{ agent: ErrorReportAgentContext; stage: ErrorReportStageContext; env: ErrorReportEnvContext; fingerprint: string }> {
    const agentId = ctx?.agentId ?? null;
    // Which conversation to read: the stage's own, else the first failed
    // sub-conversation, else the first sub-conversation.
    const subs = info.subConversations ?? [];
    const conversationId =
      info.conversationId ?? subs.find((t) => t.status === 'failed')?.id ?? subs[0]?.id ?? null;
    const row = conversationId && options.lastAssistantMessage ? safe(() => options.lastAssistantMessage!(conversationId), null) : null;
    const [cli, quota, connectivity, outputsListing] = await Promise.all([
      agentId && options.agentInfo ? options.agentInfo(agentId).catch(() => null) : Promise.resolve(null),
      agentId && options.quota ? options.quota(agentId).catch(() => null) : Promise.resolve(null),
      probeConnectivity(safe(() => options.connectivityTargets?.(agentId) ?? [], []), options.fetchImpl ?? fetch),
      ctx?.outputsDir ? listOutputsDir(ctx.outputsDir).catch(() => null) : Promise.resolve(null),
    ]);
    const projectRoot = safe(() => options.projectRoot?.(info.projectId) ?? null, null);
    const env = await collectEnv({
      projectRoot,
      activeRuns: safe(() => options.activeRuns?.() ?? null, null),
      sandboxEnabled: safe(() => options.sandboxEnabled?.() ?? null, null),
      connectivity,
    });
    const summary = summarizeAssistantMessage(row);
    const agent: ErrorReportAgentContext = {
      conversationId,
      transcriptTail: summary.transcriptTail,
      tools: summary.tools,
      usage: summary.usage,
      cli,
      quota,
      prompt: ctx?.promptChars != null || ctx?.skillId ? { chars: ctx?.promptChars ?? null, skillId: ctx?.skillId ?? null } : null,
    };
    const stage: ErrorReportStageContext = {
      tasks: taskCounts(info.subConversations),
      validation: ctx?.validation && ctx.validation.length > 0 ? ctx.validation : null,
      outputsListing: outputsListing ? scrub(outputsListing) : null,
    };
    const fingerprint = computeFingerprint(info.pipelineId, { validation: ctx?.validation ?? null, errorCode: ctx?.errorCode ?? null, error: errorText });
    return { agent, stage, env, fingerprint };
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
