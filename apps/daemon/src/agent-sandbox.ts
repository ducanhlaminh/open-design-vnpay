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
//     /work so the toolkit at /work/node_modules keeps resolving), the
//     runtime-specific auth volume (/home/node/.claude or /home/node/.codex),
//     and a whitelist of env vars — the host process env is never forwarded
//     wholesale.
//   - probe/kill/sweep helpers for preflight, cancel, and orphan cleanup.
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { SandboxConfigPrefs } from './app-config.js';
import type {
  SandboxAccount,
  SandboxAccountIdentity,
  SandboxAccountsResponse,
  SandboxEmbeddedLoginStatus,
} from '@open-design/contracts';
import {
  SANDBOX_ACCOUNT_LABEL_RE,
  sandboxAccountLabelFromEmail,
} from '@open-design/contracts';

const execFileAsync = promisify(execFile);

export const SANDBOX_IMAGE_NAME = 'od-agent-sandbox';
export const SANDBOX_CONTAINER_PREFIX = 'od-sbx-';
export const SANDBOX_LABEL_KEY = 'od.sandbox';
export const CONTAINER_PROJECT_DIR = '/work/app';
const CONTAINER_VITE_CACHE_DIR = '/work/.vite-cache';
const DOCKER_TIMEOUT_MS = 10_000;

export type SandboxRuntimeId = 'claude' | 'codex';
export type SandboxAuthState = 'logged-in' | 'missing' | 'unknown';

interface SandboxRuntimeSpec {
  authVolume: string;
  authDir: string;
  authFile: string;
  loginCommand: readonly string[];
  versionBin: string;
  forcedEnv: Readonly<Record<string, string>>;
  forwardedEnvKeys: readonly string[];
}

const SANDBOX_RUNTIME_SPECS = {
  claude: {
    authVolume: 'od-claude-auth',
    authDir: '/home/node/.claude',
    authFile: '.credentials.json',
    loginCommand: ['claude', '/login'] as const,
    versionBin: 'claude',
    forcedEnv: {
      CLAUDE_CONFIG_DIR: '/home/node/.claude',
    },
    forwardedEnvKeys: ['OD_TOOL_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'] as const,
  },
  codex: {
    authVolume: 'od-codex-auth',
    authDir: '/home/node/.codex',
    authFile: 'auth.json',
    loginCommand: ['codex', 'login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'] as const,
    versionBin: 'codex',
    forcedEnv: {
      CODEX_HOME: '/home/node/.codex',
    },
    forwardedEnvKeys: ['OD_TOOL_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY'] as const,
  },
} as const satisfies Record<SandboxRuntimeId, SandboxRuntimeSpec>;

export const SANDBOX_CLAUDE_AUTH_VOLUME = SANDBOX_RUNTIME_SPECS.claude.authVolume;
export const SANDBOX_CODEX_AUTH_VOLUME = SANDBOX_RUNTIME_SPECS.codex.authVolume;
export const SANDBOX_AUTH_VOLUME = SANDBOX_CLAUDE_AUTH_VOLUME;
export const CONTAINER_CLAUDE_AUTH_DIR = SANDBOX_RUNTIME_SPECS.claude.authDir;
export const CONTAINER_CODEX_AUTH_DIR = SANDBOX_RUNTIME_SPECS.codex.authDir;
const CONTAINER_AUTH_DIR = CONTAINER_CLAUDE_AUTH_DIR;

function sandboxRuntimeSpec(runtimeId: SandboxRuntimeId): SandboxRuntimeSpec {
  return SANDBOX_RUNTIME_SPECS[runtimeId];
}

export function sandboxAuthVolume(runtimeId: SandboxRuntimeId): string {
  return sandboxRuntimeSpec(runtimeId).authVolume;
}

export function sandboxAuthDir(runtimeId: SandboxRuntimeId): string {
  return sandboxRuntimeSpec(runtimeId).authDir;
}

export function sandboxAuthFile(runtimeId: SandboxRuntimeId): string {
  return sandboxRuntimeSpec(runtimeId).authFile;
}

export function sandboxRuntimeLoginCommand(runtimeId: SandboxRuntimeId, image: string): string {
  const spec = sandboxRuntimeSpec(runtimeId);
  const forcedEnv = Object.entries(spec.forcedEnv)
    .map(([key, value]) => `-e ${key}=${value}`)
    .join(' ');
  return `docker run -it --rm -v ${spec.authVolume}:${spec.authDir} ${forcedEnv} ${image} ${spec.loginCommand.join(' ')}`;
}

export function sandboxRuntimeVersionBin(runtimeId: SandboxRuntimeId): string {
  return sandboxRuntimeSpec(runtimeId).versionBin;
}

export function sandboxRuntimeForwardedEnvKeys(runtimeId: SandboxRuntimeId): readonly string[] {
  return sandboxRuntimeSpec(runtimeId).forwardedEnvKeys;
}

export function sandboxRuntimeForcedEnv(runtimeId: SandboxRuntimeId): Readonly<Record<string, string>> {
  return sandboxRuntimeSpec(runtimeId).forcedEnv;
}

export function sandboxCodexProfileName(runId: string): string {
  return `od-${sanitizeToken(runId)}-mcp`;
}

export function sandboxCodexProfilePath(profileName: string): string {
  const safeName = sanitizeToken(profileName);
  if (!safeName) {
    throw new Error('Invalid Codex profile name.');
  }
  return path.posix.join(CONTAINER_CODEX_AUTH_DIR, `${safeName}.config.toml`);
}

export function buildSandboxCodexProfileMaterializationScript(
  profileName: string,
  encodedToml: string,
): string {
  const safeName = sanitizeToken(profileName);
  if (!safeName) {
    throw new Error('Invalid Codex profile name.');
  }
  const finalPath = sandboxCodexProfilePath(safeName);
  const lockDir = path.posix.join(CONTAINER_CODEX_AUTH_DIR, `.${safeName}.lock`);
  return [
    'set -eu',
    `cd ${JSON.stringify(CONTAINER_CODEX_AUTH_DIR)}`,
    `final=${JSON.stringify(finalPath)}`,
    `lockdir=${JSON.stringify(lockDir)}`,
    'tmp="$(mktemp ./.codex-profile.XXXXXX)"',
    'cleanup() { rm -f "$tmp"; rmdir "$lockdir" 2>/dev/null || true; }',
    'trap cleanup EXIT INT TERM',
    'while ! mkdir "$lockdir" 2>/dev/null; do sleep 0.2; done',
    `echo '${encodedToml}' | base64 -d > "$tmp"`,
    'mv -f "$tmp" "$final"',
    'rmdir "$lockdir"',
  ].join('\n');
}

export async function materializeSandboxCodexProfile(
  image: string,
  profileName: string,
  toml: string,
): Promise<void> {
  const encodedToml = Buffer.from(toml, 'utf8').toString('base64');
  const script = buildSandboxCodexProfileMaterializationScript(profileName, encodedToml);
  await docker(
    [
      'run',
      '--rm',
      '-v',
      `${SANDBOX_CODEX_AUTH_VOLUME}:${CONTAINER_CODEX_AUTH_DIR}`,
      '--entrypoint',
      'sh',
      image,
      '-c',
      script,
    ],
    30_000,
  );
}

export async function removeSandboxCodexProfile(image: string, profileName: string): Promise<void> {
  const profilePath = sandboxCodexProfilePath(profileName);
  await docker(
    [
      'run', '--rm',
      '-v', `${SANDBOX_CODEX_AUTH_VOLUME}:${CONTAINER_CODEX_AUTH_DIR}`,
      '--entrypoint', 'rm', image, '-f', profilePath,
    ],
    30_000,
  );
}

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
 * Skill gates that USED to be the default. Earlier builds shipped a narrower
 * default (first `['ui-react']`, then the five docs→output pipeline steps) and
 * older daemons persisted the resolved default straight into app-config.json,
 * so a config carrying exactly one of these lists means "nobody ever chose
 * this" — it is a leftover from before the gate became `'*'`.
 *
 * Left alone, such a leftover silently downgrades the WHOLE app to host mode:
 * `/api/agents` and `/api/usage/claude` both key off `skills.includes('*')`, so
 * the picker starts probing host binaries (every host CLI shows up instead of
 * just "Claude · Docker") and the quota meter reports the host account instead
 * of the od-claude-auth volume — while only the listed skills actually run in
 * Docker. Treating these values as unset restores the current default. A gate
 * that is genuinely narrow (any other list) is still honored; use
 * OD_SANDBOX_SKILLS to pin one of these values on purpose.
 */
const LEGACY_DEFAULT_SKILL_GATES: readonly (readonly string[])[] = [
  ['ui-react'],
  [
    'jira-ingest',
    'customer-journey-spec',
    'ux-spec',
    'ui-react',
    'html-interactive-prototype',
  ],
];

/** Warn once per process — resolveSandboxConfig runs on nearly every request. */
let warnedLegacySkillGate = false;

function isLegacyDefaultSkillGate(skills: readonly string[]): boolean {
  return LEGACY_DEFAULT_SKILL_GATES.some(
    (legacy) =>
      legacy.length === skills.length && legacy.every((id) => skills.includes(id)),
  );
}

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
  const persistedSkills = prefs?.skills?.length ? prefs.skills : null;
  const staleSkills = persistedSkills !== null && isLegacyDefaultSkillGate(persistedSkills);
  if (staleSkills && persistedSkills && !warnedLegacySkillGate) {
    warnedLegacySkillGate = true;
    console.warn(
      `[sandbox] ignoring legacy skill gate [${persistedSkills.join(', ')}] from app-config.json — ` +
        'it is an old default and would move CLI detection + the Claude quota meter back to the host. ' +
        `Using [${DEFAULT_SANDBOX_SKILLS.join(', ')}]; set OD_SANDBOX_SKILLS to pin a narrow gate.`,
    );
  }
  return {
    enabled,
    // `['claude']` was the old persisted default before Codex shipped. Treat
    // that exact value as legacy so existing installs gain the new runtime;
    // explicit narrow runtime selection can still use the environment/config
    // after migration support is removed in a later release.
    runtimes:
      prefs?.runtimes?.length && !(prefs.runtimes.length === 1 && prefs.runtimes[0] === 'claude')
        ? prefs.runtimes
        : ['claude', 'codex'],
    skills:
      persistedSkills && !staleSkills
        ? persistedSkills
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
  runtimeId?: SandboxRuntimeId;
}

export function wrapInvocationInSandbox(input: SandboxWrapInput): {
  command: string;
  args: string[];
  containerName: string;
} {
  const {
    agentBin,
    args,
    env,
    cwd,
    runId,
    projectId,
    daemonUrl,
    image,
    cfg,
    runtimeId = 'claude',
  } = input;
  const spec = sandboxRuntimeSpec(runtimeId);
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
    '-v', `${spec.authVolume}:${spec.authDir}`,
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
  for (const [key, value] of Object.entries(spec.forcedEnv)) {
    dockerArgs.push('-e', `${key}=${value}`);
  }
  for (const key of sandboxRuntimeForwardedEnvKeys(runtimeId)) {
    const value = env[key];
    if (typeof value === 'string' && value) dockerArgs.push('-e', `${key}=${value}`);
  }
  const containerArgs = [...args];
  if (runtimeId === 'codex') {
    // buildArgs runs on the host before the Docker decision, so Codex's `-C`
    // and `--add-dir` values contain host paths. Rewrite them to the mounted
    // Linux paths; passing `/Users/...` or `C:\\...` into the container makes
    // Codex exit immediately with `No such file or directory (os error 2)`.
    let externalDirIndex = 0;
    for (let index = 0; index < containerArgs.length - 1; index += 1) {
      const flag = containerArgs[index];
      if (flag === '-C' || flag === '--cd') {
        containerArgs[index + 1] = CONTAINER_PROJECT_DIR;
        index += 1;
        continue;
      }
      if (flag !== '--add-dir') continue;
      const hostDir = containerArgs[index + 1];
      if (!hostDir) continue;
      const relative = path.relative(cwd, hostDir);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        containerArgs[index + 1] = relative
          ? path.posix.join(CONTAINER_PROJECT_DIR, ...relative.split(path.sep))
          : CONTAINER_PROJECT_DIR;
      } else {
        const containerDir = `/work/extra-${externalDirIndex}`;
        externalDirIndex += 1;
        dockerArgs.push('-v', `${hostDir}:${containerDir}`);
        containerArgs[index + 1] = containerDir;
      }
      index += 1;
    }
    const sandboxFlag = containerArgs.indexOf('--sandbox');
    if (sandboxFlag >= 0 && containerArgs[sandboxFlag + 1] === 'danger-full-access') {
      containerArgs[sandboxFlag + 1] = 'workspace-write';
    }
    if (!containerArgs.includes('sandbox_workspace_write.network_access=true')) {
      containerArgs.push('-c', 'sandbox_workspace_write.network_access=true');
    }
  }
  dockerArgs.push(image, agentBin, ...containerArgs);
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
 * Read a runtime's credential file from its sandbox auth volume. This is a
 * slow probe by design: it shells into the short-lived sandbox image rather
 * than trying to inspect the host's Docker volume API surface.
 */
export async function readSandboxRuntimeCredentials(
  image: string,
  runtimeId: SandboxRuntimeId,
): Promise<string | null> {
  const spec = sandboxRuntimeSpec(runtimeId);
  try {
    return await docker(
      [
        'run', '--rm',
        '-v', `${spec.authVolume}:${spec.authDir}:ro`,
        '--entrypoint', 'cat',
        image,
        `${spec.authDir}/${spec.authFile}`,
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

export function sandboxRuntimeAuthStateFromRaw(
  runtimeId: SandboxRuntimeId,
  raw: string | null,
): SandboxAuthState {
  if (!raw) return 'missing';
  try {
    if (runtimeId === 'claude') {
      return credentialsCarryToken(raw) ? 'logged-in' : 'missing';
    }
    const parsed = JSON.parse(raw) as {
      tokens?: { access_token?: unknown };
      OPENAI_API_KEY?: unknown;
    };
    const oauthToken =
      typeof parsed.tokens?.access_token === 'string' && parsed.tokens.access_token.length > 0
        ? parsed.tokens.access_token
        : typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0
          ? parsed.OPENAI_API_KEY
          : '';
    return oauthToken ? 'logged-in' : 'missing';
  } catch {
    return 'unknown';
  }
}

export async function probeSandboxRuntimeAuthState(
  image: string,
  runtimeId: SandboxRuntimeId,
): Promise<SandboxAuthState> {
  const raw = await readSandboxRuntimeCredentials(image, runtimeId);
  return sandboxRuntimeAuthStateFromRaw(runtimeId, raw);
}

/** Backwards-compatible Claude probe used by the existing routes. */
export async function readSandboxClaudeCredentials(image: string): Promise<string | null> {
  return readSandboxRuntimeCredentials(image, 'claude');
}

/** Backwards-compatible Claude auth check used by the existing routes. */
export async function sandboxAuthLoggedIn(image: string): Promise<boolean> {
  return (await probeSandboxRuntimeAuthState(image, 'claude')) === 'logged-in';
}

export async function readSandboxCodexCredentials(image: string): Promise<string | null> {
  return readSandboxRuntimeCredentials(image, 'codex');
}

export async function sandboxCodexAuthLoggedIn(image: string): Promise<boolean> {
  return (await probeSandboxRuntimeAuthState(image, 'codex')) === 'logged-in';
}

/**
 * How recent `oauthAccount.profileFetchedAt` must be for the profile to be
 * trusted as describing the login we just detected. See the guard note on
 * `readSandboxClaudeIdentity`.
 */
export const SANDBOX_IDENTITY_MAX_AGE_MS = 15 * 60_000;

/**
 * Who the ACTIVE login belongs to, read from the volume's `.claude.json`
 * (`oauthAccount`) — email + a stable `accountUuid`. This is what lets a login
 * be saved under a meaningful name without asking the user to invent one.
 *
 * The trap: `.claude.json` is ONE file for the whole volume, not one per
 * account. Switching accounts only swaps `.credentials.json`, so the profile
 * keeps describing the PREVIOUS account until the CLI refreshes it — and a
 * naive read would file a login under someone else's name.
 *
 * The guard is a freshness window on `profileFetchedAt`, NOT a comparison
 * against `.credentials.json`'s mtime. Measured on a real volume, those two
 * clocks legitimately drift far apart: `profileFetchedAt` is when the profile
 * was last fetched FROM THE SERVER (it moves on login), while the credentials
 * file is rewritten on every token refresh — observed 04:06 vs 08:41 for one
 * healthy, correctly-identified account. Comparing them rejects the ordinary
 * steady state.
 *
 * Callers only ask right after observing a login, and a login is exactly when
 * the CLI re-fetches the profile — so "fetched within the last few minutes"
 * means "fetched for the login in front of us". Anything older returns null and
 * the caller falls back to asking the user for a name; mislabelling someone
 * else's account is worse than one naming prompt.
 */
export async function readSandboxClaudeIdentity(
  image: string,
  nowMs: number = Date.now(),
): Promise<SandboxAccountIdentity | null> {
  let out: string;
  try {
    out = await docker(
      [
        'run', '--rm',
        '-v', `${SANDBOX_AUTH_VOLUME}:${CONTAINER_AUTH_DIR}:ro`,
        '--entrypoint', 'cat',
        image,
        `${CONTAINER_AUTH_DIR}/.claude.json`,
      ],
      30_000,
    );
  } catch {
    return null;
  }
  return parseSandboxIdentity(out, nowMs);
}

/** Parse `.claude.json` and apply the freshness guard. Exported for tests. */
export function parseSandboxIdentity(
  raw: string,
  nowMs: number = Date.now(),
): SandboxAccountIdentity | null {
  let account: Record<string, unknown> | undefined;
  try {
    account = (JSON.parse(raw) as { oauthAccount?: Record<string, unknown> }).oauthAccount;
  } catch {
    return null; // missing, truncated, or not JSON
  }
  const accountUuid = typeof account?.accountUuid === 'string' ? account.accountUuid : '';
  const emailAddress = typeof account?.emailAddress === 'string' ? account.emailAddress : '';
  if (!accountUuid || !emailAddress) return null;

  const fetchedAt = typeof account?.profileFetchedAt === 'number' ? account.profileFetchedAt : 0;
  if (fetchedAt <= 0) return null; // profile never fetched — cannot vouch for it
  if (nowMs - fetchedAt > SANDBOX_IDENTITY_MAX_AGE_MS) return null; // predates this login

  return {
    accountUuid,
    emailAddress,
    organizationType:
      typeof account?.organizationType === 'string' ? account.organizationType : null,
  };
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
    // Identity sidecars use the `.meta` extension ON PURPOSE: `accounts/*.json`
    // is the account glob, so a `<label>.meta.json` would be listed as an
    // account of its own named "<label>.meta".
    'for f in accounts/*.json; do [ -f "$f" ] || continue;',
    '  l=$(basename "$f" .json); echo "ACC:$l";',
    '  [ -f "accounts/$l.meta" ] && echo "META:$l:$(tr -d "\\n" < "accounts/$l.meta")";',
    'done',
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
  return parseSandboxAccountListing(out);
}

/** Parse the listing probe's line protocol. Exported for tests. */
export function parseSandboxAccountListing(out: string): SandboxAccountsResponse {
  const lines = out.split('\n').map((l) => l.trim());
  const loggedIn = lines.some((l) => l === 'LOGGEDIN:1');
  const active = (lines.find((l) => l.startsWith('ACTIVE:')) ?? 'ACTIVE:').slice('ACTIVE:'.length);

  const meta = new Map<string, { identity: SandboxAccountIdentity | null; auto: boolean }>();
  for (const line of lines) {
    if (!line.startsWith('META:')) continue;
    // META:<label>:<json> — split on the FIRST colon after the label only, the
    // JSON payload contains colons of its own.
    const rest = line.slice('META:'.length);
    const sep = rest.indexOf(':');
    if (sep < 0) continue;
    const label = rest.slice(0, sep);
    try {
      const parsed = JSON.parse(rest.slice(sep + 1)) as {
        accountUuid?: unknown;
        emailAddress?: unknown;
        organizationType?: unknown;
        auto?: unknown;
      };
      const identity =
        typeof parsed.accountUuid === 'string' && typeof parsed.emailAddress === 'string'
          ? {
              accountUuid: parsed.accountUuid,
              emailAddress: parsed.emailAddress,
              organizationType:
                typeof parsed.organizationType === 'string' ? parsed.organizationType : null,
            }
          : null;
      meta.set(label, { identity, auto: parsed.auto === true });
    } catch {
      // Corrupt sidecar — the account itself is still usable, just unnamed.
    }
  }

  const accounts: SandboxAccount[] = lines
    .filter((l) => l.startsWith('ACC:'))
    .map((l) => l.slice('ACC:'.length))
    .map((label) => {
      const m = meta.get(label);
      return {
        label,
        active: label === active && active !== '',
        identity: m?.identity ?? null,
        auto: m?.auto === true,
      };
    });
  const activeUnsaved = loggedIn && active === '';
  return { supported: true, loggedIn, activeUnsaved, accounts };
}

/** Snapshot the CURRENT active login into accounts/<label>.json, plus an
 *  optional `<label>.meta` sidecar recording whose account it is. */
export async function saveSandboxAccount(
  image: string,
  label: string,
  meta?: { identity: SandboxAccountIdentity; auto: boolean },
): Promise<SandboxAccountsResponse> {
  assertAccountLabel(label);
  const script = [
    `cd ${CONTAINER_AUTH_DIR}`,
    // Không lưu bản rỗng token — đó là cách accounts/<label>.json thành rác.
    'grep -q \'"accessToken"[[:space:]]*:[[:space:]]*"[^"]\' .credentials.json 2>/dev/null || { echo "NO_ACTIVE" >&2; exit 3; }',
    'mkdir -p accounts',
    `cp .credentials.json "accounts/${label}.json"`,
    // The sidecar is written from a base64 literal rather than interpolated
    // JSON: the email is attacker-influenced-ish free text and this string ends
    // up inside `sh -c`, so no quoting scheme in the payload can escape.
    ...(meta
      ? [
          `echo '${Buffer.from(
            JSON.stringify({
              accountUuid: meta.identity.accountUuid,
              emailAddress: meta.identity.emailAddress,
              organizationType: meta.identity.organizationType ?? null,
              auto: meta.auto,
            }),
            'utf8',
          ).toString('base64')}' | base64 -d > "accounts/${label}.meta"`,
        ]
      : []),
  ].join('\n');
  await docker(
    ['run', '--rm', '-v', `${SANDBOX_AUTH_VOLUME}:${CONTAINER_AUTH_DIR}`, '--entrypoint', 'sh', image, '-c', script],
    30_000,
  ).catch(() => {
    throw new Error('Chưa đăng nhập Claude nào để lưu — chạy: od sandbox login trước.');
  });
  return listSandboxAccounts(image);
}

/** Outcome of an auto-save attempt, for logging and for the caller's decision
 *  to re-list. `skipped` carries WHY so a silent no-op is never a mystery. */
export type SandboxAutoSaveResult =
  | { saved: true; label: string; reused: boolean }
  | { saved: false; reason: 'already-saved' | 'no-identity' | 'no-label' | 'failed' };

/**
 * Save the freshly-detected login into the account list under a name derived
 * from its email, so a login shows up as a real account without the user having
 * to invent a label.
 *
 * Only called on a false→true login transition. Two things keep it from
 * creating duplicates or mislabelled entries:
 *
 *   - It does nothing when the active credentials already byte-match a saved
 *     account. That is also what makes an account SWITCH safe: switching makes
 *     the active file identical to a saved one, so there is nothing to add —
 *     and the stale-`.claude.json` trap never gets a chance to mislabel it.
 *   - Duplicates are resolved on `accountUuid`, not on the credentials bytes:
 *     re-logging into the same account mints new tokens, so a byte comparison
 *     would file it as a brand-new account every time. A matching UUID updates
 *     that account's stored credentials in place, keeping its existing label.
 */
export async function autoSaveSandboxLogin(image: string): Promise<SandboxAutoSaveResult> {
  try {
    const listing = await listSandboxAccounts(image);
    if (!listing.loggedIn || !listing.activeUnsaved) return { saved: false, reason: 'already-saved' };

    const identity = await readSandboxClaudeIdentity(image);
    if (!identity) return { saved: false, reason: 'no-identity' };

    const decision = chooseAutoSaveLabel(listing.accounts, identity);
    if (decision.label === null) return { saved: false, reason: decision.reason };

    await saveSandboxAccount(image, decision.label, { identity, auto: true });
    return { saved: true, label: decision.label, reused: decision.reused };
  } catch {
    // Auto-save is a convenience layered on top of login detection; if it fails
    // the user still has the manual "name this login" flow.
    return { saved: false, reason: 'failed' };
  }
}

/**
 * Which label a freshly-detected login should be filed under. Pure so the
 * dedup rules are testable without a Docker volume.
 *
 * `reused: true` means "this is the same account signing in again" — matched on
 * `accountUuid`, never on the credentials bytes, which change on every login.
 */
export function chooseAutoSaveLabel(
  accounts: readonly SandboxAccount[],
  identity: SandboxAccountIdentity,
): { label: string; reused: boolean } | { label: null; reason: 'no-label' } {
  // Same account, new tokens → refresh that entry in place, keeping whatever
  // name it already has (possibly one the user renamed it to).
  const existing = accounts.find((a) => a.identity?.accountUuid === identity.accountUuid);
  if (existing) return { label: existing.label, reused: true };

  const base = sandboxAccountLabelFromEmail(identity.emailAddress);
  if (!base) return { label: null, reason: 'no-label' };

  const taken = new Set(accounts.map((a) => a.label));
  if (!taken.has(base)) return { label: base, reused: false };
  // Two different people whose emails slugify the same (work vs personal
  // domain), or a legacy label that happens to collide: keep both rather than
  // overwriting someone else's saved login.
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`.slice(0, 40);
    if (!taken.has(candidate)) return { label: candidate, reused: false };
  }
  return { label: null, reason: 'no-label' };
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
  return sandboxRuntimeLoginCommand('claude', image);
}

/** Runtime-specific interactive login command, used by the terminal launcher. */
export function sandboxRuntimeInteractiveLoginCommand(
  runtimeId: SandboxRuntimeId,
  image: string,
): string {
  return sandboxRuntimeLoginCommand(runtimeId, image);
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

// ── Embedded (no-terminal) Codex device-auth login ─────────────────────────
// Separate from the Claude flow so both runtime identities can be logged in
// and probed independently. Codex stores its file-backed auth in
// `od-codex-auth` at `/home/node/.codex`, and the device-auth command is
// `codex login --device-auth`.

let codexDeviceLogin: EmbeddedLoginSession | null = null;

function teardownCodexDeviceLogin(session: EmbeddedLoginSession): void {
  if (session.settleTimer) clearTimeout(session.settleTimer);
  if (session.verifyTimer) clearInterval(session.verifyTimer);
  clearTimeout(session.deadline);
  try {
    session.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  void docker(['rm', '-f', session.containerName], 10_000).catch(() => {});
}

async function sweepCodexDeviceLoginContainers(): Promise<void> {
  try {
    const out = await docker(['ps', '-a', '--filter', 'name=od.sandbox.codex.login.', '--format', '{{.Names}}']);
    for (const name of out.split('\n').filter(Boolean)) {
      await docker(['rm', '-f', name], 10_000).catch(() => {});
    }
  } catch {
    /* docker down — nothing to sweep */
  }
}

export function getCodexDeviceAuthLoginStatus(): SandboxEmbeddedLoginStatus {
  if (!codexDeviceLogin) return { phase: 'idle', url: null, error: null };
  const { phase, url, error } = codexDeviceLogin;
  return { phase, url, error };
}

export function cancelCodexDeviceAuthLogin(): SandboxEmbeddedLoginStatus {
  if (codexDeviceLogin) {
    teardownCodexDeviceLogin(codexDeviceLogin);
    codexDeviceLogin = null;
  }
  return getCodexDeviceAuthLoginStatus();
}

export function startCodexDeviceAuthLogin(image: string): SandboxEmbeddedLoginStatus {
  cancelCodexDeviceAuthLogin();
  void sweepCodexDeviceLoginContainers();
  const containerName = `od.sandbox.codex.login.${Date.now()}`;
  const spec = sandboxRuntimeSpec('codex');
  const child = spawn(
    'docker',
    [
      'run',
      '-i',
      '--rm',
      '--name',
      containerName,
      '-v',
      `${spec.authVolume}:${spec.authDir}`,
      '-e',
      `CODEX_HOME=${spec.authDir}`,
      '--entrypoint',
      'sh',
      image,
      '-c',
      `script -qec ${JSON.stringify(spec.loginCommand.join(' '))} /dev/null`,
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
      if (codexDeviceLogin === session && session.phase !== 'done') {
        session.phase = 'error';
        session.error = 'Quá thời gian đăng nhập Codex (10 phút) — thử lại.';
        teardownCodexDeviceLogin(session);
      }
    }, EMBEDDED_LOGIN_TIMEOUT_MS),
  };
  session.deadline.unref();
  codexDeviceLogin = session;

  const scheduleNudge = () => {
    if (session.settleTimer) clearTimeout(session.settleTimer);
    session.settleTimer = setTimeout(() => {
      if (codexDeviceLogin !== session || session.phase !== 'starting') return;
      if (session.promptsSent >= EMBEDDED_LOGIN_MAX_PROMPTS) {
        session.phase = 'error';
        session.error = 'Không đi hết được các bước của trình đăng nhập Codex — dùng cách mở Terminal.';
        teardownCodexDeviceLogin(session);
        return;
      }
      session.promptsSent += 1;
      session.child.stdin?.write('\r');
      scheduleNudge();
    }, 1500);
    session.settleTimer.unref();
  };

  const finishIfLoggedIn = () => {
    void probeSandboxRuntimeAuthState(session.image, 'codex').then((state) => {
      if (codexDeviceLogin !== session || session.phase === 'done' || session.phase === 'error') return;
      if (state === 'logged-in') {
        session.phase = 'done';
        teardownCodexDeviceLogin(session);
      }
    });
  };

  const onData = (chunk: Buffer) => {
    if (codexDeviceLogin !== session) return;
    session.buf = (session.buf + chunk.toString()).slice(-EMBEDDED_LOGIN_BUF_MAX);
    if (session.phase !== 'starting') {
      finishIfLoggedIn();
      return;
    }
    const url = extractOauthUrl(stripAnsi(session.buf));
    if (url) {
      if (session.settleTimer) clearTimeout(session.settleTimer);
      session.phase = 'awaiting-code';
      session.url = url;
      openHostBrowser(url);
      finishIfLoggedIn();
      return;
    }
    scheduleNudge();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (err) => {
    if (codexDeviceLogin !== session) return;
    session.phase = 'error';
    session.error = `Không chạy được docker: ${err.message}`;
    teardownCodexDeviceLogin(session);
  });
  child.on('close', () => {
    if (codexDeviceLogin !== session) return;
    if (session.phase === 'done' || session.phase === 'error') return;
    void probeSandboxRuntimeAuthState(session.image, 'codex').then((state) => {
      if (codexDeviceLogin !== session) return;
      if (state === 'logged-in') {
        session.phase = 'done';
      } else {
        session.phase = 'error';
        session.error = 'Phiên đăng nhập Codex kết thúc trước khi hoàn tất — thử lại.';
      }
      teardownCodexDeviceLogin(session);
    });
  });
  scheduleNudge();
  return getCodexDeviceAuthLoginStatus();
}

/**
 * Best-effort: open a HOST terminal window running the interactive Claude login
 * (a full-screen TUI that can't be embedded in the web UI). Returns whether a
 * window was opened; the caller shows the raw command as a copy-paste fallback.
 * On macOS the session is mirrored to a log so the daemon can auto-open the
 * OAuth URL in the host browser (see watchLoginLogForOauthUrl).
 */
export function openSandboxLoginTerminal(image: string): { launched: boolean; command: string; message?: string } {
  return openSandboxRuntimeLoginTerminal('claude', image);
}

/**
 * Best-effort: open a HOST terminal window running a runtime-specific login
 * command. Returns whether a window was opened; the caller shows the raw
 * command as a copy-paste fallback.
 */
export function openSandboxRuntimeLoginTerminal(
  runtimeId: SandboxRuntimeId,
  image: string,
): { launched: boolean; command: string; message?: string } {
  const command = sandboxRuntimeLoginCommand(runtimeId, image);
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
        `#!/bin/zsh\nclear\necho "Đăng nhập ${runtimeId === 'codex' ? 'Codex' : 'Claude'} — làm theo hướng dẫn bên dưới; trình duyệt sẽ tự mở."\n${wrapped}\n`,
        { mode: 0o755 },
      );
      spawn('open', [cmdPath], { detached: true, stdio: 'ignore' }).unref();
      watchLoginLogForOauthUrl(logPath);
      return {
        launched: true,
        command,
        message:
          runtimeId === 'codex'
            ? 'Đã mở Terminal — trình duyệt sẽ tự bật trang đăng nhập sau vài giây; xác nhận ở đó rồi quay lại Lưu.'
            : 'Đã mở Terminal — trình duyệt sẽ tự bật trang đăng nhập sau vài giây; xác nhận ở đó rồi dán mã vào Terminal, xong quay lại Lưu.',
      };
    }
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'cmd', '/k', command], { detached: true, stdio: 'ignore' }).unref();
      return {
        launched: true,
        command,
        message:
          runtimeId === 'codex'
            ? 'Đã mở cửa sổ lệnh — hoàn tất đăng nhập rồi quay lại Lưu.'
            : 'Đã mở cửa sổ lệnh — hoàn tất đăng nhập rồi quay lại Lưu.',
      };
    }
    // Linux: try the common terminal emulators, first hit wins.
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
      try {
        spawn(term, ['-e', 'sh', '-c', `${command}; exec sh`], { detached: true, stdio: 'ignore' }).unref();
        return {
          launched: true,
          command,
          message:
            runtimeId === 'codex'
              ? 'Đã mở terminal — hoàn tất đăng nhập rồi quay lại Lưu.'
              : 'Đã mở terminal — hoàn tất đăng nhập rồi quay lại Lưu.',
        };
      } catch {
        /* try the next emulator */
      }
    }
    return {
      launched: false,
      command,
      message:
        runtimeId === 'codex'
          ? 'Không mở được terminal — chạy lệnh này thủ công rồi quay lại Lưu.'
          : 'Không mở được terminal — chạy lệnh này thủ công rồi quay lại Lưu.',
    };
  } catch {
    return {
      launched: false,
      command,
      message:
        runtimeId === 'codex'
          ? 'Không mở được terminal — chạy lệnh này thủ công rồi quay lại Lưu.'
          : 'Không mở được terminal — chạy lệnh này thủ công rồi quay lại Lưu.',
    };
  }
}

/** Delete a saved account (does NOT touch the active login). */
export async function removeSandboxAccount(image: string, label: string): Promise<SandboxAccountsResponse> {
  assertAccountLabel(label);
  // Drop the identity sidecar too: leaving it behind would let a later account
  // that happens to reuse this label inherit the removed account's identity.
  const script =
    `rm -f ${CONTAINER_AUTH_DIR}/accounts/${label}.json ${CONTAINER_AUTH_DIR}/accounts/${label}.meta`;
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
  runtimeId: SandboxRuntimeId = 'claude',
): Promise<SandboxRuntimeStatus> {
  if (!(await dockerAvailable())) {
    return { dockerRunning: false, imagePresent: false, authLoggedIn: false, version: null };
  }
  if (!(await dockerImagePresent(image))) {
    return { dockerRunning: true, imagePresent: false, authLoggedIn: false, version: null };
  }
  const [authLoggedIn, version] = await Promise.all([
    probeSandboxRuntimeAuthState(image, runtimeId),
    docker(['run', '--rm', image, sandboxRuntimeVersionBin(runtimeId), '--version'], 30_000)
      .then((out) => out.split('\n')[0] ?? null)
      .catch(() => null),
  ]);
  return {
    dockerRunning: true,
    imagePresent: true,
    authLoggedIn: authLoggedIn === 'logged-in',
    version,
  };
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
export async function sandboxPreflight(
  image: string,
  runtimeId: SandboxRuntimeId = 'claude',
): Promise<SandboxPreflightResult> {
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
  const authVolume = sandboxAuthVolume(runtimeId);
  if (!(await dockerVolumePresent(authVolume))) {
    return {
      ok: false,
      reason:
        runtimeId === 'codex'
          ? `Sandbox auth volume ${authVolume} is missing. Log in once with: codex login --device-auth`
          : `Sandbox auth volume ${authVolume} is missing. Log in once with: od sandbox login`,
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
      const codex = readFileSync(path.join(builderDir, 'sandbox', 'codex.version'), 'utf8').trim();
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
          '--build-arg', `CODEX_VERSION=${codex}`,
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
