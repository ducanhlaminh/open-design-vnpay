import { mkdtemp, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mineDesignTokens, renderTokensDtcg, renderTokensMd, type MineTokensInput } from '../src/figma-tokens.js';

// Route-level (mục D "Route-level" của spec): mock `figma-rest.js` ở mức
// module — cùng khuôn figma-design-system-guide.test.ts (mục 16 prefetch ảnh)
// — orchestration REST thật không phải phạm vi file này, chỉ cần điểm nối
// route/refresh gọi đúng mining + ghi đúng file, best-effort khi mining lỗi.
vi.mock('../src/figma-rest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/figma-rest.js')>();
  return {
    ...actual,
    fetchNodeSubtrees: vi.fn(async () => new Map()),
  };
});

import { closeDatabase, openDatabase } from '../src/db.js';
import { writeFigmaConfig } from '../src/figma-config.js';
import { FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION, type FigmaComponentCatalogSnapshot } from '../src/figma-component-catalog.js';
import {
  figmaDesignSystemSlotsMdPath,
  figmaDesignSystemTokensJsonPath,
  figmaDesignSystemTokensMdPath,
  registerFigmaDesignSystemRoutes,
  writeTokensMarkdownToCriteria,
} from '../src/figma-design-system-routes.js';
import { fetchNodeSubtrees } from '../src/figma-rest.js';

type Handler = (req: any, res: any) => unknown;
function response() {
  const output: { status: number; body?: any } = { status: 200 };
  const res = {
    status(code: number) { output.status = code; return res; },
    json(body: unknown) { output.body = body; return res; },
    send(body?: unknown) { output.body = body; return res; },
  };
  return { output, res };
}

// Fixture tay theo `.tmp/pipeline/wp-ds-tokens.yaml` mục D:
// - Component A ("Primary Button"): fill #0052FF ở 2 chỗ (root + Surface),
//   một paint fill visible:false (đen) phải bị bỏ, text Inter 600 16/24px,
//   radius 12 trên Surface, một node cornerRadius=0 bị bỏ, một node ẨN
//   (visible:false) mang cornerRadius=99 phải bị bỏ NGUYÊN subtree, drop
//   shadow trên Surface, frame auto-layout itemSpacing 8 + padding 16 x4.
// - Component B ("Reuse Card"): dùng lại fill #0052FF (fill thứ 3) + thêm
//   stroke #FF3B30 — stroke phải rơi vào CÙNG nhóm colors với fill.
const HEX_0052FF = { r: 0, g: 82 / 255, b: 1, a: 1 };
const HEX_FF3B30 = { r: 1, g: 59 / 255, b: 48 / 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

function fixture(): MineTokensInput[] {
  const componentA = {
    name: 'Primary Button',
    node: {
      id: '1:1',
      type: 'COMPONENT',
      visible: true,
      fills: [{ type: 'SOLID', visible: true, color: HEX_0052FF }],
      children: [
        {
          id: '1:1:1',
          name: 'Surface',
          type: 'RECTANGLE',
          visible: true,
          fills: [
            { type: 'SOLID', visible: true, color: HEX_0052FF },
            { type: 'SOLID', visible: false, color: BLACK },
          ],
          cornerRadius: 12,
          effects: [
            { type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 2 }, radius: 4, spread: 0 },
          ],
        },
        {
          id: '1:1:2',
          name: 'ZeroRadius',
          type: 'RECTANGLE',
          visible: true,
          cornerRadius: 0,
        },
        {
          id: '1:1:3',
          name: 'Label',
          type: 'TEXT',
          visible: true,
          style: { fontFamily: 'Inter', fontWeight: 600, fontSize: 16, lineHeightPx: 24, lineHeightUnit: 'PIXELS' },
        },
        {
          id: '1:1:4',
          name: 'Layout',
          type: 'FRAME',
          visible: true,
          layoutMode: 'HORIZONTAL',
          itemSpacing: 8,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 16,
          paddingBottom: 16,
          children: [],
        },
        {
          id: '1:1:5',
          name: 'HiddenNode',
          type: 'RECTANGLE',
          visible: false,
          cornerRadius: 99,
          fills: [{ type: 'SOLID', visible: true, color: BLACK }],
        },
      ],
    },
  };

  const componentB = {
    name: 'Reuse Card',
    node: {
      id: '2:1',
      type: 'COMPONENT',
      visible: true,
      fills: [{ type: 'SOLID', visible: true, color: HEX_0052FF }],
      strokes: [{ type: 'SOLID', visible: true, color: HEX_FF3B30 }],
    },
  };

  return [componentA, componentB];
}

describe('figma-tokens: mineDesignTokens (thuần, tất định)', () => {
  it('gộp fill+stroke vào colors theo tần suất, bỏ visible=false và cornerRadius=0', () => {
    const profile = mineDesignTokens(fixture());

    expect(profile.colors).toEqual([
      { hex: '#0052FF', count: 3, examples: ['Primary Button', 'Reuse Card'] },
      { hex: '#FF3B30', count: 1, examples: ['Reuse Card'] },
    ]);
    expect(profile.colors.some((c) => c.hex.toUpperCase().includes('000000'))).toBe(false);

    expect(profile.typography).toEqual([
      { fontFamily: 'Inter', fontWeight: 600, fontSize: 16, lineHeight: '24px', count: 1, examples: ['Primary Button'] },
    ]);

    expect(profile.radii).toEqual([{ value: 12, count: 1, examples: ['Primary Button'] }]);
    expect(profile.radii.some((r) => r.value === 0)).toBe(false);
    expect(profile.radii.some((r) => r.value === 99)).toBe(false);

    expect(profile.shadows).toHaveLength(1);
    expect(profile.shadows[0]).toMatchObject({ kind: 'DROP_SHADOW', offsetX: 0, offsetY: 2, radius: 4, spread: 0, count: 1 });

    const spacingValues = profile.spacing.map((s) => s.value).sort((a, b) => a - b);
    expect(spacingValues).toEqual([8, 16]);
    const spacing16 = profile.spacing.find((s) => s.value === 16);
    expect(spacing16?.count).toBe(4);
    const spacing8 = profile.spacing.find((s) => s.value === 8);
    expect(spacing8?.count).toBe(1);
  });

  it('là hàm tất định: gọi 2 lần cùng input → deep-equal', () => {
    const a = mineDesignTokens(fixture());
    const b = mineDesignTokens(fixture());
    expect(a).toEqual(b);
  });
});

describe('figma-tokens: renderTokensMd', () => {
  it('có tiêu đề nhóm, dòng #0052FF đứng trước #FF3B30 (tần suất), có câu de-facto', () => {
    const profile = mineDesignTokens(fixture());
    const md = renderTokensMd(profile, { generatedAt: '2026-08-22T00:00:00.000Z', componentCount: 2 });

    expect(md).toContain('de-facto');
    expect(md).toContain('## Màu sắc (colors)');
    expect(md).toContain('## Chữ (typography)');
    expect(md).toContain('## Bo góc (radius)');
    expect(md).toContain('## Đổ bóng (shadow)');
    expect(md).toContain('## Khoảng cách (spacing)');

    const idx0052 = md.indexOf('#0052FF');
    const idxFF3B = md.indexOf('#FF3B30');
    expect(idx0052).toBeGreaterThan(-1);
    expect(idxFF3B).toBeGreaterThan(-1);
    expect(idx0052).toBeLessThan(idxFF3B);
  });

  it('giới hạn 40 dòng đầu mỗi nhóm + dòng tổng còn lại', () => {
    const many: MineTokensInput[] = [];
    for (let i = 0; i < 50; i += 1) {
      many.push({
        name: `Comp ${i}`,
        node: { id: String(i), type: 'RECTANGLE', visible: true, cornerRadius: i + 1 },
      });
    }
    const profile = mineDesignTokens(many);
    expect(profile.radii).toHaveLength(50);
    const md = renderTokensMd(profile, { generatedAt: '2026-08-22T00:00:00.000Z', componentCount: 50 });
    expect(md).toContain('… và 10 giá trị ít dùng khác.');
  });
});

describe('figma-tokens: renderTokensDtcg', () => {
  it('tên ổn định theo giá trị, $type đúng nhóm, có $extensions.od.frequency', () => {
    const profile = mineDesignTokens(fixture());
    const dtcg = renderTokensDtcg(profile);

    expect(dtcg.color['c-0052ff']).toMatchObject({ $type: 'color', $value: '#0052FF', $extensions: { 'od.frequency': 3 } });
    expect(dtcg.color['c-ff3b30']).toMatchObject({ $type: 'color', $value: '#FF3B30', $extensions: { 'od.frequency': 1 } });
    expect(dtcg.typography['t-inter-600-16']).toMatchObject({ $type: 'typography' });
    expect(dtcg.radius['r-12']).toMatchObject({ $type: 'dimension', $value: '12px' });
    expect(Object.keys(dtcg.shadow)).toHaveLength(1);
    expect(Object.keys(dtcg.shadow)[0]).toMatch(/^sh-[0-9a-f]{8}$/);
    expect(dtcg.spacing['sp-8']).toMatchObject({ $type: 'dimension', $value: '8px' });
    expect(dtcg.spacing['sp-16']).toMatchObject({ $type: 'dimension', $value: '16px' });
  });

  it('gọi 2 lần cùng input → deep-equal (tất định)', () => {
    const profile = mineDesignTokens(fixture());
    const first = renderTokensDtcg(profile);
    const second = renderTokensDtcg(mineDesignTokens(fixture()));
    expect(first).toEqual(second);
  });
});

describe('figma-tokens: route-level (refresh → mining best-effort, GET, criteria)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    closeDatabase();
    vi.clearAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setup() {
    const build = vi.fn(async (): Promise<FigmaComponentCatalogSnapshot> => ({
      schemaVersion: FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION,
      generatedAt: '2026-08-22T00:00:00.000Z',
      files: [{
        fileKey: 'ABC',
        name: 'Core UI',
        url: 'https://www.figma.com/design/ABC',
        components: [
          { nodeId: '1:1', name: 'Primary Button', properties: [] },
          { nodeId: '2:1', name: 'Reuse Card', properties: [] },
        ],
      }],
    }));
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-tokens-'));
    roots.push(root);
    const db = openDatabase(root, { dataDir: root });
    const handlers = new Map<string, Handler>();
    const app = {
      get(route: string, handler: Handler) { handlers.set(`GET ${route}`, handler); },
      post(route: string, handler: Handler) { handlers.set(`POST ${route}`, handler); },
      patch(route: string, handler: Handler) { handlers.set(`PATCH ${route}`, handler); },
      delete(route: string, handler: Handler) { handlers.set(`DELETE ${route}`, handler); },
    };
    registerFigmaDesignSystemRoutes(app as never, {
      db,
      http: { isLocalSameOrigin: () => true, resolvedPortRef: { current: 7456 } },
      paths: { RUNTIME_DATA_DIR: root },
      buildCatalog: build as never,
      now: () => Date.parse('2026-08-22T00:00:00.000Z'),
    } as never);
    await writeFigmaConfig(root, { token: 'machine-local-secret' });
    const created = response();
    await handlers.get('POST /api/figma-design-systems')!({ body: { name: 'Kit', links: ['https://figma.com/design/ABC'] } }, created.res);
    const id = created.output.body.source.id;
    return { root, id, handlers };
  }

  async function waitForFile(target: string): Promise<void> {
    // Task mining là fire-and-forget nền — trên máy đang tải nặng 2s có khi
    // chưa đủ (flake hiếm quan sát được khi chạy kèm battery khác), chờ hào
    // phóng tới 10s; đường xanh bình thường vẫn thoát ngay khi file xuất hiện.
    for (let i = 0; i < 500 && !fs.existsSync(target); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('refresh thành công → tokens.md + tokens.json được ghi best-effort; GET tokens trả markdown', async () => {
    vi.mocked(fetchNodeSubtrees).mockImplementation(async (_token: string, _fileKey: string, nodeIds: readonly string[]) => {
      const map = new Map<string, unknown>();
      for (const nodeId of nodeIds) {
        map.set(nodeId, {
          id: nodeId,
          type: 'COMPONENT',
          visible: true,
          fills: [{ type: 'SOLID', visible: true, color: { r: 0, g: 82 / 255, b: 1, a: 1 } }],
        });
      }
      return map;
    });
    const { root, id, handlers } = await setup();

    const refreshed = response();
    await handlers.get('POST /api/figma-design-systems/:id/refresh')!({ params: { id } }, refreshed.res);
    expect(refreshed.output.status).toBe(200);

    const mdPath = figmaDesignSystemTokensMdPath(root, id);
    const jsonPath = figmaDesignSystemTokensJsonPath(root, id);
    await waitForFile(mdPath);
    expect(fs.existsSync(mdPath)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(true);
    const markdown = await readFile(mdPath, 'utf8');
    expect(markdown).toContain('de-facto');
    expect(markdown).toContain('#0052FF');
    const dtcg = JSON.parse(await readFile(jsonPath, 'utf8'));
    expect(dtcg.color['c-0052ff']).toMatchObject({ $type: 'color', $value: '#0052FF' });

    const got = response();
    await handlers.get('GET /api/figma-design-systems/:id/tokens')!({ params: { id } }, got.res);
    expect(got.output.status).toBe(200);
    expect(got.output.body.markdown).toBe(markdown);
    expect(typeof got.output.body.generatedAt).toBe('string');

    // WP-slots: fixture không có node SLOT nào → profiles rỗng → slots.md
    // KHÔNG được ghi (cùng lý do empty-guard của tokens.md — xem
    // `mineAndWriteFigmaDesignSystemTokens`).
    expect(fs.existsSync(figmaDesignSystemSlotsMdPath(root, id))).toBe(false);
  });

  it('component có node SLOT → slots.md được ghi CẠNH tokens.md (best-effort, cùng task mining)', async () => {
    vi.mocked(fetchNodeSubtrees).mockImplementation(async (_token: string, _fileKey: string, nodeIds: readonly string[]) => {
      const map = new Map<string, unknown>();
      for (const nodeId of nodeIds) {
        map.set(nodeId, {
          id: nodeId,
          type: 'COMPONENT',
          visible: true,
          fills: [{ type: 'SOLID', visible: true, color: { r: 0, g: 82 / 255, b: 1, a: 1 } }],
          children: [
            {
              id: `${nodeId}:slot`,
              name: 'Content',
              type: 'SLOT',
              visible: true,
              children: [{ id: `${nodeId}:slot:1`, name: 'Title', type: 'TEXT', characters: 'Title' }],
            },
          ],
        });
      }
      return map;
    });
    const { root, id, handlers } = await setup();

    const refreshed = response();
    await handlers.get('POST /api/figma-design-systems/:id/refresh')!({ params: { id } }, refreshed.res);
    expect(refreshed.output.status).toBe(200);

    const tokensMdPath = figmaDesignSystemTokensMdPath(root, id);
    const slotsMdPath = figmaDesignSystemSlotsMdPath(root, id);
    await waitForFile(slotsMdPath);
    expect(fs.existsSync(tokensMdPath)).toBe(true);
    expect(fs.existsSync(slotsMdPath)).toBe(true);
    const slotsMarkdown = await readFile(slotsMdPath, 'utf8');
    expect(slotsMarkdown).toContain('SLOT');
    expect(slotsMarkdown).toContain('Content');
    expect(slotsMarkdown).toContain('Primary Button');

    // Tab Slots (DS detail): GET /slots trả đúng markdown vừa ghi.
    const got = response();
    await handlers.get('GET /api/figma-design-systems/:id/slots')!({ params: { id } }, got.res);
    expect(got.output.status).toBe(200);
    expect(got.output.body.markdown).toBe(slotsMarkdown);
    expect(typeof got.output.body.generatedAt).toBe('string');
  });

  it('mining throw → refresh vẫn 200; GET tokens trả 404 TOKENS_NOT_GENERATED', async () => {
    vi.mocked(fetchNodeSubtrees).mockRejectedValue(new Error('Figma REST lỗi'));
    const { id, handlers } = await setup();

    const refreshed = response();
    await handlers.get('POST /api/figma-design-systems/:id/refresh')!({ params: { id } }, refreshed.res);
    expect(refreshed.output.status).toBe(200);

    // Nhường vòng lặp sự kiện cho task mining (fire-and-forget) reject xong
    // trước khi khẳng định GET vẫn 404 — không có gì để chờ (không file nào
    // được ghi), nhưng vẫn cần một nhịp cho promise reject nội bộ chạy xong.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const got = response();
    await handlers.get('GET /api/figma-design-systems/:id/tokens')!({ params: { id } }, got.res);
    expect(got.output.status).toBe(404);
    expect(got.output.body.error.code).toBe('TOKENS_NOT_GENERATED');

    const gotSlots = response();
    await handlers.get('GET /api/figma-design-systems/:id/slots')!({ params: { id } }, gotSlots.res);
    expect(gotSlots.output.status).toBe(404);
    expect(gotSlots.output.body.error.code).toBe('SLOTS_NOT_GENERATED');
  });

  it('GET tokens 404 khi nguồn không tồn tại', async () => {
    const { handlers } = await setup();
    const got = response();
    await handlers.get('GET /api/figma-design-systems/:id/tokens')!({ params: { id: 'khong-ton-tai' } }, got.res);
    expect(got.output.status).toBe(404);
  });
});

describe('figma-tokens: writeTokensMarkdownToCriteria (giao criteria đúng khuôn WP20b)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('copy nguyên văn tokens.md vào criteriaDir khi nguồn có', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-tokens-criteria-'));
    roots.push(root);
    const criteriaDir = path.join(root, 'criteria');
    const result = await writeTokensMarkdownToCriteria(criteriaDir, '# Token de-facto\n\nnội dung');
    expect(result).toEqual({ delivered: true });
    expect(await readFile(path.join(criteriaDir, 'tokens.md'), 'utf8')).toBe('# Token de-facto\n\nnội dung');
  });

  it('nguồn chưa có tokens.md → không ghi, không lỗi (xoá bản cũ nếu có)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-tokens-criteria-'));
    roots.push(root);
    const criteriaDir = path.join(root, 'criteria');
    await writeTokensMarkdownToCriteria(criteriaDir, '# Bản cũ');
    const result = await writeTokensMarkdownToCriteria(criteriaDir, null);
    expect(result).toEqual({ delivered: false });
    await expect(readFile(path.join(criteriaDir, 'tokens.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
