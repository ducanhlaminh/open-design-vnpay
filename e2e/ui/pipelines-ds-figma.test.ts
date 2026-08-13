// Figma design-system import flow — a self-contained UI suite covering:
//  1. importing a fresh Design System from an offline `.ir.json` fixture pair
//     through the REAL Settings → Design Systems UI (no Figma credentials —
//     this is the file-upload path, see `POST /api/design-systems/import/figma`
//     in apps/daemon/src/static-resource-routes.ts).
//  2. opening the react-bundle preview (`FigmaDesignSystemDetailModal` /
//     `FigmaDsPreviewTabs`) for the imported system.
//  3. assigning the imported system to a brand-new App through the
//     `ProjectDesignSystemPicker` embedded in `EditAppModal`.
//
// Each `test()` performs its own UI import so the three cases stay order-
// independent (matches the no-shared-state convention already used by
// e2e/ui/project-management-flows.test.ts). Case 3 seeds its Design System
// through the faster `importFigmaIrFixture` HTTP fixture instead of driving
// the upload form a third time — its own scope is the App/DS-picker wiring,
// which cases 1 and 2 do not touch.
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import {
  createAppViaApi,
  daemonBaseUrl,
  defaultFigmaIrFixtureFiles,
  deleteAppViaApi,
  importFigmaIrFixture,
  takeCheckpointScreenshot,
} from '@/playwright/pipelines-fixtures';
import { T } from '@/timeouts';

const STORAGE_KEY = 'open-design:config';
const OPEN_SETTINGS_LABEL = /Open settings|打开设置|開啟設定/i;

test.describe.configure({ timeout: T.xlong });

// Tracks the resources the CURRENT test created so `afterEach` can clean them
// up regardless of pass/fail. Reset at both ends of the test lifecycle so a
// hook failure on one attempt can never leak into the next.
let importedDesignSystemId: string | null = null;
let createdAppId: string | null = null;

test.beforeEach(async ({ page }) => {
  importedDesignSystemId = null;
  createdAppId = null;

  await page.addInitScript((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        mode: 'daemon',
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        agentId: 'mock',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: {},
        privacyDecisionAt: 1,
        // Mandatory first-use gate (`FeedbackUsernameGate.tsx`, wired in
        // App.tsx) blocks the whole app until `feedbackUsername` is set,
        // unless a Google SSO session already supplies a name — pre-seed it
        // so the gate never covers the UI under test.
        feedbackUsername: 'E2E Agent',
        telemetry: { metrics: false, content: false, artifactManifest: false },
      }),
    );
  }, STORAGE_KEY);

  // Real daemon backs this whole suite (design-system + pipeline-app routes
  // hit the actual daemon — see playwright.config.ts's `webServer`). Only the
  // onboarding bootstrap routes are mocked so a fresh e2e data dir never
  // forces the onboarding wizard or depends on a real agent CLI being
  // installed on the test machine.
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
          feedbackUsername: 'E2E Agent',
          telemetry: { metrics: false, content: false, artifactManifest: false },
        },
      },
    });
  });

  await page.route('**/api/agents', async (route) => {
    await route.fulfill({
      json: {
        agents: [
          {
            id: 'mock',
            name: 'Mock Agent',
            bin: 'mock-agent',
            available: true,
            version: 'test',
            models: [{ id: 'default', label: 'Default' }],
          },
        ],
      },
    });
  });
});

test.afterEach(async ({ request }) => {
  if (createdAppId) {
    await deleteAppViaApi(request, createdAppId);
    createdAppId = null;
  }
  if (importedDesignSystemId) {
    await deleteDesignSystemViaApi(request, importedDesignSystemId);
    importedDesignSystemId = null;
  }
});

test('imports a new design system from a Figma IR fixture through the UI with no errors', async ({ page }) => {
  await gotoEntryHome(page);

  const dialog = await test.step('open Settings → Design Systems', () => openDesignSystemsSettingsTab(page));
  await takeCheckpointScreenshot(page, 'pipelines-ds-figma-settings-tab');

  const imported = await test.step('import the Figma IR fixture pair via the real upload form', () =>
    importFigmaFixtureViaUi(page, dialog));
  importedDesignSystemId = imported.id;

  await test.step('verify the import surfaced no error and the system now lists', async () => {
    await expect(dialog.locator('.library-install-error')).toHaveCount(0);
    await expect(dialog.getByText(`Imported ${imported.title}`)).toBeVisible();
    // This fork ships a large bundled catalog (100+ built-in design systems),
    // so `fetchDesignSystems()`'s re-render after import can outrun the
    // default 10s expect timeout — give the card a generous one instead.
    await expect(designSystemCard(dialog, imported.title)).toBeVisible({ timeout: T.xlong });
  });

  await takeCheckpointScreenshot(page, 'pipelines-ds-figma-imported');
});

test('opens the imported design system preview and renders the react-bundle detail tabs', async ({ page }) => {
  await gotoEntryHome(page);

  const dialog = await openDesignSystemsSettingsTab(page);
  const imported = await importFigmaFixtureViaUi(page, dialog);
  importedDesignSystemId = imported.id;

  const preview = await test.step('open the imported design system preview', async () => {
    // Same large-catalog re-render latency as case 1 above.
    await expect(designSystemCard(dialog, imported.title)).toBeVisible({ timeout: T.xlong });
    await designSystemCard(dialog, imported.title).locator('.library-ds-card-content').click();
    const modal = page.getByRole('dialog', { name: `${imported.title} preview` });
    await expect(modal).toBeVisible();
    return modal;
  });

  await test.step('showcase tab renders the compiled react bundle iframe', async () => {
    await expect(preview.getByRole('tab', { name: 'Showcase' })).toHaveAttribute('aria-selected', 'true');
    await expect(preview.locator('.figma-ds-showcase-frame')).toBeVisible();
  });
  await takeCheckpointScreenshot(page, 'pipelines-ds-figma-preview-showcase');

  await test.step('components tab renders (no catalog generated yet for this fixture)', async () => {
    await preview.getByRole('tab', { name: 'Thành phần' }).click();
    await expect(preview.getByRole('tab', { name: 'Thành phần' })).toHaveAttribute('aria-selected', 'true');
    await expect(preview.getByText('Chưa có danh mục thành phần')).toBeVisible();
  });
  await takeCheckpointScreenshot(page, 'pipelines-ds-figma-preview-components');

  await test.step('rules tab renders (no rules generated yet for this fixture)', async () => {
    await preview.getByRole('tab', { name: 'Nguyên tắc' }).click();
    await expect(preview.getByRole('tab', { name: 'Nguyên tắc' })).toHaveAttribute('aria-selected', 'true');
    await expect(preview.getByText('Chưa có nguyên tắc thiết kế')).toBeVisible();
  });
  await takeCheckpointScreenshot(page, 'pipelines-ds-figma-preview-rules');

  await preview.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(preview).toHaveCount(0);
});

test('assigns the imported design system to a new App via the Edit Project design-system picker', async ({
  page,
  request,
}) => {
  // Setup for THIS case's own concern (App ↔ DS wiring) uses the fast HTTP
  // fixture — cases 1/2 above already cover the upload-form UI path itself.
  const imported = await importFigmaIrFixture(request);
  importedDesignSystemId = imported.designSystem.id;
  // Every freshly-imported user design system starts life as `status:
  // 'draft'` (apps/daemon/src/design-systems.ts `listAllDesignSystems`'s
  // `defaultStatus: 'draft'` — true for Figma/local/GitHub imports alike,
  // not something the import route itself sets). `ProjectDesignSystemPicker`
  // is fed `(systems ?? []).filter((s) => s.status !== 'draft')` in both
  // EditAppModal.tsx and NewAppModal.tsx, so a draft system is legitimately
  // invisible to the picker until published — mirror the real "publish"
  // affordance (`DesignSystemsTab.tsx`'s Xuất bản button) via its own PATCH.
  await publishDesignSystemViaApi(request, imported.designSystem.id);

  const appId = `e2e-ds-figma-${Date.now()}`;
  const appName = `E2E DS Figma App ${Date.now()}`;
  const app = await createAppViaApi(request, { appId, name: appName });
  createdAppId = app.id;
  expect(app.designSystemId).toBeNull();

  await gotoEntryHome(page);

  await test.step('open the App in the Pipelines Apps grid and pick "Chỉnh sửa dự án"', async () => {
    await page.getByTestId('entry-nav-pipelines').click();
    await expect(page).toHaveURL(/\/pipelines$/);
    await expect(page.getByRole('button', { name: appName }).first()).toBeVisible();
    await page.getByRole('button', { name: `Thao tác với ${appName}` }).click();
    await page.getByRole('menuitem', { name: 'Chỉnh sửa dự án' }).click();
  });

  const editDialog = page.getByRole('dialog', { name: 'Thông tin dự án' });
  await expect(editDialog).toBeVisible();
  await takeCheckpointScreenshot(page, 'pipelines-ds-figma-edit-app-opened');

  await test.step('pick the imported design system in the picker and save', async () => {
    await editDialog.getByTestId('project-ds-picker-search').fill(imported.designSystem.title);
    const option = editDialog.getByTestId(`project-ds-picker-option-${imported.designSystem.id}`);
    // Same large-catalog fetch latency as cases 1/2: EditAppModal's own
    // `fetchDesignSystems()` re-renders the (100+ system) list once it
    // resolves, well past the default 10s expect timeout in this fork.
    await expect(option).toBeVisible({ timeout: T.xlong });
    await option.click();

    const submit = editDialog.getByTestId('edit-app-submit');
    await expect(submit).toBeEnabled();
    const [patchResponse] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes(`/api/pipelines/apps/${appId}`) && res.request().method() === 'PATCH',
      ),
      submit.click(),
    ]);
    expect(patchResponse.ok()).toBe(true);
    const patchJson = (await patchResponse.json()) as { designSystemId: string | null };
    expect(patchJson.designSystemId).toBe(imported.designSystem.id);
  });

  await expect(editDialog).toHaveCount(0);
  await takeCheckpointScreenshot(page, 'pipelines-ds-figma-app-assigned');

  await test.step('confirm the assignment persisted server-side', async () => {
    const appsResponse = await request.get(`${daemonBaseUrl()}/api/pipelines/apps`);
    expect(appsResponse.ok()).toBeTruthy();
    const appsJson = (await appsResponse.json()) as {
      apps: Array<{ id: string; designSystemId: string | null }>;
    };
    const found = appsJson.apps.find((a) => a.id === appId);
    expect(found?.designSystemId).toBe(imported.designSystem.id);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForLoadingToClear(page: Page) {
  await expect(page.getByText('Loading Open Design…')).toHaveCount(0, { timeout: T.medium });
}

async function gotoEntryHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve Open Design' });
  if (await privacyDialog.isVisible().catch(() => false)) {
    await privacyDialog.getByRole('button', { name: /not now/i }).click();
    await expect(privacyDialog).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: OPEN_SETTINGS_LABEL })).toBeVisible();
}

/** Opens the Settings dialog and switches to the Design Systems section
 *  (`apps/web/src/components/DesignSystemsSection.tsx`, mounted via
 *  `SettingsDialog.tsx`'s `activeSection === 'designSystems'` branch). */
async function openDesignSystemsSettingsTab(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: OPEN_SETTINGS_LABEL }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Design Systems' }).click();
  await expect(dialog.locator('.settings-design-systems')).toBeVisible();
  return dialog;
}

/** Expands the "Add design system" accordion if it is not already open — the
 *  file input and submit button sit inside it and are not actionable while
 *  collapsed (0-height accordion, see the shared `.accordion-collapsible`
 *  pattern in AGENTS.md's "UI animation philosophy"). */
async function openDsImportPanel(dialog: Locator): Promise<void> {
  const toggle = dialog.getByRole('button', { name: 'Add design system' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(dialog.locator('.library-add-panel.open')).toBeVisible();
}

/** Drives the REAL upload form: picks the default two-file IR fixture pair
 *  (`e2e/lib/playwright/figma-ir-fixture.ts`) via `setInputFiles` and submits
 *  it, capturing the daemon's own response instead of guessing the generated
 *  id/title (the route derives both server-side — see
 *  `ImportFigmaIrOptions.name`'s docstring in pipelines-fixtures.ts). */
async function importFigmaFixtureViaUi(
  page: Page,
  dialog: Locator,
): Promise<{ id: string; title: string }> {
  await openDsImportPanel(dialog);

  const fileInput = dialog.getByTestId('settings-design-systems-import-figma-file');
  const fixtureFiles = defaultFigmaIrFixtureFiles();
  await fileInput.setInputFiles(
    fixtureFiles.map((file) => ({
      name: file.filename,
      mimeType: 'application/json',
      buffer: Buffer.from(file.content, 'utf8'),
    })),
  );

  const submit = dialog.getByTestId('settings-design-systems-import-submit');
  await expect(submit).toBeEnabled();

  const [importResponse] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes('/api/design-systems/import/figma') && res.request().method() === 'POST',
    ),
    submit.click(),
  ]);
  expect(importResponse.ok()).toBe(true);
  const importJson = (await importResponse.json()) as { designSystem: { id: string; title: string } };
  return { id: importJson.designSystem.id, title: importJson.designSystem.title };
}

// Deliberately NOT `dialog.locator('.library-ds-card', { has: dialog.locator(...) })`:
// that nested-`has` construct returns 0 matches here (confirmed empirically —
// `.library-ds-card` count and `.library-ds-title-text` count are both
// non-zero, and a plain `.filter({ hasText })` on the same root finds the
// card, but the nested-locator `has` option does not) when the outer
// locator's root is itself a `getByRole('dialog')` chain. `.filter({
// hasText })` matching the card's own accumulated text content (title +
// summary) is simpler and proven to work against this exact DOM.
function designSystemCard(dialog: Locator, title: string): Locator {
  return dialog.locator('.library-ds-card').filter({ hasText: title });
}

/** `PATCH /api/design-systems/:id` with `{ status: 'published' }` —
 *  metadata-only fast path in `updateUserDesignSystem` (apps/daemon/src/
 *  design-systems.ts), same effect as `DesignSystemsTab.tsx`'s "Xuất bản"
 *  toggle. Not gated by `requireLocalOrigin`, but calling the daemon
 *  directly keeps this file's daemon-facing calls on one transport. */
async function publishDesignSystemViaApi(request: APIRequestContext, id: string): Promise<void> {
  const response = await request.patch(`${daemonBaseUrl()}/api/design-systems/${encodeURIComponent(id)}`, {
    data: { status: 'published' },
  });
  if (!response.ok()) {
    throw new Error(
      `publishDesignSystemViaApi failed: HTTP ${response.status()} ${(await response.text()).slice(0, 500)}`,
    );
  }
}

/** `DELETE /api/design-systems/:id` (apps/daemon/src/server.ts) — figma
 *  imports get a `user:<dir>` id; that DELETE falls through
 *  static-resource-routes.ts's `requireLocalOrigin`-gated handler (which
 *  `next()`s for `user:`-prefixed ids) into server.ts's own handler. Hitting
 *  the daemon's own port directly avoids the same dev-proxy Host-header
 *  ambiguity `pipelines-fixtures.ts` documents for the import route. */
async function deleteDesignSystemViaApi(request: APIRequestContext, id: string): Promise<void> {
  const response = await request.delete(`${daemonBaseUrl()}/api/design-systems/${encodeURIComponent(id)}`);
  if (!response.ok() && response.status() !== 404) {
    throw new Error(
      `deleteDesignSystemViaApi failed: HTTP ${response.status()} ${(await response.text()).slice(0, 500)}`,
    );
  }
}
