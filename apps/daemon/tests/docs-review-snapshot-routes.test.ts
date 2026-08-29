import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docsReviewSnapshotProjectId } from '@open-design/contracts';
import { DocsReviewReportsCollector, type DocsReviewReportsMediaClient } from '../src/docs-review-reports.js';
import { registerDocsReviewSnapshotRoutes, snapshotOutputPathOf } from '../src/docs-review-snapshot-routes.js';

type FakeFile = { path: string; content: string | Buffer };
type FakeStore = Record<string, FakeFile[]>; // projectId → files

function fakeClient(store: FakeStore): DocsReviewReportsMediaClient {
  const ids = new Map<string, FakeFile>();
  return {
    async listFolders() {
      return Object.keys(store).map((name) => ({ id: `folder-${name}`, name }));
    },
    async listAllFiles(folderId: string) {
      const projectId = folderId.replace(/^folder-/, '');
      return (store[projectId] ?? []).map((file, index) => {
        const id = `${projectId}:${index}`;
        ids.set(id, file);
        return { id, path: file.path, stage: '', checksum: '', name: file.path.split('/').pop() ?? file.path, mime: '', size: 0 };
      });
    },
    async downloadById(id: string) {
      const file = ids.get(id);
      if (!file) throw new Error(`no file ${id}`);
      return Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    },
  };
}

const OUT = 'docs-review-feedback/inst-b/c-new/outputs/';
const v2Report = JSON.stringify({
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
    { stageId: 'dr-docs', name: 'Tài liệu', status: 'succeeded', outputs: [{ path: 'docs/a.md', size: 10, mediaPath: `${OUT}docs/a.md` }], comments: [], metrics: { kind: 'dr-docs', pages: 1 } },
    { stageId: 'dr-flow', name: 'Luồng', status: 'succeeded', outputs: [{ path: 'flows/SCREEN-FLOW/as-is.drawio', size: 30, mediaPath: `${OUT}flows/SCREEN-FLOW/as-is.drawio` }, { path: 'screens-discovered.json', size: 5, mediaPath: `${OUT}screens-discovered.json` }], comments: [{ id: 'cf1', stageId: 'dr-flow', text: 'Thiếu màn OTP', by: 'binh', at: 1_400, target: { kind: 'screen', key: 's2' } }], metrics: { kind: 'dr-flow', screens: 2, flows: 1, findings: 0 } },
    // Trùng path với dr-flow → /files phải dedupe.
    { stageId: 'dr-flow-improve', name: 'Cải thiện', status: 'succeeded', outputs: [{ path: 'flows/SCREEN-FLOW/as-is.drawio', size: 30, mediaPath: `${OUT}flows/SCREEN-FLOW/as-is.drawio` }, { path: 'flows/SCREEN-FLOW/proposed.drawio', size: 33, mediaPath: `${OUT}flows/SCREEN-FLOW/proposed.drawio` }], comments: [], metrics: { kind: 'dr-flow-improve', packages: 1, accepted: 1 } },
    { stageId: 'dr-mockup', name: 'Mockup', status: 'succeeded', outputs: [{ path: 'mockups/s1.html', size: 20, mediaPath: `${OUT}mockups/s1.html` }, { path: 'mockups/gone.html', size: 9, mediaPath: `${OUT}mockups/gone.html` }], comments: [{ id: 'cm1', stageId: 'dr-mockup', text: 'Đổi màu nút', by: 'binh', at: 1_500 }], metrics: { kind: 'dr-mockup', screens: 1, variant: null } },
  ],
  summary: { agentProposals: 7, humanEdits: 3, comments: 2, aiOutcome: { proposals: 7, accepted: 4, edited: 2, dismissed: 1 } },
  agent: { add: 5, edited: 1, delete: 1, total: 7, accepted: 4, editedByUser: 2, dismissed: 1 },
  userChanges: { add: 1, edited: 0, delete: 0, total: 1 },
  pages: [],
});

const v1Artifact = JSON.stringify({
  schemaVersion: 1, confirmationId: 'c-old', projectId: 'p-legacy', workflowId: 'docs-review', installationId: 'inst-a', user: 'an', channel: 'packaged', confirmedAt: 1_000,
  agent: { add: 3, edited: 1, delete: 1, total: 5, accepted: 2, editedByUser: 1, dismissed: 2 },
  userChanges: { add: 2, edited: 0, delete: 0, total: 2 },
  pages: [],
});

const store: FakeStore = {
  'p-v2': [
    { path: 'docs-review-feedback/inst-b/c-new/report.json', content: v2Report },
    { path: `${OUT}docs/a.md`, content: '# Hello' },
    { path: `${OUT}flows/SCREEN-FLOW/as-is.drawio`, content: '<mxfile/>' },
    { path: `${OUT}flows/SCREEN-FLOW/proposed.drawio`, content: '<mxfile proposed/>' },
    { path: `${OUT}screens-discovered.json`, content: '{"screens":[]}' },
    { path: `${OUT}mockups/s1.html`, content: '<html><body>mock</body></html>' },
    // mockups/gone.html nằm trong report nhưng KHÔNG còn trên media → 404 missing.
  ],
  'p-legacy': [
    { path: 'docs-review-feedback/inst-a/c-old.json', content: v1Artifact },
  ],
};

const SNAP = docsReviewSnapshotProjectId('p-v2', 'c-new');

describe('docs-review snapshot routes (dự án ảo chỉ đọc)', () => {
  let base = '';
  let server: ReturnType<express.Express['listen']>;

  beforeAll(async () => {
    const app = express();
    const collector = new DocsReviewReportsCollector({ client: () => fakeClient(store), log: () => {} });
    registerDocsReviewSnapshotRoutes(app, { collector, mimeFor: () => 'application/x-fallback' });
    // Route "thật" đăng ký SAU — id thường phải rơi xuống đây.
    app.get('/api/projects/:id/files', (req, res) => res.json({ real: true, id: req.params.id }));
    app.post('/api/projects/:id/docs-review/comments/:stageId', (_req, res) => res.json({ real: true }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('snapshotOutputPathOf strips the docs-review/ prefix and rejects names without it', () => {
    expect(snapshotOutputPathOf('docs-review/docs/a.md')).toBe('docs/a.md');
    expect(snapshotOutputPathOf('docs/a.md')).toBeNull();
    expect(snapshotOutputPathOf('docs-review/')).toBeNull();
  });

  it('(1) id thường → next(): route thật phía sau nhận request', async () => {
    const res = await fetch(`${base}/api/projects/p-v2/files`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ real: true, id: 'p-v2' });
    const post = await fetch(`${base}/api/projects/p-v2/docs-review/comments/dr-docs`, { method: 'POST' });
    expect(await post.json()).toEqual({ real: true });
  });

  it('(2) /files: union output mọi bước, dedupe path, prefix docs-review/, kind/mime/mtime', async () => {
    const res = await fetch(`${base}/api/projects/${SNAP}/files`);
    expect(res.status).toBe(200);
    const { files } = await res.json();
    expect(files.map((f: any) => f.name)).toEqual([
      'docs-review/docs/a.md',
      'docs-review/flows/SCREEN-FLOW/as-is.drawio',
      'docs-review/screens-discovered.json',
      'docs-review/flows/SCREEN-FLOW/proposed.drawio',
      'docs-review/mockups/s1.html',
      'docs-review/mockups/gone.html',
    ]);
    const md = files.find((f: any) => f.name === 'docs-review/docs/a.md');
    expect(md).toEqual({ name: 'docs-review/docs/a.md', path: 'docs-review/docs/a.md', type: 'file', size: 10, mtime: 2_000, kind: 'text', mime: 'text/markdown; charset=utf-8' });
    const html = files.find((f: any) => f.name === 'docs-review/mockups/s1.html');
    expect(html.kind).toBe('html');
    expect(html.mime).toBe('text/html; charset=utf-8');
    const json = files.find((f: any) => f.name === 'docs-review/screens-discovered.json');
    expect(json.kind).toBe('code');
    expect(json.mime).toBe('application/json; charset=utf-8');
  });

  it('(3) /raw/docs-review/<path>: nội dung + mime + CSP cho html + cache + CORS cho origin null', async () => {
    const md = await fetch(`${base}/api/projects/${SNAP}/raw/docs-review/docs/a.md`);
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(md.headers.get('content-security-policy')).toBeNull();
    expect(md.headers.get('cache-control')).toBe('private, max-age=300');
    expect(await md.text()).toBe('# Hello');

    const html = await fetch(`${base}/api/projects/${SNAP}/raw/docs-review/mockups/s1.html`, { headers: { origin: 'null' } });
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    expect(html.headers.get('access-control-allow-origin')).toBe('*');
    expect(await html.text()).toContain('mock');

    const drawio = await fetch(`${base}/api/projects/${SNAP}/raw/docs-review/flows/SCREEN-FLOW/proposed.drawio`);
    expect(drawio.status).toBe(200);
    expect(drawio.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(await drawio.text()).toBe('<mxfile proposed/>');

    const noOrigin = await fetch(`${base}/api/projects/${SNAP}/raw/docs-review/docs/a.md`);
    expect(noOrigin.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('(4) path không thuộc outputs → 404; thiếu prefix → 404; có trong report nhưng mất trên media → 404', async () => {
    const forbidden = await fetch(`${base}/api/projects/${SNAP}/raw/docs-review/project.json`);
    expect(forbidden.status).toBe(404);
    const traversal = await fetch(`${base}/api/projects/${SNAP}/raw/docs-review/..%2F..%2Fproject.json`);
    expect(traversal.status).toBe(404);
    const noPrefix = await fetch(`${base}/api/projects/${SNAP}/raw/docs/a.md`);
    expect(noPrefix.status).toBe(404);
    const missing = await fetch(`${base}/api/projects/${SNAP}/raw/docs-review/mockups/gone.html`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'File output không còn trên media' });
  });

  it('(5) comments theo stage từ report; stage lạ → 404; stage hợp lệ không có trong report → rỗng', async () => {
    const flow = await fetch(`${base}/api/projects/${SNAP}/docs-review/comments/dr-flow`);
    expect(flow.status).toBe(200);
    expect(await flow.json()).toEqual({
      stageId: 'dr-flow',
      comments: [{ id: 'cf1', stageId: 'dr-flow', text: 'Thiếu màn OTP', by: 'binh', at: 1_400, target: { kind: 'screen', key: 's2' } }],
    });
    const review = await fetch(`${base}/api/projects/${SNAP}/docs-review/comments/dr-review`);
    expect(review.status).toBe(200);
    expect(await review.json()).toEqual({ stageId: 'dr-review', comments: [] });
    const unknown = await fetch(`${base}/api/projects/${SNAP}/docs-review/comments/dr-nope`);
    expect(unknown.status).toBe(404);
  });

  it('(6) POST/PUT/DELETE → 405; OPTIONS → 204', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${base}/api/projects/${SNAP}/docs-review/comments/dr-docs`, { method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
      expect(res.status, method).toBe(405);
      expect(await res.json()).toEqual({ error: 'Bản xác nhận chỉ đọc' });
    }
    const del = await fetch(`${base}/api/projects/${SNAP}/raw/docs-review/docs/a.md`, { method: 'DELETE' });
    expect(del.status).toBe(405);
    const options = await fetch(`${base}/api/projects/${SNAP}/raw/docs-review/docs/a.md`, { method: 'OPTIONS', headers: { origin: 'null' } });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('(7) report không tồn tại / bản v1 → 404 ở mọi đường; GET / trả thông tin tối thiểu; GET khác → 404', async () => {
    const nope = docsReviewSnapshotProjectId('p-v2', 'nope');
    expect((await fetch(`${base}/api/projects/${nope}/files`)).status).toBe(404);
    expect((await fetch(`${base}/api/projects/${nope}/raw/docs-review/docs/a.md`)).status).toBe(404);
    expect((await fetch(`${base}/api/projects/${nope}/docs-review/comments/dr-docs`)).status).toBe(404);
    const legacy = docsReviewSnapshotProjectId('p-legacy', 'c-old');
    const legacyFiles = await fetch(`${base}/api/projects/${legacy}/files`);
    expect(legacyFiles.status).toBe(404);
    expect(await legacyFiles.json()).toEqual({ error: 'Bản xác nhận cũ (v1) không có chi tiết' });

    const root = await fetch(`${base}/api/projects/${SNAP}`);
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual({ id: SNAP, name: 'Chuyển tiền', metadata: {}, readOnly: true });

    const other = await fetch(`${base}/api/projects/${SNAP}/search?q=x`);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: 'not available for snapshot' });
  });
});
