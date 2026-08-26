// screen-variants WP-V1 (docs/screen-variants-spec.md §WP-V1) — test thuần
// cho resolveScreenPlatform(), dùng fixture chung
// tests/fixtures/multi-platform-cr.md (dựng ở T0) + vài doc rút gọn cho ca
// biên không có sẵn trong fixture.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { PLATFORM_HEADING_KEYWORDS, resolveScreenPlatform } from '../src/screen-platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'multi-platform-cr.md');

async function readFixture(): Promise<string> {
  return fs.readFile(FIXTURE_PATH, 'utf8');
}

// Số dòng (1-based) cố định trong fixture — nếu fixture đổi thì test này
// phải xét lại theo nội dung mới, không đoán.
const LINE = {
  headingMB: 35, // ### 2.2 Màn hình MB
  rowUnderMB: 39, // | **Màn hình quản lý yêu cầu của tôi** |  |  |
  rowUnderIB: 52, // | **Màn hình quản lý yêu cầu của tôi** |  |  | (dưới 2.3)
  headingBO: 61, // ### 2.4 Màn hình BO quản lý yêu cầu hỗ trợ
  boldUnderBO: 63, // **Màn hình quản lý yêu cầu hỗ trợ** (bold thuần, không phải heading)
  brRowWithSDK: 85, // BR-2 ... "SDK" ... — nội dung, KHÔNG phải heading
};

describe('resolveScreenPlatform', () => {
  test('màn dưới heading "### 2.2 Màn hình MB" → mobile', async () => {
    const md = await readFixture();
    assert.equal(resolveScreenPlatform(md, LINE.rowUnderMB), 'mobile');
  });

  test('sectionStartLine trỏ thẳng vào chính dòng heading MB → mobile', async () => {
    const md = await readFixture();
    assert.equal(resolveScreenPlatform(md, LINE.headingMB), 'mobile');
  });

  test('màn dưới heading "### 2.3 Màn hình IB" → web', async () => {
    const md = await readFixture();
    assert.equal(resolveScreenPlatform(md, LINE.rowUnderIB), 'web');
  });

  test('màn dưới heading "### 2.4 Màn hình BO ..." → web (leo từ dòng bold không-heading)', async () => {
    const md = await readFixture();
    assert.equal(resolveScreenPlatform(md, LINE.boldUnderBO), 'web');
  });

  test('sectionStartLine trỏ thẳng vào heading BO → web', async () => {
    const md = await readFixture();
    assert.equal(resolveScreenPlatform(md, LINE.headingBO), 'web');
  });

  test('mục 2.5 (BR) chứa "SDK" trong NỘI DUNG nhưng heading cha không khớp → null', async () => {
    const md = await readFixture();
    // Chứng minh: dòng chứa chữ SDK không phải heading nên không được đọc;
    // chỉ heading "### 2.5 Các yêu cầu nghiệp vụ bổ sung" (không khớp từ
    // khóa nào) và tổ tiên "## II. Mô tả thay đổi" (cũng không khớp) được xét.
    assert.equal(resolveScreenPlatform(md, LINE.brRowWithSDK), null);
  });

  test('doc không heading nào khớp từ khóa → null', () => {
    const md = ['# Tài liệu tổng quan', '', '## Giới thiệu chức năng', '', 'Nội dung mô tả chung.'].join('\n');
    // sectionStartLine trỏ vào dòng nội dung cuối
    assert.equal(resolveScreenPlatform(md, 5), null);
  });

  test('doc không có heading nào phía trên sectionStartLine → null', () => {
    const md = ['Dòng mở đầu không heading.', 'Dòng thứ hai.'].join('\n');
    assert.equal(resolveScreenPlatform(md, 2), null);
  });

  test('heading cha khớp web nhưng heading gần hơn khớp mobile → gần nhất thắng', () => {
    const md = [
      '# Nền tảng Web tổng quan', // level 1, khớp "web"
      '## Màn hình MB đăng nhập', // level 2, khớp "MB" — gần section hơn
      'Nội dung màn hình.',
    ].join('\n');
    assert.equal(resolveScreenPlatform(md, 3), 'mobile');
  });

  test('heading anh em đứng trước không phải cha — không được xét', () => {
    const md = [
      '## Màn hình MB đăng nhập', // level 2, anh em — đứng trước nhưng KHÔNG bao section dưới
      '## Màn hình chi tiết BO', // level 2, cha thật của section
      'Nội dung màn hình.',
    ].join('\n');
    assert.equal(resolveScreenPlatform(md, 3), 'web');
  });

  test('PLATFORM_HEADING_KEYWORDS export đủ mobile/web theo spec §WP-V1', () => {
    const mobile = PLATFORM_HEADING_KEYWORDS.filter((k) => k.platform === 'mobile');
    const web = PLATFORM_HEADING_KEYWORDS.filter((k) => k.platform === 'web');
    assert.equal(mobile.length, 7);
    assert.equal(web.length, 8);
    assert.ok(mobile.some((k) => k.pattern.test('SDK')));
    assert.ok(web.some((k) => k.pattern.test('Quản trị hệ thống')));
  });
});
