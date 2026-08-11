import { describe, expect, it } from 'vitest';
import { buildPath, parseRoute } from '../src/router';

describe('design system criteria route', () => {
  it('parses criteria section', () => {
    expect(parseRoute('/design-systems/abc/criteria')).toEqual({
      kind: 'design-system-detail',
      designSystemId: 'abc',
      section: 'criteria',
    });
  });

  it('keeps the detail route unchanged without section', () => {
    expect(parseRoute('/design-systems/abc')).toEqual({
      kind: 'design-system-detail',
      designSystemId: 'abc',
    });
  });

  it('serializes both detail sections', () => {
    expect(buildPath({ kind: 'design-system-detail', designSystemId: 'abc', section: 'criteria' })).toBe(
      '/design-systems/abc/criteria',
    );
    expect(buildPath({ kind: 'design-system-detail', designSystemId: 'abc' })).toBe('/design-systems/abc');
  });

  it('round-trips encoded IDs', () => {
    const route = { kind: 'design-system-detail' as const, designSystemId: 'user:lib-x', section: 'criteria' as const };
    expect(parseRoute(buildPath(route))).toEqual(route);
  });
});
