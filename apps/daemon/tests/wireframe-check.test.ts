import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkWireframes, findWireframeDirs, wireframeCheckMessage } from '../src/wireframe-check.js';

// The gate runs the REAL validator that ships with the ux-spec skill, so these
// tests also prove the skill script and the daemon agree on the vocabulary.
const SKILLS_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'skills');

const V2_OK = {
  dslVersion: 2,
  layout: {
    dir: 'stack',
    children: [
      { c: 'mobile:AppBar', props: { label: 'Chuyển tiền', back: true } },
      { c: 'shadcn:Input', props: { label: 'Số tài khoản' } },
      { c: 'shadcn:Button', props: { label: 'Tiếp tục', block: true } },
    ],
  },
};

// Unknown slug + a mistyped prop: exactly what renders as a `?slug` badge and
// hands ui-react a broken layout contract.
const V2_BROKEN = {
  dslVersion: 2,
  layout: {
    dir: 'stack',
    children: [
      { c: 'shadcn:NotAThing', props: { label: 'x' } },
      { c: 'shadcn:Checkbox', props: { label: 'Đồng ý', checked: 'yes' } },
    ],
  },
};

// Pre-v2 file: the registry maps the old names, so it must WARN, never error —
// existing projects keep passing the gate.
const V1_LEGACY = {
  layout: {
    dir: 'stack',
    children: [
      { componentType: 'navbar', label: 'Giao dịch' },
      { componentType: 'button', label: 'Tiếp tục' },
    ],
  },
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'od-wireframe-check-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function writeWireframes(dir: string, files: Record<string, unknown>) {
  await mkdir(dir, { recursive: true });
  for (const [name, doc] of Object.entries(files)) {
    await writeFile(path.join(dir, `${name}.wire.json`), JSON.stringify(doc, null, 2));
  }
}

describe('findWireframeDirs', () => {
  it('finds wireframes under the workflow folder and a per-target subfolder', async () => {
    await writeWireframes(path.join(cwd, 'docs-to-ui', 'wireframes'), { 'SCR-A': V2_OK });
    await writeWireframes(path.join(cwd, 'docs-to-ui', 'web-user', 'wireframes'), { 'SCR-B': V2_OK });
    await mkdir(path.join(cwd, 'node_modules', 'wireframes'), { recursive: true });

    const dirs = findWireframeDirs(cwd).map((d) => path.relative(cwd, d)).sort();

    expect(dirs).toEqual(['docs-to-ui/web-user/wireframes', 'docs-to-ui/wireframes']);
  });

  it('returns nothing when the project has no wireframes', () => {
    expect(findWireframeDirs(cwd)).toEqual([]);
  });
});

describe('checkWireframes', () => {
  it('passes a valid v2 wireframe with no errors or warnings', async () => {
    await writeWireframes(path.join(cwd, 'wf', 'wireframes'), { 'SCR-TRANSFER': V2_OK });

    const result = await checkWireframes(cwd, SKILLS_DIR);

    expect(result).not.toBeNull();
    expect(result!.errors).toBe(0);
    expect(result!.warnings).toBe(0);
  });

  it('reports an unknown slug and a mistyped prop as ERRORS', async () => {
    await writeWireframes(path.join(cwd, 'wf', 'wireframes'), { 'SCR-BAD': V2_BROKEN });

    const result = await checkWireframes(cwd, SKILLS_DIR);

    expect(result!.errors).toBeGreaterThanOrEqual(2);
    expect(result!.report).toContain('shadcn:NotAThing');
    expect(result!.report).toContain('shadcn:Checkbox');
  });

  it('treats legacy v1 vocabulary as warnings only, so old projects still pass', async () => {
    await writeWireframes(path.join(cwd, 'wf', 'wireframes'), { 'SCR-OLD': V1_LEGACY });

    const result = await checkWireframes(cwd, SKILLS_DIR);

    expect(result!.errors).toBe(0);
    expect(result!.warnings).toBeGreaterThan(0);
    expect(result!.report).toContain('shadcn:Button');
  });

  it('returns null when there is nothing to check', async () => {
    expect(await checkWireframes(cwd, SKILLS_DIR)).toBeNull();
  });

  it('returns null when the validator is not installed, instead of failing the run', async () => {
    await writeWireframes(path.join(cwd, 'wf', 'wireframes'), { 'SCR-A': V2_OK });

    expect(await checkWireframes(cwd, path.join(cwd, 'no-skills-here'))).toBeNull();
  });
});

describe('wireframeCheckMessage', () => {
  it('leads with the error count and tells the user what breaks downstream', () => {
    const message = wireframeCheckMessage({ dirs: ['wireframes'], errors: 2, warnings: 1, report: 'x' });

    expect(message).toContain('2 lỗi');
    expect(message).toContain('wire-components.md');
  });
});
