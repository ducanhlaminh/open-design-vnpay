import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ToolPackConfig } from "../config.js";
import { readRuntimeAppVersion } from "../versions.js";
import { pathExists } from "./fs.js";
import type { WinBuiltAppManifest, WinPaths } from "./types.js";

export async function readPackagedVersion(config: ToolPackConfig): Promise<string> {
  return readRuntimeAppVersion(config);
}

type PackagedConfigEntrypoints = {
  daemonCliEntryRelative?: string;
  daemonSidecarEntryRelative?: string;
  webSidecarEntryRelative?: string;
};

// Exported so the electron-builder cache key can hash the FULL baked config:
// a build with different baked values (KGS/auth/sandbox env) must be a cache
// MISS — reusing a cached win-unpacked silently ships the old config.
export function createPackagedConfig(
  config: ToolPackConfig,
  packagedVersion: string,
  entrypoints: PackagedConfigEntrypoints = {},
): Record<string, unknown> {
  return {
    appVersion: packagedVersion,
    ...entrypoints,
    namespace: config.namespace,
    ...(config.telemetryRelayUrl == null ? {} : { telemetryRelayUrl: config.telemetryRelayUrl }),
    ...(config.posthogKey == null ? {} : { posthogKey: config.posthogKey }),
    ...(config.posthogHost == null ? {} : { posthogHost: config.posthogHost }),
    ...(config.kgsUrl == null ? {} : { kgsUrl: config.kgsUrl }),
    ...(config.kgsAppId == null ? {} : { kgsAppId: config.kgsAppId }),
    ...(config.kgsTenant == null ? {} : { kgsTenant: config.kgsTenant }),
    ...(config.kgsApiKey == null ? {} : { kgsApiKey: config.kgsApiKey }),
    ...(config.mediaUrl == null ? {} : { mediaUrl: config.mediaUrl }),
    ...(config.mediaAppId == null ? {} : { mediaAppId: config.mediaAppId }),
    ...(config.mediaUserId == null ? {} : { mediaUserId: config.mediaUserId }),
    ...(config.mediaUserRole == null ? {} : { mediaUserRole: config.mediaUserRole }),
    ...(config.atlassianJiraToken == null ? {} : { atlassianJiraToken: config.atlassianJiraToken }),
    ...(config.atlassianConfluenceToken == null ? {} : { atlassianConfluenceToken: config.atlassianConfluenceToken }),
    // Google SSO (opt-in via SESSION_SECRET) — mirror the mac writer; omitting
    // these shipped Windows builds with login silently OFF.
    ...(config.authSessionSecret == null ? {} : { authSessionSecret: config.authSessionSecret }),
    ...(config.googleClientId == null ? {} : { googleClientId: config.googleClientId }),
    ...(config.googleClientSecret == null ? {} : { googleClientSecret: config.googleClientSecret }),
    ...(config.identityUrl == null ? {} : { identityUrl: config.identityUrl }),
    ...(config.identityServiceToken == null ? {} : { identityServiceToken: config.identityServiceToken }),
    ...(config.authDomainLock == null ? {} : { authDomainLock: config.authDomainLock }),
    ...(config.sandboxDefault == null ? {} : { sandboxDefault: config.sandboxDefault }),
    ...(config.sandboxSkills == null ? {} : { sandboxSkills: config.sandboxSkills }),
    ...(config.sandboxClaudeAuthSeedB64 == null ? {} : { sandboxClaudeAuthSeedB64: config.sandboxClaudeAuthSeedB64 }),
    ...(config.sandboxCodexAuthSeedB64 == null ? {} : { sandboxCodexAuthSeedB64: config.sandboxCodexAuthSeedB64 }),
    ...(config.updateChannel == null ? {} : { updateChannel: config.updateChannel }),
    webOutputMode: config.webOutputMode,
    // Never bake namespaceBaseRoot: baking the BUILD machine's absolute path
    // pointed cross-built Windows installs at the builder's filesystem (same
    // failure the mac writer already fixed). Omitted → apps/packaged falls
    // back to `<userData>/namespaces` (%APPDATA%\Open Design\namespaces),
    // correct on every machine.
  };
}

export async function writePackagedConfigFile(
  filePath: string,
  config: ToolPackConfig,
  packagedVersion: string,
  entrypoints: PackagedConfigEntrypoints = {},
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
      `${JSON.stringify(createPackagedConfig(config, packagedVersion, entrypoints), null, 2)}\n`,
    "utf8",
  );
}

export async function writePackagedConfig(
  config: ToolPackConfig,
  paths: WinPaths,
  packagedVersion: string,
  entrypoints: PackagedConfigEntrypoints = {},
): Promise<void> {
  await writePackagedConfigFile(paths.packagedConfigPath, config, packagedVersion, entrypoints);
}

export async function writeBuiltAppManifest(
  paths: WinPaths,
  manifest: Omit<WinBuiltAppManifest, "version">,
): Promise<void> {
  await mkdir(dirname(paths.builtManifestPath), { recursive: true });
  await writeFile(paths.builtManifestPath, `${JSON.stringify({ version: 1, ...manifest }, null, 2)}\n`, "utf8");
}

export async function readBuiltAppManifest(
  paths: WinPaths,
  options: { requireExecutable?: boolean } = {},
): Promise<WinBuiltAppManifest | null> {
  try {
    const manifest = JSON.parse(await readFile(paths.builtManifestPath, "utf8")) as WinBuiltAppManifest;
    if (manifest.version !== 1) return null;
    if (options.requireExecutable === true && !(await pathExists(manifest.executablePath))) return null;
    return manifest;
  } catch {
    return null;
  }
}
