/**
 * T17–T26 — Supplement API Clients
 * Export, Deploy, Import, Templates, Media, Routines, MCP, Memory, Plugins
 * SRS FR-09, FR-10, FR-11, FR-12, FR-13, FR-14, FR-16, FR-17, FR-18
 */
import { BaseApiClient } from '../client';
import type {
  PromptTemplateSummary,
  PromptTemplateDetail,
} from '../../types';

// ── T17: Export (FR-09) ─────────────────────────────────────────────────

export class HttpExportApiClient extends BaseApiClient {
  async exportHTML(projectId: string, fileName: string): Promise<Blob> {
    const url = this.buildUrl(
      `/api/projects/${projectId}/files/${encodeURIComponent(fileName)}/export/html`,
    );
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.blob();
  }

  async exportPDF(projectId: string, fileName: string): Promise<Blob> {
    const url = this.buildUrl(
      `/api/projects/${projectId}/files/${encodeURIComponent(fileName)}/export/pdf`,
    );
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`PDF export failed: ${res.status}`);
    return res.blob();
  }

  async downloadArchiveZip(projectId: string): Promise<Blob> {
    const url = this.buildUrl(`/api/projects/${projectId}/archive`);
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Archive failed: ${res.status}`);
    return res.blob();
  }

  async downloadTranscriptMarkdown(projectId: string): Promise<Blob> {
    const url = this.buildUrl(`/api/projects/${projectId}/transcript`);
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Transcript failed: ${res.status}`);
    return res.blob();
  }
}

/** Trigger browser download from a Blob */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── T18: Deploy (FR-10) ─────────────────────────────────────────────────

export interface Deployment {
  id: string;
  projectId: string;
  fileName: string;
  providerId: 'vercel' | 'cloudflare';
  url: string;
  deploymentId?: string;
  deploymentCount: number;
  status: 'ready' | 'pending' | 'failed';
  statusMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface VercelDeployRequest {
  fileName: string;
  token: string;
  teamId?: string;
  projectName?: string;
}

export interface CloudflareDeployRequest {
  fileName: string;
  token: string;
  accountId: string;
  projectName: string;
}

export class HttpDeployApiClient extends BaseApiClient {
  deployToVercel(projectId: string, req: VercelDeployRequest): Promise<Deployment> {
    return this.post(`/api/projects/${projectId}/deployments/vercel`, req);
  }

  deployToCloudflare(projectId: string, req: CloudflareDeployRequest): Promise<Deployment> {
    return this.post(`/api/projects/${projectId}/deployments/cloudflare`, req);
  }

  listDeployments(projectId: string): Promise<Deployment[]> {
    return this.get(`/api/projects/${projectId}/deployments`);
  }

  getDeployment(projectId: string, deploymentId: string): Promise<Deployment> {
    return this.get(`/api/projects/${projectId}/deployments/${deploymentId}`);
  }

  listCloudflareZones(token: string): Promise<Array<{ id: string; name: string }>> {
    return this.post('/api/cloudflare/zones', { token });
  }

  /** Poll deployment until ready or failed, max 120s */
  async pollUntilComplete(
    projectId: string,
    deploymentId: string,
    onUpdate: (d: Deployment) => void,
    maxMs = 120_000,
  ): Promise<Deployment> {
    const start = Date.now();
    let delay = 2000;

    while (Date.now() - start < maxMs) {
      await new Promise<void>((r) => setTimeout(r, delay));
      const d = await this.getDeployment(projectId, deploymentId);
      onUpdate(d);
      if (d.status === 'ready' || d.status === 'failed') return d;
      delay = Math.min(delay * 1.5, 10_000);
    }

    throw new Error('Deployment timed out after 120s');
  }
}

// ── T19: Import (FR-11) ─────────────────────────────────────────────────

export class HttpImportApiClient extends BaseApiClient {
  async importClaudeDesignZip(
    file: File,
  ): Promise<{ projectId: string; name: string }> {
    const formData = new FormData();
    formData.append('zip', file);

    const res = await fetch(this.buildUrl('/api/import/claude-design'), {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Import failed (${res.status}): ${body}`);
    }

    return res.json() as Promise<{ projectId: string; name: string }>;
  }

  importDesignSystemFromGitHub(
    repoUrl: string,
  ): Promise<{ designSystemId: string }> {
    return this.post('/api/design-systems/import/github', { repoUrl });
  }
}

// ── T20: Templates (FR-12) ──────────────────────────────────────────────

export interface ProjectTemplate {
  id: string;
  name: string;
  description?: string;
  sourceProjectId?: string;
  createdAt: number;
}

export class HttpTemplatesApiClient extends BaseApiClient {
  listTemplates(): Promise<ProjectTemplate[]> {
    return this.get('/api/templates');
  }

  getTemplate(id: string): Promise<ProjectTemplate> {
    return this.get(`/api/templates/${id}`);
  }

  createTemplate(req: {
    name: string;
    sourceProjectId: string;
    description?: string;
  }): Promise<ProjectTemplate> {
    return this.post('/api/templates', req);
  }

  updateTemplate(id: string, req: Partial<ProjectTemplate>): Promise<ProjectTemplate> {
    return this.put(`/api/templates/${id}`, req);
  }

  deleteTemplate(id: string): Promise<void> {
    return this.del(`/api/templates/${id}`);
  }
}

// ── T21: Media (FR-13) ───────────────────────────────────────────────────

export interface MediaTask {
  id: string;
  projectId: string;
  kind: 'image' | 'video' | 'audio';
  status: 'pending' | 'processing' | 'ready' | 'failed';
  prompt: string;
  model: string;
  providerId: string;
  resultUrl?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImageGenerationRequest {
  projectId: string;
  prompt: string;
  model: string;
  aspect: '1:1' | '16:9' | '4:3' | '9:16' | '3:4';
}

export interface VideoGenerationRequest {
  projectId: string;
  prompt: string;
  model: 'seedance-2.0' | 'hyperframes-html';
  duration?: number;
  aspect: string;
  sourceImageUrl?: string;
}

export interface AudioGenerationRequest {
  projectId: string;
  kind: 'speech' | 'sound_effects';
  text?: string;
  prompt?: string;
  voiceId?: string;
}

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  preview_url?: string;
}

export class HttpMediaApiClient extends BaseApiClient {
  generateImage(req: ImageGenerationRequest): Promise<MediaTask> {
    return this.post('/api/media/image', req);
  }

  generateVideo(req: VideoGenerationRequest): Promise<MediaTask> {
    return this.post('/api/media/video', req);
  }

  generateAudio(req: AudioGenerationRequest): Promise<MediaTask> {
    return this.post('/api/media/audio', req);
  }

  getTaskStatus(taskId: string): Promise<MediaTask> {
    return this.get(`/api/media/tasks/${taskId}`);
  }

  listMediaTasks(projectId: string): Promise<MediaTask[]> {
    return this.get(`/api/media/tasks?projectId=${projectId}`);
  }

  listVoices(): Promise<ElevenLabsVoice[]> {
    return this.get('/api/elevenlabs/voices');
  }

  /** Poll media task until ready or failed, max 5 min */
  async pollUntilComplete(
    taskId: string,
    onUpdate: (t: MediaTask) => void,
    maxMs = 300_000,
  ): Promise<MediaTask> {
    const start = Date.now();
    let delay = 2000;

    while (Date.now() - start < maxMs) {
      await new Promise<void>((r) => setTimeout(r, delay));
      const task = await this.getTaskStatus(taskId);
      onUpdate(task);
      if (task.status === 'ready' || task.status === 'failed') return task;
      delay = Math.min(delay * 1.5, 15_000);
    }

    throw new Error('Media generation timed out');
  }

  // ── Prompt Templates (NEW — F-04) ──────────────────────────────────────────

  listPromptTemplates(params?: {
    surface?: 'image' | 'video';
    category?: string;
    model?: string;
    q?: string;
  }): Promise<{ items: PromptTemplateSummary[]; total: number }> {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params ?? {}).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
    ).toString();
    return this.get(`/api/prompt-templates${qs ? '?' + qs : ''}`);
  }

  getPromptTemplate(id: string): Promise<PromptTemplateDetail> {
    return this.get(`/api/prompt-templates/${id}`);
  }

  generateFromPromptTemplate(req: {
    templateId: string;
    values: Record<string, string>;
    projectId: string;
    outputAspect?: string;
  }): Promise<MediaTask> {
    return this.post('/api/media/generate-from-template', req);
  }

  getPromptTemplatePreviewUrl(id: string): string {
    return this.buildUrl(`/api/prompt-templates/${id}/preview`);
  }
}

// ── T22: Routines (FR-14) ───────────────────────────────────────────────

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  scheduleKind: 'daily' | 'weekly' | 'once';
  scheduleValue: string;
  projectMode: 'new' | 'existing';
  projectId?: string;
  skillId?: string;
  agentId?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  trigger: 'scheduled' | 'manual';
  status: 'running' | 'succeeded' | 'failed';
  projectId: string;
  startedAt: number;
  completedAt?: number;
  summary?: string;
  error?: string;
}

export class HttpRoutinesApiClient extends BaseApiClient {
  listRoutines(): Promise<Routine[]> {
    return this.get('/api/routines');
  }

  getRoutine(id: string): Promise<Routine> {
    return this.get(`/api/routines/${id}`);
  }

  createRoutine(req: Omit<Routine, 'id' | 'createdAt' | 'updatedAt'>): Promise<Routine> {
    return this.post('/api/routines', req);
  }

  updateRoutine(id: string, req: Partial<Routine>): Promise<Routine> {
    return this.put(`/api/routines/${id}`, req);
  }

  deleteRoutine(id: string): Promise<void> {
    return this.del(`/api/routines/${id}`);
  }

  triggerManualRun(id: string): Promise<RoutineRun> {
    return this.post(`/api/routines/${id}/run`);
  }

  listRoutineRuns(id: string): Promise<RoutineRun[]> {
    return this.get(`/api/routines/${id}/runs`);
  }

  getOrbitStatus(): Promise<{ enabled: boolean; nextRunAt?: number }> {
    return this.get('/api/orbit/status');
  }

  triggerOrbit(): Promise<void> {
    return this.post('/api/orbit/run');
  }
}

// ── T23: MCP (FR-16) ────────────────────────────────────────────────────

export class HttpMCPApiClient extends BaseApiClient {
  getMCPConfig(): Promise<unknown> {
    return this.get('/api/mcp/config');
  }

  updateMCPConfig(config: unknown): Promise<unknown> {
    return this.put('/api/mcp/config', config);
  }

  listMCPTemplates(): Promise<unknown[]> {
    return this.get('/api/mcp/templates');
  }

  beginOAuth(serverId: string): Promise<{ authUrl: string }> {
    return this.post('/api/mcp/oauth/begin', { serverId });
  }

  getTokens(): Promise<unknown[]> {
    return this.get('/api/mcp/tokens');
  }

  refreshToken(serverId: string): Promise<void> {
    return this.post('/api/mcp/oauth/refresh', { serverId });
  }
}

// ── T24: Memory (FR-17) ─────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  content: string;
  source?: string;
  createdAt: number;
}

export class HttpMemoryApiClient extends BaseApiClient {
  listMemory(): Promise<MemoryEntry[]> {
    return this.get('/api/memory');
  }

  extractMemory(messageId: string): Promise<MemoryEntry[]> {
    return this.post('/api/memory/extract', { messageId });
  }

  deleteMemory(id: string): Promise<void> {
    return this.del(`/api/memory/${id}`);
  }
}

// ── T26: Plugins (FR-18) ────────────────────────────────────────────────

export interface Plugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  installed: boolean;
}

export class HttpPluginsApiClient extends BaseApiClient {
  listPlugins(): Promise<Plugin[]> {
    return this.get('/api/plugins');
  }

  getPlugin(id: string): Promise<Plugin> {
    return this.get(`/api/plugins/${id}`);
  }

  installPlugin(source: string): Promise<Plugin> {
    return this.post('/api/plugins/install', { source });
  }

  uninstallPlugin(id: string): Promise<void> {
    return this.post(`/api/plugins/${id}/uninstall`);
  }

  applyPlugin(id: string, projectId: string): Promise<void> {
    return this.post(`/api/plugins/${id}/apply`, { projectId });
  }

  getSnapshot(snapshotId: string): Promise<unknown> {
    return this.get(`/api/plugins/snapshots/${snapshotId}`);
  }
}
