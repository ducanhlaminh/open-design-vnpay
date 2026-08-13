// WP6 host-runtime bundling — thin reuse shim around tools/pack's resource
// bundling so the host-runtime tarball ships EXACTLY the same resource tree
// list (skills/design-templates/design-systems/craft/plugins/_official/
// plugins/registry/prompt-templates/frames/community-pets) that packaged
// desktop builds already bundle, instead of re-deriving/duplicating that list
// here and letting the two drift apart.
//
// Deliberately does NOT modify tools/pack/src/resources.ts (owned by WP5 in a
// parallel worktree) — imports the already-exported `copyBundledResourceTrees`
// function as-is.
//
// Usage:
//   node --experimental-strip-types scripts/host-runtime/copy-resources.ts \
//     <workspaceRoot> <resourceRoot>
import { copyBundledResourceTrees } from '../../tools/pack/src/resources.ts';

const [, , workspaceRoot, resourceRoot] = process.argv;

if (!workspaceRoot || !resourceRoot) {
  console.error('Usage: copy-resources.ts <workspaceRoot> <resourceRoot>');
  process.exit(2);
}

await copyBundledResourceTrees({ workspaceRoot, resourceRoot });
console.log(`[copy-resources] bundled resource trees copied into ${resourceRoot}`);
