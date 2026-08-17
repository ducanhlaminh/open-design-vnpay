// Bước `dr-flow` — Sơ đồ luồng màn hình của workflow `docs-review`: đọc tài
// liệu đã nạp (`docs/`) và emit `flows/<FLOW-ID>.flowchart.json`. Chạy TRƯỚC
// dr-review — review là bước chốt cuối của workflow.
//
// Điều đáng khoá nhất ở đây là CHỖ ĐẶT output: `flows/` phải nằm NGANG HÀNG
// `review/`, không lồng trong nó. Lồng vào thì (a) một lần re-run dr-review
// xoá sạch sơ đồ vừa dựng và (b) stagesForOutput chấm cả dr-review lẫn dr-flow
// cho cùng một file, làm dr-review hiện xanh chỉ vì dr-flow đã chạy.
import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  WORKFLOWS,
  computeActive,
  deriveStateFromLocalFiles,
  getPipelineDef,
  relClearedByRegen,
  stagesForOutput,
  upstreamStages,
  workflowDirForPipeline,
} from '../src/pipelines.js';

function def(id: string) {
  const d = getPipelineDef(id);
  assert.ok(d, `pipeline ${id} phải có trong registry`);
  return d;
}

test('docs-review có đúng 4 stage, đúng thứ tự: dr-docs → dr-flow → dr-comp → dr-review', () => {
  const wf = WORKFLOWS.find((w) => w.id === 'docs-review');
  assert.ok(wf, 'workflow docs-review phải tồn tại');
  assert.deepEqual(wf!.pipelineIds, ['dr-docs', 'dr-flow', 'dr-comp', 'dr-review']);
  // Tên hiển thị của stage được suy từ PIPELINE_DEFS, không mirror bằng tay.
  assert.deepEqual(
    wf!.stages!.map((s) => s.id),
    wf!.pipelineIds,
  );
  assert.equal(wf!.stages!.find((s) => s.id === 'dr-flow')?.name, 'Sơ đồ luồng màn hình');
});

test('dr-flow: skill docs-flow-extract, phụ thuộc dr-docs, output flows/ ở GỐC workflow-dir', () => {
  const d = def('dr-flow');
  assert.equal(d.skillId, 'docs-flow-extract');
  assert.deepEqual(d.dependsOn, ['dr-docs']);
  assert.deepEqual(d.outputs, ['flows/']);
  // File-only; không nhận upload / design system / platform.
  assert.equal(d.acceptsUpload, undefined);
  assert.equal(d.acceptsDesignSystem, undefined);
  // Namespace thư mục là của chính workflow này.
  assert.equal(workflowDirForPipeline('dr-flow'), 'docs-review');
  // Input cần có trước khi chạy = đúng bước nạp tài liệu, không hơn.
  assert.deepEqual([...upstreamStages('dr-flow')].sort(), ['dr-docs']);
});

test('gating: dr-flow mở ngay khi dr-docs succeeded; dr-review (docs-only gate) cũng mở ngay khi dr-docs succeeded — không còn phải đợi dr-comp/dr-flow', () => {
  assert.equal(computeActive({}, def('dr-flow')), false);
  assert.equal(computeActive({ 'dr-docs': { status: 'succeeded' } }, def('dr-flow')), true);
  // dependsOn của registry KHÔNG đổi — dr-review vẫn CHỐT ở cuối cấu trúc
  // (dr-docs, dr-comp, dr-flow); dòng này tả registry, không phải cổng active.
  assert.deepEqual(def('dr-review').dependsOn, ['dr-docs', 'dr-flow', 'dr-comp']);
  // 2026-08 docs-only gate: dr-review chỉ còn chờ bước ingest của workflow này
  // (dr-docs) — dr-comp/dr-flow có chạy hay chưa không còn gate gì cả.
  assert.equal(
    computeActive(
      { 'dr-docs': { status: 'succeeded' }, 'dr-comp': { status: 'succeeded' } },
      def('dr-review'),
    ),
    true,
  );
  assert.equal(
    computeActive(
      {
        'dr-docs': { status: 'succeeded' },
        'dr-comp': { status: 'succeeded' },
        'dr-flow': { status: 'succeeded' },
      },
      def('dr-review'),
    ),
    true,
  );
  // Chưa có dr-docs (bước ingest) → vẫn khoá, dù dr-comp/dr-flow (giả định)
  // đã xong — docs-only gate chỉ đọc trạng thái của ingest, không đọc gì khác.
  assert.equal(
    computeActive(
      { 'dr-comp': { status: 'succeeded' }, 'dr-flow': { status: 'succeeded' } },
      def('dr-review'),
    ),
    false,
  );
});

test('attribution: flows/*.flowchart.json thuộc dr-flow và KHÔNG thuộc dr-review', () => {
  for (const rel of [
    'docs-review/flows/FLOW-login.flowchart.json',
    'docs-review/flows/index.json',
  ]) {
    assert.deepEqual(stagesForOutput(rel).map((d) => d.id), ['dr-flow'], rel);
  }
  // …và review/ vẫn chỉ thuộc dr-review — hai cây output không giẫm lên nhau.
  assert.deepEqual(
    stagesForOutput('docs-review/review/docs/confluence/x.md').map((d) => d.id),
    ['dr-review'],
  );
  // Một file flows/ tự nó đủ để suy ra dr-flow = succeeded (tín hiệu đĩa).
  const state = deriveStateFromLocalFiles(['docs-review/flows/FLOW-login.flowchart.json']);
  assert.equal(state['dr-flow']?.status, 'succeeded');
  assert.equal(state['dr-review'], undefined);
});

test('re-run: chạy lại dr-review không xoá flows/, chạy lại dr-flow không xoá review/', () => {
  const flow = 'docs-review/flows/FLOW-login.flowchart.json';
  const review = 'docs-review/review/docs/confluence/x.md';
  assert.equal(relClearedByRegen(flow, new Set(['dr-review']), 'docs-review'), false);
  assert.equal(relClearedByRegen(review, new Set(['dr-flow']), 'docs-review'), false);
  // Mỗi stage vẫn dọn đúng cây của mình.
  assert.equal(relClearedByRegen(flow, new Set(['dr-flow']), 'docs-review'), true);
  assert.equal(relClearedByRegen(review, new Set(['dr-review']), 'docs-review'), true);
  // Cascade từ dr-review (reset downstream) mới quét cả hai.
  const cascade = new Set(['dr-review', 'dr-flow']);
  assert.equal(relClearedByRegen(flow, cascade, 'docs-review'), true);
  assert.equal(relClearedByRegen(review, cascade, 'docs-review'), true);
});

test('trùng tên thư mục flows/ với stage ux của docs-to-ui là vô hại — attribution có namespace', () => {
  assert.deepEqual(
    stagesForOutput('docs-to-ui/flows/FLOW-TRANSFER.flow.json').map((d) => d.id),
    ['ux'],
  );
  assert.deepEqual(
    stagesForOutput('docs-review/flows/FLOW-login.flowchart.json').map((d) => d.id),
    ['dr-flow'],
  );
});
