import { cac } from "cac";
import { loadConfig } from "./config.js";
import { neo4jDown, neo4jStatus, neo4jUp } from "./compose.js";
import { clone } from "./clone.js";
import { createDriver, verifyConnectivity } from "./neo4j.js";
import { exportScreen, writeScreenDocument } from "./export.js";
import { lintScreen } from "./lint.js";

const cli = cac("tools-kg");

cli
  .command("mcp", "Run the od-kg stdio MCP server (stdout = JSON-RPC only)")
  .action(async () => {
    const { runMcpServer } = await import("./mcp/server.js");
    await runMcpServer(loadConfig());
  });

cli
  .command("neo4j <action>", "Local Neo4j lifecycle: up | down | status (Docker)")
  .action(async (action: string) => {
    const config = loadConfig();
    if (action === "up") await neo4jUp(config);
    else if (action === "down") await neo4jDown(config);
    else if (action === "status") await neo4jStatus(config);
    else throw new Error(`unsupported neo4j action: ${action} (up|down|status)`);
  });

cli
  .command("clone", "Clone the UI_* subgraph from the upstream design KG into the local Neo4j")
  .option("--from <bolt-uri>", "source bolt URI (default OD_KG_SOURCE_BOLT_URI / bolt://localhost:27687)")
  .option("--user <user>", "source user")
  .option("--password <password>", "source password")
  .option("--refresh", "wipe previously cloned reference data first (agent prototypes are never touched)")
  .action(async (options: { from?: string; user?: string; password?: string; refresh?: boolean }) => {
    await clone(loadConfig(), {
      refresh: Boolean(options.refresh),
      from: options.from,
      user: options.user,
      password: options.password,
    });
  });

cli
  .command("export <slug>", "Export a screen's graph tree to a react-shadcn screen.json")
  .option("--workspace <id>", "workspace to search (default prototype workspace; '*' = all)")
  .option("--with-flow", "include flow[] edges (FLOWS_TO)")
  .option("--out <dir>", "output directory (default <repo>/.od/kg-exports/<slug>/)")
  .action(async (slug: string, options: { workspace?: string; withFlow?: boolean; out?: string }) => {
    const config = loadConfig();
    const driver = createDriver(config.boltUri, config.user, config.password);
    try {
      await verifyConnectivity(driver, `local neo4j at ${config.boltUri}`, 10_000);
      const document = await exportScreen(driver, config, slug, {
        workspaceId: options.workspace,
        withFlow: Boolean(options.withFlow),
      });
      const file = writeScreenDocument(config, document, options.out);
      console.log(file);
    } finally {
      await driver.close();
    }
  });

cli
  .command("lint <slug>", "Lint one prototype screen subgraph (whitelist, ordering, cycles, flows)")
  .action(async (slug: string) => {
    const config = loadConfig();
    const driver = createDriver(config.boltUri, config.user, config.password);
    try {
      await verifyConnectivity(driver, `local neo4j at ${config.boltUri}`, 10_000);
      const violations = await lintScreen(driver, config, slug);
      for (const v of violations) {
        console.log(`${v.severity.toUpperCase().padEnd(7)} ${v.rule}${v.nodeId ? ` [${v.nodeId}]` : ""}: ${v.message}`);
      }
      const errors = violations.filter((v) => v.severity === "error").length;
      console.log(errors === 0 ? "LINT: PASS" : `LINT: FAIL (${errors} error${errors > 1 ? "s" : ""})`);
      process.exitCode = errors === 0 ? 0 : 1;
    } finally {
      await driver.close();
    }
  });

cli
  .command("css <composition>", "Export a composition's layer stack to a dual-scheme stylesheet")
  .option("--out <file>", "output path (default <repo>/.od/kg-exports/_css/<name>.css)")
  .option("--vars-only", "emit only the :root/html.dark value blocks (brand.css payload; structural rules live in the shell)")
  .action(async (composition: string, options: { out?: string; varsOnly?: boolean }) => {
    const config = loadConfig();
    const driver = createDriver(config.boltUri, config.user, config.password);
    try {
      await verifyConnectivity(driver, `local neo4j at ${config.boltUri}`, 10_000);
      const { exportCompositionCss } = await import("./export-css.js");
      const result = await exportCompositionCss(driver, config, composition, {
        outFile: options.out,
        varsOnly: Boolean(options.varsOnly),
      });
      for (const w of result.warnings) console.error(`WARN ${w}`);
      console.log(result.file);
    } finally {
      await driver.close();
    }
  });

cli
  .command("tokens <composition>", "Print a composition's resolved token palette (+ vars-only payload path)")
  .action(async (composition: string) => {
    const config = loadConfig();
    const driver = createDriver(config.boltUri, config.user, config.password);
    try {
      await verifyConnectivity(driver, `local neo4j at ${config.boltUri}`, 10_000);
      const { getCompositionTokens } = await import("./tokens.js");
      const result = await getCompositionTokens(driver, config, composition);
      const { cssVars: _cssVars, ...rest } = result;
      console.log(JSON.stringify(rest, null, 2));
    } finally {
      await driver.close();
    }
  });

cli
  .command("style-lint <composition>", "Lint a theme composition (layers, axis coverage, dual-scheme)")
  .action(async (composition: string) => {
    const config = loadConfig();
    const driver = createDriver(config.boltUri, config.user, config.password);
    try {
      await verifyConnectivity(driver, `local neo4j at ${config.boltUri}`, 10_000);
      const { compositionLint } = await import("./styles.js");
      const violations = await compositionLint(driver, config, composition);
      for (const v of violations) {
        console.log(`${v.severity.toUpperCase().padEnd(7)} ${v.rule}${v.nodeId ? ` [${v.nodeId}]` : ""}: ${v.message}`);
      }
      const errors = violations.filter((v) => v.severity === "error").length;
      console.log(errors === 0 ? "LINT: PASS" : `LINT: FAIL (${errors} error${errors > 1 ? "s" : ""})`);
      process.exitCode = errors === 0 ? 0 : 1;
    } finally {
      await driver.close();
    }
  });

cli.help();

async function main(): Promise<void> {
  cli.parse(process.argv, { run: false });
  if (!cli.matchedCommand) {
    cli.outputHelp();
    return;
  }
  await cli.runMatchedCommand();
}

main().catch((error: unknown) => {
  console.error(`[tools-kg] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
