// deploy/host/{install,update}.command — the macOS double-click wrappers.
// Same style as host-install.test.ts: node:test + a real `bash` child. The
// wrappers never install anything themselves, so the tests stub the two
// things they dispatch to: a fake ~/.open-design/current/install.sh (records
// its argv) and a fake bootstrap URL served from a local file via
// OD_INSTALL_SH_URL (curl reads file:// URLs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HOST_DIR = resolve(import.meta.dirname, '..', 'host');
const INSTALL_CMD = join(HOST_DIR, 'install.command');
const UPDATE_CMD = join(HOST_DIR, 'update.command');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'od-command-'));
  const odHome = join(root, 'home', '.open-design');
  const log = join(root, 'calls.log');
  return {
    root,
    odHome,
    log,
    async withInstalledCopy() {
      await mkdir(join(odHome, 'current'), { recursive: true });
      await writeFile(join(odHome, 'current', 'install.sh'), `#!/bin/bash\necho "bundled $*" >> "${log}"\nexit 0\n`);
    },
    async bootstrapFile(exit = 0) {
      const p = join(root, 'remote-install.sh');
      await writeFile(p, `#!/bin/bash\necho "bootstrap $*" >> "${log}"\nexit ${exit}\n`);
      return `file://${p}`;
    },
    async calls() {
      return readFile(log, 'utf8').catch(() => '');
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function exec(script: string, env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run('bash', [script, '--no-pause'], { env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return { code: err.code as number, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

test('install.command / update.command are executable and parse', async () => {
  for (const f of [INSTALL_CMD, UPDATE_CMD]) {
    await run('bash', ['-n', f]);
    const mode = (await import('node:fs/promises')).stat(f).then((s) => s.mode & 0o111);
    assert.notEqual(await mode, 0, `${f} must be +x (a .command without the exec bit cannot be double-clicked)`);
  }
});

// 2026-08-18: Install = CLEAN install. An existing install must NOT turn
// this into `--update`; the latest install.sh is downloaded and run fresh
// (its remove_existing_installation wipes the old runtime first).
test('install.command: existing install → still downloads the latest install.sh and runs it FRESH (no --update)', async () => {
  const fx = await fixture();
  try {
    await fx.withInstalledCopy();
    const url = await fx.bootstrapFile(0);
    const out = await exec(INSTALL_CMD, { OD_HOME: fx.odHome, OD_INSTALL_SH_URL: url });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /already installed.*Removing the previous version first/i);
    assert.equal((await fx.calls()).trim(), 'bootstrap');
    assert.doesNotMatch(await fx.calls(), /--update/);
    assert.match(out.stdout, /Open Design is ready/);
    assert.doesNotMatch(out.stdout, /Press Enter/);
  } finally {
    await fx.cleanup();
  }
});

test('install.command: no install → downloads the bootstrap install.sh and runs it (fresh install, no --update)', async () => {
  const fx = await fixture();
  try {
    const url = await fx.bootstrapFile(0);
    const out = await exec(INSTALL_CMD, { OD_HOME: fx.odHome, OD_INSTALL_SH_URL: url });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /Installing Open Design/);
    assert.equal((await fx.calls()).trim(), 'bootstrap');
  } finally {
    await fx.cleanup();
  }
});

test('install.command: bootstrap download fails → clear message, exit 1', async () => {
  const fx = await fixture();
  try {
    const out = await exec(INSTALL_CMD, { OD_HOME: fx.odHome, OD_INSTALL_SH_URL: `file://${fx.root}/missing.sh` });
    assert.equal(out.code, 1);
    assert.match(out.stdout, /Could not download the installer/);
    assert.match(out.stdout, /did not complete/);
  } finally {
    await fx.cleanup();
  }
});

test('install.command: installer exit code propagates (non-zero → "did not complete")', async () => {
  const fx = await fixture();
  try {
    const url = await fx.bootstrapFile(3);
    const out = await exec(INSTALL_CMD, { OD_HOME: fx.odHome, OD_INSTALL_SH_URL: url });
    assert.equal(out.code, 3);
    assert.match(out.stdout, /did not complete/);
  } finally {
    await fx.cleanup();
  }
});

test('update.command: existing install → bundled install.sh --update; no install → exit 1 pointing at Install', async () => {
  const fx = await fixture();
  try {
    const none = await exec(UPDATE_CMD, { OD_HOME: fx.odHome });
    assert.equal(none.code, 1);
    assert.match(none.stdout, /not installed yet/);
    assert.match(none.stdout, /OpenDesign-Install\.command/);
    await fx.withInstalledCopy();
    const ok = await exec(UPDATE_CMD, { OD_HOME: fx.odHome });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal((await fx.calls()).trim(), 'bundled --update');
    assert.match(ok.stdout, /up to date/);
  } finally {
    await fx.cleanup();
  }
});
