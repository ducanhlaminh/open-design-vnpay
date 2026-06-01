/**
 * Side-effect registration of custom tool renderers for the sm-mcp
 * Knowledge Graph server. Imported once from `App.tsx` so the registry
 * is primed before any chat message renders.
 *
 * Both naming forms are registered:
 *   - `kg_search` / `kg_get_node` / `kg_subgraph`           (bare)
 *   - `mcp__sm-mcp__kg_search` / ... / `kg_subgraph`         (Claude Code prefix)
 *   - `mcp__sm_mcp__kg_search` / ...                         (underscore variant)
 * Different agent CLIs disagree on whether to prefix MCP tool names, so
 * we cover the realistic permutations rather than guess.
 */
import { createElement } from 'react';
import { registerToolRenderer } from './tool-renderers';
import {
  KgSearchCard,
  KgGetNodeCard,
  KgSubgraphCard,
  KgNeighborsCard,
  KgThemeCompositionCard,
  KgDescribeCard,
  KgSchemaCard,
  KgCypherCard,
} from '../components/KgToolCards';

// One entry per tool; expanded below across the bare + mcp__sm-mcp__ +
// mcp__sm_mcp__ naming variants so we match whatever the agent emits.
const TOOLS: Array<[string, (props: any) => any]> = [
  ['kg_describe', KgDescribeCard],
  ['kg_describe_schema', KgSchemaCard],
  ['kg_cypher_read', KgCypherCard],
  ['kg_search', KgSearchCard],
  ['kg_get_node', KgGetNodeCard],
  ['kg_subgraph', KgSubgraphCard],
  ['kg_neighbors', KgNeighborsCard],
  ['kg_get_theme_composition', KgThemeCompositionCard],
];

const PREFIXES = ['', 'mcp__sm-mcp__', 'mcp__sm_mcp__'];

const REGISTRATIONS: Array<[string, (props: any) => any]> = TOOLS.flatMap(
  ([name, card]) => PREFIXES.map((p) => [p + name, card] as [string, (props: any) => any]),
);

for (const [name, Component] of REGISTRATIONS) {
  registerToolRenderer(name, (props) => createElement(Component, props));
}
