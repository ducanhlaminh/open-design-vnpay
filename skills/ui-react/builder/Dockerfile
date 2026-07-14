# uireact-base — the shared, heavy build toolkit for the docs-to-react workflow.
#
# node_modules for the WHOLE VNPAY React toolkit (superset) is installed ONCE
# here at /opt/toolkit and shared read-only across every project build (each
# build symlinks /app/node_modules -> /opt/toolkit/node_modules). Per-project
# config lives in the project CWD; this image carries deps only, no project.
#
# MUST be linux/arm64 to match Apple Silicon — an amd64 image would run under
# QEMU (slow) and ship the wrong native binaries (lightningcss/esbuild), so we
# pin the platform. Rebuild + bump base/toolkit.version when the superset changes.
FROM --platform=linux/arm64 node:24-bookworm-slim

# pnpm via corepack (matches the repo's package-manager story).
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Install the superset at /work/node_modules. At build time the project is
# bind-mounted at /work/app (a CHILD dir), so Node/Vite/tsc resolve deps by
# walking UP from /work/app to /work/node_modules — the shared toolkit — without
# writing any symlink into the host-mounted project dir.
WORKDIR /work
COPY base/package.json ./package.json
COPY base/pnpm-lock.yaml ./pnpm-lock.yaml
# Locked install: the committed lockfile pins the whole superset so rebuilds
# are reproducible (regenerate with `pnpm install --lockfile-only
# --ignore-workspace` in base/ when bumping deps). Native deps (lightningcss,
# esbuild) install their linux-arm64 binaries here — correct because this
# stage runs on arm64 linux, the same runtime the build uses.
RUN pnpm install --frozen-lockfile --prod=false \
 && pnpm store prune \
 && mkdir -p /work/app \
 && chmod -R a+rX /work

# Toolkit bins (vite, tsc) resolvable from the project workdir.
ENV PATH=/work/node_modules/.bin:$PATH

LABEL org.opencontainers.image.title="uireact-base" \
      org.opencontainers.image.description="Shared VNPAY React (Vite+Tailwind v4+shadcn) build toolkit for docs-to-react"

# Builds run as the unprivileged node user (build.sh also passes --user node).
USER node
WORKDIR /work/app
