import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_DEFAULTS,
} from "@open-design/sidecar-proto";
import { resolveNamespace } from "@open-design/sidecar";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const WORKSPACE_ROOT = resolve(__dirname, "../../..");

export type ToolPackPlatform = "mac" | "win" | "linux";
export type ToolPackBuildOutput = "all" | "app" | "appimage" | "dir" | "dmg" | "nsis" | "zip";
export type ToolPackMacCompression = "store" | "normal" | "maximum";
export type ToolPackWebOutputMode = "server" | "standalone";
type ToolPackPrereleaseChannel = "beta" | "nightly" | "preview";

export type ToolPackCliOptions = {
  appVersion?: string;
  cacheDir?: string;
  containerized?: boolean;
  dir?: string;
  expr?: string;
  headless?: boolean;
  json?: boolean;
  macCompression?: string;
  namespace?: string;
  path?: string;
  portable?: boolean;
  removeData?: boolean;
  removeLogs?: boolean;
  removeProductUserData?: boolean;
  removeSidecars?: boolean;
  signed?: boolean;
  silent?: boolean;
  to?: string;
  updateAction?: string;
};

export type ToolPackRoots = {
  output: {
    appBuilderRoot: string;
    namespaceRoot: string;
    platformRoot: string;
    root: string;
  };
  runtime: {
    namespaceBaseRoot: string;
    namespaceRoot: string;
  };
  cacheRoot: string;
  toolPackRoot: string;
};

export type ToolPackConfig = {
  appVersion?: string;
  containerized: boolean;
  electronBuilderCliPath: string;
  electronDistPath: string;
  electronVersion: string;
  macCompression: ToolPackMacCompression;
  namespace: string;
  platform: ToolPackPlatform;
  portable: boolean;
  removeData: boolean;
  removeLogs: boolean;
  removeProductUserData: boolean;
  removeSidecars: boolean;
  roots: ToolPackRoots;
  silent: boolean;
  signed: boolean;
  telemetryRelayUrl?: string;
  /**
   * PostHog product-analytics ingest key, sourced from process.env.POSTHOG_KEY
   * at packaging time. Baked into open-design-config.json so the packaged
   * daemon can read it as POSTHOG_KEY env at launch — only official Open
   * Design builds (CI with the secret set) ship with this; forks compiling
   * locally produce binaries that omit the key and the integration
   * short-circuits cleanly. Apache-2.0 keeps the bundle public, but `phc_`
   * keys are write-only event ingest keys (cannot read your project data),
   * so embedding them in the binary is the PostHog-recommended pattern.
   */
  posthogKey?: string;
  posthogHost?: string;
  /**
   * KGS (Knowledge Graph Store) connection, sourced from process.env at
   * packaging time and baked into open-design-config.json so the packaged
   * daemon can read KGS_URL/KGS_APP_ID/KGS_TENANT/KGS_API_KEY at launch — a
   * shipped app has no repo-root `.env.local` to read. WARNING: kgsApiKey is
   * embedded in the bundle (anyone with the app can extract it); ship a scoped
   * key. All four are omitted when their env var is unset.
   */
  kgsUrl?: string;
  kgsAppId?: string;
  kgsTenant?: string;
  kgsApiKey?: string;
  /**
   * media-service (file artifact store) connection, sourced from process.env at
   * packaging time and baked into open-design-config.json so the packaged daemon
   * can read MEDIA_URL/MEDIA_APP_ID/MEDIA_USER_ID/MEDIA_USER_ROLE at launch (the
   * hybrid counterpart to KGS — graph stays in KGS, files move to media). All
   * four are omitted when their env var is unset; the daemon then falls back to
   * its own defaults (MEDIA_URL=localhost:8083, MEDIA_APP_ID=KGS_APP_ID, …).
   */
  mediaUrl?: string;
  mediaAppId?: string;
  mediaUserId?: string;
  mediaUserRole?: string;
  /**
   * Atlassian (Jira + Confluence Data Center) personal tokens, sourced from
   * process.env.OD_ATLASSIAN_*_TOKEN at packaging time and baked into
   * open-design-config.json so the packaged daemon seeds the `mcp-atlassian`
   * stdio MCP server with working creds. WARNING: embedded in the bundle
   * (extractable) — ship scoped/rotatable tokens. Omitted when unset, in which
   * case the daemon does not seed the Atlassian server.
   */
  atlassianJiraToken?: string;
  atlassianConfluenceToken?: string;
  /**
   * Google SSO + preview-identity auth, sourced from process.env at packaging
   * time and baked into open-design-config.json so the packaged daemon runs
   * with login bật sẵn (SESSION_SECRET/GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/
   * IDENTITY_URL — auth-routes.ts authConfigFromEnv; auth là opt-in theo
   * SESSION_SECRET nên thiếu là bản packaged chạy KHÔNG login và pull-all
   * không lọc membership). WARNING: googleClientSecret + authSessionSecret
   * nằm trong bundle (trích được) — SESSION_SECRET chung nghĩa là ai có nó
   * forge được session cookie; chỉ dùng cho phân phối nội bộ, phải rotate
   * được. authDomainLock = passthrough OD_AUTH_DOMAIN_LOCK (bật khóa domain
   * email cho bản phát hành). Tất cả omit khi env unset.
   */
  authSessionSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  identityUrl?: string;
  authDomainLock?: string;
  /**
   * Personal API key (`phx_...`) used by the @posthog/cli sourcemap helper to
   * upload browser sourcemaps to PostHog after `next build` and before the
   * web bundle is copied into the Electron package. Sourced from
   * `POSTHOG_CLI_API_KEY` (or the legacy `POSTHOG_PERSONAL_API_KEY` alias)
   * in CI; when missing (local packaging by a contributor, fork builds, PRs)
   * the helper still strips the .map files so source never leaks into the
   * shipped installer — it just skips the upload step.
   */
  posthogCliApiKey?: string;
  /**
   * PostHog project ID (e.g. `420348` for the official Open Design project)
   * used by `@posthog/cli sourcemap upload`. Sourced from
   * `POSTHOG_CLI_PROJECT_ID` (or the alias `POSTHOG_PROJECT_ID`) in CI.
   * Required for upload to be attempted; missing → strip-only path.
   */
  posthogCliProjectId?: string;
  /**
   * PostHog **management** host used by `@posthog/cli sourcemap upload`. This
   * is the regional app host (e.g. `https://us.posthog.com`) — distinct from
   * `posthogHost` above, which is the **ingest** host (`us.i.posthog.com`)
   * used by the runtime SDK and accepts `/capture/` traffic only. Sourced
   * from `POSTHOG_CLI_HOST`; when missing, the CLI defaults to the US Cloud
   * app host on its own, which is correct for the official project.
   */
  posthogCliHost?: string;
  to: ToolPackBuildOutput;
  webOutputMode: ToolPackWebOutputMode;
  workspaceRoot: string;
};

function resolveToolPackBuildOutput(platform: ToolPackPlatform, value: string | undefined): ToolPackBuildOutput {
  if (value == null || value.length === 0) return platform === "win" ? "nsis" : "all";
  if (platform === "mac" && (value === "all" || value === "app" || value === "dmg" || value === "zip")) return value;
  if (platform === "win" && (value === "all" || value === "dir" || value === "nsis" || value === "zip")) return value;
  if (platform === "linux" && (value === "all" || value === "appimage" || value === "dir")) return value;
  throw new Error(`unsupported ${platform} --to target: ${value}`);
}

function resolveToolPackMacCompression(value: string | undefined): ToolPackMacCompression {
  if (value == null || value.length === 0) return "normal";
  if (value === "store" || value === "normal" || value === "maximum") return value;
  throw new Error(`unsupported mac --mac-compression value: ${value}`);
}

function resolveToolPackAppVersion(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("--app-version must not be empty");
  if (/\s/.test(normalized)) throw new Error(`--app-version must not contain whitespace: ${value}`);
  return normalized;
}

function channelFromAppVersion(value: string | undefined): ToolPackPrereleaseChannel | null {
  if (value == null || value.length === 0) return null;
  if (/(?:^|[-.])beta(?:[-.]|$)/i.test(value)) return "beta";
  if (/(?:^|[-.])nightly(?:[-.]|$)/i.test(value)) return "nightly";
  if (/(?:^|[-.])preview(?:[-.]|$)/i.test(value)) return "preview";
  return null;
}

function defaultNamespaceForAppVersion(platform: ToolPackPlatform, appVersion: string | undefined): string {
  const channel = channelFromAppVersion(appVersion);
  if (channel == null) return SIDECAR_DEFAULTS.namespace;

  const namespace = `release-${channel}`;
  return platform === "mac" ? namespace : `${namespace}-${platform}`;
}

function resolveToolPackWebOutputMode(platform: ToolPackPlatform, value: string | undefined): ToolPackWebOutputMode {
  // Standalone web output is wired for desktop packaged platforms; Linux stays on
  // the existing server output until its AppImage resource path is optimized.
  if (platform === "linux") return "server";
  if (value == null || value.length === 0) return "standalone";
  if (value === "server" || value === "standalone") return value;
  throw new Error(`unsupported OD_WEB_OUTPUT_MODE value: ${value}`);
}

function resolveToolPackPosthogKey(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  // PostHog public keys start with `phc_`. We don't hard-fail on other
  // shapes — third-party PostHog deployments may use different prefixes —
  // but flag obviously-wrong values (whitespace, control chars) so a
  // misconfigured CI secret doesn't silently bake garbage into the bundle.
  if (/[\s\x00-\x1f]/.test(normalized)) {
    throw new Error(`POSTHOG_KEY contains whitespace or control chars: ${value}`);
  }
  return normalized;
}

function resolveToolPackPosthogHost(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`POSTHOG_HOST must be an absolute URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`POSTHOG_HOST must be http(s): ${value}`);
  }
  return normalized.replace(/\/+$/, "");
}

// Trim + reject control chars (a misconfigured env must not bake garbage into
// the bundle). Empty → undefined so the field is omitted from packaged config.
function resolveToolPackKgsScalar(value: string | undefined, label: string): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (/[\s\x00-\x1f]/.test(normalized)) {
    throw new Error(`${label} contains whitespace or control chars: ${value}`);
  }
  return normalized;
}

function resolveToolPackServiceUrl(value: string | undefined, label: string): string | undefined {
  const normalized = resolveToolPackKgsScalar(value, label);
  if (normalized == null) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} must be an absolute URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must be http(s): ${value}`);
  }
  return normalized.replace(/\/+$/, "");
}

function resolveToolPackPosthogCliApiKey(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  // Personal API keys start with `phx_`. As with POSTHOG_KEY, third-party
  // PostHog deployments may use different prefixes; only flag obviously-wrong
  // values (whitespace, control chars) so a misconfigured CI secret doesn't
  // silently corrupt the upload step.
  if (/[\s\x00-\x1f]/.test(normalized)) {
    throw new Error(`POSTHOG_CLI_API_KEY contains whitespace or control chars`);
  }
  return normalized;
}

function resolveToolPackPosthogCliProjectId(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (!/^[0-9]+$/.test(normalized)) {
    throw new Error(`POSTHOG_CLI_PROJECT_ID must be a numeric project id: ${value}`);
  }
  return normalized;
}

function resolveToolPackPosthogCliHost(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`POSTHOG_CLI_HOST must be an absolute URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`POSTHOG_CLI_HOST must be http(s): ${value}`);
  }
  return normalized.replace(/\/+$/, "");
}

function resolveToolPackTelemetryRelayUrl(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`OPEN_DESIGN_TELEMETRY_RELAY_URL must be an absolute https URL: ${value}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`OPEN_DESIGN_TELEMETRY_RELAY_URL must use https: ${value}`);
  }
  return normalized.replace(/\/+$/, "");
}

function resolveElectronVersion(workspaceRoot: string): string {
  const require = createRequire(join(workspaceRoot, "apps/desktop/package.json"));
  const desktopPackage = require(join(workspaceRoot, "apps/desktop/package.json")) as {
    devDependencies?: Record<string, string>;
  };
  const version = desktopPackage.devDependencies?.electron;
  if (version == null || version.length === 0) {
    throw new Error("apps/desktop/package.json must declare electron");
  }
  return version;
}

function resolveElectronDistPath(workspaceRoot: string): string {
  const require = createRequire(join(workspaceRoot, "apps/desktop/package.json"));
  const electronEntry = require.resolve("electron");
  return join(path.dirname(electronEntry), "dist");
}

function resolveElectronBuilderCliPath(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("electron-builder/out/cli/cli.js");
}

export function resolveToolPackConfig(
  platform: ToolPackPlatform,
  options: ToolPackCliOptions = {},
): ToolPackConfig {
  const appVersion = resolveToolPackAppVersion(options.appVersion);
  const namespace = resolveNamespace({
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    env: process.env,
    namespace: options.namespace ?? defaultNamespaceForAppVersion(platform, appVersion),
  });
  const toolPackRoot = resolve(options.dir ?? join(WORKSPACE_ROOT, ".tmp", "tools-pack"));
  const cacheRoot = resolve(options.cacheDir ?? join(toolPackRoot, "cache"));
  const outputRoot = join(toolPackRoot, "out");
  const outputPlatformRoot = join(outputRoot, platform);
  const outputNamespaceRoot = join(outputPlatformRoot, "namespaces", namespace);
  const runtimeNamespaceBaseRoot = join(toolPackRoot, "runtime", platform, "namespaces");

  return {
    appVersion,
    containerized: options.containerized === true,
    electronBuilderCliPath: resolveElectronBuilderCliPath(),
    electronDistPath: resolveElectronDistPath(WORKSPACE_ROOT),
    electronVersion: resolveElectronVersion(WORKSPACE_ROOT),
    macCompression: resolveToolPackMacCompression(options.macCompression),
    namespace,
    platform,
    portable: options.portable === true,
    roots: {
      output: {
        appBuilderRoot: join(outputNamespaceRoot, "builder"),
        namespaceRoot: outputNamespaceRoot,
        platformRoot: outputPlatformRoot,
        root: outputRoot,
      },
      runtime: {
        namespaceBaseRoot: runtimeNamespaceBaseRoot,
        namespaceRoot: join(runtimeNamespaceBaseRoot, namespace),
      },
      cacheRoot,
      toolPackRoot,
    },
    removeData: options.removeData === true,
    removeLogs: options.removeLogs === true,
    removeProductUserData: options.removeProductUserData === true,
    removeSidecars: options.removeSidecars === true,
    silent: options.silent !== false,
    signed: options.signed === true,
    telemetryRelayUrl: resolveToolPackTelemetryRelayUrl(process.env.OPEN_DESIGN_TELEMETRY_RELAY_URL),
    posthogKey: resolveToolPackPosthogKey(process.env.POSTHOG_KEY),
    posthogHost: resolveToolPackPosthogHost(process.env.POSTHOG_HOST),
    kgsUrl: resolveToolPackServiceUrl(process.env.KGS_URL, "KGS_URL"),
    kgsAppId: resolveToolPackKgsScalar(process.env.KGS_APP_ID, "KGS_APP_ID"),
    kgsTenant: resolveToolPackKgsScalar(process.env.KGS_TENANT, "KGS_TENANT"),
    kgsApiKey: resolveToolPackKgsScalar(process.env.KGS_API_KEY, "KGS_API_KEY"),
    mediaUrl: resolveToolPackServiceUrl(process.env.MEDIA_URL, "MEDIA_URL"),
    mediaAppId: resolveToolPackKgsScalar(process.env.MEDIA_APP_ID, "MEDIA_APP_ID"),
    mediaUserId: resolveToolPackKgsScalar(process.env.MEDIA_USER_ID, "MEDIA_USER_ID"),
    mediaUserRole: resolveToolPackKgsScalar(process.env.MEDIA_USER_ROLE, "MEDIA_USER_ROLE"),
    atlassianJiraToken: process.env.OD_ATLASSIAN_JIRA_TOKEN?.trim() || undefined,
    atlassianConfluenceToken: process.env.OD_ATLASSIAN_CONFLUENCE_TOKEN?.trim() || undefined,
    authSessionSecret: process.env.SESSION_SECRET?.trim() || undefined,
    googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || undefined,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || undefined,
    identityUrl: process.env.IDENTITY_URL?.trim() || undefined,
    authDomainLock: process.env.OD_AUTH_DOMAIN_LOCK?.trim() || undefined,
    posthogCliApiKey: resolveToolPackPosthogCliApiKey(
      process.env.POSTHOG_CLI_API_KEY ?? process.env.POSTHOG_PERSONAL_API_KEY,
    ),
    posthogCliProjectId: resolveToolPackPosthogCliProjectId(
      process.env.POSTHOG_CLI_PROJECT_ID ?? process.env.POSTHOG_PROJECT_ID,
    ),
    posthogCliHost: resolveToolPackPosthogCliHost(process.env.POSTHOG_CLI_HOST),
    to: resolveToolPackBuildOutput(platform, options.to),
    webOutputMode: resolveToolPackWebOutputMode(platform, process.env.OD_WEB_OUTPUT_MODE),
    workspaceRoot: WORKSPACE_ROOT,
  };
}
