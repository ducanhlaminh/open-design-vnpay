// WP20: "Sinh mô tả component thiếu" (WP19b) áp cho nguồn Figma DÙNG CHUNG —
// hoàn tất scope cho App gắn DS qua figmaDesignSystemSourceId (khác
// componentSource.mode 'figma-links' của WP19b, đã có test riêng ở
// figma-catalog-routes.test.ts / figma-guide-generate.test.ts). File này phủ:
//   1. Path helper + đọc/ghi atomic kho nguồn (mirror WP19a App-level).
//   2. GET /:id: guideMarkdown + coverage tính từ row.catalog + guide.
//   3. POST/GET job route: khuôn double-submit theo sourceId, lỗi rõ lời khi
//      thiếu catalog/token.
//   4. app-context-version.ts: allowlist nhận components-guide.md + file ảo
//      lọc theo catalog (không mang mô tả của anchor đã bị xoá khỏi Figma) +
//      digest KHÔNG đổi cho app không có guide (bất biến tương thích ngược).
//
// `runDescribeChunk`/`fetchNodeSubtrees`/`fetchNodeImages` bị mock ở mức
// module — cùng lý do figma-catalog-routes.test.ts/figma-design-system-
// routes.test.ts không có test end-to-end cho job App-level: orchestration
// thật (spawn agent, gọi Figma REST) đã có bằng chứng riêng ở
// figma-guide-generate.test.ts (hàm thuần, dùng CHUNG bởi cả hai route job);
// ở đây chỉ cần job KHÔNG BAO GIỜ resolve ngay để test được nhánh double-
// submit một cách tất định, không phụ thuộc network/thời gian thật.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/figma-catalog-routes.js', () => ({
  downloadFigmaImage: vi.fn(async () => false),
  // Không bao giờ resolve — job dừng ở 'running' vô thời hạn, đủ để test
  // nhánh double-submit (202 fast-path) một cách tất định.
  runDescribeChunk: vi.fn(() => new Promise(() => {})),
}));
vi.mock('../src/figma-rest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/figma-rest.js')>();
  return {
    ...actual,
    fetchNodeSubtrees: vi.fn(async () => new Map()),
    fetchNodeImages: vi.fn(async () => new Map()),
  };
});

import { closeDatabase, openDatabase } from '../src/db.js';
import { writeFigmaConfig } from '../src/figma-config.js';
import { FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION, anchorFor, type FigmaComponentCatalogSnapshot } from '../src/figma-component-catalog.js';
import { parseComponentsGuide, renderComponentsGuideMarkdown } from '../src/figma-component-guide.js';
import {
  buildFigmaDesignSystemComponentItems,
  figmaDesignSystemGuideMetaPath,
  figmaDesignSystemGuidePath,
  readFigmaDesignSystemGuide,
  readFigmaDesignSystemGuideMeta,
  registerFigmaDesignSystemRoutes,
  writeFigmaDesignSystemGuide,
  writeFigmaDesignSystemGuideMeta,
  writeFilteredComponentsGuideToCriteria,
} from '../src/figma-design-system-routes.js';
import {
  appContextManifestDigestIsValid,
  createAppContextVersion,
} from '../src/app-context-version.js';
// WP21a: import THẲNG (không qua mock) — các test engine ở section 7 tiêm
// deps giả riêng, không đụng module `figma-catalog-routes.js`/`figma-rest.js`
// đã bị mock ở trên. `runDescribeChunk` import Ở ĐÂY là để test job route
// end-to-end (section 9) ghi đè implementation MẶC ĐỊNH "không bao giờ
// resolve" — cùng object mock nhờ vi.mock hoisted theo module specifier.
import { runDescribeChunk } from '../src/figma-catalog-routes.js';
import { generateComponentDescriptions, type GuideGenerationDeps } from '../src/figma-guide-generate.js';

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

describe('WP20: nguồn Figma dùng chung — guide + coverage + job "Sinh mô tả"', () => {
  const roots: string[] = [];
  afterEach(async () => {
    closeDatabase();
    vi.clearAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const catalog = (): FigmaComponentCatalogSnapshot => ({
    schemaVersion: FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION,
    generatedAt: '2026-08-19T00:00:00.000Z',
    files: [{
      fileKey: 'ABC',
      name: 'Core UI',
      url: 'https://www.figma.com/design/ABC',
      components: [
        { nodeId: '1:1', name: 'Button', description: 'Đã có mô tả Figma.', properties: [] },
        { nodeId: '1:2', name: 'Card', properties: [] },
      ],
    }],
  });

  async function setup(buildCatalog = vi.fn(async () => catalog())) {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-ds-guide-'));
    roots.push(root);
    const db = openDatabase(root, { dataDir: root });
    const handlers = new Map<string, Handler>();
    const app = {
      get(route: string, handler: Handler) { handlers.set(`GET ${route}`, handler); },
      post(route: string, handler: Handler) { handlers.set(`POST ${route}`, handler); },
      patch() {},
      delete() {},
    };
    registerFigmaDesignSystemRoutes(app as never, {
      db,
      http: { isLocalSameOrigin: () => true, resolvedPortRef: { current: 7456 } },
      paths: { RUNTIME_DATA_DIR: root },
      buildCatalog: buildCatalog as never,
      now: () => Date.parse('2026-08-19T00:00:00.000Z'),
      design: { runs: { create: () => ({}), start: () => {}, wait: async () => ({ status: 'succeeded' }) } },
      chat: { startChatRun: () => {} },
      agents: { getAgentDef: () => undefined, resolveAgent: async () => ({ agentId: 'test-agent', modelPrefs: {} }) },
    } as never);
    return { root, db, handlers };
  }

  async function createSourceWithCatalog(root: string, handlers: Map<string, Handler>) {
    // /refresh cần token trên máy (kể cả khi buildCatalog đã bị tiêm giả) —
    // dọn sau ở test cần "chưa có token" bằng cách KHÔNG gọi hàm này.
    await writeFigmaConfig(root, { token: 'setup-token' });
    const created = response();
    await handlers.get('POST /api/figma-design-systems')!({ body: { name: 'Kit', links: ['https://figma.com/design/ABC'] } }, created.res);
    const id = created.output.body.source.id;
    const refreshed = response();
    await handlers.get('POST /api/figma-design-systems/:id/refresh')!({ params: { id } }, refreshed.res);
    expect(refreshed.output.status).toBe(200);
    return id as string;
  }

  /* ── 1. Path helper + đọc/ghi atomic ─────────────────────────────────── */

  it('figmaDesignSystemGuidePath: cạnh components.md, dưới criteria/', () => {
    const p = figmaDesignSystemGuidePath('/data', 'src-1');
    expect(p).toBe(path.join('/data', 'figma-design-systems', 'src-1', 'criteria', 'components-guide.md'));
  });

  it('readFigmaDesignSystemGuide: null khi chưa từng ghi; ghi/đọc atomic không để lại .tmp', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-figma-ds-guide-io-'));
    roots.push(root);
    expect(await readFigmaDesignSystemGuide(root, 'src-1')).toBeNull();
    const md = renderComponentsGuideMarkdown([{ anchor: anchorFor('ABC', '1:2'), name: 'Card', description: 'Mô tả AI sinh.' }]);
    await writeFigmaDesignSystemGuide(root, 'src-1', md);
    expect(await readFigmaDesignSystemGuide(root, 'src-1')).toBe(md);
    const dir = path.dirname(figmaDesignSystemGuidePath(root, 'src-1'));
    const names = await fs.promises.readdir(dir);
    expect(names).toEqual(['components-guide.md']);
  });

  it('writeFigmaDesignSystemGuide: serialize ghi đồng thời theo sourceId — không văng lỗi, kết quả là MỘT trong các bản ghi', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-figma-ds-guide-race-'));
    roots.push(root);
    const contents = Array.from({ length: 10 }, (_, i) => `# Guide ${i}\n`);
    await expect(Promise.all(contents.map((md) => writeFigmaDesignSystemGuide(root, 'src-1', md))))
      .resolves.toHaveLength(contents.length);
    const finalMd = await readFigmaDesignSystemGuide(root, 'src-1');
    expect(contents).toContain(finalMd);
  });

  /* ── 2. GET /:id: guideMarkdown + coverage ───────────────────────────── */

  it('GET /:id: chưa có guide → coverage.missing = total, guideMarkdown vắng mặt (omit, không null)', async () => {
    const { root, handlers } = await setup();
    const id = await createSourceWithCatalog(root, handlers);
    const detail = response();
    await handlers.get('GET /api/figma-design-systems/:id')!({ params: { id } }, detail.res);
    expect(detail.output.body.coverage).toEqual({ total: 2, described: 1, fromGuide: 0, missing: 1 });
    expect('guideMarkdown' in detail.output.body).toBe(false);
  });

  it('GET /:id: có guide → guideMarkdown + coverage đúng row.catalog + guide (fromGuide đếm entry từ guide)', async () => {
    const { root, handlers } = await setup();
    const id = await createSourceWithCatalog(root, handlers);
    const md = renderComponentsGuideMarkdown([{ anchor: anchorFor('ABC', '1:2'), name: 'Card', description: 'Mô tả AI sinh cho Card.' }]);
    await writeFigmaDesignSystemGuide(root, id, md);
    const detail = response();
    await handlers.get('GET /api/figma-design-systems/:id')!({ params: { id } }, detail.res);
    expect(detail.output.body.guideMarkdown).toBe(md);
    expect(detail.output.body.coverage).toEqual({ total: 2, described: 2, fromGuide: 1, missing: 0 });
  });

  it('GET /:id: chưa có catalog (source mới tạo) → coverage vắng mặt', async () => {
    const { handlers } = await setup();
    const created = response();
    await handlers.get('POST /api/figma-design-systems')!({ body: { name: 'Kit', links: ['https://figma.com/design/ABC'] } }, created.res);
    const id = created.output.body.source.id;
    const detail = response();
    await handlers.get('GET /api/figma-design-systems/:id')!({ params: { id } }, detail.res);
    expect('coverage' in detail.output.body).toBe(false);
    expect('guideMarkdown' in detail.output.body).toBe(false);
  });

  /* ── 3. POST/GET job route ───────────────────────────────────────────── */

  it('POST /generate-guide: nguồn không tồn tại → 404', async () => {
    const { handlers } = await setup();
    const out = response();
    await handlers.get('POST /api/figma-design-systems/:id/generate-guide')!({ params: { id: 'nope' } }, out.res);
    expect(out.output.status).toBe(404);
  });

  it('POST /generate-guide: nguồn chưa có catalog → 409 rõ lời', async () => {
    const { handlers } = await setup();
    const created = response();
    await handlers.get('POST /api/figma-design-systems')!({ body: { name: 'Kit', links: ['https://figma.com/design/ABC'] } }, created.res);
    const id = created.output.body.source.id;
    const out = response();
    await handlers.get('POST /api/figma-design-systems/:id/generate-guide')!({ params: { id } }, out.res);
    expect(out.output.status).toBe(409);
    expect(String(out.output.body.error.message)).toMatch(/danh mục/i);
  });

  it('POST /generate-guide: có catalog nhưng chưa có token Figma → 400 rõ lời', async () => {
    const { root, handlers } = await setup();
    const id = await createSourceWithCatalog(root, handlers);
    // createSourceWithCatalog cần token để /refresh chạy được — xoá lại token
    // trước khi test đường lỗi "chưa có token" của /generate-guide.
    await writeFigmaConfig(root, { clear: true });
    const out = response();
    await handlers.get('POST /api/figma-design-systems/:id/generate-guide')!({ params: { id } }, out.res);
    expect(out.output.status).toBe(400);
    expect(String(out.output.body.error.message)).toMatch(/token/i);
  });

  it('POST /generate-guide: chống double-submit theo sourceId — job đang chạy thì lần bấm sau trả CÙNG jobId, 202', async () => {
    const { root, handlers } = await setup();
    const id = await createSourceWithCatalog(root, handlers);
    await writeFigmaConfig(root, { token: 'tok' });

    const first = response();
    await handlers.get('POST /api/figma-design-systems/:id/generate-guide')!({ params: { id } }, first.res);
    expect(first.output.status).toBe(202);
    expect(first.output.body.job.status).toMatch(/queued|running/);

    const second = response();
    await handlers.get('POST /api/figma-design-systems/:id/generate-guide')!({ params: { id } }, second.res);
    expect(second.output.status).toBe(202);
    expect(second.output.body.jobId).toBe(first.output.body.jobId);

    const jobStatus = response();
    await handlers.get('GET /api/figma-design-systems/:id/generate-guide/:jobId')!(
      { params: { id, jobId: first.output.body.jobId } },
      jobStatus.res,
    );
    expect(jobStatus.output.body.job.id).toBe(first.output.body.jobId);
  });

  it('GET /generate-guide/:jobId: job không tồn tại hoặc thuộc nguồn khác → 404', async () => {
    const { root, handlers } = await setup();
    const id = await createSourceWithCatalog(root, handlers);
    await writeFigmaConfig(root, { token: 'tok' });
    const started = response();
    await handlers.get('POST /api/figma-design-systems/:id/generate-guide')!({ params: { id } }, started.res);
    const jobId = started.output.body.jobId;

    const notFound = response();
    await handlers.get('GET /api/figma-design-systems/:id/generate-guide/:jobId')!({ params: { id, jobId: 'nope' } }, notFound.res);
    expect(notFound.output.status).toBe(404);

    const wrongSource = response();
    await handlers.get('GET /api/figma-design-systems/:id/generate-guide/:jobId')!({ params: { id: 'other-source', jobId } }, wrongSource.res);
    expect(wrongSource.output.status).toBe(404);
  });

  /* ── 4. app-context-version.ts: allowlist + file ảo + digest bất biến ─── */

  describe('app-context-version.ts', () => {
    const roots2: string[] = [];
    afterEach(async () => {
      await Promise.all(roots2.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('allowlist criteria/ nhận components-guide.md từ MỘT DS thật (designSystemDir), không chỉ nguồn dùng chung', async () => {
      const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'od-actx-guide-'));
      roots2.push(projectsDir);
      const dsDir = path.join(projectsDir, '_ds');
      await fs.promises.mkdir(path.join(dsDir, 'criteria'), { recursive: true });
      await fs.promises.writeFile(path.join(dsDir, 'criteria', 'components.md'), '# Components\n');
      await fs.promises.writeFile(path.join(dsDir, 'criteria', 'components-guide.md'), '# Guide\n');
      const result = await createAppContextVersion({
        projectsDir, appId: 'banking', appName: 'Banking', designSystemId: 'ds1', designSystemDir: dsDir,
      });
      expect(result.manifest.files.map((f) => f.path)).toContain('design-system/criteria/components-guide.md');
    });

    it('KHÔNG có guideMarkdown (option vắng mặt) → không entry ảo, digest y hệt giữa 2 lần gọi liên tiếp (unchanged)', async () => {
      const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'od-actx-guide-'));
      roots2.push(projectsDir);
      const options = {
        projectsDir, appId: 'banking', appName: 'Banking', designSystemId: null,
        figmaDesignSystemSource: { id: 'src-1', catalog: catalog() },
      };
      const first = await createAppContextVersion(options);
      const second = await createAppContextVersion(options);
      expect(first.status).toBe('created');
      expect(second.status).toBe('unchanged');
      expect(second.manifest.contentDigest).toBe(first.manifest.contentDigest);
      expect(first.manifest.files.map((f) => f.path)).not.toContain('design-system/criteria/components-guide.md');
    });

    it('có guideMarkdown → file ảo components-guide.md xuất hiện, LỌC còn đúng anchor CÒN THẬT trong catalog', async () => {
      const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'od-actx-guide-'));
      roots2.push(projectsDir);
      const guideMd = renderComponentsGuideMarkdown([
        { anchor: anchorFor('ABC', '1:2'), name: 'Card', description: 'Mô tả AI sinh cho Card.' },
        { anchor: anchorFor('ABC', '9:9'), name: 'Component đã xoá', description: 'Không còn trong catalog — phải bị lọc.' },
      ]);
      const withGuide = await createAppContextVersion({
        projectsDir, appId: 'banking', appName: 'Banking', designSystemId: null,
        figmaDesignSystemSource: { id: 'src-1', catalog: catalog(), guideMarkdown: guideMd },
      });
      expect(withGuide.manifest.files.map((f) => f.path)).toContain('design-system/criteria/components-guide.md');
      expect(appContextManifestDigestIsValid(withGuide.manifest)).toBe(true);
      const content = await readFile(path.join(
        projectsDir, 'banking', 'context', 'versions', withGuide.manifest.contextVersion, 'files',
        'design-system', 'criteria', 'components-guide.md',
      ), 'utf8');
      expect(content).toContain('Card');
      expect(content).not.toContain('Component đã xoá');
    });

    it('guideMarkdown mà lọc xong RỖNG (mọi anchor đã bị xoá khỏi catalog) → không thêm file ảo', async () => {
      const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'od-actx-guide-'));
      roots2.push(projectsDir);
      const guideMd = renderComponentsGuideMarkdown([
        { anchor: anchorFor('ABC', '9:9'), name: 'Ma', description: 'Không còn trong catalog.' },
      ]);
      const result = await createAppContextVersion({
        projectsDir, appId: 'banking', appName: 'Banking', designSystemId: null,
        figmaDesignSystemSource: { id: 'src-1', catalog: catalog(), guideMarkdown: guideMd },
      });
      expect(result.manifest.files.map((f) => f.path)).not.toContain('design-system/criteria/components-guide.md');
    });

    // Trace stageBoundAppContextForRun (do bài toán yêu cầu xác nhận): file
    // ảo 'design-system/criteria/components-guide.md' phải đáp xuống
    // '<runCwd>/criteria/components-guide.md' — CẠNH components.md — vì
    // stageBoundAppContextForRun map mọi file source==='design-system' có
    // path bắt đầu 'criteria/' THẲNG vào '<runCwd>/criteria/<phần còn lại>'
    // (không qua .app-design-system/), đúng cách dr-comp/dr-review đọc
    // './criteria/components.md'.
    it('stageBoundAppContextForRun: guide đáp xuống runCwd/criteria/components-guide.md, cạnh components.md', async () => {
      const { stageBoundAppContextForRun } = await import('../src/app-context-version.js');
      const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'od-actx-guide-stage-'));
      roots2.push(projectsDir);
      const guideMd = renderComponentsGuideMarkdown([
        { anchor: anchorFor('ABC', '1:2'), name: 'Card', description: 'Mô tả AI sinh cho Card.' },
      ]);
      const snapshot = await createAppContextVersion({
        projectsDir, appId: 'banking', appName: 'Banking', designSystemId: null,
        figmaDesignSystemSource: { id: 'src-1', catalog: catalog(), guideMarkdown: guideMd },
      });
      const binding = {
        schemaVersion: 1 as const,
        appId: 'banking',
        contextVersion: snapshot.manifest.contextVersion,
        contentDigest: snapshot.manifest.contentDigest,
        boundAt: '2026-08-19T00:00:00.000Z',
      };
      const runCwd = path.join(projectsDir, 'run');
      await fs.promises.mkdir(runCwd, { recursive: true });
      const staged = await stageBoundAppContextForRun({
        projectsDir, appId: 'banking', featureId: 'feat-1', runId: 'run-1', runCwd, binding,
      });
      expect(staged.stagedDesignSystem).toEqual(expect.arrayContaining([
        'criteria/components.md',
        'criteria/components-guide.md',
      ]));
      expect(await readFile(path.join(runCwd, 'criteria', 'components.md'), 'utf8')).toContain('Button');
      const guideAtRun = await readFile(path.join(runCwd, 'criteria', 'components-guide.md'), 'utf8');
      expect(guideAtRun).toContain('Card');
    });
  });

  /* ── 5. WP20b (review WP20 blocking) ─────────────────────────────────────
   * Kịch bản tái hiện: Feature bind contextVersion v1 lúc nguồn dùng chung
   * CHƯA có guide (binding không tự refresh); nguồn sau đó được sinh guide
   * đầy đủ; chạy lại dr-comp → nhánh sinh bù skip (stillMissing = 0) → guide
   * đã có ở kho nguồn KHÔNG BAO GIỜ tới cwd. server.ts (khối docs-comp prep,
   * nhánh `else if (localAppId)`) trước sửa chỉ ghi guide vào cwd BÊN TRONG
   * `if (stillMissing.length > 0)`; helper này là phần lọc-và-ghi được tách
   * ra để daemon gọi VÔ ĐIỀU KIỆN ngay sau staging (server.ts, xem
   * `writeFilteredComponentsGuideToCriteria` call site) — test ở mức hàm
   * thuần vì server.ts có @ts-nocheck và không export gì để import thẳng. */
  describe('WP20b: writeFilteredComponentsGuideToCriteria (fix blocking review WP20)', () => {
    const roots3: string[] = [];
    afterEach(async () => {
      await Promise.all(roots3.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('nguồn có guide đầy đủ → ghi cwd/criteria/components-guide.md dù KHÔNG có sự kiện sinh bù nào chạy', async () => {
      const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'od-wp20b-guide-'));
      roots3.push(projectsDir);
      const criteriaDir = path.join(projectsDir, 'run', 'criteria');
      await fs.promises.mkdir(criteriaDir, { recursive: true });
      const guideMd = renderComponentsGuideMarkdown([
        { anchor: anchorFor('ABC', '1:2'), name: 'Card', description: 'Mô tả AI sinh cho Card.' },
      ]);
      const result = await writeFilteredComponentsGuideToCriteria(criteriaDir, catalog(), guideMd);
      expect(result.entryCount).toBe(1);
      const written = await readFile(path.join(criteriaDir, 'components-guide.md'), 'utf8');
      expect(written).toContain('Card');
    });

    it('lọc entry: anchor không còn trong catalog (component đã bị xoá khỏi Figma) bị loại', async () => {
      const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'od-wp20b-guide-'));
      roots3.push(projectsDir);
      const criteriaDir = path.join(projectsDir, 'run', 'criteria');
      await fs.promises.mkdir(criteriaDir, { recursive: true });
      const guideMd = renderComponentsGuideMarkdown([
        { anchor: anchorFor('ABC', '1:2'), name: 'Card', description: 'Còn thật.' },
        { anchor: anchorFor('ABC', '9:9'), name: 'Ma', description: 'Không còn trong catalog.' },
      ]);
      const result = await writeFilteredComponentsGuideToCriteria(criteriaDir, catalog(), guideMd);
      expect(result.entryCount).toBe(1);
      const written = await readFile(path.join(criteriaDir, 'components-guide.md'), 'utf8');
      expect(written).toContain('Card');
      expect(written).not.toContain('Ma');
    });

    it('nguồn KHÔNG có guide (null) + cwd có file rác cũ (từ lần bind trước) → bị xoá', async () => {
      const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'od-wp20b-guide-'));
      roots3.push(projectsDir);
      const criteriaDir = path.join(projectsDir, 'run', 'criteria');
      await fs.promises.mkdir(criteriaDir, { recursive: true });
      const staleTarget = path.join(criteriaDir, 'components-guide.md');
      await fs.promises.writeFile(staleTarget, '# guide cũ từ lần bind trước\n', 'utf8');
      const result = await writeFilteredComponentsGuideToCriteria(criteriaDir, catalog(), null);
      expect(result.entryCount).toBe(0);
      await expect(fs.promises.access(staleTarget)).rejects.toThrow();
    });

    it('lọc xong rỗng (mọi anchor trong guide đã bị xoá khỏi catalog) → không tạo file, xoá bản cũ nếu có', async () => {
      const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'od-wp20b-guide-'));
      roots3.push(projectsDir);
      const criteriaDir = path.join(projectsDir, 'run', 'criteria');
      await fs.promises.mkdir(criteriaDir, { recursive: true });
      const staleTarget = path.join(criteriaDir, 'components-guide.md');
      await fs.promises.writeFile(staleTarget, '# guide cũ\n', 'utf8');
      const guideMd = renderComponentsGuideMarkdown([
        { anchor: anchorFor('ABC', '9:9'), name: 'Ma', description: 'Không còn trong catalog.' },
      ]);
      const result = await writeFilteredComponentsGuideToCriteria(criteriaDir, catalog(), guideMd);
      expect(result.entryCount).toBe(0);
      await expect(fs.promises.access(staleTarget)).rejects.toThrow();
    });
  });

  /* ── 6. WP21a: GET /components — API JSON có cấu trúc ────────────────────
   * Người dùng duyệt (2026-08-20): preview markdown 564 comp không dùng
   * được. `catalog3()` (3 component, khác `catalog()` ở trên) phủ đủ 3
   * nguồn mô tả: 'figma' (Button), 'ai' (Card — guide có), 'none' (Badge —
   * cả hai đều không). */
  describe('WP21a: GET /components — API JSON có cấu trúc (contract mục 1)', () => {
    const catalog3 = (): FigmaComponentCatalogSnapshot => ({
      schemaVersion: FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION,
      generatedAt: '2026-08-19T00:00:00.000Z',
      files: [{
        fileKey: 'ABC',
        name: 'Core UI',
        url: 'https://www.figma.com/design/ABC',
        components: [
          { nodeId: '1:1', name: 'Button', description: 'Nút bấm.', page: 'Actions', properties: [{ name: 'variant', type: 'VARIANT', values: ['primary', 'ghost'] }] },
          { nodeId: '1:2', name: 'Card', properties: [] },
          { nodeId: '1:3', name: 'Badge', properties: [] },
        ],
      }],
    });

    it('buildFigmaDesignSystemComponentItems: 3 nguồn mô tả đúng (figma/ai/none), thứ tự snapshot giữ nguyên, verbatim KHÔNG hậu tố', () => {
      const guideMd = renderComponentsGuideMarkdown([
        { anchor: anchorFor('ABC', '1:2'), name: 'Card', description: 'Mô tả AI sinh cho Card.' },
      ]);
      const items = buildFigmaDesignSystemComponentItems(catalog3(), guideMd);
      expect(items.map((i) => i.name)).toEqual(['Button', 'Card', 'Badge']); // đúng thứ tự snapshot
      expect(items[0]).toMatchObject({
        anchor: anchorFor('ABC', '1:1'), nodeId: '1:1', fileKey: 'ABC', fileName: 'Core UI',
        page: 'Actions', description: 'Nút bấm.', descriptionSource: 'figma',
        properties: [{ name: 'variant', type: 'VARIANT', values: ['primary', 'ghost'] }],
      });
      expect(items[1]).toMatchObject({ description: 'Mô tả AI sinh cho Card.', descriptionSource: 'ai' });
      expect('page' in items[1]!).toBe(false); // Card không có page trong snapshot → omit, không undefined
      expect(items[2]).toMatchObject({ descriptionSource: 'none' });
      expect('description' in items[2]!).toBe(false); // 'none' → omit description, không chuỗi rỗng
    });

    it('buildFigmaDesignSystemComponentItems: Figma LUÔN thắng guide (component đã có mô tả Figma thì bỏ qua guide)', () => {
      const guideMd = renderComponentsGuideMarkdown([
        { anchor: anchorFor('ABC', '1:1'), name: 'Button', description: 'Mô tả AI khác — KHÔNG được dùng vì Figma đã có.' },
      ]);
      const items = buildFigmaDesignSystemComponentItems(catalog3(), guideMd);
      expect(items[0]!.description).toBe('Nút bấm.');
      expect(items[0]!.descriptionSource).toBe('figma');
    });

    it('GET /components: nguồn không tồn tại → 404', async () => {
      const { handlers } = await setup();
      const out = response();
      await handlers.get('GET /api/figma-design-systems/:id/components')!({ params: { id: 'nope' } }, out.res);
      expect(out.output.status).toBe(404);
    });

    it('GET /components: nguồn chưa có catalog → 409 CATALOG_REQUIRED', async () => {
      const { handlers } = await setup();
      const created = response();
      await handlers.get('POST /api/figma-design-systems')!({ body: { name: 'Kit', links: ['https://figma.com/design/ABC'] } }, created.res);
      const id = created.output.body.source.id;
      const out = response();
      await handlers.get('GET /api/figma-design-systems/:id/components')!({ params: { id } }, out.res);
      expect(out.output.status).toBe(409);
      expect(out.output.body.error.code).toBe('CATALOG_REQUIRED');
    });

    it('GET /components: 200 với components[] đúng contract, giữ nguyên thứ tự snapshot', async () => {
      const { root, handlers } = await setup(vi.fn(async () => catalog3()));
      const id = await createSourceWithCatalog(root, handlers);
      const out = response();
      await handlers.get('GET /api/figma-design-systems/:id/components')!({ params: { id } }, out.res);
      expect(out.output.status).toBe(200);
      expect(out.output.body.components.map((c: { name: string }) => c.name)).toEqual(['Button', 'Card', 'Badge']);
      expect(out.output.body.components[0].descriptionSource).toBe('figma');
      expect(out.output.body.components[2].descriptionSource).toBe('none');
    });
  });

  /* ── 7. WP21a: generateComponentDescriptions — onItemStatus + fan-out ────
   * Test hàm MỚI (deps.onItemStatus, deps.cap: null, deps.concurrency) — đọc
   * `.tmp/pipeline/wp21-contract.md` mục 2 cho đúng chuỗi trạng thái. */
  describe('WP21a: generateComponentDescriptions — onItemStatus + fan-out theo nhóm trang', () => {
    const roots4: string[] = [];

    const snapshotOf = (components: Array<{ nodeId: string; name: string; page?: string; description?: string }>): FigmaComponentCatalogSnapshot => ({
      schemaVersion: FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION,
      generatedAt: '2026-08-19T00:00:00.000Z',
      files: [{
        fileKey: 'ABC',
        name: 'Kit',
        url: 'https://www.figma.com/design/ABC',
        components: components.map((c) => ({
          nodeId: c.nodeId, name: c.name,
          ...(c.page ? { page: c.page } : {}),
          ...(c.description ? { description: c.description } : {}),
          properties: [],
        })),
      }],
    });

    afterEach(async () => {
      await Promise.all(roots4.splice(0).map((r) => rm(r, { recursive: true, force: true })));
    });

    async function makeBaseDir(): Promise<string> {
      const root = await mkdtemp(path.join(tmpdir(), 'od-figma-ds-onitemstatus-'));
      roots4.push(root);
      return root;
    }

    it('happy path: chuỗi trạng thái đúng queued→running→succeeded cho comp được accept', async () => {
      const baseDir = await makeBaseDir();
      const snapshot = snapshotOf([{ nodeId: '1:1', name: 'Card' }]);
      const anchor = anchorFor('ABC', '1:1');
      const events: Array<[string, string, string | undefined]> = [];
      const deps: GuideGenerationDeps = {
        baseDir,
        fetchTree: async () => new Map(),
        fetchImages: async () => new Map(),
        downloadImage: async () => false,
        runAgentChunk: async (input) => JSON.stringify([{ anchor: input.components[0]!.anchor, description: 'Thẻ hiển thị nội dung.' }]),
        onItemStatus: (a, status, reason) => { events.push([a, status, reason]); },
      };
      const result = await generateComponentDescriptions(snapshot, null, deps);
      expect(result.generated).toBe(1);
      expect(events).toEqual([
        [anchor, 'queued', undefined],
        [anchor, 'running', undefined],
        [anchor, 'succeeded', undefined],
      ]);
    });

    it('happy path: comp bị validate từ chối → chuỗi kết ở failed kèm đúng reason validate', async () => {
      const baseDir = await makeBaseDir();
      const snapshot = snapshotOf([{ nodeId: '1:1', name: 'Card' }]);
      const anchor = anchorFor('ABC', '1:1');
      const events: Array<[string, string, string | undefined]> = [];
      const deps: GuideGenerationDeps = {
        baseDir,
        fetchTree: async () => new Map(),
        fetchImages: async () => new Map(),
        downloadImage: async () => false,
        // description trùng nguyên văn tên component → validateDescribeOutput reject.
        runAgentChunk: async (input) => JSON.stringify([{ anchor: input.components[0]!.anchor, description: 'card' }]),
        onItemStatus: (a, status, reason) => { events.push([a, status, reason]); },
      };
      const result = await generateComponentDescriptions(snapshot, null, deps);
      expect(result.generated).toBe(0);
      expect(result.rejected).toBe(1);
      expect(events).toEqual([
        [anchor, 'queued', undefined],
        [anchor, 'running', undefined],
        [anchor, 'failed', 'description trùng nguyên văn tên component (không nói gì thêm)'],
      ]);
    });

    it('chunk agent lỗi (runAgentChunk throw) → CẢ chunk failed reason "agent lỗi: <msg>", KHÔNG throw ra ngoài khi vẫn còn chunk khác thành công', async () => {
      const baseDir = await makeBaseDir();
      // 13 component → 2 chunk (12 + 1); chunk đầu lỗi, chunk sau thành công —
      // job vẫn KHÔNG throw vì có ≥1 chunk thành công.
      const items = Array.from({ length: 13 }, (_, i) => ({ nodeId: `1:${i}`, name: `Comp${i}` }));
      const snapshot = snapshotOf(items);
      const events: Array<[string, string, string | undefined]> = [];
      let call = 0;
      const deps: GuideGenerationDeps = {
        baseDir,
        fetchTree: async () => new Map(),
        fetchImages: async () => new Map(),
        downloadImage: async () => false,
        runAgentChunk: async (input) => {
          call += 1;
          if (call === 1) throw new Error('agent timeout');
          return JSON.stringify(input.components.map((c) => ({ anchor: c.anchor, description: `Mô tả cho ${c.name}.` })));
        },
        onItemStatus: (a, status, reason) => { events.push([a, status, reason]); },
      };
      const result = await generateComponentDescriptions(snapshot, null, deps);
      expect(result.generated).toBe(1); // chunk 2 chỉ có comp thứ 13 (index 12)
      const firstChunkAnchors = items.slice(0, 12).map((c) => anchorFor('ABC', c.nodeId));
      for (const anchor of firstChunkAnchors) {
        expect(events).toContainEqual([anchor, 'failed', 'agent lỗi: agent timeout']);
      }
      const lastAnchor = anchorFor('ABC', '1:12');
      expect(events).toContainEqual([lastAnchor, 'succeeded', undefined]);
    });

    it('hồi quy: không truyền onItemStatus → generateComponentDescriptions kết quả y hệt (test cũ pass nguyên trạng)', async () => {
      const baseDirA = await makeBaseDir();
      const baseDirB = await makeBaseDir();
      const snapshot = snapshotOf([{ nodeId: '1:1', name: 'Card' }]);
      const depsBase = {
        fetchTree: async () => new Map<string, unknown>(),
        fetchImages: async () => new Map<string, string>(),
        downloadImage: async () => false,
        runAgentChunk: async (input: { components: { anchor: string }[] }) =>
          JSON.stringify([{ anchor: input.components[0]!.anchor, description: 'Thẻ hiển thị nội dung.' }]),
      };
      const withoutCallback = await generateComponentDescriptions(snapshot, null, { ...depsBase, baseDir: baseDirA } as GuideGenerationDeps);
      const withCallback = await generateComponentDescriptions(snapshot, null, {
        ...depsBase,
        baseDir: baseDirB,
        onItemStatus: () => {},
      } as GuideGenerationDeps);
      expect(withCallback.guideMarkdown).toBe(withoutCallback.guideMarkdown);
      expect(withCallback.generated).toBe(withoutCallback.generated);
      expect(withCallback.rejected).toBe(withoutCallback.rejected);
      expect(withCallback.remaining).toBe(withoutCallback.remaining);
      expect(withCallback.chunkErrors).toEqual(withoutCallback.chunkErrors);
    });

    it('cap=null: sinh HẾT toàn bộ comp thiếu trong một lượt, không cap 60 (remaining = 0)', async () => {
      const baseDir = await makeBaseDir();
      const items = Array.from({ length: 70 }, (_, i) => ({ nodeId: `1:${i}`, name: `Comp${i}` }));
      const snapshot = snapshotOf(items);
      const deps: GuideGenerationDeps = {
        baseDir,
        cap: null,
        fetchTree: async () => new Map(),
        fetchImages: async () => new Map(),
        downloadImage: async () => false,
        runAgentChunk: async (input) => JSON.stringify(input.components.map((c) => ({ anchor: c.anchor, description: `Mô tả cho ${c.name}.` }))),
      };
      const result = await generateComponentDescriptions(snapshot, null, deps);
      expect(result.generated).toBe(70);
      expect(result.remaining).toBe(0);
    });

    it('concurrency=3 + cap=null: fan-out theo NHÓM TRANG — tối đa 3 nhóm chạy đồng thời, nhóm lỗi KHÔNG chặn nhóm khác, merge không mất entry', async () => {
      const baseDir = await makeBaseDir();
      const snapshot = snapshotOf([
        { nodeId: '1:1', name: 'A1', page: 'A' },
        { nodeId: '1:2', name: 'B1', page: 'B' },
        { nodeId: '1:3', name: 'C1', page: 'C' },
        { nodeId: '1:4', name: 'D1', page: 'D' },
      ]);
      let active = 0;
      let maxActive = 0;
      const deps: GuideGenerationDeps = {
        baseDir,
        cap: null,
        concurrency: 3,
        fetchTree: async () => new Map(),
        fetchImages: async () => new Map(),
        downloadImage: async () => false,
        runAgentChunk: async (input, _chunkDir, _index, group) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active -= 1;
          if (group.page === 'B') throw new Error('agent nhóm B hỏng');
          return JSON.stringify(input.components.map((c) => ({ anchor: c.anchor, description: `Mô tả cho nhóm ${group.page}.` })));
        },
      };
      const result = await generateComponentDescriptions(snapshot, null, deps);
      expect(maxActive).toBeGreaterThan(1); // thật sự chạy song song, không tuần tự
      expect(maxActive).toBeLessThanOrEqual(3); // tôn trọng concurrency cap
      const map = parseComponentsGuide(result.guideMarkdown);
      expect(map.get(anchorFor('ABC', '1:1'))?.description).toBe('Mô tả cho nhóm A.');
      expect(map.get(anchorFor('ABC', '1:3'))?.description).toBe('Mô tả cho nhóm C.');
      expect(map.get(anchorFor('ABC', '1:4'))?.description).toBe('Mô tả cho nhóm D.');
      expect(map.has(anchorFor('ABC', '1:2'))).toBe(false); // nhóm B lỗi — không có mô tả
      expect(result.generated).toBe(3); // A, C, D — nhóm B lỗi không chặn 3 nhóm còn lại
      expect(result.chunkErrors.some((e) => e.includes('agent nhóm B hỏng'))).toBe(true);
    });

    /* ── WP21-fix điểm 1 (review WP21a): grouping theo page CHỈ khi
     * concurrency > 1 — đường prep dr-comp (server.ts) không truyền
     * concurrency nên phải giữ đúng cách chunk cũ (span qua page) để không
     * rải 60 comp thành nhiều lượt agent hơn cần thiết trong timeout 8'. */
    it('WP21-fix điểm 1: không truyền concurrency (mặc định 1) — chunk 12 span qua page, KHÔNG nhóm theo page', async () => {
      const baseDir = await makeBaseDir();
      const snapshot = snapshotOf([
        ...Array.from({ length: 7 }, (_, i) => ({ nodeId: `1:${i}`, name: `A${i}`, page: 'A' })),
        ...Array.from({ length: 5 }, (_, i) => ({ nodeId: `2:${i}`, name: `B${i}`, page: 'B' })),
      ]);
      let calls = 0;
      let lastInputLen = 0;
      const deps: GuideGenerationDeps = {
        baseDir,
        fetchTree: async () => new Map(),
        fetchImages: async () => new Map(),
        downloadImage: async () => false,
        runAgentChunk: async (input) => {
          calls += 1;
          lastInputLen = input.components.length;
          return JSON.stringify(input.components.map((c) => ({ anchor: c.anchor, description: `Mô tả cho ${c.name}.` })));
        },
      };
      const result = await generateComponentDescriptions(snapshot, null, deps);
      expect(calls).toBe(1); // 1 lượt duy nhất — span qua cả 2 page
      expect(lastInputLen).toBe(12);
      expect(result.generated).toBe(12);
    });

    it('WP21-fix điểm 1: concurrency=3 — nhóm theo page, 2 lượt riêng (7 + 5)', async () => {
      const baseDir = await makeBaseDir();
      const snapshot = snapshotOf([
        ...Array.from({ length: 7 }, (_, i) => ({ nodeId: `1:${i}`, name: `A${i}`, page: 'A' })),
        ...Array.from({ length: 5 }, (_, i) => ({ nodeId: `2:${i}`, name: `B${i}`, page: 'B' })),
      ]);
      let calls = 0;
      const chunkSizes: number[] = [];
      const deps: GuideGenerationDeps = {
        baseDir,
        concurrency: 3,
        fetchTree: async () => new Map(),
        fetchImages: async () => new Map(),
        downloadImage: async () => false,
        runAgentChunk: async (input) => {
          calls += 1;
          chunkSizes.push(input.components.length);
          return JSON.stringify(input.components.map((c) => ({ anchor: c.anchor, description: `Mô tả cho ${c.name}.` })));
        },
      };
      const result = await generateComponentDescriptions(snapshot, null, deps);
      expect(calls).toBe(2); // 2 nhóm trang — mỗi nhóm 1 lượt (7 và 5, cả hai < chunkSize 12)
      expect(chunkSizes.sort((a, b) => a - b)).toEqual([5, 7]);
      expect(result.generated).toBe(12);
    });
  });

  /* ── 8. WP21a: components-guide.meta.json — persist lượt gần nhất ────────
   * Contract mục 3: ghi atomic khi job kết thúc, GET detail đọc best-effort. */
  describe('WP21a: components-guide.meta.json — ghi/đọc atomic, GET detail có lastGuideRun', () => {
    const roots5: string[] = [];
    afterEach(async () => {
      await Promise.all(roots5.splice(0).map((r) => rm(r, { recursive: true, force: true })));
    });

    it('figmaDesignSystemGuideMetaPath: cạnh components-guide.md, dưới criteria/', () => {
      const p = figmaDesignSystemGuideMetaPath('/data', 'src-1');
      expect(p).toBe(path.join('/data', 'figma-design-systems', 'src-1', 'criteria', 'components-guide.meta.json'));
    });

    it('readFigmaDesignSystemGuideMeta: null khi chưa từng ghi (best-effort, không throw)', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'od-figma-ds-meta-'));
      roots5.push(root);
      expect(await readFigmaDesignSystemGuideMeta(root, 'src-1')).toBeNull();
    });

    it('readFigmaDesignSystemGuideMeta: JSON hỏng → null (best-effort, không throw)', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'od-figma-ds-meta-'));
      roots5.push(root);
      const target = figmaDesignSystemGuideMetaPath(root, 'src-1');
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, '{ không phải JSON hợp lệ', 'utf8');
      expect(await readFigmaDesignSystemGuideMeta(root, 'src-1')).toBeNull();
    });

    it('write/read roundtrip atomic — không để lại .tmp', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'od-figma-ds-meta-'));
      roots5.push(root);
      const meta = {
        finishedAt: '2026-08-20T00:00:00.000Z',
        generated: 2,
        failed: 1,
        failures: [{ anchor: 'figma-abc', name: 'Card', reason: 'agent lỗi: timeout' }],
      };
      await writeFigmaDesignSystemGuideMeta(root, 'src-1', meta);
      expect(await readFigmaDesignSystemGuideMeta(root, 'src-1')).toEqual(meta);
      const dir = path.dirname(figmaDesignSystemGuideMetaPath(root, 'src-1'));
      const names = await fs.promises.readdir(dir);
      expect(names).toEqual(['components-guide.meta.json']);
    });

    it('GET /:id: có meta đã ghi → lastGuideRun xuất hiện đúng nội dung; chưa ghi → vắng mặt (omit)', async () => {
      const { root, handlers } = await setup();
      const id = await createSourceWithCatalog(root, handlers);

      const beforeMeta = response();
      await handlers.get('GET /api/figma-design-systems/:id')!({ params: { id } }, beforeMeta.res);
      expect('lastGuideRun' in beforeMeta.output.body).toBe(false);

      const meta = { finishedAt: '2026-08-20T00:00:00.000Z', generated: 1, failed: 1, failures: [{ anchor: 'figma-x', name: 'X', reason: 'lỗi' }] };
      await writeFigmaDesignSystemGuideMeta(root, id, meta);

      const afterMeta = response();
      await handlers.get('GET /api/figma-design-systems/:id')!({ params: { id } }, afterMeta.res);
      expect(afterMeta.output.body.lastGuideRun).toEqual(meta);
    });

    /* WP21-fix điểm 2 (review WP21a): job kết thúc SỚM (missing = 0, nhánh
     * "Không có gì để sinh" — generateComponentDescriptions còn chưa được
     * gọi, job.items vẫn rỗng) KHÔNG được ghi đè components-guide.meta.json
     * bằng zeros — xoá mất lastGuideRun có ý nghĩa của lượt sinh THẬT trước
     * đó. */
    it('job kết thúc sớm (missing=0, "Không có gì để sinh") KHÔNG ghi đè meta cũ có ý nghĩa', async () => {
      const { root, handlers } = await setup();
      const id = await createSourceWithCatalog(root, handlers); // Button có mô tả Figma, Card thiếu
      await writeFigmaConfig(root, { token: 'tok' });
      // Card cũng đã có mô tả trong guide kho nguồn → missingList rỗng khi job chạy.
      const guideMd = renderComponentsGuideMarkdown([{ anchor: anchorFor('ABC', '1:2'), name: 'Card', description: 'Đã có mô tả từ trước.' }]);
      await writeFigmaDesignSystemGuide(root, id, guideMd);
      const oldMeta = { finishedAt: '2026-08-18T00:00:00.000Z', generated: 9, failed: 0, failures: [] };
      await writeFigmaDesignSystemGuideMeta(root, id, oldMeta);

      const started = response();
      await handlers.get('POST /api/figma-design-systems/:id/generate-guide')!({ params: { id } }, started.res);
      expect(started.output.status).toBe(202);
      const jobId = started.output.body.jobId;

      let job = started.output.body.job;
      for (let i = 0; i < 100 && job.status !== 'succeeded' && job.status !== 'failed'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const poll = response();
        await handlers.get('GET /api/figma-design-systems/:id/generate-guide/:jobId')!({ params: { id, jobId } }, poll.res);
        job = poll.output.body.job;
      }
      expect(job.status).toBe('succeeded');
      expect(job.message).toMatch(/Không có gì để sinh/);

      expect(await readFigmaDesignSystemGuideMeta(root, id)).toEqual(oldMeta);
    });
  });

  /* ── 9. WP21a: job route end-to-end — items[]/remainingAfterCap từ callback
   * thật, lastGuideRun sau khi job thật kết thúc. ĐẶT CUỐI FILE: test này
   * override implementation MẶC ĐỊNH của `runDescribeChunk` (mock module-level
   * ở đầu file, "không bao giờ resolve") để job chạy XONG thay vì kẹt ở
   * 'running' — vitest chạy test trong file THEO THỨ TỰ khai báo và
   * `vi.clearAllMocks()` (afterEach) KHÔNG xoá `mockImplementation` đã set,
   * nên đặt ở cuối để không ảnh hưởng các test double-submit ở mục 3 (dựa
   * vào hành vi "không bao giờ resolve" mặc định). */
  describe('WP21a: job route end-to-end — items[] + remainingAfterCap + lastGuideRun', () => {
    it('job chạy xong thật (mock runDescribeChunk trả JSON hợp lệ) → items[] có succeeded, remainingAfterCap=0, GET detail có lastGuideRun', async () => {
      const { root, handlers } = await setup();
      const id = await createSourceWithCatalog(root, handlers); // catalog(): Button có mô tả Figma, Card chưa có mô tả
      await writeFigmaConfig(root, { token: 'tok' });

      vi.mocked(runDescribeChunk).mockImplementation(async (_deps: unknown, opts: any) => {
        const inputRaw = await fs.promises.readFile(path.join(opts.chunkDir, `input-${opts.index}.json`), 'utf8');
        const input = JSON.parse(inputRaw) as { components: { anchor: string; name: string }[] };
        return JSON.stringify(input.components.map((c) => ({ anchor: c.anchor, description: `Mô tả AI cho ${c.name}.` })));
      });

      const started = response();
      await handlers.get('POST /api/figma-design-systems/:id/generate-guide')!({ params: { id } }, started.res);
      expect(started.output.status).toBe(202);
      const jobId = started.output.body.jobId;

      // Chỉ có MỘT comp thiếu mô tả (Card) → job xong rất nhanh; poll ngắn,
      // tất định thay vì sleep cố định (tránh flake trên máy chậm).
      let job = started.output.body.job;
      for (let i = 0; i < 100 && job.status !== 'succeeded' && job.status !== 'failed'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const poll = response();
        await handlers.get('GET /api/figma-design-systems/:id/generate-guide/:jobId')!({ params: { id, jobId } }, poll.res);
        job = poll.output.body.job;
      }
      expect(job.status).toBe('succeeded');
      const cardAnchor = anchorFor('ABC', '1:2');
      expect(job.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ anchor: cardAnchor, name: 'Card', status: 'succeeded' }),
      ]));
      expect(job.remainingAfterCap).toBe(0);

      const detail = response();
      await handlers.get('GET /api/figma-design-systems/:id')!({ params: { id } }, detail.res);
      expect(detail.output.body.lastGuideRun).toBeTruthy();
      expect(detail.output.body.lastGuideRun.generated).toBe(1);
      expect(detail.output.body.lastGuideRun.failed).toBe(0);
    });
  });

  /* ── 10. WP21-fix điểm 3 (review WP21a) — agent hallucinate anchor ngoài
   * batch: onItemStatus KHÔNG được bắn cho anchor lạ đó, nên job.items/
   * meta.failures không có item ma name=''. ĐẶT CUỐI FILE (như mục 9) vì
   * cũng override `runDescribeChunk` — giữ nguyên hành vi "không bao giờ
   * resolve" mặc định cho các test double-submit ở mục 3. */
  describe('WP21-fix điểm 3: agent hallucinate anchor ngoài batch — không tạo item ma', () => {
    it('runDescribeChunk trả anchor không thuộc batch → job.items không có item name rỗng/anchor lạ, comp thật vẫn được đánh failed', async () => {
      const { root, handlers } = await setup();
      const id = await createSourceWithCatalog(root, handlers); // catalog(): Button có mô tả Figma, Card chưa có mô tả

      await writeFigmaConfig(root, { token: 'tok' });

      vi.mocked(runDescribeChunk).mockImplementation(async () => {
        // Agent KHÔNG nhắc tới anchor thật (Card) — chỉ bịa một anchor lạ.
        return JSON.stringify([{ anchor: 'figma-hallucinated-anchor', description: 'Mô tả bịa cho anchor không tồn tại.' }]);
      });

      const started = response();
      await handlers.get('POST /api/figma-design-systems/:id/generate-guide')!({ params: { id } }, started.res);
      expect(started.output.status).toBe(202);
      const jobId = started.output.body.jobId;

      let job = started.output.body.job;
      for (let i = 0; i < 100 && job.status !== 'succeeded' && job.status !== 'failed'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const poll = response();
        await handlers.get('GET /api/figma-design-systems/:id/generate-guide/:jobId')!({ params: { id, jobId } }, poll.res);
        job = poll.output.body.job;
      }
      expect(job.status).toBe('succeeded');
      expect(job.items.some((item: { name: string }) => item.name === '')).toBe(false);
      expect(job.items.some((item: { anchor: string }) => item.anchor === 'figma-hallucinated-anchor')).toBe(false);
      const cardAnchor = anchorFor('ABC', '1:2');
      expect(job.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ anchor: cardAnchor, name: 'Card', status: 'failed' }),
      ]));

      const detail = response();
      await handlers.get('GET /api/figma-design-systems/:id')!({ params: { id } }, detail.res);
      expect(detail.output.body.lastGuideRun.failures.some((f: { name: string }) => f.name === '')).toBe(false);
    });
  });
});
