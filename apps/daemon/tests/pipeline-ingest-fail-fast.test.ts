// Live incident regression: dr-docs (a jira-ingest stage) fired with NO
// input/source/saved-config seeded an agent conversation that had nothing to
// do — the agent politely no-op'd and the stage flipped 'succeeded' with an
// empty docs/. The downstream stage then failed correctly but with NO error
// text (GET /api/pipelines' per-stage payload had nothing for "Xem lỗi" to
// show). Two fixes exercised here, both via the real server (real HTTP round-
// trip — the deterministic-vs-agent branching and the conversation seeding
// live deep inside server.ts's runPipeline, not reachable through a fake-
// express harness):
//   1. FAIL-FAST: no explicit input/source, no saved runAllConfig.appFiles,
//      and the stage's own docs/ isn't already populated → fail the stage
//      immediately, no conversation created.
//   2. The 'failed' status now carries a short `error` string, round-tripped
//      through GET /api/pipelines.

import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

describe('jira-ingest fail-fast + persisted stage error', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function uniqueId(label: string): string {
    return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function createProject(projectId: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/pipelines/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: projectId }),
    });
    expect(res.status).toBe(201);
  }

  async function stageView(projectId: string, pipelineId: string, workflowId = 'docs-to-ui'): Promise<any> {
    const res = await fetch(`${baseUrl}/api/pipelines?projectId=${projectId}&workflowId=${workflowId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pipelines: Array<Record<string, unknown>> };
    return body.pipelines.find((p) => p.id === pipelineId);
  }

  async function runDocs(projectId: string, body: Record<string, unknown> = {}): Promise<Response> {
    return fetch(`${baseUrl}/api/pipelines/docs/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, ...body }),
    });
  }

  it('fails fast (no input, no source, no saved appFiles, empty docs/) and does NOT create a conversation', async () => {
    const projectId = uniqueId('failfast');
    await createProject(projectId);

    const res = await runDocs(projectId);
    expect(res.status).toBe(202);
    const start = (await res.json()) as { projectId: string; conversationId?: string; agentRunId?: string };
    // The normal agent-seeding path always returns conversationId + agentRunId
    // alongside projectId — their absence here IS the proof no conversation
    // was seeded.
    expect(start).toEqual({ projectId });
    expect(start.conversationId).toBeUndefined();
    expect(start.agentRunId).toBeUndefined();

    // The fail-fast path writes the DB status synchronously (inline in
    // runPipeline, not inside a detached completion promise) — no polling
    // needed, the write is already done by the time the 202 response lands.
    const view = await stageView(projectId, 'docs');
    expect(view.status).toBe('failed');
    expect(view.error).toBe(
      'Chưa cấu hình Nguồn tài liệu — chọn trang Confluence hoặc Tài liệu App ở panel cấu hình rồi chạy lại.',
    );
  });

  // Best-effort: cancel a seeded run right after asserting it started, so a
  // real agent CLI (when one happens to be detected in this environment —
  // e.g. a local `claude` install) doesn't keep running unbounded as a side
  // effect of proving the fail-fast gate was correctly bypassed. Never
  // fails the test if cancellation itself 404s/errors.
  async function cancelRun(agentRunId: string | undefined): Promise<void> {
    if (!agentRunId) return;
    await fetch(`${baseUrl}/api/runs/${agentRunId}/cancel`, { method: 'POST' }).catch(() => null);
  }

  it('does NOT fail fast when the stage\'s own docs/ is already populated (docsFromUpload case) — falls through to the normal agent path instead', async () => {
    const projectId = uniqueId('docsfromupload');
    await createProject(projectId);

    // Pre-populate <projectId>/docs-to-ui/docs/ directly (the single-file
    // upload path UploadFilesModal uses for a manual "Tải file lên" — distinct
    // from the App-level doc corpus routes).
    const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'docs-to-ui/docs/manual.md', content: '# Manually uploaded' }),
    });
    expect(uploadRes.status).toBe(200);

    const res = await runDocs(projectId);
    expect(res.status).toBe(202);
    const start = (await res.json()) as { projectId: string; conversationId?: string; agentRunId?: string };
    // The fail-fast path's response is ONLY { projectId } (see the previous
    // test) — a real conversationId/agentRunId here proves it fell through to
    // the normal agent-seeding path instead of taking the fail-fast shortcut.
    expect(start.conversationId).toBeTruthy();
    expect(start.agentRunId).toBeTruthy();
    await cancelRun(start.agentRunId);
  });

  it('does NOT fail fast when free-text input is present (even a non-Confluence JIRA-key-shaped value) — falls through to the agent path', async () => {
    const projectId = uniqueId('jirakey');
    await createProject(projectId);

    const res = await runDocs(projectId, { input: 'PROJ-123' });
    expect(res.status).toBe(202);
    const start = (await res.json()) as { projectId: string; conversationId?: string; agentRunId?: string };
    expect(start.conversationId).toBeTruthy();
    expect(start.agentRunId).toBeTruthy();
    await cancelRun(start.agentRunId);
  });

  it('a deterministic-ingest run failure (agent-adjacent tool-only path) persists the run\'s own error, which round-trips through GET /api/pipelines', async () => {
    const projectId = uniqueId('confluencefail');
    await createProject(projectId);

    // Explicit Confluence source takes the deterministic (no-agent) fetch
    // path; no PAT/BAS is configured in this test environment, so the fetch
    // throws — caught by runDocsDeterministic's own catch, which now stores
    // `error: String(error?.message ?? error)` instead of a bare 'failed'.
    const res = await runDocs(projectId, { source: { kind: 'confluence', ref: '999999' } });
    expect(res.status).toBe(202);

    const start = Date.now();
    let view: any;
    for (;;) {
      view = await stageView(projectId, 'docs');
      if (view?.status === 'failed') break;
      if (Date.now() - start > 5000) throw new Error(`timed out waiting for docs to fail (status: ${view?.status})`);
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(view.status).toBe('failed');
    expect(view.error).toMatch(/Confluence/i);
    expect(view.error).not.toMatch(/^Bước chạy thất bại/); // the real reason, not the generic fallback
  });
});
