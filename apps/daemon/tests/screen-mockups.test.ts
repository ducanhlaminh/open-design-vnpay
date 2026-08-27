// WP dr-mockup (2026-08-27) — validateMockups (screen-mockups.ts): validate tất
// định các mockups/<KEY>.html mà agent (skill docs-screen-mockup) ghi, theo
// danh sách màn của mockups/_inputs.json. Khoá: OK sạch; thiếu file → lỗi chặn
// kèm danh sách; <script>/<link>/ảnh ngoài → lỗi; data-nav sai → XOÁ attribute
// + warning (nav đúng giữ nguyên); data-screen sai → sửa; index.json thiếu/
// hỏng → daemon dựng lại từ file có mặt; _audit.json luôn được ghi.
// WP dr-mockup-layouts: thiếu data-pattern / bố cục 1 cột thuần → CHỈ warning;
// pattern đi qua index (data-pattern thắng, giữ của agent khi body không có);
// _audit.json có patterns + plainColumn.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'vitest';

import {
  validateMockups,
  parseMockupIndex,
  mockupRel,
  MOCKUP_INDEX_FILE,
  MOCKUP_AUDIT_FILE,
  MOCKUP_MAX_BYTES,
  LAYOUT_KIT_CLASSES,
  isPlainColumn,
  patternOf,
} from '../src/screen-mockups.js';
import type { ScreenComponentsInputs, ScreenInput } from '../src/screen-components.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const K1 = '2.1-PRD-Mua-SIM__SCR-001';
const K2 = '2.1-PRD-Mua-SIM__SCR-002';
const K3 = '2.1-PRD-Mua-SIM__NEW-xac-nhan';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'od-screen-mockups-'));
  await mkdir(join(cwd, 'mockups'), { recursive: true });
});
afterEach(async () => rm(cwd, { recursive: true, force: true }));

function screen(key: string, extra: Partial<ScreenInput> = {}): ScreenInput {
  return {
    key,
    name: `Màn ${key.split('__')[1]}`,
    order: 0,
    flowId: 'SCREEN-FLOW',
    flowTitle: 'Luồng',
    source: 'docs-feature/2.1-PRD-Mua-SIM.md',
    steps: [],
    navOut: [],
    navIn: [],
    findings: [],
    platformHint: 'mobile',
    origin: 'flow',
    ...extra,
  };
}

function inputs(screens: ScreenInput[], selection?: ScreenComponentsInputs['selection']): ScreenComponentsInputs {
  return {
    schema_version: '2.1',
    generatedAt: new Date().toISOString(),
    ds: { components: false, catalog: false, rules: false, examples: false, figmaCatalog: false },
    screens,
    ...(selection ? { selection } : {}),
  };
}

// Mặc định: có data-pattern + 1 khối kit (.mk-sticky) để không dính warning
// đa dạng bố cục; `pattern: null` / `kit: false` tắt từng thứ để test warning.
const html = (
  key: string,
  body: string,
  opts: { layout?: string; screenAttr?: string | null; style?: boolean; pattern?: string | null; kit?: boolean } = {},
) =>
  `<!doctype html><html><head><meta charset="utf-8">${opts.style === false ? '' : '<style>.mk-region{border:1px dashed #888}</style>'}</head>` +
  `<body${opts.screenAttr === null ? '' : ` data-screen="${opts.screenAttr ?? key}"`} data-layout="${opts.layout ?? 'mobile'}"` +
  `${opts.pattern === null ? '' : ` data-pattern="${opts.pattern ?? 'list-search-rows'}"`}>` +
  `<div class="mk-mobile">${body}${opts.kit === false ? '' : '<div class="mk-sticky"><section class="mk-region" data-region="cta" data-label="CTA"><p>Tiếp tục</p></section></div>'}</div></body></html>`;

const region = (label: string, nav?: string) =>
  `<section class="mk-region" data-region="content" data-label="${label}"${nav ? ` data-nav="${nav}"` : ''}><p>${label}</p></section>`;

async function write(rel: string, content: string) {
  await mkdir(join(cwd, path.dirname(rel)), { recursive: true });
  await writeFile(join(cwd, rel), content, 'utf8');
}

test('OK: đủ file, nav đúng, index của agent giữ nguyên (name/notes), audit rỗng lỗi', async () => {
  await write(mockupRel(K1), html(K1, region('App bar') + region('Danh sách', K2) + region('CTA')));
  await write(mockupRel(K2), html(K2, region('App bar') + region('Gói cước'), { layout: 'web' }));
  await write(MOCKUP_INDEX_FILE, JSON.stringify({
    schema_version: 1,
    generatedAt: '2026-08-27T00:00:00.000Z',
    variant: 'original',
    screens: [
      { key: K1, name: 'Chọn quốc gia', file: mockupRel(K1), platform: 'mobile', navOut: [K2], pattern: 'list-search-rows', notes: 'theo ảnh BA' },
      { key: K2, name: 'Chọn gói', file: mockupRel(K2), platform: 'web', navOut: [], pattern: 'list-search-rows' },
    ],
  }));
  const r = await validateMockups(cwd, inputs([screen(K1, { navOut: [{ to: K2, via: 'Chọn' }] }), screen(K2, { platform: 'web' })]));
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.indexRebuilt, false);
  assert.deepEqual(r.index.screens.map((s) => [s.key, s.name, s.platform, s.navOut, s.pattern, s.notes]), [
    [K1, 'Chọn quốc gia', 'mobile', [K2], 'list-search-rows', 'theo ảnh BA'],
    [K2, 'Chọn gói', 'web', [], 'list-search-rows', undefined],
  ]);
  const audit = JSON.parse(await readFile(join(cwd, MOCKUP_AUDIT_FILE), 'utf8')) as {
    errors: string[]; warnings: string[]; screens: number; patterns: Record<string, string | null>; plainColumn: string[];
  };
  assert.deepEqual(audit, { ...audit, errors: [], warnings: [], screens: 2, patterns: { [K1]: 'list-search-rows', [K2]: 'list-search-rows' }, plainColumn: [] });
  // File không bị ghi lại khi không có gì phải sửa.
  assert.ok((await readFile(join(cwd, mockupRel(K1)), 'utf8')).includes(`data-nav="${K2}"`));
});

test('thiếu file màn → lỗi chặn kèm danh sách key; file còn lại vẫn vào index', async () => {
  await write(mockupRel(K1), html(K1, region('App bar')));
  const r = await validateMockups(cwd, inputs([screen(K1), screen(K2), screen(K3, { provenance: 'proposed' })]));
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /thiếu file mockup cho 2 màn/);
  assert.ok(r.errors[0]!.includes(K2) && r.errors[0]!.includes(K3));
  assert.deepEqual(r.index.screens.map((s) => s.key), [K1]);
});

test('<script>, <link>, <img src=http>, @import, url(http), quá 200 KB → lỗi (mỗi file một dòng / vi phạm)', async () => {
  await write(mockupRel(K1), html(K1, region('A') + '<script>alert(1)</script>'));
  await write(mockupRel(K2), html(K2, region('A') + '<img src="https://x/y.png">' + '<link rel="stylesheet" href="x.css">'));
  const big = html(K3, region('A') + '<p>' + 'x'.repeat(MOCKUP_MAX_BYTES) + '</p>');
  await write(mockupRel(K3), big);
  const r = await validateMockups(cwd, inputs([screen(K1), screen(K2), screen(K3)]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes(mockupRel(K1)) && e.includes('<script>')));
  assert.ok(r.errors.some((e) => e.includes(mockupRel(K2)) && e.includes('<img src="http')));
  assert.ok(r.errors.some((e) => e.includes(mockupRel(K2)) && e.includes('<link>')));
  assert.ok(r.errors.some((e) => e.includes(mockupRel(K3)) && /KB >/.test(e)));
  // Ảnh nội tuyến (data:) và url(#id) là hợp lệ.
  await write(mockupRel(K1), html(K1, region('A') + '<img src="data:image/png;base64,AAAA">' + '<style>.x{background:url(#grad)}</style>'));
  const r2 = await validateMockups(cwd, inputs([screen(K1)]));
  assert.equal(r2.ok, true, r2.errors.join(' | '));
});

test('data-nav trỏ key lạ → daemon XOÁ attribute + warning; nav đúng giữ; navOut trong index theo file đã sửa', async () => {
  await write(mockupRel(K1), html(K1, region('Danh sách', K2) + region('Khác', 'KHONG-CO') + `<section class="mk-region" data-region="cta" data-label="CTA" data-nav='OTHER'><p>Đi</p></section>`));
  await write(mockupRel(K2), html(K2, region('A')));
  const r = await validateMockups(cwd, inputs([screen(K1), screen(K2)]));
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.warnings.filter((w) => w.includes('data-nav')).length, 1);
  assert.ok(r.warnings.some((w) => w.includes('KHONG-CO') && w.includes('OTHER')));
  const fixed = await readFile(join(cwd, mockupRel(K1)), 'utf8');
  assert.ok(fixed.includes(`data-nav="${K2}"`));
  assert.ok(!fixed.includes('KHONG-CO') && !fixed.includes("data-nav='OTHER'"));
  assert.deepEqual(r.index.screens.find((s) => s.key === K1)?.navOut, [K2]);
});

test('data-screen sai/thiếu → daemon sửa theo key (warning); thiếu <style> → warning; platform từ data-layout, thiếu → input', async () => {
  await write(mockupRel(K1), html(K1, region('A'), { screenAttr: 'SAI', style: false }));
  await write(mockupRel(K2), html(K2, region('A'), { screenAttr: null, layout: 'web' }));
  await write(mockupRel(K3), `<!doctype html><html><head><style></style></head><body data-screen="${K3}">${region('A')}</body></html>`);
  const r = await validateMockups(cwd, inputs([screen(K1), screen(K2), screen(K3, { platform: 'web' })]));
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.ok(r.warnings.some((w) => w.includes(mockupRel(K1)) && w.includes('data-screen="SAI"')));
  assert.ok(r.warnings.some((w) => w.includes(mockupRel(K1)) && w.includes('thiếu <style>')));
  assert.ok(r.warnings.some((w) => w.includes(mockupRel(K2)) && w.includes('thiếu data-screen')));
  assert.ok((await readFile(join(cwd, mockupRel(K1)), 'utf8')).includes(`data-screen="${K1}"`));
  assert.ok((await readFile(join(cwd, mockupRel(K2)), 'utf8')).includes(`<body data-screen="${K2}"`));
  assert.deepEqual(r.index.screens.map((s) => s.platform), ['mobile', 'web', 'web']);
});

test('index.json thiếu → dựng lại từ file có mặt (variant theo selection, provenance chép từ input); hỏng → cũng dựng lại', async () => {
  await write(mockupRel(K1), html(K1, region('A', K3)));
  await write(mockupRel(K3), html(K3, region('B')));
  const r = await validateMockups(cwd, inputs([screen(K1), screen(K3, { provenance: 'proposed' })], { variant: 'improved', source: 'run-all' }));
  assert.equal(r.ok, true);
  assert.equal(r.indexRebuilt, true);
  assert.ok(r.warnings.some((w) => w.includes('index.json thiếu hoặc hỏng')));
  const onDisk = parseMockupIndex(await readFile(join(cwd, MOCKUP_INDEX_FILE), 'utf8'));
  assert.ok(onDisk);
  assert.equal(onDisk!.variant, 'improved');
  assert.deepEqual(onDisk!.screens.map((s) => [s.key, s.file, s.provenance, s.navOut]), [
    [K1, mockupRel(K1), undefined, [K3]],
    [K3, mockupRel(K3), 'proposed', []],
  ]);

  await write(MOCKUP_INDEX_FILE, '{ not json');
  const r2 = await validateMockups(cwd, inputs([screen(K1), screen(K3)]));
  assert.equal(r2.indexRebuilt, true);
  assert.equal(parseMockupIndex(await readFile(join(cwd, MOCKUP_INDEX_FILE), 'utf8'))?.screens.length, 2);
});

test('index.json của agent lệch đĩa → đối chiếu: bỏ màn không có file/không trong danh sách, bổ sung màn có file, sửa variant; file thừa → warning', async () => {
  await write(mockupRel(K1), html(K1, region('A')));
  await write(mockupRel(K2), html(K2, region('A')));
  await write('mockups/rac.html', html('rac', region('A')));
  await write(MOCKUP_INDEX_FILE, JSON.stringify({
    schema_version: 1, generatedAt: 'x', variant: 'improved',
    screens: [{ key: K1, name: 'Một', file: mockupRel(K1), platform: 'mobile', navOut: ['BAY'] }, { key: 'LA', name: 'Lạ', file: 'mockups/LA.html', platform: 'mobile', navOut: [] }],
  }));
  const r = await validateMockups(cwd, inputs([screen(K1), screen(K2)]));
  assert.equal(r.ok, true);
  assert.equal(r.indexRebuilt, false);
  assert.deepEqual(r.index.screens.map((s) => [s.key, s.name, s.navOut]), [[K1, 'Một', []], [K2, 'Màn SCR-002', []]]);
  assert.equal(r.index.variant, 'original');
  assert.ok(r.warnings.some((w) => w.includes('"LA"') && w.includes('không có trong danh sách')));
  assert.ok(r.warnings.some((w) => w.includes(`thiếu màn "${K2}"`)));
  assert.ok(r.warnings.some((w) => w.includes('variant "improved"')));
  assert.ok(r.warnings.some((w) => w.includes('rac')));
  assert.equal(parseMockupIndex(await readFile(join(cwd, MOCKUP_INDEX_FILE), 'utf8'))?.screens.length, 2);
});

test('skills/docs-screen-mockup/assets/_mockup.css tồn tại và có các class hợp đồng skill dùng', async () => {
  const css = await readFile(join(REPO_ROOT, 'skills', 'docs-screen-mockup', 'assets', '_mockup.css'), 'utf8');
  for (const cls of ['.mk-mobile', '.mk-web', '.mk-region', '[data-nav]', '[data-proposed]', '.mk-overlay']) {
    assert.ok(css.includes(cls), `_mockup.css phải có ${cls}`);
  }
  assert.ok(css.includes('attr(data-label)'));
  assert.ok(!/url\(\s*["']?https?:/i.test(css) && !/@import/.test(css), 'CSS tự chứa');
});

test('regression: chép NGUYÊN VĂN assets/_mockup.css vào <style> KHÔNG được trúng lọc <link>/<script> (comment CSS từng chứa "<link>")', async () => {
  const css = await readFile(path.join(REPO_ROOT, 'skills', 'docs-screen-mockup', 'assets', '_mockup.css'), 'utf8');
  await write(
    mockupRel(K1),
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body data-screen="${K1}" data-layout="mobile">${region('App bar')}</body></html>`,
  );
  const r = await validateMockups(cwd, inputs([screen(K1)]));
  assert.equal(r.ok, true, r.errors.join(' | '));
  // Tên class kit nằm trong khối style KHÔNG được tính là "đã dùng kit".
  assert.ok(r.warnings.some((w) => w.includes('1 cột thuần')));
});

// ── WP dr-mockup-layouts ───────────────────────────────────────────────────

test('thiếu data-pattern trên <body> → CHỈ warning (ok vẫn true); _audit.patterns ghi null', async () => {
  await write(mockupRel(K1), html(K1, region('App bar') + region('Danh sách'), { pattern: null }));
  await write(mockupRel(K2), html(K2, region('App bar'), { pattern: 'detail-hero-kv-cta' }));
  const r = await validateMockups(cwd, inputs([screen(K1), screen(K2)]));
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.filter((w) => w.includes('data-pattern')), [`${mockupRel(K1)}: thiếu data-pattern`]);
  assert.equal(r.index.screens.find((s) => s.key === K1)?.pattern, undefined);
  assert.equal(r.index.screens.find((s) => s.key === K2)?.pattern, 'detail-hero-kv-cta');
  const audit = JSON.parse(await readFile(join(cwd, MOCKUP_AUDIT_FILE), 'utf8')) as { patterns: Record<string, string | null>; plainColumn: string[] };
  assert.deepEqual(audit.patterns, { [K1]: null, [K2]: 'detail-hero-kv-cta' });
  assert.deepEqual(audit.plainColumn, []);
});

test('body chỉ có .mk-region xếp dọc → warning "1 cột thuần" + _audit.plainColumn; có .mk-grid-2 → không warning', async () => {
  await write(mockupRel(K1), html(K1, region('App bar') + region('Danh sách') + region('CTA'), { kit: false }));
  await write(mockupRel(K2), html(K2, region('App bar') + `<div class="mk-grid-2">${region('Gói A')}${region('Gói B')}</div>`, { kit: false }));
  await write(mockupRel(K3), html(K3, region('App bar') + `<section class='mk-region mk-split' data-region="content" data-label="Đơn"><p>x</p></section>`, { kit: false }));
  const r = await validateMockups(cwd, inputs([screen(K1), screen(K2), screen(K3)]));
  assert.equal(r.ok, true, r.errors.join(' | '));
  const plain = r.warnings.filter((w) => w.includes('1 cột thuần'));
  assert.deepEqual(plain, [`${mockupRel(K1)}: bố cục 1 cột thuần — xem references/layout-patterns.md`]);
  const audit = JSON.parse(await readFile(join(cwd, MOCKUP_AUDIT_FILE), 'utf8')) as { plainColumn: string[] };
  assert.deepEqual(audit.plainColumn, [K1]);
});

test('isPlainColumn / patternOf: mọi class kit đều được nhận; class trong <style> không tính; data-pattern nháy đơn/kép', () => {
  for (const cls of LAYOUT_KIT_CLASSES) {
    assert.equal(isPlainColumn(`<body><div class="mk-mobile ${cls}"></div></body>`), false, cls);
  }
  assert.equal(isPlainColumn(`<body><div class="mk-mobile"><section class="mk-region"></section></div></body>`), true);
  assert.equal(isPlainColumn(`<style>.mk-grid-2{display:grid}</style><body><div class="mk-mobile"></div></body>`), true);
  assert.equal(isPlainColumn(`<body><div class="mk-grid-20"></div></body>`), true, 'mk-grid-20 không phải kit');
  assert.equal(patternOf(`<body data-screen="x" data-pattern='form-grouped-cards'>`), 'form-grouped-cards');
  assert.equal(patternOf(`<body data-pattern="">`), null);
  assert.equal(patternOf(`<body data-screen="x">`), null);
});

test('pattern: data-pattern thắng index của agent; body không có → giữ pattern agent ghi; index rebuild đọc data-pattern', async () => {
  await write(mockupRel(K1), html(K1, region('A'), { pattern: 'checkout-summary-sticky' }));
  await write(mockupRel(K2), html(K2, region('A'), { pattern: null }));
  await write(MOCKUP_INDEX_FILE, JSON.stringify({
    schema_version: 1, generatedAt: 'x', variant: 'original',
    screens: [
      { key: K1, name: 'Một', file: mockupRel(K1), platform: 'mobile', navOut: [], pattern: 'list-search-rows', notes: 'agent ghi sai' },
      { key: K2, name: 'Hai', file: mockupRel(K2), platform: 'mobile', navOut: [], pattern: 'result-center-status' },
    ],
  }));
  const r = await validateMockups(cwd, inputs([screen(K1), screen(K2)]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.index.screens.map((s) => [s.key, s.pattern, s.notes]), [
    [K1, 'checkout-summary-sticky', 'agent ghi sai'],
    [K2, 'result-center-status', undefined],
  ]);
  const onDisk = parseMockupIndex(await readFile(join(cwd, MOCKUP_INDEX_FILE), 'utf8'));
  assert.deepEqual(onDisk?.screens.map((s) => s.pattern), ['checkout-summary-sticky', 'result-center-status']);

  // index.json thiếu → dựng lại, pattern đọc từ data-pattern của file.
  await rm(join(cwd, MOCKUP_INDEX_FILE));
  const r2 = await validateMockups(cwd, inputs([screen(K1), screen(K2)]));
  assert.equal(r2.indexRebuilt, true);
  assert.deepEqual(r2.index.screens.map((s) => s.pattern), ['checkout-summary-sticky', undefined]);
});

test('assets/_mockup.css có đủ class kit bố cục + references/layout-patterns.md có đủ pattern tối thiểu', async () => {
  const css = await readFile(join(REPO_ROOT, 'skills', 'docs-screen-mockup', 'assets', '_mockup.css'), 'utf8');
  for (const cls of [...LAYOUT_KIT_CLASSES, 'mk-thumb', 'mk-field', 'mk-chip', 'mk-stepper', 'mk-status', 'mk-fab']) {
    assert.ok(css.includes(`.${cls}`), `_mockup.css phải có .${cls}`);
  }
  const md = await readFile(join(REPO_ROOT, 'skills', 'docs-screen-mockup', 'references', 'layout-patterns.md'), 'utf8');
  for (const id of [
    'list-search-rows', 'list-chips-cards', 'list-segment-tabs', 'grid-cards-2col',
    'picker-search-groups', 'picker-grid-3col', 'picker-sheet',
    'detail-hero-kv-cta', 'detail-tabs', 'form-grouped-cards', 'form-two-col-short',
    'checkout-summary-sticky', 'checkout-accordion', 'result-center-status', 'result-timeline',
    'status-processing', 'status-empty', 'overlay-dialog', 'overlay-sheet',
    'home-hero-quickactions', 'settings-groups', 'web-master-detail', 'web-two-col-form',
  ]) {
    assert.ok(md.includes(`### ${id}`), `layout-patterns.md thiếu pattern ${id}`);
  }
});
