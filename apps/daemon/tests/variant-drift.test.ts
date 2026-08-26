// WP-V5 lõi (docs/screen-variants-spec.md §WP-V5, subplan T5). Case 1 dùng
// đúng dữ liệu của fixture apps/daemon/tests/fixtures/multi-platform-cr.md
// (mục "Màn hình kết quả giao dịch": bảng MB có bullet "Phản hồi (bổ sung)"
// mà bảng IB không có — lỗi tài liệu thật cần bắt). Các case còn lại dùng
// dữ liệu tổng hợp cùng văn phong để cô lập từng luật.

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { diffVariantDescriptions, type VariantDescription } from '../src/variant-drift.js';

describe('diffVariantDescriptions', () => {
  test('lệch 1 bullet một phía (fixture "kết quả giao dịch") → đúng 1 finding, onlyIn đúng phía, bullet nguyên văn', () => {
    const entries: VariantDescription[] = [
      {
        key: 'man-hinh-ket-qua-giao-dich--mb',
        platform: 'mobile',
        descriptionBullets: ['Mã yêu cầu (bổ sung)', 'Số tiền GD (bổ sung)', 'Phản hồi (bổ sung)'],
      },
      {
        key: 'man-hinh-ket-qua-giao-dich--ib',
        platform: 'web',
        descriptionBullets: ['Mã yêu cầu (bổ sung)', 'Số tiền GD (bổ sung)'],
      },
    ];

    const findings = diffVariantDescriptions('cr-httt__G-man-hinh-ket-qua-giao-dich', entries);

    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.onlyIn, 'mobile');
    // bullet giữ NGUYÊN VĂN — chưa chuẩn hóa (chưa lowercase, chưa bỏ dấu câu)
    assert.equal(findings[0]!.bullet, 'Phản hồi (bổ sung)');
    assert.equal(findings[0]!.counterpartKey, 'man-hinh-ket-qua-giao-dich--ib');
    assert.equal(findings[0]!.groupKey, 'cr-httt__G-man-hinh-ket-qua-giao-dich');
  });

  test('2 danh sách tương đương khác thứ tự, khác marker (• vs -), khác hoa-thường → 0 finding', () => {
    const entries: VariantDescription[] = [
      {
        key: 'man-hinh-quan-ly--mb',
        platform: 'mobile',
        descriptionBullets: ['• Mã yêu cầu (bổ sung)', '- SỐ TIỀN giao dịch (bổ sung)'],
      },
      {
        key: 'man-hinh-quan-ly--ib',
        platform: 'web',
        // thứ tự đảo ngược + marker khác + hoa/thường khác
        descriptionBullets: ['* số tiền giao dịch (bổ sung)', '- mã yêu cầu (bổ sung).'],
      },
    ];

    const findings = diffVariantDescriptions('cr-httt__G-man-hinh-quan-ly', entries);

    assert.deepEqual(findings, []);
  });

  test('lệch cả 2 phía → finding cho từng phía', () => {
    const entries: VariantDescription[] = [
      {
        key: 'man-hinh-x--mb',
        platform: 'mobile',
        descriptionBullets: ['Bullet A', 'Bullet chung'],
      },
      {
        key: 'man-hinh-x--ib',
        platform: 'web',
        descriptionBullets: ['Bullet chung', 'Bullet C'],
      },
    ];

    const findings = diffVariantDescriptions('cr-httt__G-man-hinh-x', entries);

    assert.equal(findings.length, 2);
    const mobileFinding = findings.find((f) => f.onlyIn === 'mobile');
    const webFinding = findings.find((f) => f.onlyIn === 'web');
    assert.ok(mobileFinding);
    assert.ok(webFinding);
    assert.equal(mobileFinding!.bullet, 'Bullet A');
    assert.equal(mobileFinding!.counterpartKey, 'man-hinh-x--ib');
    assert.equal(webFinding!.bullet, 'Bullet C');
    assert.equal(webFinding!.counterpartKey, 'man-hinh-x--mb');
  });

  test('chỉ 1 entry → []', () => {
    const entries: VariantDescription[] = [
      { key: 'man-hinh-don--mb', platform: 'mobile', descriptionBullets: ['Bullet A'] },
    ];

    assert.deepEqual(diffVariantDescriptions('cr-httt__G-man-hinh-don', entries), []);
  });

  test('2 entry cùng platform → []', () => {
    const entries: VariantDescription[] = [
      { key: 'man-hinh-y--mb-1', platform: 'mobile', descriptionBullets: ['Bullet A'] },
      { key: 'man-hinh-y--mb-2', platform: 'mobile', descriptionBullets: ['Bullet B'] },
    ];

    assert.deepEqual(diffVariantDescriptions('cr-httt__G-man-hinh-y', entries), []);
  });
});
