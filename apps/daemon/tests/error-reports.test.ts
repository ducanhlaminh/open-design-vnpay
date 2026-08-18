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
  createErrorReporter,
  ERROR_REPORTS_OUTBOX_DIR,
  readLogTail,
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
    expect(hook).toHaveBeenCalledWith({ projectId: 'PROJ', pipelineId: 'docs', error: 'boom', lastRunId: 'run-1' });
    expect(getProjectPipelineState(db, 'PROJ').docs).toMatchObject({ status: 'failed', error: 'boom', errorReportId: 'rep00001' });

    // Same failure written again (outer catch re-marking) → no second report.
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'boom' });
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed' });
    expect(hook).toHaveBeenCalledTimes(1);

    // A different reason while still failed IS a new failure.
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'other' });
    expect(hook).toHaveBeenCalledTimes(2);

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
