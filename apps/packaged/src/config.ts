// PR WP5 (web-first migration): this module used to also read a baked
// `open-design-config.json` from disk for the packaged Electron entry
// (`apps/packaged/src/index.ts`, removed). The Electron entry and its
// `electron`-app-path fallback are gone, so only the plain env-var
// resolution that `apps/packaged/src/headless.ts` already builds its own
// config from (see `resolveHeadlessConfig` there) remains relevant here.
// This file now only carries the shared `PackagedConfig` shape and the
// namespace env constant headless.ts reads.
export const PACKAGED_NAMESPACE_ENV = "OD_PACKAGED_NAMESPACE";

export type PackagedWebOutputMode = "server" | "standalone";

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
