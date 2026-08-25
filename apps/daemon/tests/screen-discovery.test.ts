// WP1 (2026-08-25) — "Phát hiện màn hình" (dr-screens): file discovery
// `docs-review/screens-discovered.json` là nguồn có thẩm quyền cho danh sách
// màn-TÀI-LIỆU, thay cho quét regex `scanDocScreens` khi tồn tại + hợp lệ.
//
// Fixture PRD tự do bên dưới tái hiện đúng bug mô tả trong spec: heading
// nhiều cấp không mã ("2.1 Mua SIM" / "2.1.1 Voucher") khiến `scanDocScreens`
// (lượt 2 — mã mục nhiều cấp) coi "2.1.1 Voucher" — một khối CHI TIẾT nằm
// TRONG màn "Mua SIM" — là một màn RIÊNG (vì nó là "lá" trong cây mã mục),
// trong khi CHÍNH "2.1 Mua SIM" (màn thật) lại bị loại vì có "con" ("2.1.1")
// nên không được coi là lá. `screens-discovered.json` sửa đúng chỗ này: agent
// khai "Mua SIM" là màn thật, "Voucher" chỉ là một phần của nó (excluded).
import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  parseScreensDiscovered,
  resolveDocScreens,
  scanDocScreens,
  type DiscoveredDoc,
  type ScreenInput,
} from '../src/screen-components.js';
import { buildScreenComponentsKickoff, type ScreenComponentsKickoffOptions } from '../src/pipeline-kickoffs.js';

const SOURCE = 'docs-feature/Mua-SIM.md';

// Số dòng (1-based) ghi rõ trong comment để đối chiếu assertion.
const FIXTURE_MD = [
  '# Tài liệu', // 1
  '', // 2
  '## 2. Màn hình', // 3
  '', // 4
  '### 2.1 Mua SIM', // 5
  '', // 6
  'Mô tả tổng quan Mua SIM.', // 7
  '', // 8
  '#### 2.1.1 Voucher', // 9
  '', // 10
  'Khối nhập mã giảm giá bên trong màn Mua SIM.', // 11
  '', // 12
  '### 2.2 Chọn gói cước', // 13
  '', // 14
  'Mô tả màn chọn gói cước.', // 15
].join('\n');

function mdMap(): Map<string, string> {
  return new Map([[SOURCE, FIXTURE_MD]]);
}

const PAGES = [{ mdPath: SOURCE, page: 'Mua SIM' }];

// ── scanDocScreens (đối chứng — chứng minh bug có thật trên fixture này) ────

test('scanDocScreens (đối chứng): "2.1.1 Voucher" bị nâng thành màn RIÊNG, "2.1 Mua SIM" (màn thật) bị loại vì có "con" — đúng bug mô tả trong spec', () => {
  const found = scanDocScreens(FIXTURE_MD);
  const codes = found.map((f) => f.code);
  assert.ok(codes.includes('2.1.1'), `expected 2.1.1 in ${JSON.stringify(codes)}`);
  assert.ok(!codes.includes('2.1'), `expected 2.1 to be rejected, got ${JSON.stringify(codes)}`);
});

// ── parseScreensDiscovered ───────────────────────────────────────────────

test('parseScreensDiscovered: JSON hợp lệ → object đúng shape', () => {
  const raw = JSON.stringify({
    schema_version: 1,
    generatedAt: '2026-08-25T00:00:00.000Z',
    pages: [{ source: SOURCE, screens: [{ code: null, name: 'Mua SIM', anchorText: '### 2.1 Mua SIM' }] }],
    excluded: [{ name: 'Voucher', source: SOURCE, reason: 'chi tiết trong màn Mua SIM', partOf: 'Mua SIM' }],
  });
  const doc = parseScreensDiscovered(raw);
  assert.ok(doc);
  assert.equal(doc!.schema_version, 1);
  assert.equal(doc!.pages.length, 1);
  assert.equal(doc!.pages[0]!.source, SOURCE);
  assert.equal(doc!.pages[0]!.screens[0]!.name, 'Mua SIM');
  assert.equal(doc!.pages[0]!.screens[0]!.code, null);
  assert.equal(doc!.excluded.length, 1);
  assert.equal(doc!.excluded[0]!.partOf, 'Mua SIM');
});

test('parseScreensDiscovered: JSON hỏng (không parse được) → null', () => {
  assert.equal(parseScreensDiscovered('{ không phải json'), null);
});

test('parseScreensDiscovered: không phải object / mảng → null', () => {
  assert.equal(parseScreensDiscovered('"một chuỗi"'), null);
  assert.equal(parseScreensDiscovered('[1,2,3]'), null);
});

test('parseScreensDiscovered: thiếu "schema_version" hoặc sai giá trị → null', () => {
  assert.equal(parseScreensDiscovered(JSON.stringify({ pages: [] })), null);
  assert.equal(parseScreensDiscovered(JSON.stringify({ schema_version: 2, pages: [] })), null);
});

test('parseScreensDiscovered: thiếu "pages" (không phải mảng) → null', () => {
  assert.equal(parseScreensDiscovered(JSON.stringify({ schema_version: 1 })), null);
  assert.equal(parseScreensDiscovered(JSON.stringify({ schema_version: 1, pages: 'không phải mảng' })), null);
});

test('parseScreensDiscovered: thiếu "excluded" → mặc định mảng rỗng, không null (chỉ pages là bắt buộc)', () => {
  const doc = parseScreensDiscovered(JSON.stringify({ schema_version: 1, pages: [] }));
  assert.ok(doc);
  assert.deepEqual(doc!.excluded, []);
});

test('parseScreensDiscovered: phần tử lạ/hỏng bên trong pages[].screens[] hay excluded[] bị bỏ qua âm thầm, không làm hỏng cả tài liệu', () => {
  const doc = parseScreensDiscovered(
    JSON.stringify({
      schema_version: 1,
      pages: [
        {
          source: SOURCE,
          screens: [
            { code: null, name: 'Mua SIM', anchorText: '### 2.1 Mua SIM' },
            { code: null, name: '', anchorText: 'thiếu tên' }, // name rỗng — bỏ
            { anchorText: 'thiếu name key' }, // thiếu name — bỏ
            'không phải object', // bỏ
          ],
        },
        { source: '', screens: [] }, // source rỗng — cả trang bị bỏ
        'không phải object', // bỏ
      ],
      excluded: [
        { name: 'Voucher', source: SOURCE, reason: 'chi tiết' },
        { name: 'Thiếu reason', source: SOURCE }, // thiếu reason — bỏ
      ],
    }),
  );
  assert.ok(doc);
  assert.equal(doc!.pages.length, 1);
  assert.equal(doc!.pages[0]!.screens.length, 1);
  assert.equal(doc!.pages[0]!.screens[0]!.name, 'Mua SIM');
  assert.equal(doc!.excluded.length, 1);
  assert.equal(doc!.excluded[0]!.name, 'Voucher');
});

// ── parseScreensDiscovered: screens[].blocks[] (WP nested-blocks-A) ────────

test('parseScreensDiscovered: screens[].blocks[] — giữ hợp lệ, drop phần tử thiếu anchorText/name hay không phải object, blocks toàn rỗng → không set field', () => {
  const doc = parseScreensDiscovered(
    JSON.stringify({
      schema_version: 1,
      pages: [
        {
          source: SOURCE,
          screens: [
            {
              code: null,
              name: 'Mua SIM',
              anchorText: '### 2.1 Mua SIM',
              blocks: [
                { name: 'Voucher', anchorText: '### Voucher', why: 'chi tiết trong màn Mua SIM' },
                { name: '', anchorText: 'thiếu tên' }, // name rỗng — bỏ
                { anchorText: 'thiếu name key' }, // thiếu name — bỏ
                { name: 'Thiếu anchorText' }, // thiếu anchorText — bỏ
                'không phải object', // bỏ
              ],
            },
            {
              code: '2.2',
              name: 'Chọn gói cước',
              anchorText: '### 2.2 Chọn gói cước',
              blocks: [{ name: 'x', anchorText: '' }], // anchorText rỗng — phần tử duy nhất bị bỏ → field vắng
            },
          ],
        },
      ],
    }),
  );
  assert.ok(doc);
  const screens = doc!.pages[0]!.screens;
  const muaSim = screens.find((s) => s.name === 'Mua SIM')!;
  assert.equal(muaSim.blocks?.length, 1, `expected 1 valid block, got ${JSON.stringify(muaSim.blocks)}`);
  assert.equal(muaSim.blocks?.[0]!.name, 'Voucher');
  assert.equal(muaSim.blocks?.[0]!.anchorText, '### Voucher');
  assert.equal(muaSim.blocks?.[0]!.why, 'chi tiết trong màn Mua SIM');
  const chonGoi = screens.find((s) => s.name === 'Chọn gói cước')!;
  assert.equal(chonGoi.blocks, undefined, 'blocks rỗng sau khi lọc → field KHÔNG được set (không phải mảng rỗng)');
});

test('parseScreensDiscovered: file KHÔNG có blocks → screen.blocks undefined (tương thích ngược tuyệt đối)', () => {
  const doc = parseScreensDiscovered(
    JSON.stringify({
      schema_version: 1,
      pages: [{ source: SOURCE, screens: [{ code: null, name: 'Mua SIM', anchorText: '### 2.1 Mua SIM' }] }],
    }),
  );
  assert.ok(doc);
  assert.equal(doc!.pages[0]!.screens[0]!.blocks, undefined);
});

// ── resolveDocScreens ────────────────────────────────────────────────────

function discovery(overrides: Partial<DiscoveredDoc> = {}): DiscoveredDoc {
  return {
    schema_version: 1,
    generatedAt: '2026-08-25T00:00:00.000Z',
    pages: [
      {
        source: SOURCE,
        screens: [
          { code: null, name: 'Mua SIM', anchorText: '### 2.1 Mua SIM' },
          { code: '2.2', name: 'Chọn gói cước', anchorText: '### 2.2 Chọn gói cước' },
        ],
      },
    ],
    excluded: [{ name: 'Voucher', source: SOURCE, reason: 'chi tiết trong màn Mua SIM', partOf: 'Mua SIM' }],
    ...overrides,
  };
}

test('resolveDocScreens: CÓ discovered hợp lệ → màn lấy TỪ discovered ("Mua SIM"), KHÔNG chạy scanDocScreens ("Voucher" không xuất hiện dù regex cũ sẽ nhận nó)', () => {
  const out = resolveDocScreens({ pages: PAGES, mdBySource: mdMap(), discovered: discovery(), existingKeys: new Set() });
  const names = out.map((s) => s.name);
  assert.ok(names.includes('Mua SIM'), `expected "Mua SIM" in ${JSON.stringify(names)}`);
  assert.ok(names.includes('Chọn gói cước'));
  assert.ok(!names.includes('Voucher'), `"Voucher" phải bị loại (excluded), got ${JSON.stringify(names)}`);
  assert.equal(out.length, 2);
});

test('resolveDocScreens: KHÔNG có discovered (null) → lùi về đúng hành vi regex cũ ("Voucher" LÀ màn, "Mua SIM" bị loại — cùng kết quả scanDocScreens)', () => {
  const out = resolveDocScreens({ pages: PAGES, mdBySource: mdMap(), discovered: null, existingKeys: new Set() });
  const names = out.map((s) => s.name);
  assert.ok(names.includes('Voucher'), `expected "Voucher" (regex cũ) in ${JSON.stringify(names)}`);
  assert.ok(!names.includes('Mua SIM'), `"Mua SIM" phải KHÔNG có ở nhánh regex cũ, got ${JSON.stringify(names)}`);
  assert.ok(names.includes('Chọn gói cước'));
  assert.ok(out.every((s) => s.origin === 'doc'));
});

test('resolveDocScreens: entry "excluded" KHÔNG BAO GIỜ thành ScreenInput, kể cả khi trùng anchorText/awkward với một screens[] khác trên cùng trang', () => {
  const disc = discovery({
    pages: [
      {
        source: SOURCE,
        screens: [
          { code: null, name: 'Mua SIM', anchorText: '### 2.1 Mua SIM' },
          // Cố tình khai "Voucher" là màn nhưng NÓ CŨNG nằm trong excluded[] —
          // excluded phải thắng (an toàn kép, xem docblock resolveDocScreens).
          { code: null, name: 'Voucher', anchorText: '#### 2.1.1 Voucher' },
        ],
      },
    ],
  });
  const out = resolveDocScreens({ pages: PAGES, mdBySource: mdMap(), discovered: disc, existingKeys: new Set() });
  assert.ok(!out.some((s) => s.name === 'Voucher'));
});

test('resolveDocScreens: dedupe với flow-origin theo key — khoá đã có trong existingKeys thì KHÔNG lặp lại', () => {
  // Mô phỏng "Chọn gói cước" đã được flow gắn trước (key theo đúng contract
  // "<file-stem>__<code>": Mua-SIM__2.2).
  const out = resolveDocScreens({
    pages: PAGES,
    mdBySource: mdMap(),
    discovered: discovery(),
    existingKeys: new Set(['Mua-SIM__2.2']),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, 'Mua SIM');
  assert.ok(!out.some((s) => s.key === 'Mua-SIM__2.2'));
});

test('resolveDocScreens: code null → tự đánh X1/X2 theo thứ tự DÒNG anchor trong trang, không theo thứ tự JSON', () => {
  const disc: DiscoveredDoc = {
    schema_version: 1,
    generatedAt: '2026-08-25T00:00:00.000Z',
    pages: [
      {
        source: SOURCE,
        screens: [
          // Cố tình liệt kê màn ở dòng SAU trước — kết quả phải đánh số theo
          // DÒNG (5 trước 13), không theo thứ tự JSON.
          { code: null, name: 'Chọn gói cước', anchorText: '### 2.2 Chọn gói cước' },
          { code: null, name: 'Mua SIM', anchorText: '### 2.1 Mua SIM' },
        ],
      },
    ],
    excluded: [],
  };
  const out = resolveDocScreens({ pages: PAGES, mdBySource: mdMap(), discovered: disc, existingKeys: new Set() });
  const byName = new Map(out.map((s) => [s.name, s]));
  assert.equal(byName.get('Mua SIM')!.key, 'Mua-SIM__X1');
  assert.equal(byName.get('Chọn gói cước')!.key, 'Mua-SIM__X2');
});

test('resolveDocScreens: anchorText không tìm thấy hoặc không duy nhất trong trang → bỏ qua màn đó (khoan dung, không throw)', () => {
  const disc = discovery({
    pages: [
      {
        source: SOURCE,
        screens: [
          { code: null, name: 'Mua SIM', anchorText: '### 2.1 Mua SIM' },
          { code: 'GHOST', name: 'Màn ma', anchorText: 'Dòng không có thật trong trang' },
        ],
      },
    ],
  });
  const out = resolveDocScreens({ pages: PAGES, mdBySource: mdMap(), discovered: disc, existingKeys: new Set() });
  assert.ok(!out.some((s) => s.name === 'Màn ma'));
  assert.ok(out.some((s) => s.name === 'Mua SIM'));
});

test('resolveDocScreens: màn có mã thật ("2.2") lấy section theo CẤP HEADING (findScreenSection); màn mã tự đánh (X1) lấy section theo ranh giới anchor kế tiếp', () => {
  const out = resolveDocScreens({ pages: PAGES, mdBySource: mdMap(), discovered: discovery(), existingKeys: new Set() });
  const muaSim = out.find((s) => s.name === 'Mua SIM')!;
  const chonGoi = out.find((s) => s.name === 'Chọn gói cước')!;
  assert.equal(muaSim.section?.startLine, 5);
  assert.equal(muaSim.section?.heading, '### 2.1 Mua SIM');
  // Ranh giới anchor-based: chạy tới trước anchor kế tiếp (dòng 13) → endLine 12.
  assert.equal(muaSim.section?.endLine, 12);
  assert.equal(chonGoi.section?.heading, '### 2.2 Chọn gói cước');
  assert.equal(chonGoi.section?.startLine, 13);
});

test('resolveDocScreens: ScreenInput trả về có origin "agent" (nhánh discovered) và "doc" (nhánh regex cũ)', () => {
  const withDisc = resolveDocScreens({ pages: PAGES, mdBySource: mdMap(), discovered: discovery(), existingKeys: new Set() });
  assert.ok(withDisc.every((s: ScreenInput) => s.origin === 'agent'));
  const withoutDisc = resolveDocScreens({ pages: PAGES, mdBySource: mdMap(), discovered: null, existingKeys: new Set() });
  assert.ok(withoutDisc.every((s: ScreenInput) => s.origin === 'doc'));
});

// ── resolveDocScreens: screens[].blocks[] → ScreenInput.blocks (WP nested-blocks-A) ─
//
// "Voucher" đặt RỜI ở "Phụ lục" cuối tài liệu — non-contiguous, ngoài section
// (dòng 5-8) của màn cha "Mua SIM" — tái hiện đúng ca BA đặt sai chỗ trong
// spec: block phải định vị THUẦN bằng anchorText, không phụ thuộc vào có nằm
// trong section màn cha hay không.
const BLOCKS_MD = [
  '# Tài liệu', // 1
  '', // 2
  '## 2. Màn hình', // 3
  '', // 4
  '### 2.1 Mua SIM', // 5
  '', // 6
  'Mô tả tổng quan Mua SIM.', // 7
  '', // 8
  '### 2.2 Chọn gói cước', // 9
  '', // 10
  'Mô tả màn chọn gói cước.', // 11
  '', // 12
  '## Phụ lục', // 13
  '', // 14
  '### Voucher', // 15
  '', // 16
  'Khối nhập mã giảm giá bên trong màn Mua SIM, đặt RỜI ở phụ lục cuối tài liệu.', // 17
].join('\n');

function blocksMdMap(): Map<string, string> {
  return new Map([[SOURCE, BLOCKS_MD]]);
}

test('resolveDocScreens: Ca "Voucher" — màn có block với anchorText khớp-duy-nhất ĐẶT RỜI (non-contiguous, ngoài section cha) → ScreenInput.blocks có đúng 1 entry với section trỏ đúng khoảng dòng của block; block KHÔNG tạo ScreenInput riêng và KHÔNG chiếm mã X', () => {
  const disc: DiscoveredDoc = {
    schema_version: 1,
    generatedAt: '2026-08-25T00:00:00.000Z',
    pages: [
      {
        source: SOURCE,
        screens: [
          { code: null, name: 'Mua SIM', anchorText: '### 2.1 Mua SIM', blocks: [{ name: 'Voucher', anchorText: '### Voucher' }] },
          { code: null, name: 'Chọn gói cước', anchorText: '### 2.2 Chọn gói cước' },
        ],
      },
    ],
    excluded: [],
  };
  const out = resolveDocScreens({ pages: PAGES, mdBySource: blocksMdMap(), discovered: disc, existingKeys: new Set() });

  // 1 màn cha + 1 màn thường — KHÔNG có màn "Voucher" riêng.
  assert.equal(out.length, 2, `expected 2 screens (Mua SIM, Chọn gói cước), got ${JSON.stringify(out.map((s) => s.name))}`);
  assert.ok(!out.some((s) => s.name === 'Voucher'), '"Voucher" không được là ScreenInput riêng');

  const muaSim = out.find((s) => s.name === 'Mua SIM')!;
  assert.equal(muaSim.key, 'Mua-SIM__X1');
  assert.equal(muaSim.blocks?.length, 1);
  assert.equal(muaSim.blocks?.[0]!.name, 'Voucher');
  assert.equal(muaSim.blocks?.[0]!.section.heading, '### Voucher');
  assert.equal(muaSim.blocks?.[0]!.section.startLine, 15);
  // Hết trang (không còn anchor nào sau dòng 15 trong tập-anchor-gộp) → endLine = pageLineCount (17).
  assert.equal(muaSim.blocks?.[0]!.section.endLine, 17);

  const chonGoi = out.find((s) => s.name === 'Chọn gói cước')!;
  // Block "Voucher" KHÔNG chiếm mã X — "Chọn gói cước" vẫn là X2 (thứ tự dòng: Mua SIM dòng 5 → X1, Chọn gói cước dòng 9 → X2).
  assert.equal(chonGoi.key, 'Mua-SIM__X2');
  assert.equal(chonGoi.blocks, undefined);
});

test('resolveDocScreens: block anchorText khớp 0 lần (không tìm thấy) → bỏ qua, không vào blocks (field vắng)', () => {
  const disc: DiscoveredDoc = {
    schema_version: 1,
    generatedAt: '2026-08-25T00:00:00.000Z',
    pages: [
      {
        source: SOURCE,
        screens: [{ code: null, name: 'Mua SIM', anchorText: '### 2.1 Mua SIM', blocks: [{ name: 'Ma', anchorText: 'Dòng không có thật' }] }],
      },
    ],
    excluded: [],
  };
  const out = resolveDocScreens({ pages: PAGES, mdBySource: blocksMdMap(), discovered: disc, existingKeys: new Set() });
  assert.equal(out.find((s) => s.name === 'Mua SIM')!.blocks, undefined);
});

test('resolveDocScreens: block anchorText khớp ≥2 lần (không duy nhất) → bỏ qua, không vào blocks (field vắng)', () => {
  const DUP_MD = `${BLOCKS_MD}\n\n### Voucher\n`; // "### Voucher" xuất hiện 2 lần trong trang → không duy nhất.
  const disc: DiscoveredDoc = {
    schema_version: 1,
    generatedAt: '2026-08-25T00:00:00.000Z',
    pages: [
      {
        source: SOURCE,
        screens: [{ code: null, name: 'Mua SIM', anchorText: '### 2.1 Mua SIM', blocks: [{ name: 'Voucher', anchorText: '### Voucher' }] }],
      },
    ],
    excluded: [],
  };
  const out = resolveDocScreens({ pages: PAGES, mdBySource: new Map([[SOURCE, DUP_MD]]), discovered: disc, existingKeys: new Set() });
  assert.equal(out.find((s) => s.name === 'Mua SIM')!.blocks, undefined);
});

// ── buildScreenComponentsKickoff (SCREEN mode): blockLine (WP nested-blocks-A) ─

function baseScreenKickoffOpts(): Extract<ScreenComponentsKickoffOptions, { mode: 'screen' }> {
  return {
    mode: 'screen',
    projectId: 'demo',
    screenKey: 'Mua-SIM__X1',
    screenName: 'Mua SIM',
    flowTitle: 'Mua SIM',
    order: 1,
    total: 2,
    flowLine: 'Luồng "Mua SIM" có 2 màn.',
    dsLine: 'DS: criteria/components.md có 12 component.',
    roleMapFile: 'comp/_role-map.json',
    roleMapPlatform: 'mobile',
    sectionLine: 'Mục tài liệu mô tả màn: dòng 5-8.',
    navLine: 'Lối đi: "Tiếp tục" → Chọn gói cước.',
    mockupLine: 'Không có ảnh mockup cho màn này.',
    outRel: 'comp/Mua-SIM__X1.screen.json',
    wfRel: 'wireframes/Mua-SIM__X1.html',
    cssLine: 'dán CSS chung, ',
    wireframeCssRel: 'wireframes/_wireframe.css',
  };
}

test('buildScreenComponentsKickoff (SCREEN): không có blockLine → kickoff byte-identical với kickoff không biết field này (không thêm dòng nào)', () => {
  const opts = baseScreenKickoffOpts();
  const withoutField = buildScreenComponentsKickoff(opts);
  const withUndefinedBlockLine = buildScreenComponentsKickoff({ ...opts, blockLine: undefined });
  const withBlankBlockLine = buildScreenComponentsKickoff({ ...opts, blockLine: '   ' });
  assert.equal(withUndefinedBlockLine, withoutField);
  assert.equal(withBlankBlockLine, withoutField, 'blockLine chỉ khoảng trắng → coi như rỗng, không thêm dòng');
  assert.ok(!withoutField.includes('Khối bổ sung'));
});

test('buildScreenComponentsKickoff (SCREEN): có blockLine → thêm ĐÚNG 1 bullet, ngay sau bullet sectionLine và trước navLine', () => {
  const opts = { ...baseScreenKickoffOpts(), blockLine: 'Khối bổ sung: Voucher — daemon liệt kê dòng 15-17.' };
  const out = buildScreenComponentsKickoff(opts);
  const lines = out.split('\n');
  const sectionIdx = lines.indexOf(`- ${opts.sectionLine.trim()}`);
  assert.ok(sectionIdx >= 0, 'expected sectionLine bullet present');
  assert.equal(lines[sectionIdx + 1], `- ${opts.blockLine.trim()}`);
  assert.equal(lines[sectionIdx + 2], `- ${opts.navLine.trim()}`);
  const occurrences = out.split(opts.blockLine.trim()).length - 1;
  assert.equal(occurrences, 1, 'blockLine chỉ xuất hiện đúng 1 lần');
});
