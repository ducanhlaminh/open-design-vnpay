// T2 (docs/screen-variants-subplan.md, Wave 1): test cho screen-groups.ts
// (WP-V2, docs/screen-variants-spec.md §3.2–3.4). Dữ liệu mô phỏng theo
// apps/daemon/tests/fixtures/multi-platform-cr.md (bảng MB §2.2 / IB §2.3 /
// BO §2.4) — cùng stem `CR-Ho-tro-truc-tuyen-GD2` như một tài liệu thật sẽ
// sinh ra.

import { describe, expect, it } from 'vitest';
import { autoGroupScreens, normalizeScreenName, type GroupCandidate } from '../src/screen-groups.js';

describe('normalizeScreenName', () => {
  it('bỏ dấu + tiền tố "màn hình" (dạng có dấu và đã bỏ dấu quy về cùng kết quả)', () => {
    expect(normalizeScreenName('Màn hình Quản lý yêu cầu của tôi')).toBe('quan ly yeu cau cua toi');
    expect(normalizeScreenName('man hinh quan ly yeu cau cua toi')).toBe('quan ly yeu cau cua toi');
  });

  it('bỏ tiền tố "popup"', () => {
    expect(normalizeScreenName('Popup đánh giá')).toBe('danh gia');
  });

  it('chỉ bỏ tiền tố khi đứng ĐẦU chuỗi', () => {
    // "màn hình" đứng giữa câu — không phải tiền tố đầu chuỗi, không bị bỏ.
    expect(normalizeScreenName('Chi tiết màn hình phụ')).toBe('chi tiet man hinh phu');
  });

  it('collapse khoảng trắng thừa và trim', () => {
    expect(normalizeScreenName('  Màn hình   Kết quả   giao dịch  ')).toBe('ket qua giao dich');
  });
});

const STEM = 'CR-Ho-tro-truc-tuyen-GD2';

/** Bộ dữ liệu mô phỏng fixture multi-platform-cr.md: 3 cặp trùng tên hệt
 *  MB/IB (quản lý yêu cầu của tôi, tạo yêu cầu hỗ trợ trực tuyến, kết quả
 *  giao dịch), 1 cặp ca mờ (danh sách lý do / popup danh sách lý do hỗ trợ),
 *  2 màn BO đơn (web, không có cặp), 1 màn platform chưa xác định (null),
 *  2 màn mobile trùng tên NHAU (không có đối ứng web). */
const FIXTURE_SCREENS: GroupCandidate[] = [
  // §2.2 Màn hình MB
  { key: `${STEM}__mb-quan-ly`, name: 'Màn hình quản lý yêu cầu của tôi', platform: 'mobile' },
  { key: `${STEM}__mb-tao-yeu-cau`, name: 'Màn hình tạo yêu cầu hỗ trợ trực tuyến', platform: 'mobile' },
  { key: `${STEM}__mb-ket-qua`, name: 'Màn hình kết quả giao dịch', platform: 'mobile' },
  { key: `${STEM}__mb-danh-sach-ly-do`, name: 'Màn hình danh sách lý do', platform: 'mobile' },
  // §2.3 Màn hình IB
  { key: `${STEM}__ib-quan-ly`, name: 'Màn hình quản lý yêu cầu của tôi', platform: 'web' },
  { key: `${STEM}__ib-tao-yeu-cau`, name: 'Màn hình tạo yêu cầu hỗ trợ trực tuyến', platform: 'web' },
  { key: `${STEM}__ib-ket-qua`, name: 'Màn hình kết quả giao dịch', platform: 'web' },
  { key: `${STEM}__ib-popup-ly-do`, name: 'Popup danh sách lý do hỗ trợ', platform: 'web' },
  // §2.4 Màn hình BO — đơn, không đối ứng
  { key: `${STEM}__bo-quan-ly`, name: 'Màn hình quản lý yêu cầu hỗ trợ', platform: 'web' },
  { key: `${STEM}__bo-chi-tiet`, name: 'Màn hình chi tiết yêu cầu hỗ trợ - GDV tiếp nhận yêu cầu', platform: 'web' },
  // platform chưa suy được (heading không khớp bảng từ khóa WP-V1)
  { key: `${STEM}__unresolved`, name: 'Màn hình chưa rõ nền tảng', platform: null },
  // 2 màn cùng platform (mobile) trùng tên nhau — không có đối ứng web
  { key: `${STEM}__mb-dup-a`, name: 'Màn hình trùng tên', platform: 'mobile' },
  { key: `${STEM}__mb-dup-b`, name: 'Màn hình trùng tên', platform: 'mobile' },
];

describe('autoGroupScreens — fixture đa nền tảng', () => {
  const result = autoGroupScreens(FIXTURE_SCREENS);

  it('auto-nhóm đúng 3 cặp trùng tên hệt khác platform', () => {
    expect(Object.keys(result.groups).sort()).toEqual(
      [
        `${STEM}__G-quan-ly-yeu-cau-cua-toi`,
        `${STEM}__G-tao-yeu-cau-ho-tro-truc-tuyen`,
        `${STEM}__G-ket-qua-giao-dich`,
      ].sort(),
    );
  });

  it('groupKey đúng dạng <stem>__G-<slug> và thành viên nhận hậu tố --mb/--ib', () => {
    const g = result.groups[`${STEM}__G-quan-ly-yeu-cau-cua-toi`];
    expect(g).toEqual(
      expect.arrayContaining([`${STEM}__mb-quan-ly--mb`, `${STEM}__ib-quan-ly--ib`]),
    );
    expect(g).toHaveLength(2);
  });

  it('renamedKeys chỉ chứa thành viên đã vào nhóm, đúng hậu tố platform', () => {
    expect(result.renamedKeys[`${STEM}__mb-quan-ly`]).toBe(`${STEM}__mb-quan-ly--mb`);
    expect(result.renamedKeys[`${STEM}__ib-quan-ly`]).toBe(`${STEM}__ib-quan-ly--ib`);
    expect(result.renamedKeys[`${STEM}__mb-tao-yeu-cau`]).toBe(`${STEM}__mb-tao-yeu-cau--mb`);
    expect(result.renamedKeys[`${STEM}__ib-tao-yeu-cau`]).toBe(`${STEM}__ib-tao-yeu-cau--ib`);
    expect(result.renamedKeys[`${STEM}__mb-ket-qua`]).toBe(`${STEM}__mb-ket-qua--mb`);
    expect(result.renamedKeys[`${STEM}__ib-ket-qua`]).toBe(`${STEM}__ib-ket-qua--ib`);
  });

  it('màn đơn (BO, không đối ứng) KHÔNG đổi key — không xuất hiện trong renamedKeys', () => {
    expect(result.renamedKeys[`${STEM}__bo-quan-ly`]).toBeUndefined();
    expect(result.renamedKeys[`${STEM}__bo-chi-tiet`]).toBeUndefined();
  });

  it('màn platform null KHÔNG được nhóm và không xuất hiện trong renamedKeys', () => {
    expect(result.renamedKeys[`${STEM}__unresolved`]).toBeUndefined();
    for (const members of Object.values(result.groups)) {
      expect(members.some((k) => k.startsWith(`${STEM}__unresolved`))).toBe(false);
    }
  });

  it('2 màn cùng platform trùng tên KHÔNG được nhóm và KHÔNG sinh gợi ý', () => {
    expect(result.renamedKeys[`${STEM}__mb-dup-a`]).toBeUndefined();
    expect(result.renamedKeys[`${STEM}__mb-dup-b`]).toBeUndefined();
    const touchesDup = result.suggestions.some(
      (s) => s.a.key.includes('mb-dup') || s.b.key.includes('mb-dup'),
    );
    expect(touchesDup).toBe(false);
  });

  it('cặp tên gần-giống khác platform ("danh sách lý do" / "popup danh sách lý do hỗ trợ") nằm ở suggestions, KHÔNG trong groups', () => {
    const found = result.suggestions.find(
      (s) =>
        (s.a.key === `${STEM}__mb-danh-sach-ly-do` && s.b.key === `${STEM}__ib-popup-ly-do`) ||
        (s.b.key === `${STEM}__mb-danh-sach-ly-do` && s.a.key === `${STEM}__ib-popup-ly-do`),
    );
    expect(found).toBeDefined();
    expect(found?.reason).toContain('tập con');

    // không được lọt vào groups/renamedKeys — đây là ca mờ, agent quyết.
    expect(result.renamedKeys[`${STEM}__mb-danh-sach-ly-do`]).toBeUndefined();
    expect(result.renamedKeys[`${STEM}__ib-popup-ly-do`]).toBeUndefined();
    for (const members of Object.values(result.groups)) {
      expect(members).not.toContain(`${STEM}__mb-danh-sach-ly-do`);
      expect(members).not.toContain(`${STEM}__ib-popup-ly-do`);
    }
  });
});

describe('autoGroupScreens — trường hợp đơn giản', () => {
  it('danh sách rỗng ra kết quả rỗng, không lỗi', () => {
    const result = autoGroupScreens([]);
    expect(result.groups).toEqual({});
    expect(result.renamedKeys).toEqual({});
    expect(result.suggestions).toEqual([]);
  });

  it('khác stem thì KHÔNG nhóm dù trùng tên chuẩn hóa + khác platform', () => {
    const screens: GroupCandidate[] = [
      { key: 'doc-a__scr-1', name: 'Màn hình xác nhận', platform: 'mobile' },
      { key: 'doc-b__scr-1', name: 'Màn hình xác nhận', platform: 'web' },
    ];
    const result = autoGroupScreens(screens);
    expect(result.groups).toEqual({});
    expect(result.renamedKeys).toEqual({});
  });

  it('hàm thuần: gọi 2 lần cùng input ra kết quả y hệt (deterministic)', () => {
    const r1 = autoGroupScreens(FIXTURE_SCREENS);
    const r2 = autoGroupScreens(FIXTURE_SCREENS);
    expect(r1).toEqual(r2);
  });
});
