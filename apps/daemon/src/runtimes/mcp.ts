import type { RuntimeAgentDef } from './types.js';

type McpOptions = {
  enabled?: boolean;
  command?: string;
  argsPrefix?: string[];
  projectId?: string;
};

export function buildLiveArtifactsMcpServersForAgent(
  def: RuntimeAgentDef,
  { enabled = true, command = 'od', argsPrefix = [] }: McpOptions = {},
) {
  if (!enabled || def?.mcpDiscovery !== 'mature-acp') return [];
  return [
    {
      name: 'open-design-live-artifacts',
      command,
      args: [...argsPrefix, 'mcp', 'live-artifacts'],
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    },
  ];
}

export function buildOverviewMcpServersForAgent(
  def: RuntimeAgentDef,
  { enabled = true, command = 'od', argsPrefix = [], projectId }: McpOptions = {},
) {
  if (!enabled || def?.mcpDiscovery !== 'mature-acp' || projectId !== 'overview') return [];
  return [
    {
      name: 'open-design-overview',
      command,
      args: [...argsPrefix, 'mcp', 'overview'],
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    },
  ];
}
