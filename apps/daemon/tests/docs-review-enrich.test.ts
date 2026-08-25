import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  findMermaidFence,
  replaceDiagramInSlice,
  mapScreensToSections,
  parseCatalogue,
  renderCompositionDraft,
  buildEnrichKickoff,
  COMPOSITION_TITLE_PREFIX,
  compositionCaptionFor,
  insertCompositionTable,
  resolveInsertAnchorIdx,
  parseCompositionBlock,
  reconcileCompositionTable,
  isCompositionOwnedChange,
  findToolOutputNoise,
  truncateAtWordBoundary,
  shortComponentDesc,
  inferredScreenReviewFinding,
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
  assert.ok(text.includes('### 3.2 Mô tả'));
  assert.ok(text.includes('Bảng mô tả từng bước.'));
  // WP-drreview-mmd-preview-gc: ảnh preview mermaid cũ (alt `flow-diagram…`)
  // ngay trên fence bị GỠ — chỉ còn đúng một sơ đồ (bản đề xuất), không còn
  // ảnh gốc as-is tĩnh chồng lên trên (xem test riêng bên dưới cho các luật
  // đầy đủ: guard ảnh thường, khớp theo sourceStem, byte-identical khi không
  // có ảnh preview).
  assert.ok(!text.includes('![flow-diagram Luồng người dùng](../../attachments/flow.svg)'));

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

/* ── (1c) WP-drreview-mmd-preview-gc: gỡ ảnh preview mermaid cũ ngay trên fence ── */

// Không có ảnh preview nào ngay trên fence — hành vi PHẢI byte-identical với
// trước khi có tính năng gỡ ảnh (before bắt đầu đúng tại dòng ```mermaid).
const SLICE_NO_PREVIEW = [
  '### 3.1 Luồng sơ đồ',
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

// Ảnh NGAY TRÊN fence nhưng KHÔNG phải preview mermaid: alt không bắt đầu
// `flow-diagram` và basename (`screenshot`) không khớp sourceStem (`flow`,
// rút từ caption cũ) — ảnh nội dung thật của user, PHẢI được giữ nguyên.
const SLICE_WITH_NORMAL_IMAGE = [
  '### 3.1 Luồng sơ đồ',
  '',
  '![Ảnh chụp màn hình thật](../../attachments/screenshot.png)',
  '',
  '```mermaid',
  ...AS_IS_MMD.split('\n'),
  '```',
  '',
  '*flow-diagram — sơ đồ Mermaid "Luồng người dùng"; nguồn: [flow.mmd](../../attachments/flow.mmd)*',
  '',
].join('\n');

// Ảnh NGAY TRÊN fence có alt KHÔNG bắt đầu `flow-diagram` nhưng basename
// (`flow`) KHỚP sourceStem rút từ caption cũ (`flow.mmd`) — vẫn phải bị gỡ
// theo luật (b).
const SLICE_WITH_STEM_MATCHED_PREVIEW = [
  '### 3.1 Luồng sơ đồ',
  '',
  '![Sơ đồ luồng người dùng](../../attachments/flow.svg)',
  '',
  '```mermaid',
  ...AS_IS_MMD.split('\n'),
  '```',
  '',
  '*flow-diagram — sơ đồ Mermaid "Luồng người dùng"; nguồn: [flow.mmd](../../attachments/flow.mmd)*',
  '',
].join('\n');

test('replaceDiagramInSlice: ảnh preview SVG (alt flow-diagram) ngay trên fence bị gỡ, before chứa cả ảnh, chỉ còn một sơ đồ đề xuất', () => {
  const result = replaceDiagramInSlice(SLICE_WITH_DIAGRAM, {
    asIsMmd: AS_IS_MMD,
    proposedMmd: PROPOSED_MMD,
    flowId: 'FLOW-preview-gc',
    uxReview: {},
  });
  assert.ok(result);
  const { text, change } = result!;

  // Ảnh preview biến mất khỏi text — chỉ còn đúng một sơ đồ (bản đề xuất).
  assert.ok(!text.includes('![flow-diagram Luồng người dùng](../../attachments/flow.svg)'));
  assert.equal(text.match(/```mermaid/g)?.length, 1);

  // before mang cả ảnh preview lẫn fence/caption cũ.
  assert.ok(change.before!.includes('![flow-diagram Luồng người dùng](../../attachments/flow.svg)'));
  assert.ok(change.before!.includes('```mermaid'));
  assert.ok(SLICE_WITH_DIAGRAM.includes(change.before!));

  const errors = validateChanges(SLICE_WITH_DIAGRAM, text, [change]);
  assert.deepEqual(errors, []);
});

test('replaceDiagramInSlice: KHÔNG có ảnh preview → text/before byte-identical với hành vi hiện tại (before bắt đầu đúng tại fence)', () => {
  const result = replaceDiagramInSlice(SLICE_NO_PREVIEW, {
    asIsMmd: AS_IS_MMD,
    proposedMmd: PROPOSED_MMD,
    flowId: 'FLOW-no-preview',
    uxReview: {},
  });
  assert.ok(result);
  const { text, change } = result!;

  assert.ok(change.before!.startsWith('```mermaid'));
  assert.ok(text.includes('### 3.1 Luồng sơ đồ'));
  assert.ok(text.includes('### 3.2 Mô tả'));
  assert.ok(text.includes('Bảng mô tả từng bước.'));

  const errors = validateChanges(SLICE_NO_PREVIEW, text, [change]);
  assert.deepEqual(errors, []);
});

test('replaceDiagramInSlice: ảnh nội dung thường (alt không phải flow-diagram, stem không khớp nguồn) ngay trên fence KHÔNG bị gỡ', () => {
  const result = replaceDiagramInSlice(SLICE_WITH_NORMAL_IMAGE, {
    asIsMmd: AS_IS_MMD,
    proposedMmd: PROPOSED_MMD,
    flowId: 'FLOW-guard-normal-image',
    uxReview: {},
  });
  assert.ok(result);
  const { text, change } = result!;

  assert.ok(text.includes('![Ảnh chụp màn hình thật](../../attachments/screenshot.png)'));
  assert.ok(!change.before!.includes('screenshot.png'));
  assert.ok(change.before!.startsWith('```mermaid'));

  const errors = validateChanges(SLICE_WITH_NORMAL_IMAGE, text, [change]);
  assert.deepEqual(errors, []);
});

test('replaceDiagramInSlice: ảnh preview khớp theo sourceStem (alt không phải flow-diagram) vẫn bị gỡ — luật (b)', () => {
  const result = replaceDiagramInSlice(SLICE_WITH_STEM_MATCHED_PREVIEW, {
    asIsMmd: AS_IS_MMD,
    proposedMmd: PROPOSED_MMD,
    flowId: 'FLOW-preview-gc-stem',
    uxReview: {},
  });
  assert.ok(result);
  const { text, change } = result!;

  assert.ok(!text.includes('![Sơ đồ luồng người dùng](../../attachments/flow.svg)'));
  assert.ok(change.before!.includes('![Sơ đồ luồng người dùng](../../attachments/flow.svg)'));

  const errors = validateChanges(SLICE_WITH_STEM_MATCHED_PREVIEW, text, [change]);
  assert.deepEqual(errors, []);
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

test('renderCompositionDraft: WP19a — mô tả fromGuide (fallback AI sinh) gắn hậu tố " (AI sinh)"; mô tả thật từ Figma thì KHÔNG', () => {
  const catalogue = new Map([
    // fromGuide: true — mô tả đến từ criteria/components-guide.md (fallback).
    ['figma-297be0fb5f', { name: 'Button', description: 'Mô tả AI sinh cho Button.', fromGuide: true }],
  ]);
  const screenNames = new Map([['PAGE__6.2.1', 'Màn hình chọn Quốc gia & Khu vực']]);
  const md = renderCompositionDraft(SCREEN_DOC, catalogue, ROLE_MAP_DOC, screenNames);
  const rowLines = md.split('\n').filter((l) => l.startsWith('| 1 '));
  assert.ok(rowLines[0]!.includes('Mô tả AI sinh cho Button. (AI sinh)'));
});

test('renderCompositionDraft: mô tả thật từ Figma (fromGuide vắng mặt) — KHÔNG có hậu tố "(AI sinh)"', () => {
  const catalogue = new Map([
    ['figma-297be0fb5f', { name: 'Button', description: 'Mô tả thật từ Figma.' }],
  ]);
  const screenNames = new Map([['PAGE__6.2.1', 'Màn hình chọn Quốc gia & Khu vực']]);
  const md = renderCompositionDraft(SCREEN_DOC, catalogue, ROLE_MAP_DOC, screenNames);
  const rowLines = md.split('\n').filter((l) => l.startsWith('| 1 '));
  assert.ok(rowLines[0]!.includes('Mô tả thật từ Figma.'));
  assert.ok(!rowLines[0]!.includes('(AI sinh)'));
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

// WP8a: bảng "Cấu thành màn hình" nay do daemon TỰ CHÈN trước khi agent chạy
// (không còn nháp review/_composition/<KEY>.md cho agent tự chèn) — shape của
// `screensInThisSlice` đổi từ `{ key, insertAfterLineText }` sang `{ key, name }`
// và kickoff chỉ còn dặn luật sửa ô, không còn dặn "chèn bảng".
test('buildEnrichKickoff: có screens → nhắc «Cấu thành màn hình … — <name>», comp/<KEY>.screen.json, KHÔNG khai change, không còn nhắc _composition', () => {
  const text = buildEnrichKickoff({
    screensInThisSlice: [{ key: 'PAGE__6.1.1', name: 'Màn hình trang chủ' }],
  });
  assert.ok(text.includes('Cấu thành màn hình (Design System) — Màn hình trang chủ'));
  assert.ok(text.includes('comp/PAGE__6.1.1.screen.json'));
  assert.ok(text.includes('KHÔNG khai change'));
  assert.ok(!text.includes('_composition'));
});

test('buildEnrichKickoff: có ít nhất một trường → nối thêm cảnh báo chung KHÔNG dùng shell/dán output tool', () => {
  const text = buildEnrichKickoff({ unplacedScreens: ['PAGE__9.9.9'] });
  assert.ok(text.includes('KHÔNG dùng lệnh shell'));
  assert.ok(text.includes('Wall time:'));
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

test('WP32c: inferred screen luôn là gap tài liệu; anchor thật được giữ nhưng diagram-only không tạo anchor/change giả', () => {
  const withAnchor = inferredScreenReviewFinding({
    key: 'prd__AUTO-a1',
    name: 'Xác nhận',
    provenance: 'inferred-flow',
    evidence: { source: 'docs/prd.md', anchorText: 'Người dùng xác nhận giao dịch.' },
  });
  assert.deepEqual(withAnchor, {
    key: 'prd__AUTO-a1',
    name: 'Xác nhận',
    kind: 'gap',
    ruleId: 'comp/prd__AUTO-a1.screen.json',
    message: 'Màn “Xác nhận” được suy luận từ luồng; tài liệu chưa mô tả màn này một cách tường minh.',
    anchorText: 'Người dùng xác nhận giao dịch.',
  });

  const diagramOnly = inferredScreenReviewFinding({
    key: 'prd__AUTO-a2',
    name: 'Kết quả',
    provenance: 'inferred-flow',
    evidence: {
      source: 'docs/prd.md',
      diagramEvidence: [{ cellId: 'result', label: 'Kết quả' }],
    },
  });
  assert.ok(diagramOnly);
  assert.equal(diagramOnly.kind, 'gap');
  assert.equal('anchorText' in diagramOnly, false);
  assert.equal('change' in diagramOnly, false);

  assert.equal(inferredScreenReviewFinding({ key: 'prd__SCR-1', name: 'Explicit', provenance: 'document' }), null);
  assert.equal(inferredScreenReviewFinding({ key: 'prd__SCR-2', name: 'Legacy' }), null);
});

test('WP32c: kickoff không false-green inferred screen và cấm phát minh anchor/change khi chỉ có diagram evidence', () => {
  const text = buildEnrichKickoff({
    unplacedScreens: [
      {
        key: 'prd__AUTO-a2',
        name: 'Kết quả',
        provenance: 'inferred-flow',
        evidence: { source: 'docs/prd.md', diagramEvidence: [{ cellId: 'result', label: 'Kết quả' }] },
      },
    ],
  });
  assert.ok(text.includes('khoảng trống tài liệu'));
  assert.ok(text.includes('KHÔNG tạo anchor/change'));
});

/* ── (7) insertCompositionTable / parseCompositionBlock / reconcileCompositionTable
 *  / isCompositionOwnedChange / findToolOutputNoise (WP8a) ──────────────────── */

const COMP_KEY = 'PAGE__6.1.1';

const DRAFT_MD = [
  `${COMPOSITION_TITLE_PREFIX}Màn hình trang chủ**`,
  '',
  '| # | Thành phần | Component DS | Biến thể | Vai trò / dùng để | Mô tả component | Điều hướng tới | Ghi chú |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 1 | Nút Lịch sử | Button | Type=Ghost | Chuyển màn Lịch sử | Nút bấm chuẩn. | — | — |',
  '| 2 | App bar | — (DS không có) | — | Thanh điều hướng trên | — | — | tin cậy thấp |',
  '',
  compositionCaptionFor(COMP_KEY),
].join('\n');

const SLICE_FOR_INSERT = [
  '#### 6.1.1 Màn hình trang chủ', // 0
  '', // 1
  '![](../a/img1.png)', // 2 — afterLineIdx0 = 2
  '', // 3 — dòng trống ĐÃ CÓ SẴN ngay sau ảnh
  '| Tên trường | Mô tả |', // 4
  '| --- | --- |', // 5
  '| A | B |', // 6
].join('\n');

test('insertCompositionTable: chèn sau dòng ảnh, đúng 1 dòng trống hai bên (kể cả khi lát đã có dòng trống sau ảnh)', () => {
  const { text, change } = insertCompositionTable(SLICE_FOR_INSERT, 2, DRAFT_MD, COMP_KEY);
  const lines = text.split('\n');
  const titleIdx = lines.findIndex((l) => l.startsWith(COMPOSITION_TITLE_PREFIX));
  assert.ok(titleIdx > 0);
  assert.equal(lines[titleIdx - 1], ''); // đúng 1 dòng trống ngay trước tiêu đề
  assert.notEqual(lines[titleIdx - 2], ''); // không phải 2 dòng trống liền

  const captionIdx = lines.findIndex((l) => l.trim() === compositionCaptionFor(COMP_KEY));
  assert.ok(captionIdx > titleIdx);
  // Lát vốn đã có dòng trống ngay sau ảnh — dòng đó được TÁI SỬ DỤNG làm dòng
  // trống sau caption, không bị chèn thêm một dòng nữa (không 2 dòng trống liền).
  assert.equal(lines[captionIdx + 1], '');
  assert.equal(lines[captionIdx + 2], '| Tên trường | Mô tả |');

  assert.equal(change.kind, 'component');
  assert.equal(change.origin, 'system');
  assert.equal(change.rule_id, `comp/${COMP_KEY}.screen.json`);
  assert.equal(change.before, undefined);
  const errors = validateChanges(SLICE_FOR_INSERT, text, [change]);
  assert.deepEqual(errors, []);
});

test('insertCompositionTable: giữ nguyên EOL CRLF của lát', () => {
  const sliceCrlf = SLICE_FOR_INSERT.replace(/\n/g, '\r\n');
  const { text, change } = insertCompositionTable(sliceCrlf, 2, DRAFT_MD, COMP_KEY);
  assert.ok(text.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(text)); // không có \n trần (không kèm \r) lẫn vào
  assert.ok(change.quote!.includes('\r\n'));
});

test('insertCompositionTable: afterLineIdx0 vượt phạm vi lát → kẹp về dòng cuối', () => {
  const { text } = insertCompositionTable(SLICE_FOR_INSERT, 999, DRAFT_MD, COMP_KEY);
  const lines = text.split('\n');
  const lastOrigIdx = lines.findIndex((l) => l === '| A | B |');
  const titleIdx = lines.findIndex((l) => l.startsWith(COMPOSITION_TITLE_PREFIX));
  assert.ok(lastOrigIdx >= 0);
  assert.ok(titleIdx > lastOrigIdx);
});

test('insertCompositionTable: hai bảng cùng lát — chèn theo thứ tự afterLineIdx0 GIẢM DẦN thì cả hai vào đúng vị trí', () => {
  const TWO_SCREEN_SLICE = [
    '#### 6.1.1 Màn A', // 0
    '', // 1
    '![](a.png)', // 2 — anchor A
    '', // 3
    '#### 6.1.2 Màn B', // 4
    '', // 5
    '![](b.png)', // 6 — anchor B
    '', // 7
  ].join('\n');

  const draftA = [`${COMPOSITION_TITLE_PREFIX}Màn A**`, '', '| h |', '| --- |', '| r |', '', compositionCaptionFor('A')].join('\n');
  const draftB = [`${COMPOSITION_TITLE_PREFIX}Màn B**`, '', '| h |', '| --- |', '| r |', '', compositionCaptionFor('B')].join('\n');

  // Chèn GIẢM DẦN: B (afterLineIdx0=6) trước rồi A (afterLineIdx0=2) sau — chỉ
  // số dòng của điểm chèn A không bị lệch vì nó đứng TRƯỚC điểm chèn B.
  const step1 = insertCompositionTable(TWO_SCREEN_SLICE, 6, draftB, 'B');
  const step2 = insertCompositionTable(step1.text, 2, draftA, 'A');
  const lines = step2.text.split('\n');

  const idxA = lines.findIndex((l) => l.trim() === compositionCaptionFor('A'));
  const idxB = lines.findIndex((l) => l.trim() === compositionCaptionFor('B'));
  const idxHeadingB = lines.findIndex((l) => l.startsWith('#### 6.1.2'));
  assert.ok(idxA > 0 && idxA < idxHeadingB, 'bảng A phải nằm TRƯỚC heading màn B');
  assert.ok(idxB > idxHeadingB, 'bảng B phải nằm SAU heading màn B');

  const errors = validateChanges(TWO_SCREEN_SLICE, step2.text, [step1.change, step2.change]);
  assert.deepEqual(errors, []);
});

test('parseCompositionBlock: tách đúng title/header/separator/rows(8 ô)/caption', () => {
  const sliceWithTable = insertCompositionTable(SLICE_FOR_INSERT, 2, DRAFT_MD, COMP_KEY).text;
  const parsed = parseCompositionBlock(sliceWithTable, COMP_KEY);
  assert.ok(!('error' in parsed), JSON.stringify(parsed));
  if ('error' in parsed) return;
  assert.ok(parsed.title.startsWith(COMPOSITION_TITLE_PREFIX));
  assert.equal(parsed.header.startsWith('| # |'), true);
  assert.equal(parsed.separator.startsWith('| --- |'), true);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0]!.length, 8);
  assert.equal(parsed.rows[0]![1], 'Nút Lịch sử');
  assert.equal(parsed.caption, compositionCaptionFor(COMP_KEY));
});

test('parseCompositionBlock: thiếu dòng caption → error', () => {
  const sliceWithTable = insertCompositionTable(SLICE_FOR_INSERT, 2, DRAFT_MD, COMP_KEY).text;
  const noCaption = sliceWithTable
    .split('\n')
    .filter((l) => l.trim() !== compositionCaptionFor(COMP_KEY))
    .join('\n');
  const parsed = parseCompositionBlock(noCaption, COMP_KEY);
  assert.ok('error' in parsed);
});

test('parseCompositionBlock: hai dòng caption trùng nhau → error', () => {
  const sliceWithTable = insertCompositionTable(SLICE_FOR_INSERT, 2, DRAFT_MD, COMP_KEY).text;
  const dupCaption = `${sliceWithTable}\n${compositionCaptionFor(COMP_KEY)}`;
  const parsed = parseCompositionBlock(dupCaption, COMP_KEY);
  assert.ok('error' in parsed);
});

test('parseCompositionBlock: dòng lạ xen giữa tiêu đề và caption → error', () => {
  const sliceWithTable = insertCompositionTable(SLICE_FOR_INSERT, 2, DRAFT_MD, COMP_KEY).text;
  const withNoise = sliceWithTable.replace('| 1 | Nút Lịch sử', 'Ghi chú của agent chèn giữa bảng\n| 1 | Nút Lịch sử');
  const parsed = parseCompositionBlock(withNoise, COMP_KEY);
  assert.ok('error' in parsed);
});

test('parseCompositionBlock: ô chứa "\\|" giữ nguyên là ký tự trong ô (không bị coi là ranh giới cột)', () => {
  const draftWithEscaped = [
    `${COMPOSITION_TITLE_PREFIX}Màn escaped**`,
    '',
    '| # | Thành phần | Component DS | Biến thể | Vai trò / dùng để | Mô tả component | Điều hướng tới | Ghi chú |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 1 | Nút A\\|B | Button | — | Xác nhận | Mô tả | — | — |',
    '',
    compositionCaptionFor('ESC'),
  ].join('\n');
  const parsed = parseCompositionBlock(draftWithEscaped, 'ESC');
  assert.ok(!('error' in parsed), JSON.stringify(parsed));
  if ('error' in parsed) return;
  assert.equal(parsed.rows[0]!.length, 8);
  assert.equal(parsed.rows[0]![1], 'Nút A\\|B');
});

test('reconcileCompositionTable: agent sửa ô Vai trò + Ghi chú 2 hàng → ok, changedRows 2, block đúng, baseWithFinal chứa block', () => {
  const base = insertCompositionTable(SLICE_FOR_INSERT, 2, DRAFT_MD, COMP_KEY).text;
  const revised = base
    .replace('Chuyển màn Lịch sử', 'Chuyển sang màn Lịch sử giao dịch')
    .replace('tin cậy thấp', 'tin cậy thấp; cần xác nhận lại vai trò');
  const result = reconcileCompositionTable(base, revised, COMP_KEY);
  assert.ok(result.ok, 'error' in result ? result.error : '');
  if (!result.ok) return;
  assert.equal(result.changedRows, 2);
  assert.ok(result.block.includes('Chuyển sang màn Lịch sử giao dịch'));
  assert.ok(result.baseWithFinal.includes('Chuyển sang màn Lịch sử giao dịch'));
  assert.ok(result.baseWithFinal.includes('| Tên trường | Mô tả |')); // phần ngoài bảng của base vẫn còn nguyên
});

test('reconcileCompositionTable: sửa cột Component DS → error nêu hàng/cột', () => {
  const base = insertCompositionTable(SLICE_FOR_INSERT, 2, DRAFT_MD, COMP_KEY).text;
  const revised = base.replace('| Button |', '| Icon Button |');
  const result = reconcileCompositionTable(base, revised, COMP_KEY);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Component DS/);
  assert.match(result.error, /hàng 1/);
});

test('reconcileCompositionTable: xoá 1 hàng → error', () => {
  const base = insertCompositionTable(SLICE_FOR_INSERT, 2, DRAFT_MD, COMP_KEY).text;
  const revised = base
    .split('\n')
    .filter((l) => !l.includes('App bar'))
    .join('\n');
  const result = reconcileCompositionTable(base, revised, COMP_KEY);
  assert.equal(result.ok, false);
});

test('reconcileCompositionTable: xoá caption → error', () => {
  const base = insertCompositionTable(SLICE_FOR_INSERT, 2, DRAFT_MD, COMP_KEY).text;
  const revised = base
    .split('\n')
    .filter((l) => l.trim() !== compositionCaptionFor(COMP_KEY))
    .join('\n');
  const result = reconcileCompositionTable(base, revised, COMP_KEY);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /bị xoá\/hỏng cấu trúc/);
});

test('reconcileCompositionTable: không sửa gì → ok, changedRows 0', () => {
  const base = insertCompositionTable(SLICE_FOR_INSERT, 2, DRAFT_MD, COMP_KEY).text;
  const result = reconcileCompositionTable(base, base, COMP_KEY);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.changedRows, 0);
});

const DRAFT_BLOCK = DRAFT_MD;
const FINAL_BLOCK = DRAFT_MD.replace('Chuyển màn Lịch sử', 'Chuyển sang màn Lịch sử giao dịch');

test('isCompositionOwnedChange: change.before = một hàng của draft → true', () => {
  const change = {
    before: '| 1 | Nút Lịch sử | Button | Type=Ghost | Chuyển màn Lịch sử | Nút bấm chuẩn. | — | — |',
  };
  assert.equal(isCompositionOwnedChange(change, DRAFT_BLOCK, FINAL_BLOCK), true);
});

test('isCompositionOwnedChange: change.quote = một hàng của final → true', () => {
  const change = {
    quote: '| 1 | Nút Lịch sử | Button | Type=Ghost | Chuyển sang màn Lịch sử giao dịch | Nút bấm chuẩn. | — | — |',
  };
  assert.equal(isCompositionOwnedChange(change, DRAFT_BLOCK, FINAL_BLOCK), true);
});

test('isCompositionOwnedChange: quote ngắn ("Button", không nguyên dòng) → false (so theo dòng, không substring)', () => {
  const change = { quote: 'Button' };
  assert.equal(isCompositionOwnedChange(change, DRAFT_BLOCK, FINAL_BLOCK), false);
});

test('isCompositionOwnedChange: change ngoài bảng → false', () => {
  const change = {
    before: 'Một câu hoàn toàn không liên quan tới bảng.',
    quote: 'Một câu khác cũng vậy.',
  };
  assert.equal(isCompositionOwnedChange(change, DRAFT_BLOCK, FINAL_BLOCK), false);
});

test('findToolOutputNoise: fixture 6 dòng rác từ sự cố thật → bắt đủ', () => {
  const text = [
    'Nội dung bình thường của lát.',
    'Wall time: 0.4 seconds',
    'Total output lines: 218',
    'Output:',
    '---SLICE---',
    '---DRAFT---',
    'Exit code: 0',
    'Chữ bình thường khác.',
  ].join('\n');
  const noise = findToolOutputNoise(text);
  assert.equal(noise.length, 6);
});

test('findToolOutputNoise: văn bản thường có chữ "Output" trong câu → rỗng', () => {
  const text = [
    'Output của API trả về đúng định dạng JSON theo tài liệu.',
    'Đoạn này liệt kê Output các bước xử lý — không phải rác tool.',
  ].join('\n');
  assert.deepEqual(findToolOutputNoise(text), []);
});

/* ── (8) resolveInsertAnchorIdx (WP8d — chốt chặn bằng NỘI DUNG dòng neo thay
 *  vì tin thẳng chỉ số dòng gợi ý, xem .tmp/pipeline/wp8d.yaml) ─────────────── */

const ANCHOR_SLICE = [
  '#### 6.1.1 Màn hình trang chủ', // 0
  '', // 1
  '![](../a/img1.png)', // 2 — dòng neo
  '', // 3
  '| Tên trường | Mô tả |', // 4
  '| --- | --- |', // 5
  '| A | B |', // 6
].join('\n');

test('resolveInsertAnchorIdx: dòng tại hint khớp ngay → trả thẳng hint (đường tắt)', () => {
  assert.equal(resolveInsertAnchorIdx(ANCHOR_SLICE, '![](../a/img1.png)', 2), 2);
});

test('resolveInsertAnchorIdx: hint lệch (mô phỏng sơ đồ dài thêm 3 dòng) → dò lại đúng theo nội dung dòng neo', () => {
  const shifted = [
    '#### 6.1.1 Màn hình trang chủ', // 0
    'extra-1', // 1
    'extra-2', // 2
    'extra-3', // 3
    '', // 4
    '![](../a/img1.png)', // 5 — dòng neo đã dịch xuống 3 dòng so với hint cũ (2)
    '', // 6
    '| Tên trường | Mô tả |', // 7
  ].join('\n');
  assert.equal(resolveInsertAnchorIdx(shifted, '![](../a/img1.png)', 2), 5);
});

test('resolveInsertAnchorIdx: hai/nhiều dòng trùng nội dung → chọn dòng GẦN hint nhất, hoà thì lấy chỉ số nhỏ hơn', () => {
  const dup = ['![](x.png)', 'a', 'b', '![](x.png)', 'c', '![](x.png)'].join('\n');
  assert.equal(resolveInsertAnchorIdx(dup, '![](x.png)', 1), 0); // gần dòng 0 nhất (cách 1, so với dòng 3 cách 2)
  assert.equal(resolveInsertAnchorIdx(dup, '![](x.png)', 4), 3); // hoà (dòng 3 và 5 cùng cách hint 1 dòng) → chọn chỉ số nhỏ hơn
});

test('resolveInsertAnchorIdx: không dòng nào khớp anchorText → null', () => {
  assert.equal(resolveInsertAnchorIdx(ANCHOR_SLICE, '![](khong-ton-tai.png)', 2), null);
});

test('resolveInsertAnchorIdx: anchorText rỗng sau trim → trả hint đã kẹp trong phạm vi (giữ hành vi cũ)', () => {
  assert.equal(resolveInsertAnchorIdx(ANCHOR_SLICE, '', 2), 2);
  assert.equal(resolveInsertAnchorIdx(ANCHOR_SLICE, '   ', 4), 4);
});

test('resolveInsertAnchorIdx: hint âm hoặc vượt phạm vi (anchorText rỗng) → kẹp về [0, length-1]', () => {
  assert.equal(resolveInsertAnchorIdx(ANCHOR_SLICE, '', -5), 0);
  assert.equal(resolveInsertAnchorIdx(ANCHOR_SLICE, '', 999), ANCHOR_SLICE.split('\n').length - 1);
});

/* ── (9) Test HỒI QUY cho lỗi review chặn WP8b: thay sơ đồ TRƯỚC làm bảng
 *  "Cấu thành màn hình" chèn lệch chỗ khi cùng section vừa có sơ đồ vừa có
 *  màn có bảng (proposed.mmd dài hơn as-is.mmd làm lát dịch dòng) ───────────── */

const REG_AS_IS_MMD = ['flowchart TD', '    A --> B', '    B --> C'].join('\n'); // thân fence 3 dòng

const REG_PROPOSED_MMD = [
  'flowchart TD',
  '    A --> B',
  '    B --> C',
  '    C --> D',
  '    D --> E',
  '    E --> F',
].join('\n'); // thân fence 6 dòng — dài hơn as-is 3 dòng

const REG_SLICE = [
  '### 3.1 Luồng và màn hình', // 0
  '', // 1
  '```mermaid', // 2
  ...REG_AS_IS_MMD.split('\n'), // 3,4,5
  '```', // 6
  '', // 7
  '#### 6.1.1 Màn hình ABC', // 8 — heading màn có bảng "Cấu thành"
  '', // 9
  '![](../a/mockup.png)', // 10 — dòng ảnh mockup: hintIdx0 tính từ LÁT GỐC (trước enrich)
  '', // 11
  '| Tên trường | Mô tả |', // 12 — bảng field, KHÔNG được bảng "Cấu thành" chèn lệch vào giữa
  '| --- | --- |', // 13
  '| A | B |', // 14
].join('\n');

test('Hồi quy WP8d: dùng THẲNG hintIdx0 (không resolve) sau khi sơ đồ đã bị thay TRƯỚC → bảng KHÔNG nằm đúng chỗ (chứng minh test bắt được lỗi review chặn)', () => {
  const hintIdx0 = 10; // = chỉ số dòng ảnh mockup trong REG_SLICE gốc

  const replaced = replaceDiagramInSlice(REG_SLICE, {
    asIsMmd: REG_AS_IS_MMD,
    proposedMmd: REG_PROPOSED_MMD,
    flowId: 'FLOW-reg-wrong',
    uxReview: {},
  });
  assert.ok(replaced);
  const shiftedText = replaced!.text;

  // Bằng chứng của bug: proposed dài hơn as-is 3 dòng → dòng neo đã dịch
  // xuống 3 dòng, hintIdx0 cũ (10) KHÔNG còn trỏ vào dòng ảnh mockup nữa.
  const shiftedLines = shiftedText.split('\n');
  assert.notEqual((shiftedLines[hintIdx0] ?? '').trim(), '![](../a/mockup.png)');

  const wrongInserted = insertCompositionTable(shiftedText, hintIdx0, DRAFT_MD, COMP_KEY);
  const wrongLines = wrongInserted.text.split('\n');
  const headingIdx = wrongLines.findIndex((l) => l.startsWith('#### 6.1.1'));
  const titleIdxWrong = wrongLines.findIndex((l) => l.startsWith(COMPOSITION_TITLE_PREFIX));
  assert.ok(headingIdx > 0 && titleIdxWrong > 0);
  // Chèn sai chỗ: bảng rơi TRƯỚC heading màn (đáng lẽ phải nằm SAU heading,
  // ngay sau dòng ảnh mockup) — đúng lỗi review chặn wp8d.yaml mô tả.
  assert.ok(titleIdxWrong < headingIdx, 'bảng phải bị chèn sai (trước heading) để chứng minh test thật sự bắt được lỗi');
});

test('Hồi quy WP8d: resolveInsertAnchorIdx dò lại theo nội dung dòng neo → bảng nằm ĐÚNG chỗ (ngay sau ảnh mockup, trước bảng field) dù sơ đồ đã thay trước', () => {
  const hintIdx0 = 10;
  const anchorText = REG_SLICE.split('\n')[hintIdx0] ?? '';

  const replaced = replaceDiagramInSlice(REG_SLICE, {
    asIsMmd: REG_AS_IS_MMD,
    proposedMmd: REG_PROPOSED_MMD,
    flowId: 'FLOW-reg-right',
    uxReview: {},
  });
  assert.ok(replaced);
  const shiftedText = replaced!.text;

  const idx = resolveInsertAnchorIdx(shiftedText, anchorText, hintIdx0);
  assert.notEqual(idx, null);

  const inserted = insertCompositionTable(shiftedText, idx!, DRAFT_MD, COMP_KEY);
  const lines = inserted.text.split('\n');

  const imageIdx = lines.findIndex((l) => l.trim() === '![](../a/mockup.png)');
  const titleIdx = lines.findIndex((l) => l.startsWith(COMPOSITION_TITLE_PREFIX));
  const captionIdx = lines.findIndex((l) => l.trim() === compositionCaptionFor(COMP_KEY));
  const fieldTableIdx = lines.findIndex((l) => l.trim() === '| Tên trường | Mô tả |');

  assert.ok(imageIdx > 0 && titleIdx > 0 && captionIdx > 0 && fieldTableIdx > 0);
  assert.ok(titleIdx > imageIdx, 'bảng phải nằm NGAY SAU dòng ảnh mockup');
  assert.ok(captionIdx < fieldTableIdx, 'bảng phải nằm TRƯỚC bảng field');

  const errors = validateChanges(REG_SLICE, inserted.text, [replaced!.change, inserted.change]);
  assert.deepEqual(errors, []);
});

test('Hồi quy WP8d: đảo thứ tự (như 2a) — chèn bảng TRƯỚC rồi thay sơ đồ SAU, replaceDiagramInSlice vẫn tìm thấy fence và thay đúng, không xáo trộn vị trí bảng', () => {
  const hintIdx0 = 10;
  const anchorText = REG_SLICE.split('\n')[hintIdx0] ?? '';
  const idx = resolveInsertAnchorIdx(REG_SLICE, anchorText, hintIdx0);
  assert.equal(idx, hintIdx0); // lát còn nguyên (chưa bị sửa gì) → hint khớp thẳng, không cần dò

  const afterTable = insertCompositionTable(REG_SLICE, idx!, DRAFT_MD, COMP_KEY);

  const replaced = replaceDiagramInSlice(afterTable.text, {
    asIsMmd: REG_AS_IS_MMD,
    proposedMmd: REG_PROPOSED_MMD,
    flowId: 'FLOW-reg-reversed',
    uxReview: {},
  });
  assert.ok(
    replaced,
    'replaceDiagramInSlice phải vẫn tìm thấy fence dù bảng đã chèn phía dưới nó (định vị theo NỘI DUNG fence, không phải chỉ số dòng)',
  );
  assert.ok(replaced!.text.includes('E --> F'));

  const lines = replaced!.text.split('\n');
  const imageIdx = lines.findIndex((l) => l.trim() === '![](../a/mockup.png)');
  const titleIdx = lines.findIndex((l) => l.startsWith(COMPOSITION_TITLE_PREFIX));
  const fieldTableIdx = lines.findIndex((l) => l.trim() === '| Tên trường | Mô tả |');
  assert.ok(imageIdx > 0 && titleIdx > 0 && fieldTableIdx > 0);
  assert.ok(titleIdx > imageIdx, 'bảng vẫn nằm ngay sau ảnh mockup sau khi sơ đồ đã được thay');
  assert.ok(titleIdx < fieldTableIdx, 'bảng vẫn nằm trước bảng field sau khi sơ đồ đã được thay');
});

/* ── WP-dr-review-readability mục A: truncateAtWordBoundary / shortComponentDesc ── */

test('truncateAtWordBoundary: chuỗi ngắn hơn hoặc bằng max giữ NGUYÊN VĂN, không thêm gì', () => {
  assert.equal(truncateAtWordBoundary('ngắn', 100), 'ngắn');
  assert.equal(truncateAtWordBoundary('đúng bằng max', 'đúng bằng max'.length), 'đúng bằng max');
});

test('truncateAtWordBoundary: cắt tại ranh giới từ CUỐI CÙNG trong phạm vi max, thêm "…", không cắt giữa từ', () => {
  const s = `${'A'.repeat(50)} ${'B'.repeat(50)} ${'C'.repeat(50)}`; // 50+1+50+1+50 = 152 ký tự
  const result = truncateAtWordBoundary(s, 60);
  // window = 60 ký tự đầu = 50 chữ A + 1 dấu cách + 9 chữ B đầu — ranh giới từ
  // CUỐI CÙNG trong phạm vi đó là dấu cách sau khối A, nên phải cắt Ở ĐÓ, bỏ
  // luôn 9 chữ B dở dang (không được phép cắt giữa từ "BBB...").
  assert.equal(result, `${'A'.repeat(50)}…`);
});

test('truncateAtWordBoundary: một "từ" dài hơn cả max (không khoảng trắng nào trong phạm vi) → đành cắt CỨNG tại max', () => {
  const s = 'X'.repeat(50);
  const result = truncateAtWordBoundary(s, 20);
  assert.equal(result, `${'X'.repeat(20)}…`);
});

test('shortComponentDesc: dump "Description: … Usage: … Variants: …" → chỉ còn CÂU ĐẦU của phần description, không dump Usage/Variants', () => {
  const dump =
    'Description: Trường nhập liệu cơ bản dùng để thu thập thông tin từ người dùng. ' +
    'Usage: Use this component when you need a single line of text input from the user, typically inside a form. ' +
    'Variants: Default, Error, Disabled, Focused, Filled. ' +
    'Properties: label, placeholder, helperText, errorMessage.';
  const result = shortComponentDesc(dump);
  assert.equal(result, 'Trường nhập liệu cơ bản dùng để thu thập thông tin từ người dùng.');
  assert.ok(!result.includes('Usage:'));
  assert.ok(!result.includes('Variants:'));
  assert.ok(!result.includes('Properties:'));
});

test('shortComponentDesc: mô tả tiếng Việt ngắn (không có nhãn section nào) giữ NGUYÊN VĂN', () => {
  const desc = 'Icon dùng để hiển thị trạng thái đã chọn.';
  assert.equal(shortComponentDesc(desc), desc);
});

test('shortComponentDesc: "2.1" (số mục) KHÔNG bị coi là kết câu — chỉ cắt ở dấu chấm cuối câu thật', () => {
  const desc = 'Áp dụng từ phiên bản 2.1 trở đi.';
  assert.equal(shortComponentDesc(desc), desc);
});

test('shortComponentDesc: mô tả >160 ký tự (không dấu câu) bị cắt ĐÚNG ranh giới từ, có "…"', () => {
  const words = Array.from({ length: 40 }, (_, i) => `tukhoa${i}`);
  const longDesc = words.join(' ');
  assert.ok(longDesc.length > 160);
  const result = shortComponentDesc(longDesc);
  assert.ok(result.endsWith('…'));
  const content = result.slice(0, -1);
  assert.ok(longDesc.startsWith(content), 'phần giữ lại phải là một tiền tố nguyên văn của mô tả gốc');
  const boundaryChar = longDesc[content.length];
  assert.ok(
    boundaryChar === undefined || boundaryChar === ' ',
    'phải cắt tại ranh giới từ (ký tự ngay sau phần giữ lại phải là khoảng trắng), không cắt giữa một từ',
  );
});

test('renderCompositionDraft: mô tả dump dài (Description/Usage/Variants) → ô "Mô tả component" ngắn (≤ ~165 ký tự), KHÔNG chứa "Usage:"', () => {
  const dumpDesc =
    'Description: Trường nhập liệu cơ bản dùng để thu thập thông tin từ người dùng. ' +
    'Usage: Use this component when you need a single line of text input from the user, typically inside a form. ' +
    'Variants: Default, Error, Disabled, Focused, Filled. Properties: label, placeholder, helperText, errorMessage.';
  const catalogue = new Map([['figma-297be0fb5f', { name: 'Button', description: dumpDesc }]]);
  const screenNames = new Map([['PAGE__6.2.1', 'Màn hình chọn Quốc gia & Khu vực']]);
  const md = renderCompositionDraft(SCREEN_DOC, catalogue, ROLE_MAP_DOC, screenNames);
  const rowLines = md.split('\n').filter((l) => l.startsWith('| 1 '));
  assert.ok(rowLines[0]);
  assert.ok(!rowLines[0]!.includes('Usage:'));
  assert.ok(!rowLines[0]!.includes('Variants:'));
  const cells = rowLines[0]!.split('|').map((c) => c.trim());
  const descCell = cells[6]!.replace(/\\\|/g, '|');
  assert.ok(descCell.length <= 165, `ô mô tả phải ngắn, nhận được ${descCell.length} ký tự: "${descCell}"`);
});

test('renderCompositionDraft: mô tả dump dài + fromGuide=true → vẫn ngắn gọn và hậu tố " (AI sinh)" vẫn gắn ở cuối', () => {
  const dumpDesc = 'Mô tả: Trường nhập liệu. Usage: dùng khi cần nhập một dòng văn bản kèm nhãn rõ ràng cho người dùng.';
  const catalogue = new Map([['figma-297be0fb5f', { name: 'Text Field', description: dumpDesc, fromGuide: true }]]);
  const screenNames = new Map([['PAGE__6.2.1', 'Màn hình chọn Quốc gia & Khu vực']]);
  const md = renderCompositionDraft(SCREEN_DOC, catalogue, ROLE_MAP_DOC, screenNames);
  const rowLines = md.split('\n').filter((l) => l.startsWith('| 1 '));
  assert.ok(rowLines[0]!.includes('Trường nhập liệu. (AI sinh)'));
  assert.ok(!rowLines[0]!.includes('Usage:'));
});

test('renderCompositionDraft: el.why dài (~130 ký tự) trong cột "Vai trò / dùng để" bị cắt ĐÚNG ranh giới từ, không đứt giữa từ', () => {
  const words = Array.from({ length: 24 }, (_, i) => `lydo${i}`);
  const longWhy = words.join(' ');
  assert.ok(longWhy.length > 120);
  const doc: ScreenComponentsDoc = {
    ...SCREEN_DOC,
    elements: [
      {
        id: 'x1',
        label: 'Phần tử dài',
        role: 'text',
        ds: null,
        confidence: 'high',
        provenance: 'text',
        why: longWhy,
      },
    ],
    nav: [],
  };
  const md = renderCompositionDraft(doc, new Map(), null, new Map());
  const rowLines = md.split('\n').filter((l) => l.startsWith('| 1 '));
  const cells = rowLines[0]!.split('|').map((c) => c.trim());
  const roleCell = cells[5]!;
  const whyPart = roleCell.split(' — ')[1] ?? '';
  assert.ok(whyPart.includes('…'), `cột vai trò phải bị cắt, nhận được "${roleCell}"`);
  const roleWords = whyPart.replace('…', '').trim().split(/\s+/).filter(Boolean);
  const originalWords = new Set(longWhy.split(' '));
  for (const w of roleWords) assert.ok(originalWords.has(w), `từ "${w}" bị cắt giữa chừng trong cột vai trò`);
});
