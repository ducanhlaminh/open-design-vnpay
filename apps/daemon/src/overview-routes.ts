import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Express } from 'express';

import {
  getProject,
  insertProject,
  listPipelineApps,
  getProjectPipelineState,
  listProjects,
  updateProject,
} from './db.js';
import {
  WORKFLOWS,
  deriveStateFromLocalFiles,
  mergePipelineState,
} from './pipelines.js';
import {
  countWorkflowProgress,
  isKgsProject,
} from './pipeline-routes.js';
import type { RouteDeps } from './server-context.js';

export const OVERVIEW_PROJECT_ID = 'overview';

export interface RegisterOverviewRoutesDeps extends RouteDeps<'db' | 'paths' | 'pipelines'> {}

export async function ensureOverviewProject(db: any, projectsDir: string) {
  await mkdir(path.join(projectsDir, OVERVIEW_PROJECT_ID), { recursive: true });
  const now = Date.now();
  const existing = getProject(db, OVERVIEW_PROJECT_ID);
  if (existing) {
    return updateProject(db, OVERVIEW_PROJECT_ID, {
      name: 'Workspace tổng',
      metadata: { ...existing.metadata, kind: 'overview' },
      updatedAt: now,
    });
  }
  try {
    return insertProject(db, {
      id: OVERVIEW_PROJECT_ID,
      name: 'Workspace tổng',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'overview' },
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    // Hai request đầu tiên chạy đồng thời (Home + tab Overview cùng mở) có
    // thể cùng thấy "chưa có" — insert thua cuộc đua thì UNIQUE fail; đọc
    // lại row của người thắng thay vì nổ 500.
    return getProject(db, OVERVIEW_PROJECT_ID);
  }
}

export function registerOverviewRoutes(app: Express, ctx: RegisterOverviewRoutesDeps) {
  const { db, paths, pipelines } = ctx;

  app.get('/api/overview/summary', async (_req, res) => {
    await ensureOverviewProject(db, paths.PROJECTS_DIR);
    const projects = listProjects(db).filter((project: { metadata?: unknown }) => isKgsProject(project));
    const appEntries = new Map<string, string>();
    for (const app of listPipelineApps(db)) appEntries.set(app.id, app.name);

    const items = await Promise.all(projects.map(async (project: any) => {
      const metadata = project.metadata as Record<string, unknown> | undefined;
      const studioConfig = metadata?.studioConfig;
      const config = studioConfig && typeof studioConfig === 'object' && !Array.isArray(studioConfig)
        ? studioConfig as Record<string, unknown>
        : {};
      const appId = typeof config.appId === 'string' ? config.appId : '';
      const appName = typeof config.appName === 'string' && config.appName ? config.appName : appId;
      if (appId) appEntries.set(appId, appName);
      const localPaths = await pipelines.localOutputs(project.id).catch(() => [] as string[]);
      const localState = deriveStateFromLocalFiles(localPaths);
      const state = mergePipelineState(getProjectPipelineState(db, project.id) as any, localState);
      return {
        appId,
        appName,
        featureId: project.id,
        name: project.name,
        projectId: project.id,
        localFiles: localPaths.length > 0,
        workflows: WORKFLOWS.map((workflow) => {
          const progress = countWorkflowProgress(project, state, workflow.pipelineIds);
          return {
            id: workflow.id,
            name: workflow.name,
            ...progress,
            running: progress.running > 0,
          };
        }),
      };
    }));

    res.json({
      apps: appEntries.size,
      features: projects.length,
      items,
    });
  });

  app.get('/api/overview/outputs', async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    const project = getProject(db, projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });
    // Phạm vi của workspace tổng là FEATURE pipeline — từ chối mọi project
    // khác (chat thường, ds-criteria/ds-rules, chính `overview`…) để agent
    // chỉ-đọc không dùng route này với ID tuỳ ý làm cửa đọc file ngoài phạm vi.
    if (!isKgsProject(project)) {
      return res.status(403).json({ error: 'projectId is not a pipeline feature project' });
    }
    res.json({ paths: await pipelines.localOutputs(projectId) });
  });
}
