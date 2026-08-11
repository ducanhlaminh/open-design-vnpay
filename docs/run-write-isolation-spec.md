# Run Write Isolation — kernel-enforced write scope for every agent run

Status: SPEC (feasibility verified on this machine, 2026-08-07). Phases below.

## Problem

Every agent run today spawns with `--permission-mode bypassPermissions` (or the
runtime's equivalent) and full write access to the whole filesystem as the
daemon's user. The run *should* only write inside its own workspace (the run
cwd — today a feature project dir; tomorrow `features/<current>/` inside an
app workspace). Everything else it may need to **read** (sibling features,
shared app context) but must never modify. `chmod`-based guards are advisory
only: the agent runs as the same user and can lift them. We want the
restriction **kernel-enforced** — impossible to bypass from inside the run —
and applied to **all workflows**, not just one skill.

## Current structure (analysis)

The spawn path is a single choke point, which is what makes this cheap:

- **One spawn site.** Every chat/pipeline run — regardless of workflow
  (docs-to-ui, docs-review, docs-to-prd, plain chat) — funnels into the one
  `spawn(invocation.command, invocation.args, { cwd: effectiveCwd, … })` in
  `apps/daemon/src/server.ts` (~L11746). Pipeline stages are seeded chat
  conversations, so they use the same path. Wrapping this one invocation
  covers every workflow by construction.
- **~20 runtimes, one shape.** `apps/daemon/src/runtimes/defs/*` all produce
  `(bin, args)` consumed by that same spawn. A wrapper at the invocation level
  is runtime-agnostic — claude, codex, gemini, opencode… all inherit it, and
  so do their child processes (Bash, MCP servers, scripts the agent writes).
- **Docker sandbox already exists** (`agent-sandbox.ts`,
  `wrapInvocationInSandbox`): mounts ONLY the run cwd + auth volume into the
  container, so a sandboxed run is already *more* than write-isolated (siblings
  are invisible, not just read-only). But it is gated
  (`shouldSandboxRun`: enabled + runtime/skill allowlists), requires the image
  + auth volume, and currently claude-only in practice. It is the right
  *eventual* vessel, not the cheap *universal* one.
- **Prompt delivery is stdin-first** (`stdinMode`), and stdio streaming is
  parsed from the child. A wrapper binary in front of the agent must be
  transparent to stdio — `sandbox-exec` is (it `exec`s the target).

Conclusion: insert a second, lightweight isolation tier at the same seam where
the docker wrap already happens. Docker-sandboxed runs skip it (already
stronger); everything else gets it.

## Feasibility — verified on Darwin 25.5 (Apple Silicon)

Seatbelt profile `(allow default)` + `(deny file-write*)` + allow-subpaths,
run via `/usr/bin/sandbox-exec -f profile.sb`:

| Attempt | Result |
|---|---|
| write inside allowed dir | OK |
| `echo > sibling/file` (bash) | `Operation not permitted` |
| `python3 open(...,'w')` in sibling (child process) | `PermissionError` — children inherit |
| `chmod u+w sibling && touch` (lift-the-guard escape) | denied — kernel doesn't care about mode bits |
| `ls sibling/` (read) | OK |

Caveats that shape the design:

- `sandbox-exec` is deprecated API but universally present and load-bearing
  (Chrome's and Claude Code's own sandboxes sit on Seatbelt). Risk accepted;
  the wrapper module is the single place to swap backends later.
- macOS-only. Linux/Windows hosts run unisolated in Phase 1 (loud log line),
  or use the docker tier. (Linux `bwrap --ro-bind` is the later equivalent.)
- Writes performed by **dockerd** on the agent's behalf (e.g. ui-react
  `build.sh` → `docker run -v cwd:...`) happen outside the seatbelt. Today
  those scripts only mount the run cwd, so behavior is preserved; this is a
  documented residual hole, closed only by the docker tier owning the run.

## Design

### New module `apps/daemon/src/write-isolation.ts`

```
type WriteIsolationPlan = { profilePath: string } | null;

planWriteIsolation(input: {
  cwd: string;                  // the ONLY project-area writable root
  extraWritableDirs: string[];  // linked dirs, runtime state dirs (below)
  runId: string;
}): Promise<WriteIsolationPlan>
  // null when: platform !== darwin, sandbox-exec missing, or gate off.
  // Otherwise writes the per-run profile file and returns its path.

wrapInvocationInWriteIsolation(inv, plan): CommandInvocation
  // ['/usr/bin/sandbox-exec', '-f', plan.profilePath, inv.command, ...inv.args]
```

### The profile

Default-allow, single deny class, explicit write allowlist. Generated per run
(paths are absolute; escape `"` in paths; realpath-resolve cwd first — Seatbelt
matches the canonical `/private/tmp/...`, not the `/tmp/...` symlink):

```
(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath "<realpath(cwd)>")
  ;; run scratch + OS temp — everything a CLI expects to be able to touch
  (subpath "/private/tmp")
  (subpath "/private/var/folders")   ; TMPDIR lives here per-user
  (regex #"^/dev/")                  ; /dev/null, ttys, /dev/fd
  ;; agent runtime state — CLI session files, transcripts, caches
  (subpath "<HOME>/.claude")
  (literal "<HOME>/.claude.json")
  (literal "<HOME>/.claude.json.backup")
  ;; package-manager caches so in-run npx/pnpm/npm keep working
  (subpath "<HOME>/.npm")
  (subpath "<HOME>/.cache")
  (subpath "<HOME>/Library/pnpm")
  (subpath "<HOME>/Library/Caches")
  ;; per-run extras (linked dirs, other runtimes' state dirs)
  <one subpath per extraWritableDirs entry>)
```

Notes:

- **Keychain is unaffected**: credential reads go through `securityd` (mach
  IPC), and `(allow default)` leaves every non-file-write operation — network,
  mach, ipc, exec — untouched. Only file writes are constrained.
- **Runtime state dirs**: `RuntimeAgentDef` gains optional
  `writableStatePaths?: string[]` (e.g. codex → `~/.codex`, gemini →
  `~/.gemini`, opencode → `~/.config/opencode` + `~/.local/share/opencode`).
  Phase 1 ships claude's paths inline; other defs add theirs in Phase 2 —
  until then a non-claude run that fails to write its state dir fails loudly
  and tells us the path to add.
- **Linked dirs** (`extraAllowedDirs` / linkedDirs): included as writable to
  preserve today's behavior exactly. Tightening them to read-only is a
  separate, later decision.
- `.app-context` / `.ux-kb` / `.od-skills` staging needs nothing: the daemon
  stages them (outside the sandbox) into the cwd, which is writable.

### Wiring in `server.ts`

At the existing seam (after `sandboxPlan` is decided, before
`createCommandInvocation`):

```
if (!sandboxPlan) {
  const iso = await planWriteIsolation({ cwd: effectiveCwd, extraWritableDirs, runId });
  if (iso) invocation = wrapInvocationInWriteIsolation(invocation, iso);
  else if (writeIsolationRequired) fail loudly (mirror AGENT_SANDBOX_UNAVAILABLE);
}
```

- Mutually exclusive with the docker sandbox (that tier is stronger).
- **Fail loudly, never fall back silently**: same principle the docker
  sandbox already enforces — if isolation was requested and cannot be built,
  the run errors; it does not quietly spawn unisolated.
- Profile file goes in the daemon's per-run temp area; deleted on run finish
  (best-effort — it contains only paths).
- `sandboxed`-style flag surfaced in the `start` SSE payload
  (`writeIsolated: true`) so the web client can show it, mirroring
  `sandboxed`.

### Gate

- App-config / env: `OD_WRITE_ISOLATION = on | off | required`
  (default Phase 1: `off`; Phase 2: `on` for darwin).
  `on` = isolate when possible, warn-and-run otherwise;
  `required` = refuse to run unisolated.
- Per-run override for debugging (chat body flag), owner-only.

### App-as-workspace integration (ties into the app/feature restructure)

This spec is cwd-shape-agnostic: today `cwd` = feature project dir. When the
app-as-workspace model lands (app root = workspace, feature = folder), the
same plan is built with `cwd = <appRoot>/features/<current>` — the agent
reads the whole app tree (default-allow covers reads), writes only its
feature folder. The docker tier gets the equivalent via nested mounts:
`-v appRoot:/work/app:ro` + `-v appRoot/features/X:/work/app/features/X:rw`
(more-specific mount wins). No new mechanism needed in either tier.

## Risks / open points

1. **Unknown write paths of tools-in-run** (MCP servers, playwright, drawio
   chromium). Mitigation: the big cache/temp allowlist above covers the
   common ones; Phase 1 runs each workflow end-to-end on this machine and
   adds what surfaces. Denials show up as plain `EPERM` errors in the run
   stream — visible, not silent corruption.
2. **`sandbox-exec` disappearing in a future macOS.** Wrapper module is the
   only touch point; fallback = docker tier or Endpoint Security. Accepted.
3. **Path-with-quote edge cases** in profile generation. Unit-test escaping;
   reject cwds containing `"` outright (they don't occur in OD_DATA_DIR).
4. **dockerd writes bypass seatbelt** (see Feasibility). Documented; curated
   build scripts only mount cwd today.

## Phases

- **Phase 1 — module + wiring, default off.** `write-isolation.ts` (profile
  builder pure + unit-tested, planner, wrapper), server.ts seam, SSE flag,
  gate. Enable locally; run docs-review, docs-to-ui (ui-html + ui-react),
  docs-to-prd end-to-end; extend allowlist from real denials.
- **Phase 2 — default on (darwin).** `writableStatePaths` filled in for the
  runtimes actually used (codex, gemini, opencode…); `required` mode for
  pipeline runs.
- **Phase 3 — app-workspace scope.** When feature-as-folder lands: writable
  root = `features/<current>`, app root readable; docker tier gets the
  `:ro`/`:rw` nested mounts. Optional: linked dirs become read-only.

## Test plan

- **Unit** (`write-isolation.test.ts`): profile text for a given input —
  allowlist entries, realpath resolution, quote rejection; planner returns
  null off-darwin / when binary missing / gate off.
- **Integration** (darwin-only, skipped elsewhere): spawn
  `sandbox-exec -f <profile> bash` running a write matrix — inside cwd OK;
  sibling dir, `$HOME` stray file, chmod-then-write all EPERM; reads OK;
  `python3` child write denied.
- **End-to-end**: one real run per workflow with gate `required`; assert run
  completes and `git -C .odhistory diff` (or media push diff) touches only
  the run's own workspace.
