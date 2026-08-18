# Host runtime (one-command install, no Docker)

Runs Open Design directly on macOS, Linux, or Windows as a single Node.js
process (the daemon serves both `/api/*` and the built web UI — no Docker,
no Electron). Windows is a first-class target here, not a reduced one: same
6 steps, same `config.env` shape, same automatic rollback. This is a
different deployment path from [`../README.md`](../README.md) (Docker
self-host): that one stays as-is, this one is for a bare host install
managed by launchd (macOS), a systemd `--user` unit (Linux), or a per-user
launcher registered in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
(Windows).

Structure inspired by kit-gen style installers (folder layout and general
flow, not copied verbatim from any project).

## Install (macOS)

### Recommended: download and double-click

1. Download [`OpenDesign-macOS-Installer.zip`](https://github.com/ducanhlaminh/open-design-vnpay/releases/latest/download/OpenDesign-macOS-Installer.zip)
   and unzip it (Safari does this automatically; in other browsers
   double-click the zip). Inside: `OpenDesign-Install.command` and
   `OpenDesign-Update.command`.
2. **First time only:** macOS Gatekeeper blocks a downloaded `.command`
   ("cannot be opened because it is from an unidentified developer").
   Right-click (or Control-click) `OpenDesign-Install.command` → **Open** →
   **Open** again. After that a plain double-click works. (No `sudo`, no
   admin account — everything installs under `~/.open-design`.)
3. A Terminal window opens and shows the same 6 steps as the terminal
   install; it stays open when it finishes so the result or the actionable
   error remains visible. Press Enter to close it.

Keep the two files. They do different things:

- `OpenDesign-Install.command` = **clean install**. On a machine that already
  has Open Design it first removes the previous installation (stops the
  service, deletes `~/.open-design` and the launchd plist — project data under
  `~/od-data` is kept), then installs the latest release fresh.
- `OpenDesign-Update.command` = **in-place update** (`install.sh --update`,
  keeps `config.env`, rolls back on a failed health check). Same as the
  "Cập nhật" button in the web header and `od self-update`.

For scripts/CI, run them with `--no-pause`.

The zip is the delivery format on purpose: a bare `.command` fetched over
HTTP loses its executable bit and cannot be double-clicked; a zip keeps it.

### Terminal alternative (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/ducanhlaminh/open-design-vnpay/main/deploy/host/install.sh -o install.sh
bash install.sh
```

Linux has no double-click entry point — use the two lines above.

Without `--archive` / `--release-url`, the script downloads the latest
tagged release of this repo (immutable — pinned to whatever release was
"latest" at install time, never to a mutable branch) and picks the tarball
matching your `uname -s`/`uname -m` (`darwin-arm64`, `darwin-x64`, or
`linux-x64`; anything else is a clear error).

## Install (Windows)

Requires Windows 10 1803+ or Windows 11 (64-bit), PowerShell 5.1+ (built
into Windows — PowerShell 7/pwsh works too). `tar.exe`, which ships built-in
since Windows 10 1803, is what does the archive extraction and safety
checks — this is the reason for the minimum-version requirement.

### Recommended: download and double-click

1. Download [`OpenDesign-Windows-Installer.zip`](https://github.com/ducanhlaminh/open-design-vnpay/releases/latest/download/OpenDesign-Windows-Installer.zip)
   and extract it (right-click → *Extract All…*). It contains
   `OpenDesign-Install.cmd`, `OpenDesign-Update.cmd`, `OpenDesign-Start.cmd`,
   `OpenDesign-Stop.cmd`.
2. Double-click `OpenDesign-Install.cmd`. The command window stays open when
   it finishes so the result or any actionable error remains visible. It runs
   entirely as the current user; do not choose **Run as administrator**.

Corporate proxy that re-signs `github.com` (browser works, installer reports a
certificate/`TrustFailure` error): the installer detects this and continues
with TLS certificate validation switched off for its own downloads, printing a
warning. To restore full validation, ask IT for the proxy root CA and install it
into *Trusted Root Certification Authorities*.

The same proxy is also why the download is **slow** on such networks: the
inspecting device re-encrypts and scans the whole 60-100 MB runtime, which
typically caps a single connection at a few hundred KB/s (measured at the
VNPAY office 2026-08-18: ~200-500 KB/s to GitHub vs 11 MB/s to a
non-inspected CDN from the same desk). If IT publishes a download mirror (see
"Mirror / offline install" below), set `OD_RELEASE_URL` before double-clicking
— either as a user environment variable or in the same command window:

```bat
set OD_RELEASE_URL=https://dl.example.com/open-design/latest
OpenDesign-Install.cmd
```

`OpenDesign-Install.cmd` then fetches its bootstrap `install.ps1` from the
mirror too, and the installer saves the URL to `config.env` so in-app updates
keep using it.

After installation, Windows command files are available here:

```text
%USERPROFILE%\.open-design\OpenDesign-Install.cmd
%USERPROFILE%\.open-design\OpenDesign-Update.cmd
%USERPROFILE%\.open-design\OpenDesign-Start.cmd
%USERPROFILE%\.open-design\OpenDesign-Stop.cmd
```

Double-click the action you want. `OpenDesign-Install.cmd` is a **clean
install**: on a machine that already has Open Design it first removes the
previous installation (stops the daemon/launcher, removes the HKCU Run entry,
deletes `%USERPROFILE%\.open-design` — project data under `%USERPROFILE%\od-data`
is kept), then installs the latest release fresh. `OpenDesign-Update.cmd` is
the **in-place update** (`install.ps1 -Update`, keeps `config.env`, rolls back
on a failed health check) — same as the "Cập nhật" button in the web header.
For scripts/CI, pass `--no-pause` so the command window does not wait for a
key press.

### PowerShell alternative

```powershell
irm https://raw.githubusercontent.com/ducanhlaminh/open-design-vnpay/main/deploy/host/install.ps1 | iex
```

Or, to pass flags (`iex` piped scripts can't take arguments directly, but a
scriptblock built from the same text can):

```powershell
iex "& { $(irm https://raw.githubusercontent.com/ducanhlaminh/open-design-vnpay/main/deploy/host/install.ps1) } -NoStart"
```

Both one-liners above run the script as a string, not a file, so they're
unaffected by PowerShell's execution policy. If you'd rather keep a local
copy (e.g. to inspect it first), most machines default to a policy that
blocks running a downloaded `.ps1` directly — pass `-ExecutionPolicy Bypass`
to the invocation (this only affects this one run, not your machine's
persistent policy):

```powershell
irm https://raw.githubusercontent.com/ducanhlaminh/open-design-vnpay/main/deploy/host/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File install.ps1 -NoStart
```

`install.ps1` mirrors `install.sh` step-for-step, with native Windows
primitives standing in for the POSIX ones: a small per-user launcher started
through the current user's `HKCU ...\Run` key instead of launchd/systemd, a
directory Junction instead of a symlink (also no admin/Developer Mode
required — unlike a real Windows symlink), and `tar.exe` for the same
`..`-traversal + single-root-dir archive safety check. Every `--flag` below
has a PowerShell equivalent named the same way in PascalCase, e.g.
`--data-dir` → `-DataDir`, `--no-start` → `-NoStart`, `--update` →
`-Update`.

Everything installs under `%USERPROFILE%\.open-design` by default, data
under `%USERPROFILE%\od-data\open-design` — no administrator elevation is
used anywhere, mirroring install.sh's "no sudo" invariant.

Before step 1, a network preflight probes only the domains this particular
run actually needs (GitHub, `nodejs.org` if no local Node satisfies the
engine range, `claude.ai`/`chatgpt.com` if those CLIs aren't already on
PATH) and fails fast with the specific blocked domain named — instead of a
generic curl/exception failure buried mid-download — if a corporate
firewall/proxy is blocking it. Not counted in the "N/6" numbering below.

Six steps, each printed as it starts (identical phase names/order on every
platform):

1. **Kiểm tra gói cài đặt** — resolve/download the release tarball, verify
   its sha256 **before** anything is extracted.
2. **Kiểm tra Node.js** — reuse a system Node if it satisfies
   `apps/daemon/package.json#engines` (`~24`); otherwise download a private
   Node under `~/.open-design/tools/`, checksummed against nodejs.org's
   `SHASUMS256.txt`.
3. **Giải nén & cài đặt** — extract into `~/.open-design/releases/<version>`
   (Windows: `%USERPROFILE%\.open-design\releases\<version>`), write
   `config.env` (`chmod 600` on macOS/Linux, ACL-locked to the current user
   on Windows via `icacls`), point the `current` symlink (Windows: Junction)
   at the new release.
4. **Cấu hình dịch vụ** — install a macOS LaunchAgent
   (`~/Library/LaunchAgents/com.vnpay.open-design.plist`), a Linux systemd
   `--user` unit (`~/.config/systemd/user/open-design.service`), or a
   Windows per-user launcher registered under `HKCU ...\Run`; falls back to a
   `nohup`-managed process on macOS/Linux if neither launchd nor systemd is
   available.
5. **Khởi động & kiểm tra sức khỏe** — start the service and poll
   `GET /api/health` for up to 60s. On failure, the installer **rolls back**
   to the previous release automatically (a fresh install with nothing to
   roll back to stops the service and exits non-zero instead).
6. **Kiểm tra Claude & Codex CLI & hoàn tất** — installs the Claude Code CLI
   (`https://claude.ai/install.sh` / `.ps1`) and the Codex CLI
   (`https://chatgpt.com/codex/install.sh` / `.ps1`, both official OpenAI
   installers, confirmed live) via their native installers if missing,
   probes login state for both, and prints `http://127.0.0.1:<port>` plus,
   for whichever agent isn't logged in yet, "còn một bước: `claude /login`"
   and/or "còn một bước: `codex login`". Codex has no version-pin support
   yet (Claude does, via a bundled `claude.version` file) — always installs
   latest.

No `sudo`/administrator elevation is used anywhere on any platform.
Everything lives under `$HOME` on macOS/Linux (`~/.open-design` by default,
data under `~/od-data/open-design`), or under `%USERPROFILE%` on Windows
(`%USERPROFILE%\.open-design` by default, data under
`%USERPROFILE%\od-data\open-design`).

### Flags

| Flag | Purpose |
| --- | --- |
| `--archive <path>` | Use a local tarball instead of downloading. |
| `--release-url <url>` | A direct `.tar.gz` URL, or a release "asset base" URL (e.g. a GitHub `releases/download/<tag>` folder, or a mirror folder) containing a `release.json` manifest. Default: `$OD_RELEASE_URL`, then `OD_RELEASE_URL` from an existing `config.env` (so `--update` keeps using the same mirror), then the latest GitHub release of this repo. A base URL is persisted as `OD_RELEASE_URL` in `config.env`; a direct `.tar.gz` URL is not. |
| `--sha256 <hex>` | Expected sha256 of the tarball — overrides any discovered `.sha256`/`release.json` entry. |
| `--port <n>` | Daemon port (default `7456`). |
| `--data-dir <path>` | `OD_DATA_DIR` (default `$HOME/od-data/open-design`). |
| `--env-file <url\|path>` | KEY=VALUE defaults for `CONFLUENCE_URL`/`MEDIA_*`/`IDENTITY_URL`/`GOOGLE_CLIENT_*`/`SESSION_SECRET` (an internal mirror env template). Individual flags below always win over this file. |
| `--media-url` / `--media-app-id` / `--media-user-id` / `--media-user-role` | Media/file-store service for pipeline outputs. |
| `--identity-url` | Google-session → shared-project identity service. |
| `--google-client-id` / `--google-client-secret` / `--session-secret` | Google OAuth login (`/api/auth/google`) — used for KG sync push/pull attribution and Shared Project registration. All three are required together; the same values work across every machine (fixed `localhost:52564` OAuth callback, not machine-specific). |
| `--no-start` | Install everything but do not start/enable the service. |
| `--update` | Update an existing `~/.open-design` install in place. |
| `-h`, `--help` | Show usage. |

Windows-only (`install.ps1`; no `install.sh` equivalent yet — everyday
start/stop on macOS/Linux goes through `launchctl`/`systemctl` instead,
see Update/Rollback/Uninstall below):

| Flag | Purpose |
| --- | --- |
| `-Start` | Start the daemon from the already-installed release and exit. Does not extract/verify/reconfigure anything — for that, use `-Update`. |
| `-Stop` | Stop the running daemon and exit. |
| `-Uninstall` | Stop the daemon/launcher, remove the HKCU Run entry, delete `%USERPROFILE%\.open-design`, and exit. Project data is kept unless `-DeleteData` is also given. Prompts for confirmation unless `-Force` is given. |
| `-InsecureTls` | Turn off TLS certificate validation **for the installer process only**. For corporate networks whose proxy/firewall re-signs `github.com` (browser works, PowerShell fails with `TrustFailure`). The preflight switches this on automatically when it detects exactly that case; the flag forces it up front. Saved as `OD_INSECURE_TLS=1` in `config.env` so `-Update` keeps working. Prefer asking IT to install the proxy root CA into Windows *Trusted Root Certification Authorities* — that fixes PowerShell, Node and the CLIs at once. |

If none of the Media/Identity flags or `--env-file`/`-EnvFile` are given,
those entries are left out of `config.env` and the installer prints a
warning — **KG sync stays off** until you configure them (everything else
works: local projects, skills, design systems, agent runs).

Likewise, without all three Google login flags, `config.env` has none of
them and **Google login (`/login`) stays off** — KG sync push/pull still
works, but falls back to anonymous/installation-id attribution instead of
a real Google identity, and Shared Project registration is skipped.

**Zero-flag installs of this repo's own releases:** the `release-host-runtime.yml`
CI pipeline bundles a filled-in `host-env.template` straight into the tarball
it publishes (sourced from GitHub Actions repo secrets — `OD_MEDIA_URL`,
`OD_MEDIA_APP_ID`, `OD_MEDIA_USER_ID`, `OD_MEDIA_USER_ROLE`, `OD_IDENTITY_URL`,
`OD_GOOGLE_CLIENT_ID`, `OD_GOOGLE_CLIENT_SECRET`, `OD_SESSION_SECRET`). Both
`install.sh` and `install.ps1` read this bundled file automatically as their
last fallback (below any local `host-env.template`/`-EnvFile` override, above
"unconfigured"), so a plain `install.sh` / `install.ps1 -Archive <tarball>`
with **no config flags at all** already has KG sync and Google login enabled.
This is a deliberate tradeoff for this specific repo despite being public —
anyone can download a released tarball and read these values out of
`host-env.template` inside it. Do not copy this pattern into another
fork/deployment's release pipeline without making that same tradeoff on
purpose there too; the safer default (no secrets in the tarball) is to just
not set the `OD_*` secrets in that repo's Actions settings, which makes
build-runtime.sh skip bundling entirely.

**Simpler repeat config (Windows):** rather than passing `-EnvFile`/the
individual `-Media*`/`-Google*` flags on every `-Update`, save your
filled-in template once at `%USERPROFILE%\.open-design\host-env.template`
(same `KEY=VALUE` shape as `--env-file`) — `install.ps1` picks it up
automatically whenever `-EnvFile` isn't given. This file is never
downloaded/shipped/committed by this repo; it's a purely local convention,
so it's the right place to keep real secrets (`GOOGLE_CLIENT_SECRET`,
`SESSION_SECRET`) that must never end up in git.

## Update

```bash
bash ~/.open-design/current/install.sh --update
```

(or re-run the freshly downloaded `install.sh` with `--update`; on macOS you
can instead double-click `OpenDesign-Update.command` from the installer zip —
same command underneath). This
downloads/verifies the new release, extracts it alongside the existing one,
restarts the service, health-checks it (with the same automatic rollback as
a fresh install), **then removes every older release under
`~/.open-design/releases/`** so only the new version remains (the web
"Cập nhật" button, `OpenDesign-Update.*` and `od self-update` all end the
same way: old version gone, new one installed and running — ordered
install → start → remove-old so a failed health check can still roll back;
`--no-start` skips the removal because nothing verified the new release).
Finally it prints the new version straight from `GET /api/version`.
`config.env` is regenerated: machine-specific values (`OD_PORT`,
`OD_DATA_DIR`, `OD_INSECURE_TLS`) carry over, the bundled env defaults of the
new release win for the rest — pass the config flags above on `--update` to
override a value.

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\.open-design\current\install.ps1 -Update
```

Or double-click `%USERPROFILE%\.open-design\OpenDesign-Update.cmd`.

The Windows launcher performs the stop/start handoff outside the daemon's
process tree, so this works from a normal, non-elevated terminal. An older
installation whose bundled updater still uses Task Scheduler must bootstrap
this architecture once by downloading the latest `install.ps1` and running
it with `-Update` from a normal PowerShell window; no Administrator profile is
needed. Later UI/CLI updates use the launcher automatically. If one reports
`restart-required`, log out/in, reboot, or run `install.ps1 -Start` once. The
previous daemon keeps serving until then, and the durable update transaction
is committed or rolled back on that start.

```powershell
irm https://raw.githubusercontent.com/ducanhlaminh/open-design-vnpay/main/deploy/host/install.ps1 -OutFile "$env:TEMP\open-design-install.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\open-design-install.ps1" -Update
```

## Rollback (manual)

After a *successful* update only the current release is kept (older ones are
removed — see Update above), so going back means installing the older
tarball again: download `open-design-runtime-<older>-<platform>.tar.gz` from
the release page and run `install.sh --archive <file> --update` /
`install.ps1 -Archive <file> -Update`. The commands below only apply while an
older directory still exists under `~/.open-design/releases/` (a failed
update, or an install made with `--no-start`):

```bash
ln -sfn ~/.open-design/releases/<older-version> ~/.open-design/current
# macOS
launchctl kickstart -k gui/$(id -u)/com.vnpay.open-design
# Linux (systemd)
systemctl --user restart open-design
```

(A failed install/update already does this automatically — see step 5
above.)

Windows:

```powershell
cmd /c rmdir "$env:USERPROFILE\.open-design\current"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.open-design\current" `
  -Target "$env:USERPROFILE\.open-design\releases\<older-version>"
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\.open-design\current\install.ps1 -Stop
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\.open-design\current\install.ps1 -Start
```

## Uninstall

```bash
# macOS
launchctl bootout gui/$(id -u)/com.vnpay.open-design
rm -f ~/Library/LaunchAgents/com.vnpay.open-design.plist

# Linux (systemd)
systemctl --user disable --now open-design
rm -f ~/.config/systemd/user/open-design.service
systemctl --user daemon-reload

rm -rf ~/.open-design
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\.open-design\current\install.ps1 -Uninstall
# or, to also wipe project data in one step:
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\.open-design\current\install.ps1 -Uninstall -DeleteData
```

(equivalent by hand: stop the pids in `launcher.pid` and `open-design.pid`,
remove the `OpenDesignDaemon` value from
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, then remove
`%USERPROFILE%\.open-design`.)

**Data is not deleted** (unless `-DeleteData` was given above). Project data lives at `OD_DATA_DIR`
(`~/od-data/open-design` by default, or whatever `--data-dir`/`config.env`
pointed at) and is left alone — remove it explicitly if you want a full wipe:

```bash
rm -rf ~/od-data/open-design
```

```powershell
# Windows
Remove-Item -Recurse -Force "$env:USERPROFILE\od-data\open-design"
```

## Mirror / offline install

### Download mirror (`OD_RELEASE_URL`)

The release workflow can publish every release to a mirror in addition to
GitHub Releases. It is switched on purely by repository secrets; with none set
the workflow behaves exactly as before. Two targets are supported (either or
both):

**Cloudflare Pages** — free, no payment method, Cloudflare CDN (the same
network `nodejs.org` is served from, measured 11 MB/s at the VNPAY office).
Pages caps files at 25 MiB, so tarballs are published as `.part01`, `.part02`,
… (24 MiB each) and `release.json` carries `"<platform>.parts": "<n>"`; both
installers download the parts, concatenate, and verify the whole-file sha256
as usual. Setup once: create a free Cloudflare account → *Workers & Pages* →
create an API token (template *Edit Cloudflare Workers*, or custom with
*Account · Cloudflare Pages · Edit*) → note the *Account ID* (dashboard
sidebar / URL). Then add the secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with Pages:Edit. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID. |
| `OD_MIRROR_PAGES_PROJECT` | Pages project name, e.g. `od-runtime` (created on first publish). Public URL = `https://<project>.pages.dev`. |
| `OD_MIRROR_PUBLIC_URL` (optional) | Only if a custom domain fronts the project. |

**S3-compatible bucket** (Cloudflare R2, MinIO, AWS S3, an internal object
store) — whole files:

| Secret | Value |
| --- | --- |
| `OD_MIRROR_S3_BUCKET` | Bucket name. |
| `OD_MIRROR_S3_ENDPOINT` | S3 endpoint, e.g. `https://<account>.r2.cloudflarestorage.com` (empty for AWS S3). |
| `OD_MIRROR_S3_ACCESS_KEY_ID` / `OD_MIRROR_S3_SECRET_ACCESS_KEY` | Write credentials for the bucket. |
| `OD_MIRROR_PUBLIC_URL` | Public base URL that serves the bucket, e.g. `https://dl.example.com/open-design`. |
| `OD_MIRROR_S3_PREFIX` (optional) | Key prefix inside the bucket. |
| `OD_MIRROR_S3_REGION` (optional) | Default `auto` (R2). |

Layout under the public URL (Pages: only the current tag is kept, each deploy
replaces the site):

```text
<public>/<tag>/    open-design-runtime-*.tar.gz[.partNN] (+ .sha256), OpenDesign-*-Installer.zip,
                   release.json (points into this folder), install.ps1, install.sh
<public>/latest/   release.json, install.ps1, install.sh, OpenDesign-*-Installer.zip
                   (rolling pointer, overwritten on every publish)
```

To backfill a release that was published before the secrets existed (or to
try a new project/bucket without waiting for CI), run the same publish step
from any machine with `gh` (+ `npx` for Pages, `aws` for S3):

```bash
# Cloudflare Pages
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
scripts/host-runtime/mirror-publish.sh --tag host-runtime-v0.8.52 --pages-project od-runtime
# S3-compatible
AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
scripts/host-runtime/mirror-publish.sh --tag host-runtime-v0.8.52 \
  --bucket <bucket> --endpoint https://<account>.r2.cloudflarestorage.com \
  --public-url https://dl.example.com/open-design
# add --dry-run to stage only
```

Install from the mirror — the base URL is remembered in `config.env` for
updates:

```bash
# macOS / Linux
OD_RELEASE_URL=https://dl.example.com/open-design/latest bash install.sh
# or: bash install.sh --release-url https://dl.example.com/open-design/latest
```

```bat
rem Windows (double-click flow: set the variable first, then run the .cmd)
set OD_RELEASE_URL=https://dl.example.com/open-design/latest
OpenDesign-Install.cmd
rem PowerShell: .\install.ps1 -ReleaseUrl https://dl.example.com/open-design/latest
```

Why: networks that TLS-inspect `github.com` throttle release downloads to a
few hundred KB/s; a mirror on a non-inspected host restores full speed
(measured 2026-08-18: 8 min → seconds for the Windows runtime).

To go back to GitHub Releases, delete the `OD_RELEASE_URL=` line from
`~/.open-design/config.env` (`%USERPROFILE%\.open-design\config.env` on
Windows) and unset the environment variable.

### Config mirror (`--env-file`)

`--env-file` accepts a URL or a local path, so an internal mirror can serve
one template file with `MEDIA_URL=`, `MEDIA_APP_ID=`, `IDENTITY_URL=`, etc.
already filled in:

```bash
bash install.sh --env-file https://mirror.internal.example/open-design/host-env.template
```

For fully offline installs, pre-download the platform tarball (and its
`.sha256`) from an internal mirror and pass `--archive`:

```bash
bash install.sh --archive /path/to/open-design-runtime-<version>-<platform>.tar.gz --sha256 <hex>
```

Windows equivalents use `-EnvFile` and `-Archive` on `install.ps1` the same
way (see "Install (Windows)" above).

## Building the tarball yourself

See [`../../scripts/host-runtime/build-runtime.sh`](../../scripts/host-runtime/build-runtime.sh)
(`--help` for flags) and
[`../../.github/workflows/release-host-runtime.yml`](../../.github/workflows/release-host-runtime.yml)
for the release pipeline that publishes these tarballs to GitHub Releases.

## Scope

- Signing/notarization is out of scope — there is no `.app`/`.exe` bundle
  here (`install.ps1` downloads a `claude.exe` binary for the Claude CLI,
  but that is Anthropic's own signed installer, not something this repo
  builds or signs).
- Windows-on-ARM is out of scope for v1 — `win32-x64` only. `install.ps1`
  fails with a clear error on 32-bit or ARM64 Windows.
- This is a single-user, single-machine install. Multi-user/server fan-out is
  out of scope.
- The Docker self-host path (`../Dockerfile`, `../docker-compose.yml`,
  `../scripts/install.sh`) is unrelated and unaffected — pick whichever fits;
  both can point at the same `OD_DATA_DIR` if you want to migrate between
  them.
