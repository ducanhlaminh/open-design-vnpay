import { describe, expect, it } from 'vitest';

import {
  applyScreenFlowLayoutUpdate,
  parseScreenFlowLayoutOverrides,
  reconcileScreenFlowLayout,
} from '../src/screen-flow-layout.js';

describe('screen-flow layout overrides', () => {
  it('reads a valid layout and fails soft on corrupt files', () => {
    const valid = parseScreenFlowLayoutOverrides(JSON.stringify({
      schema_version: 1,
      flows: { F1: { positions: { A: { x: 12, y: 24 } }, locked: true, updatedAt: 'now' } },
    }));
    expect(valid.warnings).toEqual([]);
    expect(valid.doc.flows.F1?.positions.A).toEqual({ x: 12, y: 24 });
    expect(parseScreenFlowLayoutOverrides('{bad').doc.flows).toEqual({});
  });

  it('updates or resets one flow and rejects non-finite coordinates atomically', () => {
    const initial = { schema_version: 1 as const, flows: {} };
    const updated = applyScreenFlowLayoutUpdate(initial, {
      flowId: 'FLOW-A', positions: { A: { x: 10, y: 20 } }, locked: false,
    }, 'fixed');
    expect(updated.error).toBeUndefined();
    expect(updated.doc.flows['FLOW-A']).toMatchObject({ positions: { A: { x: 10, y: 20 } }, updatedAt: 'fixed' });
    expect(applyScreenFlowLayoutUpdate(updated.doc, {
      flowId: 'FLOW-A', positions: { A: { x: Number.NaN, y: 2 } },
    }).error).toMatch(/position không hợp lệ/);
    expect(applyScreenFlowLayoutUpdate(updated.doc, { flowId: 'FLOW-A', reset: true }).doc.flows).toEqual({});
  });

  it('drops stale flows and positions while retaining valid manual positions', () => {
    const current = parseScreenFlowLayoutOverrides(JSON.stringify({
      schema_version: 1,
      flows: {
        F1: { positions: { A: { x: 1, y: 2 }, STALE: { x: 3, y: 4 } }, locked: false, updatedAt: 'now' },
        OLD: { positions: { Z: { x: 0, y: 0 } }, locked: false, updatedAt: 'now' },
      },
    })).doc;
    const next = reconcileScreenFlowLayout(current, new Map([['F1', new Set(['A', 'NEW'])]]));
    expect(next.flows).toEqual({ F1: { positions: { A: { x: 1, y: 2 } }, locked: false, updatedAt: 'now' } });
  });
});
