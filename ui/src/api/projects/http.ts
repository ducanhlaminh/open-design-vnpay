/**
 * T02 — ProjectApiClient
 * Wraps /api/projects/* endpoints from SRS FR-05
 */
import { BaseApiClient } from '../client';
import type {
  Project,
  ProjectFile,
  ProjectMetadata,
  ProjectTemplate,
} from '../../types';

export interface CreateProjectRequest {
  name: string;
  skillId?: string;
  designSystemId?: string;
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
}

export class HttpProjectApiClient extends BaseApiClient {
  listProjects(): Promise<Project[]> {
    return this.get('/api/projects');
  }

  createProject(req: CreateProjectRequest): Promise<Project> {
    return this.post('/api/projects', req);
  }

  getProject(id: string): Promise<Project> {
    return this.get(`/api/projects/${id}`);
  }

  updateProject(id: string, patch: Partial<Project>): Promise<Project> {
    return this.patch(`/api/projects/${id}`, patch);
  }

  deleteProject(id: string): Promise<void> {
    return this.del(`/api/projects/${id}`);
  }

  // ── Files ─────────────────────────────────────────────────────────────

  listFiles(projectId: string): Promise<ProjectFile[]> {
    return this.get(`/api/projects/${projectId}/files`);
  }

  async readFile(projectId: string, name: string): Promise<string> {
    const url = this.buildUrl(
      `/api/projects/${projectId}/files/${encodeURIComponent(name)}`,
    );
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`readFile failed: ${res.status}`);
    return res.text();
  }

  async writeFile(projectId: string, name: string, content: string): Promise<void> {
    await fetch(
      this.buildUrl(
        `/api/projects/${projectId}/files/${encodeURIComponent(name)}`,
      ),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: content,
        credentials: 'include',
      },
    );
  }

  deleteFile(projectId: string, name: string): Promise<void> {
    return this.del(
      `/api/projects/${projectId}/files/${encodeURIComponent(name)}`,
    );
  }

  // Archive / Export helpers (return URL strings, not blobs)
  getArchiveUrl(projectId: string): string {
    return this.buildUrl(`/api/projects/${projectId}/archive`);
  }

  getTranscriptUrl(projectId: string): string {
    return this.buildUrl(`/api/projects/${projectId}/transcript`);
  }

  // ── Templates ──────────────────────────────────────────────────────────

  listTemplates(): Promise<ProjectTemplate[]> {
    return this.get('/api/templates');
  }

  createTemplate(req: {
    name: string;
    sourceProjectId: string;
    description?: string;
  }): Promise<ProjectTemplate> {
    return this.post('/api/templates', req);
  }

  deleteTemplate(id: string): Promise<void> {
    return this.del(`/api/templates/${id}`);
  }
}
