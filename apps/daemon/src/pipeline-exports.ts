// Download-ready Markdown exports, generated AT PUSH TIME into `exports/`
// inside the project cwd and synced to the media store like any other file.
// Pipeline Studio streams `exports/<doc>.md` straight down — it renders
// nothing itself (its former on-demand renderers were retired with this).
//
// The renderers are deterministic (no LLM): the pushed JSON/HTML outputs are
// the single source of truth and re-pushing always regenerates the whole
// exports/ folder, so the MD can never go stale relative to the outputs.
//
// The only machine prerequisite is pandoc (ui-html pages → MD); od machines
// install it as part of setup (`brew install pandoc`). A missing binary fails
// the push with an actionable message rather than shipping a partial export.
//
// (History: these renderers lived in pipeline-studio's server — moved HERE
// 2026-07-10 when exports became a push-time artifact. Mirror of the shapes
// tolerated by studio's adapters: journeys may be `journeys | user_flows |
// flows`, stages `stages | steps`, screens `screens | screen_specs`.)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

export const EXPORTS_DIR = 'exports';

/* ── shared MD helpers ─────────────────────────────────────────────────── */

const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Escape a value for a Markdown table cell (pipes/newlines break rows). */
const cell = (v: unknown): string => {
  if (Array.isArray(v)) return v.map((x) => cell(x)).filter(Boolean).join('<br>');
  return s(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
};

/** Mermaid node label: quotes confuse the parser. */
const mmLabel = (v: unknown): string => s(v).replace(/"/g, "'").trim() || '…';

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '_(trống)_\n';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n') + '\n';
}

function metaLine(pairs: Array<[string, unknown]>): string {
  const parts = pairs
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : Boolean(s(v))))
    .map(([k, v]) => `**${k}:** ${cell(v)}`);
  return parts.length ? parts.join(' · ') + '\n' : '';
}

const squeeze = (out: string[]): string =>
  out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

/* ── Customer Journey (stage 2) ────────────────────────────────────────── */

export function renderCustomerJourneyMd(data: unknown, title = 'Customer Journey'): string {
  const d = (data ?? {}) as Record<string, unknown>;
  const personas = asArray(d.personas);
  const journeys = asArray(d.journeys ?? d.user_flows ?? d.flows);
  const out: string[] = [`# ${title}`, ''];

  if (personas.length) {
    out.push('## Personas', '');
    out.push(
      table(
        ['Persona', 'Nghề nghiệp / bối cảnh', 'Mục tiêu', 'Thiết bị', 'Mức độ rành công nghệ'],
        personas.map((p: any) => [
          cell(p?.name ?? p?.id),
          cell([p?.occupation, p?.context_of_use].filter(Boolean).join(' — ')),
          cell(p?.goals),
          cell(p?.device_primary),
          cell(p?.tech_savviness),
        ]),
      ),
    );
  }

  if (journeys.length === 0) {
    out.push('_Chưa có journey nào trong dữ liệu._', '');
  }

  journeys.forEach((j: any, idx: number) => {
    const stages = asArray(j?.stages ?? j?.steps);
    out.push(`## ${idx + 1}. ${s(j?.name ?? j?.title) || `Journey ${idx + 1}`}`, '');
    out.push(
      metaLine([
        ['Mục tiêu', j?.goal],
        ['Actor', j?.actor_id ?? j?.actor],
        ['Loại luồng', j?.flow_type ?? j?.journey_mode],
      ]),
    );

    if (stages.length) {
      // Sơ đồ tổng quan các bước — Mermaid render được trên GitHub/GitLab,
      // studio và Confluence (có plugin).
      out.push('```mermaid');
      out.push('flowchart LR');
      stages.forEach((st: any, i: number) => {
        out.push(`  S${i}["${mmLabel(st?.name ?? `Bước ${i + 1}`)}"]`);
        if (i > 0) out.push(`  S${i - 1} --> S${i}`);
      });
      out.push('```', '');

      out.push(
        table(
          ['#', 'Giai đoạn', 'Mục tiêu', 'Hành động của user', 'Hệ thống phản hồi', 'Touchpoint', 'Pain point', 'Cảm xúc'],
          stages.map((st: any, i: number) => [
            s(st?.order ?? i + 1),
            cell(st?.name),
            cell(st?.goal),
            cell(st?.user_actions),
            cell(st?.system_responses),
            cell(st?.touchpoints),
            cell(st?.pain_points),
            cell(st?.emotion),
          ]),
        ),
      );
    }
    out.push('');
  });

  return squeeze(out);
}

/* ── UX Spec (stage 3) ─────────────────────────────────────────────────── */

export function renderUxSpecMd(data: unknown, title = 'UX Spec'): string {
  const d = (data ?? {}) as Record<string, unknown>;
  const screens = asArray(d.screens ?? d.screen_specs);
  const out: string[] = [`# ${title}`, ''];

  if (screens.length === 0) {
    out.push('_Chưa có màn hình nào trong dữ liệu._', '');
    return out.join('\n');
  }

  // Mục lục nhóm theo navigation_group để đọc lướt được cấu trúc IA.
  const groups = new Map<string, any[]>();
  for (const sc of screens) {
    const g = s((sc as any)?.navigation_group) || 'Khác';
    groups.set(g, [...(groups.get(g) ?? []), sc]);
  }
  out.push('## Tổng quan', '');
  out.push(
    table(
      ['Nhóm điều hướng', 'Màn hình'],
      [...groups.entries()].map(([g, list]) => [
        cell(g),
        cell(list.map((sc: any) => s(sc?.name ?? sc?.id))),
      ]),
    ),
  );

  screens.forEach((sc: any, idx: number) => {
    out.push(`## ${idx + 1}. ${s(sc?.name) || s(sc?.id) || `Màn hình ${idx + 1}`}`, '');
    out.push(
      metaLine([
        ['Mã', sc?.id],
        ['Loại', sc?.screen_type],
        ['Layout', sc?.layout],
        ['Actor', sc?.primary_actor],
        ['Quyền', sc?.permissions],
        ['Nhóm', sc?.navigation_group],
      ]),
    );
    if (s(sc?.screen_intent)) out.push(`> ${cell(sc.screen_intent)}`, '');

    const comps = asArray(sc?.components);
    if (comps.length) {
      out.push(
        table(
          ['#', 'Loại component', 'Label', 'Bắt buộc', 'Semantic'],
          comps.map((c: any, i: number) => [
            s(c?.order ?? i + 1),
            cell(c?.component_type),
            cell(c?.label),
            c?.required === true ? '✓' : '',
            cell(c?.semantic_type),
          ]),
        ),
      );
    }
    out.push('');
  });

  return squeeze(out);
}

/* ── UI-Spec HTML (terminal ui-html) — pandoc html→gfm ─────────────────── */

const PANDOC_TIMEOUT_MS = 30_000;

/** Run pandoc html→gfm over stdin/stdout. Rejects with an actionable message
 *  when the binary is missing (the one machine prerequisite here). */
export function pandocHtmlToMd(html: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('pandoc', ['-f', 'html', '-t', 'gfm-raw_html', '--wrap=none'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`pandoc quá ${PANDOC_TIMEOUT_MS / 1000}s — file HTML quá lớn?`));
    }, PANDOC_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === 'ENOENT'
          ? new Error('pandoc chưa được cài trên máy này — cài bằng `brew install pandoc` rồi push lại')
          : e,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`pandoc exit ${code}: ${err.slice(0, 300)}`));
    });
    child.stdin.on('error', () => {}); // EPIPE when pandoc dies first — close handler reports
    child.stdin.end(html);
  });
}

/** Inline SVG icons would otherwise come out of pandoc as giant base64
 *  data-URI images — pure noise in a text document. Strip them up front. */
const stripSvg = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/gi, '');

interface HtmlScreenInput {
  name: string;
  path: string;
  html: string;
}

export async function renderUiHtmlMd(screens: HtmlScreenInput[], title = 'UI-SPEC HTML'): Promise<string> {
  const out: string[] = [`# ${title}`, ''];
  out.push(
    table(
      ['#', 'Màn hình', 'File'],
      screens.map((sc, i) => [String(i + 1), cell(sc.name), `\`${sc.path}\``]),
    ),
  );
  // Sequential on purpose: one pandoc process at a time keeps the machine tame
  // when someone pushes a 20-screen project.
  for (const [i, sc] of screens.entries()) {
    out.push('', '---', '', `## ${i + 1}. ${sc.name}`, '', `\`${sc.path}\``, '');
    const md = (await pandocHtmlToMd(stripSvg(sc.html))).trim();
    // Demote the page's own headings two levels so its h1 lands under the
    // `## n. <screen>` section heading instead of colliding with it.
    out.push(md.replace(/^(#{1,4}) /gm, '##$1 ') || '_(pandoc không trích được nội dung nào từ trang này)_');
  }
  return squeeze(out);
}

/* ── UI-Spec React (terminal ui-react) — the project's SOURCE CODE as a ZIP
   of MD files. One `<path>.md` per agent-authored file, mirroring the source
   tree (`src/screens/home.tsx` → `src/screens/home.tsx.md`), plus `_index.md`
   with the file table. Each MD is the code VERBATIM in a fenced block — a
   text wrap, not a re-render. Template scaffold (src/components/ui/,
   src/lib/, configs) is boilerplate identical across projects — excluded,
   mirroring what syncExclude ships to the store. */

interface SourceFileInput {
  /** react/-relative path, e.g. `src/screens/home.tsx`. */
  path: string;
  content: string;
}

const CODE_LANG: Record<string, string> = {
  '.tsx': 'tsx',
  '.ts': 'ts',
  '.jsx': 'jsx',
  '.js': 'js',
  '.css': 'css',
  '.json': 'json',
  '.html': 'html',
  '.md': 'md',
};

/** A fence longer than any backtick run inside the code — content can never
 *  break out of its block. */
const fenceFor = (code: string): string => {
  const longest = (code.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
};

/** `_index.md` at the zip root: what's inside + what was left out. */
function renderSourceIndexMd(
  files: SourceFileInput[],
  skipped: Array<{ path: string; reason: string }>,
  title: string,
): string {
  const out: string[] = [`# ${title}`, ''];
  out.push('Mỗi file code là một file `.md` cùng đường dẫn (`<path>.md`), nội dung nguyên văn.', '');
  out.push(
    table(
      ['#', 'File', 'Dòng', 'Kích thước'],
      files.map((f, i) => [
        String(i + 1),
        `\`${f.path}.md\``,
        String(f.content.split('\n').length),
        `${(Buffer.byteLength(f.content, 'utf8') / 1024).toFixed(1)} KB`,
      ]),
    ),
  );
  if (skipped.length) {
    out.push('', '_Bỏ qua (không phải file text hoặc quá lớn):_', '');
    for (const sk of skipped) out.push(`- \`${sk.path}\` — ${sk.reason}`);
  }
  return out.join('\n').trimEnd() + '\n';
}

/** One source file → one MD: heading + the code VERBATIM in a fenced block.
 *  No squeeze/reformat anywhere — the code must round-trip byte-for-byte. */
function renderSourceFileMd(f: SourceFileInput): string {
  const lang = CODE_LANG[path.extname(f.path).toLowerCase()] ?? '';
  const fence = fenceFor(f.content);
  return [`# \`${f.path}\``, '', `${fence}${lang}`, f.content.replace(/\n$/, ''), fence].join('\n') + '\n';
}

/** The ui-react export artifact: a zip mirroring the source tree as MD files.
 *  Entry dates are pinned so the SAME sources produce the SAME bytes — the
 *  content-hash push (syncProjectFiles) then skips unchanged re-uploads. */
export async function buildUiReactSourceZip(
  files: SourceFileInput[],
  skipped: Array<{ path: string; reason: string }>,
  title = 'UI-SPEC (ReactJS)',
): Promise<Buffer> {
  const zip = new JSZip();
  const epoch = new Date(0);
  zip.file('_index.md', renderSourceIndexMd(files, skipped, title), { date: epoch });
  for (const f of files) zip.file(`${f.path}.md`, renderSourceFileMd(f), { date: epoch });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/* ── source discovery + generation ─────────────────────────────────────── */

const isCustomerJourneyJson = (rel: string): boolean =>
  /(customer-journey|[-_]cj|[-_]journey)\.json$/i.test(rel) ||
  /(^|\/)(customer-journey|cj)\/[^/]+\.json$/i.test(rel);

const isUxSpecJson = (rel: string): boolean =>
  /ux-spec\.json$/i.test(rel) || /(^|\/)ux\/[^/]+\.json$/i.test(rel);

/** "chuyen-tien_noi-bo.html" → "Chuyen tien noi bo". */
const prettyScreenName = (file: string): string => {
  const base = path.basename(file).replace(/\.html?$/i, '');
  const words = base.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : base;
};

const listDir = async (dir: string): Promise<string[]> =>
  fs.promises.readdir(dir).catch(() => [] as string[]);

const readJson = async (file: string): Promise<unknown | null> => {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null; // absent or corrupt → the doc is simply skipped
  }
};

// Where a project's outputs may live: the merged workflow folder, plus the
// retired twin folders old checkouts still carry (mirrors LEGACY_WORKFLOW_DIRS
// in pipelines.ts). First folder that has a given source wins.
const SOURCE_DIRS = ['docs-to-ui', 'docs-to-html', 'docs-to-react'];

/**
 * Regenerate `<cwd>/exports/` — the download-ready set Pipeline Studio
 * streams per doc: customer-journey.md, ux-spec.md, ui-html.md, ui-react.zip
 * (zip of per-file MD mirroring the React source tree).
 * Always starts from an empty folder (a stale export must not outlive the
 * output it was rendered from); only docs whose source exists are written.
 * Returns the cwd-relative paths written. Throws when prototype pages exist
 * but pandoc does not — a partial export set would silently lie downstream.
 */
export async function generateProjectExports(cwd: string, projectId: string): Promise<string[]> {
  const exportsAbs = path.join(cwd, EXPORTS_DIR);
  await fs.promises.rm(exportsAbs, { recursive: true, force: true });

  // ── discover sources across candidate workflow folders ──
  let cjFile: string | null = null;
  let uxFile: string | null = null;
  let protoDir: string | null = null;
  let reactDir: string | null = null;
  for (const wf of SOURCE_DIRS) {
    const wfAbs = path.join(cwd, wf);
    const rootJson = (await listDir(wfAbs)).filter((n) => n.endsWith('.json')).sort();
    if (!cjFile) {
      const hit =
        rootJson.find((n) => isCustomerJourneyJson(n)) ??
        (await listDir(path.join(wfAbs, 'cj'))).sort().find((n) => n.endsWith('.json')) ??
        (await listDir(path.join(wfAbs, 'customer-journey'))).sort().find((n) => n.endsWith('.json'));
      if (hit) {
        cjFile = rootJson.includes(hit)
          ? path.join(wfAbs, hit)
          : path.join(wfAbs, (await listDir(path.join(wfAbs, 'cj'))).includes(hit) ? 'cj' : 'customer-journey', hit);
      }
    }
    if (!uxFile) {
      const hit =
        rootJson.find((n) => isUxSpecJson(n)) ??
        (await listDir(path.join(wfAbs, 'ux'))).sort().find((n) => n.endsWith('.json'));
      if (hit) {
        uxFile = rootJson.includes(hit) ? path.join(wfAbs, hit) : path.join(wfAbs, 'ux', hit);
      }
    }
    if (!protoDir && (await listDir(path.join(wfAbs, 'prototype'))).some((n) => /\.html?$/i.test(n))) {
      protoDir = path.join(wfAbs, 'prototype');
    }
    if (!reactDir && (await listDir(path.join(wfAbs, 'react'))).length > 0) {
      reactDir = path.join(wfAbs, 'react');
    }
  }

  const written: string[] = [];
  const write = async (name: string, content: string | Buffer) => {
    await fs.promises.mkdir(exportsAbs, { recursive: true });
    await fs.promises.writeFile(path.join(exportsAbs, name), content);
    written.push(`${EXPORTS_DIR}/${name}`);
  };

  // ── 2. Customer Journey ──
  const cjJson = cjFile ? await readJson(cjFile) : null;
  if (cjJson) await write('customer-journey.md', renderCustomerJourneyMd(cjJson, `Customer Journey — ${projectId}`));

  // ── 3. UX Spec ──
  const uxJson = uxFile ? await readJson(uxFile) : null;
  if (uxJson) await write('ux-spec.md', renderUxSpecMd(uxJson, `UX Spec — ${projectId}`));

  // ── 4a. UI-Spec HTML (pandoc) ──
  if (protoDir) {
    const pages = (await listDir(protoDir))
      .filter((n) => /\.html?$/i.test(n))
      // index/home first, then alphabetical — mirrors the studio panel order.
      .sort((a, b) => {
        const rank = (n: string) => (/index|home|entry/i.test(n) ? 0 : 1);
        return rank(a) - rank(b) || a.localeCompare(b);
      });
    const screens: HtmlScreenInput[] = [];
    for (const n of pages) {
      screens.push({
        name: prettyScreenName(n),
        path: `prototype/${n}`,
        html: await fs.promises.readFile(path.join(protoDir, n), 'utf8'),
      });
    }
    await write('ui-html.md', await renderUiHtmlMd(screens, `UI-SPEC HTML — ${projectId}`));
  }

  // ── 4b. UI-Spec React: the source tree as a zip of MD files ──
  if (reactDir) {
    const sources = await collectReactSources(reactDir);
    if (sources.files.length) {
      await write(
        'ui-react.zip',
        await buildUiReactSourceZip(sources.files, sources.skipped, `UI-SPEC (ReactJS) — ${projectId}`),
      );
    }
  }

  return written;
}

/** Max size for a single source file in the MD — anything above is listed as
 *  skipped instead of silently ballooning the export. */
const SOURCE_FILE_CAP = 200 * 1024;

// The agent-authored source set, in a stable, diff-friendly order. Template
// scaffold (src/components/ui/, src/lib/) and configs are deliberately absent
// — identical boilerplate across every project.
async function collectReactSources(reactDir: string): Promise<{
  files: SourceFileInput[];
  skipped: Array<{ path: string; reason: string }>;
}> {
  const rels: string[] = [];
  for (const n of ['src/App.tsx', 'src/main.tsx', 'src/index.css', 'flow.json']) {
    if (await fs.promises.stat(path.join(reactDir, n)).then((st) => st.isFile(), () => false)) rels.push(n);
  }
  rels.push(...(await listDir(path.join(reactDir, 'src', 'screens'))).sort().map((n) => `src/screens/${n}`));
  // components/app may nest (per-use-case folders) — walk it recursively.
  const walkApp = async (rel: string): Promise<void> => {
    for (const n of (await listDir(path.join(reactDir, rel))).sort()) {
      const sub = `${rel}/${n}`;
      const st = await fs.promises.stat(path.join(reactDir, sub)).catch(() => null);
      if (st?.isDirectory()) await walkApp(sub);
      else if (st?.isFile()) rels.push(sub);
    }
  };
  await walkApp('src/components/app');

  const files: SourceFileInput[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const rel of rels) {
    if (!(path.extname(rel).toLowerCase() in CODE_LANG)) {
      skipped.push({ path: rel, reason: 'không phải file text/code' });
      continue;
    }
    const st = await fs.promises.stat(path.join(reactDir, rel)).catch(() => null);
    if (!st?.isFile()) continue;
    if (st.size > SOURCE_FILE_CAP) {
      skipped.push({ path: rel, reason: `quá lớn (${Math.round(st.size / 1024)} KB)` });
      continue;
    }
    files.push({ path: rel, content: await fs.promises.readFile(path.join(reactDir, rel), 'utf8') });
  }
  return { files, skipped };
}
