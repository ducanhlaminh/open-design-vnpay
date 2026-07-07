// Agent-in-sandbox status surface (`GET /api/sandbox/status`). The sandbox
// spawns gated agent runs inside a throwaway Docker container; this DTO is the
// shared shape the web Settings card and `od sandbox status` both read.
// Enable/disable persists through the existing app-config surface
// (`PUT /api/app-config` with a `sandbox` section), not a dedicated endpoint.

export interface SandboxStatusResponse {
  /** Effective enabled flag (prefs + OD_SANDBOX env override). */
  enabled: boolean;
  /** Agent runtime ids gated into the sandbox (default ['claude']). */
  runtimes: string[];
  /** Skill ids gated into the sandbox (default ['ui-react']). */
  skills: string[];
  timeoutMinutes: number;
  /** Docker engine reachable. */
  dockerOk: boolean;
  /** Expected image tag (od-agent-sandbox:<sandbox.version>). */
  image: string;
  /** Expected image tag present locally. */
  imageOk: boolean;
  /** Claude CLI version pinned in the image recipe (sandbox/claude.version). */
  claudeVersion: string | null;
  /** Shared auth volume exists. */
  authVolumeOk: boolean;
  /**
   * Auth volume holds Claude credentials. Probed with a short-lived
   * container, so only when docker + image are available; null = not probed.
   */
  authLoggedIn: boolean | null;
  /** Names of live od.sandbox containers (active sandboxed runs). */
  activeContainers: string[];
  /**
   * Absolute path of the ui-react builder dir on the daemon machine — where
   * `od sandbox build` / `od sandbox login` find build-sandbox.sh and the
   * version pins.
   */
  builderDir: string;
}
