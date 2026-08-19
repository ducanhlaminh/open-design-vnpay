// WP6 — deploy/host/install.sh shell-level tests. Mirrors the style of
// deploy/tests/install.test.ts (node:test + node:assert/strict + a plain
// execFile child process, no extra test-framework dependency).
//
// Every test here spawns a real `bash` child process; none of them drive a
// real launchd/systemd session — service registration is stubbed by
// sourcing install.sh with OD_INSTALL_SH_TEST_SOURCE=1 (see the guard at the
// bottom of install.sh) and overriding start_service/write_service_files
// with no-op shell functions before calling the function under test.
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, chmod, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, '../..');
const installScript = join(repoRoot, 'deploy/host/install.sh');

async function mktmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `od-host-install-${prefix}-`));
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** Minimal-but-structurally-valid release tree (VERSION + service templates +
 * a stub cli.js) — enough for install.sh's extract/config/service-file steps
 * without needing a real daemon build. */
async function writeMinimalRelease(dir: string, version: string): Promise<void> {
  await mkdir(join(dir, 'apps', 'daemon', 'dist'), { recursive: true });
  await mkdir(join(dir, 'apps', 'web', 'out'), { recursive: true });
  await mkdir(join(dir, 'runtime', 'service'), { recursive: true });
  await writeFile(join(dir, 'VERSION'), `${version}\n`);
  await writeFile(join(dir, 'install.sh'), '#!/usr/bin/env bash\n# updater fixture\n');
  await writeFile(
    join(dir, 'apps', 'daemon', 'dist', 'cli.js'),
    '// stub — not executed by --no-start tests\n',
  );
  await writeFile(join(dir, 'apps', 'web', 'out', 'index.html'), '<html></html>');
  await writeFile(
    join(dir, 'runtime', 'service', 'com.vnpay.open-design.plist.in'),
    '<plist>@OD_BIN@ @OD_HOME@</plist>\n',
  );
  await writeFile(
    join(dir, 'runtime', 'service', 'open-design.service.in'),
    'ExecStart=@OD_BIN@ @OD_HOME@\n',
  );
}

/** Packs `dir` (must be a single directory, e.g. `<root>/<stageName>`) into
 * `<root>/<stageName>.tar.gz` and returns the tarball path + its sha256. */
async function packRelease(root: string, stageName: string): Promise<{ archive: string; sha256: string }> {
  const archive = join(root, `${stageName}.tar.gz`);
  await execFileAsync('tar', ['-czf', archive, '-C', root, stageName]);
  const sha256Hex = sha256(await readFile(archive));
  return { archive, sha256: sha256Hex };
}

// ---------------------------------------------------------------------------
// --help — no side effects
// ---------------------------------------------------------------------------
test('install.sh --help exits 0 and documents the minimum flag set', async () => {
  const { stdout } = await execFileAsync('bash', [installScript, '--help']);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /--archive/);
  assert.match(stdout, /--release-url/);
  assert.match(stdout, /--sha256/);
  assert.match(stdout, /--port/);
  assert.match(stdout, /--data-dir/);
  assert.match(stdout, /--env-file/);
  assert.match(stdout, /--no-start/);
  assert.match(stdout, /--update/);
  assert.match(stdout, /--start/);
  assert.match(stdout, /--stop/);
});

test('fails fast for unknown flags and flags with missing values', async () => {
  for (const args of [['--udpate'], ['--archive'], ['--archive='], ['--port', '--no-start']]) {
    await assert.rejects(
      execFileAsync('bash', [installScript, ...args]),
      (err: any) => {
        assert.match(String(err.stderr ?? ''), /Unknown argument|requires a/i);
        return true;
      },
    );
  }
});

test('non-interactive downloads use bounded retries and stable silent output', async () => {
  const tmp = await mktmp('curl-policy');
  try {
    const marker = join(tmp, 'curl-args');
    const harness = join(tmp, 'harness.sh');
    await writeFile(harness, [
      '#!/usr/bin/env bash',
      'set -eu',
      `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
      `curl() { printf '%s\n' "$@" > "${marker}"; }`,
      `curl_download "${join(tmp, 'out')}" "https://example.test/archive.tar.gz"`,
    ].join('\n'));
    await execFileAsync('bash', [harness]);
    const args = await readFile(marker, 'utf8');
    assert.match(args, /^--silent$/m);
    assert.match(args, /^--show-error$/m);
    assert.match(args, /^--retry$/m);
    assert.match(args, /^--connect-timeout$/m);
    assert.match(args, /^--speed-time$/m);
    assert.doesNotMatch(args, /progress-bar/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tar safety — path traversal
// ---------------------------------------------------------------------------
test('rejects an archive containing a ".." path traversal entry', async () => {
  const tmp = await mktmp('traversal');
  try {
    await writeFile(join(tmp, 'evil.txt'), 'evil');
    const archive = join(tmp, 'traversal.tar.gz');
    // `-s ,pattern,replacement,` is understood by both bsdtar (macOS) and GNU
    // tar (`-s` is a short alias for `--transform`) — renames the entry path
    // to escape the archive root without needing a crafted tar file by hand.
    await execFileAsync('tar', ['-czf', archive, '-s', ',evil.txt,../evil.txt,', '-C', tmp, 'evil.txt']);
    const digest = sha256(await readFile(archive));

    await assert.rejects(
      execFileAsync('bash', [installScript, '--archive', archive, '--sha256', digest, '--no-start']),
      (err: any) => {
        assert.match(String(err.stderr ?? ''), /\.\.|traversal/i);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tar safety — more than one top-level directory
// ---------------------------------------------------------------------------
test('rejects an archive with more than one top-level directory', async () => {
  const tmp = await mktmp('multiroot');
  try {
    await mkdir(join(tmp, 'dirA'));
    await mkdir(join(tmp, 'dirB'));
    await writeFile(join(tmp, 'dirA', 'f'), 'a');
    await writeFile(join(tmp, 'dirB', 'f'), 'b');
    const archive = join(tmp, 'multiroot.tar.gz');
    await execFileAsync('tar', ['-czf', archive, '-C', tmp, 'dirA', 'dirB']);
    const digest = sha256(await readFile(archive));

    await assert.rejects(
      execFileAsync('bash', [installScript, '--archive', archive, '--sha256', digest, '--no-start']),
      (err: any) => {
        assert.match(String(err.stderr ?? ''), /exactly one top-level directory/i);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Checksum mismatch — must fail BEFORE extraction
// ---------------------------------------------------------------------------
test('rejects an archive whose sha256 does not match --sha256', async () => {
  const tmp = await mktmp('checksum');
  try {
    const stageName = 'open-design-runtime-9.9.9-linux-x64';
    const stageDir = join(tmp, stageName);
    await writeMinimalRelease(stageDir, '9.9.9');
    const { archive } = await packRelease(tmp, stageName);

    await assert.rejects(
      execFileAsync('bash', [installScript, '--archive', archive, '--sha256', 'not-a-real-checksum', '--no-start']),
      (err: any) => {
        assert.match(String(err.stderr ?? ''), /checksum mismatch/i);
        return true;
      },
    );

    // Nothing should have been extracted — the release dir must not exist.
    const releasesDir = join(process.env.HOME ?? '', '.open-design', 'releases', '9.9.9');
    const exists = await stat(releasesDir).then(() => true, () => false);
    assert.equal(exists, false, 'a bad-checksum archive must never be extracted');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rejects a staged release missing the daemon entry before promotion', async () => {
  const tmp = await mktmp('missing-daemon');
  const fakeHome = join(tmp, 'home');
  try {
    await mkdir(fakeHome, { recursive: true });
    const stageName = 'open-design-runtime-7.7.7-linux-x64';
    const stageDir = join(tmp, stageName);
    await mkdir(join(stageDir, 'runtime', 'service'), { recursive: true });
    await writeFile(join(stageDir, 'VERSION'), '7.7.7\n');
    await writeFile(join(stageDir, 'runtime', 'service', 'open-design.service.in'), 'stub\n');
    const packed = await packRelease(tmp, stageName);

    await assert.rejects(
      execFileAsync('bash', [installScript, '--archive', packed.archive, '--sha256', packed.sha256, '--no-start'], {
        env: { ...process.env, HOME: fakeHome },
      }),
      (err: any) => {
        assert.match(String(err.stderr ?? ''), /missing apps\/daemon\/dist\/cli\.js/i);
        return true;
      },
    );
    const promoted = await stat(join(fakeHome, '.open-design', 'releases', '7.7.7')).then(() => true, () => false);
    assert.equal(promoted, false, 'an invalid staged release must not be promoted');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rejects a staged release missing install.sh needed for the next self-update', async () => {
  const tmp = await mktmp('missing-updater');
  const fakeHome = join(tmp, 'home');
  try {
    await mkdir(fakeHome, { recursive: true });
    const stageName = 'open-design-runtime-7.7.8-linux-x64';
    const stageDir = join(tmp, stageName);
    await writeMinimalRelease(stageDir, '7.7.8');
    await rm(join(stageDir, 'install.sh'));
    const packed = await packRelease(tmp, stageName);

    await assert.rejects(
      execFileAsync('bash', [installScript, '--archive', packed.archive, '--sha256', packed.sha256, '--no-start'], {
        env: { ...process.env, HOME: fakeHome },
      }),
      (err: any) => {
        assert.match(String(err.stderr ?? ''), /missing install\.sh required for the next self-update/i);
        return true;
      },
    );
    const promoted = await stat(join(fakeHome, '.open-design', 'releases', '7.7.8')).then(() => true, () => false);
    assert.equal(promoted, false, 'a release without its updater must not be promoted');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Platform detection — clear error for an unsupported uname
// ---------------------------------------------------------------------------
test('fails with a clear error for an unsupported platform (mocked uname)', async () => {
  const tmp = await mktmp('platform');
  try {
    // A fake `uname` ahead of the real one on PATH — reports an OS install.sh
    // does not support, so detect_platform's error path runs deterministically
    // regardless of which real OS this test happens to run on.
    const fakeBin = join(tmp, 'bin');
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, 'uname'),
      '#!/bin/sh\ncase "$1" in -s) echo SunOS ;; -m) echo sparc ;; esac\n',
    );
    await chmod(join(fakeBin, 'uname'), 0o755);

    const dummyArchive = join(tmp, 'dummy.tar.gz');
    await writeFile(dummyArchive, 'not a real tarball');

    await assert.rejects(
      execFileAsync('bash', [installScript, '--archive', dummyArchive, '--no-start'], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      }),
      (err: any) => {
        assert.match(String(err.stderr ?? ''), /Unsupported OS/i);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Happy path (--no-start): extraction, config.env content + chmod 600,
// `current` symlink. Never calls start_service (--no-start short-circuits
// step5 entirely), so this never touches launchd/systemd.
// ---------------------------------------------------------------------------
test('fresh install (--no-start) writes config.env (chmod 600) and the current symlink', async () => {
  const tmp = await mktmp('fresh');
  const fakeHome = join(tmp, 'home');
  try {
    await mkdir(fakeHome, { recursive: true });
    const stageName = 'open-design-runtime-1.2.3-linux-x64';
    const stageDir = join(tmp, stageName);
    await writeMinimalRelease(stageDir, '1.2.3');
    const { archive, sha256: digest } = await packRelease(tmp, stageName);

    await execFileAsync(
      'bash',
      [
        installScript,
        '--archive', archive,
        '--sha256', digest,
        '--no-start',
        '--port', '19999',
        '--data-dir', join(fakeHome, 'data'),
        '--media-url', 'https://media.internal.example/',
        '--media-app-id', 'test-app-not-a-real-secret',
        '--identity-url', 'https://identity.internal.example/',
      ],
      { env: { ...process.env, HOME: fakeHome } },
    );

    const odHome = join(fakeHome, '.open-design');

    // Extracted release + `current` symlink.
    const versionFile = await readFile(join(odHome, 'releases', '1.2.3', 'VERSION'), 'utf8');
    assert.equal(versionFile.trim(), '1.2.3');
    const { stdout: linkTarget } = await execFileAsync('readlink', [join(odHome, 'current')]);
    assert.equal(linkTarget.trim(), join(odHome, 'releases', '1.2.3'));

    // config.env content + permissions.
    const configPath = join(odHome, 'config.env');
    const config = await readFile(configPath, 'utf8');
    assert.match(config, /^OD_SANDBOX=0$/m);
    assert.match(config, /^OD_WRITE_ISOLATION=required$/m);
    assert.match(config, /^OD_PORT=19999$/m);
    assert.match(config, new RegExp(`^OD_DATA_DIR=${join(fakeHome, 'data')}$`, 'm'));
    assert.match(config, /^MEDIA_URL=https:\/\/media\.internal\.example\/$/m);
    assert.match(config, /^MEDIA_APP_ID=test-app-not-a-real-secret$/m);
    assert.match(config, /^IDENTITY_URL=https:\/\/identity\.internal\.example\/$/m);
    // Regression: without this, apps/daemon/src/server.ts's SKILLS_DIR (and
    // every other bundled resource tree) silently falls back to a path that
    // doesn't exist in the host-runtime layout — GET /api/skills returns []
    // and no pipeline workflow can run. Written through the STABLE `current`
    // symlink (not `releases/<version>`) so it keeps resolving across
    // `--update` without needing config.env rewritten every release.
    assert.match(config, new RegExp(`^OD_RESOURCE_ROOT=${join(odHome, 'current', 'resources', 'open-design')}$`, 'm'));

    const mode = (await stat(configPath)).mode & 0o777;
    assert.equal(mode, 0o600, `config.env must be chmod 600, got ${mode.toString(8)}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('--env-file defaults are overridden by explicit flags', async () => {
  const tmp = await mktmp('envfile');
  const fakeHome = join(tmp, 'home');
  try {
    await mkdir(fakeHome, { recursive: true });
    const stageName = 'open-design-runtime-1.2.4-linux-x64';
    const stageDir = join(tmp, stageName);
    await writeMinimalRelease(stageDir, '1.2.4');
    const { archive, sha256: digest } = await packRelease(tmp, stageName);

    const envFile = join(tmp, 'mirror.env');
    await writeFile(envFile, 'CONFLUENCE_URL=https://wiki.example.test\nMEDIA_URL=https://media-from-env-file.example/\nIDENTITY_URL=https://identity-from-env-file.example/\n');

    await execFileAsync(
      'bash',
      [
        installScript,
        '--archive', archive,
        '--sha256', digest,
        '--no-start',
        '--env-file', envFile,
        '--media-url', 'https://from-flag.example/', // flag must win over env-file
      ],
      { env: { ...process.env, HOME: fakeHome } },
    );

    const config = await readFile(join(fakeHome, '.open-design', 'config.env'), 'utf8');
    assert.match(config, /^CONFLUENCE_URL=https:\/\/wiki\.example\.test$/m);
    assert.match(config, /^MEDIA_URL=https:\/\/from-flag\.example\/$/m);
    assert.match(config, /^IDENTITY_URL=https:\/\/identity-from-env-file\.example\/$/m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// Google login (--google-client-id/--google-client-secret/--session-secret)
// mirrors MEDIA_*/IDENTITY_URL exactly: written to config.env (chmod 600)
// only when given, omitted entirely otherwise — /api/auth/google's own
// isAuthEnabled() gate is what turns login on, config.env just carries the
// three values through.
test('writes Google login vars to config.env when all three flags are given', async () => {
  const tmp = await mktmp('google-login');
  const fakeHome = join(tmp, 'home');
  try {
    await mkdir(fakeHome, { recursive: true });
    const stageName = 'open-design-runtime-1.2.5-linux-x64';
    const stageDir = join(tmp, stageName);
    await writeMinimalRelease(stageDir, '1.2.5');
    const { archive, sha256: digest } = await packRelease(tmp, stageName);

    await execFileAsync(
      'bash',
      [
        installScript,
        '--archive', archive,
        '--sha256', digest,
        '--no-start',
        '--google-client-id', 'test-client-id-not-a-real-secret',
        '--google-client-secret', 'test-client-secret-not-a-real-secret',
        '--session-secret', 'test-session-secret-not-a-real-secret',
      ],
      { env: { ...process.env, HOME: fakeHome } },
    );

    const configPath = join(fakeHome, '.open-design', 'config.env');
    const config = await readFile(configPath, 'utf8');
    assert.match(config, /^GOOGLE_CLIENT_ID=test-client-id-not-a-real-secret$/m);
    assert.match(config, /^GOOGLE_CLIENT_SECRET=test-client-secret-not-a-real-secret$/m);
    assert.match(config, /^SESSION_SECRET=test-session-secret-not-a-real-secret$/m);
    const mode = (await stat(configPath)).mode & 0o777;
    assert.equal(mode, 0o600, `config.env must be chmod 600, got ${mode.toString(8)}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('omits Google login vars from config.env when the flags are absent', async () => {
  const tmp = await mktmp('google-login-absent');
  const fakeHome = join(tmp, 'home');
  try {
    await mkdir(fakeHome, { recursive: true });
    const stageName = 'open-design-runtime-1.2.6-linux-x64';
    const stageDir = join(tmp, stageName);
    await writeMinimalRelease(stageDir, '1.2.6');
    const { archive, sha256: digest } = await packRelease(tmp, stageName);

    await execFileAsync(
      'bash',
      [installScript, '--archive', archive, '--sha256', digest, '--no-start'],
      { env: { ...process.env, HOME: fakeHome } },
    );

    const config = await readFile(join(fakeHome, '.open-design', 'config.env'), 'utf8');
    assert.doesNotMatch(config, /^GOOGLE_CLIENT_ID=/m);
    assert.doesNotMatch(config, /^GOOGLE_CLIENT_SECRET=/m);
    assert.doesNotMatch(config, /^SESSION_SECRET=/m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rollback on a mocked health failure — sources install.sh
// (OD_INSTALL_SH_TEST_SOURCE=1) and stubs start_service/write_service_files/
// wait_for_health so this NEVER touches a real launchd/systemd session.
// ---------------------------------------------------------------------------
test('rollback() restores the previous `current` symlink when health checks fail', async () => {
  const tmp = await mktmp('rollback');
  const fakeHome = join(tmp, 'home');
  try {
    const odHome = join(fakeHome, '.open-design');
    await mkdir(join(odHome, 'releases', '1.0.0'), { recursive: true });
    await mkdir(join(odHome, 'releases', '2.0.0'), { recursive: true });
    await mkdir(join(odHome, 'logs'), { recursive: true });
    // `current` starts pointed at the previously-good 1.0.0 release.
    await execFileAsync('ln', ['-sfn', join(odHome, 'releases', '1.0.0'), join(odHome, 'current')]);

    const harness = join(tmp, 'rollback-harness.sh');
    await writeFile(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
        // Stub every side-effecting call rollback() makes — this is the only
        // thing standing between this test and a real launchctl/systemctl call.
        'write_service_files() { :; }',
        'start_service() { :; }',
        'stop_service() { :; }',
        'wait_for_health() { return 1; }', // rollback attempt also "fails" health — exercises the worse-case branch too
        `PREV_CURRENT="${join(odHome, 'releases', '1.0.0')}"`,
        `RELEASE_DIR="${join(odHome, 'releases', '2.0.0')}"`,
        'VERSION=2.0.0',
        'PORT=19998',
        // Simulate step3 already having swapped `current` to the new (bad) release.
        `ln -sfn "$RELEASE_DIR" "${odHome}/current"`,
        'rollback || true', // rollback() always exit 1 by design — swallow it, we only assert on-disk state
      ].join('\n'),
    );
    await chmod(harness, 0o755);

    const { code } = await execFileAsync('bash', [harness], {
      env: { ...process.env, HOME: fakeHome },
    }).then(
      () => ({ code: 0 }),
      (err: any) => ({ code: err.code as number }),
    );
    assert.equal(code, 1, 'rollback() must exit non-zero so the caller treats the install as failed');

    const { stdout: linkTarget } = await execFileAsync('readlink', [join(odHome, 'current')]);
    assert.equal(
      linkTarget.trim(),
      join(odHome, 'releases', '1.0.0'),
      'rollback() must restore `current` to the previous release',
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rollback() atomically restores the previous config.env backup', async () => {
  const tmp = await mktmp('rollback-config');
  const fakeHome = join(tmp, 'home');
  try {
    const odHome = join(fakeHome, '.open-design');
    const oldRelease = join(odHome, 'releases', '1.0.0');
    const newRelease = join(odHome, 'releases', '2.0.0');
    await mkdir(oldRelease, { recursive: true });
    await mkdir(newRelease, { recursive: true });
    await mkdir(join(odHome, 'logs'), { recursive: true });
    await execFileAsync('ln', ['-sfn', newRelease, join(odHome, 'current')]);
    await writeFile(join(odHome, 'config.env'), 'OD_APP_VERSION=2.0.0\nOD_PORT=19995\n');
    const backup = join(odHome, '.config.env.backup.test');
    await writeFile(backup, 'OD_APP_VERSION=1.0.0\nOD_PORT=19995\n');

    const harness = join(tmp, 'rollback-config-harness.sh');
    await writeFile(harness, [
      '#!/usr/bin/env bash',
      'set -eu',
      `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
      'write_service_files() { :; }',
      'start_service() { :; }',
      'stop_service() { :; }',
      'wait_for_health() { return 0; }',
      `PREV_CURRENT="${oldRelease}"`,
      `RELEASE_DIR="${newRelease}"`,
      `CONFIG_BACKUP="${backup}"`,
      'CONFIG_HAD_PREVIOUS=1',
      'CONFIG_WRITTEN=1',
      'ACTIVATED=1',
      'VERSION=2.0.0',
      'PORT=19995',
      'rollback',
    ].join('\n'));
    await execFileAsync('bash', [harness], { env: { ...process.env, HOME: fakeHome } }).catch(() => {});

    assert.equal(await readFile(join(odHome, 'config.env'), 'utf8'), 'OD_APP_VERSION=1.0.0\nOD_PORT=19995\n');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('TERM after activation exits 143 and rolls back release plus config', async () => {
  const tmp = await mktmp('term-rollback');
  const fakeHome = join(tmp, 'home');
  try {
    const odHome = join(fakeHome, '.open-design');
    const oldRelease = join(odHome, 'releases', '1.0.0');
    const newRelease = join(odHome, 'releases', '2.0.0');
    await mkdir(oldRelease, { recursive: true });
    await mkdir(newRelease, { recursive: true });
    await mkdir(join(odHome, 'logs'), { recursive: true });
    await execFileAsync('ln', ['-sfn', newRelease, join(odHome, 'current')]);
    await writeFile(join(odHome, 'config.env'), 'OD_APP_VERSION=2.0.0\n');
    const backup = join(odHome, '.config.env.backup.term-test');
    await writeFile(backup, 'OD_APP_VERSION=1.0.0\n');

    const harness = join(tmp, 'term-harness.sh');
    await writeFile(harness, [
      '#!/usr/bin/env bash',
      'set -eu',
      `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
      'write_service_files() { :; }',
      'start_service() { :; }',
      'stop_service() { :; }',
      'wait_for_health() { return 0; }',
      `PREV_CURRENT="${oldRelease}"`,
      `RELEASE_DIR="${newRelease}"`,
      `CONFIG_BACKUP="${backup}"`,
      'CONFIG_HAD_PREVIOUS=1',
      'CONFIG_WRITTEN=1',
      'ACTIVATED=1',
      'VERSION=2.0.0',
      'PORT=19994',
      'trap handle_exit EXIT',
      'trap handle_int INT',
      'trap handle_term TERM',
      'kill -TERM $$',
    ].join('\n'));
    const result = await execFileAsync('bash', [harness], { env: { ...process.env, HOME: fakeHome } }).then(
      () => ({ code: 0 }),
      (err: any) => ({ code: err.code as number }),
    );
    assert.equal(result.code, 143);
    const { stdout: target } = await execFileAsync('readlink', [join(odHome, 'current')]);
    assert.equal(target.trim(), oldRelease);
    assert.equal(await readFile(join(odHome, 'config.env'), 'utf8'), 'OD_APP_VERSION=1.0.0\n');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rollback() with no previous release stops the service and still fails loudly', async () => {
  const tmp = await mktmp('rollback-fresh');
  const fakeHome = join(tmp, 'home');
  try {
    const odHome = join(fakeHome, '.open-design');
    await mkdir(join(odHome, 'releases', '1.0.0'), { recursive: true });
    await mkdir(join(odHome, 'logs'), { recursive: true });
    await execFileAsync('ln', ['-sfn', join(odHome, 'releases', '1.0.0'), join(odHome, 'current')]);

    const harness = join(tmp, 'rollback-harness.sh');
    let stopServiceCalled = false;
    const marker = join(tmp, 'stop-service-called');
    await writeFile(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
        'write_service_files() { :; }',
        'start_service() { :; }',
        `stop_service() { touch "${marker}"; }`,
        'wait_for_health() { return 1; }',
        'PREV_CURRENT=""', // no previous release — first-ever install failed
        `RELEASE_DIR="${join(odHome, 'releases', '1.0.0')}"`,
        'VERSION=1.0.0',
        'PORT=19997',
        'rollback || true',
      ].join('\n'),
    );
    await chmod(harness, 0o755);

    await execFileAsync('bash', [harness], { env: { ...process.env, HOME: fakeHome } }).catch(() => {});
    stopServiceCalled = await stat(marker).then(() => true, () => false);
    assert.equal(stopServiceCalled, true, 'rollback() must stop the service when there is nothing to roll back to');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --update over an install with unset optional keys (MEDIA_URL/MEDIA_APP_ID/
// MEDIA_USER_ID/MEDIA_USER_ROLE/IDENTITY_URL) — the common case for any
// install without KG sync enabled. Regression: existing_config_value() ran
// `grep ... | tail -1 | cut ...` with no `|| true`; under this script's
// `set -eu -o pipefail`, grep finding no match for one of those keys in the
// pre-existing config.env exits 1, which — via resolve_cfg()'s unguarded
// final command and the bare `media_url="$(resolve_cfg ...)"` assignment —
// killed the ENTIRE script silently (no error, no rollback, exit 0 under a
// naive caller) right after step 3's extraction, before the `current`
// symlink was ever repointed to the new release or the service restarted.
// Never caught before because every prior --update-adjacent test either
// never reached an --update at all, or (the fresh-install test) populated
// every optional key so existing_config_value() was never asked about a
// genuinely-missing one.
// ---------------------------------------------------------------------------
test('--update succeeds when the existing config.env has no MEDIA_*/IDENTITY_URL set', async () => {
  const tmp = await mktmp('update-partial-config');
  const fakeHome = join(tmp, 'home');
  try {
    await mkdir(fakeHome, { recursive: true });

    const v1Name = 'open-design-runtime-1.0.0-linux-x64';
    await writeMinimalRelease(join(tmp, v1Name), '1.0.0');
    const v1 = await packRelease(tmp, v1Name);
    await execFileAsync(
      'bash',
      [installScript, '--archive', v1.archive, '--sha256', v1.sha256, '--no-start', '--port', '19996'],
      { env: { ...process.env, HOME: fakeHome } },
    );

    const odHome = join(fakeHome, '.open-design');
    const configBefore = await readFile(join(odHome, 'config.env'), 'utf8');
    assert.doesNotMatch(configBefore, /^MEDIA_URL=/m, 'fixture must start with no MEDIA_URL configured');
    assert.doesNotMatch(configBefore, /^IDENTITY_URL=/m, 'fixture must start with no IDENTITY_URL configured');

    const v2Name = 'open-design-runtime-1.1.0-linux-x64';
    await writeMinimalRelease(join(tmp, v2Name), '1.1.0');
    const v2 = await packRelease(tmp, v2Name);
    await execFileAsync(
      'bash',
      [installScript, '--archive', v2.archive, '--sha256', v2.sha256, '--no-start', '--update'],
      { env: { ...process.env, HOME: fakeHome } },
    );

    const { stdout: linkTarget } = await execFileAsync('readlink', [join(odHome, 'current')]);
    assert.equal(
      linkTarget.trim(),
      join(odHome, 'releases', '1.1.0'),
      '--update must repoint `current` to the new release, not silently stop after extraction',
    );
    const configAfter = await readFile(join(odHome, 'config.env'), 'utf8');
    assert.match(configAfter, /^OD_PORT=19996$/m, '--update must preserve the previously-configured port');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('--update of the active same version activates new bytes through a distinct immutable directory', async () => {
  const tmp = await mktmp('same-version-active');
  const fakeHome = join(tmp, 'home');
  try {
    await mkdir(fakeHome, { recursive: true });
    const stageName = 'open-design-runtime-3.0.0-linux-x64';
    const firstTree = join(tmp, stageName);
    await writeMinimalRelease(firstTree, '3.0.0');
    const first = await packRelease(tmp, stageName);
    await execFileAsync('bash', [installScript, '--archive', first.archive, '--sha256', first.sha256, '--no-start'], {
      env: { ...process.env, HOME: fakeHome },
    });

    const activeRelease = join(fakeHome, '.open-design', 'releases', '3.0.0');
    await writeFile(join(activeRelease, 'active-marker'), 'must-survive\n');

    const secondRoot = join(tmp, 'second');
    const secondTree = join(secondRoot, stageName);
    await writeMinimalRelease(secondTree, '3.0.0');
    await writeFile(join(secondTree, 'archive-marker'), 'new-archive\n');
    const second = await packRelease(secondRoot, stageName);
    await execFileAsync(
      'bash',
      [installScript, '--archive', second.archive, '--sha256', second.sha256, '--no-start', '--update'],
      { env: { ...process.env, HOME: fakeHome } },
    );

    const { stdout: newTargetOutput } = await execFileAsync('readlink', [join(fakeHome, '.open-design', 'current')]);
    const newTarget = newTargetOutput.trim();
    assert.notEqual(newTarget, activeRelease, 'same-version update must switch current to a distinct release target');
    assert.match(newTarget, /releases\/3\.0\.0-[a-f0-9]{12}-[0-9]+(?:-[0-9]+)?$/);
    assert.equal(await readFile(join(newTarget, 'archive-marker'), 'utf8'), 'new-archive\n');
    assert.equal(await readFile(join(activeRelease, 'active-marker'), 'utf8'), 'must-survive\n');
    const newMarkerInOldTarget = await stat(join(activeRelease, 'archive-marker')).then(() => true, () => false);
    assert.equal(newMarkerInOldTarget, false, 'the previously-active directory must remain untouched');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --update requires an existing install
// ---------------------------------------------------------------------------
test('--update fails fast when there is no existing install', async () => {
  const tmp = await mktmp('update-no-install');
  const fakeHome = join(tmp, 'home');
  try {
    await mkdir(fakeHome, { recursive: true });
    await assert.rejects(
      execFileAsync('bash', [installScript, '--update'], { env: { ...process.env, HOME: fakeHome } }),
      (err: any) => {
        assert.match(String(err.stderr ?? ''), /no existing install/i);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Network preflight (preflight_check) -- sourced + stubbed, so these never
// touch a real network. preflight_probe itself is stubbed per-test via a
// marker-file trick: it's the only function that would otherwise make a real
// curl call, so overriding it also proves (or disproves) whether a given
// domain was probed at all, not just what preflight_check printed.
// ---------------------------------------------------------------------------
test('preflight_check skips every probe when archive is local, Node satisfies, and claude/codex are on PATH', async () => {
  const tmp = await mktmp('preflight-skip');
  const fakeHome = join(tmp, 'home');
  const probedMarker = join(tmp, 'probed');
  try {
    const harness = join(tmp, 'harness.sh');
    await writeFile(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
        // Any call proves a probe that should have been skipped ran.
        `preflight_probe() { echo "probed:$1" >> "${probedMarker}"; return 0; }`,
        'node_satisfies_engine() { return 0; }',
        'command() { if [ "$1" = "-v" ] && { [ "$2" = "claude" ] || [ "$2" = "codex" ]; }; then echo "/fake/$2"; return 0; fi; builtin command "$@"; }',
        'OPT_ARCHIVE="/tmp/fake.tar.gz"',
        'OPT_RELEASE_URL=""',
        'OPT_UPDATE="0"',
        'preflight_check',
      ].join('\n'),
    );
    await chmod(harness, 0o755);

    const { stdout } = await execFileAsync('bash', [harness], { env: { ...process.env, HOME: fakeHome } });
    assert.match(stdout, /Kiểm tra kết nối mạng/);
    const probed = await readFile(probedMarker, 'utf8').catch(() => '');
    assert.equal(probed, '', 'no domain should have been probed when nothing in this run needs one');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('preflight_check fails fast when github.com/the asset CDN are unreachable', async () => {
  const tmp = await mktmp('preflight-required-down');
  const fakeHome = join(tmp, 'home');
  try {
    const harness = join(tmp, 'harness.sh');
    await writeFile(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
        'preflight_probe() { return 1; }', // every domain "unreachable"
        'node_satisfies_engine() { return 0; }',
        'OPT_ARCHIVE=""',
        'OPT_RELEASE_URL=""',
        'OPT_UPDATE="0"',
        'preflight_check',
      ].join('\n'),
    );
    await chmod(harness, 0o755);

    await assert.rejects(
      execFileAsync('bash', [harness], { env: { ...process.env, HOME: fakeHome } }),
      (err: any) => {
        assert.match(String(err.stderr ?? ''), /github\.com/);
        assert.match(String(err.stderr ?? ''), /release-assets\.githubusercontent\.com/);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('preflight_check warns but does not fail when only an optional domain (claude.ai) is unreachable', async () => {
  const tmp = await mktmp('preflight-optional-down');
  const fakeHome = join(tmp, 'home');
  try {
    const harness = join(tmp, 'harness.sh');
    await writeFile(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
        'preflight_probe() { [ "$1" = "https://claude.ai" ] && return 1; return 0; }',
        'node_satisfies_engine() { return 0; }',
        // Force claude "not found" (even if the real binary happens to be on
        // this machine's PATH) and codex "found", regardless of real PATH state.
        'command() { if [ "$1" = "-v" ] && [ "$2" = "claude" ]; then return 1; fi; if [ "$1" = "-v" ] && [ "$2" = "codex" ]; then echo "/fake/codex"; return 0; fi; builtin command "$@"; }',
        'OPT_ARCHIVE=""',
        'OPT_RELEASE_URL=""',
        'OPT_UPDATE="0"',
        'preflight_check',
        'echo DID_NOT_EXIT',
      ].join('\n'),
    );
    await chmod(harness, 0o755);

    // warn() prints to stderr (see install.sh's warn() definition) --
    // ok()/the phase header go to stdout.
    const { stdout, stderr } = await execFileAsync('bash', [harness], { env: { ...process.env, HOME: fakeHome } });
    assert.match(stderr, /claude\.ai/);
    assert.match(stdout, /DID_NOT_EXIT/, 'an optional domain being down must not abort the run');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// remove_existing_installation (2026-08-18: Install = clean install). Sourced
// with launchctl/systemctl stubbed; a fake ~/.open-design with a "running"
// pid must be wiped (daemon killed, plist removed, OD_HOME recreated empty)
// while the data dir outside OD_HOME is untouched. Skipped on --update by
// main(), which is asserted separately below.
// ---------------------------------------------------------------------------
test('remove_existing_installation wipes OD_HOME + service files, kills the daemon, keeps data, no-ops when nothing is installed', async () => {
  const tmp = await mktmp('remove-existing');
  const odHome = join(tmp, 'home', '.open-design');
  const dataDir = join(tmp, 'od-data');
  const plist = join(tmp, 'plist');
  const callsLog = join(tmp, 'calls.log');
  try {
    await mkdir(join(odHome, 'releases', '0.8.40'), { recursive: true });
    await writeFile(join(odHome, 'releases', '0.8.40', 'VERSION'), '0.8.40\n');
    await symlink(join(odHome, 'releases', '0.8.40'), join(odHome, 'current'));
    await writeFile(join(odHome, 'config.env'), `OD_DATA_DIR=${dataDir}\n`);
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'keep.txt'), 'kept');
    await writeFile(plist, 'fake plist');

    const harness = join(tmp, 'harness.sh');
    await writeFile(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
        `OD_HOME="${odHome}"`,
        `DARWIN_PLIST_PATH="${plist}"`,
        `LINUX_UNIT_PATH="${join(tmp, 'unit')}"`,
        `launchctl() { echo "launchctl $*" >> "${callsLog}"; }`,
        `systemctl() { echo "systemctl $*" >> "${callsLog}"; }`,
        // A real background sleeper stands in for the daemon.
        'sleep 300 & echo $! > "$OD_HOME/open-design.pid"',
        'DAEMON_PID=$(cat "$OD_HOME/open-design.pid")',
        'remove_existing_installation',
        'sleep 0.3',
        'if kill -0 "$DAEMON_PID" 2>/dev/null; then echo "daemon-still-alive"; kill "$DAEMON_PID" || true; fi',
        // Second call on the now-empty OD_HOME must be a silent no-op.
        'remove_existing_installation && echo "second-call-ok"',
      ].join('\n'),
    );
    await chmod(harness, 0o755);

    const { stdout } = await execFileAsync('bash', [harness], { env: { ...process.env, HOME: join(tmp, 'home') } });
    assert.match(stdout, /Gỡ bản cũ/);
    assert.match(stdout, /existing Open Design 0\.8\.40/);
    assert.match(stdout, /Previous installation removed \(0\.8\.40\)/);
    assert.doesNotMatch(stdout, /daemon-still-alive/);
    assert.match(stdout, /second-call-ok/);
    assert.equal((await readdir(odHome)).length, 0, 'OD_HOME must be recreated empty');
    assert.equal(await readFile(join(dataDir, 'keep.txt'), 'utf8'), 'kept', 'project data outside OD_HOME must survive');
    if (process.platform === 'darwin') {
      assert.equal(existsSync(plist), false, 'launchd plist must be removed');
      assert.match(await readFile(callsLog, 'utf8'), /launchctl bootout/);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('main() runs remove_existing_installation only for fresh installs, right after step 1', async () => {
  const sh = await readFile(installScript, 'utf8');
  const main = sh.slice(sh.indexOf('main() {'));
  assert.match(main, /step1_verify_package\n\s+\[ "\$OPT_UPDATE" = "1" \] \|\| remove_existing_installation\n\s+step2_ensure_node/);
});

// ---------------------------------------------------------------------------
// remove_old_releases (2026-08-18): after a HEALTHY update only the release
// `current` points at may remain; everything else under releases/ goes,
// tools/ and data stay. Wired into finalize_transaction.
// ---------------------------------------------------------------------------
test('remove_old_releases keeps only the current release (and nothing outside releases/)', async () => {
  const tmp = await mktmp('remove-old-releases');
  const odHome = join(tmp, '.open-design');
  try {
    for (const v of ['0.8.40', '0.8.43', '0.8.44']) {
      await mkdir(join(odHome, 'releases', v), { recursive: true });
      await writeFile(join(odHome, 'releases', v, 'VERSION'), `${v}\n`);
    }
    await mkdir(join(odHome, 'releases', '.0.8.44.replaced.123'), { recursive: true });
    await symlink(join(odHome, 'releases', '0.8.44'), join(odHome, 'current'));
    await mkdir(join(odHome, 'tools', 'node'), { recursive: true });
    await writeFile(join(odHome, 'tools', 'node', 'bin'), 'x');

    const harness = join(tmp, 'harness.sh');
    await writeFile(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
        `OD_HOME="${odHome}"`,
        'remove_old_releases',
        // Idempotent: second run finds nothing to remove and prints nothing.
        'remove_old_releases',
      ].join('\n'),
    );
    await chmod(harness, 0o755);
    const { stdout } = await execFileAsync('bash', [harness]);
    assert.match(stdout, /Removed 3 old release\(s\); only 0\.8\.44 remains/);
    assert.equal((stdout.match(/Removed \d+ old release/g) ?? []).length, 1);
    assert.deepEqual((await readdir(join(odHome, 'releases'))).sort(), ['0.8.44']);
    assert.equal(existsSync(join(odHome, 'tools', 'node', 'bin')), true, 'tools/ must be untouched');
    assert.equal(await readFile(join(odHome, 'current', 'VERSION'), 'utf8'), '0.8.44\n');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('step 5 prunes old releases only after a confirmed healthy start (not on --no-start, never in rollback)', async () => {
  const sh = await readFile(installScript, 'utf8');
  const step5 = sh.slice(sh.indexOf('step5_start_and_health_check() {'), sh.indexOf('# Step 6/6'));
  assert.match(step5, /ok "Daemon is healthy on port \$\{PORT\}"\s+finalize_transaction\s+(#[^\n]*\n\s+)*remove_old_releases/);
  const noStart = step5.slice(0, step5.indexOf('start_service'));
  assert.doesNotMatch(noStart, /remove_old_releases/);
  const rollback = sh.slice(sh.indexOf('rollback() {'), sh.indexOf('finalize_transaction() {'));
  assert.doesNotMatch(rollback, /remove_old_releases/);
});

// 2026-08-18: mirror support (OD_RELEASE_URL). See the matching Windows test
// in host-install-windows.test.ts for the why (TLS-inspecting corporate proxy
// throttling github.com downloads).
test('resolve_release_url: flag > OD_RELEASE_URL env > config.env > GitHub; only a base URL is treated as a mirror', async () => {
  const tmp = await mktmp('release-url');
  const fakeHome = join(tmp, 'home');
  await mkdir(join(fakeHome, '.open-design'), { recursive: true });
  try {
    const harness = join(tmp, 'harness.sh');
    await writeFile(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
        'OPT_RELEASE_URL="${FLAG_URL:-}"',
        'resolve_release_url',
        'echo "url=[${OPT_RELEASE_URL}] base=${RELEASE_URL_IS_MIRROR_BASE}"',
      ].join('\n'),
    );
    await chmod(harness, 0o755);
    const run = async (extraEnv: Record<string, string>) => {
      const { stdout } = await execFileAsync('bash', [harness], {
        env: { ...process.env, HOME: fakeHome, OD_RELEASE_URL: '', FLAG_URL: '', ...extraEnv },
      });
      return stdout.trim().split('\n').pop()!;
    };

    // Nothing configured -> GitHub default (empty URL, not a mirror).
    assert.equal(await run({}), 'url=[] base=0');
    // Env base URL, trailing slash trimmed, flagged as mirror.
    assert.equal(await run({ OD_RELEASE_URL: 'https://mirror.example/od/latest/' }), 'url=[https://mirror.example/od/latest] base=1');
    // Direct tarball URL is used but NOT flagged as a mirror (never persisted).
    assert.equal(
      await run({ OD_RELEASE_URL: 'https://x.y/open-design-runtime-1.0.0-linux-x64.tar.gz' }),
      'url=[https://x.y/open-design-runtime-1.0.0-linux-x64.tar.gz] base=0',
    );
    // Flag wins over env.
    assert.equal(
      await run({ OD_RELEASE_URL: 'https://env.example/x', FLAG_URL: 'https://flag.example/y/' }),
      'url=[https://flag.example/y] base=1',
    );
    // config.env fallback (what a daemon-spawned --update relies on).
    await writeFile(join(fakeHome, '.open-design', 'config.env'), 'OD_PORT=7456\nOD_RELEASE_URL=https://cfg.example/od/latest\n');
    assert.equal(await run({}), 'url=[https://cfg.example/od/latest] base=1');
    // Env still beats config.env.
    assert.equal(await run({ OD_RELEASE_URL: 'https://env.example/z' }), 'url=[https://env.example/z] base=1');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('write_config_env persists OD_RELEASE_URL only for a mirror base URL', async () => {
  const src = await readFile(installScript, 'utf8');
  const block = src.slice(src.indexOf('write_config_env() {'), src.indexOf('mv "$CONFIG_TEMP" "${OD_HOME}/config.env"'));
  assert.match(block, /\[ "\$RELEASE_URL_IS_MIRROR_BASE" = "1" \] && echo "OD_RELEASE_URL=\$\{OPT_RELEASE_URL\}"/);
  // resolve_release_url runs before the preflight so the mirror host is what
  // gets probed instead of github.com.
  const main = src.slice(src.indexOf('preflight_check\n  step1_verify_package') - 40, src.indexOf('preflight_check\n  step1_verify_package'));
  assert.match(main, /resolve_release_url\s*\n\s*$/);
});

test('build-runtime.sh trims documentation weight and hard-links duplicate resource files', async () => {
  const build = await readFile(join(repoRoot, 'scripts/host-runtime/build-runtime.sh'), 'utf8');
  // 0.8.48 measurement: 104 MB compressed, 81 MB of it resources/, the app
  // itself ~19 MB. These prunes took the win32 payload from 99.2 to 63.4 MB.
  assert.match(build, /find "\$\{STAGE_DIR\}\/apps\/web\/out" -type f -name "\*\.map" -delete/);
  assert.match(build, /node_modules\/better-sqlite3\/deps/);
  assert.match(build, /-path "\*\/docs\/readme" -o -path "\*\/scripts\/verify-output"/);
  // Duplicates are hard-linked, never deleted: both paths must exist after
  // extraction (plugins/_official/examples/<x>/assets == design-templates/<x>/assets).
  assert.match(build, /ln -f "\$\{RESOURCE_ROOT\}\/\$\{keep\}" "\$\{RESOURCE_ROOT\}\/\$\{dup\}"/);
  assert.match(build, /-size \+256k/);
  assert.doesNotMatch(build, /rm -rf "\$\{RESOURCE_ROOT\}\/community-pets"/);
});

// Multipart archives ("<platform>.parts"): the Cloudflare Pages mirror caps
// files at 25 MiB, so build-release-manifest.ts --split-mib writes
// <tarball>.partNN and the installers reassemble before the sha256 check.
test('build-release-manifest.ts --split-mib writes .partNN files whose concatenation is the original and records the count as a string', async () => {
  const tmp = await mktmp('manifest-split');
  try {
    const name = 'open-design-runtime-9.9.9-linux-x64.tar.gz';
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 123);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
    await writeFile(join(tmp, name), bytes);
    await writeFile(join(tmp, `${name}.sha256`), `${sha256(bytes)}  ${name}\n`);
    await execFileAsync('node', [
      '--experimental-strip-types', join(repoRoot, 'scripts/host-runtime/build-release-manifest.ts'),
      '--version', '9.9.9', '--tag', 't', '--repo', 'o/r', '--base-url', 'https://m.example/t/', '--split-mib', '2', '--out', 'r.json',
    ], { cwd: tmp });
    const manifest = JSON.parse(await readFile(join(tmp, 'r.json'), 'utf8'));
    assert.equal(manifest['linux-x64.parts'], '3');
    assert.equal(manifest['linux-x64.url'], `https://m.example/t/${name}`);
    const parts = (await readdir(tmp)).filter((f) => f.startsWith(`${name}.part`)).sort();
    assert.deepEqual(parts, [`${name}.part01`, `${name}.part02`, `${name}.part03`]);
    const joined = Buffer.concat(await Promise.all(parts.map((p) => readFile(join(tmp, p)))));
    assert.equal(sha256(joined), sha256(bytes));
    assert.equal((await stat(join(tmp, parts[0]!))).size, 2 * 1024 * 1024);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('download_archive with a part count fetches .partNN in order, concatenates, and removes the parts', async () => {
  const tmp = await mktmp('multipart-dl');
  const fakeHome = join(tmp, 'home');
  const served = join(tmp, 'served');
  await mkdir(served, { recursive: true });
  try {
    const name = 'open-design-runtime-9.9.9-linux-x64.tar.gz';
    const partsData = [Buffer.from('AAAA'), Buffer.from('BBBB'), Buffer.from('CC')];
    await Promise.all(partsData.map((b, i) => writeFile(join(served, `${name}.part0${i + 1}`), b)));
    const harness = join(tmp, 'harness.sh');
    await writeFile(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
        // Stand-in for curl: copy the requested basename from the served dir; log the order.
        `curl_download() { echo "$(basename "$2")" >> "${tmp}/order"; cp "${served}/$(basename "$2")" "$1"; }`,
        `download_archive "https://m.example/t/${name}" "" 3`,
        'cat "$ARCHIVE_PATH"; echo',
        'ls "$(dirname "$ARCHIVE_PATH")"',
      ].join('\n'),
    );
    await chmod(harness, 0o755);
    const { stdout } = await execFileAsync('bash', [harness], { env: { ...process.env, HOME: fakeHome } });
    assert.match(stdout, /Downloading open-design-runtime-9\.9\.9-linux-x64\.tar\.gz \(3 parts\)/);
    assert.match(stdout, /\nAAAABBBBCC\n/);
    assert.equal(stdout.trim().split('\n').pop(), name, 'part files must be removed after assembly');
    assert.equal(await readFile(join(tmp, 'order'), 'utf8'), `${name}.part01\n${name}.part02\n${name}.part03\n`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolve_archive forwards "<platform>.parts" from release.json to download_archive', async () => {
  const src = await readFile(installScript, 'utf8');
  const block = src.slice(src.indexOf('resolve_archive() {'), src.indexOf('# Step 0 — network preflight'));
  assert.match(block, /tarball_parts="\$\(json_flat_value "\$rel_json" "\$\{PLATFORM\}\.parts"\)"/);
  assert.match(block, /download_archive "\$tarball_url" "" "\$\{tarball_parts:-0\}"/);
});

// ---------------------------------------------------------------------------
// --start / --stop — lifecycle commands (the macOS OpenDesign-Start.command /
// OpenDesign-Stop.command entry points, mirroring install.ps1 -Start/-Stop).
// Argument validation and the "nothing installed" refusal run for real; the
// service calls themselves are stubbed through the OD_INSTALL_SH_TEST_SOURCE
// seam, so no test here ever touches a real launchctl/systemctl session.
// ---------------------------------------------------------------------------
test('--start / --stop reject bad combinations and refuse to run with nothing installed', async () => {
  const tmp = await mktmp('lifecycle-args');
  const fakeHome = join(tmp, 'home');
  await mkdir(fakeHome, { recursive: true });
  try {
    // Argument validation runs BEFORE any state check, so --start --update
    // reports the real mistake instead of "no existing install".
    for (const [args, pattern] of [
      [['--start', '--stop'], /mutually exclusive/],
      [['--start', '--update'], /cannot be combined with --update/],
      [['--stop', '--update'], /cannot be combined with --update/],
    ] as [string[], RegExp][]) {
      await assert.rejects(
        execFileAsync('bash', [installScript, ...args], { env: { ...process.env, HOME: fakeHome } }),
        (err: any) => {
          assert.match(String(err.stderr ?? ''), pattern);
          return true;
        },
      );
    }

    // No install at all → a message that names the entry point to run first,
    // not a launchctl error.
    for (const flag of ['--start', '--stop']) {
      await assert.rejects(
        execFileAsync('bash', [installScript, flag], { env: { ...process.env, HOME: fakeHome } }),
        (err: any) => {
          assert.match(String(err.stderr ?? ''), /chưa được cài|OpenDesign-Install\.command/);
          return true;
        },
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('run_start_command starts the installed release on the configured port; run_stop_command stops it', async () => {
  const tmp = await mktmp('lifecycle-run');
  const fakeHome = join(tmp, 'home');
  const odHome = join(fakeHome, '.open-design');
  const log = join(tmp, 'calls.log');
  try {
    // An installed tree: cli.js is what require_existing_install looks for,
    // config.env carries the port, and tools/node-v* is the private Node the
    // nohup path must find when the system Node does not satisfy engines.
    await mkdir(join(odHome, 'current', 'apps', 'daemon', 'dist'), { recursive: true });
    await writeFile(join(odHome, 'current', 'apps', 'daemon', 'dist', 'cli.js'), '// stub\n');
    await writeFile(join(odHome, 'config.env'), 'OD_PORT=19457\nOD_DATA_DIR=/tmp/od\n');
    const privateNode = join(odHome, 'tools', 'node-v24.9.9-darwin-arm64', 'bin');
    await mkdir(privateNode, { recursive: true });
    await writeFile(join(privateNode, 'node'), '#!/bin/sh\nexit 0\n');
    await chmod(join(privateNode, 'node'), 0o755);

    const harness = join(tmp, 'lifecycle-harness.sh');
    await writeFile(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `OD_INSTALL_SH_TEST_SOURCE=1 source "${installScript}"`,
        // Force the private-Node lookup regardless of the Node running these
        // tests, and stub every side-effecting call.
        'node_satisfies_engine() { return 1; }',
        `start_service() { echo "start:\${SERVICE_MODE}:\${NODE_BIN}" >> "${log}"; }`,
        `stop_service() { echo "stop:\${SERVICE_MODE}" >> "${log}"; }`,
        `wait_for_health() { echo "health:$1" >> "${log}"; return 0; }`,
        `write_service_files() { echo "RENDERED-TEMPLATE" >> "${log}"; }`,
        'run_start_command',
        'run_stop_command',
      ].join('\n'),
    );
    await chmod(harness, 0o755);
    await execFileAsync('bash', [harness], { env: { ...process.env, HOME: fakeHome } });

    const calls = await readFile(log, 'utf8');
    // No plist/unit on this fake machine → the unmanaged nohup path, driven
    // with the private Node, never the system one.
    assert.match(calls, /start:nohup:.*tools\/node-v24\.9\.9-darwin-arm64\/bin\/node/);
    // Health is awaited on the port config.env holds, not the 7456 default.
    assert.match(calls, /health:19457/);
    assert.match(calls, /stop:nohup/);
    // A lifecycle command must never rewrite the service template — that is
    // install/update work, and rewriting it here would silently re-render a
    // plist from a release the user did not ask to change.
    assert.doesNotMatch(calls, /RENDERED-TEMPLATE/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
