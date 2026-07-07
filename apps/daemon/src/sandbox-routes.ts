// Agent-in-sandbox status surface. One read-only endpoint: the web Settings
// card and `od sandbox status` both consume it. Enable/disable persists
// through the existing `PUT /api/app-config` (`sandbox` section) — no
// dedicated mutation endpoint here. Build/login are terminal-interactive
// docker operations and live in the CLI (`od sandbox build|login`), which
// resolves the scripts through `builderDir` from this response.
import path from 'node:path';
import type { Express } from 'express';
import type { SandboxStatusResponse } from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';
import { readAppConfig, type AppConfigPrefs } from './app-config.js';
import {
  dockerAvailable,
  dockerImagePresent,
  dockerVolumePresent,
  listSandboxContainers,
  resolveSandboxConfig,
  sandboxAuthLoggedIn,
  sandboxImageTag,
  SANDBOX_AUTH_VOLUME,
  SANDBOX_IMAGE_NAME,
} from './agent-sandbox.js';

export interface RegisterSandboxRoutesDeps extends RouteDeps<'http' | 'paths'> {}

export function registerSandboxRoutes(app: Express, ctx: RegisterSandboxRoutesDeps) {
  const { sendApiError } = ctx.http;
  const { RUNTIME_DATA_DIR, SKILLS_DIR } = ctx.paths;
  const builderDir = path.join(SKILLS_DIR, 'ui-react', 'builder');

  app.get('/api/sandbox/status', async (req, res) => {
    try {
      const prefs = await readAppConfig(RUNTIME_DATA_DIR).catch(
        (): AppConfigPrefs => ({}),
      );
      const cfg = resolveSandboxConfig(prefs.sandbox, process.env);

      let image = `${SANDBOX_IMAGE_NAME}:unknown`;
      let claudeVersion: string | null = null;
      try {
        image = sandboxImageTag(builderDir);
        const { readFileSync } = await import('node:fs');
        claudeVersion = readFileSync(
          path.join(builderDir, 'sandbox', 'claude.version'),
          'utf8',
        ).trim();
      } catch {
        // Builder pins unreadable (skill missing/moved) — report unknown.
      }

      const dockerOk = await dockerAvailable();
      const imageOk = dockerOk && (await dockerImagePresent(image));
      const authVolumeOk = dockerOk && (await dockerVolumePresent(SANDBOX_AUTH_VOLUME));
      // Deep probe only when requested (`?probeAuth=1`): it starts a
      // short-lived container, too slow for a settings-panel poll.
      const probeAuth = req.query.probeAuth === '1';
      const authLoggedIn =
        probeAuth && imageOk && authVolumeOk ? await sandboxAuthLoggedIn(image) : null;
      const activeContainers = dockerOk ? await listSandboxContainers() : [];

      const body: SandboxStatusResponse = {
        enabled: cfg.enabled,
        runtimes: cfg.runtimes,
        skills: cfg.skills,
        timeoutMinutes: cfg.timeoutMinutes,
        dockerOk,
        image,
        imageOk,
        claudeVersion,
        authVolumeOk,
        authLoggedIn,
        activeContainers,
        builderDir,
      };
      res.json(body);
    } catch (err) {
      return sendApiError(res, 500, 'INTERNAL_ERROR', `sandbox status failed: ${(err as Error).message}`);
    }
  });
}
