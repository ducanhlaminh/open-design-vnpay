import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';

import {
  buildDescribeInput,
  computeGuideCoverage,
  computeMissingDescriptions,
  generateComponentDescriptions,
  mergeGuideEntries,
  summarizeNodeTree,
  validateDescribeOutput,
  type GuideGenerationDeps,
  type MissingComponentDescription,
} from '../src/figma-guide-generate.js';
import { parseComponentsGuide, renderComponentsGuideMarkdown } from '../src/figma-component-guide.js';
import { anchorFor, FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION, type FigmaComponentCatalogSnapshot } from '../src/figma-component-catalog.js';

function snapshotOf(components: Array<{ nodeId: string; name: string; description?: string }>): FigmaComponentCatalogSnapshot {
  return {
    schemaVersion: FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION,
    generatedAt: '2026-08-19T00:00:00.000Z',
    files: [{
      fileKey: 'ABC',
      name: 'Kit',
      url: 'https://www.figma.com/design/ABC',
      components: components.map((c) => ({ nodeId: c.nodeId, name: c.name, ...(c.description ? { description: c.description } : {}), properties: [] })),
    }],
  };
}

/* ── computeMissingDescriptions ───────────────────────────────────────────── */

test('computeMissingDescriptions: không guide → mọi component không có mô tả Figma đều thiếu', () => {
  const snapshot = snapshotOf([
    { nodeId: '1:1', name: 'Button', description: 'Nút bấm.' },
    { nodeId: '1:2', name: 'Card' },
  ]);
  const missing = computeMissingDescriptions(snapshot, null);
  assert.equal(missing.length, 1);
  assert.equal(missing[0]!.name, 'Card');
  assert.equal(missing[0]!.anchor, anchorFor('ABC', '1:2'));
  assert.equal(missing[0]!.fileKey, 'ABC');
  assert.equal(missing[0]!.nodeId, '1:2');
});

test('computeMissingDescriptions: anchor đã có trong guide thì KHÔNG còn thiếu', () => {
  const snapshot = snapshotOf([{ nodeId: '1:2', name: 'Card' }]);
  const anchor = anchorFor('ABC', '1:2');
  const guideMd = renderComponentsGuideMarkdown([{ anchor, name: 'Card', description: 'Đã có mô tả AI sinh.' }]);
  const missing = computeMissingDescriptions(snapshot, guideMd);
  assert.equal(missing.length, 0);
});

test('computeMissingDescriptions: component đã có mô tả Figma thì bỏ qua dù guide không biết anchor', () => {
  const snapshot = snapshotOf([{ nodeId: '1:1', name: 'Button', description: 'Có rồi.' }]);
  const missing = computeMissingDescriptions(snapshot, '');
  assert.equal(missing.length, 0);
});

/* ── computeGuideCoverage ─────────────────────────────────────────────────── */

test('computeGuideCoverage: đếm total/described/fromGuide/missing đúng', () => {
  const snapshot = snapshotOf([
    { nodeId: '1:1', name: 'Button', description: 'Có mô tả Figma.' },
    { nodeId: '1:2', name: 'Card' },
    { nodeId: '1:3', name: 'Badge' },
  ]);
  const guideMd = renderComponentsGuideMarkdown([{ anchor: anchorFor('ABC', '1:2'), name: 'Card', description: 'Mô tả AI.' }]);
  const coverage = computeGuideCoverage(snapshot, guideMd);
  assert.deepEqual(coverage, { total: 3, described: 2, fromGuide: 1, missing: 1 });
});

/* ── summarizeNodeTree ────────────────────────────────────────────────────── */

test('summarizeNodeTree: giữ name/type/characters, đệ quy con', () => {
  const node = { name: 'Button', type: 'COMPONENT', children: [{ name: 'Label', type: 'TEXT', characters: 'Lưu' }] };
  const tree = summarizeNodeTree(node);
  assert.equal(tree?.name, 'Button');
  assert.equal(tree?.type, 'COMPONENT');
  assert.equal(tree?.children?.[0]?.name, 'Label');
  assert.equal(tree?.children?.[0]?.characters, 'Lưu');
});

test('summarizeNodeTree: null khi input không phải object node', () => {
  assert.equal(summarizeNodeTree(null), null);
  assert.equal(summarizeNodeTree('not-a-node'), null);
});

function buildChain(depth: number): unknown {
  let node: any = { name: `leaf`, type: 'TEXT' };
  for (let i = depth; i >= 0; i -= 1) {
    node = { name: `n${i}`, type: 'FRAME', children: [node] };
  }
  return node;
}

test('summarizeNodeTree: cắt sâu ở tầng mặc định (6) — node ở tầng đó không còn children, có truncated + childCount', () => {
  const tree = summarizeNodeTree(buildChain(10));
  let node = tree;
  let depth = 0;
  while (node?.children && depth < 20) {
    node = node.children[0];
    depth += 1;
  }
  // Duyệt tới node bị cắt (không còn children) — phải dừng đúng ở tầng cắt,
  // không sớm hơn hay muộn hơn, và phải đánh dấu truncated + giữ childCount.
  assert.equal(depth, 6);
  assert.equal(node?.truncated, true);
  assert.equal(node?.childCount, 1);
  assert.equal(node?.children, undefined);
});

test('summarizeNodeTree: cap ký tự — cây rất rộng bị cắt bớt tới khi JSON.stringify vừa cap', () => {
  const wide = { name: 'Root', type: 'FRAME', children: Array.from({ length: 500 }, (_, i) => ({ name: `Item ${i}`, type: 'INSTANCE', characters: `Nội dung lặp lại số ${i} để tăng kích thước JSON đáng kể` })) };
  const cap = 1_000;
  const tree = summarizeNodeTree(wide, cap);
  const size = JSON.stringify(tree).length;
  assert.ok(size <= cap, `expected <= ${cap}, got ${size}`);
  assert.equal(tree?.truncated, true);
  assert.ok((tree?.children?.length ?? 0) < 500);
});

/* ── buildDescribeInput ───────────────────────────────────────────────────── */

test('buildDescribeInput: gắn đúng tree/image theo nodeId, thiếu thì null', () => {
  const batch: MissingComponentDescription[] = [
    { fileKey: 'ABC', nodeId: '1:1', anchor: 'figma-a', name: 'Button', properties: [] },
    { fileKey: 'ABC', nodeId: '1:2', anchor: 'figma-b', name: 'Card', page: 'Actions', properties: [] },
  ];
  const treeByNode = new Map([['1:1', { name: 'Button', type: 'COMPONENT' }]]);
  const imagePathByNode = new Map([['1:1', 'img-figma-a.png']]);
  const input = buildDescribeInput(batch, treeByNode, imagePathByNode);
  assert.equal(input.components.length, 2);
  assert.deepEqual(input.components[0], { anchor: 'figma-a', name: 'Button', properties: [], tree: { name: 'Button', type: 'COMPONENT' }, image: 'img-figma-a.png' });
  assert.deepEqual(input.components[1], { anchor: 'figma-b', name: 'Card', page: 'Actions', properties: [], tree: null, image: null });
});

/* ── validateDescribeOutput ───────────────────────────────────────────────── */

const ALLOWED = new Map([['figma-a', 'Button'], ['figma-b', 'Card']]);

test('validateDescribeOutput: chấp nhận entry hợp lệ, collapse khoảng trắng', () => {
  const raw = JSON.stringify([{ anchor: 'figma-a', description: '  Nút   bấm  chính   của form.  ' }]);
  const result = validateDescribeOutput(raw, ALLOWED);
  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.accepted, [{ anchor: 'figma-a', description: 'Nút bấm chính của form.' }]);
});

test('validateDescribeOutput: JSON hỏng → 1 rejected, 0 accepted', () => {
  const result = validateDescribeOutput('không phải JSON', ALLOWED);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
});

test('validateDescribeOutput: không phải mảng → rejected', () => {
  const result = validateDescribeOutput(JSON.stringify({ anchor: 'figma-a', description: 'x' }), ALLOWED);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
});

test('validateDescribeOutput: anchor ngoài batch bị loại', () => {
  const raw = JSON.stringify([{ anchor: 'figma-ngoai-batch', description: 'Mô tả hợp lệ về độ dài.' }]);
  const result = validateDescribeOutput(raw, ALLOWED);
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0]!.reason, /không thuộc batch/);
});

test('validateDescribeOutput: description rỗng/thiếu bị loại', () => {
  const raw = JSON.stringify([{ anchor: 'figma-a', description: '   ' }]);
  const result = validateDescribeOutput(raw, ALLOWED);
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0]!.reason, /thiếu description/);
});

test('validateDescribeOutput: description quá 300 ký tự bị loại', () => {
  const raw = JSON.stringify([{ anchor: 'figma-a', description: 'x'.repeat(301) }]);
  const result = validateDescribeOutput(raw, ALLOWED);
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0]!.reason, /độ dài/);
});

test('validateDescribeOutput: description chứa "|" bị loại (vỡ ô bảng)', () => {
  const raw = JSON.stringify([{ anchor: 'figma-a', description: 'Nút | bấm' }]);
  const result = validateDescribeOutput(raw, ALLOWED);
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0]!.reason, /\|/);
});

test('validateDescribeOutput: description chứa xuống dòng nguyên văn bị loại', () => {
  const raw = JSON.stringify([{ anchor: 'figma-a', description: 'Dòng một.\nDòng hai.' }]);
  const result = validateDescribeOutput(raw, ALLOWED);
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0]!.reason, /xuống dòng/);
});

test('validateDescribeOutput: description trùng nguyên văn tên component (không phân biệt hoa/thường) bị loại', () => {
  const raw = JSON.stringify([{ anchor: 'figma-a', description: '  button  ' }]);
  const result = validateDescribeOutput(raw, ALLOWED);
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0]!.reason, /trùng nguyên văn tên/);
});

test('validateDescribeOutput: anchor lặp lại trong cùng output — giữ cái đầu, loại cái sau', () => {
  const raw = JSON.stringify([
    { anchor: 'figma-a', description: 'Mô tả đầu tiên hợp lệ.' },
    { anchor: 'figma-a', description: 'Mô tả thứ hai cũng hợp lệ.' },
  ]);
  const result = validateDescribeOutput(raw, ALLOWED);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0]!.description, 'Mô tả đầu tiên hợp lệ.');
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]!.reason, /lặp lại/);
});

/* ── mergeGuideEntries ────────────────────────────────────────────────────── */

test('mergeGuideEntries: giữ entry cũ khi accepted không đụng tới anchor đó', () => {
  const snapshot = snapshotOf([{ nodeId: '1:1', name: 'Button' }, { nodeId: '1:2', name: 'Card' }]);
  const anchorButton = anchorFor('ABC', '1:1');
  const anchorCard = anchorFor('ABC', '1:2');
  const existing = renderComponentsGuideMarkdown([{ anchor: anchorButton, name: 'Button', description: 'Mô tả cũ của Button.' }]);
  const md = mergeGuideEntries(existing, [{ anchor: anchorCard, description: 'Mô tả mới của Card.' }], snapshot);
  const map = parseComponentsGuide(md) as Map<string, { description: string }>;
  assert.equal(map.get(anchorButton)?.description, 'Mô tả cũ của Button.');
  assert.equal(map.get(anchorCard)?.description, 'Mô tả mới của Card.');
});

test('mergeGuideEntries: entry mới thắng entry cũ CÙNG anchor', () => {
  const snapshot = snapshotOf([{ nodeId: '1:1', name: 'Button' }]);
  const anchor = anchorFor('ABC', '1:1');
  const existing = renderComponentsGuideMarkdown([{ anchor, name: 'Button', description: 'Mô tả cũ.' }]);
  const md = mergeGuideEntries(existing, [{ anchor, description: 'Mô tả mới thắng.' }], snapshot);
  const map = parseComponentsGuide(md) as Map<string, { description: string }>;
  assert.equal(map.get(anchor)?.description, 'Mô tả mới thắng.');
});

test('mergeGuideEntries: lọc anchor ngoài snapshot (component đã bị xoá khỏi Figma)', () => {
  const snapshot = snapshotOf([{ nodeId: '1:1', name: 'Button' }]);
  const anchorButton = anchorFor('ABC', '1:1');
  const anchorDeleted = 'figma-deleted';
  const existing = renderComponentsGuideMarkdown([
    { anchor: anchorButton, name: 'Button', description: 'Mô tả Button.' },
    { anchor: anchorDeleted, name: 'Xoá rồi', description: 'Mô tả của component đã xoá.' },
  ]);
  const md = mergeGuideEntries(existing, [], snapshot);
  const map = parseComponentsGuide(md) as Map<string, { description: string }>;
  assert.equal(map.has(anchorDeleted), false);
  assert.equal(map.get(anchorButton)?.description, 'Mô tả Button.');
});

test('mergeGuideEntries: existingGuideMd null + accepted rỗng → guide rỗng (không throw)', () => {
  const snapshot = snapshotOf([{ nodeId: '1:1', name: 'Button' }]);
  const md = mergeGuideEntries(null, [], snapshot);
  assert.doesNotThrow(() => parseComponentsGuide(md));
  assert.equal(parseComponentsGuide(md).size, 0);
});

/* ── generateComponentDescriptions (điểm 1 review WP19b-fix) ─────────────── */
// "chunk thành công" phải đếm theo LƯỢT AGENT chạy xong (đọc/parse được
// output), không phải theo số THÔNG ĐIỆP lỗi phụ trong chunkErrors — một
// chunk có thể đẩy 2 message lỗi phụ (tree + ảnh) mà agent vẫn chạy ra output
// hợp lệ (dù 0 accepted). Trước fix, `chunkErrors.length >= chunks.length`
// đánh oan job này là failed dù chunk duy nhất đã chạy xong.
let baseDir = '';

beforeEach(() => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'od-guide-generate-'));
});

afterEach(() => {
  if (baseDir) rmSync(baseDir, { recursive: true, force: true });
});

test('generateComponentDescriptions: 1 chunk lỗi tree+ảnh (2 message) nhưng agent chạy xong (0 accepted) → KHÔNG throw, job coi là succeeded', async () => {
  const snapshot = snapshotOf([{ nodeId: '1:1', name: 'Button' }]);
  const deps: GuideGenerationDeps = {
    baseDir,
    fetchTree: async () => {
      throw new Error('tree lỗi mạng');
    },
    fetchImages: async () => {
      throw new Error('ảnh lỗi mạng');
    },
    downloadImage: async () => false,
    runAgentChunk: async () => JSON.stringify([]), // agent chạy xong, đọc/parse được output, chỉ là 0 entry được chấp nhận
  };
  const result = await generateComponentDescriptions(snapshot, null, deps);
  assert.equal(result.generated, 0);
  assert.equal(result.chunkErrors.length, 2); // 2 message lỗi phụ (tree + ảnh) của cùng 1 chunk
});
