import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectComponentCatalog } from '../src/docs-components.js';
import {
  commitGeneratedComponentsMd,
  commitGeneratedRulesMd,
  copyDsCriteriaIntoWorkflow,
  dsCriteriaDir,
  validateComponentsMd,
  validateRulesMd,
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

describe('validateRulesMd', () => {
  it('accepts a valid R anchor heading', () => {
    expect(validateRulesMd('### `R-COLOR-ROLE` Dùng đúng vai trò màu\n')).toEqual({ ok: true, errors: [], rules: 1 });
  });
  it('rejects missing anchor, duplicate anchor, and empty content', () => {
    expect(validateRulesMd('### Quy tắc\n').errors.join('\n')).toContain('thiếu anchor');
    expect(validateRulesMd('### `R-X` A\n### `R-X` B\n').errors.join('\n')).toContain('anchor trùng');
    expect(validateRulesMd('').errors.join('\n')).toContain('không parse được quy tắc nào');
  });
});

describe('commitGeneratedRulesMd', () => {
  it('reports missing .next without raw filesystem wording', async () => {
    const result = await commitGeneratedRulesMd(dsDir);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).not.toMatch(/ENOENT|no such file/i);
  });
  it('renames valid .next and does not create metadata', async () => {
    const dir = dsCriteriaDir(dsDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'rules.md.next'), '### `R-X` Quy tắc\n');
    const result = await commitGeneratedRulesMd(dsDir);
    expect(result).toEqual({ ok: true, errors: [], rules: 1 });
    expect(await readFile(path.join(dir, 'rules.md'), 'utf8')).toContain('R-X');
    await expect(readFile(path.join(dir, '_meta.json'))).rejects.toThrow();
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

  it('reports a clear message (not raw ENOENT) when .next was never written', async () => {
    // Agent kết thúc "succeeded" nhưng không ghi file: không có `.next`,
    // thậm chí không có thư mục criteria/.
    const result = await commitGeneratedComponentsMd(dsDir);
    expect(result.ok).toBe(false);
    expect(result.components).toBe(0);
    const message = result.errors.join('\n');
    expect(message).not.toContain('ENOENT');
    expect(message).not.toContain('no such file');
    expect(message).toContain('không sinh ra');
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

// The daemon's dsDirForId (server.ts) resolves a designSystemId to a real DS
// dir via USER_DESIGN_SYSTEMS_DIR/DESIGN_SYSTEMS_DIR — copyDsCriteriaIntoWorkflow
// stays independent of that by taking a resolver callback, so tests can just
// hand it the temp `dsDir` (or a garbage path / a throwing resolver) directly.
describe('copyDsCriteriaIntoWorkflow', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'od-ds-criteria-cwd-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const resolveToDsDir = async () => dsDir;

  it('copies both files when the DS source has both, content matching the source', async () => {
    const srcDir = dsCriteriaDir(dsDir);
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'components.md'), '# Components from DS\n');
    await writeFile(path.join(srcDir, 'rules.md'), '# Rules from DS\n');

    await copyDsCriteriaIntoWorkflow('ds-both', cwd, resolveToDsDir);

    const dstDir = path.join(cwd, 'criteria');
    expect(await readFile(path.join(dstDir, 'components.md'), 'utf8')).toBe('# Components from DS\n');
    expect(await readFile(path.join(dstDir, 'rules.md'), 'utf8')).toBe('# Rules from DS\n');
  });

  it('copies catalog.md and examples.md from the React bundle', async () => {
    const srcDir = dsCriteriaDir(dsDir);
    await mkdir(srcDir, { recursive: true });
    await mkdir(path.join(dsDir, 'react/docs'), { recursive: true });
    await writeFile(path.join(srcDir, 'components.md'), '# Components\n');
    await writeFile(path.join(srcDir, 'rules.md'), '# Rules\n');
    await writeFile(path.join(dsDir, 'react/docs/catalog.md'), '# Catalog\n');
    await writeFile(path.join(dsDir, 'react/docs/examples.md'), '# Examples\n');

    await copyDsCriteriaIntoWorkflow('ds-react-docs', cwd, resolveToDsDir);

    const dstDir = path.join(cwd, 'criteria');
    expect(await readFile(path.join(dstDir, 'catalog.md'), 'utf8')).toBe('# Catalog\n');
    expect(await readFile(path.join(dstDir, 'examples.md'), 'utf8')).toBe('# Examples\n');
  });

  it('uses manifest React paths when they differ from the defaults', async () => {
    const srcDir = dsCriteriaDir(dsDir);
    await mkdir(srcDir, { recursive: true });
    await mkdir(path.join(dsDir, 'custom'), { recursive: true });
    await writeFile(path.join(dsDir, 'manifest.json'), JSON.stringify({ react: {
      catalog: 'custom/catalog.md', examplesIndex: 'custom/examples.md',
    } }));
    await writeFile(path.join(dsDir, 'custom/catalog.md'), 'custom catalog\n');
    await writeFile(path.join(dsDir, 'custom/examples.md'), 'custom examples\n');

    await copyDsCriteriaIntoWorkflow('ds-manifest-paths', cwd, resolveToDsDir);

    const dstDir = path.join(cwd, 'criteria');
    expect(await readFile(path.join(dstDir, 'catalog.md'), 'utf8')).toBe('custom catalog\n');
    expect(await readFile(path.join(dstDir, 'examples.md'), 'utf8')).toBe('custom examples\n');
  });

  it('ignores an absolute manifest catalog path outside the DS and uses the default', async () => {
    const srcDir = dsCriteriaDir(dsDir);
    await mkdir(srcDir, { recursive: true });
    await mkdir(path.join(dsDir, 'react/docs'), { recursive: true });
    const outsidePath = path.join(cwd, 'outside-catalog.md');
    await writeFile(path.join(dsDir, 'manifest.json'), JSON.stringify({ react: { catalog: outsidePath } }));
    await writeFile(outsidePath, 'outside catalog\n');
    await writeFile(path.join(dsDir, 'react/docs/catalog.md'), 'default catalog\n');

    await copyDsCriteriaIntoWorkflow('ds-absolute-manifest-path', cwd, resolveToDsDir);

    expect(await readFile(path.join(cwd, 'criteria/catalog.md'), 'utf8')).toBe('default catalog\n');
  });

  it('ignores a manifest catalog path that escapes the DS and uses the default', async () => {
    const srcDir = dsCriteriaDir(dsDir);
    await mkdir(srcDir, { recursive: true });
    await mkdir(path.join(dsDir, 'react/docs'), { recursive: true });
    const outsidePath = path.join(cwd, 'outside-catalog.md');
    const escapingPath = path.relative(dsDir, outsidePath);
    await writeFile(path.join(dsDir, 'manifest.json'), JSON.stringify({ react: { catalog: escapingPath } }));
    await writeFile(outsidePath, 'outside catalog\n');
    await writeFile(path.join(dsDir, 'react/docs/catalog.md'), 'default catalog\n');

    await copyDsCriteriaIntoWorkflow('ds-escaping-manifest-path', cwd, resolveToDsDir);

    expect(await readFile(path.join(cwd, 'criteria/catalog.md'), 'utf8')).toBe('default catalog\n');
  });

  it('removes stale catalog.md and examples.md when the current DS does not ship them', async () => {
    const srcDir = dsCriteriaDir(dsDir);
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'components.md'), '# Components\n');
    await writeFile(path.join(srcDir, 'rules.md'), '# Rules\n');
    const dstDir = path.join(cwd, 'criteria');
    await mkdir(dstDir, { recursive: true });
    await writeFile(path.join(dstDir, 'catalog.md'), 'stale catalog\n');
    await writeFile(path.join(dstDir, 'examples.md'), 'stale examples\n');

    await copyDsCriteriaIntoWorkflow('ds-no-react-docs', cwd, resolveToDsDir);

    await expect(readFile(path.join(dstDir, 'catalog.md'))).rejects.toThrow();
    await expect(readFile(path.join(dstDir, 'examples.md'))).rejects.toThrow();
  });

  it('source has only rules.md: removes the stale components.md left by a previous DS and writes the fresh rules.md', async () => {
    const srcDir = dsCriteriaDir(dsDir);
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'rules.md'), '# Rules from DS B\n');

    const dstDir = path.join(cwd, 'criteria');
    await mkdir(dstDir, { recursive: true });
    await writeFile(path.join(dstDir, 'components.md'), '# Stale components.md from DS A\n');
    await writeFile(path.join(dstDir, 'rules.md'), '# Stale rules.md from DS A\n');

    await copyDsCriteriaIntoWorkflow('ds-b-rules-only', cwd, resolveToDsDir);

    await expect(readFile(path.join(dstDir, 'components.md'))).rejects.toThrow();
    expect(await readFile(path.join(dstDir, 'rules.md'), 'utf8')).toBe('# Rules from DS B\n');
  });

  it('DS has no criteria/ directory at all: removes BOTH stale destination files', async () => {
    // dsDir exists (mkdtemp'd in the top-level beforeEach) but its criteria/
    // subdir is never created here — the DS simply hasn't generated anything.
    const dstDir = path.join(cwd, 'criteria');
    await mkdir(dstDir, { recursive: true });
    await writeFile(path.join(dstDir, 'components.md'), '# Stale components.md from a previous DS\n');
    await writeFile(path.join(dstDir, 'rules.md'), '# Stale rules.md from a previous DS\n');
    await writeFile(path.join(dstDir, 'catalog.md'), '# Stale catalog.md from a previous DS\n');
    await writeFile(path.join(dstDir, 'examples.md'), '# Stale examples.md from a previous DS\n');

    await copyDsCriteriaIntoWorkflow('ds-no-criteria-dir', cwd, resolveToDsDir);

    await expect(readFile(path.join(dstDir, 'components.md'))).rejects.toThrow();
    await expect(readFile(path.join(dstDir, 'rules.md'))).rejects.toThrow();
    await expect(readFile(path.join(dstDir, 'catalog.md'))).rejects.toThrow();
    await expect(readFile(path.join(dstDir, 'examples.md'))).rejects.toThrow();
  });

  it('creates the destination criteria/ directory when it does not exist yet, without throwing', async () => {
    const srcDir = dsCriteriaDir(dsDir);
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'components.md'), '# Components\n');

    await expect(copyDsCriteriaIntoWorkflow('ds-fresh-cwd', cwd, resolveToDsDir)).resolves.toBeUndefined();
    expect(await readFile(path.join(cwd, 'criteria', 'components.md'), 'utf8')).toBe('# Components\n');
  });

  it('never throws when the resolver fails, returns null, or resolves to a garbage/unreadable path', async () => {
    const throwingResolver = async (): Promise<string | null> => {
      throw new Error('resolver boom');
    };
    await expect(copyDsCriteriaIntoWorkflow('ds-resolver-throws', cwd, throwingResolver)).resolves.toBeUndefined();

    const nullResolver = async () => null;
    await expect(copyDsCriteriaIntoWorkflow('ds-not-found', cwd, nullResolver)).resolves.toBeUndefined();

    const garbagePathResolver = async () => '/definitely/does/not/exist/anywhere';
    await expect(
      copyDsCriteriaIntoWorkflow('ds-garbage-path', cwd, garbagePathResolver),
    ).resolves.toBeUndefined();
  });
});
