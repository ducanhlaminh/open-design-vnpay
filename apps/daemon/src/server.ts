// @ts-nocheck
import express from 'express';
import multer from 'multer';
import JSZip from 'jszip';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import {
  defaultScenarioPluginIdForProjectMetadata,
  ERR_PLAN_EXPIRED,
  type DocsReviewComponentSource,
  type OpenDesignGithubLatestReleaseResponse,
  type OpenDesignGithubRepoResponse,
  type PullApplyResult,
  type PullPlan,
  type PullResolution,
  PLUGIN_SHARE_ACTION_PLUGIN_IDS,
} from '@open-design/contracts';
import {
  composeSystemPrompt,
  renderCodexImagegenOverride,
  resolveExclusiveSurface,
  shouldRenderCodexImagegenOverride,
} from './prompts/system.js';
import { expandHomePrefix, resolveProjectRelativePath } from './home-expansion.js';
import { userFacingAgentLabel } from './user-facing-agent-label.js';
import {
  compareVersions,
  deriveOdHomeFromResourceRoot,
  extractSemverFromTag,
  isTerminalUpdateState,
  patchUpdateState,
  readUpdateState,
  resolveJustUpdated,
  writeUpdateState,
  writeUpdateMarker,
} from './update-check.js';
import { createCommandInvocation } from '@open-design/platform';
import {
  checkPromptArgvBudget,
  checkWindowsCmdShimCommandLineBudget,
  checkWindowsDirectExeCommandLineBudget,
  detectAgents,
  getAgentDef,
  isKnownModel,
  applyAgentLaunchEnv,
  buildHostAgentEnv,
  resolveAgentLaunch,
  sanitizeCustomModel,
  spawnEnvForAgent,
} from './agents.js';
import { migrateLegacyDataDirSync } from './legacy-data-migrator.js';
import {
  getMachineIdentityUser,
  getMachineUser,
  identityUserIdOf,
  registerAuthRoutes,
} from './auth-routes.js';
import { commitHistory, listHistory, restoreCommit } from './project-history.js';
import {
  findSkillById,
  listSkills,
  resolveSkillId,
  splitDerivedSkillId,
} from './skills.js';
import { validateLinkedDirs } from './linked-dirs.js';
import { installFromTarget, uninstallById, sanitizeRepoName } from './library-install.js';
import { buildWindowsFolderDialogCommand, parseFolderDialogStdout } from './native-folder-dialog.js';
import { listCodexPets, readCodexPetSpritesheet } from './codex-pets.js';
import { syncCommunityPets } from './community-pets-sync.js';
import {
  createUserDesignSystem,
  deleteUserDesignSystem,
  LEGACY_DESIGN_SYSTEM_ARTIFACTS,
  linkUserDesignSystemProject,
  listDesignSystems,
  listUserDesignSystemFiles,
  listUserDesignSystemRevisions,
  readDesignSystem,
  readDesignSystemPackageInfo,
  readUserDesignSystemFile,
  resolveDesignSystemAssets,
  updateUserDesignSystem,
  updateUserDesignSystemRevisionStatus,
} from './design-systems.js';
import { createDesignSystemGenerationJobStore } from './design-system-generation-jobs.js';
import {
  applyDiffReviewDecisionToCwd,
  applyPlugin,
  buildConnectorProbe,
  defaultBundledRoot,
  detectSkillPluginCandidate,
  dismissSkillPluginCandidate,
  doctorPlugin,
  FIRST_PARTY_ATOMS,
  generateSkillPluginDraft,
  getInstalledPlugin,
  getSnapshot,
  installFromLocalFolder,
  installPlugin,
  insertSkillPluginCandidate,
  isDiffReviewSurfaceId,
  listSkillPluginCandidates,
  listInstalledPlugins,
  listIterationsForRun,
  MissingInputError,
  pluginPromptBlock,
  pruneExpiredSnapshots,
  readPluginLockfile,
  registerBuiltInAtomWorkers,
  registerBundledPlugins,
  registryRootsForDataDir,
  resolvePluginSnapshot,
  runPipelineForRun,
  runStageWithRegistry,
  startSnapshotGc,
  uninstallPlugin,
} from './plugins/index.js';
import {
  marketplaceManifestUrlForRegistry,
  marketplaceRegistryIdFromUrl,
} from './plugins/marketplaces.js';
import {
  getSurface,
  listSurfacesForProject,
  listSurfacesForRun,
  prefillProjectSurface,
  respondSurface as respondSurfaceRow,
  revokeProjectSurface,
} from './genui/index.js';
import {
  buildMemoryTree,
  composeMemoryBody,
  deleteMemoryEntry,
  extractFromMessage,
  listMemoryEntries,
  maskMemoryExtractionConfig,
  memoryDir,
  memoryEvents,
  readMemoryConfig,
  readMemoryEntry,
  readMemoryIndex,
  updateMemoryTreeNode,
  upsertMemoryEntry,
  writeMemoryConfig,
  writeMemoryIndex,
} from './memory.js';
import {
  clearExtractions as clearMemoryExtractions,
  listExtractions as listMemoryExtractions,
  removeExtraction as removeMemoryExtraction,
} from './memory-extractions.js';
import {
  extractMemoryFromConnectors,
  suggestMemoryFromConnectors,
} from './memory-connectors.js';
import { attachAcpSession } from './acp.js';
import { attachPiRpcSession } from './pi-rpc.js';
import {
  applyAutomationProposal,
  createAutomationProposal,
  getAutomationProposal,
  listAutomationProposals,
  rejectAutomationProposal,
} from './automation-proposals.js';
import {
  getAutomationSourcePacket,
  ingestAutomationSource,
  listAutomationSourcePackets,
} from './automation-ingestions.js';
import { ingestRoutineConnectorEvolution } from './automation-routine-evolution.js';
import { createClaudeStreamHandler } from './claude-stream.js';
import { diagnoseClaudeCliFailure } from './claude-diagnostics.js';
import { fetchClaudeUsage } from './claude-usage.js';
import { renderHtmlToPdf } from './bas/drawio-render.js';
import { finalizeFlowUx, prepareFlowUxInputs } from './flow-ux/index.js';
import { serveDrawioViewerJs } from './flow-ux/viewer-asset.js';
import { loadCritiqueConfigFromEnv } from './critique/config.js';
import { reconcileStaleRuns } from './critique/persistence.js';
import { runOrchestrator } from './critique/orchestrator.js';
import { createRunRegistry } from './critique/run-registry.js';
import { handleCritiqueInterrupt } from './critique/interrupt-handler.js';
import { handleCritiqueArtifact } from './critique/artifact-handler.js';
import { getCritiqueMetrics, register } from './metrics/index.js';
import { readConformanceHistory } from './critique/conformance-history.js';
import { evaluateRollout } from './critique/ratchet.js';
import {
  isCritiqueEnabled,
  parseEnvEnabled,
  parseRolloutPhase,
  type SkillCritiquePolicy,
} from './critique/rollout.js';
import { narrowProjectCritiqueOverride } from './critique/spawn-inputs.js';
import { createCopilotStreamHandler } from './copilot-stream.js';
import { createJsonEventStreamHandler } from './json-event-stream.js';
import { classifyAgentAuthFailure, cursorAuthGuidance } from './runtimes/auth.js';
import { resolveOnPath } from './runtimes/executables.js';
import { createQoderStreamHandler } from './qoder-stream.js';
import { subscribe as subscribeFileEvents } from './project-watchers.js';
import { renderDesignSystemPreview } from './design-system-preview.js';
import { renderDesignSystemShowcase } from './design-system-showcase.js';
import { createChatRunService } from './runs.js';
import { deriveRunErrorCode, runResultFromStatus } from './run-result.js';
import {
  countDesignSystemPreviewModules,
  countNewHtmlArtifacts,
  didRunCreateDesignSystemFile,
} from './run-artifacts.js';
import {
  reportRunCompletedFromDaemon,
  reportRunFeedbackFromDaemon,
} from './langfuse-bridge.js';
import {
  createAnalyticsService,
  newInsertId,
  readAnalyticsContext,
  readPublicConfigResponse,
} from './analytics.js';
import {
  agentIdToTracking,
  deriveConfigureGlobals,
  type ObservabilityEventRequest,
} from '@open-design/contracts/analytics';
import {
  redactSecrets,
  testAgentConnection,
  testProviderConnection,
  validateBaseUrl,
  validateBaseUrlResolved,
} from './connectionTest.js';
import { listProviderModels } from './providerModels.js';
import { importClaudeDesignZip } from './claude-design-import.js';
import {
  defaultBaseUrlForFinalizeProtocol,
  finalizeDesignPackage,
  FinalizePackageLockedError,
  FinalizeUpstreamError,
  isFinalizeProviderProtocol,
} from './finalize-design.js';
import { listPromptTemplates, readPromptTemplate } from './prompt-templates.js';
import { buildDocumentPreview } from './document-preview.js';
import { lintArtifact, renderFindingsForAgent } from './lint-artifact.js';
import { loadCraftSections } from './craft.js';
import { skillCwdAliasSegment, stageActiveSkill } from './cwd-aliases.js';
import { generateMedia } from './media.js';
import { listElevenLabsVoiceOptions } from './elevenlabs-voices.js';
import { searchResearch, ResearchError } from './research/index.js';
import { renderResearchCommandContract } from './prompts/research-contract.js';
import { openBrowser } from './browser-open.js';
import {
  AUDIO_DURATIONS_SEC,
  AUDIO_MODELS_BY_KIND,
  IMAGE_MODELS,
  MEDIA_ASPECTS,
  MEDIA_PROVIDERS,
  VIDEO_LENGTHS_SEC,
  VIDEO_MODELS,
} from './media-models.js';
import { readMaskedConfig, writeConfig } from './media-config.js';
import {
  deleteMediaTask,
  getMediaTask,
  insertMediaTask,
  listMediaTasksByProject,
  listRecentMediaTasks,
  reconcileMediaTasksOnBoot,
  updateMediaTask,
} from './media-tasks.js';
import {
  MCP_TEMPLATES,
  buildAcpMcpServers,
  buildClaudeMcpJson,
  buildCodexMcpToml,
  buildOpenCodeMcpConfigContent,
  isManagedProjectCwd,
  readMcpConfig,
  seedDefaultMcpConfig,
  removeLegacyBaAgentSeed,
  writeMcpConfig,
} from './mcp-config.js';
import { ensureUvForMcp } from './ensure-uv.js';
import {
  beginAuth,
  exchangeCodeForToken,
  PendingAuthCache,
  refreshAccessToken,
} from './mcp-oauth.js';
import {
  clearToken,
  getToken,
  isTokenExpired,
  readAllTokens,
  setToken,
} from './mcp-tokens.js';
import { agentCliEnvForAgent, readAppConfig, readPluginEnvKnobs, writeAppConfig } from './app-config.js';
import {
  CONTAINER_PROJECT_DIR,
  SANDBOX_AUTH_VOLUME,
  dockerAvailable,
  dockerImagePresent,
  dockerVolumePresent,
  ensureSandboxImage,
  readSandboxClaudeCredentials,
  readSandboxCodexUsage,
  readHostCodexUsage,
  resolveSandboxConfig,
  sandboxImageTag,
  sandboxPreflight,
  shouldSandboxRun,
  sweepOrphanSandboxContainers,
  killSandboxContainer,
  materializeSandboxCodexProfile,
  removeSandboxCodexProfile,
  sandboxAuthVolume,
  sandboxCodexProfileName,
  retireLegacyPackagedSandboxAuth,
  wrapInvocationInSandbox,
} from './agent-sandbox.js';
import {
  buildSandboxRuntimeStatuses,
  resolveSandboxFallbackRuntimeId,
  sandboxRuntimeIsGated,
} from './sandbox-routes.js';
import {
  planWriteIsolation,
  resolveWritableStatePaths,
  wrapInvocationInWriteIsolation,
  writeIsolationMode,
} from './write-isolation.js';
import { OrbitService, formatLocalProjectTimestamp, renderOrbitTemplateSystemPrompt } from './orbit.js';
import { buildOrbitNoLiveArtifactSummary } from './orbit-agent-summary.js';
import {
  RoutineService,
  validateSchedule as validateRoutineSchedule,
  validateTarget as validateRoutineTarget,
} from './routines.js';
import { createDiagnosticsExportHandler } from './diagnostics-export.js';
import { attachStageFailureContext, createErrorReporter, fanoutFailureDetail, installConsoleTailCapture, resolveDaemonLogPath } from './error-reports.js';
import { DIAGNOSTICS_EXPORT_PATH } from '@open-design/diagnostics';
import {
  buildProjectArchive,
  buildBatchArchive,
  decodeMultipartFilename,
  deleteProjectFile,
  detectEntryFile,
  ensureProject,
  isSafeId,
  listFiles,
  mimeFor,
  parseByteRange,
  projectDir,
  readProjectFile,
  renameProjectFile,
  removeProjectDir,
  resolveProjectDir,
  sanitizeName,
  searchProjectFiles,
  resolveProjectDir,
  resolveProjectFilePath,
  writeProjectFile,
  reconcileHtmlArtifactManifest,
} from './projects.js';
import { validateArtifactManifestInput } from './artifact-manifest.js';
import { ArtifactPublicationBlockedError } from './artifact-publication-guard.js';
import { isPackagedRuntime, readCurrentAppVersionInfo } from './app-version.js';
import {
  appendMessageAgentEvent,
  appendMessageStatusEvent,
  deleteConversation,
  deletePreviewComment,
  deleteProject as dbDeleteProject,
  deleteTemplate,
  getConversation,
  getDeployment,
  getDeploymentById,
  getProject,
  getPipelineApp,
  getFigmaDesignSystemSource,
  getTemplate,
  insertConversation,
  insertProject,
  insertRoutine,
  insertRoutineRun,
  insertTemplate,
  findTemplateByNameAndProject,
  updateTemplate,
  listProjectsAwaitingInput,
  listConversations,
  listDeployments,
  listLatestProjectRunStatuses,
  listMessages,
  listPreviewComments,
  listProjects,
  listPipelineApps,
  listRoutines,
  listRoutineRuns,
  listTabs,
  listTemplates,
  getLatestRoutineRun,
  getRoutine,
  deleteRoutine as dbDeleteRoutine,
  openDatabase,
  setTabs,
  updateConversation,
  updatePreviewCommentStatus,
  updateProject,
  upsertPipelineAppName,
  setPipelineAppDesignSystem,
  setPipelineFailureHook,
  setProjectPipelineStatus,
  getProjectPipelineState,
  updateRoutine,
  updateRoutineRun,
  upsertDeployment,
  upsertMessage,
  upsertPreviewComment,
} from './db.js';
import {
  createLiveArtifact,
  deleteLiveArtifact,
  ensureLiveArtifactPreview,
  getLiveArtifact,
  LiveArtifactRefreshLockError,
  LiveArtifactStoreValidationError,
  listLiveArtifacts,
  listLiveArtifactRefreshLogEntries,
  readLiveArtifactCode,
  recoverStaleLiveArtifactRefreshes,
  updateLiveArtifact,
} from './live-artifacts/store.js';
import { LiveArtifactRefreshUnavailableError, refreshLiveArtifact } from './live-artifacts/refresh-service.js';
import { LiveArtifactRefreshAbortError } from './live-artifacts/refresh.js';
import { registerConnectorRoutes } from './connectors/routes.js';
import { registerActiveContextRoutes } from './active-context-routes.js';
import { registerHostToolsRoutes } from './host-tools-routes.js';
import { registerMcpRoutes } from './mcp-routes.js';
import { registerConfluenceConfigRoutes } from './confluence-config-routes.js';
import { registerFigmaCatalogRoutes, writeAppFigmaCatalog } from './figma-catalog-routes.js';
import { registerFigmaDesignSystemRoutes } from './figma-design-system-routes.js';
import { registerFigmaConfigRoutes } from './figma-config-routes.js';
import { registerXaiRoutes } from './xai-routes.js';
import { registerLiveArtifactRoutes } from './live-artifact-routes.js';
import { registerDesignSystemToolRoutes } from './design-system-tool-routes.js';
import { registerDeployRoutes, registerDeploymentCheckRoutes } from './deploy-routes.js';
import { registerSandboxRoutes } from './sandbox-routes.js';
import { registerMediaRoutes } from './media-routes.js';
import { registerProjectRoutes, registerProjectArtifactRoutes, registerProjectFileRoutes, registerProjectUploadRoutes } from './project-routes.js';
import { registerFinalizeRoutes, registerImportRoutes, registerProjectExportRoutes } from './import-export-routes.js';
import { registerRemoteProjectsRoutes } from './remote-projects-routes.js';
import { registerProjectSyncRoutes } from './project-sync-routes.js';
import { registerHandoffRoutes } from './handoff-routes.js';
import { EmptyTranscriptError, synthesizeHandoffPrompt } from './handoff-design.js';
import { TranscriptExportLockedError } from './transcript-export.js';
import { publishFeedback, pullMergedFeedback } from './feedback.js';
import { confirmDocsReview } from './docs-review-feedback.js';
import { registerChatRoutes } from './chat-routes.js';
import { registerStaticResourceRoutes } from './static-resource-routes.js';
import { registerDesignSystemUpdateRoutes } from './design-system-update-routes.js';
import { registerDesignSystemSyncRoutes } from './design-system-sync-routes.js';
import { isCriteriaGenerationJobActive, registerDesignSystemCriteriaWorkspaceRoutes } from './design-system-criteria-workspace.js';
import { registerRoutineRoutes, routineDbRowToContract } from './routine-routes.js';
import { registerPipelineRoutes } from './pipeline-routes.js';
import { DEFAULT_WORKFLOW_ID, deriveStateFromLocalFiles, getPipelineDef, getWorkflow, isExportArtifact, isHistoryArtifact, isSyncExcluded, isTargetScopedWfDir, mergePipelineState, pickRunTarget, relClearedByRegen, relClearedByRunAllLaunch, selectRunStages, stageForOutput, stagesForOutput, stageRegenSet, upstreamStages, wfDirForStage, workflowDirForPipeline } from './pipelines.js';
import { generateProjectExports } from './pipeline-exports.js';
import {
  historyKeepCount,
  nextVerId,
  publishVersion,
  pruneVersions,
  readChangelog,
  writeChangelog,
} from './kg-sync/published-versions.js';
import {
  basConfluenceMeta,
  basListDocuments,
  basListFeatures,
  extractPageId,
  fetchConfluencePages,
  fetchSourceFiles,
  listDescendantPages,
  looksLikeConfluenceRef,
  looksLikeJiraInput,
  renderConfluenceIndex,
  resolveBasEndpoint,
  resolveConfluenceCreds,
  searchConfluencePages,
} from './bas/bas-client.js';
import { buildReactDemo } from './react-demo.js';
import { iconNameMapFromIrDir, rewriteIconMarkersInDir, runFigmaCapture } from './figma-capture.js';
import { runFigmaAudit } from './figma-audit.js';
import { listRequirementPages, mergePageReports } from './prd-review-fanout.js';
import {
  listDocPages,
  cloneDocsForReview,
  validateChanges,
  parseChangesFile,
  parseNotesFile,
  validateNotes,
  partitionNotesByAnchor,
  validateRuleIds,
  findReviewMarkers,
  collectCriteriaAnchors,
  splitSections,
  sectionOutputPath,
  sectionSlicePath,
  pageOutlinePath,
  renderPageOutline,
  sliceSections,
  rebuildPageFromSlices,
  detectEol,
  removePageOutputs,
  mergeChangeReports,
  writeDocsReviewFailureNote,
  DOCS_REVIEW_FAILURE_NOTE,
  type DocChange,
  type DocNote,
  type DocPage,
  type DocPageResult,
  // `DocSection` cũng là tên một kiểu trong section-fanout.js (section = một
  // MODULE tài liệu, đơn vị fan-out của CJ/UX). Kiểu ở đây là lát cắt theo
  // heading TRONG một trang — khác hẳn, nên đặt bí danh thay vì đổi tên một
  // trong hai (must_not cấm đụng section-fanout).
  type DocSection as DocPageSection,
} from './docs-review.js';
import {
  collectComponentCatalog,
  writeDocsComponentFailureNote,
  DOCS_COMPONENT_FAILURE_NOTE,
} from './docs-components.js';
import {
  prepareScreenComponentInputs,
  parseRoleMap,
  normalizeRoleMap,
  parseScreenComponentsDoc,
  normalizeScreenComponentsDoc,
  mergeScreenComponents,
  screenDocRel,
  wireframeRel,
  SCREEN_INPUTS_FILE,
  ROLE_MAP_FILE,
  type RoleMapDoc,
  type ScreenComponentsDoc,
} from './screen-components.js';
import { renderFigmaComponentsMarkdown, type FigmaComponentCatalogSnapshot } from './figma-component-catalog.js';
import { readFigmaConfig } from './figma-config.js';
import { FigmaDesktopClient } from './figma-desktop.js';
import { registerFigmaDesktopToolRoutes } from './figma-desktop-tool-routes.js';
import type { FigmaDesktopScope } from './figma-desktop-tool-routes.js';
import { buildFigmaComponentCatalog } from './figma-rest.js';
import { listSections, mergeCjSections, mergeUxrSections, mergeUxSpecSections, type DocSection } from './section-fanout.js';
import { listScreens, mergeHeuristicScreens, renderPrototypeIndex, type UiScreen } from './ui-fanout.js';
import { pushUxKb, resolveUxKbDir } from './ux-kb-sync.js';
import { appContextDirective, resolveAppId, stageAppContext, stageLocalAppContext } from './app-context.js';
import {
  createAppContextVersion,
  featureContextBindingFromMetadata,
  filesForFeatureContextPublish,
  metadataWithFeatureContextBinding,
  readAppContextManifest,
  stageBoundAppContextForRun,
} from './app-context-version.js';
import {
  appDocsDir,
  appDocsPoolDirective,
  readManifest,
  stageAppDocsPool,
} from './app-pool.js';
import { registerAppPoolRoutes } from './app-pool-routes.js';
import { registerAppContextRoutes } from './app-context-routes.js';
import { registerOverviewRoutes } from './overview-routes.js';
import { copyDsCriteriaIntoWorkflow, readDsCriteriaState, validateGeneratedComponentsMdDraft, validateGeneratedRulesMdDraft } from './ds-criteria.js';
import { designSystemCriteriaWorkDir, markDesignSystemCriteriaDraft } from './design-system-update.js';
import type { CriteriaGenerationJob, CriteriaGenerationKind } from '@open-design/contracts';
import { MediaClient, mediaConfigFromEnv, sha256hex, type LocalSyncFile } from './kg-sync/media-client.js';
import { PullPlanStore, applyPullFiles, planPullFiles } from './kg-sync/pull-conflict.js';
import { type PushPlan, planPush, rememberPendingId } from './kg-sync/push-plan.js';
import { studioConfigOf } from './kg-sync/push-dest.js';
import { writeStagingRequest } from './kg-sync/staging-store.js';
import { assertServerContextSatisfiesRoutes } from './route-context-contract.js';
import { configureConnectorCredentialStore, connectorService, ConnectorServiceError, FileConnectorCredentialStore } from './connectors/service.js';
import { composioConnectorProvider } from './connectors/composio.js';
import { configureComposioConfigStore } from './connectors/composio-config.js';
import { CHAT_TOOL_ENDPOINTS, CHAT_TOOL_OPERATIONS, FIGMA_TOOL_ENDPOINTS, FIGMA_TOOL_OPERATIONS, toolTokenRegistry } from './tool-tokens.js';
import {
  aggregateCloudflarePagesStatus,
  buildDeployFileSet,
  checkDeploymentUrl,
  CLOUDFLARE_PAGES_PROVIDER_ID,
  cloudflarePagesProjectNameForProject,
  DeployError,
  deployToCloudflarePages,
  deployToVercel,
  isDeployProviderId,
  listCloudflarePagesZones,
  prepareDeployPreflight,
  publicDeployConfigForProvider,
  readDeployConfig,
  readCloudflarePagesDomain,
  VERCEL_PROVIDER_ID,
  writeDeployConfig,
} from './deploy.js';
import {
  allowedBrowserPorts,
  configuredAllowedOrigins,
  isAllowedBrowserOrigin,
  isLocalSameOrigin,
} from './origin-validation.js';

/** @typedef {import('@open-design/contracts').ApiErrorCode} ApiErrorCode */
/** @typedef {import('@open-design/contracts').ApiError} ApiError */
/** @typedef {import('@open-design/contracts').ApiErrorResponse} ApiErrorResponse */
/** @typedef {import('@open-design/contracts').ChatRequest} ChatRequest */
/** @typedef {import('@open-design/contracts').ChatSseEvent} ChatSseEvent */
/** @typedef {import('@open-design/contracts').ProxyStreamRequest} ProxyStreamRequest */
/** @typedef {import('@open-design/contracts').ProxySseEvent} ProxySseEvent */
/** @typedef {import('@open-design/contracts').ProjectConversationCreatedSsePayload} ProjectConversationCreatedSsePayload */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const DAEMON_CLI_PATH_ENV = 'OD_DAEMON_CLI_PATH';

/** Runtime ids whose HOST CLI must NOT be probed because the Docker sandbox OWNS
 *  their runs (enabled + skills '*'). Passed to detectAgents so a Docker-only
 *  app never touches the host `claude` binary — availability comes from the
 *  sandbox instead. Empty when the sandbox isn't owning runs. */
function sandboxSkipProbe(config: { sandbox?: unknown } | null | undefined): string[] {
  const cfg = resolveSandboxConfig(
    config?.sandbox as Parameters<typeof resolveSandboxConfig>[0],
    process.env,
  );
  return cfg.enabled && cfg.skills.includes('*') ? cfg.runtimes : [];
}
export function resolveProjectRoot(moduleDir: string): string {
  const base = path.basename(moduleDir);
  const daemonDir =
    base === 'dist' || base === 'src' ? path.dirname(moduleDir) : moduleDir;
  return path.resolve(daemonDir, '../..');
}

function cleanOptionalPath(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? path.resolve(value)
    : null;
}

export function resolveDaemonCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = cleanOptionalPath(env[DAEMON_CLI_PATH_ENV]) ?? cleanOptionalPath(env.OD_BIN);
  if (configured) return configured;

  const packageJsonPath = require.resolve('@open-design/daemon/package.json');
  return path.join(path.dirname(packageJsonPath), 'dist', 'cli.js');
}

const PROJECT_ROOT = resolveProjectRoot(__dirname);
const RESOURCE_ROOT_ENV = 'OD_RESOURCE_ROOT';

/**
 * Pipeline-profile replacement for the full "Files already in this folder"
 * listing. A stage's skill + kickoff already name every input path and every
 * output path (fixed names, overwritten on re-run), so the agent does not
 * need the tree — and a docs-review cwd easily lists 600+ entries (docs-app
 * pool, per-slice review outputs, 150-char Confluence paths ≈ 15–20k tokens
 * re-read on every call). Keep one line per top-level entry with a count so
 * the agent can still orient itself; it can `ls` for anything deeper.
 */
export function renderPipelineFolderSummary(files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '\nThis folder is empty.';
  const top = new Map();
  for (const f of list) {
    const name = typeof f?.name === 'string' ? f.name : '';
    if (!name) continue;
    const slash = name.indexOf('/');
    const key = slash === -1 ? name : `${name.slice(0, slash)}/`;
    top.set(key, (top.get(key) ?? 0) + 1);
  }
  const lines = [...top.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, n]) => (key.endsWith('/') ? `- ${key} (${n} file${n === 1 ? '' : 's'})` : `- ${key}`));
  return `\nTop-level contents of this folder (${list.length} files total; the active skill and the user request name the exact input/output paths — read only those, \`ls\` a folder if you must):\n${lines.join('\n')}`;
}

export function composeLiveInstructionPrompt({
  daemonSystemPrompt,
  runtimeToolPrompt,
  clientSystemPrompt,
  finalPromptOverride,
}) {
  const override =
    typeof finalPromptOverride === 'string'
      ? finalPromptOverride.trim()
      : '';
  const parts = [daemonSystemPrompt, runtimeToolPrompt, clientSystemPrompt]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .map((part) =>
      override && part.includes(override)
        ? part.split(override).join('').trim()
        : part,
    )
    .filter(Boolean);
  if (override) {
    parts.push(override);
  }
  return parts.join('\n\n---\n\n');
}

function renderPluginBriefTemplate(template, inputs = {}) {
  if (typeof template !== 'string' || template.length === 0) return '';
  return template.replace(/\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g, (full, key) => {
    if (!Object.hasOwn(inputs, key)) return full;
    const value = inputs[key];
    if (value === undefined || value === null || value === '') return full;
    return String(value);
  });
}

export function resolveResearchCommandContract(research, message) {
  if (!research || !research.enabled) return '';
  const researchQuery =
    typeof research.query === 'string' && research.query.trim()
      ? research.query
      : message;
  return renderResearchCommandContract({
    query: researchQuery,
    maxSources:
      typeof research.maxSources === 'number' ? research.maxSources : undefined,
  });
}

export function resolveCodexGeneratedImagesDir(
  agentId,
  metadata,
  env = process.env,
  homeDir = os.homedir(),
) {
  if (!shouldRenderCodexImagegenOverride(agentId, metadata)) return null;
  const rawCodexHome =
    typeof env?.CODEX_HOME === 'string' && env.CODEX_HOME.trim().length > 0
      ? env.CODEX_HOME.trim()
      : path.join(homeDir, '.codex');
  const codexHome = rawCodexHome.startsWith('~/')
    ? path.join(homeDir, rawCodexHome.slice(2))
    : rawCodexHome;
  return path.resolve(codexHome, 'generated_images');
}

type DirectoryStat = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

type CodexGeneratedImagesDirValidationOptions = {
  protectedDirs?: Array<string | null | undefined>;
  mkdirSync?: (target: string, options: { recursive: true }) => unknown;
  lstatSync?: (target: string) => DirectoryStat;
  statSync?: (target: string) => DirectoryStat;
  realpathSync?: (target: string) => string;
  warn?: (message: string) => void;
};

function isMissingPathError(err: unknown): boolean {
  return (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    err.code === 'ENOENT'
  );
}

function collectProtectedDirRoots(
  protectedDirs: Array<string | null | undefined>,
  {
    realpathSync,
    statSync,
  }: {
    realpathSync: (target: string) => string;
    statSync: (target: string) => DirectoryStat;
  },
): string[] {
  const roots = [];
  for (const raw of Array.isArray(protectedDirs) ? protectedDirs : []) {
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const resolved = path.resolve(raw);
    roots.push(resolved);
    try {
      const canonical = realpathSync(resolved);
      try {
        if (statSync(canonical).isDirectory()) roots.push(canonical);
      } catch {
        roots.push(canonical);
      }
    } catch {
      // A missing protected root cannot be the canonical target of a symlink.
    }
  }
  return Array.from(new Set(roots));
}

function findContainingProtectedRoot(
  candidate: string,
  protectedRoots: string[],
): string | null {
  return protectedRoots.find((root) => isPathWithin(root, candidate)) ?? null;
}

export function validateCodexGeneratedImagesDir(
  codexGeneratedImagesDir: string | null | undefined,
  {
    protectedDirs = [],
    mkdirSync = fs.mkdirSync,
    lstatSync = fs.lstatSync,
    statSync = fs.statSync,
    realpathSync = fs.realpathSync.native,
    warn = console.warn,
  }: CodexGeneratedImagesDirValidationOptions = {},
): string | null {
  if (
    typeof codexGeneratedImagesDir !== 'string' ||
    codexGeneratedImagesDir.trim().length === 0
  ) {
    return null;
  }

  const resolved = path.resolve(codexGeneratedImagesDir);
  const protectedRoots = collectProtectedDirRoots(protectedDirs, {
    realpathSync,
    statSync,
  });
  const warnSkipped = (reason: string) =>
    warn(`[od] codex generated_images allowlist skipped: ${reason}`);

  const protectedRoot = findContainingProtectedRoot(resolved, protectedRoots);
  if (protectedRoot) {
    warnSkipped(`${resolved} is inside protected root ${protectedRoot}`);
    return null;
  }

  try {
    let existingTargetStat = null;
    try {
      existingTargetStat = lstatSync(resolved);
    } catch (err) {
      if (!isMissingPathError(err)) throw err;
    }
    if (existingTargetStat?.isSymbolicLink()) {
      warnSkipped(`${resolved} is a symlink`);
      return null;
    }
    if (existingTargetStat && !existingTargetStat.isDirectory()) {
      warnSkipped(`${resolved} is not a directory`);
      return null;
    }

    const parent = path.dirname(resolved);
    const protectedParentRoot = findContainingProtectedRoot(
      parent,
      protectedRoots,
    );
    if (protectedParentRoot) {
      warnSkipped(`${parent} is inside protected root ${protectedParentRoot}`);
      return null;
    }

    mkdirSync(parent, { recursive: true });
    const canonicalParent = realpathSync(parent);
    const canonicalCandidate = path.join(
      canonicalParent,
      path.basename(resolved),
    );
    const protectedCanonicalParentRoot = findContainingProtectedRoot(
      canonicalCandidate,
      protectedRoots,
    );
    if (protectedCanonicalParentRoot) {
      warnSkipped(
        `${canonicalCandidate} resolves inside protected root ${protectedCanonicalParentRoot}`,
      );
      return null;
    }

    mkdirSync(resolved, { recursive: true });
    if (lstatSync(resolved).isSymbolicLink()) {
      warnSkipped(`${resolved} is a symlink`);
      return null;
    }
    if (!statSync(resolved).isDirectory()) {
      warnSkipped(`${resolved} is not a directory`);
      return null;
    }
    const canonicalDir = realpathSync(resolved);
    const protectedCanonicalRoot = findContainingProtectedRoot(
      canonicalDir,
      protectedRoots,
    );
    if (protectedCanonicalRoot) {
      warnSkipped(
        `${canonicalDir} resolves inside protected root ${protectedCanonicalRoot}`,
      );
      return null;
    }

    return canonicalDir;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err ?? 'unknown error');
    warn(`[od] codex generated_images allowlist mkdir failed: ${message}`);
    return null;
  }
}

export function resolveChatExtraAllowedDirs({
  agentId,
  skillsDir,
  designSystemsDir,
  linkedDirs = [],
  codexGeneratedImagesDir,
  existsSync = fs.existsSync,
}: {
  agentId?: string | null;
  skillsDir?: string | null;
  designSystemsDir?: string | null;
  linkedDirs?: Array<string | null | undefined>;
  codexGeneratedImagesDir?: string | null;
  existsSync?: (path: string) => boolean;
}): string[] {
  const isCodex =
    typeof agentId === 'string' && agentId.trim().toLowerCase() === 'codex';
  const candidates = isCodex
    ? [codexGeneratedImagesDir]
    : [
        skillsDir,
        designSystemsDir,
        ...(Array.isArray(linkedDirs) ? linkedDirs : []),
      ];
  return Array.from(
    new Set(
      candidates.filter(
        (d) =>
          typeof d === 'string' && d.length > 0 && existsSync(d),
      ),
    ),
  );
}

export function resolveGrantedCodexImagegenOverride({
  agentId,
  metadata,
  codexGeneratedImagesDir,
  extraAllowedDirs = [],
}: {
  agentId?: string | null;
  metadata?: unknown;
  codexGeneratedImagesDir?: string | null;
  extraAllowedDirs?: string[];
}): string | null {
  if (
    typeof codexGeneratedImagesDir !== 'string' ||
    codexGeneratedImagesDir.length === 0 ||
    !Array.isArray(extraAllowedDirs) ||
    !extraAllowedDirs.includes(codexGeneratedImagesDir)
  ) {
    return null;
  }
  return renderCodexImagegenOverride(agentId, metadata);
}

export function normalizeCommentAttachments(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const filePath = cleanString(raw.filePath);
      const elementId = cleanString(raw.elementId);
      const selector = cleanString(raw.selector);
      const label = cleanString(raw.label);
      const screenshotPath = cleanString(raw.screenshotPath);
      const markKind = normalizeVisualMarkKind(raw.markKind);
      const intent = compactString(raw.intent, 220);
      const comment = cleanString(raw.comment) || intent;
      const selectionKind =
        raw.selectionKind === 'visual' ? 'visual' : raw.selectionKind === 'pod' ? 'pod' : 'element';
      if (!filePath || !elementId || !comment) return null;
      if (selectionKind !== 'visual' && !selector) return null;
      if (selectionKind === 'visual' && !screenshotPath) return null;
      const podMembers = selectionKind === 'pod' ? normalizeAttachmentPodMembers(raw.podMembers) : [];
      const memberCount =
        selectionKind === 'pod'
          ? (podMembers.length > 0
              ? podMembers.length
              : Number.isFinite(raw.memberCount)
                ? Math.max(0, Math.round(raw.memberCount))
                : 0)
          : 0;
      return {
        id: cleanString(raw.id) || `comment-${index + 1}`,
        order: Number.isFinite(raw.order)
          ? Math.max(1, Math.round(raw.order))
          : index + 1,
        filePath,
        elementId,
        selector,
        label,
        comment,
        currentText: compactString(raw.currentText, 160),
        pagePosition: normalizeAttachmentPosition(raw.pagePosition),
        htmlHint: compactString(raw.htmlHint, 180),
        style: normalizeAnnotationStyle(raw.style),
        selectionKind,
        memberCount,
        podMembers,
        screenshotPath: selectionKind === 'visual' ? screenshotPath : undefined,
        markKind: selectionKind === 'visual' ? markKind : undefined,
        intent: selectionKind === 'visual'
          ? intent || visualAnnotationIntent(markKind)
          : undefined,
        source: raw.source === 'board-batch' ? 'board-batch' : 'saved-comment',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

export function renderCommentAttachmentHint(commentAttachments) {
  if (!commentAttachments.length) return '';
  const lines = [
    '',
    '',
    '<attached-preview-comments>',
    'Scope: treat each attachment as the default refinement target. For visual marks, inspect the screenshot and modify the marked region first. Preserve unrelated areas.',
  ];
  for (const item of commentAttachments) {
    const targetKind =
      item.selectionKind === 'visual' ? 'visual' : item.selectionKind === 'pod' ? 'pod' : 'element';
    lines.push(
      '',
      `${item.order}. ${item.elementId}`,
      `targetKind: ${targetKind}`,
      `file: ${item.filePath}`,
      `label: ${item.label || '(unlabeled)'}`,
      `position: ${formatAttachmentPosition(item.pagePosition)}`,
      `currentText: ${item.currentText || '(empty)'}`,
      `htmlHint: ${item.htmlHint || '(none)'}`,
      `computedStyle: ${formatAnnotationStyle(item.style) || '(none)'}`,
      `comment: ${item.comment}`,
    );
    if (targetKind === 'visual') {
      lines.push(
        `screenshot: ${item.screenshotPath}`,
        `markKind: ${item.markKind || 'stroke'}`,
        `intent: ${item.intent || visualAnnotationIntent(item.markKind || 'stroke')}`,
      );
      if (item.selector) lines.push(`selector: ${item.selector}`);
    } else {
      lines.splice(lines.length - 4, 0, `selector: ${item.selector}`);
    }
    if (targetKind === 'pod') {
      lines.push(`memberCount: ${item.memberCount || item.podMembers.length || 0}`);
      item.podMembers.slice(0, 8).forEach((member, memberIndex) => {
        lines.push(
          `member.${memberIndex + 1}: ${member.elementId} | ${member.label || '(unlabeled)'} | ${member.selector}`,
        );
        const memberStyle = formatAnnotationStyle(member.style);
        if (memberStyle) lines.push(`member.${memberIndex + 1}.computedStyle: ${memberStyle}`);
      });
    }
  }
  lines.push('</attached-preview-comments>');
  return lines.join('\n');
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeVisualMarkKind(value) {
  return value === 'click' || value === 'click+stroke' || value === 'stroke'
    ? value
    : 'stroke';
}

function visualAnnotationIntent(markKind) {
  if (markKind === 'click') {
    return 'The screenshot has a blue focus box around the picked element; modify that picked part first.';
  }
  if (markKind === 'click+stroke') {
    return 'The screenshot has a blue focus box and red strokes; together they identify the part the user wants changed.';
  }
  return 'The screenshot has red strokes that identify the visual region the user wants changed.';
}

function compactString(value, max) {
  const text = cleanString(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function normalizeAttachmentPosition(input) {
  const value = input && typeof input === 'object' ? input : {};
  return {
    x: finiteAttachmentNumber(value.x),
    y: finiteAttachmentNumber(value.y),
    width: finiteAttachmentNumber(value.width),
    height: finiteAttachmentNumber(value.height),
  };
}

function normalizeAttachmentPodMembers(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((member) => {
      if (!member || typeof member !== 'object') return null;
      const elementId = cleanString(member.elementId);
      const selector = cleanString(member.selector);
      const label = cleanString(member.label);
      if (!elementId || !selector) return null;
      return {
        elementId,
        selector,
        label,
        text: compactString(member.text, 160),
        position: normalizeAttachmentPosition(member.position),
        htmlHint: compactString(member.htmlHint, 180),
        style: normalizeAnnotationStyle(member.style),
      };
    })
    .filter(Boolean);
}

function normalizeAnnotationStyle(input) {
  if (!input || typeof input !== 'object') return undefined;
  const style = {};
  for (const key of ANNOTATION_STYLE_KEYS) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed) style[key] = trimmed.slice(0, 120);
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function formatAnnotationStyle(style) {
  if (!style || typeof style !== 'object') return '';
  return ANNOTATION_STYLE_KEYS
    .map((key) => {
      const value = style[key];
      return value ? `${key}: ${value}` : null;
    })
    .filter(Boolean)
    .join('; ');
}

const ANNOTATION_STYLE_KEYS = [
  'color',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'textAlign',
  'fontFamily',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderRadius',
];

function finiteAttachmentNumber(value) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function formatAttachmentPosition(position) {
  return `x=${position.x}, y=${position.y}, width=${position.width}, height=${position.height}`;
}

function isPathWithin(base, target) {
  const relativePath = path.relative(path.resolve(base), path.resolve(target));
  return (
    relativePath === '' ||
    (relativePath.length > 0 &&
      !relativePath.startsWith('..') &&
      !path.isAbsolute(relativePath))
  );
}

export function resolveSafeProjectAttachments(cwd, attachments, opts = {}) {
  if (!cwd || !Array.isArray(attachments)) return [];
  const pathImpl = opts.pathImpl ?? path;
  const existsSync = opts.existsSync ?? fs.existsSync;
  const root = pathImpl.resolve(cwd);
  const out = [];

  for (const attachment of attachments) {
    if (typeof attachment !== 'string' || attachment.length === 0) continue;
    try {
      const abs = pathImpl.resolve(root, attachment);
      const relativePath = pathImpl.relative(root, abs);
      const withinRoot =
        relativePath === '' ||
        (relativePath.length > 0 &&
          !relativePath.startsWith('..') &&
          !pathImpl.isAbsolute(relativePath));
      if (withinRoot && existsSync(abs)) out.push(attachment);
    } catch {
      // Drop malformed paths; attachments are advisory prompt context.
    }
  }

  return out;
}

function resolveProcessResourcesPath() {
  if (
    typeof process.resourcesPath === 'string' &&
    process.resourcesPath.length > 0
  ) {
    return process.resourcesPath;
  }

  // Packaged daemon sidecars run under the bundled Node binary rather than the
  // Electron root process, so `process.resourcesPath` is unavailable there.
  // Infer the macOS app Resources directory from that bundled Node path.
  const resourcesMarker = `${path.sep}Contents${path.sep}Resources${path.sep}`;
  const markerIndex = process.execPath.indexOf(resourcesMarker);
  if (markerIndex !== -1) {
    return process.execPath.slice(0, markerIndex + resourcesMarker.length - 1);
  }

  const normalizedExecPath = process.execPath.toLowerCase();
  const windowsResourceBinMarker =
    `${path.sep}resources${path.sep}open-design${path.sep}bin${path.sep}`.toLowerCase();
  const windowsMarkerIndex = normalizedExecPath.indexOf(
    windowsResourceBinMarker,
  );
  if (windowsMarkerIndex !== -1) {
    return process.execPath.slice(
      0,
      windowsMarkerIndex + `${path.sep}resources`.length,
    );
  }

  return null;
}

// Node's ESM loader resolves symlinks when computing `__dirname` (see
// `PROJECT_ROOT = resolveProjectRoot(__dirname)`), so in a host-runtime
// install PROJECT_ROOT is already the REAL `releases/<version>` path, not
// the stable `current` symlink. A configured OD_RESOURCE_ROOT that
// legitimately (and deliberately, per deploy/host/install.sh) points
// through `<OD_HOME>/current/...` would lexically compare as outside that
// base and be wrongly rejected. Realpath both sides before the containment
// check so the symlink indirection on either side doesn't produce a false
// negative; fall back to the lexical path if realpath fails (e.g. the
// target doesn't exist yet) rather than erroring out here.
function realpathOrSelf(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

export function resolveDaemonResourceRoot({
  configured = process.env[RESOURCE_ROOT_ENV],
  safeBases = [PROJECT_ROOT, resolveProcessResourcesPath()],
} = {}) {
  if (!configured || configured.length === 0) return null;

  const resolved = path.resolve(configured);
  const realResolved = realpathOrSelf(resolved);
  const normalizedSafeBases = safeBases
    .filter((base) => typeof base === 'string' && base.length > 0)
    .map((base) => path.resolve(base));

  const isWithinAnyBase = normalizedSafeBases.some(
    (base) => isPathWithin(base, resolved) || isPathWithin(realpathOrSelf(base), realResolved),
  );
  if (!isWithinAnyBase) {
    throw new Error(
      `${RESOURCE_ROOT_ENV} must be under the workspace root or app resources path`,
    );
  }

  return resolved;
}

function resolveDaemonResourceDir(resourceRoot, segment, fallback) {
  return resourceRoot ? path.join(resourceRoot, segment) : fallback;
}

const DAEMON_RESOURCE_ROOT = resolveDaemonResourceRoot();
// Built web app lives in `out/` — that's where Next.js writes the static
// export configured in next.config.ts. The folder name used to be `dist/`
// when this project shipped with Vite; the daemon serves whatever the
// frontend toolchain emits, no further config needed.
const STATIC_DIR = path.join(PROJECT_ROOT, 'apps', 'web', 'out');
const OD_BIN = resolveDaemonCliPath();
const OD_NODE_BIN = process.execPath;
const SKILLS_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'skills',
  path.join(PROJECT_ROOT, 'skills'),
);
const DESIGN_SYSTEMS_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'design-systems',
  path.join(PROJECT_ROOT, 'design-systems'),
);
// Renderable templates pulled out of `skills/` by the skills/design-templates
// split (PR #955) so the EntryView Templates tab gets the large rendering
// catalogue and Settings → Skills only carries functional skills the agent
// invokes mid-task. See specs/current/skills-and-design-templates.md.
const DESIGN_TEMPLATES_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'design-templates',
  path.join(PROJECT_ROOT, 'design-templates'),
);
const CRAFT_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'craft',
  path.join(PROJECT_ROOT, 'craft'),
);
// User-installed skills and design systems live under the runtime data dir
// so they respect OD_DATA_DIR overrides (test isolation, packaged runs).
// Defined after RUNTIME_DATA_DIR is resolved below.
const FRAMES_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'frames',
  path.join(PROJECT_ROOT, 'assets', 'frames'),
);
// Curated pets baked into the repo via `scripts/bake-community-pets.ts`.
// `listCodexPets` scans this in addition to `~/.codex/pets/` so the
// "Recently hatched" grid is non-empty out-of-the-box and users do not
// need to hit the "Download community pets" button to try a few pets.
const BUNDLED_PETS_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'community-pets',
  path.join(PROJECT_ROOT, 'assets', 'community-pets'),
);
const PROMPT_TEMPLATES_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'prompt-templates',
  path.join(PROJECT_ROOT, 'prompt-templates'),
);
const BUNDLED_PLUGINS_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  path.join('plugins', '_official'),
  defaultBundledRoot(PROJECT_ROOT),
);
const PLUGIN_REGISTRY_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'plugins/registry',
  path.join(PROJECT_ROOT, 'plugins', 'registry'),
);
const OFFICIAL_MARKETPLACE_ID = 'official';
const OFFICIAL_PLUGIN_SOURCE_REPO = 'github:nexu-io/open-design@main';

export function isStaticSpaFallbackRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.path === '/api' || req.path.startsWith('/api/')) return false;
  if (req.path === '/artifacts' || req.path.startsWith('/artifacts/')) return false;
  if (req.path === '/frames' || req.path.startsWith('/frames/')) return false;
  if (req.path === '/_next' || req.path.startsWith('/_next/')) return false;

  const accept = req.get?.('accept') ?? '';
  return accept.length === 0 || accept.includes('text/html') || accept.includes('*/*');
}

export function resolveStaticSpaFallbackPath(req, staticDir) {
  const indexPath = path.join(staticDir, 'index.html');
  if (!fs.existsSync(indexPath) || !isStaticSpaFallbackRequest(req)) return null;
  return indexPath;
}

export function registerStaticSpaFallback(app, staticDir) {
  app.get('/*splat', (req, res, next) => {
    const indexPath = resolveStaticSpaFallbackPath(req, staticDir);
    if (indexPath == null) return next();
    // Serve relative to `root`, not by absolute path: `send` refuses any
    // absolute path that has a dot-segment (default `dotfiles: 'ignore'`),
    // and packaged installs live under `~/.open-design/...` -- an absolute
    // sendFile there 404s every deep link even though index.html exists.
    res.sendFile(path.basename(indexPath), { dotfiles: 'allow', root: path.dirname(indexPath) });
  });
}

function defaultMarketplaceSeedConfig(id) {
  return {
    trust: id === OFFICIAL_MARKETPLACE_ID ? 'official' : 'restricted',
    url:   marketplaceManifestUrlForRegistry(id),
  };
}

function bundledPluginRegistrySource(sourcePath) {
  if (isPathWithin(BUNDLED_PLUGINS_DIR, sourcePath)) {
    const rel = path.relative(BUNDLED_PLUGINS_DIR, sourcePath).split(path.sep).join('/');
    return `${OFFICIAL_PLUGIN_SOURCE_REPO}/plugins/_official/${rel}`;
  }
  const rel = path.relative(PROJECT_ROOT, sourcePath).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return sourcePath;
  return `${OFFICIAL_PLUGIN_SOURCE_REPO}/${rel}`;
}

function mergeMarketplaceEntries(manifestText, entries) {
  try {
    const parsed = JSON.parse(manifestText);
    const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
    const seen = new Set(plugins.map((entry) => String(entry?.name ?? '').toLowerCase()));
    const generated = entries.filter((entry) => {
      const key = String(entry.name ?? '').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return JSON.stringify({
      ...parsed,
      metadata: {
        ...(parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {}),
        bundledPreinstallCount: entries.length,
      },
      plugins: [...plugins, ...generated],
    });
  } catch {
    return manifestText;
  }
}

async function marketplaceSeedManifestText(id, bundledMarketplaceEntries) {
  const manifestPath = path.join(PLUGIN_REGISTRY_DIR, id, 'open-design-marketplace.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifestText = await fs.promises.readFile(manifestPath, 'utf8');
  if (id === OFFICIAL_MARKETPLACE_ID && bundledMarketplaceEntries.length > 0) {
    manifestText = mergeMarketplaceEntries(manifestText, bundledMarketplaceEntries);
  }
  return manifestText;
}

function createMarketplaceFetcher(seedId, bundledMarketplaceEntries) {
  return async (url) => {
    const registryId = marketplaceRegistryIdFromUrl(url);
    if (registryId && (!seedId || registryId === seedId)) {
      const manifestText = await marketplaceSeedManifestText(registryId, bundledMarketplaceEntries);
      if (manifestText != null) {
        return {
          ok:     true,
          status: 200,
          text:   async () => manifestText,
        };
      }
    }
    const response = await fetch(url, { redirect: 'follow' });
    return {
      ok:     response.ok,
      status: response.status,
      text:   () => response.text(),
    };
  };
}

export function resolveDataDir(raw, projectRoot) {
  if (!raw) return path.join(projectRoot, '.od');
  // expandHomePrefix is shared with media-config.ts so OD_DATA_DIR and
  // OD_MEDIA_CONFIG_DIR can never split state under a $HOME-style value.
  // Some launchers (systemd unit files, NixOS modules, certain Docker
  // entrypoints, Windows scheduled tasks) pass OD_DATA_DIR with literal
  // $HOME or ${HOME} because the variable is never expanded by a shell;
  // expandHomePrefix turns those (and the ~ shorthand, with both / and \
  // separators) into os.homedir() before path.resolve runs so launch
  // surfaces stay consistent.
  const resolved = resolveProjectRelativePath(raw, projectRoot);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch (err) {
    const e = err;
    const currentUser = (() => {
      try {
        return os.userInfo().username;
      } catch {
        return process.env.USER ?? process.env.LOGNAME ?? 'unknown';
      }
    })();
    const parentDir = path.dirname(resolved);
    throw new Error(
      [
        `OD_DATA_DIR "${resolved}" is not writable: ${e.message}`,
        `Current user: ${currentUser}`,
        `Check whether the folder or one of its parents is owned by another user, is a symlink to a protected location, or was previously created with sudo.`,
        `Try: ls -ld "${parentDir}" "${resolved}"`,
        `If the folder should belong to you, fix ownership/permissions, for example: sudo chown -R "${currentUser}":staff "${parentDir}" && chmod -R u+rwX "${parentDir}"`,
      ].join(' '),
    );
  }
  return resolved;
}
const RUNTIME_DATA_DIR = resolveDataDir(process.env.OD_DATA_DIR, PROJECT_ROOT);
const PLUGIN_LOCKFILE_PATH = path.join(RUNTIME_DATA_DIR, 'od-plugin-lock.json');
// Symbol key on the chat body used by INTERNAL callers of startChatRun to
// widen the per-run tool token (extra `/api/tools/*` endpoints/operations).
// A Symbol cannot arrive in a JSON request body, so `/api/chat` clients can't
// grant themselves anything through it.
const INTERNAL_TOOL_GRANT_EXTRAS = Symbol('od.internalToolGrantExtras');
// One Figma Desktop MCP client for the whole daemon: it holds the Streamable
// HTTP session with Figma's local server (127.0.0.1:3845) and serialises
// file switching, so every route/fan-out must share it.
const figmaDesktop = new FigmaDesktopClient();
// Canonical (realpath-resolved) form of RUNTIME_DATA_DIR for the few callers
// that compare it against a user-supplied realpath() result. On macOS, /var
// is a symlink to /private/var, so an import realpath lands in /private/var
// and would never start-with the raw RUNTIME_DATA_DIR. Keep RUNTIME_DATA_DIR
// itself as the stable, user-shaped path so OD_DATA_DIR resolution stays
// predictable; only this canonical alias is used for symlink-aware checks.
const RUNTIME_DATA_DIR_CANONICAL = (() => {
  try {
    return fs.realpathSync(RUNTIME_DATA_DIR);
  } catch {
    return RUNTIME_DATA_DIR;
  }
})();
// One-shot legacy data migration. When OD_LEGACY_DATA_DIR is set and the
// new data root is fresh (no app.sqlite), copy the 0.3.x .od/ payload
// across before SQLite opens. Synchronous on purpose: openDatabase below
// would race an async copy. See apps/daemon/src/legacy-data-migrator.ts
// and https://github.com/nexu-io/open-design/issues/710.
migrateLegacyDataDirSync({
  legacyDir: process.env.OD_LEGACY_DATA_DIR,
  dataDir: RUNTIME_DATA_DIR,
});
const ARTIFACTS_DIR = path.join(RUNTIME_DATA_DIR, 'artifacts');
// Critique Theater artifacts intentionally live outside the static
// `/artifacts` tree. The per-run artifact endpoint is the sanctioned
// read path so project-membership, size, and CSP guards cannot be bypassed.
const CRITIQUE_ARTIFACTS_DIR = path.join(RUNTIME_DATA_DIR, 'critique-artifacts');
const PROJECTS_DIR = path.join(RUNTIME_DATA_DIR, 'projects');
// WP3 (host process lifecycle): per-host-run pid bookkeeping so a daemon
// restart mid-run can still find and reap the orphaned process tree at
// boot. See specs/change/20260813-web-first/wp3-process-lifecycle.md.
const RUNS_STATE_DIR = path.join(RUNTIME_DATA_DIR, 'runs');

// Docs sub-tree scan (includeDescendants): above this many total pages the run
// still proceeds but logs a warning — a soft cap, never a hard block.
const DOCS_SUBTREE_WARN_THRESHOLD = 100;
const USER_SKILLS_DIR = path.join(RUNTIME_DATA_DIR, 'skills');
const USER_DESIGN_SYSTEMS_DIR = path.join(RUNTIME_DATA_DIR, 'design-systems');
const PLUGIN_REGISTRY_ROOTS = registryRootsForDataDir(RUNTIME_DATA_DIR);
// User-imported design templates mirror USER_SKILLS_DIR but are scanned
// against DESIGN_TEMPLATES_DIR rather than SKILLS_DIR so the EntryView
// Templates surface and the Settings → Skills surface stay decoupled.
const USER_DESIGN_TEMPLATES_DIR = path.join(RUNTIME_DATA_DIR, 'design-templates');
// Multi-root tuples used everywhere the daemon resolves a skill / template
// id without knowing which surface it came from. SKILL_ROOTS drives
// Settings → Skills; DESIGN_TEMPLATE_ROOTS drives the EntryView Templates
// gallery; ALL_SKILL_LIKE_ROOTS spans both for chat run system-prompt
// composition and the orbit template resolver, where stored project ids
// can resolve to either root after the split.
const SKILL_ROOTS = [USER_SKILLS_DIR, SKILLS_DIR];
const DESIGN_TEMPLATE_ROOTS = [USER_DESIGN_TEMPLATES_DIR, DESIGN_TEMPLATES_DIR];
const ALL_SKILL_LIKE_ROOTS = [
  USER_SKILLS_DIR,
  USER_DESIGN_TEMPLATES_DIR,
  SKILLS_DIR,
  DESIGN_TEMPLATES_DIR,
];
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
for (const dir of [USER_SKILLS_DIR, USER_DESIGN_SYSTEMS_DIR, USER_DESIGN_TEMPLATES_DIR, PLUGIN_REGISTRY_ROOTS.userPluginsRoot]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.mkdirSync(CRITIQUE_ARTIFACTS_DIR, { recursive: true });
const orbitService = new OrbitService(RUNTIME_DATA_DIR);
const designSystemGenerationJobs = createDesignSystemGenerationJobStore({
  root: USER_DESIGN_SYSTEMS_DIR,
});

/** Thư mục trên đĩa của một design-system id, hoặc null nếu không có.
 *
 *  Id trong catalog mang tiền tố `user:` cho DS người dùng nạp lên; DS dựng sẵn
 *  của repo không có tiền tố và nằm ở thư mục khác. Thử lần lượt cả hai gốc thay
 *  vì bắt caller tự biết DS thuộc loại nào. */
const dsDirForId = async (designSystemId: string): Promise<string | null> => {
  const bareId = designSystemId.replace(/^user:/, '');
  if (!bareId || bareId.includes('/') || bareId.includes('\\') || bareId.includes('..')) return null;
  for (const root of [USER_DESIGN_SYSTEMS_DIR, DESIGN_SYSTEMS_DIR]) {
    const dir = path.join(root, bareId);
    if (await fs.promises.stat(dir).then((s) => s.isDirectory()).catch(() => false)) return dir;
  }
  return null;
};
const figmaDesignSystemSourceForApp = (
  database: Parameters<typeof getFigmaDesignSystemSource>[0],
  app: { figmaDesignSystemSourceId?: string | null } | null | undefined,
) => {
  if (!app?.figmaDesignSystemSourceId) return null;
  const source = getFigmaDesignSystemSource(database, app.figmaDesignSystemSourceId);
  if (!source?.catalog) return null;
  return { id: source.id, catalog: source.catalog as FigmaComponentCatalogSnapshot };
};
const versionAppsUsingDesignSystem = async (designSystemId: string, dsDir: string) => {
  const apps = listPipelineApps(db).filter((item) => item.designSystemId === designSystemId);
  return Promise.all(apps.map(async (item) => {
    try {
      const result = await createAppContextVersion({ projectsDir: PROJECTS_DIR, appId: item.id,
        appName: item.name, designSystemId, docsReviewComponentSource: item.docsReviewComponentSource,
        figmaDesignSystemSource: figmaDesignSystemSourceForApp(db, item), designSystemDir: dsDir });
      return { appId: item.id, status: result.status, contextVersion: result.manifest.contextVersion };
    } catch (error) {
      return { appId: item.id, status: 'failed', contextVersion: null, error: String(error) };
    }
  }));
};
let routineService = null;

// In-memory OAuth state cache. Lives for the daemon process's lifetime.
// Maps the OAuth `state` parameter we generated in /api/mcp/oauth/start
// to the verifier + endpoint info needed to finish the exchange when the
// browser hits /api/mcp/oauth/callback.
const mcpPendingAuth = new PendingAuthCache();

/**
 * Resolve the daemon's public base URL — the origin the user's browser
 * (or the OAuth provider) reaches us at. Order of precedence:
 *
 *   1. `OD_PUBLIC_BASE_URL` env var. Cloud and packaged-electron deployments
 *      set this to the externally-routable URL (e.g. `https://app.example.com`).
 *   2. `req.protocol://req.get('host')` from the inbound request. Works in
 *      local dev and most reverse-proxy setups (Express respects
 *      `trust proxy` so X-Forwarded-* headers are honored).
 *
 * The OAuth callback URI is derived from this — it MUST be reachable from
 * the user's browser, otherwise the redirect after auth lands on
 * ERR_CONNECTION_REFUSED. Misconfiguration is loud: the OAuth provider
 * will reject `redirect_uri` mismatches.
 */
function getPublicBaseUrl(req) {
  const env = process.env.OD_PUBLIC_BASE_URL;
  if (env && /^https?:\/\//i.test(env)) {
    return env.replace(/\/+$/u, '');
  }
  const proto = req.protocol || 'http';
  const host = req.get('host');
  if (!host) return `http://localhost:${process.env.OD_PORT ?? '7456'}`;
  return `${proto}://${host}`;
}

function mcpOAuthCallbackUrl(req) {
  return `${getPublicBaseUrl(req)}/api/mcp/oauth/callback`;
}

/**
 * Refresh an expired token using the OAuth client context that the original
 * authorization-code exchange persisted alongside the token. Refresh tokens
 * are bound (RFC 6749 §6) to the client that received them, so we MUST
 * refresh against the same `tokenEndpoint` / `clientId` / `clientSecret`
 * pair — re-running discovery with a different redirect URI would risk
 * registering a new client_id that the upstream then rejects the refresh
 * for. Tokens persisted before that context was recorded can't be safely
 * refreshed; the caller treats `null` as "needs reconnect".
 */
async function refreshAndPersistToken(dataDir, serverId, current) {
  if (!current.refreshToken) return null;
  if (!current.tokenEndpoint || !current.clientId) return null;
  const tokenResp = await refreshAccessToken({
    tokenEndpoint: current.tokenEndpoint,
    clientId: current.clientId,
    clientSecret: current.clientSecret,
    refreshToken: current.refreshToken,
    scope: current.scope,
    resource: current.resourceUrl,
  });
  const next = {
    accessToken: tokenResp.access_token,
    refreshToken: tokenResp.refresh_token ?? current.refreshToken,
    tokenType: tokenResp.token_type ?? 'Bearer',
    scope: tokenResp.scope ?? current.scope,
    expiresAt:
      typeof tokenResp.expires_in === 'number'
        ? Date.now() + tokenResp.expires_in * 1000
        : undefined,
    savedAt: Date.now(),
    tokenEndpoint: current.tokenEndpoint,
    clientId: current.clientId,
    clientSecret: current.clientSecret,
    authServerIssuer: current.authServerIssuer,
    redirectUri: current.redirectUri,
    resourceUrl: current.resourceUrl,
  };
  await setToken(dataDir, serverId, next);
  return next;
}

const activeChatAgentEventSinks = new Map();
const activeProjectEventSinks = new Map();
// Per-chat-run handles, keyed by runId. Lets non-stream side effects
// (live-artifact create, project events) reach back into the chat
// run's local state — currently used by the artifact quiet-period
// shortcut (#1451) so a successful artifact registration can shorten
// the inactivity watchdog without the chat path having to poll a
// store.
const activeChatRunHandles = new Map();

function emitChatAgentEvent(runId, payload) {
  const sink = activeChatAgentEventSinks.get(runId);
  if (!sink) return false;
  return sink(payload);
}

// Exported for tests covering the artifact quiet-period plumbing
// (#1451). The chat run path is a deep closure inside startServer, so
// pin the hook contract at the emit/handle boundary instead of
// driving a full fake-agent e2e for every invariant.
export const __forTestChatRunHandles = activeChatRunHandles;

export function __forTestEmitLiveArtifactEvent(
  grant: { runId?: string; projectId?: string },
  action: 'created' | 'updated' | 'deleted',
  artifact: { id: string; projectId?: string; title?: string; refreshStatus?: string },
) {
  return emitLiveArtifactEvent(grant, action, artifact);
}

function emitLiveArtifactEvent(grant, action, artifact) {
  if (!artifact?.id) return false;
  const payload = {
    type: 'live_artifact',
    action,
    projectId: artifact.projectId ?? grant.projectId,
    artifactId: artifact.id,
    title: artifact.title ?? artifact.id,
    refreshStatus: artifact.refreshStatus,
  };
  let emitted = emitProjectEvent(payload.projectId, payload);
  if (grant?.runId) emitted = emitChatAgentEvent(grant.runId, payload) || emitted;
  // After the deliverable exists, switch the chat run into a shorter
  // "quiet period" watchdog: agents sometimes keep their child process
  // alive after a successful artifact write (post-write reasoning, log
  // flushes, claude-code stream-json's idle stdin) and the 10-minute
  // default leaves the UI parked on Working until the watchdog fires
  // an unrelated "stalled" error. See #1451.
  if (action === 'created' && grant?.runId) {
    const handle = activeChatRunHandles.get(grant.runId);
    if (handle?.noteArtifactRegistered) {
      try { handle.noteArtifactRegistered(); } catch {}
    }
  }
  return emitted;
}

function emitLiveArtifactRefreshEvent(grant, payload) {
  if (!payload?.artifactId) return false;
  const event = {
    type: 'live_artifact_refresh',
    projectId: grant.projectId,
    ...payload,
  };
  let emitted = emitProjectEvent(grant.projectId, event);
  if (grant?.runId) emitted = emitChatAgentEvent(grant.runId, event) || emitted;
  return emitted;
}

// Broadcast an event to every SSE subscriber currently watching the given
// project's `/api/projects/:id/events` stream. The payload's `type` field
// becomes the SSE event name (see project-routes.ts). Used for live-artifact
// events and `conversation-created` events emitted by routine runs (#1361).
function emitProjectEvent(projectId, payload) {
  const sinks = activeProjectEventSinks.get(projectId);
  if (!sinks || sinks.size === 0) return false;
  for (const sink of Array.from(sinks)) {
    try {
      sink(payload);
    } catch {
      sinks.delete(sink);
    }
  }
  if (sinks.size === 0) activeProjectEventSinks.delete(projectId);
  return true;
}

// Windows ENAMETOOLONG mitigation constants
const CMD_BAT_RE = /\.(cmd|bat)$/i;
const PROMPT_TEMP_FILE = () =>
  '.od-prompt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.md';
const promptFileBootstrap = (fp) =>
  `Your full instructions are stored in the file: ${fp.replace(/\\/g, '/')}. ` +
  'Open that file first and follow every instruction in it exactly — ' +
  'it contains the system prompt, design system, skill workflow, and user request. ' +
  'Do not begin your response until you have read the entire file.';

// Load Critique Theater config once at startup so a bad OD_CRITIQUE_* value
// surfaces immediately as a boot-time RangeError instead of silently at
// run time. Default: enabled=false (M0 dark launch).
const critiqueCfg = loadCritiqueConfigFromEnv();
// Tracks adapter streamFormat values that have already received a one-time
// warning explaining why the Critique Theater orchestrator was bypassed.
// Adapter denylist for orchestrator routing is implicit: anything that is
// not the 'plain' streamFormat falls through to legacy single-pass.
const critiqueWarnedAdapters = new Set<string>();

// In-process registry of in-flight critique runs so the interrupt endpoint
// can cascade an AbortController to the matching orchestrator invocation.
// Created once per process; not persisted across daemon restarts.
const critiqueRunRegistry = createRunRegistry();
export const SSE_KEEPALIVE_INTERVAL_MS = 25_000;

export function createAgentRuntimeEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  daemonUrl: string,
  toolTokenGrant: { token?: string } | null = null,
  nodeBin: string = process.execPath,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    OD_DATA_DIR: RUNTIME_DATA_DIR,
    OD_DAEMON_URL: daemonUrl,
    OD_NODE_BIN: nodeBin,
  };

  // Ensure the node binary directory is on PATH so agent sub-processes —
  // in particular npm .cmd shims on Windows that run `"node" script.js` —
  // can find the same node binary that runs the daemon even when the daemon
  // was launched with a full path to node and the directory was not on PATH.
  const nodeBinDir = path.dirname(nodeBin);
  if (nodeBinDir) {
    // On Windows, process.env spreads with the search path under 'Path' rather
    // than 'PATH'. Locate the key case-insensitively so we read and write the
    // same entry that child_process.spawn consults. If we blindly write a new
    // 'PATH' key alongside an existing 'Path', Node's case-insensitive env
    // de-duplication on Windows lets the new key win — dropping all inherited
    // directories (git, npm, agent shims, etc.) from the child's search path.
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    const existingPath = typeof env[pathKey] === 'string' ? (env[pathKey] as string) : '';
    const parts = existingPath.split(path.delimiter).filter((p) => p.length > 0);
    const normalize = (p: string) => p.replace(/[/\\]+$/, '');
    const normalizedDir = normalize(nodeBinDir);
    const alreadyIncluded = parts.some((p) => {
      const n = normalize(p);
      return process.platform === 'win32'
        ? n.toLowerCase() === normalizedDir.toLowerCase()
        : n === normalizedDir;
    });
    if (!alreadyIncluded) {
      env[pathKey] = [nodeBinDir, ...parts].join(path.delimiter);
    }
  }

  if (toolTokenGrant?.token) {
    env.OD_TOOL_TOKEN = toolTokenGrant.token;
  } else {
    delete env.OD_TOOL_TOKEN;
  }

  return env;
}

export function createAgentRuntimeToolPrompt(
  daemonUrl: string,
  toolTokenGrant: { token?: string } | null = null,
): string {
  const tokenLine = toolTokenGrant?.token
    ? '- `OD_TOOL_TOKEN` is available in your environment for this run. Use it only through project wrapper commands; do not print, persist, or override it.'
    : '- `OD_TOOL_TOKEN` is not available for this run, so `/api/tools/*` wrapper commands may be unavailable.';

  return [
    '## Runtime tool environment',
    '',
    `- Daemon URL: \`${daemonUrl}\` (also available as \`OD_DAEMON_URL\`).`,
    '- `OD_NODE_BIN` is the absolute path to the Node-compatible runtime that started the daemon; packaged desktop installs provide this even when the user has no system `node` on PATH.',
    '- `OD_BIN` is the absolute path to the Open Design CLI script. On POSIX shells run wrappers with `"$OD_NODE_BIN" "$OD_BIN" tools ...`; do not call bare `od`, which may resolve to the system octal-dump command on Unix-like systems.',
    '- On PowerShell use `& $env:OD_NODE_BIN $env:OD_BIN tools ...`; on cmd.exe use `"%OD_NODE_BIN%" "%OD_BIN%" tools ...`.',
    tokenLine,
    '- Prefer project wrapper commands through `OD_NODE_BIN` + `OD_BIN` over raw HTTP. The wrappers read these environment values automatically.',
  ].join('\n');
}

function normalizeRunContextSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const stringList = (items) => {
    if (!Array.isArray(items)) return [];
    const out = [];
    const seen = new Set();
    for (const item of items) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  };
  return {
    skillIds: stringList(value.skillIds),
    pluginIds: stringList(value.pluginIds),
    mcpServerIds: stringList(value.mcpServerIds),
    connectorIds: stringList(value.connectorIds),
  };
}

function mergeRunContextSelections(...contexts) {
  const merged = { skillIds: [], pluginIds: [], mcpServerIds: [], connectorIds: [] };
  for (const context of contexts) {
    const normalized = normalizeRunContextSelection(context);
    for (const key of Object.keys(merged)) {
      const seen = new Set(merged[key]);
      for (const id of normalized[key] ?? []) {
        if (!seen.has(id)) {
          seen.add(id);
          merged[key].push(id);
        }
      }
    }
  }
  return Object.fromEntries(
    Object.entries(merged).filter(([, ids]) => ids.length > 0),
  );
}

function projectMetadataContextSelection(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  return {
    pluginIds: Array.isArray(metadata.contextPlugins)
      ? metadata.contextPlugins.map((item) => item?.id).filter((id) => typeof id === 'string')
      : [],
    mcpServerIds: Array.isArray(metadata.contextMcpServers)
      ? metadata.contextMcpServers.map((item) => item?.id).filter((id) => typeof id === 'string')
      : [],
    connectorIds: Array.isArray(metadata.contextConnectors)
      ? metadata.contextConnectors.map((item) => item?.id).filter((id) => typeof id === 'string')
      : [],
  };
}

function formatContextRefList(ids, refs, titleKey = 'title') {
  const byId = new Map();
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (ref && typeof ref.id === 'string') byId.set(ref.id, ref);
    }
  }
  return ids
    .map((id) => {
      const ref = byId.get(id);
      const label =
        typeof ref?.[titleKey] === 'string' && ref[titleKey].trim()
          ? ref[titleKey].trim()
          : typeof ref?.label === 'string' && ref.label.trim()
            ? ref.label.trim()
            : typeof ref?.name === 'string' && ref.name.trim()
              ? ref.name.trim()
              : id;
      const meta = [
        ref?.provider,
        ref?.transport,
        ref?.status,
        ref?.accountLabel,
      ].filter((value) => typeof value === 'string' && value.trim()).join(' · ');
      return `- ${label} (\`${id}\`)${meta ? ` — ${meta}` : ''}`;
    })
    .join('\n');
}

function renderRunContextPrompt(selection, metadata) {
  const context = mergeRunContextSelections(projectMetadataContextSelection(metadata), selection);
  const lines = [];
  if (Array.isArray(context.pluginIds) && context.pluginIds.length > 0) {
    lines.push('### Selected plugins');
    lines.push(
      'The user selected these plugins as run context. When an active plugin snapshot is pinned, follow that executable plugin block; otherwise combine these plugins as requested references.',
    );
    lines.push(formatContextRefList(context.pluginIds, metadata?.contextPlugins ?? [], 'title'));
  }
  if (Array.isArray(context.mcpServerIds) && context.mcpServerIds.length > 0) {
    lines.push('### Selected MCP servers');
    lines.push(
      'The user selected these MCP servers for this run. Prefer their tools when they are mounted and relevant before asking where data should come from.',
    );
    lines.push(formatContextRefList(context.mcpServerIds, metadata?.contextMcpServers ?? [], 'label'));
  }
  if (Array.isArray(context.connectorIds) && context.connectorIds.length > 0) {
    lines.push('### Selected connectors');
    lines.push(
      'The user selected these connectors for this run. Discover available read-only connector tools first with `"$OD_NODE_BIN" "$OD_BIN" tools connectors list --format compact`, then execute relevant tools through `tools connectors execute`; do not ask for a data source that is already selected.',
    );
    lines.push(formatContextRefList(context.connectorIds, metadata?.contextConnectors ?? [], 'name'));
  }
  if (lines.length === 0) return '';
  return ['## Selected run context', ...lines].join('\n');
}

export function normalizeProjectDisplayStatus(status) {
  return status === 'starting' || status === 'queued' ? 'running' : status;
}

export function composeProjectDisplayStatus(
  baseStatus,
  awaitingInputProjects,
  projectId,
) {
  if (
    baseStatus.value === 'succeeded' &&
    awaitingInputProjects.has(projectId)
  ) {
    return { ...baseStatus, value: 'awaiting_input' };
  }
  return {
    ...baseStatus,
    value: normalizeProjectDisplayStatus(baseStatus.value),
  };
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 * @returns {ApiError}
 */
export function createCompatApiError(code, message, init = {}) {
  return { code, message, ...init };
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 * @returns {ApiErrorResponse}
 */
export function createCompatApiErrorResponse(code, message, init = {}) {
  return { error: createCompatApiError(code, message, init) };
}

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 */
function sendApiError(res, status, code, message, init = {}) {
  return res
    .status(status)
    .json(createCompatApiErrorResponse(code, message, init));
}

function normalizeProjectPluginFolderPath(input) {
  const value = String(input ?? '').replace(/\\/g, '/').trim();
  if (!value || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
    throw new Error('plugin folder path must be a relative project path');
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error('plugin folder path must not contain traversal segments');
  }
  return parts.join('/');
}

async function resolveProjectChildDirectory(projectRoot, relativePath) {
  const rootReal = await fs.promises.realpath(projectRoot);
  const candidate = path.resolve(projectRoot, relativePath);
  const real = await fs.promises.realpath(candidate);
  if (!real.startsWith(rootReal + path.sep) && real !== rootReal) {
    throw new Error('plugin folder path escapes project dir');
  }
  const st = await fs.promises.stat(real);
  if (!st.isDirectory()) {
    const err = new Error('plugin folder path is not a directory');
    err.code = 'ENOTDIR';
    throw err;
  }
  return real;
}

function execFileBuffered(command, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 120_000, maxBuffer: 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code,
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim(),
        error,
      });
    });
  });
}

function quotePosixShellArg(value) {
  const text = String(value ?? '');
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function buildGhShellCommand(args) {
  return ['gh', ...args].map(quotePosixShellArg).join(' ');
}

function buildCommandShellCommand(command, args) {
  return [command, ...args].map(quotePosixShellArg).join(' ');
}

function buildLoginShellCommand(innerCommand) {
  // Use a non-login shell and re-export PATH so test fakes and agent wrappers
  // remain visible; login shells often reset PATH from profile scripts.
  return `export PATH=${quotePosixShellArg(process.env.PATH ?? '')}; ${innerCommand}`;
}

function execGhBuffered(args, opts = {}) {
  if (process.platform === 'win32') return execFileBuffered('gh', args, opts);
  const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL.trim() : '/bin/zsh';
  return execFileBuffered(shell, ['-c', buildLoginShellCommand(buildGhShellCommand(args))], {
    env: process.env,
    ...opts,
  });
}

function execCommandViaLoginShell(command, args, opts = {}) {
  if (process.platform === 'win32') return execFileBuffered(command, args, opts);
  const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL.trim() : '/bin/zsh';
  return execFileBuffered(shell, ['-c', buildLoginShellCommand(buildCommandShellCommand(command, args))], {
    env: process.env,
    ...opts,
  });
}

async function readProjectPluginManifest(folder) {
  const raw = await fs.promises.readFile(path.join(folder, 'open-design.json'), 'utf8');
  const manifest = JSON.parse(raw);
  const name = typeof manifest.name === 'string' && manifest.name.trim()
    ? manifest.name.trim()
    : path.basename(folder);
  if (/[/\\]/.test(name) || /^\.+$/.test(name)) {
    throw new Error(
      `open-design.json in ${folder}: name "${name}" must not contain path separators or consist only of dots`,
    );
  }
  return {
    name,
    title: typeof manifest.title === 'string' ? manifest.title : name,
    version: typeof manifest.version === 'string' ? manifest.version : '0.1.0',
    manifest,
  };
}

export const __forTestReadProjectPluginManifest = readProjectPluginManifest;

function githubRepoNameFromPluginName(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/(^[-._]+|[-._]+$)/g, '');
  return slug || 'open-design-plugin';
}

const PLUGIN_SHARE_ACTION_LABELS = {
  'publish-github': 'Publish to GitHub',
  'contribute-open-design': 'Contribute to Open Design',
};

const USER_PLUGIN_SOURCE_KINDS = new Set([
  'user',
  'project',
  'marketplace',
  'github',
  'url',
  'local',
]);

const PLUGIN_CONTEXT_SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.od',
  '.output',
  '.tmp',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

const PLUGIN_CONTEXT_SKIP_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
]);

function normalizePluginShareAction(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  return Object.prototype.hasOwnProperty.call(PLUGIN_SHARE_ACTION_PLUGIN_IDS, value)
    ? value
    : null;
}

function renderPluginSharePrompt({ action, sourcePlugin, stagedPath }) {
  const title = sourcePlugin.title || sourcePlugin.id;
  if (action === 'publish-github') {
    return [
      `Publish the local Open Design plugin "${title}" as a new public GitHub repository.`,
      '',
      `The plugin source files have been copied into this project at \`${stagedPath}\`.`,
      'Use the local daemon share endpoint so the publish flow runs through Open Design\'s validated GitHub path:',
      '',
      '```bash',
      `curl -sS -X POST "$OD_DAEMON_URL/api/projects/$OD_PROJECT_ID/plugins/publish-github" \\`,
      `  -H 'content-type: application/json' \\`,
      `  -d '${JSON.stringify({ path: stagedPath })}'`,
      '```',
      '',
      'Read the JSON response. If `ok` is true, report the final repository URL and any validation/log summary. If it fails, report the `message`, `code`, and the useful log lines. The endpoint checks `gh` auth and performs the repository creation; do not hand-roll a second GitHub flow unless you are explaining a daemon endpoint failure.',
      '',
      'Do not rewrite the plugin unless publishing requires a small metadata fix. If you make any fix, explain it before publishing.',
    ].join('\n');
  }
  return [
    `Open a pull request to add the local Open Design plugin "${title}" to the Open Design repository.`,
    '',
    `The plugin source files have been copied into this project at \`${stagedPath}\`.`,
    'Use the local daemon share endpoint so the contribution flow runs through Open Design\'s validated GitHub path:',
    '',
    '```bash',
    `curl -sS -X POST "$OD_DAEMON_URL/api/projects/$OD_PROJECT_ID/plugins/contribute-open-design" \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${JSON.stringify({ path: stagedPath })}'`,
    '```',
    '',
    'Read the JSON response. If `ok` is true, report the PR URL, branch, and any validation/log summary. If it fails, report the `message`, `code`, and the useful log lines. The endpoint checks `gh` auth, forks/clones, pushes, and opens the PR; do not hand-roll a second GitHub flow unless you are explaining a daemon endpoint failure.',
    '',
    'Keep the PR focused on this plugin. Report the PR URL and any validation you ran.',
  ].join('\n');
}

async function copyPluginFolderForProjectContext(sourceRoot, destRoot) {
  const rootReal = await fs.promises.realpath(sourceRoot);
  const stat = await fs.promises.stat(rootReal);
  if (!stat.isDirectory()) {
    const err = new Error('plugin source path is not a directory');
    err.code = 'ENOTDIR';
    throw err;
  }
  await copyPluginContextDir(rootReal, destRoot, rootReal);
}

async function copyPluginContextDir(src, dest, rootReal) {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkipPluginContextEntry(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;

    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      const childReal = await fs.promises.realpath(from).catch(() => null);
      if (!childReal || (childReal !== rootReal && !childReal.startsWith(rootReal + path.sep))) {
        continue;
      }
      await copyPluginContextDir(childReal, to, rootReal);
      continue;
    }
    if (!entry.isFile()) continue;
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    await fs.promises.copyFile(from, to);
  }
}

function shouldSkipPluginContextEntry(name) {
  return PLUGIN_CONTEXT_SKIP_DIRS.has(name) || PLUGIN_CONTEXT_SKIP_FILES.has(name);
}

async function ensureGhReady() {
  const version = await execGhBuffered(['--version'], { timeout: 10_000 });
  if (!version.ok) {
    return {
      ok: false,
      code: 'gh-not-installed',
      message: 'GitHub CLI is not installed. Install it, then click this action again.',
      url: 'https://cli.github.com/',
      log: [version.stderr || version.stdout || 'gh --version failed'],
    };
  }
  const auth = await execGhBuffered(['auth', 'status', '--hostname', 'github.com'], { timeout: 10_000 });
  if (!auth.ok) {
    return {
      ok: false,
      code: 'gh-not-authenticated',
      message: 'GitHub CLI is installed but not authenticated. Run `gh auth login --web`, finish browser authorization, then click this action again.',
      url: 'https://github.com/login/device',
      log: [auth.stderr || auth.stdout || 'gh auth status failed'],
    };
  }
  return { ok: true, log: [version.stdout, auth.stderr || auth.stdout].filter(Boolean) };
}

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

function reconcileAssistantMessageOnRunEnd(db, runs, run) {
  if (!run.assistantMessageId) return;
  void runs
    .wait(run)
    .then((finalStatus) => {
      db.prepare(
        `UPDATE messages
            SET run_status = ?, ended_at = COALESCE(ended_at, ?)
          WHERE id = ? AND run_status IN ('queued', 'running')`,
      ).run(finalStatus.status, Date.now(), run.assistantMessageId);
    })
    .catch((err) => {
      console.warn('[runs] message reconciliation failed', err);
    });
}

function detectSkillPluginCandidateOnRunSuccess(db, runs, run, input, projectRoot) {
  if (!run.projectId || !run.conversationId) return;
  void runs
    .wait(run)
    .then(async (finalStatus) => {
      if (finalStatus.status !== 'succeeded') return;
      const detected = await detectSkillPluginCandidate({
        projectId: run.projectId,
        runId: run.id,
        conversationId: run.conversationId,
        assistantMessageId: null,
        message: input?.message ?? input?.currentPrompt,
        attachments: input?.attachments,
        projectRoot,
      });
      const candidate = detected ? insertSkillPluginCandidate(db, detected) : null;
      if (!candidate || candidate.status === 'dismissed') return;
      upsertSkillPluginCandidateAssistantMessage(db, run, candidate);
    })
    .catch((err) => {
      console.warn('[plugins] skill candidate detection failed', err);
    });
}

export function upsertSkillPluginCandidateAssistantMessage(db, run, candidate) {
  const currentMessagePosition = run.assistantMessageId
    ? (db.prepare(`SELECT position FROM messages WHERE id = ?`).get(run.assistantMessageId)?.position ?? null)
    : null;
  const existingMessagePosition = candidate.assistantMessageId
    ? (db.prepare(`SELECT position FROM messages WHERE id = ?`).get(candidate.assistantMessageId)?.position ?? null)
    : null;
  if (
    typeof currentMessagePosition === 'number' &&
    typeof existingMessagePosition === 'number' &&
    existingMessagePosition > currentMessagePosition
  ) {
    return null;
  }
  const canReuseExistingMessage =
    candidate.assistantMessageId &&
    candidate.assistantMessageId !== run.assistantMessageId &&
    typeof existingMessagePosition === 'number';
  const messageId = canReuseExistingMessage ? candidate.assistantMessageId : randomUUID();
  if (
    candidate.assistantMessageId &&
    candidate.assistantMessageId !== messageId &&
    candidate.assistantMessageId !== run.assistantMessageId
  ) {
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(candidate.assistantMessageId);
  }
  const now = Date.now();
  upsertMessage(db, run.conversationId, {
    id: messageId,
    role: 'assistant',
    content: `Open Design found reusable skill material that can become a plugin: ${candidate.title}`,
    agentId: run.agentId ?? undefined,
    events: [{
      kind: 'plugin_candidate',
      candidateId: candidate.id,
      title: candidate.title,
      description: candidate.description,
      confidence: candidate.confidence,
      draftPath: candidate.draftPath ?? null,
    }],
    createdAt: now,
    endedAt: now,
  });
  db.prepare(
    `UPDATE skill_plugin_candidates
        SET assistant_message_id = ?, updated_at = ?
      WHERE id = ?`,
  ).run(messageId, now, candidate.id);
  return messageId;
}

function persistRunEventToAssistantMessage(db, run, event, data) {
  if (!run.assistantMessageId) return;
  const persisted = runSseEventToPersistedAgentEvent(event, data);
  if (!persisted) return;
  try {
    appendMessageAgentEvent(db, run.assistantMessageId, persisted);
  } catch (err) {
    console.warn('[runs] message event persistence failed', err);
  }
}

function runSseEventToPersistedAgentEvent(event, data) {
  if (event === 'start') {
    return {
      kind: 'status',
      label: 'starting',
      ...(typeof data?.bin === 'string' ? { detail: data.bin } : {}),
    };
  }
  if (event === 'stdout') {
    const chunk = typeof data?.chunk === 'string' ? data.chunk : '';
    return chunk ? { kind: 'text', text: chunk } : null;
  }
  if (event === 'error') {
    const message = typeof data?.error?.message === 'string'
      ? data.error.message
      : typeof data?.message === 'string'
        ? data.message
        : '';
    return {
      kind: 'status',
      label: 'error',
      ...(message ? { detail: message } : {}),
    };
  }
  if (event !== 'agent') return null;
  return daemonAgentPayloadToPersistedAgentEvent(data);
}

function daemonAgentPayloadToPersistedAgentEvent(data) {
  const type = data?.type;
  if (type === 'status' && typeof data.label === 'string') {
    const detail =
      typeof data.detail === 'string'
        ? data.detail
        : typeof data.model === 'string'
          ? data.model
          : typeof data.ttftMs === 'number'
            ? `first token in ${Math.round(data.ttftMs / 100) / 10}s`
            : undefined;
    return { kind: 'status', label: data.label, ...(detail ? { detail } : {}) };
  }
  if (type === 'text_delta' && typeof data.delta === 'string') {
    return { kind: 'text', text: data.delta };
  }
  if (type === 'thinking_delta' && typeof data.delta === 'string') {
    return { kind: 'thinking', text: data.delta };
  }
  if (type === 'thinking_start') return { kind: 'status', label: 'thinking' };
  if (type === 'live_artifact') {
    return {
      kind: 'live_artifact',
      action: data.action,
      projectId: data.projectId,
      artifactId: data.artifactId,
      title: data.title,
      ...(data.refreshStatus ? { refreshStatus: data.refreshStatus } : {}),
    };
  }
  if (type === 'live_artifact_refresh') {
    return {
      kind: 'live_artifact_refresh',
      phase: data.phase,
      projectId: data.projectId,
      artifactId: data.artifactId,
      ...(data.refreshId ? { refreshId: data.refreshId } : {}),
      ...(data.title ? { title: data.title } : {}),
      ...(typeof data.refreshedSourceCount === 'number'
        ? { refreshedSourceCount: data.refreshedSourceCount }
        : {}),
      ...(data.error ? { error: data.error } : {}),
    };
  }
  if (type === 'tool_use' && typeof data.id === 'string' && typeof data.name === 'string') {
    return { kind: 'tool_use', id: data.id, name: data.name, input: normalizePersistedToolInput(data.input) };
  }
  if (type === 'tool_result' && typeof data.toolUseId === 'string') {
    return {
      kind: 'tool_result',
      toolUseId: data.toolUseId,
      content: String(data.content ?? ''),
      isError: Boolean(data.isError),
    };
  }
  if (type === 'usage') {
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
    return {
      kind: 'usage',
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(typeof data.costUsd === 'number' ? { costUsd: data.costUsd } : {}),
      ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
    };
  }
  if (type === 'raw' && typeof data.line === 'string') return { kind: 'raw', line: data.line };
  return null;
}

function normalizePersistedToolInput(input) {
  if (!input || typeof input !== 'object') return input;
  if ('filePath' in input && typeof input.filePath === 'string') {
    return { ...input, file_path: input.filePath };
  }
  return input;
}

function pinAssistantMessageOnRunCreate(db, run) {
  if (!run.conversationId || !run.assistantMessageId) return;
  const existing = db
    .prepare(`SELECT id FROM messages WHERE id = ?`)
    .get(run.assistantMessageId);
  if (existing) {
    db.prepare(
      `UPDATE messages
          SET run_id = ?,
              run_status = CASE
                WHEN run_status IN ('succeeded', 'failed', 'canceled') THEN run_status
                ELSE ?
              END,
              started_at = COALESCE(started_at, ?)
        WHERE id = ?`,
    ).run(run.id, run.status, run.createdAt, run.assistantMessageId);
    return;
  }
  upsertMessage(db, run.conversationId, {
    id: run.assistantMessageId,
    role: 'assistant',
    content: '',
    agentId: run.agentId ?? undefined,
    events: [],
    runId: run.id,
    runStatus: run.status,
    startedAt: run.createdAt,
  });
}

export function shouldReportRunCompletedFromMessage(saved, body = {}) {
  return Boolean(
    saved &&
      saved.runId &&
      typeof saved.runStatus === 'string' &&
      TERMINAL_RUN_STATUSES.has(saved.runStatus) &&
      body?.telemetryFinalized === true,
  );
}

export function telemetryPromptFromRunRequest(message, currentPrompt) {
  return typeof currentPrompt === 'string' ? currentPrompt : message;
}

const FORM_ANSWERS_HEADER_RE = /^\s*\[form answers\s+(?:\u2014|-)\s*([^\]\r\n]+)\]/i;

function formAnswerTransitionForCurrentPrompt(currentPrompt) {
  if (typeof currentPrompt !== 'string') return null;
  const trimmed = currentPrompt.trim();
  if (!trimmed) return null;
  const match = FORM_ANSWERS_HEADER_RE.exec(trimmed);
  if (!match) return null;
  const rawFormId = (match[1] || 'form').trim() || 'form';
  const formId = rawFormId.replace(/[^\w.-]/g, '') || 'form';
  const lines = [
    '## Latest user turn - form answers submitted',
    trimmed,
    '',
    `The user has answered the ${formId} form. Do not emit another ${formId} form.`,
  ];
  if (formId.toLowerCase() === 'discovery') {
    lines.push(
      'Continue with RULE 2 / RULE 3 now. For Branch B answers, build now instead of asking another brief.',
    );
  } else {
    lines.push(
      'Treat these form answers as the active user turn instead of replaying the transcript as a fresh request.',
    );
  }
  return lines.join('\n');
}

export function composeChatUserRequestForAgent(message, currentPrompt) {
  const body =
    typeof message === 'string' && message.trim()
      ? message
      : '(No extra typed instruction.)';
  const transition = formAnswerTransitionForCurrentPrompt(currentPrompt);
  if (!transition) return body;
  return [
    transition,
    '## Full conversation transcript',
    body,
  ].join('\n\n');
}

export function createFinalizedMessageTelemetryReporter({
  design,
  db,
  dataDir,
  reportedRuns,
  getAppVersion = () => null,
  report = reportRunCompletedFromDaemon,
}: {
  design: any;
  db: unknown;
  dataDir: string;
  reportedRuns: Set<string>;
  getAppVersion?: () => any;
  report?: typeof reportRunCompletedFromDaemon;
}) {
  return (saved, body = {}) => {
    if (!shouldReportRunCompletedFromMessage(saved, body)) return;
    const run = design.runs.get(saved.runId);
    if (!run || reportedRuns.has(run.id)) return;
    reportedRuns.add(run.id);
    void report({
      db,
      dataDir,
      run,
      persistedRunStatus: saved.runStatus,
      persistedEndedAt: saved.endedAt,
      appVersion: getAppVersion(),
    });
  };
}

const CLOUDFLARE_PAGES_PROJECT_METADATA_KEY = 'cloudflarePagesProjectName';

function cloudflarePagesDeploymentMetadata(projectName) {
  const normalized = typeof projectName === 'string' ? projectName.trim() : '';
  return normalized
    ? { [CLOUDFLARE_PAGES_PROJECT_METADATA_KEY]: normalized }
    : undefined;
}

function cloudflarePagesProjectNameFromDeployment(deployment) {
  const value = deployment?.providerMetadata?.[CLOUDFLARE_PAGES_PROJECT_METADATA_KEY];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return cloudflarePagesProjectNameFromUrl(deployment?.url);
}

function cloudflarePagesProjectNameFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (!host.endsWith('.pages.dev')) return '';
    const labels = host.slice(0, -'.pages.dev'.length).split('.').filter(Boolean);
    return labels.at(-1) || '';
  } catch {
    return '';
  }
}

function cloudflarePagesProjectNameForDeploy(db, projectId, projectName, prior) {
  const priorName = cloudflarePagesProjectNameFromDeployment(prior);
  if (priorName) return priorName;

  for (const deployment of listDeployments(db, projectId)) {
    if (deployment.providerId !== CLOUDFLARE_PAGES_PROVIDER_ID) continue;
    const stableName = cloudflarePagesProjectNameFromDeployment(deployment);
    if (stableName) return stableName;
  }

  return cloudflarePagesProjectNameForProject(projectId, projectName);
}

function publicDeployment(deployment) {
  if (!deployment || typeof deployment !== 'object') return deployment;
  const { providerMetadata: _providerMetadata, ...publicShape } = deployment;
  return publicShape;
}

function publicDeployments(deployments) {
  return (deployments || []).map(publicDeployment);
}

async function checkCloudflarePagesDeploymentLinks(existing) {
  const current = existing.cloudflarePages || {};
  const projectName = current.projectName || cloudflarePagesProjectNameFromDeployment(existing);
  const config = await readDeployConfig(CLOUDFLARE_PAGES_PROVIDER_ID);
  const pagesDevUrl = current.pagesDev?.url || existing.url;
  const pagesDevResult = await checkDeploymentUrl(pagesDevUrl);
  const pagesDev = {
    ...(current.pagesDev || {}),
    url: pagesDevUrl,
    status: pagesDevResult.reachable ? 'ready' : pagesDevResult.status || 'link-delayed',
    statusMessage: pagesDevResult.reachable
      ? 'Public link is ready.'
      : pagesDevResult.statusMessage || current.pagesDev?.statusMessage || 'Cloudflare Pages is still preparing the pages.dev link.',
    reachableAt: pagesDevResult.reachable ? Date.now() : current.pagesDev?.reachableAt,
  };
  let customDomain = current.customDomain;
  if (customDomain?.url && customDomain.status !== 'conflict') {
    let pagesDomain = null;
    if (config?.token && config?.accountId && projectName) {
      try {
        pagesDomain = await readCloudflarePagesDomain({ ...config, projectName }, customDomain.hostname);
      } catch {
        pagesDomain = null;
      }
    }
    const customResult = await checkDeploymentUrl(customDomain.url);
    const pagesDomainStatus = pagesDomain?.status || customDomain.pagesDomainStatus;
    const failedByApi = ['error', 'blocked', 'deactivated'].includes(String(pagesDomainStatus || '').toLowerCase());
    const activeByApi = String(pagesDomainStatus || '').toLowerCase() === 'active';
    const readyByReachability = customResult.reachable && activeByApi;
    customDomain = {
      ...customDomain,
      domainStatus: pagesDomain
        ? pagesDomain.status === 'active'
          ? 'active'
          : failedByApi
            ? 'failed'
            : 'pending'
        : customDomain.domainStatus,
      pagesDomainStatus,
      validationData: pagesDomain?.validation_data ?? customDomain.validationData,
      verificationData: pagesDomain?.verification_data ?? customDomain.verificationData,
      status: readyByReachability
        ? 'ready'
        : customDomain.status === 'failed' || failedByApi
          ? 'failed'
          : 'pending',
      statusMessage: readyByReachability
        ? 'Custom domain is ready.'
        : failedByApi
          ? 'Cloudflare Pages reported a custom-domain error.'
        : customResult.statusMessage || customDomain.statusMessage || 'Custom domain is still being prepared.',
    };
  }
  const cloudflarePages = {
    ...current,
    projectName,
    pagesDev,
    ...(customDomain ? { customDomain } : {}),
  };
  const aggregate = aggregateCloudflarePagesStatus(pagesDev, customDomain);
  return {
    url: pagesDev.url,
    status: aggregate.status,
    statusMessage: aggregate.statusMessage,
    cloudflarePages,
    providerMetadata: {
      ...(existing.providerMetadata || {}),
      cloudflarePages,
    },
  };
}

// Filename slug for the Content-Disposition header on archive downloads.
// Browsers reject quotes and control bytes; we keep Unicode letters/digits
// so a project name with non-ASCII characters (e.g. "café-design")
// survives instead of becoming a row of underscores.
function sanitizeArchiveFilename(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned;
}

function sendLiveArtifactRouteError(res, err) {
  if (err instanceof LiveArtifactStoreValidationError) {
    return sendApiError(res, 400, 'LIVE_ARTIFACT_INVALID', err.message, {
      details: { kind: 'validation', issues: err.issues },
    });
  }
  if (err instanceof LiveArtifactRefreshLockError) {
    return sendApiError(res, 409, 'REFRESH_LOCKED', err.message, {
      details: { artifactId: err.artifactId },
    });
  }
  if (err instanceof LiveArtifactRefreshUnavailableError) {
    return sendApiError(res, 400, 'LIVE_ARTIFACT_REFRESH_UNAVAILABLE', err.message);
  }
  if (err instanceof LiveArtifactRefreshAbortError) {
    return sendApiError(res, err.kind === 'cancelled' ? 499 : 504, 'LIVE_ARTIFACT_REFRESH_TIMEOUT', err.message, {
      details: { kind: err.kind, timeoutMs: err.timeoutMs ?? null, step: err.step ?? null },
    });
  }
  if (err instanceof ConnectorServiceError) {
    return sendApiError(res, err.status, err.code, err.message, err.details === undefined ? {} : { details: err.details });
  }
  if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
    return sendApiError(res, 404, 'LIVE_ARTIFACT_NOT_FOUND', 'live artifact not found');
  }
  return sendApiError(res, 500, 'LIVE_ARTIFACT_STORAGE_FAILED', String(err));
}

function normalizeLocalAuthority(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /[\s/@]/.test(trimmed) || trimmed.includes(',')) return null;

  try {
    const parsed = new URL(`http://${trimmed}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname || parsed.username || parsed.password || parsed.pathname !== '/') return null;
    return { hostname, port: parsed.port };
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (net.isIP(normalized) === 4) return normalized === '127.0.0.1' || normalized.startsWith('127.');
  return false;
}

function isLoopbackPeerAddress(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) return false;
  if (normalized.startsWith('::ffff:')) return isLoopbackPeerAddress(normalized.slice('::ffff:'.length));
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (net.isIP(normalized) === 4) return normalized === '127.0.0.1' || normalized.startsWith('127.');
  return false;
}

function localOriginFromHeader(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed.includes(',')) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
    if (!isLoopbackHostname(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function validateLocalDaemonRequest(req) {
  if (!isLoopbackPeerAddress(req.socket?.remoteAddress)) {
    return {
      ok: false,
      message: 'request peer must be a loopback address',
      details: { peer: 'remoteAddress' },
    };
  }

  const host = normalizeLocalAuthority(req.get('host'));
  if (!host || !isLoopbackHostname(host.hostname)) {
    return {
      ok: false,
      message: 'request host must be a loopback daemon address',
      details: { header: 'host' },
    };
  }

  const originHeader = req.get('origin');
  if (originHeader !== undefined && !localOriginFromHeader(originHeader)) {
    return {
      ok: false,
      message: 'request origin must be a loopback daemon origin',
      details: { header: 'origin' },
    };
  }

  return { ok: true, origin: localOriginFromHeader(originHeader) };
}

function requireLocalDaemonRequest(req, res, next) {
  const validation = validateLocalDaemonRequest(req);
  if (!validation.ok) {
    return sendApiError(res, 403, 'FORBIDDEN', validation.message, validation.details ? { details: validation.details } : {});
  }

  res.setHeader('Vary', 'Origin');
  if (validation.origin) {
    res.setHeader('Access-Control-Allow-Origin', validation.origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  next();
}

/**
 * Render the small HTML page that the OAuth callback returns to the
 * user's browser tab. It posts a message back to the opener (the
 * Settings dialog window) and offers a manual close button. We keep
 * the markup pure HTML/CSS — no external scripts, no React — so the
 * page works even if the opener was closed and the user just sees a
 * static success/failure screen.
 */
function renderOAuthResultPage(opts) {
  const ok = Boolean(opts.ok);
  const title = ok ? 'Connected' : 'Authorization failed';
  const heading = ok ? '✅ Connected' : '⚠️ Authorization failed';
  const body = ok
    ? `Your MCP server <code>${escapeHtml(opts.serverId ?? '')}</code> is now connected. You can close this tab and return to Open Design.`
    : escapeHtml(opts.message ?? 'Authorization could not be completed.');
  const accent = ok ? '#1a7f37' : '#cf222e';
  const payload = ok
    ? { type: 'mcp-oauth', ok: true, serverId: opts.serverId ?? null }
    : { type: 'mcp-oauth', ok: false, message: opts.message ?? null };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — Open Design</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif;
    background: #f6f7f9; color: #1f2328; padding: 24px;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    .card { background: #161b22; border-color: #30363d; }
    code { background: #1f242c; }
  }
  .card {
    max-width: 420px; width: 100%; padding: 28px 28px 22px; border-radius: 12px;
    background: white; border: 1px solid #d0d7de; box-shadow: 0 8px 24px rgba(0,0,0,.06);
    text-align: left;
  }
  h1 { margin: 0 0 8px; font-size: 18px; color: ${accent}; }
  p  { margin: 0 0 16px; font-size: 14px; line-height: 1.55; }
  code { background: #f3f4f6; padding: 1px 6px; border-radius: 4px; font-size: 12.5px; }
  button {
    appearance: none; border: 1px solid #d0d7de; background: white;
    border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer;
  }
  button:hover { background: #f6f8fa; }
  @media (prefers-color-scheme: dark) {
    button { background: #21262d; border-color: #30363d; color: #e6edf3; }
    button:hover { background: #30363d; }
  }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    <p>${body}</p>
    <button type="button" onclick="window.close()">Close this tab</button>
  </div>
  <script>
    try {
      var payload = ${JSON.stringify(payload)};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, '*');
      }
      if (window.BroadcastChannel) {
        var bc = new BroadcastChannel('open-design-mcp-oauth');
        bc.postMessage(payload);
        bc.close();
      }
    } catch (e) { /* ignore postMessage failures */ }
  </script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setLiveArtifactPreviewHeaders(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "base-uri 'none'",
      "script-src 'none'",
      "object-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "style-src 'unsafe-inline'",
      'sandbox allow-same-origin',
    ].join('; '),
  );
}

function setLiveArtifactCodeHeaders(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

const OPEN_DESIGN_GITHUB_REPO_API = 'https://api.github.com/repos/nexu-io/open-design';
const OPEN_DESIGN_GITHUB_RELEASE_LATEST_API = 'https://api.github.com/repos/nexu-io/open-design/releases/latest';
const OPEN_DESIGN_GITHUB_CACHE_TTL_MS = 60 * 60 * 1000;
const OPEN_DESIGN_GITHUB_TIMEOUT_MS = 4_000;

let openDesignGithubRepoCache = null;
let openDesignGithubRepoInflight = null;
let openDesignGithubLatestReleaseCache = null;
let openDesignGithubLatestReleaseInflight = null;

async function readOpenDesignGithubRepoStats() {
  const now = Date.now();
  if (
    openDesignGithubRepoCache &&
    now - openDesignGithubRepoCache.fetchedAt < OPEN_DESIGN_GITHUB_CACHE_TTL_MS
  ) {
    return { ...openDesignGithubRepoCache, stale: false };
  }

  if (openDesignGithubRepoInflight) {
    return openDesignGithubRepoInflight;
  }

  openDesignGithubRepoInflight = (async () => {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), OPEN_DESIGN_GITHUB_TIMEOUT_MS);
    try {
      const response = await fetch(OPEN_DESIGN_GITHUB_REPO_API, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'open-design-daemon',
        },
        signal: ctrl.signal,
      });
      if (!response.ok) {
        throw new Error(`GitHub repo metadata request failed with HTTP ${response.status}`);
      }
      const payload = await response.json();
      const count = payload && typeof payload.stargazers_count === 'number'
        ? payload.stargazers_count
        : null;
      if (!Number.isFinite(count) || count == null || count < 0) {
        throw new Error('GitHub repo metadata did not include a numeric stargazers_count');
      }
      openDesignGithubRepoCache = {
        stargazersCount: count,
        fetchedAt: Date.now(),
      };
      return { ...openDesignGithubRepoCache, stale: false };
    } catch (error) {
      if (openDesignGithubRepoCache) {
        return { ...openDesignGithubRepoCache, stale: true };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      openDesignGithubRepoInflight = null;
    }
  })();

  return openDesignGithubRepoInflight;
}

async function readOpenDesignLatestReleaseInfo() {
  const now = Date.now();
  if (
    openDesignGithubLatestReleaseCache &&
    now - openDesignGithubLatestReleaseCache.fetchedAt < OPEN_DESIGN_GITHUB_CACHE_TTL_MS
  ) {
    return { ...openDesignGithubLatestReleaseCache, stale: false };
  }

  if (openDesignGithubLatestReleaseInflight) {
    return openDesignGithubLatestReleaseInflight;
  }

  openDesignGithubLatestReleaseInflight = (async () => {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), OPEN_DESIGN_GITHUB_TIMEOUT_MS);
    try {
      const response = await fetch(OPEN_DESIGN_GITHUB_RELEASE_LATEST_API, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'open-design-daemon',
        },
        signal: ctrl.signal,
      });
      if (!response.ok) {
        throw new Error(`GitHub latest release request failed with HTTP ${response.status}`);
      }
      const payload = await response.json();
      const tagName = payload && typeof payload.tag_name === 'string' ? payload.tag_name : null;
      const htmlUrl = payload && typeof payload.html_url === 'string' ? payload.html_url : null;
      if (!tagName || !htmlUrl) {
        throw new Error('GitHub latest release metadata did not include tag_name/html_url');
      }
      openDesignGithubLatestReleaseCache = {
        tagName,
        htmlUrl,
        fetchedAt: Date.now(),
      };
      return { ...openDesignGithubLatestReleaseCache, stale: false };
    } catch (error) {
      if (openDesignGithubLatestReleaseCache) {
        return { ...openDesignGithubLatestReleaseCache, stale: true };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      openDesignGithubLatestReleaseInflight = null;
    }
  })();

  return openDesignGithubLatestReleaseInflight;
}

// Host-runtime self-update. Distinct upstream from OPEN_DESIGN_GITHUB_*
// above — that block queries `nexu-io/open-design` (an unrelated repo, a
// "GitHub stars" widget target). THIS is the actual repo
// `deploy/host/install.sh --update` downloads releases from
// (`DEFAULT_GH_REPO` in that script) and the one
// `.github/workflows/release-host-runtime.yml` publishes to.
const HOST_RUNTIME_GH_REPO = 'ducanhlaminh/open-design-vnpay';
const HOST_RUNTIME_RELEASE_LATEST_API = `https://api.github.com/repos/${HOST_RUNTIME_GH_REPO}/releases/latest`;
// Keep this shorter than the UI's seven-minute background poll. A one-hour
// cache forced users to restart the daemon before a freshly published host
// runtime became visible. Five minutes still coalesces bursts of browser
// tabs while allowing the next UI poll to discover the release naturally.
export const HOST_RUNTIME_RELEASE_CACHE_TTL_MS = 5 * 60 * 1000;

let hostRuntimeLatestReleaseCache = null;
let hostRuntimeLatestReleaseInflight = null;

// `force` (GET /api/update/status?refresh=1 — the header "Kiểm tra cập nhật"
// button) bypasses the TTL so a user-initiated check always asks GitHub;
// concurrent callers still coalesce onto one in-flight request.
async function readHostRuntimeLatestReleaseInfo({ force = false } = {}) {
  const now = Date.now();
  if (
    !force &&
    hostRuntimeLatestReleaseCache &&
    now - hostRuntimeLatestReleaseCache.fetchedAt < HOST_RUNTIME_RELEASE_CACHE_TTL_MS
  ) {
    return { ...hostRuntimeLatestReleaseCache, stale: false };
  }

  if (hostRuntimeLatestReleaseInflight) {
    return hostRuntimeLatestReleaseInflight;
  }

  hostRuntimeLatestReleaseInflight = (async () => {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), OPEN_DESIGN_GITHUB_TIMEOUT_MS);
    try {
      const response = await fetch(HOST_RUNTIME_RELEASE_LATEST_API, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'open-design-daemon',
        },
        signal: ctrl.signal,
      });
      if (!response.ok) {
        throw new Error(`GitHub latest release request failed with HTTP ${response.status}`);
      }
      const payload = await response.json();
      const tagName = payload && typeof payload.tag_name === 'string' ? payload.tag_name : null;
      const version = tagName ? extractSemverFromTag(tagName) : null;
      if (!tagName || !version) {
        throw new Error('GitHub latest release metadata did not include a parseable tag_name');
      }
      hostRuntimeLatestReleaseCache = {
        tagName,
        version,
        fetchedAt: Date.now(),
      };
      return { ...hostRuntimeLatestReleaseCache, stale: false };
    } catch (error) {
      if (hostRuntimeLatestReleaseCache) {
        return { ...hostRuntimeLatestReleaseCache, stale: true };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      hostRuntimeLatestReleaseInflight = null;
    }
  })();

  return hostRuntimeLatestReleaseInflight;
}

// Module-level lock for POST /api/update/apply below. Deliberately never
// reset after a successful spawn: `install.sh --update` kills THIS daemon
// process partway through its own service-restart step, so the flag simply
// stops existing along with the process — the next daemon process (already
// on the new version, or rolled back to the old one) starts fresh with
// this at `false`. Only reset on a failure that happens BEFORE the spawn
// (e.g. GitHub unreachable, OD_HOME unresolvable) so a transient failure
// doesn't wedge the daemon into "already-in-progress" forever.
let updateApplyInProgress = false;

// Last spawn-time failure from POST /api/update/apply, surfaced through
// GET /api/update/status as `lastError`. Deliberately in-memory only (not
// persisted to disk like the update marker above) — this only covers a
// spawn ENOENT-class failure that happens BEFORE the child process gets a
// chance to run, so THIS daemon process is still alive to report it; a
// failure after that point (mid-install, or a health-check rollback) kills
// this process and is out of scope here — see specs/change/
// 20260815-host-update-ui-windows/spec.md "Ngoài phạm vi".
let lastUpdateError: { message: string; at: string } | null = null;

// Platform-aware seam for POST /api/update/apply: decides WHICH command to
// run (`install.sh --update` on macOS/Linux, `install.ps1 -Update` via
// powershell on Windows — the exact invocation documented in
// deploy/host/README.md's "Update" section) without touching fs/spawn, so
// it is unit-testable in isolation. The caller still owns resolving the
// `powershell` binary itself (see `resolveOnPath` at the call site below)
// since that involves a real PATH lookup this function must stay free of.
export function resolveUpdateCommand(
  odHome: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    return {
      cmd: 'powershell',
      // -NoProfile/-NonInteractive/-ExecutionPolicy Bypass are required here
      // (unlike the README's interactive example): this spawn has no
      // console/TTY at all, so a profile script or an execution-policy
      // prompt has nothing to read from and the process can exit before
      // running any script code — silently, since stdio still resolves to
      // an open fd either way. Confirmed via a live Windows repro: manual
      // `-File ... -Update` in an interactive shell completed all 6 steps,
      // but the identical command spawned by this daemon (detached,
      // windowsHide, stdio redirected to a file) produced an empty
      // update.log and never restarted the service.
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', path.join(odHome, 'current', 'install.ps1'),
        '-Update',
      ],
    };
  }
  return {
    cmd: 'bash',
    args: [path.join(odHome, 'current', 'install.sh'), '--update'],
  };
}

// Normalizes a spawn-time (or pre-spawn resolution) failure into the shape
// stored in `lastUpdateError` / returned by GET /api/update/status.
export function formatUpdateSpawnError(
  err: unknown,
  at: string = new Date().toISOString(),
): { message: string; at: string } {
  return { message: String((err as { message?: unknown })?.message ?? err), at };
}

// Windows PowerShell 5.1 has a reproducible failure mode when Node launches
// it with `detached: true` and then unrefs it: the process starts and exits 0,
// but never evaluates its -Command/-File body. `windowsHide` is independent
// and safe (the non-detached hidden repro completed normally), so keep the
// window hidden without detaching on Windows. POSIX keeps the established
// detached updater behavior.
export function resolveUpdateSpawnOptions(
  platform: NodeJS.Platform = process.platform,
): { detached: boolean; windowsHide?: boolean } {
  return platform === 'win32'
    ? { detached: false, windowsHide: true }
    : { detached: true };
}

// A successful updater stops/restarts this daemon before its child can emit
// `exit` here. Therefore any observed exit — including code 0 — is premature
// and must be surfaced. This also covers the Windows failure where detached
// PowerShell silently exited 0 without executing the script body.
export function formatPrematureUpdateExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
): Error {
  const outcome = code === null ? 'without an exit code' : `with code ${code}`;
  return new Error(
    `install script exited ${outcome}${signal ? ` (signal ${signal})` : ''} before completing the update — see update.log`,
  );
}

// install.ps1 uses this non-error terminal exit when it has safely installed
// the new release but cannot restart the daemon outside the daemon-owned
// process tree. The old daemon remains available until the user restarts it.
export const WINDOWS_UPDATE_RESTART_REQUIRED_EXIT_CODE = 75;

export function isWindowsUpdateRestartRequiredExit(
  platform: NodeJS.Platform,
  code: number | null,
  signal: NodeJS.Signals | null,
): boolean {
  return platform === 'win32'
    && code === WINDOWS_UPDATE_RESTART_REQUIRED_EXIT_CODE
    && signal === null;
}

// POST /api/update/apply redirects the child's stdout/stderr into this file
// (see the spawn call below) instead of `stdio: 'ignore'`, so GET
// /api/update/status can report coarse progress while this daemon process
// is still alive to answer requests — install.sh/install.ps1 already print
// one `phase "N/6 <label>"` / `Write-Phase "N/6 <label>"` line per step to
// their own stdout for the human running them interactively; this just
// captures the same lines instead of adding a second reporting mechanism.
const UPDATE_LOG_FILENAME = 'update.log';
const UPDATE_PHASE_LINE_RE = /^(\d+)\/(\d+)\s+(.+)$/;

// install.sh colors its phase() output with ANSI SGR codes (install.ps1's
// Write-Phase does not) — strip them so the regex above matches either.
function stripAnsiCodes(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '');
}

// Best-effort parse of the CURRENT install phase from the tail of
// update.log. Returns null before the first "N/6" line appears (still in
// the unnumbered network-preflight phase) or once the log is missing/
// unreadable (e.g. no update in progress) — this is advisory UI progress,
// never load-bearing, so it never throws.
export async function readUpdateProgress(
  dataDir: string,
): Promise<{ step: number; totalSteps: number; label: string; percent: number } | null> {
  try {
    const raw = await fs.promises.readFile(path.join(dataDir, UPDATE_LOG_FILENAME), 'utf8');
    return parseUpdateProgress(raw);
  } catch {
    return null;
  }
}

// Last "NN%" inside the current step's slice of the log — install.ps1's
// Write-DownloadLog milestones ("download 35% (…)") and install.sh's curl
// --progress-bar ("####  35.0%", \r-separated) both match. Only used to
// refine the percent estimate; absence means "step just started".
const UPDATE_INNER_PERCENT_RE = /(\d{1,3})(?:[.,]\d+)?%/g;

export function parseUpdateProgress(
  raw: string,
): { step: number; totalSteps: number; label: string; percent: number } | null {
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = UPDATE_PHASE_LINE_RE.exec(stripAnsiCodes(lines[i]).trim());
    if (!match) continue;
    const step = Number(match[1]);
    const totalSteps = Number(match[2]);
    let inner = 0;
    for (const line of lines.slice(i + 1)) {
      for (const seg of stripAnsiCodes(line).split('\r')) {
        for (const m of seg.matchAll(UPDATE_INNER_PERCENT_RE)) {
          const v = Number(m[1]);
          if (v >= 0 && v <= 100) inner = v / 100;
        }
      }
    }
    const percent = totalSteps > 0
      ? Math.min(99, Math.max(0, Math.round(((step - 1 + inner) / totalSteps) * 100)))
      : 0;
    return { step, totalSteps, label: match[3].trim(), percent };
  }
  return null;
}

function updateStateForProgress(progress) {
  if (!progress) return 'preparing';
  if (progress.step <= 1) return 'downloading';
  if (progress.step === 2) return 'verifying';
  if (progress.step <= 4) return 'installing';
  return 'restarting';
}

function bearerTokenFromRequest(req) {
  const header = req.get('authorization');
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function authorizeToolRequest(req, res, operation) {
  const endpoint = req.path;
  const validation = toolTokenRegistry.consume(bearerTokenFromRequest(req), { endpoint, operation });
  if (!validation.ok) {
    const status = validation.code === 'TOOL_ENDPOINT_DENIED' || validation.code === 'TOOL_OPERATION_DENIED'
      ? 403
      : validation.code === 'TOOL_CALL_LIMIT_EXCEEDED' ? 429 : 401;
    sendApiError(res, status, validation.code, validation.message, {
      details: { endpoint, operation },
    });
    return null;
  }
  return validation.grant;
}

function requestProjectOverride(projectId, tokenProjectId) {
  return typeof projectId === 'string' && projectId.length > 0 && projectId !== tokenProjectId;
}

function requestRunOverride(runId, tokenRunId) {
  return typeof runId === 'string' && runId.length > 0 && runId !== tokenRunId;
}

function openNativeFolderDialog() {
  return new Promise((resolve) => {
    const platform = process.platform;
    if (platform === 'darwin') {
      execFile(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "Select a code folder to link")'],
        { timeout: 120_000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const p = stdout.trim().replace(/\/$/, '');
          resolve(p || null);
        },
      );
    } else if (platform === 'linux') {
      execFile(
        'zenity',
        ['--file-selection', '--directory', '--title=Select a code folder to link'],
        { timeout: 120_000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const p = stdout.trim();
          resolve(p || null);
        },
      );
    } else if (platform === 'win32') {
      const command = buildWindowsFolderDialogCommand();
      execFile(command.command, command.args, { timeout: 120_000 }, (err, stdout) => {
        resolve(parseFolderDialogStdout(err, stdout));
      });
    } else {
      resolve(null);
    }
  });
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 */
function createSseErrorPayload(code, message, init = {}) {
  return { message, error: createCompatApiError(code, message, init) };
}

const UPLOAD_DIR = path.join(os.tmpdir(), 'od-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      file.originalname = decodeMultipartFilename(file.originalname);
      const safe = sanitizeName(file.originalname);
      cb(
        null,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`,
      );
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const importUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      file.originalname = decodeMultipartFilename(file.originalname);
      const safe = sanitizeName(file.originalname);
      cb(
        null,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`,
      );
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

const PLUGIN_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const pluginUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: PLUGIN_UPLOAD_MAX_BYTES,
    files: 500,
    fieldSize: 2 * 1024 * 1024,
  },
});

// Project-scoped multi-file upload. Lands files directly in the project
// folder (flat — same shape FileWorkspace expects), so the composer's
// pasted/dropped/picked images become referenceable filenames the agent
// can Read or @-mention without any cross-folder gymnastics.
// Bridge between the multer upload-storage destination (built at module
// init) and the per-process project DB (instantiated inside startServer).
// startServer() sets this so the upload destination can route attachments
// into the right project root, including folder-imported projects whose
// files live under metadata.baseDir.
let projectMetadataLookup: ((id: string) => Record<string, unknown> | null) | null = null;

const projectUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        // Route uploads into the project's actual root: for folder-imported
        // projects (metadata.baseDir set) attachments need to land alongside
        // the user's files so the agent can read them via the same path
        // it sees. projectMetadataLookup is populated at startServer() boot
        // and keyed by project id; null fallback gives the standard
        // .od/projects/<id>/ behavior for non-imported projects.
        const meta = projectMetadataLookup?.(req.params.id) ?? null;
        const dir = await ensureProject(PROJECTS_DIR, req.params.id, meta);
        cb(null, dir);
      } catch (err) {
        cb(err, '');
      }
    },
    filename: (_req, file, cb) => {
      // multer@1 hands us latin1-decoded multipart filenames; restore the
      // original UTF-8 so the response (and the on-disk name) preserves
      // non-ASCII characters instead of mangling them. Then run the
      // shared sanitiser and prepend a base36 timestamp so multiple
      // uploads with the same original name don't clobber each other.
      file.originalname = decodeMultipartFilename(file.originalname);
      const safe = sanitizeName(file.originalname);
      cb(null, `${Date.now().toString(36)}-${safe}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },  // 200MB — covers the largest design assets we expect (PPTX/PDF/raw images)
});

function handleProjectUpload(req, res, next) {
  projectUpload.array('files', 12)(req, res, (err) => {
    if (err) {
      return sendMulterError(res, err);
    }
    next();
  });
}

function sendMulterError(res, err) {
  if (err instanceof multer.MulterError) {
    const code = err.code || 'UPLOAD_ERROR';
    const statusByCode = {
      LIMIT_FILE_SIZE: 413,
      LIMIT_FILE_COUNT: 400,
      LIMIT_UNEXPECTED_FILE: 400,
      LIMIT_PART_COUNT: 400,
      LIMIT_FIELD_KEY: 400,
      LIMIT_FIELD_VALUE: 400,
      LIMIT_FIELD_COUNT: 400,
      MISSING_FIELD_NAME: 400,
    };
    const errorByCode = {
      LIMIT_FILE_SIZE: 'file too large',
      LIMIT_FILE_COUNT: 'too many files',
      LIMIT_UNEXPECTED_FILE: 'unexpected file field',
      LIMIT_PART_COUNT: 'too many form parts',
      LIMIT_FIELD_KEY: 'field name too long',
      LIMIT_FIELD_VALUE: 'field value too long',
      LIMIT_FIELD_COUNT: 'too many form fields',
      MISSING_FIELD_NAME: 'missing field name',
    };
    const status = statusByCode[code] ?? 400;
    const message = errorByCode[code] ?? 'upload failed';
    return sendApiError(
      res,
      status,
      code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
      message,
      { details: { legacyCode: code } },
    );
  }

  if (err) {
    return sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
  }

  return sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
}

const mediaTasks = new Map();
const pluginShareTasks = new Map();
const TASK_TTL_AFTER_DONE_MS = 10 * 60 * 1000;
const MEDIA_TERMINAL_STATUSES = new Set(['done', 'failed', 'interrupted']);
const PLUGIN_SHARE_TERMINAL_STATUSES = new Set(['done', 'failed']);

function hydrateMediaTask(row) {
  const task = {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    surface: row.surface,
    model: row.model,
    progress: Array.isArray(row.progress) ? row.progress.slice() : [],
    file: row.file ?? null,
    error: row.error ?? null,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    waiters: new Set(),
  };
  mediaTasks.set(task.id, task);
  return task;
}

function getLiveMediaTask(db, taskId) {
  const cached = mediaTasks.get(taskId);
  if (cached) return cached;
  const row = getMediaTask(db, taskId);
  return row ? hydrateMediaTask(row) : null;
}

function createMediaTask(db, taskId, projectId, info = {}) {
  const task = {
    id: taskId,
    projectId,
    status: 'queued',
    surface: info.surface,
    model: info.model,
    progress: [],
    file: null,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    waiters: new Set(),
  };
  mediaTasks.set(taskId, task);
  insertMediaTask(db, {
    id: taskId,
    projectId,
    status: task.status,
    surface: task.surface,
    model: task.model,
    progress: task.progress,
    file: task.file,
    error: task.error,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
  });
  return task;
}

function persistMediaTask(db, task) {
  updateMediaTask(db, task.id, {
    status: task.status,
    surface: task.surface,
    model: task.model,
    progress: task.progress,
    file: task.file,
    error: task.error,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
  });
}

function appendTaskProgress(db, task, line) {
  task.progress.push(line);
  persistMediaTask(db, task);
  notifyTaskWaiters(db, task);
}

function notifyTaskWaiters(db, task) {
  const wakers = Array.from(task.waiters);
  for (const w of wakers) {
    try {
      w();
    } catch {
      // Never let one bad waiter block the rest.
    }
  }
  if (
    MEDIA_TERMINAL_STATUSES.has(task.status) &&
    !task._gcScheduled
  ) {
    task._gcScheduled = true;
    setTimeout(() => {
      if (task.waiters.size === 0) {
        mediaTasks.delete(task.id);
        deleteMediaTask(db, task.id);
      }
    }, TASK_TTL_AFTER_DONE_MS).unref?.();
  }
}

function mediaTaskSnapshot(task, since = 0) {
  const snapshot = {
    taskId: task.id,
    status: task.status,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    progress: task.progress.slice(since),
    nextSince: task.progress.length,
  };
  if (task.status === 'done') snapshot.file = task.file;
  if (task.status === 'failed' || task.status === 'interrupted') {
    snapshot.error = task.error;
  }
  return snapshot;
}

function createPluginShareTask(taskId, projectId, info = {}) {
  const task = {
    id: taskId,
    projectId,
    status: 'queued',
    action: info.action,
    path: info.path,
    progress: [],
    result: null,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    waiters: new Set(),
  };
  pluginShareTasks.set(taskId, task);
  return task;
}

function getLivePluginShareTask(taskId) {
  return pluginShareTasks.get(taskId) ?? null;
}

function appendPluginShareTaskProgress(task, line) {
  task.progress.push(String(line ?? ''));
  notifyPluginShareTaskWaiters(task);
}

function notifyPluginShareTaskWaiters(task) {
  const wakers = Array.from(task.waiters);
  for (const w of wakers) {
    try {
      w();
    } catch {
      // Never let one bad waiter block the rest.
    }
  }
  if (PLUGIN_SHARE_TERMINAL_STATUSES.has(task.status) && !task._gcScheduled) {
    task._gcScheduled = true;
    setTimeout(() => {
      if (task.waiters.size === 0) {
        pluginShareTasks.delete(task.id);
      }
    }, TASK_TTL_AFTER_DONE_MS).unref?.();
  }
}

function pluginShareTaskSnapshot(task, since = 0) {
  const snapshot = {
    taskId: task.id,
    action: task.action,
    path: task.path,
    status: task.status,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    progress: task.progress.slice(since),
    nextSince: task.progress.length,
  };
  if (task.status === 'done') snapshot.result = task.result;
  if (task.status === 'failed') snapshot.error = task.error;
  return snapshot;
}

function pluginShareActionToCli(action) {
  if (action === 'publish-github') {
    return {
      argv: ['plugin', 'publish-repo'],
      title: 'Publish repo',
      command: 'od plugin publish-repo',
      successMessage: 'Published plugin to GitHub.',
      failureCode: 'publish-repo-failed',
    };
  }
  return {
    argv: ['plugin', 'open-design-pr'],
    title: 'Open Design PR',
    command: 'od plugin open-design-pr',
    successMessage: 'Opened Open Design PR flow.',
    failureCode: 'open-design-pr-failed',
  };
}

function pluginShareProgressPlan(action) {
  if (action === 'publish-github') {
    return [
      'Resolve GitHub owner and validate plugin metadata',
      'Create or update the GitHub repository',
      'Push plugin files',
      'Return the repository URL',
    ];
  }
  return [
    'Ensure the Open Design fork exists',
    'Clone the fork and prepare a branch',
    'Copy the plugin into plugins/community',
    'Push the branch and open the PR form',
  ];
}

async function runPluginShareTask(task, folder) {
  const share = pluginShareActionToCli(task.action);
  appendPluginShareTaskProgress(task, `${share.title} started for ${task.path}`);
  appendPluginShareTaskProgress(task, `$ ${share.command} ${task.path}`);
  for (const step of pluginShareProgressPlan(task.action)) {
    appendPluginShareTaskProgress(task, `- ${step}`);
  }
  const result = await execCommandViaLoginShell(OD_NODE_BIN, [
    OD_BIN,
    ...share.argv,
    folder,
    '--json',
  ], { timeout: task.action === 'publish-github' ? 240_000 : 300_000 });
  let payload = null;
  try {
    payload = result.stdout ? JSON.parse(result.stdout) : null;
  } catch (error) {
    payload = null;
    appendPluginShareTaskProgress(task, `Failed to parse CLI JSON output: ${String(error?.message || error)}`);
  }
  const stepLog = payload?.steps?.map((step) => step.stderr || step.stdout || step.command).filter(Boolean) ?? [];
  for (const line of stepLog) {
    appendPluginShareTaskProgress(task, String(line).trim());
  }
  if (!result.ok || !payload?.ok) {
    task.status = 'failed';
    task.error = {
      code: payload?.error?.label || share.failureCode,
      message: payload?.error?.stderr || payload?.error?.stdout || result.stderr || result.stdout || `${share.title} failed.`,
      log: stepLog.length > 0 ? stepLog : [result.stderr || result.stdout || `${share.command} failed`],
    };
    task.endedAt = Date.now();
    notifyPluginShareTaskWaiters(task);
    return;
  }
  const url = payload.repoUrl || payload.prUrl || undefined;
  task.status = 'done';
  task.result = {
    message: url
      ? (task.action === 'publish-github'
          ? `Published plugin to ${url}.`
          : `Opened Open Design PR flow at ${url}.`)
      : share.successMessage,
    ...(url ? { url } : {}),
    log: stepLog,
  };
  task.endedAt = Date.now();
  notifyPluginShareTaskWaiters(task);
}

export function createSseResponse(
  res,
  { keepAliveIntervalMs = SSE_KEEPALIVE_INTERVAL_MS } = {},
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const canWrite = () => !res.destroyed && !res.writableEnded;
  const writeKeepAlive = () => {
    if (canWrite()) {
      res.write(': keepalive\n\n');
      return true;
    }
    return false;
  };

  let heartbeat = null;
  if (keepAliveIntervalMs > 0) {
    heartbeat = setInterval(writeKeepAlive, keepAliveIntervalMs);
    heartbeat.unref?.();
  }

  const cleanup = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);

  return {
    /** @param {ChatSseEvent['event'] | ProxySseEvent['event'] | string} event */
    send(event, data, id: string | number | null | undefined = null) {
      if (!canWrite()) return false;
      // Assemble the full SSE event into a single write so id/event/data land
      // in one TCP chunk. Three separate writes would let `event: <type>` flush
      // ahead of the `data:` payload, which produces partial events for
      // consumers that read chunk-by-chunk (e.g. tests using a Response body
      // reader with a substring marker).
      const idLine = id !== null && id !== undefined ? `id: ${id}\n` : '';
      res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    },
    writeKeepAlive,
    cleanup,
    end() {
      cleanup();
      if (canWrite()) {
        res.end();
      }
    },
  };
}

// Loosely typed shape — we only access `namespace`, `base`, `mode`, and
// `source` from the runtime context when building the diagnostics export.
// Anything richer would force a dependency from server.ts into the sidecar
// package, which the boundary checks explicitly forbid.
export interface DaemonRuntimeContext {
  namespace: string;
  base: string;
  mode?: string;
  source?: string;
}

export interface StartServerOptions {
  host?: string;
  port?: number;
  returnServer?: boolean;
  runtime?: DaemonRuntimeContext | null;
}

const DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS = 24 * 60 * 60 * 1000;
// After a successful live-artifact registration the daemon switches the
// chat-run inactivity watchdog from the long pre-artifact ceiling
// (DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS) down to a much shorter
// "quiet period" — the deliverable exists, so further silence almost
// always means the agent is winding down or hanging. See #1451.
const DEFAULT_CHAT_RUN_ARTIFACT_QUIET_PERIOD_MS = 60 * 1000;

function resolveChatRunInactivityTimeoutMs() {
  const raw = Number(process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS);
  // This watchdog observes child stdout/stderr/SSE activity, not real CPU or
  // filesystem progress. Keep the default long enough for agents that spend
  // several minutes silently writing large artifacts.
  if (!Number.isFinite(raw)) return DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
  // Node clamps delays larger than a signed 32-bit integer down to 1ms, which
  // makes an oversized override fail almost immediately while reporting a huge
  // timeout. Keep explicit overrides bounded to a practical, timer-safe value.
  return Math.min(MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS, Math.max(0, Math.floor(raw)));
}

// Resolve the post-artifact quiet-period window. Same clamp as the outer
// inactivity watchdog so an oversized override doesn't get Node-downgraded
// to a 1ms timer. Exported so tests can pin the env behavior without
// reaching into chat-run internals.
export function resolveChatRunArtifactQuietPeriodMs() {
  const raw = Number(process.env.OD_CHAT_RUN_ARTIFACT_QUIET_PERIOD_MS);
  if (!Number.isFinite(raw)) return DEFAULT_CHAT_RUN_ARTIFACT_QUIET_PERIOD_MS;
  return Math.min(MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS, Math.max(0, Math.floor(raw)));
}

// Pure resolver for the chat run's *currently active* inactivity
// ceiling. Used by both `noteAgentActivity` and `noteArtifactRegistered`
// to pick between the pre-artifact watchdog and the shortened quiet
// period. Extracted so the `OD_CHAT_RUN_ARTIFACT_QUIET_PERIOD_MS=0`
// "disable the quiet period" semantics can be pinned with focused unit
// tests (#1451 review: a 0-value override must not strand the pre-artifact
// timer or stop further reschedules — it has to fall back to the
// pre-artifact ceiling so subsequent activity keeps refreshing the timer).
export function resolveActiveInactivityTimeoutMs(params: {
  inactivityTimeoutMs: number;
  artifactQuietPeriodMs: number;
  artifactRegistered: boolean;
}): number {
  if (params.artifactRegistered && params.artifactQuietPeriodMs > 0) {
    return params.artifactQuietPeriodMs;
  }
  return params.inactivityTimeoutMs;
}

// Pure final-status classifier for the chat run's child-close handler.
// Extracted so the per-branch invariants can be unit-tested without
// driving a full child process — in particular:
//   - cancel always wins over success/failure classification.
//   - the ACP forced-shutdown override is scoped to SIGTERM + clean
//     completion only (signed-32-bit-overflow SIGKILL or non-clean ACP
//     state still report `failed`).
//   - the artifact quiet-period override is gated on a daemon-initiated
//     flag, NOT on `artifactRegistered` alone — see #1451 review:
//     an external `kill -9` after the artifact write must still report
//     `failed`, only the watchdog-initiated SIGTERM/SIGKILL escalation
//     is allowed to flip the status to `succeeded`.
export function classifyChatRunCloseStatus(params: {
  cancelRequested: boolean;
  code: number | null;
  signal: NodeJS.Signals | string | null;
  acpCleanCompletion: boolean;
  artifactQuietShutdownRequested: boolean;
}): 'canceled' | 'succeeded' | 'failed' {
  if (params.cancelRequested) return 'canceled';
  if (params.code === 0) return 'succeeded';
  const acpForcedShutdown =
    params.code === null && params.signal === 'SIGTERM' && params.acpCleanCompletion;
  if (acpForcedShutdown) return 'succeeded';
  const artifactQuietShutdown =
    params.artifactQuietShutdownRequested &&
    params.code === null &&
    (params.signal === 'SIGTERM' || params.signal === 'SIGKILL');
  if (artifactQuietShutdown) return 'succeeded';
  return 'failed';
}

function resolveChatRunShutdownGraceMs() {
  const raw = Number(process.env.OD_CHAT_RUN_SHUTDOWN_GRACE_MS);
  if (!Number.isFinite(raw)) return 3_000;
  return Math.max(0, Math.floor(raw));
}

function resolveAcpStageTimeoutMs(): number | undefined {
  // Per-stage silence watchdog for ACP chat sessions. Defaults are owned by
  // `attachAcpSession` in acp.ts; this resolver only applies when an operator
  // sets `OD_ACP_STAGE_TIMEOUT_MS`. Bounded to the same 24h ceiling as the
  // outer chat inactivity watchdog so an oversized override doesn't get
  // clamped to 1ms by Node's signed-32-bit delay limit.
  const raw = Number(process.env.OD_ACP_STAGE_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return undefined;
  return Math.min(MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS, Math.max(0, Math.floor(raw)));
}

/**
 * The kickoff directive appended for a stage that consumes a Design System's
 * review criteria (`usesDesignSystemCriteria` in pipelines.ts, today only
 * `ux`). Pure (no I/O) so it is unit-testable, same shape as
 * `appContextDirective` (app-context.ts): the caller checks which of the two
 * staged files actually exist on disk (a DS can have `rules.md` without
 * `components.md` yet, or vice versa) and passes that in — this function
 * never guesses from whether a DS was found. Returns '' when neither file is
 * present, keeping the kickoff byte-identical for a project with no linked
 * DS or a DS that hasn't generated criteria yet.
 */
export function dsCriteriaDirective(input: { hasRules: boolean; hasComponents: boolean }): string {
  const { hasRules, hasComponents } = input;
  if (!hasRules && !hasComponents) return '';
  const parts: string[] = [];
  if (hasRules) {
    parts.push(
      '"./criteria/rules.md" (the design system\'s UX rules — you MUST follow them when authoring screens and wireframes)',
    );
  }
  if (hasComponents) {
    parts.push(
      '"./criteria/components.md" (the design system\'s VALID component catalog — spec only components that appear in it)',
    );
  }
  return ` This app has a Design System with review criteria staged in the run cwd — read ${parts.join(' and ')}. `;
}

/**
 * Which re-run clear scope `runWorkflowAll`'s `runStage` should pass to
 * `runPipeline` for ONE stage of a full-workflow run. Pure so the 3-branch
 * decision is unit-testable without spinning up the daemon (see
 * `tests/run-all-reset-scope.test.ts`). Two outcomes, never `undefined`:
 *
 *   - `'downstream'`: only the very FIRST stage of an AUTOMATIC (not
 *     hand-ticked) run that isn't skipping already-succeeded stages — a
 *     fresh full run resets the whole project up front, catching stale
 *     output of stages that won't even re-run this pass.
 *   - `'stage'`: every other stage that is actually about to run — including
 *     the first stage of a hand-ticked run, and every stage after the first
 *     in an automatic run. A stage that runs without clearing its OWN prior
 *     output leaves last run's files sitting in its `outputs`, and anything
 *     downstream reads them as if THIS run had produced them — e.g. a
 *     fan-out stage that merges per-module output
 *     (`ux/<module>/ux-spec.json`) silently folds in a module the current
 *     pass no longer emits, because the old module's folder was never
 *     wiped.
 *
 * This function only ever answers for a stage `runStage` is about to
 * actually run — a stage dropped from `stages` entirely (skipped) never
 * reaches it.
 */
export function resetScopeForRunAllStage(params: {
  manualStages: boolean;
  isFirstStage: boolean;
  skipSucceeded: boolean;
}): 'stage' | 'downstream' {
  const { manualStages, isFirstStage, skipSucceeded } = params;
  if (!manualStages && isFirstStage && !skipSucceeded) return 'downstream';
  return 'stage';
}

export async function startServer({
  port = 7456,
  host = process.env.OD_BIND_HOST || '127.0.0.1',
  returnServer = false,
  runtime = null,
}: StartServerOptions = {}) {
  // Keep the last few hundred console lines in memory from the very start:
  // error reports (error-reports.ts) fall back to them on the host runtime,
  // where there is no sidecar log file to tail.
  installConsoleTailCapture();
  let resolvedPort = port;
  let daemonShuttingDown = false;
  const extraAllowedOrigins = configuredAllowedOrigins();

  // Plan §3.K1 / spec §15.7 — bound-API-token guard.
  //
  // The daemon refuses to bind to a public interface unless an
  // OD_API_TOKEN is set. This is the spec §16 Phase 5 safety floor:
  // a hosted operator can no longer accidentally publish an unsecured
  // daemon by setting OD_BIND_HOST=0.0.0.0 without a token.
  //
  // Loopback hosts (127.0.0.1 / ::1 / localhost) are always allowed —
  // the desktop / dev flow remains unchanged. Setting OD_API_TOKEN is
  // purely additive: when present, every /api/* request must carry a
  // matching `Authorization: Bearer <token>` header (loopback origins
  // are exempted so the desktop UI keeps working).
  const apiToken = (process.env.OD_API_TOKEN ?? '').trim();
  if (!isLoopbackHostname(host) && apiToken.length === 0) {
    throw new Error(
      `OD_BIND_HOST=${host} requires OD_API_TOKEN to be set. ` +
      `Generate one with \`openssl rand -hex 32\` and re-launch. ` +
      `(Loopback hosts 127.0.0.1 / ::1 / localhost do not need a token.)`,
    );
  }

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Plan §3.K1 — bearer-token middleware.
  //
  // Active only when OD_API_TOKEN is set. Loopback origins skip the
  // check (the desktop UI / local CLI never carry a bearer); every
  // other request must present `Authorization: Bearer <token>` with a
  // value matching `OD_API_TOKEN`. Health / version / status remain
  // open so monitoring probes don't need the token.
  if (apiToken.length > 0) {
    const openProbePaths = new Set(['/api/health', '/api/version', '/api/daemon/status']);
    app.use('/api', (req, res, next) => {
      if (openProbePaths.has(req.path)) return next();
      // Loopback short-circuit. We ignore the proxied X-Forwarded-For
      // header here because a reverse proxy MUST always forward the
      // bearer; the loopback bypass exists for the localhost desktop
      // UI which has no proxy in the path.
      if (isLoopbackPeerAddress(req.socket?.remoteAddress)) return next();
      const auth = req.get('authorization') ?? '';
      const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
      if (!match || match[1] !== apiToken) {
        return res.status(401).json({
          error: { code: 'API_TOKEN_REQUIRED', message: 'Authorization: Bearer <OD_API_TOKEN> required' },
        });
      }
      return next();
    });
  }

  // Google SSO (gateway mode, ported from pipeline-studio) — OPT-IN via
  // SESSION_SECRET + GOOGLE_CLIENT_ID/SECRET in the env; inert otherwise.
  // Gates BROWSER requests to /api/* only (Sec-Fetch/Origin heuristics), so
  // the local CLI, desktop sidecar and internal fetches stay ungated. Must
  // register BEFORE every other /api route so the gate middleware runs first.
  registerAuthRoutes(app, undefined, { stateDir: RUNTIME_DATA_DIR });

  // Multi-directory scanning shared by every skill / template surface. The
  // helpers delegate to listSkills(roots) which walks roots in priority
  // order, tags each entry with the SkillSource ('user' for the user
  // root, 'built-in' for the bundled root) the contracts package
  // declares, and lets a user-imported entry shadow a built-in one of
  // the same id without erasing the built-in copy.
  async function listAllSkills() {
    return listSkills(SKILL_ROOTS);
  }

  async function listAllDesignTemplates() {
    return listSkills(DESIGN_TEMPLATE_ROOTS);
  }

  // Spans both roots so chat run system-prompt composition and the orbit
  // template resolver can resolve a stored project.skillId regardless of
  // which surface created the project after the skills/design-templates
  // split. Keep in sync with SKILL_ROOTS + DESIGN_TEMPLATE_ROOTS above.
  async function listAllSkillLikeEntries() {
    return listSkills(ALL_SKILL_LIKE_ROOTS);
  }

  async function listAllDesignSystems() {
    const builtIn = (await listDesignSystems(DESIGN_SYSTEMS_DIR)).map((s) => ({
      ...s,
      source: 'built-in',
      isEditable: false,
      status: 'published',
    }));
    let installed = [];
    try {
      installed = await listDesignSystems(USER_DESIGN_SYSTEMS_DIR, {
        idPrefix: 'user:',
        source: 'user',
        isEditable: true,
        defaultStatus: 'draft',
      });
    } catch {
      // User directory may not exist yet or be unreadable.
    }
    const seen = new Set(builtIn.map((s) => s.id));
    return [
      ...installed
        .filter((s) => s.source === 'user')
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
      ...builtIn,
      ...installed.filter((s) => s.source !== 'user' && !seen.has(s.id)),
    ];
  }

  async function readAvailableDesignSystem(id) {
    if (typeof id === 'string' && id.startsWith('user:')) {
      return readDesignSystem(USER_DESIGN_SYSTEMS_DIR, id, { idPrefix: 'user:' });
    }
    return (
      (await readDesignSystem(DESIGN_SYSTEMS_DIR, id))
      ?? (await readDesignSystem(USER_DESIGN_SYSTEMS_DIR, id))
    );
  }

  // Figma-imported systems carry a real compiled showcase under
  // react/showcase/ (rendered from the imported component source). Serve it
  // over the DESIGN.md-derived marketing page. showcase-data.js and the token
  // stylesheet are inlined because the web app displays this HTML through a
  // srcDoc iframe, where relative URLs cannot resolve.
  async function readCompiledShowcaseHtml(id) {
    const slug = typeof id === 'string' && id.startsWith('user:') ? id.slice('user:'.length) : id;
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
    const reactDir = path.join(USER_DESIGN_SYSTEMS_DIR, slug, 'react');
    let html;
    try {
      html = await fs.promises.readFile(path.join(reactDir, 'showcase', 'index.html'), 'utf8');
    } catch {
      return null;
    }
    try {
      const data = await fs.promises.readFile(path.join(reactDir, 'showcase', 'showcase-data.js'), 'utf8');
      html = html.replace(
        '<script src="showcase-data.js"></script>',
        () => `<script>${data.replace(/<\/script/gi, '<\\/script')}</script>`,
      );
    } catch {
      // Older bundles inline the data into index.html — nothing to splice.
    }
    try {
      const css = await fs.promises.readFile(path.join(reactDir, 'styles', 'globals.css'), 'utf8');
      html = html.replace(
        '<link rel="stylesheet" href="../styles/globals.css" />',
        () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`,
      );
    } catch {
      // No stylesheet next to the bundle — leave the link for a served copy.
    }
    // Icon/asset fetches default to the bundle-relative "../assets/", which
    // only resolves when the page is opened from the bundle folder itself.
    // Point window.__FIG_ASSET_BASE__ at the react-assets route instead
    // (relative /api path: the modal loads this page as a same-origin
    // iframe, so cookies/auth flow through). Newer bundles hard-set the
    // global in a head script — rewrite that assignment; older bundles only
    // read it, so a head injection is enough.
    const assetBaseScript = `<script>window.__FIG_ASSET_BASE__ = ${JSON.stringify(
      `/api/design-systems/${encodeURIComponent(id)}/react-assets/`,
    )};</script>`;
    const hardSet = '<script>window.__FIG_ASSET_BASE__ = "../assets/";</script>';
    html = html.includes(hardSet)
      ? html.replace(hardSet, () => assetBaseScript)
      : html.replace('<head>', () => `<head>${assetBaseScript}`);
    return html;
  }

  // Detail payload for a react-bundle design system (Figma IR import): the
  // inventory counts from the manifest's react block plus the two compiler
  // artifacts the detail modal renders — the token-contract style guide and
  // the per-component API catalog.
  async function readReactBundleInfo(id) {
    const slug = typeof id === 'string' && id.startsWith('user:') ? id.slice('user:'.length) : id;
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
    const brandRoot = path.join(USER_DESIGN_SYSTEMS_DIR, slug);
    let manifest;
    try {
      manifest = JSON.parse(await fs.promises.readFile(path.join(brandRoot, 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
    const react = manifest?.react;
    if (!react || typeof react.dir !== 'string') return null;
    const readOptional = (rel) =>
      fs.promises.readFile(path.join(brandRoot, react.dir, rel), 'utf8').catch(() => '');
    const [styleGuide, catalog] = await Promise.all([
      readOptional('STYLE-GUIDE.md'),
      readOptional('docs/catalog.md'),
    ]);
    return {
      components: Number(react.components ?? 0),
      icons: Number(react.icons ?? 0),
      styleGuide,
      catalog,
    };
  }

  async function readAvailableDesignSystemPackageInfo(id) {
    if (typeof id === 'string' && id.startsWith('user:')) {
      return readDesignSystemPackageInfo(USER_DESIGN_SYSTEMS_DIR, id, { idPrefix: 'user:' });
    }
    return (
      (await readDesignSystemPackageInfo(DESIGN_SYSTEMS_DIR, id))
      ?? (await readDesignSystemPackageInfo(USER_DESIGN_SYSTEMS_DIR, id))
    );
  }

  function isProjectUsableDesignSystem(summary) {
    return summary?.status !== 'draft';
  }

  async function validateProjectDesignSystemId(id) {
    if (id === undefined || id === null || id === '') return { ok: true, id: null };
    if (typeof id !== 'string') {
      return {
        ok: false,
        code: 'INVALID_DESIGN_SYSTEM',
        message: 'designSystemId must be a string or null',
      };
    }
    const systems = await listAllDesignSystems();
    const summary = systems.find((system) => system.id === id);
    if (!summary) {
      return {
        ok: false,
        code: 'DESIGN_SYSTEM_NOT_FOUND',
        message: 'design system not found',
      };
    }
    if (!isProjectUsableDesignSystem(summary)) {
      return {
        ok: false,
        code: 'DESIGN_SYSTEM_NOT_PUBLISHED',
        message: 'draft design systems cannot be used by projects',
      };
    }
    return { ok: true, id };
  }

  function userDesignSystemWorkspaceProjectId(id) {
    if (typeof id !== 'string' || !id.startsWith('user:')) return null;
    const dirId = id.slice('user:'.length);
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(dirId)) return null;
    return `ds-${dirId}`.slice(0, 128);
  }

  function projectBackedDesignSystemProjectId(id, summary) {
    if (typeof summary?.projectId === 'string' && isSafeId(summary.projectId)) {
      return summary.projectId;
    }
    return userDesignSystemWorkspaceProjectId(id);
  }

  async function ensureUserDesignSystemWorkspaceProject(db, id) {
    const systems = await listAllDesignSystems();
    const summary = systems.find((s) => s.id === id && s.source === 'user');
    if (!summary) return null;
    const projectId = projectBackedDesignSystemProjectId(id, summary);
    if (!projectId) return null;

    const now = Date.now();
    const metadata = {
      kind: 'other',
      importedFrom: 'design-system',
      entryFile: 'DESIGN.md',
      sourceFileName: id,
    };
    const existing = getProject(db, projectId);
    const project = existing
      ? updateProject(db, projectId, {
          name: summary.title,
          designSystemId: id,
          metadata: { ...existing.metadata, ...metadata },
          updatedAt: now,
        })
      : insertProject(db, {
          id: projectId,
          name: summary.title,
          skillId: null,
          designSystemId: id,
          pendingPrompt: null,
          metadata,
          createdAt: now,
          updatedAt: now,
        });
    if (!project) return null;

    const files = await listUserDesignSystemFiles(USER_DESIGN_SYSTEMS_DIR, id);
    if (!files) return null;
    for (const file of files) {
      if (file.kind === 'folder') continue;
      const detail = await readUserDesignSystemFile(USER_DESIGN_SYSTEMS_DIR, id, file.path);
      if (!detail) continue;
      if (existing) {
        try {
          const existingFile = await readProjectFile(PROJECTS_DIR, projectId, detail.path, project.metadata);
          if (!isReplaceableDesignSystemWorkspaceFile(detail.path, existingFile)) continue;
        } catch (err) {
          if (!err || err.code !== 'ENOENT') throw err;
        }
      }
      await writeProjectFile(
        PROJECTS_DIR,
        projectId,
        detail.path,
        Buffer.from(detail.content, 'utf8'),
        {},
        project.metadata,
      );
    }
    await removeLegacyDesignSystemWorkspaceArtifacts(project);
    await linkUserDesignSystemProject(USER_DESIGN_SYSTEMS_DIR, id, project.id);
    const projectFiles = await listFiles(PROJECTS_DIR, projectId, { metadata: project.metadata });
    return { project, files: projectFiles };
  }

  function isReplaceableDesignSystemWorkspaceFile(filePath, file) {
    const buffer = file?.buffer;
    if (!Buffer.isBuffer(buffer)) return false;
    const text = buffer.toString('utf8');
    if (/^ui_kits\/app\/components\/.+\.(jsx|tsx|js|ts|css|html)$/u.test(filePath)) {
      return buffer.length < 700 && /od-ui-kit-[a-z-]+/u.test(text);
    }
    if (!/^(DESIGN\.md|README\.md|SKILL\.md|ui_kits\/app\/README\.md)$/u.test(filePath)) {
      return false;
    }
    return hasLegacyDesignSystemPackageReferences(text);
  }

  function hasLegacyDesignSystemPackageReferences(text) {
    return /preview\/(colors-node-types|colors-ui-palette|typography-scale|spacing-system|logo-variants)\.html|ui_kits\/generated_interface(?:\/index\.html|\/)?/u.test(text);
  }

  async function removeLegacyDesignSystemWorkspaceArtifacts(project) {
    if (project?.metadata?.importedFrom !== 'design-system') return;
    const dir = resolveProjectDir(PROJECTS_DIR, project.id, project.metadata);
    for (const artifact of LEGACY_DESIGN_SYSTEM_ARTIFACTS) {
      const replacementReady = await Promise.all(
        artifact.replacementPaths.map(async (replacementPath) => {
          try {
            const stats = await fs.promises.stat(path.join(dir, ...replacementPath.split('/')));
            return stats.isFile();
          } catch (err) {
            if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;
            return false;
          }
        }),
      );
      if (!replacementReady.every(Boolean)) continue;
      await fs.promises.rm(path.join(dir, ...artifact.legacyPath.split('/')), {
        recursive: artifact.removeDirectory === true,
        force: true,
      });
    }
  }

  async function readDesignSystemWorkspaceTextFile(db, summary, filePath) {
    if (!summary?.projectId || !isSafeId(summary.projectId)) return null;
    const project = getProject(db, summary.projectId);
    if (!project) return null;
    try {
      const file = await readProjectFile(
        PROJECTS_DIR,
        project.id,
        filePath,
        project.metadata,
      );
      const text = file.buffer.toString('utf8');
      if (text.includes('\0')) return null;
      return text;
    } catch {
      return null;
    }
  }

  // Chrome may strip the port from the Origin header on same-origin GET
  // requests. Only use this as a fallback for safe, idempotent GET requests;
  // mutating routes always require an exact origin/host match.
  function isPortlessLoopbackOrigin(origin) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])$/.test(origin);
  }

  // Routes that serve content to sandboxed iframes (Origin: null) for
  // read-only purposes.  All other /api routes reject Origin: null.
  const _NULL_ORIGIN_SAFE_GET_RE =
    /^\/projects\/[^/]+\/raw\/|^\/codex-pets\/[^/]+\/spritesheet$/;

  // Reject cross-origin requests to API endpoints.
  // Health/version remain open for monitoring probes.
  // Non-browser clients (no Origin header) are always allowed.
  app.use('/api', (req, res, next) => {
    // Live artifact previews have stricter local-daemon validation and
    // loopback CORS handling on the route itself. Let that middleware produce
    // the structured error shape and preflight headers for preview embeds.
    if (/^\/live-artifacts\/[^/]+\/preview$/.test(req.path)) return next();

    const origin = req.headers.origin;
    // Non-browser client → allow.
    if (origin == null || origin === '') return next();

    // Origin: null (sandboxed iframes) OR Origin: od://app (the packaged
    // desktop app's renderer — apps/packaged/src/protocol.ts registers the
    // `od://` scheme and its every request is proxied to this daemon via
    // `new Request(target, request)`, which carries the renderer's REAL
    // Origin header through unchanged). Neither is `null` on the wire in the
    // od:// case nor a valid http(s) localhost origin, so a Vite dist's
    // `crossorigin` <script type=module>/<link modulepreload> tags — which
    // force CORS mode and always attach Origin, even same-origin — 403 out
    // here once react/dist stopped being a single inlined HTML file and
    // started issuing real asset requests. Only allowed for safe, read-only
    // routes that set their own CORS headers for canvas drawing.
    if (origin === 'null' || origin === 'od://app') {
      const isSafeReadOnly =
        req.method === 'GET' && _NULL_ORIGIN_SAFE_GET_RE.test(req.path);
      if (!isSafeReadOnly) {
        return res.status(403).json({ error: `Origin: ${origin} not allowed for this route` });
      }
      return next();
    }

    // Fail-closed: block all browser origins until port is resolved.
    if (!resolvedPort) {
      return res.status(403).json({ error: 'Server initializing' });
    }

    const ports = allowedBrowserPorts(resolvedPort);
    if (!isAllowedBrowserOrigin(origin, req.headers.host, ports, host, extraAllowedOrigins)) {
      if (req.method !== 'GET' || !isPortlessLoopbackOrigin(String(origin))) {
        return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
      }
    }
    next();
  });
  const db = openDatabase(PROJECT_ROOT, { dataDir: RUNTIME_DATA_DIR });
  // Every stage that ends `failed` sends one error report to the developers
  // (error-reports.ts): outbox under the data dir, upload to the shared
  // media store, listed by pipeline-studio. OD_ERROR_REPORTS=0 disables.
  const errorReporter = createErrorReporter({
    dataDir: RUNTIME_DATA_DIR,
    logPath: resolveDaemonLogPath(runtime),
    namespace: runtime?.namespace ?? null,
    projectName: (id) => {
      try { return getProject(db, id)?.name ?? undefined; } catch { return undefined; }
    },
    // Fan-out stages (dr-review pages, dr-comp screens, ui slices…) finish in
    // daemon code and attach no context; let the reporter read the latest run
    // of each sub-conversation instead so the report says which sub-runs
    // failed and why.
    subRunLookup: (projectId, conversationId) => {
      const runs = design.runs.list({ projectId, conversationId }) as Array<Record<string, unknown>>;
      if (!runs.length) return null;
      const latest = runs.slice().sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))[0]!;
      return {
        id: String(latest.id),
        agentId: (latest.agentId as string | undefined) ?? null,
        status: (latest.status as string | undefined) ?? null,
        error: (latest.error as string | undefined) ?? null,
        exitCode: (latest.exitCode as number | null | undefined) ?? null,
        signal: (latest.signal as string | null | undefined) ?? null,
        errorCode: (latest.errorCode as string | null | undefined) ?? null,
        createdAt: (latest.createdAt as number | undefined) ?? null,
        updatedAt: (latest.updatedAt as number | undefined) ?? null,
        stderrTail: (latest.stderrTail as string | undefined) ?? null,
        stdoutTail: (latest.stdoutTail as string | undefined) ?? null,
      };
    },
    workflowIdOf: (pipelineId) => workflowDirForPipeline(pipelineId) ?? null,
  });
  setPipelineFailureHook((info) => errorReporter.report(info));
  // Wire the upload-destination bridge to this db so multer can route
  // file uploads into baseDir-rooted projects' actual folders.
  projectMetadataLookup = (id) => {
    try { return getProject(db, id)?.metadata ?? null; } catch { return null; }
  };
  configureConnectorCredentialStore(new FileConnectorCredentialStore(RUNTIME_DATA_DIR));
  configureComposioConfigStore(RUNTIME_DATA_DIR);
  composioConnectorProvider.configureCatalogCache(RUNTIME_DATA_DIR);
  composioConnectorProvider.startCatalogRefreshLoop();

  // RoutineService persistence is a thin adapter over the SQLite helpers.
  // Routines are stored as DB rows; the service holds in-memory timers and
  // delegates "list me everything" / "record a run" back to SQLite.
  routineService = new RoutineService({
    list: () => listRoutines(db).map((row) => routineDbRowToContract(row, null)),
    insertRun: (run) => {
      insertRoutineRun(db, {
        id: run.id,
        routineId: run.routineId,
        trigger: run.trigger,
        status: run.status,
        projectId: run.projectId,
        conversationId: run.conversationId,
        agentRunId: run.agentRunId,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        summary: run.summary,
        error: run.error,
        errorCode: run.errorCode,
      });
    },
    updateRun: (id, patch) => {
      updateRoutineRun(db, id, patch);
    },
    getLatestRun: (routineId) => getLatestRoutineRun(db, routineId),
  });
  let daemonUrl = `http://127.0.0.1:${port}`;

  // Boot reconcile: any critique_runs row left in 'running' state by a prior
  // daemon crash gets flipped to 'interrupted' with rounds_json.recoveryReason
  // = 'daemon_restart' so the spec's daemon-restart-mid-run failure mode is
  // honored on every boot. staleAfterMs comes from CritiqueConfig, not a
  // hardcoded constant.
  const reconciledStaleRuns = reconcileStaleRuns(db, { staleAfterMs: critiqueCfg.totalTimeoutMs });
  if (reconciledStaleRuns > 0) {
    console.warn(`[critique] reconcileStaleRuns flipped ${reconciledStaleRuns} stale running row(s) to interrupted`);
  }
  const mediaReconcile = reconcileMediaTasksOnBoot(db, {
    terminalTtlMs: TASK_TTL_AFTER_DONE_MS,
  });
  if (mediaReconcile.interrupted > 0 || mediaReconcile.deleted > 0) {
    console.warn(
      `[media] reconcileMediaTasksOnBoot interrupted ${mediaReconcile.interrupted} task(s), ` +
        `deleted ${mediaReconcile.deleted} expired terminal task(s)`,
    );
  }
  mediaTasks.clear();
  for (const row of listRecentMediaTasks(db, { terminalTtlMs: TASK_TTL_AFTER_DONE_MS })) {
    hydrateMediaTask(row);
  }

  if (process.env.OD_CODEX_DISABLE_PLUGINS === '1') {
    console.log('[od] Codex plugins disabled via OD_CODEX_DISABLE_PLUGINS=1');
  }

  let bundledMarketplaceEntries = [];
  // Plan §3.I3 / spec §23.3.5 — register every plugin under
  // <resourceRoot>/plugins/_official/** in packaged runs, or
  // <projectRoot>/plugins/_official/** in workspace runs, as bundled plugins. The walker
  // is idempotent (upserts on every boot) so a daemon upgrade rotates
  // the bundled set in lockstep with the code. ENOENT is silent —
  // running the daemon outside the dev tree just skips this step.
  try {
    const result = await registerBundledPlugins({
      db,
      bundledRoot: BUNDLED_PLUGINS_DIR,
      marketplaceProvenance: {
        sourceMarketplaceId: OFFICIAL_MARKETPLACE_ID,
        marketplaceTrust:    'official',
        entryNamePrefix:     'open-design',
      },
    });
    bundledMarketplaceEntries = result.registered.map((plugin) => ({
      name:        `open-design/${plugin.id}`,
      title:       plugin.title,
      title_i18n:  plugin.manifest.title_i18n,
      description: plugin.manifest.description,
      description_i18n: plugin.manifest.description_i18n,
      version:     plugin.version,
      source:      bundledPluginRegistrySource(plugin.source),
      publisher:   { id: 'open-design', url: 'https://open-design.ai' },
      homepage:    plugin.manifest.homepage,
      license:     plugin.manifest.license,
      tags:        plugin.manifest.tags,
      capabilitiesSummary: Array.isArray(plugin.manifest.od?.capabilities)
        ? plugin.manifest.od.capabilities
        : undefined,
    }));
    if (result.registered.length > 0) {
      console.log(`[plugins] registered ${result.registered.length} bundled plugin(s)`);
    }
    if (result.warnings.length > 0) {
      for (const w of result.warnings) console.warn(`[plugins] bundled warn: ${w}`);
    }
  } catch (err) {
    console.warn(`[plugins] bundled registration failed: ${(err)?.message ?? err}`);
  }

  try {
    const seedDirs = await fs.promises.readdir(PLUGIN_REGISTRY_DIR, { withFileTypes: true }).catch((err) => {
      if (err?.code === 'ENOENT') return [];
      throw err;
    });
    const { ensureMarketplaceManifest } = await import('./plugins/marketplaces.js');
    for (const dirent of seedDirs) {
      if (!dirent.isDirectory()) continue;
      const id = dirent.name;
      const manifestText = await marketplaceSeedManifestText(id, bundledMarketplaceEntries);
      if (!manifestText) continue;
      const configured = defaultMarketplaceSeedConfig(id);
      const result = ensureMarketplaceManifest(db, {
        id,
        url: configured.url,
        trust: configured.trust,
        manifestText,
      });
      if (result.ok) {
        console.log(`[plugins] seeded ${id} registry source (${result.row.manifest.plugins.length} plugin(s))`);
      } else {
        console.warn(`[plugins] ${id} registry seed failed: ${result.message}`);
      }
    }
  } catch (err) {
    console.warn(`[plugins] registry seed failed: ${(err)?.message ?? err}`);
  }

  // Default external MCP servers for a fresh data dir (none since 2026-08-18
  // — see defaultMcpServers), then drop the `ba-agent` entry older versions
  // auto-seeded so upgraded machines stop showing a pre-filled external MCP
  // server in Settings. Both best-effort: never block startup.
  try {
    const seededMcp = await seedDefaultMcpConfig(RUNTIME_DATA_DIR);
    if (seededMcp.length > 0) {
      console.log(`[mcp] seeded ${seededMcp.length} default server(s): ${seededMcp.join(', ')}`);
    }
  } catch (err) {
    console.warn(`[mcp] default seed failed: ${(err)?.message ?? err}`);
  }
  try {
    if (await removeLegacyBaAgentSeed(RUNTIME_DATA_DIR)) {
      console.log('[mcp] removed the legacy auto-seeded ba-agent server from mcp-config.json');
    }
  } catch (err) {
    console.warn(`[mcp] legacy ba-agent cleanup failed: ${(err)?.message ?? err}`);
  }
  // Best-effort, non-blocking: when an enabled stdio MCP server is launched via
  // `uvx` (e.g. mcp-atlassian) and the machine lacks uv, install it so the
  // server actually starts. Runs after the seed so a fresh install is covered.
  void ensureUvForMcp(RUNTIME_DATA_DIR);

  // Plan §3.A5 / spec §16 Phase 5 / PB2: periodic snapshot GC. Disabled
  // when OD_SNAPSHOT_GC_INTERVAL_MS is 0; otherwise one-time bootstrap
  // sweep + interval. The function returns a NOOP_HANDLE when disabled
  // so we don't have to branch on the result.
  const snapshotGc = startSnapshotGc({ db });
  // One immediate sweep so a daemon that just gained the ALTER doesn't
  // wait the full interval before reaping pre-existing expired rows.
  try {
    const initialSweep = pruneExpiredSnapshots(db);
    if (initialSweep.removed > 0) {
      console.log(`[plugins] snapshot GC startup sweep removed ${initialSweep.removed} row(s)`);
    }
  } catch (err) {
    console.warn(`[plugins] snapshot GC startup sweep failed: ${(err)?.message ?? err}`);
  }
  void snapshotGc; // keep handle alive for the daemon's lifetime

  // Warm agent-capability probes (e.g. whether the installed Claude Code
  // build advertises --include-partial-messages) so the first /api/chat
  // hits a populated cache even if /api/agents hasn't been called yet.
  void readAppConfig(RUNTIME_DATA_DIR)
    .then((config) => {
      orbitService.configure(config.orbit);
      return detectAgents(config.agentCliEnv ?? {}, sandboxSkipProbe(config));
    })
    .catch(() => detectAgents().catch(() => {}));

  await recoverStaleLiveArtifactRefreshes({ projectsRoot: PROJECTS_DIR }).catch((error) => {
    console.warn('[od] Failed to recover stale live artifact refreshes:', error);
  });

  if (fs.existsSync(STATIC_DIR)) {
    app.use(express.static(STATIC_DIR));
  }

  app.get('/api/health', async (_req, res) => {
    const versionInfo = await readCurrentAppVersionInfo();
    res.json({ ok: true, version: versionInfo.version });
  });

  app.get('/api/version', async (_req, res) => {
    const version = await readCurrentAppVersionInfo();
    res.json({ version });
  });

  // draw.io static viewer (Apache-2.0, ~4 MB) for the flow-UX preview. Too big
  // to vendor into the repo, so it is fetched ONCE into the runtime data dir
  // and served from there; the web falls back to the CDN when this 503s.
  app.get('/api/vendor/drawio-viewer.js', async (req, res) => {
    await serveDrawioViewerJs(req, res, RUNTIME_DATA_DIR);
  });

  app.get('/api/github/open-design', async (_req, res) => {
    try {
      const stats = await readOpenDesignGithubRepoStats();
      const payload = /** @type {OpenDesignGithubRepoResponse} */ ({
        repo: 'nexu-io/open-design',
        stargazers_count: stats.stargazersCount,
        fetchedAt: stats.fetchedAt,
        stale: stats.stale,
      });
      res.json(payload);
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get('/api/github/open-design/releases/latest', async (_req, res) => {
    try {
      const release = await readOpenDesignLatestReleaseInfo();
      const payload = /** @type {OpenDesignGithubLatestReleaseResponse} */ ({
        repo: 'nexu-io/open-design',
        tag_name: release.tagName,
        html_url: release.htmlUrl,
        fetchedAt: release.fetchedAt,
        stale: release.stale,
      });
      res.json(payload);
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Plan §3.F2 / spec §11.7 — daemon lifecycle status. Returns the
  // host / port the server is bound to plus the data dir,
  // so `od daemon status --json` can render a one-shot health snapshot
  // without depending on /api/version's content shape.
  app.get('/api/daemon/status', async (_req, res) => {
    const versionInfo = await readCurrentAppVersionInfo();
    res.json({
      ok: true,
      version: versionInfo.version,
      bindHost: process.env.OD_BIND_HOST ?? '127.0.0.1',
      port: Number(process.env.OD_PORT ?? 7456),
      dataDir: RUNTIME_DATA_DIR,
      mediaConfigDir: process.env.OD_MEDIA_CONFIG_DIR ?? null,
      pid: process.pid,
      shuttingDown: daemonShuttingDown,
      installedPlugins: (() => {
        try {
          return (db.prepare('SELECT COUNT(*) AS n FROM installed_plugins').get())?.n ?? 0;
        } catch {
          return 0;
        }
      })(),
    });
  });

  // Plan §3.GG1 — `od daemon db status`. Inventory of the SQLite
  // backend: file path, size on disk (primary + WAL + SHM), schema
  // version (the user_version PRAGMA we use for migrations), and
  // per-table row counts. Useful for ops sanity-checking
  // deployments + comparing 'expected' vs. 'actual' table rosters.
  app.get('/api/daemon/db', async (_req, res) => {
    try {
      const { inspectSqliteDatabase } = await import('./storage/db-inspect.js');
      const file = path.join(RUNTIME_DATA_DIR, 'app.sqlite');
      const report = await inspectSqliteDatabase({ db, file });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plan §3.KK1 — non-SSE one-shot read of the event ring buffer.
  // Useful for dashboards + the `od plugin events snapshot` CLI
  // command that doesn't need a live tail.
  app.get('/api/plugins/events/snapshot', async (req, res) => {
    const since = Number(typeof req.query.since === 'string' ? req.query.since : 0);
    const { pluginEventSnapshot } = await import('./plugins/events.js');
    const events = pluginEventSnapshot(Number.isFinite(since) && since > 0 ? since : 0);
    res.json({ events, count: events.length, generatedAt: Date.now() });
  });

  // Plan §3.KK2 — rolled-up stats over the buffer. Counts by kind +
  // pluginId + oldest/newest timestamps + id range.
  app.get('/api/plugins/events/stats', async (_req, res) => {
    const { pluginEventSnapshot, summarisePluginEvents } = await import('./plugins/events.js');
    res.json({
      stats: summarisePluginEvents(pluginEventSnapshot()),
      generatedAt: Date.now(),
    });
  });

  // Plan §3.NN1 — `od plugin events purge`. Operator escape
  // hatch for resetting the in-memory ring buffer. Loopback-only
  // because clearing the buffer drops audit history; an operator
  // with shell access to the daemon machine should be the only
  // one allowed to invoke. Returns the pre-purge stats so the
  // caller can confirm what they discarded.
  app.post('/api/plugins/events/purge', requireLocalDaemonRequest, async (_req, res) => {
    try {
      const { purgePluginEventBuffer } = await import('./plugins/events.js');
      const result = purgePluginEventBuffer();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plan §3.II1 — `od plugin events tail`. SSE-backed live event
  // stream of plugin lifecycle events from the in-memory ring
  // buffer. On open: emits the buffered backlog as 'event: backlog'
  // entries (capped at the buffer's MAX), then forwards every
  // newly-recorded event as 'event: plugin' with the same shape.
  // Optional ?since=<id> trims the backlog.
  app.get('/api/plugins/events', async (req, res) => {
    const since = Number(typeof req.query.since === 'string' ? req.query.since : 0);
    const { pluginEventSnapshot, subscribePluginEvents } = await import('./plugins/events.js');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Emit the backlog so a tail consumer doesn't miss installs
    // that happened just before they connected.
    const backlog = pluginEventSnapshot(Number.isFinite(since) && since > 0 ? since : 0);
    for (const ev of backlog) {
      res.write(`event: backlog\ndata: ${JSON.stringify(ev)}\n\n`);
    }

    const unsubscribe = subscribePluginEvents((ev) => {
      res.write(`event: plugin\ndata: ${JSON.stringify(ev)}\n\n`);
    });
    req.on('close', () => { unsubscribe(); });
  });

  // Plan §3.LL1 — `od daemon db verify`. Runs SQLite
  // PRAGMA integrity_check (or quick_check when ?quick=1) +
  // PRAGMA foreign_key_check, returns a structured issues[]
  // report. Loopback-only via requireLocalDaemonRequest because
  // the result reveals storage-layer state.
  app.post('/api/daemon/db/verify', requireLocalDaemonRequest, async (req, res) => {
    try {
      const { verifySqliteIntegrity } = await import('./storage/db-inspect.js');
      const quick = String(req.query.quick ?? '').toLowerCase();
      const report = verifySqliteIntegrity({ db, quick: quick === '1' || quick === 'true' });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plan §3.HH2 — `od daemon db vacuum`. Runs SQLite VACUUM to
  // reclaim space after large delete batches (snapshot prune,
  // plugin uninstall, etc.). Reports before / after sizes so the
  // operator sees the reclamation, plus elapsed ms so a slow
  // VACUUM on a big DB is visible.
  app.post('/api/daemon/db/vacuum', requireLocalDaemonRequest, async (_req, res) => {
    try {
      const { inspectSqliteDatabase } = await import('./storage/db-inspect.js');
      const file = path.join(RUNTIME_DATA_DIR, 'app.sqlite');
      const before = await inspectSqliteDatabase({ db, file });
      const startedAt = Date.now();
      // VACUUM cannot run inside an active transaction; better-sqlite3
      // exposes it as a regular pragma exec.
      db.exec('VACUUM');
      const elapsedMs = Date.now() - startedAt;
      const after = await inspectSqliteDatabase({ db, file });
      res.json({
        ok: true,
        beforeBytes: before.sizeBytes,
        afterBytes:  after.sizeBytes,
        reclaimedBytes: Math.max(0, before.sizeBytes - after.sizeBytes),
        elapsedMs,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plan §3.F2 — graceful shutdown. The CLI calls this from
  // `od daemon stop`; the actual close path goes through the same
  // SIGTERM-equivalent flow as a parent-process kill (the boot wrapper
  // in cli.ts wires the process listeners). 202 Accepted because the
  // shutdown completes after the response flush.
  app.post('/api/daemon/shutdown', requireLocalDaemonRequest, (_req, res) => {
    res.status(202).json({ ok: true, scheduled: true });
    setImmediate(() => {
      try {
        process.emit('SIGTERM');
      } catch {
        // Best-effort; if the listener was removed (or the process is
        // mid-shutdown already) the kernel SIGTERM falls back below.
      }
    });
  });

  // Prometheus scrape endpoint (Phase 12). Returns the full exposition
  // format string. Operators put this behind their existing auth proxy;
  // there is no built-in authn on the daemon HTTP server. To disable
  // the endpoint entirely (air-gapped installs, regulatory contexts),
  // set `OD_METRICS_ENDPOINT=disabled`; the route is registered only
  // when that env value is not the literal string 'disabled'.
  if (process.env.OD_METRICS_ENDPOINT !== 'disabled') {
    app.get('/api/metrics', async (_req, res) => {
      res.setHeader('Content-Type', register.contentType);
      res.send(await getCritiqueMetrics());
    });
  }

  // Phase 16 ratchet endpoint. Returns the rolling conformance window
  // and the ratchet's current recommendation. Operator-driven by
  // design: the recommendation does not flip OD_CRITIQUE_ROLLOUT_PHASE
  // automatically, it surfaces so a deploy-pipeline follow-up can
  // consume it. Tunables come from query string; defaults are the
  // spec values (14 days, 0.90 shipped, 0.95 clean-parse).
  // Codex + lefarcen P1 on PR #1499: clamp query inputs before the
  // evaluator sees them so a request like `?windowDays=0` falls back to
  // the spec default rather than producing a zero-evidence promotion.
  // The evaluator also defends at its own entry; both are intentional
  // (belt + suspenders) so a future caller that bypasses this route
  // cannot reach an unguarded code path either.
  const parsePositiveInt = (raw: unknown, fallback: number): number => {
    if (typeof raw !== 'string' || raw.length === 0) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const parseRate = (raw: unknown, fallback: number): number => {
    if (typeof raw !== 'string' || raw.length === 0) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
  };
  app.get('/api/critique/conformance', async (req, res) => {
    try {
      const windowDays = parsePositiveInt(req.query.windowDays, 14);
      const shippedThreshold = parseRate(req.query.shippedThreshold, 0.90);
      const cleanParseThreshold = parseRate(req.query.cleanParseThreshold, 0.95);
      const history = await readConformanceHistory(RUNTIME_DATA_DIR, windowDays);
      const decision = evaluateRollout({
        current: parseRolloutPhase(process.env.OD_CRITIQUE_ROLLOUT_PHASE),
        history,
        windowDays,
        shippedThreshold,
        cleanParseThreshold,
      });
      res.json({ window: { days: windowDays, history }, decision });
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
    }
  });

  registerConnectorRoutes(app, {
    sendApiError,
    authorizeToolRequest,
    projectsRoot: PROJECTS_DIR,
    requireLocalDaemonRequest,
    composio: composioConnectorProvider,
  });

  // Gate the diagnostics export behind requireLocalDaemonRequest so it stays
  // unreachable when daemon binds to a non-loopback address (Tailscale,
  // 0.0.0.0, etc.). The bundle contains daemon/web/desktop logs, host
  // metadata, and crash reports — same threat tier as connector / live-
  // artifact endpoints, which all use the same guard.
  app.get(
    DIAGNOSTICS_EXPORT_PATH,
    requireLocalDaemonRequest,
    createDiagnosticsExportHandler({ runtime, projectRoot: PROJECT_ROOT }),
  );

  // ---- Projects (DB-backed) -------------------------------------------------


  // ----- Memory store -----------------------------------------------------
  // Markdown-on-disk memory under <dataDir>/memory/. The daemon folds these
  // into every system prompt (gated by `enabled`) and the chat run loop
  // calls `/api/memory/extract` after each turn to sediment new facts.
  app.get('/api/memory', async (_req, res) => {
    try {
      const [config, index, entries] = await Promise.all([
        readMemoryConfig(RUNTIME_DATA_DIR),
        readMemoryIndex(RUNTIME_DATA_DIR),
        listMemoryEntries(RUNTIME_DATA_DIR),
      ]);
      res.json({
        enabled: config.enabled,
        chatExtractionEnabled: config.chatExtractionEnabled,
        rootDir: memoryDir(RUNTIME_DATA_DIR),
        index,
        entries,
        extraction: maskMemoryExtractionConfig(config.extraction),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Static sub-resources (`/index`, `/config`, `/extract`) registered
  // BEFORE the `:id` catch-alls so an `index` / `config` / `extract` slug
  // can't shadow the real handlers.
  app.get('/api/memory/tree', async (_req, res) => {
    try {
      const [config, tree] = await Promise.all([
        readMemoryConfig(RUNTIME_DATA_DIR),
        buildMemoryTree(RUNTIME_DATA_DIR),
      ]);
      res.json({
        enabled: config.enabled,
        rootDir: memoryDir(RUNTIME_DATA_DIR),
        tree,
      });
    } catch (err) {
      res.status(500).json({ error: String((err && err.message) || err) });
    }
  });

  app.patch('/api/memory/tree/:id', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const entry = await updateMemoryTreeNode(
        RUNTIME_DATA_DIR,
        req.params.id,
        body,
      );
      const tree = await buildMemoryTree(RUNTIME_DATA_DIR);
      res.json({ entry, tree });
    } catch (err) {
      const message = String((err && err.message) || err);
      res.status(message === 'memory not found' ? 404 : 400).json({ error: message });
    }
  });

  app.put('/api/memory/index', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const index = typeof body.index === 'string' ? body.index : '';
      await writeMemoryIndex(RUNTIME_DATA_DIR, index);
      res.json({ index });
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

  app.patch('/api/memory/config', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const patch = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body.chatExtractionEnabled === 'boolean') {
        patch.chatExtractionEnabled = body.chatExtractionEnabled;
      }
      // Three-state extraction handling so the UI can: (a) leave the
      // override alone (omit `extraction`), (b) clear it back to
      // auto-pick (`extraction: null`), or (c) commit a custom override
      // (`extraction: { provider, ... }`). For the apiKey field we
      // need *four* states because the masked GET surfaces only an
      // `apiKeyTail` (the secret never round-trips):
      //   - field absent      → preserve the stored key (UI re-saves
      //                          a settings form without re-typing
      //                          the secret).
      //   - field === ''      → CLEAR the stored key (the picker's
      //                          drift-resync effect fires this when
      //                          the user clears their BYOK chat
      //                          API key — keeping the old daemon-
      //                          side credential would silently keep
      //                          calling the provider after the user
      //                          intentionally removed it from the
      //                          chat picker, which the reviewer
      //                          flagged as a credential-sync bug).
      //   - field === 'sk-…'  → replace with the new key.
      //   - provider differs  → ignore stored key entirely.
      if (Object.prototype.hasOwnProperty.call(body, 'extraction')) {
        if (body.extraction === null) {
          patch.extraction = null;
        } else if (body.extraction && typeof body.extraction === 'object') {
          const incoming = body.extraction;
          const current = await readMemoryConfig(RUNTIME_DATA_DIR);
          const apiKeyOmitted = !Object.prototype.hasOwnProperty.call(
            incoming,
            'apiKey',
          );
          const sameProvider =
            !!current.extraction
            && current.extraction.provider === incoming.provider;
          let nextApiKey = '';
          if (typeof incoming.apiKey === 'string' && incoming.apiKey) {
            nextApiKey = incoming.apiKey;
          } else if (apiKeyOmitted && sameProvider) {
            nextApiKey = current.extraction.apiKey ?? '';
          }
          patch.extraction = {
            provider: incoming.provider,
            model:
              typeof incoming.model === 'string' ? incoming.model : undefined,
            baseUrl:
              typeof incoming.baseUrl === 'string'
                ? incoming.baseUrl
                : undefined,
            apiKey: nextApiKey,
            // Azure-only; ignored by the validator for the other providers.
            // We forward whatever the UI sent (or the previously-stored
            // value when the UI omits the field) so re-saving an azure
            // override without re-typing the api-version doesn't blank it.
            apiVersion:
              typeof incoming.apiVersion === 'string'
                ? incoming.apiVersion
                : current.extraction?.apiVersion,
          };
        }
      }
      const next = await writeMemoryConfig(RUNTIME_DATA_DIR, patch);
      res.json({
        enabled: next.enabled,
        chatExtractionEnabled: next.chatExtractionEnabled,
        extraction: maskMemoryExtractionConfig(next.extraction),
      });
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

  // SSE feed of memory mutations. The web settings panel subscribes to
  // this and re-fetches on every event; toast UIs can listen for
  // `kind === 'extract'` and surface a small "Memory updated (N new)"
  // notification. Payload shape: MemoryChangeEvent (see ./memory.ts).
  //
  // The same connection also forwards `extraction` events — one per LLM
  // extraction phase transition — so the settings panel can render a
  // live "recent extractions" list. We multiplex on a single SSE stream
  // so the browser opens one connection instead of two.
  app.get('/api/memory/events', async (_req, res) => {
    const sse = createSseResponse(res);
    sse.send('connected', { at: Date.now() });
    const onChange = (event) => {
      sse.send('change', event);
    };
    const onExtraction = (event) => {
      sse.send('extraction', event);
    };
    memoryEvents.on('change', onChange);
    memoryEvents.on('extraction', onExtraction);
    res.on('close', () => {
      memoryEvents.off('change', onChange);
      memoryEvents.off('extraction', onExtraction);
    });
  });

  // Recent LLM-extraction attempts (newest first; capped server-side).
  // Surfaces skip reasons, in-flight calls, success counts, and errors
  // so the settings panel can show "why didn't memory update?" at a
  // glance instead of leaving the user to guess.
  app.get('/api/memory/extractions', async (_req, res) => {
    try {
      res.json({ extractions: listMemoryExtractions() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Drop the entire extraction history. Registered BEFORE the `:id`
  // catch-all so a literal "/api/memory/extractions" can still be
  // cleared with `curl -X DELETE`.
  app.delete('/api/memory/extractions', async (_req, res) => {
    try {
      const removed = clearMemoryExtractions();
      res.json({ removed });
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

	  app.delete('/api/memory/extractions/:id', async (req, res) => {
	    try {
	      const removed = removeMemoryExtraction(req.params.id);
	      res.json({ removed });
	    } catch (err) {
	      res.status(400).json({ error: String((err && err.message) || err) });
	    }
	  });

	  app.post('/api/memory/connectors/suggest', requireLocalDaemonRequest, async (req, res) => {
	    try {
	      const body = req.body && typeof req.body === 'object' ? req.body : {};
	      const connectorIds = Array.isArray(body.connectorIds)
	        ? body.connectorIds
	          .filter((id) => typeof id === 'string')
	          .map((id) => id.trim())
	          .filter(Boolean)
	          .slice(0, 12)
	        : undefined;
	      const query =
	        typeof body.query === 'string' ? body.query.trim().slice(0, 240) : '';
	      const projectId =
	        typeof body.projectId === 'string' && body.projectId.trim()
	          ? body.projectId.trim()
	          : null;
	      const appConfig = await readAppConfig(RUNTIME_DATA_DIR).catch(() => ({}));
	      const chatAgentId =
	        typeof body.chatAgentId === 'string' && body.chatAgentId.trim()
	          ? body.chatAgentId.trim()
	          : typeof appConfig.agentId === 'string' && appConfig.agentId.trim()
	            ? appConfig.agentId.trim()
	            : null;
	      const requestChatModel =
	        typeof body.chatModel === 'string' && body.chatModel.trim()
	          ? body.chatModel.trim()
	          : null;
	      const chatModel =
	        requestChatModel
	        || (chatAgentId && appConfig.agentModels?.[chatAgentId]?.model
	          ? appConfig.agentModels[chatAgentId].model
	          : null);
	      const result = await suggestMemoryFromConnectors(RUNTIME_DATA_DIR, {
	        projectsRoot: PROJECTS_DIR,
	        projectRoot: PROJECT_ROOT,
	        projectId,
	        connectorIds,
	        query,
	        chatAgentId,
	        chatModel,
	      });
	      res.json(result);
	    } catch (err) {
	      res.status(400).json({ error: String((err && err.message) || err) });
	    }
	  });

	  app.post('/api/memory/connectors/extract', requireLocalDaemonRequest, async (req, res) => {
	    try {
	      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const connectorIds = Array.isArray(body.connectorIds)
        ? body.connectorIds
          .filter((id) => typeof id === 'string')
          .map((id) => id.trim())
          .filter(Boolean)
          .slice(0, 12)
        : undefined;
      const query =
        typeof body.query === 'string' ? body.query.trim().slice(0, 240) : '';
      const projectId =
        typeof body.projectId === 'string' && body.projectId.trim()
          ? body.projectId.trim()
          : null;
      const appConfig = await readAppConfig(RUNTIME_DATA_DIR).catch(() => ({}));
      const chatAgentId =
        typeof body.chatAgentId === 'string' && body.chatAgentId.trim()
          ? body.chatAgentId.trim()
          : typeof appConfig.agentId === 'string' && appConfig.agentId.trim()
            ? appConfig.agentId.trim()
            : null;
      const requestChatModel =
        typeof body.chatModel === 'string' && body.chatModel.trim()
          ? body.chatModel.trim()
          : null;
      const chatModel =
        requestChatModel
        || (chatAgentId && appConfig.agentModels?.[chatAgentId]?.model
          ? appConfig.agentModels[chatAgentId].model
          : null);
      const result = await extractMemoryFromConnectors(RUNTIME_DATA_DIR, {
        projectsRoot: PROJECTS_DIR,
        projectRoot: PROJECT_ROOT,
        projectId,
        connectorIds,
        query,
        chatAgentId,
        chatModel,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

  // Imperative extract — used by CLI chats internally and by BYOK /
  // API-mode chats from the web app, which never reach the chat-run
  // path on the daemon. Mirrors the two-phase hook the daemon's chat
  // route applies inline:
  //
  //   - Pre-turn (only `userMessage` supplied): run the synchronous
  //     heuristic regex pack so explicit "remember: X" / "我是 X"
  //     markers land in memory before the prompt is composed, and the
  //     same turn's assistant reply already reflects them.
  //   - Post-turn (`userMessage` + `assistantMessage` supplied): queue
  //     the LLM extractor in the background — it speaks SSE /
  //     extraction-history on its own and may take several seconds, so
  //     we don't block the HTTP response on it. The heuristic is
  //     skipped on this branch because the caller already ran it
  //     pre-turn; running it twice would double the
  //     `recordHeuristic({...})` rows in the extraction history for
  //     every turn.
  //
  // External callers (curl, replay tools) that pass only
  // `userMessage` keep the legacy behaviour: heuristic-only.
  app.post('/api/memory/extract', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const userMessage =
        typeof body.userMessage === 'string' ? body.userMessage : '';
      const assistantMessage =
        typeof body.assistantMessage === 'string' ? body.assistantMessage : '';
      const hasAssistant = assistantMessage.trim().length > 0;
      const memoryConfig = await readMemoryConfig(RUNTIME_DATA_DIR);
      if (memoryConfig.chatExtractionEnabled === false) {
        return res.json({ changed: [], attemptedLLM: false });
      }
      const changed = hasAssistant
        ? []
        : await extractFromMessage(RUNTIME_DATA_DIR, userMessage);
      // BYOK chat config — only forwarded by the web app for API-mode
      // chats. We strip the surface to the five fields pickProvider()
      // actually consumes and validate the provider against the four
      // shapes the extractor speaks; an unknown / missing provider
      // means "let the legacy chain decide" so a malformed payload
      // can't override the env / media-config fallbacks.
      const rawChat = body.chatProvider;
      let chatProvider = null;
      if (rawChat && typeof rawChat === 'object') {
        const provider = rawChat.provider;
        if (
          provider === 'anthropic'
          || provider === 'openai'
          || provider === 'azure'
          || provider === 'google'
          || provider === 'ollama'
        ) {
          chatProvider = {
            provider,
            apiKey: typeof rawChat.apiKey === 'string' ? rawChat.apiKey : '',
            baseUrl: typeof rawChat.baseUrl === 'string' ? rawChat.baseUrl : '',
            apiVersion:
              typeof rawChat.apiVersion === 'string' ? rawChat.apiVersion : '',
            model: typeof rawChat.model === 'string' ? rawChat.model : '',
          };
        }
      }
      let attemptedLLM = false;
      if (userMessage.trim().length > 0 && hasAssistant) {
        attemptedLLM = true;
        void import('./memory-llm.js')
          .then(({ extractWithLLM }) =>
            extractWithLLM(
              RUNTIME_DATA_DIR,
              { userMessage, assistantMessage },
              {
                projectRoot: PROJECT_ROOT,
                chatAgentId: null,
                chatProvider,
              },
            ),
          )
          .catch((err) =>
            console.warn('[memory-llm] background failed (http extract)', err),
          );
      }
      res.json({ changed, attemptedLLM });
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

  // Composed memory body for the system prompt. Daemon-side chat runs
  // call `composeMemoryBody()` directly; the web app (BYOK / API mode)
  // can't import daemon internals, so this endpoint exposes the same
  // string the daemon would have folded into the system prompt for a
  // CLI run. `ProjectView.composedSystemPrompt()` calls it before each
  // BYOK turn and passes the result into `composeSystemPrompt`'s
  // `memoryBody` field — without this, the Memory tab is a no-op for
  // BYOK users even though the UI saves model/index/entries for them.
  app.get('/api/memory/system-prompt', async (_req, res) => {
    try {
      const body = await composeMemoryBody(RUNTIME_DATA_DIR);
      res.json({ body });
    } catch (err) {
      res.status(500).json({ error: String((err && err.message) || err) });
    }
  });

  app.get('/api/automation-source-packets', async (req, res) => {
    try {
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const packets = await listAutomationSourcePackets(RUNTIME_DATA_DIR, { limit });
      res.json({ packets });
    } catch (err) {
      res.status(500).json({ error: String((err && err.message) || err) });
    }
  });

  app.post('/api/automation-ingestions', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = await ingestAutomationSource(RUNTIME_DATA_DIR, body);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

  app.get('/api/automation-source-packets/:id', async (req, res) => {
    try {
      const packet = await getAutomationSourcePacket(RUNTIME_DATA_DIR, req.params.id);
      if (!packet) return res.status(404).json({ error: 'automation source packet not found' });
      res.json({ packet });
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

  app.get('/api/automation-proposals', async (req, res) => {
    try {
      const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'all';
      const proposals = await listAutomationProposals(RUNTIME_DATA_DIR, {
        status: rawStatus,
      });
      res.json({ proposals });
    } catch (err) {
      res.status(500).json({ error: String((err && err.message) || err) });
    }
  });

  app.post('/api/automation-proposals', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const proposal = await createAutomationProposal(RUNTIME_DATA_DIR, body);
      res.json({ proposal });
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

  app.get('/api/automation-proposals/:id', async (req, res) => {
    try {
      const proposal = await getAutomationProposal(RUNTIME_DATA_DIR, req.params.id);
      if (!proposal) return res.status(404).json({ error: 'automation proposal not found' });
      res.json({ proposal });
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

  app.post('/api/automation-proposals/:id/apply', async (req, res) => {
    try {
      const result = await applyAutomationProposal(RUNTIME_DATA_DIR, req.params.id);
      res.json(result);
    } catch (err) {
      const message = String((err && err.message) || err);
      const status = message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/automation-proposals/:id/reject', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const proposal = await rejectAutomationProposal(
        RUNTIME_DATA_DIR,
        req.params.id,
        typeof body.reason === 'string' ? body.reason : undefined,
      );
      res.json({ proposal });
    } catch (err) {
      const message = String((err && err.message) || err);
      const status = message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/memory', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const entry = await upsertMemoryEntry(RUNTIME_DATA_DIR, body);
      res.json({ entry });
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

  app.get('/api/memory/:id', async (req, res) => {
    try {
      const entry = await readMemoryEntry(RUNTIME_DATA_DIR, req.params.id);
      if (!entry) return res.status(404).json({ error: 'memory not found' });
      res.json({ entry });
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

  app.put('/api/memory/:id', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const entry = await upsertMemoryEntry(RUNTIME_DATA_DIR, {
        ...body,
        id: req.params.id,
      });
      res.json({ entry });
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

  app.delete('/api/memory/:id', async (req, res) => {
    try {
      await deleteMemoryEntry(RUNTIME_DATA_DIR, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String((err && err.message) || err) });
    }
  });

  // Reconcile follow-up — the inline POST /api/projects body that lived
  // on garnet (with baseDir privilege check, linkedDirs validation,
  // template snapshot seeding, plugin snapshot resolution with default
  // scenario fallback) is intentionally dropped here. main moved project
  // route registration into `./project-routes.js` via PR #1043, so the
  // simple project-create surface is wired through `registerProjectRoutes`
  // further down. Plugin-snapshot-resolution / default-scenario-fallback
  // from garnet need to be re-integrated into project-routes.ts as a
  // follow-up — see reconcile decision log.
  // (legacy POST /api/projects body deleted — see registerProjectRoutes below.)

  const analyticsService = createAnalyticsService({ dataDir: RUNTIME_DATA_DIR });
  const design = {
    runs: createChatRunService({ createSseResponse, createSseErrorPayload, runsStateDir: RUNS_STATE_DIR }),
    analytics: analyticsService,
    getAppVersion: () => cachedAppVersion?.version ?? '0.0.0',
    readAnalyticsContext,
  };

  // ---------------------------------------------------------------------
  // Host-runtime self-update, UI/CLI-triggered (see specs/change/
  // 20260815-host-update-ui-windows/spec.md — was fully automatic/silent
  // before this change; the repo owner asked for an explicit user action
  // instead). The web UI's UpdateCheck component polls GET
  // /api/update/status in the background and, when it reports
  // `updateAvailable`, shows a banner with a button the user must click;
  // `od self-update apply` is the CLI-side equivalent. Either caller hits
  // POST /api/update/apply, which shells out to the already-tested
  // `deploy/host/install.sh --update` on macOS/Linux or
  // `powershell -File install.ps1 -Update` on Windows (download, verify
  // sha256, extract, repoint `current`, restart the service, health-check
  // with automatic rollback) and returns immediately — the daemon cannot
  // await its own restart, since the update kills this very process
  // partway through. A spawn-time failure (e.g. missing `bash`/
  // `powershell`) is caught via the child's `'error'` event and surfaced
  // through `lastUpdateError` / GET /api/update/status's `lastError`
  // instead of failing silently.
  // ---------------------------------------------------------------------
  app.get('/api/update/status', async (req, res) => {
    const versionInfo = await readCurrentAppVersionInfo();
    const currentVersion = versionInfo.version;
    // `?refresh=1` = explicit user check from the header button: bypass
    // the release cache and report the outcome (`checkedAt` / `checkError`)
    // so the UI can say "đã là bản mới nhất" or "không kiểm tra được"
    // instead of silently showing the same stale answer.
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';

    let latestVersion = null;
    let checkedAt = null;
    let checkError = null;
    try {
      const release = await readHostRuntimeLatestReleaseInfo({ force: refresh });
      latestVersion = release.version;
      checkedAt = new Date(release.fetchedAt).toISOString();
      if (release.stale && refresh) checkError = 'Không kết nối được GitHub — đang hiển thị kết quả kiểm tra trước đó.';
    } catch (err) {
      // GitHub unreachable / rate-limited — this is a quiet background
      // check, not a user-facing error. Leave latestVersion null; the
      // next poll (or the shared cache once GitHub recovers) picks it up.
      latestVersion = null;
      checkError = refresh ? `Không kiểm tra được bản mới: ${(err as Error).message}` : null;
    }

    const updateAvailable =
      typeof latestVersion === 'string' && compareVersions(latestVersion, currentVersion) > 0;

    let justUpdated = null;
    try {
      const marker = await resolveJustUpdated(RUNTIME_DATA_DIR, currentVersion);
      if (marker) {
        justUpdated = { version: marker.version, at: new Date(marker.at).toISOString() };
      }
    } catch {
      justUpdated = null;
    }

    // The operation record lives under OD_DATA_DIR, so the replacement
    // daemon can finish the state transition after the installer restarts
    // this process. update.log remains the installer's source of coarse
    // phase information; fold it into the durable record on every poll.
    let updateState = await readUpdateState(RUNTIME_DATA_DIR);
    if (updateState && !isTerminalUpdateState(updateState.state)) {
      const parsedProgress = await readUpdateProgress(RUNTIME_DATA_DIR);
      if (parsedProgress) {
        const nextState = updateStateForProgress(parsedProgress);
        if (
          updateState.state !== nextState
          || JSON.stringify(updateState.phase) !== JSON.stringify(parsedProgress)
        ) {
          updateState = await patchUpdateState(RUNTIME_DATA_DIR, updateState.operationId, {
            state: nextState,
            phase: parsedProgress,
          }) ?? updateState;
        }
      }

      // Never infer success from semver while the accepting daemon is
      // still alive: a same-version/replayed release already matches its
      // target before it downloads a byte. Only the replacement daemon,
      // after the installer reached restart, may reconcile the outcome.
      if (!updateApplyInProgress && updateState.state === 'restarting') {
        if (
          updateState.sourceVersion
          && updateState.sourceVersion !== updateState.targetVersion
          && currentVersion === updateState.targetVersion
        ) {
          updateState = await patchUpdateState(RUNTIME_DATA_DIR, updateState.operationId, {
            state: 'healthy',
            error: null,
          }) ?? updateState;
        } else if (currentVersion !== updateState.targetVersion) {
          const error = formatUpdateSpawnError(
            new Error(`update rolled back; daemon is still running ${currentVersion} instead of ${updateState.targetVersion}`),
          );
          updateState = await patchUpdateState(RUNTIME_DATA_DIR, updateState.operationId, {
            state: 'rolled-back',
            error,
          }) ?? updateState;
        } else {
          // Legacy state without sourceVersion (or a hand-written replay)
          // is intrinsically ambiguous: the old and new daemon report the
          // same semver. Fail closed instead of claiming a false success.
          const error = formatUpdateSpawnError(
            new Error(`cannot verify same-version update ${updateState.targetVersion}`),
          );
          updateState = await patchUpdateState(RUNTIME_DATA_DIR, updateState.operationId, {
            state: 'failed',
            error,
          }) ?? updateState;
        }
      }
    }

    // Preserve the legacy contract: `progress` is live/advisory and goes
    // quiet after completion. `phase` inside the durable record remains
    // available for post-mortem inspection.
    const progress = updateState && !isTerminalUpdateState(updateState.state)
      ? updateState.phase
      : null;
    const durableError = updateState?.error ?? lastUpdateError;
    res.json({
      currentVersion,
      latestVersion,
      updateAvailable,
      checkedAt,
      checkError,
      justUpdated,
      lastError: durableError,
      progress,
      operationId: updateState?.operationId ?? null,
      targetVersion: updateState?.targetVersion ?? null,
      state: updateState?.state ?? null,
      phase: updateState?.phase ?? null,
      updateState,
    });
  });

  app.post('/api/update/apply', async (_req, res) => {
    if (updateApplyInProgress) {
      return res.json({ started: false, reason: 'already-in-progress' });
    }
    // Never interrupt an in-flight agent run — the one hard safety
    // property that matters here. The frontend just retries on its next
    // scheduled poll once the run finishes.
    if (design.runs.list({ status: 'active' }).length > 0) {
      return res.json({ started: false, reason: 'runs-active' });
    }

    // Set the lock synchronously, before the first `await` below, so two
    // requests racing in the same event-loop turn can't both slip past
    // the `updateApplyInProgress` check above — Node runs each handler's
    // synchronous prefix to completion before yielding to the next.
    updateApplyInProgress = true;
    // Fresh attempt — clear any error left over from a previous failed
    // attempt so the UI/CLI don't keep reporting a stale failure.
    lastUpdateError = null;
    let operationId = null;
    try {
      const release = await readHostRuntimeLatestReleaseInfo();
      const targetVersion = release?.version;
      if (!targetVersion) throw new Error('latest release version unavailable');

      const sourceVersion = (await readCurrentAppVersionInfo()).version;
      if (compareVersions(targetVersion, sourceVersion) <= 0) {
        updateApplyInProgress = false;
        return res.json({
          started: false,
          reason: 'up-to-date',
          currentVersion: sourceVersion,
          targetVersion,
        });
      }

      const odHome = deriveOdHomeFromResourceRoot(DAEMON_RESOURCE_ROOT);
      if (!odHome) throw new Error('could not resolve OD_HOME from OD_RESOURCE_ROOT');

      operationId = randomUUID();
      const startedAt = new Date().toISOString();
      await writeUpdateState(RUNTIME_DATA_DIR, {
        operationId,
        targetVersion,
        sourceVersion,
        state: 'preparing',
        phase: null,
        error: null,
        startedAt,
        updatedAt: startedAt,
      });

      // Must survive the restart — write to disk BEFORE spawning, not
      // just in memory (this process is about to be killed).
      await writeUpdateMarker(RUNTIME_DATA_DIR, targetVersion);

      const { cmd, args } = resolveUpdateCommand(odHome, process.platform);
      let resolvedCmd = cmd;
      if (process.platform === 'win32') {
        // `cmd` is 'powershell' on this branch — resolve it through PATH/
        // PATHEXT the same way every other Windows executable lookup in
        // this daemon does (see `apps/daemon/src/runtimes/executables.ts`)
        // instead of trusting the bare name to `spawn`. Almost never null
        // in practice, but a null here means spawning would ENOENT anyway
        // — report it as a real error instead of spawning blind.
        const resolvedPowershell = resolveOnPath(cmd);
        if (!resolvedPowershell) {
          const notFoundError = new Error(`"${cmd}" not found on PATH`);
          lastUpdateError = formatUpdateSpawnError(notFoundError);
          throw notFoundError;
        }
        resolvedCmd = resolvedPowershell;
      }

      // Truncate any previous run's log before this attempt — readUpdateProgress
      // always reads the last matching line, so a stale leftover file could
      // otherwise report a phase from an earlier, unrelated attempt.
      let updateLogFd: number | 'ignore' = 'ignore';
      try {
        updateLogFd = fs.openSync(path.join(RUNTIME_DATA_DIR, UPDATE_LOG_FILENAME), 'w');
      } catch {
        // Progress just won't be reported this run — not fatal to the update itself.
        updateLogFd = 'ignore';
      }
      const spawnOptions = resolveUpdateSpawnOptions(process.platform);
      const child = spawn(resolvedCmd, args, {
        ...spawnOptions,
        // Windows cannot let install.ps1 kill this daemon and then continue
        // in the same process tree: live testing showed PowerShell is also
        // terminated at Step 5/6. Mark UI/API-triggered updates so the
        // installer delegates the stop/start to the independent per-user
        // launcher before the daemon is stopped.
        env: process.platform === 'win32'
          ? { ...process.env, OD_SELF_UPDATE: '1', OD_UPDATE_OPERATION_ID: operationId }
          : process.env,
        stdio: ['ignore', updateLogFd, updateLogFd],
      });
      // The child has its own duplicated fd now — release the parent's copy
      // so a sequence of apply attempts over this process's lifetime can't
      // leak file descriptors.
      if (typeof updateLogFd === 'number') {
        try {
          fs.closeSync(updateLogFd);
        } catch {
          /* already closed / invalid — nothing to clean up */
        }
      }
      // A spawn-time failure (ENOENT from a missing bash/powershell, or an
      // install script that doesn't exist) previously vanished silently —
      // `detached: true, stdio: 'ignore'` with no `'error'` listener. This
      // only catches failures BEFORE the child starts running; a failure
      // mid-install (or a health-check rollback) kills this daemon process
      // first and is out of scope here (see spec's "Ngoài phạm vi").
      child.on('error', (err) => {
        lastUpdateError = formatUpdateSpawnError(err);
        updateApplyInProgress = false;
        void patchUpdateState(RUNTIME_DATA_DIR, operationId, {
          state: 'failed',
          error: lastUpdateError,
        }).catch(() => {});
      });
      // A successful update kills THIS process via Stop-OdService before the
      // child ever exits. If this handler runs, the original daemon is still
      // alive, so even code 0 is a failed/incomplete update. This distinction
      // is required on Windows, where detached PowerShell was observed to
      // silently exit 0 without evaluating the script body.
      child.on('exit', (code, signal) => {
        updateApplyInProgress = false;
        if (isWindowsUpdateRestartRequiredExit(process.platform, code, signal)) {
          lastUpdateError = null;
          void patchUpdateState(RUNTIME_DATA_DIR, operationId, {
            state: 'restart-required',
            error: null,
          }).catch(() => {});
          return;
        }
        lastUpdateError = formatUpdateSpawnError(formatPrematureUpdateExitError(code, signal));
        void patchUpdateState(RUNTIME_DATA_DIR, operationId, {
          state: 'failed',
          error: lastUpdateError,
        }).catch(() => {});
      });
      // Only the POSIX updater is detached. Calling unref on the Windows
      // PowerShell child was part of the live failure shape and serves no
      // purpose once that child intentionally remains attached.
      if (spawnOptions.detached) child.unref();

      res.json({ started: true, operationId, targetVersion });
    } catch (error) {
      updateApplyInProgress = false;
      const persistedError = formatUpdateSpawnError(error);
      lastUpdateError = persistedError;
      if (operationId) {
        await patchUpdateState(RUNTIME_DATA_DIR, operationId, {
          state: 'failed',
          error: persistedError,
        }).catch(() => {});
      }
      res.status(500).json({
        started: false,
        reason: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // PostHog runtime config.
  //
  // - `enabled` reflects ONLY the user's consent toggle (Privacy → "Share
  //   usage data"). When false, posthog-js's full autocapture/$pageview/
  //   $autocapture pipeline must stay off — that's the privacy contract.
  //
  // - `key` and `host` are populated whenever the server has a build-time
  //   POSTHOG_KEY, regardless of consent. The error-tracking module
  //   (apps/web/src/analytics/error-tracking.ts) reads them to ship
  //   `$exception` events directly to the ingest endpoint, bypassing the
  //   consent gate. Product decision: error reports always flow so we
  //   don't lose ground truth on stability — see the privacy section of
  //   Settings → Privacy for the user-facing copy.
  //
  // - When the build itself has no POSTHOG_KEY (forks, PR builds, OSS
  //   contributors), `key` and `host` are null and even the error
  //   pipeline becomes a no-op.
  app.get('/api/analytics/config', async (_req, res) => {
    const baseline = readPublicConfigResponse();
    if (!baseline.enabled) {
      // No build-time key → nothing to report on, consent or not.
      res.json(baseline);
      return;
    }
    try {
      const appCfg = await readAppConfig(RUNTIME_DATA_DIR);
      const consentGranted = appCfg.telemetry?.metrics === true;
      // Echo the installationId so the web client uses the same anonymous
      // id PostHog already saw on prior runs (and that Langfuse uses too).
      const installationId =
        typeof appCfg.installationId === 'string' && appCfg.installationId
          ? appCfg.installationId
          : null;
      res.json({
        enabled: consentGranted,
        key: baseline.key,
        host: baseline.host,
        installationId,
      });
    } catch {
      // If the config file is unreadable, fail closed for analytics but
      // still let the error tracker run — exception reports are the most
      // valuable signal in a degraded-state scenario.
      res.json({
        enabled: false,
        key: baseline.key,
        host: baseline.host,
        installationId: null,
      });
    }
  });

  // Cross-process safety-event bridge. Used by:
  //   - Electron main process (renderer crash via render-process-gone)
  //   - Any future helper / sidecar that needs to report a safety event
  //     without owning its own posthog-node client
  //
  // The route DOES NOT check the user's analytics consent: this is the
  // same "safety telemetry always flows" contract the web error-tracking
  // module relies on. If POSTHOG_KEY is not set on the daemon (fork
  // builds), captureSafety is a no-op on NOOP_SERVICE.
  app.post('/api/observability/event', express.json({ limit: '64kb' }), (req, res) => {
    const body = (req.body ?? {}) as Partial<ObservabilityEventRequest>;
    const eventName = typeof body.event === 'string' ? body.event.trim() : '';
    if (!eventName) {
      res.status(400).json({ error: 'missing or invalid `event` field' });
      return;
    }
    const properties =
      body.properties != null && typeof body.properties === 'object' && !Array.isArray(body.properties)
        ? (body.properties as Record<string, unknown>)
        : {};
    analyticsService.captureSafety({
      eventName,
      appVersion: cachedAppVersion?.version ?? '0.0.0',
      properties,
    });
    res.json({ ok: true });
  });

  // Daemon-side uncaught errors. Without these, a crash in any daemon
  // request handler or background task leaves no PostHog signal — the
  // user sees a 500 (or worse, a connection drop) and we see nothing.
  // Both listeners install AFTER the analyticsService is created so the
  // captureSafety dispatch path is guaranteed to be ready.
  //
  // IMPORTANT — these handlers MUST keep Node's fatal-exit semantics.
  // Installing an `uncaughtException` listener silences Node's default
  // crash/exit path, and Node 15+ does the same for `unhandledRejection`
  // when a listener is present (the `--unhandled-rejections=throw` mode
  // only fires when nothing has subscribed). We bounded-flush posthog-
  // node and then call `process.exit(1)` explicitly so the supervisor
  // (pm2, packaged updater, dev `tools-dev`) gets a fresh process and
  // we don't leave a half-broken daemon answering requests with state
  // corruption. See codex review on PR #2527 (Siri-Ray).
  const FATAL_FLUSH_TIMEOUT_MS = 1000;
  let fatalShuttingDown = false;
  const triggerFatalShutdown = (
    eventName: string,
    properties: Record<string, unknown>,
  ): void => {
    if (fatalShuttingDown) return;
    fatalShuttingDown = true;
    // CRITICAL — wait for captureSafety to ENQUEUE the event in
    // posthog-node's local buffer before starting shutdown(). The
    // captureSafety implementation does an `await readInstallationIdSafe()`
    // before calling `client.capture()`; a sync fire-and-forget here would
    // race shutdown() ahead of that await, drain an empty queue, and lose
    // the crash event itself. See codex review on PR #2527 (Siri-Ray).
    const flushSequence = (async () => {
      try {
        await analyticsService.captureSafety({
          eventName,
          appVersion: cachedAppVersion?.version ?? '0.0.0',
          properties,
        });
      } catch {
        // capture must never block the exit path
      }
      await analyticsService.shutdown();
    })();
    // Race the enqueue+shutdown sequence against a bounded timeout. If
    // posthog-node hangs on a slow flush (or the installationId read
    // hangs on the filesystem) we still die in bounded time — the
    // supervisor will restart us, which is the whole point.
    void Promise.race([
      flushSequence,
      new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, FATAL_FLUSH_TIMEOUT_MS);
        handle.unref?.();
      }),
    ]).finally(() => {
      process.exitCode = 1;
      process.exit(1);
    });
  };
  process.on('uncaughtException', (error) => {
    triggerFatalShutdown('daemon_uncaught_exception', {
      error_message: error?.message ?? String(error),
      error_name: error?.name ?? 'Error',
      // Stack truncation: 8 KB ceiling to keep the ingest payload bounded
      // even when the stack contains huge native frames. Most actionable
      // stacks fit in well under 2 KB.
      error_stack: typeof error?.stack === 'string' ? error.stack.slice(0, 8192) : undefined,
    });
  });
  process.on('unhandledRejection', (reason) => {
    const asError = reason instanceof Error ? reason : null;
    triggerFatalShutdown('daemon_unhandled_rejection', {
      error_message: asError?.message ?? (typeof reason === 'string' ? reason : String(reason)),
      error_name: asError?.name ?? 'NonErrorRejection',
      error_stack: typeof asError?.stack === 'string' ? asError.stack.slice(0, 8192) : undefined,
    });
  });

  // Tracks runs whose completion has already been forwarded to Langfuse so
  // repeated message updates only emit one trace per run.
  const reportedRuns = new Set();

  // App-version snapshot read once at server start for Langfuse trace metadata.
  //
  // WP5 (web-first migration): this used to also call
  // `observePendingInstallerApplyAttempts` (from the now-removed
  // `./update-apply-observations.js`) right after the version read, to scan
  // for pending `installer_apply_observation` summary.json files and report
  // whether a desktop installer/updater apply attempt succeeded. The only
  // producer of those files was `apps/desktop/src/main/installer-observations.ts`
  // (removed with the rest of the desktop app), so the scan would only ever
  // find zero pending observations now — it was removed along with its
  // module and test.
  let cachedAppVersion = null;
  void (async () => {
    try {
      cachedAppVersion = await readCurrentAppVersionInfo();
    } catch {
      // Telemetry is best-effort; appVersion is omitted when unavailable.
    }
  })();

  const reportFinalizedMessage = createFinalizedMessageTelemetryReporter({
    design,
    db,
    dataDir: RUNTIME_DATA_DIR,
    reportedRuns,
    getAppVersion: () => cachedAppVersion,
  });

  const reportFeedback = (req: {
    runId: string;
    rating: 'positive' | 'negative';
    reasonCodes: string[];
    hasCustomReason: boolean;
    customReason: string;
    scoreMetadata?: Record<string, unknown>;
  }) =>
    reportRunFeedbackFromDaemon({
      dataDir: RUNTIME_DATA_DIR,
      ...req,
    });

  // DNS-aware wrapper. The sync `validateBaseUrl` only inspects the literal
  // hostname string, so a public DNS name pointing at an internal address
  // (`internal.example.com → 10.0.0.5`) still passes. We delegate to
  // `validateBaseUrlResolved` here so every proxy and finalize handler runs
  // the same resolved-IP check before issuing the upstream request.
  const validateExternalApiBaseUrl = (baseUrl) => validateBaseUrlResolved(baseUrl);

  const resolvedPortRef = {
    get current() {
      return resolvedPort;
    },
  };
  const daemonUrlRef = {
    get current() {
      return daemonUrl;
    },
  };
  const httpDeps = {
    sendApiError,
    sendMulterError,
    sendLiveArtifactRouteError,
    createSseResponse,
    requireLocalDaemonRequest,
    isLocalSameOrigin,
    resolvedPortRef,
  };
  const pathDeps = {
    PROJECT_ROOT,
    PROJECTS_DIR,
    ARTIFACTS_DIR,
    RUNTIME_DATA_DIR,
    RUNTIME_DATA_DIR_CANONICAL,
    DESIGN_SYSTEMS_DIR,
    USER_DESIGN_SYSTEMS_DIR,
    DESIGN_TEMPLATES_DIR,
    USER_DESIGN_TEMPLATES_DIR,
    SKILLS_DIR,
    USER_SKILLS_DIR,
    PROMPT_TEMPLATES_DIR,
    BUNDLED_PETS_DIR,
    OD_BIN,
  };
  const nodeDeps = { fs, path };
  const idDeps = { randomId, randomUUID };
  const uploadDeps = { upload, importUpload, handleProjectUpload };
  const projectStoreDeps = {
    getProject,
    insertProject,
    updateProject,
    dbDeleteProject,
    removeProjectDir,
    validateLinkedDirs,
  };
  const projectFileDeps = {
    ensureProject,
    listFiles,
    searchProjectFiles,
    readProjectFile,
    resolveProjectDir,
    resolveProjectFilePath,
    parseByteRange,
    renameProjectFile,
    deleteProjectFile,
    writeProjectFile,
    sanitizeName,
    listTabs,
    setTabs,
  };
  const conversationDeps = {
    insertConversation,
    getConversation,
    listConversations,
    updateConversation,
    deleteConversation,
    listMessages,
    upsertMessage,
    listPreviewComments,
    upsertPreviewComment,
    updatePreviewCommentStatus,
    deletePreviewComment,
  };
  const templateDeps = { getTemplate, listTemplates, deleteTemplate, insertTemplate, findTemplateByNameAndProject, updateTemplate };
  const projectStatusDeps = {
    listLatestProjectRunStatuses,
    listProjectsAwaitingInput,
    normalizeProjectDisplayStatus,
    composeProjectDisplayStatus,
    listProjects,
  };
  const projectEventDeps = { subscribeFileEvents, activeProjectEventSinks };
  const importDeps = { importClaudeDesignZip, projectDir, detectEntryFile };
  const projectExportDeps = {
    buildProjectArchive,
    buildBatchArchive,
    sanitizeArchiveFilename,
  };
  const artifactDeps = {
    sanitizeSlug,
    lintArtifact,
    renderFindingsForAgent,
    validateArtifactManifestInput,
  };
  const deployDeps = {
    VERCEL_PROVIDER_ID,
    CLOUDFLARE_PAGES_PROVIDER_ID,
    isDeployProviderId,
    publicDeployConfigForProvider,
    readDeployConfig,
    writeDeployConfig,
    listCloudflarePagesZones,
    DeployError,
    listDeployments,
    publicDeployments,
    getDeployment,
    getDeploymentById,
    buildDeployFileSet,
    cloudflarePagesProjectNameForDeploy,
    cloudflarePagesProjectNameFromDeployment,
    checkCloudflarePagesDeploymentLinks,
    checkDeploymentUrl,
    deployToCloudflarePages,
    deployToVercel,
    upsertDeployment,
    publicDeployment,
    cloudflarePagesDeploymentMetadata,
    prepareDeployPreflight,
  };
  const mediaDeps = {
    MEDIA_PROVIDERS,
    IMAGE_MODELS,
    VIDEO_MODELS,
    AUDIO_MODELS_BY_KIND,
    MEDIA_ASPECTS,
    VIDEO_LENGTHS_SEC,
    AUDIO_DURATIONS_SEC,
    readMaskedConfig,
    writeConfig,
    generateMedia,
    mediaTasks,
    createMediaTask: (taskId, projectId, info) => createMediaTask(db, taskId, projectId, info),
    persistMediaTask: (task) => persistMediaTask(db, task),
    appendTaskProgress: (task, line) => appendTaskProgress(db, task, line),
    notifyTaskWaiters: (task) => notifyTaskWaiters(db, task),
    getLiveMediaTask: (taskId) => getLiveMediaTask(db, taskId),
    mediaTaskSnapshot,
    listMediaTasksByProject,
    listElevenLabsVoiceOptions,
  };
  const appConfigDeps = { readAppConfig, writeAppConfig };
  const orbitDeps = { orbitService };
  const nativeDialogDeps = { openNativeFolderDialog };
  const researchDeps = { searchResearch, ResearchError };
  const liveArtifactDeps = {
    createLiveArtifact,
    listLiveArtifacts,
    updateLiveArtifact,
    refreshLiveArtifact,
    emitLiveArtifactEvent,
    emitLiveArtifactRefreshEvent,
    readLiveArtifactCode,
    setLiveArtifactCodeHeaders,
    ensureLiveArtifactPreview,
    setLiveArtifactPreviewHeaders,
    getLiveArtifact,
    listLiveArtifactRefreshLogEntries,
    deleteLiveArtifact,
  };
  const authDeps = {
    authorizeToolRequest,
    requestProjectOverride,
    requestRunOverride,
  };
  const finalizeDeps = {
    defaultBaseUrlForFinalizeProtocol,
    finalizeDesignPackage,
    FinalizePackageLockedError,
    FinalizeUpstreamError,
    isFinalizeProviderProtocol,
    redactSecrets,
  };
  const handoffDeps = {
    synthesizeHandoffPrompt,
    FinalizeUpstreamError,
    TranscriptExportLockedError,
    EmptyTranscriptError,
    redactSecrets,
  };
  const validationDeps = { isSafeId, validateExternalApiBaseUrl, validateBaseUrl, validateProjectDesignSystemId };
  const agentDeps = {
    listProviderModels,
    testProviderConnection,
    testAgentConnection,
    getAgentDef,
    isKnownModel,
    sanitizeCustomModel,
  };
  const critiqueDeps = {
    handleCritiqueArtifact,
    handleCritiqueInterrupt,
    critiqueArtifactsRoot: CRITIQUE_ARTIFACTS_DIR,
    critiqueResponseCapBytes: critiqueCfg.parserMaxBlockBytes,
    critiqueRunRegistry,
  };

  // External services
  registerMcpRoutes(app, {
    http: httpDeps,
    paths: pathDeps,
    mcp: { pendingAuth: mcpPendingAuth, daemonUrlRef },
  });
  // Confluence credential (base URL + PAT) — its own store, independent of
  // the generic external-MCP config above (WP8: JIRA ingest removed, no more
  // mcp-atlassian row to piggyback creds on).
  registerConfluenceConfigRoutes(app, {
    http: httpDeps,
    paths: pathDeps,
  });
  // Figma Personal Access Token — read by the docs-review Screen → Component
  // stage when an App points at Figma links instead of an imported DS.
  registerFigmaConfigRoutes(app, {
    http: httpDeps,
    paths: pathDeps,
  });
  // App-level Figma catalogue (DS tab of an App whose component source is
  // Figma links): read + refresh on demand.
  registerFigmaCatalogRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
  });
  registerFigmaDesignSystemRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
  });
  /** Which component catalogue the docs-review Screen → Component stage
   *  (dr-comp) compares against for a project: the App's setting, overridden
   *  by the App-context manifest the project is pinned to. Shared by the
   *  dr-comp fan-out and the Figma Desktop tool routes so both agree on the
   *  same list of Figma files. */
  const resolveDocsReviewComponentSourceForProject = async (
    projectId: string,
  ): Promise<{ source: DocsReviewComponentSource; appId: string | null }> => {
    const project = getProject(db, projectId);
    const studioConfig = (project?.metadata as Record<string, unknown> | undefined)?.studioConfig as
      | Record<string, unknown>
      | undefined;
    const appId = typeof studioConfig?.appId === 'string' ? studioConfig.appId.trim() : '';
    const pipelineApp = appId ? getPipelineApp(db, appId) : null;
    let source: DocsReviewComponentSource = pipelineApp?.docsReviewComponentSource ?? { mode: 'app-design-system' };
    const contextBinding = featureContextBindingFromMetadata(project?.metadata);
    if (appId && contextBinding?.appId === appId) {
      const boundManifest = await readAppContextManifest(
        PROJECTS_DIR,
        appId,
        contextBinding.contextVersion,
      ).catch(() => null);
      if (boundManifest?.docsReviewComponentSource) {
        source = boundManifest.docsReviewComponentSource;
      }
    }
    return { source, appId: appId || null };
  };
  /** Allow-list for `/api/tools/figma/*`: ONLY the Figma files the App
   *  declared, plus (best-effort) the file name + one known component from
   *  the catalogue the dr-comp preparation phase wrote, which the Desktop
   *  client uses to confirm Figma is showing the right file. `null` when the
   *  project doesn't use Figma links at all. */
  const resolveFigmaDesktopScope = async (projectId: string): Promise<FigmaDesktopScope | null> => {
    const { source } = await resolveDocsReviewComponentSourceForProject(projectId);
    if (source.mode !== 'figma-links' || source.links.length === 0) return null;
    const project = getProject(db, projectId);
    if (!project) return null;
    const projectRoot = resolveProjectDir(PROJECTS_DIR, projectId, project.metadata);
    const wfDir = wfDirForStage('dr-comp', undefined).wfDir;
    const cwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;
    const catalog = await fs.promises
      .readFile(path.join(cwd, '.figma-catalog', 'components.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as { files?: Array<{ fileKey?: string; name?: string; components?: Array<{ nodeId?: string; name?: string }> }> })
      .catch(() => null);
    const files = source.links.map((link) => {
      const known = catalog?.files?.find((file) => file.fileKey === link.fileKey);
      const probe = known?.components?.find((c) => typeof c.nodeId === 'string' && c.nodeId);
      return {
        fileKey: link.fileKey,
        ...(typeof known?.name === 'string' && known.name ? { name: known.name } : {}),
        ...(probe?.nodeId ? { probeNodeId: probe.nodeId } : {}),
        ...(probe?.name ? { probeName: probe.name } : {}),
      };
    });
    return { cwd, files };
  };
  // Figma Desktop drill-down for dr-comp: agents read ONE component's design
  // context/screenshot/variables through the daemon (allow-listed to the
  // App's files, audited), never talking to Figma themselves.
  registerFigmaDesktopToolRoutes(app, {
    auth: authDeps,
    http: httpDeps,
    figma: { desktop: figmaDesktop, resolveScope: resolveFigmaDesktopScope },
  });
  registerXaiRoutes(app, {
    http: httpDeps,
    paths: pathDeps,
  });
  // Project workspace
  registerActiveContextRoutes(app, {
    db,
    http: httpDeps,
    projectStore: projectStoreDeps,
  });
  registerHostToolsRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
    projectStore: projectStoreDeps,
    projectFiles: projectFileDeps,
  });
  registerProjectRoutes(app, {
    db,
    design,
    http: httpDeps,
    paths: pathDeps,
    projectStore: projectStoreDeps,
    projectFiles: projectFileDeps,
    conversations: conversationDeps,
    templates: templateDeps,
    status: projectStatusDeps,
    events: projectEventDeps,
    ids: idDeps,
    telemetry: { reportFinalizedMessage },
    validation: validationDeps,
  });
  registerImportRoutes(app, {
    db,
    http: httpDeps,
    uploads: uploadDeps,
    node: nodeDeps,
    ids: idDeps,
    paths: pathDeps,
    imports: importDeps,
    projectStore: projectStoreDeps,
    conversations: conversationDeps,
    projectFiles: projectFileDeps,
    validation: validationDeps,
  });

  // design-v3 KG sync (pull/push/status)
  // Resource catalog
  registerStaticResourceRoutes(app, {
    http: httpDeps,
    paths: pathDeps,
    resources: {
      listAllSkills,
      listAllDesignTemplates,
      listAllSkillLikeEntries,
      listAllDesignSystems,
      mimeFor,
    },
  });
  registerDesignSystemUpdateRoutes(app, {
    userDesignSystemsDir: USER_DESIGN_SYSTEMS_DIR,
    isLocalSameOrigin,
    resolvedPortRef,
    versionAppContexts: versionAppsUsingDesignSystem,
  });
  registerDesignSystemSyncRoutes(app, {
    db,
    paths: pathDeps,
    http: httpDeps,
  });
  registerProjectArtifactRoutes(app, {
    http: httpDeps,
    uploads: uploadDeps,
    paths: pathDeps,
    node: nodeDeps,
    artifacts: artifactDeps,
  });
  registerLiveArtifactRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
    auth: authDeps,
    liveArtifacts: liveArtifactDeps,
    projectStore: projectStoreDeps,
  });
  registerDesignSystemToolRoutes(app, {
    auth: authDeps,
    http: httpDeps,
    paths: pathDeps,
    projects: { getProject },
  });
  app.use('/artifacts', express.static(ARTIFACTS_DIR));
  registerDeployRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
    ids: idDeps,
    deploy: deployDeps,
    projectStore: projectStoreDeps,
  });
  registerSandboxRoutes(app, {
    http: httpDeps,
    paths: pathDeps,
  });
  registerFinalizeRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
    projectStore: projectStoreDeps,
    validation: validationDeps,
    finalize: finalizeDeps,
  });
  registerHandoffRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
    projectStore: projectStoreDeps,
    conversations: conversationDeps,
    validation: validationDeps,
    handoff: handoffDeps,
  });
  registerDeploymentCheckRoutes(app, { db, http: httpDeps, deploy: deployDeps });
  app.use('/frames', express.static(FRAMES_DIR));
  registerProjectExportRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
    projectStore: projectStoreDeps,
    exports: projectExportDeps,
    projectFiles: projectFileDeps,
    validation: validationDeps,
  });
  registerProjectFileRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
    uploads: uploadDeps,
    node: nodeDeps,
    projectStore: projectStoreDeps,
    projectFiles: projectFileDeps,
    documents: { buildDocumentPreview },
    artifacts: artifactDeps,
  });

  registerMediaRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
    ids: idDeps,
    media: mediaDeps,
    appConfig: appConfigDeps,
    orbit: orbitDeps,
    nativeDialogs: nativeDialogDeps,
    projectStore: projectStoreDeps,
    projectFiles: projectFileDeps,
    conversations: conversationDeps,
    research: researchDeps,
  });

  app.delete('/api/projects/:id', async (req, res) => {
    try {
      dbDeleteProject(db, req.params.id);
      await removeProjectDir(PROJECTS_DIR, req.params.id).catch(() => {});
      /** @type {import('@open-design/contracts').OkResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  // SSE stream of file-changed events for a project. Drives preview live-reload.
  // Receipt of a `file-changed` event triggers a file-list refresh, which
  // propagates new mtimes through to FileViewer iframes (the URL-load
  // `?v=${mtime}` cache-bust from PR #384 then reloads the iframe automatically).
  // Subscribers come and go as users open/close project tabs; the underlying
  // chokidar watcher is refcounted in project-watchers.ts so we never hold
  // descriptors for projects no UI is looking at.
  app.get('/api/projects/:id/events', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    }
    let sub;
    try {
      const sse = createSseResponse(res);
      const projectEventSink = (payload) => {
        sse.send(payload.type, payload);
      };
      let sinks = activeProjectEventSinks.get(req.params.id);
      if (!sinks) {
        sinks = new Set();
        activeProjectEventSinks.set(req.params.id, sinks);
      }
      sinks.add(projectEventSink);
      const watchProject = getProject(db, req.params.id);
      sub = subscribeFileEvents(PROJECTS_DIR, req.params.id, (evt) => {
        sse.send('file-changed', evt);
      }, { metadata: watchProject?.metadata });
      sub.ready.then(() => sse.send('ready', { projectId: req.params.id })).catch(() => {});
      const cleanup = () => {
        if (sub) {
          const { unsubscribe } = sub;
          sub = null;
          Promise.resolve(unsubscribe()).catch(() => {});
        }
        const currentSinks = activeProjectEventSinks.get(req.params.id);
        currentSinks?.delete(projectEventSink);
        if (currentSinks?.size === 0) activeProjectEventSinks.delete(req.params.id);
      };
      res.on('close', cleanup);
      res.on('finish', cleanup);
    } catch (err) {
      if (sub) Promise.resolve(sub.unsubscribe()).catch(() => {});
      if (!res.headersSent) sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  // ---- Conversations --------------------------------------------------------

  app.get('/api/projects/:id/conversations', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    res.json({ conversations: listConversations(db, req.params.id) });
  });

  app.post('/api/projects/:id/conversations', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    const { title } = req.body || {};
    const now = Date.now();
    const conv = insertConversation(db, {
      id: randomId(),
      projectId: req.params.id,
      title: typeof title === 'string' ? title.trim() || null : null,
      createdAt: now,
      updatedAt: now,
    });
    res.json({ conversation: conv });
  });

  app.patch('/api/projects/:id/conversations/:cid', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'not found' });
    }
    const updated = updateConversation(db, req.params.cid, req.body || {});
    res.json({ conversation: updated });
  });

  app.delete('/api/projects/:id/conversations/:cid', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'not found' });
    }
    deleteConversation(db, req.params.cid);
    res.json({ ok: true });
  });

  // ---- Messages -------------------------------------------------------------

  // Synthetic prompts that merely *trigger* a run (pipeline/orbit/routine
  // kickoffs) are written server-side via upsertMessage and carry these id
  // prefixes; genuine typed user prompts get UUID ids. We only collect the
  // latter as feedback.
  const isFeedbackTriggerId = (id: string): boolean =>
    id.startsWith('pipeline-user-') ||
    id.startsWith('orbit-user-') ||
    id.startsWith('routine-user-');

  // Best-effort: ship this install's genuine end-user feedback prompts for a
  // project to the shared media-service store (one `feedback/<installId>.jsonl`
  // per install). Fire-and-forget — must never block a message write or throw
  // into the request. publishFeedback rebuilds the whole file from app.sqlite
  // and uploadFile is content-hash idempotent, so repeat calls are no-ops.
  const publishFeedbackBestEffort = async (projectId: string): Promise<void> => {
    try {
      const cfg = await readAppConfig(RUNTIME_DATA_DIR);
      const user = (cfg.feedbackUsername?.trim() || cfg.installationId || 'unknown') as string;
      const installKey = (cfg.installationId || user) as string;
      await publishFeedback(db, projectId, { user, installKey });
    } catch (err) {
      console.warn('[feedback] publish skipped', (err as Error)?.message ?? err);
    }
  };

  app.get('/api/projects/:id/conversations/:cid/messages', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    res.json({ messages: listMessages(db, req.params.cid) });
  });

  app.put('/api/projects/:id/conversations/:cid/messages/:mid', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    const m = req.body || {};
    if (m.id && m.id !== req.params.mid) {
      return res.status(400).json({ error: 'id mismatch' });
    }
    const saved = upsertMessage(db, req.params.cid, {
      ...m,
      id: req.params.mid,
    });
    // Bump the parent project's updatedAt so the project list re-orders.
    updateProject(db, req.params.id, {});
    // Capture genuine user feedback prompts into the shared store so the
    // cross-user summary-feedback digest can see every install's prompts.
    if (m.role === 'user' && !isFeedbackTriggerId(req.params.mid)) {
      void publishFeedbackBestEffort(req.params.id);
    }
    res.json({ message: saved });
  });

  // Publish this install's latest prompts, then merge every install's feedback
  // for the project into a local `.feedback-merged.jsonl`. CLI mirror of the
  // auto-merge the summary-feedback skill triggers; lets `od feedback pull`
  // refresh the cross-user log on demand.
  app.post('/api/projects/:id/feedback/pull', async (req, res) => {
    const projectId = req.params.id;
    if (!projectId) return sendApiError(res, 400, 'BAD_REQUEST', 'project id required');
    try {
      await publishFeedbackBestEffort(projectId);
      const cwd = await ensureProject(PROJECTS_DIR, projectId);
      const merged = await pullMergedFeedback(projectId, cwd);
      res.json({ ok: true, projectId, files: merged.files, records: merged.records, path: merged.path });
    } catch (err) {
      sendApiError(res, 502, 'FEEDBACK_PULL_FAILED', (err as Error).message);
    }
  });

  // ---- Preview comments ----------------------------------------------------

  app.get('/api/projects/:id/conversations/:cid/comments', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    res.json({
      comments: listPreviewComments(db, req.params.id, req.params.cid),
    });
  });

  app.post('/api/projects/:id/conversations/:cid/comments', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    try {
      const comment = upsertPreviewComment(
        db,
        req.params.id,
        req.params.cid,
        req.body || {},
      );
      updateProject(db, req.params.id, {});
      res.json({ comment });
    } catch (err) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  app.patch(
    '/api/projects/:id/conversations/:cid/comments/:commentId',
    (req, res) => {
      const conv = getConversation(db, req.params.cid);
      if (!conv || conv.projectId !== req.params.id) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      try {
        const comment = updatePreviewCommentStatus(
          db,
          req.params.id,
          req.params.cid,
          req.params.commentId,
          req.body?.status,
        );
        if (!comment)
          return res.status(404).json({ error: 'comment not found' });
        updateProject(db, req.params.id, {});
        res.json({ comment });
      } catch (err) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.delete(
    '/api/projects/:id/conversations/:cid/comments/:commentId',
    (req, res) => {
      const conv = getConversation(db, req.params.cid);
      if (!conv || conv.projectId !== req.params.id) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      const ok = deletePreviewComment(
        db,
        req.params.id,
        req.params.cid,
        req.params.commentId,
      );
      if (!ok) return res.status(404).json({ error: 'comment not found' });
      updateProject(db, req.params.id, {});
      res.json({ ok: true });
    },
  );

  // ---- Tabs -----------------------------------------------------------------

  app.get('/api/projects/:id/tabs', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    res.json(listTabs(db, req.params.id));
  });

  app.put('/api/projects/:id/tabs', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    const { tabs = [], active = null } = req.body || {};
    if (!Array.isArray(tabs) || !tabs.every((t) => typeof t === 'string')) {
      return res.status(400).json({ error: 'tabs must be string[]' });
    }
    const result = setTabs(
      db,
      req.params.id,
      tabs,
      typeof active === 'string' ? active : null,
    );
    res.json(result);
  });

  // ---- Templates ----------------------------------------------------------
  // User-saved snapshots of a project's HTML files. Surfaced in the
  // "From template" tab of the new-project panel so a user can spin up
  // a fresh project pre-seeded with another project's design as a
  // starting point. Created via the project's Share menu (snapshots
  // every .html file in the project folder at the moment of save).

  app.get('/api/templates', (_req, res) => {
    res.json({ templates: listTemplates(db) });
  });

  app.get('/api/templates/:id', (req, res) => {
    const t = getTemplate(db, req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json({ template: t });
  });

  app.post('/api/templates', async (req, res) => {
    try {
      const { name, description, sourceProjectId } = req.body || {};
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name required' });
      }
      if (typeof sourceProjectId !== 'string') {
        return res.status(400).json({ error: 'sourceProjectId required' });
      }
      const sourceProject = getProject(db, sourceProjectId);
      if (!sourceProject) {
        return res.status(404).json({ error: 'source project not found' });
      }
      // Snapshot every HTML / sketch / text file in the source project.
      // We deliberately skip binary uploads — templates are about the
      // generated design, not the user's reference imagery.
      const files = await listFiles(PROJECTS_DIR, sourceProjectId, {
        metadata: sourceProject.metadata,
      });
      const snapshot = [];
      for (const f of files) {
        if (f.kind !== 'html' && f.kind !== 'text' && f.kind !== 'code')
          continue;
        const entry = await readProjectFile(
          PROJECTS_DIR,
          sourceProjectId,
          f.name,
          sourceProject.metadata,
        );
        if (entry && Buffer.isBuffer(entry.buffer)) {
          snapshot.push({
            name: f.name,
            content: entry.buffer.toString('utf8'),
          });
        }
      }
      const t = insertTemplate(db, {
        id: randomId(),
        name: name.trim(),
        description: typeof description === 'string' ? description : null,
        sourceProjectId,
        files: snapshot,
        createdAt: Date.now(),
      });
      res.json({ template: t });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.delete('/api/templates/:id', (req, res) => {
    deleteTemplate(db, req.params.id);
    res.json({ ok: true });
  });

  const sandboxRuntimeImage = () => {
    try {
      return sandboxImageTag(path.join(SKILLS_DIR, 'ui-react', 'builder'));
    } catch {
      return 'od-agent-sandbox:unknown';
    }
  };

  // Runtime-aware sandbox fallback. The resolver is config-only; this helper
  // adds the Docker/image/auth-volume readiness check so a missing volume does
  // not get picked as a usable runtime.
  const sandboxFallbackRuntimeId = async (): Promise<'claude' | 'codex' | null> => {
    try {
      const config = await readAppConfig(RUNTIME_DATA_DIR);
      const cfg = resolveSandboxConfig(config.sandbox, process.env);
      if (!resolveSandboxFallbackRuntimeId(cfg)) return null;
      const image = sandboxRuntimeImage();
      if (!(await dockerAvailable())) return null;
      if (!(await dockerImagePresent(image))) return null;
      if (sandboxRuntimeIsGated(cfg, 'claude') && (await dockerVolumePresent(sandboxAuthVolume('claude')))) {
        return 'claude';
      }
      if (sandboxRuntimeIsGated(cfg, 'codex') && (await dockerVolumePresent(sandboxAuthVolume('codex')))) {
        return 'codex';
      }
      return null;
    } catch {
      return null;
    }
  };

  // Sandbox-side availability, cached: the version probe starts short-lived
  // containers, too slow to run on every /api/agents poll.
  let sandboxStatusCache: { image: string; at: number; statuses: Awaited<ReturnType<typeof buildSandboxRuntimeStatuses>> } | null = null;
  const cachedSandboxRuntimeStatuses = async (image: string, probeAuth: boolean) => {
    if (
      sandboxStatusCache &&
      sandboxStatusCache.image === image &&
      sandboxStatusCache.at + 60_000 > Date.now() &&
      sandboxStatusCache.statuses.length > 0 &&
      sandboxStatusCache.statuses[0]?.loginMethod &&
      (sandboxStatusCache as { probeAuth?: boolean }).probeAuth === probeAuth
    ) {
      return sandboxStatusCache.statuses;
    }
    const statuses = await buildSandboxRuntimeStatuses(image, probeAuth, await dockerAvailable());
    sandboxStatusCache = { image, at: Date.now(), statuses, probeAuth } as typeof sandboxStatusCache & { probeAuth: boolean };
    return statuses;
  };

  // /api/agents probes EVERY registered CLI (19 today: PATH scans, then
  // `--version` / `--help` / model / auth probes for the installed ones).
  // Many surfaces call it independently (agent picker, InfraSetupGate,
  // login pollers, Settings) and on Windows each spawn is 5-10x dearer, so
  // answer from a short cache and coalesce concurrent callers onto one
  // probe. `?fresh=1` (explicit "Quét lại" / agentCliEnv change) bypasses.
  const AGENTS_CACHE_TTL_MS = 8_000;
  let agentsPayloadCache: { at: number; payload: unknown } | null = null;
  let agentsPayloadInflight: Promise<unknown> | null = null;
  const buildAgentsPayload = async (): Promise<unknown> => {
      const config = await readAppConfig(RUNTIME_DATA_DIR);
      const sandboxCfg = resolveSandboxConfig(config.sandbox, process.env);
      // Docker-only (sandbox owns Claude): the sandbox is the ONLY runtime
      // source. Do NOT scan the host at all (skip probing EVERY runtime — no
      // host codex/gemini/claude touched), and surface just the sandbox-owned
      // runtime(s). Availability there is the SANDBOX's (docker + image + auth
      // volume), never a host binary.
      const dockerOnly = sandboxCfg.enabled && sandboxCfg.skills.includes('*');
      const list = await detectAgents(
        config.agentCliEnv ?? {},
        dockerOnly ? ['*'] : sandboxSkipProbe(config),
      );
      if (dockerOnly) {
        const image = sandboxRuntimeImage();
        const runtimeStatuses = await cachedSandboxRuntimeStatuses(image, true);
        const statusById = new Map(runtimeStatuses.map((status) => [status.id, status]));
        for (const agent of list) {
          if (!sandboxCfg.runtimes.includes('*') && !sandboxCfg.runtimes.includes(agent.id)) continue;
          const status = statusById.get(agent.id as 'claude' | 'codex');
          if (!status) continue;
          // `available` means the CLI runtime can be launched. Authentication
          // is reported separately so Settings can still list Codex and let
          // the user complete device login instead of hiding it beforehand.
          const ok = status.imageAvailable;
          agent.sandbox = {
            owns: true,
            dockerRunning: status.imageAvailable,
            imagePresent: status.imageAvailable,
            authLoggedIn: status.authStatus === 'logged-in',
            version: status.version,
          };
          agent.available = ok;
          if (status.version) agent.version = status.version;
          agent.authStatus =
            status.authStatus === 'logged-in'
              ? 'ok'
              : status.authStatus === 'missing'
                ? 'missing'
                : 'unknown';
          if (!ok) {
            const runtimeLabel = agent.id === 'codex' ? 'Codex' : 'Claude';
            agent.authMessage = !status.imageAvailable
              ? `Thiếu image sandbox ${image} — build bằng: od sandbox build`
              : !status.authVolumeAvailable
                ? `Sandbox chưa có volume auth cho ${runtimeLabel} — chạy: od sandbox ${agent.id === 'codex' ? 'login --runtime codex' : 'login'}`
                : runtimeLabel === 'Codex'
                  ? 'Sandbox chưa đăng nhập Codex — chạy: od sandbox login --runtime codex'
                  : 'Sandbox chưa đăng nhập Claude — chạy: od sandbox login';
          }
        }
        // Hide host CLIs entirely: only the sandbox-owned runtime(s) remain in a
        // Docker-only install, so the picker/rescan shows just the active sandbox
        // runtime(s).
        const owned = (id: string) => sandboxCfg.runtimes.includes('*') || sandboxCfg.runtimes.includes(id);
        return { agents: list.filter((a) => owned(a.id)) };
      }
      return { agents: list };
  };
  app.get('/api/agents', async (req, res) => {
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
    try {
      if (!fresh && agentsPayloadCache && Date.now() - agentsPayloadCache.at < AGENTS_CACHE_TTL_MS) {
        res.json(agentsPayloadCache.payload);
        return;
      }
      if (!agentsPayloadInflight) {
        agentsPayloadInflight = buildAgentsPayload()
          .then((payload) => {
            agentsPayloadCache = { at: Date.now(), payload };
            return payload;
          })
          .finally(() => {
            agentsPayloadInflight = null;
          });
      }
      res.json(await agentsPayloadInflight);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/skills', async (_req, res) => {
    try {
      const skills = await listAllSkills();
      // Strip full body + on-disk dir from the listing — frontend fetches the
      // body via /api/skills/:id when needed (keeps the listing payload small).
      res.json({
        skills: skills.map(({ body, dir: _dir, ...rest }) => ({
          ...rest,
          hasBody: typeof body === 'string' && body.length > 0,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/skills/:id', async (req, res) => {
    try {
      const skills = await listAllSkills();
      const skill = findSkillById(skills, req.params.id);
      if (!skill) return res.status(404).json({ error: 'skill not found' });
      const { dir: _dir, ...serializable } = skill;
      res.json(serializable);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Codex hatch-pet registry — pets packaged by the upstream `hatch-pet`
  // skill under `${CODEX_HOME:-$HOME/.codex}/pets/`. Surfaced so the web
  // pet settings can offer one-click adoption of recently-hatched pets.
  app.get('/api/codex-pets', async (_req, res) => {
    try {
      const result = await listCodexPets({
        baseUrl: '',
        bundledRoot: BUNDLED_PETS_DIR,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // One-click community sync. Hits the Codex Pet Share + j20 Hatchery
  // catalogs and drops every pet into `${CODEX_HOME:-$HOME/.codex}/pets/`
  // so `GET /api/codex-pets` (and the web Pet settings) pick them up
  // immediately. The body is intentionally tiny — we keep the heavier
  // tuning knobs (`--limit`, `--concurrency`) on the CLI script and
  // only surface `force` + `source` here.
  app.post('/api/codex-pets/sync', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const sourceRaw = typeof body.source === 'string' ? body.source : 'all';
      const source =
        sourceRaw === 'petshare' || sourceRaw === 'hatchery'
          ? sourceRaw
          : 'all';
      const result = await syncCommunityPets({
        source,
        force: Boolean(body.force),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String((err && err.message) || err) });
    }
  });

  app.get('/api/codex-pets/:id/spritesheet', async (req, res) => {
    try {
      const sheet = await readCodexPetSpritesheet(req.params.id, {
        bundledRoot: BUNDLED_PETS_DIR,
      });
      if (!sheet) {
        return res
          .status(404)
          .type('text/plain')
          .send('codex pet spritesheet not found');
      }
      const mime =
        sheet.ext === 'webp'
          ? 'image/webp'
          : sheet.ext === 'gif'
            ? 'image/gif'
            : 'image/png';
      res.type(mime);
      // Same-origin callers (the web app proxies `/api/*` through to
      // the daemon, so PetSettings adoption fetches arrive same-origin)
      // do not need any CORS header here. We only echo
      // `Access-Control-Allow-Origin` for sandboxed iframes / data:
      // URIs (Origin: null) which need it to draw the bytes onto a
      // canvas without tainting. Local pet bytes should not be exposed
      // to arbitrary third-party origins via a wildcard ACAO.
      if (req.headers.origin === 'null') {
        res.setHeader('Access-Control-Allow-Origin', 'null');
      }
      res.setHeader('Cache-Control', 'no-store');
      const buf = await fs.promises.readFile(sheet.absPath);
      res.send(buf);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  app.get('/api/design-systems', async (_req, res) => {
    try {
      const systems = await listAllDesignSystems();
      res.json({
        designSystems: systems.map(({ body, ...rest }) => rest),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/design-systems', async (req, res) => {
    try {
      const created = await createUserDesignSystem(USER_DESIGN_SYSTEMS_DIR, req.body || {});
      res.status(201).json({ ...created, designSystem: created });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/api/design-systems/generation-jobs', async (req, res) => {
    try {
      const job = designSystemGenerationJobs.start(req.body || {});
      res.status(202).json({ job });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/generation-jobs/:jobId', async (req, res) => {
    try {
      const job = designSystemGenerationJobs.get(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: 'design system generation job not found' });
      }
      res.json({ job });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Bộ tiêu chí review của Design System (`<ds>/criteria/`) ───────────────
  //
  // `components.md` = DANH MỤC component hợp lệ, sinh bằng AGENT đọc chính DS.
  // `rules.md` = quy tắc UX, KHÔNG sinh — người dùng nạp kèm lúc import (một
  // file .md thả chung với zip, xem figma-ds-import.ts). Quy tắc "form dài thì
  // dùng Drawer" là quyết định sản phẩm, không nằm trong export Figma; bắt agent
  // suy ra thì nó bịa, và `dr-review` sẽ lấy chính rule bịa đó làm căn cứ buộc
  // tội tài liệu sai.
  //
  // Vì sao KHÔNG dùng `designSystemGenerationJobs` ở trên: store đó chạy step
  // giả lập theo `delayMs` để dựng DRAFT, nó không spawn agent bao giờ. Việc ở
  // đây là đọc `react/docs/catalog.md` (hàng nghìn dòng, hàng trăm component)
  // rồi LỌC / GOM NHÓM / DIỄN GIẢI — phán đoán, không phải biến đổi cơ học.
  // Luồng sinh rules là opt-in, chỉ chạy khi người dùng chủ động bấm.
  //
  // cwd của agent là chính thư mục DS, có được nhờ một project row ẩn mang
  // `metadata.baseDir` — `startChatRun` đọc đúng field đó để chọn cwd. Một row
  // dùng lại cho mọi lần sinh của cùng một DS.
  type DsCriteriaJob = CriteriaGenerationJob & {
    /** Run của agent, có mặt từ lúc bước `generate` khởi động. UI mở
     *  `GET /api/runs/<runId>/events` để xem log agent chạy trực tiếp — job này
     *  KHÔNG tự tích luỹ log: stream đã có sẵn và một bản sao trong RAM chỉ tổ
     *  phình theo mỗi lần sinh mà không ai đọc lại. */
    runId: string;
    /** Hội thoại chứa transcript của run, và project ẩn sở hữu nó. Đủ để UI mở
     *  thẳng màn chat (`navigate({kind:'project', projectId, conversationId})`)
     *  — người dùng xem agent chạy tới đâu bằng chính giao diện chat quen thuộc,
     *  không cần một khung log riêng dựng lại từ đầu. */
    conversationId: string;
    projectId: string;
  };
  const dsCriteriaJobs = new Map<string, DsCriteriaJob>();
  /** designSystemId → id của job GẦN NHẤT. GET /criteria trả job này, nên UI
   *  vẫn thấy được lý do thất bại sau khi tải lại trang. */
  const dsCriteriaJobByDs = new Map<string, string>();

  const resolveCriteriaAgent = async () => {
    const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
    let agentId = typeof appConfig.agentId === 'string' && appConfig.agentId ? appConfig.agentId : null;
    if (!agentId) {
      const agents = await detectAgents(appConfig.agentCliEnv ?? {}, sandboxSkipProbe(appConfig)).catch(() => []);
      agentId = agents.find((agent) => agent.available)?.id ?? null;
    }
    if (!agentId) agentId = await sandboxFallbackRuntimeId();
    if (!agentId) throw new Error('Chưa cấu hình agent nào khả dụng — chọn agent trong Cài đặt trước.');
    return { agentId, modelPrefs: appConfig.agentModels?.[agentId] ?? {} };
  };

  const startDsCriteriaJob = (
    designSystemId: string,
    dsDir: string,
    execution: Awaited<ReturnType<typeof resolveCriteriaAgent>>,
  ): DsCriteriaJob => {
    const now = () => new Date().toISOString();
    const projectId = `ds-criteria-${designSystemId.replace(/^user:/, '')}`;
    const rowNow = Date.now();
    const existingProject = getProject(db, projectId);
    if (!existingProject) {
      insertProject(db, {
        id: projectId,
        name: `Bộ tiêu chí · ${designSystemId}`,
        skillId: null,
        designSystemId: null,
        pendingPrompt: null,
        metadata: { kind: 'ds-criteria', baseDir: dsDir, designSystemId },
        createdAt: rowNow,
        updatedAt: rowNow,
      });
    } else {
      updateProject(db, projectId, {
        metadata: { ...(existingProject.metadata ?? {}), kind: 'ds-criteria', baseDir: dsDir, designSystemId },
      });
    }
    const conversationId = `ds-criteria-conv-${randomUUID()}`;
    insertConversation(db, {
      id: conversationId,
      projectId,
      title: `Sinh danh mục component · ${new Date(rowNow).toLocaleString('vi-VN')}`,
      createdAt: rowNow,
      updatedAt: rowNow,
    });
    const assistantMessageId = `ds-criteria-assistant-${randomUUID()}`;
    const kickoff =
      `Áp skill "ds-criteria-extract" cho design system "${designSystemId}". ` +
      `cwd của bạn LÀ thư mục DS: đọc "react/docs/catalog.md" (nguồn chính), "react/STYLE-GUIDE.md" và "DESIGN.md". ` +
      `Ghi kết quả ra ĐÚNG MỘT file: "criteria/components.md.next". ` +
      `TUYỆT ĐỐI KHÔNG ghi đè "criteria/components.md" — daemon validate bản nháp trước khi người dùng duyệt. ` +
      `KHÔNG đụng "criteria/rules.md" và không sửa bất cứ thứ gì trong "react/" hay "ir/".`;
    const run = design.runs.create({
      projectId,
      conversationId,
      assistantMessageId,
      clientRequestId: `ds-criteria-${randomUUID()}`,
      agentId: execution.agentId,
    });
    const job: DsCriteriaJob = {
      id: randomUUID(),
      designSystemId,
      kind: 'components',
      status: 'queued',
      message: 'Đã xếp hàng',
      error: null,
      steps: [
        { id: 'read-catalog', title: 'Đọc catalog của DS', status: 'pending' },
        { id: 'generate', title: 'Agent sinh danh mục component', status: 'pending' },
        { id: 'validate', title: 'Kiểm tra bản nháp components.md', status: 'pending' },
      ],
      createdAt: now(),
      updatedAt: now(),
      workspace: { projectId, conversationId, runId: run.id },
      projectId,
      conversationId,
      runId: run.id,
      notes: [],
    };
    dsCriteriaJobs.set(job.id, job);
    dsCriteriaJobByDs.set(designSystemId, job.id);
    const step = (id: string) => job.steps.find((s) => s.id === id)!;
    const touch = () => {
      job.updatedAt = now();
    };
    const note = (line: string) => {
      job.notes.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
      touch();
    };

    void (async () => {
      job.status = 'running';
      touch();
      try {
        step('read-catalog').status = 'running';
        touch();
        const catalogRel = 'react/docs/catalog.md';
        const catalogAbs = path.join(dsDir, catalogRel);
        if (!(await fs.promises.stat(catalogAbs).then((s) => s.isFile()).catch(() => false))) {
          throw new Error(
            `DS này không có "${catalogRel}" — chỉ design system nạp từ Figma IR mới có catalog để sinh danh mục.`,
          );
        }
        const catalogBytes = (await fs.promises.stat(catalogAbs)).size;
        step('read-catalog').status = 'succeeded';
        note(`Catalog: ${catalogRel} (${Math.round(catalogBytes / 1024)} KB)`);
        touch();

        step('generate').status = 'running';
        job.message = 'Agent đang đọc catalog…';
        touch();

        note(`Agent "${execution.agentId}" khởi động (run ${run.id.slice(0, 8)})`);
        // KHÔNG đăng ký vào `activeRuns`: cái Set đó là sổ hủy CỦA MỘT LƯỢT
        // CHẠY PIPELINE (khai bên trong runner, xem `registerPipelineCanceler`)
        // — nó không tồn tại ở phạm vi này. Job sinh danh mục cũng không có nút
        // Hủy nào để phục vụ.
        upsertMessage(db, conversationId, { id: `ds-criteria-user-${run.id}`, role: 'user', content: kickoff });
        upsertMessage(db, conversationId, {
          id: assistantMessageId,
          role: 'assistant',
          content: '',
          agentId: execution.agentId,
          agentName: getAgentDef(execution.agentId)?.name ?? execution.agentId,
          runId: run.id,
          runStatus: 'queued',
          startedAt: Date.now(),
        });
        design.runs.start(run, () =>
          startChatRun(
            {
              agentId: execution.agentId,
              projectId,
              conversationId,
              assistantMessageId,
              clientRequestId: run.clientRequestId,
              skillId: 'ds-criteria-extract',
              model: execution.modelPrefs.model ?? null,
              reasoning: execution.modelPrefs.reasoning ?? null,
              message: kickoff,
              systemPrompt:
                'Bạn đang chạy một job không có người ngồi cạnh. Không hỏi lại, không chờ input — chọn mặc định hợp lý và hoàn thành.',
            },
            run,
          ),
        );
        const final = await design.runs.wait(run);
        db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`).run(final.status, Date.now(), assistantMessageId);
        if (final.status !== 'succeeded') {
          throw new Error(`Agent kết thúc với trạng thái "${final.status}".`);
        }
        step('generate').status = 'succeeded';
        note('Agent xong, đang kiểm tra kết quả');
        touch();

        step('validate').status = 'running';
        touch();
        const committed = await validateGeneratedComponentsMdDraft(dsDir);
        if (!committed.ok) {
          step('validate').status = 'failed';
          step('validate').message = committed.errors.join('; ');
          throw new Error(committed.errors.join('; '));
        }
        step('validate').status = 'succeeded';
        job.status = 'succeeded';
        job.message = `${committed.components} component chờ duyệt`;
        note(`Đã tạo bản nháp criteria/components.md — ${committed.components} component, chờ duyệt`);
        const liveDsDir = await dsDirForId(designSystemId);
        if (liveDsDir) await markDesignSystemCriteriaDraft(liveDsDir, designSystemId, 'components');
        touch();
      } catch (error) {
        const detail = String((error as Error)?.message ?? error);
        note(`LỖI: ${detail}`);
        const active = job.steps.find((s) => s.status === 'running');
        if (active) {
          active.status = 'failed';
          active.message = active.message ?? detail;
        }
        job.status = 'failed';
        job.message = detail;
        job.error = detail;
        touch();
        console.warn(`[ds-criteria] sinh danh mục cho "${designSystemId}" thất bại:`, detail);
      }
    })();

    return job;
  };

  // Sinh (hoặc sinh lại) `criteria/components.md` của một DS.
  app.post('/api/design-systems/:id/criteria/generate', async (req, res) => {
    try {
      const id = req.params.id;
      const liveDsDir = await dsDirForId(id);
      if (!liveDsDir) return res.status(404).json({ error: `design system not found: ${id}` });
      const dsDir = await designSystemCriteriaWorkDir(liveDsDir, id);
      const existingId = dsCriteriaJobByDs.get(id);
      const existing = existingId ? dsCriteriaJobs.get(existingId) : undefined;
      if (existing && (existing.status === 'queued' || existing.status === 'running')) {
        return res.status(202).json({ jobId: existing.id, job: existing });
      }
      const execution = await resolveCriteriaAgent();
      const racedId = dsCriteriaJobByDs.get(id);
      const raced = racedId ? dsCriteriaJobs.get(racedId) : undefined;
      if (raced && (raced.status === 'queued' || raced.status === 'running')) {
        return res.status(202).json({ jobId: raced.id, job: raced });
      }
      const job = startDsCriteriaJob(id, dsDir, execution);
      res.status(202).json({ jobId: job.id, job });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Trạng thái bộ tiêu chí + job gần nhất. UI poll route này.
  app.get('/api/design-systems/:id/criteria', async (req, res) => {
    try {
      const id = req.params.id;
      const dsDir = await dsDirForId(id);
      if (!dsDir) return res.status(404).json({ error: `design system not found: ${id}` });
      const state = await readDsCriteriaState(dsDir);
      const jobId = dsCriteriaJobByDs.get(id);
      const job = jobId ? (dsCriteriaJobs.get(jobId) ?? null) : null;
      res.json({ ...state, job });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });


  const dsRulesJobs = new Map<string, DsCriteriaJob>();
  const dsRulesJobByDs = new Map<string, string>();
  const startDsRulesJob = (
    designSystemId: string,
    dsDir: string,
    execution: Awaited<ReturnType<typeof resolveCriteriaAgent>>,
  ): DsCriteriaJob => {
    const now = () => new Date().toISOString();
    const projectId = `ds-rules-${designSystemId.replace(/^user:/, '')}`;
    const rowNow = Date.now();
    const existingProject = getProject(db, projectId);
    if (!existingProject) {
      insertProject(db, {
        id: projectId,
        name: `Quy tắc review · ${designSystemId}`,
        skillId: null,
        designSystemId: null,
        pendingPrompt: null,
        metadata: { kind: 'ds-rules', baseDir: dsDir, designSystemId },
        createdAt: rowNow,
        updatedAt: rowNow,
      });
    } else {
      updateProject(db, projectId, {
        metadata: { ...(existingProject.metadata ?? {}), kind: 'ds-rules', baseDir: dsDir, designSystemId },
      });
    }
    const conversationId = `ds-rules-conv-${randomUUID()}`;
    insertConversation(db, {
      id: conversationId,
      projectId,
      title: `Sinh quy tắc · ${new Date(rowNow).toLocaleString('vi-VN')}`,
      createdAt: rowNow,
      updatedAt: rowNow,
    });
    const assistantMessageId = `ds-rules-assistant-${randomUUID()}`;
    const kickoff = `Áp skill "ds-rules-extract" cho design system "${designSystemId}". cwd của bạn LÀ thư mục DS. Đọc "react/showcase/index.html" nếu có, "preview/*.html", "react/STYLE-GUIDE.md", "react/docs/catalog.md", "DESIGN.md". KHÔNG đọc "react/showcase/showcase-data.js". Ghi đúng một file "criteria/rules.md.next", không ghi đè "criteria/rules.md", không tạo "_meta.json" hay file khác, không đụng "react/" hay "ir/".`;
    const run = design.runs.create({
      projectId,
      conversationId,
      assistantMessageId,
      clientRequestId: `ds-rules-${randomUUID()}`,
      agentId: execution.agentId,
    });
    const job: DsCriteriaJob = {
      id: randomUUID(), designSystemId, kind: 'rules', status: 'queued', message: 'Đã xếp hàng', error: null,
      steps: [
        { id: 'read-showcase', title: 'Đọc showcase của DS', status: 'pending' },
        { id: 'generate', title: 'Agent sinh quy tắc', status: 'pending' },
        { id: 'validate', title: 'Kiểm tra bản nháp rules.md', status: 'pending' },
      ], createdAt: now(), updatedAt: now(),
      workspace: { projectId, conversationId, runId: run.id },
      projectId, conversationId, runId: run.id, notes: [],
    };
    dsRulesJobs.set(job.id, job); dsRulesJobByDs.set(designSystemId, job.id);
    const step = (id: string) => job.steps.find((item) => item.id === id)!;
    const touch = () => { job.updatedAt = now(); };
    const note = (line: string) => { job.notes.push(`${new Date().toISOString().slice(11, 19)} ${line}`); touch(); };
    void (async () => {
      job.status = 'running'; touch();
      try {
        step('read-showcase').status = 'running'; touch();
        const showcase = path.join(dsDir, 'react/showcase/index.html');
        const previewDir = path.join(dsDir, 'preview');
        const hasShowcase = await fs.promises.stat(showcase).then((item) => item.isFile()).catch(() => false);
        const previews = await fs.promises.readdir(previewDir).catch(() => []);
        const hasPreview = previews.some((name) => name.endsWith('.html'));
        if (!hasShowcase && !hasPreview) throw new Error('DS này chưa có showcase/preview để rút quy tắc');
        step('read-showcase').status = 'succeeded'; note(`Nguồn showcase: ${hasShowcase ? 'react/showcase/index.html' : 'preview/*.html'}`);

        step('generate').status = 'running'; job.message = 'Agent đang đọc showcase…'; touch();
        note(`Agent "${execution.agentId}" khởi động (run ${run.id.slice(0, 8)})`);
        upsertMessage(db, conversationId, { id: `ds-rules-user-${run.id}`, role: 'user', content: kickoff });
        upsertMessage(db, conversationId, { id: assistantMessageId, role: 'assistant', content: '', agentId: execution.agentId, agentName: getAgentDef(execution.agentId)?.name ?? execution.agentId, runId: run.id, runStatus: 'queued', startedAt: Date.now() });
        design.runs.start(run, () => startChatRun({ agentId: execution.agentId, projectId, conversationId, assistantMessageId, clientRequestId: run.clientRequestId, skillId: 'ds-rules-extract', model: execution.modelPrefs.model ?? null, reasoning: execution.modelPrefs.reasoning ?? null, message: kickoff, systemPrompt: 'Bạn đang chạy một job không có người ngồi cạnh. Không hỏi lại, không chờ input — chọn mặc định hợp lý và hoàn thành.' }, run));
        const final = await design.runs.wait(run);
        db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`).run(final.status, Date.now(), assistantMessageId);
        if (final.status !== 'succeeded') throw new Error(`Agent kết thúc với trạng thái "${final.status}".`);
        step('generate').status = 'succeeded'; note('Agent xong, đang kiểm tra kết quả');
        step('validate').status = 'running'; touch();
        const committed = await validateGeneratedRulesMdDraft(dsDir);
        if (!committed.ok) { step('validate').status = 'failed'; step('validate').message = committed.errors.join('; '); throw new Error(committed.errors.join('; ')); }
        step('validate').status = 'succeeded'; job.status = 'succeeded'; job.message = `${committed.rules} quy tắc chờ duyệt`; note(`Đã tạo bản nháp criteria/rules.md — ${committed.rules} quy tắc, chờ duyệt`); const liveDsDir = await dsDirForId(designSystemId); if (liveDsDir) await markDesignSystemCriteriaDraft(liveDsDir, designSystemId, 'rules'); touch();
      } catch (error) {
        const detail = String((error as Error)?.message ?? error); note(`LỖI: ${detail}`);
        const active = job.steps.find((item) => item.status === 'running'); if (active) { active.status = 'failed'; active.message = active.message ?? detail; }
        job.status = 'failed'; job.message = detail; job.error = detail; touch(); console.warn(`[ds-rules] sinh quy tắc cho "${designSystemId}" thất bại:`, detail);
      }
    })();
    return job;
  };

  app.post('/api/design-systems/:id/rules/generate', async (req, res) => {
    try {
      const id = req.params.id; const liveDsDir = await dsDirForId(id);
      if (!liveDsDir) return res.status(404).json({ error: `design system not found: ${id}` });
      const dsDir = await designSystemCriteriaWorkDir(liveDsDir, id);
      const existingId = dsRulesJobByDs.get(id); const existing = existingId ? dsRulesJobs.get(existingId) : undefined;
      if (existing && (existing.status === 'queued' || existing.status === 'running')) return res.status(202).json({ jobId: existing.id, job: existing });
      const execution = await resolveCriteriaAgent();
      const racedId = dsRulesJobByDs.get(id); const raced = racedId ? dsRulesJobs.get(racedId) : undefined;
      if (raced && (raced.status === 'queued' || raced.status === 'running')) return res.status(202).json({ jobId: raced.id, job: raced });
      const job = startDsRulesJob(id, dsDir, execution); res.status(202).json({ jobId: job.id, job });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.get('/api/design-systems/:id/rules', async (req, res) => {
    try {
      const id = req.params.id; const dsDir = await dsDirForId(id);
      if (!dsDir) return res.status(404).json({ error: `design system not found: ${id}` });
      const state = await readDsCriteriaState(dsDir); const jobId = dsRulesJobByDs.get(id);
      const job = jobId ? (dsRulesJobs.get(jobId) ?? null) : null;
      res.json({ hasRules: state.hasRules, rules: state.rules, job });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  const criteriaJobFor = (designSystemId: string, kind: CriteriaGenerationKind): DsCriteriaJob | null => {
    const byDs = kind === 'components' ? dsCriteriaJobByDs : dsRulesJobByDs;
    const jobs = kind === 'components' ? dsCriteriaJobs : dsRulesJobs;
    const jobId = byDs.get(designSystemId);
    return jobId ? (jobs.get(jobId) ?? null) : null;
  };
  const startCriteriaJob = async (designSystemId: string, kind: CriteriaGenerationKind) => {
    const existing = criteriaJobFor(designSystemId, kind);
    if (isCriteriaGenerationJobActive(existing)) {
      return { job: existing, reused: true };
    }
    const liveDsDir = await dsDirForId(designSystemId);
    if (!liveDsDir) throw new Error(`design system not found: ${designSystemId}`);
    const workDir = await designSystemCriteriaWorkDir(liveDsDir, designSystemId);
    const execution = await resolveCriteriaAgent();
    // Agent discovery can yield; close the small race before creating a run.
    const raced = criteriaJobFor(designSystemId, kind);
    if (isCriteriaGenerationJobActive(raced)) {
      return { job: raced, reused: true };
    }
    const job = kind === 'components'
      ? startDsCriteriaJob(designSystemId, workDir, execution)
      : startDsRulesJob(designSystemId, workDir, execution);
    return { job, reused: false };
  };
  registerDesignSystemCriteriaWorkspaceRoutes(app, {
    resolveDesignSystemDir: dsDirForId,
    getJob: criteriaJobFor,
    startJob: startCriteriaJob,
  });

  app.post('/api/design-systems/:id/revision-jobs', async (req, res) => {
    try {
      const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback : '';
      if (!feedback.trim()) return res.status(400).json({ error: 'feedback is required' });
      const job = designSystemGenerationJobs.revise({
        designSystemId: req.params.id,
        feedback,
        sectionTitle: typeof req.body?.sectionTitle === 'string' ? req.body.sectionTitle : undefined,
        body: typeof req.body?.body === 'string' ? req.body.body : undefined,
      });
      res.status(202).json({ job });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id/revisions', async (req, res) => {
    try {
      const revisions = await listUserDesignSystemRevisions(
        USER_DESIGN_SYSTEMS_DIR,
        req.params.id,
      );
      if (!revisions) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.json({ revisions });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.patch('/api/design-systems/:id/revisions/:revisionId', async (req, res) => {
    try {
      const status = typeof req.body?.status === 'string' ? req.body.status : '';
      if (status !== 'accepted' && status !== 'rejected') {
        return res.status(400).json({ error: 'status must be accepted or rejected' });
      }
      const revision = await updateUserDesignSystemRevisionStatus(
        USER_DESIGN_SYSTEMS_DIR,
        req.params.id,
        req.params.revisionId,
        status,
      );
      if (!revision) {
        return res.status(404).json({ error: 'design system revision not found' });
      }
      res.json({ revision });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id', async (req, res) => {
    try {
      const systems = await listAllDesignSystems();
      const summary = systems.find((s) => s.id === req.params.id);
      const projectBody = await readDesignSystemWorkspaceTextFile(db, summary, 'DESIGN.md');
      const body = projectBody ?? await readAvailableDesignSystem(req.params.id);
      if (body === null || !summary)
        return res.status(404).json({ error: 'design system not found' });
      const packageInfo = await readAvailableDesignSystemPackageInfo(req.params.id);
      const detail = { ...summary, body, ...(packageInfo ? { packageInfo } : {}) };
      res.json({ ...detail, designSystem: detail });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/design-systems/:id/workspace', async (req, res) => {
    try {
      const workspace = await ensureUserDesignSystemWorkspaceProject(db, req.params.id);
      if (!workspace) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.status(201).json(workspace);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id/files', async (req, res) => {
    try {
      const files = await listUserDesignSystemFiles(USER_DESIGN_SYSTEMS_DIR, req.params.id);
      if (!files) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.json({ files });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id/file', async (req, res) => {
    try {
      const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
      const file = await readUserDesignSystemFile(
        USER_DESIGN_SYSTEMS_DIR,
        req.params.id,
        requestedPath,
      );
      if (!file) return res.status(404).json({ error: 'design system file not found' });
      res.json({ file });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.patch('/api/design-systems/:id', async (req, res) => {
    try {
      const updated = await updateUserDesignSystem(
        USER_DESIGN_SYSTEMS_DIR,
        req.params.id,
        req.body || {},
      );
      if (!updated) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.json({ ...updated, designSystem: updated });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.delete('/api/design-systems/:id', async (req, res) => {
    try {
      const ok = await deleteUserDesignSystem(USER_DESIGN_SYSTEMS_DIR, req.params.id);
      if (!ok) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plugin-system HTTP surface. Spec §11.5. Phase 1 wires the minimum set
  // needed for the §12.5 walkthrough: list/get installed plugins, install
  // (SSE), uninstall, apply (returns ApplyResult + snapshotId), atom catalog,
  // and snapshot fetch by id (used by run replay tooling).
  app.get('/api/plugins', async (_req, res) => {
    try {
      const plugins = listInstalledPlugins(db);
      res.json({ plugins });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/plugins/:id', async (req, res) => {
    try {
      const plugin = getInstalledPlugin(db, req.params.id);
      if (!plugin) return res.status(404).json({ error: 'plugin not found' });
      res.json(plugin);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  async function finishUploadedPluginInstall(stagedFolder, source) {
    const warnings = [];
    const log = [];
    let plugin = null;
    let message = 'Install finished.';
    try {
      const pluginRoot = await findUploadedPluginRoot(stagedFolder);
      for await (const ev of installFromLocalFolder(db, {
        source,
        roots: PLUGIN_REGISTRY_ROOTS,
        _stagedFolder: pluginRoot,
        _stagedSourceKind: 'user',
        lockfilePath: PLUGIN_LOCKFILE_PATH,
      })) {
        if (ev.message) log.push(ev.message);
        if (Array.isArray(ev.warnings)) warnings.splice(0, warnings.length, ...ev.warnings);
        if (ev.kind === 'success') {
          plugin = ev.plugin;
          message = `Installed ${ev.plugin.title}.`;
          break;
        }
        if (ev.kind === 'error') {
          message = ev.message;
          break;
        }
      }
      return { ok: Boolean(plugin), plugin, warnings, message, log };
    } finally {
      await fs.promises.rm(stagedFolder, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function findUploadedPluginRoot(stagedFolder) {
    if (await folderLooksLikePlugin(stagedFolder)) return stagedFolder;
    const entries = await fs.promises.readdir(stagedFolder, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory());
    const files = entries.filter((entry) => entry.isFile());
    if (files.length === 0 && dirs.length === 1) {
      const nested = path.join(stagedFolder, dirs[0].name);
      if (await folderLooksLikePlugin(nested)) return nested;
    }
    return stagedFolder;
  }

  async function folderLooksLikePlugin(folder) {
    const names = ['open-design.json', 'SKILL.md', path.join('.claude-plugin', 'plugin.json')];
    for (const name of names) {
      if (fs.existsSync(path.join(folder, name))) return true;
    }
    return false;
  }

  function safeUploadRelativePath(input) {
    const value = String(input || '').replace(/\\/g, '/');
    if (!value || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
      throw new Error('invalid upload path');
    }
    const parts = value.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
      throw new Error(`unsafe upload path: ${value}`);
    }
    return parts.join(path.sep);
  }

  async function extractPluginZipToFolder(buffer, stagedFolder) {
    if (buffer.length > PLUGIN_UPLOAD_MAX_BYTES) {
      throw new Error('zip file too large');
    }
    const zip = await JSZip.loadAsync(buffer);
    let totalBytes = 0;
    const entries = Object.values(zip.files);
    if (entries.length === 0) throw new Error('zip contains no files');
    for (const entry of entries) {
      if (entry.dir) continue;
      const rel = safeUploadRelativePath(entry.name);
      const unixMode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0;
      if ((unixMode & 0o170000) === 0o120000) {
        throw new Error(`zip entry is a symbolic link: ${entry.name}`);
      }
      const content = await entry.async('nodebuffer');
      totalBytes += content.length;
      if (totalBytes > PLUGIN_UPLOAD_MAX_BYTES) {
        throw new Error('zip extracted size exceeds 50 MiB');
      }
      const dest = path.join(stagedFolder, rel);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, content);
    }
  }

  app.post('/api/plugins/upload-zip', (req, res) => {
    pluginUpload.single('file')(req, res, async (err) => {
      if (err) return sendMulterError(res, err);
      try {
        const file = req.file;
        if (!file || !file.buffer) {
          return res.status(400).json({ error: 'file is required' });
        }
        const stagedFolder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'od-plugin-zip-'));
        await extractPluginZipToFolder(file.buffer, stagedFolder);
        const result = await finishUploadedPluginInstall(
          stagedFolder,
          `upload:zip:${decodeMultipartFilename(file.originalname || 'plugin.zip')}`,
        );
        res.status(result.ok ? 200 : 400).json(result);
      } catch (uploadErr) {
        res.status(400).json({
          ok: false,
          warnings: [],
          message: String(uploadErr?.message || uploadErr),
          log: [],
        });
      }
    });
  });

  app.post('/api/plugins/upload-folder', (req, res) => {
    pluginUpload.array('files', 500)(req, res, async (err) => {
      if (err) return sendMulterError(res, err);
      const stagedFolder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'od-plugin-folder-'));
      try {
        const files = Array.isArray(req.files) ? req.files : [];
        if (files.length === 0) {
          await fs.promises.rm(stagedFolder, { recursive: true, force: true }).catch(() => undefined);
          return res.status(400).json({ error: 'files are required' });
        }
        const rawPaths = req.body?.paths;
        const paths = Array.isArray(rawPaths) ? rawPaths : rawPaths ? [rawPaths] : [];
        let totalBytes = 0;
        for (let i = 0; i < files.length; i += 1) {
          const file = files[i];
          totalBytes += file.buffer.length;
          if (totalBytes > PLUGIN_UPLOAD_MAX_BYTES) {
            throw new Error('folder upload exceeds 50 MiB');
          }
          const rel = safeUploadRelativePath(paths[i] || file.originalname);
          const dest = path.join(stagedFolder, rel);
          await fs.promises.mkdir(path.dirname(dest), { recursive: true });
          await fs.promises.writeFile(dest, file.buffer);
        }
        const result = await finishUploadedPluginInstall(stagedFolder, 'upload:folder');
        res.status(result.ok ? 200 : 400).json(result);
      } catch (uploadErr) {
        await fs.promises.rm(stagedFolder, { recursive: true, force: true }).catch(() => undefined);
        res.status(400).json({
          ok: false,
          warnings: [],
          message: String(uploadErr?.message || uploadErr),
          log: [],
        });
      }
    });
  });

  app.post('/api/plugins/install', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let source = typeof body.source === 'string' ? body.source : '';
    let marketplaceResolution: {
      marketplaceId: string;
      marketplaceTrust: 'official' | 'trusted' | 'restricted';
      pluginName: string;
      pluginVersion: string;
      source: string;
      ref?: string;
      manifestDigest?: string;
      archiveIntegrity?: string;
    } | null = null;
    if (!source) {
      return res.status(400).json({ error: 'source is required' });
    }
    // Plan §3.A6: accept local folder, github:owner/repo[@ref][/subpath],
    // and https://*.tar.gz / *.tgz sources. Plan §3.F3: also accept a
    // bare plugin name and resolve it through the configured marketplaces.
    // Other shapes are 400 so the error surface is clear.
    const looksAbsolute = source.startsWith('/') || source.startsWith('./') || source.startsWith('~');
    const looksGithub = source.startsWith('github:');
    const looksHttps = /^https:\/\//i.test(source);
    if (!looksAbsolute && !looksGithub && !looksHttps) {
      // Treat the source as a plugin name and look it up in the
      // marketplace registry. Match resolution returns the canonical
      // source (github:… / https://…) so the installer can replay
      // the same byte path that would happen if the user copy-pasted
      // the source manually.
      const { resolvePluginInMarketplaces } = await import('./plugins/marketplaces.js');
      let lookupName = source;
      const lockfile = await readPluginLockfile(PLUGIN_LOCKFILE_PATH);
      const locked = lockfile.plugins[source];
      if (locked?.version && !source.includes('@')) {
        lookupName = `${source}@${locked.version}`;
      }
      const resolved = resolvePluginInMarketplaces(db, lookupName);
      if (!resolved) {
        return res.status(404).json({
          error: {
            code: 'plugin-not-found',
            message: `No marketplace plugin named "${source}". Add a marketplace via 'od marketplace add <url>' or pass a github: / https:// / local source.`,
            data: { name: source },
          },
        });
      }
      marketplaceResolution = resolved;
      source = resolved.source;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const ev of installPlugin(db, {
        source,
        roots: PLUGIN_REGISTRY_ROOTS,
        sourceMarketplaceId: marketplaceResolution?.marketplaceId,
        sourceMarketplaceEntryName: marketplaceResolution?.pluginName,
        sourceMarketplaceEntryVersion: marketplaceResolution?.pluginVersion,
        marketplaceTrust: marketplaceResolution?.marketplaceTrust,
        resolvedSource: marketplaceResolution?.source,
        resolvedRef: marketplaceResolution?.ref,
        manifestDigest: marketplaceResolution?.manifestDigest,
        archiveIntegrity: marketplaceResolution?.archiveIntegrity,
        lockfilePath: PLUGIN_LOCKFILE_PATH,
      })) {
        writeEvent(ev.kind, ev);
        if (ev.kind === 'success' || ev.kind === 'error') break;
      }
    } catch (err) {
      writeEvent('error', { kind: 'error', message: String(err), warnings: [] });
    } finally {
      res.end();
    }
  });

  app.post('/api/plugins/:id/uninstall', async (req, res) => {
    try {
      const result = await uninstallPlugin(db, req.params.id, PLUGIN_REGISTRY_ROOTS);
      if (!result.ok && !result.removedFolder) {
        return res.status(404).json({ error: 'plugin not found', warning: result.warning });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plan §3.Z2 — `od plugin upgrade <id>` re-installs a plugin from
  // its recorded source. Streams the same SSE shape as
  // POST /api/plugins/install so CLIs and the web composer reuse
  // the existing event handler.
  //
  // Rejected for source_kind='bundled': bundled plugins are
  // shipped with the daemon image and the bundled boot walker
  // re-registers them on every boot. Letting an operator
  // 'upgrade' a bundled plugin would silently overwrite the
  // daemon's authoritative copy and confuse the next boot.
  app.post('/api/plugins/:id/upgrade', async (req, res) => {
    const id = req.params.id;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const policy = body.policy === 'pinned' ? 'pinned' : 'latest';
    const plugin = getInstalledPlugin(db, id);
    if (!plugin) {
      return res.status(404).json({
        error: { code: 'plugin-not-found', message: `No installed plugin with id "${id}".`, data: { id } },
      });
    }
    if (plugin.sourceKind === 'bundled') {
      return res.status(409).json({
        error: {
          code: 'bundled-plugin',
          message: `Plugin "${id}" was shipped bundled with the daemon and upgrades only via daemon-image upgrade. The bundled boot walker re-registers bundled plugins on every boot.`,
          data: { id, sourceKind: plugin.sourceKind },
        },
      });
    }
    let source = plugin.source;
    let marketplaceResolution: {
      marketplaceId: string;
      marketplaceTrust: 'official' | 'trusted' | 'restricted';
      pluginName: string;
      pluginVersion: string;
      source: string;
      ref?: string;
      manifestDigest?: string;
      archiveIntegrity?: string;
    } | null = null;
    if (policy === 'latest' && plugin.sourceMarketplaceEntryName) {
      const { resolvePluginInMarketplaces } = await import('./plugins/marketplaces.js');
      marketplaceResolution = resolvePluginInMarketplaces(db, plugin.sourceMarketplaceEntryName);
      if (marketplaceResolution) {
        source = marketplaceResolution.source;
      }
    }
    if (!source) {
      return res.status(409).json({
        error: {
          code: 'missing-source',
          message: `Plugin "${id}" has no recorded install source — cannot upgrade. Reinstall via 'od plugin install --source <...>' to set one.`,
          data: { id },
        },
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    writeEvent('progress', { kind: 'progress', phase: 'resolving', message: `Upgrading ${id} from ${source} (policy=${policy})` });

    try {
      for await (const ev of installPlugin(db, {
        source,
        roots: PLUGIN_REGISTRY_ROOTS,
        eventKind: 'upgraded',
        sourceMarketplaceId: marketplaceResolution?.marketplaceId ?? plugin.sourceMarketplaceId,
        sourceMarketplaceEntryName: marketplaceResolution?.pluginName ?? plugin.sourceMarketplaceEntryName,
        sourceMarketplaceEntryVersion: marketplaceResolution?.pluginVersion ?? plugin.sourceMarketplaceEntryVersion,
        marketplaceTrust: marketplaceResolution?.marketplaceTrust ?? plugin.marketplaceTrust,
        resolvedSource: marketplaceResolution?.source ?? plugin.resolvedSource,
        resolvedRef: marketplaceResolution?.ref ?? plugin.resolvedRef,
        manifestDigest: marketplaceResolution?.manifestDigest ?? plugin.manifestDigest,
        archiveIntegrity: marketplaceResolution?.archiveIntegrity ?? plugin.archiveIntegrity,
        lockfilePath: PLUGIN_LOCKFILE_PATH,
      })) {
        writeEvent(ev.kind, ev);
        if (ev.kind === 'success' || ev.kind === 'error') break;
      }
    } catch (err) {
      writeEvent('error', { kind: 'error', message: String(err), warnings: [] });
    } finally {
      res.end();
    }
  });

  // Plan §3.A1: shared helper used by every endpoint that has to resolve
  // plugin context against the live registry. Skills + design systems are
  // walked from disk; craft is empty in v1; atoms come from the
  // first-party catalog. Project-scoped overrides arrive in Phase 4.
  async function loadPluginRegistryView() {
    const [skills, designSystems] = await Promise.all([
      listAllSkills(),
      listAllDesignSystems(),
    ]);
    // Spec §23.3.3: surface the bundled scenario plugins so apply()
    // can fall back to the matching scenario's pipeline when the
    // consumer plugin omits od.pipeline. Each scenario carries a
    // `taskKind` that picks the match.
    const scenarios = collectBundledScenarios();
    return {
      skills: skills.map((s) => ({ id: s.id, title: s.name, description: s.description })),
      designSystems: designSystems.map((d) => ({ id: d.id, title: d.title })),
      craft: [],
      atoms: FIRST_PARTY_ATOMS.map((a) => ({ id: a.id, label: a.label })),
      scenarios,
    };
  }

  // Pure read off `installed_plugins`: rows whose source_kind='bundled'
  // AND od.kind='scenario' AND od.pipeline is non-empty become entries
  // the apply path can fall back to. Scenario plugins from third-party
  // sources are intentionally NOT trusted as defaults — the bundled
  // boot walker (apps/daemon/src/plugins/bundled.ts) is the only writer
  // of source_kind='bundled', so this function never grants the
  // privilege to user-installed scenarios.
  //
  // Plan §3.O1 / §C-stage of plugin-driven-flow-plan: more than one
  // bundled scenario may share a `taskKind` (e.g. `od-media-generation`
  // also claims `new-generation` so the kind → scenario map can route
  // image / video / audio projects to it). The pipeline-fallback
  // resolver expects ONE scenario per taskKind, so this function
  // dedupes and prefers the canonical id `od-<taskKind>` as the
  // pipeline-fallback winner. Non-canonical scenarios still install
  // and run through their explicit pluginId path; they just don't get
  // to hijack a consumer plugin that omitted `od.pipeline`.
  function collectBundledScenarios() {
    type ScenarioEntry = {
      id: string;
      taskKind: 'new-generation' | 'figma-migration' | 'code-migration' | 'tune-collab';
      pipeline: NonNullable<NonNullable<import('@open-design/contracts').PluginManifest['od']>['pipeline']>;
    };
    const byTaskKind = new Map<ScenarioEntry['taskKind'], ScenarioEntry>();
    try {
      const all = listInstalledPlugins(db);
      for (const row of all) {
        if (row.sourceKind !== 'bundled') continue;
        const od = row.manifest.od;
        if (!od || od.kind !== 'scenario') continue;
        if (!od.pipeline || !Array.isArray(od.pipeline.stages) || od.pipeline.stages.length === 0) continue;
        const taskKind = (od.taskKind ?? 'new-generation') as ScenarioEntry['taskKind'];
        if (taskKind !== 'new-generation' && taskKind !== 'figma-migration' &&
            taskKind !== 'code-migration' && taskKind !== 'tune-collab') continue;
        const entry: ScenarioEntry = { id: row.id, taskKind, pipeline: od.pipeline };
        const existing = byTaskKind.get(taskKind);
        if (!existing || entry.id === `od-${taskKind}`) {
          byTaskKind.set(taskKind, entry);
        }
      }
    } catch {
      // On a fresh install the table may not exist yet; surface no
      // scenarios rather than crash the apply path.
      return [];
    }
    return Array.from(byTaskKind.values());
  }

  app.post('/api/plugins/:id/apply', async (req, res) => {
    try {
      const plugin = getInstalledPlugin(db, req.params.id);
      if (!plugin) return res.status(404).json({ error: 'plugin not found' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const inputs = body.inputs && typeof body.inputs === 'object' ? body.inputs : {};
      const grantCaps = Array.isArray(body.grantCaps)
        ? body.grantCaps.filter((c) => typeof c === 'string')
        : [];
      const locale = typeof body.locale === 'string' ? body.locale : undefined;

      const registry = await loadPluginRegistryView();
      const connectorProbe = buildConnectorProbe(connectorService);
      const computed = applyPlugin({ plugin, inputs, registry, locale, connectorProbe });
      // Plan §3.B2 — apply-time grants are merged into the snapshot's
      // capabilitiesGranted so the §9 capability gate sees them, but
      // they are NOT written back to installed_plugins.capabilities_granted.
      // The snapshot is the only place this ephemeral grant lives.
      if (grantCaps.length > 0) {
        const merged = new Set([...computed.result.capabilitiesGranted, ...grantCaps]);
        computed.result.capabilitiesGranted = Array.from(merged);
        computed.result.appliedPlugin.capabilitiesGranted = Array.from(merged);
      }
      res.json({ ok: true, ...computed.result, warnings: computed.warnings, manifestSourceDigest: computed.manifestSourceDigest });
    } catch (err) {
      if (err instanceof MissingInputError) {
        return res.status(422).json({ error: 'missing_inputs', fields: err.fields });
      }
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/plugins/:id/share-project', async (req, res) => {
    try {
      const sourcePlugin = getInstalledPlugin(db, req.params.id);
      if (!sourcePlugin) {
        sendApiError(res, 404, 'NOT_FOUND', 'plugin not found');
        return;
      }
      if (!USER_PLUGIN_SOURCE_KINDS.has(sourcePlugin.sourceKind)) {
        res.status(409).json({
          ok: false,
          code: 'plugin-not-shareable',
          message: 'Only user-installed plugins can start a share project.',
        });
        return;
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const action = normalizePluginShareAction(body.action);
      if (!action) {
        sendApiError(res, 400, 'BAD_REQUEST', 'action must be publish-github or contribute-open-design');
        return;
      }
      const actionPluginId = PLUGIN_SHARE_ACTION_PLUGIN_IDS[action];
      const actionPlugin = getInstalledPlugin(db, actionPluginId);
      if (!actionPlugin) {
        res.status(409).json({
          ok: false,
          code: 'share-action-plugin-missing',
          message: `The bundled action plugin "${actionPluginId}" is not installed. Restart the daemon so bundled plugins are registered.`,
        });
        return;
      }

      const now = Date.now();
      const id = randomId();
      const cid = randomId();
      const sourceSlug = githubRepoNameFromPluginName(sourcePlugin.id);
      const stagedPath = `plugin-source/${sourceSlug}`;
      const prompt = renderPluginSharePrompt({ action, sourcePlugin, stagedPath });
      const metadata = { kind: 'prototype' };
      const projectRoot = await ensureProject(PROJECTS_DIR, id, metadata);
      await copyPluginFolderForProjectContext(
        sourcePlugin.fsPath,
        path.join(projectRoot, 'plugin-source', sourceSlug),
      );

      insertProject(db, {
        id,
        name: `${PLUGIN_SHARE_ACTION_LABELS[action]}: ${sourcePlugin.title || sourcePlugin.id}`,
        skillId: null,
        designSystemId: null,
        pendingPrompt: prompt,
        metadata,
        createdAt: now,
        updatedAt: now,
      });
      insertConversation(db, {
        id: cid,
        projectId: id,
        title: null,
        createdAt: now,
        updatedAt: now,
      });

      const registry = await loadPluginRegistryView();
      const connectorProbe = buildConnectorProbe(connectorService);
      const resolved = resolvePluginSnapshot({
        db,
        body: {
          pluginId: actionPluginId,
          pluginInputs: {
            source_plugin_id: sourcePlugin.id,
            source_plugin_title: sourcePlugin.title || sourcePlugin.id,
            source_plugin_version: sourcePlugin.version,
            source_plugin_path: sourcePlugin.fsPath,
            plugin_context_path: stagedPath,
          },
          locale: typeof body.locale === 'string' ? body.locale : undefined,
        },
        projectId: id,
        conversationId: cid,
        registry,
        connectorProbe,
      });
      if (resolved && !resolved.ok) {
        res.status(resolved.status).json(resolved.body);
        return;
      }

      const project = getProject(db, id);
      if (!project) {
        sendApiError(res, 500, 'INTERNAL_ERROR', 'created project could not be loaded');
        return;
      }
      res.json({
        ok: true,
        project,
        conversationId: cid,
        ...(resolved?.ok ? { appliedPluginSnapshotId: resolved.snapshotId } : {}),
        actionPluginId,
        sourcePluginId: sourcePlugin.id,
        stagedPath,
        prompt,
        message: `Created a ${PLUGIN_SHARE_ACTION_LABELS[action]} task for ${sourcePlugin.title || sourcePlugin.id}.`,
      });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err?.message || err) });
    }
  });

  app.post('/api/plugins/:id/doctor', async (req, res) => {
    try {
      const plugin = getInstalledPlugin(db, req.params.id);
      if (!plugin) return res.status(404).json({ error: 'plugin not found' });
      const registry = await loadPluginRegistryView();
      const connectorProbe = buildConnectorProbe(connectorService);
      const report = doctorPlugin(plugin, registry, { connectorProbe });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plan §3.A2 / spec §9.1: persistent capability grant. Body is
  // `{ capabilities: string[], action?: 'grant' | 'revoke' }`. The daemon
  // validates each entry against the §5.3 vocabulary; unknown / malformed
  // strings come back as 400 with the offending list so the CLI can
  // render exit-code-2 usage advice. The mutation goes through
  // `grantCapabilities` / `revokeCapabilities` (the only writers of
  // `installed_plugins.capabilities_granted` outside of install).
  app.post('/api/plugins/:id/trust', async (req, res) => {
    try {
      const plugin = getInstalledPlugin(db, req.params.id);
      if (!plugin) return res.status(404).json({ error: 'plugin not found' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const action = body.action === 'revoke' ? 'revoke' : 'grant';
      const { validateCapabilityList, grantCapabilities, revokeCapabilities } =
        await import('./plugins/trust.js');
      const { accepted, rejected } = validateCapabilityList(body.capabilities);
      if (rejected.length > 0) {
        return res.status(400).json({
          error: {
            code: 'invalid-capability',
            message: `Capability validation failed: ${rejected.map((r) => r.capability).join(', ')}`,
            data: { rejected },
          },
        });
      }
      if (accepted.length === 0) {
        return res.status(400).json({
          error: {
            code: 'no-capabilities',
            message: 'capabilities[] is required and must contain at least one entry',
          },
        });
      }
      const next = action === 'revoke'
        ? revokeCapabilities({ db, pluginId: req.params.id, capabilities: accepted })
        : grantCapabilities({ db, pluginId: req.params.id, capabilities: accepted });
      const updated = getInstalledPlugin(db, req.params.id);
      // Plan §3.JJ1 — emit a 'plugin.trust-changed' event so the
      // ops live-tail surfaces capability mutations for security
      // audit. Best-effort.
      try {
        const { recordPluginEvent } = await import('./plugins/events.js');
        recordPluginEvent({
          kind:     'plugin.trust-changed',
          pluginId: req.params.id,
          details:  { action, capabilities: accepted, total: next.length },
        });
      } catch {
        // ignore — event recording never blocks the trust mutation.
      }
      res.status(action === 'grant' ? 201 : 200).json({
        ok: true,
        id: req.params.id,
        action,
        capabilitiesGranted: next,
        plugin: updated,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/atoms', (_req, res) => {
    res.json({ atoms: FIRST_PARTY_ATOMS.map((a) => ({ ...a, taskKinds: a.taskKinds.slice() })) });
  });

  // Plan §3.AA2 — `od atoms info <id>`. Returns the catalog row +
  // the bundled SKILL.md body (when one exists at
  // plugins/_official/atoms/<id>/SKILL.md) so the caller can render
  // a single page describing what the atom does + the prompt
  // fragment that drives it.
  app.get('/api/atoms/:id', async (req, res) => {
    const id = req.params.id;
    const atom = FIRST_PARTY_ATOMS.find((a) => a.id === id);
    if (!atom) return res.status(404).json({ error: { code: 'atom-not-found', message: `Unknown atom "${id}"` } });
    const body: Record<string, unknown> = {
      ...atom,
      taskKinds: atom.taskKinds.slice(),
    };
    try {
      const { loadAtomBodies } = await import('./plugins/atom-bodies.js');
      const bodies = await loadAtomBodies(db, [id]);
      if (bodies[0] && typeof bodies[0].body === 'string') {
        body.skillBody = bodies[0].body;
      }
    } catch (err) {
      // Best-effort; atom info still useful without the body.
      console.warn(`[atoms] failed to load SKILL.md body for ${id}:`, err);
    }
    res.json(body);
  });

  // Plan §3.L3 / spec §10.3.5 / §9.2 — plugin asset endpoint.
  //
  // Serves a static file from inside an installed plugin's fsPath,
  // sandboxed by:
  //   - whitelisted plugin ids (the registry row),
  //   - normalized relpath (no '..' / absolute / leading drive),
  //   - the §9.2 preview CSP (default-src 'none'; script-src 'self'
  //     'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'),
  //   - X-Content-Type-Options: nosniff so the browser respects the
  //     declared content type even on miss.
  // The web GenUISurfaceRenderer's SandboxedComponentSurface points
  // its iframe at this URL.
  // Helper for the /preview + /example/:name routes below. Walks a
  // list of candidate relpaths inside the plugin folder, picks the
  // first one that exists + stays inside the fsPath, and serves it
  // with the §9.2 sandboxed-iframe CSP (same shape as `/asset/*`).
  // Pulled out so /preview and /example/:name share a single source
  // of truth for the security envelope.
  async function servePluginSandboxedHtml(
    req: any,
    res: any,
    pickCandidates: (plugin: any) => Promise<string[]> | string[],
  ): Promise<void> {
    try {
      const plugin = getInstalledPlugin(db, req.params.id);
      if (!plugin) {
        res.status(404).json({ error: 'plugin not found' });
        return;
      }
      const candidates = (await pickCandidates(plugin)).filter(
        (p): p is string => typeof p === 'string' && p.length > 0,
      );
      const path = await import('node:path');
      const fsp = await import('node:fs/promises');
      const root = path.resolve(plugin.fsPath) + path.sep;
      let resolved: string | null = null;
      let resolvedRel: string | null = null;
      for (const rel of candidates) {
        if (rel.includes('..') || rel.startsWith('/') || rel.includes('\0')) continue;
        const full = path.resolve(plugin.fsPath, rel);
        if (!(full + path.sep).startsWith(root) && full !== path.resolve(plugin.fsPath)) continue;
        try {
          const st = await fsp.stat(full);
          // Refuse symlinks — the install root may be writable so a
          // symlink leak would defeat the containment check above.
          const lst = await fsp.lstat(full);
          if (lst.isSymbolicLink()) continue;
          if (!st.isFile()) continue;
          // 5 MiB cap — preview HTML is human-authored; refuse anything
          // resembling a binary blob smuggled through this surface.
          if (st.size > 5 * 1024 * 1024) {
            res.status(413).json({ error: 'preview asset too large' });
            return;
          }
          resolved = full;
          resolvedRel = rel;
          break;
        } catch {
          // try next candidate
        }
      }
      if (!resolved) {
        res.status(404).json({ error: 'preview not found' });
        return;
      }
      let contentPath = resolved;
      let contentRel = resolvedRel;
      let buf = await fsp.readFile(resolved);
      if (resolvedRel && /\.html?$/i.test(resolvedRel)) {
        const shellTarget = iframeOnlyHtmlShellTarget(buf.toString('utf8'));
        if (shellTarget) {
          const targetFull = path.resolve(path.dirname(resolved), shellTarget);
          const rootDir = path.resolve(plugin.fsPath);
          const insideRoot =
            (targetFull + path.sep).startsWith(root) ||
            targetFull === rootDir;
          if (insideRoot) {
            try {
              const st = await fsp.stat(targetFull);
              const lst = await fsp.lstat(targetFull);
              if (!lst.isSymbolicLink() && st.isFile() && st.size <= 5 * 1024 * 1024) {
                buf = await fsp.readFile(targetFull);
                contentPath = targetFull;
                contentRel = path.relative(plugin.fsPath, targetFull).split(path.sep).join('/');
              }
            } catch {
              // Keep the wrapper HTML if the iframe target cannot be read.
            }
          }
        }
      }
      if (resolvedRel && /(^|\/)example-slides\.html$/i.test(resolvedRel)) {
        const templateRel = resolvedRel.replace(
          /(^|\/)example-slides\.html$/i,
          '$1template.html',
        );
        const templateFull = path.resolve(plugin.fsPath, templateRel);
        const templateInside =
          (templateFull + path.sep).startsWith(root) ||
          templateFull === path.resolve(plugin.fsPath);
        if (templateInside) {
          try {
            const st = await fsp.stat(templateFull);
            const lst = await fsp.lstat(templateFull);
            if (!lst.isSymbolicLink() && st.isFile() && st.size <= 5 * 1024 * 1024) {
              const title =
                typeof plugin.title === 'string'
                  ? plugin.title
                  : typeof plugin.manifest?.title === 'string'
                    ? plugin.manifest.title
                    : req.params.id;
              const tplHtml = await fsp.readFile(templateFull, 'utf8');
              const slidesHtml = buf.toString('utf8');
              buf = Buffer.from(assembleExample(tplHtml, slidesHtml, title), 'utf8');
              contentPath = templateFull;
              contentRel = templateRel;
            }
          } catch {
            // Keep the raw fallback if the companion template is missing.
          }
        }
      }
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'",
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const ext = path.extname(contentPath).toLowerCase();
      const ct =
        ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js'  ? 'application/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.json' ? 'application/json; charset=utf-8'
        : ext === '.svg' ? 'image/svg+xml'
        : ext === '.png' ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      if (ext === '.html' && typeof contentRel === 'string') {
        buf = Buffer.from(
          rewritePluginAssetUrls(
            buf.toString('utf8'),
            req.params.id,
            path.posix.dirname(contentRel.replace(/\\/g, '/')),
          ),
          'utf8',
        );
      }
      res.send(buf);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  }

  function iframeOnlyHtmlShellTarget(html: string): string | null {
    if (typeof html !== 'string' || html.length === 0) return null;
    const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    if (!bodyMatch) return null;
    const body = bodyMatch[1].replace(/<!--[\s\S]*?-->/g, '').trim();
    const iframeMatch = /^<iframe\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1[^>]*>\s*(?:<\/iframe>)?\s*$/i.exec(body);
    if (!iframeMatch) return null;
    const src = iframeMatch[2].trim();
    if (
      !src ||
      src.startsWith('/') ||
      src.startsWith('//') ||
      src.includes('\0') ||
      /^[a-z][a-z0-9+.-]*:/i.test(src)
    ) {
      return null;
    }
    const pathOnly = src.split(/[?#]/)[0] ?? '';
    if (!/\.html?$/i.test(pathOnly)) return null;
    return pathOnly;
  }

  function rewritePluginAssetUrls(html: string, pluginId: string, baseDir: string) {
    if (typeof html !== 'string' || html.length === 0) return html;
    const safeBase = baseDir === '.' ? '' : baseDir;
    return html.replace(
      /(\s(?:src|href|poster)\s*=\s*)(['"])([^'"]+)(\2)/gi,
      (match, attr, quote, rawValue, closeQuote) => {
        const value = String(rawValue).trim();
        if (
          !value ||
          value.startsWith('#') ||
          value.startsWith('/') ||
          value.startsWith('//') ||
          value.includes('\0') ||
          /^[a-z][a-z0-9+.-]*:/i.test(value)
        ) {
          return match;
        }
        const splitAt = value.search(/[?#]/);
        const rel = splitAt === -1 ? value : value.slice(0, splitAt);
        const suffix = splitAt === -1 ? '' : value.slice(splitAt);
        const normalized = path.posix.normalize(path.posix.join(safeBase, rel));
        if (
          normalized === '.' ||
          normalized === '..' ||
          normalized.startsWith('../') ||
          path.posix.isAbsolute(normalized)
        ) {
          return match;
        }
        const url = `/api/plugins/${encodeURIComponent(pluginId)}/asset/${normalized}${suffix}`;
        return `${attr}${quote}${url}${closeQuote}`;
      },
    );
  }

  // Plan §6 Phase 2B + spec §11.6 / §9.2 — plugin preview + examples.
  //
  // Two flavours wrap the same sandboxed-HTML envelope as `/asset/*`:
  //   - `/preview` serves the plugin's preview entry (declared via
  //     `od.preview.entry`, with fallbacks that walk the plugin's
  //     own context.assets[] HTMLs, examples/*.html and assets/*.html).
  //   - `/example/:name` serves an entry from `od.useCase.exampleOutputs[]`,
  //     matched by basename or by index. Both reuse the same
  //     traversal / containment guards as the asset route.
  //
  // The marketplace detail page (PluginDetailView) embeds /preview
  // inside an `<iframe sandbox="allow-scripts">`. The §9.2 CSP keeps
  // the preview from reaching back into /api/* even if its scripts
  // try to fetch.
  //
  // Some bundled plugins (`example-guizang-ppt`, `example-html-ppt`,
  // …) declare `od.preview.entry: "./index.html"` but actually ship
  // the renderable HTML under `assets/example-slides.html` or
  // `assets/template.html`. Returning 404 in that case lit up white
  // tiles in the home gallery, so the candidates list always extends
  // past the declared entry to walk a curated fallback chain.
  //
  // `assets/example-slides.html` is a special case: for guizang-ppt it
  // is intentionally only the slide fragment. The old skill preview
  // assembled it into `assets/template.html` at request time; the plugin
  // route mirrors that so the marketplace card keeps the WebGL/e-ink
  // magazine treatment instead of rendering unstyled fragments.
  function collectPluginPreviewCandidates(plugin: unknown): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();
    function push(rel: unknown): void {
      if (typeof rel !== 'string') return;
      const trimmed = rel.replace(/^\.\//, '');
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      candidates.push(trimmed);
    }

    const manifest =
      ((plugin as { manifest?: unknown }).manifest ?? {}) as Record<string, unknown>;
    const od = (manifest.od ?? {}) as Record<string, unknown>;
    const preview = (od.preview ?? {}) as Record<string, unknown>;

    push(preview.entry);

    const ctx = (od.context ?? {}) as Record<string, unknown>;
    const assets = Array.isArray(ctx.assets) ? ctx.assets : [];
    for (const a of assets) {
      const rel = typeof a === 'string' ? a : null;
      if (rel && /\.html?$/i.test(rel)) push(rel);
    }

    const useCase = (od.useCase ?? {}) as Record<string, unknown>;
    const exampleOutputs = Array.isArray(useCase.exampleOutputs)
      ? useCase.exampleOutputs
      : [];
    for (const ex of exampleOutputs) {
      const p = (ex as { path?: unknown })?.path;
      if (typeof p === 'string' && /\.html?$/i.test(p)) push(p);
    }

    push('preview/index.html');
    push('index.html');
    push('examples/index.html');
    push('assets/index.html');
    push('assets/preview.html');
    push('assets/example.html');
    push('assets/example-slides.html');
    push('assets/template.html');
    push('public/index.html');
    push('dist/index.html');
    return candidates;
  }

  // Last-resort discovery for plugins whose bundle ships HTML but
  // doesn't match any of the conventional paths. We scan the plugin
  // root and a handful of common subfolders (assets/, public/, dist/,
  // examples/, preview/, templates/) for any `*.html` and surface
  // the first one. The scan is shallow to avoid pathological large
  // bundles, and the same containment guard inside
  // servePluginSandboxedHtml validates each candidate before reading.
  async function discoverPluginHtmlAssets(pluginFsPath: string): Promise<string[]> {
    const path = await import('node:path');
    const fsp = await import('node:fs/promises');
    const dirs = ['', 'assets', 'public', 'dist', 'examples', 'preview', 'templates'];
    const found: string[] = [];
    for (const dir of dirs) {
      const abs = path.resolve(pluginFsPath, dir);
      try {
        const entries = await fsp.readdir(abs, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isFile()) continue;
          if (!/\.html?$/i.test(ent.name)) continue;
          found.push(dir ? `${dir}/${ent.name}` : ent.name);
        }
      } catch {
        // dir missing — skip
      }
    }
    return found;
  }

  app.get('/api/plugins/:id/preview', async (req, res) => {
    await servePluginSandboxedHtml(req, res, async (plugin) => {
      const curated = collectPluginPreviewCandidates(plugin);
      const fsPath = (plugin as { fsPath?: unknown }).fsPath;
      if (typeof fsPath !== 'string') return curated;
      const discovered = await discoverPluginHtmlAssets(fsPath);
      const seen = new Set(curated);
      for (const rel of discovered) {
        if (!seen.has(rel)) curated.push(rel);
      }
      return curated;
    });
  });

  app.get('/api/plugins/:id/example/:name', async (req, res) => {
    const name = String(req.params.name ?? '');
    if (!name || /[\\/\0]|\.\./.test(name)) {
      return res.status(400).json({ error: 'invalid example name' });
    }
    await servePluginSandboxedHtml(req, res, async (plugin) => {
      const examples = ((plugin as { manifest?: { od?: { useCase?: { exampleOutputs?: Array<{ path?: unknown; title?: unknown }> } } } })
        .manifest?.od?.useCase?.exampleOutputs ?? []) as Array<{ path?: unknown; title?: unknown }>;
      const match = examples.find((e) => {
        if (!e || typeof e.path !== 'string') return false;
        const segments = e.path.split(/[\\/]/).filter(Boolean);
        const base = segments[segments.length - 1] ?? '';
        const baseStem = base.replace(/\.[^.]+$/, '');
        // For `examples/<folder>/index.html` the conceptual "name"
        // is the folder, not the inner basename.
        const parent = segments.length >= 2 ? segments[segments.length - 2] : null;
        const candidates = [base, baseStem, parent].filter((s): s is string => !!s);
        if (typeof e.title === 'string') candidates.push(e.title);
        return candidates.includes(name);
      });
      if (match && typeof match.path === 'string') return [match.path];
      // Allow `examples/<name>/index.html` and `examples/<name>.html`
      // so plugin authors can ship example folders without enumerating
      // them in the manifest.
      return [
        `examples/${name}/index.html`,
        `examples/${name}.html`,
      ];
    });
  });

  app.get('/api/plugins/:id/asset/*splat', async (req, res) => {
    try {
      const plugin = getInstalledPlugin(db, req.params.id);
      if (!plugin) return res.status(404).json({ error: 'plugin not found' });
      const splatParam = req.params.splat;
      const relpath = Array.isArray(splatParam) ? splatParam.join('/') : String(splatParam ?? '');
      // Reject obvious traversal up-front; the path resolution below
      // normalizes again, but this catches the easy cases without
      // touching disk.
      if (!relpath || relpath.includes('..') || relpath.startsWith('/') || relpath.includes('\0')) {
        return res.status(400).json({ error: 'invalid asset path' });
      }
      const path = await import('node:path');
      const fsp = await import('node:fs/promises');
      const resolved = path.resolve(plugin.fsPath, relpath);
      // Final containment check — `resolved` must stay under fsPath.
      const root = path.resolve(plugin.fsPath);
      const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
      if (!(resolved + path.sep).startsWith(rootWithSep) && resolved !== root) {
        return res.status(400).json({ error: 'asset escape rejected' });
      }
      const relativeSegments = path.relative(root, resolved).split(path.sep).filter(Boolean);
      let current = root;
      try {
        const rootStat = await fsp.lstat(current);
        if (rootStat.isSymbolicLink()) {
          return res.status(404).json({ error: 'asset not found' });
        }
        for (const segment of relativeSegments) {
          current = path.join(current, segment);
          const stat = await fsp.lstat(current);
          if (stat.isSymbolicLink()) {
            return res.status(404).json({ error: 'asset not found' });
          }
        }
      } catch {
        return res.status(404).json({ error: 'asset not found' });
      }
      try {
        const rootReal = await fsp.realpath(plugin.fsPath);
        const resolvedReal = await fsp.realpath(resolved);
        const rootRealWithSep = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
        if (resolvedReal !== rootReal && !resolvedReal.startsWith(rootRealWithSep)) {
          return res.status(400).json({ error: 'asset escape rejected' });
        }
      } catch {
        return res.status(404).json({ error: 'asset not found' });
      }
      let buf;
      try {
        buf = await fsp.readFile(resolved);
      } catch {
        return res.status(404).json({ error: 'asset not found' });
      }
      // §9.2 preview CSP — sandboxed iframes get only inline script + style;
      // no network, no external resources, no document-level forms.
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'",
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const ext = path.extname(resolved).toLowerCase();
      const ct =
        ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js'  ? 'application/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.json' ? 'application/json; charset=utf-8'
        : ext === '.svg' ? 'image/svg+xml'
        : ext === '.png' ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      res.send(buf);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plan §3.H2 / spec §12.2 — craft list endpoint.
  // Mirrors the daemon's existing /api/skills + /api/design-systems
  // discovery surface so `od craft list` is a thin wrapper over a
  // single HTTP call. Each entry returns a slug + size + first
  // markdown header so a code agent can browse without a separate
  // /api/craft/:id read.
  app.get('/api/craft', async (_req, res) => {
    try {
      const fsp = await import('node:fs/promises');
      let entries;
      try {
        entries = await fsp.readdir(CRAFT_DIR, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return res.json({ craft: [] });
        }
        throw err;
      }
      const out = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const slug = entry.name.replace(/\.md$/, '');
        try {
          const fullPath = `${CRAFT_DIR}/${entry.name}`;
          const text = await fsp.readFile(fullPath, 'utf8');
          const heading = text.split('\n').find((line) => line.startsWith('# '));
          out.push({
            id:     slug,
            label:  heading ? heading.replace(/^#+\s*/, '').trim() : slug,
            bytes:  Buffer.byteLength(text, 'utf8'),
          });
        } catch {
          // Skip unreadable files; surface what we can.
        }
      }
      res.json({ craft: out });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/craft/:id', async (req, res) => {
    try {
      const slug = req.params.id;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        return res.status(400).json({ error: 'invalid craft id' });
      }
      const fsp = await import('node:fs/promises');
      try {
        const text = await fsp.readFile(`${CRAFT_DIR}/${slug}.md`, 'utf8');
        res.json({ id: slug, body: text });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return res.status(404).json({ error: 'craft section not found' });
        }
        throw err;
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/applied-plugins/:snapshotId', (req, res) => {
    try {
      const snap = getSnapshot(db, req.params.snapshotId);
      if (!snap) return res.status(404).json({ error: 'snapshot not found' });
      res.json(snap);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plan §3.DD1 — `od plugin stats`. Aggregates the installed-
  // plugin roster + the applied_plugin_snapshots roster into one
  // health/inventory report. Pure helpers in plugins/stats.ts;
  // the route wires the SQLite reads + merges on the way out.
  app.get('/api/plugins/stats', async (_req, res) => {
    try {
      const { pluginInventoryStats, snapshotInventoryStats } = await import('./plugins/stats.js');
      const installed = listInstalledPlugins(db);
      const inventoryRows = db.prepare(
        `SELECT status, project_id, run_id, applied_at FROM applied_plugin_snapshots`,
      ).all() as Array<{ status: 'fresh' | 'stale'; project_id: string | null; run_id: string | null; applied_at: number }>;
      res.json({
        plugins:   pluginInventoryStats(installed),
        snapshots: snapshotInventoryStats(inventoryRows),
        generatedAt: Date.now(),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plan §3.CC1 — `od plugin canon <snapshotId>`. Returns the
  // canonical `## Active plugin` block the agent will see when
  // this snapshot is spliced into the system prompt. Powered by
  // the same renderPluginBlock() composeSystemPrompt() uses, so
  // the CLI output is byte-equal to what the agent reads.
  //
  // Two response modes:
  //   - default            : { snapshotId, pluginId, block }
  //   - Accept: text/plain : raw block body for shell pipes
  app.get('/api/applied-plugins/:snapshotId/canon', (req, res) => {
    try {
      const snap = getSnapshot(db, req.params.snapshotId);
      if (!snap) return res.status(404).json({ error: 'snapshot not found' });
      const block = pluginPromptBlock(snap);
      const accepts = String(req.headers['accept'] ?? '').toLowerCase();
      if (accepts.includes('text/plain')) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(block);
        return;
      }
      res.json({ snapshotId: snap.snapshotId, pluginId: snap.pluginId, block });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plan §3.B4 / spec §6: marketplace registry minimum verbs.
  // Phase 3 layers in `od plugin install <name>` resolution + the trust
  // UI on top; this route set is the storage half.
  app.get('/api/marketplaces', async (_req, res) => {
    try {
      const { listMarketplaces } = await import('./plugins/marketplaces.js');
      res.json({ marketplaces: listMarketplaces(db) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/marketplaces', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const url = typeof body.url === 'string' ? body.url : '';
      if (!url) return res.status(400).json({ error: 'url is required' });
      const trust = body.trust === 'trusted' || body.trust === 'official' ? body.trust : 'restricted';
      const { addMarketplace } = await import('./plugins/marketplaces.js');
      const result = await addMarketplace(db, {
        url,
        trust,
        fetcher: createMarketplaceFetcher(
          marketplaceRegistryIdFromUrl(url),
          bundledMarketplaceEntries,
        ),
      });
      if (!result.ok) {
        return res.status(result.status).json({
          error: { code: 'marketplace-add-failed', message: result.message, data: { errors: result.errors ?? [] } },
        });
      }
      res.status(201).json(result.row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/marketplaces/:id', async (req, res) => {
    try {
      const { getMarketplace } = await import('./plugins/marketplaces.js');
      const row = getMarketplace(db, req.params.id);
      if (!row) return res.status(404).json({ error: 'marketplace not found' });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete('/api/marketplaces/:id', async (req, res) => {
    try {
      const { removeMarketplace } = await import('./plugins/marketplaces.js');
      const ok = removeMarketplace(db, req.params.id);
      if (!ok) return res.status(404).json({ error: 'marketplace not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/marketplaces/:id/refresh', async (req, res) => {
    try {
      const { getMarketplace, refreshMarketplace } = await import('./plugins/marketplaces.js');
      const row = getMarketplace(db, req.params.id);
      const seedId = row ? marketplaceRegistryIdFromUrl(row.url) ?? req.params.id : req.params.id;
      const result = await refreshMarketplace(
        db,
        req.params.id,
        createMarketplaceFetcher(seedId, bundledMarketplaceEntries),
      );
      if (!result.ok) {
        return res.status(result.status).json({
          error: { code: 'marketplace-refresh-failed', message: result.message, data: { errors: result.errors ?? [] } },
        });
      }
      // Plan §3.JJ1 — emit a 'plugin.marketplace-refreshed' event
      // so ops can audit catalog refreshes via the live tail.
      try {
        const { recordPluginEvent } = await import('./plugins/events.js');
        recordPluginEvent({
          kind:     'plugin.marketplace-refreshed',
          pluginId: '',
          details:  {
            marketplaceId: req.params.id,
            marketplaceVersion: result.row.version,
            specVersion: result.row.specVersion,
          },
        });
      } catch { /* best-effort */ }
      res.json(result.row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/marketplaces/:id/trust', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const trust = body.trust === 'trusted' || body.trust === 'restricted' || body.trust === 'official'
        ? body.trust
        : null;
      if (!trust) {
        return res.status(400).json({ error: 'trust must be one of: trusted, restricted, official' });
      }
      const { setMarketplaceTrust } = await import('./plugins/marketplaces.js');
      const row = setMarketplaceTrust(db, req.params.id, trust);
      if (!row) return res.status(404).json({ error: 'marketplace not found' });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/marketplaces/:id/plugins', async (req, res) => {
    try {
      const { getMarketplace } = await import('./plugins/marketplaces.js');
      const row = getMarketplace(db, req.params.id);
      if (!row) return res.status(404).json({ error: 'marketplace not found' });
      res.json({ plugins: row.manifest.plugins ?? [] });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plan §3.A5: list all applied snapshots; useful for `od plugin
  // snapshots list` and the audit dashboard.
  app.get('/api/applied-plugins', (_req, res) => {
    try {
      const rows = db
        .prepare(`SELECT id FROM applied_plugin_snapshots ORDER BY applied_at DESC LIMIT 500`)
        .all();
      res.json({
        snapshots: rows.map((r) => getSnapshot(db, (r).id)).filter((x) => x !== null),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
  app.get('/api/projects/:projectId/applied-plugins', (req, res) => {
    try {
      const rows = db
        .prepare(`SELECT id FROM applied_plugin_snapshots WHERE project_id = ? ORDER BY applied_at DESC`)
        .all(req.params.projectId);
      res.json({
        snapshots: rows.map((r) => getSnapshot(db, (r).id)).filter((x) => x !== null),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Phase 4 / spec §14 — exporter route. Materialises a publish-ready
  // folder from the snapshot behind a given project (or an explicit
  // snapshot id). The daemon writes through `outDir` on the host
  // filesystem, so the CLI is the canonical caller; the route stays
  // local-loopback-only.
  app.post('/api/applied-plugins/export', requireLocalDaemonRequest, async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const target = body.target === 'od' || body.target === 'claude-plugin' || body.target === 'agent-skill'
        ? body.target
        : null;
      if (!target) {
        return res.status(400).json({ error: 'target must be one of: od, claude-plugin, agent-skill' });
      }
      const outDir = typeof body.outDir === 'string' && body.outDir.length > 0
        ? body.outDir
        : null;
      if (!outDir) {
        return res.status(400).json({ error: 'outDir is required' });
      }
      const { exportPlugin, ExportError } = await import('./plugins/export.js');
      try {
        const result = await exportPlugin({
          db,
          target,
          outDir,
          ...(typeof body.snapshotId === 'string' ? { snapshotId: body.snapshotId } : {}),
          ...(typeof body.projectId  === 'string' ? { projectId:  body.projectId  } : {}),
        });
        res.json({ ok: true, ...result });
      } catch (err) {
        if (err instanceof ExportError) {
          return res.status(404).json({ error: err.message });
        }
        throw err;
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Plan §3.A5 / spec §16 Phase 5: operator escape hatch for forced
  // snapshot pruning. The periodic worker (`startSnapshotGc`) runs the
  // unreferenced-TTL sweep automatically; this endpoint additionally
  // accepts `{ before: <unix-ms> }` to force-delete unreferenced rows
  // older than the cutoff. Referenced rows (run_id IS NOT NULL) stay
  // pinned forever per PB2 reproducibility-first.
  app.post('/api/applied-plugins/prune', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const before = typeof body.before === 'number' ? body.before : undefined;
      const result = pruneExpiredSnapshots(db, before ? { before } : {});
      // Plan §3.JJ1 — emit a 'plugin.snapshot-pruned' event when
      // anything was actually removed, so ops can track GC churn
      // via the live tail.
      if (result.removed > 0) {
        try {
          const { recordPluginEvent } = await import('./plugins/events.js');
          recordPluginEvent({
            kind:     'plugin.snapshot-pruned',
            pluginId: '',
            details:  { removed: result.removed, ...(before ? { before } : {}) },
          });
        } catch { /* best-effort */ }
      }
      res.json({ ok: true, removed: result.removed, ids: result.ids });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Phase 2A: GenUI surface read/write + devloop iteration history + replay.
  // Spec §10.3 for the surface lifecycle, §10.2 for devloop, §11.5 for the
  // route shapes. The surface writers go through `apps/daemon/src/genui/store.ts`
  // (sole writer of `genui_surfaces`) so the F8 cross-conversation cache stays
  // intact.
  app.get('/api/runs/:runId/genui', (req, res) => {
    try {
      const surfaces = listSurfacesForRun(db, req.params.runId);
      res.json({ runId: req.params.runId, surfaces });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/projects/:projectId/genui', (req, res) => {
    try {
      const surfaces = listSurfacesForProject(db, req.params.projectId);
      res.json({ projectId: req.params.projectId, surfaces });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/runs/:runId/genui/:surfaceId/respond', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const value = 'value' in body ? body.value : null;
      const respondedBy =
        body.respondedBy === 'agent' || body.respondedBy === 'auto'
          ? body.respondedBy
          : 'user';
      // The CLI / web pass `surfaceId` (the plugin-declared id) — look up
      // the matching pending row scoped to the run, then write through.
      const stmt = db.prepare(
        `SELECT id FROM genui_surfaces
          WHERE run_id = ? AND surface_id = ? AND status = 'pending'
          ORDER BY requested_at DESC LIMIT 1`,
      );
      const row = stmt.get(req.params.runId, req.params.surfaceId) as { id?: string } | undefined;
      if (!row?.id) {
        return res.status(404).json({ error: 'no pending surface for runId/surfaceId' });
      }
      const updated = respondSurfaceRow(db, { rowId: row.id, value, respondedBy });

      // Plan §3.R1 / spec §10.3 / §21.5 — auto-bridge for the
      // diff-review choice surface. When the surface id matches the
      // auto-derived prefix, we immediately persist the decision into
      // the run's project cwd so the next pipeline stage (handoff,
      // typically) sees `<cwd>/review/decision.json` without a second
      // turn through the agent. Best-effort: failures don't block the
      // 200 response — the agent or a follow-up call can retry.
      let diffReviewBridge: { ok: boolean; error?: string } | undefined;
      if (isDiffReviewSurfaceId(req.params.surfaceId)) {
        try {
          const run = design.runs.get(req.params.runId);
          const projectId = (run as { projectId?: string | null } | undefined)?.projectId ?? null;
          if (projectId) {
            const project = getProject(db, projectId);
            const metadata = project?.metadata && typeof project.metadata === 'string'
              ? JSON.parse(project.metadata)
              : project?.metadata ?? undefined;
            const cwd = resolveProjectDir(PROJECTS_DIR, projectId, metadata);
            const bridgeResult = await applyDiffReviewDecisionToCwd({
              cwd,
              value,
              reviewer: respondedBy === 'agent' || respondedBy === 'auto' ? 'agent' : 'user',
            });
            diffReviewBridge = bridgeResult.ok ? { ok: true } : { ok: false, error: bridgeResult.error };
          } else {
            diffReviewBridge = { ok: false, error: 'run is not linked to a project' };
          }
        } catch (err) {
          diffReviewBridge = { ok: false, error: (err as Error).message };
          console.warn('[plugins] diff-review bridge failed:', err);
        }
      }

      const responsePayload: Record<string, unknown> = { ok: true, surface: updated };
      if (diffReviewBridge) responsePayload.diffReviewBridge = diffReviewBridge;
      res.json(responsePayload);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/projects/:projectId/genui/:surfaceId/revoke', (req, res) => {
    try {
      const changed = revokeProjectSurface(db, {
        projectId: req.params.projectId,
        surfaceId: req.params.surfaceId,
      });
      res.json({ ok: true, invalidated: changed });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/projects/:projectId/genui/prefill', (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const snapshotId = typeof body.snapshotId === 'string' ? body.snapshotId : '';
      const surfaceId  = typeof body.surfaceId  === 'string' ? body.surfaceId  : '';
      const persist    = body.persist === 'run' || body.persist === 'conversation' || body.persist === 'project'
        ? body.persist
        : 'project';
      const kind = body.kind === 'form' || body.kind === 'choice' || body.kind === 'oauth-prompt'
        ? body.kind
        : 'confirmation';
      if (!snapshotId || !surfaceId) {
        return res.status(400).json({ error: 'snapshotId and surfaceId are required' });
      }
      const row = prefillProjectSurface(db, {
        projectId:        req.params.projectId,
        pluginSnapshotId: snapshotId,
        surfaceId,
        kind,
        persist,
        value:            'value' in body ? body.value : null,
        schema:           body.schema,
        expiresAt:        typeof body.expiresAt === 'number' ? body.expiresAt : null,
      });
      res.json({ ok: true, surface: row });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/runs/:runId/genui/:surfaceId', (req, res) => {
    try {
      const row = db.prepare(
        `SELECT id FROM genui_surfaces
          WHERE run_id = ? AND surface_id = ?
          ORDER BY requested_at DESC LIMIT 1`,
      ).get(req.params.runId, req.params.surfaceId) as { id?: string } | undefined;
      if (!row?.id) return res.status(404).json({ error: 'surface not found' });
      const surface = getSurface(db, row.id);
      if (!surface) return res.status(404).json({ error: 'surface not found' });
      // Plan §6 Phase 2A.5 — enrich the response with the surface
      // spec (incl. schema, prompt, persist tier) pulled out of the
      // pinned AppliedPluginSnapshot. This is what `od ui show`
      // returns to headless callers so a code agent can inspect the
      // JSON Schema before responding via `od ui respond --value-json`.
      // The store only persists `schemaDigest` (for the cross-conv
      // cache); the canonical schema lives on the snapshot.
      let spec = null;
      if (surface.pluginSnapshotId) {
        const snap = getSnapshot(db, surface.pluginSnapshotId);
        if (snap && Array.isArray(snap.genuiSurfaces)) {
          spec = snap.genuiSurfaces.find((s) => s?.id === surface.surfaceId) ?? null;
        }
      }
      res.json({ ...surface, spec });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/runs/:runId/devloop-iterations', (req, res) => {
    try {
      const iterations = listIterationsForRun(db, req.params.runId);
      res.json({ runId: req.params.runId, iterations });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Replay: rebuild a run by reading its `applied_plugin_snapshot_id`
  // and returning the snapshot for the caller (CLI / agent driver) to
  // re-launch with. Phase 2A keeps replay headless: the daemon does not
  // auto-restart the agent — it returns the materialized inputs that
  // would re-produce the run if re-applied. Spec §8.2.1 invariants
  // guarantee byte-equality across replays.
  app.post('/api/runs/:runId/replay', (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const explicitSnapshotId = typeof body.snapshotId === 'string' ? body.snapshotId : '';
      let snapshotId = explicitSnapshotId;
      if (!snapshotId) {
        // Phase 2A keeps `runs` in-memory; the caller must pass `snapshotId`
        // (e.g. the value persisted on the client after the original apply).
        // Once `runs.applied_plugin_snapshot_id` lands as a SQL column, the
        // server resolves the link itself.
        return res.status(400).json({
          error: 'snapshotId is required (runs are in-memory; pass the snapshotId returned by /api/plugins/:id/apply)',
        });
      }
      const snapshot = getSnapshot(db, snapshotId);
      if (!snapshot) return res.status(404).json({ error: 'snapshot not found' });
      res.json({
        ok:        true,
        runId:     req.params.runId,
        snapshotId,
        snapshot,
        // The caller re-launches the agent by re-applying these inputs;
        // the digest match guarantees byte-equality (§8.2.1).
        rerun: {
          pluginId:             snapshot.pluginId,
          pluginSpecVersion:    snapshot.pluginSpecVersion,
          pluginVersion:        snapshot.pluginVersion,
          inputs:               snapshot.inputs,
          manifestSourceDigest: snapshot.manifestSourceDigest,
        },
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/prompt-templates', async (_req, res) => {
    try {
      const templates = await listPromptTemplates(PROMPT_TEMPLATES_DIR);
      res.json({
        promptTemplates: templates.map(({ prompt: _prompt, ...rest }) => rest),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/prompt-templates/:surface/:id', async (req, res) => {
    try {
      const tpl = await readPromptTemplate(
        PROMPT_TEMPLATES_DIR,
        req.params.surface,
        req.params.id,
      );
      if (!tpl)
        return res.status(404).json({ error: 'prompt template not found' });
      res.json({ promptTemplate: tpl });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Showcase HTML for a design system — palette swatches, typography
  // samples, sample components, and the full DESIGN.md rendered as prose.
  // Built at request time from the on-disk DESIGN.md so any update to the
  // file shows up on the next view, no rebuild needed.
  app.get('/api/design-systems/:id/preview', async (req, res) => {
    try {
      const body = await readAvailableDesignSystem(req.params.id);
      if (body === null)
        return res.status(404).type('text/plain').send('not found');
      const html = renderDesignSystemPreview(req.params.id, body);
      res.type('text/html').send(html);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  // Marketing-style showcase derived from the same DESIGN.md — full landing
  // page parameterised by the system's tokens. Same lazy-render strategy as
  // /preview: built at request time, no caching.
  app.get('/api/design-systems/:id/showcase', async (req, res) => {
    try {
      const compiledHtml = await readCompiledShowcaseHtml(req.params.id);
      if (compiledHtml !== null) return res.type('text/html').send(compiledHtml);
      const body = await readAvailableDesignSystem(req.params.id);
      if (body === null)
        return res.status(404).type('text/plain').send('not found');
      const html = renderDesignSystemShowcase(req.params.id, body);
      res.type('text/html').send(html);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  // Static assets of a react-bundle design system (icon/vector SVGs the
  // compiled showcase lazy-fetches). express res.sendFile with a root pins
  // reads inside the bundle's assets dir (traversal rejected).
  // Machine-readable wireframe→component map of a Figma-imported design
  // system (written by figma-ds-import at import time). The ux-spec preview's
  // component-assignment UI reads it to offer per-slug candidates.
  app.get('/api/design-systems/:id/wireframe-map', async (req, res) => {
    const id = req.params.id;
    const slug = typeof id === 'string' && id.startsWith('user:') ? id.slice('user:'.length) : id;
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return res.status(404).json({ error: 'not found' });
    }
    try {
      const raw = await fs.promises.readFile(
        path.join(USER_DESIGN_SYSTEMS_DIR, slug, 'react', 'wireframe-map.json'),
        'utf8',
      );
      res.type('application/json').send(raw);
    } catch {
      res.status(404).json({ error: 'design system has no wireframe map — re-import it from the Figma zips' });
    }
  });

  // Persist a component assignment made in the wireframe preview: overwrite
  // ONE self-contained wireframes/<id>.html file.
  app.put('/api/projects/:id/wireframe', async (req, res) => {
    try {
      const projectId = req.params.id;
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'project not found' });
      const rel = typeof req.body?.path === 'string' ? req.body.path : '';
      if (!/^(?:[A-Za-z0-9._-]+\/)*wireframes\/[A-Za-z0-9._-]+\.html$/.test(rel) || rel.includes('..')) {
        return res.status(400).json({ error: 'path must be <…>/wireframes/<id>.html' });
      }
      const html = req.body?.html;
      if (typeof html !== 'string') {
        return res.status(400).json({ error: 'html (the wireframe document) is required' });
      }
      await writeProjectFile(PROJECTS_DIR, projectId, rel, Buffer.from(html, 'utf8'), {}, project.metadata);
      res.json({ ok: true, path: rel });
    } catch (err) {
      res.status(500).json({ error: String((err as Error)?.message ?? err) });
    }
  });

  app.get('/api/design-systems/:id/react-assets/*assetPath', async (req, res) => {
    const id = req.params.id;
    const slug = typeof id === 'string' && id.startsWith('user:') ? id.slice('user:'.length) : id;
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return res.status(404).type('text/plain').send('not found');
    }
    const assetsDir = path.join(USER_DESIGN_SYSTEMS_DIR, slug, 'react', 'assets');
    const rel = [req.params.assetPath ?? []].flat().join('/');
    res.sendFile(rel, { root: assetsDir }, (err) => {
      if (err && !res.headersSent) res.status(404).type('text/plain').send('not found');
    });
  });

  // Phase C of the design-system-import spec: stage a react-bundle design
  // system's compiled source into a UI-Spec (React DS) run cwd. The bundle
  // lands under react-ds/ exactly where the ui-react-ds template expects it —
  // component/lib/style source at src/ds/**, lazy-fetched icon SVGs at
  // public/assets/ (vite copies them into dist/assets/, which is where the
  // bundle runtime's relative ASSET_BASE resolves). Re-staged wholesale on
  // every run so a re-imported design system propagates.
  async function stageReactDsBundle(id, projectId, wfDir) {
    const slug = typeof id === 'string' && id.startsWith('user:') ? id.slice('user:'.length) : id;
    const bundleRoot = path.join(USER_DESIGN_SYSTEMS_DIR, slug, 'react');
    const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
    const runCwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;
    const target = path.join(runCwd, 'react-ds');
    const copies = [
      ['components', path.join('src', 'ds', 'components')],
      ['lib', path.join('src', 'ds', 'lib')],
      ['styles', path.join('src', 'ds', 'styles')],
      ['docs', path.join('src', 'ds', 'docs')],
      ['STYLE-GUIDE.md', path.join('src', 'ds', 'docs', 'STYLE-GUIDE.md')],
      ['assets', path.join('public', 'assets')],
    ];
    for (const [from, to] of copies) {
      const src = path.join(bundleRoot, from);
      const exists = await fs.promises.access(src).then(() => true, () => false);
      if (!exists) continue;
      const dest = path.join(target, to);
      await fs.promises.rm(dest, { recursive: true, force: true });
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.cp(src, dest, { recursive: true });
    }
    // The bundle is machine-generated and carries minor strict-mode gaps
    // (variant props missing from the Props type, untyped window globals).
    // The build gate must fail on AGENT code only — mute the checker inside
    // the staged ds tree; its exported prop types still flow to consumers.
    await prependTsNocheck(path.join(target, 'src', 'ds'));
    // Target marker for the builder/verify gate: WHICH target this staged
    // bundle serves and whether the app must be responsive (websites) or a
    // fixed phone viewport (mobile app — media queries forbidden). Dot-file →
    // invisible to snapshot/push/re-run-clear; rewritten on every staging.
    // Legacy single-build runs (no target segment) mark target null,
    // responsive false — today's single builds are the fixed mobile layout.
    const segments = (wfDir ?? '').split('/');
    const { UI_TARGETS, UI_TARGET_IDS } = await import('@open-design/contracts');
    const markerTarget = UI_TARGET_IDS.map((t) => UI_TARGETS[t]).find((d) => d.dir === segments[1]);
    await fs.promises.mkdir(target, { recursive: true });
    await fs.promises.writeFile(
      path.join(target, '.od-target.json'),
      `${JSON.stringify(
        { target: markerTarget?.id ?? null, responsive: markerTarget?.responsive ?? false },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  async function prependTsNocheck(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await prependTsNocheck(p);
      } else if (/\.tsx?$/.test(entry.name)) {
        const text = await fs.promises.readFile(p, 'utf8');
        if (!text.startsWith('// @ts-nocheck')) {
          await fs.promises.writeFile(p, `// @ts-nocheck\n${text}`, 'utf8');
        }
      }
    }
  }

  // React-bundle detail for a Figma-imported design system: inventory counts
  // plus the style-guide and component-catalog markdown for the detail modal.
  app.get('/api/design-systems/:id/react-info', async (req, res) => {
    try {
      const info = await readReactBundleInfo(req.params.id);
      if (info === null)
        return res.status(404).json({ error: 'not a react-bundle design system' });
      res.json(info);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Pre-built example HTML for a skill — what a typical artifact from this
  // skill looks like. Lets users browse skills without running an agent.
  //
  // The skill's `id` (from SKILL.md frontmatter `name`) can differ from its
  // on-disk folder name (e.g. id `magazine-web-ppt` lives in `skills/guizang-ppt/`),
  // so we resolve the actual directory via listSkills() rather than guessing.
  //
  // Resolution order:
  //   1. Derived id (`<parent>:<child>`):
  //      <parentDir>/examples/<child>.html — pre-baked single-file sample.
  //      Subfolder layouts (e.g. live-artifact's
  //      `examples/<name>/template.html`) are intentionally not served:
  //      they still contain `{{data.x}}` placeholders that only the
  //      daemon-side renderer fills in, and serving the raw template
  //      would render visible placeholder braces in the gallery.
  //   2. <skillDir>/example.html — fully-baked static example (preferred)
  //   3. <skillDir>/assets/template.html  +
  //      <skillDir>/assets/example-slides.html — assemble at request time
  //      by replacing the `<!-- SLIDES_HERE -->` marker with the snippet
  //      and patching the placeholder <title>. Lets a skill ship one
  //      canonical seed plus a small content fragment, so the example
  //      never drifts from the seed.
  //   4. <skillDir>/assets/template.html — raw template, no content slides
  //   5. <skillDir>/assets/index.html — generic fallback
  //   6. First .html in <skillDir>/examples/ — used as a friendly fallback
  //      so a skill that aggregates examples (like live-artifact) still has
  //      a real preview on its parent card instead of returning 404.
  app.get('/api/skills/:id/example', async (req, res) => {
    try {
      const skills = await listAllSkills();

      // 1. Derived `<parent>:<child>` id — resolve straight to the matching
      // file under <parentDir>/examples/. Done before findSkillById so the
      // parent's normal fallback chain never accidentally serves a stale
      // file when a sample is missing (we'd rather 404 explicitly).
      const derived = splitDerivedSkillId(req.params.id);
      if (derived) {
        const parent = findSkillById(skills, derived.parentId);
        if (!parent) {
          return res.status(404).type('text/plain').send('skill not found');
        }
        const candidate = path.join(
          parent.dir,
          'examples',
          `${derived.childKey}.html`,
        );
        if (fs.existsSync(candidate)) {
          const html = await fs.promises.readFile(candidate, 'utf8');
          return res
            .type('text/html')
            .send(rewriteSkillAssetUrls(html, parent.id));
        }
        return res
          .status(404)
          .type('text/plain')
          .send('derived example not found');
      }

      const skill = findSkillById(skills, req.params.id);
      if (!skill) {
        return res.status(404).type('text/plain').send('skill not found');
      }

      const baked = path.join(skill.dir, 'example.html');
      if (fs.existsSync(baked)) {
        const html = await fs.promises.readFile(baked, 'utf8');
        return res
          .type('text/html')
          .send(rewriteSkillAssetUrls(html, skill.id));
      }

      const tpl = path.join(skill.dir, 'assets', 'template.html');
      const slides = path.join(skill.dir, 'assets', 'example-slides.html');
      if (fs.existsSync(tpl) && fs.existsSync(slides)) {
        try {
          const tplHtml = await fs.promises.readFile(tpl, 'utf8');
          const slidesHtml = await fs.promises.readFile(slides, 'utf8');
          const assembled = assembleExample(tplHtml, slidesHtml, skill.name);
          return res
            .type('text/html')
            .send(rewriteSkillAssetUrls(assembled, skill.id));
        } catch {
          // Fall through to raw template on read failure.
        }
      }
      if (fs.existsSync(tpl)) {
        const html = await fs.promises.readFile(tpl, 'utf8');
        return res
          .type('text/html')
          .send(rewriteSkillAssetUrls(html, skill.id));
      }
      const idx = path.join(skill.dir, 'assets', 'index.html');
      if (fs.existsSync(idx)) {
        const html = await fs.promises.readFile(idx, 'utf8');
        return res
          .type('text/html')
          .send(rewriteSkillAssetUrls(html, skill.id));
      }

      // Friendly fallback for skills that aggregate examples in a sibling
      // `examples/` folder (e.g. live-artifact). The parent card would
      // otherwise 404 even though plenty of perfectly valid samples ship
      // alongside SKILL.md; pick the first .html file alphabetically so
      // direct URL access (e.g. deep links) shows something representative.
      // Subfolder layouts are excluded for the same reason as the derived
      // resolver above — their `template.html` still has unresolved
      // `{{data.x}}` placeholders.
      const examplesDir = path.join(skill.dir, 'examples');
      if (fs.existsSync(examplesDir)) {
        let entries: string[] = [];
        try {
          entries = await fs.promises.readdir(examplesDir);
        } catch {
          entries = [];
        }
        entries.sort();
        for (const name of entries) {
          if (name.startsWith('.')) continue;
          if (!name.toLowerCase().endsWith('.html')) continue;
          const direct = path.join(examplesDir, name);
          try {
            const html = await fs.promises.readFile(direct, 'utf8');
            return res
              .type('text/html')
              .send(rewriteSkillAssetUrls(html, skill.id));
          } catch {
            continue;
          }
        }
      }

      res
        .status(404)
        .type('text/plain')
        .send(
          'no example.html, assets/template.html, assets/index.html, or examples/*.html for this skill',
        );
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  // Static assets shipped beside a skill's example/template HTML. Lets the
  // example HTML reference `./assets/foo.png`-style paths that resolve
  // correctly when the response is loaded into a sandboxed `srcdoc` iframe
  // (where relative URLs would otherwise resolve against `about:srcdoc`).
  // The example response above rewrites `./assets/<file>` into a request
  // against this route; we still keep the on-disk paths human-friendly so
  // contributors can preview `example.html` straight from disk.
  app.get('/api/skills/:id/assets/*splat', async (req, res) => {
    try {
      const skills = await listAllSkills();
      const skill = findSkillById(skills, req.params.id);
      if (!skill) {
        return res.status(404).type('text/plain').send('skill not found');
      }
      const splatParam = req.params.splat;
      const relPath = Array.isArray(splatParam) ? splatParam.join('/') : String(splatParam || '');
      const assetsRoot = path.resolve(skill.dir, 'assets');
      const target = path.resolve(assetsRoot, relPath);
      if (target !== assetsRoot && !target.startsWith(assetsRoot + path.sep)) {
        return res.status(400).type('text/plain').send('invalid asset path');
      }
      if (!fs.existsSync(target)) {
        return res.status(404).type('text/plain').send('asset not found');
      }
      // The example HTML is rendered inside a sandboxed iframe (Origin: null).
      // Mirror the project /raw route's allowance so the iframe can fetch the
      // image bytes; same-origin web callers do not need this header.
      if (req.headers.origin === 'null') {
        res.header('Access-Control-Allow-Origin', '*');
      }
      await res.type(mimeFor(target)).sendFile(target);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  app.post('/api/upload', upload.array('images', 8), (req, res) => {
    const files = (req.files || []).map((f) => ({
      name: f.originalname,
      path: f.path,
      size: f.size,
    }));
    res.json({ files });
  });

  // Persist a generated artifact (HTML) to disk so the user can re-open it
  // in their browser or hand it off. Returns the on-disk path + a served URL.
  // The body is also passed through the anti-slop linter; findings are
  // returned alongside the path so the UI can render a P0/P1 badge and the
  // chat layer can splice them into a system reminder for the agent.
  app.post('/api/artifacts/save', (req, res) => {
    try {
      const { identifier, title, html } = req.body || {};
      if (typeof html !== 'string' || html.length === 0) {
        return res.status(400).json({ error: 'html required' });
      }
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const slug = sanitizeSlug(identifier || title || 'artifact');
      const dir = path.join(ARTIFACTS_DIR, `${stamp}-${slug}`);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'index.html');
      fs.writeFileSync(file, html, 'utf8');
      const findings = lintArtifact(html);
      res.json({
        path: file,
        url: `/artifacts/${path.basename(dir)}/index.html`,
        lint: findings,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Standalone lint endpoint — POST raw HTML, get findings back.
  // The chat layer uses this to lint streamed-in artifacts without writing
  // them to disk first, so a P0 issue can be surfaced before save.
  app.post('/api/artifacts/lint', (req, res) => {
    try {
      const { html } = req.body || {};
      if (typeof html !== 'string' || html.length === 0) {
        return res.status(400).json({ error: 'html required' });
      }
      const findings = lintArtifact(html);
      res.json({
        findings,
        agentMessage: renderFindingsForAgent(findings),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/live-artifacts', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const artifacts = await listLiveArtifacts({
        projectsRoot: PROJECTS_DIR,
        projectId,
      });
      res.json({ artifacts });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.options('/api/live-artifacts/:artifactId/preview', requireLocalDaemonRequest, (_req, res) => {
    res.status(204).end();
  });

  app.get('/api/live-artifacts/:artifactId/preview', requireLocalDaemonRequest, async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const variant = typeof req.query.variant === 'string' ? req.query.variant : 'rendered';
      if (variant === 'template' || variant === 'rendered-source') {
        const html = await readLiveArtifactCode({
          projectsRoot: PROJECTS_DIR,
          projectId,
          artifactId: req.params.artifactId,
          variant: variant === 'template' ? 'template' : 'rendered',
        });
        setLiveArtifactCodeHeaders(res);
        return res.status(200).send(html);
      }
      if (variant !== 'rendered') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'variant must be rendered, template, or rendered-source');
      }

      const record = await ensureLiveArtifactPreview({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      setLiveArtifactPreviewHeaders(res);
      res.status(200).send(record.html);
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const record = await getLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      res.json({ artifact: record.artifact });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/live-artifacts/:artifactId/refreshes', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const refreshes = await listLiveArtifactRefreshLogEntries({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      res.json({ refreshes });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/create', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:create');
      if (!toolGrant) return;
      const { projectId, input, templateHtml, provenanceJson, createdByRunId } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (requestRunOverride(createdByRunId, toolGrant.runId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'createdByRunId is derived from the tool token', {
          details: { suppliedRunId: createdByRunId },
        });
      }

      const record = await createLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId: toolGrant.projectId,
        input: input ?? {},
        templateHtml,
        provenanceJson,
        createdByRunId: toolGrant.runId,
      });
      emitLiveArtifactEvent(toolGrant, 'created', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/tools/live-artifacts/list', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:list');
      if (!toolGrant) return;
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }

      const artifacts = await listLiveArtifacts({
        projectsRoot: PROJECTS_DIR,
        projectId: toolGrant.projectId,
      });
      res.json({ artifacts });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/update', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:update');
      if (!toolGrant) return;
      const { projectId, artifactId, input, templateHtml, provenanceJson } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (typeof artifactId !== 'string' || artifactId.length === 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'artifactId is required');
      }

      const record = await updateLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId: toolGrant.projectId,
        artifactId,
        input: input ?? {},
        templateHtml,
        provenanceJson,
      });
      emitLiveArtifactEvent(toolGrant, 'updated', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/refresh', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:refresh');
      if (!toolGrant) return;
      const { projectId, artifactId } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (typeof artifactId !== 'string' || artifactId.length === 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'artifactId is required');
      }

      let result;
      try {
        result = await refreshLiveArtifact({
          projectsRoot: PROJECTS_DIR,
          projectId: toolGrant.projectId,
          artifactId,
          onStarted: ({ refreshId }) => {
            emitLiveArtifactRefreshEvent(toolGrant, { phase: 'started', artifactId, refreshId });
          },
        });
      } catch (refreshErr) {
        emitLiveArtifactRefreshEvent(toolGrant, {
          phase: 'failed',
          artifactId,
          error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
        });
        throw refreshErr;
      }
      emitLiveArtifactRefreshEvent(toolGrant, {
        phase: 'succeeded',
        artifactId,
        refreshId: result.refresh.id,
        title: result.artifact.title,
        refreshedSourceCount: result.refresh.refreshedSourceCount,
      });
      res.json(result);
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.patch('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const record = await updateLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
        input: req.body ?? {},
      });
      emitLiveArtifactEvent({ projectId }, 'updated', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.delete('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const existing = await getLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      await deleteLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      updateProject(db, projectId, {});
      emitLiveArtifactEvent({ projectId }, 'deleted', existing.artifact);
      res.json({ ok: true });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.options('/api/live-artifacts/:artifactId/refresh', requireLocalDaemonRequest, (_req, res) => {
    res.status(204).end();
  });

  app.post('/api/live-artifacts/:artifactId/refresh', requireLocalDaemonRequest, async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      let result;
      try {
        result = await refreshLiveArtifact({
          projectsRoot: PROJECTS_DIR,
          projectId,
          artifactId: req.params.artifactId,
          onStarted: ({ refreshId }) => {
            emitLiveArtifactRefreshEvent({ projectId }, { phase: 'started', artifactId: req.params.artifactId, refreshId });
          },
        });
      } catch (refreshErr) {
        emitLiveArtifactRefreshEvent({ projectId }, {
          phase: 'failed',
          artifactId: req.params.artifactId,
          error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
        });
        throw refreshErr;
      }
      emitLiveArtifactRefreshEvent({ projectId }, {
        phase: 'succeeded',
        artifactId: req.params.artifactId,
        refreshId: result.refresh.id,
        title: result.artifact.title,
        refreshedSourceCount: result.refresh.refreshedSourceCount,
      });
      res.json(result);
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.use('/artifacts', express.static(ARTIFACTS_DIR));

  // ---- Deploy --------------------------------------------------------------

  app.get('/api/deploy/config', async (req, res) => {
    try {
      const providerId =
        typeof req.query.providerId === 'string' ? req.query.providerId : VERCEL_PROVIDER_ID;
      if (!isDeployProviderId(providerId)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'unsupported deploy provider');
      }
      /** @type {import('@open-design/contracts').DeployConfigResponse} */
      const body = publicDeployConfigForProvider(providerId, await readDeployConfig(providerId));
      res.json(body);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  app.put('/api/deploy/config', async (req, res) => {
    try {
      const input = req.body || {};
      const providerId =
        typeof input.providerId === 'string' ? input.providerId : VERCEL_PROVIDER_ID;
      if (!isDeployProviderId(providerId)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'unsupported deploy provider');
      }
      /** @type {import('@open-design/contracts').DeployConfigResponse} */
      const body = await writeDeployConfig(providerId, input);
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.get('/api/deploy/cloudflare-pages/zones', async (_req, res) => {
    try {
      /** @type {import('@open-design/contracts').CloudflarePagesZonesResponse} */
      const body = await listCloudflarePagesZones(await readDeployConfig(CLOUDFLARE_PAGES_PROVIDER_ID));
      res.json(body);
    } catch (err) {
      const status = err instanceof DeployError ? err.status : 400;
      const init =
        err instanceof DeployError && err.details
          ? { details: err.details }
          : {};
      sendApiError(res, status, 'BAD_REQUEST', String(err?.message || err), init);
    }
  });

  app.get('/api/projects/:id/deployments', (req, res) => {
    try {
      /** @type {import('@open-design/contracts').ProjectDeploymentsResponse} */
      const body = { deployments: publicDeployments(listDeployments(db, req.params.id)) };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.post('/api/projects/:id/deploy', async (req, res) => {
    try {
      const { fileName, providerId = VERCEL_PROVIDER_ID, cloudflarePages } = req.body || {};
      if (!isDeployProviderId(providerId)) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'unsupported deploy provider',
        );
      }
      if (typeof fileName !== 'string' || !fileName.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'fileName required');
      }

      const prior = getDeployment(db, req.params.id, fileName, providerId);
      const deployProject = getProject(db, req.params.id);
      const files = await buildDeployFileSet(
        PROJECTS_DIR,
        req.params.id,
        fileName,
        { metadata: deployProject?.metadata },
      );
      const project = getProject(db, req.params.id);
      const cloudflarePagesProjectName =
        providerId === CLOUDFLARE_PAGES_PROVIDER_ID
          ? cloudflarePagesProjectNameForDeploy(db, req.params.id, project?.name, prior)
          : '';
      const result = providerId === CLOUDFLARE_PAGES_PROVIDER_ID
        ? await deployToCloudflarePages({
            config: {
              ...await readDeployConfig(CLOUDFLARE_PAGES_PROVIDER_ID),
              projectName: cloudflarePagesProjectName,
            },
            files,
            projectId: req.params.id,
            cloudflarePages,
            priorMetadata: prior?.providerMetadata,
          })
        : await deployToVercel({
            config: await readDeployConfig(VERCEL_PROVIDER_ID),
            files,
            projectId: req.params.id,
          });
      const now = Date.now();
      /** @type {import('@open-design/contracts').DeployProjectFileResponse} */
      const body = upsertDeployment(db, {
        id: prior?.id ?? randomUUID(),
        projectId: req.params.id,
        fileName,
        providerId,
        url: result.url,
        deploymentId: result.deploymentId,
        deploymentCount: (prior?.deploymentCount ?? 0) + 1,
        target: 'preview',
        status: result.status,
        statusMessage: result.statusMessage,
        reachableAt: result.reachableAt,
        cloudflarePages: result.cloudflarePages,
        providerMetadata:
          providerId === CLOUDFLARE_PAGES_PROVIDER_ID
            ? (result.providerMetadata ?? cloudflarePagesDeploymentMetadata(cloudflarePagesProjectName))
            : prior?.providerMetadata,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      });
      res.json(publicDeployment(body));
    } catch (err) {
      const status = err instanceof DeployError ? err.status : 400;
      const init =
        err instanceof DeployError && err.details
          ? { details: err.details }
          : {};
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
        init,
      );
    }
  });

  app.post('/api/projects/:id/deploy/preflight', async (req, res) => {
    try {
      const { fileName, providerId = VERCEL_PROVIDER_ID } = req.body || {};
      if (!isDeployProviderId(providerId)) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'unsupported deploy provider',
        );
      }
      if (typeof fileName !== 'string' || !fileName.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'fileName required');
      }
      const preflightProject = getProject(db, req.params.id);
      /** @type {import('@open-design/contracts').DeployPreflightResponse} */
      const body = await prepareDeployPreflight(
        PROJECTS_DIR,
        req.params.id,
        fileName,
        { metadata: preflightProject?.metadata, providerId },
      );
      res.json(body);
    } catch (err) {
      // DeployError is a known/expected outcome (validation, missing file).
      // Anything else points at a bug or an unexpected runtime state, so
      // surface it in the daemon log without leaking internals to the
      // client which still gets a generic 400.
      if (!(err instanceof DeployError)) {
        console.error('[deploy/preflight]', err);
      }
      const status = err instanceof DeployError ? err.status : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  app.post('/api/projects/:id/finalize/anthropic', async (req, res) => {
    const { apiKey, baseUrl, model, maxTokens } = req.body || {};
    try {
      // Centralized path-traversal guard. `isSafeId` (apps/daemon/src/projects.ts)
      // rejects pure-dot ids (`.`, `..`, etc.) which would otherwise pass
      // the char-class regex and resolve to the parent directory under
      // path.join. Express decodes percent-encoded `%2e%2e` to `..` before
      // we see it, so this check covers both URL-supplied and stored-row
      // attack vectors.
      if (!isSafeId(req.params.id)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'invalid project id');
      }

      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'apiKey is required');
      }
      if (typeof model !== 'string' || !model.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'model is required');
      }
      if (baseUrl !== undefined) {
        if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
          return sendApiError(res, 400, 'BAD_REQUEST', 'baseUrl must be a non-empty string when provided');
        }
        const validated = validateExternalApiBaseUrl(baseUrl);
        if (validated.error) {
          return sendApiError(
            res,
            validated.forbidden ? 403 : 400,
            validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
            validated.error,
          );
        }
      }
      if (maxTokens !== undefined && (typeof maxTokens !== 'number' || maxTokens <= 0)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'maxTokens must be a positive number when provided');
      }

      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }

      const result = await finalizeDesignPackage(
        db,
        PROJECTS_DIR,
        DESIGN_SYSTEMS_DIR,
        req.params.id,
        { apiKey, baseUrl, model, maxTokens },
      );
      res.json(result);
    } catch (err) {
      // Concurrent finalize - the lockfile was already held by another
      // call. Caller can retry after a short wait; not a client error.
      // Maps to the shared CONFLICT code per @lefarcen P2 on PR #832.
      if (err instanceof FinalizePackageLockedError) {
        return sendApiError(res, 409, 'CONFLICT', err.message);
      }

      // Upstream Anthropic error - status-aware mapping using shared
      // ApiErrorCode values. Run the raw upstream body through
      // redactSecrets so the API key cannot leak even if Anthropic
      // echoes the inbound headers. Codes per @lefarcen P2 on PR #832:
      // 401 -> UNAUTHORIZED, 429 -> RATE_LIMITED, others -> UPSTREAM_UNAVAILABLE.
      if (err instanceof FinalizeUpstreamError) {
        const safeDetails = redactSecrets(err.rawText || '', [apiKey]);
        const init = safeDetails ? { details: safeDetails } : {};
        if (err.status === 401) {
          return sendApiError(res, 401, 'UNAUTHORIZED', err.message, init);
        }
        if (err.status === 429) {
          return sendApiError(res, 429, 'RATE_LIMITED', err.message, init);
        }
        return sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', err.message, init);
      }

      // The blocking call hit our 120s AbortController timeout - or the
      // caller passed an already-aborted signal. Either way, surface as
      // 503 with the shared UPSTREAM_UNAVAILABLE code (no dedicated
      // TIMEOUT code in the contracts ApiErrorCode union).
      const errName =
        err && typeof err === 'object' && 'name' in err ? (err as { name?: unknown }).name : '';
      if (errName === 'AbortError') {
        return sendApiError(res, 503, 'UPSTREAM_UNAVAILABLE', 'finalize timed out');
      }

      // Unexpected runtime failure (file IO, db access, prompt build).
      // Log via console.error per the daemon convention; client sees a
      // generic 500 with the shared INTERNAL_ERROR code. Run the message
      // through redactSecrets defensively.
      console.error('[finalize/anthropic]', err);
      const safeMsg = redactSecrets(String(err?.message || err), [apiKey]);
      return sendApiError(res, 500, 'INTERNAL_ERROR', safeMsg);
    }
  });

  app.post(
    '/api/projects/:id/deployments/:deploymentId/check-link',
    async (req, res) => {
      try {
        const existing = getDeploymentById(
          db,
          req.params.id,
          req.params.deploymentId,
        );
        if (!existing) {
          return sendApiError(
            res,
            404,
            'FILE_NOT_FOUND',
            'deployment not found',
          );
        }
        const stableCloudflareProjectName =
          existing.providerId === CLOUDFLARE_PAGES_PROVIDER_ID
            ? cloudflarePagesProjectNameFromDeployment(existing)
            : '';
        if (existing.providerId === CLOUDFLARE_PAGES_PROVIDER_ID && existing.cloudflarePages?.pagesDev?.url) {
          const checked = await checkCloudflarePagesDeploymentLinks(existing);
          const now = Date.now();
          /** @type {import('@open-design/contracts').CheckDeploymentLinkResponse} */
          const body = upsertDeployment(db, {
            ...existing,
            ...checked,
            reachableAt: checked.status === 'ready' ? now : existing.reachableAt,
            updatedAt: now,
          });
          return res.json(publicDeployment(body));
        }
        const checkUrl = stableCloudflareProjectName
          ? `https://${stableCloudflareProjectName}.pages.dev`
          : existing.url;
        const result = await checkDeploymentUrl(checkUrl);
        const now = Date.now();
        /** @type {import('@open-design/contracts').CheckDeploymentLinkResponse} */
        const body = upsertDeployment(db, {
          ...existing,
          url: checkUrl || existing.url,
          status: result.reachable ? 'ready' : result.status || 'link-delayed',
          statusMessage: result.reachable
            ? 'Public link is ready.'
            : result.statusMessage ||
              'Vercel is still preparing the public link.',
          reachableAt: result.reachable ? now : existing.reachableAt,
          updatedAt: now,
        });
        res.json(publicDeployment(body));
      } catch (err) {
        sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
      }
    },
  );

  // Shared device frames (iPhone, Android, iPad, MacBook, browser chrome).
  // Skills can compose multi-screen / multi-device layouts by pointing at
  // these files via `<iframe src="/frames/iphone-15-pro.html?screen=...">`.
  // No mtime-based caching — frames are static and small.
  app.use('/frames', express.static(FRAMES_DIR));

  // Project files. Each project owns a flat folder under .od/projects/<id>/
  // containing every file the user has uploaded, pasted, sketched, or that
  // the agent has generated. Names are sanitized; paths are confined to the
  // project's own folder (see apps/daemon/src/projects.ts).
  app.get('/api/projects/:id/files', async (req, res) => {
    try {
      const since = Number(req.query?.since);
      const project = getProject(db, req.params.id);
      const files = await listFiles(PROJECTS_DIR, req.params.id, {
        since: Number.isFinite(since) ? since : undefined,
        metadata: project?.metadata,
      });
      /** @type {import('@open-design/contracts').ProjectFilesResponse} */
      const body = { files };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.post('/api/projects/:id/plugins/install-folder', async (req, res) => {
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const relativePath = normalizeProjectPluginFolderPath(body.path);
      const projectRoot = resolveProjectDir(PROJECTS_DIR, req.params.id, project.metadata);
      const folder = await resolveProjectChildDirectory(projectRoot, relativePath);
      const warnings = [];
      const log = [];
      let plugin = null;
      let message = 'Install finished.';
      for await (const ev of installPlugin(db, { source: folder, roots: PLUGIN_REGISTRY_ROOTS })) {
        if (ev.message) log.push(ev.message);
        if (Array.isArray(ev.warnings)) warnings.splice(0, warnings.length, ...ev.warnings);
        if (ev.kind === 'success') {
          plugin = ev.plugin;
          message = `Installed ${ev.plugin.title}.`;
          break;
        }
        if (ev.kind === 'error') {
          message = ev.message;
          break;
        }
      }
      res.status(plugin ? 200 : 400).json({ ok: Boolean(plugin), plugin, warnings, message, log });
    } catch (err) {
      const code = err && err.code;
      const status = code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'PLUGIN_FOLDER_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  app.post('/api/projects/:id/plugins/publish-github', async (req, res) => {
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const relativePath = normalizeProjectPluginFolderPath(body.path);
      const projectRoot = resolveProjectDir(PROJECTS_DIR, req.params.id, project.metadata);
      const folder = await resolveProjectChildDirectory(projectRoot, relativePath);
      const result = await execCommandViaLoginShell(OD_NODE_BIN, [
        OD_BIN,
        'plugin',
        'publish-repo',
        folder,
        '--json',
      ], { timeout: 240_000 });
      const payload = result.stdout ? JSON.parse(result.stdout) : null;
      if (!result.ok || !payload?.ok) {
        res.status(500).json({
          ok: false,
          code: payload?.error?.label || 'publish-repo-failed',
          message: payload?.error?.stderr || payload?.error?.stdout || 'GitHub repo publish failed.',
          log: payload?.steps?.map((step) => step.stderr || step.stdout || step.command).filter(Boolean) ?? [result.stderr || result.stdout || 'publish-repo failed'],
        });
        return;
      }
      res.json({
        ok: true,
        message: payload.repoUrl ? `Published plugin to ${payload.repoUrl}.` : 'Published plugin to GitHub.',
        ...(payload.repoUrl ? { url: payload.repoUrl } : {}),
        log: payload.steps?.map((step) => step.stderr || step.stdout || step.command).filter(Boolean) ?? [],
      });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err?.message || err), log: [] });
    }
  });

  app.get('/api/projects/:id/plugin-candidates', (req, res) => {
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      const includeDismissed = req.query.includeDismissed === 'true';
      res.json({ candidates: listSkillPluginCandidates(db, req.params.id, includeDismissed) });
    } catch (err) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  app.post('/api/projects/:id/plugin-candidates/:candidateId/dismiss', (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const candidate = dismissSkillPluginCandidate(db, req.params.id, req.params.candidateId);
    if (!candidate) {
      sendApiError(res, 404, 'NOT_FOUND', 'plugin candidate not found');
      return;
    }
    if (candidate.assistantMessageId) {
      db.prepare(`DELETE FROM messages WHERE id = ?`).run(candidate.assistantMessageId);
    }
    res.json({ ok: true, candidate });
  });

  app.post('/api/projects/:id/plugin-candidates/:candidateId/draft', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      const projectRoot = resolveProjectDir(PROJECTS_DIR, req.params.id, project.metadata);
      const result = await generateSkillPluginDraft(db, projectRoot, req.params.id, req.params.candidateId);
      if (!result) {
        sendApiError(res, 404, 'NOT_FOUND', 'plugin candidate not found');
        return;
      }
      res.status(result.ok ? 200 : 422).json(result);
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err?.message || err) });
    }
  });

  app.post('/api/projects/:id/plugin-candidates/:candidateId/share-tasks', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const action = body.action === 'publish-github' || body.action === 'contribute-open-design'
        ? body.action
        : null;
      if (!action) {
        sendApiError(res, 400, 'BAD_REQUEST', 'plugin share action is required');
        return;
      }
      const projectRoot = resolveProjectDir(PROJECTS_DIR, req.params.id, project.metadata);
      const draft = await generateSkillPluginDraft(db, projectRoot, req.params.id, req.params.candidateId);
      if (!draft) {
        sendApiError(res, 404, 'NOT_FOUND', 'plugin candidate not found');
        return;
      }
      if (!draft.validation.ok) {
        res.status(422).json({
          ok: false,
          code: 'plugin-draft-invalid',
          message: 'Generated plugin draft is invalid.',
          draft,
        });
        return;
      }
      const taskId = randomUUID();
      const task = createPluginShareTask(taskId, req.params.id, {
        action,
        path: draft.draftPath,
      });
      task.status = 'running';
      notifyPluginShareTaskWaiters(task);
      void runPluginShareTask(task, draft.folder).catch((err) => {
        task.status = 'failed';
        task.error = {
          code: 'plugin-share-task-failed',
          message: String(err?.message || err),
          log: [String(err?.stack || err?.message || err)],
        };
        task.endedAt = Date.now();
        notifyPluginShareTaskWaiters(task);
      });
      res.status(202).json({
        taskId,
        action,
        path: draft.draftPath,
        status: task.status,
        startedAt: task.startedAt,
        draft,
      });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err?.message || err) });
    }
  });

  app.post('/api/projects/:id/plugins/contribute-open-design', async (req, res) => {
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const relativePath = normalizeProjectPluginFolderPath(body.path);
      const projectRoot = resolveProjectDir(PROJECTS_DIR, req.params.id, project.metadata);
      const folder = await resolveProjectChildDirectory(projectRoot, relativePath);
      const result = await execCommandViaLoginShell(OD_NODE_BIN, [
        OD_BIN,
        'plugin',
        'open-design-pr',
        folder,
        '--json',
      ], { timeout: 300_000 });
      const payload = result.stdout ? JSON.parse(result.stdout) : null;
      if (!result.ok || !payload?.ok) {
        res.status(500).json({
          ok: false,
          code: payload?.error?.label || 'open-design-pr-failed',
          message: payload?.error?.stderr || payload?.error?.stdout || 'Open Design PR creation failed.',
          log: payload?.steps?.map((step) => step.stderr || step.stdout || step.command).filter(Boolean) ?? [result.stderr || result.stdout || 'open-design-pr failed'],
        });
        return;
      }
      res.json({
        ok: true,
        message: payload.prUrl ? `Opened Open Design PR flow at ${payload.prUrl}.` : 'Opened Open Design PR flow.',
        ...(payload.prUrl ? { url: payload.prUrl } : {}),
        log: payload.steps?.map((step) => step.stderr || step.stdout || step.command).filter(Boolean) ?? [],
      });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err?.message || err), log: [] });
    }
  });

  app.post('/api/projects/:id/plugins/share-tasks', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const action = body.action === 'publish-github' || body.action === 'contribute-open-design'
        ? body.action
        : null;
      if (!action) {
        sendApiError(res, 400, 'BAD_REQUEST', 'plugin share action is required');
        return;
      }
      const relativePath = normalizeProjectPluginFolderPath(body.path);
      const projectRoot = resolveProjectDir(PROJECTS_DIR, req.params.id, project.metadata);
      const folder = await resolveProjectChildDirectory(projectRoot, relativePath);
      const taskId = randomUUID();
      const task = createPluginShareTask(taskId, req.params.id, {
        action,
        path: relativePath,
      });
      task.status = 'running';
      notifyPluginShareTaskWaiters(task);
      void runPluginShareTask(task, folder).catch((err) => {
        task.status = 'failed';
        task.error = {
          code: 'plugin-share-task-failed',
          message: String(err?.message || err),
          log: [String(err?.stack || err?.message || err)],
        };
        task.endedAt = Date.now();
        notifyPluginShareTaskWaiters(task);
      });
      res.status(202).json({
        taskId,
        action,
        path: relativePath,
        status: task.status,
        startedAt: task.startedAt,
      });
    } catch (err) {
      const code = err && err.code;
      const status = code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'PLUGIN_FOLDER_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  app.post('/api/plugins/share-tasks/:id/wait', (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const task = getLivePluginShareTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });

    const since = Number.isFinite(req.body?.since) ? Number(req.body.since) : 0;
    const requestedTimeout = Number.isFinite(req.body?.timeoutMs)
      ? Number(req.body.timeoutMs)
      : 25_000;
    const timeoutMs = Math.min(Math.max(requestedTimeout, 0), 25_000);

    const respond = () => {
      if (res.writableEnded) return;
      res.json(pluginShareTaskSnapshot(task, since));
    };

    if (PLUGIN_SHARE_TERMINAL_STATUSES.has(task.status) || task.progress.length > since) {
      return respond();
    }

    let resolved = false;
    const wake = () => {
      if (resolved) return;
      resolved = true;
      task.waiters.delete(wake);
      clearTimeout(timer);
      respond();
    };
    task.waiters.add(wake);
    const timer = setTimeout(wake, timeoutMs);
    res.on('close', wake);
  });

  app.get('/api/projects/:id/search', async (req, res) => {
    try {
      const query = String(req.query.q ?? '');
      if (!query) {
        sendApiError(res, 400, 'BAD_REQUEST', 'q query parameter is required');
        return;
      }
      const pattern = req.query.pattern ? String(req.query.pattern) : null;
      const max = Math.min(Number(req.query.max) || 200, 1000);
      const searchProject = getProject(db, req.params.id);
      const matches = await searchProjectFiles(PROJECTS_DIR, req.params.id, query, {
        pattern,
        max,
        metadata: searchProject?.metadata,
      });
      res.json({ query, matches });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  // Streams a ZIP of the project's on-disk tree so the "Download as .zip"
  // share menu can hand the user the actual files they uploaded — e.g. the
  // imported `ui-design/` folder — instead of a one-file snapshot of the
  // rendered HTML. `root` scopes the archive to a subdirectory; without
  // it, the whole project is packed.
  app.get('/api/projects/:id/archive', async (req, res) => {
    try {
      const root = typeof req.query?.root === 'string' ? req.query.root : '';
      const project = getProject(db, req.params.id);
      const { buffer, baseName } = await buildProjectArchive(
        PROJECTS_DIR,
        req.params.id,
        root,
        project?.metadata,
      );
      const fallbackName = project?.name || req.params.id;
      const fileSlug = sanitizeArchiveFilename(baseName || fallbackName) || 'project';
      const filename = `${fileSlug}.zip`;
      // RFC 5987 dance: legacy `filename=` carries an ASCII fallback, while
      // `filename*=UTF-8''…` lets modern browsers pick up project names
      // with non-ASCII characters (accents, CJK, etc.) without mojibake.
      const asciiFallback =
        filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || 'project.zip';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(buffer);
    } catch (err) {
      const code = err && err.code;
      const status = code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  // Batch archive: accepts a list of file names and returns a ZIP of just
  // those files. Used by the Design Files panel multi-select download.
  app.post('/api/projects/:id/archive/batch', async (req, res) => {
    try {
      const { files } = req.body || {};
      if (!Array.isArray(files) || files.length === 0) {
        sendApiError(res, 400, 'BAD_REQUEST', 'files must be a non-empty array');
        return;
      }
      const project = getProject(db, req.params.id);
      const { buffer } = await buildBatchArchive(
        PROJECTS_DIR,
        req.params.id,
        files,
        project?.metadata,
      );
      const fileSlug = sanitizeArchiveFilename(project?.name || req.params.id) || 'project';
      const filename = `${fileSlug}.zip`;
      const asciiFallback =
        filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || 'project.zip';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(buffer);
    } catch (err) {
      const code = err && err.code;
      const status = code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  // Preflight for the raw file route. Current artifact fetches are simple GETs
  // (no preflight needed), but an explicit handler future-proofs the route if
  // artifacts ever add custom request headers.
  app.options(/^\/api\/projects\/([^/]+)\/raw\/(.+)$/u, (req, res) => {
    if (req.headers.origin === 'null' || req.headers.origin === 'od://app') {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
    }
    res.sendStatus(204);
  });

  app.get(/^\/api\/projects\/([^/]+)\/raw\/(.+)$/u, async (req, res) => {
    try {
      const projectId = String(req.params[0] ?? '');
      const relPath = String(req.params[1] ?? '');
      const project = getProject(db, projectId);
      const file = await readProjectFile(PROJECTS_DIR, projectId, relPath, project?.metadata);
      // PreviewModal loads artifact HTML via srcdoc, giving the iframe Origin: "null".
      // data: URIs, file://, and some sandboxed iframes also send null — all are
      // local-only callers, so this is safe. Real cross-origin sites send a real
      // origin and remain blocked by the browser's same-origin policy.
      // Origin: "od://app" is the packaged desktop app's own renderer (its
      // requests proxy through apps/packaged/src/protocol.ts, carrying that
      // origin unchanged) — a Vite dist's `crossorigin` script/link tags force
      // CORS mode and always attach Origin even same-origin, so a built
      // react/dist preview loaded in this route needs the same allowance.
      if (req.headers.origin === 'null' || req.headers.origin === 'od://app') {
        res.header('Access-Control-Allow-Origin', '*');
      }
      res.type(file.mime).send(file.buffer);
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

  app.delete(/^\/api\/projects\/([^/]+)\/raw\/(.+)$/u, async (req, res) => {
    try {
      const projectId = String(req.params[0] ?? '');
      const rawSplat = String(req.params[1] ?? '');
      const project = getProject(db, projectId);
      await deleteProjectFile(PROJECTS_DIR, projectId, rawSplat, project?.metadata);
      /** @type {import('@open-design/contracts').DeleteProjectFileResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

  app.get('/api/projects/:id/files/:name/preview', async (req, res) => {
    try {
      const project = getProject(db, req.params.id);
      const file = await readProjectFile(
        PROJECTS_DIR,
        req.params.id,
        req.params.name,
        project?.metadata,
      );
      const preview = await buildDocumentPreview(file);
      res.json(preview);
    } catch (err) {
      const status =
        err && err.statusCode
          ? err.statusCode
          : err && err.code === 'ENOENT'
            ? 404
            : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        err?.message || 'preview unavailable',
      );
    }
  });

  app.get(/^\/api\/projects\/([^/]+)\/files\/(.+)$/u, async (req, res) => {
    try {
      const projectId = String(req.params[0] ?? '');
      const fileSplat = String(req.params[1] ?? '');
      const project = getProject(db, projectId);
      const file = await readProjectFile(
        PROJECTS_DIR,
        projectId,
        fileSplat,
        project?.metadata,
      );
      res.type(file.mime).send(file.buffer);
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

  // Two ways to upload: multipart for binary files (images), and JSON
  // {name, content, encoding} for sketches and pasted text. The frontend
  // uses both depending on the file source.
  app.post(
    '/api/projects/:id/files',
    (req, res, next) => {
      upload.single('file')(req, res, (err) => {
        if (err) return sendMulterError(res, err);
        next();
      });
    },
    async (req, res) => {
      try {
        const uploadProject = getProject(db, req.params.id);
        await ensureProject(PROJECTS_DIR, req.params.id, uploadProject?.metadata);
        if (req.file) {
          const buf = await fs.promises.readFile(req.file.path);
          const desiredName = sanitizeName(
            req.body?.name || req.file.originalname,
          );
          const meta = await writeProjectFile(
            PROJECTS_DIR,
            req.params.id,
            desiredName,
            buf,
            {},
            uploadProject?.metadata,
          );
          fs.promises.unlink(req.file.path).catch(() => {});
          /** @type {import('@open-design/contracts').ProjectFileResponse} */
          const body = { file: meta };
          return res.json(body);
        }
        const { name, content, encoding, artifactManifest } = req.body || {};
        if (typeof name !== 'string' || typeof content !== 'string') {
          return sendApiError(
            res,
            400,
            'BAD_REQUEST',
            'name and content required',
          );
        }
        if (artifactManifest !== undefined && artifactManifest !== null) {
          const validated = validateArtifactManifestInput(
            artifactManifest,
            name,
          );
          if (!validated.ok) {
            return sendApiError(
              res,
              400,
              'BAD_REQUEST',
              `invalid artifactManifest: ${validated.error}`,
            );
          }
        }
        const buf =
          encoding === 'base64'
            ? Buffer.from(content, 'base64')
            : Buffer.from(content, 'utf8');
        const meta = await writeProjectFile(
          PROJECTS_DIR,
          req.params.id,
          name,
          buf,
          { artifactManifest },
          uploadProject?.metadata,
        );
        /** @type {import('@open-design/contracts').ProjectFileResponse} */
        const body = { file: meta };
        res.json(body);
      } catch (err) {
        if (err instanceof ArtifactPublicationBlockedError) {
          return sendApiError(res, 422, 'ARTIFACT_PUBLICATION_BLOCKED', err.message, {
            details: { placeholders: err.placeholders },
          });
        }
        sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
      }
    },
  );

  app.delete('/api/projects/:id/files/:name', async (req, res) => {
    try {
      const delProject = getProject(db, req.params.id);
      await deleteProjectFile(PROJECTS_DIR, req.params.id, req.params.name, delProject?.metadata);
      /** @type {import('@open-design/contracts').DeleteProjectFileResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

  app.get('/api/media/models', (_req, res) => {
    res.json({
      providers: MEDIA_PROVIDERS,
      image: IMAGE_MODELS,
      video: VIDEO_MODELS,
      audio: AUDIO_MODELS_BY_KIND,
      aspects: MEDIA_ASPECTS,
      videoLengthsSec: VIDEO_LENGTHS_SEC,
      audioDurationsSec: AUDIO_DURATIONS_SEC,
    });
  });

  app.get('/api/media/config', async (_req, res) => {
    try {
      const cfg = await readMaskedConfig(PROJECT_ROOT);
      res.json(cfg);
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/media/config', async (req, res) => {
    try {
      const cfg = await writeConfig(PROJECT_ROOT, req.body);
      res.json(cfg);
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      res
        .status(status)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.get('/api/app-config', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const config = await readAppConfig(RUNTIME_DATA_DIR);
      res.json({ config });
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/app-config', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const config = await writeAppConfig(RUNTIME_DATA_DIR, req.body);
      orbitService.configure(config.orbit);
      res.json({ config });
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.get('/api/orbit/status', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      res.json(await orbitService.status());
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/orbit/run', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const locale = typeof req.body?.locale === 'string' ? req.body.locale : null;
      res.json(await orbitService.start('manual', { locale }));
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/system/open-external', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return res.status(400).json({ ok: false, error: 'url must be a valid URL' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ ok: false, error: 'url must be http or https' });
      }
      const child = openBrowser(parsed.toString());
      res.json({ ok: Boolean(child) });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

	  // Native OS folder picker dialog. Returns { path: string | null }.
	  app.post('/api/dialog/open-folder', async (req, res) => {
	    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const selected = await openNativeFolderDialog();
      res.json({ path: selected });
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/projects/:id/media/generate', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({
        error:
          'cross-origin request rejected: media generation is restricted to the local UI / CLI',
      });
    }

    try {
      const projectId = req.params.id;
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'project not found' });

      const taskId = randomUUID();
      const task = createMediaTask(db, taskId, projectId, {
        surface: req.body?.surface,
        model: req.body?.model,
      });
      console.error(
        `[task ${taskId.slice(0, 8)}] queued model=${req.body?.model} ` +
          `surface=${req.body?.surface} ` +
          `image=${req.body?.image ? 'yes' : 'no'} ` +
          `compositionDir=${req.body?.compositionDir ? 'yes' : 'no'}`,
      );

      task.status = 'running';
      persistMediaTask(db, task);
      generateMedia({
        projectRoot: PROJECT_ROOT,
        projectsRoot: PROJECTS_DIR,
        projectId,
        surface: req.body?.surface,
        model: req.body?.model,
        prompt: req.body?.prompt,
        output: req.body?.output,
        aspect: req.body?.aspect,
        length:
          typeof req.body?.length === 'number' ? req.body.length : undefined,
        duration:
          typeof req.body?.duration === 'number'
            ? req.body.duration
            : undefined,
        voice: req.body?.voice,
        audioKind: req.body?.audioKind,
        language: typeof req.body?.language === 'string' ? req.body.language : undefined,
        compositionDir: req.body?.compositionDir,
        image: req.body?.image,
        onProgress: (line) => appendTaskProgress(db, task, line),
      })
        .then((meta) => {
          task.status = 'done';
          task.file = meta;
          task.endedAt = Date.now();
          persistMediaTask(db, task);
          notifyTaskWaiters(db, task);
          console.error(
            `[task ${taskId.slice(0, 8)}] done size=${meta?.size} mime=${meta?.mime} ` +
              `elapsed=${Math.round((task.endedAt - task.startedAt) / 1000)}s`,
          );
        })
        .catch((err) => {
          task.status = 'failed';
          task.error = {
            message: String(err && err.message ? err.message : err),
            status: typeof err?.status === 'number' ? err.status : 400,
            code: err?.code,
          };
          task.endedAt = Date.now();
          persistMediaTask(db, task);
          notifyTaskWaiters(db, task);
          console.error(
            `[task ${taskId.slice(0, 8)}] failed status=${task.error.status} ` +
              `message=${(task.error.message || '').slice(0, 240)}`,
          );
        });

      res.status(202).json({
        taskId,
        status: task.status,
        startedAt: task.startedAt,
      });
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });

  app.post('/api/research/search', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({
        error:
          'cross-origin request rejected: research search is restricted to the local UI / CLI',
      });
    }

    try {
      const result = await searchResearch({
        projectRoot: PROJECT_ROOT,
        query: req.body?.query,
        maxSources:
          typeof req.body?.maxSources === 'number'
            ? req.body.maxSources
            : undefined,
        providers: Array.isArray(req.body?.providers)
          ? req.body.providers
          : undefined,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof ResearchError) {
        return res.status(err.status).json({
          error: { code: err.code, message: err.message },
        });
      }
      res.status(500).json({
        error: {
          code: 'RESEARCH_FAILED',
          message: String(err && err.message ? err.message : err),
        },
      });
    }
  });

  app.post('/api/media/tasks/:id/wait', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const taskId = req.params.id;
    const task = getLiveMediaTask(db, taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });

    const since = Number.isFinite(req.body?.since) ? Number(req.body.since) : 0;
    const requestedTimeout = Number.isFinite(req.body?.timeoutMs)
      ? Number(req.body.timeoutMs)
      : 25_000;
    const timeoutMs = Math.min(Math.max(requestedTimeout, 0), 25_000);

    const respond = () => {
      if (res.writableEnded) return;
      res.json(mediaTaskSnapshot(task, since));
    };

    if (
      MEDIA_TERMINAL_STATUSES.has(task.status) ||
      task.progress.length > since
    ) {
      return respond();
    }

    let resolved = false;
    const wake = () => {
      if (resolved) return;
      resolved = true;
      task.waiters.delete(wake);
      clearTimeout(timer);
      respond();
    };
    task.waiters.add(wake);
    const timer = setTimeout(wake, timeoutMs);
    res.on('close', wake);
  });

  app.get('/api/projects/:id/media/tasks', (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const projectId = req.params.id;
    const includeDone =
      req.query.includeDone === '1' || req.query.includeDone === 'true';
    const tasks = listMediaTasksByProject(db, projectId, {
      includeTerminal: includeDone,
    }).map((t) => ({
      taskId: t.id,
      status: t.status,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      elapsed: Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000),
      surface: t.surface,
      model: t.model,
      progress: t.progress.slice(-3),
      progressCount: t.progress.length,
      ...(t.status === 'done' ? { file: t.file } : {}),
      ...(t.status === 'failed' || t.status === 'interrupted' ? { error: t.error } : {}),
    }));
    tasks.sort((a, b) => b.startedAt - a.startedAt);
    res.json({ tasks });
  });

  // Multi-file upload that the chat composer uses for paste/drop/picker.
  // Files land flat in the project folder; the response carries the same
  // metadata as listFiles so the client can stage them as ChatAttachments
  // without a separate refetch.
  app.post(
    '/api/projects/:id/upload',
    handleProjectUpload,
    async (req, res) => {
      try {
        const incoming = Array.isArray(req.files) ? req.files : [];
        const out = [];
        for (const f of incoming) {
          try {
            const stat = await fs.promises.stat(f.path);
            out.push({
              name: f.filename,
              path: f.filename,
              size: stat.size,
              mtime: stat.mtimeMs,
              originalName: f.originalname,
            });
          } catch {
            // skip files that vanished mid-flight
          }
        }
        /** @type {import('@open-design/contracts').UploadProjectFilesResponse} */
        const body = { files: out };
        res.json(body);
      } catch (err) {
        sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
      }
    },
  );

  // `design` already declared once above (after the chat-run service is
  // wired into the main daemon dependency graph). The garnet legacy block
  // re-introduced it here; duplicate declarations crash the esbuild
  // transformer at boot. Re-using the earlier `design` is correct — the
  // inline routes below want the same runs service as the registered
  // route modules.
  // main: file-upload routes lifted to a dedicated module. Keep alongside the
  // inline routes garnet still owns above; duplicate registrations resolve in
  // a follow-up after route-routes.ts vs garnet inline coverage is audited.
  registerProjectUploadRoutes(app, { http: httpDeps, uploads: uploadDeps, node: nodeDeps });

  const composeDaemonSystemPrompt = async ({
    agentId,
    projectId,
    skillId,
    skillIds,
    designSystemId,
    streamFormat,
    locale,
    connectedExternalMcp,
    appliedPluginSnapshotId,
    // 'pipeline' = lean unattended profile (see ComposeInput.promptProfile).
    promptProfile,
    // Pipeline only: does THIS stage generate UI from a design system
    // (`PipelineDef.acceptsDesignSystem`)? When false the DS blocks
    // (DESIGN.md, tokens.css, manifest, pull index — ~17k chars) are not
    // even resolved; review/flow/spec stages get their criteria as files
    // in the cwd, not through the prompt.
    pipelineUsesDesignSystem,
  }) => {
    const isPipelineProfile = promptProfile === 'pipeline';
    const project =
      typeof projectId === 'string' && projectId
        ? getProject(db, projectId)
        : null;
    const effectiveSkillId =
      typeof skillId === 'string' && skillId ? skillId : project?.skillId;
    const effectiveDesignSystemId =
      isPipelineProfile && !pipelineUsesDesignSystem
        ? null
        : typeof designSystemId === 'string' && designSystemId
          ? designSystemId
          : project?.designSystemId;
    const metadata = project?.metadata;
    let allSkillsPromise: ReturnType<typeof listAllSkillLikeEntries> | null = null;
    const loadAllSkills = async () => {
      allSkillsPromise ??= listAllSkillLikeEntries();
      return await allSkillsPromise;
    };

    // Per-turn skills picked via the composer's @-mention popover. They
    // never persist on the project — we just append their bodies after the
    // primary skill so the agent sees one combined block this turn.
    const effectiveCanonicalSkillId =
      typeof effectiveSkillId === 'string' && effectiveSkillId
        ? resolveSkillId(effectiveSkillId)
        : null;
    const adHocSkillIds = Array.isArray(skillIds)
      ? skillIds
          .map((s) => (typeof s === 'string' ? s.trim() : ''))
          .filter(Boolean)
          .filter((id) => resolveSkillId(id) !== effectiveCanonicalSkillId)
      : [];

    let skillBody;
    let skillName;
    let skillMode;
    const skillModes = new Set<NonNullable<Parameters<typeof composeSystemPrompt>[0]['skillMode']>>();
    let skillCraftRequires = [];
    let activeSkillDir = null;
    const activeSkillDirs: string[] = [];
    // Per-skill Critique Theater override sourced from
    // `od.critique.policy` in the resolved skill's SKILL.md frontmatter.
    // `null` means the skill has no opinion and the lower-priority tiers
    // (project override, env override, rollout phase default) decide.
    let skillCritiquePolicy: SkillCritiquePolicy = null;
    let critiqueSkillId = effectiveCanonicalSkillId;
    const registerSkillMode = (
      mode: NonNullable<Parameters<typeof composeSystemPrompt>[0]['skillMode']> | null | undefined,
    ) => {
      if (!mode) return;
      skillModes.add(mode);
    };
    const registerPrimarySkillMode = (
      mode: NonNullable<Parameters<typeof composeSystemPrompt>[0]['skillMode']> | null | undefined,
    ) => {
      if (!mode) return;
      skillMode ??= mode;
      registerSkillMode(mode);
    };
    const registerSkillDir = (dir: string | null | undefined) => {
      if (typeof dir !== 'string' || dir.length === 0) return;
      if (!activeSkillDir) activeSkillDir = dir;
      if (!activeSkillDirs.includes(dir)) activeSkillDirs.push(dir);
    };
    const mergeSkillCritiquePolicy = (
      current: SkillCritiquePolicy,
      next: SkillCritiquePolicy,
    ): SkillCritiquePolicy => {
      if (next === 'opt-out') return 'opt-out';
      if (next === 'required') return current === 'opt-out' ? current : 'required';
      if (next === 'opt-in') {
        return current === 'required' || current === 'opt-out' ? current : 'opt-in';
      }
      return current;
    };
    if (effectiveSkillId) {
      // Span both functional skills and design templates so a project
      // saved against either surface keeps its system prompt after the
      // skills/design-templates split. See specs/current/skills-and-design-templates.md.
      const allSkills = await loadAllSkills();
      const skill = findSkillById(allSkills, effectiveSkillId);
      if (skill) {
        skillBody = skill.body;
        skillName = skill.name;
        registerPrimarySkillMode(skill.mode);
        registerSkillDir(skill.dir);
        skillCritiquePolicy = mergeSkillCritiquePolicy(
          skillCritiquePolicy,
          skill.critiquePolicy,
        );
        if (Array.isArray(skill.craftRequires))
          skillCraftRequires = skill.craftRequires;
      }
    }
    let composedSkillBlocks = '';
    if (adHocSkillIds.length > 0) {
      const allSkills = await loadAllSkills();
      const seen = new Set(
        effectiveCanonicalSkillId ? [String(effectiveCanonicalSkillId)] : [],
      );
      const blocks = [];
      const baseBody = skillBody && skillBody.trim().length > 0 ? skillBody : '';
      for (const id of adHocSkillIds) {
        const canonicalId = resolveSkillId(id);
        if (typeof canonicalId !== 'string' || canonicalId.length === 0) continue;
        if (seen.has(canonicalId)) continue;
        seen.add(canonicalId);
        const extra = findSkillById(allSkills, id);
        if (!extra) continue;
        registerSkillDir(extra.dir);
        registerSkillMode(extra.mode);
        if (!effectiveCanonicalSkillId && adHocSkillIds.length === 1) {
          registerPrimarySkillMode(extra.mode);
        }
        if (!critiqueSkillId || extra.critiquePolicy !== null) critiqueSkillId = canonicalId;
        skillCritiquePolicy = mergeSkillCritiquePolicy(
          skillCritiquePolicy,
          extra.critiquePolicy,
        );
        if (Array.isArray(extra.craftRequires)) {
          for (const craft of extra.craftRequires) {
            if (!skillCraftRequires.includes(craft)) skillCraftRequires.push(craft);
          }
        }
        blocks.push(
          `\n\n---\n\n## Composed skill — ${extra.name || id}\n\n${(extra.body || '').trim()}`,
        );
      }
      if (blocks.length > 0) {
        composedSkillBlocks = blocks.join('');
        skillBody = baseBody + composedSkillBlocks;
        if (!skillName) {
          skillName = adHocSkillIds.length === 1
            ? findSkillById(allSkills, adHocSkillIds[0])?.name ?? null
            : 'composed';
        }
      }
    }

    // Stage A of plugin-driven-flow-plan: when the run is bound to a
    // plugin snapshot, prefer the plugin's local SKILL.md (declared via
    // `od.context.skills[{ path: './SKILL.md' }]`) over the global
    // skill. Without this override the agent loses the plugin's
    // template / token / layout rules and falls back to generic prompt
    // behaviour even though the user explicitly applied the plugin.
    if (
      typeof appliedPluginSnapshotId === 'string'
      && appliedPluginSnapshotId.length > 0
    ) {
      try {
        const snap = getSnapshot(db, appliedPluginSnapshotId);
        if (snap?.pluginId) {
          const plugin = getInstalledPlugin(db, snap.pluginId);
          if (plugin) {
            const { loadPluginLocalSkill } = await import('./plugins/local-skill.js');
            const local = await loadPluginLocalSkill(plugin);
            if (local) {
              skillBody = local.body + composedSkillBlocks;
              skillName = local.name;
              activeSkillDir = local.dir;
              registerSkillDir(local.dir);
            }
          }
        }
      } catch (err) {
        console.warn(
          `[plugins] pluginSkillBody load failed: ${err?.message ?? err}`,
        );
      }
    }

    let craftBody;
    let craftSections;

    // Personal-memory body is always recomputed at compose time so a
    // memory the user just edited in settings shows up on the very next
    // run. composeMemoryBody returns '' when memory is disabled or
    // empty; the composer drops the block on a falsy value.
    let memoryBody = '';
    if (!isPipelineProfile) {
      try {
        memoryBody = await composeMemoryBody(RUNTIME_DATA_DIR);
      } catch (err) {
        console.warn('[memory] composeMemoryBody failed', err);
      }
    }

    // User-level custom instructions from app-config.json.
    let userInstructions = '';
    try {
      const appCfg = await readAppConfig(RUNTIME_DATA_DIR);
      if (appCfg.customInstructions) userInstructions = appCfg.customInstructions;
    } catch (err) {
      console.warn('[custom-instructions] readAppConfig failed', err);
    }

    // Project-level custom instructions from the projects table.
    const projectInstructions = project?.customInstructions ?? '';

    let designSystemBody;
    let designSystemTitle;
    // Compiled (tokens.css + components manifest / components.html)
    // form of the active brand.
    // Default-on as of PR-D — every chat that picks a brand with
    // `tokens.css` + `components.html` siblings (today: `default` and
    // `kami`; every other brand falls through silently because the
    // files are absent) gets the structured token contract appended to
    // the system prompt automatically.
    //
    // `OD_DESIGN_TOKEN_CHANNEL=0` is the kill switch: it forces the
    // daemon back to the pre-PR-C DESIGN.md-only path for every brand,
    // including the structured ones. Any other value (unset, `1`,
    // `true`, etc.) keeps the new default. Drift on prose-only brands
    // is pinned by `scripts/check-design-system-flag-parity.ts`.
    let designSystemUsageMd;
    let designSystemTokensCss;
    let designSystemComponentsManifest;
    let designSystemFixtureHtml;
    let designSystemPullIndex;
    let designSystemImportMode;
    let designSystemCraftApplies = [];
    let designSystemCraftExemptions = [];
    if (effectiveDesignSystemId) {
      let systems = await listAllDesignSystems();
      let summary = systems.find((s) => s.id === effectiveDesignSystemId);
      if (summary?.source === 'user') {
        await ensureUserDesignSystemWorkspaceProject(db, effectiveDesignSystemId);
        systems = await listAllDesignSystems();
        summary = systems.find((s) => s.id === effectiveDesignSystemId);
      }
      const editingOwnDraftDesignSystem =
        project?.metadata?.importedFrom === 'design-system'
        && project.designSystemId === effectiveDesignSystemId;
      designSystemTitle = summary?.title;
      if (summary && (isProjectUsableDesignSystem(summary) || editingOwnDraftDesignSystem)) {
        const workspaceBody = await readDesignSystemWorkspaceTextFile(db, summary, 'DESIGN.md');
        const registryBody = await readAvailableDesignSystem(effectiveDesignSystemId);
        designSystemBody = (workspaceBody ?? registryBody) ?? undefined;
        // Single seam: env gate + built-in→user-installed fallback chain
        // live together inside `resolveDesignSystemAssets` so the whole
        // server-side asset-resolution path can be tested end-to-end
        // from real disk fixtures (see `tests/design-system-assets.test.ts`).
        const assets = await resolveDesignSystemAssets(
          effectiveDesignSystemId,
          DESIGN_SYSTEMS_DIR,
          USER_DESIGN_SYSTEMS_DIR,
        );
        designSystemUsageMd = assets.usageMd;
        designSystemTokensCss = assets.tokensCss;
        designSystemComponentsManifest = assets.componentsManifest;
        designSystemFixtureHtml = assets.fixtureHtml;
        designSystemPullIndex = assets.pullIndex;
        designSystemImportMode = assets.importMode;
        designSystemCraftApplies = Array.isArray(assets.craftApplies) ? assets.craftApplies : [];
        designSystemCraftExemptions = Array.isArray(assets.craftExemptions) ? assets.craftExemptions : [];
      }
    }

    const excludedCraft = new Set(designSystemCraftExemptions);
    const requestedCraft = Array.from(
      new Set([...skillCraftRequires, ...designSystemCraftApplies]),
    ).filter((slug) => !excludedCraft.has(slug));
    if (requestedCraft.length > 0) {
      const loaded = await loadCraftSections(CRAFT_DIR, requestedCraft);
      if (loaded.body) {
        craftBody = loaded.body;
        craftSections = loaded.sections;
      }
    }

    const template =
      metadata?.kind === 'template' && typeof metadata.templateId === 'string'
        ? (getTemplate(db, metadata.templateId) ?? undefined)
        : undefined;
    let audioVoiceOptions = [];
    let audioVoiceOptionsError;
    if (
      metadata?.kind === 'audio' &&
      metadata?.audioKind === 'speech' &&
      metadata?.audioModel === 'elevenlabs-v3' &&
      !metadata?.voice
    ) {
      try {
        audioVoiceOptions = await listElevenLabsVoiceOptions(PROJECT_ROOT, { limit: 100 });
      } catch (err) {
        audioVoiceOptionsError = err && err.message ? err.message : String(err);
        console.warn('[elevenlabs] voice option lookup failed:', audioVoiceOptionsError);
      }
    }

    // Thread the critique config plus the active design-system / skill data
    // into the composer when critique is enabled. Without this the spawned
    // child receives the legacy single-pass prompt and the parser waits for
    // <CRITIQUE_RUN> tags the model was never told to emit. The composer
    // itself ignores these fields when the top-line gate is false, so the
    // legacy path stays untouched.
    //
    // Top-line gate (post-Phase-15 wireup): the daemon now routes every
    // candidate run through the rollout resolver instead of reading the
    // env-var flag directly. The resolver carries the full priority
    // matrix: skill `od.critique.policy` veto > project override > env
    // override > rollout phase default. On a fresh install with M0
    // dark-launch defaults the resolver returns `false`, so prod traffic
    // is unchanged until an operator flips the env var or a project
    // opts in. The skill-policy input is sourced from
    // `od.critique.policy` in the active skill's SKILL.md frontmatter
    // (parsed in `skills.ts:normalizeCritiquePolicy`). The project
    // override input is sourced from the `critiqueTheaterEnabled`
    // field on the project's metadata blob, which is what the M1
    // Settings toggle writes through the existing settings endpoint.
    // Both inputs collapse to `null` when the skill / project has
    // not expressed an opinion, which is the resolver's "fall through
    // to env / phase default" signal.
    // Per-project override: the M1 Settings toggle writes
    // `critiqueTheaterEnabled` onto the project's metadata blob via
    // the existing settings round-trip. A boolean wins outright; any
    // other type (missing key, malformed value) collapses to `null`
    // so the resolver falls through to the env / phase tiers exactly
    // the way it did when the toggle had never been touched.
    const projectCritiqueOverride = narrowProjectCritiqueOverride(metadata);
    const critiqueEnabledForRun = isCritiqueEnabled({
      phase: parseRolloutPhase(process.env.OD_CRITIQUE_ROLLOUT_PHASE),
      skillPolicy: skillCritiquePolicy,
      projectOverride: projectCritiqueOverride,
      envOverride: parseEnvEnabled(process.env.OD_CRITIQUE_ENABLED),
    });
    const critiqueBrand = critiqueEnabledForRun
      && typeof designSystemTitle === 'string'
      && typeof designSystemBody === 'string'
      ? { name: designSystemTitle, design_md: designSystemBody }
      : undefined;
    const critiqueSkill = critiqueEnabledForRun && typeof critiqueSkillId === 'string'
      ? { id: critiqueSkillId }
      : undefined;
    // Single-source-of-truth eligibility check. The composer downstream
    // appends <CRITIQUE_RUN> instructions only when this check passes, and
    // the spawn path routes runs through runOrchestrator(...) only when the
    // SAME flag is true, so prompt and orchestrator stay in lockstep.
    //
    // Non-plain adapters (claude-stream-json, copilot-stream-json,
    // json-event-stream, acp-json-rpc, pi-rpc) emit their own wrapper
    // protocol; the v1 critique parser only understands plain stdout. The
    // spawn path falls through to legacy generation for those, so the
    // panel addendum has to be suppressed here too: otherwise the model
    // is instructed to emit Critique Theater tags that no orchestrator
    // consumes.
    const resolvedExclusiveSurface = resolveExclusiveSurface({
      metadata,
      skillMode,
      skillModes: skillModes.size > 0 ? Array.from(skillModes) : undefined,
    });
    const isMediaSurface =
      resolvedExclusiveSurface === 'image'
      || resolvedExclusiveSurface === 'video'
      || resolvedExclusiveSurface === 'audio';
    const isPlainAdapter = (streamFormat ?? 'plain') === 'plain';
    // Pipeline stages never run Critique Theater (the composer drops the
    // panel addendum for the pipeline profile, so the orchestrator must not
    // wait for <CRITIQUE_RUN> tags either).
    const critiqueShouldRun = !isPipelineProfile
      && critiqueEnabledForRun
      && critiqueBrand !== undefined
      && critiqueSkill !== undefined
      && !isMediaSurface
      && isPlainAdapter;
    // Only thread the critique fields when the run is actually eligible;
    // otherwise the composer's own internal eligibility check (cfg.enabled
    // && brand && skill && !isMediaSurface) might still fire on
    // non-plain adapters and we'd emit the panel for a run the orchestrator
    // skips. Gating the threading itself keeps composer + orchestrator in
    // exact lockstep regardless of which side enforces eligibility.
    let pluginBlock;
    if (
      typeof appliedPluginSnapshotId === 'string'
      && appliedPluginSnapshotId.length > 0
    ) {
      try {
        const snap = getSnapshot(db, appliedPluginSnapshotId);
        if (snap) pluginBlock = pluginPromptBlock(snap);
      } catch (err) {
        console.warn(
          `[plugins] pluginBlock build failed: ${err?.message ?? err}`,
        );
      }
    }

    // Plan §3.M2 / §3.V1 / spec §23.4 — render each stage's atoms[]
    // into `## Active stage` blocks via the contracts helper when
    // the run carries a snapshot with a pipeline. Default is now ON
    // (flipped in §3.V1 once the bundled SKILL.md fragments covered
    // every Phase 6/7/8 atom); set OD_BUNDLED_ATOM_PROMPTS=0 to opt
    // out (the runs that need pre-§3.V1 byte-equal prompts: snapshot
    // replay against an older daemon, regression-bisects).
    let activeStageBlocks;
    const bundledAtomPromptsEnabled = process.env.OD_BUNDLED_ATOM_PROMPTS !== '0';
    if (
      bundledAtomPromptsEnabled
      && typeof appliedPluginSnapshotId === 'string'
      && appliedPluginSnapshotId.length > 0
    ) {
      try {
        const snap = getSnapshot(db, appliedPluginSnapshotId);
        const stages = snap?.pipeline?.stages ?? [];
        if (stages.length > 0) {
          const { loadAtomBodies } = await import('./plugins/atom-bodies.js');
          const { renderActiveStageBlock } = await import('@open-design/contracts');
          const blocks = [];
          for (const stage of stages) {
            const bodies = await loadAtomBodies(db, stage.atoms ?? []);
            const block = renderActiveStageBlock({ stageId: stage.id, bodies });
            if (block.trim().length > 0) blocks.push(block);
          }
          if (blocks.length > 0) activeStageBlocks = blocks;
        }
      } catch (err) {
        console.warn(`[plugins] activeStageBlocks build failed: ${(err)?.message ?? err}`);
      }
    }

    const prompt = composeSystemPrompt({
      agentId,
      includeCodexImagegenOverride: false,
      skillBody,
      skillName,
      skillMode,
      skillModes: skillModes.size > 0 ? Array.from(skillModes) : undefined,
      designSystemBody,
      designSystemTitle,
      designSystemUsageMd,
      designSystemTokensCss,
      designSystemComponentsManifest,
      designSystemFixtureHtml,
      designSystemPullIndex,
      designSystemImportMode,
      craftBody,
      craftSections,
      memoryBody,
      metadata,
      template,
      audioVoiceOptions,
      audioVoiceOptionsError,
      // critiqueCfg.enabled is loaded from OD_CRITIQUE_ENABLED only, so a
      // run that the resolver enabled via phase / project / skill (env
      // unset) would have critiqueShouldRun = true while critiqueCfg.enabled
      // remains false. Without this override the composer's own gate
      // (cfg.enabled) drops the panel addendum, the orchestrator still
      // launches, and the parser waits for <CRITIQUE_RUN> tags the model
      // was never told to emit (codex P2 on PR #1338). Build a derived
      // config that pins enabled to the resolver decision so the composer
      // and the orchestrator agree on every eligibility input.
      critique: critiqueShouldRun ? { ...critiqueCfg, enabled: true } : undefined,
      critiqueBrand: critiqueShouldRun ? critiqueBrand : undefined,
      critiqueSkill: critiqueShouldRun ? critiqueSkill : undefined,
      locale: typeof locale === 'string' ? locale : undefined,
      streamFormat,
      connectedExternalMcp: Array.isArray(connectedExternalMcp)
        ? connectedExternalMcp
        : undefined,
      ...(pluginBlock ? { pluginBlock } : {}),
      ...(activeStageBlocks ? { activeStageBlocks } : {}),
      userInstructions,
      projectInstructions,
      ...(isPipelineProfile ? { promptProfile: 'pipeline' } : {}),
    });
    // The chat handler also needs to know where the active skill lives
    // on disk so it can stage a per-project copy of its side files
    // before spawning the agent. Returning that here avoids a second
    // `listSkills()` scan in `startChatRun`. critiqueShouldRun threads
    // the same panel-eligibility decision down to the spawn-path
    // orchestrator gate so prompt and orchestrator stay in lockstep.
    //
    // Workspace tổng (project hạ tầng `overview`): phiên TRA CỨU CHỈ ĐỌC về
    // tiến độ App/Feature. MCP stdio không tới được Claude Code trong sandbox
    // (không có `od` CLI trong container — OD_BIN rỗng), nên chỉ dẫn endpoint
    // qua system prompt: mọi runtime đều curl được qua OD_DAEMON_URL. Nghiệm
    // thu thật 2026-08-10: thiếu khối này agent phải probe mò hàng chục
    // endpoint 404 rồi lắp ráp từ /api/projects thô (lẫn project hạ tầng).
    if (metadata?.kind === 'overview') {
      const overviewPrompt = [
        '',
        '## Workspace tổng — tra cứu tiến độ App/Feature',
        'Bạn đang ở phiên hỏi-đáp tổng quan. Trả lời bằng dữ liệu thật từ daemon (base URL trong env `OD_DAEMON_URL`):',
        '- `GET $OD_DAEMON_URL/api/overview/summary` — số App, số Feature, tiến độ TỪNG workflow của từng feature ({done,total,running}), cờ `localFiles`.',
        '- `GET $OD_DAEMON_URL/api/overview/outputs?projectId=<id>` — danh sách file output (đường dẫn tương đối) của một feature.',
        '- `GET $OD_DAEMON_URL/api/projects/<id>/raw/<đường dẫn>` — đọc nội dung một file output (chỉ file text).',
        'KHÔNG dùng `/api/projects` thô để đếm — nó lẫn project hạ tầng (kind overview/ds-criteria/ds-rules) và project không phải feature.',
        'Feature có `localFiles: false` là chưa pull về máy này — nói thẳng như vậy, đừng đoán bước.',
        'Với DỮ LIỆU PIPELINE bạn CHỈ ĐỌC: không sửa/xoá file của project khác, không chạy pipeline, không POST/PATCH/DELETE.',
        'NGOẠI LỆ DUY NHẤT: khi người dùng yêu cầu xuất BÁO CÁO (HTML/Markdown/CSV…), hãy ghi file vào ĐÚNG thư mục làm việc hiện tại của bạn (cwd = thư mục riêng của workspace tổng, có cây thư mục hiển thị bên phải màn hình). Đặt tên rõ ràng, vd `bao-cao-tien-do-2026-08-10.html`.',
      ].join('\n');
      return {
        prompt: `${prompt}\n${overviewPrompt}`,
        activeSkillDir,
        activeSkillDirs,
        critiqueShouldRun,
      };
    }
    return { prompt, activeSkillDir, activeSkillDirs, critiqueShouldRun };
  };

  // Plan §3.I1 / §3.D / spec §10.1: fire the pipeline schedule on a
  // run's SSE stream. Synchronous first emit (the first
  // pipeline_stage_started event lands before the agent process
  // starts) + async tail. Stage D wires the atom-worker registry as
  // the default stage runner; set OD_PIPELINE_RUNNER=stub to fall
  // back to the canned v1 stub for diagnostic bisection or replay
  // of pre-Stage-D runs. Errors are swallowed (logged) so a bad
  // pipeline never blocks the agent run.
  const firePipelineForRun = (args) => {
    const { run, snapshot, runs, db: dbHandle } = args;
    if (!snapshot?.pipeline?.stages?.length) return;
    const env = { maxIterations: readPluginEnvKnobs().maxDevloopIterations };
    const emitPipeline = (evt) => {
      try { runs.emit(run, evt.kind, evt); } catch {/* ignore */}
    };
    const emitGenui = (evt) => {
      try { runs.emit(run, evt.kind, evt); } catch {/* ignore */}
    };
    const projectIdForRun = run.projectId
      ?? snapshot.resolvedContext?.items?.[0]?.id
      ?? 'project-unknown';
    const runnerMode = process.env.OD_PIPELINE_RUNNER === 'stub'
      ? 'stub'
      : 'registry';
    let runStage;
    if (runnerMode === 'stub') {
      runStage = ({ iteration }) => ({
        signals: {
          'critique.score':  iteration >= 0 ? 4 : 0,
          'preview.ok':      true,
          'user.confirmed':  true,
        },
      });
    } else {
      registerBuiltInAtomWorkers();
      runStage = async ({ stage, iteration, snapshot: stageSnapshot }) => {
        const outcome = await runStageWithRegistry({
          db:             dbHandle,
          runId:          run.id,
          projectId:      projectIdForRun,
          conversationId: run.conversationId ?? null,
          stage,
          iteration,
          snapshot:       stageSnapshot,
        });
        return {
          signals:         outcome.signals,
          critiqueSummary: outcome.critiqueSummary,
        };
      };
    }
    void runPipelineForRun({
      db: dbHandle,
      runId:           run.id,
      projectId:       projectIdForRun,
      conversationId:  run.conversationId ?? null,
      snapshot,
      pipeline:        snapshot.pipeline,
      env,
      runStage,
      emitPipeline,
      emitGenui,
    }).catch((err) => {
      try {
        runs.emit(run, 'pipeline_stage_failed', {
          runId:      run.id,
          snapshotId: snapshot.snapshotId,
          message:    String(err?.message ?? err),
        });
      } catch { /* ignore */ }
    });
  };

  const startChatRun = async (chatBody, run) => {
    /** @type {Partial<ChatRequest> & { imagePaths?: string[]; cwdSubdir?: string }} */
    chatBody = chatBody || {};
    const {
      agentId,
      message,
      currentPrompt,
      systemPrompt,
      imagePaths = [],
      projectId,
      conversationId,
      assistantMessageId,
      clientRequestId,
      skillId,
      skillIds,
      designSystemId,
      attachments = [],
      commentAttachments = [],
      model,
      reasoning,
      locale,
      research,
      context,
      cwdSubdir,
      // Set by runPipeline for stage runs → lean unattended prompt (see
      // ComposeInput.promptProfile). Anything else (chat, routines) keeps
      // the full chat profile.
      promptProfile,
      pipelineUsesDesignSystem,
    } = chatBody;
    const isPipelineProfile = promptProfile === 'pipeline';
    // Extra tool-token scope for THIS run only (e.g. dr-comp in Figma-link
    // mode grants `/api/tools/figma/*`). Keyed by a Symbol so a JSON body
    // arriving over `/api/chat` can never widen its own grant — only internal
    // callers (pipeline fan-outs) can set it, and every call still passes
    // through authorizeToolRequest.
    const toolGrantExtras = chatBody[INTERNAL_TOOL_GRANT_EXTRAS] ?? null;
    if (typeof projectId === 'string' && projectId) run.projectId = projectId;
    if (typeof conversationId === 'string' && conversationId)
      run.conversationId = conversationId;
    if (typeof assistantMessageId === 'string' && assistantMessageId)
      run.assistantMessageId = assistantMessageId;
    if (typeof clientRequestId === 'string' && clientRequestId)
      run.clientRequestId = clientRequestId;
    if (typeof agentId === 'string' && agentId) run.agentId = agentId;
    // Stash the original user prompt + per-turn config so the
    // langfuse-bridge report path can include them without reaching back
    // into chatBody across the createChatRunService boundary. Each field
    // is optional and only set when the chat body actually carried it.
    const telemetryPrompt = telemetryPromptFromRunRequest(message, currentPrompt);
    if (typeof telemetryPrompt === 'string') run.userPrompt = telemetryPrompt;
    if (typeof model === 'string' && model) run.model = model;
    if (typeof reasoning === 'string' && reasoning) run.reasoning = reasoning;
    if (typeof skillId === 'string' && skillId) run.skillId = skillId;
    if (typeof designSystemId === 'string' && designSystemId)
      run.designSystemId = designSystemId;
    // Agent-in-sandbox decision — made THIS early because it shapes the
    // SYSTEM PROMPT: a sandboxed run must be told its CONTAINER working
    // directory (/work/app), never the host cwd, or the agent composes
    // `/Users/…` commands that don't exist inside docker (host-path leak,
    // audit item 4.6). The docker/image/auth preflight still runs later at
    // the spawn gate; this is only the pure gate decision.
    const sandboxAppCfg = await readAppConfig(RUNTIME_DATA_DIR).catch(() => ({}));
    const sandboxCfgForRun = resolveSandboxConfig(sandboxAppCfg.sandbox, process.env);
    const willSandbox = shouldSandboxRun({
      agentId,
      skillIds: [
        run.skillId ?? null,
        ...(Array.isArray(skillIds) ? skillIds : []),
      ],
      cfg: sandboxCfgForRun,
    });
    const def = getAgentDef(agentId);
    if (!def)
      return design.runs.fail(
        run,
        'AGENT_UNAVAILABLE',
        `unknown agent: ${agentId}`,
      );
    if (!def.bin)
      return design.runs.fail(run, 'AGENT_UNAVAILABLE', 'agent has no binary');
    const safeCommentAttachments =
      normalizeCommentAttachments(commentAttachments);
    if (
      (typeof message !== 'string' || !message.trim()) &&
      safeCommentAttachments.length === 0
    ) {
      return design.runs.fail(run, 'BAD_REQUEST', 'message required');
    }
    if (run.cancelRequested || design.runs.isTerminal(run.status)) return;
    const runId = run.id;

    // Auto-memory hook. Pulls explicit "remember:" / "我是 X" / "I prefer Y"
    // markers out of the just-arrived user message and writes them as MD
    // files under <dataDir>/memory/. We await so the very next
    // composeSystemPrompt() call (a few lines below) re-reads memory from
    // disk and a marker inside this turn's message is reflected in this
    // turn's prompt. Failures are swallowed — memory is best-effort and
    // must never block the agent run.
    if (typeof message === 'string' && message.trim().length > 0) {
      try {
        await extractFromMessage(RUNTIME_DATA_DIR, message);
      } catch (err) {
        console.warn('[memory] extractFromMessage failed', err);
      }
    }

    // Resolve the project working directory (creating the folder if it
    // doesn't exist yet). Without one we don't pass cwd to spawn — the
    // agent then runs in whatever inherited dir, which still lets API
    // mode work but loses file-tool addressability.
    // For git-linked projects (metadata.baseDir), use that folder directly
    // so the agent writes back to the user's original source tree.
    let cwd = null;
    let existingProjectFiles = [];
    if (typeof projectId === 'string' && projectId) {
      try {
        const chatProject = getProject(db, projectId);
        const chatMeta = chatProject?.metadata;
        if (chatMeta?.baseDir) {
          cwd = path.normalize(chatMeta.baseDir);
          existingProjectFiles = await listFiles(PROJECTS_DIR, projectId, { metadata: chatMeta });
        } else if (typeof cwdSubdir === 'string' && cwdSubdir) {
          // Per-workflow isolation: a pipeline run is rooted at
          // `<projectDir>/<workflowId>/` so the agent only ever sees its own
          // workflow's files (the sibling workflow's outputs live outside this
          // cwd). Files are listed from this subdir, not the project root.
          const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
          cwd = path.join(projectRoot, cwdSubdir);
          await fs.promises.mkdir(cwd, { recursive: true });
          existingProjectFiles = await listFiles(PROJECTS_DIR, projectId, { metadata: { baseDir: cwd } });
        } else {
          cwd = await ensureProject(PROJECTS_DIR, projectId);
          existingProjectFiles = await listFiles(PROJECTS_DIR, projectId);
        }
      } catch {
        cwd = null;
      }
    }
    if (run.cancelRequested || design.runs.isTerminal(run.status)) return;

    // Cross-user feedback merge: when this run composes the `summary-feedback`
    // skill, pull every install's `feedback/*.jsonl` from the shared media
    // store and merge them into `<cwd>/.feedback-merged.jsonl` BEFORE the agent
    // starts, so the skill reads the whole team's prompts as one local file
    // (it never has to reach the network or the host DB itself). Best-effort —
    // a media outage just means the merged file is absent/partial, and the
    // skill reports that rather than failing the run.
    if (cwd && typeof projectId === 'string' && projectId &&
        Array.isArray(skillIds) && skillIds.includes('summary-feedback')) {
      try {
        const merged = await pullMergedFeedback(projectId, cwd);
        console.log(`[feedback] merged ${merged.records} prompt(s) from ${merged.files} file(s) → ${merged.path}`);
      } catch (err) {
        console.warn('[feedback] merge skipped', (err as Error)?.message ?? err);
      }
    }

    // Sanitise supplied image paths: must live under UPLOAD_DIR.
    const safeImages = imagePaths.filter((p) => {
      const resolved = path.resolve(p);
      return (
        resolved.startsWith(UPLOAD_DIR + path.sep) && fs.existsSync(resolved)
      );
    });

    // Project-scoped attachments: project-relative paths inside cwd. Each
    // is run through the same path-traversal guard the file CRUD endpoints
    // use, then existence-checked. Whatever survives shows up as an
    // explicit list at the bottom of the user message so the agent knows
    // to Read it.
    const safeAttachments = cwd
      ? resolveSafeProjectAttachments(cwd, attachments)
      : [];

    // Local code agents don't accept a separate "system" channel the way the
    // Messages API does — we fold the skill + design-system prompt into the
    // user message. The <artifact> wrapping instruction comes from
    // systemPrompt. We also stitch in the cwd hint so the agent knows
    // where its file tools should write, and the attachment list so it
    // doesn't have to guess what the user just dropped in.
    // Also ship the current file listing so the agent can pick a unique
    // filename instead of clobbering a previous artifact.
    const filesListBlock = isPipelineProfile
      ? renderPipelineFolderSummary(existingProjectFiles)
      : existingProjectFiles.length
        ? `\nFiles already in this folder (do NOT overwrite unless the user asks; pick a fresh, descriptive name for new artifacts):\n${existingProjectFiles
            .map((f) => `- ${f.name}`)
            .join('\n')}`
        : '\nThis folder is empty. Choose a clear, descriptive filename for whatever you create.';
    const projectRecord =
      typeof projectId === 'string' && projectId
        ? getProject(db, projectId)
        : null;
    const runContextPrompt = renderRunContextPrompt(context, projectRecord?.metadata);
    const linkedDirs = (() => {
      if (!Array.isArray(projectRecord?.metadata?.linkedDirs)) return [];
      const v = validateLinkedDirs(projectRecord.metadata.linkedDirs);
      return v.dirs ?? [];
    })();
    // Sandboxed runs live at /work/app inside the od-agent-sandbox container.
    // The prompt is the agent's source of truth for its cwd — advertising the
    // HOST path there makes the agent compose `/Users/…` commands that do not
    // exist in the container, so the sandbox variant states the container
    // path and explicitly disowns host paths.
    const cwdHint = cwd
      ? willSandbox
        ? `\n\nYour working directory: ${CONTAINER_PROJECT_DIR}\nYou are running INSIDE a Docker sandbox container. Host filesystem paths (\`/Users/…\`, \`/Applications/…\`, \`C:\\…\`) do NOT exist here — if any appear elsewhere in this prompt or in skill instructions, ignore them and use the path RELATIVE to your working directory instead. Staged skill files (helper scripts, references, assets) live under \`./.od-skills/<skill-folder>/\`. Write project files relative to the working directory (e.g. \`index.html\`, \`assets/x.png\`). The user can browse those files in real time.${filesListBlock}`
        : `\n\nYour working directory: ${cwd}\nWrite project files relative to it (e.g. \`index.html\`, \`assets/x.png\`). The user can browse those files in real time.${filesListBlock}`
      : '';
    // Linked dirs are host paths and are NOT mounted into the sandbox —
    // advertising them there would only produce failing reads.
    if (willSandbox && linkedDirs.length > 0) {
      console.warn('[od] sandbox: linkedDirs are host paths, omitted from the sandboxed prompt');
    }
    const linkedDirsHint = !willSandbox && linkedDirs.length > 0
      ? `\n\nLinked code folders (read-only reference code the user wants you to see):\n${
          linkedDirs.map((d) => `- \`${d}\``).join('\n')
        }`
      : '';
    const attachmentHint = safeAttachments.length
      ? `\n\nAttached project files: ${safeAttachments.map((p) => `\`${p}\``).join(', ')}`
      : '';
    // Plan §3.A3 / spec §9: thread plugin context onto every tool token
    // so the connector execute route can re-validate the §5.3
    // capability gate without re-reading the SQLite snapshot row.
    let pluginGrantContext = null;
    if (cwd && typeof projectId === 'string' && projectId && run?.appliedPluginSnapshotId) {
      const snap = getSnapshot(db, run.appliedPluginSnapshotId);
      if (snap) {
        const installed = getInstalledPlugin(db, snap.pluginId);
        pluginGrantContext = {
          pluginSnapshotId: snap.snapshotId,
          pluginTrust: installed?.trust ?? 'restricted',
          pluginCapabilitiesGranted: snap.capabilitiesGranted ?? [],
        };
      }
    }
    const toolTokenGrant = cwd && typeof projectId === 'string' && projectId
      ? toolTokenRegistry.mint({
          runId,
          projectId,
          allowedEndpoints: [...CHAT_TOOL_ENDPOINTS, ...(toolGrantExtras?.endpoints ?? [])],
          allowedOperations: [...CHAT_TOOL_OPERATIONS, ...(toolGrantExtras?.operations ?? [])],
          ...(Number.isInteger(toolGrantExtras?.maxCalls) && toolGrantExtras.maxCalls > 0
            ? {
                operationBudgets: [{
                  id: 'figma-desktop',
                  operations: toolGrantExtras.operations ?? [],
                  maxCalls: toolGrantExtras.maxCalls,
                }],
              }
            : {}),
          ...(pluginGrantContext ?? {}),
        })
      : null;
    let toolTokenRevoked = false;
    const revokeToolToken = (reason) => {
      if (toolTokenRevoked || !toolTokenGrant) return;
      toolTokenRevoked = true;
      toolTokenRegistry.revokeToken(toolTokenGrant.token, reason);
    };
    const runtimeToolPrompt = createAgentRuntimeToolPrompt(daemonUrl, toolTokenGrant);
    const commentHint = renderCommentAttachmentHint(safeCommentAttachments);

    // Resolve external MCP config + stored OAuth tokens up-front so the
    // system prompt can warn the model away from Claude Code's synthetic
    // `*_authenticate` / `*_complete_authentication` tools for any
    // server the daemon already holds a valid Bearer for. We re-use both
    // values further down at .mcp.json write time — see the spawn block
    // below — instead of re-reading.
    let externalMcpConfig = { servers: [] };
    try {
      externalMcpConfig = await readMcpConfig(RUNTIME_DATA_DIR);
    } catch (err) {
      console.warn(
        '[mcp-config] read failed:',
        err && err.message ? err.message : err,
      );
    }
    // Pipeline stage runs never get external MCP servers: docs ingest is a
    // daemon-side prefetch, dr-comp reads Figma through the daemon proxy
    // (`od tools figma …`), and every other stage only reads/writes files
    // (2026-08-18 audit of all three workflows). Attaching them only put
    // every server's tool definitions into each stage call's context. Chat
    // (and any non-pipeline run) keeps the user's Settings → External MCP.
    // An empty list also makes the branches below UNLINK a stale `.mcp.json`
    // / Codex profile a previous chat run left in the same cwd.
    const enabledExternalMcp = isPipelineProfile
      ? []
      : externalMcpConfig.servers.filter((s) => s.enabled);
    const oauthTokensForSpawn = {};
    try {
      const stored = await readAllTokens(RUNTIME_DATA_DIR);
      for (const [serverId, tok] of Object.entries(stored)) {
        if (!enabledExternalMcp.find((s) => s.id === serverId)) continue;
        // Default to the persisted access token; null it out if expired so
        // we never inject a stale `Authorization: Bearer …` header. The
        // model treats a server with a Bearer pinned as connected and
        // discourages re-auth, which is the worst possible UX when the
        // token is going to 401 every call.
        let access = isTokenExpired(tok) ? null : tok.accessToken;
        if (isTokenExpired(tok) && tok.refreshToken) {
          try {
            const refreshed = await refreshAndPersistToken(
              RUNTIME_DATA_DIR,
              serverId,
              tok,
            );
            if (refreshed) access = refreshed.accessToken;
          } catch (err) {
            console.warn(
              '[mcp-oauth] refresh failed for',
              serverId,
              err && err.message ? err.message : err,
            );
          }
        }
        if (access) {
          oauthTokensForSpawn[serverId] = access;
        } else {
          console.warn(
            '[mcp-oauth] skipping expired token for',
            serverId,
            '— reconnect required',
          );
        }
      }
    } catch (err) {
      console.warn(
        '[mcp-tokens] read failed:',
        err && err.message ? err.message : err,
      );
    }
    const connectedExternalMcp = enabledExternalMcp
      .filter((s) => typeof oauthTokensForSpawn[s.id] === 'string')
      .map((s) => ({ id: s.id, label: s.label }));

    const {
      prompt: daemonSystemPrompt,
      activeSkillDirs,
      critiqueShouldRun,
    } =
      await composeDaemonSystemPrompt({
        agentId,
        projectId,
        skillId,
        skillIds,
        designSystemId,
        streamFormat: def?.streamFormat ?? 'plain',
        locale,
        connectedExternalMcp,
        // Plan §3.M2 / §3.V1 — forward the run's snapshot id so the
        // prompt composer can splice in `## Active stage` blocks.
        // Default ON; set OD_BUNDLED_ATOM_PROMPTS=0 to opt out.
        appliedPluginSnapshotId: run?.appliedPluginSnapshotId ?? null,
        ...(isPipelineProfile
          ? { promptProfile: 'pipeline', pipelineUsesDesignSystem: pipelineUsesDesignSystem === true }
          : {}),
      });

    // Make skill side files reachable through three layers, in order of
    // preference. The skill preamble emitted by `withSkillRootPreamble()`
    // advertises both the cwd-relative path (1) and the absolute path
    // (2/3) so the agent can pick whichever works.
    //
    //   1. CWD-relative copy. Stage every active/composed skill into
    //      `<cwd>/.od-skills/<folder>/` so any agent CLI — not just the
    //      ones that honour `--add-dir` — can reach those files via a
    //      path inside its working directory. We copy (not symlink) so
    //      each staged directory is a true write barrier — agents cannot
    //      mutate the shipped repo resource through their cwd.
    //   2. `--add-dir` allowlist. For non-Codex agents, pass `SKILLS_DIR`
    //      and `DESIGN_SYSTEMS_DIR` so the absolute fallback path in the
    //      preamble is reachable when staging fails (e.g. the project has
    //      no on-disk cwd, or fs.cp errored). Codex treats `--add-dir`
    //      entries as writable, so Codex receives only the narrow
    //      `${CODEX_HOME:-$HOME/.codex}/generated_images` output folder
    //      for allowlisted gpt-image image projects.
    //   3. PROJECT_ROOT cwd. When `cwd` is null, the agent runs with
    //      `cwd: PROJECT_ROOT` — there the absolute path is already an
    //      in-cwd path, so neither (1) nor (2) is required for it to
    //      resolve.
    //
    // Design systems are *not* staged here. Their bodies are read by the
    // daemon and folded into the system prompt directly (see
    // `readDesignSystem`), so an agent never has to open them via the
    // filesystem.
    if (cwd && activeSkillDirs.length > 0) {
      for (const skillDir of activeSkillDirs) {
        const result = await stageActiveSkill(
          cwd,
          skillCwdAliasSegment(skillDir),
          skillDir,
          (msg) => console.warn(msg),
        );
        if (!result.staged) {
          console.warn(
            `[od] skill-stage skipped: ${result.reason ?? 'unknown reason'}; falling back to absolute paths`,
          );
        }
      }
    }
    // Resolve the agent's effective working directory once and use it
    // everywhere the agent could read it (buildArgs runtimeContext, spawn
    // cwd, ACP session new). Falling back to PROJECT_ROOT — rather than
    // letting `spawn` inherit the daemon process cwd — is what makes the
    // absolute-path fallback in the skill preamble actually in-cwd for
    // no-project runs (packaged daemons / service launches do not start
    // their working directory from the workspace root).
    const effectiveCwd = cwd ?? PROJECT_ROOT;
    let codexGeneratedImagesDir = resolveCodexGeneratedImagesDir(
      agentId,
      projectRecord?.metadata,
    );
    if (codexGeneratedImagesDir) {
      codexGeneratedImagesDir = validateCodexGeneratedImagesDir(
        codexGeneratedImagesDir,
        {
          protectedDirs: [SKILLS_DIR, DESIGN_SYSTEMS_DIR, ...linkedDirs],
        },
      );
    }
    const extraAllowedDirs = resolveChatExtraAllowedDirs({
      agentId,
      skillsDir: SKILLS_DIR,
      designSystemsDir: DESIGN_SYSTEMS_DIR,
      linkedDirs,
      codexGeneratedImagesDir,
    });
    const codexImagegenOverride = resolveGrantedCodexImagegenOverride({
      agentId,
      metadata: projectRecord?.metadata,
      codexGeneratedImagesDir,
      extraAllowedDirs,
    });
    const researchCommandContract = resolveResearchCommandContract(
      research,
      message,
    );
    const userRequestPrompt = composeChatUserRequestForAgent(
      message,
      currentPrompt,
    );
    const clientInstructionPrompt = [researchCommandContract, runContextPrompt, systemPrompt]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
      .join('\n\n---\n\n');
    const instructionPrompt = composeLiveInstructionPrompt({
      daemonSystemPrompt,
      runtimeToolPrompt,
      clientSystemPrompt: clientInstructionPrompt,
      finalPromptOverride: codexImagegenOverride,
    });
    // Some models (notably claude-opus-4-7 with --include-partial-messages)
    // start their reply by echoing the top of the user message verbatim,
    // so the rendered chat shows a "# Instructions ..." block ahead of the
    // real answer. Closing every Instructions block with an explicit
    // "do not echo" line cuts the regression in practice without changing
    // the turn-shape every agent CLI expects (user message carrying both
    // instructions and request) — see server.ts:9920 composer notes.
    const ECHO_GUARD =
      '\n\n(Do not quote, restate, or echo the # Instructions block above in your reply. Begin your response with the answer to the # User request below.)';
    const composed = [
      instructionPrompt
        ? `# Instructions (read first)\n\n${instructionPrompt}${cwdHint}${linkedDirsHint}${ECHO_GUARD}\n\n---\n`
        : cwdHint
          ? `# Instructions${cwdHint}${linkedDirsHint}${ECHO_GUARD}\n\n---\n`
          : linkedDirsHint
            ? `# Instructions${linkedDirsHint}${ECHO_GUARD}\n\n---\n`
            : '',
      `# User request\n\n${userRequestPrompt}${attachmentHint}${commentHint}`,
      safeImages.length
        ? `\n\n${safeImages.map((p) => `@${p}`).join(' ')}`
        : '',
    ].join('');
    // Per-agent model + reasoning the user picked in the model menu.
    // Trust the value when it matches the most recent /api/agents listing
    // (live or fallback). Otherwise allow it through if it passes a
    // permissive sanitizer — that's the path for user-typed custom model
    // ids the CLI's listing didn't surface yet.
    const safeModel =
      typeof model === 'string'
        ? isKnownModel(def, model)
          ? model
          : sanitizeCustomModel(model)
        : null;
    const safeReasoning =
      typeof reasoning === 'string' && Array.isArray(def.reasoningOptions)
        ? (def.reasoningOptions.find((r) => r.id === reasoning)?.id ?? null)
        : null;
    const agentOptions = { model: safeModel, reasoning: safeReasoning };
    // `mcpServers` starts empty; the two Open Design-internal MCP servers
    // (open-design-live-artifacts / open-design-overview) that used to seed
    // it were removed (WP9). It is still populated below by any external
    // MCP servers the user configured in Settings → External MCP.
    const mcpServers = [];

    // External MCP servers configured by the user in Settings → External MCP.
    // Open Design relays them to the agent so the model can call those tools.
    // Two delivery shapes today:
    //   - Claude Code: write a `.mcp.json` into the project cwd. Claude Code
    //     auto-loads that file at spawn (same format the CLI accepts via
    //     `claude mcp add` + Claude Desktop's config). Fire-and-forget; we
    //     deliberately do NOT block spawn on a write failure since the agent
    //     can still run without external tools — log a warning and continue.
    //   - ACP agents (Hermes/Kimi): merge stdio entries into the existing
    //     `mcpServers` array; SSE/HTTP entries are skipped because ACP's
    //     stdio-only descriptor can't represent them yet.
    // Other agents (Codex, Gemini, OpenCode, Cursor, Qwen, Qoder, Copilot,
    // Pi, DeepSeek) inherit the user's per-CLI MCP config from their own
    // home dir for now — a future change can grow this list.
    //
    // The MCP config + OAuth tokens were resolved earlier (above
    // composeDaemonSystemPrompt) so the system prompt could mention any
    // already-authenticated servers; we reuse `enabledExternalMcp` and
    // `oauthTokensForSpawn` here for the Claude `.mcp.json` write +
    // ACP merge so we don't pay for a second filesystem read.
    //
    // Claude Code: write `.mcp.json` to the daemon-managed project cwd before
    // spawn so Claude Code auto-loads the user's external MCP servers. Strict
    // gating is essential here:
    //   - cwd must be set (no project → no `.mcp.json` write).
    //   - cwd must live UNDER PROJECTS_DIR. We never write to a git-linked
    //     baseDir (= the user's own repo), since that would silently overwrite
    //     a hand-crafted .mcp.json the user already keeps in their source tree.
    // We also unlink a stale `.mcp.json` we previously wrote when the user has
    // since disabled all servers, so removing a server actually takes effect
    // on the next run.
    // Dispatch on `def.externalMcpInjection` rather than hard-coding agent
    // id / stream-format checks. The three branches are functionally
    // equivalent to the previous shape (claude/acp), with the OpenCode
    // env-content branch added to fix #2142. Runtimes that leave the field
    // undefined fall through unchanged — the settings UI surfaces an
    // explicit "external MCP is not forwarded to <agent>" banner for them
    // so the previous silent-failure UX is gone.
    if (
      def.externalMcpInjection === 'claude-mcp-json' &&
      isManagedProjectCwd(cwd, PROJECTS_DIR)
    ) {
      {
        const target = path.join(cwd, '.mcp.json');
        if (enabledExternalMcp.length > 0) {
          try {
            const claudeMcp = buildClaudeMcpJson(
              enabledExternalMcp,
              oauthTokensForSpawn,
            );
            if (claudeMcp) {
              await fs.promises.mkdir(path.dirname(target), { recursive: true });
              await fs.promises.writeFile(
                target,
                JSON.stringify(claudeMcp, null, 2),
                'utf8',
              );
            }
          } catch (err) {
            console.warn(
              '[mcp-config] failed to write project .mcp.json:',
              err && err.message ? err.message : err,
            );
          }
        } else {
          try {
            await fs.promises.unlink(target);
          } catch (err) {
            if ((err && err.code) !== 'ENOENT') {
              console.warn(
                '[mcp-config] failed to remove stale .mcp.json:',
                err && err.message ? err.message : err,
              );
            }
          }
        }
      }
    }
    if (
      enabledExternalMcp.length > 0 &&
      def.externalMcpInjection === 'acp-merge'
    ) {
      const acpExternal = buildAcpMcpServers(enabledExternalMcp);
      mcpServers.push(...acpExternal);
    }
    // Codex: write a TOML "profile-v2" layer to
    // `$CODEX_HOME/od-injected.config.toml` and pass `--profile-v2
    // od-injected`. Codex layers it on top of the user's base
    // ~/.codex/config.toml without mutating it — adding a server in
    // Settings → External MCP becomes visible to Codex on the next run
    // without the user editing TOML by hand. When no stdio servers are
    // enabled, we delete the stale file and SKIP the flag so Codex
    // doesn't try to load an empty (or absent) layer.
    const CODEX_PROFILE_NAME = 'od-injected';
    let codexProfileName: string | undefined;
    let sandboxCodexProfile: { name: string; toml: string } | null = null;
    if (def.externalMcpInjection === 'codex-profile-v2') {
      const codexHome =
        process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
          ? process.env.CODEX_HOME.trim()
          : path.join(os.homedir(), '.codex');
      const profilePath = path.join(
        codexHome,
        `${CODEX_PROFILE_NAME}.config.toml`,
      );
      const toml = buildCodexMcpToml(enabledExternalMcp);
      if (toml) {
        if (willSandbox && agentId === 'codex') {
          const name = sandboxCodexProfileName(runId);
          sandboxCodexProfile = { name, toml };
          codexProfileName = name;
        } else {
          try {
            await fs.promises.mkdir(codexHome, { recursive: true });
            await fs.promises.writeFile(profilePath, toml, 'utf8');
            codexProfileName = CODEX_PROFILE_NAME;
          } catch (err) {
            console.warn(
              '[mcp-config] failed to write Codex profile-v2:',
              err && err.message ? err.message : err,
            );
          }
        }
      } else {
        try {
          await fs.promises.unlink(profilePath);
        } catch (err) {
          if ((err && err.code) !== 'ENOENT') {
            console.warn(
              '[mcp-config] failed to remove stale Codex profile-v2:',
              err && err.message ? err.message : err,
            );
          }
        }
      }
    }

    // OpenCode: serialise enabled MCP servers into its `mcp` config schema
    // and hand the JSON to the child via `OPENCODE_CONFIG_CONTENT`. The env
    // var is *merged* with the user's saved `~/.config/opencode/opencode
    // .json` (per OpenCode's documented config layering), so adding a
    // server here does not erase whatever the user already has in their
    // global config. We deliberately leave the env unset when no servers
    // are enabled — overwriting with `{}` would wipe the user's saved
    // mcp section for this single invocation, which is exactly the kind
    // of surprise the previous silent-failure UX taught us to avoid.
    let opencodeConfigContent: string | null = null;
    if (
      def.externalMcpInjection === 'opencode-env-content' &&
      enabledExternalMcp.length > 0
    ) {
      try {
        opencodeConfigContent = buildOpenCodeMcpConfigContent(
          enabledExternalMcp,
          oauthTokensForSpawn,
        );
      } catch (err) {
        console.warn(
          '[mcp-config] failed to build OPENCODE_CONFIG_CONTENT:',
          err && err.message ? err.message : err,
        );
      }
    }

    // Pre-flight the composed prompt against any argv-byte budget the
    // adapter declared (only DeepSeek TUI today — its CLI doesn't accept
    // a `-` stdin sentinel, so the prompt has to ride argv). Doing this
    // before bin resolution means the test harness pins the guard
    // independently of whether the adapter binary happens to be on PATH
    // in the CI environment, and the user gets the actionable
    // adapter-named error even if /api/agents hadn't refreshed yet.
    const promptBudgetError = checkPromptArgvBudget(def, composed);
    if (promptBudgetError) {
      design.runs.emit(
        run,
        'error',
        createSseErrorPayload(
          promptBudgetError.code,
          promptBudgetError.message,
          { retryable: false },
        ),
      );
      return design.runs.finish(run, 'failed', 1, null);
    }

    let configuredAgentEnv = {};
    try {
      const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
      configuredAgentEnv = agentCliEnvForAgent(appConfig.agentCliEnv, def.id);
    } catch {
      configuredAgentEnv = {};
    }

    const agentLaunch = resolveAgentLaunch(def, configuredAgentEnv);
    const resolvedBin = agentLaunch.selectedPath;

    const args = def.buildArgs(
      composed,
      safeImages,
      extraAllowedDirs,
      agentOptions,
      { cwd: effectiveCwd, codexProfileName },
    );

    // Second-pass budget check that knows about the Windows `.cmd` shim
    // wrap. The pre-buildArgs `checkPromptArgvBudget` only looks at the
    // raw composed prompt; on Windows an npm-installed adapter resolves
    // to e.g. `deepseek.cmd`, the spawn path goes through `cmd.exe /d /s
    // /c "<inner>"`, and `quoteForWindowsCmdShim` doubles every embedded
    // `"` plus wraps any whitespace/special-char arg in outer quotes —
    // so a quote-heavy prompt that fit under `maxPromptArgBytes` can
    // still expand past CreateProcess's 32_767-char cap. Fail fast with
    // the same `AGENT_PROMPT_TOO_LARGE` shape so the SSE error path
    // doesn't have to special-case it.
    const cmdShimBudgetError = checkWindowsCmdShimCommandLineBudget(
      def,
      agentLaunch.launchPath ?? resolvedBin,
      args,
    );
    if (cmdShimBudgetError) {
      design.runs.emit(
        run,
        'error',
        createSseErrorPayload(
          cmdShimBudgetError.code,
          cmdShimBudgetError.message,
          { retryable: false },
        ),
      );
      return design.runs.finish(run, 'failed', 1, null);
    }

    // Companion guard for non-shim Windows installs (e.g. a cargo-built
    // `deepseek.exe` rather than the npm `.cmd` shim). Direct `.exe`
    // spawns skip the cmd.exe wrap above, but Node/libuv still composes
    // a CreateProcess `lpCommandLine` by walking each argv element
    // through `quote_cmd_arg`, which escapes every embedded `"` as `\"`
    // and doubles backslashes adjacent to quotes. A quote-heavy prompt
    // under `maxPromptArgBytes` can expand past the 32_767-char kernel
    // cap there too, so the cmd-shim early-return alone would let those
    // users hit a generic `spawn ENAMETOOLONG`.
    const directExeBudgetError = checkWindowsDirectExeCommandLineBudget(
      def,
      agentLaunch.launchPath ?? resolvedBin,
      args,
    );
    if (directExeBudgetError) {
      design.runs.emit(
        run,
        'error',
        createSseErrorPayload(
          directExeBudgetError.code,
          directExeBudgetError.message,
          { retryable: false },
        ),
      );
      return design.runs.finish(run, 'failed', 1, null);
    }

    const send = (event, data) => {
      persistRunEventToAssistantMessage(db, run, event, data);
      design.runs.emit(run, event, data);
    };
    const runStartTimeMs = Date.now();
    const inactivityTimeoutMs = resolveChatRunInactivityTimeoutMs();
    const artifactQuietPeriodMs = resolveChatRunArtifactQuietPeriodMs();
    const inactivityKillGraceMs = 3_000;
    let inactivityTimer = null;
    let childStdoutSeen = false;
    let lastAgentEventPhase = 'spawn pending';
    let lastToolResultChars = 0;
    // Becomes true once any live-artifact create has been registered for
    // this run. Subsequent watchdog scheduling uses the shorter quiet
    // period, and a watchdog trip after this point is treated as
    // "agent finished the deliverable and went idle" rather than
    // "agent stalled with nothing to show" (issue #1451).
    let artifactRegistered = false;
    // Only daemon-initiated quiet-period termination should be treated
    // as `succeeded` in the close handler. A later unrelated SIGTERM /
    // SIGKILL (external `kill`, OOM, container shutdown) must keep its
    // existing `failed` classification even when `artifactRegistered`
    // is true — those signals don't mean the agent finished cleanly,
    // they just terminated the process. Set strictly inside
    // `failForInactivity`'s quiet-period branch.
    let artifactQuietShutdownRequested = false;
    const summarizeAgentEventForInactivity = (payload) => {
      const type = payload?.type ? String(payload.type) : 'unknown';
      if (type === 'tool_result') {
        const content = typeof payload.content === 'string' ? payload.content : '';
        lastToolResultChars = Math.max(lastToolResultChars, content.length);
        return `tool_result:${content.length} chars`;
      }
      if (type === 'tool_use') {
        const name = payload?.name ? String(payload.name) : 'unknown';
        return `tool_use:${name}`;
      }
      if (type === 'text_delta' || type === 'thinking_delta') {
        const text = typeof payload.text === 'string' ? payload.text : '';
        return `${type}:${text.length} chars`;
      }
      return type;
    };
    const clearInactivityWatchdog = () => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
    };
    const scheduleForcedChildShutdown = () => {
      if (!child) return;
      setTimeout(() => {
        if (child && !child.killed) child.kill('SIGTERM');
      }, inactivityKillGraceMs).unref?.();
      setTimeout(() => {
        if (child && !child.killed) child.kill('SIGKILL');
      }, inactivityKillGraceMs * 2).unref?.();
    };
    const failForInactivity = () => {
      if (run.cancelRequested || design.runs.isTerminal(run.status)) return;
      clearInactivityWatchdog();
      if (artifactRegistered) {
        // The deliverable already exists. The agent process is either
        // genuinely idle (claude-code's stream-json child sitting on an
        // open stdin) or wedged in post-write reasoning that never
        // emits stdout. Either way, finishing the run via the normal
        // child-exit path (status decision in child.on('close') below)
        // is safer than tearing it down with a failure banner — the
        // tool token, cancel state, and exit-code classification stay
        // owned by the existing lifecycle. SIGTERM the child and let
        // the close handler classify the run as succeeded (via the
        // artifactQuietShutdown branch). Mark this termination as
        // daemon-initiated so an unrelated later signal (external
        // kill, OOM) is NOT silently reclassified to `succeeded` —
        // only signals from this watchdog branch should be.
        artifactQuietShutdownRequested = true;
        if (acpSession?.abort) {
          acpSession.abort();
        }
        if (child && !child.killed) child.kill('SIGTERM');
        scheduleForcedChildShutdown();
        return;
      }
      const message =
        `Agent stalled without emitting any new output for ${Math.round(inactivityTimeoutMs / 1000)}s. ` +
        'The model or CLI likely hung while generating. ' +
        `Phase details: spawned agent ${userFacingAgentLabel(agentId, resolvedBin)}; stdout arrived: ${childStdoutSeen ? 'yes' : 'no'}; ` +
        `last agent event: ${lastAgentEventPhase}; largest tool result observed: ${lastToolResultChars} chars. ` +
        'Retry the turn, pick a different model, or start a new conversation if the prior context is very large.';
      send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', message, { retryable: true }));
      design.runs.finish(run, 'failed', 1, null);
      if (acpSession?.abort) {
        acpSession.abort();
      }
      if (child && !child.killed) child.kill('SIGTERM');
      scheduleForcedChildShutdown();
    };
    const activeInactivityTimeoutMs = () =>
      resolveActiveInactivityTimeoutMs({
        inactivityTimeoutMs,
        artifactQuietPeriodMs,
        artifactRegistered,
      });
    const noteAgentActivity = () => {
      const delay = activeInactivityTimeoutMs();
      if (delay <= 0) return;
      clearInactivityWatchdog();
      inactivityTimer = setTimeout(failForInactivity, delay);
      inactivityTimer.unref?.();
    };
    const noteArtifactRegistered = () => {
      if (artifactRegistered) return;
      artifactRegistered = true;
      // Switch the watchdog to the shorter quiet-period window
      // immediately so we don't have to wait for the next agent event
      // before the new ceiling takes effect. Call unconditionally:
      // an earlier `if (inactivityTimer)` gate left the run in limbo
      // when `OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS=0` but
      // `OD_CHAT_RUN_ARTIFACT_QUIET_PERIOD_MS>0` — noteAgentActivity()
      // had returned early at run start (pre-artifact delay = 0,
      // no timer set), so the guard then skipped the re-arm and the
      // newly-positive quiet-period delay never armed a timer at all.
      // `noteAgentActivity` itself is the one that decides whether to
      // schedule (it bails when the active delay is 0), so leaving the
      // decision there keeps the behavior coherent across all four
      // combinations of pre / quiet timeouts.
      noteAgentActivity();
    };
    const unregisterChatAgentEventSink = () => {
      const sinkRunId = toolTokenGrant?.runId ?? runId;
      activeChatAgentEventSinks.delete(sinkRunId);
      activeChatRunHandles.delete(sinkRunId);
    };
    if (toolTokenGrant?.runId) {
      activeChatAgentEventSinks.set(toolTokenGrant.runId, (payload) => {
        lastAgentEventPhase = summarizeAgentEventForInactivity(payload);
        noteAgentActivity();
        send('agent', payload);
      });
      activeChatRunHandles.set(toolTokenGrant.runId, { noteArtifactRegistered });
    }
    // ── Agent-in-sandbox gate (docs/agent-in-sandbox-spec-plan.md) ────────
    // The DECISION (`willSandbox`) was made before the system prompt was
    // composed — it shapes the prompt's cwd. Here only the machine-side
    // preflight (docker + image + auth volume) runs. Preflight failures fail
    // the run loudly: silently spawning on the host instead would drop the
    // isolation boundary without anyone noticing. Decided BEFORE the
    // host-binary guard below: a sandboxed run spawns the CLI baked into the
    // image, so a machine with NO host install must still pass.
    let sandboxPlan = null;
    if (willSandbox) {
      let image = null;
      let failure = null;
      const builderDir = path.join(SKILLS_DIR, 'ui-react', 'builder');
      try {
        image = sandboxImageTag(builderDir);
      } catch {
        failure = 'Sandbox version pin (skills/ui-react/builder/sandbox/sandbox.version) is unreadable.';
      }
      // First-run AUTO-BUILD: on a fresh machine the sandbox image doesn't
      // exist yet. Rather than hard-failing preflight with "image is missing",
      // build it in-process (direct `docker build`, so it works on Windows
      // without Git Bash) as long as Docker is running. The login volume still
      // can't be automated — preflight below reports that if absent.
      if (image && (await dockerAvailable()) && !(await dockerImagePresent(image))) {
        send('stderr', { chunk: `\n[sandbox] image ${image} missing — building it now (first run, this can take a few minutes)…\n` });
        const built = await ensureSandboxImage(builderDir, image, (line) => send('stderr', { chunk: line }));
        if (!built.ok) failure = built.reason ?? 'sandbox image auto-build failed';
      }
      if (image && !failure) {
        // Older installers embedded a shared OAuth credential. Retire it once
        // before preflight; users now authenticate each CLI from Settings.
        await retireLegacyPackagedSandboxAuth(image);
        const preflight = await sandboxPreflight(image, agentId === 'codex' ? 'codex' : 'claude');
        if (!preflight.ok) failure = preflight.reason ?? 'sandbox preflight failed';
        if (!failure && sandboxCodexProfile) {
          try {
            await materializeSandboxCodexProfile(image, sandboxCodexProfile.name, sandboxCodexProfile.toml);
          } catch (err) {
            failure = `Không thể đưa MCP profile vào Codex sandbox: ${(err as Error).message}`;
          }
        }
      }
      if (failure) {
        revokeToolToken('child_exit');
        unregisterChatAgentEventSink();
        send('error', createSseErrorPayload('AGENT_SANDBOX_UNAVAILABLE', failure, { retryable: true }));
        return design.runs.finish(run, 'failed', 1, null);
      }
      sandboxPlan = { image, cfg: sandboxCfgForRun };
    }

    // ── Write isolation gate (docs/run-write-isolation-spec.md) ───────────
    // Lightweight Seatbelt-based write-scope tier at the same seam as the
    // docker sandbox decision above. Mutually exclusive with it: a docker
    // sandboxed run is already stronger (siblings invisible, not just
    // read-only), so it skips this tier entirely.
    let writeIsolationPlan = null;
    if (!sandboxPlan) {
      let writeIsolationError = null;
      // `def.writableStatePaths` (e.g. codex → `.codex`) are bare,
      // HOME-relative segments — resolve them against the real home dir and
      // fold them into the same extraWritableDirs allowlist linkedDirs
      // already flows through, so a codex run can write its own session
      // state (auth, PATH-alias shims) under the Seatbelt tier the same way
      // it already can unisolated. Only ever contains THIS run's agent's
      // paths, so e.g. a claude run's profile does not gain `~/.codex`.
      const runtimeStateDirs = resolveWritableStatePaths(os.homedir(), def.writableStatePaths);
      try {
        writeIsolationPlan = await planWriteIsolation({
          cwd: effectiveCwd,
          extraWritableDirs: [...linkedDirs, ...runtimeStateDirs],
          runId,
        });
      } catch (err) {
        // planWriteIsolation can reject (bad cwd path chars, tmpdir write
        // failure) — caught locally so it can't escape this `if` and land in
        // runs.start's generic .catch (runs.ts), which fails the run without
        // running this branch's revokeToolToken/unregisterChatAgentEventSink
        // cleanup below.
        writeIsolationPlan = null;
        writeIsolationError = err instanceof Error ? err.message : String(err);
      }
      if (!writeIsolationPlan && writeIsolationMode() === 'required') {
        revokeToolToken('child_exit');
        unregisterChatAgentEventSink();
        send('error', createSseErrorPayload('WRITE_ISOLATION_UNAVAILABLE', 'Write isolation is required (OD_WRITE_ISOLATION=required) but unavailable on this host (needs macOS with /usr/bin/sandbox-exec).', { retryable: true }));
        return design.runs.finish(run, 'failed', 1, null);
      }
      if (!writeIsolationPlan && writeIsolationMode() === 'on') {
        // Spec's "warn-and-run": mode 'on' isolates when possible but never
        // blocks the run when it can't — a loud stderr line instead of a
        // silently unisolated spawn.
        send('stderr', {
          chunk: `\n[write-isolation] unavailable on this host (needs macOS + /usr/bin/sandbox-exec) — run is NOT write-isolated.${writeIsolationError ? ` (${writeIsolationError})` : ''}\n`,
        });
      }
    }
    // Per-run profile file lives in its own mkdtemp'd dir (write-isolation.ts);
    // best-effort delete on every exit path below — it contains only paths,
    // so a missed cleanup is not a leak of anything sensitive.
    const cleanupWriteIsolationProfile = () => {
      if (!writeIsolationPlan) return;
      void fs.promises.rm(path.dirname(writeIsolationPlan.profilePath), { recursive: true, force: true }).catch(() => {});
    };

    // If detection can't find the binary, surface a friendly SSE error
    // pointing at /api/agents instead of silently falling back to
    // spawn(def.bin) — that fallback re-introduces the exact ENOENT symptom
    // from issue #10. A sandboxed run is exempt: its binary lives inside the
    // image, the host install is irrelevant.
    if (!sandboxPlan && (!resolvedBin || !agentLaunch.launchPath)) {
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      send('error', createSseErrorPayload(
        'AGENT_UNAVAILABLE',
        `Agent "${def.name}" (\`${def.bin}\`) is not installed or not on PATH. ` +
          'Install it and refresh the agent list (GET /api/agents) before retrying.',
        { retryable: true },
      ));
      return design.runs.finish(run, 'failed', 1, null);
    }
    const odMediaEnv = {
      OD_BIN,
      OD_NODE_BIN,
      OD_DAEMON_URL: daemonUrl,
      ...(typeof projectId === 'string' && projectId && cwd
        ? {
            OD_PROJECT_ID: projectId,
            OD_PROJECT_DIR: cwd,
          }
        : {}),
    };
    if (run.cancelRequested || design.runs.isTerminal(run.status)) {
      cleanupWriteIsolationProfile();
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      return;
    }

    run.status = 'running';
    run.updatedAt = Date.now();
    send('start', {
      runId,
      agentId,
      sandboxed: Boolean(sandboxPlan),
      writeIsolated: Boolean(writeIsolationPlan),
      bin: userFacingAgentLabel(agentId, resolvedBin),
      streamFormat: def.streamFormat ?? 'plain',
      projectId: typeof projectId === 'string' ? projectId : null,
      cwd,
      model: safeModel,
      reasoning: safeReasoning,
      toolTokenExpiresAt: toolTokenGrant?.expiresAt ?? null,
      // Surface active skills so the web client can render an "Applied
      // skills" card. `run.skillId` was set above from the chatBody (or
      // remains undefined if the request relied on the project default
      // without an explicit override). Ad-hoc per-turn @-mentioned skills
      // come straight from the chatBody field; we sanitize to a string
      // array to avoid forwarding malformed shapes to the SSE consumer.
      skillId: run.skillId ?? null,
      skillIds: Array.isArray(skillIds)
        ? skillIds.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [],
    });
    noteAgentActivity();

    let child;
    let acpSession = null;
    let writePromptToChildStdin = false;
    let spawnedAgentEnv = null;
    let agentStdoutTail = '';
    let agentStderrTail = '';
    try {
      // Prompt delivery via stdin is now the universal default. This bypasses
      // both the cmd.exe 8KB limit and the CreateProcess 32KB limit.
      const stdinMode =
        def.promptViaStdin || def.streamFormat === 'acp-json-rpc'
          ? 'pipe'
          : 'ignore';
      // WP2 (env whitelist): a sandboxed run's docker CLIENT process
      // (spawned locally to invoke `docker run ...`) still gets this same
      // `env` value below, but that's harmless — the CONTAINER only ever
      // receives its own separate `-e` whitelist from
      // `wrapInvocationInSandbox` (agent-sandbox.ts forwardedEnvKeys), never
      // this object. A true HOST spawn (no sandboxPlan — includes the
      // write-isolation path, which is host-mode with a tighter write
      // scope, not a separate env boundary) is where the full
      // `process.env` spread used to leak KGS_API_KEY / OD_ATLASSIAN_* /
      // SESSION_SECRET / etc. into the agent process — swap the base in
      // for those runs. See specs/change/20260813-web-first/wp2-env-whitelist.md.
      const hostSpawnBaseEnv = sandboxPlan ? process.env : buildHostAgentEnv(process.env);
      const env = applyAgentLaunchEnv({
        ...spawnEnvForAgent(
          def.id,
          {
            ...createAgentRuntimeEnv(hostSpawnBaseEnv, daemonUrl, toolTokenGrant),
            ...(def.env || {}),
          },
          configuredAgentEnv,
        ),
        ...odMediaEnv,
        // OpenCode external-MCP injection (issue #2142). Layered AFTER
        // spawnEnvForAgent / odMediaEnv / configuredAgentEnv so the
        // daemon-built MCP config wins over a stale value the user
        // might have exported in their shell — that would let an
        // outdated content string suppress the user's freshly-saved
        // MCP servers, which is exactly the bug we are fixing.
        // `opencodeConfigContent === null` means "no enabled servers";
        // we deliberately leave the env unset in that case so the
        // user's saved `~/.config/opencode/opencode.json` continues
        // to apply as-is.
        ...(opencodeConfigContent
          ? { OPENCODE_CONFIG_CONTENT: opencodeConfigContent }
          : {}),
      }, agentLaunch);
      spawnedAgentEnv = env;
      let invocation = createCommandInvocation({
        // Sandboxed runs may have NO host install: `def.bin` is a placeholder
        // that is immediately replaced by the docker invocation below.
        command: agentLaunch.launchPath ?? def.bin,
        args,
        env,
      });
      if (sandboxPlan) {
        // Same stdio protocol, different vessel: `docker run -i` pipes the
        // agent's stream-json stdin/stdout through unchanged, so everything
        // below (prompt write, stream parse, tool results) is untouched.
        // Container env is whitelist-only via -e flags; the docker CLIENT
        // process itself still gets the host `env` (harmless — it is not
        // the container environment).
        const wrapped = wrapInvocationInSandbox({
          agentBin: def.bin,
          args,
          env,
          cwd: effectiveCwd,
          runId,
          projectId: typeof projectId === 'string' && projectId ? projectId : null,
          daemonUrl,
          image: sandboxPlan.image,
          cfg: sandboxPlan.cfg,
          runtimeId: agentId === 'codex' ? 'codex' : 'claude',
        });
        run.sandboxContainerName = wrapped.containerName;
        invocation = createCommandInvocation({
          command: wrapped.command,
          args: wrapped.args,
          env,
        });
      } else if (writeIsolationPlan) {
        const wrapped = wrapInvocationInWriteIsolation({ command: agentLaunch.launchPath ?? def.bin, args }, writeIsolationPlan);
        invocation = createCommandInvocation({
          command: wrapped.command,
          args: wrapped.args,
          env,
        });
      }
      child = spawn(invocation.command, invocation.args, {
        env,
        stdio: [stdinMode, 'pipe', 'pipe'],
        cwd: effectiveCwd,
        shell: false,
        // Required when invocation wraps a Windows .cmd/.bat shim through
        // cmd.exe; without this, Node re-escapes the inner command line and
        // breaks paths containing spaces (issue #315).
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        // WP3 (host process lifecycle): host runs (no sandboxPlan) become
        // their own process GROUP leader so `killRunProcessTree` in runs.ts
        // can reach the whole descendant tree (MCP stdio servers, vite,
        // python, ...) via `process.kill(-pid, signal)` instead of just the
        // agent CLI itself. Sandboxed runs keep the previous (non-detached)
        // behavior — the spawned process there is the docker CLIENT, whose
        // lifecycle is already tied to the container via
        // `killSandboxContainer`, not to its own OS process group. Windows
        // has no process-group signal Node can reach, so it stays
        // non-detached there too; `killRunProcessTree` falls back to
        // `taskkill /T /F` instead. See
        // specs/change/20260813-web-first/wp3-process-lifecycle.md.
        detached: !sandboxPlan && process.platform !== 'win32',
      });
      if (sandboxPlan) {
        run.child = child;
      } else {
        // Records the pid (+ resolved command, for the boot-sweep's
        // pid-reuse safety check) under RUNS_STATE_DIR so a daemon restart
        // mid-run can still find and reap this process tree — see the
        // `sweepOrphanHostRuns()` call near daemon startup below.
        design.runs.attachHostChild(run, child, { command: invocation.command });
      }
      // Mirrors the sandboxTimeout close-listener just below: an independent
      // `once('close', ...)` hook is where the run finishes regardless of
      // which downstream branch (critique orchestrator vs. legacy) decides
      // the final status, so the profile is cleaned up exactly once here
      // instead of threading it through every design.runs.finish call site.
      child.once('close', () => cleanupWriteIsolationProfile());
      if (sandboxPlan && sandboxCodexProfile) {
        child.once('close', () => {
          void removeSandboxCodexProfile(sandboxPlan.image, sandboxCodexProfile!.name).catch(() => {});
        });
      }
      if (sandboxPlan && run.sandboxContainerName) {
        // Hard wall-clock cap for a sandboxed run: a hung container would
        // otherwise sit on its CPU/RAM reservation forever (run state is
        // in-memory, so nothing else would ever reap it mid-session).
        const sandboxDeadlineMs = sandboxPlan.cfg.timeoutMinutes * 60_000;
        const sandboxContainerName = run.sandboxContainerName;
        const sandboxTimeout = setTimeout(() => {
          if (design.runs.isTerminal(run.status)) return;
          send('error', createSseErrorPayload(
            'AGENT_EXECUTION_FAILED',
            `Sandboxed run exceeded ${sandboxPlan.cfg.timeoutMinutes} minutes and was killed (sandbox.timeoutMinutes).`,
          ));
          void killSandboxContainer(sandboxContainerName);
          if (run.child && !run.child.killed) run.child.kill('SIGKILL');
        }, sandboxDeadlineMs);
        sandboxTimeout.unref?.();
        child.once('close', () => clearTimeout(sandboxTimeout));
      }
      if (!sandboxPlan) {
        // Wall-clock cap for a HOST run (WP3 design §2 —
        // specs/change/20260813-web-first/wp3-process-lifecycle.md).
        // Docker gives sandboxed runs the ceiling above for free; host runs
        // previously had NO wall-clock cap at all — only the inactivity
        // watchdog (`resolveChatRunInactivityTimeoutMs`), which only fires
        // on silence and never on a chatty-but-endless run. Reuses the SAME
        // `sandbox.timeoutMinutes` app-config key (default 30) so existing
        // persisted prefs keep applying; `runTimeoutMinutes` is just a
        // neutral rename of the local binding now that it covers both
        // branches.
        const runTimeoutMinutes = sandboxCfgForRun.timeoutMinutes;
        design.runs.scheduleHostRunTimeout(run, {
          timeoutMs: runTimeoutMinutes * 60_000,
          timeoutMinutes: runTimeoutMinutes,
          send,
          createSseErrorPayload,
        });
      }
      if (def.promptViaStdin && child.stdin && def.streamFormat !== 'pi-rpc') {
        // EPIPE from a fast-exiting CLI (bad auth, missing model, exit on
        // launch) would otherwise surface as an unhandled stream error and
        // crash the daemon. Swallow it — the regular exit/close handlers
        // below already route the underlying failure to SSE via stderr.
        child.stdin.on('error', (err) => {
          // EPIPE = Unix broken-pipe when child closes its stdin read end
          // early. 'write EOF' (err.code 'EOF') = Windows equivalent of
          // the same condition via UV_EOF. Both mean the child exited before
          // reading stdin — the process exit/close handlers already route
          // the underlying failure to SSE via stderr, so swallow these here.
          if (err.code !== 'EPIPE' && err.code !== 'EOF' && err.message !== 'write EOF') {
            send(
              'error',
              createSseErrorPayload(
                'AGENT_EXECUTION_FAILED',
                `stdin: ${err.message}`,
              ),
            );
          }
        });
        writePromptToChildStdin = true;
      }
    } catch (err) {
      cleanupWriteIsolationProfile();
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', `spawn failed: ${err.message}`));
      design.runs.finish(run, 'failed', 1, null);
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // Reset the inactivity watchdog on every raw stdout byte so that
    // structured adapters that buffer partial lines (Codex item.completed,
    // pi-rpc session/prompt, ACP agent messages) and models that spend a
    // long time in non-streamed reasoning still keep the run alive.
    child.stdout.on('data', (chunk) => {
      childStdoutSeen = true;
      noteAgentActivity();
      agentStdoutTail = `${agentStdoutTail}${chunk}`.slice(-2000);
    });

    // ---- Memory: assistant-reply buffer for LLM extraction --------------
    // Capture up to 32 KiB of raw stdout. The LLM extractor (fired in the
    // close handler) trims further; we only need enough to ground the
    // model. Multiple `on('data')` listeners coexist — the wrapper-stream
    // handlers below also subscribe and that's fine.
    const MEMORY_BUFFER_CAP = 32 * 1024;
    let memoryAssistantBuffer = '';
    child.stdout.on('data', (chunk) => {
      if (memoryAssistantBuffer.length >= MEMORY_BUFFER_CAP) return;
      memoryAssistantBuffer += String(chunk);
      if (memoryAssistantBuffer.length > MEMORY_BUFFER_CAP) {
        memoryAssistantBuffer = memoryAssistantBuffer.slice(0, MEMORY_BUFFER_CAP);
      }
    });
    child.on('close', () => {
      const captured = memoryAssistantBuffer;
      const userMsg = typeof message === 'string' ? message : '';
      // Forward the chat agent id so memory-llm.pickProvider can
      // constrain its auto-pick to the chat protocol's family — keeps
      // a Claude Code (anthropic) chat from triggering OpenAI/gpt-4o-
      // mini extraction in the background just because the user has
      // an OpenAI key parked in media-config.
      void import('./memory-llm.js')
        .then(({ extractWithLLM }) =>
          extractWithLLM(
            RUNTIME_DATA_DIR,
            {
              userMessage: userMsg,
              assistantMessage: captured,
            },
              {
                projectRoot: PROJECT_ROOT,
                // The "same as chat" local-CLI extraction path re-invokes
                // this SAME turn's configured CLI — it must run in the
                // turn's own directory (`effectiveCwd`, already resolved
                // above for the real turn's own spawn), never
                // `PROJECT_ROOT` (the daemon's own install root). Passed
                // alongside `projectRoot`, not instead of it: that field
                // still separately anchors the BYOK media-config
                // credential store for non-local-CLI providers.
                chatCwd: effectiveCwd,
                chatAgentId: typeof agentId === 'string' ? agentId : null,
                chatModel: typeof safeModel === 'string' ? safeModel : null,
              },
            ),
        )
        .catch((err) => console.warn('[memory-llm] background failed', err));
    });

    // Critique Theater branch (M0 dark launch, default disabled).
    // Only plain-stream adapters are routed through runOrchestrator in v1.
    // Adapters that emit structured wrappers (claude-stream-json,
    // qoder-stream-json, copilot-stream-json, json-event-stream,
    // acp-json-rpc, pi-rpc) fall
    // through to the legacy single-pass code path below with a one-time
    // stderr warning so the parser never sees wrapper bytes. Per-format
    // decoding into the orchestrator is a v2 concern.
    //
    // Use critiqueShouldRun (computed in the prompt builder) instead of
    // just the env var or the rollout resolver so the orchestrator gate
    // is in lockstep with the panel addendum. Media surfaces and runs
    // missing brand/skill context never get the panel prompt, so they
    // must also skip the orchestrator and fall through to legacy
    // generation; otherwise the parser waits for <CRITIQUE_RUN> tags
    // the model was never told to emit.
    if (critiqueShouldRun) {
      const adapterStreamFormat: string = def.streamFormat ?? 'plain';
      if (adapterStreamFormat !== 'plain') {
        if (!critiqueWarnedAdapters.has(adapterStreamFormat)) {
          critiqueWarnedAdapters.add(adapterStreamFormat);
          console.warn(`[critique] adapter format=${adapterStreamFormat} is not plain-stream; skipping orchestrator and falling through to legacy generation`);
        }
      } else {
        const critiqueRunId = run.id;
        // Per-run artifact directory keeps concurrent or sequential runs in the
        // same project from overwriting each other's transcript or final HTML.
        // Spec: artifacts/<projectId>/<runId>/transcript.ndjson(.gz).
        const critiqueProjectKey = typeof projectId === 'string' && projectId ? projectId : critiqueRunId;
        const critiqueArtifactDir = path.join(ARTIFACTS_DIR, critiqueProjectKey, critiqueRunId);
        const stdoutIterable = (async function* () {
          for await (const chunk of child.stdout) yield String(chunk);
        })();
        // Forward each CritiqueSseEvent on its own contract-defined channel
        // (critique.run_started, critique.ship, critique.failed, ...) rather
        // than wrapping the frame inside the legacy 'agent' channel. Clients
        // that subscribe to the new event names see them directly with the
        // contract payload as event.data.
        //
        // Critique events go to TWO sinks (codex P1 on PR #1338):
        //
        //   1. `design.runs.emit(...)` via `send(...)`, which fans out on
        //      `/api/runs/:runId/events`. Existing transport, unchanged.
        //   2. The per-project event-sinks map, which fans out on
        //      `/api/projects/:projectId/events`. This is the transport the
        //      web `CritiqueTheaterMount` actually subscribes to (the mount
        //      is project-scoped, not run-scoped, because it lives at the
        //      project workspace level and follows the user across runs).
        //      Without this second sink the mount sees no frames in
        //      production and only the e2e tests' stubbed routes deliver
        //      anything to the reducer.
        //
        // The project-events route emits via `sse.send(payload.type,
        // payload)`, so we pack the SSE channel name onto `payload.type`
        // and let the sink push the right channel name. The web's
        // `sseToPanelEvent` overwrites `type` from the channel name on the
        // way back into a PanelEvent, so this round-trip stays correct.
        const critiqueProjectIdForBus =
          typeof projectId === 'string' && projectId ? projectId : null;
        const critiqueBus = {
          emit: (e) => {
            // Two transports for every critique event: the run-scoped
            // SSE send back to the originating chat run, plus the
            // project-scoped fan-out so the Theater mount (subscribed
            // to /api/projects/:id/events) sees it too. Route the
            // project fan-out through emitProjectEvent so empty-sink
            // cleanup and any future broadcast policy (rate limiting,
            // schema validation, telemetry) apply uniformly across
            // every project emitter (PerishCode P3 on PR #1338).
            send(e.event, e.data);
            if (critiqueProjectIdForBus) {
              emitProjectEvent(critiqueProjectIdForBus, { ...e.data, type: e.event });
            }
          },
        };

        // Register this run with the in-process registry so the interrupt
        // endpoint can cascade an AbortController to the orchestrator. The
        // register call must run BEFORE runOrchestrator is invoked, so a
        // request that arrives between spawn and orchestrator-start cannot
        // miss a runId that already has a live child process.
        const critiqueAbort = new AbortController();
        critiqueRunRegistry.register({
          runId: critiqueRunId,
          projectId: critiqueProjectKey,
          abort: critiqueAbort,
          startedAt: Date.now(),
        });

        // Stderr forwarding and child.on('error') must be wired BEFORE the
        // orchestrator awaits stdout. Otherwise a CLI that floods stderr can
        // fill the OS pipe and deadlock the run until the total timeout, and
        // an early child error fired before the orchestrator returns has no
        // listener. Both registrations are idempotent and the run lifecycle
        // is owned solely by the orchestrator's awaited result below.
        child.stderr.on('data', (chunk) => {
          noteAgentActivity();
          send('stderr', { chunk });
        });
        child.on('error', (err) => {
          send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', err.message));
        });

        // Wrap the child's close event so the orchestrator can race child
        // exit against parser completion, abort, and timeouts in one awaited
        // flow. Without this the orchestrator can't tell a non-zero exit
        // apart from a clean ship and may misclassify failures.
        const childExitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
        try {
          const orchestratorResult = await runOrchestrator({
            runId: critiqueRunId,
            projectId: typeof projectId === 'string' ? projectId : '',
            conversationId: typeof conversationId === 'string' ? conversationId : null,
            artifactId: critiqueRunId,
            artifactDir: critiqueArtifactDir,
            adapter: typeof agentId === 'string' ? agentId : 'unknown',
            // Codex P2 on PR #1485: thread the resolved skill id into the
            // orchestrator so the Phase 12 metrics carry the real label
            // instead of falling through to 'unknown' for every live run.
            // `effectiveSkillId` was already computed above (line ~2951) as
            // the request skillId with a project-row fallback; pass it
            // through verbatim, and leave the orchestrator's own default
            // of 'unknown' for runs that genuinely have no skill assigned.
            skill: typeof effectiveSkillId === 'string' && effectiveSkillId
              ? effectiveSkillId
              : undefined,
            cfg: critiqueCfg,
            db,
            bus: critiqueBus,
            stdout: stdoutIterable,
            child,
            childExitPromise,
            signal: critiqueAbort.signal,
          });
          // Map the critique terminal status to the chat run lifecycle.
          // 'shipped' and 'below_threshold' both ran to a ship decision and
          // finalize as 'succeeded'; every other status (timed_out,
          // interrupted, degraded, failed, legacy) is a failure path so the
          // run reflects the real outcome instead of a misleading success.
          const succeeded = orchestratorResult.status === 'shipped'
            || orchestratorResult.status === 'below_threshold';
          if (run.cancelRequested) {
            design.runs.finish(run, 'canceled', 1, null);
          } else if (succeeded) {
            design.runs.finish(run, 'succeeded', 0, null);
          } else {
            design.runs.finish(run, 'failed', 1, null);
          }
        } catch (err) {
          send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', err instanceof Error ? err.message : String(err)));
          design.runs.finish(run, 'failed', 1, null);
        } finally {
          critiqueRunRegistry.unregister(critiqueProjectKey, critiqueRunId);
        }
        return;
      }
    }

    // Structured streams (Claude Code) go through a line-delimited JSON
    // parser that turns stream_event objects into UI-friendly events. For
    // plain streams (most other CLIs) we forward raw chunks unchanged so
    // the browser can append them to the assistant's text buffer.
    let agentStreamError = null;
    // Tracks whether any stream the run is using actually emitted user-
    // visible content. Only the streams routed through `sendAgentEvent`
    // contribute to this flag; ACP sessions and plain stdout streams are
    // covered by their own success/failure paths and the empty-output
    // guard below skips them via `trackingSubstantiveOutput`.
    let agentProducedOutput = false;
    let trackingSubstantiveOutput = false;
    // Event types that count as "the agent actually produced something the
    // user can see." Lifecycle markers (`status`) and meter readings
    // (`usage`) deliberately do NOT count — a model can emit token-usage
    // numbers for an empty completion (issue #691), and a `status:running`
    // banner without any follow-up is exactly the silent-failure shape we
    // want to surface as failed instead of succeeded.
    const SUBSTANTIVE_AGENT_EVENT_TYPES = new Set([
      'text_delta',
      'thinking_delta',
      'tool_use',
      'tool_result',
      'artifact',
    ]);
    const sendAgentEvent = (ev) => {
      if (ev?.type === 'error') {
        if (agentStreamError) return;
        agentStreamError = String(ev.message || 'Agent stream error');
        clearInactivityWatchdog();
        const authFailure = classifyAgentAuthFailure(
          agentId,
          [
            agentStreamError,
            typeof ev.raw === 'string' ? ev.raw : '',
            agentStdoutTail,
            agentStderrTail,
          ].join('\n'),
        );
        if (authFailure?.status === 'missing') {
          send('error', createSseErrorPayload(
            'AGENT_AUTH_REQUIRED',
            authFailure.message ?? cursorAuthGuidance(),
            { retryable: true },
          ));
          return;
        }
        send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', agentStreamError, {
          details: ev.raw ? { raw: ev.raw } : undefined,
          retryable: false,
        }));
        return;
      }
      lastAgentEventPhase = summarizeAgentEventForInactivity(ev);
      noteAgentActivity();
      if (ev?.type && SUBSTANTIVE_AGENT_EVENT_TYPES.has(ev.type)) {
        agentProducedOutput = true;
      }
      send('agent', ev);
    };

    if (def.streamFormat === 'claude-stream-json') {
      const claude = createClaudeStreamHandler((ev) => {
        lastAgentEventPhase = summarizeAgentEventForInactivity(ev);
        noteAgentActivity();
        send('agent', ev);
        // Stream-json input mode keeps the child's stdin open across the
        // turn so we can answer interactive tools like `AskUserQuestion`
        // with a real `tool_result`. The child has no other way to know
        // the conversation is over, though — without an EOF it sits idle
        // until the inactivity watchdog kills it. Bookkeeping here:
        //   - tool_use(AskUserQuestion): record the id so we know we owe
        //     the model a tool_result before the turn can end.
        //   - turn_end (per-turn synthesized from `stop_reason`): fire on
        //     `end_turn` etc. but NOT on `tool_use` — that stop reason
        //     means the model paused mid-tool, not "turn complete".
        //   - usage (session result at EOF in single-shot mode).
        try {
          if (run.stdinOpen) {
            if (
              ev &&
              typeof ev === 'object' &&
              ev.type === 'tool_use' &&
              (ev.name === 'AskUserQuestion' || ev.name === 'ask_user_question') &&
              typeof ev.id === 'string'
            ) {
              if (!run.pendingHostAnswers) run.pendingHostAnswers = new Set();
              run.pendingHostAnswers.add(ev.id);
            } else if (
              ev &&
              typeof ev === 'object' &&
              ((ev.type === 'turn_end' &&
                // `stop_reason: tool_use` means the model paused to wait
                // for tool execution (claude-code is about to run an
                // internal tool, or we owe a host tool_result). Either
                // way the conversation is still in flight — do not close.
                ev.stopReason !== 'tool_use') ||
                ev.type === 'usage') &&
              (!run.pendingHostAnswers || run.pendingHostAnswers.size === 0)
            ) {
              // Per-turn `turn_end` (synthesized from
              // `assistant.message.stop_reason` in `claude-stream`) is the
              // primary close signal; `usage` is the session-level result
              // that fires at EOF in single-shot mode. Either is a valid
              // "this turn is done" cue, but only when there's no host
              // answer outstanding AND the model isn't paused mid-tool.
              if (run.child && run.child.stdin && !run.child.stdin.destroyed) {
                try { run.child.stdin.end(); } catch {}
              }
              run.stdinOpen = false;
            }
          }
        } catch {}
      });
      child.stdout.on('data', (chunk) => claude.feed(chunk));
      child.on('close', () => claude.flush());
    } else if (def.streamFormat === 'qoder-stream-json') {
      trackingSubstantiveOutput = true;
      const qoder = createQoderStreamHandler(sendAgentEvent);
      child.stdout.on('data', (chunk) => qoder.feed(chunk));
      child.on('close', () => qoder.flush());
    } else if (def.streamFormat === 'copilot-stream-json') {
      const copilot = createCopilotStreamHandler((ev) => {
        lastAgentEventPhase = summarizeAgentEventForInactivity(ev);
        noteAgentActivity();
        send('agent', ev);
      });
      child.stdout.on('data', (chunk) => copilot.feed(chunk));
      child.on('close', () => copilot.flush());
    } else if (def.streamFormat === 'pi-rpc') {
      // Route through sendAgentEvent so that pi-rpc's error events
      // (extension_error, auto_retry_end with success=false, and the
      // message_update error delta) set agentStreamError and flip the
      // run to `failed` on close — same path as qoder-stream-json and
      // json-event-stream after issue #691. Also enables the
      // substantive-output guard (agentProducedOutput) so a pi run
      // that exits 0 without producing visible content is caught.
      //
      // attachPiRpcSession invokes its send callback with the two-arg
      // channel/payload shape: send('agent', payload) for normal events
      // and send('error', {message}) from fail(). sendAgentEvent
      // expects a single event object, so we adapt at the call site:
      //   - 'agent' channel → relay payload through sendAgentEvent
      //   - 'error' channel → route through the daemon's error path
      //     (createSseErrorPayload + send SSE + set agentStreamError)
      trackingSubstantiveOutput = true;
      acpSession = attachPiRpcSession({
        child,
        prompt: composed,
        cwd: effectiveCwd,
        model: safeModel,
        send: (channel, payload) => {
          if (channel === 'agent') {
            sendAgentEvent(payload);
          } else if (channel === 'error') {
            if (agentStreamError) return;
            agentStreamError = String(payload?.message || 'Pi session error');
            clearInactivityWatchdog();
            send('error', createSseErrorPayload(
              'AGENT_EXECUTION_FAILED',
              agentStreamError,
              { retryable: false },
            ));
          } else {
            noteAgentActivity();
            send(channel, payload);
          }
        },
        imagePaths: def.supportsImagePaths ? safeImages : [],
        uploadRoot: UPLOAD_DIR,
      });
    } else if (def.streamFormat === 'acp-json-rpc') {
      const acpStageTimeoutMs = resolveAcpStageTimeoutMs();
      acpSession = attachAcpSession({
        child,
        prompt: composed,
        cwd: effectiveCwd,
        model: safeModel,
        mcpServers,
        send: (event, data) => {
          noteAgentActivity();
          send(event, data);
        },
        ...(acpStageTimeoutMs !== undefined ? { stageTimeoutMs: acpStageTimeoutMs } : {}),
      });
    } else if (def.streamFormat === 'json-event-stream') {
      // Pipe through sendAgentEvent so the OpenCode `type:'error'` frame
      // (now emitted as a real error event by json-event-stream.ts after
      // #691) actually triggers `agentStreamError` instead of being
      // forwarded as a no-op `agent` SSE event. This also wires the
      // substantive-output tracking the close handler reads below.
      trackingSubstantiveOutput = true;
      const handler = createJsonEventStreamHandler(
        def.eventParser || def.id,
        sendAgentEvent,
      );
      child.stdout.on('data', (chunk) => handler.feed(chunk));
      child.on('close', () => handler.flush());
    } else {
      child.stdout.on('data', (chunk) => {
        noteAgentActivity();
        send('stdout', { chunk });
      });
    }
    // Wire the acpSession onto the run so cancel() can call abort()
    // instead of raw SIGTERM (applies to pi-rpc and acp-json-rpc).
    run.acpSession = acpSession;
    child.stderr.on('data', (chunk) => {
      noteAgentActivity();
      agentStderrTail = `${agentStderrTail}${chunk}`.slice(-2000);
      send('stderr', { chunk });
    });

    child.on('error', (err) => {
      clearInactivityWatchdog();
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', err.message));
      design.runs.finish(run, 'failed', 1, null);
    });
    child.on('close', (code, signal) => {
      clearInactivityWatchdog();
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      // Sandboxed run: the child is only the `docker run` CLIENT. If it died
      // from a signal (Stop button SIGKILL, watchdog escalation, crash) the
      // container keeps running detached — kill it here so orphans never pile
      // up until the next app restart (they hog Docker and make the next
      // run's preflight time out). No-op when the container already exited.
      if (run.sandboxContainerName) {
        void killSandboxContainer(run.sandboxContainerName);
      }
      if (acpSession?.hasFatalError()) {
        return design.runs.finish(run, 'failed', code ?? 1, signal ?? null);
      }
      if (agentStreamError) {
        return design.runs.finish(run, 'failed', code ?? 1, signal ?? null);
      }
      if (
        code !== 0 &&
        !run.cancelRequested
      ) {
        const authFailure = classifyAgentAuthFailure(
          agentId,
          `${agentStderrTail}\n${agentStdoutTail}`,
        );
        if (authFailure?.status === 'missing') {
          send('error', createSseErrorPayload(
            'AGENT_AUTH_REQUIRED',
            authFailure.message ?? cursorAuthGuidance(),
            { retryable: true },
          ));
          return design.runs.finish(run, 'failed', code ?? 1, signal ?? null);
        }
      }
      // Empty-output guard: a clean `code === 0` exit on a stream we are
      // tracking, with no error frame and no substantive event, means the
      // run silently finished without producing anything visible. That used
      // to be marked `succeeded` and rendered as an empty assistant turn —
      // see issue #691, where OpenCode runs were ending in ~3s with no
      // chat content and no error banner. Surface an explicit failure
      // instead so the chat shows a clear reason. ACP sessions and plain
      // stdout streams are gated out via `trackingSubstantiveOutput`;
      // their success/failure determination lives elsewhere.
      if (
        code === 0 &&
        !run.cancelRequested &&
        trackingSubstantiveOutput &&
        !agentProducedOutput
      ) {
        send('error', createSseErrorPayload(
          'AGENT_EXECUTION_FAILED',
          'Agent completed without producing any output. The model or provider may have returned an empty response — check the agent logs for upstream errors.',
          { retryable: true },
        ));
        return design.runs.finish(run, 'failed', code, signal);
      }
      // ACP agents that don't shut down on stdin.end() (e.g. Devin for
      // Terminal) are forced to exit via SIGTERM from attachAcpSession after
      // a clean prompt completion. Without an override, the chat run would
      // be marked `failed` because `code === 0` fails (code is null on a
      // signal exit). `completedSuccessfully()` reports whether the ACP
      // session resolved without a fatal error or abort.
      //
      // Scope the override narrowly to the exact forced-shutdown shape this
      // PR introduces: code is null AND signal is SIGTERM AND the ACP
      // session reported clean completion. Any other post-response failure
      // (non-zero exit code, SIGKILL, SIGSEGV, etc.) still propagates as
      // `failed`, preserving the existing close-status behavior for genuine
      // post-response process problems.
      const acpCleanCompletion =
        typeof acpSession?.completedSuccessfully === 'function' &&
        acpSession.completedSuccessfully();
      const status = classifyChatRunCloseStatus({
        cancelRequested: !!run.cancelRequested,
        code,
        signal,
        acpCleanCompletion,
        artifactQuietShutdownRequested,
      });
      if (status === 'failed') {
        // Keep the tails on the run object: the pipeline completion block
        // (error report to the developers) reads them after the run ends.
        run.stderrTail = agentStderrTail;
        run.stdoutTail = agentStdoutTail;
        const diagnostic = diagnoseClaudeCliFailure({
          agentId: def.id,
          exitCode: code,
          signal,
          stderrTail: agentStderrTail,
          stdoutTail: agentStdoutTail,
          env: spawnedAgentEnv,
        });
        if (diagnostic) {
          send('error', createSseErrorPayload(
            'AGENT_EXECUTION_FAILED',
            diagnostic.message,
            { retryable: diagnostic.retryable, details: { detail: diagnostic.detail } },
          ));
        }
      }
      // Reconcile any HTML artifacts that were written during this run
      // without a manifest sidecar (e.g. agent used write_file instead of
      // create_artifact, or the run terminated between HTML write and
      // sidecar write). Only files modified after the run started are
      // touched — pre-existing HTML in imported-folder projects must not
      // receive spurious manifests. Best-effort; must not block finalisation.
      // See issue #2893.
      if (run.projectId) {
        (async () => {
          try {
            const project = getProject(db, run.projectId);
            const files = await listFiles(PROJECTS_DIR, run.projectId, {
              metadata: project?.metadata,
            });
            const dir = resolveProjectDir(PROJECTS_DIR, run.projectId, project?.metadata);
            for (const f of files) {
              const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
              if (ext !== '.html' && ext !== '.htm') continue;
              try {
                const filePath = path.join(dir, f.name);
                const st = await fs.promises.stat(filePath);
                if (st.mtimeMs < runStartTimeMs) continue;
                await reconcileHtmlArtifactManifest(
                  PROJECTS_DIR,
                  run.projectId,
                  f.name,
                  project?.metadata,
                );
              } catch { /* per-file best-effort */ }
            }
          } catch { /* project-level best-effort */ }
        })();
      }
      design.runs.finish(run, status, code, signal);
    });
    if (writePromptToChildStdin && child.stdin) {
      const promptInputFormat = def.promptInputFormat ?? 'text';
      if (promptInputFormat === 'stream-json') {
        // Wrap the prompt as an Anthropic user message and write it as one
        // JSONL line. Do NOT close stdin: claude-code keeps reading further
        // messages until EOF, which is what lets us inject a `tool_result`
        // block later when the user answers an `AskUserQuestion` card. The
        // stdin is closed implicitly when the child exits (run terminates,
        // user cancels, or the model finishes without an outstanding tool
        // call).
        const userMessage = JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: composed }],
          },
        });
        try {
          child.stdin.write(`${userMessage}\n`, 'utf8');
        } catch (err) {
          // Swallow EPIPE here for the same reason as the listener above —
          // a fast-exiting child has already routed its failure through
          // stderr / exit handlers.
          if (err && err.code !== 'EPIPE') throw err;
        }
        run.stdinOpen = true;
      } else {
        child.stdin.end(composed, 'utf8');
      }
    }
  };

  // Send a `tool_result` content block into a still-running stream-json
  // child. Used for interactive tools that the host answers (currently:
  // Claude's `AskUserQuestion`). The run must still be active and its
  // stdin must still be open — we never re-spawn a closed child.
  const submitToolResultToRun = (runId, toolUseId, content, isError = false) => {
    const run = design.runs.get(runId);
    if (!run) return { ok: false, reason: 'not_found' };
    if (design.runs.isTerminal(run.status)) {
      return { ok: false, reason: 'run_terminal' };
    }
    if (!run.child || !run.child.stdin || run.child.stdin.destroyed) {
      return { ok: false, reason: 'stdin_closed' };
    }
    if (!run.stdinOpen) {
      return { ok: false, reason: 'stdin_text_mode' };
    }
    if (typeof toolUseId !== 'string' || !toolUseId) {
      return { ok: false, reason: 'bad_tool_use_id' };
    }
    const safeContent = typeof content === 'string' ? content : String(content ?? '');
    const userMessage = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: safeContent,
            is_error: !!isError,
          },
        ],
      },
    });
    try {
      run.child.stdin.write(`${userMessage}\n`, 'utf8');
    } catch (err) {
      return { ok: false, reason: 'write_failed', error: err && err.message };
    }
    if (run.pendingHostAnswers) {
      run.pendingHostAnswers.delete(toolUseId);
      if (run.pendingHostAnswers.size === 0 && run.stdinOpen) {
        if (run.child && run.child.stdin && !run.child.stdin.destroyed) {
          try { run.child.stdin.end(); } catch {}
        }
        run.stdinOpen = false;
      }
    }
    return { ok: true };
  };

  orbitService.setRunHandler(async ({
    trigger,
    startedAt,
    prompt,
    systemPrompt,
    template,
  }) => {
    // Each Orbit run gets its own project so the conversation, messages, and
    // live artifact are isolated. The handler does the synchronous prep here
    // (insert project/conversation/run rows, kick off the chat run) and
    // returns immediately with the new project id; the daemon endpoint
    // resolves the HTTP request with that id so the client can navigate to
    // the new project before the agent has finished. Anything that depends
    // on the agent's final status (live artifact discovery, lastRun summary
    // metadata) lives inside the `completion` promise.
    const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
    let agentId = typeof appConfig.agentId === 'string' && appConfig.agentId
      ? appConfig.agentId
      : null;
    if (!agentId) {
      const agents = await detectAgents(appConfig.agentCliEnv ?? {}, sandboxSkipProbe(appConfig)).catch(() => []);
      agentId = agents.find((agent) => agent.available)?.id ?? null;
    }
    // Host detection found nothing, but the sandbox may still provide claude
    // (volume-only machines have no host install at all).
    if (!agentId) {
      const sandboxAgentId = await sandboxFallbackRuntimeId();
      if (sandboxAgentId) agentId = sandboxAgentId;
    }
    if (!agentId) throw new Error('No available agent is configured for Orbit. Choose an agent in Settings first.');

    const now = Date.now();
    const projectId = `orbit-${randomUUID()}`;
    const conversationId = `orbit-conv-${randomUUID()}`;
    const assistantMessageId = `orbit-assistant-${randomUUID()}`;
    const projectName = `Orbit · ${formatLocalProjectTimestamp(startedAt)}`;

    const orbitDesignSystemId = template?.designSystemRequired === false
      ? null
      : appConfig.designSystemId ?? null;

    insertProject(db, {
      id: projectId,
      name: projectName,
      skillId: 'live-artifact',
      designSystemId: orbitDesignSystemId,
      pendingPrompt: null,
      metadata: { kind: 'orbit', trigger },
      createdAt: now,
      updatedAt: now,
    });
    insertConversation(db, {
      id: conversationId,
      projectId,
      title: projectName,
      createdAt: now,
      updatedAt: now,
    });

    const run = design.runs.create({
      projectId,
      conversationId,
      assistantMessageId,
      clientRequestId: `orbit-${trigger}-${randomUUID()}`,
      agentId,
    });
    upsertMessage(db, conversationId, {
      id: `orbit-user-${run.id}`,
      role: 'user',
      content: prompt,
    });
    upsertMessage(db, conversationId, {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      agentId,
      agentName: getAgentDef(agentId)?.name ?? agentId,
      runId: run.id,
      runStatus: 'queued',
      startedAt: now,
    });

    if (template?.dir) {
      const cwd = await ensureProject(PROJECTS_DIR, projectId);
      const result = await stageActiveSkill(
        cwd,
        skillCwdAliasSegment(template.dir),
        template.dir,
        (msg) => console.warn(msg),
      );
      if (!result.staged) {
        console.warn(
          `[od] orbit template skill-stage skipped: ${result.reason ?? 'unknown reason'}; falling back to prompt-embedded instructions`,
        );
      }
    }

    const modelPrefs = appConfig.agentModels?.[agentId] ?? {};
    design.runs.start(run, () => startChatRun({
      agentId,
      projectId,
      conversationId: run.conversationId,
      assistantMessageId: run.assistantMessageId,
      clientRequestId: run.clientRequestId,
      skillId: 'live-artifact',
      designSystemId: orbitDesignSystemId,
      model: modelPrefs.model ?? null,
      reasoning: modelPrefs.reasoning ?? null,
      message: prompt,
      systemPrompt: [
        renderOrbitTemplateSystemPrompt(template),
        systemPrompt,
        'You are Orbit, an autonomous activity-summary agent inside Open Design.',
        'You must discover connectors and connector tools yourself through the OD CLI; the daemon has not chosen tools for you.',
        'You must create and register a Live Artifact as the final deliverable. Do not merely describe what you would do.',
        'Do not ask follow-up questions, do not emit <question-form>, and do not wait for user input. This run is unattended; pick reasonable defaults and complete the artifact.',
        'Keep connector credentials and OD_TOOL_TOKEN private; never print or persist secrets.',
      ].join('\n'),
    }, run));

    const completion = (async () => {
      const finalStatus = await design.runs.wait(run);
      db.prepare(
        `UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`,
      ).run(finalStatus.status, Date.now(), assistantMessageId);
      const artifacts = await listLiveArtifacts({ projectsRoot: PROJECTS_DIR, projectId });
      const artifact = artifacts.find((candidate) => candidate.createdByRunId === run.id);
      const status = finalStatus.status === 'succeeded' && !artifact ? 'failed' : finalStatus.status;
      return {
        agentRunId: run.id,
        status,
        ...(artifact?.id ? { artifactId: artifact.id, artifactProjectId: projectId } : {}),
        summary: artifact?.id
          ? `Agent ${finalStatus.status} and registered live artifact ${artifact.title}.`
          : finalStatus.status === 'succeeded'
            ? buildOrbitNoLiveArtifactSummary(run.events)
            : `Agent ${finalStatus.status} but did not register a live artifact for this Orbit run.`,
      };
    })();

    return { projectId, agentRunId: run.id, completion };
  });

  orbitService.setTemplateResolver(async (skillId) => {
    // Orbit templates (live-artifact, etc.) live under design-templates after
    // the split, but earlier projects may still point at functional-skill
    // ids for the same purpose — search both roots so a stored project id
    // keeps resolving through one or the other.
    const skills = await listAllSkillLikeEntries();
    const skill = findSkillById(skills, skillId);
    if (!skill || skill.scenario !== 'orbit') return null;
    return {
      id: skill.id,
      name: skill.name,
      examplePrompt: skill.examplePrompt,
      dir: skill.dir,
      body: skill.body,
      designSystemRequired: skill.designSystemRequired !== false,
    };
  });

  app.post('/api/runs', async (req, res) => {
    if (daemonShuttingDown) {
      return sendApiError(res, 503, 'UPSTREAM_UNAVAILABLE', 'daemon is shutting down');
    }
    // Plan §3.A1 / spec §11.5: resolve any pluginId / appliedPluginSnapshotId
    // before the run is created. The resolver returns null when the body
    // does not mention a plugin (legacy runs unchanged), an error envelope
    // for missing-input / capability / not-found / stale, or an ok result
    // whose `snapshotId` is pinned onto the run object so downstream
    // code (system prompt block, tool tokens, replay) can reach it.
    //
    // Stage A of plugin-driven-flow-plan: when neither the body nor the
    // project carries plugin info we fall back to the bundled scenario
    // plugin for the project's metadata kind/intent so direct callers
    // (CLI / SDK / agent-headless runs) get the same auto-binding the
    // web create flow already produces. The fallback is silent — a
    // bundled scenario that is not installed leaves the run plugin-less,
    // which matches the legacy path.
    let resolvedSnapshot = null;
    if (typeof req.body?.projectId === 'string' && req.body.projectId) {
      let registryView;
      try {
        registryView = await loadPluginRegistryView();
      } catch (err) {
        return res.status(500).json({ error: String(err) });
      }
      const explicitPlugin =
        req.body && (req.body.pluginId || req.body.appliedPluginSnapshotId);
      let runResolveBody = req.body;
      if (!explicitPlugin) {
        const projectRow = getProject(db, req.body.projectId);
        const hasPin =
          typeof projectRow?.appliedPluginSnapshotId === 'string'
          && projectRow.appliedPluginSnapshotId.length > 0;
        if (!hasPin) {
          const fallbackPluginId = defaultScenarioPluginIdForProjectMetadata(projectRow?.metadata);
          if (fallbackPluginId && getInstalledPlugin(db, fallbackPluginId)) {
            runResolveBody = { ...req.body, pluginId: fallbackPluginId };
          }
        }
      }
      const resolved = resolvePluginSnapshot({
        db,
        body: runResolveBody,
        projectId: req.body.projectId,
        conversationId: typeof req.body.conversationId === 'string'
          ? req.body.conversationId
          : null,
        registry: registryView,
        connectorProbe: buildConnectorProbe(connectorService),
      });
      if (resolved && !resolved.ok) {
        if (!explicitPlugin) {
          console.warn(
            `[plugins] default-scenario fallback skipped for run on project ${req.body.projectId}: ${resolved.body?.error?.code ?? 'unknown'}`,
          );
        } else {
          return res.status(resolved.status).json(resolved.body);
        }
      } else {
        resolvedSnapshot = resolved;
      }
    }
    const meta = { ...(req.body || {}) };
    if (resolvedSnapshot?.ok) {
      meta.appliedPluginSnapshotId = resolvedSnapshot.snapshotId;
      if (!meta.pluginId) meta.pluginId = resolvedSnapshot.snapshot.pluginId;
      if (typeof meta.message !== 'string' || meta.message.trim().length === 0) {
        const renderedQuery = renderPluginBriefTemplate(
          resolvedSnapshot.snapshot.query,
          resolvedSnapshot.snapshot.inputs,
        ).trim();
        if (renderedQuery.length > 0) meta.message = renderedQuery;
      }
    }
    const run = design.runs.create(meta);
    try {
      pinAssistantMessageOnRunCreate(db, run);
    } catch (err) {
      console.warn('[runs] message create pin failed', err);
    }
    // Capture clientType for downstream telemetry (Langfuse uses it on
    // run-completed metadata; PostHog gets it via the request header
    // bridge). Prefer the explicit `x-od-client` header from desktop /
    // web sidecars, fall back to user-agent detection. Without this the
    // run object's `clientType` stays undefined and Langfuse traces lose
    // the surface dimension.
    const declaredClient = String(req.get('x-od-client') ?? '').toLowerCase();
    if (declaredClient === 'desktop' || declaredClient === 'web') {
      run.clientType = declaredClient;
    } else {
      const ua = String(req.get('user-agent') ?? '');
      run.clientType = ua.includes('Electron/') ? 'desktop' : 'web';
    }
    if (resolvedSnapshot?.ok) {
      try {
        const { linkSnapshotToRun } = await import('./plugins/snapshots.js');
        linkSnapshotToRun(db, resolvedSnapshot.snapshotId, run.id);
      } catch {
        // Linking is best-effort here; in-memory run still carries the id.
      }
    }
    /** @type {import('@open-design/contracts').ChatRunCreateResponse} */
    const body = {
      runId: run.id,
      ...(resolvedSnapshot?.ok
        ? {
            appliedPluginSnapshotId: resolvedSnapshot.snapshotId,
            pluginId: resolvedSnapshot.snapshot.pluginId,
          }
        : {}),
    };
    res.status(202).json(body);
    // Plan §3.I1 / spec §10.1 — fire the pipeline schedule on the run's
    // SSE stream BEFORE the agent process is started. The first
    // pipeline_stage_started event is emitted synchronously (before
    // the first await inside runPipelineForRun), so any SSE consumer
    // that subscribes between create() and start() sees a stage event
    // ahead of the agent's message_chunk stream — exactly what §8 e2e-3
    // expects. The stub stage runner returns immediately so a
    // non-loop pipeline walks through every stage in O(stages) time;
    // the audit row in `run_devloop_iterations` records the timeline.
    if (resolvedSnapshot?.ok && resolvedSnapshot.snapshot.pipeline) {
      firePipelineForRun({
        run,
        snapshot: resolvedSnapshot.snapshot,
        runs: design.runs,
        db,
      });
    }
    reconcileAssistantMessageOnRunEnd(db, design.runs, run);
    if (run.projectId && run.conversationId) {
      try {
        const project = getProject(db, run.projectId);
        const projectRoot = resolveProjectDir(PROJECTS_DIR, run.projectId, project?.metadata);
        detectSkillPluginCandidateOnRunSuccess(db, design.runs, run, req.body || {}, projectRoot);
      } catch (err) {
        console.warn('[plugins] skill candidate hook setup failed', err);
      }
    }
    design.runs.start(run, () => startChatRun(meta, run));

    // Analytics v2: emit run_created (daemon-side authoritative) and
    // schedule run_finished on terminal state. The matching `chat-routes.ts`
    // handler is shadowed by this earlier registration in Express; emit
    // here so PostHog actually receives the event. Both fire under the
    // same insert_id prefix so any web-side mirror dedupes by $insert_id.
    const analyticsContext = readAnalyticsContext(req);
    if (analyticsContext) {
      const reqBody = (req.body || {}) as Record<string, unknown>;
      const runInsertId = newInsertId();
      const runStartedAt = Date.now();
      // Configure-state triplet — v2 schema requires every event to carry
      // these so PostHog dashboards can split run lifecycle by execution
      // setup. Web-side captures inherit them from a PostHog global
      // register, but daemon-side captures (run_created/run_finished) need
      // to populate them at capture time. Best-effort derivation from
      // `detectAgents()` + the request's `agentId`:
      //   - has_available_configure_cli: any CLI on PATH appears installed
      //   - configure_type: 'local_cli' when the run targets an installed
      //     CLI, otherwise 'unknown' (BYOK keys live in the web client
      //     storage and are not visible to the daemon at this layer)
      //   - configure_availability: 'available' when the requested CLI is
      //     installed; 'unavailable' when it's known but not installed;
      //     'unknown' otherwise
      const appCfgForAnalytics = await readAppConfig(RUNTIME_DATA_DIR).catch(
        () => ({} as Record<string, unknown>),
      );
      const detectedAgentsForAnalytics = await detectAgents(
        (appCfgForAnalytics as { agentCliEnv?: Record<string, unknown> }).agentCliEnv ?? {},
        sandboxSkipProbe(appCfgForAnalytics),
      ).catch(() => [] as Array<{ id: string; available: boolean }>);
      // BYOK credentials live in the web client (localStorage / store) and
      // are not visible to the daemon at this layer, so we pass
      // `byokConfigured: undefined` and let the helper fall back to the
      // installed-CLI signal. Web-side captures use the same helper with
      // the full credential view to keep dashboards aligned.
      //
      // `mode: 'daemon'` pins the call into the helper's daemon branch so
      // `configure_availability` is judged from the requested agent's
      // install status (not the cohort-wide "any CLI installed?" fallback).
      // Without it, a run for an uninstalled agent would still report
      // `available` whenever any unrelated CLI was on PATH — see PR #2285
      // review.
      const configureGlobals = deriveConfigureGlobals({
        mode: 'daemon',
        agentId: typeof reqBody.agentId === 'string' ? reqBody.agentId : null,
        agents: detectedAgentsForAnalytics,
      });
      const promptText =
        typeof reqBody.currentPrompt === 'string'
          ? reqBody.currentPrompt
          : typeof reqBody.message === 'string'
            ? reqBody.message
            : '';
      const userQueryTokens = promptText.length > 0
        ? Math.ceil(promptText.length / 4)
        : 0;
      // Optional analytics context the client may attach to a run.
      // Used to thread the DS run variant (`design_system_project` /
      // `design_system_generation` page+area, `project_kind=design_system`,
      // entry_from values like `design_system_create`) plus per-source
      // counts onto run_created / run_finished. Behavior never depends on
      // these; only PostHog props do.
      const analyticsHints =
        (reqBody as { analyticsHints?: Record<string, unknown> | null }).analyticsHints
          && typeof (reqBody as { analyticsHints?: unknown }).analyticsHints === 'object'
          ? ((reqBody as { analyticsHints?: Record<string, unknown> }).analyticsHints ?? {})
          : {};
      const hintEntryFrom = typeof analyticsHints.entryFrom === 'string'
        ? analyticsHints.entryFrom
        : undefined;
      const hintProjectKind = typeof analyticsHints.projectKind === 'string'
        ? analyticsHints.projectKind
        : null;
      const dsRunContext =
        analyticsHints.designSystemRunContext
          && typeof analyticsHints.designSystemRunContext === 'object'
          ? (analyticsHints.designSystemRunContext as Record<string, unknown>)
          : {};
      const isDesignSystemRun =
        hintProjectKind === 'design_system'
        || hintEntryFrom === 'design_system_create'
        || hintEntryFrom === 'onboarding_design_system'
        || hintEntryFrom === 'regenerate_from_review';
      // Only fields the current `/api/runs` create payload actually
      // sends. The v2 schema documents extended context props
      // (entry_from / project_kind / target_platforms / fidelity /
      // companion_surfaces / connectors / use_speaker_notes /
      // include_animations / reference_template / aspect /
      // project_source) — most aren't on the wire yet, but
      // entry_from / projectKind / DS run context land here when the
      // client populates `analyticsHints`. Other dimensions stay
      // omitted until follow-up PRs thread them through.
      const baseProps: Record<string, unknown> = {
        page_name: isDesignSystemRun ? 'design_system_project' : 'chat_panel',
        area: isDesignSystemRun ? 'design_system_generation' : 'chat_composer',
        ...configureGlobals,
        project_id: typeof reqBody.projectId === 'string' ? reqBody.projectId : null,
        conversation_id:
          typeof reqBody.conversationId === 'string' ? reqBody.conversationId : null,
        run_id: run.id,
        project_kind: hintProjectKind,
        ...(hintEntryFrom ? { entry_from: hintEntryFrom } : {}),
        design_system_id:
          typeof reqBody.designSystemId === 'string'
            ? reqBody.designSystemId
            : undefined,
        // `design_system_source` is required in the v2 contract
        // (RunCreatedProps / RunFinishedProps). The daemon doesn't see
        // whether the chosen design system was the workspace default,
        // a user pick, or template-inherited — that signal lives only
        // in the web client. Derive what we honestly know from the
        // wire payload: 'not_applicable' when no design system was
        // selected, 'unknown' otherwise. A follow-up that threads
        // `designSystemSource` through `CreateRunRequest` can replace
        // this with the precise value. See PR #2285 review 2026-05-20
        // 04:35 for the rationale.
        design_system_source:
          typeof reqBody.designSystemId === 'string' && reqBody.designSystemId
            ? 'unknown'
            : 'not_applicable',
        ...(isDesignSystemRun ? {
          ds_source_origin: typeof dsRunContext.origin === 'string'
            ? dsRunContext.origin
            : undefined,
          source_count: typeof dsRunContext.sourceCount === 'number'
            ? dsRunContext.sourceCount
            : undefined,
          has_brand_description: typeof dsRunContext.hasBrandDescription === 'boolean'
            ? dsRunContext.hasBrandDescription
            : undefined,
          brand_description_length_bucket:
            typeof dsRunContext.brandDescriptionLengthBucket === 'string'
              ? dsRunContext.brandDescriptionLengthBucket
              : undefined,
          github_repo_count: typeof dsRunContext.githubRepoCount === 'number'
            ? dsRunContext.githubRepoCount
            : undefined,
          local_folder_count: typeof dsRunContext.localFolderCount === 'number'
            ? dsRunContext.localFolderCount
            : undefined,
          fig_file_count: typeof dsRunContext.figFileCount === 'number'
            ? dsRunContext.figFileCount
            : undefined,
          asset_file_count: typeof dsRunContext.assetFileCount === 'number'
            ? dsRunContext.assetFileCount
            : undefined,
        } : {}),
        has_attachment: Array.isArray(reqBody.attachments)
          ? (reqBody.attachments as unknown[]).length > 0
          : false,
        user_query_tokens: userQueryTokens,
        model_id: typeof reqBody.model === 'string' ? reqBody.model : null,
        agent_provider_id:
          typeof reqBody.agentId === 'string'
            ? agentIdToTracking(reqBody.agentId)
            : null,
        skill_id: typeof reqBody.skillId === 'string' ? reqBody.skillId : null,
        mcp_id: null,
        token_count_source: userQueryTokens > 0 ? 'estimated' : 'unknown',
      };
      design.analytics.capture({
        eventName: 'run_created',
        context: analyticsContext,
        appVersion: design.getAppVersion(),
        properties: baseProps,
        insertId: runInsertId,
      });
      design.runs.wait(run).then((status: {
        status: string;
        error?: string | null;
        errorCode?: string | null;
        exitCode?: number | null;
        signal?: string | null;
      }) => {
        // `deriveRunErrorCode` is the invariant: when `result === 'failed'`
        // it always returns a non-empty string so dashboards keyed on
        // `error_code` never see a blank cell. Live in `run-result.ts`
        // with unit coverage for the fall-through cases (ACP fatal,
        // child close without error event, etc.).
        const result = runResultFromStatus(status.status);
        const errorCode = deriveRunErrorCode(status);
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        for (let i = run.events.length - 1; i >= 0; i -= 1) {
          const ev = run.events[i];
          const data = ev?.data as
            | { type?: string; usage?: Record<string, unknown> | null }
            | null
            | undefined;
          if (ev?.event === 'agent' && data?.type === 'usage' && data.usage) {
            const u = data.usage;
            if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
            if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
            if (inputTokens !== undefined || outputTokens !== undefined) break;
          }
        }
        const haveUsage = inputTokens !== undefined || outputTokens !== undefined;
        const totalTokens =
          inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined;
        design.analytics.capture({
          eventName: 'run_finished',
          context: analyticsContext,
          appVersion: design.getAppVersion(),
          properties: {
            ...baseProps,
            // `area` flips on run_finished: chat_panel runs publish
            // under `chat_panel`, DS runs stay on
            // `design_system_generation` to match the run_created shape.
            area: isDesignSystemRun ? 'design_system_generation' : 'chat_panel',
            result,
            // Incremental count of `.html` paths the run produced or
            // modified, deduped per file. Replaces the hard-coded `0`
            // that masked the "did this run actually generate an
            // artifact?" funnel on PostHog. See `run-artifacts.ts`
            // for the dedup semantics; tested in
            // `tests/run-artifacts.test.ts`.
            artifact_count: countNewHtmlArtifacts(run.events),
            ...(isDesignSystemRun ? {
              // DS runs land a `DESIGN.md` write when generation
              // succeeded; the run-artifacts inspector reuses the
              // same Write/Edit pairing it already does for HTML
              // artifact counts, just keyed on `DESIGN.md`.
              design_system_created: didRunCreateDesignSystemFile(run.events),
              preview_module_count: countDesignSystemPreviewModules(run.events),
              // `missing_font_count` defaults to 0 — the agent flow
              // doesn't emit a structured "missing fonts" signal yet.
              // Kept on the wire so the dashboard has the column from
              // day one; can be sourced later from a font-audit hook.
              missing_font_count: 0,
            } : {}),
            total_duration_ms: Date.now() - runStartedAt,
            ...(errorCode ? { error_code: errorCode } : {}),
            ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
            ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
            ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
            ...(haveUsage ? { token_count_source: 'provider_usage' } : {}),
          },
          insertId: `${runInsertId}-finish`,
        });
      }).catch(() => {
        // wait() can't reject in current runs.ts impl, but guard anyway.
      });
    }
  });

  app.get('/api/runs', (req, res) => {
    const { projectId, conversationId, status } = req.query;
    const runs = design.runs.list({ projectId, conversationId, status });
    /** @type {import('@open-design/contracts').ChatRunListResponse} */
    const body = { runs: runs.map(design.runs.statusBody) };
    res.json(body);
  });

  // Render a self-contained HTML document (inline CSS + data-URI images) to a
  // PDF via headless Chromium. Runtime-agnostic (spawns its own chromium), so
  // the review exporter gets a real downloadable .pdf.
  // WP5 (web-first migration): this used to try Electron's own
  // `webContents.printToPDF` via the sidecar bridge first (no npm, no
  // ~150MB Chromium download, works offline) and only fell back to headless
  // Chromium when there was no desktop runtime. That bridge — and
  // `apps/desktop` itself — is gone, so headless Chromium (provisioned on
  // first use) is now the only backend.
  app.post('/api/render/pdf', async (req, res) => {
    const html = typeof req.body?.html === 'string' ? req.body.html : '';
    const filename =
      typeof req.body?.filename === 'string' && req.body.filename ? req.body.filename : 'document.pdf';
    if (!html.trim()) return sendApiError(res, 400, 'BAD_REQUEST', 'html is required');

    try {
      const pdf = await renderHtmlToPdf(html, RUNTIME_DATA_DIR);
      const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || 'document.pdf';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(pdf);
    } catch (err) {
      // Log it: this path provisions npm + Chromium, so its failures are
      // environment-specific (missing npm, offline, blocked download) and the
      // 500 body is the only other place the reason appears.
      console.warn('[render/pdf] failed:', err);
      sendApiError(res, 500, 'RENDER_FAILED', err instanceof Error ? err.message : String(err));
    }
  });

  // Always-visible Usage meter feed: Claude account quota % (rolling 5-hour
  // and 7-day subscription limits), the same data Claude Code's `/usage` shows.
  app.get('/api/usage/claude', async (_req, res) => {
    try {
      // When the sandbox OWNS Claude runs (Docker-only), the meter must reflect
      // the DOCKER account, not the host — read the token ONLY from the
      // od-claude-auth volume. Not logged into Docker → unavailable (meter
      // hidden), instead of leaking the host account's quota. When the sandbox
      // does NOT own Claude (host mode), read the host token first and fall back
      // to the volume.
      const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
      const sandboxCfg = resolveSandboxConfig(appConfig.sandbox, process.env);
      const sandboxOwnsClaude =
        sandboxCfg.enabled &&
        sandboxCfg.skills.includes('*') &&
        (sandboxCfg.runtimes.includes('*') || sandboxCfg.runtimes.includes('claude'));
      const body = await fetchClaudeUsage({
        sandboxOnly: sandboxOwnsClaude,
        sandboxCreds: async () => {
          try {
            const image = sandboxImageTag(path.join(SKILLS_DIR, 'ui-react', 'builder'));
            return await readSandboxClaudeCredentials(image);
          } catch {
            return null;
          }
        },
      });
      // One line in the daemon log per unavailable read — that log is what a
      // prod machine can actually hand back to us.
      if (!body.available) console.warn(`[usage/claude] unavailable: ${body.reason ?? '(no reason)'}`);
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[usage/claude] failed: ${message}`);
      res.json({
        available: false,
        fiveHour: { utilization: null, resetsAt: null },
        sevenDay: { utilization: null, resetsAt: null },
        subscriptionType: null,
        reason: `Daemon không đọc được mức dùng Claude: ${message}`,
      } satisfies import('@open-design/contracts').ClaudeUsageResponse);
    }
  });

  // Read once when the Local CLI menu is opened. This uses Codex's own
  // app-server protocol (`initialize` → `account/rateLimits/read`); no
  // credential is sent to the browser and no background polling is
  // performed. Host mode (WP4 default, no Docker) reads the HOST Codex CLI's
  // own `~/.codex/auth.json` directly; only when that is unreachable AND the
  // Docker sandbox is enabled does this fall back to the sandboxed volume —
  // mirrors `/api/usage/claude` just above.
  app.get('/api/usage/codex', async (_req, res) => {
    const emptyUsage = (reason: string): import('@open-design/contracts').CodexUsageResponse => ({
      available: false,
      primary: { utilization: null, resetsAt: null, durationMinutes: null },
      secondary: null,
      planType: null,
      hasCredits: null,
      reason,
    });
    const describe = (err: unknown): string => {
      const message = err instanceof Error ? err.message : String(err);
      const head = message.split('\n').slice(0, 2).join(' ').trim();
      // Our own Vietnamese diagnostics (CLI not found, timeout…) are already
      // user-facing — pass them through untouched.
      if (/^(Không|Codex usage check timed out|Codex CLI chưa|Codex app-server)/.test(head)) return head;
      // A dead app-server usually means "not logged in" — codex prints its
      // login hint on stderr and exits; keep that text, it is the actual cause.
      if (/not logged in|codex login|unauthorized|401|refresh token|auth\.json/i.test(message)) {
        return `Codex CLI chưa đăng nhập trên máy này — chạy \`codex login\`. (${head})`;
      }
      return head || 'lỗi không rõ';
    };
    let hostReason = '';
    try {
      const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
      try {
        res.json(await readHostCodexUsage(agentCliEnvForAgent(appConfig.agentCliEnv, 'codex')));
        return;
      } catch (err) {
        // Host Codex CLI not installed / not logged in / unreachable — fall
        // through to the Docker sandbox below when it is enabled.
        hostReason = describe(err);
        console.warn(`[usage/codex] host read failed: ${hostReason}`);
      }
      if (!resolveSandboxConfig(appConfig.sandbox, process.env).enabled) {
        res.json(emptyUsage(hostReason));
        return;
      }
      const image = sandboxImageTag(path.join(SKILLS_DIR, 'ui-react', 'builder'));
      res.json(await readSandboxCodexUsage(image));
    } catch (err) {
      const sandboxReason = `Docker sandbox không đọc được mức dùng Codex: ${describe(err)}`;
      console.warn(`[usage/codex] ${sandboxReason}`);
      res.json(emptyUsage(hostReason ? `${hostReason} · ${sandboxReason}` : sandboxReason));
    }
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    res.json(design.runs.statusBody(run));
  });

  app.get('/api/runs/:id/events', (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    design.runs.stream(run, req, res);
  });

  // Phase 4 / spec §10.3.5 — AG-UI canonical stream.
  //
  // Same data plane as /api/runs/:id/events but every record passes
  // through `encodeOdEventForAgui` first so an external CopilotKit /
  // AG-UI client can consume the run unmodified. Events the encoder
  // can't map are dropped; the SSE stream stays canonical even when
  // OD adds internal-only events later.
  app.get('/api/runs/:id/agui', async (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    const { encodeOdEventForAgui } = await import('@open-design/agui-adapter');
    const sse = createSseResponse(res);
    const lastEventId = Number(req.get('Last-Event-ID') || req.query.after || 0);
    const emitMapped = (record) => {
      const mapped = encodeOdEventForAgui(
        { kind: record.event, ...(record.data ?? {}) },
        { runId: run.id, seq: record.id, now: Date.now() },
      );
      if (mapped) sse.send(mapped.kind, mapped, record.id);
    };
    for (const record of run.events) {
      if (!Number.isFinite(lastEventId) || record.id > lastEventId) emitMapped(record);
    }
    if (design.runs.isTerminal(run.status)) {
      sse.end();
      return;
    }
    // Mirror runs.stream's subscriber pattern but route through the
    // adapter. We attach a thin wrapper to run.clients so the existing
    // emit() loop reaches us; the wrapper only implements the
    // {send,end,cleanup} surface the runs service uses.
    const adapterClient = {
      send: (event, data, id) => {
        const mapped = encodeOdEventForAgui(
          { kind: event, ...(data ?? {}) },
          { runId: run.id, seq: id, now: Date.now() },
        );
        if (mapped) sse.send(mapped.kind, mapped, id);
      },
      end:     () => sse.end(),
      cleanup: () => sse.cleanup?.(),
    };
    run.clients.add(adapterClient);
    res.on('close', () => {
      run.clients.delete(adapterClient);
      sse.cleanup?.();
    });
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    design.runs.cancel(run);
    /** @type {import('@open-design/contracts').ChatRunCancelResponse} */
    const body = { ok: true };
    res.json(body);
  });

  app.post('/api/chat', (req, res) => {
    if (daemonShuttingDown) {
      return sendApiError(res, 503, 'UPSTREAM_UNAVAILABLE', 'daemon is shutting down');
    }
    const run = design.runs.create();
    design.runs.stream(run, req, res);
    design.runs.start(run, () => startChatRun(req.body || {}, run));
  });

  // Each routine fire resolves an agent, prepares project/conversation state,
  // and dispatches into the same chat runner used by manual runs.
  routineService.setRunHandler(async ({ routine, trigger, startedAt, runId }) => {
    const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
    let agentId = routine.agentId
      || (typeof appConfig.agentId === 'string' && appConfig.agentId ? appConfig.agentId : null);
    if (!agentId) {
      const agents = await detectAgents(appConfig.agentCliEnv ?? {}, sandboxSkipProbe(appConfig)).catch(() => []);
      agentId = agents.find((agent) => agent.available)?.id ?? null;
    }
    // Volume-only machines: no host install, but the sandbox provides claude.
    if (!agentId) {
      const sandboxAgentId = await sandboxFallbackRuntimeId();
      if (sandboxAgentId) agentId = sandboxAgentId;
    }
    if (!agentId) {
      throw new Error('No available agent is configured. Choose an agent in Settings first.');
    }

    const now = startedAt;
    const routineContext = normalizeRunContextSelection(routine.context);
    const routineSkillId = routine.skillId ?? routineContext.skillIds?.[0] ?? null;
    const contextMetadata = {
      ...(routineContext.pluginIds?.length
        ? {
            contextPlugins: routineContext.pluginIds.map((id) => {
              const plugin = getInstalledPlugin(db, id);
              return {
                id,
                title: plugin?.title ?? id,
                ...(plugin?.manifest?.description ? { description: plugin.manifest.description } : {}),
              };
            }),
          }
        : {}),
      ...(routineContext.mcpServerIds?.length
        ? { contextMcpServers: routineContext.mcpServerIds.map((id) => ({ id })) }
        : {}),
      ...(routineContext.connectorIds?.length
        ? { contextConnectors: routineContext.connectorIds.map((id) => ({ id, name: id })) }
        : {}),
    };
    const stamp = formatLocalProjectTimestamp(new Date(now).toISOString());
    let projectId;
    let projectName;
    if (routine.target.mode === 'reuse') {
      const project = getProject(db, routine.target.projectId);
      if (!project) throw new Error(`Routine target project ${routine.target.projectId} not found`);
      projectId = project.id;
      projectName = project.name;
    } else {
      projectId = `routine-${randomUUID()}`;
      projectName = `${routine.name} · ${stamp}`;
      insertProject(db, {
        id: projectId,
        name: projectName,
        skillId: routineSkillId,
        designSystemId: appConfig.designSystemId ?? null,
        pendingPrompt: null,
        metadata: {
          kind: 'other',
          intent: 'automation',
          automationId: routine.id,
          routineId: routine.id,
          trigger,
          ...contextMetadata,
        },
        createdAt: now,
        updatedAt: now,
      });
    }

    const conversationId = `routine-conv-${randomUUID()}`;
    const conversationTitle = routine.target.mode === 'reuse'
      ? `${routine.name} · ${stamp}`
      : projectName;
    insertConversation(db, {
      id: conversationId,
      projectId,
      title: conversationTitle,
      createdAt: now,
      updatedAt: now,
    });

    // Notify any open `ProjectView` watching this project so its
    // conversation list picks up the new routine conversation without
    // requiring the user to leave and re-enter the project (#1361).
    // For reuse-an-existing-project mode this is the only path the
    // open view has to learn the conversation exists; for new-project
    // mode this is harmless (no subscribers for a project that was
    // just created milliseconds ago). The payload shape is the shared
    // `ProjectConversationCreatedSsePayload` from `@open-design/contracts`
    // so the daemon producer and the web consumer cannot drift.
    /** @type {ProjectConversationCreatedSsePayload} */
    const conversationCreatedEvent = {
      type: 'conversation-created',
      projectId,
      conversationId,
      title: conversationTitle,
      createdAt: now,
    };
    emitProjectEvent(projectId, conversationCreatedEvent);

    const assistantMessageId = `routine-assistant-${randomUUID()}`;
    let resolvedRoutineSnapshot = null;
    const primaryPluginId = routineContext.pluginIds?.[0] ?? null;
    if (primaryPluginId) {
      const registry = await loadPluginRegistryView();
      const resolved = resolvePluginSnapshot({
        db,
        body: {
          pluginId: primaryPluginId,
          pluginInputs: { prompt: routine.prompt },
        },
        projectId,
        conversationId,
        registry,
        activeProjectDesignSystem:
          typeof appConfig.designSystemId === 'string' && appConfig.designSystemId.length > 0
            ? { id: appConfig.designSystemId }
            : undefined,
      });
      if (resolved && !resolved.ok) {
        throw new Error(`Automation plugin ${primaryPluginId} could not be applied: ${JSON.stringify(resolved.body)}`);
      }
      resolvedRoutineSnapshot = resolved;
    }

    const run = design.runs.create({
      projectId,
      conversationId,
      assistantMessageId,
      clientRequestId: `routine-${trigger}-${randomUUID()}`,
      agentId,
      ...(resolvedRoutineSnapshot?.ok
        ? {
            appliedPluginSnapshotId: resolvedRoutineSnapshot.snapshotId,
            pluginId: resolvedRoutineSnapshot.snapshot.pluginId,
          }
        : {}),
    });
    if (resolvedRoutineSnapshot?.ok) {
      try {
        const { linkSnapshotToRun } = await import('./plugins/snapshots.js');
        linkSnapshotToRun(db, resolvedRoutineSnapshot.snapshotId, run.id);
      } catch {
        // Snapshot linking is best-effort; the in-memory run still carries it.
      }
    }
    upsertMessage(db, conversationId, {
      id: `routine-user-${run.id}`,
      role: 'user',
      content: routine.prompt,
    });
    upsertMessage(db, conversationId, {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      agentId,
      agentName: getAgentDef(agentId)?.name ?? agentId,
      runId: run.id,
      runStatus: 'queued',
      startedAt: now,
    });

    const modelPrefs = appConfig.agentModels?.[agentId] ?? {};
    design.runs.start(run, () => startChatRun({
      agentId,
      projectId,
      conversationId: run.conversationId,
      assistantMessageId: run.assistantMessageId,
      clientRequestId: run.clientRequestId,
      skillId: routineSkillId,
      designSystemId: appConfig.designSystemId ?? null,
      context: routineContext,
      model: modelPrefs.model ?? null,
      reasoning: modelPrefs.reasoning ?? null,
      message: routine.prompt,
      systemPrompt: [
        `You are running an unattended scheduled routine named "${routine.name}".`,
        'Do not ask follow-up questions, do not emit <question-form>, and do not wait for user input. Pick reasonable defaults and finish the task.',
      ].join('\n'),
    }, run));

    const completion = (async () => {
      const finalStatus = await design.runs.wait(run);
      const failureError = finalStatus.status === 'failed'
        ? (typeof finalStatus.error === 'string' && finalStatus.error.trim() ? finalStatus.error.trim() : null)
        : null;
      const failureErrorCode = finalStatus.status === 'failed'
        ? (typeof finalStatus.errorCode === 'string' && finalStatus.errorCode.trim() ? finalStatus.errorCode.trim() : null)
        : null;
      if (failureError) {
        appendMessageStatusEvent(db, assistantMessageId, {
          label: 'error',
          detail: failureError,
        });
      }
      db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`)
        .run(finalStatus.status, Date.now(), assistantMessageId);
      let evolutionSummary = '';
      if (finalStatus.status === 'succeeded' && routineContext.connectorIds?.length) {
        try {
          const evolution = await ingestRoutineConnectorEvolution(RUNTIME_DATA_DIR, {
            routine,
            runId,
            trigger,
            status: finalStatus.status,
            projectId,
            conversationId,
            agentRunId: run.id,
            summary: `Routine "${routine.name}" ${finalStatus.status}.`,
            connectorIds: routineContext.connectorIds,
            messages: listMessages(db, conversationId),
          });
          if (evolution?.proposals?.length) {
            evolutionSummary = ` Created ${evolution.proposals.length} self-evolution proposal(s) from connector context.`;
          }
        } catch (error) {
          evolutionSummary = ` Connector self-evolution ingestion failed: ${error instanceof Error ? error.message : String(error)}.`;
        }
      }
      return {
        status: finalStatus.status,
        summary: failureError
          ? `Routine "${routine.name}" failed: ${failureError}`
          : `Routine "${routine.name}" ${finalStatus.status}.${evolutionSummary}`,
        error: failureError ?? undefined,
        errorCode: failureErrorCode ?? undefined,
      };
    })();

    return { projectId, conversationId, agentRunId: run.id, completion };
  });
  routineService.start();

  assertServerContextSatisfiesRoutes({
    db,
    design,
    http: httpDeps,
    paths: pathDeps,
    ids: idDeps,
    uploads: uploadDeps,
    node: nodeDeps,
    projectStore: projectStoreDeps,
    projectFiles: projectFileDeps,
    conversations: conversationDeps,
    templates: templateDeps,
    status: projectStatusDeps,
    events: projectEventDeps,
    imports: importDeps,
    exports: projectExportDeps,
    artifacts: artifactDeps,
    documents: { buildDocumentPreview },
    auth: authDeps,
    liveArtifacts: liveArtifactDeps,
    deploy: deployDeps,
    media: mediaDeps,
    appConfig: appConfigDeps,
    orbit: orbitDeps,
    nativeDialogs: nativeDialogDeps,
    research: researchDeps,
    mcp: { pendingAuth: mcpPendingAuth, daemonUrlRef },
    resources: {
      listAllSkills,
      listAllDesignTemplates,
      listAllSkillLikeEntries,
      listAllDesignSystems,
      mimeFor,
    },
    routines: { routineService },
    validation: validationDeps,
    finalize: finalizeDeps,
    handoff: handoffDeps,
    chat: { startChatRun, submitToolResultToRun },
    agents: agentDeps,
    critique: critiqueDeps,
    lifecycle: { isDaemonShuttingDown: () => daemonShuttingDown },
  });

  registerRoutineRoutes(app, {
    db,
    paths: { RUNTIME_DATA_DIR },
    routines: { routineService },
  });

  // Pipelines: per-project, dependency-gated skill runs (the docs→UI flow).
  // Each run seeds a fresh conversation in the EXISTING project with the
  // pipeline's skill active (interactive — the user watches/intervenes), then
  // reflects the run's terminal status back into the gate (metadata_json) so a
  // downstream pipeline only unlocks once its prerequisites have succeeded.
  // Mirrors the Orbit run handler but reuses the project and drives the prompt
  // through `skillId` (composeDaemonSystemPrompt injects the SKILL.md body).
  // B1 helpers: snapshot the project cwd before a pipeline run and upload the
  // files it produced/changed to the media file store afterwards (cross-device
  // handoff + tracking). Pure file-diff, so no per-stage output globs needed.
  const pipelineFileMime = (p: string): string => {
    if (p.endsWith('.md')) return 'text/markdown';
    if (p.endsWith('.json')) return 'application/json';
    if (p.endsWith('.txt')) return 'text/plain';
    if (p.endsWith('.html')) return 'text/html';
    if (p.endsWith('.css')) return 'text/css';
    if (p.endsWith('.csv')) return 'text/csv';
    // dist/assets/* of the ui-react build: browsers enforce strict MIME on
    // <script type="module"> — octet-stream chunks would be BLOCKED when a
    // remote consumer (pipeline-studio) serves them back from the store.
    if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript';
    if (p.endsWith('.zip')) return 'application/zip';
    if (p.endsWith('.svg')) return 'image/svg+xml';
    if (p.endsWith('.png')) return 'image/png';
    if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
    if (p.endsWith('.webp')) return 'image/webp';
    if (p.endsWith('.ico')) return 'image/x-icon';
    if (p.endsWith('.woff2')) return 'font/woff2';
    if (p.endsWith('.woff')) return 'font/woff';
    return 'application/octet-stream';
  };
  const snapshotPipelineCwd = async (root: string): Promise<Map<string, { mtimeMs: number; size: number }>> => {
    const out = new Map<string, { mtimeMs: number; size: number }>();
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>);
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const abs = path.join(dir, e.name);
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { await walk(abs, relPath); continue; }
        if (!e.isFile()) continue;
        const st = await fs.promises.stat(abs).catch(() => null);
        if (!st || st.size > 16 * 1024 * 1024) continue;
        out.set(relPath, { mtimeMs: st.mtimeMs, size: st.size });
      }
    };
    await walk(root, '');
    return out;
  };
  // MANUAL upload (button-triggered): push the project's CURRENT output files to
  // the media-service file store (see docs/guides/media-file-sync-design.md).
  // Each file is attributed to its stage via the registry's `outputs` patterns
  // (unmatched files → stage 'misc'). A single content-hash `syncProjectFiles`
  // replaces the per-file upload loop (idempotent re-push is a no-op). Returns
  // counts (`uploaded` = files present after sync).
  // `stages` (Push all modal / `od kg push-all --stages`) narrows the push to
  // those pipelines' outputs; absent/empty → everything (legacy). Unattributed
  // 'misc' files only travel on unfiltered pushes.
  // `plan` (kg-sync/push-plan.ts) decides WHERE this push lands: the real
  // project (case 3) or a `pending--…` approval folder (case 1/2). push-all
  // computes it once per project and passes it in; single-project callers let
  // this function resolve it. EVERY media destination below must use
  // `plan.destId`, never `projectId` — the mirror-prune in particular, since a
  // staged push that listed the REAL project's files would delete them.
  const uploadProjectFiles = async (
    projectId: string,
    stages?: string[],
    plan?: PushPlan,
  ): Promise<UploadFilesResult> => {
    const cwd = await ensureProject(PROJECTS_DIR, projectId);
    // Regenerate the download-ready MD set (exports/) from the local outputs
    // BEFORE snapshotting, so every push ships MD that matches the outputs it
    // carries — Pipeline Studio streams exports/<doc>.md straight down.
    // Throws (failing the push) when prototype pages exist but pandoc is not
    // installed: a silently missing ui-html.md would lie downstream.
    await generateProjectExports(cwd, projectId);
    const files = await snapshotPipelineCwd(cwd);
    const projectName = getProject(db, projectId)?.name ?? projectId;
    // Attribution uses only the reconciled preview-identity UUID. A Google
    // subject is login provenance, never a media/identity owner id.
    const machine = await getMachineIdentityUser();
    const identityUserId = identityUserIdOf(machine);
    const owner = machine && identityUserId
      ? { id: identityUserId, email: machine.email, name: machine.name }
      : null;
    const media = new MediaClient({
      ...mediaConfigFromEnv(),
      ...(owner ? { userId: owner.id } : {}),
    });
    // WHERE this push lands. Everything below addresses the store by `destId`;
    // `projectId` from here on means only "this machine's local project".
    const dest = plan ?? (await planPush({ db, projectId, media, submitter: owner }));
    const destId = dest.destId;
    // An App is a first-class publishable unit.  Its local metadata and shared
    // document pool travel with every Feature publish, but under a reserved
    // prefix while the Feature is waiting for approval.  Studio extracts this
    // prefix into the App folder before it promotes the Feature folder.
    const appFiles: LocalSyncFile[] = [];
    let syntheticProjectJson: Buffer | null = null;
    const localCfg = getProject(db, projectId) as { metadata?: unknown } | null;
    const appCfg = studioConfigOf(localCfg?.metadata);
    if (appCfg.appId) {
      const app = getPipelineApp(db, appCfg.appId);
      const appName = app?.name ?? appCfg.appName ?? appCfg.appId;
      const designSystemId = app?.designSystemId ?? appCfg.designSystemId ?? null;
      const contextSnapshot = await createAppContextVersion({
        projectsDir: PROJECTS_DIR,
        appId: appCfg.appId,
        appName,
        designSystemId,
        docsReviewComponentSource: app?.docsReviewComponentSource ?? { mode: 'app-design-system' },
        figmaDesignSystemSource: figmaDesignSystemSourceForApp(db, app),
        designSystemDir: designSystemId ? await dsDirForId(designSystemId) : null,
      });
      let featureBinding = featureContextBindingFromMetadata(localCfg?.metadata);
      if (!featureBinding || featureBinding.appId !== appCfg.appId) {
        featureBinding = {
          schemaVersion: 1,
          appId: appCfg.appId,
          contextVersion: contextSnapshot.manifest.contextVersion,
          contentDigest: contextSnapshot.manifest.contentDigest,
          boundAt: new Date().toISOString(),
        };
        if (localCfg) {
          updateProject(db, projectId, {
            metadata: metadataWithFeatureContextBinding(localCfg.metadata, featureBinding),
          });
        }
      }
      const appJson = Buffer.from(`${JSON.stringify({
        kind: 'app',
        name: appName,
        ...(designSystemId ? { designSystemId } : {}),
        ...(app?.figmaDesignSystemSourceId ? { figmaDesignSystemSourceId: app.figmaDesignSystemSourceId } : {}),
        contextVersion: contextSnapshot.manifest.contextVersion,
        contextDigest: contextSnapshot.manifest.contentDigest,
      }, null, 2)}\n`);
      appFiles.push({ path: 'app.json', stage: 'app', mime: 'application/json', content: appJson });
      const docsRoot = appDocsDir(PROJECTS_DIR, appCfg.appId);
      const walkAppDocs = async (dir: string, rel = ''): Promise<void> => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const next = rel ? `${rel}/${entry.name}` : entry.name;
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) { await walkAppDocs(abs, next); continue; }
          if (!entry.isFile()) continue;
          const content = await fs.promises.readFile(abs).catch(() => null);
          if (content) appFiles.push({ path: `docs/${next}`, stage: 'app', mime: pipelineFileMime(next), content });
        }
      };
      await walkAppDocs(docsRoot);
      const contextFiles = await filesForFeatureContextPublish({
        projectsDir: PROJECTS_DIR,
        appId: appCfg.appId,
        currentContextVersion: contextSnapshot.manifest.contextVersion,
        binding: featureBinding,
      });
      for (const file of contextFiles) {
        appFiles.push({
          path: file.path,
          stage: 'app-context',
          mime: pipelineFileMime(file.path),
          content: file.content,
        });
      }
      if (dest.request) {
        dest.request.appPublish = { files: appFiles.length, includesDocsPool: appFiles.some((f) => f.path.startsWith('docs/')) };
        if (dest.request.app.mode === 'create' && designSystemId) dest.request.app.designSystemId = designSystemId;
        dest.request.feature.appContextBinding = featureBinding;
      }
      const existingProjectJson = await media.downloadFile(destId, 'project.json').then(
        (content) => JSON.parse(content.toString('utf8')) as Record<string, unknown>,
        () => ({} as Record<string, unknown>),
      );
      const publishedAppId = appCfg.approvedMapping?.approvedAppId ?? appCfg.appId;
      syntheticProjectJson = Buffer.from(`${JSON.stringify({
        ...existingProjectJson,
        name: projectName,
        appId: publishedAppId,
        appContextBinding: publishedAppId === featureBinding.appId
          ? featureBinding
          : { ...featureBinding, appId: publishedAppId },
      }, null, 2)}\n`);
    }
    if (dest.staged) {
      // A staged push writes NOTHING to preview-identity: the identity project
      // is the approver's to create, under the final id and AS the submitter
      // (that is what makes the submitter its owner).
      rememberPendingId(db, projectId, destId);
      if (dest.request) {
        dest.request.schema = 2;
        dest.request.publish = { stages: stages ?? [], outputTypes: [] };
      }
      // Ticket first, files second: a push that dies halfway must still leave
      // something the reviewer can read.
      if (dest.request) await writeStagingRequest(media, destId, dest.request);
    } else {
      // Identity project registration is deliberately owned by Pipeline Studio
      // approval.  Do not create a registry record from Open Design: a folder
      // discovered through a legacy/media-only path must not become approved
      // merely because it was pushed again.
    }
    const syncFiles: LocalSyncFile[] = [];
    if (syntheticProjectJson) {
      syncFiles.push({ path: 'project.json', stage: 'config', mime: 'application/json', content: syntheticProjectJson });
    }
    for (const rel of files.keys()) {
      // History metadata never re-enters the push set: changelog.json/_v/ live
      // on the store (composed below), even if a stray copy lands in the cwd.
      if (isHistoryArtifact(rel)) continue;
      // Download-ready MD exports always ship, bypassing any stage filter —
      // they were just regenerated from the full local outputs, so a
      // stage-scoped push must not strand stale MD on the store.
      if (isExportArtifact(rel)) {
        const content = await fs.promises.readFile(path.join(cwd, rel)).catch(() => null);
        if (content) syncFiles.push({ path: rel, stage: 'exports', mime: pipelineFileMime(rel), content });
        continue;
      }
      const def = stageForOutput(rel);
      if (stages?.length && (!def || !stages.includes(def.id))) continue;
      // localOnly stages (e.g. ui-html → prototype/) stay on this device — never
      // pushed to the media file store.
      if (def?.localOnly) continue;
      // syncExclude paths (react/dist/, generated entries, template scaffold)
      // never travel: derived artifacts are rebuilt on demand and scaffold is
      // reseeded by the builder — see PipelineDef.syncExclude.
      if (isSyncExcluded(rel)) continue;
      const content = await fs.promises.readFile(path.join(cwd, rel)).catch(() => null);
      if (!content) continue;
      syncFiles.push({ path: rel, stage: def?.id ?? 'misc', mime: pipelineFileMime(rel), content });
    }
    if (dest.staged && dest.request) {
      dest.request.publish = {
        stages: [...new Set(syncFiles.map((f) => f.stage).filter(Boolean))],
        outputTypes: [
          ...new Set(
            syncFiles.map((f) => path.extname(f.path).slice(1).toLowerCase()).filter(Boolean),
          ),
        ],
      };
      await writeStagingRequest(media, destId, dest.request);
    }
    if (appFiles.length) {
      if (dest.staged) {
        await media.syncProjectFiles(destId, appFiles.map((file) => ({ ...file, path: `__open_design_app__/${file.path}` })));
      } else if (appCfg.appId) {
        // Approved App: update its own folder as well as the selected Feature.
        await media.syncProjectFiles(appCfg.approvedMapping?.approvedAppId ?? appCfg.appId, appFiles);
      }
    }
    const synced = await media.syncProjectFiles(destId, syncFiles);
    // MIRROR prune — push is an OVERRIDE, not a merge: any store file that
    // belongs to a stage this push carries but no longer exists locally is
    // deleted, so after a push the store equals this machine's outputs (a
    // re-run that drops/renames screens really removes the old ones from
    // pipeline-studio). Never touched: version history (_v/, changelog.json,
    // project.json — old pushes stay restorable), localOnly stages (their
    // store copy is the only copy), unattributed scratch files, and stages
    // with NO local output in this push (an empty/partial cwd can't wipe
    // work it never had). Also prunes syncExcluded legacy files (pre-
    // syncExclude pushes). Best-effort — a prune failure never fails the
    // sync that already succeeded.
    try {
      const localSet = new Set(syncFiles.map((f) => f.path));
      // Stages this push actually carries output for (path-derived).
      const pushedStageIds = new Set(
        syncFiles.flatMap((f) => stagesForOutput(f.path).map((d) => d.id)),
      );
      const remote = await media.listFiles(destId);
      for (const f of remote) {
        const rel = typeof f.path === 'string' ? f.path : '';
        if (!rel || typeof f.id !== 'string') continue;
        if (isHistoryArtifact(rel)) continue;
        if (isSyncExcluded(rel)) {
          await media.deleteFile(f.id).catch(() => {});
          continue;
        }
        if (localSet.has(rel)) continue;
        // Exports mirror the local set exactly: an MD whose source doc
        // vanished locally (e.g. react removed) is pruned with it.
        if (isExportArtifact(rel)) {
          await media.deleteFile(f.id).catch(() => {});
          continue;
        }
        const defs = stagesForOutput(rel);
        if (defs.length === 0) continue; // unattributed scratch — leave
        if (defs.some((d) => d.localOnly)) continue; // never pushed → never pruned
        if (stages?.length && !defs.some((d) => stages.includes(d.id))) continue;
        if (!defs.some((d) => pushedStageIds.has(d.id))) continue;
        await media.deleteFile(f.id).catch(() => {});
      }
    } catch {
      /* listFiles unavailable — prune next push */
    }
    // `converted` (graph conversion count) is always 0 now — the graph store
    // this used to feed (KGS) has been removed; kept in the return shape for
    // API compatibility with existing callers/CLI output.
    const converted = 0;
    // ── Published version: freeze this push's deliverables under _v/<id> and
    // append the changelog entry pipeline-studio renders as the timeline.
    // Best-effort by contract — a history failure never fails the push.
    try {
      const entries = await readChangelog(media, destId);
      const verId = nextVerId(entries);
      // Reference the machine-local git state: the push commit (or, when the
      // tree was already committed by the run/build hooks, current HEAD).
      const committed = await commitHistory(cwd, { kind: 'push', verId, by: historyActor() }).catch(() => null);
      const gitCommit = committed?.commit ?? (await listHistory(cwd, 1))[0]?.commit;
      // Deliverables only (stage-attributed) — scratch 'misc' files sync as
      // latest but aren't worth freezing per-version.
      const deliverables = syncFiles.filter((f) => f.stage !== 'misc');
      await publishVersion(media, destId, verId, deliverables);
      entries.push({
        verId,
        at: new Date().toISOString(),
        by: owner ? { id: owner.id, email: owner.email, name: owner.name } : null,
        ...(gitCommit ? { gitCommit } : {}),
        files: deliverables.length,
        uploaded: synced.uploaded,
        deleted: synced.deleted,
      });
      await writeChangelog(media, destId, entries);
      const dropped = await pruneVersions(media, destId, historyKeepCount());
      if (dropped.length) console.log(`[history] pruned versions: ${dropped.join(', ')}`);
    } catch (err) {
      console.warn('[history] publish version failed (push itself succeeded):', err);
    }
    // `uploaded` reports files present in the store after sync (uploaded + already
    // up-to-date), preserving the "N files" button feedback across re-pushes.
    return {
      uploaded: synced.uploaded + synced.skipped,
      converted,
      destId,
      staged: dest.staged,
      case: dest.case,
    };
  };

  // The machine's owner (last Google login) as a history-commit author.
  const historyActor = () => {
    const m = getMachineUser();
    const id = identityUserIdOf(m);
    return m && id ? { id, email: m.email, name: m.name } : null;
  };

  // Regenerate a project's pipeline files from the media-service file store into
  // its local cwd (cross-device "pull to continue"). Unconditional overwrite —
  // BUT the .odhistory pre-pull commit below fences the current state first,
  // so an overwriting pull can always be undone. The conflict-aware variant
  // lives in planPull/applyPull. Path-traversal guarded to cwd.
  // `stages` (Pull all modal / `od kg pull-all --stages`) narrows the pull to
  // those pipelines' outputs; absent/empty → everything (legacy).
  const pullPipelineFiles = async (
    projectId: string,
    cwd: string,
    stages?: string[],
    // Stage ids whose outputs must NOT be pulled — used on a RE-RUN so the store
    // copy of the stage (and its stale downstream) doesn't resurrect the local
    // files we just cleared. Path-derived (stagesForOutput) so it ignores the
    // media `stage` tag, which can carry retired stage ids.
    excludeStages?: string[],
    // Only fetch files ABSENT from the local cwd; never overwrite a file that is
    // already there. Used by the pre-run pull so running a stage can't clobber a
    // locally-edited (or freshly-regenerated) input with the store's copy.
    missingOnly?: boolean,
  ): Promise<number> => {
    await commitHistory(cwd, { kind: 'pre-pull', by: historyActor() }).catch(() => null);
    const media = new MediaClient(mediaConfigFromEnv());
    const files = await media.listFiles(projectId);
    const cwdReal = path.resolve(cwd);
    let pulled = 0;
    for (const f of files) {
      const rel = typeof f.path === 'string' ? f.path : '';
      if (!rel) continue;
      // History metadata stays on the store: version snapshots are restored
      // ON DEMAND (restore API), not dragged down by every pull.
      if (isHistoryArtifact(rel)) continue;
      // Never pull syncExclude paths, even from a store that predates the
      // exclusion — restoring an old scaffold/dist over a newer local toolkit
      // is exactly the failure mode syncExclude exists to prevent.
      if (isSyncExcluded(rel)) continue;
      // Derived MD exports never pull down: each machine regenerates its own
      // set on push, and a pulled copy would only shadow that.
      if (isExportArtifact(rel)) continue;
      if (excludeStages?.length && stagesForOutput(rel).some((d) => excludeStages.includes(d.id))) {
        continue;
      }
      if (stages?.length) {
        const sid = f.stage || stageForOutput(rel)?.id;
        if (!sid || !stages.includes(sid)) continue;
      }
      const dest = path.resolve(cwd, rel);
      if (dest !== cwdReal && !dest.startsWith(cwdReal + path.sep)) continue;
      // Don't overwrite a file the local cwd already has (see missingOnly).
      if (missingOnly && fs.existsSync(dest)) continue;
      const content = await media.downloadFile(projectId, rel).catch(() => null);
      if (!content) continue;
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, content);
      pulled += 1;
    }
    if (pulled > 0) {
      await commitHistory(cwd, {
        kind: 'pull',
        note: `pulled ${pulled} file(s) từ store`,
        by: historyActor(),
      }).catch(() => null);
    }
    return pulled;
  };

  // Conflict-aware pull (PLAN → RESOLVE → APPLY). Unlike pullPipelineFiles (which
  // overwrites blindly), this classifies remote files against the local cwd and
  // hands conflicts back to the caller. planStore holds the per-plan snapshot
  // (path→remoteChecksum at plan time) so APPLY can detect remote drift (TOCTOU).
  // See docs/guides/pull-conflict-resolution-spec.md.
  const planStore = new PullPlanStore();

  // PLAN: classify the project's media-service files against the local cwd (no
  // writes), snapshot the result, and return it. Core logic in pull-conflict.ts.
  const planPull = async (projectId: string): Promise<PullPlan> => {
    const cwd = await ensureProject(PROJECTS_DIR, projectId);
    const media = new MediaClient(mediaConfigFromEnv());
    const { plan, remoteByPath } = await planPullFiles(projectId, cwd, media);
    planStore.put(plan, remoteByPath);
    return plan;
  };

  // APPLY: act on a prior plan's resolutions (TOCTOU-guarded). Unknown/expired
  // planId → throws ERR_PLAN_EXPIRED (route maps to 409).
  const applyPull = async (
    projectId: string,
    planId: string,
    resolutions: Record<string, PullResolution>,
    onConflictDefault: PullResolution = 'local',
  ): Promise<PullApplyResult> => {
    const stored = planStore.get(planId);
    if (!stored) {
      const err = new Error(`plan ${planId} expired or unknown`) as Error & { code?: string };
      err.code = ERR_PLAN_EXPIRED;
      throw err;
    }
    const cwd = await ensureProject(PROJECTS_DIR, projectId);
    // Same fence as pullPipelineFiles: chosen-remote overwrites stay
    // reversible because the pre-apply state is committed first.
    await commitHistory(cwd, { kind: 'pre-pull', by: historyActor() }).catch(() => null);
    const media = new MediaClient(mediaConfigFromEnv());
    const result = await applyPullFiles(projectId, cwd, media, stored, resolutions, onConflictDefault);
    await commitHistory(cwd, {
      kind: 'pull',
      note: 'pull-apply (đã giải quyết conflict)',
      by: historyActor(),
    }).catch(() => null);
    return result;
  };

  // ── Deterministic docs run (TOOL-ONLY — no agent, no LLM) ──────────────────
  // The docs stage's Confluence path: the daemon fetches every page itself via
  // the BAS gateway (`confluence_fetch_page` → markdown) and writes the FINAL
  // deliverables (docs/confluence/*.md + _index.md) straight into the workflow
  // cwd — no conversation is seeded, no agent runs, and the stage flips to
  // succeeded/failed purely on the fetch result. Same side effects as an agent
  // run otherwise (status + lastInput/lastSource, re-run clear, downstream
  // reset, history commit), so gating, sync, and run-all behave identically.
  // The start payload has NO conversationId/agentRunId (nothing to open);
  // `completion` resolves when the fetch finishes so run-all chains instantly.
  const runDocsDeterministic = async (
    pipelineId: string,
    projectId: string,
    wfDir: string | null,
    refs: string[],
    input?: string,
    source?: import('@open-design/contracts').PipelineRunSource,
    resetScope?: 'stage' | 'downstream',
    followLinks?: boolean,
    includeDescendants?: boolean,
  ) => {
    const trimmedInput =
      (input ?? '').trim() || (source?.kind === 'confluence' ? source.ref.trim() : '');
    setProjectPipelineStatus(db, projectId, pipelineId, {
      status: 'running',
      ...(trimmedInput ? { lastInput: trimmedInput } : {}),
      ...(source ? { lastSource: source } : {}),
    });
    const regenIds = new Set(stageRegenSet(pipelineId, resetScope === 'downstream'));
    const pipelineCwd = await ensureProject(PROJECTS_DIR, projectId).catch(() => null);
    if (pipelineCwd) {
      // Same fence + re-run clear as the agent path: manual edits get their own
      // history commit, then this stage's (and, on cascade, downstream) outputs
      // are wiped so the fetch regenerates a clean set (target-fenced).
      await commitHistory(pipelineCwd, { kind: 'manual-edits', by: historyActor() }).catch(() => null);
      try {
        const snap = await snapshotPipelineCwd(pipelineCwd);
        for (const rel of snap.keys()) {
          if (relClearedByRegen(rel, regenIds, wfDir)) {
            await fs.promises.rm(path.join(pipelineCwd, rel), { force: true }).catch(() => null);
          }
        }
      } catch (error) {
        console.warn('[pipelines] re-run clear failed (continuing):', error);
      }
    }
    for (const id of regenIds) {
      if (id !== pipelineId) setProjectPipelineStatus(db, projectId, id, { status: 'idle' });
    }
    const completion: Promise<'succeeded' | 'failed' | 'idle'> = (async () => {
      try {
        if (!pipelineCwd) throw new Error(`project dir for ${projectId} unavailable`);
        // Direct PAT first (the same creds the page-search picker uses),
        // gateway as fallback — most gateways have no Confluence credential.
        const [creds, ep] = await Promise.all([
          resolveConfluenceCreds(RUNTIME_DATA_DIR).catch(() => null),
          resolveBasEndpoint(RUNTIME_DATA_DIR).catch(() => null),
        ]);
        if (!creds && !ep) {
          throw new Error(
            'Chưa có credential Confluence: thêm Base URL + Personal Access Token ở Settings → Integrations → Confluence, hoặc cấu hình BAS gateway (BAS_MCP_URL + BAS_MCP_TOKEN).',
          );
        }
        const cwd = wfDir ? path.join(pipelineCwd, wfDir) : pipelineCwd;
        // Sub-tree scan (opt-in): expand each seed into its descendant pages via
        // CQL, folder-structured. Soft cap — a tree bigger than the threshold
        // still runs but logs a warning (chỉ cảnh báo, không chặn). PAT-only.
        let treePages: import('./bas/bas-client.js').DescendantPage[] = [];
        if (includeDescendants && creds) {
          const seen = new Set<string>();
          for (const ref of refs) {
            const seedId = extractPageId(ref);
            try {
              const desc = await listDescendantPages(creds, seedId);
              for (const d of desc) {
                if (seen.has(d.pageId)) continue;
                seen.add(d.pageId);
                treePages.push(d);
              }
            } catch (err) {
              console.warn(`[pipelines] sub-tree scan for seed ${seedId} failed (continuing):`, err);
            }
          }
          const scanTotal = refs.length + treePages.length;
          if (scanTotal > DOCS_SUBTREE_WARN_THRESHOLD) {
            console.warn(
              `[pipelines] sub-tree scan for ${projectId}/${pipelineId}: ${scanTotal} trang (> ${DOCS_SUBTREE_WARN_THRESHOLD}) — vẫn chạy, có thể lâu.`,
            );
          }
          console.log(`[pipelines] sub-tree scan: ${treePages.length} trang con dưới ${refs.length} seed`);
        }
        const pages = await fetchConfluencePages({ creds, ep }, refs, {
          followLinks: followLinks !== false,
          attachmentsDir: path.join(cwd, 'docs/confluence/attachments'),
          runtimeDataDir: RUNTIME_DATA_DIR,
          ...(treePages.length ? { treePages } : {}),
        });
        for (const p of pages) {
          const abs = path.join(cwd, p.relPath);
          await fs.promises.mkdir(path.dirname(abs), { recursive: true });
          await fs.promises.writeFile(abs, p.content, 'utf8');
        }
        const idxAbs = path.join(cwd, 'docs/confluence/_index.md');
        await fs.promises.mkdir(path.dirname(idxAbs), { recursive: true });
        await fs.promises.writeFile(idxAbs, renderConfluenceIndex(pages), 'utf8');
        const criteriaDsId = criteriaDesignSystemForProject(projectId);
        if (criteriaDsId) await copyDsCriteriaIntoWorkflow(criteriaDsId, cwd, dsDirForId);
        console.log(
          `[pipelines] deterministic docs run for ${projectId}: fetched ${pages.length} Confluence page(s), no agent`,
        );
        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'succeeded' });
        void commitHistory(pipelineCwd, {
          kind: 'run',
          pipelineId,
          status: 'succeeded',
          by: historyActor(),
          ...(trimmedInput ? { input: trimmedInput } : {}),
        }).catch(() => null);
        return 'succeeded' as const;
      } catch (error) {
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: 'failed',
          error: String(error?.message ?? error),
        });
        console.warn('[pipelines] deterministic docs run failed:', error);
        return 'failed' as const;
      }
    })();
    return { projectId, completion };
  };

  // copyDsCriteriaIntoWorkflow sống ở ds-criteria.ts (cùng nhà với
  // dsCriteriaDir/readDsCriteriaState/writeDsRulesFile/commitGeneratedComponentsMd)
  // — import ở đầu file. server.ts chỉ còn truyền `dsDirForId` làm resolver.

  /** DS làm nguồn bộ tiêu chí review cho feature này — thuộc tính của APP sở hữu
   * nó, không phải của feature. */
  const criteriaDesignSystemForProject = (projectId: string): string | null => {
    try {
      const appId = getProject(db, projectId)?.metadata?.studioConfig;
      const id = appId && typeof appId === 'object' && !Array.isArray(appId)
        ? (appId as Record<string, unknown>).appId
        : null;
      if (typeof id !== 'string' || !id) return null;
      const designSystemId = getPipelineApp(db, id)?.designSystemId;
      return typeof designSystemId === 'string' && designSystemId ? designSystemId : null;
    } catch {
      return null;
    }
  };

  // ── App Docs Pool — deterministic copy (docs/app-docs-pool-spec.md §WP-4)
  // ────────────────────────────────────────────────────────────────────────
  // confluence-ingest with an `app-pool` source: no fetch, NO AGENT — bước 1 copy
  // THẲNG trang gốc được tick (+ attachments/ dùng chung) từ pool của App
  // vào `<wf>/docs/`. Tầng chưng cất đã gỡ hẳn (quyết định 2026-08-08:
  // docs gốc là nguồn làm việc duy nhất; các stage sau đọc cả pool qua
  // `.app-docs/` với `_index.md` sinh máy làm bản đồ) — cùng status/history
  // semantics với `runDocsDeterministic` ở trên.
  const runDocsFromAppPool = (
    pipelineId: string,
    projectId: string,
    wfDir: string | null,
    appId: string,
    paths: string[],
    source: import('@open-design/contracts').PipelineRunSource | undefined,
    resetScope?: 'stage' | 'downstream',
  ): { projectId: string; completion: Promise<'succeeded' | 'failed' | 'idle'> } => {
    setProjectPipelineStatus(db, projectId, pipelineId, {
      status: 'running',
      ...(source ? { lastSource: source } : {}),
    });
    const regenIds = new Set(stageRegenSet(pipelineId, resetScope === 'downstream'));
    const completion: Promise<'succeeded' | 'failed' | 'idle'> = (async () => {
      try {
        const pipelineCwd = await ensureProject(PROJECTS_DIR, projectId);
        await commitHistory(pipelineCwd, { kind: 'manual-edits', by: historyActor() }).catch(() => null);
        try {
          const snap = await snapshotPipelineCwd(pipelineCwd);
          for (const rel of snap.keys()) {
            if (relClearedByRegen(rel, regenIds, wfDir)) {
              await fs.promises.rm(path.join(pipelineCwd, rel), { force: true }).catch(() => null);
            }
          }
        } catch (error) {
          console.warn('[app-pool] re-run clear failed (continuing):', error);
        }
        for (const id of regenIds) {
          if (id !== pipelineId) setProjectPipelineStatus(db, projectId, id, { status: 'idle' });
        }

        const manifest = await readManifest(PROJECTS_DIR, appId);
        const selected = manifest.pages.filter((p) => paths.includes(p.path));
        if (selected.length === 0) {
          throw new Error('Không có trang nào được chọn từ pool tài liệu App — tick lại rồi chạy lại.');
        }
        const cwd = wfDir ? path.join(pipelineCwd, wfDir) : pipelineCwd;
        const poolDocsDir = appDocsDir(PROJECTS_DIR, appId);
        // `docs-feature/` thuộc TRỌN quyền bước 1 — xóa cả cây rồi copy lại
        // đúng selection mới, không cần danh sách KEEP (system-map.json,
        // docs/jira|confluence… là chuyện của layout cũ nằm ngoài thư mục này).
        const featureDir = path.join(cwd, 'docs-feature');
        await fs.promises.rm(featureDir, { recursive: true, force: true }).catch(() => null);
        await fs.promises.mkdir(featureDir, { recursive: true });
        for (const p of selected) {
          const dst = path.join(featureDir, p.path);
          await fs.promises.mkdir(path.dirname(dst), { recursive: true });
          await fs.promises.copyFile(path.join(poolDocsDir, p.path), dst);
        }
        // Shared image folder (§2.2 import-confluence localizes every page's
        // images under `<appId>/docs/attachments/`) — copy it whole so the
        // copied pages' `![...](…/attachments/…)` references resolve,
        // regardless of which subset of pages was ticked.
        await fs.promises
          .cp(path.join(poolDocsDir, 'attachments'), path.join(featureDir, 'attachments'), { recursive: true })
          .catch(() => null);
        // Mặc định của MỌI workflow gắn App: cả pool nạp read-only vào
        // `docs-app/` ngay từ bước 1 (các stage agent sau cũng tự re-stage
        // trước mỗi lượt chạy) — agent nắm toàn cảnh App qua _index.md.
        await stageAppDocsPool(PROJECTS_DIR, appId, cwd).catch((error) => {
          console.warn('[app-pool] stage docs-app at step 1 failed (continuing):', error);
        });
        const criteriaDsId = criteriaDesignSystemForProject(projectId);
        if (criteriaDsId) await copyDsCriteriaIntoWorkflow(criteriaDsId, cwd, dsDirForId);

        console.log(
          `[app-pool] docs ingest for ${projectId}: copied ${selected.length} page(s) into docs-feature/ from App "${appId}" pool, no fetch, no agent`,
        );
        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'succeeded' });
        void commitHistory(pipelineCwd, {
          kind: 'run',
          pipelineId,
          status: 'succeeded',
          by: historyActor(),
        }).catch(() => null);
        return 'succeeded' as const;
      } catch (error) {
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: 'failed',
          error: String((error as Error)?.message ?? error),
        });
        console.warn('[app-pool] docs-from-pool run failed:', error);
        return 'failed' as const;
      }
    })();
    return { projectId, completion };
  };

  // PRD Requirements Review runs PER PAGE in parallel: one agent run per doc page
  // (bounded pool), each writing review/<slug>/report.json, then the daemon
  // merges them into review/index.json + summary.md. All page runs share ONE
  // conversation (one entry in the list, per-page messages for transcripts);
  // history commit + re-run clear happen ONCE up front so the concurrent runs
  // never race the git history. A page whose run fails is marked failed in the
  // index but never fails the whole stage — the rest still ship.
  // Cancel handles for in-flight fan-out stages, keyed `${projectId}::${pipelineId}`.
  // A fan-out stage registers one when it starts (setting a flag the pool checks
  // + canceling every live sub-run) and deletes it when it finishes; the
  // /api/pipelines/:projectId/:pipelineId/cancel endpoint invokes it.
  const pipelineCancelers = new Map<string, () => void>();
  const registerPipelineCanceler = (
    key: string,
    activeRuns: Set<{ id: string }>,
    setCanceled: () => void,
  ) => {
    pipelineCancelers.set(key, () => {
      setCanceled();
      for (const r of activeRuns) {
        const live = design.runs.get(r.id);
        if (live) {
          try {
            design.runs.cancel(live);
          } catch {
            /* already terminal */
          }
        }
      }
    });
  };

  const PRD_REVIEW_FANOUT_CONCURRENCY = 4;
  const runDocsMockupReviewFanout = (
    pipelineId: string,
    projectId: string,
    wfDir: string | null,
    resetScope?: 'stage' | 'downstream',
  ): { projectId: string; completion: Promise<'succeeded' | 'failed' | 'idle'> } => {
    const cancelKey = `${projectId}::${pipelineId}`;
    const activeRuns = new Set<{ id: string }>();
    let canceled = false;
    registerPipelineCanceler(cancelKey, activeRuns, () => {
      canceled = true;
    });
    const completion: Promise<'succeeded' | 'failed' | 'idle'> = (async () => {
      const def = getPipelineDef(pipelineId)!;
      try {
        const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
        let agentId = typeof appConfig.agentId === 'string' && appConfig.agentId ? appConfig.agentId : null;
        if (!agentId) {
          const agents = await detectAgents(appConfig.agentCliEnv ?? {}, sandboxSkipProbe(appConfig)).catch(() => []);
          agentId = agents.find((a) => a.available)?.id ?? null;
        }
        if (!agentId) {
          const sandboxAgentId = await sandboxFallbackRuntimeId();
          if (sandboxAgentId) agentId = sandboxAgentId;
        }
        if (!agentId) throw new Error('No available agent is configured. Choose an agent in Settings first.');

        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'running', subConversations: [] });
        const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
        const cwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;

        // ONE-TIME fence + re-run clear (concurrent page runs must NOT each do
        // this): snapshot manual edits, then wipe this stage's (and, on cascade,
        // downstream) outputs so the fan-out regenerates a clean review/ tree.
        const regenIds = new Set(stageRegenSet(pipelineId, resetScope === 'downstream'));
        await commitHistory(projectRoot, { kind: 'manual-edits', by: historyActor() }).catch(() => null);
        try {
          const snap = await snapshotPipelineCwd(projectRoot);
          for (const rel of snap.keys()) {
            // Target fence included: a target-scoped fan-out clears only its
            // own <wf>/<target>/ subtree (see relClearedByRegen).
            if (relClearedByRegen(rel, regenIds, wfDir)) {
              await fs.promises.rm(path.join(projectRoot, rel), { force: true }).catch(() => null);
            }
          }
        } catch (error) {
          console.warn('[prd-review] re-run clear failed (continuing):', error);
        }
        for (const id of regenIds) {
          if (id !== pipelineId) setProjectPipelineStatus(db, projectId, id, { status: 'idle' });
        }

        const pages = await listRequirementPages(cwd);
        if (pages.length === 0) {
          // Nothing to review — the stage ran no agent, so it did NOT succeed.
          // Reporting 'succeeded' here would be indistinguishable from a real
          // pass. A requirements review with no source pages is a broken input,
          // not a clean bill of health — fail loudly so docs ingest is re-run.
          const { index } = mergePageReports([]);
          await fs.promises.mkdir(path.join(cwd, 'review'), { recursive: true });
          await fs.promises.writeFile(path.join(cwd, 'review/index.json'), JSON.stringify(index, null, 2), 'utf8');
          await fs.promises.writeFile(
            path.join(cwd, 'review/summary.md'),
            [
              '# PRD Requirements Review — không chạy được',
              '',
              'Không tìm thấy trang URD/PRD nào để review yêu cầu.',
              '',
              '- Bước **Docs → Markdown** đã chạy cho workflow này chưa (thư mục `docs/confluence/` có trang không).',
              '- Đã chọn/nạp trang URD chính chưa (PRD chỉ là tài liệu bổ sung ngữ cảnh).',
              '- Thư mục nguồn có trang Markdown thực tế, không chỉ `_index.md` hoặc thư mục `attachments/`, chưa.',
              '',
              'Sau khi khắc phục, chạy lại bước này.',
              '',
            ].join('\n'),
            'utf8',
          );
          setProjectPipelineStatus(db, projectId, pipelineId, {
            status: 'failed',
            subConversations: [],
            error: 'Không tìm thấy trang URD/PRD để review — chạy bước Docs → Markdown trước, rồi chạy lại bước này.',
          });
          console.warn(`[prd-review] no requirement pages under ${cwd} — nothing to review`);
          return 'failed' as const;
        }

        // Each parallel page gets its OWN conversation (titled by page) so the
        // chat UI shows one readable single-agent transcript per task instead of
        // N agents interleaved in one log. The stage's "Open chat" lands on the
        // first; the ConversationsMenu lists the siblings by their shared prefix.
        const modelPrefs = appConfig.agentModels?.[agentId] ?? {};
        const graphNote =
          ' This is a FILE-ONLY stage: produce the report file only — do not push anything anywhere.';

        // Pre-create one conversation per page (up front, all "queued") so the
        // Status modal shows X/N done + each task's live state as the pool
        // progresses. persistTasks() writes the current snapshot on each change.
        const tasks = pages.map((pg) => {
          const id = `pipeline-conv-${randomUUID()}`;
          insertConversation(db, { id, projectId, title: `${def.name} · ${pg.page}`, createdAt: Date.now(), updatedAt: Date.now() });
          return { id, title: pg.page, status: 'queued' as 'queued' | 'running' | 'succeeded' | 'failed' };
        });
        const persistTasks = () =>
          setProjectPipelineStatus(db, projectId, pipelineId, { subConversations: tasks.map((t) => ({ ...t })) });
        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'running', lastConversationId: tasks[0]?.id });
        persistTasks();

        // Bounded-concurrency pool: at most K page runs in flight at once.
        let done = 0;
        const runOnePage = async (pg: (typeof pages)[number], task: (typeof tasks)[number]): Promise<'succeeded' | 'failed' | 'idle'> => {
          const conversationId = task.id;
          task.status = 'running';
          persistTasks();
          const assistantMessageId = `pipeline-assistant-${randomUUID()}`;
          const kickoff =
            `Run the text-first PRD requirements review for ONE page of feature "${projectId}". ` +
            `Review ONLY the written requirements in "${pg.mdPath}" (title: ${pg.page}) against that page's text, ` +
            `plus the shared Customer Journey, UX Research, and Design System criteria in this cwd. ` +
            `Embedded mockups/screenshots are illustrative only: do NOT open, score, copy, or use them as design or wireframe direction. ` +
            `Write your result to "review/${pg.slug}/report.json" using the compatible attachment-keyed schema; base every finding on text. ` +
            `Do NOT review any other page, and do NOT write review/index.json or review/summary.md — the pipeline aggregates those from every page's report.${graphNote}`;
          const run = design.runs.create({
            projectId,
            conversationId,
            assistantMessageId,
            clientRequestId: `prd-review-${pg.slug}-${randomUUID()}`,
            agentId: agentId!,
          });
          activeRuns.add(run);
          upsertMessage(db, conversationId, { id: `pipeline-user-${run.id}`, role: 'user', content: kickoff });
          upsertMessage(db, conversationId, {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            agentId: agentId!,
            agentName: getAgentDef(agentId!)?.name ?? agentId!,
            runId: run.id,
            runStatus: 'queued',
            startedAt: Date.now(),
          });
          design.runs.start(run, () =>
            startChatRun(
              {
                agentId: agentId!,
                projectId,
                conversationId,
                assistantMessageId,
                clientRequestId: run.clientRequestId,
                skillId: def.skillId,
                ...(wfDir ? { cwdSubdir: wfDir } : {}),
                model: modelPrefs.model ?? null,
                reasoning: modelPrefs.reasoning ?? null,
                message: kickoff,
                promptProfile: 'pipeline',
                pipelineUsesDesignSystem: def.acceptsDesignSystem === true,
              },
              run,
            ),
          );
          const final = await design.runs.wait(run);
          activeRuns.delete(run);
          db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`).run(final.status, Date.now(), assistantMessageId);
          task.status = final.status === 'succeeded' ? 'succeeded' : 'failed';
          persistTasks();
          done += 1;
          console.log(`[prd-review] page ${done}/${pages.length} "${pg.page}" → ${final.status}`);
          return final.status === 'succeeded' ? 'succeeded' : final.status === 'canceled' ? 'idle' : 'failed';
        };

        let cursor = 0;
        const worker = async () => {
          for (;;) {
            if (canceled) break;
            const i = cursor++;
            if (i >= pages.length) break;
            await runOnePage(pages[i]!, tasks[i]!).catch(() => {
              tasks[i]!.status = 'failed';
              persistTasks();
              return 'failed' as const;
            });
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(PRD_REVIEW_FANOUT_CONCURRENCY, pages.length) }, worker),
        );

        if (canceled) {
          setProjectPipelineStatus(db, projectId, pipelineId, { status: 'idle', subConversations: tasks.map((t) => ({ ...t })) });
          console.log('[prd-review] fan-out canceled by user');
          return 'idle' as const;
        }

        // Merge: read each page's report.json (null if its run wrote nothing),
        // then write the manifest + human summary. Daemon-owned, no LLM.
        const perPage = await Promise.all(
          pages.map(async (pg) => {
            const rel = `review/${pg.slug}/report.json`;
            const report = await fs.promises
              .readFile(path.join(cwd, rel), 'utf8')
              .then((t) => JSON.parse(t) as unknown)
              .catch(() => null);
            return { slug: pg.slug, page: pg.page, mdPath: pg.mdPath, report };
          }),
        );
        const { index, summaryMd } = mergePageReports(perPage);
        await fs.promises.mkdir(path.join(cwd, 'review'), { recursive: true });
        await fs.promises.writeFile(path.join(cwd, 'review/index.json'), JSON.stringify(index, null, 2), 'utf8');
        await fs.promises.writeFile(path.join(cwd, 'review/summary.md'), summaryMd, 'utf8');

        // Don't-fail-the-whole-stage-for-one-page: succeed as long as at least
        // one page produced a report; fail only if every page run came back empty.
        const anyReport = perPage.some((p) => p.report);
        const next: 'succeeded' | 'failed' = anyReport ? 'succeeded' : 'failed';
        if (next === 'failed') {
          const failureDetail = fanoutFailureDetail(
            perPage.map((p, i) => ({ name: p.page, errors: [`không có review/${p.slug}/report.json (run: ${tasks[i]?.status ?? '?'})`] })),
          );
          attachStageFailureContext(projectId, pipelineId, {
            agentId,
            model: modelPrefs.model ?? null,
            reasoning: modelPrefs.reasoning ?? null,
            outputs: `prd-review: 0/${perPage.length} trang có report.json\n${failureDetail.list}`,
            finalStatus: 'failed',
            workflowId: wfDir,
          });
        }
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: next,
          subConversations: tasks.map((t) => ({ ...t })),
          ...(next === 'failed' ? { error: `Không trang nào ghi được report.json (${perPage.length} trang) — xem hội thoại của từng trang` } : {}),
        });
        void commitHistory(projectRoot, { kind: 'run', pipelineId, status: next, by: historyActor() }).catch(() => null);
        console.log(`[prd-review] fan-out done: ${perPage.filter((p) => p.report).length}/${pages.length} pages reported → ${next}`);
        return next;
      } catch (error) {
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: 'failed',
          error: String(error?.message ?? error),
        });
        console.warn('[prd-review] fan-out failed:', error);
        return 'failed' as const;
      } finally {
        pipelineCancelers.delete(cancelKey);
      }
    })();
    return { projectId, completion };
  };

  // Docs → Màn hình → Component (dr-comp, v2 2026-08-18) — fan-out theo MÀN
  // HÌNH lấy từ bước Đánh giá luồng UX (flows/index.json[].screens), KHÔNG
  // còn theo trang tài liệu:
  //   - v1 chỉ thấy màn khi trang khai `Màn hình N: SCR-…` + bảng "Kiểu hiển
  //     thị"; PRD viết bằng đoạn văn thì bước này trắng. v2 coi bảng đó (nếu
  //     có) là THAM KHẢO, ảnh mockup KHÔNG phải đầu vào; đề xuất component do
  //     Design System quyết (criteria/components.md + catalog/examples/rules).
  //   - Daemon dựng `comp/_inputs.json` (prepareScreenComponentInputs — màn,
  //     trang + mục tài liệu, bước luồng trên màn, đi ra màn nào, phát hiện
  //     UX), chạy MỘT lượt role-map cho cả feature (`comp/_role-map.json`) để
  //     các màn map nhất quán, rồi fan-out theo màn: mỗi lượt ghi
  //     `comp/<KEY>.screen.json` + `wireframes/<KEY>.html` (HTML kiểu ux-spec).
  //   - VALIDATE (screen-components.ts): key đúng màn được giao; component /
  //     anchor / data-comp phải có trong danh mục; data-el ↔ elements[] khớp;
  //     data-nav / nav.to phải là SCREEN-KEY của luồng; wireframe không script.
  //     KHÔNG còn đối chiếu nguyên văn heading/label với trang.
  //   - Daemon gộp `comp/index.json` (schema 2.0) + `comp/summary.md`.
  //
  // FAIL-SHUT giữ nguyên tinh thần v1 (deriveStateFromLocalFiles suy trạng
  // thái từ SỰ CÓ MẶT file dưới outputs `comp/`, `wireframes/`): màn hỏng →
  // xoá file của riêng màn đó; role-map hỏng / không màn nào đạt / huỷ / outer
  // catch → xoá sạch comp/ + wireframes/ và ghi lý do ra file ngang hàng
  // (writeDocsComponentFailureNote → `comp-khong-chay-duoc.md`).
  const DOCS_COMPONENT_FANOUT_CONCURRENCY = 4;
  const FIGMA_CATALOG_EXTRACTION_TIMEOUT_MS = 12 * 60 * 1000;
  const replaceValidatedFile = async (candidate: string, target: string): Promise<void> => {
    const backup = `${target}.${randomUUID()}.bak`;
    let backedUp = false;
    try {
      await fs.promises.rename(target, backup);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await fs.promises.rename(candidate, target);
      if (backedUp) await fs.promises.rm(backup, { force: true });
    } catch (error) {
      if (backedUp) {
        await fs.promises.rm(target, { force: true }).catch(() => null);
        await fs.promises.rename(backup, target).catch(() => null);
      }
      throw error;
    }
  };
  const runDocsComponentAuditFanout = (
    pipelineId: string,
    projectId: string,
    wfDir: string | null,
    resetScope?: 'stage' | 'downstream',
  ): { projectId: string; completion: Promise<'succeeded' | 'failed' | 'idle'> } => {
    const cancelKey = `${projectId}::${pipelineId}`;
    const activeRuns = new Set<{ id: string }>();
    let canceled = false;
    registerPipelineCanceler(cancelKey, activeRuns, () => {
      canceled = true;
    });
    // Gương của cwd/pages/results, cập nhật ngay khi từng thứ có giá trị, để
    // OUTER catch bên dưới (nó không với tới được các const block-scoped trong
    // try) vẫn fail-shut được. `outerResults` trỏ CÙNG mảng với `results`.
    let outerCwd: string | null = null;
    let outerPages: DocPage[] = [];
    let outerScreenKeys: string[] = [];
    type CompScreenResult = {
      key: string;
      name: string;
      doc: ScreenComponentsDoc | null;
      status: 'succeeded' | 'failed';
      errors: string[];
    };
    let outerResults: Array<CompScreenResult | undefined> = [];
    const completion: Promise<'succeeded' | 'failed' | 'idle'> = (async () => {
      const def = getPipelineDef(pipelineId)!;
      try {
        const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
        let agentId = typeof appConfig.agentId === 'string' && appConfig.agentId ? appConfig.agentId : null;
        if (!agentId) {
          const agents = await detectAgents(appConfig.agentCliEnv ?? {}, sandboxSkipProbe(appConfig)).catch(() => []);
          agentId = agents.find((a) => a.available)?.id ?? null;
        }
        if (!agentId) {
          const sandboxAgentId = await sandboxFallbackRuntimeId();
          if (sandboxAgentId) agentId = sandboxAgentId;
        }
        if (!agentId) throw new Error('No available agent is configured. Choose an agent in Settings first.');

        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'running', subConversations: [] });
        const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
        const cwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;

        // dr-comp is a dedicated fan-out runner and returns before the normal
        // single-agent staging block below. Stage the Feature's bound App
        // Context here so a reusable Figma DS reaches exactly the path this
        // runner reads: ./criteria/components.md.
        const featureProject = getProject(db, projectId);
        const studioConfig = (featureProject?.metadata as Record<string, unknown> | undefined)?.studioConfig as
          | Record<string, unknown>
          | undefined;
        const localAppId = typeof studioConfig?.appId === 'string' ? studioConfig.appId.trim() : '';
        if (localAppId) {
          const localApp = getPipelineApp(db, localAppId);
          const designSystemId = localApp?.designSystemId ?? criteriaDesignSystemForProject(projectId) ?? null;
          const snapshot = await createAppContextVersion({
            projectsDir: PROJECTS_DIR,
            appId: localAppId,
            appName: localApp?.name ?? localAppId,
            designSystemId,
            docsReviewComponentSource: localApp?.docsReviewComponentSource ?? { mode: 'app-design-system' },
            figmaDesignSystemSource: figmaDesignSystemSourceForApp(db, localApp),
            designSystemDir: designSystemId ? await dsDirForId(designSystemId) : null,
          });
          let binding = featureContextBindingFromMetadata(featureProject?.metadata);
          if (!binding || binding.appId !== localAppId) {
            binding = {
              schemaVersion: 1,
              appId: localAppId,
              contextVersion: snapshot.manifest.contextVersion,
              contentDigest: snapshot.manifest.contentDigest,
              boundAt: new Date().toISOString(),
            };
            if (featureProject) {
              updateProject(db, projectId, {
                metadata: metadataWithFeatureContextBinding(featureProject.metadata, binding),
              });
            }
          }
          const staged = await stageBoundAppContextForRun({
            projectsDir: PROJECTS_DIR,
            appId: localAppId,
            featureId: projectId,
            runId: `pipeline-${pipelineId}-${randomUUID()}`,
            ...(wfDir ? { workflowId: wfDir } : {}),
            runCwd: cwd,
            binding,
          });
          console.log(
            `[docs-comp] staged App Context ${binding.contextVersion} for ${projectId}: ${staged.stagedDesignSystem.length} Design System file(s)`,
          );
        }
        const { source: componentSource, appId: componentSourceAppId } = await resolveDocsReviewComponentSourceForProject(projectId);
        const modelPrefs = appConfig.agentModels?.[agentId] ?? {};
        // Figma Desktop drill-down (Figma-link mode only). Decided ONCE per
        // stage run, right after the catalogue is (re)built: when Figma
        // Desktop's local MCP server answers, every page run gets the
        // `/api/tools/figma/*` grant + a kickoff paragraph telling the agent
        // how to open a component; otherwise the kickoff says so and the
        // stage runs exactly like before (catalogue only). Never fatal.
        let figmaDesktopNote = '';
        let figmaDesktopGrant: { endpoints: readonly string[]; operations: readonly string[]; maxCalls: number } | null = null;
        let extractionTask: { id: string; title: string; status: 'queued' | 'running' | 'succeeded' | 'failed' } | null = null;

        // Figma-link mode has an explicit preparation phase. It runs before
        // the re-run clear and before `outerCwd` is armed, so a missing token,
        // an unreadable file, a timeout or an empty catalogue preserves the
        // previous `comp/` outputs and `criteria/components.md` intact. The
        // read is a deterministic REST call (figma-rest.ts) — no agent, no MCP,
        // no Figma Desktop involved — surfaced as one extra task row in the
        // Status modal ("Đọc component từ Figma · i/N") whose conversation
        // holds a short human-readable log.
        if (componentSource.mode === 'figma-links') {
          const figmaCfg = await readFigmaConfig(RUNTIME_DATA_DIR);
          if (!figmaCfg?.token) {
            const message = 'Chưa có token Figma. Mở Thông tin dự án → Nguồn đối chiếu component → dán Personal Access Token rồi chạy lại.';
            setProjectPipelineStatus(db, projectId, pipelineId, { status: 'failed', error: message, subConversations: [] });
            return 'failed' as const;
          }
          const links = componentSource.links;
          const conversationId = `pipeline-conv-${randomUUID()}`;
          const assistantMessageId = `pipeline-assistant-${randomUUID()}`;
          extractionTask = { id: conversationId, title: `Đọc component từ Figma · 0/${links.length}`, status: 'running' };
          insertConversation(db, {
            id: conversationId,
            projectId,
            title: `${def.name} · Đọc component từ Figma`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          const logLines: string[] = [];
          const extractionStartedAt = Date.now();
          const flushLog = (runStatus: 'running' | 'succeeded' | 'failed') => {
            upsertMessage(db, conversationId, {
              id: assistantMessageId,
              role: 'assistant',
              content: logLines.join('\n'),
              runStatus,
              startedAt: extractionStartedAt,
              ...(runStatus !== 'running' ? { endedAt: Date.now() } : {}),
            });
          };
          upsertMessage(db, conversationId, {
            id: `pipeline-user-${conversationId}`,
            role: 'user',
            content: `Đọc danh mục component từ ${links.length} file Figma qua REST API (token đã lưu):\n${links.map((link, index) => `${index + 1}. ${link.url}`).join('\n')}`,
          });
          flushLog('running');
          setProjectPipelineStatus(db, projectId, pipelineId, {
            status: 'running',
            lastConversationId: conversationId,
            subConversations: [{ ...extractionTask }],
          });
          const abort = new AbortController();
          const timeoutHandle = setTimeout(() => abort.abort(), FIGMA_CATALOG_EXTRACTION_TIMEOUT_MS);
          timeoutHandle.unref?.();
          let snapshot: Awaited<ReturnType<typeof buildFigmaComponentCatalog>> | null = null;
          let failure: string | null = null;
          try {
            snapshot = await Promise.race([
              buildFigmaComponentCatalog({
                token: figmaCfg.token,
                links,
                signal: abort.signal,
                onProgress: (progress) => {
                  if (abort.signal.aborted) return;
                  if (!extractionTask) return;
                  const done = progress.phase === 'done' ? progress.index : progress.index - 1;
                  extractionTask.title = `Đọc component từ Figma · ${done}/${progress.total}`;
                  if (progress.phase === 'summary') logLines.push(`File ${progress.index}/${progress.total}: đang đọc ${progress.fileKey}…`);
                  if (progress.phase === 'done') logLines.push(`File ${progress.index}/${progress.total}: “${progress.name ?? progress.fileKey}” — xong.`);
                  flushLog('running');
                  setProjectPipelineStatus(db, projectId, pipelineId, { subConversations: [{ ...extractionTask }] });
                },
              }),
              new Promise<never>((_, reject) => {
                abort.signal.addEventListener('abort', () => reject(new Error(`Đọc component từ Figma quá ${Math.round(FIGMA_CATALOG_EXTRACTION_TIMEOUT_MS / 60_000)} phút.`)), { once: true });
              }),
            ]);
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
          } finally {
            clearTimeout(timeoutHandle);
          }
          if (!snapshot) {
            extractionTask.status = 'failed';
            logLines.push(`Lỗi: ${failure ?? 'không rõ'}`, 'Kết quả cũ (nếu có) vẫn được giữ nguyên.');
            flushLog('failed');
            const message = `${failure ?? 'Không đọc được component từ Figma.'} Kết quả cũ vẫn được giữ nguyên.`;
            setProjectPipelineStatus(db, projectId, pipelineId, { status: 'failed', error: message, subConversations: [{ ...extractionTask }] });
            return 'failed' as const;
          }
          const criteriaDir = path.join(cwd, 'criteria');
          const catalogDir = path.join(cwd, '.figma-catalog');
          const nextComponents = path.join(criteriaDir, 'components.md.next');
          const nextCatalog = path.join(catalogDir, `components.${randomUUID()}.json.next`);
          await fs.promises.mkdir(criteriaDir, { recursive: true });
          await fs.promises.mkdir(catalogDir, { recursive: true });
          await fs.promises.writeFile(nextComponents, renderFigmaComponentsMarkdown(snapshot), 'utf8');
          await fs.promises.writeFile(nextCatalog, JSON.stringify(snapshot, null, 2), 'utf8');
          await replaceValidatedFile(nextComponents, path.join(criteriaDir, 'components.md'));
          await replaceValidatedFile(nextCatalog, path.join(catalogDir, 'components.json'));
          // Mirror to the App-level catalogue so the App's DS tab shows the
          // same snapshot this run used. Best-effort — the run has its copy.
          if (componentSourceAppId) {
            await writeAppFigmaCatalog(PROJECTS_DIR, componentSourceAppId, snapshot).catch((err) => {
              console.warn('[docs-comp] app-level figma catalogue write failed (continuing):', err?.message ?? err);
            });
          }
          const totalComponents = snapshot.files.reduce((sum, file) => sum + file.components.length, 0);
          extractionTask.status = 'succeeded';
          extractionTask.title = `Đọc component từ Figma · ${links.length}/${links.length}`;
          logLines.push(`Đã đóng băng ${totalComponents} component từ ${links.length} file vào criteria/components.md.`);

          // Figma Desktop drill-down: probe once, pre-warm the first file so
          // the first agent call doesn't pay the switch, and tell the user in
          // the same preparation log whether page runs will be able to open
          // components. Best-effort end to end — nothing here can fail the
          // stage, the catalogue above is already on disk.
          const desktopProbe = await figmaDesktop.probe().catch((err) => ({ ok: false as const, detail: String(err?.message ?? err) }));
          if (desktopProbe.ok) {
            const firstFile = snapshot.files[0];
            const firstComponent = firstFile?.components[0];
            let prewarm = '';
            if (firstFile) {
              try {
                const switched = await figmaDesktop.ensureActiveFile({
                  fileKey: firstFile.fileKey,
                  name: firstFile.name,
                  ...(firstComponent ? { probeNodeId: firstComponent.nodeId, probeName: firstComponent.name } : {}),
                });
                prewarm = switched === 'switched' ? ` Đã mở sẵn “${firstFile.name}”.` : ` Đang mở “${firstFile.name}”.`;
              } catch (err) {
                prewarm = ` Chưa mở được “${firstFile.name}” (${String(err?.message ?? err)}) — agent sẽ tự thử lại khi cần.`;
              }
            }
            figmaDesktopGrant = { endpoints: FIGMA_TOOL_ENDPOINTS, operations: FIGMA_TOOL_OPERATIONS, maxCalls: 8 };
            figmaDesktopNote =
              ` Figma Desktop đang chạy trên máy này: bạn CÓ THỂ mở component thật để đối chiếu bằng lệnh ` +
              `"$OD_NODE_BIN" "$OD_BIN" tools figma design-context --file <fileKey> --node <nodeId> ` +
              `(thêm lệnh "screenshot" cùng tham số để lấy ảnh — nó in ra đường dẫn PNG tương đối cwd, hãy Read ảnh đó; "variable-defs" để xem token/biến; "metadata" để xem cây con). ` +
              `fileKey và nodeId của từng component nằm trong ".figma-catalog/components.json" (mảng files[].components[].nodeId). ` +
              `Chỉ dùng khi map còn phân vân giữa 2+ component, hoặc để XÁC NHẬN một "variant-mismatch" trước khi kết luận; tối đa 8 lượt gọi cho trang này; ghi bằng chứng vào "note". ` +
              `Chỉ các file trong catalog được phép — lệnh trả FIGMA_FILE_DENIED / FIGMA_DESKTOP_UNAVAILABLE thì bỏ qua và phán theo catalog, đừng đoán.`;
            logLines.push(`Figma Desktop: sẵn sàng (Dev Mode MCP server).${prewarm} Agent sẽ được phép mở component trong ${links.length} file này để đối chiếu.`);
          } else {
            figmaDesktopNote =
              ` Figma Desktop KHÔNG sẵn sàng trên máy chạy daemon (${desktopProbe.detail ?? 'không kết nối được'}) — chỉ đối chiếu theo catalog, KHÔNG gọi lệnh "tools figma".`;
            logLines.push(`Figma Desktop: không sẵn sàng (${desktopProbe.detail ?? 'không kết nối được'}) — bước này chỉ đối chiếu theo catalog.`);
          }
          flushLog('succeeded');
          setProjectPipelineStatus(db, projectId, pipelineId, { subConversations: [{ ...extractionTask }] });
        }

        // From this point a failure belongs to the audit itself, so arm the
        // existing fail-shut cleanup and then clear the selected outputs.
        outerCwd = cwd;

        // Dọn thông báo "không chạy được" còn sót từ lần chạy TRƯỚC — nó nằm
        // ngang hàng comp/ nên cố tình không khớp outputs của stage nào, tức
        // re-run clear bên dưới không đụng tới nó; không xoá ở đây thì một lần
        // chạy THÀNH CÔNG sau đó vẫn để lại file báo lỗi cũ nằm cạnh báo cáo
        // mới.
        await fs.promises.rm(path.join(cwd, DOCS_COMPONENT_FAILURE_NOTE), { force: true }).catch(() => null);

        // ONE-TIME fence + re-run clear — cùng khuôn hai fan-out bên trên (các
        // lượt chạy trang song song TUYỆT ĐỐI không được mỗi cái làm một lần).
        const regenIds = new Set(stageRegenSet(pipelineId, resetScope === 'downstream'));
        await commitHistory(projectRoot, { kind: 'manual-edits', by: historyActor() }).catch(() => null);
        try {
          const snap = await snapshotPipelineCwd(projectRoot);
          for (const rel of snap.keys()) {
            // 'docs-review/criteria/…' không khớp outputs của stage nào
            // (stagesForOutput trả []), nên danh mục người dùng tải lên sống
            // sót qua mọi lần clear — nó là input, không phải output.
            if (relClearedByRegen(rel, regenIds, wfDir)) {
              await fs.promises.rm(path.join(projectRoot, rel), { force: true }).catch(() => null);
            }
          }
        } catch (error) {
          console.warn('[docs-comp] re-run clear failed (continuing):', error);
        }
        for (const id of regenIds) {
          if (id !== pipelineId) setProjectPipelineStatus(db, projectId, id, { status: 'idle' });
        }

        const pages = await listDocPages(cwd);
        outerPages = pages;
        if (pages.length === 0) {
          // Không có trang nào — input hỏng (bước nạp tài liệu chưa chạy),
          // KHÔNG phải "không có gì để làm". FAIL-SHUT: dùng primitive chung để
          // xoá sạch comp/ (có thể còn sót từ lần trước) và ghi lời giải thích
          // ra file ngang hàng.
          await writeDocsComponentFailureNote(
            cwd,
            [
              '# Màn hình → Component — không chạy được',
              '',
              'Không tìm thấy trang tài liệu nào dưới `docs/` nên không có gì để mô tả màn hình.',
              '',
              'Chạy bước **Tài liệu → Markdown** trước, rồi chạy lại bước này.',
              '',
            ].join('\n'),
          );
          setProjectPipelineStatus(db, projectId, pipelineId, {
            status: 'failed',
            subConversations: [],
            error: 'Không tìm thấy trang tài liệu nào dưới docs/ — chạy bước Tài liệu → Markdown trước, rồi chạy lại bước này.',
          });
          console.warn(`[docs-comp] no doc pages under ${cwd}/docs — nothing to do`);
          return 'failed' as const;
        }

        // DANH MỤC đọc MỘT LẦN cho cả stage: input CHUNG, không đổi giữa các
        // lượt. Thiếu file => Map rỗng — KHÔNG phải lỗi: validate bỏ qua phần
        // đối chiếu danh mục và kickoff bảo agent để "ds": null.
        const catalogText = await fs.promises
          .readFile(path.join(cwd, 'criteria/components.md'), 'utf8')
          .catch(() => null);
        const catalog = catalogText != null ? collectComponentCatalog(catalogText) : new Map<string, string>();

        // v2 (2026-08-18): ĐƠN VỊ FAN-OUT LÀ MÀN HÌNH lấy từ bước Đánh giá
        // luồng UX (flows/index.json[].screens), KHÔNG còn là trang tài liệu:
        // bảng "Kiểu hiển thị" (nếu có) chỉ là tham khảo, và ảnh mockup không
        // phải đầu vào. Daemon dựng comp/_inputs.json (màn nào, thuộc trang
        // nào, mục nào, bước flow nào diễn ra trên đó, đi ra màn nào) rồi:
        //   lượt 0 — role-map cho cả feature (comp/_role-map.json) để các
        //            màn map component nhất quán;
        //   lượt theo màn (song song) — comp/<KEY>.screen.json +
        //            wireframes/<KEY>.html.
        const inputs = await prepareScreenComponentInputs(cwd, { pages });
        const screenInputs = inputs.screens;
        outerScreenKeys = screenInputs.map((s) => s.key);
        console.log(
          `[docs-comp] ${screenInputs.length} màn hình từ flows/ · danh mục: ${catalogText != null ? `${catalog.size} component` : 'KHÔNG có criteria/components.md'}`,
        );
        if (screenInputs.length === 0) {
          await writeDocsComponentFailureNote(
            cwd,
            [
              '# Màn hình → Component — không chạy được',
              '',
              inputs.note ?? 'Bước Đánh giá luồng UX chưa cho ra màn hình nào.',
              '',
              'Chạy bước **Đánh giá luồng UX** (dr-flow) trước — bước này lấy danh sách màn hình từ đó — rồi chạy lại.',
              '',
            ].join('\n'),
          );
          setProjectPipelineStatus(db, projectId, pipelineId, {
            status: 'failed',
            subConversations: [],
            error: inputs.note ?? 'Bước Đánh giá luồng UX chưa cho ra màn hình nào — chạy dr-flow trước.',
          });
          return 'failed' as const;
        }
        const screenKeySet = new Set(screenInputs.map((s) => s.key));

        // Wireframe: mỗi màn một `wireframes/<SCREEN-KEY>.html` do agent viết
        // theo đúng hợp đồng của skill ux-spec (HTML tự chứa, bố cục thật,
        // data-comp = anchor DS, data-nav = SCREEN-KEY đích). CSS dùng chung
        // chép MỘT LẦN cho cả stage vào `wireframes/_wireframe.css`.
        const wireframesDir = path.join(cwd, 'wireframes');
        await fs.promises.mkdir(wireframesDir, { recursive: true });
        const wireframeCssRel = 'wireframes/_wireframe.css';
        const wireframeCssOk = await fs.promises
          .copyFile(path.join(SKILLS_DIR, 'ux-spec', 'assets', 'wireframe.css'), path.join(cwd, wireframeCssRel))
          .then(() => true)
          .catch((err) => {
            console.warn('[docs-comp] wireframe.css copy failed (continuing):', err?.message ?? err);
            return false;
          });

        const dsLine =
          catalogText != null
            ? ` Design System: danh mục component hợp lệ (ĐÓNG) tại "criteria/components.md" (${catalog.size} component)` +
              `${inputs.ds.catalog ? ', kiến thức chọn component ("Dùng khi / Không dùng khi", bảng Screen scaffolding) tại "criteria/catalog.md"' : ''}` +
              `${inputs.ds.examples ? ', cách lồng component thật tại "criteria/examples.md"' : ''}` +
              `${inputs.ds.rules ? ', quy tắc DS tại "criteria/rules.md"' : ''}` +
              `${inputs.ds.figmaCatalog ? ', fileKey/nodeId Figma tại ".figma-catalog/components.json"' : ''}. ` +
              `Mọi "component"/"anchor"/data-comp phải là tên và anchor CÓ THẬT trong "criteria/components.md": chép tên NGUYÊN VĂN từ heading "### \`#anchor\` Tên" (kể cả hậu tố " — [File] (id)" khi danh mục có nhiều mục cùng tên) và anchor đúng của mục đó — daemon đối chiếu; component không có trong danh mục bị hạ về null kèm cảnh báo.`
            : ` KHÔNG có "criteria/components.md" trong cwd này: vẫn liệt kê element theo vai trò (role) và vẽ wireframe, NHƯNG mọi "component" trong role-map và "ds" của element phải là null, wireframe KHÔNG có data-comp.`;
        const flowLine =
          ` Danh sách màn hình + ngữ cảnh từng màn (trang, mục tài liệu, bước luồng diễn ra trên màn, đi ra màn nào, phát hiện UX) nằm ở "${SCREEN_INPUTS_FILE}" — đọc nó trước.` +
          ` Ảnh mockup trong tài liệu CHỈ là minh hoạ của người viết — KHÔNG mở, KHÔNG dùng để chọn component hay bố cục; bảng cấu trúc màn (nếu có, trường "referenceTable") chỉ để tham khảo tên trường.`;
        const graphNote = ' This is a FILE-ONLY stage — do not push anything anywhere.';

        // ── Lượt 0: role-map cho cả feature ─────────────────────────────────
        const roleMapConvId = `pipeline-conv-${randomUUID()}`;
        // Tiêu đề nói rõ đây là LƯỢT CHẠY TRƯỚC: modal Status ghi "các tác vụ
        // chạy song song" nên người xem thấy 1 chạy + N chờ dễ tưởng fan-out
        // hỏng — thực ra các màn chỉ chạy song song SAU khi role-map xong.
        const roleMapTitle = 'Lượt 0 · Bảng vai trò → component DS (chạy trước, các màn chạy song song sau)';
        insertConversation(db, { id: roleMapConvId, projectId, title: `${def.name} · ${roleMapTitle}`, createdAt: Date.now(), updatedAt: Date.now() });
        const roleMapTask = { id: roleMapConvId, title: roleMapTitle, status: 'running' as 'queued' | 'running' | 'succeeded' | 'failed' };
        const screenTasks = screenInputs.map((s) => {
          const id = `pipeline-conv-${randomUUID()}`;
          insertConversation(db, { id, projectId, title: `${def.name} · ${s.name}`, createdAt: Date.now(), updatedAt: Date.now() });
          return { id, title: s.name, status: 'queued' as 'queued' | 'running' | 'succeeded' | 'failed' };
        });
        const tasks = extractionTask ? [extractionTask, roleMapTask, ...screenTasks] : [roleMapTask, ...screenTasks];
        const persistTasks = () =>
          setProjectPipelineStatus(db, projectId, pipelineId, { subConversations: tasks.map((t) => ({ ...t })) });
        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'running', lastConversationId: roleMapConvId });
        persistTasks();

        const platformCounts = screenInputs.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.platformHint]: (acc[s.platformHint] ?? 0) + 1 }), {});
        const platformGuess = (platformCounts.mobile ?? 0) > (platformCounts.web ?? 0) ? 'mobile' : 'web';
        const roleMapKickoff =
          `Run the "docs-screen-components" skill in ROLE-MAP mode for feature "${projectId}" (lượt 0 của bước Màn hình → Component).` +
          flowLine +
          dsLine +
          ` Nền tảng đoán từ tài liệu: "${platformGuess}" — tự xác nhận lại theo tài liệu.` +
          ` Nhiệm vụ: đọc "${SCREEN_INPUTS_FILE}" (mọi màn: tên, bước, mục tài liệu) và Design System, rồi ghi ĐÚNG MỘT file "${ROLE_MAP_FILE}": bảng map VAI TRÒ giao diện (app bar, list item, CTA đáy, input, select, bottom sheet, badge, empty state, error state, tab, card, table…) → component DS (tên + anchor + biến thể mặc định + khi nào dùng), phủ đủ mọi vai trò mà các màn trong feature này sẽ cần; DS không có vai trò nào thì "component": null kèm "fallback". ` +
          `Schema và luật trong skill (mục "Chế độ ROLE-MAP"). KHÔNG ghi file nào khác, KHÔNG vẽ wireframe ở lượt này.${graphNote}`;
        const roleMapAssistantId = `pipeline-assistant-${randomUUID()}`;
        const roleMapRun = design.runs.create({
          projectId,
          conversationId: roleMapConvId,
          assistantMessageId: roleMapAssistantId,
          clientRequestId: `docs-comp-rolemap-${randomUUID()}`,
          agentId: agentId!,
        });
        activeRuns.add(roleMapRun);
        upsertMessage(db, roleMapConvId, { id: `pipeline-user-${roleMapRun.id}`, role: 'user', content: roleMapKickoff });
        upsertMessage(db, roleMapConvId, {
          id: roleMapAssistantId,
          role: 'assistant',
          content: '',
          agentId: agentId!,
          agentName: getAgentDef(agentId!)?.name ?? agentId!,
          runId: roleMapRun.id,
          runStatus: 'queued',
          startedAt: Date.now(),
        });
        design.runs.start(roleMapRun, () =>
          startChatRun(
            {
              agentId: agentId!,
              projectId,
              conversationId: roleMapConvId,
              assistantMessageId: roleMapAssistantId,
              clientRequestId: roleMapRun.clientRequestId,
              skillId: def.skillId,
              ...(wfDir ? { cwdSubdir: wfDir } : {}),
              model: modelPrefs.model ?? null,
              reasoning: modelPrefs.reasoning ?? null,
              message: roleMapKickoff,
              promptProfile: 'pipeline',
              pipelineUsesDesignSystem: def.acceptsDesignSystem === true,
              ...(figmaDesktopGrant ? { [INTERNAL_TOOL_GRANT_EXTRAS]: figmaDesktopGrant } : {}),
            },
            roleMapRun,
          ),
        );
        const roleMapFinal = await design.runs.wait(roleMapRun);
        activeRuns.delete(roleMapRun);
        db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`).run(roleMapFinal.status, Date.now(), roleMapAssistantId);
        const roleMapErrors: string[] = [];
        if (roleMapFinal.status !== 'succeeded') roleMapErrors.push(`Lượt role-map kết thúc với trạng thái "${roleMapFinal.status}".`);
        let roleMap: RoleMapDoc | null = null;
        if (roleMapErrors.length === 0) {
          const raw = await fs.promises.readFile(path.join(cwd, ROLE_MAP_FILE), 'utf8').catch(() => null);
          if (raw == null) roleMapErrors.push(`Không tìm thấy "${ROLE_MAP_FILE}" — lượt role-map báo thành công nhưng không ghi gì.`);
          else {
            const parsed = parseRoleMap(raw);
            if ('errors' in parsed) roleMapErrors.push(...parsed.errors);
            else {
              // KHOAN DUNG: tên component lệch danh mục (agent viết "Heading"
              // trong khi danh mục ghi "Heading — [SDK] Web Lib (Slot) (…)")
              // được đối chiếu theo anchor / tên gốc; không khớp thì hạ vai
              // trò đó về null + ghi warning, KHÔNG đánh hỏng cả stage vì một
              // dòng — người dùng còn có gì để xem và sửa.
              const norm = normalizeRoleMap(parsed.doc, catalog);
              roleMapErrors.push(...norm.errors);
              if (roleMapErrors.length === 0) {
                roleMap = norm.doc;
                if (norm.warnings.length) {
                  console.warn(`[docs-comp] role-map: ${norm.warnings.length} chỗ được chuẩn hoá:`, norm.warnings);
                  await fs.promises.writeFile(path.join(cwd, ROLE_MAP_FILE), JSON.stringify(roleMap, null, 2), 'utf8').catch(() => null);
                }
              }
            }
          }
        }
        if (!roleMap) {
          roleMapTask.status = 'failed';
          for (const t of screenTasks) t.status = 'failed';
          if (canceled || roleMapFinal.status === 'canceled') {
            await fs.promises.rm(path.join(cwd, 'comp'), { recursive: true, force: true }).catch(() => null);
            await fs.promises.rm(wireframesDir, { recursive: true, force: true }).catch(() => null);
            setProjectPipelineStatus(db, projectId, pipelineId, { status: 'idle', subConversations: tasks.map((t) => ({ ...t })) });
            console.log('[docs-comp] canceled during role-map');
            return 'idle' as const;
          }
          // FAIL-SHUT: không role-map thì không màn nào chạy được — xoá sạch
          // comp/ + wireframes/, ghi lý do ra file ngang hàng.
          await writeDocsComponentFailureNote(
            cwd,
            ['# Màn hình → Component — không chạy được', '', 'Lượt lập bảng map vai trò → component DS hỏng:', '', ...roleMapErrors.map((e) => `- ${e}`), ''].join('\n'),
          );
          await fs.promises.rm(wireframesDir, { recursive: true, force: true }).catch(() => null);
          setProjectPipelineStatus(db, projectId, pipelineId, {
            status: 'failed',
            subConversations: tasks.map((t) => ({ ...t })),
            error: `Bảng map vai trò → component DS hỏng: ${roleMapErrors[0] ?? 'không rõ'}`,
          });
          console.warn('[docs-comp] role-map failed:', roleMapErrors);
          return 'failed' as const;
        }
        roleMapTask.status = 'succeeded';
        persistTasks();
        console.log(`[docs-comp] role-map: ${roleMap.roles.length} vai trò (${roleMap.platform})`);

        // ── Fan-out theo màn ────────────────────────────────────────────────
        const results: Array<CompScreenResult | undefined> = new Array(screenInputs.length);
        outerResults = results;
        let done = 0;
        const cssLine = wireframeCssOk
          ? `một thẻ <style> chép NGUYÊN VĂN nội dung "${wireframeCssRel}" (Read nó rồi dán vào; thêm rule layout của riêng màn phía dưới), `
          : `một thẻ <style> tự viết vài rule tối thiểu cho .wf-web/.wf-mobile/.wf-card/.wf-component (khung xám, viền 1px, padding 16px — "${wireframeCssRel}" không copy được lần này), `;

        const runOneScreen = async (s: (typeof screenInputs)[number], idx: number): Promise<'succeeded' | 'failed' | 'idle'> => {
          const task = screenTasks[idx]!;
          const conversationId = task.id;
          task.status = 'running';
          persistTasks();
          const outRel = screenDocRel(s.key);
          const wfRel = wireframeRel(s.key);
          const assistantMessageId = `pipeline-assistant-${randomUUID()}`;
          const sectionLine = s.section
            ? ` Mục tài liệu mô tả màn: "${s.source}" dòng ${s.section.startLine}–${s.section.endLine} (heading: ${JSON.stringify(s.section.heading)}) — Read đúng khoảng dòng đó (và các mục lân cận nếu cần).`
            : s.source
              ? ` Không tìm thấy mục riêng cho màn này trong "${s.source}" — đọc trang đó và tìm theo tên màn; không có thì dựng từ các bước luồng.`
              : ' Không xác định được trang tài liệu của màn — dựng từ các bước luồng và tên màn.';
          const navLine = s.navOut.length
            ? ` Từ màn này đi sang: ${s.navOut.map((n) => `"${n.to}" (qua "${n.via}"${n.condition ? `, điều kiện ${JSON.stringify(n.condition)}` : ''})`).join('; ')} — mỗi lối đi là MỘT element có data-nav tương ứng.`
            : ' Màn này không đi sang màn nào khác trong luồng — không dùng data-nav.';
          const kickoff =
            `Run the "docs-screen-components" skill in SCREEN mode for ONE screen of feature "${projectId}": SCREEN-KEY "${s.key}" — "${s.name}" (luồng "${s.flowTitle}", thứ tự ${s.order + 1}/${screenInputs.length}).` +
            flowLine +
            dsLine +
            ` Bảng map vai trò → component DS của feature đã chốt ở "${ROLE_MAP_FILE}" (nền tảng: ${roleMap.platform}) — BẮT BUỘC dùng đúng bảng đó; lệch phải ghi "why".` +
            sectionLine +
            navLine +
            ` Ghi ĐÚNG HAI file: (1) "${outRel}" theo schema "Chế độ SCREEN" trong skill (mọi element có "id" ổn định, "role", "ds" {component, anchor, variant?} hoặc null, "confidence", "provenance" text|flow|table|ds, "docType" nếu bảng tài liệu có khai, "why" khi cần; "nav": [{el, to}] cho các lối đi kể trên; "platform" = "${roleMap.platform}"); ` +
            `(2) "${wfRel}" — wireframe HTML tự chứa kiểu ux-spec: "<!doctype html>", ${cssLine}không <script>/<link>/ảnh; <body data-screen="${s.key}" data-layout="${roleMap.platform}">; DOM là bố cục THẬT của màn (header–thân–chân, hàng/cột, card lồng nhau theo criteria/examples.md), MỖI element trong JSON là một block mang data-el="<id>" (bắt buộc) + data-comp="<anchor>" khi có ds + data-nav="<SCREEN-KEY đích>" đúng như "nav"; text trong block = nhãn thật của element; không màu thương hiệu, không icon, không nội dung mẫu dài. ` +
            `Không ghi file nào khác (không sửa flows/, docs/, criteria/, "${wireframeCssRel}", không tự ghi comp/index.json).${graphNote}${figmaDesktopNote}`;

          const run = design.runs.create({
            projectId,
            conversationId,
            assistantMessageId,
            clientRequestId: `docs-comp-${s.key}-${randomUUID()}`,
            agentId: agentId!,
          });
          activeRuns.add(run);
          upsertMessage(db, conversationId, { id: `pipeline-user-${run.id}`, role: 'user', content: kickoff });
          upsertMessage(db, conversationId, {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            agentId: agentId!,
            agentName: getAgentDef(agentId!)?.name ?? agentId!,
            runId: run.id,
            runStatus: 'queued',
            startedAt: Date.now(),
          });
          design.runs.start(run, () =>
            startChatRun(
              {
                agentId: agentId!,
                projectId,
                conversationId,
                assistantMessageId,
                clientRequestId: run.clientRequestId,
                skillId: def.skillId,
                ...(wfDir ? { cwdSubdir: wfDir } : {}),
                model: modelPrefs.model ?? null,
                reasoning: modelPrefs.reasoning ?? null,
                message: kickoff,
                promptProfile: 'pipeline',
                pipelineUsesDesignSystem: def.acceptsDesignSystem === true,
                ...(figmaDesktopGrant ? { [INTERNAL_TOOL_GRANT_EXTRAS]: figmaDesktopGrant } : {}),
              },
              run,
            ),
          );
          const final = await design.runs.wait(run);
          activeRuns.delete(run);
          db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`).run(final.status, Date.now(), assistantMessageId);

          const errors: string[] = [];
          const sawCancel = final.status === 'canceled';
          if (final.status !== 'succeeded') errors.push(`Agent run kết thúc với trạng thái "${final.status}".`);
          let doc: ScreenComponentsDoc | null = null;
          if (errors.length === 0) {
            const raw = await fs.promises.readFile(path.join(cwd, outRel), 'utf8').catch(() => null);
            if (raw == null) errors.push(`Không tìm thấy "${outRel}" — lượt chạy báo thành công nhưng không ghi gì.`);
            else {
              const parsed = parseScreenComponentsDoc(raw);
              if ('errors' in parsed) errors.push(...parsed.errors);
              else {
                const wireframeHtml = await fs.promises.readFile(path.join(cwd, wfRel), 'utf8').catch(() => null);
                // Cùng tinh thần khoan dung như role-map: chỉ key sai / thiếu
                // wireframe / có <script> mới là lỗi cứng; component lạ → ds
                // null + why, data-comp/data-nav lạ → daemon gỡ, doctype /
                // data-screen / data-layout → daemon sửa, tất cả ghi vào
                // `warnings` để hiện trong panel.
                const norm = normalizeScreenComponentsDoc(parsed.doc, { expectedKey: s.key, screenKeys: screenKeySet, catalog, wireframeHtml });
                errors.push(...norm.errors);
                if (errors.length === 0) {
                  // key/name/flowId/source là siêu dữ liệu daemon TỰ BIẾT — ghi
                  // đè để index không lệch chỉ vì agent gõ lại.
                  doc = { ...norm.doc, key: s.key, name: s.name, flowId: s.flowId, source: s.source };
                  await fs.promises.writeFile(path.join(cwd, outRel), JSON.stringify(doc, null, 2), 'utf8');
                  if (norm.wireframeHtml != null && norm.wireframeHtml !== wireframeHtml) {
                    await fs.promises.writeFile(path.join(cwd, wfRel), norm.wireframeHtml, 'utf8');
                  }
                  if (norm.warnings.length) console.warn(`[docs-comp] screen "${s.name}": ${norm.warnings.length} chỗ được chuẩn hoá:`, norm.warnings);
                }
              }
            }
          }
          const status: 'succeeded' | 'failed' = doc != null ? 'succeeded' : 'failed';
          if (status === 'failed') {
            // FAIL-SHUT cấp MÀN: file của màn chưa đạt không được nằm lại.
            await fs.promises.rm(path.join(cwd, outRel), { force: true }).catch(() => null);
            await fs.promises.rm(path.join(cwd, wfRel), { force: true }).catch(() => null);
          }
          results[idx] = { key: s.key, name: s.name, doc, status, errors };
          task.status = status;
          persistTasks();
          done += 1;
          console.log(`[docs-comp] screen ${done}/${screenInputs.length} "${s.name}" → ${status}${errors.length > 0 ? ` (${errors.length} lỗi)` : ''}`);
          return status === 'succeeded' ? 'succeeded' : sawCancel ? 'idle' : 'failed';
        };

        let cursor = 0;
        const worker = async () => {
          for (;;) {
            if (canceled) break;
            const i = cursor++;
            if (i >= screenInputs.length) break;
            await runOneScreen(screenInputs[i]!, i).catch(async () => {
              screenTasks[i]!.status = 'failed';
              await fs.promises.rm(path.join(cwd, screenDocRel(screenInputs[i]!.key)), { force: true }).catch(() => null);
              await fs.promises.rm(path.join(cwd, wireframeRel(screenInputs[i]!.key)), { force: true }).catch(() => null);
              results[i] = { key: screenInputs[i]!.key, name: screenInputs[i]!.name, doc: null, status: 'failed', errors: ['Lỗi không rõ khi chạy màn này.'] };
              persistTasks();
              return 'failed' as const;
            });
          }
        };
        await Promise.all(Array.from({ length: Math.min(DOCS_COMPONENT_FANOUT_CONCURRENCY, screenInputs.length) }, worker));

        if (canceled) {
          await Promise.all(
            screenInputs.map((s, i) =>
              results[i]?.status === 'succeeded'
                ? Promise.resolve(null)
                : Promise.all([
                    fs.promises.rm(path.join(cwd, screenDocRel(s.key)), { force: true }).catch(() => null),
                    fs.promises.rm(path.join(cwd, wireframeRel(s.key)), { force: true }).catch(() => null),
                  ]),
            ),
          );
          if (!results.some((r) => r?.status === 'succeeded')) {
            await fs.promises.rm(path.join(cwd, 'comp'), { recursive: true, force: true }).catch(() => null);
            await fs.promises.rm(wireframesDir, { recursive: true, force: true }).catch(() => null);
          }
          setProjectPipelineStatus(db, projectId, pipelineId, { status: 'idle', subConversations: tasks.map((t) => ({ ...t })) });
          console.log('[docs-comp] fan-out canceled by user');
          return 'idle' as const;
        }

        // Gộp: daemon làm, không LLM. Chỉ màn ĐẠT vào index; màn hỏng liệt kê
        // kèm lý do để còn sửa.
        const okDocs = results.flatMap((r) => (r?.doc ? [r.doc] : []));
        const failedScreens = results.filter((r): r is CompScreenResult => r?.status === 'failed').map((r) => ({ key: r.key, name: r.name, errors: r.errors }));
        const { index, summaryMd } = mergeScreenComponents(okDocs, inputs, failedScreens, new Date().toISOString());
        const anySucceeded = okDocs.length > 0;
        const next: 'succeeded' | 'failed' = anySucceeded ? 'succeeded' : 'failed';
        if (anySucceeded) {
          await fs.promises.writeFile(path.join(cwd, 'comp/index.json'), JSON.stringify(index, null, 2), 'utf8');
          await fs.promises.writeFile(path.join(cwd, 'comp/summary.md'), summaryMd, 'utf8');
        } else {
          await writeDocsComponentFailureNote(cwd, summaryMd);
          await fs.promises.rm(wireframesDir, { recursive: true, force: true }).catch(() => null);
        }
        // Same as docs-review: name the per-screen reasons (the sub-
        // conversations can be green when validation rejected every screen)
        // and hand them to the error report.
        const failureDetail = next === 'failed' ? fanoutFailureDetail(failedScreens.map((f) => ({ name: f.name || f.key, errors: f.errors ?? [] }))) : null;
        if (failureDetail) {
          attachStageFailureContext(projectId, pipelineId, {
            agentId,
            model: modelPrefs.model ?? null,
            reasoning: modelPrefs.reasoning ?? null,
            outputs: `docs-comp: 0/${screenInputs.length} màn đạt (validation sau fan-out)\n${failureDetail.list}`,
            finalStatus: 'failed',
            workflowId: wfDir,
          });
        }
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: next,
          subConversations: tasks.map((t) => ({ ...t })),
          ...(failureDetail ? { error: `Không màn nào đạt kiểm tra sau khi rà soát (${screenInputs.length} màn) — ${failureDetail.first}` } : {}),
        });
        void commitHistory(projectRoot, { kind: 'run', pipelineId, status: next, by: historyActor() }).catch(() => null);
        console.log(`[docs-comp] fan-out done: ${okDocs.length}/${screenInputs.length} screens → ${next}`);
        if (failureDetail) console.warn(`[docs-comp] every screen failed validation:\n${failureDetail.list}`);
        return next;
      } catch (error) {
        // FAIL-SHUT ở OUTER catch — dọn output của mọi màn chưa đạt; không màn
        // nào đạt thì xoá sạch comp/ + wireframes/. Dọn hỏng thì PHẢI kêu to.
        if (outerCwd) {
          const cwd = outerCwd;
          await Promise.all(
            outerScreenKeys.map((key, i) =>
              outerResults[i]?.status === 'succeeded'
                ? Promise.resolve(null)
                : Promise.all([
                    fs.promises.rm(path.join(cwd, screenDocRel(key)), { force: true }),
                    fs.promises.rm(path.join(cwd, wireframeRel(key)), { force: true }),
                  ]),
            ),
          ).catch((cleanupError) =>
            console.error('[docs-comp] FAIL-SHUT hỏng: không xoá được output của màn chưa thành công — stage có thể hiện xanh sai:', cleanupError),
          );
          if (!outerResults.some((r) => r?.status === 'succeeded')) {
            await fs.promises
              .rm(path.join(cwd, 'comp'), { recursive: true, force: true })
              .catch((cleanupError) => console.error(`[docs-comp] FAIL-SHUT hỏng: không xoá được ${path.join(cwd, 'comp')}:`, cleanupError));
            await fs.promises
              .rm(path.join(cwd, 'wireframes'), { recursive: true, force: true })
              .catch((cleanupError) => console.error(`[docs-comp] FAIL-SHUT hỏng: không xoá được ${path.join(cwd, 'wireframes')}:`, cleanupError));
          }
        }
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: 'failed',
          error: String(error?.message ?? error),
        });
        console.warn('[docs-comp] fan-out failed:', error);
        return 'failed' as const;
      } finally {
        pipelineCancelers.delete(cancelKey);
      }
    })();
    return { projectId, completion };
  };

  // Docs → Review tài liệu runs PER SECTION, with one deterministic step ahead
  // of the agents: the daemon clones every ingested page into
  // review/docs/<same path> BEFORE any agent runs (cloneDocsForReview — no LLM
  // needed), so each run only ever Edits an existing file, never Writes a fresh
  // one.
  //
  // FAN-OUT UNIT + SCHEDULE (changed from per-PAGE): each page is split by
  // markdown heading (splitSections, docs-review.ts) and EACH SECTION is its
  // own conversation/agent run. Sections of the SAME page run SEQUENTIALLY —
  // they all Edit the ONE shared clone of that page, and two agents editing one
  // file at once corrupts it. PAGES run in parallel, bounded by
  // DOCS_REVIEW_FANOUT_CONCURRENCY (the pool below is a pool over PAGES; each
  // worker loops that page's sections in order). Cutting smaller is about
  // reducing one run's attention load, NOT about speed: measured on a real
  // 584-line URD, one run per page silently skipped the empty-heading sections
  // (`bodyLines === 0`) that were the document's biggest gaps.
  //
  // VALIDATION is still ONE gate per PAGE, after every section of that page has
  // finished, over the UNION of all sections' declared changes/notes: first the
  // banned-annotation check (findReviewMarkers — "[Rà soát …]" inserted into
  // the clone fails the page outright, because that was the agent's way of
  // faking an editable anchor for an architectural remark and it broke the
  // document's markdown tables), then shape (parseChangesFile/parseNotesFile —
  // runtime schema checks; `as DocChange[]` alone checks nothing at runtime),
  // then content (validateChanges — line-multiset + quote check, no diff/LCS;
  // validateNotes — anchor-exists only, notes edit nothing so there is no line
  // to attribute), then rule_id syntax (validateRuleIds against the anchors
  // collected once per stage from criteria/*.md). Deliberately NOT relaxed to
  // per-section failure: a page is one clone, so half-validated sections would
  // leave a half-reviewed clone that mergePipelineState reads as "reviewed".
  // ONE section declaring badly fails the WHOLE page.
  //
  // FAIL-SHUT INVARIANT (not a checklist — hold this at EVERY return of
  // runDocsReviewFanout's completion promise, whichever path it returns
  // through): no file under review/docs/ may belong to a page that has not
  // been CONFIRMED successful (every section's run succeeded + changes/notes
  // parsed to a valid shape + no banned marker + validateChanges/validateNotes/
  // validateRuleIds returned no errors). This is load-bearing, not cosmetic:
  // stage status is derived from files on disk
  // (mergePipelineState lets a file signal win over DB state), so a stale
  // clone left behind by a crashed, exception-aborted, or canceled run would
  // read as "reviewed" from disk alone — the UI would show the stage green
  // while the document was never actually reviewed, and a user opening it
  // would see the untouched original and wrongly conclude the AI found
  // nothing to fix. Every exit path below upholds it:
  //   - a single page's validate/parse failure (inline, below) →
  //     removePageOutputs for that one page;
  //   - a worker's .catch (a page's run threw before it could fail-shut
  //     itself) → removePageOutputs for that one page;
  //   - the cancel branch → removePageOutputs for every not-yet-succeeded
  //     page, plus a full review/ wipe if NO page succeeded;
  //   - the OUTER catch (the whole stage throwing AFTER the clone was
  //     already staged — e.g. insertConversation throwing, disk full writing
  //     index.json/summary.md) → same as cancel: removePageOutputs for every
  //     page not-yet-succeeded (tracked via the `outerCwd`/`outerPages`/
  //     `outerResults` mirrors below, since `cwd`/`pages`/`results` are
  //     block-scoped to the try and unreachable from catch), plus a full
  //     review/ wipe if none succeeded.
  // removePageOutputs is the ONE place the per-page delete is implemented —
  // every exit path calls it instead of re-deleting inline. It also deletes the
  // per-section temp files (`<clone>.s<NN>.changes.json` / `.notes.json`) by
  // LISTING the clone's directory and filtering on the file-name prefix, never
  // by guessing how many sections there were — a run that died mid-way has an
  // unpredictable number of them, and any one left under review/ is enough to
  // paint the stage green. A page whose run fails never fails the whole
  // stage — the rest still ship, exactly like PRD review.
  //
  // STAGE-LEVEL INVARIANT (stronger — covers the whole completion promise,
  // not just review/docs/): whenever this function returns anything OTHER
  // THAN 'succeeded' AND NO page was confirmed successful, NOTHING may be
  // left under review/ at all — not review/docs/, but also review/index.json
  // and review/summary.md. The per-page invariant above is necessary but not
  // sufficient: `stagesForOutput`/`mergePipelineState` (pipelines.ts) derive
  // a stage's status from ANY file under its declared `outputs` (`['review/']`
  // for dr-review) matching — that disk signal WINS over the DB status this
  // function just wrote. A stage that just wrote 'failed' to the DB but left
  // review/index.json or review/summary.md behind still reads as
  // 'succeeded' from disk alone: the UI shows the stage green, the user
  // opens it, sees a document identical to the original (or a report saying
  // the run couldn't even start), and wrongly concludes the AI reviewed it
  // and found nothing to fix. `writeDocsReviewFailureNote` (docs-review.ts)
  // is the ONE shared primitive for this: it wipes review/ completely and
  // redirects any explanatory text to `<cwd>/review-khong-chay-duoc.md` — a
  // path deliberately NOT under review/, so it never matches dr-review's
  // outputs and never lights the stage. Exit paths that must call it (or
  // already satisfy the invariant by construction):
  //   - the no-pages branch (cloneDocsForReview found nothing to review) →
  //     writeDocsReviewFailureNote instead of writing into review/ directly;
  //   - the post-merge 'failed' branch (every page failed, anySucceeded is
  //     false) → writeDocsReviewFailureNote instead of unconditionally
  //     writing review/index.json + review/summary.md;
  //   - the cancel branch and the OUTER catch already satisfy this by
  //     construction: both write review/index.json/summary.md ONLY later,
  //     after their own check, and both already wipe review/ entirely when
  //     no page succeeded (see their comments above) — no index.json/
  //     summary.md exists yet at the point they wipe, so there is nothing
  //     extra to delete.
  //
  // criteria/ IS READ HERE (readCriteriaAnchors below) — the first place the
  // daemon reads that folder rather than just naming it in a prompt. It stays
  // OUT of every stage's declared outputs (stagesForOutput('docs-review/
  // criteria/…') returns []), so it survives every re-run clear: it is user
  // input, not stage output.
  const DOCS_REVIEW_FANOUT_CONCURRENCY = 4;

  /** Semaphore DÙNG CHUNG cho mọi lượt chạy section của cả stage.
   *
   *  Vì sao cần: từ khi mỗi section có lát cắt riêng, section của cùng một
   *  trang chạy song song được — nhưng pool ngoài cũng đang chạy tới 4 TRANG
   *  cùng lúc, nên nếu mỗi trang tự do mở 4 section thì có 16 agent cùng chạy.
   *  Trần thật sự người dùng thấy phải là 4, và nó phải được đếm ở MỘT chỗ duy
   *  nhất cho cả stage chứ không phải mỗi trang một quota riêng.
   *
   *  Với một trang nhiều section (ca phổ biến: URD 1 trang, 9 section) thì
   *  trang đó một mình dùng hết 4 slot — đúng thứ trước đây không làm được, vì
   *  các section phải xếp hàng chờ nhau trên một file clone chung. */
  const sectionSlots = (() => {
    let inFlight = 0;
    const waiting: Array<() => void> = [];
    const release = () => {
      inFlight -= 1;
      waiting.shift()?.();
    };
    return {
      async run<T>(fn: () => Promise<T>): Promise<T> {
        if (inFlight >= DOCS_REVIEW_FANOUT_CONCURRENCY) {
          await new Promise<void>((resolve) => waiting.push(resolve));
        }
        inFlight += 1;
        try {
          return await fn();
        } finally {
          release();
        }
      },
    };
  })();
  const runDocsReviewFanout = (
    pipelineId: string,
    projectId: string,
    wfDir: string | null,
    resetScope?: 'stage' | 'downstream',
  ): { projectId: string; completion: Promise<'succeeded' | 'failed' | 'idle'> } => {
    const cancelKey = `${projectId}::${pipelineId}`;
    const activeRuns = new Set<{ id: string }>();
    let canceled = false;
    registerPipelineCanceler(cancelKey, activeRuns, () => {
      canceled = true;
    });
    // Mirrors of the try block's cwd/pages/results, updated the moment each
    // becomes known, so the OUTER catch below (unlike the try body, it has no
    // access to those block-scoped consts) can still fail-shut every page
    // that was never confirmed successful — see the FAIL-SHUT INVARIANT block
    // comment above this function. `outerResults` aliases the SAME array as
    // `results` (arrays are references in JS), so element writes the try body
    // makes via `results[idx] = …` are visible here too without extra
    // bookkeeping.
    let outerCwd: string | null = null;
    let outerPages: DocPage[] = [];
    let outerResults: DocPageResult[] = [];
    const completion: Promise<'succeeded' | 'failed' | 'idle'> = (async () => {
      const def = getPipelineDef(pipelineId)!;
      try {
        const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
        let agentId = typeof appConfig.agentId === 'string' && appConfig.agentId ? appConfig.agentId : null;
        if (!agentId) {
          const agents = await detectAgents(appConfig.agentCliEnv ?? {}, sandboxSkipProbe(appConfig)).catch(() => []);
          agentId = agents.find((a) => a.available)?.id ?? null;
        }
        if (!agentId) {
          const sandboxAgentId = await sandboxFallbackRuntimeId();
          if (sandboxAgentId) agentId = sandboxAgentId;
        }
        if (!agentId) throw new Error('No available agent is configured. Choose an agent in Settings first.');

        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'running', subConversations: [] });
        const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
        const cwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;
        outerCwd = cwd;

        // Dọn thông báo "không chạy được" còn sót từ lần chạy TRƯỚC — nó nằm
        // ngang hàng review/ (xem writeDocsReviewFailureNote), cố tình không
        // khớp outputs của stage nào nên không tự dọn theo re-run clear bên
        // dưới; nếu không xoá ở đây, một lần chạy THÀNH CÔNG sau đó vẫn để
        // lại file báo lỗi cũ, gây hiểu nhầm dù review/ đã có báo cáo mới.
        await fs.promises.rm(path.join(cwd, DOCS_REVIEW_FAILURE_NOTE), { force: true }).catch(() => null);

        // ONE-TIME fence + re-run clear — same shape as the PRD review fan-out
        // (concurrent page runs must NOT each do this).
        const regenIds = new Set(stageRegenSet(pipelineId, resetScope === 'downstream'));
        await commitHistory(projectRoot, { kind: 'manual-edits', by: historyActor() }).catch(() => null);
        try {
          const snap = await snapshotPipelineCwd(projectRoot);
          for (const rel of snap.keys()) {
            // Target fence included: relClearedByRegen confines the clear to
            // this run's own <wf>/<target>/ subtree when target-scoped. Note
            // 'docs-review/criteria/…' never matches any stage's outputs
            // (stagesForOutput returns []), so it survives every clear.
            if (relClearedByRegen(rel, regenIds, wfDir)) {
              await fs.promises.rm(path.join(projectRoot, rel), { force: true }).catch(() => null);
            }
          }
        } catch (error) {
          console.warn('[docs-review] re-run clear failed (continuing):', error);
        }
        for (const id of regenIds) {
          if (id !== pipelineId) setProjectPipelineStatus(db, projectId, id, { status: 'idle' });
        }

        // Deterministic clone (no LLM, no agent): pre-populates review/docs/…
        // so every page's agent run only ever Edits an existing file.
        const clonedRel = await cloneDocsForReview(cwd);
        if (clonedRel.length === 0) {
          // Nothing to review — a docs-to-ui-shaped "empty stage" is a broken
          // input (the Docs step never ran / produced nothing), not a clean
          // bill of health. Fail loudly and say what to run first.
          //
          // STAGE-LEVEL INVARIANT: do NOT write into review/ here. Even
          // though clonedRel is empty (no REVIEWABLE page), cloneDocsForReview
          // may have already populated review/docs/ with `_index.md` and/or
          // `attachments/` (it clones docs/ byte-for-byte, unfiltered — see
          // its docblock) — so review/ can be non-empty right now despite
          // there being nothing to review. Writing review/summary.md on top
          // of that would leave review/ with files while this stage just
          // declared 'failed'; stagesForOutput/mergePipelineState let that
          // file signal override the DB status and paint the stage green
          // (the exact bug this fixes). writeDocsReviewFailureNote wipes
          // review/ completely and puts the explanation in a sibling file
          // instead, which never matches dr-review's outputs.
          await writeDocsReviewFailureNote(
            cwd,
            [
              '# Docs → Review tài liệu — không chạy được',
              '',
              'Không tìm thấy trang tài liệu nào dưới `docs/` nên không có gì để review.',
              '',
              'Chạy bước **Tài liệu → Markdown** trước, rồi chạy lại bước này.',
              '',
            ].join('\n'),
          );
          setProjectPipelineStatus(db, projectId, pipelineId, {
            status: 'failed',
            subConversations: [],
            error: 'Không tìm thấy trang tài liệu nào dưới docs/ — chạy bước Tài liệu → Markdown trước, rồi chạy lại bước này.',
          });
          console.warn(`[docs-review] no doc pages under ${cwd}/docs — nothing to review`);
          return 'failed' as const;
        }
        const pages = await listDocPages(cwd);
        outerPages = pages;

        // criteria/ đọc MỘT LẦN cho cả stage (không phải mỗi trang): nó là
        // input chung, không đổi giữa các lượt chạy. Thiếu thư mục => Set rỗng
        // => validateRuleIds bỏ qua hoàn toàn.
        const criteriaAnchors = await (async () => {
          const dir = path.join(cwd, 'criteria');
          const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
          const files: Array<{ name: string; text: string }> = [];
          for (const name of names) {
            if (!name.toLowerCase().endsWith('.md')) continue;
            const text = await fs.promises.readFile(path.join(dir, name), 'utf8').catch(() => null);
            if (text != null) files.push({ name, text });
          }
          return collectCriteriaAnchors(files);
        })();

        // Mỗi TRANG cắt thành SECTION theo heading; mỗi SECTION là một lượt
        // chạy riêng. Trang không đọc được => splitSections('') vẫn cho đúng
        // một section phủ cả trang, nên trang đó vẫn được review thay vì rơi
        // ra khỏi fan-out.
        const pageUnits = await Promise.all(
          pages.map(async (pg) => {
            const original = await fs.promises.readFile(path.join(cwd, pg.mdPath), 'utf8').catch(() => '');
            return { pg, sections: splitSections(original) };
          }),
        );

        // Each SECTION gets its OWN conversation, titled by page + heading.
        // `tasks` là một danh sách PHẲNG (subConversations của stage), còn
        // `taskIndexBySection[pageIdx][sectionIdx]` cho worker biết task nào
        // thuộc section nào.
        const modelPrefs = appConfig.agentModels?.[agentId] ?? {};
        const graphNote =
          ' This is a FILE-ONLY stage: produce the edited clone + its changes/notes files only — do not push anything anywhere.';

        const tasks: Array<{ id: string; title: string; status: 'queued' | 'running' | 'succeeded' | 'failed' }> = [];
        const taskIndexBySection: number[][] = pageUnits.map(() => []);
        pageUnits.forEach((unit, pi) => {
          for (const sec of unit.sections) {
            const id = `pipeline-conv-${randomUUID()}`;
            const label = `${unit.pg.page} · ${sec.heading || 'Mở đầu'}`;
            insertConversation(db, { id, projectId, title: `${def.name} · ${label}`, createdAt: Date.now(), updatedAt: Date.now() });
            taskIndexBySection[pi]!.push(tasks.length);
            tasks.push({ id, title: label, status: 'queued' });
          }
        });
        const persistTasks = () =>
          setProjectPipelineStatus(db, projectId, pipelineId, { subConversations: tasks.map((t) => ({ ...t })) });
        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'running', lastConversationId: tasks[0]?.id });
        persistTasks();

        const results: DocPageResult[] = new Array(pages.length);
        outerResults = results;
        let done = 0;

        /** Một lượt chạy agent cho MỘT section của một trang. */
        const runOneSectionOfPage = async (
          pg: DocPage,
          sec: DocPageSection,
          task: (typeof tasks)[number],
        ): Promise<{ ok: boolean; canceled: boolean; error?: string }> => {
          const conversationId = task.id;
          task.status = 'running';
          persistTasks();
          const reviewRel = path.posix.join('review', pg.mdPath);
          const secChangesRel = sectionOutputPath(reviewRel, sec.index, 'changes');
          const secNotesRel = sectionOutputPath(reviewRel, sec.index, 'notes');
          // Đích SỬA là LÁT CẮT của riêng section này, không phải bản clone cả
          // trang: nhờ vậy các section của cùng một trang chạy song song được
          // (xem sectionSlicePath). Daemon ghép các lát lại thành bản clone
          // ngay sau khi cả trang xong, trước mọi bước validate.
          const secSliceRel = sectionSlicePath(reviewRel, sec.index);
          const assistantMessageId = `pipeline-assistant-${randomUUID()}`;
          // Ảnh mockup: daemon KHÔNG truyền ảnh vào prompt — nó nêu đích danh
          // đường dẫn và bắt agent tự Read, đúng khuôn skills/docs-mockup-review.
          // Bản clone copy nguyên cây docs/ kể cả attachments/, nên ref tương
          // đối trong section vẫn trỏ đúng file thật.
          const imageLine =
            sec.imageRefs.length > 0
              ? ` Section này nhúng ${sec.imageRefs.length} ảnh: ${sec.imageRefs.map((r) => `"${r}"`).join(', ')}. ` +
                `BẮT BUỘC mở TỪNG ảnh bằng Read (chúng là file thật nằm cạnh bản clone) trước khi kết luận bất cứ điều gì về component, biến thể, trạng thái hay layout. Không mở ảnh thì KHÔNG được tạo change/note nhóm component.`
              : ' Section này không nhúng ảnh nào.';
          const emptyLine =
            sec.bodyLines === 0
              ? ` LƯU Ý: heading này KHÔNG CÓ NỘI DUNG (chỉ có dòng tiêu đề). Đó là một gap mức major — ghi một note vào "${secNotesRel}", KHÔNG tự bịa nội dung/sơ đồ vào tài liệu.`
              : '';
          const outlineRel = pageOutlinePath(reviewRel);
          const kickoff =
            `Run the "docs-spec-review" review for ONE SECTION of ONE page of project "${projectId}" (page title: ${pg.page}; original: "${pg.mdPath}", READ-ONLY — do NOT modify any file under docs/). ` +
            `SECTION của bạn là "${sec.heading || '(phần mở đầu, trước heading đầu tiên)'}", dòng ${sec.startLine}-${sec.endLine} của trang gốc.${imageLine}${emptyLine} ` +
            `ĐỌC GÌ: (1) lát cắt "${secSliceRel}" — chứa ĐÚNG và ĐỦ nội dung section của bạn, đọc trọn; (2) mục lục trang "${outlineRel}" — cấu trúc cả trang + khoảng dòng từng section. ` +
            `KHÔNG đọc cả trang gốc và KHÔNG đọc bản clone cả trang "${reviewRel}" — chúng dài gấp nhiều lần phần bạn phụ trách. Cần ngữ cảnh ngoài section (thuật ngữ, luồng được nhắc ở phần khác), Read "${pg.mdPath}" với offset/limit đúng khoảng dòng ghi trong mục lục, tối đa vài lần. ` +
            `Edit ONLY the slice file "${secSliceRel}" using the Edit tool (one targeted edit per change — never Write to overwrite the whole file); daemon ghép các lát lại thành trang hoàn chỉnh sau khi mọi section chạy xong. ` +
            `TUYỆT ĐỐI KHÔNG sửa "${reviewRel}" — các section khác đang chạy SONG SONG và bản clone đó do daemon dựng lại, mọi sửa đổi trực tiếp vào nó sẽ bị ghi đè và mất. ` +
            `checking it against the criteria in "criteria/" if that folder exists (optional — fall back to the skill's built-in default criteria when it is absent). ` +
            `Write every change you actually made to "${secChangesRel}" as a JSON array of DocChange objects, ` +
            `and every finding you could NOT fix by editing text to "${secNotesRel}" as a JSON array of DocNote objects. ` +
            `TUYỆT ĐỐI KHÔNG chèn chuỗi chú giải "[Rà soát …]" (hay bất kỳ chú giải nào) vào lát cắt — daemon đánh hỏng CẢ TRANG nếu phát hiện; nhận xét không sửa được bằng chữ phải đi vào "${secNotesRel}". ` +
            `Do NOT review any other page or section, and do NOT write review/index.json or review/summary.md — the pipeline aggregates those from every section's files.${graphNote}`;
          const run = design.runs.create({
            projectId,
            conversationId,
            assistantMessageId,
            clientRequestId: `docs-review-${pg.slug}-s${sec.index}-${randomUUID()}`,
            agentId: agentId!,
          });
          activeRuns.add(run);
          upsertMessage(db, conversationId, { id: `pipeline-user-${run.id}`, role: 'user', content: kickoff });
          upsertMessage(db, conversationId, {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            agentId: agentId!,
            agentName: getAgentDef(agentId!)?.name ?? agentId!,
            runId: run.id,
            runStatus: 'queued',
            startedAt: Date.now(),
          });
          design.runs.start(run, () =>
            startChatRun(
              {
                agentId: agentId!,
                projectId,
                conversationId,
                assistantMessageId,
                clientRequestId: run.clientRequestId,
                skillId: def.skillId,
                ...(wfDir ? { cwdSubdir: wfDir } : {}),
                model: modelPrefs.model ?? null,
                reasoning: modelPrefs.reasoning ?? null,
                message: kickoff,
                promptProfile: 'pipeline',
                pipelineUsesDesignSystem: def.acceptsDesignSystem === true,
              },
              run,
            ),
          );
          const final = await design.runs.wait(run);
          activeRuns.delete(run);
          db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`).run(final.status, Date.now(), assistantMessageId);
          if (final.status === 'succeeded') {
            task.status = 'succeeded';
            persistTasks();
            return { ok: true, canceled: false };
          }
          task.status = 'failed';
          persistTasks();
          return {
            ok: false,
            canceled: final.status === 'canceled',
            error: `Section "${sec.heading || 'Mở đầu'}": agent run kết thúc với trạng thái "${final.status}".`,
          };
        };

        /** Chạy MỌI section của một trang TUẦN TỰ (chung một file clone — hai
         *  agent cùng Edit một file là hỏng dữ liệu), rồi validate MỘT LẦN
         *  trên tổng hợp changes/notes của cả trang. */
        const runOnePage = async (
          unit: (typeof pageUnits)[number],
          idx: number,
        ): Promise<'succeeded' | 'failed' | 'idle'> => {
          const { pg, sections } = unit;
          const reviewRel = path.posix.join('review', pg.mdPath);
          const errors: string[] = [];
          let sawCancel = false;

          // Cắt trang thành lát TRƯỚC khi chạy: mỗi section có file riêng nên
          // chúng chạy song song được. Đọc từ bản CLONE (không phải bản gốc) vì
          // clone là thứ agent được phép sửa và là thứ sẽ được dựng lại.
          let pageEol: '\r\n' | '\n' = '\n';
          try {
            const cloneText = await fs.promises.readFile(path.join(cwd, reviewRel), 'utf8');
            pageEol = detectEol(cloneText);
            const slices = sliceSections(cloneText, sections);
            await Promise.all(
              sections.map((sec, si) =>
                fs.promises.writeFile(path.join(cwd, sectionSlicePath(reviewRel, sec.index)), slices[si] ?? '', 'utf8'),
              ),
            );
            // Mục lục trang: một file cho cả trang, để mỗi lượt section đọc
            // lát của mình + mục lục thay vì đọc lại cả trang gốc lẫn bản clone
            // (xem pageOutlinePath). Xoá cùng lúc với các lát bên dưới.
            await fs.promises.writeFile(
              path.join(cwd, pageOutlinePath(reviewRel)),
              renderPageOutline({
                page: pg.page,
                mdPath: pg.mdPath,
                reviewRel,
                totalLines: cloneText.split(/\r?\n/).length,
                sections,
              }),
              'utf8',
            );
          } catch (error) {
            errors.push(`Không cắt được trang thành lát: ${error instanceof Error ? error.message : String(error)}`);
          }

          // Các section chạy SONG SONG (mỗi cái một lát riêng). Giới hạn chung
          // toàn stage là DOCS_REVIEW_FANOUT_CONCURRENCY — pool trang bên ngoài
          // và các section bên trong dùng CHUNG một semaphore, nếu không thì
          // 4 trang × 4 section = 16 agent cùng lúc.
          if (errors.length === 0) {
            const outcomes = await Promise.all(
              sections.map(async (sec, si) => {
                // Kiểm cờ huỷ ngay trước khi CHIẾM slot: một section đang xếp
                // hàng mà người dùng bấm dừng thì không được khởi động nữa.
                if (canceled) return { ok: false, canceled: true } as const;
                return sectionSlots.run(async () => {
                  if (canceled) return { ok: false, canceled: true } as const;
                  return runOneSectionOfPage(pg, sec, tasks[taskIndexBySection[idx]![si]!]!);
                });
              }),
            );
            // Trang vẫn là đơn vị đạt/hỏng: MỘT section hỏng là cả trang hỏng.
            // Khác bản tuần tự ở chỗ các section còn lại đã chạy xong rồi chứ
            // không bị bỏ dở — chúng độc lập nên không có gì để tiết kiệm.
            for (const outcome of outcomes) {
              if (outcome.ok) continue;
              if (outcome.canceled) sawCancel = true;
              if ('error' in outcome && outcome.error) errors.push(outcome.error);
            }
          }

          // Ghép các lát lại thành bản clone hoàn chỉnh. Phải chạy TRƯỚC mọi
          // bước validate bên dưới vì chúng đọc `reviewRel`. Lát nào không đọc
          // được (agent xoá mất) là lỗi trang — im lặng bỏ qua sẽ làm mất hẳn
          // một đoạn tài liệu mà validateChanges lại báo "xoá không khai báo"
          // ở tận đâu đó, rất khó lần ra.
          if (!sawCancel) {
            try {
              const parts: string[] = [];
              for (const sec of sections) {
                parts.push(await fs.promises.readFile(path.join(cwd, sectionSlicePath(reviewRel, sec.index)), 'utf8'));
              }
              await fs.promises.writeFile(path.join(cwd, reviewRel), rebuildPageFromSlices(parts, pageEol), 'utf8');
            } catch (error) {
              errors.push(`Không ghép lại được trang từ các lát: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          let changes: DocChange[] = [];
          let notes: DocNote[] = [];
          const warnings: string[] = [];
          let pageStatus: 'succeeded' | 'failed' = errors.length === 0 && !sawCancel ? 'succeeded' : 'failed';

          if (pageStatus === 'succeeded') {
            try {
              const [original, revised] = await Promise.all([
                fs.promises.readFile(path.join(cwd, pg.mdPath), 'utf8'),
                fs.promises.readFile(path.join(cwd, reviewRel), 'utf8'),
              ]);
              // Gộp file tạm của MỌI section. File thiếu = mảng rỗng, KHÔNG
              // phải lỗi: một section không có phát hiện nào là chuyện bình
              // thường và không được làm hỏng trang.
              for (const sec of sections) {
                const rawChanges = await fs.promises
                  .readFile(path.join(cwd, sectionOutputPath(reviewRel, sec.index, 'changes')), 'utf8')
                  .catch(() => null);
                if (rawChanges != null) {
                  const parsed = parseChangesFile(rawChanges);
                  if ('errors' in parsed) errors.push(...parsed.errors.map((e) => `s${sec.index}: ${e}`));
                  else changes.push(...parsed.changes);
                }
                const rawNotes = await fs.promises
                  .readFile(path.join(cwd, sectionOutputPath(reviewRel, sec.index, 'notes')), 'utf8')
                  .catch(() => null);
                if (rawNotes != null) {
                  const parsed = parseNotesFile(rawNotes);
                  if ('errors' in parsed) errors.push(...parsed.errors.map((e) => `s${sec.index}: ${e}`));
                  else notes.push(...parsed.notes);
                }
              }

              // Chú giải bị cấm kiểm TRƯỚC: nếu agent đã chèn "[Rà soát …]"
              // vào bản clone thì mọi kiểm tra sau đó chỉ đang xác nhận một
              // tài liệu đã hỏng.
              const markers = findReviewMarkers(revised);
              if (markers.length > 0) {
                errors.push(
                  `Bản clone bị chèn chú giải bị cấm ở ${markers.length} dòng — nhận xét không sửa được bằng text phải đi vào notes.json, không chèn vào tài liệu: ${markers
                    .slice(0, 5)
                    .map((m) => `"${m}"`)
                    .join('; ')}`,
                );
              }
              if (errors.length === 0) {
                errors.push(...validateChanges(original, revised, changes));
                // Note neo trượt: cảnh báo, KHÔNG hỏng trang (xem partitionNotesByAnchor).
                const partitioned = partitionNotesByAnchor(original, notes);
                notes = partitioned.notes;
                warnings.push(...partitioned.warnings);
                errors.push(...partitioned.errors);
                errors.push(
                  ...validateRuleIds(
                    [
                      ...changes.map((c) => ({ id: c.id, kind: c.kind, ...(c.rule_id ? { rule_id: c.rule_id } : {}) })),
                      ...notes.map((n) => ({ id: n.id, kind: n.kind, ...(n.rule_id ? { rule_id: n.rule_id } : {}) })),
                    ],
                    criteriaAnchors,
                  ),
                );
              }
              if (errors.length > 0) pageStatus = 'failed';
            } catch (error) {
              pageStatus = 'failed';
              errors.push(`Không đọc được output của trang: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          if (pageStatus === 'failed') {
            // Fail-shut through the ONE shared primitive — see removePageOutputs's
            // docblock in docs-review.ts for why this delete is load-bearing.
            // Nó dọn luôn mọi file tạm .s<NN>.* của trang.
            await removePageOutputs(cwd, pg.mdPath);
            changes = [];
            notes = [];
          } else {
            // Đạt: ghi file gộp cấp TRANG (đúng shape DocRedlinePreview đang
            // đọc), rồi xoá mọi file tạm theo section.
            await fs.promises.writeFile(
              path.join(cwd, reviewRel.replace(/\.md$/i, '.changes.json')),
              JSON.stringify(changes, null, 2),
              'utf8',
            );
            await fs.promises.writeFile(
              path.join(cwd, reviewRel.replace(/\.md$/i, '.notes.json')),
              JSON.stringify(notes, null, 2),
              'utf8',
            );
            for (const sec of sections) {
              await fs.promises
                .rm(path.join(cwd, sectionOutputPath(reviewRel, sec.index, 'changes')), { force: true })
                .catch(() => null);
              await fs.promises
                .rm(path.join(cwd, sectionOutputPath(reviewRel, sec.index, 'notes')), { force: true })
                .catch(() => null);
              // Lát cắt đã ghép vào bản clone xong thì không còn giá trị gì —
              // để lại chỉ làm `review/` có hai bản của cùng một nội dung.
              await fs.promises
                .rm(path.join(cwd, sectionSlicePath(reviewRel, sec.index)), { force: true })
                .catch(() => null);
            }
            await fs.promises.rm(path.join(cwd, pageOutlinePath(reviewRel)), { force: true }).catch(() => null);
          }

          results[idx] = {
            slug: pg.slug,
            page: pg.page,
            docPath: pg.mdPath,
            reviewPath: reviewRel,
            changes,
            notes,
            status: pageStatus,
            ...(errors.length > 0 ? { errors } : {}),
            ...(warnings.length > 0 ? { warnings } : {}),
          };

          // Trang là đơn vị đạt/hỏng, nên MỌI task của trang mang trạng thái
          // của trang — kể cả section chạy xong rồi mà trang hỏng ở bước
          // validate gộp, và section chưa kịp chạy vì trang dừng sớm.
          for (const ti of taskIndexBySection[idx]!) tasks[ti]!.status = pageStatus;
          persistTasks();
          done += 1;
          console.log(`[docs-review] page ${done}/${pages.length} "${pg.page}" (${sections.length} section) → ${pageStatus}`);
          return pageStatus === 'succeeded' ? 'succeeded' : sawCancel ? 'idle' : 'failed';
        };

        let cursor = 0;
        const worker = async () => {
          for (;;) {
            if (canceled) break;
            const i = cursor++;
            if (i >= pageUnits.length) break;
            await runOnePage(pageUnits[i]!, i).catch(async () => {
              for (const ti of taskIndexBySection[i]!) tasks[ti]!.status = 'failed';
              // runOnePage threw before it could fail-shut itself (e.g. a
              // read/parse blew up outside its own try/catch) — clean up here
              // too, same primitive, same reason: a clone left on disk after
              // an exception reads as "reviewed" from disk alone.
              await removePageOutputs(cwd, pages[i]!.mdPath);
              results[i] = {
                slug: pages[i]!.slug,
                page: pages[i]!.page,
                docPath: pages[i]!.mdPath,
                reviewPath: path.posix.join('review', pages[i]!.mdPath),
                changes: [],
                notes: [],
                status: 'failed',
                errors: ['Lỗi không rõ khi chạy trang này.'],
              };
              persistTasks();
              return 'failed' as const;
            });
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(DOCS_REVIEW_FANOUT_CONCURRENCY, pageUnits.length) }, worker),
        );

        if (canceled) {
          // Fail-shut on cancel too: clean every page that did NOT finish
          // successfully — including pages the pool never got to (their
          // pre-staged clone is still sitting on disk from cloneDocsForReview
          // above, untouched, and disk state wins over DB state). If nothing
          // succeeded at all, there is nothing worth keeping under review/ —
          // clear the whole directory instead of leaving an empty shell.
          await Promise.all(
            pages.map((pg, i) => (results[i]?.status === 'succeeded' ? Promise.resolve() : removePageOutputs(cwd, pg.mdPath))),
          );
          if (!results.some((r) => r?.status === 'succeeded')) {
            await fs.promises.rm(path.join(cwd, 'review'), { recursive: true, force: true }).catch(() => null);
          }
          setProjectPipelineStatus(db, projectId, pipelineId, { status: 'idle', subConversations: tasks.map((t) => ({ ...t })) });
          console.log('[docs-review] fan-out canceled by user');
          return 'idle' as const;
        }

        // Merge: daemon-owned, no LLM.
        const { index, summaryMd } = mergeChangeReports(results);

        // Don't-fail-the-whole-stage-for-one-page: succeed as long as at
        // least one page validated cleanly; fail only if every page failed.
        const anySucceeded = results.some((r) => r.status === 'succeeded');
        const next: 'succeeded' | 'failed' = anySucceeded ? 'succeeded' : 'failed';
        if (anySucceeded) {
          await fs.promises.mkdir(path.join(cwd, 'review'), { recursive: true });
          await fs.promises.writeFile(path.join(cwd, 'review/index.json'), JSON.stringify(index, null, 2), 'utf8');
          await fs.promises.writeFile(path.join(cwd, 'review/summary.md'), summaryMd, 'utf8');
        } else {
          // STAGE-LEVEL INVARIANT: every page failed — do NOT leave
          // review/index.json / review/summary.md behind while returning
          // 'failed'. mergePipelineState lets ANY file under review/ (this
          // stage's declared output) override the DB status with
          // 'succeeded', so writing those two files unconditionally (the
          // previous shape of this branch) made the stage read as green from
          // disk alone right after declaring 'failed' — the exact bug this
          // fixes. Keep the per-page failure detail for the user by
          // redirecting the same summaryMd into the sibling note file
          // instead of losing it outright.
          await writeDocsReviewFailureNote(cwd, summaryMd);
        }
        // Every page failed. The sub-conversations may all be GREEN here —
        // the agent runs finished, it was the daemon's post-run validation
        // (bad .changes/.notes JSON, "[Rà soát …]" markers left in the clone,
        // change diff mismatch, unknown rule ids…) that rejected each page.
        // So the generic "see the step's conversation" text points nowhere;
        // name the real per-page reasons in the stage error and hand them
        // to the error report (attachStageFailureContext) as well.
        const failureDetail = next === 'failed' ? fanoutFailureDetail(results.map((r) => ({ name: r.page, errors: r.errors ?? [] }))) : null;
        if (failureDetail) {
          attachStageFailureContext(projectId, pipelineId, {
            agentId,
            model: modelPrefs.model ?? null,
            reasoning: modelPrefs.reasoning ?? null,
            outputs: `docs-review: 0/${results.length} trang đạt (validation sau fan-out)\n${failureDetail.list}`,
            finalStatus: 'failed',
            workflowId: wfDir,
          });
        }
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: next,
          subConversations: tasks.map((t) => ({ ...t })),
          ...(failureDetail ? { error: `Không trang nào đạt kiểm tra sau khi rà soát (${results.length} trang) — ${failureDetail.first}. Chi tiết: ${DOCS_REVIEW_FAILURE_NOTE}` } : {}),
        });
        void commitHistory(projectRoot, { kind: 'run', pipelineId, status: next, by: historyActor() }).catch(() => null);
        console.log(`[docs-review] fan-out done: ${results.filter((r) => r.status === 'succeeded').length}/${pages.length} pages reviewed → ${next}`);
        if (failureDetail) console.warn(`[docs-review] every page failed validation:\n${failureDetail.list}`);
        return next;
      } catch (error) {
        // FAIL-SHUT — see the block comment above this function. The stage
        // can throw AFTER cloneDocsForReview already staged review/docs/…
        // (e.g. insertConversation throwing while building `tasks`, or a
        // disk-full mkdir/writeFile while merging results); leaving those
        // clones behind would read as "reviewed" purely from file presence
        // (mergePipelineState lets file signal win over DB state). `cwd` /
        // `pages` / `results` are block-scoped to the try above and
        // unreachable here, so this uses the `outerCwd` / `outerPages` /
        // `outerResults` mirrors kept in sync as each becomes known. Clean
        // every page NOT already confirmed successful; if literally none
        // succeeded, there is nothing worth keeping under review/ at all —
        // wipe the whole directory instead of leaving an empty/partial shell.
        if (outerCwd) {
          const cwd = outerCwd;
          // Dọn hỏng thì PHẢI kêu to. Nuốt lỗi ở đúng đường fail-shut là tự
          // phá mục đích của nó: file còn sót dưới review/ sẽ khiến
          // deriveStateFromLocalFiles suy ra stage 'succeeded' và thắng trạng
          // thái 'failed' ghi trong DB, tức stage hiện xanh trong khi lần chạy
          // này đã hỏng. Không xoá được thì ít nhất phải chẩn đoán được.
          await Promise.all(
            outerPages.map((pg, i) =>
              outerResults[i]?.status === 'succeeded' ? Promise.resolve() : removePageOutputs(cwd, pg.mdPath),
            ),
          ).catch((cleanupError) =>
            console.error('[docs-review] FAIL-SHUT hỏng: không xoá được output của trang chưa thành công — stage có thể hiện xanh sai:', cleanupError),
          );
          if (!outerResults.some((r) => r?.status === 'succeeded')) {
            await fs.promises
              .rm(path.join(cwd, 'review'), { recursive: true, force: true })
              .catch((cleanupError) =>
                console.error(`[docs-review] FAIL-SHUT hỏng: không xoá được ${path.join(cwd, 'review')} — stage sẽ hiện xanh dù lần chạy này hỏng:`, cleanupError),
              );
          }
        }
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: 'failed',
          error: String(error?.message ?? error),
        });
        console.warn('[docs-review] fan-out failed:', error);
        return 'failed' as const;
      } finally {
        pipelineCancelers.delete(cancelKey);
      }
    })();
    return { projectId, completion };
  };

  // Customer Journey + UX Research run PER SECTION in parallel when the docs
  // came from a sub-tree scan (a whole-product tree overwhelms one synthesis —
  // it front-loads and drops the back half). One agent run per top-level module
  // writes its slice; the daemon merges the slices into the canonical output
  // (union personas / renumber criteria). Shares the review fan-out's shape:
  // bounded pool, ONE conversation, history commit + clear ONCE up front. `kind`
  // picks CJ vs UXR (skill, per-section output path, merge).
  const SECTION_FANOUT_CONCURRENCY = 4;
  const runSectionFanout = (
    pipelineId: string,
    projectId: string,
    wfDir: string | null,
    resetScope: 'stage' | 'downstream' | undefined,
    kind: 'cj' | 'ux-research' | 'ux-spec',
    sections: DocSection[],
    platform?: import('@open-design/contracts').TargetPlatform,
  ): { projectId: string; completion: Promise<'succeeded' | 'failed' | 'idle'> } => {
    const cancelKey = `${projectId}::${pipelineId}`;
    const activeRuns = new Set<{ id: string }>();
    let canceled = false;
    registerPipelineCanceler(cancelKey, activeRuns, () => {
      canceled = true;
    });
    const completion: Promise<'succeeded' | 'failed' | 'idle'> = (async () => {
      const def = getPipelineDef(pipelineId)!;
      const label = kind;
      try {
        const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
        let agentId = typeof appConfig.agentId === 'string' && appConfig.agentId ? appConfig.agentId : null;
        if (!agentId) {
          const agents = await detectAgents(appConfig.agentCliEnv ?? {}, sandboxSkipProbe(appConfig)).catch(() => []);
          agentId = agents.find((a) => a.available)?.id ?? null;
        }
        if (!agentId) {
          const sandboxAgentId = await sandboxFallbackRuntimeId();
          if (sandboxAgentId) agentId = sandboxAgentId;
        }
        if (!agentId) throw new Error('No available agent is configured. Choose an agent in Settings first.');

        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'running', subConversations: [] });
        const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
        const cwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;

        // ONE-TIME fence + re-run clear (concurrent section runs must NOT each
        // do it) so the fan-out regenerates a clean output tree.
        const regenIds = new Set(stageRegenSet(pipelineId, resetScope === 'downstream'));
        await commitHistory(projectRoot, { kind: 'manual-edits', by: historyActor() }).catch(() => null);
        try {
          const snap = await snapshotPipelineCwd(projectRoot);
          for (const rel of snap.keys()) {
            // Target fence included: a target-scoped fan-out clears only its
            // own <wf>/<target>/ subtree (see relClearedByRegen).
            if (relClearedByRegen(rel, regenIds, wfDir)) {
              await fs.promises.rm(path.join(projectRoot, rel), { force: true }).catch(() => null);
            }
          }
        } catch (error) {
          console.warn(`[${label}] re-run clear failed (continuing):`, error);
        }
        for (const id of regenIds) {
          if (id !== pipelineId) setProjectPipelineStatus(db, projectId, id, { status: 'idle' });
        }

        // UX Research needs the knowledge base staged into the cwd; do it ONCE
        // and hand every section run the same relative-path directive.
        let kbDirective = '';
        if (kind === 'ux-research') {
          const kb = await resolveUxKbDir(RUNTIME_DATA_DIR);
          if (kb.dir) {
            try {
              const staged = path.join(cwd, '.ux-kb');
              await fs.promises.rm(staged, { recursive: true, force: true });
              await fs.promises.cp(kb.dir, staged, { recursive: true });
              kbDirective = ` The UX knowledge base IS PRESENT at "./.ux-kb" (staged by the daemon). Use it via relative paths, e.g. \`python3 ./.ux-kb/scripts/search.py <keywords>\`. Criteria must cite its sources.`;
            } catch {
              kbDirective = ` The UX knowledge base IS PRESENT at "${kb.dir}". Use that ABSOLUTE path for its scripts. Criteria must cite its sources.`;
            }
          } else {
            kbDirective = ' The daemon verified there is NO UX knowledge base available — produce the fallback report (knowledge_base: "unavailable") for this section.';
          }
        }

        // Design System review criteria (ux-spec fan-out only): the fan-out's
        // cwd IS the run cwd every section run shares (unlike the single-target
        // docs copy below, staging happens once here, not per section). Same
        // best-effort contract as the single-agent path in runPipeline — no
        // linked App / DS / criteria yet all keep this ''.
        let dsCriteriaKickoffDirective = '';
        if (kind === 'ux-spec' && def.usesDesignSystemCriteria) {
          try {
            const criteriaDsId = criteriaDesignSystemForProject(projectId);
            if (criteriaDsId) {
              await copyDsCriteriaIntoWorkflow(criteriaDsId, cwd, dsDirForId);
              const [hasRules, hasComponents] = await Promise.all([
                fs.promises.stat(path.join(cwd, 'criteria', 'rules.md')).then((s) => s.isFile()).catch(() => false),
                fs.promises.stat(path.join(cwd, 'criteria', 'components.md')).then((s) => s.isFile()).catch(() => false),
              ]);
              dsCriteriaKickoffDirective = dsCriteriaDirective({ hasRules, hasComponents });
            }
          } catch (error) {
            console.warn('[ds-criteria] staging into fan-out cwd failed (continuing without it):', error);
          }
        }

        // Pre-create one conversation per module (all "queued"), plus a trailing
        // "Hợp nhất" (reconcile) task, so the Status modal shows X/N done + each
        // module's live state.
        const modelPrefs = appConfig.agentModels?.[agentId] ?? {};
        const tasks = sections.map((sec) => {
          const id = `pipeline-conv-${randomUUID()}`;
          insertConversation(db, { id, projectId, title: `${def.name} · ${sec.title}`, createdAt: Date.now(), updatedAt: Date.now() });
          return { id, title: sec.title, status: 'queued' as 'queued' | 'running' | 'succeeded' | 'failed' };
        });
        const persistTasks = () =>
          setProjectPipelineStatus(db, projectId, pipelineId, { subConversations: tasks.map((t) => ({ ...t })) });
        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'running', lastConversationId: tasks[0]?.id });
        persistTasks();

        let done = 0;
        const outRel = (key: string) =>
          kind === 'cj' ? `cj/${key}/journey.json` : kind === 'ux-research' ? `ux-research/${key}/report.json` : `ux/${key}/ux-spec.json`;
        const platformDirective =
          kind === 'ux-spec' && platform === 'web'
            ? ' Target platform: WEBSITE — every screen sets `layout: "web"` (tables, sidebar/top nav, multi-column forms).' +
              ' The website is RESPONSIVE: give every screen a `responsive_notes` field (desktop ~1440px ↔ mobile ≤768px adaptation; wireframes stay desktop-first).'
            : kind === 'ux-spec' && platform === 'mobile'
              ? ' Target platform: MOBILE — every screen sets `layout: "mobile"` (fixed phone viewport, no responsive behavior).'
              : '';
        const runOneSection = async (sec: DocSection, task: (typeof tasks)[number]): Promise<void> => {
          const conversationId = task.id;
          task.status = 'running';
          persistTasks();
          const assistantMessageId = `pipeline-assistant-${randomUUID()}`;
          const pagesList = sec.mdPaths.map((p) => `"${p}"`).join(', ');
          const kickoff =
            kind === 'cj'
              ? `Run the customer-journey-spec skill for ONE MODULE of feature "${projectId}". ` +
                `Cover ONLY this module — its pages: ${pagesList} (module: ${sec.title}). ` +
                `Write your result to "${outRel(sec.key)}" (personas + journeys for THIS module only). ` +
                `Do NOT write any root -customer-journey.json and do NOT cover other modules — the daemon merges every module's slice.` +
                ` This is a FILE-ONLY stage: do not push anything.`
              : kind === 'ux-research'
                ? `Run the ux-research skill for ONE MODULE of feature "${projectId}". ` +
                  `Derive UX criteria ONLY for this module — its pages: ${pagesList} (module: ${sec.title}) plus the module's customer journey in the cwd. ` +
                  `Write your result to "${outRel(sec.key)}" (criteria + references for THIS module only). ` +
                  `Do NOT write ux-research/report.json (top-level) and do NOT cover other modules — the daemon merges every module's slice.${kbDirective}` +
                  ` This is a FILE-ONLY stage: do not push anything.`
                : `Run the ux-spec skill for ONE MODULE of feature "${projectId}". ` +
                  `Author UX Spec screens ONLY for this module — its pages: ${pagesList} (module: ${sec.title}), guided by the module's customer journey + UX research in the cwd. ` +
                  `EVERY screen id MUST start with "${sec.key}__" so ids (and the wireframes/<id>.html files they name) never collide with other modules. ` +
                  `Write the module's screens to "${outRel(sec.key)}" AND each screen's "wireframes/<screen-id>.html" + each flow's "flows/<flow-id>.flow.json" into the SHARED wireframes/ and flows/ dirs. ` +
                  `Do NOT write the root -ux-spec.json and do NOT author other modules' screens — the daemon merges every module's screens.${platformDirective}${dsCriteriaKickoffDirective}` +
                  ` This is a FILE-ONLY stage: do not push anything.`;
          const run = design.runs.create({
            projectId,
            conversationId,
            assistantMessageId,
            clientRequestId: `${label}-${sec.key}-${randomUUID()}`,
            agentId: agentId!,
          });
          activeRuns.add(run);
          upsertMessage(db, conversationId, { id: `pipeline-user-${run.id}`, role: 'user', content: kickoff });
          upsertMessage(db, conversationId, {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            agentId: agentId!,
            agentName: getAgentDef(agentId!)?.name ?? agentId!,
            runId: run.id,
            runStatus: 'queued',
            startedAt: Date.now(),
          });
          design.runs.start(run, () =>
            startChatRun(
              {
                agentId: agentId!,
                projectId,
                conversationId,
                assistantMessageId,
                clientRequestId: run.clientRequestId,
                skillId: def.skillId,
                ...(wfDir ? { cwdSubdir: wfDir } : {}),
                model: modelPrefs.model ?? null,
                reasoning: modelPrefs.reasoning ?? null,
                message: kickoff,
                promptProfile: 'pipeline',
                pipelineUsesDesignSystem: def.acceptsDesignSystem === true,
              },
              run,
            ),
          );
          const final = await design.runs.wait(run);
          activeRuns.delete(run);
          db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`).run(final.status, Date.now(), assistantMessageId);
          task.status = final.status === 'succeeded' ? 'succeeded' : 'failed';
          persistTasks();
          done += 1;
          console.log(`[${label}] module ${done}/${sections.length} "${sec.title}" → ${final.status}`);
        };

        let cursor = 0;
        const worker = async () => {
          for (;;) {
            if (canceled) break;
            const i = cursor++;
            if (i >= sections.length) break;
            await runOneSection(sections[i]!, tasks[i]!).catch(() => {
              tasks[i]!.status = 'failed';
              persistTasks();
            });
          }
        };
        await Promise.all(Array.from({ length: Math.min(SECTION_FANOUT_CONCURRENCY, sections.length) }, worker));

        if (canceled) {
          setProjectPipelineStatus(db, projectId, pipelineId, { status: 'idle', subConversations: tasks.map((t) => ({ ...t })) });
          console.log(`[${label}] fan-out canceled by user`);
          return 'idle' as const;
        }

        // Merge each module's slice into the canonical output the downstream reads.
        const slices = await Promise.all(
          sections.map(async (sec) => {
            const parsed = await fs.promises
              .readFile(path.join(cwd, outRel(sec.key)), 'utf8')
              .then((t) => JSON.parse(t) as unknown)
              .catch(() => null);
            return { key: sec.key, title: sec.title, parsed };
          }),
        );
        const anySlice = slices.some((s) => s.parsed);
        const project = getProject(db, projectId);
        const nameSlug =
          (project?.name ?? 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'product';
        let canonicalRel: string;
        if (kind === 'cj') {
          const merged = mergeCjSections(slices.map((s) => ({ key: s.key, title: s.title, cj: s.parsed })));
          canonicalRel = `${nameSlug}-customer-journey.json`;
          await fs.promises.writeFile(path.join(cwd, canonicalRel), JSON.stringify(merged, null, 2), 'utf8');
        } else if (kind === 'ux-research') {
          const { report, reportMd } = mergeUxrSections(slices.map((s) => ({ key: s.key, title: s.title, uxr: s.parsed })));
          await fs.promises.mkdir(path.join(cwd, 'ux-research'), { recursive: true });
          canonicalRel = 'ux-research/report.json';
          await fs.promises.writeFile(path.join(cwd, canonicalRel), JSON.stringify(report, null, 2), 'utf8');
          await fs.promises.writeFile(path.join(cwd, 'ux-research/report.md'), reportMd, 'utf8');
        } else {
          const merged = mergeUxSpecSections(slices.map((s) => ({ key: s.key, title: s.title, spec: s.parsed })));
          canonicalRel = `${nameSlug}-ux-spec.json`;
          await fs.promises.writeFile(path.join(cwd, canonicalRel), JSON.stringify(merged, null, 2), 'utf8');
        }

        // RECONCILE PASS (fail-soft): the daemon merge is mechanical — it can't
        // spot personas/criteria that are the SAME under different wording, or
        // ids that collide across modules. One small agent run reads ONLY the
        // merged file (child outputs, not the raw docs, so no context blow-up)
        // and heals those seams in place. On any error the un-reconciled merge
        // stays — coverage is already guaranteed by the fan-out above.
        if (anySlice) {
          try {
            // Its own conversation + task (the reconcile is a distinct follow-up).
            const conversationId = `pipeline-conv-${randomUUID()}`;
            insertConversation(db, { id: conversationId, projectId, title: `${def.name} · Hợp nhất`, createdAt: Date.now(), updatedAt: Date.now() });
            const reconcileTask = { id: conversationId, title: 'Hợp nhất', status: 'running' as 'queued' | 'running' | 'succeeded' | 'failed' };
            tasks.push(reconcileTask);
            persistTasks();
            const assistantMessageId = `pipeline-assistant-${randomUUID()}`;
            const reconcileKickoff =
              kind === 'cj'
                ? `Reconcile the merged customer journey file "${canonicalRel}" in the cwd. It was assembled by concatenating per-module slices, so it may have seams: ` +
                  `(1) DUPLICATE PERSONAS — the same role under different names/wording; merge each duplicate set into ONE persona (keep the richest description) and update any references to it. ` +
                  `(2) COLLIDING IDS — persona/stage/flow ids (PRSN-/STG-/UFLW-/…) reused across modules; make every id UNIQUE while keeping each journey's internal references consistent. ` +
                  `Keep EVERY journey and its module tag — do not drop or rewrite journey content, only dedup personas and fix ids. Overwrite the SAME file. Do not push anything.`
                : kind === 'ux-research'
                  ? `Reconcile the merged UX research file "${canonicalRel}" in the cwd. It was assembled by concatenating per-module slices, so it may have DUPLICATE CRITERIA that state the same requirement under different wording. Merge each duplicate set into ONE criterion (keep the strongest wording, union the sources' used_for), keep criteria ids sequential (UXR-01, UXR-02, …), and recompute the summary counts (criteria/must/should/nice). Keep every distinct criterion — only dedup true duplicates. Overwrite the SAME file. Do not push anything.`
                  : `Reconcile the merged UX Spec file "${canonicalRel}" in the cwd (screens from per-module slices; ids are module-prefixed so they don't collide). Seams to heal: (1) DUPLICATE PERSONAS — merge same-role personas into one. (2) DANGLING NAV — every component's \`navigates_to\` must point at a screen id that EXISTS in \`screens\`; fix or drop targets that don't resolve (a CTA that crosses modules should point at the real target screen's id). (3) DUPLICATE SCREENS — if two modules authored the same screen, keep one. Do NOT rename screen ids (their wireframes/<id>.html files depend on them) and do NOT drop distinct screens. Overwrite the SAME file. Do not push anything.`;
            const rc = design.runs.create({
              projectId,
              conversationId,
              assistantMessageId,
              clientRequestId: `${label}-reconcile-${randomUUID()}`,
              agentId: agentId!,
            });
            activeRuns.add(rc);
            upsertMessage(db, conversationId, { id: `pipeline-user-${rc.id}`, role: 'user', content: reconcileKickoff });
            upsertMessage(db, conversationId, {
              id: assistantMessageId,
              role: 'assistant',
              content: '',
              agentId: agentId!,
              agentName: getAgentDef(agentId!)?.name ?? agentId!,
              runId: rc.id,
              runStatus: 'queued',
              startedAt: Date.now(),
            });
            design.runs.start(rc, () =>
              startChatRun(
                {
                  agentId: agentId!,
                  projectId,
                  conversationId,
                  assistantMessageId,
                  clientRequestId: rc.clientRequestId,
                  ...(wfDir ? { cwdSubdir: wfDir } : {}),
                  model: modelPrefs.model ?? null,
                  reasoning: modelPrefs.reasoning ?? null,
                  message: reconcileKickoff,
                },
                rc,
              ),
            );
            const rcFinal = await design.runs.wait(rc);
            activeRuns.delete(rc);
            db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`).run(rcFinal.status, Date.now(), assistantMessageId);
            reconcileTask.status = rcFinal.status === 'succeeded' ? 'succeeded' : 'failed';
            persistTasks();
            console.log(`[${label}] reconcile pass → ${rcFinal.status}`);
          } catch (error) {
            reconcileTask.status = 'failed';
            persistTasks();
            console.warn(`[${label}] reconcile pass failed (keeping mechanical merge):`, error);
          }
        }

        const next: 'succeeded' | 'failed' = anySlice ? 'succeeded' : 'failed';
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: next,
          subConversations: tasks.map((t) => ({ ...t })),
          ...(next === 'failed' ? { error: 'Bước chạy thất bại — xem hội thoại của bước để biết chi tiết' } : {}),
        });
        void commitHistory(projectRoot, { kind: 'run', pipelineId, status: next, by: historyActor() }).catch(() => null);
        console.log(`[${label}] section fan-out done: ${slices.filter((s) => s.parsed).length}/${sections.length} modules → ${next}`);
        return next;
      } catch (error) {
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: 'failed',
          error: String(error?.message ?? error),
        });
        console.warn(`[${label}] section fan-out failed:`, error);
        return 'failed' as const;
      } finally {
        pipelineCancelers.delete(cancelKey);
      }
    })();
    return { projectId, completion };
  };

  // UX Heuristic Review + UI-Spec (HTML) run PER SCREEN in parallel: reviewing
  // or rendering one screen never needs another screen, so one agent run per
  // screen (bounded pool, ONE shared conversation, history commit + clear ONCE
  // up front). The daemon then assembles the canonical output — a merged
  // heuristic-review/report.json, or a deterministic prototype/index.html hub.
  // `kind` picks ux-review vs ui-html (skill, per-screen output, assembly).
  const SCREEN_FANOUT_CONCURRENCY = 4;
  const runScreenFanout = (
    pipelineId: string,
    projectId: string,
    wfDir: string | null,
    resetScope: 'stage' | 'downstream' | undefined,
    kind: 'ux-review' | 'ui-html',
    screens: UiScreen[],
    designSystemId?: string | null,
  ): { projectId: string; completion: Promise<'succeeded' | 'failed' | 'idle'> } => {
    const cancelKey = `${projectId}::${pipelineId}`;
    const activeRuns = new Set<{ id: string }>();
    let canceled = false;
    registerPipelineCanceler(cancelKey, activeRuns, () => {
      canceled = true;
    });
    const completion: Promise<'succeeded' | 'failed' | 'idle'> = (async () => {
      const def = getPipelineDef(pipelineId)!;
      const label = kind;
      try {
        const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
        let agentId = typeof appConfig.agentId === 'string' && appConfig.agentId ? appConfig.agentId : null;
        if (!agentId) {
          const agents = await detectAgents(appConfig.agentCliEnv ?? {}, sandboxSkipProbe(appConfig)).catch(() => []);
          agentId = agents.find((a) => a.available)?.id ?? null;
        }
        if (!agentId) {
          const sandboxAgentId = await sandboxFallbackRuntimeId();
          if (sandboxAgentId) agentId = sandboxAgentId;
        }
        if (!agentId) throw new Error('No available agent is configured. Choose an agent in Settings first.');

        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'running', subConversations: [] });
        const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
        const cwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;

        const regenIds = new Set(stageRegenSet(pipelineId, resetScope === 'downstream'));
        await commitHistory(projectRoot, { kind: 'manual-edits', by: historyActor() }).catch(() => null);
        try {
          const snap = await snapshotPipelineCwd(projectRoot);
          for (const rel of snap.keys()) {
            // Target fence included: a target-scoped fan-out clears only its
            // own <wf>/<target>/ subtree (see relClearedByRegen).
            if (relClearedByRegen(rel, regenIds, wfDir)) {
              await fs.promises.rm(path.join(projectRoot, rel), { force: true }).catch(() => null);
            }
          }
        } catch (error) {
          console.warn(`[${label}] re-run clear failed (continuing):`, error);
        }
        for (const id of regenIds) {
          if (id !== pipelineId) setProjectPipelineStatus(db, projectId, id, { status: 'idle' });
        }

        // Pre-create one conversation per screen (all "queued") so the Status
        // modal shows X/N done + each screen's live state.
        const modelPrefs = appConfig.agentModels?.[agentId] ?? {};
        const dsId = designSystemId !== undefined ? designSystemId : (appConfig.designSystemId ?? null);
        const tasks = screens.map((s) => {
          const id = `pipeline-conv-${randomUUID()}`;
          insertConversation(db, { id, projectId, title: `${def.name} · ${s.name}`, createdAt: Date.now(), updatedAt: Date.now() });
          return { id, title: s.name, status: 'queued' as 'queued' | 'running' | 'succeeded' | 'failed' };
        });
        const persistTasks = () =>
          setProjectPipelineStatus(db, projectId, pipelineId, { subConversations: tasks.map((t) => ({ ...t })) });
        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'running', lastConversationId: tasks[0]?.id });
        persistTasks();

        let done = 0;
        const outRel = (s: UiScreen) => (kind === 'ux-review' ? `heuristic-review/${s.slug}/report.json` : `prototype/${s.slug}.html`);
        const runOneScreen = async (s: UiScreen, task: (typeof tasks)[number]): Promise<void> => {
          const conversationId = task.id;
          task.status = 'running';
          persistTasks();
          const assistantMessageId = `pipeline-assistant-${randomUUID()}`;
          const kickoff =
            kind === 'ux-review'
              ? `Run the heuristic-eval review for ONE screen of feature "${projectId}". ` +
                `Review ONLY the screen id "${s.id}" (${s.name}) — its wireframe "wireframes/${s.id}.html" and its spec in the UX Spec, against the usability heuristics + UX Research criteria in the cwd. ` +
                `Write your result to "heuristic-review/${s.slug}/report.json" (the per-screen report schema, screens[] holding just this one screen, screen id VERBATIM). ` +
                `Do NOT review any other screen, and do NOT write heuristic-review/report.json or summary.md — the pipeline merges those. FILE-ONLY: no push.`
              : `Run the html-interactive-prototype render for ONE screen of feature "${projectId}". ` +
                `Render ONLY the screen id "${s.id}" (${s.name}) from the UX Spec + its wireframe into a self-contained "prototype/${s.slug}.html" (plus its "prototype/${s.slug}.states.json" if multistep). ` +
                `Nav links to other screens use their "<target-slug>.html" filename. ` +
                `Do NOT render any other screen, and do NOT write prototype/index.html — the pipeline builds the hub. FILE-ONLY: no push.` +
                (await uiTargetDirective(wfDir));
          const run = design.runs.create({
            projectId,
            conversationId,
            assistantMessageId,
            clientRequestId: `${label}-${s.slug}-${randomUUID()}`,
            agentId: agentId!,
          });
          activeRuns.add(run);
          upsertMessage(db, conversationId, { id: `pipeline-user-${run.id}`, role: 'user', content: kickoff });
          upsertMessage(db, conversationId, {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            agentId: agentId!,
            agentName: getAgentDef(agentId!)?.name ?? agentId!,
            runId: run.id,
            runStatus: 'queued',
            startedAt: Date.now(),
          });
          design.runs.start(run, () =>
            startChatRun(
              {
                agentId: agentId!,
                projectId,
                conversationId,
                assistantMessageId,
                clientRequestId: run.clientRequestId,
                skillId: def.skillId,
                ...(def.extraSkillIds?.length ? { skillIds: def.extraSkillIds } : {}),
                ...(wfDir ? { cwdSubdir: wfDir } : {}),
                ...(kind === 'ui-html' ? { designSystemId: dsId } : {}),
                model: modelPrefs.model ?? null,
                reasoning: modelPrefs.reasoning ?? null,
                message: kickoff,
                promptProfile: 'pipeline',
                pipelineUsesDesignSystem: def.acceptsDesignSystem === true,
              },
              run,
            ),
          );
          const final = await design.runs.wait(run);
          activeRuns.delete(run);
          db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`).run(final.status, Date.now(), assistantMessageId);
          task.status = final.status === 'succeeded' ? 'succeeded' : 'failed';
          persistTasks();
          done += 1;
          console.log(`[${label}] screen ${done}/${screens.length} "${s.name}" → ${final.status}`);
        };

        let cursor = 0;
        const worker = async () => {
          for (;;) {
            if (canceled) break;
            const i = cursor++;
            if (i >= screens.length) break;
            await runOneScreen(screens[i]!, tasks[i]!).catch(() => {
              tasks[i]!.status = 'failed';
              persistTasks();
            });
          }
        };
        await Promise.all(Array.from({ length: Math.min(SCREEN_FANOUT_CONCURRENCY, screens.length) }, worker));

        if (canceled) {
          setProjectPipelineStatus(db, projectId, pipelineId, { status: 'idle', subConversations: tasks.map((t) => ({ ...t })) });
          console.log(`[${label}] screen fan-out canceled by user`);
          return 'idle' as const;
        }

        // Assemble the canonical output (daemon-owned, no LLM).
        let anyOut = false;
        if (kind === 'ux-review') {
          const slices = await Promise.all(
            screens.map(async (s) => {
              const report = await fs.promises
                .readFile(path.join(cwd, outRel(s)), 'utf8')
                .then((t) => JSON.parse(t) as unknown)
                .catch(() => null);
              return { id: s.id, name: s.name, report };
            }),
          );
          anyOut = slices.some((s) => s.report);
          const merged = mergeHeuristicScreens(slices);
          await fs.promises.mkdir(path.join(cwd, 'heuristic-review'), { recursive: true });
          await fs.promises.writeFile(path.join(cwd, 'heuristic-review/report.json'), JSON.stringify(merged, null, 2), 'utf8');
        } else {
          const rendered: UiScreen[] = [];
          for (const s of screens) {
            const exists = await fs.promises.stat(path.join(cwd, outRel(s))).then(() => true).catch(() => false);
            if (exists) rendered.push(s);
          }
          anyOut = rendered.length > 0;
          await fs.promises.mkdir(path.join(cwd, 'prototype'), { recursive: true });
          await fs.promises.writeFile(path.join(cwd, 'prototype/index.html'), renderPrototypeIndex(rendered), 'utf8');
        }

        const next: 'succeeded' | 'failed' = anyOut ? 'succeeded' : 'failed';
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: next,
          subConversations: tasks.map((t) => ({ ...t })),
          ...(next === 'failed' ? { error: 'Bước chạy thất bại — xem hội thoại của bước để biết chi tiết' } : {}),
        });
        void commitHistory(projectRoot, { kind: 'run', pipelineId, status: next, by: historyActor() }).catch(() => null);
        console.log(`[${label}] screen fan-out done → ${next}`);
        return next;
      } catch (error) {
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: 'failed',
          error: String(error?.message ?? error),
        });
        console.warn(`[${label}] screen fan-out failed:`, error);
        return 'failed' as const;
      } finally {
        pipelineCancelers.delete(cancelKey);
      }
    })();
    return { projectId, completion };
  };

  // Cancel a running pipeline stage. A fan-out stage has a registered canceler
  // (stops the pool + cancels every live sub-run); a single-agent stage is
  // canceled through its lastRunId. Idempotent — a stage that already finished
  // just returns { canceled: 'none' }.
  app.post('/api/pipelines/:projectId/:pipelineId/cancel', (req, res) => {
    const { projectId, pipelineId } = req.params;
    const cancel = pipelineCancelers.get(`${projectId}::${pipelineId}`);
    if (cancel) {
      cancel();
      return res.json({ ok: true, canceled: 'fanout' });
    }
    const st = getProjectPipelineState(db, projectId)[pipelineId] as { lastRunId?: string } | undefined;
    if (st?.lastRunId) {
      const run = design.runs.get(st.lastRunId);
      if (run) {
        try {
          design.runs.cancel(run);
        } catch {
          /* already terminal */
        }
      }
      return res.json({ ok: true, canceled: 'run' });
    }
    return res.json({ ok: true, canceled: 'none' });
  });

  // Viewport/responsive kickoff directive for a UI-terminal run, derived from
  // the run cwd's target segment. '' outside multi-target runs so legacy
  // single builds keep a byte-identical kickoff. All targets ship web tech —
  // the difference is responsive (websites) vs fixed phone viewport (the app).
  const uiTargetDirective = async (wfDir: string | null | undefined): Promise<string> => {
    if (!isTargetScopedWfDir(wfDir)) return '';
    const seg = wfDir!.split('/')[1]!;
    const { UI_TARGETS, UI_TARGET_IDS } = await import('@open-design/contracts');
    const t = UI_TARGET_IDS.map((id) => UI_TARGETS[id]).find((d) => d.dir === seg);
    if (!t) return '';
    return t.responsive
      ? ` Build target "${t.label}": a RESPONSIVE website. Every screen must adapt from desktop (~1440px) down to mobile (≤768px), following each screen's responsive_notes in the UX spec — navigation collapse, tables degrading to cards/lists, grid column count. A desktop-only layout is NOT done.`
      : ` Build target "${t.label}": a mobile APP rendered in a FIXED phone viewport (390px wide). Do NOT add responsive breakpoints or media queries — the layout is single-viewport by design.`;
  };

  // Resolve WHICH configured target a SINGLE-stage run builds (contract:
  // RunPipelineRequest.target). Shared stages (docs ingest, sharedAcrossTargets)
  // and single-build projects (no targets.json) resolve to null — run at the
  // workflow root, the legacy behavior. On a multi-target project the caller's
  // target (or the only configured one) maps through UI_TARGETS to the same
  // dir/platform/audience scoping the run-all orchestrator applies, and the
  // shared docs are refreshed into that target's cwd so relative ./docs inputs
  // resolve.
  const resolveRunTargetDir = async (
    projectId: string,
    def: NonNullable<ReturnType<typeof getPipelineDef>>,
    requested: import('@open-design/contracts').UiTarget | undefined,
  ): Promise<{
    dir: string;
    platform: import('@open-design/contracts').TargetPlatform;
    audience: import('@open-design/contracts').UiTargetAudience;
    /** targets.json v2 per-target design system, when configured. */
    designSystemId?: string;
  } | null> => {
    if (def.inputPlaceholder || def.sharedAcrossTargets === true) return null;
    const baseWfDir = workflowDirForPipeline(def.id);
    if (!baseWfDir) return null;
    const { UI_TARGETS, TARGETS_CONFIG_BASENAME, isUiTarget } = await import('@open-design/contracts');
    const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
    let cfg: any = null;
    try {
      const raw = await fs.promises.readFile(
        path.join(projectRoot, baseWfDir, TARGETS_CONFIG_BASENAME),
        'utf8',
      );
      cfg = JSON.parse(raw);
    } catch {
      /* no targets.json → single build */
    }
    const configured: import('@open-design/contracts').UiTarget[] = Array.isArray(cfg?.targets)
      ? cfg.targets.filter(isUiTarget)
      : [];
    const target = pickRunTarget(configured, requested);
    if (!target) return null;
    const targetDef = UI_TARGETS[target];
    const dsForTarget =
      typeof cfg?.designSystemByTarget?.[target] === 'string' && cfg.designSystemByTarget[target]
        ? (cfg.designSystemByTarget[target] as string)
        : undefined;
    // Same docs copy run-all performs (a real COPY — the sandbox bind-mounts
    // only the run cwd, a ../docs symlink would dangle inside the container).
    try {
      const srcDocs = path.join(projectRoot, baseWfDir, 'docs');
      const hasDocs = await fs.promises.access(srcDocs).then(() => true, () => false);
      if (hasDocs) {
        const dstDocs = path.join(projectRoot, baseWfDir, targetDef.dir, 'docs');
        await fs.promises.rm(dstDocs, { recursive: true, force: true }).catch(() => {});
        await fs.promises.cp(srcDocs, dstDocs, { recursive: true });
      }
    } catch (error) {
      console.warn(`[pipelines] staging docs into target ${targetDef.dir} failed:`, error);
    }
    return {
      dir: targetDef.dir,
      platform: targetDef.platform,
      audience: targetDef.audience,
      ...(dsForTarget ? { designSystemId: dsForTarget } : {}),
    };
  };

  // Whether a confluence-ingest stage's own declared output (`<wfDir>/docs/`)
  // already has ANY content — the docsFromUpload case: the user manually
  // uploaded via POST /api/projects/:id/files (UploadFilesModal's existing
  // mechanism). Shallow (one readdir) is enough — any entry at all means
  // something was uploaded, regardless of nesting.
  const hasPopulatedDocsDir = async (projectId: string, wfDir: string | null): Promise<boolean> => {
    const dir = path.join(PROJECTS_DIR, projectId, wfDir ?? '', 'docs');
    try {
      const entries = await fs.promises.readdir(dir);
      return entries.length > 0;
    } catch {
      return false;
    }
  };

  // CHẨN ĐOÁN stage kết thúc KHÔNG 'succeeded': best-effort, chỉ đọc đĩa — một
  // lỗi ở đây không được phép làm sai lệch kết quả của chính lượt chạy đang
  // được chẩn đoán (mọi lỗi nội bộ tự nuốt, không throw). Với mỗi output
  // pattern khai báo ở PipelineDef.outputs (xem outputMatches trong
  // pipelines.ts để biết cú pháp pattern), báo output đó có mặt trong cwd của
  // lượt chạy hay không, để log tự trả lời "stage có sinh ra file mong đợi
  // không" thay vì phải đoán.
  const describeStageOutputs = async (
    cwd: string | null,
    wfDir: string | null,
    outputs: readonly string[] | undefined,
  ): Promise<string> => {
    if (!cwd) return '(cwd unavailable)';
    const specs = outputs ?? [];
    if (specs.length === 0) return '(none declared)';
    const runCwd = wfDir ? path.join(cwd, wfDir) : cwd;
    const parts: string[] = [];
    for (const spec of specs) {
      try {
        if (spec.startsWith('*') || spec.startsWith('-')) {
          // Suffix pattern — shallow scan of the run cwd is enough for a
          // diagnostic (not a gate, so no recursive walk).
          const suffix = spec.startsWith('*') ? spec.slice(1) : spec;
          const entries = await fs.promises.readdir(runCwd).catch(() => [] as string[]);
          parts.push(`${spec}=${entries.some((e) => e.endsWith(suffix)) ? 'found' : 'missing'}`);
          continue;
        }
        const isDir = spec.endsWith('/');
        const abs = path.join(runCwd, isDir ? spec.slice(0, -1) : spec);
        if (isDir) {
          const entries = await fs.promises.readdir(abs).catch(() => null);
          parts.push(`${spec}=${entries && entries.length > 0 ? 'exists' : 'missing'}`);
        } else {
          const stat = await fs.promises.stat(abs).catch(() => null);
          parts.push(`${spec}=${stat?.isFile() ? 'exists' : 'missing'}`);
        }
      } catch (error) {
        parts.push(`${spec}=(check failed: ${String((error as Error)?.message ?? error)})`);
      }
    }
    return parts.join(', ');
  };

  const runPipeline = async (
    projectId: string,
    pipelineId: string,
    opts: import('./server-context.js').RunPipelineOptions = {},
  ) => {
    // One options object end-to-end (see RunPipelineOptions): the previous
    // positional tail silently desynced between the PipelineDeps interface and
    // this implementation — a route's `targets` argument landed in the
    // impl-only `audience` slot with no type error.
    const { resetScope, followLinks, includeDescendants, targets } = opts;
    let { input, source, designSystemId, platform, targetDir, audience } = opts;
    const def = getPipelineDef(pipelineId);
    if (!def) throw new Error(`Unknown pipeline ${pipelineId}`);
    const project = getProject(db, projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    // Multi-target single-stage run (routes/CLI name a target — or the project
    // has exactly one configured): scope it exactly like run-all would. Without
    // this, a re-run of one stage lands at the workflow ROOT while run-all's
    // outputs live under <workflow>/<target>/ — two diverging output trees.
    if (!targetDir) {
      const resolved = await resolveRunTargetDir(projectId, def, opts.target);
      if (resolved) {
        targetDir = resolved.dir;
        platform = platform ?? resolved.platform;
        audience = audience ?? resolved.audience;
        // Per-target design system (targets.json v2): an explicit per-run id
        // (or explicit null = "none") always wins; otherwise the target's own
        // library applies before the app-config default.
        if (designSystemId === undefined && def.acceptsDesignSystem && resolved.designSystemId) {
          designSystemId = resolved.designSystemId;
        }
      }
    }

    // Per-workflow output namespace: this pipeline's run + outputs live under
    // <projectDir>/<workflowId>/ so the two workflows never share a cwd (no
    // cross-reads, no clobbering, no status bleed). null → run at the cwd root.
    // A multi-target build appends the target subfolder (<workflowId>/<target>/)
    // so each target's stages get their own output subtree. wfDirForStage is
    // the single place this is computed — run-all's clear-on-launch scope
    // (runWorkflowAll) resolves the SAME pairs through it so the two can never
    // drift on what "this stage's directory" means.
    const { baseWfDir, wfDir } = wfDirForStage(pipelineId, targetDir);

    // Final docs-review confirmation is deterministic: aggregate the current
    // annotation ledger and publish one idempotent media artifact; no agent.
    if (def.skillId === 'docs-review-confirm') {
      const docsReviewConfirmation = (async () => {
        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'running' });
        try {
          const config = await readAppConfig(RUNTIME_DATA_DIR);
          const machine = getMachineUser();
          const installationId = config.installationId || 'unknown-install';
          const result = await confirmDocsReview({
            projectId,
            workflowRoot: path.join(PROJECTS_DIR, projectId, baseWfDir ?? 'docs-review'),
            installationId,
            user: machine?.email || config.feedbackUsername?.trim() || installationId,
            channel: isPackagedRuntime() ? 'packaged' : 'dev',
            ...(opts.docsReviewConfirmationId ? { confirmationId: opts.docsReviewConfirmationId } : {}),
            ...(opts.docsReviewSourceRunId ? { sourceRunId: opts.docsReviewSourceRunId } : {}),
          });
          setProjectPipelineStatus(db, projectId, pipelineId, { status: 'succeeded' });
          void commitHistory(path.join(PROJECTS_DIR, projectId), { kind: 'run', pipelineId, status: 'succeeded', by: historyActor() }).catch(() => null);
          console.log(`[docs-review-confirm] ${projectId} → ${result.mediaPath}`);
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setProjectPipelineStatus(db, projectId, pipelineId, { status: 'failed', error: message });
          console.warn(`[docs-review-confirm] ${projectId} failed:`, message);
          throw error;
        }
      })();
      const completion = docsReviewConfirmation.then(
        () => 'succeeded' as const,
        () => 'failed' as const,
      );
      return { projectId, completion, docsReviewConfirmation };
    }

    // Docs step run with UI targets picked (docs-to-ui): record targets.json
    // next to the shared docs so the post-docs stages know which products to
    // build. Written up front, independent of the docs fetch itself.
    if (def.inputPlaceholder && targets && targets.length > 0) {
      try {
        const { buildTargetsConfig, TARGETS_CONFIG_BASENAME } = await import('@open-design/contracts');
        const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
        await fs.promises.mkdir(path.join(projectRoot, baseWfDir ?? ''), { recursive: true });
        await fs.promises.writeFile(
          path.join(projectRoot, baseWfDir ?? '', TARGETS_CONFIG_BASENAME),
          `${JSON.stringify(buildTargetsConfig([...targets], opts.designSystemByTarget), null, 2)}\n`,
          'utf8',
        );
      } catch (error) {
        console.warn('[pipelines] writing targets.json (docs run) failed:', error);
      }
    }

    // Any stage running the confluence-ingest skill (docs-to-ui's `docs`,
    // docs-to-prd's `prd-docs`, docs-review's `dr-docs` — same skill,
    // independent workflows): Confluence source → the TOOL-ONLY path
    // (runDocsDeterministic above): a structured confluence source, or a
    // free-text input whose every line is a page URL/id, is fetched by the
    // daemon itself — no agent, no MCP. WP8 removed the legacy JIRA agent
    // path entirely: anything else (a JIRA key/JQL, a corpus file path,
    // plain text) fails fast below — every branch of this block returns, so
    // this skill NEVER reaches agent seeding. (The BAS source is LOCKED for
    // maintenance at the routes/CLI.)
    if (def.skillId === 'confluence-ingest') {
      // App Docs Pool source (§WP-4): GATE + deterministic copy, own runner —
      // evaluated before the Confluence-ref detection below (an app-pool
      // source carries no `ref`/free-text input to match against).
      if (source?.kind === 'app-pool') {
        return runDocsFromAppPool(pipelineId, projectId, wfDir, source.appId, source.paths, source, resetScope);
      }
      const inputRefs = (input ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const refs =
        source?.kind === 'confluence'
          ? [source.ref]
          : source === undefined && inputRefs.length > 0 && inputRefs.every(looksLikeConfluenceRef)
            ? inputRefs
            : null;
      if (refs) {
        const deterministicStudioCfg = (project.metadata as Record<string, unknown> | undefined)?.studioConfig as Record<string, unknown> | undefined;
        const deterministicAppId = typeof deterministicStudioCfg?.appId === 'string' ? deterministicStudioCfg.appId.trim() : '';
        if (deterministicAppId) {
          const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
          const runCwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;
          await stageLocalAppContext(PROJECTS_DIR, deterministicAppId, runCwd);
          const localApp = getPipelineApp(db, deterministicAppId);
          const designSystemId = localApp?.designSystemId ?? criteriaDesignSystemForProject(projectId) ?? null;
          const snapshot = await createAppContextVersion({
            projectsDir: PROJECTS_DIR,
            appId: deterministicAppId,
            appName: localApp?.name ?? deterministicAppId,
            designSystemId,
            docsReviewComponentSource: localApp?.docsReviewComponentSource ?? { mode: 'app-design-system' },
            figmaDesignSystemSource: figmaDesignSystemSourceForApp(db, localApp),
            designSystemDir: designSystemId ? await dsDirForId(designSystemId) : null,
          });
          let binding = featureContextBindingFromMetadata(project.metadata);
          if (!binding || binding.appId !== deterministicAppId) {
            binding = {
              schemaVersion: 1,
              appId: deterministicAppId,
              contextVersion: snapshot.manifest.contextVersion,
              contentDigest: snapshot.manifest.contentDigest,
              boundAt: new Date().toISOString(),
            };
            updateProject(db, projectId, { metadata: metadataWithFeatureContextBinding(project.metadata, binding) });
          }
          await stageBoundAppContextForRun({
            projectsDir: PROJECTS_DIR,
            appId: deterministicAppId,
            featureId: projectId,
            runId: `pipeline-docs-${randomUUID()}`,
            ...(baseWfDir ? { workflowId: baseWfDir } : {}),
            runCwd,
            binding,
          });
        }
        return runDocsDeterministic(pipelineId, projectId, wfDir, refs, input, source, resetScope, followLinks, includeDescendants);
      }

      // Reached only with NO Confluence ref and no source — i.e. nothing
      // this daemon knows how to fetch. Evaluated HERE, before this function's own re-run-clear
      // block runs (that block sits further down, after readAppConfig/agent
      // detection — every branch below either `return`s out through a
      // sibling deterministic runner with its OWN internal clear, or through
      // one of the two branches right here, neither of which clears
      // anything) — so `hasPopulatedDocsDir` always sees the PRE-clear state
      // and this decision can never race a wipe of the very docs/ it is
      // about to read or bless.
      if (inputRefs.length === 0 && source === undefined) {
        const docsPopulated = await hasPopulatedDocsDir(projectId, wfDir);
        if (docsPopulated) {
          // SUCCESS shortcut (docsFromUpload semantics): the docs are
          // already there (uploaded by hand — via the run-all modal's
          // docsFromUpload flag the ingest stage would simply be DROPPED
          // from the chain, and `deriveStateFromLocalFiles` alone marks it
          // 'succeeded' purely from file presence, no DB write, no
          // lastInput/lastSource; a DIRECT single-stage run on this exact
          // stage doesn't go through that filtering, so it must reach the
          // same outcome itself). NOTHING to fetch — seeding an agent here
          // is the other half of the same ghost-run bug the fail-fast below
          // closes (the agent inspects the project, finds docs/ already
          // populated, and either no-ops or worse "helpfully" edits them).
          // Mirrors the file-derived shape as closely as an explicit write
          // reasonably can: bare 'succeeded', plus one honest lastInput
          // marker (no fabricated lastSource — there is no real source to
          // describe structurally). No history commit, no downstream reset:
          // nothing was actually regenerated, so nothing downstream is stale.
          setProjectPipelineStatus(db, projectId, pipelineId, {
            status: 'succeeded',
            lastInput: '(docs/ đã có sẵn — không fetch nguồn nào lần này)',
          });
          console.log(
            `[pipelines] ${pipelineId} for ${projectId}: docs/ already populated, no input/source — marking succeeded without a fetch (docsFromUpload semantics, no agent seeded)`,
          );
          return { projectId, completion: Promise.resolve('succeeded' as const) };
        }
        // FAIL-FAST: nothing to ingest AND nothing already there either.
        // Seeding an agent run here gives it NOTHING to work with; it
        // politely no-ops and the stage flips 'succeeded' with an empty
        // docs/, which then cascades into a downstream stage failing with NO
        // error text — the exact incident this guards against. Do not seed a
        // conversation; fail the stage immediately with a clear message
        // instead, exactly like any other stage failure (run-all's runStage
        // sees this 'failed' completion and stops the chain the same way).
        const message =
          'Chưa cấu hình Nguồn tài liệu — tick trang trong tài liệu App (hoặc chọn trang Confluence) ở panel cấu hình rồi chạy lại.';
        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'failed', error: message });
        console.warn(
          `[pipelines] ${pipelineId} for ${projectId}: no input/source and docs/ empty — failing fast (no agent seeded)`,
        );
        return { projectId, completion: Promise.resolve('failed' as const) };
      }

      // HARD GATE (WP8): reached only with NON-empty input that isn't
      // Confluence-shaped (the fail-fast above already caught the all-empty
      // case). JIRA ingest is REMOVED — there is no more agent+mcp-atlassian
      // path to fall through to, so every input reaching here fails closed.
      // `looksLikeJiraInput` is kept only to pick a more specific message: a
      // real JIRA key/JQL (an issue key, a bare project key, or a JQL query)
      // gets an explicit "no longer supported" message; anything else (a
      // corpus file path pasted by mistake, plain text, a stale web bundle's
      // leftover value) gets the generic "not recognized" message. Neither
      // ever seeds a conversation — this closes the same ghost-run class of
      // bug the fail-fast above guards against (the live incident continued
      // after the first fail-fast round because this fallthrough used to
      // stay open for JIRA-shaped input).
      if (inputRefs.length > 0 && source === undefined) {
        const jiraShaped = looksLikeJiraInput(input ?? '');
        const message = jiraShaped
          ? 'Chỉ hỗ trợ Confluence URL — JIRA đã ngừng hỗ trợ. Chọn trang Confluence ở panel Nguồn tài liệu rồi chạy lại.'
          : 'Input không nhận dạng được (không phải link/id Confluence). Chọn nguồn ở panel Nguồn tài liệu (Confluence) rồi chạy lại.';
        setProjectPipelineStatus(db, projectId, pipelineId, { status: 'failed', error: message });
        console.warn(
          `[pipelines] ${pipelineId} for ${projectId}: input matches no Confluence ref${jiraShaped ? ' (JIRA input — no longer supported)' : ''} — failing fast (no agent seeded): ${JSON.stringify(input)}`,
        );
        return { projectId, completion: Promise.resolve('failed' as const) };
      }
    }

    // PRD Requirements Review → parallel per-page fan-out (its own runner, one agent
    // run per doc page, daemon-merged into review/index.json). Not a normal
    // single-agent stage.
    if (def.skillId === 'docs-mockup-review') {
      return runDocsMockupReviewFanout(pipelineId, projectId, wfDir, resetScope);
    }

    // Docs → Màn hình → Component (dr-comp v2) → fan-out theo MÀN HÌNH lấy từ
    // bước Đánh giá luồng UX: lượt role-map cho cả feature rồi mỗi màn một
    // lượt agent ghi comp/<KEY>.screen.json + wireframes/<KEY>.html; daemon
    // validate với danh mục DS + danh sách màn, gộp comp/index.json (2.0).
    if (def.skillId === 'docs-screen-components') {
      return runDocsComponentAuditFanout(pipelineId, projectId, wfDir, resetScope);
    }

    // Docs → Review tài liệu (dr-review) → parallel per-page fan-out: the
    // daemon clones every page into review/docs/ first, one agent run per
    // page edits its own clone, the daemon validates + daemon-merges into
    // review/index.json. Not a normal single-agent stage.
    if (def.skillId === 'docs-spec-review') {
      return runDocsReviewFanout(pipelineId, projectId, wfDir, resetScope);
    }

    // Customer Journey + UX Research → parallel PER-SECTION fan-out, but ONLY
    // when the docs form a multi-section tree (sub-tree scan). A whole-product
    // tree overwhelms one synthesis; a handful of flat pages does not, so a
    // <2-section source falls through to the normal single-agent path below.
    if (def.skillId === 'customer-journey-spec' || def.skillId === 'ux-research' || def.skillId === 'ux-spec') {
      const projectRoot = await ensureProject(PROJECTS_DIR, projectId).catch(() => null);
      if (projectRoot) {
        const cwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;
        const sections = await listSections(cwd).catch(() => [] as DocSection[]);
        if (sections.length >= 2) {
          const kind =
            def.skillId === 'customer-journey-spec' ? 'cj' : def.skillId === 'ux-research' ? 'ux-research' : 'ux-spec';
          console.log(`[${kind}] ${sections.length} module(s) → per-section fan-out`);
          return runSectionFanout(pipelineId, projectId, wfDir, resetScope, kind, sections, def.acceptsPlatform ? platform : undefined);
        }
      }
    }

    // UX Heuristic Review + UI-Spec (HTML) → parallel PER-SCREEN fan-out, when
    // the UX Spec has ≥2 screens (reviewing/rendering one screen is independent
    // work). A tiny spec (<2 screens) falls through to the normal single-agent
    // path below.
    if (def.skillId === 'heuristic-eval' || def.skillId === 'html-interactive-prototype') {
      const projectRoot = await ensureProject(PROJECTS_DIR, projectId).catch(() => null);
      if (projectRoot) {
        const cwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;
        const screens = await listScreens(cwd).catch(() => [] as UiScreen[]);
        if (screens.length >= 2) {
          const kind = def.skillId === 'heuristic-eval' ? 'ux-review' : 'ui-html';
          console.log(`[${kind}] ${screens.length} screen(s) → per-screen fan-out`);
          return runScreenFanout(pipelineId, projectId, wfDir, resetScope, kind, screens, designSystemId);
        }
      }
    }

    const appConfig = await readAppConfig(RUNTIME_DATA_DIR);

    // UI-Spec (React DS): hard gate (Phase C). This stage only makes sense
    // against a design system that ships a compiled react bundle (a Figma IR
    // import) — refuse the run otherwise. The actual staging into
    // <cwd>/react-ds/ happens further down, AFTER the re-run clear (which
    // would otherwise wipe the freshly staged files as stage outputs).
    let reactDsDirective = '';
    let reactDsStageId: string | null = null;
    if (def.skillId === 'ui-react-ds') {
      const effectiveDsId =
        designSystemId !== undefined ? designSystemId : (appConfig.designSystemId ?? null);
      const reactInfo =
        typeof effectiveDsId === 'string' && effectiveDsId
          ? await readReactBundleInfo(effectiveDsId)
          : null;
      if (!reactInfo) {
        throw new Error(
          'Stage "UI-Spec (React DS)" cần một design system có bộ React (import từ Figma IR). Hãy chọn design system dạng đó trong picker của stage trước khi chạy.',
        );
      }
      reactDsStageId = effectiveDsId as string;
      reactDsDirective =
        ` The selected design system's react bundle IS STAGED at "./react-ds/src/ds/" (components/ui + components/icons + lib/runtime + styles/globals.css + docs/catalog.md — ${reactInfo.components} components, ${reactInfo.icons} icons) and its icon SVGs at "./react-ds/public/assets/". Compose screens from it per the active skill; never edit or regenerate anything under src/ds/ or public/.`;
      // Human-locked components (the ux-spec preview's "Gán component" UI
      // writes them into the wireframes' `data-comp` attribute): surface the list in the
      // kickoff so the agent treats them as a CONTRACT up front instead of
      // discovering them file by file — the verify gate hard-fails on any
      // locked component that isn't used.
      try {
        const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
        const runCwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;
        const wireDir = path.join(runCwd, 'wireframes');
        const locked = new Set<string>();
        for (const entry of await fs.promises.readdir(wireDir).catch(() => [] as string[])) {
          if (!entry.endsWith('.html')) continue;
          const raw = await fs.promises.readFile(path.join(wireDir, entry), 'utf8').catch(() => null);
          if (!raw) continue;
          for (const m of raw.matchAll(/\bdata-comp\s*=\s*[\"']([^\"']+)[\"']/gi)) locked.add(m[1]!);
        }
        if (locked.size > 0) {
          const listed = [...locked].slice(0, 24).join(', ');
          reactDsDirective += ` ${locked.size} component(s) are HUMAN-LOCKED in ../wireframes/*.html via the \`data-comp\` attribute (${listed}${locked.size > 24 ? ', …' : ''}) — every locked wireframe node MUST be built with exactly that ds component (the verify gate fails otherwise); read each wire file to see which node locks which component.`;
        }
      } catch {
        /* best-effort — no wireframes yet is fine */
      }
    }

    let agentId = typeof appConfig.agentId === 'string' && appConfig.agentId
      ? appConfig.agentId
      : null;
    if (!agentId) {
      const agents = await detectAgents(appConfig.agentCliEnv ?? {}, sandboxSkipProbe(appConfig)).catch(() => []);
      agentId = agents.find((agent) => agent.available)?.id ?? null;
    }
    // Volume-only machines: no host install, but the sandbox provides claude.
    if (!agentId) {
      const sandboxAgentId = await sandboxFallbackRuntimeId();
      if (sandboxAgentId) agentId = sandboxAgentId;
    }
    if (!agentId) throw new Error('No available agent is configured. Choose an agent in Settings first.');

    const now = Date.now();
    const conversationId = `pipeline-conv-${randomUUID()}`;
    const assistantMessageId = `pipeline-assistant-${randomUUID()}`;
    // projectId is the pipeline project's id. Named in the kickoff only to scope
    // the run; every stage is FILE-ONLY so it is not a push target.
    const trimmedInput = typeof input === 'string' ? input.trim() : '';
    // A combined pipeline (extraSkillIds) activates several skills in one run; tell
    // the agent to complete EACH skill's workflow and produce ALL their outputs.
    const skillDirective = def.extraSkillIds?.length
      ? 'This pipeline runs multiple skills in one go — follow EACH active skill\'s workflow and produce ALL of their outputs.'
      : "Follow the active skill's workflow exactly.";
    // Two source tracks (kept deliberately separate):
    //   • BAS document  → the daemon pre-fetches it via the BAS KG API into
    //     ./docs/source/bas/ below (deterministic, no per-user credential); the
    //     skill then just normalizes those local files.
    //   • Confluence link / JIRA key → handed to the AGENT as input. The skill
    //     fetches it ITSELF via the Atlassian MCP (Jira + Confluence Data Center)
    //     and writes ./docs/source/. The BE does NOT pre-fetch Confluence (the
    //     BAS gateway's confluence_* tools need a credential it can't link).
    const basSource = source?.kind === 'bas' ? source : undefined;
    const confluenceRef = source?.kind === 'confluence' ? source.ref.trim() : '';
    const agentInput = trimmedInput || confluenceRef;
    const sourceDirective = basSource
      ? ' The source documents have already been fetched into ./docs/source/bas/ — read every Markdown file there and normalize them into the stage output (do NOT call any external doc API yourself).'
      : agentInput
        ? ` Input/source for this run: ${agentInput}. Fetch it YOURSELF via the Atlassian MCP (Jira + Confluence Data Center) — a Confluence page link via the skill's Confluence export, a JIRA key/JQL via the Jira tools — following the active skill's workflow.`
        : '';
    // Every stage is file-only: produce the output file(s) only — the
    // pipeline reads them directly and syncs them to the media store
    // separately (uploadProjectFiles). There is no graph store to push to.
    const graphDirective = " This is a FILE-ONLY stage: produce the output file(s) only — the pipeline reads them directly. Do not push anything anywhere.";
    // Target platform (UX stage picker / CLI --platform). Only emitted when the
    // stage opted in AND the caller chose one — no choice keeps the kickoff
    // byte-identical to the legacy one, so existing projects are unaffected.
    const effectivePlatform = def.acceptsPlatform ? platform : undefined;
    // Platform encodes viewport semantics (all targets ship web tech, there is
    // no native track): WEBSITE = RESPONSIVE (desktop ↔ ≤768px), MOBILE = a
    // fixed phone viewport with no adaptive behavior.
    const platformDirective = effectivePlatform === 'web'
      ? ' Target platform for this run: WEBSITE — every screen in the UX spec MUST set `layout: "web"` and use web-appropriate patterns (tables over card lists where fitting, sidebar/top navigation instead of bottom tabs, wider multi-column forms).' +
        ' The website is RESPONSIVE: give every screen a `responsive_notes` field describing how its layout adapts from desktop (~1440px) down to mobile (≤768px) — navigation collapse, tables degrading to cards/lists, grid column count, which controls move where. Wireframes stay desktop-first (one wireframe per screen, no separate mobile wireframe).'
      : effectivePlatform === 'mobile'
        ? ' Target platform for this run: MOBILE — every screen in the UX spec MUST set `layout: "mobile"`. The app renders in a FIXED phone viewport: no responsive/adaptive behavior, no `responsive_notes`.'
        : '';
    // Audience (multi-target runs only), paired with the platform directive: two
    // WEB targets differ ONLY here, and the docs folder is shared across every
    // target — so the agent is told both who it is building for and to leave the
    // other audience's material alone.
    const audienceDirective =
      !audience
        ? ''
        : audience === 'backoffice'
          ? ' Audience for this run: BACKOFFICE (internal operators / admins) — build ONLY the screens the docs describe for internal staff. The docs folder is SHARED across targets, so skip end-customer material entirely; prefer dense tables, bulk actions, filters, and audit/permission affordances.'
          : ' Audience for this run: END CUSTOMER — build ONLY the screens the docs describe for the end user. The docs folder is SHARED across targets, so skip internal/backoffice-only material entirely.';
    // RE-RUN nudge: if this stage already succeeded once, its old outputs are
    // being cleared below — tell the agent to regenerate from scratch instead
    // of seeing leftover files and declaring the work already done.
    const isRerun = getProjectPipelineState(db, projectId)[pipelineId]?.status === 'succeeded';
    const rerunDirective = isRerun
      ? ' This is a RE-RUN: the previous outputs for this stage have been cleared — regenerate every deliverable from scratch. Do NOT assume prior work exists or skip steps because a file seems present.'
      : '';
    // UX knowledge base directive (any stage running the ux-research skill —
    // docs-to-ui's `ux-research`, docs-to-prd's `prd-ux-research`): the DAEMON
    // resolves the KB (env override → media-store sync → local home folder —
    // see ux-kb-sync.ts) and STAGES it into the run cwd as `./.ux-kb` — a
    // dot-folder, so snapshot/push/re-run-clear never see it. The agent gets a
    // RELATIVE path that works on the host and inside any future container
    // sandbox, with zero probing tool-calls (a past run burnt calls hunting a
    // `~/…` path that file tools never expand, then wrongly declared the KB
    // unavailable). Staging failure falls back to the absolute-path directive.
    let kbDirective = '';
    if (def.skillId === 'ux-research') {
      const kb = await resolveUxKbDir(RUNTIME_DATA_DIR);
      if (kb.dir) {
        const kbTail =
          ' Do NOT go looking anywhere else and do NOT report the knowledge base unavailable. Criteria must cite its sources, and attach Growth.Design illustration image URLs where the case studies have them.';
        try {
          const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
          const runCwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;
          const staged = path.join(runCwd, '.ux-kb');
          await fs.promises.rm(staged, { recursive: true, force: true });
          await fs.promises.cp(kb.dir, staged, { recursive: true });
          kbDirective = ` The UX knowledge base IS PRESENT at "./.ux-kb" INSIDE your working directory (staged by the daemon${
            kb.source === 'media' ? ', synced from the media store' : ''
          }). Use it via relative paths — e.g. \`python3 ./.ux-kb/scripts/search.py <keywords>\`.${kbTail}`;
        } catch (error) {
          console.warn('[ux-kb] staging into run cwd failed — falling back to absolute path:', error);
          kbDirective = ` The UX knowledge base IS PRESENT at "${kb.dir}" (verified by the daemon). Always use that ABSOLUTE path — e.g. \`python3 "${kb.dir}/scripts/search.py" <keywords>\` — never a \`~/…\` form.${kbTail}`;
        }
      } else {
        kbDirective =
          ' The daemon verified there is NO UX knowledge base available (no env override, nothing on the media store, no local folder) — produce the fallback report (knowledge_base: "unavailable") without hunting for it.';
      }
    }
    // App > feature scoping: the pipeline runs for a FEATURE; its parent App
    // is local metadata. Media is a publish target and is never consulted to
    // choose a run's context version.
    const studioCfg = (project.metadata as Record<string, unknown> | undefined)?.studioConfig as
      | Record<string, unknown>
      | undefined;
    const localAppId = typeof studioCfg?.appId === 'string' ? studioCfg.appId.trim() : '';
    const featureAppName =
      studioCfg && typeof studioCfg.appName === 'string' ? studioCfg.appName : '';
    const featureScope = featureAppName
      ? `feature "${projectId}" of app "${featureAppName}"`
      : `feature "${projectId}"`;

    // Snapshot the App's LOCAL mutable context, then stage the immutable
    // version deliberately bound to this Feature. A legacy Feature receives a
    // one-time binding to current; an existing binding never auto-upgrades.
    let appCtxDirective = '';
    let appDocsDirective = '';
    let dsCriteriaKickoffDirective = '';
    let versionedContextStaged = false;
    if (localAppId) {
      try {
        const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
        const runCwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;
        // Compatibility import: old App context lived only on media. Import it
        // once into the local mutable source before creating the first version.
        await stageLocalAppContext(PROJECTS_DIR, localAppId, runCwd);
        const localApp = getPipelineApp(db, localAppId);
        const designSystemId = localApp?.designSystemId ?? criteriaDesignSystemForProject(projectId) ?? null;
        const snapshot = await createAppContextVersion({
          projectsDir: PROJECTS_DIR,
          appId: localAppId,
          appName: (localApp?.name ?? featureAppName) || localAppId,
          designSystemId,
          docsReviewComponentSource: localApp?.docsReviewComponentSource ?? { mode: 'app-design-system' },
          figmaDesignSystemSource: figmaDesignSystemSourceForApp(db, localApp),
          designSystemDir: designSystemId ? await dsDirForId(designSystemId) : null,
        });
        let binding = featureContextBindingFromMetadata(project.metadata);
        if (!binding || binding.appId !== localAppId) {
          binding = {
            schemaVersion: 1,
            appId: localAppId,
            contextVersion: snapshot.manifest.contextVersion,
            contentDigest: snapshot.manifest.contentDigest,
            boundAt: new Date().toISOString(),
          };
          updateProject(db, projectId, {
            metadata: metadataWithFeatureContextBinding(project.metadata, binding),
          });
        }
        const staged = await stageBoundAppContextForRun({
          projectsDir: PROJECTS_DIR,
          appId: localAppId,
          featureId: projectId,
          runId: conversationId,
          ...(baseWfDir ? { workflowId: baseWfDir } : {}),
          runCwd,
          binding,
        });
        versionedContextStaged = true;
        if (def.id !== 'docs') appCtxDirective = appContextDirective(staged.stagedAppContext);
        appDocsDirective = appDocsPoolDirective(
          staged.stagedDocs > 0 ? ['_versioned-context'] : [],
          def.id,
        );
        if (def.usesDesignSystemCriteria) {
          dsCriteriaKickoffDirective = dsCriteriaDirective({
            hasRules: staged.stagedDesignSystem.includes('criteria/rules.md'),
            hasComponents: staged.stagedDesignSystem.includes('criteria/components.md'),
          });
        }
      } catch (error) {
        // A bound immutable version is a reproducibility guarantee. Never
        // silently substitute current App data when it is corrupt/missing.
        throw error;
      }
    }

    // Legacy fallback for unversioned/unlinked projects only.
    if (!versionedContextStaged) {
      try {
        if (localAppId) {
          const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
          const runCwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;
          const { staged } = await stageAppDocsPool(PROJECTS_DIR, localAppId, runCwd);
          appDocsDirective = appDocsPoolDirective(staged, def.id);
        }
      } catch (error) {
        console.warn('[app-pool] staging docs-app failed (continuing without it):', error);
      }
      if (def.usesDesignSystemCriteria) {
        try {
          const criteriaDsId = criteriaDesignSystemForProject(projectId);
          if (criteriaDsId) {
            const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
            const runCwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;
            await copyDsCriteriaIntoWorkflow(criteriaDsId, runCwd, dsDirForId);
            const [hasRules, hasComponents] = await Promise.all([
              fs.promises.stat(path.join(runCwd, 'criteria', 'rules.md')).then((s) => s.isFile()).catch(() => false),
              fs.promises.stat(path.join(runCwd, 'criteria', 'components.md')).then((s) => s.isFile()).catch(() => false),
            ]);
            dsCriteriaKickoffDirective = dsCriteriaDirective({ hasRules, hasComponents });
          }
        } catch (error) {
          console.warn('[ds-criteria] staging into run cwd failed (continuing without it):', error);
        }
      }
    }
    // UI terminals (ui-html / ui-react / ui-react-ds) get the target-viewport
    // directive on multi-target runs (responsive website vs fixed-viewport app).
    const uiDirective = def.id.startsWith('ui-') ? await uiTargetDirective(wfDir) : '';
    const kickoff = `Run the "${def.name}" pipeline for ${featureScope}. ${skillDirective}${sourceDirective}${platformDirective}${audienceDirective}${uiDirective}${rerunDirective}${kbDirective}${appCtxDirective}${appDocsDirective}${dsCriteriaKickoffDirective}${reactDsDirective}${graphDirective}`;

    // BAS document pre-fetch (BE owns the BAS KG HTTP) — done BEFORE any
    // conversation/run state is created so a fetch failure aborts cleanly with no
    // orphaned 'running' run. Writes Markdown under the project cwd's
    // ./docs/source/bas/; the skill then normalizes those local files. Confluence
    // is NOT pre-fetched here — the agent fetches it via the Atlassian MCP.
    if (basSource) {
      const ep = await resolveBasEndpoint(RUNTIME_DATA_DIR);
      if (!ep) {
        throw new Error(
          'BAS is not configured (set BAS_MCP_URL + BAS_MCP_TOKEN in the daemon environment).',
        );
      }
      const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
      // Pre-fetch into the same per-workflow folder the agent will run in, so
      // the relative ./docs/source/ path in the kickoff resolves correctly.
      const cwd = wfDir ? path.join(projectRoot, wfDir) : projectRoot;
      const files = await fetchSourceFiles(ep, basSource);
      for (const f of files) {
        const abs = path.join(cwd, f.relPath);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, f.content, 'utf8');
      }
      console.log(`[pipelines] pre-fetched ${files.length} BAS source file(s) into cwd for ${projectId}`);
    }

    insertConversation(db, {
      id: conversationId,
      projectId,
      title: def.name,
      createdAt: now,
      updatedAt: now,
    });

    const run = design.runs.create({
      projectId,
      conversationId,
      assistantMessageId,
      clientRequestId: `pipeline-${pipelineId}-${randomUUID()}`,
      agentId,
    });
    upsertMessage(db, conversationId, {
      id: `pipeline-user-${run.id}`,
      role: 'user',
      content: kickoff,
    });
    upsertMessage(db, conversationId, {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      agentId,
      agentName: getAgentDef(agentId)?.name ?? agentId,
      runId: run.id,
      runStatus: 'queued',
      startedAt: now,
    });

    setProjectPipelineStatus(db, projectId, pipelineId, {
      status: 'running',
      lastRunId: run.id,
      lastConversationId: conversationId,
      // Single-agent run → clear any per-task list left by a prior fan-out run.
      subConversations: [],
      // Persist WHAT this run was fed (Confluence link / JQL / BAS document)
      // so the stage's "run info" panel can answer "where did this output
      // come from?" long after the run finished.
      ...(agentInput ? { lastInput: agentInput } : {}),
      ...(source ? { lastSource: source } : {}),
      ...(effectivePlatform ? { lastPlatform: effectivePlatform } : {}),
    });

    // Which stages this run wipes + regenerates: just this stage, or (cascade)
    // this stage plus everything that depends on it. Used for the local clear,
    // the downstream status reset, and the pull exclusion below.
    const regenIds = new Set(stageRegenSet(pipelineId, resetScope === 'downstream'));

    const pipelineCwd = await ensureProject(PROJECTS_DIR, projectId).catch(() => null);
    if (pipelineCwd) {
      // Fence any manual edits into their own history commit so the diff of
      // the coming run is purely the run's output.
      await commitHistory(pipelineCwd, { kind: 'manual-edits', by: historyActor() }).catch(() => null);
      // RE-RUN clear: delete the local output files of every stage in regenIds
      // so the agent regenerates instead of finding leftovers and stopping. The
      // manual-edits commit above already snapshotted them → recoverable via the
      // project history. relClearedByRegen = path-derived ownership PLUS the
      // target fence: a target-scoped run clears ONLY its own <wf>/<target>/
      // subtree, never a sibling target's outputs of the same stage.
      try {
        const snap = await snapshotPipelineCwd(pipelineCwd);
        for (const rel of snap.keys()) {
          if (relClearedByRegen(rel, regenIds, wfDir)) {
            await fs.promises.rm(path.join(pipelineCwd, rel), { force: true }).catch(() => null);
          }
        }
      } catch (error) {
        console.warn('[pipelines] re-run clear failed (continuing):', error);
      }
    }
    // Downstream stages are now stale — drop their local run state so the stepper
    // shows them as needing a re-run. The stage being run flips to running above.
    for (const id of regenIds) {
      if (id !== pipelineId) setProjectPipelineStatus(db, projectId, id, { status: 'idle' });
    }
    // Cross-device: pull this stage's UPSTREAM inputs from the store into the cwd
    // first, so they're present even on a device that never ran them. Scoped to
    // `upstreamStages` (never downstream) so running a middle stage like
    // ux-review can't resurrect the UI outputs; `missingOnly` so it never
    // overwrites a locally-edited or freshly-regenerated input. EXCLUDE regenIds
    // for good measure (a re-run just cleared those).
    if (pipelineCwd) {
      try {
        const n = await pullPipelineFiles(projectId, pipelineCwd, upstreamStages(pipelineId), [...regenIds], true);
        if (n) console.log(`[pipelines] pulled ${n} input file(s) into cwd for ${projectId}`);
      } catch (error) {
        console.warn('[pipelines] pull input files failed (continuing):', error);
      }
    }
    // Stage the react bundle AFTER the re-run clear above — react-ds/** is this
    // stage's own output tree, so a clear running later would wipe the freshly
    // staged bundle (empty src/ds skeleton, agent reports it missing).
    if (def.skillId === 'ui-react-ds' && reactDsStageId) {
      await stageReactDsBundle(reactDsStageId, projectId, wfDir);
    }
    // dr-flow (docs-flow-ux): decode every draw.io / Mermaid diagram the docs
    // carry into ./flows/<FLOW-ID>/ BEFORE the agent starts (after the re-run
    // clear above, which wipes flows/). The skill reads flows/_inputs.json.
    if (def.skillId === 'docs-flow-ux' && pipelineCwd) {
      const runCwd = wfDir ? path.join(pipelineCwd, wfDir) : pipelineCwd;
      try {
        const prep = await prepareFlowUxInputs(runCwd);
        console.log(
          `[flow-ux] ${projectId}: prepared ${prep.inputs.length} diagram flow(s)` +
            (prep.normalizedPages.length ? `, normalized ${prep.normalizedPages.length} page(s)` : ''),
        );
      } catch (error) {
        console.warn('[flow-ux] prepare failed (continuing in text-only mode):', error);
      }
    }
    const modelPrefs = appConfig.agentModels?.[agentId] ?? {};
    design.runs.start(run, () => startChatRun({
      agentId,
      projectId,
      conversationId: run.conversationId,
      assistantMessageId: run.assistantMessageId,
      clientRequestId: run.clientRequestId,
      skillId: def.skillId,
      ...(def.extraSkillIds?.length ? { skillIds: def.extraSkillIds } : {}),
      ...(wfDir ? { cwdSubdir: wfDir } : {}),
      // Per-run choice (from the ui-html picker / CLI --design-system) wins; when
      // the caller didn't specify one, fall back to the global app-config default.
      designSystemId: designSystemId !== undefined ? designSystemId : (appConfig.designSystemId ?? null),
      model: modelPrefs.model ?? null,
      reasoning: modelPrefs.reasoning ?? null,
      message: kickoff,
      // Lean unattended prompt: no chat charter / memory / DS blocks unless
      // this stage generates UI (see ComposeInput.promptProfile).
      promptProfile: 'pipeline',
      pipelineUsesDesignSystem: def.acceptsDesignSystem === true,
    }, run));

    // Reflect terminal status back into the gate so downstream pipelines unlock.
    // Captured as `completion` (never rejects — errors resolve to 'failed') so
    // the run-all orchestrator can await THIS stage before chaining the next;
    // routes returning the start payload must strip it before JSON-serializing.
    const completion: Promise<'succeeded' | 'failed' | 'idle'> = (async () => {
      try {
        const finalStatus = await design.runs.wait(run);
        db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`)
          .run(finalStatus.status, Date.now(), assistantMessageId);
        let next: 'succeeded' | 'failed' | 'idle' = finalStatus.status === 'succeeded'
          ? 'succeeded'
          : finalStatus.status === 'canceled'
            ? 'idle'
            : 'failed';
        let finalizeError: string | null = null;
        // dr-flow (docs-flow-ux): the agent emitted small JSON files; the daemon
        // now applies patch.json -> proposed.drawio, derives flowchart.json and
        // rebuilds flows/index.json. A finalize failure IS a stage failure —
        // downstream stages need those files.
        if (next === 'succeeded' && def.skillId === 'docs-flow-ux' && pipelineCwd) {
          const runCwd = wfDir ? path.join(pipelineCwd, wfDir) : pipelineCwd;
          try {
            const fin = await finalizeFlowUx(runCwd);
            console.log(`[flow-ux] ${projectId}: finalized ${fin.index.length} flow(s)${fin.warnings.length ? ` — ${fin.warnings.length} warning(s): ${fin.warnings.join(' | ')}` : ''}`);
          } catch (error) {
            finalizeError = `Hoàn tất sơ đồ luồng thất bại: ${String((error as Error)?.message ?? error)}`;
            console.warn('[flow-ux] finalize failed:', error);
            next = 'failed';
          }
        }
        // CHẨN ĐOÁN "stage chết trong run-all nhưng chạy lẻ thành công, không
        // có bảng `runs` để khám nghiệm lượt đã hỏng" (xem incident docs-map):
        // đây là chỗ DUY NHẤT vừa biết trạng thái cuối vừa còn cầm `run` object
        // — chạy cho CẢ run-all lẫn kích hoạt lẻ vì cả hai đi qua đúng một
        // `runPipeline`. Chỉ log khi KHÔNG 'succeeded'; đường thành công không
        // được thêm log. Toàn bộ khối tự nuốt lỗi — chẩn đoán không được phép
        // làm sai lệch (hay làm hỏng) kết quả thật của lượt chạy.
        try {
          const finalClassification = next;
          if (finalClassification !== 'succeeded') {
            const assistantRow = db
              .prepare(`SELECT content FROM messages WHERE id = ?`)
              .get(assistantMessageId) as { content?: string } | undefined;
            const assistantContentLength =
              typeof assistantRow?.content === 'string' ? assistantRow.content.length : 0;
            const why =
              finalStatus.status === 'canceled'
                  ? `agent run status was 'canceled' — mapped to 'idle'`
                  : `agent run status was '${finalStatus.status}' — mapped to 'failed'`;
            const outputsSummary = await describeStageOutputs(pipelineCwd, wfDir, def.outputs).catch(
              (error) => `(check failed: ${String(error?.message ?? error)})`,
            );
            console.warn(
              [
                `[pipelines] STAGE NOT SUCCEEDED — project=${projectId} stage=${pipelineId} workflow=${workflowDirForPipeline(pipelineId) ?? '(none)'} run=${run.id}`,
                `  final=${finalClassification} — ${why}`,
                `  agent run: exitCode=${finalStatus.exitCode ?? '(null)'} signal=${finalStatus.signal ?? '(null)'} errorCode=${finalStatus.errorCode ?? '(null)'} error=${finalStatus.error ?? '(none)'}`,
                `  assistant message ${assistantMessageId}: content length=${assistantContentLength}${assistantContentLength === 0 ? ' (EMPTY)' : ''}`,
                `  expected outputs: ${outputsSummary}`,
              ].join('\n'),
            );
          }
        } catch (diagError) {
          console.warn('[pipelines] stage-end diagnostic logging failed (continuing):', diagError);
        }
        // Error report to the developers (error-reports.ts): hand the hook
        // fired by the failed-status write below everything only this block
        // knows — agent, exit code, model, outputs summary, stderr tail.
        if (next === 'failed') {
          try {
            attachStageFailureContext(projectId, pipelineId, {
              runId: run.id,
              agentId,
              model: modelPrefs.model ?? null,
              reasoning: modelPrefs.reasoning ?? null,
              exitCode: finalStatus.exitCode ?? null,
              signal: finalStatus.signal ?? null,
              errorCode: finalStatus.errorCode ?? null,
              durationMs:
                typeof finalStatus.updatedAt === 'number' && typeof finalStatus.createdAt === 'number'
                  ? finalStatus.updatedAt - finalStatus.createdAt
                  : null,
              outputs: await describeStageOutputs(pipelineCwd, wfDir, def.outputs).catch(() => null),
              finalStatus: finalStatus.status ?? null,
              stderrTail: (run as { stderrTail?: string }).stderrTail ?? null,
              stdoutTail: (run as { stdoutTail?: string }).stdoutTail ?? null,
              workflowId: workflowDirForPipeline(pipelineId) ?? null,
            });
          } catch {
            /* diagnostics must never affect the run result */
          }
        }
        // Upload to the media store is MANUAL (the share button /
        // POST /api/pipelines/upload). The run only produces files locally and
        // updates the gate; the user uploads when ready.
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: next,
          // Agent-run failure: prefer the run's OWN error (design.runs' error
          // text — see extractErrorDetails in runs.ts, e.g. an agent CLI
          // crash or an MCP/tool failure), then the wireframe-gate-specific
          // reason, then the generic fallback — never leave a failed status
          // with nothing for "Xem lỗi" to show.
          ...(next === 'failed'
              ? { error: finalizeError || finalStatus.error || 'Bước chạy thất bại — xem hội thoại của bước để biết chi tiết' }
              : {}),
        });
        // History snapshot: this run's outputs become one .odhistory commit —
        // re-running the stage overwrites files but never erases this state.
        if (pipelineCwd) {
          void commitHistory(pipelineCwd, {
            kind: 'run',
            pipelineId,
            runId: run.id,
            status: next,
            by: historyActor(),
            ...(agentInput ? { input: agentInput } : {}),
          }).catch(() => null);
        }
        // A failed wireframe gate also stops the run-all chain — ux-review and
        // the UI terminals would otherwise build on a broken layout contract.
        return next;
      } catch (error) {
        setProjectPipelineStatus(db, projectId, pipelineId, {
          status: 'failed',
          error: String(error?.message ?? error),
        });
        console.warn('[pipelines] run failed:', error);
        return 'failed' as const;
      }
    })();

    return { projectId, conversationId, agentRunId: run.id, completion };
  };

  // ── Run-all orchestrator: the whole workflow with one click ───────────────
  // Runs the workflow's stages SEQUENTIALLY in dependency order, auto-chaining:
  // each stage is a NORMAL runPipeline run (same seeding/clearing/history);
  // when its `completion` resolves 'succeeded' the next stage starts, with no
  // user review in between. A failure (or cancel) aborts the chain — later
  // stages stay idle. Progress is observable through the existing per-stage
  // statuses, so the stepper animates without any new state plumbing. One
  // chain per project at a time (in-flight guard).
  const workflowRunsInFlight = new Set<string>();
  const UI_TERMINAL_IDS = new Set(['ui-html', 'ui-react', 'ui-react-ds']);
  const runWorkflowAll = async (
    projectId: string,
    opts: {
      workflowId?: string;
      terminal?: import('@open-design/contracts').WorkflowTerminal;
      input?: string;
      source?: import('@open-design/contracts').PipelineRunSource;
      designSystemId?: string | null;
      platform?: import('@open-design/contracts').TargetPlatform;
      targets?: import('@open-design/contracts').UiTarget[];
      skipSucceeded?: boolean;
      lean?: boolean;
      /** Bước người dùng tick tay — chạy ĐÚNG các bước này (xem selectRunStages).
       *  Route đã kiểm id + phụ thuộc trước khi gọi tới đây. */
      stageIds?: string[];
      followLinks?: boolean;
      includeDescendants?: boolean;
      docsFromUpload?: boolean;
    },
  ) => {
    const wf = getWorkflow(opts.workflowId ?? DEFAULT_WORKFLOW_ID);
    if (!wf) throw new Error(`Unknown workflow ${opts.workflowId}`);
    if (!getProject(db, projectId)) throw new Error(`Project ${projectId} not found`);
    // Khóa theo project+workflow, KHÔNG theo project: hai workflow khác nhau
    // ghi hai cây thư mục tách bạch (docs-to-ui/ vs docs-review/) và state
    // stage-keyed không giẫm nhau, nên chạy song song là hợp lệ — UI còn chủ
    // động hiển thị nhiều workflow cùng chạy. Chỉ chặn double-run CÙNG workflow.
    const runLockKey = `${projectId}::${wf.id}`;
    if (workflowRunsInFlight.has(runLockKey)) {
      throw new Error(`a full "${wf.name}" run is already in progress for this project`);
    }
    const terminal = opts.terminal ?? 'ui-html';
    const wanted = new Set(terminal === 'both' ? ['ui-html', 'ui-react'] : [terminal]);
    // Người dùng tick tay từng bước → chạy ĐÚNG các bước đó, theo thứ tự của
    // workflow (không theo thứ tự họ gửi). Bỏ qua `lean` và `skipSucceeded`: cả
    // hai là cách SUY RA phạm vi, còn đây là phạm vi được nêu thẳng — suy tiếp
    // trên một lựa chọn đã tường minh chỉ có thể làm nó khác đi ngoài ý muốn
    // (tick lại một bước đã xong nghĩa là muốn chạy lại nó).
    //
    // `terminal` cũng là một cách SUY RA phạm vi (kết thúc ở terminal nào), nên
    // nhánh này chọn trên CẢ danh sách bước của workflow: nếu vẫn lọc terminal
    // trước, một người tick "UI-Spec (React)" trong khi `terminal` mặc định là
    // `ui-html` sẽ thấy bước mình vừa tick BIẾN MẤT không một lời báo — đúng
    // kiểu hỏng im lặng mà lựa chọn tường minh sinh ra để tránh. Route đã 400
    // mọi id không thuộc workflow, nên ở đây không có id nào bị bỏ rơi.
    const manualStages = opts.stageIds?.length ? opts.stageIds : undefined;
    let stages: string[];
    if (manualStages) {
      // `docsFromUpload` VẪN áp ở nhánh này (xem chú thích bên dưới): chạy lại
      // bước ingest sẽ xoá sạch tài liệu người dùng vừa tải lên, và việc họ lỡ
      // tick nó không làm điều đó bớt phá hoại.
      stages = selectRunStages(wf.pipelineIds, {
        stageIds: manualStages,
        ...(opts.docsFromUpload ? { docsFromUpload: true } : {}),
      });
    } else {
      // Workflow order, minus the UI terminal(s) not chosen for this run.
      const candidates = wf.pipelineIds.filter((id) => !UI_TERMINAL_IDS.has(id) || wanted.has(id));
      // LEAN: drop the analysis stages (see PipelineDef.skippedInLeanRun). Nothing
      // downstream hard-requires them — ux-spec is told to carry on without a
      // journey or a research report — so the chain still reaches a UI, just from
      // the docs alone. Gating is not consulted here: run-all drives runPipeline
      // directly, so a skipped dependency does not block its successor.
      //
      // Documents were UPLOADED by hand instead of fetched: drop the ingest stage
      // from the chain. Its declared output IS `<workflow>/docs/`, so running it
      // would clear the uploaded files (relClearedByRegen) and then fetch nothing
      // — the review stage downstream would see an empty docs folder. Only the
      // stages the user can actually upload for (`acceptsUpload`) are droppable;
      // a workflow whose ingest has no upload affordance is unaffected.
      //
      // skipSucceeded uses the same "done" signal the routes use: local run
      // metadata merged with on-disk outputs (deriveStateFromLocalFiles) — store
      // state is not consulted, mirroring loadMergedState in pipeline-routes.
      let state: import('@open-design/contracts').ProjectPipelineState | undefined;
      if (opts.skipSucceeded) {
        const local = getProjectPipelineState(db, projectId);
        const localPaths = await localOutputsForProject(projectId).catch(() => [] as string[]);
        state = mergePipelineState(local, deriveStateFromLocalFiles(localPaths));
      }
      stages = selectRunStages(candidates, {
        ...(opts.lean ? { lean: true } : {}),
        ...(opts.skipSucceeded ? { skipSucceeded: true } : {}),
        ...(opts.docsFromUpload ? { docsFromUpload: true } : {}),
        ...(state ? { state } : {}),
      });
    }
    if (stages.length === 0) {
      // Nhánh tick tay chỉ rỗng được khi `docsFromUpload` vừa loại đúng bước
      // ingest mà người dùng chọn — nói "mọi bước đã succeeded" ở đó là sai sự
      // thật và khiến họ đi tìm nhầm chỗ.
      throw new Error(
        manualStages
          ? 'nothing to run: bước duy nhất được chọn là bước nạp tài liệu, mà tài liệu đã được tải lên tay nên bước đó bị bỏ (chạy lại sẽ xoá đúng các file vừa tải lên)'
          : 'nothing to run: every stage in the chain has already succeeded',
      );
    }
    // Multi-target: chosen UI targets (docs-to-ui only). Docs run ONCE (shared);
    // the post-docs chain runs once per target into <workflow>/<target>/.
    const targets = (opts.targets ?? []).filter((t): t is import('@open-design/contracts').UiTarget =>
      t === 'mobile' || t === 'web-user' || t === 'web-backoffice',
    );
    // The docs ingest stage is the one taking free-text input (inputPlaceholder);
    // everything else is post-docs and target-scoped.
    // SHARED stages run once for the project: the docs ingest (it takes the
    // free-text input) plus anything marked sharedAcrossTargets — the system
    // map describes the project, so one answer, not one per target. Everything
    // else forks per target. Shared stages come first in workflow order, so
    // running them up front preserves the chain.
    const isShared = (id: string) => {
      const def = getPipelineDef(id);
      return !!def && (!!def.inputPlaceholder || def.sharedAcrossTargets === true);
    };
    const docsStageIds = stages.filter(isShared);
    const postStageIds = stages.filter((id) => !isShared(id));

    // CLEAR-ON-LAUNCH: the bug this closes — runWorkflowAll used to reset
    // NOTHING at launch, only call runStage(id) in sequence, so a stage still
    // waiting its turn kept showing the PREVIOUS run's "Xong · Nm ago" with its
    // stale files sitting on disk (worse: a chain that broke mid-way left that
    // lie up forever). User-decided fix: wipe it the instant Run is pressed.
    // Awaited HERE (not inside the fire-and-forget chain below) so by the time
    // this function returns to its HTTP caller, the clear + `queued` flip has
    // already happened — no race between the response and the UI's first poll.
    //
    // SCOPE = ĐÚNG tập (stage × target) THIS launch will run, no more: reuse
    // `relClearedByRunAllLaunch` per (stage, wfDir) pair, mirroring the exact
    // two branches `runStage` uses below (docs stages: no target; post-docs
    // stages: once per chosen target, or once un-scoped for a single build) —
    // wfDir itself comes from `wfDirForStage`, the SAME function `runPipeline`
    // resolves its own `wfDir` through, so this can never compute a different
    // directory than the run that follows it. `baseWfDir` is the explicit
    // workflow fence (relClearedByRunAllLaunch) that keeps this confined to
    // `wf.id`'s own subtree — a parallel workflow tree in the same project
    // (`docs-review/`, …) is never touched.
    //
    // Failure here must never fail run-all — log and continue, like every
    // other clear step in this file.
    try {
      const clearProjectRoot = await ensureProject(PROJECTS_DIR, projectId);
      const baseWfDir = workflowDirForPipeline(stages[0]!);
      const clearPairs: Array<{ stageId: string; wfDir: string | null }> = docsStageIds.map((id) => ({
        stageId: id,
        wfDir: wfDirForStage(id, undefined).wfDir,
      }));
      if (targets.length > 0) {
        const { UI_TARGETS: clearUiTargets } = await import('@open-design/contracts');
        for (const t of targets) {
          const dir = clearUiTargets[t].dir;
          for (const id of postStageIds) {
            clearPairs.push({ stageId: id, wfDir: wfDirForStage(id, dir).wfDir });
          }
        }
      } else {
        for (const id of postStageIds) {
          clearPairs.push({ stageId: id, wfDir: wfDirForStage(id, undefined).wfDir });
        }
      }
      if (clearPairs.length > 0) {
        // Đường lùi trước khi phá hàng loạt — runPipeline vẫn tự chụp ảnh riêng
        // cho lần dọn LẺ của chính nó bên dưới; đây là một ảnh chụp RIÊNG cho
        // lần dọn HÀNG LOẠT này, trước khi bất cứ file nào bị xoá.
        await commitHistory(clearProjectRoot, { kind: 'manual-edits', by: historyActor() }).catch(() => null);
        const clearSnap = await snapshotPipelineCwd(clearProjectRoot);
        const allClearStageIds = new Set(clearPairs.map((p) => p.stageId));
        const clearedStageIds = new Set<string>();
        let clearedFileCount = 0;
        // CHẨN ĐOÁN "chỉ 1/6 bước khớp file" (bug chưa có bằng chứng chắc
        // chắn về nguyên nhân — xem spec-g3-queued-and-diagnostics.yaml): mỗi
        // cặp (stageId, wfDir) tự báo số file nó khớp, để LẦN CHẠY SAU đọc
        // log là thấy ngay bước nào khớp 0 file và đang dùng wfDir gì, thay vì
        // phải dựng lại vòng lặp này bằng tay để đoán.
        const pairMatchKey = (p: { stageId: string; wfDir: string | null }) => `${p.stageId}::${p.wfDir ?? '(none)'}`;
        const pairMatchCounts = new Map<string, number>(clearPairs.map((p) => [pairMatchKey(p), 0]));
        console.log(
          `[pipelines] run-all clear-on-launch scan for ${projectId}/${wf.id}: snapshot=${clearSnap.size} file, baseWfDir=${baseWfDir ?? '(none)'}`,
        );
        for (const rel of clearSnap.keys()) {
          // Check EVERY pair (no early break): a rel could in principle match
          // more than one in-scope stage, and every match must land in
          // `clearedStageIds` — breaking after the first would delete the file
          // (correct) but silently skip marking a second owning stage `queued`
          // (stale "Xong" left standing for it).
          let matchedAny = false;
          for (const pair of clearPairs) {
            const { stageId, wfDir: pairWfDir } = pair;
            if (relClearedByRunAllLaunch(rel, new Set([stageId]), pairWfDir, baseWfDir)) {
              clearedStageIds.add(stageId);
              const key = pairMatchKey(pair);
              pairMatchCounts.set(key, (pairMatchCounts.get(key) ?? 0) + 1);
              matchedAny = true;
            }
          }
          if (matchedAny) {
            await fs.promises.rm(path.join(clearProjectRoot, rel), { force: true }).catch(() => null);
            clearedFileCount += 1;
          }
        }
        for (const pair of clearPairs) {
          console.log(
            `[pipelines] run-all clear-on-launch pair for ${projectId}/${wf.id}: stage=${pair.stageId} wfDir=${pair.wfDir ?? '(none)'} khớp ${pairMatchCounts.get(pairMatchKey(pair)) ?? 0} file`,
          );
        }
        // QUEUED cho MỌI bước sắp chạy có mặt trong `clearPairs` — không chỉ
        // những bước THẬT SỰ có file bị xoá (`clearedStageIds`, dùng lại bên
        // dưới CHỈ để log). Bước nào sắp chạy thì trạng thái đúng của nó LÀ
        // "chờ chạy", bất kể trên đĩa có sẵn file để xoá hay không: một bước
        // `succeeded` từ lượt trước (như `ux` trong bug report) mà 0 file
        // khớp thì VẪN sắp bị chạy lại — giữ badge xanh "Xong" ở đó là nói dối
        // sản phẩm.
        //
        // NGOẠI LỆ: một bước đang THẬT SỰ `running` không bị đè thành
        // `queued`. `workflowRunsInFlight` chỉ khoá lại CHÍNH workflow này
        // (projectId::wf.id) — không khoá từng stage riêng lẻ — nên về lý
        // thuyết một stage vẫn có thể đang chạy do một lần kích hoạt lẻ khác
        // (không qua run-all) đúng lúc run-all này khởi động. Stage đó không
        // "chờ chạy", nó ĐANG chạy; đè `queued` lên sẽ nói dối theo hướng
        // ngược lại.
        const currentState = getProjectPipelineState(db, projectId);
        for (const id of allClearStageIds) {
          if (currentState[id]?.status === 'running') continue;
          setProjectPipelineStatus(db, projectId, id, { status: 'queued' });
        }
        console.log(
          `[pipelines] run-all clear-on-launch for ${projectId}/${wf.id}: xoá ${clearedFileCount} file thuộc ${clearedStageIds.size}/${allClearStageIds.size} bước sắp chạy`,
        );
      }
    } catch (error) {
      console.warn('[pipelines] run-all clear-on-launch failed (continuing):', error);
    }

    workflowRunsInFlight.add(runLockKey);
    void (async () => {
      // One stage of the chain. `targetDir` scopes it into a target subfolder;
      // `platform` overrides the UX platform per target. A FRESH full run resets
      // the whole project up front via the first stage's 'downstream' scope.
      const runStage = async (
        id: string,
        targetDir: string | undefined,
        platform: import('@open-design/contracts').TargetPlatform | undefined,
        audience?: import('@open-design/contracts').UiTargetAudience,
        // Per-target design system (multi-target run): overrides the run-wide
        // opts.designSystemId for THIS target's UI stages.
        designSystemOverride?: string,
      ): Promise<'succeeded' | 'failed' | 'idle'> => {
        const def = getPipelineDef(id)!;
        const start = await runPipeline(projectId, id, {
          input: def.inputPlaceholder ? opts.input : undefined,
          source: def.inputPlaceholder ? opts.source : undefined,
          designSystemId: def.acceptsDesignSystem
            ? (designSystemOverride ?? opts.designSystemId)
            : undefined,
          platform: def.acceptsPlatform ? platform : undefined,
          // KHÔNG reset downstream khi người dùng tự chọn bước: họ đang chạy
          // một TẬP bước cụ thể, còn 'downstream' xoá luôn kết quả của mọi bước
          // phía sau — tức phá đúng những thứ họ không đụng tới và cũng không
          // có bước nào trong lần chạy này dựng lại. Nhưng MỌI bước thực sự
          // chạy vẫn phải dọn output của CHÍNH NÓ trước — bỏ trống ở đây từng
          // là bug: bước chạy lại giữ nguyên file của lần trước trong
          // `outputs` của nó, và các bước sau đọc chúng như thể lần này vừa
          // sinh ra (xem `resetScopeForRunAllStage`).
          resetScope: resetScopeForRunAllStage({
            manualStages: !!manualStages,
            isFirstStage: id === stages[0],
            skipSucceeded: !!opts.skipSucceeded,
          }),
          followLinks: def.inputPlaceholder ? opts.followLinks : undefined,
          includeDescendants: def.inputPlaceholder ? opts.includeDescendants : undefined,
          targetDir,
          audience,
        });
        return start.completion;
      };
      try {
        // 1) Docs ingest — shared across every target.
        for (const id of docsStageIds) {
          if ((await runStage(id, undefined, opts.platform)) !== 'succeeded') {
            console.warn(`[pipelines] run-all for ${projectId} stopped at docs stage "${id}"`);
            return;
          }
        }
        if (targets.length > 0) {
          // 2) Per-target post-docs chain, each in its own <workflow>/<target>/.
          const { UI_TARGETS, buildTargetsConfig, TARGETS_CONFIG_BASENAME } = await import(
            '@open-design/contracts'
          );
          const projectRoot = await ensureProject(PROJECTS_DIR, projectId);
          const base = workflowDirForPipeline(stages[0]!) ?? '';
          // Record the chosen targets as ONE config file next to the shared docs
          // (docs-to-ui/targets.json). Downloaded docs stay a single copy; this
          // file is the post-docs stages' input for which targets to build —
          // replacing the "clone docs per target" scheme. Written once up front.
          try {
            const cfg = buildTargetsConfig(targets, opts.designSystemByTarget);
            await fs.promises.writeFile(
              path.join(projectRoot, base, TARGETS_CONFIG_BASENAME),
              `${JSON.stringify(cfg, null, 2)}\n`,
              'utf8',
            );
          } catch (error) {
            console.warn('[pipelines] writing targets.json failed:', error);
          }
          for (const t of targets) {
            const dir = UI_TARGETS[t].dir;
            // Stage the shared docs INTO this target's cwd as ./docs so its
            // post-docs stages find ./docs/confluence (skills read a relative
            // path). This MUST be a real COPY, not a symlink: the agent sandbox
            // bind-mounts ONLY the run cwd at /work/app (agent-sandbox.ts), so a
            // `../docs` symlink points OUTSIDE the mount and dangles inside the
            // container — the docs would be unreadable and stages fall back to
            // wrong inputs. The copy keeps docs inside the mounted cwd. (Rail
            // dedupe hides these per-target copies from Quick result.)
            try {
              const srcDocs = path.join(projectRoot, base, 'docs');
              const dstDocs = path.join(projectRoot, base, dir, 'docs');
              await fs.promises.rm(dstDocs, { recursive: true, force: true }).catch(() => {});
              await fs.promises.cp(srcDocs, dstDocs, { recursive: true });
            } catch (error) {
              console.warn(`[pipelines] staging docs into target ${dir} failed:`, error);
            }
            let ok = true;
            for (const id of postStageIds) {
              if ((await runStage(id, dir, UI_TARGETS[t].platform, UI_TARGETS[t].audience, opts.designSystemByTarget?.[t])) !== 'succeeded') {
                console.warn(`[pipelines] run-all for ${projectId} target "${dir}" stopped at "${id}"`);
                ok = false;
                break; // this target aborts; other targets still run
              }
            }
            console.log(`[pipelines] run-all for ${projectId} target "${dir}" ${ok ? 'completed' : 'aborted'}`);
          }
        } else {
          // Single build (legacy): post-docs chain at the shared workflow cwd.
          for (const id of postStageIds) {
            if ((await runStage(id, undefined, opts.platform)) !== 'succeeded') {
              console.warn(`[pipelines] run-all for ${projectId} stopped at "${id}"`);
              return;
            }
          }
        }
        console.log(`[pipelines] run-all for ${projectId} completed (${stages.length} stage(s)${targets.length ? `, ${targets.length} target(s)` : ''})`);
      } catch (error) {
        console.warn('[pipelines] run-all chain error:', error);
      } finally {
        workflowRunsInFlight.delete(runLockKey);
      }
    })();
    return { projectId, workflowId: wf.id, stages };
  };

  // Studio-written project config (`project.json` on the store — dự án khai
  // sinh ở Pipeline Studio): mirror it into the local project row's metadata
  // so the Run flow can prefill the Confluence link + design system. The file
  // itself is store metadata (isHistoryArtifact) and never lands in the cwd.
  const syncStudioConfig = async (projectId: string): Promise<void> => {
    const media = new MediaClient(mediaConfigFromEnv());
    const buf = await media.downloadFile(projectId, 'project.json').catch(() => null);
    if (!buf) return;
    let cfg;
    try {
      cfg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!cfg || typeof cfg !== 'object') return;
    const project = getProject(db, projectId);
    if (!project) return;
    // Trang Confluence nguồn: mảng confluencePages (mới) hoặc các key 1-trang
    // legacy — chuẩn hóa về mảng {id?,title?,url?}.
    const rawPages = Array.isArray(cfg.confluencePages) ? cfg.confluencePages : [];
    const confluencePages = rawPages
      .filter((p) => p && typeof p === 'object' && (typeof p.id === 'string' || typeof p.url === 'string'))
      .map((p) => ({
        ...(typeof p.id === 'string' && p.id ? { id: p.id } : {}),
        ...(typeof p.title === 'string' && p.title ? { title: p.title } : {}),
        ...(typeof p.url === 'string' && p.url ? { url: p.url } : {}),
      }));
    if (confluencePages.length === 0 && (typeof cfg.confluenceUrl === 'string' || typeof cfg.confluencePageId === 'string')) {
      const legacy = {
        ...(typeof cfg.confluencePageId === 'string' && cfg.confluencePageId ? { id: cfg.confluencePageId } : {}),
        ...(typeof cfg.confluenceTitle === 'string' && cfg.confluenceTitle ? { title: cfg.confluenceTitle } : {}),
        ...(typeof cfg.confluenceUrl === 'string' && cfg.confluenceUrl ? { url: cfg.confluenceUrl } : {}),
      };
      if (legacy.id || legacy.url) confluencePages.push(legacy);
    }
    // App cha (Studio: feature được link vào App qua project.json.appId).
    // Mirror cả TÊN app (đọc từ project.json của chính folder app, kind:'app')
    // để picker nhóm feature theo app mà không phải gọi store mỗi lần list.
    const appId = typeof cfg.appId === 'string' ? cfg.appId.trim() : '';
    let appName = '';
    let appDesignSystemId: string | null | undefined;
    if (appId) {
      // Open Design publishes App metadata as app.json; project.json is the
      // legacy/Pipeline Studio shape. Accept both so every successful Feature
      // Pull materializes its parent App locally instead of depending on a
      // remote/local union in GET /api/pipelines/apps.
      const appBuf = await media.downloadFile(appId, 'app.json').catch(
        () => media.downloadFile(appId, 'project.json').catch(() => null),
      );
      if (appBuf) {
        try {
          const appCfg = JSON.parse(appBuf.toString('utf8')) as { name?: unknown; designSystemId?: unknown };
          if (typeof appCfg.name === 'string') appName = appCfg.name.trim();
          if (typeof appCfg.designSystemId === 'string' && appCfg.designSystemId.trim()) {
            appDesignSystemId = appCfg.designSystemId.trim();
          } else if (appCfg.designSystemId === null) {
            appDesignSystemId = null;
          }
        } catch {
          /* app config unreadable — keep id-only */
        }
      }
      const materializedName = appName || appId;
      upsertPipelineAppName(db, { id: appId, name: materializedName, createdAt: Date.now() });
      if (appDesignSystemId !== undefined) {
        setPipelineAppDesignSystem(db, {
          id: appId,
          name: materializedName,
          designSystemId: appDesignSystemId,
          createdAt: Date.now(),
        });
      }
    }
    const studioConfig = {
      ...(confluencePages.length ? { confluencePages } : {}),
      ...(typeof cfg.designSystemId === 'string' && cfg.designSystemId ? { designSystemId: cfg.designSystemId } : {}),
      ...(typeof cfg.basDocumentId === 'string' && cfg.basDocumentId ? { basDocumentId: cfg.basDocumentId } : {}),
      ...(typeof cfg.basDocumentTitle === 'string' && cfg.basDocumentTitle
        ? { basDocumentTitle: cfg.basDocumentTitle }
        : {}),
      ...(typeof cfg.displayName === 'string' && cfg.displayName ? { displayName: cfg.displayName } : {}),
      ...(appId ? { appId } : {}),
      ...(appName ? { appName } : {}),
    };
    updateProject(db, projectId, { metadata: { ...(project.metadata ?? {}), studioConfig } });
  };

  const pullFilesForProject = async (projectId: string, stages?: string[]) => {
    const cwd = await ensureProject(PROJECTS_DIR, projectId);
    const pulled = await pullPipelineFiles(projectId, cwd, stages);
    await syncStudioConfig(projectId).catch(() => {});
    return { pulled };
  };

  // Per-stage local↔remote diff (sync-status): which pipelines' outputs on this
  // machine differ from the store. Mirrors the push/pull eligibility rules
  // (history metadata, syncExclude, localOnly stages never travel → excluded),
  // so a "differs" verdict always corresponds to something a push or pull
  // would actually move. Feeds the Pull all / Push all modals' badges and
  // `od kg diff`.
  const syncStatusForProject = async (projectId: string) => {
    const cwd = await ensureProject(PROJECTS_DIR, projectId);
    const media = new MediaClient(mediaConfigFromEnv());
    const [localFiles, remote] = await Promise.all([
      snapshotPipelineCwd(cwd),
      media.listFiles(projectId).catch(() => []),
    ]);
    const stats = new Map();
    const statFor = (stage) => {
      if (!stats.has(stage)) {
        stats.set(stage, { stage, local: 0, remote: 0, changed: 0, localOnly: 0, remoteOnly: 0 });
      }
      return stats.get(stage);
    };
    const eligible = (rel, def) => Boolean(rel) && !isHistoryArtifact(rel) && !isSyncExcluded(rel) && !def?.localOnly;
    const remoteByPath = new Map();
    for (const f of remote) {
      const rel = typeof f.path === 'string' ? f.path : '';
      const def = stageForOutput(rel);
      if (!eligible(rel, def)) continue;
      const stage = f.stage || def?.id || 'misc';
      remoteByPath.set(rel, { checksum: f.checksum, stage });
      statFor(stage).remote += 1;
    }
    for (const rel of localFiles.keys()) {
      const def = stageForOutput(rel);
      if (!eligible(rel, def)) continue;
      const r = remoteByPath.get(rel);
      const stage = r?.stage ?? def?.id ?? 'misc';
      const s = statFor(stage);
      s.local += 1;
      if (!r) {
        s.localOnly += 1;
        continue;
      }
      remoteByPath.delete(rel);
      const content = await fs.promises.readFile(path.join(cwd, rel)).catch(() => null);
      if (content && sha256hex(content) !== r.checksum) s.changed += 1;
    }
    // Whatever remains on the remote side has no local counterpart.
    for (const { stage } of remoteByPath.values()) statFor(stage).remoteOnly += 1;
    const stages = [...stats.values()]
      .map((s) => ({ ...s, differs: s.changed + s.localOnly + s.remoteOnly > 0 }))
      .sort((a, b) => a.stage.localeCompare(b.stage));
    return { projectId, stages };
  };
  // List the project cwd's output files (cwd-relative) without creating the dir:
  // snapshotPipelineCwd tolerates a missing root (→ empty), so this is a safe
  // read-path probe for deriving "done" stage state from on-disk outputs.
  const localOutputsForProject = async (projectId: string): Promise<string[]> => {
    const files = await snapshotPipelineCwd(path.join(PROJECTS_DIR, projectId));
    return [...files.keys()];
  };
  // BAS gateway reads for the Pipelines source picker. Each resolves the endpoint
  // (env / mcp-config) server-side so the token never reaches the browser.
  const requireBasEndpoint = async () => {
    const ep = await resolveBasEndpoint(RUNTIME_DATA_DIR);
    if (!ep) {
      throw new Error(
        'BAS is not configured (set BAS_MCP_URL + BAS_MCP_TOKEN in the daemon environment).',
      );
    }
    return ep;
  };
  const basDeps = {
    listDocuments: async () => basListDocuments(await requireBasEndpoint()),
    listFeatures: async (documentId: string) => basListFeatures(await requireBasEndpoint(), documentId),
    confluenceMeta: async (ref: string) => basConfluenceMeta(await requireBasEndpoint(), ref),
    // Picker "tìm trang Confluence theo tên" (modal Run pipeline 1): creds
    // per-user từ confluence-config.json (Settings → Integrations → Confluence,
    // WP8) trước, env daemon fallback, cuối cùng là BAS gateway — endpoint
    // gateway optional nên không dùng requireBasEndpoint.
    searchConfluencePages: async (q: string) =>
      searchConfluencePages(
        await resolveBasEndpoint(RUNTIME_DATA_DIR).catch(() => null),
        q,
        25,
        await resolveConfluenceCreds(RUNTIME_DATA_DIR),
      ),
    // Descendant pages (all levels, flat + treePath) of one page — the tree
    // picker expands a search hit into its sub-tree so the user checks exactly
    // which pages to ingest. PAT-only (needs Confluence REST ancestors).
    confluenceDescendants: async (ref: string) => {
      const creds = await resolveConfluenceCreds(RUNTIME_DATA_DIR);
      if (!creds) {
        throw new Error(
          'Chưa có credential Confluence (CONFLUENCE_URL + CONFLUENCE_PERSONAL_TOKEN) — cần PAT để đọc cây trang con.',
        );
      }
      return listDescendantPages(creds, extractPageId(ref));
    },
  };
  // Build (or rebuild) the ui-react app ON DEMAND — the Build button /
  // `od pipelines build`. `react/dist/` is deliberately not synced
  // (PipelineDef.syncExclude), so a device that pulled a project reconstructs
  // dist from the synced src/ through the SAME builder the agent used:
  // build.sh reseeds the template scaffold (cp -Rn) then runs tsc+vite in the
  // shared toolkit container. Requires Docker on this machine.
  // Configured multi-target list of the ui workflow (targets.json). [] when
  // single-build (or unreadable) — best-effort, used only for artifact probing.
  const configuredUiTargets = async (
    cwd: string,
  ): Promise<import('@open-design/contracts').UiTarget[]> => {
    const wf = workflowDirForPipeline('ui-react-ds');
    if (!wf) return [];
    const { TARGETS_CONFIG_BASENAME, isUiTarget } = await import('@open-design/contracts');
    try {
      const raw = await fs.promises.readFile(path.join(cwd, wf, TARGETS_CONFIG_BASENAME), 'utf8');
      const cfg = JSON.parse(raw);
      return Array.isArray(cfg?.targets) ? cfg.targets.filter(isUiTarget) : [];
    } catch {
      return [];
    }
  };

  // Candidate roots for a per-target build artifact (`react` / `react-ds`)
  // under one workflow dir. Multi-target projects nest the artifact per target
  // (<wf>/<target>/<leaf>): a requested target probes ONLY its own dir; no
  // request probes every configured target (targets.json order) and keeps the
  // legacy shared root (<wf>/<leaf>) as the single-build fallback.
  const targetArtifactDirs = async (
    cwd: string,
    wf: string | null,
    leaf: string,
    target: import('@open-design/contracts').UiTarget | undefined,
  ): Promise<string[]> => {
    if (!wf) return [];
    const { UI_TARGETS } = await import('@open-design/contracts');
    if (target) return [path.join(cwd, wf, UI_TARGETS[target].dir, leaf)];
    const configured = await configuredUiTargets(cwd);
    return [
      ...configured.map((t) => path.join(cwd, wf, UI_TARGETS[t].dir, leaf)),
      path.join(cwd, wf, leaf),
    ];
  };

  const buildReactAppForProject = async (
    projectId: string,
    target?: import('@open-design/contracts').UiTarget,
  ): Promise<{ built: boolean; output: string }> => {
    const cwd = await ensureProject(PROJECTS_DIR, projectId);
    // The react/ sources live under the ui-react stage's workflow folder
    // (target-scoped on multi-target projects); old projects predate the
    // workflow merge and keep the retired docs-to-react folder, so probe that
    // as a fallback. The ui-react-ds stage keeps its own react-ds/ tree with
    // its own builder — probed last so an existing react/ project keeps its
    // build target unchanged.
    const candidates = [
      ...(await targetArtifactDirs(cwd, workflowDirForPipeline('ui-react'), 'react', target)).map(
        (dir) => ({ dir, skill: 'ui-react' }),
      ),
      ...(target ? [] : [{ dir: path.join(cwd, 'docs-to-react', 'react'), skill: 'ui-react' }]),
      ...(await targetArtifactDirs(cwd, workflowDirForPipeline('ui-react-ds'), 'react-ds', target)).map(
        (dir) => ({ dir, skill: 'ui-react-ds' }),
      ),
    ];
    let reactDir: string | null = null;
    let builderSkill = 'ui-react';
    for (const candidate of candidates) {
      const hasSrc = await fs.promises.access(path.join(candidate.dir, 'src')).then(
        () => true,
        () => false,
      );
      if (hasSrc) {
        reactDir = candidate.dir;
        builderSkill = candidate.skill;
        break;
      }
    }
    if (!reactDir) {
      throw new Error(
        'no <workflow>/react/src (or react-ds/src) in this project — run the "UI-Spec (React)" / "UI-Spec (React DS)" pipeline (or pull files) first',
      );
    }
    const script = path.join(SKILLS_DIR, builderSkill, 'builder', 'build.sh');
    const r = await execFileBuffered('bash', [script, reactDir], {
      cwd,
      timeout: 15 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, UIREACT_PROJECT_ID: projectId },
    });
    const tail = [r.stdout, r.stderr]
      .filter(Boolean)
      .join('\n')
      .split('\n')
      .slice(-40)
      .join('\n');
    if (!r.ok) throw new Error(tail || 'react build failed');
    await commitHistory(cwd, {
      kind: 'build',
      note: 'react build (dist rebuilt)',
      by: historyActor(),
    }).catch(() => null);
    return { built: true, output: tail };
  };

  // Prototype auto-demo: Playwright drives the BUILT react app through its
  // flow.json use cases and records video + per-step screenshots under
  // react/prototype-demo/ (see react-demo.ts). Deterministic — no agent.
  const buildReactDemoForProject = async (
    projectId: string,
    target?: import('@open-design/contracts').UiTarget,
  ): Promise<{ cases: number; output: string }> => {
    const cwd = await ensureProject(PROJECTS_DIR, projectId);
    const candidateDirs = [
      ...(await targetArtifactDirs(cwd, workflowDirForPipeline('ui-react'), 'react', target)),
      ...(target ? [] : [path.join(cwd, 'docs-to-react', 'react')]),
      ...(await targetArtifactDirs(cwd, workflowDirForPipeline('ui-react-ds'), 'react-ds', target)),
    ];
    let reactDir: string | null = null;
    for (const dir of candidateDirs) {
      const hasDist = await fs.promises.access(path.join(dir, 'dist')).then(
        () => true,
        () => false,
      );
      if (hasDist) {
        reactDir = dir;
        break;
      }
    }
    if (!reactDir) {
      throw new Error(
        'no <workflow>/react/dist in this project — build the React app first (Build button / `od pipeline build`)',
      );
    }
    const result = await buildReactDemo(reactDir, RUNTIME_DATA_DIR);
    await commitHistory(cwd, {
      kind: 'build',
      note: `playwright demo (${result.cases} kịch bản)`,
      by: historyActor(),
    }).catch(() => null);
    return result;
  };

  // Capture the BUILT UI-Spec (React DS) app into Figma screen JSON
  // (react-ds/figma-screens/): full figma-h2d IR per screen/state with
  // component-instance markers, rebuilt as real instances by the design-v3
  // Fig Pipeline plugin's "Screen JSON → Figma" tab. React-DS ONLY — a
  // generic ui-react app has no markers and no matching UI-Lib Figma file.
  const figmaCaptureForProject = async (
    projectId: string,
    target?: import('@open-design/contracts').UiTarget,
  ) => {
    const cwd = await ensureProject(PROJECTS_DIR, projectId);
    // Multi-target projects keep one built react-ds/ per target — capture the
    // requested one (or the first configured target that has a build).
    const candidates = await targetArtifactDirs(
      cwd,
      workflowDirForPipeline('ui-react-ds'),
      'react-ds',
      target,
    );
    let reactDsDir: string | null = null;
    for (const dir of candidates) {
      const hasDist = await fs.promises.access(path.join(dir, 'dist', 'index.html')).then(
        () => true,
        () => false,
      );
      if (hasDist) {
        reactDsDir = dir;
        break;
      }
    }
    if (!reactDsDir) {
      throw new Error(
        target
          ? `no built react-ds for target "${target}" — run the "UI-Spec (React DS)" pipeline for that target and Build app first`
          : 'no <workflow>/react-ds/dist in this project — run the "UI-Spec (React DS)" pipeline and Build app first',
      );
    }
    const result = await runFigmaCapture(reactDsDir, RUNTIME_DATA_DIR, projectId);
    // Icon markers mang SLUG (compile-core) còn plugin Figma match theo TÊN
    // NGUYÊN VĂN → viết lại marker bằng tên thật từ IR của DS target (map
    // designSystemByTarget trong targets.json). Best-effort — thiếu DS/IR thì
    // giữ nguyên slug (plugin sẽ unmatched như cũ và audit vẫn cảnh báo).
    try {
      const wf = workflowDirForPipeline('ui-react-ds');
      const seg = path.relative(cwd, reactDsDir).split(path.sep)[1] ?? '';
      const { UI_TARGETS, UI_TARGET_IDS, TARGETS_CONFIG_BASENAME } = await import('@open-design/contracts');
      const t = UI_TARGET_IDS.find((id) => UI_TARGETS[id].dir === seg);
      if (wf && t) {
        const cfg = JSON.parse(
          await fs.promises.readFile(path.join(cwd, wf, TARGETS_CONFIG_BASENAME), 'utf8'),
        ) as { designSystemByTarget?: Record<string, string> };
        const dsId = cfg.designSystemByTarget?.[t];
        if (dsId) {
          const irDir = path.join(
            USER_DESIGN_SYSTEMS_DIR,
            dsId.startsWith('user:') ? dsId.slice('user:'.length) : dsId,
            'ir',
          );
          const map = await iconNameMapFromIrDir(irDir);
          const rewritten = await rewriteIconMarkersInDir(path.join(reactDsDir, 'figma-screens'), map);
          if (rewritten > 0) console.log(`[figma-capture] rewrote ${rewritten} icon marker(s) slug → real Figma name`);
        }
      }
    } catch {
      /* best-effort */
    }
    await commitHistory(cwd, {
      kind: 'build',
      note: `figma capture (${result.screens} màn, ${result.markers} instance)`,
      by: historyActor(),
    }).catch(() => null);
    // cwd-relative path of the merged screens.json — the web UI copies its
    // content to the clipboard via GET /api/projects/:id/raw/<rawPath>. Derived
    // from the ACTUAL captured dir so the target segment survives.
    const rawPath = [
      ...path.relative(cwd, reactDsDir).split(path.sep),
      ...result.screensJson.split(path.sep),
    ].join('/');
    return { ...result, rawPath };
  };

  // Lớp 1 audit "Preview ↔ Figma": soi tĩnh figma-screens/*.capture.json đối
  // chiếu bộ DS đã stage, báo trước unmatched/variant-fallback/oversize-layer
  // TRƯỚC khi người dùng dán vào Figma. Ghi figma-screens/audit.json.
  const figmaAuditForProject = async (
    projectId: string,
    target?: import('@open-design/contracts').UiTarget,
  ) => {
    const cwd = await ensureProject(PROJECTS_DIR, projectId);
    const candidates = await targetArtifactDirs(
      cwd,
      workflowDirForPipeline('ui-react-ds'),
      'react-ds',
      target,
    );
    let reactDsDir: string | null = null;
    for (const dir of candidates) {
      const has = await fs.promises
        .access(path.join(dir, 'figma-screens', 'screens'))
        .then(() => true, () => false);
      if (has) {
        reactDsDir = dir;
        break;
      }
    }
    if (!reactDsDir) {
      throw new Error(
        'chưa có figma-screens nào — bấm "Capture Figma" (hoặc `od pipeline figma-capture`) trước khi audit.',
      );
    }
    const result = await runFigmaAudit(reactDsDir);
    const rawPath = [
      ...path.relative(cwd, reactDsDir).split(path.sep),
      ...result.auditJson.split(path.sep),
    ].join('/');
    return { ...result, rawPath };
  };

  // Project history: published versions (store) + machine-local commits,
  // newest first on both tracks.
  const projectHistoryForProject = async (projectId: string) => {
    const cwd = await ensureProject(PROJECTS_DIR, projectId);
    const media = new MediaClient(mediaConfigFromEnv());
    const [versions, commits, remote] = await Promise.all([
      readChangelog(media, projectId).catch(() => []),
      listHistory(cwd, 100),
      media.listFiles(projectId).catch(() => []),
    ]);
    // Per-version stage ids from the snapshot files' `stage:` tags (fallback:
    // re-derive from the path) — lets the UI scope history to one pipeline
    // card. Pruned versions simply have no `_v/` rows → no stages.
    const stagesByVer = new Map();
    for (const f of remote) {
      const rel = typeof f.path === 'string' ? f.path : '';
      const m = /^_v\/(v\d+)\/(.+)$/.exec(rel);
      if (!m) continue;
      const stage = f.stage || stageForOutput(m[2])?.id;
      if (!stage) continue;
      const set = stagesByVer.get(m[1]) ?? new Set();
      set.add(stage);
      stagesByVer.set(m[1], set);
    }
    const withStages = versions.map((v) => ({
      ...v,
      stages: [...(stagesByVer.get(v.verId) ?? [])].sort(),
    }));
    return { versions: withStages.slice().reverse(), commits };
  };

  // Restore: a published version pulls `_v/<verId>/…` back over the cwd; a
  // local commit rewinds through git. Both fence the current state first so
  // restore itself is always undoable.
  const restoreHistoryForProject = async (
    projectId: string,
    opts: { verId?: string; commit?: string; paths?: string[]; stage?: string },
  ) => {
    const cwd = await ensureProject(PROJECTS_DIR, projectId);
    if (opts.commit) {
      const r = await restoreCommit(cwd, opts.commit, opts.paths, historyActor());
      return { restored: 'commit', commit: opts.commit, files: r?.filesChanged ?? 0 };
    }
    if (!opts.verId) throw new Error('verId hoặc commit là bắt buộc');
    await commitHistory(cwd, {
      kind: 'pre-pull',
      note: `trước khi khôi phục ${opts.verId}${opts.stage ? ` (${opts.stage})` : ''}`,
      by: historyActor(),
    }).catch(() => null);
    const media = new MediaClient(mediaConfigFromEnv());
    const remote = await media.listFiles(projectId);
    const prefix = `_v/${opts.verId}/`;
    const cwdReal = path.resolve(cwd);
    let files = 0;
    for (const f of remote) {
      const rel = typeof f.path === 'string' ? f.path : '';
      if (!rel.startsWith(prefix)) continue;
      const target = rel.slice(prefix.length);
      // Per-pipeline restore: only that stage's outputs (stage tag, else
      // re-derived from the path) — the rest of the snapshot stays untouched.
      if (opts.stage && (f.stage || stageForOutput(target)?.id) !== opts.stage) continue;
      const dest = path.resolve(cwd, target);
      if (dest !== cwdReal && !dest.startsWith(cwdReal + path.sep)) continue;
      const content = await media.downloadFile(projectId, rel).catch(() => null);
      if (!content) continue;
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, content);
      files += 1;
    }
    if (files === 0) {
      throw new Error(
        opts.stage
          ? `bản ${opts.verId} không có file nào của stage ${opts.stage} (hoặc snapshot đã bị prune)`
          : `không có snapshot ${opts.verId} trên store`,
      );
    }
    await commitHistory(cwd, {
      kind: 'restore',
      verId: opts.verId,
      note: `khôi phục ${files} file từ bản ${opts.verId}${opts.stage ? ` (stage ${opts.stage})` : ''}`,
      by: historyActor(),
    }).catch(() => null);
    return { restored: 'version', verId: opts.verId, files };
  };

  // Shared pipeline deps — passed to both the pipeline routes and the remote
  // project registry routes (both type their `pipelines` as the full PipelineDeps).
  const pipelineDeps = {
    runPipeline,
    runWorkflowAll,
    // UX knowledge base (media-store backed): status resolves the active KB
    // source; push uploads a local KB folder to the store (content-hash sync).
    uxKbStatus: () => resolveUxKbDir(RUNTIME_DATA_DIR),
    uxKbPush: (dir?: string) => pushUxKb(dir),
    pullFiles: pullFilesForProject,
    uploadFiles: uploadProjectFiles,
    syncStatus: syncStatusForProject,
    buildReact: buildReactAppForProject,
    buildReactDemo: buildReactDemoForProject,
    figmaCapture: figmaCaptureForProject,
    figmaAudit: figmaAuditForProject,
    localOutputs: localOutputsForProject,
    history: projectHistoryForProject,
    restoreHistory: restoreHistoryForProject,
    pullConflict: { plan: planPull, apply: applyPull },
    bas: basDeps,
  };
  registerPipelineRoutes(app, {
    db,
    pipelines: pipelineDeps,
    paths: pathDeps,
  });

  // App Docs Pool (docs/app-docs-pool-spec.md) — import/pool routes.
  registerAppPoolRoutes(app, {
    db,
    paths: pathDeps,
  });

  registerAppContextRoutes(app, {
    db,
    paths: pathDeps,
    http: httpDeps,
  });

  registerOverviewRoutes(app, { db, paths: pathDeps, pipelines: pipelineDeps });

  // Remote project registry (pull-all/push-all) is registered here — after
  // the pipeline file helpers exist — so push-all can also upload output
  // files and pull-all can also restore them. Paths are distinct from other
  // routes, so the later registration order is harmless.
  registerRemoteProjectsRoutes(app, {
    db,
    http: httpDeps,
    projectStore: projectStoreDeps,
    pipelines: pipelineDeps,
  });
  registerProjectSyncRoutes(app, { db, http: httpDeps, paths: pathDeps });

  // proxy routes (anthropic / openai / azure / google / ollama) live
  // in chat-routes.ts now — garnet had a partial duplicate here that
  // referenced helpers (rejectPluginInProxyBody, extractGeminiText, …)
  // dropped during the reconcile merge. Deleted to fix the BYOK crash.
  // Restore the plugin-runs-must-go-through-daemon gate by adding it
  // to chat-routes.ts if needed.


  registerChatRoutes(app, {
    db,
    design,
    http: httpDeps,
    paths: pathDeps,
    chat: { startChatRun, submitToolResultToRun },
    agents: agentDeps,
    critique: critiqueDeps,
    validation: validationDeps,
    lifecycle: { isDaemonShuttingDown: () => daemonShuttingDown },
    telemetry: { reportFinalizedMessage, reportFeedback },
  });

  registerStaticSpaFallback(app, STATIC_DIR);

  // Wait for `listen` to bind so callers always see the resolved URL —
  // critical when port=0 (ephemeral port) and when the embedding sidecar
  // needs to advertise the port to a parent process before any request
  // can flow. Three callers depend on this contract:
  //   - `apps/daemon/src/cli.ts`            → expects `{ url, server, shutdown }`
  //   - `apps/daemon/sidecar/server.ts`     → expects `{ url, server }`
  //   - `apps/daemon/tests/version-route.test.ts` → expects `{ url, server }`
  return await new Promise((resolve, reject) => {
    let daemonShutdownStarted = false;
    const cleanupDaemonBackgroundWork = () => {
      composioConnectorProvider.stopCatalogRefreshLoop();
      orbitService.stop();
      routineService?.stop();
    };
    const shutdownDaemonRuns = async () => {
      if (daemonShutdownStarted) return;
      daemonShutdownStarted = true;
      daemonShuttingDown = true;
      await design.runs.shutdownActive({ graceMs: resolveChatRunShutdownGraceMs() });
      await design.analytics.shutdown();
    };
    let server;
    try {
      server = app.listen(port, host, () => {
        // Widen the between-request idle window so kept-alive sockets
        // belonging to chat/SSE clients survive the gaps between bursts.
        //
        // Node's `keepAliveTimeout` (default 5s) only arms *after* a
        // response finishes writing, bounding the idle gap before the next
        // request on the same socket — it does not fire while an SSE
        // response is still streaming. A streaming `/api/runs/:id/events`
        // response stays open until the agent finishes, so middlebox idle
        // timers (nginx, socat/docker bridges, EC2 SG NAT) are typically
        // the proximate cause when an SSE stream drops; this listener-
        // side change cannot extend a connection past those middleboxes.
        //
        // What it *does* fix: chat clients that pipeline multiple requests
        // on the same TCP socket (status polls, run-status fetches, the
        // initial GET before the SSE upgrade). With the default 5s window
        // a sluggish client can lose the connection between two normal
        // calls and reconnect-storm. 120s aligns with the in-band
        // SSE_KEEPALIVE_INTERVAL_MS (25s) so kept-alive sockets used
        // around an SSE stream stay warm across reasonable client pauses.
        //
        // `headersTimeout` must exceed `keepAliveTimeout` per the Node
        // docs; otherwise a slow-loris client can stall request parsing.
        if (server) {
          server.keepAliveTimeout = 120_000;
          server.headersTimeout = 125_000;
        }
        // Reap sandbox containers orphaned by a previous daemon process.
        // Run state is in-memory, so at startup EVERY live od.sandbox
        // container belongs to a run that died with the old daemon.
        // Fire-and-forget: docker being down just means nothing to sweep.
        void readAppConfig(RUNTIME_DATA_DIR)
          .then((cfg) => {
            if (!resolveSandboxConfig(cfg.sandbox, process.env).enabled) return [];
            return sweepOrphanSandboxContainers();
          })
          .then((killed) => {
            if (killed.length > 0) {
              console.warn(`[od] sandbox: reaped ${killed.length} orphaned container(s): ${killed.join(', ')}`);
            }
          })
          .catch(() => {});
        // WP3 (host process lifecycle): reap HOST run process trees
        // orphaned by a previous daemon process. Run state is in-memory
        // just like the sandbox sweep above, so any pid-file left under
        // RUNS_STATE_DIR at startup belongs to a run whose daemon already
        // died. Fire-and-forget: a missing/empty dir just means nothing to
        // sweep. See specs/change/20260813-web-first/wp3-process-lifecycle.md.
        void design.runs.sweepOrphanHostRuns()
          .then((swept) => {
            if (swept.length > 0) {
              console.warn(`[od] host: reaped ${swept.length} orphaned run process tree(s): ${swept.map((s) => s.runId).join(', ')}`);
            }
          })
          .catch(() => {});
        const address = server.address();
        // `address()` can in theory return `string | AddressInfo | null`. For
        // a TCP listener it's always `AddressInfo` with a `.port` — the guard
        // is belt-and-braces so an unexpected null never silently produces a
        // `http://127.0.0.1:0` URL that callers would then try to fetch.
        const boundPort =
          address && typeof address === 'object' ? address.port : null;
        if (!boundPort) {
          reject(
            new Error(
              `[od] daemon failed to resolve listening port (address=${JSON.stringify(address)})`,
            ),
          );
          return;
        }
        resolvedPort = boundPort;
        // When binding to all interfaces report localhost for local callers;
        // when binding to a specific address (e.g. a Tailscale IP) report that
        // address so remote callers and the sidecar use the correct URL.
        const reportHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
        const url = `http://${reportHost}:${resolvedPort}`;
        if (!returnServer) {
          console.log(`[od] daemon listening on ${url}`);
        }
        daemonUrl = url;
        resolve(returnServer ? { url, server, shutdown: shutdownDaemonRuns } : url);
      });
    } catch (error) {
      cleanupDaemonBackgroundWork();
      reject(error);
      return;
    }
    server.once('close', () => {
      void shutdownDaemonRuns().finally(cleanupDaemonBackgroundWork);
    });
    // `app.listen` throws synchronously when the port is already in use on
    // some Node versions, but emits an `error` event on others (and for
    // EACCES / EADDRNOTAVAIL even on the same Node). Wire the event so the
    // returned Promise always settles instead of hanging forever.
    server.on('error', (error) => {
      cleanupDaemonBackgroundWork();
      reject(error);
    });
  });
}

function randomId() {
  return randomUUID();
}

function sanitizeSlug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function assembleExample(templateHtml, slidesHtml, title) {
  return templateHtml
    .replace('<!-- SLIDES_HERE -->', slidesHtml)
    .replace(
      /<title>.*?<\/title>/,
      `<title>${title} | Open Design Example</title>`,
    );
}

// Skill example HTML often references shipped images via relative paths
// like `./assets/hero.png`. Those resolve correctly when the file is
// opened from disk, but the web app loads the example into a sandboxed
// iframe via `srcdoc`, where the document URL is `about:srcdoc` and
// relative URLs cannot find the assets. Rewriting them to an absolute
// `/api/skills/<id>/assets/...` URL lets the same HTML render in both
// places — the disk preview keeps working, and the in-app preview now
// fetches assets through the matching route below.
export function rewriteSkillAssetUrls(html: string, skillId: string): string {
  if (typeof html !== 'string' || html.length === 0) return html;
  // Match src/href attributes whose values point at the current skill's
  // assets (`./assets/...` or `assets/...`) or a sibling skill's assets
  // (`../other-skill/assets/...`). Quote style is preserved so we do not
  // disturb the surrounding markup.
  return html.replace(
    /(\s(?:src|href)\s*=\s*)(['"])((?:\.\.\/([^/'"#?]+)\/)?(?:\.\/)?assets\/([^'"#?]+))(\2)/gi,
    (_match, attr, openQuote, _fullPath, siblingSkillId, relPath, closeQuote) => {
      const resolvedSkillId = siblingSkillId || skillId;
      const prefix = `/api/skills/${encodeURIComponent(resolvedSkillId)}/assets/`;
      return `${attr}${openQuote}${prefix}${relPath}${closeQuote}`;
    },
  );
}
