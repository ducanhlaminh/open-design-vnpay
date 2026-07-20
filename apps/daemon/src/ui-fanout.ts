// docs-to-ui — per-SCREEN parallel fan-out helpers (ux-review + ui-html).
//
// The ux-spec stage authors many screens (one per doc section that needs UI).
// Reviewing them (heuristic-eval) and rendering them (html prototype) are both
// PER-SCREEN independent work — a screen's review/render doesn't need any other
// screen — so the daemon fans these two stages out one agent run per screen
// (bounded pool), each writing its own slice, then the daemon assembles the
// canonical output (a merged review report / an index.html hub).
//
// This module holds the PURE pieces: the screen list (parsed from the UX spec),
// the stable slug, the review merge, and the prototype hub. Orchestration lives
// in server.ts.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export type Verdict = 'pass' | 'warn' | 'fail';

export interface UiScreen {
  /** Spec screen id (VERBATIM — heuristic report + wireframe files key on it). */
  id: string;
  /** Human-readable name for logs / the prototype hub. */
  name: string;
  /** Kebab-case slug for per-screen files (prototype/<slug>.html, review/<slug>). */
  slug: string;
}

/** Stable per-screen slug — id lowercased/kebab-cased (matches the html + review
 *  skills' `<slug>` convention). */
export function screenSlug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'screen';
}

/** The UX spec's screen list. Finds the `-ux-spec.json` at the cwd root (the
 *  ux-spec stage's canonical output), parses its `screens[]`, and returns each
 *  screen's id + name + slug. Overlay/dialog screens (whose id another screen
 *  references via `overlay_of`) are kept — the caller decides; keeping them is
 *  safe for review and the html skill itself folds overlays into their host. */
export async function listScreens(cwd: string): Promise<UiScreen[]> {
  const entries = await fs.readdir(cwd).catch(() => [] as string[]);
  const specName = entries.find((n) => /-ux-spec\.json$/i.test(n));
  if (!specName) return [];
  const raw = await fs.readFile(path.join(cwd, specName), 'utf8').catch(() => '');
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const screens = Array.isArray(json?.screens) ? json.screens : [];
  const out: UiScreen[] = [];
  const seen = new Set<string>();
  for (const s of screens) {
    const id = typeof s?.id === 'string' ? s.id : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name =
      (typeof s?.name === 'string' && s.name) ||
      (typeof s?.screen_name === 'string' && s.screen_name) ||
      (typeof s?.screen_type === 'string' && s.screen_type) ||
      id;
    out.push({ id, name, slug: screenSlug(id) });
  }
  return out;
}

const asVerdict = (v: unknown): Verdict => (v === 'fail' || v === 'warn' ? v : 'pass');

/** Merge per-screen heuristic-review slices into the canonical
 *  heuristic-review/report.json (screens[] concatenated, summary recomputed).
 *  Each per-screen report is the same schema scoped to ONE screen, so its
 *  `screens[]` holds a single entry; a screen whose run wrote nothing is added
 *  as a failed placeholder so a broken screen stays visible. */
export function mergeHeuristicScreens(
  slices: Array<{ id: string; name: string; report: any | null }>,
): object {
  const screens: any[] = [];
  let blockers = 0;
  let majors = 0;
  let minors = 0;
  const scores: number[] = [];
  let worst: Verdict = 'pass';
  for (const s of slices) {
    const rows: any[] = Array.isArray(s.report?.screens) ? s.report.screens : [];
    const row =
      rows.find((r) => r?.screen === s.id) ??
      rows[0] ??
      // Fallback: the run wrote a bare single-screen object, or nothing.
      (s.report && typeof s.report === 'object' && 'findings' in s.report ? s.report : null);
    if (!row) {
      screens.push({ screen: s.id, screen_name: s.name, score: 0, verdict: 'fail', findings: [], passes: [] });
      worst = 'fail';
      scores.push(0);
      continue;
    }
    const findings: any[] = Array.isArray(row.findings) ? row.findings : [];
    let b = 0;
    let mj = 0;
    let mn = 0;
    let deduction = 0;
    for (const f of findings) {
      if (f?.severity === 'blocker') { b += 1; deduction += 25; }
      else if (f?.severity === 'major') { mj += 1; deduction += 10; }
      else if (f?.severity === 'minor') { mn += 1; deduction += 3; }
    }
    blockers += b;
    majors += mj;
    minors += mn;
    const score = typeof row.score === 'number' ? row.score : Math.max(0, 100 - deduction);
    scores.push(score);
    const hasBlocker = findings.some((f) => f?.severity === 'blocker');
    const v: Verdict = row.verdict ? asVerdict(row.verdict) : hasBlocker || score < 60 ? 'fail' : score < 85 ? 'warn' : 'pass';
    if (v === 'fail') worst = 'fail';
    else if (v === 'warn' && worst !== 'fail') worst = 'warn';
    screens.push({ ...row, screen: s.id, screen_name: row.screen_name ?? s.name });
  }
  const score = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  return {
    schema_version: '1.0',
    $comment: 'Merged per-screen heuristic review (daemon fan-out).',
    summary: { screens: screens.length, score, verdict: worst, blockers, majors, minors },
    screens,
  };
}

/** The prototype hub linking every rendered screen — a deterministic index the
 *  daemon writes so the per-screen html runs never race on one shared file. */
export function renderPrototypeIndex(screens: UiScreen[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const items = screens
    .map((s) => `      <li><a href="./${esc(s.slug)}.html">${esc(s.name)}</a> <code>${esc(s.id)}</code></li>`)
    .join('\n');
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Prototype — ${screens.length} màn hình</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 20px; }
    ul { list-style: none; padding: 0; }
    li { padding: 10px 12px; border: 1px solid #e1e5eb; border-radius: 10px; margin: 8px 0; display: flex; align-items: center; gap: 10px; }
    a { font-weight: 600; color: #0066b3; text-decoration: none; }
    code { margin-left: auto; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <h1>Prototype — ${screens.length} màn hình</h1>
  <ul>
${items}
  </ul>
</body>
</html>
`;
}
