/**
 * T04–T08 — Domain API Clients
 * DesignSystems, Skills, Config, Agents, Connectors
 * SRS FR-03, FR-04, FR-21, FR-01, FR-22
 */
import { BaseApiClient } from '../client';
import type {
  DesignSystemSummary,
  DesignSystemDetail,
  DesignTemplateSummary,
  TemplateMode,
  SkillSummary,
  SkillDetail,
  AgentInfo,
  AppConfig,
} from '../../types';

// ── T04: Design Systems (FR-04) ───────────────────────────────────────────

export class HttpDesignSystemApiClient extends BaseApiClient {
  listDesignSystems(params?: {
    category?: string;
    q?: string;
    source?: 'bundled' | 'imported' | 'generated';
  }): Promise<DesignSystemSummary[]> {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params ?? {}).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
    ).toString();
    return this.get(`/api/design-systems${qs ? '?' + qs : ''}`);
  }

  getDesignSystem(id: string): Promise<DesignSystemDetail> {
    return this.get(`/api/design-systems/${id}`);
  }

  // URL builders — return URL strings for iframe/fetch, no API call
  getTokensCssUrl(id: string): string {
    return this.buildUrl(`/api/design-systems/${id}/tokens.css`);
  }

  getComponentsUrl(id: string): string {
    return this.buildUrl(`/api/design-systems/${id}/components`);
  }

  getDesignMdUrl(id: string): string {
    return this.buildUrl(`/api/design-systems/${id}/design.md`);
  }

  getPreviewPageUrl(id: string, role: string): string {
    return this.buildUrl(`/api/design-systems/${id}/preview/${role}`);
  }

  getAssetUrl(id: string, path: string): string {
    return this.buildUrl(`/api/design-systems/${id}/assets/${path}`);
  }

  /** @deprecated use getPreviewPageUrl instead */
  getPreviewUrl(id: string): string {
    return this.buildUrl(`/api/design-systems/${id}/preview`);
  }

  getShowcaseUrl(id: string): string {
    return this.buildUrl(`/api/design-systems/${id}/showcase`);
  }

  createDesignSystem(data: { name: string; content: string }): Promise<DesignSystemDetail> {
    return this.post('/api/design-systems', data);
  }

  updateDesignSystem(
    id: string,
    data: Partial<{ name: string; content: string }>,
  ): Promise<DesignSystemDetail> {
    return this.put(`/api/design-systems/${id}`, data);
  }

  deleteDesignSystem(id: string): Promise<void> {
    return this.del(`/api/design-systems/${id}`);
  }

  importFromGitHub(repoUrl: string): Promise<DesignSystemDetail> {
    return this.post('/api/design-systems/import/github', { repoUrl });
  }
}

// ── F-05: HttpDesignTemplateApiClient (NEW — F-03/F-05) ──────────────────────

export class HttpDesignTemplateApiClient extends BaseApiClient {
  listDesignTemplates(params?: {
    mode?: TemplateMode;
    q?: string;
    scenario?: string;
  }): Promise<{ items: DesignTemplateSummary[]; total: number }> {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params ?? {}).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
    ).toString();
    return this.get(`/api/design-templates${qs ? '?' + qs : ''}`);
  }

  getDesignTemplate(id: string): Promise<DesignTemplateSummary> {
    return this.get(`/api/design-templates/${id}`);
  }

  // URL builders
  getTemplateExampleUrl(id: string): string {
    return this.buildUrl(`/api/design-templates/${id}/example`);
  }

  getTemplateDerivedExampleUrl(id: string, key: string): string {
    return this.buildUrl(`/api/design-templates/${id}/examples/${key}`);
  }

  getTemplateAssetUrl(id: string, path: string): string {
    return this.buildUrl(`/api/design-templates/${id}/assets/${path}`);
  }
}

// ── T05: Skills (FR-03) ──────────────────────────────────────────────────

export class HttpSkillApiClient extends BaseApiClient {
  listSkills(): Promise<SkillSummary[]> {
    return this.get('/api/skills');
  }

  getSkill(id: string): Promise<SkillDetail> {
    return this.get(`/api/skills/${id}`);
  }

  getExampleUrl(id: string): string {
    return this.buildUrl(`/api/skills/${id}/example`);
  }
}

// ── T06: Config (FR-21) ─────────────────────────────────────────────────

export class HttpConfigApiClient extends BaseApiClient {
  getConfig(): Promise<AppConfig> {
    return this.get('/api/config');
  }

  updateConfig(config: Partial<AppConfig>): Promise<AppConfig> {
    return this.put('/api/config', config);
  }

  async health(): Promise<boolean> {
    try {
      await this.get('/api/health');
      return true;
    } catch {
      return false;
    }
  }

  testConnection(req: {
    protocol: string;
    apiKey: string;
    baseUrl: string;
    model: string;
  }): Promise<{ ok: boolean; error?: string }> {
    return this.post('/api/connection-test', req);
  }
}

// ── T07: Agents (FR-01) ──────────────────────────────────────────────────

export class HttpAgentApiClient extends BaseApiClient {
  listAgents(): Promise<AgentInfo[]> {
    return this.get('/api/agents');
  }

  testAgent(agentId: string): Promise<{ ok: boolean; error?: string }> {
    return this.post('/api/agents/test', { agentId });
  }
}

// ── T08: Connectors (FR-22) ─────────────────────────────────────────────

export interface Connector {
  id: string;
  name: string;
  description?: string;
  connected: boolean;
  authStatus?: 'connected' | 'expired' | 'disconnected';
}

export class HttpConnectorsApiClient extends BaseApiClient {
  listConnectors(): Promise<Connector[]> {
    return this.get('/api/connectors');
  }

  getConnector(id: string): Promise<Connector> {
    return this.get(`/api/connectors/${id}`);
  }

  connect(id: string): Promise<{ authUrl?: string }> {
    return this.post(`/api/connectors/${id}/connect`);
  }

  disconnect(id: string): Promise<void> {
    return this.del(`/api/connectors/${id}`);
  }

  getComposioConfig(): Promise<{ apiKey?: string; apiKeyConfigured?: boolean }> {
    return this.get('/api/composio/config');
  }

  updateComposioConfig(config: { apiKey: string }): Promise<void> {
    return this.put('/api/composio/config', config);
  }
}
