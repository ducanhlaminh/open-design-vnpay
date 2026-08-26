// screen-variants WP-V5, subplan T8 (docs/screen-variants-spec.md §WP-V5).
// Case (a) dùng đúng fixture apps/daemon/tests/fixtures/multi-platform-cr.md
// (mục "Màn hình kết quả giao dịch": bảng MB có bullet "Phản hồi (bổ sung)"
// mà bảng IB không có) với một manifest v2 giả lập (nhóm --app/--web theo
// hậu tố chuẩn hoá mới — xem screen-groups.ts). Case (b)/(c) kiểm zero-cost
// gate cho tài liệu một-nền-tảng (manifest v1 hoặc không entry nào có
// groupKey).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

import type { ScreensManifest } from '@open-design/contracts';

import { scanVariantDriftFromDocs } from '../src/variant-drift-scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = 'multi-platform-cr.md';
const FIXTURE_MD = fs.readFileSync(path.join(__dirname, 'fixtures', FIXTURE_SOURCE), 'utf8');

const GROUP_KEY = 'multi-platform-cr__G-man-hinh-ket-qua-giao-dich';

function manifestWithKetQuaGroup(): ScreensManifest {
  return {
    schema_version: 2,
    screens: [
      {
        key: 'multi-platform-cr__ket-qua--app',
        code: 'ket-qua--app',
        name: 'Màn hình kết quả giao dịch',
        source: FIXTURE_SOURCE,
        origin: 'doc',
        line: 43, // dòng bold "**Màn hình kết quả giao dịch**" trong bảng MB (2.2)
        hasSection: true,
        platform: 'mobile',
        groupKey: GROUP_KEY,
      },
      {
        key: 'multi-platform-cr__ket-qua--web',
        code: 'ket-qua--web',
        name: 'Màn hình kết quả giao dịch',
        source: FIXTURE_SOURCE,
        origin: 'doc',
        line: 56, // dòng bold tương ứng trong bảng IB (2.3)
        hasSection: true,
        platform: 'web',
        groupKey: GROUP_KEY,
      },
    ],
  };
}

describe('scanVariantDriftFromDocs', () => {
  test('fixture multi-platform-cr.md, nhóm "kết quả giao dịch" --app/--web → 1 finding "Phản hồi (bổ sung)" onlyIn mobile', () => {
    const manifest = manifestWithKetQuaGroup();
    const mdBySource = new Map([[FIXTURE_SOURCE, FIXTURE_MD]]);

    const result = scanVariantDriftFromDocs(manifest, mdBySource);

    assert.deepEqual(result.warnings, []);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.groupKey, GROUP_KEY);
    assert.equal(result.findings[0]!.onlyIn, 'mobile');
    assert.equal(result.findings[0]!.bullet, 'Phản hồi (bổ sung)');
    assert.equal(result.findings[0]!.counterpartKey, 'multi-platform-cr__ket-qua--web');
  });

  test('manifest schema_version 1 (tài liệu một-nền-tảng) → [] không đọc md nào', () => {
    const manifest: ScreensManifest = {
      schema_version: 1,
      screens: [
        { key: 'doc__mh1', code: 'mh1', name: 'Màn hình A', source: FIXTURE_SOURCE, origin: 'doc', line: 43, hasSection: true },
      ],
    };
    // mdBySource CỐ Ý rỗng — nếu hàm đọc nhầm sẽ ném lỗi truy cập Map, ở đây
    // chỉ cần khẳng định kết quả rỗng và không throw.
    const result = scanVariantDriftFromDocs(manifest, new Map());
    assert.deepEqual(result, { findings: [], warnings: [] });
  });

  test('manifest v2 nhưng không entry nào có groupKey (dự án một-nền-tảng) → []', () => {
    const manifest: ScreensManifest = {
      schema_version: 2,
      screens: [
        { key: 'doc__mh1', code: 'mh1', name: 'Màn hình A', source: FIXTURE_SOURCE, origin: 'doc', line: 43, hasSection: true, platform: 'web' },
      ],
    };
    const result = scanVariantDriftFromDocs(manifest, new Map());
    assert.deepEqual(result, { findings: [], warnings: [] });
  });

  test('manifest rỗng/undefined → []', () => {
    assert.deepEqual(scanVariantDriftFromDocs(undefined, new Map()), { findings: [], warnings: [] });
    assert.deepEqual(scanVariantDriftFromDocs(null, new Map()), { findings: [], warnings: [] });
  });

  test('thiếu nội dung markdown cho một biến thể → warning, không throw, finding rỗng (không đủ 2 phía để so)', () => {
    const manifest = manifestWithKetQuaGroup();
    const result = scanVariantDriftFromDocs(manifest, new Map()); // mdBySource rỗng
    assert.deepEqual(result.findings, []);
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0]!, /không có nội dung markdown/);
  });
});
