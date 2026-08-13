import { describe, expect, it, vi } from 'vitest';

import { buildHostAgentEnv } from '../src/runtimes/host-env.js';
import { spawnEnvForAgent } from '../src/runtimes/env.js';

describe('buildHostAgentEnv', () => {
  it('never lets secret creds through to a host agent spawn', () => {
    const env = buildHostAgentEnv({
      KGS_API_KEY: 'kgs-secret',
      SESSION_SECRET: 'session-secret',
      OD_ATLASSIAN_JIRA_TOKEN: 'atlassian-pat',
      PATH: '/usr/bin',
    });

    expect('KGS_API_KEY' in env).toBe(false);
    expect('SESSION_SECRET' in env).toBe(false);
    expect('OD_ATLASSIAN_JIRA_TOKEN' in env).toBe(false);
  });

  it('lets the vars a host agent process actually needs through', () => {
    const env = buildHostAgentEnv({
      PATH: '/usr/bin',
      HOME: '/Users/test',
      OD_TOOL_TOKEN: 'run-token',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/test');
    expect(env.OD_TOOL_TOKEN).toBe('run-token');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('composes with spawnEnvForAgent to preserve the existing ANTHROPIC_API_KEY strip', () => {
    // buildHostAgentEnv allows ANTHROPIC_API_KEY through (it's a legitimate
    // Claude Code var) — the strip-unless-custom-base-url behavior lives
    // downstream in spawnEnvForAgent (runtimes/env.ts) and must survive the
    // new seam unchanged.
    const hostEnv = buildHostAgentEnv({
      ANTHROPIC_API_KEY: 'sk-leak',
      PATH: '/usr/bin',
    });
    expect(hostEnv.ANTHROPIC_API_KEY).toBe('sk-leak');

    const spawned = spawnEnvForAgent('claude', hostEnv);
    expect('ANTHROPIC_API_KEY' in spawned).toBe(false);
    expect(spawned.PATH).toBe('/usr/bin');
  });

  it('preserves ANTHROPIC_API_KEY through the full pipeline when ANTHROPIC_BASE_URL is set', () => {
    const hostEnv = buildHostAgentEnv({
      ANTHROPIC_API_KEY: 'sk-kimi',
      ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/v1',
      PATH: '/usr/bin',
    });
    const spawned = spawnEnvForAgent('claude', hostEnv);

    expect(spawned.ANTHROPIC_API_KEY).toBe('sk-kimi');
    expect(spawned.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.cn/v1');
  });

  it('forwards names listed in OD_AGENT_ENV_PASSTHROUGH', () => {
    const env = buildHostAgentEnv({
      OD_AGENT_ENV_PASSTHROUGH: 'FOO',
      FOO: 'bar',
      PATH: '/usr/bin',
    });

    expect(env.FOO).toBe('bar');
    // The escape-hatch knob itself is daemon-side config, not something the
    // agent process needs.
    expect('OD_AGENT_ENV_PASSTHROUGH' in env).toBe(false);
  });

  it('forwards multiple comma-separated passthrough names', () => {
    const env = buildHostAgentEnv({
      OD_AGENT_ENV_PASSTHROUGH: 'FOO, BAR',
      FOO: 'foo-val',
      BAR: 'bar-val',
      BAZ: 'not-listed',
      PATH: '/usr/bin',
    });

    expect(env.FOO).toBe('foo-val');
    expect(env.BAR).toBe('bar-val');
    expect('BAZ' in env).toBe(false);
  });

  it('blocks every var by default unless allowlisted or passed through', () => {
    const env = buildHostAgentEnv({
      SOME_RANDOM_SHELL_VAR: 'x',
      PATH: '/usr/bin',
    });

    expect('SOME_RANDOM_SHELL_VAR' in env).toBe(false);
    expect(env.PATH).toBe('/usr/bin');
  });

  it('never forwards NODE_OPTIONS (injection vector)', () => {
    const env = buildHostAgentEnv({
      NODE_OPTIONS: '--require=/tmp/evil.js',
      PATH: '/usr/bin',
    });

    expect('NODE_OPTIONS' in env).toBe(false);
  });

  it('blocks the documented secret groups even when present', () => {
    const env = buildHostAgentEnv({
      MEDIA_KLING_API_KEY: 'x',
      GOOGLE_CLIENT_SECRET: 'x',
      CONFLUENCE_PERSONAL_TOKEN: 'x',
      IDENTITY_PROVIDER_SECRET: 'x',
      POSTHOG_API_KEY: 'x',
      PATH: '/usr/bin',
    });

    expect(Object.keys(env).sort()).toEqual(['PATH']);
  });

  it('allows LC_*, XDG_*, and CLAUDE_CODE_* prefixed vars', () => {
    const env = buildHostAgentEnv({
      LC_ALL: 'en_US.UTF-8',
      XDG_CONFIG_HOME: '/home/test/.config',
      CLAUDE_CODE_SOME_FLAG: '1',
      PATH: '/usr/bin',
    });

    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.XDG_CONFIG_HOME).toBe('/home/test/.config');
    expect(env.CLAUDE_CODE_SOME_FLAG).toBe('1');
  });

  it('allows both proxy env var casings', () => {
    const env = buildHostAgentEnv({
      HTTP_PROXY: 'http://proxy:8080',
      https_proxy: 'http://proxy:8443',
      NO_PROXY: 'localhost',
      PATH: '/usr/bin',
    });

    expect(env.HTTP_PROXY).toBe('http://proxy:8080');
    expect(env.https_proxy).toBe('http://proxy:8443');
    expect(env.NO_PROXY).toBe('localhost');
  });

  it('allows the OD runtime vars a tool/skill actually reads', () => {
    const env = buildHostAgentEnv({
      OD_NODE_BIN: '/opt/node/bin/node',
      OD_TOOL_TOKEN: 'token',
      OD_DAEMON_URL: 'http://127.0.0.1:7456',
      OD_DATA_DIR: '/Users/test/.od',
      OD_PROJECT_ID: 'proj-1',
      OD_PROJECT_DIR: '/Users/test/.od/projects/proj-1',
      OD_BIN: '/opt/open-design/bin/od',
      PATH: '/usr/bin',
    });

    expect(env.OD_NODE_BIN).toBe('/opt/node/bin/node');
    expect(env.OD_TOOL_TOKEN).toBe('token');
    expect(env.OD_DAEMON_URL).toBe('http://127.0.0.1:7456');
    expect(env.OD_DATA_DIR).toBe('/Users/test/.od');
    expect(env.OD_PROJECT_ID).toBe('proj-1');
    expect(env.OD_PROJECT_DIR).toBe('/Users/test/.od/projects/proj-1');
    expect(env.OD_BIN).toBe('/opt/open-design/bin/od');
  });

  it('does not mutate the input env', () => {
    const original = { KGS_API_KEY: 'secret', PATH: '/usr/bin' };
    const env = buildHostAgentEnv(original);

    expect(original.KGS_API_KEY).toBe('secret');
    expect(env).not.toBe(original);
  });

  it('logs only the blocked-notable var NAMES (never values) once per call', () => {
    const onBlockedNotable = vi.fn();
    buildHostAgentEnv(
      {
        KGS_API_KEY: 'super-secret-value',
        OD_ATLASSIAN_JIRA_TOKEN: 'another-secret-value',
        PATH: '/usr/bin',
      },
      { onBlockedNotable },
    );

    expect(onBlockedNotable).toHaveBeenCalledTimes(1);
    expect(onBlockedNotable).toHaveBeenCalledWith(['KGS_API_KEY', 'OD_ATLASSIAN_JIRA_TOKEN']);
    const names = onBlockedNotable.mock.calls[0]?.[0] ?? [];
    const serialized = JSON.stringify(names);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('another-secret-value');
  });

  it('does not call onBlockedNotable when no notable-blocked var was present', () => {
    const onBlockedNotable = vi.fn();
    buildHostAgentEnv({ PATH: '/usr/bin' }, { onBlockedNotable });

    expect(onBlockedNotable).not.toHaveBeenCalled();
  });

  it('warns once per call when OD_AGENT_ENV_PASSTHROUGH is used', () => {
    const onPassthroughWarning = vi.fn();
    buildHostAgentEnv(
      { OD_AGENT_ENV_PASSTHROUGH: 'FOO,BAR', FOO: '1', BAR: '2', PATH: '/usr/bin' },
      { onPassthroughWarning },
    );

    expect(onPassthroughWarning).toHaveBeenCalledTimes(1);
    expect(onPassthroughWarning).toHaveBeenCalledWith(['FOO', 'BAR']);
  });

  it('does not warn when OD_AGENT_ENV_PASSTHROUGH is unset', () => {
    const onPassthroughWarning = vi.fn();
    buildHostAgentEnv({ PATH: '/usr/bin' }, { onPassthroughWarning });

    expect(onPassthroughWarning).not.toHaveBeenCalled();
  });
});
