// App Docs Pool — GATE (docs/app-docs-pool-spec.md §2.1/§WP-4) + run-all
// PRESERVE, exercised via the REAL server (mirrors
// pipeline-ingest-fail-fast.test.ts's harness — the gate/copy dispatch lives
// deep inside server.ts's runPipeline, not reachable through a fake-express
// harness).

import type http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';
import { appDocsDir, sha256, writeManifest, type AppPoolManifest } from '../src/app-pool.js';

const dataDir = process.env.OD_DATA_DIR as string;
const projectsDir = path.join(dataDir, 'projects');

describe('App Docs Pool — GATE + deterministic copy + run-all preserve', () => {
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

  async function runDocsWithAppPool(projectId: string, appId: string, paths: string[]): Promise<Response> {
    return fetch(`${baseUrl}/api/pipelines/docs/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, source: { kind: 'app-pool', appId, paths } }),
    });
  }

  async function writePoolPage(appId: string, relPath: string, content: string): Promise<{ path: string; contentHash: string }> {
    const abs = path.join(appDocsDir(projectsDir, appId), relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return { path: relPath, contentHash: sha256(content) };
  }

  it('GATE FAIL: any pending (non-distilled) page in the pool fails the run — status failed, no copy', async () => {
    const projectId = uniqueId('gatefail');
    const appId = uniqueId('app');
    await createProject(projectId);

    const p1 = await writePoolPage(appId, 'branch-a/page-one.md', '# Page One');
    const manifest: AppPoolManifest = {
      version: 1,
      pages: [
        {
          pageId: '1',
          path: p1.path,
          title: 'Page One',
          branch: 'branch-a',
          contentHash: p1.contentHash,
          fetchedAt: Date.now(),
          distill: { state: 'fetched', distilledHash: null }, // NOT distilled
        },
      ],
    };
    await writeManifest(projectsDir, appId, manifest);

    const res = await runDocsWithAppPool(projectId, appId, [p1.path]);
    expect(res.status).toBe(202);

    const view = await pollUntilTerminal(projectId, 'docs');
    expect(view.status).toBe('failed');
    expect(view.error).toMatch(/1 trang chưa chưng cất/);
    expect(view.error).toMatch(/Chưng cất tài liệu/);

    // No copy happened.
    await expect(
      readFile(path.join(projectsDir, projectId, 'docs-to-ui', 'docs', p1.path), 'utf8'),
    ).rejects.toThrow();
  });

  it('GATE PASS: every page distilled with a matching hash → copies ticked pages + shared attachments into <wf>/docs/', async () => {
    const projectId = uniqueId('gatepass');
    const appId = uniqueId('app');
    await createProject(projectId);

    const p1 = await writePoolPage(appId, 'branch-a/page-one.md', '# Page One');
    const p2 = await writePoolPage(appId, 'branch-a/page-two.md', '# Page Two — not ticked');
    await mkdir(path.join(appDocsDir(projectsDir, appId), 'attachments'), { recursive: true });
    await writeFile(path.join(appDocsDir(projectsDir, appId), 'attachments', 'logo.png'), 'fake-bytes');

    const manifest: AppPoolManifest = {
      version: 1,
      pages: [
        {
          pageId: '1',
          path: p1.path,
          title: 'Page One',
          branch: 'branch-a',
          contentHash: p1.contentHash,
          fetchedAt: Date.now(),
          distill: { state: 'distilled', distilledHash: p1.contentHash },
        },
        {
          pageId: '2',
          path: p2.path,
          title: 'Page Two',
          branch: 'branch-a',
          contentHash: p2.contentHash,
          fetchedAt: Date.now(),
          distill: { state: 'distilled', distilledHash: p2.contentHash },
        },
      ],
    };
    await writeManifest(projectsDir, appId, manifest);

    // Only page-one is ticked as a "trang CHÍNH" — page-two stays pool-only.
    const res = await runDocsWithAppPool(projectId, appId, [p1.path]);
    expect(res.status).toBe(202);

    const view = await pollUntilTerminal(projectId, 'docs');
    expect(view.status).toBe('succeeded');

    const copied = await readFile(path.join(projectsDir, projectId, 'docs-to-ui', 'docs', p1.path), 'utf8');
    expect(copied).toBe('# Page One');
    // Untocked page is NOT copied into the feature's docs/.
    await expect(
      readFile(path.join(projectsDir, projectId, 'docs-to-ui', 'docs', p2.path), 'utf8'),
    ).rejects.toThrow();
    // Shared attachments folder travels along regardless of which pages were ticked.
    const logo = await readFile(
      path.join(projectsDir, projectId, 'docs-to-ui', 'docs', 'attachments', 'logo.png'),
      'utf8',
    );
    expect(logo).toBe('fake-bytes');
  });

  async function pollUntilTerminal(projectId: string, pipelineId: string, timeoutMs = 5000): Promise<any> {
    const start = Date.now();
    for (;;) {
      const view = await stageView(projectId, pipelineId);
      if (view?.status === 'succeeded' || view?.status === 'failed') return view;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${pipelineId} to reach a terminal state (status: ${view?.status})`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // ── run-all PRESERVE (docs/app-docs-pool-spec.md §1/§2.2 — the appFiles
  // history lesson) ──────────────────────────────────────────────────────
  it('PUT run-config sets appPool; a later POST run-all that omits it PRESERVES it (not full-replace-wiped)', async () => {
    const projectId = uniqueId('preserve');
    const appId = uniqueId('app');
    await createProject(projectId);

    const putRes = await fetch(`${baseUrl}/api/pipelines/projects/${projectId}/run-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appPool: { appId, paths: ['branch-a/page-one.md'] } }),
    });
    expect(putRes.status).toBe(200);

    const beforeRunAll = await fetch(`${baseUrl}/api/pipelines/projects`);
    const beforeBody = (await beforeRunAll.json()) as { projects: Array<Record<string, any>> };
    const beforeProject = beforeBody.projects.find((p) => p.id === projectId);
    expect(beforeProject?.savedRunAll?.appPool).toEqual({ appId, paths: ['branch-a/page-one.md'] });

    // Run-all WITHOUT mentioning appPool in the body — a project with no docs
    // yet fails fast almost immediately, but the metadata write happens
    // BEFORE that (see registerPipelineRoutes' run-all handler), so we don't
    // need to wait for the run to finish to check preservation.
    const runAllRes = await fetch(`${baseUrl}/api/pipelines/run-all`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, workflowId: 'docs-to-ui', terminal: 'ui-html' }),
    });
    expect(runAllRes.status).toBe(202);

    const afterRunAll = await fetch(`${baseUrl}/api/pipelines/projects`);
    const afterBody = (await afterRunAll.json()) as { projects: Array<Record<string, any>> };
    const afterProject = afterBody.projects.find((p) => p.id === projectId);
    expect(afterProject?.savedRunAll?.appPool).toEqual({ appId, paths: ['branch-a/page-one.md'] });
  });

  it('PUT run-config with appPool:null explicitly CLEARS a previously-saved appPool', async () => {
    const projectId = uniqueId('clear');
    const appId = uniqueId('app');
    await createProject(projectId);

    await fetch(`${baseUrl}/api/pipelines/projects/${projectId}/run-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appPool: { appId, paths: ['x.md'] } }),
    });
    const clearRes = await fetch(`${baseUrl}/api/pipelines/projects/${projectId}/run-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appPool: null, confluencePages: [] }),
    });
    expect(clearRes.status).toBe(200);

    const listRes = await fetch(`${baseUrl}/api/pipelines/projects`);
    const listBody = (await listRes.json()) as { projects: Array<Record<string, any>> };
    const project = listBody.projects.find((p) => p.id === projectId);
    expect(project?.savedRunAll?.appPool ?? null).toBeNull();
  });
});
