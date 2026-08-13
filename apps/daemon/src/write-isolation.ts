// Run write isolation: kernel-enforced write scope for every agent run
// (docs/run-write-isolation-spec.md). Phase 1 wraps the ONE spawn seam in
// server.ts with `/usr/bin/sandbox-exec` (macOS Seatbelt) so a run can write
// only inside its own cwd + a curated allowlist of OS/tool scratch and cache
// dirs — everything else on disk stays READABLE (Seatbelt's `(allow default)`
// leaves reads and every non-file-write operation untouched) but not
// writable, even by a child process the agent spawns (chmod-lifting the guard
// does not work: the kernel enforces this, not file mode bits).
//
// This module owns the isolation tier end-to-end:
//   - `writeIsolationMode`      — the gate (OD_WRITE_ISOLATION env).
//   - `buildWriteIsolationProfile` — pure profile-text builder, unit-tested
//     directly (no filesystem, no sandbox-exec).
//   - `planWriteIsolation`     — decides whether isolation is possible on
//     this host/run and, if so, writes the per-run profile file.
//   - `wrapInvocationInWriteIsolation` — pure host invocation rewrite, the
//     same shape as `wrapInvocationInSandbox` in agent-sandbox.ts.
//
// Self-contained on purpose: no imports beyond node builtins, so this module
// can be wired into server.ts (or swapped for a different backend later —
// `sandbox-exec` is deprecated API, see the spec's risk #2) without pulling
// in daemon-wide dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The only Seatbelt entry point this module shells out to. Exported so
 *  callers (and tests) can assert the exact binary without re-deriving it. */
export const WRITE_ISOLATION_BIN = '/usr/bin/sandbox-exec';

/**
 * Gate. `on` = isolate when possible, warn-and-run unisolated otherwise;
 * `required` = refuse to run unisolated (caller's responsibility — this
 * module only reports the mode, it does not itself fail loudly).
 *
 * Phase 2 default: `on` on darwin (Seatbelt/`sandbox-exec` is macOS-only, and
 * this is the platform every run actually gets isolated on today), `off`
 * everywhere else — Linux/Windows have no enforcement mechanism yet (Phase 3
 * per docs/run-write-isolation-spec.md), so defaulting them to `on` would
 * just be a no-op mode name with no isolation behind it. `OD_WRITE_ISOLATION`
 * always wins over the platform default in either direction (explicit `off`
 * on darwin, or explicit `on`/`required` off-darwin for testing the fail path).
 */
export function writeIsolationMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): 'on' | 'off' | 'required' {
  const raw = (env.OD_WRITE_ISOLATION ?? '').trim().toLowerCase();
  if (raw === 'on' || raw === 'off' || raw === 'required') return raw;
  return platform === 'darwin' ? 'on' : 'off';
}

export interface BuildWriteIsolationProfileInput {
  /** The ONLY project-area writable root. Callers should pass the
   *  realpath-resolved cwd — Seatbelt matches the canonical
   *  `/private/tmp/...` path, not the `/tmp/...` symlink macOS presents. */
  cwd: string;
  /** Linked dirs / other runtimes' state dirs, granted writable verbatim
   *  (preserves today's behavior; tightening to read-only is a later,
   *  separate decision per the spec). */
  extraWritableDirs: string[];
  home: string;
}

/**
 * Pure Seatbelt profile-text builder — no filesystem access, no dependency on
 * `os.homedir()` or realpath resolution, so every input is explicit and the
 * output is unit-testable byte-for-byte. See the spec's "The profile"
 * section for the exact allowlist and its rationale (scratch/temp dirs,
 * Claude session state, package-manager caches).
 *
 * Default-allow, single deny class, explicit write allowlist: `(allow
 * default)` leaves every non-file-write operation untouched (network, mach,
 * ipc, exec — so e.g. Keychain reads via securityd are unaffected), `(deny
 * file-write*)` blocks all writes, and the one `(allow file-write* …)` block
 * re-opens exactly the paths a run legitimately needs to touch.
 *
 * Rejects `cwd`, `home`, and every `extraWritableDirs` entry that contains a
 * double-quote, a backslash, or a control character (code point < 0x20 —
 * e.g. a stray newline). Quotes obviously break out of the `"…"` literal;
 * backslash is rejected too even though Seatbelt's S-expression reader
 * treats it as a plain character in most positions, because a *trailing*
 * backslash immediately before the closing `"` would be read as an escape
 * for that quote and swallow it — silently merging this literal with
 * whatever text follows. Fail-closed here beats a spawn-time Seatbelt syntax
 * error that is confusing to trace back to one path.
 */
export function buildWriteIsolationProfile(input: BuildWriteIsolationProfileInput): string {
  const { cwd, extraWritableDirs, home } = input;

  // eslint-disable-next-line no-control-regex -- intentionally matching control chars to reject them
  const UNSAFE_PATH_CHAR_RE = /["\\\x00-\x1f]/;
  const assertSafePathChars = (label: string, value: string): void => {
    if (UNSAFE_PATH_CHAR_RE.test(value)) {
      throw new Error(
        `write-isolation: ${label} contains a double-quote, backslash, or control character: ${JSON.stringify(value)}`,
      );
    }
  };
  assertSafePathChars('cwd', cwd);
  assertSafePathChars('home', home);
  for (const dir of extraWritableDirs) assertSafePathChars('extraWritableDirs entry', dir);

  const claudeDir = path.join(home, '.claude');
  const claudeJson = path.join(home, '.claude.json');
  const claudeJsonBackup = path.join(home, '.claude.json.backup');
  const npmDir = path.join(home, '.npm');
  const cacheDir = path.join(home, '.cache');
  const pnpmDir = path.join(home, 'Library', 'pnpm');
  const cachesDir = path.join(home, 'Library', 'Caches');

  // Built-in subpaths (used both to emit the profile AND to dedupe extras
  // against below) — order matches the spec's "The profile" listing exactly.
  const builtinSubpaths = [cwd, '/private/tmp', '/private/var/folders', claudeDir, npmDir, cacheDir, pnpmDir, cachesDir];

  const seen = new Set(builtinSubpaths);
  const dedupedExtras: string[] = [];
  for (const dir of extraWritableDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    dedupedExtras.push(dir);
  }

  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    `  (subpath "${cwd}")`,
    // run scratch + OS temp — everything a CLI expects to be able to touch
    '  (subpath "/private/tmp")',
    '  (subpath "/private/var/folders")', // TMPDIR lives here per-user
    '  (regex #"^/dev/")', // /dev/null, ttys, /dev/fd
    // agent runtime state — CLI session files, transcripts, caches
    `  (subpath "${claudeDir}")`,
    `  (literal "${claudeJson}")`,
    `  (literal "${claudeJsonBackup}")`,
    // package-manager caches so in-run npx/pnpm/npm keep working
    `  (subpath "${npmDir}")`,
    `  (subpath "${cacheDir}")`,
    `  (subpath "${pnpmDir}")`,
    `  (subpath "${cachesDir}")`,
    // per-run extras (linked dirs, other runtimes' state dirs)
    ...dedupedExtras.map((dir) => `  (subpath "${dir}")`),
    ')',
  ];
  return `${lines.join('\n')}\n`;
}

const sanitizeRunId = (raw: string): string => raw.replace(/[^A-Za-z0-9._-]/g, '-');

export interface PlanWriteIsolationInput {
  cwd: string;
  extraWritableDirs?: string[];
  runId: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to the real host platform. */
  platform?: NodeJS.Platform;
}

export interface WriteIsolationPlan {
  profilePath: string;
}

/**
 * Decide whether this run can be write-isolated and, if so, write its
 * per-run Seatbelt profile file. Resolves `null` (does NOT reject) when
 * isolation is not applicable or not possible:
 *
 *   - gate is `off` (`writeIsolationMode` reads `OD_WRITE_ISOLATION`)
 *   - platform is not `darwin` (Seatbelt is macOS-only; Linux/Windows run
 *     unisolated in Phase 1 — the caller logs this loudly per the spec)
 *   - `/usr/bin/sandbox-exec` is missing (defensive: the binary is
 *     deprecated API and could disappear in a future macOS)
 *
 * `null` vs "isolation requested but impossible" is a caller-level decision
 * (mirrors `AGENT_SANDBOX_UNAVAILABLE`): this function only reports
 * possibility, it never fails loudly itself.
 *
 * This promise CAN still reject, though — it is not a pure "never throws"
 * function. Two things beyond the null-cases above can fail:
 *
 *   - `buildWriteIsolationProfile` throws on a resolved cwd, `os.homedir()`,
 *     or an `extraWritableDirs` entry that contains a character the profile
 *     can't safely embed (quote, backslash, control char — see its
 *     docblock). By the time this runs, sandbox-exec is confirmed present,
 *     so this is a real "isolation was requested but the input is
 *     unrepresentable" failure, not a "not possible here" one.
 *   - `fs.promises.mkdtemp` / `fs.promises.writeFile` can reject (disk full,
 *     permissions, tmpdir gone).
 *
 * Callers are expected to catch: server.ts treats a rejection the same way
 * it treats `AGENT_SANDBOX_UNAVAILABLE` — isolation-requested-but-failed,
 * not a silent fall-back to unisolated. Do not wrap this call in a
 * swallow-and-continue `catch`.
 */
export async function planWriteIsolation(
  input: PlanWriteIsolationInput,
): Promise<WriteIsolationPlan | null> {
  const env = input.env ?? process.env;
  if (writeIsolationMode(env) === 'off') return null;

  const platform = input.platform ?? process.platform;
  if (platform !== 'darwin') return null;

  try {
    await fs.promises.access(WRITE_ISOLATION_BIN, fs.constants.X_OK);
  } catch {
    return null;
  }

  // Seatbelt matches the canonical path, not a symlink (macOS's /tmp ->
  // /private/tmp being the prototypical case) — realpath-resolve the cwd
  // before it goes into the profile. Fall back to the raw cwd on failure
  // (e.g. the dir doesn't exist yet) rather than throwing: a stale/odd cwd
  // should fail at spawn time with a clear error, not here.
  let resolvedCwd: string;
  try {
    resolvedCwd = await fs.promises.realpath(input.cwd);
  } catch {
    resolvedCwd = input.cwd;
  }

  const home = os.homedir();
  const profileText = buildWriteIsolationProfile({
    cwd: resolvedCwd,
    extraWritableDirs: input.extraWritableDirs ?? [],
    home,
  });

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'od-write-iso-'));
  const profilePath = path.join(dir, `write-isolation-${sanitizeRunId(input.runId)}.sb`);
  await fs.promises.writeFile(profilePath, profileText, 'utf8');
  return { profilePath };
}

export interface CommandInvocation {
  command: string;
  args: string[];
}

/**
 * Pure host invocation rewrite — `sandbox-exec` `exec`s the target, so this
 * stays transparent to stdio (stdin-first prompt delivery, streamed
 * stdout/stderr parsing all keep working unchanged).
 */
export function wrapInvocationInWriteIsolation(
  inv: CommandInvocation,
  plan: WriteIsolationPlan,
): CommandInvocation {
  return {
    command: WRITE_ISOLATION_BIN,
    args: ['-f', plan.profilePath, inv.command, ...inv.args],
  };
}
