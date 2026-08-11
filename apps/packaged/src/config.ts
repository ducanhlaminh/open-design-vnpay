import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { SIDECAR_DEFAULTS, normalizeNamespace } from "@open-design/sidecar-proto";

// `electron` is loaded lazily so this module can also be imported from the
// headless entry, which runs in a plain Node process without the electron
// dependency on disk. Top-level `import { app } from "electron"` would crash
// headless at module-load with ERR_MODULE_NOT_FOUND.
async function loadElectronApp() {
  const electron = await import("electron");
  return electron.app;
}

export const PACKAGED_CONFIG_PATH_ENV = "OD_PACKAGED_CONFIG_PATH";
export const PACKAGED_NAMESPACE_ENV = "OD_PACKAGED_NAMESPACE";
export const PACKAGED_WEB_OUTPUT_MODE_OVERRIDE_ENV = "OD_PACKAGED_ALLOW_WEB_OUTPUT_MODE_OVERRIDE";
export const PACKAGED_WEB_STANDALONE_ROOT_ENV = "OD_WEB_STANDALONE_ROOT";
export const PACKAGED_WEB_OUTPUT_MODE_ENV = "OD_WEB_OUTPUT_MODE";

export type PackagedWebOutputMode = "server" | "standalone";

export type RawPackagedConfig = {
  appVersion?: string;
  daemonCliEntryRelative?: string;
  daemonSidecarEntryRelative?: string;
  namespace?: string;
  namespaceBaseRoot?: string;
  nodeCommandRelative?: string;
  resourceRoot?: string;
  // Baked by tools/pack from OPEN_DESIGN_TELEMETRY_RELAY_URL and forwarded to
  // the daemon at runtime; Langfuse credentials never ship in packaged config.
  telemetryRelayUrl?: string;
  // PostHog product-analytics ingest key, baked by tools/pack from
  // process.env.POSTHOG_KEY at packaging time. Forwarded to the daemon
  // sidecar's spawn env as POSTHOG_KEY. `phc_` keys are public ingest
  // tokens (write-only event capture); embedding them in the bundle is
  // the PostHog-recommended pattern. The integration short-circuits when
  // either this is absent or the user has declined Privacy → metrics.
  posthogKey?: string;
  posthogHost?: string;
  // KGS connection baked by tools/pack from process.env.KGS_* at packaging time.
  // Forwarded to the daemon sidecar's spawn env as KGS_URL/KGS_APP_ID/
  // KGS_TENANT/KGS_API_KEY so a shipped app reaches the central KGS without a
  // repo-root .env.local. kgsApiKey is embedded in the bundle — ship a scoped key.
  kgsUrl?: string;
  kgsAppId?: string;
  kgsTenant?: string;
  kgsApiKey?: string;
  // media-service (file artifact store) connection, baked by tools/pack from
  // process.env.MEDIA_* at packaging time. Forwarded to the daemon sidecar's
  // spawn env as MEDIA_URL/MEDIA_APP_ID/MEDIA_USER_ID/MEDIA_USER_ROLE so a
  // shipped app reaches the media-service (graph→KGS, files→media). Omitted when
  // unset; the daemon then uses its defaults (MEDIA_URL=localhost:8083, etc.).
  mediaUrl?: string;
  mediaAppId?: string;
  mediaUserId?: string;
  mediaUserRole?: string;
  // Atlassian (Jira + Confluence) personal tokens baked by tools/pack from
  // process.env.OD_ATLASSIAN_*_TOKEN. Forwarded to the daemon spawn env as
  // OD_ATLASSIAN_JIRA_TOKEN / OD_ATLASSIAN_CONFLUENCE_TOKEN so it seeds the
  // mcp-atlassian server on a fresh install. Embedded in the bundle.
  atlassianJiraToken?: string;
  atlassianConfluenceToken?: string;
  // Agent-in-sandbox defaults baked by tools/pack (OD_SANDBOX_DEFAULT /
  // OD_SANDBOX_SKILLS at packaging time); forwarded to the daemon spawn env.
  // Apply only while the user has no persisted sandbox prefs.
  sandboxDefault?: string;
  sandboxSkills?: string;
  // OAuth session seed for the isolated Docker CLI volume. Extractable from
  // an internal installer; intentionally never surfaced to the renderer.
  sandboxClaudeAuthSeedB64?: string;
  sandboxCodexAuthSeedB64?: string;
  // Release channel ("stable"/"beta"/"nightly"/"preview") baked by tools/pack
  // from --namespace/--app-version at packaging time. Forwarded into
  // OD_UPDATE_CHANNEL before the desktop main entry starts so the updater
  // (apps/desktop/src/main/updater.ts) knows its channel directly instead of
  // re-deriving it from its own version string.
  updateChannel?: string;
  // Google SSO + preview-identity auth baked by tools/pack (SESSION_SECRET/
  // GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/IDENTITY_URL/
  // OD_AUTH_DOMAIN_LOCK).
  // Forwarded to the daemon spawn env so the packaged app runs with Google
  // login + membership-scoped pull. Secrets embedded in the bundle — nội bộ,
  // rotate được.
  authSessionSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  identityUrl?: string;
  authDomainLock?: string;
  webSidecarEntryRelative?: string;
  webStandaloneRoot?: string;
  webOutputMode?: string;
};

export type PackagedConfig = {
  appVersion: string | null;
  daemonCliEntry: string | null;
  daemonSidecarEntry: string | null;
  namespace: string;
  namespaceBaseRoot: string;
  nodeCommand: string | null;
  resourceRoot: string;
  telemetryRelayUrl: string | null;
  posthogKey: string | null;
  posthogHost: string | null;
  kgsUrl: string | null;
  kgsAppId: string | null;
  kgsTenant: string | null;
  kgsApiKey: string | null;
  mediaUrl: string | null;
  mediaAppId: string | null;
  mediaUserId: string | null;
  mediaUserRole: string | null;
  atlassianJiraToken: string | null;
  atlassianConfluenceToken: string | null;
  sandboxDefault: string | null;
  sandboxSkills: string | null;
  sandboxClaudeAuthSeedB64: string | null;
  sandboxCodexAuthSeedB64: string | null;
  updateChannel: string | null;
  authSessionSecret: string | null;
  googleClientId: string | null;
  googleClientSecret: string | null;
  identityUrl: string | null;
  authDomainLock: string | null;
  webSidecarEntry: string | null;
  webStandaloneRoot: string | null;
  webOutputMode: PackagedWebOutputMode;
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath: string): Promise<RawPackagedConfig | null> {
  if (!(await pathExists(filePath))) return null;
  return JSON.parse(await readFile(filePath, "utf8")) as RawPackagedConfig;
}

function resolveDefaultConfigPath(): string {
  return join(process.resourcesPath, "open-design-config.json");
}

async function readRawPackagedConfig(): Promise<RawPackagedConfig> {
  const explicit = process.env[PACKAGED_CONFIG_PATH_ENV];
  if (explicit != null && explicit.length > 0) {
    const config = await readJsonIfExists(resolve(explicit));
    if (config == null) throw new Error(`packaged config not found at ${explicit}`);
    return config;
  }

  const electronApp = await loadElectronApp();
  return (
    (await readJsonIfExists(resolveDefaultConfigPath())) ??
    (await readJsonIfExists(join(electronApp.getAppPath(), "open-design-config.json"))) ??
    {}
  );
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  return value == null || value.length === 0 ? undefined : resolve(value);
}

// Config DTOs use null for optional scalar values consumed by runtime options;
// optional paths use undefined so callers can distinguish "no path" from a resolved path string.
function cleanOptionalString(value: string | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function resolvePackagedWebOutputMode(value: string | undefined): PackagedWebOutputMode {
  if (value == null || value.length === 0) return "server";
  if (value === "server" || value === "standalone") return value;
  throw new Error(`unsupported packaged web output mode: ${value}`);
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function resolvePackagedWebStandaloneRoot(
  webOutputMode: PackagedWebOutputMode,
  value: string | undefined,
): string | null {
  const configured = resolveOptionalPath(value);
  if (configured != null) return configured;
  if (webOutputMode !== "standalone") return null;
  return join(process.resourcesPath, "open-design-web-standalone");
}

async function resolvePackagedRelativeEntry(value: string | undefined): Promise<string | null> {
  const cleaned = cleanOptionalString(value);
  if (cleaned == null) return null;
  const entry = join(process.resourcesPath, cleaned);
  if (!(await pathExists(entry))) {
    throw new Error(`configured packaged entry not found at ${entry}`);
  }
  return entry;
}

export async function readPackagedConfig(): Promise<PackagedConfig> {
  const raw = await readRawPackagedConfig();
  const namespace = normalizeNamespace(
    process.env[PACKAGED_NAMESPACE_ENV] ?? raw.namespace ?? SIDECAR_DEFAULTS.namespace,
  );
  const electronApp = await loadElectronApp();
  const namespaceBaseRoot =
    resolveOptionalPath(raw.namespaceBaseRoot) ?? join(electronApp.getPath("userData"), "namespaces");
  const resourceRoot = resolveOptionalPath(raw.resourceRoot) ?? join(process.resourcesPath, "open-design");
  const relativeNodeCommand =
    raw.nodeCommandRelative == null || raw.nodeCommandRelative.length === 0
      ? join("open-design", "bin", "node")
      : raw.nodeCommandRelative;
  const nodeCommandCandidate = join(process.resourcesPath, relativeNodeCommand);
  const nodeCommand = (await pathExists(nodeCommandCandidate)) ? nodeCommandCandidate : null;
  const allowWebOutputModeOverride = isTruthyEnv(process.env[PACKAGED_WEB_OUTPUT_MODE_OVERRIDE_ENV]);
  const webOutputMode = resolvePackagedWebOutputMode(
    allowWebOutputModeOverride
      ? process.env[PACKAGED_WEB_OUTPUT_MODE_ENV] ?? raw.webOutputMode
      : raw.webOutputMode,
  );
  const webStandaloneRoot = resolvePackagedWebStandaloneRoot(
    webOutputMode,
    allowWebOutputModeOverride
      ? process.env[PACKAGED_WEB_STANDALONE_ROOT_ENV] ?? raw.webStandaloneRoot
      : raw.webStandaloneRoot,
  );
  const daemonCliEntry = await resolvePackagedRelativeEntry(raw.daemonCliEntryRelative);
  const daemonSidecarEntry = await resolvePackagedRelativeEntry(raw.daemonSidecarEntryRelative);
  const webSidecarEntry = await resolvePackagedRelativeEntry(raw.webSidecarEntryRelative);

  return {
    appVersion: cleanOptionalString(raw.appVersion),
    daemonCliEntry,
    daemonSidecarEntry,
    namespace,
    namespaceBaseRoot,
    nodeCommand,
    resourceRoot,
    telemetryRelayUrl: cleanOptionalString(raw.telemetryRelayUrl),
    posthogKey: cleanOptionalString(raw.posthogKey),
    posthogHost: cleanOptionalString(raw.posthogHost),
    kgsUrl: cleanOptionalString(raw.kgsUrl),
    kgsAppId: cleanOptionalString(raw.kgsAppId),
    kgsTenant: cleanOptionalString(raw.kgsTenant),
    kgsApiKey: cleanOptionalString(raw.kgsApiKey),
    mediaUrl: cleanOptionalString(raw.mediaUrl),
    mediaAppId: cleanOptionalString(raw.mediaAppId),
    mediaUserId: cleanOptionalString(raw.mediaUserId),
    mediaUserRole: cleanOptionalString(raw.mediaUserRole),
    atlassianJiraToken: cleanOptionalString(raw.atlassianJiraToken),
    atlassianConfluenceToken: cleanOptionalString(raw.atlassianConfluenceToken),
    sandboxDefault: cleanOptionalString(raw.sandboxDefault),
    sandboxSkills: cleanOptionalString(raw.sandboxSkills),
    sandboxClaudeAuthSeedB64: cleanOptionalString(raw.sandboxClaudeAuthSeedB64),
    sandboxCodexAuthSeedB64: cleanOptionalString(raw.sandboxCodexAuthSeedB64),
    updateChannel: cleanOptionalString(raw.updateChannel),
    authSessionSecret: cleanOptionalString(raw.authSessionSecret),
    googleClientId: cleanOptionalString(raw.googleClientId),
    googleClientSecret: cleanOptionalString(raw.googleClientSecret),
    identityUrl: cleanOptionalString(raw.identityUrl),
    authDomainLock: cleanOptionalString(raw.authDomainLock),
    webSidecarEntry,
    webStandaloneRoot,
    webOutputMode,
  };
}
