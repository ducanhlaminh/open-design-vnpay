import { agentCapabilities } from '../capabilities.js';
import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeModelOption } from '../types.js';
import type { RuntimeAgentDef } from '../types.js';

// Product decision 19/08/2026: Codex CLI runs pinned to Luna at the
// highest reasoning effort Luna supports, always — not a user choice, not
// read from stored config. `codex debug models` on the installed CLI lists
// `gpt-5.6-luna` ("GPT-5.6-Luna") with effort levels
// low/medium/high/xhigh/max; `max` is the highest. To change the pin,
// change these two constants (and nothing else).
export const CODEX_FIXED_MODEL = 'gpt-5.6-luna';
export const CODEX_FIXED_REASONING = 'max';

// Retained even though the def below no longer wires up `listModels` (no
// more live `codex debug models` probing now that the model is fixed) —
// still exported in case another caller / test wants the raw parser.
export function parseCodexDebugModels(stdout: string): RuntimeModelOption[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(stdout || ''));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;

  const out = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>([DEFAULT_MODEL_OPTION.id]);
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as {
      slug?: unknown;
      id?: unknown;
      display_name?: unknown;
      name?: unknown;
      visibility?: unknown;
    };
    if (entry.visibility === 'hidden') continue;
    const id =
      typeof entry.slug === 'string'
        ? entry.slug.trim()
        : typeof entry.id === 'string'
          ? entry.id.trim()
          : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label =
      typeof entry.display_name === 'string' && entry.display_name.trim()
        ? entry.display_name.trim()
        : typeof entry.name === 'string' && entry.name.trim()
          ? entry.name.trim()
          : id;
    out.push({ id, label });
  }
  return out.length > 1 ? out : null;
}

export const codexAgentDef = {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    versionArgs: ['--version'],
    // The MCP-profile flag lives under the `exec` subcommand, so probe
    // `codex exec --help` rather than global help. Older CLIs spell it
    // `--profile-v2`; current ones spell it `--profile` and reject the old
    // name outright. Both substrings are probed because `--profile` is a
    // prefix of `--profile-v2` — on an old CLI BOTH match, and buildArgs
    // resolves that ambiguity by preferring `--profile-v2` only when the
    // bare `--profile` spelling is absent.
    helpArgs: ['exec', '--help'],
    // Codex's own session/state dir (auth.json, PATH-alias shims, the
    // in-process app-server's runtime files it writes on startup). Needed
    // under the write-isolation Seatbelt tier (write-isolation.ts) — without
    // it every host-mode Codex run fails with "could not create PATH
    // aliases" / "failed to initialize in-process app-server client:
    // Operation not permitted". `$CODEX_HOME` overrides this default on a
    // real run (see auth.ts's `probeCodexAuthStatus`), but that is a static
    // def and cannot read env per-run — `.codex` covers the plain-install
    // case, which is the one that actually fails today.
    writableStatePaths: ['.codex'],
    capabilityFlags: {
      '--profile-v2 ': 'profileFlagIsV2',
      '--profile <': 'profileFlag',
    },
    // Model is fixed to Luna (see CODEX_FIXED_MODEL above) — no live
    // `codex debug models` probing and no picker beyond the one entry
    // below. `parseCodexDebugModels` above stays exported but unused here.
    fallbackModels: [{ id: CODEX_FIXED_MODEL, label: 'GPT-5.6-Luna' }],
    reasoningOptions: [{ id: CODEX_FIXED_REASONING, label: 'Max' }],
    // Prompt is delivered via stdin pipe (gated by `promptViaStdin: true`
    // below) to avoid Windows `spawn ENAMETOOLONG` while keeping Codex on
    // its structured JSON stream. Recent Codex CLI versions reject a bare
    // `-` argv sentinel — passing both the pipe and `-` produces
    // `error: unexpected argument '-' found` and the agent exits with
    // code 2 before any prompt is read (see issue #237). The pipe alone
    // is sufficient for stdin delivery.
    buildArgs: (
      _prompt,
      _imagePaths,
      extraAllowedDirs = [],
      options = {},
      runtimeContext = {},
    ) => {
      // Codex CLI's `workspace-write` sandbox blocks shell invocations on
      // Windows ("powershell.exe ... rejected: blocked by policy", #1721),
      // because Codex has no working OS-level sandbox on Windows and falls
      // back to a coarse policy that rejects any shell. macOS (Seatbelt)
      // and Linux (Landlock+seccomp) keep workspace-write because their
      // sandbox enforcement permits shell while restricting writes.
      const isWindows = process.platform === 'win32';
      // OD spawns Codex headlessly via SSE; there is no TTY for the
      // user to approve commands, so the default policy silently
      // cancels MCP tool calls and any shell invocation not on the
      // built-in trusted list. `approval_policy="never"` matches OD's
      // harness contract: the model is trusted to operate within the
      // sandbox the daemon already configured. Passed via `-c` rather
      // than `--ask-for-approval` because the latter is a top-level
      // codex flag and would be rejected as "unexpected argument"
      // after the `exec` subcommand.
      const args = isWindows
        ? [
            'exec',
            '--json',
            '--skip-git-repo-check',
            '--sandbox',
            'danger-full-access',
            '-c',
            'approval_policy="never"',
          ]
        : [
            'exec',
            '--json',
            '--skip-git-repo-check',
            '--sandbox',
            'workspace-write',
            '-c',
            'sandbox_workspace_write.network_access=true',
            '-c',
            'approval_policy="never"',
          ];
      if (process.env.OD_CODEX_DISABLE_PLUGINS === '1') {
        args.push('--disable', 'plugins');
      }
      if (runtimeContext.cwd) {
        args.push('-C', runtimeContext.cwd);
      }
      // Model + reasoning are pinned (CODEX_FIXED_MODEL /
      // CODEX_FIXED_REASONING above) — always pushed, regardless of
      // `options.model` / `options.reasoning` (including a leftover
      // 'default' or a stale value from old stored config). Codex accepts
      // `-c key=value` config overrides; reasoning effort is exposed as
      // `model_reasoning_effort`.
      args.push('--model', CODEX_FIXED_MODEL);
      args.push('-c', `model_reasoning_effort="${CODEX_FIXED_REASONING}"`);
      // Layer OD's per-run MCP profile on top of the user's base
      // ~/.codex/config.toml. The daemon writes the file at
      // `$CODEX_HOME/<name>.config.toml` BEFORE buildArgs is called
      // (see the `codex-profile-v2` dispatch branch in server.ts) and
      // surfaces the profile name through runtimeContext.
      //
      // The flag was renamed `--profile-v2` -> `--profile` (the argument is
      // still a profile-v2 name: `-p, --profile <CONFIG_PROFILE_V2>`). Passing
      // the wrong one is fatal — Codex rejects the unknown argument and exits
      // 2 before reading the prompt — so the spelling is chosen from the
      // probed `--help` text rather than assumed.
      if (runtimeContext.codexProfileName) {
        const caps = agentCapabilities.get('codex') || {};
        args.push(
          caps.profileFlagIsV2 && !caps.profileFlag ? '--profile-v2' : '--profile',
          runtimeContext.codexProfileName,
        );
      }
      const dirs = (extraAllowedDirs || []).filter(
        (d) => typeof d === 'string' && d.length > 0,
      );
      for (const d of dirs) {
        args.push('--add-dir', d);
      }
      return args;
    },
    promptViaStdin: true,
    streamFormat: 'json-event-stream',
    eventParser: 'codex',
    // Daemon writes `$CODEX_HOME/od-injected.config.toml` with enabled
    // external MCP servers before spawn and passes `--profile-v2
    // od-injected`. Codex layers that profile over the user's base
    // config so servers added via Settings UI become visible to Codex
    // without touching the user's hand-edited config file.
    externalMcpInjection: 'codex-profile-v2',
} satisfies RuntimeAgentDef;
