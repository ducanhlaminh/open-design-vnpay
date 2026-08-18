import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';

import { collectComponentCatalog } from '../src/docs-components.js';
import {
  findScreenSection,
  splitScreenKey,
  prepareScreenComponentInputs,
  parseRoleMap,
  validateRoleMap,
  parseScreenComponentsDoc,
  validateScreenComponentsDoc,
  scanWireframe,
  mergeScreenComponents,
  screenDocRel,
  wireframeRel,
  SCREEN_INPUTS_FILE,
  type ScreenComponentsInputs,
} from '../src/screen-components.js';

const CATALOG_MD = [
  '# Danh mục component',
  '',
  '## CONTROL',
  '',
  '### `#button` Button',
  '',
  '### `#top-app-bar` Top App Bar',
  '',
  '### `#list-item` List Item',
  '',
].join('\n');

const PAGE_MD = [
  '# 2.1 PRD Mua SIM',
  '',
  '## 4. Màn hình',
  '',
  '### 4.1 SCR-001 Chọn quốc gia',
  '',
  'Người dùng chọn quốc gia đến từ danh sách.',
  '',
  '![mockup](attachments/scr-001.png)',
  '',
  '| STT | Trường | Kiểu hiển thị |',
  '|---|---|---|',
  '| 1 | Ô tìm kiếm | Search |',
  '| 2 | Danh sách quốc gia | List |',
  '',
  '### 4.2 SCR-002 Chọn gói cước',
  '',
  'Hiển thị các gói eSIM theo quốc gia đã chọn.',
  '',
  '## 5. Khác',
  '',
  'Nội dung khác.',
].join('\n');

const KEY1 = '2.1-PRD-Mua-SIM__SCR-001';
const KEY2 = '2.1-PRD-Mua-SIM__SCR-002';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'od-screen-comp-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function seedFlowRun(): Promise<void> {
  await mkdir(join(cwd, 'docs-feature'), { recursive: true });
  await writeFile(join(cwd, 'docs-feature', '2.1-PRD-Mua-SIM.md'), PAGE_MD, 'utf8');
  await mkdir(join(cwd, 'criteria'), { recursive: true });
  await writeFile(join(cwd, 'criteria', 'components.md'), CATALOG_MD, 'utf8');
  await mkdir(join(cwd, 'flows', 'FLOW-a'), { recursive: true });
  await writeFile(
    join(cwd, 'flows', 'index.json'),
    JSON.stringify([
      {
        id: 'FLOW-a',
        title: 'Luồng mua SIM',
        source: 'docs-feature/2.1-PRD-Mua-SIM.md',
        kind: 'mermaid',
        screens: [
          { key: KEY1, name: 'Chọn quốc gia' },
          { key: KEY2, name: 'Chọn gói cước' },
        ],
        files: { flowchart: 'flows/FLOW-a.flowchart.json', review: 'flows/FLOW-a/ux-review.json' },
      },
    ]),
    'utf8',
  );
  await writeFile(
    join(cwd, 'flows', 'FLOW-a.flowchart.json'),
    JSON.stringify({
      nodes: [
        { id: 'n0', type: 'start', label: 'Bắt đầu' },
        { id: 'n1', type: 'action', label: 'Chọn quốc gia', screen: KEY1 },
        { id: 'n2', type: 'decision', label: 'Có gói?' },
        { id: 'n3', type: 'action', label: 'Chọn gói cước', screen: KEY2 },
        { id: 'n4', type: 'end', label: 'Kết thúc' },
      ],
      edges: [
        { from: 'n0', to: 'n1' },
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3', label: 'Có' },
        { from: 'n2', to: 'n4', label: 'Không' },
        { from: 'n3', to: 'n4' },
      ],
    }),
    'utf8',
  );
  await writeFile(
    join(cwd, 'flows', 'FLOW-a', 'ux-review.json'),
    JSON.stringify({
      flowId: 'FLOW-a',
      verdict: 'needs-improvement',
      summary: 's',
      findings: [{ id: 'F1', severity: 'major', title: 'Không có tìm kiếm quốc gia', reason: 'r', cells: { asIs: ['n1'] } }],
    }),
    'utf8',
  );
}

test('splitScreenKey tách prefix/code theo dấu "__" cuối', () => {
  assert.deepEqual(splitScreenKey(KEY1), { prefix: '2.1-PRD-Mua-SIM', code: 'SCR-001' });
  assert.equal(splitScreenKey('khong-co-code'), null);
});

test('findScreenSection: tìm theo mã màn, cắt tới heading cùng cấp, tách bảng tham khảo, bỏ ảnh', () => {
  const s = findScreenSection(PAGE_MD, 'SCR-001', 'Chọn quốc gia');
  assert.ok(s);
  assert.equal(s.heading, '### 4.1 SCR-001 Chọn quốc gia');
  assert.equal(s.startLine, 5);
  assert.equal(s.endLine, 15);
  assert.ok(s.excerpt.includes('chọn quốc gia đến từ danh sách'));
  assert.ok(!s.excerpt.includes('mockup'));
  assert.ok(s.referenceTable?.includes('Kiểu hiển thị'));
  assert.ok(s.referenceTable?.includes('Danh sách quốc gia'));
  // Theo tên khi mã không có trong heading.
  const byName = findScreenSection(PAGE_MD, 'SCR-999', 'Chọn gói cước');
  assert.equal(byName?.heading, '### 4.2 SCR-002 Chọn gói cước');
  assert.equal(byName?.referenceTable, undefined);
  assert.equal(findScreenSection(PAGE_MD, 'SCR-999', 'Không có'), null);
});

test('prepareScreenComponentInputs: màn từ flows/, mục tài liệu, navOut qua decision, findings chạm màn', async () => {
  await seedFlowRun();
  const inputs = await prepareScreenComponentInputs(cwd, {
    pages: [{ mdPath: 'docs-feature/2.1-PRD-Mua-SIM.md', page: '2.1 PRD Mua SIM' }],
  });
  assert.equal(inputs.screens.length, 2);
  assert.equal(inputs.note, undefined);
  assert.equal(inputs.ds.components, true);
  assert.equal(inputs.ds.catalog, false);
  const [s1, s2] = inputs.screens;
  assert.equal(s1!.key, KEY1);
  assert.equal(s1!.order, 0);
  assert.equal(s1!.flowId, 'FLOW-a');
  assert.equal(s1!.source, 'docs-feature/2.1-PRD-Mua-SIM.md');
  assert.equal(s1!.section?.heading, '### 4.1 SCR-001 Chọn quốc gia');
  assert.ok(s1!.referenceTable?.includes('Kiểu hiển thị'));
  assert.deepEqual(s1!.steps.map((x) => x.id), ['n1']);
  assert.deepEqual(s1!.navOut, [{ to: KEY2, via: 'Chọn quốc gia', condition: 'Có' }]);
  assert.deepEqual(s1!.findings.map((f) => f.id), ['F1']);
  assert.deepEqual(s2!.navIn, [KEY1]);
  assert.deepEqual(s2!.navOut, []);
  assert.equal(s2!.findings.length, 0);
  const onDisk = JSON.parse(await readFile(join(cwd, SCREEN_INPUTS_FILE), 'utf8')) as ScreenComponentsInputs;
  assert.equal(onDisk.screens.length, 2);
});

test('prepareScreenComponentInputs: chưa có flows → screens rỗng + note bảo chạy dr-flow', async () => {
  const inputs = await prepareScreenComponentInputs(cwd, { pages: [] });
  assert.equal(inputs.screens.length, 0);
  assert.match(inputs.note ?? '', /dr-flow/);
});

test('parseRoleMap + validateRoleMap: component phải có trong danh mục; DS trống thì component phải null', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const ok = parseRoleMap(
    JSON.stringify({
      platform: 'mobile',
      roles: [
        { role: 'app-bar', component: 'Top App Bar', anchor: 'top-app-bar', when: 'mọi màn' },
        { role: 'bottom-sheet', component: null, fallback: 'Dùng Dialog' },
      ],
      notes: ['n'],
    }),
  );
  assert.ok('doc' in ok);
  assert.deepEqual(validateRoleMap(ok.doc, catalog), []);
  assert.deepEqual(validateRoleMap(ok.doc, new Map()), ['role "app-bar": không có danh mục DS nên "component" phải là null (nhận "Top App Bar").']);

  const bad = parseRoleMap(JSON.stringify({ platform: 'mobile', roles: [{ role: 'x', component: 'Combobox' }, { role: 'y', component: 'Button', anchor: 'btn' }] }));
  assert.ok('doc' in bad);
  const errs = validateRoleMap(bad.doc, catalog);
  assert.equal(errs.length, 2);
  assert.match(errs[0]!, /Combobox/);
  assert.match(errs[1]!, /anchor "btn"/);

  const broken = parseRoleMap(JSON.stringify({ platform: 'tv', roles: [] }));
  assert.ok('errors' in broken);
  assert.equal(broken.errors.length, 2);
  assert.ok('errors' in parseRoleMap('{'));
});

const GOOD_DOC = {
  schema_version: '2.0',
  key: KEY1,
  name: 'Chọn quốc gia',
  flowId: 'FLOW-a',
  platform: 'mobile',
  source: 'docs-feature/2.1-PRD-Mua-SIM.md',
  elements: [
    { id: 'appbar', label: 'Chọn quốc gia', role: 'app-bar', ds: { component: 'Top App Bar', anchor: 'top-app-bar', variant: 'Back=true' }, confidence: 'high', provenance: 'ds' },
    { id: 'list', label: 'Danh sách quốc gia', role: 'list-item', ds: { component: 'List Item', anchor: 'list-item' }, confidence: 'medium', provenance: 'table', docType: 'List' },
    { id: 'cta', label: 'Tiếp tục', role: 'primary-cta', ds: { component: 'Button', anchor: 'button' }, confidence: 'high', provenance: 'flow' },
    { id: 'empty', label: 'Không có quốc gia', role: 'empty-state', ds: null, confidence: 'low', provenance: 'ds', why: 'DS không có Empty State' },
  ],
  nav: [{ el: 'cta', to: KEY2 }],
  notes: ['Tài liệu không nói trạng thái loading.'],
};

const wireframe = (over: { screen?: string; layout?: string; extra?: string; dropEl?: string; script?: boolean; style?: boolean } = {}) =>
  [
    '<!doctype html>',
    '<html lang="vi"><head><meta charset="utf-8"><title>t</title>',
    over.style === false ? '' : '<style>.wf-component{border:1px solid #999}</style>',
    over.script ? '<script>alert(1)</script>' : '',
    `</head><body data-screen="${over.screen ?? KEY1}" data-layout="${over.layout ?? 'mobile'}">`,
    '<main class="wf-mobile">',
    '<header class="wf-component" data-el="appbar" data-comp="top-app-bar" data-variant="Back=true">Chọn quốc gia</header>',
    '<div class="wf-component" data-el="list" data-comp="list-item">Danh sách quốc gia</div>',
    over.dropEl === 'empty' ? '' : '<div class="wf-component" data-el="empty">Không có quốc gia</div>',
    `<button class="wf-component" data-el="cta" data-comp="button" data-nav="${KEY2}">Tiếp tục</button>`,
    over.extra ?? '',
    '</main></body></html>',
  ].join('\n');

test('scanWireframe đọc data-screen/layout/comp/el/nav', () => {
  const w = scanWireframe(wireframe());
  assert.equal(w.screen, KEY1);
  assert.equal(w.layout, 'mobile');
  assert.deepEqual(w.comps, ['top-app-bar', 'list-item', 'button']);
  assert.deepEqual(w.els, ['appbar', 'list', 'empty', 'cta']);
  assert.deepEqual(w.navs, [KEY2]);
  assert.equal(w.hasScript, false);
  assert.equal(w.hasStyle, true);
});

test('parseScreenComponentsDoc + validateScreenComponentsDoc: bộ đúng đi qua sạch', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const r = parseScreenComponentsDoc(JSON.stringify(GOOD_DOC));
  assert.ok('doc' in r);
  assert.equal(r.doc.elements.length, 4);
  assert.equal(r.doc.elements[1]!.docType, 'List');
  assert.equal(r.doc.elements[3]!.ds, null);
  const errs = validateScreenComponentsDoc(r.doc, {
    expectedKey: KEY1,
    screenKeys: new Set([KEY1, KEY2]),
    catalog,
    wireframeHtml: wireframe(),
  });
  assert.deepEqual(errs, []);
});

test('parseScreenComponentsDoc: id trùng / id lạ / nav.el không tồn tại / ds thiếu anchor', () => {
  const r = parseScreenComponentsDoc(
    JSON.stringify({
      key: KEY1,
      platform: 'mobile',
      elements: [
        { id: 'a', label: 'A', role: 'r' },
        { id: 'a', label: 'A2', role: 'r' },
        { id: 'b c', label: 'B', role: 'r' },
        { id: 'd', label: 'D', role: 'r', ds: { component: 'Button' } },
      ],
      nav: [{ el: 'zzz', to: KEY2 }],
    }),
  );
  assert.ok('errors' in r);
  assert.ok(r.errors.some((e) => e.includes('bị trùng')));
  assert.ok(r.errors.some((e) => e.includes('chỉ gồm chữ/số')));
  assert.ok(r.errors.some((e) => e.includes('cần cả "component" lẫn "anchor"')));
  assert.ok(r.errors.some((e) => e.includes('"zzz"')));
});

test('validateScreenComponentsDoc: component lạ, anchor sai, nav ngoài luồng, DS trống', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const doc = {
    ...GOOD_DOC,
    elements: [
      { id: 'x', label: 'X', role: 'r', ds: { component: 'Combobox', anchor: 'combobox' }, confidence: 'high', provenance: 'text' },
      { id: 'y', label: 'Y', role: 'r', ds: { component: 'Button', anchor: 'btn' }, confidence: 'high', provenance: 'text' },
    ],
    nav: [{ el: 'y', to: 'NOPE__SCR-9' }],
  };
  const r = parseScreenComponentsDoc(JSON.stringify(doc));
  assert.ok('doc' in r);
  const html = wireframe().replace(/data-el="(appbar|list|empty|cta)"/g, (m, id) => (id === 'appbar' ? 'data-el="x"' : id === 'list' ? 'data-el="y"' : ''));
  const errs = validateScreenComponentsDoc(r.doc, { expectedKey: KEY1, screenKeys: new Set([KEY1, KEY2]), catalog, wireframeHtml: html });
  assert.ok(errs.some((e) => e.includes('"Combobox" không có trong')));
  assert.ok(errs.some((e) => e.includes('anchor "btn"')));
  assert.ok(errs.some((e) => e.includes('"NOPE__SCR-9"')));
  // Không có DS: mọi ds phải null.
  const noDs = validateScreenComponentsDoc(r.doc, { expectedKey: KEY1, screenKeys: new Set([KEY1, KEY2]), catalog: new Map(), wireframeHtml: html });
  assert.ok(noDs.some((e) => e.includes('"ds" phải là null')));
});

test('validateScreenComponentsDoc: wireframe — thiếu file, sai key, có script, thiếu style, data-comp lạ, data-el lệch, data-nav lạ, sai layout', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const r = parseScreenComponentsDoc(JSON.stringify(GOOD_DOC));
  assert.ok('doc' in r);
  const ctx = { expectedKey: KEY1, screenKeys: new Set([KEY1, KEY2]), catalog };
  const missing = validateScreenComponentsDoc(r.doc, { ...ctx, wireframeHtml: null });
  assert.deepEqual(missing, [`Thiếu wireframe "${wireframeRel(KEY1)}".`]);

  const e1 = validateScreenComponentsDoc(r.doc, { ...ctx, wireframeHtml: wireframe({ screen: 'other', script: true, style: false, layout: 'web' }) });
  assert.ok(e1.some((e) => e.includes('data-screen')));
  assert.ok(e1.some((e) => e.includes('<script>')));
  assert.ok(e1.some((e) => e.includes('<style>')));
  assert.ok(e1.some((e) => e.includes('data-layout "web"')));

  const e2 = validateScreenComponentsDoc(r.doc, {
    ...ctx,
    wireframeHtml: wireframe({ dropEl: 'empty', extra: '<div class="wf-component" data-el="ghost" data-comp="nope" data-nav="X__1">g</div>' }),
  });
  assert.ok(e2.some((e) => e.includes('data-comp="nope"')));
  assert.ok(e2.some((e) => e.includes('data-el="ghost"')));
  assert.ok(e2.some((e) => e.includes('thiếu block data-el cho 1 element: empty')));
  assert.ok(e2.some((e) => e.includes('data-nav="X__1"')));

  const noDoctype = validateScreenComponentsDoc(r.doc, { ...ctx, wireframeHtml: wireframe().replace('<!doctype html>\n', '') });
  assert.ok(noDoctype.some((e) => e.includes('<!doctype html>')));
});

test('mergeScreenComponents: index theo thứ tự luồng, đếm mapped, summary.md có bảng + màn hỏng', () => {
  const inputs = {
    schema_version: '2.0',
    generatedAt: 'g',
    ds: { components: true, catalog: false, rules: false, examples: false, figmaCatalog: false },
    screens: [
      { key: KEY1, name: 'Chọn quốc gia', order: 0, flowId: 'FLOW-a', flowTitle: 't', source: 'x.md', steps: [], navOut: [], navIn: [], findings: [], platformHint: 'mobile' },
      { key: KEY2, name: 'Chọn gói cước', order: 1, flowId: 'FLOW-a', flowTitle: 't', source: 'x.md', steps: [], navOut: [], navIn: [], findings: [], platformHint: 'mobile' },
    ],
  } as unknown as ScreenComponentsInputs;
  const d1 = parseScreenComponentsDoc(JSON.stringify(GOOD_DOC));
  assert.ok('doc' in d1);
  const { index, summaryMd } = mergeScreenComponents([d1.doc], inputs, [{ key: KEY2, name: 'Chọn gói cước', errors: ['hỏng'] }], '2026-08-18T00:00:00Z');
  assert.equal(index.schema_version, '2.0');
  assert.equal(index.screens.length, 1);
  assert.equal(index.screens[0]!.elements, 4);
  assert.equal(index.screens[0]!.mapped, 3);
  assert.deepEqual(index.screens[0]!.files, { screen: screenDocRel(KEY1), wireframe: wireframeRel(KEY1) });
  assert.deepEqual(index.screens[0]!.navOut, [KEY2]);
  assert.equal(index.failed.length, 1);
  assert.match(summaryMd, /^# Màn hình → Component/);
  assert.ok(summaryMd.includes('| Chọn quốc gia (`' + KEY1 + '`) | mobile | 4 | 3 |'));
  assert.ok(summaryMd.includes('| Danh sách quốc gia | list-item | List Item | — | vừa | table (tài liệu khai: List) |'));
  assert.ok(summaryMd.includes('## Màn chạy hỏng'));
});
