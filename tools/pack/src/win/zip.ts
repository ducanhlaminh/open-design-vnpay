import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { ToolPackConfig } from "../config.js";
import { DESKTOP_PORTABLE_MARKER_FILE } from "@open-design/sidecar-proto";

import { winResources } from "../resources.js";
import type { WinBuiltAppManifest, WinPaths } from "./types.js";

const execFileAsync = promisify(execFile);

// Produces a portable zip from the unpacked Electron build using the same 7z
// binary that ships with tools-pack for the NSIS payload. The zip lays files
// flat at the archive root so that users can extract it anywhere on Windows
// and run `Open Design.exe` without going through the NSIS installer.
//
// We deliberately do not delegate this to electron-builder's native `zip`
// target: the existing tools-pack flow forces electron-builder to `to: "dir"`
// so the cached `win-unpacked` output can be shared across cache hits and
// post-processed into the custom NSIS installer. Producing the zip from that
// same cached unpacked tree keeps the build deterministic and avoids a
// second electron-builder pass.
export async function buildWinPortableZip(
  _config: ToolPackConfig,
  paths: WinPaths,
  builtApp: WinBuiltAppManifest,
): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows portable zip build must run on Windows");

  await mkdir(dirname(paths.setupZipPath), { recursive: true });
  await rm(paths.setupZipPath, { force: true });
  await execFileAsync(
    winResources.sevenZipExe,
    ["a", "-tzip", "-mx=5", paths.setupZipPath, ".\\*"],
    {
      cwd: builtApp.unpackedRoot,
      windowsHide: true,
    },
  );

  // Stamp the archive as a PORTABLE install. The running app reads this marker
  // next to its executable (apps/desktop/src/main/updater.ts) to decide which
  // update artifact it can actually use: an installed copy takes the NSIS
  // installer, a portable copy takes this zip — a machine whose policy blocks
  // installers can still update.
  //
  // Added as a SECOND 7z pass from a temp dir rather than written into
  // `builtApp.unpackedRoot`, so the shared unpacked tree the NSIS payload is
  // built from stays byte-identical. That keeps the two targets independent
  // regardless of the order they are built in.
  const markerDir = await mkdtemp(join(tmpdir(), "od-portable-marker-"));
  try {
    await writeFile(
      join(markerDir, DESKTOP_PORTABLE_MARKER_FILE),
      `${JSON.stringify({ install: "portable" }, null, 2)}\n`,
      "utf8",
    );
    await execFileAsync(
      winResources.sevenZipExe,
      ["a", "-tzip", "-mx=5", paths.setupZipPath, DESKTOP_PORTABLE_MARKER_FILE],
      { cwd: markerDir, windowsHide: true },
    );
  } finally {
    await rm(markerDir, { force: true, recursive: true });
  }

  await stat(paths.setupZipPath);
}
