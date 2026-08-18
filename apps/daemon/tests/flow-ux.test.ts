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
import { drawioPageToFlowchart, mermaidToFlowchart } from '../src/flow-ux/to-flowchart.js';
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
  assert.match(s1.style, /fillColor=#FFF2CC/);
  assert.deepEqual(s1.attrs, { 'od-change': 'modified', 'od-finding': 'UX-01' });
  const to = cells.find((c) => c.id === 'timeout')!;
  assert.match(to.style, /fillColor=#F8CECC/);
  assert.match(to.style, /dashed=1/);
  const n1 = cells.find((c) => c.id === 'od-n1')!;
  assert.equal(n1.kind, 'vertex');
  assert.match(n1.style, /fillColor=#D5E8D4/);
  assert.ok((n1.y ?? 0) > (to.y ?? 0), 'node mới đặt dưới cell mốc');
  const e1 = cells.find((c) => c.id === 'od-e1')!;
  assert.equal(e1.source, 'timeout');
  assert.equal(e1.target, 'od-n1');
  const e12 = cells.find((c) => c.id === 'e12')!;
  assert.equal(e12.source, 'od-n1');
  assert.deepEqual(e12.attrs, { 'od-change': 'modified', 'od-finding': 'UX-02' });
  assert.ok(cells.some((c) => c.id === 'od-legend-added'), 'có legend');
  // XML còn parse được, entity không bị escape kép.
  const $ = loadGraph(r.graphXml);
  assert.equal($('object[id="s1"]').attr('label'), 'Chọn Mua SIM → &quot;SIM Du lịch&quot; &amp; tab');
  // Bản gốc không bị đụng.
  assert.equal(listCells(page.graphXml).find((c) => c.id === 's1')?.attrs, undefined);
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
    fs.writeFileSync(path.join(fdir, 'screens.json'), JSON.stringify({ cells: { s1: 'doc2__SCR-001' }, names: { 'doc2__SCR-001': 'Trang chủ' }, note: 'ghi chú' }));
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
    assert.deepEqual(d.screens, [{ key: 'doc2__SCR-001', name: 'Trang chủ' }]);
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
