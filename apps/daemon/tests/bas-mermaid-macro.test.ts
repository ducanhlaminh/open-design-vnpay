// Nạp Confluence: macro Mermaid (Stratus `mermaid-cloud`) render client-side —
// export_view/view chỉ có <div id="stratus-addons-viewer-…"> (style + script
// createViewer với SVG), không <img>. Trước đây htmlToMarkdown vứt hết → mục
// "3.1 Luồng sơ đồ" của PRD Mua SIM du lịch trống, dr-flow thấy tài liệu
// text-only. Kiểm: nhận diện block (kể cả id lightbox trùng tiền tố bên trong),
// lấy title + SVG từ createViewer, và HTML thay thế ra Markdown có ảnh + fence
// ```mermaid + link nguồn.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import {
  decodeWwmcMermaidPayload,
  expandWwmcMermaidMacros,
  findMermaidMacroBlocks,
  findWwmcMermaidBlocks,
  mermaidMacroReplacementHtml,
} from '../src/bas/bas-client.js';
import { htmlToMarkdown } from '../src/bas/html-to-markdown.js';

const SVG_ESCAPED =
  '&lt;svg aria-roledescription=&quot;flowchart-v2&quot; role=&quot;graphics-document document&quot; viewBox=&quot;0 0 1646 2926&quot; xmlns=&quot;http://www.w3.org/2000/svg&quot; id=&quot;graphDiv&quot;&gt;&lt;g&gt;&lt;/g&gt;&lt;/svg&gt;';

// Rút gọn từ body.export_view thật của trang 1008831307 (id macro rút ngắn).
const BLOCK =
  '<div style="block" id="stratus-addons-viewer-9bb76e04"> \t <style> .leaflet-container { line-height: 1.2; } </style> ' +
  '<div id="viewer-9bb76e04" class="leaflet-container"><div class="loader"></div></div> ' +
  '<section id="lightbox-9bb76e04" class="aui-layer aui-dialog2"><div class="aui-dialog2-content-full">' +
  '<div id="lightboxviewercontent-9bb76e04"></div></div></section> ' +
  "<script type=\"text/javascript\">//<![CDATA[ createViewer('9bb76e04', 'Luồng người dùng', 'fit', 'bottom', `" +
  SVG_ESCAPED +
  '`); //]]></script></div>';

const PAGE = `<h3 id="x-3.1">3.1 Luồng sơ đồ</h3><p>${BLOCK}\n\n</p><h3 id="x-3.2">3.2 Mô tả</h3><p>Bảng.</p>`;

test('findMermaidMacroBlocks: một block, đúng biên, title + SVG từ createViewer; id lightbox bên trong không sinh block thừa', () => {
  const blocks = findMermaidMacroBlocks(PAGE);
  assert.equal(blocks.length, 1);
  const b = blocks[0]!;
  assert.equal(b.title, 'Luồng người dùng');
  assert.equal(PAGE.slice(b.start, b.end), BLOCK);
  assert.ok(b.svg?.startsWith('<svg aria-roledescription="flowchart-v2"'));
  assert.ok(b.svg?.endsWith('</svg>'));
  // Không có marker → không block.
  assert.deepEqual(findMermaidMacroBlocks('<p>không có sơ đồ</p>'), []);
  // Hai macro → hai block theo thứ tự.
  const two = findMermaidMacroBlocks(`${BLOCK}<p>giữa</p>${BLOCK.replace('9bb76e04', 'aaaa1111').replace("'Luồng người dùng'", "'Sơ đồ 2'")}`);
  assert.deepEqual(
    two.map((x) => x.title),
    ['Luồng người dùng', 'Sơ đồ 2'],
  );
});

test('mermaidMacroReplacementHtml + htmlToMarkdown: ảnh SVG (đã local) + fence ```mermaid + link nguồn thay cho viewer', () => {
  const code = 'flowchart TD\n    A([Bắt đầu]) --> B[Chọn Mua SIM]\n    B --> C{Loại SIM?}\n    C -- "Quốc tế" --> D[Chọn quốc gia]';
  const rep = mermaidMacroReplacementHtml('Luồng người dùng', 'attachments', {
    svgRel: '1008831307-Luong-nguoi-dung.svg',
    codeRel: '1008831307-Luong-nguoi-dung.mmd',
    code,
  });
  const html = PAGE.replace(BLOCK, rep);
  const md = htmlToMarkdown(html, undefined, 'attachments');
  assert.ok(md.includes('### 3.1 Luồng sơ đồ'));
  assert.ok(md.includes('![flow-diagram Luồng người dùng](attachments/1008831307-Luong-nguoi-dung.svg)'), md);
  assert.ok(md.includes('```mermaid\nflowchart TD\n    A([Bắt đầu]) --> B[Chọn Mua SIM]'), md);
  assert.ok(md.includes('C -- "Quốc tế" --> D[Chọn quốc gia]\n```'), md);
  assert.ok(md.includes('[1008831307-Luong-nguoi-dung.mmd](attachments/1008831307-Luong-nguoi-dung.mmd)'), md);
  assert.ok(!md.includes('createViewer'));
  assert.ok(!md.includes('leaflet'));
  assert.ok(md.includes('### 3.2 Mô tả'));
});

test('mermaidMacroReplacementHtml: chỉ SVG (không nguồn) vẫn ra ảnh; không gì cả → chuỗi rỗng (block bị gỡ)', () => {
  const onlySvg = mermaidMacroReplacementHtml('X', 'attachments', { svgRel: 'p-x.svg' });
  assert.ok(onlySvg.includes('<img src="attachments/p-x.svg"'));
  assert.ok(!onlySvg.includes('<pre'));
  assert.equal(mermaidMacroReplacementHtml('X', 'attachments', {}), '');
});

test('htmlToMarkdown: <pre data-lang> giữ info string, <pre> thường vẫn là fence trống lang', () => {
  assert.ok(htmlToMarkdown('<pre data-lang="mermaid">graph LR\nA--&gt;B</pre>').includes('```mermaid\ngraph LR\nA-->B\n```'));
  assert.ok(htmlToMarkdown('<pre>x &lt; y</pre>').includes('```\nx < y\n```'));
});

test('svgToWellFormedXml: SVG serialise từ DOM (<br> chưa đóng trong foreignObject, &nbsp;) → XML hợp lệ để <img> nạp được', async () => {
  const { svgToWellFormedXml } = await import('../src/bas/svg-xml.js');
  const raw =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject width="10" height="10">' +
    '<div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Chọn&nbsp;SIM<br>du lịch<br />x <b>y</b> a &lt; b &amp; c</p></span></div>' +
    '</foreignObject><img src="a.png"><hr class="x"></svg>';
  const fixed = svgToWellFormedXml(raw);
  assert.ok(!/<br>/.test(fixed) && fixed.includes('<br/>') && fixed.includes('<br />'), fixed);
  assert.ok(fixed.includes('<img src="a.png"/>') && fixed.includes('<hr class="x"/>'), fixed);
  assert.ok(fixed.includes('Chọn&#160;SIM') && fixed.includes('a &lt; b &amp; c'), fixed);
  // Idempotent — chạy lại không sinh `//>`.
  assert.equal(svgToWellFormedXml(fixed), fixed);
  // Parse được bằng XML parser thật (DOMParser của jsdom không có ở daemon → dùng fast-xml-parser nếu có, không thì regex kiểm cân bằng thẻ).
  const opens = (fixed.match(/<(?!\/)(?![^>]*\/>)[a-zA-Z][^\s>]*/g) ?? []).length;
  const closes = (fixed.match(/<\/[a-zA-Z][^\s>]*>/g) ?? []).length;
  assert.equal(opens, closes, `open ${opens} != close ${closes}`);
});

test('ensureSvgIntrinsicSize: root width="100%" không height → width/height từ viewBox; đã có px thì giữ nguyên', async () => {
  const { ensureSvgIntrinsicSize, svgForImgEmbedding } = await import('../src/bas/svg-xml.js');
  const raw = '<svg aria-roledescription="flowchart-v2" viewBox="0 0 1646.9375 2926.1796875" style="max-width: 1646.9375px;" xmlns="http://www.w3.org/2000/svg" width="100%" id="graphDiv"><g/></svg>';
  const out = ensureSvgIntrinsicSize(raw);
  assert.ok(out.startsWith('<svg width="1647" height="2927" aria-roledescription'), out);
  assert.ok(!out.includes('width="100%"'));
  assert.ok(out.includes('viewBox="0 0 1646.9375 2926.1796875"'));
  const sized = '<svg width="10" height="20" viewBox="0 0 10 20"><g/></svg>';
  assert.equal(ensureSvgIntrinsicSize(sized), sized);
  assert.equal(ensureSvgIntrinsicSize('<svg><g/></svg>'), '<svg><g/></svg>');
  assert.ok(svgForImgEmbedding(raw + '<br>').startsWith('<svg width="1647"'));
});

test('htmlToMarkdown: đầu ra luôn NFC (Confluence trộn NFC/NFD làm anchor dr-review trượt)', () => {
  const nfd = 'Điểm Đến & Phân Loại'.normalize('NFD');
  const md = htmlToMarkdown(`<p>${nfd}</p>`);
  assert.equal(md, md.normalize('NFC'));
  assert.ok(md.includes('Điểm Đến & Phân Loại'.normalize('NFC')));
});

// ── wwmc `mermaiddiagram` (nguồn inline trong <script class="wwmc-code">) ──
// Rút gọn từ body.export_view/view thật của trang 996741925 (NamABank-SME
// "[URD]Tạo hồ sơ"): mount div + error div ẩn + script JSON bọc `""…""`.
const WWMC_SRC = 'sequenceDiagram\n  participant KH as Khách hàng (Maker)\n  KH->>SME: 1. Chọn Tạo hồ sơ\n  SME-->>KH: 2. Hiển thị Form';
const WWMC_PAYLOAD = `\n  ""${WWMC_SRC.replace(/\n/g, '\\n')}""\n`;
const wwmcBlock = (uuid: string, payload = WWMC_PAYLOAD): string =>
  `<div id="wwmc-mermaid-${uuid}" class="wwmc-mermaid" style="display: none">\n</div>\n\n` +
  `<div class="aui-message aui-message-error" id="wwmc-error-${uuid}" style="display: none">\n  <p class="title">\n    <strong id="wwmc-errorTitle-${uuid}">\n</strong>\n  </p>\n  <p id="wwmc-errorText-${uuid}">\n</p>\n</div>\n\n` +
  `<script class="wwmc-code" data-uuid="${uuid}" type="application/json">${payload}</script>`;

test('decodeWwmcMermaidPayload: `""…""` (export_view) và `//<![CDATA[ … //]]>` (view) → nguồn Mermaid; rỗng/rác → null', () => {
  assert.equal(decodeWwmcMermaidPayload(WWMC_PAYLOAD), WWMC_SRC);
  assert.equal(decodeWwmcMermaidPayload(`//<![CDATA[${WWMC_PAYLOAD}\n//]]>\n`), WWMC_SRC);
  // Bản add-on cũ: nguồn trần không JSON.
  assert.equal(decodeWwmcMermaidPayload('flowchart TD\n  A-->B'), 'flowchart TD\n  A-->B');
  assert.equal(decodeWwmcMermaidPayload('   '), null);
  assert.equal(decodeWwmcMermaidPayload('không phải sơ đồ'), null);
});

test('findWwmcMermaidBlocks: block gồm cả 2 div ẩn + script, đúng biên; hai macro → hai block; không có → []', () => {
  const b1 = wwmcBlock('bc73a097');
  const b2 = wwmcBlock('aaaa1111');
  const page = `<h2>Sơ đồ</h2><div class="innerCell">${b1}</div><h2>Danh sách APIs</h2><p>x</p>${b2}`;
  const blocks = findWwmcMermaidBlocks(page);
  assert.equal(blocks.length, 2);
  assert.equal(page.slice(blocks[0]!.start, blocks[0]!.end), b1);
  assert.equal(page.slice(blocks[1]!.start, blocks[1]!.end), b2);
  assert.equal(blocks[0]!.code, WWMC_SRC);
  assert.equal(blocks[1]!.uuid, 'aaaa1111');
  assert.deepEqual(findWwmcMermaidBlocks('<p>không có sơ đồ</p>'), []);
});

test('expandWwmcMermaidMacros + htmlToMarkdown: mục "Sơ đồ" ra fence ```mermaid + link nguồn, file .mmd được ghi', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wwmc-'));
  const page = `<h2>Sơ đồ</h2><div class="innerCell">${wwmcBlock('bc73a097')}</div><h2>Danh sách APIs</h2>`;
  const html = await expandWwmcMermaidMacros(page, '996741925', dir, '../attachments');
  assert.ok(!html.includes('wwmc-'), 'không còn dấu vết macro');
  const md = htmlToMarkdown(html);
  assert.match(md, /## Sơ đồ[\s\S]*```mermaid\nsequenceDiagram\n {2}participant KH as Khách hàng \(Maker\)[\s\S]*```/);
  assert.ok(md.includes('../attachments/996741925-so-do-1.mmd'));
  assert.equal(await fs.readFile(path.join(dir, '996741925-so-do-1.mmd'), 'utf8'), `${WWMC_SRC}\n`);
  // Không macro → nguyên bản.
  assert.equal(await expandWwmcMermaidMacros('<p>x</p>', '1', dir, 'a'), '<p>x</p>');
});
