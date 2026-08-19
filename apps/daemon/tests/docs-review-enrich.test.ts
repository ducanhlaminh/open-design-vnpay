import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  findMermaidFence,
  replaceDiagramInSlice,
  mapScreensToSections,
  parseCatalogue,
  renderCompositionDraft,
  buildEnrichKickoff,
} from '../src/docs-review-enrich.js';
import { splitSections, validateChanges } from '../src/docs-review.js';
import { SCREEN_COMPONENTS_SCHEMA_VERSION, type ScreenComponentsDoc, type RoleMapDoc } from '../src/screen-components.js';

/* ── fixtures rút gọn từ dự án mẫu (2-1-prd-detail-mua-sim-du-lich) ───────── */

const AS_IS_MMD = [
  'flowchart TD',
  '    A([Bắt đầu]) --> B[Chọn Mua SIM]',
  '    B --> C_Type{Loại SIM du lịch?}',
  '    C_Type -- "Quốc tế" --> C[Tìm kiếm]',
].join('\n');

const PROPOSED_MMD = [
  'flowchart TD',
  '    A([Bắt đầu]) --> B[Chọn Mua SIM]',
  '    B --> C_Type{Loại SIM du lịch?}',
  '    C_Type -- "Quốc tế" --> C[Tìm kiếm]',
  '    %% ĐỀ XUẤT: thêm nhánh thử lại',
  '    C --> D_Retry[Thử lại]',
].join('\n');

const SLICE_WITH_DIAGRAM = [
  '### 3.1 Luồng sơ đồ',
  '',
  '![flow-diagram Luồng người dùng](../../attachments/flow.svg)',
  '',
  '```mermaid',
  ...AS_IS_MMD.split('\n'),
  '```',
  '',
  '*flow-diagram — sơ đồ Mermaid "Luồng người dùng"; nguồn: [flow.mmd](../../attachments/flow.mmd)*',
  '',
  '### 3.2 Mô tả',
  '',
  'Bảng mô tả từng bước.',
  '',
].join('\n');

/* ── (1)+(2) findMermaidFence / replaceDiagramInSlice ─────────────────────── */

test('findMermaidFence tìm đúng fence có thân khớp as-is.mmd', () => {
  const found = findMermaidFence(SLICE_WITH_DIAGRAM, AS_IS_MMD);
  assert.ok(found);
  const lines = SLICE_WITH_DIAGRAM.split('\n');
  assert.equal(lines[found!.start], '```mermaid');
  assert.equal(lines[found!.end], '```');
});

test('findMermaidFence trả null khi as-is không khớp bất kỳ fence nào', () => {
  const found = findMermaidFence(SLICE_WITH_DIAGRAM, 'flowchart TD\n    X --> Y');
  assert.equal(found, null);
});

test('findMermaidFence trả null khi slice không có fence mermaid nào', () => {
  const found = findMermaidFence('Chỉ có chữ, không có sơ đồ.', AS_IS_MMD);
  assert.equal(found, null);
});

test('replaceDiagramInSlice thay đúng fence + caption, giữ nguyên phần khác, và validateChanges không lỗi', () => {
  const result = replaceDiagramInSlice(SLICE_WITH_DIAGRAM, {
    asIsMmd: AS_IS_MMD,
    proposedMmd: PROPOSED_MMD,
    flowId: 'FLOW-3-1-luong-so-do',
    uxReview: { verdict: 'needs-improvement', summary: 'Thiếu nhánh thử lại khi thất bại.' },
  });
  assert.ok(result);
  const { text, change } = result!;

  // Phần trước/sau fence không đổi.
  assert.ok(text.includes('### 3.1 Luồng sơ đồ'));
  assert.ok(text.includes('![flow-diagram Luồng người dùng](../../attachments/flow.svg)'));
  assert.ok(text.includes('### 3.2 Mô tả'));
  assert.ok(text.includes('Bảng mô tả từng bước.'));

  // Fence mới chứa nội dung proposed, không còn nội dung as-is riêng (D_Retry mới).
  assert.ok(text.includes('D_Retry[Thử lại]'));
  // Caption mới đúng khuôn, giữ lại "nguồn gốc" từ caption cũ.
  assert.ok(
    text.includes(
      '*flow-diagram — sơ đồ ĐỀ XUẤT sau rà soát UX (nguồn gốc: [flow.mmd](../../attachments/flow.mmd); đề xuất: flows/FLOW-3-1-luong-so-do/proposed.mmd)*',
    ),
  );
  assert.ok(!text.includes('sơ đồ Mermaid "Luồng người dùng"'));

  // change mang đúng shape DocChange của WP1.
  assert.equal(change.kind, 'flow-diagram');
  assert.equal(change.origin, 'system');
  assert.equal(change.severity, 'major'); // verdict needs-improvement → major
  assert.equal(change.rule_id, 'flows/FLOW-3-1-luong-so-do/ux-review.json');
  assert.equal(change.id, 'sys-flow-diagram-FLOW-3-1-luong-so-do');
  assert.ok(change.before && change.before.includes('```mermaid'));
  assert.ok(change.quote && change.quote.includes('D_Retry[Thử lại]'));
  // before/quote NGUYÊN VĂN — before khớp đúng đoạn cũ trong slice gốc, quote khớp đúng đoạn mới.
  assert.ok(SLICE_WITH_DIAGRAM.includes(change.before!));
  assert.ok(text.includes(change.quote!));

  const errors = validateChanges(SLICE_WITH_DIAGRAM, text, [change]);
  assert.deepEqual(errors, []);
});

test('replaceDiagramInSlice: verdict khác needs-improvement/fail → severity minor', () => {
  const result = replaceDiagramInSlice(SLICE_WITH_DIAGRAM, {
    asIsMmd: AS_IS_MMD,
    proposedMmd: PROPOSED_MMD,
    flowId: 'FLOW-x',
    uxReview: { verdict: 'good' },
  });
  assert.equal(result?.change.severity, 'minor');
  assert.equal(result?.change.reason, 'Thay sơ đồ luồng bằng bản đề xuất sau rà soát UX.');
});

test('replaceDiagramInSlice trả null khi as-is không khớp fence trong slice', () => {
  const result = replaceDiagramInSlice(SLICE_WITH_DIAGRAM, {
    asIsMmd: 'flowchart TD\n    Z --> W',
    proposedMmd: PROPOSED_MMD,
    flowId: 'FLOW-3-1-luong-so-do',
    uxReview: {},
  });
  assert.equal(result, null);
});

/* ── (3) mapScreensToSections ──────────────────────────────────────────────── */

const SAMPLE_PAGE = [
  '# 2.1. PRD Detail Mua SIM du lịch', // 1
  '', // 2
  '### 6.1. Màn trang chủ', // 3
  '', // 4
  '#### 6.1.1 Màn hình trang chủ ', // 5
  '', // 6
  '![](../a/img1.png)![](../a/img2.png)', // 7
  '', // 8
  '| Tên trường | Mô tả |', // 9
  '| --- | --- |', // 10
  '| A | B |', // 11
  '', // 12
  '### 6.1.10 Màn hình phụ khác', // 13 — KHÔNG được khớp code "6.1.1"
  '', // 14
  '| X | Y |', // 15
  '', // 16
  '### 6.2.1. Màn hình chọn Quốc gia & Khu vực ', // 17 — không có ảnh ngay sau
  '', // 18
  '| Thao tác | Màn hình |', // 19
  '| --- | --- | ', // 20
  '', // 21
  '### 6.3.2. Chi tiết gói cước Việt Nam (mô tả tương tự phần 6.2.3. ở trên)', // 22
  '', // 23
  '6.2.3. Màn hình Chi tiết gói cước', // 24 — dòng THƯỜNG, không phải heading
  '', // 25
  '![](../a/img3.png)', // 26
  '', // 27
  '| Tên trường | Mô tả |', // 28
  '| --- | --- |', // 29
].join('\n');

test('mapScreensToSections: heading khớp đúng, không lẫn 6.1.1 với 6.1.10', () => {
  const sections = splitSections(SAMPLE_PAGE, { minLines: 1 });
  const pageLines = SAMPLE_PAGE.split('\n');
  const { placed, unplaced } = mapScreensToSections(sections, pageLines, ['PAGE__6.1.1']);
  assert.deepEqual(unplaced, []);
  const all = [...placed.values()].flat();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.code, '6.1.1');
  // insertAfterLine phải là dòng cuối cụm ảnh (dòng 7), không phải dòng heading (5).
  assert.equal(all[0]!.insertAfterLine, 7);
});

test('mapScreensToSections: không có ảnh ngay sau heading → insertAfterLine = chính dòng heading', () => {
  const sections = splitSections(SAMPLE_PAGE, { minLines: 1 });
  const pageLines = SAMPLE_PAGE.split('\n');
  const { placed, unplaced } = mapScreensToSections(sections, pageLines, ['PAGE__6.2.1']);
  assert.deepEqual(unplaced, []);
  const all = [...placed.values()].flat();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.insertAfterLine, 17);
});

test('mapScreensToSections: fallback dòng thường (6.2.3 không phải heading), không bị 6.3.2 nuốt mất', () => {
  const sections = splitSections(SAMPLE_PAGE, { minLines: 1 });
  const pageLines = SAMPLE_PAGE.split('\n');
  const { placed, unplaced } = mapScreensToSections(sections, pageLines, ['PAGE__6.2.3']);
  assert.deepEqual(unplaced, []);
  const all = [...placed.values()].flat();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.insertAfterLine, 26); // dòng cuối cụm ảnh sau dòng thường 6.2.3 (dòng 24)
});

test('mapScreensToSections: key không định vị được → unplaced', () => {
  const sections = splitSections(SAMPLE_PAGE, { minLines: 1 });
  const pageLines = SAMPLE_PAGE.split('\n');
  const { placed, unplaced } = mapScreensToSections(sections, pageLines, ['PAGE__9.9.9']);
  assert.deepEqual(unplaced, ['PAGE__9.9.9']);
  assert.equal(placed.size, 0);
});

test('mapScreensToSections: key không có "__" → unplaced (không throw)', () => {
  const sections = splitSections(SAMPLE_PAGE, { minLines: 1 });
  const pageLines = SAMPLE_PAGE.split('\n');
  const { unplaced } = mapScreensToSections(sections, pageLines, ['khong-co-dau-gach-doi']);
  assert.deepEqual(unplaced, ['khong-co-dau-gach-doi']);
});

/* ── (3b) mapScreensToSections / computeInsertAfterLine: ảnh nằm TRONG bảng
 *  mockup, thứ tự heading đảo ngược (6.1.10 trước 6.1.1), fenced code block ── */

const SAMPLE_PAGE_MOCKUP_TABLE = [
  '# Trang mẫu bảng mockup', // 1
  '', // 2
  '### 7.1 Màn hình Mockup Bảng', // 3
  '', // 4
  '| Loại | Màn hình |', // 5
  '|---|---|', // 6
  '| App | ![](a.png) |', // 7 — hàng duy nhất có ảnh, bảng vẫn được nuốt trọn
  '', // 8
  '| Field | Mô tả |', // 9 — bảng field KHÔNG có ảnh — KHÔNG được nuốt
  '| --- | --- |', // 10
  '| X | Y |', // 11
  '', // 12
  '### 7.2 Màn hình Không Có Ảnh', // 13
  '', // 14
  '| Field | Mô tả |', // 15 — bảng field ngay sau heading, không ảnh
  '| --- | --- |', // 16
  '', // 17
].join('\n');

test('mapScreensToSections: ảnh nằm TRONG hàng của bảng mockup → insertAfterLine dừng ở hàng cuối bảng mockup, không nuốt bảng field kế tiếp', () => {
  const sections = splitSections(SAMPLE_PAGE_MOCKUP_TABLE, { minLines: 1 });
  const pageLines = SAMPLE_PAGE_MOCKUP_TABLE.split('\n');
  const { placed, unplaced } = mapScreensToSections(sections, pageLines, ['PAGE__7.1']);
  assert.deepEqual(unplaced, []);
  const all = [...placed.values()].flat();
  assert.equal(all.length, 1);
  // Dòng "| App | ![](a.png) |" (7) — không phải dòng heading (3) và không
  // nuốt luôn bảng field bên dưới (9-11).
  assert.equal(all[0]!.insertAfterLine, 7);
});

test('mapScreensToSections: heading rồi bảng field ngay (không có ảnh ở bất kỳ hàng nào) → insertAfterLine = chính dòng heading', () => {
  const sections = splitSections(SAMPLE_PAGE_MOCKUP_TABLE, { minLines: 1 });
  const pageLines = SAMPLE_PAGE_MOCKUP_TABLE.split('\n');
  const { placed, unplaced } = mapScreensToSections(sections, pageLines, ['PAGE__7.2']);
  assert.deepEqual(unplaced, []);
  const all = [...placed.values()].flat();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.insertAfterLine, 13);
});

const SAMPLE_PAGE_HEADING_ORDER_REVERSED = [
  '# Trang mẫu thứ tự heading đảo ngược', // 1
  '', // 2
  '#### 6.1.10 Màn hình phụ khác', // 3 — đứng TRƯỚC 6.1.1, không được nuốt nhầm
  '', // 4
  '| X | Y |', // 5
  '', // 6
  '#### 6.1.1 Màn hình trang chủ', // 7
  '', // 8
  '![](../a/img1.png)', // 9
  '', // 10
].join('\n');

test('mapScreensToSections: 6.1.10 đứng TRƯỚC 6.1.1 trong tài liệu → 6.1.1 vẫn gắn đúng heading + section của chính nó (không phải của 6.1.10)', () => {
  const sections = splitSections(SAMPLE_PAGE_HEADING_ORDER_REVERSED, { minLines: 1 });
  const pageLines = SAMPLE_PAGE_HEADING_ORDER_REVERSED.split('\n');
  const { placed, unplaced } = mapScreensToSections(sections, pageLines, ['PAGE__6.1.1']);
  assert.deepEqual(unplaced, []);
  const entries = [...placed.entries()];
  assert.equal(entries.length, 1);
  const [sectionIndex, arr] = entries[0]!;
  assert.equal(arr.length, 1);
  assert.equal(arr[0]!.code, '6.1.1');
  assert.equal(arr[0]!.insertAfterLine, 9); // dòng ảnh ngay sau heading 6.1.1 (dòng 7), không phải bảng của 6.1.10

  // sectionIndex phải là section CHỨA heading 6.1.1 (dòng 7), không phải
  // section chứa heading 6.1.10 (dòng 3) — khoá cả sectionIndex, không chỉ insertAfterLine.
  const sectionOf611 = sections.find((s) => 7 >= s.startLine && 7 <= s.endLine);
  const sectionOf6110 = sections.find((s) => 3 >= s.startLine && 3 <= s.endLine);
  assert.ok(sectionOf611);
  assert.equal(sectionIndex, sectionOf611!.index);
  if (sectionOf6110) assert.notEqual(sectionIndex, sectionOf6110.index);
});

const SAMPLE_PAGE_FENCED_CODE = [
  '# Trang mẫu fenced code block', // 1
  '', // 2
  '```', // 3
  '### 6.2.3 x', // 4 — nằm TRONG fence, KHÔNG được coi là heading thật
  '```', // 5
  '', // 6
  '### 6.2.3 Màn hình thật', // 7 — heading thật, đứng sau fence
  '', // 8
  'Nội dung mô tả.', // 9
].join('\n');

test('mapScreensToSections: dòng "### …" nằm trong fenced code block không được coi là heading — heading thật phía sau mới được chọn', () => {
  const sections = splitSections(SAMPLE_PAGE_FENCED_CODE, { minLines: 1 });
  const pageLines = SAMPLE_PAGE_FENCED_CODE.split('\n');
  const { placed, unplaced } = mapScreensToSections(sections, pageLines, ['PAGE__6.2.3']);
  assert.deepEqual(unplaced, []);
  const all = [...placed.values()].flat();
  assert.equal(all.length, 1);
  // Nếu dòng 4 (trong fence) bị coi là heading, insertAfterLine sẽ là 4 (không
  // có gì để gom ngay sau nó trong fence). Heading thật ở dòng 7 mới đúng.
  assert.equal(all[0]!.insertAfterLine, 7);
});

/* ── (5) parseCatalogue ────────────────────────────────────────────────────── */

const COMPONENTS_MD = [
  '# Danh mục component từ Figma',
  '',
  '## [SDK] Web Lib (Slot)',
  '',
  '### `#figma-b8cf650d6d` Text Field',
  '',
  '- Figma node: `48:333`',
  '- Trang: ↳ Input Field',
  '- Mô tả: Standard text input field for capturing user text data.',
  '',
  '| Thuộc tính | Kiểu | Giá trị |',
  '|---|---|---|',
  '',
  '### `#figma-297be0fb5f` Button',
  '',
  '- Figma node: `10:20`',
  '- Mô tả: Nút bấm chuẩn.',
  '',
  '### `#figma-no-desc` Không có mô tả',
  '',
  '- Figma node: `1:1`',
  '',
].join('\n');

test('parseCatalogue đọc đúng anchor (không dấu #) + name + description', () => {
  const map = parseCatalogue(COMPONENTS_MD);
  assert.equal(map.get('figma-b8cf650d6d')?.name, 'Text Field');
  assert.equal(map.get('figma-b8cf650d6d')?.description, 'Standard text input field for capturing user text data.');
  assert.equal(map.get('figma-297be0fb5f')?.name, 'Button');
  assert.equal(map.get('figma-297be0fb5f')?.description, 'Nút bấm chuẩn.');
});

test('parseCatalogue: thiếu dòng Mô tả → description rỗng, không lỗi', () => {
  const map = parseCatalogue(COMPONENTS_MD);
  assert.equal(map.get('figma-no-desc')?.description, '');
});

/* ── (4) renderCompositionDraft ────────────────────────────────────────────── */

const SCREEN_DOC: ScreenComponentsDoc = {
  schema_version: SCREEN_COMPONENTS_SCHEMA_VERSION,
  key: 'PAGE__6.1.1',
  name: 'Màn hình trang chủ',
  flowId: 'FLOW-x',
  platform: 'mobile',
  source: 'docs-feature/a.md',
  elements: [
    {
      id: 'btn-history',
      label: 'Nút Lịch sử giao dịch',
      role: 'icon-button',
      ds: { component: 'Button', anchor: 'figma-297be0fb5f', variant: 'Type=Ghost' },
      confidence: 'high',
      provenance: 'text',
      why: 'Click chuyển sang màn Lịch sử giao dịch.',
    },
    {
      id: 'app-bar',
      label: 'App bar',
      role: 'app-bar',
      ds: null,
      confidence: 'low',
      provenance: 'ds',
    },
    {
      id: 'mode-intl',
      label: 'Du lịch nước ngoài',
      role: 'segment-switch',
      ds: { component: 'Segmented Controls', anchor: 'figma-unknown' },
      confidence: 'medium',
      provenance: 'text',
    },
  ],
  nav: [{ el: 'mode-intl', to: 'PAGE__6.2.1' }],
  notes: [],
};

const ROLE_MAP_DOC: RoleMapDoc = {
  schema_version: SCREEN_COMPONENTS_SCHEMA_VERSION,
  platform: 'mobile',
  roles: [{ role: 'app-bar', component: null, fallback: 'Ghép Button + Label làm app-bar.' }],
};

test('renderCompositionDraft: đủ 8 cột, DS null → placeholder + fallback, mô tả từ catalogue, nav → tên màn, escape |', () => {
  const catalogue = new Map([
    ['figma-297be0fb5f', { name: 'Button', description: 'Nút | có ký tự đặc biệt' }],
  ]);
  const screenNames = new Map([['PAGE__6.2.1', 'Màn hình chọn Quốc gia & Khu vực']]);
  const md = renderCompositionDraft(SCREEN_DOC, catalogue, ROLE_MAP_DOC, screenNames);

  assert.ok(md.startsWith('**Cấu thành màn hình (Design System) — Màn hình trang chủ**'));
  const headerLine = md.split('\n').find((l) => l.startsWith('| #'));
  assert.ok(headerLine);
  assert.equal(
    headerLine,
    '| # | Thành phần | Component DS | Biến thể | Vai trò / dùng để | Mô tả component | Điều hướng tới | Ghi chú |',
  );
  // 8 cột => 9 dấu | phân cách trên dòng tiêu đề (không có nội dung escape lẫn vào).
  assert.equal((headerLine!.match(/\|/g) ?? []).length, 9);
  const rowLines = md.split('\n').filter((l) => l.startsWith('| 1 ') || l.startsWith('| 2 ') || l.startsWith('| 3 '));
  assert.equal(rowLines.length, 3);
  // Hàng 2/3 không có ký tự "|" trong nội dung ô → vẫn đúng 9 dấu phân cách.
  assert.equal((rowLines[1]!.match(/\|/g) ?? []).length, 9);
  assert.equal((rowLines[2]!.match(/\|/g) ?? []).length, 9);

  // Hàng 1: mô tả có "|" đã được escape thành "\|" (nên tổng số ký tự "|" là 10 = 9 phân cách + 1 escape).
  assert.ok(rowLines[0]!.includes('Nút \\| có ký tự đặc biệt'));
  assert.equal((rowLines[0]!.match(/\|/g) ?? []).length, 10);

  // Hàng 2 (app-bar, ds null): placeholder DS + fallback trong Ghi chú + "tin cậy thấp".
  assert.ok(rowLines[1]!.includes('— (DS không có)'));
  assert.ok(rowLines[1]!.includes('tin cậy thấp'));
  assert.ok(rowLines[1]!.includes('fallback: Ghép Button + Label làm app-bar.'));

  // Hàng 3 (mode-intl): nav → tên màn đích qua screenNames; catalogue thiếu anchor → "—".
  assert.ok(rowLines[2]!.includes('Màn hình chọn Quốc gia & Khu vực'));

  assert.ok(md.includes('*Nguồn: comp/PAGE__6.1.1.screen.json (bước Màn hình → Component)'));
});

/* ── (6) buildEnrichKickoff ────────────────────────────────────────────────── */

test('buildEnrichKickoff: input rỗng → chuỗi rỗng', () => {
  assert.equal(buildEnrichKickoff({}), '');
});

test('buildEnrichKickoff: có diagram → có câu cấm sửa fence mermaid', () => {
  const text = buildEnrichKickoff({ diagramInThisSlice: { flowId: 'FLOW-3-1-luong-so-do' } });
  assert.ok(text.includes('TUYỆT ĐỐI không sửa fence'));
  assert.ok(text.includes('```mermaid'));
  assert.ok(text.includes('flows/FLOW-3-1-luong-so-do/ux-review.json'));
});

test('buildEnrichKickoff: có screens → nhắc review/_composition/<KEY>.md và rule_id comp/<KEY>.screen.json', () => {
  const text = buildEnrichKickoff({
    screensInThisSlice: [{ key: 'PAGE__6.1.1', insertAfterLineText: '![](../a/img1.png)![](../a/img2.png)' }],
  });
  assert.ok(text.includes('review/_composition/PAGE__6.1.1.md'));
  assert.ok(text.includes('rule_id comp/PAGE__6.1.1.screen.json'));
  assert.ok(text.includes('KHÔNG before'));
});

test('buildEnrichKickoff: unplacedScreens → nhắc ghi note gap, không chèn bảng', () => {
  const text = buildEnrichKickoff({ unplacedScreens: ['PAGE__9.9.9'] });
  assert.ok(text.includes('PAGE__9.9.9'));
  assert.ok(text.includes('không định vị được'));
  assert.ok(text.includes('không chèn bảng'));
});

test('buildEnrichKickoff: pageDiagramChanged → nhắc mọi section của trang kể cả không chứa sơ đồ', () => {
  const text = buildEnrichKickoff({ pageDiagramChanged: [{ flowId: 'FLOW-3-1-luong-so-do' }] });
  assert.ok(text.includes('flows/FLOW-3-1-luong-so-do/proposed.mmd'));
  assert.ok(text.includes("kind flow, rule_id flows/FLOW-3-1-luong-so-do/ux-review.json"));
});
