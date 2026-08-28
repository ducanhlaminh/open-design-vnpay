// WP screen-flow-platform-split (2026-08-28) — Luồng màn hình + Cải thiện luồng
// tách theo nền tảng App / Web:
//   - A0: key trong screens.json (đã finalize) là thẩm quyền DUY NHẤT —
//     discovery/comp manifest giữ nguyên, KHÔNG đánh lại `X<n>` theo thứ tự dòng;
//   - (a) 2 thư mục `SCREEN-FLOW--app` + `--web` → finalize OK, index 2 entry có
//     `platform`, discovery hợp + `groupKey` cho cặp `--app/--web`;
//   - (b) màn thiếu/lệch platform → lỗi nêu key; giá trị lạ → lỗi;
//   - (c) trộn `SCREEN-FLOW` + `--app` → lỗi SCREEN_FLOW_MIXED;
//   - (d) tài liệu 1 nền tảng → output byte-identical (không field mới rỗng);
//   - (e) improve finalize per flow + selection riêng;
//   - (f) review context là mảng `flows[]`, rule_id theo flow id.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { splitSections } from '../src/docs-review.js';
import { buildEnrichKickoff } from '../src/docs-review-enrich.js';
import { finalizeFlowUx } from '../src/flow-ux/index.js';
import { finalizeScreenFlowImproveAll, readScreenFlowSelection } from '../src/flow-ux/screen-flow-improve.js';
import { loadScreenFlowReviewContext, mapScreenFlowToPage, screenFlowRefs, writeScreenFlowReviewContext, SCREEN_FLOW_CONTEXT_REL } from '../src/flow-ux/screen-flow-review.js';
import { renderDiscoveredMd } from '../src/flow-ux/screen-flow-screens.js';
import {
  SCREEN_FLOW_CELLS_FILE,
  SCREEN_FLOW_ID,
  finalizeScreenFlowXml,
  isScreenFlowId,
  listScreenFlowIds,
  screenFlowIdFor,
  screenFlowPlatformOf,
} from '../src/flow-ux/screen-flow-xml.js';
import { parseScreensDiscovered, prepareScreenComponentInputs, resolveDocScreens } from '../src/screen-components.js';
import { persistScreenDiscovery, SCREENS_DISCOVERED_FILE } from '../src/screen-discovery.js';
import { SCREENS_MANIFEST_FILE } from '../src/screen-overrides.js';

const vertex = (id: string, label: string, x: number, y: number, w = 200, h = 60) =>
  `<mxCell id="${id}" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">\n` +
  `  <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" />\n` +
  `</mxCell>`;
const edge = (id: string, from: string, to: string, label: string, anchors = 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;') =>
  `<mxCell id="${id}" value="${label}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;${anchors}" edge="1" parent="1" source="${from}" target="${to}">\n` +
  `  <mxGeometry relative="1" as="geometry" />\n` +
  `</mxCell>`;

/** Fragment 2 màn + Bắt đầu; id node theo tiền tố để hai flow không đụng nhau. */
const fragment = (p: string) =>
  [
    vertex(`od-${p}-start`, 'Bắt đầu', 40, 40, 150, 50),
    vertex(`od-${p}-1`, 'X1 · Hỗ trợ trực tuyến', 40, 200),
    vertex(`od-${p}-2`, 'X2 · Quản lý yêu cầu', 340, 200),
    edge(`od-${p}-e1`, `od-${p}-start`, `od-${p}-1`, 'Mở', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;'),
    edge(`od-${p}-e2`, `od-${p}-1`, `od-${p}-2`, 'Xem yêu cầu'),
  ].join('\n');

const CR_MD = [
  '# CR — Hỗ trợ trực tuyến GĐ2',
  '',
  '## 2.2 Màn hình MB',
  '',
  '### Hỗ trợ trực tuyến (MB)',
  '',
  'Mô tả MB.',
  '',
  '### Quản lý yêu cầu (MB)',
  '',
  '## 2.3 Màn hình IB',
  '',
  '### Hỗ trợ trực tuyến (IB)',
  '',
  '### Quản lý yêu cầu (IB)',
  '',
  '## 2.4 BO',
  '',
  '### BO — Quản lý yêu cầu hỗ trợ',
  '',
  'Mô tả BO.',
  '',
].join('\n');
const SRC = 'docs-feature/cr.md';
const PAGES = [{ mdPath: SRC, page: 'cr' }];

function mkcwd(prefix = 'sfps-'): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(cwd, 'docs-feature'), { recursive: true });
  fs.writeFileSync(path.join(cwd, SRC), CR_MD);
  return cwd;
}
function writeFlow(cwd: string, id: string, cells: string, screens: unknown): string {
  const dir = path.join(cwd, 'flows', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SCREEN_FLOW_CELLS_FILE), cells);
  fs.writeFileSync(path.join(dir, 'screens.json'), JSON.stringify(screens));
  return dir;
}
const readJson = <T,>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8')) as T;

const APP_SCREENS = {
  title: 'Luồng màn hình — Hỗ trợ trực tuyến GĐ2',
  source: SRC,
  screens: [
    { key: 'cr__X1--app', code: null, name: 'Hỗ trợ trực tuyến', anchorText: '### Hỗ trợ trực tuyến (MB)', cell: 'od-app-1', platform: 'app' },
    { key: 'cr__X2--app', code: null, name: 'Quản lý yêu cầu', anchorText: '### Quản lý yêu cầu (MB)', cell: 'od-app-2', platform: 'app' },
  ],
  excluded: [{ name: '2.2 Màn hình MB', reason: 'Heading nhóm.' }],
};
const WEB_SCREENS = {
  title: 'Luồng màn hình — Hỗ trợ trực tuyến GĐ2',
  source: SRC,
  screens: [
    { key: 'cr__X1--web', code: null, name: 'Hỗ trợ trực tuyến', anchorText: '### Hỗ trợ trực tuyến (IB)', cell: 'od-web-1', platform: 'web' },
    { key: 'cr__X2--web', code: null, name: 'Quản lý yêu cầu', anchorText: '### Quản lý yêu cầu (IB)', cell: 'od-web-2', platform: 'web' },
    // BO — agent quyết tính vào Web; không có biến thể App → không groupKey.
    { key: 'cr__X3', code: null, name: 'BO — Quản lý yêu cầu hỗ trợ', anchorText: '### BO — Quản lý yêu cầu hỗ trợ', cell: null, platform: 'web' },
  ],
  excluded: [{ name: '2.3 Màn hình IB', reason: 'Heading nhóm.' }],
};

/** Dựng cặp app/web đã finalize (dr-flow xong) — dùng cho (a)(e)(f). */
async function setupSplit(): Promise<string> {
  const cwd = mkcwd();
  writeFlow(cwd, 'SCREEN-FLOW--app', fragment('app'), APP_SCREENS);
  writeFlow(cwd, 'SCREEN-FLOW--web', fragment('web'), WEB_SCREENS);
  // Seed do prepareFlowUxInputs để lại — phải rời sang _seeds/.
  fs.mkdirSync(path.join(cwd, 'flows', 'FLOW-SEED'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'flows', 'FLOW-SEED', 'as-is.mmd'), 'flowchart TD\n  a --> b\n');
  fs.writeFileSync(
    path.join(cwd, 'flows', '_inputs.json'),
    JSON.stringify({ generatedAt: '2026-08-28T00:00:00.000Z', flows: [{ id: 'FLOW-SEED', title: 'Seed', kind: 'mermaid', source: SRC, diagram: 'flows/FLOW-SEED/as-is.mmd', files: { asIs: 'flows/FLOW-SEED/as-is.mmd' }, counts: { nodes: 2, edges: 1 } }] }),
  );
  return cwd;
}

test('id helpers: SCREEN_FLOW_ID_RE / screenFlowPlatformOf / screenFlowIdFor', () => {
  assert.equal(isScreenFlowId('SCREEN-FLOW'), true);
  assert.equal(isScreenFlowId('SCREEN-FLOW--app'), true);
  assert.equal(isScreenFlowId('SCREEN-FLOW--web'), true);
  assert.equal(isScreenFlowId('SCREEN-FLOW--ib'), false);
  assert.equal(isScreenFlowId('FLOW-x'), false);
  assert.equal(screenFlowPlatformOf('SCREEN-FLOW'), null);
  assert.equal(screenFlowPlatformOf('SCREEN-FLOW--app'), 'app');
  assert.equal(screenFlowPlatformOf('SCREEN-FLOW--web'), 'web');
  assert.equal(screenFlowIdFor('app'), 'SCREEN-FLOW--app');
  assert.equal(screenFlowIdFor(null), SCREEN_FLOW_ID);
});

// ── A0 ────────────────────────────────────────────────────────────────────
test('A0: key trong screens.json là thẩm quyền — comp/_screens.json giữ nguyên key dù thứ tự agent ≠ thứ tự dòng và có màn bị loại', async () => {
  const cwd = mkcwd('sfa0-');
  // Agent đánh X1 = màn ở dòng SAU CÙNG (BO), X2 = màn dòng đầu, X3 = màn giữa;
  // thêm một màn anchor sai (bị loại) — trước đây làm mọi X phía sau lệch.
  writeFlow(cwd, SCREEN_FLOW_ID, fragment('sf'), {
    title: 'Luồng màn hình — HTTT',
    source: SRC,
    screens: [
      { key: 'cr__X1', code: null, name: 'BO — Quản lý yêu cầu hỗ trợ', anchorText: '### BO — Quản lý yêu cầu hỗ trợ', cell: 'od-sf-1' },
      { key: 'cr__X2', code: null, name: 'Hỗ trợ trực tuyến', anchorText: '### Hỗ trợ trực tuyến (MB)', cell: 'od-sf-2' },
      { key: 'cr__X9', code: null, name: 'Anchor sai', anchorText: '### Không có dòng này', cell: null },
      { key: 'cr__X3', code: null, name: 'Quản lý yêu cầu', anchorText: '### Quản lý yêu cầu (MB)', cell: null },
    ],
    excluded: [],
  });
  const sf = await finalizeScreenFlowXml(cwd);
  assert.deepEqual(sf.errors, []);
  assert.ok(sf.discovery);
  assert.deepEqual(sf.discovery!.pages[0]!.screens.map((s) => [s.key, s.code]), [
    ['cr__X1', null],
    ['cr__X2', null],
    ['cr__X9', null],
    ['cr__X3', null],
  ]);

  const persisted = await persistScreenDiscovery({ cwd, pages: PAGES, doc: sf.discovery, md: renderDiscoveredMd(sf.discovery!, 'HTTT'), generatedAt: 't' });
  assert.equal(persisted.ok, true, JSON.stringify(persisted));
  if (!persisted.ok) return;
  assert.equal(persisted.accepted, 3);
  assert.equal(persisted.rejected.length, 1);
  const manifest = readJson<{ schema_version: number; screens: Array<{ key: string; code: string; name: string }> }>(path.join(cwd, SCREENS_MANIFEST_FILE));
  // Đúng key/code của screens.json, đúng thứ tự agent — không phải X1/X2/X3 theo dòng.
  assert.deepEqual(
    manifest.screens.map((s) => [s.key, s.code, s.name]),
    [
      ['cr__X1', 'X1', 'BO — Quản lý yêu cầu hỗ trợ'],
      ['cr__X2', 'X2', 'Hỗ trợ trực tuyến'],
      ['cr__X3', 'X3', 'Quản lý yêu cầu'],
    ],
  );
  const screensJson = readJson<{ screens: Array<{ key: string }> }>(path.join(cwd, 'flows', SCREEN_FLOW_ID, 'screens.json'));
  const accepted = new Set(manifest.screens.map((s) => s.key));
  for (const s of screensJson.screens) if (s.key !== 'cr__X9') assert.ok(accepted.has(s.key), `${s.key} phải có trong comp/_screens.json`);
  // Không có groupKey/đổi tên key nào (agent không đặt hậu tố; tên khác nhau).
  assert.ok(!fs.readFileSync(path.join(cwd, SCREENS_MANIFEST_FILE), 'utf8').includes('"groupKey"'));

  // Nhánh dr-comp/dr-mockup (resolveDocScreens đọc screens-discovered.json) cũng giữ key.
  const discovered = parseScreensDiscovered(fs.readFileSync(path.join(cwd, SCREENS_DISCOVERED_FILE), 'utf8'))!;
  assert.deepEqual(discovered.pages[0]!.screens.map((s) => s.key), ['cr__X1', 'cr__X2', 'cr__X9', 'cr__X3']);
  const resolved = resolveDocScreens({ pages: PAGES, mdBySource: new Map([[SRC, CR_MD]]), discovered, existingKeys: new Set() });
  assert.deepEqual(resolved.map((s) => s.key), ['cr__X1', 'cr__X2', 'cr__X3']);
  // Và mockup/comp _inputs.json (màn từ flow + màn tài liệu) KHÔNG trộn hai bộ key.
  await finalizeFlowUx(cwd);
  const inputs = await prepareScreenComponentInputs(cwd, { pages: PAGES, outFile: 'mockups/_inputs.json' });
  assert.deepEqual(inputs.screens.map((s) => s.key).sort(), ['cr__X1', 'cr__X2', 'cr__X3']);
});

// ── (a) ───────────────────────────────────────────────────────────────────
test('(a) 2 thư mục app/web → finalize OK, _inputs/index 2 entry có platform, discovery hợp + groupKey cho cặp --app/--web, manifest giữ key agent', async () => {
  const cwd = await setupSplit();
  assert.deepEqual(await listScreenFlowIds(cwd), ['SCREEN-FLOW--app', 'SCREEN-FLOW--web']);

  const sf = await finalizeScreenFlowXml(cwd);
  assert.deepEqual(sf.errors, []);
  assert.deepEqual(sf.warnings, [], sf.warnings.join(' | '));
  assert.deepEqual(sf.flowIds, ['SCREEN-FLOW--app', 'SCREEN-FLOW--web']);
  assert.ok(!fs.existsSync(path.join(cwd, 'flows', SCREEN_FLOW_ID)), 'không có flows/SCREEN-FLOW/ khi đã tách');
  assert.ok(fs.existsSync(path.join(cwd, 'flows', '_seeds', 'FLOW-SEED', 'as-is.mmd')), 'seed dời sang _seeds/');
  for (const id of ['SCREEN-FLOW--app', 'SCREEN-FLOW--web']) {
    assert.ok(fs.existsSync(path.join(cwd, 'flows', id, 'as-is.drawio')), `${id}/as-is.drawio`);
    assert.ok(fs.existsSync(path.join(cwd, 'flows', id, 'cells.json')), `${id}/cells.json`);
  }

  const manifest = readJson<{ generatedAt: string; flows: Array<{ id: string; title: string; platform?: string; diagram: string }> }>(path.join(cwd, 'flows', '_inputs.json'));
  assert.equal(manifest.generatedAt, '2026-08-28T00:00:00.000Z');
  assert.deepEqual(
    manifest.flows.map((f) => [f.id, f.platform, f.title, f.diagram]),
    [
      ['SCREEN-FLOW--app', 'app', 'Luồng màn hình (App) — Hỗ trợ trực tuyến GĐ2', 'flows/SCREEN-FLOW--app/as-is.drawio'],
      ['SCREEN-FLOW--web', 'web', 'Luồng màn hình (Web) — Hỗ trợ trực tuyến GĐ2', 'flows/SCREEN-FLOW--web/as-is.drawio'],
    ],
  );

  // Discovery = hợp: 5 màn, mỗi màn platform; cặp --app/--web nhận groupKey = key bỏ hậu tố.
  assert.ok(sf.discovery);
  const screens = sf.discovery!.pages[0]!.screens;
  assert.deepEqual(
    screens.map((s) => [s.key, s.platform, s.groupKey ?? null]),
    [
      ['cr__X1--app', 'app', 'cr__X1'],
      ['cr__X2--app', 'app', 'cr__X2'],
      ['cr__X1--web', 'web', 'cr__X1'],
      ['cr__X2--web', 'web', 'cr__X2'],
      ['cr__X3', 'web', null],
    ],
  );
  assert.equal(sf.discovery!.excluded.length, 2);

  // finalizeFlowUx: 2 entry, platform + màn theo flow; flowchart riêng từng flow.
  const fin = await finalizeFlowUx(cwd);
  assert.deepEqual(fin.warnings, [], fin.warnings.join(' | '));
  assert.deepEqual(fin.index.map((e) => [e.id, e.platform, e.screens.map((s) => s.key).sort()]), [
    ['SCREEN-FLOW--app', 'app', ['cr__X1--app', 'cr__X2--app']],
    ['SCREEN-FLOW--web', 'web', ['cr__X1--web', 'cr__X2--web']],
  ]);
  assert.ok(fs.existsSync(path.join(cwd, 'flows', 'SCREEN-FLOW--app.flowchart.json')));
  assert.ok(fs.existsSync(path.join(cwd, 'flows', 'SCREEN-FLOW--web.flowchart.json')));
  const indexJson = readJson<Array<{ id: string; platform?: string }>>(path.join(cwd, 'flows', 'index.json'));
  assert.deepEqual(indexJson.map((e) => e.platform), ['app', 'web']);

  // Persist: manifest schema 2, key NGUYÊN VĂN (không --app--app), platform map App→mobile, groupKey từ hậu tố.
  const md = renderDiscoveredMd(sf.discovery!, 'Hỗ trợ trực tuyến GĐ2', { flowIds: sf.flowIds });
  assert.ok(md.includes('`flows/SCREEN-FLOW--app/screens.json` + `flows/SCREEN-FLOW--web/screens.json`'));
  assert.ok(md.includes('Hỗ trợ trực tuyến (App)'));
  const persisted = await persistScreenDiscovery({ cwd, pages: PAGES, doc: sf.discovery, md, generatedAt: 't' });
  assert.equal(persisted.ok, true, JSON.stringify(persisted));
  const compManifest = readJson<{ schema_version: number; screens: Array<{ key: string; platform?: string; groupKey?: string }> }>(path.join(cwd, SCREENS_MANIFEST_FILE));
  assert.equal(compManifest.schema_version, 2);
  assert.deepEqual(
    compManifest.screens.map((s) => [s.key, s.platform, s.groupKey ?? null]),
    [
      ['cr__X1--app', 'mobile', 'cr__X1'],
      ['cr__X2--app', 'mobile', 'cr__X2'],
      ['cr__X1--web', 'web', 'cr__X1'],
      ['cr__X2--web', 'web', 'cr__X2'],
      ['cr__X3', 'web', null],
    ],
  );

  // dr-mockup/dr-comp inputs: màn từ CẢ hai entry SCREEN-FLOW*, không nhân đôi, platform theo flow.
  const inputs = await prepareScreenComponentInputs(cwd, { pages: PAGES, outFile: 'mockups/_inputs.json' });
  assert.deepEqual(
    inputs.screens.map((s) => [s.key, s.flowId, s.platform ?? null]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    [
      ['cr__X1--app', 'SCREEN-FLOW--app', 'mobile'],
      ['cr__X1--web', 'SCREEN-FLOW--web', 'web'],
      ['cr__X2--app', 'SCREEN-FLOW--app', 'mobile'],
      ['cr__X2--web', 'SCREEN-FLOW--web', 'web'],
      ['cr__X3', '', 'web'],
    ],
  );
});

// ── (b) ───────────────────────────────────────────────────────────────────
test('(b) flow tách: màn thiếu platform / lệch thư mục / hậu tố key lệch → lỗi nêu key; platform lạ → lỗi; flow đơn ≥2 nền tảng → lỗi', async () => {
  const cwd = mkcwd('sfb-');
  writeFlow(cwd, 'SCREEN-FLOW--app', fragment('app'), {
    ...APP_SCREENS,
    screens: [
      { key: 'cr__X1--app', code: null, name: 'Hỗ trợ trực tuyến', anchorText: '### Hỗ trợ trực tuyến (MB)', cell: 'od-app-1' }, // thiếu
      { key: 'cr__X2--app', code: null, name: 'Quản lý yêu cầu', anchorText: '### Quản lý yêu cầu (MB)', cell: 'od-app-2', platform: 'web' }, // lệch
      { key: 'cr__X3--web', code: null, name: 'BO', anchorText: '### BO — Quản lý yêu cầu hỗ trợ', cell: null, platform: 'app' }, // hậu tố lệch
    ],
  });
  writeFlow(cwd, 'SCREEN-FLOW--web', fragment('web'), WEB_SCREENS);
  const r = await finalizeScreenFlowXml(cwd);
  assert.equal(r.found, true);
  assert.ok(r.errors.some((e) => e.startsWith('SCREEN-FLOW--app:') && e.includes('"cr__X1--app"') && e.includes('thiếu')), r.errors.join(' | '));
  assert.ok(r.errors.some((e) => e.includes('"cr__X2--app"') && e.includes('lệch')), r.errors.join(' | '));
  assert.ok(r.errors.some((e) => e.includes('"cr__X3--web"') && e.includes('--web')), r.errors.join(' | '));
  // Không ghi gì khi có lỗi.
  assert.ok(!fs.existsSync(path.join(cwd, 'flows', 'SCREEN-FLOW--app', 'as-is.drawio')));
  assert.ok(!fs.existsSync(path.join(cwd, 'flows', 'SCREEN-FLOW--web', 'as-is.drawio')), 'flow web hợp lệ cũng KHÔNG ghi khi flow app lỗi');

  // platform ngoài app|web → lỗi parse.
  const cwd2 = mkcwd('sfb2-');
  writeFlow(cwd2, 'SCREEN-FLOW--web', fragment('web'), {
    ...WEB_SCREENS,
    screens: [{ key: 'cr__X1--web', code: null, name: 'Hỗ trợ', anchorText: '### Hỗ trợ trực tuyến (IB)', cell: 'od-web-1', platform: 'ib' }],
  });
  const r2 = await finalizeScreenFlowXml(cwd2);
  assert.ok(r2.errors.some((e) => e.includes('platform "ib"')), r2.errors.join(' | '));

  // Flow đơn có màn ở CẢ app lẫn web → phải tách.
  const cwd3 = mkcwd('sfb3-');
  writeFlow(cwd3, SCREEN_FLOW_ID, fragment('sf'), {
    ...APP_SCREENS,
    screens: [
      { key: 'cr__X1', code: null, name: 'Hỗ trợ trực tuyến', anchorText: '### Hỗ trợ trực tuyến (MB)', cell: 'od-sf-1', platform: 'app' },
      { key: 'cr__X2', code: null, name: 'BO', anchorText: '### BO — Quản lý yêu cầu hỗ trợ', cell: 'od-sf-2', platform: 'web' },
    ],
  });
  const r3 = await finalizeScreenFlowXml(cwd3);
  assert.ok(r3.errors.some((e) => e.includes('phải tách') && e.includes('SCREEN-FLOW--app')), r3.errors.join(' | '));
});

// ── (c) ───────────────────────────────────────────────────────────────────
test('(c) trộn flows/SCREEN-FLOW với SCREEN-FLOW--app → lỗi SCREEN_FLOW_MIXED (listScreenFlowIds throw, finalize trả errors)', async () => {
  const cwd = mkcwd('sfc-');
  writeFlow(cwd, SCREEN_FLOW_ID, fragment('sf'), APP_SCREENS);
  writeFlow(cwd, 'SCREEN-FLOW--app', fragment('app'), APP_SCREENS);
  await assert.rejects(listScreenFlowIds(cwd), (e: Error & { code?: string }) => e.code === 'SCREEN_FLOW_MIXED');
  const r = await finalizeScreenFlowXml(cwd);
  assert.equal(r.found, true);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /^SCREEN_FLOW_MIXED/);
  assert.ok(!fs.existsSync(path.join(cwd, 'flows', SCREEN_FLOW_ID, 'as-is.drawio')));
});

// ── (d) ───────────────────────────────────────────────────────────────────
test('(d) tài liệu một nền tảng → flows/SCREEN-FLOW/ như cũ: _inputs.json byte-identical, index/discovery không field mới', async () => {
  const cwd = mkcwd('sfd-');
  writeFlow(cwd, SCREEN_FLOW_ID, fragment('sf'), {
    title: 'Luồng màn hình — HTTT',
    source: SRC,
    screens: [
      { key: 'cr__X1', code: null, name: 'Hỗ trợ trực tuyến', anchorText: '### Hỗ trợ trực tuyến (MB)', cell: 'od-sf-1' },
      { key: 'cr__X2', code: null, name: 'Quản lý yêu cầu', anchorText: '### Quản lý yêu cầu (MB)', cell: 'od-sf-2' },
    ],
    excluded: [],
  });
  fs.writeFileSync(path.join(cwd, 'flows', '_inputs.json'), JSON.stringify({ generatedAt: '2026-08-28T00:00:00.000Z', flows: [] }));
  const sf = await finalizeScreenFlowXml(cwd);
  assert.deepEqual(sf.errors, []);
  assert.deepEqual(sf.flowIds, [SCREEN_FLOW_ID]);

  // _inputs.json: đúng từng byte như finalizeScreenFlowXml trước WP (không `platform`).
  const expectedInputs = `${JSON.stringify(
    {
      generatedAt: '2026-08-28T00:00:00.000Z',
      flows: [
        {
          id: SCREEN_FLOW_ID,
          title: 'Luồng màn hình — HTTT',
          kind: 'drawio',
          source: SRC,
          diagram: `flows/${SCREEN_FLOW_ID}/as-is.drawio`,
          files: { asIs: `flows/${SCREEN_FLOW_ID}/as-is.drawio`, cells: `flows/${SCREEN_FLOW_ID}/cells.json` },
          counts: { nodes: 3, edges: 2 },
        },
      ],
    },
    null,
    2,
  )}\n`;
  assert.equal(fs.readFileSync(path.join(cwd, 'flows', '_inputs.json'), 'utf8'), expectedInputs);

  // screens.json chuẩn hoá: không có `platform` rò vào.
  const written = fs.readFileSync(path.join(cwd, 'flows', SCREEN_FLOW_ID, 'screens.json'), 'utf8');
  assert.ok(!written.includes('"platform"'));
  assert.ok(!written.includes('"groupKey"'));

  // index.json: một entry, KHÔNG `platform`; discovery: không `platform`/`groupKey`.
  const fin = await finalizeFlowUx(cwd);
  assert.deepEqual(fin.index.map((e) => e.id), [SCREEN_FLOW_ID]);
  assert.equal('platform' in fin.index[0]!, false);
  const indexRaw = fs.readFileSync(path.join(cwd, 'flows', 'index.json'), 'utf8');
  assert.ok(!indexRaw.includes('"platform"'));
  for (const s of sf.discovery!.pages[0]!.screens) {
    assert.equal('platform' in s, false);
    assert.equal('groupKey' in s, false);
  }
  const md = renderDiscoveredMd(sf.discovery!, 'HTTT', { flowIds: sf.flowIds });
  assert.ok(md.includes('_Sinh cùng bước Luồng màn hình (dr-flow) từ `flows/SCREEN-FLOW/screens.json`._'));
  const persisted = await persistScreenDiscovery({ cwd, pages: PAGES, doc: sf.discovery, md, generatedAt: 't' });
  assert.equal(persisted.ok, true);
  const discoveredRaw = fs.readFileSync(path.join(cwd, SCREENS_DISCOVERED_FILE), 'utf8');
  assert.ok(!discoveredRaw.includes('"platform"'));
  assert.ok(!discoveredRaw.includes('"groupKey"'));
  // comp/_screens.json: key nguyên văn, không groupKey (platform theo heading
  // MB/BO là hành vi 0.8.139 sẵn có cho tài liệu không khai `platform` — giữ nguyên).
  const compManifest = readJson<{ screens: Array<{ key: string; groupKey?: string }> }>(path.join(cwd, SCREENS_MANIFEST_FILE));
  assert.deepEqual(compManifest.screens.map((s) => [s.key, s.groupKey ?? null]), [['cr__X1', null], ['cr__X2', null]]);
});

// ── (e) ───────────────────────────────────────────────────────────────────
test('(e) improve finalize per flow: patch chỉ ở --web → web có proposed + selection run-all riêng, app không; index theo selection từng flow', async () => {
  const cwd = await setupSplit();
  assert.deepEqual((await finalizeScreenFlowXml(cwd)).errors, []);
  await finalizeFlowUx(cwd);
  const webDir = path.join(cwd, 'flows', 'SCREEN-FLOW--web');
  fs.writeFileSync(
    path.join(webDir, 'ux-review.json'),
    JSON.stringify({
      flowId: 'SCREEN-FLOW--web',
      verdict: 'needs-improvement',
      summary: 'Thiếu xác nhận.',
      findings: [{ id: 'UX-01', severity: 'major', title: 'Thiếu màn xác nhận', reason: 'x', evidence: ['docs-feature/cr.md#2.3'], cells: { asIs: ['od-web-2'], proposed: ['od-web-n1'] }, change: 'added' }],
    }),
  );
  fs.writeFileSync(
    path.join(webDir, 'patch.json'),
    JSON.stringify({
      flowId: 'SCREEN-FLOW--web',
      ops: [
        { op: 'addNode', id: 'od-web-n1', shape: 'action', label: 'Xác nhận', near: 'od-web-2', dir: 'below', finding: 'UX-01', screen: { key: 'cr__NEW-xac-nhan--web', name: 'Xác nhận' } },
        { op: 'addEdge', id: 'od-web-ne1', from: 'od-web-2', to: 'od-web-n1', label: 'Tiếp tục', finding: 'UX-01' },
      ],
    }),
  );
  // Luồng app tốt: ux-review rỗng, không patch.
  fs.writeFileSync(path.join(cwd, 'flows', 'SCREEN-FLOW--app', 'ux-review.json'), JSON.stringify({ flowId: 'SCREEN-FLOW--app', verdict: 'good', summary: 'ok', findings: [] }));

  const all = await finalizeScreenFlowImproveAll(cwd, { viaRunAll: true, generatedAt: '2026-08-28T01:00:00.000Z' });
  assert.deepEqual(all.results.map((r) => [r.flowId, r.hasProposal, r.findings, r.selection?.variant ?? null, r.selection?.source ?? null]), [
    ['SCREEN-FLOW--app', false, 0, null, null],
    ['SCREEN-FLOW--web', true, 1, 'improved', 'run-all'],
  ]);
  for (const w of all.warnings) assert.match(w, /^SCREEN-FLOW--(app|web): /);
  assert.ok(!fs.existsSync(path.join(cwd, 'flows', 'SCREEN-FLOW--app', 'selection.json')), 'flow app không có selection');
  assert.ok(fs.existsSync(path.join(webDir, 'selection.json')));
  assert.ok(fs.existsSync(path.join(webDir, 'proposed.drawio')));
  assert.ok(fs.existsSync(path.join(webDir, 'screens.improved.json')));
  assert.ok(!fs.existsSync(path.join(cwd, 'flows', 'SCREEN-FLOW--app', 'proposed.drawio')));
  assert.equal((await readScreenFlowSelection(cwd, 'SCREEN-FLOW--web'))?.variant, 'improved');
  assert.equal(await readScreenFlowSelection(cwd, 'SCREEN-FLOW--app'), null);

  const index = all.fin.index;
  const app = index.find((e) => e.id === 'SCREEN-FLOW--app')!;
  const web = index.find((e) => e.id === 'SCREEN-FLOW--web')!;
  assert.equal(app.variant, 'original');
  assert.deepEqual(app.selection, { variant: 'original', source: 'default' });
  assert.equal(web.variant, 'improved');
  assert.deepEqual(web.selection, { variant: 'improved', source: 'run-all' });
  assert.ok(web.screens.some((s) => s.key === 'cr__NEW-xac-nhan--web' && s.provenance === 'proposed'));
  assert.ok(!app.screens.some((s) => s.key === 'cr__NEW-xac-nhan--web'));
});

// ── (f) ───────────────────────────────────────────────────────────────────
test('(f) review context = mảng flows[] (id + platform), rule_id/diagram theo flow id, kickoff nêu nền tảng', async () => {
  const cwd = await setupSplit();
  assert.deepEqual((await finalizeScreenFlowXml(cwd)).errors, []);
  await finalizeFlowUx(cwd);

  const ctxs = await loadScreenFlowReviewContext(cwd);
  assert.ok(ctxs);
  assert.deepEqual(ctxs!.flows.map((f) => [f.id, f.platform, f.variant, f.diagram.file]), [
    ['SCREEN-FLOW--app', 'app', 'original', 'flows/SCREEN-FLOW--app/as-is.drawio'],
    ['SCREEN-FLOW--web', 'web', 'original', 'flows/SCREEN-FLOW--web/as-is.drawio'],
  ]);
  assert.deepEqual(ctxs!.flows[1]!.screens.map((s) => s.key), ['cr__X1--web', 'cr__X2--web', 'cr__X3']);
  assert.ok(ctxs!.flows[1]!.edges.some((e) => e.key === 'od-web-1→od-web-2'));
  assert.deepEqual(screenFlowRefs('SCREEN-FLOW--web'), {
    screens: 'flows/SCREEN-FLOW--web/screens.json',
    flowchart: 'flows/SCREEN-FLOW--web.flowchart.json',
    uxReview: 'flows/SCREEN-FLOW--web/ux-review.json',
    asIs: 'flows/SCREEN-FLOW--web/as-is.drawio',
    proposed: 'flows/SCREEN-FLOW--web/proposed.drawio',
  });

  await writeScreenFlowReviewContext(cwd, ctxs!);
  const written = readJson<{ generatedAt: string; flows: Array<{ id: string }> }>(path.join(cwd, SCREEN_FLOW_CONTEXT_REL));
  assert.deepEqual(written.flows.map((f) => f.id), ['SCREEN-FLOW--app', 'SCREEN-FLOW--web']);

  // Phép 1 trên flow web với trang chỉ mô tả IB: màn BO không có mục → note gap rule_id theo flow id.
  const page = ['# CR', '', '### Hỗ trợ trực tuyến (IB)', '', 'Người dùng xem yêu cầu.', ''].join('\n');
  const m = mapScreenFlowToPage(ctxs!.flows[1]!, { pageSrc: SRC, sections: splitSections(page), pageLines: page.split('\n'), original: page });
  const bo = m.gapNotes.find((n) => n.id === 'sys-screen-flow-cr__X3')!;
  assert.ok(bo, m.gapNotes.map((n) => n.id).join(','));
  assert.equal(bo.rule_id, 'flows/SCREEN-FLOW--web/screens.json#cr__X3');
  assert.match(bo.finding, /^Luồng màn hình \(Web\) \(bản nguyên bản\)/);

  const kickoff = buildEnrichKickoff({
    screenFlows: [
      { flowId: 'SCREEN-FLOW--app', platform: 'app', variant: 'original', findingsCount: 0, screensInSection: [{ key: 'cr__X1--app', name: 'Hỗ trợ trực tuyến', cell: 'od-app-1' }], edgesInSection: [], outcomes: [] },
      { flowId: 'SCREEN-FLOW--web', platform: 'web', variant: 'improved', findingsCount: 1, screensInSection: [], edgesInSection: [], outcomes: [] },
    ],
  });
  assert.ok(kickoff.includes('Luồng màn hình (App) bản Nguyên bản'));
  assert.ok(kickoff.includes('flows/SCREEN-FLOW--app.flowchart.json#<edgeKey>'));
  assert.ok(kickoff.includes('flows/SCREEN-FLOW--app/screens.json#<KEY>'));
  assert.ok(kickoff.includes('Luồng màn hình (Web) bản Cải thiện'));
  assert.ok(kickoff.includes('flows/SCREEN-FLOW--web/ux-review.json'));
  // Flow đơn: kickoff y hệt trước (không nhãn nền tảng, path SCREEN-FLOW).
  const single = buildEnrichKickoff({ screenFlow: { variant: 'original', findingsCount: 0, screensInSection: [], edgesInSection: [], outcomes: [] } });
  assert.ok(single.startsWith('Thước đo luồng: Luồng màn hình bản Nguyên bản (`review/_screen-flow-context.json`).'));
});

// ── A6 ────────────────────────────────────────────────────────────────────
test('A6: 2 flow cùng X1..X3 code null → web đánh lại X4..X6 (screens.json ghi lại, cells/index/discovery theo), không lỗi', async () => {
  const cwd = mkcwd('sfa6-');
  const appScreens = {
    title: 'Luồng màn hình — HTTT',
    source: SRC,
    screens: [
      { key: 'cr__X1', code: null, name: 'Hỗ trợ trực tuyến', anchorText: '### Hỗ trợ trực tuyến (MB)', cell: 'od-app-1', platform: 'app' },
      { key: 'cr__X2', code: null, name: 'Quản lý yêu cầu', anchorText: '### Quản lý yêu cầu (MB)', cell: 'od-app-2', platform: 'app' },
      { key: 'cr__X3', code: null, name: 'Tổng quan MB', anchorText: '## 2.2 Màn hình MB', cell: null, platform: 'app' },
    ],
    excluded: [],
  };
  const webScreens = {
    title: 'Luồng màn hình — HTTT',
    source: SRC,
    screens: [
      { key: 'cr__X1', code: null, name: 'Hỗ trợ trực tuyến IB', anchorText: '### Hỗ trợ trực tuyến (IB)', cell: 'od-web-1', platform: 'web' },
      { key: 'cr__X2', code: null, name: 'Quản lý yêu cầu IB', anchorText: '### Quản lý yêu cầu (IB)', cell: 'od-web-2', platform: 'web' },
      { key: 'cr__X3', code: null, name: 'Tổng quan IB', anchorText: '## 2.3 Màn hình IB', cell: null, platform: 'web' },
    ],
    excluded: [{ name: 'Mục lục', reason: 'x', partOf: 'cr__X1' }],
  };
  writeFlow(cwd, 'SCREEN-FLOW--app', fragment('app'), appScreens);
  writeFlow(cwd, 'SCREEN-FLOW--web', fragment('web'), webScreens);
  const sf = await finalizeScreenFlowXml(cwd);
  assert.deepEqual(sf.errors, []);
  assert.equal(sf.warnings.length, 1, sf.warnings.join(' | '));
  assert.match(sf.warnings[0]!, /^SCREEN-FLOW--web: 3 màn .*X1→X4, X2→X5, X3→X6/);

  // screens.json của web ghi lại với key mới; app giữ nguyên.
  const app = readJson<{ screens: Array<{ key: string }>; cells: Record<string, string> }>(path.join(cwd, 'flows', 'SCREEN-FLOW--app', 'screens.json'));
  const web = readJson<{ screens: Array<{ key: string; cell: string | null }>; cells: Record<string, string>; names: Record<string, string>; excluded: Array<{ partOf?: string }> }>(path.join(cwd, 'flows', 'SCREEN-FLOW--web', 'screens.json'));
  assert.deepEqual(app.screens.map((s) => s.key), ['cr__X1', 'cr__X2', 'cr__X3']);
  assert.deepEqual(web.screens.map((s) => s.key), ['cr__X4', 'cr__X5', 'cr__X6']);
  assert.deepEqual(web.cells, { 'od-web-1': 'cr__X4', 'od-web-2': 'cr__X5' });
  assert.deepEqual(Object.keys(web.names), ['cr__X4', 'cr__X5', 'cr__X6']);
  assert.equal(web.excluded[0]!.partOf, 'cr__X4');

  // Discovery đủ 6 màn, key duy nhất, không groupKey (không cặp hậu tố).
  const keys = sf.discovery!.pages[0]!.screens.map((s) => s.key);
  assert.deepEqual(keys, ['cr__X1', 'cr__X2', 'cr__X3', 'cr__X4', 'cr__X5', 'cr__X6']);
  assert.ok(sf.discovery!.pages[0]!.screens.every((s) => !s.groupKey));

  const fin = await finalizeFlowUx(cwd);
  assert.deepEqual(fin.index.find((e) => e.id === 'SCREEN-FLOW--web')!.screens.map((s) => s.key).sort(), ['cr__X4', 'cr__X5']);
  const persisted = await persistScreenDiscovery({ cwd, pages: PAGES, doc: sf.discovery, md: 'x', generatedAt: 't' });
  assert.equal(persisted.ok, true, JSON.stringify(persisted));
  const manifest = readJson<{ screens: Array<{ key: string; platform?: string }> }>(path.join(cwd, SCREENS_MANIFEST_FILE));
  assert.equal(manifest.screens.length, 6);
  assert.equal(manifest.screens.filter((s) => s.platform === 'web').length, 3);
  assert.equal(manifest.screens.filter((s) => s.platform === 'mobile').length, 3);

  // Idempotent: chạy lại trên file đã đánh lại → không trùng, không đổi nữa.
  const again = await finalizeScreenFlowXml(cwd);
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.warnings, []);
  assert.deepEqual(readJson<{ screens: Array<{ key: string }> }>(path.join(cwd, 'flows', 'SCREEN-FLOW--web', 'screens.json')).screens.map((s) => s.key), ['cr__X4', 'cr__X5', 'cr__X6']);
});

test('A6: 2 flow trùng key có code THẬT không hậu tố → lỗi finalize nêu key, không ghi', async () => {
  const cwd = mkcwd('sfa6b-');
  writeFlow(cwd, 'SCREEN-FLOW--app', fragment('app'), {
    title: 'T', source: SRC,
    screens: [{ key: 'cr__SCR-01', code: 'SCR-01', name: 'Hỗ trợ', anchorText: '### Hỗ trợ trực tuyến (MB)', cell: 'od-app-1', platform: 'app' }],
    excluded: [],
  });
  writeFlow(cwd, 'SCREEN-FLOW--web', fragment('web'), {
    title: 'T', source: SRC,
    screens: [{ key: 'cr__SCR-01', code: 'SCR-01', name: 'Hỗ trợ', anchorText: '### Hỗ trợ trực tuyến (IB)', cell: 'od-web-1', platform: 'web' }],
    excluded: [],
  });
  const r = await finalizeScreenFlowXml(cwd);
  assert.equal(r.errors.length, 1, r.errors.join(' | '));
  assert.match(r.errors[0]!, /^SCREEN-FLOW--web: key "cr__SCR-01" trùng với flow SCREEN-FLOW--app/);
  assert.match(r.errors[0]!, /--app.*--web/);
  assert.ok(!fs.existsSync(path.join(cwd, 'flows', 'SCREEN-FLOW--web', 'as-is.drawio')));
  assert.ok(!fs.existsSync(path.join(cwd, 'flows', 'SCREEN-FLOW--app', 'as-is.drawio')));
});
