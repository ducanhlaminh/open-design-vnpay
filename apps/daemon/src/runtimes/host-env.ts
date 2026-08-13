// Allowlist-based env filter for HOST agent spawns (docs: WP2 in
// specs/change/20260813-web-first/wp2-env-whitelist.md).
//
// Docker sandbox runs already forward only a tiny, per-runtime whitelist of
// env vars into the container (see `forwardedEnvKeys` in agent-sandbox.ts) —
// that path is untouched by this module. Host spawns (no Docker) used to
// spread the ENTIRE daemon `process.env` into the agent child process
// (`createAgentRuntimeEnv`, server.ts), which leaks anything the daemon
// process happens to hold: `KGS_API_KEY`, `MEDIA_*` creds, `OD_ATLASSIAN_*`
// PATs, `CONFLUENCE_PERSONAL_TOKEN`, `GOOGLE_CLIENT_SECRET`,
// `SESSION_SECRET`, etc.
//
// `buildHostAgentEnv` closes that gap with a default-deny allowlist applied
// at the same seam, BEFORE `spawnEnvForAgent` / `applyAgentLaunchEnv` /
// `odMediaEnv` run their own (unrelated) env composition. Only a host spawn
// (no `sandboxPlan`) goes through this function — see the call site in
// server.ts.
type HostEnvMap = NodeJS.ProcessEnv | Record<string, string>;

// Exact env var names let through verbatim. Matched case-insensitively (see
// `matches` below) because Windows spreads `process.env` with inconsistent
// key casing (`Path` vs `PATH`) — the rest of this codebase already treats
// env-name comparisons as case-insensitive for the same reason
// (`spawnEnvForAgent` / `stripUnlessCustomBaseUrl` in ./env.ts).
const ALLOWED_EXACT_KEYS: ReadonlySet<string> = new Set([
  // Enough for the child process to function as a normal OS process.
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TERM',
  'LANG',
  'TZ',

  // Node/toolchain. NOTE: NODE_OPTIONS is deliberately NOT here — it is an
  // arbitrary-code-injection vector into the child's V8/Node runtime
  // (`--require`, `--loader`, etc.) and must never be inherited by an agent
  // process. OD_NODE_BIN (the node binary path itself) is fine.
  'OD_NODE_BIN',

  // Claude Code adapter. ANTHROPIC_API_KEY is stripped downstream by
  // `spawnEnvForAgent` unless ANTHROPIC_BASE_URL is also set (../env.ts) —
  // that logic is unchanged; this module only decides what is eligible to
  // reach that step in the first place.
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_BIN',

  // Codex adapter — kept at parity with the Docker sandbox's
  // `forwardedEnvKeys` for codex (agent-sandbox.ts) even though the current
  // host-CLI plan targets Claude first.
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_HOME',

  // OD runtime vars a tool/skill running INSIDE the agent process actually
  // reads. Verified by grepping `process.env.OD_` across
  // apps/daemon/src/{cli,tools-*-cli,mcp-live-artifacts-server,
  // mcp-overview-server}.ts (the `od tools ...` / `od mcp ...` subprocesses
  // an agent or its ACP-declared MCP servers shell out to) and every
  // `skills/**/*.{py,sh}` script — see wp2-env-whitelist.md report for the
  // full grep trail. Everything else under OD_* (OD_ATLASSIAN_*,
  // OD_MEDIA_CONFIG_DIR, OD_PORT, OD_BIND_HOST, OD_KG_*, ...) is
  // daemon-process-only config and must stay blocked, which is why this is
  // an explicit name list and NOT an `OD_*` prefix.
  'OD_TOOL_TOKEN',
  'OD_DAEMON_URL',
  'OD_DATA_DIR',
  'OD_PROJECT_ID',
  'OD_PROJECT_DIR',
  'OD_BIN',

  // Corporate proxy. Both cases are real-world conventions (curl honors
  // both); case-insensitive matching below lets either through without
  // needing to list both casings here.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]);

// Prefix allowlist, matched case-insensitively against the upper-cased key.
const ALLOWED_PREFIXES: readonly string[] = [
  'LC_', // locale (LC_ALL, LC_CTYPE, ...)
  'XDG_', // XDG base-dir spec (Linux)
  'CLAUDE_CODE_', // Claude Code CLI's own env namespace
];

// Named groups blocked BY DESIGN — never allowlisted, listed here purely so
// a future edit doesn't accidentally widen the allowlist to cover them, and
// so `buildHostAgentEnv` can log which of them were actually present and
// filtered (name only, never the value) to help debug "why can't my skill
// see X". The allowlist above is default-deny already; this list does not
// change behavior, only what gets reported.
const NOTABLE_BLOCKED_PREFIXES: readonly string[] = [
  'KGS_',
  'MEDIA_',
  'GOOGLE_',
  'OD_ATLASSIAN_',
  'CONFLUENCE_',
  'IDENTITY_',
  'POSTHOG_',
];
const NOTABLE_BLOCKED_EXACT: ReadonlySet<string> = new Set(['SESSION_SECRET']);

/** Dev escape hatch: comma-separated explicit var NAMES, e.g. "FOO,BAR". */
const PASSTHROUGH_ENV_VAR = 'OD_AGENT_ENV_PASSTHROUGH';

export interface BuildHostAgentEnvOptions {
  /**
   * Sink for the "these blocked-by-design vars were present and got
   * filtered" stderr line. Receives var NAMES only, never values. Defaults
   * to `console.error` (visible in the daemon's own stderr / `tools-dev
   * logs`).
   */
  onBlockedNotable?: (names: readonly string[]) => void;
  /**
   * Sink for the `OD_AGENT_ENV_PASSTHROUGH` escape-hatch warning, fired once
   * per call when the escape hatch is used. Defaults to `console.warn`.
   */
  onPassthroughWarning?: (names: readonly string[]) => void;
}

function defaultBlockedNotableSink(names: readonly string[]): void {
  console.error(
    `[host-env] filtered from agent env (blocked by design): ${names.join(', ')}`,
  );
}

function defaultPassthroughWarningSink(names: readonly string[]): void {
  console.warn(
    `[host-env] OD_AGENT_ENV_PASSTHROUGH is forwarding extra env vars to the agent process: ${names.join(', ')}`,
  );
}

function parsePassthroughNames(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(',')
    .map((name) => name.trim().toUpperCase())
    .filter((name) => name.length > 0);
}

function isAllowedByDefault(upperKey: string): boolean {
  if (ALLOWED_EXACT_KEYS.has(upperKey)) return true;
  return ALLOWED_PREFIXES.some((prefix) => upperKey.startsWith(prefix));
}

function isNotableBlocked(upperKey: string): boolean {
  if (NOTABLE_BLOCKED_EXACT.has(upperKey)) return true;
  return NOTABLE_BLOCKED_PREFIXES.some((prefix) => upperKey.startsWith(prefix));
}

/**
 * Build the env object for a HOST (non-sandboxed, non-Docker) agent spawn.
 * Default-deny: only names on the allowlist above (plus anything named by
 * `OD_AGENT_ENV_PASSTHROUGH`) survive. Does not mutate `base`.
 */
export function buildHostAgentEnv(
  base: HostEnvMap,
  opts: BuildHostAgentEnvOptions = {},
): NodeJS.ProcessEnv {
  const onBlockedNotable = opts.onBlockedNotable ?? defaultBlockedNotableSink;
  const onPassthroughWarning = opts.onPassthroughWarning ?? defaultPassthroughWarningSink;

  const passthroughNames = parsePassthroughNames(
    (base as Record<string, string | undefined>)[PASSTHROUGH_ENV_VAR],
  );
  if (passthroughNames.length > 0) {
    onPassthroughWarning(passthroughNames);
  }

  const result: NodeJS.ProcessEnv = {};
  const blockedNotable: string[] = [];

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upperKey = key.toUpperCase();
    // The escape hatch var itself is a daemon-side config knob, not
    // something an agent process needs — never forwarded, even though a
    // user could in theory name it inside its own value.
    if (upperKey === PASSTHROUGH_ENV_VAR) continue;
    const allowed = isAllowedByDefault(upperKey) || passthroughNames.includes(upperKey);
    if (allowed) {
      result[key] = value;
      continue;
    }
    if (isNotableBlocked(upperKey)) blockedNotable.push(key);
  }

  if (blockedNotable.length > 0) onBlockedNotable(blockedNotable);

  return result;
}
