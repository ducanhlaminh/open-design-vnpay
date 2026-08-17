// dr-comp (2026-08-17) vẽ thêm `wireframes/<SCREEN-KEY>.html` mỗi màn. Test này
// khoá hai chuyện daemon dựa vào trong runDocsComponentAuditFanout (server.ts):
//   1. `wireframes/` là output của RIÊNG dr-comp trong docs-review → re-run
//      clear dọn nó, và bất kỳ file nào dưới đó (kể cả `_wireframe.css` daemon
//      copy sẵn) tự nó đủ chấm dr-comp = succeeded khi suy từ đĩa — đó là lý
//      do fail-shut cấp stage phải xoá cả `wireframes/` chứ không chỉ `comp/`.
//   2. Nguồn CSS daemon copy vào `<cwd>/wireframes/_wireframe.css` là
//      `skills/ux-spec/assets/wireframe.css` (resolve qua SKILLS_DIR) — file
//      phải tồn tại và có các class mà hợp đồng wireframe của skill dùng.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { deriveStateFromLocalFiles, getPipelineDef, relClearedByRegen, stagesForOutput } from '../src/pipelines.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('dr-comp khai outputs comp/ + wireframes/, cả hai ở gốc docs-review', () => {
  assert.deepEqual(getPipelineDef('dr-comp')?.outputs, ['comp/', 'wireframes/']);
});

test('docs-review/wireframes/* thuộc RIÊNG dr-comp — kể cả _wireframe.css daemon copy sẵn', () => {
  for (const rel of [
    'docs-review/wireframes/_wireframe.css',
    'docs-review/wireframes/2.1.1-URD-Quan-ly-nhan-vien__SCR-001.html',
  ]) {
    assert.deepEqual(stagesForOutput(rel).map((d) => d.id), ['dr-comp'], rel);
    assert.equal(deriveStateFromLocalFiles([rel])['dr-comp']?.status, 'succeeded', rel);
  }
  // Re-run dr-comp dọn wireframes/ trước khi copy CSS + fan-out lại.
  assert.equal(relClearedByRegen('docs-review/wireframes/_wireframe.css', new Set(['dr-comp']), 'docs-review'), true);
  // wireframes/ của workflow docs-to-ui (stage ux) KHÔNG dính tới dr-comp.
  assert.equal(stagesForOutput('docs-to-ui/wireframes/x.html').some((d) => d.id === 'dr-comp'), false);
});

test('skills/ux-spec/assets/wireframe.css tồn tại và có các class hợp đồng wireframe dùng', async () => {
  const css = await readFile(path.join(REPO_ROOT, 'skills', 'ux-spec', 'assets', 'wireframe.css'), 'utf8');
  for (const cls of ['.wf-web', '.wf-mobile', '.wf-component', '.wf-card', '.wf-section']) {
    assert.ok(css.includes(cls), `wireframe.css phải có ${cls}`);
  }
  assert.ok(css.includes('attr(data-comp)'), 'wireframe.css phải hiện data-comp trên block');
});
