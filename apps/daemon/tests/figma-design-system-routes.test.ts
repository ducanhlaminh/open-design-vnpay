import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, getFigmaDesignSystemSource, openDatabase, setFigmaDesignSystemSourceRefreshState } from '../src/db.js';
import { writeFigmaConfig } from '../src/figma-config.js';
import { FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION } from '../src/figma-component-catalog.js';
import { registerFigmaDesignSystemRoutes } from '../src/figma-design-system-routes.js';

type Handler = (req: any, res: any) => unknown;
function response() {
  const output: { status: number; body?: any } = { status: 200 };
  const res = {
    status(code: number) { output.status = code; return res; },
    json(body: unknown) { output.body = body; return res; },
    send(body?: unknown) { output.body = body; return res; },
  };
  return { output, res };
}

describe('reusable Figma design-system routes', () => {
  const roots: string[] = [];
  afterEach(async () => {
    closeDatabase();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setup(buildCatalog = vi.fn(async () => ({
    schemaVersion: FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION,
    generatedAt: '2026-08-17T00:00:00.000Z',
    files: [{ fileKey: 'ABC', name: 'Core UI', url: 'https://www.figma.com/design/ABC', components: [{ nodeId: '1:2', name: 'Button', properties: [] }] }],
  }))) {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-ds-'));
    roots.push(root);
    const db = openDatabase(root, { dataDir: root });
    const handlers = new Map<string, Handler>();
    const app = {
      get(route: string, handler: Handler) { handlers.set(`GET ${route}`, handler); },
      post(route: string, handler: Handler) { handlers.set(`POST ${route}`, handler); },
      patch(route: string, handler: Handler) { handlers.set(`PATCH ${route}`, handler); },
      delete(route: string, handler: Handler) { handlers.set(`DELETE ${route}`, handler); },
    };
    registerFigmaDesignSystemRoutes(app as never, {
      db,
      http: { isLocalSameOrigin: () => true, resolvedPortRef: { current: 7456 } },
      paths: { RUNTIME_DATA_DIR: root },
      buildCatalog: buildCatalog as never,
      now: () => Date.parse('2026-08-17T00:00:00.000Z'),
    } as never);
    return { root, db, handlers, buildCatalog };
  }

  it('creates canonical sources without exposing or storing a PAT in the source row', async () => {
    const { db, handlers } = await setup();
    const out = response();
    await handlers.get('POST /api/figma-design-systems')!({ body: { name: 'VNPAY UI', links: ['https://figma.com/file/ABC/Foo?node-id=1%3A2'] } }, out.res);
    expect(out.output.status).toBe(201);
    expect(out.output.body.source).toMatchObject({
      name: 'VNPAY UI', kind: 'figma-links', links: ['https://www.figma.com/design/ABC?node-id=1-2'],
      status: 'empty', catalog: null, hasShowcase: false, hasReactBundle: false,
    });
    expect(JSON.stringify(getFigmaDesignSystemSource(db, out.output.body.source.id))).not.toContain('token');
  });

  it('refreshes atomically and preserves the previous catalogue on a later failure', async () => {
    const build = vi.fn()
      .mockResolvedValueOnce({ schemaVersion: FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION, generatedAt: '2026-08-17T00:00:00.000Z', files: [{ fileKey: 'ABC', name: 'Core UI', url: 'https://www.figma.com/design/ABC', components: [{ nodeId: '1:2', name: 'Button', properties: [] }] }] })
      .mockRejectedValueOnce(new Error('network down'));
    const { root, db, handlers } = await setup(build);
    await writeFigmaConfig(root, { token: 'machine-local-secret' });
    const created = response();
    await handlers.get('POST /api/figma-design-systems')!({ body: { name: 'Kit', links: ['https://figma.com/design/ABC'] } }, created.res);
    const id = created.output.body.source.id;
    const ok = response();
    await handlers.get('POST /api/figma-design-systems/:id/refresh')!({ params: { id } }, ok.res);
    expect(ok.output.body.source).toMatchObject({ status: 'ready', catalog: { fileCount: 1, componentCount: 1 } });
    expect(ok.output.body.source).not.toHaveProperty('token');
    const digest = ok.output.body.source.catalog.digest;

    const failed = response();
    await handlers.get('POST /api/figma-design-systems/:id/refresh')!({ params: { id } }, failed.res);
    expect(failed.output.status).toBe(502);
    expect(failed.output.body.source).toMatchObject({ status: 'error', catalog: { digest, componentCount: 1 } });
    expect((getFigmaDesignSystemSource(db, id)!.catalog as any).files[0].components[0].name).toBe('Button');
  });

  it('reports component additions, removals, and metadata changes after rerunning an update', async () => {
    const build = vi.fn()
      .mockResolvedValueOnce({
        schemaVersion: FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION,
        generatedAt: '2026-08-17T00:00:00.000Z',
        files: [{
          fileKey: 'ABC',
          name: 'Core UI',
          url: 'https://www.figma.com/design/ABC',
          components: [
            { nodeId: '1:1', name: 'Button', properties: [] },
            { nodeId: '1:2', name: 'Legacy card', properties: [] },
            { nodeId: '1:3', name: 'Input', properties: [] },
          ],
        }],
      })
      .mockResolvedValueOnce({
        schemaVersion: FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION,
        generatedAt: '2026-08-17T01:00:00.000Z',
        files: [{
          fileKey: 'ABC',
          name: 'Core UI',
          url: 'https://www.figma.com/design/ABC',
          components: [
            { nodeId: '1:1', name: 'Primary button', properties: [] },
            { nodeId: '1:3', name: 'Input', properties: [] },
            { nodeId: '1:4', name: 'Banner', properties: [] },
          ],
        }],
      });
    const { root, handlers } = await setup(build);
    await writeFigmaConfig(root, { token: 'machine-local-secret' });
    const created = response();
    await handlers.get('POST /api/figma-design-systems')!({ body: { name: 'Kit', links: ['https://figma.com/design/ABC'] } }, created.res);
    const id = created.output.body.source.id;

    const first = response();
    await handlers.get('POST /api/figma-design-systems/:id/refresh')!({ params: { id } }, first.res);
    expect(first.output.body.changes).toEqual({
      previousComponentCount: 0,
      currentComponentCount: 3,
      addedComponents: 3,
      removedComponents: 0,
      changedComponents: 0,
      unchangedComponents: 0,
    });

    const rerun = response();
    await handlers.get('POST /api/figma-design-systems/:id/refresh')!({ params: { id } }, rerun.res);
    expect(rerun.output.body.changes).toEqual({
      previousComponentCount: 3,
      currentComponentCount: 3,
      addedComponents: 1,
      removedComponents: 1,
      changedComponents: 1,
      unchangedComponents: 1,
    });
    expect(rerun.output.body.source).toMatchObject({
      status: 'ready',
      catalog: { componentCount: 3 },
    });
  });

  it('validates 1–5 unique Figma files and supports update/list/delete', async () => {
    const { handlers } = await setup();
    const invalid = response();
    await handlers.get('POST /api/figma-design-systems')!({ body: { name: 'Bad', links: [] } }, invalid.res);
    expect(invalid.output.status).toBe(400);
    const created = response();
    await handlers.get('POST /api/figma-design-systems')!({ body: { name: 'Kit', links: ['https://figma.com/design/ABC'] } }, created.res);
    const id = created.output.body.source.id;
    const changed = response();
    await handlers.get('PATCH /api/figma-design-systems/:id')!({ params: { id }, body: { name: 'Kit 2', links: ['https://figma.com/file/XYZ'] } }, changed.res);
    expect(changed.output.body.source).toMatchObject({ name: 'Kit 2', links: ['https://www.figma.com/design/XYZ'], status: 'empty' });
    const listed = response();
    await handlers.get('GET /api/figma-design-systems')!({}, listed.res);
    expect(listed.output.body.sources).toHaveLength(1);
    const deleted = response();
    await handlers.get('DELETE /api/figma-design-systems/:id')!({ params: { id } }, deleted.res);
    expect(deleted.output.status).toBe(204);
  });

  it('recovers an interrupted refresh after the daemon restarts', async () => {
    const { db, handlers } = await setup();
    const created = response();
    await handlers.get('POST /api/figma-design-systems')!({ body: { name: 'Kit', links: ['https://figma.com/design/ABC'] } }, created.res);
    const id = created.output.body.source.id;
    setFigmaDesignSystemSourceRefreshState(db, id, { status: 'refreshing', updatedAt: Date.parse('2026-08-17T00:00:00.000Z') });

    const restartedApp = { get() {}, post() {}, patch() {}, delete() {} };
    registerFigmaDesignSystemRoutes(restartedApp as never, {
      db,
      http: { isLocalSameOrigin: () => true, resolvedPortRef: { current: 7456 } },
      paths: { RUNTIME_DATA_DIR: '' },
      now: () => Date.parse('2026-08-17T00:01:00.000Z'),
    } as never);

    expect(getFigmaDesignSystemSource(db, id)).toMatchObject({
      status: 'error',
      lastError: 'Lần cập nhật trước bị gián đoạn. Hãy bấm Làm mới để thử lại.',
    });
  });
});
