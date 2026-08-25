// Docs-only gate (2026-08 product decision — see pipelines.ts's header comment
// and `computeActive`'s docblock): the by-STEP dependency chain that used to
// gate a pipeline's `active` flag ("this stage's dependsOn chain must all be
// `succeeded`") is GONE. The only prerequisite left is "does this workflow's
// ingest stage (the def with `inputKind: source`) have a document" — read
// straight off `outputs`/files, never off an intermediate stage's run status.
//
// Part 1 tests the new pure primitive, `docsReadyFromFiles`, directly.
// Part 2 tests the gate functions (`computeActive`, `missingDependencies` via
// `validateRunStageSelection`) with hand-built state — the shape
// `pipeline-routes.ts`'s `loadMergedState` produces once it has folded
// `docsReadyFromFiles` in (see Part 3 for that wiring itself).
// Part 3 exercises the real HTTP route (`GET /api/pipelines`) with a project
// that has REAL local files and NO run history at all, proving the file →
// route → gate wiring end to end (not just the pure functions in isolation).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PipelineView, ProjectPipelineState } from '@open-design/contracts';

import { closeDatabase, insertProject, openDatabase } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';
import {
  WORKFLOWS,
  computeActive,
  docsReadyFromFiles,
  getPipelineDef,
  validateRunStageSelection,
} from '../src/pipelines.js';

// Registry trung tâm không cần mạng trong test này.
vi.mock('../src/kg-sync/remote-registry.js', () => ({
  loadRemoteProjects: async () => [],
}));

function def(id: string) {
  const d = getPipelineDef(id);
  assert.ok(d, `pipeline ${id} should exist in the registry`);
  return d;
}

// docs-to-ui's own ordered stage list — same source pipelines.test.ts uses.
const UI_IDS = WORKFLOWS.find((w) => w.id === 'docs-to-ui')!.pipelineIds;

function succeededState(...ids: string[]): ProjectPipelineState {
  return Object.fromEntries(ids.map((id) => [id, { status: 'succeeded' as const }]));
}

// ── Part 1: docsReadyFromFiles (pure) ───────────────────────────────────────

describe('docsReadyFromFiles', () => {
  it('không có file nào → false', () => {
    assert.equal(docsReadyFromFiles([], 'docs-to-ui'), false);
    assert.equal(docsReadyFromFiles(['docs-to-ui/ux/spec.json'], 'docs-to-ui'), false);
  });

  it('một file dưới output của bước ingest (docs) → true, dù wfDir vắng mặt', () => {
    assert.equal(docsReadyFromFiles(['docs-to-ui/docs-feature/x.md'], 'docs-to-ui'), true);
    assert.equal(docsReadyFromFiles(['docs-to-ui/docs-feature/x.md'], null), true);
  });

  it('CASE 5 — file thuộc workflow KHÁC (docs-review) không làm docs-to-ui sẵn sàng', () => {
    assert.equal(docsReadyFromFiles(['docs-review/docs-feature/x.md'], 'docs-to-ui'), false);
  });

  it('CASE 6 — genericity: docs-review dùng dr-docs, docs-to-prd dùng prd-docs, không hardcode', () => {
    // dr-docs outputs ['docs/', 'docs-feature/'] — scoped to the docs-review dir.
    assert.equal(docsReadyFromFiles(['docs-review/docs/confluence/x.md'], 'docs-review'), true);
    assert.equal(docsReadyFromFiles(['docs-review/docs-feature/x.md'], 'docs-review'), true);
    // prd-docs outputs mirror docs' own — scoped to the docs-to-prd dir.
    assert.equal(docsReadyFromFiles(['docs-to-prd/docs/confluence/x.md'], 'docs-to-prd'), true);
    // Cross-workflow leak stays blocked for these two as well.
    assert.equal(docsReadyFromFiles(['docs-to-prd/docs/confluence/x.md'], 'docs-review'), false);
    assert.equal(docsReadyFromFiles(['docs-review/docs/confluence/x.md'], 'docs-to-prd'), false);
  });
});

// ── Part 2: gate functions on hand-built state ──────────────────────────────
// `state` here is exactly the shape `pipeline-routes.ts`'s `loadMergedState`
// produces once `docsReadyFromFiles` has folded a workflow's ingest stage in
// (`{ <ingestId>: { status: 'succeeded' } }`) — see Part 3 for that wiring.

describe('computeActive / validateRunStageSelection — docs-only gate', () => {
  it('CASE 1 — chưa có file tài liệu nào: ux KHÔNG active, docs VẪN active', () => {
    assert.equal(computeActive({}, def('docs')), true);
    assert.equal(computeActive({}, def('ux')), false);
    assert.equal(computeActive({}, def('ui-html')), false);
  });

  it('CASE 2 — docs sẵn sàng: ux, ui-html, ui-react đều active dù cj/ux-research/ux-review chưa từng chạy', () => {
    const state = succeededState('docs'); // KHÔNG có cj/ux-research/ux/ux-review.
    assert.equal(computeActive(state, def('cj')), true);
    assert.equal(computeActive(state, def('ux-research')), true);
    assert.equal(computeActive(state, def('ux')), true);
    assert.equal(computeActive(state, def('ux-review')), true);
    assert.equal(computeActive(state, def('ui-html')), true);
    assert.equal(computeActive(state, def('ui-react')), true);
    assert.equal(computeActive(state, def('ui-react-ds')), true);
  });

  it('CASE 3 — ca thật của người dùng: chọn [docs, docs-map, ux, ui-html, ui-react, ui-react-ds], chỉ docs succeeded, có file tài liệu → ok: true', () => {
    const stageIds = ['docs', 'docs-map', 'ux', 'ui-html', 'ui-react', 'ui-react-ds'];
    const state = succeededState('docs'); // docs-map/ux/ui-html/… CHƯA chạy.
    assert.deepEqual(validateRunStageSelection(stageIds, UI_IDS, state), { ok: true });
  });

  it('CASE 4 — chọn [ux] khi CHƯA có tài liệu → ok: false, bước thiếu là bước INGEST (docs), không phải docs-map/ux-research', () => {
    const res = validateRunStageSelection(['ux'], UI_IDS, {});
    assert.equal(res.ok, false);
    if (res.ok) throw new Error('unreachable');
    // Trỏ đích danh về bước ingest ("Tài liệu (nạp)") — KHÔNG còn nêu tên một
    // bước trung gian (docs-map: "Bản đồ hệ thống", ux-research: "UX Research").
    assert.match(res.error, /Tài liệu \(nạp\)/);
    assert.doesNotMatch(res.error, /Bản đồ hệ thống/);
    assert.doesNotMatch(res.error, /UX Research/);
    // Không còn câu "cần bước X chạy xong trước" của mô hình cũ.
    assert.doesNotMatch(res.error, /chạy xong trước/);
  });

  it('CASE 5 (mức hàm thuần) — state của docs-review (dr-docs succeeded) không mở khoá ux của docs-to-ui', () => {
    // dr-docs và docs là hai id KHÁC NHAU trong cùng registry — trạng thái của
    // workflow này không bao giờ chạm tới workflow kia qua `state`.
    const state = succeededState('dr-docs');
    assert.equal(computeActive(state, def('ux')), false);
  });

  it('CASE 6 (mức hàm thuần) — dr-docs mở khoá dr-comp/dr-flow của docs-review, prd-docs mở khoá prd-cj của docs-to-prd', () => {
    assert.equal(computeActive(succeededState('dr-docs'), def('dr-comp')), true);
    assert.equal(computeActive(succeededState('dr-docs'), def('dr-flow')), true);
    assert.equal(computeActive(succeededState('dr-docs'), def('dr-review')), true);
    assert.equal(computeActive(succeededState('prd-docs'), def('prd-cj')), true);
    assert.equal(computeActive(succeededState('prd-docs'), def('prd-ux-research')), true);
    assert.equal(computeActive(succeededState('prd-docs'), def('prd-review')), true);
    // Chưa có state nào cho docs-to-prd/docs-review thì các bước đó vẫn khoá.
    assert.equal(computeActive({}, def('dr-comp')), false);
    assert.equal(computeActive({}, def('prd-cj')), false);
  });
});

// ── Part 3: HTTP wiring — GET /api/pipelines with REAL local files, NO run history ──

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

function viewOf(views: PipelineView[], id: string): PipelineView {
  const v = views.find((x) => x.id === id);
  assert.ok(v, `view ${id} should be present`);
  return v;
}

describe('GET /api/pipelines — docs-only gate reads REAL local files, not run status', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;

  function setUp(localOutputs: string[]) {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-docs-only-gate-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const app = makeApp();
    registerPipelineRoutes(app as any, {
      db,
      pipelines: { localOutputs: async () => localOutputs },
      paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    } as any);
    handlers = app.handlers;
  }

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function insertKgsProject(id: string) {
    const now = Date.now();
    insertProject(db, {
      id,
      name: id,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'pipeline' }, // Không có runAllConfig / không có run nào từng chạy.
      createdAt: now,
      updatedAt: now,
    });
  }

  async function getPipelines(projectId: string, workflowId: string) {
    const handler = handlers.get('GET /api/pipelines');
    expect(handler, 'route should be registered').toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ query: { projectId, workflowId } }, res);
    return out;
  }

  it('CASE 2 — docs-to-ui/docs-feature/x.md tồn tại, KHÔNG có run nào → ux/ui-html/ui-react active, cj vẫn "idle"', async () => {
    setUp(['docs-to-ui/docs-feature/x.md']);
    insertKgsProject('PRJ_FILES_ONLY');

    const out = await getPipelines('PRJ_FILES_ONLY', 'docs-to-ui');
    expect(out.status).toBe(200);
    const views = out.body.pipelines as PipelineView[];
    expect(viewOf(views, 'docs').active).toBe(true);
    expect(viewOf(views, 'ux').active).toBe(true);
    expect(viewOf(views, 'ui-html').active).toBe(true);
    expect(viewOf(views, 'ui-react').active).toBe(true);
    // cj/ux-research/ux-review chưa từng chạy — status vẫn "idle", chỉ active
    // (mở khoá) đổi, không phải status (đã xong).
    expect(viewOf(views, 'cj').status).toBe('idle');
    expect(viewOf(views, 'ux-research').status).toBe('idle');
    expect(viewOf(views, 'ux-review').status).toBe('idle');
  });

  it('CASE 5 — chỉ có file của docs-review, hỏi trạng thái docs-to-ui → ux KHÔNG active', async () => {
    setUp(['docs-review/docs-feature/x.md']);
    insertKgsProject('PRJ_WRONG_WORKFLOW');

    const out = await getPipelines('PRJ_WRONG_WORKFLOW', 'docs-to-ui');
    const views = out.body.pipelines as PipelineView[];
    expect(viewOf(views, 'docs').active).toBe(true); // bước ingest luôn active.
    expect(viewOf(views, 'docs').status).toBe('idle'); // nhưng chưa "xong": không có file CỦA NÓ.
    expect(viewOf(views, 'ux').active).toBe(false);
    expect(viewOf(views, 'ui-html').active).toBe(false);
  });

  it('không có file, không có run nào → mọi bước sau ingest đều khoá', async () => {
    setUp([]);
    insertKgsProject('PRJ_EMPTY');

    const out = await getPipelines('PRJ_EMPTY', 'docs-to-ui');
    const views = out.body.pipelines as PipelineView[];
    expect(viewOf(views, 'docs').active).toBe(true);
    expect(viewOf(views, 'docs-map').active).toBe(false);
    expect(viewOf(views, 'ux').active).toBe(false);
    expect(viewOf(views, 'ui-html').active).toBe(false);
  });
});

test('mode/explicitSelection không còn ảnh hưởng computeActive (tham số giữ trong chữ ký, hết tác dụng)', () => {
  const state = succeededState('docs');
  const uxDef = def('ux');
  assert.equal(computeActive(state, uxDef), computeActive(state, uxDef, 'lean'));
  assert.equal(computeActive(state, uxDef, 'full'), computeActive(state, uxDef, 'full', ['ux-review']));
  assert.equal(computeActive({}, uxDef, 'lean'), computeActive({}, uxDef, 'full'));
});
