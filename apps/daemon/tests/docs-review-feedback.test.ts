import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { DocsReviewRevokeError, aggregateDocsReviewMetrics, assertDocsReviewCoverageComplete, buildDocsReviewReport, computeDocsReviewConfirmationDigest, confirmDocsReview, countNotesFile, docsReviewConfirmContextOf, readDocsReviewConfirmationState, readDocsReviewMetricsPages, revokeDocsReviewConfirmation } from '../src/docs-review-feedback.js';
import { addDocsReviewStageComment } from '../src/docs-review-comments.js';
import { parseDocReviewAnnotationFile } from '@open-design/contracts';
import { closeDatabase, insertProject, openDatabase } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function writeCompleteCoverage(root: string, page = 'docs/one.md'): Promise<void> {
  const changesPath = path.join(root, 'review', page.replace(/\.md$/i, '.changes.json'));
  await Promise.all([
    fs.mkdir(path.join(root, 'flows'), { recursive: true }),
    fs.mkdir(path.join(root, 'comp'), { recursive: true }),
    fs.mkdir(path.dirname(changesPath), { recursive: true }),
  ]);
  await fs.access(changesPath).catch(() => fs.writeFile(changesPath, '[]'));
  await Promise.all([
    fs.writeFile(path.join(root, 'flows', 'index.json'), JSON.stringify([
      { id: 'flow-1', screens: [{ key: 'SCREEN-1', name: 'Screen 1' }] },
    ])),
    fs.writeFile(path.join(root, 'comp', '_inputs.json'), JSON.stringify({ screens: [{ key: 'SCREEN-1' }] })),
    fs.writeFile(path.join(root, 'comp', 'index.json'), JSON.stringify({ screens: [{ key: 'SCREEN-1' }], failed: [] })),
    fs.writeFile(path.join(root, 'review', 'index.json'), JSON.stringify({
      pages: [{ page: 'One', doc_path: page, review_path: `review/${page}`, status: 'succeeded', sections_total: 1, sections_failed: 0 }],
    })),
  ]);
}

describe('docs-review feedback metrics', () => {
  it('normalizes legacy changes and attributes user edits without losing agent operations', () => {
    const parsed = parseDocReviewAnnotationFile(JSON.stringify([
      { id: 'a', quote: 'new', reason: 'r' },
      { id: 'b', before: 'old', quote: 'newer', reason: 'r', status: 'edited' },
      { id: 'c', before: 'gone', anchor: 'x', reason: 'r', status: 'dismissed' },
    ]))!;
    const result = aggregateDocsReviewMetrics([{ page: 'one.md', annotations: parsed }]);
    expect(result.agent).toEqual({ add: 1, edited: 1, delete: 1, total: 3, accepted: 1, editedByUser: 1, dismissed: 1 });
    expect(result.userChanges).toEqual({ add: 0, edited: 1, delete: 0, total: 1 });
  });

  it('counts active user-origin operations and ignores dismissed user annotations', () => {
    const result = aggregateDocsReviewMetrics([{ page: 'one.md', annotations: {
      schemaVersion: 2,
      events: [],
      annotations: [
        { id: 'u1', origin: 'user', operation: 'add', quote: 'a' },
        { id: 'u2', origin: 'user', operation: 'delete', before: 'b' },
        { id: 'u3', origin: 'user', operation: 'edited', before: 'c', quote: 'd', status: 'dismissed' },
      ],
    } }]);
    expect(result.userChanges).toEqual({ add: 1, edited: 0, delete: 1, total: 2 });
  });

  it('uses the append-only user ledger when its current-state projection is stale', () => {
    const result = aggregateDocsReviewMetrics([{ page: 'one.md', annotations: {
      schemaVersion: 2,
      annotations: [
        { id: 'agent-edited', origin: 'agent', operation: 'add', quote: 'a', status: 'active' },
        { id: 'agent-dismissed', origin: 'agent', operation: 'delete', before: 'b', status: 'active' },
        { id: 'user-restored', origin: 'user', operation: 'edited', before: 'c', quote: 'd', status: 'dismissed' },
      ],
      events: [
        { id: 'e1', annotationId: 'agent-edited', type: 'edit', actor: 'user', at: 1 },
        { id: 'e2', annotationId: 'agent-dismissed', type: 'dismiss', actor: 'user', at: 2 },
        { id: 'e3', annotationId: 'user-restored', type: 'restore', actor: 'user', at: 3 },
      ],
    } }]);
    expect(result.agent).toEqual({ add: 1, edited: 0, delete: 1, total: 2, accepted: 0, editedByUser: 1, dismissed: 1 });
    expect(result.userChanges).toEqual({ add: 0, edited: 2, delete: 0, total: 2 });
  });

  it('publishes the canonical idempotent path and writes a local receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-doc-review-feedback-'));
    dirs.push(root);
    const review = path.join(root, 'review', 'docs');
    await fs.mkdir(review, { recursive: true });
    await fs.writeFile(path.join(review, 'one.changes.json'), JSON.stringify([{ id: 'a', quote: 'new', reason: 'r' }]));
    await writeCompleteCoverage(root);
    const uploads: Array<{ stage: string; filePath: string; body: string }> = [];
    const result = await confirmDocsReview({
      projectId: 'p1', workflowRoot: root, installationId: 'install/1', user: 'u', channel: 'dev',
      confirmationId: 'confirm-1', now: 123,
      client: { uploadFile: async (_project: string, stage: string, filePath: string, _mime: string, body: Buffer) => { uploads.push({ stage, filePath, body: body.toString() }); } } as never,
    });
    // v2: report.json trong thư mục riêng của lần xác nhận; v1 vẫn upload song
    // song (studio cũ đọc) — TODO bỏ khi K ship.
    expect(result.mediaPath).toBe('docs-review-feedback/install-1/confirm-1/report.json');
    const paths = uploads.map((u) => u.filePath);
    expect(paths).toContain(result.mediaPath);
    expect(paths).toContain('docs-review-feedback/install-1/confirm-1.json');
    expect(JSON.parse(uploads.find((u) => u.filePath.endsWith('/confirm-1.json'))!.body).schemaVersion).toBe(1);
    expect(paths).toContain('docs-review-feedback/install-1/confirm-1/outputs/review/docs/one.changes.json');
    // Output lên TRƯỚC report (report chỉ tham chiếu file đã có).
    expect(paths.indexOf(result.mediaPath)).toBeGreaterThan(paths.indexOf('docs-review-feedback/install-1/confirm-1/outputs/flows/index.json'));
    const artifact = JSON.parse(await readFile(path.join(root, result.localPath), 'utf8'));
    expect(artifact.schemaVersion).toBe(2);
    expect(artifact.confirmationId).toBe('confirm-1');
    expect(result.artifact).toEqual(artifact);
    expect(JSON.stringify(artifact)).not.toContain('new');
  });

  // Regression: App-pool projects (App docs pool, 08/2026) ingest into
  // docs-feature/ instead of docs/, and dr-review clones that tree into
  // review/docs-feature/ (docs-review.ts's cloneDocsForReview picks the root
  // name from the ingested pages). listChangeFiles only walked review/docs,
  // so an App-pool run had zero change files and confirmDocsReview always
  // threw "Chưa có output dr-review để xác nhận" even though the redline
  // pages existed on disk.
  it('finds change files under review/docs-feature/ (App docs pool) with no review/docs/ present', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-doc-review-feedback-feature-'));
    dirs.push(root);
    const dir = path.join(root, 'review', 'docs-feature', 'A');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'B.changes.json'), JSON.stringify([{ id: 'a', quote: 'new', reason: 'r' }]));
    const { pages } = await readDocsReviewMetricsPages(root);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.page).toBe('docs-feature/A/B.md');
    // `page` must always use '/' regardless of OS (path.relative returns
    // native separators — a Windows run would otherwise emit
    // 'docs-feature\\A\\B.md').
    expect(pages[0]?.page).not.toContain('\\');
  });

  // Compatibility: legacy Confluence-sourced runs clone into review/docs/;
  // `page` stays relative to `review/` (not `review/docs/`) so both roots
  // share the same addressing scheme.
  it('finds change files under review/docs/ (legacy Confluence) and keeps `page` relative to review/', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-doc-review-feedback-legacy-'));
    dirs.push(root);
    const dir = path.join(root, 'review', 'docs', 'confluence');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'x.changes.json'), JSON.stringify([{ id: 'a', quote: 'new', reason: 'r' }]));
    const { pages } = await readDocsReviewMetricsPages(root);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.page).toBe('docs/confluence/x.md');
    expect(pages[0]?.page).not.toContain('\\');
  });

  // Enrich (WP5): diagrams (kind 'flow-diagram') and composition tables
  // (kind 'component' + rule_id 'comp/…' + no `before`) are counted
  // separately from the generic agent/user tallies above, per-page and
  // summed into the artifact total. A page with none of those (pre-WP5
  // fixture, no `kind` at all) must still get a zeroed — not undefined —
  // enrich block.
  it('counts enrich metrics (flow-diagram + composition tables) separately from agent/user tallies', () => {
    const result = aggregateDocsReviewMetrics([
      {
        page: 'a.md',
        annotations: {
          schemaVersion: 2,
          events: [],
          annotations: [
            {
              id: 'sys-flow-diagram-f1', origin: 'system', operation: 'edited',
              before: 'old mermaid', quote: 'new mermaid', kind: 'flow-diagram',
              rule_id: 'flows/f1/ux-review.json',
            },
            {
              id: 'comp-1', origin: 'agent', operation: 'add', quote: '| Component | ... |',
              kind: 'component', rule_id: 'comp/screen-a.json',
            },
            {
              id: 'comp-2', origin: 'agent', operation: 'add', quote: '| Component | ... |',
              kind: 'component', rule_id: 'comp/screen-b.json', status: 'dismissed',
            },
          ],
        },
      },
      {
        page: 'b.md',
        annotations: {
          schemaVersion: 2,
          events: [],
          annotations: [
            { id: 'legacy-1', origin: 'agent', operation: 'add', quote: 'old-style text' },
          ],
        },
      },
    ]);
    expect(result.pages[0]?.enrich).toEqual({
      diagrams: { total: 1, accepted: 1, dismissed: 0 },
      compositionTables: { total: 2, accepted: 1, dismissed: 1, editedByUser: 0 },
    });
    expect(result.pages[1]?.enrich).toEqual({
      diagrams: { total: 0, accepted: 0, dismissed: 0 },
      compositionTables: { total: 0, accepted: 0, dismissed: 0, editedByUser: 0 },
    });
    expect(result.enrich).toEqual({
      diagrams: { total: 1, accepted: 1, dismissed: 0 },
      compositionTables: { total: 2, accepted: 1, dismissed: 1, editedByUser: 0 },
    });
  });

  it('does not write a receipt before media-service accepts the artifact, so retry keeps the same path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-doc-review-feedback-'));
    dirs.push(root);
    const review = path.join(root, 'review', 'docs');
    await fs.mkdir(review, { recursive: true });
    await fs.writeFile(path.join(review, 'one.changes.json'), JSON.stringify([{ id: 'a', quote: 'private document text', reason: 'r' }]));
    await writeCompleteCoverage(root);
    const input = {
      projectId: 'p1', workflowRoot: root, installationId: 'install-1', user: 'u', channel: 'dev' as const,
      confirmationId: 'retry-1', now: 123,
    };
    await expect(confirmDocsReview({ ...input, client: { uploadFile: async () => { throw new Error('offline'); } } as never }))
      .rejects.toThrow('offline');
    await expect(fs.access(path.join(root, 'confirmation', 'retry-1.json'))).rejects.toThrow();

    const completed = await confirmDocsReview({ ...input, client: { uploadFile: async () => {} } as never });
    expect(completed.mediaPath).toBe('docs-review-feedback/install-1/retry-1/report.json');
    expect(JSON.stringify(completed.artifact)).not.toContain('private document text');
  });

  it('blocks final confirmation when any flow, mockup, page, or section remains uncovered (WP dr-mockup: comp/ không còn bắt buộc)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-doc-review-coverage-'));
    dirs.push(root);
    await writeCompleteCoverage(root);
    await expect(assertDocsReviewCoverageComplete(root)).resolves.toBeUndefined();

    // dr-comp rời workflow: KHÔNG có comp/ vẫn xác nhận được.
    await fs.rm(path.join(root, 'comp'), { recursive: true, force: true });
    await expect(assertDocsReviewCoverageComplete(root)).resolves.toBeUndefined();

    // Chưa chạy dr-mockup (không có mockups/index.json) → không chặn.
    // Có mockups/index.json → mọi màn của bản đã chọn phải có file .html.
    await fs.mkdir(path.join(root, 'mockups'), { recursive: true });
    await fs.writeFile(path.join(root, 'mockups', 'index.json'), JSON.stringify({ schema_version: 1, screens: [] }));
    await expect(assertDocsReviewCoverageComplete(root)).rejects.toThrow(/dr-mockup thiếu mockup cho màn: SCREEN-1/);
    await fs.writeFile(path.join(root, 'mockups', 'SCREEN-1.html'), '<!doctype html><body data-screen="SCREEN-1"></body>');
    await expect(assertDocsReviewCoverageComplete(root)).resolves.toBeUndefined();
    // Màn bị bản Cải thiện đề nghị bỏ (removedByProposal) không cần mockup.
    await fs.writeFile(path.join(root, 'flows', 'index.json'), JSON.stringify([
      { id: 'flow-1', screens: [{ key: 'SCREEN-1', name: 'Screen 1' }, { key: 'SCREEN-GONE', removedByProposal: true }] },
    ]));
    await expect(assertDocsReviewCoverageComplete(root)).resolves.toBeUndefined();

    await fs.writeFile(path.join(root, 'flows', 'index.json'), JSON.stringify([
      { id: 'flow-ok', screens: [{ key: 'SCREEN-1' }, { key: 'SCREEN-2' }] },
      { id: 'flow-missing', screens: [] },
    ]));
    await fs.writeFile(path.join(root, 'review', 'index.json'), JSON.stringify({
      pages: [{ status: 'succeeded', sections_total: 2, sections_failed: 1 }],
    }));

    await expect(assertDocsReviewCoverageComplete(root)).rejects.toThrow(/flow-missing.*thiếu mockup cho màn: SCREEN-2.*section lỗi/);
  });
});

describe('POST /api/projects/:id/docs-review/confirm', () => {
  it('uses the canonical dr-confirm runner so stage status/history are updated before returning', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-doc-review-feedback-route-'));
    dirs.push(root);
    const db = openDatabase(root, { dataDir: root });
    insertProject(db, {
      id: 'p1', name: 'p1', skillId: null, designSystemId: null, pendingPrompt: null,
      metadata: { kind: 'pipeline' }, createdAt: 1, updatedAt: 1,
    });
    const artifact = {
      schemaVersion: 1, confirmationId: 'confirm-1', projectId: 'p1', workflowId: 'docs-review' as const,
      installationId: 'install-1', user: 'u', channel: 'dev' as const, confirmedAt: 1,
      agent: { add: 0, edited: 0, delete: 0, total: 0, accepted: 0, editedByUser: 0, dismissed: 0 },
      userChanges: { add: 0, edited: 0, delete: 0, total: 0 }, pages: [],
    };
    const result = { ok: true as const, artifact, mediaPath: 'docs-review-feedback/install-1/confirm-1.json', localPath: 'confirmation/confirm-1.json' };
    const runPipeline = vi.fn(async () => ({
      projectId: 'p1',
      completion: Promise.resolve<'succeeded'>('succeeded'),
      docsReviewConfirmation: Promise.resolve(result),
    }));
    const handlers = new Map<string, (req: any, res: any) => unknown>();
    const app = {
      get: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`GET ${route}`, handler),
      post: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`POST ${route}`, handler),
      put: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`PUT ${route}`, handler),
      patch: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`PATCH ${route}`, handler),
      delete: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`DELETE ${route}`, handler),
      use: () => {},
    };
    registerPipelineRoutes(app as any, {
      db,
      pipelines: { runPipeline, localOutputs: async () => [] },
      paths: { PROJECTS_DIR: root, RUNTIME_DATA_DIR: root },
    } as any);
    const out: { status: number; body?: unknown } = { status: 200 };
    const res = {
      status(code: number) { out.status = code; return res; },
      json(body: unknown) { out.body = body; return res; },
    };
    try {
      const handler = handlers.get('POST /api/projects/:id/docs-review/confirm');
      await handler!({ params: { id: 'p1' }, body: { confirmationId: 'confirm-1', sourceRunId: 'run-1' } }, res);
      expect(runPipeline).toHaveBeenCalledWith('p1', 'dr-confirm', {
        docsReviewConfirmationId: 'confirm-1', docsReviewSourceRunId: 'run-1',
      });
      expect(out).toEqual({ status: 201, body: result });
    } finally {
      closeDatabase();
    }
  });
});

// ─── v2 (wp-docs-review-confirm-v2) ─────────────────────────────────────────
async function writeJson(root: string, rel: string, value: unknown): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/** Fixture đủ 5 bước với đúng các file người dùng có thể sửa. */
async function writeFullWorkflow(root: string): Promise<void> {
  // dr-docs: 2 trang md + attachment (KHÔNG vào snapshot) + _manifest.json (có).
  await writeJson(root, 'docs-feature/A/one.md', '# One\nSECRET-DOC-TEXT\n');
  await writeJson(root, 'docs-feature/A/two.md', '# Two\n');
  await writeJson(root, 'docs-feature/A/attachments/pic.png', 'PNG-BYTES');
  await writeJson(root, 'docs-feature/_manifest.json', { schema_version: 1, pages: [] });
  await writeJson(root, 'docs-feature/_index.md', '# index');
  // dr-flow
  await writeJson(root, 'flows/index.json', [
    { id: 'SCREEN-FLOW', title: 'Luồng', source: 'x', kind: 'drawio', screens: [{ key: 'SCREEN-1', name: 'Một' }, { key: 'SCREEN-2', name: 'Hai' }, { key: 'SCREEN-GONE', name: 'Bỏ', removedByProposal: true }] },
  ]);
  await writeJson(root, 'flows/_inputs.json', { flows: [] });
  await writeJson(root, 'flows/_seeds/seed.drawio', '<mxfile/>');
  await writeJson(root, 'flows/SCREEN-FLOW/as-is.drawio', '<mxfile/>');
  await writeJson(root, 'flows/SCREEN-FLOW/cells.json', []);
  await writeJson(root, 'flows/SCREEN-FLOW/screens.json', { screens: [] });
  await writeJson(root, 'flows/SCREEN-FLOW/as-is.edited.json', { at: 't' });
  await writeJson(root, 'screens-overrides.json', { schema_version: 1, overrides: [{ action: 'add', key: 'X' }, { action: 'remove', key: 'Y' }, { action: 'bogus' }] });
  // dr-flow-improve
  await writeJson(root, 'flows/SCREEN-FLOW/patch.json', { ops: [{ op: 'relabel' }, { op: 'addNode' }] });
  await writeJson(root, 'flows/SCREEN-FLOW/ux-review.json', { verdict: 'ok', findings: [{ id: 'F1' }] });
  await writeJson(root, 'flows/SCREEN-FLOW/screens.improved.json', { schema_version: 1, screens: [
    { key: 'SCREEN-1', provenance: 'document' }, { key: 'SCREEN-NEW', provenance: 'proposed' }, { key: 'SCREEN-GONE', provenance: 'document', removedByProposal: true },
  ] });
  await writeJson(root, 'flows/SCREEN-FLOW/selection.json', { variant: 'improved', source: 'user', at: 't' });
  await writeJson(root, 'flows/SCREEN-FLOW/proposed.edited.json', { at: 't' });
  await writeJson(root, 'flows/SCREEN-FLOW/proposed.drawio', '<mxfile/>');
  // dr-mockup
  await writeJson(root, 'mockups/index.json', { schema_version: 1, variant: 'improved', screens: [{ key: 'SCREEN-1' }, { key: 'SCREEN-2' }] });
  await writeJson(root, 'mockups/SCREEN-1.html', '<html>1</html>');
  await writeJson(root, 'mockups/SCREEN-2.html', '<html>2</html>');
  await writeJson(root, 'mockups/_assets/_mockup.css', 'body{}');
  // dr-review
  await writeJson(root, 'review/index.json', { pages: [{ page: 'One', doc_path: 'docs-feature/A/one.md', review_path: 'review/docs-feature/A/one.md', status: 'succeeded', sections_total: 1, sections_failed: 0 }] });
  await writeJson(root, 'review/docs-feature/A/one.md', '# One (reviewed)\n');
  await writeJson(root, 'review/docs-feature/A/one.changes.json', {
    schemaVersion: 2,
    annotations: [
      { id: 'a1', origin: 'agent', operation: 'add', quote: 'private document text' },
      { id: 'a2', origin: 'agent', operation: 'edited', before: 'old', quote: 'newer', status: 'edited', comments: [{ id: 'c1', text: 'Sửa lại cho đúng thuật ngữ', at: 5, by: 'u' }] },
      { id: 'a3', origin: 'agent', operation: 'delete', before: 'gone', status: 'dismissed' },
    ],
    events: [],
  });
  await writeJson(root, 'review/docs-feature/A/one.notes.json', [
    { id: 'n1', kind: 'content', severity: 'minor', anchor: 'x', finding: 'f', suggestion: 's', status: 'dismissed' },
    { id: 'n2', kind: 'content', severity: 'minor', anchor: 'y', finding: 'f', suggestion: 's', origin: 'user', comments: [{ id: 'c2', text: 'Ghi chú của tôi', at: 6 }] },
  ]);
  await writeJson(root, 'review/_debug.json', { internal: true });
  // Daemon-owned, ngoài outputs.
  await writeJson(root, '.odhistory/x.json', {});
  await writeJson(root, 'confirmation/old.json', { schemaVersion: 2 });
}

describe('docs-review confirm v2 (report.json + output snapshot)', () => {
  it('builds stages from the registry with per-stage outputs, metrics, comments and the spec summary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-dr-confirm-v2-'));
    dirs.push(root);
    await writeFullWorkflow(root);
    await addDocsReviewStageComment(root, 'dr-mockup', { text: 'Màn 2 thiếu nút quay lại', by: 'u', now: 7, target: { kind: 'screen', key: 'SCREEN-2' } });

    const { artifact, v1, files } = await buildDocsReviewReport({
      projectId: 'p1', workflowRoot: root, installationId: 'install-1', user: 'u', channel: 'dev',
      confirmationId: 'confirm-1', confirmedAt: 123,
      feature: { id: 'p1', name: 'Tính năng A' }, app: { id: 'app-1', name: 'App 1' }, screenPlatform: 'mobile',
      runIds: { 'dr-docs': 'run-docs', 'dr-review': 'run-review' },
    });
    expect(artifact.schemaVersion).toBe(2);
    expect(artifact.app).toEqual({ id: 'app-1', name: 'App 1' });
    expect(artifact.feature).toEqual({ id: 'p1', name: 'Tính năng A' });
    expect(artifact.screenPlatform).toBe('mobile');
    expect(artifact.stages.map((s) => s.stageId)).toEqual(['dr-docs', 'dr-flow', 'dr-flow-improve', 'dr-mockup', 'dr-review']);
    expect(artifact.stages.map((s) => s.name)).toEqual(['Tài liệu (nạp)', 'Luồng màn hình', 'Cải thiện luồng', 'Mockup màn', 'Review tài liệu']);
    expect(artifact.stages.every((s) => s.status === 'succeeded')).toBe(true);
    const byId = Object.fromEntries(artifact.stages.map((s) => [s.stageId, s]));

    // outputs: đúng file thật, bỏ _* / .* / attachments / comments / confirmation.
    expect(byId['dr-docs']!.outputs.map((o) => o.path)).toEqual(['docs-feature/A/one.md', 'docs-feature/A/two.md', 'docs-feature/_manifest.json']);
    expect(byId['dr-docs']!.runId).toBe('run-docs');
    expect(byId['dr-flow']!.runId).toBeUndefined();
    expect(byId['dr-flow']!.outputs.map((o) => o.path)).toEqual([
      'flows/SCREEN-FLOW/as-is.drawio', 'flows/SCREEN-FLOW/as-is.edited.json', 'flows/SCREEN-FLOW/cells.json', 'flows/SCREEN-FLOW/screens.json', 'flows/SCREEN-FLOW/selection.json', 'flows/index.json',
    ]);
    expect(byId['dr-flow-improve']!.outputs.map((o) => o.path)).toEqual([
      'flows/SCREEN-FLOW/patch.json', 'flows/SCREEN-FLOW/proposed.drawio', 'flows/SCREEN-FLOW/proposed.edited.json', 'flows/SCREEN-FLOW/screens.improved.json', 'flows/SCREEN-FLOW/ux-review.json',
    ]);
    expect(byId['dr-mockup']!.outputs.map((o) => o.path)).toEqual(['mockups/SCREEN-1.html', 'mockups/SCREEN-2.html', 'mockups/index.json']);
    expect(byId['dr-review']!.outputs.map((o) => o.path)).toEqual([
      'review/docs-feature/A/one.changes.json', 'review/docs-feature/A/one.md', 'review/docs-feature/A/one.notes.json', 'review/index.json',
    ]);
    const allPaths = artifact.stages.flatMap((s) => s.outputs.map((o) => o.path));
    expect(allPaths.some((p) => p.includes('attachments') || p.includes('_inputs') || p.includes('_seeds') || p.includes('_assets') || p.startsWith('comments/') || p.startsWith('confirmation/') || p.startsWith('.odhistory'))).toBe(false);
    expect(byId['dr-docs']!.outputs[0]).toEqual({ path: 'docs-feature/A/one.md', size: expect.any(Number), mediaPath: 'docs-review-feedback/install-1/confirm-1/outputs/docs-feature/A/one.md' });
    expect([...files.map((f) => f.path)].sort()).toEqual([...allPaths].sort());

    // metrics
    expect(byId['dr-docs']!.metrics).toEqual({ kind: 'dr-docs', pages: 2 });
    expect(byId['dr-flow']!.metrics).toEqual({ kind: 'dr-flow', flows: 1, screens: 2, platform: 'mobile', drawioEdited: true, overrides: { add: 1, rename: 0, remove: 1 } });
    expect(byId['dr-flow-improve']!.metrics).toEqual({ kind: 'dr-flow-improve', flows: [
      { flowId: 'SCREEN-FLOW', variant: 'improved', source: 'user', patchOps: 2, findings: 1, proposedScreens: 1, removedScreens: 1, proposedEdited: true },
    ] });
    expect(byId['dr-mockup']!.metrics).toEqual({ kind: 'dr-mockup', screens: 2, variant: 'improved' });
    const review = byId['dr-review']!.metrics;
    expect(review.kind).toBe('dr-review');
    if (review.kind !== 'dr-review') throw new Error('unreachable');
    expect(review.agent).toEqual({ add: 1, edited: 1, delete: 1, total: 3, accepted: 1, editedByUser: 1, dismissed: 1 });
    expect(review.userChanges).toEqual({ add: 0, edited: 1, delete: 0, total: 1 });
    expect(review.notes).toEqual({ total: 2, dismissed: 1, user: 1 });
    expect(review.annotationComments).toBe(2);
    expect(review.enrich).toEqual({ diagrams: { total: 0, accepted: 0, dismissed: 0 } });
    expect(review.pages.map((p) => p.page)).toEqual(['docs-feature/A/one.md']);

    // comments của bước
    expect(byId['dr-mockup']!.comments).toEqual([expect.objectContaining({ stageId: 'dr-mockup', text: 'Màn 2 thiếu nút quay lại', by: 'u', at: 7 })]);
    expect(byId['dr-docs']!.comments).toEqual([]);

    // summary theo spec: proposals 3+2+1; edited 1+1; dismissed 1+0+1; accepted = 6-2-2.
    expect(artifact.summary).toEqual({
      agentProposals: 6,
      humanEdits: 1 + 1 + 1 + 1 + 2 + 1,
      comments: 3,
      aiOutcome: { proposals: 6, accepted: 2, edited: 2, dismissed: 2 },
    });
    // v1 compat mirror
    expect(artifact.agent).toEqual(review.agent);
    expect(artifact.userChanges).toEqual(review.userChanges);
    expect(v1).toMatchObject({ schemaVersion: 1, confirmationId: 'confirm-1', agent: review.agent, userChanges: review.userChanges });
    expect(v1.enrich?.compositionTables).toEqual({ total: 0, accepted: 0, dismissed: 0, editedByUser: 0 });

    // report.json = metadata + comment text — KHÔNG chứa nội dung tài liệu.
    const json = JSON.stringify(artifact);
    expect(json).toContain('Màn 2 thiếu nút quay lại');
    expect(json).not.toContain('SECRET-DOC-TEXT');
    expect(json).not.toContain('private document text');
    expect(json).not.toContain('reviewed');
  });

  it('aiOutcome: chọn Nguyên bản bằng tay = bỏ cả gói patch; selection thiếu → default/original không tính bỏ', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-dr-confirm-v2-'));
    dirs.push(root);
    await writeFullWorkflow(root);
    const base = { projectId: 'p1', workflowRoot: root, installationId: 'i', user: 'u', channel: 'dev' as const, confirmationId: 'c', confirmedAt: 1, feature: { id: 'p1', name: 'p1' } };
    await writeJson(root, 'flows/SCREEN-FLOW/selection.json', { variant: 'original', source: 'user', at: 't' });
    let { artifact } = await buildDocsReviewReport(base);
    expect(artifact.summary.aiOutcome).toEqual({ proposals: 6, accepted: 0, edited: 2, dismissed: 1 + 2 + 1 });

    await fs.rm(path.join(root, 'flows/SCREEN-FLOW/selection.json'));
    ({ artifact } = await buildDocsReviewReport(base));
    const improve = artifact.stages.find((s) => s.stageId === 'dr-flow-improve')!.metrics;
    expect(improve.kind === 'dr-flow-improve' && improve.flows[0]).toMatchObject({ variant: 'original', source: 'default' });
    expect(artifact.summary.aiOutcome.dismissed).toBe(2);
    // screenPlatform thiếu → null (không đoán).
    expect(artifact.screenPlatform).toBeNull();
    expect(artifact.app).toBeNull();
  });

  it('confirmDocsReview uploads outputs (4-parallel) + report.json + v1, skips files over the size cap, writes the v2 receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-dr-confirm-v2-'));
    dirs.push(root);
    await writeFullWorkflow(root);
    await writeJson(root, 'mockups/SCREEN-BIG.html', 'x'.repeat(2048));
    const uploads: Array<{ stage: string; filePath: string; mime: string; body: Buffer }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const client = {
      uploadFile: async (_project: string, stage: string, filePath: string, mime: string, body: Buffer) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        uploads.push({ stage, filePath, mime, body });
        inFlight -= 1;
      },
    };
    const result = await confirmDocsReview({
      projectId: 'p1', workflowRoot: root, installationId: 'install/1', user: 'u', channel: 'dev',
      confirmationId: 'confirm-1', now: 123, client: client as never, maxOutputBytes: 1024,
      feature: { id: 'p1', name: 'F' }, app: { id: 'a', name: 'A' }, screenPlatform: 'web',
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(result.mediaPath).toBe('docs-review-feedback/install-1/confirm-1/report.json');
    expect(result.studioUrl).toBeUndefined();
    const paths = uploads.map((u) => u.filePath);
    expect(paths).toContain('docs-review-feedback/install-1/confirm-1.json');
    expect(paths).toContain('docs-review-feedback/install-1/confirm-1/outputs/mockups/SCREEN-1.html');
    expect(paths).not.toContain('docs-review-feedback/install-1/confirm-1/outputs/mockups/SCREEN-BIG.html');
    expect(paths.filter((p) => p.includes('attachments'))).toEqual([]);
    const mockupStage = result.artifact.stages.find((s) => s.stageId === 'dr-mockup')!;
    expect(mockupStage.skipped).toEqual([{ path: 'mockups/SCREEN-BIG.html', reason: expect.stringContaining('quá') }]);
    expect(mockupStage.outputs.map((o) => o.path)).not.toContain('mockups/SCREEN-BIG.html');
    expect(uploads.find((u) => u.filePath.endsWith('SCREEN-1.html'))!.mime).toBe('text/html');
    expect(uploads.find((u) => u.filePath.endsWith('one.md'))!.mime).toBe('text/markdown');
    // v1 y như cũ (stage v1), report v2 ở stage của lần xác nhận.
    const v1 = uploads.find((u) => u.filePath === 'docs-review-feedback/install-1/confirm-1.json')!;
    expect(v1.stage).toBe('docs-review-feedback/install-1');
    expect(JSON.parse(v1.body.toString())).toMatchObject({ schemaVersion: 1, confirmationId: 'confirm-1', installationId: 'install-1' });
    const report = uploads.find((u) => u.filePath === result.mediaPath)!;
    expect(report.stage).toBe('docs-review-feedback/install-1/confirm-1');
    expect(JSON.parse(report.body.toString())).toEqual(result.artifact);
    // Receipt local = report v2.
    expect(result.localPath).toBe('confirmation/confirm-1.json');
    expect(JSON.parse(await readFile(path.join(root, result.localPath), 'utf8'))).toEqual(result.artifact);
    expect(result.artifact.stages.map((s) => s.outputs.length).reduce((a, b) => a + b, 0)).toBe(uploads.length - 2);
  });

  it('confirmationId digest changes when a stage comment, selection or override changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-dr-confirm-v2-'));
    dirs.push(root);
    await writeFullWorkflow(root);
    const d0 = await computeDocsReviewConfirmationDigest(root);
    expect(await computeDocsReviewConfirmationDigest(root)).toBe(d0);
    await addDocsReviewStageComment(root, 'dr-docs', { text: 'x', by: 'u', now: 1, id: 'fixed' });
    const d1 = await computeDocsReviewConfirmationDigest(root);
    expect(d1).not.toBe(d0);
    await writeJson(root, 'flows/SCREEN-FLOW/selection.json', { variant: 'original', source: 'user', at: 't' });
    const d2 = await computeDocsReviewConfirmationDigest(root);
    expect(d2).not.toBe(d1);
    await writeJson(root, 'screens-overrides.json', { schema_version: 1, overrides: [] });
    expect(await computeDocsReviewConfirmationDigest(root)).not.toBe(d2);
    // Sửa file KHÔNG thuộc digest (mockup html) → giữ nguyên id.
    const d3 = await computeDocsReviewConfirmationDigest(root);
    await writeJson(root, 'mockups/SCREEN-1.html', '<html>changed</html>');
    expect(await computeDocsReviewConfirmationDigest(root)).toBe(d3);
  });

  it('docsReviewConfirmContextOf: app/feature/platform from project metadata, runIds from pipeline state (registry ids only)', () => {
    const ctx = docsReviewConfirmContextOf(
      { id: 'p1', name: 'Tính năng', metadata: { studioConfig: { appId: 'app-1', appName: 'App' }, runAllConfig: { screenPlatform: 'both' } } },
      { 'dr-docs': { lastRunId: 'r1' }, 'dr-review': { lastRunId: 'r5' }, 'dr-comp': { lastRunId: 'hidden' }, 'dr-flow': {} },
    );
    expect(ctx).toEqual({ feature: { id: 'p1', name: 'Tính năng' }, app: { id: 'app-1', name: 'App' }, screenPlatform: 'both', runIds: { 'dr-docs': 'r1', 'dr-review': 'r5' } });
    expect(docsReviewConfirmContextOf({ id: 'p2', name: 'x', metadata: { studioConfig: { appId: 'a' } } }, null))
      .toEqual({ feature: { id: 'p2', name: 'x' }, app: { id: 'a', name: 'a' }, screenPlatform: null, runIds: {} });
    expect(docsReviewConfirmContextOf(null, null).app).toBeNull();
  });

  it('countNotesFile tolerates junk and counts dismissed/user/comments', () => {
    expect(countNotesFile('{broken')).toEqual({ notes: { total: 0, dismissed: 0, user: 0 }, comments: 0 });
    expect(countNotesFile(JSON.stringify([
      { id: 'a', status: 'dismissed', comments: [{ id: 'c', text: 't', at: 1 }, { id: 'bad', text: '', at: 1 }] },
      { id: 'b', origin: 'user' }, null, 'junk',
    ]))).toEqual({ notes: { total: 2, dismissed: 1, user: 1 }, comments: 1 });
  });
});

// ─── Thu hồi xác nhận (wp-docs-review-confirm-revoke) ───────────────────────
describe('docs-review revoke confirmation', () => {
  async function writeReceipt(root: string, id: string, confirmedAt: number, installationId = 'inst-a'): Promise<void> {
    await writeJson(root, `confirmation/${id}.json`, { schemaVersion: 2, confirmationId: id, installationId, confirmedAt });
  }

  function recordingClient() {
    const uploads: Array<{ stage: string; filePath: string; body: string }> = [];
    return {
      uploads,
      client: {
        uploadFile: async (_project: string, stage: string, filePath: string, _mime: string, body: Buffer) => {
          uploads.push({ stage, filePath, body: body.toString() });
        },
      } as never,
    };
  }

  it('revokes the LATEST local confirmation: 2 media markers first, then the local marker; second revoke → 409', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-dr-revoke-'));
    dirs.push(root);
    await writeReceipt(root, 'c1', 100);
    await writeReceipt(root, 'c2', 200);
    const { uploads, client } = recordingClient();
    const input = { projectId: 'p1', workflowRoot: root, installationId: 'fallback-install', user: 'u@vnpay.vn', reason: 'bổ sung bình luận', now: 999, client };
    const result = await revokeDocsReviewConfirmation(input);
    expect(result).toEqual({ ok: true, confirmationId: 'c2', revokedAt: 999 });
    // v2 (cạnh report.json) rồi v1 (cạnh <confirmId>.json), install lấy từ receipt.
    expect(uploads.map((u) => [u.filePath, u.stage])).toEqual([
      ['docs-review-feedback/inst-a/c2/revoked.json', 'docs-review-feedback/inst-a/c2'],
      ['docs-review-feedback/inst-a/c2.revoked.json', 'docs-review-feedback/inst-a'],
    ]);
    const marker = JSON.parse(await readFile(path.join(root, 'confirmation', 'c2.revoked.json'), 'utf8'));
    expect(marker).toEqual({ schemaVersion: 1, confirmationId: 'c2', projectId: 'p1', revokedAt: 999, user: 'u@vnpay.vn', reason: 'bổ sung bình luận' });
    expect(JSON.parse(uploads[0]!.body)).toEqual(marker);
    // Thu hồi lần 2 (bản mới nhất đã revoked) → 409.
    await expect(revokeDocsReviewConfirmation(input)).rejects.toMatchObject({ status: 409 });
    await expect(revokeDocsReviewConfirmation(input)).rejects.toBeInstanceOf(DocsReviewRevokeError);
    // Bản cũ hơn vẫn thu hồi được khi trỏ đích danh.
    await expect(revokeDocsReviewConfirmation({ ...input, confirmationId: 'c1' })).resolves.toMatchObject({ ok: true, confirmationId: 'c1' });
  });

  it('404 when there is nothing to revoke or the id is unknown; upload failure leaves NO local marker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-dr-revoke-'));
    dirs.push(root);
    const { client } = recordingClient();
    const base = { projectId: 'p1', workflowRoot: root, installationId: 'inst-a', user: 'u', client };
    await expect(revokeDocsReviewConfirmation(base)).rejects.toMatchObject({ status: 404, message: 'Chưa có bản xác nhận nào để thu hồi' });
    await writeReceipt(root, 'c1', 100);
    await expect(revokeDocsReviewConfirmation({ ...base, confirmationId: 'nope' })).rejects.toMatchObject({ status: 404 });
    // Media là nguồn sự thật: upload lỗi → 502 (route), KHÔNG ghi local marker.
    const offline = { uploadFile: async () => { throw new Error('offline'); } } as never;
    await expect(revokeDocsReviewConfirmation({ ...base, client: offline })).rejects.toThrow('offline');
    await expect(fs.access(path.join(root, 'confirmation', 'c1.revoked.json'))).rejects.toThrow();
    // Marker `.revoked.json` KHÔNG được đếm là một bản xác nhận.
    await writeJson(root, 'confirmation/ghost.revoked.json', { schemaVersion: 1, confirmationId: 'ghost', revokedAt: 1, user: 'u' });
    await expect(revokeDocsReviewConfirmation({ ...base, confirmationId: 'ghost' })).rejects.toMatchObject({ status: 404 });
  });

  it('confirm again with the same id removes the revoke markers (media deleteByPath + local rm)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-dr-revoke-reconfirm-'));
    dirs.push(root);
    await writeFullWorkflow(root);
    await writeJson(root, 'confirmation/confirm-1.revoked.json', { schemaVersion: 1, confirmationId: 'confirm-1', projectId: 'p1', revokedAt: 5, user: 'u' });
    const deletes: string[] = [];
    const client = {
      uploadFile: async () => { throw new Error('phải đi qua session'); },
      openFolderSession: async () => ({
        upload: async () => {},
        deleteByPath: async (filePath: string) => { deletes.push(filePath); return 1; },
      }),
    } as never;
    await confirmDocsReview({
      projectId: 'p1', workflowRoot: root, installationId: 'install-1', user: 'u', channel: 'dev',
      confirmationId: 'confirm-1', now: 123, client,
    });
    expect(deletes).toEqual([
      'docs-review-feedback/install-1/confirm-1/revoked.json',
      'docs-review-feedback/install-1/confirm-1.revoked.json',
    ]);
    await expect(fs.access(path.join(root, 'confirmation', 'confirm-1.revoked.json'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'confirmation', 'confirm-1.json'))).resolves.toBeUndefined();
    // Trạng thái sống lại sạch sẽ: latest không còn revoked.
    const state = await readDocsReviewConfirmationState(root);
    expect(state.latest).toMatchObject({ confirmationId: 'confirm-1', confirmedAt: 123 });
    expect(state.latest?.revoked).toBeUndefined();
  });

  it('GET state: null / latest / latest+revoked; broken receipt and broken marker are tolerated', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-dr-state-'));
    dirs.push(root);
    expect(await readDocsReviewConfirmationState(root)).toEqual({ latest: null });
    await writeReceipt(root, 'c1', 100);
    await writeReceipt(root, 'c2', 200);
    expect(await readDocsReviewConfirmationState(root)).toEqual({ latest: { confirmationId: 'c2', confirmedAt: 200 } });
    // Marker hỏng → coi như KHÔNG revoked (không ghim trạng thái vì file rác).
    await writeJson(root, 'confirmation/c2.revoked.json', '{broken');
    expect((await readDocsReviewConfirmationState(root)).latest?.revoked).toBeUndefined();
    await writeJson(root, 'confirmation/c2.revoked.json', { schemaVersion: 1, confirmationId: 'c2', projectId: 'p1', revokedAt: 999, user: 'u', reason: 'r' });
    expect(await readDocsReviewConfirmationState(root)).toEqual({
      latest: { confirmationId: 'c2', confirmedAt: 200, revoked: { revokedAt: 999, user: 'u', reason: 'r' } },
    });
    // Receipt hỏng vẫn là MỘT bản (id từ tên file, confirmedAt 0) — không chết.
    await writeJson(root, 'confirmation/c3.json', '{broken');
    expect((await readDocsReviewConfirmationState(root)).latest?.confirmationId).toBe('c2');
  });
});
