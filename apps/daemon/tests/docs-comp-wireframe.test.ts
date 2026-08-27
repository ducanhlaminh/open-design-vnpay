// dr-comp (2026-08-17) vẽ thêm `wireframes/<SCREEN-KEY>.html` mỗi màn.
// WP dr-mockup (2026-08-27): dr-comp RÚT KHỎI workflow docs-review (def giữ, ẩn
// như dr-screens) → `stagesForOutput` (lọc theo pipelineIds của workflow) KHÔNG
// còn chấm dr-comp cho `docs-review/comp/**` lẫn `docs-review/wireframes/**`:
// không "Xong" ké từ đĩa, re-run clear generic không đụng (fan-out tự dọn
// comp/ + wireframes/ ở mọi đường thoát). Test này khoá hành vi mới + nguồn
// CSS daemon copy (`skills/ux-spec/assets/wireframe.css`) vẫn tồn tại.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { deriveStateFromLocalFiles, getPipelineDef, relClearedByRegen, stagesForOutput, WORKFLOWS } from '../src/pipelines.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('dr-comp khai outputs comp/ + wireframes/ nhưng ẩn khỏi mọi workflow (WP dr-mockup)', () => {
  assert.deepEqual(getPipelineDef('dr-comp')?.outputs, ['comp/', 'wireframes/']);
  assert.ok(!WORKFLOWS.some((w) => w.pipelineIds.includes('dr-comp')));
});

test('docs-review/wireframes/* và comp/* KHÔNG còn thuộc dr-comp — không Xong ké, không bị re-run clear generic', () => {
  for (const rel of [
    'docs-review/wireframes/_wireframe.css',
    'docs-review/wireframes/2.1.1-URD-Quan-ly-nhan-vien__SCR-001.html',
    'docs-review/comp/_doc-screens.json',
    'docs-review/comp/screen-flows/index.json',
    'docs-review/comp/screen-flows/FLOW-mua-sim.screen-flow.json',
  ]) {
    assert.deepEqual(stagesForOutput(rel), [], rel);
    assert.equal(deriveStateFromLocalFiles([rel])['dr-comp'], undefined, rel);
    assert.equal(relClearedByRegen(rel, new Set(['dr-comp']), 'docs-review'), false, rel);
  }
  // wireframes/ của workflow docs-to-ui (stage ux) vẫn không dính tới dr-comp.
  assert.equal(stagesForOutput('docs-to-ui/wireframes/x.html').some((d) => d.id === 'dr-comp'), false);
});

test('skills/ux-spec/assets/wireframe.css tồn tại và có các class hợp đồng wireframe dùng', async () => {
  const css = await readFile(path.join(REPO_ROOT, 'skills', 'ux-spec', 'assets', 'wireframe.css'), 'utf8');
  for (const cls of ['.wf-web', '.wf-mobile', '.wf-component', '.wf-card', '.wf-section']) {
    assert.ok(css.includes(cls), `wireframe.css phải có ${cls}`);
  }
  assert.ok(css.includes('attr(data-comp)'), 'wireframe.css phải hiện data-comp trên block');
});

// WP14 (lớp 3 — overrides + manifest): screens-overrides.json là NGUỒN SỰ
// THẬT do người dùng giữ, nằm NGAY DƯỚI docs-review/ (NGOÀI comp/) — cùng
// tầng criteria/, đúng lý do criteria/ sống sót re-run clear.
test('re-run KHÔNG xoá docs-review/screens-overrides.json (lớp 3, người dùng giữ)', () => {
  const rel = 'docs-review/screens-overrides.json';
  assert.deepEqual(stagesForOutput(rel), []);
  assert.equal(relClearedByRegen(rel, new Set(['dr-comp']), 'docs-review'), false);
  assert.equal(relClearedByRegen(rel, new Set(['dr-flow', 'dr-mockup', 'dr-review']), 'docs-review'), false);
});

test('comp/_screens.json vẫn là file của dr-flow (khai tường minh); flows/ thuộc dr-flow', () => {
  assert.deepEqual(stagesForOutput('docs-review/comp/_screens.json').map((d) => d.id), ['dr-flow']);
  assert.equal(relClearedByRegen('docs-review/comp/_screens.json', new Set(['dr-flow']), 'docs-review'), true);
  assert.equal(relClearedByRegen('docs-review/comp/_screens.json', new Set(['dr-mockup']), 'docs-review'), false);
  for (const rel of ['docs-review/flows/index.json', 'docs-review/flows/FLOW-mua-sim/as-is.drawio']) {
    assert.deepEqual(stagesForOutput(rel).map((d) => d.id), ['dr-flow'], rel);
    assert.equal(relClearedByRegen(rel, new Set(['dr-mockup']), 'docs-review'), false, rel);
  }
});
