// Bug NGƯỜI DÙNG BÁO: đã cấu hình tập bước để chạy (bỏ cj/ux-research/ux-review),
// nhưng thẻ "UX Spec" trên UI vẫn khoá, đòi "UX Research" chạy xong. CÙNG GỐC
// với bug đã sửa ở CỔNG CHẠY (`validateRunStageSelection`/`missingDependencies`
// đọc lựa chọn tường minh qua `explicitSelectionDependsOn`, xem
// `tests/pipeline-run-all-lean-gate.test.ts`), nhưng người tiêu thụ khác: phần
// tính TRẠNG THÁI HIỂN THỊ (`listPipelineStatus` → `computeActive` →
// `GET /api/pipelines`) chỉ biết MODE, không biết `runAllConfig.stageIds`.
//
// Lô này dạy CỔNG HIỂN THỊ dùng LẠI `explicitSelectionDependsOn` (không viết
// luật thứ hai) và dạy route lọc `stageIds` theo workflow đang mở trước khi
// dùng. Phần 1 kiểm các hàm THUẦN trong `pipelines.ts` trực tiếp (lớp rẻ nhất
// còn thấy triệu chứng); phần 2 kiểm hai route HTTP nơi lựa chọn đã lưu phải
// được đọc/lọc: `GET /api/pipelines` và cổng chạy-một-bước
// `POST /api/pipelines/:id/run`.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PipelineView, ProjectPipelineState } from '@open-design/contracts';

import { closeDatabase, insertProject, openDatabase, setProjectPipelineStatus } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';
import { computeActive, getPipelineDef, listPipelineStatus } from '../src/pipelines.js';

// Registry trung tâm không cần mạng trong test này.
vi.mock('../src/kg-sync/remote-registry.js', () => ({
  loadRemoteProjects: async () => [],
}));

// Cấu hình THẬT của người dùng báo bug (workflow docs-to-ui):
// lean: false, nhưng stageIds đúng bằng tập lean (bỏ cj/ux-research/ux-review).
const REPORTED_STAGE_IDS = ['docs', 'docs-map', 'ux', 'ui-html', 'ui-react', 'ui-react-ds'];

function viewOf(views: PipelineView[], id: string): PipelineView {
  const v = views.find((x) => x.id === id);
  assert.ok(v, `view ${id} should be present`);
  return v;
}

// ── Phần 1: hàm thuần trong pipelines.ts ────────────────────────────────────

test('listPipelineStatus: ux active:true khi được chọn tường minh + docs-map đã xong (ca đang hỏng)', () => {
  const state: ProjectPipelineState = {
    docs: { status: 'succeeded' },
    'docs-map': { status: 'succeeded' },
  };
  const views = listPipelineStatus(state, undefined, 'full', REPORTED_STAGE_IDS);
  assert.equal(viewOf(views, 'ux').active, true);
});

test('listPipelineStatus: ux-research và cj bị bỏ khỏi lựa chọn → skipped:true', () => {
  const state: ProjectPipelineState = {
    docs: { status: 'succeeded' },
    'docs-map': { status: 'succeeded' },
  };
  const views = listPipelineStatus(state, undefined, 'full', REPORTED_STAGE_IDS);
  assert.equal(viewOf(views, 'ux-research').skipped, true);
  assert.equal(viewOf(views, 'cj').skipped, true);
});

test('listPipelineStatus: ux-review skipped:true; ui-html KHÔNG bị khoá vì ux-review', () => {
  const state: ProjectPipelineState = {
    docs: { status: 'succeeded' },
    'docs-map': { status: 'succeeded' },
    ux: { status: 'succeeded' },
  };
  const views = listPipelineStatus(state, undefined, 'full', REPORTED_STAGE_IDS);
  assert.equal(viewOf(views, 'ux-review').skipped, true);
  // ux đã succeeded và được chọn; ux-review bị bỏ nhưng KHÔNG mang cờ gate cho
  // ui-html — phụ thuộc của ui-html rơi xuống chính phụ thuộc của ux-review (ux).
  assert.equal(viewOf(views, 'ui-html').active, true);
});

test('listPipelineStatus: ux vẫn active:true khi docs-map CHƯA succeeded (2026-08 docs-only gate: chỉ tài liệu — docs — mới gate, docs-map không còn gate gì)', () => {
  const state: ProjectPipelineState = {
    docs: { status: 'succeeded' },
    // docs-map: chưa chạy — dưới docs-only gate điều đó không còn khoá gì cả,
    // vì gate duy nhất còn lại là "bước ingest (docs) đã succeeded".
  };
  const views = listPipelineStatus(state, undefined, 'full', REPORTED_STAGE_IDS);
  assert.equal(viewOf(views, 'ux').active, true);
});

test('listPipelineStatus: không truyền lựa chọn (undefined) → active vẫn theo docs-only gate (mode full không còn tự khoá ux vào ux-research)', () => {
  const state: ProjectPipelineState = {
    docs: { status: 'succeeded' },
    'docs-map': { status: 'succeeded' },
  };
  const withoutParam = listPipelineStatus(state, undefined, 'full');
  const withUndefined = listPipelineStatus(state, undefined, 'full', undefined);
  const withEmpty = listPipelineStatus(state, undefined, 'full', []);
  assert.deepEqual(withUndefined, withoutParam);
  assert.deepEqual(withEmpty, withoutParam);
  // 2026-08 docs-only gate: docs đã succeeded nên `ux` active, bất kể mode và
  // bất kể ux-research chưa từng chạy.
  assert.equal(viewOf(withoutParam, 'ux').active, true);
  assert.equal(viewOf(withoutParam, 'ux-research').skipped, undefined);
});

test('listPipelineStatus: không truyền lựa chọn (undefined) → giống hệt trước khi sửa, mode lean', () => {
  const state: ProjectPipelineState = {
    docs: { status: 'succeeded' },
    'docs-map': { status: 'succeeded' },
  };
  const withoutParam = listPipelineStatus(state, undefined, 'lean');
  const withUndefined = listPipelineStatus(state, undefined, 'lean', undefined);
  assert.deepEqual(withUndefined, withoutParam);
  // lean tự bỏ cj/ux-research/ux-review qua effectiveDependsOn — không cần lựa
  // chọn tường minh, ux đã active vì mode một mình đủ để suy ra gate.
  assert.equal(viewOf(withoutParam, 'ux').active, true);
});

test('computeActive: vắng explicitSelection → vẫn theo docs-only gate (docs succeeded là đủ, explicitSelection không còn ảnh hưởng)', () => {
  const state: ProjectPipelineState = {
    docs: { status: 'succeeded' },
    'docs-map': { status: 'succeeded' },
  };
  const uxDef = getPipelineDef('ux')!;
  assert.equal(computeActive(state, uxDef, 'full'), true);
  assert.equal(computeActive(state, uxDef, 'full', undefined), true);
  assert.equal(computeActive(state, uxDef, 'full', []), true);
});

test('computeActive: explicitSelection không rỗng → dùng explicitSelectionDependsOn (cổng hiển thị khớp cổng chạy)', () => {
  const state: ProjectPipelineState = {
    docs: { status: 'succeeded' },
    'docs-map': { status: 'succeeded' },
  };
  const uxDef = getPipelineDef('ux')!;
  assert.equal(computeActive(state, uxDef, 'full', REPORTED_STAGE_IDS), true);
});

// ── Phần 2: HTTP — GET /api/pipelines + POST /api/pipelines/:id/run ────────
// Gọi thẳng handler mà registerPipelineRoutes đăng ký (fake express app ghi
// lại handler theo "METHOD path", như tests/pipeline-run-all-lean-gate.test.ts)
// trên một DB SQLite tạm, nên không cần bind socket.

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

describe('GET /api/pipelines + POST /api/pipelines/:id/run — honor runAllConfig.stageIds', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;
  let runPipeline: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-pipeline-status-selection-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const app = makeApp();
    runPipeline = vi.fn(async () => ({ completion: Promise.resolve(), runId: 'run-1' }));
    registerPipelineRoutes(app as any, {
      db,
      pipelines: { localOutputs: async () => [], runPipeline },
      paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    } as any);
    handlers = app.handlers;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function getPipelines(projectId: string) {
    const handler = handlers.get('GET /api/pipelines');
    expect(handler, 'route should be registered').toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ query: { projectId, workflowId: 'docs-to-ui' } }, res);
    return out;
  }

  async function postRun(pipelineId: string, projectId: string) {
    const handler = handlers.get('POST /api/pipelines/:id/run');
    expect(handler, 'route should be registered').toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ params: { id: pipelineId }, body: { projectId }, query: {} }, res);
    return out;
  }

  function insertKgsProject(id: string, runAllConfig?: Record<string, unknown>) {
    const now = Date.now();
    insertProject(db, {
      id,
      name: id,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'pipeline', ...(runAllConfig ? { runAllConfig } : {}) },
      createdAt: now,
      updatedAt: now,
    });
  }

  it('cấu hình thật của người dùng: lean:false + stageIds đúng tập lean → ux active, cj/ux-research/ux-review skipped', async () => {
    insertKgsProject('PRJ_REPORTED', { lean: false, stageIds: REPORTED_STAGE_IDS });
    setProjectPipelineStatus(db, 'PRJ_REPORTED', 'docs', { status: 'succeeded' });
    setProjectPipelineStatus(db, 'PRJ_REPORTED', 'docs-map', { status: 'succeeded' });

    const out = await getPipelines('PRJ_REPORTED');
    expect(out.status).toBe(200);
    const views = out.body.pipelines as PipelineView[];
    expect(viewOf(views, 'ux').active).toBe(true);
    expect(viewOf(views, 'cj').skipped).toBe(true);
    expect(viewOf(views, 'ux-research').skipped).toBe(true);
    expect(viewOf(views, 'ux-review').skipped).toBe(true);
  });

  it('thẻ đã mở khoá (active:true) trên GET → bấm chạy KHÔNG bị 409 (computeActive dùng cùng lựa chọn)', async () => {
    insertKgsProject('PRJ_RUN', { lean: false, stageIds: REPORTED_STAGE_IDS });
    setProjectPipelineStatus(db, 'PRJ_RUN', 'docs', { status: 'succeeded' });
    setProjectPipelineStatus(db, 'PRJ_RUN', 'docs-map', { status: 'succeeded' });

    const list = await getPipelines('PRJ_RUN');
    expect(viewOf(list.body.pipelines, 'ux').active).toBe(true);

    const out = await postRun('ux', 'PRJ_RUN');
    expect(out.status).not.toBe(409);
    expect(out.status).toBe(202);
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it('stageIds chứa id của workflow khác (docs-to-prd) → bị lọc, không làm hỏng kết quả docs-to-ui', async () => {
    insertKgsProject('PRJ_MIXED', {
      lean: false,
      stageIds: [...REPORTED_STAGE_IDS, 'prd-docs', 'prd-cj', 'prd-ux-research'],
    });
    setProjectPipelineStatus(db, 'PRJ_MIXED', 'docs', { status: 'succeeded' });
    setProjectPipelineStatus(db, 'PRJ_MIXED', 'docs-map', { status: 'succeeded' });

    const out = await getPipelines('PRJ_MIXED');
    const views = out.body.pipelines as PipelineView[];
    expect(viewOf(views, 'ux').active).toBe(true);
    expect(viewOf(views, 'cj').skipped).toBe(true);
    expect(viewOf(views, 'ux-research').skipped).toBe(true);
  });

  it('stageIds TOÀN BỘ thuộc workflow khác → lọc xong rỗng → rơi về nhánh mode, nhưng active giờ đến từ docs-only gate chứ không phải mode (KHÔNG hiểu là "không chạy bước nào")', async () => {
    insertKgsProject('PRJ_EMPTY_AFTER_FILTER', {
      lean: false,
      stageIds: ['prd-docs', 'prd-cj', 'prd-ux-research'],
    });
    setProjectPipelineStatus(db, 'PRJ_EMPTY_AFTER_FILTER', 'docs', { status: 'succeeded' });
    setProjectPipelineStatus(db, 'PRJ_EMPTY_AFTER_FILTER', 'docs-map', { status: 'succeeded' });

    const out = await getPipelines('PRJ_EMPTY_AFTER_FILTER');
    const views = out.body.pipelines as PipelineView[];
    // Lọc rỗng rơi về nhánh mode như cũ (không hiểu nhầm thành "không chạy bước
    // nào") — nhưng 2026-08 docs-only gate không còn đọc mode/lựa chọn để tính
    // `active`: docs đã succeeded nên ux vẫn active:true, và KHÔNG skip oan các
    // bước không hề bị chọn ra.
    expect(viewOf(views, 'ux').active).toBe(true);
    expect(viewOf(views, 'ux-research').skipped).toBe(undefined);
    expect(viewOf(views, 'cj').skipped).toBe(undefined);
  });
});
