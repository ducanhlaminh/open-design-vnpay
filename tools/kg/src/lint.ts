import type { Driver } from "neo4j-driver";
import type { KgConfig } from "./config.js";
import { withSession } from "./neo4j.js";
import { componentCatalogSlug, loadWhitelist, slugResolves } from "./components.js";

export type LintSeverity = "error" | "warning" | "info";

export interface LintViolation {
  rule: string;
  severity: LintSeverity;
  nodeId?: string;
  message: string;
}

/**
 * Lints one screen subgraph in the prototype workspace. Rules mirror what the
 * shell renderer and exporter require; `error` means export/render WILL
 * misbehave (red ?slug badge, broken ordering, unexportable cycle…).
 */
export async function lintScreen(driver: Driver, config: KgConfig, slug: string): Promise<LintViolation[]> {
  const violations: LintViolation[] = [];
  const ws = config.prototypeWorkspaceId;

  await withSession(driver, async (session) => {
    const screenRes = await session.run(
      "MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug}) RETURN s.id AS id",
      { ws, slug },
    );
    if (screenRes.records.length === 0) {
      violations.push({ rule: "screen-missing", severity: "error", message: `no UI_PROJECT_SCREEN slug "${slug}" in workspace ${ws}` });
      return;
    }

    // Tree instances reachable from the screen.
    const instRes = await session.run(
      `MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug})
       MATCH (s)-[:CONTAINS]->(root:UI_SCREEN_INSTANCE)
       MATCH (root)-[:COMPOSES*0..]->(i:UI_SCREEN_INSTANCE)
       RETURN DISTINCT i.id AS id, i.componentSlug AS componentSlug, i.props AS props`,
      { ws, slug },
    );
    const whitelist = loadWhitelist(config.repoRoot);
    for (const record of instRes.records) {
      const id = String(record.get("id"));
      const componentSlug = record.get("componentSlug") as string | null;
      const props = record.get("props") as string | null;
      if (!componentSlug) {
        violations.push({ rule: "unknown-component", severity: "error", nodeId: id, message: "instance has no componentSlug" });
      } else if (whitelist && !slugResolves(whitelist, componentSlug)) {
        violations.push({
          rule: "unknown-component", severity: "error", nodeId: id,
          message: `componentSlug "${componentSlug}" (catalog "${componentCatalogSlug(componentSlug)}") is outside the shell whitelist -> red ?slug badge`,
        });
      }
      if (props != null && props !== "") {
        try { JSON.parse(props); } catch {
          violations.push({ rule: "invalid-props-json", severity: "error", nodeId: id, message: "props string is not valid JSON" });
        }
      }
    }

    // multiple-roots (the shell tolerates several, design-v3 norm is exactly one).
    const rootsRes = await session.run(
      `MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug})-[c:CONTAINS]->(:UI_SCREEN_INSTANCE)
       RETURN count(c) AS roots`,
      { ws, slug },
    );
    const roots = Number(rootsRes.records[0]?.get("roots") ?? 0);
    if (roots === 0) violations.push({ rule: "no-root", severity: "error", message: "screen has no CONTAINS root instance" });
    if (roots > 1) violations.push({ rule: "multiple-roots", severity: "warning", message: `screen has ${roots} CONTAINS roots (norm is exactly 1 — wrap in a div shell)` });

    // duplicate-order among siblings (CONTAINS and COMPOSES).
    const dupRes = await session.run(
      `MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug})
       MATCH (s)-[:CONTAINS]->(root:UI_SCREEN_INSTANCE)
       MATCH (root)-[:COMPOSES*0..]->(p:UI_SCREEN_INSTANCE)
       MATCH (p)-[r:COMPOSES]->(:UI_SCREEN_INSTANCE)
       WITH p, r.order AS ord, count(*) AS n WHERE n > 1
       RETURN p.id AS parentId, ord, n`,
      { ws, slug },
    );
    for (const record of dupRes.records) {
      violations.push({
        rule: "duplicate-order", severity: "error", nodeId: String(record.get("parentId")),
        message: `parent has ${record.get("n")} children with COMPOSES order=${record.get("ord")} — child order is ambiguous`,
      });
    }

    // composes-cycle inside this screen's subtree.
    const cycleRes = await session.run(
      `MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug})
       MATCH (s)-[:CONTAINS]->(root:UI_SCREEN_INSTANCE)
       MATCH (root)-[:COMPOSES*0..]->(i:UI_SCREEN_INSTANCE)
       WHERE (i)-[:COMPOSES*1..]->(i)
       RETURN DISTINCT i.id AS id LIMIT 5`,
      { ws, slug },
    );
    for (const record of cycleRes.records) {
      violations.push({ rule: "composes-cycle", severity: "error", nodeId: String(record.get("id")), message: "instance participates in a COMPOSES cycle — export would never terminate" });
    }

    // flow-target-missing: FLOWS_TO out of this screen's instances must hit an
    // existing prototype-workspace screen.
    const flowRes = await session.run(
      `MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug})
       MATCH (s)-[:CONTAINS]->(root:UI_SCREEN_INSTANCE)
       MATCH (root)-[:COMPOSES*0..]->(i:UI_SCREEN_INSTANCE)
       MATCH (i)-[f:FLOWS_TO]->(t)
       RETURN i.id AS fromId, f.type AS type, t.slug AS toSlug, t.workspaceId AS toWs`,
      { ws, slug },
    );
    for (const record of flowRes.records) {
      const toWs = record.get("toWs") as string | null;
      if (toWs !== ws) {
        violations.push({
          rule: "flow-target-missing", severity: "error", nodeId: String(record.get("fromId")),
          message: `FLOWS_TO "${record.get("toSlug")}" targets workspace "${toWs}" — flow targets must be prototype-workspace screens`,
        });
      }
    }

    // orphan-instance: prototype-ws instances reachable from no screen at all.
    const orphanRes = await session.run(
      `MATCH (i:UI_SCREEN_INSTANCE {workspaceId: $ws})
       WHERE NOT (:UI_PROJECT_SCREEN)-[:CONTAINS]->(i)
         AND NOT (:UI_SCREEN_INSTANCE)-[:COMPOSES]->(i)
       RETURN i.id AS id LIMIT 20`,
      { ws },
    );
    for (const record of orphanRes.records) {
      violations.push({ rule: "orphan-instance", severity: "warning", nodeId: String(record.get("id")), message: "instance is attached to no screen (no incoming CONTAINS/COMPOSES) — delete or re-parent" });
    }

    // missing-renders-as (traceability only).
    const noRaRes = await session.run(
      `MATCH (s:UI_PROJECT_SCREEN {workspaceId: $ws, slug: $slug})
       MATCH (s)-[:CONTAINS]->(root:UI_SCREEN_INSTANCE)
       MATCH (root)-[:COMPOSES*0..]->(i:UI_SCREEN_INSTANCE)
       WHERE NOT (i)-[:RENDERS_AS]->(:UI_COMPONENT)
       RETURN count(DISTINCT i) AS n`,
      { ws, slug },
    );
    const noRa = Number(noRaRes.records[0]?.get("n") ?? 0);
    if (noRa > 0) {
      violations.push({ rule: "missing-renders-as", severity: "info", message: `${noRa} instance(s) without RENDERS_AS catalog edge (traceability only — HTML fallbacks never have one)` });
    }
  });

  return violations;
}
