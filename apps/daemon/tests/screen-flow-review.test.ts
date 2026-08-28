// WP dr-review-screen-flow (2026-08-27): ngữ cảnh "Luồng màn hình bản đã
// chọn" cho dr-review — loadScreenFlowReviewContext (original/improved/null)
// + mapScreenFlowToPage (phép đối chiếu 1: màn ↔ mục tài liệu → note gap).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { splitSections } from '../src/docs-review.js';
import {
  SCREEN_FLOW_CONTEXT_REL,
  classifyOutcomes,
  loadScreenFlowReviewContext,
  loadScreenFlowReviewContextFor,
  mapScreenFlowToPage,
  screenFlowEdgeKey,
  writeScreenFlowReviewContext,
} from '../src/flow-ux/screen-flow-review.js';
import { SCREEN_FLOW_ID } from '../src/flow-ux/screen-flow-xml.js';

const vertex = (id: string, label: string, style = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;') =>
  `<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="1"><mxGeometry x="0" y="0" width="200" height="60" as="geometry"/></mxCell>`;
const edge = (id: string, from: string, to: string, label: string) =>
  `<mxCell id="${id}" value="${label}" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="${from}" target="${to}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
const model = (cells: string[]) => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel>`;
const mxfile = (pages: Array<[string, string]>) =>
  `<mxfile host="test">${pages.map(([name, g], i) => `<diagram id="p${i}" name="${name}">${g}</diagram>`).join('')}</mxfile>`;

const START = 'ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;';
const OK = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;';
const FAIL = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;';

const AS_IS = model([
  vertex('od-start', 'Bắt đầu', START),
  vertex('od-6-1-1', '6.1.1 · Trang chủ'),
  vertex('od-6-4-1', '6.4.1 · Nhập thông tin'),
  vertex('od-ok', 'Mua thành công', OK),
  vertex('od-fail', 'Thanh toán lỗi', FAIL),
  vertex('od-legend-ok', 'Kết cục thành công', OK),
  edge('od-e1', 'od-start', 'od-6-1-1', 'Mở app'),
  edge('od-e2', 'od-6-1-1', 'od-6-4-1', 'Mua SIM'),
  edge('od-e3', 'od-6-4-1', 'od-ok', 'Thanh toán OK'),
  edge('od-e4', 'od-6-4-1', 'od-fail', 'Thanh toán lỗi'),
]);
const PROPOSED = model([
  vertex('od-start', 'Bắt đầu', START),
  vertex('od-6-1-1', '6.1.1 · Trang chủ'),
  vertex('od-6-4-1', '6.4.1 · Nhập thông tin'),
  vertex('od-n1', 'Xác nhận đơn hàng'),
  vertex('od-ok', 'Mua thành công', OK),
  vertex('od-fail', 'Thanh toán lỗi', FAIL),
  edge('od-e1', 'od-start', 'od-6-1-1', 'Mở app'),
  edge('od-e2', 'od-6-1-1', 'od-6-4-1', 'Mua SIM'),
  edge('od-ne1', 'od-6-4-1', 'od-n1', 'Tiếp tục'),
  edge('od-e3', 'od-n1', 'od-ok', 'Thanh toán OK'),
  edge('od-e4', 'od-n1', 'od-fail', 'Thanh toán lỗi'),
]);

const SCREENS = {
  title: 'Luồng màn hình — Mua SIM',
  source: 'docs-feature/prd.md',
  screens: [
    { key: 'prd__6.1.1', code: '6.1.1', name: 'Trang chủ', anchorText: '## 6.1.1 Trang chủ', cell: 'od-6-1-1' },
    { key: 'prd__6.4.1', code: '6.4.1', name: 'Nhập thông tin', anchorText: '## 6.4.1 Nhập thông tin', cell: 'od-6-4-1' },
  ],
  excluded: [],
};
const SCREENS_IMPROVED = {
  schema_version: 1,
  generatedAt: '2026-08-27T00:00:00.000Z',
  screens: [
    { key: 'prd__6.1.1', name: 'Trang chủ', cell: 'od-6-1-1', provenance: 'document', anchorText: '## 6.1.1 Trang chủ' },
    { key: 'prd__6.4.1', name: 'Nhập thông tin', cell: 'od-6-4-1', provenance: 'document', anchorText: '## 6.4.1 Nhập thông tin' },
    { key: 'prd__NEW-xac-nhan-don', name: 'Xác nhận đơn hàng', cell: 'od-n1', provenance: 'proposed', why: 'UX-01' },
  ],
};
const FLOWCHART_ORIGINAL = {
  id: SCREEN_FLOW_ID,
  title: 'Luồng màn hình — Mua SIM',
  source: 'docs-feature/prd.md',
  nodes: [
    { id: 'od-start', type: 'start', label: 'Bắt đầu' },
    { id: 'od-6-1-1', type: 'action', label: '6.1.1 · Trang chủ', screen: 'prd__6.1.1' },
    { id: 'od-6-4-1', type: 'action', label: '6.4.1 · Nhập thông tin', screen: 'prd__6.4.1' },
    { id: 'od-ok', type: 'end', label: 'Mua thành công' },
    { id: 'od-fail', type: 'end', label: 'Thanh toán lỗi' },
  ],
  edges: [
    { from: 'od-start', to: 'od-6-1-1', label: 'Mở app' },
    { from: 'od-6-1-1', to: 'od-6-4-1', label: 'Mua SIM' },
    { from: 'od-6-4-1', to: 'od-ok', label: 'Thanh toán OK' },
    { from: 'od-6-4-1', to: 'od-fail', label: 'Thanh toán lỗi' },
  ],
};
const FLOWCHART_IMPROVED = {
  ...FLOWCHART_ORIGINAL,
  nodes: [...FLOWCHART_ORIGINAL.nodes, { id: 'od-n1', type: 'action', label: 'Xác nhận đơn hàng', screen: 'prd__NEW-xac-nhan-don' }],
  edges: [
    { from: 'od-start', to: 'od-6-1-1', label: 'Mở app' },
    { from: 'od-6-1-1', to: 'od-6-4-1', label: 'Mua SIM' },
    { from: 'od-6-4-1', to: 'od-n1', label: 'Tiếp tục' },
    { from: 'od-n1', to: 'od-ok', label: 'Thanh toán OK' },
    { from: 'od-n1', to: 'od-fail', label: 'Thanh toán lỗi' },
  ],
};
const REVIEW = {
  flowId: SCREEN_FLOW_ID,
  verdict: 'needs-improvement',
  summary: 'Thiếu bước xác nhận.',
  findings: [
    { id: 'UX-01', severity: 'major', title: 'Thiếu màn xác nhận đơn', reason: 'x', cells: { asIs: ['od-6-4-1'], proposed: ['od-n1'] }, change: 'added' },
  ],
};

function setup(opts: { improved?: boolean; selection?: 'original' | 'improved'; noAsIs?: boolean } = {}): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sfr-'));
  const dir = path.join(cwd, 'flows', SCREEN_FLOW_ID);
  fs.mkdirSync(dir, { recursive: true });
  if (!opts.noAsIs) fs.writeFileSync(path.join(dir, 'as-is.drawio'), mxfile([['Luồng', AS_IS]]));
  fs.writeFileSync(path.join(dir, 'screens.json'), JSON.stringify(SCREENS));
  const improved = !!opts.improved;
  if (improved) {
    fs.writeFileSync(path.join(dir, 'proposed.drawio'), mxfile([['Hiện trạng', AS_IS], ['Đề xuất', PROPOSED]]));
    fs.writeFileSync(path.join(dir, 'screens.improved.json'), JSON.stringify(SCREENS_IMPROVED));
    fs.writeFileSync(path.join(dir, 'ux-review.json'), JSON.stringify(REVIEW));
  }
  if (opts.selection) fs.writeFileSync(path.join(dir, 'selection.json'), JSON.stringify({ variant: opts.selection, source: 'user', at: 'x' }));
  const useImproved = improved && opts.selection === 'improved';
  fs.writeFileSync(path.join(cwd, 'flows', `${SCREEN_FLOW_ID}.flowchart.json`), JSON.stringify(useImproved ? FLOWCHART_IMPROVED : FLOWCHART_ORIGINAL));
  return cwd;
}

test('screenFlowEdgeKey: <from>→<to> với mũi tên unicode', () => {
  assert.equal(screenFlowEdgeKey('od-6-4-1', 'od-n1'), 'od-6-4-1→od-n1');
});

test('classifyOutcomes: fill lỗi → error, fill OK không ellipse → success, ellipse OK có cạnh ra (Bắt đầu) bỏ, legend bỏ', () => {
  const out = classifyOutcomes(AS_IS);
  assert.deepEqual(
    out.map((o) => [o.cell, o.kind]),
    [
      ['od-ok', 'success'],
      ['od-fail', 'error'],
    ],
  );
});

test('loadScreenFlowReviewContext: null khi thiếu as-is.drawio', async () => {
  const cwd = setup({ noAsIs: true });
  assert.equal(await loadScreenFlowReviewContext(cwd), null);
  assert.equal(await loadScreenFlowReviewContextFor(cwd), null);
});

test('loadScreenFlowReviewContext: không selection → original, as-is trang 0, screens từ screens.json, edges từ flowchart, findings rỗng', async () => {
  const cwd = setup({ improved: true });
  const ctx = await loadScreenFlowReviewContextFor(cwd);
  assert.ok(ctx);
  assert.equal(ctx.variant, 'original');
  assert.equal(ctx.selectionSource, 'default');
  assert.deepEqual(ctx.diagram, { file: 'flows/SCREEN-FLOW/as-is.drawio', page: 0 });
  assert.equal(ctx.source, 'docs-feature/prd.md');
  assert.deepEqual(
    ctx.screens.map((s) => [s.key, s.cell, s.source, s.provenance ?? null]),
    [
      ['prd__6.1.1', 'od-6-1-1', 'docs-feature/prd.md', null],
      ['prd__6.4.1', 'od-6-4-1', 'docs-feature/prd.md', null],
    ],
  );
  assert.equal(ctx.edges.length, 4);
  const e = ctx.edges.find((x) => x.key === 'od-6-1-1→od-6-4-1')!;
  assert.deepEqual(e, { key: 'od-6-1-1→od-6-4-1', from: 'od-6-1-1', to: 'od-6-4-1', label: 'Mua SIM', fromName: 'Trang chủ', toName: 'Nhập thông tin' });
  assert.deepEqual(ctx.findings, []);
  assert.deepEqual(ctx.outcomes.map((o) => o.cell), ['od-ok', 'od-fail']);
});

test('loadScreenFlowReviewContext: selection improved + proposed trang 1 → improved, màn đề xuất provenance proposed, findings từ ux-review', async () => {
  const cwd = setup({ improved: true, selection: 'improved' });
  const ctx = await loadScreenFlowReviewContextFor(cwd);
  assert.ok(ctx);
  assert.equal(ctx.variant, 'improved');
  assert.equal(ctx.selectionSource, 'user');
  assert.deepEqual(ctx.diagram, { file: 'flows/SCREEN-FLOW/proposed.drawio', page: 1 });
  const proposed = ctx.screens.find((s) => s.key === 'prd__NEW-xac-nhan-don')!;
  assert.equal(proposed.provenance, 'proposed');
  assert.equal(proposed.cell, 'od-n1');
  assert.equal(proposed.source, 'docs-feature/prd.md');
  assert.equal(ctx.findings.length, 1);
  assert.ok(ctx.edges.some((e) => e.key === 'od-6-4-1→od-n1' && e.toName === 'Xác nhận đơn hàng'));
  // Kết cục lấy từ trang Đề xuất.
  assert.deepEqual(ctx.outcomes.map((o) => o.kind), ['success', 'error']);
});

test('loadScreenFlowReviewContext: selection improved nhưng KHÔNG có proposed.drawio → lùi về original', async () => {
  const cwd = setup({ selection: 'improved' });
  const ctx = await loadScreenFlowReviewContextFor(cwd);
  assert.ok(ctx);
  assert.equal(ctx.variant, 'original');
  assert.equal(ctx.selectionSource, 'user');
  assert.deepEqual(ctx.findings, []);
});

test('writeScreenFlowReviewContext: ghi review/_screen-flow-context.json dạng { generatedAt, flows[] } (flow đơn → 1 phần tử có id)', async () => {
  const cwd = setup();
  const ctxs = (await loadScreenFlowReviewContext(cwd))!;
  assert.equal(ctxs.flows.length, 1);
  assert.equal(ctxs.flows[0]!.id, SCREEN_FLOW_ID);
  assert.equal(ctxs.flows[0]!.platform, undefined);
  await writeScreenFlowReviewContext(cwd, ctxs);
  const written = JSON.parse(fs.readFileSync(path.join(cwd, SCREEN_FLOW_CONTEXT_REL), 'utf8'));
  assert.equal(written.flows[0].variant, 'original');
  assert.equal(written.flows[0].id, SCREEN_FLOW_ID);
  assert.equal(written.flows[0].screens.length, 2);
  assert.ok(typeof written.generatedAt === 'string');
});

const PAGE = ['# PRD', '', '## 6.1.1 Trang chủ', '', 'Người dùng bấm Mua SIM để sang bước nhập thông tin.', '', '## 6.9.9 Mục khác', '', 'Không liên quan.', ''].join('\n');

test('mapScreenFlowToPage (phép 1): màn có mục → placed + cạnh/kết cục theo section; màn không có mục → note gap rule_id screens.json#<KEY>, anchor rỗng + anchor_unresolved', async () => {
  const cwd = setup();
  const ctx = (await loadScreenFlowReviewContextFor(cwd))!;
  const sections = splitSections(PAGE);
  const m = mapScreenFlowToPage(ctx, { pageSrc: 'docs-feature/prd.md', sections, pageLines: PAGE.split('\n'), original: PAGE });
  assert.equal(m.pageScreens.length, 2);
  const placedKeys = [...m.placedBySection.values()].flat().map((s) => s.key);
  assert.deepEqual(placedKeys, ['prd__6.1.1']);
  const secIdx = [...m.placedBySection.keys()][0]!;
  assert.deepEqual(
    (m.edgesBySection.get(secIdx) ?? []).map((e) => e.key),
    ['od-start→od-6-1-1', 'od-6-1-1→od-6-4-1'],
  );
  // Kết cục không nối trực tiếp với 6.1.1 → không có trong section này.
  assert.equal(m.outcomesBySection.get(secIdx), undefined);
  assert.deepEqual(m.unplaced.map((s) => s.key), ['prd__6.4.1']);
  assert.equal(m.gapNotes.length, 1);
  const note = m.gapNotes[0]!;
  assert.equal(note.id, 'sys-screen-flow-prd__6.4.1');
  assert.equal(note.kind, 'gap');
  assert.equal(note.severity, 'major');
  assert.equal(note.rule_id, 'flows/SCREEN-FLOW/screens.json#prd__6.4.1');
  assert.equal(note.anchor, '');
  assert.equal(note.anchor_unresolved, true);
  assert.match(note.finding, /bản nguyên bản/);
  assert.match(note.finding, /«Nhập thông tin»/);
});

test('mapScreenFlowToPage: anchorText có trong trang → anchor giữ nguyên văn (không anchor_unresolved)', async () => {
  const cwd = setup();
  const ctx = (await loadScreenFlowReviewContextFor(cwd))!;
  // Trang nhắc tới "## 6.4.1 Nhập thông tin" trong fence (không phải heading thật) → unplaced nhưng anchor tìm thấy.
  const page = `${PAGE}\n\`\`\`\n## 6.4.1 Nhập thông tin\n\`\`\`\n`;
  const sections = splitSections(page);
  const m = mapScreenFlowToPage(ctx, { pageSrc: 'docs-feature/prd.md', sections, pageLines: page.split('\n'), original: page });
  const note = m.gapNotes.find((n) => n.id === 'sys-screen-flow-prd__6.4.1')!;
  assert.equal(note.anchor, '## 6.4.1 Nhập thông tin');
  assert.equal(note.anchor_unresolved, undefined);
});

test('mapScreenFlowToPage (improved): màn đề xuất LUÔN là gap kèm UX-id; kết cục nối với cạnh của section có mặt', async () => {
  const cwd = setup({ improved: true, selection: 'improved' });
  const ctx = (await loadScreenFlowReviewContextFor(cwd))!;
  const page = ['# PRD', '', '## 6.4.1 Nhập thông tin', '', 'Nhập rồi thanh toán.', ''].join('\n');
  const sections = splitSections(page);
  const m = mapScreenFlowToPage(ctx, { pageSrc: 'docs-feature/prd.md', sections, pageLines: page.split('\n'), original: page });
  const ids = m.gapNotes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['sys-screen-flow-prd__6.1.1', 'sys-screen-flow-prd__NEW-xac-nhan-don']);
  const proposed = m.gapNotes.find((n) => n.id === 'sys-screen-flow-prd__NEW-xac-nhan-don')!;
  assert.match(proposed.finding, /bản cải thiện đề xuất \(UX-01\)/);
  assert.equal(proposed.rule_id, 'flows/SCREEN-FLOW/screens.json#prd__NEW-xac-nhan-don');
  const secIdx = [...m.placedBySection.keys()][0]!;
  assert.deepEqual((m.edgesBySection.get(secIdx) ?? []).map((e) => e.key), ['od-6-1-1→od-6-4-1', 'od-6-4-1→od-n1']);
});

test('mapScreenFlowToPage: trang khác source → không màn, không note', async () => {
  const cwd = setup();
  const ctx = (await loadScreenFlowReviewContextFor(cwd))!;
  const sections = splitSections(PAGE);
  const m = mapScreenFlowToPage(ctx, { pageSrc: 'docs-feature/other.md', sections, pageLines: PAGE.split('\n'), original: PAGE });
  assert.equal(m.pageScreens.length, 0);
  assert.deepEqual(m.gapNotes, []);
  assert.equal(m.placedBySection.size, 0);
});
