import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { collectComponentCatalog } from './docs-components.js';
import { collectCriteriaAnchors } from './docs-review.js';

/** <dsDir>/criteria */
export function dsCriteriaDir(dsDir: string): string {
  return path.join(dsDir, 'criteria');
}

export type DsCriteriaMeta = {
  generatedAt: string;
  components: number;
  rulesBytes: number | null;
  sourceCatalogSha: string | null;
};

export type DsCriteriaState = {
  hasComponents: boolean;
  hasRules: boolean;
  components: number;
  rules: number;
  meta: DsCriteriaMeta | null;
};

export async function readDsCriteriaState(dsDir: string): Promise<DsCriteriaState> {
  const dir = dsCriteriaDir(dsDir);
  const [componentsText, rulesText, metaText] = await Promise.all([
    readFile(path.join(dir, 'components.md'), 'utf8').catch(() => null),
    readFile(path.join(dir, 'rules.md'), 'utf8').catch(() => null),
    readFile(path.join(dir, '_meta.json'), 'utf8').catch(() => null),
  ]);
  let meta: DsCriteriaMeta | null = null;
  if (metaText) {
    try {
      const parsed = JSON.parse(metaText) as DsCriteriaMeta;
      if (typeof parsed.generatedAt === 'string' && typeof parsed.components === 'number') meta = parsed;
    } catch {
      // Malformed metadata should not make the status endpoint fail.
    }
  }
  return {
    hasComponents: componentsText !== null,
    hasRules: rulesText !== null,
    components: componentsText === null ? 0 : collectComponentCatalog(componentsText).size,
    rules: rulesText === null ? 0 : collectCriteriaAnchors([{ name: 'rules.md', text: rulesText }]).size,
    meta,
  };
}

export async function writeDsRulesFile(dsDir: string, text: string): Promise<string[]> {
  const dir = dsCriteriaDir(dsDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'rules.md'), text, 'utf8');
  const anchors = collectCriteriaAnchors([{ name: 'rules.md', text }]);
  return anchors.size === 0
    ? ['rules.md không có heading nào mang anchor dạng `R-XXX` — dr-review sẽ không trace được rule_id về file này.']
    : [];
}

export function validateComponentsMd(text: string): { ok: boolean; errors: string[]; components: number } {
  const catalog = collectComponentCatalog(text);
  const errors: string[] = [];
  if (catalog.size < 1) {
    errors.push('không parse được component nào (heading phải dạng `### `#slug` Tên`)');
  }

  const anchors = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!/^#{1,6} /.test(line)) continue;
    const tokens = [...line.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? '').trim().replace(/^#/, ''));
    if (tokens.length === 0) {
      if (line.startsWith('### ')) errors.push(`heading component thiếu anchor: ${JSON.stringify(line)}`);
      continue;
    }
    for (const token of tokens) {
      if (!token) continue;
      anchors.set(token, (anchors.get(token) ?? 0) + 1);
    }
  }
  for (const [anchor, count] of anchors) {
    if (count >= 2) errors.push(`anchor trùng: #${anchor}`);
  }
  return { ok: errors.length === 0, errors, components: catalog.size };
}

export async function commitGeneratedComponentsMd(
  dsDir: string,
  opts: { now?: Date } = {},
): Promise<{ ok: boolean; errors: string[]; components: number }> {
  const dir = dsCriteriaDir(dsDir);
  const nextPath = path.join(dir, 'components.md.next');
  let text: string;
  try {
    text = await readFile(nextPath, 'utf8');
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], components: 0 };
  }
  const result = validateComponentsMd(text);
  if (!result.ok) {
    await rm(nextPath, { force: true });
    return result;
  }

  const rulesPath = path.join(dir, 'rules.md');
  const catalogPath = path.join(dsDir, 'react', 'docs', 'catalog.md');
  const [rulesBytes, catalogText] = await Promise.all([
    stat(rulesPath).then((value) => value.size).catch(() => null),
    readFile(catalogPath, 'utf8').catch(() => null),
  ]);
  const meta: DsCriteriaMeta = {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    components: result.components,
    rulesBytes,
    sourceCatalogSha: catalogText === null ? null : createHash('sha256').update(catalogText).digest('hex'),
  };
  try {
    await rename(nextPath, path.join(dir, 'components.md'));
    await writeFile(path.join(dir, '_meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  } catch (error) {
    await rm(nextPath, { force: true }).catch(() => undefined);
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], components: 0 };
  }
  return result;
}
