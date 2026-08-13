import { cac } from "cac";
import type { CAC } from "cac";

import { resolveToolPackConfig, type ToolPackCliOptions, type ToolPackPlatform } from "./config.js";
import {
  cleanupPackedLinuxNamespace,
  installPackedLinuxApp,
  installPackedLinuxHeadless,
  inspectPackedLinuxApp,
  packLinux,
  readPackedLinuxLogs,
  resolveLinuxLifecycleMode,
  startPackedLinuxApp,
  startPackedLinuxHeadless,
  stopPackedLinuxApp,
  stopPackedLinuxHeadless,
  uninstallPackedLinuxApp,
  uninstallPackedLinuxHeadless,
} from "./linux.js";

type CliOptions = ToolPackCliOptions;

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printLogs(result: { logs: Record<string, { lines: string[]; logPath: string }>; namespace: string }, options: CliOptions): void {
  if (options.json === true) {
    printJson(result);
    return;
  }

  for (const [app, entry] of Object.entries(result.logs)) {
    process.stdout.write(`[${app}] ${entry.logPath}\n`);
    process.stdout.write(entry.lines.length > 0 ? `${entry.lines.join("\n")}\n` : "(no log lines)\n");
  }
}

type CacCommand = ReturnType<CAC["command"]>;

function addSharedOptions(command: CacCommand) {
  return command
    .option("--cache-dir <path>", "tools-pack cache directory")
    .option("--dir <path>", "tools-pack root directory")
    .option("--json", "print JSON")
    .option("--namespace <name>", "runtime namespace");
}

// Per-platform `--to` help text mirroring resolveToolPackBuildOutput in
// config.ts. Keep these in sync: the resolver throws on any value not listed
// here for the given platform. Mac and Windows packaging commands were
// removed from this CLI in WP5 (web-first migration; apps/desktop and
// tools/pack/src/{mac,win}/** are gone), but `ToolPackPlatform` and
// `resolveToolPackConfig` still resolve "mac"/"win" configs for direct unit
// tests, so this record stays exhaustive over the type.
const TO_HELP_BY_PLATFORM: Record<ToolPackPlatform, string> = {
  linux: "build target: all|appimage|dir (default: all)",
  mac: "build target: all|app|dmg|zip (default: all)",
  win: "build target: all|dir|nsis|zip (default: nsis). `zip` produces a portable zip from the unpacked build; `all` produces dir+nsis+zip.",
};

function addBuildOptions(command: CacCommand, platform: ToolPackPlatform) {
  return command
    .option("--app-version <version>", "override packaged app version for release artifacts")
    .option("--portable", "do not bake local tools-pack runtime roots into the packaged config")
    .option("--to <target>", TO_HELP_BY_PLATFORM[platform]);
}

const cli = cac("tools-pack");

addBuildOptions(addSharedOptions(cli.command("linux <action>", "Linux packaging commands: build|install|start|stop|logs|uninstall|cleanup|inspect")), "linux")
  .option("--containerized", "build inside electronuserland/builder Docker for wider glibc compatibility")
  .option("--headless", "install/start/stop/uninstall/cleanup the headless entry; inspect returns status only")
  .action(async (action: string, options: CliOptions) => {
    const config = resolveToolPackConfig("linux", options);
    switch (action) {
      case "build":
        printJson(await packLinux(config));
        return;
      case "install": {
        const mode = resolveLinuxLifecycleMode(options, "install");
        printJson(await (mode === "headless" ? installPackedLinuxHeadless(config) : installPackedLinuxApp(config)));
        return;
      }
      case "start": {
        const mode = resolveLinuxLifecycleMode(options, "start");
        printJson(await (mode === "headless" ? startPackedLinuxHeadless(config) : startPackedLinuxApp(config)));
        return;
      }
      case "stop": {
        const mode = resolveLinuxLifecycleMode(options, "stop");
        printJson(await (mode === "headless" ? stopPackedLinuxHeadless(config) : stopPackedLinuxApp(config)));
        return;
      }
      case "logs":
        printLogs(await readPackedLinuxLogs(config), options);
        return;
      case "inspect":
        printJson(await inspectPackedLinuxApp(config));
        return;
      case "uninstall": {
        const mode = resolveLinuxLifecycleMode(options, "uninstall");
        printJson(await (mode === "headless" ? uninstallPackedLinuxHeadless(config) : uninstallPackedLinuxApp(config)));
        return;
      }
      case "cleanup":
        printJson(await cleanupPackedLinuxNamespace(config, options));
        return;
      default:
        throw new Error(`unsupported linux action: ${action}`);
    }
  });

cli.help();
cli.parse();
