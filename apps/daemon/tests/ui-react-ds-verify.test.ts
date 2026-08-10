import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// The design-system gate the ui-react-ds build.sh runs after a green vite
// build. These specs pin the two silent failure modes the gate exists for —
// off-token styling values and hand-rolled screen scaffolding — against a
// REALISTICALLY-NAMED ds inventory (`ipay-dialog`, never plain `dialog`),
// because the 2026-07 live run showed exact-name matching turns the whole
// scaffold check off.
const VERIFY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../skills/ui-react-ds/builder/verify.mjs',
);

const GLOBALS_CSS = [
  ':root { --text-primary: #111; --size-t14: 14px; }',
  '.tk-text-text-primary { color: var(--text-primary); }',
  '.tk-fs-size-t14 { font-size: var(--size-t14); }',
].join('\n');

let root: string | undefined;

async function fixture(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(path.join(tmpdir(), 'uireact-ds-verify-'));
  const all: Record<string, string> = {
    'src/ds/styles/globals.css': GLOBALS_CSS,
    'src/ds/components/ui/ipay-dialog.tsx': 'export const IPayDialog = () => null;\n',
    'src/ds/components/ui/ipay-bottom-sheet-modal.tsx': 'export const IPayBottomSheetModal = () => null;\n',
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    const dest = path.join(root, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content, 'utf8');
  }
  return root;
}

function runVerify(dir: string): { status: number | null; stderr: string } {
  const res = spawnSync(process.execPath, [VERIFY, dir], { encoding: 'utf8' });
  return { status: res.status, stderr: res.stderr };
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('ui-react-ds verify gate', () => {
  it('passes a screen that styles through tk-* classes and ds components', async () => {
    const dir = await fixture({
      'src/screens/home.tsx': [
        "import { IPayDialog } from '../ds/components/ui/ipay-dialog'",
        'export default function Home() {',
        '  return (',
        '    <div className="tk-text-text-primary tk-fs-size-t14" style={{ display: \'flex\', padding: \'16px\' }}>',
        '      <IPayDialog />',
        '    </div>',
        '  )',
        '}',
      ].join('\n'),
    });
    const res = runVerify(dir);
    expect(res.stderr).toContain('[verify] OK');
    expect(res.status).toBe(0);
  });

  it('fails on literal styling values even without hex or var()', async () => {
    const dir = await fixture({
      'src/screens/home.tsx': [
        "import { IPayDialog } from '../ds/components/ui/ipay-dialog'",
        'export default function Home() {',
        "  return <div style={{ fontSize: 14, color: 'white', borderRadius: 8, background: 'transparent' }}><IPayDialog /></div>",
        '}',
      ].join('\n'),
    });
    const res = runVerify(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[literal-value] inline style "fontSize: 14"');
    expect(res.stderr).toContain('[literal-value] inline style "color: \'white\'"');
    expect(res.stderr).toContain('[literal-value] inline style "borderRadius: 8"');
    // resets are allowed inline
    expect(res.stderr).not.toContain('background');
  });

  it('flags a hand-rolled dialog by FAMILY name match (ipay-dialog counts as Dialog)', async () => {
    const dir = await fixture({
      'src/components/app/app-dialog.tsx': [
        'export function AppDialog() {',
        '  return <div role="dialog" aria-modal="true" className="tk-text-text-primary" />',
        '}',
      ].join('\n'),
    });
    const res = runVerify(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[hand-rolled-scaffold]');
    expect(res.stderr).toContain('ds/components/ui/ipay-dialog');
  });

  it('exempts only the file that itself imports the family component', async () => {
    const dialog = [
      "import { IPayDialog } from '../../ds/components/ui/ipay-dialog'",
      'export function AppDialog() {',
      '  return <div role="dialog" aria-modal="true"><IPayDialog /></div>',
      '}',
    ].join('\n');
    const other = [
      'export function OtherDialog() {',
      '  return <div role="dialog" aria-modal="true" className="tk-text-text-primary" />',
      '}',
    ].join('\n');
    const dir = await fixture({
      'src/components/app/app-dialog.tsx': dialog,
      'src/components/app/second-dialog.tsx': other,
    });
    const res = runVerify(dir);
    // one import elsewhere must NOT silence the second hand-rolled copy
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('second-dialog.tsx');
    expect(res.stderr).not.toMatch(/app-dialog\.tsx:\d+\s+\[hand-rolled-scaffold\]/);
  });

  it('ignores scaffold words in comments and props passed to composites', async () => {
    const dir = await fixture({
      'src/screens/home.tsx': [
        "import { AppDialog } from '../components/app/app-dialog'",
        '// the bottom-sheet select opens from here',
        'export default function Home() {',
        '  return <AppDialog role="alertdialog" />',
        '}',
      ].join('\n'),
      'src/components/app/app-dialog.tsx': [
        "import { IPayDialog } from '../../ds/components/ui/ipay-dialog'",
        'export function AppDialog(props: { role?: string }) {',
        '  return <IPayDialog />',
        '}',
      ].join('\n'),
    });
    const res = runVerify(dir);
    expect(res.stderr).not.toContain('[hand-rolled-scaffold]');
    expect(res.status).toBe(0);
  });

  it('lets a documented od-verify-allow pragma through as a warning, but rejects a reasonless one', async () => {
    const body = [
      'export function AppSheet() {',
      '  return <div role="dialog" aria-modal="true" className="tk-text-text-primary" />',
      '}',
    ];
    const withReason = await fixture({
      'src/components/app/app-sheet.tsx': [
        '// od-verify-allow: scaffold — ipay-dialog label cứng, không nhận onClick',
        ...body,
      ].join('\n'),
    });
    const ok = runVerify(withReason);
    expect(ok.status).toBe(0);
    expect(ok.stderr).toContain('[allow-pragma]');
    await rm(withReason, { recursive: true, force: true });

    const noReason = await fixture({
      'src/components/app/app-sheet.tsx': ['// od-verify-allow: scaffold', ...body].join('\n'),
    });
    const bad = runVerify(noReason);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('thiếu lý do');
  });

  it('responsive target: requires a breakpoint in layout.css and accepts defined ly-* classes', async () => {
    const dir = await fixture({
      '.od-target.json': JSON.stringify({ target: 'web-user', responsive: true }),
      'src/styles/layout.css': [
        '.ly-shell { display: grid; grid-template-columns: 260px 1fr; }',
        '@media (max-width: 768px) { .ly-shell { grid-template-columns: 1fr; } }',
      ].join('\n'),
      'src/screens/home.tsx': [
        "import { IPayDialog } from '../ds/components/ui/ipay-dialog'",
        'export default function Home() {',
        '  return <div className="ly-shell tk-text-text-primary"><IPayDialog /></div>',
        '}',
      ].join('\n'),
    });
    const res = runVerify(dir);
    expect(res.stderr).toContain('(RESPONSIVE)');
    expect(res.stderr).toContain('[verify] OK');
    expect(res.status).toBe(0);
  });

  it('responsive target without any @media breakpoint fails', async () => {
    const dir = await fixture({
      '.od-target.json': JSON.stringify({ target: 'web-user', responsive: true }),
      'src/styles/layout.css': '.ly-shell { display: flex; }',
      'src/screens/home.tsx': [
        "import { IPayDialog } from '../ds/components/ui/ipay-dialog'",
        'export default function Home() { return <IPayDialog /> }',
      ].join('\n'),
    });
    const res = runVerify(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[missing-breakpoint]');
  });

  it('fixed-viewport target (mobile / legacy no-marker) forbids @media in layout.css', async () => {
    const dir = await fixture({
      'src/styles/layout.css': '@media (max-width: 768px) { .ly-x { display: none; } }',
      'src/screens/home.tsx': [
        "import { IPayDialog } from '../ds/components/ui/ipay-dialog'",
        'export default function Home() { return <IPayDialog /> }',
      ].join('\n'),
    });
    const res = runVerify(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[no-media-query]');
  });

  it('layout.css is layout-ONLY: styling values and non-ly classes fail; ly-* must be defined', async () => {
    const dir = await fixture({
      'src/styles/layout.css': [
        '.ly-row { display: flex; color: red; }',
        '.sidebar { display: none; }',
      ].join('\n'),
      'src/screens/home.tsx': [
        "import { IPayDialog } from '../ds/components/ui/ipay-dialog'",
        'export default function Home() {',
        '  return <div className="ly-undefined-class"><IPayDialog /></div>',
        '}',
      ].join('\n'),
    });
    const res = runVerify(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[layout-css-value]');
    expect(res.stderr).toContain('[layout-css-class]');
    expect(res.stderr).toContain('"ly-undefined-class" chưa được định nghĩa');
  });

  it('the seeded template layout.css (header comment only, with example rules) passes on a fixed target', async () => {
    const templateCss = [
      '/* layout.css — layout only. Example:',
      ' *   .ly-shell { display: grid; }',
      ' *   @media (max-width: 768px) { .ly-shell { grid-template-columns: 1fr; } }',
      ' */',
      '',
    ].join('\n');
    const dir = await fixture({
      'src/styles/layout.css': templateCss,
      'src/screens/home.tsx': [
        "import { IPayDialog } from '../ds/components/ui/ipay-dialog'",
        'export default function Home() { return <IPayDialog /> }',
      ].join('\n'),
    });
    const res = runVerify(dir);
    expect(res.stderr).toContain('[verify] OK');
    expect(res.status).toBe(0);
  });

  it('enforces human-locked wireframe comps: unused or invalid locks fail, used locks pass', async () => {
    // Wireframes live BESIDE react-ds/ in the target tree — build that shape
    // for real: <tmp>/wireframes/*.html + <tmp>/react-ds/ as the verify
    // target (the plain fixture() would resolve `..` outside the tmp dir).
    const wire = (comp: string) =>
      `<!doctype html><html><body data-screen="SCR-X" data-layout="mobile">
        <section data-comp="${comp}">Dialog</section>
      </body></html>`;
    const lockedFixture = async (comp: string) => {
      const parent = await mkdtemp(path.join(tmpdir(), 'uireact-ds-locked-'));
      const reactDs = path.join(parent, 'react-ds');
      const inner: Record<string, string> = {
        'src/ds/styles/globals.css': GLOBALS_CSS,
        'src/ds/components/ui/ipay-dialog.tsx': 'export const IPayDialog = () => null;\n',
        'src/ds/components/ui/ipay-bottom-sheet-modal.tsx': 'export const IPayBottomSheetModal = () => null;\n',
        'src/screens/home.tsx': [
          "import { IPayDialog } from '../ds/components/ui/ipay-dialog'",
          'export default function Home() { return <IPayDialog /> }',
        ].join('\n'),
      };
      for (const [rel, content] of Object.entries(inner)) {
        const dest = path.join(reactDs, rel);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, content, 'utf8');
      }
      await mkdir(path.join(parent, 'wireframes'), { recursive: true });
      await writeFile(path.join(parent, 'wireframes', 'home.html'), wire(comp), 'utf8');
      return { parent, reactDs };
    };

    // Locked comp used → OK.
    const ok = await lockedFixture('ipay-dialog');
    const okRes = runVerify(ok.reactDs);
    expect(okRes.stderr).toContain('wireframe locked comps: 1');
    expect(okRes.status).toBe(0);
    await rm(ok.parent, { recursive: true, force: true });

    // Locked comp never imported → hard fail.
    const unused = await lockedFixture('ipay-bottom-sheet-modal');
    const unusedRes = runVerify(unused.reactDs);
    expect(unusedRes.status).toBe(1);
    expect(unusedRes.stderr).toContain('[locked-comp]');
    expect(unusedRes.stderr).toContain('ipay-bottom-sheet-modal');
    await rm(unused.parent, { recursive: true, force: true });

    // Locked comp the DS does not ship → hard fail pointing at the preview UI.
    const invalid = await lockedFixture('non-existent-comp');
    const invalidRes = runVerify(invalid.reactDs);
    expect(invalidRes.status).toBe(1);
    expect(invalidRes.stderr).toContain('bộ DS không có component đó');
    await rm(invalid.parent, { recursive: true, force: true });
  });

  it('fails hard on rendered markup that references nothing from the ds', async () => {
    const dir = await fixture({
      'src/screens/naked.tsx': [
        'export default function Naked() {',
        "  return <div style={{ display: 'flex' }}>Xin chào</div>",
        '}',
      ].join('\n'),
    });
    const res = runVerify(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[no-token-usage]');
  });
});
