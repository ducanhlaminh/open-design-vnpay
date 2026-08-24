// WP-drreview-mmd-color-badge — sơ đồ mermaid ĐỀ XUẤT chỉ có màu highlight
// khi AGENT tự tô 3 classDef od-added/od-modified/od-removed
// (skills/docs-flow-ux/SKILL.md mục 4b). `ensureProposedMermaidHighlight`
// (flow-ux/mermaid-highlight.ts) bù màu khi agent quên — đối xứng với
// draw.io (daemon tô qua patch.ts, không phụ thuộc agent). Test hàm THUẦN
// (a-e của accept) + một vòng tích hợp qua finalizeFlowUx (proposed.mmd trên
// đĩa được ghi đè khi bù màu).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { ensureProposedMermaidHighlight } from '../src/flow-ux/mermaid-highlight.js';
import { finalizeFlowUx } from '../src/flow-ux/index.js';

const AS_IS = ['flowchart TD', 'A([Bắt đầu]) --> B[Chọn gói cước]', 'B --> C[Xác nhận]'].join('\n');

test('(a) proposed đã có :::od-added nhưng thiếu classDef → chỉ append 3 classDef; đã đủ classDef → nguyên văn từng byte', () => {
  const proposedNoClassDef = [
    'flowchart TD',
    'A([Bắt đầu]) --> B[Chọn gói cước]',
    'B --> C[Xác nhận]',
    'B --> D[Thêm mới]:::od-added',
  ].join('\n');
  const result = ensureProposedMermaidHighlight(AS_IS, proposedNoClassDef);
  assert.notEqual(result, proposedNoClassDef, 'phải bù thêm classDef');
  assert.equal(result.startsWith(proposedNoClassDef.replace(/\n+$/, '')), true, 'không đụng nội dung gốc');
  assert.match(result, /^classDef od-added fill:#D5E8D4,stroke:#82B366,color:#1B4D1F$/m);
  assert.match(result, /^classDef od-modified fill:#FFF2CC,stroke:#D6B656,color:#5C4A00$/m);
  assert.match(result, /^classDef od-removed fill:#F8CECC,stroke:#B85450,stroke-dasharray:5 5,color:#5C1F1B$/m);

  const already = appendClassDefs(proposedNoClassDef);
  const second = ensureProposedMermaidHighlight(AS_IS, already);
  assert.equal(second, already, 'đã đủ 3 classDef → trả nguyên văn từng byte');
});

test('(b) node mới trong proposed (chưa tô) → có class <id> od-added + 3 classDef', () => {
  const proposed = ['flowchart TD', 'A([Bắt đầu]) --> B[Chọn gói cước]', 'B --> C[Xác nhận]', 'B --> D[Thêm mới]'].join('\n');
  const result = ensureProposedMermaidHighlight(AS_IS, proposed);
  assert.match(result, /^classDef od-added fill:#D5E8D4,stroke:#82B366,color:#1B4D1F$/m);
  assert.match(result, /^classDef od-modified fill:#FFF2CC,stroke:#D6B656,color:#5C4A00$/m);
  assert.match(result, /^classDef od-removed fill:#F8CECC,stroke:#B85450,stroke-dasharray:5 5,color:#5C1F1B$/m);
  assert.match(result, /^class D od-added$/m);
  assert.equal(/^class .+ od-modified$/m.test(result), false, 'không có node sửa nào');
});

test('(c) node đổi nhãn (chưa tô) → od-modified', () => {
  const proposed = ['flowchart TD', 'A([Bắt đầu]) --> B[Chọn gói cước (mới)]', 'B --> C[Xác nhận]'].join('\n');
  const result = ensureProposedMermaidHighlight(AS_IS, proposed);
  assert.match(result, /^class B od-modified$/m);
  assert.equal(/^class .+ od-added$/m.test(result), false, 'không có node thêm nào');
});

test('(d) hai sơ đồ giống hệt (chưa tô) → trả proposed NGUYÊN VĂN TỪNG BYTE', () => {
  const identical = `${AS_IS}\n`;
  const result = ensureProposedMermaidHighlight(AS_IS, identical);
  assert.equal(result, identical);
});

test('(e) dòng classDef/class/%% trong input không bị parse thành node', () => {
  const proposed = [
    'flowchart TD',
    '%% ghi chú C[Không phải node]',
    'A([Bắt đầu]) --> B[Chọn gói cước]',
    'B --> C[Xác nhận]',
    'classDef fake fill:#000',
    'class B fake',
  ].join('\n');
  // Không dùng bất kỳ class od-* nào → vẫn ở nhánh "chưa tô"; diff không thấy
  // gì thêm/sửa thật (C[Không phải node] trong dòng %% không được coi là một
  // khai báo node) → trả nguyên văn.
  const result = ensureProposedMermaidHighlight(AS_IS, proposed);
  assert.equal(result, proposed);
});

function appendClassDefs(code: string): string {
  return `${code}\nclassDef od-added fill:#D5E8D4,stroke:#82B366,color:#1B4D1F\nclassDef od-modified fill:#FFF2CC,stroke:#D6B656,color:#5C4A00\nclassDef od-removed fill:#F8CECC,stroke:#B85450,stroke-dasharray:5 5,color:#5C1F1B\n`;
}

test('finalizeFlowUx: proposed.mmd chưa tô màu → sau finalize file trên đĩa có class od-added + 3 classDef', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-flow-ux-mmd-highlight-'));
  try {
    const fdir = path.join(cwd, 'flows', 'FLOW-mua-goi');
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'as-is.mmd'), `${AS_IS}\n`);
    fs.writeFileSync(
      path.join(fdir, 'proposed.mmd'),
      `${AS_IS}\nB --> D[Thêm bước xác nhận số điện thoại]\n`,
    );
    fs.writeFileSync(
      path.join(fdir, 'screens.json'),
      JSON.stringify({ title: 'Mua gói cước', source: 'docs-feature/urd.md' }),
    );
    fs.writeFileSync(
      path.join(fdir, 'ux-review.json'),
      JSON.stringify({ verdict: 'needs-improvement', summary: 'thiếu xác nhận', findings: [{ severity: 'minor', title: 'x', reason: 'x' }] }),
    );

    const fin = await finalizeFlowUx(cwd);
    assert.equal(fin.index.length, 1);
    const onDisk = fs.readFileSync(path.join(fdir, 'proposed.mmd'), 'utf8');
    assert.match(onDisk, /^classDef od-added fill:#D5E8D4,stroke:#82B366,color:#1B4D1F$/m);
    assert.match(onDisk, /^class D od-added$/m);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
