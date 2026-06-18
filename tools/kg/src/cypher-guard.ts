/**
 * Read-only Cypher pre-check for kg_cypher_read. Defense-in-depth only — the
 * real enforcement is that the server runs the query inside
 * session.executeRead(), which the database rejects writes from. This guard
 * exists to fail fast with a friendly message instead of a driver error.
 */

const WRITE_PATTERN =
  /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|FOREACH)\b|\bLOAD\s+CSV\b|\bIN\s+TRANSACTIONS\b|\bapoc\s*\.\s*(create|merge|refactor|periodic|load|trigger)\b|\bdbms\s*\./i;

/** Strips string literals and comments so keywords inside them don't trip the check. */
function stripLiterals(cypher: string): string {
  return cypher
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

export function assertReadOnlyCypher(cypher: string): void {
  const stripped = stripLiterals(cypher);
  const match = WRITE_PATTERN.exec(stripped);
  if (match) {
    throw new Error(
      `kg_cypher_read is read-only — "${match[0]}" is not allowed. Use the typed ui_screen_* tools for writes.`,
    );
  }
}
