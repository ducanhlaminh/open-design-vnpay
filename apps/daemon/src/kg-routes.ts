import type { Express } from 'express';
import type { RouteDeps } from './server-context.js';
import type { KgProjectsResponse, KgPushDocument, KgPushResponse } from '@open-design/contracts';
import { validateKgPushDocument } from '@open-design/contracts';
import { KG_SCHEMA, LABEL_COUNTER } from './kg-schema.js';

export interface RegisterKgRoutesDeps
  extends RouteDeps<'http' | 'paths' | 'projectStore' | 'projectFiles'> {}

// KGS connection config. Mirrors the customer-journey-spec / ux-spec skills'
// scripts/push_to_kgs.py defaults so the web button, `od kg push`, and the CLI
// script all target the same open-design producer app.
//
// Defaults are wired for the local dev stack so "Push to KG" works with ZERO
// env setup. The fallback API key is the local open-design-app read key already
// committed in the platform repo's deploy/local/be-native/configs/unified.yaml
// (a local-dev key, not a production secret). Override any of these via env
// (KGS_URL / KGS_API_KEY / KGS_APP_ID) for other environments.
const DEFAULT_KGS_LOCAL_KEY = 'kgs_ak_5608b4b2205f03e5364a4a2542ca9f169110c11f1e868983';
function kgsConfig() {
  const url = (process.env.KGS_URL || 'http://localhost:28001').replace(/\/+$/, '');
  const apiKey = process.env.KGS_API_KEY || DEFAULT_KGS_LOCAL_KEY;
  const appId = process.env.KGS_APP_ID || 'open-design-app';
  return { url, apiKey, appId };
}

interface PushOutcome {
  pushed: number;
  personas: number;
  journeys: number;
  stages: number;
  screens: number;
  components: number;
  edges: number;
  warnings: string[];
}

async function postNode(
  cfg: ReturnType<typeof kgsConfig>,
  label: string,
  props: Record<string, unknown>,
  warnings: string[],
): Promise<boolean> {
  const res = await fetch(`${cfg.url}/v1/graph/nodes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey },
    body: JSON.stringify({ label, propertiesJson: JSON.stringify(props) }),
  });
  if (res.ok || res.status === 409) return true; // 409 = already exists → OK
  const text = await res.text().catch(() => '');
  warnings.push(`${label} ${String(props.id)}: ${res.status} ${text.slice(0, 120)}`);
  return false;
}

async function postEdge(
  cfg: ReturnType<typeof kgsConfig>,
  sourceNodeId: string,
  targetNodeId: string,
  relationType: string,
  warnings: string[],
): Promise<boolean> {
  if (!sourceNodeId || !targetNodeId) return false;
  const res = await fetch(`${cfg.url}/v1/graph/edges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey },
    body: JSON.stringify({
      sourceNodeId,
      targetNodeId,
      relationType,
      propertiesJson: JSON.stringify({ app_id: cfg.appId, _seed: 'open-design-cj' }),
    }),
  });
  if (res.ok || res.status === 409) return true;
  const text = await res.text().catch(() => '');
  warnings.push(`edge ${relationType} ${sourceNodeId}->${targetNodeId}: ${res.status} ${text.slice(0, 120)}`);
  return false;
}

/**
 * Push a CJ + UX Spec document into the KGS open-design app. Labels + props
 * match preview-content's node_mapper exactly (USER_FLOW / STAGE /
 * UX_PERSONA_PROFILE / S_SCREEN_SPEC / DP_UI_COMPONENT), and every node is
 * tagged with `projectId` so SimStudio's /sync/pull scopes it.
 */
async function pushDocument(
  doc: KgPushDocument,
  projectId: string,
  cfg: ReturnType<typeof kgsConfig>,
): Promise<PushOutcome> {
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const created = new Set<string>();
  const edgeList: Array<[string, string, string]> = []; // [source, target, relationType]
  const bump = (label: string) => {
    counts[label] = (counts[label] ?? 0) + 1;
  };
  const base = (props: Record<string, unknown>, id: string) => ({
    ...props,
    id,
    app_id: cfg.appId,
    project_id: projectId, // ← scope to the project (REQUIRED)
    _seed: 'open-design-cj',
  });
  const arr = (obj: unknown, key: string): unknown[] => {
    const v = (obj as Record<string, unknown> | null | undefined)?.[key];
    return Array.isArray(v) ? v : [];
  };

  // Generic walk of the declarative schema (kg-schema.ts). Nodes first, edges
  // collected as we go and created after (so both endpoints exist on projection).
  for (const ent of KG_SCHEMA) {
    for (const [i, item] of arr(doc, ent.key).entries()) {
      const id = ent.id(item, projectId, i);
      if (await postNode(cfg, ent.label, base(ent.props(item), id), warnings)) {
        bump(ent.label);
        created.add(id);
      }
      for (const child of ent.children ?? []) {
        for (const [k, kid] of arr(item, child.key).entries()) {
          const cid = child.id(kid, id, k);
          if (await postNode(cfg, child.label, base(child.props(kid, id, k), cid), warnings)) {
            bump(child.label);
            created.add(cid);
            if (child.edgeToParent) edgeList.push([id, cid, child.edgeToParent]);
          }
        }
      }
      for (const link of ent.links ?? []) {
        const tgt = link.target(item);
        if (tgt) edgeList.push([id, tgt, link.relation]);
      }
    }
  }

  // Edges — only when BOTH endpoints were actually created (no dangling edges).
  let edges = 0;
  for (const [src, tgt, rel] of edgeList) {
    if (!created.has(src) || !created.has(tgt)) continue;
    if (await postEdge(cfg, src, tgt, rel, warnings)) edges++;
  }

  const out: PushOutcome = {
    pushed: 0,
    personas: 0,
    journeys: 0,
    stages: 0,
    screens: 0,
    components: 0,
    edges,
    warnings,
  };
  for (const [label, n] of Object.entries(counts)) {
    out.pushed += n;
    const field = LABEL_COUNTER[label];
    if (field) out[field] += n;
  }
  return out;
}

export function registerKgRoutes(app: Express, ctx: RegisterKgRoutesDeps) {
  const { sendApiError } = ctx.http;
  const { PROJECTS_DIR } = ctx.paths;
  const { getProject } = ctx.projectStore;
  const { readProjectFile } = ctx.projectFiles;

  // POST /api/kg/push — push a Customer Journey + UX Spec document into KGS
  // (open-design app). Body: { projectId, filePath? | json? }. Dual-track:
  // the FileViewer "Push to KG" button and `od kg push` both call this.
  app.post('/api/kg/push', async (req, res) => {
    try {
      const input = req.body || {};
      const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId is required');
      }

      const cfg = kgsConfig();
      if (!cfg.apiKey) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'KGS_API_KEY env not set (open-design app key). Set KGS_URL / KGS_API_KEY / KGS_APP_ID for the daemon.',
        );
      }

      let doc: KgPushDocument | undefined;
      if (input.json && typeof input.json === 'object') {
        doc = input.json as KgPushDocument;
      } else if (typeof input.filePath === 'string' && input.filePath.trim()) {
        const odProjectId =
          typeof input.odProjectId === 'string' && input.odProjectId.trim()
            ? input.odProjectId.trim()
            : projectId;
        const project = await getProject(odProjectId).catch(() => null);
        const entry = await readProjectFile(PROJECTS_DIR, odProjectId, input.filePath, project?.metadata);
        try {
          doc = JSON.parse(entry.buffer.toString('utf8')) as KgPushDocument;
        } catch (e: any) {
          return sendApiError(res, 400, 'BAD_REQUEST', `file is not valid JSON: ${String(e?.message || e)}`);
        }
      } else {
        return sendApiError(res, 400, 'BAD_REQUEST', 'either filePath or json is required');
      }

      // Validate against the shared KG schema (same validator the FileViewer
      // button uses) — push is only allowed for a schema-valid document.
      const validation = validateKgPushDocument(doc);
      if (!validation.valid) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          `document failed KG schema validation: ${validation.errors.join('; ')}`,
        );
      }

      const out = await pushDocument(doc!, projectId, cfg);
      const body: KgPushResponse = {
        ok: true,
        pushed: out.pushed,
        personas: out.personas,
        journeys: out.journeys,
        stages: out.stages,
        screens: out.screens,
        components: out.components,
        edges: out.edges,
        ...(out.warnings.length ? { warnings: out.warnings } : {}),
      };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  // GET /api/kg/projects — list SimStudio projects so the FileViewer "Push to
  // KG" dropdown can pick a target. Proxies preview-project's list endpoint
  // (single-tenant: returns all projects; only needs a non-empty X-User-ID).
  // Configure with SIMSTUDIO_PROJECT_URL (default http://localhost:8101) and,
  // when going through the auth gateway, SIMSTUDIO_TOKEN.
  app.get('/api/kg/projects', async (_req, res) => {
    try {
      const base = (process.env.SIMSTUDIO_PROJECT_URL || 'http://localhost:8101').replace(/\/+$/, '');
      // preview-project's list is owner-scoped (returns projects owned by the
      // X-User-ID caller). Default to the local admin@vnp.vn user id so the
      // dropdown shows the same projects the SimStudio UI shows. Override via
      // SIMSTUDIO_USER_ID (or SIMSTUDIO_TOKEN when going through the gateway).
      const headers: Record<string, string> = {
        'X-User-ID': process.env.SIMSTUDIO_USER_ID || '047edf3a-dcec-44d5-a3a5-c47e366fdaf6',
      };
      if (process.env.SIMSTUDIO_TOKEN) headers.Authorization = `Bearer ${process.env.SIMSTUDIO_TOKEN}`;
      const upstream = await fetch(`${base}/api/v1/projects?limit=200`, { headers });
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return sendApiError(
          res,
          502,
          'UPSTREAM_ERROR',
          `preview-project ${upstream.status}: ${text.slice(0, 160)}`,
        );
      }
      const data = (await upstream.json().catch(() => ({}))) as {
        projects?: Array<{ id?: string; name?: string }>;
      };
      const projects = (Array.isArray(data.projects) ? data.projects : [])
        .filter((p) => typeof p?.id === 'string' && p.id)
        .map((p) => ({ id: String(p.id), name: String(p.name ?? p.id) }));
      const body: KgProjectsResponse = { projects };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 502, 'UPSTREAM_ERROR', String(err?.message || err));
    }
  });
}
