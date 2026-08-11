import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { DockerSetupResponse } from '@open-design/contracts';
import { resolveDockerCommand } from './agent-sandbox.js';

const execFileAsync = promisify(execFile);
const LOG_LIMIT = 160;

let state: DockerSetupResponse = {
  phase: 'idle',
  running: false,
  dockerOk: false,
  error: null,
  log: [],
};

function appendLog(value: string): void {
  for (const line of value.split(/\r?\n/)) {
    const clean = line.trimEnd();
    if (clean) state.log.push(clean);
  }
  if (state.log.length > LOG_LIMIT) state.log = state.log.slice(-LOG_LIMIT);
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function dockerReady(): Promise<boolean> {
  try {
    await execFileAsync(resolveDockerCommand(), ['info'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function spawnAndWait(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: false, env: process.env });
    child.stdout?.on('data', (chunk: Buffer) => appendLog(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => appendLog(chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} kết thúc với mã ${code ?? 'không rõ'}.`));
    });
  });
}

async function firstAccessible(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known installation path.
    }
  }
  return null;
}

async function installDockerDesktop(): Promise<void> {
  if (process.platform === 'darwin') {
    const brew = await firstAccessible(['/opt/homebrew/bin/brew', '/usr/local/bin/brew']);
    if (brew) {
      appendLog('Đang cài Docker Desktop qua Homebrew…');
      await spawnAndWait(brew, ['install', '--cask', 'docker']);
      return;
    }
    // Low-tech Macs commonly have no Homebrew. Install the official app in
    // ~/Applications so the flow stays inside Open Design and needs no sudo.
    const scratch = await mkdtemp(path.join(tmpdir(), 'open-design-docker-'));
    const dmg = path.join(scratch, 'Docker.dmg');
    const mount = path.join(scratch, 'mount');
    const applications = path.join(homedir(), 'Applications');
    const destination = path.join(applications, 'Docker.app');
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    let attached = false;
    try {
      await mkdir(mount);
      await mkdir(applications, { recursive: true });
      appendLog('Đang tải Docker Desktop chính thức…');
      await spawnAndWait('curl', ['-fL', '--retry', '3', '-o', dmg, `https://desktop.docker.com/mac/main/${arch}/Docker.dmg`]);
      appendLog('Đang cài Docker Desktop…');
      await spawnAndWait('hdiutil', ['attach', dmg, '-nobrowse', '-mountpoint', mount]);
      attached = true;
      await rm(destination, { recursive: true, force: true });
      await spawnAndWait('ditto', [path.join(mount, 'Docker.app'), destination]);
      await spawnAndWait('hdiutil', ['detach', mount]);
      attached = false;
    } finally {
      if (attached) await execFileAsync('hdiutil', ['detach', mount], { timeout: 30_000 }).catch(() => {});
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }
  if (process.platform === 'win32') {
    if (!(await commandExists('winget'))) {
      throw new Error('Máy chưa có WinGet/App Installer. Hãy cập nhật App Installer trong Microsoft Store rồi thử lại.');
    }
    appendLog('Đang cài Docker Desktop qua WinGet…');
    await spawnAndWait('winget', [
      'install', '--id', 'Docker.DockerDesktop', '-e',
      '--accept-source-agreements', '--accept-package-agreements',
    ]);
    return;
  }
  throw new Error('Cài Docker tự động hiện hỗ trợ macOS và Windows.');
}

async function startDockerDesktop(): Promise<void> {
  state.phase = 'starting';
  appendLog('Đang mở Docker Desktop…');
  if (process.platform === 'darwin') {
    const userApp = path.join(homedir(), 'Applications', 'Docker.app');
    if (await firstAccessible([userApp])) {
      await execFileAsync('open', [userApp], { timeout: 15_000 });
    } else {
      await execFileAsync('open', ['-a', 'Docker'], { timeout: 15_000 });
    }
    return;
  }
  if (process.platform === 'win32') {
    const executable = await firstAccessible([
      `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Docker\\Docker\\Docker Desktop.exe`,
      `${process.env.LOCALAPPDATA ?? ''}\\Docker\\Docker Desktop.exe`,
    ]);
    if (!executable) throw new Error('Đã cài nhưng không tìm thấy Docker Desktop để khởi động.');
    const child = spawn(executable, [], { detached: true, windowsHide: false, stdio: 'ignore' });
    child.unref();
    return;
  }
}

async function waitForDocker(): Promise<void> {
  state.phase = 'waiting';
  appendLog('Đang chờ Docker Engine sẵn sàng…');
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    if (await dockerReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error('Docker Desktop chưa sẵn sàng sau 3 phút. Có thể máy cần khởi động lại.');
}

async function runSetup(): Promise<void> {
  try {
    const resolvedDocker = resolveDockerCommand();
    if (resolvedDocker === 'docker' && !(await commandExists('docker'))) {
      state.phase = 'installing';
      await installDockerDesktop();
    }
    if (!(await dockerReady())) {
      await startDockerDesktop();
      await waitForDocker();
    }
    state = { ...state, phase: 'ready', running: false, dockerOk: true, error: null };
    appendLog('Docker đã sẵn sàng.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state = { ...state, phase: 'error', running: false, dockerOk: false, error: message };
    appendLog(message);
  }
}

export async function getDockerSetupStatus(): Promise<DockerSetupResponse> {
  if (!state.running && await dockerReady()) {
    state = { ...state, phase: 'ready', dockerOk: true, error: null };
  }
  return { ...state, log: [...state.log] };
}

export function startDockerSetup(): DockerSetupResponse {
  if (!state.running) {
    state = { phase: 'installing', running: true, dockerOk: false, error: null, log: [] };
    void runSetup();
  }
  return { ...state, log: [...state.log] };
}
