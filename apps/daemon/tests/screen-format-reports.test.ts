import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SCREEN_FORMAT_REPORTS_FOLDER,
  SCREEN_FORMAT_REPORTS_OUTBOX_DIR,
  SCREEN_FORMAT_REPORT_MAX_ATTACHMENTS,
  SCREEN_FORMAT_REPORT_MAX_BUNDLE_BYTES,
  SCREEN_FORMAT_REPORT_MAX_FILE_BYTES,
  computeScreenFormatFingerprint,
  createScreenFormatReporter,
  type ScreenFormatObservationManifest,
} from '../src/screen-format-reports.js';

type Upload = { folder: string; stage: string; filePath: string; mime: string; content: Buffer };

function fakeClient(opts: { failFirst?: number } = {}) {
  const uploads: Upload[] = [];
  let failures = opts.failFirst ?? 0;
  return {
    uploads,
    uploadFile: vi.fn(async (folder: string, stage: string, filePath: string, mime: string, content: Buffer) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('offline');
      }
      uploads.push({ folder, stage, filePath, mime, content: Buffer.from(content) });
    }),
  };
}

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

describe('createScreenFormatReporter', () => {
  let dataDir: string;
  let projectRoot: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'od-screen-format-data-'));
    projectRoot = mkdtempSync(path.join(os.tmpdir(), 'od-screen-format-project-'));
    delete process.env.OD_SCREEN_FORMAT_REPORTS;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    delete process.env.OD_SCREEN_FORMAT_REPORTS;
  });

  function input() {
    return {
      projectId: 'P1',
      projectName: 'SIM du lịch',
      workflowId: 'docs-review',
      stageId: 'dr-flow',
      severity: 'info' as const,
      app: { version: '0.8.200', channel: 'preview', packaged: true },
      installationId: 'install:one',
      scannerTrace: { scanner: 'scanDocScreens', screensFound: 0, formatsTried: ['explicit-code', 'numbered-heading'] },
      recovery: {
        accepted: [{ flowId: 'FLOW-sim', name: 'Trang chủ', source: 'docs-feature/prd.md', cells: ['C_Type'] }],
        rejected: [{ flowId: 'FLOW-sim', name: 'Backend', reason: 'không có bằng chứng UI' }],
      },
      projectRoot,
      sources: ['docs-feature/prd.md'],
    };
  }

  it('uploads full Markdown byte-for-byte plus referenced local attachments and a complete manifest', async () => {
    const md = Buffer.from('# PRD\r\n\r\n![Ảnh](attachments/mock.png)\r\n[Flow](attachments/screen.mmd)\r\n', 'utf8');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const mmd = Buffer.from('flowchart TD\n A-->B\n', 'utf8');
    mkdirSync(path.join(projectRoot, 'docs-feature', 'attachments'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'docs-feature', 'prd.md'), md);
    writeFileSync(path.join(projectRoot, 'docs-feature', 'attachments', 'mock.png'), png);
    writeFileSync(path.join(projectRoot, 'docs-feature', 'attachments', 'screen.mmd'), mmd);

    const client = fakeClient();
    const reporter = createScreenFormatReporter({ dataDir, client, now: () => 1_700_000_000_000, id: () => 'obs-1', log: () => {} });
    expect(reporter.report(input())).toBe('obs-1');
    await reporter.idle();

    const prefix = 'observations/installone/obs-1/';
    const docUpload = client.uploads.find((u) => u.filePath === `${prefix}documents/docs-feature/prd.md`)!;
    expect(docUpload.folder).toBe(SCREEN_FORMAT_REPORTS_FOLDER);
    expect(docUpload.stage).toBe('observations');
    expect(docUpload.mime).toBe('text/markdown');
    expect(docUpload.content.equals(md)).toBe(true);

    const pngUpload = client.uploads.find((u) => u.filePath === `${prefix}attachments/docs-feature/attachments/mock.png`)!;
    expect(pngUpload.content.equals(png)).toBe(true);
    expect(pngUpload.mime).toBe('image/png');
    const manifestUpload = client.uploads.find((u) => u.filePath === `${prefix}manifest.json`)!;
    const manifest = JSON.parse(manifestUpload.content.toString('utf8')) as ScreenFormatObservationManifest;
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      observationId: 'obs-1',
      containsFullDocument: true,
      severity: 'info',
      project: { id: 'P1', name: 'SIM du lịch', workflowId: 'docs-review', stageId: 'dr-flow' },
      app: { version: '0.8.200', channel: 'preview', packaged: true },
      installationId: 'install:one',
      scannerTrace: { screensFound: 0 },
    });
    expect(manifest.documents).toEqual([
      expect.objectContaining({ source: 'docs-feature/prd.md', status: 'included', size: md.length, checksum: sha256(md), mime: 'text/markdown' }),
    ]);
    expect(manifest.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'docs-feature/attachments/mock.png', status: 'included', size: png.length, checksum: sha256(png), mime: 'image/png' }),
        expect.objectContaining({ source: 'docs-feature/attachments/screen.mmd', status: 'included', size: mmd.length, checksum: sha256(mmd), mime: 'text/plain' }),
      ]),
    );
    expect(readdirSync(path.join(dataDir, SCREEN_FORMAT_REPORTS_OUTBOX_DIR))).toEqual([]);
  });

  it('prioritizes full Markdown and records every omitted attachment for file, count, bundle, missing and outside-project caps', async () => {
    const refs = [
      '![large](a/large.bin)',
      '![one](a/one.png)',
      '![two](a/two.png)',
      '![missing](a/missing.png)',
      '[outside](../../outside.secret)',
      '![three](a/three.png)',
    ].join('\n');
    const md = Buffer.from(refs, 'utf8');
    mkdirSync(path.join(projectRoot, 'docs-feature', 'a'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'docs-feature', 'prd.md'), md);
    writeFileSync(path.join(projectRoot, 'docs-feature', 'a', 'large.bin'), Buffer.alloc(9, 1));
    writeFileSync(path.join(projectRoot, 'docs-feature', 'a', 'one.png'), Buffer.alloc(4, 2));
    writeFileSync(path.join(projectRoot, 'docs-feature', 'a', 'two.png'), Buffer.alloc(4, 3));
    writeFileSync(path.join(projectRoot, 'docs-feature', 'a', 'three.png'), Buffer.alloc(1, 4));

    const client = fakeClient();
    const reporter = createScreenFormatReporter({
      dataDir,
      client,
      now: () => 1,
      id: () => 'caps',
      log: () => {},
      limits: { bundleBytes: md.length + 4, fileBytes: 8, attachments: 4 },
    });
    reporter.report(input());
    await reporter.idle();
    const manifest = JSON.parse(client.uploads.find((u) => u.filePath.endsWith('/manifest.json'))!.content.toString()) as ScreenFormatObservationManifest;
    expect(manifest.documents[0]).toMatchObject({ status: 'included', size: md.length });
    const omitted = new Map(manifest.attachments.map((a) => [a.source, a.omittedReason]));
    expect(omitted.get('docs-feature/a/large.bin')).toBe('file-size-cap');
    expect(omitted.get('docs-feature/a/one.png')).toBeUndefined();
    expect(omitted.get('docs-feature/a/two.png')).toBe('bundle-size-cap');
    expect(omitted.get('docs-feature/a/missing.png')).toBe('missing');
    expect(omitted.get('docs-feature/a/three.png')).toBe('attachment-count-cap');
    expect([...omitted.values()]).toContain('outside-project');
  });

  it('exports the production caps and computes a stable content/format fingerprint', () => {
    expect(SCREEN_FORMAT_REPORT_MAX_BUNDLE_BYTES).toBe(25 * 1024 * 1024);
    expect(SCREEN_FORMAT_REPORT_MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(SCREEN_FORMAT_REPORT_MAX_ATTACHMENTS).toBe(50);
    const a = computeScreenFormatFingerprint({
      scannerTrace: { formatsTried: ['a', 'b'], screensFound: 0 },
      documents: [{ source: 'docs-feature/a.md', checksum: 'abc' }],
    });
    const b = computeScreenFormatFingerprint({
      documents: [{ checksum: 'abc', source: 'docs-feature/a.md' }],
      scannerTrace: { screensFound: 0, formatsTried: ['a', 'b'] },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it('keeps a durable bundle after upload failure and drains it on explicit retry without rejecting report()', async () => {
    mkdirSync(path.join(projectRoot, 'docs-feature'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'docs-feature', 'prd.md'), '# Full secret document\n');
    const client = fakeClient({ failFirst: 1 });
    const logs: string[] = [];
    const reporter = createScreenFormatReporter({ dataDir, client, id: () => 'retry', log: (message) => logs.push(message) });
    expect(() => reporter.report(input())).not.toThrow();
    await reporter.idle();
    expect(client.uploads).toHaveLength(0);
    expect(readdirSync(path.join(dataDir, SCREEN_FORMAT_REPORTS_OUTBOX_DIR))).toHaveLength(1);
    expect(logs.join('\n')).not.toContain('Full secret document');

    expect(await reporter.flushOutbox()).toEqual({ sent: 1, left: 0 });
    expect(client.uploads.some((u) => u.filePath.endsWith('/documents/docs-feature/prd.md'))).toBe(true);
    expect(readdirSync(path.join(dataDir, SCREEN_FORMAT_REPORTS_OUTBOX_DIR))).toEqual([]);
  });

  it('OD_SCREEN_FORMAT_REPORTS=0 returns an id but creates no outbox and uploads nothing', async () => {
    process.env.OD_SCREEN_FORMAT_REPORTS = '0';
    mkdirSync(path.join(projectRoot, 'docs-feature'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'docs-feature', 'prd.md'), '# Doc\n');
    const client = fakeClient();
    const reporter = createScreenFormatReporter({ dataDir, client, id: () => 'disabled', log: () => {} });
    expect(reporter.report(input())).toBe('disabled');
    await reporter.idle();
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(readdirSync(dataDir)).not.toContain('screen-format-reports');
  });
});
