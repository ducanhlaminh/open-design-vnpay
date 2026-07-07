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
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SandboxConfigPrefs } from './app-config.js';

const execFileAsync = promisify(execFile);

export const SANDBOX_IMAGE_NAME = 'od-agent-sandbox';
export const SANDBOX_AUTH_VOLUME = 'od-claude-auth';
export const SANDBOX_CONTAINER_PREFIX = 'od-sbx-';
export const SANDBOX_LABEL_KEY = 'od.sandbox';
const CONTAINER_PROJECT_DIR = '/work/app';
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
 * Default sandboxed skills = EVERY pipeline step across the three docs→output
 * workflows. All of them are safe in the container: cj/ux/feature/shadcn/html
 * are pure author-files-in-CWD steps, ui-react builds in-place on the baked
 * toolkit, and jira-ingest's stdio MCP (`uvx mcp-atlassian`) is baked into the
 * od-agent-sandbox image (see sandbox/Dockerfile). General chat / Orbit /
 * routine runs stay host-spawned — different CWD + integration surface.
 */
const DEFAULT_SANDBOX_SKILLS = [
  'jira-ingest',
  'customer-journey-spec',
  'ux-spec',
  'ui-react',
  'html-interactive-prototype',
];

/**
 * Prefs → effective config. `OD_SANDBOX=1|0` overrides the persisted
 * `enabled` flag for quick dev toggling without editing app-config.json.
 * A `'*'` entry in `runtimes`/`skills` matches everything.
 */
export function resolveSandboxConfig(
  prefs: SandboxConfigPrefs | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSandboxConfig {
  let enabled = prefs?.enabled === true;
  if (env.OD_SANDBOX === '1') enabled = true;
  else if (env.OD_SANDBOX === '0') enabled = false;
  return {
    enabled,
    runtimes: prefs?.runtimes?.length ? prefs.runtimes : ['claude'],
    skills: prefs?.skills?.length ? prefs.skills : [...DEFAULT_SANDBOX_SKILLS],
    timeoutMinutes: prefs?.timeoutMinutes ?? 30,
    cpus: prefs?.cpus ?? 2,
    memoryGb: prefs?.memoryGb ?? 4,
  };
}

/**
 * The gate. Sandboxing is opt-in per runtime AND per skill: by default every
 * docs→output pipeline step runs in the container (DEFAULT_SANDBOX_SKILLS),
 * while general chat / Orbit / routine runs keep host spawn. `'*'` in either
 * list matches everything.
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
export async function sandboxAuthLoggedIn(image: string): Promise<boolean> {
  try {
    await docker(
      [
        'run', '--rm',
        '-v', `${SANDBOX_AUTH_VOLUME}:${CONTAINER_AUTH_DIR}:ro`,
        '--entrypoint', 'sh',
        image,
        '-c', `test -s ${CONTAINER_AUTH_DIR}/.credentials.json`,
      ],
      30_000,
    );
    return true;
  } catch {
    return false;
  }
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
