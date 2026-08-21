import { describe, expect, it } from 'vitest';
import {
  buildSandboxCodexProfileMaterializationScript,
  sandboxAuthCredentialPath,
  sandboxAuthDir,
  sandboxAuthFile,
  sandboxAuthSeedMarkerPath,
  sandboxAuthVolume,
  sandboxCodexProfileName,
  resolveSandboxConfig,
  rewriteUrlForContainer,
  sandboxContainerName,
  sandboxRuntimeAuthStateFromRaw,
  sandboxRuntimeForwardedEnvKeys,
  sandboxRuntimeLoginCommand,
  sandboxRuntimeVersionBin,
  shouldSandboxRun,
  wrapInvocationInSandbox,
} from '../src/agent-sandbox.js';

// The temporary host lock ignores prefs.enabled, so enabled configs for the
// gating tests below must come through the OD_SANDBOX=1 escape hatch.
const cfg = resolveSandboxConfig(undefined, { OD_SANDBOX: '1' });

describe('sandbox auth volume paths', () => {
  it('targets credential and seed marker files inside each mounted auth directory', () => {
    expect(sandboxAuthCredentialPath('claude')).toBe('/home/node/.claude/.credentials.json');
    expect(sandboxAuthSeedMarkerPath('claude')).toBe('/home/node/.claude/.od-auth-seed-consumed');
    expect(sandboxAuthCredentialPath('codex')).toBe('/home/node/.codex/auth.json');
    expect(sandboxAuthSeedMarkerPath('codex')).toBe('/home/node/.codex/.od-auth-seed-consumed');
  });

});

describe('resolveSandboxConfig', () => {
  it('defaults to DISABLED (host CLI) — Claude/Codex runtime and skill defaults stay ready for when it IS enabled', () => {
    // Web-first migration (WP4) + temporary host lock: every run spawns as a
    // host CLI process by default; only OD_SANDBOX=1 opts INTO the Docker
    // sandbox while the lock is in place.
    const resolved = resolveSandboxConfig(undefined, {});
    expect(resolved.enabled).toBe(false);
    // Runtime/skill defaults are unchanged so opting in still behaves exactly
    // like before (every gated runtime, every skill, in scope).
    expect(resolved.runtimes).toEqual(['claude', 'codex']);
    expect(resolved.skills).toEqual(['*']);
    expect(resolved.timeoutMinutes).toBe(30);
  });

  it('TEMPORARY HOST LOCK: prefs.enabled=true no longer opts in — only OD_SANDBOX=1 can', () => {
    const resolved = resolveSandboxConfig({ enabled: true }, {});
    expect(resolved.enabled).toBe(false);
    // Runtime/skill defaults survive so lifting the lock restores the old
    // opt-in behavior unchanged.
    expect(resolved.runtimes).toEqual(['claude', 'codex']);
    expect(resolved.skills).toEqual(['*']);
  });

  it('OD_SANDBOX=1 is the only remaining way to enable the sandbox', () => {
    expect(resolveSandboxConfig({ enabled: false }, { OD_SANDBOX: '1' }).enabled).toBe(true);
    expect(resolveSandboxConfig({ enabled: true }, { OD_SANDBOX: '0' }).enabled).toBe(false);
    // Unset prefs (the new default) still opts in via the escape hatch.
    expect(resolveSandboxConfig(undefined, { OD_SANDBOX: '1' }).enabled).toBe(true);
  });

  it('keeps custom allowlists and limits', () => {
    const resolved = resolveSandboxConfig(
      { enabled: true, runtimes: ['claude', 'codex'], skills: ['ui-react', 'ui-html'], timeoutMinutes: 5, cpus: 1, memoryGb: 2 },
      {},
    );
    expect(resolved.runtimes).toContain('codex');
    expect(resolved.skills).toContain('ui-html');
    expect(resolved.cpus).toBe(1);
  });

  it('drops a persisted skill gate that is only an OLD default', () => {
    // Configs written before the gate became '*' still carry the then-current
    // default. Honoring it would flip /api/agents + the quota meter back to the
    // host without anyone asking, so those exact lists resolve to the default.
    for (const legacy of [
      ['ui-react'],
      ['jira-ingest', 'customer-journey-spec', 'ux-spec', 'ui-react', 'html-interactive-prototype'],
    ]) {
      expect(resolveSandboxConfig({ enabled: true, skills: legacy }, {}).skills).toEqual(['*']);
    }
    // OD_SANDBOX_SKILLS is the way to pin one of those gates on purpose.
    expect(
      resolveSandboxConfig({ enabled: true, skills: ['ui-react'] }, { OD_SANDBOX_SKILLS: 'ui-react' }).skills,
    ).toEqual(['ui-react']);
    // Any other narrow list is a real choice and survives untouched.
    expect(resolveSandboxConfig({ enabled: true, skills: ['ui-html'] }, {}).skills).toEqual(['ui-html']);
  });

  it('a legacy skill gate does NOT re-enable the sandbox by itself — enabled stays OFF unless opted in', () => {
    // Post-WP4: `enabled` defaults to false regardless of what `skills`
    // carries. The legacy-gate migration only matters once the sandbox is
    // actually turned on — it must not be read as an implicit opt-in.
    for (const legacy of [
      ['ui-react'],
      ['jira-ingest', 'customer-journey-spec', 'ux-spec', 'ui-react', 'html-interactive-prototype'],
    ]) {
      const resolved = resolveSandboxConfig({ enabled: false, skills: legacy }, {});
      expect(resolved.enabled).toBe(false);
      expect(resolved.skills).toEqual(['*']);
      expect(shouldSandboxRun({ agentId: 'claude', skillIds: legacy, cfg: resolved })).toBe(false);
    }
  });
});

describe('shouldSandboxRun', () => {
  it('sandboxes EVERY claude run by default — pipeline skills, ad-hoc skills, and skill-less chat', () => {
    for (const skill of ['confluence-ingest', 'customer-journey-spec', 'ux-spec', 'ui-react', 'html-interactive-prototype']) {
      expect(shouldSandboxRun({ agentId: 'claude', skillIds: [skill], cfg })).toBe(true);
    }
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['ui-react', 'frontend-design'], cfg })).toBe(true);
    // General chat / Orbit / routine runs carry no skill — still sandboxed.
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: [], cfg })).toBe(true);
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: [null, undefined], cfg })).toBe(true);
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['summary-feedback'], cfg })).toBe(true);
  });

  it('rejects disabled config and null agent — and honors a NARROWED skill list', () => {
    const disabled = resolveSandboxConfig({ enabled: false }, {});
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['ui-react'], cfg: disabled })).toBe(false);
    expect(shouldSandboxRun({ agentId: 'codex', skillIds: ['ui-react'], cfg })).toBe(true);
    expect(shouldSandboxRun({ agentId: null, skillIds: ['ui-react'], cfg })).toBe(false);
    // User-persisted narrow list restores skill-scoped sandboxing: chat and
    // unlisted skills go back to host spawn. (`['ui-react']` alone is an OLD
    // default, so it resolves back to '*' — use a list nobody ever shipped.)
    const narrowed = resolveSandboxConfig({ enabled: false, skills: ['ui-react', 'ui-html'] }, { OD_SANDBOX: '1' });
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['ui-react'], cfg: narrowed })).toBe(true);
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['summary-feedback'], cfg: narrowed })).toBe(false);
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: [], cfg: narrowed })).toBe(false);
  });

  it('supports wildcard matching in runtimes and skills', () => {
    const wild = resolveSandboxConfig({ enabled: false, runtimes: ['*'], skills: ['*'] }, { OD_SANDBOX: '1' });
    expect(shouldSandboxRun({ agentId: 'codex', skillIds: ['anything-at-all'], cfg: wild })).toBe(true);
    // Wildcard skills use the default Claude + Codex runtime gate.
    const wildSkills = resolveSandboxConfig({ enabled: false, skills: ['*'] }, { OD_SANDBOX: '1' });
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['summary-feedback'], cfg: wildSkills })).toBe(true);
    expect(shouldSandboxRun({ agentId: 'codex', skillIds: ['summary-feedback'], cfg: wildSkills })).toBe(true);
    // Wildcard never bypasses the enabled flag or a null agent.
    const wildDisabled = resolveSandboxConfig({ enabled: false, runtimes: ['*'], skills: ['*'] }, {});
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['x'], cfg: wildDisabled })).toBe(false);
    expect(shouldSandboxRun({ agentId: null, skillIds: ['x'], cfg: wild })).toBe(false);
  });
});

describe('rewriteUrlForContainer', () => {
  it('rewrites loopback hosts to host.docker.internal, keeping the port', () => {
    expect(rewriteUrlForContainer('http://127.0.0.1:7456')).toBe('http://host.docker.internal:7456');
    expect(rewriteUrlForContainer('http://localhost:17456')).toBe('http://host.docker.internal:17456');
  });

  it('leaves non-loopback URLs untouched', () => {
    expect(rewriteUrlForContainer('https://b5.openledger.vn/kgs')).toBe('https://b5.openledger.vn/kgs');
  });
});

describe('sandboxContainerName', () => {
  it('prefixes and sanitizes the run id', () => {
    expect(sandboxContainerName('run_abc-123')).toBe('od-sbx-run_abc-123');
    expect(sandboxContainerName('run/../evil x')).toBe('od-sbx-run-..-evil-x');
  });
});

describe('wrapInvocationInSandbox', () => {
  const wrap = () =>
    wrapInvocationInSandbox({
      agentBin: 'claude',
      args: ['-p', '--input-format', 'stream-json'],
      env: {
        OD_TOOL_TOKEN: 'tok-1',
        ANTHROPIC_BASE_URL: 'https://proxy.example',
        HOME: '/Users/dev',
        AWS_SECRET_ACCESS_KEY: 'leak-me-not',
      },
      cwd: '/data/projects/p1/docs-to-react',
      runId: 'run-42',
      projectId: 'p1',
      daemonUrl: 'http://127.0.0.1:7456',
      image: 'od-agent-sandbox:0.1.0',
      cfg,
    });

  it('produces a docker run invocation ending with the agent command', () => {
    const { command, args, containerName } = wrap();
    expect(command.endsWith('docker') || command.endsWith('docker.exe')).toBe(true);
    expect(containerName).toBe('od-sbx-run-42');
    expect(args.slice(0, 2)).toEqual(['run', '-i']);
    const imageIdx = args.indexOf('od-agent-sandbox:0.1.0');
    expect(imageIdx).toBeGreaterThan(0);
    expect(args.slice(imageIdx + 1)).toEqual(['claude', '-p', '--input-format', 'stream-json']);
  });

  it('forwards OD_MCP_BEARER_* env into the container ONLY for the codex runtime (WP27)', () => {
    const base = {
      agentBin: 'codex',
      args: ['exec', '--json'],
      env: {
        OD_TOOL_TOKEN: 'tok-1',
        OD_MCP_BEARER_FIGMA: 'bearer-secret',
        OD_MCP_BEARER_OTHER: 'bearer-two',
        AWS_SECRET_ACCESS_KEY: 'leak-me-not',
      },
      cwd: '/data/projects/p1/docs-to-react',
      runId: 'run-43',
      projectId: 'p1',
      daemonUrl: 'http://127.0.0.1:7456',
      image: 'od-agent-sandbox:0.1.0',
      cfg,
    };
    const codexRun = wrapInvocationInSandbox({ ...base, runtimeId: 'codex' as const });
    const codexEnvFlags = codexRun.args.flatMap((a, i) => (a === '-e' ? [codexRun.args[i + 1]] : []));
    expect(codexEnvFlags).toContain('OD_MCP_BEARER_FIGMA=bearer-secret');
    expect(codexEnvFlags).toContain('OD_MCP_BEARER_OTHER=bearer-two');
    expect(codexEnvFlags.some((f) => f.startsWith('AWS_SECRET_ACCESS_KEY='))).toBe(false);

    // Claude container: bearer vars must NOT cross — claude reads MCP auth
    // from .mcp.json headers, and the pattern-forward is codex-gated.
    const claudeRun = wrapInvocationInSandbox({ ...base, agentBin: 'claude', runtimeId: 'claude' as const });
    const claudeEnvFlags = claudeRun.args.flatMap((a, i) => (a === '-e' ? [claudeRun.args[i + 1]] : []));
    expect(claudeEnvFlags.some((f) => f.startsWith('OD_MCP_BEARER_'))).toBe(false);
  });

  it('mounts exactly the project dir, auth volume and cache volume', () => {
    const { args } = wrap();
    const mounts = args.flatMap((a, i) => (a === '-v' ? [args[i + 1]] : []));
    expect(mounts).toEqual([
      '/data/projects/p1/docs-to-react:/work/app',
      'od-claude-auth:/home/node/.claude',
      'uireact-cache-p1:/work/.vite-cache',
    ]);
  });

  it('forwards only whitelisted env, rewrites the daemon URL, never leaks host env', () => {
    const { args } = wrap();
    const envs = args.flatMap((a, i) => (a === '-e' ? [args[i + 1]] : []));
    expect(envs).toContain('OD_DAEMON_URL=http://host.docker.internal:7456');
    expect(envs).toContain('OD_PROJECT_DIR=/work/app');
    expect(envs).toContain('OD_PROJECT_ID=p1');
    expect(envs).toContain('UIREACT_IN_SANDBOX=1');
    expect(envs).toContain('OD_TOOL_TOKEN=tok-1');
    expect(envs).toContain('ANTHROPIC_BASE_URL=https://proxy.example');
    expect(envs.join(' ')).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(envs.join(' ')).not.toContain('/Users/dev');
  });

  it('caps resources and labels the container for sweep/cancel', () => {
    const { args } = wrap();
    expect(args).toContain('--cpus');
    expect(args[args.indexOf('--cpus') + 1]).toBe('2');
    expect(args[args.indexOf('--memory') + 1]).toBe('4g');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('1024');
    const labels = args.flatMap((a, i) => (a === '--label' ? [args[i + 1]] : []));
    expect(labels).toContain('od.sandbox=1');
    expect(labels).toContain('od.run.id=run-42');
  });

  it('omits project-scoped mounts/env when projectId is null', () => {
    const { args } = wrapInvocationInSandbox({
      agentBin: 'claude',
      args: [],
      env: {},
      cwd: '/tmp/x',
      runId: 'r',
      projectId: null,
      daemonUrl: 'http://127.0.0.1:7456',
      image: 'img:1',
      cfg,
    });
    expect(args.join(' ')).not.toContain('uireact-cache');
    expect(args.join(' ')).not.toContain('OD_PROJECT_ID');
  });

  it('wraps Codex runs against the Codex auth volume and forwards only OpenAI/Codex env', () => {
    const { args } = wrapInvocationInSandbox({
      agentBin: 'codex',
      args: ['login', '--device-auth'],
      env: {
        OPENAI_API_KEY: 'sk-openai',
        OPENAI_BASE_URL: 'https://api.example',
        CODEX_API_KEY: 'sk-codex',
        ANTHROPIC_API_KEY: 'should-not-forward',
      },
      cwd: '/data/projects/p1/docs-to-react',
      runId: 'run-codex',
      projectId: 'p1',
      daemonUrl: 'http://127.0.0.1:7456',
      image: 'od-agent-sandbox:0.1.0',
      cfg,
      runtimeId: 'codex',
    });
    const mounts = args.flatMap((a, i) => (a === '-v' ? [args[i + 1]] : []));
    const envs = args.flatMap((a, i) => (a === '-e' ? [args[i + 1]] : []));
    expect(mounts).toContain('od-codex-auth:/home/node/.codex');
    expect(envs).toContain('CODEX_HOME=/home/node/.codex');
    expect(envs).toContain('OPENAI_API_KEY=sk-openai');
    expect(envs).toContain('OPENAI_BASE_URL=https://api.example');
    expect(envs).toContain('CODEX_API_KEY=sk-codex');
    expect(envs.join(' ')).not.toContain('ANTHROPIC_API_KEY');
  });

  it('normalizes a Windows-host Codex policy for the Linux container', () => {
    const wrapped = wrapInvocationInSandbox({
      agentBin: 'codex',
      args: [
        'exec', '--json',
        '-C', '/data/project',
        '--add-dir', '/data/project/docs',
        '--add-dir', '/shared/design-system',
        '--sandbox', 'danger-full-access',
      ],
      env: {},
      cwd: '/data/project',
      runId: 'run-windows-policy',
      projectId: null,
      daemonUrl: 'http://127.0.0.1:7456',
      image: 'od-agent-sandbox:0.1.0',
      cfg,
      runtimeId: 'codex',
    });
    expect(wrapped.args).toContain('workspace-write');
    expect(wrapped.args).not.toContain('danger-full-access');
    expect(wrapped.args).toContain('sandbox_workspace_write.network_access=true');
    expect(wrapped.args[wrapped.args.indexOf('-C') + 1]).toBe('/work/app');
    const addDirs = wrapped.args.flatMap((arg, index) =>
      arg === '--add-dir' ? [wrapped.args[index + 1]] : [],
    );
    expect(addDirs).toEqual(['/work/app/docs', '/work/extra-0']);
    expect(wrapped.args).toContain('/shared/design-system:/work/extra-0');
  });
});

describe('Codex sandbox helpers', () => {
  it('keeps Codex auth storage, login command, env whitelist, and version probing separate from Claude', () => {
    expect(sandboxAuthVolume('claude')).toBe('od-claude-auth');
    expect(sandboxAuthVolume('codex')).toBe('od-codex-auth');
    expect(sandboxAuthDir('claude')).toBe('/home/node/.claude');
    expect(sandboxAuthDir('codex')).toBe('/home/node/.codex');
    expect(sandboxAuthFile('claude')).toBe('.credentials.json');
    expect(sandboxAuthFile('codex')).toBe('auth.json');
    expect(sandboxRuntimeVersionBin('claude')).toBe('claude');
    expect(sandboxRuntimeVersionBin('codex')).toBe('codex');
    expect(sandboxRuntimeForwardedEnvKeys('codex')).toEqual(
      expect.arrayContaining(['OD_TOOL_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY']),
    );
    const command = sandboxRuntimeLoginCommand('codex', 'od-agent-sandbox:0.1.0');
    expect(command).toContain('docker run -it --rm');
    expect(command).toContain('-v od-codex-auth:/home/node/.codex');
    expect(command).toContain('-e CODEX_HOME=/home/node/.codex');
    expect(command).toContain('codex login --device-auth');
  });

  it('derives Codex profile names and materialization scripts without touching user config', () => {
    expect(sandboxCodexProfileName('run/../evil x')).toBe('od-run-..-evil-x-mcp');
    const script = buildSandboxCodexProfileMaterializationScript(
      'od-run-42-mcp',
      Buffer.from('mcpServers = {}', 'utf8').toString('base64'),
    );
    expect(script).toContain('cd "/home/node/.codex"');
    expect(script).toContain('od-run-42-mcp.config.toml');
    expect(script).toContain('mkdir "$lockdir"');
    expect(script).toContain('mv -f "$tmp" "$final"');
    expect(script).toContain('base64 -d');
    expect(script).not.toContain('/home/node/.codex/config.toml');
  });

  it('parses runtime auth files into logged-in, missing, and unknown states', () => {
    expect(
      sandboxRuntimeAuthStateFromRaw(
        'claude',
        JSON.stringify({ claudeAiOauth: { accessToken: 'claude-token' } }),
      ),
    ).toBe('logged-in');
    expect(
      sandboxRuntimeAuthStateFromRaw(
        'codex',
        JSON.stringify({ tokens: { access_token: 'codex-token' } }),
      ),
    ).toBe('logged-in');
    expect(sandboxRuntimeAuthStateFromRaw('codex', JSON.stringify({}))).toBe('missing');
    expect(sandboxRuntimeAuthStateFromRaw('codex', 'not json')).toBe('unknown');
    expect(sandboxRuntimeAuthStateFromRaw('claude', null)).toBe('missing');
  });
});
