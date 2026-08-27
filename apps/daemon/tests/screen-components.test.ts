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
  normalizeRoleMap,
  normalizeScreenComponentsDoc,
  resolveCatalogEntry,
  scanDocScreens,
  scanWireframe,
  mergeScreenComponents,
  screenDocRel,
  wireframeRel,
  SCREEN_INPUTS_FILE,
  SCREEN_COMPONENTS_SCHEMA_VERSION,
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
  '### `#figma-aaa` Heading — [SDK] Web Lib (Slot) (2548:10828)',
  '',
  '### `#figma-bbb` Heading — [SDK] Web Lib (Slot) (30:704)',
  '',
  '### `#figma-ccc` Text Field Simple',
  '',
].join('\n');

// Heading GỘP số mục + mã màn thật ("4.1 SCR-001 …") — khuôn tài liệu có
// thật (BLOCKING 1, review độc lập vòng 2 sau WP9b). scanDocScreens phải
// nhận SCR-001/SCR-002 làm mã màn (không phải "4.1"/"4.2" — số mục bao
// ngoài) để khoá `…__SCR-001` khớp đúng khoá flow đã khai, không nhân đôi
// khi prepareScreenComponentInputs hợp nhất (WP9b). WP9b từng LÉN đổi
// fixture này sang "SCR-001 …" (bỏ hẳn tiền tố số mục) để né lỗi thay vì sửa
// gốc rễ ở scanDocScreens — WP9c trả fixture về khuôn gốc và sửa gốc rễ.
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

test('scanDocScreens: heading GỘP số mục + mã màn thật ("4.1 SCR-001 …") → nhận SCR-001/SCR-002, không phải "4.1"/"4.2" (BLOCKING 1, review độc lập vòng 2)', () => {
  const found = scanDocScreens(PAGE_MD);
  assert.deepEqual(
    found.map((f) => [f.code, f.name]),
    [
      ['SCR-001', 'Chọn quốc gia'],
      ['SCR-002', 'Chọn gói cước'],
    ],
  );
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
  // WP9c: prepareScreenComponentInputs giờ LUÔN quét tài liệu để hợp nhất, và
  // scanDocScreens tự nhận ra mã màn SCR-001/SCR-002 dù heading có tiền tố số
  // mục ("4.1"/"4.2") đứng trước (BLOCKING 1) → khoá trùng với flow, dedup
  // sạch, không có màn bổ sung nào (khác test dưới, dùng mã MH).
  assert.equal(s1!.origin, 'flow');
  assert.equal(s2!.origin, 'flow');
  const onDisk = JSON.parse(await readFile(join(cwd, SCREEN_INPUTS_FILE), 'utf8')) as ScreenComponentsInputs;
  assert.equal(onDisk.screens.length, 2);
});

// WP dr-mockup (2026-08-27): `outFile` cho dr-mockup ghi `mockups/_inputs.json`
// (mặc định vẫn comp/_inputs.json); `selection` chép từ index entry;
// `excludeRemovedByProposal` bỏ màn bản Cải thiện đề nghị bỏ.
test('prepareScreenComponentInputs: outFile ghi đúng chỗ (mặc định không đổi), selection từ index, excludeRemovedByProposal', async () => {
  await seedFlowRun();
  const pages = [{ mdPath: 'docs-feature/2.1-PRD-Mua-SIM.md', page: '2.1 PRD Mua SIM' }];
  // Thêm selection + một màn removedByProposal vào index để kiểm 2 option còn lại.
  const indexPath = join(cwd, 'flows', 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8')) as Array<Record<string, unknown>>;
  index[0]!.selection = { variant: 'improved', source: 'user' };
  (index[0]!.screens as Array<Record<string, unknown>>).push({ key: '2.1-PRD-Mua-SIM__SCR-009', name: 'Màn bỏ', removedByProposal: true });
  await writeFile(indexPath, JSON.stringify(index));

  const viaMockup = await prepareScreenComponentInputs(cwd, { pages, outFile: 'mockups/_inputs.json', excludeRemovedByProposal: true });
  assert.deepEqual(viaMockup.selection, { variant: 'improved', source: 'user' });
  assert.ok(!viaMockup.screens.some((s) => s.key === '2.1-PRD-Mua-SIM__SCR-009'), 'màn removedByProposal bị loại');
  const onDisk = JSON.parse(await readFile(join(cwd, 'mockups', '_inputs.json'), 'utf8')) as ScreenComponentsInputs;
  assert.equal(onDisk.screens.length, viaMockup.screens.length);
  assert.deepEqual(onDisk.selection, { variant: 'improved', source: 'user' });
  await assert.rejects(readFile(join(cwd, SCREEN_INPUTS_FILE), 'utf8'), 'outFile không ghi comp/_inputs.json');

  // Mặc định: comp/_inputs.json như cũ, removedByProposal VẪN có mặt cho dr-comp.
  const viaComp = await prepareScreenComponentInputs(cwd, { pages });
  assert.ok(viaComp.screens.some((s) => s.key === '2.1-PRD-Mua-SIM__SCR-009'));
  const compDisk = JSON.parse(await readFile(join(cwd, SCREEN_INPUTS_FILE), 'utf8')) as ScreenComponentsInputs;
  assert.equal(compDisk.screens.length, viaComp.screens.length);
});

test('prepareScreenComponentInputs: chưa có flows → screens rỗng + note bảo chạy dr-flow', async () => {
  const inputs = await prepareScreenComponentInputs(cwd, { pages: [] });
  assert.equal(inputs.screens.length, 0);
  assert.match(inputs.note ?? '', /dr-flow/);
});

// ── Sự cố #5d13309f: dr-comp chết vì dr-flow không gắn được màn nào (sơ đồ
// sequence). Fixture rút gọn từ tài liệu thật "Đăng nhập SSO" (dự án
// dang-nhap-sso, docs-review/docs-feature/…/Dang-nhap-SSO.md). ──────────────

const HEADING_CASES_MD = [
  '## 2/ Luồng sơ đồ',
  '',
  '### 3.1/ Danh sách màn hình',
  '',
  '#### MH1: Đăng nhập SSO',
  '',
  '#### MH2: Đồng ý chia sẻ dữ liệu cá nhân',
  '',
  '#### MH3: Popup chia sẻ dữ liệu với bên thứ 3',
  '',
  '### 3.2/ Mô tả màn hình',
  '',
  '#### MH1: Đăng nhập SSO',
  '',
  '###### Màn hình 1: SCR-001 — Trang chủ',
  '',
  // WP9c (BLOCKING trong review độc lập vòng 2, letter b): trước đây (WP9b)
  // mã mục nhiều cấp (`6.1.1`) được nhận CÙNG với MH/SCR trong một tài liệu
  // khi có heading tổ tiên nhắc "giao diện"/"màn hình". Luật 2 lượt mới đổi
  // điều đó — một khi tài liệu đã có mã màn TƯỜNG MINH (MH/SCR/URD) ở BẤT KỲ
  // đâu, lượt 2 (mã mục nhiều cấp) không chạy nữa, dù chương "6. …" dưới đây
  // có ancestor hint hợp lệ. Giữ chương này lại đúng để chứng minh nó KHÔNG
  // còn lọt vào kết quả (xem assert.ok bên dưới).
  '## 6. Khung giao diện sơ bộ',
  '',
  '### 6.1.1 Màn hình chi tiết gói cước',
  '',
  '```',
  '#### MH9: Trong code fence, không tính',
  '```',
].join('\n');

test('scanDocScreens: bắt MH/SCR ở đầu heading + khuôn v1 URD, bỏ heading số mục thường/mục lục và nội dung trong fence, loại trùng mã (giữ lần đầu); mã mục nhiều cấp KHÔNG chạy khi tài liệu đã có mã tường minh (WP9c, luật 2 lượt)', () => {
  const found = scanDocScreens(HEADING_CASES_MD);
  assert.deepEqual(
    found.map((f) => [f.code, f.name]),
    [
      ['MH1', 'Đăng nhập SSO'],
      ['MH2', 'Đồng ý chia sẻ dữ liệu cá nhân'],
      ['MH3', 'Popup chia sẻ dữ liệu với bên thứ 3'],
      ['SCR-001', 'Trang chủ'],
    ],
  );
  assert.ok(!found.some((f) => f.code === '6.1.1'), 'lượt 2 (mã mục nhiều cấp) không được chạy khi tài liệu đã có mã tường minh ở nơi khác');
  assert.deepEqual(scanDocScreens('## 3.1/ Danh sách màn hình\n\n## 2/ Luồng sơ đồ\n'), []);
});

// Fixture RÚT GỌN chép từ tài liệu PRD SIM du lịch thật (2.1.-PRD-Detail-Mua-
// SIM-du-lich.md, dự án 2-1-prd-detail-mua-sim-du-lich) — giữ nguyên các
// heading nêu trong spec WP9b, kể cả lỗi thật của export Confluence: mục "8."
// mất `#` (còn `##` rỗng + text đậm rời) và `6.2.2.` nằm ở cấp `##` xen giữa
// các heading `###` khác cùng chương (không đọc od-data lúc chạy test).
const PRD_SIM_SECTION_MD = [
  '## **3. Luồng nghiệp vụ tính năng**',
  '',
  '### 3.1 Luồng sơ đồ',
  '',
  'sơ đồ mermaid ở đây (không tính vì tổ tiên "3. Luồng nghiệp vụ" không nhắc giao diện/màn hình).',
  '',
  '### 3.2 Mô tả',
  '',
  'bảng bước luồng.',
  '',
  '## **6. Khung giao diện sơ bộ**',
  '',
  '### 6.1. Màn trang chủ',
  '',
  '#### 6.1.1 Màn hình trang chủ',
  '',
  '### 6.2. Trường hợp: KH chọn đi du lịch nước ngoài',
  '',
  '### 6.2.1. Màn hình chọn Quốc gia & Khu vực',
  '',
  '## 6.2.2. Màn hình Danh sách gói cước Nước ngoài',
  '',
  '### 6.3. Trường hợp: KH chọn đi du lịch Việt Nam',
  '',
  '#### 6.3.1. Màn hình danh sách gói cước Việt Nam',
  '',
  '#### 6.3.2. Chi tiết gói cước Việt Nam (mô tả tương tự phần chi tiết gói nước ngoài 6.2.3. Lưu ý: chi tiết gói VN chỉ áp dụng với quốc gia = Việt Nam)',
  '',
  '### 6.4. Thông tin chung',
  '',
  '#### 6.4.1 Nhập thông tin',
  '',
  '#### 6.4.2 Địa chỉ nhận hàng (Sim vật lý)',
  '',
  '#### 6.4.3. Thông tin xuất hóa đơn',
  '',
  '#### 6.4.4. Mã voucher',
  '',
  '## **7. Tiêu chí nghiệm thu**',
  '',
  '##',
  '**8. Trong phạm vi & ngoài phạm vi tính năng**',
  '',
  '### 8.1 Trong Phạm Vi (In Scope)',
  '',
  '### 8.2 Ngoài Phạm Vi (Out of Scope)',
].join('\n');

test('scanDocScreens: PRD SIM du lịch thật — 9 màn (6.1.1…6.4.4), KHÔNG có luồng sơ đồ/phạm vi/mục nhóm (trước WP9b quét ra 17)', () => {
  const found = scanDocScreens(PRD_SIM_SECTION_MD);
  assert.deepEqual(
    found.map((f) => f.code),
    ['6.1.1', '6.2.1', '6.2.2', '6.3.1', '6.3.2', '6.4.1', '6.4.2', '6.4.3', '6.4.4'],
  );
  for (const bad of ['3.1', '3.2', '8.1', '8.2', '6.1', '6.2', '6.3', '6.4']) {
    assert.ok(!found.some((f) => f.code === bad), `không được nhận "${bad}" là màn`);
  }
});

// Mục lục lặp mã MH ở 3 mục khác nhau (3.1/, 3.2/, 4/) — chỉ heading "3.1/"
// bản thân (dùng dấu "/" không nằm trong tập phân cách) không được tính.
const SSO_HEADINGS_MD = [
  '## 3/ Luồng màn hình',
  '',
  '### 3.1/ Danh sách màn hình',
  '',
  '#### MH1: Đăng nhập SSO',
  '',
  '#### MH2: Đồng ý chia sẻ dữ liệu cá nhân',
  '',
  '#### MH3: Popup chia sẻ dữ liệu với bên thứ 3',
  '',
  '### 3.2/ Mô tả màn hình',
  '',
  '#### MH1: Đăng nhập SSO',
  '',
  '#### MH2: Đồng ý chia sẻ dữ liệu cá nhân',
  '',
  '#### MH3: Popup chia sẻ dữ liệu với bên thứ 3',
  '',
  '## 4/ Logic xử lý',
  '',
  '#### MH1: Đăng nhập SSO',
  '',
  '#### MH2: Đồng ý chia sẻ dữ liệu cá nhân',
  '',
  '#### MH3: Popup chia sẻ dữ liệu với bên thứ 3',
].join('\n');

test('scanDocScreens: SSO thật (mục lục 3/→3.1/→MH1-3, lặp ở 3.2/ và 4/) → đúng 3 màn MH1-3, không có "3.1"', () => {
  const found = scanDocScreens(SSO_HEADINGS_MD);
  assert.deepEqual(found.map((f) => f.code), ['MH1', 'MH2', 'MH3']);
});

// ── WP9c (BLOCKING 2, review độc lập vòng 2): heading NHÓM số mục
// ("### 3.1 Danh sách màn hình") dưới chương "## 3. Danh sách màn hình" bị
// leaf-check cũ coi là lá (con thật đánh mã MHxx, không phải "3.1.x") nên
// thành màn ma. Fixture rút gọn từ Chinh-sua-anh-gui.md thật (dự án
// dang-nhap-sso, docs-app/…/Quy-tac-chung/). ─────────────────────────────────
const SECTION_GROUP_VS_MH_MD = [
  '## 3. Danh sách màn hình',
  '',
  '### 3.1 Danh sách màn hình',
  '',
  '#### MH01: Trang chủ',
].join('\n');

test('scanDocScreens: luật 2 lượt (i) — tài liệu đã có mã MH tường minh thì heading nhóm số mục ("3.1 Danh sách màn hình") không còn được xét, dù ancestor hint "màn hình" khớp (BLOCKING 2)', () => {
  const found = scanDocScreens(SECTION_GROUP_VS_MH_MD);
  assert.deepEqual(found.map((f) => [f.code, f.name]), [['MH01', 'Trang chủ']]);
  assert.ok(!found.some((f) => f.code === '3.1'), 'heading nhóm "3.1" không được thành màn ma');
});

// Kiểu PRD SIM rút gọn — không có heading MH/SCR nào, chỉ có mã mục nhiều
// cấp (nhóm "6.1" + màn lá "6.1.1"): lượt 2 (fallback) phải vẫn chạy đúng
// như WP9b khi lượt 1 trắng tay.
const SECTION_ONLY_MD = [
  '## 6. Giao diện',
  '',
  '### 6.1 Nhóm màn chọn gói',
  '',
  '#### 6.1.1 Màn hình chọn gói',
].join('\n');

test('scanDocScreens: luật 2 lượt (ii) — tài liệu KHÔNG có mã MH/SCR nào (kiểu PRD SIM) → mã mục nhiều cấp vẫn fallback đúng như WP9b (nhóm "6.1" bị loại, lá "6.1.1" được nhận)', () => {
  const found = scanDocScreens(SECTION_ONLY_MD);
  assert.deepEqual(found.map((f) => f.code), ['6.1.1']);
});

// ── WP9c: MH nhận hậu tố "-<số>" (MH05-1 … MH05-7 trong Chinh-sua-anh-gui.md
// thật là các màn CON riêng biệt, trước đây bị gộp hết về "MH05"). ──────────
const MH_SUFFIX_MD = [
  '#### MH05-1: Khung chung',
  '',
  '#### MH05-2: Nhiều ảnh',
  '',
  '#### MH 2 — Tên',
].join('\n');

test('scanDocScreens: MH nhận hậu tố "-<số>" (MH05-1, MH05-2 tách riêng, không gộp về "MH05"); "MH 2 — Tên" vẫn ra MH2 như cũ', () => {
  const found = scanDocScreens(MH_SUFFIX_MD);
  assert.deepEqual(
    found.map((f) => [f.code, f.name]),
    [
      ['MH05-1', 'Khung chung'],
      ['MH05-2', 'Nhiều ảnh'],
      ['MH2', 'Tên'],
    ],
  );
});

// ── WP11 (sweep WP10, 24 trang URD cờ đỏ — 4 nguyên nhân thật soát tay từ
// Webhooks-Incoming-Webhook-…md, URD-Dang-ky-cham-cong-…md,
// URD-Hoi-dap-du-lieu-SalesGo-…md, Trang-chu.md, Group-Chia-se-nhom.md,
// Chinh-sua-anh-gui.md, URD-Bao-cao-dinh-ky-…md thật). ──────────────────────

// Nguyên nhân 1 — HỆ MÃ S: rút gọn từ Webhooks-Incoming-Webhook-…md (S01–S05)
// + URD-Hoi-dap-du-lieu-SalesGo-…md (`### S01 - Tên`).
const S_CODE_HEADINGS_MD = [
  '### S01 - Chuỗi tin — hỏi Sóc trong channel',
  '',
  '### S02 — DM Trợ lý Sóc',
  '',
  '### S03 Card kết quả submit',
  '',
  '### AF-01 — Thiếu slot bắt buộc',
  '',
  '### MF-01 — Tạo Webhook',
  '',
  '### Sóc trả lời',
].join('\n');

test('scanDocScreens: hệ mã S (WP11, nguyên nhân 1) — "S01 - Tên"/"S02 — Tên"/"S03 Tên" là màn; "AF-01"/"MF-01"/"Sóc trả lời" thì không', () => {
  const found = scanDocScreens(S_CODE_HEADINGS_MD);
  assert.deepEqual(
    found.map((f) => [f.code, f.name]),
    [
      ['S01', 'Chuỗi tin — hỏi Sóc trong channel'],
      ['S02', 'DM Trợ lý Sóc'],
      ['S03', 'Card kết quả submit'],
    ],
  );
});

test('scanDocScreens: mã mục dính mã S ("2.1.1. S01 Tên") → nhận S01, không phải "2.1.1" (matchLeadingCode, WP11)', () => {
  const found = scanDocScreens('### 2.1.1. S01 Tên màn hình chi tiết\n');
  assert.deepEqual(found.map((f) => [f.code, f.name]), [['S01', 'Tên màn hình chi tiết']]);
});

test('scanDocScreens: tài liệu có S01 + heading "2.1. Danh sách màn hình" → không có màn ma "2.1" (lượt 1 đã có S nên lượt 2 không chạy, WP11)', () => {
  const md = ['## 2.1. Danh sách màn hình', '', '### S01 - Tên', ''].join('\n');
  assert.deepEqual(
    scanDocScreens(md).map((f) => f.code),
    ['S01'],
  );
});

// Nguyên nhân 2 — HẬU TỐ CHẤM: rút gọn từ Trang-chu.md thật (MH6.1–6.3,
// MH10.1–10.4 bị gộp về "MH6"/"MH10" trước WP11 vì MH_CODE_RE cũ chỉ nhận
// hậu tố "-<số>").
const MH_DOT_SUFFIX_MD = [
  '#### MH6.1: Tên A',
  '',
  '#### MH6.2: Tên B',
  '',
  '#### MH10.4: Tên C',
  '',
  '#### MH 2 — Tên D',
  '',
  '#### MH05-1: Tên E',
].join('\n');

test('scanDocScreens: MH nhận hậu tố chấm (WP11, nguyên nhân 2, Trang-chu.md thật) — MH6.1/MH6.2 là hai màn riêng, MH10.4 giữ nguyên; "MH 2" vẫn MH2; "MH05-1" (hậu tố gạch, WP9c) không hồi quy', () => {
  const found = scanDocScreens(MH_DOT_SUFFIX_MD);
  assert.deepEqual(
    found.map((f) => [f.code, f.name]),
    [
      ['MH6.1', 'Tên A'],
      ['MH6.2', 'Tên B'],
      ['MH10.4', 'Tên C'],
      ['MH2', 'Tên D'],
      ['MH05-1', 'Tên E'],
    ],
  );
});

// Nguyên nhân 3 — DÒNG BOLD: rút gọn từ Group-Chia-se-nhom.md /
// Web-Group-Chia-se-nhom-…md thật (16 màn khai bằng dòng bold đứng riêng,
// không heading MH nào — trang trắng màn trước WP11).
const BOLD_ONLY_MD = [
  '## 1/ Danh sách màn hình',
  '',
  '**MH1: Đăng nhập SSO**',
  '',
  'Mô tả ngắn cho MH1.',
  '',
  '**MH2: Đồng ý chia sẻ**',
  '',
  'Mô tả ngắn cho MH2.',
  '',
  '## 2/ Mô tả màn hình',
  '',
  'Nội dung khác không liên quan.',
].join('\n');

test('scanDocScreens: doc chỉ có bold-khai-màn (không heading MH nào) → vẫn nhận đủ màn (WP11, nguyên nhân 3)', () => {
  const found = scanDocScreens(BOLD_ONLY_MD);
  assert.deepEqual(
    found.map((f) => [f.code, f.name]),
    [
      ['MH1', 'Đăng nhập SSO'],
      ['MH2', 'Đồng ý chia sẻ'],
    ],
  );
});

test('findScreenSection: section của màn bold chạy từ dòng bold tới bold kế/heading kế (WP11)', () => {
  const s1 = findScreenSection(BOLD_ONLY_MD, 'MH1', 'Đăng nhập SSO');
  assert.ok(s1);
  assert.equal(s1!.heading, '**MH1: Đăng nhập SSO**');
  assert.ok(s1!.excerpt.includes('Mô tả ngắn cho MH1'));
  assert.ok(!s1!.excerpt.includes('MH2'));
  const s2 = findScreenSection(BOLD_ONLY_MD, 'MH2', 'Đồng ý chia sẻ');
  assert.ok(s2);
  assert.equal(s2!.heading, '**MH2: Đồng ý chia sẻ**');
  assert.ok(s2!.excerpt.includes('Mô tả ngắn cho MH2'));
  assert.ok(!s2!.excerpt.includes('Nội dung khác'));
});

const BOLD_IN_TABLE_MD = ['| Cột | Nội dung |', '| --- | --- |', '| 1 | **MH1: Không tính vì đứng trong bảng** |'].join('\n');

test('scanDocScreens: dòng bold trong ô bảng (bắt đầu "|") KHÔNG thành màn; "**Mục đích:** abc" (bold không phải mã màn) không thành màn (WP11)', () => {
  assert.deepEqual(scanDocScreens(BOLD_IN_TABLE_MD), []);
  assert.deepEqual(scanDocScreens('**Mục đích:** abc\n'), []);
});

// Nguyên nhân 4 — BẢNG DANH SÁCH MÀN HÌNH: rút gọn từ URD-Bao-cao-dinh-ky-…md
// thật (S01–S03 chỉ trong bảng, hàng rác "*(ngoài SocChat)*").
const TABLE_ONLY_MD = [
  '## 2. Màn hình',
  '',
  '### 2.1. Danh sách màn hình',
  '',
  '| Mã | Tên màn hình | Ghi chú |',
  '| --- | --- | --- |',
  '| S01 | Thread báo cáo | ghi chú 1 |',
  '| S02 | Thông báo đẩy | ghi chú 2 |',
  '| *(ngoài SocChat)* | Trang chi tiết ngoài | không tính |',
  '',
  '## 3. Khác',
].join('\n');

test('scanDocScreens: bảng "Danh sách màn hình" → mỗi hàng hợp lệ thành màn, hàng mã không hợp lệ bị bỏ (WP11, nguyên nhân 4)', () => {
  const found = scanDocScreens(TABLE_ONLY_MD);
  assert.deepEqual(
    found.map((f) => [f.code, f.name]),
    [
      ['S01', 'Thread báo cáo'],
      ['S02', 'Thông báo đẩy'],
    ],
  );
});

// Rút gọn từ Chinh-sua-anh-gui.md thật: MH05-1…MH05-6 có heading riêng,
// MH05-7 chỉ có trong bảng; hàng nhóm "**MH05**" phải bị bỏ.
const TABLE_GROUP_ROW_MD = [
  '#### MH01: Khung hội thoại',
  '',
  '#### MH05-1: Trình chỉnh sửa - Khung chung',
  '',
  '## 3. Danh sách màn hình',
  '',
  '### 3.1 Danh sách màn hình',
  '',
  '| Mã MH | Tên màn hình |',
  '| --- | --- |',
  '| MH01 | Khung hội thoại |',
  '| **MH05** | Trình chỉnh sửa ảnh |',
  '| MH05-1 | Trình chỉnh sửa - Khung chung |',
  '| MH05-2 | Nhiều ảnh |',
].join('\n');

test('scanDocScreens: bảng — hàng nhóm ("**MH05**") bị bỏ khi có MH05-1; màn đã có từ heading không bị bảng ghi đè (giữ section); màn chỉ-trong-bảng không có section nhưng vẫn vào danh sách (WP11, nguyên nhân 4)', () => {
  const found = scanDocScreens(TABLE_GROUP_ROW_MD);
  assert.deepEqual(found.map((f) => f.code), ['MH01', 'MH05-1', 'MH05-2']);
  assert.ok(!found.some((f) => f.code === 'MH05'), 'hàng nhóm "MH05" không được thành màn');
  assert.equal(found.find((f) => f.code === 'MH01')?.heading, '#### MH01: Khung hội thoại');
  assert.equal(findScreenSection(TABLE_GROUP_ROW_MD, 'MH05-2', 'Nhiều ảnh'), null);
});

// Blocklist tên mục (WP11, giết màn ma "X.Y Danh sách màn hình").
test('scanDocScreens: blocklist — "MH1: Danh sách màn hình" bị loại; "MH1: Danh sách danh bạ" được giữ (WP11)', () => {
  const md1 = ['#### MH1: Danh sách màn hình', '', '#### MH2: Trang chủ'].join('\n');
  assert.deepEqual(
    scanDocScreens(md1).map((f) => f.code),
    ['MH2'],
  );
  const md2 = '#### MH1: Danh sách danh bạ\n';
  assert.deepEqual(
    scanDocScreens(md2).map((f) => [f.code, f.name]),
    [['MH1', 'Danh sách danh bạ']],
  );
});

test('scanDocScreens: blocklist áp dụng cả fallback mã mục — "2.1 Danh sách màn hình" bị loại dù ancestor-hint đạt (WP11, luật 2 lượt)', () => {
  const md = ['## 2. Màn hình', '', '### 2.1 Danh sách màn hình', '', 'nội dung không có mã màn nào khác.'].join('\n');
  assert.deepEqual(scanDocScreens(md), []);
});

// WP11b (review độc lập wave 1, lỗi chặn): `boldLines` dùng cho biên section
// của một màn bold PHẢI chỉ gồm dòng bold-KHAI-MÀN (qua matchBoldScreenLine),
// không phải MỌI dòng bold đứng riêng (matchBoldLineText) — xem docblock trên
// findScreenSection. Doc dưới có một dòng "**Ghi chú:**" đứng riêng, TOÀN BỘ
// dòng in đậm (khớp matchBoldLineText — trước fix bị tính nhầm là biên section
// — nhưng KHÔNG khớp matchBoldScreenLine vì "Ghi chú:" không phải mã màn)
// chen giữa nội dung MH1 và màn bold kế MH2; sau đó một heading chen giữa
// MH2 và MH3 để khoá luôn việc heading vẫn cắt đúng biên (không bị fix này
// ảnh hưởng).
const BOLD_NOTE_BETWEEN_MD = [
  '**MH1: Đăng nhập**',
  '',
  'Dòng nội dung 1.',
  '',
  '**Ghi chú:**',
  '',
  'Một lưu ý chen giữa, không phải màn — dòng nội dung 2 sau ghi chú.',
  '',
  '**MH2: Trang chủ**',
  '',
  'Nội dung MH2 trước heading.',
  '',
  '## Heading chen giữa',
  '',
  'Nội dung dưới heading, không thuộc MH2.',
  '',
  '**MH3: Cài đặt**',
  '',
  'Nội dung MH3.',
].join('\n');

test('findScreenSection: dòng bold thường ("**Ghi chú:**") chen giữa KHÔNG cắt cụt section của màn bold — chạy qua tới màn bold kế; heading chen giữa vẫn cắt đúng tại heading (WP11b, bug review độc lập wave 1)', () => {
  const s1 = findScreenSection(BOLD_NOTE_BETWEEN_MD, 'MH1', 'Đăng nhập');
  assert.ok(s1);
  assert.equal(s1!.heading, '**MH1: Đăng nhập**');
  assert.ok(s1!.excerpt.includes('Dòng nội dung 1'));
  assert.ok(s1!.excerpt.includes('Ghi chú'), 'section phải CHẠY QUA dòng Ghi chú, không dừng ở đó');
  assert.ok(s1!.excerpt.includes('dòng nội dung 2 sau ghi chú'), 'nội dung SAU dòng Ghi chú phải còn trong excerpt');
  assert.ok(!s1!.excerpt.includes('MH2'), 'section MH1 vẫn phải dừng đúng ở màn bold kế (MH2)');

  const s2 = findScreenSection(BOLD_NOTE_BETWEEN_MD, 'MH2', 'Trang chủ');
  assert.ok(s2);
  assert.equal(s2!.heading, '**MH2: Trang chủ**');
  assert.ok(s2!.excerpt.includes('Nội dung MH2 trước heading'));
  assert.ok(!s2!.excerpt.includes('không thuộc MH2'), 'heading chen giữa vẫn phải cắt đúng biên, không chạy sang MH3');
  assert.ok(!s2!.excerpt.includes('MH3'));
});

test('scanDocScreens: "### s01 Tên" (s thường) không phải mã hệ S (chữ hoa mới tính) → không là màn (WP11b)', () => {
  assert.deepEqual(scanDocScreens('### s01 Tên màn hình\n'), []);
});

test('scanDocScreens: doc có cả "### SCR-002 B" và "### S01 A" → 2 mã đúng, SCR không bị hệ mã S nuốt (WP11b)', () => {
  const md = ['### SCR-002 B', '', '### S01 A'].join('\n');
  assert.deepEqual(
    scanDocScreens(md).map((f) => [f.code, f.name]),
    [
      ['SCR-002', 'B'],
      ['S01', 'A'],
    ],
  );
});

test('scanDocScreens: 2 heading "Danh sách màn hình" lồng nhau cùng bao 1 bảng → mỗi mã chỉ vào danh sách đúng 1 lần (WP11b, dedupe theo mã giữ lần đầu)', () => {
  const md = [
    '## 2. Danh sách màn hình',
    '',
    '### 2.1 Danh sách màn hình',
    '',
    '| Mã | Tên màn hình |',
    '| --- | --- |',
    '| S01 | Trang chủ |',
    '| S02 | Cài đặt |',
  ].join('\n');
  assert.deepEqual(
    scanDocScreens(md).map((f) => [f.code, f.name]),
    [
      ['S01', 'Trang chủ'],
      ['S02', 'Cài đặt'],
    ],
  );
});

test('scanDocScreens: bảng dưới heading KHÔNG khớp trigger "danh sách màn hình" → 0 màn (WP11b)', () => {
  const md = ['## 2. Bảng dữ liệu', '', '| Mã | Tên màn hình |', '| --- | --- |', '| S01 | Trang chủ |'].join('\n');
  assert.deepEqual(scanDocScreens(md), []);
});

test('scanDocScreens: "**MH3.1: A +** **MH3.2: B**" (2 cặp ** trên một dòng) không khớp khuôn bold-khai-màn đơn → không màn nào (WP11b)', () => {
  assert.deepEqual(scanDocScreens('**MH3.1: A +** **MH3.2: B**\n'), []);
});

test('scanDocScreens + findScreenSection: bold "**MH1: Tên Bold**" và hàng bảng MH1 cùng trang → bold thắng, tên VÀ section lấy từ bold (WP11b)', () => {
  const md = ['**MH1: Tên Bold**', '', '## Danh sách màn hình', '', '| Mã | Tên màn hình |', '| --- | --- |', '| MH1 | Tên Bảng |'].join('\n');
  assert.deepEqual(
    scanDocScreens(md).map((f) => [f.code, f.name, f.heading]),
    [['MH1', 'Tên Bold', '**MH1: Tên Bold**']],
  );
  const section = findScreenSection(md, 'MH1', 'Tên Bold');
  assert.ok(section);
  assert.equal(section!.heading, '**MH1: Tên Bold**');
});

test('scanDocScreens: "#### MH 2.1 Tên" (khoảng trắng + hậu tố chấm cùng lúc) → MH2.1 (WP11b)', () => {
  assert.deepEqual(scanDocScreens('#### MH 2.1 Tên\n').map((f) => [f.code, f.name]), [['MH2.1', 'Tên']]);
});

const SSO_DOC_MD = [
  '---',
  'title: Đăng nhập SSO',
  '---',
  '',
  '## 3/ Luồng màn hình',
  '',
  '### 3.1/ Danh sách màn hình',
  '',
  '#### MH1: Đăng nhập SSO',
  '',
  '![](../attachments/mh1.png)',
  '',
  '#### MH2: Đồng ý chia sẻ dữ liệu cá nhân',
  '',
  '![](../attachments/mh2.png)',
  '',
  '#### MH3: Popup chia sẻ dữ liệu với bên thứ 3',
  '',
  '![](../attachments/mh3.png)',
  '',
  '### 3.2/ Mô tả màn hình',
  '',
  '#### MH1: Đăng nhập SSO',
  '',
  '| STT | Hạng mục | Kiểu hiển thị |',
  '| --- | --- | --- |',
  '| 1 | Nút Đăng nhập SSO | Button |',
].join('\n');

test('prepareScreenComponentInputs: dr-flow không gắn được màn nào → dựng danh sách màn TỪ TÀI LIỆU (heading MH), origin: "doc", section khớp heading, note nói rõ lý do', async () => {
  await mkdir(join(cwd, 'docs-feature'), { recursive: true });
  await writeFile(join(cwd, 'docs-feature', 'Dang-nhap-SSO.md'), SSO_DOC_MD, 'utf8');
  // Không có flows/index.json (dr-flow chưa gắn được màn nào, hoặc chưa chạy).
  const inputs = await prepareScreenComponentInputs(cwd, {
    pages: [{ mdPath: 'docs-feature/Dang-nhap-SSO.md', page: 'Đăng nhập SSO' }],
  });
  assert.equal(inputs.screens.length, 3);
  const [s1, s2, s3] = inputs.screens;
  assert.equal(s1!.key, 'Dang-nhap-SSO__MH1');
  assert.equal(s1!.name, 'Đăng nhập SSO');
  assert.equal(s1!.origin, 'doc');
  assert.equal(s1!.flowId, '');
  assert.equal(s1!.flowTitle, '');
  assert.equal(s1!.source, 'docs-feature/Dang-nhap-SSO.md');
  assert.deepEqual(s1!.steps, []);
  assert.deepEqual(s1!.navOut, []);
  assert.deepEqual(s1!.navIn, []);
  assert.deepEqual(s1!.findings, []);
  assert.equal(s1!.section?.heading, '#### MH1: Đăng nhập SSO');
  assert.equal(s2!.key, 'Dang-nhap-SSO__MH2');
  assert.equal(s2!.name, 'Đồng ý chia sẻ dữ liệu cá nhân');
  assert.equal(s3!.key, 'Dang-nhap-SSO__MH3');
  assert.equal(s3!.name, 'Popup chia sẻ dữ liệu với bên thứ 3');
  assert.match(inputs.note ?? '', /TỪ TÀI LIỆU/);
});

// ── WP9b: HỢP NHẤT thay vì "hoặc-là" (dự án "Đăng nhập SSO" thật: dr-flow
// chỉ gắn được MH1 — MH2/MH3 trỏ vào node chỉ có ở bản đề xuất, không bao
// giờ gắn được từ flow, dù tài liệu khai rõ). ───────────────────────────────

test('prepareScreenComponentInputs: HỢP NHẤT — flow gắn được 1/3 màn (MH1) → bổ sung MH2/MH3 từ tài liệu, MH1 giữ nguyên origin "flow" + steps, note nêu đúng số màn bổ sung', async () => {
  await mkdir(join(cwd, 'docs-feature'), { recursive: true });
  await writeFile(join(cwd, 'docs-feature', 'Dang-nhap-SSO.md'), SSO_DOC_MD, 'utf8');
  await mkdir(join(cwd, 'flows'), { recursive: true });
  await writeFile(
    join(cwd, 'flows', 'FLOW-sso.flowchart.json'),
    JSON.stringify({
      nodes: [
        { id: 'n0', type: 'start', label: 'Bắt đầu' },
        { id: 'n1', type: 'action', label: 'Đăng nhập SSO', screen: 'Dang-nhap-SSO__MH1' },
      ],
      edges: [{ from: 'n0', to: 'n1' }],
    }),
    'utf8',
  );
  await writeFile(
    join(cwd, 'flows', 'index.json'),
    JSON.stringify([
      {
        id: 'FLOW-sso',
        title: 'Đăng nhập SSO',
        source: 'docs-feature/Dang-nhap-SSO.md',
        kind: 'mermaid',
        screens: [{ key: 'Dang-nhap-SSO__MH1', name: 'Đăng nhập SSO' }],
        files: { flowchart: 'flows/FLOW-sso.flowchart.json' },
      },
    ]),
    'utf8',
  );

  const inputs = await prepareScreenComponentInputs(cwd, {
    pages: [{ mdPath: 'docs-feature/Dang-nhap-SSO.md', page: 'Đăng nhập SSO' }],
  });
  assert.equal(inputs.screens.length, 3);
  const [s1, s2, s3] = inputs.screens;
  assert.equal(s1!.key, 'Dang-nhap-SSO__MH1');
  assert.equal(s1!.origin, 'flow');
  assert.equal(s1!.flowId, 'FLOW-sso');
  assert.deepEqual(s1!.steps.map((x) => x.id), ['n1']);
  assert.equal(s2!.key, 'Dang-nhap-SSO__MH2');
  assert.equal(s2!.origin, 'doc');
  assert.equal(s2!.flowId, '');
  assert.equal(s3!.key, 'Dang-nhap-SSO__MH3');
  assert.equal(s3!.origin, 'doc');
  assert.match(inputs.note ?? '', /Bổ sung 2 màn/);
  assert.ok(inputs.note?.includes('Dang-nhap-SSO__MH2'));
  assert.ok(inputs.note?.includes('Dang-nhap-SSO__MH3'));
});

test('prepareScreenComponentInputs: flow đã khớp ĐỦ 9 màn với tài liệu (PRD SIM) → vẫn 9, không nhân đôi, không note bổ sung', async () => {
  const stem = 'PRD-Sim-du-lich';
  const codes = ['6.1.1', '6.2.1', '6.2.2', '6.3.1', '6.3.2', '6.4.1', '6.4.2', '6.4.3', '6.4.4'];
  await mkdir(join(cwd, 'docs-feature'), { recursive: true });
  await writeFile(join(cwd, 'docs-feature', `${stem}.md`), PRD_SIM_SECTION_MD, 'utf8');
  await mkdir(join(cwd, 'flows'), { recursive: true });
  await writeFile(
    join(cwd, 'flows', 'index.json'),
    JSON.stringify([
      {
        id: 'FLOW-prd',
        title: 'Mua SIM du lịch',
        source: `docs-feature/${stem}.md`,
        kind: 'mermaid',
        screens: codes.map((c) => ({ key: `${stem}__${c}`, name: c })),
        files: {},
      },
    ]),
    'utf8',
  );

  const inputs = await prepareScreenComponentInputs(cwd, {
    pages: [{ mdPath: `docs-feature/${stem}.md`, page: 'PRD SIM du lịch' }],
  });
  assert.equal(inputs.screens.length, 9);
  assert.equal(inputs.note, undefined);
  assert.ok(inputs.screens.every((s) => s.origin === 'flow'));
  assert.deepEqual(
    inputs.screens.map((s) => s.key),
    codes.map((c) => `${stem}__${c}`),
  );
});

// ── WP24a: mockups per màn — ảnh mockup thật (tồn tại trên đĩa) tìm trong
// khoảng dòng section, KHÔNG dùng để quyết bố cục/component ở lớp này (đó là
// việc của kickoff server.ts) — chỉ input builder trích đúng danh sách. ─────

const MOCKUP_PAGE_MD = [
  '# 3 PRD Mockup',
  '',
  '## 4. Màn hình',
  '',
  '### 4.1 SCR-010 Danh sách gói cước',
  '',
  '![a](attachments/scr-010-a.png) ![b](attachments/scr-010-b.png)',
  '',
  '| STT | Trường | Ảnh | Kiểu hiển thị |',
  '|---|---|---|---|',
  '| 1 | Card gói | ![c](attachments/scr-010-c.png) | Card |',
  '',
  '![missing](attachments/scr-010-missing.png)',
  '',
  '![dup](attachments/scr-010-a.png)',
  '',
  '![d](attachments/scr-010-d.png)',
  '![e](attachments/scr-010-e.png)',
  '![f](attachments/scr-010-f.png)',
  '![g](attachments/scr-010-g.png)',
  '',
  '### 4.2 SCR-011 Không có ảnh',
  '',
  'Màn này không có ảnh mockup nào cả.',
].join('\n');

test('prepareScreenComponentInputs: WP24a — mockups per màn: ảnh cụm 1 dòng + ảnh trong bảng đứng trước theo thứ tự, ref không tồn tại bị bỏ, ref trùng bị khử, cap 6; màn không ảnh → mockups vắng', async () => {
  await mkdir(join(cwd, 'docs-feature', 'attachments'), { recursive: true });
  for (const name of ['scr-010-a.png', 'scr-010-b.png', 'scr-010-c.png', 'scr-010-d.png', 'scr-010-e.png', 'scr-010-f.png', 'scr-010-g.png']) {
    await writeFile(join(cwd, 'docs-feature', 'attachments', name), 'x', 'utf8');
  }
  await writeFile(join(cwd, 'docs-feature', 'Mockup-Page.md'), MOCKUP_PAGE_MD, 'utf8');
  const inputs = await prepareScreenComponentInputs(cwd, {
    pages: [{ mdPath: 'docs-feature/Mockup-Page.md', page: 'Mockup Page' }],
  });
  const s010 = inputs.screens.find((s) => s.key === 'Mockup-Page__SCR-010');
  const s011 = inputs.screens.find((s) => s.key === 'Mockup-Page__SCR-011');
  assert.ok(s010);
  assert.ok(s011);
  assert.deepEqual(s010!.mockups, [
    'docs-feature/attachments/scr-010-a.png',
    'docs-feature/attachments/scr-010-b.png',
    'docs-feature/attachments/scr-010-c.png',
    'docs-feature/attachments/scr-010-d.png',
    'docs-feature/attachments/scr-010-e.png',
    'docs-feature/attachments/scr-010-f.png',
  ]);
  assert.ok(!s011!.mockups || s011!.mockups.length === 0);
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

// ── WP24a: schema 2.1 — elements[].content + doc.layoutSource. ─────────────

test('parseScreenComponentsDoc: WP24a — content hợp lệ giữ nguyên; khoá lạ trong content bị drop + warning; string 200 ký tự cắt còn 160; items 15 phần tử cắt còn 12; layoutSource giá trị lạ bị drop + warning; schema_version "2.0" (khai bởi agent) không content vẫn parse như cũ', () => {
  const longStr = 'x'.repeat(200);
  const items15 = Array.from({ length: 15 }, (_, i) => `item-${i}`);
  const raw = {
    schema_version: '2.0',
    key: KEY1,
    name: 'Chọn gói',
    flowId: 'FLOW-a',
    platform: 'mobile',
    source: null,
    elements: [
      {
        id: 'card',
        label: 'Gói cước',
        role: 'card',
        ds: null,
        confidence: 'high',
        provenance: 'text',
        content: { text: 'VN Traveler 79', secondary: '5GB/ngày · 7 ngày', value: '79.000đ', badge: '-21%', items: items15, weird: 'nope' },
      },
      {
        id: 'card2',
        label: 'Gói cước 2',
        role: 'card',
        ds: null,
        confidence: 'high',
        provenance: 'text',
        content: { text: longStr },
      },
      { id: 'card3', label: 'Gói cước 3', role: 'card', ds: null, confidence: 'high', provenance: 'text' },
    ],
    nav: [],
    layoutSource: 'not-a-real-value',
  };
  const r = parseScreenComponentsDoc(JSON.stringify(raw));
  assert.ok('doc' in r);
  // schema_version "2.0" khai bởi agent không làm hỏng gì — daemon luôn ghi
  // đúng phiên bản đang pin (SCREEN_COMPONENTS_SCHEMA_VERSION), bất kể agent
  // khai gì (tương thích ngược 2.0 → 2.1).
  assert.equal(r.doc.schema_version, SCREEN_COMPONENTS_SCHEMA_VERSION);
  assert.deepEqual(r.doc.elements[0]!.content, {
    text: 'VN Traveler 79',
    secondary: '5GB/ngày · 7 ngày',
    value: '79.000đ',
    badge: '-21%',
    items: items15.slice(0, 12),
  });
  assert.equal(r.doc.elements[1]!.content?.text?.length, 160);
  assert.equal(r.doc.elements[2]!.content, undefined);
  assert.equal(r.doc.layoutSource, undefined);
  assert.ok(r.doc.warnings?.some((w) => w.includes('khoá lạ "weird"')));
  assert.ok(r.doc.warnings?.some((w) => w.includes('layoutSource')));
});

test('mergeScreenComponents: WP24a — doc có layoutSource → index entry có layoutSource', () => {
  const inputs = {
    schema_version: SCREEN_COMPONENTS_SCHEMA_VERSION,
    generatedAt: 'g',
    ds: { components: true, catalog: false, rules: false, examples: false, figmaCatalog: false },
    screens: [
      { key: KEY1, name: 'Chọn quốc gia', order: 0, flowId: 'FLOW-a', flowTitle: 't', source: 'x.md', steps: [], navOut: [], navIn: [], findings: [], platformHint: 'mobile' },
    ],
  } as unknown as ScreenComponentsInputs;
  const d1 = parseScreenComponentsDoc(JSON.stringify(GOOD_DOC));
  assert.ok('doc' in d1);
  const docWithLayout = { ...d1.doc, layoutSource: 'doc-image' as const };
  const { index } = mergeScreenComponents([docWithLayout], inputs, [], '2026-08-21T00:00:00Z');
  assert.equal(index.screens[0]!.layoutSource, 'doc-image');
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
  // WP24a: bump schema_version '2.0' → '2.1' (mockups/content/layoutSource);
  // GOOD_DOC ở trên khai "2.0" NGUYÊN — kiểm tra ngầm parse vẫn chấp nhận
  // (parseScreenComponentsDoc không đọc schema_version của agent, luôn ghi
  // đúng phiên bản daemon đang pin).
  assert.equal(index.schema_version, '2.1');
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

test('resolveCatalogEntry: tên đúng / theo anchor / theo tên gốc duy nhất; trùng tên không anchor → ambiguous; lạ → unknown', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  assert.deepEqual(resolveCatalogEntry(catalog, 'Button'), { component: 'Button', anchor: 'button' });
  assert.deepEqual(resolveCatalogEntry(catalog, 'Button', 'btn'), { component: 'Button', anchor: 'button', note: 'anchor "btn" sửa thành "button" (anchor của "Button")' });
  const byAnchor = resolveCatalogEntry(catalog, 'Heading', 'figma-bbb');
  assert.ok('component' in byAnchor && byAnchor.component === 'Heading — [SDK] Web Lib (Slot) (30:704)' && byAnchor.anchor === 'figma-bbb');
  const byBase = resolveCatalogEntry(catalog, 'text-field-simple');
  assert.ok('component' in byBase && byBase.component === 'Text Field Simple' && byBase.anchor === 'figma-ccc');
  const amb = resolveCatalogEntry(catalog, 'Heading');
  assert.ok('reason' in amb && amb.reason === 'ambiguous' && amb.candidates.length === 2);
  const unk = resolveCatalogEntry(catalog, 'Combobox');
  assert.ok('reason' in unk && unk.reason === 'unknown');
});

test('normalizeRoleMap: component lạ/ambiguous hạ về null + fallback + warning, không lỗi; chỉ roles rỗng mới lỗi', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const parsed = parseRoleMap(
    JSON.stringify({
      platform: 'mobile',
      roles: [
        { role: 'section-heading', component: 'Heading' },
        { role: 'title', component: 'Heading', anchor: 'figma-aaa' },
        { role: 'primary-cta', component: 'button', anchor: 'button' },
        { role: 'x', component: 'Combobox', anchor: 'combobox' },
      ],
    }),
  );
  assert.ok('doc' in parsed);
  const norm = normalizeRoleMap(parsed.doc, catalog);
  assert.deepEqual(norm.errors, []);
  assert.equal(norm.doc.roles[0]!.component, null);
  assert.match(norm.doc.roles[0]!.fallback ?? '', /Heading/);
  assert.equal(norm.doc.roles[0]!.anchor, undefined);
  assert.equal(norm.doc.roles[1]!.component, 'Heading — [SDK] Web Lib (Slot) (2548:10828)');
  assert.equal(norm.doc.roles[2]!.component, 'Button');
  assert.equal(norm.doc.roles[3]!.component, null);
  assert.equal(norm.warnings.length, 4);
  assert.deepEqual(norm.doc.warnings, norm.warnings);
  // Không có DS → mọi component về null.
  const noDs = normalizeRoleMap(parsed.doc, new Map());
  assert.ok(noDs.doc.roles.every((r) => r.component === null));
});

test('normalizeScreenComponentsDoc: lỗi cứng chỉ khi key sai / thiếu wireframe / có <script>; còn lại chuẩn hoá + warnings', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const ctx = { expectedKey: KEY1, screenKeys: new Set([KEY1, KEY2]), catalog };
  const good = parseScreenComponentsDoc(JSON.stringify(GOOD_DOC));
  assert.ok('doc' in good);
  const clean = normalizeScreenComponentsDoc(good.doc, { ...ctx, wireframeHtml: wireframe() });
  assert.deepEqual(clean.errors, []);
  assert.deepEqual(clean.warnings, []);
  assert.equal(clean.doc.warnings, undefined);
  assert.equal(clean.wireframeHtml, wireframe());

  const hard = normalizeScreenComponentsDoc({ ...good.doc, key: 'X__1' }, { ...ctx, wireframeHtml: wireframe({ script: true }) });
  assert.equal(hard.errors.length, 2);
  assert.ok(normalizeScreenComponentsDoc(good.doc, { ...ctx, wireframeHtml: null }).errors.length === 1);

  const messy = parseScreenComponentsDoc(
    JSON.stringify({
      ...GOOD_DOC,
      elements: [
        { id: 'appbar', label: 'A', role: 'app-bar', ds: { component: 'Heading', anchor: 'figma-aaa' }, confidence: 'high', provenance: 'ds' },
        { id: 'list', label: 'L', role: 'r', ds: { component: 'Combobox', anchor: 'combobox' }, confidence: 'high', provenance: 'text', why: 'tài liệu đòi' },
        { id: 'cta', label: 'C', role: 'r', ds: { component: 'Button', anchor: 'btn' }, confidence: 'high', provenance: 'flow' },
        { id: 'empty', label: 'E', role: 'r', ds: null, confidence: 'low', provenance: 'ds' },
      ],
      nav: [{ el: 'cta', to: KEY2 }, { el: 'list', to: 'NOPE__1' }],
    }),
  );
  assert.ok('doc' in messy);
  const html = wireframe({ screen: 'wrong', layout: 'web', extra: '<div class="wf-component" data-el="ghost" data-comp="combobox" data-nav="NOPE__1">g</div>' })
    .replace('data-comp="top-app-bar"', 'data-comp="figma-aaa"')
    .replace('data-comp="list-item"', 'data-comp="combobox"')
    .replace('data-comp="button"', 'data-comp="btn"')
    .replace('<!doctype html>\n', '');
  const r = normalizeScreenComponentsDoc(messy.doc, { ...ctx, wireframeHtml: html });
  assert.deepEqual(r.errors, []);
  assert.equal(r.doc.elements[0]!.ds?.component, 'Heading — [SDK] Web Lib (Slot) (2548:10828)');
  assert.equal(r.doc.elements[1]!.ds, null);
  assert.equal(r.doc.elements[1]!.confidence, 'low');
  assert.match(r.doc.elements[1]!.why ?? '', /^Đề xuất "Combobox" không có trong danh mục DS\. tài liệu đòi$/);
  assert.deepEqual(r.doc.elements[2]!.ds, { component: 'Button', anchor: 'button' });
  assert.deepEqual(r.doc.nav, [{ el: 'cta', to: KEY2 }]);
  const out = r.wireframeHtml!;
  assert.ok(/^<!doctype html>/i.test(out));
  assert.ok(out.includes(`data-screen="${KEY1}"`));
  assert.ok(out.includes('data-layout="mobile"'));
  assert.ok(!out.includes('data-comp="combobox"'));
  assert.ok(!out.includes('data-comp="btn"'));
  assert.ok(out.includes('data-comp="button"'));
  assert.ok(!out.includes('data-nav="NOPE__1"'));
  assert.ok(out.includes(`data-nav="${KEY2}"`));
  assert.ok(r.warnings.some((w) => w.includes('data-el không có trong elements[]: ghost')));
  assert.ok(r.warnings.some((w) => w.includes('doctype')));
  assert.deepEqual(r.doc.warnings, r.warnings);
});

test('WP32c: inferred provenance/confidence/evidence đi từ flows/index vào ScreenInput và parser screen manifest giữ metadata optional', async () => {
  await mkdir(join(cwd, 'flows', 'FLOW-recovered'), { recursive: true });
  await mkdir(join(cwd, 'docs'), { recursive: true });
  await writeFile(join(cwd, 'docs', 'prd.md'), '# Tài liệu\n\nNgười dùng xác nhận giao dịch.\n', 'utf8');
  await writeFile(
    join(cwd, 'flows', 'index.json'),
    JSON.stringify([
      {
        id: 'FLOW-recovered',
        title: 'Luồng phục hồi',
        source: 'docs/prd.md',
        kind: 'mermaid',
        screens: [
          {
            key: 'prd__AUTO-ab12',
            name: 'Xác nhận giao dịch',
            provenance: 'inferred-flow',
            confidence: 0.82,
            evidence: {
              source: 'docs/prd.md',
              diagramEvidence: [{ cellId: 'confirm', label: 'Xác nhận giao dịch' }],
            },
          },
        ],
      },
    ]),
    'utf8',
  );

  const inputs = await prepareScreenComponentInputs(cwd, { pages: [{ mdPath: 'docs/prd.md', page: 'PRD' }] });
  assert.equal(inputs.screens.length, 1);
  assert.equal(inputs.screens[0]!.provenance, 'inferred-flow');
  assert.equal(inputs.screens[0]!.confidence, 0.82);
  assert.deepEqual(inputs.screens[0]!.evidence, {
    source: 'docs/prd.md',
    diagramEvidence: [{ cellId: 'confirm', label: 'Xác nhận giao dịch' }],
  });

  const parsed = parseScreenComponentsDoc(
    JSON.stringify({
      ...GOOD_DOC,
      provenance: 'inferred-flow',
      confidence: 0.82,
      evidence: { source: 'docs/prd.md', anchorText: 'Người dùng xác nhận giao dịch.' },
    }),
  );
  assert.ok('doc' in parsed);
  assert.equal(parsed.doc.provenance, 'inferred-flow');
  assert.equal(parsed.doc.confidence, 0.82);
  assert.deepEqual(parsed.doc.evidence, {
    source: 'docs/prd.md',
    anchorText: 'Người dùng xác nhận giao dịch.',
  });

  const legacy = parseScreenComponentsDoc(JSON.stringify(GOOD_DOC));
  assert.ok('doc' in legacy);
  assert.equal(legacy.doc.provenance, undefined);
  assert.equal(legacy.doc.confidence, undefined);
  assert.equal(legacy.doc.evidence, undefined);

  const merged = mergeScreenComponents([parsed.doc], inputs, [], '2026-08-25T00:00:00Z');
  assert.equal(merged.index.screens[0]!.provenance, 'inferred-flow');
  assert.equal(merged.index.screens[0]!.confidence, 0.82);
  assert.deepEqual(merged.index.screens[0]!.evidence, {
    source: 'docs/prd.md',
    anchorText: 'Người dùng xác nhận giao dịch.',
  });
});

// ── WP dr-mockup-layouts (2026-08-27): opts.layoutKb → archetype + layoutRefs
// từ ~/layout-kb (env LAYOUT_KB_DIR). KB GIẢ trong tmp; mặc định tắt phải giữ
// output byte-identical.

async function seedFakeLayoutKb(root: string): Promise<void> {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  await mkdir(join(root, 'wireframes'), { recursive: true });
  await writeFile(join(root, 'wireframes', '1.png'), png);
  await writeFile(join(root, 'wireframes', '2.png'), png);
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      source: 'enrico',
      license: 'MIT',
      builtAt: '2026-08-27T00:00:00.000Z',
      topics: {
        list: {
          count: 10,
          templates: [{ id: 'list-appbar-search-list-fab', bands: ['appbar', 'search', 'list(5)', 'fab'], sketch: 'S', samples: ['1'] }],
          samples: [{ id: '1', wireframe: 'wireframes/1.png', bands: ['appbar', 'search', 'list(5)', 'fab'] }],
        },
        search: {
          count: 3,
          templates: [{ id: 'search-appbar-search-list', bands: ['appbar', 'search', 'list(4)'], sketch: 'T', samples: ['2'] }],
          samples: [{ id: '2', wireframe: 'wireframes/2.png', bands: ['appbar', 'search', 'list(4)'] }],
        },
      },
    }),
    'utf8',
  );
}

/** Bỏ field phụ thuộc thời gian để so byte. */
const stableJson = (raw: string) => raw.replace(/"generatedAt": "[^"]+"/, '"generatedAt": "T"');

test('prepareScreenComponentInputs: layoutKb:true + KB giả → archetype + layoutRefs đúng, inputs.layoutKb có dir/topics', async () => {
  await seedFlowRun();
  const kbDir = await mkdtemp(join(tmpdir(), 'od-layout-kb-'));
  const saved = process.env.LAYOUT_KB_DIR;
  process.env.LAYOUT_KB_DIR = kbDir;
  try {
    await seedFakeLayoutKb(kbDir);
    const pages = [{ mdPath: 'docs-feature/2.1-PRD-Mua-SIM.md', page: '2.1 PRD Mua SIM' }];
    const inputs = await prepareScreenComponentInputs(cwd, { pages, outFile: 'mockups/_inputs.json', excludeRemovedByProposal: true, layoutKb: true });
    assert.deepEqual(inputs.layoutKb, { dir: kbDir, source: 'enrico', builtAt: '2026-08-27T00:00:00.000Z', topics: 2 });
    const s1 = inputs.screens.find((s) => s.key === KEY1)!;
    const s2 = inputs.screens.find((s) => s.key === KEY2)!;
    // "Chọn quốc gia" / "Chọn gói cước" → picker (topics list, search, menu → KB có list + search).
    assert.deepEqual(s1.archetype, { id: 'picker', confidence: 'high' });
    assert.deepEqual(s2.archetype, { id: 'picker', confidence: 'high' });
    assert.deepEqual(s1.layoutRefs?.topics, ['list', 'search']);
    assert.deepEqual(s1.layoutRefs?.templates.map((t) => t.id), ['list-appbar-search-list-fab', 'search-appbar-search-list']);
    assert.deepEqual(s1.layoutRefs?.images, [join(kbDir, 'wireframes', '1.png'), join(kbDir, 'wireframes', '2.png')]);
    // Field cũ không đổi.
    assert.equal(s1.section?.heading, '### 4.1 SCR-001 Chọn quốc gia');
    assert.deepEqual(s1.navOut, [{ to: KEY2, via: 'Chọn quốc gia', condition: 'Có' }]);
    const onDisk = JSON.parse(await readFile(join(cwd, 'mockups', '_inputs.json'), 'utf8')) as ScreenComponentsInputs;
    assert.equal(onDisk.layoutKb?.topics, 2);
    assert.equal(onDisk.screens[0]!.layoutRefs?.images.length, 2);
  } finally {
    if (saved === undefined) delete process.env.LAYOUT_KB_DIR;
    else process.env.LAYOUT_KB_DIR = saved;
    await rm(kbDir, { recursive: true, force: true });
  }
});

test('prepareScreenComponentInputs: layoutKb:true nhưng KB vắng → layoutKb: null + note, vẫn có archetype, không layoutRefs', async () => {
  await seedFlowRun();
  const empty = await mkdtemp(join(tmpdir(), 'od-layout-kb-empty-'));
  const saved = process.env.LAYOUT_KB_DIR;
  process.env.LAYOUT_KB_DIR = empty;
  try {
    const pages = [{ mdPath: 'docs-feature/2.1-PRD-Mua-SIM.md', page: '2.1 PRD Mua SIM' }];
    const inputs = await prepareScreenComponentInputs(cwd, { pages, outFile: 'mockups/_inputs.json', layoutKb: true });
    assert.equal(inputs.layoutKb, null);
    assert.match(inputs.note ?? '', /layout-kb/);
    for (const s of inputs.screens) {
      assert.ok(s.archetype, s.key);
      assert.equal(s.layoutRefs, undefined);
    }
    // KB vắng + không màn → note "dr-flow" cũ giữ nguyên (server ném note làm lỗi kickoff).
    await rm(join(cwd, 'flows'), { recursive: true, force: true });
    const none = await prepareScreenComponentInputs(cwd, { pages: [], layoutKb: true });
    assert.equal(none.layoutKb, null);
    assert.match(none.note ?? '', /dr-flow/);
    assert.doesNotMatch(none.note ?? '', /layout-kb/);
  } finally {
    if (saved === undefined) delete process.env.LAYOUT_KB_DIR;
    else process.env.LAYOUT_KB_DIR = saved;
    await rm(empty, { recursive: true, force: true });
  }
});

test('prepareScreenComponentInputs: layoutKb mặc định (false) → output byte-identical, không archetype/layoutRefs/layoutKb dù KB có', async () => {
  await seedFlowRun();
  const kbDir = await mkdtemp(join(tmpdir(), 'od-layout-kb-'));
  const saved = process.env.LAYOUT_KB_DIR;
  process.env.LAYOUT_KB_DIR = kbDir;
  try {
    await seedFakeLayoutKb(kbDir);
    const pages = [{ mdPath: 'docs-feature/2.1-PRD-Mua-SIM.md', page: '2.1 PRD Mua SIM' }];
    await prepareScreenComponentInputs(cwd, { pages });
    const a = stableJson(await readFile(join(cwd, SCREEN_INPUTS_FILE), 'utf8'));
    await prepareScreenComponentInputs(cwd, { pages, layoutKb: false });
    const b = stableJson(await readFile(join(cwd, SCREEN_INPUTS_FILE), 'utf8'));
    assert.equal(a, b);
    assert.ok(!a.includes('"archetype"') && !a.includes('"layoutRefs"') && !a.includes('"layoutKb"'));
  } finally {
    if (saved === undefined) delete process.env.LAYOUT_KB_DIR;
    else process.env.LAYOUT_KB_DIR = saved;
    await rm(kbDir, { recursive: true, force: true });
  }
});
