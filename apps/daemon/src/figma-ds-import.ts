// Figma IR design-system import. Turns one or more fig-export IR JSON files
// (exported by the design-v3 `fig-export` Figma plugin, typically a
// foundation/token file plus a component-library file) into a user
// design-system project folder that carries BOTH the prompt-facing files every
// design system ships (DESIGN.md, tokens.css, components.html) AND a
// vendorable plain-React source bundle under react/ compiled by the vendored
// fig-import compiler (the same compiler behind the plugin's one-click .zip).
//
// Inputs may be raw `.ir.json` files OR the `.zip` bundle downloaded straight
// from the plugin (the zip carries its ir.json; we extract it, matching
// upstream merge-react.mjs). Merge order is last-writer-wins on duplicate
// tokens/icons and follows NATURAL FILENAME ORDER (the upstream convention:
// prefix files 01-, 02-, … with the foundation/token export first) — browser
// FileList order is OS-dependent, so filenames are the deterministic contract.
// Re-importing replaces react/ and ir/ wholesale — the compiler has no
// edit-preserving regeneration, every import is a new version.

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import { extractComponentsManifest } from '@open-design/contracts';

import { LocalDesignSystemImportError } from './design-system-import.js';
import { compileIR } from './vendor/fig-import/compile-core.js';
import { mergeIRs } from './vendor/fig-import/merge-ir.js';
import { writeDsRulesFile } from './ds-criteria.js';

export type FigmaIRImportFile = {
  /** Original upload filename, used for ordering, merge warnings and ir/ persistence. */
  filename: string;
  /** Raw .ir.json text, or the plugin's .zip bundle bytes (ir.json inside). */
  content: string | Buffer;
};

export type FigmaIRImportOptions = {
  now?: Date;
  /** Display name override; defaults to the merged IR's Figma file name. */
  name?: string;
  reservedIds?: Iterable<string>;
  craftApplies?: string[];
};

export type FigmaIRImportSummary = {
  componentSets: number;
  components: number;
  icons: number;
  variables: number;
  tokenClasses: number;
  assets: number;
  /** IMAGE fills embedded with real bytes (assets/images/ + data URIs). */
  images: number;
  /** IMAGE fills the IR had no bytes for (old plugin export) — dropped. */
  missingImages: number;
  errors: string[];
  sources: Array<{ filename: string; figmaFile: string }>;
};

export type FigmaIRImportResult = {
  id: string;
  dir: string;
  warnings: string[];
  summary: FigmaIRImportSummary;
  criteria: { rules: boolean };
};

/** globals.css layout marker written by compile-core (tokens above, tk-* below). */
const TK_SECTION_MARKER = '/* ---------- token utility classes (tk-*) ---------- */';

export async function importFigmaIRDesignSystem(
  files: FigmaIRImportFile[],
  userDesignSystemsRoot: string,
  options: FigmaIRImportOptions = {},
): Promise<FigmaIRImportResult> {
  const mdFiles = files.filter((file) => file.filename.toLowerCase().endsWith('.md'));
  const irFiles = files.filter((file) => !file.filename.toLowerCase().endsWith('.md'));
  if (mdFiles.length > 1) {
    throw new LocalDesignSystemImportError('BAD_REQUEST', `chỉ nhận 1 file rules .md kèm theo (nhận được ${mdFiles.length})`);
  }
  if (irFiles.length === 0) {
    throw new LocalDesignSystemImportError('BAD_REQUEST', 'at least one .ir.json or plugin .zip file is required');
  }

  // Natural filename order (upstream merge-react convention: 01-, 02-, …) so
  // the merge order never depends on browser/OS file-picker ordering.
  const ordered = [...irFiles].sort((a, b) =>
    a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' }),
  );

  const sourceTexts = ordered.map((file) => ({
    filename: file.filename,
    json: irJsonText(file),
  }));
  const inputs = sourceTexts.map((file) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.json);
    } catch {
      throw new LocalDesignSystemImportError('BAD_REQUEST', `${file.filename}: not valid JSON`);
    }
    return { ir: parsed, filename: file.filename };
  });

  // mergeIRs validates each IR (meta.file + array shapes) and resolves
  // cross-file token bindings; single-file imports go through the same path so
  // warnings/tokenLinks reporting is uniform.
  let merged: { ir: any; warnings: string[] };
  try {
    merged = mergeIRs(inputs);
  } catch (err: any) {
    throw new LocalDesignSystemImportError('BAD_REQUEST', String(err?.message ?? err));
  }

  let compiled: { files: Array<{ path: string; content: string }>; summary: any };
  try {
    compiled = compileIR(merged.ir) as typeof compiled;
  } catch (err: any) {
    throw new LocalDesignSystemImportError('INTERNAL_ERROR', `IR compile failed: ${String(err?.message ?? err)}`);
  }
  enrichShowcaseIconAssets(compiled.files, merged.ir);
  // Wireframe mapping first, then scaffolding — each inserts before the first
  // component heading, so the LAST call ends up on top (Screen scaffolding →
  // Wireframe mapping → per-component tables).
  injectWireframeMappingSection(compiled.files);
  injectScaffoldingCatalogSection(compiled.files);
  const { summary } = compiled;

  const displayName = cleanDisplayName(options.name ?? defaultDisplayName(merged.ir));
  const id = await nextAvailableSlug(userDesignSystemsRoot, slugify(displayName), options.reservedIds);
  const outDir = path.join(userDesignSystemsRoot, id);
  await mkdir(outDir, { recursive: true });

  // React bundle. rm first so a re-import into a pre-existing folder (future
  // "replace" flows) never leaves stale generated files behind.
  const reactDir = path.join(outDir, 'react');
  await rm(reactDir, { recursive: true, force: true });
  const madeDirs = new Set<string>();
  for (const file of compiled.files) {
    const dest = path.join(reactDir, file.path);
    const destDir = path.dirname(dest);
    if (!madeDirs.has(destDir)) {
      await mkdir(destDir, { recursive: true });
      madeDirs.add(destDir);
    }
    await writeFile(dest, file.content, 'utf8');
  }

  // Source IRs — kept so the bundle can be re-compiled, diffed, or partially
  // re-imported (send only the changed file next time) without Figma access.
  const irDir = path.join(outDir, 'ir');
  await rm(irDir, { recursive: true, force: true });
  await mkdir(irDir, { recursive: true });
  const irFileNames: string[] = [];
  for (const file of sourceTexts) {
    // Zips persist as their extracted ir.json so ir/ stays uniformly diffable
    // and partially re-importable regardless of how the file was uploaded.
    const irName = uniqueIrFileName(file.filename, irFileNames);
    irFileNames.push(irName);
    await writeFile(path.join(irDir, irName), file.json, 'utf8');
  }

  const globalsCss = compiled.files.find((file) => file.path === 'styles/globals.css')?.content ?? '';
  const tokensCss = tokensOnlyCss(globalsCss);
  const swatches = extractColorSwatches(merged.ir);
  const sources = (merged.ir?.meta?.files ?? []).map((entry: any, index: number) => ({
    filename: String(entry?.filename ?? sourceTexts[index]?.filename ?? `IR #${index + 1}`),
    figmaFile: String(entry?.name ?? ''),
  }));
  const warnings = [...(merged.warnings ?? [])];

  // mergeIRs rebuilds meta from scratch, so per-export image notes only exist
  // on the source IRs. Surface them here or an oversized image silently comes
  // back as a lower-resolution render with no trace of why.
  for (const input of inputs) {
    const meta = (input.ir as any)?.meta;
    const shrunk = Number(meta?.imagesShrunk ?? 0);
    const skipped = Number(meta?.imagesSkipped ?? 0);
    if (shrunk > 0 || skipped > 0) {
      warnings.push(
        `${input.filename}: ${shrunk} image(s) re-rendered smaller, ${skipped} skipped by the export image budget`,
      );
    }
    for (const note of (meta?.imageNotes ?? []).slice(0, 10)) warnings.push(`${input.filename}: ${String(note)}`);
  }
  if (Number(summary.missingImages ?? 0) > 0) {
    warnings.push(
      `${summary.missingImages} IMAGE fill(s) had no bytes in the IR (gray placeholders dropped) — re-export with the latest Fig Pipeline plugin to include real images`,
    );
  }

  const styleGuideMd = compiled.files.find((file) => file.path === 'STYLE-GUIDE.md')?.content ?? '';
  const catalogMd = compiled.files.find((file) => file.path === 'docs/catalog.md')?.content ?? '';
  // Figma components suffixed `_example` compile to examples/<slug>.tsx instead
  // of components/ui/ — production-shaped layouts an agent reads to learn how
  // the pieces fit together, never imported into a screen.
  const exampleCount = compiled.files.filter((file) => file.path.startsWith('examples/')).length;
  const designMd = renderDesignMd(
    displayName,
    summary,
    sources,
    swatches,
    warnings,
    styleGuideMd,
    catalogMd,
    exampleCount,
  );
  const componentsHtml = renderComponentsHtml(displayName, summary);
  const componentsManifest = extractComponentsManifest({
    brandId: id,
    fixtureHtml: componentsHtml,
    tokensCss,
  });

  await writeFile(path.join(outDir, 'DESIGN.md'), designMd, 'utf8');
  await writeFile(path.join(outDir, 'tokens.css'), tokensCss, 'utf8');
  await writeFile(path.join(outDir, 'components.html'), componentsHtml, 'utf8');
  await writeFile(path.join(outDir, 'USAGE.md'), renderUsageMd(displayName, summary), 'utf8');
  await writeFile(
    path.join(outDir, 'components.manifest.json'),
    `${JSON.stringify(componentsManifest, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify(
      renderManifest(id, displayName, summary, sources, irFileNames, options, exampleCount),
      null,
      2,
    )}\n`,
    'utf8',
  );

  if (mdFiles[0]) warnings.push(...await writeDsRulesFile(outDir, Buffer.isBuffer(mdFiles[0].content) ? mdFiles[0].content.toString('utf8') : mdFiles[0].content));

  return {
    id,
    dir: outDir,
    warnings,
    criteria: { rules: Boolean(mdFiles[0]) },
    summary: {
      componentSets: Number(summary.totalSets ?? 0),
      components: Number(summary.components ?? 0),
      icons: Number(summary.icons ?? 0),
      variables: Number(summary.variables ?? 0),
      tokenClasses: Number(summary.tokenClasses ?? 0),
      assets: Number(summary.assets ?? 0),
      images: Number(summary.images ?? 0),
      missingImages: Number(summary.missingImages ?? 0),
      errors: (summary.errors ?? []).map(String),
      sources,
    },
  };
}

// Local patch on top of the verbatim vendored compiler: the showcase icon
// GALLERY renders every __FIG_ICONS__ entry by name, but upstream's
// showcase-data.js only inlines component-referenced assets, so icons no
// component uses render as empty boxes (in the real app they live inside
// components/icons/*.tsx and are unaffected). Backfill the missing icon SVGs
// from the merged IR's asset map. No-ops once upstream ships them itself.
function enrichShowcaseIconAssets(files: Array<{ path: string; content: string }>, ir: any): void {
  const dataFile = files.find((file) => file.path === 'showcase/showcase-data.js');
  if (!dataFile) return;
  const assetsMatch = /window\.__FIG_ASSETS__ = (.*?);\n/.exec(dataFile.content);
  const iconsMatch = /window\.__FIG_ICONS__ = (.*?);\n/.exec(dataFile.content);
  if (!assetsMatch?.[1] || !iconsMatch?.[1]) return;
  let assets: Record<string, string>;
  let icons: Record<string, string>;
  try {
    assets = JSON.parse(assetsMatch[1]);
    icons = JSON.parse(iconsMatch[1]);
  } catch {
    return;
  }
  const allAssets: Record<string, string> = ir?.assets ?? {};
  let added = 0;
  for (const hash of Object.values(icons)) {
    if (!assets[hash] && allAssets[hash]) {
      assets[hash] = allAssets[hash];
      added += 1;
    }
  }
  if (added === 0) return;
  dataFile.content = `window.__FIG_ASSETS__ = ${JSON.stringify(assets)};\nwindow.__FIG_ICONS__ = ${JSON.stringify(icons)};\n`;
}

// Scaffold role → normalized-substring keys matched against the compiled
// component slugs. Mirrors the family keys in
// skills/ui-react-ds/builder/verify.mjs — keep the two lists in sync so what
// the catalog advertises is exactly what the gate enforces.
const SCAFFOLD_ROLES: Array<{ role: string; keys: string[] }> = [
  { role: 'App bar / top navigation', keys: ['appbar', 'topnavigationbar', 'topbar'] },
  { role: 'Tab bar / bottom navigation', keys: ['tabbar', 'tabs', 'tabitem', 'bottomnavigation'] },
  { role: 'Dialog', keys: ['dialog', 'modal'] },
  { role: 'Bottom sheet / drawer', keys: ['bottomsheet', 'actionsheet', 'drawer'] },
  { role: 'Snackbar / toast', keys: ['snackbar', 'toast'] },
  { role: 'Card', keys: ['card'] },
  { role: 'List item', keys: ['listitem'] },
  { role: 'Button', keys: ['button'] },
  { role: 'Input / form field', keys: ['input', 'textfield'] },
];

// The ui-react-ds SKILL sends the agent to a "Screen scaffolding" section at
// the top of catalog.md to map screen-frame roles (dialog, sheet, app bar…)
// onto THIS design system's own component names — Figma imports never use the
// generic names, so without the map the agent hand-rolls frames the DS already
// ships. compile-core does not generate the section; inject it right after the
// catalog header. No-ops if upstream ever ships its own.
function injectScaffoldingCatalogSection(files: Array<{ path: string; content: string }>): void {
  const catalog = files.find((file) => file.path === 'docs/catalog.md');
  if (!catalog || catalog.content.includes('## Screen scaffolding')) return;
  const slugs = files
    .filter((file) => /^components\/ui\/[^/]+\.tsx$/.test(file.path))
    .map((file) => file.path.slice('components/ui/'.length, -'.tsx'.length));
  if (slugs.length === 0) return;
  const lines: string[] = [
    '## Screen scaffolding',
    '',
    'Trước khi tự dựng khung màn bằng `<div>`, tra bảng này — mỗi vai trò liệt kê',
    'các component CÓ SẴN của bộ DS (import từ `ds/components/ui/<tên>`). Tự dựng',
    'lại khung khi DS đã có component = mất instance khi capture sang Figma',
    '(cổng verify của build.sh sẽ chặn).',
    '',
  ];
  for (const { role, keys } of SCAFFOLD_ROLES) {
    const matches = slugs.filter((slug) => {
      const normalized = slug.replace(/-/g, '').toLowerCase();
      return keys.some((key) => normalized.includes(key));
    });
    const listed = matches.slice(0, 10).map((slug) => `\`${slug}\``);
    if (matches.length > 10) listed.push(`+${matches.length - 10} nữa`);
    lines.push(
      matches.length > 0
        ? `- **${role}**: ${listed.join(', ')}`
        : `- **${role}**: (không có trong bộ DS này — được phép tự dựng, mọi giá trị style vẫn phải qua class \`tk-*\`)`,
    );
  }
  const section = `${lines.join('\n')}\n`;
  const firstComponentHeading = catalog.content.indexOf('\n## ');
  catalog.content =
    firstComponentHeading >= 0
      ? `${catalog.content.slice(0, firstComponentHeading + 1)}${section}\n${catalog.content.slice(firstComponentHeading + 1)}`
      : `${catalog.content}\n${section}`;
}

// ── Wireframe mapping (Mức 1) ───────────────────────────────────────────────
// The ux-spec wireframes speak the CLOSED DSL-v2 vocabulary
// (skills/ux-spec/references/wire-registry.json — shadcn:*/mobile:*/…); this
// table mirrors those slugs and maps each onto THIS bundle's own components by
// normalized-substring role matching, so the UI stage builds every wireframe
// node from the right ds component instead of guessing across 200+ Figma
// names. A slug missing here (registry drift) is simply not listed — never an
// error. `none` marks slugs that are deliberately unmapped (plain markup +
// tk-* classes), `token` keys match whole hyphen-separated words ("stat" must
// not hit "state"/"status").
const WIRE_EXCLUDE = /^(ic-|emoji-|d-e-s-|pd-|ipay-illustration|illus-)/;
const WIREFRAME_ROLES: Array<{
  slug: string;
  keys?: string[];
  token?: string;
  none?: string;
}> = [
  { slug: 'shadcn:Heading', keys: ['title'] },
  { slug: 'shadcn:Text', none: 'text thuần — markup + class tk-*' },
  { slug: 'shadcn:Label', none: 'label thuần — markup + class tk-*' },
  { slug: 'layout:SectionLabel', none: 'text + class tk-*' },
  { slug: 'shadcn:Link', none: 'thẻ <a>/<button> + class tk-*' },
  { slug: 'shadcn:Input', keys: ['textfield', 'input'] },
  { slug: 'shadcn:InputSearch', keys: ['search'] },
  { slug: 'shadcn:Textarea', keys: ['textarea'] },
  { slug: 'shadcn:Select', keys: ['selection', 'select', 'dropdown'] },
  { slug: 'shadcn:Checkbox', keys: ['checkbox'] },
  { slug: 'shadcn:RadioGroup', keys: ['radio'] },
  { slug: 'shadcn:Switch', keys: ['toggle', 'switch'] },
  { slug: 'shadcn:Slider', keys: ['slider'] },
  { slug: 'shadcn:InputOTP', keys: ['otp', 'codeinput'] },
  { slug: 'shadcn:Button', keys: ['button'] },
  { slug: 'shadcn:Badge', keys: ['badge', 'chip'] },
  { slug: 'shadcn:ToggleGroup', keys: ['togglegroup', 'segmented'] },
  { slug: 'shadcn:Tabs', keys: ['tabs', 'tabitem'] },
  { slug: 'shadcn:NavigationMenu', keys: ['topnavigationbar', 'navigationbar', 'navbar'] },
  { slug: 'shadcn:Breadcrumb', keys: ['breadcrumb'] },
  { slug: 'shadcn:Pagination', keys: ['pagination', 'pageindicator'] },
  { slug: 'shadcn:Sidebar', keys: ['sidebar'] },
  { slug: 'shadcn:Accordion', keys: ['accordion', 'expand'] },
  { slug: 'shadcn:Item', keys: ['listitem', 'optiontile', 'dataitem'] },
  { slug: 'shadcn:Table', keys: ['table'] },
  { slug: 'shadcn:Card', keys: ['card'] },
  { slug: 'data:Stat', token: 'stat', keys: ['datarow', 'balance'] },
  { slug: 'shadcn:Progress', keys: ['progress'] },
  { slug: 'data:Stepper', keys: ['stepper'] },
  { slug: 'shadcn:Skeleton', keys: ['skeleton'] },
  { slug: 'shadcn:Empty', keys: ['emptystate', 'empty', 'nodata'] },
  { slug: 'shadcn:Avatar', keys: ['avatar'] },
  { slug: 'media:Image', keys: ['imageratio', 'image'] },
  { slug: 'shadcn:Separator', keys: ['divider', 'separator'] },
  { slug: 'shadcn:Alert', keys: ['alertbanner', 'alert'] },
  { slug: 'layout:Spacer', none: 'khoảng trống — inline style layout' },
  { slug: 'mobile:AppBar', keys: ['topnavigationbar', 'appbar'] },
  { slug: 'mobile:BottomNav', keys: ['bottomnavigation', 'tabbar'] },
  { slug: 'mobile:Fab', keys: ['fab', 'floatingbutton'] },
  { slug: 'mobile:NavDrawer', keys: ['drawer', 'sidemenu'] },
  { slug: 'mobile:ActionSheet', keys: ['bottomsheet', 'actionsheet'] },
];

/** Machine-readable side of the wireframe mapping — the ux-spec preview's
 *  component-assignment UI consumes this (served via
 *  GET /api/design-systems/:id/wireframe-map). Same data the markdown section
 *  renders from. */
export type WireframeMap = {
  kind: 'od-wireframe-map';
  version: 1;
  slugs: Array<{ slug: string; candidates?: string[]; none?: string }>;
  specials: { templates: string[]; charts: string[]; other: string[] };
  components: string[];
};

function computeWireframeMap(slugs: string[]): WireframeMap {
  const usable = slugs.filter((slug) => !WIRE_EXCLUDE.test(slug));
  const normalized = (slug: string) => slug.replace(/-/g, '').toLowerCase();
  const matched = new Set<string>();
  const rankHits = (hits: string[]) =>
    [...new Set(hits)].sort(
      (a, b) => (a.startsWith('i-pay') ? 0 : 1) - (b.startsWith('i-pay') ? 0 : 1) || a.length - b.length,
    );
  const out: WireframeMap['slugs'] = [];
  for (const role of WIREFRAME_ROLES) {
    if (role.none) {
      out.push({ slug: role.slug, none: role.none });
      continue;
    }
    let hits: string[] = [];
    if (role.token) {
      const re = new RegExp(`(^|-)${role.token}(-|$)`);
      hits = hits.concat(usable.filter((slug) => re.test(slug)));
    }
    for (const key of role.keys ?? []) {
      hits = hits.concat(usable.filter((slug) => normalized(slug).includes(key)));
    }
    const ranked = rankHits(hits);
    for (const hit of ranked) matched.add(hit);
    out.push({ slug: role.slug, candidates: ranked });
  }
  const leftovers = usable.filter((slug) => !matched.has(slug));
  const templates = leftovers.filter((slug) => /^i-pay-template|template/.test(slug));
  const charts = leftovers.filter((slug) => /chart/.test(slug) && !templates.includes(slug));
  const other = leftovers.filter((slug) => !templates.includes(slug) && !charts.includes(slug));
  return {
    kind: 'od-wireframe-map',
    version: 1,
    slugs: out,
    specials: { templates, charts, other },
    components: usable,
  };
}

function injectWireframeMappingSection(files: Array<{ path: string; content: string }>): void {
  const catalog = files.find((file) => file.path === 'docs/catalog.md');
  if (!catalog || catalog.content.includes('## Wireframe mapping')) return;
  const slugs = files
    .filter((file) => /^components\/ui\/[^/]+\.tsx$/.test(file.path))
    .map((file) => file.path.slice('components/ui/'.length, -'.tsx'.length));
  if (slugs.length === 0) return;
  const map = computeWireframeMap(slugs);
  // Machine-readable twin for the preview's component-assignment UI.
  files.push({
    path: 'wireframe-map.json',
    content: `${JSON.stringify(map, null, 2)}\n`,
  });
  const rows: string[] = map.slugs.map((entry) => {
    if (entry.none) return `| \`${entry.slug}\` | (không có — ${entry.none}) |`;
    return entry.candidates && entry.candidates.length > 0
      ? `| \`${entry.slug}\` | ${entry.candidates.slice(0, 3).map((slug) => `\`${slug}\``).join(', ')} |`
      : `| \`${entry.slug}\` | (không có trong bộ DS này — tự dựng bằng markup + class \`tk-*\`) |`;
  });
  // DS-specific components no wireframe slug covers: the ux wireframe points
  // at them via `note`, the UI stage picks them from here.
  const { templates, charts, other } = map.specials;
  const listOf = (items: string[], cap: number) => {
    const listed = items.slice(0, cap).map((slug) => `\`${slug}\``);
    if (items.length > cap) listed.push(`+${items.length - cap} nữa`);
    return listed.join(', ');
  };
  const lines: string[] = [
    '## Wireframe mapping',
    '',
    'Wireframe của UX spec nói từ vựng chung (DSL v2: `shadcn:*`/`mobile:*`/…).',
    'Bảng này là NGUỒN SỰ THẬT khi dựng màn từ wireframe: slug có component thì',
    'PHẢI dựng bằng đúng component đó (API xem bảng props của nó bên dưới);',
    'slug "(không có)" thì tự dựng bằng markup + class `tk-*`.',
    '',
    '| Wireframe slug | Component của bộ DS này |',
    '|---|---|',
    ...rows,
  ];
  if (templates.length > 0 || charts.length > 0 || other.length > 0) {
    lines.push('', '### Component đặc thù ngoài từ vựng wireframe', '');
    lines.push('Wireframe tham chiếu các component này qua prop `note`; bước UI chọn đúng:');
    if (templates.length > 0) lines.push(`- **Template màn nguyên con**: ${listOf(templates, 10)}`);
    if (charts.length > 0) lines.push(`- **Charts**: ${listOf(charts, 10)}`);
    if (other.length > 0) lines.push(`- **Khác**: ${listOf(other, 20)}`);
  }
  const section = `${lines.join('\n')}\n`;
  const firstComponentHeading = catalog.content.indexOf('\n## ');
  catalog.content =
    firstComponentHeading >= 0
      ? `${catalog.content.slice(0, firstComponentHeading + 1)}${section}\n${catalog.content.slice(firstComponentHeading + 1)}`
      : `${catalog.content}\n${section}`;
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

function isZipContent(file: FigmaIRImportFile): boolean {
  if (/\.zip$/i.test(file.filename)) return true;
  return Buffer.isBuffer(file.content) && file.content.length >= 4 && file.content.readUInt32LE(0) === ZIP_LOCAL_HEADER;
}

function irJsonText(file: FigmaIRImportFile): string {
  if (isZipContent(file)) {
    const buf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    try {
      return irJsonFromZip(buf);
    } catch (err: any) {
      throw new LocalDesignSystemImportError('BAD_REQUEST', `${file.filename}: ${String(err?.message ?? err)}`);
    }
  }
  return Buffer.isBuffer(file.content) ? file.content.toString('utf8') : file.content;
}

// Ported from upstream fig-pipeline/tools/merge-react.mjs — reads the ir.json
// entry out of the plugin's bundle zip (written by compile-core's zipFiles:
// store/deflate-raw with a standard End-of-Central-Directory record).
function irJsonFromZip(buf: Buffer): string {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no End-of-Central-Directory record — corrupt zip?');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== ZIP_CENTRAL_HEADER) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === 'ir.json' || name.endsWith('/ir.json')) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      const raw = method === 8 ? zlib.inflateRawSync(data) : method === 0 ? data : null;
      if (!raw) throw new Error(`ir.json compression method=${method} not supported`);
      return raw.toString('utf8');
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('zip has no ir.json — not a Fig Pipeline bundle?');
}

// Multi-file merges get an ugly synthetic meta.file ("Foundation + 1 files");
// prefer the shared prefix of the source Figma file names ("[SDK] Foundation
// (Slot)" + "[SDK] UI Lib (Slot)" → "[SDK] Design System"), falling back to
// the first file's name when the exports share no meaningful prefix.
function defaultDisplayName(ir: any): string {
  const names: string[] = (ir?.meta?.files ?? [])
    .map((entry: any) => String(entry?.name ?? '').trim())
    .filter(Boolean);
  const first = names[0] ?? '';
  if (names.length === 0 || !first) return String(ir?.meta?.file ?? 'Figma Design System');
  if (names.length === 1) return first;
  let prefix = first;
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  prefix = prefix.replace(/[\s\-_/|([{]+$/g, '').trim();
  return prefix.length >= 3 ? `${prefix} Design System` : first;
}

function cleanDisplayName(raw: string): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned || 'Figma Design System';
}

function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'figma-design-system';
}

async function nextAvailableSlug(
  root: string,
  preferred: string,
  reservedIds: Iterable<string> = [],
): Promise<string> {
  await mkdir(root, { recursive: true });
  const reserved = new Set(reservedIds);
  for (let index = 1; index < 1000; index += 1) {
    const id = index === 1 ? preferred : `${preferred}-${index}`;
    if (reserved.has(id)) continue;
    try {
      await stat(path.join(root, id));
    } catch {
      return id;
    }
  }
  throw new LocalDesignSystemImportError('INTERNAL_ERROR', 'could not allocate design system id');
}

function uniqueIrFileName(original: string, taken: string[]): string {
  // Zips persist as the extracted ir.json (foo.zip → foo.ir.json).
  const base = path
    .basename(original)
    .replace(/\.zip$/i, '')
    .replace(/[^\w.\-]+/g, '-');
  const named = base.endsWith('.ir.json') ? base : base.endsWith('.json') ? base : `${base}.ir.json`;
  if (!taken.includes(named)) return named;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = named.replace(/(\.ir)?\.json$/, `-${index}$&`);
    if (!taken.includes(candidate)) return candidate;
  }
  return `${Date.now()}-${named}`;
}

// tokens.css carries only the CSS-variable blocks (:root / .dark / .mode-*) —
// the tk-* utility half of globals.css is markup vocabulary for the React
// bundle, not prompt-injection material, and would bloat the system prompt.
function tokensOnlyCss(globalsCss: string): string {
  const markerAt = globalsCss.indexOf(TK_SECTION_MARKER);
  const tokens = markerAt >= 0 ? globalsCss.slice(0, markerAt) : globalsCss;
  return `${tokens.trimEnd()}\n`;
}

// Named so DESIGN.md can render the "- **Name:** `#hex`" form the registry's
// extractSwatches parser recognises (a bare hex row yields no swatches).
function extractColorSwatches(ir: any): Array<{ name: string; hex: string }> {
  const out: Array<{ name: string; hex: string }> = [];
  const seen = new Set<string>();
  for (const variable of ir?.variables ?? []) {
    if (variable?.type !== 'COLOR') continue;
    const name = String(variable?.name ?? '').trim();
    if (!/^[A-Za-z]/.test(name) || name.length > 60) continue;
    for (const mode of Object.values(variable?.values ?? {})) {
      const value = (mode as any)?.value;
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) continue;
      const hex = value.toLowerCase();
      if (seen.has(hex)) continue;
      seen.add(hex);
      out.push({ name, hex });
      break;
    }
    if (out.length >= 6) break;
  }
  return out;
}

// The prompt-facing DESIGN.md carries the compiler's own artifacts instead of
// a synthesized summary: the STYLE-GUIDE token-contract rules (its token
// listings are cut — tokens.css is injected separately by the push channel)
// and the full component catalog (per-component props/variants tables), so
// agents compose screens against the real component API, not prose.
function renderDesignMd(
  name: string,
  summary: any,
  sources: Array<{ filename: string; figmaFile: string }>,
  swatches: Array<{ name: string; hex: string }>,
  warnings: string[],
  styleGuideMd: string,
  catalogMd: string,
  exampleCount: number,
): string {
  const lines: string[] = [
    `# ${name}`,
    '',
    '> Category: Figma',
    '',
    `React design system compiled from a Figma export: ${summary.components}/${summary.totalSets} component sets, ${summary.icons} icons, and ${summary.variables} design tokens, generated as a self-contained plain-React + CSS-variables bundle under \`react/\` (no Tailwind, React is the only dependency).`,
    '',
  ];
  if (swatches.length > 0) {
    lines.push('## Palette', '', ...swatches.map((s) => `- **${s.name}:** \`${s.hex}\``), '');
  }
  const rules = styleGuideRules(styleGuideMd);
  if (rules) {
    lines.push('## Token contract', '', rules, '');
  }
  lines.push(
    '## Source',
    '',
    ...sources.map((s) => `- \`${s.filename}\`${s.figmaFile ? ` — Figma file "${s.figmaFile}"` : ''}`),
    '',
    '## Structure',
    '',
    '- `react/components/ui/*.tsx` — one React component per Figma component set (variant props).',
    '- `react/components/icons/*.tsx` — icon components (`size` prop, `currentColor`).',
    '- `react/styles/globals.css` — design tokens as CSS variables per collection/mode; dark modes double as `.dark`.',
    '- `react/docs/catalog.md` — full per-component props/variants reference.',
    ...(exampleCount > 0
      ? [
          `- \`react/examples/*.tsx\` — ${exampleCount} reference layout${exampleCount === 1 ? '' : 's'} (Figma components suffixed \`_example\`).`,
          '- `react/docs/examples.md` — index of those layouts.',
        ]
      : []),
    '- `tokens.css` (this folder) — the token blocks only, for token-level theming.',
    '',
  );
  if (exampleCount > 0) {
    lines.push(
      '## Reference layouts',
      '',
      'Read `react/examples/*.tsx` before composing a screen: their JSX shows how these components are meant to fit together. Copy the structure, props and tokens — never import an example into a screen.',
      '',
    );
  }
  const catalog = catalogBody(catalogMd);
  if (catalog) {
    lines.push('## Component catalog', '', catalog, '');
  }
  if (warnings.length > 0) {
    lines.push('## Import warnings', '', ...warnings.slice(0, 20).map((w) => `- ${w}`), '');
  }
  return lines.join('\n');
}

// STYLE-GUIDE.md = usage rules up top, then exhaustive token listings
// ("## Colors (630)", spacing, …) that duplicate tokens.css. Keep the rules,
// drop the listings and the file's own H1.
function styleGuideRules(styleGuideMd: string): string {
  if (!styleGuideMd.trim()) return '';
  const firstSection = styleGuideMd.search(/\n## /);
  const head = firstSection >= 0 ? styleGuideMd.slice(0, firstSection) : styleGuideMd;
  return head.replace(/^# .*\n/, '').trim();
}

// docs/catalog.md opens with its own H1 + "Generated …" line; strip both so
// the tables nest cleanly under DESIGN.md's "## Component catalog" heading.
function catalogBody(catalogMd: string): string {
  if (!catalogMd.trim()) return '';
  return catalogMd
    .replace(/^# .*\n/, '')
    .replace(/^\s*Generated .*\n/, '')
    .trim();
}

function renderUsageMd(name: string, summary: any): string {
  return [
    `# Using ${name}`,
    '',
    'This design system ships real React source (compiled from Figma), not just tokens.',
    '',
    '- Components live in `react/components/ui/` and are plain React + TypeScript; import them directly and pass the variant props documented in `react/docs/catalog.md`.',
    '- Import `react/styles/globals.css` exactly once; every token is a CSS variable and the markup only uses `tk-*` single-declaration classes from that stylesheet.',
    '- Theme switching is class-driven: add `.dark` (or a `.mode-*` class) to a root element. There is no JS theme provider.',
    '- Icons are components in `react/components/icons/` with a numeric `size` prop.',
    '- Components render static structure faithfully to Figma; wire state, handlers, and data yourself.',
    '- Do not restyle components with ad-hoc CSS overrides — change token values instead so every variant stays consistent.',
    '',
    `Inventory: ${summary.components} components, ${summary.icons} icons, ${summary.variables} tokens.`,
    '',
  ].join('\n');
}

// Minimal static fixture so the components-manifest extractor and the human
// preview have something faithful to index: the real component inventory,
// styled through the exported tokens. The genuine component reference for
// agents is react/docs/catalog.md.
function renderComponentsHtml(name: string, summary: any): string {
  const componentNames: string[] = (summary.componentNames ?? []).map(String);
  const items = componentNames
    .map((entry) => {
      const label = entry.replace(/\s*\(\d+\)\s*$/, '');
      const slug = slugify(label);
      return `      <li class="component component-${slug}">${escapeHtml(entry)}</li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(name)} — components</title>
<style>
  main { font-family: var(--font-family-body, system-ui, sans-serif); color: var(--text-primary, #111); padding: 24px; }
  h1 { font-size: 20px; }
  .component { padding: 4px 0; border-bottom: 1px solid var(--border-default, #e5e7eb); }
</style>
</head>
<body>
<main>
  <section class="container">
    <h1>${escapeHtml(name)}</h1>
    <p>React components compiled from Figma (${componentNames.length} sets, ${summary.icons} icons). Source of truth: <code>react/docs/catalog.md</code>.</p>
    <ul>
${items}
    </ul>
  </section>
</main>
</body>
</html>
`;
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderManifest(
  id: string,
  name: string,
  summary: any,
  sources: Array<{ filename: string; figmaFile: string }>,
  irFiles: string[],
  options: FigmaIRImportOptions,
  exampleCount: number,
) {
  const importedAt = (options.now ?? new Date()).toISOString();
  const craftApplies = options.craftApplies ?? [];
  return {
    schemaVersion: 'od-design-system-project/v1',
    id,
    name,
    category: 'Figma',
    description: `React design system compiled from Figma IR export${sources.length ? ` (${sources.map((s) => s.figmaFile || s.filename).join(', ')})` : ''}.`,
    source: {
      type: 'figma-ir',
      files: sources,
      importedAt,
    },
    files: {
      design: 'DESIGN.md',
      tokens: 'tokens.css',
      components: 'components.html',
    },
    usage: 'USAGE.md',
    componentsManifest: 'components.manifest.json',
    importMode: 'verbatim',
    craft: {
      applies: craftApplies,
      suggested: craftApplies.includes('color') ? [] : ['color'],
      exemptions: [],
    },
    // React-source marker consumed by the pipeline DS staging (Phase C): when
    // present, the daemon can stage react/ into a run cwd instead of treating
    // the system as prose/tokens-only.
    react: {
      dir: 'react',
      componentsDir: 'react/components/ui',
      iconsDir: 'react/components/icons',
      stylesheet: 'react/styles/globals.css',
      catalog: 'react/docs/catalog.md',
      components: Number(summary.components ?? 0),
      icons: Number(summary.icons ?? 0),
      // Reference layouts compiled from `_example` Figma components. Absent
      // when the library ships none, so a consumer can branch on presence
      // rather than probing the filesystem.
      ...(exampleCount > 0
        ? {
            examplesDir: 'react/examples',
            examplesIndex: 'react/docs/examples.md',
            examples: exampleCount,
          }
        : {}),
    },
    ir: {
      dir: 'ir',
      files: irFiles,
    },
  };
}
