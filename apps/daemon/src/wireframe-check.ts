// wireframe-check.ts — deterministic post-run check for the `ux` stage.
//
// The ux skill TELLS the agent to validate its wireframes, but nothing makes it.
// This runs the SAME validator (`skills/ux-spec/scripts/validate-wire.mjs`, the
// one source of truth for the closed component vocabulary) after the run, so a
// wireframe with an unknown slug or a mistyped prop cannot pass silently into
// ux-review / ui-react.
//
// Deliberately NOT passed `--spec`: cross-checking screen ids against the spec
// would false-fail the per-module fan-out (the daemon merges the root spec after
// the module runs finish). Per-file structural validation only.
//
// Legacy v1 wireframes produce WARNINGS, never errors — old projects keep working.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface WireframeCheckResult {
  /** Directories scanned (relative to the pipeline cwd). */
  dirs: string[];
  errors: number;
  warnings: number;
  /** The validator's stdout, trimmed — already human-readable. */
  report: string;
}

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.od', '.odhistory', '.od-skills',
  'react', 'rn', 'prototype', 'ux-refs', 'docs',
]);

/** Find every `wireframes/` directory under `cwd` (depth ≤ 3). Wireframes live
 *  under the workflow folder (`<workflow>/wireframes/`), and multi-target builds
 *  add another level (`<workflow>/<target>/wireframes/`). */
export function findWireframeDirs(cwd: string, depth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, left: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.name === 'wireframes') found.push(full);
      else if (left > 0) walk(full, left - 1);
    }
  };
  if (fs.existsSync(path.join(cwd, 'wireframes'))) found.push(path.join(cwd, 'wireframes'));
  walk(cwd, depth);
  return [...new Set(found)];
}

function runValidator(script: string, dir: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += String(b); });
    child.stderr.on('data', (b) => { out += String(b); });
    child.on('error', () => resolve({ code: -1, out }));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
    // A wedged validator must never wedge the pipeline.
    setTimeout(() => { child.kill('SIGKILL'); }, 30_000).unref?.();
  });
}

/** Validate every wireframe under `cwd`. Returns null when there is nothing to
 *  check or the validator is unavailable — never throws, never blocks. */
export async function checkWireframes(cwd: string, skillsDir: string): Promise<WireframeCheckResult | null> {
  const script = path.join(skillsDir, 'ux-spec', 'scripts', 'validate-wire.mjs');
  if (!fs.existsSync(script)) return null;
  const dirs = findWireframeDirs(cwd);
  if (!dirs.length) return null;

  let errors = 0;
  let warnings = 0;
  const chunks: string[] = [];
  for (const dir of dirs) {
    const { code, out } = await runValidator(script, dir);
    if (code === -1) return null; // validator could not run — not the run's fault
    const tail = /(\d+) file · (\d+) lỗi · (\d+) cảnh báo/.exec(out);
    if (tail) {
      errors += Number(tail[2]);
      warnings += Number(tail[3]);
    }
    const body = out.trim();
    if (body) chunks.push(dirs.length > 1 ? `${path.relative(cwd, dir)}\n${body}` : body);
  }
  return { dirs: dirs.map((d) => path.relative(cwd, d)), errors, warnings, report: chunks.join('\n\n').trim() };
}

/** The chat message shown after a `ux` run whose wireframes did not validate. */
export function wireframeCheckMessage(result: WireframeCheckResult): string {
  const head = result.errors
    ? `⚠️ **Wireframe check: ${result.errors} lỗi** (${result.warnings} cảnh báo)`
    : `ℹ️ **Wireframe check: ${result.warnings} cảnh báo**`;
  const why = result.errors
    ? 'Những màn này sẽ render sai (badge đỏ `?slug`) và bước UI không dựng đúng component. ' +
      'Sửa file rồi chạy lại bước UX, hoặc sửa tay trong `wireframes/`.'
    : 'Không chặn — nhưng nên sửa để file lên đúng DSL v2.';
  return `${head}\n\n\`\`\`\n${result.report}\n\`\`\`\n\n${why}\n\nTừ vựng hợp lệ: \`skills/ux-spec/references/wire-components.md\`.`;
}
