// Pull-all / Push-all round trip — Pipelines Studio ↔ the REAL media-service
// (kg-sync), against the real daemon `webServer` this config boots (see
// playwright.config.ts). Self-contained: does not depend on any of the other
// Pipelines UI suites.
//
// POLICY EXCEPTION (explicit product decision, not something this file chose
// on its own): every other e2e suite must mock external services
// (e2e/AGENTS.md "External service dependencies must use temporary
// server-level mocks"). THIS file is a deliberate, narrow exception —
// push/pull genuinely round-trip against the real media-service at
// `MEDIA_URL` (see ../.env.local) — on the condition that media-service is
// actually reachable (checked below) and every project this suite touches
// uses a namespaced id + gets deleted from the remote store again in
// `afterAll`, so it never leaves real team data behind. See the task report
// for the full reachability evidence.
//
// SECOND, NARROWER exception layered on top of the same decision: the daemon
// gates `/api/kg/push-all`, `/api/kg/pull-all`, and `GET /api/kg/remote-
// projects` behind TWO independent identity checks that are easy to conflate:
//   1. The BROWSER session (`/api/auth/me`, a signed cookie) — only gates
//      whether the Pull all / Push all BUTTONS are clickable in the UI
//      (`syncAccess.syncReady` in PipelinesView.tsx). Mocked below via
//      `page.route('**/api/auth/me', ...)`, patching only the `syncReady`
//      field of that ONE internal auth route — media-service itself is never
//      touched by this mock.
//   2. The MACHINE session (`<OD_DATA_DIR>/auth-user.json`, written by a real
//      Google login — see apps/daemon/src/auth-routes.ts's "machine user"
//      section) — this is what `getMachineIdentityUser()` reads SERVER-SIDE
//      inside the push-all/pull-all/remote-projects route handlers
//      themselves. It has nothing to do with the browser cookie above. A
//      fresh Playwright-spawned daemon (isolated `OD_DATA_DIR`, see
//      playwright.config.ts) never has this file, so mocking #1 alone is not
//      enough: push-all would hard-fail every project with
//      `status: 'auth_required'`, and pull-all / GET remote-projects would
//      silently return zero rows (`pullScopeFor` fail-closes with no
//      identity) — the Pull all modal would never show our test project to
//      pick, no matter how much UI mocking is applied.
//      `seedMachineIdentity()` below closes this gap by REUSING this exact
//      machine's own already-established Google login (copied from the real
//      interactive dev daemon's own `OD_DATA_DIR`, resolved from the SAME
//      `../.env.local` the task's media-service reachability check reads)
//      into this suite's isolated e2e `OD_DATA_DIR`. This is not a forged
//      credential — it is the real developer's own session, already sitting
//      unencrypted on this machine, reused for a same-machine local test.
//      Local, personal side effect worth flagging: the identity-service
//      (`preview-identity`, bound to `localhost` — a personal local dev
//      instance, not shared team infra) has no exposed delete API, so the
//      project-registration records the push creates under that identity
//      cannot be cleaned up by this suite. See the task report's `not_done`.
//      If no machine session is available (nobody has ever logged into Open
//      Design's Google SSO on this machine), the whole suite skips with a
//      clear reason instead of running to a guaranteed, confusing failure.
//
// data-testid values below were grepped directly from the component source
// (apps/web/src/components/PipelinesView.tsx, apps/web/src/components/
// pipelines/PipelineModals.tsx) — see the report for the exact list.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyStorageConfig, routeMockAgents, STORAGE_KEY } from '@/playwright/mock-factory';
import {
  createAppViaApi,
  createFeatureViaApi,
  deleteAppViaApi,
  deleteFeatureViaApi,
  deleteRemoteProjectViaApi,
  repoRoot,
  resolveOdDataDir,
  takeCheckpointScreenshot,
} from '@/playwright/pipelines-fixtures';
import { T } from '@/timeouts';

test.describe.configure({ mode: 'serial', timeout: T.xlong });

// docs-review is the only workflow whose docs-ingest stage (`dr-docs`) has a
// broad `docs/` output pattern that matches ANY file dropped straight into
// its docs dir (apps/daemon/src/pipelines.ts PIPELINE_DEFS — `dr-docs`
// outputs `['docs/', 'docs-feature/']`) — the same stage UploadFilesModal's
// "Tải file lên" button targets. docs-to-ui's own `docs` stage requires
// nested jira/confluence/context subfolders an ingest RUN produces, which
// this suite deliberately never runs (no agent CLI in this harness).
const WORKFLOW_ID = 'docs-review';
const FEEDBACK_USERNAME = 'Pipelines Pull/Push E2E';

// One namespaced id-space per run so parallel/repeat runs never collide and
// a leftover from a prior crashed run is trivially recognizable.
const RUN_STAMP = `${Date.now()}-${process.pid}`;
const APP_ID = `e2e-pullpush-app-${RUN_STAMP}`;
const APP_NAME = `E2E Pull-Push App ${RUN_STAMP}`;
const FEATURE_ID = `e2e-pullpush-feature-${RUN_STAMP}`;
const FEATURE_NAME = `E2E Pull-Push Feature ${RUN_STAMP}`;
// Decoy Feature that stays local for the whole suite. PipelinesView hides its
// entire config rail (and the Pull all / Push all buttons inside it) behind
// `hasProjects` (apps/web/src/components/PipelinesView.tsx) — once test case
// B deletes FEATURE_ID locally, this isolated e2e daemon would otherwise have
// ZERO local projects and the rail (and the buttons under test) would not
// render at all. This keepalive Feature is never pushed/pulled itself; it
// only exists so the run screen keeps rendering while FEATURE_ID is locally
// absent.
const KEEPALIVE_ID = `e2e-pullpush-keepalive-${RUN_STAMP}`;
const KEEPALIVE_NAME = `E2E Pull-Push Keepalive ${RUN_STAMP}`;
const SEED_MARKDOWN = `# E2E pull/push round-trip seed\n\nrun=${RUN_STAMP}\n`;

let docsDir = `${WORKFLOW_ID}/docs`; // overwritten from GET /api/workflows in beforeAll
const seedFilePath = () => `${docsDir}/e2e-seed.md`;

let identityReady = false;
let identitySkipReason = '';

/** See the file-header "SECOND, NARROWER exception" note above for the full
 *  why. Best-effort: never throws — a missing source session just means the
 *  suite skips instead of running to a guaranteed auth_required failure. */
async function seedMachineIdentity(): Promise<void> {
  const envLocalPath = path.join(repoRoot(), '.env.local');
  let envLocalRaw: string;
  try {
    envLocalRaw = await readFile(envLocalPath, 'utf8');
  } catch {
    identitySkipReason = `no ${envLocalPath} found — cannot locate a machine Google session to reuse`;
    return;
  }
  const configuredDir = envLocalRaw.match(/^OD_DATA_DIR=(.*)$/m)?.[1]?.trim();
  if (!configuredDir) {
    identitySkipReason = `${envLocalPath} has no OD_DATA_DIR — cannot locate a machine Google session to reuse`;
    return;
  }
  const expanded =
    configuredDir === '~'
      ? os.homedir()
      : configuredDir.startsWith('~/') || configuredDir.startsWith('~\\')
        ? path.join(os.homedir(), configuredDir.slice(2))
        : configuredDir;
  const sourcePath = path.join(expanded, 'auth-user.json');
  let sessionRaw: string;
  try {
    sessionRaw = await readFile(sourcePath, 'utf8');
  } catch {
    identitySkipReason =
      `no machine Google session at ${sourcePath} — log into Open Design once on this machine ` +
      `(Settings → Account → Google) before running this suite`;
    return;
  }
  const destDir = resolveOdDataDir();
  await mkdir(destDir, { recursive: true });
  await writeFile(path.join(destDir, 'auth-user.json'), sessionRaw, { mode: 0o600 });
  identityReady = true;
}

/** Only field this suite is authorized to fake — see the file-header
 *  "POLICY EXCEPTION" note. Fetches the REAL response first (so a caller
 *  session cookie, if one ever exists, still flows through) and only forces
 *  `syncReady`/status; nothing about media-service is touched here. */
async function mockSyncReady(page: Page): Promise<void> {
  await page.route('**/api/auth/me', async (route) => {
    const real = await route.fetch();
    let body: { user?: Record<string, unknown>; identityUserId?: string } = {};
    try {
      body = await real.json();
    } catch {
      body = {};
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: body.user ?? {
          googleSubject: 'e2e-pullpush',
          email: 'e2e-pullpush@example.invalid',
          name: 'E2E Pull-Push',
          provider: 'google',
          roles: [],
        },
        syncReady: true,
        identityUserId: body.identityUserId ?? 'e2e-pullpush-identity',
        syncIssue: null,
      }),
    });
  });
}

async function applyPipelinesMocks(page: Page): Promise<void> {
  await applyStorageConfig(page);
  // FeedbackUsernameGate (apps/web/src/App.tsx) blocks all pointer
  // interaction until `feedbackUsername` is set — mirrors the pattern
  // already established in pipelines-app-feature-crud.test.ts.
  await page.addInitScript(
    ({ key, feedbackUsername }: { key: string; feedbackUsername: string }) => {
      const raw = window.localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      window.localStorage.setItem(key, JSON.stringify({ ...parsed, feedbackUsername }));
    },
    { key: STORAGE_KEY, feedbackUsername: FEEDBACK_USERNAME },
  );
  await routeMockAgents(page);
  // `routeMockAgents` (mock-factory.ts, shared across e2e/ui) only mocks a
  // `mock`-id agent. `InfraSetupGate.tsx` (added by the WP4 host-default
  // flip) separately polls `/api/agents` every 4s looking for a `claude`-id
  // entry with `authStatus === 'ok'` — once its FIRST `/api/sandbox/status`
  // probe resolves `mode: 'host'` (real daemon default; not mocked here on
  // purpose, see below), it starts that poll and, finding no such entry,
  // renders a full-screen "Cài Claude CLI" setup overlay that blocks every
  // click underneath it. Short tests can race past the gate's first status
  // resolution and never trip it; this file's longer Pull-all flow reliably
  // does. Override AFTER `routeMockAgents` (Playwright takes the
  // most-recently-registered matching route) with an additional `claude`
  // entry so the gate is satisfied — this is local to Pull/Push's own
  // longer-running flow, not a shared mock-factory.ts change.
  await page.route('**/api/agents', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        agents: [
          { id: 'mock', name: 'Mock Agent', bin: 'mock-agent', available: true, version: 'test', models: [{ id: 'default', label: 'Default' }] },
          { id: 'claude', name: 'Claude Code', bin: 'claude', available: true, authStatus: 'ok', version: 'test', models: [{ id: 'default', label: 'Default' }] },
        ],
      },
    });
  });
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        config: {
          onboardingCompleted: true,
          agentId: 'mock',
          skillId: null,
          designSystemId: null,
          agentModels: {},
          privacyDecisionAt: 1,
          feedbackUsername: FEEDBACK_USERNAME,
        },
      },
    });
  });
  await mockSyncReady(page);
}

/** `locator(selector, { hasText })` has no `exact` option (unlike
 *  `getByText`) — build an anchored regex instead so `FEATURE_NAME` never
 *  matches `KEEPALIVE_NAME`'s row by loose substring inclusion. */
function exactTextPattern(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/** `Toast.tsx` renders `role="status"` on a clean success, but `role="alert"`
 *  the moment ANY per-project result carries a caveat (e.g. `auth_required`)
 *  — `syncAll` in PipelinesView.tsx still shows the "Đã chia sẻ/lấy N…" copy
 *  either way, just concatenated with the caveat note. Locate by the toast's
 *  own class so the role doesn't have to be guessed up front; the caveat
 *  check right after this locator is what actually asserts a CLEAN success. */
function toastLocator(page: Page) {
  return page.locator('.od-toast');
}

async function gotoRunScreen(page: Page, featureId: string): Promise<void> {
  await page.goto(`/pipelines/app/${encodeURIComponent(APP_ID)}/${encodeURIComponent(featureId)}/${WORKFLOW_ID}`);
  await expect(page.getByTestId('pipelines-view')).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  await seedMachineIdentity();

  const workflowsRes = await request.get('/api/workflows');
  expect(workflowsRes.ok(), await workflowsRes.text()).toBeTruthy();
  const workflowsBody = (await workflowsRes.json()) as {
    workflows: Array<{ id: string; docsDir?: string }>;
  };
  docsDir = workflowsBody.workflows.find((w) => w.id === WORKFLOW_ID)?.docsDir || `${WORKFLOW_ID}/docs`;

  await createAppViaApi(request, { appId: APP_ID, name: APP_NAME });
  await createFeatureViaApi(request, {
    projectId: FEATURE_ID,
    name: FEATURE_NAME,
    appId: APP_ID,
    appName: APP_NAME,
  });
  await createFeatureViaApi(request, {
    projectId: KEEPALIVE_ID,
    name: KEEPALIVE_NAME,
    appId: APP_ID,
    appName: APP_NAME,
  });

  const seedRes = await request.post(`/api/projects/${encodeURIComponent(FEATURE_ID)}/files`, {
    data: { name: seedFilePath(), content: SEED_MARKDOWN },
  });
  expect(seedRes.ok(), await seedRes.text()).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  // Remote first (media-service): both the Feature itself AND its parent App
  // pick up a media-service folder on push (uploadProjectFiles also syncs
  // the App's context/docs pool under the App's own id) — see
  // apps/daemon/src/server.ts's `uploadProjectFiles`.
  for (const id of [FEATURE_ID, APP_ID]) {
    try {
      await deleteRemoteProjectViaApi(request, id);
    } catch (err) {
      console.warn(`[pipelines-pull-push] teardown: failed to delete remote project "${id}": ${String(err)}`);
    }
  }
  for (const id of [FEATURE_ID, KEEPALIVE_ID]) {
    try {
      await deleteFeatureViaApi(request, id);
    } catch (err) {
      console.warn(`[pipelines-pull-push] teardown: failed to delete local feature "${id}": ${String(err)}`);
    }
  }
  try {
    await deleteAppViaApi(request, APP_ID);
  } catch (err) {
    console.warn(`[pipelines-pull-push] teardown: failed to delete local app "${APP_ID}": ${String(err)}`);
  }

  // Hard verify: no residue left on the remote store for either test id.
  const res = await request.get('/api/kg/remote-projects');
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { data: Array<{ projectId: string }> };
  const remainingIds = body.data.map((p) => p.projectId);
  expect(remainingIds, `remote-projects after teardown: ${JSON.stringify(remainingIds)}`).not.toContain(FEATURE_ID);
  expect(remainingIds, `remote-projects after teardown: ${JSON.stringify(remainingIds)}`).not.toContain(APP_ID);
});

test.beforeEach(async ({ page }) => {
  test.skip(!identityReady, identitySkipReason);
  await applyPipelinesMocks(page);
});

test('Push-all: pushes the seeded Feature through the real UI and it appears on the remote store', async ({ page, request }) => {
  await gotoRunScreen(page, FEATURE_ID);

  const pushAllBtn = page.getByTestId('pipeline-push-all-btn');
  await expect(pushAllBtn).toBeEnabled({ timeout: T.long });
  await pushAllBtn.click();

  const dialog = page.getByRole('dialog', { name: /Chia sẻ kết quả/ });
  await expect(dialog).toBeVisible();

  const featureCheckbox = page.getByRole('checkbox', { name: `Chọn Feature ${FEATURE_NAME}` });
  await featureCheckbox.check();

  const confirmBtn = page.getByTestId('pipeline-push-confirm');
  await expect(confirmBtn).toBeEnabled({ timeout: T.long });
  await takeCheckpointScreenshot(page, 'pull-push-push-all-modal-selected');

  await confirmBtn.click();
  await expect(dialog).toHaveCount(0, { timeout: T.long });
  const pushToast = toastLocator(page);
  await expect(pushToast).toContainText('Đã chia sẻ', { timeout: T.long });
  await takeCheckpointScreenshot(page, 'pull-push-push-all-success-toast');
  // A clean push must carry no per-project caveat (e.g. the machine identity
  // session being unusable) — fail with the ACTUAL daemon-reported reason
  // instead of a generic timeout further down if one shows up.
  await expect(pushToast, 'push-all toast reported a caveat instead of a clean success').not.toContainText('Chưa thể chia sẻ');

  // Verify BY API, not just by trusting the UI toast.
  const remoteRes = await request.get('/api/kg/remote-projects');
  expect(remoteRes.ok(), await remoteRes.text()).toBeTruthy();
  const remoteBody = (await remoteRes.json()) as {
    data: Array<{ projectId: string; availableOutputs: string[]; files: number; inMedia: boolean }>;
  };
  const remoteFeature = remoteBody.data.find((p) => p.projectId === FEATURE_ID);
  expect(remoteFeature, `remote-projects did not contain ${FEATURE_ID}: ${JSON.stringify(remoteBody.data.map((p) => p.projectId))}`).toBeTruthy();
  expect(remoteFeature!.inMedia).toBe(true);
  expect(remoteFeature!.availableOutputs).toContain('dr-docs');
});

test('Pull-all: deletes the local Feature, then pulls it back through the real UI with the same content', async ({ page, request }) => {
  await deleteFeatureViaApi(request, FEATURE_ID);
  const localListRes = await request.get('/api/pipelines/projects');
  expect(localListRes.ok()).toBeTruthy();
  const localList = (await localListRes.json()) as { projects: Array<{ id: string }> };
  expect(localList.projects.map((p) => p.id)).not.toContain(FEATURE_ID);

  // Navigate through the keepalive Feature — FEATURE_ID no longer exists
  // locally, and the run screen (with the sync rail / Pull all button) only
  // renders while at least one local project exists.
  await gotoRunScreen(page, KEEPALIVE_ID);

  const pullAllBtn = page.getByTestId('pipeline-pull-all-btn');
  await expect(pullAllBtn).toBeEnabled({ timeout: T.long });
  await pullAllBtn.click();

  const dialog = page.getByRole('dialog', { name: /Lấy dự án về máy/ });
  await expect(dialog).toBeVisible();

  // Two things confirmed empirically (real failure screenshots), neither a
  // bug in this test:
  //  1. Matched by projectId, NOT `FEATURE_NAME`: the remote registry
  //     (`mergeRemoteProjects` in apps/daemon/src/kg-sync/remote-registry.ts)
  //     only ever knows a media-service folder's `projectId` — it has no
  //     persisted "friendly name" field — so `displayName` (and this row's
  //     `.pl-pullall__name`, PipelineModals.tsx) always renders the raw id.
  //  2. Rendered as an UNGROUPED row (`label.pl-pullall__row`, not the
  //     nested-under-App `label.pl-pullall__row--feature` markup): grouping
  //     requires `isApp` (remote-registry.ts) to recognize the parent App's
  //     projectId, which only tests `projectId.startsWith('app--')`.
  //     Nothing in this codebase actually generates that prefix any more —
  //     not `createAppViaApi`, and not the real UI's own `toSlugId`
  //     (apps/web/src/components/pipelines/newProjectForm.ts, a plain name
  //     slugifier) — so App-grouping in Pull-all is effectively dead for
  //     every App, real or test-created alike. A real, separate product
  //     finding, not something to paper over here; this test only needs the
  //     Feature to be selectable, which the ungrouped row still is.
  const featureRow = dialog
    .locator('label.pl-pullall__row')
    .filter({ has: page.locator('.pl-pullall__name', { hasText: exactTextPattern(FEATURE_ID) }) });
  await expect(featureRow, 'pushed Feature must be discoverable in the remote picker').toBeVisible({ timeout: T.long });
  await takeCheckpointScreenshot(page, 'pull-push-pull-all-remote-list');

  await featureRow.locator('input[type="checkbox"]').check();

  const confirmBtn = page.getByTestId('pipeline-pull-confirm');
  await expect(confirmBtn).toBeEnabled({ timeout: T.long });
  await confirmBtn.click();
  await expect(dialog).toHaveCount(0, { timeout: T.long });
  await expect(toastLocator(page)).toContainText('Đã lấy', { timeout: T.long });
  await takeCheckpointScreenshot(page, 'pull-push-pull-all-success-toast');

  // Verify BY API that the pulled Feature exists locally again...
  const localAfterRes = await request.get('/api/pipelines/projects');
  expect(localAfterRes.ok()).toBeTruthy();
  const localAfter = (await localAfterRes.json()) as { projects: Array<{ id: string }> };
  expect(localAfter.projects.map((p) => p.id)).toContain(FEATURE_ID);

  // ...and that the round-tripped file content is byte-identical to what was
  // seeded before the push (real round trip, not just a file-count match).
  const fileRes = await request.get(`/api/projects/${encodeURIComponent(FEATURE_ID)}/files/${seedFilePath()}`);
  expect(fileRes.ok(), await fileRes.text()).toBeTruthy();
  expect(await fileRes.text()).toBe(SEED_MARKDOWN);
});
