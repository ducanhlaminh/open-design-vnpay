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

export interface DesignSystemSummary {
  id: string;
  name: string;
  description?: string;
  builtin: boolean;
  updatedAt: string;
}

export interface DesignSystemDetail extends DesignSystemSummary {
  content: string;
  previewUrl?: string;
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
