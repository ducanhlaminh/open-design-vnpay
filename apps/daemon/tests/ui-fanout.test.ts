import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';

import { screenSlug, listScreens, mergeHeuristicScreens, renderPrototypeIndex } from '../src/ui-fanout.js';

test('screenSlug kebab-cases the screen id', () => {
  assert.equal(screenSlug('SCR-Login'), 'scr-login');
  assert.equal(screenSlug('SCR_Bank.Account 2'), 'scr-bank-account-2');
});

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'ui-fanout-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test('listScreens reads screens from the -ux-spec.json (id + name + slug), dedups', async () => {
  await writeFile(
    join(cwd, 'test-ux-spec.json'),
    JSON.stringify({
      screens: [
        { id: 'SCR-Login', screen_type: 'form', name: 'Đăng nhập' },
        { id: 'SCR-List', screen_type: 'list' },
        { id: 'SCR-Login', screen_type: 'form' }, // dup id → dropped
      ],
    }),
  );
  const screens = await listScreens(cwd);
  assert.equal(screens.length, 2);
  assert.deepEqual(screens[0], { id: 'SCR-Login', name: 'Đăng nhập', slug: 'scr-login' });
  assert.equal(screens[1]!.name, 'list'); // falls back to screen_type
});

test('listScreens returns [] when no ux-spec present', async () => {
  assert.deepEqual(await listScreens(cwd), []);
});

test('mergeHeuristicScreens concatenates per-screen rows + recomputes summary; marks empty run failed', () => {
  const merged = mergeHeuristicScreens([
    { id: 'SCR-A', name: 'A', report: { screens: [{ screen: 'SCR-A', score: 100, verdict: 'pass', findings: [] }] } },
    { id: 'SCR-B', name: 'B', report: { screens: [{ screen: 'SCR-B', findings: [{ severity: 'blocker' }, { severity: 'minor' }] }] } },
    { id: 'SCR-C', name: 'C', report: null }, // failed run → placeholder
  ]) as any;
  assert.equal(merged.summary.screens, 3);
  assert.equal(merged.summary.blockers, 1);
  assert.equal(merged.summary.minors, 1);
  assert.equal(merged.summary.verdict, 'fail'); // B blocker + C placeholder
  assert.equal(merged.screens.find((s: any) => s.screen === 'SCR-C').verdict, 'fail');
  // Screen id preserved verbatim (downstream joins wireframes on it).
  assert.equal(merged.screens[1].screen, 'SCR-B');
});

test('renderPrototypeIndex lists every screen linking its slug.html', () => {
  const html = renderPrototypeIndex([
    { id: 'SCR-Login', name: 'Đăng nhập', slug: 'scr-login' },
    { id: 'SCR-List', name: 'Danh sách', slug: 'scr-list' },
  ]);
  assert.match(html, /<a href="\.\/scr-login\.html">Đăng nhập<\/a>/);
  assert.match(html, /<a href="\.\/scr-list\.html">Danh sách<\/a>/);
  assert.match(html, /2 màn hình/);
});
