// App Confluence docs-tree spec (docs/app-docs-tree-picker-spec.md), MULTI-ROOT
// revision: an App's Confluence scope is now MULTIPLE roots. Covers the schema
// column (dual bare-id/JSON-array storage), App CRUD `confluenceRoots` (plural,
// new) / `confluenceRoot` (singular, legacy back-compat) normalization, and the
// v2 GET /api/pipelines/apps/:appId/docs-tree browse endpoint (`roots[]`,
// per-page `rootPageId`, root pages as selectable entries, cross-root dedupe,
// truncated = any root truncated).
//
// Same harness as tests/pipeline-apps-routes.test.ts: fake express app that
// records handlers by "METHOD path", real SQLite in a temp dir,
// `loadRemoteProjects` mocked dead (best-effort local-only branch). The
// Confluence-reading half of bas-client.js (`resolveConfluenceCreds`,
// `listDescendantPages`, `fetchConfluencePageDirect`) is ALSO mocked here —
// `extractPageId`/`looksLikeConfluenceRef` stay real via importOriginal so
// the CRUD normalization path exercises the actual parser.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, getPipelineApp, insertProject, openDatabase } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';
import type { ConfluenceCreds, DescendantPage } from '../src/bas/bas-client.js';

const UNREACHABLE = async (): Promise<unknown[]> => {
  throw new Error('stores unreachable');
};
let remoteImpl: () => Promise<unknown[]> = UNREACHABLE;

vi.mock('../src/kg-sync/remote-registry.js', () => ({
  loadRemoteProjects: () => remoteImpl(),
}));

const DEFAULT_CREDS: ConfluenceCreds = { base: 'https://wiki.test', token: 'tok_123' };
let credsImpl: () => Promise<ConfluenceCreds | null> = async () => DEFAULT_CREDS;
let descendantsImpl: (creds: ConfluenceCreds, root: string, hardCap?: number) => Promise<DescendantPage[]> =
  async () => [];
let rootMetaImpl: (
  creds: ConfluenceCreds,
  pageId: string,
) => Promise<{ title: string; url: string; html: string; macroHtml: string; ancestors: Array<{ id: string; title: string }> }> =
  async (_creds, pageId) => ({ title: `Root ${pageId}`, url: '', html: '', macroHtml: '', ancestors: [] });

vi.mock('../src/bas/bas-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bas/bas-client.js')>();
  return {
    ...actual,
    resolveConfluenceCreds: (..._args: unknown[]) => credsImpl(),
    listDescendantPages: (creds: ConfluenceCreds, root: string, hardCap?: number) =>
      descendantsImpl(creds, root, hardCap),
    fetchConfluencePageDirect: (creds: ConfluenceCreds, pageId: string) => rootMetaImpl(creds, pageId),
  };
});

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const handlers = new Map<string, Handler>();
  const record = (method: string) => (routePath: string, handler: Handler) => {
    handlers.set(`${method} ${routePath}`, handler);
  };
  return {
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    delete: record('DELETE'),
    patch: record('PATCH'),
    use: () => {},
    handlers,
  };
}

function makeRes() {
  const out: { status: number; body: any } = { status: 200, body: undefined };
  const res: any = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  return { res, out };
}

describe('app docs-tree spec (schema + CRUD + browse endpoint, multi-root)', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;

  beforeEach(() => {
    remoteImpl = UNREACHABLE;
    credsImpl = async () => DEFAULT_CREDS;
    descendantsImpl = async () => [];
    rootMetaImpl = async (_creds, pageId) => ({ title: `Root ${pageId}`, url: '', html: '', macroHtml: '', ancestors: [] });
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-docs-tree-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const app = makeApp();
    registerPipelineRoutes(app as any, {
      db,
      pipelines: { localOutputs: async () => [] },
      paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    } as any);
    handlers = app.handlers;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function call(key: string, req: Record<string, unknown> = {}) {
    const handler = handlers.get(key);
    expect(handler, `${key} should be registered`).toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ body: {}, query: {}, params: {}, ...req }, res);
    return out;
  }

  const postApp = (body: unknown) => call('POST /api/pipelines/apps', { body });
  const patchApp = (id: string, body: unknown) =>
    call('PATCH /api/pipelines/apps/:id', { params: { id }, body });
  const listApps = () => call('GET /api/pipelines/apps');
  const docsTree = (appId: string) =>
    call('GET /api/pipelines/apps/:appId/docs-tree', { params: { appId } });

  function insertFeature(id: string, appId: string, metadataExtra: Record<string, unknown> = {}) {
    const now = Date.now();
    insertProject(db, {
      id,
      name: id,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'pipeline', studioConfig: { appId }, ...metadataExtra },
      createdAt: now,
      updatedAt: now,
    });
  }

  // Simulates a row written BEFORE the multi-root revision existed: the bare
  // page id string, no JSON. Bypasses insertPipelineApp on purpose.
  function insertLegacyAppRow(id: string, name: string, bareConfluenceRoot: string) {
    const now = Date.now();
    db.prepare(`INSERT INTO pipeline_apps (id, name, created_at, confluence_root) VALUES (?, ?, ?, ?)`)
      .run(id, name, now, bareConfluenceRoot);
  }

  describe('schema', () => {
    it('adds confluence_root once and it survives a reopen (idempotent ALTER)', async () => {
      // First openDatabase() call (in beforeEach) already ran the migration —
      // insertPipelineApp already proves the column exists via the CRUD
      // routes below. Here: reopen the SAME on-disk file — the
      // pragma_table_info guard must skip the ALTER the second time instead
      // of throwing "duplicate column", and the column keeps working.
      expect((await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoot: '123' })).status).toBe(201);
      closeDatabase();

      let reopened: any;
      expect(() => {
        reopened = openDatabase(tempDir, { dataDir: tempDir });
      }).not.toThrow();
      expect(getPipelineApp(reopened, 'XPOS')?.confluenceRoots).toEqual(['123']);
      db = reopened;
    });

    it('reads a pre-multi-root legacy row (bare id string, no JSON) as a 1-element array', () => {
      insertLegacyAppRow('app--Ke_toan', 'Kế toán', '1001423450');
      expect(getPipelineApp(db, 'app--Ke_toan')?.confluenceRoots).toEqual(['1001423450']);
    });
  });

  describe('App CRUD confluenceRoots (multi-root) / confluenceRoot (legacy singular)', () => {
    it('normalizes a pasted Confluence URL to the pageId on create via the legacy singular field', async () => {
      const res = await postApp({
        appId: 'XPOS',
        name: 'X POS',
        confluenceRoot: 'https://wiki.test/pages/1000083499/Root',
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: 'XPOS',
        name: 'X POS',
        confluenceRoot: '1000083499',
        confluenceRoots: ['1000083499'],
      });
      expect(getPipelineApp(db, 'XPOS')?.confluenceRoots).toEqual(['1000083499']);
    });

    it('accepts a bare numeric page id on create via the legacy singular field', async () => {
      const res = await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoot: '42' });
      expect(res.status).toBe(201);
      expect(res.body.confluenceRoot).toBe('42');
      expect(res.body.confluenceRoots).toEqual(['42']);
    });

    it('400s on create when the legacy confluenceRoot does not resolve to a page id', async () => {
      const res = await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoot: 'not a confluence ref' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Could not find a Confluence page id/);
      expect(getPipelineApp(db, 'XPOS')).toBeNull();
    });

    it('omits confluenceRoot/confluenceRoots on create when neither is provided', async () => {
      const res = await postApp({ appId: 'XPOS', name: 'X POS' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: 'XPOS', name: 'X POS' });
      expect(getPipelineApp(db, 'XPOS')?.confluenceRoots).toBeUndefined();
    });

    it('accepts multiple roots via the plural confluenceRoots array on create', async () => {
      const res = await postApp({
        appId: 'XPOS',
        name: 'X POS',
        confluenceRoots: ['https://wiki.test/pages/111/A', '222', '/pages/333/C'],
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: 'XPOS',
        name: 'X POS',
        confluenceRoot: '111',
        confluenceRoots: ['111', '222', '333'],
      });
      expect(getPipelineApp(db, 'XPOS')?.confluenceRoots).toEqual(['111', '222', '333']);
    });

    it('dedupes repeated page ids within confluenceRoots', async () => {
      const res = await postApp({
        appId: 'XPOS',
        name: 'X POS',
        confluenceRoots: ['111', 'https://wiki.test/pages/111/A', '222'],
      });
      expect(res.status).toBe(201);
      expect(res.body.confluenceRoots).toEqual(['111', '222']);
    });

    it('400s on create when confluenceRoots is not an array', async () => {
      const res = await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoots: '111' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/confluenceRoots must be an array/);
      expect(getPipelineApp(db, 'XPOS')).toBeNull();
    });

    it('400s on create when a confluenceRoots entry is not a string', async () => {
      const res = await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoots: ['111', 42] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/confluenceRoots entries must be strings/);
      expect(getPipelineApp(db, 'XPOS')).toBeNull();
    });

    it('400s on create when a confluenceRoots entry does not resolve to a page id', async () => {
      const res = await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoots: ['111', 'not a confluence ref'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Could not find a Confluence page id/);
      expect(getPipelineApp(db, 'XPOS')).toBeNull();
    });

    it('confluenceRoots WINS when both confluenceRoots and the legacy confluenceRoot are present', async () => {
      const res = await postApp({
        appId: 'XPOS',
        name: 'X POS',
        confluenceRoot: '999',
        confluenceRoots: ['111', '222'],
      });
      expect(res.status).toBe(201);
      expect(res.body.confluenceRoots).toEqual(['111', '222']);
      expect(getPipelineApp(db, 'XPOS')?.confluenceRoots).toEqual(['111', '222']);
    });

    it('sets multiple confluenceRoots on update, preserves them on a rename that omits the field, and clears on []', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS' })).status).toBe(201);

      const setRes = await patchApp('XPOS', { name: 'X POS', confluenceRoots: ['/pages/999/Docs', '888'] });
      expect(setRes.status).toBe(200);
      expect(setRes.body).toEqual({
        id: 'XPOS',
        name: 'X POS',
        confluenceRoot: '999',
        confluenceRoots: ['999', '888'],
      });

      // Rename-only (no confluenceRoots/confluenceRoot key) must not clear the
      // stored roots.
      const renameRes = await patchApp('XPOS', { name: 'X POS 2' });
      expect(renameRes.status).toBe(200);
      expect(renameRes.body).toEqual({
        id: 'XPOS',
        name: 'X POS 2',
        confluenceRoot: '999',
        confluenceRoots: ['999', '888'],
      });
      expect(getPipelineApp(db, 'XPOS')?.confluenceRoots).toEqual(['999', '888']);

      const clearRes = await patchApp('XPOS', { name: 'X POS 2', confluenceRoots: [] });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body).toEqual({ id: 'XPOS', name: 'X POS 2' });
      expect(getPipelineApp(db, 'XPOS')?.confluenceRoots).toBeUndefined();
    });

    it('still accepts the legacy singular confluenceRoot on update ("" clears)', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS' })).status).toBe(201);

      const setRes = await patchApp('XPOS', { name: 'X POS', confluenceRoot: '/pages/999/Docs' });
      expect(setRes.status).toBe(200);
      expect(setRes.body).toEqual({ id: 'XPOS', name: 'X POS', confluenceRoot: '999', confluenceRoots: ['999'] });

      const clearRes = await patchApp('XPOS', { name: 'X POS', confluenceRoot: '' });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body).toEqual({ id: 'XPOS', name: 'X POS' });
      expect(getPipelineApp(db, 'XPOS')?.confluenceRoots).toBeUndefined();
    });

    it('400s on update when the legacy confluenceRoot does not resolve to a page id', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS' })).status).toBe(201);
      const res = await patchApp('XPOS', { name: 'X POS', confluenceRoot: 'nope' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Could not find a Confluence page id/);
    });

    it('400s on create when confluenceRoot is present but not a string (e.g. a JSON number)', async () => {
      const res = await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoot: 123 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/confluenceRoot must be a string/);
      expect(getPipelineApp(db, 'XPOS')).toBeNull();
    });

    it('400s on update when confluenceRoot is present but not a string, without clearing the stored roots', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoot: '123' })).status).toBe(201);
      const res = await patchApp('XPOS', { name: 'X POS', confluenceRoot: 123 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/confluenceRoot must be a string/);
      // A non-string value must not fall through to the '' → clear branch.
      expect(getPipelineApp(db, 'XPOS')?.confluenceRoots).toEqual(['123']);
    });

    it('confluenceRoots WINS over the legacy confluenceRoot on update too', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS' })).status).toBe(201);
      const res = await patchApp('XPOS', { name: 'X POS', confluenceRoot: '999', confluenceRoots: ['111', '222'] });
      expect(res.status).toBe(200);
      expect(res.body.confluenceRoots).toEqual(['111', '222']);
    });

    it('includes confluenceRoot + confluenceRoots in the GET /api/pipelines/apps picker payload for local apps only', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoots: ['123', '456'] })).status).toBe(201);
      expect((await postApp({ appId: 'VNPAY', name: 'VNPAY App' })).status).toBe(201);
      remoteImpl = async () => [
        { projectId: 'REMOTEAPP', name: 'Remote App', inKgs: true, inMedia: true, files: 0, isApp: true },
      ];

      const listed = await listApps();
      expect(listed.body).toEqual({
        apps: [
          { id: 'REMOTEAPP', name: 'Remote App', origin: 'remote' },
          { id: 'VNPAY', name: 'VNPAY App', origin: 'local' },
          { id: 'XPOS', name: 'X POS', origin: 'local', confluenceRoot: '123', confluenceRoots: ['123', '456'] },
        ],
      });
    });

    it('lists a legacy bare-id row through the picker as a 1-element confluenceRoots array', async () => {
      insertLegacyAppRow('app--Ke_toan', 'Kế toán', '1001423450');
      const listed = await listApps();
      expect(listed.body).toEqual({
        apps: [
          {
            id: 'app--Ke_toan',
            name: 'Kế toán',
            origin: 'local',
            confluenceRoot: '1001423450',
            confluenceRoots: ['1001423450'],
          },
        ],
      });
    });
  });

  describe('GET /api/pipelines/apps/:appId/docs-tree', () => {
    it('404s an app unknown to local pipeline_apps', async () => {
      const res = await docsTree('NOPE');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/);
    });

    it('404s an app that only exists denormalized on a feature (no pipeline_apps row)', async () => {
      insertFeature('xpos-checkout', 'XPOS');
      const res = await docsTree('XPOS');
      expect(res.status).toBe(404);
    });

    it('400s an app with no confluence_root configured', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS' })).status).toBe(201);
      const res = await docsTree('XPOS');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/confluence_root/);
    });

    it('502s when Confluence creds are not configured', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoot: '123' })).status).toBe(201);
      credsImpl = async () => null;
      const res = await docsTree('XPOS');
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/credential/i);
    });

    it('502s when the Confluence fetch throws', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoot: '123' })).status).toBe(201);
      descendantsImpl = async () => {
        throw new Error('Confluence subtree search HTTP 403 for 123');
      };
      const res = await docsTree('XPOS');
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/403/);
    });

    it('single root: returns v2 shape (roots[], rootPageId per page, root page itself as an entry) with usedBy and truncated=false', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoot: '123' })).status).toBe(201);
      descendantsImpl = async () => [
        { pageId: '456', title: 'Overview', treePath: [] },
        { pageId: '789', title: 'Refund flow', treePath: ['Folder A'] },
      ];
      rootMetaImpl = async () => ({ title: 'XPOS root', url: '', html: '', macroHtml: '', ancestors: [] });
      // Sibling feature of the SAME app already ingested page 456 (docs) via
      // free-text lastInput, and page 789 (dr-docs) via structured lastSource.
      insertFeature('xpos-checkout', 'XPOS', {
        pipelines: {
          docs: { status: 'succeeded', lastInput: 'https://wiki.test/pages/456/Overview' },
          'dr-docs': { status: 'succeeded', lastSource: { kind: 'confluence', ref: '789' } },
        },
      });
      // Feature of a DIFFERENT app must not leak into usedBy.
      insertFeature('vnpay-checkout', 'VNPAY', {
        pipelines: { docs: { status: 'succeeded', lastInput: '456' } },
      });

      const res = await docsTree('XPOS');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        root: { pageId: '123', title: 'XPOS root' },
        roots: [{ pageId: '123', title: 'XPOS root' }],
        pages: [
          // Root page itself is a selectable entry — treePath [], rootPageId = itself.
          { pageId: '123', title: 'XPOS root', treePath: [], rootPageId: '123', usedBy: [] },
          {
            pageId: '456',
            title: 'Overview',
            treePath: [],
            rootPageId: '123',
            usedBy: [{ projectId: 'xpos-checkout', pipelineId: 'docs' }],
          },
          {
            pageId: '789',
            title: 'Refund flow',
            treePath: ['Folder A'],
            rootPageId: '123',
            usedBy: [{ projectId: 'xpos-checkout', pipelineId: 'dr-docs' }],
          },
        ],
        truncated: false,
      });
    });

    it('falls back to the pageId as root title when the root metadata fetch fails', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoot: '123' })).status).toBe(201);
      rootMetaImpl = async () => {
        throw new Error('Confluence REST 403 for page 123');
      };
      const res = await docsTree('XPOS');
      expect(res.status).toBe(200);
      expect(res.body.root).toEqual({ pageId: '123', title: '123' });
      expect(res.body.roots).toEqual([{ pageId: '123', title: '123' }]);
    });

    it('sets truncated=true and slices back to 500 descendants (plus the root entry) when the tree is bigger than the cap', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoot: '123' })).status).toBe(201);
      // The route asks for DOCS_TREE_HARD_CAP + 1 (501) as a sentinel:
      // listDescendantPages itself hard-stops at whatever cap it's given, so
      // a tree with MORE than 500 pages returns exactly 501 here. Ids are
      // prefixed ("d0".."d500") so none collides with the root's own id
      // ("123") — the root-page entry must count as a genuinely extra page.
      descendantsImpl = async (_creds, _root, hardCap = 500) =>
        Array.from({ length: hardCap }, (_v, i) => ({ pageId: `d${i}`, title: `Page ${i}`, treePath: [] }));

      const res = await docsTree('XPOS');
      expect(res.status).toBe(200);
      expect(res.body.truncated).toBe(true);
      // 500 capped descendants + 1 root-page entry (id "123", distinct from
      // the stub's "d0".."d499" descendant ids).
      expect(res.body.pages).toHaveLength(501);
    });

    it('does NOT report truncated when the tree has exactly the cap (500) pages', async () => {
      expect((await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoot: '123' })).status).toBe(201);
      // Regression for the off-by-one: a real tree of exactly 500 pages,
      // asked with hardCap 501 (DOCS_TREE_HARD_CAP + 1), returns exactly 500
      // — nothing was cut, so truncated must be false.
      descendantsImpl = async () =>
        Array.from({ length: 500 }, (_v, i) => ({ pageId: `d${i}`, title: `Page ${i}`, treePath: [] }));

      const res = await docsTree('XPOS');
      expect(res.status).toBe(200);
      expect(res.body.truncated).toBe(false);
      expect(res.body.pages).toHaveLength(501); // + root-page entry
    });

    it('multi-root: merges disjoint roots, tags each page with its own rootPageId, includes both root pages', async () => {
      expect(
        (await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoots: ['100', '200'] })).status,
      ).toBe(201);
      descendantsImpl = async (_creds, root) =>
        root === '100'
          ? [{ pageId: '101', title: 'A1', treePath: [] }]
          : [{ pageId: '201', title: 'B1', treePath: [] }];
      rootMetaImpl = async (_creds, pageId) => ({
        title: pageId === '100' ? 'Root A' : 'Root B',
        url: '',
        html: '',
        macroHtml: '',
        ancestors: [],
      });

      const res = await docsTree('XPOS');
      expect(res.status).toBe(200);
      expect(res.body.root).toEqual({ pageId: '100', title: 'Root A' });
      expect(res.body.roots).toEqual([
        { pageId: '100', title: 'Root A' },
        { pageId: '200', title: 'Root B' },
      ]);
      expect(res.body.pages).toEqual([
        { pageId: '100', title: 'Root A', treePath: [], rootPageId: '100', usedBy: [] },
        { pageId: '101', title: 'A1', treePath: [], rootPageId: '100', usedBy: [] },
        { pageId: '200', title: 'Root B', treePath: [], rootPageId: '200', usedBy: [] },
        { pageId: '201', title: 'B1', treePath: [], rootPageId: '200', usedBy: [] },
      ]);
      expect(res.body.truncated).toBe(false);
    });

    it('multi-root: dedupes a page reachable from two overlapping roots, keeping the FIRST root\'s rootPageId', async () => {
      expect(
        (await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoots: ['100', '200'] })).status,
      ).toBe(201);
      // Page 999 sits under BOTH roots' sub-trees (overlapping scope).
      descendantsImpl = async (_creds, root) =>
        root === '100'
          ? [{ pageId: '999', title: 'Shared', treePath: ['Folder A'] }]
          : [{ pageId: '999', title: 'Shared', treePath: ['Folder B'] }];
      rootMetaImpl = async (_creds, pageId) => ({
        title: `Root ${pageId}`,
        url: '',
        html: '',
        macroHtml: '',
        ancestors: [],
      });

      const res = await docsTree('XPOS');
      expect(res.status).toBe(200);
      const shared = res.body.pages.find((p: any) => p.pageId === '999');
      expect(shared).toEqual({ pageId: '999', title: 'Shared', treePath: ['Folder A'], rootPageId: '100', usedBy: [] });
      // Exactly one entry for the shared page — not one per root.
      expect(res.body.pages.filter((p: any) => p.pageId === '999')).toHaveLength(1);
    });

    it('multi-root: a page that IS one root, discovered as a descendant of an earlier root, keeps the earlier root\'s rootPageId', async () => {
      expect(
        (await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoots: ['100', '200'] })).status,
      ).toBe(201);
      // Root 200 is nested INSIDE root 100's sub-tree.
      descendantsImpl = async (_creds, root) =>
        root === '100'
          ? [{ pageId: '200', title: 'Nested root', treePath: ['Folder A'] }]
          : [{ pageId: '201', title: 'B1', treePath: [] }];
      rootMetaImpl = async (_creds, pageId) => ({
        title: `Root ${pageId}`,
        url: '',
        html: '',
        macroHtml: '',
        ancestors: [],
      });

      const res = await docsTree('XPOS');
      expect(res.status).toBe(200);
      const nested = res.body.pages.find((p: any) => p.pageId === '200');
      // Kept root 100's descendant entry (treePath from A's walk), not the
      // later self-as-root entry that would have overwritten it.
      expect(nested).toEqual({ pageId: '200', title: 'Nested root', treePath: ['Folder A'], rootPageId: '100', usedBy: [] });
      expect(res.body.pages.filter((p: any) => p.pageId === '200')).toHaveLength(1);
      // Root 200's OWN sub-tree (201) is still walked and included.
      expect(res.body.pages.some((p: any) => p.pageId === '201')).toBe(true);
    });

    it('multi-root: truncated=true when ANY root hits the cap, even if the others are small', async () => {
      expect(
        (await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoots: ['100', '200'] })).status,
      ).toBe(201);
      descendantsImpl = async (_creds, root, hardCap = 500) =>
        root === '100'
          ? [{ pageId: '101', title: 'A1', treePath: [] }] // small, not truncated
          : Array.from({ length: hardCap }, (_v, i) => ({ pageId: `b${i}`, title: `B${i}`, treePath: [] })); // hits the cap

      const res = await docsTree('XPOS');
      expect(res.status).toBe(200);
      expect(res.body.truncated).toBe(true);
    });

    it('multi-root: usedBy is computed once per page id and applies regardless of which root surfaced it', async () => {
      expect(
        (await postApp({ appId: 'XPOS', name: 'X POS', confluenceRoots: ['100', '200'] })).status,
      ).toBe(201);
      descendantsImpl = async (_creds, root) =>
        root === '100' ? [{ pageId: '101', title: 'A1', treePath: [] }] : [];
      insertFeature('xpos-checkout', 'XPOS', {
        pipelines: { docs: { status: 'succeeded', lastInput: '101' } },
      });

      const res = await docsTree('XPOS');
      const page = res.body.pages.find((p: any) => p.pageId === '101');
      expect(page.usedBy).toEqual([{ projectId: 'xpos-checkout', pipelineId: 'docs' }]);
    });
  });
});
