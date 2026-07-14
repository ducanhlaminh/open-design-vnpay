import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commitHistory,
  historyAvailable,
  listHistory,
  restoreCommit,
  showFileAt,
} from '../src/project-history.js';

let gitOk = false;
beforeAll(async () => {
  gitOk = await historyAvailable();
});

function freshCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'od-history-'));
  mkdirSync(join(dir, 'docs-to-html', 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs-to-html', 'docs', 'a.md'), '# v1');
  return dir;
}

describe('project history (hidden git repo)', () => {
  it('commits, lists with structured meta, and no-ops on a clean tree', async () => {
    if (!gitOk) return; // machine without git — feature self-disables
    const cwd = freshCwd();

    const first = await commitHistory(cwd, {
      kind: 'run',
      pipelineId: 'html-docs',
      runId: 'run-1',
      status: 'succeeded',
      by: { email: 'anhnd13@vnpay.vn', name: 'Anh' },
      input: 'PRD-1',
    });
    expect(first).not.toBeNull();
    expect(first!.filesChanged).toBeGreaterThan(0);

    // clean tree → null (no empty commits)
    expect(await commitHistory(cwd, { kind: 'push' })).toBeNull();

    writeFileSync(join(cwd, 'docs-to-html', 'docs', 'a.md'), '# v2');
    const second = await commitHistory(cwd, { kind: 'push', verId: 'v1' });
    expect(second).not.toBeNull();

    const entries = await listHistory(cwd);
    expect(entries.length).toBe(2);
    expect(entries[0]).toMatchObject({ kind: 'push', verId: 'v1', commit: second!.commit });
    expect(entries[1]).toMatchObject({
      kind: 'run',
      pipelineId: 'html-docs',
      status: 'succeeded',
      by: { email: 'anhnd13@vnpay.vn' },
    });
  });

  it('showFileAt reads old content; restoreCommit rewinds and records itself', async () => {
    if (!gitOk) return;
    const cwd = freshCwd();
    const c1 = await commitHistory(cwd, { kind: 'run', runId: 'r1' });
    writeFileSync(join(cwd, 'docs-to-html', 'docs', 'a.md'), '# v2');
    await commitHistory(cwd, { kind: 'run', runId: 'r2' });

    const old = await showFileAt(cwd, c1!.commit, 'docs-to-html/docs/a.md');
    expect(old?.toString()).toBe('# v1');
    expect(await showFileAt(cwd, c1!.commit, 'khong/ton/tai.md')).toBeNull();

    const restored = await restoreCommit(cwd, c1!.commit, undefined, { email: 'anhnd13@vnpay.vn' });
    expect(readFileSync(join(cwd, 'docs-to-html', 'docs', 'a.md'), 'utf8')).toBe('# v1');
    expect(restored).not.toBeNull();
    const entries = await listHistory(cwd);
    expect(entries[0]!.kind).toBe('restore');
  });

  it('never syncs itself: git dir is a dotfile and excludes cover node_modules', async () => {
    if (!gitOk) return;
    const cwd = freshCwd();
    mkdirSync(join(cwd, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'x', 'index.js'), '0');
    const c = await commitHistory(cwd, { kind: 'run' });
    expect(c).not.toBeNull();
    // .odhistory exists but as a dotfile the sync walker skips it
    expect(existsSync(join(cwd, '.odhistory', 'HEAD'))).toBe(true);
    // node_modules must not be tracked (info/exclude)
    writeFileSync(join(cwd, 'node_modules', 'x', 'index.js'), '1');
    expect(await commitHistory(cwd, { kind: 'run' })).toBeNull();
  });
});
