// Agent-in-sandbox: spawn gated agent runs inside a throwaway
// `od-agent-sandbox` Docker container instead of as a host process
// (docs/agent-in-sandbox-spec-plan.md in the parent repo).
//
// The daemon↔agent protocol is pure stdio (stream-json over stdin/stdout), so
// `docker run -i` preserves it byte-for-byte — the only change at the spawn
// site is the command line. This module owns that translation:
//
//   - `shouldSandboxRun` — the gate (runtime + skill allowlists from prefs).
//   - `wrapInvocationInSandbox` — pure host→docker invocation rewrite. The
//     container sees exactly one RW project dir at /work/app (a CHILD of
//     /work so the toolkit at /work/node_modules keeps resolving), the shared
//     auth volume at /home/node/.claude, and a whitelist of env vars — the
//     host process env is never forwarded wholesale.
//   - probe/kill/sweep helpers for preflight, cancel, and orphan cleanup.
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { SandboxConfigPrefs } from './app-config.js';
import type {
  SandboxAccount,
  SandboxAccountsResponse,
  SandboxEmbeddedLoginStatus,
} from '@open-design/contracts';
import { SANDBOX_ACCOUNT_LABEL_RE } from '@open-design/contracts';

const execFileAsync = promisify(execFile);

export const SANDBOX_IMAGE_NAME = 'od-agent-sandbox';
export const SANDBOX_AUTH_VOLUME = 'od-claude-auth';
export const SANDBOX_CONTAINER_PREFIX = 'od-sbx-';
export const SANDBOX_LABEL_KEY = 'od.sandbox';
export const CONTAINER_PROJECT_DIR = '/work/app';
const CONTAINER_AUTH_DIR = '/home/node/.claude';
const CONTAINER_VITE_CACHE_DIR = '/work/.vite-cache';
const DOCKER_TIMEOUT_MS = 10_000;

export interface ResolvedSandboxConfig {
  enabled: boolean;
  runtimes: string[];
  skills: string[];
  timeoutMinutes: number;
  cpus: number;
  memoryGb: number;
}

/**
 * Default sandboxed skills = EVERYTHING (`'*'`). Since 2026-07-10 the sandbox
 * covers ALL runs of the gated runtimes — pipeline steps AND general chat /
 * Orbit / routine turns — so the host needs no Claude install at all: the CLI
 * lives in the od-agent-sandbox image and credentials in the od-claude-auth
 * volume. The daemon↔agent protocol is stdio, and every chat cwd mounts the
 * same way a pipeline cwd does. Known tradeoff: stdio MCP servers must be
 * baked into the image (`uvx mcp-atlassian` is; arbitrary host-configured
 * MCPs are not) and file references outside the project cwd are invisible to
 * the container. Narrow via prefs.skills / OD_SANDBOX_SKILLS to sandbox only
 * specific skills again.
 */
const DEFAULT_SANDBOX_SKILLS = ['*'];

/**
 * Prefs → effective config. `OD_SANDBOX=1|0` overrides the persisted
 * `enabled` flag for quick dev toggling without editing app-config.json.
 * A `'*'` entry in `runtimes`/`skills` matches everything.
 *
 * Packaged DEFAULTS (baked at build time, forwarded by apps/packaged as
 * spawn env): `OD_SANDBOX_DEFAULT=1` turns the sandbox on and
 * `OD_SANDBOX_SKILLS` (comma list, e.g. `*`) seeds the skill gate — but
 * ONLY while the user hasn't persisted their own prefs, so `od sandbox
 * disable` / an explicit app-config.json always wins over the baked default.
 */
export function resolveSandboxConfig(
  prefs: SandboxConfigPrefs | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSandboxConfig {
  // Default ON: this fork runs Claude through the Docker sandbox by default (no
  // enable toggle in the UI). Disabled only by an EXPLICIT opt-out —
  // prefs.enabled === false, or OD_SANDBOX=0 (escape hatch for a machine with no
  // Docker). OD_SANDBOX=1 still force-enables regardless of prefs.
  let enabled = prefs?.enabled !== false;
  if (env.OD_SANDBOX === '1') enabled = true;
  else if (env.OD_SANDBOX === '0') enabled = false;
  const envSkills = (env.OD_SANDBOX_SKILLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    enabled,
    runtimes: prefs?.runtimes?.length ? prefs.runtimes : ['claude'],
    skills: prefs?.skills?.length
      ? prefs.skills
      : envSkills.length
        ? envSkills
        : [...DEFAULT_SANDBOX_SKILLS],
    timeoutMinutes: prefs?.timeoutMinutes ?? 30,
    cpus: prefs?.cpus ?? 2,
    memoryGb: prefs?.memoryGb ?? 4,
  };
}

/**
 * The gate. Sandboxing is scoped per runtime AND per skill; the DEFAULT skill
 * scope is `'*'` — every run of a gated runtime (pipeline steps, general
 * chat, Orbit, routines) goes through the container. A user-persisted
 * `skills` list narrows it back to specific skills.
 */
export function shouldSandboxRun(input: {
  agentId: string | null | undefined;
  skillIds: readonly (string | null | undefined)[];
  cfg: ResolvedSandboxConfig;
}): boolean {
  const { agentId, skillIds, cfg } = input;
  if (!cfg.enabled) return false;
  if (!agentId) return false;
  if (!cfg.runtimes.includes('*') && !cfg.runtimes.includes(agentId)) return false;
  if (cfg.skills.includes('*')) return true;
  return skillIds.some((s) => typeof s === 'string' && cfg.skills.includes(s));
}

const sanitizeToken = (raw: string): string => raw.replace(/[^a-zA-Z0-9_.-]/g, '-');

export function sandboxContainerName(runId: string): string {
  return `${SANDBOX_CONTAINER_PREFIX}${sanitizeToken(runId)}`;
}

/** Read the image tag pinned by the skill's builder (sandbox/sandbox.version). */
export function sandboxImageTag(builderDir: string): string {
  const version = readFileSync(
    path.join(builderDir, 'sandbox', 'sandbox.version'),
    'utf8',
  ).trim();
  return `${SANDBOX_IMAGE_NAME}:${version}`;
}

/**
 * localhost/127.0.0.1 in a URL points at the container itself once inside
 * docker; the daemon must be reached through the host gateway alias instead.
 */
export function rewriteUrlForContainer(url: string): string {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '0.0.0.0' ||
      parsed.hostname === '::1'
    ) {
      parsed.hostname = 'host.docker.internal';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

// Env vars forwarded from the computed host agent env into the container.
// Whitelist-only: everything else (HOME, PATH, shell secrets, host paths)
// stays on the host. OD_DAEMON_URL / OD_PROJECT_DIR are rewritten, not copied.
const FORWARD_ENV_KEYS = [
  'OD_TOOL_TOKEN',
  // Claude runtime knobs the user may have configured via agentCliEnv; the
  // upstream spawn env already decided whether these should be present.
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
] as const;

export interface SandboxWrapInput {
  /** Binary name INSIDE the image (e.g. `claude`), not the host launch path. */
  agentBin: string;
  /** Agent CLI args from the runtime def's buildArgs — reused verbatim. */
  args: readonly string[];
  /** Fully-computed host agent env; only whitelisted keys are forwarded. */
  env: NodeJS.ProcessEnv;
  cwd: string;
  runId: string;
  projectId: string | null;
  daemonUrl: string;
  image: string;
  cfg: ResolvedSandboxConfig;
}

export function wrapInvocationInSandbox(input: SandboxWrapInput): {
  command: string;
  args: string[];
  containerName: string;
} {
  const { agentBin, args, env, cwd, runId, projectId, daemonUrl, image, cfg } = input;
  const containerName = sandboxContainerName(runId);
  const dockerArgs: string[] = [
    'run',
    '-i',
    '--rm',
    // PID 1 = tini so SIGTERM forwarding + zombie reaping work for the CLI.
    '--init',
    '--name', containerName,
    '--label', `${SANDBOX_LABEL_KEY}=1`,
    '--label', `od.run.id=${sanitizeToken(runId)}`,
    '-v', `${cwd}:${CONTAINER_PROJECT_DIR}`,
    '-v', `${SANDBOX_AUTH_VOLUME}:${CONTAINER_AUTH_DIR}`,
    '--tmpfs', '/tmp',
    '--pids-limit', '1024',
    '--cpus', String(cfg.cpus),
    '--memory', `${cfg.memoryGb}g`,
    // Explicit host-gateway alias: built in on Docker Desktop/OrbStack, and
    // this flag makes the same spelling work on Linux engines too.
    '--add-host', 'host.docker.internal:host-gateway',
    '-w', CONTAINER_PROJECT_DIR,
    '-e', `OD_DAEMON_URL=${rewriteUrlForContainer(daemonUrl)}`,
    '-e', `OD_PROJECT_DIR=${CONTAINER_PROJECT_DIR}`,
    '-e', 'UIREACT_IN_SANDBOX=1',
  ];
  if (projectId) {
    dockerArgs.push(
      '--label', `od.project.id=${sanitizeToken(projectId)}`,
      '-e', `OD_PROJECT_ID=${projectId}`,
      // Warm per-project vite cache survives across throwaway containers.
      '-v', `uireact-cache-${sanitizeToken(projectId)}:${CONTAINER_VITE_CACHE_DIR}`,
    );
  }
  for (const key of FORWARD_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value) dockerArgs.push('-e', `${key}=${value}`);
  }
  dockerArgs.push(image, agentBin, ...args);
  return { command: 'docker', args: dockerArgs, containerName };
}

// ── docker-side helpers (preflight, cancel, sweep, status) ───────────────────

async function docker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, { timeout: timeoutMs });
  return stdout.trim();
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

export async function dockerImagePresent(image: string): Promise<boolean> {
  try {
    await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    return true;
  } catch {
    return false;
  }
}

export async function dockerVolumePresent(volume: string): Promise<boolean> {
  try {
    await docker(['volume', 'inspect', '--format', '{{.Name}}', volume]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the shared auth volume holds Claude CLI credentials. Runs a
 * short-lived container to look inside the volume, so callers should treat
 * this as a slow probe (status command), not a per-spawn check.
 */
/**
 * Read the Claude CLI credentials JSON from the shared auth volume (where
 * `od sandbox login` stored them). Used by the usage meter when the sandbox
 * owns Claude runs — the OAuth token lives in the container volume, not on the
 * host keychain/file. Returns the raw file content, or null if unreadable.
 */
export async function readSandboxClaudeCredentials(image: string): Promise<string | null> {
  try {
    return await docker(
      [
        'run', '--rm',
        '-v', `${SANDBOX_AUTH_VOLUME}:${CONTAINER_AUTH_DIR}:ro`,
        '--entrypoint', 'cat',
        image,
        `${CONTAINER_AUTH_DIR}/.credentials.json`,
      ],
      30_000,
    );
  } catch {
    return null;
  }
}

/**
 * A credentials file counts as a login only when it actually carries a token.
 * The Claude CLI writes the `claudeAiOauth` skeleton with EMPTY strings before
 * the code exchange completes, so a size test (`test -s`) calls a failed login
 * a success — and then every later attempt "succeeds" instantly against that
 * hollow file, which is the shape of the stuck-login report.
 */
export function credentialsCarryToken(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth;
    return typeof oauth?.accessToken === 'string' && oauth.accessToken.length > 0;
  } catch {
    return false;
  }
}

export async function sandboxAuthLoggedIn(image: string): Promise<boolean> {
  return credentialsCarryToken(await readSandboxClaudeCredentials(image));
}

// ── Claude account switching ────────────────────────────────────────────────
// Several Claude logins live side by side in the SAME `od-claude-auth` volume:
// each saved login is `accounts/<label>.json`; the ACTIVE one is the volume's
// `.credentials.json` (what the Claude CLI reads). "Active account" is derived
// by byte-comparing each saved file against `.credentials.json` — robust even
// when someone re-ran `od sandbox login` without saving. All ops run a
// short-lived container mounting the volume read-write.

/** Validate a label; throws with a user-facing message on a bad one. */
function assertAccountLabel(label: string): void {
  if (!SANDBOX_ACCOUNT_LABEL_RE.test(label)) {
    throw new Error(
      'Tên account chỉ gồm chữ/số/gạch (_ -), 1–40 ký tự, không khoảng trắng.',
    );
  }
}

/** List saved accounts + which one is active (byte-match against the live creds). */
export async function listSandboxAccounts(image: string): Promise<SandboxAccountsResponse> {
  const script = [
    `cd ${CONTAINER_AUTH_DIR} 2>/dev/null || exit 0`,
    // Cùng luật với credentialsCarryToken(): file rỗng token = CHƯA đăng nhập.
    'loggedin=0; grep -q \'"accessToken"[[:space:]]*:[[:space:]]*"[^"]\' .credentials.json 2>/dev/null && loggedin=1',
    'active=""',
    'if [ "$loggedin" = 1 ]; then',
    '  for f in accounts/*.json; do [ -f "$f" ] || continue;',
    '    if cmp -s "$f" .credentials.json; then active=$(basename "$f" .json); fi; done',
    'fi',
    'echo "LOGGEDIN:$loggedin"',
    'echo "ACTIVE:$active"',
    'for f in accounts/*.json; do [ -f "$f" ] && basename "$f" .json; done',
    // Force a 0 exit: with no saved accounts the loop's last `[ -f ] && …`
    // evaluates false → exit 1 → docker() would throw and we'd wrongly report
    // "not logged in" even when .credentials.json exists.
    'exit 0',
  ].join('\n');
  let out = '';
  try {
    out = await docker(
      ['run', '--rm', '-v', `${SANDBOX_AUTH_VOLUME}:${CONTAINER_AUTH_DIR}`, '--entrypoint', 'sh', image, '-c', script],
      30_000,
    );
  } catch {
    return { supported: true, loggedIn: false, activeUnsaved: false, accounts: [] };
  }
  const lines = out.split('\n').map((l) => l.trim());
  const loggedIn = lines.some((l) => l === 'LOGGEDIN:1');
  const active = (lines.find((l) => l.startsWith('ACTIVE:')) ?? 'ACTIVE:').slice('ACTIVE:'.length);
  const labels = lines.filter((l) => l && !l.startsWith('LOGGEDIN:') && !l.startsWith('ACTIVE:'));
  const accounts: SandboxAccount[] = labels.map((label) => ({ label, active: label === active && active !== '' }));
  const activeUnsaved = loggedIn && active === '';
  return { supported: true, loggedIn, activeUnsaved, accounts };
}

/** Snapshot the CURRENT active login into accounts/<label>.json. */
export async function saveSandboxAccount(image: string, label: string): Promise<SandboxAccountsResponse> {
  assertAccountLabel(label);
  const script = [
    `cd ${CONTAINER_AUTH_DIR}`,
    // Không lưu bản rỗng token — đó là cách accounts/<label>.json thành rác.
    'grep -q \'"accessToken"[[:space:]]*:[[:space:]]*"[^"]\' .credentials.json 2>/dev/null || { echo "NO_ACTIVE" >&2; exit 3; }',
    'mkdir -p accounts',
    `cp .credentials.json "accounts/${label}.json"`,
  ].join('\n');
  await docker(
    ['run', '--rm', '-v', `${SANDBOX_AUTH_VOLUME}:${CONTAINER_AUTH_DIR}`, '--entrypoint', 'sh', image, '-c', script],
    30_000,
  ).catch(() => {
    throw new Error('Chưa đăng nhập Claude nào để lưu — chạy: od sandbox login trước.');
  });
  return listSandboxAccounts(image);
}

/** Make accounts/<label>.json the active login (copy over .credentials.json). */
export async function switchSandboxAccount(image: string, label: string): Promise<SandboxAccountsResponse> {
  assertAccountLabel(label);
  const script = [
    `cd ${CONTAINER_AUTH_DIR}`,
    `[ -f "accounts/${label}.json" ] || { echo "NO_SUCH" >&2; exit 4; }`,
    `cp "accounts/${label}.json" .credentials.json`,
  ].join('\n');
  await docker(
    ['run', '--rm', '-v', `${SANDBOX_AUTH_VOLUME}:${CONTAINER_AUTH_DIR}`, '--entrypoint', 'sh', image, '-c', script],
    30_000,
  ).catch(() => {
    throw new Error(`Không tìm thấy account "${label}".`);
  });
  return listSandboxAccounts(image);
}

/** The interactive Claude OAuth login command (runs the TUI inside the sandbox,
 *  writing credentials into the shared volume). Shared by the CLI and the
 *  "add account" terminal launcher. */
export function sandboxLoginCommand(image: string): string {
  return `docker run -it --rm -v ${SANDBOX_AUTH_VOLUME}:${CONTAINER_AUTH_DIR} ${image} claude /login`;
}

// The login TUI runs INSIDE the container, so its own "open browser" step
// can't reach the host — it only prints the OAuth URL. These helpers strip
// the TUI's ANSI codes, re-join the 80-column line wrapping and find the
// OAuth URL in raw pty output.
function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/\x1b[78]/g, '')
    .replace(/\r/g, '');
}

function extractOauthUrl(plain: string): string | null {
  return (
    (plain.match(/https:\/\/[^\s]+(?:\n[^\s]+)*/g) ?? [])
      .map((m) => m.replace(/\n/g, ''))
      .find((u) => /oauth/i.test(u)) ?? null
  );
}

function openHostBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      // `start` is a cmd builtin; the empty '' is its window-title slot.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Best-effort — the UI always shows the URL as a clickable fallback.
  }
}

// Terminal-login helper: poll the `script -q` mirror log of the login session
// and auto-open the OAuth URL in the host browser once it appears.
function watchLoginLogForOauthUrl(logPath: string): void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - startedAt > 5 * 60_000) {
      clearInterval(timer);
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(logPath, 'utf8');
    } catch {
      return; // log not written yet
    }
    const url = extractOauthUrl(stripAnsi(raw));
    if (!url) return;
    clearInterval(timer);
    openHostBrowser(url);
  }, 1000);
  timer.unref();
}

// ── Embedded (no-terminal) Claude login ─────────────────────────────────────
// Drives `claude /login` in the sandbox container through a container-side
// faked TTY (`script -qec`): the CLI pinned in the image renders a fixed
// prompt sequence (theme picker → login-method menu → OAuth URL → paste
// code), so the daemon walks it by sending Enter whenever the output settles
// with no URL yet, extracts the URL, opens the HOST browser, and pipes the
// user-pasted code back over stdin. Success = `.credentials.json` appears in
// the auth volume (same file the interactive flow writes), which the /login
// TUI persists — so accounts/switching keep working unchanged.

interface EmbeddedLoginSession {
  phase: SandboxEmbeddedLoginStatus['phase'];
  url: string | null;
  error: string | null;
  image: string;
  containerName: string;
  child: ChildProcess;
  buf: string;
  promptsSent: number;
  settleTimer: NodeJS.Timeout | null;
  verifyTimer: NodeJS.Timeout | null;
  deadline: NodeJS.Timeout;
}

let embeddedLogin: EmbeddedLoginSession | null = null;

const EMBEDDED_LOGIN_TIMEOUT_MS = 10 * 60_000;
const EMBEDDED_LOGIN_MAX_PROMPTS = 6;
const EMBEDDED_LOGIN_BUF_MAX = 256 * 1024;

export function getEmbeddedLoginStatus(): SandboxEmbeddedLoginStatus {
  if (!embeddedLogin) return { phase: 'idle', url: null, error: null };
  const { phase, url, error } = embeddedLogin;
  return { phase, url, error };
}

function teardownEmbeddedLogin(session: EmbeddedLoginSession): void {
  if (session.settleTimer) clearTimeout(session.settleTimer);
  if (session.verifyTimer) clearInterval(session.verifyTimer);
  clearTimeout(session.deadline);
  // Kill BOTH sides: the docker CLI child (frees stdio) and the container by
  // name with `rm -f` — a plain `kill` no-ops when the container hasn't
  // finished creating yet, which leaked zombies on rapid restart clicks.
  try {
    session.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  void docker(['rm', '-f', session.containerName], 10_000).catch(() => {});
}

/** rm -f every od.sandbox.login.* container. There is only ever ONE valid
 *  session, so at start-time anything matching the prefix is a leftover. */
async function sweepEmbeddedLoginContainers(): Promise<void> {
  try {
    const out = await docker(['ps', '-a', '--filter', 'name=od.sandbox.login.', '--format', '{{.Names}}']);
    for (const name of out.split('\n').filter(Boolean)) {
      await docker(['rm', '-f', name], 10_000).catch(() => {});
    }
  } catch {
    /* docker down — nothing to sweep */
  }
}

export function cancelEmbeddedLogin(): SandboxEmbeddedLoginStatus {
  if (embeddedLogin) {
    teardownEmbeddedLogin(embeddedLogin);
    embeddedLogin = null;
  }
  return getEmbeddedLoginStatus();
}

export function startEmbeddedLogin(image: string): SandboxEmbeddedLoginStatus {
  cancelEmbeddedLogin();
  void sweepEmbeddedLoginContainers();
  const containerName = `od.sandbox.login.${Date.now()}`;
  const child = spawn(
    'docker',
    [
      'run', '-i', '--rm',
      '--name', containerName,
      '-v', `${SANDBOX_AUTH_VOLUME}:${CONTAINER_AUTH_DIR}`,
      '--entrypoint', 'sh',
      image,
      '-c', 'script -qec "claude /login" /dev/null',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const session: EmbeddedLoginSession = {
    phase: 'starting',
    url: null,
    error: null,
    image,
    containerName,
    child,
    buf: '',
    promptsSent: 0,
    settleTimer: null,
    verifyTimer: null,
    deadline: setTimeout(() => {
      if (embeddedLogin === session && session.phase !== 'done') {
        session.phase = 'error';
        session.error = 'Quá thời gian đăng nhập (10 phút) — thử lại.';
        teardownEmbeddedLogin(session);
      }
    }, EMBEDDED_LOGIN_TIMEOUT_MS),
  };
  session.deadline.unref();
  embeddedLogin = session;

  // The TUI redraws constantly; treat 1.5s of output silence BEFORE the URL
  // as "a prompt is waiting" and answer it with Enter (theme picker and
  // login-method menu both take the default). Capped so an unexpected screen
  // can't be Enter-spammed forever.
  const scheduleNudge = () => {
    if (session.settleTimer) clearTimeout(session.settleTimer);
    session.settleTimer = setTimeout(() => {
      if (embeddedLogin !== session || session.phase !== 'starting') return;
      if (session.promptsSent >= EMBEDDED_LOGIN_MAX_PROMPTS) {
        session.phase = 'error';
        session.error = 'Không đi hết được các bước của trình đăng nhập — dùng cách mở Terminal.';
        teardownEmbeddedLogin(session);
        return;
      }
      session.promptsSent += 1;
      session.child.stdin?.write('\r');
      scheduleNudge();
    }, 1500);
    session.settleTimer.unref();
  };

  const onData = (chunk: Buffer) => {
    if (embeddedLogin !== session) return;
    session.buf = (session.buf + chunk.toString()).slice(-EMBEDDED_LOGIN_BUF_MAX);
    if (session.phase !== 'starting') return;
    const url = extractOauthUrl(stripAnsi(session.buf));
    if (url) {
      if (session.settleTimer) clearTimeout(session.settleTimer);
      session.phase = 'awaiting-code';
      session.url = url;
      openHostBrowser(url);
      return;
    }
    scheduleNudge();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (err) => {
    if (embeddedLogin !== session) return;
    session.phase = 'error';
    session.error = `Không chạy được docker: ${err.message}`;
    teardownEmbeddedLogin(session);
  });
  child.on('close', () => {
    if (embeddedLogin !== session) return;
    if (session.phase === 'done' || session.phase === 'error') return;
    // Container gone before we confirmed credentials — one last check (the
    // user may have finished right as the TUI exited).
    void sandboxAuthLoggedIn(session.image).then((ok) => {
      if (embeddedLogin !== session) return;
      if (ok) {
        session.phase = 'done';
      } else {
        session.phase = 'error';
        session.error = 'Phiên đăng nhập kết thúc trước khi hoàn tất — thử lại.';
      }
      teardownEmbeddedLogin(session);
    });
  });
  scheduleNudge();
  return getEmbeddedLoginStatus();
}

export function submitEmbeddedLoginCode(code: string): SandboxEmbeddedLoginStatus {
  const session = embeddedLogin;
  if (!session || session.phase !== 'awaiting-code') {
    throw new Error('Chưa ở bước dán mã — bấm Đăng nhập trước.');
  }
  const trimmed = code.trim();
  if (!trimmed) throw new Error('Mã trống.');
  session.error = null;
  session.phase = 'verifying';
  session.child.stdin?.write(`${trimmed}\r`);
  // Success criterion is the volume, not the TUI: poll for .credentials.json
  // (what /login persists). Post-code screens ("Login successful — press
  // Enter", security notes) can sit between token exchange and persistence,
  // so a few blind Enters walk past them (harmless at a re-prompt: they just
  // submit empty input). Rejected/stale code → drop back to awaiting-code
  // with an error so the user can re-paste without restarting the session.
  const startedAt = Date.now();
  let ticks = 0;
  session.verifyTimer = setInterval(() => {
    if (embeddedLogin !== session) return;
    ticks += 1;
    if (ticks % 2 === 0 && ticks <= 10) session.child.stdin?.write('\r');
    void sandboxAuthLoggedIn(session.image).then((ok) => {
      if (embeddedLogin !== session || session.phase !== 'verifying') return;
      if (ok) {
        session.phase = 'done';
        teardownEmbeddedLogin(session);
        return;
      }
      if (Date.now() - startedAt > 90_000) {
        if (session.verifyTimer) clearInterval(session.verifyTimer);
        session.verifyTimer = null;
        session.phase = 'awaiting-code';
        session.error =
          'Mã chưa được chấp nhận. Lưu ý: mã phải lấy từ trang đăng nhập MỚI NHẤT vừa mở (mỗi lần bấm Đăng nhập lại là mã cũ hết hiệu lực) — mở lại trang bằng link ở trên rồi dán mã mới.';
      }
    });
  }, 2000);
  session.verifyTimer.unref();
  return getEmbeddedLoginStatus();
}

/**
 * Best-effort: open a HOST terminal window running the interactive Claude login
 * (a full-screen TUI that can't be embedded in the web UI). Returns whether a
 * window was opened; the caller shows the raw command as a copy-paste fallback.
 * On macOS the session is mirrored to a log so the daemon can auto-open the
 * OAuth URL in the host browser (see watchLoginLogForOauthUrl).
 */
export function openSandboxLoginTerminal(image: string): { launched: boolean; command: string; message?: string } {
  const command = sandboxLoginCommand(image);
  try {
    if (process.platform === 'darwin') {
      const id = Date.now();
      const logPath = path.join(tmpdir(), `od-sandbox-login-${id}.log`);
      const wrapped = `script -q ${JSON.stringify(logPath)} ${command}`;
      // Launch via a .command file + open(1), NOT osascript: AppleEvents
      // automation ("control Terminal") needs a privacy permission, and when
      // it's denied the Terminal window opens EMPTY with no command run —
      // silently. Terminal executes an opened .command file without any
      // automation permission.
      const cmdPath = path.join(tmpdir(), `od-sandbox-login-${id}.command`);
      writeFileSync(
        cmdPath,
        `#!/bin/zsh\nclear\necho "Đăng nhập Claude — làm theo hướng dẫn bên dưới; trình duyệt sẽ tự mở."\n${wrapped}\n`,
        { mode: 0o755 },
      );
      spawn('open', [cmdPath], { detached: true, stdio: 'ignore' }).unref();
      watchLoginLogForOauthUrl(logPath);
      return {
        launched: true,
        command,
        message:
          'Đã mở Terminal — trình duyệt sẽ tự bật trang đăng nhập sau vài giây; xác nhận ở đó rồi dán mã vào Terminal, xong quay lại Lưu.',
      };
    }
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'cmd', '/k', command], { detached: true, stdio: 'ignore' }).unref();
      return { launched: true, command, message: 'Đã mở cửa sổ lệnh — hoàn tất đăng nhập rồi quay lại Lưu.' };
    }
    // Linux: try the common terminal emulators, first hit wins.
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
      try {
        spawn(term, ['-e', 'sh', '-c', `${command}; exec sh`], { detached: true, stdio: 'ignore' }).unref();
        return { launched: true, command, message: 'Đã mở terminal — hoàn tất đăng nhập rồi quay lại Lưu.' };
      } catch {
        /* try the next emulator */
      }
    }
    return { launched: false, command, message: 'Không mở được terminal — chạy lệnh này thủ công rồi quay lại Lưu.' };
  } catch {
    return { launched: false, command, message: 'Không mở được terminal — chạy lệnh này thủ công rồi quay lại Lưu.' };
  }
}

/** Delete a saved account (does NOT touch the active login). */
export async function removeSandboxAccount(image: string, label: string): Promise<SandboxAccountsResponse> {
  assertAccountLabel(label);
  const script = `rm -f ${CONTAINER_AUTH_DIR}/accounts/${label}.json`;
  await docker(
    ['run', '--rm', '-v', `${SANDBOX_AUTH_VOLUME}:${CONTAINER_AUTH_DIR}`, '--entrypoint', 'sh', image, '-c', script],
    30_000,
  );
  return listSandboxAccounts(image);
}

/** Read a SAVED account's credentials JSON (accounts/<label>.json) from the auth
 *  volume, or null if missing/unreadable — used to probe that account's token. */
export async function readSandboxAccountCredentials(image: string, label: string): Promise<string | null> {
  assertAccountLabel(label);
  try {
    return await docker(
      [
        'run', '--rm',
        '-v', `${SANDBOX_AUTH_VOLUME}:${CONTAINER_AUTH_DIR}:ro`,
        '--entrypoint', 'cat',
        image,
        `${CONTAINER_AUTH_DIR}/accounts/${label}.json`,
      ],
      30_000,
    );
  } catch {
    return null;
  }
}

export interface SandboxRuntimeStatus {
  dockerRunning: boolean;
  imagePresent: boolean;
  authLoggedIn: boolean;
  /** First line of `<agentBin> --version` run INSIDE the image, when probeable. */
  version: string | null;
}

/**
 * Full sandbox-side availability picture for a runtime — what "Local CLI"
 * detection reports when the sandbox owns this runtime's runs (the host
 * binary is irrelevant then). Runs a short-lived container for the version
 * probe, so callers should cache (detectAgents already does).
 */
export async function sandboxRuntimeStatus(
  image: string,
  agentBin = 'claude',
): Promise<SandboxRuntimeStatus> {
  if (!(await dockerAvailable())) {
    return { dockerRunning: false, imagePresent: false, authLoggedIn: false, version: null };
  }
  if (!(await dockerImagePresent(image))) {
    return { dockerRunning: true, imagePresent: false, authLoggedIn: false, version: null };
  }
  const [authLoggedIn, version] = await Promise.all([
    sandboxAuthLoggedIn(image),
    docker(['run', '--rm', image, agentBin, '--version'], 30_000)
      .then((out) => out.split('\n')[0] ?? null)
      .catch(() => null),
  ]);
  return { dockerRunning: true, imagePresent: true, authLoggedIn, version };
}

export async function killSandboxContainer(containerName: string): Promise<boolean> {
  try {
    await docker(['kill', containerName]);
    return true;
  } catch {
    return false;
  }
}

export async function listSandboxContainers(): Promise<string[]> {
  try {
    const out = await docker([
      'ps', '--filter', `label=${SANDBOX_LABEL_KEY}=1`, '--format', '{{.Names}}',
    ]);
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Kill sandbox containers left over from a previous daemon process. Run state
 * is in-memory, so at daemon startup EVERY live od.sandbox container is an
 * orphan (its run died with the old process). Best-effort: docker being down
 * just means there is nothing to sweep.
 */
export async function sweepOrphanSandboxContainers(): Promise<string[]> {
  const names = await listSandboxContainers();
  const killed: string[] = [];
  for (const name of names) {
    if (await killSandboxContainer(name)) killed.push(name);
  }
  return killed;
}

export interface SandboxPreflightResult {
  ok: boolean;
  /** Human-actionable reason when not ok (surfaced over SSE). */
  reason?: string;
}

/**
 * Fast per-spawn checks (docker + image + auth volume existence — no
 * container start). Failing preflight FAILS the run loudly; silently falling
 * back to host spawn would drop the security boundary without anyone
 * noticing.
 */
export async function sandboxPreflight(image: string): Promise<SandboxPreflightResult> {
  if (!(await dockerAvailable())) {
    return {
      ok: false,
      reason: 'Docker is not running. Start Docker/OrbStack, or disable the agent sandbox (od sandbox disable).',
    };
  }
  if (!(await dockerImagePresent(image))) {
    return {
      ok: false,
      reason: `Sandbox image ${image} is missing. Build it with: od sandbox build`,
    };
  }
  if (!(await dockerVolumePresent(SANDBOX_AUTH_VOLUME))) {
    return {
      ok: false,
      reason: `Sandbox auth volume ${SANDBOX_AUTH_VOLUME} is missing. Log in once with: od sandbox login`,
    };
  }
  return { ok: true };
}

// The docker --platform for a NATIVE build (no QEMU): arm64 host → linux/arm64,
// everything else (Intel mac / Windows / Linux x64) → linux/amd64. Mirrors the
// builder scripts' `uname -m` logic; OD_DOCKER_PLATFORM overrides.
function nativeDockerPlatform(): string {
  const override = (process.env.OD_DOCKER_PLATFORM ?? '').trim();
  if (override) return override;
  return process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
}

// One long docker command (build/pull) streamed line-by-line to `onLog`
// (these take minutes, so no capture-with-timeout). Rejects on non-zero exit.
function dockerStream(argv: string[], onLog?: (line: string) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const pipe = (buf: Buffer) => onLog?.(buf.toString());
    child.stdout?.on('data', pipe);
    child.stderr?.on('data', pipe);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker ${argv[0]} exited ${code}`));
    });
  });
}

// ── Registry pull-first ──────────────────────────────────────────────────────
// The sandbox images are published multi-arch to a PUBLIC registry (GHCR, see
// skills/ui-react/builder/push-ghcr.sh) so a fresh machine downloads them
// instead of running a 10-minute local docker build. The registry lives in the
// `registry` pin file next to the version pins; OD_SANDBOX_REGISTRY overrides
// it, and the value `off` (or an empty/missing pin) disables pulls entirely.
function resolveSandboxRegistry(builderDir: string): string | null {
  const override = (process.env.OD_SANDBOX_REGISTRY ?? '').trim();
  if (override) return override.toLowerCase() === 'off' ? null : override.replace(/\/+$/, '');
  try {
    const pinned = readFileSync(path.join(builderDir, 'registry'), 'utf8').trim();
    return pinned ? pinned.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

/** `docker pull` a published image and re-tag it under the local names the
 *  rest of the sandbox code expects. Any failure (offline, package private,
 *  tag not pushed yet) returns false — the caller falls back to building. */
async function tryPullRemoteImage(
  remoteRef: string,
  platform: string,
  localTags: string[],
  onLog?: (line: string) => void,
): Promise<boolean> {
  try {
    onLog?.(`[sandbox] pulling ${remoteRef} (${platform})…\n`);
    await dockerStream(['pull', '--platform', platform, remoteRef], onLog);
    for (const tag of localTags) await docker(['tag', remoteRef, tag]);
    return true;
  } catch (err) {
    onLog?.(
      `[sandbox] pull ${remoteRef} failed (${err instanceof Error ? err.message : String(err)}) — falling back to a local build.\n`,
    );
    return false;
  }
}

// Single-flight per image so concurrent spawns (run-all, parallel runs) don't
// race the same build.
const sandboxBuildInFlight = new Map<string, Promise<SandboxPreflightResult>>();

/**
 * Ensure the sandbox image exists: PULL the published image from the pinned
 * public registry first (seconds-to-minutes, no toolchain needed), and only
 * fall back to BUILDING it in-process (direct `docker build`, no bash — works
 * on Windows without Git Bash) when the pull fails. This is the first-run
 * auto-provision so a fresh machine doesn't hard-fail preflight with "image is
 * missing". Requires Docker to be running (caller checks / build fails loudly
 * otherwise). The build path creates `uireact-base:<toolkit>` first when
 * absent, then the sandbox image, both at the host's NATIVE arch. Returns ok
 * when the image is present after the attempt. The auth volume (interactive
 * OAuth) is NOT auto-created — that stays a manual `od sandbox login`.
 */
export async function ensureSandboxImage(
  builderDir: string,
  image: string,
  onLog?: (line: string) => void,
): Promise<SandboxPreflightResult> {
  if (await dockerImagePresent(image)) return { ok: true };
  const existing = sandboxBuildInFlight.get(image);
  if (existing) return existing;
  const task = (async (): Promise<SandboxPreflightResult> => {
    try {
      const platform = nativeDockerPlatform();
      const toolkit = readFileSync(path.join(builderDir, 'base', 'toolkit.version'), 'utf8').trim();
      const claude = readFileSync(path.join(builderDir, 'sandbox', 'claude.version'), 'utf8').trim();
      const baseImage = `uireact-base:${toolkit}`;

      // Pull-first: grab the published images off the public registry. The
      // base image is best-effort (ui-react per-project builds want it, but
      // the sandbox image alone unblocks agent runs — build.sh builds the
      // base lazily if it's still missing when first needed).
      const registry = resolveSandboxRegistry(builderDir);
      if (registry) {
        await tryPullRemoteImage(
          `${registry}/${image}`,
          platform,
          [image, `${SANDBOX_IMAGE_NAME}:latest`],
          onLog,
        );
        if (!(await dockerImagePresent(baseImage))) {
          await tryPullRemoteImage(
            `${registry}/${baseImage}`,
            platform,
            [baseImage, 'uireact-base:latest'],
            onLog,
          );
        }
        if (await dockerImagePresent(image)) return { ok: true };
      }

      if (!(await dockerImagePresent(baseImage))) {
        onLog?.(`[sandbox] auto-building ${baseImage} (${platform}) — first run, a few minutes…\n`);
        await dockerStream(
          ['build', '--platform', platform, '-t', baseImage, '-t', 'uireact-base:latest', '-f', path.join(builderDir, 'Dockerfile'), builderDir],
          onLog,
        );
      }
      onLog?.(`[sandbox] auto-building ${image} (${platform})…\n`);
      await dockerStream(
        [
          'build',
          '--platform', platform,
          '--build-arg', `TOOLKIT_VERSION=${toolkit}`,
          '--build-arg', `CLAUDE_CODE_VERSION=${claude}`,
          '-t', image,
          '-t', `${SANDBOX_IMAGE_NAME}:latest`,
          '-f', path.join(builderDir, 'sandbox', 'Dockerfile'),
          path.join(builderDir, 'sandbox'),
        ],
        onLog,
      );
      if (await dockerImagePresent(image)) return { ok: true };
      return { ok: false, reason: `Sandbox image ${image} build finished but the image is still missing.` };
    } catch (err) {
      return {
        ok: false,
        reason: `Auto-building sandbox image ${image} failed (${err instanceof Error ? err.message : String(err)}). Build it manually: od sandbox build.`,
      };
    } finally {
      sandboxBuildInFlight.delete(image);
    }
  })();
  sandboxBuildInFlight.set(image, task);
  return task;
}
