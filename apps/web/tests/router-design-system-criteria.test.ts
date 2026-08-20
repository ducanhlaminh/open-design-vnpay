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

// WP21b — `/design-systems/figma/:sourceId` phải tách khỏi
// `design-system-detail`: segment literal "figma" không được nuốt nhầm làm
// designSystemId.
describe('figma design system detail route', () => {
  it('parses /design-systems/figma/:sourceId', () => {
    expect(parseRoute('/design-systems/figma/src-1')).toEqual({
      kind: 'figma-ds-detail',
      sourceId: 'src-1',
    });
  });

  it('does not swallow "figma" into design-system-detail', () => {
    const route = parseRoute('/design-systems/figma/src-1');
    expect(route.kind).not.toBe('design-system-detail');
  });

  it('serializes figma-ds-detail', () => {
    expect(buildPath({ kind: 'figma-ds-detail', sourceId: 'src-1' })).toBe('/design-systems/figma/src-1');
  });

  it('round-trips encoded sourceId', () => {
    const route = { kind: 'figma-ds-detail' as const, sourceId: 'user:src-1' };
    expect(parseRoute(buildPath(route))).toEqual(route);
  });

  it('keeps plain design-system-detail routes unaffected', () => {
    expect(parseRoute('/design-systems/abc')).toEqual({
      kind: 'design-system-detail',
      designSystemId: 'abc',
    });
  });
});
