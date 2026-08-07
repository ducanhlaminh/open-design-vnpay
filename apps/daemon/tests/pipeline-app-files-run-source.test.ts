// The `app-files` deterministic run source: a feature's run-config PICKS
// files out of its App's already-uploaded doc corpus
// (POST /api/pipelines/apps/:appId/upload-folder) instead of re-fetching
// Confluence or re-uploading per feature. Mirrors runDocsDeterministic's
// TOOL-ONLY shape (no agent) — see server.ts's runAppFilesDeterministic.
//
// Exercises the full HTTP round-trip via the real server (startServer): the
// copy happens in a detached background Promise the route does NOT await
// (POST /api/pipelines/:id/run returns 202 before the copy finishes, same as
// the Confluence deterministic path), so these tests POLL
// GET /api/pipelines?projectId=…&workflowId=… until the stage's status
// settles, then assert against the actual files on disk.

import type http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

const dataDir = process.env.OD_DATA_DIR as string;

describe('app-files deterministic run source', () => {
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

  async function createApp(appId: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/pipelines/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, name: appId }),
    });
    expect(res.status).toBe(201);
  }

  async function uploadAppDocs(appId: string, files: Array<{ path: string; text?: string; base64?: string }>) {
    const res = await fetch(`${baseUrl}/api/pipelines/apps/${appId}/upload-folder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written: number; skipped: unknown[] };
    return body;
  }

  async function createProject(projectId: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/pipelines/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: projectId }),
    });
    expect(res.status).toBe(201);
  }

  async function runDocsWithAppFiles(projectId: string, appId: string, paths: string[]): Promise<Response> {
    return fetch(`${baseUrl}/api/pipelines/docs/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, source: { kind: 'app-files', appId, paths } }),
    });
  }

  async function waitForStageSettled(
    projectId: string,
    pipelineId: string,
    workflowId = 'docs-to-ui',
    timeoutMs = 5000,
  ): Promise<any> {
    const start = Date.now();
    for (;;) {
      const res = await fetch(`${baseUrl}/api/pipelines?projectId=${projectId}&workflowId=${workflowId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pipelines: Array<{ id: string; status: string }> };
      const view = body.pipelines.find((p) => p.id === pipelineId);
      if (view && (view.status === 'succeeded' || view.status === 'failed')) return view;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${pipelineId} to settle (last status: ${view?.status})`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function readDest(projectId: string, relPath: string): Promise<string> {
    return readFile(path.join(dataDir, 'projects', projectId, 'docs-to-ui', 'docs', relPath), 'utf8');
  }

  async function saveAppFilesConfig(projectId: string, appId: string, paths: string[]): Promise<void> {
    const res = await fetch(`${baseUrl}/api/pipelines/projects/${projectId}/run-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appFiles: { appId, paths } }),
    });
    expect(res.status).toBe(200);
  }

  // No explicit source/input in the body — relies entirely on the project's
  // saved run-config appFiles selection.
  async function runDocsWithNoExplicitSource(projectId: string): Promise<Response> {
    return fetch(`${baseUrl}/api/pipelines/docs/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
  }

  it('copies a selected page AND its sibling attachments/ folder, marks the stage succeeded, persists lastInput/lastSource', async () => {
    const appId = uniqueId('app-files-app');
    const projectId = uniqueId('app-files-proj');
    await createApp(appId);
    await uploadAppDocs(appId, [
      { path: 'Overview.md', text: '# Overview\nSome page content.' },
      { path: 'Overview/attachments/img1.png', base64: Buffer.from('fake-png-bytes').toString('base64') },
      { path: 'Overview/attachments/nested/img2.png', base64: Buffer.from('fake-png-2').toString('base64') },
      // NOT selected — must not be copied.
      { path: 'Unrelated.md', text: '# Unrelated' },
    ]);
    await createProject(projectId);

    const startRes = await runDocsWithAppFiles(projectId, appId, ['Overview.md']);
    expect(startRes.status).toBe(202);

    const view = await waitForStageSettled(projectId, 'docs');
    expect(view.status).toBe('succeeded');
    expect(view.lastInput).toBe('Overview.md');
    expect(view.lastSource).toEqual({ kind: 'app-files', appId, paths: ['Overview.md'] });

    expect(await readDest(projectId, 'Overview.md')).toBe('# Overview\nSome page content.');
    expect(await readDest(projectId, 'Overview/attachments/img1.png')).toBe('fake-png-bytes');
    expect(await readDest(projectId, 'Overview/attachments/nested/img2.png')).toBe('fake-png-2');
    // The unselected sibling page must not have been copied.
    await expect(readDest(projectId, 'Unrelated.md')).rejects.toThrow();
  });

  it('copies a page with NO attachments/ folder without error (pairing is opportunistic, not required)', async () => {
    const appId = uniqueId('app-files-app');
    const projectId = uniqueId('app-files-proj');
    await createApp(appId);
    await uploadAppDocs(appId, [{ path: 'Solo.md', text: '# Solo page, no attachments' }]);
    await createProject(projectId);

    const startRes = await runDocsWithAppFiles(projectId, appId, ['Solo.md']);
    expect(startRes.status).toBe(202);

    const view = await waitForStageSettled(projectId, 'docs');
    expect(view.status).toBe('succeeded');
    expect(await readDest(projectId, 'Solo.md')).toBe('# Solo page, no attachments');
  });

  it('copies multiple selected paths from nested folders in one run', async () => {
    const appId = uniqueId('app-files-app');
    const projectId = uniqueId('app-files-proj');
    await createApp(appId);
    await uploadAppDocs(appId, [
      { path: 'folder-a/PageA.md', text: '# A' },
      { path: 'folder-b/PageB.md', text: '# B' },
    ]);
    await createProject(projectId);

    const startRes = await runDocsWithAppFiles(projectId, appId, ['folder-a/PageA.md', 'folder-b/PageB.md']);
    expect(startRes.status).toBe(202);

    const view = await waitForStageSettled(projectId, 'docs');
    expect(view.status).toBe('succeeded');
    expect(await readDest(projectId, 'folder-a/PageA.md')).toBe('# A');
    expect(await readDest(projectId, 'folder-b/PageB.md')).toBe('# B');
  });

  it('fails the stage when every selected path is missing from the app corpus (best-effort skip, nothing to copy)', async () => {
    const appId = uniqueId('app-files-app');
    const projectId = uniqueId('app-files-proj');
    await createApp(appId);
    await uploadAppDocs(appId, [{ path: 'Real.md', text: '# Real' }]);
    await createProject(projectId);

    const startRes = await runDocsWithAppFiles(projectId, appId, ['DoesNotExist.md']);
    expect(startRes.status).toBe(202);

    const view = await waitForStageSettled(projectId, 'docs');
    expect(view.status).toBe('failed');
  });

  it('best-effort: copies the paths that DO exist and skips ones that do not, still succeeding', async () => {
    const appId = uniqueId('app-files-app');
    const projectId = uniqueId('app-files-proj');
    await createApp(appId);
    await uploadAppDocs(appId, [{ path: 'Real.md', text: '# Real' }]);
    await createProject(projectId);

    const startRes = await runDocsWithAppFiles(projectId, appId, ['Real.md', 'Ghost.md']);
    expect(startRes.status).toBe(202);

    const view = await waitForStageSettled(projectId, 'docs');
    expect(view.status).toBe('succeeded');
    expect(await readDest(projectId, 'Real.md')).toBe('# Real');
  });

  describe('saved run-config appFiles fallback + precedence', () => {
    it('a run with NO explicit source/input falls back to the saved run-config appFiles selection', async () => {
      const appId = uniqueId('app-files-app');
      const projectId = uniqueId('app-files-proj');
      await createApp(appId);
      await uploadAppDocs(appId, [
        { path: 'SavedPage.md', text: '# From saved config' },
        { path: 'SavedPage/attachments/pic.png', base64: Buffer.from('pic-bytes').toString('base64') },
      ]);
      await createProject(projectId);
      await saveAppFilesConfig(projectId, appId, ['SavedPage.md']);

      const startRes = await runDocsWithNoExplicitSource(projectId);
      expect(startRes.status).toBe(202);

      const view = await waitForStageSettled(projectId, 'docs');
      expect(view.status).toBe('succeeded');
      expect(view.lastSource).toEqual({ kind: 'app-files', appId, paths: ['SavedPage.md'] });
      expect(await readDest(projectId, 'SavedPage.md')).toBe('# From saved config');
      expect(await readDest(projectId, 'SavedPage/attachments/pic.png')).toBe('pic-bytes');
    });

    it('an explicit per-run source WINS over a saved appFiles selection (precedence: explicit > saved appFiles)', async () => {
      const appId = uniqueId('app-files-app');
      const projectId = uniqueId('app-files-proj');
      await createApp(appId);
      await uploadAppDocs(appId, [{ path: 'FromApp.md', text: '# Would be copied if appFiles won' }]);
      await createProject(projectId);
      await saveAppFilesConfig(projectId, appId, ['FromApp.md']);

      // Explicit confluence source in THIS run's body — no PAT/BAS configured
      // in this test env, so the deterministic Confluence fetch throws and the
      // stage fails. That failure is itself proof the explicit source (not the
      // saved appFiles, which would have succeeded via a plain file copy) drove
      // this run.
      const res = await fetch(`${baseUrl}/api/pipelines/docs/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, source: { kind: 'confluence', ref: '999999' } }),
      });
      expect(res.status).toBe(202);

      const view = await waitForStageSettled(projectId, 'docs');
      expect(view.status).toBe('failed');
      expect(view.lastSource).toEqual({ kind: 'confluence', ref: '999999' });
    });

    it('an explicit per-run free-text input WINS over a saved appFiles selection', async () => {
      const appId = uniqueId('app-files-app');
      const projectId = uniqueId('app-files-proj');
      await createApp(appId);
      await uploadAppDocs(appId, [{ path: 'FromApp.md', text: '# Would be copied if appFiles won' }]);
      await createProject(projectId);
      await saveAppFilesConfig(projectId, appId, ['FromApp.md']);

      // Free-text input that LOOKS like a Confluence ref (all-lines-are-refs
      // gate) takes the deterministic Confluence path instead of appFiles —
      // same "no PAT configured → fails" proof as above.
      const res = await fetch(`${baseUrl}/api/pipelines/docs/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, input: '999999' }),
      });
      expect(res.status).toBe(202);

      const view = await waitForStageSettled(projectId, 'docs');
      expect(view.status).toBe('failed');
      expect(view.lastInput).toBe('999999');
    });
  });
});
