// ds-lab / lab-kit (WP-kit, 2026-08-22) red-spec: pure glue in lab-kit.ts
// (parse/brief/paths) + pickPinterestMcpServer (figma-build.ts). See
// `.tmp/pipeline/wp-kit.yaml`.

import { describe, expect, it } from 'vitest';

import {
  buildKitBrief,
  kitShotPngRel,
  labKitPageName,
  parseKitResult,
  KIT_REGISTRY_FILE_REL,
  KIT_RESULT_FILE_REL,
  KIT_SHOTS_DIR_REL,
} from '../src/lab-kit.js';
import { pickPinterestMcpServer } from '../src/figma-build.js';

// ── labKitPageName ───────────────────────────────────────────────────────────

describe('labKitPageName', () => {
  it('names the page "[OD Lab Kit] <app feature>" — distinct from lab-compose\'s "[OD Lab] …"', () => {
    expect(labKitPageName('Ví điện tử')).toBe('[OD Lab Kit] Ví điện tử');
  });
});

// ── parseKitResult ───────────────────────────────────────────────────────────

describe('parseKitResult', () => {
  it('parses a valid result', () => {
    const parsed = parseKitResult(
      JSON.stringify({
        components: [
          {
            key: 'card-choose-number',
            name: 'Card - Chọn số',
            componentNodeId: '773:22161',
            reason: 'điểm neo thị giác chính của màn danh sách gói',
            baseComponents: ['datarow', 'ProviderMini'],
            notes: 'ghi chú',
          },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.components).toEqual([
      {
        key: 'card-choose-number',
        name: 'Card - Chọn số',
        componentNodeId: '773:22161',
        reason: 'điểm neo thị giác chính của màn danh sách gói',
        baseComponents: ['datarow', 'ProviderMini'],
        notes: 'ghi chú',
      },
    ]);
    expect(parsed!.warnings).toEqual([]);
  });

  it('drops an entry missing componentNodeId, with a warning — keeps the rest', () => {
    const parsed = parseKitResult(
      JSON.stringify({
        components: [
          { key: 'a', name: 'A' },
          { key: 'b', name: 'B', componentNodeId: '1:2' },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.components.map((c) => c.key)).toEqual(['b']);
    expect(parsed!.warnings.length).toBe(1);
    expect(parsed!.warnings[0]).toMatch(/"a"/);
    expect(parsed!.warnings[0]).toMatch(/componentNodeId/);
  });

  it('drops an instance-inner id ("I<a>;<b>") — stale outside the agent session', () => {
    const parsed = parseKitResult(
      JSON.stringify({ components: [{ key: 'a', name: 'A', componentNodeId: 'I12:34;56:78' }] }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.components).toEqual([]);
    expect(parsed!.warnings.length).toBe(1);
    expect(parsed!.warnings[0]).toMatch(/"a"/);
  });

  it('drops an entry missing key, with a warning', () => {
    const parsed = parseKitResult(JSON.stringify({ components: [{ componentNodeId: '1:2' }] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.components).toEqual([]);
    expect(parsed!.warnings.length).toBe(1);
  });

  it('falls back name to key when name is absent/blank (same tolerance as parseLabResult)', () => {
    const parsed = parseKitResult(JSON.stringify({ components: [{ key: 'card-x', componentNodeId: '5:6' }] }));
    expect(parsed!.components[0]).toEqual({ key: 'card-x', name: 'card-x', componentNodeId: '5:6' });
  });

  it('returns null on malformed JSON', () => {
    expect(parseKitResult('{not json')).toBeNull();
  });

  it('returns null when "components" is missing or not an array', () => {
    expect(parseKitResult(JSON.stringify({}))).toBeNull();
    expect(parseKitResult(JSON.stringify({ components: 'nope' }))).toBeNull();
  });

  it('an empty components array is NOT null — caller decides whether empty is a failure', () => {
    const parsed = parseKitResult(JSON.stringify({ components: [] }));
    expect(parsed).toEqual({ components: [], warnings: [] });
  });
});

// ── kitShotPngRel ────────────────────────────────────────────────────────────

describe('kitShotPngRel', () => {
  it('builds the kit-shots/<key>.png path for a plain key', () => {
    expect(kitShotPngRel('card-choose-number')).toBe('kit-shots/card-choose-number.png');
  });

  it('sanitizes characters outside [A-Za-z0-9._-] (same charset as screenPngRel)', () => {
    expect(kitShotPngRel('Card - Chọn số')).toBe(`${KIT_SHOTS_DIR_REL}/Card_-_Ch_n_s_.png`);
  });
});

// ── buildKitBrief ────────────────────────────────────────────────────────────

describe('buildKitBrief', () => {
  const baseOpts = {
    docsIndex: ['_index.md'],
    scopeHint: null as string | null,
    previewFileKey: 'FILE123',
    appFeature: 'Ví điện tử',
    hasTokens: true,
    hasGuide: true,
    hasSlots: true,
    hasPinterest: false,
    kitNames: [] as string[],
  };

  it('names the kit page, states the SYSTEM DESIGNER role, and cites the "lab-kit-compose" skill', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('lab-kit-compose');
    expect(brief).toContain('SYSTEM DESIGNER');
    expect(brief).toContain(labKitPageName('Ví điện tử'));
    expect(brief).toContain(baseOpts.previewFileKey);
  });

  it('states the selective-analysis criterion (visual anchor comps only, plumbing stays base)', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('PHÂN TÍCH CHỌN LỌC');
    expect(brief).toContain('ĐIỂM NEO THỊ GIÁC');
    expect(brief).toContain('ống nước');
  });

  it('forbids writing to the source DS file — kit lives ONLY in the preview file', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('TUYỆT ĐỐI KHÔNG ghi bất kỳ thứ gì vào file Design System NGUỒN');
    expect(brief).toContain('PROMOTE');
  });

  it('states the component-shaped idempotent rule (update in place, never delete-recreate — orphan instances)', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('IDEMPOTENT KIỂU COMPONENT');
    expect(brief).toContain('GIỮ NGUYÊN node component đó');
    expect(brief).toContain('orphan');
  });

  it('states the one-notch gradient/alpha token rule — same wording as buildComposeBrief\'s rule (4)', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('Luật token nới MỘT NẤC');
    expect(brief).toContain('GRADIENT_LINEAR');
  });

  it('kitNames non-empty → tells the agent to update the existing kit in place instead of duplicating', () => {
    const brief = buildKitBrief({ ...baseOpts, kitNames: ['Card - Chọn số', 'ProviderMini'] });
    expect(brief).toContain('Card - Chọn số');
    expect(brief).toContain('ProviderMini');
    expect(brief).toContain('CẬP NHẬT');
  });

  it('kitNames empty → says there is no prior kit yet', () => {
    const brief = buildKitBrief({ ...baseOpts, kitNames: [] });
    expect(brief).toContain('Chưa có kit nào từ lần trước');
  });

  it('hasPinterest=true → mentions pinterest_* moodboard/placeholder recipe; false → silent', () => {
    const withPinterest = buildKitBrief({ ...baseOpts, hasPinterest: true });
    expect(withPinterest).toContain('pinterest_');
    expect(withPinterest).toContain('PLACEHOLDER');

    const withoutPinterest = buildKitBrief({ ...baseOpts, hasPinterest: false });
    expect(withoutPinterest).not.toContain('pinterest');
  });

  it('mentions "criteria/slots.md" when hasSlots=true, and omits it when false', () => {
    const withSlots = buildKitBrief({ ...baseOpts, hasSlots: true });
    expect(withSlots).toContain('criteria/slots.md');

    const withoutSlots = buildKitBrief({ ...baseOpts, hasSlots: false });
    expect(withoutSlots).not.toContain('criteria/slots.md');
  });

  it('notes the absence of tokens.md/components-guide.md instead of pretending they exist', () => {
    const brief = buildKitBrief({ ...baseOpts, hasTokens: false, hasGuide: false });
    expect(brief).toContain('CHƯA có cho dự án này');
  });

  it('ends by requiring kit-result.json + kit/kit.json', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain(KIT_RESULT_FILE_REL);
    expect(brief).toContain(KIT_REGISTRY_FILE_REL);
  });
});

// ── pickPinterestMcpServer ───────────────────────────────────────────────────

describe('pickPinterestMcpServer', () => {
  it('picks the first ENABLED server whose templateId is pinterest', () => {
    const servers = [
      { id: 'other', enabled: true },
      { id: 'my-pinterest', enabled: true, templateId: 'pinterest' },
    ];
    expect(pickPinterestMcpServer(servers)).toMatchObject({ id: 'my-pinterest' });
  });

  it('falls back to id/url matching /pinterest/i when no templateId match', () => {
    expect(pickPinterestMcpServer([{ id: 'pinterest-mcp-server', enabled: true }])).toMatchObject({
      id: 'pinterest-mcp-server',
    });
    expect(
      pickPinterestMcpServer([{ id: 'srv', enabled: true, url: 'https://pinterest.example.com/mcp' }]),
    ).toMatchObject({ id: 'srv' });
  });

  it('ignores a disabled server, returns null when none match', () => {
    expect(pickPinterestMcpServer([{ id: 'pinterest', enabled: false }])).toBeNull();
    expect(pickPinterestMcpServer([{ id: 'unrelated', enabled: true }])).toBeNull();
    expect(pickPinterestMcpServer([])).toBeNull();
  });
});

// Sanity: the exported path constants match what the docblocks/brief claim.
describe('path constants', () => {
  it('match the module\'s own docblock claims', () => {
    expect(KIT_SHOTS_DIR_REL).toBe('kit-shots');
    expect(KIT_RESULT_FILE_REL).toBe('kit-result.json');
    expect(KIT_REGISTRY_FILE_REL).toBe('kit/kit.json');
  });
});
