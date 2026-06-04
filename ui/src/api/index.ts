/**
 * T09 + T27 — API Registry
 * Central import point for all API clients.
 * Usage: import { api } from '@/api';
 */
import { HttpProjectApiClient } from './projects/http';
import { HttpRunsApiClient } from './runs/http';
import {
  HttpDesignSystemApiClient,
  HttpSkillApiClient,
  HttpConfigApiClient,
  HttpAgentApiClient,
  HttpConnectorsApiClient,
} from './domain/http';
import {
  HttpExportApiClient,
  HttpDeployApiClient,
  HttpImportApiClient,
  HttpTemplatesApiClient,
  HttpMediaApiClient,
  HttpRoutinesApiClient,
  HttpMCPApiClient,
  HttpMemoryApiClient,
  HttpPluginsApiClient,
} from './supplement/http';

export const api = {
  // T02 — Projects: listProjects, createProject, getProject, updateProject, deleteProject
  //        Files: listFiles, readFile, writeFile, deleteFile
  projects: new HttpProjectApiClient(),

  // T03 — Runs: sendMessage (SSE, all 9 event types), cancelRun
  runs: new HttpRunsApiClient(),

  // T04 — Design Systems: listDesignSystems, getDesignSystem, create/update/delete, importFromGitHub
  designSystems: new HttpDesignSystemApiClient(),

  // T05 — Skills: listSkills, getSkill, getExampleUrl
  skills: new HttpSkillApiClient(),

  // T06 — Config: getConfig, updateConfig, health, testConnection
  config: new HttpConfigApiClient(),

  // T07 — Agents: listAgents, testAgent
  agents: new HttpAgentApiClient(),

  // T08 / T25 — Connectors: listConnectors, getConnector, connect, disconnect, getComposioConfig
  connectors: new HttpConnectorsApiClient(),

  // T17 — Export: exportHTML, exportPDF, downloadArchiveZip, downloadTranscriptMarkdown
  export: new HttpExportApiClient(),

  // T18 — Deploy: deployToVercel, deployToCloudflare, pollUntilComplete
  deploy: new HttpDeployApiClient(),

  // T19 — Import: importClaudeDesignZip, importDesignSystemFromGitHub
  import: new HttpImportApiClient(),

  // T20 — Templates: list, get, create, update, delete
  templates: new HttpTemplatesApiClient(),

  // T21 — Media: generateImage, generateVideo, generateAudio, pollUntilComplete, listVoices
  media: new HttpMediaApiClient(),

  // T22 — Routines: list, create, update, delete, triggerManualRun, listRuns, getOrbitStatus
  routines: new HttpRoutinesApiClient(),

  // T23 — MCP: getConfig, updateConfig, listTemplates, beginOAuth
  mcp: new HttpMCPApiClient(),

  // T24 — Memory: list, extract, delete
  memory: new HttpMemoryApiClient(),

  // T26 — Plugins: list, install, uninstall, apply
  plugins: new HttpPluginsApiClient(),
} as const;

export type Api = typeof api;

// ── Re-exports for consumers ─────────────────────────────────────────────

export { ApiError } from './client';

export type { CreateProjectRequest } from './projects/http';

export type {
  RunSSEEvent,
  DeltaEvent,
  ToolUseEvent,
  TodoItem,
  TodoEvent,
  ArtifactEvent,
  FileOpEvent,
  FormField,
  QuestionFormEvent,
  Direction,
  DirectionPickerEvent,
  EndEvent,
  ErrorEvent,
  RunStreamHandlers,
  SendMessageRequest,
} from './runs/http';

export type { Connector } from './domain/http';

export type {
  Deployment,
  VercelDeployRequest,
  CloudflareDeployRequest,
  MediaTask,
  ImageGenerationRequest,
  VideoGenerationRequest,
  AudioGenerationRequest,
  ElevenLabsVoice,
  Routine,
  RoutineRun,
  MemoryEntry,
  Plugin,
  ProjectTemplate,
} from './supplement/http';

export { triggerDownload } from './supplement/http';
