import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';

import { sectionKey, listSections, mergeCjSections, mergeUxrSections, mergeUxSpecSections } from '../src/section-fanout.js';

test('sectionKey groups a section overview file and its children under one key', () => {
  assert.equal(sectionKey('docs/confluence/I.-Tai-khoan.md'), 'I.-Tai-khoan');
  assert.equal(sectionKey('docs/confluence/I.-Tai-khoan/1-thiet-lap.md'), 'I.-Tai-khoan');
  assert.equal(sectionKey('docs/confluence/I.-Tai-khoan/sub/deep.md'), 'I.-Tai-khoan');
  assert.equal(sectionKey('docs/confluence/root.md'), 'root');
});

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'section-fanout-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test('listSections groups pages by top-level section with the overview title', async () => {
  const conf = join(cwd, 'docs', 'confluence');
  await mkdir(join(conf, 'I.-Tai-khoan'), { recursive: true });
  await mkdir(join(conf, 'II.-Danh-muc'), { recursive: true });
  await writeFile(join(conf, 'I.-Tai-khoan.md'), '---\ntitle: I. Tài khoản\n---\nOverview\n');
  await writeFile(join(conf, 'I.-Tai-khoan', '1-thiet-lap.md'), '---\ntitle: 1. Thiết lập\n---\nx\n');
  await writeFile(join(conf, 'II.-Danh-muc.md'), '---\ntitle: II. Danh mục\n---\ny\n');
  await writeFile(join(conf, '_index.md'), 'toc\n');

  const sections = await listSections(cwd);
  assert.equal(sections.length, 2);
  const s1 = sections.find((s) => s.key === 'I.-Tai-khoan')!;
  assert.equal(s1.title, 'I. Tài khoản');
  assert.equal(s1.mdPaths.length, 2); // overview + child
  const s2 = sections.find((s) => s.key === 'II.-Danh-muc')!;
  assert.equal(s2.title, 'II. Danh mục');
  assert.equal(s2.mdPaths.length, 1);
});

test('listSections prefers docs-feature when it contains markdown', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'od-section-feature-'));
  await mkdir(join(cwd, 'docs-feature', 'payments'), { recursive: true });
  await writeFile(join(cwd, 'docs-feature', 'payments', 'page.md'), '# Payments');
  await mkdir(join(cwd, 'docs', 'confluence'), { recursive: true });
  await writeFile(join(cwd, 'docs', 'confluence', 'legacy.md'), '# Legacy');
  const sections = await listSections(cwd);
  assert.deepEqual(sections.map((s) => s.key), ['payments']);
  await rm(cwd, { recursive: true, force: true });
});

test('mergeCjSections unions personas by name and concatenates journeys tagged by section', () => {
  const merged = mergeCjSections([
    {
      key: 'I',
      title: 'I. Tài khoản',
      cj: { personas: [{ name: 'Kế toán viên' }], journeys: [{ name: 'Thiết lập TK' }] },
    },
    {
      key: 'IV',
      title: 'IV. Mua hàng',
      cj: { personas: [{ name: 'Kế toán viên' }, { name: 'Kế toán trưởng' }], journeys: [{ name: 'Mua hàng' }] },
    },
    { key: 'V', title: 'V. Bán hàng', cj: null }, // failed section — skipped
  ]) as any;
  assert.equal(merged.personas.length, 2); // "Kế toán viên" deduped
  assert.equal(merged.journeys.length, 2);
  assert.equal(merged.journeys[0].section, 'I. Tài khoản');
  assert.equal(merged.journeys[1].section, 'IV. Mua hàng'); // operational module PRESENT
});

test('mergeUxSpecSections concatenates module-prefixed screens + unions personas', () => {
  const merged = mergeUxSpecSections([
    {
      key: 'I',
      title: 'I. Tài khoản',
      spec: { personas: [{ name: 'Kế toán viên' }], screens: [{ id: 'I__SCR-Login', screen_type: 'form' }] },
    },
    {
      key: 'IV',
      title: 'IV. Mua hàng',
      spec: { personas: [{ name: 'Kế toán viên' }], screens: [{ id: 'IV__SCR-PO', screen_type: 'form' }] },
    },
    { key: 'V', title: 'V. Bán hàng', spec: null }, // failed module — skipped
  ]) as any;
  assert.equal(merged.screens.length, 2);
  assert.deepEqual(merged.screens.map((s: any) => s.id), ['I__SCR-Login', 'IV__SCR-PO']); // no id collision
  assert.equal(merged.screens[1].section, 'IV. Mua hàng');
  assert.equal(merged.personas.length, 1); // deduped by name
});

test('mergeUxrSections renumbers criteria globally and rewrites reference used_for', () => {
  const { report, reportMd } = mergeUxrSections([
    {
      key: 'I',
      title: 'I. Tài khoản',
      uxr: {
        criteria: [{ id: 'UXR-01', title: 'Inline validation', priority: 'must' }],
        references: [{ url: 'https://a', used_for: ['UXR-01'] }],
      },
    },
    {
      key: 'IV',
      title: 'IV. Mua hàng',
      uxr: {
        criteria: [
          { id: 'UXR-01', title: 'Bulk actions', priority: 'should' },
          { id: 'UXR-02', title: 'Undo', priority: 'nice' },
        ],
        references: [{ url: 'https://a', used_for: ['UXR-01'] }], // same source, section-local id
      },
    },
  ]) as any;
  const r = report as any;
  // 3 criteria, globally renumbered 01..03 (no collision).
  assert.deepEqual(r.criteria.map((c: any) => c.id), ['UXR-01', 'UXR-02', 'UXR-03']);
  assert.equal(r.criteria[2].title, 'Undo');
  assert.equal(r.summary.criteria, 3);
  assert.equal(r.summary.must, 1);
  // The shared reference (url https://a) merged; its used_for spans both
  // sections' remapped ids (I's UXR-01 → UXR-01, IV's UXR-01 → UXR-02).
  assert.equal(r.references.length, 1);
  assert.deepEqual([...r.references[0].used_for].sort(), ['UXR-01', 'UXR-02']);
  assert.match(reportMd, /UX Research/);
});
