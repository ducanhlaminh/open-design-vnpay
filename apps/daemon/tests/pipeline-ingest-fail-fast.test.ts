// Live incident regression: dr-docs (a jira-ingest stage) fired with NO
// input/source/saved-config seeded an agent conversation that had nothing to
// do — the agent politely no-op'd and the stage flipped 'succeeded' with an
// empty docs/. The downstream stage then failed correctly but with NO error
// text (GET /api/pipelines' per-stage payload had nothing for "Xem lỗi" to
// show). Four fixes exercised here, all via the real server (real HTTP
// round-trip — the deterministic-vs-agent branching and the conversation
// seeding live deep inside server.ts's runPipeline, not reachable through a
// fake-express harness):
//   1. FAIL-FAST: no explicit input/source, and the stage's own docs/ isn't
//      already populated → fail the stage immediately, no conversation
//      created.
//   2. The 'failed' status now carries a short `error` string, round-tripped
//      through GET /api/pipelines.
//   3. HARD GATE (follow-up hardening — the incident continued after (1)
//      because non-empty, non-Confluence, non-JIRA input still fell through
//      to the legacy agent path): the ONLY route to the agent for a
//      jira-ingest stage is input that's genuinely JIRA-shaped
//      (looksLikeJiraInput — see bas-client.test.ts for the heuristic's own
//      unit coverage). Everything else (corpus file paths, plain text, a
//      stale web bundle's leftover value) fails immediately instead.
//   4. SUCCESS shortcut (the OTHER half of the ghost-run this incident kept
//      surfacing — "cần Atlassian MCP" on a project whose docs/ was already
//      populated by hand): empty input/source but the stage's own docs/
//      ALREADY has files → mark the stage succeeded immediately
//      (docsFromUpload semantics — see server.ts's runPipeline), no fetch,
//      no agent, docs left untouched.

import type http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

const dataDir = process.env.OD_DATA_DIR as string;

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

  it('fails fast (no input, no source, empty docs/) and does NOT create a conversation', async () => {
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
      'Chưa cấu hình Nguồn tài liệu — tick trang trong tài liệu App (hoặc chọn trang Confluence) ở panel cấu hình rồi chạy lại.',
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

  it('empty input/source + populated docs/ (docsFromUpload case) marks the stage succeeded immediately — no fetch, no agent, docs left intact', async () => {
    const projectId = uniqueId('docsfromupload');
    await createProject(projectId);

    // Pre-populate <projectId>/docs-to-ui/docs/ directly (the single-file
    // upload path UploadFilesModal uses for a manual "Tải file lên").
    const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'docs-to-ui/docs/manual.md', content: '# Manually uploaded' }),
    });
    expect(uploadRes.status).toBe(200);

    const res = await runDocs(projectId);
    expect(res.status).toBe(202);
    const start = (await res.json()) as { projectId: string; conversationId?: string; agentRunId?: string };
    // Same response shape as the fail-fast path — {projectId} only — proving
    // no conversation/agent was seeded either way.
    expect(start).toEqual({ projectId });
    expect(start.conversationId).toBeUndefined();
    expect(start.agentRunId).toBeUndefined();

    const view = await stageView(projectId, 'docs');
    expect(view.status).toBe('succeeded');
    expect(view.error).toBeUndefined();

    // The docs that made this branch fire are untouched — no re-run clear
    // ran (this branch returns before runPipeline's own clear block, and
    // never calls into a runner that clears docs/ itself).
    const content = await readFile(
      path.join(dataDir, 'projects', projectId, 'docs-to-ui', 'docs', 'manual.md'),
      'utf8',
    );
    expect(content).toBe('# Manually uploaded');
  });

  it('a real JIRA-key input STILL reaches agent seeding (the one legitimate route left open)', async () => {
    const projectId = uniqueId('jirakey');
    await createProject(projectId);

    const res = await runDocs(projectId, { input: 'PROJ-123' });
    expect(res.status).toBe(202);
    const start = (await res.json()) as { projectId: string; conversationId?: string; agentRunId?: string };
    expect(start.conversationId).toBeTruthy();
    expect(start.agentRunId).toBeTruthy();
    await cancelRun(start.agentRunId);
  });

  it('a JQL-shaped input also reaches agent seeding', async () => {
    const projectId = uniqueId('jql');
    await createProject(projectId);

    const res = await runDocs(projectId, { input: 'project = PROJ ORDER BY created DESC' });
    expect(res.status).toBe(202);
    const start = (await res.json()) as { projectId: string; conversationId?: string; agentRunId?: string };
    expect(start.conversationId).toBeTruthy();
    expect(start.agentRunId).toBeTruthy();
    await cancelRun(start.agentRunId);
  });

  // The hardening this round adds: HARD GATE — non-empty input that is
  // neither Confluence-shaped nor JIRA-shaped must fail immediately, not
  // fall through to the agent (the exact ghost-run vector that kept the
  // incident alive after the first fail-fast round).
  it.each([
    ['a corpus file path', 'Overview.md'],
    ['a nested corpus file path', 'nested/sub/dir/page.md'],
    ['plain text pasted by mistake', 'random text pasted by mistake'],
    ['a mix of one real JIRA key and one non-key line', 'PROJ-123\nOverview.md'],
  ])('garbage input (%s) fails immediately — no conversation created', async (_label, garbageInput) => {
    const projectId = uniqueId('garbage');
    await createProject(projectId);

    const res = await runDocs(projectId, { input: garbageInput });
    expect(res.status).toBe(202);
    const start = (await res.json()) as { projectId: string; conversationId?: string; agentRunId?: string };
    expect(start).toEqual({ projectId });
    expect(start.conversationId).toBeUndefined();
    expect(start.agentRunId).toBeUndefined();

    const view = await stageView(projectId, 'docs');
    expect(view.status).toBe('failed');
    expect(view.error).toBe(
      'Input không nhận dạng được (không phải link/id Confluence, không phải JIRA key/JQL). Chọn nguồn ở panel Nguồn tài liệu (Confluence) rồi chạy lại.',
    );
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
