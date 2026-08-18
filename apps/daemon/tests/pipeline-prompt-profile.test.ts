import { describe, expect, it } from 'vitest';
import { composeSystemPrompt, PIPELINE_CHARTER } from '../src/prompts/system.js';
import { renderPipelineFolderSummary } from '../src/server.js';

// `promptProfile: 'pipeline'` is the lean prompt for unattended stage runs.
// Measured 2026-08 on real docs-review transcripts: the chat profile costs a
// stage 80–113k prompt tokens (charter + memory + DS + full file listing),
// of which the stage's own skill is ~15–20k. These tests pin what the lean
// profile drops and what it MUST keep.

const skillBody = '# docs-flow-ux\n\n## Bước 0 — đọc input\n\nRead `docs/<page>.md`.';

function compose(profile?: 'chat' | 'pipeline') {
  return composeSystemPrompt({
    agentId: 'claude',
    includeCodexImagegenOverride: false,
    skillBody,
    skillName: 'docs-flow-ux',
    memoryBody: '### Project\n- **kg-seed** — remembered fact from a past chat',
    designSystemBody: '# Neutral Modern\n\nPalette: blue.',
    designSystemTitle: 'Neutral Modern',
    designSystemTokensCss: ':root { --accent: #0066b3; }',
    userInstructions: 'Always answer in Vietnamese.',
    projectInstructions: 'Project X: use SCR- prefixes.',
    metadata: { kind: 'other' },
    ...(profile ? { promptProfile: profile } : {}),
  });
}

describe('composeSystemPrompt — promptProfile: pipeline', () => {
  it('drops the chat-only layers and keeps the stage essentials', () => {
    const chat = compose();
    const lean = compose('pipeline');

    // What the lean profile must NOT carry.
    expect(lean).not.toContain('# OD core directives');
    expect(lean).not.toContain('# Identity and workflow charter');
    expect(lean).not.toContain('## Personal memory');
    expect(lean).not.toContain('remembered fact from a past chat');
    expect(lean).not.toContain('## Clarifying questions');
    expect(lean).not.toContain('If this brief is a slide deck');

    // What it must keep.
    expect(lean).toContain(PIPELINE_CHARTER);
    expect(lean).toContain('## Active skill — docs-flow-ux');
    expect(lean).toContain(skillBody);
    expect(lean).toContain('## Custom instructions (user-level)');
    expect(lean).toContain('## Custom instructions (project-level)');
    // Response-language / house style still leads the prompt.
    expect(lean).toContain('# Response language');

    // And it is materially smaller than the chat profile for the same inputs.
    expect(lean.length).toBeLessThan(chat.length * 0.5);
    // The chat profile is unchanged by the new field being absent.
    expect(chat).toContain('# OD core directives');
    expect(chat).toContain('## Personal memory');
    expect(chat).toContain('## Clarifying questions');
  });

  it('still renders design-system blocks when the caller passes them (UI stages)', () => {
    // The daemon only resolves DS assets for `acceptsDesignSystem` stages;
    // when it does, the composer must not silently drop them.
    const lean = compose('pipeline');
    expect(lean).toContain('## Active design system — Neutral Modern');
    expect(lean).toContain('## Active design system tokens — Neutral Modern');
    expect(lean).toContain('## Active design system visual direction');
  });

  it('never appends the Critique Theater panel for pipeline runs', () => {
    const lean = composeSystemPrompt({
      agentId: 'claude',
      includeCodexImagegenOverride: false,
      skillBody,
      promptProfile: 'pipeline',
      critique: { enabled: true, panelSize: 3, rounds: 1 } as never,
      critiqueBrand: { name: 'Neutral Modern', design_md: '# NM' },
      critiqueSkill: { id: 'docs-flow-ux' },
    });
    expect(lean).not.toContain('CRITIQUE_RUN');
  });
});

describe('renderPipelineFolderSummary', () => {
  it('collapses the file listing to top-level entries with counts', () => {
    const files = [
      { name: 'docs-feature/App/A/B/page-1.md' },
      { name: 'docs-feature/App/A/B/page-2.md' },
      { name: 'docs-app/_index.md' },
      { name: 'flows/F-01.flowchart.json' },
      { name: 'context-lock.json' },
    ];
    const out = renderPipelineFolderSummary(files);
    expect(out).toContain('5 files total');
    expect(out).toContain('- docs-feature/ (2 files)');
    expect(out).toContain('- docs-app/ (1 file)');
    expect(out).toContain('- flows/ (1 file)');
    expect(out).toContain('- context-lock.json');
    // No deep paths leak into the prompt.
    expect(out).not.toContain('page-1.md');
    expect(out).not.toContain('do NOT overwrite');
  });

  it('handles an empty folder', () => {
    expect(renderPipelineFolderSummary([])).toContain('This folder is empty.');
  });
});
