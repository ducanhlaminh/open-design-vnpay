import { describe, expect, it } from 'vitest';
import {
  resolveSandboxConfig,
  rewriteUrlForContainer,
  sandboxContainerName,
  shouldSandboxRun,
  wrapInvocationInSandbox,
} from '../src/agent-sandbox.js';

const cfg = resolveSandboxConfig({ enabled: true }, {});

describe('resolveSandboxConfig', () => {
  it('defaults to ENABLED, claude runtime, and EVERY run in scope (skills *)', () => {
    // This fork runs Claude through the Docker sandbox by default (no UI toggle);
    // only an explicit prefs.enabled=false or OD_SANDBOX=0 opts out.
    const resolved = resolveSandboxConfig(undefined, {});
    expect(resolved.enabled).toBe(true);
    expect(resolved.runtimes).toEqual(['claude']);
    // The sandbox owns ALL runs of gated runtimes by default — pipeline
    // steps AND general chat / Orbit / routine turns.
    expect(resolved.skills).toEqual(['*']);
    expect(resolved.timeoutMinutes).toBe(30);
  });

  it('OD_SANDBOX env overrides the persisted flag in both directions', () => {
    expect(resolveSandboxConfig({ enabled: false }, { OD_SANDBOX: '1' }).enabled).toBe(true);
    expect(resolveSandboxConfig({ enabled: true }, { OD_SANDBOX: '0' }).enabled).toBe(false);
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
});

describe('shouldSandboxRun', () => {
  it('sandboxes EVERY claude run by default — pipeline skills, ad-hoc skills, and skill-less chat', () => {
    for (const skill of ['jira-ingest', 'customer-journey-spec', 'ux-spec', 'ui-react', 'html-interactive-prototype']) {
      expect(shouldSandboxRun({ agentId: 'claude', skillIds: [skill], cfg })).toBe(true);
    }
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['ui-react', 'frontend-design'], cfg })).toBe(true);
    // General chat / Orbit / routine runs carry no skill — still sandboxed.
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: [], cfg })).toBe(true);
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: [null, undefined], cfg })).toBe(true);
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['summary-feedback'], cfg })).toBe(true);
  });

  it('rejects disabled config, other runtimes, null agent — and honors a NARROWED skill list', () => {
    const disabled = resolveSandboxConfig({ enabled: false }, {});
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['ui-react'], cfg: disabled })).toBe(false);
    expect(shouldSandboxRun({ agentId: 'codex', skillIds: ['ui-react'], cfg })).toBe(false);
    expect(shouldSandboxRun({ agentId: null, skillIds: ['ui-react'], cfg })).toBe(false);
    // User-persisted narrow list restores skill-scoped sandboxing: chat and
    // unlisted skills go back to host spawn.
    const narrowed = resolveSandboxConfig({ enabled: true, skills: ['ui-react'] }, {});
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['ui-react'], cfg: narrowed })).toBe(true);
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['summary-feedback'], cfg: narrowed })).toBe(false);
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: [], cfg: narrowed })).toBe(false);
  });

  it('supports wildcard matching in runtimes and skills', () => {
    const wild = resolveSandboxConfig({ enabled: true, runtimes: ['*'], skills: ['*'] }, {});
    expect(shouldSandboxRun({ agentId: 'codex', skillIds: ['anything-at-all'], cfg: wild })).toBe(true);
    // Wildcard skills alone still respects the runtime gate.
    const wildSkills = resolveSandboxConfig({ enabled: true, skills: ['*'] }, {});
    expect(shouldSandboxRun({ agentId: 'claude', skillIds: ['summary-feedback'], cfg: wildSkills })).toBe(true);
    expect(shouldSandboxRun({ agentId: 'codex', skillIds: ['summary-feedback'], cfg: wildSkills })).toBe(false);
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
    expect(command).toBe('docker');
    expect(containerName).toBe('od-sbx-run-42');
    expect(args.slice(0, 2)).toEqual(['run', '-i']);
    const imageIdx = args.indexOf('od-agent-sandbox:0.1.0');
    expect(imageIdx).toBeGreaterThan(0);
    expect(args.slice(imageIdx + 1)).toEqual(['claude', '-p', '--input-format', 'stream-json']);
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
});
