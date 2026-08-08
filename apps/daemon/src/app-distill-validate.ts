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
      if (row[0]) paths.push(row[0]);
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

export function validateOverview(
  overviewContent: string,
  manifestPages: readonly DistillPage[],
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
