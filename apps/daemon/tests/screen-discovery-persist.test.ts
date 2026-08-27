// WP dr-screens-merge (2026-08-27): hậu xử lý dr-screens tách thành
// persistScreenDiscovery (screen-discovery.ts) — dùng chung cho dr-screens chạy
// tay lẫn dr-flow (screens.json v2). Bất biến: anchorText đối chiếu tất định,
// 0 màn hợp lệ → ok:false và KHÔNG ghi gì đè kết quả cũ.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { SCREENS_DISCOVERED_FILE, SCREENS_DISCOVERED_MD_FILE, persistScreenDiscovery } from '../src/screen-discovery.js';
import { SCREENS_MANIFEST_FILE } from '../src/screen-overrides.js';

const PRD_MD = ['# PRD', '', '## 6.1.1 Trang chủ', '', 'Mô tả.', '', '## 6.2.1 Danh sách gói', '', '### Bộ lọc', '', 'Khối lọc.', ''].join('\n');

function setup(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-'));
  fs.mkdirSync(path.join(cwd, 'docs-feature'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'docs-feature', 'prd.md'), PRD_MD);
  return cwd;
}

test('persistScreenDiscovery: ghi screens-discovered.json (+schema_version/generatedAt) + .md + comp/_screens.json; anchor sai → rejected', async () => {
  const cwd = setup();
  const doc = {
    schema_version: 1,
    pages: [
      {
        source: 'docs-feature/prd.md',
        screens: [
          { code: '6.1.1', name: 'Trang chủ', anchorText: '## 6.1.1 Trang chủ' },
          { code: '6.2.1', name: 'Danh sách gói', anchorText: '## 6.2.1 Danh sách gói', blocks: [{ name: 'Bộ lọc', anchorText: '### Bộ lọc' }] },
          { code: '9.9', name: 'Không có trong trang', anchorText: '## 9.9 Ma' },
        ],
      },
    ],
    excluded: [{ name: 'Mục lục', source: 'docs-feature/prd.md', reason: 'Chỉ liệt kê.' }],
  };
  const r = await persistScreenDiscovery({
    cwd,
    pages: [{ mdPath: 'docs-feature/prd.md' }],
    doc,
    md: '# Bản người đọc\n',
    generatedAt: '2026-08-27T00:00:00.000Z',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.accepted, 2);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0]!, /không tìm thấy anchorText/);
  assert.equal(r.excludedCount, 1);
  assert.deepEqual(r.suggestions, []);

  const persisted = JSON.parse(fs.readFileSync(path.join(cwd, SCREENS_DISCOVERED_FILE), 'utf8')) as {
    schema_version: number; generatedAt: string; pages: Array<{ screens: Array<{ blocks?: unknown[] }> }>; excluded: unknown[];
  };
  assert.equal(persisted.schema_version, 1);
  assert.equal(persisted.generatedAt, '2026-08-27T00:00:00.000Z');
  // Doc giữ nguyên như nhận (kể cả màn bị loại + blocks) — người review thấy đủ khai báo của agent.
  assert.equal(persisted.pages[0]!.screens.length, 3);
  assert.equal(persisted.pages[0]!.screens[1]!.blocks?.length, 1);
  assert.equal(persisted.excluded.length, 1);
  assert.equal(fs.readFileSync(path.join(cwd, SCREENS_DISCOVERED_MD_FILE), 'utf8'), '# Bản người đọc\n');

  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, SCREENS_MANIFEST_FILE), 'utf8')) as {
    schema_version: number; screens: Array<{ key: string; code: string; name: string; origin: string; line: number | null }>;
  };
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(manifest.screens.map((s) => [s.key, s.code, s.origin]), [
    ['prd__6.1.1', '6.1.1', 'agent'],
    ['prd__6.2.1', '6.2.1', 'agent'],
  ]);
  assert.equal(manifest.screens[0]!.line, 3);
});

test('persistScreenDiscovery: generatedAt sẵn có được giữ; không đưa md → không ghi .md (agent tự ghi); readMd tuỳ biến', async () => {
  const cwd = setup();
  fs.writeFileSync(path.join(cwd, SCREENS_DISCOVERED_MD_FILE), 'bản agent');
  const r = await persistScreenDiscovery({
    cwd,
    pages: [{ mdPath: 'docs-feature/prd.md' }],
    doc: { schema_version: 1, generatedAt: '2000-01-01T00:00:00.000Z', pages: [{ source: 'docs-feature/prd.md', screens: [{ code: null, name: 'Trang chủ', anchorText: '## 6.1.1 Trang chủ' }] }] },
    readMd: async (rel) => (rel === 'docs-feature/prd.md' ? PRD_MD : null),
    generatedAt: '2026-08-27T00:00:00.000Z',
  });
  assert.equal(r.ok, true);
  const persisted = JSON.parse(fs.readFileSync(path.join(cwd, SCREENS_DISCOVERED_FILE), 'utf8')) as { generatedAt: string };
  assert.equal(persisted.generatedAt, '2000-01-01T00:00:00.000Z');
  assert.equal(fs.readFileSync(path.join(cwd, SCREENS_DISCOVERED_MD_FILE), 'utf8'), 'bản agent');
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, SCREENS_MANIFEST_FILE), 'utf8')) as { screens: Array<{ key: string }> };
  assert.deepEqual(manifest.screens.map((s) => s.key), ['prd__X1'], 'code null → X1');
});

test('persistScreenDiscovery: 0 màn hợp lệ → ok:false, KHÔNG ghi discovery/manifest đè bản cũ; doc không phải object → ok:false', async () => {
  const cwd = setup();
  fs.mkdirSync(path.join(cwd, 'comp'), { recursive: true });
  fs.writeFileSync(path.join(cwd, SCREENS_MANIFEST_FILE), '{"old":true}');
  const r = await persistScreenDiscovery({
    cwd,
    pages: [{ mdPath: 'docs-feature/prd.md' }],
    doc: { schema_version: 1, pages: [{ source: 'docs-feature/prd.md', screens: [{ code: '1', name: 'Ma', anchorText: '## không có' }] }] },
    md: 'x',
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /không xuất được màn hình hợp lệ nào/);
  assert.equal(r.rejected.length, 1);
  assert.equal(fs.readFileSync(path.join(cwd, SCREENS_MANIFEST_FILE), 'utf8'), '{"old":true}');
  assert.ok(!fs.existsSync(path.join(cwd, SCREENS_DISCOVERED_FILE)));
  assert.ok(!fs.existsSync(path.join(cwd, SCREENS_DISCOVERED_MD_FILE)));

  const bad = await persistScreenDiscovery({ cwd, pages: [{ mdPath: 'docs-feature/prd.md' }], doc: 'chuỗi' });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /không phải một object JSON/);
});

// WP dr-flow-improve: màn CHỈ có ở bản cải thiện (không anchor) đi nhánh
// riêng — vào manifest với origin flow / provenance proposed, ghi kèm
// `proposed` vào screens-discovered.json; trùng key màn tài liệu → màn tài liệu thắng.
test('persistScreenDiscovery: `proposed` nối vào sau màn tài liệu (không qua anchor), key trùng bị bỏ, field proposed persist', async () => {
  const cwd = setup();
  const doc = {
    schema_version: 1,
    pages: [{ source: 'docs-feature/prd.md', screens: [{ code: '6.1.1', name: 'Trang chủ', anchorText: '## 6.1.1 Trang chủ' }] }],
    excluded: [],
  };
  const r = await persistScreenDiscovery({
    cwd,
    pages: [{ mdPath: 'docs-feature/prd.md' }],
    doc,
    generatedAt: '2026-08-27T00:00:00.000Z',
    proposed: [
      { key: 'prd__NEW-xac-nhan', name: 'Xác nhận đơn', source: 'docs-feature/prd.md', why: 'Đề xuất cải thiện UX-01' },
      { key: 'prd__6.1.1', name: 'Trùng màn tài liệu' },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, SCREENS_MANIFEST_FILE), 'utf8')) as { screens: Array<{ key: string; name: string; origin: string }> };
  assert.deepEqual(manifest.screens.map((s) => [s.key, s.origin]), [['prd__6.1.1', 'agent'], ['prd__NEW-xac-nhan', 'flow']]);
  assert.equal(manifest.screens[0]!.name, 'Trang chủ', 'màn tài liệu thắng khi trùng key');
  const persisted = JSON.parse(fs.readFileSync(path.join(cwd, SCREENS_DISCOVERED_FILE), 'utf8')) as { proposed?: Array<{ key: string }> };
  assert.deepEqual(persisted.proposed?.map((p) => p.key), ['prd__NEW-xac-nhan', 'prd__6.1.1']);
  assert.ok(!fs.existsSync(path.join(cwd, SCREENS_DISCOVERED_MD_FILE)), 'không đưa md → không ghi');
});
