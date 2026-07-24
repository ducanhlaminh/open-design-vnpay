// Agent-in-sandbox status surface. One read-only endpoint: the web Settings
// card and `od sandbox status` both consume it. Enable/disable persists
// through the existing `PUT /api/app-config` (`sandbox` section) — no
// dedicated mutation endpoint here. Build/login are terminal-interactive
// docker operations and live in the CLI (`od sandbox build|login`), which
// resolves the scripts through `builderDir` from this response.
import path from 'node:path';
import type { Express, Response } from 'express';
import type {
  SandboxStatusResponse,
  SandboxAccountsResponse,
  SandboxAccountsCheckResponse,
  SandboxBuildResponse,
} from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';
import { readAppConfig, type AppConfigPrefs } from './app-config.js';
import { invalidateClaudeUsageCache, probeClaudeCredentials } from './claude-usage.js';
import {
  dockerAvailable,
  dockerImagePresent,
  dockerVolumePresent,
  listSandboxContainers,
  listSandboxAccounts,
  saveSandboxAccount,
  switchSandboxAccount,
  removeSandboxAccount,
  readSandboxAccountCredentials,
  openSandboxLoginTerminal,
  startEmbeddedLogin,
  getEmbeddedLoginStatus,
  submitEmbeddedLoginCode,
  cancelEmbeddedLogin,
  ensureSandboxImage,
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

  // ── Claude account switching (Docker-only) ────────────────────────────────
  // `supported` = the sandbox OWNS Claude (enabled + skills '*' + claude gated);
  // `ready` also needs docker + the image so the account containers can run.
  const accountsContext = async (): Promise<{ supported: boolean; image: string | null; ready: boolean }> => {
    const prefs = await readAppConfig(RUNTIME_DATA_DIR).catch((): AppConfigPrefs => ({}));
    const cfg = resolveSandboxConfig(prefs.sandbox, process.env);
    const supported =
      cfg.enabled && cfg.skills.includes('*') && (cfg.runtimes.includes('*') || cfg.runtimes.includes('claude'));
    let image: string | null = null;
    try {
      image = sandboxImageTag(builderDir);
    } catch {
      image = null;
    }
    const ready = supported && !!image && (await dockerAvailable()) && !!image && (await dockerImagePresent(image));
    return { supported, image, ready };
  };

  const emptyAccounts = (supported: boolean): SandboxAccountsResponse => ({
    supported,
    loggedIn: false,
    activeUnsaved: false,
    accounts: [],
  });

  const runAccountMutation = async (
    res: Response,
    fn: (image: string) => Promise<SandboxAccountsResponse>,
  ): Promise<void> => {
    const { supported, image, ready } = await accountsContext();
    if (!supported) {
      sendApiError(res, 400, 'BAD_REQUEST', 'Chuyển account chỉ áp dụng khi sandbox sở hữu Claude (Docker-only).');
      return;
    }
    if (!ready || !image) {
      sendApiError(res, 503, 'SANDBOX_UNAVAILABLE', 'Docker/sandbox image chưa sẵn sàng — bật Docker + build image trước.');
      return;
    }
    try {
      res.json(await fn(image));
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', (err as Error).message);
    }
  };

  app.get('/api/sandbox/accounts', async (_req, res) => {
    try {
      const { supported, image, ready } = await accountsContext();
      if (!ready || !image) {
        res.json(emptyAccounts(supported));
        return;
      }
      res.json(await listSandboxAccounts(image));
    } catch (err) {
      return sendApiError(res, 500, 'INTERNAL_ERROR', `list accounts failed: ${(err as Error).message}`);
    }
  });

  app.post('/api/sandbox/accounts/save', async (req, res) => {
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    await runAccountMutation(res, (image) => saveSandboxAccount(image, label));
  });

  app.post('/api/sandbox/accounts/switch', async (req, res) => {
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    await runAccountMutation(res, async (image) => {
      const result = await switchSandboxAccount(image, label);
      // The active credentials just changed — drop the cached usage so the
      // quota meter reflects the newly-switched account on its next poll.
      invalidateClaudeUsageCache();
      return result;
    });
  });

  app.delete('/api/sandbox/accounts/:label', async (req, res) => {
    const label = decodeURIComponent(req.params.label ?? '');
    await runAccountMutation(res, (image) => removeSandboxAccount(image, label));
  });

  // Check each saved account's token health (probe its OAuth token). A revoked/
  // expired token (e.g. password changed) comes back ok:false with an error —
  // the UI flags it red and shows the error, but never deletes the account.
  app.post('/api/sandbox/accounts/check', async (req, res) => {
    const { supported, image, ready } = await accountsContext();
    if (!supported) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'Chỉ áp dụng khi Docker-only (sandbox sở hữu Claude).');
    }
    if (!ready || !image) {
      return sendApiError(res, 503, 'SANDBOX_UNAVAILABLE', 'Docker/sandbox image chưa sẵn sàng.');
    }
    try {
      // Optional `label` → probe just that account; absent → probe them all.
      const only = typeof req.body?.label === 'string' ? req.body.label : null;
      const { accounts } = await listSandboxAccounts(image);
      const targets = only ? accounts.filter((a) => a.label === only) : accounts;
      const statuses = await Promise.all(
        targets.map(async (a) => {
          const raw = await readSandboxAccountCredentials(image, a.label);
          if (!raw) return { label: a.label, ok: false, error: 'Không đọc được credentials' };
          const probe = await probeClaudeCredentials(raw);
          return { label: a.label, ok: probe.ok, ...(probe.error ? { error: probe.error } : {}) };
        }),
      );
      res.json({ statuses } satisfies SandboxAccountsCheckResponse);
    } catch (err) {
      return sendApiError(res, 500, 'INTERNAL_ERROR', `check accounts failed: ${(err as Error).message}`);
    }
  });

  // ── Build the sandbox image from the UI ("Build image" button) ────────────
  // On a fresh machine (Docker installed, image not built yet) the user can't
  // run `od sandbox build` from a terminal they may not have — so build it in
  // the daemon. `ensureSandboxImage` builds the base image first when THAT is
  // missing too, i.e. "build whatever's missing". Builds take minutes: POST
  // starts it and returns at once; the UI polls GET until `building` is false.
  const BUILD_LOG_MAX = 200;
  let buildState: SandboxBuildResponse = { building: false, ok: null, error: null, log: [] };
  const pushBuildLog = (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const l = line.replace(/\s+$/, '');
      if (l) buildState.log.push(l);
    }
    if (buildState.log.length > BUILD_LOG_MAX) {
      buildState.log = buildState.log.slice(-BUILD_LOG_MAX);
    }
  };

  app.get('/api/sandbox/build', (_req, res) => {
    res.json(buildState);
  });

  app.post('/api/sandbox/build', async (_req, res) => {
    if (buildState.building) {
      // Already running — just report progress (idempotent, no second build).
      res.json(buildState);
      return;
    }
    let image: string;
    try {
      image = sandboxImageTag(builderDir);
    } catch {
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Không đọc được phiên bản image (skills/ui-react/builder thiếu?).');
    }
    if (!(await dockerAvailable())) {
      return sendApiError(res, 503, 'SANDBOX_UNAVAILABLE', 'Docker chưa chạy — bật Docker/OrbStack rồi thử lại.');
    }
    buildState = { building: true, ok: null, error: null, log: [] };
    // Fire-and-forget: the build runs for minutes; the UI polls GET for progress.
    void ensureSandboxImage(builderDir, image, pushBuildLog)
      .then((result) => {
        buildState.ok = result.ok;
        buildState.error = result.ok ? null : result.reason ?? 'Build thất bại.';
        if (!result.ok && result.reason) pushBuildLog(result.reason);
      })
      .catch((err: unknown) => {
        buildState.ok = false;
        buildState.error = err instanceof Error ? err.message : String(err);
        pushBuildLog(buildState.error);
      })
      .finally(() => {
        buildState.building = false;
      });
    res.status(202).json(buildState);
  });

  // Add account = open a host terminal running the interactive Claude OAuth
  // login (can't embed the TUI in the web). The user finishes there, then Saves.
  app.post('/api/sandbox/accounts/login', async (_req, res) => {
    const { supported, image, ready } = await accountsContext();
    if (!supported) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'Chỉ áp dụng khi Docker-only (sandbox sở hữu Claude).');
    }
    if (!ready || !image) {
      return sendApiError(res, 503, 'SANDBOX_UNAVAILABLE', 'Docker/sandbox image chưa sẵn sàng.');
    }
    res.json(openSandboxLoginTerminal(image));
  });

  // ── Embedded (no-terminal) login: the daemon drives `claude /login` in the
  // container and the web collects the OAuth code (see agent-sandbox.ts).
  // GET = poll state; POST = start session; POST /code = submit pasted code;
  // DELETE = cancel. One session at a time.
  app.get('/api/sandbox/embedded-login', (_req, res) => {
    res.json(getEmbeddedLoginStatus());
  });

  app.post('/api/sandbox/embedded-login', async (_req, res) => {
    const { supported, image, ready } = await accountsContext();
    if (!supported) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'Chỉ áp dụng khi Docker-only (sandbox sở hữu Claude).');
    }
    if (!ready || !image) {
      return sendApiError(res, 503, 'SANDBOX_UNAVAILABLE', 'Docker/sandbox image chưa sẵn sàng.');
    }
    res.json(startEmbeddedLogin(image));
  });

  app.post('/api/sandbox/embedded-login/code', (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    try {
      const status = submitEmbeddedLoginCode(code);
      // Fresh credentials may land within seconds — drop the usage cache so
      // the quota meter picks up the new login promptly.
      invalidateClaudeUsageCache();
      res.json(status);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', (err as Error).message);
    }
  });

  app.delete('/api/sandbox/embedded-login', (_req, res) => {
    res.json(cancelEmbeddedLogin());
  });
}
