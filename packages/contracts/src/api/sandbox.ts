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

// ── Claude account switching (Docker-only sandbox) ──────────────────────────
// The sandbox Claude auth is ONE `.credentials.json` in the `od-claude-auth`
// volume. To hold several Claude accounts, each login is snapshotted to
// `accounts/<label>.json` in the same volume; "switch" copies one back over the
// active `.credentials.json`. Labels are filesystem-safe slugs.

/** A regex the label must satisfy (also enforced server-side). Kept
 *  filesystem-safe (no spaces/slashes) since the label IS the stored filename. */
export const SANDBOX_ACCOUNT_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export interface SandboxAccount {
  /** User-chosen label, e.g. "Personal" / "Work". */
  label: string;
  /** True when this account's saved credentials match the active ones. */
  active: boolean;
}

export interface SandboxAccountsResponse {
  /** The sandbox owns Claude (Docker-only) — the switcher only applies then. */
  supported: boolean;
  /** Claude credentials exist at all (someone has logged in). */
  loggedIn: boolean;
  /** A credentials.json is present but matches no saved account (login not saved). */
  activeUnsaved: boolean;
  accounts: SandboxAccount[];
}

/** Save (snapshot the current login) / switch / remove all return the fresh list. */
export type SandboxAccountsMutationResponse = SandboxAccountsResponse;

/** Live health of one saved account — its OAuth token probed against Claude.
 *  A revoked/expired token (e.g. the password was changed) comes back `ok:false`
 *  with a human `error`; the account is flagged red, NOT deleted. */
export interface SandboxAccountStatus {
  label: string;
  ok: boolean;
  /** Short reason when not ok (e.g. "HTTP 401 — token hết hạn / bị thu hồi"). */
  error?: string;
}

export interface SandboxAccountsCheckResponse {
  statuses: SandboxAccountStatus[];
}

/**
 * Adding an account = a fresh Claude OAuth login, which is an INTERACTIVE
 * terminal flow (`claude /login`), so it can't be embedded in the web UI. The
 * daemon best-effort opens a host terminal running the login command; the UI
 * then tells the user to finish there and Save the result under a label.
 */
export interface SandboxLoginLaunchResponse {
  /** A terminal window was opened running the login command. */
  launched: boolean;
  /** The exact command (shown as a copy-paste fallback when launch failed). */
  command: string;
  /** Human note (why it couldn't launch, or the next step). */
  message?: string;
}

/**
 * Live state of an in-daemon `docker build` of the sandbox image, driven from
 * the Settings "Build image" button (and pollable by the CLI). Builds take
 * minutes, so `POST /api/sandbox/build` starts it and returns immediately; the
 * UI polls `GET /api/sandbox/build` until `building` flips false. Builds the
 * base image first when that's missing too — "build whatever's missing".
 */
export interface SandboxBuildResponse {
  /** A build is currently running. */
  building: boolean;
  /** Result of the LAST finished build: true = image present, false = failed,
   *  null = never run / still building. */
  ok: boolean | null;
  /** Failure reason when the last build failed. */
  error: string | null;
  /** Tail of the docker build output (most-recent lines, capped). */
  log: string[];
}
