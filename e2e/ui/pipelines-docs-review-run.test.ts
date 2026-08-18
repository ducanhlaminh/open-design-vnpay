// Pipelines Studio — the full "Rà soát tài liệu" (docs-review) workflow run,
// against the real daemon `webServer` this config boots (see
// playwright.config.ts). Self-contained: does not depend on any of the other
// Pipelines UI suites.
//
// docs-review's stages (apps/daemon/src/pipelines.ts `WORKFLOW_DEFS['docs-review']`)
// are:
//   dr-docs   (ingest, skillId 'confluence-ingest')      — file-derived status,
//             no agent run needed when ingested via upload.
//   dr-comp   (skillId 'docs-screen-components')         — PER-SCREEN agent
//             fan-out (screens come from dr-flow's flows/index.json) after a
//             role-map run; each screen's agent MUST write
//             "comp/<KEY>.screen.json" + "wireframes/<KEY>.html" or the screen
//             (and, if every screen fails, the whole stage) is a hard error
//             (apps/daemon/src/server.ts `runDocsComponentAuditFanout`).
//             ⚠ TODO(dr-comp v2, 2026-08-18): this suite's fake codex still
//             writes the v1 "comp/<slug>.components.json" and case 3 runs
//             dr-comp IN PARALLEL with dr-flow — under v2 dr-comp fail-shuts
//             when flows/index.json has no screens, so case 3 needs to run
//             dr-flow first (with a fake that writes flows/index.json +
//             flowchart.json) and the dr-comp fake must write
//             comp/_role-map.json, then comp/<KEY>.screen.json +
//             wireframes/<KEY>.html per screen. Not yet updated.
//   dr-flow   (skillId 'docs-flow-ux')                    — generic single-agent
//             path plus a deterministic pre-step (`prepareFlowUxInputs`:
//             extract draw.io/Mermaid diagrams → flows/<id>/…) and post-step
//             (`finalizeFlowUx`: apply patch.json → proposed.drawio, derive
//             flowchart.json, write flows/index.json). With no diagrams in the
//             docs both steps are no-ops, so status still follows the run's
//             terminal status — no file-content validation.
//   dr-review (skillId 'docs-spec-review')                — PER-SECTION agent
//             fan-out; the agent is NOT required to write anything for a
//             section (missing changes.json/notes.json = valid empty array,
//             not an error — apps/daemon/src/server.ts `runDocsReviewFanout`).
//   dr-confirm ("Xác nhận hoàn tất") is a separate deterministic action (no
//             agent), reachable only via the `pipeline-docs-review-confirm`
//             toolbar button — it is NOT part of `WORKFLOW_DEFS['docs-review']
//             .pipelineIds`, so it never appears as a stepper row.
//
// None of the three agent-driven stages needs a REAL Claude/Codex/etc CLI —
// this suite drives them with a small self-contained fake "codex" CLI (same
// mechanism as `e2e/lib/fake-agents.ts`'s `createFakeAgentRuntimes`, but
// written locally rather than imported, since the shared script has no hook
// for dr-comp's one required file write). See `FAKE_CODEX_SCRIPT` below.
//
// IMPORTANT — two corrections to how this suite reads the product today
// (see the report's `decisions` for the full writeup):
//   1. The "2026-08 docs-only gate" (`computeActive` in pipelines.ts) means
//      dr-review's own "Chạy" button is enabled as soon as dr-docs has
//      ingested files — NOT gated on dr-comp/dr-flow having succeeded first
//      (the legacy per-step `dependsOn` chain no longer drives `active`).
//      This suite still runs dr-comp + dr-flow before dr-review (the intended
//      product order), but asserts the REAL gating rule (dr-review's Run
//      button is already visible right after ingest) instead of a "disabled
//      until upstream succeeds" premise that no longer holds.
//   2. dr-review's Quick-result preview is rendered by `DocRedlinePreview`,
//      not `DocsReviewPreview` (that component is docs-to-prd's `prd-review`
//      stage). This suite asserts the preview surface generically (visible
//      Quick-result region, non-empty file viewer) rather than pinning to
//      either component's internals.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { STORAGE_KEY } from '@/playwright/mock-factory';
import {
  createAppViaApi,
  createFeatureViaApi,
  deleteAppViaApi,
  deleteFeatureViaApi,
  takeCheckpointScreenshot,
} from '@/playwright/pipelines-fixtures';
import { T } from '@/timeouts';

// Same FeedbackUsernameGate concern as pipelines-app-feature-crud.test.ts —
// `apps/web/src/App.tsx`'s gate blocks all pointer interaction once
// onboarding is done and `config.feedbackUsername` is empty. Unlike that
// sibling suite this file cannot mock GET /api/app-config away (see the
// `beforeEach` comment), so `feedbackUsername` is threaded through the real
// localStorage seed AND the real daemon PUT instead.
const FEEDBACK_USERNAME = 'Pipelines Docs-Review E2E';

// Stage row labels — `PipelineDef.name` in apps/daemon/src/pipelines.ts,
// rendered verbatim as `PipelineView.name` in every stage row / modal title.
const STAGE_NAME = {
  'dr-docs': 'Tài liệu (nạp)',
  'dr-comp': 'Màn hình → Component',
  'dr-flow': 'Đánh giá luồng UX',
  'dr-review': 'Review tài liệu',
} as const;

const WORKFLOW_CARD_LABEL = 'Rà soát chất lượng tài liệu';
const STAGE_POLL_TIMEOUT = T.xlong;

// A minimal, single-section markdown doc. Deliberately short (well under the
// 120-non-blank-line `splitSections` merge threshold in
// apps/daemon/src/docs-review.ts) so it collapses into exactly one section —
// one dr-comp page turn, one dr-review section turn.
const INGEST_DOC_NAME = 'login-spec.md';
const INGEST_DOC_CONTENT = `# Đặc tả màn hình đăng nhập

Tài liệu đặc tả tối giản dùng để kiểm thử tự động luồng Rà soát tài liệu
(docs-review) trong Pipelines Studio.

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

let createdAppIds: string[] = [];
let createdFeatureIds: string[] = [];
let fakeCodex: { bin: string; env: Record<string, string> };

test.beforeAll(async () => {
  fakeCodex = await createFakeCodexAgent();
});

test.beforeEach(async ({ page }) => {
  createdAppIds = [];
  createdFeatureIds = [];
  // Not the shared `routeMockAgents` (mock-factory.ts): apps/web/src/
  // components/InfraSetupGate.tsx blocks all pointer interaction (host mode)
  // until it sees a `claude` entry in GET /api/agents with
  // `available && authStatus === 'ok'` — it gates on the CLI named "claude"
  // specifically, independent of whichever agent this suite actually
  // configures (codex). A `page.reload()` (case 7's cancel-recovery) re-runs
  // this check from scratch, so it must be satisfied on every navigation,
  // not just the first.
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
  // Deliberately do NOT mock GET /api/app-config (unlike the sibling CRUD
  // suite): apps/web/src/App.tsx's boot sequence fetches it, merges it over
  // local config (`mergeDaemonConfig` — daemon wins per-field, including
  // `agentId`/`agentCliEnv`), and immediately `syncConfigToDaemon`s the
  // merge back as an idempotent "keep both sides in sync" step. A GET mock
  // pinned to `agentId: 'mock'` would make that boot-time write-back clobber
  // the real fake-codex config this suite needs for the daemon to actually
  // run dr-comp/dr-flow/dr-review with. Seeding localStorage with the exact
  // same config instead (below) makes that resync idempotent — real GET,
  // real (matching) local state, real PUT, all in agreement from the first
  // render.
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
        }),
      );
    },
    { key: STORAGE_KEY, agentEnv: fakeCodex.env, feedbackUsername: FEEDBACK_USERNAME },
  );

  // Real server-side agent config — pipeline stage runs are resolved
  // daemon-side from this (the run request body never carries an agentId;
  // see PipelinesView.tsx `startRun`). Set BEFORE the first navigation so
  // even the very first `GET /api/app-config` the app boots with already
  // matches localStorage above.
  await configureFakeCodexAgent(page);
});

test.afterEach(async ({ page, request }) => {
  await resetAppConfig(page).catch((err) => {
    console.warn(`[pipelines-docs-review-run] teardown: failed to reset app-config: ${String(err)}`);
  });
  for (const featureId of createdFeatureIds) {
    await deleteFeatureViaApi(request, featureId).catch((err) => {
      console.warn(`[pipelines-docs-review-run] teardown: failed to delete feature "${featureId}": ${String(err)}`);
    });
  }
  for (const appId of createdAppIds) {
    await deleteAppViaApi(request, appId).catch((err) => {
      console.warn(`[pipelines-docs-review-run] teardown: failed to delete app "${appId}": ${String(err)}`);
    });
  }
});

test('runs the full docs-review workflow through the real UI and daemon', async ({ page, request }) => {
  test.setTimeout(240_000);

  const stamp = Date.now();
  const appId = `docs-review-run-app-${stamp}`;
  const appName = `Docs Review Run App ${stamp}`;
  const featureId = `docs-review-run-feature-${stamp}`;
  const featureName = `Docs Review Run Feature ${stamp}`;

  // ── Case 1: setup App + Feature, open the docs-review workflow through
  // the real UI (App → Feature → workflow picker → stepper). ───────────────
  const app = await createAppViaApi(request, { appId, name: appName });
  createdAppIds.push(app.id);
  const feature = await createFeatureViaApi(request, {
    projectId: featureId,
    name: featureName,
    appId: app.id,
    appName: app.name,
  });
  createdFeatureIds.push(feature.id);

  await test.step('case 1: open the docs-review workflow via the real UI', async () => {
    await page.goto(`/pipelines/app/${appId}`);
    await expect(page.getByRole('heading', { name: appName })).toBeVisible();
    // PipelinesFeaturesView's row is itself a toggle (expand/collapse the
    // inline workflow accordion) — "Xem chi tiết" is the dedicated,
    // unambiguous action that navigates into the workflow picker
    // (apps/web/src/components/pipelines/PipelinesFeaturesView.tsx `openFeature`).
    await page.getByRole('button', { name: `Xem chi tiết ${featureName}` }).click();
    await expect(page).toHaveURL(new RegExp(`/pipelines/app/${appId}/${featureId}$`));
    await takeCheckpointScreenshot(page, 'docs-review-run-case1-workflow-picker');

    const card = page.locator('[class*="pipelineCard"]').filter({ hasText: WORKFLOW_CARD_LABEL }).first();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /^(Bắt đầu|Mở)$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/pipelines/app/${appId}/${featureId}/docs-review$`));
    await expect(page.getByTestId('pipelines-view')).toBeVisible();
    await expect(stageRow(page, STAGE_NAME['dr-docs'])).toBeVisible();
    await takeCheckpointScreenshot(page, 'docs-review-run-case1-stepper-opened');
  });

  // ── Case 2: ingest via "Tải file lên" (avoids mocking Confluence — see
  // e2e/AGENTS.md's server-level-mocks-only rule for external services) and
  // confirm dr-docs flips to succeeded via real polling. ───────────────────
  await test.step('case 2: ingest a document via "Tải file lên" and dr-docs succeeds', async () => {
    await uploadIngestDoc(page);
    await takeCheckpointScreenshot(page, 'docs-review-run-case2-upload-submitted');
    await waitForStatus(page, featureId, 'dr-docs', 'succeeded', STAGE_POLL_TIMEOUT);
    await expect(stageRow(page, STAGE_NAME['dr-docs']).getByTestId('pipeline-result-stage-dr-docs')).toBeVisible();
    await takeCheckpointScreenshot(page, 'docs-review-run-case2-dr-docs-succeeded');

    // Corrected gating: the "2026-08 docs-only gate" (`computeActive` in
    // apps/daemon/src/pipelines.ts) makes EVERY downstream stage active as
    // soon as dr-docs has ingested files — dr-review's own Run button is
    // already enabled here, well before dr-comp/dr-flow ever run. This
    // documents the real rule in place of the (no longer true) "dr-review is
    // locked until dr-comp+dr-flow succeed" premise.
    await expect(page.getByTestId('pipeline-run-stage-dr-review')).toBeVisible();
    await expect(page.getByTestId('pipeline-run-stage-dr-review')).toBeEnabled();
  });

  // ── Case 7 (folded in here, before dr-flow's real run — see the report's
  // `decisions`): start dr-flow, cancel it mid-run, confirm it returns to a
  // non-running state, then actually run it for real. ──────────────────────
  await test.step('case 7: cancel a running stage (dr-flow) and confirm it returns to idle', async () => {
    await clickRunStage(page, 'dr-flow');
    await takeCheckpointScreenshot(page, 'docs-review-run-case7-dr-flow-running');
    await cancelRunningStage(page, STAGE_NAME['dr-flow']);
    await waitForStatus(page, featureId, 'dr-flow', 'idle', STAGE_POLL_TIMEOUT);
    // The daemon truth is already 'idle' (confirmed above via direct polling)
    // but PipelinesView's own row state is driven by an independent 2.5s
    // background poll — an in-flight refresh dispatched just before the
    // cancel can resolve just after it and leave the row's LOCAL state
    // showing "running" for longer than is reasonable to wait out here.
    // Reload for a clean fetch instead of trusting that poll's timing.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('pipelines-view')).toBeVisible();
    await expect(page.getByTestId('pipeline-run-stage-dr-flow')).toBeVisible();
    await takeCheckpointScreenshot(page, 'docs-review-run-case7-dr-flow-cancelled');
  });

  // ── Case 3: run dr-comp AND dr-flow (parallel, matching the real design)
  // via the real "Chạy" button. ─────────────────────────────────────────────
  await test.step('case 3: run dr-comp + dr-flow in parallel and both succeed', async () => {
    await clickRunStage(page, 'dr-comp');
    await clickRunStage(page, 'dr-flow');
    await takeCheckpointScreenshot(page, 'docs-review-run-case3-running');
    await waitForAllStatus(page, featureId, ['dr-comp', 'dr-flow'], 'succeeded', STAGE_POLL_TIMEOUT);
    await takeCheckpointScreenshot(page, 'docs-review-run-case3-succeeded');
  });

  // ── Case 4: run dr-review (after dr-comp + dr-flow, matching the intended
  // product order) and confirm it succeeds. ────────────────────────────────
  await test.step('case 4: run dr-review and it succeeds', async () => {
    await clickRunStage(page, 'dr-review');
    await waitForStatus(page, featureId, 'dr-review', 'succeeded', STAGE_POLL_TIMEOUT);
    await takeCheckpointScreenshot(page, 'docs-review-run-case4-dr-review-succeeded');
  });

  // ── Case 5: "Xem kết quả" for dr-review renders the Quick-result view. ───
  await test.step('case 5: "Xem kết quả" opens the Quick-result view for dr-review', async () => {
    await page.getByTestId('pipeline-result-stage-dr-review').click();
    const resultRegion = page.locator('.pl-result-page');
    await expect(resultRegion).toBeVisible();
    await expect(resultRegion).toContainText('Review tài liệu');
    await expect(page.getByText('Bước này chưa có tệp kết quả', { exact: false })).toHaveCount(0);
    await expect(page.locator('.pl-result-stage')).toBeVisible();
    await takeCheckpointScreenshot(page, 'docs-review-run-case5-quick-result');

    await page.getByRole('button', { name: 'Quay lại' }).click();
    await expect(page.getByTestId('pipelines-view')).toBeVisible();
  });

  // ── Case 6: "Xác nhận hoàn tất" (dr-confirm) succeeds. ────────────────────
  await test.step('case 6: "Xác nhận hoàn tất" confirms the docs-review workflow', async () => {
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
    await takeCheckpointScreenshot(page, 'docs-review-run-case6-confirmed');
  });
});

// ---------------------------------------------------------------------------
// Fake "codex" CLI — same drop-in-binary mechanism as
// e2e/lib/fake-agents.ts's `createFakeAgentRuntimes`, written locally because
// dr-comp needs ONE targeted side effect (writing its required per-page
// output file) that the shared script has no hook for. Everything else
// (dr-flow, dr-review) needs nothing beyond "a normal successful turn" —
// dr-flow's status comes purely from the run's terminal status (no file
// checks — apps/daemon/src/server.ts's generic `runPipeline` tail), and
// dr-review's fan-out treats a missing changes/notes file as a valid empty
// result, not an error (apps/daemon/src/server.ts `runDocsReviewFanout`).
//
// Protocol: codex's own JSON-stream (thread.started / turn.started /
// item.completed / turn.completed) — mirrors `renderFakeAgentScript('codex')`
// in e2e/lib/fake-agents.ts. A 3s artificial delay on every turn gives the
// case-7 cancel test a wide, real-world-timing-independent window to open the
// Status modal and cancel before the turn would otherwise complete.
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
  process.stdout.write('codex-e2e-docs-review 0.0.0\\n');
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
    // Some invocations of this binary run without the intended project cwd
    // (e.g. a daemon-side preflight/detect probe that spawns the configured
    // CLI with no explicit cwd, inheriting the DAEMON's own process cwd —
    // observed empirically to be the repo root). Only perform the file-write
    // side effect when cwd is unambiguously the docs-review workflow
    // directory the daemon actually reads "comp/<slug>.components.json"
    // back from (apps/daemon/src/server.ts runDocsComponentAuditFanout's own
    // \`cwd = path.join(projectRoot, wfDir)\`) — never write relative to an
    // unverified cwd, so a stray invocation can never pollute an unintended
    // directory (e.g. the actual repo working tree during local/dev runs).
    if (match && path.basename(process.cwd()) === 'docs-review') {
      try {
        const outRel = match[1];
        const outAbs = path.join(process.cwd(), outRel);
        fs.mkdirSync(path.dirname(outAbs), { recursive: true });
        fs.writeFileSync(outAbs, JSON.stringify({ schema_version: '1.0', screens: [] }));
      } catch (err) {
        process.stderr.write('fake-codex-docs-review: failed writing comp report: ' + String(err) + '\\n');
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
  const dir = path.join(os.tmpdir(), `od-e2e-docs-review-codex-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const bin = path.join(dir, 'codex-e2e-docs-review.js');
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
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function resetAppConfig(page: Page): Promise<void> {
  const response = await page.request.put('/api/app-config', {
    data: {
      onboardingCompleted: true,
      agentId: 'mock',
      agentModels: {},
      agentCliEnv: {},
      skillId: null,
      designSystemId: null,
    },
  });
  expect(response.ok()).toBeTruthy();
}

// ---------------------------------------------------------------------------
// UI helpers
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

async function cancelRunningStage(page: Page, stageName: string): Promise<void> {
  const row = stageRow(page, stageName);
  const progressButton = row.getByRole('button', { name: 'Xem tiến trình' });
  await expect(progressButton).toBeVisible();
  await progressButton.click();

  const dialog = page.getByRole('dialog', { name: `Status · ${stageName}` });
  await expect(dialog).toBeVisible();
  const cancelButton = dialog.getByTestId('pipeline-status-cancel');
  await expect(cancelButton).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (res) => /\/api\/runs\/[^/]+\/cancel$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
    ),
    cancelButton.click(),
  ]);
  // PlModal renders BOTH an icon-only header close (aria-label "Close") and,
  // for this modal, a footer "Close" button — both share the accessible name
  // "Close", so target the unambiguous header one by its fixed class.
  await dialog.locator('.pl-modal__close').click();
  await expect(dialog).toHaveCount(0);
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

// ---------------------------------------------------------------------------
// Status polling — GET /api/pipelines?projectId=&workflowId=docs-review
// (apps/daemon/src/pipeline-routes.ts). Deliberately real HTTP polling
// against the daemon's own truth, never `page.waitForTimeout`.
// ---------------------------------------------------------------------------

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
