// GET /api/pipelines/projects — mảng `workflows`: trạng thái của TỪNG workflow
// trên một feature.
//
// Lý do route phải trả mảng này: `done/total/running` ở cấp project chỉ nói về
// MỘT workflow (cái của query, mặc định workflow đầu tiên), nên một feature
// đang chạy workflow khác vẫn đọc thành "Chưa chạy". Test canh đúng chỗ đó:
// hai workflow có state khác nhau thì mỗi phần tử phải đếm theo state của
// CHÍNH nó, và cờ lean chỉ được ảnh hưởng workflow có stage lean-skip.
//
// Cùng cách dựng như tests/pipeline-apps-routes.test.ts: gọi thẳng handler mà
// registerPipelineRoutes đăng ký (fake express app ghi lại handler theo
// "METHOD path") trên một DB SQLite tạm, `loadRemoteProjects` mock để registry
// trung tâm không cần mạng.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, insertProject, openDatabase } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';
import { WORKFLOWS, getPipelineDef } from '../src/pipelines.js';

// Số stage KHÔNG held của một workflow — mẫu số `total` thật sự (2026-08 hold:
// countWorkflowProgress bỏ 3 terminal UI-Spec khỏi mẫu số, xem HELD_STAGE_IDS
// trong pipelines.ts). docs-to-prd/docs-review không có stage held nên không
// đổi; chỉ docs-to-ui rút từ 9 xuống 6.
const nonHeldCount = (ids: readonly string[]) => ids.filter((id) => !getPipelineDef(id)?.heldFromRun).length;

vi.mock('../src/kg-sync/remote-registry.js', () => ({
  loadRemoteProjects: async () => {
    throw new Error('stores unreachable');
  },
}));

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

describe('GET /api/pipelines/projects — workflows[]', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-pipeline-wf-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const app = makeApp();
    registerPipelineRoutes(app as any, {
      db,
      pipelines: { localOutputs: async () => [] },
      paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    } as any);
    handlers = app.handlers;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function listProjects(query: Record<string, unknown> = {}) {
    const handler = handlers.get('GET /api/pipelines/projects');
    expect(handler, 'GET /api/pipelines/projects should be registered').toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ body: {}, params: {}, query }, res);
    return out;
  }

  // Feature (project pipeline) mang sẵn trạng thái chạy trong metadata.pipelines
  // — chính là chỗ getProjectPipelineState đọc.
  function insertFeature(
    id: string,
    pipelines: Record<string, { status: string }>,
    extraMetadata: Record<string, unknown> = {},
  ) {
    const now = Date.now();
    insertProject(db, {
      id,
      name: id,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'pipeline', pipelines, ...extraMetadata },
      createdAt: now,
      updatedAt: now,
    });
  }

  const wfById = (body: any, id: string) =>
    (body.projects[0].workflows as any[]).find((w) => w.id === id);

  it('trả một phần tử cho MỌI workflow trong registry, đúng id + tên', async () => {
    insertFeature('checkout', {});
    const listed = await listProjects();
    expect(listed.body.projects).toHaveLength(1);
    expect(listed.body.projects[0].workflows.map((w: any) => w.id)).toEqual(
      WORKFLOWS.map((w) => w.id),
    );
    expect(listed.body.projects[0].workflows.map((w: any) => w.name)).toEqual(
      WORKFLOWS.map((w) => w.name),
    );
    // Chưa chạy gì: mọi workflow 0 done / 0 running, total = số stage KHÔNG
    // held của nó (docs-to-ui: 9 - 3 terminal held = 6; các workflow khác
    // không có stage held nên không đổi).
    for (const w of listed.body.projects[0].workflows) {
      expect({ done: w.done, running: w.running }).toEqual({ done: 0, running: 0 });
      expect(w.total).toBe(nonHeldCount(WORKFLOWS.find((x) => x.id === w.id)!.pipelineIds));
    }
  });

  it('đếm riêng cho từng workflow khi state của chúng khác nhau', async () => {
    // docs-review đang chạy dở (1 xong, 1 đang chạy trên tổng 3 stage) trong khi docs-to-ui —
    // workflow mặc định mà badge tổng đọc — chưa chạy gì.
    insertFeature('checkout', {
      'dr-docs': { status: 'succeeded' },
      'dr-review': { status: 'running' },
      'prd-docs': { status: 'succeeded' },
      'prd-cj': { status: 'queued' },
    });
    const listed = await listProjects();
    const p = listed.body.projects[0];

    expect(wfById(listed.body, 'docs-review')).toMatchObject({ done: 1, total: 4, running: 1 });
    expect(wfById(listed.body, 'docs-to-prd')).toMatchObject({ done: 1, total: 4, running: 1 });
    expect(wfById(listed.body, 'docs-to-ui')).toMatchObject({ done: 0, running: 0 });

    // Field cũ GIỮ NGUYÊN ngữ nghĩa: theo workflow của query (mặc định
    // docs-to-ui) — đúng cái không thấy được workflow khác đang chạy.
    expect({ done: p.done, running: p.running }).toEqual({ done: 0, running: 0 });
    expect(wfById(listed.body, 'docs-to-ui')).toMatchObject({ done: p.done, total: p.total, running: p.running });
  });

  it('workflowId của query chỉ đổi field cũ, mảng workflows vẫn đủ mọi workflow', async () => {
    insertFeature('checkout', { 'dr-docs': { status: 'succeeded' } });
    const listed = await listProjects({ workflowId: 'docs-review' });
    const p = listed.body.projects[0];
    expect({ done: p.done, total: p.total, running: p.running }).toEqual({ done: 1, total: 4, running: 0 });
    expect(p.workflows.map((w: any) => w.id)).toEqual(WORKFLOWS.map((w) => w.id));
    expect(wfById(listed.body, 'docs-to-ui').done).toBe(0);
  });

  it('mode lean chỉ rút total của workflow có stage lean-skip', async () => {
    insertFeature('checkout', {}, { runAllConfig: { lean: true } });
    const listed = await listProjects();
    const uiWf = WORKFLOWS.find((w) => w.id === 'docs-to-ui')!;
    // 3 stage phân tích (cj / ux-research / ux-review) bị bỏ khỏi chuỗi lean,
    // CỘNG THÊM 3 terminal UI-Spec đang held (2026-08 hold) luôn bị bỏ khỏi
    // mẫu số bất kể mode — 9 - 3 - 3 = 3.
    expect(wfById(listed.body, 'docs-to-ui').total).toBe(nonHeldCount(uiWf.pipelineIds) - 3);
    // lean là khái niệm riêng của docs-to-ui — hai workflow còn lại không đổi.
    expect(wfById(listed.body, 'docs-to-prd').total).toBe(4);
    expect(wfById(listed.body, 'docs-review').total).toBe(4);
  });

  it('trả runningStage (bước running/queued đầu tiên + tên + startedAt) cho workflow của query', async () => {
    // docs-review: dr-docs xong, dr-review đang chạy → runningStage là dr-review.
    insertFeature('checkout', {
      'dr-docs': { status: 'succeeded' },
      'dr-review': { status: 'running' },
    });
    const listed = await listProjects({ workflowId: 'docs-review' });
    const p = listed.body.projects[0];
    expect(p.runningStage).toBeTruthy();
    expect(p.runningStage.id).toBe('dr-review');
    // tên hiển thị từ registry, không phải raw id.
    expect(typeof p.runningStage.name).toBe('string');
    expect(p.runningStage.name.length).toBeGreaterThan(0);
    // startedAt lấy từ updatedAt của state (insertFeature không set nên có thể
    // vắng — field optional): nếu có thì phải là số.
    if (p.runningStage.startedAt !== undefined) {
      expect(typeof p.runningStage.startedAt).toBe('number');
    }
  });

  it('không có runningStage khi workflow của query không có bước nào đang chạy', async () => {
    // docs-review chạy dở nhưng query workflow mặc định (docs-to-ui) — nó chưa chạy.
    insertFeature('checkout', { 'dr-review': { status: 'running' } });
    const listed = await listProjects();
    expect(listed.body.projects[0].runningStage).toBeUndefined();
  });
});
