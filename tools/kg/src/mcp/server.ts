import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Driver } from "neo4j-driver";
import type { KgConfig } from "../config.js";
import { createDriver, withSession } from "../neo4j.js";
import { ensureSchema } from "../schema.js";
import { assertReadOnlyCypher } from "../cypher-guard.js";
import { componentCatalogSlug, loadWhitelist, slugResolves } from "../components.js";
import { lintScreen } from "../lint.js";
import { exportScreen, writeScreenDocument } from "../export.js";
import {
  THEME_KINDS,
  compositionLint,
  compositionUpsert,
  themeUpsert,
  tokenValuesSet,
} from "../styles.js";
import { exportCompositionCss } from "../export-css.js";
import { getCompositionTokens } from "../tokens.js";

/**
 * od-kg stdio MCP server.
 *
 * Write policy: there is deliberately NO raw write-Cypher tool. Every write
 * goes through a typed ui_* tool that (a) hard-codes workspaceId to the
 * prototype workspace, (b) stamps source:'agent' + updatedAt, and (c) refuses
 * to touch nodes that carry odClonedFrom or live in another workspace. The
 * cloned reference graph is therefore immutable to agents and
 * `tools-kg clone --refresh` is always safe.
 */

const MAX_ROWS = 500;
const DEFAULT_ROWS = 100;
const TRUNCATE_VALUE_AT = 2000;
const INLINE_EXPORT_LIMIT = 50_000;

function text(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function truncateValues(value: unknown): unknown {
  if (typeof value === "string" && value.length > TRUNCATE_VALUE_AT) {
    return value.slice(0, TRUNCATE_VALUE_AT) + `… [truncated ${value.length - TRUNCATE_VALUE_AT} chars]`;
  }
  if (Array.isArray(value)) return value.map(truncateValues);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncateValues(v)]));
  }
  return value;
}

export async function runMcpServer(config: KgConfig): Promise<void> {
  // stdout belongs to the JSON-RPC transport. Rebind console BEFORE anything
  // else can print; all tool logging goes to stderr.
  const stderrLog = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
  console.log = stderrLog;
  console.info = stderrLog;
  console.warn = stderrLog;

  const driver: Driver = createDriver(config.boltUri, config.user, config.password);
  await ensureSchema(driver);
  const ws = config.prototypeWorkspaceId;

  /** Common guard for mutating tools: the target node must be agent-owned. */
  const agentOwnedGuard =
    "(n.workspaceId = $ws AND n.odClonedFrom IS NULL)";

  const server = new McpServer({ name: "od-kg", version: "0.1.0" });

  server.registerTool(
    "kg_cypher_read",
    {
      description:
        "Run a read-only Cypher query against the local UI knowledge graph (cloned reference data + agent prototypes). Write clauses are rejected; use the ui_* tools to mutate. Returns at most 500 rows.",
      inputSchema: {
        query: z.string().describe("Cypher, read-only (MATCH/RETURN/WHERE/ORDER BY/...)"),
        params: z.record(z.unknown()).optional().describe("query parameters"),
        limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`row cap, default ${DEFAULT_ROWS}`),
      },
    },
    async ({ query, params, limit }) => {
      assertReadOnlyCypher(query);
      const rows = await withSession(driver, async (session) => {
        const result = await session.executeRead((tx) => tx.run(query, params ?? {}));
        return result.records.slice(0, limit ?? DEFAULT_ROWS).map((record) => truncateValues(record.toObject()));
      });
      return text({ rowCount: rows.length, rows });
    },
  );

  server.registerTool(
    "kg_find",
    {
      description:
        "Find UI_* nodes by case-insensitive substring over name/slug/label/componentSlug. Convenience grounding search (catalog components, reference screens, compositions).",
      inputSchema: {
        term: z.string().min(1),
        label: z.string().regex(/^UI_[A-Z_]+$/).optional().describe("restrict to one label, e.g. UI_COMPONENT"),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ term, label, limit }) => {
      const rows = await withSession(driver, async (session) => {
        const result = await session.executeRead((tx) =>
          tx.run(
            `MATCH (n)
             WITH n, [l IN labels(n) WHERE l STARTS WITH 'UI_'][0] AS uiLabel
             WHERE uiLabel IS NOT NULL AND ($label IS NULL OR uiLabel = $label)
               AND any(v IN [n.name, n.slug, n.label, n.componentSlug, n.displayName]
                       WHERE v IS NOT NULL AND toLower(toString(v)) CONTAINS toLower($term))
             RETURN uiLabel AS label, n.id AS id, n.slug AS slug, n.name AS name,
                    n.componentSlug AS componentSlug, n.workspaceId AS workspaceId
             LIMIT toInteger($limit)`,
            { term, label: label ?? null, limit: Math.trunc(limit ?? 25) },
          ),
        );
        return result.records.map((record) => record.toObject());
      });
      return text({ rowCount: rows.length, rows });
    },
  );

  server.registerTool(
    "ui_screen_upsert",
    {
      description:
        `Create or update a prototype screen (UI_PROJECT_SCREEN) in the agent workspace "${ws}". Returns the screen node. Then attach a single root instance via ui_instance_upsert {screenSlug}.`,
      inputSchema: {
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe("kebab-case screen slug"),
        name: z.string().min(1),
        category: z.enum(["mobile", "web"]).optional(),
        viewport: z.enum(["mobile", "desktop"]).optional(),
      },
    },
    async ({ slug, name, category, viewport }) => {
      const row = await withSession(driver, async (session) => {
        const result = await session.executeWrite((tx) =>
          tx.run(
            `MERGE (w:UI_WORKSPACE {id: $ws})
               ON CREATE SET w.name = 'Open Design agent prototypes', w.source = 'agent', w.createdAt = $now
             MERGE (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug})
               ON CREATE SET s.id = 'scr-' + $slug, s.createdAt = $now, s.source = 'agent'
             SET s.name = $name, s.displayName = $name, s.value = $slug,
                 s.category = coalesce($category, s.category, 'mobile'),
                 s.viewport = coalesce($viewport, s.viewport, 'mobile'),
                 s.updatedAt = $now
             MERGE (w)-[:OWNS_SCREEN]->(s)
             RETURN s {.id, .slug, .name, .category, .viewport, .workspaceId} AS screen`,
            { ws, slug, name, category: category ?? null, viewport: viewport ?? null, now: new Date().toISOString() },
          ),
        );
        return result.records[0]?.get("screen");
      });
      return text({ screen: row });
    },
  );

  server.registerTool(
    "ui_instance_upsert",
    {
      description:
        "Create or update one UI_SCREEN_INSTANCE node in the prototype workspace and (re)attach it. Pass EXACTLY ONE of screenSlug (root via CONTAINS{order}) or parentId (child via COMPOSES{order}). props is a JSON object — it is stored as a JSON string per the graph contract. componentSlug outside the shell whitelist is accepted with a warning (it would render as a red ?slug badge).",
      inputSchema: {
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).optional().describe("stable instance id; auto-generated (inst-…) when omitted"),
        screenSlug: z.string().optional().describe("attach as ROOT of this screen (CONTAINS)"),
        parentId: z.string().optional().describe("attach as CHILD of this instance (COMPOSES)"),
        order: z.number().int().min(1).describe("1-based position among siblings"),
        componentSlug: z.string().min(1).describe('PascalCase export ("Button") or HTML tag ("div")'),
        props: z.record(z.unknown()).optional(),
        text: z.string().optional(),
        label: z.string().optional(),
      },
    },
    async (args) => {
      if ((args.screenSlug ? 1 : 0) + (args.parentId ? 1 : 0) !== 1) {
        throw new Error("pass exactly one of screenSlug (root) or parentId (child)");
      }
      const warnings: string[] = [];
      const whitelist = loadWhitelist(config.repoRoot);
      if (whitelist && !slugResolves(whitelist, args.componentSlug)) {
        warnings.push(`componentSlug "${args.componentSlug}" is outside the shell whitelist — it will render as a red ?slug badge (see references/components.md)`);
      }
      const id = args.id ?? `inst-${randomUUID().slice(0, 12)}`;
      const now = new Date().toISOString();
      const catalogSlug = componentCatalogSlug(args.componentSlug);

      const row = await withSession(driver, async (session) =>
        session.executeWrite(async (tx) => {
          // Upsert the node — refuse to repurpose a cloned/foreign node id.
          const upsert = await tx.run(
            `MERGE (n:UI_SCREEN_INSTANCE {id: $id})
               ON CREATE SET n.createdAt = $now, n.workspaceId = $ws, n.source = 'agent'
             WITH n WHERE ${agentOwnedGuard}
             SET n.componentSlug = $componentSlug, n.value = $componentSlug,
                 n.label = $label, n.displayName = $label, n.name = $label,
                 n.text = $text, n.props = $props, n.order = $order,
                 n.updatedAt = $now
             RETURN n.id AS id`,
            {
              id, ws, now,
              componentSlug: args.componentSlug,
              label: args.label ?? null,
              text: args.text ?? null,
              props: JSON.stringify(args.props ?? {}),
              order: Math.trunc(args.order),
            },
          );
          if (upsert.records.length === 0) {
            throw new Error(`instance id "${id}" exists but is not agent-owned (cloned reference or foreign workspace) — pick another id`);
          }

          // Re-parent: drop any previous incoming attachment, then attach.
          await tx.run(
            `MATCH (n:UI_SCREEN_INSTANCE {id: $id})<-[r:CONTAINS|COMPOSES]-() DELETE r`,
            { id },
          );
          if (args.screenSlug) {
            const attach = await tx.run(
              `MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $screenSlug})
               MATCH (n:UI_SCREEN_INSTANCE {id: $id})
               MERGE (s)-[r:CONTAINS]->(n) SET r.order = $order
               RETURN s.slug AS attachedTo`,
              { ws, screenSlug: args.screenSlug, id, order: Math.trunc(args.order) },
            );
            if (attach.records.length === 0) throw new Error(`screen "${args.screenSlug}" not found in workspace ${ws} — call ui_screen_upsert first`);
          } else {
            const attach = await tx.run(
              `MATCH (p:UI_SCREEN_INSTANCE {id: $parentId})
               WHERE p.workspaceId = $ws AND p.odClonedFrom IS NULL
               MATCH (n:UI_SCREEN_INSTANCE {id: $id})
               MERGE (p)-[r:COMPOSES]->(n) SET r.order = $order
               RETURN p.id AS attachedTo`,
              { parentId: args.parentId, ws, id, order: Math.trunc(args.order) },
            );
            if (attach.records.length === 0) throw new Error(`parent instance "${args.parentId}" not found or not agent-owned`);
          }

          // Best-effort catalog traceability (cloned UI_COMPONENT may not exist).
          await tx.run(
            `MATCH (n:UI_SCREEN_INSTANCE {id: $id})
             OPTIONAL MATCH (c:UI_COMPONENT {slug: $catalogSlug})
             FOREACH (_ IN CASE WHEN c IS NULL THEN [] ELSE [1] END | MERGE (n)-[:RENDERS_AS]->(c))`,
            { id, catalogSlug },
          );
          return id;
        }),
      );
      return text({ id: row, warnings });
    },
  );

  server.registerTool(
    "ui_flow_link",
    {
      description:
        "Link a trigger instance to a target screen with FLOWS_TO (navigate | showDialog | closeDialog). Both ends must live in the prototype workspace.",
      inputSchema: {
        fromInstanceId: z.string().min(1),
        toScreenSlug: z.string().min(1),
        type: z.enum(["navigate", "showDialog", "closeDialog"]),
        label: z.string().optional().describe("arrow label; defaults to the trigger's text"),
      },
    },
    async ({ fromInstanceId, toScreenSlug, type, label }) => {
      const row = await withSession(driver, async (session) =>
        session.executeWrite(async (tx) => {
          const result = await tx.run(
            `MATCH (i:UI_SCREEN_INSTANCE {id: $fromInstanceId})
             WHERE i.workspaceId = $ws AND i.odClonedFrom IS NULL
             MATCH (t:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $toScreenSlug})
             MERGE (i)-[r:FLOWS_TO {type: $type}]->(t)
             SET r.label = coalesce($label, i.text)
             RETURN i.id AS from, t.slug AS to, r.type AS type, r.label AS label`,
            { fromInstanceId, ws, toScreenSlug, type, label: label ?? null },
          );
          if (result.records.length === 0) {
            throw new Error(`trigger "${fromInstanceId}" (agent-owned) or target screen "${toScreenSlug}" not found in workspace ${ws}`);
          }
          return result.records[0].toObject();
        }),
      );
      return text(row);
    },
  );

  server.registerTool(
    "ui_screen_lint",
    {
      description:
        "Lint one prototype screen subgraph: unknown componentSlug, orphan instances, duplicate sibling order, COMPOSES cycles, invalid props JSON, flow targets, root count. Run before ui_screen_export.",
      inputSchema: { slug: z.string().min(1) },
    },
    async ({ slug }) => {
      const violations = await lintScreen(driver, config, slug);
      const errors = violations.filter((v) => v.severity === "error").length;
      return text({ slug, ok: errors === 0, errors, violations });
    },
  );

  server.registerTool(
    "ui_screen_export",
    {
      description:
        "Export a screen's graph tree to a react-shadcn screen.json document (CONTAINS/COMPOSES walked by order, props JSON-parsed). Writes <exportDir>/<slug>/screen.json and returns the document (truncated inline past 50KB). Use workspaceId '*' to export cloned reference screens too.",
      inputSchema: {
        slug: z.string().min(1),
        workspaceId: z.string().optional().describe(`default "${ws}"; pass '*' to search all workspaces`),
        withFlow: z.boolean().optional().describe("include flow[] edges (FLOWS_TO)"),
        outDir: z.string().optional().describe("absolute output dir; default <exportDir>/<slug>/"),
      },
    },
    async ({ slug, workspaceId, withFlow, outDir }) => {
      const document = await exportScreen(driver, config, slug, { workspaceId, withFlow });
      const file = writeScreenDocument(config, document, outDir);
      const json = JSON.stringify(document, null, 2);
      return text({
        file,
        nodes: json.match(/"componentSlug"/g)?.length ?? 0,
        document: json.length > INLINE_EXPORT_LIMIT ? `[${json.length} bytes — read ${file}]` : document,
      });
    },
  );

  server.registerTool(
    "ui_screen_delete",
    {
      description:
        "Delete an agent-owned prototype screen (whole CONTAINS/COMPOSES subtree) or, with instanceId, just that instance's subtree. Refuses cloned reference nodes.",
      inputSchema: {
        slug: z.string().min(1),
        instanceId: z.string().optional().describe("delete only this instance's subtree instead of the whole screen"),
      },
    },
    async ({ slug, instanceId }) => {
      const deleted = await withSession(driver, async (session) =>
        session.executeWrite(async (tx) => {
          if (instanceId) {
            const result = await tx.run(
              `MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug})-[:CONTAINS]->(root:UI_SCREEN_INSTANCE)
               MATCH (root)-[:COMPOSES*0..]->(i:UI_SCREEN_INSTANCE {id: $instanceId})
               MATCH (i)-[:COMPOSES*0..]->(d:UI_SCREEN_INSTANCE)
               WITH collect(DISTINCT d) AS nodes
               WHERE all(x IN nodes WHERE x.workspaceId = $ws AND x.odClonedFrom IS NULL)
               UNWIND nodes AS n DETACH DELETE n
               RETURN count(n) AS deleted`,
              { ws, slug, instanceId },
            );
            return Number(result.records[0]?.get("deleted") ?? 0);
          }
          const result = await tx.run(
            `MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug})
             WHERE s.odClonedFrom IS NULL
             OPTIONAL MATCH (s)-[:CONTAINS]->(:UI_SCREEN_INSTANCE)-[:COMPOSES*0..]->(d:UI_SCREEN_INSTANCE)
             WITH s, collect(DISTINCT d) AS nodes
             WHERE all(x IN nodes WHERE x.workspaceId = $ws AND x.odClonedFrom IS NULL)
             FOREACH (n IN nodes | DETACH DELETE n)
             DETACH DELETE s
             RETURN size(nodes) + 1 AS deleted`,
            { ws, slug },
          );
          return Number(result.records[0]?.get("deleted") ?? 0);
        }),
      );
      if (deleted === 0) throw new Error(`nothing deleted — screen/instance not found in workspace ${ws}, or subtree contains non-agent nodes`);
      return text({ deleted });
    },
  );

  /* ── style authoring (Compositional Design Pattern) ────────────────────── */

  server.registerTool(
    "ui_tokens_get",
    {
      description:
        "Creative grounding for KG-driven prototypes: returns the user-chosen composition's RESOLVED token palette (values per dark/light scheme, grouped, with the Tailwind semantic utilities available per color token) PLUS the vars-only cssVars payload. Workflow: read `palette` to judge color relationships, then fill `cssVars` into the artifact — write it as <artifact>/brand.css (door 1) or paste into the <style id=\"brand\"> slot in shell.html (door 2, srcDoc environments). Then compose the screen creatively using ONLY the listed utilities.",
      inputSchema: {
        compositionId: z.string().min(1).describe("composition id or exact name (the one the user chose)"),
      },
    },
    async ({ compositionId }) => {
      const result = await getCompositionTokens(driver, config, compositionId);
      return text(result);
    },
  );

  server.registerTool(
    "ui_theme_upsert",
    {
      description:
        `Create/update an agent-owned UI_THEME (one axis layer of a style) in workspace "${ws}". The realistic flow: pass basedOnThemeId to copy ALL token values from an existing theme (e.g. cloned "Payment Glass Pro"), then override specific paths with ui_token_values_set. kind = the axis this theme restyles.`,
      inputSchema: {
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).optional().describe("default: theme-<kind>-<slug(name)>"),
        name: z.string().min(1),
        kind: z.enum(THEME_KINDS),
        description: z.string().optional(),
        basedOnThemeId: z.string().optional().describe("copy every token value of this theme first (clone-and-tweak)"),
      },
    },
    async (args) => {
      const result = await themeUpsert(driver, config, args);
      return text(result);
    },
  );

  server.registerTool(
    "ui_token_values_set",
    {
      description:
        "Bulk-set token values on an agent-owned theme. Each entry: targetPath + either value (both schemes) or dark/light. rawValue formats: plain CSS, paint JSON ({type:'paint',layers:[…]} — gradients supported), shadow JSON, or Tailwind class-token (bg-[…] backdrop-blur-[…] … for glass surfaces). Stored per the real graph contract (scheme property + EMITS edge).",
      inputSchema: {
        themeId: z.string().min(1),
        values: z.array(z.object({
          targetPath: z.string().min(1).describe('token path, e.g. "primary", "background", "radius-card"'),
          value: z.string().optional().describe("same in both schemes"),
          dark: z.string().optional(),
          light: z.string().optional(),
        })).min(1),
      },
    },
    async ({ themeId, values }) => {
      const result = await tokenValuesSet(driver, config, themeId, values);
      return text(result);
    },
  );

  server.registerTool(
    "ui_composition_upsert",
    {
      description:
        "Create/update an agent-owned UI_THEME_COMPOSITION = mix & match of theme layers (agent AND cloned themes) blended by order. layers persist in layersJson (property source of truth — survives clone --refresh; edges are re-derived). setActive marks it HAS_ACTIVE_COMPOSITION for the prototype workspace.",
      inputSchema: {
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).optional().describe("default: composition-<slug(name)>"),
        name: z.string().min(1),
        description: z.string().optional(),
        layers: z.array(z.object({
          themeId: z.string().min(1),
          order: z.number().int().min(1),
        })).min(1).describe("1 theme per axis; reuse cloned layer ids for axes you don't restyle"),
        setActive: z.boolean().optional(),
      },
    },
    async (args) => {
      const result = await compositionUpsert(driver, config, args);
      return text(result);
    },
  );

  server.registerTool(
    "ui_composition_lint",
    {
      description:
        "Lint a composition (agent or cloned): layers resolve, one theme per axis, 7-axis coverage, themes emit values, dual-scheme completeness. Run before ui_composition_export_css.",
      inputSchema: { compositionId: z.string().min(1).describe("composition id or exact name") },
    },
    async ({ compositionId }) => {
      const violations = await compositionLint(driver, config, compositionId);
      const errors = violations.filter((v) => v.severity === "error").length;
      return text({ compositionId, ok: errors === 0, errors, violations });
    },
  );

  server.registerTool(
    "ui_composition_export_css",
    {
      description:
        "Resolve a composition's full layer stack from the local graph into a standalone dual-scheme stylesheet (vnpay-glass.css shape: :root light + html.dark + glass/control [data-slot] bindings). Include it AFTER theme.css in the react-shadcn shell to SEE the style on real components. Works for cloned compositions too (e.g. 'VNPAY Glass').",
      inputSchema: {
        compositionId: z.string().min(1).describe("composition id or exact name"),
        outFile: z.string().optional().describe("absolute output path; default <exportDir>/_css/<name>.css"),
        varsOnly: z.boolean().optional().describe("emit only :root/html.dark value blocks — the brand.css payload to place beside an artifact (structural rules live in the shell). Use this for artifact branding."),
      },
    },
    async ({ compositionId, outFile, varsOnly }) => {
      const result = await exportCompositionCss(driver, config, compositionId, { outFile, varsOnly });
      return text(result);
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  stderrLog(`[od-kg] MCP server up — bolt ${config.boltUri}, workspace ${ws}`);

  // Keep the driver alive for the life of the transport; exit when the host
  // closes our stdin (the open bolt connection would otherwise keep the
  // process alive forever).
  await new Promise<void>((resolvePromise) => {
    transport.onclose = () => resolvePromise();
    process.stdin.on("end", () => resolvePromise());
    process.stdin.on("close", () => resolvePromise());
  });
  await driver.close();
}
