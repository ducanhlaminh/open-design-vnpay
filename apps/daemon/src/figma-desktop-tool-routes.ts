// Figma Desktop tool routes — WP2 of the 2026-08-16 Figma Desktop drill-down
// plan (see specs/change/20260816-figma-desktop-tools/spec.md). Proxies the
// local Figma Desktop Dev Mode MCP server (127.0.0.1:3845) through the
// existing agent-run tool-token machinery so an agent can pull design
// context (layout/color/text/variants/screenshot) for exactly one component
// from a file the App already declared in docsReviewComponentSource.
//
// WP1 (`figma-desktop.ts`) supplies the real MCP client; this module only
// depends on the minimal `FigmaDesktopLike` duck-typed interface below so
// the two work packages can land independently. WP3 wires the real client +
// scope resolver into `server.ts`.
import type { Express, Request, Response } from 'express';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  FigmaDesktopScreenshotResponse,
  FigmaDesktopStatusResponse,
  FigmaDesktopTextToolResponse,
  FigmaDesktopToolName,
} from '@open-design/contracts';

import type { ToolTokenGrant } from './tool-tokens.js';

type SendApiError = (
  res: Response,
  status: number,
  code: string,
  message: string,
  extras?: Record<string, unknown>,
) => void;

/** Minimal surface WP1's real MCP client must implement. Duck-typed on
 *  purpose — WP1 lands in parallel and this file must not import it. */
export interface FigmaDesktopLike {
  probe(): Promise<{ ok: boolean; detail?: string; tools?: string[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; images: Array<{ mimeType: string; data: string }> }>;
  activeFileTitle(): Promise<string | null>;
  ensureActiveFile(
    expect: { fileKey: string; name?: string; probeNodeId?: string; probeName?: string },
    timeoutMs?: number,
  ): Promise<'already' | 'switched'>;
}

/** WP3 supplies the real implementation from `App.docsReviewComponentSource`
 *  + the read `.figma-catalog/components.json`. `null` means the project
 *  does not use figma-links, so every tool call must be denied. */
export interface FigmaDesktopScope {
  /** The run's workflow cwd — where `.figma-catalog/` lives. */
  cwd: string;
  files: Array<{ fileKey: string; name?: string; probeNodeId?: string; probeName?: string }>;
}

export interface RegisterFigmaDesktopToolRoutesDeps {
  auth: {
    authorizeToolRequest: (req: Request, res: Response, operation: string) => ToolTokenGrant | null;
  };
  http: {
    sendApiError: SendApiError;
    isLocalSameOrigin: (req: Request, port: number) => boolean;
    resolvedPortRef: { current: number };
  };
  figma: {
    desktop: FigmaDesktopLike;
    resolveScope: (projectId: string) => Promise<FigmaDesktopScope | null>;
    platform?: NodeJS.Platform;
    now?: () => number;
  };
}

interface FigmaDesktopToolConfig {
  name: FigmaDesktopToolName;
  endpoint: string;
  mcpTool: string;
}

const TOOL_CONFIGS: readonly FigmaDesktopToolConfig[] = [
  { name: 'design-context', endpoint: '/api/tools/figma/design-context', mcpTool: 'get_design_context' },
  { name: 'screenshot', endpoint: '/api/tools/figma/screenshot', mcpTool: 'get_screenshot' },
  { name: 'variable-defs', endpoint: '/api/tools/figma/variable-defs', mcpTool: 'get_variable_defs' },
  { name: 'metadata', endpoint: '/api/tools/figma/metadata', mcpTool: 'get_metadata' },
];

/** "10-1" -> "10:1"; plain node ids must match /^\d+:\d+$/. Instance ids
 *  ("I10:1;20:2") are allowed as-is once restricted to [0-9I:;-]. */
export function normalizeNodeId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = /^\d+-\d+$/.test(trimmed) ? trimmed.replace('-', ':') : trimmed;
  if (/^\d+:\d+$/.test(normalized)) return normalized;
  if (normalized.startsWith('I') && /^[0-9I:;-]+$/.test(normalized)) return normalized;
  return null;
}

function isFigmaDesktopError(err: unknown): err is { kind: string; message?: unknown } {
  return Boolean(err) && typeof err === 'object' && err !== null && 'kind' in err;
}

function mapFigmaDesktopError(err: { kind: string; message?: unknown }): { status: number; code: string; message: string } {
  const message = typeof err.message === 'string' ? err.message : 'Figma Desktop error';
  switch (err.kind) {
    case 'unavailable':
      return { status: 503, code: 'FIGMA_DESKTOP_UNAVAILABLE', message };
    case 'switch_timeout':
      return { status: 504, code: 'FIGMA_SWITCH_TIMEOUT', message };
    case 'switch_unsupported':
      return { status: 501, code: 'FIGMA_SWITCH_UNSUPPORTED', message };
    case 'tool_error':
      return { status: 502, code: 'FIGMA_TOOL_ERROR', message };
    default:
      return { status: 502, code: 'FIGMA_PROXY_ERROR', message };
  }
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpeg';
  if (mimeType.includes('webp')) return 'webp';
  return 'png';
}

// Figma Desktop only ever has one active file, so every call across every
// project/run must be strictly sequential. Module-level on purpose: a
// second `registerFigmaDesktopToolRoutes` call (there is only ever one in
// production) would otherwise race against the first for the one real
// desktop process.
let mutexChain: Promise<unknown> = Promise.resolve();
function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = mutexChain.then(task, task);
  mutexChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 300;

type CacheEntry =
  | { kind: 'text'; expiresAtMs: number; text: string }
  | { kind: 'screenshot'; expiresAtMs: number; path: string; mimeType: string };

// Same reasoning as the mutex: caching is keyed by (tool, fileKey, nodeId,
// languages, frameworks) with no projectId, so it is intentionally shared
// across every project/run that reads the same component.
const cache = new Map<string, CacheEntry>();

function cacheKey(tool: string, fileKey: string, nodeId: string, clientLanguages: string, clientFrameworks: string): string {
  return `${tool}|${fileKey}|${nodeId}|${clientLanguages}|${clientFrameworks}`;
}

function cacheGet(key: string, nowMs: number): CacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAtMs <= nowMs) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (!cache.has(key) && cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, entry);
}

interface AuditEntry {
  ts: string;
  runId: string;
  projectId: string;
  tool: string;
  fileKey: string;
  nodeId: string;
  switched?: 'already' | 'switched';
  cached: boolean;
  ms: number;
  ok: boolean;
  error?: { code: string; message: string };
}

async function appendAudit(cwd: string, entry: AuditEntry): Promise<void> {
  try {
    const dir = path.join(cwd, '.figma-catalog');
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, 'desktop-audit.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.warn('[figma-desktop] failed to write audit log', error);
  }
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export function registerFigmaDesktopToolRoutes(app: Express, ctx: RegisterFigmaDesktopToolRoutesDeps): void {
  const { authorizeToolRequest } = ctx.auth;
  const { sendApiError, isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const { desktop, resolveScope } = ctx.figma;
  const platform = ctx.figma.platform ?? process.platform;
  const now = ctx.figma.now ?? Date.now;

  app.get('/api/figma-desktop/status', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const probe = await desktop.probe();
      const activeFileTitle = probe.ok ? await desktop.activeFileTitle() : null;
      const body: FigmaDesktopStatusResponse = {
        available: probe.ok,
        ...(probe.detail !== undefined ? { detail: probe.detail } : {}),
        activeFileTitle,
        canSwitch: platform === 'darwin' || platform === 'win32',
        platform,
      };
      res.json(body);
    } catch (err: any) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  for (const toolConfig of TOOL_CONFIGS) {
    app.post(toolConfig.endpoint, async (req, res) => {
      const startedAtMs = now();
      const grant = authorizeToolRequest(req, res, `figma:${toolConfig.name}`);
      if (!grant) return;

      const rawFileKey = typeof req.body?.fileKey === 'string' ? req.body.fileKey : '';
      const fileKey = /^[A-Za-z0-9]+$/.test(rawFileKey) ? rawFileKey : null;
      const nodeId = normalizeNodeId(req.body?.nodeId);
      if (!fileKey || !nodeId) {
        return sendApiError(res, 400, 'INVALID_INPUT', 'fileKey and nodeId are required and must be valid');
      }

      const clientLanguages = typeof req.body?.clientLanguages === 'string' ? req.body.clientLanguages : 'unknown';
      const clientFrameworks = typeof req.body?.clientFrameworks === 'string' ? req.body.clientFrameworks : 'unknown';

      const scope = await resolveScope(grant.projectId);
      if (!scope) {
        return sendApiError(res, 404, 'FIGMA_SCOPE_NOT_FOUND', 'Dự án này không cấu hình nguồn Link Figma.');
      }

      const fileEntry = scope.files.find((file) => file.fileKey === fileKey);
      if (!fileEntry) {
        const allowedKeys = scope.files.map((file) => file.fileKey).join(', ');
        const message = `File ${fileKey} không nằm trong danh sách link Figma của App — chỉ được đọc: ${allowedKeys}.`;
        await appendAudit(scope.cwd, {
          ts: new Date(now()).toISOString(),
          runId: grant.runId,
          projectId: grant.projectId,
          tool: toolConfig.name,
          fileKey,
          nodeId,
          cached: false,
          ms: now() - startedAtMs,
          ok: false,
          error: { code: 'FIGMA_FILE_DENIED', message },
        });
        return sendApiError(res, 403, 'FIGMA_FILE_DENIED', message);
      }

      const key = cacheKey(toolConfig.name, fileKey, nodeId, clientLanguages, clientFrameworks);
      const cached = cacheGet(key, now());
      if (cached) {
        if (cached.kind === 'screenshot') {
          const absolutePath = path.join(scope.cwd, cached.path);
          if (await fileExists(absolutePath)) {
            const body: FigmaDesktopScreenshotResponse = {
              ok: true,
              tool: 'screenshot',
              fileKey,
              nodeId,
              switched: 'already',
              cached: true,
              path: cached.path,
              mimeType: cached.mimeType,
            };
            await appendAudit(scope.cwd, {
              ts: new Date(now()).toISOString(),
              runId: grant.runId,
              projectId: grant.projectId,
              tool: toolConfig.name,
              fileKey,
              nodeId,
              switched: 'already',
              cached: true,
              ms: now() - startedAtMs,
              ok: true,
            });
            return res.json(body);
          }
          // Cached file is gone from disk — fall through and redo the call.
        } else {
          const body: FigmaDesktopTextToolResponse = {
            ok: true,
            tool: toolConfig.name,
            fileKey,
            nodeId,
            switched: 'already',
            cached: true,
            text: cached.text,
          };
          await appendAudit(scope.cwd, {
            ts: new Date(now()).toISOString(),
            runId: grant.runId,
            projectId: grant.projectId,
            tool: toolConfig.name,
            fileKey,
            nodeId,
            switched: 'already',
            cached: true,
            ms: now() - startedAtMs,
            ok: true,
          });
          return res.json(body);
        }
      }

      try {
        const result = await runExclusive(async () => {
          const switched = await desktop.ensureActiveFile(fileEntry);
          if (toolConfig.name === 'screenshot') {
            const toolResult = await desktop.callTool('get_screenshot', { nodeId });
            const image = toolResult.images[0];
            if (!image) {
              throw { kind: 'tool_error', message: 'Figma không trả ảnh' };
            }
            const ext = extensionForMimeType(image.mimeType);
            const relativePath = path.posix.join('.figma-catalog', 'shots', fileKey, `${nodeId.replace(/:/g, '-')}.${ext}`);
            const absolutePath = path.join(scope.cwd, relativePath);
            await mkdir(path.dirname(absolutePath), { recursive: true });
            await writeFile(absolutePath, Buffer.from(image.data, 'base64'));
            return { switched, path: relativePath, mimeType: image.mimeType, text: undefined as string | undefined };
          }
          const toolResult = await desktop.callTool(toolConfig.mcpTool, { nodeId, clientLanguages, clientFrameworks });
          return { switched, text: toolResult.text, path: undefined as string | undefined, mimeType: undefined as string | undefined };
        });

        const ms = now() - startedAtMs;
        if (toolConfig.name === 'screenshot' && result.path !== undefined && result.mimeType !== undefined) {
          cacheSet(key, { kind: 'screenshot', expiresAtMs: now() + CACHE_TTL_MS, path: result.path, mimeType: result.mimeType });
          await appendAudit(scope.cwd, {
            ts: new Date(now()).toISOString(),
            runId: grant.runId,
            projectId: grant.projectId,
            tool: toolConfig.name,
            fileKey,
            nodeId,
            switched: result.switched,
            cached: false,
            ms,
            ok: true,
          });
          console.info(`[figma-desktop] ${toolConfig.name} ${fileKey}#${nodeId} ok ${ms}ms`);
          const body: FigmaDesktopScreenshotResponse = {
            ok: true,
            tool: 'screenshot',
            fileKey,
            nodeId,
            switched: result.switched,
            cached: false,
            path: result.path,
            mimeType: result.mimeType,
          };
          return res.json(body);
        }

        if (result.text !== undefined) {
          cacheSet(key, { kind: 'text', expiresAtMs: now() + CACHE_TTL_MS, text: result.text });
          await appendAudit(scope.cwd, {
            ts: new Date(now()).toISOString(),
            runId: grant.runId,
            projectId: grant.projectId,
            tool: toolConfig.name,
            fileKey,
            nodeId,
            switched: result.switched,
            cached: false,
            ms,
            ok: true,
          });
          console.info(`[figma-desktop] ${toolConfig.name} ${fileKey}#${nodeId} ok ${ms}ms`);
          const body: FigmaDesktopTextToolResponse = {
            ok: true,
            tool: toolConfig.name,
            fileKey,
            nodeId,
            switched: result.switched,
            cached: false,
            text: result.text,
          };
          return res.json(body);
        }

        // Unreachable in practice — guards TypeScript's narrowing above.
        return sendApiError(res, 502, 'FIGMA_PROXY_ERROR', 'Figma Desktop returned an unexpected result shape');
      } catch (error) {
        const ms = now() - startedAtMs;
        const mapped = isFigmaDesktopError(error)
          ? mapFigmaDesktopError(error)
          : { status: 502, code: 'FIGMA_PROXY_ERROR', message: error instanceof Error ? error.message : String(error) };
        await appendAudit(scope.cwd, {
          ts: new Date(now()).toISOString(),
          runId: grant.runId,
          projectId: grant.projectId,
          tool: toolConfig.name,
          fileKey,
          nodeId,
          cached: false,
          ms,
          ok: false,
          error: { code: mapped.code, message: mapped.message },
        });
        console.info(`[figma-desktop] ${toolConfig.name} ${fileKey}#${nodeId} ${mapped.code} ${ms}ms`);
        return sendApiError(res, mapped.status, mapped.code, mapped.message);
      }
    });
  }
}
