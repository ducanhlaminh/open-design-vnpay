import type { Driver } from "neo4j-driver";
import type { KgConfig } from "./config.js";
import { withSession } from "./neo4j.js";
import type { LintViolation } from "./lint.js";

/**
 * Style authoring on the local KG — the Compositional Design Pattern:
 * a new style = new UI_THEME(s) for the axes that change + UI_TOKEN_VALUEs
 * for those themes + one UI_THEME_COMPOSITION that mixes new and cloned
 * layers via USES_THEME {order}.
 *
 * Property-first contract: agent nodes always carry the linking data as
 * properties (theme.kind/axisSlug, value.themeId/targetPath/scheme,
 * composition.layersJson). Edges (EMITS, USES_THEME, HAS_THEME) are derived
 * conveniences — `clone --refresh` DETACH-deletes cloned endpoints and takes
 * agent→clone edges with it, so every reader re-derives or re-links from
 * properties instead of trusting edges.
 */

export const THEME_KINDS = ["spacing", "rounded", "typography", "control-density", "visual", "icon", "brand"] as const;
export type ThemeKind = (typeof THEME_KINDS)[number];

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* ── theme ──────────────────────────────────────────────────────────────── */

export interface ThemeUpsertInput {
  id?: string;
  name: string;
  kind: ThemeKind;
  description?: string;
  /** Copy every token value of this existing (cloned or agent) theme first —
   * the realistic authoring flow: clone "Payment Glass Pro", then override. */
  basedOnThemeId?: string;
}

export async function themeUpsert(driver: Driver, config: KgConfig, input: ThemeUpsertInput): Promise<{ id: string; copiedValues: number }> {
  const ws = config.prototypeWorkspaceId;
  const id = input.id ?? `theme-${input.kind}-${slugify(input.name)}`;
  const now = new Date().toISOString();

  return withSession(driver, (session) =>
    session.executeWrite(async (tx) => {
      const upsert = await tx.run(
        `MERGE (t:UI_THEME {id: $id})
           ON CREATE SET t.createdAt = $now, t.workspaceId = $ws, t.source = 'agent'
         WITH t WHERE t.workspaceId = $ws AND t.odClonedFrom IS NULL
         SET t.name = $name, t.displayName = $name, t.slug = $slug, t.value = $slug,
             t.kind = $kind, t.axisSlug = $kind, t.description = $description,
             t.authored = true, t.updatedAt = $now
         RETURN t.id AS id`,
        { id, ws, now, name: input.name, slug: slugify(input.name), kind: input.kind, description: input.description ?? null },
      );
      if (upsert.records.length === 0) {
        throw new Error(`theme id "${id}" exists but is not agent-owned — pick another id`);
      }

      // Best-effort HAS_THEME from a cloned axis of the same kind (axis.kind is
      // null upstream; match via a sibling theme that carries the same kind).
      await tx.run(
        `MATCH (t:UI_THEME {id: $id})
         OPTIONAL MATCH (axis:UI_THEME_AXIS)-[:HAS_THEME]->(ref:UI_THEME {kind: $kind})
         WITH t, axis LIMIT 1
         FOREACH (_ IN CASE WHEN axis IS NULL THEN [] ELSE [1] END | MERGE (axis)-[:HAS_THEME]->(t))`,
        { id, kind: input.kind },
      );

      let copiedValues = 0;
      if (input.basedOnThemeId) {
        // Copy values; scheme derived from the source's IN_MODE edge (mode name
        // Dark/Light) or its own scheme property; stored as a plain property.
        const copy = await tx.run(
          `MATCH (src:UI_THEME {id: $fromId})-[:EMITS]->(v:UI_TOKEN_VALUE)
           OPTIONAL MATCH (v)-[:IN_MODE]->(m:UI_MODE)
           WITH v, coalesce(v.scheme, toLower(m.name)) AS scheme
           MATCH (t:UI_THEME {id: $id})
           MERGE (nv:UI_TOKEN_VALUE {id: $id + ':' + v.targetPath + ':' + coalesce(scheme, 'both')})
           SET nv.workspaceId = $ws, nv.source = 'agent', nv.themeId = $id,
               nv.targetPath = v.targetPath, nv.targetType = coalesce(v.targetType, 'token'),
               nv.rawValue = v.rawValue, nv.scheme = scheme, nv.authored = true,
               nv.name = v.targetPath, nv.value = v.targetPath, nv.updatedAt = $now
           MERGE (t)-[:EMITS]->(nv)
           RETURN count(nv) AS n`,
          { fromId: input.basedOnThemeId, id, ws, now },
        );
        copiedValues = Number(copy.records[0]?.get("n") ?? 0);
        if (copiedValues === 0) throw new Error(`basedOnThemeId "${input.basedOnThemeId}" has no EMITS values (wrong id?)`);
      }
      return { id, copiedValues };
    }),
  );
}

/* ── token values ───────────────────────────────────────────────────────── */

export interface TokenValueInput {
  targetPath: string;
  /** Same value in both schemes. */
  value?: string;
  dark?: string;
  light?: string;
}

export async function tokenValuesSet(driver: Driver, config: KgConfig, themeId: string, values: TokenValueInput[]): Promise<{ written: number }> {
  const ws = config.prototypeWorkspaceId;
  const now = new Date().toISOString();
  const rows: Array<{ path: string; raw: string; scheme: string | null }> = [];
  for (const v of values) {
    if (v.value === undefined && v.dark === undefined && v.light === undefined) {
      throw new Error(`targetPath "${v.targetPath}": pass value (both schemes) or dark/light`);
    }
    if (v.value !== undefined) rows.push({ path: v.targetPath, raw: v.value, scheme: null });
    if (v.dark !== undefined) rows.push({ path: v.targetPath, raw: v.dark, scheme: "dark" });
    if (v.light !== undefined) rows.push({ path: v.targetPath, raw: v.light, scheme: "light" });
  }

  return withSession(driver, (session) =>
    session.executeWrite(async (tx) => {
      const theme = await tx.run(
        `MATCH (t:UI_THEME {id: $themeId}) WHERE t.workspaceId = $ws AND t.odClonedFrom IS NULL RETURN t.id AS id`,
        { themeId, ws },
      );
      if (theme.records.length === 0) throw new Error(`theme "${themeId}" not found or not agent-owned — create it with ui_theme_upsert first`);

      const res = await tx.run(
        `MATCH (t:UI_THEME {id: $themeId})
         UNWIND $rows AS row
         // A scheme-specific write replaces a previous both-scheme value and vice versa.
         OPTIONAL MATCH (t)-[:EMITS]->(old:UI_TOKEN_VALUE {targetPath: row.path})
           WHERE (row.scheme IS NULL) OR (old.scheme IS NULL) OR old.scheme = row.scheme
         DETACH DELETE old
         WITH t, row
         MERGE (nv:UI_TOKEN_VALUE {id: $themeId + ':' + row.path + ':' + coalesce(row.scheme, 'both')})
         SET nv.workspaceId = $ws, nv.source = 'agent', nv.themeId = $themeId,
             nv.targetPath = row.path, nv.targetType = 'token', nv.rawValue = row.raw,
             nv.scheme = row.scheme, nv.authored = true,
             nv.name = row.path, nv.value = row.path, nv.updatedAt = $now
         MERGE (t)-[:EMITS]->(nv)
         RETURN count(nv) AS n`,
        { themeId, ws, now, rows },
      );
      return { written: Number(res.records[0]?.get("n") ?? 0) };
    }),
  );
}

/* ── composition ────────────────────────────────────────────────────────── */

export interface CompositionLayerInput { themeId: string; order: number }

export interface CompositionUpsertInput {
  id?: string;
  name: string;
  description?: string;
  /** Mix & match: agent theme ids and/or cloned theme ids, blended by order. */
  layers: CompositionLayerInput[];
  /** Mark as the prototype workspace's HAS_ACTIVE_COMPOSITION. */
  setActive?: boolean;
}

export async function compositionUpsert(driver: Driver, config: KgConfig, input: CompositionUpsertInput): Promise<{ id: string; linkedLayers: number }> {
  const ws = config.prototypeWorkspaceId;
  const id = input.id ?? `composition-${slugify(input.name)}`;
  const now = new Date().toISOString();
  const orders = input.layers.map((l) => l.order);
  if (new Set(orders).size !== orders.length) throw new Error("duplicate layer order — orders must be unique");

  return withSession(driver, (session) =>
    session.executeWrite(async (tx) => {
      const upsert = await tx.run(
        `MERGE (c:UI_THEME_COMPOSITION {id: $id})
           ON CREATE SET c.createdAt = $now, c.workspaceId = $ws, c.source = 'agent'
         WITH c WHERE c.workspaceId = $ws AND c.odClonedFrom IS NULL
         SET c.name = $name, c.displayName = $name, c.slug = $slug, c.value = $slug,
             c.description = $description, c.layersJson = $layersJson,
             c.authored = true, c.updatedAt = $now
         WITH c
         MERGE (w:UI_WORKSPACE {id: $ws})
           ON CREATE SET w.name = 'Open Design agent prototypes', w.source = 'agent', w.createdAt = $now
         MERGE (w)-[:OWNS_COMPOSITION]->(c)
         RETURN c.id AS id`,
        {
          id, ws, now, name: input.name, slug: slugify(input.name),
          description: input.description ?? null,
          layersJson: JSON.stringify([...input.layers].sort((a, b) => a.order - b.order)),
        },
      );
      if (upsert.records.length === 0) throw new Error(`composition id "${id}" exists but is not agent-owned — pick another id`);

      const linked = await relinkCompositionTx(tx, id);

      if (input.setActive) {
        await tx.run(
          `MATCH (w:UI_WORKSPACE {id: $ws}) OPTIONAL MATCH (w)-[old:HAS_ACTIVE_COMPOSITION]->() DELETE old`,
          { ws },
        );
        await tx.run(
          `MATCH (w:UI_WORKSPACE {id: $ws}) MATCH (c:UI_THEME_COMPOSITION {id: $id}) MERGE (w)-[:HAS_ACTIVE_COMPOSITION]->(c)`,
          { ws, id },
        );
      }
      return { id, linkedLayers: linked };
    }),
  );
}

interface TxLike { run(query: string, params?: Record<string, unknown>): Promise<{ records: Array<{ get(key: string): unknown }> }> }

/** Re-derive USES_THEME edges from layersJson (drops stale, recreates from the
 * property source of truth — no APOC on the local container, so layersJson is
 * parsed client-side). Returns how many layers resolved to a live theme. */
async function relinkCompositionTx(tx: TxLike, compositionId: string): Promise<number> {
  await tx.run(`MATCH (c:UI_THEME_COMPOSITION {id: $id})-[r:USES_THEME]->() DELETE r`, { id: compositionId });
  const c = await tx.run(`MATCH (c:UI_THEME_COMPOSITION {id: $id}) RETURN c.layersJson AS layers`, { id: compositionId });
  const layers = JSON.parse(String(c.records[0]?.get("layers") ?? "[]")) as CompositionLayerInput[];
  const res = await tx.run(
    `MATCH (c:UI_THEME_COMPOSITION {id: $id})
     UNWIND $layers AS layer
     MATCH (t:UI_THEME {id: layer.themeId})
     MERGE (c)-[r:USES_THEME]->(t) SET r.order = layer.order
     RETURN count(r) AS n`,
    { id: compositionId, layers },
  );
  return Number(res.records[0]?.get("n") ?? 0);
}

/* ── composition lint ───────────────────────────────────────────────────── */

export interface CompositionLayerInfo {
  themeId: string;
  order: number;
  kind: string | null;
  name: string | null;
  exists: boolean;
  cloned: boolean;
  valueCount: number;
}

export async function loadCompositionLayers(driver: Driver, compositionId: string): Promise<{ name: string; layers: CompositionLayerInfo[] } | null> {
  return withSession(driver, async (session) => {
    const comp = await session.run(
      `MATCH (c:UI_THEME_COMPOSITION) WHERE c.id = $id OR c.name = $id
       RETURN c.id AS id, c.name AS name, c.layersJson AS layersJson LIMIT 1`,
      { id: compositionId },
    );
    const record = comp.records[0];
    if (!record) return null;
    const id = String(record.get("id"));
    let layerRefs: CompositionLayerInput[];
    const layersJson = record.get("layersJson") as string | null;
    if (layersJson) {
      layerRefs = JSON.parse(layersJson) as CompositionLayerInput[];
    } else {
      // Cloned compositions: edges are the only source.
      const edges = await session.run(
        `MATCH (c:UI_THEME_COMPOSITION {id: $id})-[r:USES_THEME]->(t:UI_THEME)
         RETURN t.id AS themeId, r.order AS ord ORDER BY ord`,
        { id },
      );
      layerRefs = edges.records.map((e) => ({ themeId: String(e.get("themeId")), order: Number(e.get("ord") ?? 0) }));
    }
    const layers: CompositionLayerInfo[] = [];
    for (const ref of [...layerRefs].sort((a, b) => a.order - b.order)) {
      const t = await session.run(
        `OPTIONAL MATCH (t:UI_THEME {id: $themeId})
         OPTIONAL MATCH (t)-[:EMITS]->(v:UI_TOKEN_VALUE)
         WITH t, count(v) AS edgeVals
         OPTIONAL MATCH (pv:UI_TOKEN_VALUE {themeId: $themeId})
         WITH t, edgeVals, count(pv) AS propVals
         RETURN t IS NOT NULL AS exists, t.kind AS kind, t.name AS name,
                t.odClonedFrom IS NOT NULL AS cloned,
                CASE WHEN edgeVals > 0 THEN edgeVals ELSE propVals END AS valueCount`,
        { themeId: ref.themeId },
      );
      const row = t.records[0];
      layers.push({
        themeId: ref.themeId,
        order: ref.order,
        exists: Boolean(row?.get("exists")),
        kind: (row?.get("kind") as string | null) ?? null,
        name: (row?.get("name") as string | null) ?? null,
        cloned: Boolean(row?.get("cloned")),
        valueCount: Number(row?.get("valueCount") ?? 0),
      });
    }
    return { name: String(record.get("name")), layers };
  });
}

export async function compositionLint(driver: Driver, config: KgConfig, compositionId: string): Promise<LintViolation[]> {
  const violations: LintViolation[] = [];
  const loaded = await loadCompositionLayers(driver, compositionId);
  if (!loaded) return [{ rule: "composition-missing", severity: "error", message: `no UI_THEME_COMPOSITION with id/name "${compositionId}"` }];

  const { layers } = loaded;
  if (layers.length === 0) violations.push({ rule: "no-layers", severity: "error", message: "composition has no layers" });

  const kinds = new Map<string, number>();
  for (const layer of layers) {
    if (!layer.exists) {
      violations.push({ rule: "layer-theme-missing", severity: "error", nodeId: layer.themeId, message: `layer order=${layer.order} references theme "${layer.themeId}" which does not exist (deleted by clone --refresh? themes must be agent-owned or re-cloned)` });
      continue;
    }
    if (layer.kind) kinds.set(layer.kind, (kinds.get(layer.kind) ?? 0) + 1);
    if (layer.valueCount === 0 && layer.kind !== "icon") {
      violations.push({ rule: "layer-empty", severity: "warning", nodeId: layer.themeId, message: `layer "${layer.name}" (${layer.kind}) emits no token values` });
    }
  }
  for (const [kind, n] of kinds) {
    if (n > 1) violations.push({ rule: "duplicate-axis", severity: "error", message: `${n} layers share kind "${kind}" — one theme per axis (mix & match means swapping, not stacking same-axis themes)` });
  }
  const missing = THEME_KINDS.filter((k) => !kinds.has(k));
  if (missing.length > 0) {
    violations.push({ rule: "axis-coverage", severity: "warning", message: `composition covers ${kinds.size}/7 axes — missing: ${missing.join(", ")} (reuse cloned layers for axes you don't restyle)` });
  }

  // Dual-scheme completeness for agent layers: a path with exactly one scheme renders one-sided.
  await withSession(driver, async (session) => {
    for (const layer of layers.filter((l) => l.exists && !l.cloned)) {
      const res = await session.run(
        `MATCH (v:UI_TOKEN_VALUE {themeId: $themeId})
         WITH v.targetPath AS path, collect(DISTINCT v.scheme) AS schemes
         WHERE NOT null IN schemes AND size(schemes) = 1
         RETURN path, schemes[0] AS only LIMIT 20`,
        { themeId: layer.themeId },
      );
      for (const record of res.records) {
        violations.push({ rule: "single-scheme", severity: "warning", nodeId: layer.themeId, message: `"${record.get("path")}" only has a ${record.get("only")} value — the other scheme falls back to lower layers` });
      }
    }
  });

  return violations;
}
