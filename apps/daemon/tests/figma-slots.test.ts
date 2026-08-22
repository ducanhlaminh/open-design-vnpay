import { describe, expect, it } from 'vitest';

import { mineComponentSlots, renderSlotsMd, type MineSlotsInput } from '../src/figma-slots.js';

// Fixture tay theo `.tmp/pipeline/wp-slots.yaml` mục F, nhại shape REST thật
// (probe node 23:782 file preview: Card Default > Heading > SLOT "Content"
// chứa INSTANCE Title/Paragraph, SLOT ".card-container", SLOT ".card-action"):
// - "Card Default": root > Heading (INSTANCE) > SLOT "Content" (chứa TEXT
//   "Title" + TEXT "Paragraph" placeholder) — slot lồng trong instance con.
//   root cũng có SLOT ".card-action" đang HIDDEN (visible:false), rỗng.
// - "Tabbar": root > SLOT "Cells" chứa 10 children (Tab-Cell lặp) — vượt cap
//   8, phải cắt còn 8 + "+2 nữa".
// - "Plain Rectangle": không có SLOT nào — phải bị loại khỏi kết quả.
function cardDefaultFixture(): MineSlotsInput {
  return {
    name: 'Card Default',
    node: {
      id: '1:1',
      type: 'COMPONENT',
      name: 'Card Default',
      children: [
        {
          id: '1:2',
          name: 'Heading',
          type: 'INSTANCE',
          children: [
            {
              id: '1:3',
              name: 'Content',
              type: 'SLOT',
              visible: true,
              children: [
                { id: '1:4', name: 'Title', type: 'TEXT', characters: 'Title' },
                { id: '1:5', name: 'Paragraph', type: 'TEXT', characters: 'Body copy goes here' },
              ],
            },
          ],
        },
        {
          id: '1:6',
          name: '.card-action',
          type: 'SLOT',
          visible: false,
          children: [],
        },
      ],
    },
  };
}

function tabbarFixture(): MineSlotsInput {
  const cells = Array.from({ length: 10 }, (_, i) => ({
    id: `2:${10 + i}`,
    name: `Tab-Cell ${i + 1}`,
    type: 'INSTANCE',
  }));
  return {
    name: 'Tabbar',
    node: {
      id: '2:1',
      type: 'COMPONENT',
      name: 'Tabbar',
      children: [
        {
          id: '2:2',
          name: 'Cells',
          type: 'SLOT',
          visible: true,
          children: cells,
        },
      ],
    },
  };
}

function plainRectangleFixture(): MineSlotsInput {
  return {
    name: 'Plain Rectangle',
    node: {
      id: '3:1',
      type: 'COMPONENT',
      name: 'Plain Rectangle',
      children: [{ id: '3:2', name: 'Fill', type: 'RECTANGLE' }],
    },
  };
}

describe('figma-slots: mineComponentSlots (thuần, tất định)', () => {
  it('đào path lồng đúng (Heading > Content), hidden, defaultChildren, textLayers', () => {
    const profiles = mineComponentSlots([cardDefaultFixture()]);
    expect(profiles).toHaveLength(1);
    const profile = profiles[0];
    expect(profile.componentName).toBe('Card Default');

    const contentSlot = profile.slots.find((s) => s.path === 'Heading > Content');
    expect(contentSlot).toBeTruthy();
    expect(contentSlot?.hidden).toBe(false);
    expect(contentSlot?.defaultChildren).toEqual([
      { name: 'Title', type: 'TEXT' },
      { name: 'Paragraph', type: 'TEXT' },
    ]);

    const actionSlot = profile.slots.find((s) => s.path === '.card-action');
    expect(actionSlot).toBeTruthy();
    expect(actionSlot?.hidden).toBe(true);
    expect(actionSlot?.defaultChildren).toEqual([]);

    expect(profile.textLayers).toEqual([
      { path: 'Heading > Content > Title', characters: 'Title' },
      { path: 'Heading > Content > Paragraph', characters: 'Body copy goes here' },
    ]);
  });

  it('slot ở tầng đỉnh (con trực tiếp của root) → path = tên chính slot đó', () => {
    const profiles = mineComponentSlots([cardDefaultFixture()]);
    const actionSlot = profiles[0].slots.find((s) => s.path === '.card-action');
    expect(actionSlot).toBeTruthy();
  });

  it('component không có SLOT nào → bị loại khỏi kết quả', () => {
    const profiles = mineComponentSlots([plainRectangleFixture()]);
    expect(profiles).toEqual([]);
  });

  it('cắt defaultChildren còn tối đa 8 + entry "… (+N nữa)"', () => {
    const profiles = mineComponentSlots([tabbarFixture()]);
    expect(profiles).toHaveLength(1);
    const slot = profiles[0].slots[0];
    expect(slot.defaultChildren).toHaveLength(9);
    expect(slot.defaultChildren.slice(0, 8)).toEqual(
      Array.from({ length: 8 }, (_, i) => ({ name: `Tab-Cell ${i + 1}`, type: 'INSTANCE' })),
    );
    expect(slot.defaultChildren[8]).toEqual({ name: '… (+2 nữa)', type: '…' });
  });

  it('là hàm tất định: gọi 2 lần cùng input → deep-equal', () => {
    const a = mineComponentSlots([cardDefaultFixture(), tabbarFixture()]);
    const b = mineComponentSlots([cardDefaultFixture(), tabbarFixture()]);
    expect(a).toEqual(b);
  });

  it('dedupe biến thể: hai input cùng name + cùng chữ ký cấu trúc → giữ MỘT entry', () => {
    const profiles = mineComponentSlots([cardDefaultFixture(), cardDefaultFixture()]);
    expect(profiles).toHaveLength(1);
  });

  it('cùng name khác chữ ký cấu trúc → giữ CẢ HAI, entry sau thêm hậu tố "(biến thể khác)"', () => {
    const variant = cardDefaultFixture();
    // Đổi cấu trúc: xoá một text layer khỏi slot Content → chữ ký khác.
    const variantNode = variant.node as { children: Array<Record<string, unknown>> };
    const heading = variantNode.children[0] as { children: Array<{ children: unknown[] }> };
    const contentSlot = heading.children[0];
    contentSlot.children = [(contentSlot.children as unknown[])[0]];

    const profiles = mineComponentSlots([cardDefaultFixture(), variant]);
    expect(profiles).toHaveLength(2);
    expect(profiles[0].componentName).toBe('Card Default');
    expect(profiles[1].componentName).toBe('Card Default (biến thể khác)');
  });

  it('dedupe biến thể theo tên dạng "Prop=Value, Prop2=Value2" (page-walk fallback)', () => {
    const variantA: MineSlotsInput = {
      name: 'State=Default, Size=Large',
      node: cardDefaultFixture().node,
    };
    const variantB: MineSlotsInput = {
      name: 'State=Hover, Size=Large',
      node: cardDefaultFixture().node,
    };
    const profiles = mineComponentSlots([variantA, variantB]);
    // Cùng chữ ký cấu trúc + cả hai tên đều dạng biến thể → collapse về MỘT
    // entry, dùng tên của input đầu tiên.
    expect(profiles).toHaveLength(1);
    expect(profiles[0].componentName).toBe('State=Default, Size=Large');
  });
});

describe('figma-slots: renderSlotsMd', () => {
  it('chứa đoạn giải thích cơ chế SLOT + heading từng component + escape "|"', () => {
    const profiles = mineComponentSlots([cardDefaultFixture()]);
    const md = renderSlotsMd(profiles, { generatedAt: '2026-08-22T00:00:00.000Z', componentCount: 1 });

    expect(md).toContain('SLOT');
    expect(md).toContain('đè');
    expect(md).toContain('### Card Default');
    expect(md).toContain('Heading > Content');
  });

  it('escape ký tự "|" trong path/characters khi render bảng', () => {
    const withPipe: MineSlotsInput = {
      name: 'Pipe|Component',
      node: {
        id: '9:1',
        type: 'COMPONENT',
        name: 'Pipe|Component',
        children: [
          {
            id: '9:2',
            name: 'Sl|ot',
            type: 'SLOT',
            visible: true,
            children: [{ id: '9:3', name: 'Child', type: 'TEXT', characters: 'a|b' }],
          },
        ],
      },
    };
    const profiles = mineComponentSlots([withPipe]);
    const md = renderSlotsMd(profiles, { generatedAt: '2026-08-22T00:00:00.000Z', componentCount: 1 });
    expect(md).not.toContain('Sl|ot');
    expect(md).toContain('Sl\\|ot');
    expect(md).toContain('Pipe\\|Component');
  });

  it('profiles rỗng → vẫn trả markdown hợp lệ, chỉ có header', () => {
    const md = renderSlotsMd([], { generatedAt: '2026-08-22T00:00:00.000Z', componentCount: 0 });
    expect(md).toContain('# Hồ sơ SLOT de-facto');
    expect(md).not.toContain('###');
  });
});
