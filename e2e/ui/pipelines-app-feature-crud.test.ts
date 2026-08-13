// Pipelines Studio — App/Feature CRUD, against the real daemon `webServer`
// this config boots (see playwright.config.ts). Self-contained: does not
// depend on any of the other Pipelines UI suites.
//
// Real UI copy is Vietnamese and the "App"/"Feature" domain concepts surface
// under different Vietnamese labels depending on the screen:
//   - NewAppModal / EditAppModal / PipelinesAppsView call an App a "dự án"
//     (title "Dự án mới" / "Thông tin dự án", button "Dự án mới").
//   - NewFeatureModal / EditFeatureModal / PipelinesFeaturesView call a
//     Feature a "tính năng" (title "Tính năng mới" / "Sửa tính năng", button
//     "Tính năng mới").
// data-testid values below were grepped directly from the component source
// (apps/web/src/components/pipelines/*.tsx) — see the report for the exact
// list.
import { expect, test } from '@playwright/test';
import type { Locator, Page, Response } from '@playwright/test';

import { applyStorageConfig, routeMockAgents, STORAGE_KEY } from '@/playwright/mock-factory';
import {
  createAppViaApi,
  createFeatureViaApi,
  deleteAppViaApi,
  deleteFeatureViaApi,
  takeCheckpointScreenshot,
} from '@/playwright/pipelines-fixtures';

// Mirrors `UNASSIGNED_APP` in apps/web/src/router.ts — the synthetic bucket
// id features with no parent App are grouped under. Not imported: e2e must
// not depend on the web app's private implementation (see e2e/AGENTS.md).
const UNASSIGNED_APP_ID = '__unassigned';
const UNASSIGNED_APP_LABEL = 'Chưa gán app';

// apps/web/src/App.tsx's mandatory FeedbackUsernameGate blocks all pointer
// interaction (renders a full-screen overlay) once onboarding is done and
// `config.feedbackUsername` is empty — with SSO auth off (the daemon's
// default) there is no session identity to fill it in silently. The shared
// `mock-factory.ts` fixture predates that gate and doesn't set one, so it is
// patched in locally below (both the localStorage seed and the
// `/api/app-config` fixture) instead of editing the shared helper — keeps
// this file fully self-contained per the task's "độc lập" requirement.
const FEEDBACK_USERNAME = 'Pipelines CRUD E2E';

let createdAppIds: string[] = [];
let createdFeatureIds: string[] = [];

test.beforeEach(async ({ page }) => {
  createdAppIds = [];
  createdFeatureIds = [];
  await applyStorageConfig(page);
  await page.addInitScript(
    ({ key, feedbackUsername }: { key: string; feedbackUsername: string }) => {
      const raw = window.localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      window.localStorage.setItem(key, JSON.stringify({ ...parsed, feedbackUsername }));
    },
    { key: STORAGE_KEY, feedbackUsername: FEEDBACK_USERNAME },
  );
  await routeMockAgents(page);
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
});

// Cases 5/6 already exercise the UI delete path for some of these ids —
// deleteAppViaApi/deleteFeatureViaApi are 404-safe (see pipelines-fixtures.ts
// docstrings), so calling them again here is a no-op. Any unexpected
// teardown error is swallowed (logged, not thrown) so it never masks a real
// assertion failure from the test body above it.
test.afterEach(async ({ request }) => {
  for (const featureId of createdFeatureIds) {
    await deleteFeatureViaApi(request, featureId).catch((err) => {
      console.warn(`[pipelines-app-feature-crud] teardown: failed to delete feature "${featureId}": ${String(err)}`);
    });
  }
  for (const appId of createdAppIds) {
    await deleteAppViaApi(request, appId).catch((err) => {
      console.warn(`[pipelines-app-feature-crud] teardown: failed to delete app "${appId}": ${String(err)}`);
    });
  }
});

test('creates an App through the real UI and it appears in the Apps list', async ({ page }) => {
  const stamp = Date.now();
  const appName = `CRUD Create App ${stamp}`;

  await gotoPipelinesApps(page);
  await takeCheckpointScreenshot(page, 'create-app-apps-list-before');

  await page.getByRole('button', { name: 'Dự án mới' }).first().click();
  const modal = page.getByRole('dialog', { name: 'Dự án mới' });
  await expect(modal).toBeVisible();
  await page.getByTestId('new-app-name').fill(appName);
  await takeCheckpointScreenshot(page, 'create-app-form-filled');

  const response = await submitAndWaitForResponse(page, '/api/pipelines/apps', 'POST', () =>
    page.getByTestId('new-app-submit').click(),
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const created = (await response.json()) as { id: string; name: string };
  createdAppIds.push(created.id);

  // NewAppModal's onCreated navigates straight into the new App's (empty)
  // Features screen — confirm that drill-down landed correctly before
  // checking the Apps list itself.
  await expect(page).toHaveURL(new RegExp(`/pipelines/app/${created.id}$`));
  await expect(page.getByRole('heading', { name: appName })).toBeVisible();
  await takeCheckpointScreenshot(page, 'create-app-drilldown-after-create');

  await gotoPipelinesApps(page);
  await expect(namedActionButton(page, appName)).toBeVisible();
  await takeCheckpointScreenshot(page, 'create-app-apps-list-after');
});

test('creates a Feature with no parent App through the real UI and it lands in "Chưa gán app"', async ({ page, request }) => {
  const stamp = Date.now();
  // The "Chưa gán app" bucket only appears in the Apps grid once at least one
  // Feature with no App actually exists (PipelinesAppsView / usePipelineNav
  // derive it from the Feature list, not from a fixed entry) — there is no
  // UI entry point to reach an empty bucket's Features screen. Seed exactly
  // one throwaway unassigned Feature via the API so the bucket becomes
  // navigable, then create the Feature under test through the real
  // NewFeatureModal form (its "Thuộc dự án" field is only editable/blankable
  // from inside that bucket's own Features screen — see NewFeatureModal.tsx
  // `appFromInput`).
  const seedId = `crud-seed-unassigned-${stamp}`;
  const seed = await createFeatureViaApi(request, { projectId: seedId, name: `CRUD seed unassigned ${stamp}` });
  createdFeatureIds.push(seed.id);

  const featureName = `CRUD Unassigned Feature ${stamp}`;

  await gotoPipelinesApps(page);
  const unassignedCard = namedActionButton(page, UNASSIGNED_APP_LABEL);
  await expect(unassignedCard).toBeVisible();
  await unassignedCard.click();
  await expect(page).toHaveURL(new RegExp(`/pipelines/app/${UNASSIGNED_APP_ID}$`));
  await takeCheckpointScreenshot(page, 'create-unassigned-feature-bucket-opened');

  await page.getByRole('button', { name: 'Tính năng mới' }).first().click();
  const modal = page.getByRole('dialog', { name: 'Tính năng mới' });
  await expect(modal).toBeVisible();
  await page.getByTestId('new-feature-name').fill(featureName);
  // Unlocked "Thuộc dự án (tuỳ chọn)" field only renders from this bucket —
  // confirm it is present and left blank before submitting.
  const appPicker = page.getByTestId('new-feature-app-picker');
  await expect(appPicker).toBeVisible();
  await expect(appPicker).toHaveValue('');
  await takeCheckpointScreenshot(page, 'create-unassigned-feature-form-filled');

  const response = await submitAndWaitForResponse(page, '/api/pipelines/projects', 'POST', () =>
    page.getByTestId('new-feature-submit').click(),
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const created = (await response.json()) as { id: string; name: string };
  createdFeatureIds.push(created.id);
  expect(response.request().postDataJSON()).not.toHaveProperty('appId');

  await page.goto(`/pipelines/app/${UNASSIGNED_APP_ID}`);
  await expect(namedActionButton(page, featureName)).toBeVisible();
  await takeCheckpointScreenshot(page, 'create-unassigned-feature-listed');
});

test('creates a Feature under an existing App through the real UI and it lands under that App', async ({ page, request }) => {
  const stamp = Date.now();
  const appId = `crud-parent-app-${stamp}`;
  const appName = `CRUD Parent App ${stamp}`;
  // Independent App via the API fixture (spec explicitly allows either
  // reusing case 1's App or a fresh one — a fresh one keeps this case
  // self-contained).
  const app = await createAppViaApi(request, { appId, name: appName });
  createdAppIds.push(app.id);

  const featureName = `CRUD Scoped Feature ${stamp}`;

  await page.goto(`/pipelines/app/${app.id}`);
  await expect(page.getByRole('heading', { name: appName })).toBeVisible();
  await takeCheckpointScreenshot(page, 'create-scoped-feature-app-opened');

  await page.getByRole('button', { name: 'Tính năng mới' }).first().click();
  const modal = page.getByRole('dialog', { name: 'Tính năng mới' });
  await expect(modal).toBeVisible();
  // Opened from inside a real App's Features screen — "Thuộc dự án" is
  // locked (read-only) to that App, per NewFeatureModal's `initialAppId`.
  await expect(page.getByRole('textbox', { name: 'Thuộc dự án' })).toHaveValue(appName);
  await page.getByTestId('new-feature-name').fill(featureName);
  await takeCheckpointScreenshot(page, 'create-scoped-feature-form-filled');

  const response = await submitAndWaitForResponse(page, '/api/pipelines/projects', 'POST', () =>
    page.getByTestId('new-feature-submit').click(),
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const created = (await response.json()) as { id: string; name: string };
  createdFeatureIds.push(created.id);
  expect(response.request().postDataJSON()).toMatchObject({ appId: app.id });

  await expect(page).toHaveURL(new RegExp(`/pipelines/app/${app.id}/${created.id}$`));
  await takeCheckpointScreenshot(page, 'create-scoped-feature-drilldown-after-create');

  await page.goto(`/pipelines/app/${app.id}`);
  await expect(namedActionButton(page, featureName)).toBeVisible();
  await takeCheckpointScreenshot(page, 'create-scoped-feature-listed-under-app');
});

test('updates an App name via EditAppModal and the new name shows in the Apps list', async ({ page, request }) => {
  const stamp = Date.now();
  const appId = `crud-rename-app-${stamp}`;
  // Deliberately NOT a suffix of one another — a substring relationship
  // would make "the old name is gone" unverifiable, since the new card's
  // accessible name would still contain the old name as a substring.
  const originalName = `CRUD App Before Rename ${stamp}`;
  const renamedName = `CRUD App After Rename ${stamp}`;
  const app = await createAppViaApi(request, { appId, name: originalName });
  createdAppIds.push(app.id);

  await gotoPipelinesApps(page);
  await expect(namedActionButton(page, originalName)).toBeVisible();
  await takeCheckpointScreenshot(page, 'update-app-before-rename');

  await page.getByRole('button', { name: `Thao tác với ${originalName}` }).click();
  await page.getByRole('menuitem', { name: 'Chỉnh sửa dự án' }).click();

  const modal = page.getByRole('dialog', { name: 'Thông tin dự án' });
  await expect(modal).toBeVisible();
  await expect(page.getByTestId('edit-app-name')).toHaveValue(originalName);
  await page.getByTestId('edit-app-name').fill(renamedName);
  await takeCheckpointScreenshot(page, 'update-app-form-filled');

  const response = await submitAndWaitForResponse(page, `/api/pipelines/apps/${appId}`, 'PATCH', () =>
    page.getByTestId('edit-app-submit').click(),
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  await expect(modal).toHaveCount(0);

  await expect(namedActionButton(page, renamedName)).toBeVisible();
  await expect(namedActionButton(page, originalName)).toHaveCount(0);
  await takeCheckpointScreenshot(page, 'update-app-after-rename');
});

test('deletes a Feature via ConfirmDeleteModal and it disappears from the Features list', async ({ page, request }) => {
  const stamp = Date.now();
  const appId = `crud-del-feature-app-${stamp}`;
  const appName = `CRUD Delete-Feature App ${stamp}`;
  const app = await createAppViaApi(request, { appId, name: appName });
  createdAppIds.push(app.id);
  const featureId = `crud-feature-to-delete-${stamp}`;
  const featureName = `CRUD Feature To Delete ${stamp}`;
  const feature = await createFeatureViaApi(request, {
    projectId: featureId,
    name: featureName,
    appId: app.id,
    appName: app.name,
  });
  createdFeatureIds.push(feature.id);

  await page.goto(`/pipelines/app/${app.id}`);
  await expect(namedActionButton(page, featureName)).toBeVisible();
  await takeCheckpointScreenshot(page, 'delete-feature-before');

  await page.getByRole('button', { name: `Thao tác với ${featureName}` }).click();
  await page.getByRole('menuitem', { name: 'Xóa' }).click();

  const modal = page.getByRole('dialog', { name: `Xóa tính năng "${featureName}"?` });
  await expect(modal).toBeVisible();
  await takeCheckpointScreenshot(page, 'delete-feature-confirm-open');

  const response = await submitAndWaitForResponse(page, `/api/projects/${featureId}`, 'DELETE', () =>
    page.getByTestId('confirm-delete-confirm').click(),
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  await expect(modal).toHaveCount(0);

  await expect(namedActionButton(page, featureName)).toHaveCount(0);
  await takeCheckpointScreenshot(page, 'delete-feature-after');

  const listed = await listPipelineProjectIds(page);
  expect(listed).not.toContain(featureId);
});

test('deletes an App with a child Feature via ConfirmDeleteModal and both disappear (cascade)', async ({ page, request }) => {
  const stamp = Date.now();
  const appId = `crud-cascade-app-${stamp}`;
  const appName = `CRUD Cascade App ${stamp}`;
  const app = await createAppViaApi(request, { appId, name: appName });
  createdAppIds.push(app.id);
  const featureId = `crud-cascade-feature-${stamp}`;
  const featureName = `CRUD Cascade Feature ${stamp}`;
  const feature = await createFeatureViaApi(request, {
    projectId: featureId,
    name: featureName,
    appId: app.id,
    appName: app.name,
  });
  createdFeatureIds.push(feature.id);

  await gotoPipelinesApps(page);
  await expect(namedActionButton(page, appName)).toBeVisible();
  await takeCheckpointScreenshot(page, 'delete-app-cascade-before');

  await page.getByRole('button', { name: `Thao tác với ${appName}` }).click();
  await page.getByRole('menuitem', { name: 'Xóa khỏi máy' }).click();

  const modal = page.getByRole('dialog', { name: `Xóa dự án "${appName}" khỏi máy?` });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('1 tính năng');
  await takeCheckpointScreenshot(page, 'delete-app-cascade-confirm-open');

  const response = await submitAndWaitForResponse(page, `/api/pipelines/apps/${appId}`, 'DELETE', () =>
    page.getByTestId('confirm-delete-confirm').click(),
  );
  expect(response.ok(), await response.text()).toBeTruthy();

  await expect(page).toHaveURL(/\/pipelines$/);
  await expect(namedActionButton(page, appName)).toHaveCount(0);
  await takeCheckpointScreenshot(page, 'delete-app-cascade-after');

  const appsResponse = await page.request.get('/api/pipelines/apps');
  expect(appsResponse.ok()).toBeTruthy();
  const appsBody = (await appsResponse.json()) as { apps: Array<{ id: string }> };
  expect(appsBody.apps.map((a) => a.id)).not.toContain(appId);

  const projectIds = await listPipelineProjectIds(page);
  expect(projectIds).not.toContain(featureId);
});

async function gotoPipelinesApps(page: Page) {
  await page.goto('/pipelines');
  await expect(page.getByRole('heading', { name: 'Quy trình tự động hóa' })).toBeVisible();
}

/** The App card (PipelinesAppsView) / Feature row (PipelinesFeaturesView)
 *  button whose accessible name is its own display name. Plain
 *  `getByRole('button', { name })` is ambiguous here: the same card/row also
 *  renders sibling pull/push/kebab/detail icon buttons whose own
 *  `aria-label` (e.g. "Thao tác với {name}", "Lấy Dự án {name} từ kho
 *  chung") embeds that same name as a substring. Those decorative buttons
 *  all set an explicit `aria-label`; the card/row itself does not (its name
 *  comes from its own text content) — filtering on that is what actually
 *  disambiguates. */
function namedActionButton(page: Page, name: string): Locator {
  return page.locator('button:not([aria-label])', { hasText: name });
}

async function submitAndWaitForResponse(
  page: Page,
  urlIncludes: string,
  method: string,
  submit: () => Promise<void>,
): Promise<Response> {
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes(urlIncludes) && res.request().method() === method),
    submit(),
  ]);
  return response;
}

async function listPipelineProjectIds(page: Page): Promise<string[]> {
  const response = await page.request.get('/api/pipelines/projects');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { projects: Array<{ id: string }> };
  return body.projects.map((p) => p.id);
}
