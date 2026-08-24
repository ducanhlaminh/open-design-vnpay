// WP-dr-review-readability mục D: sơ đồ đề xuất không còn cạnh song song tự
// mâu thuẫn — `findUnlabeledParallelEdges` (flow-ux/index.ts) cảnh báo khi một
// nhánh đề xuất thêm một đường mới nhưng vẫn giữ nguyên cạnh cũ bị thay thế mà
// không gắn nhãn (đo trên dự án dich-vu-mua-sim: `J1 --> K` (cũ) tồn tại song
// song với `J1 --> OD_InvoiceAndTotal --> K` (mới), không nhãn nào phân biệt).
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { findUnlabeledParallelEdges } from '../src/flow-ux/index.js';

const AS_IS = ['flowchart TD', 'J1 --> K'].join('\n');

test('findUnlabeledParallelEdges: nhánh mới thêm J1 --> OD_X --> K nhưng vẫn giữ J1 --> K không nhãn → đúng 1 cảnh báo nêu đúng cặp', () => {
  const proposed = ['flowchart TD', 'J1 --> OD_X', 'OD_X --> K', 'J1 --> K'].join('\n');
  const warnings = findUnlabeledParallelEdges(AS_IS, proposed);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /"J1 --> K"/);
  assert.match(warnings[0]!, /"J1 --> OD_X"/);
  assert.match(warnings[0]!, /cạnh song song không nhãn/);
});

test('findUnlabeledParallelEdges: cạnh cũ ĐÃ gắn nhãn bất kỳ → không cảnh báo', () => {
  const proposed = ['flowchart TD', 'J1 --> OD_X', 'OD_X --> K', 'J1 -- "hiện trạng — bỏ nếu áp dụng UX-01" --> K'].join('\n');
  const warnings = findUnlabeledParallelEdges(AS_IS, proposed);
  assert.deepEqual(warnings, []);
});

test('findUnlabeledParallelEdges: cạnh cũ đã bị XOÁ khỏi proposed.mmd → không cảnh báo', () => {
  const proposed = ['flowchart TD', 'J1 --> OD_X', 'OD_X --> K'].join('\n');
  const warnings = findUnlabeledParallelEdges(AS_IS, proposed);
  assert.deepEqual(warnings, []);
});

test('findUnlabeledParallelEdges: proposed không thêm node mới nào → không cảnh báo', () => {
  const proposed = ['flowchart TD', 'J1 --> K'].join('\n');
  const warnings = findUnlabeledParallelEdges(AS_IS, proposed);
  assert.deepEqual(warnings, []);
});

test('findUnlabeledParallelEdges: dòng %%/classDef/class không sinh cạnh giả', () => {
  const proposed = [
    'flowchart TD',
    '%% ghi chú không phải cạnh',
    'classDef od-added fill:#D5E8D4,stroke:#82B366,color:#1B4D1F',
    'class OD_X od-added',
    'J1 --> OD_X',
    'OD_X --> K',
    'J1 --> K',
  ].join('\n');
  const warnings = findUnlabeledParallelEdges(AS_IS, proposed);
  // Vẫn đúng 1 cảnh báo (từ cặp J1/K/OD_X thật) — các dòng %%/classDef/class
  // không được coi là cạnh và không sinh thêm cảnh báo giả nào khác.
  assert.equal(warnings.length, 1);
});
