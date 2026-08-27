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
  stageRegenSet,
} from '../src/pipelines.js';

function def(id: string) {
  const d = getPipelineDef(id);
  assert.ok(d, `pipeline ${id} phải có trong registry`);
  return d;
}

test('docs-review có đúng 5 stage, đúng thứ tự: dr-docs → dr-flow → dr-flow-improve → dr-mockup → dr-review (dr-screens gộp vào dr-flow, dr-comp ẩn 2026-08-27)', () => {
  const wf = WORKFLOWS.find((w) => w.id === 'docs-review');
  assert.ok(wf, 'workflow docs-review phải tồn tại');
  assert.deepEqual(wf!.pipelineIds, ['dr-docs', 'dr-flow', 'dr-flow-improve', 'dr-mockup', 'dr-review']);
  // WP dr-mockup: dr-comp GIỮ def (chạy tay khi App có DS) nhưng ẩn như dr-screens.
  assert.ok(getPipelineDef('dr-comp'));
  assert.equal(def('dr-comp').skillId, 'docs-screen-components');
  assert.equal(wf!.stages!.find((s) => s.id === 'dr-mockup')?.name, 'Mockup màn');
  // dr-screens GIỮ def (chạy tay khi tài liệu không có luồng) nhưng ẩn khỏi stepper/Run All như dr-confirm.
  assert.ok(getPipelineDef('dr-screens'));
  assert.equal(def('dr-screens').skillId, 'docs-screen-discovery');
  // Tên hiển thị của stage được suy từ PIPELINE_DEFS, không mirror bằng tay.
  assert.deepEqual(
    wf!.stages!.map((s) => s.id),
    wf!.pipelineIds,
  );
  // 2026-08-27 WP-screen-flow: dr-flow đổi vai review → SINH luồng màn hình.
  assert.equal(wf!.stages!.find((s) => s.id === 'dr-flow')?.name, 'Luồng màn hình');
  assert.equal(wf!.stages!.find((s) => s.id === 'dr-flow-improve')?.name, 'Cải thiện luồng');
});

// WP dr-flow-improve (2026-08-27): bước "Cải thiện luồng" đứng giữa dr-flow và
// dr-comp; dr-comp KHÔNG phụ thuộc nó (tuỳ chọn khi chạy lẻ, run-all có).
test('dr-flow-improve: skill docs-screen-flow-improve, chỉ phụ thuộc dr-flow, outputs là 5 file dưới flows/SCREEN-FLOW/ — KHÔNG có selection.json; dr-comp dependsOn không đổi', () => {
  const d = def('dr-flow-improve');
  assert.equal(d.skillId, 'docs-screen-flow-improve');
  assert.deepEqual(d.dependsOn, ['dr-flow']);
  assert.deepEqual(d.outputs, [
    'flows/SCREEN-FLOW/patch.json',
    'flows/SCREEN-FLOW/ux-review.json',
    'flows/SCREEN-FLOW/proposed.drawio',
    'flows/SCREEN-FLOW/proposed.edited.json',
    'flows/SCREEN-FLOW/screens.improved.json',
  ]);
  assert.equal(d.skippedInLeanRun, undefined, 'docs-review không có cơ chế lean');
  assert.equal(workflowDirForPipeline('dr-flow-improve'), 'docs-review');
  assert.deepEqual([...upstreamStages('dr-flow-improve')].sort(), ['dr-docs', 'dr-flow']);
  assert.deepEqual(def('dr-comp').dependsOn, ['dr-docs', 'dr-flow']);
  // WP dr-mockup: dr-review không còn chờ dr-comp; dr-mockup cũng không chờ improve.
  assert.deepEqual(def('dr-review').dependsOn, ['dr-docs', 'dr-flow']);
  assert.deepEqual(def('dr-mockup').dependsOn, ['dr-docs', 'dr-flow']);
  // Gate docs-only: mở ngay khi dr-docs succeeded (như mọi bước sau ingest).
  assert.equal(computeActive({}, d), false);
  assert.equal(computeActive({ 'dr-docs': { status: 'succeeded' } }, d), true);
});

test('re-run dr-flow-improve chỉ xoá output của nó (patch/ux-review/proposed/marker/screens.improved), KHÔNG xoá as-is/selection; re-run dr-flow (cascade) xoá cả improve', () => {
  const own = [
    'docs-review/flows/SCREEN-FLOW/patch.json',
    'docs-review/flows/SCREEN-FLOW/ux-review.json',
    'docs-review/flows/SCREEN-FLOW/proposed.drawio',
    'docs-review/flows/SCREEN-FLOW/proposed.edited.json',
    'docs-review/flows/SCREEN-FLOW/screens.improved.json',
  ];
  for (const rel of own) {
    // WP dr-flow-result-split: khai tường minh THẮNG khai thư mục — dr-flow
    // chỉ chạm tới các file này qua `flows/` nên KHÔNG còn đồng sở hữu (trước
    // đây ['dr-flow','dr-flow-improve'] làm improve "Xong" ké khi dr-flow ghi).
    assert.deepEqual(stagesForOutput(rel).map((x) => x.id), ['dr-flow-improve'], rel);
    assert.equal(relClearedByRegen(rel, new Set(['dr-flow-improve']), 'docs-review'), true, rel);
    // …nhưng re-run dr-flow (cascade) vẫn dọn vì cascade chứa improve.
    assert.equal(relClearedByRegen(rel, new Set(['dr-flow', 'dr-flow-improve']), 'docs-review'), true, rel);
    // Re-run dr-flow KHÔNG cascade: file của improve sống sót (chủ riêng).
    assert.equal(relClearedByRegen(rel, new Set(['dr-flow']), 'docs-review'), false, rel);
    // Tín hiệu đĩa chỉ chấm improve, không chấm dr-flow.
    assert.equal(deriveStateFromLocalFiles([rel])['dr-flow'], undefined, rel);
  }
  for (const rel of ['docs-review/flows/SCREEN-FLOW/as-is.drawio', 'docs-review/flows/SCREEN-FLOW/selection.json', 'docs-review/flows/index.json', 'docs-review/flows/SCREEN-FLOW/screens.json']) {
    assert.deepEqual(stagesForOutput(rel).map((x) => x.id), ['dr-flow'], rel);
    assert.equal(relClearedByRegen(rel, new Set(['dr-flow-improve']), 'docs-review'), false, rel);
  }
  // Cascade từ dr-flow bao gồm improve + mockup + review (+ dr-comp/dr-screens ẩn — vô hại).
  const cascade = new Set(stageRegenSet('dr-flow', true));
  for (const id of ['dr-flow', 'dr-flow-improve', 'dr-mockup', 'dr-review']) assert.ok(cascade.has(id), id);
  assert.equal(relClearedByRegen('docs-review/flows/SCREEN-FLOW/selection.json', cascade, 'docs-review'), true);
  // WP dr-mockup: re-run dr-flow (cascade) xoá mockups/; re-run dr-mockup chỉ xoá mockups/.
  assert.equal(relClearedByRegen('docs-review/mockups/index.json', cascade, 'docs-review'), true);
  assert.equal(relClearedByRegen('docs-review/mockups/X.html', new Set(['dr-mockup']), 'docs-review'), true);
  assert.equal(relClearedByRegen('docs-review/flows/index.json', new Set(['dr-mockup']), 'docs-review'), false);
  assert.equal(deriveStateFromLocalFiles(['docs-review/mockups/index.json'])['dr-mockup']?.status, 'succeeded');
  // Tín hiệu đĩa: proposed.drawio đủ để suy dr-flow-improve = succeeded.
  const state = deriveStateFromLocalFiles(['docs-review/flows/SCREEN-FLOW/proposed.drawio']);
  assert.equal(state['dr-flow-improve']?.status, 'succeeded');
  // comp/_screens.json vẫn KHÔNG thuộc improve (không bị re-run improve xoá).
  assert.equal(relClearedByRegen('docs-review/comp/_screens.json', new Set(['dr-flow-improve']), 'docs-review'), false);
});

test('dr-flow: skill docs-screen-flow, phụ thuộc dr-docs, output flows/ ở GỐC workflow-dir', () => {
  const d = def('dr-flow');
  assert.equal(d.skillId, 'docs-screen-flow');
  assert.deepEqual(d.dependsOn, ['dr-docs']);
  // WP dr-screens-merge: dr-flow sở hữu luôn danh sách màn (3 output cũ của dr-screens).
  assert.deepEqual(d.outputs, ['flows/', 'screens-discovered.json', 'screens-discovered.md', 'comp/_screens.json']);
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
  // dr-review vẫn CHỐT ở cuối cấu trúc (dr-docs, dr-flow — WP dr-mockup bỏ
  // dr-comp); dòng này tả registry, không phải cổng active.
  assert.deepEqual(def('dr-review').dependsOn, ['dr-docs', 'dr-flow']);
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

// WP dr-screens-merge (2026-08-27): ba output discovery nay do dr-flow sinh.
test('attribution + re-run: screens-discovered.* thuộc dr-flow; comp/_screens.json CHỈ dr-flow (khai tường minh thắng comp/); screens-overrides.json không ai xoá', () => {
  for (const rel of ['docs-review/screens-discovered.json', 'docs-review/screens-discovered.md']) {
    assert.deepEqual(stagesForOutput(rel).map((d) => d.id), ['dr-flow'], rel);
    assert.equal(relClearedByRegen(rel, new Set(['dr-flow']), 'docs-review'), true, rel);
    assert.equal(relClearedByRegen(rel, new Set(['dr-comp']), 'docs-review'), false, rel);
  }
  // WP dr-flow-result-split: chủ DUY NHẤT là dr-flow (khai tên file tường
  // minh); dr-comp chỉ khai `comp/` nên không còn "Xong" ké qua file này và
  // re-run dr-comp scope 'stage' KHÔNG xoá nó (dr-comp lớp 3 vẫn ghi lại được).
  assert.deepEqual(stagesForOutput('docs-review/comp/_screens.json').map((d) => d.id), ['dr-flow']);
  assert.equal(relClearedByRegen('docs-review/comp/_screens.json', new Set(['dr-flow']), 'docs-review'), true);
  assert.equal(relClearedByRegen('docs-review/comp/_screens.json', new Set(['dr-comp']), 'docs-review'), false);
  assert.equal(deriveStateFromLocalFiles(['docs-review/comp/_screens.json'])['dr-comp'], undefined);
  // dr-screens ẩn (không trong pipelineIds) → không còn được chấm cho file của workflow này.
  assert.ok(!stagesForOutput('docs-review/screens-discovered.json').some((d) => d.id === 'dr-screens'));
  // Bất biến WP14: screens-overrides.json nằm ngoài mọi outputs → sống sót re-run dr-flow.
  assert.deepEqual(stagesForOutput('docs-review/screens-overrides.json'), []);
  assert.equal(relClearedByRegen('docs-review/screens-overrides.json', new Set(['dr-flow', 'dr-comp', 'dr-review']), 'docs-review'), false);
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
