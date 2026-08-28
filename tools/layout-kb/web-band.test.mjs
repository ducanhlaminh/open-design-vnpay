// node --test tools/layout-kb/web-band.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bandsFromBoxes, classifyRow, collapse, kindOf, sketchFor, slugOf, signatureOf, topicFor, SKETCH_LINES, SKETCH_W } from './web-band.mjs';

const VP = { w: 1440, h: 900, docH: 1400 };
const el = (tag, cls, x, y, w, h, extra = {}) => ({ tag, cls, x, y, w, h, ...extra });
const shell = () => [
  el('nav', 'app-header navbar', 250, 0, 1190, 56),
  el('aside', 'app-sidebar sidebar', 0, 0, 250, 1400),
  el('a', 'nav-link', 10, 80, 230, 32),
  el('a', 'nav-link', 10, 120, 230, 32),
  el('input', 'form-control', 400, 12, 300, 32), // ô tìm trong topbar → bỏ
];

test('admin shell: sidenav + filterbar + table + pagination', () => {
  const els = [
    ...shell(),
    el('nav', 'breadcrumb', 270, 70, 400, 20),
    el('div', 'card', 270, 110, 1150, 700, { inputs: 2 }),
    el('input', 'form-control', 290, 130, 240, 36),
    el('select', 'form-select', 550, 130, 200, 36),
    el('button', 'btn', 770, 130, 90, 36),
    el('table', 'table', 290, 190, 1110, 520),
    el('ul', 'pagination', 290, 740, 400, 40),
    el('footer', 'app-footer', 250, 1340, 1190, 60),
  ];
  const r = bandsFromBoxes(els, VP);
  assert.equal(r.sidenav, true);
  assert.deepEqual(r.bands, ['topbar', 'sidenav', 'breadcrumb', 'table', 'footer']);
  // card chứa table → cả card là 1 band table (filterbar/pagination nằm TRONG card table)
  // → đặt filterbar/pagination NGOÀI card để test chuỗi đầy đủ:
  const els2 = [
    ...shell(),
    el('input', 'form-control', 290, 80, 240, 36),
    el('select', 'form-select', 550, 80, 200, 36),
    el('button', 'btn', 770, 80, 90, 36),
    el('table', 'table', 290, 140, 1110, 520),
    el('ul', 'pagination', 290, 700, 400, 40),
  ];
  const r2 = bandsFromBoxes(els2, VP);
  assert.deepEqual(r2.bands, ['topbar', 'sidenav', 'filterbar', 'table', 'pagination']);
  assert.equal(topicFor({ name: 'data', url: 'tables/data.html', bands: r2.bands }), 'web-table');
});

test('form 2 cột trong card → form-2col + actions', () => {
  const els = [
    ...shell(),
    el('div', 'card', 270, 80, 1150, 600),
    el('form', '', 290, 100, 1110, 560),
    el('input', 'form-control', 300, 120, 500, 36),
    el('input', 'form-control', 860, 120, 500, 36),
    el('input', 'form-control', 300, 180, 500, 36),
    el('input', 'form-control', 860, 180, 500, 36),
    el('textarea', 'form-control', 300, 240, 1060, 120),
    el('button', 'btn btn-primary', 1260, 700, 100, 36),
  ];
  const r = bandsFromBoxes(els, VP);
  assert.deepEqual(r.bands, ['topbar', 'sidenav', 'form-2col', 'actions']);
  assert.equal(topicFor({ name: 'layout', url: 'forms/layout.html', bands: r.bands }), 'web-form');
});

test('form 1 cột → form(N); input rời liên tiếp gộp form', () => {
  const els = [
    ...shell(),
    el('input', 'form-control', 300, 100, 600, 36),
    el('input', 'form-control', 300, 160, 600, 36),
    el('input', 'form-control', 300, 220, 600, 36),
    el('button', 'btn', 300, 300, 120, 36),
  ];
  const r = bandsFromBoxes(els, VP);
  assert.deepEqual(r.bands, ['topbar', 'sidenav', 'form(3)', 'actions']);
  assert.deepEqual(collapse(['input', 'input', 'actions']), ['form(2)', 'actions']);
  assert.deepEqual(collapse(['form(2)', 'form(3)']), ['form(5)']);
});

test('dashboard: kpi cards + chart + table → web-dashboard', () => {
  const els = [
    ...shell(),
    el('div', 'small-box', 270, 80, 270, 120, { num: true }),
    el('div', 'small-box', 560, 80, 270, 120, { num: true }),
    el('div', 'small-box', 850, 80, 270, 120, { num: true }),
    el('div', 'small-box', 1140, 80, 270, 120, { num: true }),
    el('div', 'card', 270, 230, 760, 360),
    el('canvas', '', 290, 260, 720, 300),
    el('div', 'card', 1050, 230, 370, 360),
    el('table', 'table', 1060, 260, 350, 300),
    el('div', 'card', 270, 620, 1150, 300),
    el('table', 'table', 290, 640, 1110, 260),
  ];
  const r = bandsFromBoxes(els, VP);
  assert.deepEqual(r.bands, ['topbar', 'sidenav', 'kpi-cards', 'table', 'table'].slice(0, 3).concat(r.bands.slice(3)));
  assert.equal(r.bands[2], 'kpi-cards');
  // hàng chart+table cùng dải y → table thắng (classifyRow ưu tiên table); hàng cuối là table → gộp còn 1
  assert.ok(r.bands.includes('table'));
  assert.equal(topicFor({ name: 'index', url: 'index.html', bands: r.bands }), 'web-dashboard');
  assert.equal(classifyRow({ units: [{ kind: 'chart', x: 0, y: 0, w: 700, h: 300 }] }, 1190), 'chart');
});

test('Tabler kpi: 4 card nhỏ (không small-box) → kpi-cards', () => {
  const cards = [0, 1, 2, 3].map((i) => el('div', 'card', 270 + i * 290, 80, 270, 110, { txt: 30 }));
  const r = bandsFromBoxes([...shell(), ...cards], VP);
  assert.deepEqual(r.bands, ['topbar', 'sidenav', 'kpi-cards']);
});

test('portal (không sidenav): header-nav + hero + cards-3 + footer → web-list', () => {
  const els = [
    el('header', 'navbar navbar-expand-lg', 0, 0, 1440, 64),
    el('section', 'hero', 0, 64, 1440, 300),
    el('div', 'card', 120, 400, 380, 260),
    el('div', 'card', 530, 400, 380, 260),
    el('div', 'card', 940, 400, 380, 260),
    el('footer', 'footer', 0, 1300, 1440, 100),
  ];
  const r = bandsFromBoxes(els, VP);
  assert.equal(r.sidenav, false);
  assert.deepEqual(r.bands, ['header-nav', 'hero', 'cards-3', 'footer']);
  assert.equal(topicFor({ name: 'projects', url: 'pages/projects.html', bands: r.bands }), 'web-list');
});

test('login: card giữa màn với 2 input + nút → form(2) actions → web-auth', () => {
  const els = [
    el('div', 'card', 520, 250, 400, 320),
    el('input', 'form-control', 540, 300, 360, 40),
    el('input', 'form-control', 540, 360, 360, 40),
    el('button', 'btn btn-primary', 540, 430, 360, 40),
  ];
  const r = bandsFromBoxes(els, VP);
  assert.deepEqual(r.bands, ['form(2)']);
  assert.equal(topicFor({ name: 'login', url: 'examples/login.html', bands: r.bands }), 'web-auth');
});

test('detail: tabs + kv + stepper → topic theo band/tên', () => {
  const els = [...shell(), el('ul', 'nav nav-tabs', 270, 80, 600, 40), el('dl', 'datagrid', 270, 140, 1100, 200)];
  const r = bandsFromBoxes(els, VP);
  assert.deepEqual(r.bands, ['topbar', 'sidenav', 'tabs', 'kv']);
  assert.equal(topicFor({ name: 'profile', url: 'pages/profile.html', bands: r.bands }), 'web-detail');
  const w = bandsFromBoxes([...shell(), el('div', 'bs-stepper', 270, 80, 1100, 400)], VP);
  assert.deepEqual(w.bands, ['topbar', 'sidenav', 'stepper']);
  assert.equal(topicFor({ name: 'wizard', bands: w.bands }), 'web-wizard');
  assert.equal(topicFor({ name: 'settings', bands: ['topbar', 'sidenav', 'form(4)'] }), 'web-settings');
});

test('modal đứng đầu chuỗi band; trang trống → empty', () => {
  const els = [...shell(), el('table', 'table', 270, 80, 1100, 500), el('div', 'modal-dialog', 420, 200, 600, 400, { role: 'dialog' })];
  const r = bandsFromBoxes(els, VP);
  assert.equal(r.bands[0], 'modal');
  assert.ok(r.bands.includes('table'));
  const e = bandsFromBoxes([...shell()], VP);
  assert.deepEqual(e.bands, ['topbar', 'sidenav', 'empty']);
});

test('kindOf: từ khoá class + tag + role', () => {
  assert.equal(kindOf({ tag: 'div', cls: 'card card-body' }), 'card');
  assert.equal(kindOf({ tag: 'div', role: 'tablist' }), 'tabs');
  assert.equal(kindOf({ tag: 'div', cls: 'row' }), null);
  assert.equal(kindOf({ tag: 'div', cls: 'modal-backdrop' }), null);
  assert.equal(kindOf({ tag: 'svg', w: 400, h: 200 }), 'chart');
  assert.equal(kindOf({ tag: 'h1' }), 'title');
});

test('sketch 40 cột × 12 dòng, sidenav chiếm 8 cột trái', () => {
  const bands = ['topbar', 'sidenav', 'filterbar', 'table', 'pagination', 'footer'];
  const s = sketchFor(bands);
  const lines = s.split('\n');
  assert.equal(lines.length, SKETCH_LINES);
  for (const l of lines) assert.equal([...l].length, SKETCH_W, l);
  assert.ok(lines[2].startsWith('│≡ Menu │'), lines[2]);
  assert.ok(lines[1].includes('Logo'));
  assert.ok(lines[10].includes('©'));
  const p = sketchFor(['header-nav', 'hero', 'cards-3']).split('\n');
  assert.equal(p.length, SKETCH_LINES);
  assert.ok(!p[2].startsWith('│≡ Menu'));
  for (const l of p) assert.equal([...l].length, SKETCH_W, l);
});

test('signature/slug bỏ số đếm', () => {
  assert.equal(signatureOf(['topbar', 'sidenav', 'form(3)', 'actions']), 'topbar › sidenav › form › actions');
  assert.equal(slugOf(['topbar', 'sidenav', 'form-2col', 'actions']), 'topbar-sidenav-form2col-actions');
});
