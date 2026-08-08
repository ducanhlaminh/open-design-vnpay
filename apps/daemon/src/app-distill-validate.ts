/** Deterministic validation for distilled App-pool Markdown outputs. */

export interface DistillPage {
  path: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const OVERVIEW_HEADINGS = [
  'Cách dùng file này',
  'Dự án',
  'Phân hệ',
  'Luồng nghiệp vụ xuyên trang',
  'Thuật ngữ',
  'Bản đồ trang',
] as const;

function result(errors: string[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split(/\r\n?|\n/);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function headings(content: string): string[] {
  return content
    .split(/\r\n?|\n/)
    .map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1])
    .filter((heading): heading is string => heading !== undefined);
}

function section(content: string, heading: string): string {
  const lines = content.split(/\r\n?|\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return '';
  const end = lines.findIndex(
    (line, index) => index > start && /^##\s+/.test(line),
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function cells(line: string): string[] | undefined {
  if (!line.includes('|')) return undefined;
  const trimmed = line.trim();
  const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const normalized = body.endsWith('|') ? body.slice(0, -1) : body;
  return normalized.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(row: string[]): boolean {
  return row.length > 0 && row.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** Ô path/slug so sánh theo GIÁ TRỊ, không theo cách trình bày: agent hay bọc
 *  path trong `backtick` (đúng thói quen citation của skill) hoặc viết `./`
 *  đằng trước — e2e đầu tiên (App "Test chung cất") fail validation chỉ vì
 *  backtick dù nội dung đúng 100%. Chỉ áp cho ô ĐƯỢC so sánh (Path/Slug/
 *  Branch), không áp cho cells() chung — ô Keywords chứa nhiều span backtick
 *  thì bóc kiểu này sẽ sai. */
function stripCellDecoration(cell: string): string {
  const unquoted = /^`([^`]*)`$/.exec(cell)?.[1] ?? cell;
  return unquoted.replace(/^\.\//, '').trim();
}

function tablePaths(content: string): { paths: string[]; found: boolean } {
  const lines = content.split(/\r\n?|\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = cells(lines[index] ?? '');
    const separator = cells(lines[index + 1] ?? '');
    if (!header || !separator || header[0]?.toLowerCase() !== 'path' || !isSeparatorRow(separator)) {
      continue;
    }

    const paths: string[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowLine = lines[rowIndex] ?? '';
      if (/^##\s+/.test(rowLine)) break;
      const row = cells(rowLine);
      if (!row) {
        if (paths.length > 0) break;
        continue;
      }
      if (row[0]) paths.push(stripCellDecoration(row[0]));
    }
    return { paths, found: true };
  }
  return { paths: [], found: false };
}

function validatePageTable(
  content: string,
  expectedPages: readonly DistillPage[],
  label: string,
): string[] {
  const errors: string[] = [];
  const expected = new Set(expectedPages.map((page) => page.path));
  const table = tablePaths(content);

  if (!table.found) {
    errors.push(`${label} page table is missing or has no Path header.`);
    return errors;
  }

  const seen = new Set<string>();
  for (const path of table.paths) {
    if (!expected.has(path)) errors.push(`${label} page table contains unknown path: ${path}`);
    if (seen.has(path)) errors.push(`${label} page table contains duplicate path: ${path}`);
    seen.add(path);
  }
  for (const path of expected) {
    if (!seen.has(path)) errors.push(`${label} page table is missing path: ${path}`);
  }
  return errors;
}

// §2.3 validation rule (c): "mọi `_branches/` được `## Phân hệ` tham chiếu" —
// every existing `_branches/<slug>.md` file's slug must show up in the
// `## Phân hệ` table (its `Slug` or `Branch` column; the table is
// `Slug|Phân hệ|Phạm vi|Branch`).
function phanHeSlugs(overviewContent: string): { slugs: Set<string>; found: boolean } {
  const sectionContent = section(overviewContent, 'Phân hệ');
  const lines = sectionContent.split(/\r\n?|\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = cells(lines[index] ?? '');
    const separator = cells(lines[index + 1] ?? '');
    if (!header || !separator || !isSeparatorRow(separator)) continue;
    const slugIdx = header.findIndex((h) => /^slug$/i.test(h));
    const branchIdx = header.findIndex((h) => /^branch$/i.test(h));
    if (slugIdx < 0 && branchIdx < 0) continue;
    const slugs = new Set<string>();
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowLine = lines[rowIndex] ?? '';
      if (/^##\s+/.test(rowLine)) break;
      const row = cells(rowLine);
      if (!row) {
        if (slugs.size > 0) break;
        continue;
      }
      if (slugIdx >= 0 && row[slugIdx]) slugs.add(stripCellDecoration(row[slugIdx]!));
      if (branchIdx >= 0 && row[branchIdx]) slugs.add(stripCellDecoration(row[branchIdx]!));
    }
    return { slugs, found: true };
  }
  return { slugs: new Set(), found: false };
}

export function validateBranchReferences(
  overviewContent: string,
  branchSlugs: readonly string[],
): ValidationResult {
  const errors: string[] = [];
  const { slugs, found } = phanHeSlugs(overviewContent);
  if (!found) {
    if (branchSlugs.length > 0) errors.push('Phân hệ table is missing or has no Slug/Branch header.');
    return result(errors);
  }
  for (const branch of branchSlugs) {
    if (!slugs.has(branch)) {
      errors.push(`Overview "Phân hệ" table does not reference _branches/${branch}.md.`);
    }
  }
  return result(errors);
}

export function validateOverview(
  overviewContent: string,
  manifestPages: readonly DistillPage[],
  /** Existing `_branches/<slug>.md` slugs — checked against rule (c). Omit
   *  (or pass []) to skip that check, e.g. when validating before any branch
   *  file exists. */
  branchSlugs: readonly string[] = [],
): ValidationResult {
  const errors: string[] = [];
  const actualHeadings = headings(overviewContent);
  if (
    actualHeadings.length !== OVERVIEW_HEADINGS.length ||
    actualHeadings.some((heading, index) => heading !== OVERVIEW_HEADINGS[index])
  ) {
    errors.push(
      `Overview headings must be exactly: ${OVERVIEW_HEADINGS.map((heading) => `## ${heading}`).join(' · ')}.`,
    );
  }
  if (lineCount(overviewContent) > 400) errors.push('Overview exceeds 400 lines.');

  const map = section(overviewContent, 'Bản đồ trang');
  errors.push(...validatePageTable(map, manifestPages, 'Overview'));
  errors.push(...validateBranchReferences(overviewContent, branchSlugs).errors);
  return result(errors);
}

export function validateBranch(
  content: string,
  branchPages: readonly DistillPage[],
): ValidationResult {
  const errors: string[] = [];
  if (lineCount(content) > 120) errors.push('Branch document exceeds 120 lines.');
  errors.push(...validatePageTable(content, branchPages, 'Branch'));
  return result(errors);
}
