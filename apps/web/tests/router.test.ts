/**
 * URL router round-trip tests (issue #1505).
 *
 * Pins the deep-link shape for the project route:
 *
 *   /                                                 home
 *   /projects/:id                                     project root
 *   /projects/:id/files/:path                         file view
 *   /projects/:id/conversations/:cid                  specific conversation
 *   /projects/:id/conversations/:cid/files/:path      conversation + file
 *
 * The conversation segment was added to unblock the Routines history
 * row: clicking "Open project" on a parallel run's row needs to land
 * the user on that run's own conversation, not on whatever the
 * project happens to default to.
 */

import { describe, expect, it } from 'vitest';

import { buildPath, parseRoute, type Route } from '../src/router';

function roundTrip(route: Route): Route {
  return parseRoute(buildPath(route));
}

describe('parseRoute / buildPath (issue #1505)', () => {
  it('parses the home route', () => {
    expect(parseRoute('/')).toEqual({ kind: 'home', view: 'home' });
    expect(parseRoute('')).toEqual({ kind: 'home', view: 'home' });
  });

  it('round-trips a bare project route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: null,
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/workspaces/p-1');
  });

  it('round-trips a project + file route (no conversation)', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: 'src/index.tsx',
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/workspaces/p-1/files/src/index.tsx');
  });

  it('round-trips a project + conversation route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'conv-abc',
      fileName: null,
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/workspaces/p-1/conversations/conv-abc');
  });

  it('round-trips a project + conversation + file route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'conv-abc',
      fileName: 'index.html',
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/workspaces/p-1/conversations/conv-abc/files/index.html');
  });

  it('percent-encodes ids and file names with reserved characters', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p/1 with space',
      conversationId: 'conv/abc with space',
      fileName: 'dir/file name.tsx',
    };
    const built = buildPath(route);
    expect(built).toContain('p%2F1%20with%20space');
    expect(built).toContain('conv%2Fabc%20with%20space');
    // File path components are percent-encoded individually so the
    // slash between segments survives.
    expect(built.endsWith('/dir/file%20name.tsx')).toBe(true);
    expect(roundTrip(route)).toEqual(route);
  });

  it('parses a legacy project + file URL with no conversation segment', () => {
    expect(parseRoute('/projects/p-1/files/README.md')).toEqual({
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: 'README.md',
    });
  });

  it('parses a project + conversation URL with no file segment', () => {
    expect(parseRoute('/projects/p-1/conversations/c-2')).toEqual({
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'c-2',
      fileName: null,
    });
  });

  it('round-trips a Design System criteria workspace', () => {
    const components: Route = {
      kind: 'design-system-criteria-workspace',
      designSystemId: 'ds/with space',
      criteriaKind: 'components',
    };
    const rules: Route = {
      kind: 'design-system-criteria-workspace',
      designSystemId: 'ds-2',
      criteriaKind: 'rules',
    };

    expect(buildPath(components)).toBe('/design-systems/ds%2Fwith%20space/criteria/components/workspace');
    expect(roundTrip(components)).toEqual(components);
    expect(roundTrip(rules)).toEqual(rules);
  });

  it('keeps the legacy criteria deep link on the review catalog', () => {
    expect(parseRoute('/design-systems/ds-1/criteria')).toEqual({
      kind: 'design-system-detail',
      designSystemId: 'ds-1',
      section: 'criteria',
    });
  });


  it('parses canonical workspace routes and legacy project aliases', () => {
    const paths = [
      '/workspaces/abc',
      '/workspaces/abc/conversations/c1',
      '/workspaces/abc/conversations/c1/files/x/y.md',
      '/workspaces/abc/files/x.md',
    ];
    for (const path of paths) {
      const canonical = parseRoute(path);
      expect(parseRoute(path.replace('/workspaces', '/projects'))).toEqual(canonical);
    }
    expect(parseRoute('/workspaces')).toEqual({ kind: 'home', view: 'workspaces' });
  });

  it('round-trips /integrations/<tab> and ignores unknown tabs', () => {
    expect(parseRoute('/integrations')).toEqual({ kind: 'home', view: 'integrations' });
    expect(parseRoute('/integrations/mcp')).toEqual({ kind: 'home', view: 'integrations', integrationsTab: 'mcp' });
    expect(parseRoute('/integrations/connectors')).toEqual({ kind: 'home', view: 'integrations', integrationsTab: 'connectors' });
    expect(parseRoute('/integrations/nope')).toEqual({ kind: 'home', view: 'integrations' });
    expect(buildPath({ kind: 'home', view: 'integrations' })).toBe('/integrations');
    expect(buildPath({ kind: 'home', view: 'integrations', integrationsTab: 'mcp' })).toBe('/integrations/mcp');
    expect(roundTrip({ kind: 'home', view: 'integrations', integrationsTab: 'use-everywhere' }))
      .toEqual({ kind: 'home', view: 'integrations', integrationsTab: 'use-everywhere' });
  });

  it('falls back to home when the URL is unrecognized', () => {
    expect(parseRoute('/something/else')).toEqual({ kind: 'home', view: 'home' });
    expect(parseRoute('/workspaces')).toEqual({ kind: 'home', view: 'workspaces' });
    expect(parseRoute('/projects')).toEqual({ kind: 'home', view: 'workspaces' });
  });
});
