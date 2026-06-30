import type { Driver } from "neo4j-driver";
import type { KgConfig } from "./config.js";
import { createDriver, quoteIdentifier, verifyConnectivity, withSession } from "./neo4j.js";
import { ensureSchema } from "./schema.js";

const BATCH = 500;

interface NodeRow {
  id: string;
  props: Record<string, unknown>;
  labels: string[];
}

interface RelRow {
  type: string;
  props: Record<string, unknown>;
  fromId: string;
  fromLabel: string;
  toId: string;
  toLabel: string;
}

/** First UI_* label is the anchor used for MERGE/MATCH (id constraints are per label). */
function primaryLabel(labels: string[]): string {
  const ui = labels.find((l) => l.startsWith("UI_"));
  if (!ui) throw new Error(`node without UI_ label leaked into clone: ${labels.join(",")}`);
  return ui;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export interface CloneOptions {
  refresh: boolean;
  /** Override source connection (defaults from config/env). */
  from?: string;
  user?: string;
  password?: string;
}

export async function clone(config: KgConfig, options: CloneOptions): Promise<void> {
  const sourceUri = options.from ?? config.sourceBoltUri;
  const source = createDriver(sourceUri, options.user ?? config.sourceUser, options.password ?? config.sourcePassword);
  const local = createDriver(config.boltUri, config.user, config.password);
  const clonedAt = new Date().toISOString();

  try {
    await verifyConnectivity(source, `source neo4j at ${sourceUri}`, 10_000);
    await verifyConnectivity(local, `local neo4j at ${config.boltUri}`, 10_000);

    // 1. Discover UI_* labels on the source.
    const labels = await withSession(source, async (s) => {
      const res = await s.run("CALL db.labels() YIELD label RETURN label");
      return res.records.map((r) => String(r.get("label"))).filter((l) => l.startsWith("UI_"));
    });
    if (labels.length === 0) throw new Error(`source ${sourceUri} has no UI_* labels — wrong database?`);
    labels.forEach((l) => quoteIdentifier(l)); // validate before any interpolation
    console.error(`[clone] source labels: ${labels.join(", ")}`);

    // 2. --refresh: wipe ONLY previously-cloned reference data. Agent-authored
    //    nodes never carry odClonedFrom and always live in the prototype
    //    workspace, so they are doubly excluded.
    if (options.refresh) {
      await withSession(local, async (s) => {
        const res = await s.run(
          `MATCH (n) WHERE n.odClonedFrom IS NOT NULL
             AND (n.workspaceId IS NULL OR n.workspaceId <> $protoWs)
           CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS`,
          { protoWs: config.prototypeWorkspaceId },
        );
        console.error(`[clone] refresh: wiped previously cloned nodes (${res.summary.counters.updates().nodesDeleted} deleted)`);
      });
    }

    // 3. Schema before bulk MERGE so id lookups are index-backed.
    await ensureSchema(local, labels);

    // 4. Copy nodes per label. Source nodes in the prototype workspace are
    //    skipped (paranoia guard — they should not exist upstream).
    const nodeCounts = new Map<string, { source: number; local: number }>();
    for (const label of labels) {
      const l = quoteIdentifier(label);
      const rows = await withSession(source, async (s) => {
        const res = await s.run(
          `MATCH (n:${l})
           WHERE n.workspaceId IS NULL OR n.workspaceId <> $protoWs
           RETURN coalesce(n.id, 'od-syn-' + elementId(n)) AS id, properties(n) AS props, labels(n) AS labels`,
          { protoWs: config.prototypeWorkspaceId },
        );
        return res.records.map((r): NodeRow => ({
          id: String(r.get("id")),
          props: r.get("props") as Record<string, unknown>,
          labels: r.get("labels") as string[],
        }));
      });

      // Group by full (sorted) label set so secondary labels are applied statically.
      const byLabelSet = new Map<string, NodeRow[]>();
      for (const row of rows) {
        if (primaryLabel(row.labels) !== label) continue; // copied once, under its primary label
        const key = [...row.labels].sort().join("|");
        (byLabelSet.get(key) ?? byLabelSet.set(key, []).get(key)!).push(row);
      }

      let written = 0;
      for (const [key, group] of byLabelSet) {
        const labelSet = key.split("|");
        labelSet.forEach((x) => quoteIdentifier(x));
        const secondary = labelSet.filter((x) => x !== label);
        const setLabels = secondary.length ? `SET n:${secondary.map(quoteIdentifier).join(":")}` : "";
        for (const batch of chunk(group, BATCH)) {
          await withSession(local, async (s) => {
            await s.run(
              `UNWIND $rows AS row
               MERGE (n:${l} {id: row.id})
               SET n += row.props, n.id = row.id, n.odClonedFrom = $src, n.odClonedAt = $ts
               ${setLabels}`,
              { rows: batch, src: sourceUri, ts: clonedAt },
            );
          });
          written += batch.length;
        }
      }
      nodeCounts.set(label, { source: rows.length, local: written });
    }

    // 5. Copy every relationship whose BOTH endpoints carry a UI_* label.
    const relRows = await withSession(source, async (s) => {
      const res = await s.run(
        `MATCH (a)-[r]->(b)
         WHERE any(l IN labels(a) WHERE l STARTS WITH 'UI_')
           AND any(l IN labels(b) WHERE l STARTS WITH 'UI_')
           AND (a.workspaceId IS NULL OR a.workspaceId <> $protoWs)
           AND (b.workspaceId IS NULL OR b.workspaceId <> $protoWs)
         RETURN type(r) AS type, properties(r) AS props,
                coalesce(a.id, 'od-syn-' + elementId(a)) AS fromId, labels(a) AS fromLabels,
                coalesce(b.id, 'od-syn-' + elementId(b)) AS toId, labels(b) AS toLabels`,
        { protoWs: config.prototypeWorkspaceId },
      );
      return res.records.map((r): RelRow => ({
        type: String(r.get("type")),
        props: r.get("props") as Record<string, unknown>,
        fromId: String(r.get("fromId")),
        fromLabel: primaryLabel(r.get("fromLabels") as string[]),
        toId: String(r.get("toId")),
        toLabel: primaryLabel(r.get("toLabels") as string[]),
      }));
    });

    const byGroup = new Map<string, RelRow[]>();
    for (const row of relRows) {
      const key = `${row.type}|${row.fromLabel}|${row.toLabel}`;
      (byGroup.get(key) ?? byGroup.set(key, []).get(key)!).push(row);
    }
    const relCounts = new Map<string, number>();
    for (const [key, group] of byGroup) {
      const [type, fromLabel, toLabel] = key.split("|");
      const [t, la, lb] = [quoteIdentifier(type), quoteIdentifier(fromLabel), quoteIdentifier(toLabel)];
      for (const batch of chunk(group, BATCH)) {
        await withSession(local, async (s) => {
          await s.run(
            // MERGE on the bare pattern collapses parallel same-type rels
            // between one node pair. The UI model has none (COMPOSES order
            // lives on distinct child nodes), and --refresh wipes first, so
            // duplicates cannot accumulate either way.
            `UNWIND $rows AS row
             MATCH (a:${la} {id: row.fromId})
             MATCH (b:${lb} {id: row.toId})
             MERGE (a)-[r:${t}]->(b)
             SET r += row.props`,
            { rows: batch },
          );
        });
      }
      relCounts.set(type, (relCounts.get(type) ?? 0) + group.length);
    }

    // 6. Verify: per-label/per-type local counts must match what we read.
    let mismatch = false;
    console.error("\n[clone] node counts (source -> local):");
    for (const [label, { source: src }] of nodeCounts) {
      const localCount = await countNodes(local, label);
      const flag = localCount >= src ? "ok" : "MISMATCH";
      if (localCount < src) mismatch = true;
      console.error(`  ${label}: ${src} -> ${localCount} ${flag}`);
    }
    console.error("[clone] relationship counts (source -> local):");
    for (const [type, src] of relCounts) {
      const localCount = await countRels(local, type);
      const flag = localCount >= src ? "ok" : "MISMATCH";
      if (localCount < src) mismatch = true;
      console.error(`  ${type}: ${src} -> ${localCount} ${flag}`);
    }
    if (mismatch) throw new Error("clone verification failed — local counts below source");
    console.error(`\n[clone] done (${relRows.length} relationships, source ${sourceUri})`);
  } finally {
    await source.close();
    await local.close();
  }
}

async function countNodes(driver: Driver, label: string): Promise<number> {
  return withSession(driver, async (s) => {
    const res = await s.run(`MATCH (n:${quoteIdentifier(label)}) RETURN count(n) AS c`);
    return Number(res.records[0]?.get("c") ?? 0);
  });
}

async function countRels(driver: Driver, type: string): Promise<number> {
  return withSession(driver, async (s) => {
    const res = await s.run(
      `MATCH (a)-[r:${quoteIdentifier(type)}]->(b)
       WHERE any(l IN labels(a) WHERE l STARTS WITH 'UI_')
         AND any(l IN labels(b) WHERE l STARTS WITH 'UI_')
       RETURN count(r) AS c`,
    );
    return Number(res.records[0]?.get("c") ?? 0);
  });
}
