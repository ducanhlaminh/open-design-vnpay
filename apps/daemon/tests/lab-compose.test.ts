// ds-lab (WP-lab) red-spec: registry ('ds-lab' workflow, 'lab-docs' +
// 'lab-compose' pipelines) + lab-compose.ts's pure glue (brief builder, lab-
// result parser, output paths, preview-file fallback) + attribution
// (screens/ vs patterns/). See `.tmp/pipeline/wp-lab.yaml`.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, test } from 'vitest';

import {
  buildComposeBrief,
  labPageName,
  parseLabResult,
  resolveLabPreviewConfig,
  screenPngRel,
  LAB_PATTERNS_DIR_REL,
  LAB_RESULT_FILE_REL,
} from '../src/lab-compose.js';
import { writeFigmaPreviewConfig } from '../src/figma-build.js';
import {
  PIPELINE_DEFS,
  WORKFLOWS,
  getPipelineDef,
  getWorkflow,
  relClearedByRegen,
  stagesForOutput,
  workflowDirForPipeline,
} from '../src/pipelines.js';

function def(id: string) {
  const d = getPipelineDef(id);
  assert.ok(d, `pipeline ${id} should exist in the registry`);
  return d;
}

// ── Registry: ds-lab workflow ────────────────────────────────────────────────

// WP-kit-plan (.tmp/pipeline/wp-kit-plan.yaml, 2026-08-22): ds-lab grew a 4th
// stage, the approval gate "Đề xuất kit" (lab-kit-plan), between lab-docs and
// lab-kit — see pipelines.test.ts's dedicated ds-lab tests for the full
// lab-kit-plan assertions; this test only needs its own pipelineIds/dependsOn
// expectations updated to not regress.
test('ds-lab: 4-stage workflow (WP-kit-plan added lab-kit-plan before lab-kit), independent of docs-to-ui/docs-to-prd/docs-review', () => {
  const wf = getWorkflow('ds-lab');
  assert.ok(wf, 'ds-lab workflow should exist');
  assert.deepEqual(wf!.pipelineIds, ['lab-docs', 'lab-kit-plan', 'lab-kit', 'lab-compose']);
  assert.equal(def('lab-docs').skillId, 'confluence-ingest');
  assert.equal(def('lab-kit').skillId, 'lab-kit-compose');
  assert.equal(def('lab-compose').skillId, 'lab-screen-compose');
  assert.deepEqual(def('lab-docs').dependsOn, []);
  assert.deepEqual(def('lab-kit').dependsOn, ['lab-docs', 'lab-kit-plan']);
  assert.deepEqual(def('lab-compose').dependsOn, ['lab-docs']);
  assert.deepEqual(def('lab-docs').outputs, ['docs/', 'docs-feature/']);
  // WP-kit-regen (.tmp/pipeline/wp-kit-regen.yaml, 2026-08-22): kit/kit.json is
  // now a declared output of lab-kit (Chạy lại = gen lại từ đầu) — unlike
  // lab-compose's patterns/ below, which stays agent-owned/survives re-run.
  assert.deepEqual(def('lab-kit').outputs, ['kit-shots/', 'kit-result.json', 'kit/kit.json']);
  assert.deepEqual(def('lab-compose').outputs, ['screens/', 'lab-result.json']);
  assert.equal(def('lab-docs').acceptsUpload, true);
  // patterns/ (lab-compose) is deliberately NOT a declared output of any
  // stage — see the attribution test below. kit/kit.json no longer gets the
  // same treatment (see the lab-kit.test.ts / pipelines.test.ts red specs).
  for (const d of PIPELINE_DEFS) {
    for (const pattern of d.outputs ?? []) {
      assert.notEqual(pattern, 'patterns/', `${d.id}.outputs must not declare patterns/`);
      assert.notEqual(pattern, 'kit/', `${d.id}.outputs must not declare kit/ as a whole-directory pattern`);
    }
  }
  // Docs-to-ui stays the default workflow — appending ds-lab must not disturb it.
  assert.equal(WORKFLOWS[0]!.id, 'docs-to-ui');
});

test('ds-lab: pipeline ids resolve to their OWN workflow folder, never another workflow\'s', () => {
  assert.equal(workflowDirForPipeline('lab-docs'), 'ds-lab');
  assert.equal(workflowDirForPipeline('lab-kit-plan'), 'ds-lab');
  assert.equal(workflowDirForPipeline('lab-kit'), 'ds-lab');
  assert.equal(workflowDirForPipeline('lab-compose'), 'ds-lab');
  // Other workflows' own ids stay untouched.
  assert.equal(workflowDirForPipeline('docs'), 'docs-to-ui');
  assert.equal(workflowDirForPipeline('prd-docs'), 'docs-to-prd');
  assert.equal(workflowDirForPipeline('dr-docs'), 'docs-review');
});

// `dr-confirm` is a deliberate exception (see its comment in pipelines.ts): an
// internal deterministic action exposed as a completion CTA, never listed in
// any workflow's pipelineIds. Every OTHER registry id must be claimed by
// exactly one workflow — and no id may ever be claimed by more than one
// (the real risk `stagesForOutput`/`workflowDirForPipeline` guard against).
const NOT_A_WORKFLOW_STAGE = new Set(['dr-confirm']);

test('invariant: every PIPELINE_DEFS id belongs to EXACTLY one workflow (dr-confirm is the one documented exception)', () => {
  for (const d of PIPELINE_DEFS) {
    const owners = WORKFLOWS.filter((w) => w.pipelineIds.includes(d.id));
    if (NOT_A_WORKFLOW_STAGE.has(d.id)) {
      assert.equal(owners.length, 0, `${d.id} is documented as NOT belonging to any workflow`);
      continue;
    }
    assert.equal(owners.length, 1, `${d.id} should belong to exactly one workflow (found in: ${owners.map((w) => w.id).join(', ') || 'none'})`);
  }
});

// ── Attribution: screens/ vs patterns/ ──────────────────────────────────────

test('attribution: ds-lab/screens/x.png belongs to lab-compose; ds-lab/lab-result.json too', () => {
  assert.deepEqual(stagesForOutput('ds-lab/screens/SCR-001.png').map((d) => d.id), ['lab-compose']);
  assert.deepEqual(stagesForOutput('ds-lab/lab-result.json').map((d) => d.id), ['lab-compose']);
  assert.deepEqual(stagesForOutput('ds-lab/docs/confluence/x.md').map((d) => d.id), ['lab-docs']);
});

test('attribution: ds-lab/patterns/x.json belongs to NO stage — survives every re-run', () => {
  assert.deepEqual(stagesForOutput('ds-lab/patterns/card-list.json'), []);
  assert.equal(
    relClearedByRegen('ds-lab/patterns/card-list.json', new Set(['lab-compose', 'lab-docs']), 'ds-lab'),
    false,
  );
  // A re-run of lab-compose DOES clear its own declared outputs.
  assert.equal(
    relClearedByRegen('ds-lab/screens/SCR-001.png', new Set(['lab-compose']), 'ds-lab'),
    true,
  );
});

// ── parseLabResult ───────────────────────────────────────────────────────────

describe('parseLabResult', () => {
  it('parses a valid result', () => {
    const parsed = parseLabResult(
      JSON.stringify({
        screens: [
          { key: 'SCR-001', name: 'Đăng nhập', frameNodeId: '12:34', frameUrl: 'https://figma.com/x', notes: 'ok' },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.screens).toEqual([
      { key: 'SCR-001', name: 'Đăng nhập', frameNodeId: '12:34', frameUrl: 'https://figma.com/x', notes: 'ok' },
    ]);
    expect(parsed!.warnings).toEqual([]);
  });

  it('drops an entry missing frameNodeId, with a warning — keeps the rest', () => {
    const parsed = parseLabResult(
      JSON.stringify({
        screens: [
          { key: 'SCR-001', name: 'A' },
          { key: 'SCR-002', name: 'B', frameNodeId: '1:2' },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.screens.map((s) => s.key)).toEqual(['SCR-002']);
    expect(parsed!.warnings.length).toBe(1);
    expect(parsed!.warnings[0]).toMatch(/SCR-001/);
    expect(parsed!.warnings[0]).toMatch(/frameNodeId/);
  });

  it('drops an instance-inner id ("I<a>;<b>") — stale outside the agent session', () => {
    const parsed = parseLabResult(
      JSON.stringify({ screens: [{ key: 'SCR-001', name: 'A', frameNodeId: 'I12:34;56:78' }] }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.screens).toEqual([]);
    expect(parsed!.warnings.length).toBe(1);
    expect(parsed!.warnings[0]).toMatch(/SCR-001/);
  });

  it('drops an entry missing key, with a warning', () => {
    const parsed = parseLabResult(JSON.stringify({ screens: [{ frameNodeId: '1:2' }] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.screens).toEqual([]);
    expect(parsed!.warnings.length).toBe(1);
  });

  it('returns null on malformed JSON', () => {
    expect(parseLabResult('{not json')).toBeNull();
  });

  it('returns null when "screens" is missing or not an array', () => {
    expect(parseLabResult(JSON.stringify({}))).toBeNull();
    expect(parseLabResult(JSON.stringify({ screens: 'nope' }))).toBeNull();
  });

  it('an empty screens array is NOT null — caller decides whether empty is a failure', () => {
    const parsed = parseLabResult(JSON.stringify({ screens: [] }));
    expect(parsed).toEqual({ screens: [], warnings: [] });
  });

  it('falls back name to key when name is absent/blank', () => {
    const parsed = parseLabResult(JSON.stringify({ screens: [{ key: 'SCR-003', frameNodeId: '5:6' }] }));
    expect(parsed!.screens[0]).toEqual({ key: 'SCR-003', name: 'SCR-003', frameNodeId: '5:6' });
  });
});

// ── screenPngRel ─────────────────────────────────────────────────────────────

describe('screenPngRel', () => {
  it('builds the screens/<key>.png path for a plain key', () => {
    expect(screenPngRel('SCR-001')).toBe('screens/SCR-001.png');
  });

  it('sanitizes characters outside [A-Za-z0-9._-]', () => {
    expect(screenPngRel('SCR 001 / Đăng nhập')).toBe('screens/SCR_001_____ng_nh_p.png');
  });
});

// ── buildComposeBrief ────────────────────────────────────────────────────────
// WP-lab-clean (.tmp/pipeline/wp-lab-clean.yaml): khuôn mới "skill = luật (đã
// ở system prompt), brief = dữ liệu lần chạy" — cùng ràng buộc đo được với
// buildKitBrief/buildKitPlanBrief (xem describe tương ứng trong
// lab-kit.test.ts): ≥5 heading, ≥10 dòng, phần TĨNH ≤1700 ký tự (compose dài
// hơn plan/kit vì có thêm dòng kit/pattern/phạm vi), ≤6 từ VIẾT HOA (không
// tính JSON/tên file/ID), vắng mặt giai thoại bằng chứng cũ.

const REQUIRED_COMPOSE_HEADINGS = [
  '## Đầu vào lần này',
  '## Việc cần làm',
  '## Nhắc luật hay vi phạm nhất (chi tiết trong skill)',
  '## Kết thúc — ghi đúng file',
];

const BANNED_COMPOSE_PHRASES = [
  'lỗi thật đã gặp',
  '445',
  '398',
  'GRADIENT_LINEAR đã probe',
  'đừng đi tìm file skill',
  '5 luật sống còn',
];

function allCapsWordsCompose(text: string): string[] {
  const matches = text.match(/(?<![\p{L}0-9_`])[A-ZÀ-Ỹ]{4,}(?![\p{L}0-9_`])/gu) ?? [];
  return matches.filter((w) => w !== 'JSON');
}

describe('buildComposeBrief', () => {
  const minOpts = {
    docsIndex: [] as string[],
    previewFileKey: 'F',
    appFeature: 'X',
    hasTokens: false,
    hasGuide: false,
    hasSlots: false,
    patternNames: [] as string[],
    hasKit: false,
    kitNames: [] as string[],
    hasPinterest: false,
  };

  const baseOpts = {
    docsIndex: ['_index.md'],
    previewFileKey: 'FILE123',
    appFeature: 'Ví điện tử',
    hasTokens: true,
    hasGuide: true,
    hasSlots: true,
    patternNames: ['card-list'],
    hasKit: false,
    kitNames: [] as string[],
    hasPinterest: false,
  };

  it('phần TĨNH (dữ liệu rỗng/tối thiểu) đúng khuôn: ≥5 heading, ≥10 dòng, ≤1700 ký tự, ≤6 từ VIẾT HOA, vắng giai thoại cũ', () => {
    const brief = buildComposeBrief({ ...minOpts, scopeHint: null });
    const headingLines = brief.match(/^#{1,2} .+$/gm) ?? [];
    expect(headingLines.length).toBeGreaterThanOrEqual(5);
    for (const h of REQUIRED_COMPOSE_HEADINGS) expect(brief).toContain(h);
    expect(brief.split('\n').length).toBeGreaterThanOrEqual(10);
    expect(brief.length).toBeLessThanOrEqual(1700);
    expect(allCapsWordsCompose(brief).length).toBeLessThanOrEqual(6);
    for (const banned of BANNED_COMPOSE_PHRASES) expect(brief).not.toContain(banned);
  });

  it('states the page name and an explicit scope, and points to the hard-contract rules by number', () => {
    const brief = buildComposeBrief({ ...baseOpts, scopeHint: 'Chỉ màn Đăng nhập' });
    expect(brief).toContain(labPageName('Ví điện tử'));
    expect(brief).toContain('Chỉ màn Đăng nhập');
    expect(brief).toContain('luật #1/#3');
    expect(brief).toContain('luật #5');
    expect(brief).toContain('luật #6/#7');
    expect(brief).toContain('nguyên tử theo lần execute-code');
    expect(brief).toContain('không vẽ đè');
  });

  it('mentions "criteria/slots.md" ✓/✗ đúng chỗ trong dòng "Nguyên liệu"', () => {
    const withSlots = buildComposeBrief({ ...baseOpts, hasSlots: true, scopeHint: null });
    expect(withSlots).toContain('slots.md ✓');

    const withoutSlots = buildComposeBrief({ ...baseOpts, hasSlots: false, scopeHint: null });
    expect(withoutSlots).toContain('slots.md ✗');
  });

  it('falls back the scope hint to "tự chọn ≤3 màn" when absent/blank', () => {
    const brief = buildComposeBrief({ ...baseOpts, scopeHint: undefined });
    expect(brief).toContain('tự chọn ≤3 màn đầu luồng chính');
    const briefBlank = buildComposeBrief({ ...baseOpts, scopeHint: '   ' });
    expect(briefBlank).toContain('tự chọn ≤3 màn đầu luồng chính');
  });

  // Style pattern (`patterns/style-*.json`, luật #8 skill) tách khỏi pattern
  // ghép comp: brief phải nói rõ "ÁP LẠI" để agent không quay về mặc định
  // phẳng — bằng chứng: 3 vòng người dùng chỉnh "flat → 3 lớp + bottom-sheet +
  // listing nổi" rồi lần chạy sau lại bắt đầu từ phẳng.
  it('tách style pattern (style-*) khỏi pattern ghép comp và bảo ÁP LẠI', () => {
    const brief = buildComposeBrief({
      ...baseOpts,
      scopeHint: null,
      patternNames: ['card-list', 'style-bottom-sheet-3-layer'],
    });
    expect(brief).toMatch(/- Style pattern đã duyệt: style-bottom-sheet-3-layer — ÁP LẠI/);
    expect(brief).toMatch(/- Pattern sẵn có: card-list \(/);
    expect(brief).not.toMatch(/- Pattern sẵn có: .*style-bottom-sheet-3-layer/);
  });

  it('không có style pattern → bảo xác lập theo luật #8 rồi ghi patterns/style-<slug>.json', () => {
    const brief = buildComposeBrief({ ...baseOpts, scopeHint: null, patternNames: [] });
    expect(brief).toContain('Style pattern đã duyệt: (chưa có');
    expect(brief).toContain('patterns/style-<slug>.json');
  });

  it('ô nhập của stage gánh cả phạm vi lẫn định hướng thị giác — nhãn nói rõ điều đó', () => {
    const brief = buildComposeBrief({ ...baseOpts, scopeHint: 'Chỉ màn Đăng nhập · bottom-sheet, nền gradient brand' });
    expect(brief).toContain('- Phạm vi / định hướng thị giác: "Chỉ màn Đăng nhập · bottom-sheet, nền gradient brand"');
  });

  it('hasGuide/hasTokens ✓/✗ đúng chỗ trong dòng "Nguyên liệu"', () => {
    const brief = buildComposeBrief({ ...baseOpts, hasTokens: false, hasGuide: false, scopeHint: null });
    expect(brief).toContain('components-guide ✗');
    expect(brief).toContain('tokens.md ✗');
  });

  it('lists existing pattern names so the agent reads them before inventing new ones', () => {
    const brief = buildComposeBrief({ ...baseOpts, scopeHint: null, patternNames: ['card-list', 'empty-state'] });
    expect(brief).toContain('card-list');
    expect(brief).toContain('empty-state');
  });

  // ── WP-kit: ưu tiên kit khi có ─────────────────────────────────────────────

  it('hasKit=true → mentions the kit page name, kit.json path, kit names, and "ưu tiên"', () => {
    const brief = buildComposeBrief({
      ...baseOpts,
      scopeHint: null,
      hasKit: true,
      kitNames: ['Card - Chọn số', 'ProviderMini'],
    });
    expect(brief).toContain('kit/kit.json');
    expect(brief).toContain('Card - Chọn số');
    expect(brief).toContain('ProviderMini');
    expect(brief).toContain('ưu tiên');
    expect(brief).toContain('[OD Lab Kit] Ví điện tử');
  });

  it('hasKit=false → says nothing about the kit page/registry', () => {
    const brief = buildComposeBrief({ ...baseOpts, scopeHint: null, hasKit: false, kitNames: [] });
    expect(brief).not.toContain('kit/kit.json');
    expect(brief).not.toContain('[OD Lab Kit]');
  });

  // ── WP-kit: Pinterest fail-soft ──────────────────────────────────────────────

  it('hasPinterest ✓/✗ đúng chỗ trong dòng "Tool thêm"', () => {
    const withPinterest = buildComposeBrief({ ...baseOpts, scopeHint: null, hasPinterest: true });
    expect(withPinterest).toContain('Pinterest ✓');

    const withoutPinterest = buildComposeBrief({ ...baseOpts, scopeHint: null, hasPinterest: false });
    expect(withoutPinterest).toContain('Pinterest ✗');
  });

  it('ends with the lab-result.json + patterns/*.json two-file contract', () => {
    const brief = buildComposeBrief({ ...baseOpts, scopeHint: null });
    expect(brief).toContain(LAB_RESULT_FILE_REL);
    expect(brief).toContain(`${LAB_PATTERNS_DIR_REL}/*.json`);
  });

  it('cites the "lab-screen-compose" skill', () => {
    const brief = buildComposeBrief({ ...baseOpts, scopeHint: null });
    expect(brief).toContain('lab-screen-compose');
  });
});

// ── resolveLabPreviewConfig ──────────────────────────────────────────────────

describe('resolveLabPreviewConfig', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('reads the lab workflow\'s own .figma-preview.json first', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ds-lab-preview-'));
    const labCwd = path.join(root, 'ds-lab');
    const docsReviewCwd = path.join(root, 'docs-review');
    await mkdir(labCwd, { recursive: true });
    await mkdir(docsReviewCwd, { recursive: true });
    await writeFigmaPreviewConfig(labCwd, { fileKey: 'LAB_FILE', url: 'https://www.figma.com/design/LAB_FILE' });
    await writeFigmaPreviewConfig(docsReviewCwd, { fileKey: 'DR_FILE', url: 'https://www.figma.com/design/DR_FILE' });
    const config = await resolveLabPreviewConfig(labCwd, docsReviewCwd);
    expect(config?.fileKey).toBe('LAB_FILE');
  });

  it('falls back to docs-review\'s .figma-preview.json when the lab one is absent', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ds-lab-preview-'));
    const labCwd = path.join(root, 'ds-lab');
    const docsReviewCwd = path.join(root, 'docs-review');
    await mkdir(labCwd, { recursive: true });
    await mkdir(docsReviewCwd, { recursive: true });
    await writeFigmaPreviewConfig(docsReviewCwd, { fileKey: 'DR_FILE', url: 'https://www.figma.com/design/DR_FILE' });
    const config = await resolveLabPreviewConfig(labCwd, docsReviewCwd);
    expect(config?.fileKey).toBe('DR_FILE');
  });

  it('returns null when neither is configured', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ds-lab-preview-'));
    const labCwd = path.join(root, 'ds-lab');
    const docsReviewCwd = path.join(root, 'docs-review');
    const config = await resolveLabPreviewConfig(labCwd, docsReviewCwd);
    expect(config).toBeNull();
  });
});

// Sanity: the exported path constants line up with the registry's declared
// outputs and the module's own docblock claims.
test('path constants match the registry', () => {
  expect(LAB_RESULT_FILE_REL).toBe('lab-result.json');
  expect(def('lab-compose').outputs).toContain(LAB_RESULT_FILE_REL);
  expect(LAB_PATTERNS_DIR_REL).toBe('patterns');
});
