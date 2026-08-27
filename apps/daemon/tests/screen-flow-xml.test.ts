// WP-screen-flow: dr-flow bản mới (skill docs-screen-flow) — agent ghi fragment
// mxCell trần + screens.json, daemon wrap → validate → dịch thành flow drawio
// cho finalizeFlowUx. Test các mảnh thuần (wrap/validate) và vòng đầy-đủ trên
// thư mục tạm: finalizeScreenFlowXml → finalizeFlowUx phải cho ra index đúng
// MỘT entry SCREEN-FLOW có màn, seed dời sang flows/_seeds/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { decodeMxfile, listCells } from '../src/flow-ux/mxfile.js';
import { finalizeFlowUx } from '../src/flow-ux/index.js';
import {
  SCREEN_FLOW_CELLS_FILE,
  SCREEN_FLOW_ID,
  finalizeScreenFlowXml,
  saveScreenFlowEdit,
  validateScreenFlowGraph,
  wrapScreenFlowCells,
} from '../src/flow-ux/screen-flow-xml.js';

const vertex = (id: string, label: string, x: number, y: number, w = 200, h = 60) =>
  `<mxCell id="${id}" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">\n` +
  `  <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" />\n` +
  `</mxCell>`;
const edge = (id: string, from: string, to: string, label: string, anchors = 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;') =>
  `<mxCell id="${id}" value="${label}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;${anchors}" edge="1" parent="1" source="${from}" target="${to}">\n` +
  `  <mxGeometry relative="1" as="geometry" />\n` +
  `</mxCell>`;

// 3 màn + 1 node hệ thống, đủ mọi loại cạnh mà không phô trương.
const GOOD_FRAGMENT = [
  vertex('od-start', 'Bắt đầu', 40, 40, 150, 50),
  vertex('od-6-1-1', '6.1.1 · Trang chủ', 40, 200),
  vertex('od-6-2-1', '6.2.1 · Danh sách gói', 340, 200),
  vertex('od-sys-pay', 'Cổng thanh toán', 640, 200),
  edge('od-e1', 'od-start', 'od-6-1-1', 'Mở app', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;'),
  edge('od-e2', 'od-6-1-1', 'od-6-2-1', 'Mua SIM'),
  edge('od-e3', 'od-6-2-1', 'od-sys-pay', 'Thanh toán'),
].join('\n');

test('wrapScreenFlowCells: bọc fragment trần thành mxGraphModel; chặn fragment rỗng và fragment tự bọc wrapper', () => {
  const ok = wrapScreenFlowCells(GOOD_FRAGMENT);
  assert.ok('graphXml' in ok);
  const cells = listCells((ok as { graphXml: string }).graphXml);
  assert.equal(cells.filter((c) => c.kind === 'vertex').length, 4);
  assert.equal(cells.filter((c) => c.kind === 'edge').length, 3);

  assert.ok('error' in wrapScreenFlowCells('   \n<!-- chỉ có comment -->\n'));
  const wrapped = wrapScreenFlowCells(`<mxGraphModel><root>${GOOD_FRAGMENT}</root></mxGraphModel>`);
  assert.ok('error' in wrapped);
  assert.match((wrapped as { error: string }).error, /TRẦN/);
});

test('validateScreenFlowGraph: bắt id trùng, cạnh trỏ node ma, thiếu geometry, node đè nhau, cạnh trùng path; node rời = warning', () => {
  const good = wrapScreenFlowCells(GOOD_FRAGMENT) as { graphXml: string };
  const v = validateScreenFlowGraph(good.graphXml);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
  assert.equal(v.vertexCount, 4);

  const bad = wrapScreenFlowCells(
    [
      vertex('od-a', 'A', 0, 0),
      vertex('od-a', 'A lặp', 300, 0), // id trùng
      vertex('od-b', 'B', 280, 0), // đè lên od-a lặp
      `<mxCell id="od-c" value="thiếu geometry" style="rounded=1;" vertex="1" parent="1"><mxGeometry as="geometry" /></mxCell>`,
      vertex('od-roi', 'không ai trỏ tới', 0, 300),
      edge('od-e1', 'od-a', 'od-ma', 'tới node ma'),
      edge('od-e2', 'od-a', 'od-b', 'x'),
      edge('od-e3', 'od-a', 'od-b', 'y'), // cùng source/target + cùng exit/entry mặc định
    ].join('\n'),
  ) as { graphXml: string };
  const bv = validateScreenFlowGraph(bad.graphXml);
  assert.ok(bv.errors.some((e) => e.includes('id trùng: od-a')), bv.errors.join(' | '));
  assert.ok(bv.errors.some((e) => e.includes('"od-ma" không tồn tại')));
  assert.ok(bv.errors.some((e) => e.includes('od-c: thiếu geometry')));
  assert.ok(bv.errors.some((e) => e.includes('node đè nhau')));
  assert.ok(bv.errors.some((e) => e.includes('cạnh trùng path: od-e2 ↔ od-e3')));
  assert.ok(bv.warnings.some((w) => w.includes('od-roi')));
});

test('wrapScreenFlowCells: escape thẻ HTML thô trong value="…" — sự cố <br> làm browser rớt toàn bộ cạnh', () => {
  // Agent viết nhãn nhiều dòng bằng <br> trần trong attribute — XML không hợp
  // lệ với DOMParser của browser (dr-flow 2026-08-27: node hiện, cạnh biến
  // mất sạch). Wrap phải escape tại chỗ thành &lt;br&gt; (html=1 render lại
  // đúng xuống dòng) và validator vẫn thấy đủ node/cạnh.
  const fragment = [
    vertex('od-a', 'Xuất đơn thất bại,<br>Hoàn tiền', 0, 0),
    vertex('od-b', 'B &amp; C', 300, 0),
    edge('od-e1', 'od-a', 'od-b', 'x'),
  ].join('\n');
  const wrapped = wrapScreenFlowCells(fragment);
  assert.ok('graphXml' in wrapped);
  const graphXml = (wrapped as { graphXml: string }).graphXml;
  assert.ok(graphXml.includes('&lt;br&gt;'), 'thẻ <br> trong value phải được escape');
  assert.ok(!/value="[^"]*<br>/.test(graphXml), 'không còn <br> trần trong attribute');
  assert.ok(graphXml.includes('B &amp; C'), 'entity sẵn có không bị double-escape');
  const v = validateScreenFlowGraph(graphXml);
  assert.deepEqual(v.errors, []);
  assert.equal(v.vertexCount, 2);
  assert.equal(v.edgeCount, 1);
});

test('finalizeScreenFlowXml: không có fragment → found:false, không đụng gì', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
  const r = await finalizeScreenFlowXml(cwd);
  assert.deepEqual(r, { found: false, errors: [], warnings: [] });
  assert.ok(!fs.existsSync(path.join(cwd, 'flows')));
});

test('finalizeScreenFlowXml: fragment lỗi → errors chặn, KHÔNG ghi as-is.drawio', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
  const dir = path.join(cwd, 'flows', SCREEN_FLOW_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SCREEN_FLOW_CELLS_FILE), [vertex('od-a', 'A', 0, 0), edge('od-e1', 'od-a', 'od-ma', 'x')].join('\n'));
  const r = await finalizeScreenFlowXml(cwd);
  assert.equal(r.found, true);
  assert.ok(r.errors.length > 0);
  assert.match(r.errors[0]!, new RegExp(`^${SCREEN_FLOW_ID}: `));
  assert.ok(!fs.existsSync(path.join(dir, 'as-is.drawio')));
});

test('vòng đầy-đủ: finalizeScreenFlowXml dịch fragment + dọn seed, finalizeFlowUx dựng index đúng MỘT flow SCREEN-FLOW có màn', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
  const flowsDir = path.join(cwd, 'flows');
  const dir = path.join(flowsDir, SCREEN_FLOW_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SCREEN_FLOW_CELLS_FILE), GOOD_FRAGMENT);
  fs.writeFileSync(
    path.join(dir, 'screens.json'),
    JSON.stringify({
      title: 'Luồng màn hình — Mua SIM',
      source: 'docs/prd.md',
      cells: { 'od-6-1-1': 'prd__6.1.1', 'od-6-2-1': 'prd__6.2.1' },
      names: { 'prd__6.1.1': 'Trang chủ', 'prd__6.2.1': 'Danh sách gói' },
    }),
  );
  // Seed do prepareFlowUxInputs để lại: một flow mermaid trong manifest — phải
  // rời sang _seeds/ và biến khỏi index (kể cả nhánh auto-pickup as-is.mmd).
  const seedDir = path.join(flowsDir, 'FLOW-SEED');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(path.join(seedDir, 'as-is.mmd'), 'flowchart TD\n  a[A] --> b[B]\n');
  fs.writeFileSync(
    path.join(flowsDir, '_inputs.json'),
    JSON.stringify({
      generatedAt: '2026-08-27T00:00:00.000Z',
      flows: [{ id: 'FLOW-SEED', title: 'Sơ đồ nghiệp vụ gốc', kind: 'mermaid', source: 'docs/prd.md', diagram: 'flows/FLOW-SEED/as-is.mmd', files: { asIs: 'flows/FLOW-SEED/as-is.mmd' }, counts: { nodes: 2, edges: 1 } }],
    }),
  );

  const r = await finalizeScreenFlowXml(cwd);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, [], r.warnings.join(' | '));

  // as-is.drawio là mxfile thật, decode ra đúng đồ thị; cells.json là bằng
  // chứng node id cho auto-link dr-comp.
  const pages = decodeMxfile(fs.readFileSync(path.join(dir, 'as-is.drawio'), 'utf8'));
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.name, 'Luồng màn hình — Mua SIM');
  assert.equal(listCells(pages[0]!.graphXml).filter((c) => c.kind === 'vertex').length, 4);
  const cellsDump = JSON.parse(fs.readFileSync(path.join(dir, 'cells.json'), 'utf8')) as Array<{ id: string; style?: unknown }>;
  assert.ok(cellsDump.some((c) => c.id === 'od-6-1-1'));
  assert.ok(cellsDump.every((c) => c.style === undefined));

  // Seed đã rời chỗ, manifest chỉ còn SCREEN-FLOW. WP dr-flow-result-split:
  // KHÔNG còn ux-review.json tối thiểu — file đó là output riêng của
  // dr-flow-improve (nếu dr-flow ghi, improve "Xong" ké qua attribution).
  assert.ok(!fs.existsSync(seedDir));
  assert.ok(fs.existsSync(path.join(flowsDir, '_seeds', 'FLOW-SEED', 'as-is.mmd')));
  const manifest = JSON.parse(fs.readFileSync(path.join(flowsDir, '_inputs.json'), 'utf8')) as { generatedAt?: string; flows: Array<{ id: string }> };
  assert.equal(manifest.generatedAt, '2026-08-27T00:00:00.000Z');
  assert.deepEqual(manifest.flows.map((f) => f.id), [SCREEN_FLOW_ID]);
  assert.ok(!fs.existsSync(path.join(dir, 'ux-review.json')));

  // finalizeFlowUx hiện có xử lý phần còn lại như một flow drawio bình thường
  // — vắng ux-review.json trên SCREEN-FLOW là bình thường: KHÔNG warning,
  // entry không có verdict/findings/files.review.
  const fin = await finalizeFlowUx(cwd);
  assert.deepEqual(fin.warnings, [], fin.warnings.join(' | '));
  assert.deepEqual(fin.index.map((e) => e.id), [SCREEN_FLOW_ID]);
  const entry = fin.index[0]!;
  assert.equal(entry.kind, 'drawio');
  assert.deepEqual(entry.screens.map((s) => s.key).sort(), ['prd__6.1.1', 'prd__6.2.1']);
  assert.equal(entry.verdict, undefined);
  assert.equal(entry.findings, undefined);
  assert.equal(entry.files?.review, undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'ux-review.json')));
  assert.equal(entry.files?.flowchart, `flows/${SCREEN_FLOW_ID}.flowchart.json`);
  const chart = JSON.parse(fs.readFileSync(path.join(flowsDir, `${SCREEN_FLOW_ID}.flowchart.json`), 'utf8')) as {
    nodes: Array<{ id: string; screen?: string }>;
    edges: Array<{ from: string; to: string }>;
  };
  assert.equal(chart.nodes.find((n) => n.id === 'od-6-1-1')?.screen, 'prd__6.1.1');
  assert.ok(chart.edges.some((e) => e.from === 'od-6-1-1' && e.to === 'od-6-2-1'));
  // Chạy lại idempotent: không nhân đôi entry, không lỗi mới.
  const again = await finalizeScreenFlowXml(cwd);
  assert.deepEqual(again.errors, []);
  const fin2 = await finalizeFlowUx(cwd);
  assert.deepEqual(fin2.index.map((e) => e.id), [SCREEN_FLOW_ID]);

  // ── saveScreenFlowEdit: bản chỉnh tay từ editor ghi đè + re-finalize ──
  // Giả lập editor: đổi nhãn node + kéo toạ độ (id GIỮ NGUYÊN như draw.io).
  const editedGraph = (wrapScreenFlowCells(
    [
      vertex('od-start', 'Bắt đầu (đã sửa)', 40, 40, 150, 50),
      vertex('od-6-1-1', '6.1.1 · Trang chủ', 500, 400),
      vertex('od-6-2-1', '6.2.1 · Danh sách gói', 900, 400),
      vertex('od-sys-pay', 'Cổng thanh toán', 1200, 400),
      edge('od-e1', 'od-start', 'od-6-1-1', 'Mở app', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;'),
      edge('od-e2', 'od-6-1-1', 'od-6-2-1', 'Mua SIM'),
      edge('od-e3', 'od-6-2-1', 'od-sys-pay', 'Thanh toán'),
    ].join('\n'),
  ) as { graphXml: string }).graphXml;
  const editedMxfile = `<mxfile host="embed.diagrams.net"><diagram id="screen-flow" name="Luồng màn hình — Mua SIM">${editedGraph}</diagram></mxfile>`;
  const saved = await saveScreenFlowEdit(cwd, editedMxfile);
  assert.equal(saved.ok, true, saved.errors.join(' | '));
  const fin3 = await finalizeFlowUx(cwd);
  assert.deepEqual(fin3.index.map((e) => e.id), [SCREEN_FLOW_ID]);
  assert.deepEqual(fin3.index[0]!.screens.map((s) => s.key).sort(), ['prd__6.1.1', 'prd__6.2.1']);
  const editedChart = JSON.parse(fs.readFileSync(path.join(flowsDir, `${SCREEN_FLOW_ID}.flowchart.json`), 'utf8')) as {
    nodes: Array<{ id: string; label: string }>;
  };
  assert.equal(editedChart.nodes.find((n) => n.id === 'od-start')?.label, 'Bắt đầu (đã sửa)');
});

// WP dr-screens-merge: screens.json v2 (`screens[]`) → daemon dẫn xuất
// cells/names, ghi lại file chuẩn hoá, trả `discovery`; cell không có trong
// XML → warning + null; finalizeFlowUx vẫn đọc contract v1 không đổi.
test('finalizeScreenFlowXml: screens.json v2 → ghi lại có cells/names đúng, discovery trả về, cell lạ → warning + null', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
  const dir = path.join(cwd, 'flows', SCREEN_FLOW_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SCREEN_FLOW_CELLS_FILE), GOOD_FRAGMENT);
  fs.writeFileSync(
    path.join(dir, 'screens.json'),
    JSON.stringify({
      title: 'Luồng màn hình — Mua SIM',
      source: 'docs/prd.md',
      note: 'ghi chú',
      // v1 lỡ ghi kèm — screens[] thắng.
      cells: { 'od-cu': 'prd__cu' },
      names: { prd__cu: 'Cũ' },
      screens: [
        { key: 'prd__6.1.1', code: '6.1.1', name: 'Trang chủ', anchorText: '## 6.1.1 Trang chủ', cell: 'od-6-1-1' },
        { key: 'prd__6.2.1', code: '6.2.1', name: 'Danh sách gói', anchorText: '## 6.2.1 Danh sách gói', cell: 'od-6-2-1', blocks: [{ name: 'Bộ lọc', anchorText: '### Bộ lọc' }] },
        { key: 'prd__6.3.2', code: '6.3.2', name: 'Chi tiết gói VN', anchorText: '## 6.3.2 Chi tiết gói VN', cell: null },
        { key: 'prd__9.9', code: '9.9', name: 'Trỏ node ma', anchorText: '## 9.9 Trỏ node ma', cell: 'od-khong-co' },
      ],
      excluded: [{ name: 'Mục lục', reason: 'Chỉ liệt kê.' }],
    }),
  );

  const r = await finalizeScreenFlowXml(cwd);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('od-khong-co') && w.includes('không có trong XML')), r.warnings.join(' | '));
  assert.ok(r.discovery, 'v2 phải trả discovery');
  assert.equal(r.discovery!.schema_version, 1);
  assert.deepEqual(r.discovery!.pages.map((p) => p.source), ['docs/prd.md']);
  assert.deepEqual(r.discovery!.pages[0]!.screens.map((s) => s.code), ['6.1.1', '6.2.1', '6.3.2', '9.9']);
  assert.deepEqual(r.discovery!.pages[0]!.screens[1]!.blocks, [{ name: 'Bộ lọc', anchorText: '### Bộ lọc' }]);
  assert.deepEqual(r.discovery!.excluded, [{ name: 'Mục lục', source: 'docs/prd.md', reason: 'Chỉ liệt kê.' }]);

  const written = JSON.parse(fs.readFileSync(path.join(dir, 'screens.json'), 'utf8')) as {
    title: string; source: string; note: string; cells: Record<string, string>; names: Record<string, string>;
    screens: Array<{ key: string; cell: string | null }>; excluded: unknown[];
  };
  assert.equal(written.title, 'Luồng màn hình — Mua SIM');
  assert.equal(written.note, 'ghi chú');
  assert.deepEqual(written.cells, { 'od-6-1-1': 'prd__6.1.1', 'od-6-2-1': 'prd__6.2.1' });
  assert.deepEqual(Object.keys(written.names).sort(), ['prd__6.1.1', 'prd__6.2.1', 'prd__6.3.2', 'prd__9.9']);
  assert.deepEqual(written.screens.map((s) => [s.key, s.cell]), [
    ['prd__6.1.1', 'od-6-1-1'],
    ['prd__6.2.1', 'od-6-2-1'],
    ['prd__6.3.2', null],
    ['prd__9.9', null],
  ]);
  assert.equal(written.excluded.length, 1);

  // finalizeFlowUx đọc đúng cells/names dẫn xuất — không còn screensDropped.
  const fin = await finalizeFlowUx(cwd);
  const entry = fin.index.find((e) => e.id === SCREEN_FLOW_ID)!;
  assert.deepEqual(entry.screens.map((s) => s.key).sort(), ['prd__6.1.1', 'prd__6.2.1']);
  assert.equal(entry.screensDropped, undefined);
  // Idempotent: chạy lại trên file đã chuẩn hoá cho cùng kết quả, không warning cell lạ nữa (đã null).
  const again = await finalizeScreenFlowXml(cwd);
  assert.deepEqual(again.errors, []);
  assert.ok(!again.warnings.some((w) => w.includes('od-khong-co')));
  assert.deepEqual(again.discovery!.pages[0]!.screens.map((s) => s.code), ['6.1.1', '6.2.1', '6.3.2', '9.9']);
});

test('finalizeScreenFlowXml: screens.json v1 (cells+names) → KHÔNG đổi file, discovery undefined; screens[] rỗng → lỗi chặn', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
  const dir = path.join(cwd, 'flows', SCREEN_FLOW_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SCREEN_FLOW_CELLS_FILE), GOOD_FRAGMENT);
  const v1 = JSON.stringify({ title: 'T', source: 'docs/prd.md', cells: { 'od-6-1-1': 'prd__6.1.1' }, names: { 'prd__6.1.1': 'Trang chủ' } });
  fs.writeFileSync(path.join(dir, 'screens.json'), v1);
  const r = await finalizeScreenFlowXml(cwd);
  assert.deepEqual(r.errors, []);
  assert.equal(r.discovery, undefined);
  assert.equal(fs.readFileSync(path.join(dir, 'screens.json'), 'utf8'), v1, 'v1 phải byte-identical');

  fs.writeFileSync(path.join(dir, 'screens.json'), JSON.stringify({ title: 'T', screens: [{ name: 'thiếu key' }] }));
  const bad = await finalizeScreenFlowXml(cwd);
  assert.ok(bad.errors.some((e) => e.includes('không có entry hợp lệ')), bad.errors.join(' | '));
});

test('saveScreenFlowEdit: chặn khi chưa có SCREEN-FLOW hoặc XML hỏng; lỗi cấu trúc mềm thành warning', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
  const none = await saveScreenFlowEdit(cwd, '<mxfile><diagram id="d" name="n"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>');
  assert.equal(none.ok, false);
  assert.match(none.errors[0]!, /chưa có flows\/SCREEN-FLOW/);

  const dir = path.join(cwd, 'flows', SCREEN_FLOW_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'as-is.drawio'), '<mxfile/>');
  const empty = await saveScreenFlowEdit(cwd, '<mxfile><diagram id="d" name="n"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>');
  assert.equal(empty.ok, false, 'không còn node nào phải bị chặn');

  // Người dùng kéo 2 node đè lên nhau — validate mềm: vẫn lưu, trả warning.
  const overlapping = (wrapScreenFlowCells(
    [vertex('od-a', 'A', 0, 0), vertex('od-b', 'B', 50, 10), edge('od-e1', 'od-a', 'od-b', 'x')].join('\n'),
  ) as { graphXml: string }).graphXml;
  const soft = await saveScreenFlowEdit(cwd, `<mxfile><diagram id="d" name="n">${overlapping}</diagram></mxfile>`);
  assert.equal(soft.ok, true);
  assert.ok(soft.warnings.some((w) => w.includes('node đè nhau')), soft.warnings.join(' | '));
});

// WP dr-flow-improve: editor gửi mxfile 2 trang (Nguyên bản | Cải thiện).
test('saveScreenFlowEdit 2 trang: trang 1 → proposed.drawio đủ 2 trang + marker proposed.edited.json khi khác bản cũ; trang 0 đổi khi đang có đề xuất → warning; lưu lại y nguyên → không marker mới', async () => {
  const { PROPOSED_EDITED_FILE } = await import('../src/flow-ux/screen-flow-xml.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
  const dir = path.join(cwd, 'flows', SCREEN_FLOW_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SCREEN_FLOW_CELLS_FILE), GOOD_FRAGMENT);
  fs.writeFileSync(path.join(dir, 'screens.json'), JSON.stringify({ title: 'T', source: 'docs/prd.md', cells: { 'od-6-1-1': 'prd__6.1.1' }, names: { 'prd__6.1.1': 'Trang chủ' } }));
  assert.deepEqual((await finalizeScreenFlowXml(cwd)).errors, []);
  const asIsGraph = decodeMxfile(fs.readFileSync(path.join(dir, 'as-is.drawio'), 'utf8'))[0]!.graphXml;
  const proposedGraph = (wrapScreenFlowCells(
    [
      vertex('od-start', 'Bắt đầu', 40, 40, 150, 50),
      vertex('od-6-1-1', '6.1.1 · Trang chủ', 40, 200),
      vertex('od-6-2-1', '6.2.1 · Danh sách gói', 340, 200),
      vertex('od-sys-pay', 'Cổng thanh toán', 640, 200),
      vertex('od-n1', 'Xác nhận (đề xuất)', 640, 400),
      edge('od-e1', 'od-start', 'od-6-1-1', 'Mở app', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;'),
      edge('od-e2', 'od-6-1-1', 'od-6-2-1', 'Mua SIM'),
      edge('od-e3', 'od-6-2-1', 'od-n1', 'Thanh toán'),
      edge('od-e4', 'od-n1', 'od-sys-pay', 'Xác nhận'),
    ].join('\n'),
  ) as { graphXml: string }).graphXml;
  const twoPages = (p0: string, p1: string) =>
    `<mxfile host="embed.diagrams.net"><diagram id="p0" name="Nguyên bản">${p0}</diagram><diagram id="p1" name="Cải thiện">${p1}</diagram></mxfile>`;

  // Lần 1: chưa có proposed.drawio → trang 1 là mới → marker.
  const first = await saveScreenFlowEdit(cwd, twoPages(asIsGraph, proposedGraph));
  assert.equal(first.ok, true, first.errors.join(' | '));
  assert.equal(first.savedProposed, true);
  assert.equal(first.proposedEdited, true);
  assert.ok(!first.warnings.some((w) => w.includes('Nguyên bản đã sửa tay')), 'trang 0 không đổi → không cảnh báo lệch');
  const pages = decodeMxfile(fs.readFileSync(path.join(dir, 'proposed.drawio'), 'utf8'));
  assert.equal(pages.length, 2);
  assert.equal(pages[1]!.name, 'Cải thiện');
  assert.ok(listCells(pages[1]!.graphXml).some((c) => c.id === 'od-n1'));
  assert.ok(fs.existsSync(path.join(dir, PROPOSED_EDITED_FILE)));
  const marker1 = fs.readFileSync(path.join(dir, PROPOSED_EDITED_FILE), 'utf8');

  // Lần 2: gửi lại y nguyên (editor round-trip đổi whitespace) → không phải sửa mới.
  fs.rmSync(path.join(dir, PROPOSED_EDITED_FILE));
  const same = await saveScreenFlowEdit(cwd, twoPages(asIsGraph, proposedGraph.replace(/\n\s*/g, '\n')));
  assert.equal(same.ok, true);
  assert.equal(same.proposedEdited, false);
  assert.ok(!fs.existsSync(path.join(dir, PROPOSED_EDITED_FILE)), 'không đổi trang 1 → không ghi marker');
  void marker1;

  // Lần 3: trang 0 đổi nhãn trong khi đang có đề xuất → warning lệch; trang 1 giữ.
  const movedAsIs = asIsGraph.replace('value="Bắt đầu"', 'value="Bắt đầu (đã sửa)"');
  const third = await saveScreenFlowEdit(cwd, twoPages(movedAsIs, proposedGraph));
  assert.equal(third.ok, true);
  assert.ok(third.warnings.some((w) => w.includes('Nguyên bản đã sửa tay')), third.warnings.join(' | '));
  const pages3 = decodeMxfile(fs.readFileSync(path.join(dir, 'proposed.drawio'), 'utf8'));
  assert.ok(listCells(pages3[0]!.graphXml).some((c) => c.label === 'Bắt đầu (đã sửa)'), 'trang 0 của proposed.drawio theo as-is mới');

  // Lần 4: chỉ gửi 1 trang khi đang có đề xuất → giữ trang 1, thay trang 0.
  const only0 = await saveScreenFlowEdit(cwd, `<mxfile><diagram id="p0" name="n">${asIsGraph}</diagram></mxfile>`);
  assert.equal(only0.ok, true);
  assert.equal(only0.savedProposed, false);
  const pages4 = decodeMxfile(fs.readFileSync(path.join(dir, 'proposed.drawio'), 'utf8'));
  assert.equal(pages4.length, 2);
  assert.ok(listCells(pages4[1]!.graphXml).some((c) => c.id === 'od-n1'));
  assert.ok(!listCells(pages4[0]!.graphXml).some((c) => c.label === 'Bắt đầu (đã sửa)'));
});

test('normalizeWaypoints: <Object x y/> trong Array points → <mxPoint/> (wrap lẫn save), không đụng thẻ khác', async () => {
  const { normalizeWaypoints } = await import('../src/flow-ux/screen-flow-xml.js');
  const bad =
    '<mxCell id="od-e1" edge="1" parent="1" source="od-a" target="od-b" style="edgeStyle=orthogonalEdgeStyle;">\n' +
    '  <mxGeometry relative="1" as="geometry">\n' +
    '    <Array as="points">\n      <Object x="680" y="1630"/>\n      <Object x="360" y="1630" />\n    </Array>\n' +
    '  </mxGeometry>\n</mxCell>';
  const fixed = normalizeWaypoints(bad);
  assert.equal((fixed.match(/<mxPoint /g) ?? []).length, 2);
  assert.ok(!fixed.includes('<Object'));
  // Object ngoài Array points (không phải waypoint) giữ nguyên.
  assert.equal(normalizeWaypoints('<Object x="1" y="2"/>'), '<Object x="1" y="2"/>');
  // wrap sửa luôn cho bản agent…
  const wrapped = wrapScreenFlowCells([vertex('od-a', 'A', 0, 0), vertex('od-b', 'B', 300, 0), bad].join('\n')) as { graphXml: string };
  assert.ok(wrapped.graphXml.includes('<mxPoint x="680" y="1630"/>'));
  assert.ok(!wrapped.graphXml.includes('<Object'));
  // …và save cũng sửa cho bản editor round-trip.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
  const dir = path.join(cwd, 'flows', SCREEN_FLOW_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'as-is.drawio'), '<mxfile/>');
  const graph = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${vertex('od-a', 'A', 0, 0)}${vertex('od-b', 'B', 300, 0)}${bad}</root></mxGraphModel>`;
  const saved = await saveScreenFlowEdit(cwd, `<mxfile><diagram id="d" name="n">${graph}</diagram></mxfile>`);
  assert.equal(saved.ok, true, saved.errors.join(' | '));
  const onDisk = fs.readFileSync(path.join(dir, 'as-is.drawio'), 'utf8');
  assert.ok(onDisk.includes('<mxPoint'));
  assert.ok(!onDisk.includes('<Object'));
});

test('legend od-legend-*: validator không cảnh báo cô lập / không bắt đè nhau nội bộ; flowchart.json loại hẳn cell chú thích', async () => {
  const { drawioPageToFlowchart } = await import('../src/flow-ux/to-flowchart.js');
  const legend = [
    `<mxCell id="od-legend-box" value="" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#9e9e9e;" vertex="1" parent="1"><mxGeometry x="1000" y="40" width="260" height="400" as="geometry"/></mxCell>`,
    `<mxCell id="od-legend-screen" value="Màn hình người dùng" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="1016" y="80" width="130" height="36" as="geometry"/></mxCell>`,
    `<mxCell id="od-legend-p1a" value="" style="ellipse;fillColor=#666666;strokeColor=none;" vertex="1" parent="1"><mxGeometry x="1016" y="370" width="6" height="6" as="geometry"/></mxCell>`,
    `<mxCell id="od-legend-p1b" value="" style="ellipse;fillColor=#666666;strokeColor=none;" vertex="1" parent="1"><mxGeometry x="1120" y="370" width="6" height="6" as="geometry"/></mxCell>`,
    edge('od-legend-e1', 'od-legend-p1a', 'od-legend-p1b', 'Hành động người dùng'),
  ].join('\n');
  const wrapped = wrapScreenFlowCells(`${GOOD_FRAGMENT}\n${legend}`) as { graphXml: string };
  const v = validateScreenFlowGraph(wrapped.graphXml);
  assert.deepEqual(v.errors, [], v.errors.join(' | ')); // mẫu đè lên hộp legend = chủ ý
  assert.deepEqual(v.warnings, [], v.warnings.join(' | ')); // od-legend-screen cô lập nhưng không cảnh báo
  const chart = drawioPageToFlowchart(wrapped.graphXml, { id: 'SCREEN-FLOW', title: 't', source: 's' }, {});
  assert.ok(chart.nodes.every((n) => !n.id.startsWith('od-legend-')), 'legend không thành bước');
  assert.ok(chart.edges.every((e) => !e.from.startsWith('od-legend-')), 'cạnh legend không vào flowchart');
  assert.equal(chart.nodes.length, 4);
  // Legend đè lên node THẬT vẫn là lỗi.
  const bad = wrapScreenFlowCells(
    `${GOOD_FRAGMENT}\n<mxCell id="od-legend-box" value="" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="50" y="210" width="260" height="400" as="geometry"/></mxCell>`,
  ) as { graphXml: string };
  assert.ok(validateScreenFlowGraph(bad.graphXml).errors.some((e) => e.includes('node đè nhau')));
});
