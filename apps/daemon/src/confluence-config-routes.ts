// Confluence credential routes — GET never leaks the saved token, only
// whether one is set (`hasToken`); PUT writes the file. Independent of the
// generic `/api/mcp/*` routes in mcp-routes.ts.
import type { Express } from 'express';

import {
  configuredConfluenceBase,
  readConfluenceConfig,
  testConfluenceConnection,
  writeConfluenceConfig,
} from './confluence-config.js';
import type { RouteDeps } from './server-context.js';

export interface RegisterConfluenceConfigRoutesDeps extends RouteDeps<'http' | 'paths'> {}

export function registerConfluenceConfigRoutes(app: Express, ctx: RegisterConfluenceConfigRoutesDeps) {
  const { isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const { RUNTIME_DATA_DIR } = ctx.paths;

  app.get('/api/confluence-config', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const cfg = await readConfluenceConfig(RUNTIME_DATA_DIR);
      res.json({ base: configuredConfluenceBase(), hasToken: Boolean(cfg?.token) });
    } catch (err: any) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/confluence-config', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const base = configuredConfluenceBase();
      if (!base) return res.status(503).json({ error: 'CONFLUENCE_URL is not configured' });
      const cfg = await writeConfluenceConfig(
        RUNTIME_DATA_DIR,
        req.body?.clear === true ? { base: '', token: '' } : { ...req.body, base },
      );
      res.json({ base, hasToken: Boolean(cfg?.token) });
    } catch (err: any) {
      res.status(400).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/confluence-config/test', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const base = configuredConfluenceBase();
      if (!base) return res.status(503).json({ error: 'CONFLUENCE_URL is not configured' });
      const result = await testConfluenceConnection(RUNTIME_DATA_DIR, { ...req.body, base });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });
}
