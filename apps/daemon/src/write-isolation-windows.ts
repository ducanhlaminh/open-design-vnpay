// Run write isolation: kernel-enforced write scope for every agent run
// (docs/run-write-isolation-spec.md) — WINDOWS backend, a second isolation
// tier that runs alongside `write-isolation.ts` (macOS/Seatbelt). That file
// owns the darwin tier end-to-end and is NOT touched by this one; this
// module is additive and self-contained on purpose, mirroring its shape
// function-for-function so server.ts's spawn seam only needs to branch on
// `process.platform`, not learn a second API:
//
//   - `restrictedTokenIsolationMode`             — the gate (OD_WRITE_ISOLATION).
//   - `planRestrictedTokenIsolation`              — decides whether isolation is
//     possible for this run and, if so, resolves the writable-roots list.
//   - `wrapInvocationInRestrictedTokenIsolation`  — pure host invocation
//     rewrite, the Windows analogue of `wrapInvocationInWriteIsolation`.
//
// Mechanism (verified feasible against a real shipped product, NOT invented
// for this module — see specs/change/20260814-windows-write-isolation/spec.md
// for the research trail): OpenAI Codex CLI's Windows "unelevated" sandbox
// uses a Win32 WRITE-RESTRICTED token — `CreateRestrictedToken(...,
// WRITE_RESTRICTED, ...)` with a restricting-SID list of [Everyone,
// this-logon-session] — combined with an explicit `Everyone:(OI)(CI)W` ACE
// planted on each writable root via `icacls`. A write-restricted token's
// access checks for WRITE operations are evaluated TWICE — once against the
// token's normal (enabled) SID list, once against the restricting-SID list
// alone — and both must grant access; every other access class (read, exec,
// network, mach/ipc-equivalent) is checked only the normal way and is
// therefore untouched. Concretely: a directory that has NOT been granted
// `Everyone:W` denies the restricted token's write attempt even though the
// real user account backing the token has full write access there via
// inherited ACLs; a directory we `icacls ... /grant Everyone:(OI)(CI)W`
// beforehand passes both checks. No admin/elevation is required and no other
// user is impersonated — `CreateProcessAsUser`'s SE_ASSIGNPRIMARYTOKEN_NAME
// privilege requirement is waived by Windows specifically for the case where
// the token being used is a *restricted* duplicate of the caller's OWN
// primary token (this exemption is what makes the whole "unelevated mode"
// possible; see Microsoft Learn's Restricted Tokens documentation).
//
// The actual mechanics live in a PowerShell + inline C# (`Add-Type
// -TypeDefinition`) script built by `buildRestrictedTokenPowerShellScript`
// below, following the repo's existing precedent for building PowerShell
// commands as template strings directly in a `.ts` file rather than shipping
// a separate `.ps1` resource (see `native-folder-dialog.ts`).
//
// KNOWN LIMITATION (documented here on purpose, not hidden — same honesty
// standard as write-isolation.ts's own docblocks): if a writable root ALREADY
// has an ACE granting "Everyone: Write" (or any SID present in the
// restricting-SID list) before this module plants its own, the double-check
// the restricted token relies on was already going to pass on that path
// regardless of what we plant — the restricted-SID mechanism adds no
// additional barrier there. This is rare for a normal per-user project
// directory (the common case this module targets) but is a real, accepted
// gap; the Codex CLI team's own research documents the identical limitation
// for their sandbox. Not solved by this module, per the spec's explicit
// "Ngoài phạm vi".
//
// VERIFICATION STATUS (be honest about this — do not let a green
// `pnpm typecheck` be mistaken for "the mechanism works"): everything in this
// file below the "pure / unit-tested" functions — i.e. the actual
// CreateRestrictedToken / icacls / CreateProcessAsUser sequence embedded in
// the generated PowerShell text — has NOT been executed on a real Windows
// host from this change. The dev machine that authored this module is
// macOS; there is no Windows host available to run it. Only the gate logic
// (`restrictedTokenIsolationMode`) and the pure string-building functions
// (`planRestrictedTokenIsolation`'s writable-roots resolution,
// `wrapInvocationInRestrictedTokenIsolation`'s rewrite shape, and the
// PowerShell/argv quoting helpers) are unit-tested here. Whether
// `CreateRestrictedToken` + the planted ACE actually block a write outside
// the allowlist while leaving it inside — the entire point of this module —
// can only be confirmed by a `windows-latest` CI job that spawns this wrap
// and asserts both the allow and the deny cases (see the spec's Acceptance
// criteria). Do not treat this module as validated until that CI leg exists
// and passes.

/** The only entry point this module shells out to. Exported so callers (and
 *  tests) can assert the exact binary without re-deriving it — mirrors
 *  `WRITE_ISOLATION_BIN` in write-isolation.ts. */
export const RESTRICTED_TOKEN_ISOLATION_BIN = 'powershell.exe';

/**
 * Gate. Same three-state semantics as `writeIsolationMode` in
 * write-isolation.ts (`on`/`off`/`required`, `OD_WRITE_ISOLATION`), but the
 * unset-env-var default is `off` on EVERY platform right now — including
 * win32 — unlike write-isolation.ts's darwin default of `on`. This backend
 * has no windows-latest CI smoke test proving `CreateRestrictedToken`
 * actually gates writes end-to-end yet (see this file's top docblock and the
 * spec's Acceptance #3); flipping the win32 default to `on` once that CI leg
 * exists and passes is a deliberate, separate follow-up change, not part of
 * this one. `platform` is accepted (and threaded through, unused for now) so
 * that follow-up is a one-line diff in this function, not a signature change
 * at every call site.
 */
export function restrictedTokenIsolationMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): 'on' | 'off' | 'required' {
  const raw = (env.OD_WRITE_ISOLATION ?? '').trim().toLowerCase();
  if (raw === 'on' || raw === 'off' || raw === 'required') return raw;
  void platform;
  return 'off';
}

export interface PlanRestrictedTokenIsolationInput {
  /** The ONLY project-area writable root. Unlike write-isolation.ts's `cwd`,
   *  this is NOT realpath-resolved — Windows has no `/tmp` -> `/private/tmp`
   *  style symlink quirk for the paths this module deals with, and `icacls`
   *  operates on the path exactly as given. */
  cwd: string;
  /** Linked dirs / other runtimes' state dirs, granted writable verbatim —
   *  same caller-resolved absolute paths write-isolation.ts's
   *  `extraWritableDirs` receives (e.g. `resolveWritableStatePaths(home,
   *  def.writableStatePaths)` folded in by server.ts). */
  extraWritableRoots?: string[];
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to the real host platform. */
  platform?: NodeJS.Platform;
}

export interface RestrictedTokenIsolationPlan {
  /** Absolute writable roots this run's restricted token is allowed to write
   *  under — cwd first, then extraWritableRoots, deduped (exact-string; a
   *  differently-cased duplicate on Windows' case-insensitive filesystem
   *  just costs one redundant `icacls` call, not a correctness bug). */
  writableRoots: string[];
}

/**
 * Decide whether this run can be restricted-token-isolated. Pure — no
 * filesystem access, no syscalls — unlike write-isolation.ts's
 * `planWriteIsolation` this never has to write a per-run profile FILE (the
 * profile-equivalent — the writable-roots list — is embedded directly into
 * the PowerShell script text at wrap time), so there is nothing here that
 * can reject; it simply resolves `null` when isolation does not apply:
 *
 *   - gate is `off` (`restrictedTokenIsolationMode` reads `OD_WRITE_ISOLATION`)
 *   - platform is not `win32` (this backend is Windows-only; darwin has its
 *     own tier in write-isolation.ts, Linux has none yet — Phase 1)
 *
 * Deliberately does NOT probe for `powershell.exe` on PATH the way
 * `planWriteIsolation` probes `/usr/bin/sandbox-exec` — that check is cheap
 * for macOS because the binary lives at one fixed absolute path;
 * `powershell.exe` is resolved via PATH by the eventual `spawn()` call, and
 * there is no equivalently cheap absolute-path check for it. A genuinely
 * missing/blocked PowerShell surfaces later as a normal spawn-time failure
 * instead of this function's `null` — a known, accepted gap (see this file's
 * top docblock's verification-status note).
 */
export function planRestrictedTokenIsolation(
  input: PlanRestrictedTokenIsolationInput,
): RestrictedTokenIsolationPlan | null {
  const env = input.env ?? process.env;
  if (restrictedTokenIsolationMode(env) === 'off') return null;

  const platform = input.platform ?? process.platform;
  if (platform !== 'win32') return null;

  const seen = new Set<string>();
  const writableRoots: string[] = [];
  for (const root of [input.cwd, ...(input.extraWritableRoots ?? [])]) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    writableRoots.push(root);
  }
  return { writableRoots };
}

export interface CommandInvocation {
  command: string;
  args: string[];
}

// ── Pure string-building helpers (unit-tested directly, no PowerShell
//    runtime involved — these only assert the TEXT they produce) ──────────

/**
 * Quote a single argv element the way the Win32 `CreateProcess` family (and
 * therefore `CreateProcessAsUser`) expects to find it in `lpCommandLine` —
 * the MSVCRT / `CommandLineToArgvW` parsing convention. This is deliberately
 * NOT the same algorithm as `quoteWindowsCommandArg` in
 * `packages/platform/src/index.ts` (that one is cmd.exe-specific: it also
 * neutralizes `%`-expansion because that invocation goes through `cmd.exe
 * /s /c`). Here there is no cmd.exe in the path at all — `CreateProcessAsUser`
 * launches the target binary directly — so only `"` and backslash-run-before-
 * quote sequences need escaping; `%` is passed through untouched.
 */
export function quoteArgvForCreateProcess(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

/** Build the single `lpCommandLine` string `CreateProcessAsUser` wants from a
 *  (command, args) pair, quoting each element per
 *  `quoteArgvForCreateProcess`. */
export function buildWin32CommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteArgvForCreateProcess).join(' ');
}

/** Escape a value for embedding as a PowerShell single-quoted string literal
 *  (`'...'`) — PowerShell single-quoted strings do not interpolate `$` or
 *  process escape sequences at all, so the ONLY character that needs
 *  handling is a literal `'`, escaped by doubling per PowerShell's own
 *  quoting rule. Deliberately used (instead of a double-quoted `"..."`
 *  literal) for every value embedded below so a path containing `"`, `\`, or
 *  `$` (all legal, common in real Windows paths / usernames) cannot break out
 *  of the literal or trigger PowerShell variable expansion. */
export function psSingleQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Build a PowerShell array-literal (`@('a', 'b')`) of single-quoted string
 *  literals. */
export function psSingleQuoteArrayLiteral(values: string[]): string {
  return `@(${values.map(psSingleQuoteLiteral).join(', ')})`;
}

// eslint-disable-next-line no-control-regex -- intentionally matching control chars to reject them
const UNSAFE_ROOT_CHAR_RE = /[\x00-\x1f]/;

/**
 * Windows write-isolation's path-safety check is intentionally NARROWER than
 * write-isolation.ts's `assertSafePathChars`: that one rejects `"` and `\`
 * too because they are dangerous inside a Seatbelt S-expression string
 * literal. Neither is dangerous here — both are handled correctly by
 * `psSingleQuoteLiteral`'s doubling, and `\` is the normal Windows path
 * separator (rejecting it would reject every Windows path). Only control
 * characters (a stray embedded newline, NUL, etc.) are rejected, same
 * fail-closed rationale as the macOS module: a raw newline inside what is
 * meant to be one array-literal entry produces a confusing-to-trace
 * PowerShell parse error instead of a clean, attributable failure here.
 */
function assertSafeRootChars(label: string, value: string): void {
  if (UNSAFE_ROOT_CHAR_RE.test(value)) {
    throw new Error(
      `write-isolation-windows: ${label} contains a control character: ${JSON.stringify(value)}`,
    );
  }
}

// The inline C# P/Invoke declarations Add-Type compiles into the PowerShell
// session. Kept as one constant so `buildRestrictedTokenPowerShellScript`'s
// PowerShell-side logic below (the part most useful to unit-test markers
// against) stays readable. See this file's top docblock for the mechanism
// this implements (WRITE_RESTRICTED token + planted ACE).
const RESTRICTED_TOKEN_CSHARP_TYPE = `
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class OdRestrictedToken {
    public const uint TOKEN_DUPLICATE = 0x0002;
    public const uint TOKEN_QUERY = 0x0008;
    public const uint TOKEN_ALL_ACCESS = 0x000F01FF;
    public const uint WRITE_RESTRICTED = 0x8;
    public const int TokenPrimary = 1;
    public const int SecurityImpersonation = 2;
    public const int TokenGroups = 2;
    public const uint SE_GROUP_LOGON_ID = 0xC0000000;
    public const uint STARTF_USESTDHANDLES = 0x00000100;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    public const int STD_INPUT_HANDLE = -10;
    public const int STD_OUTPUT_HANDLE = -11;
    public const int STD_ERROR_HANDLE = -12;
    public const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    public struct SID_AND_ATTRIBUTES {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
    }

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory")]
    public static extern void CopyMemory(IntPtr dest, IntPtr src, uint count);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool DuplicateTokenEx(IntPtr hExistingToken, uint dwDesiredAccess, IntPtr lpTokenAttributes, int ImpersonationLevel, int TokenType, out IntPtr phNewToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, int TokenInformationLength, out int ReturnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool CreateRestrictedToken(IntPtr ExistingTokenHandle, uint Flags, uint DisableSidCount, IntPtr SidsToDisable, uint DeletePrivilegeCount, IntPtr PrivilegesToDelete, uint RestrictedSidCount, [In] SID_AND_ATTRIBUTES[] SidsToRestrict, out IntPtr NewTokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern int GetLengthSid(IntPtr pSid);

    // lpCommandLine MUST be a StringBuilder (a real mutable native buffer),
    // never a managed 'string' -- CreateProcess-family APIs are documented to
    // write back into this buffer, and marshaling a 'string' there risks
    // corrupting an interned literal. This is a well-known P/Invoke pitfall,
    // not an oversight.
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    // Scans this process's own TokenGroups for the one entry flagged
    // SE_GROUP_LOGON_ID (the per-logon-session SID) and returns a copy of it
    // (Marshal.AllocHGlobal'd — caller/process teardown reclaims it; this
    // script's process lifetime is one agent run). Returns IntPtr.Zero if no
    // logon-session group is present (rare token shapes) — the caller treats
    // that as "restrict to Everyone alone".
    public static IntPtr GetLogonSidCopy(IntPtr hToken) {
        int len;
        GetTokenInformation(hToken, TokenGroups, IntPtr.Zero, 0, out len);
        if (len <= 0) return IntPtr.Zero;
        IntPtr buffer = Marshal.AllocHGlobal(len);
        try {
            if (!GetTokenInformation(hToken, TokenGroups, buffer, len, out len)) {
                throw new InvalidOperationException("GetTokenInformation(TokenGroups) failed, error " + Marshal.GetLastWin32Error());
            }
            int groupCount = Marshal.ReadInt32(buffer);
            int headerSize = IntPtr.Size == 8 ? 8 : 4;
            int entrySize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            for (int i = 0; i < groupCount; i++) {
                IntPtr entryPtr = IntPtr.Add(buffer, headerSize + i * entrySize);
                SID_AND_ATTRIBUTES entry = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(entryPtr, typeof(SID_AND_ATTRIBUTES));
                if ((entry.Attributes & SE_GROUP_LOGON_ID) != 0) {
                    int sidLen = GetLengthSid(entry.Sid);
                    IntPtr sidCopy = Marshal.AllocHGlobal(sidLen);
                    CopyMemory(sidCopy, entry.Sid, (uint)sidLen);
                    return sidCopy;
                }
            }
            return IntPtr.Zero;
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
`;

export interface BuildRestrictedTokenScriptInput {
  writableRoots: string[];
  /** Pre-quoted (via `buildWin32CommandLine`) full command line for
   *  `CreateProcessAsUser`'s `lpCommandLine`. */
  commandLine: string;
}

/**
 * Pure PowerShell script-text builder — no filesystem access, no PowerShell
 * runtime involved, so the output is unit-testable byte-for-byte (well,
 * marker-by-marker: unlike `buildWriteIsolationProfile`'s small S-expression
 * output, asserting this script's full text line-for-line is not useful —
 * tests instead assert it contains the load-bearing calls/flags in the right
 * relative order). Mirrors `buildWriteIsolationProfile`'s role in
 * write-isolation.ts: this is the one place that turns plan data into the
 * text that actually gets executed.
 *
 * Every value that becomes PowerShell TEXT here goes in via
 * `psSingleQuoteLiteral` / `psSingleQuoteArrayLiteral` — single-quoted
 * PowerShell string literals do not expand `$variables` or process escape
 * sequences, so this is injection-safe against `"`, `\`, `$`, and backticks
 * in a path; only a literal `'` needs (and gets) escaping. Control
 * characters are rejected up front by `assertSafeRootChars` for the
 * fail-closed reasons documented there.
 *
 * Order of operations in the generated script, matching the spec's design:
 *   1. `icacls <root> /grant Everyone:(OI)(CI)W` for every writable root —
 *      plants the ACE the write-restricted token's double-check needs to
 *      pass on that root.
 *   2. `Add-Type` the C# P/Invoke surface (`RESTRICTED_TOKEN_CSHARP_TYPE`).
 *   3. Duplicate this process's own token to a primary token, then
 *      `CreateRestrictedToken(..., WRITE_RESTRICTED, ...)` restricting to
 *      [Everyone, this logon session's SID]. No admin/elevation, no
 *      impersonation of another user — see this file's top docblock.
 *   4. Build a Unicode environment block from THIS PowerShell process's own
 *      environment (`Get-ChildItem Env:` — already exactly the `env` object
 *      server.ts passed to `spawn()`, since PowerShell is the direct Node
 *      child) and pass it explicitly via `lpEnvironment` +
 *      `CREATE_UNICODE_ENVIRONMENT`. Deliberately NOT `lpEnvironment =
 *      NULL`: Microsoft's docs for `CreateProcessAsUser` say a NULL
 *      `lpEnvironment` builds the new process's environment from the
 *      *token's user profile*, not from the calling process — with a
 *      restricted token that is a real, easy-to-miss way to silently drop
 *      every env var the daemon set for this run (auth tokens, model
 *      config, WP2's whitelist). Building the block explicitly avoids that.
 *   5. `CreateProcessAsUser` with `STARTF_USESTDHANDLES` pointed at this
 *      process's own inherited stdin/stdout/stderr (so the grandchild's
 *      stdio lands on the same pipes Node gave `powershell.exe`) and
 *      `bInheritHandles = true`. NOTE (flagged honestly, not solved here):
 *      whether Node's Windows named-pipe stdio handles survive this
 *      SECOND hop of inheritance (Node -> powershell.exe -> the restricted
 *      grandchild) is exactly the kind of thing that needs the
 *      `windows-latest` CI smoke test to confirm — nested handle
 *      inheritance through `CreateProcessAsUser` is a known-finicky area of
 *      Win32 even outside this restricted-token context.
 *   6. Wait for exit, capture the exit code.
 *   7. `icacls <root> /remove:g Everyone` for every writable root — undo the
 *      ACE planted in step 1 so the run does not leave the machine more
 *      writable than it found it (spec's step 5; cleanup is attempted on
 *      both the success and the `CreateProcessAsUser` launch-failure paths).
 *   8. `exit $exitCode` — propagates the grandchild's real exit code as
 *      `powershell.exe`'s own exit code, since server.ts's spawn() reads
 *      the DIRECT child's (`powershell.exe`'s) exit code as the run's
 *      result. This is the one place this backend is NOT exec-transparent
 *      like macOS's `sandbox-exec -f profile cmd args` (which literally
 *      execs the target) — Windows has no equivalent "exec, replace this
 *      process" primitive usable here, so the exit code is forwarded
 *      explicitly instead.
 */
export function buildRestrictedTokenPowerShellScript(input: BuildRestrictedTokenScriptInput): string {
  const { writableRoots, commandLine } = input;
  writableRoots.forEach((root, i) => assertSafeRootChars(`writableRoots[${i}]`, root));
  assertSafeRootChars('commandLine', commandLine);

  const rootsLiteral = psSingleQuoteArrayLiteral(writableRoots);
  const commandLineLiteral = psSingleQuoteLiteral(commandLine);

  const lines: string[] = [
    '$ErrorActionPreference = "Stop"',
    `$writableRoots = ${rootsLiteral}`,
    `$commandLine = ${commandLineLiteral}`,
    '',
    '# Step 1: plant the write ACE every writable root needs for the',
    "# restricted token's double-check to pass on it (see this file's",
    '# write-isolation-windows.ts docblock).',
    'foreach ($root in $writableRoots) {',
    '  if (Test-Path -LiteralPath $root) {',
    '    icacls $root /grant "Everyone:(OI)(CI)W" | Out-Null',
    '  }',
    '}',
    '',
    `Add-Type -TypeDefinition @'${RESTRICTED_TOKEN_CSHARP_TYPE}'@`,
    '',
    '$cleanupAces = {',
    '  foreach ($root in $writableRoots) {',
    '    if (Test-Path -LiteralPath $root) {',
    "      icacls $root '/remove:g' 'Everyone' | Out-Null",
    '    }',
    '  }',
    '}',
    '',
    '$hProcessToken = [IntPtr]::Zero',
    '[OdRestrictedToken]::OpenProcessToken([OdRestrictedToken]::GetCurrentProcess(), [OdRestrictedToken]::TOKEN_ALL_ACCESS, [ref]$hProcessToken) | Out-Null',
    'if ($hProcessToken -eq [IntPtr]::Zero) { throw "OpenProcessToken failed" }',
    '',
    '$hPrimaryToken = [IntPtr]::Zero',
    '[OdRestrictedToken]::DuplicateTokenEx($hProcessToken, [OdRestrictedToken]::TOKEN_ALL_ACCESS, [IntPtr]::Zero, [OdRestrictedToken]::SecurityImpersonation, [OdRestrictedToken]::TokenPrimary, [ref]$hPrimaryToken) | Out-Null',
    'if ($hPrimaryToken -eq [IntPtr]::Zero) { throw "DuplicateTokenEx failed" }',
    '',
    '# Everyone (S-1-1-0) is a universal well-known SID, not something that',
    "# needs to come from THIS token's group list — .NET's SecurityIdentifier",
    '# resolves it directly.',
    '$everyoneSid = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::WorldSid, $null)',
    '$everyoneBytes = New-Object byte[] ($everyoneSid.BinaryLength)',
    '$everyoneSid.GetBinaryForm($everyoneBytes, 0)',
    '$everyoneSidPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($everyoneBytes.Length)',
    '[System.Runtime.InteropServices.Marshal]::Copy($everyoneBytes, 0, $everyoneSidPtr, $everyoneBytes.Length)',
    '',
    '# The logon-session SID IS token-specific — has to come from this',
    "# process's own TokenGroups.",
    '$logonSidPtr = [OdRestrictedToken]::GetLogonSidCopy($hPrimaryToken)',
    '',
    '$restrictList = New-Object "System.Collections.Generic.List[OdRestrictedToken+SID_AND_ATTRIBUTES]"',
    '$everyoneEntry = New-Object OdRestrictedToken+SID_AND_ATTRIBUTES',
    '$everyoneEntry.Sid = $everyoneSidPtr',
    '$everyoneEntry.Attributes = 0',
    '$restrictList.Add($everyoneEntry)',
    'if ($logonSidPtr -ne [IntPtr]::Zero) {',
    '  $logonEntry = New-Object OdRestrictedToken+SID_AND_ATTRIBUTES',
    '  $logonEntry.Sid = $logonSidPtr',
    '  $logonEntry.Attributes = 0',
    '  $restrictList.Add($logonEntry)',
    '}',
    '$sidsToRestrict = $restrictList.ToArray()',
    '',
    '$hRestrictedToken = [IntPtr]::Zero',
    '$restricted = [OdRestrictedToken]::CreateRestrictedToken($hPrimaryToken, [OdRestrictedToken]::WRITE_RESTRICTED, 0, [IntPtr]::Zero, 0, [IntPtr]::Zero, [uint32]$sidsToRestrict.Length, $sidsToRestrict, [ref]$hRestrictedToken)',
    'if (-not $restricted) {',
    '  throw ("CreateRestrictedToken failed, error " + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())',
    '}',
    '',
    '# Build the child environment block explicitly from THIS process\'s own',
    "# environment — a NULL lpEnvironment would instead build it from the",
    "# restricted token's user profile, silently dropping every env var",
    '# server.ts set for this run (auth, model config, the WP2 whitelist).',
    '$envBuilder = New-Object System.Text.StringBuilder',
    'foreach ($item in Get-ChildItem Env:) {',
    '  [void]$envBuilder.Append($item.Name)',
    "  [void]$envBuilder.Append('=')",
    '  [void]$envBuilder.Append($item.Value)',
    '  [void]$envBuilder.Append([char]0)',
    '}',
    '[void]$envBuilder.Append([char]0)',
    '$envChars = $envBuilder.ToString().ToCharArray()',
    '$envBlockPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($envChars.Length * 2)',
    '[System.Runtime.InteropServices.Marshal]::Copy($envChars, 0, $envBlockPtr, $envChars.Length)',
    '',
    '$si = New-Object OdRestrictedToken+STARTUPINFO',
    '$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)',
    '$si.dwFlags = [OdRestrictedToken]::STARTF_USESTDHANDLES',
    '$si.hStdInput = [OdRestrictedToken]::GetStdHandle([OdRestrictedToken]::STD_INPUT_HANDLE)',
    '$si.hStdOutput = [OdRestrictedToken]::GetStdHandle([OdRestrictedToken]::STD_OUTPUT_HANDLE)',
    '$si.hStdError = [OdRestrictedToken]::GetStdHandle([OdRestrictedToken]::STD_ERROR_HANDLE)',
    '',
    '$pi = New-Object OdRestrictedToken+PROCESS_INFORMATION',
    '$cmdLineBuilder = New-Object System.Text.StringBuilder($commandLine, $commandLine.Length + 32)',
    '$launched = [OdRestrictedToken]::CreateProcessAsUser($hRestrictedToken, $null, $cmdLineBuilder, [IntPtr]::Zero, [IntPtr]::Zero, $true, [OdRestrictedToken]::CREATE_UNICODE_ENVIRONMENT, $envBlockPtr, (Get-Location).Path, [ref]$si, [ref]$pi)',
    'if (-not $launched) {',
    '  $launchError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()',
    '  & $cleanupAces',
    '  throw ("CreateProcessAsUser failed, error " + $launchError)',
    '}',
    '',
    '[OdRestrictedToken]::WaitForSingleObject($pi.hProcess, [OdRestrictedToken]::INFINITE) | Out-Null',
    '$exitCodeRef = 0',
    '[OdRestrictedToken]::GetExitCodeProcess($pi.hProcess, [ref]$exitCodeRef) | Out-Null',
    '',
    '& $cleanupAces',
    '',
    '[OdRestrictedToken]::CloseHandle($pi.hProcess) | Out-Null',
    '[OdRestrictedToken]::CloseHandle($pi.hThread) | Out-Null',
    '[OdRestrictedToken]::CloseHandle($hRestrictedToken) | Out-Null',
    '[OdRestrictedToken]::CloseHandle($hPrimaryToken) | Out-Null',
    '[OdRestrictedToken]::CloseHandle($hProcessToken) | Out-Null',
    '',
    'exit $exitCodeRef',
  ];
  return lines.join('\n');
}

/**
 * Pure host invocation rewrite — the Windows analogue of
 * `wrapInvocationInWriteIsolation`. Unlike that one, this is NOT
 * exec-transparent (see `buildRestrictedTokenPowerShellScript`'s docblock,
 * step 8): `powershell.exe` stays alive for the duration of the run to
 * perform ACE cleanup after the grandchild exits, then forwards its exit
 * code explicitly. Stdio stays transparent (`CreateProcessAsUser` inherits
 * `powershell.exe`'s own stdio handles), which is what stdin-first prompt
 * delivery and streamed stdout/stderr parsing need.
 */
export function wrapInvocationInRestrictedTokenIsolation(
  inv: CommandInvocation,
  plan: RestrictedTokenIsolationPlan,
): CommandInvocation {
  const commandLine = buildWin32CommandLine(inv.command, inv.args);
  const script = buildRestrictedTokenPowerShellScript({
    writableRoots: plan.writableRoots,
    commandLine,
  });
  return {
    command: RESTRICTED_TOKEN_ISOLATION_BIN,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
  };
}
