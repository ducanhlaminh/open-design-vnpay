// Customer Journey + UX Research — per-SECTION parallel fan-out helpers.
//
// A whole-product doc tree (e.g. a full accounting suite: 13 top-level modules,
// 69 pages) is too much for one agent to synthesize completely — a single CJ /
// UX-Research run front-loads the pages it read first and silently drops the
// back half. So when the docs came from a sub-tree scan (multiple top-level
// SECTIONS), the daemon fans these stages out per section: one agent run per
// module, each producing that module's slice, then the daemon merges the slices
// into the canonical output the downstream stages read.
//
// A SECTION is a top-level group under docs/confluence/ — the section's own
// overview page (`<Section>.md`) plus everything under its `<Section>/` folder.
// Unlike the per-PAGE review fan-out, sections are the coarser unit so each run
// keeps within-module cross-page context (a journey spans several pages).
//
// This module holds the PURE pieces (section grouping + the two merges); the
// run-lifecycle orchestration lives in server.ts.

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** A top-level doc section = one fan-out unit. */
export interface DocSection {
  /** Section key = the top-level path segment (folder name or top-level file
   *  stem) under docs/confluence, e.g. `I.-T-i-kho-n`. Stable + filesystem-safe. */
  key: string;
  /** Human title (the section overview page's frontmatter title, else the key). */
  title: string;
  /** Every md page in this section, relative to cwd. */
  mdPaths: string[];
}

/** Group key for a page = its first path segment under docs/confluence/. A
 *  top-level file `I.-T-i-kho-n.md` and the folder `I.-T-i-kho-n/` share the
 *  key `I.-T-i-kho-n`, so a section's overview page and its children group
 *  together. */
export function sectionKey(mdRelPath: string): string {
  const rest = mdRelPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^docs\/confluence\//, '');
  const parts = rest.split('/');
  return parts.length > 1 ? parts[0]! : parts[0]!.replace(/\.md$/i, '');
}

function titleFromFrontmatter(md: string, fallback: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (m) {
    const t = /^title:\s*(.+)$/m.exec(m[1]!);
    if (t?.[1]) return t[1].trim();
  }
  return fallback;
}

/** List all markdown pages under docs/confluence (excluding _index.md and
 *  anything under attachments/), each with its title. */
async function listPages(cwd: string): Promise<Array<{ mdPath: string; title: string }>> {
  const root = path.join(cwd, 'docs', 'confluence');
  const out: Array<{ mdPath: string; title: string }> = [];
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
      const mdPath = path.relative(cwd, abs).replace(/\\/g, '/');
      out.push({ mdPath, title: titleFromFrontmatter(md, path.basename(e.name, path.extname(e.name))) });
    }
  };
  await walk(root);
  return out;
}

/** Group the doc pages into top-level sections. The section title prefers its
 *  overview page (the top-level `<key>.md`, whose mdPath == docs/confluence/<key>.md). */
export async function listSections(cwd: string): Promise<DocSection[]> {
  const pages = await listPages(cwd);
  const byKey = new Map<string, { key: string; title?: string; mdPaths: string[] }>();
  for (const p of pages) {
    const key = sectionKey(p.mdPath);
    let g = byKey.get(key);
    if (!g) {
      g = { key, mdPaths: [] };
      byKey.set(key, g);
    }
    g.mdPaths.push(p.mdPath);
    // The section overview page (docs/confluence/<key>.md) names the section.
    if (p.mdPath === `docs/confluence/${key}.md`) g.title = p.title;
  }
  return [...byKey.values()]
    .map((g) => ({ key: g.key, title: g.title ?? g.key.replace(/[-_]+/g, ' ').trim(), mdPaths: g.mdPaths.sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

const normName = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Merge per-section customer-journey slices into one product journey doc.
 *  Personas are product-wide → unioned deduped by normalized name (first-wins,
 *  so the earliest section's phrasing stays canonical). Journeys are per-module
 *  → concatenated in section order, each tagged with its section title so the
 *  reader knows which module it belongs to. */
export function mergeCjSections(
  sections: Array<{ key: string; title: string; cj: any | null }>,
): object {
  const personas: any[] = [];
  const seenPersona = new Set<string>();
  const journeys: any[] = [];
  for (const s of sections) {
    if (!s.cj) continue;
    for (const p of Array.isArray(s.cj.personas) ? s.cj.personas : []) {
      const name = typeof p?.name === 'string' ? p.name : typeof p?.role === 'string' ? p.role : '';
      const key = normName(name || JSON.stringify(p));
      if (seenPersona.has(key)) continue;
      seenPersona.add(key);
      personas.push(p);
    }
    for (const j of Array.isArray(s.cj.journeys) ? s.cj.journeys : []) {
      journeys.push({ ...j, section: j?.section ?? s.title });
    }
  }
  return {
    $comment: 'Merged per-section customer journeys (daemon fan-out). Personas unioned by name; journeys concatenated per module.',
    personas,
    journeys,
  };
}

/** Merge per-section UX-research slices into one report. Criteria ids
 *  (UXR-01…) are LOCAL to each section run so they collide — renumber them
 *  GLOBALLY on merge (UXR-01, UXR-02, … across all sections) and rewrite every
 *  reference's `used_for` through the per-section id remap. References dedup by
 *  url. Summary counts are recomputed. */
export function mergeUxrSections(
  sections: Array<{ key: string; title: string; uxr: any | null }>,
): { report: object; reportMd: string } {
  const criteria: any[] = [];
  const references: any[] = [];
  const refByUrl = new Map<string, any>();
  let n = 0;
  for (const s of sections) {
    if (!s.uxr) continue;
    const idRemap = new Map<string, string>();
    for (const c of Array.isArray(s.uxr.criteria) ? s.uxr.criteria : []) {
      n += 1;
      const newId = `UXR-${String(n).padStart(2, '0')}`;
      if (typeof c?.id === 'string') idRemap.set(c.id, newId);
      criteria.push({ ...c, id: newId, section: c?.section ?? s.title });
    }
    for (const r of Array.isArray(s.uxr.references) ? s.uxr.references : []) {
      const usedFor = Array.isArray(r?.used_for) ? r.used_for.map((id: string) => idRemap.get(id) ?? id) : r?.used_for;
      const url = typeof r?.url === 'string' ? r.url : '';
      if (url && refByUrl.has(url)) {
        // Same source cited by several sections → union its used_for ids.
        const existing = refByUrl.get(url);
        existing.used_for = Array.from(new Set([...(existing.used_for ?? []), ...(usedFor ?? [])]));
        continue;
      }
      const ref = { ...r, ...(usedFor ? { used_for: usedFor } : {}) };
      if (url) refByUrl.set(url, ref);
      references.push(ref);
    }
  }
  const count = (p: string) => criteria.filter((c) => c?.priority === p).length;
  const report = {
    kind: 'ux-research-report',
    version: 1,
    $comment: 'Merged per-section UX research (daemon fan-out). Criteria renumbered globally; references deduped by url.',
    summary: { criteria: criteria.length, must: count('must'), should: count('should'), nice: count('nice') },
    criteria,
    references,
  };
  let reportMd = `# UX Research — ${criteria.length} tiêu chí (${count('must')} bắt buộc)\n\n`;
  reportMd += `Tổng hợp từ ${sections.filter((s) => s.uxr).length} module.\n\n`;
  for (const c of criteria) {
    reportMd += `- **${c.id}** (${c.priority ?? '—'}) — ${c.title ?? ''}${c.section ? ` _(${c.section})_` : ''}\n`;
  }
  return { report, reportMd };
}
