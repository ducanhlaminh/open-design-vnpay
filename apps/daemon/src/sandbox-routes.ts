// Agent-in-sandbox status surface. The web Settings card and `od sandbox
// status` both consume it. Enable/disable persists through the existing
// `PUT /api/app-config` (`sandbox` section) — no dedicated mutation endpoint
// here. Build/login are terminal-interactive docker operations and live in the
// CLI (`od sandbox build|login`), which resolves the scripts through
// `builderDir` from this response.
//
// This module also owns the Codex device-login session state machine. The
// device flow is specific to the Docker sandbox so it lives next to the other
// sandbox auth routes, while the fallback resolver is exported for server.ts to
// keep agent selection in one place.
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { Express, Response } from 'express';
import type {
  SandboxCodexDeviceLoginStatus,
  SandboxRuntimeAuthStatus,
  SandboxRuntimeId,
  SandboxRuntimeLoginMethod,
  SandboxRuntimeStatus,
  SandboxStatusResponse,
  SandboxHostClaudeStatus,
  SandboxMode,
  SandboxAccountsResponse,
  SandboxAccountsCheckResponse,
  SandboxBuildResponse,
  DockerSetupResponse,
} from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';
import { readAppConfig, type AppConfigPrefs } from './app-config.js';
import { invalidateClaudeUsageCache, probeClaudeCredentials } from './claude-usage.js';
import { getAgentDef, resolveAgentLaunch } from './agents.js';
import { probeClaudeAuthStatus } from './runtimes/auth.js';
import {
  dockerAvailable,
  dockerImagePresent,
  dockerVolumePresent,
  listSandboxContainers,
  listSandboxAccounts,
  autoSaveSandboxLogin,
  saveSandboxAccount,
  switchSandboxAccount,
  removeSandboxAccount,
  readSandboxAccountCredentials,
  openSandboxLoginTerminal,
  openHostLoginTerminal,
  startEmbeddedLogin,
  getEmbeddedLoginStatus,
  submitEmbeddedLoginCode,
  cancelEmbeddedLogin,
  ensureSandboxImage,
  resolveSandboxConfig,
  sandboxAuthLoggedIn,
  sandboxAuthDir,
  sandboxAuthFile,
  sandboxAuthVolume,
  retireLegacyPackagedSandboxAuth,
  clearSandboxRuntimeAuth,
  resolveDockerCommand,
  sandboxImageTag,
  SANDBOX_AUTH_VOLUME,
  SANDBOX_IMAGE_NAME,
} from './agent-sandbox.js';
import { getDockerSetupStatus, startDockerSetup } from './docker-setup.js';
import { getWindowsFirmwareStatus, restartWindowsToFirmware } from './windows-system-setup.js';

const execFileAsync = promisify(execFile);
const SANDBOX_RUNTIME_IDS: readonly SandboxRuntimeId[] = ['claude', 'codex'];
const SANDBOX_RUNTIME_LOGIN_METHODS: Record<SandboxRuntimeId, SandboxRuntimeLoginMethod> = {
  claude: 'interactive',
  codex: 'device',
};

export function sandboxRuntimeIsGated(
  cfg: { enabled: boolean; runtimes: string[]; skills: string[] },
  runtimeId: SandboxRuntimeId,
): boolean {
  return (
    cfg.enabled &&
    cfg.skills.includes('*') &&
    (cfg.runtimes.includes('*') || cfg.runtimes.includes(runtimeId))
  );
}

export function resolveSandboxFallbackRuntimeId(
  cfg: { enabled: boolean; runtimes: string[]; skills: string[] },
): SandboxRuntimeId | null {
  if (sandboxRuntimeIsGated(cfg, 'claude')) return 'claude';
  if (sandboxRuntimeIsGated(cfg, 'codex')) return 'codex';
  return null;
}

/** `resolveSandboxConfig().enabled` spelled as the mode web/CLI branch on
 *  (web-first migration, WP4: host is the default; the sandbox is opt-in). */
export function sandboxModeFromCfg(cfg: { enabled: boolean }): SandboxMode {
  return cfg.enabled ? 'sandbox' : 'host';
}

export const SANDBOX_MODE_HOST_MESSAGE =
  'Daemon đang ở chế độ Host CLI — thao tác này chỉ áp dụng khi Docker sandbox được bật. ' +
  'Bật lại trong Cài đặt → Chế độ thực thi, hoặc chạy `od sandbox enable` (hay đặt OD_SANDBOX=1) rồi thử lại.';

/**
 * Host Claude CLI snapshot for `GET /api/sandbox/status` / `od sandbox
 * status` / `od doctor`. Deliberately cheap: PATH resolution (no spawn) for
 * `available`, and the same file/Keychain probe `/api/agents` uses for auth —
 * no Docker touched, so this is safe to compute in EVERY mode (unlike the
 * docker* fields below, which stay whatever the sandbox preflight last saw).
 */
export async function resolveHostClaudeStatus(): Promise<SandboxHostClaudeStatus> {
  const def = getAgentDef('claude');
  const launch = def ? resolveAgentLaunch(def, {}) : null;
  const available = Boolean(launch?.selectedPath && launch?.launchPath);
  const auth = await probeClaudeAuthStatus(process.env);
  return {
    available,
    authStatus: auth.status,
    ...(auth.message ? { authMessage: auth.message } : {}),
  };
}

async function dockerText(args: string[], timeoutMs = 10_000): Promise<string> {
  const { stdout } = await execFileAsync(resolveDockerCommand(), args, { timeout: timeoutMs });
  return stdout.trim();
}

async function dockerPresent(args: string[], timeoutMs = 10_000): Promise<boolean> {
  try {
    await dockerText(args, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function probeRuntimeVersion(image: string, runtimeId: SandboxRuntimeId): Promise<string | null> {
  try {
    return (await dockerText(['run', '--rm', image, runtimeId, '--version'], 30_000)).split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

function runtimeAuthVolume(runtimeId: SandboxRuntimeId): string {
  return sandboxAuthVolume(runtimeId);
}

function runtimeLoginMethod(runtimeId: SandboxRuntimeId): SandboxRuntimeLoginMethod {
  return SANDBOX_RUNTIME_LOGIN_METHODS[runtimeId];
}

function authStatusFromText(text: string, runtimeId: SandboxRuntimeId): SandboxRuntimeAuthStatus {
  const normalized = text.toLowerCase();
  if (runtimeId === 'claude') {
    if (normalized.includes('logged in') || normalized.includes('authenticated')) return 'logged-in';
    if (normalized.includes('not logged in') || normalized.includes('sign in') || normalized.includes('login')) {
      return 'missing';
    }
    return 'unknown';
  }
  if (normalized.includes('logged in') || normalized.includes('authenticated')) return 'logged-in';
  if (normalized.includes('not logged in') || normalized.includes('sign in') || normalized.includes('login')) {
    return 'missing';
  }
  return 'unknown';
}

async function probeRuntimeAuthStatus(image: string, runtimeId: SandboxRuntimeId): Promise<SandboxRuntimeAuthStatus> {
  if (runtimeId === 'claude') {
    return (await sandboxAuthLoggedIn(image)) ? 'logged-in' : 'missing';
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      resolveDockerCommand(),
      ['run', '--rm', '-v', `${sandboxAuthVolume('codex')}:${sandboxAuthDir('codex')}`, '-e', `CODEX_HOME=${sandboxAuthDir('codex')}`, image, 'codex', 'login', 'status'],
      { timeout: 30_000 },
    );
    return authStatusFromText(`${stdout}\n${stderr}`, runtimeId);
  } catch (err) {
    const stdout = typeof err === 'object' && err && 'stdout' in err ? String((err as { stdout?: unknown }).stdout ?? '') : '';
    const stderr = typeof err === 'object' && err && 'stderr' in err ? String((err as { stderr?: unknown }).stderr ?? '') : '';
    return authStatusFromText(`${stdout}\n${stderr}`, runtimeId);
  }
}

export async function buildSandboxRuntimeStatuses(
  image: string,
  probeAuth: boolean,
  dockerOk: boolean,
): Promise<SandboxRuntimeStatus[]> {
  const imageAvailable = dockerOk && (await dockerPresent(['image', 'inspect', '--format', '{{.Id}}', image]));
  return Promise.all(
    SANDBOX_RUNTIME_IDS.map(async (runtimeId) => {
      const authVolume = runtimeAuthVolume(runtimeId);
      const authVolumeAvailable = dockerOk && (await dockerPresent(['volume', 'inspect', '--format', '{{.Name}}', authVolume]));
      const authStatus =
        !dockerOk || !imageAvailable
          ? 'unknown'
          : !authVolumeAvailable
            ? 'missing'
          : probeAuth
            ? await probeRuntimeAuthStatus(image, runtimeId)
            : 'unknown';
      return {
        id: runtimeId,
        version: imageAvailable ? await probeRuntimeVersion(image, runtimeId) : null,
        imageAvailable,
        authVolume,
        authVolumeAvailable,
        authStatus,
        loginMethod: runtimeLoginMethod(runtimeId),
      };
    }),
  );
}

type CodexDeviceLoginSession = {
  phase: SandboxCodexDeviceLoginStatus['phase'];
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  image: string;
  containerName: string;
  child: ChildProcess;
  output: string;
  verifyTimer: NodeJS.Timeout | null;
  deadline: NodeJS.Timeout;
  expiresAt: string;
};

let codexDeviceLogin: CodexDeviceLoginSession | null = null;

function stopCodexDeviceLoginSession(session: CodexDeviceLoginSession): void {
  if (session.verifyTimer) clearInterval(session.verifyTimer);
  clearTimeout(session.deadline);
  try {
    session.child.kill('SIGKILL');
  } catch {
    /* already stopped */
  }
  void execFileAsync(resolveDockerCommand(), ['rm', '-f', session.containerName], { timeout: 10_000 }).catch(() => {});
}

function codexDeviceLoginStatus(): SandboxCodexDeviceLoginStatus {
  if (!codexDeviceLogin) return { phase: 'idle', url: null, code: null, expiresAt: null, error: null };
  const { phase, verificationUrl, userCode, expiresAt, error } = codexDeviceLogin;
  return { phase, url: verificationUrl, code: userCode, expiresAt, error };
}

function clearCodexDeviceLogin(): void {
  if (codexDeviceLogin) {
    stopCodexDeviceLoginSession(codexDeviceLogin);
    codexDeviceLogin = null;
  }
}

function cancelCodexDeviceLogin(): SandboxCodexDeviceLoginStatus {
  if (codexDeviceLogin) {
    stopCodexDeviceLoginSession(codexDeviceLogin);
    codexDeviceLogin.phase = 'error';
    codexDeviceLogin.error = 'Đăng nhập Codex đã bị hủy.';
  }
  return codexDeviceLoginStatus();
}

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

function startCodexDeviceLogin(image: string): SandboxCodexDeviceLoginStatus {
  clearCodexDeviceLogin();
  const containerName = `od.sandbox.codex.login.${Date.now()}`;
  const child = spawn(
    resolveDockerCommand(),
    [
      'run',
      '-i',
      '--rm',
      '--name',
      containerName,
      '-v',
      `${sandboxAuthVolume('codex')}:${sandboxAuthDir('codex')}`,
      '-e',
      `CODEX_HOME=${sandboxAuthDir('codex')}`,
      image,
      'codex',
      'login',
      '--device-auth',
      '-c',
      'cli_auth_credentials_store="file"',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const session: CodexDeviceLoginSession = {
    phase: 'starting',
    verificationUrl: null,
    userCode: null,
    error: null,
    image,
    containerName,
    child,
    output: '',
    verifyTimer: null,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    deadline: setTimeout(() => {
      if (codexDeviceLogin !== session) return;
      session.phase = 'error';
      session.error = 'Đăng nhập Codex hết thời gian chờ — thử lại.';
      stopCodexDeviceLoginSession(session);
    }, 15 * 60_000),
  };
  session.deadline.unref();
  const onData = (chunk: Buffer) => {
    if (codexDeviceLogin !== session) return;
    session.output = `${session.output}${chunk.toString('utf8')}`.slice(-16_384);
    if (session.phase === 'starting' || session.phase === 'awaiting-user') {
      const parsed = parseCodexDeviceLoginOutput(session.output);
      if (parsed.verificationUrl) session.verificationUrl = parsed.verificationUrl;
      if (parsed.userCode) session.userCode = parsed.userCode;
      if (session.verificationUrl && session.userCode) {
        session.phase = 'awaiting-user';
      }
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (err) => {
    if (codexDeviceLogin !== session) return;
    session.phase = 'error';
    session.error = `Không chạy được docker: ${err.message}`;
    if (session.verifyTimer) clearInterval(session.verifyTimer);
    clearTimeout(session.deadline);
  });
  child.on('close', () => {
    if (codexDeviceLogin !== session) return;
    session.phase = 'verifying';
    session.verifyTimer = setInterval(() => {
      if (codexDeviceLogin !== session) return;
      void probeRuntimeAuthStatus(image, 'codex').then((status) => {
        if (codexDeviceLogin !== session) return;
        if (status === 'logged-in') {
          session.phase = 'done';
          if (session.verifyTimer) clearInterval(session.verifyTimer);
          clearTimeout(session.deadline);
          void execFileAsync(resolveDockerCommand(), ['rm', '-f', session.containerName], { timeout: 10_000 }).catch(() => {});
          return;
        }
        if (status === 'missing') {
          session.phase = 'error';
          session.error = 'Codex chưa xác thực xong — thử lại.';
          if (session.verifyTimer) clearInterval(session.verifyTimer);
          clearTimeout(session.deadline);
        }
      });
    }, 2000);
    session.verifyTimer.unref();
  });
  codexDeviceLogin = session;
  return codexDeviceLoginStatus();
}

async function resolveSandboxStatusBody(
  req: { query: Record<string, unknown> },
  ctx: RegisterSandboxRoutesDeps,
): Promise<SandboxStatusResponse> {
  const { RUNTIME_DATA_DIR, SKILLS_DIR } = ctx.paths;
  const builderDir = path.join(SKILLS_DIR, 'ui-react', 'builder');
  const prefs = await readAppConfig(RUNTIME_DATA_DIR).catch(
    (): AppConfigPrefs => ({}),
  );
  const cfg = resolveSandboxConfig(prefs.sandbox, process.env);

  let image = `${SANDBOX_IMAGE_NAME}:unknown`;
  let claudeVersion: string | null = null;
  try {
    image = sandboxImageTag(builderDir);
    const { readFileSync } = await import('node:fs');
    claudeVersion = readFileSync(
      path.join(builderDir, 'sandbox', 'claude.version'),
      'utf8',
    ).trim();
  } catch {
    // Builder pins unreadable (skill missing/moved) — report unknown.
  }

  const dockerOk = await dockerAvailable();
  const imageOk = dockerOk && (await dockerImagePresent(image));
  if (imageOk) await retireLegacyPackagedSandboxAuth(image);
  const authVolumeOk = dockerOk && (await dockerVolumePresent(SANDBOX_AUTH_VOLUME));
  const probeAuth = req.query.probeAuth === '1';
  const authLoggedIn = probeAuth && imageOk && authVolumeOk ? await sandboxAuthLoggedIn(image) : null;
  const runtimeStatuses = await buildSandboxRuntimeStatuses(image, probeAuth, dockerOk);
  const activeContainers = dockerOk ? await listSandboxContainers() : [];
  const hostClaude = await resolveHostClaudeStatus();

  return {
    enabled: cfg.enabled,
    mode: sandboxModeFromCfg(cfg),
    runtimes: cfg.runtimes,
    skills: cfg.skills,
    timeoutMinutes: cfg.timeoutMinutes,
    dockerOk,
    image,
    imageOk,
    claudeVersion,
    authVolumeOk,
    authLoggedIn,
    runtimeStatuses,
    activeContainers,
    builderDir,
    hostClaude,
  };
}

export interface RegisterSandboxRoutesDeps extends RouteDeps<'http' | 'paths'> {}

export function registerSandboxRoutes(app: Express, ctx: RegisterSandboxRoutesDeps) {
  const { sendApiError } = ctx.http;
  const { RUNTIME_DATA_DIR, SKILLS_DIR } = ctx.paths;
  const builderDir = path.join(SKILLS_DIR, 'ui-react', 'builder');

  // Docker-only ACTION routes (build / accounts / embedded-login / Codex
  // device login) must not even attempt a docker call while the daemon is in
  // host mode — a clean 409 beats either a confusing "Docker chưa chạy" 503
  // (from a build that only ran that check because nobody gated it) or,
  // worse, a 500. Setup routes that HELP a host-mode user switch INTO sandbox
  // mode (`/api/sandbox/docker/setup`, `/api/sandbox/windows/firmware*`) are
  // deliberately NOT gated here — blocking those would make opting into the
  // sandbox from host mode impossible.
  const requireSandboxEnabled = async (res: Response): Promise<boolean> => {
    const prefs = await readAppConfig(RUNTIME_DATA_DIR).catch((): AppConfigPrefs => ({}));
    const cfg = resolveSandboxConfig(prefs.sandbox, process.env);
    if (cfg.enabled) return true;
    sendApiError(res, 409, 'SANDBOX_MODE_HOST', SANDBOX_MODE_HOST_MESSAGE);
    return false;
  };

  // Host-mode CLI login trigger for the "Local CLI" panel — deliberately
  // NOT behind requireSandboxEnabled: this opens a terminal for the
  // HOST-installed `claude`/`codex` binary directly (openHostLoginTerminal,
  // agent-sandbox.ts), independent of whether the Docker sandbox is
  // enabled. Lives here (next to the sandbox login routes) rather than in
  // auth-routes.ts because that file is entirely about the daemon's own
  // Google-SSO gateway, a different concern. Response shape matches the
  // Docker sandbox login routes above (`{ launched, command, message }`) so
  // the frontend reuses the same "open terminal → copy-paste fallback →
  // poll for state to flip" UX.
  app.post('/api/agents/:agentId/login', (req, res) => {
    const agentId = req.params.agentId;
    if (agentId !== 'claude' && agentId !== 'codex') {
      return sendApiError(res, 400, 'BAD_REQUEST', 'agentId must be "claude" or "codex".');
    }
    res.json(openHostLoginTerminal(agentId));
  });

  app.get('/api/sandbox/status', async (req, res) => {
    try {
      res.json(await resolveSandboxStatusBody(req, ctx));
    } catch (err) {
      return sendApiError(res, 500, 'INTERNAL_ERROR', `sandbox status failed: ${(err as Error).message}`);
    }
  });

  app.get('/api/sandbox/docker/setup', async (_req, res) => {
    res.json(await getDockerSetupStatus() satisfies DockerSetupResponse);
  });

  app.post('/api/sandbox/docker/setup', (_req, res) => {
    res.status(202).json(startDockerSetup() satisfies DockerSetupResponse);
  });

  app.get('/api/sandbox/windows/firmware', async (_req, res) => {
    try {
      res.json(await getWindowsFirmwareStatus(RUNTIME_DATA_DIR));
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', `Windows firmware detection failed: ${(err as Error).message}`);
    }
  });

  app.post('/api/sandbox/windows/firmware/restart', async (req, res) => {
    if (req.body?.confirmed !== true) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'Cần xác nhận rõ ràng trước khi khởi động lại máy.');
    }
    if (process.platform !== 'win32') {
      return sendApiError(res, 400, 'BAD_REQUEST', 'Tính năng này chỉ hỗ trợ Windows.');
    }
    try {
      const status = await getWindowsFirmwareStatus(RUNTIME_DATA_DIR);
      if (!status.detection) return sendApiError(res, 500, 'INTERNAL_ERROR', 'Không đọc được thông tin firmware.');
      const pending = await restartWindowsToFirmware(RUNTIME_DATA_DIR, status.detection);
      res.status(202).json({ ok: true, restartScheduled: true, delaySeconds: 5, pending });
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'UEFI_REQUIRED') return sendApiError(res, 409, 'BAD_REQUEST', 'Máy không hỗ trợ khởi động thẳng vào UEFI; hãy dùng phím BIOS trong hướng dẫn.');
      if (message === 'VIRTUALIZATION_ALREADY_ENABLED') return sendApiError(res, 409, 'BAD_REQUEST', 'Virtualization đã được bật.');
      return sendApiError(res, 500, 'INTERNAL_ERROR', `Không thể lên lịch khởi động vào UEFI: ${message}`);
    }
  });

  // ── Claude account switching (Docker-only) ────────────────────────────────
  // `supported` = the sandbox OWNS Claude (enabled + skills '*' + claude gated);
  // `ready` also needs docker + the image so the account containers can run.
  const accountsContext = async (): Promise<{ supported: boolean; image: string | null; ready: boolean }> => {
    const prefs = await readAppConfig(RUNTIME_DATA_DIR).catch((): AppConfigPrefs => ({}));
    const cfg = resolveSandboxConfig(prefs.sandbox, process.env);
    const supported =
      cfg.enabled && cfg.skills.includes('*') && (cfg.runtimes.includes('*') || cfg.runtimes.includes('claude'));
    let image: string | null = null;
    try {
      image = sandboxImageTag(builderDir);
    } catch {
      image = null;
    }
    const ready = supported && !!image && (await dockerAvailable()) && !!image && (await dockerImagePresent(image));
    return { supported, image, ready };
  };

  const emptyAccounts = (supported: boolean): SandboxAccountsResponse => ({
    supported,
    loggedIn: false,
    activeUnsaved: false,
    accounts: [],
  });

  const runAccountMutation = async (
    res: Response,
    fn: (image: string) => Promise<SandboxAccountsResponse>,
  ): Promise<void> => {
    if (!(await requireSandboxEnabled(res))) return;
    const { supported, image, ready } = await accountsContext();
    if (!supported) {
      sendApiError(res, 400, 'BAD_REQUEST', 'Chuyển account chỉ áp dụng khi sandbox sở hữu Claude (Docker-only).');
      return;
    }
    if (!ready || !image) {
      sendApiError(res, 503, 'SANDBOX_UNAVAILABLE', 'Docker/sandbox image chưa sẵn sàng — bật Docker + build image trước.');
      return;
    }
    try {
      res.json(await fn(image));
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', (err as Error).message);
    }
  };

  // `loggedIn` as of the previous listing, so we can spot the moment it turns
  // on. `null` = never observed yet (a first listing that is already logged in
  // must still invalidate: the daemon may have cached a signed-out verdict
  // before the user logged in through a terminal).
  let lastLoggedIn: boolean | null = null;

  /**
   * Drop the cached Claude usage the moment this listing reports a login that
   * the previous one did not. This listing IS the signal behind the green
   * "đã đăng nhập" check, so tying invalidation to it keeps the quota meter and
   * the check in step no matter HOW the login happened — embedded flow,
   * terminal fallback, or a `claude /login` run outside the app entirely.
   *
   * Invalidating when the *code is submitted* is too early and was the original
   * bug: the credentials land a few seconds later, so any usage read in that
   * window re-cached "signed out" and the meter stayed hidden for a further
   * minute after the check had already gone green.
   */
  const noteLoginState = (loggedIn: boolean): void => {
    if (loggedIn && lastLoggedIn !== true) invalidateClaudeUsageCache();
    lastLoggedIn = loggedIn;
  };

  app.get('/api/sandbox/accounts', async (_req, res) => {
    try {
      const { supported, image, ready } = await accountsContext();
      if (!ready || !image) {
        res.json(emptyAccounts(supported));
        return;
      }
      let accounts = await listSandboxAccounts(image);
      const isNewLogin = accounts.loggedIn === true && lastLoggedIn !== true;
      noteLoginState(accounts.loggedIn === true);

      // A login that just appeared gets filed into the account list under a name
      // derived from its own email, so the user never has to invent one. Runs
      // BEFORE responding so the very first listing after a login already shows
      // the account, and never throws — a failed auto-save just leaves the
      // existing "name this login" prompt in place.
      if (isNewLogin) {
        const result = await autoSaveSandboxLogin(image);
        if (result.saved) {
          console.log(
            `[sandbox] auto-saved Claude login as "${result.label}"` +
              (result.reused ? ' (refreshed existing account)' : ''),
          );
          accounts = await listSandboxAccounts(image);
        } else if (result.reason !== 'already-saved') {
          console.warn(`[sandbox] auto-save skipped: ${result.reason}`);
        }
      }
      res.json(accounts);
    } catch (err) {
      return sendApiError(res, 500, 'INTERNAL_ERROR', `list accounts failed: ${(err as Error).message}`);
    }
  });

  app.post('/api/sandbox/accounts/save', async (req, res) => {
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    await runAccountMutation(res, (image) => saveSandboxAccount(image, label));
  });

  app.post('/api/sandbox/accounts/switch', async (req, res) => {
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    await runAccountMutation(res, async (image) => {
      const result = await switchSandboxAccount(image, label);
      // The active credentials just changed — drop the cached usage so the
      // quota meter reflects the newly-switched account on its next poll.
      invalidateClaudeUsageCache();
      return result;
    });
  });

  app.delete('/api/sandbox/accounts/:label', async (req, res) => {
    const label = decodeURIComponent(req.params.label ?? '');
    await runAccountMutation(res, (image) => removeSandboxAccount(image, label));
  });

  // Check each saved account's token health (probe its OAuth token). A revoked/
  // expired token (e.g. password changed) comes back ok:false with an error —
  // the UI flags it red and shows the error, but never deletes the account.
  app.post('/api/sandbox/accounts/check', async (req, res) => {
    if (!(await requireSandboxEnabled(res))) return;
    const { supported, image, ready } = await accountsContext();
    if (!supported) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'Chỉ áp dụng khi Docker-only (sandbox sở hữu Claude).');
    }
    if (!ready || !image) {
      return sendApiError(res, 503, 'SANDBOX_UNAVAILABLE', 'Docker/sandbox image chưa sẵn sàng.');
    }
    try {
      // Optional `label` → probe just that account; absent → probe them all.
      const only = typeof req.body?.label === 'string' ? req.body.label : null;
      const { accounts } = await listSandboxAccounts(image);
      const targets = only ? accounts.filter((a) => a.label === only) : accounts;
      const statuses = await Promise.all(
        targets.map(async (a) => {
          const raw = await readSandboxAccountCredentials(image, a.label);
          if (!raw) return { label: a.label, ok: false, error: 'Không đọc được credentials' };
          const probe = await probeClaudeCredentials(raw);
          return { label: a.label, ok: probe.ok, ...(probe.error ? { error: probe.error } : {}) };
        }),
      );
      res.json({ statuses } satisfies SandboxAccountsCheckResponse);
    } catch (err) {
      return sendApiError(res, 500, 'INTERNAL_ERROR', `check accounts failed: ${(err as Error).message}`);
    }
  });

  // ── Build the sandbox image from the UI ("Build image" button) ────────────
  // On a fresh machine (Docker installed, image not built yet) the user can't
  // run `od sandbox build` from a terminal they may not have — so build it in
  // the daemon. `ensureSandboxImage` builds the base image first when THAT is
  // missing too, i.e. "build whatever's missing". Builds take minutes: POST
  // starts it and returns at once; the UI polls GET until `building` is false.
  const BUILD_LOG_MAX = 200;
  let buildState: SandboxBuildResponse = { building: false, ok: null, error: null, log: [] };
  const pushBuildLog = (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const l = line.replace(/\s+$/, '');
      if (l) buildState.log.push(l);
    }
    if (buildState.log.length > BUILD_LOG_MAX) {
      buildState.log = buildState.log.slice(-BUILD_LOG_MAX);
    }
  };

  app.get('/api/sandbox/build', (_req, res) => {
    res.json(buildState);
  });

  app.post('/api/sandbox/build', async (_req, res) => {
    if (!(await requireSandboxEnabled(res))) return;
    if (buildState.building) {
      // Already running — just report progress (idempotent, no second build).
      res.json(buildState);
      return;
    }
    let image: string;
    try {
      image = sandboxImageTag(builderDir);
    } catch {
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Không đọc được phiên bản image (skills/ui-react/builder thiếu?).');
    }
    if (!(await dockerAvailable())) {
      return sendApiError(res, 503, 'SANDBOX_UNAVAILABLE', 'Docker chưa chạy — bật Docker/OrbStack rồi thử lại.');
    }
    buildState = { building: true, ok: null, error: null, log: [] };
    // Fire-and-forget: the build runs for minutes; the UI polls GET for progress.
    void ensureSandboxImage(builderDir, image, pushBuildLog)
      .then((result) => {
        buildState.ok = result.ok;
        buildState.error = result.ok ? null : result.reason ?? 'Build thất bại.';
        if (!result.ok && result.reason) pushBuildLog(result.reason);
      })
      .catch((err: unknown) => {
        buildState.ok = false;
        buildState.error = err instanceof Error ? err.message : String(err);
        pushBuildLog(buildState.error);
      })
      .finally(() => {
        buildState.building = false;
      });
    res.status(202).json(buildState);
  });

  // Add account = open a host terminal running the interactive Claude OAuth
  // login (can't embed the TUI in the web). The user finishes there, then Saves.
  app.post('/api/sandbox/accounts/login', async (_req, res) => {
    if (!(await requireSandboxEnabled(res))) return;
    const { supported, image, ready } = await accountsContext();
    if (!supported) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'Chỉ áp dụng khi Docker-only (sandbox sở hữu Claude).');
    }
    if (!ready || !image) {
      return sendApiError(res, 503, 'SANDBOX_UNAVAILABLE', 'Docker/sandbox image chưa sẵn sàng.');
    }
    res.json(openSandboxLoginTerminal(image));
  });

  // ── Embedded (no-terminal) login: the daemon drives `claude /login` in the
  // container and the web collects the OAuth code (see agent-sandbox.ts).
  // GET = poll state; POST = start session; POST /code = submit pasted code;
  // DELETE = cancel. One session at a time.
  app.get('/api/sandbox/embedded-login', (_req, res) => {
    res.json(getEmbeddedLoginStatus());
  });

  app.post('/api/sandbox/embedded-login', async (_req, res) => {
    if (!(await requireSandboxEnabled(res))) return;
    const { supported, image, ready } = await accountsContext();
    if (!supported) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'Chỉ áp dụng khi Docker-only (sandbox sở hữu Claude).');
    }
    if (!ready || !image) {
      return sendApiError(res, 503, 'SANDBOX_UNAVAILABLE', 'Docker/sandbox image chưa sẵn sàng.');
    }
    res.json(startEmbeddedLogin(image));
  });

  app.post('/api/sandbox/embedded-login/code', (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    try {
      // No usage-cache invalidation here on purpose: submitting the code only
      // STARTS the exchange, and the credentials appear seconds later. The
      // cache is dropped by `noteLoginState` once a listing actually reports
      // the login — see the comment there.
      const status = submitEmbeddedLoginCode(code);
      res.json(status);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', (err as Error).message);
    }
  });

  app.delete('/api/sandbox/embedded-login', (_req, res) => {
    res.json(cancelEmbeddedLogin());
  });

  const codexContext = async (): Promise<{ supported: boolean; image: string | null; ready: boolean }> => {
    const prefs = await readAppConfig(RUNTIME_DATA_DIR).catch((): AppConfigPrefs => ({}));
    const cfg = resolveSandboxConfig(prefs.sandbox, process.env);
    // Login/logout are setup operations, not run-gating decisions. Allow them
    // whenever the sandbox is enabled and the image contains Codex; otherwise
    // a legacy persisted `runtimes: ['claude']` creates an HTTP 400 loop that
    // prevents the user from ever enabling/authenticating Codex.
    const supported = cfg.enabled;
    let image: string | null = null;
    try {
      image = sandboxImageTag(builderDir);
    } catch {
      image = null;
    }
    const ready = supported && !!image && (await dockerAvailable()) && !!image && (await dockerImagePresent(image));
    return { supported, image, ready };
  };

  const getCodexLogin = (_req: unknown, res: Response) => {
    res.json(codexDeviceLoginStatus());
  };
  app.get('/api/sandbox/codex-login', getCodexLogin);
  app.get('/api/sandbox/runtimes/codex/login', getCodexLogin);

  const postCodexLogin = async (_req: unknown, res: Response) => {
    const { supported, image, ready } = await codexContext();
    // `supported` here IS `cfg.enabled` (see codexContext above) — host mode
    // gets the same 409 as the other Docker-only action routes.
    if (!supported) {
      return sendApiError(res, 409, 'SANDBOX_MODE_HOST', SANDBOX_MODE_HOST_MESSAGE);
    }
    if (!ready || !image) {
      return sendApiError(res, 503, 'SANDBOX_UNAVAILABLE', 'Docker/sandbox image chưa sẵn sàng.');
    }
    res.json(startCodexDeviceLogin(image));
  };
  app.post('/api/sandbox/codex-login', postCodexLogin);
  app.post('/api/sandbox/runtimes/codex/login', postCodexLogin);

  const cancelCodexLogin = (_req: unknown, res: Response) => {
    res.json(cancelCodexDeviceLogin());
  };
  app.delete('/api/sandbox/codex-login', cancelCodexLogin);
  app.post('/api/sandbox/runtimes/codex/login/cancel', cancelCodexLogin);

  const logoutCodex = async (_req: unknown, res: Response) => {
    const { supported, image, ready } = await codexContext();
    if (!supported) {
      return sendApiError(res, 409, 'SANDBOX_MODE_HOST', SANDBOX_MODE_HOST_MESSAGE);
    }
    if (!ready || !image) {
      return sendApiError(res, 503, 'SANDBOX_UNAVAILABLE', 'Docker/sandbox image chưa sẵn sàng.');
    }
    cancelCodexDeviceLogin();
    try {
      await clearSandboxRuntimeAuth(image, 'codex');
    } catch {
      // Missing volume is fine; logout is best-effort.
    }
    res.json({ ok: true });
  };
  app.post('/api/sandbox/codex-logout', logoutCodex);
  app.delete('/api/sandbox/runtimes/codex/auth', logoutCodex);
}
