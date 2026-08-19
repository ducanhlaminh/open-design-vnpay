import type { ExecFileOptions } from 'node:child_process';

export type RuntimeEnv = NodeJS.ProcessEnv | Record<string, string>;

export type RuntimeModelOption = {
  id: string;
  label: string;
};

export type RuntimeModelSource = 'live' | 'fallback';

export type RuntimeReasoningOption = RuntimeModelOption;

export type RuntimeBuildOptions = {
  model?: string | null;
  reasoning?: string | null;
};

export type RuntimeContext = {
  cwd?: string;
  // Name of the per-run Codex profile-v2 TOML file the daemon wrote
  // for this spawn (without the `.config.toml` suffix). Forwarded to
  // codex's buildArgs so it can append `--profile-v2 <name>`, layering
  // OD's MCP server config on top of the user's base ~/.codex/config.toml
  // without mutating it.
  codexProfileName?: string;
  // True when the daemon is about to wrap this spawn in
  // `/usr/bin/sandbox-exec` (write-isolation.ts). Runtimes whose own
  // sandbox is ALSO Seatbelt-based must turn theirs off when this is set:
  // macOS refuses a nested `sandbox_apply` ("Operation not permitted"), so
  // the inner sandbox does not weaken — it fails every command outright,
  // before it runs. Only codex reads it today.
  writeIsolated?: boolean;
};

export type RuntimeCapabilityMap = Record<string, boolean>;

export type RuntimeListModels = {
  args: string[];
  timeoutMs?: number;
  parse: (stdout: string) => RuntimeModelOption[] | null;
};

export type RuntimePromptBudgetError = {
  code: 'AGENT_PROMPT_TOO_LARGE';
  message: string;
  bytes?: number;
  commandLineLength?: number;
  limit: number;
};

export type RuntimeAgentDef = {
  id: string;
  name: string;
  bin: string;
  versionArgs: string[];
  fallbackModels: RuntimeModelOption[];
  buildArgs: (
    prompt: string,
    imagePaths: string[],
    extraAllowedDirs?: string[],
    options?: RuntimeBuildOptions,
    runtimeContext?: RuntimeContext,
  ) => string[];
  streamFormat: string;
  fallbackBins?: string[];
  versionProbeTimeoutMs?: number;
  helpArgs?: string[];
  capabilityFlags?: Record<string, string>;
  promptViaStdin?: boolean;
  // Format for the user prompt fed via stdin. Default is plain text (the
  // entire prompt buffer goes in raw, then stdin is closed). When set to
  // 'stream-json' the daemon writes a single JSONL line wrapping the prompt
  // as an Anthropic user message (so tool_result blocks can later be
  // injected into the same stdin without re-spawning the child). Only
  // honored for adapters that also set `promptViaStdin: true`.
  promptInputFormat?: 'text' | 'stream-json';
  eventParser?: string;
  env?: Record<string, string>;
  listModels?: RuntimeListModels;
  fetchModels?: (
    resolvedBin: string,
    env: RuntimeEnv,
  ) => Promise<RuntimeModelOption[] | null>;
  reasoningOptions?: RuntimeReasoningOption[];
  supportsImagePaths?: boolean;
  maxPromptArgBytes?: number;
  mcpDiscovery?: string;
  // How the daemon forwards the user's `.od/mcp-config.json` external MCP
  // servers to this runtime at spawn time. The shape of the injection
  // is one of three strategies, each of which the server.ts spawn
  // pipeline knows how to apply:
  //
  //   'claude-mcp-json'      — write `.mcp.json` into the managed
  //                            project cwd (Claude Code auto-loads it).
  //   'acp-merge'            — merge stdio entries into the existing
  //                            `mcpServers` array of an ACP launch
  //                            descriptor (Hermes / Kimi / Kilo / Kiro
  //                            / Vibe / Devin).
  //   'opencode-env-content' — serialise to OpenCode's `mcp` config
  //                            schema and hand it through
  //                            `OPENCODE_CONFIG_CONTENT` in the spawn
  //                            env.
  //   'codex-profile-v2'     — write a TOML profile to
  //                            `$CODEX_HOME/<name>.config.toml` and
  //                            pass `--profile-v2 <name>` so Codex
  //                            layers it on top of the user's base
  //                            config (no mutation of ~/.codex/config.toml).
  //
  // Leave undefined for adapters that have no native MCP transport
  // wired yet (gemini, cursor-agent, copilot, qoder, pi). The settings
  // UI reads this field to surface an explicit "external MCP is not
  // forwarded to <agent>; configure servers in <agent>'s own config
  // file instead" hint, replacing the previous silent-failure UX from
  // issue #2142.
  externalMcpInjection?:
    | 'claude-mcp-json'
    | 'acp-merge'
    | 'opencode-env-content'
    | 'codex-profile-v2';
  installUrl?: string;
  docsUrl?: string;
  // Extra directories (beyond the run cwd) this runtime needs write access
  // to under the write-isolation Seatbelt tier (write-isolation.ts,
  // docs/run-write-isolation-spec.md) — its own session/state dir, where it
  // stores auth tokens, PATH-alias shims, or other runtime files it writes
  // on startup regardless of cwd. Entries are bare, HOME-relative segments
  // (e.g. `.codex`, not `~/.codex` or an absolute path) — server.ts resolves
  // them against `os.homedir()` at the write-isolation call site via
  // `resolveWritableStatePaths`. An already-absolute entry is also accepted
  // (passed through unchanged) for a future def that needs a non-home path.
  // Claude's own state dir stays hardcoded inline in
  // `buildWriteIsolationProfile` per the spec — this field is for every
  // OTHER runtime. Leave undefined for adapters with no on-disk state dir
  // that needs writing (or none identified yet); an omitted def just means
  // that runtime's write-isolated run fails loudly with a plain EPERM if it
  // ever needs one, which tells us the path to add.
  writableStatePaths?: string[];
};

export type DetectedAgent = Omit<
  RuntimeAgentDef,
  | 'buildArgs'
  | 'listModels'
  | 'fetchModels'
  | 'fallbackModels'
  | 'helpArgs'
  | 'capabilityFlags'
  | 'fallbackBins'
  | 'versionProbeTimeoutMs'
  | 'maxPromptArgBytes'
  | 'env'
> & {
  models: RuntimeModelOption[];
  modelsSource: RuntimeModelSource;
  available: boolean;
  authStatus?: 'ok' | 'missing' | 'unknown';
  authMessage?: string;
  /** Best-effort logged-in account identity (e.g. email), read from the same
   *  on-disk state `authStatus` came from. Undefined whenever unavailable —
   *  never treated as a probe failure. See runtimes/auth.ts. */
  authAccount?: { email?: string };
  path?: string;
  version?: string | null;
  /** Present when the agent sandbox OWNS this runtime's runs (enabled +
   *  skills `'*'`): every run spawns inside the od-agent-sandbox container,
   *  so `available`/`version`/`authStatus` above reflect the SANDBOX (docker
   *  + image + auth volume), not a host install. Attached by /api/agents. */
  sandbox?: {
    owns: boolean;
    dockerRunning: boolean;
    imagePresent: boolean;
    authLoggedIn: boolean;
    version: string | null;
  };
};

export type RuntimeExecOptions = ExecFileOptions & {
  env?: NodeJS.ProcessEnv;
};
