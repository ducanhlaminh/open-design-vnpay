# uireact-base — the shared, heavy build toolkit for the docs-to-react workflow.
#
# node_modules for the WHOLE VNPAY React toolkit (superset) is installed ONCE
# here at /opt/toolkit and shared read-only across every project build (each
# build symlinks /app/node_modules -> /opt/toolkit/node_modules). Per-project
# config lives in the project CWD; this image carries deps only, no project.
#
# Built for the HOST's native arch (build-base.sh passes --platform: arm64 on
# Apple Silicon, amd64 on Intel/Windows/Linux) so the container never runs
# under QEMU and native deps (lightningcss/esbuild) install the right
# binaries. Do NOT re-pin a platform in this FROM — a FROM pin overrides the
# build flag and forces emulation on the other arch.
FROM node:24-bookworm-slim

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
# esbuild) install the binaries for THIS stage's arch here — correct because
# the build runs on the same arch the toolkit is later used on.
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
