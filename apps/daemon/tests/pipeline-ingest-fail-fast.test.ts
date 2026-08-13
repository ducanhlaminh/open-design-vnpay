// Live incident regression: dr-docs (a confluence-ingest stage) fired with NO
// input/source/saved-config seeded an agent conversation that had nothing to
// do — the agent politely no-op'd and the stage flipped 'succeeded' with an
// empty docs/. The downstream stage then failed correctly but with NO error
// text (GET /api/pipelines' per-stage payload had nothing for "Xem lỗi" to
// show). Four fixes exercised here, all via the real server (real HTTP
// round-trip — the deterministic-vs-fail-fast branching lives deep inside
// server.ts's runPipeline, not reachable through a fake-express harness):
//   1. FAIL-FAST: no explicit input/source, and the stage's own docs/ isn't
//      already populated → fail the stage immediately, no conversation
//      created.
//   2. The 'failed' status now carries a short `error` string, round-tripped
//      through GET /api/pipelines.
//   3. HARD GATE (WP8, 2026-08: JIRA ingest removed entirely — there is no
//      more agent+mcp-atlassian path to fall through to). ALL non-empty,
//      non-Confluence input fails fast now, including a genuine JIRA key/JQL
//      (looksLikeJiraInput — see bas-client.test.ts for the heuristic's own
//      unit coverage, still used to pick a more specific rejection message).
//      No conversation is ever seeded for this stage.
//   4. SUCCESS shortcut (the OTHER half of the ghost-run this incident kept
//      surfacing — a stale "needs configuring" state on a project whose
//      docs/ was already populated by hand): empty input/source but the
//      stage's own docs/ ALREADY has files → mark the stage succeeded
//      immediately (docsFromUpload semantics — see server.ts's runPipeline),
//      no fetch, no agent, docs left untouched.

import type http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

const dataDir = process.env.OD_DATA_DIR as string;

describe('confluence-ingest fail-fast + persisted stage error', () => {
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

  // WP8 (2026-08): JIRA ingest was removed entirely. A genuine JIRA key/JQL
  // no longer reaches agent seeding — it fails fast, same as any other
  // non-Confluence input, but with a message that specifically says JIRA is
  // no longer supported (looksLikeJiraInput is kept only to pick that
  // message, see bas-client.test.ts for its own unit coverage).
  it.each([
    ['a real JIRA issue key', 'PROJ-123'],
    ['a JQL query', 'project = PROJ ORDER BY created DESC'],
  ])('JIRA-shaped input (%s) fails immediately with a "no longer supported" message — no conversation created', async (_label, jiraInput) => {
    const projectId = uniqueId('jira');
    await createProject(projectId);

    const res = await runDocs(projectId, { input: jiraInput });
    expect(res.status).toBe(202);
    const start = (await res.json()) as { projectId: string; conversationId?: string; agentRunId?: string };
    expect(start).toEqual({ projectId });
    expect(start.conversationId).toBeUndefined();
    expect(start.agentRunId).toBeUndefined();

    const view = await stageView(projectId, 'docs');
    expect(view.status).toBe('failed');
    expect(view.error).toBe(
      'Chỉ hỗ trợ Confluence URL — JIRA đã ngừng hỗ trợ. Chọn trang Confluence ở panel Nguồn tài liệu rồi chạy lại.',
    );
  });

  // The hardening this round adds: HARD GATE — ANY non-empty input that
  // isn't Confluence-shaped must fail immediately, never seed a
  // conversation (the exact ghost-run vector that kept the incident alive
  // after the first fail-fast round — now closed completely since there is
  // no more agent fallback for this stage at all).
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
      'Input không nhận dạng được (không phải link/id Confluence). Chọn nguồn ở panel Nguồn tài liệu (Confluence) rồi chạy lại.',
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
