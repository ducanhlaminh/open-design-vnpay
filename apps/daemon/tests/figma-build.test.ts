import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { anchorFor, type FigmaComponentCatalogSnapshot } from '../src/figma-component-catalog.js';
import {
  buildWireframeLayoutTree,
  catalogHasComponentKeys,
  compileScreenBuildInput,
  computeEnabledMcp,
  parseFigmaPreviewLink,
  pickDefaultVariant,
  pickFigmaMcpServer,
  readFigmaPreviewConfig,
  readFrozenFigmaCatalog,
  writeFigmaPreviewConfig,
} from '../src/figma-build.js';
import { registerFigmaBuildRoutes } from '../src/figma-build-routes.js';
import { SCREEN_INPUTS_FILE } from '../src/screen-components.js';

// Trạng thái mock DB chỉnh được per-test (vi.hoisted vì factory vi.mock bị
// hoist lên đầu file): projectMetadata mô phỏng studioConfig.appId, apps/
// dsSources mô phỏng pipeline_apps + figma_design_system_sources cho nhánh
// fallback catalog mode app-design-system.
const dbMockState = vi.hoisted(() => ({
  projectMetadata: undefined as Record<string, unknown> | undefined,
  apps: {} as Record<string, { figmaDesignSystemSourceId: string | null }>,
  dsSources: {} as Record<string, { catalog: unknown }>,
}));

vi.mock('../src/db.js', () => ({
  getProject: (_db: unknown, id: string) => ({ id, name: id === 'proj-1' ? 'Ví điện tử' : id, metadata: dbMockState.projectMetadata }),
  getPipelineApp: (_db: unknown, id: string) => dbMockState.apps[id] ?? null,
  getFigmaDesignSystemSource: (_db: unknown, id: string) => dbMockState.dsSources[id] ?? null,
  insertConversation: () => undefined,
  upsertMessage: () => undefined,
}));

afterEach(() => {
  dbMockState.projectMetadata = undefined;
  dbMockState.apps = {};
  dbMockState.dsSources = {};
});

const DS_FILE_KEY = 'DS_FILE';

const catalogWithVariants = (): FigmaComponentCatalogSnapshot => ({
  schemaVersion: '1.0',
  generatedAt: '2026-08-21T00:00:00.000Z',
  files: [
    {
      fileKey: DS_FILE_KEY,
      name: 'DS Kit',
      url: 'https://www.figma.com/design/DS_FILE',
      components: [
        {
          nodeId: '10:1',
          name: 'Button',
          key: 'set-key-10-1',
          properties: [],
          variants: [
            { nodeId: '10:2', key: 'variant-key-default', name: 'State=Default' },
            { nodeId: '10:3', key: 'variant-key-disabled', name: 'State=Disabled' },
          ],
        },
        {
          nodeId: '11:1',
          name: 'Avatar',
          key: 'component-key-avatar',
          properties: [],
        },
      ],
    },
  ],
});

describe('compileScreenBuildInput', () => {
  const buttonAnchor = anchorFor(DS_FILE_KEY, '10:1');
  const avatarAnchor = anchorFor(DS_FILE_KEY, '11:1');

  const wireframeHtml = `<!doctype html><html><body data-screen="SCR-001">
    <div data-el="el-2"></div>
    <div data-el="el-1"></div>
  </body></html>`;

  it('matches a variant by unordered Prop=Value pairs (case/space-insensitive)', () => {
    const input = compileScreenBuildInput({
      screenDoc: {
        key: 'SCR-001',
        name: 'Đăng nhập',
        platform: 'mobile',
        elements: [
          { id: 'el-1', label: 'Nút', role: 'primary-button', ds: { component: 'Button', anchor: buttonAnchor, variant: ' state = default ' } },
        ],
      },
      wireframeHtml: null,
      catalog: catalogWithVariants(),
      previewFileKey: 'PREVIEW',
      appFeature: 'Ví điện tử',
    });
    expect(input.elements[0]!.component).toEqual({
      name: 'Button',
      key: 'variant-key-default',
      variantNodeId: '10:2',
      setNodeId: '10:1',
      variant: ' state = default ',
    });
    expect(input.elements[0]!.warning).toBeUndefined();
    expect(input.dsFileKey).toBe(DS_FILE_KEY);
  });

  it('falls back to the default variant + warning when nothing matches', () => {
    const input = compileScreenBuildInput({
      screenDoc: {
        key: 'SCR-001',
        name: 'Đăng nhập',
        platform: 'mobile',
        elements: [
          { id: 'el-1', label: 'Nút', role: 'primary-button', ds: { component: 'Button', anchor: buttonAnchor, variant: 'State=Hover' } },
        ],
      },
      wireframeHtml: null,
      catalog: catalogWithVariants(),
      previewFileKey: 'PREVIEW',
      appFeature: 'Ví điện tử',
    });
    expect(input.elements[0]!.component).toMatchObject({ variantNodeId: '10:2', key: 'variant-key-default' });
    expect(input.elements[0]!.warning).toMatch(/không khớp/);
  });

  it('element with ds: null is skipped (no component field, no warning)', () => {
    const input = compileScreenBuildInput({
      screenDoc: {
        key: 'SCR-001',
        name: 'Đăng nhập',
        platform: 'mobile',
        elements: [
          { id: 'el-1', label: 'Tiêu đề', role: 'heading', ds: null, content: { text: 'Chào mừng' } },
        ],
      },
      wireframeHtml: null,
      catalog: catalogWithVariants(),
      previewFileKey: 'PREVIEW',
      appFeature: 'Ví điện tử',
    });
    expect(input.elements[0]!.component).toBeUndefined();
    expect(input.elements[0]!.warning).toBeUndefined();
    expect(input.elements[0]!.content).toEqual({ text: 'Chào mừng' });
    expect(input.dsFileKey).toBeNull();
  });

  it('standalone component (no variants) resolves directly by key', () => {
    const input = compileScreenBuildInput({
      screenDoc: {
        key: 'SCR-001',
        name: 'Đăng nhập',
        platform: 'mobile',
        elements: [
          { id: 'el-1', label: 'Avatar', role: 'avatar', ds: { component: 'Avatar', anchor: avatarAnchor } },
        ],
      },
      wireframeHtml: null,
      catalog: catalogWithVariants(),
      previewFileKey: 'PREVIEW',
      appFeature: 'Ví điện tử',
    });
    expect(input.elements[0]!.component).toEqual({ name: 'Avatar', key: 'component-key-avatar' });
  });

  it('unknown anchor (component deleted from Figma) → warning, no component', () => {
    const input = compileScreenBuildInput({
      screenDoc: {
        key: 'SCR-001',
        name: 'Đăng nhập',
        platform: 'mobile',
        elements: [
          { id: 'el-1', label: 'Ghost', role: 'x', ds: { component: 'Ghost', anchor: 'figma-0000000000' } },
        ],
      },
      wireframeHtml: null,
      catalog: catalogWithVariants(),
      previewFileKey: 'PREVIEW',
      appFeature: 'Ví điện tử',
    });
    expect(input.elements[0]!.component).toBeUndefined();
    expect(input.elements[0]!.warning).toMatch(/không còn trong danh mục/);
  });

  it('orders elements by data-el appearance in the wireframe DOM, not screen.json order', () => {
    const input = compileScreenBuildInput({
      screenDoc: {
        key: 'SCR-001',
        name: 'Đăng nhập',
        platform: 'mobile',
        elements: [
          { id: 'el-1', label: 'A', role: 'a', ds: null },
          { id: 'el-2', label: 'B', role: 'b', ds: null },
        ],
      },
      wireframeHtml,
      catalog: catalogWithVariants(),
      previewFileKey: 'PREVIEW',
      appFeature: 'Ví điện tử',
    });
    expect(input.elements.map((e) => e.id)).toEqual(['el-2', 'el-1']);
  });

  it('names page/frame per WP25a naming rule', () => {
    const input = compileScreenBuildInput({
      screenDoc: { key: 'SCR-001', name: 'Đăng nhập', platform: 'web', elements: [] },
      wireframeHtml: null,
      catalog: catalogWithVariants(),
      previewFileKey: 'PREVIEW',
      appFeature: 'Ví điện tử',
    });
    expect(input.pageName).toBe('[OD] Ví điện tử');
    expect(input.frameName).toBe('SCR-001 — Đăng nhập');
    expect(input.platform).toBe('web');
  });

  it('WP28: variant khai không khớp trục nào của component (VD "Hierarchy=Secondary" trên Button chỉ có trục Type/Size/State/Icon Btn) → dùng heuristic "nghỉ" thay vì variants[0] khi variants[0] là State=Pressed', () => {
    const catalogRealButton: FigmaComponentCatalogSnapshot = {
      schemaVersion: '1.0',
      generatedAt: '2026-08-21T00:00:00.000Z',
      files: [
        {
          fileKey: DS_FILE_KEY,
          name: 'DS Kit',
          url: 'https://www.figma.com/design/DS_FILE',
          components: [
            {
              nodeId: '20:1',
              name: 'Button',
              key: 'set-key-btn',
              properties: [],
              variants: [
                { nodeId: '20:2', key: 'key-pressed', name: 'Type=Primary, Size=Medium, State=Pressed, Icon Btn=false' },
                { nodeId: '20:3', key: 'key-default', name: 'Type=Primary, Size=Medium, State=Default, Icon Btn=false' },
                { nodeId: '20:4', key: 'key-hover', name: 'Type=Primary, Size=Medium, State=Hover, Icon Btn=false' },
              ],
            },
          ],
        },
      ],
    };
    const buttonRealAnchor = anchorFor(DS_FILE_KEY, '20:1');
    const input = compileScreenBuildInput({
      screenDoc: {
        key: 'SCR-001',
        name: 'Đăng nhập',
        platform: 'mobile',
        elements: [
          { id: 'el-1', label: 'Nút', role: 'primary-button', ds: { component: 'Button', anchor: buttonRealAnchor, variant: 'Hierarchy=Secondary' } },
        ],
      },
      wireframeHtml: null,
      catalog: catalogRealButton,
      previewFileKey: 'PREVIEW',
      appFeature: 'Ví điện tử',
    });
    expect(input.elements[0]!.component).toMatchObject({ variantNodeId: '20:3', key: 'key-default' });
    expect(input.elements[0]!.warning).toMatch(/không khớp/);
    expect(input.elements[0]!.warning).toMatch(/State=Default/);
  });

  it('WP29: schema_version === 2 và "layout" gắn khi wireframe có cấu trúc (wf-section + wf-row)', () => {
    const html = `<!doctype html><html><body data-screen="SCR-001">
      <div class="wf-section">Thông tin</div>
      <div class="wf-row">
        <div data-el="el-1"></div>
        <div data-el="el-2"></div>
      </div>
    </body></html>`;
    const input = compileScreenBuildInput({
      screenDoc: {
        key: 'SCR-001',
        name: 'Đăng nhập',
        platform: 'mobile',
        elements: [
          { id: 'el-1', label: 'A', role: 'a', ds: null },
          { id: 'el-2', label: 'B', role: 'b', ds: null },
        ],
      },
      wireframeHtml: html,
      catalog: catalogWithVariants(),
      previewFileKey: 'PREVIEW',
      appFeature: 'Ví điện tử',
    });
    expect(input.schema_version).toBe(2);
    expect(input.layout).toEqual([
      { type: 'heading', text: 'Thông tin' },
      { type: 'row', children: [{ type: 'el', id: 'el-1' }, { type: 'el', id: 'el-2' }] },
    ]);
  });

  it('WP29: mockups passthrough khi truyền, giữ nguyên đường dẫn tương đối', () => {
    const input = compileScreenBuildInput({
      screenDoc: { key: 'SCR-001', name: 'Đăng nhập', platform: 'mobile', elements: [] },
      wireframeHtml: null,
      catalog: catalogWithVariants(),
      previewFileKey: 'PREVIEW',
      appFeature: 'Ví điện tử',
      mockups: ['docs-feature/attachments/image-1.png'],
    });
    expect(input.mockups).toEqual(['docs-feature/attachments/image-1.png']);
  });

  it('WP29: KHÔNG truyền wireframe → "layout" vắng mặt, elements[] vẫn nguyên (tương thích ngược schema 1 cũ)', () => {
    const input = compileScreenBuildInput({
      screenDoc: {
        key: 'SCR-001',
        name: 'Đăng nhập',
        platform: 'mobile',
        elements: [
          { id: 'el-1', label: 'A', role: 'a', ds: null },
          { id: 'el-2', label: 'B', role: 'b', ds: null },
        ],
      },
      wireframeHtml: null,
      catalog: catalogWithVariants(),
      previewFileKey: 'PREVIEW',
      appFeature: 'Ví điện tử',
    });
    expect(input.layout).toBeUndefined();
    expect(input.mockups).toBeUndefined();
    expect(input.elements.map((e) => e.id)).toEqual(['el-1', 'el-2']);
  });
});

describe('buildWireframeLayoutTree', () => {
  it('(a) 2 element trong div.wf-row → node row 2 con', () => {
    const html = `<!doctype html><html><body>
      <div class="wf-row">
        <div data-el="a"></div>
        <div data-el="b"></div>
      </div>
    </body></html>`;
    expect(buildWireframeLayoutTree(html, ['a', 'b'])).toEqual([
      { type: 'row', children: [{ type: 'el', id: 'a' }, { type: 'el', id: 'b' }] },
    ]);
  });

  it('(b) div.wf-section có text → heading', () => {
    const html = `<!doctype html><html><body><div class="wf-section">Tiêu đề</div></body></html>`;
    expect(buildWireframeLayoutTree(html, [])).toEqual([{ type: 'heading', text: 'Tiêu đề' }]);
  });

  it('(c) data-el bọc data-el con → group đúng id + children', () => {
    const html = `<!doctype html><html><body>
      <div data-el="card1"><div data-el="child1"></div></div>
    </body></html>`;
    expect(buildWireframeLayoutTree(html, ['card1', 'child1'])).toEqual([
      { type: 'group', id: 'card1', children: [{ type: 'el', id: 'child1' }] },
    ]);
  });

  it('(d) wrapper vô danh xuyên qua, row 1 con bị nâng lên thay row', () => {
    const html = `<!doctype html><html><body>
      <div>
        <div class="wf-row"><div data-el="x"></div></div>
      </div>
    </body></html>`;
    expect(buildWireframeLayoutTree(html, ['x'])).toEqual([{ type: 'el', id: 'x' }]);
  });

  it('(e) data-el ngoài knownIds bị bỏ nhưng con vẫn vào cây', () => {
    const html = `<!doctype html><html><body>
      <div data-el="unknown"><div data-el="known1"></div></div>
    </body></html>`;
    expect(buildWireframeLayoutTree(html, ['known1'])).toEqual([{ type: 'el', id: 'known1' }]);
  });

  it('(f) html không có gì khớp → null', () => {
    const html = `<!doctype html><html><body><div>không có data-el hay wf-section/wf-row nào</div></body></html>`;
    expect(buildWireframeLayoutTree(html, ['whatever'])).toBeNull();
  });
});

describe('pickDefaultVariant', () => {
  it('(a) State=Pressed đứng đầu, State=Default đứng sau → chọn Default (ca Button thật của DS)', () => {
    const variants = [
      { nodeId: '1', name: 'State=Pressed' },
      { nodeId: '2', name: 'State=Default' },
    ];
    expect(pickDefaultVariant(variants)).toBe(variants[1]);
  });

  it('(b) không có state=default nhưng có variant sạch marker vs variant chứa "hover" → chọn variant sạch', () => {
    const variants = [
      { nodeId: '1', name: 'Type=Ghost, State=Hover' },
      { nodeId: '2', name: 'Type=Ghost, Size=Large' },
    ];
    expect(pickDefaultVariant(variants)).toBe(variants[1]);
  });

  it('(c) tất cả đều chứa marker → variants[0]', () => {
    const variants = [
      { nodeId: '1', name: 'State=Pressed' },
      { nodeId: '2', name: 'State=Hover' },
    ];
    expect(pickDefaultVariant(variants)).toBe(variants[0]);
  });

  it('(d) set 1 variant → chính nó', () => {
    const variants = [{ nodeId: '1', name: 'State=Pressed' }];
    expect(pickDefaultVariant(variants)).toBe(variants[0]);
  });
});

describe('pickFigmaMcpServer', () => {
  it('picks the first ENABLED server whose templateId is figma', () => {
    const servers = [
      { id: 'other', enabled: true },
      { id: 'my-figma', enabled: true, templateId: 'figma' },
    ];
    expect(pickFigmaMcpServer(servers)).toMatchObject({ id: 'my-figma' });
  });

  it('falls back to id/url matching /figma/i when no templateId match', () => {
    expect(pickFigmaMcpServer([{ id: 'acme-figma-remote', enabled: true }])).toMatchObject({ id: 'acme-figma-remote' });
    expect(pickFigmaMcpServer([{ id: 'srv', enabled: true, url: 'https://figma.example.com/mcp' }])).toMatchObject({ id: 'srv' });
  });

  it('ignores a disabled server, returns null when none match', () => {
    expect(pickFigmaMcpServer([{ id: 'figma', enabled: false }])).toBeNull();
    expect(pickFigmaMcpServer([{ id: 'unrelated', enabled: true }])).toBeNull();
    expect(pickFigmaMcpServer([])).toBeNull();
  });
});

describe('computeEnabledMcp', () => {
  const servers = [{ id: 'a', enabled: true }, { id: 'b', enabled: false }, { id: 'c', enabled: true }];

  it('pipeline profile → always empty, regardless of allowIds', () => {
    expect(computeEnabledMcp(servers, true, null)).toEqual([]);
    expect(computeEnabledMcp(servers, true, ['a'])).toEqual([]);
  });

  it('no allow-list (null) → every existing call site unchanged: all enabled servers', () => {
    expect(computeEnabledMcp(servers, false, null)).toEqual([{ id: 'a', enabled: true }, { id: 'c', enabled: true }]);
  });

  it('allow-list narrows to the intersection with enabled servers', () => {
    expect(computeEnabledMcp(servers, false, ['c', 'b', 'nonexistent'])).toEqual([{ id: 'c', enabled: true }]);
  });
});

describe('.figma-preview.json', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('read → null when missing; write → read round-trips', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-preview-'));
    roots.push(root);
    expect(await readFigmaPreviewConfig(root)).toBeNull();
    await writeFigmaPreviewConfig(root, { fileKey: 'ABC123', url: 'https://www.figma.com/design/ABC123' });
    expect(await readFigmaPreviewConfig(root)).toEqual({ fileKey: 'ABC123', url: 'https://www.figma.com/design/ABC123' });
    const files = await import('node:fs/promises').then((m) => m.readdir(root));
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('read → null on corrupted JSON (best-effort, no throw)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-preview-'));
    roots.push(root);
    await writeFile(path.join(root, '.figma-preview.json'), '{not json', 'utf8');
    expect(await readFigmaPreviewConfig(root)).toBeNull();
  });
});

describe('parseFigmaPreviewLink', () => {
  it('accepts figma.com/design/<key> and file/<key>, canonicalizes to design/', () => {
    expect(parseFigmaPreviewLink('https://www.figma.com/design/ABC123/My-File?node-id=1-2'))
      .toEqual({ fileKey: 'ABC123', url: 'https://www.figma.com/design/ABC123' });
    expect(parseFigmaPreviewLink('https://figma.com/file/XYZ789/Other'))
      .toEqual({ fileKey: 'XYZ789', url: 'https://www.figma.com/design/XYZ789' });
  });

  it('rejects non-figma hosts, malformed URLs, empty input', () => {
    expect(parseFigmaPreviewLink('https://example.com/design/ABC123')).toBeNull();
    expect(parseFigmaPreviewLink('not a url')).toBeNull();
    expect(parseFigmaPreviewLink('')).toBeNull();
  });
});

describe('readFrozenFigmaCatalog / catalogHasComponentKeys', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reads .figma-catalog/components.json when present and shaped like a snapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-frozen-'));
    roots.push(root);
    await mkdir(path.join(root, '.figma-catalog'), { recursive: true });
    const snapshot = catalogWithVariants();
    await writeFile(path.join(root, '.figma-catalog', 'components.json'), JSON.stringify(snapshot), 'utf8');
    const read = await readFrozenFigmaCatalog(root);
    expect(read).toEqual(snapshot);
    expect(catalogHasComponentKeys(read!)).toBe(true);
  });

  it('missing file → null; a catalogue frozen before WP25a (no key/variants) → catalogHasComponentKeys false', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-frozen-'));
    roots.push(root);
    expect(await readFrozenFigmaCatalog(root)).toBeNull();
    const oldSnapshot: FigmaComponentCatalogSnapshot = {
      schemaVersion: '1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      files: [{ fileKey: 'F', name: 'Old', url: 'https://www.figma.com/design/F', components: [{ nodeId: '1:1', name: 'Button', properties: [] }] }],
    };
    expect(catalogHasComponentKeys(oldSnapshot)).toBe(false);
  });
});

// ── job routes (clone of figma-catalog-routes.test.ts's fake-express harness) ──

type Handler = (req: any, res: any) => unknown;
function response() {
  const output: { status: number; body?: unknown } = { status: 200 };
  const res = { status(code: number) { output.status = code; return res; }, json(body: unknown) { output.body = body; return res; } };
  return { output, res };
}

function register(
  dataDir: string,
  agents?: { getAgentDef?: () => unknown; resolveAgent?: () => unknown },
  // WP29: cho phép một test override `design.runs.wait` (vd để tự ghi
  // result.json giữa lúc "agent" chạy) mà không đụng tới mọi test khác vẫn
  // đang dùng mock mặc định "succeeded ngay".
  designOverrides?: { runs?: { create?: () => unknown; start?: () => unknown; wait?: () => Promise<unknown> } },
) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(route: string, handler: Handler) { handlers.set(`GET ${route}`, handler); },
    post(route: string, handler: Handler) { handlers.set(`POST ${route}`, handler); },
    put(route: string, handler: Handler) { handlers.set(`PUT ${route}`, handler); },
  };
  registerFigmaBuildRoutes(app as never, {
    db: { prepare: () => ({ run: () => undefined }) },
    http: { isLocalSameOrigin: () => true, resolvedPortRef: { current: 7456 } },
    paths: { RUNTIME_DATA_DIR: dataDir, PROJECTS_DIR: path.join(dataDir, 'projects') },
    design: {
      runs: {
        create: designOverrides?.runs?.create ?? (() => ({ id: 'run-1' })),
        start: designOverrides?.runs?.start ?? (() => undefined),
        wait: designOverrides?.runs?.wait ?? (async () => ({ status: 'succeeded' })),
      },
    },
    chat: { startChatRun: () => undefined },
    agents,
  } as never);
  return handlers;
}

/** Job chạy trong `void (async () => {...})()` không được await bởi POST —
 *  poll GET job cho tới khi kết thúc (thay vì sleep cố định, tránh flaky). */
async function waitForBuildJobDone(handlers: Map<string, Handler>, projectId: string, jobId: string): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const r = response();
    await handlers.get('GET /api/projects/:projectId/docs-review/figma-build/:jobId')!({ params: { projectId, jobId } }, r.res);
    const job = (r.output.body as any)?.job;
    if (job?.status === 'succeeded' || job?.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('figma-build job did not finish in time');
}

describe('figma-build job routes: precheck error codes', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('FIGMA_PREVIEW_FILE_REQUIRED when .figma-preview.json is missing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const handlers = register(root);
    const r = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, r.res);
    expect(r.output.status).toBe(400);
    expect((r.output.body as any).error.code).toBe('FIGMA_PREVIEW_FILE_REQUIRED');
  });

  it('MCP_FIGMA_REQUIRED when preview is configured but no enabled Figma MCP server exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const cwd = path.join(root, 'projects', 'proj-1', 'docs-review');
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, '.figma-preview.json'), JSON.stringify({ fileKey: 'PREVIEW', url: 'https://www.figma.com/design/PREVIEW' }), 'utf8');
    await writeFile(path.join(root, 'mcp-config.json'), JSON.stringify({ servers: [{ id: 'other', enabled: true, transport: 'http' }] }), 'utf8');
    const handlers = register(root);
    const r = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, r.res);
    expect(r.output.status).toBe(400);
    expect((r.output.body as any).error.code).toBe('MCP_FIGMA_REQUIRED');
  });

  it('MCP_FIGMA_CONNECT_REQUIRED when the Figma MCP server is enabled but has no stored OAuth token', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const cwd = path.join(root, 'projects', 'proj-1', 'docs-review');
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, '.figma-preview.json'), JSON.stringify({ fileKey: 'PREVIEW', url: 'https://www.figma.com/design/PREVIEW' }), 'utf8');
    await writeFile(path.join(root, 'mcp-config.json'), JSON.stringify({ servers: [{ id: 'figma', enabled: true, transport: 'http', templateId: 'figma', url: 'https://mcp.figma.com/mcp' }] }), 'utf8');
    // No mcp-tokens.json at all — the seeded server was never OAuth'd.
    const handlers = register(root);
    const r = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, r.res);
    expect(r.output.status).toBe(400);
    // Distinct code from MCP_FIGMA_REQUIRED — the web maps known codes to
    // hardcoded messages, and only an UNKNOWN code falls through to this
    // daemon message, so reusing the old code would hide the "Connect" hint.
    expect((r.output.body as any).error.code).toBe('MCP_FIGMA_CONNECT_REQUIRED');
    expect((r.output.body as any).error.message).toContain('Connect');
  });

  it('token check skipped for a user-pinned Authorization header and for non-oauth transports', async () => {
    // Both configs pass the MCP precheck WITHOUT any mcp-tokens.json and land
    // on CATALOG_REQUIRED — a stored OAuth token is only demanded where its
    // absence would actually break the run (oauth mode, nothing pinned).
    const cases = [
      // http + oauth but the user pinned a manual token (mergeAuthHeader lets it win)
      { id: 'figma', enabled: true, transport: 'http', templateId: 'figma', url: 'https://mcp.figma.com/mcp', authMode: 'oauth', headers: { Authorization: 'Bearer manual' } },
      // stdio server whose id matches /figma/i (e.g. figma-context) — no token concept at all
      { id: 'figma-context', enabled: true, transport: 'stdio', command: 'npx' },
    ];
    for (const server of cases) {
      const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
      roots.push(root);
      const cwd = path.join(root, 'projects', 'proj-1', 'docs-review');
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(cwd, '.figma-preview.json'), JSON.stringify({ fileKey: 'PREVIEW', url: 'https://www.figma.com/design/PREVIEW' }), 'utf8');
      await writeFile(path.join(root, 'mcp-config.json'), JSON.stringify({ servers: [server] }), 'utf8');
      const handlers = register(root);
      const r = response();
      await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, r.res);
      expect((r.output.body as any).error.code).toBe('CATALOG_REQUIRED');
    }
  });

  it('an expired token WITH a refreshToken still counts as connected (spawn path refreshes it)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const cwd = path.join(root, 'projects', 'proj-1', 'docs-review');
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, '.figma-preview.json'), JSON.stringify({ fileKey: 'PREVIEW', url: 'https://www.figma.com/design/PREVIEW' }), 'utf8');
    await writeFile(path.join(root, 'mcp-config.json'), JSON.stringify({ servers: [{ id: 'figma', enabled: true, transport: 'http', templateId: 'figma', url: 'https://mcp.figma.com/mcp', authMode: 'oauth' }] }), 'utf8');
    await writeFile(path.join(root, 'mcp-tokens.json'), JSON.stringify({ servers: { figma: { accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() - 10_000_000, expiresAt: Date.now() - 1_000, refreshToken: 'refresh' } } }), 'utf8');
    const handlers = register(root);
    const r = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, r.res);
    expect((r.output.body as any).error.code).toBe('CATALOG_REQUIRED');
  });

  it('app-design-system mode: falls back to the App DS-source catalog in DB when no frozen .figma-catalog exists', async () => {
    // Bug thật từ 0.8.90: App mode mặc định không bao giờ ghi .figma-catalog/
    // (chỉ figma-links mode ghi) → precheck cũ trả CATALOG_REQUIRED vĩnh viễn
    // dù DS source đã Refresh và có key. Fallback phải đọc được catalog DB.
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const cwd = path.join(root, 'projects', 'proj-1', 'docs-review');
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, '.figma-preview.json'), JSON.stringify({ fileKey: 'PREVIEW', url: 'https://www.figma.com/design/PREVIEW' }), 'utf8');
    await writeFile(path.join(root, 'mcp-config.json'), JSON.stringify({ servers: [{ id: 'figma', enabled: true, transport: 'http', templateId: 'figma', url: 'https://mcp.figma.com/mcp', authMode: 'oauth' }] }), 'utf8');
    await writeFile(path.join(root, 'mcp-tokens.json'), JSON.stringify({ servers: { figma: { accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() } } }), 'utf8');
    dbMockState.projectMetadata = { studioConfig: { appId: 'app-1' } };
    dbMockState.apps['app-1'] = { figmaDesignSystemSourceId: 'src-1' };
    dbMockState.dsSources['src-1'] = { catalog: catalogWithVariants() };
    const handlers = register(root, {}); // no resolveAgent — catalog OK phải trượt tới AGENT_UNAVAILABLE
    const r = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, r.res);
    expect(r.output.status).toBe(501);
    expect((r.output.body as any).error.code).toBe('AGENT_UNAVAILABLE');
  });

  it('app-design-system mode: DB catalog WITHOUT keys (refreshed pre-0.8.89) still → CATALOG_REQUIRED', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const cwd = path.join(root, 'projects', 'proj-1', 'docs-review');
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, '.figma-preview.json'), JSON.stringify({ fileKey: 'PREVIEW', url: 'https://www.figma.com/design/PREVIEW' }), 'utf8');
    await writeFile(path.join(root, 'mcp-config.json'), JSON.stringify({ servers: [{ id: 'figma', enabled: true, transport: 'http', templateId: 'figma', url: 'https://mcp.figma.com/mcp', authMode: 'oauth' }] }), 'utf8');
    await writeFile(path.join(root, 'mcp-tokens.json'), JSON.stringify({ servers: { figma: { accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() } } }), 'utf8');
    dbMockState.projectMetadata = { studioConfig: { appId: 'app-1' } };
    dbMockState.apps['app-1'] = { figmaDesignSystemSourceId: 'src-1' };
    const legacy = catalogWithVariants();
    for (const f of legacy.files) for (const c of f.components) { delete (c as { key?: string }).key; delete (c as { variants?: unknown }).variants; }
    dbMockState.dsSources['src-1'] = { catalog: legacy };
    const handlers = register(root);
    const r = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, r.res);
    expect(r.output.status).toBe(400);
    expect((r.output.body as any).error.code).toBe('CATALOG_REQUIRED');
  });

  it('CATALOG_REQUIRED when the frozen .figma-catalog/components.json is missing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const cwd = path.join(root, 'projects', 'proj-1', 'docs-review');
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, '.figma-preview.json'), JSON.stringify({ fileKey: 'PREVIEW', url: 'https://www.figma.com/design/PREVIEW' }), 'utf8');
    await writeFile(path.join(root, 'mcp-config.json'), JSON.stringify({ servers: [{ id: 'figma', enabled: true, transport: 'http', templateId: 'figma', url: 'https://mcp.figma.com/mcp' }] }), 'utf8');
    await writeFile(path.join(root, 'mcp-tokens.json'), JSON.stringify({ servers: { figma: { accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() } } }), 'utf8');
    const handlers = register(root);
    const r = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, r.res);
    expect(r.output.status).toBe(400);
    expect((r.output.body as any).error.code).toBe('CATALOG_REQUIRED');
  });

  it('AGENT_UNAVAILABLE when every earlier precheck passes but no agent resolver is wired', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const cwd = path.join(root, 'projects', 'proj-1', 'docs-review');
    await mkdir(path.join(cwd, '.figma-catalog'), { recursive: true });
    await writeFile(path.join(cwd, '.figma-preview.json'), JSON.stringify({ fileKey: 'PREVIEW', url: 'https://www.figma.com/design/PREVIEW' }), 'utf8');
    await writeFile(path.join(root, 'mcp-config.json'), JSON.stringify({ servers: [{ id: 'figma', enabled: true, transport: 'http', templateId: 'figma', url: 'https://mcp.figma.com/mcp' }] }), 'utf8');
    await writeFile(path.join(root, 'mcp-tokens.json'), JSON.stringify({ servers: { figma: { accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() } } }), 'utf8');
    await writeFile(path.join(cwd, '.figma-catalog', 'components.json'), JSON.stringify(catalogWithVariants()), 'utf8');
    const handlers = register(root, {}); // no resolveAgent
    const r = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, r.res);
    expect(r.output.status).toBe(501);
    expect((r.output.body as any).error.code).toBe('AGENT_UNAVAILABLE');
  });

  it('resolveAgent THROWS (no claude-capable runtime) → 501 AGENT_UNAVAILABLE with the thrown message, not 500', async () => {
    // server.ts's resolveFigmaBuildAgent throws when no runtime with
    // externalMcpInjection 'claude-mcp-json' is available (default agent =
    // codex on the user machine that hit this) — the route must surface it
    // as an actionable AGENT_UNAVAILABLE, not a generic INTERNAL.
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const cwd = path.join(root, 'projects', 'proj-1', 'docs-review');
    await mkdir(path.join(cwd, '.figma-catalog'), { recursive: true });
    await writeFile(path.join(cwd, '.figma-preview.json'), JSON.stringify({ fileKey: 'PREVIEW', url: 'https://www.figma.com/design/PREVIEW' }), 'utf8');
    await writeFile(path.join(root, 'mcp-config.json'), JSON.stringify({ servers: [{ id: 'figma', enabled: true, transport: 'http', templateId: 'figma', url: 'https://mcp.figma.com/mcp' }] }), 'utf8');
    await writeFile(path.join(root, 'mcp-tokens.json'), JSON.stringify({ servers: { figma: { accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() } } }), 'utf8');
    await writeFile(path.join(cwd, '.figma-catalog', 'components.json'), JSON.stringify(catalogWithVariants()), 'utf8');
    const handlers = register(root, { resolveAgent: () => Promise.reject(new Error('Bước "Dựng trong Figma" cần Claude CLI khả dụng.')) });
    const r = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, r.res);
    expect(r.output.status).toBe(501);
    expect((r.output.body as any).error.code).toBe('AGENT_UNAVAILABLE');
    expect((r.output.body as any).error.message).toContain('Claude CLI');
  });

  it('missing/empty screenKeys → INVALID_INPUT before any precheck', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const handlers = register(root);
    const r = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: [] } }, r.res);
    expect(r.output.status).toBe(400);
    expect((r.output.body as any).error.code).toBe('INVALID_INPUT');
  });

  it('screenKey with path separators or ".." → INVALID_INPUT (no fs path built from it)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const handlers = register(root);
    for (const bad of ['../secret', 'a/b', 'a\\b', '..', '6.3..1']) {
      const r = response();
      await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['6.3.1', bad] } }, r.res);
      expect(r.output.status).toBe(400);
      expect((r.output.body as any).error.code).toBe('INVALID_INPUT');
    }
  });
});

describe('figma-build figma-preview GET/PUT routes', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('GET before PUT → config null; PUT valid link → 200 + persisted; GET after → same config', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const handlers = register(root);
    const before = response();
    await handlers.get('GET /api/projects/:projectId/docs-review/figma-preview')!({ params: { projectId: 'proj-1' } }, before.res);
    expect(before.output.body).toEqual({ config: null });

    const put = response();
    await handlers.get('PUT /api/projects/:projectId/docs-review/figma-preview')!({ params: { projectId: 'proj-1' }, body: { url: 'https://www.figma.com/design/PREVIEW/Some-File' } }, put.res);
    expect(put.output.status).toBe(200);
    expect(put.output.body).toEqual({ config: { fileKey: 'PREVIEW', url: 'https://www.figma.com/design/PREVIEW' } });

    const after = response();
    await handlers.get('GET /api/projects/:projectId/docs-review/figma-preview')!({ params: { projectId: 'proj-1' } }, after.res);
    expect(after.output.body).toEqual({ config: { fileKey: 'PREVIEW', url: 'https://www.figma.com/design/PREVIEW' } });
  });

  it('PUT invalid link → 400 INVALID_INPUT, nothing persisted', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-'));
    roots.push(root);
    const handlers = register(root);
    const put = response();
    await handlers.get('PUT /api/projects/:projectId/docs-review/figma-preview')!({ params: { projectId: 'proj-1' }, body: { url: 'not a figma link' } }, put.res);
    expect(put.output.status).toBe(400);
    expect((put.output.body as any).error.code).toBe('INVALID_INPUT');
    const readBack = await readFigmaPreviewConfig(path.join(root, 'projects', 'proj-1', 'docs-review'));
    expect(readBack).toBeNull();
  });
});

describe('figma-build job: WP29 mockups từ comp/_inputs.json → input.json', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setupPassingPrecheck(root: string, cwd: string): Promise<void> {
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, '.figma-preview.json'), JSON.stringify({ fileKey: 'PREVIEW', url: 'https://www.figma.com/design/PREVIEW' }), 'utf8');
    await writeFile(path.join(root, 'mcp-config.json'), JSON.stringify({ servers: [{ id: 'figma', enabled: true, transport: 'http', templateId: 'figma', url: 'https://mcp.figma.com/mcp' }] }), 'utf8');
    await writeFile(path.join(root, 'mcp-tokens.json'), JSON.stringify({ servers: { figma: { accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() } } }), 'utf8');
    await mkdir(path.join(cwd, '.figma-catalog'), { recursive: true });
    await writeFile(path.join(cwd, '.figma-catalog', 'components.json'), JSON.stringify(catalogWithVariants()), 'utf8');
    await mkdir(path.join(cwd, 'comp'), { recursive: true });
    await writeFile(path.join(cwd, 'comp', 'SCR-001.screen.json'), JSON.stringify({ key: 'SCR-001', name: 'Đăng nhập', platform: 'mobile', elements: [] }), 'utf8');
  }

  function registerWithSucceedingAgent(root: string, resultPath: string) {
    return register(root, { resolveAgent: async () => ({ agentId: 'claude', modelPrefs: { model: null, reasoning: null } }) }, {
      runs: {
        wait: async () => {
          await mkdir(path.dirname(resultPath), { recursive: true });
          await writeFile(resultPath, JSON.stringify({ frameNodeId: '1:1' }), 'utf8');
          return { status: 'succeeded' };
        },
      },
    });
  }

  it('_inputs.json có mockups → input.json ghi ra chứa mockups đã lọc còn tồn tại thật, tối đa 3, chặn traversal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-mockups-'));
    roots.push(root);
    const cwd = path.join(root, 'projects', 'proj-1', 'docs-review');
    await setupPassingPrecheck(root, cwd);
    await mkdir(path.join(cwd, 'docs-feature', 'attachments'), { recursive: true });
    await writeFile(path.join(cwd, 'docs-feature', 'attachments', 'image-1.png'), 'fake', 'utf8');
    await writeFile(path.join(cwd, 'docs-feature', 'attachments', 'image-2.png'), 'fake', 'utf8');
    await writeFile(path.join(cwd, 'docs-feature', 'attachments', 'image-3.png'), 'fake', 'utf8');
    await writeFile(path.join(cwd, 'docs-feature', 'attachments', 'image-4.png'), 'fake', 'utf8');
    await writeFile(path.join(cwd, SCREEN_INPUTS_FILE), JSON.stringify({
      screens: [
        {
          key: 'SCR-001',
          mockups: [
            'docs-feature/attachments/image-1.png',
            'docs-feature/attachments/image-2.png',
            'docs-feature/attachments/missing.png', // không tồn tại → loại
            '../outside.png', // thoát ra ngoài cwd → loại
            'docs-feature/attachments/image-3.png',
            'docs-feature/attachments/image-4.png', // vượt quá 3 ảnh đã lọc → loại
          ],
        },
      ],
    }), 'utf8');

    const resultPath = path.join(cwd, 'comp', 'figma-build', 'SCR-001.result.json');
    const handlers = registerWithSucceedingAgent(root, resultPath);
    const start = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, start.res);
    expect(start.output.status).toBe(202);
    const jobId = (start.output.body as any).jobId;
    const job = await waitForBuildJobDone(handlers, 'proj-1', jobId);
    expect(job.status).toBe('succeeded');

    const input = JSON.parse(await readFile(path.join(cwd, 'comp', 'figma-build', 'SCR-001.input.json'), 'utf8'));
    expect(input.schema_version).toBe(2);
    expect(input.mockups).toEqual([
      'docs-feature/attachments/image-1.png',
      'docs-feature/attachments/image-2.png',
      'docs-feature/attachments/image-3.png',
    ]);
  });

  it('_inputs.json hỏng (JSON lỗi) → compile vẫn chạy, input.json không có mockups (không fail, không warning)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-mockups-'));
    roots.push(root);
    const cwd = path.join(root, 'projects', 'proj-1', 'docs-review');
    await setupPassingPrecheck(root, cwd);
    await writeFile(path.join(cwd, SCREEN_INPUTS_FILE), '{not json', 'utf8');

    const resultPath = path.join(cwd, 'comp', 'figma-build', 'SCR-001.result.json');
    const handlers = registerWithSucceedingAgent(root, resultPath);
    const start = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, start.res);
    const jobId = (start.output.body as any).jobId;
    const job = await waitForBuildJobDone(handlers, 'proj-1', jobId);
    expect(job.status).toBe('succeeded');

    const input = JSON.parse(await readFile(path.join(cwd, 'comp', 'figma-build', 'SCR-001.input.json'), 'utf8'));
    expect(input.mockups).toBeUndefined();
  });

  it('_inputs.json thiếu hẳn (không tồn tại) → compile vẫn chạy, input.json không có mockups', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-build-mockups-'));
    roots.push(root);
    const cwd = path.join(root, 'projects', 'proj-1', 'docs-review');
    await setupPassingPrecheck(root, cwd);
    // Không ghi comp/_inputs.json nào cả.

    const resultPath = path.join(cwd, 'comp', 'figma-build', 'SCR-001.result.json');
    const handlers = registerWithSucceedingAgent(root, resultPath);
    const start = response();
    await handlers.get('POST /api/projects/:projectId/docs-review/figma-build/start')!({ params: { projectId: 'proj-1' }, body: { screenKeys: ['SCR-001'] } }, start.res);
    const jobId = (start.output.body as any).jobId;
    const job = await waitForBuildJobDone(handlers, 'proj-1', jobId);
    expect(job.status).toBe('succeeded');

    const input = JSON.parse(await readFile(path.join(cwd, 'comp', 'figma-build', 'SCR-001.input.json'), 'utf8'));
    expect(input.mockups).toBeUndefined();
  });
});
