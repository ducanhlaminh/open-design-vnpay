// WP docs-review-screen-platform (2026-08-28) — "Nền tảng màn hình" của
// docs-review do NGƯỜI DÙNG chọn ở rightPanel (mobile | web | both), KHÔNG
// default, KHÔNG đoán từ tài liệu:
//   (1) runAllConfigFromBody (qua PUT run-config + POST run-all): nhận đúng 3
//       giá trị, giá trị lạ bỏ qua, run-all KHÔNG điền default và GIỮ giá trị
//       đã lưu khi request không nhắc tới;
//   (2) POST /api/pipelines/dr-flow/run thiếu cấu hình → 409, status KHÔNG đổi (tránh error-reports),
//       runPipeline KHÔNG được gọi; có cấu hình → gọi; directive kickoff
//       (screenPlatformDirective) đúng câu theo phạm vi;
//   (3) finalizeScreenFlowXml: phạm vi mobile điền `platform` thiếu, từ chối
//       platform lệch / thư mục `--web`; both giữ luật cũ + flow rỗng bỏ qua;
//   (4) prepareScreenComponentInputs: phạm vi web → mọi hint web dù md có
//       "bottom sheet"; both + màn thiếu platform → throw thông điệp;
//   (5) applyScreenOverrides: thêm màn ở phạm vi both thiếu platform → warning
//       + bỏ; phạm vi đơn → platform = phạm vi.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';

import { closeDatabase, getProject, getProjectPipelineState, insertProject, openDatabase } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';
import { SCREEN_PLATFORM_MISSING_MSG, getPipelineDef, listPipelineStatus, screenPlatformScopeFor, WORKFLOWS } from '../src/pipelines.js';
import { screenPlatformDirective } from '../src/pipeline-kickoffs.js';
import { SCREEN_FLOW_CELLS_FILE, SCREEN_FLOW_ID, finalizeScreenFlowXml } from '../src/flow-ux/screen-flow-xml.js';
import { assertScreensHavePlatform, prepareScreenComponentInputs, resolveInputPlatform, type ScreenInput } from '../src/screen-components.js';
import { applyScreenOverrides, parseScreensOverrides } from '../src/screen-overrides.js';

vi.mock('../src/kg-sync/remote-registry.js', () => ({
  loadRemoteProjects: async () => [],
}));

// ── Fake express app (khuôn tests/pipeline-stage-held.test.ts) ─────────────
type Handler = (req: any, res: any) => unknown;
function makeApp() {
  const handlers = new Map<string, Handler>();
  const record = (method: string) => (routePath: string, handler: Handler) => {
    handlers.set(`${method} ${routePath}`, handler);
  };
  return { get: record('GET'), post: record('POST'), put: record('PUT'), delete: record('DELETE'), patch: record('PATCH'), use: () => {}, handlers };
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

describe('stage flag: dr-flow / dr-comp / dr-mockup acceptsScreenPlatform', () => {
  it('def + PipelineView đều mang acceptsScreenPlatform; các stage khác không', () => {
    for (const id of ['dr-flow', 'dr-comp', 'dr-mockup']) assert.equal(getPipelineDef(id)?.acceptsScreenPlatform, true, id);
    for (const id of ['dr-docs', 'dr-review', 'ux', 'docs']) assert.equal(getPipelineDef(id)?.acceptsScreenPlatform, undefined, id);
    const wf = WORKFLOWS.find((w) => w.id === 'docs-review')!;
    const views = listPipelineStatus({}, wf.pipelineIds);
    const byId = new Map(views.map((v) => [v.id, v]));
    assert.equal(byId.get('dr-flow')?.acceptsScreenPlatform, true);
    assert.equal(byId.get('dr-mockup')?.acceptsScreenPlatform, true);
    assert.equal(byId.get('dr-docs')?.acceptsScreenPlatform, undefined);
  });
});

describe('routes: run-config / run-all / run (fail-fast)', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;
  let runPipeline: ReturnType<typeof vi.fn>;
  let runWorkflowAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-screen-platform-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const app = makeApp();
    runPipeline = vi.fn(async () => ({ completion: Promise.resolve('succeeded'), conversationId: 'c1' }));
    runWorkflowAll = vi.fn(async (projectId: string, opts: { stageIds?: string[] }) => ({ workflowId: 'docs-review', projectId, stages: opts.stageIds ?? [] }));
    registerPipelineRoutes(app as any, {
      db,
      // dr-docs của docs-review đã có tài liệu → dr-flow "active" (docs-only gate).
      pipelines: { localOutputs: async () => ['docs-review/docs/confluence/a.md'], runPipeline, runWorkflowAll },
      paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    } as any);
    handlers = app.handlers;
  });
  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

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
  async function call(key: string, req: Record<string, unknown>) {
    const handler = handlers.get(key);
    expect(handler, `${key} should be registered`).toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ params: {}, query: {}, ...req }, res);
    return out;
  }
  const putConfig = (id: string, body: Record<string, unknown>) => call('PUT /api/pipelines/projects/:id/run-config', { params: { id }, body });
  const postRunAll = (body: Record<string, unknown>) => call('POST /api/pipelines/run-all', { body });
  const postRun = (pipelineId: string, projectId: string) => call('POST /api/pipelines/:id/run', { params: { id: pipelineId }, body: { projectId } });

  it('PUT run-config nhận mobile/web/both, bỏ qua giá trị lạ, không tự điền', async () => {
    insertKgsProject('P1');
    let out = await putConfig('P1', { screenPlatform: 'mobile' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(screenPlatformScopeFor(getProject(db, 'P1')), 'mobile');
    out = await putConfig('P1', { screenPlatform: 'both' });
    assert.equal(screenPlatformScopeFor(getProject(db, 'P1')), 'both');
    // Giá trị lạ → bỏ qua, giữ giá trị cũ.
    out = await putConfig('P1', { screenPlatform: 'desktop' });
    assert.equal(out.status, 200);
    assert.equal(screenPlatformScopeFor(getProject(db, 'P1')), 'both');
    // Patch không nhắc tới → giữ nguyên.
    await putConfig('P1', { designSystemId: null });
    assert.equal(screenPlatformScopeFor(getProject(db, 'P1')), 'both');
    // Project chưa từng chọn → undefined (không default).
    insertKgsProject('P2');
    await putConfig('P2', { designSystemId: null });
    assert.equal(screenPlatformScopeFor(getProject(db, 'P2')), undefined);
  });

  it('POST run-all: KHÔNG điền default; request có → ghi; request không nhắc → GIỮ giá trị đã lưu (full-replace không xoá)', async () => {
    insertKgsProject('P3');
    let out = await postRunAll({ projectId: 'P3', workflowId: 'docs-review', confluencePages: [{ id: '1', url: 'https://wiki/x' }] });
    assert.equal(out.status, 202, JSON.stringify(out.body));
    assert.equal(screenPlatformScopeFor(getProject(db, 'P3')), undefined, 'run-all không được tự điền screenPlatform');
    out = await postRunAll({ projectId: 'P3', workflowId: 'docs-review', screenPlatform: 'web', confluencePages: [{ id: '1', url: 'https://wiki/x' }] });
    assert.equal(out.status, 202);
    assert.equal(screenPlatformScopeFor(getProject(db, 'P3')), 'web');
    out = await postRunAll({ projectId: 'P3', workflowId: 'docs-review', confluencePages: [{ id: '1', url: 'https://wiki/x' }] });
    assert.equal(out.status, 202);
    assert.equal(screenPlatformScopeFor(getProject(db, 'P3')), 'web', 'run-all full-replace phải giữ screenPlatform đã lưu');
    // Cấu hình khác của run-all vẫn được ghi như cũ.
    const rac = (getProject(db, 'P3')!.metadata as any).runAllConfig;
    assert.deepEqual(rac.confluencePages, [{ id: '1', url: 'https://wiki/x' }]);
  });

  it('POST /api/pipelines/dr-flow/run thiếu Nền tảng màn hình → 409 SCREEN_PLATFORM_MISSING, status KHÔNG failed, runPipeline KHÔNG gọi', async () => {
    insertKgsProject('P4');
    const out = await postRun('dr-flow', 'P4');
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.code, 'SCREEN_PLATFORM_MISSING');
    assert.equal(out.body.error, SCREEN_PLATFORM_MISSING_MSG);
    assert.match(out.body.error, /Chưa chọn Nền tảng màn hình/);
    expect(runPipeline).not.toHaveBeenCalled();
    const st = getProjectPipelineState(db, 'P4')['dr-flow'];
    // Không đánh dấu failed: stage chưa chạy; 'failed' sẽ kích hoạt error-reports.
    assert.notEqual(st?.status, 'failed');
    assert.notEqual(st?.error, SCREEN_PLATFORM_MISSING_MSG);
  });

  it('POST /api/pipelines/dr-flow/run có cấu hình → 202 và gọi runPipeline; stage không cần (dr-docs) không bị chặn', async () => {
    insertKgsProject('P5', { screenPlatform: 'mobile' });
    let out = await postRun('dr-flow', 'P5');
    assert.equal(out.status, 202, JSON.stringify(out.body));
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline.mock.calls[0]![1]).toBe('dr-flow');
    insertKgsProject('P6');
    out = await postRun('dr-docs', 'P6');
    assert.notEqual(out.status, 409, JSON.stringify(out.body));
  });
});

describe('kickoff: screenPlatformDirective — đúng 1 trong 3 câu', () => {
  test('mobile', () => {
    const d = screenPlatformDirective('mobile');
    assert.match(d, /\*\*MOBILE APP\*\*/);
    assert.match(d, /`platform: "app"` cho MỌI màn/);
    assert.match(d, /chỉ MỘT thư mục `flows\/SCREEN-FLOW\/`/);
    assert.match(d, /ngoài phạm vi nền tảng \(Mobile app\)/);
    assert.match(d, /KHÔNG tự suy nền tảng từ tài liệu/);
    assert.doesNotMatch(d, /WEBSITE|CẢ HAI/);
  });
  test('web', () => {
    const d = screenPlatformDirective('web');
    assert.match(d, /\*\*WEBSITE\*\*/);
    assert.match(d, /`platform: "web"` cho MỌI màn/);
    assert.match(d, /ngoài phạm vi nền tảng \(Website\)/);
    assert.doesNotMatch(d, /MOBILE APP|CẢ HAI/);
  });
  test('both', () => {
    const d = screenPlatformDirective('both');
    assert.match(d, /\*\*CẢ HAI\*\*/);
    assert.match(d, /`flows\/SCREEN-FLOW--app\/` \+ `flows\/SCREEN-FLOW--web\/`/);
    assert.match(d, /`screens: \[\]`/);
    assert.match(d, /KHÔNG bịa màn/);
  });
});

// ── (3) finalizeScreenFlowXml theo phạm vi ─────────────────────────────────
const vertex = (id: string, label: string, x: number, y: number, w = 200, h = 60) =>
  `<mxCell id="${id}" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">\n` +
  `  <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" />\n` +
  `</mxCell>`;
const edge = (id: string, from: string, to: string, label: string, anchors = 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;') =>
  `<mxCell id="${id}" value="${label}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;${anchors}" edge="1" parent="1" source="${from}" target="${to}">\n` +
  `  <mxGeometry relative="1" as="geometry" />\n` +
  `</mxCell>`;
const fragment = (p: string) =>
  [
    vertex(`od-${p}-start`, 'Bắt đầu', 40, 40, 150, 50),
    vertex(`od-${p}-1`, 'X1 · Hỗ trợ trực tuyến', 40, 200),
    vertex(`od-${p}-2`, 'X2 · Quản lý yêu cầu', 340, 200),
    edge(`od-${p}-e1`, `od-${p}-start`, `od-${p}-1`, 'Mở', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;'),
    edge(`od-${p}-e2`, `od-${p}-1`, `od-${p}-2`, 'Xem yêu cầu'),
  ].join('\n');
const CR_MD = ['# CR', '', '## 2.2 Màn hình MB', '', '### Hỗ trợ trực tuyến (MB)', '', 'Mở bottom sheet chọn lý do.', '', '### Quản lý yêu cầu (MB)', '', '## 2.3 Màn hình IB', '', '### Hỗ trợ trực tuyến (IB)', ''].join('\n');
const SRC = 'docs-feature/cr.md';
function mkcwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-sps-'));
  fs.mkdirSync(path.join(cwd, 'docs-feature'), { recursive: true });
  fs.writeFileSync(path.join(cwd, SRC), CR_MD);
  return cwd;
}
function writeFlow(cwd: string, id: string, cells: string | null, screens: unknown): void {
  const dir = path.join(cwd, 'flows', id);
  fs.mkdirSync(dir, { recursive: true });
  if (cells != null) fs.writeFileSync(path.join(dir, SCREEN_FLOW_CELLS_FILE), cells);
  fs.writeFileSync(path.join(dir, 'screens.json'), JSON.stringify(screens));
}
const readJson = <T,>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8')) as T;
const singleScreens = (platformA?: string, platformB?: string) => ({
  title: 'Luồng màn hình — CR',
  source: SRC,
  screens: [
    { key: 'cr__X1', code: null, name: 'Hỗ trợ trực tuyến', anchorText: '### Hỗ trợ trực tuyến (MB)', cell: 'od-s-1', ...(platformA ? { platform: platformA } : {}) },
    { key: 'cr__X2', code: null, name: 'Quản lý yêu cầu', anchorText: '### Quản lý yêu cầu (MB)', cell: 'od-s-2', ...(platformB ? { platform: platformB } : {}) },
  ],
  excluded: [{ name: '2.3 Màn hình IB', reason: 'ngoài phạm vi nền tảng (Mobile app)' }],
});

describe('finalizeScreenFlowXml theo phạm vi người dùng chọn', () => {
  test('mobile: màn thiếu platform → daemon ĐIỀN "app" (theo lựa chọn, không đoán); screens.json ghi lại có platform; discovery mang platform', async () => {
    const cwd = mkcwd();
    writeFlow(cwd, SCREEN_FLOW_ID, fragment('s'), singleScreens());
    const r = await finalizeScreenFlowXml(cwd, { screenPlatform: 'mobile' });
    assert.deepEqual(r.errors, []);
    assert.equal(r.found, true);
    const written = readJson<{ screens: Array<{ key: string; platform?: string }> }>(path.join(cwd, 'flows', SCREEN_FLOW_ID, 'screens.json'));
    assert.deepEqual(written.screens.map((s) => s.platform), ['app', 'app']);
    const disc = r.discovery!.pages[0]!.screens;
    assert.deepEqual(disc.map((s) => s.platform), ['app', 'app']);
  });

  test('mobile: màn khai platform "web" → lỗi "ngoài phạm vi"', async () => {
    const cwd = mkcwd();
    writeFlow(cwd, SCREEN_FLOW_ID, fragment('s'), singleScreens('app', 'web'));
    const r = await finalizeScreenFlowXml(cwd, { screenPlatform: 'mobile' });
    assert.equal(r.errors.length, 1, r.errors.join(' | '));
    assert.match(r.errors[0]!, /màn "cr__X2" platform "web" ngoài phạm vi Mobile app/);
  });

  test('web: có thư mục SCREEN-FLOW--web (tách) → lỗi, chỉ dùng flows/SCREEN-FLOW/', async () => {
    const cwd = mkcwd();
    writeFlow(cwd, `${SCREEN_FLOW_ID}--web`, fragment('w'), { ...singleScreens('web', 'web'), screens: singleScreens('web', 'web').screens.map((s) => ({ ...s, key: `${s.key}--web`, cell: s.cell.replace('od-s', 'od-w') })) });
    const r = await finalizeScreenFlowXml(cwd, { screenPlatform: 'web' });
    assert.equal(r.errors.length, 1, r.errors.join(' | '));
    assert.match(r.errors[0]!, /Website — chỉ dùng flows\/SCREEN-FLOW\//);
  });

  test('both: flows/SCREEN-FLOW/ đơn → lỗi phải tách --app + --web', async () => {
    const cwd = mkcwd();
    writeFlow(cwd, SCREEN_FLOW_ID, fragment('s'), singleScreens('app', 'app'));
    const r = await finalizeScreenFlowXml(cwd, { screenPlatform: 'both' });
    assert.equal(r.errors.length, 1, r.errors.join(' | '));
    assert.match(r.errors[0]!, /Cả hai — phải tách flows\/SCREEN-FLOW--app\/ \+ flows\/SCREEN-FLOW--web\//);
  });

  test('both: luật cũ giữ nguyên — màn thiếu platform trong --app → lỗi nêu key; flow --web rỗng (screens: []) → bỏ qua kèm warning, không bịa', async () => {
    const cwd = mkcwd();
    const app = singleScreens('app');
    app.screens = app.screens.map((s) => ({ ...s, key: `${s.key}--app`, cell: s.cell.replace('od-s', 'od-a') }));
    writeFlow(cwd, `${SCREEN_FLOW_ID}--app`, fragment('a'), app);
    writeFlow(cwd, `${SCREEN_FLOW_ID}--web`, fragment('w'), { title: 'Luồng màn hình — CR', source: SRC, screens: [], excluded: [{ name: '2.3 Màn hình IB', reason: 'tài liệu không mô tả màn web' }] });
    let r = await finalizeScreenFlowXml(cwd, { screenPlatform: 'both' });
    assert.ok(r.errors.some((e) => /màn "cr__X2--app" thiếu `platform`/.test(e)), r.errors.join(' | '));
    // Sửa: đủ platform → OK, flow web rỗng chỉ warning.
    app.screens = app.screens.map((s) => ({ ...s, platform: 'app' }));
    writeFlow(cwd, `${SCREEN_FLOW_ID}--app`, fragment('a'), app);
    r = await finalizeScreenFlowXml(cwd, { screenPlatform: 'both' });
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.some((w) => /SCREEN-FLOW--web: flow Web không có màn \(screens: \[\], excluded: 1\)/.test(w)), r.warnings.join(' | '));
    assert.deepEqual(r.flowIds, [`${SCREEN_FLOW_ID}--app`]);
    assert.equal(fs.existsSync(path.join(cwd, 'flows', `${SCREEN_FLOW_ID}--web`, 'as-is.drawio')), false);
  });

  test('phạm vi vắng (tool cũ): không điền, không chặn thư mục — luật trước WP', async () => {
    const cwd = mkcwd();
    writeFlow(cwd, SCREEN_FLOW_ID, fragment('s'), singleScreens());
    const r = await finalizeScreenFlowXml(cwd);
    assert.deepEqual(r.errors, []);
    const written = readJson<{ screens: Array<{ platform?: string }> }>(path.join(cwd, 'flows', SCREEN_FLOW_ID, 'screens.json'));
    assert.deepEqual(written.screens.map((s) => s.platform), [undefined, undefined]);
  });
});

// ── (4) screen inputs theo phạm vi ─────────────────────────────────────────
function seedFlowIndex(cwd: string, entries: Array<{ id: string; platform?: 'app' | 'web'; keys: string[] }>): void {
  fs.mkdirSync(path.join(cwd, 'flows'), { recursive: true });
  const index = entries.map((e) => ({
    id: e.id,
    title: 'Luồng màn hình',
    ...(e.platform ? { platform: e.platform } : {}),
    screens: e.keys.map((key) => ({ key, name: key })),
    files: {},
  }));
  fs.writeFileSync(path.join(cwd, 'flows', 'index.json'), JSON.stringify(index));
}
const PAGES = [{ mdPath: SRC, page: 'cr' }];

describe('prepareScreenComponentInputs theo phạm vi', () => {
  test('web: mọi màn platform/platformHint = web dù tài liệu có "bottom sheet"; _inputs.json ghi screenPlatform', async () => {
    const cwd = mkcwd();
    assert.match(CR_MD, /bottom sheet/);
    seedFlowIndex(cwd, [{ id: SCREEN_FLOW_ID, keys: ['cr__X1', 'cr__X2'] }]);
    const inputs = await prepareScreenComponentInputs(cwd, { pages: PAGES, screenPlatform: 'web' });
    assert.equal(inputs.screens.length, 2);
    for (const s of inputs.screens) {
      assert.equal(s.platformHint, 'web', s.key);
      assert.equal(s.platform, 'web', s.key);
    }
    assert.equal(inputs.screenPlatform, 'web');
    const onDisk = readJson<{ screenPlatform?: string }>(path.join(cwd, 'comp', '_inputs.json'));
    assert.equal(onDisk.screenPlatform, 'web');
  });

  test('mobile: mọi màn = mobile kể cả màn của flow đơn không có platform', async () => {
    const cwd = mkcwd();
    seedFlowIndex(cwd, [{ id: SCREEN_FLOW_ID, keys: ['cr__X1'] }]);
    const inputs = await prepareScreenComponentInputs(cwd, { pages: PAGES, screenPlatform: 'mobile' });
    assert.deepEqual(inputs.screens.map((s) => [s.platform, s.platformHint]), [['mobile', 'mobile']]);
  });

  test('both: màn của flow tách nhận platform theo thư mục; màn thiếu platform → throw thông điệp fail-fast', async () => {
    const cwd = mkcwd();
    seedFlowIndex(cwd, [
      { id: `${SCREEN_FLOW_ID}--app`, platform: 'app', keys: ['cr__X1--app'] },
      { id: `${SCREEN_FLOW_ID}--web`, platform: 'web', keys: ['cr__X1--web'] },
    ]);
    const inputs = await prepareScreenComponentInputs(cwd, { pages: PAGES, screenPlatform: 'both' });
    assert.deepEqual(inputs.screens.map((s) => [s.key, s.platform, s.platformHint]), [
      ['cr__X1--app', 'mobile', 'mobile'],
      ['cr__X1--web', 'web', 'web'],
    ]);
    // Flow đơn (không platform) dưới phạm vi both → fail-fast.
    const cwd2 = mkcwd();
    seedFlowIndex(cwd2, [{ id: SCREEN_FLOW_ID, keys: ['cr__X9'] }]);
    await assert.rejects(prepareScreenComponentInputs(cwd2, { pages: PAGES, screenPlatform: 'both' }), /Màn cr__X9 chưa có nền tảng — chọn Mobile\/Web hoặc chạy lại Luồng màn hình/);
  });

  test('resolveInputPlatform / assertScreensHavePlatform: helper thuần', () => {
    assert.deepEqual(resolveInputPlatform('mobile', 'web', 'k'), { platform: 'mobile', platformHint: 'mobile' });
    assert.deepEqual(resolveInputPlatform('both', 'web', 'k'), { platform: 'web', platformHint: 'web' });
    assert.throws(() => resolveInputPlatform('both', null, 'k'), /Màn k chưa có nền tảng/);
    assert.deepEqual(resolveInputPlatform(undefined, null, 'k'), { platformHint: 'web' });
    const base = (key: string, platform?: 'mobile' | 'web'): ScreenInput => ({ key, name: key, order: 0, flowId: '', flowTitle: '', source: null, steps: [], navOut: [], navIn: [], findings: [], platformHint: 'web', ...(platform ? { platform } : {}) });
    assert.doesNotThrow(() => assertScreensHavePlatform([base('a')], 'mobile'));
    assert.doesNotThrow(() => assertScreensHavePlatform([base('a', 'web')], 'both'));
    assert.throws(() => assertScreensHavePlatform([base('a'), base('b', 'web'), base('c')], 'both'), /Màn a, c chưa có nền tảng/);
  });
});

// ── (5) overrides thêm màn theo phạm vi ────────────────────────────────────
describe('applyScreenOverrides: màn thêm tay theo phạm vi', () => {
  const MD = ['# PRD', '', 'Màn hình thanh toán', ''].join('\n');
  const md = () => new Map([['docs/prd.md', MD]]);
  const overridesJson = (platform?: string) =>
    JSON.stringify({ schema_version: 1, overrides: [{ action: 'add', source: 'docs/prd.md', code: 'PAY', name: 'Thanh toán', anchorText: 'Màn hình thanh toán', ...(platform ? { platform } : {}) }] });

  test('both + thiếu platform → warning "màn thêm tay cần nền tảng" và KHÔNG thêm', () => {
    const { doc } = parseScreensOverrides(overridesJson());
    const { screens, warnings } = applyScreenOverrides([], doc, md(), { screenPlatform: 'both' });
    assert.equal(screens.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /màn thêm tay cần nền tảng .* khi phạm vi = Cả hai/);
  });

  test('both + có platform "web" → thêm với platform web', () => {
    const { doc, warnings: parseWarnings } = parseScreensOverrides(overridesJson('web'));
    assert.deepEqual(parseWarnings, []);
    const { screens, warnings } = applyScreenOverrides([], doc, md(), { screenPlatform: 'both' });
    assert.deepEqual(warnings, []);
    assert.equal(screens.length, 1);
    assert.equal(screens[0]!.platform, 'web');
    assert.equal(screens[0]!.platformHint, 'web');
    assert.equal(screens[0]!.origin, 'user');
  });

  test('phạm vi đơn (mobile) → platform = phạm vi, bỏ qua platform người dùng khai lệch; giá trị lạ chỉ warning parse', () => {
    const { doc, warnings: parseWarnings } = parseScreensOverrides(overridesJson('desktop'));
    assert.equal(parseWarnings.length, 1);
    assert.match(parseWarnings[0]!, /"platform" không hợp lệ/);
    const { screens } = applyScreenOverrides([], doc, md(), { screenPlatform: 'mobile' });
    assert.equal(screens.length, 1);
    assert.equal(screens[0]!.platform, 'mobile');
    assert.equal(screens[0]!.platformHint, 'mobile');
  });
});
