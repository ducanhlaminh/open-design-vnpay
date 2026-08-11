import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import {
  importFigmaIRDesignSystem,
  type FigmaIRImportFile,
} from '../src/figma-ds-import.js';
import { LocalDesignSystemImportError } from '../src/design-system-import.js';

// Minimal but realistic pair mirroring the real-world split: a foundation
// export owning the tokens and a UI-lib export whose component binds them.
const foundationIR = {
  meta: { file: '[Acme] Foundation' },
  collections: [{ name: 'Mode', modes: ['Light', 'Dark'], defaultMode: 'Light' }],
  variables: [
    {
      name: 'color/bg',
      type: 'COLOR',
      collection: 'Mode',
      values: { Light: { value: '#ffffff' }, Dark: { value: '#111111' } },
    },
  ],
  componentSets: [],
  components: [],
  // An icon NO component references — upstream's showcase-data.js omits its
  // SVG (empty gallery box); our enrichShowcaseIconAssets must backfill it.
  icons: [{ name: 'ic-lonely', asset: 'lonelyhash', w: 16, h: 16 }],
  assets: { lonelyhash: '<svg width="16" height="16" xmlns="http://www.w3.org/2000/svg"><rect/></svg>' },
};

const uiLibIR = {
  meta: { file: '[Acme] UI Lib' },
  componentSets: [
    {
      name: 'Badge',
      id: '1:1',
      props: {},
      variants: [
        {
          props: {},
          tree: {
            name: 'Badge',
            type: 'FRAME',
            w: 24,
            h: 24,
            fills: [{ type: 'solid', color: '#ffffff', var: 'color/bg' }],
          },
        },
      ],
    },
    {
      // Real-world names never say plain "Dialog" — the scaffolding section
      // must still map this into the Dialog family by normalized substring.
      name: 'IPay Dialog',
      id: '1:2',
      props: {},
      variants: [
        {
          props: {},
          tree: { name: 'IPay Dialog', type: 'FRAME', w: 343, h: 200, fills: [] },
        },
      ],
    },
  ],
  variables: [],
  components: [],
  icons: [],
};

function irFiles(): FigmaIRImportFile[] {
  return [
    { filename: 'acme-foundation.ir.json', content: JSON.stringify(foundationIR) },
    { filename: 'acme-ui-lib.ir.json', content: JSON.stringify(uiLibIR) },
  ];
}

describe('importFigmaIRDesignSystem', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('merges multi-file IRs and writes a React design-system project', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'figma-ds-import-'));
    const result = await importFigmaIRDesignSystem(irFiles(), root);

    // Shared "[Acme] " prefix wins over the synthetic merged meta.file name.
    expect(result.id).toBe('acme-design-system');
    expect(result.summary.componentSets).toBe(2);
    expect(result.summary.components).toBe(2);
    expect(result.summary.variables).toBe(1);
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.sources.map((s) => s.figmaFile)).toEqual([
      '[Acme] Foundation',
      '[Acme] UI Lib',
    ]);

    const dir = result.dir;
    for (const rel of [
      'DESIGN.md',
      'USAGE.md',
      'tokens.css',
      'components.html',
      'components.manifest.json',
      'manifest.json',
      'react/styles/globals.css',
      'react/docs/catalog.md',
      'ir/acme-foundation.ir.json',
      'ir/acme-ui-lib.ir.json',
    ]) {
      expect((await stat(path.join(dir, rel))).isFile(), rel).toBe(true);
    }

    // DESIGN.md carries the compiler's own artifacts, not a synthesized
    // summary: the STYLE-GUIDE token-contract rules (minus its token listings,
    // which duplicate tokens.css) and the full per-component catalog tables.
    const designMd = await readFile(path.join(dir, 'DESIGN.md'), 'utf8');
    expect(designMd).toContain('## Token contract');
    expect(designMd).toContain('## Component catalog');
    expect(designMd).toContain('## Badge');
    expect(designMd).not.toContain('## Colors (');

    // Cross-file token binding: the UI-lib component resolves the foundation
    // token, and tokens.css carries the variable blocks without tk-* classes.
    const tokensCss = await readFile(path.join(dir, 'tokens.css'), 'utf8');
    expect(tokensCss).toContain('--color-bg');
    expect(tokensCss).not.toContain('.tk-');
    const globalsCss = await readFile(path.join(dir, 'react/styles/globals.css'), 'utf8');
    expect(globalsCss).toContain('.dark');

    // The token-bound fill compiles to a shared tk-* utility class whose
    // declaration resolves through the foundation token in globals.css.
    const badge = await readFile(path.join(dir, 'react/components/ui/badge.tsx'), 'utf8');
    expect(badge).toContain('tk-bg-color-bg');
    expect(globalsCss).toContain('var(--color-bg');

    // catalog.md gets the injected "Screen scaffolding" section the ui-react-ds
    // SKILL points the agent at: family roles mapped onto THIS bundle's real
    // component names (fuzzy: "IPay Dialog" → Dialog), empty roles marked as
    // legitimately hand-rollable. Injected before the first component heading.
    const catalogMd = await readFile(path.join(dir, 'react/docs/catalog.md'), 'utf8');
    expect(catalogMd).toContain('## Screen scaffolding');
    expect(catalogMd).toMatch(/- \*\*Dialog\*\*:.*`i-pay-dialog`/);
    expect(catalogMd).toMatch(/- \*\*Bottom sheet \/ drawer\*\*: \(không có/);
    expect(catalogMd.indexOf('## Screen scaffolding')).toBeLessThan(catalogMd.indexOf('## Badge'));
    // …and flows into DESIGN.md through the embedded catalog body.
    expect(designMd).toContain('## Screen scaffolding');

    // Wireframe mapping: the DSL-v2 slugs resolved onto THIS bundle's real
    // component names (badge → shadcn:Badge), unmatched slugs marked
    // hand-rollable, deliberate non-mappings carry their tk-* note. Section
    // order: Screen scaffolding → Wireframe mapping → component tables.
    expect(catalogMd).toContain('## Wireframe mapping');
    expect(catalogMd).toMatch(/\| `shadcn:Badge` \| `badge` \|/);
    expect(catalogMd).toMatch(/\| `shadcn:Table` \| \(không có trong bộ DS này/);
    expect(catalogMd).toMatch(/\| `shadcn:Text` \| \(không có — text thuần/);
    expect(catalogMd.indexOf('## Screen scaffolding')).toBeLessThan(
      catalogMd.indexOf('## Wireframe mapping'),
    );
    expect(catalogMd.indexOf('## Wireframe mapping')).toBeLessThan(catalogMd.indexOf('## Badge'));

    // Machine-readable twin for the ux-spec preview's assignment UI.
    const wireMap = JSON.parse(
      await readFile(path.join(dir, 'react/wireframe-map.json'), 'utf8'),
    ) as { kind: string; slugs: Array<{ slug: string; candidates?: string[] }>; components: string[] };
    expect(wireMap.kind).toBe('od-wireframe-map');
    expect(wireMap.components).toContain('badge');
    expect(wireMap.slugs.find((s) => s.slug === 'shadcn:Badge')?.candidates).toContain('badge');

    // Showcase gallery must resolve EVERY icon by name — including icons no
    // component references (backfilled into showcase-data.js on import).
    const showcaseData = await readFile(path.join(dir, 'react/showcase/showcase-data.js'), 'utf8');
    const showcaseAssets = JSON.parse(/window\.__FIG_ASSETS__ = (.*?);\n/.exec(showcaseData)![1]!);
    const showcaseIcons = JSON.parse(/window\.__FIG_ICONS__ = (.*?);\n/.exec(showcaseData)![1]!);
    expect(showcaseIcons['ic-lonely']).toBe('lonelyhash');
    expect(showcaseAssets['lonelyhash']).toContain('<svg');

    // The manifest passes the registry's strict validator fields and carries
    // the react/ marker the pipeline DS staging (Phase C) will read.
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.schemaVersion).toBe('od-design-system-project/v1');
    expect(manifest.id).toBe(result.id);
    expect(manifest.files).toEqual({
      design: 'DESIGN.md',
      tokens: 'tokens.css',
      components: 'components.html',
    });
    expect(manifest.react.dir).toBe('react');
    expect(manifest.ir.files).toEqual(['acme-foundation.ir.json', 'acme-ui-lib.ir.json']);
  });

  it('rejects invalid JSON with the offending filename', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'figma-ds-import-'));
    await expect(
      importFigmaIRDesignSystem(
        [{ filename: 'broken.ir.json', content: '{nope' }],
        root,
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof LocalDesignSystemImportError &&
        err.code === 'BAD_REQUEST' &&
        err.message.includes('broken.ir.json'),
    );
  });

  it('rejects IRs that fail validation (missing meta.file)', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'figma-ds-import-'));
    await expect(
      importFigmaIRDesignSystem(
        [{ filename: 'no-meta.ir.json', content: JSON.stringify({ variables: [] }) }],
        root,
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof LocalDesignSystemImportError && err.code === 'BAD_REQUEST',
    );
  });

  it('merges in natural filename order regardless of upload order', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'figma-ds-import-'));
    // Passed ui-lib FIRST — the 01-/02- prefixes must decide the merge order.
    const result = await importFigmaIRDesignSystem(
      [
        { filename: '02-ui-lib.ir.json', content: JSON.stringify(uiLibIR) },
        { filename: '01-foundation.ir.json', content: JSON.stringify(foundationIR) },
      ],
      root,
    );
    expect(result.summary.sources.map((s) => s.filename)).toEqual([
      '01-foundation.ir.json',
      '02-ui-lib.ir.json',
    ]);
  });

  it('accepts the plugin .zip bundle and persists its extracted ir.json', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'figma-ds-import-'));
    const zip = new JSZip();
    zip.file('ir.json', JSON.stringify(uiLibIR));
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const result = await importFigmaIRDesignSystem(
      [
        { filename: '01-foundation.ir.json', content: JSON.stringify(foundationIR) },
        { filename: '02-ui-lib.zip', content: zipBuf },
      ],
      root,
    );
    expect(result.summary.componentSets).toBe(2);
    expect(result.summary.sources.map((s) => s.figmaFile)).toEqual([
      '[Acme] Foundation',
      '[Acme] UI Lib',
    ]);
    // The zip persists as its extracted ir.json, uniform with raw uploads.
    const persisted = await readFile(path.join(result.dir, 'ir/02-ui-lib.ir.json'), 'utf8');
    expect(JSON.parse(persisted).meta.file).toBe('[Acme] UI Lib');
  });

  it('rejects a zip without ir.json inside', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'figma-ds-import-'));
    const zip = new JSZip();
    zip.file('readme.txt', 'not a bundle');
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await expect(
      importFigmaIRDesignSystem([{ filename: 'bundle.zip', content: zipBuf }], root),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof LocalDesignSystemImportError &&
        err.code === 'BAD_REQUEST' &&
        err.message.includes('bundle.zip'),
    );
  });

  it('allocates a fresh id when the slug is taken', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'figma-ds-import-'));
    const first = await importFigmaIRDesignSystem(irFiles(), root);
    const second = await importFigmaIRDesignSystem(irFiles(), root, {
      reservedIds: [first.id],
    });
    expect(second.id).toBe('acme-design-system-2');
  });
});
