// wp-docs-review-confirm-v2 (2026-08-28): comment CẤP BƯỚC của docs-review —
// file `docs-review/comments/<stageId>.json` ngoài outputs mọi stage.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DocsReviewCommentError,
  addDocsReviewStageComment,
  deleteDocsReviewStageComment,
  docsReviewCommentsPath,
  docsReviewStageIds,
  isDocsReviewStageId,
  parseDocsReviewStageCommentsFile,
  readAllDocsReviewStageComments,
  readDocsReviewStageComments,
} from '../src/docs-review-comments.js';
import { getWorkflow, relClearedByRegen, relClearedByRunAllLaunch, stagesForOutput } from '../src/pipelines.js';
import { closeDatabase, insertProject, openDatabase } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function tmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe('docs-review stage comments (module)', () => {
  it('stage ids come from the docs-review workflow registry, not a hard-coded list', () => {
    expect(docsReviewStageIds()).toEqual(getWorkflow('docs-review')!.pipelineIds);
    expect(isDocsReviewStageId('dr-review')).toBe(true);
    expect(isDocsReviewStageId('dr-comp')).toBe(false); // ẩn, ngoài pipelineIds
    expect(isDocsReviewStageId('docs')).toBe(false);
  });

  it('CRUD: missing file → [], add appends with id/by/at, delete removes, file is the v1 envelope', async () => {
    const root = await tmp('od-dr-comments-');
    expect(await readDocsReviewStageComments(root, 'dr-docs')).toEqual([]);

    const a = await addDocsReviewStageComment(root, 'dr-mockup', { text: '  Màn 2 thiếu nút quay lại  ', by: 'u@x', now: 10, target: { kind: 'screen', key: 'SCREEN-2', label: 'Màn 2' } });
    expect(a).toEqual({ id: expect.any(String), stageId: 'dr-mockup', text: 'Màn 2 thiếu nút quay lại', by: 'u@x', at: 10, target: { kind: 'screen', key: 'SCREEN-2', label: 'Màn 2' } });
    const b = await addDocsReviewStageComment(root, 'dr-mockup', { text: 'ok', by: 'v', now: 11 });
    expect(b.target).toBeUndefined();
    expect(a.id).not.toBe(b.id);

    const raw = JSON.parse(await fs.readFile(docsReviewCommentsPath(root, 'dr-mockup'), 'utf8'));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.comments.map((c: { id: string }) => c.id)).toEqual([a.id, b.id]);
    // Không để lại file tmp sau rename.
    expect((await fs.readdir(path.join(root, 'comments'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    expect(await deleteDocsReviewStageComment(root, 'dr-mockup', a.id)).toBe(true);
    expect(await deleteDocsReviewStageComment(root, 'dr-mockup', a.id)).toBe(false);
    expect((await readDocsReviewStageComments(root, 'dr-mockup')).map((c) => c.id)).toEqual([b.id]);

    const all = await readAllDocsReviewStageComments(root);
    expect(Object.keys(all)).toEqual(docsReviewStageIds());
    expect(all['dr-mockup']).toHaveLength(1);
    expect(all['dr-docs']).toEqual([]);
  });

  it('validates: unknown stage → 404, empty / too long text → 400, malformed target → 400', async () => {
    const root = await tmp('od-dr-comments-');
    await expect(addDocsReviewStageComment(root, 'dr-comp', { text: 'x', by: 'u' })).rejects.toMatchObject({ status: 404 });
    await expect(addDocsReviewStageComment(root, 'dr-docs', { text: '   ', by: 'u' })).rejects.toMatchObject({ status: 400 });
    await expect(addDocsReviewStageComment(root, 'dr-docs', { text: 'x'.repeat(4001), by: 'u' })).rejects.toMatchObject({ status: 400 });
    await expect(addDocsReviewStageComment(root, 'dr-docs', { text: 'x', by: 'u', target: { kind: 'bogus', key: 'k' } })).rejects.toBeInstanceOf(DocsReviewCommentError);
    await expect(addDocsReviewStageComment(root, 'dr-docs', { text: 'x', by: 'u', target: { kind: 'page', key: '' } })).rejects.toMatchObject({ status: 400 });
    await expect(deleteDocsReviewStageComment(root, 'nope', 'c1')).rejects.toMatchObject({ status: 404 });
    // Đúng 4000 ký tự vẫn nhận.
    await expect(addDocsReviewStageComment(root, 'dr-docs', { text: 'x'.repeat(4000), by: 'u' })).resolves.toMatchObject({ stageId: 'dr-docs' });
  });

  it('parses tolerantly: broken JSON → [], bad entries dropped, stageId forced from the file name', () => {
    expect(parseDocsReviewStageCommentsFile('{nope', 'dr-docs')).toEqual([]);
    const parsed = parseDocsReviewStageCommentsFile(JSON.stringify({ schemaVersion: 1, comments: [
      { id: 'a', stageId: 'dr-review', text: 'hi', by: 'u', at: 1, target: { kind: 'flow', key: 'SCREEN-FLOW' } },
      { id: '', text: 'no id', by: 'u', at: 1 },
      { id: 'b', text: '', by: 'u', at: 1 },
      { id: 'c', text: 'no at', by: 'u' },
      { id: 'd', text: 'no by', at: 2 },
      'junk',
    ] }), 'dr-docs');
    expect(parsed).toEqual([
      { id: 'a', stageId: 'dr-docs', text: 'hi', by: 'u', at: 1, target: { kind: 'flow', key: 'SCREEN-FLOW' } },
      { id: 'd', stageId: 'dr-docs', text: 'no by', by: 'unknown', at: 2 },
    ]);
  });

  it('lives outside every stage output: neither single-stage re-run nor run-all clear-on-launch touches comments/', () => {
    const ids = getWorkflow('docs-review')!.pipelineIds;
    for (const stageId of ids) {
      const rel = `docs-review/comments/${stageId}.json`;
      expect(stagesForOutput(rel)).toEqual([]);
      expect(relClearedByRegen(rel, new Set(ids), 'docs-review')).toBe(false);
      expect(relClearedByRunAllLaunch(rel, new Set(ids), 'docs-review', 'docs-review')).toBe(false);
    }
    // Đối chứng: output thật của stage thì BỊ xoá.
    expect(relClearedByRunAllLaunch('docs-review/mockups/index.json', new Set(ids), 'docs-review', 'docs-review')).toBe(true);
  });
});

describe('docs-review stage comment routes', () => {
  function fakeApp() {
    const handlers = new Map<string, (req: any, res: any) => unknown>();
    const app = {
      get: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`GET ${route}`, handler),
      post: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`POST ${route}`, handler),
      put: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`PUT ${route}`, handler),
      patch: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`PATCH ${route}`, handler),
      delete: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`DELETE ${route}`, handler),
      use: () => {},
    };
    return { app, handlers };
  }
  function fakeRes() {
    const out: { status: number; body?: unknown; ended?: boolean } = { status: 200 };
    const res = {
      status(code: number) { out.status = code; return res; },
      json(body: unknown) { out.body = body; return res; },
      end() { out.ended = true; return res; },
    };
    return { out, res };
  }

  it('GET → [] when no file, POST → 201 with identity, DELETE → 204 then 404; unknown stage/project → 404', async () => {
    const root = await tmp('od-dr-comments-route-');
    const db = openDatabase(root, { dataDir: root });
    insertProject(db, {
      id: 'p1', name: 'p1', skillId: null, designSystemId: null, pendingPrompt: null,
      metadata: { kind: 'pipeline' }, createdAt: 1, updatedAt: 1,
    });
    const { app, handlers } = fakeApp();
    registerPipelineRoutes(app as any, {
      db,
      pipelines: { runPipeline: async () => { throw new Error('unused'); }, localOutputs: async () => [] },
      paths: { PROJECTS_DIR: root, RUNTIME_DATA_DIR: root },
    } as any);
    const get = handlers.get('GET /api/projects/:id/docs-review/comments/:stageId')!;
    const post = handlers.get('POST /api/projects/:id/docs-review/comments/:stageId')!;
    const del = handlers.get('DELETE /api/projects/:id/docs-review/comments/:stageId/:commentId')!;
    expect(get && post && del).toBeTruthy();
    try {
      let r = fakeRes();
      await get({ params: { id: 'p1', stageId: 'dr-flow' } }, r.res);
      expect(r.out).toEqual({ status: 200, body: { stageId: 'dr-flow', comments: [] } });

      r = fakeRes();
      await get({ params: { id: 'p1', stageId: 'dr-comp' } }, r.out && r.res);
      expect(r.out.status).toBe(404);
      r = fakeRes();
      await get({ params: { id: 'nope', stageId: 'dr-flow' } }, r.res);
      expect(r.out.status).toBe(404);

      r = fakeRes();
      await post({ params: { id: 'p1', stageId: 'dr-flow' }, body: { text: 'Luồng thiếu bước OTP', target: { kind: 'flow', key: 'SCREEN-FLOW' } } }, r.res);
      expect(r.out.status).toBe(201);
      const created = (r.out.body as { comment: { id: string; by: string; at: number; text: string; stageId: string } }).comment;
      expect(created).toMatchObject({ stageId: 'dr-flow', text: 'Luồng thiếu bước OTP', target: { kind: 'flow', key: 'SCREEN-FLOW' } });
      expect(typeof created.by).toBe('string');
      expect(created.by.length).toBeGreaterThan(0);
      expect(created.at).toBeGreaterThan(0);
      // File nằm đúng chỗ: <PROJECTS_DIR>/p1/docs-review/comments/dr-flow.json
      await expect(fs.access(path.join(root, 'p1', 'docs-review', 'comments', 'dr-flow.json'))).resolves.toBeUndefined();

      r = fakeRes();
      await post({ params: { id: 'p1', stageId: 'dr-flow' }, body: { text: '   ' } }, r.res);
      expect(r.out.status).toBe(400);

      r = fakeRes();
      await get({ params: { id: 'p1', stageId: 'dr-flow' } }, r.res);
      expect((r.out.body as { comments: unknown[] }).comments).toHaveLength(1);

      r = fakeRes();
      await del({ params: { id: 'p1', stageId: 'dr-flow', commentId: created.id } }, r.res);
      expect(r.out).toEqual({ status: 204, ended: true });
      r = fakeRes();
      await del({ params: { id: 'p1', stageId: 'dr-flow', commentId: created.id } }, r.res);
      expect(r.out.status).toBe(404);
    } finally {
      closeDatabase();
    }
  });
});
