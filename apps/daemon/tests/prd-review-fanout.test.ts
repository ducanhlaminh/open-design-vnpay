import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';

import { pageSlug, listRequirementPages, scorePageReport, mergePageReports } from '../src/prd-review-fanout.js';

test('pageSlug strips docs/confluence prefix, flattens folders, drops .md', () => {
  assert.equal(pageSlug('docs/confluence/i-tai-khoan/1-thiet-lap.md'), 'i-tai-khoan__1-thiet-lap');
  assert.equal(pageSlug('docs/confluence/danh-sach.md'), 'danh-sach');
  assert.equal(pageSlug('./docs/confluence/a/b/c.md'), 'a__b__c');
});

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'prd-fanout-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test('listRequirementPages returns every requirements page, including pages without illustrations', async () => {
  const conf = join(cwd, 'docs', 'confluence');
  await mkdir(join(conf, 'i-tai-khoan'), { recursive: true });
  await mkdir(join(conf, 'attachments'), { recursive: true });
  // A page WITH two mockups (nested).
  await writeFile(
    join(conf, 'i-tai-khoan', '1-thiet-lap.md'),
    '---\ntitle: 1. Thiết lập tài khoản\npage_id: 12\n---\n\nText ![a](../attachments/x.png) more ![b](../attachments/y.png)\n',
  );
  // A requirements page with no illustration remains eligible.
  await writeFile(join(conf, 'danh-muc.md'), '---\ntitle: II. Danh mục\n---\n\nNo images here.\n');
  // The _index.md companion → excluded even if it links images.
  await writeFile(join(conf, '_index.md'), '![i](attachments/z.png)\n');
  // A stray file under attachments/ → excluded.
  await writeFile(join(conf, 'attachments', 'note.md'), '![n](x.png)\n');

  const pages = await listRequirementPages(cwd);
  assert.equal(pages.length, 2);
  const illustrated = pages.find((page) => page.slug === 'i-tai-khoan__1-thiet-lap');
  assert.equal(illustrated?.page, '1. Thiết lập tài khoản');
  assert.equal(illustrated?.illustrationCount, 2);
  assert.equal(illustrated?.mdPath, 'docs/confluence/i-tai-khoan/1-thiet-lap.md');
  const textOnly = pages.find((page) => page.slug === 'danh-muc');
  assert.equal(textOnly?.illustrationCount, 0);
});

test('listRequirementPages prefers docs-feature', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'od-prd-feature-'));
  await mkdir(join(cwd, 'docs-feature'), { recursive: true });
  await writeFile(join(cwd, 'docs-feature', 'screen.md'), '![screen](attachments/a.png)');
  await mkdir(join(cwd, 'docs', 'confluence'), { recursive: true });
  await writeFile(join(cwd, 'docs', 'confluence', 'legacy.md'), '![legacy](attachments/b.png)');
  const pages = await listRequirementPages(cwd);
  assert.equal(pages[0]?.mdPath, 'docs-feature/screen.md');
  await rm(cwd, { recursive: true, force: true });
});

test('scorePageReport recomputes counts/score/verdict from images (skill arithmetic)', () => {
  const r = scorePageReport({
    images: [
      { findings: [{ severity: 'blocker' }, { severity: 'minor' }] }, // 100-25-3=72, blocker→fail
      { findings: [{ severity: 'major' }] }, // 90 → pass? 90≥85 pass
    ],
  });
  assert.equal(r.images, 2);
  assert.equal(r.blockers, 1);
  assert.equal(r.majors, 1);
  assert.equal(r.minors, 1);
  assert.equal(r.score, Math.round((72 + 90) / 2)); // 81
  assert.equal(r.verdict, 'fail'); // any image fail → page fail
});

test('scorePageReport ignores diagram images (flow reference, never scored)', () => {
  const r = scorePageReport({
    images: [
      { kind: 'screen', findings: [{ severity: 'major' }] }, // 90 pass
      { kind: 'diagram', summary: 'sequence flow' }, // must NOT count or inflate the mean
    ],
  });
  assert.equal(r.images, 1); // only the screen
  assert.equal(r.score, 90); // diagram's implicit 100 must not enter the mean
  assert.equal(r.majors, 1);
  assert.equal(r.verdict, 'pass');
});

test('mergePageReports builds a worst-first index + summary, and marks a failed page', () => {
  const { index, summaryMd } = mergePageReports([
    {
      slug: 'a',
      page: 'Trang A (pass)',
      mdPath: 'docs/confluence/a.md',
      report: { images: [{ findings: [] }] }, // 100 pass
    },
    {
      slug: 'b',
      page: 'Trang B (fail)',
      mdPath: 'docs/confluence/b.md',
      report: { images: [{ findings: [{ severity: 'blocker' }] }] }, // fail
    },
    {
      slug: 'c',
      page: 'Trang C (run lỗi)',
      mdPath: 'docs/confluence/c.md',
      report: null, // the page's run produced nothing → marked fail, still listed
    },
  ]);
  const idx = index as any;
  assert.equal(idx.kind, 'docs-mockup-review-index');
  // Worst-verdict first: the two fails (b, c) precede the pass (a).
  assert.equal(idx.pages[idx.pages.length - 1].slug, 'a');
  assert.equal(idx.summary.verdict, 'fail');
  assert.equal(idx.summary.images, 2); // c contributed 0
  // Each page points at its own report path.
  assert.equal(idx.pages.find((p: any) => p.slug === 'b').report, 'b/report.json');
  assert.match(summaryMd, /PRD Requirements Review/);
  assert.match(summaryMd, /Trang B \(fail\)/);
});
