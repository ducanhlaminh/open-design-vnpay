// Guard check: the wireframe component registry and everything generated from it
// must stay in sync.
//
// `skills/ux-spec/references/wire-registry.json` is the ONE source of truth for
// the wireframe DSL vocabulary. Two artifacts are generated from it —
// `references/wire-components.md` (what the ux agent reads) and
// `apps/web/src/components/wire-slug-map.generated.ts` (what the renderer
// resolves slugs with). Editing the registry without regenerating them means the
// agent authors against one vocabulary while the renderer draws another.
//
// The generator's own `--check` mode does the comparison (plus the drift check
// that every render kind has a `case` in the renderer); this wrapper just runs it
// so `pnpm guard` fails on a stale tree.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const generator = path.join(repoRoot, "skills", "ux-spec", "scripts", "gen-wire-doc.mjs");

export async function checkWireRegistrySync(): Promise<boolean> {
  if (!existsSync(generator)) {
    console.log("Wire registry sync check skipped: skills/ux-spec/scripts/gen-wire-doc.mjs is absent.");
    return true;
  }

  const result = spawnSync(process.execPath, [generator, "--check"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status === 0) {
    console.log(output || "Wire registry sync check passed.");
    return true;
  }

  console.error("Wire registry is out of sync with its generated files:");
  if (output) console.error(output);
  return false;
}
