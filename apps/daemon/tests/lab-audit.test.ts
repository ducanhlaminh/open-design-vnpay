// ds-lab quality (WP-lab-quality, 2026-08-22) red-spec: lab-audit.ts, module
// THUẦN audit placeholder-lộ + tràn-biên từ subtree REST. See
// `.tmp/pipeline/wp-lab-quality.yaml`.

import { describe, expect, it } from 'vitest';

import { auditLabSubtrees, renderLabAuditMd, type AuditSubtreeInput } from '../src/lab-audit.js';

function frameWithBox(x: number, y: number, width: number, height: number, children: unknown[]): unknown {
  return {
    id: '1:1',
    type: 'FRAME',
    name: 'SCR-01 — Danh sách gói',
    visible: true,
    absoluteBoundingBox: { x, y, width, height },
    children,
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
});
