// WP6 — deploy/host/install.sh shell-level tests. Mirrors the style of
// deploy/tests/install.test.ts (node:test + node:assert/strict + a plain
// execFile child process, no extra test-framework dependency).
//
// Every test here spawns a real `bash` child process; none of them drive a
// real launchd/systemd session — service registration is stubbed by
// sourcing install.sh with OD_INSTALL_SH_TEST_SOURCE=1 (see the guard at the
// bottom of install.sh) and overriding start_service/write_service_files
// with no-op shell functions before calling the function under test.
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, stat } from 'node:fs/promises';
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
    await writeFile(envFile, 'MEDIA_URL=https://media-from-env-file.example/\nIDENTITY_URL=https://identity-from-env-file.example/\n');

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
