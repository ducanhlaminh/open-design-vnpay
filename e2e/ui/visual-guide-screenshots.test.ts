import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { configureVisualPage, gotoVisualHome, waitForVisualFonts } from '@/playwright/visual';

const outputDir = path.resolve(process.env.OD_GUIDE_SCREENSHOT_DIR ?? '../../docs/screenshots/guide');

test.describe('guide screenshots', () => {
  test('captures project and design-system actions', async ({ page }) => {
    await configureGuidePage(page);
    await gotoVisualHome(page);
    await waitForVisualFonts(page);

    const newProject = page.getByTestId('entry-nav-new-project');
    await highlight(page, newProject, '1');
    await capture(page, '01-tao-du-an.png');

    await newProject.click();
    const nameField = page.getByTestId('new-project-name');
    await expect(nameField).toBeVisible();
    await highlight(page, nameField, '2');
    await capture(page, '02-dat-ten-du-an.png');

    await page.keyboard.press('Escape');
    const designSystems = page.getByTestId('entry-nav-design-systems');
    await designSystems.click();
    await expect(page.getByTestId('design-systems-tab')).toBeVisible();
    await highlight(page, page.getByTestId('design-systems-tab'), '3');
    await capture(page, '03-mo-design-system.png');
  });

  test('captures the execution settings action', async ({ page }) => {
    await configureGuidePage(page);
    await gotoVisualHome(page);
    await page.getByTestId('recent-projects-strip').locator('[data-project-id]').first().click();
    await expect(page.getByTestId('chat-composer')).toBeVisible();
    await page.locator('.avatar-menu .avatar-agent-trigger').click();
    const menu = page.locator('.avatar-popover[role="dialog"]');
    await expect(menu).toBeVisible();
    const settingsButton = menu.getByRole('button', { name: /^Settings\b/i });
    await highlight(page, settingsButton, '4');
    await capture(page, '04-mo-cai-dat-execution.png');
  });
});

async function configureGuidePage(page: Page): Promise<void> {
  await configureVisualPage(page);
  await page.route('**/api/app-config', async (route) => {
    await route.fulfill({
      json: {
        config: {
          onboardingCompleted: true,
          feedbackUsername: 'guide',
          agentId: 'mock',
          skillId: null,
          designSystemId: null,
          mode: 'daemon',
          agentModels: {},
          privacyDecisionAt: 1,
          telemetry: { metrics: false, content: false, artifactManifest: false },
        },
      },
    });
  });
}

async function capture(page: Page, filename: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await page.screenshot({ path: path.join(outputDir, filename), animations: 'disabled', caret: 'hide' });
}

async function highlight(page: Page, target: Locator, number: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`Cannot locate screenshot target ${number}`);
  await page.evaluate(({ box: rect, number: badge }) => {
    document.querySelector('[data-guide-highlight]')?.remove();
    const root = document.createElement('div');
    root.dataset.guideHighlight = '';
    Object.assign(root.style, {
      position: 'fixed', left: `${rect.x - 6}px`, top: `${rect.y - 6}px`,
      width: `${rect.width + 12}px`, height: `${rect.height + 12}px`,
      border: '3px solid #e5484d', borderRadius: '10px',
      boxShadow: '0 0 0 9999px rgba(20, 24, 31, 0.14), 0 0 0 6px rgba(229, 72, 77, 0.2)',
      pointerEvents: 'none', zIndex: '2147483647',
    });
    const label = document.createElement('span');
    label.textContent = badge;
    Object.assign(label.style, {
      position: 'absolute', left: '-12px', top: '-16px', width: '26px', height: '26px',
      borderRadius: '999px', background: '#e5484d', color: '#fff', display: 'grid',
      placeItems: 'center', font: '700 14px/1 system-ui, sans-serif',
    });
    root.append(label);
    document.body.append(root);
  }, { box, number });
}
