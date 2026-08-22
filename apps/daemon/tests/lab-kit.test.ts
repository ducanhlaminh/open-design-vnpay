// ds-lab / lab-kit (WP-kit, 2026-08-22) red-spec: pure glue in lab-kit.ts
// (parse/brief/paths) + pickPinterestMcpServer (figma-build.ts). See
// `.tmp/pipeline/wp-kit.yaml`.
//
// WP-kit-plan (2026-08-22 — .tmp/pipeline/wp-kit-plan.yaml): + parseKitPlan/
// buildKitPlanBrief/renderKitPlanMd (stage "Đề xuất kit", cổng duyệt của
// NGƯỜI trước lab-kit) và buildKitBrief đổi vai (DỰNG ĐÚNG danh sách plan,
// không còn tự phân tích chọn lọc).

import { describe, expect, it } from 'vitest';

import {
  buildKitBrief,
  buildKitPlanBrief,
  kitShotPngRel,
  labKitPageName,
  parseKitPlan,
  parseKitResult,
  renderKitPlanMd,
  KIT_PLAN_FILE_REL,
  KIT_PLAN_MD_REL,
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
// WP-kit-plan (2026-08-22): buildKitBrief no longer analyzes anything itself
// — it lists the ALREADY-APPROVED `plan` (decision==='derive' entries from
// kit-plan.json, filtered by the caller) and tells the agent to build EXACTLY
// that list.

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
    plan: [
      { key: 'card-choose-number', name: 'Card - Chọn số', decision: 'derive' as const, gap: 'base Card thiếu media + badge chồng góc + price-tag' },
      { key: 'app-bar', name: 'App Bar', decision: 'derive' as const, gap: 'DS chưa có App Bar', mustHave: true },
    ],
  };

  it('names the kit page, states the SYSTEM DESIGNER role, and cites the "lab-kit-compose" skill', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('lab-kit-compose');
    expect(brief).toContain('SYSTEM DESIGNER');
    expect(brief).toContain(labKitPageName('Ví điện tử'));
    expect(brief).toContain(baseOpts.previewFileKey);
  });

  it('lists the approved plan entries by name + gap, and says "DỰNG ĐÚNG danh sách"', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('DỰNG ĐÚNG danh sách');
    expect(brief).toContain('kit-plan.json');
    expect(brief).toContain('Card - Chọn số');
    expect(brief).toContain('base Card thiếu media + badge chồng góc + price-tag');
    expect(brief).toContain('App Bar');
  });

  it('no longer contains the retired selective-analysis / mandatory-App-Bar-exception wording', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).not.toContain('PHÂN TÍCH CHỌN LỌC');
    expect(brief).not.toContain('NGOẠI LỆ BẮT BUỘC');
  });

  it('still states GEN LẠI TỪ ĐẦU, AUTO-LAYOUT/resize-358, and "KHÔNG merge" — unchanged rules', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('GEN LẠI TỪ ĐẦU');
    expect(brief).toContain('AUTO-LAYOUT');
    expect(brief).toContain('358');
    expect(brief).toContain('KHÔNG merge');
  });

  it('forbids writing to the source DS file — kit lives ONLY in the preview file', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('TUYỆT ĐỐI KHÔNG ghi bất kỳ thứ gì vào file Design System NGUỒN');
    expect(brief).toContain('PROMOTE');
  });

  it('states the regen-from-scratch rule (wipe the kit page unconditionally — no in-place update, orphan is intentional)', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('GEN LẠI TỪ ĐẦU');
    expect(brief).toContain('XÓA TOÀN BỘ children');
    expect(brief).toContain('mainComponent');
  });

  it('states the one-notch gradient/alpha token rule — same wording as buildComposeBrief\'s rule (4)', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('Luật token nới MỘT NẤC');
    expect(brief).toContain('GRADIENT_LINEAR');
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

  it('ends by requiring kit-result.json + kit/kit.json written whole, not merged with the old one', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain(KIT_RESULT_FILE_REL);
    expect(brief).toContain(KIT_REGISTRY_FILE_REL);
    expect(brief).toContain('MỚI TOÀN BỘ');
    expect(brief).toContain('KHÔNG merge');
  });

  // WP-lab-quality (.tmp/pipeline/wp-lab-quality.yaml): bằng chứng thật — kit
  // comp rộng tự nhiên ~445pt đặt vào instance 358pt bị cắt cụt mép phải.
  it('states the auto-layout + resize-test-358 rule with the 445pt evidence', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('AUTO-LAYOUT');
    expect(brief).toContain('resize');
    expect(brief).toContain('358');
    expect(brief).toContain('445');
  });

  it('ends with the "skill already in system prompt, do not search local catalog" note', () => {
    const brief = buildKitBrief(baseOpts);
    expect(brief).toContain('system prompt');
    expect(brief).toContain('lab-kit-compose');
    expect(brief).toContain('ĐỪNG đi tìm file skill');
  });
});

// ── parseKitPlan ─────────────────────────────────────────────────────────────

describe('parseKitPlan', () => {
  it('parses a valid plan (derive + use-base entries)', () => {
    const parsed = parseKitPlan(
      JSON.stringify({
        candidates: [
          {
            key: 'card-choose-number',
            name: 'Card - Chọn số',
            decision: 'derive',
            baseComponents: ['datarow', 'ProviderMini'],
            gap: 'base Card không có chỗ cho media + badge chồng góc + price-tag',
            reason: 'điểm neo thị giác chính của màn danh sách gói',
          },
          { key: 'radio', name: 'Radio', decision: 'use-base' },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.candidates).toEqual([
      {
        key: 'card-choose-number',
        name: 'Card - Chọn số',
        decision: 'derive',
        baseComponents: ['datarow', 'ProviderMini'],
        gap: 'base Card không có chỗ cho media + badge chồng góc + price-tag',
        reason: 'điểm neo thị giác chính của màn danh sách gói',
      },
      { key: 'radio', name: 'Radio', decision: 'use-base' },
    ]);
    expect(parsed!.warnings).toEqual([]);
  });

  it('drops a "derive" entry missing "gap" (hard contract of the two-tier test), keeps the rest', () => {
    const parsed = parseKitPlan(
      JSON.stringify({
        candidates: [
          { key: 'a', name: 'A', decision: 'derive' },
          { key: 'b', name: 'B', decision: 'derive', gap: '' },
          { key: 'c', name: 'C', decision: 'use-base' },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.candidates.map((c) => c.key)).toEqual(['c']);
    expect(parsed!.warnings.length).toBe(2);
    expect(parsed!.warnings.join(' ')).toMatch(/"a"/);
    expect(parsed!.warnings.join(' ')).toMatch(/gap/);
  });

  it('drops an entry with an invalid "decision" value', () => {
    const parsed = parseKitPlan(JSON.stringify({ candidates: [{ key: 'a', name: 'A', decision: 'maybe' }] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.candidates).toEqual([]);
    expect(parsed!.warnings.length).toBe(1);
    expect(parsed!.warnings[0]).toMatch(/decision/);
  });

  it('drops an entry missing key or name, with a warning', () => {
    const parsed = parseKitPlan(
      JSON.stringify({
        candidates: [{ name: 'A', decision: 'use-base' }, { key: 'b', decision: 'use-base' }],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.candidates).toEqual([]);
    expect(parsed!.warnings.length).toBe(2);
  });

  it('returns null on malformed JSON', () => {
    expect(parseKitPlan('{not json')).toBeNull();
  });

  it('returns null when "candidates" is missing or not an array', () => {
    expect(parseKitPlan(JSON.stringify({}))).toBeNull();
    expect(parseKitPlan(JSON.stringify({ candidates: 'nope' }))).toBeNull();
  });

  it('an empty candidates array is NOT null — caller decides whether empty is a failure', () => {
    expect(parseKitPlan(JSON.stringify({ candidates: [] }))).toEqual({ candidates: [], warnings: [] });
  });

  it('preserves mustHave: true (the mandatory App Bar exception)', () => {
    const parsed = parseKitPlan(
      JSON.stringify({
        candidates: [{ key: 'app-bar', name: 'App Bar', decision: 'derive', gap: 'DS thiếu App Bar', mustHave: true }],
      }),
    );
    expect(parsed!.candidates[0]?.mustHave).toBe(true);
  });
});

// ── buildKitPlanBrief ────────────────────────────────────────────────────────

describe('buildKitPlanBrief', () => {
  const baseOpts = {
    docsIndex: ['_index.md'],
    scopeHint: null as string | null,
    appFeature: 'Ví điện tử',
    hasTokens: true,
    hasGuide: true,
    hasSlots: true,
  };

  it('states the SYSTEM DESIGNER analysis-only role and cites the "lab-kit-plan" skill', () => {
    const brief = buildKitPlanBrief(baseOpts);
    expect(brief).toContain('lab-kit-plan');
    expect(brief).toContain('SYSTEM DESIGNER');
  });

  it('states there is NO Figma tool in this session', () => {
    const brief = buildKitPlanBrief(baseOpts);
    expect(brief).toContain('KHÔNG có tool Figma');
  });

  it('states the two-tier test with the "default is no generation" burden-of-proof rule', () => {
    const brief = buildKitPlanBrief(baseOpts);
    expect(brief).toContain('HAI TẦNG');
    expect(brief).toContain('MẶC ĐỊNH LÀ KHÔNG SINH');
  });

  it('states the mandatory App Bar exception with mustHave: true', () => {
    const brief = buildKitPlanBrief(baseOpts);
    expect(brief).toContain('App Bar');
    expect(brief).toContain('mustHave');
  });

  it('ends with the kit-plan.json + kit-plan.md two-file contract', () => {
    const brief = buildKitPlanBrief(baseOpts);
    expect(brief).toContain(KIT_PLAN_FILE_REL);
    expect(brief).toContain(KIT_PLAN_MD_REL);
  });

  it('ends with the "skill already in system prompt, do not search local catalog" note', () => {
    const brief = buildKitPlanBrief(baseOpts);
    expect(brief).toContain('system prompt');
    expect(brief).toContain('lab-kit-plan');
    expect(brief).toContain('ĐỪNG đi tìm file skill');
  });

  it('mentions the user-supplied scopeHint when present', () => {
    const brief = buildKitPlanBrief({ ...baseOpts, scopeHint: 'Ưu tiên các màn thanh toán' });
    expect(brief).toContain('Ưu tiên các màn thanh toán');
  });
});

// ── renderKitPlanMd ──────────────────────────────────────────────────────────

describe('renderKitPlanMd', () => {
  it('renders a markdown table with comp | decision | gap | reason', () => {
    const md = renderKitPlanMd([
      { key: 'card', name: 'Card - Chọn số', decision: 'derive', gap: 'thiếu price-tag', reason: 'điểm neo' },
      { key: 'radio', name: 'Radio', decision: 'use-base' },
    ]);
    expect(md).toContain('Card - Chọn số');
    expect(md).toContain('thiếu price-tag');
    expect(md).toContain('Radio');
    expect(md).toContain('use-base');
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

  // Hotfix 0.8.101 — bài học thật 0.8.100: form "custom server" của Settings
  // lưu id CỐ ĐỊNH là 'custom' (danh tính chỉ lộ ở label/command/args), user
  // thêm Pinterest ra entry {id: 'custom', label: 'Pinterest'} và picker dò
  // theo id đã bỏ sót → moodboard không chạy.
  it('matches identity in label, command, or args (custom-form entry: id is always "custom")', () => {
    expect(
      pickPinterestMcpServer([{ id: 'custom', enabled: true, label: 'Pinterest' }]),
    ).toMatchObject({ id: 'custom' });
    expect(
      pickPinterestMcpServer([{ id: 'custom', enabled: true, command: '/usr/local/bin/pinterest-mcp' }]),
    ).toMatchObject({ id: 'custom' });
    expect(
      pickPinterestMcpServer([
        { id: 'custom', enabled: true, label: 'Ảnh tham khảo', args: ['/opt/pinterest-mcp-server/dist/index.js'] },
      ]),
    ).toMatchObject({ id: 'custom' });
    expect(
      pickPinterestMcpServer([{ id: 'custom', enabled: true, label: 'Confluence', command: '/usr/bin/node' }]),
    ).toBeNull();
  });
});

// Sanity: the exported path constants match what the docblocks/brief claim.
describe('path constants', () => {
  it('match the module\'s own docblock claims', () => {
    expect(KIT_SHOTS_DIR_REL).toBe('kit-shots');
    expect(KIT_RESULT_FILE_REL).toBe('kit-result.json');
    expect(KIT_REGISTRY_FILE_REL).toBe('kit/kit.json');
    expect(KIT_PLAN_FILE_REL).toBe('kit-plan.json');
    expect(KIT_PLAN_MD_REL).toBe('kit-plan.md');
  });
});
