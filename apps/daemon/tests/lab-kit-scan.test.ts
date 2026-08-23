// ds-lab / lab-kit-scan red-spec (WP-lab-reorder, 2026-08-23 — xem
// .tmp/pipeline/wp-lab-reorder.yaml): scanKitCandidates là module THUẦN quét
// subtree REST của các màn đã dựng (lab-result.json) tìm khối nên đóng gói —
// xem docblock đầy đủ ở src/lab-kit-scan.ts.

import { describe, expect, it } from 'vitest';

import {
  kitCandidatePngRel,
  KIT_CANDIDATES_DIR_REL,
  KIT_CANDIDATES_FILE_REL,
  renderKitCandidatesMd,
  scanKitCandidates,
  type KitCandidate,
} from '../src/lab-kit-scan.js';

function card(id: string, name: string, x: number, y: number, width = 160, height = 200): unknown {
  return {
    id,
    type: 'FRAME',
    name,
    visible: true,
    absoluteBoundingBox: { x, y, width, height },
    children: [
      { id: `${id}:title`, type: 'TEXT', name: 'Title', visible: true, characters: name },
      { id: `${id}:price`, type: 'TEXT', name: 'Price', visible: true, characters: '99.000đ' },
    ],
  };
}

function screenFrame(id: string, name: string, children: unknown[]): unknown {
  return {
    id,
    type: 'FRAME',
    name,
    visible: true,
    absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 800 },
    children,
  };
}

describe('scanKitCandidates: repeat', () => {
  it('bắt nhóm ≥2 cùng chữ ký cấu trúc dù tên khác nhau (đếm là 1 candidate reason=repeat)', () => {
    const screen = screenFrame('1:1', 'SCR-01', [
      card('1:2', 'Card A', 0, 0),
      card('1:3', 'Card B', 0, 210),
    ]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    const repeats = candidates.filter((c) => c.reason === 'repeat');
    expect(repeats).toHaveLength(1);
    expect(repeats[0].occurrences).toHaveLength(2);
  });

  it('normalizeName gộp "Card 2" và "Card copy" vào cùng chữ ký với "Card"', () => {
    const screen = screenFrame('1:1', 'SCR-01', [
      card('1:2', 'Card', 0, 0),
      card('1:3', 'Card 2', 0, 210),
      card('1:4', 'Card copy', 0, 420),
    ]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    const repeats = candidates.filter((c) => c.reason === 'repeat');
    expect(repeats).toHaveLength(1);
    expect(repeats[0].occurrences).toHaveLength(3);
    expect(repeats[0].suggestedName).toBe('Card');
  });

  it('KHÔNG gộp hai card có ruột khác hẳn (chữ ký khác nhau) — hai nhóm riêng', () => {
    const differentCard = {
      id: '1:5',
      type: 'FRAME',
      name: 'Feature Card',
      visible: true,
      absoluteBoundingBox: { x: 0, y: 630, width: 160, height: 200 },
      children: [
        { id: '1:5:icon', type: 'INSTANCE', name: 'Icon', visible: true },
        { id: '1:5:desc', type: 'TEXT', name: 'Description', visible: true, characters: 'Mô tả' },
      ],
    };
    const differentCard2 = { ...differentCard, id: '1:6', absoluteBoundingBox: { x: 0, y: 840, width: 160, height: 200 } };
    const screen = screenFrame('1:1', 'SCR-01', [
      card('1:2', 'Card A', 0, 0),
      card('1:3', 'Card B', 0, 210),
      differentCard,
      differentCard2,
    ]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    const repeats = candidates.filter((c) => c.reason === 'repeat');
    expect(repeats).toHaveLength(2);
  });
});

describe('scanKitCandidates: loại trừ', () => {
  it('bỏ node type INSTANCE (không xét làm candidate)', () => {
    const instanceNode = {
      id: '1:2',
      type: 'INSTANCE',
      name: 'Card',
      visible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 200 },
      children: [
        { id: '1:2:a', type: 'TEXT', name: 'Title', visible: true, characters: 'x' },
        { id: '1:2:b', type: 'TEXT', name: 'Price', visible: true, characters: 'y' },
      ],
    };
    const instanceNode2 = { ...instanceNode, id: '1:3', absoluteBoundingBox: { x: 0, y: 210, width: 160, height: 200 } };
    const screen = screenFrame('1:1', 'SCR-01', [instanceNode, instanceNode2]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    expect(candidates).toHaveLength(0);
  });

  it('bỏ root màn (không bao giờ chính root trở thành candidate)', () => {
    const screen = screenFrame('1:1', 'SCR-01', [
      { id: '1:1:t', type: 'TEXT', name: 'Title', visible: true, characters: 'x' },
    ]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    expect(candidates).toHaveLength(0);
  });

  it('bỏ node khớp vai trò khung app-bar/tabbar theo tên', () => {
    const appBar = {
      id: '1:2',
      type: 'FRAME',
      name: 'App Bar',
      visible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 56 },
      children: [
        { id: '1:2:a', type: 'TEXT', name: 'Title', visible: true, characters: 'x' },
        { id: '1:2:b', type: 'INSTANCE', name: 'Back', visible: true },
      ],
    };
    const appBar2 = { ...appBar, id: '1:3', absoluteBoundingBox: { x: 0, y: 60, width: 390, height: 56 } };
    const screen = screenFrame('1:1', 'SCR-01', [appBar, appBar2]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    expect(candidates).toHaveLength(0);
  });

  it('bỏ node nhỏ (width<120 hoặc height<40)', () => {
    const tiny = {
      id: '1:2',
      type: 'FRAME',
      name: 'Chip',
      visible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 80, height: 24 },
      children: [
        { id: '1:2:a', type: 'TEXT', name: 'Label', visible: true, characters: 'x' },
        { id: '1:2:b', type: 'TEXT', name: 'Icon', visible: true, characters: 'y' },
      ],
    };
    const tiny2 = { ...tiny, id: '1:3', absoluteBoundingBox: { x: 90, y: 0, width: 80, height: 24 } };
    const screen = screenFrame('1:1', 'SCR-01', [tiny, tiny2]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    expect(candidates).toHaveLength(0);
  });

  it('bỏ node có <2 con hiển thị', () => {
    const single = {
      id: '1:2',
      type: 'FRAME',
      name: 'Wrapper',
      visible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 200 },
      children: [{ id: '1:2:a', type: 'TEXT', name: 'Title', visible: true, characters: 'x' }],
    };
    const single2 = { ...single, id: '1:3', absoluteBoundingBox: { x: 0, y: 210, width: 160, height: 200 } };
    const screen = screenFrame('1:1', 'SCR-01', [single, single2]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    expect(candidates).toHaveLength(0);
  });

  it('không đếm nhánh ẨN (visible:false) làm occurrence', () => {
    const screen = screenFrame('1:1', 'SCR-01', [
      card('1:2', 'Card A', 0, 0),
      { ...(card('1:3', 'Card B', 0, 210) as Record<string, unknown>), visible: false },
    ]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    expect(candidates.filter((c) => c.reason === 'repeat')).toHaveLength(0);
  });
});

describe('scanKitCandidates: lồng nhau chỉ lấy ngoài', () => {
  it('card chứa badge (cũng FRAME ≥2 con) → chỉ card ngoài là candidate, badge KHÔNG tách riêng', () => {
    const outer = (id: string, x: number): unknown => ({
      id,
      type: 'FRAME',
      name: 'Card',
      visible: true,
      absoluteBoundingBox: { x, y: 0, width: 200, height: 240 },
      children: [
        { id: `${id}:title`, type: 'TEXT', name: 'Title', visible: true, characters: 'x' },
        {
          id: `${id}:badge`,
          type: 'FRAME',
          name: 'Badge',
          visible: true,
          absoluteBoundingBox: { x, y: 0, width: 140, height: 60 },
          children: [
            { id: `${id}:badge:a`, type: 'TEXT', name: 'Label', visible: true, characters: 'Sale' },
            { id: `${id}:badge:b`, type: 'TEXT', name: 'Percent', visible: true, characters: '10%' },
          ],
        },
      ],
    });
    const screen = screenFrame('1:1', 'SCR-01', [outer('1:2', 0), outer('1:3', 210)]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    // Chỉ MỘT nhóm repeat (Card ngoài) — Badge lồng bên trong không tách
    // thành candidate riêng dù về mặt cấu trúc cũng thoả điều kiện base.
    expect(candidates).toHaveLength(1);
    expect(candidates[0].occurrences.map((o) => o.nodeId).sort()).toEqual(['1:2', '1:3']);
  });
});

describe('scanKitCandidates: anchor', () => {
  it('không có nhóm lặp → chọn node lớn nhất (diện tích) ≥3 con làm anchor, tối đa 1/màn', () => {
    const small = {
      id: '1:2',
      type: 'FRAME',
      name: 'Nhỏ',
      visible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 100 },
      children: [
        { id: '1:2:a', type: 'TEXT', name: 'Chip label', visible: true, characters: 'a' },
        { id: '1:2:b', type: 'TEXT', name: 'Chip icon', visible: true, characters: 'b' },
        { id: '1:2:c', type: 'TEXT', name: 'Chip badge', visible: true, characters: 'c' },
      ],
    };
    const big = {
      id: '1:3',
      type: 'FRAME',
      name: 'Hero',
      visible: true,
      absoluteBoundingBox: { x: 0, y: 100, width: 390, height: 400 },
      children: [
        { id: '1:3:a', type: 'TEXT', name: 'Headline', visible: true, characters: 'a' },
        { id: '1:3:b', type: 'TEXT', name: 'Subhead', visible: true, characters: 'b' },
        { id: '1:3:c', type: 'INSTANCE', name: 'CTA button', visible: true, characters: 'c' },
      ],
    };
    const screen = screenFrame('1:1', 'SCR-01', [small, big]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toBe('anchor');
    expect(candidates[0].occurrences[0].nodeId).toBe('1:3');
  });

  it('node <3 con KHÔNG đủ điều kiện anchor dù lớn nhất', () => {
    const twoChild = {
      id: '1:2',
      type: 'FRAME',
      name: 'Hero',
      visible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 400 },
      children: [
        { id: '1:2:a', type: 'TEXT', name: 'A', visible: true, characters: 'a' },
        { id: '1:2:b', type: 'TEXT', name: 'B', visible: true, characters: 'b' },
      ],
    };
    const screen = screenFrame('1:1', 'SCR-01', [twoChild]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    expect(candidates).toHaveLength(0);
  });

  it('node đã thuộc nhóm repeat KHÔNG được chọn lại làm anchor', () => {
    const screen = screenFrame('1:1', 'SCR-01', [
      card('1:2', 'Card A', 0, 0),
      card('1:3', 'Card B', 0, 210),
    ]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    expect(candidates.filter((c) => c.reason === 'anchor')).toHaveLength(0);
  });
});

describe('scanKitCandidates: maxCandidates', () => {
  it('mặc định 12 — cắt đuôi khi vượt quá', () => {
    const cards: unknown[] = [];
    for (let i = 0; i < 20; i += 1) {
      cards.push(card(`1:${i + 2}`, `Card ${i}`, (i % 4) * 170, Math.floor(i / 4) * 210));
    }
    const screen = screenFrame('1:1', 'SCR-01', cards);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    expect(candidates.length).toBeLessThanOrEqual(12);
  });

  it('tôn trọng maxCandidates tuỳ chỉnh', () => {
    // Mỗi màn có một Hero với ruột KHÁC HẲN nhau (chữ ký khác) để mỗi màn
    // sinh ra một anchor RIÊNG (không gộp lại thành một nhóm repeat).
    // normalizeName bỏ hậu tố số ở cuối tên — dùng chữ khác nhau (không phải
    // số) để KHÔNG bị gộp chữ ký qua normalizeName.
    const words = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
    const screens = Array.from({ length: 5 }, (_, i) =>
      screenFrame(`1:${i}`, `SCR-0${i}`, [
        {
          id: `1:${i}:hero`,
          type: 'FRAME',
          name: 'Hero',
          visible: true,
          absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 400 },
          children: [
            { id: `1:${i}:a`, type: 'TEXT', name: `Headline ${words[i]}`, visible: true, characters: 'a' },
            { id: `1:${i}:b`, type: 'TEXT', name: `Subhead ${words[i]}`, visible: true, characters: 'b' },
            { id: `1:${i}:c`, type: 'TEXT', name: `Detail ${words[i]}`, visible: true, characters: 'c' },
          ],
        },
      ]),
    ).map((node, i) => ({ screenKey: `SCR-0${i}`, node }));
    const candidates = scanKitCandidates(screens, { maxCandidates: 3 });
    expect(candidates).toHaveLength(3);
  });
});

describe('scanKitCandidates: id/thứ tự ổn định', () => {
  it('id KC-01, KC-02… theo thứ tự repeat (nhiều occurrence trước) rồi anchor', () => {
    const screen1 = screenFrame('1:1', 'SCR-01', [
      card('1:2', 'Card A', 0, 0),
      card('1:3', 'Card B', 0, 210),
      card('1:4', 'Card C', 0, 420),
    ]);
    const screen2 = screenFrame('2:1', 'SCR-02', [
      {
        id: '2:2',
        type: 'FRAME',
        name: 'Row',
        visible: true,
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 60 },
        children: [
          { id: '2:2:a', type: 'TEXT', name: 'A', visible: true, characters: 'a' },
          { id: '2:2:b', type: 'TEXT', name: 'B', visible: true, characters: 'b' },
        ],
      },
      {
        id: '2:3',
        type: 'FRAME',
        name: 'Row',
        visible: true,
        absoluteBoundingBox: { x: 0, y: 70, width: 200, height: 60 },
        children: [
          { id: '2:3:a', type: 'TEXT', name: 'A', visible: true, characters: 'a' },
          { id: '2:3:b', type: 'TEXT', name: 'B', visible: true, characters: 'b' },
        ],
      },
      {
        id: '2:4',
        type: 'FRAME',
        name: 'Hero',
        visible: true,
        absoluteBoundingBox: { x: 0, y: 140, width: 390, height: 400 },
        children: [
          { id: '2:4:a', type: 'TEXT', name: 'A', visible: true, characters: 'a' },
          { id: '2:4:b', type: 'TEXT', name: 'B', visible: true, characters: 'b' },
          { id: '2:4:c', type: 'TEXT', name: 'C', visible: true, characters: 'c' },
        ],
      },
    ]);
    const candidates = scanKitCandidates([
      { screenKey: 'SCR-01', node: screen1 },
      { screenKey: 'SCR-02', node: screen2 },
    ]);
    // Card group (3 occurrence) đứng trước Row group (2 occurrence) — nhiều
    // occurrence trước; anchor (Hero) đứng cuối cùng.
    expect(candidates.map((c) => c.id)).toEqual(['KC-01', 'KC-02', 'KC-03']);
    expect(candidates[0].reason).toBe('repeat');
    expect(candidates[0].occurrences).toHaveLength(3);
    expect(candidates[1].reason).toBe('repeat');
    expect(candidates[1].occurrences).toHaveLength(2);
    expect(candidates[2].reason).toBe('anchor');

    // Cùng input → cùng thứ tự (tất định).
    const again = scanKitCandidates([
      { screenKey: 'SCR-01', node: screen1 },
      { screenKey: 'SCR-02', node: screen2 },
    ]);
    expect(again.map((c) => c.id)).toEqual(candidates.map((c) => c.id));
  });
});

describe('scanKitCandidates: hasInstance', () => {
  it('candidate có ít nhất một occurrence chứa INSTANCE bên trong → hasInstance true', () => {
    const withInstance = {
      id: '1:2',
      type: 'FRAME',
      name: 'Card',
      visible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 200 },
      children: [
        { id: '1:2:icon', type: 'INSTANCE', name: 'Icon', visible: true },
        { id: '1:2:title', type: 'TEXT', name: 'Title', visible: true, characters: 'x' },
      ],
    };
    const withInstance2 = { ...withInstance, id: '1:3', absoluteBoundingBox: { x: 0, y: 210, width: 160, height: 200 } };
    const screen = screenFrame('1:1', 'SCR-01', [withInstance, withInstance2]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    expect(candidates[0].hasInstance).toBe(true);
  });

  it('không có INSTANCE nào bên trong bất kỳ occurrence → hasInstance false', () => {
    const screen = screenFrame('1:1', 'SCR-01', [card('1:2', 'Card A', 0, 0), card('1:3', 'Card B', 0, 210)]);
    const candidates = scanKitCandidates([{ screenKey: 'SCR-01', node: screen }]);
    expect(candidates[0].hasInstance).toBe(false);
  });
});

describe('renderKitCandidatesMd', () => {
  it('render bảng markdown với id/tên/lặp/màn/instance/lý do', () => {
    const candidates: KitCandidate[] = [
      {
        id: 'KC-01',
        signature: 'FRAME|x',
        suggestedName: 'Card',
        occurrences: [
          { screenKey: 'SCR-01', nodeId: '1:2', name: 'Card A' },
          { screenKey: 'SCR-02', nodeId: '2:2', name: 'Card B' },
        ],
        childrenSummary: ['TEXT:title'],
        hasInstance: true,
        reason: 'repeat',
      },
    ];
    const md = renderKitCandidatesMd(candidates);
    expect(md).toContain('KC-01');
    expect(md).toContain('Card');
    expect(md).toContain('SCR-01');
    expect(md).toContain('SCR-02');
    expect(md).toContain('repeat');
  });

  it('mảng rỗng → chuỗi rỗng', () => {
    expect(renderKitCandidatesMd([])).toBe('');
  });
});

describe('hằng số path', () => {
  it('KIT_CANDIDATES_FILE_REL/DIR_REL/kitCandidatePngRel', () => {
    expect(KIT_CANDIDATES_FILE_REL).toBe('kit-candidates.json');
    expect(KIT_CANDIDATES_DIR_REL).toBe('kit-candidates');
    expect(kitCandidatePngRel('KC-01')).toBe('kit-candidates/KC-01.png');
    expect(kitCandidatePngRel('KC 01 / Đề xuất')).toBe('kit-candidates/KC_01______xu_t.png');
  });
});
