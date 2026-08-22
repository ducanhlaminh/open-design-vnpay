import { describe, expect, it } from 'vitest';

import {
  PREVIEW_STAGE_COUNT,
  resolvePreviewTargets,
} from '../../src/components/preview-targets';

function files(...names: string[]): { name: string }[] {
  return names.map((name) => ({ name }));
}

const EXPECTED_ORDER = [
  'docs-map',
  'cj',
  'ux-research',
  'ux',
  'ux-review',
  'ui-html',
  'ui-react',
  'ui-react-ds',
  'prd-review',
  'dr-review',
];

describe('resolvePreviewTargets', () => {
  it('strips the docs-to-ui/ workflow prefix and resolves the HTML prototype hero file', () => {
    const rows = resolvePreviewTargets(
      files('docs-to-ui/prototype/index.html', 'docs-to-ui/prototype/screens/home.html'),
    );
    const uiHtml = rows.filter((row) => row.stageId === 'ui-html');
    expect(uiHtml).toHaveLength(1);
    expect(uiHtml[0]!.path).toBe('docs-to-ui/prototype/index.html');
    expect(uiHtml[0]!.target).toBeNull();
  });

  it('emits one row per target on a multi-target build', () => {
    const rows = resolvePreviewTargets(
      files(
        'docs-to-ui/mobile/prototype/index.html',
        'docs-to-ui/web-user/prototype/index.html',
      ),
    );
    const uiHtml = rows.filter((row) => row.stageId === 'ui-html');
    expect(uiHtml).toHaveLength(2);
    expect(uiHtml.map((row) => row.target)).toEqual(['mobile', 'web-user']);
    expect(uiHtml.map((row) => row.path)).toEqual([
      'docs-to-ui/mobile/prototype/index.html',
      'docs-to-ui/web-user/prototype/index.html',
    ]);
  });

  it('emits exactly one path-less row for a step with no output', () => {
    const rows = resolvePreviewTargets(files('docs-to-ui/prototype/index.html'));
    const uiReact = rows.filter((row) => row.stageId === 'ui-react');
    expect(uiReact).toHaveLength(1);
    expect(uiReact[0]!.path).toBeNull();
    expect(uiReact[0]!.target).toBeNull();
  });

  it('always lists every pipeline step in table order', () => {
    for (const list of [files(), files('docs-to-ui/prototype/index.html')]) {
      const rows = resolvePreviewTargets(list);
      expect(rows).toHaveLength(PREVIEW_STAGE_COUNT);
      expect(rows.map((row) => row.stageId)).toEqual(EXPECTED_ORDER);
    }
  });

  it('does not light up a docs-to-ui step from another workflow’s files', () => {
    // docs-to-prd dominates, so its review/summary.md resolves prd-review while
    // the lone docs-to-ui prototype stays out of scope.
    const rows = resolvePreviewTargets(
      files(
        'docs-to-prd/review/summary.md',
        'docs-to-prd/docs/prd.md',
        'docs-to-ui/prototype/index.html',
      ),
    );
    expect(rows.find((row) => row.stageId === 'prd-review')!.path).toBe(
      'docs-to-prd/review/summary.md',
    );
    expect(rows.find((row) => row.stageId === 'ui-html')!.path).toBeNull();
  });

  it('resolves the remaining hero files, including cj pattern preference', () => {
    const rows = resolvePreviewTargets(
      files(
        'docs-to-ui/docs/system-map.json',
        'docs-to-ui/checkout-customer-journey.json',
        'docs-to-ui/checkout-cj.json',
        'docs-to-ui/ux-research/report.json',
        'docs-to-ui/checkout-ux-spec.json',
        'docs-to-ui/heuristic-review/report.json',
        'docs-to-ui/react/dist/index.html',
        'docs-to-ui/react-ds/dist/index.html',
      ),
    );
    const byStage = new Map(rows.map((row) => [row.stageId, row.path]));
    expect(byStage.get('docs-map')).toBe('docs-to-ui/docs/system-map.json');
    expect(byStage.get('cj')).toBe('docs-to-ui/checkout-customer-journey.json');
    expect(byStage.get('ux-research')).toBe('docs-to-ui/ux-research/report.json');
    expect(byStage.get('ux')).toBe('docs-to-ui/checkout-ux-spec.json');
    expect(byStage.get('ux-review')).toBe('docs-to-ui/heuristic-review/report.json');
    expect(byStage.get('ui-react')).toBe('docs-to-ui/react/dist/index.html');
    expect(byStage.get('ui-react-ds')).toBe('docs-to-ui/react-ds/dist/index.html');
  });

  it('handles legacy flat projects with no workflow prefix', () => {
    const rows = resolvePreviewTargets(files('prototype/index.html'));
    expect(rows.find((row) => row.stageId === 'ui-html')!.path).toBe('prototype/index.html');
  });

  it('resolves docs-review outputs', () => {
    const rows = resolvePreviewTargets(files('docs-review/review/index.json'));
    expect(rows.find((row) => row.stageId === 'dr-review')!.path).toBe(
      'docs-review/review/index.json',
    );
  });

  // ds-lab (WP-lab): its head IS a known workflow prefix (WORKFLOW_HEAD_TO_ID),
  // but no STAGE_SPECS entry names it — lab-compose's screens/*.png have no
  // single hero file, same reason the ingest steps are absent. Its files must
  // not get treated as unprefixed-legacy (which would conflate them with a
  // genuinely flat project) nor light up any row.
  it('recognizes ds-lab as a known workflow prefix but lights up no row for it (no single hero file)', () => {
    const rows = resolvePreviewTargets(files('ds-lab/screens/SCR-001.png', 'ds-lab/lab-result.json'));
    expect(rows.every((row) => row.path === null)).toBe(true);
  });

  it('a ds-lab project does not steal another workflow’s dominant scope', () => {
    // docs-to-ui still dominates (2 files vs 1) and resolves its own hero,
    // while the lone ds-lab file stays out of scope (foreign workflow prefix).
    const rows = resolvePreviewTargets(
      files(
        'docs-to-ui/prototype/index.html',
        'docs-to-ui/checkout-ux-spec.json',
        'ds-lab/screens/SCR-001.png',
      ),
    );
    expect(rows.find((row) => row.stageId === 'ui-html')!.path).toBe('docs-to-ui/prototype/index.html');
  });
});
