// Lớp 2 (agent trích màn) — WP12. Fixture ở đây PHẢI bền với WP11 đang sửa
// scanDocScreens song song: `needsAgentScreenExtract` chỉ dựa vào việc
// scanDocScreens trả 0 màn hay không, không dựa vào một hệ mã cụ thể nào
// (S01, X1…) — nên trang "trigger" dùng heading tín hiệu + hoàn toàn không
// có heading dạng mã màn nào (không MH/SCR/mã mục), và trang "không-trigger"
// dùng heading "### MH1: Tên", khuôn MH tường minh mà mọi phiên bản
// scanDocScreens (cũ lẫn mới) đều nhận ra — xem docblock scanDocScreens
// (screen-components.ts) về LƯỢT 1 (mã tường minh) luôn thắng tuyệt đối.
import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { ScreenInput } from '../src/screen-components.js';
import { DOC_SCREENS_FILE, mergeExtractedScreens, needsAgentScreenExtract, validateDocScreenExtract } from '../src/screen-extract.js';

// ── fixtures cho needsAgentScreenExtract ────────────────────────────────────

// Tín hiệu "danh sách màn hình" có, KHÔNG một heading nào khác dạng mã màn
// (không số ở đầu bất kỳ heading nào) — scanDocScreens (mọi phiên bản) trả
// mảng rỗng chắc chắn, không phụ thuộc hệ mã X/S mà WP11 đang phát triển.
const TRIGGER_MD = [
  '# Trang tài liệu',
  '',
  '## Danh sách màn hình',
  '',
  'Người dùng di chuyển giữa các màn hình theo luồng nghiệp vụ, tài liệu mô tả',
  'bằng văn xuôi, không có bảng mã màn hay heading đánh số.',
  '',
  'Ứng dụng có nhiều bước thao tác khác nhau tuỳ theo ngữ cảnh sử dụng, được',
  'trình bày liên tục không tách theo mục.',
].join('\n');

// Có tín hiệu VÀ có heading mã màn tường minh MH1 — mọi phiên bản
// scanDocScreens đều nhận MH1 (LƯỢT 1, mã tường minh thắng tuyệt đối) nên
// needsAgentScreenExtract phải false vì lớp 1 đã đủ mạnh.
const TRIGGER_BUT_HAS_CODE_MD = [
  '# Trang tài liệu',
  '',
  '## Danh sách màn hình',
  '',
  '### MH1: Trang chủ',
  '',
  'Mô tả trang chủ.',
].join('\n');

const NO_SIGNAL_MD = ['# Trang tài liệu', '', '## Giới thiệu', '', 'Nội dung giới thiệu chung, không liệt kê màn hình nào ở đây.'].join('\n');

// Tín hiệu chỉ xuất hiện BÊN TRONG code fence — không tính là heading thật.
const FENCE_SIGNAL_MD = ['# Trang tài liệu', '', '```', '## Danh sách màn hình', '```', '', 'Nội dung không có màn hình liệt kê thật.'].join(
  '\n',
);

test('needsAgentScreenExtract: heading tín hiệu + scanDocScreens rỗng → true', () => {
  assert.equal(needsAgentScreenExtract(TRIGGER_MD), true);
});

test('needsAgentScreenExtract: có tín hiệu nhưng đã có mã màn tường minh (MH1) → false', () => {
  assert.equal(needsAgentScreenExtract(TRIGGER_BUT_HAS_CODE_MD), false);
});

test('needsAgentScreenExtract: không có heading tín hiệu nào → false', () => {
  assert.equal(needsAgentScreenExtract(NO_SIGNAL_MD), false);
});

test('needsAgentScreenExtract: tín hiệu nằm trong code fence → false', () => {
  assert.equal(needsAgentScreenExtract(FENCE_SIGNAL_MD), false);
});

// ── fixtures cho validateDocScreenExtract ───────────────────────────────────

const SOURCE = 'docs-feature/trang-mau.md';

// Số dòng (1-based) ghi rõ trong comment để đối chiếu assertion.
const EXTRACT_PAGE_MD = [
  '# Trang mẫu', // 1
  '', // 2
  '## 2.1. Danh sách màn hình', // 3
  '', // 4
  '| Mã MH | Tên màn hình |', // 5
  '|---|---|', // 6
  '| MH1 | Trang chủ |', // 7
  '| MH2 | Chi tiết sản phẩm |', // 8
  '', // 9
  '**Màn xác nhận thanh toán**', // 10
  '', // 11
  'Dòng lặp lại hai lần', // 12
  '', // 13
  'Dòng lặp lại hai lần', // 14
  '', // 15
  '```', // 16
  'Dòng chỉ có trong fence', // 17
  '```', // 18
  '', // 19
  '**Màn hoàn tất**', // 20
  '', // 21
  'Cuối trang.', // 22
].join('\n');

function mdMap(): Map<string, string> {
  return new Map([[SOURCE, EXTRACT_PAGE_MD]]);
}

test('validateDocScreenExtract: anchor đúng một dòng, duy nhất → accepted kèm line', () => {
  const doc = {
    schema_version: 1,
    pages: [{ source: SOURCE, screens: [{ code: 'S01', name: 'Trang chủ', anchorText: '| MH1 | Trang chủ |' }] }],
  };
  const { accepted, rejected } = validateDocScreenExtract(mdMap(), doc);
  assert.deepEqual(rejected, []);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]!.line, 7);
  assert.equal(accepted[0]!.code, 'S01');
  assert.equal(accepted[0]!.source, SOURCE);
});

test('validateDocScreenExtract: anchor không tồn tại trong trang → rejected "không tìm thấy"', () => {
  const doc = {
    schema_version: 1,
    pages: [{ source: SOURCE, screens: [{ code: 'S01', name: 'Màn ma', anchorText: 'Dòng không có thật trong trang' }] }],
  };
  const { accepted, rejected } = validateDocScreenExtract(mdMap(), doc);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.reason, /không tìm thấy/);
});

test('validateDocScreenExtract: anchor xuất hiện 2 lần → rejected "không duy nhất"', () => {
  const doc = {
    schema_version: 1,
    pages: [{ source: SOURCE, screens: [{ code: 'S01', name: 'Trùng dòng', anchorText: 'Dòng lặp lại hai lần' }] }],
  };
  const { accepted, rejected } = validateDocScreenExtract(mdMap(), doc);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.reason, /không duy nhất/);
});

test('validateDocScreenExtract: anchor chỉ tồn tại trong code fence → rejected', () => {
  const doc = {
    schema_version: 1,
    pages: [{ source: SOURCE, screens: [{ code: 'S01', name: 'Trong fence', anchorText: 'Dòng chỉ có trong fence' }] }],
  };
  const { accepted, rejected } = validateDocScreenExtract(mdMap(), doc);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
});

test('validateDocScreenExtract: name khớp blocklist mục tài liệu → rejected', () => {
  const doc = {
    schema_version: 1,
    pages: [{ source: SOURCE, screens: [{ code: 'S01', name: 'Danh sách màn hình', anchorText: '**Màn xác nhận thanh toán**' }] }],
  };
  const { accepted, rejected } = validateDocScreenExtract(mdMap(), doc);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
});

test('validateDocScreenExtract: name "Danh sách danh bạ" không khớp blocklist → accepted', () => {
  const doc = {
    schema_version: 1,
    pages: [{ source: SOURCE, screens: [{ code: 'S01', name: 'Danh sách danh bạ', anchorText: '| MH2 | Chi tiết sản phẩm |' }] }],
  };
  const { accepted, rejected } = validateDocScreenExtract(mdMap(), doc);
  assert.deepEqual(rejected, []);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]!.name, 'Danh sách danh bạ');
});

test('validateDocScreenExtract: code null → tự đánh X1/X2 theo thứ tự dòng anchor trong trang (không theo thứ tự JSON)', () => {
  const doc = {
    schema_version: 1,
    pages: [
      {
        source: SOURCE,
        screens: [
          // Cố tình liệt kê màn ở dòng SAU trước, màn ở dòng TRƯỚC sau — kết
          // quả phải đánh số theo DÒNG (10 trước 20), không theo thứ tự JSON.
          { code: null, name: 'Màn hoàn tất', anchorText: '**Màn hoàn tất**' },
          { code: null, name: 'Màn xác nhận thanh toán', anchorText: '**Màn xác nhận thanh toán**' },
        ],
      },
    ],
  };
  const { accepted, rejected } = validateDocScreenExtract(mdMap(), doc);
  assert.deepEqual(rejected, []);
  assert.equal(accepted.length, 2);
  const byLine = [...accepted].sort((a, b) => a.line - b.line);
  assert.equal(byLine[0]!.line, 10);
  assert.equal(byLine[0]!.code, 'X1');
  assert.equal(byLine[1]!.line, 20);
  assert.equal(byLine[1]!.code, 'X2');
});

test('validateDocScreenExtract: code trùng trong cùng trang → cái sau (thứ tự JSON) rejected', () => {
  const doc = {
    schema_version: 1,
    pages: [
      {
        source: SOURCE,
        screens: [
          { code: 'S01', name: 'Trang chủ', anchorText: '| MH1 | Trang chủ |' },
          { code: 'S01', name: 'Chi tiết sản phẩm', anchorText: '| MH2 | Chi tiết sản phẩm |' },
        ],
      },
    ],
  };
  const { accepted, rejected } = validateDocScreenExtract(mdMap(), doc);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]!.name, 'Trang chủ');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.name, 'Chi tiết sản phẩm');
});

test('validateDocScreenExtract: source lạ (không có trong mdBySource) → rejected', () => {
  const doc = {
    schema_version: 1,
    pages: [{ source: 'docs-feature/khong-ton-tai.md', screens: [{ code: 'S01', name: 'Màn X', anchorText: 'Bất kỳ' }] }],
  };
  const { accepted, rejected } = validateDocScreenExtract(mdMap(), doc);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
});

test('validateDocScreenExtract: schema_version lạ / shape hỏng toàn phần → accepted rỗng + rejected có reason, không throw', () => {
  const r1 = validateDocScreenExtract(mdMap(), { schema_version: 2, pages: [] });
  assert.deepEqual(r1.accepted, []);
  assert.equal(r1.rejected.length, 1);
  assert.ok(r1.rejected[0]!.reason.length > 0);

  const r2 = validateDocScreenExtract(mdMap(), 'không phải object');
  assert.deepEqual(r2.accepted, []);
  assert.equal(r2.rejected.length, 1);

  const r3 = validateDocScreenExtract(mdMap(), { schema_version: 1 }); // thiếu "pages"
  assert.deepEqual(r3.accepted, []);
  assert.equal(r3.rejected.length, 1);
});

test('validateDocScreenExtract: section = anchor tới anchor-hợp-lệ kế tiếp trừ 1, màn cuối chạy tới hết trang', () => {
  const doc = {
    schema_version: 1,
    pages: [
      {
        source: SOURCE,
        screens: [
          { code: 'S01', name: 'Trang chủ', anchorText: '| MH1 | Trang chủ |' }, // line 7
          { code: 'S02', name: 'Màn xác nhận thanh toán', anchorText: '**Màn xác nhận thanh toán**' }, // line 10
          { code: 'S03', name: 'Màn hoàn tất', anchorText: '**Màn hoàn tất**' }, // line 20
        ],
      },
    ],
  };
  const { accepted, rejected } = validateDocScreenExtract(mdMap(), doc);
  assert.deepEqual(rejected, []);
  const byCode = new Map(accepted.map((a) => [a.code, a]));
  assert.deepEqual(byCode.get('S01')!.section, { startLine: 7, endLine: 9 });
  assert.deepEqual(byCode.get('S02')!.section, { startLine: 10, endLine: 19 });
  assert.deepEqual(byCode.get('S03')!.section, { startLine: 20, endLine: 22 });
});

// ── mergeExtractedScreens ────────────────────────────────────────────────

function existingScreen(overrides: Partial<ScreenInput> = {}): ScreenInput {
  return {
    key: 'trang-mau__S01',
    name: 'Có sẵn từ lớp 1',
    order: 0,
    flowId: 'FLOW-a',
    flowTitle: 'Luồng A',
    source: SOURCE,
    steps: [],
    navOut: [],
    navIn: [],
    findings: [],
    platformHint: 'web',
    origin: 'flow',
    ...overrides,
  };
}

test('mergeExtractedScreens: khoá màn mới đúng "<stem(source)>__<code>"', () => {
  const existing = [existingScreen()];
  const accepted = [{ source: SOURCE, code: 'S02', name: 'Màn mới', line: 10 }];
  const { screens, added } = mergeExtractedScreens(existing, accepted, mdMap());
  const newOne = screens.find((s) => s.key === 'trang-mau__S02');
  assert.ok(newOne);
  assert.equal(newOne!.origin, 'agent');
  assert.deepEqual(added, ['trang-mau__S02']);
});

test('mergeExtractedScreens: trùng khoá với màn có sẵn → màn có sẵn thắng, không nhân đôi', () => {
  const existing = [existingScreen()]; // key = trang-mau__S01
  const accepted = [
    { source: SOURCE, code: 'S01', name: 'Bản agent trích (phải bị bỏ)', line: 7 },
    { source: SOURCE, code: 'S02', name: 'Màn mới', line: 10 },
  ];
  const { screens, added } = mergeExtractedScreens(existing, accepted, mdMap());
  assert.equal(screens.length, 2);
  const s01 = screens.find((s) => s.key === 'trang-mau__S01');
  assert.equal(s01!.name, 'Có sẵn từ lớp 1'); // không bị đè bởi bản agent
  assert.deepEqual(added, ['trang-mau__S02']);
});

test('mergeExtractedScreens: order của màn mới nối tiếp liên tục từ màn có sẵn', () => {
  const existing = [existingScreen({ order: 0 }), existingScreen({ key: 'trang-mau__S00', order: 1 })];
  const accepted = [
    { source: SOURCE, code: 'S02', name: 'Màn mới 1', line: 10 },
    { source: SOURCE, code: 'S03', name: 'Màn mới 2', line: 20 },
  ];
  const { screens } = mergeExtractedScreens(existing, accepted, mdMap());
  const s02 = screens.find((s) => s.key === 'trang-mau__S02')!;
  const s03 = screens.find((s) => s.key === 'trang-mau__S03')!;
  assert.equal(s02.order, 2);
  assert.equal(s03.order, 3);
});

test('DOC_SCREENS_FILE = "comp/_doc-screens.json"', () => {
  assert.equal(DOC_SCREENS_FILE, 'comp/_doc-screens.json');
});
