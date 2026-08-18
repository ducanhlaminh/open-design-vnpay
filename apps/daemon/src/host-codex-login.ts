// Host-mode Codex device-code login (no Docker, no terminal window).
//
// The Settings → Runtime Codex card in host mode (the locked prod default)
// needs the same embedded device-auth UX the Docker sandbox card has:
// daemon runs `codex login --device-auth` on the HOST CLI, parses the
// verification URL + one-time code out of its output, the web shows them,
// and once Codex writes `~/.codex/auth.json` the flow flips to `done`.
//
// Kept separate from the sandbox flow in sandbox-routes.ts (which drives a
// `docker run … codex login --device-auth` container) so neither path can
// break the other; the output parser is shared and lives here.

import { spawn, type ChildProcess } from 'node:child_process';
import { createCommandInvocation } from '@open-design/platform';
import type { SandboxCodexDeviceLoginStatus } from '@open-design/contracts';
import { probeCodexAuthStatus } from './runtimes/auth.js';

export const HOST_CODEX_DEVICE_LOGIN_ARGS = [
  'login',
  '--device-auth',
  '-c',
  'cli_auth_credentials_store="file"',
] as const;

const DEVICE_LOGIN_TTL_MS = 15 * 60_000;
const VERIFY_INTERVAL_MS = 1000;
const VERIFY_MAX_ATTEMPTS = 10;
const OUTPUT_TAIL_MAX = 16_384;

export function parseCodexDeviceLoginOutput(output: string): { verificationUrl: string | null; userCode: string | null } {
  // Codex colors the URL/code even without a TTY. Parse the visible text,
  // otherwise fragments such as `90mOpenAI` can be mistaken for a device code
  // and the URL retains an ESC suffix that breaks browser navigation.
  const compact = output
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
  const urlMatch = compact.match(/https:\/\/[^\s]+\/codex\/device\b/i) ?? compact.match(/https:\/\/[^\s]+/i);
  const codeMatch = compact.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/i);
  return {
    verificationUrl: urlMatch ? urlMatch[0] : null,
    userCode: codeMatch ? codeMatch[0] : null,
  };
}

type HostCodexDeviceLoginSession = {
  phase: SandboxCodexDeviceLoginStatus['phase'];
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  child: ChildProcess;
  env: NodeJS.ProcessEnv;
  output: string;
  verifyTimer: NodeJS.Timeout | null;
  deadline: NodeJS.Timeout;
  expiresAt: string;
};

let session: HostCodexDeviceLoginSession | null = null;

function snapshot(): SandboxCodexDeviceLoginStatus {
  if (!session) return { phase: 'idle', url: null, code: null, expiresAt: null, error: null };
  const { phase, verificationUrl, userCode, expiresAt, error } = session;
  return { phase, url: verificationUrl, code: userCode, expiresAt, error };
}

function stop(s: HostCodexDeviceLoginSession): void {
  if (s.verifyTimer) clearInterval(s.verifyTimer);
  clearTimeout(s.deadline);
  try {
    s.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

export function hostCodexDeviceLoginStatus(): SandboxCodexDeviceLoginStatus {
  return snapshot();
}

/** Stop the in-flight flow (if any) and forget it — used by logout so a
 *  stale "awaiting-user" never outlives the credential it was creating. */
export function clearHostCodexDeviceLogin(): void {
  if (session) {
    stop(session);
    session = null;
  }
}

export function cancelHostCodexDeviceLogin(): SandboxCodexDeviceLoginStatus {
  if (session) {
    stop(session);
    session.phase = 'error';
    session.error = 'Đăng nhập Codex đã bị hủy.';
  }
  return snapshot();
}

export type HostCodexDeviceLoginIO = {
  /** Injectable for tests: spawn the login child. */
  spawnLogin?: (launchPath: string, env: NodeJS.ProcessEnv) => ChildProcess;
  /** Injectable for tests: does the host now carry a Codex login? */
  probeLoggedIn?: (env: NodeJS.ProcessEnv) => Promise<boolean>;
  now?: () => number;
};

function defaultSpawnLogin(launchPath: string, env: NodeJS.ProcessEnv): ChildProcess {
  const invocation = createCommandInvocation({ command: launchPath, args: [...HOST_CODEX_DEVICE_LOGIN_ARGS], env });
  return spawn(invocation.command, invocation.args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

async function defaultProbeLoggedIn(env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await probeCodexAuthStatus(env)).status === 'ok';
}

/**
 * Start (or restart) the host device-auth flow. `launchPath` is the resolved
 * host Codex binary (same resolution chat/run use — see resolveAgentLaunch),
 * `env` the launch env (so CODEX_HOME / PATH overrides are honoured by both
 * the child and the auth probe).
 */
export function startHostCodexDeviceLogin(
  launchPath: string,
  env: NodeJS.ProcessEnv,
  io: HostCodexDeviceLoginIO = {},
): SandboxCodexDeviceLoginStatus {
  clearHostCodexDeviceLogin();
  const now = io.now ?? Date.now;
  const probeLoggedIn = io.probeLoggedIn ?? defaultProbeLoggedIn;
  const child = (io.spawnLogin ?? defaultSpawnLogin)(launchPath, env);
  const s: HostCodexDeviceLoginSession = {
    phase: 'starting',
    verificationUrl: null,
    userCode: null,
    error: null,
    child,
    env,
    output: '',
    verifyTimer: null,
    expiresAt: new Date(now() + DEVICE_LOGIN_TTL_MS).toISOString(),
    deadline: setTimeout(() => {
      if (session !== s) return;
      s.phase = 'error';
      s.error = 'Đăng nhập Codex hết thời gian chờ — thử lại.';
      stop(s);
    }, DEVICE_LOGIN_TTL_MS),
  };
  s.deadline.unref();

  const onData = (chunk: Buffer | string) => {
    if (session !== s) return;
    s.output = `${s.output}${chunk.toString()}`.slice(-OUTPUT_TAIL_MAX);
    if (s.phase === 'starting' || s.phase === 'awaiting-user') {
      const parsed = parseCodexDeviceLoginOutput(s.output);
      if (parsed.verificationUrl) s.verificationUrl = parsed.verificationUrl;
      if (parsed.userCode) s.userCode = parsed.userCode;
      if (s.verificationUrl && s.userCode) s.phase = 'awaiting-user';
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (err) => {
    if (session !== s) return;
    s.phase = 'error';
    s.error = `Không chạy được Codex CLI: ${err.message}`;
    if (s.verifyTimer) clearInterval(s.verifyTimer);
    clearTimeout(s.deadline);
  });
  child.on('close', (code) => {
    if (session !== s) return;
    if (s.phase === 'error') return;
    // Codex exits once the browser side approves (auth.json written) or the
    // code expires / the user declines. Confirm via the same probe
    // /api/agents uses; retry briefly in case the file lands a beat later.
    s.phase = 'verifying';
    let attempts = 0;
    s.verifyTimer = setInterval(() => {
      if (session !== s) return;
      attempts += 1;
      void probeLoggedIn(s.env).then((ok) => {
        if (session !== s || s.phase !== 'verifying') return;
        if (ok) {
          s.phase = 'done';
          if (s.verifyTimer) clearInterval(s.verifyTimer);
          clearTimeout(s.deadline);
          return;
        }
        if (attempts >= VERIFY_MAX_ATTEMPTS) {
          s.phase = 'error';
          const tail = s.output
            .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
            .trim()
            .split('\n')
            .filter(Boolean)
            .slice(-2)
            .join(' ');
          s.error =
            code === 0
              ? 'Codex chưa xác thực xong — thử lại.'
              : `Codex kết thúc đăng nhập (mã ${code ?? '?'})${tail ? `: ${tail}` : ''} — thử lại.`;
          if (s.verifyTimer) clearInterval(s.verifyTimer);
          clearTimeout(s.deadline);
        }
      });
    }, VERIFY_INTERVAL_MS);
    s.verifyTimer.unref();
  });

  session = s;
  return snapshot();
}
