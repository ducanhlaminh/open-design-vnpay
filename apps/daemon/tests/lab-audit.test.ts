// ds-lab quality (WP-lab-quality, 2026-08-22) red-spec: lab-audit.ts, module
// THUẦN audit placeholder-lộ + tràn-biên từ subtree REST. See
// `.tmp/pipeline/wp-lab-quality.yaml`.
//
// WP-lab-clean (2026-08-23 — .tmp/pipeline/wp-lab-clean.yaml): + 'no-instance'
// / 'no-bound-variable' — xem describe riêng ở cuối file. `frameWithBox` (dùng
// bởi các test placeholder/overflow có TỪ TRƯỚC) nay tự chèn thêm một decoy
// INSTANCE có `boundVariables` KHÔNG hiển thị — để những test đó tiếp tục chỉ
// đo đúng đối tượng chúng khai báo (placeholder/overflow), không bị 2 kind
// mới làm lệch số violation đếm được.

import { describe, expect, it } from 'vitest';

import { auditLabSubtrees, renderLabAuditMd, type AuditSubtreeInput } from '../src/lab-audit.js';

// Decoy KHÔNG hiển thị (không tham gia audit placeholder/overflow, vốn chỉ
// duyệt nhánh hiển thị) nhưng VẪN được 'no-instance'/'no-bound-variable' đếm
// (2 kind đó cố ý duyệt CẢ nhánh ẩn) — giữ các test placeholder/overflow có
// từ trước không bị 2 kind mới này làm lệch số violation.
function decoySatisfiesInstanceAndBind(): unknown {
  return {
    id: '9:99',
    type: 'INSTANCE',
    name: '__decoy_instance_with_bind',
    visible: false,
    boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' }] },
  };
}

function frameWithBox(x: number, y: number, width: number, height: number, children: unknown[]): unknown {
  return {
    id: '1:1',
    type: 'FRAME',
    name: 'SCR-01 — Danh sách gói',
    visible: true,
    absoluteBoundingBox: { x, y, width, height },
    children: [...children, decoySatisfiesInstanceAndBind()],
  };
}

describe('auditLabSubtrees: placeholder', () => {
  it('bắt text placeholder khớp nguyên văn, case-insensitive (kể cả "Active tab")', () => {
    const node = frameWithBox(0, 0, 390, 800, [
      { id: '1:2', type: 'TEXT', name: 'Tab label', visible: true, characters: 'Active tab' },
    ]);
    const violations = auditLabSubtrees([{ key: 'SCR-01', name: 'Danh sách gói', node }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ key: 'SCR-01', kind: 'placeholder' });
    expect(violations[0].detail).toContain('Tab label');
    expect(violations[0].detail).toContain('Active tab');
  });

  it('KHÔNG bắt text trong nhánh hidden (node.visible=false, hoặc tổ tiên hidden)', () => {
    const nodeSelfHidden = frameWithBox(0, 0, 390, 800, [
      { id: '1:2', type: 'TEXT', name: 'Title', visible: false, characters: 'Title' },
    ]);
    expect(auditLabSubtrees([{ key: 'SCR-01', name: 'x', node: nodeSelfHidden }])).toEqual([]);

    const nodeAncestorHidden = frameWithBox(0, 0, 390, 800, [
      {
        id: '1:3',
        type: 'GROUP',
        name: 'Hidden group',
        visible: false,
        children: [{ id: '1:4', type: 'TEXT', name: 'Title', visible: true, characters: 'Title' }],
      },
    ]);
    expect(auditLabSubtrees([{ key: 'SCR-01', name: 'x', node: nodeAncestorHidden }])).toEqual([]);
  });

  it('không khớp text KHÔNG nằm trong danh sách placeholder', () => {
    const node = frameWithBox(0, 0, 390, 800, [
      { id: '1:2', type: 'TEXT', name: 'Giá', visible: true, characters: '99.000đ/tháng' },
    ]);
    expect(auditLabSubtrees([{ key: 'SCR-01', name: 'x', node }])).toEqual([]);
  });

  it('bắt đủ các chuỗi placeholder khác trong danh mục (title/body/content/label/paragraph/lorem/lorem ipsum/text here)', () => {
    const strings = ['title', 'Body', 'CONTENT', 'Label', 'Paragraph', 'lorem', 'Lorem Ipsum', 'Text Here'];
    const node = frameWithBox(
      0,
      0,
      390,
      800,
      strings.map((s, i) => ({ id: `1:${i}`, type: 'TEXT', name: `T${i}`, visible: true, characters: s })),
    );
    const violations = auditLabSubtrees([{ key: 'SCR-01', name: 'x', node }]);
    expect(violations).toHaveLength(strings.length);
    expect(violations.every((v) => v.kind === 'placeholder')).toBe(true);
  });
});

describe('auditLabSubtrees: overflow', () => {
  it('bắt tràn PHẢI > 2px', () => {
    const node = frameWithBox(0, 0, 358, 800, [
      {
        id: '1:2',
        type: 'INSTANCE',
        name: 'Nút Chọn gói',
        visible: true,
        absoluteBoundingBox: { x: 300, y: 10, width: 100, height: 40 }, // right edge 400, khung 358 → thò 42px
      },
    ]);
    const violations = auditLabSubtrees([{ key: 'SCR-02', name: 'Checkout', node }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ key: 'SCR-02', kind: 'overflow' });
    expect(violations[0].detail).toContain('Nút Chọn gói');
    expect(violations[0].detail).toContain('42');
    expect(violations[0].detail).toContain('PHẢI');
  });

  it('bắt tràn TRÁI > 2px', () => {
    const node = frameWithBox(0, 0, 358, 800, [
      {
        id: '1:2',
        type: 'INSTANCE',
        name: 'Card lệch',
        visible: true,
        absoluteBoundingBox: { x: -10, y: 10, width: 100, height: 40 }, // left edge -10 < 0 → thò 10px
      },
    ]);
    const violations = auditLabSubtrees([{ key: 'SCR-02', name: 'Checkout', node }]);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('overflow');
    expect(violations[0].detail).toContain('TRÁI');
    expect(violations[0].detail).toContain('10');
  });

  it('≤2px KHÔNG bắt (dung sai subpixel)', () => {
    const node = frameWithBox(0, 0, 358, 800, [
      {
        id: '1:2',
        type: 'INSTANCE',
        name: 'Sát biên',
        visible: true,
        absoluteBoundingBox: { x: 356.5, y: 10, width: 3, height: 40 }, // right edge 359.5, thò 1.5px
      },
    ]);
    expect(auditLabSubtrees([{ key: 'SCR-02', name: 'x', node }])).toEqual([]);
  });

  it('thò ĐÁY không bắt — chỉ so trái/phải, màn cuộn dọc là bình thường', () => {
    const node = frameWithBox(0, 0, 358, 800, [
      {
        id: '1:2',
        type: 'FRAME',
        name: 'Nội dung dài',
        visible: true,
        absoluteBoundingBox: { x: 0, y: 700, width: 358, height: 500 }, // đáy vượt 400px, x/width khớp khung
      },
    ]);
    expect(auditLabSubtrees([{ key: 'SCR-02', name: 'x', node }])).toEqual([]);
  });

  it('node thiếu bbox không throw — bỏ qua kiểm tra tràn biên cho node đó', () => {
    const node = frameWithBox(0, 0, 358, 800, [
      { id: '1:2', type: 'INSTANCE', name: 'Không bbox', visible: true },
    ]);
    expect(() => auditLabSubtrees([{ key: 'SCR-02', name: 'x', node }])).not.toThrow();
    expect(auditLabSubtrees([{ key: 'SCR-02', name: 'x', node }])).toEqual([]);
  });

  it('gốc thiếu bbox không throw — bỏ qua audit tràn biên cho cả subtree (vẫn audit placeholder)', () => {
    const node = {
      id: '1:1',
      type: 'FRAME',
      name: 'Không có bbox gốc',
      visible: true,
      children: [
        {
          id: '1:2',
          type: 'INSTANCE',
          name: 'Tràn nếu có R',
          visible: true,
          absoluteBoundingBox: { x: 9999, y: 0, width: 10, height: 10 },
          boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' }] },
        },
        { id: '1:3', type: 'TEXT', name: 'Title', visible: true, characters: 'Title' },
      ],
    };
    const violations = auditLabSubtrees([{ key: 'SCR-03', name: 'x', node }]);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('placeholder');
  });

  it('input.node không phải object → bỏ qua, không throw', () => {
    const inputs: AuditSubtreeInput[] = [{ key: 'SCR-99', name: 'x', node: null }];
    expect(() => auditLabSubtrees(inputs)).not.toThrow();
    expect(auditLabSubtrees(inputs)).toEqual([]);
  });
});

// ── auditLabSubtrees: no-instance / no-bound-variable (WP-lab-clean) ────────
// Bằng chứng thật: comp kit "Order Summary Card" = 0 INSTANCE (datarow/Badge/
// Currency là frame+text đặt tên giống base), get_variable_defs trả {} (hex
// trần). Cả hai kind duyệt TOÀN BỘ subtree (kể cả nhánh ẩn) — khác placeholder/
// overflow ở trên.

describe('auditLabSubtrees: no-instance', () => {
  it('subtree KHÔNG có node INSTANCE nào → báo "no-instance"', () => {
    const node = {
      id: '114:14',
      type: 'COMPONENT',
      name: 'Order Summary Card',
      visible: true,
      children: [
        { id: '1:2', type: 'FRAME', name: 'datarow', visible: true, children: [] },
        { id: '1:3', type: 'TEXT', name: 'Badge', visible: true, characters: 'Giảm 10%' },
      ],
    };
    const violations = auditLabSubtrees([{ key: 'card-order-summary', name: 'Order Summary Card', node }]);
    const kinds = violations.map((v) => v.kind);
    expect(kinds).toContain('no-instance');
    expect(violations.filter((v) => v.kind === 'no-instance')).toHaveLength(1);
  });

  it('có INSTANCE dù nằm trong nhánh ẨN → KHÔNG báo "no-instance"', () => {
    const node = {
      id: '1:1',
      type: 'COMPONENT',
      name: 'x',
      visible: true,
      children: [
        {
          id: '1:2',
          type: 'GROUP',
          name: 'Hidden group',
          visible: false,
          children: [{ id: '1:3', type: 'INSTANCE', name: 'Base ẩn', visible: true }],
        },
      ],
    };
    const violations = auditLabSubtrees([{ key: 'card-x', name: 'x', node }]);
    expect(violations.map((v) => v.kind)).not.toContain('no-instance');
  });
});

describe('auditLabSubtrees: no-bound-variable', () => {
  it('subtree KHÔNG node nào có `boundVariables` không rỗng → báo "no-bound-variable"', () => {
    const node = {
      id: '1:1',
      type: 'COMPONENT',
      name: 'Order Summary Card',
      visible: true,
      children: [{ id: '1:2', type: 'INSTANCE', name: 'ProviderMini', visible: true }],
    };
    const violations = auditLabSubtrees([{ key: 'card-order-summary', name: 'x', node }]);
    const kinds = violations.map((v) => v.kind);
    expect(kinds).toContain('no-bound-variable');
    expect(violations.filter((v) => v.kind === 'no-bound-variable')).toHaveLength(1);
  });

  it('`boundVariables` rỗng ({}) vẫn tính là KHÔNG bind — vẫn báo', () => {
    const node = {
      id: '1:1',
      type: 'COMPONENT',
      name: 'x',
      visible: true,
      children: [{ id: '1:2', type: 'INSTANCE', name: 'y', visible: true, boundVariables: {} }],
    };
    const violations = auditLabSubtrees([{ key: 'card-x', name: 'x', node }]);
    expect(violations.map((v) => v.kind)).toContain('no-bound-variable');
  });

  it('có `boundVariables` không rỗng ở BẤT KỲ node nào (kể cả nhánh ẩn) → KHÔNG báo', () => {
    const node = {
      id: '1:1',
      type: 'COMPONENT',
      name: 'x',
      visible: true,
      children: [
        {
          id: '1:2',
          type: 'GROUP',
          name: 'Hidden',
          visible: false,
          children: [
            {
              id: '1:3',
              type: 'INSTANCE',
              name: 'z',
              visible: true,
              boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' }] },
            },
          ],
        },
      ],
    };
    const violations = auditLabSubtrees([{ key: 'card-x', name: 'x', node }]);
    expect(violations.map((v) => v.kind)).not.toContain('no-bound-variable');
  });
});

describe('auditLabSubtrees: no-instance + no-bound-variable cùng thoả → không báo cả hai', () => {
  it('có INSTANCE + có boundVariables → không báo no-instance lẫn no-bound-variable', () => {
    const node = {
      id: '1:1',
      type: 'COMPONENT',
      name: 'Order Summary Card',
      visible: true,
      children: [
        {
          id: '1:2',
          type: 'INSTANCE',
          name: 'ProviderMini',
          visible: true,
          boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' }] },
        },
      ],
    };
    const violations = auditLabSubtrees([{ key: 'card-order-summary', name: 'x', node }]);
    expect(violations).toEqual([]);
  });
});

describe('renderLabAuditMd', () => {
  it('violations rỗng → trả chuỗi rỗng', () => {
    expect(renderLabAuditMd([], { generatedAt: '2026-08-22T00:00:00.000Z', subject: 'màn' })).toBe('');
  });

  it('header cảnh báo "Máy tự soát sau run — sửa rồi Chạy lại stage", nhóm theo key, mỗi violation một bullet', () => {
    const md = renderLabAuditMd(
      [
        { key: 'SCR-01', kind: 'placeholder', detail: 'Node "Title" vẫn hiển thị placeholder mặc định "Title".' },
        { key: 'SCR-01', kind: 'overflow', detail: 'Node "Nút" tràn 42px về phía PHẢI.' },
        { key: 'SCR-02', kind: 'placeholder', detail: 'Node "Body" vẫn hiển thị placeholder mặc định "Body".' },
      ],
      { generatedAt: '2026-08-22T00:00:00.000Z', subject: 'màn' },
    );
    expect(md).toContain('Máy tự soát sau run — sửa rồi Chạy lại stage');
    expect(md).toContain('SCR-01');
    expect(md).toContain('SCR-02');
    expect(md).toContain('Placeholder');
    expect(md).toContain('Tràn biên');
    // Nhóm theo key: SCR-01 xuất hiện trước cả 2 dòng của nó rồi mới tới SCR-02.
    const idxScr01 = md.indexOf('## SCR-01');
    const idxScr02 = md.indexOf('## SCR-02');
    expect(idxScr01).toBeGreaterThanOrEqual(0);
    expect(idxScr02).toBeGreaterThan(idxScr01);
  });

  it('subject "component" đổi xưng hô cho lab-kit', () => {
    const md = renderLabAuditMd(
      [{ key: 'card-choose-number', kind: 'placeholder', detail: 'x' }],
      { generatedAt: '2026-08-22T00:00:00.000Z', subject: 'component' },
    );
    expect(md).toContain('component');
  });

  it('nhãn "[Không instance]" / "[Không bind biến]" cho 2 kind mới (WP-lab-clean)', () => {
    const md = renderLabAuditMd(
      [
        { key: 'card-order-summary', kind: 'no-instance', detail: 'không chứa instance base nào.' },
        { key: 'card-order-summary', kind: 'no-bound-variable', detail: 'mọi màu/chữ là giá trị trần.' },
      ],
      { generatedAt: '2026-08-22T00:00:00.000Z', subject: 'component' },
    );
    expect(md).toContain('[Không instance]');
    expect(md).toContain('[Không bind biến]');
  });
});
