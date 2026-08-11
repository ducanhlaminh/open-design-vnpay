// @ts-nocheck
// Vendored from design-v3 fig-pipeline/tools/merge-ir.mjs (branch
// feat/ui-figma-new). Pure ESM, zero dependencies. validateIR / mergeIRs /
// analyzeTokenLinks for multi-file IR imports (foundation + ui-lib splits).
// Kept verbatim apart from this header; re-vendor instead of editing.
function validateArray(ir, key, label) {
  if (ir[key] !== undefined && !Array.isArray(ir[key])) throw new Error(`${label}: ${key} must be an array`);
}

export function validateIR(value, label = "IR") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: JSON root must be an object`);
  if (!value.meta || typeof value.meta.file !== "string") throw new Error(`${label}: missing meta.file`);
  for (const key of ["collections", "variables", "componentSets", "components", "icons"]) validateArray(value, key, label);
  if (value.assets !== undefined && (!value.assets || typeof value.assets !== "object" || Array.isArray(value.assets))) {
    throw new Error(`${label}: assets must be an object`);
  }
  return value;
}

function collectBoundTokens(node, output) {
  if (!node) return;
  for (const value of Object.values(node.bound ?? {})) if (typeof value === "string") output.add(value);
  for (const paint of [...(node.fills ?? []), ...(node.strokes ?? [])]) if (typeof paint?.var === "string") output.add(paint.var);
  for (const child of node.children ?? []) collectBoundTokens(child, output);
}

export function analyzeTokenLinks(ir) {
  const warnings = [];
  const available = new Set((ir.variables ?? []).map((variable) => variable.name));
  const tokenCollections = new Map();
  for (const variable of ir.variables ?? []) {
    const collections = tokenCollections.get(variable.name) ?? new Set();
    collections.add(variable.collection ?? "?");
    tokenCollections.set(variable.name, collections);
  }
  for (const [name, collections] of tokenCollections) {
    if (collections.size > 1) warnings.push(`token "${name}" exists in multiple collections (${[...collections].join(", ")}); generated CSS uses one variable name`);
  }

  const used = new Set();
  for (const component of [...(ir.componentSets ?? []), ...(ir.components ?? [])]) {
    for (const variant of component.variants ?? []) collectBoundTokens(variant.tree, used);
  }
  const missing = [...used].filter((name) => !available.has(name)).sort();
  if (missing.length) warnings.push(`${missing.length} unresolved token binding(s): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", …" : ""}`);
  return { used: [...used].sort(), missing, warnings };
}

export function mergeIRs(inputs) {
  if (!inputs.length) throw new Error("No IR files to merge");
  const normalized = inputs.map((input, index) => {
    const entry = input?.ir ? input : { ir: input, filename: `IR #${index + 1}` };
    return { ...entry, ir: validateIR(entry.ir, entry.filename ?? `IR #${index + 1}`) };
  });
  const collections = new Map();
  const variables = new Map();
  const icons = new Map();
  const swapNames = {};
  const assets = {};
  const images = {};
  const componentSets = [];
  const components = [];
  const warnings = [];

  normalized.forEach(({ ir, filename }, sourceIndex) => {
    for (const collection of ir.collections ?? []) {
      const previous = collections.get(collection.name);
      collections.set(collection.name, previous ? {
        ...previous,
        ...collection,
        modes: [...new Set([...(previous.modes ?? []), ...(collection.modes ?? [])])],
      } : { ...collection });
    }
    for (const variable of ir.variables ?? []) {
      const key = `${variable.collection}\u0000${variable.name}`;
      if (variables.has(key)) warnings.push(`duplicate token ${variable.collection}/${variable.name}; using ${filename}`);
      variables.set(key, variable);
    }
    for (const set of ir.componentSets ?? []) componentSets.push({ ...set, id: `f${sourceIndex}:${set.id ?? set.name}` });
    for (const component of ir.components ?? []) components.push({ ...component, id: `f${sourceIndex}:${component.id ?? component.name}` });
    for (const icon of ir.icons ?? []) {
      if (icons.has(icon.name)) warnings.push(`duplicate icon "${icon.name}"; using ${filename}`);
      icons.set(icon.name, icon);
    }
    Object.assign(swapNames, ir.swapNames ?? {});
    Object.assign(assets, ir.assets ?? {});
    Object.assign(images, ir.images ?? {});
  });

  const files = normalized.map(({ ir, filename }) => ({
    filename,
    name: ir.meta.file,
    exportedAt: ir.meta.exportedAt,
    scope: ir.meta.scope,
    generator: ir.meta.generator,
  }));
  const merged = {
    meta: {
      file: files.length === 1 ? files[0].name : `${files[0].name} + ${files.length - 1} files`,
      files,
      exportedAt: new Date().toISOString(),
      scope: "multi-file-offline",
      source: "offline-ir-merge",
      generator: "fig-import-merge@1.0.0",
    },
    collections: [...collections.values()],
    variables: [...variables.values()],
    componentSets,
    components,
    icons: [...icons.values()],
    swapNames,
    assets,
    images,
  };
  const tokenLinks = analyzeTokenLinks(merged);
  warnings.push(...tokenLinks.warnings);
  merged.meta.mergeWarnings = warnings;
  merged.meta.tokenLinks = { used: tokenLinks.used.length, missing: tokenLinks.missing };
  return { ir: merged, warnings, tokenLinks };
}
