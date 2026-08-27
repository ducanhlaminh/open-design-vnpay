// WP dr-mockup-layouts (2026-08-27): layout-kb.ts — resolve dir, manifest,
// archetype tiếng Việt không dấu, refs theo archetype. KB GIẢ trong tmp —
// không phụ thuộc ~/layout-kb thật.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';

import {
  ARCHETYPE_TOPICS,
  foldVi,
  guessArchetype,
  layoutRefsFor,
  loadLayoutKb,
  parseLayoutKbManifest,
  resolveLayoutKbDir,
} from '../src/layout-kb.js';

let dir: string;
let savedEnv: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'od-layout-kb-'));
  savedEnv = process.env.LAYOUT_KB_DIR;
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env.LAYOUT_KB_DIR;
  else process.env.LAYOUT_KB_DIR = savedEnv;
  await rm(dir, { recursive: true, force: true });
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function seedFakeKb(root: string): Promise<void> {
  await mkdir(join(root, 'wireframes'), { recursive: true });
  await writeFile(join(root, 'wireframes', '1.png'), PNG);
  await writeFile(join(root, 'wireframes', '2.png'), PNG);
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      source: 'enrico',
      license: 'MIT',
      builtAt: '2026-08-27T00:00:00.000Z',
      topics: {
        list: {
          count: 10,
          templates: [
            { id: 'list-appbar-search-list-fab', bands: ['appbar', 'search', 'list(5)', 'fab'], sketch: '┌┐\n└┘', samples: ['1'] },
            { id: 'list-appbar-tabs-list', bands: ['appbar', 'tabs', 'list(6)'], sketch: 'x', samples: ['2'] },
          ],
          samples: [
            { id: '1', wireframe: 'wireframes/1.png', bands: ['appbar', 'search', 'list(5)', 'fab'] },
            { id: '2', wireframe: 'wireframes/2.png', bands: ['appbar', 'tabs', 'list(6)'] },
          ],
        },
        form: {
          count: 4,
          templates: [{ id: 'form-appbar-form-button', bands: ['appbar', 'form(4)', 'button'], sketch: 'y', samples: ['2'] }],
          samples: [{ id: '2', wireframe: 'wireframes/2.png', bands: ['appbar', 'form(4)', 'button'] }],
        },
      },
    }),
    'utf8',
  );
}

test('resolveLayoutKbDir: env LAYOUT_KB_DIR có manifest → dir; thiếu manifest → null', async () => {
  process.env.LAYOUT_KB_DIR = dir;
  assert.equal(await resolveLayoutKbDir(), null);
  await seedFakeKb(dir);
  assert.equal(await resolveLayoutKbDir(), dir);
});

test('loadLayoutKb: đọc manifest typed, cache theo mtime, manifest hỏng → null', async () => {
  await seedFakeKb(dir);
  const kb = await loadLayoutKb(dir);
  assert.ok(kb);
  assert.equal(kb.dir, dir);
  assert.deepEqual(Object.keys(kb.manifest.topics).sort(), ['form', 'list']);
  assert.equal(kb.manifest.topics.list!.templates.length, 2);
  const again = await loadLayoutKb(dir);
  assert.equal(again, kb, 'cùng mtime → cùng object (cache)');
  await writeFile(join(dir, 'manifest.json'), '{not json', 'utf8');
  // Đổi mtime chắc chắn (fs mtime độ phân giải ms).
  const { utimes } = await import('node:fs/promises');
  await utimes(join(dir, 'manifest.json'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(await loadLayoutKb(dir), null);
  assert.equal(await loadLayoutKb(join(dir, 'nope')), null);
});

test('parseLayoutKbManifest: chịu field thiếu, bỏ template/sample sai khuôn', () => {
  const m = parseLayoutKbManifest(JSON.stringify({ topics: { list: { templates: [{ id: 'a' }, { nope: 1 }], samples: [{ id: '1' }, { id: '2', wireframe: 'w/2.png' }] } } }));
  assert.ok(m);
  assert.equal(m.schema_version, 1);
  assert.equal(m.source, 'enrico');
  assert.deepEqual(m.topics.list!.templates, [{ id: 'a', bands: [], sketch: '', samples: [] }]);
  assert.deepEqual(m.topics.list!.samples, [{ id: '2', wireframe: 'w/2.png', bands: [] }]);
  assert.equal(m.topics.list!.count, 1);
  assert.equal(parseLayoutKbManifest('[]'), null);
  assert.equal(parseLayoutKbManifest('{"topics": 3}'), null);
});

test('foldVi: bỏ dấu + đ, hạ chữ thường, gom ký tự lạ', () => {
  assert.equal(foldVi('Đăng ký — Thông tin (SĐT)'), 'dang ky thong tin sdt');
  assert.equal(foldVi('Chọn gói cước'), 'chon goi cuoc');
});

test('guessArchetype: từ khoá tiếng Việt không dấu, tên màn +1, ≥2 = high', () => {
  const g = (name: string, extra: Partial<Parameters<typeof guessArchetype>[0]> = {}) =>
    guessArchetype({ name, steps: [], navOut: [], navIn: [], ...extra });
  assert.deepEqual(g('Chọn quốc gia'), { id: 'picker', confidence: 'high' });
  assert.deepEqual(g('Danh sách gói cước'), { id: 'list', confidence: 'high' });
  assert.deepEqual(g('Nhập thông tin người mua'), { id: 'form', confidence: 'high' });
  assert.deepEqual(g('Xác nhận thanh toán'), { id: 'checkout', confidence: 'high' });
  assert.deepEqual(g('Thanh toán thành công'), { id: 'result', confidence: 'high' });
  assert.deepEqual(g('Thanh toán thất bại').id, 'result');
  assert.deepEqual(g('Đang xử lý giao dịch'), { id: 'status', confidence: 'high' });
  assert.deepEqual(g('Chi tiết gói'), { id: 'detail', confidence: 'high' });
  assert.deepEqual(g('Trang chủ'), { id: 'home', confidence: 'high' });
  assert.deepEqual(g('Cài đặt'), { id: 'settings', confidence: 'high' });
  assert.deepEqual(g('Popup xác nhận'), { id: 'overlay', confidence: 'high' });
  // Chỉ heading trúng (không phải tên) → 1 điểm = low.
  assert.deepEqual(g('SCR-007', { section: { heading: '### 4.7 SCR-007 Chi tiết', startLine: 1, endLine: 2, excerpt: '' } }), {
    id: 'detail',
    confidence: 'low',
  });
  // Không từ khoá: màn cuối luồng (có navIn, không navOut) → result low; còn lại content low.
  assert.deepEqual(g('SCR-009', { navIn: ['a'] }), { id: 'result', confidence: 'low' });
  assert.deepEqual(g('SCR-001'), { id: 'content', confidence: 'low' });
  // Không phân biệt dấu: viết không dấu vẫn trúng.
  assert.equal(g('Dang ky thong tin').id, 'form');
});

test('layoutRefsFor: luân phiên topic ưu tiên, ≤4 template, ảnh tuyệt đối khử trùng, topic vắng bị bỏ', async () => {
  await seedFakeKb(dir);
  const kb = (await loadLayoutKb(dir))!;
  // list → [list, news, gallery]: chỉ 'list' có trong KB giả.
  const list = layoutRefsFor(kb, 'list');
  assert.deepEqual(list.topics, ['list']);
  assert.deepEqual(list.templates.map((t) => t.id), ['list-appbar-search-list-fab', 'list-appbar-tabs-list']);
  assert.deepEqual(list.templates[0], { id: 'list-appbar-search-list-fab', bands: ['appbar', 'search', 'list(5)', 'fab'], sketch: '┌┐\n└┘' });
  assert.deepEqual(list.images, [join(dir, 'wireframes', '1.png'), join(dir, 'wireframes', '2.png')]);
  // form → [form, login]: chỉ form; sample '2' — 1 ảnh.
  const form = layoutRefsFor(kb, 'form');
  assert.deepEqual(form.topics, ['form']);
  assert.equal(form.templates.length, 1);
  assert.deepEqual(form.images, [join(dir, 'wireframes', '2.png')]);
  // result → [modal, tutorial]: không topic nào → rỗng.
  assert.deepEqual(layoutRefsFor(kb, 'result'), { topics: [], templates: [], images: [] });
  // Mọi archetype đều có mapping.
  for (const a of ['list', 'picker', 'detail', 'form', 'checkout', 'result', 'status', 'overlay', 'home', 'settings', 'content'] as const) {
    assert.ok(ARCHETYPE_TOPICS[a].length > 0, a);
  }
});
