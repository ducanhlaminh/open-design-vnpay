// Publish a packaged mac stable build to GitHub Releases so the desktop
// auto-updater can discover it.
//
// The runtime updater (apps/desktop/src/main/updater.ts) reads a rolling
// `metadata.json` feed. For the VNPAY fork that feed is a GitHub Release asset
// at `https://github.com/<repo>/releases/latest/download/metadata.json`
// (see `defaultMetadataUrl` in updater.ts). This script builds that JSON from
// one or two already-built DMGs, computes hex sha256 checksums (the updater
// verifies bytes with `createHash("sha256").digest("hex")` + case-insensitive
// compare), and uploads the DMG(s), their `.sha256` sidecars, and metadata.json
// to a single GitHub Release tagged `open-design-v<version>`.
//
// Usage:
//   node --experimental-strip-types scripts/release-github.ts \
//     --arm64-dmg "/path/to/Open Design-<namespace>.dmg" \
//     [--x64-dmg "/path/to/Open Design-<namespace>.dmg"] \
//     [--version 0.8.1] [--notes "..."] [--signed] [--dry-run]
//
// Prereq: `gh` CLI installed and authenticated (`brew install gh && gh auth login`).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "ducanhlaminh/open-design-vnpay";
const RELEASE_ORIGIN = `https://github.com/${REPO}`;
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

type Arch = "arm64" | "x64";

type CliArgs = {
  version: string | null;
  arm64Dmg: string | null;
  x64Dmg: string | null;
  winInstaller: string | null;
  winPortableZip: string | null;
  notes: string | null;
  signed: boolean;
  dryRun: boolean;
};

type PlatformKey = "mac" | "macIntel" | "win";
// `zip` is the Windows PORTABLE build. It ships alongside `installer` under the
// same `win` platform key: an installed copy updates through the installer, a
// portable copy through the zip (apps/desktop/src/main/updater.ts).
type ArtifactKind = "dmg" | "installer" | "zip";

type ArtifactInput = {
  arch: Arch;
  platformKey: PlatformKey;
  artifactKind: ArtifactKind;
  sourcePath: string;
};

type PreparedArtifact = {
  arch: Arch;
  platformKey: PlatformKey;
  artifactKind: ArtifactKind;
  assetName: string;
  assetPath: string;
  sha256Path: string;
  sha256: string;
  size: number;
  url: string;
  sha256Url: string;
};

function fail(message: string): never {
  console.error(`[release-github] ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    version: null,
    arm64Dmg: null,
    x64Dmg: null,
    winInstaller: null,
    winPortableZip: null,
    notes: null,
    signed: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const takeValue = (): string => {
      const value = argv[i + 1];
      if (value == null) fail(`${flag} requires a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--version":
        args.version = takeValue();
        break;
      case "--arm64-dmg":
        args.arm64Dmg = takeValue();
        break;
      case "--x64-dmg":
        args.x64Dmg = takeValue();
        break;
      case "--win-installer":
        args.winInstaller = takeValue();
        break;
      case "--win-portable-zip":
        args.winPortableZip = takeValue();
        break;
      case "--notes":
        args.notes = takeValue();
        break;
      case "--signed":
        args.signed = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      default:
        fail(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function readPackagedVersion(): string {
  const packageJsonPath = join(process.cwd(), "apps", "packaged", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    fail(`missing version in ${packageJsonPath}`);
  }
  return packageJson.version;
}

function sha256Hex(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function prepareArtifact(input: ArtifactInput, version: string, workDir: string): PreparedArtifact {
  try {
    if (!statSync(input.sourcePath).isFile()) fail(`not a file: ${input.sourcePath}`);
  } catch {
    fail(`artifact not found: ${input.sourcePath}`);
  }
  // GitHub rewrites spaces in asset filenames, so copy the built artifact to a
  // URL-safe, versioned name and upload that.
  const assetName =
    input.artifactKind === "installer"
      ? `open-design-${version}-win-${input.arch}-setup.exe`
      : input.artifactKind === "zip"
        ? `open-design-${version}-win-${input.arch}-portable.zip`
        : `open-design-${version}-mac-${input.arch}.dmg`;
  const assetPath = join(workDir, assetName);
  copyFileSync(input.sourcePath, assetPath);
  const sha256 = sha256Hex(assetPath);
  const size = statSync(assetPath).size;
  const sha256Path = join(workDir, `${assetName}.sha256`);
  writeFileSync(sha256Path, `${sha256}  ${assetName}\n`, "utf8");
  const tag = `open-design-v${version}`;
  const url = `${RELEASE_ORIGIN}/releases/download/${tag}/${assetName}`;
  return {
    arch: input.arch,
    platformKey: input.platformKey,
    artifactKind: input.artifactKind,
    assetName,
    assetPath,
    sha256Path,
    sha256,
    size,
    url,
    sha256Url: `${url}.sha256`,
  };
}

function buildMetadata(version: string, signed: boolean, generatedAt: string, artifacts: PreparedArtifact[]): unknown {
  // One platform key can carry SEVERAL artifact kinds (win = installer + zip),
  // so merge into the existing entry instead of replacing it.
  const platforms: Record<string, { artifacts: Record<string, unknown> } & Record<string, unknown>> = {};
  for (const artifact of artifacts) {
    const entry = platforms[artifact.platformKey] ?? { enabled: true, arch: artifact.arch, signed, artifacts: {} };
    entry.artifacts[artifact.artifactKind] = {
      name: artifact.assetName,
      url: artifact.url,
      size: artifact.size,
      sha256: artifact.sha256,
      sha256Url: artifact.sha256Url,
    };
    platforms[artifact.platformKey] = entry;
  }
  return {
    version: 1,
    channel: "stable",
    releaseVersion: version,
    stableVersion: version,
    signed,
    generatedAt,
    github: { repository: REPO },
    platforms,
  };
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function releaseExists(tag: string): boolean {
  try {
    gh(["release", "view", tag, "--repo", REPO, "--json", "tagName"]);
    return true;
  } catch {
    return false;
  }
}

function ensureGhAvailable(): void {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    fail("`gh` CLI not found. Install it first: brew install gh && gh auth login");
  }
}

const args = parseArgs(process.argv.slice(2));
const version = args.version ?? readPackagedVersion();
if (!STABLE_VERSION_PATTERN.test(version)) {
  fail(`stable version must be x.y.z; got ${version}`);
}
const tag = `open-design-v${version}`;
const title = `Open Design ${version}`;
const notes = args.notes ?? `Open Design ${version}`;

const inputs: ArtifactInput[] = [];
if (args.arm64Dmg != null) inputs.push({ arch: "arm64", platformKey: "mac", artifactKind: "dmg", sourcePath: args.arm64Dmg });
if (args.x64Dmg != null) inputs.push({ arch: "x64", platformKey: "macIntel", artifactKind: "dmg", sourcePath: args.x64Dmg });
if (args.winInstaller != null) inputs.push({ arch: "x64", platformKey: "win", artifactKind: "installer", sourcePath: args.winInstaller });
if (args.winPortableZip != null) inputs.push({ arch: "x64", platformKey: "win", artifactKind: "zip", sourcePath: args.winPortableZip });
if (inputs.length === 0) {
  fail("provide at least one of --arm64-dmg / --x64-dmg / --win-installer / --win-portable-zip");
}

const workDir = mkdtempSync(join(tmpdir(), "od-release-github-"));
const artifacts = inputs.map((input) => prepareArtifact(input, version, workDir));
const generatedAt = new Date().toISOString();
const metadata = buildMetadata(version, args.signed, generatedAt, artifacts);
const metadataPath = join(workDir, "metadata.json");
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

const uploadFiles = [
  ...artifacts.map((artifact) => artifact.assetPath),
  ...artifacts.map((artifact) => artifact.sha256Path),
  metadataPath,
];

console.log(`[release-github] repo:    ${REPO}`);
console.log(`[release-github] version: ${version}`);
console.log(`[release-github] tag:     ${tag}`);
console.log(`[release-github] signed:  ${args.signed}`);
for (const artifact of artifacts) {
  console.log(`[release-github] ${artifact.platformKey} (${artifact.arch}): ${artifact.assetName}`);
  console.log(`[release-github]   sha256 ${artifact.sha256}`);
  console.log(`[release-github]   size   ${artifact.size}`);
  console.log(`[release-github]   url    ${artifact.url}`);
}

if (args.dryRun) {
  console.log("[release-github] --dry-run: metadata.json below, no upload performed\n");
  console.log(readFileSync(metadataPath, "utf8"));
  process.exit(0);
}

ensureGhAvailable();

if (releaseExists(tag)) {
  console.log(`[release-github] release ${tag} exists; uploading assets with --clobber`);
  gh(["release", "upload", tag, "--repo", REPO, "--clobber", ...uploadFiles]);
} else {
  console.log(`[release-github] creating release ${tag}`);
  gh([
    "release",
    "create",
    tag,
    "--repo",
    REPO,
    "--title",
    title,
    "--notes",
    notes,
    "--latest",
    ...uploadFiles,
  ]);
}

console.log(`[release-github] done. Feed: ${RELEASE_ORIGIN}/releases/latest/download/metadata.json`);
