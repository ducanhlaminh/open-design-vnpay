import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Driver } from "neo4j-driver";
import type { KgConfig } from "./config.js";
import { withSession } from "./neo4j.js";

/** Node shape of the react-shadcn skill's screen.json contract. */
export interface ScreenNode {
  id: string;
  componentSlug: string;
  props?: Record<string, unknown>;
  text?: string;
  children?: ScreenNode[];
}

export interface FlowEdge {
  from: string;
  to: string;
  type: string;
  label?: string;
}

/**
 * Stamp proving a screen.json was produced by `ui_screen_export` (graph -> JSON),
 * not hand-authored. `builder/validate.mjs` gates on this so the KG-first pipeline
 * can't be silently skipped ("forgot the graph, typed the JSON by hand").
 */
export interface ScreenProvenance {
  tool: "ui_screen_export";
  workspaceId: string;
  screenSlug: string;
  exportedAt: string;
}

export interface ScreenDocument {
  $schema?: string;
  /** Provenance stamp — see {@link ScreenProvenance}. Always present on KG exports. */
  __provenance: ScreenProvenance;
  version: number;
  source: string;
  screen: {
    slug: string;
    name: string;
    category?: string;
    viewport?: string;
    roots: ScreenNode[];
    flow?: FlowEdge[];
  };
}

interface RawInstance {
  id: string;
  componentSlug: string;
  text: string | null;
  props: string | null;
}

/**
 * Walks one screen's CONTAINS/COMPOSES tree (ordered by the rel `order`
 * property) out of the graph and emits the screen.json document the
 * react-shadcn shell consumes. Works for both cloned reference screens and
 * agent-authored prototype screens — `workspaceId` selects which.
 */
export async function exportScreen(
  driver: Driver,
  config: KgConfig,
  slug: string,
  options: { workspaceId?: string; withFlow?: boolean } = {},
): Promise<ScreenDocument> {
  const ws = options.workspaceId ?? config.prototypeWorkspaceId;

  return withSession(driver, async (session) => {
    const screenRes = await session.run(
      `MATCH (s:UI_PROJECT_SCREEN {slug: $slug})
       WHERE s.workspaceId = $ws OR $ws = '*'
       RETURN s.workspaceId AS ws, s.slug AS slug, s.name AS name, s.category AS category, s.viewport AS viewport
       LIMIT 1`,
      { slug, ws },
    );
    const screenRecord = screenRes.records[0];
    if (!screenRecord) throw new Error(`screen "${slug}" not found in workspace ${ws} (pass --workspace <id> or '*' to search all)`);
    const screenWs = String(screenRecord.get("ws"));

    // Pull the whole subtree once: parent/child pairs with order.
    const rootsRes = await session.run(
      `MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug})-[c:CONTAINS]->(root:UI_SCREEN_INSTANCE)
       RETURN root.id AS id, root.componentSlug AS componentSlug, root.text AS text, root.props AS props, c.order AS ord
       ORDER BY ord`,
      { ws: screenWs, slug },
    );
    const edgesRes = await session.run(
      `MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug})-[:CONTAINS]->(root:UI_SCREEN_INSTANCE)
       MATCH (root)-[:COMPOSES*0..]->(p:UI_SCREEN_INSTANCE)-[r:COMPOSES]->(child:UI_SCREEN_INSTANCE)
       RETURN DISTINCT p.id AS parentId, r.order AS ord,
              child.id AS id, child.componentSlug AS componentSlug, child.text AS text, child.props AS props`,
      { ws: screenWs, slug },
    );

    const childrenByParent = new Map<string, Array<RawInstance & { ord: number }>>();
    for (const record of edgesRes.records) {
      const parentId = String(record.get("parentId"));
      const list = childrenByParent.get(parentId) ?? [];
      list.push({
        id: String(record.get("id")),
        componentSlug: String(record.get("componentSlug")),
        text: record.get("text") as string | null,
        props: record.get("props") as string | null,
        ord: Number(record.get("ord") ?? 0),
      });
      childrenByParent.set(parentId, list);
    }
    for (const list of childrenByParent.values()) list.sort((a, b) => a.ord - b.ord);

    const visited = new Set<string>();
    const buildNode = (raw: RawInstance): ScreenNode => {
      if (visited.has(raw.id)) {
        throw new Error(`COMPOSES cycle at instance "${raw.id}" — run lint, fix the graph, re-export`);
      }
      visited.add(raw.id);
      const node: ScreenNode = { id: raw.id, componentSlug: raw.componentSlug };
      let props: Record<string, unknown> | undefined;
      if (raw.props != null && raw.props !== "") {
        try {
          props = JSON.parse(raw.props) as Record<string, unknown>;
        } catch {
          throw new Error(`instance "${raw.id}" has unparseable props JSON string`);
        }
      }
      if (props && Object.keys(props).length > 0) node.props = props;
      if (raw.text != null && raw.text !== "") node.text = raw.text;
      const kids = childrenByParent.get(raw.id) ?? [];
      if (kids.length > 0) node.children = kids.map(buildNode);
      return node;
    };

    const roots = rootsRes.records.map((record) =>
      buildNode({
        id: String(record.get("id")),
        componentSlug: String(record.get("componentSlug")),
        text: record.get("text") as string | null,
        props: record.get("props") as string | null,
      }),
    );
    if (roots.length === 0) throw new Error(`screen "${slug}" has no CONTAINS root instance`);

    const document: ScreenDocument = {
      __provenance: {
        tool: "ui_screen_export",
        workspaceId: screenWs,
        screenSlug: String(screenRecord.get("slug")),
        exportedAt: new Date().toISOString(),
      },
      version: 1,
      source: `od-kg-export:${screenWs}`,
      screen: {
        slug: String(screenRecord.get("slug")),
        name: String(screenRecord.get("name") ?? screenRecord.get("slug")),
        ...(screenRecord.get("category") ? { category: String(screenRecord.get("category")) } : {}),
        ...(screenRecord.get("viewport") ? { viewport: String(screenRecord.get("viewport")) } : {}),
        roots,
      },
    };

    if (options.withFlow) {
      const flowRes = await session.run(
        `MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug})-[:CONTAINS]->(root:UI_SCREEN_INSTANCE)
         MATCH (root)-[:COMPOSES*0..]->(i:UI_SCREEN_INSTANCE)
         MATCH (i)-[f:FLOWS_TO]->(t:UI_PROJECT_SCREEN)
         RETURN i.id AS fromId, t.slug AS toSlug, f.type AS type, f.label AS label`,
        { ws: screenWs, slug },
      );
      const flow = flowRes.records.map((record): FlowEdge => ({
        from: String(record.get("fromId")),
        to: String(record.get("toSlug")),
        type: String(record.get("type")),
        ...(record.get("label") ? { label: String(record.get("label")) } : {}),
      }));
      if (flow.length > 0) document.screen.flow = flow;
    }

    return document;
  });
}

/** Writes the document to <exportDir>/<slug>/screen.json and returns the path. */
export function writeScreenDocument(config: KgConfig, document: ScreenDocument, outDir?: string): string {
  const dir = outDir ?? resolve(config.exportDir, document.screen.slug);
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, "screen.json");
  writeFileSync(file, JSON.stringify(document, null, 2) + "\n");
  return file;
}
