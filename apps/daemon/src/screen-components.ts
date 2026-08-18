// Màn hình → Component (dr-comp v2, workflow `docs-review`) — pure helpers +
// the deterministic pre-step.
//
// v1 fanned out per DOCUMENT PAGE and could only see a screen when the page
// declared it as a `Màn hình N: SCR-… — …` heading followed by a table with a
// "Kiểu hiển thị" column. Most PRDs describe screens in prose, so the stage
// came back empty. v2 takes the screen list from the FLOW stage (dr-flow —
// `flows/index.json[].screens`, the flowchart nodes that happen on each
// screen, and the UX findings that touch it), treats any structure table in
// the document as a REFERENCE only, and asks the agent for ONE thing per
// screen: which Design System components the screen should be built from,
// drawn as an ux-spec-style HTML wireframe (`wireframes/<SCREEN-KEY>.html`)
// plus a machine-checkable `comp/<SCREEN-KEY>.screen.json`.
//
// Consistency across screens comes from a role-map pass (one agent per
// feature, `comp/_role-map.json`: role → DS component) that every per-screen
// run must follow. Everything the agent may cite is checked here against the
// closed catalogue (`criteria/components.md`) and the flow's screen list;
// nothing is checked against the literal document text any more.
//
// Pure (no DB, no agent). The stage runner in server.ts owns the run
// lifecycle and calls into this module before / after each agent run.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { FlowchartDoc } from './flow-ux/to-flowchart.js';
import type { FlowIndexEntry, UxReview } from './flow-ux/index.js';

export const SCREEN_COMPONENTS_SCHEMA_VERSION = '2.0' as const;
export const SCREEN_INPUTS_FILE = 'comp/_inputs.json';
export const ROLE_MAP_FILE = 'comp/_role-map.json';

/** `comp/<SCREEN-KEY>.screen.json` */
export const screenDocRel = (key: string): string => `comp/${key}.screen.json`;
/** `wireframes/<SCREEN-KEY>.html` */
export const wireframeRel = (key: string): string => `wireframes/${key}.html`;

// ── Inputs (daemon → agent) ────────────────────────────────────────────────

export interface ScreenStep {
  id: string;
  type: 'start' | 'end' | 'action' | 'decision';
  label: string;
}

export interface ScreenNav {
  /** SCREEN-KEY of the destination screen. */
  to: string;
  /** Label of the step / edge that leaves this screen (what the user does). */
  via: string;
  /** Edge label(s) along the way (decision outcomes), if any. */
  condition?: string;
}

export interface ScreenInput {
  key: string;
  name: string;
  /** Position in the flow (BFS from start) — the rail order. */
  order: number;
  flowId: string;
  flowTitle: string;
  /** Markdown page (relative to cwd) the screen belongs to (from the key prefix). */
  source: string | null;
  /** Section of `source` that describes this screen, when one was found. */
  section?: { heading: string; startLine: number; endLine: number; excerpt: string };
  /** A screen-structure table found inside that section — REFERENCE only. */
  referenceTable?: string;
  /** Flowchart steps that happen on this screen. */
  steps: ScreenStep[];
  /** Ways out of this screen into other screens (→ `data-nav`). */
  navOut: ScreenNav[];
  /** Screens that lead here. */
  navIn: string[];
  /** UX findings (dr-flow) that touch this screen. */
  findings: { id: string; severity: string; title: string; recommendation?: string }[];
  /** 'mobile' | 'web' guess from the document wording — the agent decides. */
  platformHint: 'mobile' | 'web';
}

export interface ScreenComponentsInputs {
  schema_version: typeof SCREEN_COMPONENTS_SCHEMA_VERSION;
  generatedAt: string;
  ds: { components: boolean; catalog: boolean; rules: boolean; examples: boolean; figmaCatalog: boolean };
  screens: ScreenInput[];
  /** Why the list is empty / partial. */
  note?: string;
}

// ── Outputs (agent → daemon) ───────────────────────────────────────────────

export interface RoleMapEntry {
  role: string;
  /** DS component name as written in criteria/components.md (null = DS has nothing for it). */
  component: string | null;
  anchor?: string;
  variant?: string;
  when?: string;
  /** What to use instead when `component` is null. */
  fallback?: string;
}
export interface RoleMapDoc {
  schema_version: typeof SCREEN_COMPONENTS_SCHEMA_VERSION;
  platform: 'mobile' | 'web';
  roles: RoleMapEntry[];
  notes?: string[];
}

export type Provenance = 'text' | 'flow' | 'table' | 'ds';
export type Confidence = 'high' | 'medium' | 'low';

export interface ScreenElement {
  /** Stable id inside the screen — the wireframe block carries `data-el` = this. */
  id: string;
  label: string;
  role: string;
  ds: { component: string; anchor: string; variant?: string } | null;
  confidence: Confidence;
  provenance: Provenance;
  /** What the document's own table declared for it (reference only). */
  docType?: string;
  why?: string;
}

export interface ScreenComponentsDoc {
  schema_version: typeof SCREEN_COMPONENTS_SCHEMA_VERSION;
  key: string;
  name: string;
  flowId: string;
  platform: 'mobile' | 'web';
  source: string | null;
  elements: ScreenElement[];
  nav: { el: string; to: string }[];
  notes?: string[];
}

// ── Prepare ────────────────────────────────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}
async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}
async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function normalizeVi(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split `<prefix>__<code>` — the SCREEN-KEY convention shared with dr-flow. */
export function splitScreenKey(key: string): { prefix: string; code: string } | null {
  const i = key.lastIndexOf('__');
  if (i <= 0 || i + 2 >= key.length) return null;
  return { prefix: key.slice(0, i), code: key.slice(i + 2) };
}

/** Find the section of a page that describes a screen: a heading containing
 *  the screen code (`SCR-001`, `4.2.1`) or, failing that, the screen name.
 *  Returns 1-based inclusive line range up to the next heading of the same
 *  or a higher level. */
export function findScreenSection(
  md: string,
  code: string,
  name: string,
): { heading: string; startLine: number; endLine: number; excerpt: string; referenceTable?: string } | null {
  const lines = md.split(/\r?\n/);
  const headings: { line: number; level: number; text: string }[] = [];
  let fence: string | null = null;
  lines.forEach((raw, i) => {
    const f = /^\s*(```+|~~~+)/.exec(raw);
    if (f) {
      if (fence == null) fence = f[1]!;
      else if (raw.trim().startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const m = HEADING_RE.exec(raw);
    if (m) headings.push({ line: i, level: m[1]!.length, text: m[2]!.trim() });
  });
  const codeNorm = normalizeVi(code);
  const nameNorm = normalizeVi(name);
  const codeRe = new RegExp(`(^|[^\\w.])${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i');
  let hit =
    headings.find((h) => codeRe.test(h.text)) ??
    headings.find((h) => normalizeVi(h.text).includes(codeNorm) && codeNorm.length >= 3) ??
    (nameNorm.length >= 4 ? headings.find((h) => normalizeVi(h.text).includes(nameNorm)) : undefined);
  if (!hit) return null;
  const idx = headings.indexOf(hit);
  let end = lines.length - 1;
  for (let j = idx + 1; j < headings.length; j += 1) {
    if (headings[j]!.level <= hit.level) {
      end = headings[j]!.line - 1;
      break;
    }
  }
  const body = lines.slice(hit.line + 1, end + 1);
  // Reference table: a markdown table whose header row mentions "Kiểu hiển thị"
  // (or "Component"/"Loại") — the v1 contract, now advisory.
  let referenceTable: string | undefined;
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i]!;
    if (!l.trim().startsWith('|')) continue;
    const head = normalizeVi(l);
    if (!(head.includes('kieu hien thi') || head.includes('component') || head.includes('loai dieu khien'))) continue;
    let j = i;
    while (j < body.length && body[j]!.trim().startsWith('|')) j += 1;
    referenceTable = body.slice(i, j).join('\n');
    break;
  }
  const excerptSrc = body
    .filter((l) => !l.trim().startsWith('|') && l.trim() !== '')
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .trim();
  const excerpt = excerptSrc.length > 900 ? `${excerptSrc.slice(0, 900)}…` : excerptSrc;
  return {
    heading: lines[hit.line]!,
    startLine: hit.line + 1,
    endLine: end + 1,
    excerpt,
    ...(referenceTable ? { referenceTable } : {}),
  };
}

const MOBILE_HINT_RE = /\b(sdk|mobile|ios|android|app di động|ứng dụng di động|màn hình điện thoại|smartphone|super ?app|mini ?app|bottom sheet)\b/i;

/** Ways out of `key`: follow edges from a node on this screen through
 *  non-screen nodes (decisions, system steps) until another screen is
 *  reached (depth ≤ 4). */
function navOutOf(doc: FlowchartDoc, key: string): ScreenNav[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const out: ScreenNav[] = [];
  const seenTo = new Set<string>();
  const outEdges = (id: string) => doc.edges.filter((e) => e.from === id);
  for (const n of doc.nodes.filter((x) => x.screen === key)) {
    const walk = (id: string, via: string, cond: string[], depth: number, visited: Set<string>) => {
      if (depth > 4) return;
      for (const e of outEdges(id)) {
        const t = byId.get(e.to);
        if (!t || visited.has(t.id)) continue;
        const nextCond = e.label ? [...cond, e.label] : cond;
        if (t.screen && t.screen !== key) {
          const sig = `${t.screen}|${via}`;
          if (!seenTo.has(sig)) {
            seenTo.add(sig);
            out.push({ to: t.screen, via, ...(nextCond.length ? { condition: nextCond.join(' → ') } : {}) });
          }
          continue;
        }
        if (t.screen === key) continue;
        walk(t.id, via, nextCond, depth + 1, new Set([...visited, t.id]));
      }
    };
    walk(n.id, n.label, [], 0, new Set([n.id]));
  }
  return out;
}

export interface PrepareScreenInputsOptions {
  /** Doc pages of the run (`listDocPages`): mdPath relative to cwd + title. */
  pages: { mdPath: string; page: string }[];
}

/** Build `comp/_inputs.json` from the flow stage's outputs + the documents.
 *  Returns the inputs (also written to disk). `screens` is empty (with a
 *  `note`) when dr-flow has not produced any screen. */
export async function prepareScreenComponentInputs(
  cwd: string,
  opts: PrepareScreenInputsOptions,
): Promise<ScreenComponentsInputs> {
  const flowsDir = path.join(cwd, 'flows');
  const index = (await readJson<FlowIndexEntry[]>(path.join(flowsDir, 'index.json'))) ?? [];
  const pagesByStem = new Map<string, { mdPath: string; page: string }>();
  for (const p of opts.pages) pagesByStem.set(path.posix.basename(p.mdPath, '.md'), p);
  const mdCache = new Map<string, string | null>();
  const readMd = async (rel: string) => {
    if (!mdCache.has(rel)) mdCache.set(rel, await readText(path.join(cwd, rel)));
    return mdCache.get(rel) ?? null;
  };

  const screens: ScreenInput[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const entry of Array.isArray(index) ? index : []) {
    if (!entry || !Array.isArray(entry.screens) || entry.screens.length === 0) continue;
    const flowchart = entry.files?.flowchart ? await readJson<FlowchartDoc>(path.join(cwd, entry.files.flowchart)) : null;
    const review = await readJson<UxReview>(path.join(flowsDir, entry.id, 'ux-review.json'));
    const cellScreen = new Map<string, string>();
    for (const n of flowchart?.nodes ?? []) if (n.screen) cellScreen.set(n.id, n.screen);
    for (const s of entry.screens) {
      if (!s?.key || seen.has(s.key)) continue;
      seen.add(s.key);
      const parts = splitScreenKey(s.key);
      const page = parts ? pagesByStem.get(parts.prefix) ?? null : null;
      const md = page ? await readMd(page.mdPath) : null;
      const section = md && parts ? findScreenSection(md, parts.code, s.name) : null;
      const steps: ScreenStep[] = (flowchart?.nodes ?? [])
        .filter((n) => n.screen === s.key)
        .map((n) => ({ id: n.id, type: n.type, label: n.label }));
      const navOut = flowchart ? navOutOf(flowchart, s.key) : [];
      const findings = (review?.findings ?? [])
        .filter((f) => (f.cells?.asIs ?? []).some((c) => cellScreen.get(c) === s.key))
        .map((f) => ({ id: f.id, severity: f.severity, title: f.title, ...(f.recommendation ? { recommendation: f.recommendation } : {}) }));
      const platformHint: 'mobile' | 'web' = md && MOBILE_HINT_RE.test(md) ? 'mobile' : 'web';
      const input: ScreenInput = {
        key: s.key,
        name: s.name,
        order: order++,
        flowId: entry.id,
        flowTitle: entry.title,
        source: page?.mdPath ?? null,
        steps,
        navOut,
        navIn: [],
        findings,
        platformHint,
      };
      if (section) {
        input.section = { heading: section.heading, startLine: section.startLine, endLine: section.endLine, excerpt: section.excerpt };
        if (section.referenceTable) input.referenceTable = section.referenceTable;
      }
      screens.push(input);
    }
  }
  // navIn from navOut.
  const byKey = new Map(screens.map((s) => [s.key, s]));
  for (const s of screens) for (const n of s.navOut) byKey.get(n.to)?.navIn.push(s.key);
  for (const s of screens) s.navIn = [...new Set(s.navIn)];

  const criteria = path.join(cwd, 'criteria');
  const inputs: ScreenComponentsInputs = {
    schema_version: SCREEN_COMPONENTS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    ds: {
      components: await exists(path.join(criteria, 'components.md')),
      catalog: await exists(path.join(criteria, 'catalog.md')),
      rules: await exists(path.join(criteria, 'rules.md')),
      examples: await exists(path.join(criteria, 'examples.md')),
      figmaCatalog: await exists(path.join(cwd, '.figma-catalog', 'components.json')),
    },
    screens,
  };
  if (screens.length === 0) {
    inputs.note =
      index.length === 0
        ? 'Chưa có flows/index.json — chạy bước "Đánh giá luồng UX" (dr-flow) trước.'
        : 'Bước Đánh giá luồng UX chưa gắn màn hình nào (screens.json rỗng) — chạy lại dr-flow với gắn màn.';
  }
  await fs.mkdir(path.join(cwd, 'comp'), { recursive: true });
  await fs.writeFile(path.join(cwd, SCREEN_INPUTS_FILE), JSON.stringify(inputs, null, 2), 'utf8');
  return inputs;
}

// ── Parse + validate ───────────────────────────────────────────────────────

const PLATFORMS = new Set(['mobile', 'web']);
const CONFIDENCES = new Set<Confidence>(['high', 'medium', 'low']);
const PROVENANCES = new Set<Provenance>(['text', 'flow', 'table', 'ds']);

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function parseRoleMap(raw: string): { doc: RoleMapDoc } | { errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { errors: [`_role-map.json không phải JSON hợp lệ: ${(e as Error).message}`] };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { errors: ['_role-map.json phải là một object.'] };
  const o = json as Record<string, unknown>;
  const errors: string[] = [];
  const platform = str(o.platform);
  if (!PLATFORMS.has(platform)) errors.push(`"platform" phải là "mobile" | "web" (nhận "${platform}").`);
  if (!Array.isArray(o.roles) || o.roles.length === 0) errors.push('"roles" phải là mảng không rỗng.');
  const roles: RoleMapEntry[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(o.roles) ? o.roles : []) {
    if (!r || typeof r !== 'object') {
      errors.push('Một mục "roles" không phải object.');
      continue;
    }
    const e = r as Record<string, unknown>;
    const role = str(e.role);
    if (!role) {
      errors.push('Một mục "roles" thiếu "role".');
      continue;
    }
    if (seen.has(role)) errors.push(`role "${role}" bị khai hai lần.`);
    seen.add(role);
    const component = e.component == null ? null : str(e.component) || null;
    const entry: RoleMapEntry = { role, component };
    if (str(e.anchor)) entry.anchor = str(e.anchor);
    if (str(e.variant)) entry.variant = str(e.variant);
    if (str(e.when)) entry.when = str(e.when);
    if (str(e.fallback)) entry.fallback = str(e.fallback);
    roles.push(entry);
  }
  if (errors.length) return { errors };
  const doc: RoleMapDoc = { schema_version: SCREEN_COMPONENTS_SCHEMA_VERSION, platform: platform as 'mobile' | 'web', roles };
  if (Array.isArray(o.notes)) doc.notes = o.notes.filter((n): n is string => typeof n === 'string');
  return { doc };
}

/** `catalog` = name → `criteria/components.md#anchor` (collectComponentCatalog). */
export function validateRoleMap(doc: RoleMapDoc, catalog: Map<string, string>): string[] {
  const errors: string[] = [];
  if (catalog.size === 0) {
    for (const r of doc.roles) if (r.component) errors.push(`role "${r.role}": không có danh mục DS nên "component" phải là null (nhận "${r.component}").`);
    return errors;
  }
  const anchorOf = (ruleId: string) => ruleId.slice(ruleId.indexOf('#') + 1);
  for (const r of doc.roles) {
    if (r.component == null) continue;
    const ruleId = catalog.get(r.component);
    if (!ruleId) errors.push(`role "${r.role}": component "${r.component}" không có trong criteria/components.md.`);
    else if (r.anchor && r.anchor !== anchorOf(ruleId)) errors.push(`role "${r.role}": anchor "${r.anchor}" không phải anchor của "${r.component}" ("${anchorOf(ruleId)}").`);
  }
  return errors;
}

export function parseScreenComponentsDoc(raw: string): { doc: ScreenComponentsDoc } | { errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { errors: [`screen.json không phải JSON hợp lệ: ${(e as Error).message}`] };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { errors: ['screen.json phải là một object.'] };
  const o = json as Record<string, unknown>;
  const errors: string[] = [];
  const key = str(o.key);
  if (!key) errors.push('Thiếu "key" (SCREEN-KEY).');
  const platform = str(o.platform);
  if (!PLATFORMS.has(platform)) errors.push(`"platform" phải là "mobile" | "web" (nhận "${platform}").`);
  if (!Array.isArray(o.elements)) errors.push('"elements" phải là mảng.');
  const elements: ScreenElement[] = [];
  const ids = new Set<string>();
  for (const [i, e] of (Array.isArray(o.elements) ? o.elements : []).entries()) {
    if (!e || typeof e !== 'object') {
      errors.push(`elements[${i}] không phải object.`);
      continue;
    }
    const el = e as Record<string, unknown>;
    const id = str(el.id);
    const label = str(el.label);
    const role = str(el.role);
    if (!id) errors.push(`elements[${i}] thiếu "id".`);
    else if (!/^[A-Za-z0-9_.-]+$/.test(id)) errors.push(`elements[${i}] "id" chỉ gồm chữ/số/_/-/. (nhận "${id}").`);
    else if (ids.has(id)) errors.push(`elements[${i}] "id" "${id}" bị trùng.`);
    ids.add(id);
    if (!label) errors.push(`elements[${i}] (${id}) thiếu "label".`);
    if (!role) errors.push(`elements[${i}] (${id}) thiếu "role".`);
    let ds: ScreenElement['ds'] = null;
    if (el.ds != null) {
      if (typeof el.ds !== 'object') errors.push(`elements[${i}] (${id}) "ds" phải là object hoặc null.`);
      else {
        const d = el.ds as Record<string, unknown>;
        const component = str(d.component);
        const anchor = str(d.anchor);
        if (!component || !anchor) errors.push(`elements[${i}] (${id}) "ds" cần cả "component" lẫn "anchor".`);
        ds = { component, anchor, ...(str(d.variant) ? { variant: str(d.variant) } : {}) };
      }
    }
    const confidence = str(el.confidence) as Confidence;
    const provenance = str(el.provenance) as Provenance;
    const entry: ScreenElement = {
      id,
      label,
      role,
      ds,
      confidence: CONFIDENCES.has(confidence) ? confidence : 'medium',
      provenance: PROVENANCES.has(provenance) ? provenance : 'text',
    };
    if (str(el.docType)) entry.docType = str(el.docType);
    if (str(el.why)) entry.why = str(el.why);
    elements.push(entry);
  }
  const nav: { el: string; to: string }[] = [];
  for (const [i, n] of (Array.isArray(o.nav) ? o.nav : []).entries()) {
    if (!n || typeof n !== 'object') continue;
    const nn = n as Record<string, unknown>;
    const el = str(nn.el);
    const to = str(nn.to);
    if (!el || !to) errors.push(`nav[${i}] cần "el" và "to".`);
    else if (!ids.has(el)) errors.push(`nav[${i}]: "el" "${el}" không phải id element nào của màn.`);
    else nav.push({ el, to });
  }
  if (errors.length) return { errors };
  const doc: ScreenComponentsDoc = {
    schema_version: SCREEN_COMPONENTS_SCHEMA_VERSION,
    key,
    name: str(o.name),
    flowId: str(o.flowId),
    platform: platform as 'mobile' | 'web',
    source: str(o.source) || null,
    elements,
    nav,
  };
  if (Array.isArray(o.notes)) doc.notes = o.notes.filter((n): n is string => typeof n === 'string');
  return { doc };
}

export interface ValidateScreenContext {
  /** The SCREEN-KEY this run was asked to produce. */
  expectedKey: string;
  /** Every screen key of the feature (for `nav[].to`). */
  screenKeys: ReadonlySet<string>;
  /** name → `criteria/components.md#anchor`; empty when no DS. */
  catalog: Map<string, string>;
  /** Wireframe HTML the agent wrote (null = missing). */
  wireframeHtml: string | null;
}

/** All `data-comp` / `data-el` / `data-nav` values in a wireframe. */
export function scanWireframe(html: string): { screen: string | null; layout: string | null; comps: string[]; els: string[]; navs: string[]; hasScript: boolean; hasStyle: boolean } {
  const attr = (name: string) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map((m) => m[1]!.trim());
  const body = /<body\b([^>]*)>/i.exec(html)?.[1] ?? '';
  const bodyAttr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(body)?.[1]?.trim() ?? null;
  return {
    screen: bodyAttr('data-screen'),
    layout: bodyAttr('data-layout'),
    comps: attr('data-comp').filter(Boolean),
    els: attr('data-el').filter(Boolean),
    navs: attr('data-nav').filter(Boolean),
    hasScript: /<script\b/i.test(html),
    hasStyle: /<style\b/i.test(html),
  };
}

export function validateScreenComponentsDoc(doc: ScreenComponentsDoc, ctx: ValidateScreenContext): string[] {
  const errors: string[] = [];
  if (doc.key !== ctx.expectedKey) errors.push(`"key" phải là "${ctx.expectedKey}" (nhận "${doc.key}").`);
  const anchors = new Set([...ctx.catalog.values()].map((r) => r.slice(r.indexOf('#') + 1)));
  const hasCatalog = ctx.catalog.size > 0;
  for (const el of doc.elements) {
    if (!el.ds) continue;
    if (!hasCatalog) {
      errors.push(`element "${el.id}": không có danh mục DS (criteria/components.md) nên "ds" phải là null.`);
      continue;
    }
    const ruleId = ctx.catalog.get(el.ds.component);
    if (!ruleId) errors.push(`element "${el.id}": component "${el.ds.component}" không có trong criteria/components.md.`);
    else if (el.ds.anchor !== ruleId.slice(ruleId.indexOf('#') + 1)) errors.push(`element "${el.id}": anchor "${el.ds.anchor}" không phải anchor của "${el.ds.component}".`);
  }
  for (const n of doc.nav) {
    if (!ctx.screenKeys.has(n.to)) errors.push(`nav "${n.el}" → "${n.to}": không phải SCREEN-KEY nào của luồng.`);
  }
  if (ctx.wireframeHtml == null) {
    errors.push(`Thiếu wireframe "${wireframeRel(doc.key)}".`);
    return errors;
  }
  const w = scanWireframe(ctx.wireframeHtml);
  if (!/^\s*<!doctype html>/i.test(ctx.wireframeHtml)) errors.push('Wireframe phải bắt đầu bằng "<!doctype html>".');
  if (w.hasScript) errors.push('Wireframe không được chứa <script>.');
  if (!w.hasStyle) errors.push('Wireframe thiếu <style> (chép wireframes/_wireframe.css vào).');
  if (w.screen !== doc.key) errors.push(`Wireframe: <body data-screen> phải là "${doc.key}" (nhận "${w.screen ?? ''}").`);
  if (w.layout && w.layout !== doc.platform) errors.push(`Wireframe: data-layout "${w.layout}" khác "platform" trong JSON ("${doc.platform}").`);
  if (hasCatalog) for (const c of new Set(w.comps)) if (!anchors.has(c)) errors.push(`Wireframe: data-comp="${c}" không phải anchor nào trong criteria/components.md.`);
  const elIds = new Set(doc.elements.map((e) => e.id));
  for (const id of new Set(w.els)) if (!elIds.has(id)) errors.push(`Wireframe: data-el="${id}" không có trong elements[] của JSON.`);
  const missing = doc.elements.filter((e) => !w.els.includes(e.id));
  if (missing.length) errors.push(`Wireframe thiếu block data-el cho ${missing.length} element: ${missing.slice(0, 6).map((e) => e.id).join(', ')}${missing.length > 6 ? '…' : ''}.`);
  for (const t of new Set(w.navs)) if (!ctx.screenKeys.has(t)) errors.push(`Wireframe: data-nav="${t}" không phải SCREEN-KEY nào của luồng.`);
  return errors;
}

// ── Merge ──────────────────────────────────────────────────────────────────

export interface ScreenComponentsIndexEntry {
  key: string;
  name: string;
  flowId: string;
  order: number;
  platform: 'mobile' | 'web';
  source: string | null;
  elements: number;
  mapped: number;
  files: { screen: string; wireframe: string };
  navOut: string[];
}

export interface ScreenComponentsIndex {
  schema_version: typeof SCREEN_COMPONENTS_SCHEMA_VERSION;
  generatedAt: string;
  roleMap: string;
  screens: ScreenComponentsIndexEntry[];
  failed: { key: string; name: string; errors: string[] }[];
}

const CONF_VI: Record<Confidence, string> = { high: 'cao', medium: 'vừa', low: 'thấp' };

export function mergeScreenComponents(
  docs: ScreenComponentsDoc[],
  inputs: ScreenComponentsInputs,
  failed: { key: string; name: string; errors: string[] }[],
  generatedAt: string,
): { index: ScreenComponentsIndex; summaryMd: string } {
  const orderOf = new Map(inputs.screens.map((s) => [s.key, s.order]));
  const nameOf = new Map(inputs.screens.map((s) => [s.key, s.name]));
  const sorted = [...docs].sort((a, b) => (orderOf.get(a.key) ?? 1e9) - (orderOf.get(b.key) ?? 1e9));
  const screens: ScreenComponentsIndexEntry[] = sorted.map((d) => ({
    key: d.key,
    name: d.name || nameOf.get(d.key) || d.key,
    flowId: d.flowId,
    order: orderOf.get(d.key) ?? 1e9,
    platform: d.platform,
    source: d.source,
    elements: d.elements.length,
    mapped: d.elements.filter((e) => e.ds).length,
    files: { screen: screenDocRel(d.key), wireframe: wireframeRel(d.key) },
    navOut: [...new Set(d.nav.map((n) => n.to))],
  }));
  const index: ScreenComponentsIndex = { schema_version: SCREEN_COMPONENTS_SCHEMA_VERSION, generatedAt, roleMap: ROLE_MAP_FILE, screens, failed };

  const lines: string[] = ['# Màn hình → Component', ''];
  lines.push(`${screens.length} màn hình có đề xuất component; ${failed.length} màn chạy hỏng.`, '');
  lines.push('| # | Màn hình | Nền tảng | Element | Đã map DS | Điều hướng tới |', '|---|---|---|---|---|---|');
  screens.forEach((s, i) => lines.push(`| ${i + 1} | ${s.name} (\`${s.key}\`) | ${s.platform} | ${s.elements} | ${s.mapped} | ${s.navOut.join(', ') || '—'} |`));
  lines.push('');
  for (const d of sorted) {
    lines.push(`## ${d.name || d.key}`, '', `Wireframe: \`${wireframeRel(d.key)}\``, '');
    lines.push('| Element | Vai trò | Component DS | Biến thể | Tin cậy | Nguồn |', '|---|---|---|---|---|---|');
    for (const e of d.elements) {
      lines.push(`| ${e.label} | ${e.role} | ${e.ds ? e.ds.component : '—'} | ${e.ds?.variant ?? '—'} | ${CONF_VI[e.confidence]} | ${e.provenance}${e.docType ? ` (tài liệu khai: ${e.docType})` : ''} |`);
    }
    if (d.notes?.length) lines.push('', ...d.notes.map((n) => `- ${n}`));
    lines.push('');
  }
  if (failed.length) {
    lines.push('## Màn chạy hỏng', '');
    for (const f of failed) lines.push(`- **${f.name}** (\`${f.key}\`): ${f.errors.join('; ')}`);
    lines.push('');
  }
  return { index, summaryMd: `${lines.join('\n').trim()}\n` };
}
