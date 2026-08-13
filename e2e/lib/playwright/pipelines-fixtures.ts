// Shared Playwright fixture helpers for the Pipelines (App/Feature CRUD, run,
// pull/push) UI suites. These call the DAEMON's own HTTP API directly
// (`http://127.0.0.1:${daemonPort}`) instead of going through the web app's
// `/api/*` Next.js rewrite (see `apps/web/next.config.ts`) — a couple of the
// routes below (`importFigmaIrFixture`) are gated by the daemon's
// `requireLocalOrigin` check (apps/daemon/src/static-resource-routes.ts),
// which is driven by the `Host` header the daemon actually receives. Calling
// the daemon's own port sidesteps any ambiguity in how the dev-mode Next.js
// proxy forwards that header, and keeps every fixture call in this module on
// one consistent transport.
//
// `daemonPort()` mirrors the resolution in `playwright.config.ts`
// (`Number(process.env.OD_PORT) || 17_456`) — the same daemon the
// `webServer` block there boots for the whole UI suite.

import type { APIRequestContext, Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultFigmaIrFixtureFiles, type FigmaIrFixtureFile } from './figma-ir-fixture.ts';

export { defaultFigmaIrFixtureFiles, type FigmaIrFixtureFile };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `e2e/lib/playwright/` -> repo root is exactly three levels up. Deliberately
// NOT a "walk up until a package.json is found" search: `e2e/` owns its own
// package.json, so that pattern would stop at `e2e/` instead of the true
// monorepo root (verified against apps/daemon/src/server.ts's own
// `resolveProjectRoot`, which this mirrors).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export function repoRoot(): string {
  return REPO_ROOT;
}

/** Same resolution as `playwright.config.ts`'s `daemonPort`. */
export function daemonPort(): number {
  return Number(process.env.OD_PORT) || 17_456;
}

export function daemonBaseUrl(): string {
  return `http://127.0.0.1:${daemonPort()}`;
}

function daemonUrl(pathname: string): string {
  return `${daemonBaseUrl()}${pathname}`;
}

async function readJsonOrThrow<T>(response: {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
}, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok()) {
    throw new Error(`${label} failed: HTTP ${response.status()} ${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

// ---------------------------------------------------------------------------
// App CRUD — POST/DELETE /api/pipelines/apps (apps/daemon/src/pipeline-routes.ts)
// ---------------------------------------------------------------------------

export interface CreateAppResult {
  id: string;
  name: string;
  designSystemId: string | null;
}

export async function createAppViaApi(
  request: APIRequestContext,
  options: { appId: string; name?: string; designSystemId?: string | null },
): Promise<CreateAppResult> {
  const response = await request.post(daemonUrl('/api/pipelines/apps'), {
    data: {
      appId: options.appId,
      name: options.name ?? options.appId,
      ...(options.designSystemId !== undefined ? { designSystemId: options.designSystemId } : {}),
    },
  });
  return readJsonOrThrow<CreateAppResult>(response, 'createAppViaApi');
}

/** Idempotent cleanup: a 404 (already gone) is not an error for a teardown helper. */
export async function deleteAppViaApi(request: APIRequestContext, appId: string): Promise<void> {
  const response = await request.delete(daemonUrl(`/api/pipelines/apps/${encodeURIComponent(appId)}`));
  if (!response.ok() && response.status() !== 404) {
    throw new Error(`deleteAppViaApi failed: HTTP ${response.status()} ${(await response.text()).slice(0, 500)}`);
  }
}

// ---------------------------------------------------------------------------
// Feature CRUD — Feature = a pipeline "project". POST /api/pipelines/projects
// creates it; DELETE reuses the generic /api/projects/:id route (see
// `deleteFeature` in apps/web/src/components/pipelines/PipelinesRoute.tsx).
// ---------------------------------------------------------------------------

export interface CreateFeatureResult {
  id: string;
  name: string;
}

export async function createFeatureViaApi(
  request: APIRequestContext,
  options: { projectId: string; name?: string; appId?: string; appName?: string },
): Promise<CreateFeatureResult> {
  const response = await request.post(daemonUrl('/api/pipelines/projects'), {
    data: {
      projectId: options.projectId,
      name: options.name ?? options.projectId,
      ...(options.appId ? { appId: options.appId } : {}),
      ...(options.appName ? { appName: options.appName } : {}),
    },
  });
  return readJsonOrThrow<CreateFeatureResult>(response, 'createFeatureViaApi');
}

/** Idempotent cleanup: a 404 (already gone) is not an error for a teardown helper. */
export async function deleteFeatureViaApi(request: APIRequestContext, projectId: string): Promise<void> {
  const response = await request.delete(daemonUrl(`/api/projects/${encodeURIComponent(projectId)}`));
  if (!response.ok() && response.status() !== 404) {
    throw new Error(`deleteFeatureViaApi failed: HTTP ${response.status()} ${(await response.text()).slice(0, 500)}`);
  }
}

// ---------------------------------------------------------------------------
// Figma IR import — POST /api/design-systems/import/figma (multipart)
// apps/daemon/src/static-resource-routes.ts. Field `files` may repeat (multer
// `.array('files', 16)`); Node's global `FormData#append` supports repeated
// keys, which a plain `multipart` object literal (one value per key) cannot.
// ---------------------------------------------------------------------------

export interface ImportFigmaIrOptions {
  /** Optional display name. The route derives the resulting design-system id
   *  by slugifying this (or the IR's own `meta.file` prefix when omitted) —
   *  it does NOT accept a caller-chosen id directly
   *  (apps/daemon/src/figma-ds-import.ts `nextAvailableSlug`). Read the
   *  returned `designSystem.id` instead of guessing it up front. */
  name?: string;
  /** Defaults to `defaultFigmaIrFixtureFiles()` (./figma-ir-fixture.ts). */
  files?: FigmaIrFixtureFile[];
  craftApplies?: string[];
}

export interface ImportFigmaIrResult {
  designSystem: { id: string; title: string; [key: string]: unknown };
  warnings: string[];
  summary: Record<string, unknown>;
  criteria: { rules: boolean; components: boolean };
}

export async function importFigmaIrFixture(
  request: APIRequestContext,
  options: ImportFigmaIrOptions = {},
): Promise<ImportFigmaIrResult> {
  const files = options.files ?? defaultFigmaIrFixtureFiles();
  const form = new FormData();
  for (const file of files) {
    form.append('files', new Blob([file.content], { type: 'application/json' }), file.filename);
  }
  if (options.name) form.append('name', options.name);
  for (const slug of options.craftApplies ?? []) form.append('craftApplies', slug);

  const response = await request.post(daemonUrl('/api/design-systems/import/figma'), {
    multipart: form,
  });
  return readJsonOrThrow<ImportFigmaIrResult>(response, 'importFigmaIrFixture');
}

// ---------------------------------------------------------------------------
// DS review criteria seeding — writes criteria/components.md + criteria/rules.md
// straight to disk under the design system's own directory (apps/daemon/src/
// ds-criteria.ts `dsCriteriaDir`, apps/daemon/src/server.ts `dsDirForId`).
//
// IMPORTANT: this needs the exact on-disk data dir the RUNNING daemon was
// started with. playwright.config.ts computes that as
// `process.env.OD_E2E_DATA_DIR || \`e2e/ui/.od-data/playwright-${process.pid}\``
// — but that fallback's `process.pid` belongs to the Playwright *runner*
// process, not the *worker* process a test (and this helper) actually runs
// in, so a worker can never recompute the PID-based default on its own.
// Callers that need `seedDsCriteria` MUST set `OD_E2E_DATA_DIR` explicitly
// before invoking `playwright test`, so both the config (building the
// `webServer` command) and this helper resolve the identical directory.
// ---------------------------------------------------------------------------

/** `~/` (and bare `~`) expansion only — the daemon's own `expandHomePrefix`
 *  (apps/daemon/src/server.ts) also handles literal `$HOME`/`${HOME}` for a
 *  few non-shell launchers (systemd units, Windows scheduled tasks); those
 *  are not reachable from a local `pnpm exec playwright test` invocation, so
 *  they are intentionally not replicated here. */
function expandHomePrefix(raw: string): string {
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

export function resolveOdDataDir(): string {
  const raw = process.env.OD_E2E_DATA_DIR;
  if (!raw) {
    throw new Error(
      'resolveOdDataDir/seedDsCriteria requires OD_E2E_DATA_DIR to be set to the same value passed to ' +
        '`playwright test` (playwright.config.ts otherwise falls back to a PID-based default this helper, ' +
        'running in a separate worker process, cannot recompute).',
    );
  }
  const expanded = expandHomePrefix(raw);
  return path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot(), expanded);
}

/** Same id-to-directory rule as `dsDirForId` in apps/daemon/src/server.ts,
 *  restricted to the user-imported root (`<dataDir>/design-systems/<id>`) —
 *  every design system a fixture creates lives there, never in the bundled
 *  read-only catalog. */
export function designSystemDirOnDisk(designSystemId: string): string {
  const bareId = designSystemId.replace(/^user:/, '');
  return path.join(resolveOdDataDir(), 'design-systems', bareId);
}

export interface SeedDsCriteriaOptions {
  componentsMd?: string;
  rulesMd?: string;
}

export async function seedDsCriteria(designSystemId: string, options: SeedDsCriteriaOptions = {}): Promise<void> {
  const criteriaDir = path.join(designSystemDirOnDisk(designSystemId), 'criteria');
  await mkdir(criteriaDir, { recursive: true });
  if (options.componentsMd !== undefined) {
    await writeFile(path.join(criteriaDir, 'components.md'), options.componentsMd, 'utf8');
  }
  if (options.rulesMd !== undefined) {
    await writeFile(path.join(criteriaDir, 'rules.md'), options.rulesMd, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Remote-project cleanup — DELETE /api/kg/remote-projects/:id
// (apps/daemon/src/remote-projects-routes.ts). Phase 1 only supports
// `scope=files` (the route's own default); `graph`/`all` are reserved.
// ---------------------------------------------------------------------------

export interface DeleteRemoteProjectResult {
  ok: true;
  data: Record<string, unknown>;
}

export async function deleteRemoteProjectViaApi(
  request: APIRequestContext,
  projectId: string,
): Promise<DeleteRemoteProjectResult> {
  const response = await request.delete(
    daemonUrl(`/api/kg/remote-projects/${encodeURIComponent(projectId)}`),
  );
  return readJsonOrThrow<DeleteRemoteProjectResult>(response, 'deleteRemoteProjectViaApi');
}

// ---------------------------------------------------------------------------
// Checkpoint screenshots — shared across the four Pipelines UI suites so
// reviewers get one predictable screenshot trail per checkpoint.
// `e2e/ui/reports/` is gitignored (see repo root .gitignore) so these never
// land in git.
// ---------------------------------------------------------------------------

function sanitizeScreenshotName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'checkpoint';
}

export async function takeCheckpointScreenshot(page: Page, name: string): Promise<string> {
  const dir = path.join(repoRoot(), 'e2e', 'ui', 'reports', 'manual-screenshots');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${sanitizeScreenshotName(name)}-${Date.now()}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}
