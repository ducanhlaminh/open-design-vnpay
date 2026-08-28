// WP dr-screens-merge (2026-08-27): screens.json v2 (`screens[]`) của dr-flow
// → dẫn xuất cells/names (contract v1) + DiscoveredDoc (contract
// screens-discovered.json) + bản .md người-đọc. Module thuần, không fs/Date.
import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  deriveCellsAndNames,
  parseScreenFlowScreensV2,
  renderDiscoveredMd,
  toDiscoveredDoc,
  type ScreensV2,
} from '../src/flow-ux/screen-flow-screens.js';

const V2_RAW = {
  title: 'Luồng màn hình — Mua SIM',
  source: 'docs-feature/prd.md',
  screens: [
    { key: 'prd__6.1.1', code: '6.1.1', name: 'Trang chủ', anchorText: '#### 6.1.1 Trang chủ', cell: 'od-6-1-1', why: 'Màn khởi đầu.' },
    {
      key: 'prd__6.4.1',
      code: '6.4.1',
      name: 'Nhập thông tin',
      anchorText: '#### 6.4.1 Nhập thông tin',
      cell: 'od-6-4-1',
      blocks: [
        { name: 'Mã voucher', anchorText: '#### 6.4.4. Mã voucher', why: 'Bottom-sheet trong màn.' },
        { name: 'thiếu anchor' },
      ],
    },
    { key: 'prd__6.3.2', code: '6.3.2', name: 'Chi tiết gói VN', anchorText: '#### 6.3.2. Chi tiết gói VN', cell: null },
    { key: 'other__X', code: null, name: 'Màn trang khác', anchorText: '## Màn trang khác', cell: null, source: 'docs-feature/other.md' },
    { key: '', name: 'thiếu key', anchorText: 'x', cell: null },
    'không phải object',
  ],
  excluded: [
    { name: '6. Khung giao diện sơ bộ', reason: 'Heading nhóm.' },
    { name: 'Phụ lục', reason: 'Bảng.', source: 'docs-feature/other.md', partOf: 'prd__6.1.1' },
    { name: 'thiếu reason' },
  ],
  note: 'ghi chú',
  // Agent lỡ ghi cả v1 — screens[] thắng, hai field này bị dẫn xuất lại.
  cells: { 'od-cu': 'prd__cu' },
  names: { prd__cu: 'Cũ' },
};

test('parseScreenFlowScreensV2: v2 → doc khoan dung (bỏ entry/block/excluded thiếu field kèm warning), giữ title/source/note', () => {
  const r = parseScreenFlowScreensV2(V2_RAW);
  assert.ok('doc' in r, JSON.stringify(r));
  const { doc, warnings } = r as { doc: ScreensV2; warnings: string[] };
  assert.equal(doc.title, 'Luồng màn hình — Mua SIM');
  assert.equal(doc.source, 'docs-feature/prd.md');
  assert.equal(doc.note, 'ghi chú');
  assert.deepEqual(doc.screens.map((s) => s.key), ['prd__6.1.1', 'prd__6.4.1', 'prd__6.3.2', 'other__X']);
  assert.equal(doc.screens[0]!.why, 'Màn khởi đầu.');
  assert.deepEqual(doc.screens[1]!.blocks, [{ name: 'Mã voucher', anchorText: '#### 6.4.4. Mã voucher', why: 'Bottom-sheet trong màn.' }]);
  assert.equal(doc.screens[2]!.cell, null);
  assert.equal(doc.screens[3]!.code, null);
  assert.equal(doc.screens[3]!.source, 'docs-feature/other.md');
  assert.deepEqual(doc.excluded, [
    { name: '6. Khung giao diện sơ bộ', reason: 'Heading nhóm.' },
    { name: 'Phụ lục', reason: 'Bảng.', source: 'docs-feature/other.md', partOf: 'prd__6.1.1' },
  ]);
  assert.ok(warnings.some((w) => w.includes('thiếu key/name/anchorText')), warnings.join(' | '));
  assert.ok(warnings.some((w) => w.includes('không phải object')));
  assert.ok(warnings.some((w) => w.includes('block thiếu name/anchorText')));
  assert.ok(warnings.some((w) => w.includes('excluded[2] thiếu name/reason')));
  // v1 field không lọt vào doc.
  assert.ok(!('cells' in doc) && !('names' in doc));
});

test('parseScreenFlowScreensV2: v1 (cells+names, không screens) → { v1: true }; shape hỏng → errors', () => {
  assert.deepEqual(parseScreenFlowScreensV2({ cells: { 'od-a': 'p__1' }, names: { p__1: 'A' } }), { v1: true });
  assert.deepEqual(parseScreenFlowScreensV2({}), { v1: true });
  assert.ok('errors' in parseScreenFlowScreensV2(null));
  assert.ok('errors' in parseScreenFlowScreensV2([]));
  assert.ok('errors' in parseScreenFlowScreensV2({ screens: 'x' }));
  const empty = parseScreenFlowScreensV2({ screens: [{ name: 'thiếu key' }] });
  assert.ok('errors' in empty);
  assert.match((empty as { errors: string[] }).errors[0]!, /không có entry hợp lệ/);
});

test('deriveCellsAndNames: cells chỉ entry có cell, names MỌI entry; cell trùng → giữ đầu + entry sau null + warning; cell lạ (knownCells) → null', () => {
  const doc = (parseScreenFlowScreensV2(V2_RAW) as { doc: ScreensV2 }).doc;
  const d = deriveCellsAndNames(doc);
  assert.deepEqual(d.cells, { 'od-6-1-1': 'prd__6.1.1', 'od-6-4-1': 'prd__6.4.1' });
  assert.deepEqual(Object.keys(d.names).sort(), ['other__X', 'prd__6.1.1', 'prd__6.3.2', 'prd__6.4.1']);
  assert.equal(d.names['prd__6.3.2'], 'Chi tiết gói VN');
  assert.deepEqual(d.warnings, []);

  const dup: ScreensV2 = {
    screens: [
      { key: 'p__1', code: '1', name: 'A', anchorText: 'a', cell: 'od-x' },
      { key: 'p__2', code: '2', name: 'B', anchorText: 'b', cell: 'od-x' },
      { key: 'p__1', code: '1', name: 'A lặp', anchorText: 'a', cell: 'od-y' },
      { key: 'p__3', code: '3', name: 'C', anchorText: 'c', cell: 'od-ghost' },
    ],
    excluded: [],
  };
  const r = deriveCellsAndNames(dup, new Set(['od-x', 'od-y']));
  assert.deepEqual(r.cells, { 'od-x': 'p__1' });
  assert.deepEqual(r.screens.map((s) => [s.key, s.cell]), [['p__1', 'od-x'], ['p__2', null], ['p__3', null]]);
  assert.ok(r.warnings.some((w) => w.includes('cell "od-x"') && w.includes('p__2')), r.warnings.join(' | '));
  assert.ok(r.warnings.some((w) => w.includes('key "p__1" khai hai lần')));
  assert.ok(r.warnings.some((w) => w.includes('od-ghost') && w.includes('không có trong XML')));
});

test('toDiscoveredDoc: pages nhóm theo source (mặc định source cấp file), code null giữ null, blocks/why/excluded pass-through, excluded.source mặc định', () => {
  const doc = (parseScreenFlowScreensV2(V2_RAW) as { doc: ScreensV2 }).doc;
  const disc = toDiscoveredDoc(doc, { generatedAt: '2026-08-27T00:00:00.000Z' });
  assert.equal(disc.schema_version, 1);
  assert.equal(disc.generatedAt, '2026-08-27T00:00:00.000Z');
  assert.deepEqual(disc.pages.map((p) => p.source), ['docs-feature/prd.md', 'docs-feature/other.md']);
  assert.deepEqual(disc.pages[0]!.screens.map((s) => s.code), ['6.1.1', '6.4.1', '6.3.2']);
  // WP screen-flow-platform-split A0: `key` đi kèm (thẩm quyền duy nhất — persist
  // KHÔNG đánh lại X<n>); code null vẫn null.
  assert.deepEqual(disc.pages[1]!.screens, [{ key: 'other__X', code: null, name: 'Màn trang khác', anchorText: '## Màn trang khác' }]);
  assert.equal(disc.pages[0]!.screens[0]!.why, 'Màn khởi đầu.');
  assert.deepEqual(disc.pages[0]!.screens[1]!.blocks, [{ name: 'Mã voucher', anchorText: '#### 6.4.4. Mã voucher', why: 'Bottom-sheet trong màn.' }]);
  assert.equal('blocks' in disc.pages[0]!.screens[0]!, false);
  // `cell` là chuyện của luồng — không rò sang contract discovery; `key` thì
  // PHẢI có (A0). Tài liệu một nền tảng: không `platform`/`groupKey`.
  assert.equal('cell' in disc.pages[0]!.screens[0]!, false);
  assert.equal(disc.pages[0]!.screens[0]!.key, 'prd__6.1.1');
  assert.equal('platform' in disc.pages[0]!.screens[0]!, false);
  assert.equal('groupKey' in disc.pages[0]!.screens[0]!, false);
  assert.deepEqual(disc.excluded, [
    { name: '6. Khung giao diện sơ bộ', source: 'docs-feature/prd.md', reason: 'Heading nhóm.' },
    { name: 'Phụ lục', source: 'docs-feature/other.md', reason: 'Bảng.', partOf: 'prd__6.1.1' },
  ]);
});

test('renderDiscoveredMd: đủ 3 mục (Màn hình thật / Khối bổ sung / Mục tài liệu bị loại), lồng block dưới màn cha', () => {
  const doc = (parseScreenFlowScreensV2(V2_RAW) as { doc: ScreensV2 }).doc;
  const md = renderDiscoveredMd(toDiscoveredDoc(doc, { generatedAt: 'x' }), 'Mua SIM');
  assert.ok(md.startsWith('# Phát hiện màn hình — Mua SIM\n'));
  for (const h of ['## Màn hình thật', '## Khối bổ sung', '## Mục tài liệu bị loại']) assert.ok(md.includes(`\n${h}\n`), h);
  assert.ok(md.includes('1. `6.1.1` — Trang chủ'));
  assert.ok(md.includes('4. Màn trang khác'), 'code null → chỉ tên');
  assert.ok(md.includes('- `6.4.1` — Nhập thông tin\n  - Khối bổ sung: Mã voucher\n    - Lý do: Bottom-sheet trong màn.'));
  assert.ok(md.includes('- `6. Khung giao diện sơ bộ` — Heading nhóm.'));
  assert.ok(md.includes('- `Phụ lục` — Bảng. (thuộc: prd__6.1.1)'));
  // Không có block / excluded → vẫn đủ 3 mục.
  const bare = renderDiscoveredMd({ schema_version: 1, generatedAt: 'x', pages: [{ source: 's.md', screens: [{ code: null, name: 'A', anchorText: 'a' }] }], excluded: [] }, 'T');
  assert.ok(bare.includes('## Khối bổ sung\n\n_Không có._'));
  assert.ok(bare.includes('## Mục tài liệu bị loại\n\n_Không có._'));
  assert.ok(bare.endsWith('\n') && !bare.endsWith('\n\n'));
});
