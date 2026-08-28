// screen-variants WP-V (docs/screen-variants-spec.md), subplan T8/T10
// (docs/screen-variants-subplan.md) — phần "e2e docs-review thêm fixture đa
// nền tảng" của T8 gốc chưa làm: tests/fixtures/multi-platform-cr.md chỉ
// từng được 5 file unit test (screen-platform/screen-groups/mockup-order/
// variant-drift/variant-drift-scan) dùng RỜI RẠC, mỗi file chỉ khớp MỘT lớp
// (screen-platform.ts | screen-groups.ts | variant-drift-scan.ts…). File
// này chạy CHUỖI THẬT bốn hàm thuần liên tiếp — mergeExtractedScreens →
// applyScreenGrouping → buildScreensManifest → scanVariantDriftFromDocs —
// đúng thứ tự wiring thật trong server.ts (stage dr-comp), để bắt những lỗi
// chỉ lộ ra ở RANH GIỚI giữa hai lớp (ví dụ: field một lớp ghi mà lớp sau đọc
// sai tên/sai đơn vị dòng) mà test đơn lẻ từng lớp không thấy được. Không
// mock: mọi hàm là export thật từ src/, mọi dữ liệu là nội dung THẬT của
// fixture (số dòng ghim thủ công, đối chiếu README ở tests/screen-platform.test.ts).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import type { ScreensManifest } from '@open-design/contracts';

import { mergeExtractedScreens, type ExtractAccepted } from '../src/screen-extract.js';
import { applyScreenGrouping, buildScreensManifest } from '../src/screen-overrides.js';
import { scanVariantDriftFromDocs } from '../src/variant-drift-scan.js';
import type { ScreenInput } from '../src/screen-components.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'multi-platform-cr.md');
const SOURCE = 'docs/cr.md'; // stem 'cr' (path.posix.basename(SOURCE, '.md'))

async function readFixture(): Promise<string> {
  return fs.readFile(FIXTURE_PATH, 'utf8');
}

// Số dòng (1-based) cố định trong fixture — ghim thủ công đối chiếu nội
// dung thật (xem tests/screen-platform.test.ts cho cùng khuôn). Nếu fixture
// đổi, các hằng số này phải xét lại theo nội dung mới, không đoán.
const LINE = {
  // §2.1 — luồng bước đánh số, KHÔNG dưới heading khớp từ khóa platform nào
  // (ancestor "## II. Mô tả thay đổi" / "### 2.1 Luồng xử lý...") → platform
  // phải là null, và spread không được thêm field 'platform'.
  flow1Bold: 29, // 1. KH truy cập chức năng **Hỗ trợ trực tuyến**
  // §2.2 Màn hình MB (bảng "Hiện trạng | Thay đổi | Mô tả", mỗi màn 2 dòng)
  mb1Bold: 39, // **Màn hình quản lý yêu cầu của tôi**
  mb2Bold: 41, // **Màn hình tạo yêu cầu hỗ trợ trực tuyến**
  mb3Bold: 43, // **Màn hình kết quả giao dịch**
  mb4Bold: 45, // **Màn hình danh sách lý do**
  // §2.3 Màn hình IB
  ib1Bold: 52, // **Màn hình quản lý yêu cầu của tôi** (trùng hệt tên MB1)
  ib2Bold: 54, // **Màn hình tạo yêu cầu hỗ trợ trực tuyến** (trùng hệt tên MB2)
  ib3Bold: 56, // **Màn hình kết quả giao dịch** (trùng hệt tên MB3)
  ib4Bold: 58, // **Popup danh sách lý do hỗ trợ** (ca mờ so với MB4)
  // §2.4 Màn hình BO — heading đậm + ảnh + bullet, không đối ứng MB/IB
  bo1Bold: 63, // **Màn hình quản lý yêu cầu hỗ trợ**
  bo2Bold: 74, // **Màn hình chi tiết yêu cầu hỗ trợ - GDV tiếp nhận yêu cầu**
};

/** Dựng `ExtractAccepted[]` từ chính nội dung fixture — 1 màn "flow" (agent
 *  không khai platform) + 4 màn MB + 4 màn IB + 2 màn BO, đúng như agent lớp 2
 *  (screen-extract.ts) sẽ khai sau khi `validateDocScreenExtract` đã đối
 *  chiếu anchor thật (ở đây dựng thẳng accepted vì phạm vi T10 chỉ chạy chuỗi
 *  TỪ mergeExtractedScreens trở đi, không lặp lại test của validate*).
 *  WP docs-review-screen-platform (2026-08-28): daemon KHÔNG còn suy platform
 *  từ heading cha — `platform` là quyết định của AGENT (`app` | `web`), ở đây
 *  khai thẳng trên accepted đúng như screens.json v2 của flow tách. */
function buildCrAccepted(): ExtractAccepted[] {
  return [
    { source: SOURCE, code: 'FLOW1', name: 'Hỗ trợ trực tuyến', line: LINE.flow1Bold, section: { startLine: LINE.flow1Bold, endLine: 33 } },
    { source: SOURCE, code: 'MB1', name: 'Màn hình quản lý yêu cầu của tôi', line: LINE.mb1Bold, section: { startLine: LINE.mb1Bold, endLine: 40 }, platform: 'app' },
    { source: SOURCE, code: 'MB2', name: 'Màn hình tạo yêu cầu hỗ trợ trực tuyến', line: LINE.mb2Bold, section: { startLine: LINE.mb2Bold, endLine: 42 }, platform: 'app' },
    { source: SOURCE, code: 'MB3', name: 'Màn hình kết quả giao dịch', line: LINE.mb3Bold, section: { startLine: LINE.mb3Bold, endLine: 44 }, platform: 'app' },
    { source: SOURCE, code: 'MB4', name: 'Màn hình danh sách lý do', line: LINE.mb4Bold, section: { startLine: LINE.mb4Bold, endLine: 47 }, platform: 'app' },
    { source: SOURCE, code: 'IB1', name: 'Màn hình quản lý yêu cầu của tôi', line: LINE.ib1Bold, section: { startLine: LINE.ib1Bold, endLine: 53 }, platform: 'web' },
    { source: SOURCE, code: 'IB2', name: 'Màn hình tạo yêu cầu hỗ trợ trực tuyến', line: LINE.ib2Bold, section: { startLine: LINE.ib2Bold, endLine: 55 }, platform: 'web' },
    { source: SOURCE, code: 'IB3', name: 'Màn hình kết quả giao dịch', line: LINE.ib3Bold, section: { startLine: LINE.ib3Bold, endLine: 57 }, platform: 'web' },
    { source: SOURCE, code: 'IB4', name: 'Popup danh sách lý do hỗ trợ', line: LINE.ib4Bold, section: { startLine: LINE.ib4Bold, endLine: 60 }, platform: 'web' },
    { source: SOURCE, code: 'BO1', name: 'Màn hình quản lý yêu cầu hỗ trợ', line: LINE.bo1Bold, section: { startLine: LINE.bo1Bold, endLine: 73 }, platform: 'web' },
    { source: SOURCE, code: 'BO2', name: 'Màn hình chi tiết yêu cầu hỗ trợ - GDV tiếp nhận yêu cầu', line: LINE.bo2Bold, section: { startLine: LINE.bo2Bold, endLine: 85 }, platform: 'web' },
  ];
}

async function buildCrMdBySource(): Promise<Map<string, string>> {
  return new Map([[SOURCE, await readFixture()]]);
}

async function buildMergedCrScreens(): Promise<ScreenInput[]> {
  const mdBySource = await buildCrMdBySource();
  const accepted = buildCrAccepted();
  const { screens } = mergeExtractedScreens([], accepted, mdBySource);
  return screens;
}

function byKey(screens: ScreenInput[], key: string): ScreenInput {
  const s = screens.find((x) => x.key === key);
  assert.ok(s, `không tìm thấy màn có key "${key}"`);
  return s!;
}

// ── Bước 1: mergeExtractedScreens ───────────────────────────────────────────

describe('T10 e2e: mergeExtractedScreens trên fixture đa nền tảng', () => {
  test('màn dưới bảng MB (§2.2, agent khai platform "app") nhận platform "mobile"', async () => {
    const screens = await buildMergedCrScreens();
    for (const code of ['MB1', 'MB2', 'MB3', 'MB4']) {
      const s = byKey(screens, `cr__${code}`);
      assert.equal(s.platform, 'mobile', `cr__${code} phải là mobile`);
    }
  });

  test('màn dưới bảng IB (§2.3) và mục BO (§2.4, agent khai "web") nhận platform "web"', async () => {
    const screens = await buildMergedCrScreens();
    for (const code of ['IB1', 'IB2', 'IB3', 'IB4', 'BO1', 'BO2']) {
      const s = byKey(screens, `cr__${code}`);
      assert.equal(s.platform, 'web', `cr__${code} phải là web`);
    }
  });

  test('màn dưới §2.1 (agent không khai platform, phạm vi vắng) KHÔNG có field platform — daemon không suy từ heading', async () => {
    const screens = await buildMergedCrScreens();
    const flow1 = byKey(screens, 'cr__FLOW1');
    assert.equal(flow1.platform, undefined);
    assert.equal('platform' in flow1, false);
  });

  test('mọi màn được gắn origin "agent" và key đúng khuôn <stem>__<code>', async () => {
    const screens = await buildMergedCrScreens();
    assert.equal(screens.length, 11);
    for (const s of screens) {
      assert.equal(s.origin, 'agent');
      assert.ok(s.key.startsWith('cr__'));
    }
  });
});

// ── Bước 2: applyScreenGrouping ──────────────────────────────────────────────

describe('T10 e2e: applyScreenGrouping trên kết quả bước 1', () => {
  test('3 cặp trùng-hệt tên MB↔IB thành nhóm, key đổi hậu tố --app/--web, groupKey dạng cr__G-<slug>', async () => {
    const merged = await buildMergedCrScreens();
    const grouped = applyScreenGrouping(merged);

    assert.equal(grouped.changed, true);
    assert.equal(grouped.groupCount, 3);

    const pairs: Array<[string, string, string]> = [
      ['MB1', 'IB1', 'cr__G-quan-ly-yeu-cau-cua-toi'],
      ['MB2', 'IB2', 'cr__G-tao-yeu-cau-ho-tro-truc-tuyen'],
      ['MB3', 'IB3', 'cr__G-ket-qua-giao-dich'],
    ];
    for (const [mbCode, ibCode, groupKey] of pairs) {
      const app = byKey(grouped.screens, `cr__${mbCode}--app`);
      const web = byKey(grouped.screens, `cr__${ibCode}--web`);
      assert.equal(app.groupKey, groupKey, `cr__${mbCode}--app phải mang groupKey ${groupKey}`);
      assert.equal(web.groupKey, groupKey, `cr__${ibCode}--web phải mang groupKey ${groupKey}`);
      // Key gốc không còn tồn tại — đã đổi hẳn sang hậu tố.
      assert.equal(grouped.screens.some((s) => s.key === `cr__${mbCode}`), false);
      assert.equal(grouped.screens.some((s) => s.key === `cr__${ibCode}`), false);
    }
  });

  test('cặp mờ "danh sách lý do" ↔ "popup danh sách lý do hỗ trợ" (MB4/IB4) nằm trong suggestions, KHÔNG thành nhóm', async () => {
    const merged = await buildMergedCrScreens();
    const grouped = applyScreenGrouping(merged);

    const found = grouped.suggestions.find(
      (s) =>
        (s.a.key === 'cr__MB4' && s.b.key === 'cr__IB4') || (s.b.key === 'cr__MB4' && s.a.key === 'cr__IB4'),
    );
    assert.ok(found, 'MB4/IB4 phải xuất hiện trong suggestions');
    assert.match(found!.reason, /tập con/);

    // Key gốc GIỮ NGUYÊN — ca mờ không tự nhóm.
    assert.ok(grouped.screens.some((s) => s.key === 'cr__MB4'));
    assert.ok(grouped.screens.some((s) => s.key === 'cr__IB4'));
    assert.equal(byKey(grouped.screens, 'cr__MB4').groupKey, undefined);
    assert.equal(byKey(grouped.screens, 'cr__IB4').groupKey, undefined);
  });

  test('màn BO đơn (không đối ứng) giữ nguyên key, không groupKey', async () => {
    const merged = await buildMergedCrScreens();
    const grouped = applyScreenGrouping(merged);
    for (const code of ['BO1', 'BO2']) {
      const s = byKey(grouped.screens, `cr__${code}`);
      assert.equal(s.groupKey, undefined);
    }
  });

  test('navOut/navIn được sweep sang key mới sau khi nhóm đổi key', async () => {
    const merged = await buildMergedCrScreens();
    // Dựng cạnh nav thủ công (dr-flow thật sẽ tạo cạnh này) TRƯỚC khi nhóm:
    // BO1 --nav--> MB1 (navOut), và MB2 khai navIn từ MB1 (mô phỏng một cạnh
    // nội bộ) — cả hai đều trỏ theo SCREEN-KEY GỐC trước khi đổi hậu tố.
    byKey(merged, 'cr__BO1').navOut = [{ to: 'cr__MB1', via: 'test nav sweep' }];
    byKey(merged, 'cr__MB2').navIn = ['cr__MB1'];

    const grouped = applyScreenGrouping(merged);

    // BO1 không đổi key (không nhóm) — navOut.to phải được sweep theo key MỚI
    // của MB1 (đã đổi thành cr__MB1--app).
    const bo1 = byKey(grouped.screens, 'cr__BO1');
    assert.equal(bo1.navOut.length, 1);
    assert.equal(bo1.navOut[0]!.to, 'cr__MB1--app');

    // MB2 chính nó cũng đổi key (cr__MB2--app) — navIn phải trỏ key MỚI của MB1.
    const mb2 = byKey(grouped.screens, 'cr__MB2--app');
    assert.deepEqual(mb2.navIn, ['cr__MB1--app']);
  });
});

// ── Bước 3: buildScreensManifest ─────────────────────────────────────────────

describe('T10 e2e: buildScreensManifest trên kết quả bước 2', () => {
  test('schema_version 2, entry nhóm mang đủ platform+groupKey, entry đơn không có groupKey', async () => {
    const merged = await buildMergedCrScreens();
    const grouped = applyScreenGrouping(merged);
    const manifest = buildScreensManifest(grouped.screens);

    assert.equal(manifest.schema_version, 2);
    assert.equal(manifest.screens.length, 11);

    const grouped1 = manifest.screens.find((e) => e.key === 'cr__MB1--app')!;
    assert.equal(grouped1.platform, 'mobile');
    assert.equal(grouped1.groupKey, 'cr__G-quan-ly-yeu-cau-cua-toi');

    const grouped2 = manifest.screens.find((e) => e.key === 'cr__IB3--web')!;
    assert.equal(grouped2.platform, 'web');
    assert.equal(grouped2.groupKey, 'cr__G-ket-qua-giao-dich');

    // Đơn (ca mờ, không nhóm) — có platform (suy được theo section) nhưng
    // KHÔNG có groupKey.
    for (const key of ['cr__MB4', 'cr__IB4', 'cr__BO1', 'cr__BO2']) {
      const e = manifest.screens.find((x) => x.key === key)!;
      assert.ok(e, `manifest phải có entry ${key}`);
      assert.equal(e.groupKey, undefined, `${key} không được có groupKey`);
      assert.ok(e.platform === 'mobile' || e.platform === 'web', `${key} phải có platform xác định`);
    }

    // FLOW1 — platform không suy được, không nhóm.
    const flow1 = manifest.screens.find((e) => e.key === 'cr__FLOW1')!;
    assert.ok(flow1);
    assert.equal(flow1.platform, undefined);
    assert.equal(flow1.groupKey, undefined);
    assert.equal(flow1.line, LINE.flow1Bold);
    assert.equal(flow1.hasSection, true);
  });
});

// ── Bước 4: scanVariantDriftFromDocs ────────────────────────────────────────

describe('T10 e2e: scanVariantDriftFromDocs trên manifest bước 3', () => {
  test('nhóm "kết quả giao dịch" lệch đúng 1 bullet ("Phản hồi (bổ sung)") chỉ có ở MB — 2 nhóm còn lại khớp hoàn toàn', async () => {
    const merged = await buildMergedCrScreens();
    const grouped = applyScreenGrouping(merged);
    const manifest = buildScreensManifest(grouped.screens);
    const mdBySource = await buildCrMdBySource();

    const result = scanVariantDriftFromDocs(manifest, mdBySource);

    // Đọc kỹ nội dung THẬT của fixture (§2.2 dòng 44 / §2.3 dòng 57):
    // - nhóm "quản lý yêu cầu của tôi": cột Mô tả MB (dòng 40) và IB (dòng 53)
    //   giống hệt nhau → 0 finding.
    // - nhóm "tạo yêu cầu hỗ trợ trực tuyến": cột Mô tả MB (dòng 42) và IB
    //   (dòng 55) giống hệt nhau → 0 finding.
    // - nhóm "kết quả giao dịch": MB (dòng 44) có 3 bullet "Mã yêu cầu (bổ
    //   sung)" / "Số tiền GD (bổ sung)" / "Phản hồi (bổ sung)"; IB (dòng 57)
    //   chỉ có 2 bullet đầu — thiếu "Phản hồi (bổ sung)" → 1 finding onlyIn
    //   'mobile'.
    assert.equal(result.warnings.length, 0);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0], {
      groupKey: 'cr__G-ket-qua-giao-dich',
      onlyIn: 'mobile',
      bullet: 'Phản hồi (bổ sung)',
      counterpartKey: 'cr__IB3--web',
    });
  });
});

// ── Bước 5: bất biến G6 (tài liệu MỘT nền tảng) ─────────────────────────────

describe('T10 e2e: bất biến G6 — tài liệu không có heading nào khớp từ khóa platform', () => {
  const SINGLE_SOURCE = 'docs/single.md';
  const SINGLE_MD = [
    '# Tài liệu một nền tảng',
    '',
    '## Mô tả màn hình',
    '',
    '**Màn hình đăng nhập**',
    '',
    'Nội dung màn hình đăng nhập.',
    '',
    '**Màn hình danh sách**',
    '',
    'Nội dung màn hình danh sách.',
  ].join('\n');
  const SINGLE_LINE = { s1Bold: 5, s2Bold: 9 };

  function buildSingleAccepted(): ExtractAccepted[] {
    return [
      { source: SINGLE_SOURCE, code: 'S1', name: 'Màn hình đăng nhập', line: SINGLE_LINE.s1Bold, section: { startLine: SINGLE_LINE.s1Bold, endLine: 8 } },
      { source: SINGLE_SOURCE, code: 'S2', name: 'Màn hình danh sách', line: SINGLE_LINE.s2Bold, section: { startLine: SINGLE_LINE.s2Bold, endLine: 11 } },
    ];
  }

  test('mọi màn không có field platform sau mergeExtractedScreens', () => {
    const mdBySource = new Map([[SINGLE_SOURCE, SINGLE_MD]]);
    const { screens } = mergeExtractedScreens([], buildSingleAccepted(), mdBySource);
    assert.equal(screens.length, 2);
    for (const s of screens) {
      assert.equal(s.platform, undefined);
      assert.equal('platform' in s, false);
    }
  });

  test('applyScreenGrouping trả changed:false, danh sách/key giữ nguyên', () => {
    const mdBySource = new Map([[SINGLE_SOURCE, SINGLE_MD]]);
    const { screens } = mergeExtractedScreens([], buildSingleAccepted(), mdBySource);
    const grouped = applyScreenGrouping(screens);

    assert.equal(grouped.changed, false);
    assert.equal(grouped.groupCount, 0);
    assert.deepEqual(grouped.suggestions, []);
    assert.equal(grouped.screens, screens); // cùng tham chiếu — không đổi gì.
    assert.deepEqual(
      grouped.screens.map((s) => s.key),
      ['single__S1', 'single__S2'],
    );
  });

  test('buildScreensManifest ra schema_version 1, serialize không chứa "platform"/"groupKey"', () => {
    const mdBySource = new Map([[SINGLE_SOURCE, SINGLE_MD]]);
    const { screens } = mergeExtractedScreens([], buildSingleAccepted(), mdBySource);
    const grouped = applyScreenGrouping(screens);
    const manifest: ScreensManifest = buildScreensManifest(grouped.screens);

    assert.equal(manifest.schema_version, 1);
    const json = JSON.stringify(manifest);
    assert.equal(json.includes('"platform"'), false);
    assert.equal(json.includes('"groupKey"'), false);
  });

  test('scanVariantDriftFromDocs trả findings rỗng (manifest schema_version 1 → không đọc md nào)', () => {
    const mdBySource = new Map([[SINGLE_SOURCE, SINGLE_MD]]);
    const { screens } = mergeExtractedScreens([], buildSingleAccepted(), mdBySource);
    const grouped = applyScreenGrouping(screens);
    const manifest: ScreensManifest = buildScreensManifest(grouped.screens);

    // mdBySource CỐ Ý rỗng ở bước quét — nếu hàm lỡ đọc nhầm sẽ không throw
    // (Map rỗng), nhưng khẳng định luôn ở đây rằng findings rỗng vì gate
    // schema_version chặn NGAY từ đầu (spec "0 nhóm = 0 chi phí").
    const result = scanVariantDriftFromDocs(manifest, new Map());
    assert.deepEqual(result, { findings: [], warnings: [] });
  });
});
