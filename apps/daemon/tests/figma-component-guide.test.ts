import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  renderComponentsGuideMarkdown,
  parseComponentsGuide,
  mergeCatalogueWithGuide,
  type ComponentsGuideEntry,
} from '../src/figma-component-guide.js';

/* ── render ↔ parse roundtrip ─────────────────────────────────────────────── */

const ENTRIES: ComponentsGuideEntry[] = [
  { anchor: 'figma-b8cf650d6d', name: 'Text Field', description: 'Ô nhập liệu chuẩn cho dữ liệu văn bản.' },
  { anchor: 'figma-297be0fb5f', name: 'Button', description: 'Nút bấm chuẩn | có ký tự đặc biệt' },
  { anchor: 'figma-empty', name: 'Không có mô tả', description: '' },
];

test('renderComponentsGuideMarkdown: có header cảnh báo AI-sinh (tiếng Việt) + mirror heading của components.md', () => {
  const md = renderComponentsGuideMarkdown(ENTRIES);
  assert.match(md, /AI sinh/);
  assert.match(md, /Figma LUÔN thắng/);
  assert.ok(md.includes('### `#figma-b8cf650d6d` Text Field'));
  assert.ok(md.includes('- Mô tả: Ô nhập liệu chuẩn cho dữ liệu văn bản.'));
});

test('renderComponentsGuideMarkdown → parseComponentsGuide roundtrip: đọc lại đúng anchor/name/description', () => {
  const md = renderComponentsGuideMarkdown(ENTRIES);
  const map = parseComponentsGuide(md);
  assert.equal(map.get('figma-b8cf650d6d')?.name, 'Text Field');
  assert.equal(map.get('figma-b8cf650d6d')?.description, 'Ô nhập liệu chuẩn cho dữ liệu văn bản.');
  assert.equal(map.get('figma-297be0fb5f')?.description, 'Nút bấm chuẩn | có ký tự đặc biệt');
  assert.equal(map.get('figma-empty')?.name, 'Không có mô tả');
  assert.equal(map.get('figma-empty')?.description, '');
});

test('parseComponentsGuide: khoan dung — markdown hỏng/rỗng không throw, trả Map rỗng', () => {
  assert.doesNotThrow(() => parseComponentsGuide(''));
  assert.equal(parseComponentsGuide('').size, 0);
  assert.doesNotThrow(() => parseComponentsGuide('không phải markdown có heading nào cả\nchỉ là văn bản trơn'));
});

/* ── mergeCatalogueWithGuide ──────────────────────────────────────────────── */

test('mergeCatalogueWithGuide: Figma thắng — anchor đã có mô tả trong catalogue giữ nguyên, KHÔNG lấy guide', () => {
  const catalogue = new Map([
    ['figma-297be0fb5f', { name: 'Button', description: 'Mô tả thật từ Figma.' }],
  ]);
  const guide = new Map([
    ['figma-297be0fb5f', { name: 'Button', description: 'Mô tả AI sinh — không được dùng.' }],
  ]);
  const merged = mergeCatalogueWithGuide(catalogue, guide);
  assert.equal(merged.get('figma-297be0fb5f')?.description, 'Mô tả thật từ Figma.');
  assert.equal(merged.get('figma-297be0fb5f')?.fromGuide, undefined);
});

test('mergeCatalogueWithGuide: catalogue thiếu mô tả → điền từ guide + đánh dấu fromGuide: true', () => {
  const catalogue = new Map([
    ['figma-no-desc', { name: 'Segmented Control', description: '' }],
  ]);
  const guide = new Map([
    ['figma-no-desc', { name: 'Segmented Control', description: 'Bộ chuyển đổi giữa các chế độ.' }],
  ]);
  const merged = mergeCatalogueWithGuide(catalogue, guide);
  assert.equal(merged.get('figma-no-desc')?.description, 'Bộ chuyển đổi giữa các chế độ.');
  assert.equal(merged.get('figma-no-desc')?.fromGuide, true);
  // Tên vẫn đến từ catalogue (Figma), không phải guide.
  assert.equal(merged.get('figma-no-desc')?.name, 'Segmented Control');
});

test('mergeCatalogueWithGuide: anchor chỉ có trong guide (không có trong catalogue) bị bỏ hẳn', () => {
  const catalogue = new Map([
    ['figma-still-there', { name: 'Button', description: '' }],
  ]);
  const guide = new Map([
    ['figma-deleted-from-figma', { name: 'Old Component', description: 'Component đã bị xoá khỏi Figma.' }],
  ]);
  const merged = mergeCatalogueWithGuide(catalogue, guide);
  assert.equal(merged.has('figma-deleted-from-figma'), false);
  assert.equal(merged.size, 1);
  // Anchor còn trong catalogue nhưng guide không có → giữ description rỗng, không lỗi.
  assert.equal(merged.get('figma-still-there')?.description, '');
  assert.equal(merged.get('figma-still-there')?.fromGuide, undefined);
});

test('mergeCatalogueWithGuide: catalogue thiếu mô tả VÀ guide cũng không có anchor đó → vẫn rỗng, không throw', () => {
  const catalogue = new Map([
    ['figma-none', { name: 'Card', description: '' }],
  ]);
  const merged = mergeCatalogueWithGuide(catalogue, new Map());
  assert.equal(merged.get('figma-none')?.description, '');
  assert.equal(merged.get('figma-none')?.fromGuide, undefined);
});
