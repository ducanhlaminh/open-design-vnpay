// `dr-flow` (skill docs-flow-ux) — the two deterministic halves around the
// agent run of the "Đánh giá luồng UX" stage of `docs-review`.
//
//   prepareFlowUxInputs(cwd)  — BEFORE the agent: find every flow diagram the
//     ingested docs carry (draw.io pages, Mermaid), decode it, and lay it out
//     under `flows/<FLOW-ID>/` as plain files the agent can read (`as-is.drawio`
//     / `as-is.mmd`, `cells.json`), plus `flows/_inputs.json` listing them.
//
//   finalizeFlowUx(cwd)       — AFTER the agent: apply `patch.json` → the
//     colour-coded `proposed.drawio` (2 pages: Hiện trạng | Đề xuất), derive
//     `flows/<FLOW-ID>.flowchart.json` (frozen schema dr-comp / dr-review read)
//     from the SOURCE diagram + the agent's `screens.json`, validate
//     `ux-review.json`, and rebuild `flows/index.json`.
//
// The agent never touches XML and never writes the index: it reads, judges,
// and emits small JSON files. Everything file-shaped is produced here.

import fs from 'node:fs';
import path from 'node:path';

import { decodeMxfile, encodeMxfile, listCells, type MxPage } from './mxfile.js';
import { applyPatch, parsePatchDoc, type PatchOp } from './patch.js';
import { drawioPageToFlowchart, mermaidToFlowchart, resolveScreenCells, type FlowchartDoc } from './to-flowchart.js';
import { svgForImgEmbedding } from '../bas/svg-xml.js';
import { findEmbeddedMermaid, isMermaidFlowchart, looksLikeMermaid, replaceCreateViewerCalls } from './mermaid-detect.js';

export type FlowKind = 'drawio' | 'mermaid' | 'text';

/** One entry of `flows/_inputs.json` — what the agent finds prepared. */
export interface FlowInput {
  id: string;
  title: string;
  kind: Exclude<FlowKind, 'text'>;
  /** Markdown page (relative to cwd) that embeds the diagram, else the diagram file. */
  source: string;
  /** Diagram file this page came from (relative to cwd). */
  diagram: string;
  /** draw.io page name / index inside `diagram`. */
  page?: { index: number; name: string; count: number };
  /** Files under `flows/<id>/` the agent should read. */
  files: { asIs: string; cells?: string; svg?: string };
  /** Cell / node counts, for the agent to size its effort. */
  counts: { nodes: number; edges: number };
}

export interface UxFinding {
  id: string;
  severity: 'blocker' | 'major' | 'minor' | 'note';
  heuristic?: string;
  title: string;
  reason: string;
  recommendation?: string;
  evidence?: string[];
  cells?: { asIs?: string[]; proposed?: string[] };
  change?: 'added' | 'modified' | 'removed' | 'none';
  conflictsWith?: string;
}
export interface UxReview {
  flowId: string;
  verdict: 'good' | 'needs-improvement' | 'poor';
  summary: string;
  findings: UxFinding[];
}

/** One entry of the rebuilt `flows/index.json`. Superset of the legacy shape
 *  (`id`/`title`/`source`/`screens`/`note`) the web viewer already reads. */
export interface FlowIndexEntry {
  id: string;
  title: string;
  source: string;
  kind: FlowKind;
  screens: { key: string; name: string }[];
  note?: string;
  verdict?: UxReview['verdict'];
  findings?: number;
  hasProposal?: boolean;
  files?: { asIs?: string; proposed?: string; review?: string; flowchart?: string; svg?: string };
  patchSkipped?: { op: PatchOp; reason: string }[];
  /** Mapping màn (`screens.json`) daemon không dùng được — sự cố #5d13309f:
   *  trước đây bị loại thẳng tay, không một cảnh báo. Chỉ ghi khi có. */
  screensDropped?: { cell: string; key: string; reason: string }[];
}

const DOC_ROOTS = ['docs-feature', 'docs'];
const SEVERITIES = new Set(['blocker', 'major', 'minor', 'note']);
const VERDICTS = new Set(['good', 'needs-improvement', 'poor']);

/* ── fs helpers ──────────────────────────────────────────────────────────── */

async function exists(p: string): Promise<boolean> {
  return fs.promises
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

async function readText(p: string): Promise<string | null> {
  return fs.promises.readFile(p, 'utf8').catch(() => null);
}

async function readJson<T>(p: string): Promise<T | null> {
  const raw = await readText(p);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(p: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Recursively list files under `dir` (relative paths, posix separators). */
async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), r)));
    else out.push(r);
  }
  return out;
}

/* ── ids ─────────────────────────────────────────────────────────────────── */

/** ASCII slug: strip diacritics (đ→d), non-alnum → `-`, ≤ 48 chars. */
export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
    .toLowerCase();
}

function uniqueFlowId(base: string, taken: Set<string>): string {
  const root = `FLOW-${slugify(base) || 'so-do'}`;
  let id = root;
  let n = 2;
  while (taken.has(id)) id = `${root}-${n++}`;
  taken.add(id);
  return id;
}

/* ── prepare ─────────────────────────────────────────────────────────────── */

export interface PrepareResult {
  inputs: FlowInput[];
  /** Markdown pages rewritten (createViewer → image + .mmd link). */
  normalizedPages: string[];
  /** draw.io diagrams no markdown page references — sự cố #5d13309f: trước
   *  đây vẫn vào `flows` và tốn một lượt agent cho mỗi cái. Rỗng khi không
   *  có sơ đồ mồ côi (hoặc khi safety net bên dưới giữ lại hết). */
  orphans: { diagram: string; reason: string }[];
}

/** Loose form of a diagram filename for tolerant matching: strip the
 *  Confluence numeric export prefix (`903353914-…`) and the extension, fold
 *  `_`/`%20`/runs of whitespace to single spaces, lowercase. Two names that
 *  differ only by that noise (`903353914-Untitled_Diagram-123.drawio` vs the
 *  rendered `Untitled Diagram-123.png` a page embeds) become the same token. */
function looseDiagramToken(s: string): string {
  return s
    .replace(/^\d+-/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/%20/gi, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Which markdown page references a diagram file (by basename)? Exact match
 *  first (verbatim basename, or its `encodeURI` form); a tolerant pass
 *  second — sự cố #5d13309f: 12/13 sơ đồ draw.io của một dự án thật chỉ được
 *  Confluence export dưới tên có tiền tố số, còn trang tài liệu chỉ nhúng
 *  ẢNH PNG cùng gốc tên (không có tiền tố, `_` thành khoảng trắng); khớp
 *  nguyên văn bỏ lỡ hết, khiến mọi sơ đồ trông như "mồ côi". */
function pageReferencing(mdByRel: Map<string, string>, diagramBase: string): string | null {
  const needle = diagramBase.toLowerCase();
  const enc = encodeURI(diagramBase).toLowerCase();
  for (const [rel, text] of mdByRel) {
    const low = text.toLowerCase();
    if (low.includes(needle) || low.includes(enc)) return rel;
  }
  const loose = looseDiagramToken(diagramBase);
  // WP9b: token khoan dung ngắn/chung chung (`a-1`) có thể khớp nhầm bất kỳ
  // trang nào chứa cùng chuỗi con tình cờ — guard tối thiểu 8 ký tự SAU
  // chuẩn hoá và phải còn ít nhất một chữ số (dấu hiệu của tiền tố export
  // Confluence thật, `1769153289432` trong `Untitled Diagram-1769153289432`);
  // không đạt thì bỏ hẳn pass khoan dung, chỉ dùng khớp nguyên văn ở trên.
  if (!loose || loose.length < 8 || !/\d/.test(loose)) return null;
  for (const [rel, text] of mdByRel) {
    if (looseDiagramToken(text).includes(loose)) return rel;
  }
  return null;
}

export async function prepareFlowUxInputs(cwd: string): Promise<PrepareResult> {
  const flowsDir = path.join(cwd, 'flows');
  const inputs: FlowInput[] = [];
  const taken = new Set<string>();
  const normalizedPages: string[] = [];
  // Disk writes are deferred until every id is settled.
  const pendingWrites: (() => Promise<void>)[] = [];

  // Collect docs: prefer docs-feature/ (app-pool projects) then docs/ (legacy).
  const roots: string[] = [];
  for (const r of DOC_ROOTS) if (await exists(path.join(cwd, r))) roots.push(r);
  const mdByRel = new Map<string, string>();
  const files: string[] = [];
  for (const root of roots) {
    for (const rel of await walk(path.join(cwd, root), root)) {
      files.push(rel);
      if (/\.md$/i.test(rel) && !/(^|\/)_index\.md$/i.test(rel) && !/\/attachments\//i.test(rel)) {
        const t = await readText(path.join(cwd, rel));
        if (t != null) mdByRel.set(rel, t);
      }
    }
  }

  // (1) draw.io files — every page is one flow, EXCEPT a diagram no markdown
  // page references at all: that one is "mồ côi" (sự cố #5d13309f — 12/13 sơ
  // đồ của một dự án thật không trang nào tham chiếu, mỗi cái vẫn tốn một
  // lượt agent và đẻ ra flow rác). Candidates are built first and only
  // committed to `inputs`/disk once we know which diagrams are referenced.
  const drawioCandidates: { input: FlowInput; write: () => Promise<void>; orphan: boolean; diagram: string }[] = [];
  for (const rel of files.filter((f) => /\.drawio$/i.test(f)).sort()) {
    const xml = await readText(path.join(cwd, rel));
    if (xml == null) continue;
    let pages: MxPage[];
    try {
      pages = decodeMxfile(xml);
    } catch (err) {
      console.warn(`[flow-ux] cannot decode ${rel}:`, err);
      continue;
    }
    const stem = path.basename(rel).replace(/\.drawio$/i, '').replace(/^\d+-/, '');
    const referencedBy = pageReferencing(mdByRel, path.basename(rel));
    const orphan = referencedBy == null;
    const source = referencedBy ?? rel;
    pages.forEach((page, i) => {
      const cells = listCells(page.graphXml);
      const nodes = cells.filter((c) => c.kind === 'vertex' && c.label).length;
      const edges = cells.filter((c) => c.kind === 'edge').length;
      if (nodes < 2 && edges === 0) return; // empty / single-box page, not a flow
      const generic = /^page-?\d*$/i.test(page.name.trim()) || !page.name.trim();
      const title = generic ? (pages.length > 1 ? `${stem} — trang ${i + 1}` : stem) : page.name.trim();
      const id = uniqueFlowId(generic ? `${stem}${pages.length > 1 ? `-p${i + 1}` : ''}` : page.name, taken);
      drawioCandidates.push({
        input: {
          id,
          title,
          kind: 'drawio',
          source,
          diagram: rel,
          page: { index: i, name: page.name, count: pages.length },
          files: { asIs: `flows/${id}/as-is.drawio`, cells: `flows/${id}/cells.json` },
          counts: { nodes, edges },
        },
        orphan,
        diagram: rel,
        write: async () => {
          const dir = path.join(flowsDir, id);
          await fs.promises.mkdir(dir, { recursive: true });
          await fs.promises.writeFile(path.join(dir, 'as-is.drawio'), encodeMxfile([{ ...page, name: 'Hiện trạng' }]), 'utf8');
          await writeJson(
            path.join(dir, 'cells.json'),
            cells.map((c) => {
              const { style: _style, ...rest } = c;
              return rest;
            }),
          );
        },
      });
    });
  }
  const referenced = drawioCandidates.filter((c) => !c.orphan);
  const orphanedCandidates = drawioCandidates.filter((c) => c.orphan);
  const orphans: PrepareResult['orphans'] = [];
  let orphanSafetyNote: string | undefined;
  if (referenced.length === 0 && orphanedCandidates.length > 0) {
    // Safety net: đừng để một dự án đang chạy được (có sơ đồ thật) biến thành
    // không còn luồng nào chỉ vì việc khớp trang tham chiếu trượt hết —
    // hành vi cũ (mọi sơ đồ vào flows) + cảnh báo thay vì im lặng bỏ hết.
    orphanSafetyNote = `${orphanedCandidates.length} sơ đồ draw.io không trang tài liệu nào tham chiếu được, nhưng đó là TOÀN BỘ sơ đồ dự án — vẫn đưa hết vào flows để không mất luồng nào.`;
    for (const c of drawioCandidates) {
      inputs.push(c.input);
      pendingWrites.push(c.write);
    }
  } else {
    for (const c of referenced) {
      inputs.push(c.input);
      pendingWrites.push(c.write);
    }
    const seenDiagram = new Set<string>();
    for (const c of orphanedCandidates) {
      if (seenDiagram.has(c.diagram)) continue;
      seenDiagram.add(c.diagram);
      orphans.push({ diagram: c.diagram, reason: 'không có trang tài liệu nào tham chiếu sơ đồ này' });
    }
  }

  // (2) Mermaid — standalone files, exported macro calls, fenced blocks.
  const seenMermaid = new Set<string>();
  const addMermaid = async (title: string, code: string, source: string, diagram: string, svg?: string) => {
    if (!isMermaidFlowchart(code)) return; // sequence/ER/… are not screen flows
    const key = code.replace(/\s+/g, ' ').trim();
    if (seenMermaid.has(key)) return;
    seenMermaid.add(key);
    const id = uniqueFlowId(title, taken);
    const parsed = mermaidToFlowchart(code, { id, title, source });
    inputs.push({
      id,
      title,
      kind: 'mermaid',
      source,
      diagram,
      files: { asIs: `flows/${id}/as-is.mmd`, ...(svg ? { svg: `flows/${id}/as-is.svg` } : {}) },
      counts: { nodes: parsed?.nodes.length ?? 0, edges: parsed?.edges.length ?? 0 },
    });
    pendingWrites.push(async () => {
      const dir = path.join(flowsDir, id);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, 'as-is.mmd'), `${code.trim()}\n`, 'utf8');
      if (svg) await fs.promises.writeFile(path.join(dir, 'as-is.svg'), svgForImgEmbedding(svg), 'utf8');
    });
  };

  // Attachment texts (extension-less Mermaid sources, .mmd) by basename, per
  // root — the exported macro names its source after the diagram title.
  const attachmentText = new Map<string, string>();
  for (const rel of files) {
    if (!/\/attachments\//i.test(rel)) continue;
    if (/\.(png|jpe?g|gif|webp|svg|pdf|drawio|zip|docx?|xlsx?|pptx?)$/i.test(rel)) continue;
    const st = await fs.promises.stat(path.join(cwd, rel)).catch(() => null);
    if (!st || st.size > 512 * 1024) continue;
    const t = await readText(path.join(cwd, rel));
    if (t != null && looksLikeMermaid(t)) attachmentText.set(path.basename(rel), t);
  }
  const consumedAttachments = new Set<string>();
  // Pages FIRST: a diagram embedded in a page (fenced ```mermaid — what our
  // Confluence ingest now writes for the Mermaid macro — or an exported
  // createViewer call) carries the document's own title and SVG; the same
  // source saved as an `attachments/*.mmd` file next to it is only a copy
  // and would otherwise claim the flow under its file name (dedupe is by
  // code, first one wins).
  for (const [rel, text] of mdByRel) {
    const found = findEmbeddedMermaid(text, attachmentText);
    if (!found.length) continue;
    const pageDir = path.posix.dirname(rel);
    const attDirRel = `${pageDir}/attachments`;
    // Normalize the page: swap each raw createViewer(...) call for an image of
    // the saved SVG plus a link to the Mermaid source (idempotent — a second
    // run finds no createViewer). Only pages that carry the raw call change.
    const saved: { svgRel?: string; codeRel?: string }[] = [];
    let idx = 0;
    for (const item of found) {
      const base = slugify(item.title) || `so-do-${idx + 1}`;
      const entry: { svgRel?: string; codeRel?: string } = {};
      if (!item.svg && item.svgRef) {
        // Fenced block with the rendered SVG shown as an image right above it
        // (our Confluence ingest) — read the file so the viewer gets the
        // original picture next to the analysis.
        const svgText = await readText(path.join(cwd, pageDir, item.svgRef));
        if (svgText && /<svg\b/i.test(svgText)) item.svg = svgText;
      }
      if (item.svg) {
        await fs.promises.mkdir(path.join(cwd, attDirRel), { recursive: true });
        await fs.promises.writeFile(path.join(cwd, attDirRel, `${base}.svg`), svgForImgEmbedding(item.svg), 'utf8');
        entry.svgRel = `attachments/${base}.svg`;
      }
      if (item.code) {
        consumedAttachments.add(item.title);
        consumedAttachments.add(`${item.title}.mmd`);
        await fs.promises.mkdir(path.join(cwd, attDirRel), { recursive: true });
        await fs.promises.writeFile(path.join(cwd, attDirRel, `${base}.mmd`), `${item.code.trim()}\n`, 'utf8');
        entry.codeRel = `attachments/${base}.mmd`;
        await addMermaid(item.title, item.code, rel, `${attDirRel}/${base}.mmd`, item.svg);
      } else if (item.svg) {
        // SVG only: no source to judge from — still index it so the viewer can
        // show the original picture next to the text-only analysis.
        console.log(`[flow-ux] ${rel}: sơ đồ Mermaid "${item.title}" chỉ có SVG, không tìm thấy nguồn`);
      }
      saved.push(entry);
      idx += 1;
    }
    if (text.includes('createViewer(')) {
      const rewritten = replaceCreateViewerCalls(text, (_item, i) => saved[i] ?? null);
      if (rewritten !== text) {
        await fs.promises.writeFile(path.join(cwd, rel), rewritten, 'utf8');
        normalizedPages.push(rel);
      }
    }
  }

  // Standalone `.mmd` / `.mermaid` attachments (a copy of an embedded diagram
  // is skipped by the code dedupe above): titled after the file minus the
  // `<pageId>-` prefix our ingest adds; a sibling `.svg` of the same stem is
  // the rendered picture.
  for (const [name, code] of attachmentText) {
    if (!/\.(mmd|mermaid)$/i.test(name)) continue;
    consumedAttachments.add(name);
    const rel = files.find((f) => path.basename(f) === name)!;
    const stem = name.replace(/\.(mmd|mermaid)$/i, '');
    const svgRel = files.find((f) => path.dirname(f) === path.dirname(rel) && path.basename(f) === `${stem}.svg`);
    const svg = svgRel ? (await readText(path.join(cwd, svgRel))) ?? undefined : undefined;
    await addMermaid(stem.replace(/^\d+-/, ''), code, pageReferencing(mdByRel, name) ?? rel, rel, svg && /<svg\b/i.test(svg) ? svg : undefined);
  }

  // Extension-less Mermaid attachments no page call referenced (older ingests
  // that dropped the macro's <script>, leaving only the source attachment):
  // still a flow — titled after the file.
  for (const [name, code] of attachmentText) {
    if (consumedAttachments.has(name)) continue;
    const rel = files.find((f) => path.basename(f) === name)!;
    await addMermaid(name, code, pageReferencing(mdByRel, name) ?? rel, rel);
  }

  await fs.promises.mkdir(flowsDir, { recursive: true });
  for (const w of pendingWrites.splice(0)) await w();
  await writeJson(path.join(flowsDir, '_inputs.json'), {
    generatedAt: new Date().toISOString(),
    flows: inputs,
    ...(orphans.length ? { orphans } : {}),
    note:
      inputs.length === 0
        ? 'Không tìm thấy sơ đồ draw.io/Mermaid nào trong tài liệu — chạy chế độ text-only (tự dựng flowchart.json từ chữ).'
        : orphanSafetyNote,
  });
  return { inputs, normalizedPages, orphans };
}

/* ── finalize ────────────────────────────────────────────────────────────── */

interface ScreensFile {
  cells?: Record<string, string>;
  names?: Record<string, string>;
  note?: string;
  /** Text-only flows (agent-drawn `as-is.mmd`, no diagram in the docs): the
   *  agent names the flow and points at the page it was distilled from. */
  title?: string;
  source?: string;
}

function normalizeReview(raw: unknown, flowId: string): UxReview | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const findingsRaw = Array.isArray(o.findings) ? o.findings : [];
  const findings: UxFinding[] = [];
  findingsRaw.forEach((f, i) => {
    if (!f || typeof f !== 'object') return;
    const x = f as Record<string, unknown>;
    const title = typeof x.title === 'string' ? x.title.trim() : '';
    const reason = typeof x.reason === 'string' ? x.reason.trim() : '';
    if (!title && !reason) return;
    const sev = typeof x.severity === 'string' && SEVERITIES.has(x.severity) ? (x.severity as UxFinding['severity']) : 'minor';
    const cellsRaw = x.cells && typeof x.cells === 'object' ? (x.cells as Record<string, unknown>) : {};
    const strList = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined);
    const finding: UxFinding = {
      id: typeof x.id === 'string' && x.id.trim() ? x.id.trim() : `UX-${String(i + 1).padStart(2, '0')}`,
      severity: sev,
      title: title || reason.slice(0, 80),
      reason: reason || title,
    };
    if (typeof x.heuristic === 'string') finding.heuristic = x.heuristic;
    if (typeof x.recommendation === 'string') finding.recommendation = x.recommendation;
    const ev = strList(x.evidence);
    if (ev?.length) finding.evidence = ev;
    const asIs = strList(cellsRaw.asIs);
    const proposed = strList(cellsRaw.proposed);
    if (asIs?.length || proposed?.length) finding.cells = { ...(asIs?.length ? { asIs } : {}), ...(proposed?.length ? { proposed } : {}) };
    if (typeof x.change === 'string' && ['added', 'modified', 'removed', 'none'].includes(x.change)) finding.change = x.change as NonNullable<UxFinding['change']>;
    if (typeof x.conflictsWith === 'string') finding.conflictsWith = x.conflictsWith;
    findings.push(finding);
  });
  const verdict =
    typeof o.verdict === 'string' && VERDICTS.has(o.verdict)
      ? (o.verdict as UxReview['verdict'])
      : findings.some((f) => f.severity === 'blocker')
        ? 'poor'
        : findings.some((f) => f.severity === 'major' || f.severity === 'minor')
          ? 'needs-improvement'
          : 'good';
  return {
    flowId: typeof o.flowId === 'string' && o.flowId ? o.flowId : flowId,
    verdict,
    summary: typeof o.summary === 'string' ? o.summary.trim() : '',
    findings,
  };
}

function screensOf(doc: FlowchartDoc | null, names: Record<string, string>): { key: string; name: string }[] {
  if (!doc) return [];
  const seen = new Set<string>();
  const out: { key: string; name: string }[] = [];
  for (const n of doc.nodes) {
    if (!n.screen || seen.has(n.screen)) continue;
    seen.add(n.screen);
    out.push({ key: n.screen, name: names[n.screen] ?? n.screen });
  }
  return out;
}

/* ── cạnh song song không nhãn (WP-dr-review-readability, mục D) ─────────── */

/** Một cạnh mermaid parse tối giản — chỉ `from`/`to`/`label?`, đủ để
 *  {@link findUnlabeledParallelEdges} so cặp (from, to) giữa hai bản sơ đồ. */
interface LooseMermaidEdge {
  from: string;
  to: string;
  label?: string;
}

/** Lấy phần ID đứng đầu một token cạnh mermaid, bỏ phần hình dạng/nhãn node đi
 *  kèm (`OD_X[Nhãn]`, `K{Quyết định}`, `Start([Bắt đầu])`) — chỉ id mới cần để
 *  so cặp from/to giữa hai bản. */
function looseMermaidNodeId(token: string): string {
  const trimmed = token.trim();
  const m = /^([A-Za-z0-9_-]+)/.exec(trimmed);
  return m ? m[1]! : trimmed;
}

// Bốn dạng cú pháp cạnh mermaid mà proposed.mmd/as-is.mmd của dr-flow thực sự
// dùng (xem skills/docs-flow-ux/SKILL.md mục 4b): `A --> B`, `A -- "nhãn" -->
// B`, `A -- nhãn --> B`, `A -->|nhãn| B`. `(?!>)` sau `--` loại trừ trường hợp
// "--" đó thực ra là hai ký tự đầu của chính "-->" (cạnh KHÔNG nhãn) — nếu
// không có nó thì regex nhãn-thường có thể nuốt nhầm một cạnh trơn thành cạnh
// có "nhãn" rỗng.
const QUOTED_DASH_LABEL_RE = /^(.+?)\s*--(?!>)\s*"([^"]*)"\s*-->\s*(.+)$/;
const BARE_DASH_LABEL_RE = /^(.+?)\s*--(?!>)\s*([^"\s][^\n]*?)\s*-->\s*(.+)$/;
const PIPE_LABEL_RE = /^(.+?)\s*-->\s*\|([^|]*)\|\s*(.+)$/;
const PLAIN_ARROW_RE = /^(.+?)\s*-->\s*(.+)$/;

/** Parse cạnh mermaid TỐI GIẢN cho {@link findUnlabeledParallelEdges} — CỐ Ý
 *  không gọi lại {@link mermaidToFlowchart}: hàm đó đòi dòng mở đầu
 *  `flowchart`/`graph` và dựng lại toàn bộ cây node/shape, trong khi mục tiêu
 *  ở đây chỉ là cặp (from, to, label?) của từng cạnh để so cạnh song song —
 *  một đoạn `proposed.mmd`/`as-is.mmd` bất kỳ (có hay không dòng mở đầu) đều
 *  phải parse được. Bỏ qua dòng chú thích (`%%`), khai báo style (`classDef`,
 *  `class`) và dòng mở đầu (`flowchart`/`graph`) — chúng không phải cạnh. */
function parseMermaidEdgesLoose(code: string): LooseMermaidEdge[] {
  const edges: LooseMermaidEdge[] = [];
  const lines = code.replace(/\r\n?/g, '\n').split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('%%')) continue;
    if (/^(flowchart|graph)\b/i.test(line)) continue;
    if (/^classDef\b/i.test(line)) continue;
    if (/^class\b/i.test(line)) continue;

    // `exactOptionalPropertyTypes: true` cấm gán `label: undefined` tường
    // minh lên một property optional — nên chỉ thêm key `label` khi nhãn
    // thực sự không rỗng, thay vì luôn gán rồi để `undefined` lọt vào.
    const quoted = QUOTED_DASH_LABEL_RE.exec(line);
    if (quoted) {
      const from = looseMermaidNodeId(quoted[1]!);
      const to = looseMermaidNodeId(quoted[3]!);
      const label = quoted[2]!.trim();
      edges.push(label ? { from, to, label } : { from, to });
      continue;
    }
    const bare = BARE_DASH_LABEL_RE.exec(line);
    if (bare) {
      const from = looseMermaidNodeId(bare[1]!);
      const to = looseMermaidNodeId(bare[3]!);
      const label = bare[2]!.trim();
      edges.push(label ? { from, to, label } : { from, to });
      continue;
    }
    const piped = PIPE_LABEL_RE.exec(line);
    if (piped) {
      const from = looseMermaidNodeId(piped[1]!);
      const to = looseMermaidNodeId(piped[3]!);
      const label = piped[2]!.trim();
      edges.push(label ? { from, to, label } : { from, to });
      continue;
    }
    const plain = PLAIN_ARROW_RE.exec(line);
    if (plain) {
      edges.push({ from: looseMermaidNodeId(plain[1]!), to: looseMermaidNodeId(plain[2]!) });
      continue;
    }
  }
  return edges;
}

/** Tìm cạnh SONG SONG KHÔNG NHÃN trong `proposedCode` so với `asIsCode` — sự
 *  cố đo được trên dự án dich-vu-mua-sim: nhánh đề xuất thêm `J1 -->
 *  OD_InvoiceAndTotal --> K` để THAY THẾ đường cũ, nhưng cạnh cũ `J1 --> K`
 *  vẫn còn nguyên trong `proposed.mmd`, không nhãn gì phân biệt — sơ đồ đọc
 *  thành hai luồng song song tự mâu thuẫn thay vì một đề xuất thay thế rõ
 *  ràng (xem `skills/docs-flow-ux/SKILL.md` mục 4b, luật "xử lý cạnh cũ bị
 *  thay thế").
 *
 *  Cảnh báo khi: một node nguồn `S` trong `proposedCode` có (i) ít nhất một
 *  cạnh `S -> X` mà `X` là node MỚI (xuất hiện trong `proposedCode` nhưng
 *  không có trong `asIsCode`), VÀ (ii) vẫn còn một cạnh `S -> T` khác (đúng
 *  cặp from+to) đã CÓ MẶT trong `asIsCode` mà KHÔNG có nhãn ở `proposedCode`.
 *  Cạnh cũ đã bị xoá khỏi `proposedCode`, hoặc đã được gắn nhãn (bất kỳ nhãn
 *  nào, ví dụ "hiện trạng — bỏ nếu áp dụng UX-0n") thì KHÔNG cảnh báo.
 *
 *  Hàm THUẦN: chỉ parse hai chuỗi mermaid truyền vào, không đọc đĩa, không
 *  gọi mạng — caller ({@link finalizeFlowUx}) tự đọc `as-is.mmd`/`proposed.mmd`
 *  rồi truyền nội dung vào đây. */
export function findUnlabeledParallelEdges(asIsCode: string, proposedCode: string): string[] {
  const asIsEdges = parseMermaidEdgesLoose(asIsCode);
  const proposedEdges = parseMermaidEdgesLoose(proposedCode);

  const asIsIds = new Set<string>();
  for (const e of asIsEdges) {
    asIsIds.add(e.from);
    asIsIds.add(e.to);
  }
  const proposedIds = new Set<string>();
  for (const e of proposedEdges) {
    proposedIds.add(e.from);
    proposedIds.add(e.to);
  }
  const newNodeIds = new Set<string>([...proposedIds].filter((id) => !asIsIds.has(id)));
  const asIsPairs = new Set(asIsEdges.map((e) => `${e.from} ${e.to}`));

  const out: string[] = [];
  const reported = new Set<string>();
  for (const newEdge of proposedEdges) {
    if (!newNodeIds.has(newEdge.to)) continue; // chỉ xét cạnh TỚI một node mới
    const source = newEdge.from;
    for (const oldEdge of proposedEdges) {
      if (oldEdge.from !== source) continue;
      if (newNodeIds.has(oldEdge.to)) continue; // chính nó là cạnh mới, không phải cạnh cũ giữ lại
      if (!asIsPairs.has(`${oldEdge.from} ${oldEdge.to}`)) continue; // cặp này không tồn tại ở as-is
      if ((oldEdge.label ?? '').trim() !== '') continue; // đã gắn nhãn ở bản proposed — không mâu thuẫn nữa

      const key = `${source} ${oldEdge.to} ${newEdge.to}`;
      if (reported.has(key)) continue;
      reported.add(key);
      out.push(
        `cạnh song song không nhãn: "${source} --> ${oldEdge.to}" (cũ) tồn tại cạnh mới "${source} --> ${newEdge.to}" — xoá cạnh cũ khỏi proposed.mmd hoặc gắn nhãn "hiện trạng — bỏ nếu áp dụng UX-0n"`,
      );
    }
  }
  return out;
}

export interface FinalizeResult {
  index: FlowIndexEntry[];
  warnings: string[];
}

export async function finalizeFlowUx(cwd: string): Promise<FinalizeResult> {
  const flowsDir = path.join(cwd, 'flows');
  const warnings: string[] = [];
  const index: FlowIndexEntry[] = [];
  const manifest = await readJson<{ flows?: FlowInput[] }>(path.join(flowsDir, '_inputs.json'));
  const inputs: FlowInput[] = [...(manifest?.flows ?? [])];
  const covered = new Set<string>();

  // Text-only flows (documents with no diagram): the agent draws ONE full
  // Mermaid flowchart itself at `flows/<id>/as-is.mmd` (+ optional
  // proposed.mmd). Pick those folders up as Mermaid inputs so they get the same
  // treatment — flowchart.json derived, review normalised, one index entry —
  // and the viewer shows a real diagram instead of a re-laid-out canvas.
  const manifestIds = new Set(inputs.map((i) => i.id));
  const dirents = await fs.promises.readdir(flowsDir, { withFileTypes: true }).catch(() => []);
  for (const d of dirents.filter((e) => e.isDirectory() && !e.name.startsWith('_')).sort((a, b) => a.name.localeCompare(b.name))) {
    if (manifestIds.has(d.name)) continue;
    const asIs = path.join(flowsDir, d.name, 'as-is.mmd');
    if (!(await exists(asIs))) continue;
    const meta = (await readJson<ScreensFile>(path.join(flowsDir, d.name, 'screens.json'))) ?? {};
    inputs.push({
      id: d.name,
      title: typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : d.name,
      kind: 'mermaid',
      source: typeof meta.source === 'string' ? meta.source : '',
      diagram: `flows/${d.name}/as-is.mmd`,
      files: { asIs: `flows/${d.name}/as-is.mmd` },
      counts: { nodes: 0, edges: 0 },
    });
  }

  for (const input of inputs) {
    covered.add(input.id);
    const dir = path.join(flowsDir, input.id);
    const entry: FlowIndexEntry = { id: input.id, title: input.title, source: input.source, kind: input.kind, screens: [], files: {} };
    const screensFile = (await readJson<ScreensFile>(path.join(dir, 'screens.json'))) ?? {};
    const cellScreens = screensFile.cells ?? {};
    const names = screensFile.names ?? {};
    let flowchart: FlowchartDoc | null = null;
    // Bảng id cạnh → {from,to} + id node do patch đề xuất thêm, dùng SAU khi
    // dựng flowchart để tính lại `screensDropped` (resolveScreenCells) và
    // phân loại đúng lý do — sự cố #5d13309f: agent gắn màn đúng ý nhưng bị
    // loại thẳng tay, không một dòng cảnh báo nào tới người dùng. WP9b: đưa
    // MỌI cạnh vào đây (kể cả cạnh TRÔI — sequence, không source/target),
    // không lọc trước như trước, để resolveScreenCells tự phân loại đúng lý
    // do; trước đây lọc `source && target` khiến cạnh trôi không bao giờ tới
    // được lệnh gọi này nên lý do "là cạnh không nối hai đỉnh" chỉ tồn tại
    // trong hàm, không bao giờ lên `entry.screensDropped` thật.
    let edgesForDrop: Array<{ id?: string; from?: string | undefined; to?: string | undefined }> = [];
    let patchAddNodeIds = new Set<string>();

    if (input.kind === 'drawio') {
      const asIsXml = await readText(path.join(dir, 'as-is.drawio'));
      if (asIsXml == null) {
        warnings.push(`${input.id}: thiếu as-is.drawio`);
        index.push(entry);
        continue;
      }
      entry.files!.asIs = `flows/${input.id}/as-is.drawio`;
      const page = decodeMxfile(asIsXml)[0];
      if (!page) {
        warnings.push(`${input.id}: as-is.drawio không có trang nào`);
        index.push(entry);
        continue;
      }
      flowchart = drawioPageToFlowchart(page.graphXml, { id: input.id, title: input.title, source: input.source }, cellScreens);
      edgesForDrop = listCells(page.graphXml)
        .filter((c) => c.kind === 'edge')
        .map((c) => ({ id: c.id, from: c.source, to: c.target }));
      const patchRaw = await readText(path.join(dir, 'patch.json'));
      if (patchRaw != null) {
        const patch = parsePatchDoc(patchRaw);
        patchAddNodeIds = new Set(
          patch.ops.filter((o): o is Extract<PatchOp, { op: 'addNode' }> => o.op === 'addNode').map((o) => o.id),
        );
        if (patch.ops.length) {
          const result = applyPatch(page.graphXml, patch);
          if (result.applied > 0) {
            const proposed = encodeMxfile([
              { id: `${page.id}`, name: 'Hiện trạng', graphXml: page.graphXml },
              { id: `${page.id}-proposed`, name: 'Đề xuất', graphXml: result.graphXml },
            ]);
            await fs.promises.writeFile(path.join(dir, 'proposed.drawio'), proposed, 'utf8');
            entry.hasProposal = true;
            entry.files!.proposed = `flows/${input.id}/proposed.drawio`;
          }
          if (result.skipped.length) {
            entry.patchSkipped = result.skipped;
            warnings.push(`${input.id}: ${result.skipped.length} thao tác vá bị bỏ qua (${result.skipped.map((s) => s.reason).join('; ')})`);
          }
        }
      }
    } else {
      const code = await readText(path.join(dir, 'as-is.mmd'));
      if (code == null) {
        warnings.push(`${input.id}: thiếu as-is.mmd`);
        index.push(entry);
        continue;
      }
      entry.files!.asIs = `flows/${input.id}/as-is.mmd`;
      if (input.files.svg && (await exists(path.join(cwd, input.files.svg)))) entry.files!.svg = input.files.svg;
      flowchart = mermaidToFlowchart(code, { id: input.id, title: input.title, source: input.source }, cellScreens);
      if (!flowchart) warnings.push(`${input.id}: không parse được Mermaid — bỏ qua flowchart.json`);
      const proposed = await readText(path.join(dir, 'proposed.mmd'));
      if (proposed != null && looksLikeMermaid(proposed)) {
        entry.hasProposal = true;
        entry.files!.proposed = `flows/${input.id}/proposed.mmd`;
        // WP-dr-review-readability mục D: cảnh báo (KHÔNG fail) khi nhánh đề
        // xuất thêm một đường mới nhưng vẫn giữ nguyên cạnh cũ bị thay thế,
        // không nhãn — xem docblock findUnlabeledParallelEdges.
        for (const msg of findUnlabeledParallelEdges(code, proposed)) warnings.push(`${input.id}: ${msg}`);
      }
    }

    if (flowchart && flowchart.nodes.length) {
      await writeJson(path.join(flowsDir, `${input.id}.flowchart.json`), flowchart);
      entry.files!.flowchart = `flows/${input.id}.flowchart.json`;
      entry.screens = screensOf(flowchart, names);
    }
    // Mapping màn bị bỏ (id lạ / trỏ vào cạnh mà hai đầu không dùng được /
    // node decision / chỉ có ở bản đề xuất patch.json chưa vào flowchart) —
    // tính lại bằng CHÍNH cây node cuối cùng để không lệch với `entry.screens`
    // ở trên, rồi báo ra cho người dùng thay vì im lặng như trước.
    if (flowchart && Object.keys(cellScreens).length) {
      const { dropped } = resolveScreenCells(
        { nodes: flowchart.nodes.map((n) => ({ id: n.id, type: n.type })), edges: edgesForDrop },
        cellScreens,
      );
      const classified = dropped.map((d) =>
        d.reason === 'không có trong sơ đồ' && (d.cell.startsWith('od-') || patchAddNodeIds.has(d.cell))
          ? { ...d, reason: 'chỉ có ở bản đề xuất (node do patch thêm)' }
          : d,
      );
      if (classified.length) {
        entry.screensDropped = classified;
        for (const d of classified) warnings.push(`${input.id}: mapping màn "${d.key}" trỏ vào "${d.cell}" bị bỏ — ${d.reason}`);
      }
      if (entry.screens.length === 0) {
        warnings.push(`${input.id}: khai ${Object.keys(cellScreens).length} mapping màn nhưng không cái nào dùng được — xem screensDropped`);
      }
    }
    const reviewRaw = await readJson<unknown>(path.join(dir, 'ux-review.json'));
    const review = normalizeReview(reviewRaw, input.id);
    if (review) {
      await writeJson(path.join(dir, 'ux-review.json'), review);
      entry.files!.review = `flows/${input.id}/ux-review.json`;
      entry.verdict = review.verdict;
      entry.findings = review.findings.length;
    } else {
      warnings.push(`${input.id}: thiếu/hỏng ux-review.json`);
    }
    if (screensFile.note) entry.note = screensFile.note;
    index.push(entry);
  }

  // Text-only flows: `flows/<id>.flowchart.json` the agent wrote by hand for
  // documents without any diagram (legacy contract, still valid).
  const rootFiles = await fs.promises.readdir(flowsDir).catch(() => [] as string[]);
  for (const f of rootFiles.sort()) {
    const m = /^(.+)\.flowchart\.json$/i.exec(f);
    if (!m || covered.has(m[1]!)) continue;
    const id = m[1]!;
    const doc = await readJson<FlowchartDoc>(path.join(flowsDir, f));
    if (!doc || !Array.isArray(doc.nodes)) continue;
    const dir = path.join(flowsDir, id);
    const screensFile = (await readJson<ScreensFile>(path.join(dir, 'screens.json'))) ?? {};
    const entry: FlowIndexEntry = {
      id,
      title: typeof doc.title === 'string' ? doc.title : id,
      source: typeof doc.source === 'string' ? doc.source : '',
      kind: 'text',
      screens: screensOf(doc, screensFile.names ?? {}),
      files: { flowchart: `flows/${f}` },
    };
    const reviewRaw = await readJson<unknown>(path.join(dir, 'ux-review.json'));
    const review = normalizeReview(reviewRaw, id);
    if (review) {
      await writeJson(path.join(dir, 'ux-review.json'), review);
      entry.files!.review = `flows/${id}/ux-review.json`;
      entry.verdict = review.verdict;
      entry.findings = review.findings.length;
    }
    if (screensFile.note) entry.note = screensFile.note;
    index.push(entry);
  }

  await writeJson(path.join(flowsDir, 'index.json'), index);
  // Trước đây warnings CHỈ đi ra console.log — người dùng không bao giờ thấy.
  // Ghi ra file để studio/web đọc được; không làm stage thất bại vì chuyện
  // này (fail-soft), và xoá file cũ khi lần chạy này không còn cảnh báo.
  const warningsPath = path.join(flowsDir, '_warnings.json');
  if (warnings.length > 0) await writeJson(warningsPath, { generatedAt: new Date().toISOString(), warnings });
  else await fs.promises.unlink(warningsPath).catch(() => {});
  return { index, warnings };
}
