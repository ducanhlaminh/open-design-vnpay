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
  /** Skill ids gated into the sandbox (default ['*'] — every run). */
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

/**
 * Turn a Claude account email into a label satisfying SANDBOX_ACCOUNT_LABEL_RE,
 * so a login can be saved without asking the user to invent a name.
 *
 * The label becomes a FILENAME that the daemon interpolates into a shell
 * command, so this must never widen what the regex allows: everything outside
 * `[A-Za-z0-9_-]` collapses to `-`, and the caller still validates the result.
 * Returns null when nothing usable survives (e.g. an all-symbol local part) —
 * callers then fall back to asking the user.
 */
export function sandboxAccountLabelFromEmail(email: string): string | null {
  const localPart = String(email || '').split('@')[0] ?? '';
  const slug = localPart
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 40);
  // The regex additionally demands an alphanumeric FIRST character.
  const label = slug.replace(/^[^A-Za-z0-9]+/, '');
  return label && SANDBOX_ACCOUNT_LABEL_RE.test(label) ? label : null;
}

/** Who a saved login belongs to, read from the volume's `.claude.json`. */
export interface SandboxAccountIdentity {
  /** Stable per-account id — the dedup key, since tokens change every login. */
  accountUuid: string;
  emailAddress: string;
  /** e.g. "claude_max" — shown next to the account so plans are tellable apart. */
  organizationType?: string | null;
}

export interface SandboxAccount {
  /** Label, e.g. "Personal" / "Work"; auto-derived from the email when saved
   *  automatically on login. */
  label: string;
  /** True when this account's saved credentials match the active ones. */
  active: boolean;
  /** Identity recorded when the account was saved; absent for accounts saved
   *  before auto-save existed (label-only). */
  identity?: SandboxAccountIdentity | null;
  /** True when this entry was added automatically on login detection. */
  auto?: boolean;
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

// ── Embedded (no-terminal) Claude login ─────────────────────────────────────
// The daemon drives `claude /login` inside the sandbox container through a
// faked TTY: it auto-answers the onboarding prompts, extracts the OAuth URL,
// opens it in the HOST browser, and the web UI collects the pasted code —
// no terminal window involved. One session at a time.

export type SandboxEmbeddedLoginPhase =
  | 'idle' // no session running
  | 'starting' // container spawning / walking the TUI prompts
  | 'awaiting-code' // OAuth URL extracted (browser opened) — waiting for the pasted code
  | 'verifying' // code submitted — waiting for credentials to land in the volume
  | 'done' // credentials present; container cleaned up
  | 'error';

export interface SandboxEmbeddedLoginStatus {
  phase: SandboxEmbeddedLoginPhase;
  /** OAuth URL once extracted (also auto-opened in the host browser). */
  url: string | null;
  /** Human error (also set alongside awaiting-code on a rejected code retry). */
  error: string | null;
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
