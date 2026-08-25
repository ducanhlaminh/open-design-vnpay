import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { aggregateDocsReviewMetrics, assertDocsReviewCoverageComplete, confirmDocsReview, readDocsReviewMetricsPages } from '../src/docs-review-feedback.js';
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
    expect(result.mediaPath).toBe('docs-review-feedback/install-1/confirm-1.json');
    expect(uploads[0]?.filePath).toBe(result.mediaPath);
    const artifact = JSON.parse(await readFile(path.join(root, result.localPath), 'utf8'));
    expect(artifact.confirmationId).toBe('confirm-1');
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
    expect(completed.mediaPath).toBe('docs-review-feedback/install-1/retry-1.json');
    expect(JSON.stringify(completed.artifact)).not.toContain('private document text');
  });

  it('blocks final confirmation when any flow, screen, page, or section remains uncovered', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-doc-review-coverage-'));
    dirs.push(root);
    await writeCompleteCoverage(root);
    await expect(assertDocsReviewCoverageComplete(root)).resolves.toBeUndefined();

    await fs.writeFile(path.join(root, 'flows', 'index.json'), JSON.stringify([
      { id: 'flow-ok', screens: [{ key: 'SCREEN-1' }] },
      { id: 'flow-missing', screens: [] },
    ]));
    await fs.writeFile(path.join(root, 'comp', 'index.json'), JSON.stringify({
      screens: [],
      failed: [{ key: 'SCREEN-1', errors: ['bad schema'] }],
    }));
    await fs.writeFile(path.join(root, 'review', 'index.json'), JSON.stringify({
      pages: [{ status: 'succeeded', sections_total: 2, sections_failed: 1 }],
    }));

    await expect(assertDocsReviewCoverageComplete(root)).rejects.toThrow(/flow-missing.*màn hình lỗi.*section lỗi/);
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
