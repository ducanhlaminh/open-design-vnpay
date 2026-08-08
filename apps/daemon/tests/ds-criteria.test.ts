import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectComponentCatalog } from '../src/docs-components.js';
import {
  commitGeneratedComponentsMd,
  dsCriteriaDir,
  validateComponentsMd,
  writeDsRulesFile,
} from '../src/ds-criteria.js';

let dsDir: string;

beforeEach(async () => {
  dsDir = await mkdtemp(path.join(tmpdir(), 'od-ds-criteria-'));
});

afterEach(async () => {
  await rm(dsDir, { recursive: true, force: true });
});

const validComponents = `# Components\n\n## CONTROL\n\n### \`#button\` Button\n\n### \`#input\` Input\n\n## NAVIGATION\n\n### \`#tabs\` Tabs\n`;

describe('validateComponentsMd', () => {
  it('accepts grouped components and unanchored group headings', () => {
    const result = validateComponentsMd(validComponents);
    expect(result).toEqual({ ok: true, errors: [], components: 3 });
  });

  it('rejects duplicate anchors', () => {
    const result = validateComponentsMd(`${validComponents}\n### \`#button\` Duplicate\n`);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('anchor trùng: #button');
  });

  it('rejects an unanchored component heading', () => {
    const result = validateComponentsMd('### Button\n');
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('heading component thiếu anchor');
  });

  it('rejects empty content', () => {
    const result = validateComponentsMd('');
    expect(result.ok).toBe(false);
    expect(result.components).toBe(0);
  });
});

describe('commitGeneratedComponentsMd', () => {
  it('keeps the old file when .next is invalid and removes .next', async () => {
    const dir = dsCriteriaDir(dsDir);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(dir, { recursive: true }));
    await writeFile(path.join(dir, 'components.md'), 'old');
    await writeFile(path.join(dir, 'components.md.next'), '### Broken\n');

    const result = await commitGeneratedComponentsMd(dsDir);
    expect(result.ok).toBe(false);
    expect(await readFile(path.join(dir, 'components.md'), 'utf8')).toBe('old');
    await expect(readFile(path.join(dir, 'components.md.next'))).rejects.toThrow();
  });

  it('atomically commits valid content and metadata', async () => {
    const dir = dsCriteriaDir(dsDir);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(dir, { recursive: true }));
    await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(dsDir, 'react/docs'), { recursive: true }));
    await writeFile(path.join(dsDir, 'react/docs/catalog.md'), 'catalog');
    await writeFile(path.join(dir, 'components.md.next'), validComponents);

    const result = await commitGeneratedComponentsMd(dsDir, { now: new Date('2026-01-02T03:04:05.000Z') });
    expect(result).toEqual({ ok: true, errors: [], components: 3 });
    expect(await readFile(path.join(dir, 'components.md'), 'utf8')).toBe(validComponents);
    const meta = JSON.parse(await readFile(path.join(dir, '_meta.json'), 'utf8'));
    expect(meta.components).toBe(3);
    expect(Number.isNaN(Date.parse(meta.generatedAt))).toBe(false);
  });
});

describe('writeDsRulesFile', () => {
  it('warns when no rule anchor exists and preserves input bytes', async () => {
    const text = '# Rules\n';
    const warnings = await writeDsRulesFile(dsDir, text);
    expect(warnings).toEqual(['rules.md không có heading nào mang anchor dạng `R-XXX` — dr-review sẽ không trace được rule_id về file này.']);
    expect(await readFile(path.join(dsCriteriaDir(dsDir), 'rules.md'), 'utf8')).toBe(text);
  });

  it('accepts an anchored rule', async () => {
    expect(await writeDsRulesFile(dsDir, '## `R-OVERLAY` X\n')).toEqual([]);
  });
});

describe('component catalog round-trip', () => {
  it('returns criteria rule ids for every component', () => {
    const catalog = collectComponentCatalog(validComponents);
    expect([...catalog.values()]).toEqual([
      'criteria/components.md#button',
      'criteria/components.md#input',
      'criteria/components.md#tabs',
    ]);
  });
});
