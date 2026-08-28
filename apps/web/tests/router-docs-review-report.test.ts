/**
 * URL router coverage for the docs-review report detail page under /feedback:
 *   /feedback                                         → home view 'feedback'
 *   /feedback/docs-review/:projectId/:confirmationId  → docs-review-report
 */
import { describe, expect, it } from 'vitest';
import { buildPath, parseRoute, type Route } from '../src/router';

describe('router /feedback/docs-review', () => {
  it('parses the detail route and decodes segments', () => {
    expect(parseRoute('/feedback/docs-review/p-v2/c-new')).toEqual({ kind: 'docs-review-report', projectId: 'p-v2', confirmationId: 'c-new' });
    expect(parseRoute('/feedback/docs-review/p%201/c%2F2/')).toEqual({ kind: 'docs-review-report', projectId: 'p 1', confirmationId: 'c/2' });
  });

  it('falls back to the feedback home when segments are missing', () => {
    expect(parseRoute('/feedback')).toEqual({ kind: 'home', view: 'feedback' });
    expect(parseRoute('/feedback/docs-review')).toEqual({ kind: 'home', view: 'feedback' });
    expect(parseRoute('/feedback/docs-review/p-only')).toEqual({ kind: 'home', view: 'feedback' });
  });

  it('serializes and round-trips', () => {
    const route: Route = { kind: 'docs-review-report', projectId: 'p 1', confirmationId: 'c/2' };
    expect(buildPath(route)).toBe('/feedback/docs-review/p%201/c%2F2');
    expect(parseRoute(buildPath(route))).toEqual(route);
    expect(buildPath({ kind: 'home', view: 'feedback' })).toBe('/feedback');
  });
});
