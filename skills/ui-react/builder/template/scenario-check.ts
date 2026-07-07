// scenario-check — the build-gate validator for the scenarios.json contract.
//
// Run by builder/build.sh AFTER `tsc && vite build` (both sandbox and docker
// backends, Node 24 type-stripping — keep this file plain types-only TS: no
// enums/namespaces). It mechanically enforces that every agent-authored
// use-case script can actually replay against the authored screens:
//
//   - step.route / step.expect resolve to a real screen route (`/<slug>`),
//   - step.action of the form [data-flow-action='X'] has a matching
//     data-flow-action="X" annotation somewhere in src/,
//   - fills[].selector (#id / [name='x']) resolves to an authored id/name.
//
// A violation FAILS the build with the exact list — the agent's normal
// build→red→fix loop then repairs the drift before the run can finish.
// No scenarios.json (the seed baseline) → silently skipped.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const scnPath = path.join(root, 'scenarios.json');
if (!existsSync(scnPath)) {
  console.log('[scenario-check] no scenarios.json — skipped (required before the run is done)');
  process.exit(0);
}

type Fill = { selector?: string; value?: string };
type Step = { route?: string; action?: string; label?: string; fills?: Fill[]; expect?: string };
type Scenario = { id?: string; name?: string; steps?: Step[] };

let scenarios: Scenario[];
try {
  scenarios = JSON.parse(readFileSync(scnPath, 'utf8'));
} catch (err) {
  console.error(`[scenario-check] scenarios.json is not valid JSON: ${(err as Error).message}`);
  process.exit(1);
}
if (!Array.isArray(scenarios) || scenarios.length === 0) {
  console.error('[scenario-check] scenarios.json must be a non-empty array of scenarios');
  process.exit(1);
}

// ── collect ground truth from the authored source ────────────────────────────
const srcFiles: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(entry)) srcFiles.push(p);
  }
};
const srcDir = path.join(root, 'src');
if (existsSync(srcDir)) walk(srcDir);
const source = srcFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

const actions = new Set<string>();
for (const m of source.matchAll(
  /data-flow-action\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["']([^"']*)["']\s*\})/g,
)) {
  actions.add((m[1] ?? m[2] ?? m[3] ?? '').trim());
}
const ids = new Set<string>();
for (const m of source.matchAll(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["']([^"']*)["']\s*\})/g)) {
  ids.add((m[1] ?? m[2] ?? m[3] ?? '').trim());
}
const names = new Set<string>();
for (const m of source.matchAll(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
  names.add((m[1] ?? m[2] ?? '').trim());
}
const routes = new Set<string>(['/']);
const screensDir = path.join(srcDir, 'screens');
if (existsSync(screensDir)) {
  for (const f of readdirSync(screensDir)) {
    if (/\.tsx$/.test(f)) routes.add(`/${f.replace(/\.tsx$/, '')}`);
  }
}

// ── validate every step ───────────────────────────────────────────────────────
const errors: string[] = [];
const normRoute = (r: string) => {
  const t = r.trim().split('?')[0] ?? '';
  if (!t || t === '/') return '/';
  return (t.startsWith('/') ? t : `/${t}`).replace(/\/+$/, '');
};

scenarios.forEach((sc, si) => {
  const where = (k: number) => `scenario ${si + 1} "${sc.name ?? sc.id ?? '?'}" step ${k + 1}`;
  if (!Array.isArray(sc.steps) || sc.steps.length === 0) {
    errors.push(`scenario ${si + 1} "${sc.name ?? '?'}": no steps`);
    return;
  }
  sc.steps.forEach((st, k) => {
    for (const [field, value] of [
      ['route', st.route],
      ['expect', st.expect],
    ] as const) {
      if (value === undefined) continue;
      if (typeof value !== 'string' || !routes.has(normRoute(value))) {
        errors.push(`${where(k)}: ${field} "${value}" is not a screen route (expected /<slug> of src/screens/*)`);
      }
    }
    if (st.action !== undefined) {
      const m = /^\[data-flow-action=['"](.+)['"]\]$/.exec(st.action.trim());
      if (m) {
        const label = m[1]!.trim();
        if (!actions.has(label)) {
          errors.push(
            `${where(k)}: action targets data-flow-action='${label}' but NO element in src/ carries that annotation — annotate the control or fix the scenario`,
          );
        }
      } else if (st.action.trim().startsWith('#')) {
        const id = st.action.trim().slice(1);
        if (!ids.has(id)) errors.push(`${where(k)}: action "#${id}" — no element with id="${id}" in src/`);
      } else {
        errors.push(
          `${where(k)}: action "${st.action}" is not verifiable — use [data-flow-action='<label>'] (preferred) or #id`,
        );
      }
    }
    for (const f of st.fills ?? []) {
      const sel = (f.selector ?? '').trim();
      if (sel.startsWith('#')) {
        if (!ids.has(sel.slice(1))) errors.push(`${where(k)}: fill "${sel}" — no element with that id in src/`);
      } else {
        const nm = /^\[name=['"](.+)['"]\]$/.exec(sel);
        if (nm) {
          if (!names.has(nm[1]!)) errors.push(`${where(k)}: fill "${sel}" — no element with that name in src/`);
        } else {
          errors.push(`${where(k)}: fill selector "${sel}" is not verifiable — use #id or [name='…']`);
        }
      }
    }
  });
});

if (errors.length > 0) {
  console.error(`[scenario-check] ${errors.length} contract violation(s) between scenarios.json and src/:`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('[scenario-check] fix the screens (add the annotations) or the scenarios, then rebuild.');
  process.exit(1);
}
console.log(`[scenario-check] OK — ${scenarios.length} scenario(s) verified against src/`);
