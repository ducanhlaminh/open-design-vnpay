// ds-lab "Bản đồ màn" (lab-map, WP-lab-map — .tmp/pipeline/wp-lab-map.yaml)
// red-spec: pure module (parseScreenMap/renderScreenMapMd/
// pickDocsReviewMapSources/summarizeScreenMapForCompose/buildMapBrief).
// Registry assertions (5-stage workflow, def shape) live in
// pipelines.test.ts / lab-compose.test.ts to keep this file focused on
// lab-map.ts's own pure behavior.
//
// WP-lab-shell (2026-08-23 — .tmp/pipeline/wp-lab-shell.yaml): + shell
// parsing (screen-map.json's `shell` field), deriveShellDefaults/
// resolveScreenShell/fillShellDefaults, and the "Khung" column in
// renderScreenMapMd/summarizeScreenMapForCompose's `shells`.

import { describe, expect, it } from 'vitest';

import {
  buildMapBrief,
  deriveShellDefaults,
  fillShellDefaults,
  parseScreenMap,
  pickDocsReviewMapSources,
  renderScreenMapMd,
  resolveScreenShell,
  summarizeScreenMapForCompose,
  MAP_SRC_DIR_REL,
  SCREEN_MAP_FILE_REL,
  SCREEN_MAP_MD_REL,
} from '../src/lab-map.js';

// ── path constants ───────────────────────────────────────────────────────────

describe('path constants', () => {
  it('match the docblock/registry claims', () => {
    expect(SCREEN_MAP_FILE_REL).toBe('screen-map.json');
    expect(SCREEN_MAP_MD_REL).toBe('screen-map.md');
    expect(MAP_SRC_DIR_REL).toBe('map-src');
  });
});

// ── parseScreenMap ───────────────────────────────────────────────────────────

describe('parseScreenMap', () => {
  it('parses a valid map (flows + screens, mustHave, nav, states, source, dsHints)', () => {
    const parsed = parseScreenMap(
      JSON.stringify({
        schema_version: 1,
        generatedFrom: 'docs-review',
        flows: [
          {
            id: 'F1',
            title: 'Luồng A',
            basis: 'proposed',
            mainPath: ['S1', 'S2'],
            branches: [{ from: 'S1', to: 'S2', label: 'nhánh' }],
          },
        ],
        screens: [
          {
            key: 'S1',
            name: 'Màn 1',
            purpose: 'Mục đích',
            flowId: 'F1',
            mustHave: [{ role: 'app-bar', label: 'Tiêu đề', content: { text: 'x' }, note: 'ghi chú' }],
            states: ['có dữ liệu', 'rỗng'],
            nav: [{ el: 'cta', to: 'S2', label: 'Tiếp tục' }],
            source: { doc: 'docs/a.md', line: 12 },
            dsHints: ['Button'],
          },
          { key: 'S2', name: 'Màn 2', mustHave: [] },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.warnings).toEqual([]);
    expect(parsed!.map.generatedFrom).toBe('docs-review');
    expect(parsed!.map.flows).toEqual([
      {
        id: 'F1',
        mainPath: ['S1', 'S2'],
        title: 'Luồng A',
        basis: 'proposed',
        branches: [{ from: 'S1', to: 'S2', label: 'nhánh' }],
      },
    ]);
    expect(parsed!.map.screens[0]).toEqual({
      key: 'S1',
      name: 'Màn 1',
      purpose: 'Mục đích',
      flowId: 'F1',
      mustHave: [{ role: 'app-bar', label: 'Tiêu đề', content: { text: 'x' }, note: 'ghi chú' }],
      states: ['có dữ liệu', 'rỗng'],
      nav: [{ el: 'cta', to: 'S2', label: 'Tiếp tục' }],
      source: { doc: 'docs/a.md', line: 12 },
      dsHints: ['Button'],
    });
    expect(parsed!.map.screens[1]).toEqual({ key: 'S2', name: 'Màn 2', mustHave: [] });
  });

  it('returns null on malformed JSON', () => {
    expect(parseScreenMap('{not json')).toBeNull();
  });

  it('returns null when not an object, or "screens" missing/not an array', () => {
    expect(parseScreenMap(JSON.stringify([]))).toBeNull();
    expect(parseScreenMap(JSON.stringify({}))).toBeNull();
    expect(parseScreenMap(JSON.stringify({ screens: 'nope' }))).toBeNull();
  });

  it('an empty screens array is NOT null — caller decides whether empty is a failure', () => {
    const parsed = parseScreenMap(JSON.stringify({ screens: [] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.map.screens).toEqual([]);
  });

  it('drops a screen missing "key" or "name", with a warning — keeps the rest', () => {
    const parsed = parseScreenMap(
      JSON.stringify({
        screens: [{ name: 'Thiếu key' }, { key: 'S1' }, { key: 'S2', name: 'OK' }],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.map.screens.map((s) => s.key)).toEqual(['S2']);
    expect(parsed!.warnings.length).toBe(2);
  });

  it('dedupes a repeated "key" — keeps the FIRST occurrence, warns on the rest', () => {
    const parsed = parseScreenMap(
      JSON.stringify({
        screens: [
          { key: 'S1', name: 'Bản đầu' },
          { key: 'S1', name: 'Bản trùng' },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.map.screens).toEqual([{ key: 'S1', name: 'Bản đầu', mustHave: [] }]);
    expect(parsed!.warnings.length).toBe(1);
    expect(parsed!.warnings[0]).toMatch(/trùng key/);
  });

  it('missing "mustHave" defaults to []; an item missing "role" is dropped with a warning, not the whole screen', () => {
    const parsed = parseScreenMap(
      JSON.stringify({
        screens: [
          { key: 'S1', name: 'A' },
          { key: 'S2', name: 'B', mustHave: [{ label: 'Thiếu role' }, { role: 'app-bar' }] },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.map.screens[0]!.mustHave).toEqual([]);
    expect(parsed!.map.screens[1]!.mustHave).toEqual([{ role: 'app-bar' }]);
    expect(parsed!.warnings.length).toBe(1);
    expect(parsed!.warnings[0]).toMatch(/"S2"/);
    expect(parsed!.warnings[0]).toMatch(/role/);
  });

  it('missing "flows" defaults to []; a flow missing "id" is dropped with a warning', () => {
    const parsed = parseScreenMap(
      JSON.stringify({ screens: [{ key: 'S1', name: 'A' }], flows: [{ mainPath: ['S1'] }] }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.map.flows).toEqual([]);
    expect(parsed!.warnings.length).toBe(1);

    const noFlows = parseScreenMap(JSON.stringify({ screens: [{ key: 'S1', name: 'A' }] }));
    expect(noFlows!.map.flows).toEqual([]);
  });

  it('mainPath referencing a key NOT present in screens is KEPT, with a warning', () => {
    const parsed = parseScreenMap(
      JSON.stringify({
        screens: [{ key: 'S1', name: 'A' }],
        flows: [{ id: 'F1', mainPath: ['S1', 'S-missing'] }],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.map.flows[0]!.mainPath).toEqual(['S1', 'S-missing']);
    expect(parsed!.warnings.some((w) => w.includes('S-missing'))).toBe(true);
  });

  it('unknown/missing "generatedFrom" falls back to "docs"', () => {
    expect(parseScreenMap(JSON.stringify({ screens: [] }))!.map.generatedFrom).toBe('docs');
    expect(parseScreenMap(JSON.stringify({ screens: [], generatedFrom: 'bogus' }))!.map.generatedFrom).toBe('docs');
    expect(parseScreenMap(JSON.stringify({ screens: [], generatedFrom: 'mixed' }))!.map.generatedFrom).toBe('mixed');
  });

  // ── WP-lab-shell: shell parsing ──────────────────────────────────────────

  it('parses a valid "shell" (kind + must/should/avoid + note) and marks source "agent"', () => {
    const parsed = parseScreenMap(
      JSON.stringify({
        screens: [
          {
            key: 'S1',
            name: 'Màn 1',
            shell: { kind: 'child', must: ['app-bar', 'back'], should: [], avoid: ['tabbar'], note: 'ghi chú' },
          },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.warnings).toEqual([]);
    expect(parsed!.map.screens[0]!.shell).toEqual({
      kind: 'child',
      must: ['app-bar', 'back'],
      should: [],
      avoid: ['tabbar'],
      note: 'ghi chú',
      source: 'agent',
    });
  });

  it('an invalid "shell.kind" drops the whole shell, with a warning', () => {
    const parsed = parseScreenMap(
      JSON.stringify({ screens: [{ key: 'S1', name: 'A', shell: { kind: 'bogus', must: ['app-bar'] } }] }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.map.screens[0]!.shell).toBeUndefined();
    expect(parsed!.warnings.some((w) => w.includes('shell.kind'))).toBe(true);
  });

  it('an invalid role value inside must/should/avoid is filtered out, with a warning — valid roles are kept', () => {
    const parsed = parseScreenMap(
      JSON.stringify({
        screens: [
          { key: 'S1', name: 'A', shell: { kind: 'root', must: ['tabbar', 'bogus-role'], should: ['  SEARCH  '] } },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.map.screens[0]!.shell).toMatchObject({ kind: 'root', must: ['tabbar'], should: ['search'] });
    expect(parsed!.warnings.some((w) => w.includes('shell.must'))).toBe(true);
  });
});

// ── renderScreenMapMd ─────────────────────────────────────────────────────────

describe('renderScreenMapMd', () => {
  it('renders the "# Bản đồ màn" heading, one flow block (title + basis + mainPath), and a screen table (with the "Khung" column)', () => {
    const md = renderScreenMapMd({
      schema_version: 1,
      generatedFrom: 'docs-review',
      flows: [{ id: 'F1', title: 'Luồng A', basis: 'proposed', mainPath: ['S1', 'S2'] }],
      screens: [
        {
          key: 'S1',
          name: 'Màn 1',
          purpose: 'Mục đích',
          mustHave: [{ role: 'app-bar', label: 'Tiêu đề' }],
          states: ['rỗng'],
          nav: [{ to: 'S2' }],
          shell: { kind: 'child', must: ['app-bar', 'back'], should: [], avoid: ['tabbar'], source: 'agent' },
        },
        { key: 'S2', name: 'Màn 2', mustHave: [] },
      ],
    });
    expect(md).toMatch(/^# Bản đồ màn/);
    expect(md).toContain('F1 — Luồng A (proposed)');
    expect(md).toContain('Luồng chính: S1 → S2');
    expect(md).toContain('| Key | Tên | Mục đích | Phải có | Khung | Trạng thái | Đi tới |');
    expect(md).toContain('| S1 | Màn 1 | Mục đích | app-bar: Tiêu đề | child · phải: app-bar, back · tránh: tabbar | rỗng | S2 |');
    expect(md).toContain('Nguồn: docs-review');
  });

  it('a screen without an explicit "shell" still gets a "Khung" cell, resolved via derive', () => {
    const md = renderScreenMapMd({
      schema_version: 1,
      generatedFrom: 'docs',
      flows: [{ id: 'F1', mainPath: ['S1'] }],
      screens: [{ key: 'S1', name: 'Trang chủ', mustHave: [] }],
    });
    const row = md.split('\n').find((l) => l.startsWith('| S1 '));
    expect(row).toContain('root · phải: tabbar · nên: search · tránh: back');
  });

  it('caps mustHave display at 8 entries, then appends "+N"', () => {
    const mustHave = Array.from({ length: 10 }, (_, i) => ({ role: `role-${i}` }));
    const md = renderScreenMapMd({
      schema_version: 1,
      generatedFrom: 'docs',
      flows: [],
      screens: [{ key: 'S1', name: 'A', mustHave }],
    });
    const row = md.split('\n').find((l) => l.startsWith('| S1 '));
    expect(row).toBeDefined();
    expect(row).toContain('+2');
    expect(row!.match(/role-/g)?.length).toBe(8);
  });

  it('renders branches as bullet lines under the flow block', () => {
    const md = renderScreenMapMd({
      schema_version: 1,
      generatedFrom: 'docs',
      flows: [{ id: 'F1', mainPath: ['S1'], branches: [{ from: 'S1', to: 'S-err', label: 'lỗi' }] }],
      screens: [{ key: 'S1', name: 'A', mustHave: [] }],
    });
    expect(md).toContain('- Nhánh: S1 → S-err (lỗi)');
  });
});

// ── pickDocsReviewMapSources ─────────────────────────────────────────────────

describe('pickDocsReviewMapSources', () => {
  const allPaths = [
    'flows/FLOW-1.flowchart.json',
    'flows/FLOW-1/ux-review.json',
    'flows/FLOW-1/screens.json',
    'flows/FLOW-1/as-is.mmd',
    'flows/FLOW-1/proposed.mmd',
    'flows/index.json',
    'comp/_screens.json',
    'comp/_role-map.json',
    'comp/_inputs.json',
    'comp/index.json',
    'comp/summary.md',
    'comp/doc__6.2.1.screen.json',
    'comp/figma-build/x.json',
    'wireframes/doc__6.2.1.html',
    'review/docs/x.md',
    'docs/x.md',
    'docs-feature/x.md',
    'context-lock.json',
    'criteria/components.md',
  ];

  it('keeps exactly the allow-listed shapes, excludes wireframes/review/docs*/figma-build and dr-comp internals', () => {
    expect(pickDocsReviewMapSources(allPaths)).toEqual([
      'comp/_screens.json',
      'comp/doc__6.2.1.screen.json',
      'flows/FLOW-1.flowchart.json',
      'flows/FLOW-1/screens.json',
      'flows/FLOW-1/ux-review.json',
      'flows/index.json',
    ]);
  });

  it('returns a stably-sorted array regardless of input order', () => {
    const shuffled = [...allPaths].reverse();
    expect(pickDocsReviewMapSources(shuffled)).toEqual(pickDocsReviewMapSources(allPaths));
  });

  it('returns [] on an empty or irrelevant input', () => {
    expect(pickDocsReviewMapSources([])).toEqual([]);
    expect(pickDocsReviewMapSources(['docs/x.md', 'review/y.md'])).toEqual([]);
  });
});

// ── summarizeScreenMapForCompose ─────────────────────────────────────────────

describe('summarizeScreenMapForCompose', () => {
  const map = {
    schema_version: 1 as const,
    generatedFrom: 'docs-review' as const,
    flows: [{ id: 'F1', mainPath: ['doc__6.1.1', 'doc__6.2.1', 'doc__6.2.3', 'doc__6.4.1'] }],
    screens: [
      { key: 'doc__6.1.1', name: 'Trang chủ', mustHave: [{ role: 'app-bar' }] },
      { key: 'doc__6.2.1', name: 'Chọn QG', mustHave: [{ role: 'search-input' }, { role: 'listing' }] },
      { key: 'doc__6.2.3', name: 'Chi tiết gói', mustHave: [] },
      { key: 'doc__6.4.1', name: 'Nhập tin', mustHave: [] },
    ],
  };

  it('summarizes screens (key/name/mustHaveCount) and the first flow\'s mainPath', () => {
    const s = summarizeScreenMapForCompose(map, null);
    expect(s.screens).toEqual([
      { key: 'doc__6.1.1', name: 'Trang chủ', mustHaveCount: 1 },
      { key: 'doc__6.2.1', name: 'Chọn QG', mustHaveCount: 2 },
      { key: 'doc__6.2.3', name: 'Chi tiết gói', mustHaveCount: 0 },
      { key: 'doc__6.4.1', name: 'Nhập tin', mustHaveCount: 0 },
    ]);
    expect(s.mainPath).toEqual(['doc__6.1.1', 'doc__6.2.1', 'doc__6.2.3', 'doc__6.4.1']);
  });

  it('scopeHint matching a LITERAL key selects that key', () => {
    const s = summarizeScreenMapForCompose(map, 'chỉ dựng doc__6.2.1 thôi');
    expect(s.scoped).toEqual(['doc__6.2.1']);
  });

  it('scopeHint matching a "code" suffix (after "__") selects the matching key', () => {
    const s = summarizeScreenMapForCompose(map, 'ưu tiên màn 6.2.3 nhé');
    expect(s.scoped).toEqual(['doc__6.2.3']);
  });

  it('scopeHint matching multiple keys selects them in the order they appear in map.screens', () => {
    const s = summarizeScreenMapForCompose(map, 'ưu tiên 6.4.1 và 6.1.1');
    expect(s.scoped).toEqual(['doc__6.1.1', 'doc__6.4.1']);
  });

  it('no scopeHint match (or absent/blank) falls back to the first 3 keys of mainPath', () => {
    expect(summarizeScreenMapForCompose(map, null).scoped).toEqual(['doc__6.1.1', 'doc__6.2.1', 'doc__6.2.3']);
    expect(summarizeScreenMapForCompose(map, undefined).scoped).toEqual(['doc__6.1.1', 'doc__6.2.1', 'doc__6.2.3']);
    expect(summarizeScreenMapForCompose(map, '   ').scoped).toEqual(['doc__6.1.1', 'doc__6.2.1', 'doc__6.2.3']);
    expect(summarizeScreenMapForCompose(map, 'không khớp gì cả').scoped).toEqual([
      'doc__6.1.1',
      'doc__6.2.1',
      'doc__6.2.3',
    ]);
  });

  it('no mainPath (or no flows) falls back to the first 3 of map.screens', () => {
    const noFlows = { ...map, flows: [] };
    expect(summarizeScreenMapForCompose(noFlows, null).scoped).toEqual(['doc__6.1.1', 'doc__6.2.1', 'doc__6.2.3']);
    expect(summarizeScreenMapForCompose(noFlows, null).mainPath).toEqual([]);
  });

  // ── WP-lab-shell: `shells` for the scoped keys ────────────────────────────

  it('resolves `shells` (derived, since no screen has an explicit shell) for exactly the scoped keys, in scoped order', () => {
    const s = summarizeScreenMapForCompose(map, null);
    expect(s.scoped).toEqual(['doc__6.1.1', 'doc__6.2.1', 'doc__6.2.3']);
    expect(s.shells.map((sh) => sh.key)).toEqual(['doc__6.1.1', 'doc__6.2.1', 'doc__6.2.3']);
    // doc__6.1.1 is mainPath[0] and referenced by nothing else → root.
    expect(s.shells[0]).toEqual({ key: 'doc__6.1.1', kind: 'root', must: ['tabbar'], should: ['search'], avoid: ['back'] });
    // doc__6.2.1/doc__6.2.3 are referenced later in mainPath → child.
    expect(s.shells[1]).toEqual({ key: 'doc__6.2.1', kind: 'child', must: ['app-bar', 'back'], should: [], avoid: ['tabbar'] });
  });

  it('an explicit screen.shell wins over the derived default in `shells`', () => {
    const withShell = {
      ...map,
      screens: map.screens.map((s) =>
        s.key === 'doc__6.1.1'
          ? { ...s, shell: { kind: 'fullscreen' as const, must: ['close' as const], should: [], avoid: ['tabbar' as const], source: 'agent' as const } }
          : s,
      ),
    };
    const s = summarizeScreenMapForCompose(withShell, null);
    expect(s.shells[0]).toMatchObject({ key: 'doc__6.1.1', kind: 'fullscreen', must: ['close'] });
  });
});

// ── deriveShellDefaults / resolveScreenShell / fillShellDefaults ────────────

describe('deriveShellDefaults', () => {
  it('mainPath[0] (not referenced elsewhere) derives to "root"', () => {
    const map = {
      schema_version: 1 as const,
      generatedFrom: 'docs' as const,
      flows: [{ id: 'F1', mainPath: ['S1', 'S2'] }],
      screens: [
        { key: 'S1', name: 'Trang chủ', mustHave: [] },
        { key: 'S2', name: 'Chi tiết', mustHave: [] },
      ],
    };
    const derived = deriveShellDefaults(map);
    expect(derived.get('S1')).toMatchObject({ kind: 'root' });
  });

  it('a screen referenced by nav[].to, mainPath[i>0], or branches[].to derives to "child"', () => {
    const byNav = deriveShellDefaults({
      schema_version: 1,
      generatedFrom: 'docs',
      flows: [],
      screens: [
        { key: 'S1', name: 'A', mustHave: [], nav: [{ to: 'S2' }] },
        { key: 'S2', name: 'B', mustHave: [] },
      ],
    });
    expect(byNav.get('S2')).toMatchObject({ kind: 'child' });

    const byBranch = deriveShellDefaults({
      schema_version: 1,
      generatedFrom: 'docs',
      flows: [{ id: 'F1', mainPath: ['S1'], branches: [{ from: 'S1', to: 'S-err' }] }],
      screens: [
        { key: 'S1', name: 'A', mustHave: [] },
        { key: 'S-err', name: 'Lỗi', mustHave: [] },
      ],
    });
    expect(byBranch.get('S-err')).toMatchObject({ kind: 'child' });
  });

  it('a screen name matching "Bottom sheet ..." derives to "sheet" regardless of graph position', () => {
    const map = {
      schema_version: 1 as const,
      generatedFrom: 'docs' as const,
      flows: [],
      screens: [{ key: 'S1', name: 'Bottom sheet chọn gói', mustHave: [] }],
    };
    expect(deriveShellDefaults(map).get('S1')).toMatchObject({ kind: 'sheet' });
  });

  it('a screen name matching "Kết quả ..." derives to "result"', () => {
    const map = {
      schema_version: 1 as const,
      generatedFrom: 'docs' as const,
      flows: [],
      screens: [{ key: 'S1', name: 'Kết quả thanh toán', mustHave: [] }],
    };
    expect(deriveShellDefaults(map).get('S1')).toMatchObject({ kind: 'result' });
  });

  it('the derived shell copies SHELL_RULES arrays (mutating one does not affect the rule table)', () => {
    const map = {
      schema_version: 1 as const,
      generatedFrom: 'docs' as const,
      flows: [],
      screens: [{ key: 'S1', name: 'Trang chủ', mustHave: [] }],
    };
    const shell = deriveShellDefaults(map).get('S1')!;
    shell.must.push('close');
    expect(deriveShellDefaults(map).get('S1')!.must).toEqual(['tabbar']);
  });
});

describe('resolveScreenShell', () => {
  it('prefers screen.shell over the derived map', () => {
    const derived = new Map([['S1', { kind: 'root' as const, must: ['tabbar' as const], should: [], avoid: [], source: 'derived' as const }]]);
    const screen = { key: 'S1', name: 'A', mustHave: [], shell: { kind: 'modal' as const, must: ['close' as const], should: [], avoid: [], source: 'agent' as const } };
    expect(resolveScreenShell(screen, derived)).toEqual(screen.shell);
  });

  it('falls back to the derived map, then to a "child" default when neither is present', () => {
    const derived = new Map([['S1', { kind: 'sheet' as const, must: [], should: ['close' as const], avoid: [], source: 'derived' as const }]]);
    expect(resolveScreenShell({ key: 'S1', name: 'A', mustHave: [] }, derived)).toMatchObject({ kind: 'sheet' });
    expect(resolveScreenShell({ key: 'S-missing', name: 'B', mustHave: [] }, derived)).toMatchObject({
      kind: 'child',
      must: ['app-bar', 'back'],
    });
  });
});

describe('fillShellDefaults', () => {
  it('fills only screens missing a shell, and reports exactly those keys in `filled`', () => {
    const map = {
      schema_version: 1 as const,
      generatedFrom: 'docs' as const,
      flows: [],
      screens: [
        { key: 'S1', name: 'Trang chủ', mustHave: [] },
        {
          key: 'S2',
          name: 'Chi tiết',
          mustHave: [],
          shell: { kind: 'modal' as const, must: ['close' as const], should: [], avoid: [], source: 'agent' as const },
        },
      ],
    };
    const { map: filledMap, filled } = fillShellDefaults(map);
    expect(filled).toEqual(['S1']);
    expect(filledMap.screens[0]!.shell).toMatchObject({ kind: 'root', source: 'derived' });
    expect(filledMap.screens[1]!.shell).toEqual(map.screens[1]!.shell);
  });
});

// ── buildMapBrief ────────────────────────────────────────────────────────────

const REQUIRED_MAP_HEADINGS = [
  '## Đầu vào lần này',
  '## Việc cần làm',
  '## Nhắc luật hay vi phạm nhất (chi tiết trong skill)',
  '## Kết thúc — ghi đúng file',
];

function allCapsWordsMap(text: string): string[] {
  const matches = text.match(/(?<![\p{L}0-9_`])[A-ZÀ-Ỹ]{4,}(?![\p{L}0-9_`])/gu) ?? [];
  return matches.filter((w) => w !== 'JSON');
}

describe('buildMapBrief', () => {
  const minOpts = {
    docsIndex: [] as string[],
    scopeHint: null as string | null,
    appFeature: 'X',
    mapSrc: { flowcharts: [] as string[], uxReviews: [] as string[], screensIndex: false, screenJsonCount: 0 },
  };

  const baseOpts = {
    docsIndex: ['_index.md'],
    scopeHint: null as string | null,
    appFeature: 'Ví điện tử',
    mapSrc: {
      flowcharts: ['FLOW-1', 'FLOW-2'],
      uxReviews: ['flows/FLOW-1/ux-review.json'],
      screensIndex: true,
      screenJsonCount: 4,
    },
  };

  it('phần TĨNH (dữ liệu rỗng/tối thiểu) đúng khuôn: ≥5 heading, ≥10 dòng, ≤1400 ký tự, ≤6 từ VIẾT HOA', () => {
    const brief = buildMapBrief(minOpts);
    const headingLines = brief.match(/^#{1,2} .+$/gm) ?? [];
    expect(headingLines.length).toBeGreaterThanOrEqual(5);
    for (const h of REQUIRED_MAP_HEADINGS) expect(brief).toContain(h);
    expect(brief.split('\n').length).toBeGreaterThanOrEqual(10);
    expect(brief.length).toBeLessThanOrEqual(1400);
    expect(allCapsWordsMap(brief).length).toBeLessThanOrEqual(6);
  });

  it('no map-src data at all → says "không có docs-review — tự phân tích từ docs"', () => {
    const brief = buildMapBrief(minOpts);
    expect(brief).toContain('không có docs-review — tự phân tích từ docs');
  });

  it('reminds the agent to fill "shell" per screen, and that daemon derives a default when left blank', () => {
    const brief = buildMapBrief(minOpts);
    expect(brief).toContain('shell (kind + must/should/avoid)');
    expect(brief).toContain('bỏ trống thì daemon tự suy');
  });

  it('map-src present → states the exact flowchart/ux-review/screen.json counts + _screens.json checkmark', () => {
    const brief = buildMapBrief(baseOpts);
    expect(brief).toContain('map-src/');
    expect(brief).toContain('flowchart ×2');
    expect(brief).toContain('FLOW-1');
    expect(brief).toContain('FLOW-2');
    expect(brief).toContain('ux-review ×1');
    expect(brief).toContain('_screens.json ✓');
    expect(brief).toContain('screen.json ×4');
  });

  it('_screens.json absent → checkmark renders ✗', () => {
    const brief = buildMapBrief({ ...baseOpts, mapSrc: { ...baseOpts.mapSrc, screensIndex: false } });
    expect(brief).toContain('_screens.json ✗');
  });

  it('states "không có trong phiên này" for Figma — read-only session', () => {
    const brief = buildMapBrief(baseOpts);
    expect(brief).toContain('Figma: không có trong phiên này');
  });

  it('scopeHint present/absent renders correctly in "Định hướng người dùng"', () => {
    const withHint = buildMapBrief({ ...baseOpts, scopeHint: 'Ưu tiên luồng thanh toán' });
    expect(withHint).toContain('Ưu tiên luồng thanh toán');
    const withoutHint = buildMapBrief({ ...baseOpts, scopeHint: null });
    expect(withoutHint).toContain('Định hướng người dùng: (không có)');
  });

  it('ends with the screen-map.json + screen-map.md two-file contract, cites the "lab-map" skill', () => {
    const brief = buildMapBrief(baseOpts);
    expect(brief).toContain(SCREEN_MAP_FILE_REL);
    expect(brief).toContain(SCREEN_MAP_MD_REL);
    expect(brief).toContain('lab-map');
  });

  it('reminds "CÁI GÌ, không LÀM THẾ NÀO" and stable-key priority', () => {
    const brief = buildMapBrief(baseOpts);
    expect(brief).toContain('CÁI GÌ');
    expect(brief).toContain('LÀM THẾ NÀO');
    expect(brief).toContain('Key nguyên văn docs-review');
  });
});
