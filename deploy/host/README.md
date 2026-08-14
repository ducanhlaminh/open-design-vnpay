# Host runtime (one-command install, no Docker)

Runs Open Design directly on macOS or Linux as a single Node.js process (the
daemon serves both `/api/*` and the built web UI — no Docker, no Electron).
This is a different deployment path from [`../README.md`](../README.md)
(Docker self-host): that one stays as-is, this one is for a bare host install
managed by launchd (macOS) or a systemd `--user` unit (Linux).

Structure inspired by kit-gen style installers (folder layout and general
flow, not copied verbatim from any project).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ducanhlaminh/open-design-vnpay/main/deploy/host/install.sh -o install.sh
bash install.sh
```

Without `--archive` / `--release-url`, the script downloads the latest
tagged release of this repo (immutable — pinned to whatever release was
"latest" at install time, never to a mutable branch) and picks the tarball
matching your `uname -s`/`uname -m` (`darwin-arm64`, `darwin-x64`, or
`linux-x64`; anything else is a clear error).

Six steps, each printed as it starts:

1. **Kiểm tra gói cài đặt** — resolve/download the release tarball, verify
   its sha256 **before** anything is extracted.
2. **Kiểm tra Node.js** — reuse a system Node if it satisfies
   `apps/daemon/package.json#engines` (`~24`); otherwise download a private
   Node under `~/.open-design/tools/`, checksummed against nodejs.org's
   `SHASUMS256.txt`.
3. **Giải nén & cài đặt** — extract into `~/.open-design/releases/<version>`,
   write `~/.open-design/config.env` (`chmod 600`), point the `current`
   symlink at the new release.
4. **Cấu hình dịch vụ** — install a macOS LaunchAgent
   (`~/Library/LaunchAgents/com.vnpay.open-design.plist`) or a Linux systemd
   `--user` unit (`~/.config/systemd/user/open-design.service`); falls back
   to a `nohup`-managed process if neither is available.
5. **Khởi động & kiểm tra sức khỏe** — start the service and poll
   `GET /api/health` for up to 60s. On failure, the installer **rolls back**
   to the previous release automatically (a fresh install with nothing to
   roll back to stops the service and exits non-zero instead).
6. **Kiểm tra Claude CLI & hoàn tất** — installs the Claude Code CLI via its
   native installer if missing, probes login state, and prints
   `http://127.0.0.1:<port>` plus, if not logged in yet, "còn một bước:
   `claude /login`".

No `sudo` is used anywhere. Everything lives under `$HOME`
(`~/.open-design` by default, data under `~/od-data/open-design` by
default).

### Flags

| Flag | Purpose |
| --- | --- |
| `--archive <path>` | Use a local tarball instead of downloading. |
| `--release-url <url>` | A direct `.tar.gz` URL, or a release "asset base" URL (e.g. a GitHub `releases/download/<tag>` folder) containing a `release.json` manifest. Default: the latest GitHub release of this repo. |
| `--sha256 <hex>` | Expected sha256 of the tarball — overrides any discovered `.sha256`/`release.json` entry. |
| `--port <n>` | Daemon port (default `7456`). |
| `--data-dir <path>` | `OD_DATA_DIR` (default `$HOME/od-data/open-design`). |
| `--env-file <url\|path>` | KEY=VALUE defaults for `MEDIA_*`/`IDENTITY_URL`/`GOOGLE_CLIENT_*`/`SESSION_SECRET` (an internal mirror env template). Individual flags below always win over this file. |
| `--media-url` / `--media-app-id` / `--media-user-id` / `--media-user-role` | Media/file-store service for pipeline outputs. |
| `--identity-url` | Google-session → shared-project identity service. |
| `--google-client-id` / `--google-client-secret` / `--session-secret` | Google OAuth login (`/api/auth/google`) — used for KG sync push/pull attribution and Shared Project registration. All three are required together; the same values work across every machine (fixed `localhost:52564` OAuth callback, not machine-specific). |
| `--no-start` | Install everything but do not start/enable the service. |
| `--update` | Update an existing `~/.open-design` install in place. |
| `-h`, `--help` | Show usage. |

If none of the Media/Identity flags or `--env-file` are given, those
entries are left out of `config.env` and the installer prints a warning —
**KG sync stays off** until you configure them (everything else works: local
projects, skills, design systems, agent runs).

Likewise, without all three Google login flags, `config.env` has none of
them and **Google login (`/login`) stays off** — KG sync push/pull still
works, but falls back to anonymous/installation-id attribution instead of
a real Google identity, and Shared Project registration is skipped.

## Update

```bash
bash ~/.open-design/current/install.sh --update
```

(or re-run the freshly downloaded `install.sh` with `--update`). This
downloads/verifies the new release, extracts it alongside the existing ones,
restarts the service, health-checks it (with the same automatic rollback as
a fresh install), and finally prints the new version straight from
`GET /api/version`. `config.env` is left untouched unless you pass one of
the config flags above — pass them again on `--update` if you want to change
a value.

## Rollback (manual)

Every extracted release stays under `~/.open-design/releases/`. To go back
to an older one by hand:

```bash
ln -sfn ~/.open-design/releases/<older-version> ~/.open-design/current
# macOS
launchctl kickstart -k gui/$(id -u)/com.vnpay.open-design
# Linux (systemd)
systemctl --user restart open-design
```

(A failed install/update already does this automatically — see step 5
above.)

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

**Data is not deleted.** Project data lives at `OD_DATA_DIR`
(`~/od-data/open-design` by default, or whatever `--data-dir`/`config.env`
pointed at) and is left alone — remove it explicitly if you want a full wipe:

```bash
rm -rf ~/od-data/open-design
```

## Mirror / offline install

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

## Building the tarball yourself

See [`../../scripts/host-runtime/build-runtime.sh`](../../scripts/host-runtime/build-runtime.sh)
(`--help` for flags) and
[`../../.github/workflows/release-host-runtime.yml`](../../.github/workflows/release-host-runtime.yml)
for the release pipeline that publishes these tarballs to GitHub Releases.

## Scope

- Signing/notarization is out of scope — there is no `.app` bundle here.
- Windows is not supported by this installer; see the (separate) `apps/desktop`
  Electron build for that.
- This is a single-user, single-machine install. Multi-user/server fan-out is
  out of scope.
- The Docker self-host path (`../Dockerfile`, `../docker-compose.yml`,
  `../scripts/install.sh`) is unrelated and unaffected — pick whichever fits;
  both can point at the same `OD_DATA_DIR` if you want to migrate between
  them.
