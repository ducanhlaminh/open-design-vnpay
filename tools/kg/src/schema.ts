import type { Driver } from "neo4j-driver";
import { quoteIdentifier, withSession } from "./neo4j.js";

/** Core labels that always get a unique-id constraint, even on an empty
 * database (before any clone has run). Clone extends this with every UI_*
 * label it discovers on the source. */
export const CORE_LABELS = [
  "UI_WORKSPACE",
  "UI_PROJECT_SCREEN",
  "UI_SCREEN_INSTANCE",
  "UI_COMPONENT",
  "UI_THEME",
  "UI_THEME_COMPOSITION",
  "UI_TOKEN_VALUE",
  "UI_MODE",
];

/**
 * Idempotent: unique constraint on id per UI_* label (backs the MERGE-by-id
 * clone and all tool upserts), plus slug lookup indexes for the two labels
 * the export/lint/grounding paths query by slug.
 */
export async function ensureSchema(driver: Driver, labels: string[] = []): Promise<void> {
  const all = [...new Set([...CORE_LABELS, ...labels])];
  await withSession(driver, async (session) => {
    for (const label of all) {
      const l = quoteIdentifier(label);
      const constraintName = `kg_${label.toLowerCase()}_id`;
      await session.run(
        `CREATE CONSTRAINT ${constraintName} IF NOT EXISTS FOR (n:${l}) REQUIRE n.id IS UNIQUE`,
      );
    }
    await session.run(
      "CREATE INDEX kg_ui_project_screen_slug IF NOT EXISTS FOR (n:UI_PROJECT_SCREEN) ON (n.slug)",
    );
    await session.run(
      "CREATE INDEX kg_ui_component_slug IF NOT EXISTS FOR (n:UI_COMPONENT) ON (n.slug)",
    );
  });
}
