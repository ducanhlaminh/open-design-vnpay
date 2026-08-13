// Pipelines Studio — end-to-end SMOKE test through the whole golden path,
// against the real daemon `webServer` this config boots (see
// playwright.config.ts): App → Design System (Figma import + bind) →
// Feature → docs-review workflow run → Push-all to the remote store.
//
// This is the 5th and final spec in a batch of five. Its job is different
// from its four siblings below — it does NOT exhaustively cover edge cases
// (that is their job); it only needs to prove the full pipe works together,
// front to back, in ONE LINEAR pass:
//   pipelines-ds-figma.test.ts           — DS import/publish/bind edge cases
//   pipelines-app-feature-crud.test.ts   — App/Feature CRUD edge cases
//   pipelines-docs-review-run.test.ts    — docs-review workflow edge cases
//   pipelines-pull-push.test.ts          — pull/push round-trip edge cases
//
// Self-contained per e2e/AGENTS.md ("no borrowing another suite's private
// implementation as a shared helper"): every mechanism this file needs (fake
// "codex" CLI, machine-identity seeding, InfraSetupGate/FeedbackUsernameGate
// local patches) is copied/adapted locally from the four files above rather
// than imported from them — only the shared `e2e/lib/playwright/*` fixtures
// are imported.
//
// Machine-identity / Push-all POLICY EXCEPTION: same one pipelines-pull-push
// .test.ts documents in its own header — push genuinely round-trips against
// the real media-service, gated on this machine's own already-established
// Google login being reusable (`seedMachineIdentity()` below). If that
// session is not available, ONLY the push phase (phase 5) is skipped via
// `test.skip()` — phases 1-4 (App → Design System → Feature → docs-review)
// still run and still assert the real UI/daemon end to end.
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Locator, Page, Response } from '@playwright/test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { STORAGE_KEY } from '@/playwright/mock-factory';
import {
  daemonBaseUrl,
  defaultFigmaIrFixtureFiles,
  deleteAppViaApi,
  deleteFeatureViaApi,
  deleteRemoteProjectViaApi,
  repoRoot,
  resolveOdDataDir,
  takeCheckpointScreenshot,
} from '@/playwright/pipelines-fixtures';
import { T } from '@/timeouts';

// Same locale ambiguity pipelines-ds-figma.test.ts's own OPEN_SETTINGS_LABEL
// documents — the shared entry chrome renders through the i18n catalog
// (unlike most Pipelines-specific copy, which is hardcoded Vietnamese), and
// this suite's sandbox has been observed to resolve any of these three.
const OPEN_SETTINGS_LABEL = /Open settings|打开设置|開啟設定/i;
const FEEDBACK_USERNAME = 'Pipelines Happy-Path E2E';

// Stage row labels — `PipelineDef.name` in apps/daemon/src/pipelines.ts. See
// pipelines-docs-review-run.test.ts's header comment for the full
// docs-review stage/gating writeup (fan-out validation per stage, the
// 2026-08 docs-only active-gate correction) this file's phase 4 mirrors.
const STAGE_NAME = {
  'dr-docs': 'Tài liệu (nạp)',
  'dr-comp': 'Màn hình → Component',
  'dr-flow': 'Sơ đồ luồng màn hình',
  'dr-review': 'Review tài liệu',
} as const;
const WORKFLOW_CARD_LABEL = 'Rà soát chất lượng tài liệu';
const STAGE_POLL_TIMEOUT = T.xlong;

// Minimal single-section doc (well under the 120-non-blank-line
// `splitSections` merge threshold in apps/daemon/src/docs-review.ts) — one
// dr-comp page turn, one dr-review section turn, matching
// pipelines-docs-review-run.test.ts's own fixture doc.
const INGEST_DOC_NAME = 'login-spec.md';
const INGEST_DOC_CONTENT = `# Đặc tả màn hình đăng nhập

Tài liệu đặc tả tối giản dùng để kiểm thử luồng smoke test đầu-cuối của
Pipelines Studio (App → Design System → Feature → docs-review → Push).

## Mục tiêu

Người dùng nhập email và mật khẩu để đăng nhập vào hệ thống.

## Nội dung

- Trường nhập email.
- Trường nhập mật khẩu.
- Nút "Đăng nhập".
`;

interface StageRow {
  id: string;
  status: string;
  active: boolean;
}

let fakeCodex: { bin: string; env: Record<string, string> };
let identityReady = false;
let identitySkipReason = '';

// Tracked so `afterAll` can tear down exactly what this run created,
// regardless of how far the test got (including a mid-test `test.skip()`
// for phase 5 — hooks still run after a skip).
let createdAppId: string | null = null;
let createdFeatureId: string | null = null;
let importedDesignSystemId: string | null = null;

test.beforeAll(async () => {
  fakeCodex = await createFakeCodexAgent();
  await seedMachineIdentity();
});

test.beforeEach(async ({ page }) => {
  // FeedbackUsernameGate (apps/web/src/App.tsx) blocks all pointer
  // interaction until `feedbackUsername` is set. `privacyDecisionAt` is
  // seeded too (both localStorage AND the real daemon PUT further below) so
  // the "Help us improve Open Design" privacy banner never renders —
  // pipelines-docs-review-run.test.ts's own local seed omits this field (its
  // test never touches the top-level Apps grid this file's App/Feature
  // creation phases need), but pipelines-ds-figma.test.ts and
  // pipelines-app-feature-crud.test.ts both set it. This file needs BOTH
  // docs-review's "don't mock GET /api/app-config" behavior (so the fake
  // codex agent config actually sticks — see below) AND that field, so it is
  // seeded from both ends instead of mocked away.
  await page.addInitScript(
    ({ key, agentEnv, feedbackUsername }: { key: string; agentEnv: Record<string, string>; feedbackUsername: string }) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          mode: 'daemon',
          apiKey: '',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-5',
          agentId: 'codex',
          skillId: null,
          designSystemId: null,
          onboardingCompleted: true,
          agentModels: { codex: { model: 'default', reasoning: 'default' } },
          agentCliEnv: { codex: agentEnv },
          feedbackUsername,
          privacyDecisionAt: 1,
          telemetry: { metrics: false, content: false, artifactManifest: false },
        }),
      );
    },
    { key: STORAGE_KEY, agentEnv: fakeCodex.env, feedbackUsername: FEEDBACK_USERNAME },
  );

  // InfraSetupGate.tsx (host mode) blocks all pointer interaction until it
  // sees a `claude`-id entry in GET /api/agents with `authStatus: 'ok'` —
  // independent of whichever agent this suite actually runs stages with
  // (codex). Identical shape to the local overrides in both
  // pipelines-docs-review-run.test.ts and pipelines-pull-push.test.ts; this
  // suite's run is the longest of the five (all phases in one test), so it
  // reliably trips the gate's poll without this.
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

  // Deliberately do NOT mock GET /api/app-config — see
  // pipelines-docs-review-run.test.ts's header comment for the full why: a
  // mocked GET pinned to a different agentId would make the boot-time config
  // resync (`syncConfigToDaemon`) clobber the real fake-codex config phase 4
  // needs to actually run dr-comp/dr-flow/dr-review.
  await mockSyncReady(page);
  await configureFakeCodexAgent(page);
});

test.afterAll(async ({ request }) => {
  await request
    .put('/api/app-config', {
      data: {
        onboardingCompleted: true,
        agentId: 'mock',
        agentModels: {},
        agentCliEnv: {},
        skillId: null,
        designSystemId: null,
      },
    })
    .catch((err) => {
      console.warn(`[pipelines-happy-path] teardown: failed to reset app-config: ${String(err)}`);
    });

  // Remote first (media-service): pushing a Feature also syncs its parent
  // App's context/docs pool under the App's own id (`uploadProjectFiles` in
  // apps/daemon/src/server.ts) — see pipelines-pull-push.test.ts's header
  // comment. Best-effort: when phase 5 skipped (no machine identity), no
  // remote residue was ever created, so a 404 here is expected and fine.
  if (createdFeatureId) {
    await deleteRemoteProjectViaApi(request, createdFeatureId).catch((err) => {
      console.warn(`[pipelines-happy-path] teardown: failed to delete remote feature "${createdFeatureId}": ${String(err)}`);
    });
  }
  if (createdAppId) {
    await deleteRemoteProjectViaApi(request, createdAppId).catch((err) => {
      console.warn(`[pipelines-happy-path] teardown: failed to delete remote app "${createdAppId}": ${String(err)}`);
    });
  }

  if (createdFeatureId) {
    await deleteFeatureViaApi(request, createdFeatureId).catch((err) => {
      console.warn(`[pipelines-happy-path] teardown: failed to delete local feature "${createdFeatureId}": ${String(err)}`);
    });
  }
  if (createdAppId) {
    await deleteAppViaApi(request, createdAppId).catch((err) => {
      console.warn(`[pipelines-happy-path] teardown: failed to delete local app "${createdAppId}": ${String(err)}`);
    });
  }
  if (importedDesignSystemId) {
    await deleteDesignSystemViaApi(request, importedDesignSystemId).catch((err) => {
      console.warn(`[pipelines-happy-path] teardown: failed to delete design system "${importedDesignSystemId}": ${String(err)}`);
    });
  }

  // Hard verify: no residue left on the remote store — same shape of
  // assertion pipelines-pull-push.test.ts's own afterAll ends on.
  if (createdFeatureId || createdAppId) {
    const res = await request.get('/api/kg/remote-projects');
    expect(res.ok(), await res.text()).toBeTruthy();
    const body = (await res.json()) as { data: Array<{ projectId: string }> };
    const remainingIds = body.data.map((p) => p.projectId);
    if (createdFeatureId) {
      expect(remainingIds, `remote-projects after teardown: ${JSON.stringify(remainingIds)}`).not.toContain(createdFeatureId);
    }
    if (createdAppId) {
      expect(remainingIds, `remote-projects after teardown: ${JSON.stringify(remainingIds)}`).not.toContain(createdAppId);
    }
  }
});

test('walks the full Pipelines Studio golden path: App → Design System → Feature → docs-review → Push', async ({ page, request }) => {
  test.setTimeout(300_000);

  const stamp = Date.now();
  const appName = `E2E Happy Path App ${stamp}`;
  const featureName = `E2E Happy Path Feature ${stamp}`;

  await gotoPipelinesApps(page);

  // ── Phase 1: create the App through the real UI (NewAppModal). ──────────
  let appId = '';
  await test.step('phase 1: create the App via the real UI', async () => {
    await page.getByRole('button', { name: 'Dự án mới' }).first().click();
    const modal = page.getByRole('dialog', { name: 'Dự án mới' });
    await expect(modal).toBeVisible();
    await page.getByTestId('new-app-name').fill(appName);
    await takeCheckpointScreenshot(page, 'happy-path-01-app-form-filled');

    const response = await submitAndWaitForResponse(page, '/api/pipelines/apps', 'POST', () =>
      page.getByTestId('new-app-submit').click(),
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    const created = (await response.json()) as { id: string; name: string };
    appId = created.id;
    createdAppId = appId;

    await expect(page).toHaveURL(new RegExp(`/pipelines/app/${appId}$`));
    await expect(page.getByRole('heading', { name: appName })).toBeVisible();
    await takeCheckpointScreenshot(page, 'happy-path-02-app-created');
  });

  // ── Phase 2: import a Design System from a Figma IR fixture pair via the
  // real Settings → Design Systems upload form, publish it (fresh imports
  // default to `status: 'draft'` — ProjectDesignSystemPicker filters those
  // out), then bind it to the App via EditAppModal's picker. ──────────────
  let designSystemId = '';
  await test.step('phase 2: import + publish + bind a Design System', async () => {
    const settingsDialog = await openDesignSystemsSettingsTab(page);
    await takeCheckpointScreenshot(page, 'happy-path-03-settings-ds-tab');

    const imported = await importFigmaFixtureViaUi(page, settingsDialog);
    designSystemId = imported.id;
    importedDesignSystemId = designSystemId;
    await expect(settingsDialog.locator('.library-install-error')).toHaveCount(0);
    await takeCheckpointScreenshot(page, 'happy-path-04-ds-imported');

    await closeSettingsDialog(settingsDialog);
    await publishDesignSystemViaApi(request, designSystemId);

    await gotoPipelinesApps(page);
    await expect(namedActionButton(page, appName)).toBeVisible();
    await page.getByRole('button', { name: `Thao tác với ${appName}` }).click();
    await page.getByRole('menuitem', { name: 'Chỉnh sửa dự án' }).click();

    const editDialog = page.getByRole('dialog', { name: 'Thông tin dự án' });
    await expect(editDialog).toBeVisible();
    await takeCheckpointScreenshot(page, 'happy-path-05-edit-app-opened');

    await editDialog.getByTestId('project-ds-picker-search').fill(imported.title);
    const option = editDialog.getByTestId(`project-ds-picker-option-${designSystemId}`);
    // Large bundled catalog (100+ built-in design systems) — EditAppModal's
    // own `fetchDesignSystems()` re-render can outrun the default 10s expect
    // timeout, same as pipelines-ds-figma.test.ts's equivalent step.
    await expect(option).toBeVisible({ timeout: T.xlong });
    await option.click();

    const submit = editDialog.getByTestId('edit-app-submit');
    await expect(submit).toBeEnabled();
    const [patchResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes(`/api/pipelines/apps/${appId}`) && res.request().method() === 'PATCH',
      ),
      submit.click(),
    ]);
    expect(patchResponse.ok(), await patchResponse.text()).toBeTruthy();
    const patchJson = (await patchResponse.json()) as { designSystemId: string | null };
    expect(patchJson.designSystemId).toBe(designSystemId);
    await expect(editDialog).toHaveCount(0);
    await takeCheckpointScreenshot(page, 'happy-path-06-ds-bound');
  });

  // ── Phase 3: create a Feature under the App through the real UI
  // (NewFeatureModal). ─────────────────────────────────────────────────────
  let featureId = '';
  await test.step('phase 3: create the Feature via the real UI', async () => {
    await page.goto(`/pipelines/app/${appId}`);
    await expect(page.getByRole('heading', { name: appName })).toBeVisible();

    await page.getByRole('button', { name: 'Tính năng mới' }).first().click();
    const modal = page.getByRole('dialog', { name: 'Tính năng mới' });
    await expect(modal).toBeVisible();
    // Opened from inside the App's own Features screen — "Thuộc dự án" is
    // locked (read-only) to that App, per NewFeatureModal's `initialAppId`.
    await expect(page.getByRole('textbox', { name: 'Thuộc dự án' })).toHaveValue(appName);
    await page.getByTestId('new-feature-name').fill(featureName);
    await takeCheckpointScreenshot(page, 'happy-path-07-feature-form-filled');

    const response = await submitAndWaitForResponse(page, '/api/pipelines/projects', 'POST', () =>
      page.getByTestId('new-feature-submit').click(),
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    const created = (await response.json()) as { id: string; name: string };
    featureId = created.id;
    createdFeatureId = featureId;

    await expect(page).toHaveURL(new RegExp(`/pipelines/app/${appId}/${featureId}$`));
    await takeCheckpointScreenshot(page, 'happy-path-08-feature-created');
  });

  // ── Phase 4: run the docs-review workflow to completion — ingest → run
  // dr-comp + dr-flow → run dr-review → confirm. Same fake-codex mechanism
  // as pipelines-docs-review-run.test.ts (see below), just the subset of
  // that file's 7 cases needed to prove the workflow completes end to end. ──
  await test.step('phase 4: run the docs-review workflow to completion', async () => {
    const card = page.locator('[class*="pipelineCard"]').filter({ hasText: WORKFLOW_CARD_LABEL }).first();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /^(Bắt đầu|Mở)$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/pipelines/app/${appId}/${featureId}/docs-review$`));
    await expect(page.getByTestId('pipelines-view')).toBeVisible();
    await takeCheckpointScreenshot(page, 'happy-path-09-docs-review-opened');

    await uploadIngestDoc(page);
    await waitForStatus(page, featureId, 'dr-docs', 'succeeded', STAGE_POLL_TIMEOUT);
    await takeCheckpointScreenshot(page, 'happy-path-10-dr-docs-succeeded');

    await clickRunStage(page, 'dr-comp');
    await clickRunStage(page, 'dr-flow');
    await waitForAllStatus(page, featureId, ['dr-comp', 'dr-flow'], 'succeeded', STAGE_POLL_TIMEOUT);
    await takeCheckpointScreenshot(page, 'happy-path-11-dr-comp-dr-flow-succeeded');

    await clickRunStage(page, 'dr-review');
    await waitForStatus(page, featureId, 'dr-review', 'succeeded', STAGE_POLL_TIMEOUT);
    await takeCheckpointScreenshot(page, 'happy-path-12-dr-review-succeeded');

    const confirmButton = page.getByTestId('pipeline-docs-review-confirm');
    await expect(confirmButton).toBeEnabled({ timeout: STAGE_POLL_TIMEOUT });
    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes(`/api/projects/${featureId}/docs-review/confirm`) &&
          res.request().method() === 'POST',
      ),
      confirmButton.click(),
    ]);
    await expect(page.getByText('Đã xác nhận hoàn tất và gửi số liệu review.')).toBeVisible();
    await takeCheckpointScreenshot(page, 'happy-path-13-docs-review-confirmed');
  });

  // ── Phase 5: push the Feature to the remote store via Push-all and
  // confirm it landed (GET /api/kg/remote-projects). Skips (not fails) when
  // no machine Google session is available to reuse — see
  // seedMachineIdentity() below, mirroring pipelines-pull-push.test.ts's own
  // skip pattern. Placed AFTER phases 1-4 (not in beforeEach) so only this
  // phase is conditional; the rest of the golden path always runs. ────────
  test.skip(!identityReady, identitySkipReason);

  await test.step('phase 5: push the Feature to the remote store', async () => {
    const pushAllBtn = page.getByTestId('pipeline-push-all-btn');
    await expect(pushAllBtn).toBeEnabled({ timeout: T.long });
    await pushAllBtn.click();

    const dialog = page.getByRole('dialog', { name: /Chia sẻ kết quả/ });
    await expect(dialog).toBeVisible();
    await page.getByRole('checkbox', { name: `Chọn Feature ${featureName}` }).check();

    const confirmBtn = page.getByTestId('pipeline-push-confirm');
    await expect(confirmBtn).toBeEnabled({ timeout: T.long });
    await takeCheckpointScreenshot(page, 'happy-path-14-push-all-selected');

    await confirmBtn.click();
    await expect(dialog).toHaveCount(0, { timeout: T.long });
    const pushToast = page.locator('.od-toast');
    await expect(pushToast).toContainText('Đã chia sẻ', { timeout: T.long });
    // A clean push must carry no per-project caveat (e.g. an unusable
    // machine identity session) — fail with the real reason instead of a
    // generic timeout further down if one shows up.
    await expect(pushToast, 'push-all toast reported a caveat instead of a clean success').not.toContainText('Chưa thể chia sẻ');
    await takeCheckpointScreenshot(page, 'happy-path-15-push-all-success-toast');

    // Verify BY API, not just by trusting the UI toast.
    const remoteRes = await request.get('/api/kg/remote-projects');
    expect(remoteRes.ok(), await remoteRes.text()).toBeTruthy();
    const remoteBody = (await remoteRes.json()) as {
      data: Array<{ projectId: string; availableOutputs: string[]; inMedia: boolean }>;
    };
    const remoteFeature = remoteBody.data.find((p) => p.projectId === featureId);
    expect(
      remoteFeature,
      `remote-projects did not contain ${featureId}: ${JSON.stringify(remoteBody.data.map((p) => p.projectId))}`,
    ).toBeTruthy();
    expect(remoteFeature!.inMedia).toBe(true);
    expect(remoteFeature!.availableOutputs).toContain('dr-docs');
  });
});

// ---------------------------------------------------------------------------
// Fake "codex" CLI — same drop-in-binary mechanism as
// pipelines-docs-review-run.test.ts's own `FAKE_CODEX_SCRIPT` (copied here,
// not imported — e2e/AGENTS.md forbids treating another spec file as a
// shared helper). dr-comp needs ONE targeted side effect (writing its
// required per-page output file); dr-flow and dr-review need nothing beyond
// "a normal successful turn" — see that file's header comment for the full
// per-stage validation writeup.
//
// The defensive cwd guard below (only perform the file-write side effect
// when cwd is unambiguously the docs-review workflow directory) is carried
// over deliberately: pipelines-docs-review-run.test.ts discovered a real
// daemon bug where some invocations of the configured CLI run with the
// daemon's own process cwd instead of the project's docs-review dir, and a
// naive relative write would have leaked a stray `comp/` directory into the
// repo root. Not re-litigated here — just inherited.
// ---------------------------------------------------------------------------

const FAKE_CODEX_SCRIPT = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const DELAY_MS = 3000;
// Exact literal kickoff phrase from apps/daemon/src/server.ts's
// runDocsComponentAuditFanout — the only file dr-comp's validation actually
// requires (an empty "screens" array is trivially valid regardless of the
// source doc — apps/daemon/src/docs-components.ts validateComponentReport).
const COMP_OUTPUT_RE = /ghi kết quả ra ĐÚNG MỘT file: "([^"]+)"/;
const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('codex-e2e-happy-path 0.0.0\\n');
  process.exitCode = 0;
} else {
  let prompt = '';
  let emitted = false;
  let emitTimer = null;
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    prompt += chunk;
    if (emitted) return;
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = setTimeout(() => { void run(prompt); }, 25);
  });
  process.stdin.on('end', () => { void run(prompt); });
  if (process.stdin.isTTY) {
    prompt = args.join(' ');
    void run(prompt);
  }

  async function run(promptText) {
    if (emitted) return;
    emitted = true;
    const match = COMP_OUTPUT_RE.exec(promptText);
    // Never write relative to an unverified cwd — some invocations of this
    // binary run with the DAEMON's own process cwd instead of the intended
    // project docs-review dir (a real, separately-tracked daemon bug; see
    // this file's header comment above). Only write when cwd is
    // unambiguously the docs-review workflow directory the daemon actually
    // reads "comp/<slug>.components.json" back from.
    if (match && path.basename(process.cwd()) === 'docs-review') {
      try {
        const outRel = match[1];
        const outAbs = path.join(process.cwd(), outRel);
        fs.mkdirSync(path.dirname(outAbs), { recursive: true });
        fs.writeFileSync(outAbs, JSON.stringify({ schema_version: '1.0', screens: [] }));
      } catch (err) {
        process.stderr.write('fake-codex-happy-path: failed writing comp report: ' + String(err) + '\\n');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    writeJson({ type: 'thread.started' });
    writeJson({ type: 'turn.started' });
    writeJson({ type: 'item.completed', item: { type: 'agent_message', text: 'Fake e2e turn completed.' } });
    writeJson({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 10);
  }

  function writeJson(value) {
    process.stdout.write(JSON.stringify(value) + '\\n');
  }
}
`;

async function createFakeCodexAgent(): Promise<{ bin: string; env: Record<string, string> }> {
  const dir = path.join(os.tmpdir(), `od-e2e-happy-path-codex-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const bin = path.join(dir, 'codex-e2e-happy-path.js');
  await writeFile(bin, FAKE_CODEX_SCRIPT, 'utf8');
  await chmod(bin, 0o755);
  return { bin, env: { CODEX_BIN: bin } };
}

async function configureFakeCodexAgent(page: Page): Promise<void> {
  const response = await page.request.put('/api/app-config', {
    data: {
      onboardingCompleted: true,
      agentId: 'codex',
      agentModels: { codex: { model: 'default', reasoning: 'default' } },
      agentCliEnv: { codex: fakeCodex.env },
      skillId: null,
      designSystemId: null,
      feedbackUsername: FEEDBACK_USERNAME,
      privacyDecisionAt: 1,
    },
  });
  expect(response.ok()).toBeTruthy();
}

// ---------------------------------------------------------------------------
// Machine identity + sync-ready mocks — same mechanism as
// pipelines-pull-push.test.ts (copied, not imported). See that file's header
// comment ("SECOND, NARROWER exception") for the full why two independent
// identity checks (browser session vs machine session) both need
// satisfying.
//
// DEVIATION from that file's own version: this copy also tolerates a missing
// `OD_E2E_DATA_DIR` (pipelines-fixtures.ts's `resolveOdDataDir()` throws when
// unset) by treating it as just another skip reason instead of letting the
// throw crash `beforeAll` outright. pipelines-pull-push.test.ts's own suite
// is always invoked with that env var pre-set (required for its
// `seedDsCriteria`-adjacent tooling); this suite's own acceptance run does
// not assume that, so a hard throw here would fail the whole file instead of
// cleanly skipping just phase 5.
// ---------------------------------------------------------------------------

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
  let destDir: string;
  try {
    destDir = resolveOdDataDir();
  } catch (err) {
    identitySkipReason = `cannot resolve e2e OD_DATA_DIR (set OD_E2E_DATA_DIR to run phase 5): ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  await mkdir(destDir, { recursive: true });
  await writeFile(path.join(destDir, 'auth-user.json'), sessionRaw, { mode: 0o600 });
  identityReady = true;
}

/** Only field this suite is authorized to fake — see the file-header policy
 *  note. Fetches the REAL response first (so a caller session cookie, if one
 *  ever exists, still flows through) and only forces `syncReady`/status;
 *  nothing about media-service is touched here. Identical to
 *  pipelines-pull-push.test.ts's own version. */
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
          googleSubject: 'e2e-happy-path',
          email: 'e2e-happy-path@example.invalid',
          name: 'E2E Happy Path',
          provider: 'google',
          roles: [],
        },
        syncReady: true,
        identityUserId: body.identityUserId ?? 'e2e-happy-path-identity',
        syncIssue: null,
      }),
    });
  });
}

// ---------------------------------------------------------------------------
// Design-system import UI helpers — same mechanism as
// pipelines-ds-figma.test.ts (copied, not imported).
// ---------------------------------------------------------------------------

/** Opens the Settings dialog and switches to the Design Systems section
 *  (`apps/web/src/components/DesignSystemsSection.tsx`, mounted via
 *  `SettingsDialog.tsx`'s `activeSection === 'designSystems'` branch). The
 *  Settings button lives in the persistent EntryShell chrome, which wraps
 *  every Pipelines drill-down level (App/Feature/Run) too — see
 *  `apps/web/src/components/EntryShell.tsx`'s own `view` derivation — so
 *  this is reachable from wherever phase 1 left the page. */
async function openDesignSystemsSettingsTab(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: OPEN_SETTINGS_LABEL }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Design Systems' }).click();
  await expect(dialog.locator('.settings-design-systems')).toBeVisible();
  return dialog;
}

/** Expands the "Add design system" accordion if not already open — the file
 *  input and submit button sit inside it and are not actionable while
 *  collapsed (0-height accordion; see AGENTS.md's "UI animation
 *  philosophy"). */
async function openDsImportPanel(dialog: Locator): Promise<void> {
  const toggle = dialog.getByRole('button', { name: 'Add design system' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(dialog.locator('.library-add-panel.open')).toBeVisible();
}

/** Drives the REAL upload form: picks the default two-file IR fixture pair
 *  (`e2e/lib/playwright/figma-ir-fixture.ts`) via `setInputFiles` and
 *  submits it, capturing the daemon's own response instead of guessing the
 *  generated id/title. */
async function importFigmaFixtureViaUi(page: Page, dialog: Locator): Promise<{ id: string; title: string }> {
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
      (res) => res.url().includes('/api/design-systems/import/figma') && res.request().method() === 'POST',
    ),
    submit.click(),
  ]);
  expect(importResponse.ok()).toBe(true);
  const importJson = (await importResponse.json()) as { designSystem: { id: string; title: string } };
  return { id: importJson.designSystem.id, title: importJson.designSystem.title };
}

async function closeSettingsDialog(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
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
 *  the daemon's own port directly avoids any dev-proxy Host-header
 *  ambiguity. */
async function deleteDesignSystemViaApi(request: APIRequestContext, id: string): Promise<void> {
  const response = await request.delete(`${daemonBaseUrl()}/api/design-systems/${encodeURIComponent(id)}`);
  if (!response.ok() && response.status() !== 404) {
    throw new Error(
      `deleteDesignSystemViaApi failed: HTTP ${response.status()} ${(await response.text()).slice(0, 500)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// App/Feature grid UI helpers — same mechanism as
// pipelines-app-feature-crud.test.ts (copied, not imported).
// ---------------------------------------------------------------------------

async function gotoPipelinesApps(page: Page): Promise<void> {
  await page.goto('/pipelines', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Loading Open Design…')).toHaveCount(0, { timeout: T.medium });
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve Open Design' });
  if (await privacyDialog.isVisible().catch(() => false)) {
    await privacyDialog.getByRole('button', { name: /not now/i }).click();
    await expect(privacyDialog).toHaveCount(0);
  }
  await expect(page.getByRole('heading', { name: 'Quy trình tự động hóa' })).toBeVisible();
}

/** The App card / Feature row button whose accessible name is its own
 *  display name — plain `getByRole('button', { name })` is ambiguous
 *  (sibling pull/push/kebab/detail icon buttons embed the same name as a
 *  substring in their own explicit `aria-label`s); those all set an
 *  explicit `aria-label`, the card/row itself does not. */
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

// ---------------------------------------------------------------------------
// docs-review UI + status-polling helpers — same mechanism as
// pipelines-docs-review-run.test.ts (copied, not imported).
// ---------------------------------------------------------------------------

function stageRow(page: Page, stageName: string): Locator {
  return page.locator('li.pl-step').filter({ has: page.locator('.pl-step__name', { hasText: stageName }) });
}

async function clickRunStage(page: Page, stageId: keyof typeof STAGE_NAME): Promise<void> {
  const button = page.getByTestId(`pipeline-run-stage-${stageId}`);
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes(`/api/pipelines/${stageId}/run`) && res.request().method() === 'POST',
    ),
    button.click(),
  ]);
}

async function uploadIngestDoc(page: Page): Promise<void> {
  const row = stageRow(page, STAGE_NAME['dr-docs']);
  await row.getByRole('button', { name: `Thao tác khác — ${STAGE_NAME['dr-docs']}` }).click();
  await page.getByRole('menuitem', { name: 'Tải file lên' }).click();

  const dialog = page.getByRole('dialog', { name: `Tải file lên · ${STAGE_NAME['dr-docs']}` });
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: INGEST_DOC_NAME,
    mimeType: 'text/markdown',
    buffer: Buffer.from(INGEST_DOC_CONTENT, 'utf8'),
  });
  await expect(dialog.getByText(INGEST_DOC_NAME)).toBeVisible();

  await Promise.all([
    page.waitForResponse((res) => res.url().includes('/files') && res.request().method() === 'POST'),
    dialog.getByRole('button', { name: /^Tải lên/ }).click(),
  ]);
  await expect(dialog).toHaveCount(0);
}

// Status polling — GET /api/pipelines?projectId=&workflowId=docs-review
// (apps/daemon/src/pipeline-routes.ts). Deliberately real HTTP polling
// against the daemon's own truth, never `page.waitForTimeout`.

async function fetchStagePipelines(page: Page, projectId: string): Promise<StageRow[]> {
  const res = await page.request.get(
    `/api/pipelines?projectId=${encodeURIComponent(projectId)}&workflowId=docs-review`,
  );
  if (!res.ok()) return [];
  const body = (await res.json()) as { pipelines: StageRow[] };
  return body.pipelines;
}

async function waitForStatus(
  page: Page,
  projectId: string,
  stageId: string,
  status: string,
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const pipelines = await fetchStagePipelines(page, projectId);
        return pipelines.find((p) => p.id === stageId)?.status ?? 'missing';
      },
      { timeout: timeoutMs },
    )
    .toBe(status);
}

async function waitForAllStatus(
  page: Page,
  projectId: string,
  stageIds: string[],
  status: string,
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const pipelines = await fetchStagePipelines(page, projectId);
        return stageIds.map((id) => pipelines.find((p) => p.id === id)?.status ?? 'missing');
      },
      { timeout: timeoutMs },
    )
    .toEqual(stageIds.map(() => status));
}
