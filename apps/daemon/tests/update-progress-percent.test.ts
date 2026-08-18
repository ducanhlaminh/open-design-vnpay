import { describe, expect, it } from 'vitest';
import { parseUpdateProgress } from '../src/server.js';

// Feeds the header update button (apps/web HostUpdateButton): overall
// percent = completed steps + the last "NN%" seen inside the current step.
describe('parseUpdateProgress', () => {
  it('returns null before the first N/6 phase line', () => {
    expect(parseUpdateProgress('Kiem tra ket noi mang\n  [ok] github.com\n')).toBeNull();
  });

  it('estimates from the step alone when the step has no inner percent yet', () => {
    const p = parseUpdateProgress('1/6 Kiem tra goi cai dat\n  > Looking up the latest release\n');
    expect(p).toEqual({ step: 1, totalSteps: 6, label: 'Kiem tra goi cai dat', percent: 0 });
    expect(parseUpdateProgress('\x1b[1m4/6 Cau hinh dich vu\x1b[0m\n')?.percent).toBe(50);
  });

  it('refines with install.ps1 download milestones inside the current step', () => {
    const log = [
      '1/6 Kiem tra goi cai dat',
      'download attempt 1/3: https://example/x.tar.gz',
      'download 25% (1/4 bytes)',
      'download 50% (2/4 bytes)',
    ].join('\n');
    expect(parseUpdateProgress(log)?.percent).toBe(8); // (0 + 0.5) / 6
  });

  it("refines with curl's \\r-separated progress bar (install.sh) and ignores earlier steps", () => {
    const log = '1/6 Goi cai dat\n####  10.0%\r########  40.0%\r####################  80.0%\n2/6 Node.js\n';
    expect(parseUpdateProgress(log)).toMatchObject({ step: 2, percent: 17 });
    const withInner = log + '###  30.0%\r';
    expect(parseUpdateProgress(withInner)?.percent).toBe(22); // (1 + 0.3) / 6
  });

  it('never reports 100 while the installer is still writing the log', () => {
    expect(parseUpdateProgress('6/6 Hoan tat\n100%\n')?.percent).toBe(99);
  });
});
