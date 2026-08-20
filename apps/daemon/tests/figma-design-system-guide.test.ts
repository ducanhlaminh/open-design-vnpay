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
import { renderComponentsGuideMarkdown } from '../src/figma-component-guide.js';
import {
  figmaDesignSystemGuidePath,
  readFigmaDesignSystemGuide,
  registerFigmaDesignSystemRoutes,
  writeFigmaDesignSystemGuide,
  writeFilteredComponentsGuideToCriteria,
} from '../src/figma-design-system-routes.js';
import {
  appContextManifestDigestIsValid,
  createAppContextVersion,
} from '../src/app-context-version.js';

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
});
