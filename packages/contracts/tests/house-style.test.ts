import { describe, expect, it } from 'vitest';

import { composeSystemPrompt } from '../src/prompts/system.js';
import { renderHouseStylePrompt } from '../src/prompts/house-style.js';

describe('renderHouseStylePrompt', () => {
  it('pins Vietnamese output when no UI locale overrides the language', () => {
    for (const locale of [undefined, '', 'en', 'EN']) {
      const prompt = renderHouseStylePrompt(locale);
      expect(prompt).toContain('Write every user-visible sentence in Vietnamese');
      expect(prompt).toContain('# Answer shape');
    }
  });

  it('yields the language rule to a non-English UI locale', () => {
    // The "UI locale override" block already pins the language for these;
    // emitting both would ask for two languages in one prompt.
    const prompt = renderHouseStylePrompt('ja');
    expect(prompt).not.toContain('Vietnamese');
    expect(prompt).toContain('# Answer shape');
  });
});

describe('composeSystemPrompt — house style', () => {
  it('carries the answer shape into every run', () => {
    const prompt = composeSystemPrompt({});
    expect(prompt).toContain('# Answer shape');
    expect(prompt).toContain('Write every user-visible sentence in Vietnamese');
  });

  it('keeps the shape but not the Vietnamese rule under a non-English locale', () => {
    const prompt = composeSystemPrompt({ locale: 'zh-CN' });
    expect(prompt).toContain('# Answer shape');
    expect(prompt).toContain('# UI locale override');
    expect(prompt).not.toContain('Write every user-visible sentence in Vietnamese');
  });
});
