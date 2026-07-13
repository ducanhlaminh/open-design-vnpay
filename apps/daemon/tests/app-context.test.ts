import { describe, expect, it } from 'vitest';

import { appContextDirective, APP_CONTEXT_DIR, STAGED_APP_CONTEXT } from '../src/app-context.js';

// The staging + media I/O is best-effort and covered by integration; here we
// lock the PURE directive logic that shapes the kickoff, because that text is
// what makes a feature inherit its app's context (or leaves the kickoff
// untouched for an unlinked feature).
describe('app-context — kickoff directive', () => {
  it('is empty when nothing was staged, so unlinked features keep the legacy kickoff', () => {
    expect(appContextDirective([])).toBe('');
  });

  it('lists the staged context files and points the agent at ./.app-context', () => {
    const d = appContextDirective(['ux-charter.json', 'ia.json']);
    expect(d).toContain('./.app-context');
    expect(d).toContain('ux-charter.json');
    expect(d).toContain('ia.json');
    // The charter's "must" criteria must be framed as hard constraints.
    expect(d).toMatch(/hard constraint/i);
  });

  it('routes cross-cutting additions to a JSON delta proposal, never a direct edit', () => {
    const d = appContextDirective(['ux-charter.json']);
    expect(d).toContain('app-context-delta.json');
    // Read-only guarantee: the agent must not write into the staged folder.
    expect(d).toMatch(/do NOT edit \.\/\.app-context directly/i);
  });

  it('exposes stable folder constants for the media layout and staging path', () => {
    expect(APP_CONTEXT_DIR).toBe('app-context');
    expect(STAGED_APP_CONTEXT).toBe('.app-context');
  });
});
