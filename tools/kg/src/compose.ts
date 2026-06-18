import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KgConfig } from "./config.js";
import { createDriver, verifyConnectivity, withSession } from "./neo4j.js";
import { ensureSchema } from "./schema.js";

function composeFile(): string {
  // dist/index.mjs and src/compose.ts both sit one level under tools/kg/.
  return resolve(dirname(fileURLToPath(import.meta.url)), "../docker/docker-compose.yml");
}

function boltPort(config: KgConfig): string {
  const m = /:(\d+)$/.exec(config.boltUri);
  return m ? m[1] : "27787";
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"], env });
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });
}

async function runCapture(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise({ code: code ?? 1, out }));
  });
}

async function assertDockerRunning(): Promise<void> {
  const { code } = await runCapture("docker", ["info"], process.env).catch(() => ({ code: 1, out: "" }));
  if (code !== 0) {
    throw new Error("Docker is not running (docker info failed). Start Docker Desktop and retry.");
  }
}

function composeEnv(config: KgConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OD_KG_PASSWORD: config.password,
    OD_KG_BOLT_PORT: boltPort(config),
    OD_KG_HTTP_PORT: String(config.httpPort),
  };
}

const COMPOSE_BASE = ["compose", "-p", "od-kg", "-f"];

export async function neo4jUp(config: KgConfig): Promise<void> {
  await assertDockerRunning();
  const code = await run("docker", [...COMPOSE_BASE, composeFile(), "up", "-d", "--wait"], composeEnv(config));
  if (code !== 0) throw new Error(`docker compose up failed (exit ${code}) — check ports ${boltPort(config)}/${config.httpPort} are free`);
  const driver = createDriver(config.boltUri, config.user, config.password);
  try {
    await verifyConnectivity(driver, `local neo4j at ${config.boltUri}`);
    await ensureSchema(driver);
  } finally {
    await driver.close();
  }
  console.error(`[tools-kg] neo4j up: bolt ${config.boltUri}, browser http://localhost:${config.httpPort}, data in docker volumes od-kg_data/od-kg_logs`);
}

export async function neo4jDown(config: KgConfig): Promise<void> {
  await assertDockerRunning();
  const code = await run("docker", [...COMPOSE_BASE, composeFile(), "down"], composeEnv(config));
  if (code !== 0) throw new Error(`docker compose down failed (exit ${code})`);
  console.error("[tools-kg] neo4j down (data preserved in docker volume od-kg_data)");
}

export async function neo4jStatus(config: KgConfig): Promise<void> {
  await assertDockerRunning();
  const { out } = await runCapture("docker", [...COMPOSE_BASE, composeFile(), "ps"], composeEnv(config));
  console.log(out.trim());
  const driver = createDriver(config.boltUri, config.user, config.password);
  try {
    await verifyConnectivity(driver, `local neo4j at ${config.boltUri}`, 5_000);
    const counts = await withSession(driver, async (session) => {
      const res = await session.run(
        `MATCH (n) WITH [l IN labels(n) WHERE l STARTS WITH 'UI_'][0] AS label
         WHERE label IS NOT NULL
         RETURN label, count(*) AS count ORDER BY label`,
      );
      return res.records.map((r) => `${r.get("label")}: ${r.get("count")}`);
    });
    console.log(counts.length ? counts.join("\n") : "(no UI_* nodes yet — run `tools-kg clone`)");
  } catch {
    console.log("bolt: unreachable");
  } finally {
    await driver.close();
  }
}
