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
  WEB_ARCHETYPE_TOPICS,
  countLayoutKbTopics,
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

// ── WP layout-kb-web (2026-08-28): manifest v2 có platform; màn web chỉ nhận
// topic web; màn mobile byte-identical; guessArchetype table/dashboard chỉ khi web.

/** KB v2: topic Enrico (list/form như seedFakeKb) + 3 topic web viết tay (samples rỗng). */
async function seedFakeKbV2(root: string): Promise<void> {
  await seedFakeKb(root);
  const v1 = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'manifest.json'), 'utf8'));
  const web = (topic: string, ids: string[]) => ({
    platform: 'web',
    count: ids.length,
    templates: ids.map((slug) => ({ id: `${topic}-${slug}`, bands: ['topbar', 'sidenav', slug], sketch: `sketch ${topic}-${slug}`, samples: [] })),
    samples: [],
  });
  const v2 = {
    ...v1,
    schema_version: 2,
    sources: [
      { id: 'enrico', license: 'MIT' },
      { id: 'web-templates', license: 'hand-authored', note: 'viết tay' },
    ],
    topics: {
      ...v1.topics,
      'web-table': web('web-table', ['filterbar-table', 'tabs-table']),
      'web-list': web('web-list', ['hero-cards']),
      'web-form': web('web-form', ['form-2col', 'modal']),
    },
  };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(v2), 'utf8');
}

test('parseLayoutKbManifest: v1 → mọi topic platform mobile, không sources; v2 giữ platform web + sources', async () => {
  await seedFakeKb(dir);
  const { readFile } = await import('node:fs/promises');
  const v1 = parseLayoutKbManifest(await readFile(join(dir, 'manifest.json'), 'utf8'))!;
  assert.equal(v1.schema_version, 1);
  assert.equal(v1.sources, undefined);
  assert.deepEqual(Object.values(v1.topics).map((t) => t.platform), ['mobile', 'mobile']);
  assert.deepEqual(countLayoutKbTopics(v1), { mobile: 2, web: 0 });

  await seedFakeKbV2(dir);
  const v2 = parseLayoutKbManifest(await readFile(join(dir, 'manifest.json'), 'utf8'))!;
  assert.equal(v2.schema_version, 2);
  assert.deepEqual(v2.sources, [
    { id: 'enrico', license: 'MIT' },
    { id: 'web-templates', license: 'hand-authored', note: 'viết tay' },
  ]);
  assert.equal(v2.topics.list!.platform, 'mobile');
  assert.equal(v2.topics['web-table']!.platform, 'web');
  assert.equal(v2.topics['web-table']!.count, 2);
  assert.deepEqual(v2.topics['web-table']!.samples, []);
  assert.deepEqual(countLayoutKbTopics(v2), { mobile: 2, web: 3 });
  // platform lạ → mobile; sources sai khuôn bị bỏ.
  const odd = parseLayoutKbManifest(JSON.stringify({ topics: { x: { platform: 'tv' } }, sources: [{ nope: 1 }, { id: 'a' }] }))!;
  assert.equal(odd.topics.x!.platform, 'mobile');
  assert.deepEqual(odd.sources, [{ id: 'a', license: '' }]);
});

test('layoutRefsFor v1 (KB cũ): mobile mặc định y hệt trước (snapshot); màn web → rỗng vì không có topic web', async () => {
  await seedFakeKb(dir);
  const kb = (await loadLayoutKb(dir))!;
  const snapshot = {
    topics: ['list'],
    templates: [
      { id: 'list-appbar-search-list-fab', bands: ['appbar', 'search', 'list(5)', 'fab'], sketch: '┌┐\n└┘' },
      { id: 'list-appbar-tabs-list', bands: ['appbar', 'tabs', 'list(6)'], sketch: 'x' },
    ],
    images: [join(dir, 'wireframes', '1.png'), join(dir, 'wireframes', '2.png')],
  };
  assert.deepEqual(layoutRefsFor(kb, 'list'), snapshot);
  assert.deepEqual(layoutRefsFor(kb, 'list', 'mobile'), snapshot);
  for (const a of ['list', 'table', 'form', 'home', 'dashboard', 'picker'] as const) {
    assert.deepEqual(layoutRefsFor(kb, a, 'web'), { topics: [], templates: [], images: [] }, a);
  }
});

test('layoutRefsFor v2: màn web chỉ nhận topic web (không ảnh khi samples rỗng); màn mobile không đổi so với v1', async () => {
  await seedFakeKb(dir);
  const mobileV1 = layoutRefsFor((await loadLayoutKb(dir))!, 'list');
  await seedFakeKbV2(dir);
  const { utimes } = await import('node:fs/promises');
  await utimes(join(dir, 'manifest.json'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const kb = (await loadLayoutKb(dir))!;
  const webList = layoutRefsFor(kb, 'list', 'web');
  assert.deepEqual(webList.topics, ['web-table', 'web-list']);
  // Luân phiên: web-table[0], web-list[0], web-table[1].
  assert.deepEqual(webList.templates.map((t) => t.id), ['web-table-filterbar-table', 'web-list-hero-cards', 'web-table-tabs-table']);
  assert.deepEqual(webList.templates[0], { id: 'web-table-filterbar-table', bands: ['topbar', 'sidenav', 'filterbar-table'], sketch: 'sketch web-table-filterbar-table' });
  assert.deepEqual(webList.images, []);
  assert.ok(webList.topics.every((t) => t.startsWith('web-')), 'không lẫn topic mobile');
  assert.deepEqual(layoutRefsFor(kb, 'table', 'web').topics, ['web-table']);
  assert.deepEqual(layoutRefsFor(kb, 'picker', 'web').topics, ['web-form']);
  assert.deepEqual(layoutRefsFor(kb, 'form', 'web').topics, ['web-form'], 'web-wizard không có trong KB → bỏ');
  assert.deepEqual(layoutRefsFor(kb, 'settings', 'web'), { topics: [], templates: [], images: [] });
  // Mobile: v2 có thêm topic web nhưng refs mobile y hệt v1.
  assert.deepEqual(layoutRefsFor(kb, 'list'), mobileV1);
  assert.deepEqual(layoutRefsFor(kb, 'list', 'mobile'), mobileV1);
  // Màn mobile không bao giờ nhận topic web dù archetype table/dashboard.
  assert.deepEqual(layoutRefsFor(kb, 'table', 'mobile').topics, ['list']);
  assert.ok(!layoutRefsFor(kb, 'dashboard', 'mobile').topics.some((t) => t.startsWith('web-')));
  // Bảng web: đủ khoá archetype, mọi topic tiền tố web-.
  for (const a of Object.keys(ARCHETYPE_TOPICS) as Array<keyof typeof ARCHETYPE_TOPICS>) {
    assert.ok(WEB_ARCHETYPE_TOPICS[a]?.length > 0, a);
    assert.ok(WEB_ARCHETYPE_TOPICS[a].every((t) => t.startsWith('web-')), a);
  }
});

test('guessArchetype: table/dashboard CHỈ khi platform web; mobile/vắng platform như cũ', () => {
  const g = (name: string, platform?: 'mobile' | 'web') => guessArchetype({ name, steps: [], navOut: [], navIn: [] }, platform);
  assert.deepEqual(g('Danh sách giao dịch', 'web'), { id: 'table', confidence: 'high' });
  assert.deepEqual(g('Quản lý người dùng', 'web'), { id: 'table', confidence: 'high' });
  assert.deepEqual(g('Tra cứu đơn hàng', 'web'), { id: 'table', confidence: 'high' });
  assert.deepEqual(g('Tổng quan', 'web'), { id: 'dashboard', confidence: 'high' });
  assert.deepEqual(g('Báo cáo doanh thu', 'web'), { id: 'dashboard', confidence: 'high' });
  assert.deepEqual(g('Thống kê', 'web').id, 'dashboard');
  // Cùng tên, mobile / vắng platform → không bao giờ table/dashboard.
  assert.deepEqual(g('Danh sách giao dịch'), { id: 'list', confidence: 'high' });
  assert.deepEqual(g('Danh sách giao dịch', 'mobile'), { id: 'list', confidence: 'high' });
  assert.deepEqual(g('Tổng quan'), { id: 'content', confidence: 'low' });
  assert.deepEqual(g('Quản lý người dùng', 'mobile'), { id: 'content', confidence: 'low' });
  // Web nhưng không từ khoá bảng/dashboard → bảng chung như cũ.
  assert.deepEqual(g('Chọn quốc gia', 'web'), { id: 'picker', confidence: 'high' });
  assert.deepEqual(g('Nhập thông tin người mua', 'web'), { id: 'form', confidence: 'high' });
  assert.deepEqual(g('Thanh toán thành công', 'web'), { id: 'result', confidence: 'high' });
  assert.deepEqual(g('Cài đặt', 'web'), { id: 'settings', confidence: 'high' });
});
