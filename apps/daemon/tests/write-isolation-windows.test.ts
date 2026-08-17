import { describe, expect, it } from 'vitest';
import {
  RESTRICTED_TOKEN_ISOLATION_BIN,
  buildRestrictedTokenPowerShellScript,
  buildWin32CommandLine,
  planRestrictedTokenIsolation,
  psSingleQuoteArrayLiteral,
  psSingleQuoteLiteral,
  quoteArgvForCreateProcess,
  restrictedTokenIsolationMode,
  wrapInvocationInRestrictedTokenIsolation,
} from '../src/write-isolation-windows.js';

describe('restrictedTokenIsolationMode', () => {
  it('defaults to off on every platform when the env var is unset, including win32', () => {
    expect(restrictedTokenIsolationMode({}, 'win32')).toBe('off');
    expect(restrictedTokenIsolationMode({}, 'darwin')).toBe('off');
    expect(restrictedTokenIsolationMode({}, 'linux')).toBe('off');
  });

  it('parses on/off/required regardless of platform', () => {
    expect(restrictedTokenIsolationMode({ OD_WRITE_ISOLATION: 'on' }, 'win32')).toBe('on');
    expect(restrictedTokenIsolationMode({ OD_WRITE_ISOLATION: 'off' }, 'win32')).toBe('off');
    expect(restrictedTokenIsolationMode({ OD_WRITE_ISOLATION: 'required' }, 'win32')).toBe('required');
  });

  it('falls back to off on an unrecognized value', () => {
    expect(restrictedTokenIsolationMode({ OD_WRITE_ISOLATION: 'yes' }, 'win32')).toBe('off');
    expect(restrictedTokenIsolationMode({ OD_WRITE_ISOLATION: '1' }, 'win32')).toBe('off');
    expect(restrictedTokenIsolationMode({ OD_WRITE_ISOLATION: '' }, 'win32')).toBe('off');
  });
});

describe('planRestrictedTokenIsolation', () => {
  it('returns null when the gate is off, regardless of platform', () => {
    const plan = planRestrictedTokenIsolation({
      cwd: 'C:\\Users\\dev\\project',
      env: { OD_WRITE_ISOLATION: 'off' },
      platform: 'win32',
    });
    expect(plan).toBeNull();
  });

  it('returns null off-win32 even with the gate on', () => {
    const plan = planRestrictedTokenIsolation({
      cwd: 'C:\\Users\\dev\\project',
      env: { OD_WRITE_ISOLATION: 'on' },
      platform: 'darwin',
    });
    expect(plan).toBeNull();
    const plan2 = planRestrictedTokenIsolation({
      cwd: '/data/projects/p1',
      env: { OD_WRITE_ISOLATION: 'required' },
      platform: 'linux',
    });
    expect(plan2).toBeNull();
  });

  it('resolves cwd + extraWritableRoots on win32 with the gate on', () => {
    const plan = planRestrictedTokenIsolation({
      cwd: 'C:\\Users\\dev\\project',
      extraWritableRoots: ['C:\\Users\\dev\\.claude', 'C:\\Users\\dev\\.codex'],
      env: { OD_WRITE_ISOLATION: 'on' },
      platform: 'win32',
    });
    expect(plan).toEqual({
      writableRoots: ['C:\\Users\\dev\\project', 'C:\\Users\\dev\\.claude', 'C:\\Users\\dev\\.codex'],
    });
  });

  it('resolves on win32 with the gate required too', () => {
    const plan = planRestrictedTokenIsolation({
      cwd: 'C:\\Users\\dev\\project',
      env: { OD_WRITE_ISOLATION: 'required' },
      platform: 'win32',
    });
    expect(plan).toEqual({ writableRoots: ['C:\\Users\\dev\\project'] });
  });

  it('dedupes extraWritableRoots against cwd and against each other', () => {
    const plan = planRestrictedTokenIsolation({
      cwd: 'C:\\Users\\dev\\project',
      extraWritableRoots: ['C:\\Users\\dev\\project', 'C:\\Users\\dev\\.claude', 'C:\\Users\\dev\\.claude'],
      env: { OD_WRITE_ISOLATION: 'on' },
      platform: 'win32',
    });
    expect(plan).toEqual({
      writableRoots: ['C:\\Users\\dev\\project', 'C:\\Users\\dev\\.claude'],
    });
  });

  it('defaults env/platform to the real process values when omitted', () => {
    // Just exercises the default-parameter path without asserting a
    // platform-specific outcome (this suite may run on any CI host).
    expect(() => planRestrictedTokenIsolation({ cwd: 'C:\\Users\\dev\\project' })).not.toThrow();
  });
});

describe('quoteArgvForCreateProcess', () => {
  it('passes a simple argument through unquoted', () => {
    expect(quoteArgvForCreateProcess('claude')).toBe('claude');
    expect(quoteArgvForCreateProcess('--input-format')).toBe('--input-format');
  });

  it('quotes an argument containing a space', () => {
    expect(quoteArgvForCreateProcess('C:\\Users\\First Last\\claude.cmd')).toBe(
      '"C:\\Users\\First Last\\claude.cmd"',
    );
  });

  it('doubles backslashes immediately preceding an embedded quote', () => {
    // A literal `"` in the arg must survive as `\"`; any backslashes right
    // before it are doubled so they are not themselves read as escaping the
    // quote (the standard CommandLineToArgvW algorithm).
    expect(quoteArgvForCreateProcess('a "b" c')).toBe('"a \\"b\\" c"');
  });

  it('doubles a trailing run of backslashes before the closing quote', () => {
    expect(quoteArgvForCreateProcess('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"');
  });

  it('leaves interior backslashes not adjacent to a quote untouched', () => {
    expect(quoteArgvForCreateProcess('C:\\Users\\dev\\project')).toBe('C:\\Users\\dev\\project');
  });

  it('quotes an empty string argument', () => {
    expect(quoteArgvForCreateProcess('')).toBe('""');
  });
});

describe('buildWin32CommandLine', () => {
  it('joins command + args, quoting only elements that need it', () => {
    expect(buildWin32CommandLine('codex.exe', ['exec', '--json', 'C:\\Users\\dev\\my project'])).toBe(
      'codex.exe exec --json "C:\\Users\\dev\\my project"',
    );
  });

  it('handles an empty args list', () => {
    expect(buildWin32CommandLine('codex.exe', [])).toBe('codex.exe');
  });
});

describe('psSingleQuoteLiteral / psSingleQuoteArrayLiteral', () => {
  it('wraps a plain value in single quotes', () => {
    expect(psSingleQuoteLiteral('C:\\Users\\dev\\project')).toBe("'C:\\Users\\dev\\project'");
  });

  it('doubles an embedded single quote', () => {
    expect(psSingleQuoteLiteral("C:\\Users\\O'Brien\\project")).toBe("'C:\\Users\\O''Brien\\project'");
  });

  it('does not need to escape a double-quote or backslash (single-quoted literal)', () => {
    expect(psSingleQuoteLiteral('a "b" c\\d')).toBe('\'a "b" c\\d\'');
  });

  it('builds a PowerShell array literal of single-quoted entries', () => {
    expect(psSingleQuoteArrayLiteral(['a', "O'Brien"])).toBe("@('a', 'O''Brien')");
  });

  it('builds an empty array literal', () => {
    expect(psSingleQuoteArrayLiteral([])).toBe('@()');
  });
});

describe('buildRestrictedTokenPowerShellScript', () => {
  const base = {
    writableRoots: ['C:\\Users\\dev\\project', 'C:\\Users\\dev\\.claude'],
    commandLine: 'claude.exe -p --input-format stream-json',
  };

  it('embeds the writable roots as a single-quoted PowerShell array literal', () => {
    const script = buildRestrictedTokenPowerShellScript(base);
    expect(script).toContain("$writableRoots = @('C:\\Users\\dev\\project', 'C:\\Users\\dev\\.claude')");
  });

  it('embeds the command line as a single-quoted PowerShell literal', () => {
    const script = buildRestrictedTokenPowerShellScript(base);
    expect(script).toContain("$commandLine = 'claude.exe -p --input-format stream-json'");
  });

  it('plants the Everyone write ACE before creating the restricted token', () => {
    const script = buildRestrictedTokenPowerShellScript(base);
    const grantIdx = script.indexOf('icacls $root /grant "Everyone:(OI)(CI)W"');
    const restrictedTokenIdx = script.indexOf('CreateRestrictedToken(');
    expect(grantIdx).toBeGreaterThan(-1);
    expect(restrictedTokenIdx).toBeGreaterThan(-1);
    expect(grantIdx).toBeLessThan(restrictedTokenIdx);
  });

  it('uses the WRITE_RESTRICTED flag and restricts to Everyone + logon SID', () => {
    const script = buildRestrictedTokenPowerShellScript(base);
    expect(script).toContain('WRITE_RESTRICTED');
    expect(script).toContain('WellKnownSidType]::WorldSid');
    expect(script).toContain('GetLogonSidCopy');
  });

  it('spawns via CreateProcessAsUser and waits for its exit code', () => {
    const script = buildRestrictedTokenPowerShellScript(base);
    expect(script).toContain('CreateProcessAsUser(');
    expect(script).toContain('WaitForSingleObject(');
    expect(script).toContain('GetExitCodeProcess(');
    expect(script).toContain('exit $exitCodeRef');
  });

  it('cleans up the planted ACE after the child exits and on launch failure', () => {
    const script = buildRestrictedTokenPowerShellScript(base);
    const removeCount = script.split("icacls $root '/remove:g' 'Everyone'").length - 1;
    expect(removeCount).toBe(1); // defined once, invoked via `& $cleanupAces` on both paths
    expect(script).toContain('$cleanupAces = {');
    const cleanupCalls = script.split('& $cleanupAces').length - 1;
    expect(cleanupCalls).toBe(2); // launch-failure path + normal exit path
  });

  it('builds an explicit environment block instead of passing NULL', () => {
    const script = buildRestrictedTokenPowerShellScript(base);
    expect(script).toContain('Get-ChildItem Env:');
    expect(script).toContain('CREATE_UNICODE_ENVIRONMENT');
    const callLine = script
      .split('\n')
      .find((line) => line.includes('[OdRestrictedToken]::CreateProcessAsUser('));
    expect(callLine).toBeDefined();
    // The env-block pointer built from this process's own environment must
    // be the lpEnvironment argument — not [IntPtr]::Zero (NULL), which would
    // silently drop every env var server.ts set for this run.
    expect(callLine).toContain('$envBlockPtr');
  });

  it('rejects a writable root containing a control character', () => {
    expect(() =>
      buildRestrictedTokenPowerShellScript({ ...base, writableRoots: ['C:\\Users\\dev\\evil\npath'] }),
    ).toThrow();
  });

  it('rejects a command line containing a control character', () => {
    expect(() =>
      buildRestrictedTokenPowerShellScript({ ...base, commandLine: 'claude.exe\t--evil' }),
    ).toThrow();
  });

  it('does NOT reject a writable root containing a double-quote or backslash', () => {
    // Unlike write-isolation.ts's Seatbelt profile builder, both are legal
    // and safely handled here (backslash is the normal Windows path
    // separator; the single-quoted PS literal does not care about `"`).
    expect(() =>
      buildRestrictedTokenPowerShellScript({
        ...base,
        writableRoots: ['C:\\Users\\dev\\"quoted"\\project'],
      }),
    ).not.toThrow();
  });
});

describe('wrapInvocationInRestrictedTokenIsolation', () => {
  it('wraps the invocation in powershell.exe -NoProfile -ExecutionPolicy Bypass -Command <script>', () => {
    const wrapped = wrapInvocationInRestrictedTokenIsolation(
      { command: 'claude', args: ['-p', '--input-format', 'stream-json'] },
      { writableRoots: ['C:\\Users\\dev\\project'] },
    );
    expect(wrapped.command).toBe(RESTRICTED_TOKEN_ISOLATION_BIN);
    expect(wrapped.args.slice(0, 3)).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass']);
    expect(wrapped.args[3]).toBe('-Command');
    expect(wrapped.args).toHaveLength(5);
  });

  it('embeds the quoted original command + args as the CreateProcessAsUser command line', () => {
    const wrapped = wrapInvocationInRestrictedTokenIsolation(
      { command: 'C:\\Program Files\\codex\\codex.exe', args: ['exec', '--json'] },
      { writableRoots: ['C:\\Users\\dev\\project'] },
    );
    const script = wrapped.args[4];
    expect(script).toContain('$commandLine = \'"C:\\Program Files\\codex\\codex.exe" exec --json\'');
  });

  it('preserves an empty args list', () => {
    const wrapped = wrapInvocationInRestrictedTokenIsolation(
      { command: 'codex', args: [] },
      { writableRoots: ['C:\\Users\\dev\\project'] },
    );
    const script = wrapped.args[4];
    expect(script).toContain("$commandLine = 'codex'");
  });
});
