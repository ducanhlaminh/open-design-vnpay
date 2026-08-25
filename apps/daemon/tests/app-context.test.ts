import { describe, expect, it } from 'vitest';

import { appContextDirective, APP_CONTEXT_DIR, STAGED_APP_CONTEXT } from '../src/app-context.js';
// dsCriteriaDirective lives in server.ts (not app-context.ts): it is the
// kickoff directive for `usesDesignSystemCriteria` stages, staged/used inside
// runPipeline / runSectionFanout — see the doc-comment above its definition.
import { dsCriteriaDirective } from '../src/server.js';

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
    expect(d).toMatch(/ràng buộc cứng/i);
  });

  it('routes cross-cutting additions to a JSON delta proposal, never a direct edit', () => {
    const d = appContextDirective(['ux-charter.json']);
    expect(d).toContain('app-context-delta.json');
    // Read-only guarantee: the agent must not write into the staged folder.
    expect(d).toMatch(/KHÔNG sửa \.\/\.app-context trực tiếp/i);
  });

  it('exposes stable folder constants for the media layout and staging path', () => {
    expect(APP_CONTEXT_DIR).toBe('app-context');
    expect(STAGED_APP_CONTEXT).toBe('.app-context');
  });
});

// dsCriteriaDirective: the kickoff directive for a stage that consumes a
// Design System's review criteria (usesDesignSystemCriteria). Pure, same
// shape as appContextDirective — the caller checks which files actually
// exist on disk and passes that in, so a DS half-generated (rules.md but no
// components.md yet, or vice versa) never gets misreported here.
describe('dsCriteriaDirective — kickoff directive', () => {
  it('is empty when neither file was staged, so a project with no DS (or no criteria yet) keeps the legacy kickoff', () => {
    expect(dsCriteriaDirective({ hasRules: false, hasComponents: false })).toBe('');
  });

  it('mentions ./criteria/rules.md when hasRules, and calls it the DS UX rules that must be followed', () => {
    const d = dsCriteriaDirective({ hasRules: true, hasComponents: false });
    expect(d).toContain('./criteria/rules.md');
    expect(d).toMatch(/BẮT BUỘC tuân theo/i);
    // Only the file that actually exists is mentioned.
    expect(d).not.toContain('./criteria/components.md');
  });

  it('mentions ./criteria/components.md when hasComponents, and calls it the valid component catalog', () => {
    const d = dsCriteriaDirective({ hasRules: false, hasComponents: true });
    expect(d).toContain('./criteria/components.md');
    expect(d).toMatch(/danh mục component/i);
    expect(d).not.toContain('./criteria/rules.md');
  });

  it('mentions both files when both are staged', () => {
    const d = dsCriteriaDirective({ hasRules: true, hasComponents: true });
    expect(d).toContain('./criteria/rules.md');
    expect(d).toContain('./criteria/components.md');
  });
});
