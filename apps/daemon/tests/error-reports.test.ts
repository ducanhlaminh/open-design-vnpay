// Pipeline stage error reports → developers (error-reports.ts + the db.ts
// failure hook): one report per NEW failure, durable outbox, upload to the
// dedicated media folder, secrets scrubbed, rich context merged when the
// completion block attached it.

import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PIPELINE_ERROR_REPORTS_FOLDER, type PipelineErrorReport } from '@open-design/contracts';

import {
  attachStageFailureContext,
  contextFromSubRuns,
  createErrorReporter,
  ERROR_REPORTS_OUTBOX_DIR,
  fanoutFailureDetail,
  classifyValidationError,
  computeFingerprint,
  listOutputsDir,
  probeConnectivity,
  structuredValidation,
  summarizeAssistantMessage,
  taskCounts,
  pushConsoleTailLine,
  readLogTail,
  resetConsoleTailForTests,
} from '../src/error-reports.js';
import {
  closeDatabase,
  getProjectPipelineState,
  insertProject,
  openDatabase,
  setPipelineFailureHook,
  setProjectPipelineStatus,
} from '../src/db.js';

type Upload = { projectId: string; stage: string; filePath: string; mime: string; body: PipelineErrorReport };

function fakeClient(opts: { failFirst?: number } = {}) {
  const uploads: Upload[] = [];
  let failures = opts.failFirst ?? 0;
  return {
    uploads,
    uploadFile: vi.fn(async (projectId: string, stage: string, filePath: string, mime: string, content: Buffer) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('media unreachable');
      }
      uploads.push({ projectId, stage, filePath, mime, body: JSON.parse(content.toString('utf8')) as PipelineErrorReport });
    }),
  };
}

const IDENTITY = async () => ({ user: 'designer@vnpay.vn', installationId: 'inst-1' });
const VERSION = async () => ({ version: '0.8.62', channel: 'stable', packaged: true });

describe('createErrorReporter', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'od-error-reports-'));
    delete process.env.OD_ERROR_REPORTS;
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.OD_ERROR_REPORTS;
  });

  it('builds a report, uploads it to the dedicated folder and drains the outbox', async () => {
    const logPath = path.join(dataDir, 'latest.log');
    writeFileSync(
      logPath,
      ['boot', 'Authorization: Bearer sk-live-SECRET', '[pipelines] run run-1 started', '[pipelines] STAGE NOT SUCCEEDED run=run-1'].join('\n'),
    );
    const client = fakeClient();
    const reporter = createErrorReporter({
      dataDir,
      logPath,
      namespace: 'default',
      client,
      identity: IDENTITY,
      version: VERSION,
      projectName: () => 'SIM du lịch',
      now: () => 1_700_000_000_000,
      log: () => {},
    });
    attachStageFailureContext('P1', 'dr-review', {
      runId: 'run-1',
      agentId: 'claude',
      exitCode: 1,
      finalStatus: 'failed',
      stderrTail: 'x-api-key: abc123 boom',
      workflowId: 'docs-review',
    });
    const id = reporter.report({ projectId: 'P1', pipelineId: 'dr-review', error: 'Bước chạy thất bại', lastRunId: undefined });
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    await reporter.idle();

    expect(client.uploads).toHaveLength(1);
    const up = client.uploads[0]!;
    expect(up.projectId).toBe(PIPELINE_ERROR_REPORTS_FOLDER);
    expect(up.filePath).toBe(`errors/inst-1/${id}.json`);
    expect(up.mime).toBe('application/json');
    const r = up.body;
    expect(r.schemaVersion).toBe(1);
    expect(r.id).toBe(id);
    expect(r.app).toEqual({ version: '0.8.62', channel: 'stable', packaged: true });
    expect(r.identity).toEqual({ user: 'designer@vnpay.vn', installationId: 'inst-1', namespace: 'default', channel: 'packaged' });
    expect(r.run).toMatchObject({ projectId: 'P1', projectName: 'SIM du lịch', workflowId: 'docs-review', stageId: 'dr-review', runId: 'run-1', agentId: 'claude', exitCode: 1, finalStatus: 'failed' });
    expect(r.error).toBe('Bước chạy thất bại');
    expect(r.stderrTail).toMatch(/\[REDACTED/);
    expect(r.stderrTail).not.toContain('abc123');
    expect(r.logTail).toContain('STAGE NOT SUCCEEDED run=run-1');
    expect(r.logTail).not.toContain('sk-live-SECRET');
    // Outbox drained after a successful send.
    expect(readdirSync(path.join(dataDir, ERROR_REPORTS_OUTBOX_DIR))).toEqual([]);
  });

  it('keeps the report in the outbox when the store is unreachable and sends it on the next flush', async () => {
    const client = fakeClient({ failFirst: 1 });
    const reporter = createErrorReporter({ dataDir, logPath: null, namespace: null, client, identity: IDENTITY, version: VERSION, log: () => {} });
    const id = reporter.report({ projectId: 'P1', pipelineId: 'docs', error: 'no source', lastRunId: undefined });
    await reporter.idle();
    expect(client.uploads).toHaveLength(0);
    const queued = readdirSync(path.join(dataDir, ERROR_REPORTS_OUTBOX_DIR));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toContain(id);

    const result = await reporter.flushOutbox();
    expect(result).toEqual({ sent: 1, left: 0 });
    expect(client.uploads).toHaveLength(1);
    expect(client.uploads[0]!.body.id).toBe(id);
    expect(client.uploads[0]!.body.logTail).toBeNull();
    expect(readdirSync(path.join(dataDir, ERROR_REPORTS_OUTBOX_DIR))).toEqual([]);
  });

  it('OD_ERROR_REPORTS=0 disables sending entirely', async () => {
    process.env.OD_ERROR_REPORTS = '0';
    const client = fakeClient();
    const reporter = createErrorReporter({ dataDir, logPath: null, namespace: null, client, identity: IDENTITY, version: VERSION, log: () => {} });
    reporter.report({ projectId: 'P1', pipelineId: 'docs', error: 'x', lastRunId: undefined });
    await reporter.idle();
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(readdirSync(dataDir)).not.toContain('error-reports');
  });
});

describe('readLogTail', () => {
  it('returns the window from the first mention of the run id, scrubbed', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'od-log-tail-'));
    const logPath = path.join(dir, 'latest.log');
    const lines: string[] = [];
    for (let i = 0; i < 400; i += 1) lines.push(`line ${i} token=abc${i}`);
    lines.push('[pipelines] run run-77 started');
    for (let i = 0; i < 30; i += 1) lines.push(`after ${i}`);
    writeFileSync(logPath, lines.join('\n'));
    const tail = await readLogTail(logPath, 'run-77');
    expect(tail).toBeTruthy();
    expect(tail).toContain('run run-77 started');
    expect(tail).toContain('after 29');
    expect(tail).toContain('line 380'); // ~20 lines of context before the run
    expect(tail).not.toContain('line 300');
    expect(tail).not.toContain('token=abc380');
    expect(tail).toContain('token=[REDACTED]');
    expect(await readLogTail(null)).toBeNull();
    expect(await readLogTail(path.join(dir, 'missing.log'))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('setProjectPipelineStatus failure hook', () => {
  let tempDir: string;
  let db: any;
  const hook = vi.fn(() => 'rep00001');

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-failure-hook-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'PROJ', name: 'PROJ', skillId: null, designSystemId: null, pendingPrompt: null, metadata: { kind: 'pipeline' }, createdAt: now, updatedAt: now });
    hook.mockClear();
    setPipelineFailureHook(hook);
  });
  afterEach(() => {
    setPipelineFailureHook(null);
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fires once per new failure, stores the report id, and clears it on the next non-failed status', () => {
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'running', lastRunId: 'run-1' });
    expect(hook).not.toHaveBeenCalled();
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'boom' });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({ projectId: 'PROJ', pipelineId: 'docs', error: 'boom', lastRunId: 'run-1', subConversations: undefined });
    expect(getProjectPipelineState(db, 'PROJ').docs).toMatchObject({ status: 'failed', error: 'boom', errorReportId: 'rep00001' });

    // Same failure written again (outer catch re-marking) → no second report.
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'boom' });
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed' });
    expect(hook).toHaveBeenCalledTimes(1);

    // A different reason while still failed IS a new failure — and a fan-out
    // stage's sub-conversations ride along so the report can name them.
    const subs = [{ id: 'c1', title: 'Trang 1', status: 'failed' }];
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'other', subConversations: subs });
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'other', subConversations: subs }));

    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'succeeded' });
    const state = getProjectPipelineState(db, 'PROJ').docs;
    expect(state?.error).toBeUndefined();
    expect(state?.errorReportId).toBeUndefined();
  });

  it('a throwing hook never breaks the status write', () => {
    setPipelineFailureHook(() => {
      throw new Error('reporter down');
    });
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'boom' });
    expect(getProjectPipelineState(db, 'PROJ').docs).toMatchObject({ status: 'failed', error: 'boom' });
    expect(getProjectPipelineState(db, 'PROJ').docs?.errorReportId).toBeUndefined();
  });
});

describe('readLogTail — console-tail fallback (host runtime has no log file)', () => {
  afterEach(() => resetConsoleTailForTests());

  it('uses the in-memory console tail when there is no log path, windowed on the run id and scrubbed', async () => {
    for (let i = 0; i < 100; i += 1) pushConsoleTailLine('log', [`noise ${i}`]);
    pushConsoleTailLine('warn', ['[pipelines] run run-42 started token=abc42', { detail: 'obj' }]);
    pushConsoleTailLine('error', ['agent exited', new Error('boom')]);
    const tail = await readLogTail(null, 'run-42');
    expect(tail).toBeTruthy();
    expect(tail).toContain('[warn] [pipelines] run run-42 started');
    expect(tail).toContain('[error] agent exited Error: boom');
    expect(tail).toContain('noise 80');
    expect(tail).not.toContain('noise 10 ');
    expect(tail).not.toContain('token=abc42');
    expect(tail).toContain('token=[REDACTED]');
    expect(tail).toContain('{"detail":"obj"}');
  });

  it('falls back to the console tail when the log file is missing too', async () => {
    pushConsoleTailLine('log', ['hello from console']);
    expect(await readLogTail('/nonexistent/latest.log')).toContain('hello from console');
  });
});

describe('fan-out fallback context (contextFromSubRuns)', () => {
  const info = {
    projectId: 'p1',
    pipelineId: 'dr-review',
    error: 'Bước chạy thất bại — xem hội thoại của bước để biết chi tiết',
    lastRunId: undefined,
    subConversations: [
      { id: 'c-a', title: 'Trang A', status: 'failed' },
      { id: 'c-b', title: 'Trang B', status: 'failed' },
      { id: 'c-c', title: 'Trang C', status: 'succeeded' },
    ],
  };
  const lookup = (_projectId: string, conversationId: string) =>
    conversationId === 'c-a'
      ? { id: 'run-a', agentId: 'claude', status: 'failed', error: 'spawn claude ENOENT\nmore', exitCode: 127, errorCode: 'AGENT_SPAWN', createdAt: 1000, updatedAt: 4000, stderrTail: 'stderr of a' }
      : conversationId === 'c-b'
        ? { id: 'run-b', agentId: 'claude', status: 'failed', error: null, exitCode: 1 }
        : { id: 'run-c', agentId: 'claude', status: 'succeeded', exitCode: 0 };

  it('names failed sub-runs, carries the first failure\'s exit code / stderr and appends a summary to the error', () => {
    const out = contextFromSubRuns(info, lookup);
    expect(out).toBeTruthy();
    expect(out!.ctx.agentId).toBe('claude');
    expect(out!.ctx.runId).toBe('run-a');
    expect(out!.ctx.exitCode).toBe(127);
    expect(out!.ctx.errorCode).toBe('AGENT_SPAWN');
    expect(out!.ctx.durationMs).toBe(3000);
    expect(out!.ctx.stderrTail).toBe('stderr of a');
    expect(out!.ctx.outputs).toContain('2/3 sub-run failed');
    expect(out!.ctx.outputs).toContain('- Trang A: failed (exit 127, AGENT_SPAWN) — spawn claude ENOENT');
    expect(out!.ctx.outputs).toContain('- Trang C: succeeded');
    expect(out!.errorSuffix).toBe('2/3 bước con lỗi — lỗi đầu: spawn claude ENOENT');
  });

  it('returns null when the stage had no sub-conversations', () => {
    expect(contextFromSubRuns({ ...info, subConversations: [] }, lookup)).toBeNull();
    expect(contextFromSubRuns({ ...info, subConversations: undefined }, lookup)).toBeNull();
  });

  it('createErrorReporter uses it when no context was attached', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'od-error-reports-fanout-'));
    delete process.env.OD_ERROR_REPORTS;
    const client = fakeClient();
    const reporter = createErrorReporter({
      dataDir, logPath: null, namespace: null, client, identity: IDENTITY, version: VERSION,
      subRunLookup: lookup, workflowIdOf: () => 'docs-review',
    });
    reporter.report(info);
    await reporter.idle();
    expect(client.uploads).toHaveLength(1);
    const body = client.uploads[0]!.body;
    expect(body.run.agentId).toBe('claude');
    expect(body.run.exitCode).toBe(127);
    expect(body.run.workflowId).toBe('docs-review');
    expect(body.run.outputs).toContain('2/3 sub-run failed');
    expect(body.error).toContain('2/3 bước con lỗi — lỗi đầu: spawn claude ENOENT');
    expect(body.stderrTail).toBe('stderr of a');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('shows "failed (agent run: succeeded)" when the stage rejected a finished run\'s output', () => {
    // docs-review: every section run finished, the daemon's post-run
    // validation failed the page → task failed, run succeeded.
    const out = contextFromSubRuns(
      { ...info, subConversations: [{ id: 'c-a', title: 'Trang A · Mở đầu', status: 'failed' }] },
      () => ({ id: 'run-a', agentId: 'claude', status: 'succeeded', exitCode: 0 }),
    );
    expect(out!.ctx.outputs).toContain('- Trang A · Mở đầu: failed (agent run: succeeded) (exit 0)');
    expect(out!.errorSuffix).toBe('1/1 bước con lỗi');
  });

  it('merges an attached stage context with the derived sub-run view (attached wins, both outputs kept)', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'od-error-reports-fanout-merge-'));
    delete process.env.OD_ERROR_REPORTS;
    const client = fakeClient();
    const reporter = createErrorReporter({
      dataDir, logPath: null, namespace: null, client, identity: IDENTITY, version: VERSION,
      subRunLookup: lookup, workflowIdOf: () => 'docs-review',
    });
    attachStageFailureContext('p1', 'dr-review', {
      agentId: 'codex',
      model: 'gpt-5',
      outputs: 'docs-review: 0/3 trang đạt (validation sau fan-out)\n- Trang A: s1: JSON không hợp lệ',
      finalStatus: 'failed',
      workflowId: 'docs-review',
    });
    reporter.report({ ...info, error: 'Không trang nào đạt kiểm tra sau khi rà soát (3 trang) — Trang A: s1: JSON không hợp lệ' });
    await reporter.idle();
    const body = client.uploads[0]!.body;
    expect(body.run.agentId).toBe('codex'); // attached wins
    expect(body.run.model).toBe('gpt-5');
    expect(body.run.exitCode).toBe(127); // derived fills the gap
    expect(body.run.runId).toBe('run-a');
    expect(body.run.outputs).toContain('0/3 trang đạt');
    expect(body.run.outputs).toContain('2/3 sub-run failed');
    expect(body.error).toContain('Trang A: s1: JSON không hợp lệ');
    expect(body.error).toContain('2/3 bước con lỗi');
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('fanoutFailureDetail', () => {
  it('lists one line per failed item and a first-reason string', () => {
    const d = fanoutFailureDetail([
      { name: 'Trang A', errors: [] },
      { name: 'Trang B', errors: ['s2: JSON không hợp lệ', 'còn dấu [Rà soát …]'] },
      { name: 'Trang C', errors: ['rule_id lạ: DS-99'] },
    ]);
    expect(d.list).toBe('- Trang B: s2: JSON không hợp lệ; còn dấu [Rà soát …]\n- Trang C: rule_id lạ: DS-99');
    expect(d.first).toBe('Trang B: s2: JSON không hợp lệ');
  });
  it('caps the list and degrades gracefully with no errors', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ name: `T${i}`, errors: ['x'] }));
    expect(fanoutFailureDetail(many).list.split('\n')).toHaveLength(41);
    expect(fanoutFailureDetail(many).list).toContain('… và 5 mục nữa');
    expect(fanoutFailureDetail([{ name: 'A', errors: [] }])).toEqual({ list: '(không có chi tiết lỗi)', first: 'không rõ lý do' });
  });
});

describe('additive context helpers', () => {
  it('classifies the daemon\'s own validation strings into stable codes', () => {
    expect(classifyValidationError('Section "Mở đầu": agent run kết thúc với trạng thái "failed".')).toBe('AGENT_RUN');
    expect(classifyValidationError('Không cắt được trang thành lát: boom')).toBe('SLICE');
    expect(classifyValidationError('Không ghép lại được trang từ các lát: x')).toBe('REBUILD');
    expect(classifyValidationError('s2: .changes.json không phải JSON hợp lệ')).toBe('INVALID_JSON');
    expect(classifyValidationError('Bản clone còn dấu [Rà soát …] ở dòng 12')).toBe('MARKER_LEFT');
    expect(classifyValidationError('rule_id "DS-99" không có trong criteria/')).toBe('RULE_ID');
    expect(classifyValidationError('files: s01.changes.json: 0B JSON ok, clone: thiếu')).toBe('EVIDENCE');
    expect(classifyValidationError('gì đó lạ')).toBe('OTHER');
    expect(structuredValidation([{ name: 'Trang A', errors: ['s1: JSON hỏng', 'files: clone: thiếu'] }])).toEqual([
      { item: 'Trang A', code: 'INVALID_JSON', detail: 's1: JSON hỏng' },
      { item: 'Trang A', code: 'EVIDENCE', detail: 'files: clone: thiếu' },
    ]);
  });

  it('summarizes an assistant message: transcript tail (redacted), tool failures, token usage', () => {
    const events = [
      { kind: 'text', text: 'Đang đọc file…' },
      { kind: 'tool_use', id: 't1', name: 'Read', input: {} },
      { kind: 'tool_result', toolUseId: 't1', content: 'ok', isError: false },
      { kind: 'tool_use', id: 't2', name: 'Edit', input: {} },
      { kind: 'tool_result', toolUseId: 't2', content: 'ENOENT: no such file C:\\x\\y.md\nmore', isError: true },
      { kind: 'usage', inputTokens: 1200, outputTokens: 300, costUsd: 0.02 },
    ];
    const out = summarizeAssistantMessage({ content: 'Tôi không tìm thấy file. token=abc42', eventsJson: JSON.stringify(events) });
    expect(out.transcriptTail).toContain('Tôi không tìm thấy file');
    expect(out.transcriptTail).not.toContain('abc42');
    expect(out.tools).toEqual({ total: 2, failed: 1, lastTool: 'Edit', failures: ['Edit: ENOENT: no such file C:\\x\\y.md'] });
    expect(out.usage).toEqual({ inputTokens: 1200, outputTokens: 300, costUsd: 0.02 });
    expect(summarizeAssistantMessage(null)).toEqual({ transcriptTail: null, tools: null, usage: null });
    // Malformed events_json → text only, no tool summary.
    expect(summarizeAssistantMessage({ content: 'x', eventsJson: '{nope' }).tools).toBeNull();
    // Long text keeps the END (that is where the agent explains why it stopped).
    const long = 'a'.repeat(5000) + 'CUỐI';
    expect(summarizeAssistantMessage({ content: long, eventsJson: null }).transcriptTail!.endsWith('CUỐI')).toBe(true);
    expect(summarizeAssistantMessage({ content: long, eventsJson: null }).transcriptTail!.length).toBeLessThan(3100);
  });

  it('lists an outputs dir as names/sizes only, capped, skipping node_modules', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'od-outputs-'));
    writeFileSync(path.join(dir, 'review-khong-chay-duoc.md'), '# note');
    const sub = path.join(dir, 'review', 'docs');
    await import('node:fs').then((fs) => fs.mkdirSync(sub, { recursive: true }));
    writeFileSync(path.join(sub, 'a.md'), 'secret content of the doc');
    await import('node:fs').then((fs) => fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true }));
    const listing = (await listOutputsDir(dir))!;
    expect(listing).toContain('review-khong-chay-duoc.md  6B');
    expect(listing).toContain('review/docs/a.md  25B');
    expect(listing).not.toContain('secret content');
    expect(listing).not.toContain('node_modules');
    expect(await listOutputsDir(path.join(dir, 'missing'))).toMatch(/^\(missing\)/);
    const capped = (await listOutputsDir(dir, { maxEntries: 1 }))!;
    expect(capped).toContain('… (truncated)');
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts sub-conversation statuses', () => {
    expect(taskCounts(undefined)).toBeNull();
    expect(taskCounts([{ status: 'failed' }, { status: 'succeeded' }, { status: 'queued' }, { status: 'running' }, { status: 'failed' }]))
      .toEqual({ total: 5, queued: 1, running: 1, succeeded: 1, failed: 2 });
  });

  it('probes connectivity with an injectable fetch and never throws', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('ok')) return new Response(null, { status: 204 });
      if (u.includes('tls')) throw Object.assign(new Error('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      throw err;
    }) as unknown as typeof fetch;
    const out = (await probeConnectivity(['https://ok.example/', 'https://tls.example/', 'https://slow.example/', 'https://ok.example/', 'not-a-url'], fetchImpl))!;
    expect(out.map((o) => `${o.target} ${o.result}`)).toEqual([
      'https://ok.example/ HTTP 204',
      'https://tls.example/ UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'https://slow.example/ timeout',
    ]);
    expect(await probeConnectivity([], fetchImpl)).toBeNull();
  });

  it('fingerprints by validation codes, else errorCode, else the normalized error line', () => {
    const a = computeFingerprint('dr-review', { validation: [{ code: 'INVALID_JSON' }, { code: 'EVIDENCE' }], error: 'x' });
    const b = computeFingerprint('dr-review', { validation: [{ code: 'EVIDENCE' }, { code: 'INVALID_JSON' }], error: 'y' });
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
    expect(computeFingerprint('ux', { errorCode: 'AGENT_SPAWN', error: 'a' })).toBe(computeFingerprint('ux', { errorCode: 'AGENT_SPAWN', error: 'b' }));
    expect(computeFingerprint('ux', { error: 'Không trang nào đạt (3 trang) — "Trang A": lỗi 12' }))
      .toBe(computeFingerprint('ux', { error: 'Không trang nào đạt (7 trang) — "Trang B": lỗi 99' }));
    expect(computeFingerprint('ux', { error: 'a' })).not.toBe(computeFingerprint('ui', { error: 'a' }));
  });

  it('createErrorReporter fills report.agent / .stage / .env / fingerprint from the lookups', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'od-error-reports-additive-'));
    const outputsDir = mkdtempSync(path.join(os.tmpdir(), 'od-outputs-'));
    writeFileSync(path.join(outputsDir, 'review-khong-chay-duoc.md'), '# note');
    delete process.env.OD_ERROR_REPORTS;
    const client = fakeClient();
    const reporter = createErrorReporter({
      dataDir, logPath: null, namespace: null, client, identity: IDENTITY, version: VERSION,
      lastAssistantMessage: (id) => (id === 'c-a' ? { content: 'Không tìm thấy criteria/', eventsJson: JSON.stringify([{ kind: 'usage', inputTokens: 10, outputTokens: 2 }]) } : null),
      agentInfo: async () => ({ available: true, version: '2.1.0', path: '/usr/local/bin/claude', authStatus: 'ok', sandbox: false }),
      quota: async () => ({ source: 'claude', windows: [{ label: '5 giờ', utilization: 97, resetsAt: null }], reason: null, readAt: 1 }),
      projectRoot: () => '/Users/x/od-data/projects/p1',
      connectivityTargets: () => ['https://ok.example/'],
      fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      activeRuns: () => 2,
      sandboxEnabled: () => false,
    });
    attachStageFailureContext('p1', 'dr-review', {
      agentId: 'claude',
      validation: [{ item: 'Trang A', code: 'INVALID_JSON', detail: 's1: JSON hỏng' }],
      outputsDir,
      promptChars: 4321,
      skillId: 'docs-spec-review',
    });
    reporter.report({
      projectId: 'p1', pipelineId: 'dr-review', error: 'Không trang nào đạt', lastRunId: undefined,
      subConversations: [{ id: 'c-a', title: 'Trang A', status: 'failed' }, { id: 'c-b', title: 'Trang B', status: 'succeeded' }],
      previousReportId: 'deadbeef',
    });
    await reporter.idle();
    const body = client.uploads[0]!.body;
    expect(body.agent?.conversationId).toBe('c-a');
    expect(body.agent?.transcriptTail).toBe('Không tìm thấy criteria/');
    expect(body.agent?.usage).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: null });
    expect(body.agent?.cli?.version).toBe('2.1.0');
    expect(body.agent?.quota?.windows[0]?.utilization).toBe(97);
    expect(body.agent?.prompt).toEqual({ chars: 4321, skillId: 'docs-spec-review' });
    expect(body.stage?.tasks).toEqual({ total: 2, queued: 0, running: 0, succeeded: 1, failed: 1 });
    expect(body.stage?.validation).toEqual([{ item: 'Trang A', code: 'INVALID_JSON', detail: 's1: JSON hỏng' }]);
    expect(body.stage?.outputsListing).toContain('review-khong-chay-duoc.md');
    expect(body.env?.projectRootLength).toBe('/Users/x/od-data/projects/p1'.length);
    expect(body.env?.activeRuns).toBe(2);
    expect(body.env?.connectivity).toEqual([{ target: 'https://ok.example/', result: 'HTTP 200', ms: expect.any(Number) }]);
    expect(typeof body.env?.memTotalBytes).toBe('number');
    expect(body.fingerprint).toBe(computeFingerprint('dr-review', { validation: [{ code: 'INVALID_JSON' }], error: 'x' }));
    expect(body.previousReportId).toBe('deadbeef');
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(outputsDir, { recursive: true, force: true });
  });
});
