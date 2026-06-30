# 05 — Plugin Models

**Nguồn:** `packages/contracts/src/plugins/manifest.ts`, `packages/contracts/src/plugins/installed.ts`, `packages/contracts/src/plugins/apply.ts`, `packages/contracts/src/plugins/marketplace.ts`

---

## PluginManifest (`open-design.json`)

Schema v1 cho plugin manifest, validated bằng Zod:

```typescript
interface McpServerSpec {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

interface InputField {
  name: string;
  label?: string;
  type?: 'string' | 'text' | 'select' | 'number' | 'boolean' | 'file';
  required?: boolean;
  options?: string[];
  placeholder?: string;
  default?: unknown;
}

type LocalizedText = string | Record<string, string>;

interface PipelineStage {
  id: string;
  atoms: string[];
  repeat?: boolean;
  until?: string;           // e.g. "critique.score>=4 || iterations>=3"
  onFailure?: 'abort' | 'skip' | 'retry';
}

interface PluginPipeline {
  stages: PipelineStage[];
}

interface GenUISurfaceSpec {
  id: string;
  kind: 'form' | 'choice' | 'confirmation' | 'oauth-prompt';
  persist: 'run' | 'conversation' | 'project';
  trigger?: {
    stageId?: string;
    atom?: string;
  };
  schema?: Record<string, unknown>;
  prompt?: string;
  capabilitiesRequired?: string[];
  timeout?: number;
  onTimeout?: 'abort' | 'default' | 'skip';
  default?: unknown;
  oauth?: {
    route: 'connector' | 'mcp' | 'plugin';
    connectorId?: string;
    mcpServerId?: string;
  };
  component?: {
    path: string;          // Relative to plugin folder
    export?: string;       // Named export (default: default export)
    sandbox?: 'iframe' | 'react';
  };
}

interface PluginConnectorRef {
  id: string;
  tools: string[];
  required?: boolean;
}

interface PluginManifest {
  $schema?: string;
  specVersion?: string;      // e.g. '1.0.0'
  name: string;              // Stable slug: lowercase + [a-z0-9._-]
  title?: string;
  title_i18n?: Record<string, string>;
  version: string;           // Semver
  description?: string;
  description_i18n?: Record<string, string>;
  author?: {
    name?: string;
    url?: string;
  };
  license?: string;
  homepage?: string;
  icon?: string;
  tags?: string[];
  compat?: {
    agentSkills?: Array<{ path: string }>;
    claudePlugins?: Array<{ path: string }>;
  };
  od?: {
    kind?: 'skill' | 'scenario' | 'atom' | 'bundle';
    taskKind?: 'new-generation' | 'code-migration' | 'figma-migration' | 'tune-collab';
    mode?: string;
    platform?: string;
    scenario?: string;
    engineRequirements?: { od?: string };
    preview?: {
      type?: string;
      entry?: string;
      poster?: string;
      video?: string;
      gif?: string;
    };
    useCase?: {
      query?: string | Record<string, string>;
      exampleOutputs?: Array<{ path: string; title?: string }>;
    };
    context?: {
      skills?: Array<{ ref?: string; path?: string }>;
      designSystem?: { ref?: string; primary?: boolean };
      craft?: string[];
      assets?: string[];
      claudePlugins?: Array<{ ref?: string; path?: string }>;
      mcp?: McpServerSpec[];
      atoms?: string[];
    };
    pipeline?: PluginPipeline;
    genui?: {
      surfaces?: GenUISurfaceSpec[];
    };
    connectors?: {
      required?: PluginConnectorRef[];
      optional?: PluginConnectorRef[];
    };
    inputs?: InputField[];
    capabilities?: string[];
  };
}
```

### Known v1 Capabilities

| Capability | Mô tả |
|-----------|-------|
| `prompt:inject` | Inject vào system prompt (default cho restricted installs) |
| `fs:read` | Đọc files |
| `fs:write` | Viết files |
| `mcp` | Kết nối MCP servers |
| `subprocess` | Spawn subprocesses |
| `bash` | Run bash commands |
| `network` | Network requests |
| `connector` | Sử dụng connectors |
| `connector:<id>` | Sử dụng connector cụ thể |

---

## Plugin Pipeline Atoms

| Atom | Mô tả |
|------|-------|
| `discovery-question-form` | Discovery Q&A form |
| `direction-picker` | Visual direction picker |
| `todo-write` | Live todo tracking |
| `file-write` | Write file to disk |
| `file-read` | Read file from disk |
| `live-artifact` | Create/update live artifact |
| `media-image` | Generate image |
| `media-video` | Generate video |
| `media-audio` | Generate audio |
| `critique-theater` | Self-critique loop |
| `figma-extract` | Extract from Figma |
| `code-import` | Import from code |
| `token-map` | Map design tokens |
| `rewrite-plan` | Plan code rewrite |
| `handoff` | Handoff to external |
| `diff-review` | Review diffs |
| `patch-edit` | Apply patch |
| `connector` | Use connector |
| `build-test` | Build and test |

---

## InstalledPluginRecord

Plugin đã cài trên local, lưu trong database:

```typescript
type PluginSourceKind =
  | 'bundled'
  | 'user'
  | 'project'
  | 'marketplace'
  | 'github'
  | 'url'
  | 'local';

type TrustTier = 'trusted' | 'restricted';

interface InstalledPluginRecord {
  id: string;
  title: string;
  version: string;
  sourceKind: PluginSourceKind;
  source: string;                   // URL, path, or marketplace id
  pinnedRef?: string;               // Git ref / commit
  sourceDigest?: string;
  sourceMarketplaceId?: string;
  sourceMarketplaceEntryName?: string;
  sourceMarketplaceEntryVersion?: string;
  marketplaceTrust?: MarketplaceTrust;
  resolvedSource?: string;
  resolvedRef?: string;
  manifestDigest?: string;
  archiveIntegrity?: string;
  trust: TrustTier;
  capabilitiesGranted: string[];
  manifest: PluginManifest;
  fsPath: string;                   // Absolute path on disk
  installedAt: number;
  updatedAt: number;
}
```

---

## AppliedPluginSnapshot

Immutable snapshot khi plugin được apply vào project run:

```typescript
interface AppliedPluginSnapshot {
  snapshotId: string;
  pluginId: string;
  pluginSpecVersion?: string;
  pluginVersion: string;
  manifestSourceDigest: string;
  sourceMarketplaceId?: string;
  sourceMarketplaceEntryName?: string;
  sourceMarketplaceEntryVersion?: string;
  marketplaceTrust?: 'official' | 'trusted' | 'restricted';
  resolvedSource?: string;
  resolvedRef?: string;
  archiveIntegrity?: string;
  pinnedRef?: string;
  inputs: Record<string, string | number | boolean>;
  resolvedContext: ResolvedContext;
  capabilitiesGranted: string[];
  capabilitiesRequired: string[];
  assetsStaged: PluginAssetRef[];
  taskKind: 'new-generation' | 'code-migration' | 'figma-migration' | 'tune-collab';
  appliedAt: number;

  // Frozen state at apply time
  connectorsRequired: PluginConnectorRef[];
  connectorsResolved: PluginConnectorBinding[];
  mcpServers: McpServerSpec[];
  pipeline?: PluginPipeline;
  genuiSurfaces?: GenUISurfaceSpec[];

  // Display metadata
  pluginTitle?: string;
  pluginDescription?: string;
  query?: string;

  status: 'fresh' | 'stale';       // 'stale' when digest drift detected
}
```

### PluginAssetRef

```typescript
interface PluginAssetRef {
  path: string;
  src: string;
  mime?: string;
  stageAt: 'project-create' | 'run-start';
}
```

### PluginConnectorBinding

```typescript
interface PluginConnectorBinding {
  id: string;
  tools: string[];
  required?: boolean;
  accountLabel?: string;
  status: 'connected' | 'pending' | 'unavailable';
}
```

---

## PluginInstallOutcome

```typescript
interface PluginInstallOutcome {
  ok: boolean;
  plugin?: InstalledPluginRecord | null;
  warnings: string[];
  message?: string;
  log: string[];
}
```

---

## Plugin od.mode Values

| Mode | Output |
|------|--------|
| `prototype` | Interactive single-page web artifact |
| `deck` | Slide deck |
| `live-artifact` | Dashboard, report, calculator |
| `image` | Generated image |
| `video` | Video |
| `hyperframes` | HyperFrames HTML motion |
| `audio` | Voice, music, sound |
| `design-system` | Brand/interface system |
