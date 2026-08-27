// Bước `dr-flow` bản mới (skill docs-flow-ux): daemon giải nén sơ đồ gốc → agent
// đánh giá → daemon áp patch, sinh flowchart.json, dựng index. Test các mảnh
// thuần (mxfile / patch / to-flowchart / mermaid-detect) và một vòng
// prepare → (giả lập agent) → finalize trên thư mục tạm.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { decodeMxfile, encodeMxfile, listCells, loadGraph } from '../src/flow-ux/mxfile.js';
import { applyPatch, parsePatchDoc } from '../src/flow-ux/patch.js';
import { drawioPageToFlowchart, mermaidToFlowchart, resolveScreenCells } from '../src/flow-ux/to-flowchart.js';
import { findEmbeddedMermaid, replaceCreateViewerCalls } from '../src/flow-ux/mermaid-detect.js';
import { finalizeFlowUx, prepareFlowUxInputs, slugify } from '../src/flow-ux/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'flow-ux');
const DRAWIO = fs.readFileSync(path.join(FIXTURES, 'sample-compressed.drawio'), 'utf8');
const MERMAID = fs.readFileSync(path.join(FIXTURES, 'sim-du-lich.mmd'), 'utf8');

test('mxfile: giải nén trang deflate+base64 lẫn trang plain, giữ id/tên trang', () => {
  const pages = decodeMxfile(DRAWIO);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((p) => [p.id, p.name]), [['p1', 'Mua SIM du lịch'], ['p2', 'Xuất đơn']]);
  assert.match(pages[0]!.graphXml, /^<mxGraphModel\b/);
  const cells = listCells(pages[0]!.graphXml);
  assert.equal(cells.filter((c) => c.kind === 'vertex').length, 10);
  assert.equal(cells.filter((c) => c.kind === 'edge').length, 12);
  // Nhãn chữ thuần (entity đã giải), object wrapper giữ id + custom attrs.
  assert.equal(cells.find((c) => c.id === 's1')?.label, 'Chọn Mua SIM > SIM Du lịch');
  assert.deepEqual(cells.find((c) => c.id === 's2')?.attrs, { placeholders: '1' });
  // Encode lại là mxfile plain, decode được y nguyên.
  const again = decodeMxfile(encodeMxfile(pages));
  assert.equal(again.length, 2);
  assert.equal(listCells(again[0]!.graphXml).length, cells.length);
});

test('patch: relabel/mark/addNode/addEdge/redirectEdge → cell tô màu + od-change/od-finding, legend, op sai bị skip', () => {
  const page = decodeMxfile(DRAWIO)[0]!;
  const patch = parsePatchDoc(
    JSON.stringify({
      ops: [
        { op: 'relabel', cell: 's1', label: 'Chọn Mua SIM → "SIM Du lịch" & tab', finding: 'UX-01' },
        { op: 'mark', cell: 'timeout', change: 'removed', finding: 'UX-02' },
        { op: 'addNode', id: 'od-n1', shape: 'action', label: 'Báo hoàn tiền', near: 'timeout', dir: 'below', finding: 'UX-02' },
        { op: 'addEdge', id: 'od-e1', from: 'timeout', to: 'od-n1', finding: 'UX-02' },
        { op: 'redirectEdge', edge: 'e12', from: 'od-n1', finding: 'UX-02' },
        { op: 'mark', cell: 'khong-co', change: 'modified' },
        { op: 'addNode', id: 'od-n2', shape: 'action', label: 'x', near: 'khong-co' },
      ],
    }),
  );
  const r = applyPatch(page.graphXml, patch);
  assert.equal(r.applied, 5);
  assert.equal(r.skipped.length, 2);
  const cells = listCells(r.graphXml);
  const s1 = cells.find((c) => c.id === 's1')!;
  assert.equal(s1.label, 'Chọn Mua SIM → "SIM Du lịch" & tab');
  // WP dr-flow-edit-highlight: thay đổi = viền màu, KHÔNG tô fill.
  assert.match(s1.style, /strokeColor=#B7791F;strokeWidth=3;fontStyle=1;/);
  assert.doesNotMatch(s1.style, /fillColor=#FFF2CC/);
  assert.deepEqual(s1.attrs, { 'od-change': 'modified', 'od-finding': 'UX-01' });
  const to = cells.find((c) => c.id === 'timeout')!;
  assert.match(to.style, /strokeColor=#C0392B/);
  assert.match(to.style, /strokeWidth=3/);
  assert.match(to.style, /dashed=1/);
  assert.doesNotMatch(to.style, /fillColor=#F8CECC/);
  const n1 = cells.find((c) => c.id === 'od-n1')!;
  assert.equal(n1.kind, 'vertex');
  assert.match(n1.style, /fillColor=#FFFFFF/);
  assert.match(n1.style, /strokeColor=#1B7F3B/);
  assert.match(n1.style, /strokeWidth=3/);
  assert.match(n1.style, /fontStyle=1/);
  assert.ok((n1.y ?? 0) > (to.y ?? 0), 'node mới đặt dưới cell mốc');
  const e1 = cells.find((c) => c.id === 'od-e1')!;
  assert.equal(e1.source, 'timeout');
  assert.equal(e1.target, 'od-n1');
  assert.match(e1.style, /strokeColor=#1B7F3B/);
  assert.match(e1.style, /strokeWidth=4/);
  const e12 = cells.find((c) => c.id === 'e12')!;
  assert.equal(e12.source, 'od-n1');
  assert.deepEqual(e12.attrs, { 'od-change': 'modified', 'od-finding': 'UX-02' });
  assert.match(e12.style, /strokeColor=#B7791F/);
  assert.match(e12.style, /strokeWidth=4/);
  assert.ok(cells.some((c) => c.id === 'od-legend-added'), 'có legend');
  // Legend: ô trắng viền màu theo loại, tiêu đề nêu rõ "viền màu".
  const legendTitle = cells.find((c) => c.id === 'od-legend-title')!;
  assert.equal(legendTitle.label, 'Chú giải đề xuất UX — viền màu');
  const legendAdded = cells.find((c) => c.id === 'od-legend-added')!;
  assert.match(legendAdded.style, /fillColor=#FFFFFF/);
  assert.match(legendAdded.style, /strokeColor=#1B7F3B;strokeWidth=3;fontStyle=1;/);
  const legendModified = cells.find((c) => c.id === 'od-legend-modified')!;
  assert.match(legendModified.style, /fillColor=#FFFFFF/);
  assert.match(legendModified.style, /strokeColor=#B7791F;strokeWidth=3;fontStyle=1;/);
  const legendRemoved = cells.find((c) => c.id === 'od-legend-removed')!;
  assert.match(legendRemoved.style, /fillColor=#FFFFFF/);
  assert.match(legendRemoved.style, /strokeColor=#C0392B;strokeWidth=3;fontStyle=1;dashed=1;/);
  // XML còn parse được, entity không bị escape kép.
  const $ = loadGraph(r.graphXml);
  assert.equal($('object[id="s1"]').attr('label'), 'Chọn Mua SIM → &quot;SIM Du lịch&quot; &amp; tab');
  // Bản gốc không bị đụng.
  assert.equal(listCells(page.graphXml).find((c) => c.id === 's1')?.attrs, undefined);
});

test('patch: viền màu GIỮ fill cũ của template — relabel/mark trên vertex fillColor=#dae8fc vẫn #dae8fc, stroke template bị ghi đè; addNode mới fill trắng; cạnh strokeWidth=4', () => {
  const vertex = (id: string, x: number) =>
    `<mxCell id="${id}" value="${id}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="${x}" y="100" width="160" height="60" as="geometry"/></mxCell>`;
  const graph =
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    vertex('a', 0) +
    vertex('b', 300) +
    vertex('c', 600) +
    '<mxCell id="ab" style="edgeStyle=orthogonalEdgeStyle;html=1;strokeColor=#666666;strokeWidth=1;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const r = applyPatch(graph, {
    ops: [
      { op: 'relabel', cell: 'a', label: 'A mới' },
      { op: 'mark', cell: 'b', change: 'modified' },
      { op: 'mark', cell: 'c', change: 'removed' },
      { op: 'addNode', id: 'n', shape: 'action', label: 'Mới', near: 'c', dir: 'below' },
      { op: 'addEdge', id: 'cn', from: 'c', to: 'n' },
      { op: 'redirectEdge', edge: 'ab', to: 'c' },
    ],
  });
  assert.equal(r.applied, 6);
  const by = new Map(listCells(r.graphXml).map((c) => [c.id, c]));
  // relabel → modified: giữ fill, đổi stroke template #6c8ebf → #B7791F.
  const a = by.get('a')!;
  assert.match(a.style, /fillColor=#dae8fc/);
  assert.match(a.style, /strokeColor=#B7791F;strokeWidth=3;fontStyle=1;/);
  assert.doesNotMatch(a.style, /#6c8ebf/);
  assert.doesNotMatch(a.style, /dashed/);
  // mark modified: y hệt relabel về style.
  const b = by.get('b')!;
  assert.match(b.style, /fillColor=#dae8fc/);
  assert.match(b.style, /strokeColor=#B7791F;strokeWidth=3;fontStyle=1;/);
  // mark removed: giữ fill + dashed + đỏ.
  const c = by.get('c')!;
  assert.match(c.style, /fillColor=#dae8fc/);
  assert.match(c.style, /strokeColor=#C0392B/);
  assert.match(c.style, /strokeWidth=3/);
  assert.match(c.style, /dashed=1/);
  assert.match(c.style, /fontStyle=1/);
  // addNode: nền trắng + viền xanh đậm.
  const n = by.get('n')!;
  assert.match(n.style, /fillColor=#FFFFFF/);
  assert.match(n.style, /strokeColor=#1B7F3B;strokeWidth=3;fontStyle=1;/);
  assert.doesNotMatch(n.style, /dashed/);
  // addEdge: xanh, width 4; redirectEdge → modified: vàng đậm, width 4, ghi đè stroke cũ.
  const cn = by.get('cn')!;
  assert.match(cn.style, /strokeColor=#1B7F3B;strokeWidth=4;/);
  const ab = by.get('ab')!;
  assert.equal(ab.target, 'c');
  assert.match(ab.style, /strokeColor=#B7791F;strokeWidth=4;/);
  assert.doesNotMatch(ab.style, /#666666/);
  assert.doesNotMatch(ab.style, /strokeWidth=1;/);
  // Không cell thay đổi nào mang palette fill cũ.
  for (const cell of by.values()) assert.doesNotMatch(cell.style, /D5E8D4|FFF2CC|F8CECC|82B366|D6B656|B85450/);
});

test('to-flowchart: draw.io — ellipse đầu/cuối, rhombus = decision, cạnh có nhãn, screens merge', () => {
  const page = decodeMxfile(DRAWIO)[0]!;
  const fc = drawioPageToFlowchart(page.graphXml, { id: 'FLOW-x', title: 't', source: 's.md' }, { s1: 'doc__SCR-001' });
  const byId = new Map(fc.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('start')?.type, 'start');
  assert.equal(byId.get('end')?.type, 'end');
  assert.equal(byId.get('d1')?.type, 'decision');
  assert.equal(byId.get('s1')?.type, 'action');
  assert.equal(byId.get('s1')?.screen, 'doc__SCR-001');
  assert.equal(fc.edges.length, 12);
  assert.deepEqual(fc.edges.find((e) => e.from === 'd1' && e.to === 's3'), { from: 'd1', to: 's3', label: 'Việt Nam' });
});

test('to-flowchart: Mermaid thật (SIM du lịch) — 28 node / 35 cạnh, nhãn `-- text -->` và `([…])`/`{…}` đúng loại', () => {
  const fc = mermaidToFlowchart(MERMAID, { id: 'FLOW-m', title: 'm', source: 'm.mmd' });
  assert.ok(fc);
  assert.equal(fc!.nodes.length, 28);
  assert.equal(fc!.edges.length, 35);
  const byId = new Map(fc!.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('A')?.type, 'start');
  assert.equal(byId.get('End')?.type, 'end');
  assert.equal(byId.get('C_Type')?.type, 'decision');
  assert.equal(byId.get('C')?.label, 'Tìm kiếm & Chọn Quốc gia / Khu vực');
  assert.equal(byId.get('J1')?.label, 'Nhập: • Họ tên • SĐT liên hệ • Email nhận QR');
  assert.deepEqual(fc!.edges.find((e) => e.from === 'C_Type' && e.to === 'C'), { from: 'C_Type', to: 'C', label: 'SIM du lịch Quốc tế' });
  assert.deepEqual(fc!.edges.find((e) => e.from === 'D' && e.to === 'E1'), { from: 'D', to: 'E1', label: 'eSIM' });
  // Không phải flowchart → null.
  assert.equal(mermaidToFlowchart('sequenceDiagram\n A->>B: hi', { id: 'x', title: 'x', source: 'x' }), null);
});

test('mermaid-detect: createViewer(...) xuất từ Confluence — lấy title + SVG (backtick escape kiểu markdown) + nguồn từ attachment cùng tên; thay bằng ảnh + link', () => {
  const svg = '&lt;svg xmlns=&quot;http://www.w3.org/2000/svg&quot; viewBox=&quot;0 0 10 10&quot;&gt;&lt;g&gt;&lt;/g&gt;&lt;/svg&gt;';
  const md = `# Trang\n\n### 3.1 Luồng\n\ncreateViewer('abc', 'Luồng người dùng', 'fit', 'bottom', \\\`${svg}\\\`);\n\n### 3.2 Mô tả\n`;
  const att = new Map([['Luồng người dùng', 'flowchart TD\n  A --> B']]);
  const found = findEmbeddedMermaid(md, att);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.title, 'Luồng người dùng');
  assert.match(found[0]!.svg ?? '', /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal(found[0]!.code, 'flowchart TD\n  A --> B');
  const out = replaceCreateViewerCalls(md, () => ({ svgRel: 'attachments/luong.svg', codeRel: 'attachments/luong.mmd' }));
  assert.ok(!out.includes('createViewer('));
  assert.ok(out.includes('![flow-diagram Luồng người dùng](attachments/luong.svg)'));
  assert.ok(out.includes('[attachments/luong.mmd](attachments/luong.mmd)'));
  assert.ok(out.includes('### 3.2 Mô tả'));
  // Fence ```mermaid cũng nhận, đặt tên theo heading gần nhất.
  const fenced = findEmbeddedMermaid('## Luồng đăng nhập\n\n```mermaid\nflowchart LR\n A-->B\n```\n');
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0]!.title, 'Luồng đăng nhập');
});

test('slugify: bỏ dấu, đ→d, gọn', () => {
  assert.equal(slugify('Luồng người dùng'), 'luong-nguoi-dung');
  assert.equal(slugify('Mua SIM du lịch — trang 2'), 'mua-sim-du-lich-trang-2');
});

test('prepare → (agent) → finalize: drawio + mermaid nhúng; proposed.drawio 2 trang, flowchart.json, index.json, md được chuẩn hoá', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-'));
  try {
    const dir = path.join(cwd, 'docs-feature', 'sim');
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'sample-compressed.drawio'), path.join(dir, 'attachments', '12345-Luong-mua-sim.drawio'));
    fs.writeFileSync(path.join(dir, 'doc2.md'), '# Doc 2\n\n![flow-diagram Luong](attachments/12345-Luong-mua-sim.drawio)\n');
    fs.writeFileSync(path.join(dir, 'attachments', 'Luồng người dùng'), MERMAID);
    const svg = '&lt;svg xmlns=&quot;http://www.w3.org/2000/svg&quot;&gt;&lt;/svg&gt;';
    fs.writeFileSync(path.join(dir, 'prd.md'), `# PRD\n\ncreateViewer('x', 'Luồng người dùng', 'fit', 'bottom', \\\`${svg}\\\`);\n\n## 3.2\n`);

    const prep = await prepareFlowUxInputs(cwd);
    const ids = prep.inputs.map((i) => i.id).sort();
    assert.deepEqual(ids, ['FLOW-luong-nguoi-dung', 'FLOW-mua-sim-du-lich']); // trang "Xuất đơn" chỉ 1 ô → không phải luồng
    assert.deepEqual(prep.normalizedPages, ['docs-feature/sim/prd.md']);
    assert.ok(fs.existsSync(path.join(cwd, 'flows', 'FLOW-mua-sim-du-lich', 'as-is.drawio')));
    assert.ok(fs.existsSync(path.join(cwd, 'flows', 'FLOW-mua-sim-du-lich', 'cells.json')));
    assert.ok(fs.existsSync(path.join(cwd, 'flows', 'FLOW-luong-nguoi-dung', 'as-is.mmd')));
    assert.ok(fs.existsSync(path.join(cwd, 'flows', 'FLOW-luong-nguoi-dung', 'as-is.svg')));
    const prd = fs.readFileSync(path.join(dir, 'prd.md'), 'utf8');
    assert.ok(!prd.includes('createViewer('));
    assert.ok(prd.includes('![flow-diagram Luồng người dùng](attachments/luong-nguoi-dung.svg)'));
    assert.ok(fs.existsSync(path.join(dir, 'attachments', 'luong-nguoi-dung.mmd')));
    const drawioInput = prep.inputs.find((i) => i.kind === 'drawio')!;
    assert.equal(drawioInput.source, 'docs-feature/sim/doc2.md');
    assert.equal(prep.inputs.find((i) => i.kind === 'mermaid')!.source, 'docs-feature/sim/prd.md');

    // Agent giả lập.
    const fdir = path.join(cwd, 'flows', 'FLOW-mua-sim-du-lich');
    fs.writeFileSync(
      path.join(fdir, 'patch.json'),
      JSON.stringify({ ops: [{ op: 'addNode', id: 'od-n1', shape: 'action', label: 'Báo hoàn tiền', near: 'timeout', finding: 'UX-01' }, { op: 'addEdge', id: 'od-e1', from: 'timeout', to: 'od-n1', finding: 'UX-01' }, { op: 'mark', cell: 'nope', change: 'modified' }] }),
    );
    fs.writeFileSync(
      path.join(fdir, 'ux-review.json'),
      JSON.stringify({ summary: 'thiếu phản hồi', findings: [{ severity: 'major', title: 'Timeout mù', reason: 'x', cells: { asIs: ['timeout'], proposed: ['od-n1'] }, change: 'added' }, { severity: 'lạ', title: 'nhỏ', reason: 'y' }] }),
    );
    fs.writeFileSync(
      path.join(fdir, 'screens.json'),
      JSON.stringify({
        cells: { s1: 'doc2__SCR-001' },
        names: { 'doc2__SCR-001': 'Trang chủ' },
        note: 'ghi chú',
        meta: {
          'doc2__SCR-001': {
            provenance: 'inferred-flow',
            confidence: 0.82,
            evidence: { source: 'docs-feature/sim/doc2.md', diagramEvidence: [{ cellId: 's1', label: 'Trang chủ' }] },
          },
        },
      }),
    );
    const mdir = path.join(cwd, 'flows', 'FLOW-luong-nguoi-dung');
    fs.writeFileSync(path.join(mdir, 'ux-review.json'), JSON.stringify({ verdict: 'good', summary: 'ok', findings: [] }));
    // Một luồng text-only agent tự viết.
    fs.writeFileSync(
      path.join(cwd, 'flows', 'FLOW-text.flowchart.json'),
      JSON.stringify({ id: 'FLOW-text', title: 'Text', source: 'docs-feature/sim/doc2.md', nodes: [{ id: 'n1', type: 'start', label: 'a' }, { id: 'n2', type: 'end', label: 'b' }], edges: [{ from: 'n1', to: 'n2' }] }),
    );

    const fin = await finalizeFlowUx(cwd);
    const byId = new Map(fin.index.map((e) => [e.id, e]));
    assert.deepEqual([...byId.keys()].sort(), ['FLOW-luong-nguoi-dung', 'FLOW-mua-sim-du-lich', 'FLOW-text']);
    const d = byId.get('FLOW-mua-sim-du-lich')!;
    assert.equal(d.kind, 'drawio');
    assert.equal(d.hasProposal, true);
    assert.equal(d.verdict, 'needs-improvement'); // suy từ severity khi agent quên verdict
    assert.equal(d.findings, 2);
    assert.equal(d.note, 'ghi chú');
    assert.deepEqual(d.screens, [{
      key: 'doc2__SCR-001',
      name: 'Trang chủ',
      provenance: 'inferred-flow',
      confidence: 0.82,
      evidence: { source: 'docs-feature/sim/doc2.md', diagramEvidence: [{ cellId: 's1', label: 'Trang chủ' }] },
    }]);
    assert.equal(d.patchSkipped?.length, 1);
    const proposed = fs.readFileSync(path.join(fdir, 'proposed.drawio'), 'utf8');
    assert.equal((proposed.match(/<diagram /g) ?? []).length, 2);
    assert.match(proposed, /name="Hiện trạng"/);
    assert.match(proposed, /name="Đề xuất"/);
    assert.match(proposed, /od-change="added"/);
    // ux-review được chuẩn hoá: id tự đánh, severity lạ → minor.
    const review = JSON.parse(fs.readFileSync(path.join(fdir, 'ux-review.json'), 'utf8'));
    assert.deepEqual(review.findings.map((f: { id: string; severity: string }) => [f.id, f.severity]), [['UX-01', 'major'], ['UX-02', 'minor']]);
    // flowchart.json từ nguồn + screens.
    const fc = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', 'FLOW-mua-sim-du-lich.flowchart.json'), 'utf8'));
    assert.equal(fc.nodes.find((n: { id: string }) => n.id === 's1').screen, 'doc2__SCR-001');
    const mfc = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', 'FLOW-luong-nguoi-dung.flowchart.json'), 'utf8'));
    assert.equal(mfc.nodes.length, 28);
    const m = byId.get('FLOW-luong-nguoi-dung')!;
    assert.equal(m.kind, 'mermaid');
    assert.equal(m.verdict, 'good');
    assert.equal(m.files?.svg, 'flows/FLOW-luong-nguoi-dung/as-is.svg');
    assert.equal(byId.get('FLOW-text')!.kind, 'text');
    // index.json là mảng (viewer cũ đọc `[].screens`).
    const index = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', 'index.json'), 'utf8'));
    assert.ok(Array.isArray(index));
    assert.equal(index.length, 3);
    // Prepare lần 2 (re-run) không nhân đôi, không sửa md nữa.
    const prep2 = await prepareFlowUxInputs(cwd);
    assert.deepEqual(prep2.inputs.map((i) => i.id).sort(), ids);
    assert.deepEqual(prep2.normalizedPages, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('text-only: agent tự vẽ flows/<id>/as-is.mmd (+ proposed.mmd, screens.json có title/source) → finalize coi như luồng Mermaid: flowchart.json suy ra, index kind=mermaid, title/source từ screens.json', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-text-'));
  try {
    fs.mkdirSync(path.join(cwd, 'docs-feature'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'docs-feature', 'urd.md'), '# URD Mua sim thường\n\n## 5.1 Luồng cơ bản\n1. KH mở SDK…\n');
    const prep = await prepareFlowUxInputs(cwd);
    assert.equal(prep.inputs.length, 0, 'không có sơ đồ trong tài liệu');
    // Agent (giả lập): MỘT sơ đồ TD đầy đủ theo mẫu URD + đề xuất + screens.
    const fdir = path.join(cwd, 'flows', 'FLOW-mua-sim');
    fs.mkdirSync(fdir, { recursive: true });
    const asIs = [
      'flowchart TD',
      '    A([Bắt đầu: Mở SDK Viễn thông]) --> B[Trang chủ SDK (4.1.1)]',
      '    B --> C{Chọn loại SIM?}',
      '    %% NHÁNH 1',
      '    C -- "SIM giá rẻ" --> D[Màn Chọn số (4.2.1)]',
      '    C -- "SIM Data" --> E[Màn Chọn gói cước - SIM Data (4.3.1)]',
      '    D --> F[Màn Nhập thông tin & thanh toán (4.4.1)]',
      '    E --> F',
      '    F --> G{Kết quả thanh toán?}',
      '    G -- "Thành công" --> H["Billing gạch nợ<br>-> SDK BE tạo đơn"]',
      '    G -- "Thất bại" --> I[Thông báo thất bại]',
      '    H --> End([Kết thúc])',
      '    I --> End',
    ].join('\n');
    fs.writeFileSync(path.join(fdir, 'as-is.mmd'), asIs);
    fs.writeFileSync(path.join(fdir, 'proposed.mmd'), `${asIs}\n    G -- "Timeout" --> OD_T[Billing revert tiền & báo KH]\n    OD_T --> End\n    classDef od-added fill:#D5E8D4,stroke:#82B366\n    class OD_T od-added\n`);
    fs.writeFileSync(
      path.join(fdir, 'screens.json'),
      JSON.stringify({
        title: 'Mua SIM trên SDK Viễn thông',
        source: 'docs-feature/urd.md',
        cells: { B: 'urd__4.1.1', D: 'urd__4.2.1', F: 'urd__4.4.1' },
        names: { 'urd__4.1.1': 'Trang chủ', 'urd__4.2.1': 'Chọn số', 'urd__4.4.1': 'Nhập thông tin & thanh toán' },
      }),
    );
    fs.writeFileSync(path.join(fdir, 'ux-review.json'), JSON.stringify({ verdict: 'needs-improvement', summary: 'thiếu nhánh timeout', findings: [{ severity: 'major', title: 'Timeout mù', reason: 'r', cells: { asIs: ['G'] } }] }));

    const fin = await finalizeFlowUx(cwd);
    assert.deepEqual(fin.warnings, []);
    assert.equal(fin.index.length, 1);
    const e = fin.index[0]!;
    assert.equal(e.id, 'FLOW-mua-sim');
    assert.equal(e.kind, 'mermaid');
    assert.equal(e.title, 'Mua SIM trên SDK Viễn thông');
    assert.equal(e.source, 'docs-feature/urd.md');
    assert.equal(e.hasProposal, true);
    assert.equal(e.files?.asIs, 'flows/FLOW-mua-sim/as-is.mmd');
    assert.equal(e.files?.proposed, 'flows/FLOW-mua-sim/proposed.mmd');
    assert.equal(e.files?.flowchart, 'flows/FLOW-mua-sim.flowchart.json');
    assert.deepEqual(e.screens.map((s) => s.key), ['urd__4.1.1', 'urd__4.2.1', 'urd__4.4.1']);
    const fc = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', 'FLOW-mua-sim.flowchart.json'), 'utf8'));
    assert.equal(fc.title, 'Mua SIM trên SDK Viễn thông');
    assert.equal(fc.nodes.length, 10);
    assert.equal(fc.edges.length, 11);
    assert.equal(fc.nodes.find((n: { id: string }) => n.id === 'A').type, 'start');
    assert.equal(fc.nodes.find((n: { id: string }) => n.id === 'End').type, 'end');
    assert.equal(fc.nodes.find((n: { id: string }) => n.id === 'C').type, 'decision');
    assert.equal(fc.nodes.find((n: { id: string }) => n.id === 'B').screen, 'urd__4.1.1');
    // Không có flowchart.json cũ nào bị coi là luồng "text" trùng.
    assert.equal(fin.index.filter((x) => x.kind === 'text').length, 0);
    const review = JSON.parse(fs.readFileSync(path.join(fdir, 'ux-review.json'), 'utf8'));
    assert.equal(review.findings[0].id, 'UX-01');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('prepare: trang do ingest Confluence mới viết (ảnh SVG + fence ```mermaid + <pageId>-<slug>.mmd/.svg trong attachments) → ĐÚNG MỘT luồng, tiêu đề theo heading, có as-is.svg', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-'));
  try {
    const dir = path.join(cwd, 'docs-feature', 'sim');
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'attachments', '1008831307-Luong-nguoi-dung.mmd'), MERMAID);
    fs.writeFileSync(path.join(dir, 'attachments', '1008831307-Luong-nguoi-dung.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>');
    fs.writeFileSync(
      path.join(dir, 'prd.md'),
      `# PRD\n\n### 3.1 Luồng sơ đồ\n\n![flow-diagram Luồng người dùng](attachments/1008831307-Luong-nguoi-dung.svg)\n\n\`\`\`mermaid\n${MERMAID}\n\`\`\`\n\n*flow-diagram — nguồn: [x](attachments/1008831307-Luong-nguoi-dung.mmd)*\n\n### 3.2 Mô tả\n`,
    );
    const prep = await prepareFlowUxInputs(cwd);
    assert.equal(prep.inputs.length, 1, JSON.stringify(prep.inputs.map((i) => [i.id, i.title])));
    const flow = prep.inputs[0]!;
    assert.equal(flow.kind, 'mermaid');
    assert.equal(flow.title, '3.1 Luồng sơ đồ');
    assert.equal(flow.source, 'docs-feature/sim/prd.md');
    assert.ok(fs.existsSync(path.join(cwd, 'flows', flow.id, 'as-is.mmd')));
    assert.ok(fs.existsSync(path.join(cwd, 'flows', flow.id, 'as-is.svg')));
    // Không có createViewer nên trang không bị viết lại.
    assert.deepEqual(prep.normalizedPages, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Sự cố #5d13309f: dr-flow nuốt mapping màn trỏ vào cạnh, patch bỏ near là
// cạnh, sơ đồ mồ côi vẫn tốn lượt agent, warnings không tới người dùng. ──────

test('resolveScreenCells: mapping vào cạnh quy về node đích/nguồn; explicit decision mapping được giữ; id lạ vẫn dropped', () => {
  const nodes = [
    { id: 'a', type: 'start' as const },
    { id: 'b', type: 'action' as const },
    { id: 'c', type: 'decision' as const },
    { id: 'd', type: 'action' as const },
  ];
  const edges = [
    { id: 'e1', from: 'a', to: 'b' }, // đích b là action → gắn thẳng vào b
    { id: 'e2', from: 'd', to: 'c' }, // đích c là decision → lùi về nguồn d
  ];
  const { byNode, dropped } = resolveScreenCells(
    { nodes, edges },
    { e1: 'doc__MH1', e2: 'doc__MH2', zzz: 'doc__MH3', c: 'doc__MH4' },
  );
  assert.deepEqual(byNode, { b: 'doc__MH1', d: 'doc__MH2', c: 'doc__MH4' });
  assert.deepEqual(
    dropped.sort((x, y) => x.cell.localeCompare(y.cell)),
    [{ cell: 'zzz', key: 'doc__MH3', reason: 'không có trong sơ đồ' }],
  );
});

test('resolveScreenCells: WP9b — cạnh TRÔI (không source/target) bị dropped với lý do đúng bản chất, không lẫn với "không có trong sơ đồ"', () => {
  const nodes = [
    { id: 'a', type: 'start' as const },
    { id: 'b', type: 'action' as const },
  ];
  // 'floaty' là cạnh CÓ id thật trong sơ đồ (sequence, vẽ theo toạ độ) nhưng
  // không có source/target — khác hẳn 'zzz' (id không tồn tại trong sơ đồ).
  const edges = [
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'floaty' },
  ];
  const { byNode, dropped } = resolveScreenCells({ nodes, edges }, { e1: 'doc__MH1', floaty: 'doc__MH2', zzz: 'doc__MH3' });
  assert.deepEqual(byNode, { b: 'doc__MH1' });
  assert.deepEqual(
    dropped.sort((x, y) => x.cell.localeCompare(y.cell)),
    [
      { cell: 'floaty', key: 'doc__MH2', reason: 'là cạnh không nối hai đỉnh (sơ đồ kiểu sequence)' },
      { cell: 'zzz', key: 'doc__MH3', reason: 'không có trong sơ đồ' },
    ],
  );
});

// ── Bổ sung sau review: resolveScreenCells mất mapping ÂM THẦM khi hai khoá
// cùng quy về MỘT node (`byNode[target] = key` ghi đè không cảnh báo). ──────

test('resolveScreenCells: hai khoá cùng quy về MỘT node — mapping TRỎ THẲNG thắng mapping suy ra từ cạnh, khoá thua vào dropped có lý do', () => {
  const nodes = [
    { id: 'a', type: 'start' as const },
    { id: 'b', type: 'action' as const },
  ];
  const edges = [{ id: 'e1', from: 'a', to: 'b' }];
  // Tái hiện đúng ca review: e1 (cạnh, suy ra → b) và b (trỏ thẳng) cùng khai
  // hai màn khác nhau — trước đây 'doc__MH1' biến mất không lý do.
  const { byNode, dropped } = resolveScreenCells({ nodes, edges }, { e1: 'doc__MH1', b: 'doc__MH2' });
  assert.deepEqual(byNode, { b: 'doc__MH2' });
  assert.deepEqual(dropped, [{ cell: 'e1', key: 'doc__MH1', reason: 'node "b" đã gắn màn "doc__MH2" — mỗi bước chỉ mang một màn' }]);
});

test('resolveScreenCells: hai CẠNH cùng đổ về một node — giữ cái ĐẦU (thứ tự khoá trong screens), cái sau vào dropped', () => {
  const nodes = [
    { id: 'a', type: 'start' as const },
    { id: 'b', type: 'action' as const },
    { id: 'c', type: 'start' as const },
  ];
  const edges = [
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'c', to: 'b' },
  ];
  const { byNode, dropped } = resolveScreenCells({ nodes, edges }, { e1: 'doc__MH1', e2: 'doc__MH2' });
  assert.deepEqual(byNode, { b: 'doc__MH1' });
  assert.deepEqual(dropped, [{ cell: 'e2', key: 'doc__MH2', reason: 'node "b" đã gắn màn "doc__MH1" — mỗi bước chỉ mang một màn' }]);
});

test('resolveScreenCells: không đụng độ (mỗi node một khoá) → byNode/dropped như cũ, không có lý do đụng độ nào', () => {
  const nodes = [
    { id: 'a', type: 'start' as const },
    { id: 'b', type: 'action' as const },
    { id: 'd', type: 'action' as const },
  ];
  const edges = [{ id: 'e1', from: 'a', to: 'b' }];
  const { byNode, dropped } = resolveScreenCells({ nodes, edges }, { e1: 'doc__MH1', d: 'doc__MH2' });
  assert.deepEqual(byNode, { b: 'doc__MH1', d: 'doc__MH2' });
  assert.deepEqual(dropped, []);
});

test('to-flowchart: mapping vào id CẠNH (sơ đồ sequence, thao tác nằm trên mũi tên) → daemon quy về node đích thay vì loại thẳng tay', () => {
  const page = decodeMxfile(DRAWIO)[0]!;
  // 'e1' là id cạnh có thật trong fixture (s1 -> pay theo cells.json sample).
  const cells = listCells(page.graphXml);
  const anEdge = cells.find((c) => c.kind === 'edge' && c.source && c.target)!;
  const fc = drawioPageToFlowchart(page.graphXml, { id: 'FLOW-x', title: 't', source: 's.md' }, { [anEdge.id]: 'doc__MH1' });
  const target = fc.nodes.find((n) => n.id === anEdge.target);
  const usedTarget = target && target.type !== 'decision';
  const holder = usedTarget ? target : fc.nodes.find((n) => n.id === anEdge.source);
  assert.equal(holder?.screen, 'doc__MH1');
});

test('patch: addNode.near là CẠNH → quy về đỉnh đích; node vừa thêm nhìn thấy được bởi addNode sau (od-n3 near od-n2)', () => {
  const graphXml = `<mxGraphModel><root>
<mxCell id="0"/>
<mxCell id="1" parent="0"/>
<mxCell id="v1" value="Bắt đầu" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>
<mxCell id="v2" value="Kết thúc" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="300" y="0" width="120" height="60" as="geometry"/></mxCell>
<mxCell id="e1" value="" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="v1" target="v2"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
  const patch = parsePatchDoc(
    JSON.stringify({
      ops: [
        { op: 'addNode', id: 'od-n2', shape: 'action', label: 'Node 2', near: 'e1', dir: 'below' },
        { op: 'addNode', id: 'od-n3', shape: 'action', label: 'Node 3', near: 'od-n2', dir: 'below' },
      ],
    }),
  );
  const r = applyPatch(graphXml, patch);
  assert.equal(r.applied, 2);
  assert.equal(r.skipped.length, 0);
  const cells = listCells(r.graphXml);
  const n2 = cells.find((c) => c.id === 'od-n2')!;
  const n3 = cells.find((c) => c.id === 'od-n3')!;
  assert.ok(n2 && n3, 'cả hai node được thêm');
  assert.ok((n3.y ?? 0) > (n2.y ?? 0), 'od-n3 đặt dưới od-n2 (near = od-n2 vừa thêm)');
});

test('patch: addNode.near là CẠNH TRÔI (không source/target, sơ đồ sequence) → skip có lý do đúng bản chất, khác "not found or not a vertex"', () => {
  const graphXml = `<mxGraphModel><root>
<mxCell id="0"/>
<mxCell id="1" parent="0"/>
<mxCell id="v1" value="Bắt đầu" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>
<mxCell id="floaty" value="Thao tác" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1"><mxGeometry x="150" y="30" width="80" height="20" relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
  const patch = parsePatchDoc(
    JSON.stringify({
      ops: [
        { op: 'addNode', id: 'od-n1', shape: 'action', label: 'Báo lỗi', near: 'floaty', dir: 'below' },
        { op: 'addNode', id: 'od-n2', shape: 'action', label: 'x', near: 'khong-ton-tai', dir: 'below' },
      ],
    }),
  );
  const r = applyPatch(graphXml, patch);
  assert.equal(r.applied, 0);
  assert.equal(r.skipped.length, 2);
  const floatySkip = r.skipped.find((s) => (s.op as { near?: string }).near === 'floaty')!;
  assert.equal(floatySkip.reason, 'near cell "floaty" là cạnh không nối hai đỉnh (sơ đồ kiểu sequence) — không đặt được node cạnh nó');
  const missingSkip = r.skipped.find((s) => (s.op as { near?: string }).near === 'khong-ton-tai')!;
  assert.equal(missingSkip.reason, 'near cell "khong-ton-tai" not found or not a vertex');
});

test('prepareFlowUxInputs: pageReferencing khoan dung (bỏ tiền tố số Confluence + đuôi + chuẩn hoá _/khoảng trắng) và sơ đồ mồ côi không vào flows', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-orphan-'));
  try {
    const dir = path.join(cwd, 'docs-feature', 'sso');
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    const diagramXml = (a: string, b: string) => `<mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="v1" value="${a}" style="ellipse;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="v2" value="${b}" style="ellipse;" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" parent="1" source="v1" target="v2"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
    fs.writeFileSync(path.join(dir, 'attachments', '901-Untitled_Diagram-123.drawio'), diagramXml('Bắt đầu', 'Kết thúc'));
    fs.writeFileSync(path.join(dir, 'attachments', '902-Mo-coi-Diagram.drawio'), diagramXml('X', 'Y'));
    // Trang chỉ nhúng ẢNH cùng gốc tên với sơ đồ 901 (không tiền tố, `_`→khoảng trắng).
    fs.writeFileSync(path.join(dir, 'doc.md'), '# Doc\n\n![](attachments/Untitled Diagram-123.png)\n');

    const prep = await prepareFlowUxInputs(cwd);
    const referenced = prep.inputs.find((i) => i.diagram.endsWith('901-Untitled_Diagram-123.drawio'));
    assert.ok(referenced, 'khớp khoan dung — sơ đồ 901 phải nằm trong flows');
    assert.equal(referenced!.source, 'docs-feature/sso/doc.md');
    assert.equal(
      prep.inputs.some((i) => i.diagram.endsWith('902-Mo-coi-Diagram.drawio')),
      false,
      'sơ đồ mồ côi không trang nào tham chiếu → không vào flows',
    );
    assert.deepEqual(prep.orphans, [
      { diagram: 'docs-feature/sso/attachments/902-Mo-coi-Diagram.drawio', reason: 'không có trang tài liệu nào tham chiếu sơ đồ này' },
    ]);
    const inputsJson = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', '_inputs.json'), 'utf8'));
    assert.deepEqual(inputsJson.orphans, prep.orphans);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('prepareFlowUxInputs: mọi sơ đồ đều mồ côi → safety net giữ nguyên hết trong flows (không mất luồng) + cảnh báo', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-allorphan-'));
  try {
    const dir = path.join(cwd, 'docs-feature', 'sso');
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    const diagramXml = (a: string, b: string) => `<mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="v1" value="${a}" style="ellipse;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="v2" value="${b}" style="ellipse;" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" parent="1" source="v1" target="v2"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
    fs.writeFileSync(path.join(dir, 'attachments', '901-A.drawio'), diagramXml('A1', 'A2'));
    fs.writeFileSync(path.join(dir, 'attachments', '902-B.drawio'), diagramXml('B1', 'B2'));
    // Không có trang .md nào cả — mọi sơ đồ chắc chắn mồ côi.

    const prep = await prepareFlowUxInputs(cwd);
    assert.equal(prep.inputs.length, 2, 'safety net: cả 2 sơ đồ vẫn vào flows dù mồ côi');
    assert.deepEqual(prep.orphans, []);
    const inputsJson = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', '_inputs.json'), 'utf8'));
    assert.match(inputsJson.note ?? '', /vẫn đưa hết vào flows/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ── WP dr-flow docs-app scope: dự án App-pool (có docs-app/) copy NGUYÊN
// attachments/ của TOÀN BỘ trang App vào docs-feature/attachments (Bước 1) —
// sơ đồ của feature khác lọt vào theo, "không trang docs-feature nào tham
// chiếu" gần như chắc chắn là leak, không phải một cái trống mất-mát. Gate
// theo sự TỒN TẠI của docs-app/ ngay dưới cwd. ─────────────────────────────

test('App-pool (docs-app/): .mmd standalone không trang nào tham chiếu → KHÔNG vào flows, có trong orphans của _inputs.json; CÙNG fixture bỏ docs-app/ → legacy giữ nguyên (vào flows)', async () => {
  const build = (withAppPool: boolean) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-pool-mmd-'));
    if (withAppPool) fs.mkdirSync(path.join(cwd, 'docs-app'), { recursive: true });
    const dir = path.join(cwd, 'docs-feature', 'other-feature');
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    // Sơ đồ này thuộc một feature KHÁC — không trang docs-feature nào ở đây
    // nhắc tới nó (đúng dạng leak do copy nguyên attachments/ ở Bước 1).
    fs.writeFileSync(path.join(dir, 'attachments', '999-Leaked-Diagram.mmd'), MERMAID);
    fs.writeFileSync(path.join(dir, 'doc.md'), '# Doc\n\nKhông nhắc tới sơ đồ nào cả.\n');
    return cwd;
  };

  const poolCwd = build(true);
  try {
    const prep = await prepareFlowUxInputs(poolCwd);
    assert.equal(
      prep.inputs.some((i) => i.diagram.endsWith('999-Leaked-Diagram.mmd')),
      false,
      'App-pool: .mmd không trang docs-feature nào tham chiếu → không vào flows',
    );
    assert.ok(
      prep.orphans.some((o) => o.diagram.endsWith('999-Leaked-Diagram.mmd')),
      'phải ghi nhận minh bạch vào orphans',
    );
    const inputsJson = JSON.parse(fs.readFileSync(path.join(poolCwd, 'flows', '_inputs.json'), 'utf8'));
    assert.deepEqual(inputsJson.orphans, prep.orphans);
  } finally {
    fs.rmSync(poolCwd, { recursive: true, force: true });
  }

  const legacyCwd = build(false);
  try {
    const prep = await prepareFlowUxInputs(legacyCwd);
    assert.equal(
      prep.inputs.some((i) => i.diagram.endsWith('999-Leaked-Diagram.mmd')),
      true,
      'legacy (không docs-app/): hành vi cũ giữ nguyên — vẫn vào flows dù không trang nào tham chiếu',
    );
  } finally {
    fs.rmSync(legacyCwd, { recursive: true, force: true });
  }
});

test('App-pool (docs-app/): TOÀN BỘ sơ đồ draw.io mồ côi → safety-net TẮT (không giữ hết), flows không chứa chúng, orphans đủ từng diagram', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-pool-drawio-'));
  try {
    fs.mkdirSync(path.join(cwd, 'docs-app'), { recursive: true });
    const dir = path.join(cwd, 'docs-feature', 'sso');
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    const diagramXml = (a: string, b: string) => `<mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="v1" value="${a}" style="ellipse;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="v2" value="${b}" style="ellipse;" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" parent="1" source="v1" target="v2"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
    fs.writeFileSync(path.join(dir, 'attachments', '901-A.drawio'), diagramXml('A1', 'A2'));
    fs.writeFileSync(path.join(dir, 'attachments', '902-B.drawio'), diagramXml('B1', 'B2'));
    // Không có trang .md nào cả — mọi sơ đồ chắc chắn mồ côi, nhưng đây là
    // App-pool nên KHÔNG áp safety-net "giữ tất cả" như dự án legacy.

    const prep = await prepareFlowUxInputs(cwd);
    assert.equal(prep.inputs.length, 0, 'App-pool: safety-net tắt, mọi candidate mồ côi bị loại khỏi flows');
    assert.deepEqual(prep.orphans.map((o) => o.diagram).sort(), [
      'docs-feature/sso/attachments/901-A.drawio',
      'docs-feature/sso/attachments/902-B.drawio',
    ]);
    const inputsJson = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', '_inputs.json'), 'utf8'));
    assert.deepEqual(inputsJson.orphans, prep.orphans);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('App-pool (docs-app/): drawio và .mmd ĐƯỢC trang docs-feature tham chiếu → vẫn vào flows bình thường; kèm 1 sơ đồ mồ côi khác → orphans + note đếm N sơ đồ pool App bị loại', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-pool-referenced-'));
  try {
    fs.mkdirSync(path.join(cwd, 'docs-app'), { recursive: true });
    const dir = path.join(cwd, 'docs-feature', 'sim');
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'sample-compressed.drawio'), path.join(dir, 'attachments', '12345-Luong-mua-sim.drawio'));
    fs.writeFileSync(path.join(dir, 'attachments', '999-Referenced.mmd'), MERMAID);
    const otherMermaid = 'flowchart TD\n    P1[Bắt đầu] --> P2[Kết thúc]\n';
    fs.writeFileSync(path.join(dir, 'attachments', '888-Orphan.mmd'), otherMermaid);
    fs.writeFileSync(
      dir + '/doc.md',
      '# Doc\n\n![](attachments/12345-Luong-mua-sim.drawio)\n\n![](attachments/999-Referenced.mmd)\n',
    );

    const prep = await prepareFlowUxInputs(cwd);
    assert.ok(
      prep.inputs.some((i) => i.diagram.endsWith('12345-Luong-mua-sim.drawio')),
      'drawio được tham chiếu vẫn vào flows',
    );
    assert.ok(
      prep.inputs.some((i) => i.diagram.endsWith('999-Referenced.mmd')),
      '.mmd được tham chiếu vẫn vào flows',
    );
    assert.equal(
      prep.inputs.some((i) => i.diagram.endsWith('888-Orphan.mmd')),
      false,
      'sơ đồ mồ côi khác (không tham chiếu) vẫn bị loại dù cùng dự án',
    );
    assert.equal(prep.orphans.length, 1);
    assert.ok(prep.orphans[0]!.diagram.endsWith('888-Orphan.mmd'));
    const inputsJson = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', '_inputs.json'), 'utf8'));
    assert.equal(
      inputsJson.note,
      '1 sơ đồ thuộc pool App (docs-app) không trang docs-feature nào tham chiếu — đã loại khỏi flows.',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('App-pool (docs-app/): sau khi lọc hết bởi luật mới, inputs rỗng → note text-only hiện có vẫn được ghi (không phải note đếm orphan)', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-pool-empty-'));
  try {
    fs.mkdirSync(path.join(cwd, 'docs-app'), { recursive: true });
    const dir = path.join(cwd, 'docs-feature', 'sso');
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'attachments', '999-Leaked.mmd'), MERMAID);
    fs.writeFileSync(path.join(dir, 'doc.md'), '# Doc\n\nKhông nhắc gì tới sơ đồ.\n');

    const prep = await prepareFlowUxInputs(cwd);
    assert.equal(prep.inputs.length, 0);
    assert.equal(prep.orphans.length, 1);
    const inputsJson = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', '_inputs.json'), 'utf8'));
    assert.equal(
      inputsJson.note,
      'Không tìm thấy sơ đồ draw.io/Mermaid nào trong tài liệu — chạy chế độ text-only (tự dựng flowchart.json từ chữ).',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('finalizeFlowUx: screens.json explicit map C_Type decision→Trang chủ được giữ; id lạ vẫn warning/drop như cũ', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-dropped-'));
  try {
    const fdir = path.join(cwd, 'flows', 'FLOW-x');
    fs.mkdirSync(fdir, { recursive: true });
    const graphXml = `<mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="v1" value="Bắt đầu" style="ellipse;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="C_Type" value="Chọn loại SIM" style="rhombus;" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="v3" value="Kết thúc" style="ellipse;" vertex="1" parent="1"><mxGeometry x="400" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" value="eSIM" edge="1" parent="1" source="v1" target="C_Type"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e2" value="SIM vật lý" edge="1" parent="1" source="C_Type" target="v3"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
    fs.writeFileSync(path.join(fdir, 'as-is.drawio'), encodeMxfile([{ id: 'p1', name: 'Hiện trạng', graphXml }]));
    fs.writeFileSync(path.join(fdir, 'screens.json'), JSON.stringify({ cells: { zzz: 'doc__MH1', C_Type: 'doc__6.1.1' }, names: { 'doc__6.1.1': 'Màn hình trang chủ' } }));
    fs.writeFileSync(path.join(fdir, 'ux-review.json'), JSON.stringify({ summary: 'ok', findings: [] }));
    fs.mkdirSync(path.join(cwd, 'flows'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'flows', '_inputs.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        flows: [
          {
            id: 'FLOW-x',
            title: 'x',
            kind: 'drawio',
            source: 'doc.md',
            diagram: 'doc.drawio',
            files: { asIs: 'flows/FLOW-x/as-is.drawio', cells: 'flows/FLOW-x/cells.json' },
            counts: { nodes: 3, edges: 2 },
          },
        ],
      }),
    );

    const fin = await finalizeFlowUx(cwd);
    assert.equal(fin.index.length, 1);
    const entry = fin.index[0]!;
    assert.deepEqual(entry.screens, [{ key: 'doc__6.1.1', name: 'Màn hình trang chủ' }]);
    assert.deepEqual(entry.screensDropped, [{ cell: 'zzz', key: 'doc__MH1', reason: 'không có trong sơ đồ' }]);
    const flowchart = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', 'FLOW-x.flowchart.json'), 'utf8'));
    const decision = flowchart.nodes.find((node: { id: string }) => node.id === 'C_Type');
    assert.deepEqual(decision, { id: 'C_Type', type: 'decision', label: 'Chọn loại SIM', screen: 'doc__6.1.1' });
    assert.deepEqual(flowchart.edges.map((edge: { label?: string }) => edge.label), ['eSIM', 'SIM vật lý']);
    assert.ok(fin.warnings.some((w) => w.includes('mapping màn "doc__MH1" trỏ vào "zzz" bị bỏ')));
    assert.ok(!fin.warnings.some((w) => w.includes('mapping màn "doc__6.1.1"')));
    assert.ok(!fin.warnings.some((w) => w.includes('không cái nào dùng được')));
    const warningsFile = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', '_warnings.json'), 'utf8'));
    assert.deepEqual(warningsFile.warnings, fin.warnings);
    assert.ok(typeof warningsFile.generatedAt === 'string');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Bug prod #6d40d52e đảo hành vi WP9b cho cạnh trôi CÓ NHÃN: mapping màn trên
// cạnh trôi có nhãn giờ được thăng cấp thành bước 'action' đứng riêng mang
// screen (tài liệu sequence-only trước đây là ngõ cụt: recovery 0.8.142 nhận
// cạnh UI, finalize lại vứt đúng các mapping ấy → flow không bao giờ được phủ).
// Cạnh trôi KHÔNG nhãn vẫn drop với lý do WP9b như cũ (test dưới).
test('finalizeFlowUx: screens.json trỏ màn vào cạnh TRÔI có nhãn → thăng cấp thành bước mang screen, flow được phủ, không còn screensDropped', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-floaty-drop-'));
  try {
    const fdir = path.join(cwd, 'flows', 'FLOW-x');
    fs.mkdirSync(fdir, { recursive: true });
    // 'floaty' là cạnh có NHÃN, có id thật trong sơ đồ, nhưng không có
    // source/target (kiểu vẽ theo toạ độ của sơ đồ sequence) — trước WP9b,
    // apps/daemon/src/flow-ux/index.ts tự lọc edgesForDrop chỉ giữ cạnh có cả
    // source&&target nên cạnh này không bao giờ tới được resolveScreenCells
    // (đường dùng cho screensDropped thật); lý do đúng chỉ nằm trong hàm,
    // không tới người dùng.
    const graphXml = `<mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="v1" value="Bắt đầu" style="ellipse;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="v2" value="Kết thúc" style="ellipse;" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" parent="1" source="v1" target="v2"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="floaty" value="Click Đăng nhập" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1"><mxGeometry x="90" y="10" width="60" height="20" relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
    fs.writeFileSync(path.join(fdir, 'as-is.drawio'), encodeMxfile([{ id: 'p1', name: 'Hiện trạng', graphXml }]));
    fs.writeFileSync(path.join(fdir, 'screens.json'), JSON.stringify({ cells: { floaty: 'doc__MH1' } }));
    fs.writeFileSync(path.join(fdir, 'ux-review.json'), JSON.stringify({ summary: 'ok', findings: [] }));
    fs.writeFileSync(
      path.join(cwd, 'flows', '_inputs.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        flows: [
          {
            id: 'FLOW-x',
            title: 'x',
            kind: 'drawio',
            source: 'doc.md',
            diagram: 'doc.drawio',
            files: { asIs: 'flows/FLOW-x/as-is.drawio', cells: 'flows/FLOW-x/cells.json' },
            counts: { nodes: 2, edges: 2 },
          },
        ],
      }),
    );

    const fin = await finalizeFlowUx(cwd);
    assert.equal(fin.index.length, 1);
    const entry = fin.index[0]!;
    assert.deepEqual(entry.screens, [{ key: 'doc__MH1', name: 'doc__MH1' }], 'cạnh trôi có nhãn được thăng cấp — flow được phủ');
    assert.equal(entry.screensDropped, undefined);
    assert.ok(!fin.warnings.some((w) => w.includes('doc__MH1')), 'không còn cảnh báo drop cho mapping đã dùng được');
    const flowchart = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', 'FLOW-x.flowchart.json'), 'utf8')) as {
      nodes: Array<{ id: string; type: string; label: string; screen?: string }>;
    };
    const promoted = flowchart.nodes.find((n) => n.id === 'floaty');
    assert.deepEqual(promoted, { id: 'floaty', type: 'action', label: 'Click Đăng nhập', screen: 'doc__MH1' });
    assert.notEqual(flowchart.nodes[0]!.id, 'floaty', 'bước thăng cấp không được chọn làm start');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('finalizeFlowUx: cạnh TRÔI KHÔNG nhãn vẫn drop với lý do WP9b — không thăng cấp mù', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-floaty-unlabeled-'));
  try {
    const fdir = path.join(cwd, 'flows', 'FLOW-x');
    fs.mkdirSync(fdir, { recursive: true });
    const graphXml = `<mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="v1" value="Bắt đầu" style="ellipse;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="v2" value="Kết thúc" style="ellipse;" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" parent="1" source="v1" target="v2"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="floaty" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1"><mxGeometry x="90" y="10" width="60" height="20" relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
    fs.writeFileSync(path.join(fdir, 'as-is.drawio'), encodeMxfile([{ id: 'p1', name: 'Hiện trạng', graphXml }]));
    fs.writeFileSync(path.join(fdir, 'screens.json'), JSON.stringify({ cells: { floaty: 'doc__MH1' } }));
    fs.writeFileSync(path.join(fdir, 'ux-review.json'), JSON.stringify({ summary: 'ok', findings: [] }));
    fs.writeFileSync(
      path.join(cwd, 'flows', '_inputs.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        flows: [
          {
            id: 'FLOW-x',
            title: 'x',
            kind: 'drawio',
            source: 'doc.md',
            diagram: 'doc.drawio',
            files: { asIs: 'flows/FLOW-x/as-is.drawio', cells: 'flows/FLOW-x/cells.json' },
            counts: { nodes: 2, edges: 2 },
          },
        ],
      }),
    );

    const fin = await finalizeFlowUx(cwd);
    const entry = fin.index[0]!;
    assert.deepEqual(entry.screens, []);
    assert.deepEqual(entry.screensDropped, [{ cell: 'floaty', key: 'doc__MH1', reason: 'là cạnh không nối hai đỉnh (sơ đồ kiểu sequence)' }]);
    assert.ok(
      fin.warnings.some((w) => w.includes('mapping màn "doc__MH1" trỏ vào "floaty" bị bỏ — là cạnh không nối hai đỉnh (sơ đồ kiểu sequence)')),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('finalizeFlowUx: lượt chạy sau KHÔNG còn warning → flows/_warnings.json của lượt trước bị XOÁ (không để lại cảnh báo cũ đã hết hiệu lực)', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-warnclear-'));
  try {
    const fdir = path.join(cwd, 'flows', 'FLOW-x');
    fs.mkdirSync(fdir, { recursive: true });
    const graphXml = `<mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="v1" value="Bắt đầu" style="ellipse;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="v2" value="Kết thúc" style="ellipse;" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" parent="1" source="v1" target="v2"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
    fs.writeFileSync(path.join(fdir, 'as-is.drawio'), encodeMxfile([{ id: 'p1', name: 'Hiện trạng', graphXml }]));
    // Lượt đầu: mapping hỏng (id lạ) → có warning, _warnings.json được ghi.
    fs.writeFileSync(path.join(fdir, 'screens.json'), JSON.stringify({ cells: { zzz: 'doc__MH1' } }));
    fs.writeFileSync(path.join(fdir, 'ux-review.json'), JSON.stringify({ summary: 'ok', findings: [] }));
    fs.writeFileSync(
      path.join(cwd, 'flows', '_inputs.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        flows: [
          {
            id: 'FLOW-x',
            title: 'x',
            kind: 'drawio',
            source: 'doc.md',
            diagram: 'doc.drawio',
            files: { asIs: 'flows/FLOW-x/as-is.drawio', cells: 'flows/FLOW-x/cells.json' },
            counts: { nodes: 2, edges: 1 },
          },
        ],
      }),
    );

    const first = await finalizeFlowUx(cwd);
    assert.ok(first.warnings.length > 0, 'lượt đầu phải có warning (mapping hỏng)');
    const warningsPath = path.join(cwd, 'flows', '_warnings.json');
    assert.ok(fs.existsSync(warningsPath), 'lượt đầu ghi flows/_warnings.json');

    // Lượt sau: agent (giả lập) sửa lại, screens.json không còn mapping hỏng.
    fs.writeFileSync(path.join(fdir, 'screens.json'), JSON.stringify({ cells: {} }));
    const second = await finalizeFlowUx(cwd);
    assert.deepEqual(second.warnings, []);
    assert.ok(!fs.existsSync(warningsPath), 'flows/_warnings.json của lượt trước phải bị xoá khi lượt này sạch warning');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('prepareFlowUxInputs: pageReferencing khoan dung có guard độ dài (≥ 8 ký tự sau chuẩn hoá, phải có chữ số) — token ngắn/chung chung không khớp nhầm', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-loose-guard-'));
  try {
    const dir = path.join(cwd, 'docs-feature', 'x');
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    const diagramXml = (a: string, b: string) => `<mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="v1" value="${a}" style="ellipse;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="v2" value="${b}" style="ellipse;" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" parent="1" source="v1" target="v2"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
    // Token khoan dung ngắn/chung chung ("a-1", 3 ký tự) — KHÔNG được khớp
    // nhầm dù chuỗi con "a-1" có mặt tình cờ trong một trang bất kỳ.
    fs.writeFileSync(path.join(dir, 'attachments', 'a-1.drawio'), diagramXml('P', 'Q'));
    // Token thật (tiền tố Confluence + số dài) — vẫn khớp trang chỉ nhúng ảnh
    // cùng gốc tên, không có đuôi ".drawio".
    fs.writeFileSync(path.join(dir, 'attachments', '901-Untitled_Diagram-1769153289432.drawio'), diagramXml('Bắt đầu', 'Kết thúc'));
    fs.writeFileSync(
      path.join(dir, 'doc.md'),
      '# Doc\n\nNhắc tới a-1 ở đây nhưng đây không phải sơ đồ.\n\n![](attachments/Untitled Diagram-1769153289432.png)\n',
    );

    const prep = await prepareFlowUxInputs(cwd);
    assert.equal(
      prep.inputs.some((i) => i.diagram.endsWith('a-1.drawio')),
      false,
      'token khoan dung ngắn/chung chung không được khớp nhầm — sơ đồ mồ côi',
    );
    const matched = prep.inputs.find((i) => i.diagram.endsWith('901-Untitled_Diagram-1769153289432.drawio'));
    assert.ok(matched, 'token khoan dung đủ dài + có chữ số vẫn khớp trang chỉ nhúng ảnh cùng gốc tên');
    assert.equal(matched!.source, 'docs-feature/x/doc.md');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
