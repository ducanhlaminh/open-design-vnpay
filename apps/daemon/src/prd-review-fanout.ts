// PRD Mockup Review — per-page PARALLEL fan-out helpers.
//
// The prd-review stage reviews every mockup embedded in the ingested Confluence
// docs. With a whole sub-tree of dozens of pages, one agent reviewing hundreds
// of images is slow and context-bound, so the daemon fans out: one agent run
// PER PAGE (bounded concurrency), each writing its own review/<slug>/report.json,
// then the daemon deterministically merges those into review/index.json +
// review/summary.md (no LLM needed for the aggregation).
//
// This module holds the PURE, unit-testable pieces: which pages have mockups,
// the stable page slug, and the merge. The run-lifecycle orchestration lives in
// server.ts (it needs the design.runs machinery).

import { promises as fs } from 'node:fs';
import path from 'node:path';

export type Verdict = 'pass' | 'warn' | 'fail';

/** A doc page that carries at least one mockup image → one fan-out unit. */
export interface MockupPage {
  /** Page md path relative to the run cwd, e.g. docs/confluence/i-tai-khoan/1.md */
  mdPath: string;
  /** Stable slug: docs/confluence/ prefix stripped, '/'→'__', '.md' dropped. */
  slug: string;
  /** Page title (from the md frontmatter `title:`), fallback to the file stem. */
  page: string;
  /** How many embedded mockup image refs the page has (for logging/summary). */
  mockupCount: number;
}

/** Stable per-page slug — MUST match the skill's convention so re-runs and
 *  manual edits line up. `docs/confluence/i-tai-khoan/1-thiet-lap.md`
 *  → `i-tai-khoan__1-thiet-lap`. A path already stripped of the prefix (or a
 *  bare name) still slugifies sensibly. */
export function pageSlug(mdRelPath: string): string {
  const norm = mdRelPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const noPrefix = norm.replace(/^docs\/confluence\//, '');
  return noPrefix.replace(/\.md$/i, '').replace(/\//g, '__');
}

/** A markdown image ref whose target sits under an `attachments/` folder — the
 *  shape localizeConfluenceImages emits for every downloaded mockup. */
const MOCKUP_REF_RE = /!\[[^\]]*\]\([^)]*attachments\/[^)]+\)/g;

function titleFromFrontmatter(md: string, fallback: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (m) {
    const t = /^title:\s*(.+)$/m.exec(m[1]!);
    if (t?.[1]) return t[1].trim();
  }
  return fallback;
}

/** Recursively list every markdown page under `docs/confluence/` (excluding
 *  the _index.md companion and anything under attachments/) that embeds ≥1
 *  mockup image. */
export async function listMockupPages(cwd: string): Promise<MockupPage[]> {
  const root = path.join(cwd, 'docs', 'confluence');
  const out: MockupPage[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'attachments') continue;
        await walk(abs);
        continue;
      }
      if (!e.name.toLowerCase().endsWith('.md') || e.name.toLowerCase() === '_index.md') continue;
      const md = await fs.readFile(abs, 'utf8').catch(() => '');
      const mockupCount = (md.match(MOCKUP_REF_RE) ?? []).length;
      if (mockupCount === 0) continue;
      const mdPath = path.relative(cwd, abs).replace(/\\/g, '/');
      out.push({
        mdPath,
        slug: pageSlug(mdPath),
        page: titleFromFrontmatter(md, path.basename(e.name, path.extname(e.name))),
        mockupCount,
      });
    }
  };
  await walk(root);
  // Deterministic order (path) so re-runs and the index are stable.
  out.sort((a, b) => a.mdPath.localeCompare(b.mdPath));
  return out;
}

const asVerdict = (v: unknown): Verdict => (v === 'fail' || v === 'warn' ? v : 'pass');

/** Recompute a page's counts/score/verdict from its images — the daemon owns
 *  the roll-up so a page report with a stale/missing summary still aggregates
 *  correctly. Same arithmetic as the skill (blocker −25 / major −10 / minor −3,
 *  verdict fail if any blocker or <60, warn 60–84, pass ≥85; page verdict =
 *  worst image, page score = mean image score). */
export function scorePageReport(report: unknown): {
  images: number;
  blockers: number;
  majors: number;
  minors: number;
  score: number;
  verdict: Verdict;
} {
  // Score SCREEN mockups only — 'diagram' images (draw.io / flowcharts) are flow
  // reference context, never graded, so they don't enter the count or the mean.
  const all = Array.isArray((report as any)?.images) ? (report as any).images : [];
  const images = all.filter((im: any) => im?.kind !== 'diagram');
  let blockers = 0;
  let majors = 0;
  let minors = 0;
  const scores: number[] = [];
  let worst: Verdict = 'pass';
  for (const im of images) {
    const findings = Array.isArray(im?.findings) ? im.findings : [];
    let deduction = 0;
    for (const f of findings) {
      if (f?.severity === 'blocker') { blockers += 1; deduction += 25; }
      else if (f?.severity === 'major') { majors += 1; deduction += 10; }
      else if (f?.severity === 'minor') { minors += 1; deduction += 3; }
    }
    const s = Math.max(0, 100 - deduction);
    scores.push(s);
    const hasBlocker = findings.some((f: any) => f?.severity === 'blocker');
    const v: Verdict = hasBlocker || s < 60 ? 'fail' : s < 85 ? 'warn' : 'pass';
    if (v === 'fail') worst = 'fail';
    else if (v === 'warn' && worst !== 'fail') worst = 'warn';
  }
  const score = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  return { images: images.length, blockers, majors, minors, score, verdict: worst };
}

export interface MergedPage {
  slug: string;
  page: string;
  page_path: string;
  report: string;
  images: number;
  score: number;
  verdict: Verdict;
  blockers: number;
  majors: number;
  minors: number;
}

/** Merge per-page reports into the index.json manifest + a human summary.md.
 *  `pages` pairs each fan-out unit with the JSON its agent wrote (null when the
 *  page's run failed / wrote nothing — it still appears, marked failed, so a
 *  broken page is visible rather than silently dropped). */
export function mergePageReports(
  pages: Array<{ slug: string; page: string; mdPath: string; report: unknown | null }>,
): { index: object; summaryMd: string } {
  const merged: MergedPage[] = pages.map((p) => {
    if (!p.report) {
      return { slug: p.slug, page: p.page, page_path: p.mdPath, report: `${p.slug}/report.json`, images: 0, score: 0, verdict: 'fail' as Verdict, blockers: 0, majors: 0, minors: 0 };
    }
    const r = scorePageReport(p.report);
    return { slug: p.slug, page: p.page, page_path: p.mdPath, report: `${p.slug}/report.json`, ...r };
  });
  const rank: Record<Verdict, number> = { fail: 0, warn: 1, pass: 2 };
  merged.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.page_path.localeCompare(b.page_path));
  const images = merged.reduce((n, p) => n + p.images, 0);
  const blockers = merged.reduce((n, p) => n + p.blockers, 0);
  const majors = merged.reduce((n, p) => n + p.majors, 0);
  const minors = merged.reduce((n, p) => n + p.minors, 0);
  const verdict: Verdict = merged.some((p) => p.verdict === 'fail')
    ? 'fail'
    : merged.some((p) => p.verdict === 'warn')
      ? 'warn'
      : 'pass';
  const score = merged.length ? Math.round(merged.reduce((n, p) => n + p.score, 0) / merged.length) : 0;
  const index = {
    schema_version: '1.1',
    kind: 'docs-mockup-review-index',
    summary: { images, score, verdict, blockers, majors, minors },
    pages: merged,
  };
  const vLabel = (v: Verdict) => (v === 'fail' ? 'Chưa đạt' : v === 'warn' ? 'Cảnh báo' : 'Đạt');
  let summaryMd = `# PRD Mockup Review — ${vLabel(verdict)} (${score}/100)\n\n`;
  summaryMd += `${merged.length} trang · ${images} mockup · ${blockers} nghiêm trọng · ${majors} nặng · ${minors} nhẹ\n\n`;
  summaryMd += `| Trang | Mockup | Điểm | Kết luận | NT | Nặng |\n| --- | --- | --- | --- | --- | --- |\n`;
  for (const p of merged) {
    summaryMd += `| ${p.page} | ${p.images} | ${p.score} | ${vLabel(p.verdict)} | ${p.blockers} | ${p.majors} |\n`;
  }
  return { index, summaryMd };
}
