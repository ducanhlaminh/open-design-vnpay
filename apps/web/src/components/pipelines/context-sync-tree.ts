export type ContextFileOperation = 'add' | 'edit' | 'delete';

export interface ContextFileChange {
  path: string;
  operation: ContextFileOperation;
}

/** UI-facing context metadata. The API adapter may fill only the fields that
 * are available while legacy Apps continue to render as "Chưa tạo version". */
export interface AppContextSyncInfo {
  currentVersion?: string | null;
  sharedVersion?: string | null;
  latestVersion?: string | null;
  localDigest?: string | null;
  sharedDigest?: string | null;
  changedFiles?: ContextFileChange[];
}

export interface ContextTreeFeature {
  id: string;
  name: string;
  boundVersion?: string | null;
}

export interface ContextTreeApp {
  id: string;
  name: string;
  context?: AppContextSyncInfo | null;
  features: ContextTreeFeature[];
}

export interface ContextTreeSelection {
  /** Apps whose Context package is selected. Feature selection always keeps
   * its parent here because a Feature cannot be transferred without the exact
   * Context version it is bound to. */
  appIds: ReadonlySet<string>;
  featureIds: ReadonlySet<string>;
}

export interface ContextTreeSelectionPayload {
  appIds: string[];
  projectIds: string[];
}

export function emptyContextSelection(): ContextTreeSelection {
  return { appIds: new Set(), featureIds: new Set() };
}

export function selectionForFeatures(
  apps: readonly ContextTreeApp[],
  featureIds: readonly string[],
): ContextTreeSelection {
  const wanted = new Set(featureIds);
  const appIds = new Set<string>();
  for (const app of apps) {
    if (app.features.some((feature) => wanted.has(feature.id))) appIds.add(app.id);
  }
  return { appIds, featureIds: wanted };
}

export function isWholeAppSelected(app: ContextTreeApp, selection: ContextTreeSelection): boolean {
  return selection.appIds.has(app.id) && app.features.every((feature) => selection.featureIds.has(feature.id));
}

export function isPartOfAppSelected(app: ContextTreeApp, selection: ContextTreeSelection): boolean {
  if (isWholeAppSelected(app, selection)) return false;
  return selection.appIds.has(app.id) || app.features.some((feature) => selection.featureIds.has(feature.id));
}

export function toggleWholeApp(
  app: ContextTreeApp,
  selection: ContextTreeSelection,
): ContextTreeSelection {
  const appIds = new Set(selection.appIds);
  const featureIds = new Set(selection.featureIds);
  if (isWholeAppSelected(app, selection)) {
    appIds.delete(app.id);
    for (const feature of app.features) featureIds.delete(feature.id);
  } else {
    appIds.add(app.id);
    for (const feature of app.features) featureIds.add(feature.id);
  }
  return { appIds, featureIds };
}

export function toggleAppContext(
  app: ContextTreeApp,
  selection: ContextTreeSelection,
): ContextTreeSelection {
  const appIds = new Set(selection.appIds);
  if (appIds.has(app.id)) {
    // A selected Feature requires its binding, so Context cannot be removed
    // until every child Feature has been removed from the transfer.
    if (!app.features.some((feature) => selection.featureIds.has(feature.id))) appIds.delete(app.id);
  } else {
    appIds.add(app.id);
  }
  return { appIds, featureIds: new Set(selection.featureIds) };
}

export function toggleContextFeature(
  app: ContextTreeApp,
  featureId: string,
  selection: ContextTreeSelection,
): ContextTreeSelection {
  const appIds = new Set(selection.appIds);
  const featureIds = new Set(selection.featureIds);
  if (featureIds.has(featureId)) {
    featureIds.delete(featureId);
  } else {
    featureIds.add(featureId);
    appIds.add(app.id);
  }
  return { appIds, featureIds };
}

export function serializeContextSelection(selection: ContextTreeSelection): ContextTreeSelectionPayload {
  return {
    appIds: [...selection.appIds].sort(),
    projectIds: [...selection.featureIds].sort(),
  };
}

/** Versions that must travel for a selected tree. Bound versions come first;
 * the App's current version comes last so Pull can install historical packages
 * and still leave the current pointer on the version the App selected. */
export function contextVersionsForSelection(
  apps: readonly ContextTreeApp[],
  selection: ContextTreeSelection,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const app of apps) {
    if (!selection.appIds.has(app.id)) continue;
    const current = app.context?.currentVersion ?? app.context?.latestVersion ?? null;
    const versions = new Set<string>();
    for (const feature of app.features) {
      if (selection.featureIds.has(feature.id) && feature.boundVersion) versions.add(feature.boundVersion);
    }
    if (current) {
      versions.delete(current);
      versions.add(current);
    }
    result[app.id] = [...versions];
  }
  return result;
}

export function contextVersionLabel(version?: string | null): string {
  if (!version) return 'Chưa tạo version';
  return version.toLowerCase().startsWith('v') ? version : `v${version}`;
}

export function contextNeedsUpdate(context?: AppContextSyncInfo | null): boolean {
  if (!context) return false;
  if (context.localDigest && context.sharedDigest) return context.localDigest !== context.sharedDigest;
  return Boolean(
    context.currentVersion && context.sharedVersion && context.currentVersion !== context.sharedVersion,
  );
}

export function featureHasNewContext(
  feature: ContextTreeFeature,
  context?: AppContextSyncInfo | null,
): boolean {
  const latest = context?.latestVersion ?? context?.currentVersion;
  return Boolean(feature.boundVersion && latest && feature.boundVersion !== latest);
}

export function summarizeContextChanges(changes: readonly ContextFileChange[] = []): string {
  const counts = { add: 0, edit: 0, delete: 0 };
  for (const change of changes) counts[change.operation] += 1;
  return [
    counts.add ? `${counts.add} tệp thêm` : '',
    counts.edit ? `${counts.edit} tệp sửa` : '',
    counts.delete ? `${counts.delete} tệp xóa` : '',
  ].filter(Boolean).join(' · ');
}

export function diffContextManifests(
  current: { files: Array<{ path: string; digest: string }> },
  previous?: { files: Array<{ path: string; digest: string }> } | null,
): ContextFileChange[] {
  const before = new Map((previous?.files ?? []).map((file) => [file.path, file.digest]));
  const after = new Map(current.files.map((file) => [file.path, file.digest]));
  const changes: ContextFileChange[] = [];
  for (const [path, digest] of after) {
    const oldDigest = before.get(path);
    if (oldDigest === undefined) changes.push({ path, operation: 'add' });
    else if (oldDigest !== digest) changes.push({ path, operation: 'edit' });
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ path, operation: 'delete' });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
