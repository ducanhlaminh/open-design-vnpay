import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeFigmaConfig } from '../src/figma-config.js';
import { readAppFigmaCatalog, registerFigmaCatalogRoutes, writeAppFigmaCatalog } from '../src/figma-catalog-routes.js';
import {
  FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION,
  renderFigmaComponentsMarkdown,
  type FigmaComponentCatalogSnapshot,
} from '../src/figma-component-catalog.js';

vi.mock('../src/db.js', () => ({
  getPipelineApp: (_db: unknown, id: string) => (id === 'retail'
    ? { id, docsReviewComponentSource: { mode: 'figma-links', links: [{ url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }] } }
    : id === 'plain' ? { id, docsReviewComponentSource: { mode: 'app-design-system' } } : null),
}));

type Handler = (req: any, res: any) => unknown;
function response() {
  const output: { status: number; body?: unknown } = { status: 200 };
  const res = { status(code: number) { output.status = code; return res; }, json(body: unknown) { output.body = body; return res; } };
  return { output, res };
}
function register(dataDir: string) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(route: string, handler: Handler) { handlers.set(`GET ${route}`, handler); },
    post(route: string, handler: Handler) { handlers.set(`POST ${route}`, handler); },
  };
  registerFigmaCatalogRoutes(app as never, {
    db: {},
    http: { isLocalSameOrigin: () => true, resolvedPortRef: { current: 7456 } },
    paths: { RUNTIME_DATA_DIR: dataDir, PROJECTS_DIR: path.join(dataDir, 'projects') },
  } as never);
  return handlers;
}

const publishedSets = { meta: { component_sets: [{ node_id: '10:1', name: 'Button', containing_frame: { pageName: 'Actions' } }] } };
const nodes = { nodes: { '10:1': { document: { componentPropertyDefinitions: { State: { type: 'VARIANT', variantOptions: ['Default', 'Disabled'] } } } } } };

describe('app figma-catalog routes', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('GET before any read: links + hasToken, no snapshot; non-figma app → links null; unknown app → 404', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-catalog-'));
    roots.push(root);
    const handlers = register(root);
    const a = response();
    await handlers.get('GET /api/pipelines/apps/:appId/figma-catalog')!({ params: { appId: 'retail' } }, a.res);
    expect(a.output.body).toEqual({ links: [{ url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }], hasToken: false, generatedAt: null, files: [], componentCount: 0, markdown: null });
    const b = response();
    await handlers.get('GET /api/pipelines/apps/:appId/figma-catalog')!({ params: { appId: 'plain' } }, b.res);
    expect(b.output.body).toMatchObject({ links: null });
    const c = response();
    await handlers.get('GET /api/pipelines/apps/:appId/figma-catalog')!({ params: { appId: 'nope' } }, c.res);
    expect(c.output.status).toBe(404);
  });

  it('refresh: no token → 400; with token builds via Figma, writes json+md under projects/<app>/figma-catalog and GET returns it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-catalog-'));
    roots.push(root);
    const handlers = register(root);
    const denied = response();
    await handlers.get('POST /api/pipelines/apps/:appId/figma-catalog/refresh')!({ params: { appId: 'retail' } }, denied.res);
    expect(denied.output.status).toBe(400);
    expect(String((denied.output.body as any).error)).toMatch(/token/i);

    await writeFigmaConfig(root, { token: 'tok' });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/files/ABC') return new Response(JSON.stringify({ name: 'Kit', document: { children: [] } }), { status: 200 });
      if (url.pathname === '/v1/files/ABC/component_sets') return new Response(JSON.stringify(publishedSets), { status: 200 });
      if (url.pathname === '/v1/files/ABC/components') return new Response(JSON.stringify({ meta: { components: [] } }), { status: 200 });
      if (url.pathname === '/v1/files/ABC/nodes') return new Response(JSON.stringify(nodes), { status: 200 });
      return new Response('{}', { status: 404 });
    }));
    const ok = response();
    await handlers.get('POST /api/pipelines/apps/:appId/figma-catalog/refresh')!({ params: { appId: 'retail' } }, ok.res);
    expect(ok.output.status).toBe(200);
    expect(ok.output.body).toMatchObject({ hasToken: true, componentCount: 1, files: [{ fileKey: 'ABC', name: 'Kit', componentCount: 1 }] });
    expect((ok.output.body as any).markdown).toContain('Button');
    expect((ok.output.body as any).generatedAt).toBeTruthy();
    const json = JSON.parse(await readFile(path.join(root, 'projects', 'retail', 'figma-catalog', 'components.json'), 'utf8'));
    expect(json.files[0].components[0]).toMatchObject({ nodeId: '10:1', name: 'Button' });

    const again = response();
    await handlers.get('GET /api/pipelines/apps/:appId/figma-catalog')!({ params: { appId: 'retail' } }, again.res);
    expect(again.output.body).toMatchObject({ componentCount: 1, hasToken: true });

    const plain = response();
    await handlers.get('POST /api/pipelines/apps/:appId/figma-catalog/refresh')!({ params: { appId: 'plain' } }, plain.res);
    expect(plain.output.status).toBe(400);
  });

  it('serializes concurrent writers and always reads matching JSON + Markdown generations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-catalog-'));
    roots.push(root);
    const projectsDir = path.join(root, 'projects');
    const snapshots: FigmaComponentCatalogSnapshot[] = Array.from({ length: 20 }, (_, index) => ({
      schemaVersion: FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION,
      generatedAt: `2026-08-16T00:00:${String(index).padStart(2, '0')}.000Z`,
      files: [{
        fileKey: 'ABC',
        name: `Kit ${index}`,
        url: 'https://www.figma.com/design/ABC',
        components: [{ nodeId: `${index}:1`, name: `Button ${index}`, properties: [] }],
      }],
    }));

    await expect(Promise.all(snapshots.map((snapshot) => writeAppFigmaCatalog(projectsDir, 'retail', snapshot))))
      .resolves.toHaveLength(snapshots.length);
    const stored = await readAppFigmaCatalog(projectsDir, 'retail');
    expect(stored).not.toBeNull();
    expect(stored!.markdown).toBe(renderFigmaComponentsMarkdown(stored!.snapshot));
    const names = await (await import('node:fs/promises')).readdir(path.join(projectsDir, 'retail', 'figma-catalog'));
    expect(names).toEqual(expect.arrayContaining(['components.json', 'components.md']));
    expect(names.some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
