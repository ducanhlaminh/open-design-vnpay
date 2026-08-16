// Figma token routes — GET never leaks the saved token, only whether one is
// set (`hasToken`); PUT writes/clears it; POST /test probes `GET /v1/me`;
// POST /verify-links reads each configured file's name + component count so
// the App form can show a green/red row per link BEFORE the user saves.
// Independent of the generic `/api/mcp/*` routes in mcp-routes.ts.
import type { Express } from 'express';
import type {
  FigmaConfigResponse,
  TestFigmaConfigResponse,
  VerifyFigmaLinksResponse,
} from '@open-design/contracts';

import { readFigmaConfig, resolveFigmaToken, writeFigmaConfig } from './figma-config.js';
import { describeFigmaError, figmaWhoAmI, verifyFigmaLink } from './figma-rest.js';
import type { RouteDeps } from './server-context.js';

export interface RegisterFigmaConfigRoutesDeps extends RouteDeps<'http' | 'paths'> {}

const MAX_LINKS = 5;

function linksOf(body: unknown): Array<{ url: string; fileKey: string }> {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).links : null;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ url: string; fileKey: string }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const fileKey = typeof entry.fileKey === 'string' ? entry.fileKey.trim() : '';
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!/^[A-Za-z0-9]+$/.test(fileKey) || seen.has(fileKey)) continue;
    seen.add(fileKey);
    out.push({ url: url || `https://www.figma.com/design/${fileKey}`, fileKey });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

export function registerFigmaConfigRoutes(app: Express, ctx: RegisterFigmaConfigRoutesDeps) {
  const { isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const { RUNTIME_DATA_DIR } = ctx.paths;

  app.get('/api/figma-config', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const cfg = await readFigmaConfig(RUNTIME_DATA_DIR);
      const body: FigmaConfigResponse = { hasToken: Boolean(cfg?.token) };
      res.json(body);
    } catch (err: any) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/figma-config', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const cfg = await writeFigmaConfig(RUNTIME_DATA_DIR, req.body);
      const body: FigmaConfigResponse = { hasToken: Boolean(cfg?.token) };
      res.json(body);
    } catch (err: any) {
      res.status(400).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/figma-config/test', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const token = await resolveFigmaToken(RUNTIME_DATA_DIR, req.body);
      if (!token) {
        const body: TestFigmaConfigResponse = { ok: false, detail: 'Dán Personal Access Token của Figma trước khi kiểm tra.' };
        return res.json(body);
      }
      try {
        const me = await figmaWhoAmI(token);
        const body: TestFigmaConfigResponse = { ok: true, ...me };
        res.json(body);
      } catch (err) {
        const body: TestFigmaConfigResponse = { ok: false, detail: describeFigmaError(err) };
        res.json(body);
      }
    } catch (err: any) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/figma-config/verify-links', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const token = await resolveFigmaToken(RUNTIME_DATA_DIR, req.body);
      const links = linksOf(req.body);
      const body: VerifyFigmaLinksResponse = {
        hasToken: Boolean(token),
        links: token
          // Sequential on purpose: 1–5 files, and Figma rate-limits per token.
          ? await links.reduce(async (acc, link) => [...(await acc), await verifyFigmaLink(token, link)], Promise.resolve([] as VerifyFigmaLinksResponse['links']))
          : links.map((link) => ({ ...link, ok: false, detail: 'Chưa có token Figma.' })),
      };
      res.json(body);
    } catch (err: any) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });
}
