// WP6 — merges the per-platform host-runtime tarballs produced by
// build-runtime.sh (one per darwin-arm64/darwin-x64/linux-x64 CI matrix job)
// into a single flat-key release.json asset.
//
// Flat keys ("<platform>.url" / "<platform>.sha256" as TOP-LEVEL keys,
// not nested objects) are deliberate: deploy/host/install.sh resolves this
// file with grep before Node.js is guaranteed to be installed on the target
// host (that's the whole point of the bootstrap — see json_flat_value in
// install.sh), so the shape has to stay greppable without a JSON parser.
//
// Usage:
//   node --experimental-strip-types scripts/host-runtime/build-release-manifest.ts \
//     --version <x.y.z> --tag <tag> --repo <owner>/<repo> --out release.json \
//     [--base-url <https://mirror.example/od/<tag>>]
//   (run with cwd = the directory containing every open-design-runtime-*.tar.gz
//   + its .sha256 sidecar)
//
// --base-url makes every "<platform>.url" point at <base-url>/<tarball> instead
// of the GitHub release asset. Used by the release workflow's optional mirror
// step: corporate networks that TLS-inspect github.com (measured 2026-08-18 at
// the VNPAY office: ~200-500 KB/s through the inspecting proxy vs 11 MB/s to a
// non-inspected CDN) can install from a mirror by pointing the installers at
// that mirror's release.json (OD_RELEASE_URL / -ReleaseUrl / --release-url).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

const version = argValue('version');
const tag = argValue('tag');
const repo = argValue('repo');
const out = argValue('out') ?? 'release.json';
const baseUrl = argValue('base-url')?.replace(/\/+$/, '');

if (!version || !tag || !repo) {
  console.error('Usage: build-release-manifest.ts --version <x.y.z> --tag <tag> --repo <owner>/<repo> [--out release.json] [--base-url <url>]');
  process.exit(2);
}

const TARBALL_RE = /^open-design-runtime-.+-(darwin-arm64|darwin-x64|linux-x64|win32-x64)\.tar\.gz$/;

const manifest: Record<string, string> = { version, tag };
let found = 0;

for (const entry of readdirSync('.')) {
  const match = TARBALL_RE.exec(entry);
  if (!match) continue;
  const platform = match[1]!;
  const sha256Path = `${entry}.sha256`;
  const sha256Line = readFileSync(sha256Path, 'utf8').trim();
  const sha256 = sha256Line.split(/\s+/)[0];
  if (!sha256) throw new Error(`could not read sha256 from ${sha256Path}`);
  manifest[`${platform}.url`] = baseUrl
    ? `${baseUrl}/${entry}`
    : `https://github.com/${repo}/releases/download/${tag}/${entry}`;
  manifest[`${platform}.sha256`] = sha256;
  found += 1;
}

if (found === 0) {
  throw new Error('no open-design-runtime-*.tar.gz tarballs found in the current directory');
}

writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[build-release-manifest] wrote ${out} (${found} platform(s))`);
