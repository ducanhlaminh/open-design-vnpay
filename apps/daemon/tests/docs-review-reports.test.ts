import { describe, expect, it } from 'vitest';
import {
  DocsReviewReportsCollector,
  buildReportsResponse,
  dropShadowedV1,
  latestPerProject,
  registerDocsReviewReportRoutes,
  summaryFromV1,
  type DocsReviewReportsMediaClient,
} from '../src/docs-review-reports.js';

type FakeFile = { path: string; content: string | Buffer };
type FakeStore = Record<string, FakeFile[]>; // projectId → files

function fakeClient(store: FakeStore, counters = { folders: 0, lists: 0, downloads: 0 }): DocsReviewReportsMediaClient & { counters: typeof counters } {
  const ids = new Map<string, FakeFile>();
  return {
    counters,
    async listFolders() {
      counters.folders += 1;
      return Object.keys(store).map((name) => ({ id: `folder-${name}`, name }));
    },
    async listAllFiles(folderId: string) {
      counters.lists += 1;
      const projectId = folderId.replace(/^folder-/, '');
      return (store[projectId] ?? []).map((file, index) => {
        const id = `${projectId}:${index}`;
        ids.set(id, file);
        return { id, path: file.path, stage: '', checksum: '', name: file.path.split('/').pop() ?? file.path, mime: '', size: 0 };
      });
    },
    async downloadById(id: string) {
      counters.downloads += 1;
      const file = ids.get(id);
      if (!file) throw new Error(`no file ${id}`);
      return Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    },
  };
}

const v1Artifact = (confirmationId: string, confirmedAt: number, user = 'an') => JSON.stringify({
  schemaVersion: 1, confirmationId, projectId: 'p-legacy', workflowId: 'docs-review', installationId: 'inst-a', user, channel: 'packaged', confirmedAt,
  agent: { add: 3, edited: 1, delete: 1, total: 5, accepted: 2, editedByUser: 1, dismissed: 2 },
  userChanges: { add: 2, edited: 0, delete: 0, total: 2 },
  pages: [],
});

function v2Report(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 2,
    confirmationId: 'c-new',
    projectId: 'p-v2',
    workflowId: 'docs-review',
    installationId: 'inst-b',
    user: 'binh',
    channel: 'packaged',
    confirmedAt: 2_000,
    app: { id: 'app-1', name: 'Ví VNPAY' },
    feature: { id: 'p-v2', name: 'Chuyển tiền' },
    screenPlatform: 'mobile',
    stages: [
      { stageId: 'dr-docs', name: 'Tài liệu', status: 'succeeded', outputs: [{ path: 'docs/a.md', size: 10, mediaPath: 'docs-review-feedback/inst-b/c-new/outputs/docs/a.md' }], comments: [], metrics: { kind: 'dr-docs', pages: 1 } },
      { stageId: 'dr-mockup', name: 'Mockup', status: 'succeeded', outputs: [{ path: 'mockups/s1.html', size: 20, mediaPath: 'docs-review-feedback/inst-b/c-new/outputs/mockups/s1.html' }], skipped: [{ path: 'mockups/big.png', reason: 'size' }], comments: [{ id: 'cm1', stageId: 'dr-mockup', text: 'Đổi màu nút', by: 'binh', at: 1_500 }], metrics: { kind: 'dr-mockup', screens: 1, variant: null } },
    ],
    summary: { agentProposals: 7, humanEdits: 3, comments: 1, aiOutcome: { proposals: 7, accepted: 4, edited: 2, dismissed: 1 } },
    agent: { add: 5, edited: 1, delete: 1, total: 7, accepted: 4, editedByUser: 2, dismissed: 1 },
    userChanges: { add: 1, edited: 0, delete: 0, total: 1 },
    pages: [],
    ...overrides,
  });
}

const store: FakeStore = {
  'p-legacy': [
    { path: 'project.json', content: JSON.stringify({ name: 'Đăng nhập', studioConfig: { appId: 'app-1', appName: 'Ví VNPAY' } }) },
    { path: 'docs-review-feedback/inst-a/c-old.json', content: v1Artifact('c-old', 1_000) },
    { path: 'docs-review-feedback/inst-a/c-older.json', content: v1Artifact('c-older', 500, 'cuong') },
    { path: 'docs-review-feedback/inst-a/broken.json', content: '{not json' },
  ],
  'p-v2': [
    { path: 'docs-review-feedback/inst-b/c-new/report.json', content: v2Report() },
    { path: 'docs-review-feedback/inst-b/c-new/outputs/docs/a.md', content: '# Hello' },
    { path: 'docs-review-feedback/inst-b/c-new/outputs/mockups/s1.html', content: '<html><body>mock</body></html>' },
    { path: 'docs-review-feedback/inst-b/c-prev/report.json', content: v2Report({ confirmationId: 'c-prev', confirmedAt: 1_200, user: 'dung' }) },
    { path: 'docs-review-feedback/inst-b/c-bad/report.json', content: JSON.stringify({ schemaVersion: 2, confirmationId: 'c-bad' }) },
  ],
  'p-noapp': [
    { path: 'docs-review-feedback/inst-c/c-x.json', content: v1Artifact('c-x', 800, 'em') },
  ],
  'p-empty': [{ path: 'outputs/docs/x.md', content: 'nothing' }],
};

type Handler = (req: any, res: any) => Promise<void> | void;
function routes(collector: DocsReviewReportsCollector) {
  const table = new Map<string, Handler>();
  const app = { get: (route: string, handler: Handler) => table.set(route, handler) };
  registerDocsReviewReportRoutes(app as never, { collector, mimeFor: () => 'application/octet-stream' });
  return table;
}
async function call(handler: Handler, params = {}, query = {}) {
  const output: any = { status: 200, headers: {} as Record<string, string> };
  const res: any = {
    status: (status: number) => ((output.status = status), res),
    json: (json: unknown) => ((output.body = json), res),
    setHeader: (name: string, value: string) => { output.headers[name] = value; },
    send: (body: unknown) => ((output.sent = body), res),
  };
  await handler({ params, query }, res);
  // Handlers return a promise chain via `void …then()`; wait a tick for it.
  for (let i = 0; i < 20 && output.body === undefined && output.sent === undefined; i += 1) await new Promise((r) => setImmediate(r));
  return output;
}

describe('docs-review reports collector', () => {
  it('summaryFromV1 maps dr-review counts to the shared summary shape', () => {
    expect(summaryFromV1({ agent: { total: 5, accepted: 2, editedByUser: 1, dismissed: 2 }, userChanges: { total: 2 } })).toEqual({
      agentProposals: 5, humanEdits: 3, comments: 0, aiOutcome: { proposals: 5, accepted: 2, edited: 1, dismissed: 2 },
    });
  });

  it('merges v1 + v2 files, keeps only the latest confirmation per project and reports skipped files', async () => {
    const collector = new DocsReviewReportsCollector({ client: () => fakeClient(store) });
    const body = await collector.reports();
    expect(body.storeReachable).toBe(true);
    expect(body.summary).toEqual({
      apps: 1,
      features: 3,
      confirmations: 5,
      agentProposals: 7 + 5 + 5,
      humanEdits: 3 + 3 + 3,
      comments: 1,
      aiOutcome: { proposals: 17, accepted: 8, edited: 4, dismissed: 5 },
    });
    expect(body.completed.map((row) => [row.projectId, row.confirmationId, row.legacy])).toEqual([
      ['p-v2', 'c-new', false],
      ['p-legacy', 'c-old', true],
      ['p-noapp', 'c-x', true],
    ]);
    const legacy = body.completed.find((row) => row.projectId === 'p-legacy')!;
    expect(legacy.app).toEqual({ id: 'app-1', name: 'Ví VNPAY' });
    expect(legacy.feature).toEqual({ id: 'p-legacy', name: 'Đăng nhập' });
    expect(legacy.screenPlatform).toBeNull();
    expect(legacy.summary).toEqual({ agentProposals: 5, humanEdits: 3, comments: 0, aiOutcome: { proposals: 5, accepted: 2, edited: 1, dismissed: 2 } });
    const noApp = body.completed.find((row) => row.projectId === 'p-noapp')!;
    expect(noApp.app).toBeNull();
    expect(noApp.feature).toEqual({ id: 'p-noapp', name: 'p-noapp' });
    const v2 = body.completed.find((row) => row.projectId === 'p-v2')!;
    expect(v2.screenPlatform).toBe('mobile');
    expect(v2.feature).toEqual({ id: 'p-v2', name: 'Chuyển tiền' });

    expect(body.byApp.map((row) => [row.appId, row.appName, row.features, row.confirmations])).toEqual([
      ['app-1', 'Ví VNPAY', 2, 4],
      [null, 'Chưa gắn App', 1, 1],
    ]);
    expect(body.byApp[0].aiOutcome).toEqual({ proposals: 12, accepted: 6, edited: 3, dismissed: 3 });
    expect(body.skippedFiles.map((row) => row.path).sort()).toEqual([
      'docs-review-feedback/inst-a/broken.json',
      'docs-review-feedback/inst-b/c-bad/report.json',
    ]);
  });

  it('dropShadowedV1 removes the v1 twin of a confirmation that also has a v2 report (no double count, no duplicate history row)', () => {
    const base = { installationId: 'i', user: 'u', app: null, feature: { id: 'p', name: 'p' }, screenPlatform: null, summary: summaryFromV1({ agent: { total: 0, accepted: 0, editedByUser: 0, dismissed: 0 }, userChanges: { total: 0 } }), report: null };
    const kept = dropShadowedV1([
      { ...base, projectId: 'a', confirmationId: 'x', confirmedAt: 5, legacy: true },
      { ...base, projectId: 'a', confirmationId: 'x', confirmedAt: 5, legacy: false },
      { ...base, projectId: 'a', confirmationId: 'old', confirmedAt: 1, legacy: true },
      { ...base, projectId: 'b', confirmationId: 'x', confirmedAt: 2, legacy: true },
    ]);
    expect(kept.map((r) => `${r.projectId}:${r.confirmationId}:${r.legacy ? 'v1' : 'v2'}`)).toEqual(['a:x:v2', 'a:old:v1', 'b:x:v1']);
  });

  it('latestPerProject breaks ties on confirmationId and sorts newest first', () => {
    const base = { installationId: 'i', user: 'u', legacy: true, app: null, feature: { id: 'p', name: 'p' }, screenPlatform: null, summary: summaryFromV1({ agent: { total: 0, accepted: 0, editedByUser: 0, dismissed: 0 }, userChanges: { total: 0 } }), report: null };
    const rows = latestPerProject([
      { ...base, projectId: 'a', confirmationId: 'x', confirmedAt: 5 },
      { ...base, projectId: 'a', confirmationId: 'y', confirmedAt: 5 },
      { ...base, projectId: 'b', confirmationId: 'z', confirmedAt: 9 },
    ]);
    expect(rows.map((row) => `${row.projectId}:${row.confirmationId}`)).toEqual(['b:z', 'a:y']);
  });

  it('caches for the TTL, refresh=1 bypasses, and store failure yields storeReachable:false', async () => {
    let now = 100_000;
    const client = fakeClient(store);
    const collector = new DocsReviewReportsCollector({ client: () => client, now: () => now, ttlMs: 60_000, log: () => {} });
    await collector.reports();
    await collector.reports();
    expect(client.counters.folders).toBe(1);
    now += 30_000;
    await collector.reports({ refresh: true });
    expect(client.counters.folders).toBe(2);
    now += 61_000;
    await collector.reports();
    expect(client.counters.folders).toBe(3);

    const broken = new DocsReviewReportsCollector({ client: () => ({ ...client, listFolders: async () => { throw new Error('ECONNREFUSED'); } }), log: () => {} });
    expect(await broken.reports()).toEqual(expect.objectContaining({ storeReachable: false, completed: [], byApp: [], skippedFiles: [] }));
    const unconfigured = new DocsReviewReportsCollector({ client: () => null });
    expect((await unconfigured.reports()).storeReachable).toBe(false);
    expect(buildReportsResponse({ storeReachable: false, records: [], skippedFiles: [] }).summary.features).toBe(0);
  });
});

describe('docs-review reports routes', () => {
  it('GET /reports returns the aggregate; detail returns report + history; v1 detail is 404', async () => {
    const table = routes(new DocsReviewReportsCollector({ client: () => fakeClient(store), log: () => {} }));
    const list = await call(table.get('/api/pipelines/docs-review/reports')!);
    expect(list.status).toBe(200);
    expect(list.body.summary.features).toBe(3);

    const detail = await call(table.get('/api/pipelines/docs-review/reports/:projectId/:confirmationId')!, { projectId: 'p-v2', confirmationId: 'c-new' });
    expect(detail.status).toBe(200);
    expect(detail.body.report.confirmationId).toBe('c-new');
    expect(detail.body.report.stages.map((s: any) => s.stageId)).toEqual(['dr-docs', 'dr-mockup']);
    expect(detail.body.report.stages[1].skipped).toEqual([{ path: 'mockups/big.png', reason: 'size' }]);
    expect(detail.body.history).toEqual([
      { confirmationId: 'c-new', confirmedAt: 2_000, user: 'binh', legacy: false },
      { confirmationId: 'c-prev', confirmedAt: 1_200, user: 'dung', legacy: false },
    ]);

    const legacy = await call(table.get('/api/pipelines/docs-review/reports/:projectId/:confirmationId')!, { projectId: 'p-legacy', confirmationId: 'c-old' });
    expect(legacy.status).toBe(404);
    expect(legacy.body).toEqual({ error: 'Bản xác nhận cũ (v1) không có chi tiết' });

    const missing = await call(table.get('/api/pipelines/docs-review/reports/:projectId/:confirmationId')!, { projectId: 'p-v2', confirmationId: 'nope' });
    expect(missing.status).toBe(404);
  });

  it('output streams only allow-listed paths with content type by extension', async () => {
    const table = routes(new DocsReviewReportsCollector({ client: () => fakeClient(store), log: () => {} }));
    const handler = table.get('/api/pipelines/docs-review/reports/:projectId/:confirmationId/output')!;
    const md = await call(handler, { projectId: 'p-v2', confirmationId: 'c-new' }, { path: 'docs/a.md' });
    expect(md.status).toBe(200);
    expect(md.headers['Content-Type']).toBe('text/markdown; charset=utf-8');
    expect(md.headers['Content-Security-Policy']).toBeUndefined();
    expect(Buffer.from(md.sent).toString('utf8')).toBe('# Hello');

    const html = await call(handler, { projectId: 'p-v2', confirmationId: 'c-new' }, { path: 'mockups/s1.html', download: '1' });
    expect(html.status).toBe(200);
    expect(html.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(html.headers['Content-Security-Policy']).toBe('sandbox allow-scripts');
    expect(html.headers['Content-Disposition']).toContain('s1.html');

    const forbidden = await call(handler, { projectId: 'p-v2', confirmationId: 'c-new' }, { path: '../../project.json' });
    expect(forbidden.status).toBe(403);
    const notListed = await call(handler, { projectId: 'p-v2', confirmationId: 'c-new' }, { path: 'docs-review-feedback/inst-b/c-new/outputs/docs/a.md' });
    expect(notListed.status).toBe(403);
    const noPath = await call(handler, { projectId: 'p-v2', confirmationId: 'c-new' }, {});
    expect(noPath.status).toBe(400);
    const legacy = await call(handler, { projectId: 'p-legacy', confirmationId: 'c-old' }, { path: 'docs/a.md' });
    expect(legacy.status).toBe(404);
  });
});
