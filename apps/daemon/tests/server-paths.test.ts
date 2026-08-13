import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDaemonCliPath, resolveDaemonResourceRoot, resolveProjectRoot } from '../src/server.js';

describe('resolveProjectRoot', () => {
  it('resolves the repository root from the source daemon directory', () => {
    const root = path.resolve(import.meta.dirname, '../../..');

    expect(resolveProjectRoot(path.join(root, 'apps', 'daemon'))).toBe(root);
  });

  it('resolves the repository root from the live TypeScript source directory', () => {
    const root = path.resolve(import.meta.dirname, '../../..');

    expect(resolveProjectRoot(path.join(root, 'apps', 'daemon', 'src'))).toBe(root);
  });

  it('resolves the repository root from the compiled daemon dist directory', () => {
    const root = path.resolve(import.meta.dirname, '../../..');

    expect(resolveProjectRoot(path.join(root, 'apps', 'daemon', 'dist'))).toBe(root);
  });

  it('resolves the repository root from the daemon src directory (tsx entry)', () => {
    const root = path.resolve(import.meta.dirname, '../../..');

    expect(resolveProjectRoot(path.join(root, 'apps', 'daemon', 'src'))).toBe(root);
  });
});

describe('resolveDaemonCliPath', () => {
  it('resolves the od CLI from the daemon package root', () => {
    const packageRoot = path.resolve(import.meta.dirname, '..');

    expect(resolveDaemonCliPath()).toBe(path.join(packageRoot, 'dist', 'cli.js'));
  });

  it('uses the packaged daemon CLI path override before package resolution', () => {
    expect(resolveDaemonCliPath({ OD_DAEMON_CLI_PATH: '/app/prebundled/daemon-cli.mjs' })).toBe(
      '/app/prebundled/daemon-cli.mjs',
    );
  });

  it('uses OD_BIN as a fallback override for bundled wrapper invocations', () => {
    expect(resolveDaemonCliPath({ OD_BIN: '/app/prebundled/daemon-cli.mjs' })).toBe(
      '/app/prebundled/daemon-cli.mjs',
    );
  });
});

describe('resolveDaemonResourceRoot', () => {
  it('allows resource roots under an explicit safe base', () => {
    const safeBase = path.resolve(import.meta.dirname, '..', 'fixtures', 'resources');
    const configured = path.join(safeBase, 'packaged');

    expect(resolveDaemonResourceRoot({ configured, safeBases: [safeBase] })).toBe(configured);
  });

  it('allows a resource root equal to an explicit safe base', () => {
    const safeBase = path.resolve(import.meta.dirname, '..', 'fixtures', 'resources');

    expect(resolveDaemonResourceRoot({ configured: safeBase, safeBases: [safeBase] })).toBe(safeBase);
  });

  it('rejects resource roots outside the safe bases', () => {
    const safeBase = path.resolve(import.meta.dirname, '..', 'fixtures', 'resources');
    const configured = path.resolve(import.meta.dirname, '..', 'fixtures-other', 'resources');

    expect(() => resolveDaemonResourceRoot({ configured, safeBases: [safeBase] })).toThrow(
      /OD_RESOURCE_ROOT must be under/,
    );
  });

  // Regression for a real host-runtime install bug: `deploy/host/install.sh`
  // deliberately writes OD_RESOURCE_ROOT through the STABLE `<OD_HOME>/
  // current/resources/open-design` symlink (so it survives `--update`
  // without a rewrite), but Node's ESM loader resolves symlinks when
  // computing `__dirname` — so PROJECT_ROOT (this function's own safe base
  // in production) is already the REAL `releases/<version>` path, not
  // `current`. A purely lexical containment check rejects a legitimately
  // configured value that only differs by symlink indirection. None of the
  // tests above exercise a real symlink (their fixture paths don't even
  // exist on disk), so this gap shipped unnoticed until a live install.
  describe('symlink indirection (regression: host-runtime `current` symlink)', () => {
    const tmpRoot = mkdtempSync(path.join(realpathSync(tmpdir()), 'od-resource-root-'));
    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('allows a configured root reached through a symlink into the real safe base', () => {
      const release = path.join(tmpRoot, 'releases', '0.8.0');
      const resources = path.join(release, 'resources', 'open-design');
      mkdirSync(resources, { recursive: true });
      const current = path.join(tmpRoot, 'current');
      symlinkSync(release, current);

      const configured = path.join(current, 'resources', 'open-design');
      expect(resolveDaemonResourceRoot({ configured, safeBases: [release] })).toBe(configured);
    });

    it('still rejects a symlink pointing genuinely outside every safe base', () => {
      const release = path.join(tmpRoot, 'releases', '0.8.0');
      const outside = path.join(tmpRoot, 'outside', 'resources');
      mkdirSync(release, { recursive: true });
      mkdirSync(outside, { recursive: true });
      const escape = path.join(tmpRoot, 'escape');
      symlinkSync(outside, escape);

      expect(() => resolveDaemonResourceRoot({ configured: escape, safeBases: [release] })).toThrow(
        /OD_RESOURCE_ROOT must be under/,
      );
    });
  });
});
