import { describe, expect, it } from 'vitest';

import { auditCaptureDoc, parseFigMarker, type DsAuditData } from '../src/figma-audit.js';

// Marker format thật từ capture-lib: fig-comp = TÊN FIGMA của set, fig-variant
// = JSON url-encoded {"PropFigma":"Value"}.
const marker = (comp: string, variant?: Record<string, string>) =>
  `kg:fig|fig-comp=${comp}${variant ? `;fig-variant=${encodeURIComponent(JSON.stringify(variant))}` : ''}`;

const ds: DsAuditData = {
  uiComps: new Set(['ipaytopnavigationbar', 'ipaybutton']),
  iconComps: new Set(['ipayillustrationtransactionresulticonsuccess']),
  variants: new Map([
    [
      'ipaytopnavigationbar',
      { combos: new Set(['Level=Level 1|Type=Text', 'Level=Level 2|Type=Text']), defaultLabel: 'Level=Level 1|Type=Text' },
    ],
  ]),
};

const rect = (w: number, h: number) => ({ x: 0, y: 0, width: w, height: h });

describe('parseFigMarker', () => {
  it('parses comp name + url-encoded variant JSON', () => {
    const m = parseFigMarker(marker('iPay / Top Navigation Bar', { Level: 'Level 2', Type: 'Text' }));
    expect(m?.comp).toBe('iPay / Top Navigation Bar');
    expect(m?.variant).toEqual({ Level: 'Level 2', Type: 'Text' });
  });
  it('rejects non-fig markers', () => {
    expect(parseFigMarker('kg:tk|text=base-primary')).toBeNull();
  });
});

describe('auditCaptureDoc', () => {
  it('clean frame → no findings (valid comp + valid variant)', () => {
    const root = {
      rect: rect(390, 800),
      childNodes: [
        {
          owningReactComponent: marker('iPay / Top Navigation Bar', { Level: 'Level 2', Type: 'Text' }),
          rect: rect(375, 111),
          childNodes: [{ rect: rect(375, 100) }],
        },
      ],
    };
    const res = auditCaptureDoc('01 Màn A', root, ds);
    expect(res.markers).toBe(1);
    expect(res.findings).toEqual([]);
  });

  it('flags unknown components (plugin sẽ drop)', () => {
    const root = { childNodes: [{ owningReactComponent: marker('Không Tồn Tại') }] };
    const res = auditCaptureDoc('s', root, ds);
    expect(res.findings.map((f) => f.rule)).toEqual(['unknown-component']);
    expect(res.findings[0]!.level).toBe('error');
  });

  it('flags icon/illustration components (nằm ở file Iconography — vụ dấu ✓ mất)', () => {
    const root = {
      childNodes: [
        { owningReactComponent: marker('iPay / Illustration / Transaction Result / Icon / Success') },
      ],
    };
    const res = auditCaptureDoc('s', root, ds);
    expect(res.findings.map((f) => f.rule)).toEqual(['icon-file-component']);
    expect(res.findings[0]!.level).toBe('warning');
  });

  it('flags variant not in the compiled VARIANTS set (Figma sẽ fallback default — vụ header)', () => {
    const root = {
      childNodes: [
        {
          owningReactComponent: marker('iPay / Top Navigation Bar', { Level: 'Level 3', Type: 'Text' }),
          rect: rect(375, 111),
        },
      ],
    };
    const res = auditCaptureDoc('s', root, ds);
    expect(res.findings.map((f) => f.rule)).toEqual(['variant-fallback']);
    expect(res.findings[0]!.detail).toContain('Level=Level 1|Type=Text'); // default được nêu ra
  });

  it('variant so khớp KHÔNG phụ thuộc thứ tự key', () => {
    const root = {
      childNodes: [
        {
          owningReactComponent: marker('iPay / Top Navigation Bar', { Type: 'Text', Level: 'Level 2' }),
          rect: rect(375, 111),
        },
      ],
    };
    expect(auditCaptureDoc('s', root, ds).findings).toEqual([]);
  });

  it('flags a layer spilling far outside its component frame (vụ khối đen 375×812 trong nav)', () => {
    const root = {
      childNodes: [
        {
          owningReactComponent: marker('iPay / Top Navigation Bar', { Level: 'Level 2', Type: 'Text' }),
          rect: rect(375, 111),
          childNodes: [{ rect: rect(375, 812) }],
        },
      ],
    };
    const res = auditCaptureDoc('s', root, ds);
    expect(res.findings.map((f) => f.rule)).toEqual(['oversize-layer']);
    expect(res.findings[0]!.detail).toContain('375×812');
  });

  it('dedupes per (rule, comp, screen) so một component lặp nhiều node chỉ báo một lần', () => {
    const icon = {
      owningReactComponent: marker('iPay / Illustration / Transaction Result / Icon / Success'),
    };
    const root = { childNodes: [icon, { ...icon }, { ...icon }] };
    expect(auditCaptureDoc('s', root, ds).findings).toHaveLength(1);
  });
});

describe('aggregateFindings', () => {
  it('gộp cùng (rule, comp) qua nhiều màn thành MỘT dòng kèm danh sách màn, error lên đầu', async () => {
    const { aggregateFindings } = await import('../src/figma-audit.js');
    const f = (rule: string, level: string, comp: string, screen: string) =>
      ({ rule, level, comp, screen, detail: 'd', fix: 'x' }) as never;
    const out = aggregateFindings([
      f('icon-file-component', 'warning', 'ipay-divider', 'Màn 1'),
      f('icon-file-component', 'warning', 'ipay-divider', 'Màn 2'),
      f('icon-file-component', 'warning', 'ipay-divider', 'Màn 2'),
      f('unknown-component', 'error', 'ghost', 'Màn 1'),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ rule: 'unknown-component', level: 'error' });
    expect(out[1]).toMatchObject({ comp: 'ipay-divider', screens: ['Màn 1', 'Màn 2'] });
  });
});
