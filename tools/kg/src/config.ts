import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from this module until pnpm-workspace.yaml is found. Works from both
 * src/ (tsx dev) and dist/ (bundled) because both live under tools/kg/.
 */
export function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("tools-kg: cannot locate repo root (pnpm-workspace.yaml not found upwards)");
}

export interface KgConfig {
  repoRoot: string;
  /** Local project-owned Neo4j (Docker). */
  boltUri: string;
  httpPort: number;
  user: string;
  password: string;
  /** Workspace agent-authored prototypes live in; never touched by clone --refresh. */
  prototypeWorkspaceId: string;
  /** Upstream design KG to clone FROM (read-only). */
  sourceBoltUri: string;
  sourceUser: string;
  sourcePassword: string;
  /** Reserved for bind-mount setups; the default compose file uses named
   * docker volumes instead (macOS blocks mounts under ~/Downloads). */
  dataDir: string;
  /** Where ui_screen_export / tools-kg export write screen.json. */
  exportDir: string;
}

export function loadConfig(): KgConfig {
  const repoRoot = findRepoRoot();
  const env = process.env;
  return {
    repoRoot,
    boltUri: env.OD_KG_BOLT_URI ?? "bolt://localhost:27787",
    // 27787/27475 deliberately clear of the upstream design KG container
    // (demo-neo4j binds 27687 bolt + 27474 http on the same machine).
    httpPort: Number(env.OD_KG_HTTP_PORT ?? 27475),
    user: env.OD_KG_USER ?? "neo4j",
    password: env.OD_KG_PASSWORD ?? "od_local_password",
    prototypeWorkspaceId: env.OD_KG_WORKSPACE ?? "ws-od-prototypes",
    sourceBoltUri: env.OD_KG_SOURCE_BOLT_URI ?? "bolt://localhost:27687",
    sourceUser: env.OD_KG_SOURCE_USER ?? "neo4j",
    sourcePassword: env.OD_KG_SOURCE_PASSWORD ?? "demo_password",
    dataDir: env.OD_KG_DATA_DIR ?? resolve(repoRoot, ".od/neo4j"),
    exportDir: env.OD_KG_EXPORT_DIR ?? resolve(repoRoot, ".od/kg-exports"),
  };
}
