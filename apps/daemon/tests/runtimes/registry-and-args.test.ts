import { test } from 'vitest';
import {
  AGENT_DEFS, assert, chmodSync, codex, cursorAgent, detectAgents, join, mkdtempSync, rmSync, tmpdir, withEnvSnapshot, withPlatform, writeFileSync,
} from './helpers/test-helpers.js';
import { readLocalAgentProfileDefs } from '../../src/runtimes/registry.js';
import { parseCodexDebugModels } from '../../src/runtimes/defs/codex.js';

test('AGENT_DEFS ids are unique', () => {
  const ids = AGENT_DEFS.map((a) => a.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate agent ids: ${JSON.stringify(dupes)}`);
});

test('local agent profiles inherit a base adapter and can pin the default model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-local-agent-profiles-'));
  try {
    await withEnvSnapshot(['OD_AGENT_PROFILES_CONFIG'], async () => {
      const config = join(dir, 'agents.local.json');
      writeFileSync(
        config,
        JSON.stringify({
          agents: [
            {
              id: 'zcode',
              name: 'ZCode',
              baseAgent: 'claude',
              bin: 'zcode',
              args: ['run'],
              defaultModel: 'zyb-claude',
              models: [
                { id: 'zyb-claude', label: 'zyb-claude' },
                { id: 'zyb-gpt', label: 'zyb-gpt' },
              ],
              env: {
                ZCODE_ROUTE: 'design',
                RETRIES: 2,
                'BAD-NAME': 'ignored',
              },
            },
          ],
        }),
      );
      process.env.OD_AGENT_PROFILES_CONFIG = config;

      const profiles = readLocalAgentProfileDefs();
      assert.equal(profiles.length, 1);
      const [profile] = profiles;
      assert.ok(profile);
      assert.equal(profile.id, 'zcode');
      assert.equal(profile.name, 'ZCode');
      assert.equal(profile.bin, 'zcode');
      assert.equal(profile.promptViaStdin, true);
      assert.equal(profile.streamFormat, 'claude-stream-json');
      assert.deepEqual(profile.fallbackModels.map((model) => model.id), [
        'default',
        'zyb-claude',
        'zyb-gpt',
      ]);
      assert.deepEqual(profile.env, {
        ZCODE_ROUTE: 'design',
        RETRIES: '2',
      });

      const defaultArgs = profile.buildArgs('', [], [], {});
      assert.deepEqual(defaultArgs.slice(0, 2), ['run', '-p']);
      assert.ok(defaultArgs.includes('--model'));
      assert.equal(defaultArgs[defaultArgs.indexOf('--model') + 1], 'zyb-claude');

      const explicitArgs = profile.buildArgs('', [], [], { model: 'zyb-gpt' });
      assert.equal(explicitArgs[explicitArgs.indexOf('--model') + 1], 'zyb-gpt');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local agent profiles skip explicit unknown baseAgent without falling back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-local-agent-profiles-invalid-'));
  try {
    await withEnvSnapshot(['OD_AGENT_PROFILES_CONFIG'], async () => {
      const config = join(dir, 'agents.local.json');
      writeFileSync(
        config,
        JSON.stringify({
          agents: [
            { id: 'claude', bin: 'duplicate' },
            { id: 'bad id with spaces', bin: 'bad' },
            { id: 'unknown-base', baseAgent: 'does-not-exist', bin: 'bad' },
            { id: 'ok-wrapper', bin: 'ok-wrapper' },
          ],
        }),
      );
      process.env.OD_AGENT_PROFILES_CONFIG = config;

      const profiles = readLocalAgentProfileDefs();

      assert.deepEqual(profiles.map((profile) => profile.id), ['ok-wrapper']);
      assert.equal(profiles[0]?.bin, 'ok-wrapper');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex args disable plugins when OD_CODEX_DISABLE_PLUGINS is 1', () => {
  process.env.OD_CODEX_DISABLE_PLUGINS = '1';

  withPlatform('darwin', () => {
    const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/od-project' });

    // Assert the flag itself, not its exact position — the base sandbox prefix
    // is covered by the "workspace-write sandbox" test, and pinning positions
    // here broke when `-c approval_policy="never"` was inserted before it.
    const di = args.indexOf('--disable');
    assert.ok(di >= 0, 'expected --disable when OD_CODEX_DISABLE_PLUGINS=1');
    assert.equal(args[di + 1], 'plugins', 'expected --disable to be followed by plugins');
  });
});

test('codex args use workspace-write sandbox on macOS and Linux', () => {
  delete process.env.OD_CODEX_DISABLE_PLUGINS;

  for (const platform of ['darwin', 'linux'] as const) {
    withPlatform(platform, () => {
      const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/od-project' });
      assert.equal(args.includes('--full-auto'), false);
      assert.deepEqual(args.slice(0, 5), [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
      ]);
    });
  }
});

test('codex args use danger-full-access sandbox on Windows because workspace-write blocks PowerShell', () => {
  // Codex CLI's workspace-write sandbox mode on Windows lacks a working
  // OS-level sandbox and falls back to a policy that rejects shell
  // invocations such as powershell.exe with "blocked by policy".
  // The agent cannot list files or run any shell-backed tool under that
  // policy. danger-full-access is Codex CLI's documented Windows-compatible
  // mode (issue #1721).
  delete process.env.OD_CODEX_DISABLE_PLUGINS;

  withPlatform('win32', () => {
    const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/od-project' });

    assert.deepEqual(args.slice(0, 5), [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'danger-full-access',
    ]);
    // The workspace-write-scoped network override is meaningless under
    // danger-full-access and must not appear on Windows.
    assert.equal(args.includes('workspace-write'), false);
    assert.equal(
      args.includes('sandbox_workspace_write.network_access=true'),
      false,
    );
  });
});

// 19/08/2026: a fresh host install (install.sh writes
// OD_WRITE_ISOLATION=required) runs the agent under `sandbox-exec`. Codex's
// own workspace-write is Seatbelt too and shells out to `sandbox-exec` per
// command; macOS refuses the nested `sandbox_apply`, so EVERY tool call —
// including a read like `cat flows/_inputs.json` — dies before it runs.
test('codex args drop codex\'s own Seatbelt sandbox when OD already wraps the spawn (no nested sandbox)', () => {
  delete process.env.OD_CODEX_DISABLE_PLUGINS;

  withPlatform('darwin', () => {
    const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/od-project', writeIsolated: true });

    assert.deepEqual(args.slice(0, 5), [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'danger-full-access',
    ]);
    assert.equal(args.includes('workspace-write'), false);
    assert.equal(args.includes('sandbox_workspace_write.network_access=true'), false);
    // Still headless: nothing here may reintroduce an approval prompt.
    assert.ok(args.includes('approval_policy="never"'));
  });
});

test('codex keeps workspace-write when OD is NOT wrapping the spawn (writeIsolated false/absent)', () => {
  delete process.env.OD_CODEX_DISABLE_PLUGINS;

  withPlatform('darwin', () => {
    for (const ctx of [
      { cwd: '/tmp/od-project' },
      { cwd: '/tmp/od-project', writeIsolated: false },
    ]) {
      const args = codex.buildArgs('', [], [], {}, ctx);
      assert.equal(args[4], 'workspace-write', `expected workspace-write for ${JSON.stringify(ctx)}`);
      assert.ok(args.includes('sandbox_workspace_write.network_access=true'));
    }
  });
});

test('codex args keep plugins enabled when OD_CODEX_DISABLE_PLUGINS is unset', () => {
  delete process.env.OD_CODEX_DISABLE_PLUGINS;

  withPlatform('darwin', () => {
    const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/od-project' });

    assert.equal(args.includes('--disable'), false);
    assert.equal(args.includes('plugins'), false);
  });
});

test('codex args keep plugins enabled when OD_CODEX_DISABLE_PLUGINS is not 1', () => {
  process.env.OD_CODEX_DISABLE_PLUGINS = 'true';

  withPlatform('darwin', () => {
    const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/od-project' });

    assert.equal(args.includes('--disable'), false);
    assert.equal(args.includes('plugins'), false);
  });
});

// Product decision 19/08/2026 (revised 21/08 + 23/08/2026): Codex CLI model
// is a CLOSED list of the three GPT-5.6 siblings (Luna default, Sol, Terra —
// no live probing, no custom ids); reasoning effort is a user choice over the
// union ladder, default `high`; `ultra` only exists on Sol/Terra and is
// clamped to `max` on Luna.
test('codex model picker = Luna (default) / Sol / Terra; reasoning exposes the full ladder (user choice)', () => {
  assert.deepEqual(codex.fallbackModels, [
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  ]);
  assert.ok(codex.reasoningOptions, 'codex must define reasoningOptions');
  // Option đầu là sentinel 'default' (convention pi) — SettingsDialog hiển
  // thị option [0] khi user chưa chọn nên nó phải là hành vi mặc định thật.
  assert.deepEqual(
    codex.reasoningOptions.map((o: { id: string }) => o.id),
    ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
  assert.equal(codex.listModels, undefined, 'codex must not probe `debug models` anymore');

  // Unset model/reasoning → Luna + high; chosen values → passed through.
  const argsDefault = codex.buildArgs('', [], [], {}, { cwd: '/tmp/od-project' });
  assert.ok(argsDefault.includes('--model'));
  assert.equal(argsDefault[argsDefault.indexOf('--model') + 1], 'gpt-5.6-luna');
  assert.ok(argsDefault.includes('model_reasoning_effort="high"'));

  const argsChosen = codex.buildArgs('', [], [], { model: 'gpt-5.6-sol', reasoning: 'max' }, { cwd: '/tmp/od-project' });
  assert.equal(argsChosen[argsChosen.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.ok(argsChosen.includes('model_reasoning_effort="max"'));

  const argsTerra = codex.buildArgs('', [], [], { model: 'gpt-5.6-terra', reasoning: 'ultra' }, { cwd: '/tmp/od-project' });
  assert.equal(argsTerra[argsTerra.indexOf('--model') + 1], 'gpt-5.6-terra');
  assert.ok(argsTerra.includes('model_reasoning_effort="ultra"'));

  // Luna has no `ultra` notch → clamp to max, not an unknown effort the CLI rejects.
  const argsLunaUltra = codex.buildArgs('', [], [], { model: 'gpt-5.6-luna', reasoning: 'ultra' }, { cwd: '/tmp/od-project' });
  assert.ok(argsLunaUltra.includes('model_reasoning_effort="max"'));

  // Unknown / stale / sentinel model ids never reach the CLI — fall back to Luna.
  for (const model of ['default', 'gpt-5', 'gpt-5.5', '  ']) {
    const args = codex.buildArgs('', [], [], { model }, { cwd: '/tmp/od-project' });
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-luna', `model ${JSON.stringify(model)}`);
  }
});

// `codex.listModels` was removed from the def (fixed-model product
// decision, 19/08/2026) so nothing wires this parser up anymore, but it
// stays exported from codex.ts — exercise it directly here so the parsing
// logic itself doesn't silently rot.
test('parseCodexDebugModels parses live model catalog JSON (parser retained though unused by the def)', () => {
  const parsed = parseCodexDebugModels(JSON.stringify({
    models: [
      {
        slug: 'gpt-6-codex',
        display_name: 'GPT-6 Codex',
        visibility: 'list',
      },
      {
        slug: 'gpt-6-codex-mini',
        display_name: 'GPT-6 Codex Mini',
        visibility: 'list',
      },
      {
        slug: 'gpt-hidden-internal',
        display_name: 'Hidden internal',
        visibility: 'hidden',
      },
    ],
  }));

  assert.deepEqual(parsed, [
    { id: 'default', label: 'Default (CLI config)' },
    { id: 'gpt-6-codex', label: 'GPT-6 Codex' },
    { id: 'gpt-6-codex-mini', label: 'GPT-6 Codex Mini' },
  ]);
});

// codex.listModels was intentionally removed (fixed-model product decision,
// 19/08/2026): detection.ts's fetchModels() falls back to def.fallbackModels
// whenever `def.listModels` is absent, so a CLI that still answers
// `debug models` must no longer be probed live for codex.
test('codex detection no longer probes live "debug models" — always resolves to the fixed fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-agents-codex-live-models-'));
  try {
    await withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], async () => {
      const codexBin = join(dir, 'codex');
      writeFileSync(
        codexBin,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  printf '%s\\n' '{"models":[{"slug":"gpt-6-codex","display_name":"GPT-6 Codex","visibility":"list"}]}'
  exit 0
fi
exit 2
`,
      );
      chmodSync(codexBin, 0o755);
      process.env.OD_AGENT_HOME = dir;
      process.env.PATH = dir;

      const agents = await detectAgents();
      const detected = agents.find((agent) => agent.id === 'codex');

      assert.ok(detected);
      assert.equal(detected.available, true);
      assert.equal(detected.modelsSource, 'fallback');
      assert.deepEqual(detected.models.map((m: { id: string }) => m.id), [
        'gpt-5.6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
      ]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex picker is the closed GPT-5.6 family (Luna first = default, Sol, Terra) — no other ids', () => {
  const pickerModels = codex.fallbackModels.map((model) => model.id);

  assert.deepEqual(pickerModels, ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
});

test('cursor-agent parses live model ids separately from display labels', () => {
  assert.ok(cursorAgent.listModels, 'cursor-agent must define live model discovery');
  const parsed = cursorAgent.listModels.parse([
    'Available models',
    'auto - Auto',
    'composer-2.5 - Composer 2.5 (current)',
    'grok-4.3 - Grok 4.3 1M',
  ].join('\n'));

  assert.deepEqual(parsed, [
    { id: 'default', label: 'Default (CLI config)' },
    { id: 'auto', label: 'Auto' },
    { id: 'composer-2.5', label: 'Composer 2.5 (current)' },
    { id: 'grok-4.3', label: 'Grok 4.3 1M' },
  ]);
});

// Recent Codex CLI versions reject a bare `-` argv sentinel; passing it
// alongside the stdin pipe causes `error: unexpected argument '-' found`
// and exit code 2 before any prompt is read. We deliver the prompt via
// stdin pipe alone (gated by `promptViaStdin: true`). Regression of #237.
test('codex args do not include the literal `-` stdin sentinel (regression of #237)', () => {
  delete process.env.OD_CODEX_DISABLE_PLUGINS;

  const baseArgs = codex.buildArgs('', [], [], {}, { cwd: '/tmp/od-project' });
  assert.equal(baseArgs.includes('-'), false);

  const withModel = codex.buildArgs(
    '',
    [],
    [],
    { model: 'gpt-5-codex' },
    { cwd: '/tmp/od-project' },
  );
  assert.equal(withModel.includes('-'), false);

  const withReasoning = codex.buildArgs(
    '',
    [],
    [],
    { reasoning: 'high' },
    { cwd: '/tmp/od-project' },
  );
  assert.equal(withReasoning.includes('-'), false);

  process.env.OD_CODEX_DISABLE_PLUGINS = '1';
  const withDisablePlugins = codex.buildArgs(
    '',
    [],
    [],
    {},
    { cwd: '/tmp/od-project' },
  );
  assert.equal(withDisablePlugins.includes('-'), false);
});

test('codex args pass valid extraAllowedDirs with repeatable --add-dir flags', () => {
  delete process.env.OD_CODEX_DISABLE_PLUGINS;

  const args = codex.buildArgs(
    '',
    [],
    ['/repo/skills', '', null, '/tmp/codex/generated_images', undefined] as unknown as string[],
    {},
    { cwd: '/tmp/od-project' },
  );

  assert.deepEqual(
    args.filter((arg, index) => arg === '--add-dir' || args[index - 1] === '--add-dir'),
    ['--add-dir', '/repo/skills', '--add-dir', '/tmp/codex/generated_images'],
  );
});
