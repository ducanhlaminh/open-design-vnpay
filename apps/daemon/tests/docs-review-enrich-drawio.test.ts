// WP-drreview-drawio-preview mục B+A: `replaceDrawioInSlice` — thay khối ảnh
// PNG per-page + dòng "nguồn sơ đồ" của một diagram .drawio đã ingest (xem
// bas-client.ts:expandDrawioPagesInExportView) bằng MỘT dòng caption marker
// mà DocRedlinePreview.tsx (web) nhận diện để portal DrawioViewer vào. Khác
// mermaid (mã nhúng thẳng, so khớp NỘI DUNG) — draw.io chỉ để lại ẢNH, nên so
// khớp theo TÊN FILE (`stem` = basename(diagramRel) bỏ đuôi .drawio, GIỮ
// NGUYÊN tiền tố số Confluence gắn).
//
// (f) xác nhận mục A: finalizeFlowUx phải PERSIST `FlowInput.diagram` vào
// `FlowIndexEntry` (`flows/index.json`) — trước WP này bị bỏ rơi hoàn toàn dù
// đã có sẵn trên FlowInput.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { replaceDrawioInSlice } from '../src/docs-review-enrich.js';
import { validateChanges } from '../src/docs-review.js';
import { finalizeFlowUx, prepareFlowUxInputs } from '../src/flow-ux/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'flow-ux');

/* ── (a) khối 3 ảnh -p1/-p2/-p3 (thẻ <img>) + dòng nguồn → 1 marker ───────── */

test('replaceDrawioInSlice: khối 3 ảnh <img> -p1/-p2/-p3 + dòng nguồn liền kề (thẻ <img>) → thay bằng 1 dòng marker, before đủ nguyên văn (kể cả dòng trống xen giữa)', () => {
  const lines = [
    '### 3.1 Luồng sơ đồ',
    '',
    '<img src="../attachments/12345-Luong-mua-sim-p1.png" alt="flow-diagram Luong — trang 1"/>',
    '<img src="../attachments/12345-Luong-mua-sim-p2.png" alt="flow-diagram Luong — trang 2"/>',
    '<img src="../attachments/12345-Luong-mua-sim-p3.png" alt="flow-diagram Luong — trang 3"/>',
    '',
    '<em>flow-diagram — nguồn sơ đồ (đọc file này để lấy luồng): <a href="../attachments/12345-Luong-mua-sim.drawio">12345-Luong-mua-sim.drawio</a></em>',
    '',
    '### 3.2 Mô tả',
    '',
    'Bảng mô tả từng bước.',
    '',
  ];
  const sliceText = lines.join('\n');
  const result = replaceDrawioInSlice(sliceText, {
    diagramRel: 'docs-feature/sim/attachments/12345-Luong-mua-sim.drawio',
    flowId: 'FLOW-mua-sim-du-lich',
    uxReview: { verdict: 'needs-improvement', summary: 'thiếu nhánh timeout' },
  });
  assert.ok(result, 'phải tìm thấy khối ảnh khớp stem');
  const { text, change } = result!;
  // before = NGUYÊN VĂN khối cũ — 3 dòng <img> + dòng trống + dòng nguồn.
  assert.equal(change.before, lines.slice(2, 7).join('\n'));
  assert.equal(
    change.quote,
    '*flow-diagram-drawio — sơ đồ ĐỀ XUẤT sau rà soát UX (nguồn gốc: 12345-Luong-mua-sim.drawio; đề xuất: flows/FLOW-mua-sim-du-lich/proposed.drawio)*',
  );
  assert.equal(change.id, 'sys-flow-diagram-FLOW-mua-sim-du-lich');
  assert.equal(change.kind, 'flow-diagram');
  assert.equal(change.origin, 'system');
  assert.equal(change.severity, 'major'); // needs-improvement → major, y hệt replaceDiagramInSlice
  assert.equal(change.reason, 'thiếu nhánh timeout');
  assert.equal(change.rule_id, 'flows/FLOW-mua-sim-du-lich/ux-review.json');
  // Khối cũ biến mất khỏi text, thay bằng đúng 1 dòng marker; phần còn lại
  // của slice (heading 3.2, đoạn mô tả) giữ nguyên.
  assert.equal(
    text,
    ['### 3.1 Luồng sơ đồ', '', change.quote, '', '### 3.2 Mô tả', '', 'Bảng mô tả từng bước.', ''].join('\n'),
  );
});

/* ── (b) ảnh đơn, không dòng nguồn (thẻ <img>) ────────────────────────────── */

test('replaceDrawioInSlice: ảnh đơn (thẻ <img>), KHÔNG có dòng nguồn đi kèm → before chỉ đúng 1 dòng ảnh', () => {
  const lines = [
    '### 3.1',
    '',
    '<img src="attachments/999-Sim.png" alt="flow-diagram Sim"/>',
    '',
    'Đoạn mô tả tiếp theo, không liên quan.',
  ];
  const sliceText = lines.join('\n');
  const result = replaceDrawioInSlice(sliceText, {
    diagramRel: 'docs-feature/sim/attachments/999-Sim.drawio',
    flowId: 'FLOW-sim',
    uxReview: { verdict: 'good', summary: 'ok' },
  });
  assert.ok(result);
  const { text, change } = result!;
  assert.equal(change.before, lines[2]);
  assert.equal(change.severity, 'minor'); // verdict 'good' → minor
  assert.equal(
    text,
    ['### 3.1', '', change.quote, '', 'Đoạn mô tả tiếp theo, không liên quan.'].join('\n'),
  );
});

/* ── (c) cú pháp markdown ![…](…) + [text](href) (sau html-to-markdown) ──── */

test('replaceDrawioInSlice: cú pháp markdown ![…](…) (2 trang) + dòng nguồn [text](href) → khớp và thay đúng khối', () => {
  const lines = [
    '## Luồng',
    '',
    '![flow-diagram Luong — trang 1](../attachments/777-Doi-mat-khau-p1.png)',
    '![flow-diagram Luong — trang 2](../attachments/777-Doi-mat-khau-p2.png)',
    '*flow-diagram — nguồn sơ đồ (đọc file này để lấy luồng): [777-Doi-mat-khau.drawio](../attachments/777-Doi-mat-khau.drawio)*',
    '',
    'Tiếp theo.',
  ];
  const sliceText = lines.join('\n');
  const result = replaceDrawioInSlice(sliceText, {
    diagramRel: 'docs-feature/acc/attachments/777-Doi-mat-khau.drawio',
    flowId: 'FLOW-doi-mat-khau',
    uxReview: {},
  });
  assert.ok(result);
  const { change } = result!;
  assert.equal(change.before, lines.slice(2, 5).join('\n'));
  assert.equal(change.severity, 'minor'); // uxReview trống → không needs-improvement/fail → minor
  assert.equal(change.reason, 'Thay sơ đồ luồng bằng bản đề xuất sau rà soát UX.');
});

test('replaceDrawioInSlice: hai flow p1/p2 cùng diagram chỉ thay đúng ảnh của page mình và self-check cùng đạt', () => {
  const lines = [
    '## Sequence diagram — luồng chính',
    '',
    '![flow-diagram Untitled — trang 1](attachments/1009587453-Untitled_Diagram-1783562766184-p1.png)',
    '![flow-diagram Untitled — trang 2](attachments/1009587453-Untitled_Diagram-1783562766184-p2.png)',
    '*flow-diagram — nguồn sơ đồ (đọc file này để lấy luồng): [1009587453-Untitled_Diagram-1783562766184.drawio](attachments/1009587453-Untitled_Diagram-1783562766184.drawio)*',
    '',
    'Bảng mô tả bước.',
  ];
  const original = lines.join('\n');
  const p1 = replaceDrawioInSlice(original, {
    diagramRel: 'docs-feature/login/attachments/1009587453-Untitled_Diagram-1783562766184.drawio',
    flowId: 'FLOW-untitled-diagram-1783562766184-p1',
    page: { index: 0, count: 2 },
    uxReview: {},
  });
  assert.ok(p1);
  assert.equal(p1.change.before, lines[2]);
  assert.match(p1.text, /-p2\.png/);

  const p2 = replaceDrawioInSlice(p1.text, {
    diagramRel: 'docs-feature/login/attachments/1009587453-Untitled_Diagram-1783562766184.drawio',
    flowId: 'FLOW-untitled-diagram-1783562766184-p2',
    page: { index: 1, count: 2 },
    uxReview: {},
  });
  assert.ok(p2);
  assert.equal(p2.change.before, lines.slice(3, 5).join('\n'));
  assert.deepEqual(validateChanges(original, p2.text, [p1.change, p2.change]), []);
  assert.match(p2.text, /FLOW-untitled-diagram-1783562766184-p1/);
  assert.match(p2.text, /FLOW-untitled-diagram-1783562766184-p2/);
});

test('replaceDrawioInSlice: index 0.8.126 chưa có page vẫn suy đúng p1/p2 từ flow id', () => {
  const original = [
    '![p1](attachments/1009587453-Untitled_Diagram-1783562766184-p1.png)',
    '![p2](attachments/1009587453-Untitled_Diagram-1783562766184-p2.png)',
    '*nguồn: [drawio](attachments/1009587453-Untitled_Diagram-1783562766184.drawio)*',
  ].join('\n');
  const common = {
    diagramRel: 'docs-feature/login/attachments/1009587453-Untitled_Diagram-1783562766184.drawio',
    uxReview: {},
  };
  const p1 = replaceDrawioInSlice(original, { ...common, flowId: 'FLOW-untitled-diagram-1783562766184-p1' });
  assert.ok(p1);
  const p2 = replaceDrawioInSlice(p1.text, { ...common, flowId: 'FLOW-untitled-diagram-1783562766184-p2' });
  assert.ok(p2);
  assert.deepEqual(validateChanges(original, p2.text, [p1.change, p2.change]), []);
});

/* ── (d) stem có ký tự cần encode (dấu tiếng Việt/space) — khớp dạng encoded ─ */

test('replaceDrawioInSlice: stem có dấu tiếng Việt/khoảng trắng, ảnh trong slice dùng dạng encodeURIComponent(stem) → vẫn khớp', () => {
  const diagramRel = 'docs-feature/sim/attachments/456-Chọn gói cước.drawio';
  const stem = '456-Chọn gói cước';
  const encStem = encodeURIComponent(stem);
  const lines = [
    '### Luồng chọn gói',
    '',
    `![flow-diagram Chọn gói](attachments/${encStem}.png)`,
    `*flow-diagram — nguồn sơ đồ (đọc file này để lấy luồng): [456-Chọn gói cước.drawio](attachments/${encStem}.drawio)*`,
    '',
  ];
  const sliceText = lines.join('\n');
  const result = replaceDrawioInSlice(sliceText, {
    diagramRel,
    flowId: 'FLOW-chon-goi',
    uxReview: { verdict: 'fail', summary: 'x'.repeat(200) },
  });
  assert.ok(result, 'phải khớp dạng encodeURIComponent(stem)');
  const { change } = result!;
  assert.equal(change.before, lines.slice(2, 4).join('\n'));
  assert.equal(change.severity, 'major'); // verdict 'fail' → major
  assert.equal(change.reason.length, 160); // reason cắt 160 ký tự
  assert.equal(change.quote, '*flow-diagram-drawio — sơ đồ ĐỀ XUẤT sau rà soát UX (nguồn gốc: 456-Chọn gói cước.drawio; đề xuất: flows/FLOW-chon-goi/proposed.drawio)*');
});

/* ── (e) slice không có ảnh nào khớp → null ───────────────────────────────── */

test('replaceDrawioInSlice: slice không chứa ảnh khớp stem → null (section không có sơ đồ này, không phải lỗi)', () => {
  const sliceText = ['### Mục khác', '', 'Không có ảnh sơ đồ nào ở đây.', '', '![ảnh khác](attachments/unrelated.png)'].join('\n');
  const result = replaceDrawioInSlice(sliceText, {
    diagramRel: 'docs-feature/sim/attachments/12345-Luong-mua-sim.drawio',
    flowId: 'FLOW-mua-sim-du-lich',
    uxReview: {},
  });
  assert.equal(result, null);
});

/* ── (g)-(j) fallback: sơ đồ 1-TRANG giữ tên gốc Confluence (previewName),
 * KHÔNG phải <stem>.png (xem bas-client.ts:expandDrawioPagesInExportView
 * nhánh pages.length<=1 → appendAfterImage(out, meta.previewName, refHtml) —
 * ẢNH không đổi tên theo stem, chỉ dòng NGUỒN mới mang tên <stem>.drawio).
 * Matcher theo stem trên ảnh trượt hoàn toàn trong trường hợp này; fallback
 * định vị qua dòng NGUỒN rồi gom ảnh BẤT KỲ liền ngay trên nó. ───────────── */

test('replaceDrawioInSlice: (g) fallback — ảnh 1 trang tên KHÔNG chứa stem (thẻ <img>, previewName Confluence) + dòng nguồn khớp stem → cả 2 dòng bị thay bằng marker', () => {
  const lines = [
    '### 3.1',
    '',
    '<img src="attachments/Doi-mat-khau-fjkq2.png" alt="flow-diagram"/>',
    '<em>flow-diagram — nguồn sơ đồ (đọc file này để lấy luồng): <a href="attachments/777-Doi-mat-khau.drawio">777-Doi-mat-khau.drawio</a></em>',
    '',
    'Đoạn tiếp theo, không liên quan.',
  ];
  const sliceText = lines.join('\n');
  const result = replaceDrawioInSlice(sliceText, {
    diagramRel: 'docs-feature/acc/attachments/777-Doi-mat-khau.drawio',
    flowId: 'FLOW-doi-mat-khau',
    uxReview: {},
  });
  assert.ok(result, 'fallback theo dòng nguồn phải tìm thấy khối (ảnh tên không khớp stem)');
  const { text, change } = result!;
  // before = NGUYÊN VĂN 2 dòng: ảnh (tên bất kỳ) + dòng nguồn.
  assert.equal(change.before, lines.slice(2, 4).join('\n'));
  assert.equal(
    text,
    ['### 3.1', '', change.quote, '', 'Đoạn tiếp theo, không liên quan.'].join('\n'),
  );
});

test('replaceDrawioInSlice: (h) fallback — cú pháp markdown ![…](…) tên khác stem + dòng nguồn [text](href) → khớp', () => {
  const lines = [
    '## Luồng',
    '',
    '![flow-diagram X](attachments/anh-preview-abc.png)',
    '*flow-diagram — nguồn sơ đồ (đọc file này để lấy luồng): [777-Doi-mat-khau.drawio](attachments/777-Doi-mat-khau.drawio)*',
    '',
    'Tiếp theo.',
  ];
  const sliceText = lines.join('\n');
  const result = replaceDrawioInSlice(sliceText, {
    diagramRel: 'docs-feature/acc/attachments/777-Doi-mat-khau.drawio',
    flowId: 'FLOW-doi-mat-khau',
    uxReview: {},
  });
  assert.ok(result, 'fallback phải khớp cú pháp markdown');
  const { change } = result!;
  assert.equal(change.before, lines.slice(2, 4).join('\n'));
});

test('replaceDrawioInSlice: (i) fallback — CHỈ dòng nguồn, không ảnh nào ở trên (ảnh có thể đã bị xoá tay) → before chỉ đúng dòng nguồn', () => {
  const lines = [
    '### Mô tả',
    '',
    '*flow-diagram — nguồn sơ đồ (đọc file này để lấy luồng): [777-Doi-mat-khau.drawio](attachments/777-Doi-mat-khau.drawio)*',
    '',
    'Tiếp theo.',
  ];
  const sliceText = lines.join('\n');
  const result = replaceDrawioInSlice(sliceText, {
    diagramRel: 'docs-feature/acc/attachments/777-Doi-mat-khau.drawio',
    flowId: 'FLOW-doi-mat-khau',
    uxReview: {},
  });
  assert.ok(result, 'chỉ dòng nguồn vẫn phải thay được');
  const { text, change } = result!;
  assert.equal(change.before, lines[2]);
  assert.equal(
    text,
    ['### Mô tả', '', change.quote, '', 'Tiếp theo.'].join('\n'),
  );
});

test('replaceDrawioInSlice: (j) fallback — có ảnh lạ trong slice nhưng KHÔNG có dòng nguồn khớp stem, không ảnh khớp stem → vẫn null (không vơ nhầm ảnh không liên quan)', () => {
  const lines = [
    '### Khác',
    '',
    '![ảnh khác](attachments/unrelated-abc.png)',
    '',
    'Không có gì liên quan.',
  ];
  const sliceText = lines.join('\n');
  const result = replaceDrawioInSlice(sliceText, {
    diagramRel: 'docs-feature/acc/attachments/777-Doi-mat-khau.drawio',
    flowId: 'FLOW-doi-mat-khau',
    uxReview: {},
  });
  assert.equal(result, null);
});

/* ── (f) finalizeFlowUx persist FlowInput.diagram vào FlowIndexEntry ──────── */

test('finalizeFlowUx: entry.diagram được ghi lại từ FlowInput.diagram (mục A) — trước WP này bị bỏ rơi dù đã có trên FlowInput', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-drawio-diagram-'));
  try {
    const dir = path.join(cwd, 'docs-feature', 'sim');
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURES, 'sample-compressed.drawio'),
      path.join(dir, 'attachments', '12345-Luong-mua-sim.drawio'),
    );
    fs.writeFileSync(
      path.join(dir, 'doc2.md'),
      '# Doc 2\n\n![flow-diagram Luong](attachments/12345-Luong-mua-sim.drawio)\n',
    );

    const prep = await prepareFlowUxInputs(cwd);
    const drawioInput = prep.inputs.find((i) => i.kind === 'drawio')!;
    assert.ok(drawioInput, 'phải có đúng một FlowInput kind=drawio');
    assert.equal(drawioInput.diagram, 'docs-feature/sim/attachments/12345-Luong-mua-sim.drawio');

    const fdir = path.join(cwd, 'flows', drawioInput.id);
    fs.writeFileSync(path.join(fdir, 'ux-review.json'), JSON.stringify({ verdict: 'good', summary: 'ok', findings: [] }));

    const fin = await finalizeFlowUx(cwd);
    const entry = fin.index.find((e) => e.id === drawioInput.id)!;
    assert.ok(entry, 'entry tương ứng phải có trong index.json');
    assert.equal(entry.diagram, 'docs-feature/sim/attachments/12345-Luong-mua-sim.drawio');
    assert.deepEqual(entry.page, drawioInput.page);

    // index.json trên đĩa cũng phải mang field này (không chỉ giá trị in-memory).
    const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, 'flows', 'index.json'), 'utf8')) as Array<{ id: string; diagram?: string; page?: { index: number; name: string; count: number } }>;
    const onDiskEntry = onDisk.find((e) => e.id === drawioInput.id)!;
    assert.equal(onDiskEntry.diagram, 'docs-feature/sim/attachments/12345-Luong-mua-sim.drawio');
    assert.deepEqual(onDiskEntry.page, drawioInput.page);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
