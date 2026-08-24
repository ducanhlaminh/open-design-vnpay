// ds-lab / lab-refs (WP-lab-refs-daemon — .tmp/pipeline/wp-lab-refs-daemon.yaml,
// WP-lab-refs-v2 — .tmp/pipeline/wp-lab-refs-v2-daemon.yaml)
// red-spec: pure module (parseFigmaPageLink/detectConceptsFromNode/
// isScreenLikeCandidate/buildConceptStructure) + fs-boundary module
// (readLabRefs/writeLabRefs/scanLabRefs).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildConceptStructure,
  conceptPngRel,
  conceptSlug,
  conceptStructureRel,
  detectConceptsFromNode,
  detectConceptsFromPage,
  isScreenLikeCandidate,
  parseFigmaPageLink,
  readLabRefs,
  scanLabRefs,
  writeLabRefs,
  LAB_REFS_DIR_REL,
  LAB_REFS_FILE_REL,
  STRUCTURE_MAX_DEPTH,
  STRUCTURE_MAX_NODES,
  type RefsFile,
} from '../src/lab-refs.js';
import { registerFigmaBuildRoutes } from '../src/figma-build-routes.js';

// registerFigmaBuildRoutes imports db.js for OTHER routes in the same file
// (figma-build job, figma-preview) — mock it out so this file doesn't need a
// real SQLite instance (same shape as figma-build.test.ts's mock).
vi.mock('../src/db.js', () => ({
  getProject: (_db: unknown, id: string) => ({ id, name: id, metadata: undefined }),
  getPipelineApp: () => null,
  getFigmaDesignSystemSource: () => null,
  insertConversation: () => undefined,
  upsertMessage: () => undefined,
}));

// ── path constants ───────────────────────────────────────────────────────

describe('path constants', () => {
  it('match the docblock claims', () => {
    expect(LAB_REFS_DIR_REL).toBe('refs');
    expect(LAB_REFS_FILE_REL).toBe('refs/refs.json');
  });
});

// ── parseFigmaPageLink ───────────────────────────────────────────────────

describe('parseFigmaPageLink', () => {
  it('parses a "design" link with node-id, dash-form → colon-form', () => {
    const parsed = parseFigmaPageLink('https://www.figma.com/design/ABC123/My-File?node-id=123-456');
    expect(parsed).toEqual({
      fileKey: 'ABC123',
      nodeId: '123:456',
      url: 'https://www.figma.com/design/ABC123/?node-id=123-456',
    });
  });

  it('parses a "file" link with node-id', () => {
    const parsed = parseFigmaPageLink('https://figma.com/file/XYZ789/Other?node-id=1-2&t=abc');
    expect(parsed).toEqual({
      fileKey: 'XYZ789',
      nodeId: '1:2',
      url: 'https://www.figma.com/design/XYZ789/?node-id=1-2',
    });
  });

  it('missing node-id → null (a page/selection link always carries one)', () => {
    expect(parseFigmaPageLink('https://www.figma.com/design/ABC123/My-File')).toBeNull();
  });

  it('not a Figma link, malformed URL, or blank → null', () => {
    expect(parseFigmaPageLink('https://example.com/design/ABC123?node-id=1-2')).toBeNull();
    expect(parseFigmaPageLink('not a url')).toBeNull();
    expect(parseFigmaPageLink('')).toBeNull();
    expect(parseFigmaPageLink('   ')).toBeNull();
  });

  it('a node-id not shaped like "<num>-<num>" → null', () => {
    expect(parseFigmaPageLink('https://www.figma.com/design/ABC123/File?node-id=abc')).toBeNull();
  });
});

// ── isScreenLikeCandidate ────────────────────────────────────────────────

function box(width: number, height: number) {
  return { absoluteBoundingBox: { x: 0, y: 0, width, height } };
}

describe('isScreenLikeCandidate', () => {
  // Bảng case từ số liệu thật đo trên page 76-frame ([SDK] SIM Giá Rẻ Copy,
  // 4:147, 24/08) — xem .tmp/pipeline/wp-lab-refs-v2-daemon.yaml.
  it('2550x132 (dải ngang utility-section) → loại (w/h > 3)', () => {
    expect(isScreenLikeCandidate(box(2550, 132))).toBe(false);
  });

  it('515x72 (utility-flow) → loại (min(w,h) < 100)', () => {
    expect(isScreenLikeCandidate(box(515, 72))).toBe(false);
  });

  it('390x148 (utility-note) → loại (h < 300)', () => {
    expect(isScreenLikeCandidate(box(390, 148))).toBe(false);
  });

  it('20x20 (icon) → loại (min(w,h) < 100)', () => {
    expect(isScreenLikeCandidate(box(20, 20))).toBe(false);
  });

  it('390x844 (màn thật) → giữ', () => {
    expect(isScreenLikeCandidate(box(390, 844))).toBe(true);
  });

  it('390x1887 (màn thật, cao) → giữ', () => {
    expect(isScreenLikeCandidate(box(390, 1887))).toBe(true);
  });

  it('không có absoluteBoundingBox/width/height → loại', () => {
    expect(isScreenLikeCandidate({})).toBe(false);
    expect(isScreenLikeCandidate({ absoluteBoundingBox: { width: 390 } })).toBe(false);
  });
});

// ── detectConceptsFromNode ───────────────────────────────────────────────

describe('detectConceptsFromNode', () => {
  it('node null, hoặc type không phải page/frame/section → ok:false, detail mới', () => {
    expect(detectConceptsFromNode(null)).toEqual({
      ok: false,
      detail: 'link không trỏ vào page/frame/section',
      candidates: [],
    });
    const result = detectConceptsFromNode({ id: '1:1', type: 'TEXT', name: 'Không phải page' });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('link không trỏ vào page/frame/section');
    expect(result.candidates).toEqual([]);
  });

  it('FRAME link: CHÍNH node đó = 1 concept duy nhất, KHÔNG qua bộ lọc hình học (kể cả hình dạng "rác")', () => {
    const node = { id: '9:9', type: 'FRAME', name: 'Chọn thẳng frame nhỏ', absoluteBoundingBox: { width: 20, height: 20 } };
    const result = detectConceptsFromNode(node);
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.candidates).toEqual([{ nodeId: '9:9', name: 'Chọn thẳng frame nhỏ', width: 20, height: 20 }]);
  });

  it('COMPONENT/COMPONENT_SET/INSTANCE link: cũng CHÍNH nó = 1 concept, không lọc', () => {
    for (const type of ['COMPONENT', 'COMPONENT_SET', 'INSTANCE']) {
      const node = { id: '9:9', type, name: 'X', absoluteBoundingBox: { width: 390, height: 844 } };
      const result = detectConceptsFromNode(node);
      expect(result.ok).toBe(true);
      expect(result.candidates.map((c) => c.nodeId)).toEqual(['9:9']);
    }
  });

  it('SECTION link: con trực tiếp thuộc 4 type concept, QUA bộ lọc hình học; con khác type/ẩn bị bỏ', () => {
    const node = {
      id: '5:5',
      type: 'SECTION',
      name: 'Nhóm',
      children: [
        { id: 'a', type: 'FRAME', name: 'Màn thật', absoluteBoundingBox: { width: 390, height: 844 } },
        { id: 'b', type: 'FRAME', name: 'icon rác', absoluteBoundingBox: { width: 20, height: 20 } },
        { id: 'c', type: 'FRAME', name: 'Ẩn', visible: false, absoluteBoundingBox: { width: 390, height: 844 } },
        { id: 'd', type: 'TEXT', name: 'không phải concept' },
      ],
    };
    const result = detectConceptsFromNode(node);
    expect(result.candidates.map((c) => c.nodeId)).toEqual(['a']);
    expect(result.warning).toBe('trang Nhóm: đã loại 1 frame không giống màn (dải ngang/icon/ghi chú)');
  });

  it('CANVAS: lọc hình học loại đúng rác, giữ đúng màn thật (mô phỏng page 76-frame thật)', () => {
    const junk = [
      { id: 'j1', type: 'FRAME', name: 'utility-section', absoluteBoundingBox: { width: 2550, height: 132 } },
      { id: 'j2', type: 'FRAME', name: 'utility-flow', absoluteBoundingBox: { width: 515, height: 72 } },
      { id: 'j3', type: 'FRAME', name: 'utility-note', absoluteBoundingBox: { width: 390, height: 148 } },
      { id: 'j4', type: 'FRAME', name: 'icon', absoluteBoundingBox: { width: 20, height: 20 } },
    ];
    const realScreens = Array.from({ length: 56 }, (_, i) => ({
      id: `s${i}`,
      type: 'FRAME',
      name: `Màn ${i}`,
      absoluteBoundingBox: { width: 390, height: 844 },
    }));
    const pageDoc = { id: '0:1', type: 'CANVAS', name: 'Trang thật', children: [...junk, ...realScreens] };
    const result = detectConceptsFromNode(pageDoc);
    expect(result.ok).toBe(true);
    expect(result.candidates.length).toBe(56);
    expect(result.candidates.map((c) => c.nodeId)).toEqual(realScreens.map((s) => s.id));
    expect(result.warning).toBe('trang Trang thật: đã loại 4 frame không giống màn (dải ngang/icon/ghi chú)');
  });

  it('CANVAS: SECTION đóng góp con trực tiếp (qua lọc); node ẩn ở mọi cấp bị bỏ', () => {
    const pageDoc = {
      id: '0:1',
      type: 'CANVAS',
      name: 'Concepts',
      children: [
        { id: '1:1', type: 'FRAME', name: 'Màn A', absoluteBoundingBox: { width: 390, height: 844 } },
        { id: '1:2', type: 'FRAME', name: 'Ẩn', visible: false, absoluteBoundingBox: { width: 390, height: 844 } },
        { id: '1:3', type: 'TEXT', name: 'Ghi chú' },
        {
          id: '1:4',
          type: 'SECTION',
          name: 'Nhóm',
          children: [
            { id: '1:5', type: 'FRAME', name: 'Màn B', absoluteBoundingBox: { width: 390, height: 844 } },
            { id: '1:6', type: 'COMPONENT', name: 'Comp con', absoluteBoundingBox: { width: 390, height: 844 } },
            { id: '1:7', type: 'FRAME', name: 'Ẩn trong section', visible: false, absoluteBoundingBox: { width: 390, height: 844 } },
            { id: '1:8', type: 'TEXT', name: 'Không phải concept' },
          ],
        },
        { id: '1:9', type: 'COMPONENT_SET', name: 'Set C', absoluteBoundingBox: { width: 390, height: 844 } },
        { id: '1:10', type: 'INSTANCE', name: 'Instance D', absoluteBoundingBox: { width: 390, height: 844 } },
      ],
    };
    const result = detectConceptsFromNode(pageDoc);
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.candidates.map((c) => c.nodeId)).toEqual(['1:1', '1:5', '1:6', '1:9', '1:10']);
  });

  it('a hidden SECTION excludes all of its children too', () => {
    const pageDoc = {
      id: '0:1',
      type: 'CANVAS',
      name: 'P',
      children: [
        {
          id: '1:4',
          type: 'SECTION',
          name: 'Nhóm ẩn',
          visible: false,
          children: [{ id: '1:5', type: 'FRAME', name: 'X', absoluteBoundingBox: { width: 390, height: 844 } }],
        },
      ],
    };
    expect(detectConceptsFromNode(pageDoc).candidates).toEqual([]);
  });

  it('caps at 60 concepts/page SAU bộ lọc, kèm cảnh báo nêu tên trang + tổng thật', () => {
    const children = Array.from({ length: 65 }, (_, i) => ({
      id: `1:${i}`,
      type: 'FRAME',
      name: `Màn ${i}`,
      absoluteBoundingBox: { width: 390, height: 844 },
    }));
    const pageDoc = { id: '0:1', type: 'CANVAS', name: 'Trang lớn', children };
    const result = detectConceptsFromNode(pageDoc);
    expect(result.ok).toBe(true);
    expect(result.candidates.length).toBe(60);
    expect(result.candidates.map((c) => c.nodeId)).toEqual(children.slice(0, 60).map((c) => c.id));
    expect(result.warning).toBe('trang Trang lớn có 65 frame, chỉ lấy 60 đầu');
  });

  it('exactly 60 concepts (đã qua lọc) → no warning', () => {
    const children = Array.from({ length: 60 }, (_, i) => ({
      id: `1:${i}`,
      type: 'FRAME',
      name: `Màn ${i}`,
      absoluteBoundingBox: { width: 390, height: 844 },
    }));
    const result = detectConceptsFromNode({ id: '0:1', type: 'CANVAS', name: 'P', children });
    expect(result.warning).toBeUndefined();
    expect(result.candidates.length).toBe(60);
  });

  it('cap + lọc cùng lúc → warning nối cả hai bằng " | "', () => {
    const junk = Array.from({ length: 3 }, (_, i) => ({ id: `j${i}`, type: 'FRAME', name: 'rác', absoluteBoundingBox: { width: 20, height: 20 } }));
    const realScreens = Array.from({ length: 65 }, (_, i) => ({
      id: `s${i}`,
      type: 'FRAME',
      name: `Màn ${i}`,
      absoluteBoundingBox: { width: 390, height: 844 },
    }));
    const result = detectConceptsFromNode({ id: '0:1', type: 'CANVAS', name: 'Trang X', children: [...junk, ...realScreens] });
    expect(result.candidates.length).toBe(60);
    expect(result.warning).toBe(
      'trang Trang X: đã loại 3 frame không giống màn (dải ngang/icon/ghi chú) | trang Trang X có 65 frame, chỉ lấy 60 đầu',
    );
  });

  it('a top-level node missing "id" or "name" is skipped, not crashed on', () => {
    const pageDoc = {
      id: '0:1',
      type: 'CANVAS',
      name: 'P',
      children: [
        { type: 'FRAME', absoluteBoundingBox: { width: 390, height: 844 } },
        { id: '1:1', type: 'FRAME', absoluteBoundingBox: { width: 390, height: 844 } },
        { id: '1:2', type: 'FRAME', name: 'OK', absoluteBoundingBox: { width: 390, height: 844 } },
      ],
    };
    expect(detectConceptsFromNode(pageDoc).candidates).toEqual([{ nodeId: '1:2', name: 'OK', width: 390, height: 844 }]);
  });

  it('detectConceptsFromPage vẫn export như alias tương thích ngược (cùng hàm)', () => {
    expect(detectConceptsFromPage).toBe(detectConceptsFromNode);
  });
});

// ── buildConceptStructure ────────────────────────────────────────────────

describe('buildConceptStructure', () => {
  it('rút gọn: type/name/w/h + layoutMode/itemSpacing/padding gộp 4 cạnh + text (TEXT, cắt 120) + children đệ quy', () => {
    const node = {
      id: '1',
      type: 'FRAME',
      name: 'Card',
      absoluteBoundingBox: { width: 300, height: 200 },
      layoutMode: 'VERTICAL',
      itemSpacing: 8,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
      paddingLeft: 16,
      children: [
        {
          id: '2',
          type: 'TEXT',
          name: 'Title',
          absoluteBoundingBox: { width: 100, height: 20 },
          characters: 'x'.repeat(200),
        },
      ],
    };
    const structure = buildConceptStructure(node);
    expect(structure).toEqual({
      type: 'FRAME',
      name: 'Card',
      w: 300,
      h: 200,
      layoutMode: 'VERTICAL',
      itemSpacing: 8,
      padding: '16 16 16 16',
      children: [{ type: 'TEXT', name: 'Title', w: 100, h: 20, text: 'x'.repeat(120) }],
    });
  });

  it('không layoutMode/itemSpacing/padding/text khi node không có field đó', () => {
    const node = { id: '1', type: 'RECTANGLE', name: 'Bg', absoluteBoundingBox: { width: 10, height: 10 } };
    expect(buildConceptStructure(node)).toEqual({ type: 'RECTANGLE', name: 'Bg', w: 10, h: 10 });
  });

  it('depth > STRUCTURE_MAX_DEPTH (6) → cắt cành, truncated:true, không children', () => {
    let node: unknown = { id: 'leaf', type: 'FRAME', name: 'Leaf', absoluteBoundingBox: { width: 10, height: 10 } };
    // 8 tầng lồng nhau (root ở depth 1) → tầng thứ 6 phải bị cắt.
    for (let i = 0; i < 8; i++) {
      node = { id: `n${i}`, type: 'FRAME', name: `N${i}`, absoluteBoundingBox: { width: 10, height: 10 }, children: [node] };
    }
    const structure = buildConceptStructure(node)!;
    let cur = structure;
    for (let d = 1; d < STRUCTURE_MAX_DEPTH; d++) {
      expect(cur.truncated).toBeUndefined();
      expect(cur.children).toBeDefined();
      cur = cur.children![0]!;
    }
    expect(cur.truncated).toBe(true);
    expect(cur.children).toBeUndefined();
  });

  it('> STRUCTURE_MAX_NODES (400) node → cắt, tổng node ≤ 400, truncated:true ở nhánh bị cắt', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      id: `c${i}`,
      type: 'RECTANGLE',
      name: `R${i}`,
      absoluteBoundingBox: { width: 5, height: 5 },
    }));
    const root = { id: 'root', type: 'FRAME', name: 'Root', absoluteBoundingBox: { width: 100, height: 100 }, children: many };
    const structure = buildConceptStructure(root)!;
    function countNodes(n: { children?: unknown[] }): number {
      const children = Array.isArray(n.children) ? (n.children as { children?: unknown[] }[]) : [];
      return 1 + children.reduce((sum, c) => sum + countNodes(c), 0);
    }
    expect(countNodes(structure)).toBeLessThanOrEqual(STRUCTURE_MAX_NODES);
    expect(structure.truncated).toBe(true);
  });

  it('INSTANCE/COMPONENT/COMPONENT_SET không phải gốc: không đi sâu vào con (chỉ type/name/w/h)', () => {
    for (const type of ['INSTANCE', 'COMPONENT', 'COMPONENT_SET']) {
      const node = {
        id: '1',
        type: 'FRAME',
        name: 'Screen',
        absoluteBoundingBox: { width: 390, height: 844 },
        children: [
          {
            id: 'i1',
            type,
            name: 'Comp con',
            absoluteBoundingBox: { width: 390, height: 44 },
            children: [{ id: 'x', type: 'RECTANGLE', name: 'pin', absoluteBoundingBox: { width: 5, height: 5 } }],
          },
        ],
      };
      const structure = buildConceptStructure(node)!;
      expect(structure.children).toEqual([{ type, name: 'Comp con', w: 390, h: 44 }]);
    }
  });

  it('gốc là INSTANCE/COMPONENT/COMPONENT_SET (concept chính là 1 comp): NGOẠI LỆ, gốc vẫn được mở con', () => {
    for (const type of ['INSTANCE', 'COMPONENT', 'COMPONENT_SET']) {
      const node = {
        id: 'root',
        type,
        name: 'Comp gốc',
        absoluteBoundingBox: { width: 390, height: 844 },
        children: [{ id: 'x', type: 'RECTANGLE', name: 'ruột', absoluteBoundingBox: { width: 5, height: 5 } }],
      };
      const structure = buildConceptStructure(node)!;
      expect(structure.children).toEqual([{ type: 'RECTANGLE', name: 'ruột', w: 5, h: 5 }]);
    }
  });
});

// ── conceptSlug / conceptPngRel / conceptStructureRel ───────────────────

describe('conceptSlug / conceptPngRel / conceptStructureRel', () => {
  it('builds stable "refs/<fileKey>-<nodeId>.{png,structure.json}" paths, replacing ":" with "-"', () => {
    expect(conceptSlug('ABC123', '1:2')).toBe('ABC123-1-2');
    expect(conceptPngRel('ABC123', '1:2')).toBe('refs/ABC123-1-2.png');
    expect(conceptStructureRel('ABC123', '1:2')).toBe('refs/ABC123-1-2.structure.json');
  });
});

// ── readLabRefs / writeLabRefs ───────────────────────────────────────────

describe('readLabRefs / writeLabRefs', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('missing refs.json → default empty registry (incl. warnings:[]), no scannedAt field', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-'));
    roots.push(root);
    const refs = await readLabRefs(root);
    expect(refs).toEqual({ schema_version: 1, pages: [], concepts: [], warnings: [] });
    expect('scannedAt' in refs).toBe(false);
  });

  it('corrupted JSON, or valid JSON missing pages/concepts arrays → same default (fail-soft, never throws)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-'));
    roots.push(root);
    await mkdir(path.join(root, 'refs'), { recursive: true });
    await writeFile(path.join(root, 'refs', 'refs.json'), '{not json', 'utf8');
    expect(await readLabRefs(root)).toEqual({ schema_version: 1, pages: [], concepts: [], warnings: [] });

    await writeFile(path.join(root, 'refs', 'refs.json'), JSON.stringify({ schema_version: 1 }), 'utf8');
    expect(await readLabRefs(root)).toEqual({ schema_version: 1, pages: [], concepts: [], warnings: [] });
  });

  it('a registry written BEFORE WP-lab-refs-v2 (no "warnings" field) → warnings defaults to [], NOT treated as broken', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-'));
    roots.push(root);
    await mkdir(path.join(root, 'refs'), { recursive: true });
    const oldFile = {
      schema_version: 1,
      scannedAt: '2026-08-01T00:00:00.000Z',
      pages: [{ url: 'https://www.figma.com/design/F/?node-id=1-2', fileKey: 'F', nodeId: '1:2', ok: true, name: 'Trang' }],
      concepts: [{ id: 'F:1:2', fileKey: 'F', nodeId: '1:2', name: 'Màn A', png: 'refs/F-1-2.png' }],
    };
    await writeFile(path.join(root, 'refs', 'refs.json'), JSON.stringify(oldFile), 'utf8');
    const refs = await readLabRefs(root);
    expect(refs.warnings).toEqual([]);
    expect(refs.pages).toEqual(oldFile.pages);
    expect(refs.concepts).toEqual(oldFile.concepts);
  });

  it('round-trips a written registry, including scannedAt and warnings', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-'));
    roots.push(root);
    const refs: RefsFile = {
      schema_version: 1,
      scannedAt: '2026-08-24T00:00:00.000Z',
      pages: [{ url: 'https://www.figma.com/design/F/?node-id=1-2', fileKey: 'F', nodeId: '1:2', ok: true, name: 'Trang', kind: 'page' }],
      concepts: [{ id: 'F:1:2', fileKey: 'F', nodeId: '1:2', name: 'Màn A', png: 'refs/F-1-2.png', structure: 'refs/F-1-2.structure.json' }],
      warnings: ['một cảnh báo'],
    };
    await writeLabRefs(root, refs);
    expect(await readLabRefs(root)).toEqual(refs);
    const onDisk = JSON.parse(await readFile(path.join(root, 'refs', 'refs.json'), 'utf8'));
    expect(onDisk).toEqual(refs);
  });
});

// ── scanLabRefs ──────────────────────────────────────────────────────────

function fakeRestFetch(routes: {
  nodes?: (url: URL) => { status?: number; body?: unknown };
  images?: (url: URL) => { status?: number; body?: unknown };
  png?: (url: URL) => { status?: number; body?: Buffer };
}) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname === 'api.figma.com') {
      if (url.pathname.includes('/nodes')) {
        const out = routes.nodes?.(url) ?? { body: { nodes: {} } };
        return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.startsWith('/v1/images/')) {
        const out = routes.images?.(url) ?? { body: { images: {} } };
        return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
    }
    // PNG "S3" download.
    const out = routes.png?.(url) ?? { body: Buffer.from('fake-png') };
    return new Response(out.body ?? Buffer.from('fake-png'), { status: out.status ?? 200 });
  };
}

describe('scanLabRefs', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('an invalid link (no node-id) → page row ok:false, no throw, nothing else affected', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    const fetchImpl = fakeRestFetch({});
    const { refs, warnings } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/ABC/File'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch },
    });
    expect(refs.pages).toEqual([
      { url: 'https://www.figma.com/design/ABC/File', fileKey: '', nodeId: '', ok: false, detail: expect.stringContaining('Link không hợp lệ') },
    ]);
    expect(refs.concepts).toEqual([]);
    expect(refs.warnings).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('a page REST 403 → page row ok:false, detail via describeFigmaError, does not throw', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    const fetchImpl = fakeRestFetch({
      nodes: () => ({ status: 403, body: { status: 403, err: 'Not authorized' } }),
    });
    const { refs } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/ABC/File?node-id=1-2'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch },
    });
    expect(refs.pages).toEqual([
      { url: 'https://www.figma.com/design/ABC/?node-id=1-2', fileKey: 'ABC', nodeId: '1:2', ok: false, detail: expect.any(String) },
    ]);
    expect(refs.pages[0]!.detail).toContain('quyền');
  });

  it('a valid page with concepts: downloads PNGs + writes structure.json, and one concept whose image 404s keeps the concept with an empty png + a warning persisted in refs.json', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    const pageDoc = {
      id: '1:2',
      type: 'CANVAS',
      name: 'Trang concept',
      children: [
        { id: '1:3', type: 'FRAME', name: 'Màn A', absoluteBoundingBox: { width: 390, height: 844 } },
        { id: '1:4', type: 'FRAME', name: 'Màn B', absoluteBoundingBox: { width: 390, height: 844 } },
      ],
    };
    const fetchImpl = fakeRestFetch({
      nodes: () => ({ body: { nodes: { '1:2': { document: pageDoc } } } }),
      images: () => ({ body: { images: { '1:3': 'https://s3.example.com/a.png', '1:4': null } } }),
      png: () => ({ body: Buffer.from('PNGDATA') }),
    });
    const { refs, warnings } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/ABC/File?node-id=1-2'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch, now: () => new Date('2026-08-24T00:00:00.000Z') },
    });
    expect(refs.pages).toEqual([
      { url: 'https://www.figma.com/design/ABC/?node-id=1-2', fileKey: 'ABC', nodeId: '1:2', ok: true, name: 'Trang concept', kind: 'page' },
    ]);
    expect(refs.concepts).toEqual([
      { id: 'ABC:1:3', fileKey: 'ABC', nodeId: '1:3', name: 'Màn A', png: 'refs/ABC-1-3.png', structure: 'refs/ABC-1-3.structure.json', width: 390, height: 844 },
      { id: 'ABC:1:4', fileKey: 'ABC', nodeId: '1:4', name: 'Màn B', png: '', structure: 'refs/ABC-1-4.structure.json', width: 390, height: 844 },
    ]);
    expect(warnings.some((w) => w.includes('Màn B'))).toBe(true);
    // warnings are PERSISTED into refs.json — not just the PUT response.
    expect(refs.warnings).toEqual(warnings);
    const written = await readFile(path.join(root, 'refs', 'ABC-1-3.png'));
    expect(written.toString()).toBe('PNGDATA');
    const structureOnDisk = JSON.parse(await readFile(path.join(root, 'refs', 'ABC-1-3.structure.json'), 'utf8'));
    expect(structureOnDisk).toEqual({ type: 'FRAME', name: 'Màn A', w: 390, h: 844 });
    expect(refs.scannedAt).toBe('2026-08-24T00:00:00.000Z');
    // refs.json persisted on disk, matching the returned value.
    const onDisk = JSON.parse(await readFile(path.join(root, 'refs', 'refs.json'), 'utf8'));
    expect(onDisk).toEqual(refs);
  });

  it('a selection link straight to a FRAME → kind "frame" + "size" in the page row, 1 concept', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    const frameDoc = { id: '9:9', type: 'FRAME', name: 'Màn chọn thẳng', absoluteBoundingBox: { width: 390, height: 844 } };
    const fetchImpl = fakeRestFetch({
      nodes: () => ({ body: { nodes: { '9:9': { document: frameDoc } } } }),
      images: () => ({ body: { images: { '9:9': 'https://s3.example.com/a.png' } } }),
    });
    const { refs } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/ABC/File?node-id=9-9'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch },
    });
    expect(refs.pages).toEqual([
      { url: 'https://www.figma.com/design/ABC/?node-id=9-9', fileKey: 'ABC', nodeId: '9:9', ok: true, name: 'Màn chọn thẳng', kind: 'frame', size: '390x844' },
    ]);
    expect(refs.concepts.map((c) => c.id)).toEqual(['ABC:9:9']);
  });

  it('ảnh lỗi lần đầu (scale 2 throw) → retry sau 2s ở scale 1 thành công → concept có ảnh, không warning', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    const pageDoc = {
      id: '1:2',
      type: 'CANVAS',
      name: 'Trang',
      children: [{ id: '1:3', type: 'FRAME', name: 'Màn A', absoluteBoundingBox: { width: 390, height: 844 } }],
    };
    const scaleSeen: string[] = [];
    const fetchImpl = fakeRestFetch({
      nodes: () => ({ body: { nodes: { '1:2': { document: pageDoc } } } }),
      images: (url) => {
        const scale = url.searchParams.get('scale') ?? '';
        scaleSeen.push(scale);
        if (scale === '2') throw new Error('transient figma error');
        return { body: { images: { '1:3': 'https://s3.example.com/a.png' } } };
      },
    });
    const sleepCalls: number[] = [];
    const { refs, warnings } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/ABC/File?node-id=1-2'],
      token: 'tok',
      deps: {
        fetch: fetchImpl as unknown as typeof fetch,
        sleep: async (ms: number) => {
          sleepCalls.push(ms);
        },
      },
    });
    expect(scaleSeen).toEqual(['2', '1']);
    expect(sleepCalls).toEqual([2000]);
    expect(refs.concepts[0]!.png).toBe('refs/ABC-1-3.png');
    expect(warnings).toEqual([]);
  });

  it('ảnh lỗi cả hai lần (scale 2 và scale 1) → png rỗng + warning trong refs.json.warnings', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    const pageDoc = {
      id: '1:2',
      type: 'CANVAS',
      name: 'Trang',
      children: [{ id: '1:3', type: 'FRAME', name: 'Màn A', absoluteBoundingBox: { width: 390, height: 844 } }],
    };
    const fetchImpl = fakeRestFetch({
      nodes: () => ({ body: { nodes: { '1:2': { document: pageDoc } } } }),
      images: () => {
        throw new Error('always fails');
      },
    });
    const { refs, warnings } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/ABC/File?node-id=1-2'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch, sleep: async () => undefined },
    });
    expect(refs.concepts[0]!.png).toBe('');
    // Chunk gộp (1 id → 1 chunk) fail cả hai lần → MỘT warning gộp cho chunk,
    // KHÔNG phải warning per-concept "giữ concept, ảnh rỗng" nữa (tránh spam
    // khi cả trang render lỗi — xem docblock `fetchImagesInChunks`).
    expect(warnings.some((w) => w.includes('1 ảnh không lấy được từ Figma'))).toBe(true);
    expect(warnings.some((w) => w.includes('không lấy được ảnh render từ Figma — giữ concept'))).toBe(false);
    expect(refs.warnings).toEqual(warnings);
  });

  it('25 id → 3 chunk (10/10/5) đều OK → đủ ảnh cả 25 concept, fetchNodeImages được gọi đúng 3 lần ở scale 2', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    const children = Array.from({ length: 25 }, (_, i) => ({
      id: `1:${i}`,
      type: 'FRAME',
      name: `Màn ${i}`,
      absoluteBoundingBox: { width: 390, height: 844 },
    }));
    const pageDoc = { id: '1:2', type: 'CANVAS', name: 'Trang', children };
    const imageCalls: { scale: string; count: number }[] = [];
    const fetchImpl = fakeRestFetch({
      nodes: () => ({ body: { nodes: { '1:2': { document: pageDoc } } } }),
      images: (url) => {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
        imageCalls.push({ scale: url.searchParams.get('scale') ?? '', count: ids.length });
        return { body: { images: Object.fromEntries(ids.map((id) => [id, `https://s3.example.com/${id.replace(':', '-')}.png`])) } };
      },
    });
    const { refs, warnings } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/ABC/File?node-id=1-2'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch, sleep: async () => undefined },
    });
    expect(imageCalls).toEqual([
      { scale: '2', count: 10 },
      { scale: '2', count: 10 },
      { scale: '2', count: 5 },
    ]);
    expect(refs.concepts.length).toBe(25);
    expect(refs.concepts.every((c) => c.png.length > 0)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('25 id (3 chunk) — chunk giữa throw cả scale 2 lẫn scale 1 → concept của CHUNK ĐÓ png:"" + đúng 1 warning; hai chunk còn lại vẫn có ảnh', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    const children = Array.from({ length: 25 }, (_, i) => ({
      id: `1:${i}`,
      type: 'FRAME',
      name: `Màn ${i}`,
      absoluteBoundingBox: { width: 390, height: 844 },
    }));
    const pageDoc = { id: '1:2', type: 'CANVAS', name: 'Trang', children };
    const fetchImpl = fakeRestFetch({
      nodes: () => ({ body: { nodes: { '1:2': { document: pageDoc } } } }),
      images: (url) => {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
        // Chunk giữa (id 1:10..1:19, chunk #2) fail ở CẢ hai scale — chunk #1
        // (1:0..1:9) và #3 (1:20..1:24) luôn OK.
        if (ids.includes('1:10')) throw new Error('chunk giữa lỗi');
        return { body: { images: Object.fromEntries(ids.map((id) => [id, `https://s3.example.com/${id.replace(':', '-')}.png`])) } };
      },
    });
    const { refs, warnings } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/ABC/File?node-id=1-2'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch, sleep: async () => undefined },
    });
    const byId = new Map(refs.concepts.map((c) => [c.nodeId, c]));
    for (let i = 0; i < 10; i++) expect(byId.get(`1:${i}`)!.png).not.toBe('');
    for (let i = 10; i < 20; i++) expect(byId.get(`1:${i}`)!.png).toBe('');
    for (let i = 20; i < 25; i++) expect(byId.get(`1:${i}`)!.png).not.toBe('');
    // Đúng MỘT warning cho cả chunk giữa (10 concept), không phải 10 warning.
    const chunkWarnings = warnings.filter((w) => w.includes('ảnh không lấy được từ Figma'));
    expect(chunkWarnings).toHaveLength(1);
    expect(chunkWarnings[0]).toContain('10 ảnh không lấy được từ Figma');
  });

  it('25 id (3 chunk) — chunk giữa throw ở scale 2 nhưng scale 1 OK (retry cũ vẫn sống ở mức chunk) → đủ ảnh cả 25, không warning', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    const children = Array.from({ length: 25 }, (_, i) => ({
      id: `1:${i}`,
      type: 'FRAME',
      name: `Màn ${i}`,
      absoluteBoundingBox: { width: 390, height: 844 },
    }));
    const pageDoc = { id: '1:2', type: 'CANVAS', name: 'Trang', children };
    const fetchImpl = fakeRestFetch({
      nodes: () => ({ body: { nodes: { '1:2': { document: pageDoc } } } }),
      images: (url) => {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
        const scale = url.searchParams.get('scale');
        if (ids.includes('1:10') && scale === '2') throw new Error('chunk giữa lỗi tạm thời ở scale 2');
        return { body: { images: Object.fromEntries(ids.map((id) => [id, `https://s3.example.com/${id.replace(':', '-')}.png`])) } };
      },
    });
    const { refs, warnings } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/ABC/File?node-id=1-2'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch, sleep: async () => undefined },
    });
    expect(refs.concepts.length).toBe(25);
    expect(refs.concepts.every((c) => c.png.length > 0)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('re-scanning overwrites refs.json entirely and deletes a stale PNG/structure.json no longer in the new concept list', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    await mkdir(path.join(root, 'refs'), { recursive: true });
    await writeFile(path.join(root, 'refs', 'STALE-9-9.png'), 'old', 'utf8');
    await writeFile(path.join(root, 'refs', 'STALE-9-9.structure.json'), '{"type":"FRAME"}', 'utf8');
    await writeFile(
      path.join(root, 'refs', 'refs.json'),
      JSON.stringify({
        schema_version: 1,
        pages: [{ url: 'old', fileKey: 'OLD', nodeId: '9:9', ok: true }],
        concepts: [{ id: 'OLD:9:9', fileKey: 'OLD', nodeId: '9:9', name: 'Cũ', png: 'refs/STALE-9-9.png', structure: 'refs/STALE-9-9.structure.json' }],
        warnings: [],
      }),
      'utf8',
    );
    const pageDoc = {
      id: '1:2',
      type: 'CANVAS',
      name: 'Trang mới',
      children: [{ id: '1:3', type: 'FRAME', name: 'Màn mới', absoluteBoundingBox: { width: 390, height: 844 } }],
    };
    const fetchImpl = fakeRestFetch({
      nodes: () => ({ body: { nodes: { '1:2': { document: pageDoc } } } }),
      images: () => ({ body: { images: { '1:3': 'https://s3.example.com/a.png' } } }),
    });
    const { refs } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/NEW/File?node-id=1-2'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch },
    });
    expect(refs.concepts.map((c) => c.id)).toEqual(['NEW:1:3']);
    await expect(readFile(path.join(root, 'refs', 'STALE-9-9.png'))).rejects.toThrow();
    await expect(readFile(path.join(root, 'refs', 'STALE-9-9.structure.json'))).rejects.toThrow();
    expect(await readFile(path.join(root, 'refs', 'NEW-1-3.png'))).toBeTruthy();
    expect(await readFile(path.join(root, 'refs', 'NEW-1-3.structure.json'))).toBeTruthy();
  });

  it('never throws even when every single link is bad', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    await expect(
      scanLabRefs({ labCwd: root, links: ['not a link', ''], token: 'tok', deps: { fetch: fakeRestFetch({}) as unknown as typeof fetch } }),
    ).resolves.toBeDefined();
  });
});

// ── HTTP routes: GET/PUT /api/projects/:projectId/ds-lab/lab-refs ─────────

type Handler = (req: any, res: any) => unknown;

function response() {
  const output: { status: number; body?: unknown } = { status: 200 };
  const res = { status(code: number) { output.status = code; return res; }, json(body: unknown) { output.body = body; return res; } };
  return { output, res };
}

function register(dataDir: string) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(route: string, handler: Handler) { handlers.set(`GET ${route}`, handler); },
    post(route: string, handler: Handler) { handlers.set(`POST ${route}`, handler); },
    put(route: string, handler: Handler) { handlers.set(`PUT ${route}`, handler); },
  };
  registerFigmaBuildRoutes(app as never, {
    db: { prepare: () => ({ run: () => undefined }) },
    http: { isLocalSameOrigin: () => true, resolvedPortRef: { current: 7456 } },
    paths: { RUNTIME_DATA_DIR: dataDir, PROJECTS_DIR: path.join(dataDir, 'projects') },
    design: { runs: { create: () => ({ id: 'run-1' }), start: () => undefined, wait: async () => ({ status: 'succeeded' }) } },
    chat: { startChatRun: () => undefined },
    agents: {},
  } as never);
  return handlers;
}

describe('ds-lab/lab-refs routes', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('GET before any PUT → default empty registry', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-lab-refs-route-'));
    roots.push(root);
    const handlers = register(root);
    const r = response();
    await handlers.get('GET /api/projects/:projectId/ds-lab/lab-refs')!({ params: { projectId: 'proj-1' } }, r.res);
    expect(r.output.status).toBe(200);
    expect(r.output.body).toEqual({ schema_version: 1, pages: [], concepts: [], warnings: [] });
  });

  it('PUT with no links → 400 INVALID_INPUT (flat error shape)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-lab-refs-route-'));
    roots.push(root);
    const handlers = register(root);
    const r = response();
    await handlers.get('PUT /api/projects/:projectId/ds-lab/lab-refs')!({ params: { projectId: 'proj-1' }, body: { links: [] } }, r.res);
    expect(r.output.status).toBe(400);
    expect((r.output.body as any).error).toBe('INVALID_INPUT');
  });

  it('PUT with more than 10 links → 400 INVALID_INPUT', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-lab-refs-route-'));
    roots.push(root);
    const handlers = register(root);
    const r = response();
    const links = Array.from({ length: 11 }, (_, i) => `https://www.figma.com/design/F/File?node-id=${i}-1`);
    await handlers.get('PUT /api/projects/:projectId/ds-lab/lab-refs')!({ params: { projectId: 'proj-1' }, body: { links } }, r.res);
    expect(r.output.status).toBe(400);
    expect((r.output.body as any).error).toBe('INVALID_INPUT');
  });

  it('PUT without a configured Figma token → 400 FIGMA_TOKEN_REQUIRED (flat error shape per spec)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-lab-refs-route-'));
    roots.push(root);
    const handlers = register(root);
    const r = response();
    await handlers.get('PUT /api/projects/:projectId/ds-lab/lab-refs')!(
      { params: { projectId: 'proj-1' }, body: { links: ['https://www.figma.com/design/F/File?node-id=1-2'] } },
      r.res,
    );
    expect(r.output.status).toBe(400);
    expect(r.output.body).toEqual({ error: 'FIGMA_TOKEN_REQUIRED', detail: 'Chưa cấu hình Figma token trong Cài đặt → Figma.' });
  });

  it('PUT with a token configured scans, persists refs.json (incl. structure.json path), and a subsequent GET returns it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-lab-refs-route-'));
    roots.push(root);
    await writeFile(path.join(root, 'figma-config.json'), JSON.stringify({ token: 'secret-tok' }), 'utf8');
    const pageDoc = {
      id: '1:2',
      type: 'CANVAS',
      name: 'Trang',
      children: [{ id: '1:3', type: 'FRAME', name: 'Màn A', absoluteBoundingBox: { width: 390, height: 844 } }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.hostname === 'api.figma.com' && url.pathname.includes('/nodes')) {
          return new Response(JSON.stringify({ nodes: { '1:2': { document: pageDoc } } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.hostname === 'api.figma.com' && url.pathname.startsWith('/v1/images/')) {
          return new Response(JSON.stringify({ images: { '1:3': 'https://s3.example.com/a.png' } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(Buffer.from('PNGDATA'), { status: 200 });
      }),
    );
    const handlers = register(root);
    const put = response();
    await handlers.get('PUT /api/projects/:projectId/ds-lab/lab-refs')!(
      { params: { projectId: 'proj-1' }, body: { links: ['https://www.figma.com/design/F/File?node-id=1-2'] } },
      put.res,
    );
    expect(put.output.status).toBe(200);
    const body = put.output.body as { refs: RefsFile; warnings: string[] };
    expect(body.refs.concepts).toEqual([
      { id: 'F:1:3', fileKey: 'F', nodeId: '1:3', name: 'Màn A', png: 'refs/F-1-3.png', structure: 'refs/F-1-3.structure.json', width: 390, height: 844 },
    ]);
    // Never leak the token into the response.
    expect(JSON.stringify(body)).not.toContain('secret-tok');

    const get = response();
    await handlers.get('GET /api/projects/:projectId/ds-lab/lab-refs')!({ params: { projectId: 'proj-1' } }, get.res);
    expect((get.output.body as RefsFile).concepts).toEqual(body.refs.concepts);
  });
});
