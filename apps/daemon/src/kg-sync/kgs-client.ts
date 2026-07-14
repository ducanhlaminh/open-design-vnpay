// Minimal KGS (Knowledge Graph Store) HTTP client for design-v3 sync.
//
// Read path mirrors preview-content's Go client: structured entity/edge queries
// against the namespaced read API (`/kg/graph/<appId>/<tenant>/...`). Write path
// mirrors skills/.../push_to_kgs.py: the graph write API (`/v1/graph/nodes`,
// `/v1/graph/edges`) which feeds KGS's outbox → Neo4j projection. 409 = the row
// already exists and is treated as success.
//
// Config comes from the environment (same names as push_to_kgs.py):
//   KGS_URL      default http://localhost:28001
//   KGS_APP_ID   default design-v3   (the unified central KG)
//   KGS_TENANT   default default
//   KGS_API_KEY  optional — bootstrap-minted on first use when absent

export interface KgsEntity {
  entityId: string;
  entityType?: string; // the node label (DP_*); needed to round-trip on push
  name?: string;
  properties: Record<string, unknown>;
}

export interface KgsEdge {
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  properties: Record<string, unknown>;
}

export interface KgsClientConfig {
  baseUrl: string;
  appId: string;
  tenant: string;
  apiKey?: string;
}

export function kgsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): KgsClientConfig {
  const apiKey = env.KGS_API_KEY;
  return {
    baseUrl: (env.KGS_URL || 'http://localhost:28001').replace(/\/+$/, ''),
    appId: env.KGS_APP_ID || 'design-v3',
    tenant: env.KGS_TENANT || 'default',
    ...(apiKey ? { apiKey } : {}),
  };
}

export class KgsClient {
  private apiKey: string | undefined;

  constructor(private readonly cfg: KgsClientConfig) {
    this.apiKey = cfg.apiKey;
  }

  private namespace(): string {
    return `graph/${this.cfg.appId}/${this.cfg.tenant}`;
  }

  // Resolve an API key, bootstrap-minting one when none is configured (OPA is
  // allow-all in the local stack, matching preview-content's dv3Key).
  private async key(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const url = `${this.cfg.baseUrl}/v1/apps/${this.cfg.appId}/keys`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'bootstrap' },
      body: JSON.stringify({ name: 'open-design-kg-sync', scopes: 'all', ttl_seconds: 0 }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`mint KGS key: HTTP ${res.status}: ${text.slice(0, 200)}`);
    const body = text ? (JSON.parse(text) as { apiKey?: string }) : {};
    if (!body.apiKey) throw new Error(`mint KGS key: no apiKey in response: ${text.slice(0, 200)}`);
    this.apiKey = body.apiKey;
    return this.apiKey;
  }

  // ── reads (pull) ───────────────────────────────────────────────────────────

  // Query entities by label(s) + exact-property match. Empty `labels` means "any
  // label". The server clamps limit to 1000 and paginates by offset, so this
  // walks pages until the result set is exhausted (or `cap` is reached).
  async queryEntities(labels: string[], propertyEq: Record<string, string>, cap = 20000): Promise<KgsEntity[]> {
    const key = await this.key();
    const url = `${this.cfg.baseUrl}/kg/${this.namespace()}/entities/query`;
    const pageSize = 1000;
    const out: KgsEntity[] = [];
    for (let offset = 0; offset < cap; offset += pageSize) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify({ labels, property_eq: propertyEq, limit: pageSize, offset }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`entities/query HTTP ${res.status}: ${text.slice(0, 200)}`);
      const body = text ? (JSON.parse(text) as { entities?: KgsEntity[] }) : {};
      const page = body.entities ?? [];
      out.push(...page);
      if (page.length < pageSize) break;
    }
    return out;
  }

  // Fetch edges, following pagination cursors. Both filters are optional: empty
  // relationType means "all relations", omitted fromEntityId means "all sources".
  // maxPages caps the walk (each page is up to 1000 edges).
  async edges(relationType = '', fromEntityId?: string, maxPages = 10): Promise<KgsEdge[]> {
    const key = await this.key();
    const out: KgsEdge[] = [];
    let cursor = '';
    for (let page = 0; page < maxPages; page++) {
      let url = `${this.cfg.baseUrl}/kg/${this.namespace()}/edges?relationType=${encodeURIComponent(relationType)}&limit=1000`;
      if (fromEntityId) url += `&fromEntityId=${encodeURIComponent(fromEntityId)}`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      const res = await fetch(url, { headers: { 'X-API-Key': key } });
      const text = await res.text();
      if (!res.ok) throw new Error(`edges HTTP ${res.status}: ${text.slice(0, 200)}`);
      const body = text
        ? (JSON.parse(text) as { edges?: KgsEdge[]; nextCursor?: string; hasMore?: boolean })
        : {};
      out.push(...(body.edges ?? []));
      if (!body.hasMore || !body.nextCursor) break;
      cursor = body.nextCursor;
    }
    return out;
  }

  // All edges in the app graph (no filter), fully paginated. Used to build the
  // in-memory adjacency for workspace-anchored project pulls.
  async allEdges(maxPages = 200): Promise<KgsEdge[]> {
    return this.edges('', undefined, maxPages);
  }

  // ── writes (push) ──────────────────────────────────────────────────────────
  // Returns 'ok' on 2xx, 'exists' on 409 (idempotent), throws otherwise.

  async createNode(label: string, props: Record<string, unknown>): Promise<'ok' | 'exists'> {
    const key = await this.key();
    const res = await fetch(`${this.cfg.baseUrl}/v1/graph/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ label, propertiesJson: JSON.stringify(props) }),
    });
    if (res.status === 409) return 'exists';
    if (!res.ok) throw new Error(`createNode HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return 'ok';
  }

  async createEdge(
    sourceNodeId: string,
    targetNodeId: string,
    relationType: string,
    props: Record<string, unknown>,
  ): Promise<'ok' | 'exists'> {
    const key = await this.key();
    const res = await fetch(`${this.cfg.baseUrl}/v1/graph/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ sourceNodeId, targetNodeId, relationType, propertiesJson: JSON.stringify(props) }),
    });
    if (res.status === 409) return 'exists';
    if (!res.ok) throw new Error(`createEdge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return 'ok';
  }

  // Verify a node landed (read-back) — used by push to not trust outbox "DONE".
  async nodeExists(entityId: string): Promise<boolean> {
    const ents = await this.queryEntities([], { id: entityId }, 1);
    return ents.length > 0;
  }

  // Ensure a DP_UI_WORKSPACE node exists for this project. pull-all discovers
  // projects by enumerating DP_UI_WORKSPACE, so a locally-created ("New project")
  // app is invisible cross-device until it has one. Idempotent: queries by
  // projectId first and only creates when absent (createNode has no upsert, so
  // skipping the existence check would mint a duplicate workspace on every push).
  async ensureWorkspace(
    projectId: string,
    name: string,
    owner?: { id: string; email: string; name?: string } | null,
  ): Promise<'created' | 'exists'> {
    const existing = await this.queryEntities(['DP_UI_WORKSPACE'], { projectId }, 1);
    if (existing.length > 0) return 'exists';
    // Owner attribution (the machine's last Google login — see auth-routes
    // getMachineUser) rides on the node itself so graph consumers can answer
    // "whose project is this" without a join. CreateNode has no upsert:
    // pre-existing workspaces keep whatever they were created with.
    await this.createNode('DP_UI_WORKSPACE', {
      projectId,
      kind: 'project',
      name,
      ...(owner ? { owner_id: owner.id, owner_email: owner.email, owner_name: owner.name ?? '' } : {}),
    });
    return 'created';
  }

  // ── pipeline file store (non-graph artifact tracking) ────────────────────────
  // Raw stage-output files stored in KGS Postgres (NOT projected to Neo4j),
  // scoped by app/tenant/project. This is the B1 (upload) + cross-device handoff.

  async uploadFile(projectId: string, stage: string, filePath: string, mime: string, content: Buffer): Promise<Record<string, unknown>> {
    const key = await this.key();
    const res = await fetch(`${this.cfg.baseUrl}/kg/${this.namespace()}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({
        project_id: projectId,
        stage,
        path: filePath,
        mime,
        content_base64: content.toString('base64'),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`uploadFile HTTP ${res.status}: ${text.slice(0, 200)}`);
    const body = text ? (JSON.parse(text) as { file?: Record<string, unknown> }) : {};
    return body.file ?? {};
  }

  async listFiles(projectId: string, stage = ''): Promise<Array<Record<string, unknown>>> {
    const key = await this.key();
    let url = `${this.cfg.baseUrl}/kg/${this.namespace()}/files?project_id=${encodeURIComponent(projectId)}`;
    if (stage) url += `&stage=${encodeURIComponent(stage)}`;
    const res = await fetch(url, { headers: { 'X-API-Key': key } });
    const text = await res.text();
    if (!res.ok) throw new Error(`listFiles HTTP ${res.status}: ${text.slice(0, 200)}`);
    const body = text ? (JSON.parse(text) as { files?: Array<Record<string, unknown>> }) : {};
    return body.files ?? [];
  }

  async downloadFile(projectId: string, filePath: string): Promise<Buffer> {
    const key = await this.key();
    const url = `${this.cfg.baseUrl}/kg/${this.namespace()}/files/content?project_id=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filePath)}`;
    const res = await fetch(url, { headers: { 'X-API-Key': key } });
    if (!res.ok) throw new Error(`downloadFile HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async setFileStatus(projectId: string, stage: string, filePath: string, status: string): Promise<void> {
    const key = await this.key();
    const res = await fetch(`${this.cfg.baseUrl}/kg/${this.namespace()}/files/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ project_id: projectId, stage, path: filePath, status }),
    });
    if (!res.ok) throw new Error(`setFileStatus HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
