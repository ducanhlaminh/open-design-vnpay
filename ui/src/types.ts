/**
 * Shared types for the ui/ React CSR app.
 * Mirrors key types from apps/web/src/types.ts but is standalone
 * (no dependency on Next.js or @open-design/contracts).
 */

export type ExecMode = 'daemon' | 'api';
export type ApiProtocol =
  | 'anthropic'
  | 'openai'
  | 'azure'
  | 'google'
  | 'ollama'
  | 'senseaudio';

export type AppTheme = 'system' | 'light' | 'dark';

// ── Projects ─────────────────────────────────────────────────────────────

export type ProjectKind = 'web' | 'image' | 'video' | 'audio';
export type ProjectDisplayStatus = 'active' | 'archived';
export type ProjectFileKind = 'html' | 'css' | 'js' | 'md' | 'other';
export type ProjectPlatform = 'desktop' | 'mobile' | 'tablet';

export interface ProjectFile {
  name: string;
  kind: ProjectFileKind;
  size: number;
  updatedAt: string;
}

export interface ProjectMetadata {
  description?: string;
  surface?: ProjectPlatform;
  tags?: string[];
  templateId?: string;
  templateInputs?: Record<string, string>;
}

export interface Project {
  id: string;
  name: string;
  kind: ProjectKind;
  skillId?: string;
  designSystemId?: string;
  status: ProjectDisplayStatus;
  metadata?: ProjectMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description?: string;
  sourceProjectId?: string;
  createdAt: number;
}

// ── Conversations ────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatMessageRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
}

// ── Artifact ─────────────────────────────────────────────────────────────

export interface Artifact {
  identifier: string;
  title: string;
  html: string;
  artifactType?: string;
}

// ── Design Systems ───────────────────────────────────────────────────────

// ── DSPreviewPage (NEW) ──────────────────────────────────────────────────
export interface DSPreviewPage {
  path: string;
  role: 'colors' | 'typography' | 'spacing' | 'buttons' | 'app' | string;
  title: string;
}

export interface DesignSystemSummary {
  id: string;
  name: string;
  description?: string;
  /** @deprecated use sourceType instead */
  builtin?: boolean;
  category: string;
  sourceType: 'bundled' | 'imported' | 'generated';
  hasTokens: boolean;
  hasComponents: boolean;
  previewPages: DSPreviewPage[];
  updatedAt: string;
}

export interface DesignSystemDetail extends DesignSystemSummary {
  content: string;
  previewUrl?: string;
}

// ── Design Templates (NEW) ────────────────────────────────────────────────

export type TemplateMode = 'prototype' | 'deck' | 'template' | 'image' | 'video' | 'audio';

export interface TemplateInput {
  name: string;
  type: 'string' | 'text' | 'select' | 'number' | 'boolean';
  required: boolean;
  default?: string;
  options?: string[];
  placeholder?: string;
}

export interface DesignTemplateSummary {
  id: string;
  name: string;
  description?: string;
  mode: TemplateMode;
  platform?: 'desktop' | 'mobile' | 'tablet';
  scenario?: string;
  triggers: string[];
  hasExample: boolean;
  exampleUrl: string;
  inputs: TemplateInput[];
}

// ── Prompt Templates (NEW) ────────────────────────────────────────────────

export interface PromptTemplateArg {
  name: string;
  default: string;
}

export interface PromptTemplateSummary {
  id: string;
  surface: 'image' | 'video';
  title: string;
  summary: string;
  category: string;
  tags: string[];
  model: string;    // "gpt-image-2" | "seedance-2.0" | ...
  aspect: string;   // "1:1" | "16:9" | ...
  previewImageUrl?: string;
  argumentCount: number;
}

export interface PromptTemplateDetail extends PromptTemplateSummary {
  rawPrompt: string;
  arguments: PromptTemplateArg[];
  source: {
    repo: string;
    license: string;
    author?: string;
    url?: string;
  };
}

// ── Skills ───────────────────────────────────────────────────────────────

export interface SkillSummary {
  id: string;
  name: string;
  description?: string;
  scenario?: string;
  tags?: string[];
}

export interface SkillDetail extends SkillSummary {
  content: string;
  exampleUrl?: string;
}

// ── Agents ───────────────────────────────────────────────────────────────

export interface AgentModelPrefs {
  model?: string;
  reasoning?: string;
}

export interface AgentCliEnvPrefs {
  [agentId: string]: Record<string, string>;
}

export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  streamFormat: 'agent' | 'stdout';
  defaultModel?: string;
  models?: string[];
}

// ── Config ───────────────────────────────────────────────────────────────

export interface MediaProviderCredentials {
  apiKey: string;
  baseUrl: string;
  model?: string;
  apiKeyConfigured?: boolean;
  apiKeyTail?: string;
}

export interface ApiProtocolConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  apiVersion?: string;
  apiProviderBaseUrl?: string | null;
  byokImageModel?: string;
}

export interface ComposioSettings {
  apiKey?: string;
  apiKeyConfigured?: boolean;
  apiKeyTail?: string;
}

export interface NotificationsConfig {
  soundEnabled: boolean;
  successSoundId: string;
  failureSoundId: string;
  desktopEnabled: boolean;
}

export interface OrbitConfig {
  enabled: boolean;
  time: string;
  templateSkillId?: string | null;
}

export interface TelemetryConfig {
  metrics?: boolean;
  content?: boolean;
  artifactManifest?: boolean;
}

export type AgentModelChoice = AgentModelPrefs;
export type AgentCliEnvConfig = AgentCliEnvPrefs;

export interface AppConfig {
  mode: ExecMode;
  apiKey: string;
  baseUrl: string;
  model: string;
  apiProtocol?: ApiProtocol;
  apiVersion?: string;
  byokImageModel?: string;
  apiProtocolConfigs?: Partial<Record<ApiProtocol, ApiProtocolConfig>>;
  apiProviderBaseUrl?: string | null;
  configMigrationVersion?: number;
  agentId: string | null;
  skillId: string | null;
  designSystemId: string | null;
  theme?: AppTheme;
  accentColor?: string;
  onboardingCompleted?: boolean;
  mediaProviders?: Record<string, MediaProviderCredentials>;
  composio?: ComposioSettings;
  agentModels?: Record<string, AgentModelChoice>;
  agentCliEnv?: AgentCliEnvConfig;
  maxTokens?: number;
  notifications?: NotificationsConfig;
  orbit?: OrbitConfig;
  disabledSkills?: string[];
  disabledDesignSystems?: string[];
  installationId?: string | null;
  privacyDecisionAt?: number | null;
  telemetry?: TelemetryConfig;
  customInstructions?: string;
}

// ── Media Jobs (F-26) ────────────────────────────────────────────────────

export type MediaJobStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface MediaJobSummary {
  id: string;
  kind: 'image' | 'video' | 'audio';
  status: MediaJobStatus;
  model: string;
  templateId?: string;
  resultUrl?: string;
  errorMsg?: string;
  durationMs?: number;
  createdAt: string;
  updatedAt: string;
}

// ── CreateProjectRequest (re-export for components) ──────────────────────

export interface CreateProjectRequest {
  name: string;
  kind?: ProjectKind;
  skillId?: string;
  designSystemId?: string;
  description?: string;
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
}
