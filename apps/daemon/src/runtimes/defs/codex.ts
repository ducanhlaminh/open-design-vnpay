import { agentCapabilities } from '../capabilities.js';
import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeModelOption } from '../types.js';
import type { RuntimeAgentDef } from '../types.js';

// Product decision 19/08/2026: Codex CLI runs pinned to Luna — MODEL is not a
// user choice. Revised 21/08/2026 (reasoning thành user choice) rồi 23/08/2026
// (model thành closed list Luna/Sol/Terra). Revised 27/08/2026: KHÓA lại cả
// hai — model ghim Luna, reasoning effort KHÔNG đẩy xuống CLI nữa để Codex
// dùng đúng default của chính nó như khi mới cài (`codex debug models`:
// `default_reasoning_level: "medium"`). Lý do: model/effort thấp do người
// dùng chọn làm các stage nặng suy luận (dr-review, dr-comp) sụp đổ; giá trị
// đã lưu trong agentModels.codex.{model,reasoning} trở thành inert —
// resolveCodexModel nuốt mọi id cũ (Sol/Terra) về Luna, còn reasoning không
// còn picker (def bỏ reasoningOptions) và không còn `-c
// model_reasoning_effort` trong argv.
export const CODEX_MODEL_OPTIONS = [
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
] as const;
export const CODEX_DEFAULT_MODEL = CODEX_MODEL_OPTIONS[0].id;
/** @deprecated tên cũ — giữ cho caller/test cũ; nay model lại ghim Luna. */
export const CODEX_FIXED_MODEL = CODEX_DEFAULT_MODEL;

/** Model thật đẩy xuống CLI: id nằm trong CODEX_MODEL_OPTIONS thì giữ, còn
 *  lại (unset, sentinel 'default', id lạ/cũ — kể cả Sol/Terra đã lưu từ
 *  trước 27/08/2026) → CODEX_DEFAULT_MODEL. */
export function resolveCodexModel(model: string | null | undefined): string {
  const id = typeof model === 'string' ? model.trim() : '';
  return (CODEX_MODEL_OPTIONS as readonly { id: string }[]).some((m) => m.id === id)
    ? id
    : CODEX_DEFAULT_MODEL;
}

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
    // Model khóa Luna (27/08/2026) — danh sách một phần tử, không live
    // probing. KHÔNG khai reasoningOptions: Settings không hiện picker
    // reasoning nữa, effort để Codex CLI tự quyết theo default của nó.
    // `parseCodexDebugModels` above stays exported but unused here.
    fallbackModels: [...CODEX_MODEL_OPTIONS],
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
      // macOS + OD write isolation: the daemon is about to run this very
      // process under `/usr/bin/sandbox-exec` (write-isolation.ts). Codex's
      // own `workspace-write` is Seatbelt too — it shells out to
      // `/usr/bin/sandbox-exec` for EVERY command it runs — and macOS
      // refuses a nested sandbox: the inner call dies with `sandbox_apply:
      // Operation not permitted` BEFORE the command runs. The agent then
      // reports every tool call, even a plain `cat file`, as "blocked by the
      // sandbox environment before it ran" and the stage fails without
      // reading a single file (reported 19/08/2026 on a fresh host install,
      // where install.sh writes OD_WRITE_ISOLATION=required).
      //
      // So hand write-scope enforcement to the OUTER sandbox, which is
      // strictly stronger: OD's profile confines codex itself and every
      // child it spawns to the run cwd + a fixed allowlist, kernel-enforced,
      // whereas codex's workspace-write only covers the commands codex
      // chooses to route through it. `danger-full-access` here means "no
      // SECOND sandbox", not "unsandboxed".
      const outerSandboxOwnsWrites = runtimeContext.writeIsolated === true;
      // OD spawns Codex headlessly via SSE; there is no TTY for the
      // user to approve commands, so the default policy silently
      // cancels MCP tool calls and any shell invocation not on the
      // built-in trusted list. `approval_policy="never"` matches OD's
      // harness contract: the model is trusted to operate within the
      // sandbox the daemon already configured. Passed via `-c` rather
      // than `--ask-for-approval` because the latter is a top-level
      // codex flag and would be rejected as "unexpected argument"
      // after the `exec` subcommand.
      const args = isWindows || outerSandboxOwnsWrites
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
      // Model khóa Luna (27/08/2026): mọi options.model — kể cả Sol/Terra
      // còn lưu trong agentModels từ trước — đều resolve về Luna. Reasoning
      // effort KHÔNG đẩy xuống CLI (không còn `-c model_reasoning_effort`):
      // Codex tự dùng default của model như khi mới cài CLI.
      const modelId = resolveCodexModel(options.model);
      args.push('--model', modelId);
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
