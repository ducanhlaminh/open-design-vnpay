// Lớp 3 (overrides của người dùng) — phần daemon thuần: parse
// docs-review/screens-overrides.json, áp lên danh sách màn, dựng
// comp/_screens.json. RED SPEC theo .tmp/pipeline/wp13a.yaml.
//
// SONG SONG HOÁ: WP11 đang sửa screen-components.ts + tests/screen-components.test.ts
// cùng lúc — không gọi scanDocScreens / prepareScreenComponentInputs (hành vi
// của file đó); fixture ScreenInput dựng TAY, độc lập.

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import type { ScreenInput } from '../src/screen-components.js';
import {
  SCREENS_MANIFEST_FILE,
  SCREENS_OVERRIDES_REL,
  parseScreensOverrides,
  applyScreenOverrides,
  buildScreensManifest,
} from '../src/screen-overrides.js';
import type { ScreensOverrides } from '@open-design/contracts';

// Trang markdown dùng cho các test anchor — cố tình có một fence (đoạn code
// mẫu) chứa dòng TRÙNG với một dòng nội dung thật bên ngoài fence, để chứng
// minh luật "ngoài fence" loại đúng ứng viên trong fence.
const MD = [
  '# PRD Mua SIM',
  '',
  '### SCR-001 Chọn quốc gia',
  '',
  'Nội dung máy đoán cho SCR-001.',
  '',
  '### SCR-003 Xác nhận thanh toán',
  '',
  'Người dùng xem lại đơn hàng và bấm Thanh toán.',
  '',
  'Sau khi thanh toán, hệ thống chuyển sang màn kết quả.',
  '',
  '```',
  'Người dùng xem lại đơn hàng và bấm Thanh toán.',
  '```',
].join('\n');
const MD_LINES = MD.split('\n');

// Trang riêng cho test "trùng lặp ngoài fence" — anchor xuất hiện hai lần ở
// nội dung thật (không phải trong fence) nên KHÔNG duy nhất.
const MD_DUP = [
  '# Trang trùng',
  '',
  'Xác nhận và tiếp tục.',
  '',
  'Xác nhận và tiếp tục.',
].join('\n');

function baseScreens(): ScreenInput[] {
  return [
    {
      key: 'prd__SCR-001',
      name: 'Chọn quốc gia',
      order: 0,
      flowId: 'flow-1',
      flowTitle: 'Mua SIM',
      source: 'docs/prd.md',
      steps: [],
      navOut: [{ to: 'prd__SCR-002', via: 'Tiếp tục' }],
      navIn: [],
      findings: [],
      platformHint: 'web',
      origin: 'flow',
      section: { heading: '### SCR-001 Chọn quốc gia', startLine: 3, endLine: 5, excerpt: 'Nội dung máy đoán cho SCR-001.' },
    },
    {
      key: 'prd__SCR-002',
      name: 'Chọn gói cước',
      order: 1,
      flowId: 'flow-1',
      flowTitle: 'Mua SIM',
      source: 'docs/prd.md',
      steps: [],
      // navOut trỏ tới SCR-001: dùng để chứng minh navOut GIỮ NGUYÊN sau khi
      // SCR-001 bị remove (SCREEN-mode kickoff chịu được key vắng).
      navOut: [{ to: 'prd__SCR-001', via: 'Quay lại' }],
      navIn: ['prd__SCR-001'],
      findings: [],
      platformHint: 'web',
      origin: 'flow',
    },
  ];
}

describe('SCREENS_MANIFEST_FILE / SCREENS_OVERRIDES_REL', () => {
  test('manifest nằm dưới comp/, overrides nằm ngoài comp/', () => {
    // comp/ bị "Run lại" dọn sạch mỗi lần chạy (đúng ý cho manifest — nó mô
    // tả lần chạy này); screens-overrides.json phải sống sót re-run clear vì
    // nó là nguồn sự thật của người dùng (WP14 sẽ có test tích hợp chứng
    // minh — ở đây chỉ khẳng định đường dẫn).
    assert.equal(SCREENS_MANIFEST_FILE, 'comp/_screens.json');
    assert.equal(SCREENS_OVERRIDES_REL, 'screens-overrides.json');
  });
});

describe('parseScreensOverrides', () => {
  test('JSON hỏng → doc rỗng + warning', () => {
    const { doc, warnings } = parseScreensOverrides('{not json');
    assert.deepEqual(doc, { schema_version: 1, overrides: [] });
    assert.equal(warnings.length, 1);
  });

  test('schema_version lạ → doc rỗng + warning', () => {
    const raw = JSON.stringify({ schema_version: 2, overrides: [] });
    const { doc, warnings } = parseScreensOverrides(raw);
    assert.deepEqual(doc, { schema_version: 1, overrides: [] });
    assert.equal(warnings.length, 1);
  });

  test('entry action lạ → bỏ entry đó + warning, entry khác vẫn ăn', () => {
    const raw = JSON.stringify({
      schema_version: 1,
      overrides: [{ action: 'bogus' }, { action: 'rename', key: 'k', name: 'n' }],
    });
    const { doc, warnings } = parseScreensOverrides(raw);
    assert.deepEqual(doc.overrides, [{ action: 'rename', key: 'k', name: 'n' }]);
    assert.equal(warnings.length, 1);
  });

  test('entry thiếu field → bỏ entry đó + warning, entry khác vẫn ăn', () => {
    const raw = JSON.stringify({
      schema_version: 1,
      overrides: [{ action: 'add', source: 'docs/prd.md' }, { action: 'remove', key: 'prd__SCR-001' }],
    });
    const { doc, warnings } = parseScreensOverrides(raw);
    assert.deepEqual(doc.overrides, [{ action: 'remove', key: 'prd__SCR-001' }]);
    assert.equal(warnings.length, 1);
  });

  test('file chuẩn → không warning', () => {
    const valid: ScreensOverrides = {
      schema_version: 1,
      overrides: [
        { action: 'add', source: 'docs/prd.md', code: 'SCR-003', name: 'Xác nhận thanh toán', anchorText: 'x' },
        { action: 'rename', key: 'prd__SCR-002', name: 'Chọn gói cước (mới)' },
        { action: 'remove', key: 'prd__SCR-001' },
      ],
    };
    const { doc, warnings } = parseScreensOverrides(JSON.stringify(valid));
    assert.deepEqual(doc, valid);
    assert.deepEqual(warnings, []);
  });
});

describe('applyScreenOverrides', () => {
  test('add không anchor → màn origin user không section', () => {
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'add', source: 'docs/prd.md', code: 'SCR-003', name: 'Xác nhận thanh toán' }],
    };
    const { screens, warnings } = applyScreenOverrides(baseScreens(), overrides, new Map([['docs/prd.md', MD]]));
    const added = screens.find((s) => s.key === 'prd__SCR-003');
    assert.ok(added, 'màn mới phải được thêm');
    assert.equal(added!.origin, 'user');
    assert.equal(added!.section, undefined);
    assert.deepEqual(warnings, []);
  });

  test('add anchor đúng → line/section đúng', () => {
    const anchorText = 'Người dùng xem lại đơn hàng và bấm Thanh toán.';
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'add', source: 'docs/prd.md', code: 'SCR-003', name: 'Xác nhận thanh toán', anchorText }],
    };
    const { screens, warnings } = applyScreenOverrides(baseScreens(), overrides, new Map([['docs/prd.md', MD]]));
    const added = screens.find((s) => s.key === 'prd__SCR-003');
    assert.ok(added);
    // Dòng anchor ngoài fence (1-based) — dòng thứ 9 trong MD.
    const expectedLine = MD_LINES.findIndex((l) => l === anchorText) + 1;
    assert.equal(expectedLine, 9);
    assert.ok(added!.section, 'phải có section khi anchor hợp lệ');
    assert.equal(added!.section!.startLine, expectedLine);
    assert.equal(added!.section!.endLine, MD_LINES.length);
    assert.deepEqual(warnings, []);
  });

  test('add anchor hỏng (không tìm thấy) → vẫn thêm + warning', () => {
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'add', source: 'docs/prd.md', code: 'SCR-003', name: 'Xác nhận thanh toán', anchorText: 'Dòng không tồn tại trong tài liệu' }],
    };
    const { screens, warnings } = applyScreenOverrides(baseScreens(), overrides, new Map([['docs/prd.md', MD]]));
    const added = screens.find((s) => s.key === 'prd__SCR-003');
    assert.ok(added);
    assert.equal(added!.section, undefined);
    assert.equal(warnings.length, 1);
  });

  test('add anchor trùng lặp ngoài fence (không duy nhất) → vẫn thêm + warning', () => {
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'add', source: 'docs/dup.md', code: 'SCR-009', name: 'Trùng', anchorText: 'Xác nhận và tiếp tục.' }],
    };
    const { screens, warnings } = applyScreenOverrides(baseScreens(), overrides, new Map([['docs/dup.md', MD_DUP]]));
    const added = screens.find((s) => s.key === 'dup__SCR-009');
    assert.ok(added);
    assert.equal(added!.section, undefined);
    assert.equal(warnings.length, 1);
  });

  test('add anchor chỉ khớp bên TRONG fence → coi như không tìm thấy, vẫn thêm + warning', () => {
    // MD có anchorText xuất hiện đúng 1 lần NGOÀI fence và 1 lần TRONG fence
    // (dòng 14). Đặt anchor trùng CHỈ với dòng trong fence bằng cách xoá bản
    // ngoài fence khỏi một trang riêng — dùng MD gốc, anchor "Người dùng xem
    // lại đơn hàng và bấm Thanh toán." đã test ở case hợp lệ (khớp ngoài
    // fence, bỏ qua bản trong fence) — ở đây kiểm NGƯỢC LẠI bằng đoạn chỉ có
    // fence.
    const mdFenceOnly = ['# Trang', '', '```', 'Chỉ có trong fence.', '```'].join('\n');
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'add', source: 'docs/fence.md', code: 'SCR-010', name: 'Trong fence', anchorText: 'Chỉ có trong fence.' }],
    };
    const { screens, warnings } = applyScreenOverrides(baseScreens(), overrides, new Map([['docs/fence.md', mdFenceOnly]]));
    const added = screens.find((s) => s.key === 'fence__SCR-010');
    assert.ok(added);
    assert.equal(added!.section, undefined);
    assert.equal(warnings.length, 1);
  });

  test('add trùng key màn máy (không anchor) → user thắng tên/origin, GIỮ section máy', () => {
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'add', source: 'docs/prd.md', code: 'SCR-001', name: 'Chọn quốc gia (user sửa)' }],
    };
    const before = baseScreens();
    const machineSection = before[0]!.section;
    const { screens, warnings } = applyScreenOverrides(before, overrides, new Map([['docs/prd.md', MD]]));
    const merged = screens.find((s) => s.key === 'prd__SCR-001');
    assert.ok(merged);
    assert.equal(merged!.name, 'Chọn quốc gia (user sửa)');
    assert.equal(merged!.origin, 'user');
    assert.deepEqual(merged!.section, machineSection);
    // Không tạo thêm màn mới — vẫn 2 màn.
    assert.equal(screens.length, 2);
    assert.deepEqual(warnings, []);
  });

  test('add trùng key màn máy kèm anchor hợp lệ → dùng section của user', () => {
    const anchorText = 'Người dùng xem lại đơn hàng và bấm Thanh toán.';
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'add', source: 'docs/prd.md', code: 'SCR-001', name: 'Chọn quốc gia (user sửa)', anchorText }],
    };
    const { screens } = applyScreenOverrides(baseScreens(), overrides, new Map([['docs/prd.md', MD]]));
    const merged = screens.find((s) => s.key === 'prd__SCR-001');
    assert.ok(merged);
    assert.equal(merged!.section!.startLine, 9);
  });

  test('rename đổi name', () => {
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'rename', key: 'prd__SCR-002', name: 'Chọn gói cước (mới)' }],
    };
    const { screens, warnings } = applyScreenOverrides(baseScreens(), overrides, new Map());
    assert.equal(screens.find((s) => s.key === 'prd__SCR-002')!.name, 'Chọn gói cước (mới)');
    assert.deepEqual(warnings, []);
  });

  test('rename key lạ → warning bỏ qua', () => {
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'rename', key: 'khong-ton-tai', name: 'x' }],
    };
    const before = baseScreens();
    const { screens, warnings } = applyScreenOverrides(before, overrides, new Map());
    assert.deepEqual(screens.map((s) => s.name), before.map((s) => s.name));
    assert.equal(warnings.length, 1);
  });

  test('remove loại màn flow + navIn màn khác được lọc + navOut giữ nguyên', () => {
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'remove', key: 'prd__SCR-001' }],
    };
    const { screens, warnings } = applyScreenOverrides(baseScreens(), overrides, new Map());
    assert.equal(screens.length, 1);
    const remaining = screens[0]!;
    assert.equal(remaining.key, 'prd__SCR-002');
    // navIn lọc bỏ key đã remove.
    assert.deepEqual(remaining.navIn, []);
    // navOut GIỮ NGUYÊN dù trỏ tới key đã vắng.
    assert.deepEqual(remaining.navOut, [{ to: 'prd__SCR-001', via: 'Quay lại' }]);
    assert.deepEqual(warnings, []);
  });

  test('remove key lạ → warning bỏ qua', () => {
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'remove', key: 'khong-ton-tai' }],
    };
    const before = baseScreens();
    const { screens, warnings } = applyScreenOverrides(before, overrides, new Map());
    assert.equal(screens.length, before.length);
    assert.equal(warnings.length, 1);
  });

  // WP14 do.0 (review độc lập WP13a nêu, thêm cùng đợt nối dây): 2 ca đặc
  // biệt của thứ tự override trong CÙNG một mảng — quan trọng vì client
  // (ScreenListManager.tsx) luôn PUT ĐÈ TOÀN BỘ mảng, có thể chứa nhiều
  // thao tác chồng lên nhau cho cùng một key trong một lần lưu.
  test('2 entry add CÙNG key → entry sau thắng, không nhân đôi', () => {
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [
        { action: 'add', source: 'docs/prd.md', code: 'SCR-003', name: 'Tên lần 1' },
        { action: 'add', source: 'docs/prd.md', code: 'SCR-003', name: 'Tên lần 2 (thắng)' },
      ],
    };
    const { screens, warnings } = applyScreenOverrides(baseScreens(), overrides, new Map([['docs/prd.md', MD]]));
    const matches = screens.filter((s) => s.key === 'prd__SCR-003');
    assert.equal(matches.length, 1, 'không được nhân đôi màn');
    assert.equal(matches[0]!.name, 'Tên lần 2 (thắng)');
    assert.deepEqual(warnings, []);
  });

  test('remove RỒI add CÙNG key → add sau thắng (màn trở lại danh sách)', () => {
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [
        { action: 'remove', key: 'prd__SCR-001' },
        { action: 'add', source: 'docs/prd.md', code: 'SCR-001', name: 'Chọn quốc gia (thêm lại)' },
      ],
    };
    const { screens, warnings } = applyScreenOverrides(baseScreens(), overrides, new Map([['docs/prd.md', MD]]));
    const matches = screens.filter((s) => s.key === 'prd__SCR-001');
    assert.equal(matches.length, 1, 'không được nhân đôi màn');
    assert.equal(matches[0]!.name, 'Chọn quốc gia (thêm lại)');
    assert.equal(matches[0]!.origin, 'user');
    // 2 màn ban đầu: remove rồi add lại → vẫn 2 màn (không mất SCR-002).
    assert.equal(screens.length, 2);
    assert.deepEqual(warnings, []);
  });

  test('order đánh lại liên tục sau apply (remove + add)', () => {
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [
        { action: 'remove', key: 'prd__SCR-001' },
        { action: 'add', source: 'docs/prd.md', code: 'SCR-005', name: 'Màn mới' },
      ],
    };
    const { screens } = applyScreenOverrides(baseScreens(), overrides, new Map([['docs/prd.md', MD]]));
    assert.equal(screens.length, 2);
    assert.deepEqual(screens.map((s) => s.order), [0, 1]);
  });
});

describe('buildScreensManifest', () => {
  test('shape đúng DTO', () => {
    const manifest = buildScreensManifest(baseScreens());
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.screens.length, 2);
    const first = manifest.screens[0]!;
    assert.deepEqual(first, {
      key: 'prd__SCR-001',
      code: 'SCR-001',
      name: 'Chọn quốc gia',
      source: 'docs/prd.md',
      origin: 'flow',
      line: 3,
      hasSection: true,
    });
  });

  test('origin thiếu (màn flow cũ) → "flow"', () => {
    const screens = baseScreens();
    delete screens[1]!.origin;
    const manifest = buildScreensManifest(screens);
    assert.equal(manifest.screens[1]!.origin, 'flow');
  });

  test('hasSection/line đúng khi không có section', () => {
    const manifest = buildScreensManifest(baseScreens());
    const second = manifest.screens[1]!;
    assert.equal(second.hasSection, false);
    assert.equal(second.line, null);
  });
});
